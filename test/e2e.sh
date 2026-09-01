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
  # Three overrides that all resolve to the same mock model, so none of them changes what
  # this script exercises. They are here for the boot check in step 1a, one per way a key
  # can be judged: \`reader\` is dispatched from a call site, \`chartDataAgent\` is routable
  # only because a file of that name is in \`agents_dir\`, and \`table\` is neither. Nothing
  # else distinguishes them — same provider, same model, no error, no log line, nothing in
  # \`by_agent\` — which is the defect this is guarding. The specialist earns its line: it
  # is what fails if the boot check is handed some other readable directory.
  per_agent:
    reader: openrouter
    chartDataAgent: openrouter
    table: openrouter
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

echo "==> 1a. a per_agent key naming no agent is reported at boot"
# The config above puts `table:` under `providers.per_agent`. Nothing dispatches that name,
# so `resolveAgentModel` finds no override and the call takes the provider's own model: the
# run succeeds, costs what it would have cost, and no request-time signal anywhere says the
# swap did not happen. Startup is the only place it can be said, and this is the only test
# that boots the real server to hear it — the unit tests call `perAgentKeyWarning` directly,
# which cannot catch src/index.ts handing it the wrong directory (a mistake that typechecks
# and silently disarms the warning for every deployment).
#
# Both halves read the KEY LIST rather than the whole log or the whole warning line: the
# sentence goes on to name every routable agent as the way out, so `reader` appears in it
# legitimately. The keys are the quoted names before "which Iris does not", and nothing is
# assumed about their order.
#
# `|| true` because the missing warning is the regression this step exists to report: under
# `set -euo pipefail` a grep that matches nothing makes the assignment fail, and the script
# would exit here with no ✗ line, no server log dumped (`fail` is its only caller) and every
# later step's result lost — an unexplained early exit instead of this check failing. Same
# reason as the `if grep` at the alt-text step below.
named=$(grep 'per_agent names' "$LOG" | sed 's/, which Iris does not.*//' || true)
case "$named" in
  *'"table"'*) pass "boot names the unroutable key" ;;
  *) fail "per_agent warning" \
       "nothing in $LOG reports \"table\" as a key Iris cannot route. Line: ${named:-<none>}" ;;
esac
# And the routable keys are not reported as broken, or the warning is noise on every boot.
for agent in reader chartDataAgent; do
  case "$named" in
    *"\"$agent\""*)
      fail "per_agent warning" \
        "boot reported \"$agent\" as unroutable; this deployment can route it. Line: $named" ;;
  esac
done
# chartDataAgent is routable only via agents_dir, so this pair is also what proves src/index.ts
# passes the agents directory: any other readable path resolves the same table warning while
# calling the shipped specialist an unknown agent.
pass "the agents it can route are not named among them"

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

# What this run was going to measure about its own corrections, and where (#288). The sampled
# re-check is the one signal whose ABSENCE used to be unreadable: no `page_correction_recheck`
# line means the measurement is off, or no page was corrected, or every corrected page fell below
# the first threshold, and those have different remedies. So the settings ride on the phase's own
# start line, and only a real run says whether the config reached it — the sampler is built from
# the pages this batch runs, in the pipeline, from a value normalized three layers away.
# No `| head -1`: `set -o pipefail` is on, and if a run ever logged two of these the head
# would exit first, kill jq with SIGPIPE and abort the whole suite over a passing assertion.
xs=$(echo "$logs" | jq -c 'select(.type == "extraction_start")')
[ -n "$xs" ] \
  && pass "extraction says what it will measure ($xs)" \
  || fail "extraction_start" "no extraction_start event in the run log"
echo "$xs" | jq -e '.recheck_sample_size == 1 and (.recheck_thresholds | length) == 1
  and .recheck_thresholds[0] >= 1 and .recheck_thresholds[0] <= .pages' >/dev/null \
  && pass "one slot, on a page of this batch (threshold $(echo "$xs" | jq -r '.recheck_thresholds[0]') of $(echo "$xs" | jq -r '.pages'))" \
  || fail "recheck sample" "$xs"

