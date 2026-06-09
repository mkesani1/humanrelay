import { createHash } from "node:crypto";
import type { DB } from "../db.js";
import type { Tier } from "../core/pricing.js";

/**
 * Binary answer cache — Relay V1's pattern learner.
 * Repeat binaries with strong consensus are auto-resolved without a human.
 *
 * Matching is two-stage: exact normalized-text hash, then cosine similarity
 * over a deterministic character-trigram embedding (pluggable; swap for a
 * real embedding model without touching callers).
 */

export const CACHE_MIN_CONSENSUS = 3;
export const CACHE_SIMILARITY_THRESHOLD = 0.97;
const DIM = 256;

export function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

export function questionHash(q: string): string {
  return createHash("sha256").update(normalizeQuestion(q)).digest("hex");
}

export function embed(q: string): number[] {
  const norm = normalizeQuestion(q);
  const v = new Array<number>(DIM).fill(0);
  for (let i = 0; i < norm.length - 2; i++) {
    const tri = norm.slice(i, i + 3);
    let h = 2166136261;
    for (let j = 0; j < tri.length; j++) {
      h ^= tri.charCodeAt(j);
      h = Math.imul(h, 16777619);
    }
    v[(h >>> 0) % DIM]! += 1;
  }
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / mag);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * (b[i] ?? 0);
  return dot;
}

export interface CacheHit {
  cache_id: string;
  tier: Tier;
  verdict: Record<string, unknown>;
  consensus_count: number;
  similarity: number;
  /** Total times this entry has served an answer (after this hit). Drives audit sampling. */
  uses: number;
}

export class BinaryCache {
  constructor(private db: DB) {}

  async lookup(question: string): Promise<CacheHit | null> {
    const hash = questionHash(question);
    const exact = await this.db.query<{ id: string; tier: Tier; verdict: Record<string, unknown>; consensus_count: number; uses: number }>(
      `select id, tier, verdict, consensus_count, uses from binary_cache where question_hash = $1`,
      [hash],
    );
    const e = exact.rows[0];
    if (e && Number(e.consensus_count) >= CACHE_MIN_CONSENSUS) {
      return this.serve({ cache_id: e.id, tier: e.tier, verdict: e.verdict, consensus_count: Number(e.consensus_count), similarity: 1, uses: Number(e.uses) });
    }

    // Similarity scan over recent entries (bounded; replace with pgvector at scale).
    const candidates = await this.db.query<{
      id: string; tier: Tier; embedding: number[]; verdict: Record<string, unknown>; consensus_count: number; uses: number;
    }>(
      `select id, tier, embedding, verdict, consensus_count, uses from binary_cache
        where consensus_count >= $1
        order by last_seen_at desc limit 500`,
      [CACHE_MIN_CONSENSUS],
    );
    const qv = embed(question);
    let best: CacheHit | null = null;
    for (const c of candidates.rows) {
      const sim = cosine(qv, c.embedding);
      if (sim >= CACHE_SIMILARITY_THRESHOLD && (!best || sim > best.similarity)) {
        best = { cache_id: c.id, tier: c.tier, verdict: c.verdict, consensus_count: Number(c.consensus_count), similarity: sim, uses: Number(c.uses) };
      }
    }
    return best ? this.serve(best) : null;
  }

  private async serve(hit: CacheHit): Promise<CacheHit> {
    await this.db.query(`update binary_cache set uses = uses + 1, last_seen_at = now() where id = $1`, [hit.cache_id]);
    return { ...hit, uses: hit.uses + 1 };
  }

  /** Audit outcome: a human re-answered a cached question. */
  async applyAudit(cacheId: string, humanVerdict: Record<string, unknown>): Promise<void> {
    const { rows } = await this.db.query<{ verdict: Record<string, unknown> }>(
      `select verdict from binary_cache where id = $1`, [cacheId]);
    const row = rows[0];
    if (!row) return;
    const match = String(row.verdict["answer"] ?? "").toLowerCase() === String(humanVerdict["answer"] ?? "").toLowerCase();
    if (match) {
      await this.db.query(`update binary_cache set consensus_count = consensus_count + 1 where id = $1`, [cacheId]);
    } else {
      // Drift detected: human ground truth wins; cache must re-earn consensus.
      await this.db.query(
        `update binary_cache set verdict = $2, consensus_count = 1, audit_mismatches = audit_mismatches + 1 where id = $1`,
        [cacheId, JSON.stringify(humanVerdict)],
      );
    }
  }

  /** Record a human-resolved binary. Same answer increments consensus; a different answer resets it. */
  async record(question: string, tier: Tier, verdict: Record<string, unknown>): Promise<void> {
    const hash = questionHash(question);
    const norm = normalizeQuestion(question);
    const existing = await this.db.query<{ id: string; verdict: Record<string, unknown> }>(
      `select id, verdict from binary_cache where question_hash = $1`,
      [hash],
    );
    const row = existing.rows[0];
    if (!row) {
      await this.db.query(
        `insert into binary_cache (question_norm, question_hash, embedding, tier, verdict)
         values ($1,$2,$3,$4,$5)`,
        [norm, hash, JSON.stringify(embed(question)), tier, JSON.stringify(verdict)],
      );
      return;
    }
    const same = String(row.verdict["answer"] ?? "").toLowerCase() === String(verdict["answer"] ?? "").toLowerCase();
    if (same) {
      await this.db.query(
        `update binary_cache set consensus_count = consensus_count + 1, last_seen_at = now() where id = $1`,
        [row.id],
      );
    } else {
      await this.db.query(
        `update binary_cache set verdict = $2, consensus_count = 1, last_seen_at = now() where id = $1`,
        [row.id, JSON.stringify(verdict)],
      );
    }
  }
}
