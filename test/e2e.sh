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
# Shared secret for GET /v1/quality (step 11c). Not a GitHub token — that endpoint
# is the one that does not use the per-user auth, because it returns an aggregate
# belonging to no user and its real caller is a CI job.
QUALITY_TOKEN=e2e-quality-token

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
  # The quality tally is off unless a token is set (it 404s otherwise), and step
  # 11c needs it on. Written literally rather than via \${IRIS_QUALITY_TOKEN} so
  # the test does not depend on the caller's environment.
  quality_token: $QUALITY_TOKEN
  # A whole test run is one client from one address (issue #102): this script creates ~11
  # sessions and polls twice a second throughout, which is nothing for a deployment but
  # sits right on the DEFAULT upload budget of 12/minute when the mocks make runs finish
  # in seconds. Raised rather than switched off, so what these steps exercise is still the
  # real limiter — and \`auth_per_minute\` is deliberately left SMALL, because the device
  # flow above is the last authentication this script performs, which makes /v1/auth the
  # one budget it can exhaust on purpose to prove a refusal (step 3b).
  rate_limits:
    general_per_minute: 6000
    upload_per_minute: 600
    auth_per_minute: 10
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

echo "==> 1b. GET /v1/limits (what an upload may be, no token)"
# Deliberately WITHOUT "${AUTH[@]}": the browser app states the file limits on its
# upload step, where the visitor has not signed in yet, so this endpoint sits above
# the auth middleware. Step 2 establishes that everything else 401s.
#
# Asserted as a shape, not as today's numbers — every value here is resolved from the
# configured model and provider, and this run's config is not the deployment's. What
# must hold is that the byte limit is a usable positive number, that the format list
# is the one the upload validator uses (PNG is in it, TIFF is not — TIFF was
# advertised for months and the model has never read it), and that `hint` is present,
# since the demo renders it verbatim rather than composing its own sentence.
limits=$(curl -s "$BASE/limits")
echo "$limits" | jq -e '.image.max_bytes > 0 and (.image.hint|type=="string") and (.image.hint|length > 0)' >/dev/null \
  && pass "upload limits published ($(echo "$limits" | jq -r '.image.max_bytes') bytes/image)" \
  || fail "limits" "expected a positive max_bytes and a hint, got $limits"
echo "$limits" | jq -e '(.image.media_types|index("image/png")) and (.image.media_types|index("image/tiff")|not)' >/dev/null \
  && pass "format list matches what the model reads" || fail "limits formats" "$limits"
# The page cap the same request must also answer, because a client deciding whether to
# send a 40-page PDF needs both numbers and should not have to guess one.
echo "$limits" | jq -e '.max_pages > 0 and .max_pages == .pdf.max_pages' >/dev/null \
  && pass "page cap published ($(echo "$limits" | jq -r '.max_pages') pages)" || fail "limits pages" "$limits"
# And how often a client may ask, plus what one request may carry (issue #102). Same
# rationale as the file limits: a budget a client can read is one it can pace itself
# against instead of discovering by being refused.
echo "$limits" | jq -e '.rate_limits.general_per_minute > 0 and .rate_limits.window_seconds > 0
  and .upload.max_request_bytes > 0 and .upload.max_files > 0' >/dev/null \
  && pass "request budget published ($(echo "$limits" | jq -r '.rate_limits.general_per_minute')/min)" \
  || fail "limits rate" "$limits"
# The header on a real response, which is the only thing here that can see the limiter is
# actually MOUNTED. Everything above reads config; a limiter left out of src/index.ts
# would publish the same body and bound nothing.
curl -si "$BASE/limits" | grep -qi '^ratelimit:' \
  && pass "responses carry the remaining budget" || fail "ratelimit header" "no RateLimit header on /v1/limits"
