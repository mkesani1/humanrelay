import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setup, createWorker, addGoldItem, type TestCtx } from "./helpers.js";
import { posteriorMean, routingScore, updateOnGold, shouldInjectGold, verdictMatches, GOLD_CADENCE } from "../src/core/quality.js";
import { rankWorkers, type WorkerRow } from "../src/core/routing.js";
import { aggregateAnswers } from "../src/core/engine.js";

describe("quality math", () => {
  it("posterior mean and update", () => {
    let q = { gold_alpha: 1, gold_beta: 1 };
    expect(posteriorMean(q)).toBeCloseTo(0.5);
    q = updateOnGold(q, true);
    q = updateOnGold(q, true);
    q = updateOnGold(q, false);
    expect(q).toEqual({ gold_alpha: 3, gold_beta: 2 });
    expect(posteriorMean(q)).toBeCloseTo(0.6);
  });

  it("routing score discounts uncertainty", () => {
    const proven = { gold_alpha: 90, gold_beta: 10 };  // 0.9 over 100 golds
    const newbie = { gold_alpha: 9, gold_beta: 1 };    // 0.9 over 10 golds
    expect(routingScore(proven)).toBeGreaterThan(routingScore(newbie));
  });

  it("gold cadence", () => {
    expect(shouldInjectGold(0)).toBe(false);
    expect(shouldInjectGold(GOLD_CADENCE - 1)).toBe(true);
  });

  it("verdict matching is forgiving on case/whitespace for answers", () => {
    expect(verdictMatches({ answer: " Yes " }, { answer: "yes" })).toBe(true);
    expect(verdictMatches({ answer: "no" }, { answer: "yes" })).toBe(false);
    expect(verdictMatches({ label: "a" }, { label: "a" })).toBe(true);
  });
});

describe("routing", () => {
  const w = (over: Partial<WorkerRow>): WorkerRow => ({
    id: crypto.randomUUID(), name: "w", tier: "basic", skills: [], active: true,
    gold_alpha: 1, gold_beta: 1, tasks_since_gold: 0, active_assignments: 0, ...over,
  });

  it("filters by tier and skills, ranks by quality then load", () => {
    const expert = w({ tier: "expert", skills: ["medical"], gold_alpha: 9, gold_beta: 1 });
    const basic = w({ tier: "basic" });
    const busyExpert = w({ tier: "expert", skills: ["medical"], gold_alpha: 99, gold_beta: 1, active_assignments: 3 });
    const ranked = rankWorkers([basic, busyExpert, expert], "expert", ["medical"]);
    expect(ranked.map((x) => x.id)).toEqual([expert.id, busyExpert.id]); // least-loaded first
    expect(rankWorkers([basic], "expert", [])).toHaveLength(0);
  });
});

describe("aggregation", () => {
  it("majority vote on answer", () => {
    const { verdict } = aggregateAnswers([
      { verdict: { answer: "yes" }, rationale: "a" },
      { verdict: { answer: "no" }, rationale: "b" },
      { verdict: { answer: "YES" }, rationale: "c" },
    ]);
    expect(String(verdict["answer"]).toLowerCase()).toBe("yes");
  });
});

