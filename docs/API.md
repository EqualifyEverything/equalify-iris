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
  "unresolved_rate": 0.061,
  "first_read": { "documents": 212, "mean_issues": 2.4, "unread_documents": 2 },
  "unresolved_severity": [
    { "severity": "high", "documents": 1 },
    { "severity": "medium", "documents": 4 },
    { "severity": "low", "documents": 12 },
    { "severity": "unrated", "documents": 0 }
  ],
  "review_stopped": [
    { "where": "clean", "documents": 197 },
    { "where": "unread", "documents": 2 },
    { "where": "converged", "documents": 11 },
    { "where": "truncated", "documents": 2 },
    { "where": "cap", "documents": 0 }
  ],
  "links_dropped_rate": 0.02,
  "links_unresolved_rate": 0.11,
  "markup_unbalanced_rate": 0.01,
  "table_no_body_rate": 0.005,
  "structural_defect_rate": 0.09,
  "lint_error_rate": 0.01,
  "lint_error_where": [
    { "where": "parse", "documents": 0 },
    { "where": "inject", "documents": 0 },
    { "where": "run", "documents": 2 }
  ],
  "documents_linted": 210,
  "editor_truncated_rate": 0.01,
  "editor_truncated_lost_rate": 0.002,
  "editor_headings_gated_rate": 0.014,
  "review_unread_rate": 0.01,
  "unfinished_page_rate": 0.03,
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
  page means transcribing that page from its image, which is a re-extraction — a pass with a whole
  response for one page and its own gates on what came back — and not a correction to the markup
  around it. What the copy editor would produce instead is a paragraph written while looking at a
  page, delivered where nothing downstream can tell the two apart. So it is reported
  and left standing, and it
  raises this rate for a document that is otherwise sound — but only for as many rounds as it takes
  the editor to leave the document alone once, which is what now ends the loop. Read it as what it is — one page
  arrived short, and the document says where.
  Everything in the two paragraphs above is a claim about a **floor** under this rate, and the two
  fields that follow, plus `unfinished_page_rate` below, are what measure it. Until #264 nothing did,
  which is how a threshold of 15% came to be compared against a rate of 84% with no way to tell
  which part was inherent.
* `first_read` — what the reviewer **found**, before any of it was fixed. Every other number in this
  tally is taken after the editor has run, which makes the two facts a reviewer change most needs to
  be told apart arrive identically: an editor that fixed everything and a reviewer that faulted
  nothing both deliver an empty `@unresolved` list and a `clean` exit, and both *lower*
  `unresolved_rate`. This is the one field that separates them.
  * `mean_issues` — mean issues raised by the **first** read of a document, averaged over the
    documents that recorded one. The first read specifically, and not a sum over rounds: every later
    round reads a body the editor has already rewritten, so a total would measure how many rounds ran
    as much as what the reviewer saw, and the first read is the only one taken on extraction's own
    output. A document the reviewer cleared contributes `0` — that is the observation, not a missing
    one — and the field is `null`, not `0`, when no document in the window recorded a read.
    A feedback re-run (§5) does **not** replace it, unlike every other value in this tally: a
    document-level re-run re-reviews the body already delivered, so its first read is on bytes
    the copy editor has rewritten and would land here as a smaller number for a reason that is
    not the reviewer's. A re-run that re-extracts does replace it, because that read *is* on
    fresh extraction output. One consequence worth knowing when reading this across a model change,
    which is its stated use: a carried-forward count is **re-dated** to the re-run, like every other
    row for that session, so a document converted before the change and given document-level
    feedback after it contributes the old reviewer's number to the new window. The alternative is
    worse — keeping the original date would drop the row out of the window while the document itself
    stays in it, and `first_read.documents` would fall short for a reason that is not a missing
    measurement. `first_read_carried` in the run log (§5) names every document this happened to.
  * `documents` — how many documents recorded a first read, which is the denominator `mean_issues`
    was divided by. Compare it with `documents` at the top of the response: it is the same on a
    window whose runs all pass through the review loop, and short of it otherwise.
  * `unread_documents` — of those, how many had at least one window of that first read come back
    unusable. This is the error bar on `mean_issues` rather than a defect rate: on those documents the
    count is a floor, so a fall in `mean_issues` with this number rising is a reviewer that could not
    answer, and a fall with it flat is a reviewer that found less. Distinct from
    `review_unread_rate` below, which is about the **last** read — the one taken on the bytes that
    shipped. A document can be counted here and not there, and the reverse.
* `unresolved_severity` — how the Reader rated what was left open, one entry per severity and always
  all four including the zeroes. **Per document, and not a partition of `unresolved_rate`**: a
  document with three `low` issues and one `high` is one entry in each of those two, so the counts
  can sum to more than `unresolved_rate × documents`. This is the field that says whether the rate
  above describes a defect — it counts documents that shipped with *anything* open, and `high` is
  the part of it a reader of the document would call a barrier. `unrated` is not a fifth severity
  but the Reader having written something outside the three, or nothing; the severities are
  model-written and unvalidated, so anything unrecognised is bucketed there rather than published
  as found.