# The generic-alt rule over what shipped (#290). This is the signal whose absence is least
# readable of any in the pipeline: it is expected to find NOTHING, so a rule that silently stopped
# running and a document with no placeholder in it produce the same log. Hence the denominator —
# each mock page carries one real description and one decorative `alt=""`, so a run that checked
# every page reads 3, a run that checked one reads 1, and a rule that never ran reads 0. The
# empty alt must stay out of that count: it is a decision, not a missing description.
xc=$(echo "$logs" | jq -c 'select(.type == "extraction_complete")')
echo "$xc" | jq -e '.alts_checked == 3 and .alts_generic == 0' >/dev/null \
  && pass "every page's alt text was checked and none of it is a placeholder ($(echo "$xc" | jq -r '.alts_generic') of $(echo "$xc" | jq -r '.alts_checked'))" \
  || fail "generic alt" "$xc"

# The in-document references in what shipped (#234). Every page's mock output links to
# #appendix-a and no page defines it, so this asserts the whole measurement path — the
# check runs on the delivered bytes, the event carries both units, and the ids are the
# distinct set. Unit tests cover the function; only this covers the wiring.
il=$(echo "$logs" | jq -c 'select(.type == "internal_links")' | head -1)
[ -n "$il" ] \
  && pass "a dead in-document reference is measured on what shipped ($il)" \
  || fail "internal links" "no internal_links event in the run log"
echo "$il" | jq -e '.refs == 3 and .empty == 0 and .dangling == 3 and .ids == ["appendix-a"]' >/dev/null \
  && pass "counted per reference (3), ids are the distinct set (1)" \
  || fail "internal links units" "$il"
# And the ids are the one part of this that must not leave the deployment: a fragment is
# text the model chose out of the document, so the public tally gets counts only.
echo "$stats" | grep -q 'appendix-a' \
  && fail "internal links leak" "a failing fragment reached the stats payload" \
  || pass "the failing fragment stays in the run log, not in the tally"

# The delivered document's own structure (#240). Page 1's mock output ships an unclosed
# `<div>` and a table with a header block and no rows, and the run reaches
# ready_for_review with `final_lint.ok: true` — which is the finding, not a bug in the
# mock. axe lints a tree the parser has already repaired, so neither defect can reach it.
# Only this step proves the check runs on the delivered bytes rather than on that tree.
dm=$(echo "$logs" | jq -c 'select(.type == "delivered_markup")' | head -1)
[ -n "$dm" ] \
  && pass "the delivered document's structure is measured on its own bytes ($dm)" \
  || fail "delivered markup" "no delivered_markup event in the run log"
echo "$dm" | jq -e '.unbalanced == ["div 1/0"] and .tables == 1 and .tables_without_body == 1' >/dev/null \
  && pass "an unclosed div and a rowless table are both named, past a clean lint" \
  || fail "delivered markup units" "$dm"
# The caption is the user's own text, so it takes the same route the dead fragment does:
# named in the run log, never in a payload that leaves the deployment.
echo "$dm" | jq -e '.empty_table_captions == ["Table 1. Revenue by region"]' >/dev/null \
  && pass "the empty table is identified by its caption, so a maintainer can find it" \
  || fail "delivered markup captions" "$dm"
echo "$stats" | grep -q 'Revenue by region' \
  && fail "delivered markup leak" "an empty table's caption reached the stats payload" \
  || pass "the caption stays in the run log, not in the tally"

# The four structural defect classes (#255), on their own line. Page 1's mock output ships a
# paragraph whose `aria-describedby` names an id no page defines: the gate is clean on it —
# axe files a dead ARIA reference as `incomplete`, never as a violation — so this line is the
# only place the document's broken promise of a description appears.
ds=$(echo "$logs" | jq -c 'select(.type == "delivered_structure")' | head -1)
[ -n "$ds" ] \
  && pass "the structural defects the gate cannot report are measured on the delivered bytes ($ds)" \
  || fail "delivered structure" "no delivered_structure event in the run log"
# All four counts, zeros included: a zero on a line that exists says that class was looked for
# in THIS document and is not in it, which is the distinction the count is for.
echo "$ds" | jq -e '.dangling_idrefs == 1 and .dl_without_dd == 0 and .lang_on_void == 0 and .empty_landmarks == 0' >/dev/null \
  && pass "one dead reference named, and the other three classes reported clean rather than omitted" \
  || fail "delivered structure units" "$ds"
