import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setup, createWorker, workThroughTasks, type TestCtx } from "./helpers.js";
import { RelayEngine, validatePlan, AUDIT_EVERY, type PlanBinaryState } from "../src/relay/engine.js";
import { MockLlm, type RelayLlm, type Plan } from "../src/relay/llm.js";
import { questionHash } from "../src/relay/cache.js";

const bin = (over: Partial<PlanBinaryState>): PlanBinaryState => ({
  id: "b1", question: "q?", tier: "basic", depends_on: [], skill_tags: [], cost_cents: 0, ...over,
});

describe("plan validation", () => {
  it("accepts a sound DAG", () => {
    expect(validatePlan([
      bin({ id: "a" }), bin({ id: "b" }), bin({ id: "c", depends_on: ["a", "b"] }),
    ])).toBeNull();
  });
  it("rejects empties, duplicates, unknown deps, self-deps, cycles, oversize", () => {
    expect(validatePlan([])).toMatch(/empty/);
    expect(validatePlan([bin({ id: "a" }), bin({ id: "a" })])).toMatch(/duplicate/);
    expect(validatePlan([bin({ id: "a", depends_on: ["zz"] })])).toMatch(/unknown/);
    expect(validatePlan([bin({ id: "a", depends_on: ["a"] })])).toMatch(/itself/);
    expect(validatePlan([
      bin({ id: "a", depends_on: ["b"] }), bin({ id: "b", depends_on: ["a"] }),
    ])).toMatch(/cycle/);
    expect(validatePlan(Array.from({ length: 9 }, (_, i) => bin({ id: `b${i}` })))).toMatch(/too many/);
  });
});

