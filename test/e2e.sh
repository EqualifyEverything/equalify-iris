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
LOG=/tmp/iris-e2e.log
BASE="http://localhost:$PORT/v1"

# Seconds to wait for Iris to answer /health. Generous because a cold CI runner
# type-strips every .ts source with no warm cache; locally this takes ~1s.
BOOT_TIMEOUT=${BOOT_TIMEOUT:-45}

command -v jq >/dev/null || { echo "jq is required"; exit 1; }

pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; echo "    $2"; dump_server_log; cleanup; exit 1; }

# Any failure here is far easier to diagnose with the server's own output, and on
# CI this script's stdout is often the only artifact — so print it on every
# failure rather than leaving it in a temp file nobody retrieves.
dump_server_log() {
  [ -f "$LOG" ] || return 0
  echo "    ── last 40 lines of $LOG ──"
  tail -40 "$LOG" | sed 's/^/    /'
  echo "    ── end server log ──"
}

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
  # One run at a time across sessions, so step 9e can observe the queue: a second
  # upload submitted while the first is running must WAIT in \`queued\` rather than
  # starting a second unthrottled pipeline.
  max_concurrent_runs: 1
YAML

echo "==> starting mock services"
MOCK_GH_PORT=$GH_PORT MOCK_OR_PORT=$OR_PORT node test/mock-services.mjs &
PIDS+=($!)

echo "==> starting Iris"
IRIS_CONFIG="$CFG" node --experimental-sqlite src/index.ts > "$LOG" 2>&1 &
IRIS_PID=$!
PIDS+=("$IRIS_PID")

# Wait for health, distinguishing the three ways this can go wrong: the process
# died (report its log immediately rather than polling a corpse for 45s), it is
# still booting (keep waiting), or it never answered in time (report how long we
# waited and whether it was even alive — a bare "no ok" is undiagnosable, which
# is exactly what happened on the one CI failure that motivated this).
boot_start=$SECONDS
booted=""
while [ $((SECONDS - boot_start)) -lt "$BOOT_TIMEOUT" ]; do
  if curl -sf "$BASE/health" >/dev/null 2>&1; then booted=1; break; fi
  if ! kill -0 "$IRIS_PID" 2>/dev/null; then
    echo "  ✗ Iris exited during startup after $((SECONDS - boot_start))s"
    dump_server_log
    cleanup
    exit 1
  fi
  sleep 0.3
done
boot_elapsed=$((SECONDS - boot_start))

echo "==> 1. GET /v1/health"
if [ -z "$booted" ]; then
  fail "health" "no response within ${BOOT_TIMEOUT}s (process still running: \
$(kill -0 "$IRIS_PID" 2>/dev/null && echo yes || echo no)). \
Raise BOOT_TIMEOUT if this runner is just slow."
fi
curl -sf "$BASE/health" | jq -e '.status=="ok"' >/dev/null \
  && pass "health ok (booted in ${boot_elapsed}s)" || fail "health" "no ok"

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

# The scope the service ASKED GitHub for. Invisible from the client — the flow
# succeeds whatever is requested — and bounded from both sides: too narrow and the
# user cannot file the feedback issue every session contributes (PRD §12), too wide
# and every user hands over write access to all their private repos for nothing. The
# config above sets no `oauth_scope`, so this asserts the DEFAULT that ships, not a
# value the test chose.
scope=$(curl -s "http://localhost:$GH_PORT/__last_device_scope")
echo "$scope" | jq -e '.scope=="public_repo"' >/dev/null \
  && pass "the device flow requested public_repo, not repo" \
  || fail "oauth scope" "expected scope=public_repo, got $scope"

echo "==> 4. GET /v1/me"
me=$(curl -s "${AUTH[@]}" "$BASE/me")
echo "$me" | jq -e '.github_login=="iris-tester" and .defaults.max_review_iterations==1' >/dev/null \
  && pass "identity resolved ($(echo "$me" | jq -r .github_login))" || fail "me" "$me"
# The response shape over the wire, not just in a unit test: `fork_repo` is gone
# rather than permanently null, since nothing forks (PRD §7.13 v1.2).
echo "$me" | jq -e 'has("fork_repo")|not' >/dev/null \
  && pass "no fork_repo in /me" || fail "me shape" "$me"

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

