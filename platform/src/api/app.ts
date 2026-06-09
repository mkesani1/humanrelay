import { Hono } from "hono";
import type { Context, Next } from "hono";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { DB } from "../db.js";
import { TaskEngine, ApiError, publicTask, type Primitive } from "../core/engine.js";
import { currentPeriod, type Tier } from "../core/pricing.js";
import { RelayEngine, publicTrace } from "../relay/engine.js";
import { TeleopService, publicSession } from "../core/teleop.js";
import { CaptureService } from "../core/capture.js";
import { WebhookDispatcher } from "./webhooks.js";

export interface AppDeps {
  db: DB;
  engine: TaskEngine;
  relay: RelayEngine;
  teleop: TeleopService;
  capture: CaptureService;
  dispatcher: WebhookDispatcher;
  adminToken: string;
}

type Env = { Variables: { orgId: string } };

const PRIMITIVES: Primitive[] = ["classify", "judge", "extract", "escalate", "resolve"];

const TaskBody = z.object({
  content: z.unknown().optional(),
  question: z.string().optional(),
  rubric: z.string().optional(),
  tier: z.enum(["basic", "complex", "expert"]).default("basic"),
  skill_tags: z.array(z.string()).default([]),
  consensus: z.number().int().min(1).max(5).default(1),
  webhook_url: z.string().url().optional(),
});

const RelayBody = z.object({
  question: z.string().min(3),
  tier_cap: z.enum(["basic", "complex", "expert"]).default("expert"),
  max_cost_cents: z.number().int().positive().optional(),
});

