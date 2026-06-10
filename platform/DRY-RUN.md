# Customer-Zero Dry Run — IndiVillage Workers on Production

**Goal:** put real IndiVillage workers on the production bench and run a realistic task
mix end to end, *before* the first paying pilot. We come out with honest numbers
(latency, gold accuracy, relay completion) and a list of everything that confused a
real worker. Nothing on humanrelay.com changes until this run backs it up.

**Where:** production — bench at `https://api.humanrelay.com/console`,
API at `https://api.humanrelay.com`, DB = Supabase `knyflhjlgdttwkcnwgbh`.

---

## Cast

| Role | Who | Needs |
|---|---|---|
| Facilitator | founder | `ADMIN_TOKEN`, rotated pilot API key, this doc |
| Workers | 4–6 IndiVillage professionals | a laptop + their worker ID each |
| Customer driver | facilitator (or a Claude session) | pilot API key, `scripts/seed-dry-run.sh` |

Worker mix that exercises routing (tier ≥ task tier, skills must cover tags):
**2× basic, 2× complex, 1–2× expert**. Give at least one expert
`["video_labeling"]` so skill-tag routing is visible.

## Before the session (facilitator, ~15 min)

1. **Rotate the pilot key** if not already done:
   `curl -s -X POST https://api.humanrelay.com/v1/keys/rotate -H "Authorization: Bearer <current key>"`
2. **Create the real workers** (replace the placeholder bench for the session — leave
   the `Bench *` rows; routing prefers least-loaded, so idle placeholders are harmless,
   but tell workers to use their own ID):
   ```bash
   curl -s -X POST https://api.humanrelay.com/admin/workers \
     -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' \
     -d '{"name":"<Real Name>","tier":"basic|complex|expert","skills":[]}'
   # → note each worker.id; hand it to that worker
   ```
3. **Decide Relay mode.** `RELAY_MODE=mock` (current default) decomposes
   deterministically without an LLM — fine for a worker-flow dry run. Set
   `RELAY_MODE=live` + `ANTHROPIC_API_KEY` in Vercel before the run if you want the
   real Opus decompositions the site demos. Either way humans answer every binary.
4. Open the Supabase SQL editor with the queries from "Watch it live" below.

## Session plan (~90 min)

**1 · Briefing (10 min).** What HumanRelay is, what the bench is, what gold items are
(say it plainly: "some tasks are calibration items with known answers — you can't tell
which, that's the point"). Expert tier requires a written rationale — the API rejects
expert answers without one (422).

**2 · Warm-up (10 min).** Each worker: open `/console`, paste worker ID, "Start
shift", answer 1–2 warm-up tasks (facilitator seeds them by hand or runs the seed
script's warm-up section). Confirm keyboard flow: **Y / N** keys, rationale textarea.

**3 · Main run (40 min).** Customer driver runs:
```bash
API=https://api.humanrelay.com HR_API_KEY=hr_live_... ./scripts/seed-dry-run.sh
```
This seeds the common-sense-gap mix from `EDGE-CASES.md`: tiered classify/judge
binaries, an escalate, and two Relay decompositions (flooded road, blender refund).
Workers just keep answering. Facilitator watches the queues drain and notes every
hesitation, misread question, or UI stumble — that list is the deliverable.

**4 · Debrief (20 min).** Ask each worker: What was unclear? What would you need to
do this 4 hours straight? Did any question feel unanswerable as yes/no? (Those are
decomposition bugs — file them against the Relay planner prompt.)

**5 · Numbers (10 min).** Run the queries below; screenshot for the pilot deck.

## Watch it live (Supabase SQL)

```sql
-- queue state
select status, count(*) from tasks group by status;

-- per-worker: answers, gold hit-rate, current Bayesian accuracy
select w.name, count(a.id) as answers,
       count(*) filter (where a.gold_correct) as gold_right,
       count(*) filter (where a.gold_correct is not null) as gold_seen,
       round(w.gold_alpha / (w.gold_alpha + w.gold_beta), 3) as accuracy
from workers w left join answers a on a.worker_id = w.id
group by w.id order by answers desc;

-- task latency (created -> completed)
select tier, count(*),
       round(avg(extract(epoch from completed_at - created_at))) as avg_s,
       round(percentile_cont(0.5) within group (order by extract(epoch from completed_at - created_at))) as p50_s
from tasks where status = 'completed' group by tier;

-- relay traces with per-binary provenance
select id, status, strategy, cache_hits, total_cost_cents, completed_at - created_at as wall
from relay_traces order by created_at desc;
```

## Success criteria

- [ ] Every seeded task reaches `completed` with no facilitator intervention
- [ ] Both Relay traces reassemble a verdict (binaries → verdict → rationale)
- [ ] Gold items appear in worker streams (cadence: every 10th task per worker) and
      gold accuracy is recorded
- [ ] Expert task without rationale is rejected and the worker recovers unaided
- [ ] p50 task latency under 60s while workers are actively on the bench
- [ ] Zero console bugs that block a worker; every confusion noted has an owner

## Honesty notes

- The dry run writes to the **pilot org's real usage meters** — that's correct
  (it's our own org); just don't quote those meter numbers as customer traction.
- Latency numbers from a staffed 40-minute window support "sub-minute responses
  *while the bench is staffed*" — coverage hours are a separate claim. Keep the
  site's wording within what this run actually shows.
- If a worker fails gold items, that's the system working. Don't edit it out of
  the debrief notes.

## Abort / reset

A stuck task: `POST /admin/maintenance/expire-leases` (or wait for the hourly cron).
To re-run clean, the seed script is idempotent-enough — tasks dedupe on
`Idempotency-Key` only, so re-running creates a fresh batch; old completed tasks
stay as history. No destructive reset exists by design (append-only audit trail).
