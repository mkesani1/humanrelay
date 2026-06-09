/**
 * Worker quality engine.
 *
 * Each worker carries a Beta(alpha, beta) posterior over their accuracy,
 * updated only by gold-set results (tasks with a known expected answer,
 * indistinguishable from real work). Routing weights workers by posterior
 * mean, slightly discounted for uncertainty so unproven workers don't
 * outrank proven ones at the same mean.
 */

export interface QualityState {
  gold_alpha: number;
  gold_beta: number;
}

export function posteriorMean(q: QualityState): number {
  return q.gold_alpha / (q.gold_alpha + q.gold_beta);
}

/** Lower confidence bound (~1 sigma below mean). Used for routing rank. */
export function routingScore(q: QualityState): number {
  const n = q.gold_alpha + q.gold_beta;
  const mean = posteriorMean(q);
  const variance = (q.gold_alpha * q.gold_beta) / (n * n * (n + 1));
  return mean - Math.sqrt(variance);
}

export function updateOnGold(q: QualityState, correct: boolean): QualityState {
  return {
    gold_alpha: q.gold_alpha + (correct ? 1 : 0),
    gold_beta: q.gold_beta + (correct ? 0 : 1),
  };
}

/** Inject a gold item every N real tasks per worker (deterministic cadence). */
export const GOLD_CADENCE = 10;

export function shouldInjectGold(tasksSinceGold: number): boolean {
  return tasksSinceGold >= GOLD_CADENCE - 1;
}

/**
 * Compare a worker verdict against a gold expectation.
 * Binary verdicts ({"answer": "yes"|"no"}) compare on the answer field;
 * anything else falls back to deep equality on JSON.
 */
export function verdictMatches(verdict: unknown, expected: unknown): boolean {
  const v = verdict as Record<string, unknown> | null;
  const e = expected as Record<string, unknown> | null;
  if (v && e && typeof v === "object" && typeof e === "object" && "answer" in e) {
    return normalize(v["answer"]) === normalize(e["answer"]);
  }
  return JSON.stringify(verdict) === JSON.stringify(expected);
}

function normalize(x: unknown): string {
  return String(x ?? "").trim().toLowerCase();
}
