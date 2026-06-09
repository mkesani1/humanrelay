import { createPgliteDb, migrate, type DB } from "../src/db.js";
import { TaskEngine } from "../src/core/engine.js";
import type { Tier } from "../src/core/pricing.js";

export interface TestCtx {
  db: DB;
  engine: TaskEngine;
  systemOrgId: string;
  orgId: string;
}

export async function setup(): Promise<TestCtx> {
  const db = await createPgliteDb();
  await migrate(db);
  const systemOrgId = await createOrg(db, "HumanRelay Internal");
  const orgId = await createOrg(db, "Acme Robotics");
  const engine = new TaskEngine(db, systemOrgId);
  return { db, engine, systemOrgId, orgId };
}

export async function createOrg(db: DB, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(`insert into orgs (name) values ($1) returning id`, [name]);
  return rows[0]!.id;
}

export async function createWorker(
  db: DB,
  opts: { name?: string; tier?: Tier; skills?: string[]; alpha?: number; beta?: number } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into workers (name, tier, skills, gold_alpha, gold_beta) values ($1,$2,$3,$4,$5) returning id`,
    [opts.name ?? "Worker", opts.tier ?? "basic", opts.skills ?? [], opts.alpha ?? 1, opts.beta ?? 1],
  );
  return rows[0]!.id;
}

export async function addGoldItem(
  db: DB,
  opts: { tier?: Tier; expected?: Record<string, unknown> } = {},
): Promise<void> {
  await db.query(
    `insert into gold_items (primitive, tier, payload, expected) values ('classify',$1,$2,$3)`,
    [opts.tier ?? "basic", JSON.stringify({ question: "Is this spam?" }), JSON.stringify(opts.expected ?? { answer: "yes" })],
  );
}

/** Simulated workforce: claims and answers everything pending with the given verdict fn. */
export async function workThroughTasks(
  ctx: TestCtx,
  workerIds: string[],
  verdictFor: (task: { payload: Record<string, unknown>; relay_binary_id: string | null }) => Record<string, unknown>,
  rounds = 20,
): Promise<number> {
  let answered = 0;
  for (let i = 0; i < rounds; i++) {
    let any = false;
    for (const w of workerIds) {
      const claim = await ctx.engine.claimNext(w);
      if (!claim) continue;
      any = true;
      await ctx.engine.submitAnswer(claim.assignment_id, verdictFor(claim.task), "test rationale");
      answered++;
    }
    if (!any) break;
  }
  return answered;
}