echo "==> 9d. a truncated model response fails the run instead of shipping partial HTML"
# A response that stops at the output-token ceiling arrives as a 200 with partial
# content — nothing downstream can distinguish it from a complete answer, and HTML
# cut mid-tag still parses well enough to be assembled and delivered as if it were
# real content. On a SEPARATE session so the main one stays intact.
curl -s -X POST "http://localhost:$OR_PORT/__truncate" >/dev/null
trunc=$(curl -s -X POST "${AUTH[@]}" "$BASE/sessions" \
  -F "images=@$png;filename=trunc-001.png" -F 'config={"max_review_iterations":1}')
TSID=$(echo "$trunc" | jq -r '.session_id')
tstatus=""
for i in $(seq 1 60); do
  tstatus=$(curl -s "${AUTH[@]}" "$BASE/sessions/$TSID" | jq -r '.status')
  { [ "$tstatus" = "failed" ] || [ "$tstatus" = "ready_for_review" ]; } && break
  sleep 0.5
done
curl -s -X POST "http://localhost:$OR_PORT/__truncate" >/dev/null   # back to normal
[ "$tstatus" = "failed" ] \
  && pass "truncated response failed the run (not delivered as content)" \
  || fail "truncation" "expected status=failed, got '$tstatus'"
# The error must name the ceiling and the knob to raise — an operator seeing this
# has no other clue why a page came back short.
terr=$(curl -s "${AUTH[@]}" "$BASE/sessions/$TSID" | jq -r '.error')
echo "$terr" | grep -q 'output ceiling' && echo "$terr" | grep -q 'max_tokens' \
  && pass "the failure explains the ceiling and names max_tokens" \
  || fail "truncation error" "$terr"
# And the partial HTML must not be retrievable as output.
tout=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$BASE/sessions/$TSID/output")
[ "$tout" = "409" ] && pass "no output served for the truncated run (409)" \
  || fail "truncation output" "expected 409, got $tout"

echo "==> 9f. specialist dispatch says so in the log, whether it runs or misses"
# The page agent names the specialist it wants in free text, and the service
# resolves that string to a file. Any drift between what the model writes and what
# the library is called ("chart" vs "chartDataAgent.md", a plural, a display name)
# silently disables routing: no error, and previously no log line either, so
# "routing was never attempted" and "routing was attempted and the name did not
# resolve" produced the identical observation — a page from the general pass.
#
# Both directions are driven here, on their own sessions, because a miss that
# LOOKS like a success is the whole failure mode.
#
# The session id comes back in the global DISPATCH_SID rather than on stdout: a
# `SID=$(dispatch_run ...)` would run this in a subshell, where `fail`'s ✗ line and
# server-log dump land in SID instead of the terminal and its `exit 1` only leaves
# the subshell — so a broken run would read as a green test with a garbled id,
# after cleanup had already deleted the data dir out from under the servers.
dispatch_run() {   # $1 = suggested agent name, $2 = label; sets DISPATCH_SID
  curl -s -X POST -H 'content-type: application/json' \
    -d "{\"name\":\"$1\"}" "http://localhost:$OR_PORT/__suggest" >/dev/null
  local created st
  created=$(curl -s -X POST "${AUTH[@]}" "$BASE/sessions" \
    -F "images=@$png;filename=dispatch-001.png" -F 'config={"max_review_iterations":1}')
  DISPATCH_SID=$(echo "$created" | jq -r '.session_id')
  for i in $(seq 1 120); do
    st=$(curl -s "${AUTH[@]}" "$BASE/sessions/$DISPATCH_SID" | jq -r '.status')
    { [ "$st" = "ready_for_review" ] || [ "$st" = "failed" ]; } && break
    sleep 0.5
  done
  [ "$st" = "ready_for_review" ] \
    || fail "$2" "run ended $st: $(curl -s "${AUTH[@]}" "$BASE/sessions/$DISPATCH_SID" | jq -r .error)"
}

# (a) A name that DOES resolve: chartDataAgent.md is in the library.
dispatch_run "chartDataAgent" "specialist dispatch (hit)"; HIT=$DISPATCH_SID
hitlog=$(curl -s "${AUTH[@]}" "$BASE/sessions/$HIT/logs")
echo "$hitlog" | jq -e -s 'map(select(.type=="specialist_dispatched")) | length == 1' >/dev/null \
  && pass "a resolvable suggestion logs specialist_dispatched" \
  || fail "specialist dispatch" "no specialist_dispatched event: $(echo "$hitlog" | jq -c -s 'map(.type)')"
