# Equalify Iris — API Guide (bash / curl)

For how the system works, in plain language, open `/how-it-works` on a running Iris. It makes these
calls on a real document and explains each; every endpoint is under The API there, with Try it.
Each endpoint's exact request and response is in [openapi.yaml](openapi.yaml), served as
`GET /v1/openapi.json`. The sections below point at it.

Every endpoint is under `/v1`. All responses are JSON unless noted. There is no sign-in
([Authenticate](#authenticate)). Whether you send anything at all depends on the deployment: where the operator set `server.api_token`, `/v1/me` and
`/v1/sessions` need `Authorization: Bearer <that shared secret>`; where they did not, send no header.
`/v1/health`, `/v1/stats` and `/v1/limits` never need one. `/v1/quality` is the exception in the other
direction: it has its own separate secret
([Quality tally](#quality-tally-shared-secret-off-by-default)).

These commands are copy-pasteable. They are the same calls exercised by `test/e2e.sh`, which
runs the whole lifecycle against mock GitHub + mock model services and asserts every response.

Requests are rate limited per client, and every response says how much of the budget is left:
[Rate limits](#rate-limits-how-often-you-may-ask) says where to find the numbers, the headers and the `429`.

`fragment`, `block`, `verdict`, `declaration` and `round` all mean something specific here, and
[README § Terms](../README.md#terms) defines them. These ones appear below in both of their senses:

- **`round`** — a round of the reader/editor loop, or one captured run of a corpus. The text says
  which: a **bench round** or a **deployed round**.
- **`fragment`** — one page's extracted HTML, or the `#id` part of a link. The second sense is what
  `links_unresolved_rate` under [Quality tally](#quality-tally-shared-secret-off-by-default) is about.
- **`block`** — one top-level element of the assembled document, which is what
  `@editor-truncated blocks B of T` counts, or a group of table rows: the "header block" in
  `table_no_body_rate` is a `<thead>`.
- **`declaration`** — the page agent's claim that a page holds no content, except on the
  [run log](#run-log)'s `page_main_stripped` line, where it is the `lang` declaration on the
  document's root element.

`verdict` has one sense here: the Feedback Agent's decision about one page.

```bash
export BASE=http://localhost:8080/v1
export AUTH="Authorization: Bearer $IRIS_TOKEN"   # where the deployment sets a token
```

## Health (unauthenticated)

`GET /v1/health` says Iris is up, and which version. Exact contract: [`docs/openapi.yaml`](openapi.yaml).

## Public tally (unauthenticated)

`GET /v1/stats`: how many pages and documents this deployment has made accessible, and, over the
last 30 days, how well that went. No token. Exact contract: [`docs/openapi.yaml`](openapi.yaml).
Why the fields are as they are, including the privacy floor: [design
notes](design-notes.md#what-the-public-tally-may-say).

```bash
curl -s "$BASE/stats"
```

## Quality tally (shared secret, off by default)

`GET /v1/quality`: how good the output has been over recent documents. It has one caller,
`.github/workflows/quality-report.yml`, which reads it weekly and files an issue when a rate crosses
a threshold in that workflow. Access and field types: [`docs/openapi.yaml`](openapi.yaml). Why the
fields are as they are: [design notes](design-notes.md#reading-the-quality-tally). Setting up the
workflow: [ci.md](ci.md), "Weekly quality report".

```bash
curl -s -H "Authorization: Bearer $IRIS_QUALITY_TOKEN" "$BASE/quality?days=30"
```

**Nothing here may carry document content.** The workflow copies these values into a public issue,
and the documents are user uploads. Rule ids are axe-core's fixed vocabulary. Unresolved issues and
dropped links appear only as counts. A new field must not quote a document.

Every count is per session: a file uploaded three times is three documents.

**Denominators and window**

- `documents`: documents delivered in the window, flawless ones included. Every `_rate` divides by
  it, and is 0 when it is 0.
- `documents_linted`: documents the linter examined (`documents` minus the lint errors). `rules[].share`
  divides by it. When it is well below `documents`, the rule table describes a subset.
- `files`: distinct uploads, by sha256. For one file, the file's own hash; for several, the sha256 of
  their hex hashes joined by newlines, in upload order, so another order or grouping is another
  upload. `documents_unhashed`: sessions from before the hash, counted in `documents` but not `files`.
- `window_days`: the window used. `?days=` is clamped to 1-365 and a garbled value means 30, so read
  this rather than assume. `since`: the earliest document in the window, or `null`.

**The review loop**

- `mean_rounds`: mean Copy Editor passes per document, against `defaults.max_review_iterations`. 0
  means the first reading found nothing. `null` when nothing ran. The loop also stops when a round
  changes nothing, so a low `mean_rounds` beside a non-zero `unresolved_rate` is ordinary.
- `unresolved_rate`: documents that finished with issues still open, at the `cap`, `converged` or
  `truncated` exit. Only the count of issues is stored, never their text. Three kinds are never
  resolved, by design, so always land here:
  - two headings labelled alike, where nothing the Copy Editor has says whether they are one section
    or two
  - a `[not legible]` marker the Copy Editor could not read either, often because it had no image
    for that page (`capEditorImages`, or a provider refusing a large request)
  - a `[page not fully transcribed]` marker, which only a re-extraction can fix
    (`unfinished_page_rate` counts these)
- `first_read`: what the reviewer found before anything was fixed. Every other number is taken after
  the Copy Editor ran, so this is the one that tells "the editor fixed it" from "the reviewer found
  nothing".
  - `mean_issues`: mean issues raised by each document's first read. A cleared document counts 0;
    `null` when no document recorded a read.
  - `documents`: how many recorded a first read, the denominator of `mean_issues`.
  - `unread_documents`: of those, how many had part of the first read come back unusable. On them
    the count is a floor.
  - A document-level feedback re-run keeps the earlier first read, re-dated to the re-run, so it can
    carry an older reviewer's number into a new window ([`first_read_carried`](#first_read_carried)).
    A re-run that re-extracts replaces it.
- `unresolved_severity`: documents with at least one open issue at each severity. Always all four
  entries, zeroes included. Not a partition: one document can be in several, so the counts can sum
  to more than `unresolved_rate × documents`. `high` is what a reader would call a barrier.
  `unrated` means the Reader wrote another severity or none.
- `review_stopped`: which exit ended each document. Always all five entries. A partition: the counts
  sum to `documents` when every run recorded one. A smaller sum means older documents, never a sixth
  exit.
  - `clean`: re-read the finished document and found nothing.
  - `converged`, `truncated`, `cap`: delivered an `@unresolved` list. Together they are the documents
    in `unresolved_rate`.
  - `unread`: an empty list that is still not clean (`review_unread_rate`).
  - Each points at a different fix: `cap` at `max_review_iterations`, `converged` at a prompt,
    `truncated` at the output ceiling, `unread` at the reviewer.
  - On `cap` and `converged` the open list was read on the delivered bytes. On `truncated` it may be
    older than them, so that exit over-reports.
- `review_unread_rate`: part of the reviewer's **last** read came back unusable (prose, an apology,
  `{"issues": "none"}`), so part of the document has no verdict. Not counted clean. Can overlap
  `unresolved_rate`. The document carries `@review-unread`; the run log has
  [`reader_no_output`](#reader_no_output), and that call's [`agent_call`](#agent_call) `output` is the
  reply.
- `unfinished_page_rate`: documents delivered with a `[page not fully transcribed]` marker. Each is
  in `unresolved_rate`, so subtract this before comparing that rate to a threshold. The cause is
  extraction or `max_pages`.

**The Copy Editor**

- `links_dropped_rate`: an `href` present before the Copy Editor was missing after it. A URL completed
  to the link's printed text is not counted ([`editor_links_completed`](#editor_links_completed)).
- `editor_truncated_rate`: a correction round's reply hit the output ceiling, whatever was rescued.
  What the reply finished is applied ([`editor_salvaged`](#editor_salvaged)), the rest is redone a
  section at a time, and the loop stops. `@editor-truncated` in the document says which. These
  documents are also in `unresolved_rate`. A non-zero value means `max_tokens` is low for
  `max_pages`. The weekly workflow sets no threshold on it.
- `editor_truncated_lost_rate`: neither route covered the whole body. The run log says why:
  [`editor_salvage_declined`](#editor_salvage_declined), [`editor_sections_declined`](#editor_sections_declined),
  a section that truncated in turn, or a section that came back with under half its prose
  ([`editor_section_failed`](#editor_section_failed), `reason: "shrank"`, which `max_tokens` does
  not fix). A subset of `editor_truncated_rate` and of `unresolved_rate`. This one has a threshold.
- `editor_headings_gated_rate`: at least one round had blocks handed back because applying them would
  leave fewer headings with every word still there (`headings_reverted` on `editor_patch`, or
  `discarded: "headings_lost"`). It rises when the guard works. Per document.
  - Gated rounds are retried, so a document can count here and still stop `clean`.
  - A rise beside a rise in `cap` points at the Copy Editor's prompt (`EDITOR_SYSTEM` in
    `src/pipeline/review.ts`) or model. More rounds buy more of the same.
  - Known false positives: a heading correctly turned into a `<label>`, `<caption>`, `<dt>` or `<th>`,
    or a repeated title dropped. When the replacement lands in a different block, the whole round is
    refused (`discarded: "headings_lost"`, `headings_dropped`, no `headings_reverted`).
  - 0 does not mean no round demotes a heading. The guard is only on the block-patch path. The
    whole-body and sectioned paths log [`editor_navigation`](#editor_navigation) instead and refuse
    nothing, so read those lines where there are any.

**The delivered document**

- `links_unresolved_rate`: shipped with an `href="#"` or a fragment naming an `id` the document does
  not have. `#` and `#top` are excluded. Which ones: [`internal_links`](#internal_links).
- `markup_unbalanced_rate`: an element whose end tag HTML requires (`table`, `ul`, `a`, `section`,
  ...; never `li` or `tr`) has unequal start and end tags. Measured on the delivered bytes. Which
  element: [`delivered_markup`](#delivered_markup).
- `table_no_body_rate`: at least one table with no content row: no rows, none outside `<thead>`, or,
  with no `<thead>`, only header rows. Row headers (`<th scope="row">`) are content. Measured on the
  parsed tree.
- `structural_defect_rate`: an `aria-labelledby`, `aria-describedby` or `label[for]` naming a missing
  `id`; a `<dl>` with terms and no definitions; or a `<nav>`, `<aside>` or named `<section>` holding
  nothing a reader receives. Which: [`delivered_structure`](#delivered_structure), which also reports
  `lang_on_void`, not counted here.

**The accessibility check**

- `lint_error_rate`: the lint pass errored instead of running. Those documents have no accessibility
  verdict: `lint_ok: false` and no `violations` figure, and an `@lint-unavailable` comment in the
  document. The `assembly` line (or [`lint_unavailable`](#lint_unavailable)) carries `lint_error`,
  `lint_error_where`, `lint_error_name` and the first frames of `lint_error_stack`.
- `lint_error_where`: which step failed. `parse` (jsdom refused the HTML), `inject` (axe's own source
  would not run, a dependency problem) or `run` (the rule pass threw). Always all three entries. A
  sum below `lint_error_rate × documents` means older documents. No message or stack, because they
  can quote markup.
- `rules[]`: per axe rule id, `documents` that violated it, `share` of `documents_linted`, total
  offending `nodes`, and `impact`. Sorted by `documents`, then `nodes`, then id.

## Agent suggestions (shared secret, off by default)

`GET /v1/suggestions`: the agents Iris suggested, behind the quality token. Exact contract: [`docs/openapi.yaml`](openapi.yaml).

## Authenticate

There is no sign-in. A deployment is open (send no header) or gated (send `Authorization: Bearer <token>`); `GET /v1/me` with no header answers 200 or 401. What the token covers, and why some endpoints stay open, is in the spec's description. Exact contract: [`docs/openapi.yaml`](openapi.yaml).

## Deployment defaults

`GET /v1/me`: call it first. It says whether you can use the deployment, and the review cap. Exact contract: [`docs/openapi.yaml`](openapi.yaml).

## Create a session (upload images)

`POST /v1/sessions`, one `images` part per page or PDF, in reading order. Exact contract: [`docs/openapi.yaml`](openapi.yaml). What the page step then checks in code, and why, is in [design notes](design-notes.md#what-code-checks-on-each-page-and-why).

```bash
export SID=$(curl -s -H "$AUTH" -F images=@page1.png -F images=@page2.png "$BASE/sessions" | jq -r .session_id)
```

### Upload limits (unauthenticated)

`GET /v1/limits`: what an upload may be, for the model this deployment runs. Exact contract: [`docs/openapi.yaml`](openapi.yaml).

### Rate limits (how often you may ask)

Per address, per minute, with `ratelimit` headers on every answer except `/v1/health`, and 429 with `Retry-After` when over. Exact contract: the description at the top of [`docs/openapi.yaml`](openapi.yaml).

## Poll status

`GET /v1/sessions/{id}`: poll until `status` is `ready_for_review` or `failed`. Exact contract: [`docs/openapi.yaml`](openapi.yaml).

## Fetch the HTML output

`GET /v1/sessions/{id}/output`: the accessible HTML, and the comments it can end with (`@unresolved`, `@editor-truncated`, `@lint-unavailable`). Exact contract: [`docs/openapi.yaml`](openapi.yaml).

## Get a tagged PDF (optional)

Where the deployment runs [equalify-iris-pdf](https://github.com/EqualifyEverything/equalify-iris-pdf),
`GET /v1/sessions/{id}/fields` lists a one-PDF session's form fields, and `POST /v1/sessions/{id}/pdf`
returns that PDF tagged, with any values filled in. Values are never stored or logged. Exact contract:
[`docs/openapi.yaml`](openapi.yaml).

```bash
curl -s -X POST -H "$AUTH" "$BASE/sessions/$SID/pdf" \
  -H 'content-type: application/json' \
  -d '{"values":{"applicant.name":"Jane Doe"}}' | jq -r .pdf | base64 --decode > tagged.pdf
```

## Audit (off by default)

`GET /v1/sessions/{id}/audit` and the routes under it serve page images, prompts and the document between steps, when `server.audit` is on. Anyone who can read a session can read all of this. Exact contract: [`docs/openapi.yaml`](openapi.yaml).

## Submit feedback (re-run)

`POST /v1/sessions/{id}/feedback`: a new run of the same document with your feedback, routed to a re-review or a re-read of named pages. Exact contract: [`docs/openapi.yaml`](openapi.yaml).

## Run log

```bash
curl -s -H "$AUTH" "$BASE/sessions/$SID/logs"
```
`application/x-ndjson` — one JSON object per line (agent calls with git-SHA / inline-content
version pinning, model-call timing, no-content signals, phase transitions).

The events worth grepping for have a section each below, and the index is a link to it. Reach for
the index when you have a `type` off a log line and want to know what it means; read a section when
you want to know what the field it names is for and what it costs.

**The index is the whole log.** `src/` emits **127** event types and every one of them has a section
below — **118** sections, because a few cover two or three events that are only read together. So a
`type` you cannot find here is not one the index skipped: it is a misread line, or a name `src/` no
longer emits.

That is a claim about the code, so it is not maintained by hand. The test suite reads both numbers
back out of this paragraph and every event name out of the headings, and checks them against the emit
sites in `src/` — three different call shapes, since a grep for one of them cannot see the others. A
new event fails that test until it has a section here, and a section for an event `src/` no longer
emits fails it too.

| `type` | What it records |
| --- | --- |
| [`page_refit`](#page_refit) | A page too large to send was rendered again, smaller, instead of refusing the document |
| [`run_queued` / `run_dequeued`](#run_queued--run_dequeued) | The run's wait for a concurrency slot |
| [`run_start`](#run_start) | The run's opening line: how many source pages, and which of the three paths it took |
| [`phase`](#phase) | The pipeline entered a phase |
| [`model_call_start` / `model_call`](#model_call_start--model_call) | One completion, from the layer that resolved it |
| [`agent_call`](#agent_call) | One agent call that returned, with **the reply itself** and the prompt version that produced it |
| [`extraction_start`](#extraction_start) | The page pass is about to run |
| [`page_lessons_injected`](#page_lessons_injected) | Past lessons were added to this run's page prompts |
| [`feedback_rerun`](#feedback_rerun) | Feedback arrived, and the document it is about was snapshotted first |
| [`feedback_scoped`](#feedback_scoped) | How a feedback re-run was routed |
| [`first_read_carried`](#first_read_carried) | A feedback re-run kept the document's earlier first-read count |
| [`reextract_start` / `reextract_complete`](#reextract_start--reextract_complete) | Which pages went back to the page agent |
| [`reextract_skipped`](#reextract_skipped) | Pages a re-extraction could not attempt, for want of an input |
| [`page_redrawn`](#page_redrawn) | A draw that carried no page and claimed nothing about it, asked once more |
| [`page_no_output`](#page_no_output) | The page agent answered, and no HTML could be read out of the answer |
| [`page_bare_html`](#page_bare_html) | The reply was **markup rather than the envelope**, so the page was rescued as it stood |
| [`page_blank`](#page_blank) | The page agent read the page and reported it empty |
| [`page_blank_refused`](#page_blank_refused) | A re-extraction declared a page blank that the document already has content for |
| [`page_extraction_failed`](#page_extraction_failed) | One page's own extraction threw |
| [`extraction_complete`](#extraction_complete) | How many page fragments came out, and which pages failed |
| [`page_generic_alt`](#page_generic_alt) | A page described an image with a placeholder instead of a description |
| [`page_generic_alt_unrecovered`](#page_generic_alt_unrecovered) | A correction bought for a placeholder `alt` left the placeholder there |
| [`page_duplicate_ids`](#page_duplicate_ids) | One page fragment used the same `id` on more than one element |
| [`page_duplicate_ids_unrecovered`](#page_duplicate_ids_unrecovered) | A correction bought for a duplicate `id` left a duplicate there |
| [`page_links`](#page_links) | The source file's own link annotations were listed in a page's prompt |
| [`page_links_missing`](#page_links_missing) | A link the source annotates is not in the page's HTML |
| [`page_links_unrecovered`](#page_links_unrecovered) | A correction bought for a missing link left it missing |
| [`page_links_unexpected`](#page_links_unexpected) | The page links to a URL **no annotation accounts for** |
| [`page_links_correction_rejected`](#page_links_correction_rejected) | A correction bought for a page that had already passed was refused |
| [`page_soft_hyphens`](#page_soft_hyphens) | Soft hyphens (U+00AD) were taken out of a reply before it became markup |
| [`page_style_attributes`](#page_style_attributes) | `style` attributes were taken out of a reply, and what they were setting |
| [`page_digit_groups`](#page_digit_groups) | A thousands separator split by the printer's alignment space was closed up |
| [`page_split_words`](#page_split_words) | A page wrote one word two ways, `Compos-ite` here and `Composite` there |
| [`page_split_words_unrecovered`](#page_split_words_unrecovered) | A correction bought for a word written two ways left both spellings there |
| [`text_layer_numbers`](#text_layer_numbers) | A PDF page's numbers were checked against its own text layer |
| [`text_layer_numbers_unrecovered`](#text_layer_numbers_unrecovered) | A correction bought for a number the text layer lacks left it there |
| [`page_caption_claim`](#page_caption_claim) | A `<figcaption>` makes a claim about the picture its `alt` describes |
| [`specialist_unresolved`](#specialist_unresolved) | A page asked for a specialist **no available agent answers to** |
| [`specialist_declined`](#specialist_declined) | A page asked for a specialist the general pass already covers |
| [`specialist_no_content`](#specialist_no_content) | A specialist ran and returned nothing of its type |
| [`specialist_dispatched`](#specialist_dispatched) | A specialist ran, and whether its fragment reached the page |
| [`specialist_dispatch_failed`](#specialist_dispatch_failed) | A specialist's call threw, so the page stands as it was |
| [`page_recovered`](#page_recovered) | A re-extraction succeeded on a page an earlier run had lost |
| [`extraction_failed`](#extraction_failed) | **No page produced any content**, so the run is ending |
| [`page_verify_ok` / `page_verify_failed`](#page_verify_ok--page_verify_failed) | The Feedback Agent's fidelity verdict on one page |
| [`page_verify_error`](#page_verify_error) | A page's fidelity check could not be obtained |
| [`page_verify_inconsistent`](#page_verify_inconsistent) | The verifier **described** a defect and then passed the page |
| [`page_corrected`](#page_corrected) | What a self-correction pass did |
| [`page_correction_rejected`](#page_correction_rejected) | A correction came back under a quarter the size of the page it was given |
| [`page_correction_failed`](#page_correction_failed) | A self-correction's model call threw |
| [`page_correction_no_output`](#page_correction_no_output) | A self-correction's reply carried no readable HTML |
| [`page_correction_declined`](#page_correction_declined) | The corrector refused problems it was given, saying which and why |
| [`page_correction_recheck`](#page_correction_recheck) | A second verdict on a corrected page |
| [`page_correction_recheck_failed`](#page_correction_recheck_failed) | The measurement-only sample could not be taken |
| [`table_continuations`](#table_continuations) | A table whose caption says it continues the one before it |
| [`table_joined`](#table_joined) | Two halves were merged into one table |
| [`table_join_code_declined`](#table_join_code_declined) | The code merge stood down on this pair, so a Copy Editor call was bought |
| [`table_join_failed`](#table_join_failed) | One pair was left as two tables, and why |
| [`table_joins_capped`](#table_joins_capped) | More continuation pairs than one run will spend requests on |
| [`prose_joined`](#prose_joined) | A sentence the source printed across a page turn was delivered whole |
| [`editor_images`](#editor_images) | How many source images the Copy Editor received this round |
| [`editor_images_refused`](#editor_images_refused) | The payload was refused as too large, so it was re-sent **without** images |
| [`editor_fidelity_observed`](#editor_fidelity_observed) | The Copy Editor reports a disagreement **nobody asked it about** |
| [`editor_links_dropped`](#editor_links_dropped) | An `href` present before that round's correction was missing after it |
| [`editor_links_completed`](#editor_links_completed) | The Copy Editor lengthened an `href` to the URL its link prints |
| [`internal_links`](#internal_links) | The delivered document has an in-document reference that lands nowhere |
| [`delivered_markup`](#delivered_markup) | The delivered document's own structure disagrees with itself |
| [`delivered_structure`](#delivered_structure) | Four structural defects **no rule in the gate reports** |
| [`delivered_alt`](#delivered_alt) | A placeholder where a description belongs, in the file the caller receives |
| [`editor_markers_changed`](#editor_markers_changed) | A `[not legible]` marker count changed across one correction round |
| [`editor_list_markers_split`](#editor_list_markers_split) | Half of the one list conversion the editor is licensed to make |
| [`editor_truncated`](#editor_truncated) | A correction round's response hit the model's output ceiling |
| [`editor_salvaged`](#editor_salvaged) | The truncated reply was read as far as it got |
| [`editor_salvage_declined`](#editor_salvage_declined) | The reply could not be read as a prefix, and why |
| [`editor_sections`](#editor_sections) | A round that could not be answered whole is being re-made a piece at a time |
| [`editor_section_failed`](#editor_section_failed) | One section could not be corrected |
| [`editor_sections_declined`](#editor_sections_declined) | The round could not be re-made a section at a time, and why |
| [`reader_start`](#reader_start) | The Reader is about to read the document, in this many windows |
| [`reader` / `editor`](#reader--editor) | Per-iteration review-loop progress |
| [`reader_issues_dropped`](#reader_issues_dropped) | Entries in one window's reply that could not be issues |
| [`reader_no_output`](#reader_no_output) | One window was paid for and produced **no verdict** |
| [`lint_unavailable`](#lint_unavailable) | axe-core could not run on a body no `assembly` line covers |
| [`lint_debris`](#lint_debris) | The linted body carried attributes whose **names no valid markup produces** |
| [`editor_patch`](#editor_patch) | What one ordinary correction round's reply did to the body, block by block |
| [`editor_whole_body`](#editor_whole_body) | The reply carried an `html` string and no `edits`, so it was read whole |
| [`editor_no_output`](#editor_no_output) | The Copy Editor's reply carried no usable body |
| [`editor_shrank`](#editor_shrank) | A round came back with **less than half the prose** it was given, and was refused |
| [`editor_navigation`](#editor_navigation) | The structures a reader navigates by, on a reply that was **adopted** |
| [`assembly`](#assembly) | The pages were joined into one body, and the first lint of it |
| [`assembly_anchors`](#assembly_anchors) | What namespacing the pages' `id`s cost |
| [`assembly_words_joined`](#assembly_words_joined) | A word broken at a line end was closed up, and what licensed it |
| [`deprecated_roles_stripped`](#deprecated_roles_stripped) | A deprecated ARIA role was removed from an element that already said it |
| [`invalid_roles_stripped`](#invalid_roles_stripped) | A `role` naming something that is **not an ARIA role at all** was removed |
| [`page_main_stripped`](#page_main_stripped) | A `<main>` a page emitted for its own content was taken out of the body |
| [`page_markers`](#page_markers) | Page-break markers were checked against the document's own numbering |
| [`reader_page_reports_deduped`](#reader_page_reports_deduped) | Reader reports about a page with **no content** were reduced to one per page |
| [`review_converged`](#review_converged) | The loop stopped early because a round changed nothing |
| [`run_signals_failed`](#run_signals_failed) | The quality tally could not be written for this document |
| [`feedback_classified`](#feedback_classified) | A correction was classified and **nothing was recorded** |
| [`feedback_learned`](#feedback_learned) | A lesson was recorded, and how many sessions have reported it |
| [`feedback_agent_missing`](#feedback_agent_missing) | `agents/feedback.md` could not be loaded, so no proposal was made |
| [`feedback_target_missing`](#feedback_target_missing) | The agent the correction was about could not be loaded |
| [`agent_trained`](#agent_trained) | A session-built agent was improved in place, with neither gate run |
| [`regression_gate`](#regression_gate) | The candidate prompt was re-run against the agent's own fixtures |
| [`eval_gate`](#eval_gate) | Candidate against current, over the fixtures **both** could be scored on |
| [`agent_update_blocked`](#agent_update_blocked) | A proposed prompt change was refused — two shapes, told apart by `reason` |
| [`agent_updates_proposed`](#agent_updates_proposed) | A proposal cleared both gates and was written to the session |
| [`feedback_training_failed`](#feedback_training_failed) | The whole training step threw, and the document still shipped |
| [`run_complete`](#run_complete) | The run's terminal marker, and the state it delivered |
| [`suggestions_recorded`](#suggestions_recorded) | New-agent suggestions were saved for the maintainers, **after** `run_complete` |
| [`contribution_failed`](#contribution_failed) | Saving them threw, **after** `run_complete` |
| [`run_failed`](#run_failed) | The run threw, so there is **no document** |
| [`tagged_pdf` / `tagged_pdf_failed`](#tagged_pdf--tagged_pdf_failed) | A tagged PDF was made, or could not be |
| [`tagged_pdf_fields` / `tagged_pdf_fields_failed`](#tagged_pdf_fields--tagged_pdf_fields_failed) | A flat form was tagged to list its fields, or could not be |
| [`form_fields` / `page_fields` / `page_fields_missing`](#form_fields--page_fields--page_fields_missing) | The PDF's form field names were read, shown to a page, or not used |
| [`calibrate_call_failed`](#calibrate_call_failed) | One calibration verifier call threw — a tool's line, never a run's |
| [`audit_snapshot`](#audit_snapshot) | Audit mode saved the document at one stage of the run |
| [`audit_unavailable`](#audit_unavailable) | Audit mode is on, but this run could not keep its audit files |

### `page_refit`

One page of an uploaded PDF was rendered a second time, smaller, because the first render came out too
large to send: `pdf` and `page` name it (the PDF's own page number, 1-based), `from` is the size the
first render produced (`8334x8334`), and `long_edge_px` is what the second one was fitted to. One line
per page refitted, so a document of fold-outs writes several.

Written by `src/pipeline/stage.ts`.

### `run_queued` / `run_dequeued`

The run's wait for a concurrency slot: how busy the queue was when it was admitted (`running` of
`limit`, plus `waiting`), and `waited_ms` when it actually started. A large `waited_ms` means the
deployment is saturated, not that this run is slow.

### `run_start`

The run's own opening line: `images`, how many source pages the session has; `feedback`, the text a
re-run was asked to act on, `null` on a first run; and `mode`, one of `full`, `feedback_reextract`
and `feedback_iterative`.

`mode` is not on the session's first line ([`run_queued`](#run_queued--run_dequeued)) because it is
not decided that early. A re-run with saved state
routes its feedback first, so [`feedback_scoped`](#feedback_scoped) sits **above** this line and
decides it: `target: "extraction"` is `feedback_reextract` and `target: "document"` is
`feedback_iterative`. Scoping is a model call, so such a session can have spent money before its own
`run_start` — `feedback_scoped`'s `reason` reads `feedback agent unavailable` on the one path that
routes without buying one. Feedback that arrives with no saved state to build on runs `full`, since
there is nothing to refine — so a `full` run with a [`feedback_rerun`](#feedback_rerun) line above it
is not a first run. [`run_complete`](#run_complete) carries `mode` again.

`images` counts source pages, blank ones and pages that go on to fail included, and it is the only
count of them present on **every** mode: `feedback_iterative` runs no extraction at all, so it has
neither an `extraction_start` nor an `extraction_complete` line to read `pages` off.

This is also where [Diagnostics](#diagnostics-timing--hang-detection) cuts the log. A session's log
accumulates across feedback rounds, so diagnostics slices at the **last** `run_start` and reports
the run after it, ending at that run's `run_complete` or `run_failed`. One case straddles that cut:
a client may POST feedback inside a round's post-delivery window, and with `max_concurrent_runs`
above 1 the next round's `run_start` is then written before the previous round's completion line.

**`phase_durations_ms` is not cut here, and cannot be.** It reads the whole log rather than the slice,
and the `extraction` marker is written *before* this line on every mode, so on a first run the field
covers slightly more than the run and on a session with feedback rounds it mixes them
([`phase`](#phase)).

### `phase`

A phase marker for timing: `phase` is `extraction`, `assembly` or `review`, written as the session's
own `phase` field is set ([Poll status](#poll-status)).
[Diagnostics](#diagnostics-timing--hang-detection) turns these into `phase_durations_ms` by
measuring each to the next, and the last one to the run's terminal line — or to now, on a run still
going.

Three values here and four in [Poll status](#poll-status): `done` is a phase the session record
reaches and never a log line, so the last phase is measured to `run_complete`. A
`feedback_iterative` round has no `assembly` marker, because it assembles nothing — it re-reviews
the body already delivered. So a phase missing from a session's log is not always a phase that
failed.

The inverse holds too, and it is the one to watch: **an `extraction` marker is written on every mode,
`feedback_iterative` included**, before [`run_start`](#run_start) and before the mode is even decided.
So that marker's duration on a round that re-extracted nothing is the time spent routing the feedback
and reviewing, filed under a phase that did not run.

`phase_durations_ms` reads the **whole** log and not the current run's slice, which matters once a
session has taken feedback. Its keys are one per phase NAME, so a later round's marker overwrites an
earlier round's: `extraction` and `review` end up the last round's, since every round writes both.
`assembly` does not, and that is the field to distrust — a `feedback_iterative` round writes no
`assembly` marker, so the value left standing beside that round's numbers is **a previous round's
assembly**, measured from a run that is over.

### `model_call_start` / `model_call`

One completion, from the layer that resolved it: `agent`, `step`, `capability`, `model`,
`provider`, and `api` for a provider that has more than one wire format (Bedrock's `invoke` vs
`converse`, so a comparison of the two says on every line which side produced its numbers).

`step` is the **job** the call was bought for, on both lines, and it is a different question from
`agent`: an agent file is a contract and one contract serves several jobs — the Feedback Agent
checks a freshly extracted page, re-checks a corrected one, routes a user's feedback and classifies
a lesson from it — so the agent name alone cannot price a step, and reading extraction's cost off it
understated the step by a third ([Diagnostics](#diagnostics-timing--hang-detection), which reads
these back as `by_step` and lists the closed set of names). It is on the **start** line because that
is what an in-flight or hung call is asked about, and on a **failed** line because a call that threw
still spent — a truncated editor round paid for a full ceiling of output — and those are exactly the
calls with no answer to attribute them by.

The start marker is written **before** the call, so a hung or in-flight call is a start with no end;
the end line adds `duration_ms`, `ok`, an `error` when it failed, and the token counts flat
(`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) — taken
from the result where there is one, and otherwise from what the adapter reported through a callback
as the call ran, so a call that **threw** still says what it spent
([Diagnostics](#diagnostics-timing--hang-detection) reads these back as `tokens`). One line per
completion, not per HTTP request.

In [audit mode](#audit-off-by-default) the start line also carries `prompt`: each message sent, as
`role`, `sha256` and `chars` (fetch its text at `/audit/prompts/<sha256>`), and each image, as
`media_type`, `bytes` and `sha256`, which matches a page image's hash in the audit list.

`output_ceiling_clamped: true` says this call ran below the output ceiling the deployment
configured, with `output_ceiling_asked` (what `providers.<provider>.max_tokens` says) and
`output_ceiling_stated` (what the model grants): several Bedrock models cap output well below
32000 and **refuse** the request rather than clamping it, so the adapter re-sends at the ceiling
the rejection names and remembers it (issue #249). Present means a config error is live — the
pages arrive, so nothing else downstream shows it, and a deployment can otherwise run for a month
at a ceiling nobody chose with a dense page truncating occasionally.

Read the pair as the remedy: set `max_tokens` to `output_ceiling_stated`, or route that capability
to a model whose ceiling is at least what you asked for. It is on **every** clamped call, not only
the one that discovered it, because the adapter's stderr paragraph is said once per process and
the remembered ceiling outlives the session — a field that copied that dedup would mark one call
in the life of a server and leave every document after the first reading clean.

`output_ceiling_refused: true`, present only on the call that paid for the lesson, is what
separates the condition from its cost: that line's `duration_ms` covers a rejected round-trip as
well as the request that worked. Absent on a deployment whose models accept their ceiling, which
is every deployment today.

`max_output_tokens` is the opposite direction and is **not** a config problem: a ceiling the
caller asked for, below the deployment's, because it already knows roughly how large the answer
should be. Present on the page-correction call only (`correctionCeiling` in
`src/pipeline/extraction.ts`, issue #285) and absent everywhere else, so a truncation on a line
carrying it is the caller's estimate being low and a truncation on a line without it is the
deployment's ceiling — the same two remedies the error message itself distinguishes (**Errors**
below).

It is on the **start** line too, for the same reason `step` is: the calls worth attributing are
the ones with no answer to attribute them by.

### `agent_call`

One agent call that returned, carrying the whole reply in `output` and the prompt version that
produced it. This is the only place a model's raw text is kept — every other line about a call
reports what was *read out of* it — so a question about what an agent actually said is answered here
and nowhere else, and a reply this pipeline then rejected is still on record in full.

| Field | Reads |
| --- | --- |
| `phase` | `extraction`, `assembly` or `review`, matching the [`phase`](#phase) markers |
| `agent` | The agent's **file** name, not its logical name: a table join and a correction round are both the Copy Editor, and they are `copy_editor_table_join.md` and `copy_editor.md`. Read it as a label rather than as a path |
| `agent_sha` | The git blob SHA of the prompt text that was **sent**. `null` at eight call sites |
| `agent_content` | The prompt inline, for a **session-built** agent — one loaded from `tmp/<id>/agents` in preference to the agent library. On **every** line and `null` on all but that one case, so read it as present-and-null rather than omitted |
| `capabilities` | What the agent **declared** it needs (`text`, `vision`, `structured_output`), read off its `## Required capability` section. The one capability that routed this call is `capability` on the [`model_call`](#model_call_start--model_call) beside it, and an agent declaring two does not use both at once |
| `image` | The source image on a per-page call and `null` otherwise — written rather than omitted, like `agent_content` and unlike the count fields elsewhere in this log |

**A call that threw has no line here.** The provider's failure is on `model_call` with `ok: false`, and
this line is written after the call returned — so these lines count answers, not attempts, and a phase's
spend cannot be read off them.

**Two `agent_call` lines cannot be told apart by any field on them**: a training round's two fixture
replays, one per prompt being compared. The rule that separates them, and its two caveats, are in
[design notes — telling a training round's two replays
apart](design-notes.md#telling-a-training-rounds-two-replays-apart). What recovers a prompt at each of
the eight null-SHA sites, and which single one is recoverable nowhere, is [what recovers the text a
prompt actually sent](design-notes.md#what-recovers-the-text-a-prompt-actually-sent).

### `extraction_start`

The page pass is about to run: `pages`, the `concurrency` it will run them at, and what it will
measure while it does — `recheck_sample_size` (`defaults.recheck_sample_size`, the number of
corrected pages to be re-verified, 0 for none) with `recheck_thresholds`, the page orders those
slots sit on. The two measurement fields are here rather than left implicit because their absence
made a log ambiguous three ways: no `page_correction_recheck` in a run can mean the measurement is
off, no page needed correcting, or every corrected page falling below the first threshold, and
those have different remedies (issue #288).

The thresholds are computed from the orders of the pages **this** batch runs, so they say which
pages could have answered and not merely how many.

### `page_lessons_injected`

Lessons learned from earlier feedback were added to the page agent's prompt, so the agent improves
without `agents/page.md` being rewritten (issue #1). `chars` is how much text was added.

Written by `src/pipeline/extraction.ts`.

### `feedback_rerun`

Feedback arrived, and the document it is about was copied aside before this round overwrote it:
`feedback` is the text as submitted, and `prior_output` the path the previous `output.html` was
snapshotted to, relative to the session directory (`history/output-<timestamp>.html`). That copy is
the only record of the document as it was delivered before this round; nothing else keeps it, and
[Fetch the HTML output](#fetch-the-html-output) serves what this round produces.

`prior_output: null` means there was no delivered output to snapshot. Written for **every** re-run,
including one that goes on to run `full` for want of saved state ([`run_start`](#run_start)) — so
this line, and not `mode`, is what says feedback was submitted at all.

### `feedback_scoped`

How a feedback re-run was routed (`document` vs `extraction`, and which pages)

Fields: `pages`, `reason`, `target`.

Written by `src/pipeline/orchestrator.ts`.

### `first_read_carried`

A document-level feedback re-run kept the document's earlier first-read count for the quality tally
instead of recording its own (the [quality tally](#quality-tally-shared-secret-off-by-default)'s
`first_read`, issue #313).

Fields: `carried`, `found`, `unread`.

Written by `src/pipeline/orchestrator.ts`.

### `reextract_start` / `reextract_complete`

Which pages went back to the page agent. `reextract_start` also carries the same
`recheck_sample_size` / `recheck_thresholds` pair as `extraction_start`, spread over the pages
this round re-extracts rather than over the whole document — a round re-running pages 7, 12 and 20
of 25 has its own thresholds, since bands taken from the document's length would all fall below
page 7.

`reextract_complete.pages` is what was actually re-extracted; a `failed` list is pages whose
re-extraction threw and which therefore kept their **prior** content unchanged.

`reextract_complete` also carries `alts_checked` / `alts_generic`, `ids_checked` /
`ids_duplicated` and `words_checked` / `words_split`, and they are over the **whole** document this
round delivers rather than the pages it re-ran — the prior round's pages with the re-extracted ones
substituted in — so they are comparable with `extraction_complete`'s and a session's log does not
read as its alt, id or word corpus shrinking every time a client sends feedback. Comments are
stripped before the two alt counts and before the two word counts, as on `extraction_complete`, and
the two id counts are read off each fragment's parsed tree, where a comment is not an element.

`uncorrected` is over the whole document too, and for the same reason: a round that repairs one
rejected page out of three should read as two left rather than as one page re-run. It follows the
document page by page — a page re-rendered and now accepted leaves the set, one rejected again
stays, one this round never touched keeps the prior round's verdict, and one whose re-extraction
**threw** keeps it too, because it is the prior fragment that ships and so the prior verdict that
describes it.

### `reextract_skipped`

Pages this round meant to re-extract and could not: `pages`, the orders it gave up on, and `reason`,
which is `no source image or prior fragment` — the only value the line carries today.

Written by `src/pipeline/extraction.ts`.

### `page_redrawn`

A draw carried no page **and claimed nothing about the page**, so the same call was made once more
(`page`, `image`, `chars` of the discarded reply, its `shape`, `dropped` where markup arrived, and
`reextract: true` on a feedback round). The fields are `page_no_output`'s, because the triage
question does not change — the draw that lost is the one worth reading — and this line is where a
recovered page's losing draw is recorded. **A page that recovers has this line and no
`page_no_output`; a page that loses twice has this line and then that one.** So every count taken
off `page_no_output`, here and in `pages_failed`, still counts pages given up on rather than draws
discarded.

**Once, and never twice.** The failure this is for is a draw the model can lose, and a page that
loses two in a row is not that page.

**The gate is that the reply asserted nothing, not that it was short.** A reply Iris refused whole is
0 characters of HTML however much page it was carrying, so a character floor would redraw every page
that correctly declared itself blank. Reaching this branch at all is rare: about **1%** of pages
drawn at least once, over every bench round on disk.

A redrawn page's second draw re-runs the four repair seams, so `page_soft_hyphens`,
`page_style_attributes`, `page_digit_groups` and `page_links` can fire twice for one page. The second
draw's lines carry **`redrawn: true`**, because `where` attributes a count to the call it was billed
under and a redraw makes two calls at the same seam: an offline per-occurrence census discounts the
flagged lines rather than counting a discarded draw's markup as page content.

**A provider failure never reaches this line:** a throttle, a stall and a refusal all throw before a
reply exists to read, and that boundary is deliberate.

**A reply the model itself cut short does reach it**, as `truncated_envelope`, and is redrawn — where
a truncated *correction* is not, because a correction's page survives its failure and a first
render's does not. A page that genuinely exceeds the ceiling loses the second draw as well, and its
remedy is `providers.*.max_tokens`.

Two shapes of blank-page declaration this gate cannot read are redrawn anyway, each costing one call
and changing no outcome. Why the gate reads a declaration rather than a size, what the corpus behind
the rule is, and what those two shapes are, is in [design notes — a draw that claimed
nothing](design-notes.md#a-draw-that-claimed-nothing-and-the-corpus-behind-redrawing-once).

### `page_no_output`

The page agent answered, and no HTML could be read out of the answer (`page`, `image`, `chars` of
text, and the `shape` it was in). A reply that claimed nothing about the page has already been
[redrawn once](#page_redrawn) by the time this line is written, so this is the second draw's failure
and the page is now given up on: [`page_extraction_failed`](#page_extraction_failed) follows it and
the page is lost the way any failed page is lost. "The reply could not be read" and "this text is
the page" are different claims, and a reply delivered as content would put a JSON envelope, or an
apology, into the document while the run reported every page delivered.

`shape` names the remedy:

| `shape` | What the reply was | What to do |
| --- | --- | --- |
| `truncated_envelope` | The output ceiling cut it off | Raise `providers.*.max_tokens` |
| `envelope` | Complete, and its escaping defeated the parser | Rare — a reply whose only fault is the page's own unescaped punctuation is repaired before it reaches here. Report it |
| `prose` | The agent answered conversationally | A prompt problem |
| `empty_html` | An envelope read perfectly that carried no page | A prompt problem |
| `empty` | Nothing in the reply at all | A prompt problem |
| `bare_html` | The page's markup rather than the envelope | Read `dropped` — two findings, opposite remedies |

`empty_html` is no `html` key at all, or one whose HTML holds nothing a reader receives and whose
`log` does not say the page is blank — the model answering with no page and not saying why, or
saying it could not read it. **"Nothing a reader receives" is not "an empty string":** a comment, an
empty wrapper and a bare page-break marker are all nothing, so a refused blank declaration reaches
this line whichever way its fragment was written.

`bare_html` is markup the pipeline normally accepts and delivers (`bareHtml` in
`src/pipeline/extraction.ts`). On **this** line it is one of two things with opposite remedies, and
the shape cannot tell them apart: either the markup arrived behind a fence that never closed, so a
page was refused by the parser and the text on the line is that page, or the markup arrived fine and
carried nothing a reader receives, which is a prompt problem exactly as `prose` is. `dropped` is
what separates them — it holds that markup, under the same 200-character bound as on
[`page_blank`](#page_blank), because `chars` is the length of the whole reply and not of the fragment.

A page the agent reports as **blank** is not here: that is [`page_blank`](#page_blank), and not a
failure.

**Where the reply did claim the page was blank and the claim was refused,** four fields say which
check refused it and what it read:

| Field | What it holds |
| --- | --- |
| `blank_vetoed` | The doubt words that refused the claim — the reply says the page could not be *read* |
| `blank_contradicted` | The words that named content on a page the log had just called empty |
| `blank_stated` | `true` where the refused claim was made in the reply's `blank` field rather than left to be read out of its prose |
| `log` | The agent's own sentence |

Without them the line reads as "the model answered with no page", which is the opposite of what
happened, and tracing four such pages back to a single word once meant rerunning the regexes on the
replies by hand (issue #190).

`blank_stated` here is the one thing in these logs that can show the field being misused: a page
whose log says it could not be read is the one page the prompt tells the model never to send the
field for, and a run carrying `blank_stated` only on the line that honoured it could count the field
working and not the field failing (issue #371).

`blank_contradicted` on **this** line means the claim was made in prose. A claim the reply STATED in
its `blank` field is not refused for a contradiction: it lands on [`page_blank`](#page_blank) with
the same field name and a verify call instead (issue #371).

**These are two findings with two remedies, and one line can carry both.** A doubt word means the
page could not be read and wants a better scan. A contradiction means the agent answered with no
page for a page it says has content on it, which wants a re-extraction. They are read independently,
so `"Page is blank. The scan is blurry. There is handwriting on the page."` fills `blank_vetoed`
with `blurry` and `blank_contradicted` with `there is handwriting`. **On a line with both, act on the
doubt first** — a reply that could not read the page is not a reliable witness to what is on it.

Which words count as doubt, as a contradiction, or as a declaration is a long rule, and every clause
of it was bought by a page that had been lost: see
[design notes — reading a blank-page declaration](design-notes.md#reading-a-blank-page-declaration).

### `page_bare_html`

The page agent's reply was **markup rather than the envelope**, so the page was rescued from the
text as it stood (`page`, `image`, `chars` of the whole reply, `html_chars` of the markup taken
from it, and `reextract: true` on a feedback round). The page **shipped**: it is in neither
`pages_failed` nor `pages_blank`, the HTML is usable, and that is why the rescue exists. What it
did not ship is a `"log"` — there was no field to put one in, and `agents/page.md` asks for that
field by name in 26 places, six of which are obligations it discharges there and **nowhere else**:
a page ending mid-sentence, a heading with no parent on the page, a symbol with no key, a
placeholder image source, a language change, an irregular table.

On these pages every one of those is unmet and unreported while the run says every page was
delivered. Not rare, which is why it is now a line of its own: 41 of 300 first page calls across
two multi-vendor bench rounds and 54 of 400 across four deployed rounds of one PDF (13.7%), and 0
of those 41 left any other line behind. It is also the discriminator between the two readings of
an empty log — `log: ""` **with** this line means the reply had no envelope, and without it means
the model sent one and left the field empty, which is a prompt-compliance question rather than a
parse one and has the opposite remedy.

Which of the two the deployed models do is answerable now: over 67 round logs on file, 2,320
`page.md` replies are 2,001 with a non-empty log and 319 bare, and **0** with an envelope whose
log is empty.

`chars` and `html_chars` are both here because they answer different questions — `chars` is what
the reply was billed for and `html_chars` is what the page got, so a rescue that delivered a whole
page and one that salvaged a fragment of a truncated reply are otherwise the same event.

`reextract` marks the feedback round because the 13.7% is a rate over **first** calls and a count
that pools rounds is not comparable with it. The verify step is sent no log section for these
pages, and `agents/feedback.md` tells it to say nothing about the absence: that is a fact about
the reply, not about the page (issue #349).

### `page_blank`

The page agent read the page and reported it empty (`page`, `image`, and its own `log` line), so the
page is delivered as an empty fragment because there was nothing on it to deliver.

**Not a failure and not in `pages_failed`.** The remedies are opposite: a failed page is work to
redo, and a blank page is work already finished.

A reply earns this line when it is a complete envelope whose `html` is present and carries **nothing
a reader receives** — no visible text, and none of the elements that are content with no text in
them (a picture, a grid, a form control) — **and** it says the page is blank, either in the reply's
own `"blank": true` field or, where that field is absent, in a `log` that asserts it in so many
words. `blank_stated: true` says the declaration arrived in the field.

`dropped` carries the markup, bounded to 200 characters, where the declaration was spelled in markup
rather than as an empty `html` — a comment, an empty wrapper, a page-break marker. The fragment
delivered is `""` whichever spelling arrived, so without the field the line would not say which one
did. Prose is content whatever it says: `<p>This page is blank.</p>` is not a declaration, it is
delivered as the page's words.

**No verify call is bought for a blank page.** Its [`page_verify_ok`](#page_verify_ok--page_verify_failed)
line says so with `skipped: "blank"` and `unjudged`. The one exception is a declaration **stated** in
the field whose own log names something on the page: that page is delivered *and* judged, carries
`blank_contradicted` on this line and no `skipped` on its verify line, and the log's claim is quoted
to the verifier in its own words beside the empty fragment — so a log that was right about the
heading it named buys a correction and the reader gets the page.

**This line therefore counts the declarations that were made, not the pages that ended up empty.**
[Diagnostics](#diagnostics-timing--hang-detection) reads the ones that cost a verify call off it as
`pages_blank - pages_skipped_blank`, and a page whose content came back that way is the
[`page_corrected`](#page_corrected) line beside it, with `trigger: "verify"`.

**No page-break marker is delivered for a blank page,** whatever the paper prints, so a marker that
arrives anyway goes to `dropped` with the rest of the fragment. A page whose only printed content
**is** its folio is one of these pages by decision: the folio is never transcribed as text and the
marker it may be carried in is never delivered, so such a sheet has nothing on it a reader receives.

Two limits to know before triaging a run off these lines:

- **A confident wrong declaration about a page whose source file says nothing is not caught.** It is
  delivered as an empty page and this line is the whole of the evidence it leaves, so a run with no
  surprising `page_blank` lines is not evidence that no such page occurred. Where the source file
  *does* carry link annotations for the page, the document contradicts the declaration and
  [`page_links_missing`](#page_links_missing) fires on it as on any other page, buys a re-render
  against the image, and that fragment is verified in turn.
- **The field states and cannot deny.** `"blank": false` is read as no answer at all and the sentence
  decides, exactly as it did before the field existed, so every error the field can make runs in one
  direction. It is read loosely enough for `"true"` as a string and no further: `1`, `"yes"` and
  `"blank"` are silence, because a field loose enough to accept them deletes a page on a typo. And it
  cannot declare a page blank that came back with a page on it.

Where a declaration is refused rather than accepted, the line is
[`page_no_output`](#page_no_output) carrying `blank_vetoed` or `blank_contradicted`, or — on a
feedback re-extraction of a page Iris already holds content for —
[`page_blank_refused`](#page_blank_refused) below. Which words count as a declaration, a doubt or a
contradiction, and what each clause of that rule cost before it existed, is in
[design notes — reading a blank-page declaration](design-notes.md#reading-a-blank-page-declaration).

### `page_blank_refused`

A feedback re-extraction declared a page blank that the document already has content for (`page`,
`image`, `chars_kept`, the agent's `log`, and `dropped` — the markup the declaration was spelled
in, where it was spelled in any), so the declaration is refused and the page keeps that content.

`blank_stated: true` is on this line too where the declaration came from the `blank` field, for
the same reason as on `page_no_output` above: the field can be sent for a page Iris already holds
content for, and a log that recorded the field only where it was believed could not show it (issue
#371). The model was shown its own previous output for the page and then said the paper was empty,
which contradicts what Iris already holds; the page is then handled as any re-extraction that
could not improve it — `page_extraction_failed` with `kept: "prior"`, and the page in
`reextract_complete.failed`.

Nothing else would catch it: the shrink floor guards the *correction* pass, where the comparison
is against that round's own render, so prior → empty never reaches it. That is also why the test
is what a reader receives rather than whether `html` is empty — a re-extraction answering
`<!-- blank page -->` for a page with content used to walk straight past this refusal and replace
the content with the comment, and 13 renders in the bench corpus are that reply (issue #219). A
page that was **lost** can still come back blank and be recovered: there is no content to
contradict.

### `page_extraction_failed`

One page's own extraction threw (`page`, `image`, `error`). The rest of the document still ran — see
[Partial documents](#partial-documents). `kept: "prior"` marks the feedback-re-extraction case,
where the page keeps the content it already had and the document stays whole. A **truncation**
carries three more fields (#293), the same three as `page_correction_failed` below and for a
stronger reason: there the page survives the failure, while here its content is gone, so the excerpt
is the only record of what the model had written when the ceiling cut it.

`reply_chars` is how far the reply reached, `reply_head` its first 240 characters and `reply_tail`
its last 240 — one budget of the user's text, quoted **entire** under `reply_head` when the
fragment is shorter than both excerpts together, exactly as on `editor_truncated`. Deployment
only: like every excerpt of a document, it stays in the run log and never reaches
`GET /v1/quality`. There is no `ceiling` field here because a first pass carries no cap of its own
— the ceiling is the deployment's, and the error names it.

`truncated: true` with **no** `reply_head` at all is the shape worth watching: a call that spent a
whole ceiling of output and never began the page, which is a reasoning model burning the budget
before the answer, not a page that needed more room (see [Errors](#errors) and `EMPTY_REPLY` in
`src/providers/types.ts`).

### `extraction_complete`

How many page fragments came out (`pages`) and which page numbers failed (`failed`, always
present, `[]` on a whole run).

`uncorrected` is the other set, and the opposite failure: page numbers the fidelity check
**rejected** whose one correction pass repaired nothing, so what the document carries for them is
content Iris named a defect in and never fixed ([Partial documents](#partial-documents),
`@page-uncorrected`, #328). Always present and `[]` where no page shipped that way, for the reason
`failed` is — a field that only appears when it fires cannot tell "every rejected page was repaired"
from "this run predates the count". Disjoint from `failed` by construction: a page whose render
threw never reached a verdict, so it cannot be in this set, and the two counts add rather than
overlap.

It is the roll-up of what `page_verify_failed` and then `page_correction_failed` or `page_corrected`
already say a line at a time — worth having as one field because reading it off those needs a join
per page, though the rule is one line: a page whose verdict failed is in this set exactly when its
`page_corrected` `result` is **not** `kept` ([Partial documents](#partial-documents)).

`alts_checked` / `alts_generic` are the generic-alt rule over the fragments the document is built
from — every non-empty `alt` on an `<img>`, and how many of them are a placeholder rather than a
description (#290). Asked **after** any correction, so a non-zero `alts_generic` is a placeholder
this step could not repair, which is a different statement from the per-page `page_generic_alt`
finding. It is not a statement about the delivered document: the review loop runs afterwards and
can replace a block's `<img>` along with its markup, which is what `delivered_alt` is measured on.

Both are present at zero on every run, for the same reason `failed` is: a class reported only when
it fires cannot distinguish "it never happened" from "the check never ran", and this rule's whole
claim is that it fires on nothing the page agents write.

`alts_checked` is what makes the zero readable — 0 of 0 says nothing about the rule, 0 of 40 says
something. Comments are stripped before either count, as on `page_generic_alt` and
`delivered_alt`.

`ids_checked` / `ids_duplicated` are the same pair for the id rule (#373): how many elements
across those fragments carry a usable `id`, and how many of those ids are used more than once
**within one fragment**. Per fragment and summed, which is the only count this rule can make — two
pages sharing an id is not a defect at this point, since `namespaceAnchors` prefixes each page at
assembly, and pooling the document's ids into one set would report that fix as a failure once per
page. Present at zero on every run, and it matters more here than for the alts: this rule fires on
2 of 1,501 measured page replies, one of them on the model deployed today, so a field that appeared
only when it fired would be indistinguishable from the check not running.

Read off the parsed tree, so markup the HTML parser discards — an orphan `<td>`, anything inside a
comment — owns no id: an over-collected id would be a phantom duplicate, and on this path that
buys a rewrite of a page with nothing wrong with it.

`words_checked` / `words_split` are the third pair, for the split-word rule (#334): how many words
those fragments contain, and how many words a fragment writes **two ways** — one word counted once
however often it appears. Per fragment and summed, and here for a reason of its own rather than
`ids_duplicated`'s: a word written one way on page 3 and the other way on page 40 is not this defect
at all, since a printing breaks a word wherever the column falls, so pooling the document's words
would manufacture contradictions out of the whole corpus's vocabulary.

Unlike the two pairs above, `words_split` is **expected to be non-zero**. On #334's 100-page census
every one of three models contradicted itself somewhere — `kimi-k2.5` on 4 pages, `claude-sonnet-4-6`
on 3, `gpt-5.6-luna` on 2 — so a run reporting 0 of 20,000 is the reading to check the rule against,
not the reading to be reassured by. And a non-zero here after correction is not necessarily a repair
that failed: a page that really does print both spellings is invited to say so and change nothing.

### `page_generic_alt`

A page described an image with a placeholder instead of a description (`page`, `image`, `alts` —
the values as written, duplicates included). Free and exact, run on every page rather than on the
ones a sampled verifier looks at, and fed to the same self-correction pass as a dropped link: the
fix needs the image, so it needs the page agent. This is not a blind spot being covered — the
deployed verifier catches a gutted `alt` 6 times out of 6 — it is a capability being moved off the
model's bill, because the cheaper verifiers it may be swapped for catch it 0–2 times out of 6 and
`axe` catches it never (#290, #246).

The list is closed and matched whole: `alt="logo"` is a finding, `alt="Meta logo"` is not, and
`alt=""` is left alone as a valid statement that an image is decorative. Comments are stripped
before the scan, here as on `delivered_alt`: an `<img>` a page quoted inside a comment is not an
image a reader is offered, and on this path a false finding is not just noise — it buys a rewrite
of a page that had nothing wrong with it.

### `page_generic_alt_unrecovered`

A correction bought for a placeholder `alt` was kept and the placeholder is still there (`page`,
`image`, `alts` — the values that remain). The mirror of
[`page_links_unrecovered`](#page_links_unrecovered) in what it measures, and the reason a
deterministic rule is worth more here than a model that finds the same defect: the check that
raised the complaint can be run again on the answer, exactly and for nothing, so "the rule found
something" and "the rule got it fixed" are separable at no cost. Only logged where the correction
was bought for an alt in the first place — which is where the mirror stops, since the link line is
logged whenever a kept correction leaves a link missing, however that correction was bought.

### `page_duplicate_ids`

One page fragment used the same `id` on more than one element (`page`, `image`, `ids` — each
duplicated id named once and sorted, however many copies it has). Free and exact, on every page,
fed to the same self-correction pass as a dropped link. It is at the page step rather than left to
lint for a reason the other two free rules do not have: this defect **does** have a downstream
reporter and that reporter cannot fix it.

`namespaceAnchors` makes ids unique across the document by prefixing each page's, so a page that
collided with **itself** gets the same prefix on both copies and stays collided — the one case it
declines by name — and lint then names the collision on the assembled document, on a page nobody
will look at again with the image in front of them, usually as `p3-fn-1` rather than under the
name the page wrote (usually and not always: nothing is prefixed unless more than one *page*
claimed the id). Here the model that chose the ids is still holding the picture.

A blank `id` is not this rule's finding: it is invalid markup, but "renumber every copy after the
first" is not its repair.

### `page_duplicate_ids_unrecovered`

A correction bought for a duplicate `id` was kept and a duplicate is still there (`page`, `image`,
`ids` — the ones that remain). The mirror of `page_generic_alt_unrecovered` and free in the same
way. The remaining ids are named rather than counted because, unlike an unrecovered link, this is
not matched against anything the page arrived with: a correction renumbers, so it can clear `fn-1`
and collide on `fn-2`, and that is a repair that **moved** the defect rather than one that failed
to touch it. Only logged where the correction was bought for a duplicate id in the first place.

### `page_links`

The source file's own link annotations were listed in this page's prompt: `image`, `links` — how many
were shown — and `dropped`, how many the page had beyond the cap of 40.

Fields: `dropped`, `image`, `links`, `redrawn`.

Written by `src/pipeline/extraction.ts`.

### `page_links_missing`

Links the source file annotates that the page's HTML does not contain: `image`, and `links`, the hrefs
that did not arrive.

Checked in code rather than left to the fidelity verifier, because this is the defect that verifier
structurally cannot see: it judges the output against the **image**, and a link's target does not
appear there. A dropped link is invisible to it and a fabricated one is unfalsifiable. The comparison
against the file's own annotations has an exact answer, so it is made in code, for nothing, on every
page — and its result is handed to the same self-correction pass as any other fidelity problem.

Matched by normalized URL and deduplicated: one `<a>` is enough to say a target survived, so a page
that links the same URL under two phrases does not report a miss for a link it has.

A page can be listed here and have **passed** its fidelity check. That is the case this rule exists
for, and it is why the correction it buys is verified in turn — see
[`page_links_correction_rejected`](#page_links_correction_rejected). What a correction was asked to fix
is `trigger` on [`page_corrected`](#page_corrected), which reads `links` when this line is why.

### `page_links_unrecovered`

A self-correction was **kept** on this page and the delivered fragment is still missing links the
source annotates: `image`, and `links`, the hrefs still absent.

The correction pass is single-shot, so this is the delivered document's state rather than an
intermediate one — a link named here is missing from what the caller receives. The line exists to keep
apart two questions one count cannot: whether the free check **found** something, and whether it got
it **fixed**. Only the second is evidence about what the verifier's model is worth.

Only on a **kept** correction, which on [`page_corrected`](#page_corrected) is `result: "kept"` or
`"identical"`. A page whose correction was rejected shipped its original fragment, so its missing links
are on [`page_links_missing`](#page_links_missing) and here on neither.

**Not gated on links having been the reason for the correction**, and that is the one respect in which
it is not the mirror of [`page_generic_alt_unrecovered`](#page_generic_alt_unrecovered), which is. So
this line's pages are not a subset of `page_links_missing`'s: a correction bought for a placeholder
`alt`, a duplicate `id` or a failed fidelity check can **drop** a link the page already had, and that
lands here with no `page_links_missing` line before it. It is the same failure
[`editor_links_dropped`](#editor_links_dropped) records for the Copy Editor, one step earlier in the
run. Which of the two happened is readable: look for a `page_links_missing` line with the same `image`.
With one, a repair was bought and did not take; without one, the correction lost a link that was there.

### `page_links_unexpected`

Absolute URLs the delivered fragment links to that no annotation on this page accounts for: `image`,
and `hrefs`.

Written by `src/pipeline/extraction.ts`.

### `page_links_correction_rejected`

A correction bought for a page that had already passed its fidelity check was refused by the second
verdict, so the page shipped as it was: `image`; `trigger`, what the correction had been asked to fix;
`links`, the hrefs that were missing; `alts`, `ids` or `words` where those were part of the same
call; and `problems`, what the **second** verdict objected to — the field that says why the billed
rewrite lost.

`problems` is that verdict's objections **as prose**, an array of the strings it wrote. That is not
what the field of the same name carries on [`page_corrected`](#page_corrected), which is a count of the
problems the correction was *given*; the two lines can appear for the same `image` in one round, so a
reader summing "problems" across the log without checking which line it came off is adding a list to a
number.

`links` is always present and is `[]` where the refused correction was bought for a placeholder
`alt`, a duplicate `id` or a word written two ways alone, so the field to read for what the call was
for is `trigger`, not this one.

The name is older than the rest of the line, and keeping it is deliberate. It began as the links-only
case, and renaming it now would split one measurement across two event names in a log that is read
across rounds. `trigger` is what says which repair was refused: `links`, `alt`, `ids`, `words`, or
`both`. It cannot read `verify` here, though that value exists on
[`page_corrected`](#page_corrected) — this recheck is only bought for a page whose fidelity check
**passed**, since a page that failed has no standing to protect.

`both` means more than one source fired, and deliberately not which combination. That collapse is a
property of the shared `trigger`, computed once for this line and [`page_corrected`](#page_corrected)
from five sources — where naming the combination would be thirty-one buckets — and only four of the
five can reach *this* line, since `verify` cannot. The per-source detail is already exact on
[`page_links_missing`](#page_links_missing), [`page_generic_alt`](#page_generic_alt),
[`page_duplicate_ids`](#page_duplicate_ids) and [`page_split_words`](#page_split_words), all keyed by
the same `image`. `alts`, `ids` and `words` are on the line anyway, and that is the reason: `both`
cannot say the alt, the duplicate id or the split word was part of what the refused call was asked to
fix. `words` carries one further reading the others do not: a refused correction bought for a split
word may be a rewrite that lost, or a model that declined the problem — which on that check is a
legitimate answer — and was overruled by the recheck.

The correction is billed either way, so this is a line about money that bought nothing — a page that
was known to be good was re-rendered, the rewrite was judged in turn, and the rewrite lost. A verdict
that could not be **obtained** lands on [`page_verify_error`](#page_verify_error) with
`correction_discarded` instead, so no verdict and a failed verdict are the same outcome for the page
and two different lines in the log.

### `page_soft_hyphens`

Soft hyphens (U+00AD) were taken out of a page reply before it became markup Iris keeps (`page`,
`image`, `removed` — every occurrence, not every word — and `where`: the step whose reply carried
them, one of `extract`, `correct`, `specialist`, `specialist_merge`). A word the printing broke
across a column, carried into the HTML as an invisible character:

`agents/page.md` forbids exactly that, with a worked example, and three models from three labs do
it anyway — 63 occurrences on 9 pages of one 100-page arm, reaching 23 of 62 delivered documents,
on pages the fidelity check passed (#334). It renders as nothing, so the page reads as clean while
find-in-page fails: a reader searching a delivered document for `Insurance` does not match
`Insur&shy;ance`, and the words this lands on are table row labels and column headings. The strip
is unconditional because there is no output where the character is the right answer — it needs no
image, no word list and no second model — and it covers the entity spellings (`&shy;`, `&#173;`,
`&#xAD;`) as well as the codepoint, since those render and defeat a search identically.

**Logged only where it fired**, so a run with none of these lines is a run in which no reply
carried one. `where` is what makes the count attributable: the same character from a first render,
from the correction pass and from a specialist are three facts about three different calls — and
`redrawn: true` is present when the reply was a page's [second draw](#page_redrawn), whose markup Iris
discarded, because a redraw makes two `extract` calls for one page. The same flag appears for the same
reason on `page_style_attributes`, `page_digit_groups`, `page_links` and `page_fields`. It is
written AFTER `agent_call`, so the reply on record in the round logs is still the model's own —
the census behind this row was a $0 regrade of logs already on disk, and a strip applied before
the log would have left no way to take that measurement or any future one.

### `page_style_attributes`

`style` attributes were taken out of a page reply before it became markup Iris keeps (`page`, `image`,
`where` — the same four steps as above — `stripped`: how many attributes, `spans`: how many `<span>`
elements this strip left holding nothing but whitespace and so removed whole, `cells_emptied`: how many
`<td>`/`<th>` cells were left holding nothing by those removals, and `props`: the CSS property names
those attributes set, deduped and sorted).

`agents/page.md` forbids all styling in as many words — a `style` attribute is not announced, does not
survive being read aloud, and is dropped by anything that reformats the document — and #374 measured 52
of them shipped anyway on one 91-page arm. The strip cannot lose anything a reader was getting, which
is what makes it a repair rather than a re-ask: whatever the declaration was doing, it was doing it
only for someone who could see it.

**`props` is the field to read.** 46 of those 52 are `padding-left`, 40 of them on a single page's row
headings, and that is a table's row groups written in ink instead of in markup — information the page
HAS and the delivered document does not. Removing the attribute does not lose that, but it does make
the page look clean, so the properties are logged: a line saying `padding-left` names a page whose
hierarchy needs the `<tbody>`/`scope="rowgroup"` treatment the prompt asks for, and one saying
`background-color` names a legend swatch that painted nothing and announced nothing. Rebuilding either
is a re-ask against the image and is not something the strip can do — the stated limit of the repair.

`spans` is counted apart from `stripped` because it is a different edit: an element removed rather than
an attribute. It covers only the residue THIS strip creates — a `<span>` whose attributes were all
`style` and whose content is nothing but whitespace — so a `<span></span>` the model wrote empty of its
own accord is left alone, and a `<span class="…" style="…">` keeps its element because it still has an
attribute afterwards. The removal is repeated until it stops changing anything, because a styled span
whose only content is another styled span is invisible to a single pass — the outer one would survive as
the bare `<span></span>` the rule exists to prevent, with `spans` and `cells_emptied` both short by one on
a mark that is just as gone. That nesting is not a shape anything has been seen to write (0 of 69 styled
spans over 1,741 of the bench's kept HTML files), so the repeat is there to keep the counts honest on a
shape they were not looking at, not because it was measured. **What goes is the element, never content:**
a span holding one space hands that
space back, because the same markup is a legend swatch's width in one place and a word boundary in
another, and only one of those two mistakes is visible in the delivered text (`Ohio<span
style="…"> </span>5%` would otherwise be delivered as `Ohio5%`, which the page prints nowhere).

**`cells_emptied` is the one number here that names work rather than housekeeping.** A legend swatch
written as `<td><span style="background:#ccc"></span></td>` leaves `<td></td>`, and `agents/page.md`
calls an empty cell the one encoding a reader cannot undo, because the cell then claims the paper printed
nothing there. The strip does not create that defect — the cell held no text before it either, so a
screen reader announced an empty cell both ways — but it removes the last trace that the page had a mark
there, so a page with this above zero is a page whose mark is unrecoverable without the image. Cells that
were already empty are not counted; the number is what these removals added.

The strip does not read inside an element whose content the parser reads as text (`script`, `style`,
`textarea`, `title`, `xmp`, `iframe`, `noembed`, `noframes`, `plaintext`), because a `<` in there opens
nothing and a page transcribing a report on markup can print a tag's source unescaped. That list is
narrower than `src/pipeline/anchors.ts`'s for the same shape of skip, on purpose: a `<template>` or a
`<select>` interior IS parsed as markup, so a `style` attribute in one is a real attribute and skipping
them would leave a hole rather than close a false positive.

Scoped to the extraction phase like the strip above, but WITHOUT that clause's argument, and the
difference is worth stating. A soft hyphen is an artefact of reading a printing; a `style` attribute is
a model reaching for CSS to hold a shape, which any agent writing markup can do, and the review-phase
agents write markup. #374 measured the page agent because that is what #374 looked at, so what is known
is that it happens there — not that it happens nowhere else. `where` is what would say otherwise.

### `page_digit_groups`

A thousands separator the page reply split with the printer's alignment space — `4, 271` — was closed
up (`page`, `image`, `where`, and `tightened`: how many separators, not how many cells).

Written by `src/pipeline/extraction.ts`.

### `page_split_words`

A page wrote one word two ways (`page`, `image`, and `words` — one entry per word, `"Compos-ite /
Composite"`, each spelling as the page wrote that one, in the order the hyphenated form first
appears). The other half of the hyphen family above, and the half a strip cannot do: this is the
**visible** break (U+002D), where `page_soft_hyphens` is the invisible one.

A page that writes both `Compos-ite` and `Composite` has certainly got one of them wrong, whichever
the paper prints, and that is the whole finding. It needs no word list — the evidence is the page's
own two spellings, so English is never consulted, and #334 measured what happens when it is
(`/usr/share/dict/words` scored `totals`, `states` and `populations` as non-words while failing to
match `manu-facturing` against `manufacturing`, wrong in both directions) — no second model, no
second arm and not the image. So it is free and exact on the same terms as a dropped link.

It also fires where the strip does not, and on **every** arm rather than one. On #334's 100-page
three-arm census the soft-hyphen column is 63 occurrences on 9 pages from `claude-sonnet-4-6` and
zero from `kimi-k2.5`, the page model of the day; this check's own column there — one word written
both ways on one page, the predicate above, not the wider count of retained visible hyphens beside it
— is `kimi-k2.5` **6 words on 4 pages**, `claude-sonnet-4-6` 3 on 3, `gpt-5.6-luna` 2 on 2.

The problem it raises does **not** say which spelling to keep, and that is deliberate to a degree
the census measures: three of Kimi's six are `inter-state` and `non-farm`, forms a 1962
report genuinely prints, so on half the measured cases the hyphen is right and the joined spelling
is the defect. "Join them" would have been the wrong instruction there, and on a page that
legitimately prints both forms it is how a defect gets introduced. Only the agent holding the image
can settle it, and `agents/page.md`'s hyphen rule already tells it how: "Where you cannot tell whose
hyphen it is, keep it".

Read **after** the soft-hyphen strip, and that order is load-bearing rather than tidy:
`Govern<U+00AD>ment` has contiguous letters, so a page carrying the invisible break writes the word
whole as far as any text comparison can tell and the contradiction is hidden (#334 measured this on
the page this rule comes from).

**A lower bound, not a rate.** A page that breaks a word and never writes it whole is invisible
here, since it is the second spelling that makes the first a contradiction. #334's cross-arm
version of this test asks whether *another* arm delivered the word whole, and that is not available
at run time with one arm running. Three further limits, each narrowing in the same direction:
attribute text is not examined at all, `alt` included (`href`, `id` and `class` carry hyphens by
convention, and `id="non-tax"` beside the word `nontax` is not a contradiction about anything a
reader is shown); only unhyphenated words corroborate, so a page writing `Commu-nications` and
`communications-related` and never the bare word finds nothing; and only one internal hyphen counts,
so `Con-struc-tion` and `Trans-porta-tion` — two breaks each, on `p032` of the same census, and
missed by #334's first detector for this same reason — are skipped. That last one is a limit and not
a proof: neither of those words is written whole anywhere on its own page, so admitting them would
have added nothing to this count on **that** corpus, which is a fact about the corpus. One hyphen is
kept because it is the shape of the common case and because it keeps a printed compound like
`state-by-state` from being compared against a `statebystate` nothing writes.

A fifth limit, of a different kind from those four: they are about which tokens get compared, this
one is about a break that never becomes a token. The hyphen must be followed by a letter
immediately, so a fragment that soft-wraps its own source at the break (`Compos-` ending a line,
`ite` beginning the next) is read as two whole words and nothing is a candidate. Under-detection
again, and deliberately not widened to allow whitespace after the hyphen: that needs whitespace out
of the lookup key too, and the same widening then fires across an element boundary
(`<td>Total-</td><td>farm</td>` beside a `Totalfarm`, since every tag renders as a space here), and
it reports a `split` string the document does not contain, which is the one thing a corrector is
asked to go and find. Such a fragment also shows the reader `Compos- ite`, hyphen and space — a
defect on its own terms rather than the contradiction this rule is about.

Skipped means skipped in **both** roles: a word carrying more than one hyphen is neither a candidate
nor evidence that some other word was broken. Both halves matter, and the second is the one a reader
would not assume. The tokeniser consumes a whole hyphen chain as one word, so `up-to-date` does not
contribute a bare `date`, and a page writing `up-to-date` beside `dat-e` reports nothing — the
`joined` spelling in every finding is one the page writes on its own. Such a word still counts
toward `words_checked`, since that field is how many words were looked at.

### `page_split_words_unrecovered`

A correction bought for a word written two ways was kept and a word is still written two ways
(`page`, `image`, `words` — the pairs that remain, recomputed on the delivered fragment rather than
intersected with the list going in, so a correction that joined `Compos-ite` and broke
`col-lections` in the same reply reads as a defect **moved** rather than one untouched). Only logged
where the correction was bought for a split word in the first place.

One reading this line does **not** support that its three siblings do. A link still missing, an alt
still generic and an id still duplicated are failures. A word still written two ways may be the
model declining, and on this check a decline is a legitimate answer: Iris knows the page
contradicts itself and cannot know which spelling the printing carries, so the problem it raises
asks rather than instructs, and ends by saying that a page which really prints both spellings
should say so and change nothing. The request licenses that refusal by name rather than leaving it
implied — see the second mark under
[`page_correction_declined`](#page_correction_declined), which is the sentence that makes this
reading a real channel instead of a hope. This line therefore says the contradiction survived the pass and
nothing about whose fault that is. [`page_correction_declined`](#page_correction_declined), keyed by
the same `image`, is where the model's side of it is, and a cited decline lands in `declined.words`
rather than `declined.code_checked` for exactly this reason.

### `text_layer_numbers`

A page from a PDF with a text layer had its numbers checked against that layer (`page`, `image`,
`checked` — distinct numbers in the HTML — `missing`, how many of them the layer lacks, and `numbers`,
the ones sent, at most 10). Each one sent goes to the correction as a problem (trigger `numbers`), so
a time misread as `4:45 pm` where the page prints `9:45 pm` gets fixed even when verification passed
(#585). Thousands separators (and a space after one, `4, 271`), dashes and am/pm case do not count as
differences. Not logged for a scan. `skipped` means nothing was sent: `thin_layer`, the layer has
less than half the HTML's text (a scan with a typed stamp); `mostly_absent`, more than 10 numbers,
and most of them, were missing.

### `text_layer_numbers_unrecovered`

A kept correction bought for a missing number still writes it (`page`, `image`, `numbers`). Like
[`page_split_words_unrecovered`](#page_split_words_unrecovered), this may be the model declining
because the image does print it; a cited decline lands in `declined.numbers`.

### `page_caption_claim`

A figure whose `<figcaption>` makes a claim about the picture its `alt` describes, recorded as the
two free caption checks found it (`image`, `page`, `figure`: its place among the fragment's
figures, and `caption`: the caption's visible text, clipped to 200 characters). Written per
figure, from the page's own fragment, **after** any specialist merge and **before** the verify
call, so it reads the same two strings the verifier is about to be shown. Two of the three axes it
covers are already rules in both prompts — a count the page PRINTS against the length of the
description's list (issue #353), and a region the caption calls highest or lowest against the
bands the description sorts places into (v1.12) — and this line is not a third rule.

Fields: `band`, `caption`, `declined`, `enumerations`, `figure`, `image`, `named`, `page`, `quantifier`, `share`.

Written by `src/pipeline/extraction.ts`.

### `specialist_unresolved`

The page agent named a specialist and no available agent answers to that name: `agent`, `image`,
`reason`, and two lists.

This is the first of the five `specialist_*` lines, which are the five exits from one attempt: a page
agent that judges some content beyond its own reach names the specialist it wants, in its own words, and
the pipeline tries to route the page to it. **Every exit writes a line, including the ones that change
nothing** — because without them, "no routing was attempted" and "routing was attempted and the name
did not resolve" are the same observation: a page that came out of the general pass unchanged. Their
counts reconcile against the requests in one run. `agent` names the request on all five, but not in the
same form: here the raw string the model wrote when it normalized to nothing, the normalized type when
it did not resolve to a file, and on the three lines after a successful load, the agent's **filename**.

`reason` distinguishes the two ways to get here. `empty name` means the request normalized to nothing,
and `agent` is then the raw string, since that is what a maintainer has to recognize. `no agent file of
that name` means it normalized fine and no file matched, exactly or by its key (case, punctuation and
a trailing "agent" or "specialist" ignored, so `chartData` runs `chartDataAgent.md`). `chart`, a
display name or a plural still misses. Both are one defect in practice: the model's wording and the
library's filenames disagree, and the specialist silently does not run. The page agent's prompt lists
the library's specialists by name to prevent it.

The two lists are the explanation, and they are kept apart on purpose. `candidates` is what **was**
dispatchable — real files, so a near-miss reads as a near-miss without a second run to investigate.
`declined_types` is the standard types, and it is the commoner half of the answer: a suggestion of
"tables" is not a standard type, so it never reaches the decline branch and resolves to no file, and
reporting "table" among `candidates` would claim the opposite of what is true. Had the model written
"table", it would have been **declined**, not dispatched.

The page is delivered as the general pass wrote it, and the fidelity verifier is told so — this exit
sets the caution "No agent of that name was available".

### `specialist_declined`

The page agent asked for a specialist of a type the general page pass already covers, so the request was
refused by policy: `agent` (the normalized type), `image`, and `reason: "standard type"`.

**Not a failure.** The decline is keyed on the standard list rather than on what is on disk, so a
deployment that drops a `table.md` into its agents directory does not get the original defect back — a
standard specialist splicing its fragment over content the general pass already rendered, which is the
duplication the page prompt forbids. Matched case-insensitively, so `Table` declines here rather than
falling through to a file lookup that on a case-insensitive volume would find the very file the rule
exists to refuse.

This is the one exit that answers the request rather than merely not granting it, and so the only one
that sends the verifier no caution. Narrowing the verifier's licence here would apply to the commonest
suggestion shape there is — on a table page, it would mean declining to say a cell reads wrongly — and
it would buy nothing measured: of the 7 requests behind #353, 0 named a standard type.

### `specialist_no_content`

A specialist loaded, ran, and returned nothing of its type: `agent` (its filename) and `image`.

Written by `src/pipeline/extraction.ts`.

### `specialist_dispatched`

A specialist ran and produced a fragment: `agent` (its filename), `image`, and `merged`.

**`merged: false` on this line is a failure, not a detail.** A fragment that was written and then not
spliced into the page leaves exactly the page a fragment-less run would have left, so the request is
unmet and the delivered page is the general pass's own unaided work. Only `merged: true` met it.

That is the general shape of this family, and it is why the log carries five lines rather than a
boolean. The pipeline keeps two internal signals across these six exits and they disagree on **four**
of them: `dispatched`, which answers "is this suggestion already covered, or should it be filed as a
new-agent issue", and the caution sent to the verifier, which answers whether the request went unmet.
Three of the four disagreements are silent — no content, a throw, and a fragment that would not merge
all count as dispatched while no specialist content reached the page. The fourth is the other way
round: [`specialist_declined`](#specialist_declined) is not dispatched and sends no caution, because
nothing ran and the request was nonetheless answered.

So a count of `specialist_dispatched` lines is not a count of pages that got specialist content; the
`merged` field is.

### `specialist_dispatch_failed`

The specialist call threw: `agent` (its filename), `image`, and `error`.

Written by `src/pipeline/extraction.ts`.

### `page_recovered`

A feedback re-extraction succeeded on a page an earlier run had lost, so the document is whole
again for those `pages`. Logged late in the run, once that document has been persisted: a round
that re-extracts the page and then throws in review leaves the earlier document — hole and all —
as the one the session holds.

### `extraction_failed`

**No page produced any content**, so the run is ending rather than delivering a document with no
words in it (`pages`: how many failed, `blank`: how many were reported blank). With `blank: 0` the
`run_failed` line that follows carries the first page's provider error, because that is the
diagnosis. Otherwise the source itself was empty — one blank scan uploaded alone, a rasterization
that yielded white pages — and the error says how many of its pages were blank, which an empty
document could not.

Fields: `blank`, `pages`, `reason`.

Written by `src/pipeline/extraction.ts`.

### `page_verify_ok` / `page_verify_failed`

The Feedback Agent's fidelity verdict on one page, checked against its source image. A failure
names its `problems` and buys that page one self-correction pass. A page that passes can still be
re-rendered (a dropped link), so a run's `page` call count is `pages + corrections`, not
`pages + failures`. A failure also carries `kinds`: the distinct kinds of problem the verdict
named, out of `content_missing`, `content_wrong`, `structure_wrong`, `a11y_only` and `alt_quality`
(defined in `agents/feedback.md`, in the order the agent is told to prefer them — content that is
absent is `content_missing` even though it is also a WCAG failure).

It is a **set**, not one label per problem: two missing rows are one page that lost content.
Without it a page that lost three table rows and a page whose alt text was refined from "orange
kayak" to "orange-yellow kayak" wrote the same line, which made `verify_failed` a count of pages
the verifier had an opinion about and nothing more.

`untagged` is how many of that page's `problems` — a count of problems, where the diagnostics
fold's `untagged_pages` counts pages — carried no kind this version recognizes — an agent file
whose VERIFY contract predates the kinds, a session-built or trained one that dropped the field,
or a kind the agent invented. Read it beside `kinds` or a split reads as covering pages it never
saw. A problem is never dropped for being untagged or unrecognizably shaped: a lost label costs a
label, and a lost problem ships the page.

A `page_verify_ok` line carries `unjudged: true` when nothing actually judged the page — no
Feedback Agent loaded, nothing to verify, a reply that would not parse. Verification is
non-blocking, so all three answer "faithful" and the page ships; the field is what separates "the
verifier looked and was satisfied" from "nobody looked", which is otherwise the same line. Omitted
rather than false on a real verdict, and absent from every log written before it existed. The
diagnostics fold counts them as `pages_unjudged`. A fourth case joins those three and is the one
that saves money:

`skipped: "blank"`, a page the agent declared blank, which is not sent to the verifier at all
because an empty fragment has no content to be unfaithful with (issue #294). Not every blank page:
a declaration the reply **stated** in its `blank` field whose own log names something on the page
is judged, and its line carries no `skipped` at all — it is the one blank page a verdict is bought
for, and `blank_contradicted` on its [`page_blank`](#page_blank) line is why (issue #371). It
carries `unjudged: true` too — both are pages nothing looked at and neither may enter a pass rate
— and the extra field is what separates a call that could not be made from one that was not
bought, which is the difference between a broken run and a saving.

Counted as `pages_skipped_blank`, a subset of `pages_unjudged`. The free checks still run on that
page, so a blank page carrying link annotations still fails the link comparison and still buys a
correction. A fifth case is `skipped: "error"`, the second value that same distinction always
described and nothing had ever emitted: the call that could **not be made**, as against the one
that was not bought (issue #364, and `page_verify_error` below for what went wrong). It is
`unjudged` too and stays out of every pass rate for the same reason, but it is the opposite of a
saving — that page was billed for a full ceiling of output and got no verdict for it — so
`pages_skipped_blank` and `pages_verify_error` are counted separately and must not be added.

### `page_verify_error`

A page's fidelity check could not be obtained: the call was made and the provider errored, was
throttled, stalled, or the reply overran its output ceiling. Carries `image`, `page`, the `step`
that failed (`verify`, the check that decides whether a correction is bought, or
`recheck_binding`, the gate on keeping one), the `error` message, and for a truncation the same
evidence `page_correction_failed` carries — `truncated`, `reply_chars`, and both ends of the
reply, which is what separates a verifier that needed the room from one that wrote an essay about
a page it had already judged.

**A verdict that cannot be obtained is not a page that cannot be extracted**, and until issue #364
this pipeline could not say so on the first check:

`verifyAgentOutput` is non-blocking for an absent Feedback Agent and for an unparseable reply, but
a provider error is rethrown, and that first call had nothing to catch it — so a throttled or
over-long *check* propagated out of the page's extraction and shipped a `@page-failed` marker for
a page that had rendered fine. Measured once on a 100-page bench arm: a page extracted as 8,855
characters of HTML, a complete statistical table of 568 words, was delivered as a 156-byte
comment, and $0.5051 of that page's $0.6634 was the call that deleted it.

Three things it cost besides the page, which is why this is its own event rather than a silent
`catch`: the delivered document asserted "the source pages above could not be extracted", which
was false; `pages_failed` and every triage of *why* pages fail recorded a vision failure, so
anyone tuning the page agent on that signal was tuning the wrong agent; and the marker advised
raising `providers.*.max_tokens`, which buys the verifier room to write more about a page it has
already judged — the wrong lever, pushed the wrong way.

The policy it is fixed to is this pipeline's own: a specialist that fails leaves the page as the
general pass wrote it, and a fidelity check that cannot run is nothing to correct, so no
correction is bought and the page ships as extracted. That matches an unconfigured deployment on
any page whose only route to a repair was the verdict, and **not** on a page the link comparison
would have repaired: with no Feedback Agent loaded every call site returns a passing unjudged
verdict, so a links- or alt-triggered correction reaches the binding recheck and is **kept**,
while under a provider failure that recheck throws too and the correction is discarded.

A page with a dropped `href` therefore ships without it here and with it there — the discard
decision below, stated rather than folded into a claim of equivalence. On `recheck_binding` the
line also carries `trigger` and `correction_discarded: true`: that recheck exists to stop a
correction bought for one link or one placeholder alt from damaging a page that had already
**passed**, so where its verdict cannot be obtained the correction is not kept — no verdict is no
licence, and the status quo is a page that passed.

The correction is billed either way, and that field is what puts the discard on the record rather
than leaving it inferred from an absent rejection line. The third verify call, the sampled
recheck, keeps its own older `page_correction_recheck_failed` and is not folded in here: it
decides nothing whether it answers or not, and it has been read across rounds under that name.

### `page_verify_inconsistent`

The verifier **described** a defect and then passed the page (`page`, `image`, `problems`,
`kinds`, `untagged`). A verdict's pass/fail is its `faithful` / `accessible` flags, and a
correction is bought only when a flag is false **and** a problem is named, so a verdict that names
one with both flags true ships the page — and its sentence was not previously anywhere in the log,
since `page_verify_ok` carries no `problems`. Calibrating the verifier against injected defects
found 3 of 30 damaged pages described in full and passed: a swapped pair of paragraphs quoted back
verbatim, an `<h4>` among `<h2>` siblings named as such, `faithful: true` on both.

That is most of the gap between what it perceived (28 of 30) and what it flagged (25), and it is a
different failure from a verifier that cannot see (issue #210). Written on the FIRST verdict only,
the one that decides whether a correction is bought; a recheck's own disagreement is already
readable on its line, which carries both `ok` and `problems`. It decides nothing and costs nothing
— the page ships exactly as it did — because the fix worth having is kind-gated (a
`content_missing`, `content_wrong` or `structure_wrong` problem failing the page whatever the
flags say) and pricing that needs this counted over a fleet; failing on any named problem would
instead buy a correction round for every `alt_quality` suggestion the same agent is asked to
volunteer.

The diagnostics fold counts them as `verification.verify_inconsistent`.

### `page_corrected`

One self-correction pass on a page.

- `trigger`: what asked for it. `verify` is the checking model; `links`, `alt`, `ids` and `words` are
  code checks; `both` means more than one source (which ones: that page's `page_links_missing`,
  `page_generic_alt`, `page_duplicate_ids` and `page_split_words` lines, keyed by the same `image`).
- `problems`: how many it was given. `kinds`: what the verdict said was wrong, the same set as
  `page_verify_failed`'s; empty on the code triggers, where no verdict named anything.
- `result`:
  - `kept`: it changed the delivered document.
  - `rejected`: thrown away for the page it was meant to improve. Three causes, two with their own
    line: a reply a fraction of the page's size ([`page_correction_rejected`](#page_correction_rejected));
    a second verdict naming something the rewrite lost (`page_links_correction_rejected`); and, with
    neither, a binding recheck that could not be obtained (`page_verify_error` with
    `correction_discarded: true`, counted as `rechecks.binding_error`).
  - `identical`: it changed nothing, judged on the effect, not the string, so a re-indented page or
    `&amp;` for `&` counts here. The fragment is still adopted. With `chars_before` / `chars_after` and
    four `false` flags, the model re-typed the page; with no sizes and no flags, it returned the exact
    string.
  - `empty`: nothing usable came back.
  - `failed`: the call threw ([`page_correction_failed`](#page_correction_failed)).
  `identical`, `empty` and `failed` were paid for and bought nothing; `failed` costs most, since a
  truncation pays a full output ceiling.
- What changed, observed on the two fragments: `text_changed`, `alt_changed`, `attrs_changed`,
  `structure_changed`, `chars_before` / `chars_after`, and `text_chars_before` / `text_chars_after`
  (prose only, which tells added markup apart from restored content).
- Image descriptions and markers. Each names its members, is capped at six names, and is absent when
  nothing happened. None decides what ships or which reply is right.
  - `alt_relocated`: named members a correction moved from one list in a description to another
    (always also `alt_changed`).
  - `alt_added`: a name that arrived: listed in the corrected description, in a list that already
    held at least two of the earlier description's members, and named nowhere in the earlier
    description's words. Disjoint from `alt_relocated` by construction, so the two can be added.
  - `markers_added`: which of `[not legible]` and `[page not fully transcribed]` the corrected page has
    more of.

Before counting a corpus off the three:

- Two lists in two sentences with no semicolon between them read as one list.
- A member only dropped is on neither line; the text sizes say a description lost prose.
- A correction that changes how many images a fragment has is skipped: descriptions pair by position.
- A name containing "and" or "or" reads as one member where its list uses commas, except as the first
  half of the list's last item, where it is missed. With no commas at all, the conjunction splits it.
- An entry is a token that changed list, not always a place: "pale and light and medium and dark"
  yields band words.
- A description that lost any member it no longer names anywhere reports no arrivals ("N.D." becoming
  "North Dakota" reads as a loss and a gain), and so does one that listed a member twice. A member
  moved between bands is not lost.
- A wholly new list of new names is an invented category, reported by `structure_changed` and the
  sizes, not here.
- `markers_added` counts the whole fragment, attributes included. Inside an `alt`: `alt_changed` true,
  `text_changed` false, equal text sizes. Inside another attribute: only `attrs_changed`. So do not
  expect `text_changed` beside every `markers_added`.

Why they match the way they do: [design notes — what a correction's alt fields can and cannot
see](design-notes.md#what-a-corrections-alt-fields-can-and-cannot-see).

### `page_correction_rejected`

A correction came back under a quarter of the size of the page it was given, so it was refused and
the page it was meant to correct ships (`page`, `image`, `trigger`, `reason: "shrank"`, `chars_before`,
`chars_after`). Paired with `page_corrected` `result: "rejected"`. Applies on every trigger, and is
decided before any re-verification, so no checking call is spent on it.

### `page_correction_failed`

A self-correction's model call threw, so the page keeps the version it had: **it costs the
correction, not the page**. Paired with `page_corrected` `result: "failed"`. Nothing is retried: a
correction that truncates because the page is large would truncate again.

- `trigger`, `problems`, `kinds`: as on `page_corrected`; `kinds` is empty on the code triggers.
- `error`, and `truncated: true` when the model hit its output ceiling.
- `ceiling`: the output ceiling this call asked for, on every failure (read `truncated` for whether it
  is what the call died of). Usually the call's own cap, not the deployment's: twice what the page's
  first pass spent, scaled up when a specialist lengthened it, with a 4,000-token floor
  (`correctionCeiling` in `src/pipeline/extraction.ts`). **So the remedy for a truncated correction is
  that multiple, not `providers.*.max_tokens`.**
  - Larger than `providers.<provider>.max_tokens`: the adapter sent the smaller of the two, and the
    truncation is the deployment's, as its message says.
  - Absent: the call ran uncapped, and the configuration is the remedy. Either the first pass reported
    no token usage, or the page was delivered blank ([`page_blank`](#page_blank)) and this is a re-render
    from its image (reachable only on the `links` trigger).
- `ceiling_bound`: which term produced `ceiling`, `multiple` or `floor`. Read the term here, not off the
  number: a doubling that lands on 4,000 is still `multiple`. Absent wherever `ceiling` is.
- `chars_kept`: the size of the fragment that ships.
- On a truncation, `reply_chars`: how far the reply got (read it against `chars_kept`); `0` for a
  reply of no characters at all.
- On a truncation that returned something:
  - `reply_head` / `reply_tail`: its first and last 240 characters, whitespace folded. A reply shorter
    than both is quoted whole in `reply_head`. Deployment-only, never on `/v1/quality`. A tail
    mid-sentence in content the head has not reached is a page that needed the room; a tail repeating
    rows from the head is a model looping.
  - `shape`: `truncated_envelope` (the asked-for reply, cut), `bare_html` (a reply that is the page's
    markup; says where the reply began, not where it went), `prose` (never began the page: raising the
    cap buys more of the same), `envelope` (the ceiling landed after the closing brace), or `empty`
    (whitespace only).
- A bare `truncated: true`, with no excerpt, is two shapes: a reply of zero characters
  (`reply_chars: 0`), or a truncation that lost its class crossing a boundary (no `reply_chars` at
  all). Read `reply_chars`, not the missing `reply_head`, to tell them apart.

The fidelity problems the correction was for are still unfixed and on record.

Why the multiple and the floor, and why no retry: [design notes — the output ceiling a correction
asks for](design-notes.md#the-output-ceiling-a-correction-asks-for).

### `page_correction_no_output`

A self-correction's reply had no readable HTML (`page`, `image`, `chars`, `shape`, with
`page_no_output`'s shapes), so the page keeps the version it had. Paired with `page_corrected`
`result: "empty"`. `declined` is a count, absent at 0, of problems the reply refused while sending no
page: refusing and failing have different remedies. The reasons are on `page_correction_declined`,
keyed by the same `image`.

### `page_correction_declined`

The corrector refused one or more problems, saying why (`page`, `image`, `trigger`, `problems`, the
whole list it was offered, and `declined`: one entry per refusal with `problem`, `source` and `why`).
It may refuse only a claim about the HTML it was shown that the HTML itself refutes (an id "used
twice" that is used once), never a claim about the image. **It gates nothing**: no verdict, result,
recheck or `uncorrected` set is decided here, so a wrong refusal leaves the page where a failed
correction leaves it, marked `@page-uncorrected`.

- `problem`: the number the reply cited, against the numbered list it was sent. Absent when the reply
  cited none.
- `source`: which check raised that problem (`verify`, `links`, `alt`, `ids`, `words`), `null` when no
  number was cited or it falls outside the list. A refusal over `verify` disagrees with the checking
  model and may be right; over `links`, `alt` or `ids` it refuses a fact checked in code, which the
  request marks and excludes by name. `words` is not counted as code-checked: Iris checked that both
  spellings are on the page, not which is right, and the request invites a refusal there. It has its
  own `declined.words` count in [Diagnostics](#diagnostics-timing--hang-detection).
- `problems` is the denominator: 2 of 2 refused is a correction refused outright, 2 of 9 is the pass
  working.

Absent when nothing was refused, which is usual. Diagnostics counts these as `verification.declined`.
Why refusals are allowed, and why split words are marked differently: [design notes — why a correction
may refuse a problem](design-notes.md#why-a-correction-may-refuse-a-problem).

### `page_correction_recheck`

A second verdict on a corrected page: `ok` and its `problems`.

- `problems_before` / `problems_after`: fidelity problems the page was sent with, and how many this
  verdict names. `kinds_before` / `kinds_after`: their kinds, both lists in full (not a diff).
- `links_before`, `alt_before`, `ids_before`, `words_before`, `numbers_before`: the code-found defects
  it was also given, kept out of `problems_before` so one fidelity problem and two code defects do not
  read as three in. `problems_after` can name a split word that `words_before` also counts. Whether a
  code-found defect came back is answered exactly by the matching `_unrecovered` line, not by the
  difference of these numbers.
- `binding: true`: the links path re-verifying a rewrite it may discard. The page had passed, so
  `problems_before` is 0, and any problem here is a rewrite that lost something.
- `binding: false`: a measurement-only sample of `defaults.recheck_sample_size` pages (default 1, `0`
  for none), changing nothing that ships. Corrections are single-shot, so `ok: false` is expected; the
  counts say how far it got. At the default this is a count, not a rate.
- `unjudged: true`: nothing judged it (no checking agent loaded), so its `ok` means nothing.

Diagnostics counts the two kinds apart as `verification.rechecks.binding` and `.sampled`, with
`binding_unjudged` and `sampled_unjudged` for the `unjudged` ones among them. An `ok: false` line's
problems go to `rechecks.failures`, not `diagnostics.errors`.
`extraction_start` / `reextract_start` carry `recheck_sample_size` and `recheck_thresholds`, so a log
with no recheck lines says whether the sample was off, nothing was corrected, or every correction fell
below the first threshold.

What a census of the sample showed: [design notes — the recheck, and what a sample of one can
say](design-notes.md#the-recheck-and-what-a-sample-of-one-can-say).

### `page_correction_recheck_failed`

The measurement-only sample could not be taken — the extra Feedback Agent call hit a provider
error (`error`). Logged rather than raised: the page ships as it would have with no measurement at
all, and the slot this page claimed stays spent, so a throttled provider is not retried once per
corrected page — and at a census that is one failed call per correction, not one per run. A
`binding` recheck has no such line, because there the verdict decides whether the rewrite is kept.

### `table_continuations`

The assembled document holds a table whose caption says it continues the one before it: `tables`
(how many tables the document has), `pairs` (how many of them are second halves that were located
in the source bytes) and `declined` (how many said so and could not be paired). Logged once per
run, before any join is attempted, so the ratio is readable on a run whose joins then all failed.
A table printed across a page break arrives as two tables with duplicate headers and no connection
between them, and no page agent can fix it: each printed page is its own call, so the agent that
wrote the second half had one image and the other half was not on it (issue #239).

It knew — all 18 continuation captions in the reference corpus say "Continued" — and emitted a
fresh `<table>` because there was nothing to append to.

`declined` is a fact about the bytes rather than about the model: the pair is found in the DOM and
its two source spans are not, which happens when a page delivered an unclosed `<table>` (an
unclosed opener swallows the table after it, so the bytes delimit nothing to splice). Those halves
ship as they arrived.

### `table_joined`

Two halves were merged into one table: `by` (`"code"` or `"editor"`, which path produced the
merge), the merged `caption`, `rows_first` / `rows_second` / `rows_joined`, `chars_before` /
`chars_after` for the two halves against the one table, and — on the editor path only — that
editor's own `editor_log`. On `by: "code"` only, the two halves' own bytes as well
(`halves` / `chars_first` / `chars_second` / `html_first` / `html_second`, exactly as
[`table_join_code_declined`](#table_join_code_declined) carries them and documented there): a
candidate loosening of the free path has to be scored on the pairs it must not break as well as on the
pairs it would newly take, and these are the first population. The presence rule is `by`, which is on
every line, so the population is countable. A paid join does not repeat them because the decline that
bought it is the same pair's bytes, on the line immediately before — and since a pair's identity in
this loop **is** those two strings, the two lines can be matched on the bytes rather than on their
order.

A table printed across three or more pages is joined one pair per pass, so the second pass's first half
**is** the first pass's merged table: `chars_first` on the later line equals `chars_after` on the earlier
one, and the first two pieces' rows are on both. That is what the later pass judged, so a replay of that
line needs it. It also means the retention figures below are a corpus's cost and not a ceiling — the
ceiling is per line, and per document it is the 12 pairs the loop can reach.

**The merge is not a plain concatenation**, because the halves do not always agree on what to
concatenate: a continued page can declare a different column count, the repeated header block can
carry footnote-reference ids an endnote links back to, and the bracketed unit note a continued page
reprints belongs in the joined table exactly once. Where one of those judgements is real the merge is
a Copy Editor call (`copy_editor_table_join.md` in the agent ledger); where it is not, it is made in
code and costs nothing.

**Read `by` rather than the agent ledger to tell the two apart.** A pair joined in code never reaches
the ledger, so a run's `table_joined` count and its `copy_editor_table_join.md` call count are
different numbers on purpose.

**`rows_joined` below `rows_first + rows_second` is not a defect.** The merge drops the duplicated
header block the continued page reprinted, and it may drop one bracketed note row — or, where the
joined caption absorbed note rows, exactly the rows it absorbed. Both paths go through the same
verification, which is what makes this line trustworthy: one table, a caption without the
continuation marker, no column lost, a header block still made of `<th>` cells, every distinct row
label from either half still present as a cell somewhere, and the rows accounted for. What each of
those checks is for, and how much slack the row floor allows, is in
[design notes](design-notes.md#what-is-deterministic-and-what-the-answer-is-checked-against).

### `table_join_code_declined`

The merge was tried in code on this pair and stood down, so a Copy Editor call was bought for it: the
second half's `caption` and the `reason`. Logged on **every** pair the code path did not take, because
the share it takes is what a later round has to be able to re-measure and
[`table_joined`](#table_joined) alone cannot tell a free join from a paid one.

**A decline costs nothing.** The pair goes to the editor exactly as it did before this path existed.

| `reason` | What stood the code path down |
| --- | --- |
| `header_differs` | The second half's header block is not the first half's, so which one describes the joined rows is a reading of the table |
| `columns_differ` | A row of the continued page is wider than the first half already is. Reached where the continued page reprinted no header at all — the case the header comparison cannot see |
| `id_would_be_lost` | An id on the half being dropped has no free counterpart to move onto: a footnote-reference anchor in the repeated header block, or an id on both halves' own `<caption>` or `<table>` element, where keeping one live target means choosing which |
| `id_would_collide` | The join would print one id twice, a defect it would have introduced |
| `note_repeat_unclear` | The continued page opens with a bracketed unit note the first half does not carry, so it is not the reprint rule 6 licenses dropping. "Carry" reads the first half's note rows **and** its caption, since the two halves need not agree on where they print it. The reverse is not a repeat: a note only the continued half carries is a first appearance |
| `note_repeats_exceed_licence` | The join would drop more bracketed note rows as repeats than the row floor forgives, and joining anyway would come back `rows_lost` |
| `caption_unclear` | The continuation marker is not wholly inside one text node, so taking it off means rewriting markup |
| `no_caption_available` | Neither half has a caption, which the verification requires |
| `content_outside_table` | A half's span parses to something beside its own table — the parser fosters a stray `<p>` out of a `<table>` and the joined table's `outerHTML` would not carry it. The one way this path can lose content where a model reply cannot |
| `tfoot_no_tbody` | The first half has no `<tbody>` to append to and has a `<tfoot>`, so the rows would land after the table's own summary |
| `unreadable` | A half holding no `<table>` |
| `read_failed` | A parse **threw** — on a half, or on the merged candidate |
| `verify:<reason>` | A code merge the same verification as [`table_join_failed`](#table_join_failed) refused. A refusal and a throw are different lines: only the throw is `read_failed` |

Every decline carries both halves' header blocks, because a header comparison is evidence about a
`columns_differ` decline too:

| Field | What it holds |
| --- | --- |
| `headers_identical` | String equality on the two **full** signatures, computed at the line rather than left to a reader of the capped `header_first` / `header_second` strings |
| `header_rows_first` / `header_cells_first` / `header_rows_second` / `header_cells_second` | The size of each half's whole header block. `cells` counts every child of a header row, `<td>` included, because the signature does and because a header block returning as `<td>` is its own defect (`header_cells_lost`) |
| `header_first` / `header_second` | The signatures as rule 3 compares them: per header cell, tag name, `colspan` and normalized text, cells joined with `\|` and rows with ` // `. Capped at 1,200 characters with a trailing `…` when cut |

Four things to know before counting these:

- **`cells` is the field that says whether a half declared a header block at all.** A header row
  holding no cells reports `rows: 1, cells: 0` with an empty signature, which a rows-only reading
  takes for a real header.
- **`headers_identical: false` with a zero cell count beside it is a page that reprinted no header,
  not two readings disagreeing.** Rule 3 skips the comparison entirely for such a pair. Count with the
  cell counts, not without them.
- **A signature is not re-splittable into a cell count.** A cell's own text can contain `|`; that is
  what the four counts are for.
- **All seven are absent in two cases and `reason` does not separate them** — do not read absence as
  one reason, or one reason as absence. They are absent for `unreadable`, a half with no `<table>` to
  read them from, and for the `read_failed` that is the **join itself** throwing on a half no parser
  can read. The **other** `read_failed` is the verification throwing while it parses the merged
  candidate, and there all seven are present. A half with a `<table>` but no header block is present
  too, with an empty signature and `0` for both counts.

The halves' own bytes are on the line as well, which is what makes a decline re-scorable:

| Field | What it holds |
| --- | --- |
| `html_first` / `html_second` | The two halves exactly as the source delivered them |
| `halves` | `"logged"` when the bytes are on the line, `"too_large"` when they are not. Always present |
| `chars_first` / `chars_second` | Always present, so what an over-large pair dropped is measurable |

Read the bytes back with `pairFromHalves` (exported from `src/pipeline/tables.ts`) rather than with a
fresh parse, because that rebuilds the pair the round was holding and the free path then returns the
verdict it returned in the round. A rebuilt half's `start` / `end` are offsets into itself, so a merge
produced from a replay must not be spliced into anything.

`halves` is present even when the bytes are, because presence alone cannot be counted: a re-score has
to be able to say *N of M declines replayable* straight off the log, and the bound is a constant in
the code that a reader of an old log has no way to know. A line written before this field is neither
value, and reads as not replayable, which is what it is. The bound is 64,000 characters for the pair
and it **refuses rather than truncates**, unlike the capped header signatures — half a table's bytes
parse to a different table.

**The run log carries page content, not only metadata about it.** These fields hold table markup from
the submitted document verbatim. `GET /v1/sessions/{id}/logs` and the diagnostics route are both
owner-scoped, so the only reader is whoever submitted the document, and `/v1/quality` publishes
aggregates with no log text in them. Worth knowing before a run log is attached to a bug report or
exported somewhere the document itself would not go.

**How often this line fires is not a property of the code.** The free path has taken 24–53% of pairs
across rounds of the same rules on the same corpus — so this line fired on the other 47–76% — with
nothing in the repo changing, because the disagreement is usually between two extractions of one
printed header. Per-run totals are folded into `tables` in
[Diagnostics](#diagnostics-timing--hang-detection) as `code_declined` and
`code_declined_with_halves`. What the variability means for anyone re-measuring the free share, and
why the guards are not loosened, is in
[design notes — joining a table split across a page turn](design-notes.md#joining-a-table-split-across-a-page-turn).

### `table_join_failed`

One pair was left as two tables. **The document keeps both halves byte for byte**, so every failure
here delivers the output the pipeline had before this stage existed — unlike a correction round, a
refusal costs one table's structure and not the document. A pair that failed is not asked again in the
same run, since the next pass would send the same two tables to the same prompt, so one unjoinable
pair does not starve the joinable pair after it.

`reason` is one of two groups. The pair never reached a verified answer:

| `reason` | What happened |
| --- | --- |
| `unmatched_source` / `not_adjacent` | The source bytes cannot delimit the pair (see [`table_continuations`](#table_continuations)). Reported with a caption and nothing else — there are no halves to replay |
| `declined` | The editor judged the halves not to be one table |
| `no_output` | A reply with no HTML in it |
| `truncated` / `call_failed` | A request that did not come back |
| `read_failed` | Markup no parser could read, with `stage: "body"` when it was the document rather than the reply. jsdom parses by recursion and overflows on a body nested a few hundred thousand levels deep, which is reachable because `anchors.ts` delivers a page past 500 levels as written. The document then ships exactly as it arrived rather than failing the phase, the way the lint one step later reports its own overflow as `@lint-unavailable` |

Or the answer came back and the verification refused it. These are checked in this order, and the
order is only which reason a failed pair reports:

| `reason` | What the merge did to the table |
| --- | --- |
| `not_one_table` | The answer is not a single table |
| `no_caption` | The joined table has no caption |
| `still_continued` | The continuation marker is still in the caption |
| `columns_lost` | A column went |
| `header_cells_lost` | The merged header block came back as `<td>`, which axe does not report and which removes the header association from the one table this stage exists to improve. Counted over the cells that describe columns, so a bracketed note row printed inside the block is not one of them |
| `rows_lost` | Rows went, counted against both halves' rows less the collapsed header block and less an allowance that is the **larger** of one row and the note rows the joined **caption** absorbed, never their sum — a note promoted into the caption is content kept |
| `labels_lost:<n>` | `n` row labels went. A bracketed unit note the merge moved from a row into the caption counts as kept, because the label check reads `th,td` and would otherwise refuse the very drop rule 6 licenses |
| `caption_note_lost` | A bracketed note **either** half's caption carried is in neither the joined caption nor a row some half printed |
| `caption_note_struck` | The note is still in the table, as a row a half printed where it printed it, and missing only from the caption rule 4 says to **copy** |
| `note_shipped_twice` | The joined table holds one note in its caption **and** as a row |
| `note_row_lost` | A note **neither** caption carried, printed by a half as a row, gone from the delivered table and not in the caption either |

The four note reasons are last on purpose: a merge that dropped the note *and* lost rows should say
`rows_lost`, because the note is the cheapest of these losses and would otherwise mask the dearest.
Among the four the order is lost, then struck, then doubled, then `note_row_lost`, so that each reason
names what happened to the note rather than the first condition that happens to hold.

Three limits to know before triaging a run off the note reasons:

- **A note the merge kept in any form these cannot see reads as a note lost.** They match a run's
  exact characters and look only in a caption or a note row, so a rewritten delimiter, a reworded note
  or a note moved elsewhere in the table all refuse. Every such refusal is safe — the pair declines and
  both halves ship — and every one costs a join that lost nothing.
- **Both bracket widths are read, ASCII and fullwidth. The parenthesised spelling is not**, because a
  check demanding every parenthesised run survive would demand the survival of `(continued`, which
  rule 4 requires dropped. So a parenthesised note, and a note printed with no delimiter at all, can
  go missing without this seeing it.
- **It is a shape test and not a reading**, so every bracketed run in either caption is owed, not only
  a note of measure. A caption carrying `[Sheet 2 of 3]` is owed too, and two captions carrying
  different runs — `[In millions of dollars]` against `[In thousands]` — can be satisfied by no joined
  caption that does not invent, so that pair declines for good and reports the loss rather than the
  units disagreement that actually happened.

Why the note rules are shaped this way, what each of them cost before it existed, and what the row
floor forgives is in
[design notes — the bracketed unit note](design-notes.md#the-bracketed-unit-note).

### `table_joins_capped`

The document had more continuation pairs than one run will spend requests on (`joined`, `pending`,
`max`), and the `pending` ones ship split. Present only when pairs remain. The cap is not a bound
anything measured comes near — the worst 25-page chunk of the reference corpus has 7 pairs — and
since #276 a pass need not cost anything at all, because a pair the code path takes buys no
request. It bounds **passes**, not spend: a body that keeps producing pairs needs something to
stop on. Pairs are re-read from the body each pass, which is how a table in three pieces closes:
joining the first two leaves a document whose remaining half now follows a joined table.

### `prose_joined`

A sentence the source printed across a page turn was delivered whole (issue #248). `markers`
page-break markers stood between the pages, `candidates` of those turns had the next page opening
with a `<p>` that begins with a lowercase letter, `joined` were mended, `unmarked` of the joins
had no marker between the halves at all (a page printing no number emits none), and `word_splits`
were breaks that fell inside a word. Then one count per refusal:

`declined_interrupted` (something other than a paragraph stands between the halves — a footnote
list, in all 9 of the reference corpus's cases — so the marker is not what interrupts the
sentence; a page that FAILED extraction lands here too, because its fragment is the `@page-failed`
comment and that comment is exactly such a node), `declined_not_continuing` (the paragraph before
ended a sentence, so the lowercase start after it is something else), `declined_page_gap` (a page
between the two returned nothing at all, so the middle of the sentence may be what is missing —
the page that came back empty with no marker, #194, which is dropped from the body and then
visible only as a hole in the numbering), `declined_no_cut` (the continuing sentence begins inside
an inline element that opened earlier, so no cut leaves both halves balanced markup),
`declined_attrs_kept` (the whole paragraph would have moved and it carries an attribute the move
cannot take with it — `id` above all, which something may refer to), `declined_lang_mismatch` (the
two paragraphs disagree about `lang` or `dir`, so the words would arrive in a language nothing
said they were in), `declined_as_written` (one of the pages is being shipped byte for byte,
`skipped_pages`) and `declined_too_far` (more than 500 characters of text would cross the marker —
a paragraph with no sentence boundary in it moves entire, so without the bound a page of
unpunctuated prose would deliver its whole text after the *next* page's anchor, which is not the
few words the direction below was chosen for).

Plus `word_split_examples`, up to five words the break split, cut at 40 characters — text out of
the user's own document, so it stays on the deployment and never reaches `GET /v1/quality`. Absent
unless at least one turn was a candidate, so a document whose pages happen never to break a
sentence adds no line, and `markers` high beside `candidates: 0` is what a caseless script looks
like here: the lowercase test is the measured one and has no signal in Hangul, Chinese, Japanese,
Arabic or Hebrew, so those sentences ship split.

**The words move forward, past the marker**, which is a decision about what a page anchor means
and not a detail: the sentence is then whole with `#page-74` standing immediately before it, so a
reader following that anchor hears a few words of page 73 first — where pulling the next page's
head back instead would land `#page-74` after the sentence it should open on and cost that reader
the start of it. A word the printer broke **keeps its hyphen** and is closed up ("Simi-" + "larly"
ships as "Simi-larly"), because nothing at this seam can tell a line-fill hyphen from a real one
and dropping it would be the one place this pass deleted a character the source printed;
`word_splits` is what makes that answerable with data.

Deterministic, so no model call is spent on it — unlike the table join, which needs one wherever
the two halves' headers disagree about what the table is.

### `editor_images`

How many source images the Copy Editor received this round (`attached` of `of`, plus `pages`). A
`dropped` count means the selection did not fit in one request and was trimmed to the pages issues
actually named. `attached == of` on a multi-page document means at least one issue in that round
carried no page attribution, so the round asked for everything.

### `editor_images_refused`

The provider refused the round's payload as too large, so the same prompt was re-sent **without**
images. The correction still had the whole body and every issue; only a fidelity problem that must
be checked against the source can go unfixed.

### `editor_fidelity_observed`

The Copy Editor, looking at a page image it was sent for some other reason, says the HTML and the
page disagree about something **nobody asked it about**:

`count` observations, the `attached` pages it actually had, and the `observations` themselves —
each a `page`, a sentence, and one of `page_verify_failed`'s five `kind`s (the same taxonomy, so
this can be read against `verify_kinds`; `null` where the reply named a kind this version does not
recognize, and the sentence is kept either way). Reported and **not acted on**: acting would mean
re-reading that page in full, which is a re-extraction and not this loop's job, and an edit made
from one glance at an image reaches a reader as what the page says.

So nothing about the delivered document changes because of this line — it is the only trace, and
it is addressed to a person. Its value is that it is the **only** second opinion on fidelity in
the run: VERIFY checks each page once, with the same model family on the same image as the
transcriber, so its blind spots are the transcriber's by construction, and the Reader cannot see
the source images at all (issue #183).

`unattached` counts observations about a page whose image was **not** in `attached` — the prompt
asks for attached pages only, so those are guesses about a page the model could not see, kept but
counted apart so a mostly-guesswork set can be discounted whole.

`unplaced` counts observations that named no page. Absent on the ordinary round, where the editor
noticed nothing.

### `editor_links_dropped`

An `href` present before that round's correction was missing after it (`iteration`, `hrefs`, and
`added`, up to 20 absolute `href`s the round introduced, not counting repairs logged as
`editor_links_completed`, so a lost link can be told from a changed one). A
link's target came from the source **file**, not from a page image, so a dropped one cannot be
recovered by looking again — logged rather than repaired, and counted into `links_dropped_rate`.

### `editor_links_completed`

The Copy Editor replaced an `href` with a longer URL that starts with it and is the text its own
link printed (`iteration`, and `links`, each `{from, to}`). The longer URL must be new in that round. This happens when a PDF's link target is cut where the
printed URL wraps onto a second line. It is a repair, so it is not in `editor_links_dropped` or
`links_dropped_rate`.

Written by `src/pipeline/review.ts`.

### `internal_links`

The delivered document contains an in-document reference that lands nowhere (`refs` fragment links
in all, of which `empty` are `href="#"` and `dangling` name an `id` the document does not have,
plus `ids` — up to 20 of the fragments that failed). Those three are counted per **reference**, so
`refs` is the denominator of the other two and one missing section linked forty times is forty
references a reader can activate to no effect; `ids` alone is the **distinct** set, because the
cap is 20 and one dead target must not spend it.

Measured on the bytes actually written, after every rename and every correction round, because
that is the only place the question "does this reference land" has a final answer; `@`-comment
markers are stripped first, since those quote model prose and an `<a>` inside one is not a link.
Absent on a document where every reference resolves. The two shapes are apart because the remedies
are:

`empty` is a link the page agent wrote knowing it had no target — nothing to rename — while a
`dangling` one had a target that moved, was never transcribed, or is in a part of the document
this run did not hold. The ids are here and not in `links_unresolved_rate` on purpose: a fragment
is text chosen out of the document, so it stays on the deployment while the public tally gets
counts only.

### `delivered_markup`

The delivered document's own structure disagrees with itself (#240): `unbalanced` lists
`element open/close` for every element whose end tag HTML **requires** and whose start and end tag
counts differ (e.g. `table 16/15`), `tables` and `tables_without_body` count the parsed tables and
those holding no row a reader receives as content (no rows at all, none outside a declared
`<thead>`, or — with no header block declared — none that is anything but column headers; a body
of `<th scope="row">` cells is content), and `empty_table_captions` names up to 10 of those
tables.

Absent when both are clean. The two halves are one question asked either side of the parser, which
is why they share a line: an HTML parser repairs malformed markup before axe is handed the
document, so the **bytes** are the only place an unclosed `<table>` is still visible, while a
table with no rows is what survives that repair and reaches a reader. `@`-comment markers are
stripped before counting, since those quote model prose — with them in, one bench document read
`table 25/19` with nothing actually wrong; an unterminated `<!--` is treated as running to the end
of the document, which is what a parser does with one.

Elements with optional end tags (`li`, `tr`, `td`, `p`, `tbody`, …) are excluded:
`<ul><li>a<li>b</ul>` is correct HTML and counting it would bury the real finding. A `parse_error`
key means the table half could not be measured at all, so its zeros are not a clean bill of health
(#164).

### `delivered_structure`

Four structural defects in the delivered document that **no rule in the gate reports** (#255),
each decidable from the HTML alone:

`dangling_idrefs` (an `aria-labelledby`, `aria-describedby` or `<label for>` naming an id that
exists nowhere in the joined document), `dl_without_dd` (a `<dl>` holding terms and no
definitions), `lang_on_void` (`lang` on an `<img>`, `<hr>`, `<br>`, `<input>` … — an element with
no text at all for it to apply to, holding neither a text node nor text in an attribute: HTML
scopes `lang` to an element's contents **and** to its text-bearing attributes, so
`<img alt="Un graphique" lang="fr">` is correct authoring and is not counted, while the same image
with `alt=""` is) and `empty_landmarks` (a `<nav>`, `<aside>`, or NAMED `<section>` with no text
and no image, table or form field in it).

All four counts appear whenever any of them fired, zeros included — on a line that exists, a zero
says that class was looked for in this document and is not in it — plus `dangling_idref_examples`,
`dl_without_dd_examples`, `lang_on_void_examples` and `empty_landmark_elements`, up to five
instances each, written as `element[attribute=value]` and cut at 40 characters. Absent entirely
when all four are clean, which is the ordinary document. Measurement only: nothing is repaired and
no run is failed, for the same reason as `delivered_markup` — these are a class worth seeing, not
a rate anyone can calibrate yet.

Three of the four do reach the deployment-wide tally as `iris:structural-defect`, one row per
document however many instances it had, surfaced as `structural_defect_rate` above; `lang_on_void`
is left out of it on purpose (wasted output, not something a reader loses), and so are the
examples — ids and language tags are text out of the user's own document and stay on the
deployment. Why each is here rather than in the lint, measured against this deployment's own axe
config: a dead `aria-labelledby` or `aria-describedby` is filed by axe as `incomplete` and never
as a violation (`aria-valid-attr-value` is `reviewOnFail`), and a dead `<label for>` reaches the
`label` rule only when the input has no other name, so the gate is CLEAN on all three;
`definition-list` does report a bare `<dl><dt>Term</dt></dl>`, but HTML allows a `<div>` between a
list and its groups and axe passes as soon as one is present, so
`<dl><div><dt>Term</dt></div></dl>` lints clean with every definition missing; `lang` is a global
attribute, so a `lang` on a void element is legal markup and there is nothing for a rule to fail;
and no rule fires on an announced region with nothing in it.

The ARIA rule is not promoted into the gate the way `duplicate-id-aria` is, because the rule is
wider than the finding — `aria-controls` naming an element that appears on activation is genuinely
undecidable statically, and promoting the id would fail runs on it. The scope is the **joined**
document, not a page: a page agent writes one page at a time and a reference to an id defined on
page 40 is correct in the document those pages assemble into, which is the same reason the issue's
`href="#x"` check was left out. An unnamed empty `<section>` is not counted: a `<section>` is
exposed as a `region` only with an accessible name, so an unnamed one is a generic container no
reader is offered — and a name that resolves to nothing is no name, so
`<section aria-labelledby="nope"></section>` is one finding (the dead reference) and not two.

A `<main>` a page emitted for itself is deliberately NOT among these: that one is fixed rather
than counted (`page_main_stripped`, #251).

`parse_error` on the `delivered_markup` line means these four were never measured, so their zeros
are not a clean bill of health (#164).

### `delivered_alt`

A placeholder where a description belongs, in the file the caller receives (#290): `generic`
counts the `alt` values that are only a word for the medium (`image`, `photo`, `logo`, `null`, …),
`checked` is every non-empty `alt` in the document as the denominator, and `examples` names up to
five of the values. Its own line rather than a field on `extraction_complete`, because they answer
different questions: that one reads the fragments the document is assembled **from**, and the
review loop runs afterwards and replaces a top-level block's markup wholesale — `<img>` and its
`alt` included — so a copy-edit round that guts an alt, or writes a placeholder into a block it
was patching for another reason, is invisible there and visible here.

Absent when there is none, like `delivered_markup` and `delivered_structure`, and for the same
reason: the ordinary document needs no line. A missing line still cannot be read as a check that
never ran, because `extraction_complete.alts_checked` is on every run whatever it found. Comments
are stripped before the scan, exactly as `internal_links` and `delivered_markup` strip them off
the same bytes: the `@unresolved` list is model-written prose ABOUT the document and quotes markup
freely, so an `<img>` inside one would report a placeholder on a document whose images are all
described and inflate `checked` besides.

Measurement only — nothing is repaired at delivery, since the repair is to describe the picture
and the page agent is the only component holding it, which is what the correction pass
(`page_generic_alt`) is for. Nothing here reaches the tally.

### `editor_markers_changed`

The count of a `[not legible]` or `[page not fully transcribed]` marker changed across one
correction round (`iteration`, `before`, `after`, plus `fewer` and/or `more`).

`fewer` is expected where the editor read that region off the attached page image, and is a loss
anywhere else — nothing downstream can tell those apart, and no other signal sees it at all, since
the flattened view strips bracketed tokens before comparing words.

`more` is a placeholder written over words the extractor did read, which no instruction in the
loop allows.

### `editor_list_markers_split`

Half of the one list conversion the Copy Editor is licensed to make (`iteration`, `shape`, plus
`before` and `after`, each `{ items, lettered, printed, printed_lettered, doubled }`).

Written by `src/pipeline/review.ts`.

Why: [design notes — the flattened view and the one conversion it
polices](design-notes.md#the-flattened-view-and-the-one-conversion-it-polices).

### `editor_truncated`

A correction round's response hit the model's output ceiling (`max_tokens`, `chars` returned, plus
`attached`/`of` images and `after: "images_refused"` when it was the retry that truncated). The
review loop stops after this round either way, but the round itself is not given up on: what the
reply already said is read (`editor_salvaged`), and only the part it never reached is re-made a
section at a time (`editor_sections` below). The whole ceiling of output was billed, so this is
the log's most expensive line. Since #250 the round asks only for the blocks the editor changed,
so a ceiling hit here is no longer what a long document costs: it is either a document whose
changed blocks really do fill a response, or — read `editor_patch` and `editor_whole_body` on the
rounds around it — a model returning the whole document when it was asked for a few blocks of it.

**Which of those two it was is on this line** (#277): `reply_head` is the first 240 characters of
what the model did emit, `reply_tail` the last 240, and `blocks_named` counts the `"block"` keys
it managed. One budget of the user's text, spent one of two ways: a fragment longer than both
excerpts together is quoted at each end, and a shorter one is quoted **entire** under `reply_head`
with no `reply_tail` at all — rather than reported as a head whose middle and end are missing
while `chars` says there was more.

`blocks_named` is a count of a key and not a parse, so a document quoting `"block":` in its own
text counts its own prose; the excerpts are logged beside the count for that reason and not only
for colour. Between them, an `edits` array that genuinely did not fit is distinguishable from a
whole document returned out of habit — a block-size problem and a prompt problem respectively.
Recorded because the round **cannot be asked again**, so the fragment is the only evidence that
will ever exist about why it did not fit, and the round was billed in full; the count is the
answer and the excerpts are how a person checks the count.

`blocks_named` is also the closest thing here to a prediction of what the next line will say: it
counts a key rather than parsing, so it is an upper bound on the edits `editor_salvaged` could
recover, and a `blocks_named` well above that line's `edits` means most of the count was the
model's own prose or an entry the ceiling cut. This is the user's own document coming back, so
like `prose_joined`'s `word_split_examples` it stays in the run log on the deployment and never
reaches `GET /v1/quality`, which gets `editor_truncated_rate` and no text.

### `editor_salvaged`

The truncated reply was read as far as it got, and this is what it turned out to have said (#295).
The contract makes the answer a list of independent block edits, so an entry that arrived complete
is a whole correction to a whole top-level node:

`edits` is how many were used, `applied` how many changed their block, `unchanged` how many named
a block and returned it as it was, `refused` how many could not be used (a duplicate, or a
replacement that ends inside an element — each costs its own block, exactly as on `editor_patch`),
and `markers` / `navigation_lost` read as they do there.

`reached` of `of` is the share of the document this covers, and it is the number to read first:
the blocks before it carry this round's own corrections, made by a call that saw the whole
document and the page images, and the `rest` characters after it are what the section calls are
then asked for.

`closed: true` says the edits list itself finished — the ceiling was reached on the way *out* of
the envelope, in `fidelity_observed` or in trailing prose — so every block was considered, and
unless the claim was then cut back (`lost_at` below) `reached` is the whole document and no
section call is made at all: the one truncation that costs a reader nothing.

`edits: 0` with `closed: true` is that same answer with nothing in it: the list closed **empty**,
meaning the editor considered every block and had no change to make, which is a round that
converges rather than a round that failed — the document is delivered as it entered, unsectioned,
and its marker says it was passed rather than lost. (`edits: 0` cannot appear without `closed`: an
unclosed empty list is `no_complete_edit` below, and a list whose every edit was refused is
`all_refused`.) `lost_at` and `dropped` are a claim that was **cut back** (#317), and are on the
line only when one was: the block the reply emptied or handed back with less content in it than it
had, which is where `reached` now stops, and how many of the reply's edits were left unapplied
because they named that block or a block behind it.

A cut-back claim is the case that used to be refused outright, and the change is a cost decision —
refusing it re-requested every block of the document in section calls to avoid applying one edit,
which on the round that filed it was 6 and 5 calls at $0.2243 each against replies holding 6 and 7
usable edits. What it trades is named on that issue: a move carrying content *backwards* leaves it
in the document twice rather than losing it — and **that duplicate is delivered**, because a
truncated round is the review loop's last round and the section calls see only the remainder, so
nothing later in the run removes it (a feedback re-run is the pass that can).

Which is why the count is here to be read rather than assumed to be zero: a deployment seeing
`lost_at` often is a deployment whose delivered documents may hold duplicated content, and the
remedy for the ceiling itself is still `providers.<name>.max_tokens` or fewer pages per session.

`lost_at` may appear beside `closed: true`, which reads oddly and is real — the patch was complete
and part of it is being re-asked for anyway — and then `rest` is non-zero where a `closed` line
otherwise has none. Read `chars` against `editor_truncated`'s `chars` on the line above (they are
the same number) and against `blocks_named` there. The waste this line exists to end was the
largest measured in the pipeline: 24 truncated editor calls across 10 deployment rounds, $17.23 of
a $158.67 bill, every dollar of it on a response nothing looked at.

### `editor_salvage_declined`

The reply could not be read as a prefix, and why (`reason`): `no_edits_list` (no `edits` array in
it at all — the model answered with the document or with prose about it, which is a prompt problem
and not evidence this document is too big for its ceiling), `no_complete_edit` (an `edits` array
that opened and whose first entry never finished: the contract followed and the ceiling reached
inside the *first* block — one enormous table, typically, and the only one of these that says the
document cannot be answered whole. An empty list that **closed** is not this and is not a decline
at all — see `edits: 0` on `editor_salvaged` above), `unknown_block` (a block number this document
does not have, so the reply is not about this document), `unreadable_edit` (an entry whose `block`
could not be read, which might have named a block past the cut), `out_of_order` (block numbers
that jump backwards, so the blocks *between* two named ones cannot be read as deliberately left
alone and the coverage this rests on is not claimable), `all_refused` (every edit read and none
usable), `loss_before_cut` (the reply gave content up and there is nothing in front of the loss to
keep: `lost_at` names the block it emptied or handed back with less in it than it had, and
`lost_at: 0` — the very first block it claimed — is the common shape. A higher one says the same
thing about a claim that started later: there was nothing usable in front of that block, either
because the reply named no earlier one at all (its first edit was the lossy one, so the blocks in
front of it were only ever covered by silence) or because the edits it did name there were
themselves refused. This contract makes a *move* a pair of edits, and here the cut **is** a
refusal of everything after it, so the source half without its landing half would delete content
nothing downstream can miss. A loss with usable edits in front of it is **not** this and is not a
decline at all — since #317 the claim is cut back to that block and those edits are applied, which
is `lost_at` on `editor_salvaged` above).

The counts that decided it are on the line, with `reached` and `of` where they are known —
`reached` on a decline is the whole claim the reply made, since nothing was applied and there is
no shorter prefix to report. The round then takes the route it took before this existed: the
**whole** body, a section at a time (`editor_sections`, with no `covers` field). The last three
are the strict ones, and being wrong about them costs a longer route rather than a document.

### `editor_sections`

A round that could not be answered whole is being re-made a piece at a time: the body was cut into
`sections` pieces of at most `budget` characters, sized from the `chars` that response actually
returned, and they are corrected `concurrency` at a time. The budget is measured rather than
estimated — nothing here is computed until the ceiling has actually been hit — and it is
deliberately well under what came back, because a correction adds characters.
`covers: "remainder"` says this is the tail of a salvaged round rather than the document:

`chars` on such a line is the size of what the reply never reached, not of the body, and the
blocks before it are already corrected (`editor_salvaged` above). Absent on the whole-document
path, which is what every log before #295 holds.

### `editor_section_failed`

One section could not be corrected (`section` of `of`, and `reason`: `truncated` or `too_large`
for a section whose own response or request did not fit, `no_output` for a reply with no usable
HTML in it, `shrank` for one that parsed but came back with under half the section's prose — the
same floor the ordinary round applies to the body it assembles, with the same four sizes and
`floor` on the line, see `editor_shrank`). A `truncated` section carries the same `reply_head` /
`reply_tail` / `blocks_named` as `editor_truncated` above, on the same terms — deployment only, a
few hundred characters — with one difference in how to read them: a section round asks for the
section's corrected HTML and not for an edits list, so `blocks_named` is 0 on a section that
answered the request it was given, and it is `reply_head` that says whether it was.

A count above 0 here is not noise but the same prompt problem in its other form — the
whole-document contract's shape coming back to a request that never used it. `covers: "remainder"`
where the sections are the sections of the **tail** a truncated reply never reached rather than of
the document — the same marker `editor_sections` carries, on the same terms, because
`section 2 of 3` means two different things without it. That section's **original text** goes back
into the document, so the cost is that section and not the round.

Anything that is not a size failure — a stall, a stream error, a bad key — is not logged here and
still ends the run.

### `editor_sections_declined`

The round could not be re-made a section at a time, and why (`reason`): `unmeasured` (no character
count to size a budget from), `budget_too_small` (the response was cut so early that the sections
would be too small to be worth asking about), `budget_exceeds_body` (the response was *longer than
the document* — a reply that ran away with itself, so the sections would be one section and the
same request), `indivisible` (the piece to correct is over budget and has no top-level boundary to
cut at — one enormous table, say), `too_many_sections` (more requests than one round may spend,
with `sections`, `max` and `budget`).

`covers: "remainder"` means this was the tail of a salvaged round (`editor_salvaged`), and it
changes what the line costs: the blocks the reply reached keep their corrections and only the
remainder goes uncorrected.

`budget_exceeds_body` is not reachable there — a remainder short enough to fit under the budget is
*asked for* in one call, because it is strictly smaller than the request that truncated and
carries no images, which is the whole of that reason's objection. Without `covers`, the round is
discarded as it was before any of this existed: the document that entered it is delivered with
that round's issues unresolved.

### `reader_start`

The Reader is about to read the document: which `iteration`, how many `chunks` it goes out in, and
the `concurrency` those run at.

Written by `src/pipeline/review.ts`.

### `reader` / `editor`

Per-iteration review-loop progress: the Reader's `issues` count, and whether that round's correction
`changed` the document.

**Which fields are on the line says what shape the round took.** A round answered piece by piece
carries `sections` and `corrected`, which is how a log tells one from an ordinary round
([`editor_patch`](#editor_patch)) and how much of the document the corrections reached. A **salvaged**
round carries `blocks_reached` of `blocks` too — the pair [`editor_salvaged`](#editor_salvaged) calls
`reached` and `of` — and then **`covers: "remainder"`** beside the section counts, because those
sections are the sections of the tail the reply never got to and not of the document (#295). So a
truncated round that was salvaged and sectioned corrected `blocks_reached` blocks with the whole
document in view *and* `corrected` of `sections` pieces of what was left. Without `covers`, the line a
reader greps per round would read as document-wide coverage on the one round where the section counts
are over something smaller.

**A truncated round that rescued nothing has no `editor` line at all**, which is how it is told apart
from a round that ran and changed nothing ([`review_converged`](#review_converged)).

**Three readings of size, all on the line whatever fired.**

| Fields | What they measure |
| --- | --- |
| `chars_before` / `chars_after` | The body that entered the round and the body that left it, whole |
| `text_chars_before` / `text_chars_after` | The same two, with the markup taken out |
| `structure_before` / `structure_after` | Counts of headings, paragraphs, lists, items, terms, definitions, tables, captions, rows, header cells, data cells, images and links in the body on each side |

The first two are the same pair [`page_corrected`](#page_corrected) carries, so a round and a page
correction can be read against each other. Both, because a length alone cannot say whether a round
lost content or lost wrappers: markup-only work leaves the prose pair equal and moves the whole
one, and a round that deleted a paragraph moves both. **The prose pair is the one the floor reads**
(`editor_shrank`) — a reply under half the prose it was given is refused.

`structure_before` / `structure_after` are full counts, because a ratio needs its denominator, and
`h1`-`h6` are folded into one number so that the re-levelling the page rules ask for is not read as
headings lost. Header cells are counted apart from data cells, and `<caption>` is counted; wrappers
(`<section>`, `<div>`) are not, since unwrapping a mis-structured page is one of the corrections this
loop is for.

**Four things to know before counting a corpus off these.**

- **The sizes are the body.** The wrapper and the `@`-comments after `</main>` are added downstream
  and are not what any round returned, and the sizes are taken after the deprecated-role strip, so
  they describe the body that ships.
- **On a sectioned round they are still the whole body's**, which matters to anyone reading them as a
  distribution, since one section's *reply* is a fraction of the body it belongs to.
- **A round whose reply carried nothing usable reports equal sizes by construction**, with
  [`editor_no_output`](#editor_no_output) beside it to say so.
- **The published ratios are not all this line's quantity.** 0.62–2.32 over 265 page corrections is
  delivered-against-given, as here; 0.982–0.984 over three rounds is the *reply* against the body that
  went in, reconstructed from `agent_call`. This line reports 1.000 for those same three rounds.

**The structure counts do not gate, and the residual is unwatched rather than covered.**
[`editor_patch`](#editor_patch)'s `headings_dropped` reads the same heading fold per BLOCK, where the
question is whether one replacement gave up its heading rather than what proportion of the document's
headings are left — which is why a fall can be acted on there when no ratio can be placed here. Its
`navigation_lost` is not that reading: it compares the whole body before against the whole body after.
A
round that rewrote every heading to the *same* level leaves no downward skip, so the re-lint's
`heading-order` is silent on it, `headings` is unchanged and the prose pair is equal: every level
distinction gone with nothing on the line to say so.

Why the floor reads the prose pair rather than the whole-body size or the structure counts, and what
the structure counts were measured to be worth, is in [design notes — what the review loop's structure
counts count](design-notes.md#what-the-review-loops-structure-counts-count).

### `reader_issues_dropped`

One window's reply listed entries that could not be issues, and they were dropped: `iteration`,
`window` of `of`, `dropped` how many went, and `of_entries` how many the list held.

A reply's shape is the model's and not this pipeline's, so none of it is assumed — and this line is
what that check costs, said out loud rather than silently. An entry that is not an object cannot be an issue, and
reading a page list off one throws — the same crash as an `issues` that arrived as a string, one
level in. So it is dropped rather than fatal, on the argument the whole path is built on: a reply
that is partly usable is worth its usable part. `dropped` equal to `of_entries` is a window that
said nothing readable at all, and it has a `reader_no_output` line beside it.

### `reader_no_output`

One window was paid for and produced no verdict: `iteration`, `window` of `of`, `chars` of reply
text, and `reason` — `no_issue_list` for a reply with no `issues` list in it this code can read
(prose, an apology, `{"issues": "none"}`), `no_readable_issue` for one that listed entries and had
none survive the shape check. Two different replies, which is why the reason is a field. Said the way
`editor_no_output` is said, because it is the same event about the other agent: a call that was
bought and gave nothing to act on.

One line per window that failed, because a document is read in windows and only one of them may
have. An **empty** `issues` list is not this event — that is a verdict, and the one the whole loop
is for. The delivered document carries a `@review-unread` comment saying how many windows of how
many, and the tally counts the document (the
[quality tally](#quality-tally-shared-secret-off-by-default)'s `review_unread_rate`), because
otherwise this outcome reads as the best one there is: no issues found, no `iris:unresolved` row, a
document counted clean.

### `lint_unavailable`

axe-core could not run on a body no `assembly` line covers, with the same `lint_error` /
`lint_error_where` / `lint_error_name` / `lint_error_stack` fields that line carries.
`stage: "correction_round"` is the review loop's re-lint of a body an editor round changed, with
the `iteration` that produced it; `stage: "feedback_relint"` is a feedback re-run that skipped
extraction, where there is no assembly to report one. The document ships with **no accessibility
verdict** either way: the loop had no violations to work from, and the delivered HTML says so in
an `@lint-unavailable` comment.

### `lint_debris`

The linted body carried attributes whose **names no valid markup produces**:
`malformed_attributes` (how many, exact) and `malformed_attribute_names` (up to three of the names,
each cut at 40 characters). The same fields appear on the `assembly` line; this event
carries `stage: "correction_round"` (plus `iteration`) or `stage: "feedback_relint"`, matching
`lint_unavailable`.

Absent when there were none, so a line carrying it means something. These are evidence about a bug
**one stage earlier**, not a defect in the document: an attribute named `1\"` is what the HTML
parser makes of `aria-label=\"Page 1\"` arriving with its JSON escaping still on it, and the same
leak puts `\"doc-pagebreak\"` in a `role` and `\"page-1\"` in an `id` (#233, #234) — an invalid
role, a marker that announces the wrong text, and a dead target for every reference to it. Those
are findable only by reading the document; this is a number.

Nothing is removed from the document the lint checks, because removing an attribute takes the
rules that read it away too: `aria-valid-attr` (critical, wcag2a) reports `aria-label"Note"`
*because* it is malformed. Up to jsdom 25, `malformed_attributes_removed` also counted digit-leading
names the lint removed so axe could run at all (#257). jsdom 30 does not need that, so the field is
gone (#535). The document that ships keeps every byte.

### `editor_patch`

What one ordinary correction round's reply actually did to the body, block by block (#250). The editor
is shown the body as numbered top-level blocks and answers with the blocks it changed, so this line is
the whole accounting.

**Four fields are always there**, so a round that named nothing is still on the record: `blocks` in the
body, `edits` named in the reply, and how many were `applied` and `deleted` (a block emptied with
`"html": ""`). `applied` means applied to the body that goes on, so a block that was refused, or held
back for dropping a heading, is not in it.

**Six more appear only when non-zero**, and a line carrying any of them is a reply that did not follow
the contract in some way:

| Field | What it counts | Effect |
| --- | --- | --- |
| `unchanged` | Blocks returned byte-identical to the one they replace | Delivered as it stood — output paid for to say nothing |
| `markers` | `<!-- @block N -->` comments copied back into a replacement | Stripped out, then applied like any other |
| `unknown` | Block numbers the body does not have: out of range, negative, or not whole | Refused |
| `duplicate` | A second edit for a block already named — the first is kept | Refused |
| `incomplete` | A replacement whose markup does not close what it opens, or that carries an end tag closing nothing | Refused |
| `unreadable` | Entries in the array that are not an edit at all | Refused |

A refusal costs that block and nothing else: it keeps its original text and the rest of the reply is
still applied. `unchanged` and `markers` are on the record as costs rather than rejections, which is
why they are named apart.

**Two readings of what the round took away, at two grains.**

`shrunk` counts applied replacements carrying less of the document than the block they replace, and is
on the line whenever it happened, because that is one of the ordinary ways this contract removes
content the document printed twice. It is read as the **prose**, plus the two things a block holds
that carry no words — `<img>` and `<a>` — plus `headings`, folded across `h1`-`h6`.

`navigation_lost` is `{ "headings": 1, "items": 2, "rows": 1 }`: how many of each stopped existing,
read on the **joined body** rather than block by block, and present only where that body's prose did
**not** shorten. The grain differs because a reorder is a pair of edits under this contract — a heading
moved down past a paragraph is one block giving it up and another taking it — so a sum of per-block
falls would report a document that kept every heading as having lost one.

**Three limits before counting a corpus off `navigation_lost`.**

- **One sanctioned deletion anywhere in the reply silences it for the whole round.** A round that drops
  a reprinted title in one block and demotes a real heading in another logs nothing here. It
  under-collects on purpose.
- **`items` and `rows` do not gate**, because content leaving one of those can land in a different
  structure a reader can still navigate: a `<ul>` rewritten as the `<dl>` the page rules ask for takes
  `items` to 0, and a list mis-extracted as a single-column table, corrected, takes `rows` to 0.
- **A rate quoted off this field alone is a rate over block-patch rounds.** The same reading is
  collected on the other two apply paths — a whole-body reply and the section fallback — under its own
  line ([`editor_navigation`](#editor_navigation), #375); before that it was computed here and only
  here.

**`discarded` names the case where the reply is not applied in part**, and which of three it was:

| `discarded` | What it means |
| --- | --- |
| `all_refused` | Edits were sent and not one could be used |
| `refusal_with_loss` | A refusal in the same reply as a block that gave content up — `deleted` or `shrunk` |
| `headings_lost` | The body this round would have delivered has fewer headings than the body it was given, with its prose no shorter and nothing refused anywhere — and handing back the blocks that dropped them could not be shown to fix it (#331) |

Either way the body is handed back untouched and the next round is a retry (see
[`editor_no_output`](#editor_no_output) for why that is not convergence).

**The heading fall is held back per block, not per round.** `headings_reverted` lists, in ascending
order, the block numbers whose own heading count fell **and** that gave nothing to another edit in the
reply; those blocks keep their original text, the reply is re-applied without them, and the round is
delivered with everything else it corrected. So a line carrying `headings_reverted` with no `discarded`
beside it reads as *`applied` shipped and `headings_reverted` did not* — it is the only place that
difference is visible.

Where the revert was not available, one of these says which attribution failed, since `headings_lost`
has three reasons behind it:

| Field | Why the blocks could not be handed back |
| --- | --- |
| `headings_gained` | A heading arrived somewhere it was not, so a departure cannot be matched to an arrival. Counted, because one arrival beside one fall is a move and eleven is a restructure |
| `headings_dropped` | No heading arrived, but a block that dropped one gave content to another edit in the same reply, so re-seating it would print those words twice. **Every** block whose own count fell, which is the reading of what the model did |
| `headings_abandoned` | Beside `headings_dropped`: the blocks that COULD have been handed back and were refused with the round anyway. Subtracting it leaves the blocks that could not be, so both readings come off one line |
| `headings_recheck: true` | Beside `headings_dropped`: a fall survived the revert that no block still dropping a heading explains. Unreachable by construction, so its firing at all is the finding |

`headings_gained` and `headings_dropped` are mutually exclusive on a line, and `headings_reverted`
present *with* `discarded` is the fourth shape — blocks were handed back and nothing was left to
apply. What is worth reading off a `navigation_lost` `headings` count is its magnitude: one heading
gone is a repeated title resolved a little too thoroughly and 84 is a document flattened.

**One case the headings reading counts and should not**, named rather than compensated for:
`EDITOR_SYSTEM` sanctions "correct labels and table headers", so a field label the extractor emitted as
`<h4>Name</h4>` corrected into a `<label>` inside the same `<form>` block keeps every word and takes
`headings` down. `<label>` and `<legend>` are not counted at all, so no discount reaches it. Since #331
the cost is one block on one round: that `<form>` block is handed back with its `<h4>` intact and every
other correction in the reply is applied and delivered.

[`editor_headings_gated_rate`](#quality-tally-shared-secret-off-by-default) is what says how often it
happens.

Why the gate acts on a reply with nothing else wrong with it, why an arrival is counted at word grain
rather than looked up, why size cannot license the re-seat, and why the re-check is per block, is in
[design notes — a heading fall with nothing else
wrong](design-notes.md#a-heading-fall-with-nothing-else-wrong).

### `editor_whole_body`

The reply carried no `edits` array but did carry an `html` string, so the round was read as the
whole corrected body — the contract every round used before #250 (`blocks` in the body it was
given, `chars` in the reply). Accepted rather than refused because refusing it spends the round,
and on a model that falls back to a familiar shape under load it would spend every round of the
run; a whole body arriving this way goes through the same `editor_shrank` check it always did. It
costs one thing the old contract could not, and `markers` is that cost measured: the document this
model was SHOWN carries a `<!-- @block N -->` line above every top-level element, so the likeliest
whole-body reply is that document retyped, markers and all.

Written by `src/pipeline/review.ts`.

### `editor_no_output`

The Copy Editor's reply carried no usable body (`chars` of text came back), so the round kept the
document it was given. A call paid for and nothing said — which is why it does not end the loop:
the next round is a retry, not a repeat.

### `editor_shrank`

The body a correction round produced came back with **less than half the prose** of the one it was
given, so it was refused and the round kept the body it was given (`chars_before`/`chars_after`,
`text_chars_before`/`text_chars_after`, and the `floor` divisor). `stage: "patch"` is the ordinary
round, measured on the **joined** body rather than on the reply — the reply is a few blocks, and
the question this floor asks is about the document those blocks assemble into — and it carries
`deleted` and `shrunk` of `of` beside the sizes, because that is what a shrink under the block
contract is made of: blocks emptied with `"html": ""`, and blocks returned with less in them than
they had, in a reply where each edit on its own was well-formed.

Both, because this path is only reached when nothing was refused — a refusal beside a block that
gave content up is `discarded` on `editor_patch` before the floor is read — so the commonest reply
that lands here empties nothing and returns blocks holding a fifth of their prose, and
`deleted: 0` alone would say nothing about where the document went. With no `stage` the round
returned a whole body, where the model's `html` is adopted for the document with nothing compared
against what went in and the blast radius is the deliverable — a reply that answered about one
section, or summarised, or quoted the contract back after answering, arrives shaped like a
corrected document (issue #174).

Reported the same way as `editor_no_output` and for the same reason: nothing came back that can be
used as *this* document, so the next round is a retry rather than a repeat and this is not a
`review_converged`. Read on the **prose**, not on the characters and not on the structure counts,
because only the prose pair is stable on a legitimate round: the four rounds that record all three
readings land within 0.6% of their input on it, while unwrapping a mis-structured document keeps
every word and loses half the bytes, and one of those rounds rewrote a 55-item `<dl>` into list
items — a ratio of 0.055 on `terms` — while its prose moved 0.3%.

Bodies with under 1,000 characters of prose are not judged at all: the legitimate deletions are
fixed-size (a `[page not fully transcribed]` marker is 28 characters, a duplicated heading 20–60),
so on a short body the floor would fire on the editor doing its job.

### `editor_navigation`

The structures a reader navigates by, counted on a reply that was **adopted**, for the two apply
paths that do not gate on the count (#375). `stage: "whole_body"` is the pre-#250 contract's reply
taken as the whole corrected document (`editor_whole_body` above); `stage: "section"` is one
section of a sectioned round, with `section` of `of` — and `covers: "remainder"` where those are
the sections of the **tail** a truncated reply never reached rather than of the document
(`editor_sections`, `editor_section_failed`, and `editor_salvaged`'s `covers` are the same marker;
a rate grouped per round off a line without it would read `of: 3` as "the document was cut in
three").

The reading is `navigation_lost` on `editor_patch`, and until #375 it was computed there and
nowhere else — so a `<h2>` rewritten as `<p><strong>` fell silently on both of these paths, and
the only check either had cannot see it by construction:

`editor_shrank`'s floor is a prose floor at half the document, and a demotion keeps every word and
grows the bytes. On the sectioned path that matters most, because a sectioned round is the loop's
**last** round (`editor_sections`), so what falls there ships with no retry behind it. **Nothing
is refused on this line, and that is deliberate rather than pending.** #331's remedy is a block
handed back, and neither path has blocks: a whole-body reply is one string and a section reply
*is* the section, so the only refusal expressible is the whole thing — which is what #331 did in
its first version on the patch path and what it was changed away from, because on the commonest
false positive (a stray `<h4>Name</h4>` corrected into the `<label>` axe's `label` rule asks for)
it threw away every other correction in the reply, every round, until the budget ran out.

Doing that here would be worse: it would cost a whole section's corrections, on the round that has
no successor. What has to come first is the rate, and this line is the rate. **It prints on every
delivered reply**, counts or no counts, because a rate needs its denominator on the record and a
line that appeared only when something fell could not tell a round nothing fell on from a round
that never took this path — so a clean whole-body round is `{"stage": "whole_body"}` and that is a
row in the denominator.

`headings`, `items` and `rows` appear only where each fell, and only where the reply's prose did
**not** shorten; where it did, `shortened: true` is on the line **instead** of the counts, because
the reading is silenced there — a deletion the prompt sanctions takes its own words with it, which
is the ordinary shape of a correction rather than damage — and an empty reading would otherwise
read as "nothing fell" when it means "not asked". The grain is the unit the reply was about, so
the sectioned path reads each section rather than the joined body.

That is sound here and finer than the patch path can manage: sections are corrected independently
and joined, so no heading can move *between* them, and the reorder hazard that forces
`navigation_lost` to be read on a whole body does not exist. It is also cheaper in the one way the
patch path's grain is expensive — there, one sanctioned deletion anywhere in a reply silences the
reading for the whole round; here it silences that section, so a demotion in section 3 is still on
the record. Not folded into `editor_headings_gated_rate` in the
[quality tally](#quality-tally-shared-secret-off-by-default): that rate counts documents where
something **was** handed back, and adding rounds where nothing was would make a signal about a
working guard into a mixture of that and a reading nobody acted on.

### `assembly`

The assembly phase's own line: `pages`, how many page fragments were joined into one body, and the
first accessibility lint of it — `lint_ok`, plus `violations` when there were any to count.

`violations` is **omitted rather than zeroed** when the lint did not run, and that omission is the
point of the field: `violations: 0` read beside `lint_ok: true` was a clean bill of health for a
document axe had never looked at, and anything tallying these lines added it as a real zero (#164).
A lint that could not run carries `lint_error`, and `lint_error_where`, `lint_error_name` and
`lint_error_stack` where they could be said — which step threw, its error class, the first frames —
because the message on its own read "Octal escape sequences are not allowed in strict mode" and named
nothing anyone could reproduce from. The document that provoked it needs no second copy to
reconstruct: this lints `wrapDocument(assembleBody(fragments))`, both pure, and `fragments.json` is
written before this phase runs.

`malformed_attributes` and `malformed_attribute_names` are the same two fields [`lint_debris`](#lint_debris) carries, on the same argument. Later lints of the same
document have no `assembly` line to sit on: a correction round's re-lint and a feedback re-run that
skipped assembly report through [`lint_unavailable`](#lint_unavailable) and `lint_debris` with a
`stage` instead.

### `assembly_anchors`

What namespacing the pages' `id`s cost, written **only when the join had to do something**, so an
ordinary run adds no line. `collisions` are the ids more than one page claimed. `ambiguous` are the
references naming one of those, as `page N: #ref`, each repointed at the first claimant — which is
what the un-namespaced document resolved it to, but no page vouches for that being the copy it meant,
so this is the field worth a person's eye. Without this line there is no symptom at all.

`unrepointed` is the subset aimed at no owner, because every page claiming the id already links to
its own copy (#233): the page that wrote the reference transcribed a marker whose note nothing in
this document holds, which is a page worth looking at. Left **bare**, not dead — the link still
resolves, to a note that has its own marker. `pinned_ids` are ids whose FIRST owner was deliberately
left un-namespaced so that a reference on a page that could not be rewritten keeps landing; without
that field, `collisions` would claim an id was namespaced when it was on purpose not. `skipped_pages`
are pages left exactly as written rather than risk losing markup on reserialization, so one may still
carry a collision — lint's `duplicate-id` / `duplicate-id-active` names those — or a reference the
other pages renamed away from.

Whether a reference lands in the bytes that ship is measured on the delivered document
([`internal_links`](#internal_links)), not here.

### `assembly_words_joined`

A word the printing broke at a line end, carried into the markup with its hyphen, **rewritten without
it** — written only when something was rewritten, so an ordinary run adds no line. Each entry reads
`Govern-ment -> Government (document writes government)`: the spelling that stood, what replaced it,
and the unhyphenated occurrence elsewhere in the document that licensed the change.

**This line is the only trace, and it reports a change to delivered TEXT** rather than to markup, which
no other assembly line does. The third field is the evidence: a reader checking this line is asking
whether the document really writes the whole spelling somewhere, and if it does not, the join is wrong
and the log is where that is visible.

**Three conditions have to hold together**, and each stops a different mistake:

1. The joined spelling appears somewhere in the document — without it, `ad-valorem` closes into an
   `advalorem` no page prints.
2. The fragment after the hyphen is not a word the document uses on its own, which is why
   `inter-state`, `non-tax`, `non-farm`, `Mid-east` and `Non-property` are never touched here.
3. The joined spelling is not on the page carrying the hyphen. That page is
   [`page_split_words`](#page_split_words)'s ground, and the words this pass declines stay with it and
   its correction call.

**`words` is capped at 20 spellings; `count` is not.** Bounded on the same reasoning as
[`prose_joined`](#prose_joined)'s examples — the count is the figure, the list is what a reader
spot-checks, and an OCR-garbled submission is what a cap is for — so a truncated list never
understates how much text changed.

Why the three conditions read the document at three different widths, why the repair is written into
prose only, and the one leftover that is a WCAG failure rather than an inconsistency, are in [design
notes — closing a word the printing broke at a line
end](design-notes.md#closing-a-word-the-printing-broke-at-a-line-end).

### `deprecated_roles_stripped`

A deprecated ARIA role was removed from an element whose own role already said it — `roles` (the
set) and `nodes` (how many attributes went), with `stage: "assembly"` for what extraction
produced, `stage: "correction_round"` plus `iteration` for what an editor round introduced, or
`stage: "feedback_prior_body"` for one already in a stored body that a feedback re-run picked up
without re-extracting. ARIA deprecates exactly three roles — `directory`, `doc-biblioentry`,
`doc-endnote` — all folded into list semantics, so an `<li role="doc-endnote">` inside an `<ol>`
is announced identically without it and axe's `aria-deprecated-role` has nothing left to report.

**This line is the only trace.** The delivered document is clean and the lint that would have
named the role now finds nothing, so a run log with this line in it is the page agent's FOOTNOTES
rule not being followed (`stage: "assembly"`) or the Copy Editor introducing markup nobody asked
for (`stage: "correction_round"`) — which is how issue #187 shipped: axe reported the role, the
editor was told, it rewrote five sections, and the role survived. The strip is deliberately
narrow: the role is removed only where the host element already provides it, so a
`<div role="doc-endnote">` is left to fail the gate, because deleting it there would leave nothing
marking the element as a note at all and the remedy is to make it a list item.

**The host table is not the only thing that narrows it**: it shares its attribute locator with the
row below, so the shape that row declines to edit — a `role` whose unquoted value runs into a
quote — is declined here too, and a **repeated** `role` is handled here the same way, by emptying
the attribute rather than deleting it so the second copy cannot be promoted. Both are set out in
that row.

### `invalid_roles_stripped`

A `role` naming something that is **not an ARIA role at all** was removed — `roles` (the set,
spelled as the document spelled them) and `nodes` (how many elements were edited), with the same
three `stage` values as `deprecated_roles_stripped`. The case this was built for is
`role="doc-footnotes"`, which does not exist: DPUB defines `doc-footnote` for one note and
`doc-endnotes` for a collection, and never a plural of the first, so a model following the
footnote rule generalises from the `doc-endnotes` example beside it and invents the name. axe
reports that as `aria-roles` at **critical** — the most severe thing this gate says about any
document Iris produces — and it has reached a delivered `output.html`, on a round where the lint
had degraded to *did not run*.

Fields: `iteration`, `nodes`, `roles`, `stage`.

Written by `src/pipeline/assembly.ts`, `src/pipeline/orchestrator.ts`, `src/pipeline/review.ts`.

### `page_main_stripped`

A `<main>` a page emitted for its own content was taken out of the body, because `wrapDocument`
puts the assembled body inside one and a `main` inside a `main` takes away the landmark a
screen-reader user jumps to in order to skip the furniture (issue #251, 18% of page answers).

`unwrapped` (a bare `<main>`, tags removed and children promoted), `downgraded` (one carrying
attributes, rewritten to a `<div>` keeping them, since unwrapping it would drop the `lang` the
document's root declaration is derived from or an `id` an `href` elsewhere resolves to) `dropped`
(a stray `</main>` closing nothing, deleted) and `declined` (a `<main>` nothing closed, left in
place), with the same three `stage` values as `deprecated_roles_stripped`. **This line is the only
trace of the first three counts**, exactly as with the role strip: the delivered document is
clean, and a run log with this line in it is the page contract's shell sentence not being followed
(`stage: "assembly"`) or the Copy Editor supplying a wrapper it was told not to
(`stage: "correction_round"`).

`declined` is the one that ships: the element's extent is whatever the parser decides, so there is
no correct edit for an unclosed `<main>`, and
`landmark-no-duplicate-main`/`landmark-main-is-top-level` report it in the gate. The unpaired END
tag is not left, for the reason that reverses: a parser discards it, so nothing is being weighed —
and it is the one shape no rule reports, because inside the shell it closes the document's own
`<main>` early and every element after it is delivered outside the landmark with the lint clean.

That escape predates this rewrite; what would be new is a `declined` count promising a violation
nobody can find. A `role="main"` on an element that was never a `<main>` is not counted here at
all and goes straight to the gate, for the reason the role strip stays narrow.

### `page_markers`

Page-break markers were checked against the document's own numbering, and any label naming the
**position of the image in the file** instead of the number the page prints was removed (issue #333).

Fields: `departures`, `markers`, `off_mode`, `readable`, `stage`, `stripped`, `systems`, `unchecked`, `undecided`, `unreadable`.

Written by `src/pipeline/assembly.ts`.

Why: [design notes — a page label naming the image's position rather
than the page's
number](design-notes.md#a-page-label-naming-the-images-position-rather-than-the-pages-number).

### `reader_page_reports_deduped`

One round's Reader reports about a page the document has **no content** for were reduced to one
per page: `dropped` (how many reports went), `pages` (which pages the kept ones stand for) and
`reports` (each dropped report's severity and text, folded and bounded), for that `iteration`. Two
kinds of page have no content — one extraction lost (`pages_failed`, a `@page-failed` comment) and
one that is blank in the source (`page_blank`, correctly delivered as an empty page) — and neither
is something a correction round can act on.

The Reader is told so in the index it reads and in its own prompt; this line is what happens when
a sampled model raises them anyway, which it did **once per chunk**, in a different wording each
time, so exact-string dedupe caught none of them (issue #188). Per chunk of the FINAL round, to be
exact: `@unresolved` is written from the last read of the document, so that read's chunk count is
how many copies were delivered — six of one document's 26 on the round that filed the issue. What
the iterations multiplied was the spend, not the list: every round's editor was handed the same
unrepairable reports.

Only the FIRST report of a page is kept, deliberately: an issue whose attribution is entirely
pages with no content can only be about the absence, but the attribution is the Reader's and a
misattributed real issue must not vanish without trace — which is what `reports` is for, since
which report came first is an accident of chunk order. An issue that names any page with content
in it is never touched, and an unattributed report cannot be reached here at all.

### `review_converged`

The loop stopped early because a round changed nothing (`iteration`, the `issues` that round was
given, and the `rounds_left` it did not spend). The editor answered and handed back the document
it was given, so the same request next round would be answered the same way; what ships is that
document with those issues written to `@unresolved`. Expect this on a document whose remaining
issues are the ones the loop is designed not to resolve — an undecidable pair of same-worded
headings, a `[page not fully transcribed]` marker.

Frequent lines here with `issues` the editor *should* be able to fix are the signal worth chasing:
that is the editor declining work, not the loop saving a wasted round.

### `run_signals_failed`

The deployment-wide quality tally could not be written for this document (`error`). The document still
ships: recording is soft, on the same argument the agent-suggestion filing at the end of a run is —
a tally is not worth failing a document someone has already waited for.

Written by `src/pipeline/orchestrator.ts`.

### `feedback_classified`

The classify pass read a correction and **nothing was recorded**: `kind` is what it called the lesson,
and `recorded` is `false`.

Written by `src/pipeline/feedback.ts`.

### `feedback_learned`

A correction was distilled into a reusable instruction and recorded to the agent's example bank:
`agent` is the file it was recorded against, `kind` is `generalizable` or `a11y_policy`, `instruction`
is the sentence stored, and `count` is how many **distinct sessions** have now reported this same
lesson.

Written by `src/pipeline/feedback.ts`.

### `feedback_agent_missing`

`agents/feedback.md` could not be loaded, so no agent-update proposal was made this round. `note`
carries the whole of that; there is no other field, and no `agent`.

Written by `src/pipeline/feedback.ts`.

### `feedback_target_missing`

The agent the correction was about could not be loaded: `agent` is the file that was asked for, not
one that was found.

Written by `src/pipeline/feedback.ts`.

### `agent_trained`

A **session-built** agent was improved in place: `agent` is its file, and `scope` is `session_built`,
the only value.

Written by `src/pipeline/feedback.ts`.

### `regression_gate`

The candidate prompt was re-run against the agent's stored fixtures before anything was proposed:
`agent` is the file, `cases` how many fixtures were read, `passed` whether all of them held,
`failures` **how many** did not, and `meanCoverage` the mean of the candidate's fixture scores.

`failures` here is a count. On [`agent_update_blocked`](#agent_update_blocked) the field of the same
name is the list of strings behind it, and both lines are written for the same blocked update — so
summing `failures` across the log adds a list to a number.

`cases` counts fixture **files**, not fixtures judged. It is at most 3, the newest three by filename,
and a fixture whose JSON cannot be parsed or whose image is gone contributes to neither `failures` nor
`meanCoverage`. `cases: 3, passed: true` is therefore consistent with nothing having been judged at
all.

`meanCoverage` is `null` when no fixture was scored, which is not a zero: a score of 0 is a fixture
the candidate produced no output for, which is a failure on that fixture rather than an absence of
evidence. The mean is over the candidate alone — the comparison against the prompt in the library is
[`eval_gate`](#eval_gate)'s.

**A missing line does not mean the gate was skipped; it means it had nothing to check.** An agent with
no fixtures directory, or an empty one, passes without writing anything here. So an
[`agent_updates_proposed`](#agent_updates_proposed) with no `regression_gate` above it is a proposal
that was checked against nothing.

The candidate's own text is not recoverable from the log. Its `agent_call` lines carry `agent_sha:
null` and `agent_content: null`, which is [`agent_call`](#agent_call)'s one case where neither field
recovers the prompt that went out.

### `eval_gate`

The candidate prompt scored against the current one over the fixtures **both** could be scored on:
`agent` is the file, as on [`regression_gate`](#regression_gate), `current` and `candidate` are the two
paired means rounded to three decimals, `paired` the fixtures that counted, and `unpaired` those that
could not.

`paired` and `unpaired` are lists of fixture image filenames, not counts.

`current: null` and `candidate: null` mean no fixture was measurable on both sides. That is neither a
regression nor a pass: the update proceeds on [`regression_gate`](#regression_gate)'s verdict alone.

The pairing is what the line is for. Whether a fixture has a score is partly a property of the
prompt: one that produced nothing scores 0, while a fixture too short to judge abstains. So averaging
each side over whatever it happened to measure compared two different fixture sets, and one flake on
the **current** prompt could deflate the bar enough to pass a real regression. Pairing drops
such a fixture from both means instead of moving the threshold, and leaves it visible in `unpaired`,
where on the current side it usually means the shipped agent is flaking.

The gate blocks a drop of more than **0.02** only. A line here whose `candidate` is below its
`current` by less than that is an update that went ahead.

### `agent_update_blocked`

A proposed prompt change was not proposed after all: `agent` is the file it was about.

**Two shapes, and `reason` is what tells them apart.** With no `reason`, this is the regression gate:
`failures` is the list of strings saying what the candidate broke, at most one per fixture, and the
[`regression_gate`](#regression_gate) line above it carries the same information as a count. With
`reason: "eval_regression"`, this is the eval gate: `current`, `candidate` and `paired` repeat the
[`eval_gate`](#eval_gate) line above it, and there is no `failures` field at all — nothing broke, the
candidate simply scored lower.

Nothing is saved on either path, and the document the correction was about is unaffected: it was
delivered before the training step began.

### `agent_updates_proposed`

A proposal cleared both gates and was written to the session's `agent-updates.md` — JSON, despite the
extension: `agents` is a one-element list and `count` is always 1.

Written by `src/pipeline/feedback.ts`.

### `feedback_training_failed`

The training step threw and the failure was contained: `error` is the message, and the only field.

This is the catch in `src/pipeline/orchestrator.ts` around **both** halves of training — the
classification and the update proposal — so the line does not say which half failed, and the first
may have completed. The lines above it are what say how far it got.

**The session is not failed by it.** The document has been `ready_for_review` since before the step
began, and training is work about a future document rather than this one: there is no
[`run_failed`](#run_failed) line under this one, and [`run_complete`](#run_complete) still follows it.

### `run_complete`

The run's own terminal marker: `iterations` the review loop completed, `unresolved` issues left open
in the delivered document, and the `mode` it ran in ([`run_start`](#run_start)).

`failed_pages` and `uncorrected_pages` are present **only when there were any**: a `failed_pages:
[]` on every successful run would read as a field about failure on the lines that have none. This
line is also the only place either set can be read on **every** mode, since a feedback round that
re-extracts nothing has no `extraction_complete` line to carry them. What the run **delivered** is
the question, not what it attempted (#328). Neither set is what
[Diagnostics](#diagnostics-timing--hang-detection) reports: its `pages_failed` is folded from the
per-page `page_extraction_failed` and `page_recovered` lines, and the uncorrected set has no
diagnostics field at all — so this line is where a client reads it.

Written **after** the feedback-training step that follows delivery, even though the session has been
`ready_for_review` since before it, because the run holds its `max_concurrent_runs` slot until it
returns: a marker written before that training would report the run as shorter than the time it
actually occupied the machine. [Diagnostics](#diagnostics-timing--hang-detection) measures a
finished run's duration up to this line.

There is no `pages` field here. The count of source pages is `images` on [`run_start`](#run_start),
and `pages` on [`extraction_start`](#extraction_start).

It is the run's terminal marker and **not the last line of the log**. Suggestions are saved after it,
so [`suggestions_recorded`](#suggestions_recorded) and [`contribution_failed`](#contribution_failed)
can appear underneath it.

### `suggestions_recorded`

New-agent suggestions from this run were saved for the maintainers: `agents` lists the names and
`count` the rows (one per agent and page). They are served by
[`GET /v1/suggestions`](#agent-suggestions-shared-secret-off-by-default).

Written by `src/pipeline/contribute.ts`.

### `contribution_failed`

Saving the suggestions threw: `error` is the only field. It is written by a catch in
`src/pipeline/orchestrator.ts`, like [`feedback_training_failed`](#feedback_training_failed).

This line comes **after** [`run_complete`](#run_complete), and it does not fail the session.

### `run_failed`

The run threw, so there is no document: `error` is the message, and [Poll status](#poll-status)
hands the client that same string in its own `error` field, which exists on a failed session and
nowhere else.

A page that fails on its own does **not** reach here — the run finishes and delivers the rest
([Partial documents](#partial-documents)), which is what `failed_pages` above is for — so a line
here means nothing was delivered at all.

Where a run does end in extraction, [`extraction_failed`](#extraction_failed) is the line that says
which failure it was, and this `error` is written to match: with `blank: 0` it is the first page's own
provider error, standing for all of them because that is the diagnosis; otherwise it counts the source
pages reported blank, which an empty document could not.

### `tagged_pdf` / `tagged_pdf_failed`

A [tagged PDF](#get-a-tagged-pdf-optional) was made, or the tagger refused. `ms` is how long it took.
`tagged_pdf` lists `fields_given`, the names of the fields that were filled in. The values are
never logged. `tagged_pdf_failed` has the tagger's `code` and `error`. An `internal_error`'s
message is left out, because it may quote a value.

### `tagged_pdf_fields` / `tagged_pdf_fields_failed`

`GET /fields` tagged a flat form to list the fields it gets. `ms` is how long it took.
`tagged_pdf_fields` has `created`, how many fields were made. `tagged_pdf_fields_failed` has the
tagger's `code`. A made list is reused until the extracted pages change. A failure is reused for a
minute after it ends, so a failing form writes at most one line a minute while it is asked.

Written by `src/routes/sessions.ts`.

### `form_fields` / `page_fields` / `page_fields_missing`

With tagged PDFs on, the upload reads the PDF's form fields, and the page agent is asked to name
each control after its field, so the tagger can tag the field where it sits.

- `form_fields`: at upload, `fields` (how many were kept) and `unusable` (fields dropped: a name with
  a quote, `'`, `<`, `>`, a backtick or a control character, a name over 100 characters, or no page
  number), or the tagger's `error` code. Without them the run converts the same.
- `page_fields`: `image`, `fields` (how many were in the prompt), `dropped` (past the cap of 40) and,
  on a second draw, `redrawn: true`.
- `page_fields_missing`: `image`, and `fields`, the names no control in the first pass's HTML has.
  Only logged; no correction is made. A control a later correction removes is not reported here, but
  the tagged PDF's report lists it as `field_not_in_html`.

### `calibrate_call_failed`

One verifier call in the calibration harness threw: `image` is the page, `defect` the seeded defect the
copy it was judging carried, and `error` the message.

`defect: null` means the failed call was judging the **undamaged** copy of that page.

**An ordinary run never writes this line.** Calibration is a tool — `src/tools/calibrate.ts` — and not
a phase of a run: nothing else in `src/` imports `src/pipeline/calibration.ts`, so a session's log
cannot contain it.

The failure is not counted as a miss. The call comes back marked unjudged, and every rate the report
prints leaves the unjudged out of its denominator: a defect's catch rate is over what was applied
minus what went unjudged, and the false-positive rate over the clean copies that were judged. The
verdict substituted for the dead call reads `ok: true`, and is not counted as a pass either. What the
line is for is telling a provider to retry apart from a verifier to fix, which is why an unparseable
reply is counted separately from this.

### `audit_snapshot`

Audit mode only ([Audit](#audit-off-by-default)). The document's body was saved at one stage: `name`
is `assembled` (the pages joined, before review) or `round-<n>` (after review round `n`'s fixes), `run`
is which run of the session it belongs to (a feedback re-run is the next), and `chars` its length. Fetch
it at `/audit/runs/<run>/<name>`.

### `audit_unavailable`

Audit mode is on, but its folders for this session could not be made (`reason`, the error), so the
run keeps no prompts or snapshots. The run itself goes on. Expect a full disk or a permissions problem
under `storage.data_dir`.

Written by `src/pipeline/orchestrator.ts`.

## Diagnostics (timing / hang detection)

`GET /v1/sessions/{id}/diagnostics`: a summary of the run log, for maintainers, human or AI, to see
what is slow, stuck or expensive. Field types: [`docs/openapi.yaml`](openapi.yaml). Why the fields
are as they are: [design notes](design-notes.md#reading-diagnostics).

```bash
curl -s -H "$AUTH" "$BASE/sessions/$SID/diagnostics" | jq
```

Unless a field says otherwise, counts sum over every run the session has had, feedback rounds
included. A zero on a field newer than the log means "not recorded", not "none".

**Is it hung?**

- `in_flight`: the longest-waiting open model call (`agent`, `step`, `model`, `provider`,
  `capability`, `since`, `waiting_ms`), or `null`. A large `waiting_ms` is the likely culprit.
- `in_flight_count`: how many calls are open. Pages are extracted in parallel, so several can be.
- `phase`, `started_at`, `last_event_at`, `elapsed_ms`, `phase_durations_ms`: where the time went.
- `model_calls`: `count`, `failed`, `total_ms`, `avg_ms`, `max_ms`, and `concurrency_factor`, which
  is total call time over elapsed time. About 1 means calls ran one at a time; a parallel extraction
  should approach `defaults.extraction_concurrency`.
- `slowest_calls`: the five slowest calls, with `agent`, `step`, `model`, `capability`, `duration_ms`
  and `ok`.
- `errors`: `{ts, type, message}` for each failed model call, `run_failed`, and the two failures
  after delivery that report rather than raise: `feedback_training_failed` and `contribution_failed`.
  A failing recheck verdict is not here; it is in `verification.rechecks.failures`. So a non-empty
  `errors` means the run is in doubt.

**What it cost**

- `tokens`: `input`, `output`, `cache_read`, `cache_write`. They bill at four rates and are never
  summed. `input` excludes cache reads, so the whole prompt is `input + cache_read + cache_write`. On
  an OpenAI-shaped provider, cache writes may be counted in both `input` and `cache_write`, so that
  sum can be high. No dollar figure: prices are deployment config.
- `tokens.calls_reported`: how many of `model_calls.count` reported usage. Below `count`, the sums
  are a floor. Failed calls are counted.
- `by_agent` and `by_step`: the same calls, each with `count`, `total_ms`, `max_ms`, the four token
  counts under their run-log names (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`) and `models`. `by_agent` is keyed by the agent that answered,
  `by_step` by the job the call was for. Either one sums to `tokens`.
  - `models`: the model ids that answered, sorted and unique. Read `by_agent.<agent>.models` after
    changing `providers.per_agent`, on a session run since the change. More than one is normal
    (`per_capability` can put one agent on two models). Empty on a row with calls means an old log.
  - The steps: extraction is `extract`, `verify`, `correct`, `recheck_binding`, `recheck_sampled`,
    `specialist`, `specialist_merge`; review is `read`, `edit`, `edit_section`, `table_join`; a
    feedback round adds `feedback_scope`, `feedback_learn`, `agent_update`, `agent_regression`;
    `agent_calibrate` and `contribute` are maintenance. `"?"` means an old log.
- Caching: expect a few `cache_write` on a run's first calls and `cache_read` on the rest. Several
  calls to one agent with `cache_read: 0` means paying full price for the same instructions. That is
  expected for a model Iris cannot recognize as Claude, a Claude older than 3.7, a prompt under about
  1k tokens, or `prompt_cache: false`. `cache_write: 0` with reads climbing is a provider not
  reporting writes, not a broken cache. These fields cannot show which cache TTL you got
  (`prompt_cache_ttl`); only the provider's bill can.

**`verification`: the verify-then-correct loop**

Every page is checked against its image, and a page that fails is re-rendered once.

- `pages_verified`: pages that reached verification.
  - `pages_unjudged`: of those, pages with no judgement: no Feedback Agent, nothing to verify, a
    reply that would not parse, or a page declared blank. A subset, not a deduction.
    - `pages_skipped_blank`: of those, blank pages whose verify call was not bought.
      `by_step.verify.count` says whether any verify call was bought at all.
    - `pages_verify_error`: of those, pages whose verify call was bought and threw
      ([`page_verify_error`](#page_verify_error)). It cost a full ceiling; never add it to
      `pages_skipped_blank`.
- `verify_failed`: pages the verifier rejected. The rejection rate is
  `verify_failed / (pages_verified - pages_unjudged)`.
- `verify_kinds`: rejected pages by kind (`content_missing`, `content_wrong`, `structure_wrong`,
  `a11y_only`, `alt_quality`), in pages. Not a partition: read each against `verify_failed`.
  `content_missing` includes an image with no description. `untagged_pages`: pages with a problem
  that carried no kind. `verify_untagged_problems`: the same, in problems.
- `verify_inconsistent`: pages the verifier passed while naming a problem. They bought no
  correction. Kinds as above, in pages. `content_or_structure`: pages naming a content or structure
  kind. `undecided_pages`: pages whose problems carried no kind this version knows, and named no content or
  structure kind either.
- `corrections`: pages re-rendered, which is more than `verify_failed`.
  - `triggers`: why. `verify` (rejected), `links` (passed, lost a link), `alt` (passed, placeholder
    alt), `ids` (passed, one `id` twice), `words` (passed, one word spelt two ways), `numbers` (a
    number the PDF text layer lacks, [`text_layer_numbers`](#text_layer_numbers)), `both` (more than
    one). Read it first when `corrections` grows and `verify_failed` does not.
  - `results`: how each ended. `kept`, `rejected` (under a quarter of the page's size, or a rewrite
    of a passing page refused), `identical`, `empty`, `failed` (threw). `identical`, `empty` and
    `failed` are calls that changed nothing. `rejected: 0` is normal.
  - `effects`: what kept corrections changed, read off the two fragments. `alt_only` stands alone;
    `text`, `attrs` (every attribute but `alt`) and `structure` overlap. `text_grew` and
    `text_shrank` split `text` by direction; on a log that mixes old and new lines, compare
    `text_grew + text_shrank` with `text` first.
  - `declined`: problems the corrector refused, with reasons, changing nothing. A decline gates
    nothing, and the page still lands in `uncorrected`. `pages` against `corrections`, `problems`
    against `problems_offered` (every problem every correction was given). `code_checked`: declines
    of problems Iris checked in code (`links`, `alt`, `ids`), which are wrong by construction, so
    watch it. `words` and `numbers` are counted apart, because there only the image can say which is
    right. `unattributed`: declines naming no listed problem.
- `rechecks`:
  - `sampled`, `sampled_ok`: corrected pages that had failed, checked again. How many a run may take
    is `defaults.recheck_sample_size` (default 1); `sampled` is how many it took. Read it as a count,
    not a rate.
  - `sampled_problems_before`, `sampled_problems_after`: fidelity problems before and after, over
    the judged samples. A ratio, and an `after` of 0 does not mean the sample passed.
  - `binding`, `binding_ok`: re-checks of passing pages rewritten for a link or alt. The verdict
    decides whether the rewrite ships. Counted apart from the sample.
  - `sampled_unjudged`, `binding_unjudged`: subsets with no real verdict, which log `ok: true`.
    Subtract from both sides: `(binding_ok - binding_unjudged) / (binding - binding_unjudged)`.
  - `binding_error`: binding rechecks that were bought and threw. Not a subset of `binding`. The
    rewrite was discarded.
  - `failures`: each failing recheck verdict, as `{ts, page, binding, message}`, in the verifier's own
    words. `binding: false` is a page that shipped still wrong; `true`, a rewrite refused; `null`, a
    line that did not say. At most 20, each `message` cut at 600 characters plus `…`.
    `verdicts_omitted` counts the rest. `GET .../logs` has every verdict whole.

**`tables`: joining tables split across a page**

From [`table_joined`](#table_joined), [`table_join_code_declined`](#table_join_code_declined) and
[`table_join_failed`](#table_join_failed).

- `joined_in_code`: pairs joined with no model call. `joined_by_editor`: pairs a Copy Editor call
  joined. `code_declined`: pairs the free path passed to the editor, which is not a failure.
- `code_declined_with_halves`, `joined_in_code_with_halves`: of those, how many logged both halves'
  bytes, so a looser rule can be scored without a run. Expect them to equal their totals.
- `header_compared`: declines where both halves have header cells. `header_differs`: of those, how
  many headers were read differently. Non-zero is normal; watch its direction.
- `failed`: pairs tried and lost. `capped_pending`: pairs never tried because `MAX_TABLE_JOINS` (12)
  was spent. `body_unreadable`: runs whose body would not parse, so no pair was joined. A
  `table_join_failed` with any other `stage` is in none of these.

**`editor_ceiling`: correction rounds that hit the output ceiling**

From [`editor_truncated`](#editor_truncated), [`editor_salvaged`](#editor_salvaged) and
[`editor_salvage_declined`](#editor_salvage_declined). Counts rounds, not documents.

- `truncated`: rounds whose reply hit the ceiling.
- `salvaged`: the part the reply finished ships; only the rest was asked again.
  - `salvaged_closed`: of those, the edits list had closed. One call and no sections, unless
    `retreated` counts the same round.
  - `retreated`: of those, a block before the cut gave content up, so the claim was cut back to it
    (`lost_at`). The document may carry a duplicate; the remedy is a feedback re-run.
- `declined`: the salvage kept nothing, and the whole body went to sections.
- `truncated - (salvaged + declined)` can be above 0: a truncation with no text, or an error that
  lost its type, writes no salvage line.
- `decline_reasons`: sums to `declined`. `loss_before_cut` and `all_refused` are the salvage working;
  `no_complete_edit` is one block bigger than the ceiling; `no_edits_list` is the prompt not
  followed; `out_of_order` a reply not in document order; `unknown_block` and `unreadable_edit` a
  reply that may not be about this document; `unrecognized` a reason from a later build.
- The cost is in `by_step.edit` and `by_step.edit_section`.

**`fidelity_observed`: what the Copy Editor noticed about a page**

From [`editor_fidelity_observed`](#editor_fidelity_observed). Evidence, not a rate: `observed: 0`
means nobody noticed anything, not that the document is faithful. It changes nothing in the
document.

- `observed`: observations. `pages`: distinct pages they were about, including guesses.
  `unattached_pages`: of those, pages whose image the editor did not have that round.
- `kinds`: the five verify kinds plus `untagged`. Not a partition; read each against `observed`.
- `unattached`: observations about a page without its image. `unplaced`: observations naming no
  page. Discount these first.

**Pages**

These follow the document's current state, so a page recovered in a later round leaves its set.

- `pages_failed`: pages with no content in the document, because their extraction threw
  ([Partial documents](#partial-documents)). The run can still be `ready_for_review`.
- `pages_blank`: pages the agent read and reported empty ([`page_blank`](#page_blank)). Not failures.
  `images` on [`run_start`](#run_start) counts them, so `images - pages_blank.length` produced
  markup. Disjoint from `pages_failed`.
- `pages_bare_html`: pages whose reply was bare markup, not the envelope, so their content is in but
  their `log` is not ([`page_bare_html`](#page_bare_html)). What the `log` would have recorded (a
  mid-sentence cut, an orphan heading, a language change, and so on) went unrecorded. A bare page
  whose verify call then failed is in `pages_failed` too.

## Partial documents

A page can fail on its own: a reply cut off at the output ceiling, a stalled stream, or a reply with
no readable HTML (`page_no_output`). That page fails and the run goes on. Every other page is
rendered, verified, assembled and reviewed, and the document is delivered.

- **A blank page is not a failure.** The agent answers with a `log` line saying so and HTML that
  holds nothing a reader receives: an empty string, a comment, an empty paragraph or a bare
  page-break marker (`page_blank`, `pages_blank`). A page whose only content is its own page number
  is blank too. No marker is written for it, and the document is whole.
- **If no page produced content, the run fails.** When every page failed, `error` is the first
  page's own provider error. When some or all were blank, it says `no page produced any content: <n>
  of <m> source pages were reported blank`, plus how many could not be extracted.
  `GET .../output` answers 409.
- **A failed page is marked twice.** Inside `<main>`, where its content would have been, and once
  more after `</main>`, which the Copy Editor cannot reach:

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

- **Where to read it:** `page_extraction_failed` per page in the run log, `failed_pages` on
  `run_complete` (only when there are any), and `pages_failed` in
  [diagnostics](#diagnostics-timing--hang-detection). To know whether you received a whole document,
  check `pages_failed`, not `status`.
- **On a feedback re-run** a failed re-extraction keeps the page's earlier content. It is logged as
  `page_extraction_failed` with `kept: "prior"`, listed in `reextract_complete.failed`, and not
  counted in `pages_failed` or `failed_pages`.
- **A missing page stays missing** across feedback rounds, and every round's document marks it. Only
  a successful re-extraction of that page removes it (`page_recovered`).
- Missing pages are left out of the regression fixtures saved by `POST .../close`.

### A page that is here and is known to be wrong

The page is in the document, but it failed Iris's fidelity check, and the one correction pass
repaired nothing (#328). Its content may be missing or mis-structured. A table that lost rows is how
this has been seen.

```html
<!-- @page-uncorrected 5, 31
  The content of the source pages above IS in this document, and it never passed Iris's
  own fidelity check: the check named what was wrong with each of them, one correction
  pass was made against the source image, and it repaired nothing. No later step checks a
  page against its source again, so nothing after that point can have put right what the
  check named. ...
-->
```

- Written once, after `</main>`, like `@page-failed`.
- A page is in the set exactly when its verdict failed and its `page_corrected` `result` is not
  `kept`. The other results are `identical` (the same page back, even if written differently),
  `rejected` (under a quarter of the page's size, refused as a deletion), `empty` (no HTML) and
  `failed` (the call threw; `page_correction_failed` says why). `page_verify_failed` says what was
  wrong.
- The set is on `extraction_complete.uncorrected` (or `reextract_complete.uncorrected`) and on
  `uncorrected_pages` on `run_complete`, only when there are any. `run_complete` is the one place it
  appears in every mode, since a feedback round that re-extracts nothing logs neither of the others.
- Diagnostics has no list of these pages; `pages_failed` is the no-content set.
  `verification.results` and `verification.triggers` count how corrections ended, without naming
  pages.
- A correction that was adopted is not listed, even if it might still be wrong. No marker means no
  page shipped as the version its own verifier rejected, not that every page was checked again.
- Like a missing page, it follows the document across feedback rounds, only a re-extraction removes
  it, and it is left out of the regression fixtures.

Why both markers work this way: [design notes](design-notes.md#why-a-partial-document-says-so).

## Contributions (automatic)

Every run saves suggestions for new or better agents, with no opt-out, and a workflow files them as public issues. How, and what that means for private documents, is in `GET /v1/suggestions`'s description. Exact contract: [`docs/openapi.yaml`](openapi.yaml).

## Errors

All errors share one shape, except `/v1/quality` and `/v1/suggestions`, which answer `{"error", "message"}`:
```json
{ "error": { "code": "invalid_state", "message": "Human-readable description", "details": {} } }
```
The codes and their statuses are in [`docs/openapi.yaml`](openapi.yaml) (`ErrorCode`).

### When a run fails

A run that fails says why in `error` on `GET /v1/sessions/{id}`. A failed page costs that page; the
run fails only when every page failed ([Partial documents](#partial-documents)). Messages worth
recognizing:

- `response hit the 32000-token output ceiling and was truncated (31998 chars returned). Raise
  providers.openrouter.max_tokens.` The answer was longer than the ceiling, so it was cut mid-tag.
  Iris never assembles a cut-off page. Raise `max_tokens` on that provider and re-run. Dense
  full-page tables and forms are the usual cause.
- `That ceiling is <model>'s own, below the 32000 in providers.bedrock.max_tokens`: the model refuses
  that ceiling. Use a model with a higher one, or fewer pages per call
  ([`output_ceiling_clamped`](#model_call_start--model_call)).
- `That ceiling is this call's own`: Iris capped this call, because it can predict the answer's
  size. Today only the page correction does this: twice the first pass's output tokens, scaled up
  if it is handed more text, and never under 4,000 (`correctionCeiling` in
  `src/pipeline/extraction.ts`). Raising `max_tokens` changes nothing. `step` on the `model_call`
  line names the caller.
- `(0 chars returned)`, followed by `No text was returned at all, so raising that ceiling is not the
  remedy`: the whole ceiling went on reasoning before any reply. Change the model or the size of
  the request, not the ceiling. On `page_extraction_failed` and `page_correction_failed` this is
  `reply_chars: 0`. Read that field, not a missing `reply_head`; on `page_correction_failed`
  `truncated: true` has a second cause ([`page_correction_failed`](#page_correction_failed)).
- `page agent returned no HTML (prose, 412 chars)`: the reply arrived whole but held no HTML.
  `page agent returned no page in 19 chars of HTML`: it held HTML that a reader receives nothing
  from, such as a comment. Both are [`page_no_output`](#page_no_output); its `shape` says which
  remedy applies. Either costs that page, not the run.
- A **correction round** that hits the ceiling keeps what it returned, re-makes the rest a section
  at a time, and stops. The document says so in an `@editor-truncated` comment
  ([`editor_truncated`](#editor_truncated), [`editor_salvaged`](#editor_salvaged),
  [`editor_sections`](#editor_sections)). The remedy is `max_tokens`.

Why these messages read as they do: [When a reply hits its output
ceiling](design-notes.md#when-a-reply-hits-its-output-ceiling).
