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
  extraction_concurrency: 4
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

echo "==> 5. POST /v1/sessions (upload 3 images)"
# minimal valid 1x1 PNGs. Three pages, with extraction_concurrency=4 above, so
# all pages are extracted concurrently — which is what step 7's ordering
# assertion exercises.
png=/tmp/iris-e2e-page.png
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC' | base64 -d > "$png"
create=$(curl -s -X POST "${AUTH[@]}" "$BASE/sessions" \
  -F "images=@$png;filename=page-001.png" \
  -F "images=@$png;filename=page-002.png" \
  -F "images=@$png;filename=page-003.png" \
  -F 'config={"max_review_iterations":1}')
SID=$(echo "$create" | jq -r '.session_id')
echo "$create" | jq -e '.status=="queued" and .image_count==3' >/dev/null \
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

echo "==> 7. GET /v1/sessions/{id}/output"
out=$(curl -s "${AUTH[@]}" "$BASE/sessions/$SID/output")
echo "$out" | grep -q '<main>' && echo "$out" | grep -q 'Quarterly Report' \
  && ! echo "$out" | grep -q '@source' \
  && pass "clean HTML output (no provenance comments)" || fail "output" "$out"
# filename mirrors the uploaded file (first part: page-001.png)
hdr=$(curl -s -D - -o /dev/null "${AUTH[@]}" "$BASE/sessions/$SID/output")
echo "$hdr" | grep -qi 'content-disposition:.*page-001_converted.html' \
  && pass "download filename mirrors input (page-001_converted.html)" || fail "filename" "$hdr"
echo "$out" | grep -q '<title>page-001</title>' \
  && pass "output title mirrors input" || fail "title" "$(echo "$out" | grep -i '<title>')"
# Pages are extracted in PARALLEL, and the mock deliberately answers
# slowest-first (page 1 is delayed the longest), so completion order is the
# reverse of document order. Two independent checks that parallelism did not
# reorder the document:
#   a) the delivered HTML reads 1,2,3 (assembleBody also sorts by .order, so this
#      is the belt-and-braces check the user actually sees), and
#   b) fragments.json — the raw mapWithConcurrency output, unsorted — is already
#      in document order, which is the property the helper guarantees.
markers=$(echo "$out" | grep -o 'Page marker [0-9]*' | grep -o '[0-9]*' | tr '\n' ',')
[ "$markers" = "1,2,3," ] \
  && pass "pages assembled in document order despite reverse completion order ($markers)" \
  || fail "page order" "expected 1,2,3, got '$markers'"
frag="$DATA/sessions/$SID/fragments/fragments.json"
fragorder=$(jq -r '[.[].order] | @csv' "$frag")
fragmarks=$(jq -r '[.[].innerHtml | capture("Page marker (?<n>[0-9]+)").n] | @csv' "$frag")
[ "$fragorder" = '1,2,3' ] && [ "$fragmarks" = '"1","2","3"' ] \
  && pass "fragments.json in submitted order pre-sort (order=$fragorder)" \
  || fail "fragment order" "order=$fragorder markers=$fragmarks"

echo "==> 8. GET /v1/sessions/{id}/logs (ndjson)"
logs=$(curl -s "${AUTH[@]}" "$BASE/sessions/$SID/logs")
echo "$logs" | head -1 | jq -e '.type' >/dev/null \
  && pass "run log is ndjson ($(echo "$logs" | wc -l | tr -d ' ') lines)" || fail "logs" "$logs"

echo "==> 8b. GET /v1/sessions/{id}/diagnostics"
diag=$(curl -s "${AUTH[@]}" "$BASE/sessions/$SID/diagnostics")
echo "$diag" | jq -e '.model_calls.count >= 1 and .in_flight == null and (.phase_durations_ms | length >= 1)' >/dev/null \
  && pass "diagnostics: $(echo "$diag" | jq -r '.model_calls.count') model calls timed, in_flight=null, phases=$(echo "$diag" | jq -r '.phase_durations_ms|keys|length')" \
  || fail "diagnostics" "$diag"

# Waits for the session to return to ready_for_review after a feedback re-run.
await_ready() {
  for i in $(seq 1 60); do
    status=$(curl -s "${AUTH[@]}" "$BASE/sessions/$SID" | jq -r '.status')
    [ "$status" = "ready_for_review" ] && return 0
    [ "$status" = "failed" ] && fail "$1" "run failed: $(curl -s "${AUTH[@]}" "$BASE/sessions/$SID" | jq -r .error)"
    sleep 0.5
  done
  fail "$1" "stuck at $status"
}
# Reads the last-logged value of a field from a given run-log event type. The logs
# endpoint is ndjson, so filter line-by-line rather than slurping one document.
log_field() {
  curl -s "${AUTH[@]}" "$BASE/sessions/$SID/logs" \
    | jq -c --arg t "$1" 'select(.type==$t)' | tail -1 | jq -r --arg f "$2" ".[\$f] // \"none\""
}

echo "==> 9. POST /v1/sessions/{id}/feedback (document-level => review only)"
fb=$(curl -s -X POST "${AUTH[@]}" "$BASE/sessions/$SID/feedback" -H 'content-type: application/json' \
  -d '{"feedback":"Keep headings distinct from body text."}')
