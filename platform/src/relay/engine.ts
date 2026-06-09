import type { DB } from "../db.js";
import { TaskEngine, type TaskRow } from "../core/engine.js";
import { TIER_PRICE_CENTS, type Tier } from "../core/pricing.js";
import { BinaryCache } from "./cache.js";
import type { Plan, RelayLlm } from "./llm.js";

/**
 * Relay engine: negotiate -> decompose -> route -> reassemble.
 * Event-driven: task completions advance the trace via onTaskFinished.
 */

export interface PlanBinaryState {
  id: string;
  question: string;
  tier: Tier;
  depends_on: string[];
  skill_tags: string[];
  task_id?: string;
  verdict?: Record<string, unknown>;
  rationale?: string | null;
  from_cache?: boolean;
  cost_cents: number;
}

export interface TraceRow {
  id: string;
  org_id: string;
  question: string;
  tier_cap: Tier;
  max_cost_cents: number | null;
  strategy: string | null;
  status: "planning" | "running" | "reassembling" | "completed" | "failed" | "over_budget";
  plan: { binaries: PlanBinaryState[] } | null;
  verdict: Record<string, unknown> | null;
  rationale: string | null;
  total_cost_cents: number;
  cache_hits: number;
  created_at: Date;
  completed_at: Date | null;
}

export class RelayEngine {
  private cache: BinaryCache;

  constructor(
    private db: DB,
    private tasks: TaskEngine,
    private llm: RelayLlm,
  ) {
    this.cache = new BinaryCache(db);
  }

  async start(
    orgId: string,
    question: string,
    opts: { tierCap?: Tier; maxCostCents?: number } = {},
  ): Promise<TraceRow> {
    const tierCap = opts.tierCap ?? "expert";
    const { rows } = await this.db.query<TraceRow>(
      `insert into relay_traces (org_id, question, tier_cap, max_cost_cents) values ($1,$2,$3,$4) returning *`,
      [orgId, question, tierCap, opts.maxCostCents ?? null],
    );
    const trace = rows[0]!;

    // Whole-question cache short-circuit.
    const hit = await this.cache.lookup(question);
    if (hit) {
      await this.db.query(
        `update relay_traces set status='completed', strategy='cache', verdict=$2,
                rationale=$3, cache_hits=1, completed_at=now() where id=$1`,
        [trace.id, JSON.stringify(hit.verdict),
         `Resolved from binary cache (consensus ${hit.consensus_count}, similarity ${hit.similarity.toFixed(3)}).`],
      );
      return (await this.getTrace(trace.id))!;
    }

    const plan = await this.llm.plan(question, tierCap);
    const binaries = planToState(plan, question, tierCap);

    // Budget check up front: refuse plans that cannot fit.
    const planned = binaries.reduce((s, b) => s + TIER_PRICE_CENTS[b.tier], 0);
    if (opts.maxCostCents != null && planned > opts.maxCostCents) {
      await this.db.query(
        `update relay_traces set status='over_budget', strategy=$2, plan=$3, completed_at=now() where id=$1`,
        [trace.id, plan.strategy, JSON.stringify({ binaries })],
      );
      return (await this.getTrace(trace.id))!;
    }

    await this.db.query(`update relay_traces set strategy=$2, status='running', plan=$3 where id=$1`, [
      trace.id, plan.strategy, JSON.stringify({ binaries }),
    ]);

    await this.advance(trace.id);
    return (await this.getTrace(trace.id))!;
  }

  /** Hook for TaskEngine: a relay child task finished. */
  async onTaskFinished(task: TaskRow): Promise<void> {
    if (task.parent_kind !== "relay" || !task.parent_id) return;
    const trace = await this.getTrace(task.parent_id);
    if (!trace || !trace.plan || (trace.status !== "running" && trace.status !== "reassembling")) return;

    const binaries = trace.plan.binaries;
    const b = binaries.find((x) => x.id === task.relay_binary_id);
    if (!b) return;

    if (task.status === "failed") {
      await this.db.query(
        `update relay_traces set status='failed', plan=$2, rationale=$3, completed_at=now() where id=$1`,
        [trace.id, JSON.stringify({ binaries }), `Binary "${b.question}" failed to resolve.`],
      );
      return;
    }

    b.verdict = task.result ?? {};
    b.rationale = task.rationale;
    b.cost_cents = task.price_cents;
    await this.cache.record(b.question, b.tier, b.verdict);

    const total = binaries.reduce((s, x) => s + (x.verdict ? x.cost_cents : 0), 0);
    await this.db.query(`update relay_traces set plan=$2, total_cost_cents=$3 where id=$1`, [
      trace.id, JSON.stringify({ binaries }), total,
    ]);
    await this.advance(trace.id);
  }

