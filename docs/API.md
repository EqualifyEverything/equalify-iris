# Equalify Iris — API Guide (bash / curl)

Every endpoint is under `/v1`. All responses are JSON unless noted. Every endpoint except
`/v1/health` and `/v1/auth/*` requires `Authorization: Bearer <github_token>` (PRD §9.1).

These commands are copy-pasteable. They are the same calls exercised by `test/e2e.sh`, which
runs the whole lifecycle against mock GitHub + mock model services and asserts every response.

```bash
export BASE=http://localhost:8080/v1
```

## 0. Health (unauthenticated)

```bash
curl -s "$BASE/health"
# {"status":"ok","service":"equalify-iris"}
```

## 1. Authenticate (get a token)

GitHub OAuth is the only auth mechanism. The consent screen requests `repo` scope because the
same token is used to file agent-suggestion issues on your behalf (unless the deployment sets a
service token — see [Contributions](#contributions-automatic)). Nothing opens pull requests. By
default the service uses a **bundled OAuth App** — you don't create or configure anything; just
run the device flow below and approve in your browser.

### CLI / bash — device flow (recommended for terminals)

```bash
# Begin: returns a code to type into the browser.
dev=$(curl -s -X POST "$BASE/auth/github/device")
echo "$dev"
# {"device_code":"...","user_code":"WXYZ-1234","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}

# Open the verification_uri in a browser and enter the user_code, then poll:
DEVICE_CODE=$(echo "$dev" | jq -r .device_code)
curl -s -X POST "$BASE/auth/github/device/poll" \
  -H 'content-type: application/json' \
  -d "{\"device_code\":\"$DEVICE_CODE\"}"
# while pending -> 202 {"status":"pending","error":"authorization_pending"}
# once approved -> 200 {"access_token":"gho_...","token_type":"bearer"}

export TOKEN=gho_xxx   # paste the access_token
export AUTH="Authorization: Bearer $TOKEN"
```

### Web clients — redirect flow

```
GET  /v1/auth/github/start      -> 302 redirect to the GitHub consent screen
GET  /v1/auth/github/callback   -> 200 {"access_token":"gho_...","token_type":"bearer"}
```

`/start` issues a state value and redirects to GitHub; after the user approves, GitHub calls
`/callback?code=...&state=...` and the service returns the access token.

## 2. Current user

```bash
curl -s -H "$AUTH" "$BASE/me"
```
```json
{
  "github_login": "iris-tester",
  "github_user_id": 4242,
  "upstream_repo": "https://github.com/example/iris",
  "fork_repo": null,
  "defaults": { "max_review_iterations": 3 }
}
```
`fork_repo` is **always** `null`: contributions are filed as issues, so no fork is ever created.
The field is a vestige of the PRD's fork+PR flow and is retained only for response-shape
stability.

## 3. Create a session (upload images)

`multipart/form-data`. Repeat `images` once per file; **the order of the parts is the
processing order** (not the filename). `config` is an optional JSON part.

```bash
create=$(curl -s -X POST -H "$AUTH" "$BASE/sessions" \
  -F "images=@page-001.png" \
  -F "images=@page-002.png" \
  -F 'config={"max_review_iterations":3}')
echo "$create"
export SID=$(echo "$create" | jq -r .session_id)
```
```json
{ "session_id": "ses_01HXYZ...", "status": "queued", "image_count": 2, "created_at": "..." }
```
Accepted file types: PNG, JPEG, TIFF, WebP, **and PDF**. A PDF is rasterized server-side into
one image per page (in page order) and processed like any other page sequence. Total pages
(across all parts) are capped per deployment.

`status` is `queued` on creation and becomes `running` when the pipeline actually starts. Those are
usually the same instant, but a deployment runs at most `defaults.max_concurrent_runs` pipelines at
once (default 2): beyond that, the session **waits in `queued`** — in FIFO order, for as long as it
takes — rather than being rejected. Nothing is lost; the upload is already stored. If a session sits
in `queued`, check its run log for `run_queued` / `run_dequeued` to see the wait rather than
assuming a hang.

## 4. Poll status

The pipeline runs asynchronously; poll until `status` is `ready_for_review` (or `failed`).

```bash
curl -s -H "$AUTH" "$BASE/sessions/$SID" | jq
```
```json
{
  "session_id": "ses_01HXYZ...",
  "status": "running",
  "phase": "extraction",
  "iterations_completed": 0,
  "iterations_max": 3,
  "image_count": 2,
  "created_at": "...",
  "updated_at": "..."
}
```
A simple wait loop:
```bash
until [ "$(curl -s -H "$AUTH" "$BASE/sessions/$SID" | jq -r .status)" = "ready_for_review" ]; do
  sleep 2
done
```

## 5. Fetch the HTML output

```bash
curl -s -H "$AUTH" "$BASE/sessions/$SID/output" -o output.html
```
`text/html` — clean, content-only accessible HTML. Provenance comments (`@source`, `@agent`,
`@fragment`) are **not** included, a deliberate deviation from PRD §7.4; provenance lives in the
run log instead (step 7). An `<!-- @unresolved -->` comment listing outstanding issues is
appended if the review loop hit its iteration cap. Returns `409` while the session is still
running.

## 6. Submit feedback (re-run)

Triggers a new run within the same session, with the feedback injected as a top-level
instruction to every agent (PRD §7.12). The prior output is snapshotted to
`sessions/<id>/history/` so it can be reverted to.

```bash
curl -s -X POST -H "$AUTH" "$BASE/sessions/$SID/feedback" \
  -H 'content-type: application/json' \
  -d '{"feedback":"The footnote on page 4 was inlined as body text. Keep footnotes distinct."}'
# 202 {"session_id":"ses_...","status":"running","phase":"extraction"}
```
Then poll status again as in step 4. A re-run is subject to the same `max_concurrent_runs` cap as a
new upload, so the 202 may instead report `{"status":"queued","phase":"triage"}` — accepted, waiting
for a slot. Either way the session is no longer `ready_for_review`, so a second feedback POST gets a
`409` until this run finishes.

A re-run on a session that already produced output builds on the **existing document** rather
than regenerating it, and is routed by what the feedback is about (visible in the run log as a
`feedback_scoped` event):

| Scope | What runs | Typical feedback |
| --- | --- | --- |
| `document` | Re-lint the saved body, then the feedback-aware review loop. No re-extraction. | tone, wording, ordering, an accessibility rule |
| `extraction` | The named pages go back to the page agent **with their source image**, then reassemble + review. Other pages keep their prior fragments. | "the revenue figure on page 2 is wrong", missed or misread content |

The second case exists because the **Reader** never sees the source images (by design, §7.8 — it
reads the way a screen-reader user does), so a misreading of the source is invisible to it: no
issue is raised, and the loop has nothing to act on. Routing is biased toward the cheaper
`document` path: if the pages can't be localized, or the feedback claims more than half the
document, it falls back rather than re-extracting broadly.

## 7. Run log

```bash
curl -s -H "$AUTH" "$BASE/sessions/$SID/logs"
```
`application/x-ndjson` — one JSON object per line (agent calls with git-SHA / inline-content
version pinning, model-call timing, no-content signals, phase transitions).

Useful events to grep for:

| `type` | Meaning |
| --- | --- |
| `run_queued` / `run_dequeued` | The run's wait for a concurrency slot: how busy the queue was when it was admitted (`running` of `limit`, plus `waiting`), and `waited_ms` when it actually started. A large `waited_ms` means the deployment is saturated, not that this run is slow. |
| `feedback_scoped` | How a feedback re-run was routed (`document` vs `extraction`, and which pages) |
| `reextract_start` / `reextract_complete` | Which pages went back to the page agent |
| `editor_images` | How many source images the Copy Editor received this round (`attached` of `of`, plus `pages`). `attached == of` on a multi-page document means at least one issue in that round carried no page attribution, so the round fell back to sending everything. |
| `reader` / `editor` | Per-iteration review-loop progress (issue counts) |

## 7b. Diagnostics (timing / hang detection)

A machine-readable health summary distilled from the run log — built for maintainers, human
or AI, to spot what's slow or stuck.

```bash
curl -s -H "$AUTH" "$BASE/sessions/$SID/diagnostics" | jq
```
```json
{
  "session_id": "ses_...",
  "status": "running",
  "phase": "extraction",
  "started_at": "2026-05-22T16:25:01Z",
  "elapsed_ms": 92000,
  "in_flight": {
    "agent": "table", "model": "us.anthropic.claude-sonnet-4-6",
    "provider": "bedrock", "capability": "vision",
    "since": "2026-05-22T16:26:12Z", "waiting_ms": 41000
  },
  "in_flight_count": 3,
  "concurrency_factor": 3.8,
  "phase_durations_ms": { "extraction": 60100, "review": 24000 },
  "model_calls": { "count": 7, "failed": 0, "total_ms": 51000, "avg_ms": 7285, "max_ms": 14300 },
  "by_agent": { "page": { "count": 2, "total_ms": 28200, "max_ms": 15100 } },
  "slowest_calls": [ { "agent": "table", "model": "...", "capability": "vision", "duration_ms": 14300, "ok": true } ],
  "errors": []
}
```

The key field for **"is it hung?"** is `in_flight`: a non-null value with a large `waiting_ms`
means a model call started and hasn't returned (the likely culprit). Because pages are
extracted in parallel, several calls can be open at once — `in_flight` reports the
**longest-waiting** one and `in_flight_count` how many are open in total. `concurrency_factor`
is total model-call time ÷ wall-clock elapsed: ~1 means calls ran serially, and roughly
`extraction_concurrency` during a parallel extraction phase — a value near 1 on a multi-page run
means parallelism isn't happening. `slowest_calls` and `phase_durations_ms` show where time goes;
`errors` lists failed calls.

## 8. List sessions

```bash
curl -s -H "$AUTH" "$BASE/sessions?limit=20"
curl -s -H "$AUTH" "$BASE/sessions?status=ready_for_review"
```
```json
{ "sessions": [ { "session_id": "ses_...", "status": "ready_for_review",
  "image_count": 2, "created_at": "...", "updated_at": "..." } ],
  "next_cursor": "2026-05-22T18:00:00.000Z|ses_01HXYZ..." }
```
Paginate by passing `cursor=<next_cursor>` **verbatim** — it encodes both halves of the
sort key (`created_at|session_id`), because `created_at` alone is not unique: sessions
created in the same millisecond tie on it, and paging on a non-unique key skips and
repeats rows at page boundaries. Treat it as opaque; the shape is documented so a paging
bug is readable in a request log, not so clients can construct one.

"Verbatim" means the *value*, not the URL: **percent-encode it when you build the query
string** (`%7C` for the `|`). A raw `|` is not a legal query character per RFC 3986 — curl,
browsers and Express all accept it, but a strict URI type (`java.net.URI`) or a strict proxy
will reject the request, and the error will not point back here. Use whatever your client
calls `--data-urlencode`; the examples below do.

`next_cursor` is `null` on the last page — including when that page is full. Stop when it
is `null` rather than when a page comes back short.

**Send the cursor back byte-for-byte.** It is validated against the exact format the store
writes (UTC ISO-8601 with milliseconds), and anything else is a `400 invalid_request` — not
a silent restart from page one. That includes values which are perfectly good timestamps
for the same instant: `2026-05-22T18:00:00Z` (milliseconds dropped) and
`2026-05-22T19:00:00.000+01:00` (an offset instead of `Z`) are both rejected, because the
cursor is compared as a *string* and either one sorts above every stored value. If you
round-trip cursors through a date type, you will reformat them; keep them as strings.

One exception, and the only case where a page can still lose rows: a cursor from *before*
this endpoint became compound is a bare timestamp with no `|`, and it is still accepted
rather than 400'd — so a client paginating across the deploy that introduced the compound
cursor keeps working, but that one request skips any sessions tied on that timestamp.
It clears itself on the next page, since the cursor it hands back is compound. If a client
reports a gap during an upgrade window, this is why; re-listing from the start is the fix.

```bash
# Walk every page.
cursor=""
while :; do
  page=$(curl -s -H "$AUTH" --get ${cursor:+--data-urlencode "cursor=$cursor"} "$BASE/sessions?limit=50")
  echo "$page" | jq -r '.sessions[].session_id'
  cursor=$(echo "$page" | jq -r '.next_cursor // empty')
  [ -z "$cursor" ] && break
done
```

## 9. Close the session (finalize + clean up)

Locks the output and deletes `tmp/<id>/`. Requires `status` = `ready_for_review` (else `409`).
Contributions are handled automatically during the run (see below), so close does not open PRs.

```bash
curl -s -X POST -H "$AUTH" "$BASE/sessions/$SID/close"
```
```json
{ "session_id": "ses_...", "status": "closed" }
```

## Contributions (automatic)

When the extractor encounters content a dedicated specialist agent would handle better than the
general pass, Iris drafts that agent and **automatically files a labeled GitHub issue**
(`iris-agent-suggestion`) on the upstream repo containing the agent code + context. This happens
server-side during the run — there is no PR/fork flow (deviation from PRD §7.13), so `/close`
returns no `prs_opened` and requests accept no `skip_prs`.

By default the issue is filed with **the logged-in user's token**. Set `IRIS_GITHUB_TOKEN` to a
service-account PAT to file everything under a bot account instead.

## Errors (PRD §9.3)

All errors share one shape:
```json
{ "error": { "code": "invalid_state", "message": "Human-readable description", "details": {} } }
```
Common codes: `unauthorized` (401), `session_not_found` (404), `invalid_state` (409),
`invalid_request` (400).

A run that fails reports why in the `error` field of `GET /v1/sessions/{id}`. One worth
recognizing:

```
openrouter: response hit the 32000-token output ceiling and was truncated
(31998 chars returned). Raise providers.openrouter.max_tokens.
```

The model stopped at the output ceiling rather than at the end of its answer, so the HTML it
returned is cut mid-tag. Iris **fails the run** instead of assembling the fragment — a truncated
page still parses, so it would otherwise be delivered as though the missing content were never in
the source. Raise `max_tokens` on that provider block and re-run. Dense full-page tables and
forms are the usual trigger.

## Prove it works

```bash
./test/e2e.sh      # boots mocks + Iris, runs all of the above via curl, asserts each step
```