echo "$fb" | jq -e '.status=="running"' >/dev/null && pass "feedback re-run accepted" || fail "feedback" "$fb"
await_ready "re-run"
# Document-level feedback must NOT re-extract: no page should be marked Revised.
target=$(log_field feedback_scoped target)
[ "$target" = "document" ] && pass "feedback scoped to document (no re-extraction)" \
  || fail "scope" "expected target=document, got '$target'"
out2=$(curl -s "${AUTH[@]}" "$BASE/sessions/$SID/output")
! echo "$out2" | grep -q 'Revised' \
  && pass "no page re-extracted for document-level feedback" \
  || fail "scope" "a page was re-extracted: $(echo "$out2" | grep -o 'Page marker [0-9]*[^<]*')"

echo "==> 9b. POST /v1/sessions/{id}/feedback (source-level => re-extract page 2)"
# Content-level feedback the review loop structurally cannot fix: the Reader never
# sees the source images, so a misreading raises no issue at all — page 2 must go
# back to the page agent WITH its image attached (#30 Tier 3).
fb=$(curl -s -X POST "${AUTH[@]}" "$BASE/sessions/$SID/feedback" -H 'content-type: application/json' \
  -d '{"feedback":"The revenue figure was misread on page 2 — check it against the source."}')
echo "$fb" | jq -e '.status=="running"' >/dev/null && pass "source-level feedback accepted" || fail "feedback" "$fb"
await_ready "re-extract re-run"
target=$(log_field feedback_scoped target)
[ "$target" = "extraction" ] && pass "feedback scoped to extraction" \
  || fail "scope" "expected target=extraction, got '$target'"
out3=$(curl -s "${AUTH[@]}" "$BASE/sessions/$SID/output")
# Exactly page 2 revised, and the document is still in order with all 3 pages.
revised=$(echo "$out3" | grep -o 'Page marker [0-9]*\. Revised\.' | grep -o '[0-9]*' | tr '\n' ',')
[ "$revised" = "2," ] && pass "only page 2 was re-extracted (revised=$revised)" \
  || fail "re-extract" "expected only page 2 revised, got '$revised'"
markers3=$(echo "$out3" | grep -o 'Page marker [0-9]*' | grep -o '[0-9]*' | tr '\n' ',')
[ "$markers3" = "1,2,3," ] && pass "all 3 pages still present, in order, after re-extraction" \
  || fail "re-extract order" "expected 1,2,3, got '$markers3'"

echo "==> 9c. POST /v1/sessions/{id}/feedback (copy-edit round => only the flagged page's image)"
# The Copy Editor attaches source images as base64 on EVERY review round. The mock
# Reader reports one issue attributed to page 2, so the editor must receive 1 of 3
# images. Asserted twice, independently: from the run log, and from the editor's own
# output (the mock echoes how many image parts it actually received).
fb=$(curl -s -X POST "${AUTH[@]}" "$BASE/sessions/$SID/feedback" -H 'content-type: application/json' \
  -d '{"feedback":"The headings need a copy-edit pass."}')
echo "$fb" | jq -e '.status=="running"' >/dev/null && pass "copy-edit feedback accepted" || fail "feedback" "$fb"
await_ready "copy-edit re-run"
target=$(log_field feedback_scoped target)
[ "$target" = "document" ] && pass "copy-edit feedback stayed on the document path" \
  || fail "scope" "expected target=document, got '$target'"
attached=$(log_field editor_images attached)
of=$(log_field editor_images of)
[ "$attached" = "1" ] && [ "$of" = "3" ] \
  && pass "editor image payload scoped to the flagged page ($attached of $of)" \
  || fail "editor images" "expected 1 of 3, got $attached of $of"
out4=$(curl -s "${AUTH[@]}" "$BASE/sessions/$SID/output")
echo "$out4" | grep -q 'Editor saw 1 image(s)' \
  && pass "the editor actually received 1 image, not all 3" \
  || fail "editor images" "$(echo "$out4" | grep -o 'Editor saw [0-9]* image(s)')"
# Issues left at the iteration cap carry the page the Reader attributed them to.
echo "$out4" | grep -q '@unresolved' && echo "$out4" | grep -q 'page 2' \
  && pass "unresolved issues record their source page" \
  || fail "unresolved attribution" "$(echo "$out4" | grep -A3 '@unresolved')"

echo "==> 10. ownership isolation (other endpoints reject unknown id)"
code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$BASE/sessions/ses_doesnotexist")
[ "$code" = "404" ] && pass "unknown session => 404" || fail "isolation" "got $code"

echo "==> 11. GET /v1/sessions (list)"
list=$(curl -s "${AUTH[@]}" "$BASE/sessions")
echo "$list" | jq -e --arg sid "$SID" '.sessions | map(.session_id) | index($sid) != null' >/dev/null \
  && pass "session appears in list" || fail "list" "$list"

echo "==> 12. POST /v1/sessions/{id}/close (finalize + clean tmp; no PRs)"
close=$(curl -s -X POST "${AUTH[@]}" "$BASE/sessions/$SID/close")
echo "$close" | jq -e '.status=="closed"' >/dev/null && pass "session closed" || fail "close" "$close"
[ ! -d "$DATA/tmp/$SID" ] && pass "tmp/ cleaned on close" || fail "tmp cleanup" "tmp dir still present"

echo "==> 13. close again => 409 invalid_state"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${AUTH[@]}" "$BASE/sessions/$SID/close")
[ "$code" = "409" ] && pass "re-close rejected (409)" || fail "re-close" "got $code"

echo ""
echo "ALL ENDPOINTS PASSED ✅"