# The id is the model's own invention out of the user's document, so it takes the caption's
# route exactly: named in the run log, never in a payload that leaves the deployment.
echo "$ds" | jq -e '.dangling_idref_examples == ["p[aria-describedby=revenue-note]"]' >/dev/null \
  && pass "the dead reference is identified by element and attribute, so a maintainer can find it" \
  || fail "delivered structure examples" "$ds"
echo "$stats" | grep -q 'revenue-note' \
  && fail "delivered structure leak" "a dead id reference reached the stats payload" \
  || pass "the dead reference stays in the run log, not in the tally"

echo "==> 8b. GET /v1/sessions/{id}/diagnostics"
diag=$(curl -s "${AUTH[@]}" "$BASE/sessions/$SID/diagnostics")
echo "$diag" | jq -e '.model_calls.count >= 1 and .in_flight == null and (.phase_durations_ms | length >= 1)' >/dev/null \
  && pass "diagnostics: $(echo "$diag" | jq -r '.model_calls.count') model calls timed, in_flight=null, phases=$(echo "$diag" | jq -r '.phase_durations_ms|keys|length')" \
  || fail "diagnostics" "$diag"

# `errors` is failures of the run, and a second verdict on a corrected page is not one (#296).
# What this step proves on the mock corpus is the part only a real run can: the field is PRESENT
# and an array in the payload the route actually serialized, and nothing recheck-typed is in
# `errors`. The mock verifier answers `{}`, so this run corrects nothing and fails no recheck —
# `nrf` is 0 and the count and message checks below reduce to 0 == 0. They are written against
# the log rather than against a fixed number so they arm themselves the day the mock does fail
# one, and the pass line prints `nrf` so a reader can see which of the two cases this was.
# That the emitter writes `problems` on an `ok: false` recheck — the field name the old
# `message: "unknown"` got wrong — is pinned in test/verification.test.ts, not here.
nrf=$(echo "$logs" | jq -s '[.[] | select(.type == "page_correction_recheck" and .ok == false)] | length')
echo "$diag" | jq -e --argjson n "$nrf" '
  (.verification.rechecks.failures | type) == "array"
  and (.verification.rechecks.failures | length) == $n
  and ([.verification.rechecks.failures[] | select((.message | length) > 0)] | length) == $n
  and ([.errors[] | select(.type == "page_correction_recheck")] | length) == 0' >/dev/null \
  && pass "recheck verdicts are reported as measurements, not errors ($nrf failing, $(echo "$diag" | jq -r '.errors | length') error(s))" \
  || fail "rechecks.failures" "$(echo "$diag" | jq -c '{errors, failures: .verification.rechecks.failures}')"

# What each call was BOUGHT FOR, on a real run. An agent name is not a step — one agent file
# serves several jobs, so `by_agent` alone priced extraction at 41% of a document when its jobs
# together are 57.2% (#280) — so `by_step` keys the same calls by job. Asserted here and not only
# in unit tests because the failure mode is a call site that forgot to say, and only a whole run
# through the real router exercises every call site at once.
echo "$diag" | jq -e '(.by_step | length) >= 2 and (.by_step | has("extract"))' >/dev/null \
  && pass "diagnostics names the job behind each call ($(echo "$diag" | jq -r '.by_step|keys|join(", ")'))" \
  || fail "by_step" "$diag"
# No `?` bucket on a live run. The router requires a step and the type is closed, so the only way
# to land here is a log line written before the field existed — an archived run, never this one.
echo "$diag" | jq -e '.by_step | has("?") | not' >/dev/null \
  && pass "every call on this run said which job it was for" \
  || fail "by_step unattributed" "$(echo "$diag" | jq -c '.by_step["?"]')"
# The two splits are the same calls grouped two ways, so they add to the same totals and to
# `tokens`. A step's share quoted against a differently-collected whole would be wrong in a way
# no reader of the report could see.
echo "$diag" | jq -e '
  ([.by_step[]  | .count] | add) as $sc | ([.by_agent[] | .count] | add) as $ac |
  ([.by_step[]  | .input_tokens] | add) as $si | ([.by_agent[] | .input_tokens] | add) as $ai |
  $sc == $ac and $sc == .model_calls.count and $si == $ai and $si == .tokens.input' >/dev/null \
  && pass "by_step and by_agent add up to each other and to the run's totals" \
  || fail "by_step totals" "$(echo "$diag" | jq -c '{by_step,by_agent,tokens}')"