# …and the liveness probe deliberately does NOT, because a probe that can be refused
# reports a healthy deployment as down.
curl -si "$BASE/health" | grep -qi '^ratelimit:' \
  && fail "health exempt" "the liveness probe is behind the rate limiter" \
  || pass "liveness probe is not rate limited"

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

# Iris requests NO scope: it authenticates as a GitHub App, whose `issues: write`
# comes from installing the app on `upstream_repo` rather than from the user. This is
# invisible from the client — the flow succeeds whatever is requested — and a scope
# added back would be silently ignored by GitHub rather than breaking anything, so
# nothing but this assertion would notice the service going back to asking every user
# for account-wide access to their public repos.
#
# `.recorded` is asserted alongside `.present`: "the body carried no scope" and "the
# route was never hit" would otherwise be the same answer, so this assertion — the only
# thing standing between the repo and a silently reintroduced scope — could pass
# vacuously if the service stopped starting the flow at all.
scope=$(curl -s "http://localhost:$GH_PORT/__last_device_scope")
echo "$scope" | jq -e '.recorded==true and .present==false' >/dev/null \
  && pass "the device flow requested no scope (and a request was actually recorded)" \
  || fail "oauth scope" "expected a recorded device-flow body carrying no scope, got $scope"

echo "==> 3b. the request budget is enforced, not just published (issue #102)"
# Step 1b proved the limiter is mounted and publishes headers; this proves it REFUSES, in
# the documented shape, through the real stack. /v1/auth is the endpoint to do it on: it
# holds the strict budget (auth_per_minute: 10 in the config above), the login just above
# is the last authentication this script performs, and every request there would otherwise
# cost an outbound call to GitHub — which is the reason the limit exists.
code=""
for i in $(seq 1 12); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/github/device")
  [ "$code" = "429" ] && break
done
[ "$code" = "429" ] && pass "auth budget enforced after $i requests" \
  || fail "auth limit" "expected a 429 within 12 requests to /v1/auth, got $code"
# And the refusal is an Iris error with a retry hint rather than the library's default
# plain-text body — a client that cannot parse a refusal cannot pace itself.
refusal=$(curl -si -X POST "$BASE/auth/github/device")
echo "$refusal" | grep -qi '^retry-after:' \
  && echo "$refusal" | tail -1 | jq -e '.error.code=="rate_limited" and .error.details.retry_after_seconds > 0' >/dev/null \
  && pass "429 carries Retry-After and an Iris error body" \
  || fail "auth limit shape" "expected Retry-After and an Iris rate_limited body, got: $refusal"

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
# The `config` part below is deliberately stale: the per-request
# max_review_iterations override was removed, and a client still sending one must
# be served at the deployment's cap (1, from the config above) rather than
# rejected — or told it got the 5 rounds it asked for.
create=$(curl -s -X POST "${AUTH[@]}" "$BASE/sessions" \
  -F "images=@$png;filename=page-001.png" \
  -F "images=@$png;filename=page-002.png" \
  -F "images=@$png;filename=page-003.png" \
  -F 'config={"max_review_iterations":5}')
SID=$(echo "$create" | jq -r '.session_id')
echo "$create" | jq -e '.status=="queued" and .image_count==3' >/dev/null \
  && pass "session created: $SID" || fail "create" "$create"
capped=$(curl -s "${AUTH[@]}" "$BASE/sessions/$SID")
echo "$capped" | jq -e '.iterations_max==1' >/dev/null \
  && pass "a stale config part is ignored, not honored (iterations_max=1)" \
  || fail "config ignored" "$capped"

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