describe("relay v1 behaviors", () => {
  let ctx: TestCtx;
  let relay: RelayEngine;
  let worker: string;

  beforeEach(async () => {
    ctx = await setup();
    relay = new RelayEngine(ctx.db, ctx.engine, new MockLlm());
    ctx.engine.setHooks({ onTaskFinished: (t) => relay.onTaskFinished(t) });
    worker = await createWorker(ctx.db, { tier: "expert" });
  });
  afterEach(async () => { await ctx.db.close(); });

  it("negotiation: vague question -> clarify -> re-plan -> resolve", async () => {
    const t = await relay.start(ctx.orgId, "Fix it?");
    expect(t.status).toBe("needs_clarification");
    expect(t.clarification_question).toBeTruthy();

    const replanned = (await relay.clarify(t.id, ctx.orgId, "The boiler in unit 4 is leaking; decide replace vs repair."))!;
    expect(replanned.status).toBe("running");
    await workThroughTasks(ctx, [worker], () => ({ answer: "yes" }));
    expect((await relay.getTrace(t.id))!.status).toBe("completed");
  });

  it("clarify is one round-trip only; wrong-state clarify is a 409", async () => {
    const stillVague = new (class implements RelayLlm {
      async plan(): Promise<Plan> {
        return { strategy: "clarify", binaries: [], clarification_question: "??" };
      }
      async reassemble() { return { verdict: { answer: "x" }, rationale: "" }; }
    })();
    const r2 = new RelayEngine(ctx.db, ctx.engine, stillVague);
    const t = await r2.start(ctx.orgId, "Fix it?");
    const failed = (await r2.clarify(t.id, ctx.orgId, "still vague"))!;
    expect(failed.status).toBe("failed");
    expect(failed.rationale).toMatch(/ambiguous/);
    await expect(r2.clarify(t.id, ctx.orgId, "again")).rejects.toMatchObject({ status: 409 });
  });

  it("malformed LLM plans are rejected before any human is engaged", async () => {
    const cyclic = new (class implements RelayLlm {
      async plan(): Promise<Plan> {
        return {
          strategy: "decompose",
          binaries: [
            { id: "a", question: "A?", tier: "basic", depends_on: ["b"], skill_tags: [] },
            { id: "b", question: "B?", tier: "basic", depends_on: ["a"], skill_tags: [] },
          ],
        };
      }
      async reassemble() { return { verdict: { answer: "x" }, rationale: "" }; }
    })();
    const r2 = new RelayEngine(ctx.db, ctx.engine, cyclic);
    const t = await r2.start(ctx.orgId, "Should we do the thing with the cycle?");
    expect(t.status).toBe("failed");
    expect(t.rationale).toMatch(/cycle/);
    const { rows } = await ctx.db.query(`select * from tasks where parent_id = $1`, [t.id]);
    expect(rows).toHaveLength(0);
  });

  it("pattern library: similar questions reuse the decomposition without an LLM call", async () => {
    const q1 = "Should I replace this boiler or repair it?";
    const t1 = await relay.start(ctx.orgId, q1);
    await workThroughTasks(ctx, [worker], () => ({ answer: "yes" }));
    expect((await relay.getTrace(t1.id))!.status).toBe("completed");

    // A planner that explodes proves the pattern path bypasses the LLM.
    const exploding = new (class implements RelayLlm {
      async plan(): Promise<Plan> { throw new Error("LLM should not be called"); }
      async reassemble() { return { verdict: { answer: "yes" }, rationale: "via pattern" }; }
    })();
    const r2 = new RelayEngine(ctx.db, ctx.engine, exploding);
    ctx.engine.setHooks({ onTaskFinished: (t) => r2.onTaskFinished(t) });

    const q2 = "Should I replace this old boiler or repair it?"; // similar, not identical
    const t2 = await r2.start(ctx.orgId, q2);
    expect(t2.status).toBe("running");
    expect(t2.strategy).toBe("pattern");
    // Binaries were instantiated against the NEW question.
    expect(t2.plan!.binaries[0]!.question).toContain(q2);

    await workThroughTasks(ctx, [worker], () => ({ answer: "yes" }));
    expect((await relay.getTrace(t2.id))!.status).toBe("completed");
  });

  it("cache audit: every Nth cached serve dispatches a human check; mismatch resets the cache", async () => {
    const q = "Is this image NSFW?";
    // Build a consensus-3 entry resolved as "no".
    for (let i = 0; i < 3; i++) {
      const t = await relay.start(ctx.orgId, q);
      if ((await relay.getTrace(t.id))!.status !== "completed") {
        await workThroughTasks(ctx, [worker], () => ({ answer: "no" }));
      }
    }
    // Pre-position the use counter one short of the audit boundary.
    await ctx.db.query(`update binary_cache set uses = $1 where question_hash = $2`,
      [AUDIT_EVERY - 1, questionHash(q)]);

    const t = await relay.start(ctx.orgId, q);
    expect(t.status).toBe("completed"); // served from cache
    // ...and an unbilled audit task was dispatched alongside.
    const { rows: audits } = await ctx.db.query<{ id: string; price_cents: number }>(
      `select id, price_cents from tasks where payload ? 'cache_audit_id' and status != 'completed'`);
    expect(audits).toHaveLength(1);
    expect(Number(audits[0]!.price_cents)).toBe(0);

    // The human disagrees -> cache resets and stops serving.
    await workThroughTasks(ctx, [worker], () => ({ answer: "yes" }));
    const { rows: cache } = await ctx.db.query<{ consensus_count: number; audit_mismatches: number }>(
      `select consensus_count, audit_mismatches from binary_cache where question_hash = $1`, [questionHash(q)]);
    expect(Number(cache[0]!.consensus_count)).toBe(1);
    expect(Number(cache[0]!.audit_mismatches)).toBe(1);

    const after = await relay.start(ctx.orgId, q);
    expect(after.status).toBe("running"); // humans are back in the loop
  });

  it("terminal relay states notify org webhooks", async () => {
    await ctx.db.query(
      `insert into webhooks (org_id, url, secret) values ($1, 'https://agent.example/hook', 'whsec_x')`,
      [ctx.orgId],
    );
    const t = await relay.start(ctx.orgId, "Should I replace this boiler or repair it?");
    await workThroughTasks(ctx, [worker], () => ({ answer: "yes" }));
    expect((await relay.getTrace(t.id))!.status).toBe("completed");

    const { rows } = await ctx.db.query<{ event: string; payload: { relay: { id: string } } }>(
      `select event, payload from webhook_deliveries where event like 'relay.%'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event).toBe("relay.completed");
    expect(rows[0]!.payload.relay.id).toBe(t.id);
  });
});