# WHICH MODEL each agent ran on, on a real run. `providers.per_agent` is the only knob that
# picks a model, and a key naming no dispatched agent is ignored rather than refused (#310), so
# a swap that never took effect used to look exactly like a cheaper model that saved nothing:
# the seven numbers were identical either way. Here, because the whole run goes through the real
# router, every agent's row has to name the model it was actually called with, and the union
# over `by_agent` has to be the set of models the run's own call lines carry — a row assembled
# from anything but those lines could disagree, and that is the failure worth catching.
logmodels=$(echo "$logs" | jq -s -c '[.[] | select(.type == "model_call") | .model] | unique')
# `$m` non-empty first, because two empty lists compare equal: a run that made no calls, or a
# `.model` field that had been renamed away, would otherwise pass this without proving anything.
echo "$diag" | jq -e --argjson m "$logmodels" '
  ($m | length) > 0
  and ([.by_agent[] | .models] | flatten | unique) == $m
  and ([.by_agent[] | select((.count > 0) and (.models | length) == 0)] | length) == 0' >/dev/null \
  && pass "every agent's row names the model it ran on ($(echo "$diag" | jq -r '.by_agent | to_entries | map("\(.key)=\(.value.models|join("+"))") | join(", ")'))" \
  || fail "by_agent models" "$(echo "$diag" | jq -c '.by_agent')"

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
# And this round's read is not what the quality tally holds for the document (#313): it read a
# body the Copy Editor had already rewritten, so the earlier count is carried forward. The line
# exists because this round DID log a `reader` result of its own, and without it a session's log
# and `/v1/quality` disagree about the number with nothing saying why.
carried=$(log_field first_read_carried carried)
# Asserted as a NUMBER, because the two non-numeric answers are the two regressions and neither is
# an absent value: `log_field` prints an empty string when the event is missing entirely — the line
# dropped, or the carry reverted so the block never runs — and `none` when it is there with
# `carried: null`, which is a documented value for a session delivered before the field existed and
# a defect here, since this session's first run recorded one.
case "$carried" in
  '' | *[!0-9]*)
    fail "first_read" "first_read_carried carried='$carried' on a document-level re-run: '' means no such line in the log at all, 'none' means a null count on a session that has a first read"
    ;;
  *)
    pass "the document's first read was carried across the feedback round (carried=$carried, this round found $(log_field first_read_carried found))"
    ;;
esac

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
# And the placeholder alt this round's editor wrote is caught on the delivered bytes (#290).
# This is the whole reason `delivered_alt` exists apart from `extraction_complete.alts_generic`:
# the pages described their images properly, so extraction is clean, and the review loop replaced
# the body afterwards. Only a check on the file the caller receives can see it.
flog=$(curl -s "${AUTH[@]}" "$BASE/sessions/$SID/logs")
da=$(echo "$flog" | jq -c 'select(.type == "delivered_alt")' | tail -1)
echo "$da" | jq -e '.checked == 1 and .generic == 1 and .examples == ["image"]' >/dev/null \
  && pass "a placeholder alt a copy-edit round wrote is reported on the delivered bytes ($da)" \
  || fail "delivered alt" "${da:-no delivered_alt event in the run log}"
# The distinction stated as an assertion rather than a comment: the same run's extraction was
# clean, so a check reading the fragments would have passed this document.
echo "$flog" | jq -e -s 'map(select(.type=="extraction_complete")) | all(.alts_generic == 0)' >/dev/null \
  && pass "and extraction said nothing, which is why the fragments could not be the instrument" \
  || fail "delivered alt" "$(echo "$flog" | jq -c 'select(.type=="extraction_complete")')"
