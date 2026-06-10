/**
 * Vercel serverless entry for the HumanRelay API.
 * Deploy: Vercel project with Root Directory = platform.
 * Env: DATABASE_URL (Supabase pooled, port 6543), ADMIN_TOKEN, RELAY_MODE, ANTHROPIC_API_KEY, CRON_SECRET.
 */
import { handle } from "hono/vercel";
import { createDb } from "../src/db.js";
import { buildPlatform, type Platform } from "../src/server.js";

let platformPromise: Promise<Platform> | null = null;

// Background loops don't exist in serverless: run maintenance opportunistically
// (throttled) on traffic, with Vercel Cron as the idle-period backstop.
let lastMaintenance = 0;
const MAINTENANCE_INTERVAL_MS = 30_000;

async function getPlatform(): Promise<Platform> {
  if (!platformPromise) {
    platformPromise = (async () => {
      const db = await createDb(); // DATABASE_URL -> pg Pool; absent -> PGlite (preview only)
      return buildPlatform(db);    // runs idempotent migrations on cold start
    })();
    // Never cache a failed boot: a transient DB error on cold start would
    // otherwise pin this instance at 500 for its entire lifetime.
    platformPromise.catch(() => { platformPromise = null; });
  }
  return platformPromise;
}

const handler = async (req: Request): Promise<Response> => {
  const platform = await getPlatform();
  const now = Date.now();
  if (now - lastMaintenance > MAINTENANCE_INTERVAL_MS) {
    lastMaintenance = now;
    // Fire-and-forget; never blocks or fails a customer request.
    platform.engine.expireLeases().catch(() => {});
    platform.dispatcher.processDue().catch(() => {});
  }
  return handle(platform.app)(req);
};

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export default handler;