echo "==> 7b. GET /v1/stats (public tally, no token)"
# Deliberately WITHOUT "${AUTH[@]}": this endpoint is mounted above the auth
# middleware so the browser app can show the tally to a visitor who has not signed
# in, and step 2 has already established that everything else 401s without a token.
# Exactly one 3-page session has completed at this point.
#
# The count is asserted only here, not again after the feedback rounds below: the
# route caches its answer for 60s, so a second call inside this run is served from
# that cache and would assert nothing. That the tally does not double-count a
# re-run — or dip while one is in flight — is covered in test/stats.test.ts against
# the store, where the clock is not in the way.
stats=$(curl -s "$BASE/stats")
echo "$stats" | jq -e '.pages_processed==3 and .documents_processed==1 and (.since|type=="string")' >/dev/null \
  && pass "public tally: $(echo "$stats" | jq -r '.pages_processed') pages, $(echo "$stats" | jq -r '.documents_processed') document" \
  || fail "stats" "expected 3 pages / 1 document / a since timestamp, got $stats"
# Aggregate only. The response is unauthenticated, so a session id, a login or a
# user id appearing in it is a leak, and it would be an easy one to introduce by
# widening the query behind it.
echo "$stats" | jq -e 'has("session_id") or has("sessions") or has("github_login") or has("github_user_id") | not' >/dev/null \
  && pass "tally carries no per-user or per-session detail" || fail "stats shape" "$stats"
# The quality half, end to end, on the case every new deployment is in: one document
# is far below PUBLIC_QUALITY_MIN_DOCUMENTS, so the honest answer is to say nothing.
# The field has to be PRESENT and null — the demo page distinguishes "too few
# documents to say" from an older server that has no such field at all — and the
# floor has to hold through the real store and the real route, not only in the unit
# test that calls the store directly.
echo "$stats" | jq -e 'has("quality") and .quality==null' >/dev/null \
  && pass "quality stays silent below the document floor" \
  || fail "stats quality" "expected quality:null on a one-document deployment, got $stats"

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
#
# Both of these read the main session unless LSID names another one — step 9e runs a
# multi-round session of its own (a document that loses a page must not corrupt the one
# every later step asserts against) and needs the same waiting and log reading.
await_ready() {
  local sid=${LSID:-$SID}
  for i in $(seq 1 60); do
    status=$(curl -s "${AUTH[@]}" "$BASE/sessions/$sid" | jq -r '.status')
    [ "$status" = "ready_for_review" ] && return 0
    [ "$status" = "failed" ] && fail "$1" "run failed: $(curl -s "${AUTH[@]}" "$BASE/sessions/$sid" | jq -r .error)"
    sleep 0.5
  done
  fail "$1" "stuck at $status"
}
# Reads the last-logged value of a field from a given run-log event type. The logs
# endpoint is ndjson, so filter line-by-line rather than slurping one document.
log_field() {
  curl -s "${AUTH[@]}" "$BASE/sessions/${LSID:-$SID}/logs" \
    | jq -c --arg t "$1" 'select(.type==$t)' | tail -1 | jq -r --arg f "$2" ".[\$f] // \"none\""
}
# The same, for a field whose value is an array (compact, so it can be compared as a
# string): `jq -r` prints an array across several lines.
log_json() {
  curl -s "${AUTH[@]}" "$BASE/sessions/${LSID:-$SID}/logs" \
    | jq -c --arg t "$1" --arg f "$2" 'select(.type==$t) | .[$f] // "none"' | tail -1
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
  -F "images=@$png;filename=trunc-001.png")
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

echo "==> 9g. one page failing is a hole the document admits, and a later round fills it"
# The other side of 9d: when SOME pages produced content, ending the run throws away
# every page that worked (issue #135), so the run finishes and the page it lost is
# reported instead — in the document, in the run log, and in diagnostics.
#
# Driven over three rounds on a session of its own, because the part that regressed is
# not the containment but the WIRING that carries the set across rounds: the set is a
# property of the document, it lives in final.json, and the one report a Copy Editor
# round cannot delete is the copy wrapDocument re-states after the loop.
curl -s -X POST -H 'content-type: application/json' -d '{"page":2}' \
  "http://localhost:$OR_PORT/__fail-page" >/dev/null
