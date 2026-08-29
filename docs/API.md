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
  * `clean_rate` — share (0–1) of those documents the **reviewer** read in full and reported nothing
    left open on. Stated the positive way round because this one is read by someone deciding whether
    to trust Iris with a file. It is 1 − (§0c's `unresolved_rate` ∪ `review_unread_rate`), not the
    complement of the first alone: a document part of which the reviewer never answered about has
    nothing open because nothing was looked for, and counting that as clean is what made this field
    worth doubting (#186). Note also what it is *not*: it is the Reader Agent's remaining-issue list,
    not the final axe result, so a document carrying a violation the reviewer never raised still
    counts here. §0c can see that gap (its `rules` come from the final lint of the same run); this
    field cannot, which is why the demo page's sentence credits the reviewer rather than saying the
    document came out clean.
  * `mean_rounds` — mean reader/editor passes per document. **0 is the good value:** the loop stops
    as soon as the Reader finds nothing, so a document that reads clean immediately contributes 0.
    It is not *only* a good value, though, and this number cannot tell the two apart: the loop also
    stops as soon as a round changes nothing, so a document whose remaining issues are ones the
    loop is designed not to fix contributes a low count too. Read it beside `clean_rate`, which
    convergence can only move DOWNWARD — stopping early can report issues a further Reader sample
    might have called clean, never the reverse. So
    a falling `mean_rounds` beside a steady `clean_rate` is the loop wasting fewer rounds; a
    falling `mean_rounds` is not by itself evidence of anything improving.

`quality` is `null` until the window holds at least 20 documents (`PUBLIC_QUALITY_MIN_DOCUMENTS`),
and that floor is a privacy control, not a presentation choice. A rate over three documents is not
a measurement — one bad afternoon reads as "67% clean" on a front page — and, more to the point, on
a quiet deployment the aggregate *is* the individual: "50% finished clean" next to a document count
of four is a statement about identifiable people's uploads. The floor is enforced in
`Store.publicQuality`, not in the route, so a future route edit that reads the fields it wants
cannot walk around it. Below the floor the answer is `null` rather than zeros, because a route has
no way to tell a real 0% from an absent one and "0% clean" is the worst claim the field can make.

**The floor bounds a snapshot, not a series of them.** `documents` and `clean_rate` together give an
exact integer count of not-clean documents, and `documents_processed` deltas were already
inferrable before `quality` existed — so an observer polling this endpoint on a deployment near the
floor can difference the readings over days and attribute not-clean status to a single document,
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
  "links_unresolved_rate": 0.11,
  "markup_unbalanced_rate": 0.01,
  "table_no_body_rate": 0.005,
  "lint_error_rate": 0.01,
  "documents_linted": 210,
  "editor_truncated_rate": 0.01,
  "editor_truncated_lost_rate": 0.002,
  "review_unread_rate": 0.01,
  "rules": [
    { "id": "heading-order", "impact": "moderate", "documents": 81, "share": 0.382, "nodes": 240 }
  ]
}
```

* `documents` — delivered documents in the window, **including flawless ones**. This is the
  denominator for every `_rate` below (the rule table divides by `documents_linted` instead, for the
  reason given there), and it is the whole reason the tally is stored the way it is: a
  clean run produces no violation rows, so counting "documents that had a problem" would divide by
  the bad documents alone and report every rate near 100%.
* `mean_rounds` — mean **editor** passes per document, against `defaults.max_review_iterations`. The
  loop stops as soon as the Reader finds nothing, so a document that reads clean on the first look
  contributes `0`: low is good, and `0.0` across the window means nothing needed fixing. `null`,
  not `0`, when nothing has run — otherwise an empty deployment reports the best possible score.
  It also stops as soon as a round changes nothing: an editor that answers and returns the document
  it was given has said what it would say to the same request next round, so the remaining rounds
  would rewrite the document into itself. That means a low `mean_rounds` beside a non-zero
  `unresolved_rate` is now an ordinary reading rather than a contradiction — the document stopped
  early *because* what was left could not be fixed here, not because it was fixed.
* `unresolved_rate` — share of documents that finished with issues the review loop could not
  resolve. Only the **count** of those issues is used, never their text — see below. One class of
  issue is deliberately never resolved and so always lands here: two headings the document labels
  alike where nothing the copy editor was given says whether they are one section or two. It is
  reported and left standing rather than guessed at, because merging two real sections cannot be
  undone — so a document whose only remaining issue is one of these raises this rate while its
  `mean_rounds` stays low: the first round that leaves it alone changes nothing and the loop stops
  there. That is the honest reading — it shipped with an ambiguity a reader meets, and the rounds it
  did not spend would each have rewritten the document into itself.
  A `[not legible]` marker can end the same way: the copy editor is usually given that page's image
  and may well read what the extractor could not — usually, because the per-round image budget
  (`capEditorImages`) and a provider that refuses a request for size both leave it with fewer images
  than the issues named, or none. Where the image is absent, or the marks do not resolve for it
  either, the marker stays and the issue is reported unresolved every round. That is the source page being
  unreadable, not the pipeline failing to try, and the alternative — a plausible word, or a quiet
  deletion — is the one outcome a reader cannot detect. A `[page not fully transcribed]` marker
  always ends this way, by design: no pass in the review loop can resolve it, because finishing a
  page means returning the rest of it on top of the whole corrected body, and a response that hits
  its ceiling ends that round's reading of the document — what the round still corrects is
  whatever the section-at-a-time retry rescues (`editor_truncated_rate` below). So it is reported
  and left standing, and it
  raises this rate for a document that is otherwise sound — but only for as many rounds as it takes
  the editor to leave the document alone once, which is what now ends the loop. Read it as what it is — one page
  arrived short, and the document says where.
* `links_dropped_rate` — share of documents where an `href` present before the copy editor was
  missing after it.
* `links_unresolved_rate` — share of documents that shipped with an in-document reference that
  lands nowhere: an `href="#"`, or a fragment naming an `id` the delivered document does not
  contain. Counted per document; the per-reference numbers, and *which* ids failed, are on the
  deployment's `internal_links` log line and stay there, because a fragment is text the model chose
  out of the document. This is a different defect from `links_dropped_rate` — nothing was lost, the
  target was never there — and a document can have either without the other. Neither shape is an
  axe violation, which is why it needed measuring at all: a table of contents where every entry is
  `href="#"` lints clean, reads as finished, and does nothing when a reader activates it. `#` and
  `#top` are excluded, being the two fragments a browser resolves without an element.
* `markup_unbalanced_rate` — share of documents delivered with markup that does not balance: an
  element whose end tag HTML **requires** (`table`, `ul`, `a`, `section`, … — never `<li>` or
  `<tr>`, whose end tags are optional and legally omitted) appearing a different number of times as
  a start tag and as an end tag. The only rate here measured on the delivered **bytes**, and it has
  to be: an HTML parser repairs malformed markup before axe is given the document, so a document
  delivered with an unclosed `<table>` lints clean and reports `ready_for_review`. Which element,
  and the two counts, are on the deployment's `delivered_markup` log line — what the imbalance costs
  a reader depends entirely on which element it was.
* `table_no_body_rate` — share of documents delivered with at least one table holding no row a
  reader receives as content: no rows at all, no row outside a declared `<thead>`, or — where no
  header block was declared — no row that is anything but column headers. A screen reader
  announces the table, reads its caption and every column header, and there is nothing in it. A
  table whose body cells are all `<th scope="row">` is content and is not counted. Measured on the **parsed** tree, unlike the rate above,
  because this is a question about what a reader receives and parser recovery is part of that. No
  axe rule covers it — `empty-table-header` is about a header *cell* with no text — and the captions
  stay on the deployment's log line, a caption being text out of the user's own document.
* `lint_error_rate` — share of documents whose lint pass **errored** instead of running. Recorded
  explicitly rather than inferred, because a linter that cannot run has no violations to report and
  a broken one would otherwise read as a deployment that got better. Those documents are delivered
  with **no accessibility verdict at all**: the run's log line carries `lint_ok: false` and *no*
  `violations` figure (the count in a check that did not happen is unknown, not zero), and the
  delivered document carries an `@lint-unavailable` comment saying so to whoever opens it. The
  `assembly` line — and `lint_unavailable`, if a later correction round's re-lint is the one that
  failed — carries `lint_error` with `lint_error_where` (`parse`, `inject` or `run`),
  `lint_error_name` and the first frames of `lint_error_stack`, which is what makes one occurrence
  chaseable; `axe-core` and `jsdom` are pinned to exact versions so the linter's behaviour changes
  only when someone changes it.
* `documents_linted` — how many of `documents` the linter actually examined, i.e. `documents` minus
  the `lint_error_rate` ones. This is the denominator for `rules[].share`, and it is published
  because otherwise that share cannot be read: an unexamined document looks exactly like one where
  the rule did not fire, so a spell of failing lints would make every rule appear to be getting
  fixed. When it is well below `documents`, the rule table is a measurement of a subset — fix that
  before reading the rules.
* `editor_truncated_rate` — share of documents where a correction round's **response** hit the
  model's output-token ceiling. The editor is asked for the whole document, so its output length
  follows the length of the document rather than the number of issues in it: at a large
  `max_pages` an ordinary document doing exactly what it was told can exceed a fixed
  `max_tokens`. Such a round is re-made **a section at a time** — the body is cut at top-level
  boundaries into pieces sized from what the truncated response actually returned, and each is
  corrected on its own — and the loop then stops either way. So the document may carry that
  round's corrections (from requests that each saw one section, so a problem spanning two of
  them may be untouched) or none of them, if the body could not be divided or no section came
  back; the delivered `@editor-truncated` comment says which, and `editor_sections` in the run
  log says how many. This rate counts the ceiling being hit, whatever was rescued afterwards,
  and those documents are also counted in `unresolved_rate` — the issues in the `@unresolved`
  block are the reading that preceded the truncated round and were never looked for again.
  A non-zero value is a statement about the **deployment**, not about the documents: either
  `providers.<name>.max_tokens` is too low for the pages allowed per session, or `max_pages` is
  too high for it. It is deliberately the one rate here with **no threshold** in
  `.github/workflows/quality-report.yml`, and the rate below is why: on a 100-page document a
  whole-body rewrite does not fit under a 32,000-token ceiling and never will, so this number
  rises with document length alone — it went 1/4 → 2/4 → 3/4 across three bench rounds in which
  every section came back — and an alarm on it would fire on a pipeline that lost nothing (#159).
* `editor_truncated_lost_rate` — share of documents where that retry did **not** cover the whole
  body: it was declined or came back with nothing — the run log says which on an
  `editor_sections_declined` line, whose `reason` is one of `unmeasured`, `budget_too_small`,
  `budget_exceeds_body`, `indivisible` or `too_many_sections` — or a section truncated in its turn
  and kept the text it went in with, or a section that came back complete but with under half the
  prose it was given (`editor_section_failed`, `reason: "shrank"`). That last cause is why this
  rate is no longer only about the output ceiling: it also fires on the SHAPE of a reply — one
  section answered with a sentence about itself rather than with the section — and the remedy for
  that is not more `max_tokens`. The log line says which, and the two differ in what they cost a
  reader only in that the shrunk one had a reply and declined to trust it. This is
  the truncation number that carries a threshold, because it is the one that costs a reader
  something: those parts of the document had no editor pass at all, and a truncation is the loop's
  last round, so nothing looks for their issues again. A strict subset of `editor_truncated_rate`
  above and of `unresolved_rate` — it adds no documents to this tally, it says *why* those
  documents ended where they did, and the remedy it points at is a `max_tokens` or `max_pages`
  number rather than a prompt.
* `review_unread_rate` — share of documents where part of the reviewer's last read of them came back
  **unusable**, so some of the document has no review verdict at all. The document is read in windows
  (long ones in several), and a reply that carries no issue list this code can read — prose, an
  apology, `{"issues": "none"}` — is a window nobody got an answer about. It is recorded because
  without it that outcome is invisible in every other number here *and reads as the best one*: no
  issues were found, so there is no `iris:unresolved` row, so the document was being counted clean.
  This is the same principle as `lint_error_rate` above — an absent verdict must not count as a good
  one — and it is why `clean_rate` in §0b subtracts both. Not disjoint from `unresolved_rate`: the
  windows that *did* answer may have found issues. The delivered document carries a `@review-unread`
  comment saying how many windows of how many, and `reader_no_output` in the run log carries the
  reply's size and which of the two ways it failed. A non-zero value is a statement about the reader
  model or its prompt, and the run log's `agentCall` output for that call is where to start.
* `rules[]` — axe-core rule ids, **per document**: `documents` is how many documents violated the
  rule and `share` is that over `documents_linted`, with `nodes` (total offending elements) alongside
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

Both statements in that paragraph are documented for Claude, which is what a deployment normally
runs. One that runs a vision model Iris has no published limits for gets the same two numbers
enforced the same way — they are the conservative end of what is known — but they are then
stand-ins rather than facts about it: nothing promises that the model discards the pixels above
the long edge, and the 8000 px ceiling is Iris's rule rather than a refusal it has seen. This is
why `hint` is the thing to quote (§3.1): it is written from whichever of the two holds.

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

That last point is also why the advice about pixels lives in `hint` rather than in a field of its
own. A deployment may run a vision model Iris has no published image limits for, and then the two
pixel numbers are its conservative stand-ins rather than facts about that model — the same values,
enforced the same way, but not something to tell a user they can rely on. `hint` is written from
whichever of the two situations holds, so quoting it is always accurate; composing your own
sentence from `max_long_edge_px` is what can go stale, and this is a second reason not to.

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

**No correction may delete a page**, whatever triggered it. A self-correction pass is single-shot,
so what it returns is what the document keeps — and a reply that comes back at less than a quarter
of the size of the page it was given has not corrected that page. It is refused, the page it was
asked to correct is what ships, and the run log says so (`page_correction_rejected`).

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
appended if the review loop stopped with any still open — at its iteration cap, or on a round that
changed nothing, which is how a document whose remaining issues the loop is designed not to fix
ordinarily ends. A third stop reason adds a second comment: `<!-- @editor-truncated -->` says a
correction round's response hit the model's output ceiling — read together with `@unresolved`,
which on its own would say the editor tried and could not fix them (§0c
`editor_truncated_rate`). It comes in two forms, and the difference is what corrections the
document in your hand contains. `@editor-truncated sections C of N` means the round was re-made a
section at a time and `C` of `N` sections came back corrected, so those corrections **are** here
but each was made by a request that saw one section and not the rest of the document; the
`@unresolved` list is the reading that preceded them and was never taken again, so some of it may
already be fixed. The bare `@editor-truncated` means nothing was rescued — the round was
discarded and **none** of the issues below it were worked on. The bare form, and `C` short of `N`
in the first, are what `editor_truncated_lost_rate` counts deployment-wide; `C` equal to `N` is a
document that cost more and lost nothing. A third comment,
`<!-- @lint-unavailable -->`, says axe-core could not run on this document at all, so **nothing**
in it was checked for accessibility violations and an empty `@unresolved` is not a clean bill of
health (§0c `lint_error_rate`). Returns `409` while the session is still running.

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
| `page_no_output` | The page agent answered, and no HTML could be read out of the answer (`page`, `image`, `chars` of text, and the `shape` it was in). The page is then lost the way any failed page is lost — the `page_extraction_failed` line below follows it — because "the reply could not be read" and "this text is the page" are different claims, and a reply delivered as content puts a JSON envelope, or an apology, into the document while the run reports every page delivered. `shape` names the remedy: `truncated_envelope` is the output ceiling (raise `providers.*.max_tokens`), `envelope` is a complete reply whose escaping defeated the parser (rare, because a reply whose only fault is the page's own unescaped punctuation is repaired before it reaches here), `prose` is the agent answering conversationally, `empty_html` is an envelope that was read perfectly and carried no page in it (no `html` key at all, or one whose HTML holds nothing a reader receives and whose `log` does not say the page is blank — the model answering with no page and not saying why, or saying it could not read it), and `empty` is a reply with nothing in it at all. "Nothing a reader receives" is not the same as "an empty string": a comment, an empty wrapper and a bare page-break marker are all nothing, and 33 of 818 initial renders in the bench logs answered a blank page in one of those spellings rather than with the empty `html` the prompt asks for (issue #219), so a refused declaration reaches this line whichever way its fragment was written. The last three are prompt problems and say nothing about the parser. A page the agent reports as **blank** is not one of them: that is `page_blank` below and not a failure. Where markup did arrive and carried nothing, `dropped` carries it — the same field, and the same 200-character bound, as on `page_blank` below — because `chars` is the length of the whole reply and not of the fragment, so without it the line says a page produced nothing readable and not whether that was an empty envelope, a comment or a marker naming a folio the paper never printed. On a refused declaration that is the difference between triaging the wording from a run and replaying the replies to find it, which is the half of #219's reconstruction its fix left behind (issue #223). Where the reply *did* claim the page was blank and the claim was refused, more fields say so: `blank_vetoed` lists the doubt words that refused it and `log` carries the agent's own sentence. Without them the line reads as "the model answered with no page", which is the opposite of what happened, and tracing four such pages back to a word meant rerunning the regexes on the replies by hand (issue #190). `blank_contradicted` is the other way a claim is refused, and a different finding: the log declared the page empty and then said something was on it, and the field carries the words that said so (issue #194). The page's own printed number is the one thing a log may name without contradicting itself (issue #222): a folio is not content that page could have delivered, so `blank apart from the printed page number` and `blank except for its printed folio` are declarations rather than refusals, while `the printed page number and a heading are visible` still refuses — through the heading, which is what a reader would have got nothing of. They are two findings with two remedies — a doubt word means the page could not be read and wants a better scan, a contradiction means the agent answered with no page for a page it says has content on it, which wants a re-extraction — and they are read independently, so a log can carry both: "Page is blank. The scan is blurry. There is handwriting on the page." fills `blank_vetoed` with `blurry` and `blank_contradicted` with `there is handwriting`. On a line with both, the doubt is the one to act on first, because a reply that could not read the page is not a reliable witness to what is on it. |
| `page_blank` | The page agent read the page and reported it empty (`page`, `image`, and its own `log` line), so the document carries no content for it because there was none. Not a failure and not in `pages_failed`: the remedies are opposite, since a failed page is work to redo and a blank page is work already finished. The reply that earns this is a complete envelope whose `html` is present and carries **nothing a reader receives** — no visible text, and none of the elements that are content with no text in them (a picture, a grid, a form control) — **and** whose `log` asserts the page is blank in so many words. Present-and-carrying-nothing rather than present-and-empty, because the empty `html` the prompt asks for is not the only way the model writes a blank page: of 78 such replies in 818 initial renders of the bench logs, 33 spelled it in markup — 18 a bare page-break marker, 13 a comment (`<!-- blank page -->`), 2 an empty paragraph — and read as content each of those was a page counted as having produced markup, with the comment or the anchor delivered into the document (issue #219). Prose is content whatever it says, so a reply of `<p>This page is blank.</p>` is delivered as the page's words: a page that *prints* "This page intentionally left blank" has that sentence as its correct transcription, and nothing in the pipeline can tell the two apart. Where the declaration was spelled in markup, `dropped` carries that markup (bounded to 200 characters), because the fragment delivered is `""` whichever spelling arrived and the line would otherwise not say which one did. What `dropped` discards on the marker spelling is a `doc-pagebreak` anchor, and deliberately: every one of those logs says the paper prints no number, which makes the label the image's position in the file and the anchor a claim that the document's page 14 begins there. The test is positive and doubt is fatal: an absent `html` key, an empty one with nothing said about it, one whose `log` says the page could not be *read* (illegible, too dark to resolve, truncated — including a hedge like "appears blank, though the scan is very faint"), and one that describes the **image's** condition rather than the paper's ("the page is very dark and appears empty", "low resolution scan; no text") are all still the model giving up, and stay `page_no_output`. That reply is the one that most needs a human to look at the page, and reading it as a declaration would leave nothing in the document to look at. A blank page whose wording falls outside both patterns is reported as a failed page, which is the safe direction — a page wrongly reported as failed costs a glance, a page wrongly dropped costs the page. One thing is **not** doubt, though: a doubt word used to describe the *marks on an empty sheet* rather than the image. "Specks/dots are visible but do not resolve into any characters", "a few faint specks/artifacts … no legible text" — that is the blank declaration itself, stated positively, and reading `resolve`, `faint` and `noise` there as doubt about the scan cost four blank pages of 100 on one bench round, while an agent that answered "Page is blank." and stopped was believed (issue #190; two pages of one document opened with a verbatim identical sentence and only the one that explained itself was refused). What is exempt is the *phrase* — `faint specks` is the paper, `faint scan` is the image — so a log that describes both in one sentence still refuses: "the scan is blurry, showing only faint specks and no legible text" loses `faint` and keeps `blurry`. It also needs the marks named *as* marks: `stray marks do not resolve into characters` is the paper, while bare `marks do not resolve into characters` is the phrase the page prompt uses for content that could not be read, and a `dark streak`, `dark spot` or `dark shadow` is the capture and can cover content. It reaches across one sentence or semicolon boundary only where the next clause continues the same observation — the marks referred back to, no subject at all, or a denial — so "a few specks of dust are visible. The handwritten note in the corner does not resolve into words" is still a failed page. And a log that says *where* something illegible sits ("not legible printing in the margin") is naming what the page bears rather than denying it, while naming the substrate ("not legible text on the page") is another way of saying the sheet is empty; the whole rest of that statement has to be made of denial for it to count as one, so a word for a place on the paper — `margin`, `header`, `corner`, `seal`, `spine` — refuses whatever punctuation or preposition leads into it, and a name for what the page bears has to be introduced by a denial there (`or content`, `nor any figures`, `no writing`) rather than by a determiner, and not handed on to a verb that says it is there, because "not legible text, only a heading is visible" and "not legible text, and printing on the page is visible" are built from the same words as a denial and say the opposite — while a tail that goes on to deny something else carries verbs of its own ("not legible text or content, and no writing is visible", "…and no printed page number is visible") and is read as the denial it is. The same read applies to "do not resolve into …", one noun further on — that construction's object is what the `do not` denies, and everything after it has to deny too, so "do not resolve into any characters or content" is a blank page and "do not resolve into any characters, only a heading in the margin" is a failed one. And no exemption applies at all to a log that anywhere says the reading failed or hedges the answer (`illegible`, `obscured`, `too dark`, `could not`, `though`), which are claims about the page wherever they sit. The claim is not taken on trust either: the fragment goes through the same fidelity check as every other page, so a page that in fact has content on it fails that check and is corrected on the normal path. Before this existed, six of 100 bench pages across three of four documents were well-formed envelopes correctly saying the page was blank, and every one shipped a `@page-failed` marker and counted as a lost source page (issue #179). No page-break marker is delivered for a blank page, and the prompt no longer asks for one on such a page whatever the paper prints — it did, which was an instruction the pipeline could not honour once every accepted declaration returned an empty fragment (issue #222) — so a marker that arrives anyway goes to `dropped` with the rest of the fragment rather than into the document. A blank page that did print its folio loses an anchor to a page with nothing to anchor to, which is the cheaper of the two mistakes. A page whose only printed content **is** its folio is one of these pages, and by decision rather than by accident: the folio is never transcribed as text and the marker it may be carried in is never delivered, so such a sheet has nothing on it a reader receives, and a marker-only fragment is not a page. The alternative — delivering a lone `doc-pagebreak` where no declaration was asserted — was refused because that gate also passes a reply whose log says the page's table was too faint to transcribe, which is a page silently dropped while the run reports it delivered, and because every one of the 18 bare markers measured in the corpus carried a label the paper never printed. |
| `page_blank_refused` | A feedback re-extraction declared a page blank that the document already has content for (`page`, `image`, `chars_kept`, the agent's `log`, and `dropped` — the markup the declaration was spelled in, where it was spelled in any), so the declaration is refused and the page keeps that content. The model was shown its own previous output for the page and then said the paper was empty, which contradicts what Iris already holds; the page is then handled as any re-extraction that could not improve it — `page_extraction_failed` with `kept: "prior"`, and the page in `reextract_complete.failed`. Nothing else would catch it: the shrink floor guards the *correction* pass, where the comparison is against that round's own render, so prior → empty never reaches it. That is also why the test is what a reader receives rather than whether `html` is empty — a re-extraction answering `<!-- blank page -->` for a page with content used to walk straight past this refusal and replace the content with the comment, and 13 renders in the bench corpus are that reply (issue #219). A page that was **lost** can still come back blank and be recovered: there is no content to contradict. |
| `page_extraction_failed` | One page's own extraction threw (`page`, `image`, `error`). The rest of the document still ran — see §7c. `kept: "prior"` marks the feedback-re-extraction case, where the page keeps the content it already had and the document stays whole. |
| `extraction_complete` | How many page fragments came out (`pages`) and which page numbers failed (`failed`, always present, `[]` on a whole run). |
| `page_recovered` | A feedback re-extraction succeeded on a page an earlier run had lost, so the document is whole again for those `pages`. Logged late in the run, once that document has been persisted: a round that re-extracts the page and then throws in review leaves the earlier document — hole and all — as the one the session holds. |
| `extraction_failed` | **No page produced any content**, so the run is ending rather than delivering a document with no words in it (`pages`: how many failed, `blank`: how many were reported blank). With `blank: 0` the `run_failed` line that follows carries the first page's provider error, because that is the diagnosis. Otherwise the source itself was empty — one blank scan uploaded alone, a rasterization that yielded white pages — and the error says how many of its pages were blank, which an empty document could not. |
| `page_verify_ok` / `page_verify_failed` | The Feedback Agent's fidelity verdict on one page, checked against its source image. A failure names its `problems` and buys that page one self-correction pass. A page that passes can still be re-rendered (a dropped link), so a run's `page` call count is `pages + corrections`, not `pages + failures`. A failure also carries `kinds`: the distinct kinds of problem the verdict named, out of `content_missing`, `content_wrong`, `structure_wrong`, `a11y_only` and `alt_quality` (defined in `agents/feedback.md`, in the order the agent is told to prefer them — content that is absent is `content_missing` even though it is also a WCAG failure). It is a **set**, not one label per problem: two missing rows are one page that lost content. Without it a page that lost three table rows and a page whose alt text was refined from "orange kayak" to "orange-yellow kayak" wrote the same line, which made `verify_failed` a count of pages the verifier had an opinion about and nothing more. `untagged` is how many of that page's `problems` — a count of problems, where the diagnostics fold's `untagged_pages` counts pages — carried no kind this version recognizes — an agent file whose VERIFY contract predates the kinds, a session-built or trained one that dropped the field, or a kind the agent invented. Read it beside `kinds` or a split reads as covering pages it never saw. A problem is never dropped for being untagged or unrecognizably shaped: a lost label costs a label, and a lost problem ships the page. A `page_verify_ok` line carries `unjudged: true` when nothing actually judged the page — no Feedback Agent loaded, nothing to verify, a reply that would not parse. Verification is non-blocking, so all three answer "faithful" and the page ships; the field is what separates "the verifier looked and was satisfied" from "nobody looked", which is otherwise the same line. Omitted rather than false on a real verdict, and absent from every log written before it existed. The diagnostics fold counts them as `pages_unjudged`. |
| `page_verify_inconsistent` | The verifier **described** a defect and then passed the page (`page`, `image`, `problems`, `kinds`, `untagged`). A verdict's pass/fail is its `faithful` / `accessible` flags, and a correction is bought only when a flag is false **and** a problem is named, so a verdict that names one with both flags true ships the page — and its sentence was not previously anywhere in the log, since `page_verify_ok` carries no `problems`. Calibrating the verifier against injected defects found 3 of 30 damaged pages described in full and passed: a swapped pair of paragraphs quoted back verbatim, an `<h4>` among `<h2>` siblings named as such, `faithful: true` on both. That is most of the gap between what it perceived (28 of 30) and what it flagged (25), and it is a different failure from a verifier that cannot see (issue #210). Written on the FIRST verdict only, the one that decides whether a correction is bought; a recheck's own disagreement is already readable on its line, which carries both `ok` and `problems`. It decides nothing and costs nothing — the page ships exactly as it did — because the fix worth having is kind-gated (a `content_missing`, `content_wrong` or `structure_wrong` problem failing the page whatever the flags say) and pricing that needs this counted over a fleet; failing on any named problem would instead buy a correction round for every `alt_quality` suggestion the same agent is asked to volunteer. The diagnostics fold counts them as `verification.verify_inconsistent`. |
| `page_corrected` | What a self-correction pass did (`trigger`: `verify`, `links` or `both`; `problems`: how many it was given; `kinds`: what the verdict said was wrong going in — the same set as `page_verify_failed`'s, and empty on the `links` trigger, where a dropped link was found by code against the file's own annotations rather than named by the verifier). `result` is `kept` (it changed the delivered document), `rejected` (thrown away in favour of the page it was meant to improve — see `page_correction_rejected` and `page_links_correction_rejected` for the two reasons), `identical` (it changed nothing about the page), `empty` (nothing usable came back) or `failed` (the model call threw, so nothing came back at all — see `page_correction_failed`); the last three are calls paid for that bought nothing, and `failed` is the expensive one, since a truncation has already paid for a full ceiling of output. `identical` is decided on the **effect**, not on string identity, so a model that returns its own page re-indented or with `&` for `&amp;` is counted here rather than as `kept`. Note that such a fragment is still **adopted** — what ships is decided on string identity, deliberately, so that a change no signal here observes cannot be silently reverted; `identical` means the page call bought nothing, not that its output was discarded (that is `rejected`). Two shapes of `identical` are worth telling apart, and field presence is what tells them apart: with `chars_before` / `chars_after` and all four flags `false`, the model re-typed the page to no effect; with no sizes and no flags at all, it handed back the exact string it was given. Same bill, different behaviour. When it changed something, `text_changed` / `alt_changed` / `attrs_changed` / `structure_changed` and `chars_before` / `chars_after` say **what** changed — observed on the two fragments, not claimed by the verdict, so an alt-text refinement, a re-typed `href` and a restored table row are distinguishable. `text_chars_before` / `text_chars_after` are the same two sizes with the markup taken out — how much prose a *reader* receives — which is what separates a correction that added markup to a page that was already complete from one that brought back content the vision pass had dropped. |
| `page_correction_rejected` | A correction came back at less than a quarter of the size of the page it was given (`page`, `image`, `trigger`, `reason: "shrank"`, `chars_before`, `chars_after`), so it was refused and the page it was asked to correct is what ships — paired with `page_corrected` `result: "rejected"`. A correction is single-shot, so what it returns is what the document would keep; a reply this much smaller did not correct that page. Applies on **every** trigger, unlike the links path's own check, and it is decided before either re-verification, so no Feedback Agent call is spent judging a fragment nothing will deliver. In the bench logs the two replies that would have hit this were an agent's scratch template and an abandoned draft, both bound by a parser that took the first `{…}` in a reasoning model's reply rather than the last (issue #170); the parser now reads the right one, and this is the floor under that judgement. |
| `page_correction_failed` | A self-correction's model call threw (`page`, `image`, `trigger`, `problems`, `error`, `truncated`, `chars_kept`), so the page keeps the version it already had — the extraction that succeeded, verified minutes earlier. It costs the **correction**, not the page: before this, the error propagated out of the page's own task and the run logged `page_extraction_failed` and shipped a `@page-failed` marker for a page it still had, which also named a stage that had worked (issue #171). Paired with `page_corrected` `result: "failed"`. Every error class is survivable here, not only a ceiling — a throttle, a stall and a truncation all leave behind a page good enough to have been worth correcting — and nothing is retried, because a correction truncating because the *page* is large will truncate again for a second full ceiling of output. `truncated: true` is the one shape with a configuration remedy (`providers.*.max_tokens`); it also says the model wrote an essay where a page was asked for, which is worth reading beside `page_verify_failed`'s problem list. `chars_kept` is the size of the fragment that ships. The fidelity problems the correction was asked to fix are still unfixed and still on record — keeping the page is not a claim that it was right. |
| `page_correction_no_output` | A self-correction's reply carried no readable HTML (`page`, `image`, `chars`, `shape` — the same shapes as `page_no_output`), so the page keeps the version it had. That version had already passed everything except the fidelity problem the correction was asked to fix, which makes it strictly better than the reply. Paired with `page_corrected` `result: "empty"`, which is the existing record of a correction call that bought nothing; this line says what came back instead. |
| `page_correction_recheck` | A second verdict on a corrected page (`ok`, `problems`), with `problems_before` / `problems_after` — how many **fidelity** problems the page was sent to be corrected with, and how many this verdict names — `kinds_before` / `kinds_after`, the same two sides as kinds, and `links_before`, the missing links it was also given. The kinds are what turn "the recheck did not pass" into an answer about the correction: `content_missing` in and `alt_quality` out is a page whose content came back and whose description is now the complaint, while `content_missing` on both sides is a correction that did not do the one thing it was asked to. Both are `ok: false` with the same counts. `binding: true` is the links path re-verifying a rewrite it may discard; `binding: false` is a measurement-only sample, one page per batch, which changes nothing about what is delivered. The two are counted apart in `verification.rechecks`; `sampled_ok / sampled` across many runs is whether correction converges. On a `binding: false` line, read the two counts beside it: a correction pass is single-shot and was never expected to reach zero problems, so five-in-one-out and five-in-five-out are both `ok: false` and only these say which happened. On a `binding: true` line the page had **passed**, so `problems_before` is 0 by construction and a problem named here is a rewrite of a good page that lost something — not a correction that failed to converge. The link share is carried apart because this verdict judges the fragment against the *image*, where a link target does not appear, so a link counted going in could never be counted coming out; `page_corrected`'s `problems` is the correction's whole bill and `page_links_unrecovered` says whether the links came back. Counts, not a diff — deciding whether two of the Feedback Agent's prose descriptions are the same problem is fuzzy matching on model output, so both lists are on the line in full instead. `unjudged: true` marks a recheck nothing judged, on the same terms as `page_verify_ok`: `ok` is also what an unavailable Feedback Agent looks like, and with none loaded every page passes its first check, so every corrected page's recheck is the binding one and every one of them would otherwise read as a rewrite checked and found good. `verification.rechecks.binding_unjudged` and `sampled_unjudged` are those, per population. |
| `page_correction_recheck_failed` | The measurement-only sample could not be taken — the extra Feedback Agent call hit a provider error (`error`). Logged rather than raised: the page ships as it would have with no measurement at all, and the batch's one sample slot stays spent, so a throttled provider is not retried once per corrected page. A `binding` recheck has no such line, because there the verdict decides whether the rewrite is kept. |
| `table_continuations` | The assembled document holds a table whose caption says it continues the one before it: `tables` (how many tables the document has), `pairs` (how many of them are second halves that were located in the source bytes) and `declined` (how many said so and could not be paired). Logged once per run, before any join is attempted, so the ratio is readable on a run whose joins then all failed. A table printed across a page break arrives as two tables with duplicate headers and no connection between them, and no page agent can fix it: each printed page is its own call, so the agent that wrote the second half had one image and the other half was not on it (issue #239). It knew — all 18 continuation captions in the reference corpus say "Continued" — and emitted a fresh `<table>` because there was nothing to append to. `declined` is a fact about the bytes rather than about the model: the pair is found in the DOM and its two source spans are not, which happens when a page delivered an unclosed `<table>` (an unclosed opener swallows the table after it, so the bytes delimit nothing to splice). Those halves ship as they arrived. |
| `table_joined` | Two halves were merged into one table: the merged `caption`, `rows_first` / `rows_second` / `rows_joined`, `chars_before` / `chars_after` for the two halves against the one table, and the editor's own `editor_log`. The merge itself is a Copy Editor call (`copy_editor_table_join.md` in the agent ledger) rather than a concatenation, because the halves do not agree on what to concatenate: in the reference corpus two of 18 pairs declare a different column count from their own first half, 13 carry footnote-reference ids in the repeated header block that an endnote links back to, and a bracketed unit note ("[In millions of dollars]") is reprinted with the header and belongs in the joined table once. What the answer is *checked* for is deterministic and is the reason this line is trustworthy: one table, a caption without the continuation marker, no column lost, the header block still made of `<th>` cells, at least `rows_first + rows_second` rows less one header block and one droppable row — the header credit is the more permissive of two readings, either one shared block (the smaller of the two declared depths) or what the joined table's own depth says went, because neither alone is right on its own: the two halves may declare headers of different depths (4 of the corpus's 18 pairs do, so the smaller depth alone under-credits a merge that kept the deeper block), and reading the drop off the joined table alone charges a merge that PROMOTED the reprinted unit note into `<thead>` for a row that is still in the table. The shared-block reading is available only while the joined header is no deeper than one block plus that one promotable row: past that depth the extra header rows are a block **kept** — the duplicate header repeated mid-table, the state this stage exists to remove — rather than a row promoted, nothing went, and crediting a shared block would let a merge keep that block and drop its worth of unlabelled rows along with it. The two cases are separated to within one row rather than outright — a reply that kept a single duplicated header row is inside the bound and can lose one unlabelled row with it, which is the size of the drop the floor forgives anyway — so what the bound rules out is slack a whole header block deep, and every distinct row label from either half still present as a cell somewhere. Two row checks rather than one, because neither sees what the other does: the label set is blind to a row that has no label (a printed table's multi-line row labels have continuation lines whose first cell is empty), and a count cannot tell a legitimately dropped duplicate from a dropped state. The one row the count forgives is the bracketed unit note a continued page reprints. `rows_joined` under `rows_first + rows_second` is therefore not a defect. |
| `table_join_failed` | One pair was left as two tables, with `reason`: `unmatched_source` / `not_adjacent` for a pair the source bytes cannot delimit (see `table_continuations`), `declined` for an editor that judged the halves not to be one table, `no_output` for a reply with no HTML in it, `truncated` / `call_failed` for a request that did not come back, `read_failed` for markup no parser could read (with `stage: "body"` when it was the document rather than the reply — jsdom parses by recursion and overflows on a body nested a few hundred thousand levels deep, which is reachable because `anchors.ts` delivers a page past 500 levels as written; the document then ships exactly as it arrived rather than failing the phase, the way the lint one step later reports its own overflow as `@lint-unavailable`), or one of the verification failures — `not_one_table`, `no_caption`, `still_continued`, `columns_lost`, `header_cells_lost` (the merged header block came back as `<td>`, which axe does not report and which would have removed the header association from the one table this stage exists to improve), `rows_lost`, `labels_lost:<n>`. The document keeps **both halves byte for byte**, so every failure here delivers the output the pipeline had before this stage existed, which is what makes the merge safe to ask a model for at all: unlike a correction round, a refusal costs one table's structure and not the document. A pair that failed is not asked again in the same run — the next pass would send the same two tables to the same prompt — so one unjoinable pair does not starve the joinable pair after it. |
| `table_joins_capped` | The document had more continuation pairs than one run will spend requests on (`joined`, `pending`, `max`), and the `pending` ones ship split. Present only when pairs remain. The cap is not a bound anything measured comes near — the worst 25-page chunk of the reference corpus has 7 pairs — but each pass costs one request, so the loop needs one. Pairs are re-read from the body each pass, which is how a table in three pieces closes: joining the first two leaves a document whose remaining half now follows a joined table. |
| `editor_images` | How many source images the Copy Editor received this round (`attached` of `of`, plus `pages`). A `dropped` count means the selection did not fit in one request and was trimmed to the pages issues actually named. `attached == of` on a multi-page document means at least one issue in that round carried no page attribution, so the round asked for everything. |
| `editor_images_refused` | The provider refused the round's payload as too large, so the same prompt was re-sent **without** images. The correction still had the whole body and every issue; only a fidelity problem that must be checked against the source can go unfixed. |
| `editor_fidelity_observed` | The Copy Editor, looking at a page image it was sent for some other reason, says the HTML and the page disagree about something **nobody asked it about**: `count` observations, the `attached` pages it actually had, and the `observations` themselves — each a `page`, a sentence, and one of `page_verify_failed`'s five `kind`s (the same taxonomy, so this can be read against `verify_kinds`; `null` where the reply named a kind this version does not recognize, and the sentence is kept either way). Reported and **not acted on**: acting would mean re-reading that page in full, which is a re-extraction and not this loop's job, and an edit made from one glance at an image reaches a reader as what the page says. So nothing about the delivered document changes because of this line — it is the only trace, and it is addressed to a person. Its value is that it is the **only** second opinion on fidelity in the run: VERIFY checks each page once, with the same model family on the same image as the transcriber, so its blind spots are the transcriber's by construction, and the Reader cannot see the source images at all (issue #183). `unattached` counts observations about a page whose image was **not** in `attached` — the prompt asks for attached pages only, so those are guesses about a page the model could not see, kept but counted apart so a mostly-guesswork set can be discounted whole. `unplaced` counts observations that named no page. Absent on the ordinary round, where the editor noticed nothing. |
| `editor_links_dropped` | An `href` present before that round's correction was missing after it (`iteration`, `hrefs`). A link's target came from the source **file**, not from a page image, so a dropped one cannot be recovered by looking again — logged rather than repaired, and counted into `links_dropped_rate`. |
| `internal_links` | The delivered document contains an in-document reference that lands nowhere (`refs` fragment links in all, of which `empty` are `href="#"` and `dangling` name an `id` the document does not have, plus `ids` — up to 20 of the fragments that failed). Those three are counted per **reference**, so `refs` is the denominator of the other two and one missing section linked forty times is forty references a reader can activate to no effect; `ids` alone is the **distinct** set, because the cap is 20 and one dead target must not spend it. Measured on the bytes actually written, after every rename and every correction round, because that is the only place the question "does this reference land" has a final answer; `@`-comment markers are stripped first, since those quote model prose and an `<a>` inside one is not a link. Absent on a document where every reference resolves. The two shapes are apart because the remedies are: `empty` is a link the page agent wrote knowing it had no target — nothing to rename — while a `dangling` one had a target that moved, was never transcribed, or is in a part of the document this run did not hold. The ids are here and not in `links_unresolved_rate` on purpose: a fragment is text chosen out of the document, so it stays on the deployment while the public tally gets counts only. |
| `delivered_markup` | The delivered document's own structure disagrees with itself (#240): `unbalanced` lists `element open/close` for every element whose end tag HTML **requires** and whose start and end tag counts differ (e.g. `table 16/15`), `tables` and `tables_without_body` count the parsed tables and those holding no row a reader receives as content (no rows at all, none outside a declared `<thead>`, or — with no header block declared — none that is anything but column headers; a body of `<th scope="row">` cells is content), and `empty_table_captions` names up to 10 of those tables. Absent when both are clean. The two halves are one question asked either side of the parser, which is why they share a line: an HTML parser repairs malformed markup before axe is handed the document, so the **bytes** are the only place an unclosed `<table>` is still visible, while a table with no rows is what survives that repair and reaches a reader. `@`-comment markers are stripped before counting, since those quote model prose — with them in, one bench document read `table 25/19` with nothing actually wrong; an unterminated `<!--` is treated as running to the end of the document, which is what a parser does with one. Elements with optional end tags (`li`, `tr`, `td`, `p`, `tbody`, …) are excluded: `<ul><li>a<li>b</ul>` is correct HTML and counting it would bury the real finding. A `parse_error` key means the table half could not be measured at all, so its zeros are not a clean bill of health (#164). |
| `editor_markers_changed` | The count of a `[not legible]` or `[page not fully transcribed]` marker changed across one correction round (`iteration`, `before`, `after`, plus `fewer` and/or `more`). `fewer` is expected where the editor read that region off the attached page image, and is a loss anywhere else — nothing downstream can tell those apart, and no other signal sees it at all, since the flattened view strips bracketed tokens before comparing words. `more` is a placeholder written over words the extractor did read, which no instruction in the loop allows. |
| `editor_truncated` | A correction round's response hit the model's output ceiling (`max_tokens`, `chars` returned, plus `attached`/`of` images and `after: "images_refused"` when it was the retry that truncated). The review loop stops after this round either way, but the round itself is not given up on: it is re-made a section at a time (`editor_sections` below). The whole ceiling of output was billed, so this is the log's most expensive line. |
| `editor_sections` | The truncated round is being re-made a piece at a time: the body was cut into `sections` pieces of at most `budget` characters, sized from the `chars` that response actually returned, and they are corrected `concurrency` at a time. The budget is measured rather than estimated — nothing here is computed until the ceiling has actually been hit — and it is deliberately well under what came back, because a correction adds characters. |
| `editor_section_failed` | One section could not be corrected (`section` of `of`, and `reason`: `truncated` or `too_large` for a section whose own response or request did not fit, `no_output` for a reply with no usable HTML in it, `shrank` for one that parsed but came back with under half the section's prose — the same floor the whole-body path applies, with the same four sizes and `floor` on the line, see `editor_shrank`). That section's **original text** goes back into the document, so the cost is that section and not the round. Anything that is not a size failure — a stall, a stream error, a bad key — is not logged here and still ends the run. |
| `editor_sections_declined` | The truncated round could not be re-made a section at a time, and why (`reason`): `unmeasured` (no character count to size a budget from), `budget_too_small` (the response was cut so early that the sections would be too small to be worth asking about), `budget_exceeds_body` (the response was *longer than the document* — a reply that ran away with itself, so the sections would be one section and the same request), `indivisible` (the body has no top-level boundary to cut at — one enormous table, say), `too_many_sections` (more requests than one round may spend, with `sections`, `max` and `budget`). The round is then discarded as it was before this existed: the document that entered it is delivered with that round's issues unresolved. |
| `reader` / `editor` | Per-iteration review-loop progress: the Reader's `issues` count, and whether that round's correction `changed` the document. A round answered piece by piece carries `sections` and `corrected` as well, which is how a log tells one from a round answered whole — and how much of the document the corrections actually reached. A truncated round that rescued nothing has **no** `editor` line, which is how it is told apart from a round that ran and changed nothing (`review_converged`). `chars_before` / `chars_after` and `text_chars_before` / `text_chars_after` are the size of the body that entered the round and the size of the one that left it, whole and with the markup taken out — the same two readings `page_corrected` carries, so a round and a page correction can be read against each other. The Copy Editor's `html` is adopted for the body **verbatim**, so without these the body that entered a successful round is gone and the ratio it moved by is unrecoverable: before they existed the distribution of a legitimate round was measurable only on the rounds that FAILED, which is three samples on one document (issue #174). Both pairs, because a length alone cannot say whether a round lost content or lost wrappers: markup-only work leaves the prose pair equal and moves the whole-fragment one, and a round that deleted a paragraph moves both. Both published ranges are whole-fragment ratios, and they are not both this line's quantity: 0.62–2.32 over 265 page corrections is delivered-against-given, as here, while 0.982–0.984 over the three rounds is the *reply* against the body that went in, reconstructed from `agent_call`. This line reports 1.000 for those same three rounds, because a reply with nothing usable in it is a body handed back untouched — so the published span and a fresh one are the same rounds measured two ways. The prose pair is what the floor on this path is read on, and the four rounds that first carried it are what placed the number: they land at 0.997–1.006 of the body they were given, and a reply under half is refused (`editor_shrank`). What the three earlier rounds *do* show beyond length is structure: one of them dropped 5 of 7 lists and 13 of 47 list items while its length moved 1.6%, which is an argument for a structure count rather than for either size — so `structure_before` / `structure_after` carry one, counting headings, paragraphs, lists, items, terms, definitions, tables, captions, rows, header cells, data cells, images and links in the body on each side of the round. Full counts, because a ratio needs its denominator. Grouped, and `h1`-`h6` into one number in particular: the page agent's rules promote a sub-topic the page named, make a printed group label the parent of the cluster under it, and put a procedure's step one level under its heading, so a round that re-levels a section is doing its job and a per-level count would report every one of those as a heading lost. What no rule asks for is a heading that stops existing, which is what this number sees. Read the residual as unwatched, not as covered: a round that rewrote every heading to the *same* level leaves no downward skip, so the re-lint's `heading-order` is silent on it (that rule fires only where a level goes down by more than one), `headings` is unchanged, and the prose pair is equal — every level distinction gone with nothing on the line to say so. Header cells are counted APART from data cells for the same missing-second-opinion reason in the direction that costs nothing: no axe rule fires on a `<th>` demoted to a `<td>`, which is the loss that strips a table's header association from a screen reader, so folding the two would report that round as no structure moved. `<caption>` is counted for the same reason. Wrappers (`<section>`, `<div>`) are not counted, since unwrapping a mis-structured page is one of the corrections this loop is for. Read them knowing which way that evidence points, because the next bench round settled it and it went the other way: on those three rounds the structure counts were already the *less* stable number, moving in both directions on rounds that were working, and the first round to log all three had one turn a 55-item `<dl>` into list items — `terms` 55 → 3, a ratio of 0.055 — while its prose moved 0.3%. So no threshold on a structure count both permits that round and refuses a reply carrying a fifth of the document, and the floor reads the prose pair instead (`editor_shrank`). All three readings stay on the line regardless: two of them are what a person reads once the third has fired. The sizes are the **body**: the wrapper and the `@`-comments after `</main>` are added downstream and are not what any round returned, and they are taken after the deprecated-role strip, so they describe the body that ships. On a sectioned round they are still the whole body's, which is why `sections` on the same line matters to anyone reading them as a distribution: one section's *reply* is a fraction of the body it belongs to (0.016–0.379 on the bench rounds) because it is one section, and a round whose reply carried nothing usable reports equal sizes by construction, with `editor_no_output` beside it to say so. |
| `lint_unavailable` | axe-core could not run on a body no `assembly` line covers, with the same `lint_error` / `lint_error_where` / `lint_error_name` / `lint_error_stack` fields that line carries. `stage: "correction_round"` is the review loop's re-lint of a body an editor round changed, with the `iteration` that produced it; `stage: "feedback_relint"` is a feedback re-run that skipped extraction, where there is no assembly to report one. The document ships with **no accessibility verdict** either way: the loop had no violations to work from, and the delivered HTML says so in an `@lint-unavailable` comment. |
| `editor_no_output` | The Copy Editor's reply carried no usable body (`chars` of text came back), so the round kept the document it was given. A call paid for and nothing said — which is why it does not end the loop: the next round is a retry, not a repeat. |
| `editor_shrank` | The Copy Editor's reply parsed as a document and came back with **less than half the prose** of the one it was given, so it was refused and the round kept the body it was given (`chars_before`/`chars_after`, `text_chars_before`/`text_chars_after`, and the `floor` divisor). This is the one path where the model's `html` is adopted for the whole body with nothing compared against what went in, and the blast radius is the deliverable — a reply that answered about one section, or summarised, or quoted the contract back after answering, arrives shaped like a corrected document (issue #174). Reported the same way as `editor_no_output` and for the same reason: nothing came back that can be used as *this* document, so the next round is a retry rather than a repeat and this is not a `review_converged`. Read on the **prose**, not on the characters and not on the structure counts, because only the prose pair is stable on a legitimate round: the four rounds that record all three readings land within 0.6% of their input on it, while unwrapping a mis-structured document keeps every word and loses half the bytes, and one of those rounds rewrote a 55-item `<dl>` into list items — a ratio of 0.055 on `terms` — while its prose moved 0.3%. Bodies with under 1,000 characters of prose are not judged at all: the legitimate deletions are fixed-size (a `[page not fully transcribed]` marker is 28 characters, a duplicated heading 20–60), so on a short body the floor would fire on the editor doing its job. |
| `deprecated_roles_stripped` | A deprecated ARIA role was removed from an element whose own role already said it — `roles` (the set) and `nodes` (how many attributes went), with `stage: "assembly"` for what extraction produced, `stage: "correction_round"` plus `iteration` for what an editor round introduced, or `stage: "feedback_prior_body"` for one already in a stored body that a feedback re-run picked up without re-extracting. ARIA deprecates exactly three roles — `directory`, `doc-biblioentry`, `doc-endnote` — all folded into list semantics, so an `<li role="doc-endnote">` inside an `<ol>` is announced identically without it and axe's `aria-deprecated-role` has nothing left to report. **This line is the only trace.** The delivered document is clean and the lint that would have named the role now finds nothing, so a run log with this line in it is the page agent's FOOTNOTES rule not being followed (`stage: "assembly"`) or the Copy Editor introducing markup nobody asked for (`stage: "correction_round"`) — which is how issue #187 shipped: axe reported the role, the editor was told, it rewrote five sections, and the role survived. The strip is deliberately narrow: the role is removed only where the host element already provides it, so a `<div role="doc-endnote">` is left to fail the gate, because deleting it there would leave nothing marking the element as a note at all and the remedy is to make it a list item. |
| `page_main_stripped` | A `<main>` a page emitted for its own content was taken out of the body, because `wrapDocument` puts the assembled body inside one and a `main` inside a `main` takes away the landmark a screen-reader user jumps to in order to skip the furniture (issue #251, 18% of page answers). `unwrapped` (a bare `<main>`, tags removed and children promoted), `downgraded` (one carrying attributes, rewritten to a `<div>` keeping them, since unwrapping it would drop the `lang` the document's root declaration is derived from or an `id` an `href` elsewhere resolves to) and `declined` (half a wrapper, left in place), with the same three `stage` values as `deprecated_roles_stripped`. **This line is the only trace of the first two counts**, exactly as with the role strip: the delivered document is clean, and a run log with this line in it is the page contract's shell sentence not being followed (`stage: "assembly"`) or the Copy Editor supplying a wrapper it was told not to (`stage: "correction_round"`). `declined` is the opposite case — the element's extent is whatever the parser decides, so there is no correct edit, the residue ships, and `landmark-no-duplicate-main`/`landmark-main-is-top-level` report it in the gate. A `role="main"` on an element that was never a `<main>` is not counted here at all and goes straight to the gate, for the reason the role strip stays narrow. |
| `reader_page_reports_deduped` | One round's Reader reports about a page the document has **no content** for were reduced to one per page: `dropped` (how many reports went), `pages` (which pages the kept ones stand for) and `reports` (each dropped report's severity and text, folded and bounded), for that `iteration`. Two kinds of page have no content — one extraction lost (`pages_failed`, a `@page-failed` comment) and one that is blank in the source (`page_blank`, correctly delivered as an empty page) — and neither is something a correction round can act on. The Reader is told so in the index it reads and in its own prompt; this line is what happens when a sampled model raises them anyway, which it did **once per chunk**, in a different wording each time, so exact-string dedupe caught none of them (issue #188). Per chunk of the FINAL round, to be exact: `@unresolved` is written from the last read of the document, so that read's chunk count is how many copies were delivered — six of one document's 26 on the round that filed the issue. What the iterations multiplied was the spend, not the list: every round's editor was handed the same unrepairable reports. Only the FIRST report of a page is kept, deliberately: an issue whose attribution is entirely pages with no content can only be about the absence, but the attribution is the Reader's and a misattributed real issue must not vanish without trace — which is what `reports` is for, since which report came first is an accident of chunk order. An issue that names any page with content in it is never touched, and an unattributed report cannot be reached here at all. |
| `review_converged` | The loop stopped early because a round changed nothing (`iteration`, the `issues` that round was given, and the `rounds_left` it did not spend). The editor answered and handed back the document it was given, so the same request next round would be answered the same way; what ships is that document with those issues written to `@unresolved`. Expect this on a document whose remaining issues are the ones the loop is designed not to resolve — an undecidable pair of same-worded headings, a `[page not fully transcribed]` marker. Frequent lines here with `issues` the editor *should* be able to fix are the signal worth chasing: that is the editor declining work, not the loop saving a wasted round. |

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
    "pages_verified": 25, "pages_unjudged": 0, "verify_failed": 13, "corrections": 14,
    "verify_kinds": { "content_missing": 5, "content_wrong": 2, "structure_wrong": 6,
                      "a11y_only": 3, "alt_quality": 4, "untagged_pages": 1 },
    "verify_untagged_problems": 2,
    "verify_inconsistent": { "pages": 3, "content_missing": 0, "content_wrong": 1,
                             "structure_wrong": 1, "a11y_only": 0, "alt_quality": 1,
                             "content_or_structure": 2, "undecided_pages": 1 },
    "results": { "kept": 12, "rejected": 0, "identical": 2, "empty": 0, "failed": 0 },
    "triggers": { "verify": 13, "links": 1, "both": 0 },
    "effects": { "alt_only": 4, "text": 8, "attrs": 3, "structure": 6, "text_grew": 5, "text_shrank": 1 },
    "rechecks": {
      "sampled": 1, "sampled_ok": 1, "sampled_unjudged": 0,
      "sampled_problems_before": 3, "sampled_problems_after": 0,
      "binding": 1, "binding_ok": 1, "binding_unjudged": 0
    }
  },
  "fidelity_observed": {
    "observed": 3, "pages": [2, 5], "unattached_pages": [],
    "kinds": { "content_missing": 2, "content_wrong": 0, "structure_wrong": 0,
               "a11y_only": 0, "alt_quality": 1, "untagged": 0 },
    "unattached": 0, "unplaced": 0
  },
  "pages_failed": [],
  "pages_blank": [17]
}
```

The key field for **"is it hung?"** is `in_flight`: a non-null value with a large `waiting_ms`
means a model call started and hasn't returned (the likely culprit). Because pages are
extracted in parallel, several calls can be open at once — `in_flight` reports the
**longest-waiting** one and `in_flight_count` how many are open in total. `concurrency_factor`
is total model-call time ÷ wall-clock elapsed: ~1 means calls ran serially, and roughly
`extraction_concurrency` during a parallel extraction phase — a value near 1 on a multi-page run
means parallelism isn't happening. `slowest_calls` and `phase_durations_ms` show where time goes;
`errors` lists failed calls, plus the two failures that are not calls — a feedback round's
agent training (`feedback_training_failed`) and its agent-suggestion filing
(`contribution_failed`). Both run after the document is delivered and report rather than raise,
since neither may revoke a document the user already has, so this is where they surface.

`tokens` is what the run **consumed**, and `by_agent` carries the same four counts per agent
(under the names the run log uses: `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
`cache_creation_input_tokens`) — so "which agent is slow" and "which agent is expensive" can be
answered separately, because they are often different agents. Deliberately no dollar figure: the rate depends on the provider,
region and model, all of which are deployment config, so the token counts are reported and
whoever holds the price sheet does the multiplication. The four counts bill at four different
rates and are never summed here; note that `input` **excludes** tokens read from the cache, so the
whole prompt is `input + cache_read + cache_write`.

The last two are non-zero because Iris asks the model to cache the part of each prompt that does
not change. Three things qualify: the agent's own system prompt, which is identical on every page
of every document; on the fidelity check, the contract of the agent it is judging, which that task
re-states in full on every page and which is the largest single constant Iris sends; and on the
Reader, the index of the document's source pages, which every chunk of every review round is given
and which does not change while the loop runs. The last of those is per-document rather than
per-deployment, so its entry is cold once per session by construction, and it is only asked for
when the index is long enough to be worth a breakpoint — roughly ten pages.
Expect a `cache_write` on the first calls of a run and a `cache_read` on every call after them —
a handful of writes rather than exactly one, because pages are converted concurrently
(`defaults.extraction_concurrency`), so the first few calls of a phase go out together before any
of them has written the entry the others would have read. A request may carry more than one cached
prefix — the fidelity check caches its system prompt and the contract it is judging, and a Reader
call caches its system prompt and the page index — and they share one `cache_creation_input_tokens`
figure on that call's `model_call` line rather than appearing as separate writes. So
on a long document the same prefix is paid for a few times at 1.25× instead of 25 times at 1×, and
every other call reads it at 0.1×. A run that shows `cache_read: 0` with several calls to the same agent is a run that
is paying full price for the same instructions repeatedly — the cases where that is expected are a
model whose id Iris cannot recognize as a Claude model, a model generation older than caching
support (Iris asks from 3.7 on), an agent prompt too short to be cacheable (the platform minimum is
~1k tokens), and a deployment that set `prompt_cache: false` on the provider block.

A cache entry lives five minutes by default, refreshed on every read — so within one run the
prefixes stay warm on their own however long the document takes. A deployment whose runs arrive
in bursts, more than five minutes and less than an hour apart, can hold them for an hour instead
with `providers.<name>.prompt_cache_ttl: 1h`. It is a trade rather than a free upgrade: an
hour-long entry is written at 2× instead of 1.25×, so it needs a third use to pay for itself
where five minutes needs a second. A deployment converting a document a day should leave it
alone.

**These fields cannot tell you which TTL you got.** The difference between the two is a price
multiplier on a write, not a token count — the same prefix written either way reports the same
`cache_write` — so a broker that silently strips the field reads exactly like one that honours
it, and your provider's own billing is where that question is answered. A value Iris cannot
read (`60m`, `1 hour`) is caught at startup instead, with a warning, and falls back to five
minutes.

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
and lost a link, `both` one that did each. `verify_failed / (pages_verified - pages_unjudged)` is the
rejection rate; the raw counts are reported rather than the percentage, because a rate over three
pages is not a measurement.

`pages_unjudged` is a **subset** of `pages_verified`, not a deduction from it: the pages that reached
verification and came back with no judgement — no Feedback Agent loaded, nothing to verify, a reply
that would not parse. Verification is non-blocking, so all three answer "faithful" and cost the page
nothing, which means a run that lost its Feedback Agent halfway through would otherwise read as a run
with an unusually good pass rate. Zero on every log written before the flag existed, which is the one
case it cannot distinguish rather than one it claims to.

`verify_kinds` is that rejection rate split by what was **wrong**, in pages, out of the five kinds
VERIFY tags each problem with (`agents/feedback.md`). Two benchmark rounds rejected 74 of 94 and 76
of 100 pages with no way to tell content arriving missing from descriptions being polished, which is
what made `verify_failed` unreadable as an accuracy signal. `content_missing` is where an image with
no description at all lands too, because the rule is what a reader LOSES and there the loss is the
content: so a high `content_missing` share is "content is not arriving", which may mean the vision
pass dropped table rows or that meaningful images came back undescribed — two remedies, extraction
fidelity and alt-text prompting, and this field does not separate them. The `problems` text on the
page's own log line does. Not a partition, for the same reason
`effects` is not: a page with a missing row and a thin alt text is counted in `content_missing` and
in `alt_quality`, so these sum to at least `verify_failed` and usually more — read each against
`verify_failed`, never against their own total. Pages rather than problems, so one page naming six
things cannot outweigh six pages naming one each. `untagged_pages` keeps the rest honest: a page whose
problems carried no kind — an older log, an agent file whose contract predates the kinds, a model that
answered in plain strings — is in `verify_failed` and in no kind bucket, and a split read without it
beside them is a split of the tagged share presented as the whole run. A page appears in both when
some of its problems were tagged and some were not, which is why the name says pages: the `untagged`
on the log line it is folded from counts PROBLEMS, and the two are different numbers on one run.
`verify_untagged_problems`, beside `verify_kinds`, is that other unit — a run that lost one tag per
page and a run that lost every tag report the same `untagged_pages`, and only the second means the
split cannot be read at all.

`verify_inconsistent` is the other side of the verdict: pages the verifier **passed** while naming a
problem. Those are not in `verify_failed` and they bought no correction — a page fails only when a
`faithful` / `accessible` flag is false *and* a problem is named — so this is the one place the
sentence such a verdict wrote is counted at all. `pages` is how many, split by kind in pages exactly
as `verify_kinds` splits the failures and just as much not a partition. `content_or_structure` is the
field to read: pages naming at least one `content_missing`, `content_wrong` or `structure_wrong`,
which is precisely the population a kind-gated failure rule would newly fail and newly pay a page call
for. Read the rest as the run working, not failing — an `alt_quality` note on a page that ships is the
Feedback Agent answering a question it was asked to answer. `undecided_pages` is the unknown above
that floor: pages where such a rule has nothing to decide on, because a problem arrived with no kind
this version knows and no content or structure kind was named either. The two are addable —
`content_or_structure` is the least the rule would cost and their sum the most — which is why this
field is **not** the same rule as `verify_kinds`' `untagged_pages`: that one counts a partly-tagged
page as well, because it audits a split and a missing tag makes the split incomplete, whereas a page
already naming `content_missing` is decided here whatever else it left untagged. Expect
`undecided_pages` to be the whole of `pages` on a log from an agent file whose VERIFY contract
predates the kinds. Nothing in the pipeline reads any of this; it exists so that rule can be priced
over a fleet before it changes what a document costs (issue #210). Paired with
`effects` on the `page_corrected` line for the same page, this is what says whether a correction
addressed what was reported: a page flagged `content_missing` whose correction came back
`alt_changed` only did not get fixed.

The fields answer different questions about the same loop. `results` is what the corrections
**cost**: `identical`, `empty` and `failed` are page calls paid for that produced no change at all,
and `failed` is the most expensive of the three — a correction that hit the output ceiling paid for a
full ceiling of tokens before failing, so summing only the first two undercounts the waste by the
worst of it. `effects`
is what they **did**, read off the two fragments rather than taken from the verdict — the other end
of the same question `verify_kinds` answers, and the one that can be checked against it: what the
verifier said was wrong, and what the correction actually changed. It is also the only one of the two
available for a page whose verdict named nothing, since a page that passed its check is re-rendered
too when a link is missing.
`text` and `structure` are not exclusive (a re-render is usually both); `alt_only` is the count that
stands alone, and a run where it dominates is spending a page call per page on image descriptions.
`attrs` is every attribute but `alt`, which is where the cheapest real fixes live — an `href` the
model re-typed, a missing `<th scope>`, an `aria-describedby` — a correction that moves no word and
still matters.
`text_grew` and `text_shrank` split `text` by direction, measured on the prose a reader receives:
how many corrections added words, how many removed them, and — on a log where every line carries the
sizes — by subtraction how many rewrote the same quantity in place. That subtraction is only safe on
a log written entirely since the sizes existed: an older `page_corrected` line still counts under
`text` and lands in neither direction, and a session's log is append-only across rounds, so a session
that takes a feedback round across the upgrade has a mixed one. Compare `text_grew + text_shrank`
against `text` first.
This is what makes a high `verify_failed` rate readable in either direction.
Two bench rounds put it at 71% and 74% of pages, with `attrs` and `structure` touched on nearly
every correction — which reads either as most pages arriving with content missing, or as most pages
arriving fine and being polished, and no count could tell the two apart. A round clustered in
`text_grew` is recovering content the vision pass dropped; one that barely leaves `attrs` and
`structure` is buying markup on pages that were already readable, and the cheaper fix for that is
the page prompt rather than a call per page. There is no threshold — a correction that adds one
character counts as `text_grew`, because any band calling that "cosmetic" would be picked rather
than measured, and the magnitudes are on each `page_corrected` line for anyone with a corpus to
calibrate one on.
`rechecks` is whether correction **converges**: `sampled_ok / sampled` is a corrected page that had
FAILED its check, verified a second time to see whether the re-render fixed it. One sample per batch
is deliberate — re-verifying every corrected page would roughly double the share of the bill the
question is about — so it is a fleet number that accrues over runs, not a verdict on any single
document. `sampled_problems_before / sampled_problems_after` is how far the kept corrections got:
`sampled_ok` alone read as pass/fail on a single-shot pass that was never expected to reach zero, so
11 problems in and 3 out looked exactly like 11 and 11. Fidelity problems on both sides, deliberately
— a correction is also handed the links the code found missing, and this verdict judges the fragment
against the *image*, where a link target does not appear, so counting a link going in and never
being able to count it coming out would bias the ratio toward "the loop converges" on exactly the
pages that have the most to fix. Both are sums over the sampled pages that were actually judged —
`sampled` less `sampled_unjudged`, and less any line too old to carry both counts — so
read them as a ratio rather than a per-page average, and note that `sampled_problems_after: 0` does
not mean the sample passed — a verdict's `ok` is its `faithful` / `accessible` flags, which an agent
can set false while naming nothing. `binding` is counted apart from the sample and not added to it:
those are the links path's own re-verifications of pages that had already **passed**, kept or
discarded on the verdict, so their ok-rate answers "did a rewrite of a good page stay good" — a
different question, and on a link-heavy PDF there is one per page, enough to swamp the sample if the
two were summed. The tally has no binding `problems_*` pair for the same reason — the event lines do
carry the counts, but nothing sums them here: those pages had passed, so their `problems_before` is 0
by construction, and their verdict decides whether the rewrite ships at all rather than measuring how
far a kept one got. `sampled_unjudged` and `binding_unjudged` are `pages_unjudged`'s caveat one level
down, and subsets in the same way: a recheck's `ok` is also what an unavailable Feedback Agent looks
like, and with none loaded every page passes its first check, so every corrected page's recheck is the
binding one and every one of them reads as a rewrite checked and found good. Subtract from BOTH sides
— `(binding_ok - binding_unjudged) / (binding - binding_unjudged)`, same shape for sampled — because
an unjudged recheck logs `ok: true` and so is already inside `binding_ok`. That is where these differ
from `pages_unjudged`, which comes off the denominator alone: `verify_failed` can only come from a
`page_verify_failed` line, which an unjudged verdict never writes. The `sampled_problems_*` pair needs
no such correction, because an unjudged sample is left out of it: its `problems_after` is 0 for want
of a verdict rather than for want of remaining problems, and summed in it would report a page nobody
judged as a correction that fixed everything it was given.

`rejected: 0` over a whole round is the expected reading of a healthy one, not a gate that accepts
everything. The only rejection that applies on every trigger is the shrink floor — a correction that
came back at less than a quarter of the page it was given — which catches a parser or ceiling
failure, not a bad rewrite. (Before it existed, `rejected` was reachable on the `links` trigger
alone, so a round whose corrections were all verify-driven could not produce one at any rate of
badness; two bench rounds of 145 corrections read `rejected: 0` for that reason.) A correction that
is merely **wrong** is kept, and `rechecks.sampled_problems_*` is where that shows up.

Nothing else in here gates anything, deliberately. A verify-driven correction is accepted exactly as
it was before these fields existed, including one whose sampled recheck failed. Discarding it would
not restore a good page — it would ship the fragment that had already failed the same verifier, so
the choice is between a page with fewer named problems and a page with more. The sample is also one
page per batch, so binding it would put a gate on page 4 that page 5 never sees; binding it for
every page means a Feedback Agent call per correction, which is the cost under investigation.
Whether to re-render until a page passes, or to run a cheaper verifier, is a policy question that
needs the rate first. Like `model_calls`, the counts sum over every run a session has had, so a
feedback round that re-extracts three pages adds three more verifications.

`fidelity_observed` sits outside `verification` because it is not part of that loop and does not
gate anything: it is what the **Copy Editor** noticed about a page it happened to be looking at,
folded from `editor_fidelity_observed` (§7a). Everything under `verification` is the one fidelity
check each page gets, and that check's weakness is structural rather than a matter of rate — the
verifier is the same model family looking at the same image as the transcriber, so a page whose text
it misread once it can misread twice, and a page it declared blank it will declare blank again.
Nothing else in the run had standing to disagree. The Reader never sees a source image; the editor
does, for the pages the Reader's issues name, and now has a field to say so in (issue #183). So read
this as **evidence, not a rate**: the denominator is "pages an unrelated issue happened to attach an
image for", which is not a sample of anything, and `observed: 0` on a run means nobody noticed
something in passing, not that the document is faithful. What it is good for is the direction of a
disagreement between the two — `kinds` uses the same five as `verify_kinds` on purpose, so a run
whose editor reports `content_missing` on pages whose VERIFY passed is saying the check missed
content, which is the failure mode no count in `verification` can see. `pages` is the distinct pages
observations were filed about, so one page reported in three rounds is one page and three
observations; `observed` is the observations. `unattached` and `unplaced` are the ones to discount
first — an observation about a page whose image was not attached is a guess about a page the model
could not see, and one that named no page cannot be checked at all. `pages` includes the guessed
pages, because it is where a person should look and a guess that turns out to be right is worth the
look; `unattached_pages` is the subset the editor could **not** see, so the difference between the
two is the set that was backed by an image in front of the model. Attachment is judged per round, so
a page attached in round 1 and reported in round 2 without its image counts as a guess — and a log
line that does not say what was attached puts its pages in `pages` and none in `unattached_pages`,
leaving its own `unattached` count as the only statement that some were guesses. `untagged` in `kinds` is the
usual companion: an observation whose kind this version does not recognize is counted there and in no
other bucket, and the kinds are not a partition, so read each against `observed`. None of this
changes the delivered document — an observation is addressed to a person, and acting on one would
mean re-extracting that page.

`pages_failed` is the set of source pages the delivered document has no content for, because their
own extraction threw (§7c). It has its own field
because a run that reaches `ready_for_review` without one of its pages is otherwise
indistinguishable here from one that delivered the whole document: the failed model call
underneath shows up in `errors` exactly as a retried-and-recovered one does, and `status` says the
run succeeded — which it did, on 24 of 25 pages.

It reports the document's current state, not the session's history: a session's log accumulates
across feedback rounds, so a page lost in round 1 and re-extracted in round 3 (`page_recovered`)
leaves this list, while one that failed again is still in it.

`pages_blank` is the other reason a source page contributes nothing to the document, and the
opposite one: the agent read the page and reported it empty (`page_blank` in §7a). Kept apart from
`pages_failed` because what a reader should do about the two is opposite — a failed page is work to
redo, a blank page is work already finished — and because the alternative was measured: six of 100
bench pages were blank versos reported as lost source pages, which made three of four documents read
as partial when all four were complete (issue #179). Nothing is subtracted for them: `pages` on
`run_complete` counts source images, so `pages - pages_blank.length` is how many produced markup.
The two sets are disjoint, and follow the document the same way — a page that failed in round 1 and
came back blank in round 3 has been answered, so it leaves `pages_failed` and arrives here.

## 7c. Partial documents

A page's extraction can fail on its own (a model call that hits the output ceiling, a stalled
stream, a reply with no readable HTML in it — `page_no_output`). That page fails; the run does not. Every other page is still rendered, verified,
assembled and reviewed, and the document is delivered.

A page that carries nothing is **not** one of these. A blank verso is a page the agent can answer
completely, and it answers with a `log` line saying the page is blank and an `html` holding nothing a
reader receives — an empty string, or, in 33 of the 78 such replies in the bench logs, a comment, an
empty paragraph or a bare page-break marker (`page_blank`, `pages_blank`, issue #219); that page
contributes nothing to the document because there was nothing on it, the document is whole, and none
of the markers below are written for it. A page whose only printed content is its own number is such a
page: the folio is the one thing on a sheet this pipeline never delivers, so a page that prints nothing
else has nothing on it a reader receives (issue #222).

**Unless no page produced any content.** Then the run ends `failed` — a document containing none of
the source's words is not a partial success, and an error is more use than an empty file. Where
every page failed, the `error` is the first page's own provider error, which names the ceiling and
the knob to raise. Where the pages were reported **blank**, it says how many of them were: a source
whose every page is empty is a statement about the source, and delivering `<main></main>` from a run
reporting success would leave that unsaid. `GET .../output` answers `409`, as it does for any failed
run.

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
returned is cut mid-tag. Iris never assembles such a fragment — a truncated page still parses, so
it would otherwise be delivered as though the missing content were never in the source. Which
page it costs and whether it costs the run is §7c: one page's failure costs that page, and the
run only ends `failed` (with this as its `error`) when every page failed. Raise `max_tokens` on
that provider block and re-run. Dense full-page tables and forms are the usual trigger.

A reply that arrives whole and still cannot be read is the neighbouring case, and reads as
`page agent returned no HTML (prose, 412 chars)` — `page_no_output` in §7a, with the `shape` that
says which remedy applies. Where HTML did arrive and carried nothing a reader receives, the same
line says that instead — `page agent returned no page in 19 chars of HTML` — because a comment or
a bare page-break marker is not the model answering with no HTML, and the first reading of these
reported the reply's whole length under a message that said none of it was markup. It costs the same as the ceiling does (that page, not the run) and for
the same reason: a page whose content is a JSON envelope or an apology is a document that lies
about being complete, which is worse than one page short and saying so.

The same ceiling reached by a **correction** round is contained differently, because there the
whole document is what did not fit: that round is re-made a section at a time, the loop then
stops, and the delivered document says so in an `@editor-truncated` comment (§5, and
`editor_truncated` / `editor_sections` in §7a). The remedy is the same knob.

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
