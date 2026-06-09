import { z } from "zod";
import type { Tier } from "../core/pricing.js";

/**
 * Relay's three LLM steps. `RealLlm` calls the Anthropic API with structured
 * outputs; `MockLlm` is deterministic and used by the test suite and
 * RELAY_MODE=mock deployments. Models per ARCHITECTURE.md:
 *   triage      -> claude-haiku-4-5   (cheap, latency-sensitive)
 *   decompose   -> claude-opus-4-8    (quality gates everything downstream)
 *   reassemble  -> claude-sonnet-4-6
 */

export const BinarySchema = z.object({
  id: z.string(),
  question: z.string(),
  tier: z.enum(["basic", "complex", "expert"]),
  depends_on: z.array(z.string()).default([]),
  skill_tags: z.array(z.string()).default([]),
});

export const PlanSchema = z.object({
  strategy: z.enum(["direct", "decompose"]),
  tier: z.enum(["basic", "complex", "expert"]).optional(), // for direct
  binaries: z.array(BinarySchema).default([]),
});
export type Plan = z.infer<typeof PlanSchema>;

export const ReassemblySchema = z.object({
  verdict: z.record(z.string(), z.unknown()),
  rationale: z.string(),
});
export type Reassembly = z.infer<typeof ReassemblySchema>;

export interface RelayLlm {
  plan(question: string, tierCap: Tier): Promise<Plan>;
  reassemble(
    question: string,
    binaries: { question: string; verdict: Record<string, unknown>; rationale: string | null }[],
  ): Promise<Reassembly>;
}

/** Deterministic mock: short clear yes/no questions go direct; everything else decomposes into a 2-wave tree. */
export class MockLlm implements RelayLlm {
  async plan(question: string, tierCap: Tier): Promise<Plan> {
    const q = question.trim();
    const isBinaryShaped = /^(is|are|does|do|can|should|was|were|has|have)\b/i.test(q) && q.length <= 80 && !/\bor\b/i.test(q);
    if (isBinaryShaped) {
      return { strategy: "direct", tier: "basic", binaries: [] };
    }
    const expert: Tier = tierCap === "basic" ? "basic" : "expert";
    return {
      strategy: "decompose",
      binaries: [
        { id: "b1", question: `Is this a routine case? Context: ${q}`, tier: "basic", depends_on: [], skill_tags: [] },
        { id: "b2", question: `Does close inspection favor the primary option? Context: ${q}`, tier: expert, depends_on: [], skill_tags: [] },
        { id: "b3", question: `Given prior findings, is the primary option the right call? Context: ${q}`, tier: expert, depends_on: ["b1", "b2"], skill_tags: [] },
      ],
    };
  }

  async reassemble(
    question: string,
    binaries: { question: string; verdict: Record<string, unknown>; rationale: string | null }[],
  ): Promise<Reassembly> {
    const final = binaries[binaries.length - 1];
    const yes = binaries.filter((b) => String(b.verdict["answer"]).toLowerCase() === "yes").length;
    return {
      verdict: { answer: final ? final.verdict["answer"] : "unknown", confidence: yes / Math.max(1, binaries.length) },
      rationale: `Composed from ${binaries.length} human-resolved binaries (${yes} affirmative).`,
    };
  }
}

/** Production implementation against the Anthropic API. */
export class RealLlm implements RelayLlm {
  private client: import("@anthropic-ai/sdk").default | null = null;

  private async getClient() {
    if (!this.client) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      this.client = new Anthropic();
    }
    return this.client;
  }

  async plan(question: string, tierCap: Tier): Promise<Plan> {
    const client = await this.getClient();
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: [
        {
          type: "text",
          text: PLANNER_SYSTEM,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: `Tier cap: ${tierCap}\nQuestion: ${question}`,
        },
      ],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              strategy: { type: "string", enum: ["direct", "decompose"] },
              tier: { type: "string", enum: ["basic", "complex", "expert"] },
              binaries: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    id: { type: "string" },
                    question: { type: "string" },
                    tier: { type: "string", enum: ["basic", "complex", "expert"] },
                    depends_on: { type: "array", items: { type: "string" } },
                    skill_tags: { type: "array", items: { type: "string" } },
                  },
                  required: ["id", "question", "tier", "depends_on", "skill_tags"],
                },
              },
            },
            required: ["strategy", "binaries"],
          },
        },
      },
    } as never);
    return PlanSchema.parse(extractJson(response));
  }

  async reassemble(
    question: string,
    binaries: { question: string; verdict: Record<string, unknown>; rationale: string | null }[],
  ): Promise<Reassembly> {
    const client = await this.getClient();
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: [{ type: "text", text: REASSEMBLER_SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: JSON.stringify({ question, resolved_binaries: binaries }),
        },
      ],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              verdict: { type: "object", additionalProperties: false, properties: { answer: { type: "string" } }, required: ["answer"] },
              rationale: { type: "string" },
            },
            required: ["verdict", "rationale"],
          },
        },
      },
    } as never);
    return ReassemblySchema.parse(extractJson(response));
  }
}

function extractJson(response: { content: { type: string; text?: string }[] }): unknown {
  const block = response.content.find((b) => b.type === "text");
  if (!block?.text) throw new Error("no text block in model response");
  return JSON.parse(block.text);
}

const PLANNER_SYSTEM = `You are Relay, the intelligence layer of HumanRelay — a human-in-the-loop API.
You receive a question an AI agent could not answer on its own. Your job is to find the SMALLEST set of
binary (yes/no) questions that trained human workers can answer to resolve it.

Rules:
- If the question is already a single clear binary, return strategy "direct" with the right tier.
- Otherwise return strategy "decompose" with 2-5 binaries. Each binary must be answerable yes/no by a
  human without seeing the other answers, unless it lists depends_on.
- Independent binaries run in parallel; keep dependency chains short.
- Tiers: basic ($0.50) clear-cut pattern checks; complex ($1.00) reasoning; expert ($2.50) domain
  expertise (medical/legal/trade). Never exceed the tier cap. Cost matters: do not use expert where
  basic suffices.
- skill_tags route to specialists, e.g. ["plumbing"], ["medical"]. Use sparingly.`;

const REASSEMBLER_SYSTEM = `You are Relay's reassembler. Given the original question and the
human-resolved binary answers (with rationales), compose the final verdict. The verdict object must
contain an "answer" field with a short direct answer. The rationale must cite the binary findings.
Never contradict the human answers; if they conflict, weigh dependent/later binaries higher and say so.`;
