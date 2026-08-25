# Equalify Iris — API Guide (bash / curl)

Every endpoint is under `/v1`. All responses are JSON unless noted. Every endpoint except
`/v1/health`, `/v1/stats` and `/v1/auth/*` requires `Authorization: Bearer <github_token>`
(PRD §9.1) — with one exception, `/v1/quality`, which takes a bearer token that is **not** a
GitHub token (§0c).

These commands are copy-pasteable. They are the same calls exercised by `test/e2e.sh`, which
runs the whole lifecycle against mock GitHub + mock model services and asserts every response.

Requests are rate limited per client, and every response says how much of the budget is left:
§3.2 has the numbers, the headers, and what a `429` looks like.

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
{ "pages_processed": 1284, "documents_processed": 212, "since": "2026-05-22T18:00:00.000Z",
  "quality": { "window_days": 30, "documents": 212, "clean_rate": 0.93, "mean_rounds": 1.8 } }
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
* `quality` — how *well* it went, or **`null`** when the deployment has too few recent documents to
  say (below). Present either way, so a client can tell "nothing to report" from an older server
  without the field. Four fields, and no more:
  * `window_days` — the window the two rates cover, echoed so a client can write "over the last 30
    days" without hardcoding it. Fixed at 30 and **not** caller-adjustable: this endpoint takes no
    parameters, which is what keeps its single shared cache entry correct for everyone, and a public
    `?days=` would let anyone narrow the window until the denominator was one document.
  * `documents` — the denominator: documents delivered inside the window, flawless ones included.
    Distinct from `documents_processed`, which is all-time.
  * `clean_rate` — share (0–1) of those documents whose review loop ended with the **reviewer**
    reporting nothing left open. The complement of §0c's `unresolved_rate`, stated the positive way
    round because this one is read by someone deciding whether to trust Iris with a file. Note what
    it is *not*: it is the Reader Agent's remaining-issue list, not the final axe result, so a
    document carrying a violation the reviewer never raised still counts here. §0c can see that gap
    (its `rules` come from the final lint of the same run); this field cannot, which is why the demo
    page's sentence credits the reviewer rather than saying the document came out clean.
  * `mean_rounds` — mean reader/editor passes per document. **0 is the good value:** the loop stops
    as soon as the Reader finds nothing, so a document that reads clean immediately contributes 0.

`quality` is `null` until the window holds at least 20 documents (`PUBLIC_QUALITY_MIN_DOCUMENTS`),
and that floor is a privacy control, not a presentation choice. A rate over three documents is not
a measurement — one bad afternoon reads as "67% clean" on a front page — and, more to the point, on
a quiet deployment the aggregate *is* the individual: "50% finished clean" next to a document count
of four is a statement about identifiable people's uploads. The floor is enforced in
`Store.publicQuality`, not in the route, so a future route edit that reads the fields it wants
cannot walk around it. Below the floor the answer is `null` rather than zeros, because a route has
no way to tell a real 0% from an absent one and "0% clean" is the worst claim the field can make.

**The floor bounds a snapshot, not a series of them.** `documents` and `clean_rate` together give an
exact integer count of unresolved documents, and `documents_processed` deltas were already
inferrable before `quality` existed — so an observer polling this endpoint on a deployment near the
floor can difference the readings over days and attribute unresolved status to a single document,
which is the inference the floor exists to prevent. Nothing identifying is exposed (no login, no
filename, no per-document timestamp), so out-of-band knowledge of who uploaded when is needed for it
to mean anything, and it is inherent to publishing any windowed rate rather than specific to these
fields. An operator for whom that matters should treat it the same way as the page-count delta above:
keep the endpoint off the public internet.

Volume is all-time while quality is windowed, which is deliberate rather than an inconsistency: an
all-time rate converges and stops responding to a fix, while an all-time page count is the
achievement being reported. No rule ids here, unlike §0c — a standing list of what Iris still fails
at belongs in front of the people who would fix it, not on a public page.

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

## 0c. Quality tally (shared secret, off by default)

How *good* the output has been, as opposed to how much of it there was. Iris already measures
itself on every run — how many reader/editor rounds a document needed, which axe-core rules its
HTML still violates, whether a link from the source went missing — and this is the only place
those measurements are readable across sessions (PRD §7.16).

