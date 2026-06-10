import type { DB } from "../db.js";
import { TaskEngine, ApiError, type TaskRow } from "../core/engine.js";
import { TIER_PRICE_CENTS, type Tier } from "../core/pricing.js";
import { BinaryCache, embed, cosine, normalizeQuestion, questionHash, type CacheHit } from "./cache.js";
import type { Plan, RelayLlm } from "./llm.js";

/**
 * Relay engine: negotiate -> decompose -> route -> reassemble. See RELAY-SPEC.md.
 * Event-driven: task completions advance the trace via onTaskFinished.
 */

/** Every Nth use of a cached answer is re-verified by a human (unbilled). */
export const AUDIT_EVERY = 10;
/** Pattern-library reuse threshold (looser than the answer cache: structure transfers further than answers). */
export const PATTERN_SIMILARITY = 0.88;
/** V2 gate — Relay answering binaries itself beyond the consensus cache. Product decision, off. */
export const AUTO_RESOLVE_ENABLED = false;
const MAX_BINARIES = 8;

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
  content: unknown | null;
  tier_cap: Tier;
  max_cost_cents: number | null;
  strategy: string | null;
  status: "planning" | "needs_clarification" | "running" | "reassembling" | "completed" | "failed" | "over_budget";
  plan: { binaries: PlanBinaryState[] } | null;
  verdict: Record<string, unknown> | null;
  rationale: string | null;
  clarification_question: string | null;
  clarification_answer: string | null;
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
    opts: { tierCap?: Tier; maxCostCents?: number; content?: unknown } = {},
  ): Promise<TraceRow> {
    const tierCap = opts.tierCap ?? "expert";
    const hasContent = opts.content !== undefined && opts.content !== null;
    const { rows } = await this.db.query<TraceRow>(
      `insert into relay_traces (org_id, question, tier_cap, max_cost_cents, content) values ($1,$2,$3,$4,$5) returning *`,
      [orgId, question, tierCap, opts.maxCostCents ?? null, hasContent ? JSON.stringify(opts.content) : null],
    );
    const trace = rows[0]!;

    // [0] Whole-question cache short-circuit — only when the question text alone
    // identifies the case. A content-bearing trace (a camera frame, a document)
    // always gets fresh human eyes: same text + different frame must never share answers.
    const hit = hasContent ? null : await this.cache.lookup(question);
    if (hit) {
      await this.db.query(
        `update relay_traces set status='completed', strategy='cache', verdict=$2,
                rationale=$3, cache_hits=1, completed_at=now() where id=$1`,
        [trace.id, JSON.stringify(hit.verdict),
         `Resolved from binary cache (consensus ${hit.consensus_count}, similarity ${hit.similarity.toFixed(3)}).`],
      );
      await this.maybeAudit(orgId, question, hit);
      const done = (await this.getTrace(trace.id))!;
      await this.notify(done);
      return done;
    }

    // [1] Pattern library: reuse a known decomposition shape with zero LLM calls.
    const pattern = await this.lookupPattern(question);
    if (pattern) {
      return this.adoptPlan(trace.id, { strategy: "decompose", binaries: pattern }, question, tierCap, opts.maxCostCents, "pattern");
    }

    // [2] Negotiate / plan.
    const plan = await this.llm.plan(question, tierCap);
    if (plan.strategy === "clarify") {
      await this.db.query(
        `update relay_traces set status='needs_clarification', strategy='clarify', clarification_question=$2 where id=$1`,
        [trace.id, plan.clarification_question ?? "Please provide more context for this question."],
      );
      return (await this.getTrace(trace.id))!;
    }
    return this.adoptPlan(trace.id, plan, question, tierCap, opts.maxCostCents, plan.strategy);
  }

  /** The one clarification round-trip: agent answers Relay's question; Relay re-plans. */
  async clarify(traceId: string, orgId: string, answer: string): Promise<TraceRow | null> {
    const trace = await this.getTrace(traceId);
    if (!trace || trace.org_id !== orgId) return null;
    if (trace.status !== "needs_clarification") {
      throw new ApiError(409, `trace is ${trace.status}, not awaiting clarification`);
    }
    const enriched = `${trace.question}\nClarification: ${answer}`;
    await this.db.query(`update relay_traces set clarification_answer=$2, question=$3 where id=$1`, [
      traceId, answer, enriched,
    ]);

    const plan = await this.llm.plan(enriched, trace.tier_cap);
    if (plan.strategy === "clarify") {
      // One round-trip only (V0 contract) — a plan that still can't proceed fails honestly.
      await this.db.query(
        `update relay_traces set status='failed', rationale=$2, completed_at=now() where id=$1`,
        [traceId, "Question remained too ambiguous after one clarification round-trip."],
      );
      const failed = (await this.getTrace(traceId))!;
      await this.notify(failed);
      return failed;
    }
    return this.adoptPlan(traceId, plan, enriched, trace.tier_cap, trace.max_cost_cents ?? undefined, plan.strategy);
  }

  /** Validate, persist, budget-check, and launch a plan. */
  private async adoptPlan(
    traceId: string,
    plan: Plan,
    question: string,
    tierCap: Tier,
    maxCostCents: number | undefined,
    strategy: string,
  ): Promise<TraceRow> {
    const binaries = planToState(plan, question, tierCap);

    // [3] Structural validation — never engage a human against a malformed plan.
    const invalid = validatePlan(binaries);
    if (invalid) {
      await this.db.query(
        `update relay_traces set status='failed', strategy=$2, rationale=$3, completed_at=now() where id=$1`,
        [traceId, strategy, `Plan rejected: ${invalid}`],
      );
      const failed = (await this.getTrace(traceId))!;
      await this.notify(failed);
      return failed;
    }

    const planned = binaries.reduce((s, b) => s + TIER_PRICE_CENTS[b.tier], 0);
    if (maxCostCents != null && planned > maxCostCents) {
      await this.db.query(
        `update relay_traces set status='over_budget', strategy=$2, plan=$3, completed_at=now() where id=$1`,
        [traceId, strategy, JSON.stringify({ binaries })],
      );
      const refused = (await this.getTrace(traceId))!;
      await this.notify(refused);
      return refused;
    }

    await this.db.query(
      `update relay_traces set strategy=$2, status='running', plan=$3, clarification_question=coalesce(clarification_question, null) where id=$1`,
      [traceId, strategy, JSON.stringify({ binaries })],
    );
    await this.advance(traceId);
    return (await this.getTrace(traceId))!;
  }

  /** Hook for TaskEngine: a task finished — may be a relay binary or a cache audit. */
  async onTaskFinished(task: TaskRow): Promise<void> {
    // Cache audits: human re-verification of a cached answer.
    const auditId = task.payload["cache_audit_id"];
    if (typeof auditId === "string" && task.status === "completed" && task.result) {
      await this.cache.applyAudit(auditId, task.result);
      return;
    }

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
      await this.notify((await this.getTrace(trace.id))!);
      return;
    }

    b.verdict = task.result ?? {};
    b.rationale = task.rationale;
    b.cost_cents = task.price_cents;
    // Content-bearing answers are about the attached frame/document, not the
    // question text — caching them under the text would poison future lookups.
    if (trace.content == null) await this.cache.record(b.question, b.tier, b.verdict);

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

      const q = contextualized(b, binaries);
      // Per-binary cache: skip the human when consensus already exists.
      // Never for content-bearing traces — the text doesn't identify the case.
      const hit = trace.content == null ? await this.cache.lookup(q) : null;
      if (hit) {
        b.verdict = hit.verdict;
        b.rationale = `cache (consensus ${hit.consensus_count})`;
        b.from_cache = true;
        b.cost_cents = 0;
        await this.db.query(`update relay_traces set cache_hits = cache_hits + 1 where id = $1`, [traceId]);
        await this.maybeAudit(trace.org_id, q, hit);
        dirty = true;
        continue;
      }

      const { task } = await this.tasks.createTask({
        orgId: trace.org_id,
        primitive: "classify",
        tier: b.tier,
        payload: {
          question: q,
          relay: true,
          ...(trace.content != null ? { content: trace.content } : {}),
        },
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
      // [6] Learn: whole-question cache + decomposition pattern. Content-bearing
      // verdicts stay out of the cache (text alone doesn't identify the case);
      // decomposition *structure* still transfers, so patterns are always saved.
      if (trace.content == null) await this.cache.record(trace.question, trace.tier_cap, out.verdict);
      if (binaries.length > 1) await this.savePattern(trace.question, binaries);
      await this.notify((await this.getTrace(traceId))!);
    } else if (dirty) {
      // Cache hits may have unlocked the next wave.
      const pendingUnlocked = binaries.some(
        (b) => !b.task_id && !b.verdict && b.depends_on.every(resolved),
      );
      if (pendingUnlocked) await this.advance(traceId);
    }
  }

  // ---------- learning systems ----------

  /** Sampled human re-verification of cached answers (unbilled). See RELAY-SPEC §4.2. */
  private async maybeAudit(orgId: string, question: string, hit: CacheHit): Promise<void> {
    if (hit.uses % AUDIT_EVERY !== 0) return;
    await this.tasks.createTask({
      orgId,
      primitive: "classify",
      tier: hit.tier,
      payload: { question, cache_audit_id: hit.cache_id },
      billable: false,
    });
  }

  private async savePattern(question: string, binaries: PlanBinaryState[]): Promise<void> {
    const hash = questionHash(question);
    const template = binaries.map((b) => ({
      id: b.id,
      question: b.question.split(question).join("{{question}}"),
      tier: b.tier,
      depends_on: b.depends_on,
      skill_tags: b.skill_tags,
    }));
    await this.db.query(
      `insert into relay_patterns (question_norm, question_hash, embedding, plan)
       values ($1,$2,$3,$4)
       on conflict (question_hash) do update set uses = relay_patterns.uses + 1, last_used_at = now()`,
      [normalizeQuestion(question), hash, JSON.stringify(embed(question)), JSON.stringify({ binaries: template })],
    );
  }

  private async lookupPattern(question: string): Promise<PlanBinaryState[] | null> {
    const { rows } = await this.db.query<{
      id: string; embedding: number[]; plan: { binaries: Omit<PlanBinaryState, "cost_cents">[] };
    }>(`select id, embedding, plan from relay_patterns order by last_used_at desc limit 200`);
    const qv = embed(question);
    let best: { id: string; sim: number; plan: { binaries: Omit<PlanBinaryState, "cost_cents">[] } } | null = null;
    for (const r of rows) {
      const sim = cosine(qv, r.embedding);
      if (sim >= PATTERN_SIMILARITY && (!best || sim > best.sim)) best = { id: r.id, sim, plan: r.plan };
    }
    if (!best) return null;
    await this.db.query(`update relay_patterns set uses = uses + 1, last_used_at = now() where id = $1`, [best.id]);
    return best.plan.binaries.map((b) => ({
      ...b,
      question: b.question.split("{{question}}").join(question),
      task_id: undefined, verdict: undefined, rationale: undefined, from_cache: undefined,
      cost_cents: 0,
    }));
  }

  // ---------- integration ----------

  /** relay.completed / relay.failed webhooks to all active org webhooks. */
  private async notify(trace: TraceRow): Promise<void> {
    const terminal = ["completed", "failed", "over_budget"].includes(trace.status);
    if (!terminal) return;
    const event = trace.status === "completed" ? "relay.completed" : "relay.failed";
    const { rows: hooks } = await this.db.query<{ url: string; secret: string }>(
      `select url, secret from webhooks where org_id = $1 and active`,
      [trace.org_id],
    );
    for (const h of hooks) {
      await this.db.query(
        `insert into webhook_deliveries (org_id, url, secret, event, payload) values ($1,$2,$3,$4,$5)`,
        [trace.org_id, h.url, h.secret, event, JSON.stringify({ event, relay: publicTrace(trace) })],
      );
    }
  }

  async getTrace(id: string): Promise<TraceRow | null> {
    const { rows } = await this.db.query<TraceRow>(`select * from relay_traces where id = $1`, [id]);
    return rows[0] ?? null;
  }
}

