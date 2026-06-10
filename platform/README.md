# HumanRelay Platform

The systems behind humanrelay.com: the **Judge** HITL API, the **Relay** intelligence layer,
the worker quality engine, **Operate** (teleop safety gate + flywheel), and **Capture**
(dataset manifests). See `../ARCHITECTURE.md` for the full design.

## Run it

```bash
cd platform
npm install
npm start            # http://localhost:8787 — no DATABASE_URL needed (in-process PGlite dev mode)
npm test             # 32 specs over real Postgres semantics
npm run typecheck
```

Production: set `DATABASE_URL` (Supabase), `ADMIN_TOKEN`, and `RELAY_MODE=live` +
`ANTHROPIC_API_KEY`. Migrations in `db/migrations/` run automatically at boot.

## Production deploy (Vercel + Supabase)

Live infra: Supabase project `humanrelay-platform` (ref `knyflhjlgdttwkcnwgbh`, us-east-1).

1. Vercel → Add New Project → import the repo → **Root Directory: `platform`** →
   Framework: Other, no build command.
2. Environment variables:
   - `DATABASE_URL` — Supabase Dashboard → Connect → **Transaction pooler** URI (port 6543)
   - `ADMIN_TOKEN` — long random string (admin + maintenance auth)
   - `CRON_SECRET` — long random string (Vercel Cron auth)
   - `RELAY_MODE` — `mock` until `ANTHROPIC_API_KEY` is set, then `live`
3. Deploy, then add domain `api.humanrelay.com` (auto-DNS — same Vercel team hosts the zone).
4. Smoke: `GET /health`, create an org via `/admin/orgs`, run one `/v1/classify` round trip.

`api/index.ts` is the serverless entry; `/cron/maintenance` (hourly cron + opportunistic
on-traffic runs) replaces the dev-mode background loops in `server.ts`.

## Try the whole loop locally

```bash
ADMIN_TOKEN=dev npm start &

# 1. Create a customer org + API key
curl -s -X POST localhost:8787/admin/orgs -H 'x-admin-token: dev' \
  -H 'content-type: application/json' -d '{"name":"Acme"}'        # → { api_key: "hr_live_..." }

# 2. Create a worker
curl -s -X POST localhost:8787/admin/workers -H 'x-admin-token: dev' \
  -H 'content-type: application/json' \
  -d '{"name":"Asha","tier":"expert","skills":["teleop","teleop_safety","video_labeling"]}'

# 3. Agent asks a question
curl -s -X POST localhost:8787/v1/relay -H 'authorization: Bearer hr_live_...' \
  -H 'content-type: application/json' \
  -d '{"question":"The road ahead is covered in water. Should my delivery robot proceed or reroute?"}'

# 4. Open the worker bench and answer the binaries
open http://localhost:8787/console     # enter the worker id, press Y/N

# 5. Fetch the reassembled verdict
curl -s localhost:8787/v1/relay/<id> -H 'authorization: Bearer hr_live_...'
```

## Layout

| Path | What |
|---|---|
| `db/migrations/` | Supabase-compatible SQL schema (orgs, keys, workers, tasks, events, gold, webhooks, meters, relay, capture, teleop) |
| `src/db.ts` | DB abstraction — pg Pool (prod) / PGlite (dev & tests) |
| `src/core/engine.ts` | Task lifecycle: idempotent create, worker pull, gold injection, consensus, leases, metering, audit events |
| `src/core/quality.ts` | Bayesian worker accuracy (Beta posterior), gold cadence |
| `src/core/routing.ts` | Tier/skill eligibility, quality + load ranking |
| `src/core/teleop.ts` | Safety-gated teleop sessions; handback → demonstration annotation task (the flywheel) |
| `src/core/capture.ts` | Clip registry, QC/PII gating, provenance dataset manifests |
| `src/relay/` | Relay: plan (Opus, structured outputs) → waves of human binaries → reassemble (Sonnet); binary cache (V1 pattern learner) |
| `src/api/app.ts` | Hono REST API: 5 primitives, relay, teleop, datasets, webhooks (HMAC + backoff), usage, worker bench, admin |
| `src/mcp/server.ts` | MCP server: `humanrelay_classify/judge/extract/escalate/resolve/relay` tools for agents |
| `src/console/console.html` | Keyboard-first worker bench |
| `tests/` | vitest suite (core, relay, api e2e, teleop, sdk) |
| `src/sdk/client.ts` | TypeScript customer SDK — the `hr.judge(...)` from the website, real |

## API surface

Customer (Bearer `hr_live_...`):

```
POST /v1/classify|judge|extract|escalate|resolve   create a human task (Idempotency-Key honored)
POST /v1/relay                                     decompose + resolve a complex question
GET  /v1/tasks/:id  /v1/relay/:id                  status, verdict, rationale, audit trail
POST /v1/teleop/sessions                           robot escalation → safety binary → operator
POST /v1/teleop/sessions/:id/handback              ends session, emits demonstration task
POST /v1/datasets   GET /v1/datasets/:id           provenance-bearing capture manifests
POST /v1/webhooks   GET /v1/usage                  HMAC-signed deliveries; metered billing
POST /v1/keys/rotate   GET /v1/keys                self-service rotation (grace_minutes 0–1440 keeps the old key alive); deliberately not an MCP tool
```

Workers: `POST /worker/claim`, `POST /worker/answer`, `GET /worker/:id/stats`, UI at `/console`.
Admin (`x-admin-token`): orgs, workers, gold items, clips, maintenance.

Webhook verification: `x-humanrelay-signature: sha256=HMAC_SHA256(body, secret)`.

## Design choices worth knowing

- **The audit trail is the product.** Every transition is an append-only `task_events` row;
  `GET /v1/tasks/:id` returns it. Expert-tier accountability is queryable.
- **Gold sets are invisible.** Workers periodically receive calibration tasks indistinguishable
  from real work; results update a Beta posterior that drives routing. The public "99%+"
  number is computed, not asserted.
- **Relay never economizes on decomposition.** Opus plans, humans answer, Sonnet reassembles.
  Token cost is cents; a wasted $2.50 expert binary is the real cost.
- **The cache is the margin.** Repeat binaries auto-resolve after 3-way consensus
  (`binary_cache`), converting human calls into free lookups — Relay V1 from the roadmap.
- **The flywheel is literal.** `teleop handback` creates an `annotate` task pointing at the
  recording. Every intervention is a labeled demonstration.

## Deliberately not built here

Stripe billing hookup (meters are ready to export), LiveKit transport (lifecycle + safety
gate are ready for it), real embeddings for the cache (provider is pluggable), CVAT
integration, and any UI beyond the bench. Next in line per ARCHITECTURE.md phases.