describe("task engine lifecycle", () => {
  let ctx: TestCtx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(async () => { await ctx.db.close(); });

  it("idempotency: same key returns same task", async () => {
    const a = await ctx.engine.createTask({
      orgId: ctx.orgId, primitive: "judge", tier: "basic", payload: { q: 1 }, idempotencyKey: "k1",
    });
    const b = await ctx.engine.createTask({
      orgId: ctx.orgId, primitive: "judge", tier: "basic", payload: { q: 1 }, idempotencyKey: "k1",
    });
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    expect(b.task.id).toBe(a.task.id);
  });

  it("happy path: claim -> answer -> completed, metered, audited", async () => {
    const workerId = await createWorker(ctx.db, { tier: "basic" });
    const { task } = await ctx.engine.createTask({
      orgId: ctx.orgId, primitive: "classify", tier: "basic", payload: { question: "Is this spam?" },
    });

    const claim = await ctx.engine.claimNext(workerId);
    expect(claim?.task.id).toBe(task.id);

    const done = await ctx.engine.submitAnswer(claim!.assignment_id, { answer: "yes" }, "obvious spam");
    expect(done.status).toBe("completed");
    expect(done.result).toEqual({ answer: "yes" });

    const { rows: meters } = await ctx.db.query<{ calls: number; amount_cents: number }>(
      `select calls, amount_cents from usage_meters where org_id = $1`, [ctx.orgId]);
    expect(Number(meters[0]!.calls)).toBe(1);
    expect(Number(meters[0]!.amount_cents)).toBe(50);

    const { rows: events } = await ctx.db.query<{ type: string }>(
      `select type from task_events where task_id = $1 order by id`, [task.id]);
    expect(events.map((e) => e.type)).toEqual(["created", "assigned", "answered", "completed"]);
  });

  it("consensus: two answers required, majority wins, no double-answering", async () => {
    const w1 = await createWorker(ctx.db, { name: "w1" });
    const w2 = await createWorker(ctx.db, { name: "w2" });
    const { task } = await ctx.engine.createTask({
      orgId: ctx.orgId, primitive: "judge", tier: "basic", payload: {}, consensusN: 2,
    });

    const c1 = await ctx.engine.claimNext(w1);
    await ctx.engine.submitAnswer(c1!.assignment_id, { answer: "no" });
    expect((await ctx.engine.getTask(task.id))!.status).toBe("pending");

    // w1 cannot claim the same task again
    expect(await ctx.engine.claimNext(w1)).toBeNull();

    const c2 = await ctx.engine.claimNext(w2);
    expect(c2!.task.id).toBe(task.id);
    const done = await ctx.engine.submitAnswer(c2!.assignment_id, { answer: "no" });
    expect(done.status).toBe("completed");
    expect(done.result).toEqual({ answer: "no" });
  });

  it("lease expiry requeues then fails after max attempts", async () => {
    const workerId = await createWorker(ctx.db);
    const { task } = await ctx.engine.createTask({
      orgId: ctx.orgId, primitive: "classify", tier: "basic", payload: {},
    });
    const future = new Date(Date.now() + 10 * 60 * 1000);

    for (let attempt = 1; attempt <= 3; attempt++) {
      const claim = await ctx.engine.claimNext(workerId);
      expect(claim).not.toBeNull();
      const res = await ctx.engine.expireLeases(future);
      expect(res.expired).toBe(1);
      const t = (await ctx.engine.getTask(task.id))!;
      if (attempt < 3) {
        expect(t.status).toBe("pending");
        // worker answered nothing, so they can claim again
      } else {
        expect(t.status).toBe("failed");
      }
    }
  });

  it("gold injection: cadence triggers, posterior updates, org not billed", async () => {
    const workerId = await createWorker(ctx.db);
    await addGoldItem(ctx.db, { expected: { answer: "yes" } });
    await ctx.db.query(`update workers set tasks_since_gold = 9 where id = $1`, [workerId]);

    const claim = await ctx.engine.claimNext(workerId);
    expect(claim).not.toBeNull();
    const t = (await ctx.engine.getTask(claim!.task.id))!;
    expect(t.is_gold).toBe(true);

    await ctx.engine.submitAnswer(claim!.assignment_id, { answer: "no" }); // wrong
    const w = (await ctx.engine.getWorker(workerId))!;
    expect(Number(w.gold_beta)).toBe(2);
    expect(Number(w.gold_alpha)).toBe(1);
    expect(w.tasks_since_gold).toBe(0);

    const { rows: meters } = await ctx.db.query(`select * from usage_meters`);
    expect(meters).toHaveLength(0);
  });

  it("webhook deliveries enqueued on completion with org + per-task targets", async () => {
    await ctx.db.query(
      `insert into webhooks (org_id, url, secret) values ($1, 'https://example.com/hook', 'whsec_org')`,
      [ctx.orgId],
    );
    const workerId = await createWorker(ctx.db);
    await ctx.engine.createTask({
      orgId: ctx.orgId, primitive: "resolve", tier: "basic", payload: {},
      webhookUrl: "https://example.com/per-task",
    });
    const claim = await ctx.engine.claimNext(workerId);
    await ctx.engine.submitAnswer(claim!.assignment_id, { answer: "done" });

    const { rows } = await ctx.db.query<{ url: string; event: string }>(
      `select url, event from webhook_deliveries order by url`);
    expect(rows.map((r) => r.url)).toEqual(["https://example.com/hook", "https://example.com/per-task"]);
    expect(rows.every((r) => r.event === "task.completed")).toBe(true);
  });
});