* `review_stopped` — which of the review loop's exits ended each document, one entry per reason and
  always all five. Recorded for **every** delivered document, so unlike `unresolved_severity` these
  *are* a partition: on a window where every run recorded one, the counts sum to `documents`.
  `clean` is the only exit that re-read the
  finished document and found nothing. `converged`, `truncated` and `cap` each deliver an
  `@unresolved` list, so those three are the documents `unresolved_rate` counts — in the example
  above, 11 + 2 + 0 of 212, which is the 0.061 beside them. `unread` is the one exit that stops with
  an EMPTY list and is still not clean, which is why it has a rate of its own
  (`review_unread_rate`) and why the document says so under `@review-unread`. Which exit it was is
  which fix is being asked for — `cap` is a config number
  (`defaults.max_review_iterations`), `converged` is a prompt, `truncated` is an output ceiling,
  `unread` is a reviewer that could not read part of what it was judging. The `cap`/`converged`
  split is the one that could not be had before: from outside the loop they are the same shape, and
  only `cap` is something more rounds would help. A sum **below** `documents` means either
  documents delivered before this was recorded or an exit added to the loop with no reason attached
  — never a sixth kind of exit. Where they differ, this breakdown describes the documents it sums
  to and **not** the window: a rate read against `documents` and a split read against the attributed
  subset are two denominators, and the split does not scale up to the rate.
  * **And it is the split of `unresolved_rate` #264 asked for.** That rate counts a document that
    was re-read and still had problems, and a document whose open list may predate the bytes that
    shipped, as the same thing. On `cap` and `converged` the `@unresolved` list was read on the
    delivered bytes — the loop re-reads at the top of every round and both exits are taken before
    the next editor call — so an open issue there is an open issue in the delivered document.
    `truncated` is the one exit where the list may be older than the document: the editor's reply
    was cut off, what the reply had already said and the sectioned retry may between them have
    corrected most of the body afterwards, and the round that would have re-read it is the one that
    could not be made (`src/pipeline/review.ts`). So it over-reports there on purpose, and a
    truncation that rescued nothing over-reports not at
    all — a distinction this tally cannot draw and the delivered document can
    (`@editor-truncated blocks B of T`, `sections N of M`). Those are a claim about the document and a claim about
    the round: read `cap` + `converged` as the part of the rate that is about the document, and
    `truncated` beside `editor_truncated_rate` and the output ceiling. One threshold over both
    cannot be set honestly, which is why the weekly report's is still on the mixture and says so.
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
* `structural_defect_rate` — share of documents that shipped promising a reader something the
  document does not contain: an `aria-labelledby`, `aria-describedby` or `label[for]` naming an
  absent `id`; a `<dl>` with terms and no definitions; or a `<nav>`, `<aside>` or named `<section>`
  holding nothing a reader receives. Three checks under one rate because they fail identically from
  the outside — nothing is malformed, so the gate returns clean and the run reaches
  `ready_for_review` anyway. axe reports the dangling ARIA reference as `incomplete` and never as a
  violation (`aria-valid-attr-value` is `reviewOnFail`), `<dl><div><dt>Term</dt></div></dl>` passes
  `definition-list` outright because the wrapper is legal HTML, and an empty `<nav>` breaks no rule
  at all. Which class fired, and the elements it fired on, are on the deployment's
  `delivered_structure` log line — as is `lang_on_void`, a language tag on an element with no text,
  which is measured there but is deliberately **not** in this rate: it is wasted output rather than
  something a reader loses.
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
  only when someone changes it. One cause of this rate is now prevented rather than reported: an
  attribute name the selector engine cannot compile used to take the whole rule set offline, so the
  lint drops **those** names from its own copy of the document before axe walks it and reports them
  on the line instead (`malformed_attributes_removed`, with `malformed_attributes` counting every
  malformed name whether or not it had to go, and `lint_debris` where there is no `assembly` line —
  #257). A run with `malformed_attributes_removed` set and no `lint_error` is a document that used
  to be delivered unchecked.
* `lint_error_where` — which of the three steps failed on those documents: `parse` (jsdom refused
  the assembled HTML), `inject` (axe's own source would not evaluate, which is a dependency problem
  and cannot depend on the document) or `run` (the rule pass threw while walking the document).
  Always all three entries, including the zeroes, so "measured and none of these" is distinguishable
  from a deployment too old to record it — the same distinction `documents_linted` preserves for the
  rule shares. Published because the per-step detail otherwise exists **only** in one session's run
  log, and a run log cannot answer a question about the deployment: it belongs to a single user's
  document. #263 reported six documents with no verdict and no way to tell whether the cause was the
  one #257 had just fixed or a new one, which is how a fixed cause and a live one come to look the
  same in a weekly report. The counts may sum to **less** than `lint_error_rate × documents`, and the
  shortfall is documents linted before this was recorded — not a fourth kind of failure. The error
  message and stack stay out of this endpoint on purpose: a parse failure quotes the markup it choked
  on, and this response is copied into a public issue.
* `documents_linted` — how many of `documents` the linter actually examined, i.e. `documents` minus
  the `lint_error_rate` ones. This is the denominator for `rules[].share`, and it is published
  because otherwise that share cannot be read: an unexamined document looks exactly like one where
  the rule did not fire, so a spell of failing lints would make every rule appear to be getting
  fixed. When it is well below `documents`, the rule table is a measurement of a subset — fix that
  before reading the rules.
* `editor_truncated_rate` — share of documents where a correction round's **response** hit the
  model's output-token ceiling. The editor answers with the blocks it changed, so its output
  length follows how much of the document is wrong rather than how long the document is (#250);
  what remains is a model that returns more than it was asked for. Under the contract this rate
  was defined against — the whole corrected body, every round — output length followed document
  length alone, so at a large `max_pages` an ordinary document doing exactly what it was told
  could exceed a fixed `max_tokens`. Such a round is not thrown away. What the reply had already
  said is **read**: the contract makes it a list of independent block edits, so every edit that
  finished arriving is applied, and the round covers the document up to the last block it named — or
  up to the first block the reply handed back with less content in it than it had, whichever comes
  first (`editor_salvaged`, `lost_at`). Only the part it never reached, or the part behind that
  block, is asked for again, **a section at a time** —
  cut at top-level boundaries into pieces sized from what the truncated response actually returned —
  and the loop then stops either way. So the document may carry that round's own corrections for
  part of it, section corrections for the rest (from requests that each saw one section, so a
  problem spanning two of them may be untouched), or none at all where neither route worked; the
  delivered `@editor-truncated` comment says which, and `editor_salvaged` / `editor_sections` in the
  run log say how much each covered. This rate counts the ceiling being hit, whatever was rescued afterwards,
  and those documents are also counted in `unresolved_rate` — the issues in the `@unresolved`
  block are the reading that preceded the truncated round and were never looked for again.
  A non-zero value is a statement about the **deployment**, not about the documents: either
  `providers.<name>.max_tokens` is too low for the pages allowed per session, or `max_pages` is
  too high for it. It is deliberately the one rate here with **no threshold** in
  `.github/workflows/quality-report.yml`, and the rate below is why: a reply too long for the
  ceiling is a property of the document and of what the model chose to return, not of whether
  anything was lost, so a rise in it can be a rise in nothing but document length — under the
  whole-body contract it went 1/4 → 2/4 → 3/4 across three bench rounds in which every section
  came back — and an alarm on it would fire on a pipeline that lost nothing (#159).
* `editor_truncated_lost_rate` — share of documents where neither route covered the whole body. The
  reply's own prefix covers the blocks it reached, so what this counts is the **remainder**: a reply
  whose edits list closed, or that named the document's last block, leaves none and costs a reader
  nothing (`editor_salvaged`, `closed`/`reached`) — unless it gave content up on the way, in which
  case the claim was cut back to that block and the remainder starts there however far the reply got
  (`lost_at` on the same line). Where there is a remainder, either the prefix
  itself was refused — the run log says why on an `editor_salvage_declined` line, `reason` one of
  `no_edits_list`, `no_complete_edit`, `unknown_block`, `unreadable_edit`, `out_of_order`,
  `all_refused` or `loss_before_cut` — or the sections over that remainder
  were declined or came back with nothing — an
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
* `editor_headings_gated_rate` — share of documents where at least one correction round had **blocks
  handed back** because applying them would have left the delivered body with **fewer headings than it
  had**, every word still there (`headings_reverted` on an `editor_patch` line, or `discarded:
  "headings_lost"` where the whole round went; #331). The one number in this tally that goes **up**
  when a guard is working: what it counts did not ship, so the document it is counted on kept its
  outline. It is a rate of *attempts*, not of damage, and per
  **document** rather than per round — a document whose editor demotes a heading on three rounds
  counts once, and how many headings each of those rounds would have taken is on that session's run
  log rather than here, deliberately, because a count of a document's own structure is a description
  of the document. Read it against `review_stopped`: gated rounds are retried, so a document can
  carry this signal and still stop at `clean`, and that pairing is this rate working as intended. The
  shape to worry about is a rise in this rate beside a rise in `cap` — an editor demoting headings
  every round, with nothing else in its replies, spends the whole budget and the document is delivered
  as it entered, with its issues in `@unresolved`. That is a statement about `agents/copy-editor.md` or
  the model behind it, not about the budget: raising `max_review_iterations` buys more of the same
  round. A rise with no `cap` beside it is the cheap case — the demoted blocks were handed back and the
  rest of each reply was delivered — and can also be the two known false positives: a heading correctly
  re-expressed as a `<label>`, `<caption>`, `<dt>` or `<th>`, or a reprinted title dropped in a way that
  left the prose no shorter. Neither costs the document its other corrections; each costs the one block
  it happened in, for the round it happened on — with one exception, which is when the re-expression
  lands in a **different** block from the heading it replaces (the stray `<h4>` emptied, the `<label>`
  seated inside the form). Re-seating that block would print those words twice, so that round is refused
  whole and logs `discarded: "headings_lost"` with `headings_dropped` and no `headings_reverted` beside
  it. Until #376 the exception was wider and covered a block that dropped a heading and corrected **any**
  of its own words — a typo fixed in the same `<div>` — which is an ordinary round, moved nothing
  anywhere, and was refused entire. What is read now is where the words went, not whether they changed.

  **What a 0 here does not mean.** It is not evidence that no round demotes a heading, so it is not on
  its own a reason to retire the guard. The guard is on **one of the three paths a reply is applied
  through** — the block patch, where a fall can be attributed to the block that dropped it and that
  block alone handed back. The other two adopt a reply whole: the whole-body branch and each section of
  a sectioned round (the loop's **last** round, so nothing looks at its output again). Both check only
  the size floor, which a demotion cannot move — it keeps every word and grows the bytes — so a
  demotion on either is applied and delivered, and this rate stays 0. That is still true and is now
  **measurable rather than only stated** (#375): both paths compute the same reading and log it as
  `editor_navigation` in §7, refusing nothing, with a line on every delivered reply so the denominator
  is there too. So a 0 here paired with `editor_navigation` lines carrying no `headings` is a guard
  that has nothing to fire on; a 0 here paired with `headings` falls on those lines is a guard looking
  where the demotions are not. Which of the two it is is not answerable from this number, before #375
  or after it — it is answerable from that line, which is the point of having it. **And only where
  there are such lines**: a deployment whose rounds are all block patches writes none at all, and
  their absence is an empty population rather than evidence about the guard — the same mistake as
  reading a 0 here as evidence, one step along. What #375 changed is that the population can be
  collected, not that it has been.
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
  model or its prompt, and the run log's `agentCall` output for that call is where to start. The
  **last** read is the one this counts, because what ships is one reading of the body that shipped;
  `first_read.unread_documents` above is the same failure on the first read, where it is an error bar
  on that read's count rather than a gap in the delivered document's verdict.
* `unfinished_page_rate` — share of documents delivered with a `[page not fully transcribed]` marker
  still in the body, i.e. documents that **could not** have finished the review loop clean whatever
  budget they were given. Not a defect rate of its own: the Reader is instructed to report every one
  of those markers with its page, and nothing in the loop is allowed to resolve one, so each of these
  documents is a guaranteed member of `unresolved_rate`. This is the measured floor under that rate
  — subtract it before asking whether a threshold on it is being met. The cause is upstream of
  everything else here (a page the extractor could not return in full), so a high value is a question
  about extraction and `max_pages` rather than about review.
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

**A placeholder is not a description.** `alt="image"` satisfies every machine-checkable rule
there is — `image-alt` asks whether the attribute is *present* — and it tells a reader who
cannot see the image nothing at all. So a closed list of words that name the medium rather than
the content (`image`, `photo`, `figure`, `logo`, `screenshot`, `placeholder`, `null`, and about
twenty more) is checked against every `alt` on every page, in code, and a page that carries one
is sent back to the page agent with the image and asked to describe it — or to write `alt=""` if
the image carries nothing a reader needs. `page_generic_alt` is the finding,
`page_generic_alt_unrecovered` says the correction did not clear it, and
`extraction_complete.alts_generic` is the count over the fragments the document is assembled
*from*, beside `alts_checked` as its denominator. The delivered bytes are a separate line,
`delivered_alt`, for the reason `delivered_markup` is measured there too: the review loop runs
after extraction and replaces a top-level block's markup wholesale, `<img>` and its `alt`
included, so a copy-edit round that guts an alt ships a placeholder the extraction counts never
saw. It is deliberately **not** a length rule: the shortest alts
this pipeline legitimately writes are `"M"`, `"Home"` and `"Meta"`, all of them logos, where one
word is the correct answer — and `alt=""` is left alone, because an empty alt is a valid
statement that an image is decorative. Measured over 1,064 non-empty alts across 32 bench run
directories, the rule flags nothing the page agents wrote (issue #290). It exists because this
was the one defect class where the only thing watching was the most expensive model in the
deployment: the verifier catches a gutted alt 6 times out of 6, and the cheaper models it may be
swapped for catch it 0–2 times out of 6.

Recovering a link never costs a page its structure, and neither does replacing a placeholder.
When a page passed its fidelity check and is re-rendered only to attach a link or to describe an
image, the rewrite is verified in turn, and one that lost something — a heading level, a
`<th scope>` — is discarded in favour of the fragment that passed, logged as
`page_links_correction_rejected` (`trigger` says which of the two repairs was refused). Both are
local additions; the accessibility of a page that already checked out is not something either
may be paid for with.

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
`editor_truncated_rate`). It comes in three forms, and the difference is what corrections the
document in your hand contains, and which part of it has which kind.
`@editor-truncated blocks B of T` is the commonest: the reply was read as far as it got, so the
first `B` of the document's `T` top-level blocks carry that round's **own** corrections, made by a
call that saw the whole document and the page images. The same comment then says what happened to
the other `T − B` — asked for again a section at a time (`C of N sections`), or not divisible and so
left as they were — and `B` equal to `T` means the reply named its last block before the ceiling cut
it, so nothing was left to ask for at all. `B` is not always where the ceiling stopped the reply:
where the reply's next change would have left a block holding less than it came in with, the claim
stops **there** instead (§0c `editor_salvaged`, `lost_at`), and the comment says so in its own
words — including that a passage moved backwards across that point may now be in the document twice,
which is the trade that rule accepts and the one thing about it a person reading the document can
act on.
`@editor-truncated sections C of N` with no block count means no prefix could be used, so the
**whole** body was re-made a section at a time and `C` of `N` came back corrected; each of those was
made by a request that saw one section and not the rest of the document. Under both, the
`@unresolved` list is the reading that preceded the corrections and was never taken again, so some
of it may already be fixed. The bare `@editor-truncated` means nothing was rescued — the round was
discarded and **none** of the issues below it were worked on. What
`editor_truncated_lost_rate` counts deployment-wide is any part of the document that no editor pass
reached: the bare form, `C` short of `N`, and blocks past `B` that no section covered. A third comment,
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
| `model_call_start` / `model_call` | One completion, from the layer that resolved it: `agent`, `step`, `capability`, `model`, `provider`, and `api` for a provider that has more than one wire format (Bedrock's `invoke` vs `converse`, so a comparison of the two says on every line which side produced its numbers). `step` is the **job** the call was bought for, on both lines, and it is a different question from `agent`: an agent file is a contract and one contract serves several jobs — the Feedback Agent checks a freshly extracted page, re-checks a corrected one, routes a user's feedback and classifies a lesson from it — so the agent name alone cannot price a step, and reading extraction's cost off it understated the step by a third (§7b, which reads these back as `by_step` and lists the closed set of names). It is on the **start** line because that is what an in-flight or hung call is asked about, and on a **failed** line because a call that threw still spent — a truncated editor round paid for a full ceiling of output — and those are exactly the calls with no answer to attribute them by. The start marker is written **before** the call, so a hung or in-flight call is a start with no end; the end line adds `duration_ms`, `ok`, an `error` when it failed, and the token counts flat (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) — taken from the result where there is one, and otherwise from what the adapter reported through a callback as the call ran, so a call that **threw** still says what it spent (§7b reads these back as `tokens`). One line per completion, not per HTTP request. `output_ceiling_clamped: true` says this call ran below the output ceiling the deployment configured, with `output_ceiling_asked` (what `providers.<provider>.max_tokens` says) and `output_ceiling_stated` (what the model grants): several Bedrock models cap output well below 32000 and **refuse** the request rather than clamping it, so the adapter re-sends at the ceiling the rejection names and remembers it (issue #249). Present means a config error is live — the pages arrive, so nothing else downstream shows it, and a deployment can otherwise run for a month at a ceiling nobody chose with a dense page truncating occasionally. Read the pair as the remedy: set `max_tokens` to `output_ceiling_stated`, or route that capability to a model whose ceiling is at least what you asked for. It is on **every** clamped call, not only the one that discovered it, because the adapter's stderr paragraph is said once per process and the remembered ceiling outlives the session — a field that copied that dedup would mark one call in the life of a server and leave every document after the first reading clean. `output_ceiling_refused: true`, present only on the call that paid for the lesson, is what separates the condition from its cost: that line's `duration_ms` covers a rejected round-trip as well as the request that worked. Absent on a deployment whose models accept their ceiling, which is every deployment today. `max_output_tokens` is the opposite direction and is **not** a config problem: a ceiling the caller asked for, below the deployment's, because it already knows roughly how large the answer should be. Present on the page-correction call only (`correctionCeiling` in `src/pipeline/extraction.ts`, issue #285) and absent everywhere else, so a truncation on a line carrying it is the caller's estimate being low and a truncation on a line without it is the deployment's ceiling — the same two remedies the error message itself distinguishes (**Errors** below). It is on the **start** line too, for the same reason `step` is: the calls worth attributing are the ones with no answer to attribute them by. |
| `extraction_start` | The page pass is about to run: `pages`, the `concurrency` it will run them at, and what it will measure while it does — `recheck_sample_size` (`defaults.recheck_sample_size`, the number of corrected pages to be re-verified, 0 for none) with `recheck_thresholds`, the page orders those slots sit on. The two measurement fields are here rather than left implicit because their absence made a log ambiguous three ways: no `page_correction_recheck` in a run can mean the measurement is off, no page needed correcting, or every corrected page falling below the first threshold, and those have different remedies (issue #288). The thresholds are computed from the orders of the pages **this** batch runs, so they say which pages could have answered and not merely how many. |
| `feedback_scoped` | How a feedback re-run was routed (`document` vs `extraction`, and which pages) |
| `first_read_carried` | A document-level feedback re-run kept the document's earlier first-read count for the quality tally instead of recording its own (§0c `first_read`, PRD §7.16 v1.10). `carried` is the number kept, `unread` its window count, and `found` what this round's own first read came to — which is the one this round's `reader` events describe, so without this line a session's log and `/v1/quality` disagree about it with nothing to say why. `carried: null` means the session had no first read on record — one delivered before the field existed — and contributes none. Written on the review-only path only: a re-run that re-extracts reads fresh extraction output and records it. |
| `reextract_start` / `reextract_complete` | Which pages went back to the page agent. `reextract_start` also carries the same `recheck_sample_size` / `recheck_thresholds` pair as `extraction_start`, spread over the pages this round re-extracts rather than over the whole document — a round re-running pages 7, 12 and 20 of 25 has its own thresholds, since bands taken from the document's length would all fall below page 7. `reextract_complete.pages` is what was actually re-extracted; a `failed` list is pages whose re-extraction threw and which therefore kept their **prior** content unchanged. `reextract_complete` also carries `alts_checked` / `alts_generic`, and they are over the **whole** document this round delivers rather than the pages it re-ran — the prior round's pages with the re-extracted ones substituted in — so they are comparable with `extraction_complete`'s and a session's log does not read as its alt corpus shrinking every time a client sends feedback. Comments are stripped before both counts, as on `extraction_complete`. `uncorrected` is over the whole document too, and for the same reason: a round that repairs one rejected page out of three should read as two left rather than as one page re-run. It follows the document page by page — a page re-rendered and now accepted leaves the set, one rejected again stays, one this round never touched keeps the prior round's verdict, and one whose re-extraction **threw** keeps it too, because it is the prior fragment that ships and so the prior verdict that describes it. |
| `page_no_output` | The page agent answered, and no HTML could be read out of the answer (`page`, `image`, `chars` of text, and the `shape` it was in). The page is then lost the way any failed page is lost — the `page_extraction_failed` line below follows it — because "the reply could not be read" and "this text is the page" are different claims, and a reply delivered as content puts a JSON envelope, or an apology, into the document while the run reports every page delivered. `shape` names the remedy: `truncated_envelope` is the output ceiling (raise `providers.*.max_tokens`), `envelope` is a complete reply whose escaping defeated the parser (rare, because a reply whose only fault is the page's own unescaped punctuation is repaired before it reaches here), `prose` is the agent answering conversationally, `empty_html` is an envelope that was read perfectly and carried no page in it (no `html` key at all, or one whose HTML holds nothing a reader receives and whose `log` does not say the page is blank — the model answering with no page and not saying why, or saying it could not read it), and `empty` is a reply with nothing in it at all. "Nothing a reader receives" is not the same as "an empty string": a comment, an empty wrapper and a bare page-break marker are all nothing, and 33 of 818 initial renders in the bench logs answered a blank page in one of those spellings rather than with the empty `html` the prompt asks for (issue #219), so a refused declaration reaches this line whichever way its fragment was written. The last three are prompt problems and say nothing about the parser. A page the agent reports as **blank** is not one of them: that is `page_blank` below and not a failure. Where markup did arrive and carried nothing, `dropped` carries it — the same field, and the same 200-character bound, as on `page_blank` below — because `chars` is the length of the whole reply and not of the fragment, so without it the line says a page produced nothing readable and not whether that was an empty envelope, a comment or a marker naming a folio the paper never printed. On a refused declaration that is the difference between triaging the wording from a run and replaying the replies to find it, which is the half of #219's reconstruction its fix left behind (issue #223). Where the reply *did* claim the page was blank and the claim was refused, more fields say so: `blank_vetoed` lists the doubt words that refused it and `log` carries the agent's own sentence. `blank_stated: true` beside them says the refused claim was made in the `blank` field rather than left to be read out of the sentence, and that pair is the one thing in these logs that can show the field being misused: a page whose log says it could not be read is the one page the prompt tells the model never to send the field for, and a run that carried `blank_stated` only on the line that honoured it could count the field working and not the field failing (issue #371). Without them the line reads as "the model answered with no page", which is the opposite of what happened, and tracing four such pages back to a word meant rerunning the regexes on the replies by hand (issue #190). `blank_contradicted` is the other way a claim made **in prose** is refused — a claim the reply STATED in its `blank` field is not refused for this, and lands on `page_blank` with the same field name and a verify call instead (§7a, issue #371), and a different finding: the log declared the page empty and then said something was on it, and the field carries the words that said so (issue #194). The page's own printed number is the one thing a log may name without contradicting itself (issue #222): a folio is not content that page could have delivered, so `blank apart from the printed page number` and `blank except for its printed folio` are declarations rather than refusals, while `the printed page number and a heading are visible` still refuses — through the heading, which is what a reader would have got nothing of. They are two findings with two remedies — a doubt word means the page could not be read and wants a better scan, a contradiction means the agent answered with no page for a page it says has content on it, which wants a re-extraction — and they are read independently, so a log can carry both: "Page is blank. The scan is blurry. There is handwriting on the page." fills `blank_vetoed` with `blurry` and `blank_contradicted` with `there is handwriting`. On a line with both, the doubt is the one to act on first, because a reply that could not read the page is not a reliable witness to what is on it. |
| `page_bare_html` | The page agent's reply was **markup rather than the envelope**, so the page was rescued from the text as it stood (`page`, `image`, `chars` of the whole reply, `html_chars` of the markup taken from it, and `reextract: true` on a feedback round). The page **shipped**: it is in neither `pages_failed` nor `pages_blank`, the HTML is usable, and that is why the rescue exists. What it did not ship is a `"log"` — there was no field to put one in, and `agents/page.md` asks for that field by name in 26 places, six of which are obligations it discharges there and **nowhere else**: a page ending mid-sentence, a heading with no parent on the page, a symbol with no key, a placeholder image source, a language change, an irregular table. On these pages every one of those is unmet and unreported while the run says every page was delivered. Not rare, which is why it is now a line of its own: 41 of 300 first page calls across two multi-vendor bench rounds and 54 of 400 across four deployed rounds of one PDF (13.7%), and 0 of those 41 left any other line behind. It is also the discriminator between the two readings of an empty log — `log: ""` **with** this line means the reply had no envelope, and without it means the model sent one and left the field empty, which is a prompt-compliance question rather than a parse one and has the opposite remedy. Which of the two the deployed models do is answerable now: over 67 round logs on file, 2,320 `page.md` replies are 2,001 with a non-empty log and 319 bare, and **0** with an envelope whose log is empty. `chars` and `html_chars` are both here because they answer different questions — `chars` is what the reply was billed for and `html_chars` is what the page got, so a rescue that delivered a whole page and one that salvaged a fragment of a truncated reply are otherwise the same event. `reextract` marks the feedback round because the 13.7% is a rate over **first** calls and a count that pools rounds is not comparable with it. The verify step is sent no log section for these pages, and `agents/feedback.md` tells it to say nothing about the absence: that is a fact about the reply, not about the page (issue #349). |
| `page_blank` | The page agent read the page and reported it empty (`page`, `image`, and its own `log` line), so the page is delivered as an empty fragment because there was nothing on it to deliver. That is true of the page as this line records it and not always of the document: since issue #371 one kind of declaration — one **stated** in the `blank` field whose own log names something on the page — is delivered empty and then judged, and a correction it earns can put content back on that page while this line still counts it. The count is kept that way deliberately, because it is the declarations that were made and §7b reads the ones that cost a verify call off it as `pages_blank - pages_skipped_blank`; a page whose content came back that way is the `page_corrected` line beside it, with `trigger: "verify"`. Not a failure and not in `pages_failed`:  the remedies are opposite, since a failed page is work to redo and a blank page is work already finished. The reply that earns this is a complete envelope whose `html` is present and carries **nothing a reader receives** — no visible text, and none of the elements that are content with no text in them (a picture, a grid, a form control) — **and** that says the page is blank — either in the reply's own `"blank": true` field, or, where that field is absent, in a `log` that asserts it in so many words. The field is what the prompt asks for since issue #371, and `blank_stated: true` on this line says the declaration arrived that way: five blank pages had been lost to five different words while the sentence read was being got right — `resolve` (#190), a contradiction that was not one (#194), a negator four tokens behind its noun (#220), `image` (#343), `document` (#367) — and each fix bought the word it was written for, so a reply that can simply state the answer is the one change that is not about a word. The field states and cannot deny: `"blank": false` is read as no answer at all and the sentence decides, exactly as it did for every reply sent before the field existed, so every error the field can make is in one direction. It is read loosely enough for `"true"` as a string and no further — `1`, `"yes"` and `"blank"` are silence, because a field read loosely enough to accept them is one that deletes a page on a typo. And it cannot declare a page blank that came back with a page on it: what a reader receives is decided as below, so a reply that says both things is not a declaration. Present-and-carrying-nothing rather than present-and-empty, because the empty `html` the prompt asks for is not the only way the model writes a blank page: of 78 such replies in 818 initial renders of the bench logs, 33 spelled it in markup — 18 a bare page-break marker, 13 a comment (`<!-- blank page -->`), 2 an empty paragraph — and read as content each of those was a page counted as having produced markup, with the comment or the anchor delivered into the document (issue #219). Prose is content whatever it says, so a reply of `<p>This page is blank.</p>` is delivered as the page's words: a page that *prints* "This page intentionally left blank" has that sentence as its correct transcription, and nothing in the pipeline can tell the two apart. Where the declaration was spelled in markup, `dropped` carries that markup (bounded to 200 characters), because the fragment delivered is `""` whichever spelling arrived and the line would otherwise not say which one did. What `dropped` discards on the marker spelling is a `doc-pagebreak` anchor, and deliberately: every one of those logs says the paper prints no number, which makes the label the image's position in the file and the anchor a claim that the document's page 14 begins there. The test is positive and doubt is fatal: an absent `html` key, an empty one with nothing said about it, one whose `log` says the page could not be *read* (illegible, too dark to resolve, truncated — including a hedge like "appears blank, though the scan is very faint"), and one that describes the **image's** condition rather than the paper's ("the page is very dark and appears empty", "low resolution scan; no text") are all still the model giving up, and stay `page_no_output`. That reply is the one that most needs a human to look at the page, and reading it as a declaration would leave nothing in the document to look at. A blank page whose wording falls outside both patterns is reported as a failed page, which is the safe direction — a page wrongly reported as failed costs a glance, a page wrongly dropped costs the page. One thing is **not** doubt, though: a doubt word used to describe the *marks on an empty sheet* rather than the image. "Specks/dots are visible but do not resolve into any characters", "a few faint specks/artifacts … no legible text" — that is the blank declaration itself, stated positively, and reading `resolve`, `faint` and `noise` there as doubt about the scan cost four blank pages of 100 on one bench round, while an agent that answered "Page is blank." and stopped was believed (issue #190; two pages of one document opened with a verbatim identical sentence and only the one that explained itself was refused). What is exempt is the *phrase* — `faint specks` is the paper, `faint scan` is the image — so a log that describes both in one sentence still refuses: "the scan is blurry, showing only faint specks and no legible text" loses `faint` and keeps `blurry`. It also needs the marks named *as* marks: `stray marks do not resolve into characters` is the paper, while bare `marks do not resolve into characters` is the phrase the page prompt uses for content that could not be read, and a `dark streak`, `dark spot` or `dark shadow` is the capture and can cover content. It reaches across one sentence or semicolon boundary only where the next clause continues the same observation — the marks referred back to, no subject at all, or a denial — so "a few specks of dust are visible. The handwritten note in the corner does not resolve into words" is still a failed page. And a log that says *where* something illegible sits ("not legible printing in the margin") is naming what the page bears rather than denying it, while naming the substrate ("not legible text on the page") is another way of saying the sheet is empty; the whole rest of that statement has to be made of denial for it to count as one, so a word for a place on the paper — `margin`, `header`, `corner`, `seal`, `spine` — refuses whatever punctuation or preposition leads into it, and a name for what the page bears has to be introduced by a denial there (`or content`, `nor any figures`, `no writing`) rather than by a determiner, and not handed on to a verb that says it is there, because "not legible text, only a heading is visible" and "not legible text, and printing on the page is visible" are built from the same words as a denial and say the opposite — while a tail that goes on to deny something else carries verbs of its own ("not legible text or content, and no writing is visible", "…and no printed page number is visible") and is read as the denial it is. The same read applies to "do not resolve into …", one noun further on — that construction's object is what the `do not` denies, and everything after it has to deny too, so "do not resolve into any characters or content" is a blank page and "do not resolve into any characters, only a heading in the margin" is a failed one. And no exemption applies at all to a log that anywhere says the reading failed or hedges the answer (`illegible`, `obscured`, `too dark`, `could not`, `though`), which are claims about the page wherever they sit. The claim is not paid to be checked, and it used to be: the empty fragment went to the Feedback Agent like any other page, which was shown the source image and an empty code block and asked whether the one was faithful to the other. In 36 such judgements — 9 pages of a 100-page corpus, two page-model arms, two shas — it passed every one, for $0.0859 an arm (issue #294), so the call is not made and the page's `page_verify_ok` line says so with `skipped: "blank"` and `unjudged`, with one exception, which is the only spend issue #371 adds: a declaration **stated** in the field whose own log names something on the page is delivered *and* judged. That page carries `blank_contradicted` on this line, no `skipped` on its `page_verify_ok`, and the log's claim is quoted to the verifier in the log's own words beside the empty fragment — so a log that was right about the heading it named buys a correction and the reader gets the page, and a log the regex misread costs a verify call instead of a page. Before the field there were two answers and both were worse: believe the prose and drop the page in silence, or refuse it and report a page nobody has. What it costs is bounded by how rarely the two halves disagree — 1 of the 125 blank declarations in every bench round on disk, off 2,189 page renders — and that one is a page whose log says it is blank three times, refused today by a misread first clause. A declaration made in prose alone is unchanged and still refused on a contradiction (`blank_contradicted` on `page_no_output`), because for a prose declaration refusing remains the cheaper of the two errors available (§7a above, `pages_skipped_blank` in §7b). What still checks the claim are the checks that cost nothing, and they are the ones that can prove it wrong: the veto refuses a hedged declaration before it is ever accepted, whether the reply stated blankness or described it — a page the model says it could not read is not a page it can state anything about, including that it is empty — and the contradiction refuses a self-contradicting one that was described in prose, and a page reported blank whose **source file** carries link annotations for it is a page the document itself contradicts — `page_links_missing` fires on it as on any other page, buys a re-render against the image, and that fragment is verified in turn. What is no longer caught is a *confident* wrong declaration about a page whose file says nothing: it is delivered as an empty page, and this line is the whole of the evidence it leaves. Before this existed, six of 100 bench pages across three of four documents were well-formed envelopes correctly saying the page was blank, and every one shipped a `@page-failed` marker and counted as a lost source page (issue #179). No page-break marker is delivered for a blank page, and the prompt no longer asks for one on such a page whatever the paper prints — it did, which was an instruction the pipeline could not honour once every accepted declaration returned an empty fragment (issue #222) — so a marker that arrives anyway goes to `dropped` with the rest of the fragment rather than into the document. A blank page that did print its folio loses an anchor to a page with nothing to anchor to, which is the cheaper of the two mistakes. A page whose only printed content **is** its folio is one of these pages, and by decision rather than by accident: the folio is never transcribed as text and the marker it may be carried in is never delivered, so such a sheet has nothing on it a reader receives, and a marker-only fragment is not a page. The alternative — delivering a lone `doc-pagebreak` where no declaration was asserted — was refused because that gate also passes a reply whose log says the page's table was too faint to transcribe, which is a page silently dropped while the run reports it delivered, and because every one of the 18 bare markers measured in the corpus carried a label the paper never printed. |
| `page_blank_refused` | A feedback re-extraction declared a page blank that the document already has content for (`page`, `image`, `chars_kept`, the agent's `log`, and `dropped` — the markup the declaration was spelled in, where it was spelled in any), so the declaration is refused and the page keeps that content. `blank_stated: true` is on this line too where the declaration came from the `blank` field, for the same reason as on `page_no_output` above: the field can be sent for a page Iris already holds content for, and a log that recorded the field only where it was believed could not show it (issue #371). The model was shown its own previous output for the page and then said the paper was empty, which contradicts what Iris already holds; the page is then handled as any re-extraction that could not improve it — `page_extraction_failed` with `kept: "prior"`, and the page in `reextract_complete.failed`. Nothing else would catch it: the shrink floor guards the *correction* pass, where the comparison is against that round's own render, so prior → empty never reaches it. That is also why the test is what a reader receives rather than whether `html` is empty — a re-extraction answering `<!-- blank page -->` for a page with content used to walk straight past this refusal and replace the content with the comment, and 13 renders in the bench corpus are that reply (issue #219). A page that was **lost** can still come back blank and be recovered: there is no content to contradict. |
| `page_extraction_failed` | One page's own extraction threw (`page`, `image`, `error`). The rest of the document still ran — see §7c. `kept: "prior"` marks the feedback-re-extraction case, where the page keeps the content it already had and the document stays whole. A **truncation** carries three more fields (#293), the same three as `page_correction_failed` below and for a stronger reason: there the page survives the failure, while here its content is gone, so the excerpt is the only record of what the model had written when the ceiling cut it. `reply_chars` is how far the reply reached, `reply_head` its first 240 characters and `reply_tail` its last 240 — one budget of the user's text, quoted **entire** under `reply_head` when the fragment is shorter than both excerpts together, exactly as on `editor_truncated`. Deployment only: like every excerpt of a document, it stays in the run log and never reaches `GET /v1/quality`. There is no `ceiling` field here because a first pass carries no cap of its own — the ceiling is the deployment's, and the error names it. `truncated: true` with **no** `reply_head` at all is the shape worth watching: a call that spent a whole ceiling of output and never began the page, which is a reasoning model burning the budget before the answer, not a page that needed more room (see §9.3 and `EMPTY_REPLY` in `src/providers/types.ts`). |
| `extraction_complete` | How many page fragments came out (`pages`) and which page numbers failed (`failed`, always present, `[]` on a whole run). `uncorrected` is the other set, and the opposite failure: page numbers the fidelity check **rejected** whose one correction pass repaired nothing, so what the document carries for them is content Iris named a defect in and never fixed (§7c, `@page-uncorrected`, #328). Always present and `[]` where no page shipped that way, for the reason `failed` is — a field that only appears when it fires cannot tell "every rejected page was repaired" from "this run predates the count". Disjoint from `failed` by construction: a page whose render threw never reached a verdict, so it cannot be in this set, and the two counts add rather than overlap. It is the roll-up of what `page_verify_failed` and then `page_correction_failed` or `page_corrected` already say a line at a time — worth having as one field because reading it off those needs a join per page, though the rule is one line: a page whose verdict failed is in this set exactly when its `page_corrected` `result` is **not** `kept` (§7c). `alts_checked` / `alts_generic` are the generic-alt rule over the fragments the document is built from — every non-empty `alt` on an `<img>`, and how many of them are a placeholder rather than a description (#290). Asked **after** any correction, so a non-zero `alts_generic` is a placeholder this step could not repair, which is a different statement from the per-page `page_generic_alt` finding. It is not a statement about the delivered document: the review loop runs afterwards and can replace a block's `<img>` along with its markup, which is what `delivered_alt` is measured on. Both are present at zero on every run, for the same reason `failed` is: a class reported only when it fires cannot distinguish "it never happened" from "the check never ran", and this rule's whole claim is that it fires on nothing the page agents write. `alts_checked` is what makes the zero readable — 0 of 0 says nothing about the rule, 0 of 40 says something. Comments are stripped before either count, as on `page_generic_alt` and `delivered_alt`. |
| `page_generic_alt` | A page described an image with a placeholder instead of a description (`page`, `image`, `alts` — the values as written, duplicates included). Free and exact, run on every page rather than on the ones a sampled verifier looks at, and fed to the same self-correction pass as a dropped link: the fix needs the image, so it needs the page agent. This is not a blind spot being covered — the deployed verifier catches a gutted `alt` 6 times out of 6 — it is a capability being moved off the model's bill, because the cheaper verifiers it may be swapped for catch it 0–2 times out of 6 and `axe` catches it never (#290, #246). The list is closed and matched whole: `alt="logo"` is a finding, `alt="Meta logo"` is not, and `alt=""` is left alone as a valid statement that an image is decorative. Comments are stripped before the scan, here as on `delivered_alt`: an `<img>` a page quoted inside a comment is not an image a reader is offered, and on this path a false finding is not just noise — it buys a rewrite of a page that had nothing wrong with it. |
| `page_generic_alt_unrecovered` | A correction bought for a placeholder `alt` was kept and the placeholder is still there (`page`, `image`, `alts` — the values that remain). The mirror of `page_links_unrecovered`, and the reason a deterministic rule is worth more here than a model that finds the same defect: the check that raised the complaint can be run again on the answer, exactly and for nothing, so "the rule found something" and "the rule got it fixed" are separable at no cost. Only logged where the correction was bought for an alt in the first place. |
| `page_soft_hyphens` | Soft hyphens (U+00AD) were taken out of a page reply before it became markup Iris keeps (`page`, `image`, `removed` — every occurrence, not every word — and `where`: the step whose reply carried them, one of `extract`, `correct`, `specialist`, `specialist_merge`). A word the printing broke across a column, carried into the HTML as an invisible character: `agents/page.md` forbids exactly that, with a worked example, and three models from three labs do it anyway — 63 occurrences on 9 pages of one 100-page arm, reaching 23 of 62 delivered documents, on pages the fidelity check passed (#334). It renders as nothing, so the page reads as clean while find-in-page fails: a reader searching a delivered document for `Insurance` does not match `Insur&shy;ance`, and the words this lands on are table row labels and column headings. The strip is unconditional because there is no output where the character is the right answer — it needs no image, no word list and no second model — and it covers the entity spellings (`&shy;`, `&#173;`, `&#xAD;`) as well as the codepoint, since those render and defeat a search identically. **Logged only where it fired**, so a run with none of these lines is a run in which no reply carried one. `where` is what makes the count attributable: the same character from a first render, from the correction pass and from a specialist are three facts about three different calls. It is written AFTER `agent_call`, so the reply on record in the round logs is still the model's own — the census behind this row was a $0 regrade of logs already on disk, and a strip applied before the log would have left no way to take that measurement or any future one. |
| `page_recovered` | A feedback re-extraction succeeded on a page an earlier run had lost, so the document is whole again for those `pages`. Logged late in the run, once that document has been persisted: a round that re-extracts the page and then throws in review leaves the earlier document — hole and all — as the one the session holds. |
| `extraction_failed` | **No page produced any content**, so the run is ending rather than delivering a document with no words in it (`pages`: how many failed, `blank`: how many were reported blank). With `blank: 0` the `run_failed` line that follows carries the first page's provider error, because that is the diagnosis. Otherwise the source itself was empty — one blank scan uploaded alone, a rasterization that yielded white pages — and the error says how many of its pages were blank, which an empty document could not. |
| `page_verify_ok` / `page_verify_failed` | The Feedback Agent's fidelity verdict on one page, checked against its source image. A failure names its `problems` and buys that page one self-correction pass. A page that passes can still be re-rendered (a dropped link), so a run's `page` call count is `pages + corrections`, not `pages + failures`. A failure also carries `kinds`: the distinct kinds of problem the verdict named, out of `content_missing`, `content_wrong`, `structure_wrong`, `a11y_only` and `alt_quality` (defined in `agents/feedback.md`, in the order the agent is told to prefer them — content that is absent is `content_missing` even though it is also a WCAG failure). It is a **set**, not one label per problem: two missing rows are one page that lost content. Without it a page that lost three table rows and a page whose alt text was refined from "orange kayak" to "orange-yellow kayak" wrote the same line, which made `verify_failed` a count of pages the verifier had an opinion about and nothing more. `untagged` is how many of that page's `problems` — a count of problems, where the diagnostics fold's `untagged_pages` counts pages — carried no kind this version recognizes — an agent file whose VERIFY contract predates the kinds, a session-built or trained one that dropped the field, or a kind the agent invented. Read it beside `kinds` or a split reads as covering pages it never saw. A problem is never dropped for being untagged or unrecognizably shaped: a lost label costs a label, and a lost problem ships the page. A `page_verify_ok` line carries `unjudged: true` when nothing actually judged the page — no Feedback Agent loaded, nothing to verify, a reply that would not parse. Verification is non-blocking, so all three answer "faithful" and the page ships; the field is what separates "the verifier looked and was satisfied" from "nobody looked", which is otherwise the same line. Omitted rather than false on a real verdict, and absent from every log written before it existed. The diagnostics fold counts them as `pages_unjudged`. A fourth case joins those three and is the one that saves money: `skipped: "blank"`, a page the agent declared blank, which is not sent to the verifier at all because an empty fragment has no content to be unfaithful with (issue #294). Not every blank page: a declaration the reply **stated** in its `blank` field whose own log names something on the page is judged, and its line carries no `skipped` at all — it is the one blank page a verdict is bought for, and `blank_contradicted` on its `page_blank` line is why (§7a `page_blank`, issue #371). It carries `unjudged: true` too — both are pages nothing looked at and neither may enter a pass rate — and the extra field is what separates a call that could not be made from one that was not bought, which is the difference between a broken run and a saving. Counted as `pages_skipped_blank`, a subset of `pages_unjudged`. The free checks still run on that page, so a blank page carrying link annotations still fails the link comparison and still buys a correction. A fifth case is `skipped: "error"`, the second value that same distinction always described and nothing had ever emitted: the call that could **not be made**, as against the one that was not bought (issue #364, and `page_verify_error` below for what went wrong). It is `unjudged` too and stays out of every pass rate for the same reason, but it is the opposite of a saving — that page was billed for a full ceiling of output and got no verdict for it — so `pages_skipped_blank` and `pages_verify_error` are counted separately and must not be added. |
| `page_verify_error` | A page's fidelity check could not be obtained: the call was made and the provider errored, was throttled, stalled, or the reply overran its output ceiling. Carries `image`, `page`, the `step` that failed (`verify`, the check that decides whether a correction is bought, or `recheck_binding`, the gate on keeping one), the `error` message, and for a truncation the same evidence `page_correction_failed` carries — `truncated`, `reply_chars`, and both ends of the reply, which is what separates a verifier that needed the room from one that wrote an essay about a page it had already judged. **A verdict that cannot be obtained is not a page that cannot be extracted**, and until issue #364 this pipeline could not say so on the first check: `verifyAgentOutput` is non-blocking for an absent Feedback Agent and for an unparseable reply, but a provider error is rethrown, and that first call had nothing to catch it — so a throttled or over-long *check* propagated out of the page's extraction and shipped a `@page-failed` marker for a page that had rendered fine. Measured once on a 100-page bench arm: a page extracted as 8,855 characters of HTML, a complete statistical table of 568 words, was delivered as a 156-byte comment, and $0.5051 of that page's $0.6634 was the call that deleted it. Three things it cost besides the page, which is why this is its own event rather than a silent `catch`: the delivered document asserted "the source pages above could not be extracted", which was false; `pages_failed` and every triage of *why* pages fail recorded a vision failure, so anyone tuning the page agent on that signal was tuning the wrong agent; and the marker advised raising `providers.*.max_tokens`, which buys the verifier room to write more about a page it has already judged — the wrong lever, pushed the wrong way. The policy it is fixed to is this pipeline's own: a specialist that fails leaves the page as the general pass wrote it, and a fidelity check that cannot run is nothing to correct, so no correction is bought and the page ships as extracted. That matches an unconfigured deployment on any page whose only route to a repair was the verdict, and **not** on a page the link comparison would have repaired: with no Feedback Agent loaded every call site returns a passing unjudged verdict, so a links- or alt-triggered correction reaches the binding recheck and is **kept**, while under a provider failure that recheck throws too and the correction is discarded. A page with a dropped `href` therefore ships without it here and with it there — the discard decision below, stated rather than folded into a claim of equivalence. On `recheck_binding` the line also carries `trigger` and `correction_discarded: true`: that recheck exists to stop a correction bought for one link or one placeholder alt from damaging a page that had already **passed**, so where its verdict cannot be obtained the correction is not kept — no verdict is no licence, and the status quo is a page that passed. The correction is billed either way, and that field is what puts the discard on the record rather than leaving it inferred from an absent rejection line. The third verify call, the sampled recheck, keeps its own older `page_correction_recheck_failed` and is not folded in here: it decides nothing whether it answers or not, and it has been read across rounds under that name. |
| `page_verify_inconsistent` | The verifier **described** a defect and then passed the page (`page`, `image`, `problems`, `kinds`, `untagged`). A verdict's pass/fail is its `faithful` / `accessible` flags, and a correction is bought only when a flag is false **and** a problem is named, so a verdict that names one with both flags true ships the page — and its sentence was not previously anywhere in the log, since `page_verify_ok` carries no `problems`. Calibrating the verifier against injected defects found 3 of 30 damaged pages described in full and passed: a swapped pair of paragraphs quoted back verbatim, an `<h4>` among `<h2>` siblings named as such, `faithful: true` on both. That is most of the gap between what it perceived (28 of 30) and what it flagged (25), and it is a different failure from a verifier that cannot see (issue #210). Written on the FIRST verdict only, the one that decides whether a correction is bought; a recheck's own disagreement is already readable on its line, which carries both `ok` and `problems`. It decides nothing and costs nothing — the page ships exactly as it did — because the fix worth having is kind-gated (a `content_missing`, `content_wrong` or `structure_wrong` problem failing the page whatever the flags say) and pricing that needs this counted over a fleet; failing on any named problem would instead buy a correction round for every `alt_quality` suggestion the same agent is asked to volunteer. The diagnostics fold counts them as `verification.verify_inconsistent`. |
| `page_corrected` | What a self-correction pass did (`trigger`: `verify`, `links`, `alt` or `both`; `problems`: how many it was given; `kinds`: what the verdict said was wrong going in — the same set as `page_verify_failed`'s, and empty on the `links` and `alt` triggers, where the defect was found by code against the file's own annotations or against a closed word list rather than named by the verifier). `both` means **more than one** source, which is what it has always counted: until #290 there were two, so no reading of an older log changes, and it no longer names which pair — `page_links_missing` and `page_generic_alt`, keyed by the same `image`, are where the per-source detail is exact. `result` is `kept` (it changed the delivered document), `rejected` (thrown away in favour of the page it was meant to improve — for **three** reasons, and only two of them have a rejection event: `page_correction_rejected` where the reply came back a fraction of the page's size, `page_links_correction_rejected` where a second verdict named something the rewrite had lost, and — with neither of those beside it — a binding recheck that could not be obtained at all, which logs `page_verify_error` with `correction_discarded: true` and is counted as `rechecks.binding_error`. Anyone triaging a `rejected` by looking only for the first two will find no event for the third, which is why it is named here: the first two are a correction judged and found wanting, and the third was never judged), `identical` (it changed nothing about the page), `empty` (nothing usable came back) or `failed` (the model call threw, so nothing came back at all — see `page_correction_failed`); the last three are calls paid for that bought nothing, and `failed` is the expensive one, since a truncation has already paid for a full ceiling of output. `identical` is decided on the **effect**, not on string identity, so a model that returns its own page re-indented or with `&` for `&amp;` is counted here rather than as `kept`. Note that such a fragment is still **adopted** — what ships is decided on string identity, deliberately, so that a change no signal here observes cannot be silently reverted; `identical` means the page call bought nothing, not that its output was discarded (that is `rejected`). Two shapes of `identical` are worth telling apart, and field presence is what tells them apart: with `chars_before` / `chars_after` and all four flags `false`, the model re-typed the page to no effect; with no sizes and no flags at all, it handed back the exact string it was given. Same bill, different behaviour. When it changed something, `text_changed` / `alt_changed` / `attrs_changed` / `structure_changed` and `chars_before` / `chars_after` say **what** changed — observed on the two fragments, not claimed by the verdict, so an alt-text refinement, a re-typed `href` and a restored table row are distinguishable. `alt_relocated` is on the line only where the correction moved one or more NAMED members from one enumeration in a description into a disjoint one — a state that left `darkest` and entered `cross-hatched` (#355) — and it names them rather than counting them, because a boolean saying something moved somewhere is not a claim anyone can check afterwards. It is not a fifth flag: a relocation is always an `alt_changed` too, and what this adds is what KIND of alt change it was, which the four booleans and the sizes cannot say — that page's line read as an alt refinement, the same bucket as "orange kayak" becoming "orange-yellow kayak", and its two sizes were equal. It takes no view on which of the two replies is right, and it is not a gate: nothing about what ships is decided here. Absent where nothing moved, which is the ordinary case, and absent rather than empty. Its limits are worth knowing before a corpus is counted off it: two lists written as two sentences with no semicolon between them read as one list, a member added or dropped is not a relocation and is reported only by the sizes, a correction that changes how many images a fragment has is skipped, since descriptions are paired by position, and a name whose own words include "and" or "or" is read as one member wherever the list it sits in also uses commas, except as the first half of that list's last item ("Ohio, Health and Human Services and Education"), where nothing in the string says which conjunction is the list's and a member is silently not seen. In a run written with no commas at all the conjunction is the only separator there is, so such a name is split there — which costs the name itself and not its neighbours, since its two halves always travel together. Reading a run-on at all is also what lets a word that is not a name onto the line — "the legend runs pale and light and medium and dark" separates into band words — so an entry here is a **token that changed bucket** and not necessarily a place, and a corpus counted off this field will contain some adjectives. `text_chars_before` / `text_chars_after` are the same two sizes with the markup taken out — how much prose a *reader* receives — which is what separates a correction that added markup to a page that was already complete from one that brought back content the vision pass had dropped. |
| `page_correction_rejected` | A correction came back at less than a quarter of the size of the page it was given (`page`, `image`, `trigger`, `reason: "shrank"`, `chars_before`, `chars_after`), so it was refused and the page it was asked to correct is what ships — paired with `page_corrected` `result: "rejected"`. A correction is single-shot, so what it returns is what the document would keep; a reply this much smaller did not correct that page. Applies on **every** trigger, unlike the links path's own check, and it is decided before either re-verification, so no Feedback Agent call is spent judging a fragment nothing will deliver. In the bench logs the two replies that would have hit this were an agent's scratch template and an abandoned draft, both bound by a parser that took the first `{…}` in a reasoning model's reply rather than the last (issue #170); the parser now reads the right one, and this is the floor under that judgement. |
| `page_correction_failed` | A self-correction's model call threw (`page`, `image`, `trigger`, `problems`, `error`, `truncated`, `ceiling`, `chars_kept`, and on a truncation `reply_chars` / `reply_head` / `reply_tail`), so the page keeps the version it already had — the extraction that succeeded, verified minutes earlier. It costs the **correction**, not the page: before this, the error propagated out of the page's own task and the run logged `page_extraction_failed` and shipped a `@page-failed` marker for a page it still had, which also named a stage that had worked (issue #171). Paired with `page_corrected` `result: "failed"`. Every error class is survivable here, not only a ceiling — a throttle, a stall and a truncation all leave behind a page good enough to have been worth correcting — and nothing is retried, because a correction truncating because the *page* is large will truncate again for a second full ceiling of output. `truncated: true` says the model wrote an essay where a page was asked for, which is worth reading beside `page_verify_failed`'s problem list. `ceiling` is the output ceiling this call **asked for**, which since #285 is usually **this call's own** and not the deployment's: a correction is capped at twice what the first pass of that page spent — scaled up if a specialist handed it a document longer than that pass produced — with a 4,000-token floor (`correctionCeiling` in `src/pipeline/extraction.ts`). So the remedy on a truncated correction is that multiple, not `providers.*.max_tokens` — one uncapped correction ran to 32,000 tokens on a page whose render cost 6,233 and was discarded for being truncated, and the error it raised advised raising the ceiling, which would only have bought a larger discarded reply. It is the number asked for and not the number reached, so it is on **every** failure this line reports and not only a truncation: read it with `truncated`, which says whether the ceiling is what the call died of. A throttle or a stall carries a `ceiling` it never got near. A `ceiling` **larger** than `providers.<provider>.max_tokens` is not a contradiction and is the one case where this field is not what the call asked the provider for: a caller may lower a call's ceiling and never raise it, so the adapter sent the smaller of the two, and a truncation on such a line is the deployment's ceiling — which is what its error message will name. `ceiling` is absent where the call ran uncapped, and the configuration is the remedy again on such a line — but it is two causes, not one, and the *page* tells them apart. Either the first pass reported no token usage, so there was no measurement to take a cap from; or the page rendered **nothing** and was delivered as blank (`page_blank`), whose correction is a re-render of the page from its image rather than an edit of a page, so nothing its first pass spent bounds it (issue #294 — this line is reachable there only on the `links` trigger, and it is the repair that catches a page the source file says was wrongly declared blank, which is why it is not capped at the floor). `chars_kept` is the size of the fragment that ships. On a truncation, three fields say what the reply itself was, which is the evidence `ceiling` only poses a question about (#293): the same cap is either too tight for a page that genuinely needs more room than its first pass took, or exactly right for a model that went on rewriting the page it was given, and nothing else on the line can tell those apart — two truncations at 34,573 and 41,959 characters against pages of 11,908 and 11,456 were argued both ways off the same log, and the round cannot be asked again, because a truncation has already been billed for a full ceiling of output. `reply_chars` is how far the reply reached (the number `editor_truncated` calls `chars`, renamed here because `chars_kept` is on the same line and a bare `chars` would read as the page's own length — read as a ratio against it, those two pages are 2.9x and 3.7x), `reply_head` its first 240 characters and `reply_tail` its last 240, on `editor_truncated`'s terms exactly: whitespace folded, a fragment shorter than both excerpts together quoted **entire** under `reply_head` with no `reply_tail`, and deployment-only — never on `GET /v1/quality`. A tail mid-sentence in content the head has not reached is a page that needed the room; a tail repeating rows already in the head is a model looping. Absent on every other failure, which has no reply to quote, and absent on a truncation that returned nothing at all — `reply_chars: 0` is the zero-character shape §9.3 describes, where raising anything buys a larger burn. On this line uniquely it is `reply_chars` and not the missing `reply_head` that says so: `truncated` here is a predicate over the error's *message*, so it is also true of a truncation whose class was lost crossing a boundary, and such a line carries no `reply_chars` at all. So a bare `truncated: true` is two shapes — a reply of zero characters, or a truncation that arrived without its evidence — and only `reply_chars` separates them. `blocks_named` has no counterpart here: this call is asked for the page's HTML and not for an edits list. The fidelity problems the correction was asked to fix are still unfixed and still on record — keeping the page is not a claim that it was right. |
| `page_correction_no_output` | A self-correction's reply carried no readable HTML (`page`, `image`, `chars`, `shape` — the same shapes as `page_no_output`), so the page keeps the version it had. That version had already passed everything except the fidelity problem the correction was asked to fix, which makes it strictly better than the reply. Paired with `page_corrected` `result: "empty"`, which is the existing record of a correction call that bought nothing; this line says what came back instead. |
| `page_correction_recheck` | A second verdict on a corrected page (`ok`, `problems`), with `problems_before` / `problems_after` — how many **fidelity** problems the page was sent to be corrected with, and how many this verdict names — `kinds_before` / `kinds_after`, the same two sides as kinds, and `links_before` / `alt_before`, the missing links and placeholder alts it was also given. The kinds are what turn "the recheck did not pass" into an answer about the correction: `content_missing` in and `alt_quality` out is a page whose content came back and whose description is now the complaint, while `content_missing` on both sides is a correction that did not do the one thing it was asked to. Both are `ok: false` with the same counts. `binding: true` is the links path re-verifying a rewrite it may discard; `binding: false` is a measurement-only sample, `defaults.recheck_sample_size` pages of the batch (default 1, `0` for none), which changes nothing about what is delivered. The two are counted apart in `verification.rechecks`, and a line with `ok: false` has its `problems` reported there as `rechecks.failures` — **not** in `diagnostics.errors`, which is failures of the run and rendered every one of these `"unknown"` while the diagnosis sat on this line (issue #296). At the default the sample is a **count and not a rate**: one draw per run, so `1 of 1 cleared` is everything it says. Reading a proportion off it is what this field invited and got — four draws split 2/2 quoted as "half", and the same instrument reading 50% on one model's four draws and 25% on another's over one 100-page corpus (issue #288). `sampled_ok / sampled` is a rate over corrected pages only at a size at or above the page count, which is a census and costs one Feedback Agent call per correction; the answer at that setting, replayed off 57 corrected bench pages, is that **26%** of corrected pages clear their recheck against a 2% floor for re-asking about the page as it was — 19 pages better and 2 worse, p = 0.000. Between the two, which pages answer is a deterministic threshold spread across the batch rather than a random draw, and is not evidence that any position is representative: it replaced a rule that handed the slot to whichever corrected page finished **first**, which under concurrency is the front of the batch, and on one 8-run corpus put all 8 slots on six pages of 100. `extraction_start` / `reextract_start` carry `recheck_sample_size` and `recheck_thresholds`, so a log with none of these lines in it says which of three things happened: the measurement is off, no page was corrected, or every correction landed below the first threshold. On a `binding: false` line, read the two counts beside it: a correction pass is single-shot and was never expected to reach zero problems, so five-in-one-out and five-in-five-out are both `ok: false` and only these say which happened. On a `binding: true` line the page had **passed**, so `problems_before` is 0 by construction and a problem named here is a rewrite of a good page that lost something — not a correction that failed to converge. The link and alt shares are carried apart because this verdict judges the fragment against the *image* and names the Feedback Agent's own problems: a link target does not appear in the image at all, and a placeholder alt was found by code rather than by this verdict, so neither could be counted coming out. Folding them in would make a page with one fidelity problem and two gutted alts read as three-in-one-out — a correction that fixed nothing, logged as converging. `page_corrected`'s `problems` is the correction's whole bill, `page_links_unrecovered` says whether the links came back, and `page_generic_alt_unrecovered` answers the alts exactly and for free. Counts, not a diff — deciding whether two of the Feedback Agent's prose descriptions are the same problem is fuzzy matching on model output, so both lists are on the line in full instead. `unjudged: true` marks a recheck nothing judged, on the same terms as `page_verify_ok`: `ok` is also what an unavailable Feedback Agent looks like, and with none loaded every page passes its first check, so every corrected page's recheck is the binding one and every one of them would otherwise read as a rewrite checked and found good. `verification.rechecks.binding_unjudged` and `sampled_unjudged` are those, per population. |
| `page_correction_recheck_failed` | The measurement-only sample could not be taken — the extra Feedback Agent call hit a provider error (`error`). Logged rather than raised: the page ships as it would have with no measurement at all, and the slot this page claimed stays spent, so a throttled provider is not retried once per corrected page — and at a census that is one failed call per correction, not one per run. A `binding` recheck has no such line, because there the verdict decides whether the rewrite is kept. |
| `table_continuations` | The assembled document holds a table whose caption says it continues the one before it: `tables` (how many tables the document has), `pairs` (how many of them are second halves that were located in the source bytes) and `declined` (how many said so and could not be paired). Logged once per run, before any join is attempted, so the ratio is readable on a run whose joins then all failed. A table printed across a page break arrives as two tables with duplicate headers and no connection between them, and no page agent can fix it: each printed page is its own call, so the agent that wrote the second half had one image and the other half was not on it (issue #239). It knew — all 18 continuation captions in the reference corpus say "Continued" — and emitted a fresh `<table>` because there was nothing to append to. `declined` is a fact about the bytes rather than about the model: the pair is found in the DOM and its two source spans are not, which happens when a page delivered an unclosed `<table>` (an unclosed opener swallows the table after it, so the bytes delimit nothing to splice). Those halves ship as they arrived. |
| `table_joined` | Two halves were merged into one table: `by` (`"code"` or `"editor"`, which path produced the merge), the merged `caption`, `rows_first` / `rows_second` / `rows_joined`, `chars_before` / `chars_after` for the two halves against the one table, and — on the editor path only — that editor's own `editor_log`. The merge is not a plain concatenation, because the halves do not always agree on what to concatenate: in the reference corpus two of 18 pairs declare a different column count from their own first half, 13 carry footnote-reference ids in the repeated header block that an endnote links back to, and a bracketed unit note ("[In millions of dollars]") is reprinted with the header and belongs in the joined table once. Where one of those judgements is real the merge is a Copy Editor call (`copy_editor_table_join.md` in the agent ledger); where it is not — three of the editor's six rules are "move these bytes and change nothing" — the merge is made in code and costs nothing, which is 26 of 50 pairs measured out of already-delivered documents (issue #276). Read `by` rather than the agent ledger to split the two: a pair joined in code never reaches the ledger at all, so a run's `table_joined` count and its `copy_editor_table_join.md` call count are different numbers on purpose. What the answer is *checked* for is deterministic and is the reason this line is trustworthy: one table, a caption without the continuation marker, no column lost, the header block still made of `<th>` cells, at least `rows_first + rows_second` rows less one header block and one droppable row — the header credit is the more permissive of two readings, either one shared block (the smaller of the two declared depths) or what the joined table's own depth says went, because neither alone is right on its own: the two halves may declare headers of different depths (4 of the corpus's 18 pairs do, so the smaller depth alone under-credits a merge that kept the deeper block), and reading the drop off the joined table alone charges a merge that PROMOTED the reprinted unit note into `<thead>` for a row that is still in the table. The shared-block reading is available only while the joined header is no deeper than one block plus that one promotable row: past that depth the extra header rows are a block **kept** — the duplicate header repeated mid-table, the state this stage exists to remove — rather than a row promoted, nothing went, and crediting a shared block would let a merge keep that block and drop its worth of unlabelled rows along with it. The two cases are separated to within one row rather than outright — a reply that kept a single duplicated header row is inside the bound and can lose one unlabelled row with it, which is the size of the drop the floor forgives anyway — so what the bound rules out is slack a whole header block deep, and every distinct row label from either half still present as a cell somewhere. Two row checks rather than one, because neither sees what the other does: the label set is blind to a row that has no label (a printed table's multi-line row labels have continuation lines whose first cell is empty), and a count cannot tell a legitimately dropped duplicate from a dropped state. The one row the count forgives is the bracketed unit note a continued page reprints. `rows_joined` under `rows_first + rows_second` is therefore not a defect. |
| `table_join_code_declined` | The merge was tried in code on this pair and stood down, so a Copy Editor call was bought for it: the second half's `caption` and the `reason`. `header_differs` (the second half's header block is not the first half's, so which one describes the joined rows is a reading of the table — 17 of the 50 measured pairs, and the commonest), `id_would_be_lost` (an id on the half being dropped has no free counterpart to move onto: a footnote-reference anchor in the repeated header block, whose cell in the surviving block nothing but a reading can pick, or an id on both halves' own `<caption>` or `<table>` element, where keeping one live target means choosing which — 7 of the 50), `columns_differ` (a row of the continued page is wider than the first half already is, so appending it would put cells under a header block that does not describe them — reached where the continued page reprinted no header at all, which is the case the header comparison above cannot see), `note_repeat_unclear` (the continued page opens with a bracketed unit note the first half does not carry, so it is not the reprint rule 6 licenses dropping), `caption_unclear` / `no_caption_available` (the continuation marker is not wholly inside one text node, so taking it off means rewriting markup; or neither half has a caption, which the verification requires), `content_outside_table` (a half's span parses to something beside its own table — the parser fosters a stray `<p>` out of a `<table>` and the joined table's `outerHTML` would not carry it, which is the one way this path can lose content where a model reply cannot), `id_would_collide` (the join would print one id twice, a defect it would have introduced), `tfoot_no_tbody` (the first half has no `<tbody>` to append to and a `<tfoot>`, so the rows would land after the table's own summary), `unreadable` / `read_failed` (a half no parser could read), or `verify:<reason>` for a code merge the same verification as `table_join_failed` refused. Logged on every pair the code path did not take, because the share it takes is what a later round has to be able to re-measure and `table_joined` alone cannot tell a free join from a paid one. A decline costs nothing: the pair goes to the editor exactly as it did before this path existed. |
| `table_join_failed` | One pair was left as two tables, with `reason`: `unmatched_source` / `not_adjacent` for a pair the source bytes cannot delimit (see `table_continuations`), `declined` for an editor that judged the halves not to be one table, `no_output` for a reply with no HTML in it, `truncated` / `call_failed` for a request that did not come back, `read_failed` for markup no parser could read (with `stage: "body"` when it was the document rather than the reply — jsdom parses by recursion and overflows on a body nested a few hundred thousand levels deep, which is reachable because `anchors.ts` delivers a page past 500 levels as written; the document then ships exactly as it arrived rather than failing the phase, the way the lint one step later reports its own overflow as `@lint-unavailable`), or one of the verification failures — `not_one_table`, `no_caption`, `still_continued`, `columns_lost`, `header_cells_lost` (the merged header block came back as `<td>`, which axe does not report and which would have removed the header association from the one table this stage exists to improve), `rows_lost`, `labels_lost:<n>`. The document keeps **both halves byte for byte**, so every failure here delivers the output the pipeline had before this stage existed, which is what makes the merge safe to ask a model for at all: unlike a correction round, a refusal costs one table's structure and not the document. A pair that failed is not asked again in the same run — the next pass would send the same two tables to the same prompt — so one unjoinable pair does not starve the joinable pair after it. |
| `table_joins_capped` | The document had more continuation pairs than one run will spend requests on (`joined`, `pending`, `max`), and the `pending` ones ship split. Present only when pairs remain. The cap is not a bound anything measured comes near — the worst 25-page chunk of the reference corpus has 7 pairs — and since #276 a pass need not cost anything at all, because a pair the code path takes buys no request. It bounds **passes**, not spend: a body that keeps producing pairs needs something to stop on. Pairs are re-read from the body each pass, which is how a table in three pieces closes: joining the first two leaves a document whose remaining half now follows a joined table. |
| `prose_joined` | A sentence the source printed across a page turn was delivered whole (issue #248). `markers` page-break markers stood between the pages, `candidates` of those turns had the next page opening with a `<p>` that begins with a lowercase letter, `joined` were mended, `unmarked` of the joins had no marker between the halves at all (a page printing no number emits none), and `word_splits` were breaks that fell inside a word. Then one count per refusal: `declined_interrupted` (something other than a paragraph stands between the halves — a footnote list, in all 9 of the reference corpus's cases — so the marker is not what interrupts the sentence; a page that FAILED extraction lands here too, because its fragment is the `@page-failed` comment and that comment is exactly such a node), `declined_not_continuing` (the paragraph before ended a sentence, so the lowercase start after it is something else), `declined_page_gap` (a page between the two returned nothing at all, so the middle of the sentence may be what is missing — the page that came back empty with no marker, #194, which is dropped from the body and then visible only as a hole in the numbering), `declined_no_cut` (the continuing sentence begins inside an inline element that opened earlier, so no cut leaves both halves balanced markup), `declined_attrs_kept` (the whole paragraph would have moved and it carries an attribute the move cannot take with it — `id` above all, which something may refer to), `declined_lang_mismatch` (the two paragraphs disagree about `lang` or `dir`, so the words would arrive in a language nothing said they were in), `declined_as_written` (one of the pages is being shipped byte for byte, `skipped_pages`) and `declined_too_far` (more than 500 characters of text would cross the marker — a paragraph with no sentence boundary in it moves entire, so without the bound a page of unpunctuated prose would deliver its whole text after the *next* page's anchor, which is not the few words the direction below was chosen for). Plus `word_split_examples`, up to five words the break split, cut at 40 characters — text out of the user's own document, so it stays on the deployment and never reaches `GET /v1/quality`. Absent unless at least one turn was a candidate, so a document whose pages happen never to break a sentence adds no line, and `markers` high beside `candidates: 0` is what a caseless script looks like here: the lowercase test is the measured one and has no signal in Hangul, Chinese, Japanese, Arabic or Hebrew, so those sentences ship split. **The words move forward, past the marker**, which is a decision about what a page anchor means and not a detail: the sentence is then whole with `#page-74` standing immediately before it, so a reader following that anchor hears a few words of page 73 first — where pulling the next page's head back instead would land `#page-74` after the sentence it should open on and cost that reader the start of it. A word the printer broke **keeps its hyphen** and is closed up ("Simi-" + "larly" ships as "Simi-larly"), because nothing at this seam can tell a line-fill hyphen from a real one and dropping it would be the one place this pass deleted a character the source printed; `word_splits` is what makes that answerable with data. Deterministic, so no model call is spent on it — unlike the table join, which needs one wherever the two halves' headers disagree about what the table is. |
| `editor_images` | How many source images the Copy Editor received this round (`attached` of `of`, plus `pages`). A `dropped` count means the selection did not fit in one request and was trimmed to the pages issues actually named. `attached == of` on a multi-page document means at least one issue in that round carried no page attribution, so the round asked for everything. |
| `editor_images_refused` | The provider refused the round's payload as too large, so the same prompt was re-sent **without** images. The correction still had the whole body and every issue; only a fidelity problem that must be checked against the source can go unfixed. |
| `editor_fidelity_observed` | The Copy Editor, looking at a page image it was sent for some other reason, says the HTML and the page disagree about something **nobody asked it about**: `count` observations, the `attached` pages it actually had, and the `observations` themselves — each a `page`, a sentence, and one of `page_verify_failed`'s five `kind`s (the same taxonomy, so this can be read against `verify_kinds`; `null` where the reply named a kind this version does not recognize, and the sentence is kept either way). Reported and **not acted on**: acting would mean re-reading that page in full, which is a re-extraction and not this loop's job, and an edit made from one glance at an image reaches a reader as what the page says. So nothing about the delivered document changes because of this line — it is the only trace, and it is addressed to a person. Its value is that it is the **only** second opinion on fidelity in the run: VERIFY checks each page once, with the same model family on the same image as the transcriber, so its blind spots are the transcriber's by construction, and the Reader cannot see the source images at all (issue #183). `unattached` counts observations about a page whose image was **not** in `attached` — the prompt asks for attached pages only, so those are guesses about a page the model could not see, kept but counted apart so a mostly-guesswork set can be discounted whole. `unplaced` counts observations that named no page. Absent on the ordinary round, where the editor noticed nothing. |
| `editor_links_dropped` | An `href` present before that round's correction was missing after it (`iteration`, `hrefs`). A link's target came from the source **file**, not from a page image, so a dropped one cannot be recovered by looking again — logged rather than repaired, and counted into `links_dropped_rate`. |
| `internal_links` | The delivered document contains an in-document reference that lands nowhere (`refs` fragment links in all, of which `empty` are `href="#"` and `dangling` name an `id` the document does not have, plus `ids` — up to 20 of the fragments that failed). Those three are counted per **reference**, so `refs` is the denominator of the other two and one missing section linked forty times is forty references a reader can activate to no effect; `ids` alone is the **distinct** set, because the cap is 20 and one dead target must not spend it. Measured on the bytes actually written, after every rename and every correction round, because that is the only place the question "does this reference land" has a final answer; `@`-comment markers are stripped first, since those quote model prose and an `<a>` inside one is not a link. Absent on a document where every reference resolves. The two shapes are apart because the remedies are: `empty` is a link the page agent wrote knowing it had no target — nothing to rename — while a `dangling` one had a target that moved, was never transcribed, or is in a part of the document this run did not hold. The ids are here and not in `links_unresolved_rate` on purpose: a fragment is text chosen out of the document, so it stays on the deployment while the public tally gets counts only. |
| `delivered_markup` | The delivered document's own structure disagrees with itself (#240): `unbalanced` lists `element open/close` for every element whose end tag HTML **requires** and whose start and end tag counts differ (e.g. `table 16/15`), `tables` and `tables_without_body` count the parsed tables and those holding no row a reader receives as content (no rows at all, none outside a declared `<thead>`, or — with no header block declared — none that is anything but column headers; a body of `<th scope="row">` cells is content), and `empty_table_captions` names up to 10 of those tables. Absent when both are clean. The two halves are one question asked either side of the parser, which is why they share a line: an HTML parser repairs malformed markup before axe is handed the document, so the **bytes** are the only place an unclosed `<table>` is still visible, while a table with no rows is what survives that repair and reaches a reader. `@`-comment markers are stripped before counting, since those quote model prose — with them in, one bench document read `table 25/19` with nothing actually wrong; an unterminated `<!--` is treated as running to the end of the document, which is what a parser does with one. Elements with optional end tags (`li`, `tr`, `td`, `p`, `tbody`, …) are excluded: `<ul><li>a<li>b</ul>` is correct HTML and counting it would bury the real finding. A `parse_error` key means the table half could not be measured at all, so its zeros are not a clean bill of health (#164). |
| `delivered_structure` | Four structural defects in the delivered document that **no rule in the gate reports** (#255), each decidable from the HTML alone: `dangling_idrefs` (an `aria-labelledby`, `aria-describedby` or `<label for>` naming an id that exists nowhere in the joined document), `dl_without_dd` (a `<dl>` holding terms and no definitions), `lang_on_void` (`lang` on an `<img>`, `<hr>`, `<br>`, `<input>` … — an element with no text at all for it to apply to, holding neither a text node nor text in an attribute: HTML scopes `lang` to an element's contents **and** to its text-bearing attributes, so `<img alt="Un graphique" lang="fr">` is correct authoring and is not counted, while the same image with `alt=""` is) and `empty_landmarks` (a `<nav>`, `<aside>`, or NAMED `<section>` with no text and no image, table or form field in it). All four counts appear whenever any of them fired, zeros included — on a line that exists, a zero says that class was looked for in this document and is not in it — plus `dangling_idref_examples`, `dl_without_dd_examples`, `lang_on_void_examples` and `empty_landmark_elements`, up to five instances each, written as `element[attribute=value]` and cut at 40 characters. Absent entirely when all four are clean, which is the ordinary document. Measurement only: nothing is repaired and no run is failed, for the same reason as `delivered_markup` — these are a class worth seeing, not a rate anyone can calibrate yet. Three of the four do reach the deployment-wide tally as `iris:structural-defect`, one row per document however many instances it had, surfaced as `structural_defect_rate` above; `lang_on_void` is left out of it on purpose (wasted output, not something a reader loses), and so are the examples — ids and language tags are text out of the user's own document and stay on the deployment. Why each is here rather than in the lint, measured against this deployment's own axe config: a dead `aria-labelledby` or `aria-describedby` is filed by axe as `incomplete` and never as a violation (`aria-valid-attr-value` is `reviewOnFail`), and a dead `<label for>` reaches the `label` rule only when the input has no other name, so the gate is CLEAN on all three; `definition-list` does report a bare `<dl><dt>Term</dt></dl>`, but HTML allows a `<div>` between a list and its groups and axe passes as soon as one is present, so `<dl><div><dt>Term</dt></div></dl>` lints clean with every definition missing; `lang` is a global attribute, so a `lang` on a void element is legal markup and there is nothing for a rule to fail; and no rule fires on an announced region with nothing in it. The ARIA rule is not promoted into the gate the way `duplicate-id-aria` is, because the rule is wider than the finding — `aria-controls` naming an element that appears on activation is genuinely undecidable statically, and promoting the id would fail runs on it. The scope is the **joined** document, not a page: a page agent writes one page at a time and a reference to an id defined on page 40 is correct in the document those pages assemble into, which is the same reason the issue's `href="#x"` check was left out. An unnamed empty `<section>` is not counted: a `<section>` is exposed as a `region` only with an accessible name, so an unnamed one is a generic container no reader is offered — and a name that resolves to nothing is no name, so `<section aria-labelledby="nope"></section>` is one finding (the dead reference) and not two. A `<main>` a page emitted for itself is deliberately NOT among these: that one is fixed rather than counted (`page_main_stripped`, #251). `parse_error` on the `delivered_markup` line means these four were never measured, so their zeros are not a clean bill of health (#164). |
| `delivered_alt` | A placeholder where a description belongs, in the file the caller receives (#290): `generic` counts the `alt` values that are only a word for the medium (`image`, `photo`, `logo`, `null`, …), `checked` is every non-empty `alt` in the document as the denominator, and `examples` names up to five of the values. Its own line rather than a field on `extraction_complete`, because they answer different questions: that one reads the fragments the document is assembled **from**, and the review loop runs afterwards and replaces a top-level block's markup wholesale — `<img>` and its `alt` included — so a copy-edit round that guts an alt, or writes a placeholder into a block it was patching for another reason, is invisible there and visible here. Absent when there is none, like `delivered_markup` and `delivered_structure`, and for the same reason: the ordinary document needs no line. A missing line still cannot be read as a check that never ran, because `extraction_complete.alts_checked` is on every run whatever it found. Comments are stripped before the scan, exactly as `internal_links` and `delivered_markup` strip them off the same bytes: the `@unresolved` list is model-written prose ABOUT the document and quotes markup freely, so an `<img>` inside one would report a placeholder on a document whose images are all described and inflate `checked` besides. Measurement only — nothing is repaired at delivery, since the repair is to describe the picture and the page agent is the only component holding it, which is what the correction pass (`page_generic_alt`) is for. Nothing here reaches the tally. |
| `editor_markers_changed` | The count of a `[not legible]` or `[page not fully transcribed]` marker changed across one correction round (`iteration`, `before`, `after`, plus `fewer` and/or `more`). `fewer` is expected where the editor read that region off the attached page image, and is a loss anywhere else — nothing downstream can tell those apart, and no other signal sees it at all, since the flattened view strips bracketed tokens before comparing words. `more` is a placeholder written over words the extractor did read, which no instruction in the loop allows. |
| `editor_truncated` | A correction round's response hit the model's output ceiling (`max_tokens`, `chars` returned, plus `attached`/`of` images and `after: "images_refused"` when it was the retry that truncated). The review loop stops after this round either way, but the round itself is not given up on: what the reply already said is read (`editor_salvaged`), and only the part it never reached is re-made a section at a time (`editor_sections` below). The whole ceiling of output was billed, so this is the log's most expensive line. Since #250 the round asks only for the blocks the editor changed, so a ceiling hit here is no longer what a long document costs: it is either a document whose changed blocks really do fill a response, or — read `editor_patch` and `editor_whole_body` on the rounds around it — a model returning the whole document when it was asked for a few blocks of it. **Which of those two it was is on this line** (#277): `reply_head` is the first 240 characters of what the model did emit, `reply_tail` the last 240, and `blocks_named` counts the `"block"` keys it managed. One budget of the user's text, spent one of two ways: a fragment longer than both excerpts together is quoted at each end, and a shorter one is quoted **entire** under `reply_head` with no `reply_tail` at all — rather than reported as a head whose middle and end are missing while `chars` says there was more. `blocks_named` is a count of a key and not a parse, so a document quoting `"block":` in its own text counts its own prose; the excerpts are logged beside the count for that reason and not only for colour. Between them, an `edits` array that genuinely did not fit is distinguishable from a whole document returned out of habit — a block-size problem and a prompt problem respectively. Recorded because the round **cannot be asked again**, so the fragment is the only evidence that will ever exist about why it did not fit, and the round was billed in full; the count is the answer and the excerpts are how a person checks the count. `blocks_named` is also the closest thing here to a prediction of what the next line will say: it counts a key rather than parsing, so it is an upper bound on the edits `editor_salvaged` could recover, and a `blocks_named` well above that line's `edits` means most of the count was the model's own prose or an entry the ceiling cut. This is the user's own document coming back, so like `prose_joined`'s `word_split_examples` it stays in the run log on the deployment and never reaches `GET /v1/quality`, which gets `editor_truncated_rate` and no text. |
| `editor_salvaged` | The truncated reply was read as far as it got, and this is what it turned out to have said (#295). The contract makes the answer a list of independent block edits, so an entry that arrived complete is a whole correction to a whole top-level node: `edits` is how many were used, `applied` how many changed their block, `unchanged` how many named a block and returned it as it was, `refused` how many could not be used (a duplicate, or a replacement that ends inside an element — each costs its own block, exactly as on `editor_patch`), and `markers` / `navigation_lost` read as they do there. `reached` of `of` is the share of the document this covers, and it is the number to read first: the blocks before it carry this round's own corrections, made by a call that saw the whole document and the page images, and the `rest` characters after it are what the section calls are then asked for. `closed: true` says the edits list itself finished — the ceiling was reached on the way *out* of the envelope, in `fidelity_observed` or in trailing prose — so every block was considered, and unless the claim was then cut back (`lost_at` below) `reached` is the whole document and no section call is made at all: the one truncation that costs a reader nothing. `edits: 0` with `closed: true` is that same answer with nothing in it: the list closed **empty**, meaning the editor considered every block and had no change to make, which is a round that converges rather than a round that failed — the document is delivered as it entered, unsectioned, and its marker says it was passed rather than lost. (`edits: 0` cannot appear without `closed`: an unclosed empty list is `no_complete_edit` below, and a list whose every edit was refused is `all_refused`.) `lost_at` and `dropped` are a claim that was **cut back** (#317), and are on the line only when one was: the block the reply emptied or handed back with less content in it than it had, which is where `reached` now stops, and how many of the reply's edits were left unapplied because they named that block or a block behind it. A cut-back claim is the case that used to be refused outright, and the change is a cost decision — refusing it re-requested every block of the document in section calls to avoid applying one edit, which on the round that filed it was 6 and 5 calls at $0.2243 each against replies holding 6 and 7 usable edits. What it trades is named on that issue and in the PRD (§7.11 v1.11): a move carrying content *backwards* leaves it in the document twice rather than losing it — and **that duplicate is delivered**, because a truncated round is the review loop's last round and the section calls see only the remainder, so nothing later in the run removes it (a feedback re-run is the pass that can). Which is why the count is here to be read rather than assumed to be zero: a deployment seeing `lost_at` often is a deployment whose delivered documents may hold duplicated content, and the remedy for the ceiling itself is still `providers.<name>.max_tokens` or fewer pages per session. `lost_at` may appear beside `closed: true`, which reads oddly and is real — the patch was complete and part of it is being re-asked for anyway — and then `rest` is non-zero where a `closed` line otherwise has none. Read `chars` against `editor_truncated`'s `chars` on the line above (they are the same number) and against `blocks_named` there. The waste this line exists to end was the largest measured in the pipeline: 24 truncated editor calls across 10 deployment rounds, $17.23 of a $158.67 bill, every dollar of it on a response nothing looked at. |
| `editor_salvage_declined` | The reply could not be read as a prefix, and why (`reason`): `no_edits_list` (no `edits` array in it at all — the model answered with the document or with prose about it, which is a prompt problem and not evidence this document is too big for its ceiling), `no_complete_edit` (an `edits` array that opened and whose first entry never finished: the contract followed and the ceiling reached inside the *first* block — one enormous table, typically, and the only one of these that says the document cannot be answered whole. An empty list that **closed** is not this and is not a decline at all — see `edits: 0` on `editor_salvaged` above), `unknown_block` (a block number this document does not have, so the reply is not about this document), `unreadable_edit` (an entry whose `block` could not be read, which might have named a block past the cut), `out_of_order` (block numbers that jump backwards, so the blocks *between* two named ones cannot be read as deliberately left alone and the coverage this rests on is not claimable), `all_refused` (every edit read and none usable), `loss_before_cut` (the reply gave content up and there is nothing in front of the loss to keep: `lost_at` names the block it emptied or handed back with less in it than it had, and `lost_at: 0` — the very first block it claimed — is the common shape. A higher one says the same thing about a claim that started later: there was nothing usable in front of that block, either because the reply named no earlier one at all (its first edit was the lossy one, so the blocks in front of it were only ever covered by silence) or because the edits it did name there were themselves refused. This contract makes a *move* a pair of edits, and here the cut **is** a refusal of everything after it, so the source half without its landing half would delete content nothing downstream can miss. A loss with usable edits in front of it is **not** this and is not a decline at all — since #317 the claim is cut back to that block and those edits are applied, which is `lost_at` on `editor_salvaged` above). The counts that decided it are on the line, with `reached` and `of` where they are known — `reached` on a decline is the whole claim the reply made, since nothing was applied and there is no shorter prefix to report. The round then takes the route it took before this existed: the **whole** body, a section at a time (`editor_sections`, with no `covers` field). The last three are the strict ones, and being wrong about them costs a longer route rather than a document. |
| `editor_sections` | A round that could not be answered whole is being re-made a piece at a time: the body was cut into `sections` pieces of at most `budget` characters, sized from the `chars` that response actually returned, and they are corrected `concurrency` at a time. The budget is measured rather than estimated — nothing here is computed until the ceiling has actually been hit — and it is deliberately well under what came back, because a correction adds characters. `covers: "remainder"` says this is the tail of a salvaged round rather than the document: `chars` on such a line is the size of what the reply never reached, not of the body, and the blocks before it are already corrected (`editor_salvaged` above). Absent on the whole-document path, which is what every log before #295 holds. |
| `editor_section_failed` | One section could not be corrected (`section` of `of`, and `reason`: `truncated` or `too_large` for a section whose own response or request did not fit, `no_output` for a reply with no usable HTML in it, `shrank` for one that parsed but came back with under half the section's prose — the same floor the ordinary round applies to the body it assembles, with the same four sizes and `floor` on the line, see `editor_shrank`). A `truncated` section carries the same `reply_head` / `reply_tail` / `blocks_named` as `editor_truncated` above, on the same terms — deployment only, a few hundred characters — with one difference in how to read them: a section round asks for the section's corrected HTML and not for an edits list, so `blocks_named` is 0 on a section that answered the request it was given, and it is `reply_head` that says whether it was. A count above 0 here is not noise but the same prompt problem in its other form — the whole-document contract's shape coming back to a request that never used it. `covers: "remainder"` where the sections are the sections of the **tail** a truncated reply never reached rather than of the document — the same marker `editor_sections` carries, on the same terms, because `section 2 of 3` means two different things without it. That section's **original text** goes back into the document, so the cost is that section and not the round. Anything that is not a size failure — a stall, a stream error, a bad key — is not logged here and still ends the run. |
| `editor_sections_declined` | The round could not be re-made a section at a time, and why (`reason`): `unmeasured` (no character count to size a budget from), `budget_too_small` (the response was cut so early that the sections would be too small to be worth asking about), `budget_exceeds_body` (the response was *longer than the document* — a reply that ran away with itself, so the sections would be one section and the same request), `indivisible` (the piece to correct is over budget and has no top-level boundary to cut at — one enormous table, say), `too_many_sections` (more requests than one round may spend, with `sections`, `max` and `budget`). `covers: "remainder"` means this was the tail of a salvaged round (`editor_salvaged`), and it changes what the line costs: the blocks the reply reached keep their corrections and only the remainder goes uncorrected. `budget_exceeds_body` is not reachable there — a remainder short enough to fit under the budget is *asked for* in one call, because it is strictly smaller than the request that truncated and carries no images, which is the whole of that reason's objection. Without `covers`, the round is discarded as it was before any of this existed: the document that entered it is delivered with that round's issues unresolved. |
| `reader` / `editor` | Per-iteration review-loop progress: the Reader's `issues` count, and whether that round's correction `changed` the document. A round answered piece by piece carries `sections` and `corrected` as well, which is how a log tells one from an ordinary round (`editor_patch`) — and how much of the document the corrections actually reached. On a **salvaged** round it carries `blocks_reached` of `blocks` too (the pair `editor_salvaged` calls `reached` and `of`), and then `covers: "remainder"` beside the section counts, because those sections are the sections of the tail the reply never got to and not of the document (#295): a truncated round that was salvaged and sectioned corrected `blocks_reached` blocks with the whole document in view *and* `corrected` of `sections` pieces of what was left. Without those fields this line — the one a reader greps per round — would read as document-wide coverage on the one round where the section counts are over something smaller. A truncated round that rescued nothing has **no** `editor` line, which is how it is told apart from a round that ran and changed nothing (`review_converged`). `chars_before` / `chars_after` and `text_chars_before` / `text_chars_after` are the size of the body that entered the round and the size of the one that left it, whole and with the markup taken out — the same two readings `page_corrected` carries, so a round and a page correction can be read against each other. What the round produces is adopted for the body **verbatim** — each block the editor returned in place of the one it named, every block it did not name carried across character for character — so without these the body that entered a successful round is gone and the ratio it moved by is unrecoverable: before they existed the distribution of a legitimate round was measurable only on the rounds that FAILED, which is three samples on one document (issue #174). Both pairs, because a length alone cannot say whether a round lost content or lost wrappers: markup-only work leaves the prose pair equal and moves the whole-fragment one, and a round that deleted a paragraph moves both. Both published ranges are whole-fragment ratios, and they are not both this line's quantity: 0.62–2.32 over 265 page corrections is delivered-against-given, as here, while 0.982–0.984 over the three rounds is the *reply* against the body that went in, reconstructed from `agent_call`. This line reports 1.000 for those same three rounds, because a reply with nothing usable in it is a body handed back untouched — so the published span and a fresh one are the same rounds measured two ways. The prose pair is what the floor on this path is read on, and the four rounds that first carried it are what placed the number: they land at 0.997–1.006 of the body they were given, and a reply under half is refused (`editor_shrank`). What the three earlier rounds *do* show beyond length is structure: one of them dropped 5 of 7 lists and 13 of 47 list items while its length moved 1.6%, which is an argument for a structure count rather than for either size — so `structure_before` / `structure_after` carry one, counting headings, paragraphs, lists, items, terms, definitions, tables, captions, rows, header cells, data cells, images and links in the body on each side of the round. Full counts, because a ratio needs its denominator. Grouped, and `h1`-`h6` into one number in particular: the page agent's rules promote a sub-topic the page named, make a printed group label the parent of the cluster under it, and put a procedure's step one level under its heading, so a round that re-levels a section is doing its job and a per-level count would report every one of those as a heading lost. What no rule asks for is a heading that stops existing, which is what this number sees. Since #271 that is acted on and not only counted — on the other line and at a different grain: `editor_patch`'s `navigation_lost` reads the same fold per BLOCK, where the question is whether one replacement gave up its heading, not what proportion of the document's headings are left. That is why a fall can be read there when no ratio can be placed here: a block's heading either survived its rewrite or it did not, and there is no denominator to be wrong about. Read the residual as unwatched, not as covered: a round that rewrote every heading to the *same* level leaves no downward skip, so the re-lint's `heading-order` is silent on it (that rule fires only where a level goes down by more than one), `headings` is unchanged, and the prose pair is equal — every level distinction gone with nothing on the line to say so. Header cells are counted APART from data cells for the same missing-second-opinion reason in the direction that costs nothing: no axe rule fires on a `<th>` demoted to a `<td>`, which is the loss that strips a table's header association from a screen reader, so folding the two would report that round as no structure moved. `<caption>` is counted for the same reason. Wrappers (`<section>`, `<div>`) are not counted, since unwrapping a mis-structured page is one of the corrections this loop is for. Read them knowing which way that evidence points, because the next bench round settled it and it went the other way: on those three rounds the structure counts were already the *less* stable number, moving in both directions on rounds that were working, and the first round to log all three had one turn a 55-item `<dl>` into list items — `terms` 55 → 3, a ratio of 0.055 — while its prose moved 0.3%. So no threshold on a structure count both permits that round and refuses a reply carrying a fifth of the document, and the floor reads the prose pair instead (`editor_shrank`). All three readings stay on the line regardless: two of them are what a person reads once the third has fired. The sizes are the **body**: the wrapper and the `@`-comments after `</main>` are added downstream and are not what any round returned, and they are taken after the deprecated-role strip, so they describe the body that ships. On a sectioned round they are still the whole body's, which is why `sections` on the same line matters to anyone reading them as a distribution: one section's *reply* is a fraction of the body it belongs to (0.016–0.379 on the bench rounds) because it is one section, and a round whose reply carried nothing usable reports equal sizes by construction, with `editor_no_output` beside it to say so. |
| `lint_unavailable` | axe-core could not run on a body no `assembly` line covers, with the same `lint_error` / `lint_error_where` / `lint_error_name` / `lint_error_stack` fields that line carries. `stage: "correction_round"` is the review loop's re-lint of a body an editor round changed, with the `iteration` that produced it; `stage: "feedback_relint"` is a feedback re-run that skipped extraction, where there is no assembly to report one. The document ships with **no accessibility verdict** either way: the loop had no violations to work from, and the delivered HTML says so in an `@lint-unavailable` comment. |
| `lint_debris` | The linted body carried attributes whose **names no valid markup produces**: `malformed_attributes` (how many, exact), `malformed_attributes_removed` (how many of them the lint had to take out of its own copy of the document for axe to run at all — absent when none, which is the ordinary case), and `malformed_attribute_names` (up to three of the names, removed ones first, each cut at 40 characters). The same fields appear on the `assembly` line; this event carries `stage: "correction_round"` (plus `iteration`) or `stage: "feedback_relint"`, matching `lint_unavailable`. Absent when there were none, so a line carrying it means something. These are evidence about a bug **one stage earlier**, not a defect in the document: an attribute named `1\"` is what the HTML parser makes of `aria-label=\"Page 1\"` arriving with its JSON escaping still on it, and the same leak puts `\"doc-pagebreak\"` in a `role` and `\"page-1\"` in an `id` (#233, #234) — an invalid role, a marker that announces the wrong text, and a dead target for every reference to it. Those are findable only by reading the document; this is a number. A removal is not cosmetic: axe escapes an attribute name it builds a selector from, a name beginning with a digit escapes to `\39`, jsdom's selector engine splices the name into JavaScript source where that is an octal escape, and the SyntaxError killed **the entire rule set** — one such attribute anywhere in a 25-page document and there was no verdict on any of it (#257). So `malformed_attributes_removed` on a line is a run that would otherwise have had no verdict on any page. Everything else is counted and **left in place**, because removing an attribute takes the rules that read it away too: a name that lost a quote (`aria-label"Note"`) is reported by `aria-valid-attr` — critical, wcag2a — *because* it is malformed, and removing it turns that document into a clean pass. The document that ships keeps every byte either way, including the removed ones: what the attribute was meant to be is not this stage's to decide. |
| `editor_patch` | What one ordinary correction round's reply actually did to the body, block by block (#250). The editor is shown the body as numbered top-level blocks and answers with the blocks it changed, so this line is the whole accounting: `blocks` in the body, `edits` named in the reply, and how many were `applied`, `deleted` (a block emptied with `"html": ""`) — those four always, so a round that named nothing is still on the record. Then, only when non-zero, what was not used: `unchanged` (a block returned byte-identical to the one it replaces — paid for and delivered as it stood), `unknown` (block numbers that are not in the body: out of range, negative, or not whole), `duplicate` (a second edit for a block already named; the first is kept), `incomplete` (a replacement whose markup does not close what it opens, which is what a reply cut off mid-block looks like), `markers` (`<!-- @block N -->` comments copied back into a replacement and stripped out of it) and `unreadable` (entries in the array that are not an edit at all). Four of those are a **refusal** — `unknown`, `duplicate`, `incomplete`, `unreadable`: that block keeps its original text, and the rest of the reply is still applied. The other two are costs on the record rather than rejections, which is why they are named apart: an `unchanged` block is delivered exactly as it stood, and a stripped `markers` comment leaves a replacement that is then applied like any other. `incomplete` covers both ends of the same question — a replacement that leaves an element open, and one carrying an end tag that closes nothing (`</figure><p>x</p>`, which a parser ignores and which would splice an unbalanced tag into the delivered bytes for `delivered_markup` to report). `shrunk` counts applied replacements carrying less of the document than the block they replace — on the line whenever it happened, because that is one of the ordinary ways this contract removes content the document printed twice. Read as the **prose**, plus the two things a block holds that carry no words — `<img>` and `<a>` — plus one structure count, `headings`. The prose, so that unwrapping a mis-structured block — shorter markup, every word kept — is not counted as content leaving; the images and links because a source block that hands back its figcaption and drops the image is a loss no prose comparison can see, the words being unchanged, and an image with its alt text leaving the deliverable is worse than a sentence and not smaller. Headings for the same reason in the third direction (#271): a heading rewritten as a paragraph of the same words keeps every size on every line equal and takes away the only means a screen-reader user had of finding that content. `h1`-`h6` are folded into one number, so the re-levelling this loop asks for does not move it, and the one heading removal the prompt does sanction — a title the pages reprinted — takes that title's words with it and is already a prose shortfall. Still not every structure count: splitting one paragraph in two, merging two the extractor split across a page turn, or correcting a table's headers (`<td>` → `<th>`, which takes `cells` down by exactly the number corrected) are corrections this loop asks for and each moves a count down while taking nothing out of the document. `navigation_lost` is the same reading at a different grain, widened past the one count that gates to the two that do not: `{ "headings": 1, "items": 2, "rows": 1 }`, how many of each stopped existing, read on the **joined body** rather than block by block and present only where that body's prose did **not** shorten. Two conditions, each doing work. The grain, because a reorder is a pair of edits under this contract — `EDITOR_SYSTEM` sanctions "reorder blocks", so a heading moved down past a paragraph is one block giving it up and another taking it — and a sum of per-block falls would report a document that kept every heading as having lost one. `shrunk` is deliberately the other way round, per block, because its job is to spot the source half of a move so that a refusal on the landing half cannot take the heading with it. The prose condition, because a structure falling alongside a word loss is the ordinary shape of every deletion the prompt sanctions and is already `shrunk`, so counting it here too would put the sanctioned case and the silent one in one number and leave neither readable. At this grain that condition is coarse and knowingly so: one sanctioned deletion anywhere in the reply silences the count for the whole round, so a round that drops a reprinted title in one block and demotes a real heading in another logs nothing here. The alternative is worse rather than better — two headings are gone, one of them legitimately, and nothing in the counts says which — and since this number is a sample used to decide whether `items` and `rows` can gate, a filter that under-collects is right where one that over-collects is not. Since #331 the `headings` half of this reading is no longer only a reading, and that coarseness is what it costs: a body that would have carried fewer headings than the body it was given, with its prose no shorter and nothing refused beside it, has the blocks that dropped them handed back and the rest of the reply applied (`headings_reverted` below), but the round that demotes one real heading *and* drops a reprinted title takes words with it, so nothing appears here and nothing is handed back here. Per-block `shrunk` sees that demotion, and turns it into a refused round only where the same reply also holds a refusal (`refusal_with_loss`) — so the round that is both sanctioned and silent in one reply is still the shape this contract cannot tell apart, and it is the reason the count above under-collects rather than over-collects. `items` and `rows` are reported without gating, because there the content can land in a DIFFERENT structure a reader can still navigate with every word intact — a `<ul>` rewritten as the `<dl>` the page rules ask for takes `items` to 0, and a list mis-extracted as a single-column table, corrected, takes `rows` to 0 — so reading either as a loss would report a working round as damage. A grouped total does not rescue them: summing the list-ish counts makes `<ul>` → `<dl>` rise but makes the measured `runs-231` round (a 55-item `<dl>` rewritten as list items) fall. What would settle it is the rate at which a working round moves them, which no round on file measures, so a line carrying `navigation_lost` with no `shrunk` beside it is that population being collected. That population is now collected on the other two apply paths as well, under its own line (`editor_navigation` below, #375) — this reading was computed here and only here until then, so a rate quoted off this field was a rate over the block-patch rounds alone and did not name that as its population. The evidence for the headings half: 13 of 151 bench rounds lost headings and 5 of those lost no text at all (#271, measured outside this repo in equalify-iris-bench's `editorround.mjs`, run `runs-editor-1`). One case the headings reading counts and should not, named rather than compensated for: `EDITOR_SYSTEM` also sanctions "correct labels and table headers", so a field label the extractor emitted as `<h4>Name</h4>` corrected into a `<label>` inside the same `<form>` block keeps every word and takes `headings` down. Discounting a fall wherever `captions`/`terms`/`header_cells` rose would cover a heading turned into a `<caption>`, a `<dt>` or a `<th>` but not that one, since `<label>` and `<legend>` are not counted at all — so the cost is accepted rather than compensated for, and since #331 it is paid with no refusal needed beside it. That is why what it costs had to come down to one block: the `<form>` block holding the corrected label is handed back with its `<h4>` intact and every other correction in the reply — an alt text, a table header, a split paragraph — is applied and delivered. `editor_headings_gated_rate` in §0c is what says how often it happens. `discarded` names the case where the reply is NOT applied in part, and which of the three it was: `all_refused` (edits were sent and not one could be used), `refusal_with_loss` (a refusal in the same reply as a block that gave content up — `deleted` or `shrunk`) or `headings_lost` (#331: `navigation_lost` on this same line reports a `headings` fall — the body this round would have delivered has fewer headings than the body it was given and its prose is no shorter, with nothing refused anywhere in the reply, which is what the first two need and this one does not — **and** handing back the blocks that dropped them could not be shown to fix it, because the reply also moved a heading somewhere else (`headings_gained`), or a block that dropped one gave content to another edit in the same reply and so could not be handed back (`headings_dropped`), or left nothing to apply once they were handed back; the ordinary heading fall is `headings_reverted`, not this). The second is there because this contract makes a MOVE a pair of edits — the block the content lands in, and the block it came from — so taking the source half and refusing the landing half deletes content that nothing downstream can miss: the size floor cannot see one paragraph, and the next Reader round reads a document that no longer mentions it. Both forms of the source half count, because the prompt offers both ("with what is left of it, or `""` if nothing is"), and the shrinking one is the commoner: a move usually leaves something behind. Either way the body is handed back untouched and the next round is a retry (see `editor_no_output` for why that is not convergence). Each is an ordinary correction on its own, so `refusal_with_loss` fires only on a reply that ALREADY has a defect in it: the cost of being wrong about whether two such edits were really a pair is one round, and the cost of being wrong the other way is in the deliverable. The heading fall is the one that acts on a reply with no defect anywhere in it, and it is the same trade at a finer grain: every edit applied, nothing refused, not a word missing, and the document that would have shipped has lost part of the outline a screen-reader user navigates it by — a barrier of exactly the kind this pipeline exists to remove, introduced by the pipeline. So what is held back is the block, not the round: `headings_reverted` lists, in ascending order, the block numbers whose own heading count fell **and that gave nothing to another edit in the reply**; those blocks keep their original text, the reply is re-applied without them, and the round is delivered with everything else it corrected. A block may only be re-seated when nothing else in the reply is now holding what it held, and that has two failure modes, which are the same hazard from opposite ends. `headings_gained` appears in place of `headings_reverted`, carrying how many headings arrived somewhere they were not, when the thing that moved was a heading — a reply that both moves one and loses one, which this contract sanctions ("reorder blocks") and which moves three blocks' counts for a document that fell by one, so handing all three back would leave the moved heading in two places at once. The other end is the heading's WORDS moving into another block as something no structure count counts: the extractor's stray `<h4>Name</h4>` sibling emptied while `<label for="name">Name</label>` is seated inside the `<form>`, which keeps every word (so the fall reads as ordinary) and gains no heading anywhere (so `headings_gained` is 0). A block that **gave what it lost to another edit in the same reply** is therefore never re-seated: the words it no longer has, or an `<img>` or an `<a>`, turning up where another edit put something new. Where the words WENT, and not whether they changed, which is the narrowing #376 asked for — read as "are these the words it had", a block that demotes a heading and fixes a typo in the same `<div>` was unseatable too, so a reply whose only demotion was that block was refused entire with nothing having moved anywhere. A departure is still an inequality and not a shortfall, because a block can shed the heading's words and grow in the same edit by rewording what survives, and a "did it get shorter" test sees no departure at all. Nor is the re-seat licensed by size, which is the comparison that suggests itself and is refuted by measurement (#376): the re-applied body's prose against the fully patched body's is 34 against 34 on the safe shape and **24 against 59** on the duplication hazard, so `kept <= patched` passes the hazard by a mile — the edit that grew is the one being reverted. Arrivals are counted rather than looked up, and at word grain rather than as text: the landing block may have had the word already, and the words are re-expressed where they land (`Name` seated as `Name:`), so a set comparison or a string comparison would license exactly the re-seat that prints them twice. On those rounds the line carries `headings_dropped` instead: every block whose own heading count fell, which is the reading of what the model did rather than of what could be salvaged — where some of those blocks could have been handed back and were refused with the round anyway, they are named beside it as `headings_abandoned`, so subtracting one from the other leaves the blocks that could not be handed back and the presence of the field is the rate at which refusing the round throws a safe salvage away. A round whose revert left nothing to apply, or did not bring the count back, is also refused — the re-check is fail-closed, and it is read **per block** rather than on the joined body, which is the one place in this reading where the grain has to be the other way round. Only the blocks that could be handed back were, so a block that dropped a heading *and* gave its content to another edit keeps its edit and keeps its fall: one reply that demotes in two places — one of them the `<label>` migration — lands there, and it is the case above reached from the other side, so it logs `headings_dropped` like the other. The joined reading cannot be the test here, because it is silent wherever the body it reads is shorter in prose and **the revert is itself an edit that can get under that floor** — hand back the block that added prose and the re-applied body can be shorter than the one that came in, so a fall that was visible before the revert reports nothing after it, and the held block's demotion would ship (found in review of #376). `headings_recheck: true` is beside `headings_dropped` only where the joined body lost a heading and NO block still dropping one accounts for it, which is unreachable by construction — the joined count is the sum of the blocks' own — so its firing at all is the finding. All of them log `discarded: "headings_lost"` and hand the body back untouched for a retry, and which of the three it was is readable from the line: `headings_gained` (a heading moved), `headings_dropped` (its words moved), or `headings_reverted` present beside `discarded` (blocks were handed back and nothing was left to apply). The first two are mutually exclusive on a line. What the reading can be wrong about is a heading correctly re-expressed as something this count does not count (the `<label>` case above, or a reprinted title dropped in a way that left the prose no shorter), and being wrong now costs that one block on that one round rather than every other correction in the reply — which is the principle `applyBlockEdits` is built on, that an unusable edit costs the block it was about and not the document's corrections, and a gate is not exempt from it. An editor that demotes on every round therefore still delivers what it corrected on the way, round after round, instead of spending `max_review_iterations` re-sending the same body and shipping the document as it entered with its issues in `@unresolved` (`stopped_at: "cap"`) — and the run log names the held-back blocks round by round, which is a statement about the prompt or the model. What #331 asked for and this deliberately does NOT do is the narrower predicate — refuse the fall only in a block no reported issue asked about — because `ReviewIssue` attributes an issue to the source **pages** it was found on and nothing binds an edit's block to the issue it answers, so that reading is not available to write. The counters are the point of the design: the failure this contract could have had is a replacement landing on the wrong block, which is well-formed markup in the wrong place and invisible to everything downstream, so the block number is written above each block for the model to copy rather than counted by it, and every number that does not resolve is reported here instead of being guessed at. |
| `editor_whole_body` | The reply carried no `edits` array but did carry an `html` string, so the round was read as the whole corrected body — the contract every round used before #250 (`blocks` in the body it was given, `chars` in the reply). Accepted rather than refused because refusing it spends the round, and on a model that falls back to a familiar shape under load it would spend every round of the run; a whole body arriving this way goes through the same `editor_shrank` check it always did. It costs one thing the old contract could not, and `markers` is that cost measured: the document this model was SHOWN carries a `<!-- @block N -->` line above every top-level element, so the likeliest whole-body reply is that document retyped, markers and all. They are stripped before the body is taken and counted here. Adopting them would write Iris's own request scaffolding into the delivered HTML, and it compounds — a comment is a top-level node, so the next round would be shown the markers as blocks in their own right, the body would double every round, and a document that never stops changing never converges. A run where this line appears on most rounds is a model not following the block contract, which is worth knowing about a deployment even though the document is fine. |
| `editor_no_output` | The Copy Editor's reply carried no usable body (`chars` of text came back), so the round kept the document it was given. A call paid for and nothing said — which is why it does not end the loop: the next round is a retry, not a repeat. |
| `editor_shrank` | The body a correction round produced came back with **less than half the prose** of the one it was given, so it was refused and the round kept the body it was given (`chars_before`/`chars_after`, `text_chars_before`/`text_chars_after`, and the `floor` divisor). `stage: "patch"` is the ordinary round, measured on the **joined** body rather than on the reply — the reply is a few blocks, and the question this floor asks is about the document those blocks assemble into — and it carries `deleted` and `shrunk` of `of` beside the sizes, because that is what a shrink under the block contract is made of: blocks emptied with `"html": ""`, and blocks returned with less in them than they had, in a reply where each edit on its own was well-formed. Both, because this path is only reached when nothing was refused — a refusal beside a block that gave content up is `discarded` on `editor_patch` before the floor is read — so the commonest reply that lands here empties nothing and returns blocks holding a fifth of their prose, and `deleted: 0` alone would say nothing about where the document went. With no `stage` the round returned a whole body, where the model's `html` is adopted for the document with nothing compared against what went in and the blast radius is the deliverable — a reply that answered about one section, or summarised, or quoted the contract back after answering, arrives shaped like a corrected document (issue #174). Reported the same way as `editor_no_output` and for the same reason: nothing came back that can be used as *this* document, so the next round is a retry rather than a repeat and this is not a `review_converged`. Read on the **prose**, not on the characters and not on the structure counts, because only the prose pair is stable on a legitimate round: the four rounds that record all three readings land within 0.6% of their input on it, while unwrapping a mis-structured document keeps every word and loses half the bytes, and one of those rounds rewrote a 55-item `<dl>` into list items — a ratio of 0.055 on `terms` — while its prose moved 0.3%. Bodies with under 1,000 characters of prose are not judged at all: the legitimate deletions are fixed-size (a `[page not fully transcribed]` marker is 28 characters, a duplicated heading 20–60), so on a short body the floor would fire on the editor doing its job. |
| `editor_navigation` | The structures a reader navigates by, counted on a reply that was **adopted**, for the two apply paths that do not gate on the count (#375). `stage: "whole_body"` is the pre-#250 contract's reply taken as the whole corrected document (`editor_whole_body` above); `stage: "section"` is one section of a sectioned round, with `section` of `of` — and `covers: "remainder"` where those are the sections of the **tail** a truncated reply never reached rather than of the document (`editor_sections`, `editor_section_failed`, and `editor_salvaged`'s `covers` are the same marker; a rate grouped per round off a line without it would read `of: 3` as "the document was cut in three"). The reading is `navigation_lost` on `editor_patch`, and until #375 it was computed there and nowhere else — so a `<h2>` rewritten as `<p><strong>` fell silently on both of these paths, and the only check either had cannot see it by construction: `editor_shrank`'s floor is a prose floor at half the document, and a demotion keeps every word and grows the bytes. On the sectioned path that matters most, because a sectioned round is the loop's **last** round (`editor_sections`), so what falls there ships with no retry behind it. **Nothing is refused on this line, and that is deliberate rather than pending.** #331's remedy is a block handed back, and neither path has blocks: a whole-body reply is one string and a section reply *is* the section, so the only refusal expressible is the whole thing — which is what #331 did in its first version on the patch path and what it was changed away from, because on the commonest false positive (a stray `<h4>Name</h4>` corrected into the `<label>` axe's `label` rule asks for) it threw away every other correction in the reply, every round, until the budget ran out. Doing that here would be worse: it would cost a whole section's corrections, on the round that has no successor. What has to come first is the rate, and this line is the rate. **It prints on every delivered reply**, counts or no counts, because a rate needs its denominator on the record and a line that appeared only when something fell could not tell a round nothing fell on from a round that never took this path — so a clean whole-body round is `{"stage": "whole_body"}` and that is a row in the denominator. `headings`, `items` and `rows` appear only where each fell, and only where the reply's prose did **not** shorten; where it did, `shortened: true` is on the line **instead** of the counts, because the reading is silenced there — a deletion the prompt sanctions takes its own words with it, which is the ordinary shape of a correction rather than damage — and an empty reading would otherwise read as "nothing fell" when it means "not asked". The grain is the unit the reply was about, so the sectioned path reads each section rather than the joined body. That is sound here and finer than the patch path can manage: sections are corrected independently and joined, so no heading can move *between* them, and the reorder hazard that forces `navigation_lost` to be read on a whole body does not exist. It is also cheaper in the one way the patch path's grain is expensive — there, one sanctioned deletion anywhere in a reply silences the reading for the whole round; here it silences that section, so a demotion in section 3 is still on the record. Not folded into `editor_headings_gated_rate` in §0c: that rate counts documents where something **was** handed back, and adding rounds where nothing was would make a signal about a working guard into a mixture of that and a reading nobody acted on. |
| `deprecated_roles_stripped` | A deprecated ARIA role was removed from an element whose own role already said it — `roles` (the set) and `nodes` (how many attributes went), with `stage: "assembly"` for what extraction produced, `stage: "correction_round"` plus `iteration` for what an editor round introduced, or `stage: "feedback_prior_body"` for one already in a stored body that a feedback re-run picked up without re-extracting. ARIA deprecates exactly three roles — `directory`, `doc-biblioentry`, `doc-endnote` — all folded into list semantics, so an `<li role="doc-endnote">` inside an `<ol>` is announced identically without it and axe's `aria-deprecated-role` has nothing left to report. **This line is the only trace.** The delivered document is clean and the lint that would have named the role now finds nothing, so a run log with this line in it is the page agent's FOOTNOTES rule not being followed (`stage: "assembly"`) or the Copy Editor introducing markup nobody asked for (`stage: "correction_round"`) — which is how issue #187 shipped: axe reported the role, the editor was told, it rewrote five sections, and the role survived. The strip is deliberately narrow: the role is removed only where the host element already provides it, so a `<div role="doc-endnote">` is left to fail the gate, because deleting it there would leave nothing marking the element as a note at all and the remedy is to make it a list item. **The host table is not the only thing that narrows it**: it shares its attribute locator with the row below, so the shape that row declines to edit — a `role` whose unquoted value runs into a quote — is declined here too, and a **repeated** `role` is handled here the same way, by emptying the attribute rather than deleting it so the second copy cannot be promoted. Both are set out in that row. |
| `invalid_roles_stripped` | A `role` naming something that is **not an ARIA role at all** was removed — `roles` (the set, spelled as the document spelled them) and `nodes` (how many elements were edited), with the same three `stage` values as `deprecated_roles_stripped`. The case this was built for is `role="doc-footnotes"`, which does not exist: DPUB defines `doc-footnote` for one note and `doc-endnotes` for a collection, and never a plural of the first, so a model following the footnote rule generalises from the `doc-endnotes` example beside it and invents the name. axe reports that as `aria-roles` at **critical** — the most severe thing this gate says about any document Iris produces — and it has reached a delivered `output.html`, on a round where the lint had degraded to *did not run*. **This line is the only trace**, on the same argument as the row above, and it is the harder evidence of the two: `doc-endnotes` is a real role reached for in the wrong place, while a name like `doc-footnotes` was never in any specification. Unlike the deprecated strip this one is not narrow, and does not need to be — assistive technology already ignores an invalid role and announces the element's own, which is exactly what it announces with the attribute gone, so no element can lose anything by the removal. **That argument holds of a role token and of nothing else, so the attribute has to be located as a parser locates it** — by walking the start tag's attributes as `name(=value)?` pairs — and not by searching the tag for something shaped like `role=`. A search matches inside another attribute's *value*, and the values on these elements are prose: an `alt` reading "each user and role = admin, editor or viewer" put `admin,` where a role name goes and the word was cut out of the accessible name. Nothing can report that loss — the name is still non-empty and not generic, so the gate sees a clean element — and this very line would have named the eaten word as an invented role, blaming the page agent for it. The row above shares the locator and was reachable the same way, on `<ul aria-label="the role=directory column">`, because `directory` is an ordinary English word and `<ul>` is one of its hosts. What the removal does not do is NAME the block: a stripped `<section role="doc-footnotes">` is an anonymous `<section>`, which is compliant, and the page agent's FOOTNOTES rule is the half that says what to write instead (`<aside>`, `<footer>`, a bare `<ol>`, or `<section aria-label="Footnotes">`). Which names count as real is asked of axe rather than listed in Iris, so this strip and the gate are one judgement, and asked case-folded, because the rule folds a role token and the underlying predicate does not — `role="DOC-ENDNOTES"` is a document the gate passes and is left alone. **One shape is declined rather than stripped**, and there the document is passed through untouched and the gate goes on reporting the role: a `role` whose unquoted value runs into a quote, which is what the JSON-escaping leak (`<hr role=\"doc-pagebreak\" …>`) delivers. Editing that would cut one character out of the middle of an attribute; `lint`'s `malformed_attributes` still counts and names the debris. **A second shape is edited but not deleted: a repeated `role`, where the attribute is left in place with an empty value.** Deleting it would *promote the second copy* — `<div role="doc-footnotes" role="main">` computes to generic today, since the parser keeps the invalid first value and discards the duplicate, and deleting the attribute would leave `<div role="main">`, an element handed a landmark it never had (`aria-roles` at critical traded for `landmark-main-is-top-level` and `landmark-no-duplicate-main`). A removal that puts the next attribute into effect is not the removal this row's argument is about. `role=""` avoids it without giving the strip up: ARIA treats a value with no valid token as no role at all, so the element computes to exactly what it computed to before and the gate reads it clean, while the attribute stays in the position the parser reads. Measured on all four shapes rather than argued, including `<ol><li role="doc-endnote" role="listitem">` and `<ul role="directory" role="list">`, which the row above delivers clean by the same mechanism. |
| `page_main_stripped` | A `<main>` a page emitted for its own content was taken out of the body, because `wrapDocument` puts the assembled body inside one and a `main` inside a `main` takes away the landmark a screen-reader user jumps to in order to skip the furniture (issue #251, 18% of page answers). `unwrapped` (a bare `<main>`, tags removed and children promoted), `downgraded` (one carrying attributes, rewritten to a `<div>` keeping them, since unwrapping it would drop the `lang` the document's root declaration is derived from or an `id` an `href` elsewhere resolves to) `dropped` (a stray `</main>` closing nothing, deleted) and `declined` (a `<main>` nothing closed, left in place), with the same three `stage` values as `deprecated_roles_stripped`. **This line is the only trace of the first three counts**, exactly as with the role strip: the delivered document is clean, and a run log with this line in it is the page contract's shell sentence not being followed (`stage: "assembly"`) or the Copy Editor supplying a wrapper it was told not to (`stage: "correction_round"`). `declined` is the one that ships: the element's extent is whatever the parser decides, so there is no correct edit for an unclosed `<main>`, and `landmark-no-duplicate-main`/`landmark-main-is-top-level` report it in the gate. The unpaired END tag is not left, for the reason that reverses: a parser discards it, so nothing is being weighed — and it is the one shape no rule reports, because inside the shell it closes the document's own `<main>` early and every element after it is delivered outside the landmark with the lint clean. That escape predates this rewrite; what would be new is a `declined` count promising a violation nobody can find. A `role="main"` on an element that was never a `<main>` is not counted here at all and goes straight to the gate, for the reason the role strip stays narrow. |
| `page_markers` | Page-break markers were checked against the document's own numbering, and any label naming the **position of the image in the file** instead of the number the page prints was removed (issue #333). `markers` found, `readable` (labels that parse as a numeral), `unreadable` (a sectioned folio — `A-3`, `M-16` — plus markers carrying no label at all), `systems` (one entry per numbering system that produced at least three markers, `arabic: offset -11 on 22 of 23` where an offset was acted on, or one of the two ways nothing was: `arabic: no offset holds 8 markers (best: 3)` where no offset held both a run of three and a majority, and `arabic: offset 0 on 8 of 10, 8 of them repeating their own filename` where the check refused this document), `stripped` (one entry per label removed, `page 52: "Page 52" → 38`, cut at 40 characters, with the derived folio omitted where the derivation computes below 1), `departures` (the shape those removals form, one entry per offset they sat at — `arabic: 1 removed at offset -50, page 2` against `arabic: 6 removed at offset 0, pages 1-6 (every marker in that span)`), `off_mode`, `undecided`, `unchecked`, and `stage: "assembly"`. **The number is checkable because Iris supplied it**: the page agent is handed `filename: acir-p052.png, page 2 of 25`, so a leak can only be one of two numbers, and the one tested is the FILENAME's — its **last integer**, which is the part Iris writes. A label is touched only when it repeats that number, AND its numbering system's own modal offset says the folio is something else, AND the markers holding that offset do not repeat their own filenames. The last integer and not every integer, because `<base>-p<N>.png` takes `<base>` from the uploaded file's own name: a check reading all of them finds the label `Page 1` written in `volume-1-p13.png` and takes a true page number off a document whose only distinction was being called `volume-1.pdf`. The third condition is what a document is refused on — where the honest majority repeats its own filenames, a label repeating its filename is the shape of a CORRECT label there and the test carries no information, which covers both a caller who names images after the printed folios and a plain report whose sheets really do print their own submitted positions. Three markers to ask and three agreeing to act are also different gates: a strict majority of three markers is two, so without the second `Page 1` and `Page 2` would hold an offset and delete `Page 9`'s number, and the smallest document that can lose a label carries four markers. The other half, `page N of M`, is deliberately not tested: replayed over 61 chunks of paid rounds this removed 29 labels, all 29 repeating the filename, and the only label that ever matched the position alone was CORRECT — a round re-submitting a non-contiguous subset of a rendered document, where the sheet printing `iv` happened to arrive 4th. Where Iris rasterizes a whole PDF itself the two numbers are the same one anyway (`<base>-p<N>.png`), so what is uncovered is a caller uploading images whose names carry no position — counted as `unchecked`, since a marker with no number to check against is not one this agreed with. Roman and arabic are counted apart, because a document with both has two offsets and a pooled reading would both exempt a `Page xv` leak and read correct front matter as a departure. **The label is removed, not corrected, and the `id` stays.** The derived folio is right where it can be checked — the four it named on the reference corpus are the four read off the scans — but delivering it would have Iris assert a number nobody saw printed, on a page whose own model just proved it was guessing, so it is logged and not shipped; and taking out `id="page-52"` would turn a `#page-52` reference that lands on the wrong sheet today into one that lands nowhere. Every copy of the attribute goes, not the one a parser keeps, since deleting the first would promote a repeated `aria-label` into its place and leave the line claiming a removal the page did not get. What is left is a break saying only that something ended, which is what the page contract prescribes for a page whose number is not known. **This line prints on clean documents too**, unlike `assembly_anchors` above: `stripped: []` beside `arabic: offset 14 on 23 of 25` is a document this checked and agreed with, while no line at all is one it could not decide, and a round measuring whether the defect is fixed cannot tell those apart from silence. `off_mode` counts readable labels that disagree with their system's offset and were left alone because they repeat no positional number — a page printing `ix` labelled `Page 9` — and `undecided` counts labels that do repeat one where nothing could be concluded — too few markers, no offset holding a run of them, or a document refused above — which is this check's blind spot with a size on it, and `unchecked` counts readable labels on a page whose filename carries no number at all, so that `readable: 25, stripped: []` cannot read as agreement when nothing could be checked. Three more blind spots, each of which reads as a clean document: a model that leaks on EVERY page (which is the same input as a report printing its own positions, so the document is refused and the log says so); a document whose arabic numbering restarts partway through, where the minority run's folios coincide with the numbers in their filenames while the majority's do not — an active removal of true labels rather than a missed leak, which is why `departures` is logged: a restart takes out a block of consecutive positions with no surviving label among them, a leak is interleaved with the labels that contradict it, and the check cannot act on that difference but a round can count it; and a positional number announced through `aria-labelledby` instead, which is not read — #333's shape is `aria-label` on both failing arms, and resolving an ID reference into another element's text is a different pass on a different input. `stage` is only ever `"assembly"` — unlike the role strips above, this cannot run on a corrected body, because deriving an offset needs every page's filename and position and by then there is one string with the pages' provenance spent, so a marker the Copy Editor introduces later is not reached. Measured cause, and why this is code and not more prose: `agents/page.md` forbids exactly this by name (`never the position of the image you were given in the file`) at every prompt blob there is a round for, and two of three vendors did it anyway on the same document and the same blob — 6 of 88 markers on the shipped page model, 5 of 90 on another, on the same two pages. The labels are text out of the user's own document, so like `prose_joined`'s `word_split_examples` this line stays in the run log on the deployment and never reaches `GET /v1/quality`. |
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
    "agent": "table", "step": "specialist", "model": "us.anthropic.claude-sonnet-4-6",
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
    "cache_read_input_tokens": 2500, "cache_creation_input_tokens": 2500,
    "models": ["us.anthropic.claude-sonnet-4-6"] } },
  "by_step": { "extract": { "count": 2, "total_ms": 28200, "max_ms": 15100,
    "input_tokens": 16400, "output_tokens": 9100,
    "cache_read_input_tokens": 2500, "cache_creation_input_tokens": 2500,
    "models": ["us.anthropic.claude-sonnet-4-6"] } },
  "slowest_calls": [ { "agent": "table", "step": "specialist", "model": "...", "capability": "vision", "duration_ms": 14300, "ok": true } ],
  "errors": [],
  "verification": {
    "pages_verified": 25, "pages_unjudged": 3, "pages_skipped_blank": 2, "pages_verify_error": 1,
    "verify_failed": 13, "corrections": 14,
    "verify_kinds": { "content_missing": 5, "content_wrong": 2, "structure_wrong": 6,
                      "a11y_only": 3, "alt_quality": 4, "untagged_pages": 1 },
    "verify_untagged_problems": 2,
    "verify_inconsistent": { "pages": 3, "content_missing": 0, "content_wrong": 1,
                             "structure_wrong": 1, "a11y_only": 0, "alt_quality": 1,
                             "content_or_structure": 2, "undecided_pages": 1 },
    "results": { "kept": 12, "rejected": 0, "identical": 2, "empty": 0, "failed": 0 },
    "triggers": { "verify": 13, "links": 1, "alt": 0, "both": 0 },
    "effects": { "alt_only": 4, "text": 8, "attrs": 3, "structure": 6, "text_grew": 5, "text_shrank": 1 },
    "rechecks": {
      "sampled": 1, "sampled_ok": 1, "sampled_unjudged": 0,
      "sampled_problems_before": 3, "sampled_problems_after": 0,
      "binding": 1, "binding_ok": 1, "binding_unjudged": 0, "binding_error": 0,
      "failures": [], "verdicts_omitted": 0
    }
  },
  "fidelity_observed": {
    "observed": 3, "pages": [2, 5], "unattached_pages": [],
    "kinds": { "content_missing": 2, "content_wrong": 0, "structure_wrong": 0,
               "a11y_only": 0, "alt_quality": 1, "untagged": 0 },
    "unattached": 0, "unplaced": 0
  },
  "pages_failed": [],
  "pages_blank": [17],
  "pages_bare_html": [4, 31]
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
since neither may revoke a document the user already has, so this is where they surface. **Failures
only**, which it was not: a `page_correction_recheck` carries an `ok` of its own meaning "the
verifier named no problem", so every second verdict that named one landed here too — 31 of 31 on
disk across 22 rounds, all of them the measurement-only sample, which runs *after* the correction is
kept and changes nothing about what ships. On a four-document round that made two clean documents
read as having errors, and the only thing distinguishing a working measurement from a truncated call
was that the measurement's `message` said `"unknown"` — this entry read `error`, and that event
carries its diagnosis under `problems` (issue #296). A failing verdict is now reported where its
counts are, as `verification.rechecks.failures`, so a non-empty `errors` means the run is in doubt.
Every entry that reaches it carries a real message: the three named above are built from a caught
throw and a failed `model_call` is logged with the provider's own, so `"unknown"` is what an old log
would read as rather than a standing entry on every run that sampled.

`tokens` is what the run **consumed**, and `by_agent` carries the same four counts per agent
(under the names the run log uses: `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
`cache_creation_input_tokens`) — so "which agent is slow" and "which agent is expensive" can be
answered separately, because they are often different agents. `by_step` is the **same calls with
the same seven numbers, keyed by the job the call was bought for** instead of by the agent that
answered it, so summing either gives the same totals and the same `tokens`.

Each row also carries `models`: **which model ids answered those calls**, sorted and
deduplicated. The seven numbers say what a bucket cost, and this says what the cost is a price
*of* — the pair matters on the one knob a deployment turns, since `providers.per_agent` picks a
model per agent and until this field nothing in a finished run said whether a swap had taken
effect. A key naming no dispatched agent is ignored rather than refused (**Configuration**), so
the call falls through to the provider's own model and the run succeeds at the price it would
have cost anyway: a cheaper model that saved nothing and a swap that never happened produced
identical diagnostics. Read `by_agent.<agent>.models` after changing an override — that is the
split the override is keyed by, on a session that has only run since the change: this field folds
the whole session log exactly as the seven numbers do, and a session's log spans its feedback
rounds, so a session extracted before a restart and given feedback after one reports both ids
truthfully. Usually one id; **more than one is not a defect**, because
resolution keys on capability as well as agent, so a provider's `per_capability` block can put
one agent on two models on purpose (`page` extracts with `vision` and merges a specialist
fragment with `text`; `feedback` judges with `vision` and classifies with `text`; the copy editor
picks by whether the section it is editing has images). An **empty** list on a row with calls in
it means a log old enough to predate the field — every `model_call` the router writes carries
`model`, on the failure branch as well as the success one, which is deliberate: a model id that
is valid for one provider and named to another resolves happily and then fails on every call, and
that row's model is the whole diagnosis. Both are reported
because they answer different questions and neither substitutes for the other: an agent name is a
*contract*, and one contract serves several jobs. The Feedback Agent judges a freshly extracted
page, re-judges a corrected one, routes a user's feedback and classifies a lesson from it; the
Copy Editor runs a review round **and** merges a table split across a page break. So the cost of a
*step* is not a row in `by_agent` — extraction read as 41% of a document's spend against a
`by_agent` split that books its per-page fidelity check to `feedback`, where its jobs together are
57.2% — while `providers.per_agent` overrides are keyed by agent, so "which model should this be
on?" is not a question `by_step` can answer. The step names are a closed set, split finely on
purpose because buckets add: **extraction** is `extract`, `verify`, `correct`, `recheck_binding`,
`recheck_sampled`, `specialist`, `specialist_merge`; **review** is `read`, `edit`, `edit_section`,
`table_join`; **a feedback round** adds `feedback_scope`, `feedback_learn`, `agent_update`,
`agent_regression`; and `agent_calibrate` and `contribute` are maintenance paths a delivered
document does not pay for. Every call carries one, so a `"?"` key means the log predates the field
rather than that a call went unattributed. `in_flight` and `slowest_calls` name the step too, since
"what is this run stuck on?" is a question about the job and not about the contract.
Deliberately no dollar figure: the rate depends on the provider,
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
and lost a link, `alt` a page that passed and described an image with a placeholder (#290), `both` one
with more than one of those. `alt` is expected to be 0 on a healthy run, and that is the point of
counting it: the rule flags nothing this pipeline writes, so a non-zero is either a page agent that has
started writing placeholders or a regression in the rule. `verify_failed / (pages_verified - pages_unjudged)` is the
rejection rate; the raw counts are reported rather than the percentage, because a rate over three
pages is not a measurement.

`pages_unjudged` is a **subset** of `pages_verified`, not a deduction from it: the pages that reached
verification and came back with no judgement — no Feedback Agent loaded, nothing to verify, a reply
that would not parse, and a page the agent declared **blank**, which is not sent to the verifier at
all. Verification is non-blocking, so all four answer "faithful" and cost the page
nothing, which means a run that lost its Feedback Agent halfway through would otherwise read as a run
with an unusually good pass rate. Zero on every log written before the flag existed, which is the one
case it cannot distinguish rather than one it claims to.

`pages_skipped_blank` is a subset of *that*: the pages nothing looked at because nothing was bought.
A page the page agent declared blank has an empty fragment, and an empty fragment has no content to be
unfaithful with — the verifier used to be shown the source image and an empty code block, and in 36
such judgements on a 100-page corpus (9 blank pages, two page-model arms, two commits) it passed every
one, for $0.0859 per arm: 0.77% of that lineup's bill and a growing share as the models get cheaper,
because a per-image cost does not shrink with them (issue #294). Read it as the saving — this count
times $0.0095, the measured cost of a verify call carrying no HTML, against $0.0212 for an average
page — with one caveat: it counts calls **not bought**, which is money not spent only where there was a
verifier to spend it on. A run with no Feedback Agent loaded skips the blank page's call too and saves
nothing by it. `pages_unjudged == pages_verified` is *consistent* with such a run but does not
identify it: a run whose Feedback Agent loaded and whose every verify reply failed to parse gives the
same equality, and there the calls were bought and the money spent. What settles it is the calls
themselves — `by_step.verify.count` in this same object is 0 on a run that bought no verdict at all,
whatever `pages_unjudged` says. It is a subset of `pages_unjudged` and therefore still inside `pages_verified`, so no rate
published before it moves; what it adds is that a skip and a broken Feedback Agent stop being the same
two numbers. The blank page keeps every check that costs nothing: a page carrying link annotations
that came back empty still fails the link comparison, still buys a correction against the image, and
that correction is still verified — so the wrong-blank case a **file** can prove is caught for free.
What is given up is a confident wrong declaration on a page with no annotations, which this call has
never caught (0 of 36) and whose observed cause — a hedged declaration — is refused before it gets
here by the doubt-word veto (`blank_vetoed`), which a stated declaration does not override either. Its
evidence is the `page_blank` line and `pages_blank`. One blank page is outside this count and is
supposed to be: where the reply stated blankness in its `blank` field and its own log names something on
the page, the verdict IS bought — `blank_contradicted` on `page_blank`, no `skipped` on the page's line —
so `pages_blank - pages_skipped_blank` is the number of declarations that cost a call (issue #371).

`pages_verify_error` is the other subset of `pages_unjudged`, and it is the counterweight to the one
above: the pages whose verify call **was** bought and threw — a throttle, a stall, or a reply that
overran the output ceiling (`page_verify_error` for the evidence, `skipped: "error"` on the page's own
line). Nested identically, so it moves nothing published either. The reason both exist rather than one
"unjudged for a reason" total is that they point opposite ways in money: a blank skip is a call not
made and is a saving, while an error is a call made, billed for a full ceiling of output, and answered
with nothing. On the case that prompted it that was **$0.5051 on one page** — more than twice an
average page's entire bill, and 3.2x the extraction the call was checking (issue #364). So price this
count against a full-page verify call, never the empty-fragment one, and never add the two counts
together. Zero on every log written before the guard existed, and that zero measures nothing: the same
failure used to take the page with it, so those runs recorded it as `page_extraction_failed` and a page
in `pages_failed`. A run whose verifier was being throttled reads, on an older log, as a run whose
vision was failing.

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
FAILED its check, verified a second time to see whether the re-render fixed it. How many pages a run
samples is `defaults.recheck_sample_size` (default 1, `0` off, at or above the page count a census),
and how many it actually took is `sampled` — a slot is spent only if a corrected page reached its
threshold. Read the default as a **count**: `sampled: 1` supports "1 of 1 cleared" and no percentage,
which is the mistake this number was built to invite — 8 runs over 111 corrections bought 8 verdicts,
and two four-draw samples off one corpus read 50% and 25% (issue #288). Accruing draws over a fleet
does not fix that on its own, because the pages are chosen by a rule and not at random. The rate over
corrected pages is what a **census** buys, at one Feedback Agent call per correction — roughly half
again on top of verify's 14.2% of a document's bill — and it is worth buying once rather than
standing in production: replayed over 57 corrected bench pages it says **26%** of corrected pages
clear their recheck, against a 2% floor for re-asking about the page as it was (19 better, 2 worse,
p = 0.000). So a correction usually leaves a named problem behind, and `sampled_ok` near zero on a
small sample is the expected reading rather than a regression.
`sampled_problems_before / sampled_problems_after` is how far the kept corrections got:
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

`binding_error` is the binding recheck that was **bought and threw**, so it produced no verdict at all
(`page_verify_error` with `step: "recheck_binding"`, issue #364). It is **not** a subset of `binding`
and not in any rate above: the three fields beside it are fed from `page_correction_recheck`, which does
not fire when there is no verdict to report, so this population is disjoint from all of them and the
judged-only rate is unaffected. It is here and not in `pages_verify_error` for the reason that field is
nested: that count sits inside `pages_unjudged`, and a page whose binding recheck threw is **not**
unjudged — it has a real first verdict and it passed, so counting it there would put a judged page in
the unjudged total and move the rate the nesting protects. Read it as *a gate that could not be
applied*: the correction was billed, the page had already rendered, passed and been corrected, and the
rewrite is discarded because no verdict is no licence to change a page known to be good. It is the more
expensive of the two verify-error shapes and, without this field, the only one with no number — its
sole other trace is a `page_corrected` `result: "rejected"`, pooled with the shrink floor and with a
rewrite a second verdict genuinely refused. The sampled recheck's own failure
(`page_correction_recheck_failed`) has no counter, and that asymmetry is intended rather than an
oversight: the sample decides nothing whether it answers or not, so it is the one verify failure that
changes nothing about what ships.

`failures` is the failing verdicts themselves and not a count — the counts are `sampled - sampled_ok`
and `binding - binding_ok`. One entry per recheck that named a problem, in the verifier's own prose:

```json
{ "ts": "2026-09-01T07:43:58.408Z", "page": 21, "binding": false,
  "message": "The alt text places Mississippi in the dotted-pattern category ... but on the map MISS. is shown with the solid-dark fill." }
```

Nothing else in `diagnostics.json` holds that prose, and it is the whole answer to "what is still
wrong with the page that shipped" — the counts say a correction did not converge and never say what
it failed to fix. Both populations, told apart by `binding`, because the two failures read
differently: `false` is a page that shipped **still wrong**, and `true` is a rewrite that was refused
so the page shipped as it was (`page_links_correction_rejected`). `null` is a line that did not say,
which the counts above put in neither bucket — kept here anyway, since what that line failed to say
is which rate it belongs in and not what is wrong with the page. `page` is on the entry because a run
can fail several rechecks and each message is about one page. The `message` is the problems in full,
counted when there is more than one (`"2 problems: … | …"`), since no order is claimed among them and
the dropped one is as likely as any to be why the page is wrong. Failing verdicts only, so an
unjudged recheck never appears — it logs `ok: true` and names nothing. This is where these were meant
to be read all along: they were in `errors` under the word `"unknown"` (issue #296).
Bounded, which nothing else in this payload needs to be: every other field here is a count, and these
entries are model prose, so they are the one part that grows with what the documents needed. At most
**20** verdicts, each `message` cut at **600** characters with a `…` marking the cut (so a cut message
is 601 characters, the mark being extra), and `verdicts_omitted` says how many the cap left out — a
capped list is never a short one read as whole. The two populations reach that cap at very different
rates, and the sampled one effectively never does: `recheck_sample_size` is 1 by default, so a run
supplies at most one sampled failure. The binding recheck is **not** sampled — it runs on every page
that passed its check and had a link or alt rewritten — so a link-heavy document can refuse more than
twenty rewrites inside one round on default config, and the cap engages there. That is the run worth
capping: twenty refusals plus a count of the rest says the rewrite path is losing content
systematically as well as fifty verbatim would. `GET /v1/sessions/{id}/logs` holds every verdict in
full, uncut and uncapped.

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
the choice is between a page with fewer named problems and a page with more. The sample is also a
subset of the batch at any size below a census, so binding it would put a gate on page 4 that page 5
never sees; and it stays non-binding **at** a census too, since a knob that changed what ships as it
was turned up would make every rate it collected a measurement of a different pipeline. Whether to
re-render until a page passes, or to run a cheaper verifier, is a policy question, and the rate it
needs is now buyable (`defaults.recheck_sample_size`) rather than only inferable from a bench replay. Like `model_calls`, the counts sum over every run a session has had, so a
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

`pages_bare_html` is a third state, and unlike those two it is not about a page that contributed
nothing: these pages contributed their content and not their `log`. The reply was markup rather than
the envelope, so it was rescued as it stood (`page_bare_html` in §7a) and carried no `"log"` field at
all — and `agents/page.md` discharges six kinds of obligation in that field and nowhere else, so on
these pages a mid-sentence cut, an orphan heading, an unkeyed symbol, a placeholder image source, a
language change and an irregular table all go unrecorded while the run reports every page delivered.
It was 13.7% of pages across four deployed rounds of one PDF (issue #349). Named for the reply's
SHAPE rather than for the consequence, because that is the narrower claim: an enveloped reply that
merely leaves `"log"` empty also has no log and has a different remedy, and is not counted here —
though over 67 round logs on file that shape is 0 of 2,320 page replies, so today this field is the
whole population of pages with no log. It follows the document like the other two: a page
re-extracted with a proper envelope has a log and leaves the set, one that came back bare stays, and
a round that threw keeps the prior fragment and so keeps the page. No one page is ANSWERED two of these ways: a blank declaration needs
an envelope with a `log` asserting the page is empty, and a page that failed has no fragment of its own
at all. The sets are not quite disjoint as memberships, though, and the exception is worth knowing before
you subtract one from another: `page_bare_html` is emitted while the page is being rendered, and the
verify call that follows is unwrapped, so a bare page whose verifier takes a provider error is in
`pages_bare_html` and `pages_failed` both. Nothing on file has done it.

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

### A page that is here and is known to be wrong

The opposite failure, and the one Iris knows the most about and used to say the least about (issue
#328). These pages **are** in the document: they were rendered, the fidelity check rejected them
naming what was wrong, one self-correction pass was bought, and it repaired nothing. So what those
pages carry is content Iris named a defect in and never fixed. Not necessarily the rejected bytes: the
marker is written after the review loop, and the Copy Editor may have rewritten a block on one of
these pages since. What no later round can have done is **answer the check** — nothing after
extraction asks whether a page is faithful to its source, and the editor, which is the one step that
does see a source image after that point (for the pages the Reader's issues name), is told to *report*
a discrepancy it notices rather than edit from one reading of an image (`editor_fidelity_observed`,
§7a). The rejection therefore stands
whatever the markup became, and only a re-extraction can lift it.

```html
<!-- @page-uncorrected 5, 31
  The content of the source pages above IS in this document, and it never passed Iris's
  own fidelity check: the check named what was wrong with each of them, one correction
  pass was made against the source image, and it repaired nothing. No later step checks a
  page against its source again, so nothing after that point can have put right what the
  check named. ...
-->
```

Written once after `</main>`, out of the Copy Editor's reach, like `@page-failed`. It is the more
useful of the two declarations, because a page with no content is obviously incomplete to anyone who
opens the file while a page whose statistical table lost its six aggregate rows looks finished and no
longer adds up.

The correction ends without repairing the page in five ways, and for the delivered document they are
one fact — the page the verifier named problems in — so the marker does not distinguish them. The log
does: `page_correction_failed` is the call that threw, and `page_corrected`'s `result` is `empty` (it
answered with no HTML), `identical` (it answered with the page it was given, **or** with a different
string carrying the same page — re-indented, or `&` written `&amp;` — which is adopted and is the
fifth way) or `rejected` (its answer came back at under a quarter of that page's size and was refused
as a deletion). Which makes the rule readable off the log without a per-value table: a page whose
verdict failed is in this set exactly when its `page_corrected` `result` is **not** `kept`.
`page_verify_failed` on the same image says what was wrong. The set itself is on `extraction_complete.uncorrected` (or `reextract_complete.uncorrected`)
and, present only when there were any, on `uncorrected_pages` on the `run_complete` line — which is
the one place it can be read on **every** mode, because a feedback round that re-extracts nothing runs
no extraction and so logs neither of the other two. There is no diagnostics list of these pages —
`pages_failed` is the no-content set and these
pages are deliberately not in it; §7b's `verification.results` and `verification.triggers` count how
many corrections ended each way without naming pages, so the run log is where you go for the page.

It is **not** the claim "this page might be wrong". A correction the pass did adopt is not listed,
even though replaying the check over 57 corrected pages put their pass rate at 26% (issue #288): that
is a repaired page rather than the rejected one, the verifier rejects 71–74% of first renders, and a
marker that fired on most of a document's pages would tell a reader nothing. What the **absence** of
this marker means is exactly that no page shipped as the fragment its own verifier rejected — not
that every page was checked after correction, which is a sample (`page_correction_recheck`) and not a
gate.

Like a missing page, it follows the document across feedback rounds rather than the run: re-extracting
the page is the only thing that takes it out of the set, because re-rendering from the image is the
only way a page whose correction failed gets a second answer. And like a missing page it is kept out
of the regression fixtures captured on `POST .../close` — accepting a session is a human saying the
*document* is good enough to close, which is not the same claim as this page being the correct output
for its image, and filing it would gate every future page-agent update on reproducing markup this run
had already declared wrong.

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

Two ceilings are **not** that one, and both say so in the same message rather than leaving the
advice above to be followed: `That ceiling is <model>'s own, below the 32000 in
providers.bedrock.max_tokens` is a model that refuses the ceiling the deployment asked for and
needs a different model rather than a different setting (§7a, `output_ceiling_clamped`), and `That
ceiling is this call's own` is a ceiling **Iris** asked for, on a call whose answer has a size it
can predict. Only the page-correction call does that today: it is handed a page and asked to return
it with named problems fixed, so it is capped at twice what the first pass of that page spent (with
a floor, `correctionCeiling` in `src/pipeline/extraction.ts`). Before the cap, one such call ran to
the full 32,000 tokens on a page whose render cost 6,233, and the reply was discarded for being
truncated — a bill 5.13x the first pass for output nothing read. The remedy is that caller's
multiple, and `step` on the `model_call` line says which caller it was; raising `max_tokens` moves
nothing.

A **third** shape wears the same stop reason and is not a size problem at all: `(0 chars returned)`,
where the ceiling was reached with no reply written. That message carries its own sentence too — `No
text was returned at all, so raising that ceiling is not the remedy: look at the model's reasoning
behaviour and at the size of what it was asked to produce. The ceiling was spent before the reply
began, and a larger one buys more of whatever consumed it.` A response cut mid-document is an answer
too long for its ceiling, and a larger one — whichever of the two above the call died of — is the
fix. Zero characters means the whole
ceiling went somewhere other than the text — reasoning a model streams as its own channel, which
Iris counts as output tokens and not as reply (§7a, `model_call`) — so raising the number is a bet
that the thinking finishes inside the new ceiling, and a lost bet is billed for the whole of the new
one. One extract call in a 100-page benchmark round spent 32,000 output tokens this way and returned
nothing (issue #293). It is a reasoning model's failure, so the thing to change is the model or the
size of the request; on the two page paths the run log says which shape it was — `reply_chars: 0`
is this one (`page_extraction_failed`, `page_correction_failed`). Read that field and not the
absence of `reply_head`: on `page_extraction_failed` the two say the same thing, but on
`page_correction_failed` `truncated` is a predicate over the error's message and a bare
`truncated: true` there has a second cause, which §7a's row for that event spells out.

The order of the two sentences in that message is load-bearing, which is why it is quoted here whole:
a page's `@page-failed` marker carries only the message's first 300 characters, and the advice this
shape exists to withdraw — `Raise providers.<provider>.max_tokens.` — is inside that cut. So the
instruction has to lead and the explanation has to follow, or the operator reading a lost page's
marker gets the advice without the take-back. `test/bedrock-output-ceiling.test.ts` pins it; the
margin is a handful of characters, so lengthening that sentence means re-measuring the cut.

A reply that arrives whole and still cannot be read is the neighbouring case, and reads as
`page agent returned no HTML (prose, 412 chars)` — `page_no_output` in §7a, with the `shape` that
says which remedy applies. Where HTML did arrive and carried nothing a reader receives, the same
line says that instead — `page agent returned no page in 19 chars of HTML` — because a comment or
a bare page-break marker is not the model answering with no HTML, and the first reading of these
reported the reply's whole length under a message that said none of it was markup. It costs the same as the ceiling does (that page, not the run) and for
the same reason: a page whose content is a JSON envelope or an apology is a document that lies
about being complete, which is worse than one page short and saying so.

The same ceiling reached by a **correction** round is contained differently, because there the
whole document is what did not fit: whatever the reply managed before the cut is applied and the
part it never reached is re-made a section at a time, the loop then stops, and the delivered
document says so in an `@editor-truncated` comment (§5, and
`editor_truncated` / `editor_salvaged` / `editor_sections` in §7a). The remedy is the same knob.

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
