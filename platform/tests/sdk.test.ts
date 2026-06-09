import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createPgliteDb, type DB } from "../src/db.js";
import { buildPlatform, type Platform } from "../src/server.js";
import { HumanRelay, HumanRelayError } from "../src/sdk/client.js";

const ADMIN = "test-admin-token";

describe("TypeScript SDK + hardening", () => {
  let db: DB;
  let p: Platform;
  let apiKey: string;
  let workerId: string;
  let hr: HumanRelay;

  /** Background workforce that answers everything until the queue drains. */
  async function workforce(answer = "yes", maxRounds = 30) {
    for (let i = 0; i < maxRounds; i++) {
      const claim = await p.engine.claimNext(workerId);
      if (!claim) { await new Promise((r) => setTimeout(r, 30)); continue; }
      await p.engine.submitAnswer(claim.assignment_id, { answer }, "sdk-test rationale");
    }
  }

  beforeEach(async () => {
    db = await createPgliteDb();
    p = await buildPlatform(db, { adminToken: ADMIN });
    const orgRes = await p.app.request("/admin/orgs", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": ADMIN },
      body: JSON.stringify({ name: "SdkCo" }),
    });
    apiKey = (await orgRes.json() as { api_key: string }).api_key;
    const wRes = await p.app.request("/admin/workers", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": ADMIN },
      body: JSON.stringify({ name: "W", tier: "expert", skills: [] }),
    });
    workerId = ((await wRes.json()) as { worker: { id: string } }).worker.id;

    // SDK talks to the in-memory app via its fetch.
    hr = new HumanRelay({
      apiKey,
      baseUrl: "http://hr.test",
      pollIntervalMs: 25,
      timeoutMs: 15000,
      fetchFn: ((url: string, init?: RequestInit) =>
        p.app.request(String(url).replace("http://hr.test", ""), init)) as typeof fetch,
    });
  });
  afterEach(async () => { await db.close(); });

  it("hr.judge(...) matches the website code sample: returns verdict + rationale", async () => {
    const work = workforce("yes", 10);
    const result = await hr.judge({
      content: { a: "Response A", b: "Response B" },
      rubric: "Which response is more helpful?",
      tier: "expert",
    });
    await work;
    expect(result.status).toBe("completed");
    expect(result.verdict).toEqual({ answer: "yes" });
    expect(result.rationale).toBe("sdk-test rationale");
    expect(result.price_cents).toBe(250);
  });

  it("hr.relay(...) resolves a complex question end to end", async () => {
    const work = workforce("yes", 40);
    const result = await hr.relay("Should I replace this boiler or repair it?");
    await work;
    expect(result.status).toBe("completed");
    expect(result.total_cost_cents).toBe(550);
    expect(result.binaries).toHaveLength(3);
  });

  it("surfaces budget refusal as a typed error", async () => {
    await expect(
      hr.relay("Should I replace this boiler or repair it?", { max_cost_cents: 10 }),
    ).rejects.toThrowError(HumanRelayError);
  });

  it("expert-tier answers without rationale are rejected (422)", async () => {
    await hr.create("judge", { question: "expert call?", tier: "expert" });
    const claim = await p.engine.claimNext(workerId);
    await expect(p.engine.submitAnswer(claim!.assignment_id, { answer: "yes" }))
      .rejects.toMatchObject({ status: 422 });
    // With a rationale it goes through.
    const done = await p.engine.submitAnswer(claim!.assignment_id, { answer: "yes" }, "because");
    expect(done.status).toBe("completed");
  });

  it("per-key rate limit returns 429 past the window", async () => {
    await db.query(`update api_keys set rate_limit_per_min = 3`);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await p.app.request("/v1/usage", {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      codes.push(res.status);
    }
    expect(codes.filter((c) => c === 200)).toHaveLength(3);
    expect(codes.filter((c) => c === 429)).toHaveLength(2);
  });
});