It exists for one caller: `.github/workflows/quality-report.yml`, which reads it weekly, compares
the rates against thresholds held in that workflow, and files a GitHub issue when one is crossed.

```bash
curl -s -H "Authorization: Bearer $IRIS_QUALITY_TOKEN" "$BASE/quality?days=30"
```
```json
{
  "window_days": 30,
  "documents": 212,
  "since": "2026-07-14T00:00:00.000Z",
  "mean_rounds": 1.8,
  "unresolved_rate": 0.07,
  "links_dropped_rate": 0.02,
  "lint_error_rate": 0,
  "rules": [
    { "id": "heading-order", "impact": "moderate", "documents": 81, "share": 0.382, "nodes": 240 }
  ]
}
```

* `documents` — delivered documents in the window, **including flawless ones**. This is the
  denominator for every rate below, and it is the whole reason the tally is stored the way it is: a
  clean run produces no violation rows, so counting "documents that had a problem" would divide by
  the bad documents alone and report every rate near 100%.
* `mean_rounds` — mean **editor** passes per document, against `defaults.max_review_iterations`. The
  loop stops as soon as the Reader finds nothing, so a document that reads clean on the first look
  contributes `0`: low is good, and `0.0` across the window means nothing needed fixing. `null`,
  not `0`, when nothing has run — otherwise an empty deployment reports the best possible score.
* `unresolved_rate` — share of documents that finished with issues the review loop could not
  resolve. Only the **count** of those issues is used, never their text — see below. One class of
  issue is deliberately never resolved and so always lands here: two headings the document labels
  alike where nothing the copy editor was given says whether they are one section or two. It is
  reported and left standing rather than guessed at, because merging two real sections cannot be
  undone — so a document with one spends the full `max_review_iterations` and raises this rate and
  `mean_rounds` together, which is the honest reading: it shipped with an ambiguity a reader meets.
  A `[not legible]` marker can end the same way: the copy editor is usually given that page's image
  and may well read what the extractor could not — usually, because the per-round image budget
  (`capEditorImages`) and a provider that refuses a request for size both leave it with fewer images
  than the issues named, or none. Where the image is absent, or the marks do not resolve for it
  either, the marker stays and the issue is reported unresolved every round. That is the source page being
  unreadable, not the pipeline failing to try, and the alternative — a plausible word, or a quiet
  deletion — is the one outcome a reader cannot detect. A `[page not fully transcribed]` marker
  always ends this way, by design: no pass in the review loop can resolve it, because finishing a
  page means returning the rest of it on top of the whole corrected body, and a response that hits
  its ceiling ends the run with nothing delivered. So it is reported every round and left standing,
  and it raises this rate for a document that is otherwise sound. Read it as what it is — one page
  arrived short, and the document says where.
* `links_dropped_rate` — share of documents where an `href` present before the copy editor was
  missing after it.
* `lint_error_rate` — share of documents whose lint pass **errored** instead of running. Recorded
  explicitly rather than inferred, because `runAxe` degrades to "no violations" when axe cannot run
  at all, so a broken linter would otherwise read as a deployment that got better.
* `rules[]` — axe-core rule ids, **per document**: `documents` is how many documents violated the
  rule and `share` is that over `documents` above, with `nodes` (total offending elements) alongside
  rather than folded in. One pathological scan with 400 bad headings is a worse `nodes` and the same
  `documents` as any other single failure — "fails on 40% of documents" names a prompt defect,
  while "is 90% of our violations" moves when an unrelated rule is fixed.
* `window_days` — the window actually used, echoed back. `?days=N` is clamped to 1–365 and a
  garbled value falls back to 30, so read this rather than assuming what you asked for. Windowed
  rather than all-time on purpose: an all-time rate converges and stops responding to a fix.

**Nothing here can carry document content, and that is a hard constraint rather than a
convention.** The consumer copies these values into a *public* GitHub issue, and the documents
behind them are user uploads — at the reference deployment, student records. Rule ids come from
axe-core's fixed vocabulary and are safe to publish; the review loop's unresolved-issue
descriptions are model-written prose about one person's document, which is why only their count
appears, and dropped `href`s came from the user's own PDF, which is why only their count appears.
A field added here that quoted a document would leak it through a path no reviewer of the workflow
would think to check.

