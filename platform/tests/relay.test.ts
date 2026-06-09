import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setup, createWorker, workThroughTasks, type TestCtx } from "./helpers.js";
import { RelayEngine } from "../src/relay/engine.js";
import { MockLlm } from "../src/relay/llm.js";
import { BinaryCache, embed, cosine, normalizeQuestion, CACHE_MIN_CONSENSUS } from "../src/relay/cache.js";

describe("binary cache", () => {
  it("embedding is deterministic and similarity-sensitive", () => {
    const a = embed("Is the boiler more than 15 years old?");
    const b = embed("Is the boiler more than 15 years old???");
    const c = embed("Does the contract include an arbitration clause?");
    expect(cosine(a, a)).toBeCloseTo(1);
    expect(cosine(a, b)).toBeGreaterThan(0.97);
    expect(cosine(a, c)).toBeLessThan(0.8);
    expect(normalizeQuestion("  Is THIS, spam?! ")).toBe("is this spam");
  });

  it("consensus builds on agreement, resets on conflict, serves at threshold", async () => {
    const ctx = await setup();
    const cache = new BinaryCache(ctx.db);
    const q = "Is this image NSFW?";
    for (let i = 0; i < CACHE_MIN_CONSENSUS - 1; i++) {
      await cache.record(q, "basic", { answer: "no" });
      expect(await cache.lookup(q)).toBeNull(); // below threshold
    }
    await cache.record(q, "basic", { answer: "no" });
    const hit = await cache.lookup(q);
    expect(hit?.verdict).toEqual({ answer: "no" });

    await cache.record(q, "basic", { answer: "yes" }); // conflict resets
    expect(await cache.lookup(q)).toBeNull();
    await ctx.db.close();
  });
});

describe("relay engine", () => {
  let ctx: TestCtx;
  let relay: RelayEngine;

  beforeEach(async () => {
    ctx = await setup();
    relay = new RelayEngine(ctx.db, ctx.engine, new MockLlm());
    ctx.engine.setHooks({ onTaskFinished: (t) => relay.onTaskFinished(t) });
  });
  afterEach(async () => { await ctx.db.close(); });

  it("direct strategy: binary-shaped question becomes a single task", async () => {
    const worker = await createWorker(ctx.db, { tier: "expert" });
    const trace = await relay.start(ctx.orgId, "Is this invoice a duplicate?");
    expect(trace.strategy).toBe("direct");
    expect(trace.status).toBe("running");

    await workThroughTasks(ctx, [worker], () => ({ answer: "yes" }));
    const done = (await relay.getTrace(trace.id))!;
    expect(done.status).toBe("completed");
    expect(String(done.verdict!["answer"])).toBe("yes");
    expect(done.total_cost_cents).toBe(50);
  });

  it("decompose strategy: waves respect dependencies, costs accumulate", async () => {
    const worker = await createWorker(ctx.db, { tier: "expert" });
    const trace = await relay.start(ctx.orgId, "Should I replace this boiler or repair it?");
    expect(trace.strategy).toBe("decompose");

    // Wave 1: two independent binaries have tasks; the dependent one waits.
    let t = (await relay.getTrace(trace.id))!;
    const states = () => t.plan!.binaries.map((b) => ({ id: b.id, hasTask: !!b.task_id, resolved: !!b.verdict }));
    expect(states()).toEqual([
      { id: "b1", hasTask: true, resolved: false },
      { id: "b2", hasTask: true, resolved: false },
      { id: "b3", hasTask: false, resolved: false },
    ]);

    await workThroughTasks(ctx, [worker], (task) => ({
      answer: String(task.payload["question"]).includes("right call") ? "yes" : "yes",
    }));

    t = (await relay.getTrace(trace.id))!;
    expect(t.status).toBe("completed");
    expect(String(t.verdict!["answer"])).toBe("yes");
    // b1 basic (50) + b2 expert (250) + b3 expert (250)
    expect(t.total_cost_cents).toBe(550);

    // The dependent binary saw prior findings in its payload.
    const { rows } = await ctx.db.query<{ payload: { question: string } }>(
      `select payload from tasks where relay_binary_id = 'b3'`);
    expect(rows[0]!.payload.question).toContain("[prior]");
  });

  it("budget: plans exceeding max_cost_cents are refused before any human is engaged", async () => {
    const trace = await relay.start(ctx.orgId, "Should I replace this boiler or repair it?", {
      maxCostCents: 100,
    });
    expect(trace.status).toBe("over_budget");
    const { rows } = await ctx.db.query(`select * from tasks where parent_id = $1`, [trace.id]);
    expect(rows).toHaveLength(0);
  });

  it("tier cap downgrades expert binaries", async () => {
    const trace = await relay.start(ctx.orgId, "Should I replace this boiler or repair it?", {
      tierCap: "basic",
    });
    expect(trace.plan!.binaries.every((b) => b.tier === "basic")).toBe(true);
  });

  it("cache: repeat binaries auto-resolve and identical questions short-circuit", async () => {
    const worker = await createWorker(ctx.db, { tier: "expert" });
    const q = "Should I replace this boiler or repair it?";

    // Run the same question until binaries reach cache consensus (3 agreeing resolutions).
    for (let i = 0; i < 3; i++) {
      await relay.start(ctx.orgId, q);
      await workThroughTasks(ctx, [worker], () => ({ answer: "yes" }));
    }

    // 4th run: wave-1 binaries hit the per-binary cache; humans only see what's novel.
    const t4 = await relay.start(ctx.orgId, q);
    const done4 = (await relay.getTrace(t4.id))!;
    if (done4.status !== "completed") {
      await workThroughTasks(ctx, [worker], () => ({ answer: "yes" }));
    }
    const final4 = (await relay.getTrace(t4.id))!;
    expect(final4.status).toBe("completed");
    expect(final4.cache_hits).toBeGreaterThan(0);
    expect(final4.total_cost_cents).toBeLessThan(550);

    // Whole-question consensus reached -> full short-circuit, zero tasks, zero cost.
    const t5 = await relay.start(ctx.orgId, q);
    expect(t5.status).toBe("completed");
    expect(t5.strategy).toBe("cache");
    expect(t5.total_cost_cents).toBe(0);
  });
});
