import { createHmac } from "node:crypto";
import type { DB } from "../db.js";

/**
 * Webhook dispatcher: at-least-once delivery with HMAC signatures and
 * exponential backoff. Run via processDue() on an interval (server.ts) or
 * on demand (tests, admin endpoint).
 */

export const SIGNATURE_HEADER = "x-humanrelay-signature";
export const MAX_ATTEMPTS = 5;

export function sign(payload: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifySignature(payload: string, secret: string, header: string): boolean {
  return sign(payload, secret) === header;
}

export type FetchLike = (url: string, init: {
  method: string; headers: Record<string, string>; body: string;
}) => Promise<{ ok: boolean; status: number }>;

export class WebhookDispatcher {
  constructor(private db: DB, private fetchFn: FetchLike = fetch as unknown as FetchLike) {}

  async processDue(now = new Date()): Promise<{ delivered: number; retried: number; failed: number }> {
    const { rows } = await this.db.query<{
      id: string; url: string; secret: string; event: string; payload: Record<string, unknown>; attempts: number;
    }>(
      `select id, url, secret, event, payload, attempts from webhook_deliveries
        where status = 'pending' and next_attempt_at <= $1
        order by next_attempt_at asc limit 50`,
      [now],
    );

    let delivered = 0, retried = 0, failed = 0;
    for (const d of rows) {
      const body = JSON.stringify(d.payload);
      let ok = false;
      try {
        const res = await this.fetchFn(d.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [SIGNATURE_HEADER]: sign(body, d.secret),
            "x-humanrelay-event": d.event,
            "x-humanrelay-delivery": d.id,
          },
          body,
        });
        ok = res.ok;
      } catch {
        ok = false;
      }

      if (ok) {
        await this.db.query(
          `update webhook_deliveries set status='delivered', attempts=attempts+1, delivered_at=now() where id=$1`,
          [d.id],
        );
        delivered++;
      } else if (d.attempts + 1 >= MAX_ATTEMPTS) {
        await this.db.query(
          `update webhook_deliveries set status='failed', attempts=attempts+1 where id=$1`,
          [d.id],
        );
        failed++;
      } else {
        const backoffMs = Math.pow(2, d.attempts + 1) * 30_000; // 1m, 2m, 4m, 8m
        await this.db.query(
          `update webhook_deliveries set attempts=attempts+1, next_attempt_at=$2 where id=$1`,
          [d.id, new Date(now.getTime() + backoffMs)],
        );
        retried++;
      }
    }
    return { delivered, retried, failed };
  }
}