echo "$out4" | grep -q 'alt="image"' \
  && pass "the placeholder really is in the document that was served, not only in the log" \
  || fail "delivered alt" "the served document holds no alt=\"image\""

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
# And the reply itself is on the failure line (#293). A page lost to the ceiling takes its content
# with it, so the fragment the model did emit is the only record of what was written before the cut,
# and the round cannot be asked again for it. Asserted through the real adapter rather than in the
# unit test alone, because the text arrives on the error from the provider and nothing between here
# and there is allowed to drop it. This fragment is 35 characters — shorter than both excerpts
# together — so it is quoted ENTIRE under `reply_head`, with no `reply_tail` repeating part of it.
tfail=$(curl -s "${AUTH[@]}" "$BASE/sessions/$TSID/logs" \
  | jq -c 'select(.type == "page_extraction_failed")' | tail -1)
echo "$tfail" | jq -e --arg h '{"html":"<table><tr><td>cut off mid' \
  '.truncated == true and .reply_chars == 35 and .reply_head == $h and (has("reply_tail") | not)' >/dev/null \
  && pass "the lost page's reply is quoted on the failure line ($tfail)" \
  || fail "truncation excerpt" "$tfail"

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

# B's pages are written cleanly, which this step needs for a second reason: it is the one
# session in the run whose delivered document has nothing structurally wrong with it, so it
# is what pins the `delivered_markup` line as CONDITIONAL (#240). Every other session's page 1
# carries the defects on purpose, and a log line that appears on every document is a line
# nobody reads.
curl -s -X POST -H 'content-type: application/json' -d '{"clean":true}' \
  "http://localhost:$OR_PORT/__clean-markup" >/dev/null
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

# B's document is the clean one, so the structural check must have run and said nothing (#240).
# Both halves matter: no `delivered_markup` line, and the `internal_links` line still there —
# every page keeps its dead `#appendix-a` reference — so an absence caused by the check not
# running at all would fail here rather than read as a clean document.
echo "$qlog" | jq -e 'select(.type=="delivered_markup")' >/dev/null \
  && fail "delivered markup gate" "a clean document logged delivered_markup: $(echo "$qlog" | jq -c 'select(.type=="delivered_markup")')" \
  || pass "a clean document says nothing about its markup, so the line means something"
echo "$qlog" | jq -e 'select(.type=="internal_links")' >/dev/null \
  && pass "and the measurement did run on it — its dead reference is still reported" \
  || fail "delivered markup gate" "no internal_links either, so the silence above proves nothing"
# The same gate on the same document for the four structural classes (#255): with the clean page
# there is no dead ARIA reference either, so a line with four zeros on it would be a line on
# every run, and the zeros would stop meaning anything.
echo "$qlog" | jq -e 'select(.type=="delivered_structure")' >/dev/null \
  && fail "delivered structure gate" "a clean document logged delivered_structure: $(echo "$qlog" | jq -c 'select(.type=="delivered_structure")')" \
  || pass "a clean document says nothing about its structure either"
# And the third of these lines (#290). B ran with no feedback, so no copy-edit round touched its
# body and every alt in it is the page agent's own description — the ordinary document, which must
# be silent here. Its `alts_checked` on `extraction_complete` is the unconditional half, so this
# silence cannot be a check that never ran.
echo "$qlog" | jq -e 'select(.type=="delivered_alt")' >/dev/null \
  && fail "delivered alt gate" "a document with no placeholder alt logged delivered_alt: $(echo "$qlog" | jq -c 'select(.type=="delivered_alt")')" \
  || pass "a document whose alt text is all descriptions says nothing about it"
curl -s -X POST -H 'content-type: application/json' -d '{"clean":false}' \
  "http://localhost:$OR_PORT/__clean-markup" >/dev/null   # back to the defective page

# Only the flagged page's image reached the editor earlier; here the point is that
# the queue did not corrupt either document. B is single-page and must be complete.
qbout=$(curl -s "${AUTH[@]}" "$BASE/sessions/$QB/output")
echo "$qbout" | grep -q 'Page marker 1' \
  && pass "the queued run produced a complete document" \
  || fail "queued output" "$qbout"

