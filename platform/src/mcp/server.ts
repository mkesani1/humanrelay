#!/usr/bin/env node
/**
 * @humanrelay/mcp — MCP server exposing the HumanRelay HITL API as tools.
 *
 * Agents wire this into their MCP config:
 *   { "mcpServers": { "humanrelay": {
 *       "command": "npx", "args": ["-y", "tsx", "platform/src/mcp/server.ts"],
 *       "env": { "HUMANRELAY_API_KEY": "hr_live_...", "HUMANRELAY_BASE_URL": "http://localhost:8787" } } } }
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = process.env.HUMANRELAY_BASE_URL ?? "https://api.humanrelay.com";
const API_KEY = process.env.HUMANRELAY_API_KEY ?? "";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(path: string, body?: unknown, method?: string): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: method ?? (body !== undefined ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HumanRelay API ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

function asText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

const tierSchema = z.enum(["basic", "complex", "expert"]).default("basic")
  .describe("basic $0.50 (clear-cut), complex $1.00 (reasoning), expert $2.50 (credentialed specialist)");

const server = new McpServer({ name: "humanrelay", version: "0.1.0" });

const primitives = [
  ["classify", "Ask a trained human to classify content (binary or multi-class). Use when your confidence is low and a wrong label has consequences."],
  ["judge", "Ask a human for a judgment call: pairwise comparison, preference ranking, or rubric evaluation."],
  ["extract", "Ask a human to extract structured data from a document, image, or text you cannot parse reliably."],
  ["escalate", "Route a high-risk or ambiguous case to a credentialed domain specialist (always expert tier, $2.50)."],
  ["resolve", "Hand a human an end-to-end micro-task to resolve, with rationale and audit trail."],
] as const;

for (const [name, description] of primitives) {
  server.tool(
    `humanrelay_${name}`,
    description,
    {
      question: z.string().describe("The question for the human. For yes/no answers, phrase as a binary."),
      content: z.unknown().optional().describe("Supporting content (document text, options to compare, etc.)"),
      rubric: z.string().optional().describe("How the human should decide"),
      tier: tierSchema,
    },
    async ({ question, content, rubric, tier }) => {
      const out = await api(`/v1/${name}`, { question, content, rubric, tier });
      return asText({
        task_id: out.task.id,
        status: out.task.status,
        price_cents: out.task.price_cents,
        note: "Poll humanrelay_get_task until status=completed; typical resolution is under a minute.",
      });
    },
  );
}

server.tool(
  "humanrelay_relay",
  "Resolve a complex question via Relay: it decomposes the question into priced human-answered binaries, runs them in parallel, and reassembles the answer. Use for questions too complex for a single yes/no.",
  {
    question: z.string().describe("The complex question to resolve"),
    tier_cap: z.enum(["basic", "complex", "expert"]).default("expert"),
    max_cost_cents: z.number().int().positive().optional().describe("Refuse plans costing more than this"),
  },
  async ({ question, tier_cap, max_cost_cents }) => {
    const out = await api("/v1/relay", { question, tier_cap, max_cost_cents });
    return asText({
      relay_id: out.relay.id,
      status: out.relay.status,
      strategy: out.relay.strategy,
      binaries: out.relay.binaries,
      verdict: out.relay.verdict,
      note: out.relay.status === "completed" ? "Resolved." : "Poll humanrelay_get_relay until status=completed.",
    });
  },
);

server.tool(
  "humanrelay_get_task",
  "Fetch a task's status, verdict, rationale, and audit trail.",
  { task_id: z.string() },
  async ({ task_id }) => asText(await api(`/v1/tasks/${task_id}`)),
);

server.tool(
  "humanrelay_get_relay",
  "Fetch a Relay trace: per-binary progress, verdict, rationale, and total cost.",
  { relay_id: z.string() },
  async ({ relay_id }) => asText(await api(`/v1/relay/${relay_id}`)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
