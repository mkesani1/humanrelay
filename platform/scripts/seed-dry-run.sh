#!/usr/bin/env bash
# Seed the customer-zero dry-run task mix (see ../DRY-RUN.md).
#
# Usage:
#   API=https://api.humanrelay.com HR_API_KEY=hr_live_... ./scripts/seed-dry-run.sh
#   WARMUP_ONLY=1 ...   # just the two warm-up tasks
#
# Task mix drawn from platform/EDGE-CASES.md, plus a warfarin escalate that
# exists to exercise the expert tier + rationale enforcement (it is NOT a
# common-sense-gap example — see the library's entry test).
# Customer-API only: no admin token, nothing here can touch other orgs.
set -euo pipefail

API="${API:-http://localhost:8787}"
: "${HR_API_KEY:?set HR_API_KEY (the pilot org api key)}"

post() { # post <path> <json> [idempotency-key]
  curl -sf -X POST "$API$1" -H "authorization: Bearer $HR_API_KEY" \
    -H "content-type: application/json" ${3:+-H "idempotency-key: $3"} -d "$2"
}
tid() { python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('task',d.get('relay',{})).get('id','?'))"; }

echo "==> health"; curl -sf "$API/health" >/dev/null && echo "    ok"

echo "==> warm-up (2 basic classifies)"
post /v1/classify '{"question":"Does the image description \"a person stacking boxes in a warehouse\" describe manual work?","tier":"basic"}' | tid
post /v1/classify '{"question":"Is the sentence \"Please reset my password\" a customer support request?","tier":"basic"}' | tid

if [ "${WARMUP_ONLY:-0}" = "1" ]; then echo "WARMUP_ONLY=1 — stopping here."; exit 0; fi

echo "==> tiered binaries (from EDGE-CASES.md)"
post /v1/classify '{"question":"Does the water span the full width of the road? Context: delivery robot, residential street after heavy rain.","tier":"basic"}' | tid
post /v1/classify '{"question":"Are vehicles ahead stalled or turning around? Context: same flooded street.","tier":"basic"}' | tid
post /v1/judge   '{"question":"Is the damage in this claim consistent with shipping, not use? Context: blender, outer box intact, crushed corner inside.","tier":"complex","rubric":"Transit damage shows impact patterns consistent with handling; use damage shows wear."}' | tid
post /v1/classify '{"question":"Was the raw chicken unrefrigerated for more than two hours? Context: kitchen prep log shows it was set out at 11:05, it is now 14:20.","tier":"basic"}' | tid
post /v1/judge   '{"question":"Given a pallet stack leaning visibly past vertical with an unsecured top layer, is it safe for a warehouse robot to pass under it?","tier":"complex"}' | tid
post /v1/escalate '{"question":"Patient takes warfarin; new prescription is high-dose ibuprofen. Fill it, or escalate to the prescriber?","content":{"interaction_class":"anticoagulant + NSAID"}}' | tid

echo "==> relay decompositions (workers will see the binaries)"
post /v1/relay '{"question":"The road ahead is covered in water. Should my delivery robot proceed or reroute?"}' | tid
post /v1/relay '{"question":"A customer says their blender arrived shattered and wants an $89 refund. Should we approve it?","tier_cap":"complex"}' | tid

echo
echo "DONE. Workers: answer at $API/console."
echo "Track: curl -s $API/v1/usage -H 'authorization: Bearer \$HR_API_KEY'"
echo "Relay: curl -s $API/v1/relay/<id> -H 'authorization: Bearer \$HR_API_KEY'"