// ---------- pure helpers ----------

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

/** Returns a rejection reason, or null if the plan is structurally sound. */
export function validatePlan(binaries: PlanBinaryState[]): string | null {
  if (binaries.length === 0) return "empty plan";
  if (binaries.length > MAX_BINARIES) return `too many binaries (${binaries.length} > ${MAX_BINARIES})`;
  const ids = new Set<string>();
  for (const b of binaries) {
    if (ids.has(b.id)) return `duplicate binary id "${b.id}"`;
    ids.add(b.id);
  }
  for (const b of binaries) {
    for (const d of b.depends_on) {
      if (!ids.has(d)) return `binary "${b.id}" depends on unknown id "${d}"`;
      if (d === b.id) return `binary "${b.id}" depends on itself`;
    }
  }
  // Kahn's algorithm: every binary must be reachable through resolved dependencies.
  const indeg = new Map<string, number>(binaries.map((b) => [b.id, b.depends_on.length]));
  const queue = binaries.filter((b) => b.depends_on.length === 0).map((b) => b.id);
  let seen = 0;
  while (queue.length) {
    const id = queue.shift()!;
    seen++;
    for (const b of binaries) {
      if (b.depends_on.includes(id)) {
        const left = indeg.get(b.id)! - 1;
        indeg.set(b.id, left);
        if (left === 0) queue.push(b.id);
      }
    }
  }
  if (seen !== binaries.length) return "dependency cycle detected";
  return null;
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
    clarification_question: t.clarification_question,
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
