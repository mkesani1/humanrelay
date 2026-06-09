import type { DB } from "../db.js";
import { tierAtLeast, type Tier } from "./pricing.js";
import { routingScore } from "./quality.js";

export interface WorkerRow {
  id: string;
  name: string;
  tier: Tier;
  skills: string[];
  active: boolean;
  gold_alpha: number;
  gold_beta: number;
  tasks_since_gold: number;
  active_assignments?: number;
}

/**
 * Pick the best worker for a task: must be active, at or above the required
 * tier, and cover all requested skill tags. Ranked by quality score
 * (uncertainty-discounted accuracy), tie-broken by current load so work
 * spreads across the bench.
 */
export function rankWorkers(workers: WorkerRow[], tier: Tier, skillTags: string[]): WorkerRow[] {
  return workers
    .filter(
      (w) =>
        w.active &&
        tierAtLeast(w.tier, tier) &&
        skillTags.every((t) => w.skills.includes(t)),
    )
    .sort((a, b) => {
      const load = (a.active_assignments ?? 0) - (b.active_assignments ?? 0);
      if (load !== 0) return load; // least-loaded first
      return routingScore(b) - routingScore(a);
    });
}

export async function loadWorkersWithLoad(db: DB): Promise<WorkerRow[]> {
  const { rows } = await db.query<WorkerRow & { active_assignments: string | number }>(
    `select w.*, coalesce(a.cnt, 0) as active_assignments
       from workers w
       left join (
         select worker_id, count(*) as cnt from assignments where status = 'active' group by worker_id
       ) a on a.worker_id = w.id`,
  );
  return rows.map((r) => ({ ...r, active_assignments: Number(r.active_assignments) }));
}
