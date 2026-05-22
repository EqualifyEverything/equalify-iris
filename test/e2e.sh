#!/usr/bin/env bash
# End-to-end API test driven entirely by curl. Boots mock GitHub + mock
# OpenRouter (test/mock-services.mjs), starts Iris against them, and exercises
# every /v1 endpoint through a full session lifecycle, asserting each response.
#
#   ./test/e2e.sh
#
# Requires: node 24+, curl, jq.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

GH_PORT=9301
OR_PORT=9302
PORT=8099
DATA=/tmp/iris-e2e
CFG=/tmp/iris-e2e-config.yaml
BASE="http://localhost:$PORT/v1"

command -v jq >/dev/null || { echo "jq is required"; exit 1; }

pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; echo "    $2"; cleanup; exit 1; }

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$DATA" "$CFG"
}
trap cleanup EXIT

rm -rf "$DATA"; mkdir -p "$DATA"

# Test deployment config: points GitHub + the model provider at the mocks.
cat > "$CFG" <<YAML
server:
  port: $PORT
  base_url: http://localhost:$PORT
storage:
  data_dir: $DATA
  agents_dir: ./agents
  database: $DATA/iris.sqlite
github:
  client_id: test-client
  client_secret: test-secret
  upstream_repo: https://github.com/example/iris
  api_base_url: http://localhost:$GH_PORT
  oauth_base_url: http://localhost:$GH_PORT
providers:
  default: openrouter
  openrouter:
    api_key: test-key
    base_url: http://localhost:$OR_PORT
    default_model: mock-model
    per_capability:
      vision: mock-model
      structured_output: mock-model
      text: mock-model
defaults:
  max_review_iterations: 1
YAML

echo "==> starting mock services"
MOCK_GH_PORT=$GH_PORT MOCK_OR_PORT=$OR_PORT node test/mock-services.mjs &
PIDS+=($!)

echo "==> starting Iris"
IRIS_CONFIG="$CFG" node --experimental-sqlite src/index.ts > /tmp/iris-e2e.log 2>&1 &
PIDS+=($!)

# wait for health
for i in $(seq 1 30); do
  if curl -sf "$BASE/health" >/dev/null 2>&1; then break; fi
  sleep 0.3
done

echo "==> 1. GET /v1/health"
curl -sf "$BASE/health" | jq -e '.status=="ok"' >/dev/null && pass "health ok" || fail "health" "no ok"

echo "==> 2. auth gating (no token => 401)"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/me")
[ "$code" = "401" ] && pass "unauthenticated request rejected" || fail "auth gating" "got $code"

echo "==> 3. device flow"
dev=$(curl -s -X POST "$BASE/auth/github/device")
echo "$dev" | jq -e '.user_code and .verification_uri' >/dev/null && pass "device code issued" || fail "device" "$dev"
DEVICE_CODE=$(echo "$dev" | jq -r '.device_code')
poll=$(curl -s -X POST "$BASE/auth/github/device/poll" -H 'content-type: application/json' -d "{\"device_code\":\"$DEVICE_CODE\"}")
TOKEN=$(echo "$poll" | jq -r '.access_token')
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] && pass "token obtained: $TOKEN" || fail "device poll" "$poll"
AUTH=(-H "Authorization: Bearer $TOKEN")

echo "==> 4. GET /v1/me"
me=$(curl -s "${AUTH[@]}" "$BASE/me")
echo "$me" | jq -e '.github_login=="iris-tester" and .defaults.max_review_iterations==1' >/dev/null \
  && pass "identity resolved ($(echo "$me" | jq -r .github_login))" || fail "me" "$me"

echo "==> 5. POST /v1/sessions (upload 2 images)"
# minimal valid 1x1 PNGs
png=/tmp/iris-e2e-page.png
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC' | base64 -d > "$png"
create=$(curl -s -X POST "${AUTH[@]}" "$BASE/sessions" \
  -F "images=@$png;filename=page-001.png" \
  -F "images=@$png;filename=page-002.png" \
  -F 'config={"max_review_iterations":1}')