**Off unless configured**, and unset means **404**, not 401: a deployment that has not opted in
does not acknowledge the endpoint at all. Set `server.quality_token`
(`IRIS_QUALITY_TOKEN`) to a long random value — `openssl rand -hex 32` — and restart. This is the
one endpoint not behind the GitHub user auth: the data belongs to no user, and the caller is a CI
job with no GitHub identity, so a per-user credential is the wrong shape for it. Responses carry
`Cache-Control: no-store` and are cached in-process for five minutes.

Two more values live in the repo that reads it — the `QUALITY_URL` **variable** (the deployment's
**origin**, no `/v1`: the job appends the path, and a value carrying one produces a 404 that looks
exactly like a deployment which never opted in) and the `QUALITY_TOKEN` **secret**, byte-for-byte the
token above. Verify the pair with `gh workflow run quality-report.yml -f dry_run=true` rather than
waiting for the weekly schedule; README's "Weekly quality report" section has the full procedure,
including why a green run that declines to file is the expected result on a young deployment.

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
Accepted file types: PNG, JPEG, GIF, WebP, **and PDF**. A PDF is rasterized server-side into
one image per page (in page order) and processed like any other page sequence. Total pages
(across all parts) are capped per deployment.

Each **image** part also has a size limit, and an upload over it is rejected here with a `400`
rather than accepted and failed later. The limit is not Iris's own: an uploaded image is passed
to the vision model byte for byte, so the model's per-image cap is the cap — currently **5 MB
base64**, which is **3.75 MB on disk**, on Amazon Bedrock. Ask the deployment instead of
assuming, since it moves with the configured model and provider:
[`GET /v1/limits`](#31-upload-limits-unauthenticated). A **PDF** is not measured against that
limit — the file you send is not what reaches the model, since Iris rasterizes its pages at its
own resolution — but each *rendered page* is, and a page over it fails with a `400` naming the
page and the PDF. That happens with large-format pages: rasterizing at a fixed DPI means the
page image scales with the physical page, so a letter page renders well inside the limit and an
ARCH-D drawing does not.

Pixel dimensions are mostly **not** a limit worth planning around, and this is the common
misdiagnosis: a large-but-light image converts fine, while a small-but-heavy photo is what
fails. The model downscales anything over its long-edge limit (1568 px on Sonnet 4.6, 2576 px
on Claude 4.7 and later) before reading it, so extra pixels buy no fidelity — they only spend
bytes against the cap. Re-saving a 12-megapixel scan at 1568 px on the long edge, or as a JPEG,
loses nothing the conversion would have used. There is one hard ceiling, `max_dimension_px`
(8000 px on either edge): above it the model rejects the request outright rather than
downscaling, so Iris rejects it here instead, reading the dimensions from the file's header.

### 3.1 Upload limits (unauthenticated)

`GET /v1/limits` — unauthenticated. What this deployment accepts, resolved from the model and
provider it is configured to use, so a client never has to hardcode numbers that change when
the model does. The demo page states its file limits from this endpoint.

```bash
curl -s "$BASE/limits" | jq
```
```json
{
  "max_pages": 25,
  "image": {
    "max_bytes": 3932160,
    "max_long_edge_px": 1568,
    "max_dimension_px": 8000,
    "media_types": ["image/png", "image/jpeg", "image/gif", "image/webp"],
    "extensions": [".png", ".jpg", ".jpeg", ".gif", ".webp"],
    "hint": "Each image must be under 3.7 MB and in one of PNG, JPEG, GIF, WEBP format. …"
  },
  "pdf": { "max_pages": 25 },
  "upload": { "max_files": 25, "max_request_bytes": 134217728 },
  "rate_limits": {
    "general_per_minute": 240,
    "auth_per_minute": 60,
    "upload_per_minute": 12,
    "max_upload_memory_mb": 256,
    "window_seconds": 60
  }
}
```

`max_bytes` is what `POST /v1/sessions` enforces per image part, and `hint` is the same sentence
its `400` carries — quote it rather than composing your own, and the two cannot disagree.
`max_bytes` and `max_dimension_px` are both enforced — the second only when the dimensions can be
read from the file's header, since a header Iris cannot parse must not become a rejection;
`max_long_edge_px` is advice, not a limit —
nothing rejects an image for exceeding it, because the model downscales past it instead of
failing. If a client can only surface one number, surface `max_bytes`: it is what nearly every
rejected upload will have broken. The model and provider that produced these numbers are
deliberately not named here; that is deployment detail, and this endpoint answers a question
about files.

`upload` is what one **request** may be, as opposed to what one image may be: `max_files` parts and
`max_request_bytes` across all of them. They are refused at different moments, which matters if you
are streaming: the byte total is checked before the body is read (or counted as it arrives, when the
request declares no length), while the part count is refused during parsing, once a part past
`max_files` appears. `rate_limits`
is how often you may ask (§3.2), and is `null` on a deployment that does not limit requests in the
app — which means "not limiting", not "unknown".

A PDF's **links survive**, which rasterizing alone would not manage: a link is an annotation
over the page rather than something drawn on it, so the page image carries the link text and
none of its target. The link targets are read out of the file separately and given to the page
agent as ground truth, and the output's `<a href>`s are checked against them — the run log
carries a `page_links` line per page that had any, and `page_links_missing` /
`page_links_unrecovered` when one did not make it into the HTML. Three kinds are dropped on
purpose: links to a destination inside the same document (the page they point at is in the
delivered HTML already); any URL whose scheme is not `http(s)`, `mailto`, `tel`, or `ftp` — a
PDF can carry a `javascript:` action, and that is not something to re-emit into a document —
and any URL containing a character that would end the attribute it is written into (a quote,
`<`, whitespace), which no legitimate URL carries unencoded. A link over an image with no text
under it has nothing to attach to and is lost.

Recovering a link never costs a page its structure. When a page passed its fidelity check and
is re-rendered only to attach a link, the rewrite is verified in turn, and one that lost
something — a heading level, a `<th scope>` — is discarded in favour of the fragment that
passed, logged as `page_links_correction_rejected`. A link is additive; the accessibility of a
page that already checked out is not something it may be paid for with.

`status` is `queued` on creation and becomes `running` when the pipeline actually starts. Those are
usually the same instant, but a deployment runs at most `defaults.max_concurrent_runs` pipelines at
once (default 2): beyond that, the session **waits in `queued`** — in FIFO order, for as long as it
takes — rather than being rejected. Nothing is lost; the upload is already stored. If a session sits
in `queued`, check its run log for `run_queued` / `run_dequeued` to see the wait rather than
assuming a hang.

### 3.2 Rate limits (how often you may ask)

A deployment limits requests at the HTTP layer, because it is a single process whose reads hit
SQLite synchronously — one client's runaway loop is felt by everyone, including the runs already
in flight. Three budgets, each per minute, all published by `GET /v1/limits`:

| Budget | Applies to | Default | Counted per |
| --- | --- | --- | --- |
| `general_per_minute` | everything under `/v1` except `/v1/health` | 240 | token if validated, else address |
| `auth_per_minute` | `/v1/auth/*` | 60 | address (there is no token yet) |
| `upload_per_minute` | `POST /v1/sessions` | 12 | user |

Every response carries the budget it was counted against, so a client can pace itself without
being refused first:

```bash
curl -si "${AUTH[@]}" "$BASE/sessions" | grep -i '^ratelimit'
# ratelimit: limit=240, remaining=238, reset=41
# ratelimit-policy: 240;w=60
```

Over budget is a `429` with `Retry-After` (seconds) and the standard error body:

```json
{ "error": { "code": "rate_limited",
             "message": "Too many requests: this deployment allows 240 per minute per client. Retry in 41s.",
             "details": { "limit": 240, "window_seconds": 60, "retry_after_seconds": 41 } } }
```

**Wait `Retry-After` seconds; do not retry immediately.** A tight retry loop spends the next
window before it opens. If you are polling a session, poll every 2–5 seconds — a conversion takes
minutes, and nothing changes faster than that.

Two more refusals concern uploads specifically. Both normally answer **before** the body is read,
so a rejected upload costs you nothing but the round trip — the one exception is a request that
declares no length, which can only be refused while it is arriving:

- `413 upload_too_large` — the request is bigger than `upload.max_request_bytes`. Retrying it
  unchanged will fail again; split the batch across sessions. Normally answered from the declared
  `Content-Length` before a byte of body is read; a request that declares no length (chunked) is
  counted as it arrives and cut off at the same ceiling, mid-upload, with `received_bytes` in
  `details` instead of `declared_bytes`.
- `429 rate_limited` with `max_upload_memory_bytes` in `details` — too much upload is arriving at
  once across all callers (`max_upload_memory_mb`). This is about *bytes in flight*, not your
  request count, so small uploads are essentially never refused for it. Retry in a few seconds.

A token identifies you no matter which address you arrive from, so signing in is what gets you
your own budget: unauthenticated requests, and any bearer token this deployment has not validated,
count against your **address** — which you may be sharing with an entire campus.

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

**Image references do not resolve, by design.** A graphic on the page — a logo, a diagram, a
photograph — is emitted as an `<img>` with a description and a placeholder `src` naming the page
and the graphic (`src="page-1-logo.png"`), because the extractor sees a rasterized page and has no
asset to embed; the placeholder is also recorded in the run log. Iris serves no image endpoint, so
those references 404 until a consumer supplies the files. What a screen-reader user receives is the
`alt` text, which is the content the picture carries — but a client that renders this HTML in a
browser will show broken images, and one that rewrites the `src`s has the log and the fragment to
match them against.

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
| `reextract_start` / `reextract_complete` | Which pages went back to the page agent. `reextract_complete.pages` is what was actually re-extracted; a `failed` list is pages whose re-extraction threw and which therefore kept their **prior** content unchanged. |
| `page_extraction_failed` | One page's own extraction threw (`page`, `image`, `error`). The rest of the document still ran — see §7c. `kept: "prior"` marks the feedback-re-extraction case, where the page keeps the content it already had and the document stays whole. |
| `extraction_complete` | How many page fragments came out (`pages`) and which page numbers failed (`failed`, always present, `[]` on a whole run). |
| `page_recovered` | A feedback re-extraction succeeded on a page an earlier run had lost, so the document is whole again for those `pages`. Logged late in the run, once that document has been persisted: a round that re-extracts the page and then throws in review leaves the earlier document — hole and all — as the one the session holds. |
| `extraction_failed` | **Every** page failed, so the run is ending rather than delivering a document with no content in it. The `run_failed` line that follows carries the first page's provider error. |
| `page_verify_ok` / `page_verify_failed` | The Feedback Agent's fidelity verdict on one page, checked against its source image. A failure names its `problems` and buys that page one self-correction pass. A page that passes can still be re-rendered (a dropped link), so a run's `page` call count is `pages + corrections`, not `pages + failures`. |
| `page_corrected` | What a self-correction pass did (`trigger`: `verify`, `links` or `both`; `problems`: how many it was given). `result` is `kept` (it changed the delivered document), `rejected` (discarded to keep a page that had already passed — links path only), `identical` (it changed nothing about the page) or `empty` (nothing usable came back); the last two are calls paid for that bought nothing. `identical` is decided on the **effect**, not on string identity, so a model that returns its own page re-indented or with `&` for `&amp;` is counted here rather than as `kept`. Note that such a fragment is still **adopted** — what ships is decided on string identity, deliberately, so that a change no signal here observes cannot be silently reverted; `identical` means the page call bought nothing, not that its output was discarded (that is `rejected`). Two shapes of `identical` are worth telling apart, and field presence is what tells them apart: with `chars_before` / `chars_after` and all four flags `false`, the model re-typed the page to no effect; with no sizes and no flags at all, it handed back the exact string it was given. Same bill, different behaviour. When it changed something, `text_changed` / `alt_changed` / `attrs_changed` / `structure_changed` and `chars_before` / `chars_after` say **what** changed — observed on the two fragments, not claimed by the verdict, so an alt-text refinement, a re-typed `href` and a restored table row are distinguishable. |
| `page_correction_recheck` | A second verdict on a corrected page (`ok`, `problems`). `binding: true` is the links path re-verifying a rewrite it may discard; `binding: false` is a measurement-only sample, one page per batch, which changes nothing about what is delivered. The two are counted apart in `verification.rechecks`; `sampled_ok / sampled` across many runs is whether correction converges. |
| `page_correction_recheck_failed` | The measurement-only sample could not be taken — the extra Feedback Agent call hit a provider error (`error`). Logged rather than raised: the page ships as it would have with no measurement at all, and the batch's one sample slot stays spent, so a throttled provider is not retried once per corrected page. A `binding` recheck has no such line, because there the verdict decides whether the rewrite is kept. |
| `editor_images` | How many source images the Copy Editor received this round (`attached` of `of`, plus `pages`). A `dropped` count means the selection did not fit in one request and was trimmed to the pages issues actually named. `attached == of` on a multi-page document means at least one issue in that round carried no page attribution, so the round asked for everything. |
| `editor_images_refused` | The provider refused the round's payload as too large, so the same prompt was re-sent **without** images. The correction still had the whole body and every issue; only a fidelity problem that must be checked against the source can go unfixed. |
| `editor_links_dropped` | An `href` present before that round's correction was missing after it (`iteration`, `hrefs`). A link's target came from the source **file**, not from a page image, so a dropped one cannot be recovered by looking again — logged rather than repaired, and counted into `links_dropped_rate`. |
| `editor_markers_changed` | The count of a `[not legible]` or `[page not fully transcribed]` marker changed across one correction round (`iteration`, `before`, `after`, plus `fewer` and/or `more`). `fewer` is expected where the editor read that region off the attached page image, and is a loss anywhere else — nothing downstream can tell those apart, and no other signal sees it at all, since the flattened view strips bracketed tokens before comparing words. `more` is a placeholder written over words the extractor did read, which no instruction in the loop allows. |
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
  "tokens": { "input": 43200, "output": 19400, "cache_read": 2500, "cache_write": 2500, "calls_reported": 7 },
  "by_agent": { "page": { "count": 2, "total_ms": 28200, "max_ms": 15100,
    "input_tokens": 16400, "output_tokens": 9100,
    "cache_read_input_tokens": 2500, "cache_creation_input_tokens": 2500 } },
  "slowest_calls": [ { "agent": "table", "model": "...", "capability": "vision", "duration_ms": 14300, "ok": true } ],
  "errors": [],
  "verification": {
    "pages_verified": 25, "verify_failed": 13, "corrections": 14,
    "results": { "kept": 12, "rejected": 0, "identical": 2, "empty": 0 },
    "triggers": { "verify": 13, "links": 1, "both": 0 },
    "effects": { "alt_only": 4, "text": 8, "attrs": 3, "structure": 6 },
    "rechecks": { "sampled": 1, "sampled_ok": 1, "binding": 1, "binding_ok": 1 }
  },
  "pages_failed": []
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

`tokens` is what the run **consumed**, and `by_agent` carries the same four counts per agent
(under the names the run log uses: `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
`cache_creation_input_tokens`) — so "which agent is slow" and "which agent is expensive" can be
answered separately, because they are often different agents. Deliberately no dollar figure: the rate depends on the provider,
region and model, all of which are deployment config, so the token counts are reported and
whoever holds the price sheet does the multiplication. The four counts bill at four different
rates and are never summed here; note that `input` **excludes** tokens read from the cache, so the
whole prompt is `input + cache_read + cache_write`.

The last two are non-zero because Iris asks the model to cache the part of each prompt that does
not change: the agent's own system prompt, which is identical on every page of every document, and
— on the fidelity check — the contract of the agent it is judging, which that task re-states in
full on every page and which is the largest single constant Iris sends.
Expect a `cache_write` on the first calls of a run and a `cache_read` on every call after them —
a handful of writes rather than exactly one, because pages are converted concurrently
(`defaults.extraction_concurrency`), so the first few calls of a phase go out together before any
of them has written the entry the others would have read. A request may carry more than one cached
prefix — the fidelity check caches its system prompt and the contract it is judging — and they
share one `cache_creation_input_tokens` figure on that call's `model_call` line rather than
appearing as separate writes. So
on a long document the same prefix is paid for a few times at 1.25× instead of 25 times at 1×, and
every other call reads it at 0.1×. A run that shows `cache_read: 0` with several calls to the same agent is a run that
is paying full price for the same instructions repeatedly — the cases where that is expected are a
model whose id Iris cannot recognize as a Claude model, a model generation older than caching
support (Iris asks from 3.7 on), an agent prompt too short to be cacheable (the platform minimum is
~1k tokens), and a deployment that set `prompt_cache: false` on the provider block.

`cache_write` is the weaker signal of the two, and a zero there means less than a zero read. It is
reported by the provider, and on an OpenAI-shaped upstream the field it would come from is
undocumented, so a deployment can see reads climbing with writes sitting at 0 forever. That is a
cache working and a counter staying quiet, not a cache half-broken; `cache_read` is what tells you
whether the asking is paying off. Whichever way these two land, the caching changes nothing about
the converted document — it is the same prompt either way, so these are cost fields and not quality
ones.

One caveat on that sum, for whoever is doing the multiplication. It is exact on a provider that
reports the four counts as disjoint sets, which is what the Anthropic-shaped APIs do. On an
OpenAI-shaped one, cache reads are reported *inside* the prompt total and are subtracted back out
here, but whether cache **writes** are also inside it is undocumented — so where they are, they
are counted once as `input` and again as `cache_write`, and the sum is high by that amount.
Over-counting is the deliberate choice: the alternative subtracts a number that may never have
been in the total, which understates the prompt and reports a cache as cheaper than it was.

`calls_reported` is how many of `model_calls.count` reported any usage at all. When it is lower
than `count`, these sums cover only part of the run — a cost derived from them is a floor, not
an estimate. Some upstreams report nothing; a call that stalls knows its prompt size but never
learns its output size. Failed calls **are** counted, because a truncation has already paid for
a full ceiling of output and a stall for its prompt.

`verification` is what the verify-then-correct loop did. Every page is checked against its source
image and a page that fails is re-rendered once, so a run's `page` call count is
`pages + corrections` — on three real 25-page runs the Feedback Agent rejected 58 of 75 pages,
which makes the "correct if needed" pass mandatory in practice and put verification alone at 24% of
one document's bill. `corrections` and **not** `verify_failed`: a page that passed its check is
re-rendered too when the code finds a link the model dropped, and that costs the same page call, so
`triggers` is the split — `verify` is a page the Feedback Agent rejected, `links` a page that passed
and lost a link, `both` one that did each. `verify_failed / pages_verified` is the rejection rate; the
raw counts are reported rather than the percentage, because a rate over three pages is not a
measurement.

The fields answer different questions about the same loop. `results` is what the corrections
**cost**: `identical` and `empty` are page calls paid for that produced no change at all. `effects`
is what they **did**, read off the two fragments rather than taken from the verdict, which is what
separates a refined alt text from a restored table row — both are one `page_verify_failed` line.
`text` and `structure` are not exclusive (a re-render is usually both); `alt_only` is the count that
stands alone, and a run where it dominates is spending a page call per page on image descriptions.
`attrs` is every attribute but `alt`, which is where the cheapest real fixes live — an `href` the
model re-typed, a missing `<th scope>`, an `aria-describedby` — a correction that moves no word and
still matters.
`rechecks` is whether correction **converges**: `sampled_ok / sampled` is a corrected page that had
FAILED its check, verified a second time to see whether the re-render fixed it. One sample per batch
is deliberate — re-verifying every corrected page would roughly double the share of the bill the
question is about — so it is a fleet number that accrues over runs, not a verdict on any single
document. `binding` is counted apart from it and not added to it: those are the links path's own
re-verifications of pages that had already **passed**, kept or discarded on the verdict, so their
ok-rate answers "did a rewrite of a good page stay good" — a different question, and on a link-heavy
PDF there is one per page, enough to swamp the sample if the two were summed.

Nothing in here gates anything. A verify-driven correction is accepted exactly as it was before
these fields existed; whether to re-render until a page passes, or to run a cheaper verifier, is a
policy question that needs the rate first. Like `model_calls`, the counts sum over every run a
session has had, so a feedback round that re-extracts three pages adds three more verifications.

`pages_failed` is the set of source pages the delivered document has no content for, because their
own extraction threw (§7c). It has its own field
because a run that reaches `ready_for_review` without one of its pages is otherwise
indistinguishable here from one that delivered the whole document: the failed model call
underneath shows up in `errors` exactly as a retried-and-recovered one does, and `status` says the
run succeeded — which it did, on 24 of 25 pages.

It reports the document's current state, not the session's history: a session's log accumulates
across feedback rounds, so a page lost in round 1 and re-extracted in round 3 (`page_recovered`)
leaves this list, while one that failed again is still in it.

## 7c. Partial documents

A page's extraction can fail on its own (a model call that hits the output ceiling, a stalled
stream). That page fails; the run does not. Every other page is still rendered, verified,
assembled and reviewed, and the document is delivered.

**Unless every page failed.** Then the run ends `failed`, with the page's own provider error as
`error` — a document containing none of the source's words is not a partial success, and the error
naming the ceiling and the knob to raise is more use than an empty file. `GET .../output` answers
`409`, as it does for any failed run.

The failed page is **not** silently dropped. Two comments say so, in different places and for
different reasons:

```html
<main>
<!-- @page-failed 7: bedrock: response hit the 32000-token output ceiling and was truncated (87851 chars returned). ... -->
</main>
<!-- @page-failed 7
  This document is incomplete: the source pages above could not be extracted and
  none of their content is here. See the run log (page_extraction_failed) or the
  session's diagnostics (pages_failed) for why.
-->
```

The one **inside** `<main>` sits where the page's content would have been, so it says *where* the
hole is — but it is part of the body handed to the Copy Editor each review round, and a round that
rewrites the document may drop it. The one **after** `</main>` is injected once the review loop is
finished, out of the editor's reach, so the document cannot end up claiming to be whole. Comments
rather than visible prose, for the same reason as `@unresolved`: everything visible in a delivered
document is meant to be text that was on the page. Both are invisible to a reader, inert to axe and
to the screen-reader flattening, and findable by tooling.

Three places report it, in increasing order of convenience: `page_extraction_failed` in the run log
per page, `failed_pages` on the `run_complete` line (present only when there were any), and
`pages_failed` in diagnostics (§7b). A client that cares whether it received a whole document
should check the last of those, not `status`.

On a feedback re-extraction the same failure is non-destructive instead: the page keeps the content
it already had, because a page Iris could not improve is not a page it lost. That case is
`page_extraction_failed` with `kept: "prior"`, and it is deliberately **not** counted in
`pages_failed` or `failed_pages` — the document is whole, it is just not improved. Look for it in
`reextract_complete.failed`.

A missing page stays missing across feedback rounds, and every round's document says so: the set is
a property of the document, not of the run that lost the page. Sending feedback that names the
failed page is what fixes it — re-extracting it successfully removes it from the set and logs
`page_recovered`. Nothing else does, so `failed_pages` on round 3's `run_complete` still names a page
lost in round 1 if it is still not there.

Pages missing from the delivered document are also excluded from the regression fixtures captured on
`POST .../close`: a fixture asserts that some HTML is the *right* output for a page image, and a
failure comment is not.

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
- **Agent improvements** (`Agent update proposal: <agent> — <lesson>`) — when your `/feedback`
  produces a change that generalizes beyond your document, and it survives the agent's regression
  fixtures. The title carries a short slug of the lesson as well as the agent, and the issue body
  carries the lesson, how many sessions have reported it, and your feedback verbatim.

Both are filed with **your** token, so the issue carries your GitHub identity and the credit is
yours. There is no PR/fork flow (deviation from PRD §7.13): `/close` returns no `prs_opened` and
requests accept no `skip_prs`.

Both dedupe against an open issue with the same title, found by searching GitHub — a new agent
suggestion skips, an agent improvement **comments on the existing issue** with your session and the
updated proposal. The improvement path has to do more than skip because its title is not unique per
document: every proposal targets the same `page.md`, so before the lesson slug was in the title, one
open issue silently discarded every later lesson from every user for as long as it stayed open. A
lesson never disappears now — worst case it lands as a comment on a related issue.

That search is the only dedupe, and GitHub's search index is not immediate — two sessions that report
the same thing within a minute or two of each other can each file one. Deliberate: a duplicate costs
a maintainer one click, and hard-failing the check would cost you your document.

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
`invalid_request` (400), `rate_limited` (429, carries `Retry-After` — see §3.2),
`upload_too_large` (413).

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
