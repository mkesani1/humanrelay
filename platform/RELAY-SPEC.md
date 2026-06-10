# Relay — Specification v1

Relay is the intelligence layer between a customer's agent and the HumanRelay workforce.
Its contract: take any question an agent can't answer, find the **smallest set of human-answerable
binary decisions** that resolves it, and return a verdict with a full audit trace.
The smallest set is very often **one**: a robot sends a camera frame and asks "is this
safe to drive through?" — that's `strategy=direct`, one human, one look, one price.
Decomposition is reserved for genuinely multi-part questions.

**Attached content:** `POST /v1/relay` accepts an optional `content` value (an image
URL, a document, sensor context). It is stored on the trace and rides into **every**
binary task payload so workers see it alongside the question. Content-bearing traces
**bypass the answer cache entirely** (lookup and record): the question text alone no
longer identifies the case — same text + different frame must never share answers.
Decomposition *structure* still transfers, so the pattern library stays active.

This spec covers the production behavior implemented in `src/relay/`; the V0→V2 ladder
matches the public roadmap on humanrelay.com.

---

## 1. The protocol

```
agent question
   │
   ▼
[0] WHOLE-QUESTION CACHE ──hit──▶ verdict (cost $0, strategy=cache)
   │ miss
   ▼
[1] PATTERN LIBRARY ──match──▶ reuse stored decomposition template (no LLM call, strategy=pattern)
   │ miss
   ▼
[2] NEGOTIATE (LLM plan)
   ├─ strategy=clarify  ──▶ status needs_clarification ──agent answers──▶ re-plan (once)
   ├─ strategy=direct   ──▶ one binary at the planned tier
   └─ strategy=decompose──▶ 2..8 binaries with dependencies
   ▼
[3] VALIDATE PLAN (ids unique, deps exist, acyclic, size cap, budget cap)
   │ invalid → failed / over_budget (no human engaged, no spend)
   ▼
[4] EXECUTE WAVES
   per binary: per-binary cache hit? → free resolve (+ sampled human audit)
               else → human task (tier-priced); dependent binaries see prior verdicts
   ▼
[5] REASSEMBLE (LLM) → verdict + rationale citing binary findings
   ▼
[6] LEARN: record binaries + whole question in cache; store decomposition as pattern template
   ▼
[7] NOTIFY: relay.completed / relay.failed webhook to the org
```

## 2. States

`planning → needs_clarification → running → reassembling → completed | failed | over_budget`

- `needs_clarification`: Relay asked the agent one question back (`clarification_question`).
  The agent answers via `POST /v1/relay/:id/clarify`. One round-trip only (V0 promise);
  a second clarify attempt fails the trace.
- `over_budget`: the validated plan exceeded `max_cost_cents`. Decided **before** any
  human is engaged; costs nothing.
- `failed`: a binary exhausted attempts, or the plan was structurally invalid.

## 3. Model assignments (per ARCHITECTURE.md)

| Step | Model | Notes |
|---|---|---|
| plan (negotiate/decompose) | `claude-opus-4-8`, adaptive thinking, structured outputs | quality gates everything; tokens are cents, a wasted expert binary is $2.50 |
| reassemble | `claude-sonnet-4-6`, structured outputs | mechanical composition |
| (mock mode) | deterministic heuristics | tests, dev, `RELAY_MODE=mock` |

## 4. Learning systems

### 4.1 Binary cache (V1 — live)
- Key: normalized question (lowercase, alphanumeric) → exact hash, plus trigram-embedding
  similarity ≥ 0.97 over recent consensus entries.
- Serve threshold: **3 consecutive agreeing human resolutions**. A conflicting resolution
  resets consensus to 1.
- **Content-bearing traces never touch the cache** — neither lookup nor record. The
  text is not the case when a frame/document is attached.
- Economics: a cache hit converts a $0.50–$2.50 human call into a free lookup, still billed
  as resolved work.

### 4.2 Cache auditing (trust maintenance)
Every **10th use** of a cached answer also dispatches a real (unbilled) human task with the
same question. Match → consensus grows. Mismatch → cache entry resets (consensus 1,
`audit_mismatches` incremented) and humans resume answering that binary. The cache can
never silently drift from human ground truth.

### 4.3 Pattern library (V1 — live)
Successful decompositions are stored as **templates**: binary questions with the original
question text replaced by `{{question}}`. A new question with embedding similarity ≥ 0.88
to a stored pattern reuses its structure with zero LLM calls (`strategy=pattern`).
Humans still answer the binaries — patterns save planning latency/cost, not judgment.

### 4.4 V2 (specified, not yet enabled)
Auto-resolution beyond cached binaries: Relay answers high-confidence binaries itself when
(a) cached consensus ≥ 99% over a large sample, (b) audit mismatch rate < 1%, and
(c) the customer opted in. Always with audit trail + ongoing sampled verification.
Gate constant exists (`AUTO_RESOLVE_ENABLED=false`); flipping it is a product decision.

## 5. Plan validation invariants

Rejected before execution (trace → failed, rationale states why):
- 0 or > 8 binaries
- duplicate binary ids
- `depends_on` referencing unknown ids
- dependency cycles (Kahn topological check)
- planned cost > `max_cost_cents` (→ over_budget)
- tiers above `tier_cap` are silently downgraded to the cap

## 6. Observability & integration

- Every binary is a normal task: full `task_events` audit trail, gold-set QA, lease recovery.
- The trace stores the full plan state (per-binary verdicts, cache provenance, cost).
- Org webhooks receive `relay.completed` / `relay.failed` with the public trace.
- `GET /v1/relay/:id` exposes per-binary status (`waiting | in_progress | resolved`),
  `from_cache` flags, cache hit counts, and total cost.

## 7. Metrics that define Relay's evolution

| Metric | V0 target | V1 signal | V2 gate |
|---|---|---|---|
| cache hit rate (binaries) | — | ≥ 20% by 10K questions | ≥ 60% on auto-resolve candidates |
| audit mismatch rate | — | < 2% | < 1% sustained |
| pattern reuse rate | — | ≥ 25% of decomposed questions | — |
| median plan size | ≤ 4 binaries | shrinking per category | — |
| cost per resolved question | baseline | declining | step-change on auto-resolve |
