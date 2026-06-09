import { randomUUID } from "node:crypto";
import type { DB } from "../db.js";
import { TIER_PRICE_CENTS, LEASE_SECONDS, currentPeriod, type Tier } from "./pricing.js";
import { rankWorkers, loadWorkersWithLoad, type WorkerRow } from "./routing.js";
import { shouldInjectGold, updateOnGold, verdictMatches } from "./quality.js";

export type Primitive =
  | "classify" | "judge" | "extract" | "escalate" | "resolve"
  | "safety_confirm" | "annotate";

export interface TaskRow {
  id: string;
  org_id: string;
  idempotency_key: string | null;
  primitive: Primitive;
  tier: Tier;
  status: "pending" | "assigned" | "answered" | "completed" | "failed" | "expired" | "canceled";
  payload: Record<string, unknown>;
  rubric: string | null;
  skill_tags: string[];
  consensus_n: number;
  price_cents: number;
  attempts: number;
  max_attempts: number;
  is_gold: boolean;
  gold_expected: Record<string, unknown> | null;
  parent_kind: "relay" | "teleop" | "dataset" | null;
  parent_id: string | null;
  relay_binary_id: string | null;
  result: Record<string, unknown> | null;
  rationale: string | null;
  webhook_url: string | null;
  created_at: Date;
  completed_at: Date | null;
}

export interface CreateTaskInput {
  orgId: string;
  primitive: Primitive;
  tier: Tier;
  payload: Record<string, unknown>;
  rubric?: string;
  skillTags?: string[];
  consensusN?: number;
  idempotencyKey?: string;
  webhookUrl?: string;
  parentKind?: "relay" | "teleop" | "dataset";
  parentId?: string;
  relayBinaryId?: string;
  /** Internal tasks (gold, flywheel annotation) are not billed to the org. */
  billable?: boolean;
}

export interface EngineHooks {
  /** Called after a (non-gold) task completes or fails terminally. */
  onTaskFinished?: (task: TaskRow) => Promise<void>;
}

export class TaskEngine {
  constructor(
    private db: DB,
    private systemOrgId: string,
    private hooks: EngineHooks = {},
  ) {}

  setHooks(hooks: EngineHooks) {
    this.hooks = hooks;
  }

  // ---------- creation ----------