pcreate=$(curl -s -X POST "${AUTH[@]}" "$BASE/sessions" \
  -F "images=@$png;filename=page-001.png" \
  -F "images=@$png;filename=page-002.png" \
  -F "images=@$png;filename=page-003.png")
PSID=$(echo "$pcreate" | jq -r '.session_id')
LSID=$PSID
await_ready "run with one failed page"
pout=$(curl -s "${AUTH[@]}" "$BASE/sessions/$PSID/output")
echo "$pout" | grep -q 'Page marker 1' && echo "$pout" | grep -q 'Page marker 3' \
  && pass "the pages that worked were delivered rather than discarded with the run" \
  || fail "containment" "$(echo "$pout" | grep -o 'Page marker [0-9]*' | tr '\n' ',')"
echo "$pout" | grep -q '@page-failed 2' \
  && pass "the document says which page it has no content for" \
  || fail "page marker" "$pout"
pfailed=$(curl -s "${AUTH[@]}" "$BASE/sessions/$PSID/diagnostics" | jq -c '.pages_failed')
[ "$pfailed" = "[2]" ] && pass "diagnostics reports the missing page (pages_failed=$pfailed)" \
  || fail "pages_failed" "expected [2], got $pfailed"
[ "$(log_json run_complete failed_pages)" = "[2]" ] \
  && pass "the run's own completion line names it, not just the per-page event" \
  || fail "run_complete" "failed_pages=$(log_json run_complete failed_pages)"

# A round that rewrites the whole document: the Copy Editor is handed the body and
# returns its own, so the in-fragment comment is gone — and the mock editor's HTML
# claims all three pages. Only the copy wrapDocument re-states after the loop can
# still say otherwise, and it can only do that if the set survived final.json.
fb=$(curl -s -X POST "${AUTH[@]}" "$BASE/sessions/$PSID/feedback" -H 'content-type: application/json' \
  -d '{"feedback":"The headings need a copy-edit pass."}')
echo "$fb" | jq -e '.status=="running"' >/dev/null || fail "feedback" "$fb"
await_ready "copy-edit round on a partial document"
[ "$(log_field feedback_scoped target)" = "document" ] || fail "scope" "expected the review-only path"
pout2=$(curl -s "${AUTH[@]}" "$BASE/sessions/$PSID/output")
echo "$pout2" | grep -q 'This document is incomplete' && echo "$pout2" | grep -q '@page-failed 2' \
  && pass "a second round cannot deliver a document that claims to be whole" \
  || fail "durable marker" "$pout2"
pfailed=$(curl -s "${AUTH[@]}" "$BASE/sessions/$PSID/diagnostics" | jq -c '.pages_failed')
[ "$pfailed" = "[2]" ] && pass "and the page is still reported missing a round later" \
  || fail "pages_failed" "expected [2], got $pfailed"

# Re-extracting the page is the one thing that fills the hole.
curl -s -X POST -H 'content-type: application/json' -d '{"page":null}' \
  "http://localhost:$OR_PORT/__fail-page" >/dev/null
fb=$(curl -s -X POST "${AUTH[@]}" "$BASE/sessions/$PSID/feedback" -H 'content-type: application/json' \
  -d '{"feedback":"The revenue figure was misread on page 2 — check it against the source."}')
echo "$fb" | jq -e '.status=="running"' >/dev/null || fail "feedback" "$fb"
await_ready "recovery round"
[ "$(log_field feedback_scoped target)" = "extraction" ] || fail "scope" "expected the re-extraction path"
pout3=$(curl -s "${AUTH[@]}" "$BASE/sessions/$PSID/output")
echo "$pout3" | grep -q 'Page marker 2' && ! echo "$pout3" | grep -q '@page-failed' \
  && ! echo "$pout3" | grep -q 'This document is incomplete' \
  && pass "the recovered page is in the document, which stops admitting a hole" \
  || fail "recovery" "$pout3"