export function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function createApp(deps: AppDeps) {
  const app = new Hono<Env>();
  const { db, engine, relay, teleop, capture, dispatcher, adminToken } = deps;

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.message }, err.status as 400);
    if (err instanceof z.ZodError) return c.json({ error: "invalid request", issues: err.issues }, 400);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true, service: "humanrelay-platform" }));

  // ---------- customer API auth ----------

  const requireOrg = async (c: Context<Env>, next: Next) => {
    const header = c.req.header("authorization") ?? "";
    const raw = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!raw) return c.json({ error: "missing bearer token" }, 401);
    const { rows } = await db.query<{ org_id: string }>(
      `select org_id from api_keys where key_hash = $1 and revoked_at is null`,
      [hashKey(raw)],
    );
    if (!rows[0]) return c.json({ error: "invalid api key" }, 401);
    c.set("orgId", rows[0].org_id);
    await next();
  };

  // ---------- the five primitives ----------

  for (const primitive of PRIMITIVES) {
    app.post(`/v1/${primitive}`, requireOrg, async (c) => {
      const body = TaskBody.parse(await c.req.json().catch(() => ({})));
      const tier: Tier = primitive === "escalate" ? "expert" : body.tier;
      const { task, deduped } = await engine.createTask({
        orgId: c.get("orgId"),
        primitive,
        tier,
        payload: {
          ...(body.question ? { question: body.question } : {}),
          ...(body.content !== undefined ? { content: body.content } : {}),
        },
        rubric: body.rubric,
        skillTags: body.skill_tags,
        consensusN: body.consensus,
        webhookUrl: body.webhook_url,
        idempotencyKey: c.req.header("idempotency-key") ?? undefined,
      });
      return c.json({ task: publicTask(task), deduped }, deduped ? 200 : 202);
    });
  }

  app.get("/v1/tasks/:id", requireOrg, async (c) => {
    const task = await engine.getTask((c.req.param("id") ?? ""));
    if (!task || task.org_id !== c.get("orgId")) return c.json({ error: "not found" }, 404);
    const { rows: events } = await db.query(
      `select type, data, created_at from task_events where task_id = $1 order by id`,
      [task.id],
    );
    return c.json({ task: publicTask(task), events });
  });

  // ---------- Relay ----------

  app.post("/v1/relay", requireOrg, async (c) => {
    const body = RelayBody.parse(await c.req.json());
    const trace = await relay.start(c.get("orgId"), body.question, {
      tierCap: body.tier_cap,
      maxCostCents: body.max_cost_cents,
    });
    return c.json({ relay: publicTrace(trace) }, trace.status === "completed" ? 200 : 202);
  });

  app.get("/v1/relay/:id", requireOrg, async (c) => {
    const trace = await relay.getTrace((c.req.param("id") ?? ""));
    if (!trace || trace.org_id !== c.get("orgId")) return c.json({ error: "not found" }, 404);
    return c.json({ relay: publicTrace(trace) });
  });

  // ---------- Teleop ----------

  app.post("/v1/teleop/sessions", requireOrg, async (c) => {
    const body = z.object({
      robot_id: z.string().min(1),
      context: z.record(z.string(), z.unknown()).default({}),
      control_scope: z.record(z.string(), z.unknown()).default({}),
    }).parse(await c.req.json());
    const session = await teleop.requestSession(c.get("orgId"), {
      robotId: body.robot_id, context: body.context, controlScope: body.control_scope,
    });
    return c.json({ session: publicSession(session) }, 202);
  });

  app.get("/v1/teleop/sessions/:id", requireOrg, async (c) => {
    const s = await teleop.getSession((c.req.param("id") ?? ""));
    if (!s || s.org_id !== c.get("orgId")) return c.json({ error: "not found" }, 404);
    return c.json({ session: publicSession(s) });
  });

  app.post("/v1/teleop/sessions/:id/handback", requireOrg, async (c) => {
    const body = z.object({
      recording_url: z.string().url().optional(),
      resolution: z.string().optional(),
    }).parse(await c.req.json().catch(() => ({})));
    const session = await teleop.handback((c.req.param("id") ?? ""), c.get("orgId"), {
      recordingUrl: body.recording_url, resolution: body.resolution,
    });
    return c.json({ session: publicSession(session) });
  });

  // ---------- Datasets ----------

  app.post("/v1/datasets", requireOrg, async (c) => {
    const body = z.object({
      name: z.string().min(1),
      filter: z.object({
        taxonomy: z.array(z.string()).optional(),
        task_label: z.string().optional(),
        min_duration_s: z.number().int().optional(),
      }).default({}),
    }).parse(await c.req.json());
    const dataset = await capture.buildDataset(c.get("orgId"), body.name, body.filter);
    return c.json({ dataset }, 201);
  });

  app.get("/v1/datasets/:id", requireOrg, async (c) => {
    const dataset = await capture.getDataset((c.req.param("id") ?? ""), c.get("orgId"));
    if (!dataset) return c.json({ error: "not found" }, 404);
    return c.json({ dataset });
  });

  // ---------- Webhooks & usage ----------

  app.post("/v1/webhooks", requireOrg, async (c) => {
    const body = z.object({ url: z.string().url() }).parse(await c.req.json());
    const secret = "whsec_" + randomBytes(24).toString("hex");
    const { rows } = await db.query<{ id: string }>(
      `insert into webhooks (org_id, url, secret) values ($1,$2,$3) returning id`,
      [c.get("orgId"), body.url, secret],
    );
    return c.json({ id: rows[0]!.id, url: body.url, secret }, 201);
  });

  app.get("/v1/usage", requireOrg, async (c) => {
    const { rows } = await db.query(
      `select period, primitive, tier, calls, amount_cents from usage_meters
        where org_id = $1 order by period desc, primitive`,
      [c.get("orgId")],
    );
    return c.json({ period: currentPeriod(), usage: rows });
  });

  // ---------- Worker endpoints (bench/console) ----------

  app.post("/worker/claim", async (c) => {
    const body = z.object({ worker_id: z.string().uuid() }).parse(await c.req.json());
    const claim = await engine.claimNext(body.worker_id);
    if (!claim) return c.body(null, 204);
    return c.json({
      task: publicTask(claim.task),
      assignment_id: claim.assignment_id,
      lease_expires_at: claim.lease_expires_at,
    });
  });

  app.post("/worker/answer", async (c) => {
    const body = z.object({
      assignment_id: z.string().uuid(),
      verdict: z.record(z.string(), z.unknown()),
      rationale: z.string().optional(),
    }).parse(await c.req.json());
    const task = await engine.submitAnswer(body.assignment_id, body.verdict, body.rationale);
    return c.json({ task: publicTask(task) });
  });

  app.get("/worker/:id/stats", async (c) => {
    const w = await engine.getWorker((c.req.param("id") ?? ""));
    if (!w) return c.json({ error: "not found" }, 404);
    const { rows } = await db.query<{ n: string | number }>(
      `select count(*) as n from answers where worker_id = $1`, [w.id]);
    return c.json({
      worker: {
        id: w.id, name: w.name, tier: w.tier, skills: w.skills,
        accuracy: Number(w.gold_alpha) / (Number(w.gold_alpha) + Number(w.gold_beta)),
        answers: Number(rows[0]!.n),
      },
    });
  });

  // ---------- Admin ----------

  const requireAdmin = async (c: Context<Env>, next: Next) => {
    if (c.req.header("x-admin-token") !== adminToken) return c.json({ error: "forbidden" }, 403);
    await next();
  };

  app.post("/admin/orgs", requireAdmin, async (c) => {
    const body = z.object({ name: z.string().min(1) }).parse(await c.req.json());
    const { rows } = await db.query<{ id: string }>(
      `insert into orgs (name) values ($1) returning id`, [body.name]);
    const orgId = rows[0]!.id;
    const raw = "hr_live_" + randomBytes(24).toString("hex");
    await db.query(
      `insert into api_keys (org_id, key_hash, prefix) values ($1,$2,$3)`,
      [orgId, hashKey(raw), raw.slice(0, 16)],
    );
    return c.json({ org: { id: orgId, name: body.name }, api_key: raw }, 201);
  });

  app.post("/admin/workers", requireAdmin, async (c) => {
    const body = z.object({
      name: z.string().min(1),
      tier: z.enum(["basic", "complex", "expert"]),
      skills: z.array(z.string()).default([]),
    }).parse(await c.req.json());
    const { rows } = await db.query<{ id: string }>(
      `insert into workers (name, tier, skills) values ($1,$2,$3) returning id`,
      [body.name, body.tier, body.skills],
    );
    return c.json({ worker: { id: rows[0]!.id, ...body } }, 201);
  });

  app.post("/admin/gold", requireAdmin, async (c) => {
    const body = z.object({
      primitive: z.string().default("classify"),
      tier: z.enum(["basic", "complex", "expert"]),
      payload: z.record(z.string(), z.unknown()),
      rubric: z.string().optional(),
      expected: z.record(z.string(), z.unknown()),
    }).parse(await c.req.json());
    await db.query(
      `insert into gold_items (primitive, tier, payload, rubric, expected) values ($1,$2,$3,$4,$5)`,
      [body.primitive, body.tier, JSON.stringify(body.payload), body.rubric ?? null, JSON.stringify(body.expected)],
    );
    return c.json({ ok: true }, 201);
  });

  app.post("/admin/clips", requireAdmin, async (c) => {
    const body = z.object({
      center: z.string(), collector_code: z.string(), task_label: z.string(),
      taxonomy: z.array(z.string()).default([]), duration_s: z.number().int().positive(),
      resolution: z.string().default("4K"), fps: z.number().int().default(30),
      streams: z.array(z.string()).default(["video", "audio", "imu"]),
      consent_id: z.string(), pii_scrubbed: z.boolean().default(false),
      storage_url: z.string(), recorded_at: z.string(),
      status: z.string().optional(),
    }).parse(await c.req.json());
    const id = await capture.registerClip({
      center: body.center, collectorCode: body.collector_code, taskLabel: body.task_label,
      taxonomy: body.taxonomy, durationS: body.duration_s, resolution: body.resolution,
      fps: body.fps, streams: body.streams, consentId: body.consent_id,
      piiScrubbed: body.pii_scrubbed, storageUrl: body.storage_url, recordedAt: body.recorded_at,
    });
    if (body.status) await capture.setClipStatus(id, body.status);
    return c.json({ clip: { id } }, 201);
  });

  app.post("/admin/maintenance/expire-leases", requireAdmin, async (c) => {
    return c.json(await engine.expireLeases());
  });

  app.post("/admin/maintenance/dispatch-webhooks", requireAdmin, async (c) => {
    return c.json(await dispatcher.processDue());
  });

  // ---------- Worker bench ----------

  app.get("/console", (c) => {
    const html = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "console", "console.html"), "utf8");
    return c.html(html);
  });

  app.get("/", (c) =>
    c.json({
      service: "HumanRelay API",
      docs: "https://humanrelay.com",
      primitives: PRIMITIVES.map((p) => `POST /v1/${p}`),
      relay: "POST /v1/relay",
      teleop: "POST /v1/teleop/sessions",
    }),
  );

  return app;
}
