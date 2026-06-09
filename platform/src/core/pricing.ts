export type Tier = "basic" | "complex" | "expert";

/** One binary, one price. Cents, matching the public pricing page. */
export const TIER_PRICE_CENTS: Record<Tier, number> = {
  basic: 50,
  complex: 100,
  expert: 250,
};

export const TIER_ORDER: Tier[] = ["basic", "complex", "expert"];

export function tierAtLeast(worker: Tier, required: Tier): boolean {
  return TIER_ORDER.indexOf(worker) >= TIER_ORDER.indexOf(required);
}

/** Lease durations: how long a worker holds a task before it is reassigned. */
export const LEASE_SECONDS: Record<Tier, number> = {
  basic: 120,
  complex: 300,
  expert: 900,
};

export function currentPeriod(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