# The mock marks a page "Revised." when the prompt carried a previous output. A page with
# no content has none worth carrying — its fragment is the failure comment, and handing
# that back asks the agent to preserve a note about a truncated response as if it were
# the page.
! echo "$pout3" | grep -q 'Revised' \
  && pass "the lost page was re-extracted from the image, not from its own failure note" \
  || fail "recovery input" "$(echo "$pout3" | grep -o 'Page marker [0-9]*[^<]*')"
[ "$(log_json page_recovered pages)" = "[2]" ] \
  && pass "the recovery is logged, so the earlier failure is not the log's last word" \
  || fail "page_recovered" "pages=$(log_json page_recovered pages)"
pfailed=$(curl -s "${AUTH[@]}" "$BASE/sessions/$PSID/diagnostics" | jq -c '.pages_failed')
[ "$pfailed" = "[]" ] && pass "diagnostics no longer reports a page the document now has" \
  || fail "pages_failed" "expected [], got $pfailed"
[ "$(log_json run_complete failed_pages)" = '"none"' ] \
  && pass "and the whole run's completion line says nothing about failed pages" \
  || fail "run_complete" "failed_pages=$(log_json run_complete failed_pages)"
LSID=""

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
    -F "images=@$png;filename=dispatch-001.png")
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

echo "==> 9h. training that dies does not take a delivered document with it"
# The training a feedback round triggers — classify the correction, propose a prompt
# change, gate it against the agent's fixtures — runs AFTER the session is marked
# ready_for_review, because none of it can change the document and all of it is slow
# (a classify call, a train call, then the candidate run against the agent's fixtures
# twice over). What that ordering has to guarantee is this: a provider error in there
# is not the user's problem. It used to be — the same failure marked a session `failed`
# whose output.html was on disk and whose Reader had signed it off.
#
# On a session of its own, and with feedback that actually CHANGES the document: both
# training steps return early when a round leaves the body untouched, so a no-op round
# would test nothing.
tcreate=$(curl -s -X POST "${AUTH[@]}" "$BASE/sessions" \
  -F "images=@$png;filename=page-001.png" \
  -F "images=@$png;filename=page-002.png")
TSID=$(echo "$tcreate" | jq -r '.session_id')
LSID=$TSID
await_ready "session for the training-failure round"
curl -s -X POST -H 'content-type: application/json' \
  -d '{"fail":true}' "http://localhost:$OR_PORT/__fail-training" >/dev/null
fb=$(curl -s -X POST "${AUTH[@]}" "$BASE/sessions/$TSID/feedback" -H 'content-type: application/json' \
  -d '{"feedback":"The headings need a copy-edit pass."}')
echo "$fb" | jq -e '.status=="running"' >/dev/null && pass "feedback re-run accepted (training armed to fail)" \
  || fail "training failure" "$fb"
await_ready "re-run whose training fails"
pass "the session still reached ready_for_review"
# The document is served, not withheld.
outT=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$BASE/sessions/$TSID/output")
[ "$outT" = "200" ] && pass "the document is still served (200)" \
  || fail "training failure" "expected 200 from /output, got $outT"
# The session is ready while the training is STILL RUNNING — that is the whole point of
# the ordering — so the round's own terminal line is what says the training is over.
# Reading the log the moment /sessions/{id} says ready catches it mid-flight.
for i in $(seq 1 60); do
  completes=$(curl -s "${AUTH[@]}" "$BASE/sessions/$TSID/logs" | jq -s 'map(select(.type=="run_complete")) | length')
  [ "$completes" -ge 2 ] && break
  sleep 0.5
done
[ "$completes" -ge 2 ] || fail "training failure" "the feedback round never logged run_complete ($completes seen)"
pass "the round finished after the session was already ready"
# The failure is recorded rather than swallowed: a training step that quietly stopped
# running would look exactly like one that had nothing to propose.
tlog=$(curl -s "${AUTH[@]}" "$BASE/sessions/$TSID/logs")
echo "$tlog" | jq -e -s 'map(select(.type=="feedback_training_failed")) | length >= 1' >/dev/null \
  && pass "the training failure is in the run log" \
  || fail "training failure" "expected feedback_training_failed; saw: $(echo "$tlog" | jq -r .type | sort -u | tr '\n' ' ')"
