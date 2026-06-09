import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createPgliteDb, type DB } from "../src/db.js";
import { buildPlatform, type Platform } from "../src/server.js";

const ADMIN = "test-admin-token";

async function jsonReq(p: Platform, path: string, opts: {
  method?: string; body?: unknown; key?: string; admin?: boolean;
} = {}) {
  const res = await p.app.request(path, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}),
      ...(opts.admin ? { "x-admin-token": ADMIN } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("teleop: safety gate and the flywheel", () => {
  let db: DB;
  let p: Platform;
  let apiKey: string;
  let safetyWorker: string;
  let operator: string;

  beforeEach(async () => {
    db = await createPgliteDb();
    p = await buildPlatform(db, { adminToken: ADMIN });
    apiKey = (await jsonReq(p, "/admin/orgs", { body: { name: "FleetCo" }, admin: true })).body.api_key;
    safetyWorker = (await jsonReq(p, "/admin/workers", {
      body: { name: "SafetyDesk", tier: "basic", skills: ["teleop_safety"] }, admin: true,
    })).body.worker.id;
    operator = (await jsonReq(p, "/admin/workers", {
      body: { name: "OperatorOne", tier: "expert", skills: ["teleop", "teleop_safety", "video_labeling"] }, admin: true,
    })).body.worker.id;
  });
  afterEach(async () => { await db.close(); });

  async function answerNext(workerId: string, answer: string) {
    const claim = await jsonReq(p, "/worker/claim", { body: { worker_id: workerId } });
    expect(claim.status).toBe(200);
    await jsonReq(p, "/worker/answer", {
      body: { assignment_id: claim.body.assignment_id, verdict: { answer }, rationale: "checked" },
    });
    return claim.body.task;
  }

  it("approved safety binary activates the session; handback creates the demonstration task", async () => {
    const req = await jsonReq(p, "/v1/teleop/sessions", {
      body: {
        robot_id: "unit-7",
        context: { situation: "gripper jammed on mug" },
        control_scope: { joints: ["arm_l"], max_velocity: 0.2, duration_s: 120 },
      },
      key: apiKey,
    });
    expect(req.status).toBe(202);
    const sessionId = req.body.session.id;
    expect(req.body.session.status).toBe("safety_check");

    // The safety gate is a real $0.50 binary in the queue.
    const safetyTask = await answerNext(safetyWorker, "yes");
    expect(safetyTask.primitive).toBe("safety_confirm");

    let s = await jsonReq(p, `/v1/teleop/sessions/${sessionId}`, { key: apiKey });
    expect(s.body.session.status).toBe("active");
    expect(s.body.session.operator_assigned).toBe(true);

    // Operator finishes; the recording becomes an annotation task — the flywheel.
    const hb = await jsonReq(p, `/v1/teleop/sessions/${sessionId}/handback`, {
      body: { recording_url: "https://r2.example/recordings/unit-7.mp4" }, key: apiKey,
    });
    expect(hb.body.session.status).toBe("completed");
    const demoTaskId = hb.body.session.demonstration_task_id;
    expect(demoTaskId).toBeTruthy();

    const demo = await jsonReq(p, `/v1/tasks/${demoTaskId}`, { key: apiKey });
    expect(demo.body.task.primitive).toBe("annotate");
    expect(demo.body.task.payload.recording_url).toBe("https://r2.example/recordings/unit-7.mp4");
    expect(demo.body.task.price_cents).toBe(0); // included in intervention pricing

    // And the demonstration task is real, claimable work.
    const annotated = await answerNext(operator, "yes");
    expect(annotated.id).toBe(demoTaskId);
  });

  it("denied safety binary kills the session and blocks handback", async () => {
    const req = await jsonReq(p, "/v1/teleop/sessions", {
      body: { robot_id: "unit-9", context: { situation: "human in workspace" } }, key: apiKey,
    });
    const sessionId = req.body.session.id;
    await answerNext(safetyWorker, "no");

    const s = await jsonReq(p, `/v1/teleop/sessions/${sessionId}`, { key: apiKey });
    expect(s.body.session.status).toBe("denied");

    const hb = await jsonReq(p, `/v1/teleop/sessions/${sessionId}/handback`, { body: {}, key: apiKey });
    expect(hb.status).toBe(409);
  });
});
