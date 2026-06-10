import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createPgliteDb, type DB } from "../src/db.js";
import { buildPlatform, type Platform } from "../src/server.js";
import { verifySignature, SIGNATURE_HEADER, WebhookDispatcher } from "../src/api/webhooks.js";

const ADMIN = "test-admin-token";

async function jsonReq(p: Platform, path: string, opts: {
  method?: string; body?: unknown; key?: string; admin?: boolean; headers?: Record<string, string>;
} = {}) {
  const res = await p.app.request(path, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}),
      ...(opts.admin ? { "x-admin-token": ADMIN } : {}),
      ...(opts.headers ?? {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("API end to end", () => {
  let db: DB;
  let p: Platform;
  let apiKey: string;
  let workerId: string;

  beforeEach(async () => {
    db = await createPgliteDb();
    p = await buildPlatform(db, { adminToken: ADMIN });
    const org = await jsonReq(p, "/admin/orgs", { body: { name: "Acme" }, admin: true });
    apiKey = org.body.api_key;
    const w = await jsonReq(p, "/admin/workers", {
      body: { name: "Asha", tier: "expert", skills: ["teleop", "teleop_safety", "video_labeling"] }, admin: true,
    });
    workerId = w.body.worker.id;
  });
  afterEach(async () => { await db.close(); });

  it("boots degraded (not dead) when a migration cannot apply", async () => {
    // Simulate prod: the runtime role can't run DDL on tables it doesn't own.
    const raw = await createPgliteDb();
    const flaky = {
      ...raw,
      exec: async (sql: string) => {
        if (sql.includes("add column if not exists content")) {
          throw new Error("must be owner of table relay_traces");
        }
        return raw.exec(sql);
      },
    };
    const degraded = await buildPlatform(flaky, { adminToken: ADMIN });
    expect(degraded.migrationError).toContain("must be owner");

    // Service is up: health reports the pending migration, normal endpoints work.
    const health = await jsonReq(degraded, "/health");
    expect(health.status).toBe(200);
    expect(health.body.migrations).toContain("pending");
    const org = await jsonReq(degraded, "/admin/orgs", { body: { name: "DegradedCo" }, admin: true });
    expect(org.status).toBe(201);
    await flaky.close();
  });

  it("rejects missing/invalid auth and wrong admin token", async () => {
    expect((await jsonReq(p, "/v1/judge", { body: {} })).status).toBe(401);
    expect((await jsonReq(p, "/v1/judge", { body: {}, key: "hr_live_nope" })).status).toBe(401);
    const res = await p.app.request("/admin/orgs", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": "wrong" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(403);
  });

  it("rotates API keys, with optional grace window for the old key", async () => {
    // Immediate rotation: new key works, old key dies on the spot.
    const rot = await jsonReq(p, "/v1/keys/rotate", { body: {}, key: apiKey });
    expect(rot.status).toBe(201);
    const second = rot.body.api_key;
    expect(second).toMatch(/^hr_live_/);
    expect(second).not.toBe(apiKey);
    expect((await jsonReq(p, "/v1/usage", { key: apiKey })).status).toBe(401);
    expect((await jsonReq(p, "/v1/usage", { key: second })).status).toBe(200);

    // Graceful rotation: both keys work during the window.
    const rot2 = await jsonReq(p, "/v1/keys/rotate", { body: { grace_minutes: 30 }, key: second });
    expect(rot2.status).toBe(201);
    const third = rot2.body.api_key;
    expect(new Date(rot2.body.old_key.revokes_at).getTime()).toBeGreaterThan(Date.now());
    expect((await jsonReq(p, "/v1/usage", { key: second })).status).toBe(200);
    expect((await jsonReq(p, "/v1/usage", { key: third })).status).toBe(200);

    // Rotating again with the grace-window key cannot extend its own life.
    const rot3 = await jsonReq(p, "/v1/keys/rotate", { body: { grace_minutes: 1440 }, key: second });
    expect(rot3.status).toBe(201);
    expect(new Date(rot3.body.old_key.revokes_at).getTime())
      .toBeLessThanOrEqual(new Date(rot2.body.old_key.revokes_at).getTime() + 1000);

    // Key inventory: full lineage visible, revoked keys marked inactive.
    const keys = await jsonReq(p, "/v1/keys", { key: third });
    expect(keys.status).toBe(200);
    expect(keys.body.keys.length).toBe(4);
    expect(keys.body.keys.filter((k: { active: boolean }) => k.active).length).toBe(3);
  });

  it("full task round trip with idempotency, webhook HMAC, and usage metering", async () => {
    // Register an org webhook.
    const hook = await jsonReq(p, "/v1/webhooks", { body: { url: "https://customer.example/hook" }, key: apiKey });
    expect(hook.status).toBe(201);
    const secret = hook.body.secret;

    // Create a judge task (idempotent).
    const create = await jsonReq(p, "/v1/judge", {
      body: { question: "Is response A more helpful than B?", tier: "expert", rubric: "Pick the more helpful." },
      key: apiKey, headers: { "idempotency-key": "req-1" },
    });
    expect(create.status).toBe(202);
    const dup = await jsonReq(p, "/v1/judge", {
      body: { question: "Is response A more helpful than B?", tier: "expert" },
      key: apiKey, headers: { "idempotency-key": "req-1" },
    });
    expect(dup.status).toBe(200);
    expect(dup.body.task.id).toBe(create.body.task.id);

    // Worker claims and answers through the bench endpoints.
    const claim = await jsonReq(p, "/worker/claim", { body: { worker_id: workerId } });
    expect(claim.body.task.id).toBe(create.body.task.id);
    const answer = await jsonReq(p, "/worker/answer", {
      body: { assignment_id: claim.body.assignment_id, verdict: { answer: "yes" }, rationale: "A cites sources" },
    });
    expect(answer.body.task.status).toBe("completed");

    // Task is visible to the org with its audit trail.
    const got = await jsonReq(p, `/v1/tasks/${create.body.task.id}`, { key: apiKey });
    expect(got.body.task.result).toEqual({ answer: "yes" });
    expect(got.body.events.map((e: { type: string }) => e.type)).toContain("completed");

    // Webhook delivered with a valid HMAC signature.
    const seen: { url: string; body: string; sig: string }[] = [];
    const dispatcher = new WebhookDispatcher(db, async (url, init) => {
      seen.push({ url, body: init.body, sig: init.headers[SIGNATURE_HEADER]! });
      return { ok: true, status: 200 };
    });
    const result = await dispatcher.processDue();
    expect(result.delivered).toBe(1);
    expect(seen[0]!.url).toBe("https://customer.example/hook");
    expect(verifySignature(seen[0]!.body, secret, seen[0]!.sig)).toBe(true);
    expect(JSON.parse(seen[0]!.body).task.id).toBe(create.body.task.id);

    // Usage metered at expert price.
    const usage = await jsonReq(p, "/v1/usage", { key: apiKey });
    expect(usage.body.usage[0]).toMatchObject({ primitive: "judge", tier: "expert" });
    expect(Number(usage.body.usage[0].amount_cents)).toBe(250);
  });

  it("escalate forces expert tier; org isolation on task reads", async () => {
    const t = await jsonReq(p, "/v1/escalate", {
      body: { question: "Ambiguous compliance case", tier: "basic" }, key: apiKey,
    });
    expect(t.body.task.tier).toBe("expert");

    const other = await jsonReq(p, "/admin/orgs", { body: { name: "Rival" }, admin: true });
    const denied = await jsonReq(p, `/v1/tasks/${t.body.task.id}`, { key: other.body.api_key });
    expect(denied.status).toBe(404);
  });

  it("relay endpoint runs end to end through the workforce", async () => {
    const start = await jsonReq(p, "/v1/relay", {
      body: { question: "Should I replace this boiler or repair it?" }, key: apiKey,
    });
    expect(start.status).toBe(202);
    const relayId = start.body.relay.id;
    expect(start.body.relay.binaries.length).toBe(3);

    // Workforce answers until done.
    for (let i = 0; i < 10; i++) {
      const claim = await jsonReq(p, "/worker/claim", { body: { worker_id: workerId } });
      if (claim.status === 204) break;
      await jsonReq(p, "/worker/answer", {
        body: { assignment_id: claim.body.assignment_id, verdict: { answer: "yes" }, rationale: "r" },
      });
    }

    const done = await jsonReq(p, `/v1/relay/${relayId}`, { key: apiKey });
    expect(done.body.relay.status).toBe("completed");
    expect(done.body.relay.total_cost_cents).toBe(550);
    expect(done.body.relay.binaries.every((b: { status: string }) => b.status === "resolved")).toBe(true);
  });

  it("failed webhook deliveries back off and eventually fail", async () => {
    await jsonReq(p, "/v1/webhooks", { body: { url: "https://down.example/hook" }, key: apiKey });
    const t = await jsonReq(p, "/v1/classify", { body: { question: "spam?" }, key: apiKey });
    const claim = await jsonReq(p, "/worker/claim", { body: { worker_id: workerId } });
    await jsonReq(p, "/worker/answer", { body: { assignment_id: claim.body.assignment_id, verdict: { answer: "no" } } });
    expect(t.status).toBe(202);

    const failingDispatcher = new WebhookDispatcher(db, async () => ({ ok: false, status: 500 }));
    let now = new Date();
    for (let attempt = 1; attempt <= 5; attempt++) {
      const r = await failingDispatcher.processDue(now);
      if (attempt < 5) {
        expect(r.retried).toBe(1);
        now = new Date(now.getTime() + Math.pow(2, attempt + 1) * 30_000 + 1000);
      } else {
        expect(r.failed).toBe(1);
      }
    }
    const { rows } = await db.query<{ status: string; attempts: number }>(
      `select status, attempts from webhook_deliveries`);
    expect(rows[0]!.status).toBe("failed");
    expect(Number(rows[0]!.attempts)).toBe(5);
  });

  it("datasets: only QC-passed, PII-scrubbed clips enter the manifest with provenance", async () => {
    const mk = (over: Record<string, unknown>) => jsonReq(p, "/admin/clips", {
      admin: true,
      body: {
        center: "Yemmiganur-1", collector_code: "C042", task_label: "folding_laundry",
        taxonomy: ["home", "manipulation"], duration_s: 1800, consent_id: "consent-9",
        storage_url: "r2://clips/a.mp4", recorded_at: "2026-06-01T10:00:00Z",
        pii_scrubbed: true, status: "qc_passed", ...over,
      },
    });
    await mk({});
    await mk({ storage_url: "r2://clips/b.mp4", duration_s: 3600 });
    await mk({ storage_url: "r2://clips/raw.mp4", pii_scrubbed: false });          // excluded: PII not scrubbed
    await mk({ storage_url: "r2://clips/short.mp4", status: "ingested" });         // excluded: not QC passed

    const ds = await jsonReq(p, "/v1/datasets", {
      body: { name: "Home manipulation v1", filter: { taxonomy: ["manipulation"] } }, key: apiKey,
    });
    expect(ds.status).toBe(201);
    expect(ds.body.dataset.clip_count).toBe(2);
    expect(Number(ds.body.dataset.total_hours)).toBeCloseTo(1.5);
    const manifest = ds.body.dataset.manifest;
    expect(manifest.clips[0].provenance.consent_id).toBe("consent-9");
    expect(manifest.clips.every((c: { provenance: { pii_scrubbed: boolean } }) => c.provenance.pii_scrubbed)).toBe(true);
  });
});