# It really ran, rather than just being logged: the merged fragment is in the output.
curl -s "${AUTH[@]}" "$BASE/sessions/$HIT/output" | grep -q 'Specialist fragment' \
  && pass "the dispatched specialist's fragment reached the document" \
  || fail "specialist dispatch" "merged fragment absent from output"

# (b) A name that does NOT resolve — the silent case.
dispatch_run "chart" "specialist dispatch (miss)"; MISS=$DISPATCH_SID
misslog=$(curl -s "${AUTH[@]}" "$BASE/sessions/$MISS/logs")
echo "$misslog" | jq -e -s 'map(select(.type=="specialist_unresolved")) | length == 1' >/dev/null \
  && pass "an unresolvable suggestion logs specialist_unresolved (was silent)" \
  || fail "specialist dispatch" "no specialist_unresolved event: $(echo "$misslog" | jq -c -s 'map(.type)')"
# The log must name what the model asked for AND what was available — that is what
# makes a near-miss ("chart" vs "chartDataAgent") diagnosable from one run.
missev=$(echo "$misslog" | jq -c -s 'map(select(.type=="specialist_unresolved")) | .[0]')
echo "$missev" | jq -e '.agent=="chart"' >/dev/null \
  && echo "$missev" | jq -e '.candidates | index("chartDataAgent") != null' >/dev/null \
  && pass "the miss names the requested agent and the available candidates" \
  || fail "specialist dispatch" "expected agent=chart and chartDataAgent among candidates, got $missev"
# And a miss must not be reported as a dispatch.
echo "$misslog" | jq -e -s 'map(select(.type=="specialist_dispatched")) | length == 0' >/dev/null \
  && pass "a miss is not logged as a dispatch" \
  || fail "specialist dispatch" "miss logged specialist_dispatched"
curl -s -X POST -H 'content-type: application/json' -d '{}' "http://localhost:$OR_PORT/__suggest" >/dev/null  # disarm

echo "==> 9e. a second upload WAITS in the run queue instead of starting a second pipeline"
# max_concurrent_runs=1 in the config above. Uploads used to `void runPipeline(...)`
# straight out of the handler, so two simultaneous uploads meant two unthrottled
# pipelines — two jsdom+axe instances and 2 x extraction_concurrency model calls in
# flight, on a machine PRD §10.1 says may be a laptop.
#
# No race here: the create handler enqueues synchronously and runPipeline sets
# status=running before returning to the queue, so by the time the FIRST 201 lands
# its run is already occupying the only slot. The second upload therefore must be
# waiting, not running.
qa=$(curl -s -X POST "${AUTH[@]}" "$BASE/sessions" \
  -F "images=@$png;filename=queue-a-001.png" \
  -F "images=@$png;filename=queue-a-002.png" \
  -F "images=@$png;filename=queue-a-003.png" \
  -F 'config={"max_review_iterations":1}')
QA=$(echo "$qa" | jq -r '.session_id')

# A feedback re-run is subject to the same cap, and its 202 must say what actually
# happened. Reporting "running" for a run still sitting in the queue would make a
# waiting session look hung to the only client that can see it.
fbq=$(curl -s -X POST "${AUTH[@]}" "$BASE/sessions/$SID/feedback" -H 'content-type: application/json' \
  -d '{"feedback":"Tighten the wording throughout."}')
echo "$fbq" | jq -e '.status=="queued"' >/dev/null \
  && pass "a feedback re-run at the cap reports queued, not running" \
  || fail "feedback queueing" "expected status=queued, got $fbq"
# And the STORED row must agree. A row saying "running" for a run still in the
# queue is what the polling client actually sees, so it is the one that matters —
# the 202 body is read once, the status endpoint is read every two seconds.
fbst=$(curl -s "${AUTH[@]}" "$BASE/sessions/$SID" | jq -r '.status')
[ "$fbst" = "queued" ] \
  && pass "the queued re-run's stored status is queued too" \
  || fail "feedback queueing" "GET /sessions/\$SID says '$fbst', expected queued"

qb=$(curl -s -X POST "${AUTH[@]}" "$BASE/sessions" \
  -F "images=@$png;filename=queue-b-001.png" -F 'config={"max_review_iterations":1}')
