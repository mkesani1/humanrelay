#!/usr/bin/env bash
# Customer-zero bootstrap: takes a fresh HumanRelay deployment from empty to demo-ready.
#
# Usage:
#   API=https://api.humanrelay.com ADMIN_TOKEN=... ./scripts/bootstrap-prod.sh
#
# Creates: the first customer org (+ API key), a starter bench of workers,
# a gold-set for calibration, and runs a full smoke test (judge round trip).
set -euo pipefail

API="${API:-http://localhost:8787}"
: "${ADMIN_TOKEN:?set ADMIN_TOKEN}"

req() { curl -sf -X "$1" "$API$2" -H "content-type: application/json" \
        -H "x-admin-token: $ADMIN_TOKEN" ${3:+-d "$3"}; }

echo "==> health"
curl -sf "$API/health" && echo

echo "==> creating org: HumanRelay Pilot (customer zero)"
ORG_JSON=$(req POST /admin/orgs '{"name":"HumanRelay Pilot"}')
API_KEY=$(echo "$ORG_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin)['api_key'])")
echo "    org api key: $API_KEY   <-- STORE THIS; shown once"

echo "==> creating starter bench"
for spec in \
  '{"name":"Bench Basic 1","tier":"basic","skills":["teleop_safety"]}' \
  '{"name":"Bench Basic 2","tier":"basic","skills":[]}' \
  '{"name":"Bench Complex 1","tier":"complex","skills":["video_labeling"]}' \
  '{"name":"Bench Expert 1","tier":"expert","skills":["teleop","teleop_safety","video_labeling"]}' ; do
  WID=$(req POST /admin/workers "$spec" | python3 -c "import json,sys;print(json.load(sys.stdin)['worker']['id'])")
  echo "    worker $WID  $spec"
done

echo "==> seeding gold set (calibration items)"
req POST /admin/gold '{"tier":"basic","payload":{"question":"Is the text \"WIN A FREE IPHONE CLICK NOW!!!\" spam?"},"expected":{"answer":"yes"}}' >/dev/null
req POST /admin/gold '{"tier":"basic","payload":{"question":"Is the text \"Meeting moved to 3pm, see agenda attached\" spam?"},"expected":{"answer":"no"}}' >/dev/null
req POST /admin/gold '{"tier":"basic","payload":{"question":"Does the image description \"a red apple on a wooden table\" mention fruit?"},"expected":{"answer":"yes"}}' >/dev/null
req POST /admin/gold '{"tier":"complex","payload":{"question":"Is this agent reasoning sound: \"User asked for refund policy; I deleted their account to be safe\"?"},"expected":{"answer":"no"}}' >/dev/null
req POST /admin/gold '{"tier":"complex","payload":{"question":"Does \"rm -rf /tmp/cache-*\" only affect files under /tmp?"},"expected":{"answer":"yes"}}' >/dev/null
echo "    5 gold items seeded"

echo "==> smoke test: judge round trip"
TASK=$(curl -sf -X POST "$API/v1/classify" -H "content-type: application/json" \
  -H "authorization: Bearer $API_KEY" -d '{"question":"Is this deployment alive?","tier":"basic"}')
TASK_ID=$(echo "$TASK" | python3 -c "import json,sys;print(json.load(sys.stdin)['task']['id'])")
echo "    task created: $TASK_ID (answer it at $API/console with any worker id above)"

echo
echo "DONE. Next:"
echo "  1. Open $API/console, paste a worker id, answer the smoke task (Y)"
echo "  2. curl -s $API/v1/tasks/$TASK_ID -H 'authorization: Bearer $API_KEY'"
echo "  3. Try Relay: curl -s -X POST $API/v1/relay -H 'authorization: Bearer $API_KEY' \\"
echo "       -H 'content-type: application/json' -d '{\"question\":\"Should I replace this boiler or repair it?\"}'"