# The round's terminal line is written after its training, so a run's recorded duration
# still covers the slot it held (diagnostics measures a finished run up to run_complete).
echo "$tlog" \
  | jq -e -s '(map(.type) | rindex("run_complete")) > (map(.type) | rindex("feedback_training_failed"))' >/dev/null \
  && pass "run_complete is logged after the training, not before it" \
  || fail "training failure" "run_complete precedes the training in the log"
curl -s -X POST -H 'content-type: application/json' \
  -d '{"fail":false}' "http://localhost:$OR_PORT/__fail-training" >/dev/null  # disarm
LSID=$SID

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
  -F "images=@$png;filename=queue-a-003.png")
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
  -F "images=@$png;filename=queue-b-001.png")
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
    -F "images=@$png;filename=page-burst-$n.png" >/dev/null &
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

echo "==> 11c. GET /v1/quality (the tally the weekly quality-report workflow reads)"
# Placed here, after several documents have been through the real pipeline, because
# that is the only thing this check can do that a unit test cannot: prove the run
# signals are actually WRITTEN by a real run. test/quality.test.ts covers what the
# numbers mean and test/quality-route.test.ts covers the guard, both against a store
# seeded by hand — neither would notice if the orchestrator stopped calling
# recordRunSignals, which is a silent failure that makes the tally read BETTER.
QAUTH=(-H "Authorization: Bearer $QUALITY_TOKEN")

# The guard first. This endpoint is not behind the auth middleware every other one
# uses, so its shared secret is the only thing in front of it.
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/quality")
[ "$code" = "401" ] && pass "no token => 401" || fail "quality" "unauthenticated request got $code, expected 401"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer wrong-token" "$BASE/quality")
[ "$code" = "401" ] && pass "wrong token => 401" || fail "quality" "wrong token got $code, expected 401"
# A user's GitHub token must NOT work here. It is a valid bearer token for every
# other endpoint, so accepting it would be an easy mistake to make and an invisible
# one — the workflow would keep working either way.
code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$BASE/quality")
[ "$code" = "401" ] && pass "a valid GitHub token is not a quality token (401)" \
  || fail "quality" "a GitHub token was accepted on /quality ($code)"

q=$(curl -s "${QAUTH[@]}" "$BASE/quality")
# `!= null` rather than truthiness: `documents` is 0 on a deployment that has
# converted nothing, and 0 is falsy in jq, so `.documents and …` would report a
# perfectly good empty tally as a malformed response.
echo "$q" | jq -e '.documents != null and .window_days != null' >/dev/null \
  && pass "tally returned: $(echo "$q" | jq -c '{documents, mean_rounds, unresolved_rate, rules: (.rules | length)}')" \
  || fail "quality" "$q"

# The denominator is the whole design: a clean run writes no violation rows, so
# every document that reached ready_for_review must be counted here whether or not
# anything was wrong with it. If this is 0 while the runs above succeeded, the
# orchestrator is not recording signals at all.
docs=$(echo "$q" | jq -r '.documents')
[ "$docs" -ge 1 ] \
  && pass "the completed runs are in the denominator ($docs document(s))" \
  || fail "quality" "documents=$docs after successful runs — recordRunSignals is not being called"
# ...and the rule table's own denominator, which counts only the documents axe-core
# actually examined (#164). It can be smaller than `documents` but never larger, and
# never absent: a missing key here would make every rule share divide by zero.
echo "$q" | jq -e '.documents_linted != null and .documents_linted >= 0 and .documents_linted <= .documents' >/dev/null \
  && pass "documents_linted is $(echo "$q" | jq -r '.documents_linted'), within 0..$docs" \
  || fail "quality" "documents_linted=$(echo "$q" | jq -r '.documents_linted') against documents=$docs"