  async createTask(input: CreateTaskInput): Promise<{ task: TaskRow; deduped: boolean }> {
    if (input.idempotencyKey) {
      const existing = await this.db.query<TaskRow>(
        `select * from tasks where org_id = $1 and idempotency_key = $2`,
        [input.orgId, input.idempotencyKey],
      );
      if (existing.rows[0]) return { task: existing.rows[0], deduped: true };
    }
    const billable = input.billable !== false;
    const { rows } = await this.db.query<TaskRow>(
      `insert into tasks (org_id, idempotency_key, primitive, tier, payload, rubric, skill_tags,
                          consensus_n, price_cents, webhook_url, parent_kind, parent_id, relay_binary_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
      [
        input.orgId,
        input.idempotencyKey ?? null,
        input.primitive,
        input.tier,
        JSON.stringify(input.payload),
        input.rubric ?? null,
        input.skillTags ?? [],
        input.consensusN ?? 1,
        billable ? TIER_PRICE_CENTS[input.tier] : 0,
        input.webhookUrl ?? null,
        input.parentKind ?? null,
        input.parentId ?? null,
        input.relayBinaryId ?? null,
      ],
    );
    const task = rows[0]!;
    await this.event(task.id, "created", { primitive: task.primitive, tier: task.tier });
    return { task, deduped: false };
  }

  // ---------- worker pull ----------

  /**
   * Worker claims their next task. Periodically a gold item is injected
   * instead of real work — indistinguishable to the worker.
   */
  async claimNext(workerId: string): Promise<{ task: TaskRow; assignment_id: string; lease_expires_at: Date } | null> {
    const worker = await this.getWorker(workerId);
    if (!worker || !worker.active) return null;

    if (shouldInjectGold(worker.tasks_since_gold)) {
      const gold = await this.makeGoldTask(worker);
      if (gold) return this.assign(gold, worker);
    }

    // Oldest eligible pending task this worker can do and hasn't answered yet.
    const { rows } = await this.db.query<TaskRow>(
      `select t.* from tasks t
        where t.status = 'pending'
          and t.tier in (select unnest($2::text[]))
          and t.skill_tags <@ $3::text[]
          and not exists (select 1 from answers a where a.task_id = t.id and a.worker_id = $1)
          and not exists (select 1 from assignments s where s.task_id = t.id and s.status = 'active')
        order by t.created_at asc
        limit 1`,
      [workerId, eligibleTiers(worker.tier), worker.skills],
    );
    const task = rows[0];
    if (!task) return null;
    return this.assign(task, worker);
  }

  private async assign(task: TaskRow, worker: WorkerRow) {
    const lease = new Date(Date.now() + LEASE_SECONDS[task.tier] * 1000);
    const { rows } = await this.db.query<{ id: string }>(
      `insert into assignments (task_id, worker_id, lease_expires_at) values ($1,$2,$3) returning id`,
      [task.id, worker.id, lease],
    );
    await this.db.query(`update tasks set status = 'assigned' where id = $1`, [task.id]);
    await this.event(task.id, "assigned", { worker_id: worker.id, lease_expires_at: lease.toISOString() });
    return { task: { ...task, status: "assigned" as const }, assignment_id: rows[0]!.id, lease_expires_at: lease };
  }

  private async makeGoldTask(worker: WorkerRow): Promise<TaskRow | null> {
    const { rows } = await this.db.query<{
      id: string; primitive: Primitive; tier: Tier; payload: Record<string, unknown>;
      rubric: string | null; expected: Record<string, unknown>;
    }>(
      `select * from gold_items
        where active and tier in (select unnest($1::text[]))
        order by random() limit 1`,
      [eligibleTiers(worker.tier)],
    );
    const item = rows[0];
    if (!item) return null;
    const { rows: created } = await this.db.query<TaskRow>(
      `insert into tasks (org_id, primitive, tier, payload, rubric, price_cents, is_gold, gold_expected)
       values ($1,$2,$3,$4,$5,0,true,$6) returning *`,
      [this.systemOrgId, item.primitive, item.tier, JSON.stringify(item.payload), item.rubric, JSON.stringify(item.expected)],
    );
    const task = created[0]!;
    await this.event(task.id, "created", { gold: true });
    return task;
  }

  // ---------- answers ----------

  async submitAnswer(
    assignmentId: string,
    verdict: Record<string, unknown>,
    rationale?: string,
  ): Promise<TaskRow> {
    const { rows } = await this.db.query<{
      id: string; task_id: string; worker_id: string; status: string; lease_ok: boolean;
    }>(
      `select id, task_id, worker_id, status, (lease_expires_at > now()) as lease_ok
         from assignments where id = $1`,
      [assignmentId],
    );
    const a = rows[0];
    if (!a) throw new ApiError(404, "assignment not found");
    if (a.status !== "active") throw new ApiError(409, `assignment is ${a.status}`);
    if (!a.lease_ok) throw new ApiError(409, "lease expired");

    const task = await this.getTask(a.task_id);
    if (!task) throw new ApiError(404, "task not found");
    if (task.status !== "assigned") throw new ApiError(409, `task is ${task.status}`);
    // Expert-tier accountability: a verdict without reasoning is not deliverable.
    if (task.tier === "expert" && !task.is_gold && !rationale?.trim()) {
      throw new ApiError(422, "rationale is required for expert-tier tasks");
    }

    const goldCorrect = task.is_gold ? verdictMatches(verdict, task.gold_expected) : null;

    await this.db.query(
      `insert into answers (task_id, assignment_id, worker_id, verdict, rationale, gold_correct)
       values ($1,$2,$3,$4,$5,$6)`,
      [task.id, a.id, a.worker_id, JSON.stringify(verdict), rationale ?? null, goldCorrect],
    );
    await this.db.query(
      `update assignments set status = 'completed', completed_at = now() where id = $1`,
      [a.id],
    );
    await this.event(task.id, "answered", { worker_id: a.worker_id });

    if (task.is_gold) {
      await this.gradeGold(task, a.worker_id, goldCorrect === true);
      return (await this.getTask(task.id))!;
    }

    await this.bumpTasksSinceGold(a.worker_id);

    const { rows: cnt } = await this.db.query<{ n: string | number }>(
      `select count(*) as n from answers where task_id = $1`,
      [task.id],
    );
    if (Number(cnt[0]!.n) >= task.consensus_n) {
      return this.completeTask(task.id);
    }
    // Needs more independent answers — back to the pool.
    await this.db.query(`update tasks set status = 'pending' where id = $1`, [task.id]);
    await this.event(task.id, "awaiting_consensus", {});
    return (await this.getTask(task.id))!;
  }

  private async gradeGold(task: TaskRow, workerId: string, correct: boolean) {
    const worker = await this.getWorker(workerId);
    if (worker) {
      const updated = updateOnGold(worker, correct);
      await this.db.query(
        `update workers set gold_alpha = $2, gold_beta = $3, tasks_since_gold = 0 where id = $1`,
        [workerId, updated.gold_alpha, updated.gold_beta],
      );
    }
    await this.db.query(
      `update tasks set status = 'completed', completed_at = now(), result = $2 where id = $1`,
      [task.id, JSON.stringify({ gold_correct: correct })],
    );
    await this.event(task.id, "gold_graded", { worker_id: workerId, correct });
  }

  private async completeTask(taskId: string): Promise<TaskRow> {
    const task = (await this.getTask(taskId))!;
    const { rows: answers } = await this.db.query<{
      verdict: Record<string, unknown>; rationale: string | null; worker_id: string;
    }>(`select verdict, rationale, worker_id from answers where task_id = $1 order by created_at`, [taskId]);

    const { verdict, rationale } = aggregateAnswers(answers);
    await this.db.query(
      `update tasks set status = 'completed', completed_at = now(), result = $2, rationale = $3 where id = $1`,
      [taskId, JSON.stringify(verdict), rationale],
    );
    await this.event(taskId, "completed", { verdict });

    if (task.price_cents > 0) await this.meter(task);
    const finished = (await this.getTask(taskId))!;
    await this.emitWebhooks(finished, "task.completed");
    await this.hooks.onTaskFinished?.(finished);
    return finished;
  }

  // ---------- maintenance ----------

  /** Expire overdue leases; requeue or fail tasks past max_attempts. */
  async expireLeases(now = new Date()): Promise<{ expired: number; failed: number }> {
    const { rows } = await this.db.query<{ id: string; task_id: string }>(
      `update assignments set status = 'expired'
        where status = 'active' and lease_expires_at < $1
        returning id, task_id`,
      [now],
    );
    let failed = 0;
    for (const a of rows) {
      const { rows: t } = await this.db.query<TaskRow>(
        `update tasks set attempts = attempts + 1 where id = $1 returning *`,
        [a.task_id],
      );
      const task = t[0]!;
      await this.event(task.id, "lease_expired", { assignment_id: a.id, attempts: task.attempts });
      if (task.attempts >= task.max_attempts) {
        await this.db.query(`update tasks set status = 'failed' where id = $1`, [task.id]);
        await this.event(task.id, "failed", { reason: "max_attempts" });
        const finished = (await this.getTask(task.id))!;
        await this.emitWebhooks(finished, "task.failed");
        await this.hooks.onTaskFinished?.(finished);
        failed++;
      } else {
        await this.db.query(`update tasks set status = 'pending' where id = $1`, [task.id]);
      }
    }
    return { expired: rows.length, failed };
  }

  // ---------- billing & webhooks ----------

  private async meter(task: TaskRow) {
    await this.db.query(
      `insert into usage_meters (org_id, period, primitive, tier, calls, amount_cents)
       values ($1,$2,$3,$4,1,$5)
       on conflict (org_id, period, primitive, tier)
       do update set calls = usage_meters.calls + 1, amount_cents = usage_meters.amount_cents + $5`,
      [task.org_id, currentPeriod(), task.primitive, task.tier, task.price_cents],
    );
  }

  private async emitWebhooks(task: TaskRow, event: string) {
    const payload = {
      event,
      task: publicTask(task),
    };
    const { rows: hooks } = await this.db.query<{ url: string; secret: string }>(
      `select url, secret from webhooks where org_id = $1 and active`,
      [task.org_id],
    );
    const targets = [...hooks];
    if (task.webhook_url) {
      const { rows: org } = await this.db.query<{ webhook_secret: string }>(
        `select webhook_secret from orgs where id = $1`,
        [task.org_id],
      );
      targets.push({ url: task.webhook_url, secret: org[0]!.webhook_secret });
    }
    for (const t of targets) {
      await this.db.query(
        `insert into webhook_deliveries (org_id, url, secret, event, payload) values ($1,$2,$3,$4,$5)`,
        [task.org_id, t.url, t.secret, event, JSON.stringify(payload)],
      );
    }
  }

  // ---------- helpers ----------

  async getTask(id: string): Promise<TaskRow | null> {
    const { rows } = await this.db.query<TaskRow>(`select * from tasks where id = $1`, [id]);
    return rows[0] ?? null;
  }

  async getWorker(id: string): Promise<WorkerRow | null> {
    const { rows } = await this.db.query<WorkerRow>(`select * from workers where id = $1`, [id]);
    return rows[0] ?? null;
  }

  private async bumpTasksSinceGold(workerId: string) {
    await this.db.query(`update workers set tasks_since_gold = tasks_since_gold + 1 where id = $1`, [workerId]);
  }

  async event(taskId: string, type: string, data: Record<string, unknown>) {
    await this.db.query(`insert into task_events (task_id, type, data) values ($1,$2,$3)`, [
      taskId, type, JSON.stringify(data),
    ]);
  }

  /** Best worker for a tier/skill combination (used by teleop operator pick). */
  async pickWorker(tier: Tier, skills: string[]): Promise<WorkerRow | null> {
    const workers = await loadWorkersWithLoad(this.db);
    return rankWorkers(workers, tier, skills)[0] ?? null;
  }
}

function eligibleTiers(workerTier: Tier): Tier[] {
  const order: Tier[] = ["basic", "complex", "expert"];
  return order.slice(0, order.indexOf(workerTier) + 1);
}

/** Majority vote on verdict.answer; ties broken by first answer. */
export function aggregateAnswers(
  answers: { verdict: Record<string, unknown>; rationale: string | null }[],
): { verdict: Record<string, unknown>; rationale: string | null } {
  if (answers.length === 1) return { verdict: answers[0]!.verdict, rationale: answers[0]!.rationale };
  const counts = new Map<string, number>();
  for (const a of answers) {
    const key = String(a.verdict["answer"] ?? JSON.stringify(a.verdict)).trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let winner: string | null = null;
  let max = -1;
  for (const a of answers) {
    const key = String(a.verdict["answer"] ?? JSON.stringify(a.verdict)).trim().toLowerCase();
    const c = counts.get(key)!;
    if (c > max) { max = c; winner = key; }
  }
  const winning = answers.find(
    (a) => String(a.verdict["answer"] ?? JSON.stringify(a.verdict)).trim().toLowerCase() === winner,
  )!;
  return { verdict: winning.verdict, rationale: winning.rationale };
}

export function publicTask(t: TaskRow) {
  return {
    id: t.id,
    primitive: t.primitive,
    tier: t.tier,
    status: t.status,
    payload: t.payload,
    rubric: t.rubric,
    skill_tags: t.skill_tags,
    consensus_n: t.consensus_n,
    price_cents: t.price_cents,
    result: t.result,
    rationale: t.rationale,
    created_at: t.created_at,
    completed_at: t.completed_at,
  };
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