SID=$(echo "$create" | jq -r '.session_id')
echo "$create" | jq -e '.status=="queued" and .image_count==2' >/dev/null \
  && pass "session created: $SID" || fail "create" "$create"

echo "==> 6. poll GET /v1/sessions/{id} until ready_for_review"
status=""
for i in $(seq 1 60); do
  s=$(curl -s "${AUTH[@]}" "$BASE/sessions/$SID")
  status=$(echo "$s" | jq -r '.status')
  [ "$status" = "ready_for_review" ] && break
  [ "$status" = "failed" ] && fail "pipeline" "$(echo "$s" | jq -r '.error')"
  sleep 0.5
done
[ "$status" = "ready_for_review" ] && pass "pipeline finished (phase=$(echo "$s" | jq -r .phase))" || fail "poll" "stuck at $status"
echo "$s" | jq -e '.pending_prs.new_agents | length >= 1' >/dev/null \
  && pass "pending_prs preview shows built agent ($(echo "$s" | jq -r '.pending_prs.new_agents[0].agent_name'))" \
  || fail "pending_prs" "$s"

echo "==> 7. GET /v1/sessions/{id}/output"
out=$(curl -s "${AUTH[@]}" "$BASE/sessions/$SID/output")
echo "$out" | grep -q '<main>' && echo "$out" | grep -q '@source' \
  && pass "HTML output with provenance comments" || fail "output" "$out"

echo "==> 8. GET /v1/sessions/{id}/logs (ndjson)"
logs=$(curl -s "${AUTH[@]}" "$BASE/sessions/$SID/logs")
echo "$logs" | head -1 | jq -e '.type' >/dev/null \
  && pass "run log is ndjson ($(echo "$logs" | wc -l | tr -d ' ') lines)" || fail "logs" "$logs"

echo "==> 9. POST /v1/sessions/{id}/feedback (re-run)"
fb=$(curl -s -X POST "${AUTH[@]}" "$BASE/sessions/$SID/feedback" -H 'content-type: application/json' \
  -d '{"feedback":"Keep headings distinct from body text."}')
echo "$fb" | jq -e '.status=="running"' >/dev/null && pass "feedback re-run accepted" || fail "feedback" "$fb"
for i in $(seq 1 60); do
  status=$(curl -s "${AUTH[@]}" "$BASE/sessions/$SID" | jq -r '.status')
  [ "$status" = "ready_for_review" ] && break
  [ "$status" = "failed" ] && fail "re-run" "failed"
  sleep 0.5
done
[ "$status" = "ready_for_review" ] && pass "re-run finished" || fail "re-run poll" "$status"

echo "==> 10. ownership isolation (other endpoints reject unknown id)"
code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$BASE/sessions/ses_doesnotexist")
[ "$code" = "404" ] && pass "unknown session => 404" || fail "isolation" "got $code"

echo "==> 11. GET /v1/sessions (list)"
list=$(curl -s "${AUTH[@]}" "$BASE/sessions")
echo "$list" | jq -e --arg sid "$SID" '.sessions | map(.session_id) | index($sid) != null' >/dev/null \
  && pass "session appears in list" || fail "list" "$list"

echo "==> 12. POST /v1/sessions/{id}/close (opens PR for built agent)"
close=$(curl -s -X POST "${AUTH[@]}" "$BASE/sessions/$SID/close")
echo "$close" | jq -e '.status=="closed"' >/dev/null && pass "session closed" || fail "close" "$close"
echo "$close" | jq -e '.prs_opened | length >= 1' >/dev/null \
  && pass "PR opened: $(echo "$close" | jq -r '.prs_opened[0].pr_url')" || fail "prs" "$close"
[ ! -d "$DATA/tmp/$SID" ] && pass "tmp/ cleaned on close" || fail "tmp cleanup" "tmp dir still present"

echo "==> 13. close again => 409 invalid_state"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${AUTH[@]}" "$BASE/sessions/$SID/close")
[ "$code" = "409" ] && pass "re-close rejected (409)" || fail "re-close" "got $code"

echo ""
echo "ALL ENDPOINTS PASSED ✅"