QB=$(echo "$qb" | jq -r '.session_id')
sa=$(curl -s "${AUTH[@]}" "$BASE/sessions/$QA" | jq -r '.status')
sb=$(curl -s "${AUTH[@]}" "$BASE/sessions/$QB" | jq -r '.status')
[ "$sa" = "running" ] && [ "$sb" = "queued" ] \
  && pass "second upload held at the cap (A=$sa, B=$sb)" \
  || fail "run queue" "expected A=running B=queued, got A=$sa B=$sb"

# Waiting must not mean dropped: both runs finish, in order.
await_session_ready() {
  for i in $(seq 1 120); do
    st=$(curl -s "${AUTH[@]}" "$BASE/sessions/$1" | jq -r '.status')
    [ "$st" = "ready_for_review" ] && return 0
    [ "$st" = "failed" ] && fail "$2" "run failed: $(curl -s "${AUTH[@]}" "$BASE/sessions/$1" | jq -r .error)"
    sleep 0.5
  done
  fail "$2" "stuck at $st"
}
await_session_ready "$QA" "queued run A"
await_session_ready "$QB" "queued run B"
# SID's queued feedback re-run too, so step 12 can still close it.
await_session_ready "$SID" "queued feedback re-run"
pass "all three queued runs completed (nothing dropped at the cap)"

# The wait is recorded in the waiting session's own run log — otherwise a session
# sitting behind someone else's 25-page PDF is indistinguishable from a hung one.
qlog=$(curl -s "${AUTH[@]}" "$BASE/sessions/$QB/logs")
qwait=$(echo "$qlog" | jq -c 'select(.type=="run_dequeued")' | tail -1 | jq -r '.waited_ms // -1')
qrunning=$(echo "$qlog" | jq -c 'select(.type=="run_queued")' | tail -1 | jq -r '.running // -1')
[ "$qwait" -gt 0 ] && [ "$qrunning" = "1" ] \
  && pass "the wait is visible in the run log (waited_ms=$qwait, running=$qrunning at submit)" \
  || fail "queue logging" "expected waited_ms>0 and running=1, got waited_ms=$qwait running=$qrunning"

# Only the flagged page's image reached the editor earlier; here the point is that
# the queue did not corrupt either document. B is single-page and must be complete.
qbout=$(curl -s "${AUTH[@]}" "$BASE/sessions/$QB/output")
echo "$qbout" | grep -q 'Page marker 1' \
  && pass "the queued run produced a complete document" \
  || fail "queued output" "$qbout"

echo "==> 10. ownership isolation (other endpoints reject unknown id)"
code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$BASE/sessions/ses_doesnotexist")
[ "$code" = "404" ] && pass "unknown session => 404" || fail "isolation" "got $code"

echo "==> 11. GET /v1/sessions (list)"
list=$(curl -s "${AUTH[@]}" "$BASE/sessions")
echo "$list" | jq -e --arg sid "$SID" '.sessions | map(.session_id) | index($sid) != null' >/dev/null \
  && pass "session appears in list" || fail "list" "$list"

echo "==> 11b. paginating GET /v1/sessions visits every session exactly once"
# The list used to page on `created_at` alone. That is a millisecond timestamp, so
# a burst of uploads ties on it, and at a page boundary inside a tie the old query
# both skipped rows (`created_at < ?` drops the rest of the tied group) and could
# repeat them (nothing pinned the order among ties).
#
# Fire the burst in parallel and walk one row per page, so every boundary lands
# inside it. Whether a tie ACTUALLY occurs is up to the machine — the count is
# printed rather than asserted, since a run that produced none has still proved
# the walk is complete, just not the tie-breaking specifically. The tie case is
# pinned deterministically in test/pagination.test.ts, which forges the
# timestamps; this step's job is to prove the real wire cursor round-trips
# through HTTP at all, which no unit test covers.
burst=()
for n in 1 2 3 4 5; do
  curl -s -X POST "${AUTH[@]}" "$BASE/sessions" \
    -F "images=@$png;filename=page-burst-$n.png" -F 'config={"max_review_iterations":1}' >/dev/null &
  burst+=("$!")
done
# Wait on THESE pids only. A bare `wait` would also wait on the mock services and
# the Iris server — they were started with `&` in this same shell and never exit,
# so it would hang the script forever.
for p in "${burst[@]}"; do wait "$p"; done
# Reference set: one unpaged request (limit is capped at 100, well above what this
# script creates).
all=$(curl -s "${AUTH[@]}" "$BASE/sessions?limit=100" | jq -r '.sessions[].session_id' | sort)
ties=$(curl -s "${AUTH[@]}" "$BASE/sessions?limit=100" \
  | jq '[.sessions[].created_at] | length - (unique | length)')
