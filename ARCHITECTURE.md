# HumanRelay — Platform & Relay Tech Stack Plan

**Scope:** the systems needed to ship the four products (Capture, Annotate, Judge, Operate) and the Relay intelligence layer.
**Bias:** buy or lean on managed services for commodity infrastructure; build only what's differentiating — routing, Relay, the worker quality system, and the intervention→data flywheel.
**Date:** June 2026

---

## 0. Guiding constraints

1. **Human cost dominates LLM cost.** A $5.50 resolved question costs ~$0.02 in model tokens. Never economize on Relay's decomposition model — a bad decomposition wastes $2.50 expert calls and 47 seconds of customer patience.
2. **HITL workflows are long-running and failure-prone.** A "task" can wait minutes for a human, time out, escalate, need consensus. The orchestration layer must make retries, timers, and SLAs first-class — not bolted onto a job queue.
3. **Video scale is brutal.** Hundreds of hours/day of 4K ≈ 2–4 TB/day raw, ~100 TB/month and growing. Egress fees decide the storage vendor, because the product *is* shipping these bytes to customers.
4. **Audit trail is the product.** Expert-tier pricing is justified by individual accountability. Every task, assignment, answer, and intervention is an append-only event.

---

## 1. Core platform (Judge API + console) — build first

This is the spine everything else plugs into.

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript end-to-end (Python for ML/video tooling) | One language across API, console, MCP server; hiring; Vercel-native |
| Public API | Dedicated Node service (Hono or Fastify) deployed on Fly.io/Railway; `api.humanrelay.ai` | Long-lived connections (SSE task streams, webhooks) and latency control don't fit serverless function limits |
| Dashboards | Next.js on Vercel (customer console + worker console + admin) | Already your deployment platform; preview deploys per PR |
| Database | Supabase Postgres (managed) | Postgres for everything: tasks, events, billing meters. Auth + Realtime + RLS included; you already have the Supabase integration |
| Queue/orchestration | **Phase 1:** Graphile Worker (Postgres-backed jobs). **Phase 2+:** Temporal for task lifecycle workflows | Start with zero extra infra. Move the task state machine to Temporal when escalation chains, SLA timers, and consensus rounds outgrow queue semantics — HITL is exactly what Temporal models well |
| Worker task push | Supabase Realtime (Postgres CDC → websocket) | Sub-second task delivery to the worker console without building a push layer |
| Billing | Stripe usage-based metering | Per-call ($0.50/$1.00/$2.50), per-intervention, per-data-hour all map to metered prices |
| Auth | Supabase Auth for humans; hashed API keys (`hr_live_...`) with per-key scopes + rate limits for machines | |
| Webhooks out | HMAC-signed, retried with backoff, idempotency keys on both directions | Agents poll or subscribe; never lose a verdict |
| Observability | Sentry (errors) + Axiom or Grafana Cloud (logs/metrics/traces), OpenTelemetry from day one | Per-task trace = customer-facing audit trail and internal debugging from the same events |

