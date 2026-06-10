import { serve } from "@hono/node-server";
import { randomBytes } from "node:crypto";
import { createDb, migrate, type DB } from "./db.js";
import { TaskEngine } from "./core/engine.js";
import { TeleopService } from "./core/teleop.js";
import { CaptureService } from "./core/capture.js";
import { RelayEngine } from "./relay/engine.js";
import { MockLlm, RealLlm } from "./relay/llm.js";
import { WebhookDispatcher } from "./api/webhooks.js";
import { createApp } from "./api/app.js";

async function bootstrapSystemOrg(db: DB): Promise<string> {
  const existing = await db.query<{ id: string }>(`select id from orgs where name = $1`, ["HumanRelay Internal"]);
  if (existing.rows[0]) return existing.rows[0].id;
  const { rows } = await db.query<{ id: string }>(
    `insert into orgs (name) values ('HumanRelay Internal') returning id`);
  return rows[0]!.id;
}

export interface Platform {
  db: DB;
  engine: TaskEngine;
  relay: RelayEngine;
  teleop: TeleopService;
  capture: CaptureService;
  dispatcher: WebhookDispatcher;
  app: ReturnType<typeof createApp>;
  adminToken: string;
  /** Non-null when boot-time migrations could not apply (e.g. the runtime role lacks DDL rights). */
  migrationError: string | null;
}

/** Wire the whole platform together. Shared by server.ts and the test suite. */
export async function buildPlatform(db: DB, opts: { adminToken?: string; relayMode?: string } = {}): Promise<Platform> {
  // A failed migration must degrade the service, not kill it: endpoints that
  // don't need the new schema keep working, and /health reports the pending
  // migration so it's impossible to miss. (Learned in prod: the runtime role
  // may not own the tables, so DDL can fail where DML succeeds.)
  let migrationError: string | null = null;
  try {
    await migrate(db);
  } catch (err) {
    migrationError = err instanceof Error ? err.message : String(err);
    console.error(`[humanrelay] MIGRATION FAILED — running on existing schema: ${migrationError}`);
  }
  const systemOrgId = await bootstrapSystemOrg(db);
  const engine = new TaskEngine(db, systemOrgId);
  const llm = (opts.relayMode ?? process.env.RELAY_MODE ?? "mock") === "live" ? new RealLlm() : new MockLlm();
  const relay = new RelayEngine(db, engine, llm);
  const teleop = new TeleopService(db, engine);
  const capture = new CaptureService(db);
  const dispatcher = new WebhookDispatcher(db);

  engine.setHooks({
    onTaskFinished: async (task) => {
      await relay.onTaskFinished(task);
      await teleop.onTaskFinished(task);
    },
  });

  const adminToken = opts.adminToken ?? process.env.ADMIN_TOKEN ?? randomBytes(16).toString("hex");
  const app = createApp({ db, engine, relay, teleop, capture, dispatcher, adminToken, migrationError });
  return { db, engine, relay, teleop, capture, dispatcher, app, adminToken, migrationError };
}

const isMain = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (isMain) {
  const db = await createDb();
  const platform = await buildPlatform(db);
  if (!process.env.ADMIN_TOKEN) {
    console.log(`[humanrelay] generated admin token: ${platform.adminToken}`);
  }
  if (!process.env.DATABASE_URL) {
    console.log("[humanrelay] DATABASE_URL not set — running on in-process PGlite (dev mode)");
  }

  // Background maintenance loops.
  setInterval(() => platform.engine.expireLeases().catch(console.error), 15_000);
  setInterval(() => platform.dispatcher.processDue().catch(console.error), 10_000);

  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: platform.app.fetch, port });
  console.log(`[humanrelay] api listening on :${port} — worker bench at /console`);
}