# A round is an EDITOR pass, not a reader pass: the loop returns as soon as the
# Reader finds nothing, before incrementing, so a document that comes back clean on
# the first look completes with 0 rounds and that is the good outcome. The mock model
# here produces exactly that. What must hold is that 0 is a recorded 0 and not a
# missing row — `null` means nothing was recorded at all — and that the mean cannot
# exceed the cap this config set (1), which would mean rounds are being double-counted.
echo "$q" | jq -e '.mean_rounds != null and .mean_rounds >= 0 and .mean_rounds <= 1' >/dev/null \
  && pass "mean_rounds is $(echo "$q" | jq -r '.mean_rounds'), within 0..max_review_iterations" \
  || fail "quality" "mean_rounds=$(echo "$q" | jq -r '.mean_rounds'), expected a number in 0..1"
echo "$q" | jq -e '.since != null' >/dev/null && pass "since is set" \
  || fail "quality" "since is null despite $docs document(s)"

# Nothing per-session, per-user or per-document. This is the constraint that matters
# most, because the consumer copies these values into a PUBLIC issue and the
# documents are user uploads. Checked against the real session id and login the run
# above actually used, not a placeholder.
# (`if`, not `grep … && fail`: under `set -e` a grep that finds nothing would fail
# the AND-list and kill the script, turning "no leak" into a broken run.)
for secret in "$SID" "$TOKEN"; do
  if echo "$q" | grep -qF "$secret"; then
    fail "quality" "the tally leaked '$secret' — see the constraint in src/routes/quality.ts"
  fi
done
# Then the whole key set, so a field ADDED later has to be justified here rather than
# shipped to a public issue by whoever adds it. Set subtraction rather than `inside`:
# `inside` compares strings with `contains`, i.e. substring containment, so
# `["doc"] | inside(["documents"])` is true and any new leaf whose name happens to be a
# substring of an allowed one would slip through the one check that enforces this.
allowed='["window_days","documents","since","mean_rounds","unresolved_rate","review_unread_rate","links_dropped_rate","lint_error_rate","documents_linted","editor_truncated_rate","editor_truncated_lost_rate","id","impact","share","nodes"]'
extra=$(echo "$q" | jq -c --argjson allowed "$allowed" '([paths(scalars) | last] | unique) - $allowed')
[ "$extra" = "[]" ] \
  && pass "the payload's key set is exactly the documented one (no session id, login or document content)" \
  || fail "quality" "unexpected field(s) in the tally: $extra"

# The window is echoed back clamped, so a caller reads what it got rather than what
# it asked for — the workflow prints this number in a public issue.
echo "$q" | jq -e '.window_days == 30' >/dev/null && pass "default window is 30 days" \
  || fail "quality" "default window_days=$(echo "$q" | jq -r '.window_days')"
w=$(curl -s "${QAUTH[@]}" "$BASE/quality?days=9999" | jq -r '.window_days')
[ "$w" = "365" ] && pass "an out-of-range window is clamped (9999 => 365)" \
  || fail "quality" "days=9999 gave window_days=$w, expected 365"
w=$(curl -s "${QAUTH[@]}" "$BASE/quality?days=nonsense" | jq -r '.window_days')
[ "$w" = "30" ] && pass "a garbled window falls back to the default rather than 400ing a weekly job" \
  || fail "quality" "days=nonsense gave window_days=$w, expected 30"
# Gated by a secret, so it must never be shared-cached — unlike /v1/stats, which is
# public and sets max-age=60.
curl -si "${QAUTH[@]}" "$BASE/quality" | grep -qi '^cache-control: no-store' \
  && pass "Cache-Control: no-store" || fail "quality" "the response is missing Cache-Control: no-store"

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
