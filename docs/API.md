# Equalify Iris — API Guide (bash / curl)

Every endpoint is under `/v1`. All responses are JSON unless noted. Every endpoint except
`/v1/health`, `/v1/stats` and `/v1/auth/*` requires `Authorization: Bearer <github_token>`
(PRD §9.1).

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

## 0b. Public tally (unauthenticated)

How much this deployment has actually made accessible. No token: the browser app shows it to
visitors before anyone signs in, and it is the number the project celebrates with.

```bash
curl -s "$BASE/stats"
```
```json
{ "pages_processed": 1284, "documents_processed": 212, "since": "2026-05-22T18:00:00.000Z" }
```

* `pages_processed` — **distinct page images** Iris has converted to accessible HTML. A session
  counts once it has reached `ready_for_review`, so an upload that has **never** reached it — still
  queued, still running, or failed on its first run — is not in the number, and a feedback re-run
  does **not** count its pages again: this is a tally of pages made accessible, not of model calls.
  Note the asymmetry with a `failed` status: a session that completed once and then failed a re-run
  stays counted (see "the number only ever goes up" below).
* `documents_processed` — sessions counted, on the same basis. A 40-page PDF is one document and
  forty pages.
* `since` — when the earliest counted document finished, or `null` before anything has, so a
  client can say "since May 2026" without hardcoding a launch date.

The number only ever goes up. It is derived from a write-once `first_completed_at` stamp rather
than from current `status`, precisely so that asking Iris to re-run a finished document — which
moves it back to `queued`, and possibly on to `failed` — cannot make the public count dip. For
databases that predate that column, sessions already in `ready_for_review`/`closed` are backfilled
from `updated_at`, so nothing already converted is dropped from the count.

*One session is missed by that backfill, once:* one that had completed and was **mid-re-run** at the
moment the upgraded build booted. It is not `ready_for_review`/`closed` at that instant, and the
startup sweep then marks it `failed`, so it is excluded for good rather than until the re-run ends.
Counting in-flight sessions instead would be worse — it would credit first runs that had produced
nothing — so the tally undercounts by that one document. Only the upgrade moment is affected.

Everything here is a deployment-wide aggregate: no session ids, logins, user ids, filenames or
content. It is not, however, free of per-upload information: the **delta** between two reads is one
— `documents_processed` +1 with `pages_processed` +40 means a 40-page document finished in that
window, and on a quiet deployment the aggregate is the individual. Nothing identifying follows from
it (no who, no what), but an operator who treats document sizes as sensitive should keep this
endpoint off the public internet. Responses are cached for 60 seconds
(`Cache-Control: public, max-age=60`), which coarsens *when* a conversion shows up but not the page
count — so a page you just converted may take up to a minute to appear.

## 1. Authenticate (get a token)

GitHub is the only auth mechanism, and a GitHub token is **required** on every API call —
there is no anonymous mode, no API key and no second SSO provider. That is a design decision, not
a gap: your token is what files your session's feedback back to the shared agent library, under
your own GitHub identity. Using Iris and improving it for the next person are the same act
(PRD §12). If you would rather not contribute, this is not the service to run.

By default the service uses a **bundled GitHub App** — you don't create or configure anything;
just run the device flow below and approve in your browser.

The consent screen requests **no repository access at all.** Iris is a GitHub App, so the one
permission it needs — write access to issues on the upstream repo — comes from the app being
*installed* on that repo, not from your authorization. What your token grants is your **identity**,
which is what puts your name on the feedback your session contributes. It cannot read your code, and
it cannot touch any repository other than the upstream one the app is installed on.