# Walk with limit=1, following next_cursor exactly as a client would.
walked=""
cursor=""
for i in $(seq 1 40); do
  if [ -z "$cursor" ]; then
    pg=$(curl -s "${AUTH[@]}" "$BASE/sessions?limit=1")
  else
    pg=$(curl -s "${AUTH[@]}" --get --data-urlencode "cursor=$cursor" "$BASE/sessions?limit=1")
  fi
  walked="$walked$(echo "$pg" | jq -r '.sessions[].session_id')
"
  cursor=$(echo "$pg" | jq -r '.next_cursor // empty')
  [ -z "$cursor" ] && break
done
if [ -n "$cursor" ]; then fail "pagination" "did not terminate after 40 pages"; fi
walked_sorted=$(echo "$walked" | grep -v '^$' | sort)
[ "$walked_sorted" = "$all" ] \
  && pass "one-at-a-time pagination saw every session once ($(echo "$all" | wc -l | tr -d ' ') rows, $ties timestamp ties)" \
  || fail "pagination" "walked pages differ from the unpaged list:
$(diff <(echo "$all") <(echo "$walked_sorted") || true)"
# No duplicates even if the sets happened to match by luck.
dupes=$(echo "$walked_sorted" | uniq -d)
[ -z "$dupes" ] && pass "no session was returned on two pages" \
  || fail "pagination" "duplicated across pages: $dupes"
# A cursor that is not one is a 400, not a silent restart. The old code compared
# the raw string, so `cursor=hello` matched every row and handed back page one —
# a client following next_cursor would page forever.
#
# Every value below string-sorts ABOVE the stored `2026-…` timestamps, so each one
# reproduces that bug if it gets through. The last two are the ones that matter in
# practice: both PARSE as dates — they are legitimate ISO-8601 for a real instant —
# and are what a client that reformats a timestamp sends (milliseconds dropped, or
# a UTC offset instead of Z). "Date.parse succeeded" is not the same question as
# "this string is comparable to that column".
for bad in hello 9999 '2026-05-22T18:00:00Z' '2026-05-22T19:00:00.000+01:00'; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" --get \
    --data-urlencode "cursor=$bad" "$BASE/sessions")
  [ "$code" = "400" ] \
    || fail "pagination" "expected 400 for cursor='$bad', got $code (it would restart at page one)"
done
pass "cursors that are not this column's format are rejected (400), including ones that parse as dates"
# The real cursor still works, obviously — the check above must not be so strict it
# rejects what the endpoint itself issues.
realc=$(curl -s "${AUTH[@]}" "$BASE/sessions?limit=1" | jq -r '.next_cursor')
code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" --get \
  --data-urlencode "cursor=$realc" "$BASE/sessions?limit=1")
[ "$code" = "200" ] && pass "the endpoint's own next_cursor is accepted (200)" \
  || fail "pagination" "the API rejected its own cursor '$realc' with $code"
# Every unusable limit gets the SAME answer: the default. Written as
# `Math.max(parseInt(x) || 20, 1)` this was two rules — 0 is falsy so it became 20,
# while -1 clamped to 1 — i.e. two equally invalid values twenty-fold apart. There are
# 9 sessions by now, so the default (20) and the clamp (1) are distinguishable.
# Compared against the no-limit-param response rather than a hardcoded 20, so this does
# not break if the session count later exceeds the default page size.
deflt=$(curl -s "${AUTH[@]}" "$BASE/sessions" | jq '.sessions | length')
[ "$deflt" -gt 1 ] || fail "pagination" "need >1 session to tell the default from a clamp (got $deflt)"
for bad in 0 -1 -100 abc ''; do
  n=$(curl -s "${AUTH[@]}" --get --data-urlencode "limit=$bad" "$BASE/sessions" | jq '.sessions | length')
  [ "$n" = "$deflt" ] \
    || fail "pagination" "limit='$bad' returned $n rows; the default returns $deflt (two rules, not one)"