echo "==> 9i. a page that says it is unfinished is the one thing the review loop may not fix"
# `[page not fully transcribed]` is the marker agents/page.md tells the page agent to emit
# when a page holds more than it can return, and READER_SYSTEM tells the Reader to report
# every one and says settling one means re-extracting that page — "which is nobody's job in
# this loop". So a document carrying one cannot finish the loop clean whatever the round
# budget is, and it is the measured floor under `unresolved_rate` (#264, `iris:unfinished-page`).
#
# Driven end to end because of what the workflow does with the number: the weekly finding
# prints the floor whenever the field is PRESENT, including at 0%, which is deliberate — a
# measured 0% says the whole unresolved rate is Iris's to fix. That makes a producer stuck at
# zero worse than a missing one: it would have the report assert the one thing this metric can
# get wrong. Nothing but a real run can rule that out.
#
# One mock artifact to read past: this document exits the loop `clean`, because the mock Reader
# answers with an empty issue list whatever it is shown. A real Reader is instructed to report
# every marker, so on a deployment this same document exits `converged` and is in
# `unresolved_rate` too. What the mock decides is what the READER says; what is under test here
# is that the marker survives to the delivered body and is counted from it.
curl -s -X POST -H 'content-type: application/json' -d '{"on":true}' \
  "http://localhost:$OR_PORT/__unfinished-page" >/dev/null
ucreate=$(curl -s -X POST "${AUTH[@]}" "$BASE/sessions" \
  -F "images=@$png;filename=page-001.png" \
  -F "images=@$png;filename=page-002.png")
USID=$(echo "$ucreate" | jq -r '.session_id')
LSID=$USID
await_ready "run whose second page stopped short"
curl -s -X POST -H 'content-type: application/json' -d '{"on":false}' \
  "http://localhost:$OR_PORT/__unfinished-page" >/dev/null
LSID=""
uout=$(curl -s "${AUTH[@]}" "$BASE/sessions/$USID/output")
umarkers=$(echo "$uout" | grep -o '\[page not fully transcribed\]' | wc -l | tr -d ' ')
[ "$umarkers" = "1" ] \
  && pass "the marker is delivered as content, once, rather than tidied away" \
  || fail "unfinished page" "expected 1 marker in the delivered document, found $umarkers"

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
# The dead reference measured back at step 8 reaching the published rate. A per-document
# share, so three references to one missing id raise it once — the count that says three
# is on the run log, and the rate is the number the weekly workflow reads.
echo "$q" | jq -e '.links_unresolved_rate > 0 and .links_unresolved_rate <= 1' >/dev/null \
  && pass "links_unresolved_rate carries the dead reference through ($(echo "$q" | jq -r '.links_unresolved_rate'))" \
  || fail "quality" "links_unresolved_rate=$(echo "$q" | jq -r '.links_unresolved_rate') though a delivered document had one"
# The same for the two structural findings from step 8, which are the ones no lint gate can
# report. Separate rates because one document can have either: an unclosed tag is the
# model's markup, an empty table is its reading of the page.
echo "$q" | jq -e '.markup_unbalanced_rate > 0 and .table_no_body_rate > 0' >/dev/null \
  && pass "the delivered document's structure reaches the tally (markup $(echo "$q" | jq -r '.markup_unbalanced_rate'), tables $(echo "$q" | jq -r '.table_no_body_rate'))" \
  || fail "quality" "markup_unbalanced_rate=$(echo "$q" | jq -r '.markup_unbalanced_rate'), table_no_body_rate=$(echo "$q" | jq -r '.table_no_body_rate') though a delivered document had both"
# And the dangling `aria-describedby` from the same document, which the gate reported as
# `incomplete` and not as a violation — so a rate above zero here is the only place outside the
# run log where that document's broken promise is visible at all.
echo "$q" | jq -e '.structural_defect_rate > 0 and .structural_defect_rate <= 1' >/dev/null \
  && pass "structural_defect_rate carries the dangling id reference through ($(echo "$q" | jq -r '.structural_defect_rate'))" \
  || fail "quality" "structural_defect_rate=$(echo "$q" | jq -r '.structural_defect_rate') though a delivered document had one"
# ...and the rule table's own denominator, which counts only the documents axe-core
# actually examined (#164). It can be smaller than `documents` but never larger, and
# never absent: a missing key here would make every rule share divide by zero.
echo "$q" | jq -e '.documents_linted != null and .documents_linted >= 0 and .documents_linted <= .documents' >/dev/null \
  && pass "documents_linted is $(echo "$q" | jq -r '.documents_linted'), within 0..$docs" \
  || fail "quality" "documents_linted=$(echo "$q" | jq -r '.documents_linted') against documents=$docs"