  /** Create tasks for every binary whose dependencies are resolved; reassemble when all done. */
  private async advance(traceId: string): Promise<void> {
    const trace = (await this.getTrace(traceId))!;
    const binaries = trace.plan!.binaries;
    const resolved = (id: string) => binaries.find((b) => b.id === id)?.verdict != null;

    let dirty = false;
    for (const b of binaries) {
      if (b.task_id || b.verdict) continue;
      if (!b.depends_on.every(resolved)) continue;

      // Per-binary cache: skip the human when consensus already exists.
      const hit = await this.cache.lookup(contextualized(b, binaries));
      if (hit) {
        b.verdict = hit.verdict;
        b.rationale = `cache (consensus ${hit.consensus_count})`;
        b.from_cache = true;
        b.cost_cents = 0;
        await this.db.query(`update relay_traces set cache_hits = cache_hits + 1 where id = $1`, [traceId]);
        dirty = true;
        continue;
      }

      const { task } = await this.tasks.createTask({
        orgId: trace.org_id,
        primitive: "classify",
        tier: b.tier,
        payload: { question: contextualized(b, binaries), relay: true },
        skillTags: b.skill_tags,
        parentKind: "relay",
        parentId: trace.id,
        relayBinaryId: b.id,
      });
      b.task_id = task.id;
      dirty = true;
    }
    if (dirty) {
      await this.db.query(`update relay_traces set plan=$2 where id=$1`, [traceId, JSON.stringify({ binaries })]);
    }

    if (binaries.every((b) => b.verdict != null)) {
      await this.db.query(`update relay_traces set status='reassembling' where id=$1`, [traceId]);
      const out = await this.llm.reassemble(
        trace.question,
        binaries.map((b) => ({ question: b.question, verdict: b.verdict!, rationale: b.rationale ?? null })),
      );
      const total = binaries.reduce((s, x) => s + x.cost_cents, 0);
      await this.db.query(
        `update relay_traces set status='completed', verdict=$2, rationale=$3, total_cost_cents=$4,
                plan=$5, completed_at=now() where id=$1`,
        [traceId, JSON.stringify(out.verdict), out.rationale, total, JSON.stringify({ binaries })],
      );
      // Whole-question cache so identical questions short-circuit entirely.
      await this.cache.record(trace.question, trace.tier_cap, out.verdict);
    } else if (dirty && binaries.some((b) => b.from_cache && !b.task_id)) {
      // Cache hits may have unlocked the next wave.
      const pendingUnlocked = binaries.some(
        (b) => !b.task_id && !b.verdict && b.depends_on.every(resolved),
      );
      if (pendingUnlocked) await this.advance(traceId);
    }
  }

  async getTrace(id: string): Promise<TraceRow | null> {
    const { rows } = await this.db.query<TraceRow>(`select * from relay_traces where id = $1`, [id]);
    return rows[0] ?? null;
  }
}

function planToState(plan: Plan, question: string, tierCap: Tier): PlanBinaryState[] {
  if (plan.strategy === "direct") {
    return [{
      id: "b1", question, tier: capTier(plan.tier ?? "basic", tierCap),
      depends_on: [], skill_tags: [], cost_cents: 0,
    }];
  }
  return plan.binaries.map((b) => ({
    ...b, tier: capTier(b.tier, tierCap), cost_cents: 0,
  }));
}

function capTier(tier: Tier, cap: Tier): Tier {
  const order: Tier[] = ["basic", "complex", "expert"];
  return order[Math.min(order.indexOf(tier), order.indexOf(cap))]!;
}

/** Dependent binaries see the verdicts of what they depend on. */
function contextualized(b: PlanBinaryState, all: PlanBinaryState[]): string {
  if (b.depends_on.length === 0) return b.question;
  const ctx = b.depends_on
    .map((id) => all.find((x) => x.id === id))
    .filter((x): x is PlanBinaryState => !!x?.verdict)
    .map((x) => `[prior] ${x.question} -> ${String(x.verdict!["answer"] ?? JSON.stringify(x.verdict))}`)
    .join("\n");
  return `${b.question}\n${ctx}`;
}

export function publicTrace(t: TraceRow) {
  return {
    id: t.id,
    question: t.question,
    strategy: t.strategy,
    status: t.status,
    tier_cap: t.tier_cap,
    binaries: t.plan?.binaries.map((b) => ({
      id: b.id, question: b.question, tier: b.tier, depends_on: b.depends_on,
      status: b.verdict ? "resolved" : b.task_id ? "in_progress" : "waiting",
      verdict: b.verdict ?? null, from_cache: b.from_cache ?? false, cost_cents: b.cost_cents,
    })) ?? [],
    verdict: t.verdict,
    rationale: t.rationale,
    total_cost_cents: t.total_cost_cents,
    cache_hits: t.cache_hits,
    created_at: t.created_at,
    completed_at: t.completed_at,
  };
}
