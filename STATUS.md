# HumanRelay — STATUS

> Authoritative state of the company's systems. Read this first in any new session.
> Last updated: **2026-06-10** (post-launch day 1).

## What HumanRelay is

**humanrelay.com — "the human layer for agents and robots."** Four products, one
workforce, one pipeline:

1. **Capture** — egocentric 4K data collection (managed centers, consent-first)
2. **Annotate** — labeling & evaluation via sister company IndiVillage (500M+ delivered)
3. **Judge** — HITL API: five primitives (Classify, Judge, Extract, Escalate, Resolve)
   + **Relay** decomposition (complex question → priced human binaries → verdict)
4. **Operate** — safety-gated teleoperation for deployed fleets

The thesis on the site: **the common-sense gap** — "every human knows not to drive
into a flooded road; no dataset does." Every intervention returns as a labeled
demonstration (the flywheel). Canonical examples: `platform/EDGE-CASES.md`.

## Live infrastructure (all verified in production)

| Thing | Where | Notes |
|---|---|---|
| Site | https://humanrelay.com | static, `public/index.html`, single file |
| API | https://api.humanrelay.com | same Vercel project, Host-header rewrite → `/api/index` |
| Vercel project | `humanrelay.com` (`prj_rQtepgbkfFqfnBpX832zU4m5D2rh`, team `team_axY29JS4o7JgkXdfGbml7Nl2`) | main auto-deploys production |
| DB | Supabase `humanrelay-platform`, ref `knyflhjlgdttwkcnwgbh` (us-east-1) | transaction pooler, port 6543 |
| Email | Google Workspace, hello@humanrelay.com | |
| Cron | Vercel cron, hourly `/cron/maintenance` | leases + webhook dispatch |
| Orgs in prod | `HumanRelay Internal` (system), `HumanRelay Pilot` (customer zero) | first production human judgment completed 2026-06-10 |

Secrets (`DATABASE_URL`, `ADMIN_TOKEN`, `CRON_SECRET`, `RELAY_MODE`) live only in
Vercel env vars (Sensitive). Admin/cron tokens known to the founder. **Never commit
secrets; agents must never self-mint or rotate production credentials** (the
permission classifier also enforces this — rotation is founder-run via the endpoint).

`RELAY_MODE` is currently `mock` (deterministic decomposition, no LLM). Flip to
`live` + `ANTHROPIC_API_KEY` before customer-facing Relay demos.

## Platform code

`platform/` — TypeScript/Hono/Postgres. `cd platform && npm install && npm test`
(**41 passing**). Key docs: `ARCHITECTURE.md` (root), `platform/RELAY-SPEC.md`,
`platform/EDGE-CASES.md`, `platform/README.md` (deploy runbook + API surface),
`platform/DRY-RUN.md` (customer-zero session plan).

Worker bench: `https://api.humanrelay.com/console`. Bootstrap: `platform/scripts/bootstrap-prod.sh`.
Dry-run seeder: `platform/scripts/seed-dry-run.sh` (customer API only, rehearsed locally).

## Shipped log

**2026-06-11**
- Relay demo is now photoreal: four founder-generated frames live
  (flood = default, crop scout, two pills, resident-on-floor), each
  band-cropped past generator watermarks and zoom-checked (no readable
  labels/imprints/faces/plates). Rotation shows photo-backed cards only;
  bee/bag/cones/eagle (SVG) rejoin as their photos land — briefs in
  ASSET-BRIEFS.md. Pipeline for new frames: drop in ~/Downloads →
  band crop to 2.91:1 → zoom checks → 1600×550 WebP → add img/alt to
  the card entry in public/index.html.