Your token is never written to disk. It is read from the `Authorization` header, held in memory
for the duration of the run it authorizes, and discarded — revoke it any time at
[github.com/settings/applications](https://github.com/settings/applications) and the service loses
that access within five minutes (see the README's "What happens to your token").

*Operators:* an earlier build did store tokens, in a `github_token` column. There is no migration —
delete any `data/iris.sqlite` from before that change and let users re-authorize. The service
refuses to start against such a file rather than adopting it, since the old table would break
first-time logins *and* would still hold live plaintext tokens, making the paragraph above false for
that deployment.

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
  "defaults": { "max_review_iterations": 3 }
}
```
`upstream_repo` is where this deployment files your contributions. There is no `fork_repo` field:
contributions are filed as issues, so no fork is ever created (deviation from PRD §7.13).

## 3. Create a session (upload images)

`multipart/form-data`. Repeat `images` once per file; **the order of the parts is the
processing order** (not the filename). `images` is the only part the endpoint reads — there are
no per-session options. (A `config` part used to override `max_review_iterations` for one
session; it was removed, and sending one now is ignored rather than an error. The cap comes from
your account default, seeded from the deployment's `defaults.max_review_iterations` — see
[`GET /v1/me`](#2-current-user).)

```bash
create=$(curl -s -X POST -H "$AUTH" "$BASE/sessions" \
  -F "images=@page-001.png" \
  -F "images=@page-002.png")
echo "$create"
export SID=$(echo "$create" | jq -r .session_id)
```
```json
{ "session_id": "ses_01HXYZ...", "status": "queued", "image_count": 2, "created_at": "..." }
```
Accepted file types: PNG, JPEG, TIFF, WebP, **and PDF**. A PDF is rasterized server-side into
one image per page (in page order) and processed like any other page sequence. Total pages
(across all parts) are capped per deployment.

A PDF's **links survive**, which rasterizing alone would not manage: a link is an annotation
over the page rather than something drawn on it, so the page image carries the link text and
none of its target. The link targets are read out of the file separately and given to the page
agent as ground truth, and the output's `<a href>`s are checked against them — the run log
carries a `page_links` line per page that had any, and `page_links_missing` /
`page_links_unrecovered` when one did not make it into the HTML. Two kinds are dropped on
purpose: links to a destination inside the same document (the page they point at is in the
delivered HTML already), and any URL whose scheme is not `http(s)`, `mailto`, `tel`, or `ftp` —
a PDF can carry a `javascript:` action, and that is not something to re-emit into a document.
A link over an image with no text under it has nothing to attach to and is lost.

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
`status` is one of `queued`, `running`, `ready_for_review`, `closed`, `failed`.

`phase` is one of `extraction`, `assembly`, `review`, `done`, and is only meaningful while
`status` is `running` — a `queued` session reports the phase it will start in, not one it has
reached. These are the four phases the pipeline enters; `triage` and `reconciliation` appear in
PRD §6/§7.2/§7.6 but are **not implemented** and are no longer emitted, so a client should not
branch on them. Treat the list as open anyway: fall back to displaying the raw value rather than
showing nothing for a phase you don't recognize.

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
new upload, so the 202 may instead report `{"status":"queued","phase":"extraction"}` — accepted, waiting
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
`limit` is `20` by default and capped at `100`. Anything not an integer of at least 1 —
`0`, negative, fractional, non-numeric — is the default, not an error: one rule, so two
equally invalid values can't get page sizes differing by a factor of twenty.

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

Every session gives something back, and there is no opt-out. This is why the API requires a GitHub
token at all (PRD §12).

Two things get filed as GitHub issues on the upstream repo, server-side during the run. Each is
identified by its title prefix rather than by a label, because GitHub silently drops labels set by a
filer without push access — which is most filers here:

- **New agent suggestions** (`New agent suggestion: <type>`) — when the extractor meets content a
  dedicated specialist agent would handle better than the general pass, Iris drafts that agent and
  files it with the code + context.
- **Agent improvements** (`Agent update proposal: <agent>`) — when your `/feedback` produces a
  change that generalizes beyond your document, and it survives the agent's regression fixtures.

Both are filed with **your** token, so the issue carries your GitHub identity and the credit is
yours. There is no PR/fork flow (deviation from PRD §7.13): `/close` returns no `prs_opened` and
requests accept no `skip_prs`.

Both skip filing if an open issue with the same title already exists, found by searching GitHub. That
search is the only dedupe, and GitHub's search index is not immediate — two sessions that suggest the
same thing within a minute or two of each other can each file one. Deliberate: a duplicate suggestion
costs a maintainer one click, and hard-failing the check would cost you your document.

Filing never fails your run — a contribution is a side effect, and a GitHub outage must not cost
you a document you already paid for. It is logged as `agent_issue_failed` instead, with a hint
naming the likely cause when the failure looks like a permissions problem (usually: the GitHub App
is not installed on `upstream_repo`).

A deployment can set `github.issue_token` to a service-account PAT to file everything under one bot
account instead. That is **not recommended** and it is off by default: it erases the attribution
that is the point of the design. Use it only where an org policy forbids filing as users.

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

This is the same script CI runs on every PR, and its output is handed to the automated reviewer as
evidence rather than re-run by it (PRD §7.14, and
[Automated code review](../README.md#automated-code-review)). So a change that breaks a request or
response documented above surfaces as a blocking review finding quoting the failure — which is why
this file is in the reviewer's scope: the API docs are part of the contract, and docs that now
contradict the code are treated as a real defect.