# ...and, when it is smaller, WHICH of the three lint steps failed (#263). All three are
# always present, zeros included: the workflow prints this sentence only when the field
# exists, so "measured and none" and "not measured on this deployment" have to be
# distinguishable, and an absent step would collapse them. The counts sum to at most the
# documents the rate covers, never more — a step counted per occurrence rather than per
# document would exceed the failures it is breaking down.
echo "$q" | jq -e '[.lint_error_where[].where] == ["parse","inject","run"]
  and ([.lint_error_where[].documents] | all(. >= 0))
  and ([.lint_error_where[].documents] | add) <= (.documents - .documents_linted)' >/dev/null \
  && pass "lint_error_where accounts for the unlinted documents ($(echo "$q" | jq -c '[.lint_error_where[] | "\(.where)=\(.documents)"] | join(" ")' | tr -d '"'))" \
  || fail "quality" "lint_error_where=$(echo "$q" | jq -c '.lint_error_where') against documents=$docs linted=$(echo "$q" | jq -r '.documents_linted')"
# Which of the review loop's five exits ended each document (#264), and the property that
# makes the breakdown readable: one exit per delivered document, so these sum to
# `documents` exactly. Asserted end to end rather than only in test/quality.test.ts because
# the sum is what a shortfall is read against, and a shortfall is meant to mean "delivered
# before this was recorded" — an exit in the real pipeline that assigns nothing would look
# identical, and only a run of the whole pipeline can rule that out.
echo "$q" | jq -e '[.review_stopped[].where] == ["clean","unread","converged","truncated","cap"]
  and ([.review_stopped[].documents] | all(. >= 0))
  and ([.review_stopped[].documents] | add) == .documents' >/dev/null \
  && pass "review_stopped attributes all $docs document(s) ($(echo "$q" | jq -c '[.review_stopped[] | select(.documents > 0) | "\(.where)=\(.documents)"] | join(" ")' | tr -d '"'))" \
  || fail "quality" "review_stopped=$(echo "$q" | jq -c '.review_stopped') against documents=$docs — an exit that assigns no stop reason"
# And the arithmetic that makes those exits a split OF `unresolved_rate` rather than a second
# breakdown standing beside it (#264). Three of the five deliver an `@unresolved` list and two
# do not, so on this window — where every document named its exit — the three sum to the
# documents in the rate. That is what licenses the weekly report reading `cap` + `converged` as
# the part of the rate that is a statement about the delivered document and `truncated` as the
# part that is a statement about the round. Only a real run can check it: the store test asserts
# the same equality over signals written by hand, and the way this breaks is a pipeline that
# records an exit and an unresolved list that disagree.
echo "$q" | jq -e '([.review_stopped[] | select(.where == "cap" or .where == "converged" or .where == "truncated") | .documents] | add)
  == ((.unresolved_rate * .documents) | round)' >/dev/null \
  && pass "the exits that ship an open list are the $(echo "$q" | jq -r '(.unresolved_rate * .documents) | round') document(s) in unresolved_rate" \
  || fail "quality" "cap+converged+truncated=$(echo "$q" | jq -r '[.review_stopped[] | select(.where == "cap" or .where == "converged" or .where == "truncated") | .documents] | add') against unresolved_rate × documents=$(echo "$q" | jq -r '(.unresolved_rate * .documents) | round') — the split does not describe the rate"
# How the Reader rated what it left open. NOT a partition (one document with a high issue
# and two low ones is counted in both), so the invariant is the weaker one that matters:
# an unresolved rate above zero must have severities behind it, and a rate of zero must
# have none. The two disagreeing means the rate and this breakdown are counting different
# documents, which would make a `high`-based threshold unsafe to set.
echo "$q" | jq -e '[.unresolved_severity[].severity] == ["high","medium","low","unrated"]
  and ([.unresolved_severity[].documents] | all(. >= 0))
  and ([.unresolved_severity[].documents] | max) <= .documents
  and ((([.unresolved_severity[].documents] | add) > 0) == (.unresolved_rate > 0))' >/dev/null \
  && pass "unresolved_severity agrees with unresolved_rate=$(echo "$q" | jq -r '.unresolved_rate') ($(echo "$q" | jq -c '[.unresolved_severity[] | "\(.severity)=\(.documents)"] | join(" ")' | tr -d '"'))" \
  || fail "quality" "unresolved_severity=$(echo "$q" | jq -c '.unresolved_severity') against unresolved_rate=$(echo "$q" | jq -r '.unresolved_rate')"