**2026-06-10 (pm)**
- Common-sense-gap thesis woven into the site flywheel (pull-quote + copy);
  Relay demo rotates 5 examples — bee-or-wasp photo (default), flooded road,
  counterfeit listing, contradicting construction cones, eagle-in-drone-frame —
  `platform/EDGE-CASES.md` is the source of truth, keep in sync.
  **The founder-set entry test: more training data doesn't fix the case.**
  Two admissible flavors: out-of-distribution situations (robots/AVs: the
  Waymo-flooded-road test) and long-tail instance ambiguity (agents: "model
  says 60% wasp; 60% isn't good enough" — the volume business). Cut for
  failing it: boiler (specialist lookup), pharmacy interaction (database);
  officer-at-red-light, downed cable, chicken, wire, crosswalk → library only.
  **Robot/AV cases are `strategy=direct`** — an image is sent, a question is
  asked ("is this safe to drive through?"), one human answers at one price.
  Don't dress robot escalations up as decompositions.
- `POST /v1/relay` now accepts `content` (camera frame, document): rides into
  every binary task payload; content-bearing traces bypass the answer cache
  entirely (same text + different frame must never share answers). Migration
  0003, SDK + MCP tool updated, 42 tests passing.
- `POST /v1/keys/rotate` (self-service, optional `grace_minutes` 0–1440) +
  `GET /v1/keys`. Live and verified in prod. Deliberately not an MCP tool.
- Customer-zero dry-run kit (`DRY-RUN.md` + `seed-dry-run.sh`), rehearsed end-to-end
  locally including a Relay trace completing via the pattern library.

**2026-06-10 (am, launch session)**
- Vercel serverless adapter, host-routed site+API, 504 fix, prod deploy runbook,
  customer-zero bootstrap; first production human judgment completed.

**Earlier:** Relay v1 build-out (negotiation, plan validation, pattern library, cache
auditing, webhooks), M1–M6 platform milestones, site v2 with humanrelay.com domain.

## Conventions

- Every claim on the site must be defensible in a customer call. No inflated numbers.
- **Schema changes:** the runtime role (`humanrelay_app`) does NOT own the tables —
  boot-time migrations that need DDL fail with "must be owner" (caused a ~25-min
  API outage on 2026-06-10). Apply new migrations via the Supabase connector's
  `apply_migration` (owner role, founder authorization required) **before** pushing
  code that depends on them, and insert the matching `schema_migrations` row.
  Boot now degrades instead of dying: `/health` shows `migrations: pending: <err>`
  and a failed cold start is never cached.
- Brand: warm paper `#F5F0E8` / vermillion `#E05A33`, "HumanRelay." wordmark with
  vermillion dot, Fraunces display over Inter.
- Commit and push frequently; main auto-deploys production.
- Sandbox egress blocks most hosts but **api.humanrelay.com and humanrelay.com are
  reachable via curl**; Vercel MCP fetch works for anything else Vercel-hosted.
  Anthropic's WebFetch is blocked by Vercel platform-wide (not our config).
- Supabase MCP `execute_sql` against `knyflhjlgdttwkcnwgbh` for DB checks;
  Vercel MCP for deploys/logs.

## Open items (in priority order)

1. **Founder: rotate the pilot API key** — one command, kills the launch-day key:
   `curl -s -X POST https://api.humanrelay.com/v1/keys/rotate -H "Authorization: Bearer <current key>"`
   (response shows the new key once; add `-d '{"grace_minutes":30}'` for soft cutover).
2. **Run the customer-zero dry run** with real IndiVillage workers (`platform/DRY-RUN.md`).
3. **First paying pilot** — the goal behind all of it. Pipeline work: pick 5 target
   robotics/agent companies, send the pilot one-pager, get one signed scope.
4. Stripe billing hookup (meters ready), `RELAY_MODE=live`, real embeddings for the
   binary cache, LiveKit teleop transport — per `ARCHITECTURE.md` phases.

**Done 2026-06-10:** Google Search Console — domain property `humanrelay.com`
verified via DNS TXT (record lives in Vercel DNS, comment "Google Search Console
domain verification" — don't delete it), sitemap submitted (Status: Success),
homepage already indexed with the FAQ rich result detected; recrawl requested for
the new flywheel content.

We're not done until customers are coming through the door.