**Core schema (Postgres):**
`orgs`, `api_keys`, `tasks` (one row per binary), `task_events` (append-only: created → decomposed → routed → assigned → answered → QA'd → returned), `workers` (skills, tier, calibration scores), `assignments` (lease + heartbeat, reassign on timeout), `answers`, `gold_items` (calibration), `webhooks`, `usage_meters`.

**Worker console essentials:** keyboard-first binary answering, injected gold-set items (workers can't distinguish them), dual-pass sampling, per-worker Bayesian accuracy score that feeds routing. This quality engine — not the UI — is the moat; it's what lets you print "99%+" honestly.

**MCP server:** `@humanrelay/mcp` npm package exposing the five primitives as tools over the REST API. Thin client, versioned with the API. This is cheap to build and is the integration story on the website.

---

## 2. Relay — the intelligence layer

Relay negotiates, decomposes, routes, and reassembles. It's an LLM workflow (code-orchestrated, not an autonomous agent): every step has a defined input/output, so use direct Claude API calls with structured outputs — no agent framework needed.

### Model tiering (Anthropic API, June 2026 pricing)

| Step | Model | Why | Cost/1M tok (in/out) |
|---|---|---|---|
| Triage ("already a binary? which tier? which skill?") | `claude-haiku-4-5` | High volume, low complexity, latency-sensitive | $1 / $5 |
| Decomposition (question → minimal binary tree) | `claude-opus-4-8`, adaptive thinking (`thinking: {type: "adaptive"}`, `effort: "high"`) | Quality here gates everything downstream; per-question token cost is cents while a wasted expert binary is $2.50 | $5 / $25 |
| Reassembly (binary answers → verdict + rationale) | `claude-sonnet-4-6` (Opus for expert-tier rationale) | Mechanical composition with good prose | $3 / $15 |
| Offline jobs (gold-set scoring, eval, dataset QC) | Batch API on Sonnet/Haiku | 50% discount, no latency requirement | half price |

### Non-negotiable implementation details

- **Structured outputs** (`output_config: {format: {type: "json_schema", ...}}`) for the decomposition plan: `{binaries: [{question, tier, depends_on, skill_tags}], strategy}`. Guaranteed parseable — no regex on prose.
- **Prompt caching:** frozen system prompt + decomposition pattern library as the cached prefix (`cache_control: {type: "ephemeral"}`); the customer's question goes after the breakpoint. Cache reads are ~10% of input price; at scale this is most of Relay's token bill.
- **Full trace persistence:** every (question → plan → binary answers → verdict → customer feedback) tuple lands in Postgres. This corpus *is* the V1/V2 roadmap.

### Relay V0 → V2, mapped to systems

| Stage | What ships | Tech |
|---|---|---|
| **V0 — Smart Router** (launch) | Template-guided decomposition, fixed routing, one clarification round-trip | Haiku triage + Opus decomposition + pattern library in the prompt |
| **V1 — Pattern Learner** (~10K questions) | Repeat binaries auto-resolved from cache; confidence-based routing to best workers | `pgvector` embeddings over historical binaries; similarity match + unanimity check → cached answer in <500ms; worker quality scores drive assignment |
| **V2 — Autonomous Engine** (scale) | Relay answers high-confidence binaries itself; humans get only the novel ones | Distilled/fine-tuned decomposition model trained on the trace corpus; auto-resolution gated at 99%+ historical consensus, always with audit trail + sampled human verification |

The binary answer cache (V1) is the highest-leverage build after launch: every cache hit converts a $0.50–$2.50 human call into a free lookup while still billing as resolved.

---

## 3. Capture — video ingestion at TB/day

| Layer | Choice | Why |
|---|---|---|
| Object storage | **Cloudflare R2** | Zero egress fees. You will ship 100+ TB/month to labs; S3 egress (~$0.09/GB) would cost more than storage itself. Keep an S3-compatible interface so a swap stays possible |
| Upload path | Capture center ingest stations (NVMe buffer) → resumable multipart upload (tus or R2 multipart) on dedicated uplinks | 4K files are tens of GB; uploads must survive network interruptions |
| Processing | Queue-driven pipeline on Modal (or AWS Batch): ffmpeg proxies/thumbnails, clip segmentation, IMU/audio sync validation, **PII scrubbing** (face/plate blur via open detection models), metadata extraction | GPU on demand, scale-to-zero between batches |
| Catalog | Postgres: clips, tasks taxonomy, device/rig, collector (pseudonymized), consent record, QC status. `pgvector` embeddings (frame + caption) for semantic search ("pouring liquid into container") | Searchable catalog is what turns raw hours into a sellable dataset |
| Provenance | Per-clip provenance manifest (capture device, time, location class, consent ID, processing chain) — C2PA-style, exportable with the dataset | "Data you can put in the model card" must be literal |
| Delivery | Dataset manifests (WebDataset / Parquet index + signed R2 URLs), versioned releases, per-customer entitlements | Labs want `wget`-able shards, not a portal |

---

## 4. Annotate — don't build a labeler

- **Tooling:** self-hosted **CVAT** (video-native, open source) as the default bench tool; keep whatever IndiVillage already runs for existing service lines. The differentiation is not the labeling UI.
- **Build the QA layer** on the shared Postgres: gold sets, dual-pass agreement, inter-annotator metrics, per-project accuracy dashboards (customer-visible — turn the 99% claim into a live number).
- **LLM-assisted pre-labeling:** Claude (vision) drafts labels/segments, humans correct — typically 2–4× throughput on dense video tasks. Run via the Batch API at half price.
- Robotics-specific stacks (3D pose, hand tracking) as needed per contract: evaluate Aria-style toolchains/per-modality OSS before writing anything custom.

---

## 5. Operate — teleop with a safety gate

| Layer | Choice | Why |
|---|---|---|
| Transport | **LiveKit** (managed cloud first, self-host when volume justifies) | Production WebRTC SFU: low-latency video down, control data-channel up, recording built in. Building raw WebRTC infra is a year of undifferentiated work |
| Robot SDK | Python package + ROS 2 bridge node; escalation call carries context (frames, task state, requested control scope) | Meets robotics teams where they are |
| Safety gate | Escalation → scoped control grant (which joints/velocities, geofence, max duration) → **safety-confirmation binary through Judge** → session. Deadman switch + robot-side watchdog reverts to safe state on packet loss | The gate is a product feature ("$0.50 safety binary") and a liability requirement |
| Operator bench | Browser-based console (LiveKit client) with gamepad/keyboard input; region-pinned operator pods to keep control latency <250 ms for assigned fleets | Latency budget dictates operator geography — plan benches per region, not one global pool |
| Design principle | Favor **discrete assistance** (select grasp, confirm object, set waypoint, approve plan) over raw joystick wherever the robot stack allows | Tolerates latency, lowers operator skill floor, and produces cleaner demonstration data |
| The flywheel, literally | Session recording (video + control inputs + rationale) → R2 → auto-created annotation task → returned to customer via API as a training-ready demonstration | This pipeline is ~3 integrations of things already built above — that's why the architecture shares one spine |

---

## 6. Cross-cutting

- **Security/compliance:** SOC 2 program tooling (Vanta or Drata) from day one; append-only audit events; RLS everywhere; per-customer data isolation in R2 prefixes + scoped signed URLs; PII scrubbing in the capture pipeline.
- **Environments:** `prod` + `staging`; Supabase branches for preview; IaC (Terraform) once Fly/R2/LiveKit/Modal resources multiply.
- **The one thing not to build:** a custom workflow engine, a custom labeling tool, custom WebRTC infrastructure, or a custom usage-billing system. All four have excellent off-the-shelf answers; the moat is routing, quality, Relay's trace corpus, and the flywheel.

---

## 7. Build order

| Phase | Weeks | Ships | New infra |
|---|---|---|---|
| **1 — Judge + Relay V0** | 1–8 | REST API (5 primitives), Relay V0, worker console, Stripe metering, webhooks, MCP server, status page | Supabase, Fly.io, Stripe, Sentry |
| **2 — Capture & Annotate productized** | 8–20 | Ingest pipeline, PII scrub, searchable catalog, dataset delivery, CVAT + QA dashboards | R2, Modal, CVAT |
| **3 — Operate pilot + flywheel** | 16–28 | LiveKit teleop bench, robot SDK, safety gate, intervention→demonstration pipeline; Relay V1 (pgvector answer cache, confidence routing) | LiveKit, Temporal |
| **4 — Relay V2** | post-traction | Auto-resolution at consensus, distilled decomposition model | training infra as needed |

Phases 2 and 3 overlap deliberately: capture revenue funds the platform; Judge/Operate create the recurring relationship.