# What the Reader FOUND, which is the one number here that is not downstream of the editor
# (#313). Its invariant is the same one `review_stopped` has and for the same reason: the row is
# written for every delivered document, zero included, so on a window where every document
# recorded one these two counts are equal and a shortfall means "delivered before the field
# existed". Only a real run can check that, and the way it breaks is the way every producer here
# breaks — a mean that quietly covers half the documents reads as a Reader finding half as much.
#
# The mean is asserted at exactly 0, which is a statement about this mock and a sharp check on
# the one subtle part of the field. The mock Reader finds nothing on a first read; the only read
# in this whole script that finds anything is the feedback round of step 9c, which re-reviews a
# body the Copy Editor has already rewritten — and that is precisely the read this signal must
# not hold, because a re-read of corrected bytes finds less and would move the mean the same way
# a Reader going blind moves it. So a non-zero mean here is not good news: it means a feedback
# round's read reached the row (`Store.priorFirstRead` and its caller in the orchestrator are
# what stop it). A shortfall in the count is the other failure and the commoner one — dropping
# the carry-forward entirely takes this to `documents: 8` against 10, which is how this check
# was verified.
echo "$q" | jq -e '.first_read.documents == .documents
  and .first_read.mean_issues != null and .first_read.mean_issues == 0
  and .first_read.unread_documents == 0' >/dev/null \
  && pass "first_read covers all $docs document(s), and holds each one's FIRST read (mean $(echo "$q" | jq -r '.first_read.mean_issues'), all windows answered)" \
  || fail "quality" "first_read=$(echo "$q" | jq -c '.first_read') against documents=$docs — either the Reader's yield is not reaching the tally, or a feedback round's re-read of an edited body is being recorded as one"
# And the floor under that rate: documents still carrying `[page not fully transcribed]`,
# which no pass in the loop may resolve. Above zero because step 9i put exactly one such
# document through the pipeline, and that is the half of this only a real run can check —
# the weekly report prints this sentence whenever the FIELD is present, including at 0%, so
# a producer stuck at zero would not go quiet: it would have the report assert that the
# whole unresolved rate is Iris's to fix. A recorded 0 and a missing key are also different
# claims, which is why `!= null` is asserted rather than only a range.
echo "$q" | jq -e '.unfinished_page_rate != null and .unfinished_page_rate > 0 and .unfinished_page_rate <= 1' >/dev/null \
  && pass "unfinished_page_rate is $(echo "$q" | jq -r '.unfinished_page_rate'), measured from the document step 9i delivered" \
  || fail "quality" "unfinished_page_rate=$(echo "$q" | jq -r '.unfinished_page_rate'), expected the marker from step 9i to be counted"
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
# LEAF names, so a nested field contributes the keys inside it and not its own: the
# entries of `lint_error_where` add `where` (their `documents` is already allowed).
# `where` is one of three strings named in `src/store/db.ts`, which is why it is
# publishable at all — the version of that field carrying the error message would have
# quoted the markup jsdom choked on. `severity` (#264) is publishable for the same reason
# and needs it more: the Reader WRITES that value, so the store maps anything outside its
# four words to `unrated` rather than passing it on — an unmapped one would put model prose
# about someone's document into a public issue. `mean_issues` and `unread_documents` (#313) are
# the leaves of `first_read`, and are two counts and an average of counts — the obvious next
# request of a mean is a distribution, and the obvious way to give it one is a sample, which
# would name documents.
allowed='["window_days","documents","since","mean_rounds","unresolved_rate","mean_issues","unread_documents","severity","review_unread_rate","links_dropped_rate","links_unresolved_rate","markup_unbalanced_rate","table_no_body_rate","structural_defect_rate","lint_error_rate","where","documents_linted","editor_truncated_rate","editor_truncated_lost_rate","unfinished_page_rate","id","impact","share","nodes"]'
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
