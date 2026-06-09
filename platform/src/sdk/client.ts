/**
 * HumanRelay TypeScript client — the `hr.judge(...)` from the website, real.
 *
 *   import { HumanRelay } from "humanrelay";
 *   const hr = new HumanRelay({ apiKey: "hr_live_..." });
 *   const result = await hr.judge({
 *     content: { a: responseA, b: responseB },
 *     rubric: "Which response is more helpful?",
 *     tier: "expert",
 *   });
 *   console.log(result.verdict, result.rationale);
 */

export type Tier = "basic" | "complex" | "expert";

export interface TaskRequest {
  question?: string;
  content?: unknown;
  rubric?: string;
  tier?: Tier;
  skill_tags?: string[];
  consensus?: number;
  webhook_url?: string;
  idempotency_key?: string;
}

export interface TaskResult {
  id: string;
  status: string;
  verdict: Record<string, unknown> | null;
  rationale: string | null;
  price_cents: number;
}

export interface RelayResult {
  id: string;
  status: string;
  strategy: string | null;
  verdict: Record<string, unknown> | null;
  rationale: string | null;
  total_cost_cents: number;
  binaries: { question: string; tier: Tier; status: string; from_cache: boolean }[];
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Polling interval while waiting for humans (ms). */
  pollIntervalMs?: number;
  /** Give up waiting after this long (ms). Default 5 minutes. */
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class HumanRelayError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class HumanRelay {
  private baseUrl: string;
  private pollMs: number;
  private timeoutMs: number;
  private fetchFn: typeof fetch;

  constructor(private opts: ClientOptions) {
    this.baseUrl = (opts.baseUrl ?? "https://api.humanrelay.com").replace(/\/$/, "");
    this.pollMs = opts.pollIntervalMs ?? 2000;
    this.timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  classify(req: TaskRequest) { return this.runPrimitive("classify", req); }
  judge(req: TaskRequest)    { return this.runPrimitive("judge", req); }
  extract(req: TaskRequest)  { return this.runPrimitive("extract", req); }
  escalate(req: TaskRequest) { return this.runPrimitive("escalate", req); }
  resolve(req: TaskRequest)  { return this.runPrimitive("resolve", req); }

  /** Fire-and-poll: creates the task and waits for the human verdict. */
  private async runPrimitive(primitive: string, req: TaskRequest): Promise<TaskResult> {
    const created = await this.call(`/v1/${primitive}`, "POST", req, req.idempotency_key);
    const id: string = created.task.id;
    const task = await this.waitUntil(
      () => this.getTask(id),
      (t) => t.status === "completed" || t.status === "failed",
    );
    if (task.status === "failed") throw new HumanRelayError(502, `task ${id} failed to resolve`);
    return task;
  }

  /** Create without waiting (use webhooks for the result). */
  async create(primitive: string, req: TaskRequest): Promise<{ id: string; status: string }> {
    const out = await this.call(`/v1/${primitive}`, "POST", req, req.idempotency_key);
    return { id: out.task.id, status: out.task.status };
  }

  async getTask(id: string): Promise<TaskResult> {
    const out = await this.call(`/v1/tasks/${id}`, "GET");
    return {
      id: out.task.id, status: out.task.status, verdict: out.task.result,
      rationale: out.task.rationale, price_cents: out.task.price_cents,
    };
  }

  /** Relay: decompose a complex question into human-answered binaries and wait for the verdict. */
  async relay(question: string, opts: { tier_cap?: Tier; max_cost_cents?: number } = {}): Promise<RelayResult> {
    const started = await this.call("/v1/relay", "POST", { question, ...opts });
    if (started.relay.status === "completed") return toRelayResult(started.relay);
    if (started.relay.status === "over_budget") {
      throw new HumanRelayError(402, `relay plan exceeds max_cost_cents`);
    }
    const done = await this.waitUntil(
      async () => (await this.call(`/v1/relay/${started.relay.id}`, "GET")).relay,
      (r) => ["completed", "failed", "over_budget"].includes(r.status),
    );
    if (done.status !== "completed") throw new HumanRelayError(502, `relay ${done.status}`);
    return toRelayResult(done);
  }

  async registerWebhook(url: string): Promise<{ id: string; secret: string }> {
    return this.call("/v1/webhooks", "POST", { url });
  }

  // ---- internals ----

  private async waitUntil<T>(get: () => Promise<T>, done: (t: T) => boolean): Promise<T> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const t = await get();
      if (done(t)) return t;
      if (Date.now() > deadline) throw new HumanRelayError(408, "timed out waiting for human resolution");
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async call(path: string, method: string, body?: unknown, idemKey?: string): Promise<any> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
        ...(idemKey ? { "idempotency-key": idemKey } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new HumanRelayError(res.status, (json as { error?: string }).error ?? `HTTP ${res.status}`);
    }
    return json;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRelayResult(r: any): RelayResult {
  return {
    id: r.id, status: r.status, strategy: r.strategy, verdict: r.verdict,
    rationale: r.rationale, total_cost_cents: r.total_cost_cents, binaries: r.binaries,
  };
}