done
# A fractional limit truncates to a usable size rather than defaulting — 2.7 -> 2.
n=$(curl -s "${AUTH[@]}" "$BASE/sessions?limit=2.7" | jq '.sessions | length')
[ "$n" = "2" ] || fail "pagination" "limit=2.7 returned $n rows, expected 2"
pass "every unusable limit falls back to the default rather than clamping to 1 ($deflt rows)"
# ...and it survives percent-encoding, which is how a correct client sends it: a raw
# `|` is not a legal query character per RFC 3986, so a strict URI type or proxy will
# encode it (or refuse). Sent as a literal %7C rather than via --data-urlencode, to
# prove the server decodes it rather than only tolerating the raw form.
enc=${realc//|/%7C}
code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$BASE/sessions?limit=1&cursor=$enc")
[ "$code" = "200" ] && pass "a percent-encoded cursor (%7C) is accepted (200)" \
  || fail "pagination" "the API rejected its own percent-encoded cursor '$enc' with $code"
# A rejected cursor is echoed so the 400 is diagnosable, but truncated. Asserting
# BOUNDEDNESS rather than a length threshold: a 10x longer input must not produce a
# longer message, which is the actual property (the reflected value is unbounded
# client input). The length is still reported, so the client can see it was the input
# and not the truncation that was wrong.
# Both inputs are 4-digit lengths (1000 and 9000) so the messages must come out
# EXACTLY equal: the only part that varies with the input is the reported length, and
# "(1000 chars)" and "(9000 chars)" are the same width. Comparing 500 to 5000 instead
# leaves a legitimate one-character difference and makes the assertion look broken.
# (Plain variables, not an associative array — macOS ships bash 3.2.)
len_a=""; len_b=""
for n in 1000 9000; do
  long=$(printf 'x%.0s' $(seq 1 "$n"))
  msg=$(curl -s "${AUTH[@]}" --get --data-urlencode "cursor=$long" "$BASE/sessions" | jq -r '.error.message')
  echo "$msg" | grep -q "($n chars)" \
    || fail "pagination" "a $n-char cursor's 400 should report its length, got: $msg"
  [ -z "$len_a" ] && len_a=${#msg} || len_b=${#msg}
done
[ "$len_a" = "$len_b" ] \
  && pass "an overlong cursor's 400 echo is bounded ($len_a chars for both a 1000- and a 9000-char input)" \
  || fail "pagination" "the echoed cursor is not bounded: $len_a vs $len_b chars"

echo "==> 12. POST /v1/sessions/{id}/close (finalize + clean tmp; no PRs)"
close=$(curl -s -X POST "${AUTH[@]}" "$BASE/sessions/$SID/close")
echo "$close" | jq -e '.status=="closed"' >/dev/null && pass "session closed" || fail "close" "$close"
[ ! -d "$DATA/tmp/$SID" ] && pass "tmp/ cleaned on close" || fail "tmp cleanup" "tmp dir still present"

echo "==> 12b. a tmp tree that cannot be removed still closes the session"
# The close handler claims the session (status -> closed) BEFORE the cleanup, so
# the cleanup must not be able to throw: after the claim there is no way back to
# ready_for_review, and a 500 here would leave the client unable to retry (the
# guard answers 409) with the tmp tree orphaned anyway. `force: true` does not
# cover this — it suppresses ENOENT only, and an unwritable subdirectory whose
# child cannot be unlinked gives ENOTEMPTY.
#
# QB is a completed, still-open session left over from step 9e.
qbtmp="$DATA/tmp/$QB/agents"
if [ -d "$qbtmp" ]; then
  touch "$qbtmp/undeletable.md"
  chmod 0500 "$qbtmp"
  qbclose=$(curl -s -X POST "${AUTH[@]}" "$BASE/sessions/$QB/close")
  chmod 0700 "$qbtmp"   # restore so the harness's own cleanup works
  echo "$qbclose" | jq -e '.status=="closed"' >/dev/null \
    && pass "close survives an unremovable tmp tree (no 500, session still closed)" \
    || fail "close cleanup" "expected status=closed, got: $qbclose"
  qbst=$(curl -s "${AUTH[@]}" "$BASE/sessions/$QB" | jq -r '.status')
  [ "$qbst" = "closed" ] && pass "the stored status is closed despite the failed cleanup" \
    || fail "close cleanup" "GET says '$qbst', expected closed"
else
  fail "close cleanup" "expected a tmp tree for $QB at $qbtmp"
fi

echo "==> 13. close again => 409 invalid_state"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${AUTH[@]}" "$BASE/sessions/$SID/close")
[ "$code" = "409" ] && pass "re-close rejected (409)" || fail "re-close" "got $code"

echo ""
echo "ALL ENDPOINTS PASSED ✅"
