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

GitHub OAuth is the only auth mechanism, and the same token opens PRs on close, so the consent
screen requests `repo` scope. By default the service uses a **bundled OAuth App** — you don't
create or configure anything; just run the device flow below and approve in your browser.

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
`fork_repo` is `null` until the first `/close` (the fork is created lazily).

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
When `status` is `ready_for_review`, the response also includes a `pending_prs` preview of what
`/close` will open:
```json
{
  "status": "ready_for_review",
  "phase": "done",
  "pending_prs": {
    "new_agents": [
      { "agent_name": "scientificNotation",
        "summary": "Convert inline scientific notation.",
        "triggered_by": "page-007.png" }
    ],
    "agent_updates": []
  }
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
`text/html` with provenance comments intact (`@source`, `@agent`, `@fragment`, `@reconciled`).
Returns `409` while the session is still running.

## 6. Submit feedback (re-run)

Triggers a new run within the same session, with the feedback injected as a top-level
instruction to every agent (PRD §7.12). The prior output is snapshotted to
`sessions/<id>/history/` so it can be reverted to.

```bash
curl -s -X POST -H "$AUTH" "$BASE/sessions/$SID/feedback" \
  -H 'content-type: application/json' \
  -d '{"feedback":"The footnote on page 4 was inlined as body text. Keep footnotes distinct."}'
# 202 {"session_id":"ses_...","status":"running","phase":"triage"}
```
Then poll status again as in step 4.

## 7. Run log

```bash
curl -s -H "$AUTH" "$BASE/sessions/$SID/logs"
```
`application/x-ndjson` — one JSON object per line (agent calls with git-SHA / inline-content
version pinning, model-call timing, no-content signals, phase transitions).

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
  "phase_durations_ms": { "triage": 8200, "extraction": 60100 },
  "model_calls": { "count": 7, "failed": 0, "total_ms": 51000, "avg_ms": 7285, "max_ms": 14300 },
  "by_agent": { "image_analysis": { "count": 1, "total_ms": 8200, "max_ms": 8200 } },
  "slowest_calls": [ { "agent": "table", "model": "...", "capability": "vision", "duration_ms": 14300, "ok": true } ],
  "errors": []
}
```

The key field for **"is it hung?"** is `in_flight`: a non-null value with a large `waiting_ms`
means a model call started and hasn't returned (the likely culprit). `slowest_calls` and
`phase_durations_ms` show where time goes; `errors` lists failed calls.

## 8. List sessions

```bash
curl -s -H "$AUTH" "$BASE/sessions?limit=20"
curl -s -H "$AUTH" "$BASE/sessions?status=ready_for_review"
```
```json
{ "sessions": [ { "session_id": "ses_...", "status": "ready_for_review",
  "image_count": 2, "created_at": "...", "updated_at": "..." } ], "next_cursor": null }
```
Paginate by passing `cursor=<next_cursor>`.

## 9. Close the session (finalize + open PRs)

Locks the output, opens a GitHub PR for each session-built agent (and each proposed update),
and deletes `tmp/<id>/`. Requires `status` = `ready_for_review` (else `409`).

```bash
curl -s -X POST -H "$AUTH" "$BASE/sessions/$SID/close"
```
```json
{
  "session_id": "ses_...",
  "status": "closed",
  "prs_opened": [
    { "kind": "new_agent", "agent_name": "scientificNotation",
      "pr_url": "https://github.com/example/iris/pull/142",
      "branch": "new-agent/scientificNotation-a3f9" }
  ]
}
```
Skip contributing the session-built agents (finalize without any PRs):
```bash
curl -s -X POST -H "$AUTH" "$BASE/sessions/$SID/close?skip_prs=true"
```

## Errors (PRD §9.3)

All errors share one shape:
```json
{ "error": { "code": "invalid_state", "message": "Human-readable description", "details": {} } }
```
Common codes: `unauthorized` (401), `session_not_found` (404), `invalid_state` (409),
`invalid_request` (400), `pr_failed` (502).

## Prove it works

```bash
./test/e2e.sh      # boots mocks + Iris, runs all of the above via curl, asserts each step
```
