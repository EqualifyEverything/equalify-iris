# Implementation notes

Decisions the code makes that are worth knowing before you read it.

Several reverse an earlier design, so they are written as decisions rather than as a diff against
one: Iris was specified up front in a requirements document, that document was amended twenty-odd
times as the build disagreed with it, and it has now been retired. The design record is the git
history and the issues each decision cites. What is true today is here, in [API.md](API.md), in
[models.md](models.md) and in the code.

This file is for someone about to change the code. If you only want to run Iris, the
[README](../README.md) is enough.

Each decision below is one bullet, and the headings only group them:

- [The pipeline's shape](#the-pipelines-shape) — what got built, what got deleted, and how your
  corrections get back to the library
- [What the lint checks](#what-the-lint-checks) — and the things it repairs without telling anyone
- [Assembly: one document out of many pages](#assembly-one-document-out-of-many-pages) — id
  collisions, and tables and sentences cut in half by a page break
- [Extraction: verdicts and empty pages](#extraction-verdicts-and-empty-pages)
- [The review loop](#the-review-loop) — the Reader, the Copy Editor, and the floors a round cannot go under
- [Learning from feedback](#learning-from-feedback) — the eval gate
- [The provider adapters](#the-provider-adapters) — output ceilings, timeouts, and Bedrock's two dialects
- [Running the service](#running-the-service) — the queue, upload limits, one instance per `data_dir`
- [Designed for, and not built](#designed-for-and-not-built)

## The pipeline's shape

- **Three phases, not five.** The original design had a Triage pass writing per-image notes and
  a Reconciliation pass stitching fragments across images; neither is built. Extraction is a
  single general page agent rather than triage → per-region fan-out; the fan-out was removed
  because it duplicated output for nested structures like forms. Reconciliation additionally
  cannot run until extraction emits fragment edge data (it currently emits none). A Builder
  Agent that drafts session-scoped agents into `tmp/<id>/agents/` is likewise designed for and
  not built — what ships instead files the drafted agent as an issue (below).

  Reconciliation's *within-page* job also no longer exists: it was there to clean up after the
  fan-out, and one page now yields one fragment from one agent, so there are never two fragments
  competing to represent the same content. Across pages the problem is real, and it is now closed
  both ways: a **table** printed across a page break is rejoined where the pages are joined, and so
  is a **sentence** (the two bullets further down describe how). Prose was the harder half for a
  reason worth stating, because it was never a gap anyone could close in the page agent: the
  page-break marker is the first thing a page emits, so a split sentence lands with its halves in two
  different replies, and the agent that wrote `public serv-` was never shown the page that says
  `ices`. Neither can emit that sentence whole without inventing the half it cannot see. So the page
  agent's job there is to transcribe its own edge exactly, hyphen included, and declare in its `log`
  that the page opens or ends mid-sentence, and the join is done by the pass that holds both halves.
  Measured on the last bench round before it: 22 of 90 page-break markers stood where a
  sentence carried on, and 2 of those split a hyphenated word.
- **One agent per page, not one per content type.** Nine per-content-type
  agents (`paragraph.md`, `table.md`, `formField.md`, …) once shipped and have been **deleted**, and this is the
  decision on whether the agent library is the product: it is, but the library is not a taxonomy
  of content types. Those nine were not merely unused, they were unreachable through every path
  that can reach an agent file — dispatch declines each of their names *before* the file is
  looked up, only `page.md` is ever trained, and the contribution filter blocks the same names —
  so no fixture, lesson or prompt improvement could ever accrue to one. Nine prompt files that
  cannot run are worse than none: they read as the live extraction path to anyone opening
  `agents/`.

  Seeing the whole page is the capability, so per-region fan-out is not coming back: nine agents
  re-rendering one image produced two representations of one thing (a `<form>` and a `<table>`
  for the same fields) and then needed a reconciliation phase to remove a duplication the
  architecture had just created — at nine times the cost and latency of the single call that
  already produces the answer.

  What is left is specialization that *earns* its place: `page.md` as the general, trainable
  pass, plus specialists for content a whole-page pass demonstrably handles worse, dispatched by
  name and merged in. `chartDataAgent.md` is the shape — reading precise values off a chart's
  axes into a data table is a different task, needs its own long contract, and would bloat the
  page prompt for every page containing no chart. A `paragraph` specialist is not that shape;
  "wrap prose in `<p>`" is one line of the page prompt. This is also why the context pressure
  that motivates splitting agents up is answered per-*capability* rather than per-content-type:
  a specialist's contract is loaded only for the pages that need it, whereas nine near-duplicate
  prompts relieve nothing.

  The nine type *names* survive as data (`STANDARD` in `src/pipeline/contribute.ts`), which is
  what declines a suggestion the page pass already covers and what keeps it from being re-filed
  as a new agent to build. That list was never a mirror of the library — it is the boundary of
  what one whole-page call handles — so it stays data rather than a directory listing, and
  dropping a `table.md` into `agents/` does not start splicing a second table over the page's own.

  The names are matched case-insensitively, through one shared normalizer used by both the
  dispatch decline and the contribution filter. A suggestion's name is prose a model wrote, not a
  filename (`STANDARD` itself spells one entry `formField`), so `"Table"` is ordinary output.
  While the nine files existed, `agents/Table.md` resolved on a case-insensitive volume and
  absorbed it; with them gone, an exact-match filter would draft an agent and file a public issue
  on the upstream repo — under the user's own GitHub identity — for a type the page pass covers.
- **No provenance comments in the output.** `@source` / `@agent` / `@fragment` wrappers travel
  with a fragment through the pipeline, and an early design kept them in the final HTML. Iris
  delivers clean content-only HTML
  instead: the comments leak pipeline internals into a document meant to be handed to end users,
  and every consumer would have to strip them. Provenance is recorded in the run log
  (`GET /v1/sessions/{id}/logs`) rather than in the deliverable. `@unresolved` **is** emitted
  when the review loop stops with issues outstanding — at its iteration cap, on a round that
  changed nothing, or on a round whose response hit the model's output ceiling. That
  last exit adds a second comment, `@editor-truncated`, saying what that round managed: a round
  too long to answer is re-made a section at a time, and the comment reports how many sections
  came back — or, where nothing could be, that
  no editor pass ever worked on the issues `@unresolved` lists. A third comment,
  `@lint-unavailable`, is emitted when axe-core could not run on the document at all: nothing in
  it was checked, so an `@unresolved` list that is short — or absent — is not evidence that there
  is nothing left to fix.
- **Contributions are issues, not PRs.** Instead of fork+PR-on-close, when the
  extractor flags content a specialist would handle better, Iris drafts that agent and files a
  `New agent suggestion: <type>` GitHub issue with the agent code + context; feedback that
  generalizes files an `Agent update proposal: <agent> — <lesson>` issue the same way. Simpler to
  triage, and it needs no write access to a fork — so nothing forks and nothing pushes. The
  `pending_prs` and `prs_opened` response fields, the `skip_prs` parameter and the
  `fork_repo` field on `/v1/me` belonged to that flow and are **not** part of the API.
  Issues are filed with the logged-in user's token, which is
  [required, and the point](../README.md#github-is-the-only-sso-layer-and-tokens-are-required);
  `github.issue_token` overrides that with a service account, at the cost of the attribution.
  The update title carries a slug of the **lesson**, not just the agent, because the agent on that
  path is always `page.md`: with the agent alone, every proposal ever made computed one title, and
  the title-based dedupe then skipped every one of them after the first — silently, for as long as
  that first issue stayed open (observed on the UIC deployment, where one issue blocked the path for
  a day). A repeat report of the same lesson now comments on its issue with the new session and
  corroboration count instead of being dropped, so no lesson leaves without a trace.
- **Review issues are attributed by page, not by `@source` region.** The Reader's issue format
  was designed around the `@source` region ids of the per-region fan-out, which extraction no longer
  produces and which are stripped from the deliverable anyway (above). Issues instead carry
  `pages: number[]` — the source pages the Reader matched the offending content to, from an index
  of page-number + extracted-HTML excerpt. Attribution is what scopes the Copy Editor's image
  payload (below); the two-view (HTML + flattened) cross-check is implemented as specified.

Places where a decision was left open, and where v1 intentionally stops:

- **`runs/<run-id>` vs `sessions/<session-id>`.** The design named both.
  This implementation treats the run id as the session id and writes the log, `agent-updates.md`,
  etc. under `sessions/<session-id>/`, which is the layout above. (Two files that tree once
  named, `new-agents.md` and `prs.md`, are not written at all — they belong to the withdrawn
  fork-and-PR flow.)
- **Reader chunking.** Chunks use a fixed character budget with overlap rather than a
  literal 30%-of-context computation, since the per-model context window is not exposed through
  the provider abstraction. The two-view (HTML + flattened) cross-check is implemented as
  designed.
## What the lint checks

- **Color-contrast lint.** Output is content-only with no styling, so axe-core's
  `color-contrast` rule is disabled — it cannot be assessed without rendering and is out of
  scope.
- **Skipped heading levels are linted for, though they are not a conformance failure.**
  axe tags `heading-order` `best-practice`, so the WCAG-only tag filter drops it, and it is
  enabled by name on the same argument as the duplicate-id rules below: headings are how a
  screen-reader user navigates a long document, the levels here are decided one page at a time
  by a model looking at type size, and nothing after extraction could see the result. The page
  prompt has forbidden skipping a level since #96 and #114 reported one shipped anyway. The rule
  fires only where a level goes *down* by more than one, so it stays quiet on the shapes the page
  prompt asks for — a body that opens at `<h2>` or `<h3>`, because a page may be a subsection of
  a heading the extractor was never shown, and a heading that returns to an outer level after a
  run of subsections. It cannot see the other half of the bug (an `<h2>` that should have been an
  `<h3>` is a level the page decided, not a gap), so it narrows the prompt's job rather than
  replacing it. Two consequences worth knowing: a document that used to pass may now spend review
  iterations on heading levels, and `heading-order` can now appear in the quality tally, where it
  has been the worked example in `docs/API.md` §0c all along without once being reportable.
- **A `<main>` inside the delivered `<main>` is linted for, and removed before it gets there.**
  `wrapDocument` puts the assembled body inside `<main>`; 18% of page answers across a six-model
  bench lineup emitted one of their own, which ships a `main` inside a `main` — and that takes away
  the landmark a screen-reader user jumps to in order to skip the furniture. axe has three rules for
  it and tags all three `best-practice`, so the WCAG-only filter dropped every one and the gate
  called the document clean. `landmark-no-duplicate-main` and `landmark-main-is-top-level` are now
  enabled by name, on the same argument as `heading-order` above. The third, `landmark-unique`, is
  deliberately left off: measured, it fires on two `<nav>` elements with no accessible name, on two
  `<aside>`, and on two `<section>` the page names alike — repeatable page furniture, not a defect —
  and it is quiet on a nested `<main>` that carries a label, so it would cost false positives
  without covering the case. The rules are a backstop, not the fix: `landmarks.ts` takes the tags
  out of the body first (below).
- **Duplicate ids are linted for three separate ways.** Obsolete as a *conformance
  criterion* is not the same as harmless here: this document is assembled from independently
  extracted pages, so a duplicate id is the specific defect concatenation produces, and it breaks
  navigation rather than conformance. Two `id="fn-1"` means every `href="#fn-1"` reaches the first
  one, so a footnote reference on a later page silently goes to the wrong note while the link still
  looks like it works. Covering that takes three rules, because axe splits the check by what the
  element *is* and each rule skips the others' elements:

  - `duplicate-id` (elements nothing references and nothing focuses) and `duplicate-id-active`
    (focusable ones) are both tagged `wcag2a-obsolete` — WCAG 2.2 dropped 4.1.1 — so the tag filter
    would skip them and each is enabled by name.
  - `duplicate-id-aria` covers ids something actually *references*, is still live WCAG 4.1.2, and
    needs no enabling — but axe marks it `reviewOnFail`, so its findings arrive as `incomplete`
    rather than `violations`. That left the worst case invisible: two `<input id="q1">` under one
    `<label for="q1">` returned **zero** violations even with both obsolete rules on. A duplicate id
    needs no human judgement to confirm, so this rule's incomplete results are promoted to
    violations — only this rule, since the rest of `incomplete` genuinely cannot be decided without
    rendering.

  This widens what the gate reports, which is the point but has a cost worth knowing: a document
  that used to pass now spends review iterations on duplicate ids, and can reach
  `max_review_iterations` with them still listed in `unresolved.md`. Assembly namespaces the
  *cross-page* duplicates itself, so what reaches the review loop is the ids duplicated **within a
  single page** — which the assembler cannot fix, because there is no second page to attribute the
  copy to — plus the collisions on any page the reserialization guard left as written.
- **The delivered document's own structure is measured outside the lint gate, because axe cannot
  see it.** axe lints a parsed DOM, and an HTML parser's job is to turn malformed markup into a
  well-formed tree before anything downstream looks at it. A document delivered with an unclosed
  `<table>` therefore reaches axe as sixteen tidy tables: on one bench round, a document whose
  bytes read sixteen `<table>` start tags and fifteen end tags reported `final_lint.ok: true`,
  zero violations, `ready_for_review`. The other half is content that is not there for the parser
  to repair — a table in the same document had a caption, a two-row header block naming nine
  columns, and no rows, which a screen reader announces and reads out as an empty table. axe has
  no rule for that either (`empty-table-header` is about a header *cell* with no text), so zero
  violations was the honest answer to the question axe was asked. Both are checked on the
  delivered bytes instead (`markup.ts`), reported as `delivered_markup` in the run log, and
  tallied as `iris:markup-unbalanced` / `iris:table-no-body`. Two narrowings are worth knowing.
  Only elements whose end tag HTML *requires* are balance-checked: `<ul><li>a<li>b</ul>` is
  correct markup, and counting it would bury the real finding under legal output. And a table
  counts as empty when it holds no row a reader receives as *content*, not when it has no `<td>` —
  a table whose body cells are all `<th scope="row">` is legal and full of content. So what is
  counted is a table with no rows at all, none outside a declared `<thead>`, or — where the model
  declared no header block, which is the shape it writes when it has drifted from the page prompt
  — none that is anything but column headers. Nothing here
  is repaired and no run fails on it: a count with no threshold, on the same argument as
  `internal_links`, until there is enough of a rate to calibrate.
- **Four more questions are asked in the same pass, about promises the document makes and does not
  keep (issue #255).** These are not malformed markup, which is why they needed their own checks: a
  reference to an `id` no page defines (`aria-labelledby`, `aria-describedby`, `label[for]`), a
  `<dl>` with terms and no definitions, a `lang` on an element with no text for it to apply to
  (neither a text node nor text in an attribute — `<img alt="Un graphique" lang="fr">` is correct
  authoring and is not counted, the same image with `alt=""` is), and a `<nav>`,
  `<aside>` or *named* `<section>` with nothing in it. The gate is clean on every one of them, each
  for a different reason — axe reports a dead ARIA reference as `incomplete` rather than a violation
  (`aria-valid-attr-value` is `reviewOnFail`, so it never reaches a rule the review loop acts on),
  `<dl><div><dt>Term</dt></div></dl>` *passes* `definition-list` because the wrapper is legal HTML,
  `lang` is a global attribute so putting one on an empty `<img>` breaks nothing, and an empty `<nav>` has
  no rule at all. They are reported together as `delivered_structure` in the run log, with the
  elements named, and three of the four are tallied as `iris:structural-defect`. Two decisions are
  worth knowing. The checks run on the **joined** document, not per page, because a reference to an
  id a *later* page defines is correct and a per-page scan would report it as dead. And a `lang` on
  an empty element is measured but deliberately kept **out** of the tally: it is wasted output, not
  something a reader loses, and mixing it into a rate about harm would move that rate for the wrong
  reason. Like the two above, nothing here is repaired and no run fails on it.
- **The lint counts every attribute name no valid markup produces, and removes the few that stop it
  running (issue #257).** Not tidying: an attribute name beginning with a digit took the entire rule
  set offline. axe needs a unique CSS path for the elements it reports; where an id is unusable and a
  similar sibling must be disambiguated it enumerates attributes, and a CSS escape is the hex
  codepoint, so a name starting `9` escapes to `\39`; jsdom's selector engine compiles selectors into
  JavaScript source, where `\39` is an octal escape and a SyntaxError in strict mode. One such
  attribute pair anywhere in a 25-page document and there was no verdict on any of it — which
  happened to six delivered documents, 150 pages, every defect on them unexamined. `runAxe` removes
  those names from **its own copy** of the document before axe walks it; the delivered bytes are
  untouched, because what a name like `1\"` was meant to be is a question for the stage that produced
  it. The removal is limited to the escape shape the compiler chokes on, and everything else
  malformed is counted and left where it is, because **removing an attribute takes the rules that
  read it away too**: `aria-valid-attr` (critical, WCAG 2 A) fires on a name that lost a quote —
  `aria-label"Note"` — *because* the name is malformed, and a wider strip turns that document into a
  clean pass with a log-line number as the only trace. What the predicate is, is checked against both
  libraries it makes a claim about: axe's own `escapeSelector` and nwsapi itself, name by name. The
  count is reported (`malformed_attributes`, plus `malformed_attributes_removed` when the linted copy
  differed, on the `assembly` line or `lint_debris`) because the name is the only symptom of a leak
  whose other three harms — an invalid `role`, a marker announcing the wrong text, an `id` no
  reference resolves to — are findable only by reading the document (#233, #234). Counted on **every**
  document rather than only on ones that break, since a number that appears only after a crash cannot
  answer whether the leak upstream is fixed. Two boundaries worth knowing: an attribute VALUE
  beginning with a digit, and an id or class beginning with one, are escaped correctly by the same
  engine and are never removed; and `<template>` content is reached by neither the strip nor axe, so
  debris there is uncounted and also harmless.
## Assembly: one document out of many pages

- **Colliding ids are namespaced during assembly.** A page is extracted alone and
  concurrently, so it cannot know that another page also numbered its first footnote 1 — and the
  page prompt asks it to preserve the source numbering. `assembleBody` prefixes the ids that more
  than one page claimed with their page number (`fn-1` → `p3-fn-1`) and rewrites everything that
  points at them in the same pass: `href="#…"`, plus `for`, `headers`, `list`, `form` and the
  `aria-*` references, since unique ids with dangling references would be a worse defect than the
  collision.

  The scope is deliberately one id at a time, not one page at a time. Prefixing every id on a page
  also breaks the references that legitimately span a page break — a `<label for>` whose input is
  on the next page, or endnotes with continuous numbering — which resolved correctly before
  assembly touched them, so that trade is a no-target reference in place of a wrong-target one.

  The prefix is reserved against every id the document already claims, growing its
  separator (`p1-` → `p1--` → …) until nothing collides with it, because `p1-total` and
  `p2-name` are what a paginated form emits and a blind prefix would manufacture the
  duplicate it exists to remove. An ordinary document keeps the short form.

  The prefix is *labelled* with the page number, but it does not depend on that number being
  unique: two fragments sharing an `order` would otherwise take the same prefix and stay
  collided, with the log reporting the id as namespaced. Ownership is tracked per fragment
  position and a repeated label becomes `p1_2-`.

  Every reference to a colliding id is repointed rather than abandoned. If the page owns the id it
  goes to the page's own copy (reference and target were written together by one agent looking at
  one image). If it does not, the reference is ambiguous and goes to the first page in document
  order that claims the id — where a browser sent the bare reference before any of this ran.
  Leaving it dangling instead was the same defect in a new place: with a `<label for="q1">` on page
  1 and an `<input id="q1">` on pages 2 *and* 3, every owner is renamed and the label points at
  nothing, so the field loses its accessible name and axe reports `label` on a document a plain
  concatenation passed. Ambiguous references are named in the run log as `assembly_anchors`.

  A *link* is aimed slightly differently: it takes the first owner that does not already link to
  its own copy. That owner's target is spoken for — a footnote marker on page 3 pointing at `#fn-1`
  where pages 1 and 2 each carry their own `fn-1` *and* their own marker for it is not a tie
  document order can break, and aiming it at page 1 gives one note two markers while page 3's note
  stays unreachable. An owner that does *not* link its own copy is a footnote continued from an
  earlier page, so a link is still repointed there. Only when every owner has its own marker is the
  link left bare. Those are listed in the same log line as
  `unrepointed`, a subset of `ambiguous`, and the references themselves are counted as unresolved in
  the delivered document (`internal_links`). Links only: a `for`, `headers` or `aria-*` reference
  with no target is an axe violation, so those still take the first owner. A page
  whose markup would not survive a reserialization is left exactly as written, keeping its collision
  for lint to report and its bare ids for anything resolved to it. If such a page holds a *reference*
  instead, the referenced id's first owner keeps its bare form so that reference still resolves —
  only the first owner, so every other copy is still renamed, and only when none of that id's
  *owners* was skipped, since a skipped owner is already keeping the bare id and pinning a second
  copy would ship a duplicate. Any id pinned this way is listed in the same log line as
  `pinned_ids`: it is a colliding id that deliberately was *not* renamed, so without it a bare
  colliding id in the delivered document would be indistinguishable from namespacing that
  silently failed. A page too deeply *nested* to rewrite — rewriting recurses per level in three
  places, so past 500 levels, measured on the parsed tree, the page is refused rather than allowed
  to overflow one of them — is delivered as written for
  the same reason and takes the same treatment: it counts as an owner (or the collision would go
  undetected for its copy, and the pin would fire on top of the bare id it is already keeping) and
  its frozen references pin their first owner. Its ids and references are read from its **DOM**,
  which such a page keeps: `querySelectorAll` does not recurse, so it works at any depth the parse
  survived, and the reading is exact. Only a page whose *parse* threw falls back to scanning the
  source, and that scan follows the parser's own rules — attributes only from real tag positions,
  elements whose content is not markup (`<textarea>`, `<script>`, `<template>` and the rest)
  skipped, character references decoded, first of a repeated attribute — because a *phantom* id
  read out of non-markup text is worse than a missed one: it suppresses the pin, the real owner is
  renamed, and a `<label for>` elsewhere is left naming nothing. Reading the tree is what closed
  that class rather than modelling more of the parser: the scan cannot see tree *construction*, so
  it invented owners for markup the parser drops outright (an orphan `<tr>`/`<td>`, a stray
  `<caption>`/`<col>`/`<thead>`, anything after `<plaintext>`) and missed real references inside a
  `<select>`, whose `<option>` children survive parsing even though most tags in there do not.
  That covers foster parenting in
  both directions: a `<tr>` outside a `<table>` is dropped to bare text, and content inside one is
  *hoisted out past the table* — a reading-order change, worse than the duplicate id it would be
  fixing. The guard compares the source's sequence of tags **and text** against the parsed document
  as a subsequence, since counts cannot see a move, equality would refuse every page where the
  parser legitimately adds a tag, and a tag-only sequence misses bare prose being hoisted out of a
  table with every tag left in place.
- **A deprecated ARIA role redundant with its element is dropped, not reported.** ARIA deprecates
  exactly three roles — `directory`, `doc-biblioentry`, `doc-endnote` — and all three were folded
  into list semantics, so each has a host element whose implicit role already *is* the role: an
  `<li role="doc-endnote">` inside an `<ol>` is announced identically without it. Removing the
  attribute is therefore a rewrite with no judgement in it, and it happens where the pages are
  joined and again after every correction round, logged as `deprecated_roles_stripped`. Both ends
  are needed: extraction reached for the DPUB pair on its own and took the deprecated half (issue
  #187), and the round that was told the rule had failed rewrote five sections and left it. A body
  a feedback re-run picks up without re-extracting is stripped for the same reason, since that path
  runs no assembly at all. The prompt is still the primary fix — `agents/page.md`'s FOOTNOTES rule
  now asks for a plain `<ol>` of `<li>` with no role on either, and says why the *landmark* roles
  do not belong on the list either: a role replaces the element's own, and `doc-endnotes` is a
  landmark that is not a kind of list, so `<ol role="doc-endnotes">` stops being announced as a
  list of N items and no gate reports it. This pass is the part that does not depend on a model
  obeying any of that. Only where the role is redundant: a `<div role="doc-endnote">` is left to fail the gate,
  because deleting the attribute there loses the only thing marking the element as a note, and
  DPUB's own remedy is to make it a list item — a restructure, not an attribute rewrite. A document
  with no such role comes back byte-identical, which is what the loop's change detection and the
  reserialization caution above both need.
- **A `<main>` a page emitted for itself is taken out of the body, not reported.** Same division of
  labour, at the same three points, logged as `page_main_stripped`. A bare `<main>` loses its tags
  and its children are promoted; a `<main lang="ko" id="p3">` becomes a `<div>` keeping those
  attributes, because unwrapping it would drop the `lang` the document's root declaration is derived
  from or an `id` an `href` elsewhere resolves to — a `<div>` is generic, so the landmark is gone
  either way. An explicit `role="main"` is the one attribute the downgrade cannot keep — and any
  later spelling of `role` goes with it, since removing the first one is what makes the second live.
  What it declines is a `<main>` with no `</main>`: the element's extent is whatever the parser
  decides, so both guesses move content into or out of a landmark, and the gate reports it. A stray
  `</main>` is the reverse and is deleted — a parser discards it, so nothing is being weighed, and it
  is the one unpaired shape no rule reports, because inside the shell it closes the document's own
  `<main>` early and everything after it ships outside the landmark with the lint clean. A
  `role="main"` on an element that was never a `<main>` is left to the gate as well: that is a role a
  model chose on an element whose own semantics do not cover it, the same judgement the role strip
  above refuses to make. All three points are needed for the
  usual reason: the assembly join is where extraction's wrappers arrive, an editor round rewrites blocks of the
  body and can introduce one of its own, and a feedback re-run resumes a stored body that was
  written before any of this existed. The prompt is still the primary fix — `agents/page.md` now says the document supplies `<html>`, `<head>`,
  `<body>` and the `<main>`, which is the fact all six benched models were missing.
- **A table printed across a page break is rejoined into one table.** Each page is extracted alone,
  so the agent that wrote the second half had one image and the rest of the table was not on it: it
  ships as a fresh `<table>` repeating the header, and a screen-reader user reading down the column
  gets the header row again mid-data with nothing saying the two are one table (issue #239). The
  halves are *findable* because the second one says so — all 18 continuation captions measured in
  the reference corpus carry a "Continued" marker, in four different spellings, against 48 tables.
  The rule reads that marker anywhere in the caption after a dash, a bracket or a parenthesis:
  requiring it at the *end* drops 4 of the 18, and requiring the `Table N` stem to repeat drops 8,
  because a second half often keeps the title and loses the number. The predecessor is the
  immediately preceding table in document order in all 18.
  The **merge** needs a Copy Editor call wherever the halves do not agree on what to concatenate: two
  of the 18 pairs declare a different column count from their own first half, 13 repeat a header
  block carrying footnote-*reference* ids that an endnote links back to, and a bracketed unit note
  is reprinted with the header and belongs in the joined table once. Only three of the editor's six
  rules hold a judgement, though — the other three are "move these bytes and change nothing" — so the
  join is **tried in code first** and stands down wherever the judgement is real. Measured on 50 pairs
  read out of already-delivered documents, 26 join with no model call and no output tokens, and
  `verifyJoin` refuses none of what the code path produces (#276); the 24 that stand down are 17 whose
  second half describes its columns differently and 7 carrying an id with nowhere to move to. An id on
  the dropped half's own `<caption>` or `<table>` element does move, onto the counterpart that survives
  the join, and only where that counterpart carries no id of its own — two live link targets
  collapsing onto one element is a choice about which link keeps working, and that choice is the
  editor's. Both paths go through the same verification and the same splice, and `table_joined` says
  `by: "code"` or `by: "editor"`, so the ledger can tell a pair the editor was asked about from a pair
  it was not. Three guards belong to the code path alone, none of them visible to the verification
  below, which reads columns, header cells, rows and labels and never reads an id: a half whose span
  parses to anything *outside* its own table is declined, since the parser fosters a stray `<p>` out of
  a `<table>` and `outerHTML` then does not carry it — the one thing this path does that can lose
  content where a model reply cannot; a join that would print one id twice is declined; and so is a
  continued page whose rows run wider than the first half already is, which is what a page that
  reprinted no header at all can do, since then there are no two header blocks to compare. Everything
  around the ask is
  deterministic: which tables are halves (the caption rule), where their bytes are, whether the
  answer kept the table, and the splice. The body is never reserialized — the halves' source spans
  are found by a depth-counting scan and checked against the parsed DOM, and the reply is spliced in
  as a string, for the same reason `anchors.ts` refuses a whole-body round trip. A pair whose bytes
  the source does not delimit is left alone (`table_join_failed`, `unmatched_source`); that is what
  an unclosed `<table>` on a page does, since an unclosed opener swallows the table after it.
  The answer is then verified: one table, a caption without the marker, no column lost, a header
  block still made of `<th>` cells, and the rows accounted for two ways. Labels as a **set**, because
  the duplicated header block legitimately goes and a legitimately dropped duplicate row must not
  read as loss — and over all cells, not first cells, so a label the merge moved along a column still
  counts. And a **count** floored on the sum of both halves, less one header block and the one
  bracketed unit note a continued page reprints. The header credit is the more permissive of two
  readings — one shared block, at the smaller of the two declared depths, or whatever the joined
  table's own depth says went — because each of them is wrong once: the halves declare headers of
  different depths in 4 of the 18 pairs, so the smaller depth alone under-credits a merge that kept
  the deeper block, and reading the drop off the joined table alone charges a merge that *promoted*
  the reprinted unit note into `<thead>` for a row that is still in the table, which cancels the one
  drop the prompt asks for and refuses the same content for sitting on the other side of `<thead>`.
  The shared-block reading is bounded by that same one row, because the two things that deepen a
  joined header are a row promoted into it and a header block *kept*: past one block plus one row,
  the merge is carrying the duplicate header this stage exists to remove, nothing went, and the
  shared-block credit would hand back that block's worth of unlabelled rows. To within one row, that
  is: a reply that keeps a single duplicated header row is inside the bound and can lose one
  unlabelled row with it, which is the size of the drop the floor forgives anyway and indivisible
  from the promotion the prompt asks for. What is ruled out is slack a whole header block deep.
  The count is needed at all because the label set is blind to a row that has no
  label: a printed statistical table gives a multi-line row label continuation lines whose first cell
  is empty, and neither a label set nor a floor at the larger half can see those disappear. Header
  cells are checked because nothing else would: a merged header block returned as `<td>` keeps every
  label, every column and every row, and axe reports nothing on a data table with no headers, so it
  would ship having removed the header association from the tables this stage exists to improve.
  Any failure keeps **both halves byte for byte**, which is what makes this safe to ask a model for:
  unlike a correction round, which adopts a whole new body, a refusal here costs one table's
  structure and not the document. That includes markup no parser can read — jsdom parses by
  recursion and a body nested a few hundred thousand levels deep overflows it, which is reachable
  because `anchors.ts` delivers a page past 500 levels as written, so the failure is caught and the
  document ships as it arrived rather than the phase failing. A failed pair is not asked twice, and
  it is remembered by its two halves' bytes rather than by its caption, since two pairs in one chain
  share a caption and one refusal must not silently cover both. It runs where the pages are joined,
  before the shell and before the lint, so the document the gate cleared and the document the Reader
  reads are the document that ships. Logged as `table_continuations`, `table_joined`,
  `table_join_code_declined`, `table_join_failed` and `table_joins_capped`.
- **A sentence printed across a page break is delivered whole.** Same seam as the table, same reason
  no page could have fixed it, and a different answer: this one needs no model call, because there is
  no judgement in it (issue #248). 22 of 90 page-break markers in the reference corpus stand where a
  sentence carries on, 13 with the sentence's tail in the paragraph immediately before the marker, and
  a reader hears "Only 12 States tax tourist courts. Simi-", then "Page 74", then "larly, the more
  populous States…". The rule is the measured one: the next page opens with a `<p>` beginning with a
  lowercase letter, the paragraph before it ends on a letter, digit, comma or hyphen, and the sentence
  that runs over is moved **forward, past the marker**. That direction is the decision here, and it is
  about what a page anchor means rather than a detail — `<hr>` cannot sit inside a `<p>`, so text has
  to cross the marker one way or the other, and moving the tail forward leaves `#page-74` standing
  immediately before a whole sentence, where pulling the next page's head back would land that anchor
  *after* the sentence it should open on. "A few words" is held to rather than hoped for: at most 500
  characters may cross a marker, because a paragraph with no sentence boundary in it moves *entire*,
  and for a page of unpunctuated prose that would be the whole page's text delivered after the next
  page's anchor — which the argument for the direction does not cover. A word the printer broke
  **keeps its hyphen** and is closed
  up: nothing at this seam can tell "Simi-" + "larly" from "public-" + "sector", `agents/page.md`
  answers the same wall from the page's side the same way, and dropping it would be the one place this
  pass deleted a character the source printed — so what is fixed is the interruption, and
  `word_splits` in the log is what would let a later pass decide the hyphen with data. What it refuses
  matters more than what it joins, and each refusal is counted: a footnote list between the halves (9
  of the 22 — the marker is then not what interrupts the sentence, and a page that *failed* extraction
  is the same shape, since its `@page-failed` comment is a node standing between them), a page between
  them that returned nothing at all (the middle of the sentence may be what is missing, and only this
  stage can tell, because an empty fragment is dropped from the body and leaves nothing but a hole in
  the page numbering), a sentence beginning inside an inline element that opened earlier, two
  paragraphs disagreeing about `lang`, a paragraph carrying an `id` something may refer to, a page
  being shipped byte for byte because the parser and its bytes disagree about it, and more text than
  the bound above. The lowercase test has no signal in Hangul, Chinese, Japanese, Arabic or Hebrew,
  so those sentences still ship split — a join missed rather than a join got wrong, and left there
  because the 22 were measured on an English corpus. Logged as `prose_joined`.
## Extraction: verdicts and empty pages

- **A verdict that cannot be obtained is not a page that cannot be extracted.** `verifyAgentOutput` is
  non-blocking for an absent Feedback Agent and for a reply that will not parse, but a provider error
  is *rethrown*, and the first verify call had nothing to catch it — so a throttled or over-long
  **check** propagated out of the page's own extraction, logged `page_extraction_failed`, and shipped a
  `@page-failed` comment for a page that had rendered fine (issue #364). Measured once on a 100-page
  bench arm: a page extracted as 8,855 characters of HTML — a complete statistical table, 568 words —
  delivered as a 156-byte comment, and **$0.5051 of that page's $0.6634 was the call that deleted it**,
  3.2x what the extraction it was checking cost. The fix is the policy this pipeline already applies to
  every other specialist, arriving one call earlier: a specialist that fails leaves the page as the
  general pass wrote it, and a fidelity check that cannot run is nothing to correct — so no correction
  is bought and the page ships as extracted, which on a page whose only repair would have come from the
  verdict is exactly what an unconfigured deployment delivers. **Exactly, but not on every page**, and
  the exception is worth stating because it is the one axis a reader can check: with no Feedback Agent
  loaded, `verifyAgentOutput` returns a passing unjudged verdict at *both* call sites, so a links- or
  alt-triggered correction reaches the binding recheck, is judged unjudged-ok, and is **kept** — while
  under a throttle that recheck throws too, and the correction is discarded. So a page with a dropped
  `href` ships without it here and with it there. That is the discard decision below, taken knowingly;
  what is not claimed is equivalence on the page it costs something. Three things the misattribution cost
  besides the page, and they are why this is its own `page_verify_error` event rather than a quiet
  `catch`: the delivered document asserted the source pages "could not be extracted", which was false;
  `pages_failed` and every triage of *why* pages fail recorded a vision failure, so anyone tuning the
  page agent on that signal was tuning the wrong agent; and the marker told the operator to raise
  `providers.*.max_tokens`, which buys the verifier room to write **more** about a page it has already
  judged — the wrong lever, pushed the wrong way, on the one line the operator was given. **The second
  unguarded call site was not in the report and cost more when it fired:** the `recheck_binding` gate,
  which throws away a page that had rendered, *passed*, and been corrected — two calls' work, not one.
  There the failure is a decision rather than a default, and it is taken the conservative way: that
  recheck exists to stop a correction bought for one link or one placeholder alt from damaging a page
  that had already passed, so no verdict is no licence, the correction is discarded, and the page ships
  as it was — which is the same answer the branch gives a verdict that *fails*. The correction is
  billed either way, and `correction_discarded` on the line is what says the money bought nothing. **The
  two failures are counted in different places, because they are not the same kind of page.** A failed
  first check makes the page *unjudged*, so it counts as `pages_verify_error`, a subset of
  `pages_unjudged` and so of `pages_verified`, and no published rate moves. A failed binding recheck does
  not: that page has a real first verdict and it **passed**, so counting it as unjudged would put a
  judged page inside the unjudged total. It counts as `rechecks.binding_error` instead — disjoint from
  `binding`, `binding_ok` and `binding_unjudged`, which are fed from the recheck's own verdict line and
  so cannot see a recheck that produced none. Giving it a number rather than only a sentence is the
  point: it is the more expensive shape, and its only other trace is `page_corrected`
  `result: "rejected"`, pooled there with the shrink floor and with a rewrite a second verdict actually
  refused — and those were judged, while this one never was. `pages_verify_error` in turn is kept apart
  from `pages_skipped_blank` because those two point opposite ways
  in money — a blank skip is a call not made and is a saving, an error is a full ceiling of output
  billed for no verdict — and adding them would price the most expensive shape of verification failure
  as a saving. The third verify call, the *sampled* recheck, was guarded already and keeps its own
  older `page_correction_recheck_failed`: it decides nothing whether it answers or not.
- **A page the document has no content for is reported once, not once per chunk.** Two kinds of
  source page contribute nothing: one extraction *lost* (`pages_failed`, and a `@page-failed`
  comment where the content would have been) and one that is *blank in the source*, delivered as an
  empty page because that is what the paper says (`page_blank`). No correction round can act on
  either — a page that was never extracted is not something an editor can repair — but the Reader
  was asked about both, once per chunk: `runReader` gives every chunk the same page index so the
  bytes can be cached, a lost page's entry there was the failure's own marker and a blank page's was
  an empty line, and every call that saw one reported it in its own wording — so no two reports
  matched and exact-string dedupe caught none of them. On the round that filed issue #188 that was 6
  of one document's 26 unresolved issues for a single page, and a longer document has more chunks.
  The delivered list is the *final* round's read (`@unresolved` is written from it), so that read's
  chunk count is the multiplier; what the iterations multiplied was the spend, since every round's
  editor was handed the same reports about a page it cannot repair. Both entries now say what the
  page is and that it is not an issue to report, `READER_SYSTEM` says the same with the reasons, and
  a round's repeats are reduced to one report per page (`reader_page_reports_deduped`, which logs
  what it dropped). The FIRST report is kept rather than all of them dropped: an issue attributed
  entirely to pages with no content can only be about the absence, but that attribution is the
  Reader's, so a misattributed real issue must not vanish without a trace. An issue naming any page
  that *does* have content is never touched. And the Reader is now told which case it is in: the
  HTML section says `window N of M` when the body was split, and only then is a page whose content
  it cannot find someone else's to read — on a single-chunk document the Reader is the only check
  that content went missing at all, and it keeps that licence. **The label is also named as never
  being a defect itself, and so are the window's own cut edges (#274).** Telling the Reader what
  the label means turned out not to be the same as telling it the label is not part of the
  document: benchmarked in the Reader seat, Claude Haiku 4.5 filed the windowing apparatus as an
  accessibility problem in 7 of 163 issues where Sonnet 4.6 filed it in 0 of 197 — three of the
  seven the label proper, once suggesting the fix was to "review the complete document (all 3
  windows)"; two the cut edge; one the corpus artefact the filing disclosed; one a `(CONT.)` report
  too truncated in the log to attribute. Each of those costs an editor call, and that
  round's page images, on a document that is not broken — and since nothing downstream can edit
  the prompt, the issue returns every round. The cut edges are the same shape one step down:
  `chunk()` slices on a character count, so a window can open mid-sentence or mid-tag, which one
  model reported as content lost. Both prohibitions were written because a Reader swap is a live
  option and this is how a prompt that misleads the field goes unnoticed — but not because the risk
  belongs to the cheaper model, which is what the measurement below took away.
  **The incumbent is not exempt — and one pair of runs locates a model, it does not give it a
  rate.** Violations per multi-window document over 20 documents (18 of them long enough to be
  windowed, 45 windows) and two runs of the identical prompt, measured at both Reader prompts this
  repo has shipped: `158e3d9`, and the current `e842faa`, whose *Reader prompt* differs from it only
  by the appended sentence in the bullet below (the builds are four commits apart; the provenance
  paragraph below says why that does not reach these figures). **At `158e3d9`:** `gpt-5.6-luna` **0.00** (0 and 0), the incumbent
  `claude-sonnet-4-6` **0.03** (0 then 1), `kimi-k2.5` **0.25** (6 then 3), `claude-haiku-4-5`
  **0.31** (6 then 5). **At `e842faa`,** same corpus and same design: Luna **0.00** (0 and 0), the
  incumbent **0.14** (4 then 1), Kimi **0.08** (1 then 2), Haiku **0.28** (5 then 5). The thesis is
  stronger at the shipped prompt — the incumbent is second-worst of four rather than nearly clean —
  but the arithmetic that carried it is gone: it is five violations against thirteen over the same
  36 document-runs, and the incumbent's five is *more* than Kimi's three (#308).
  **The prompt change is not the lever, which is what four models measured at both shas are for.**
  All four were given the same appended sentence. The incumbent rose by four violations, Kimi fell
  by six, Haiku fell by one and Luna did not move. There is no common direction, and every per-model shift is
  the size of that model's own spread between two runs of the *identical* prompt: Kimi's two runs at
  `158e3d9` differ by 3 violations, the incumbent's two at `e842faa` by 3. So a pair of runs resolves
  a model to within a few events on 18 windowed documents, and no more than that — which is also why
  #274's "0 of 197" was a sample rather than a property. What does reproduce is what has four runs
  behind it: **Haiku is the worst violator at both prompts** (6, 5, 5, 5) and **Luna files none at
  either** (0, 0, 0, 0). Four more models file 0 violations and never mention a window at all, on
  one run each at `158e3d9`: `pixtral-large-2502` (231 issues), `gemma-3-27b-it` (111), `nova-2-lite`
  (75), `qwen3-vl` (11). Read the last two as silence rather than compliance, but `pixtral-large`
  files more issues than the incumbent's 187 in the same round, so it is a second credible zero on a
  quarter of the evidence. **Compliance does not track price, in either direction**, which is the
  part to carry into a swap, and it reads more sharply at the shipped prompt than it did before: the
  cheapest model in the field is the most compliant (Luna **$0.0165** per document at 0.00), the
  second-cheapest is the worst (Haiku **$0.0358** at 0.28), and the dearest sits between them (the
  incumbent **$0.0931** at 0.14), with Kimi at **$0.0207** and 0.08. `pixtral-large` files 0 at
  **$0.0721** — dearer than Haiku, and still one round at `158e3d9`, its price as much a single
  sample as its zero. So "a cheaper Reader is the risk" is not the rule and neither is its inverse;
  the number has to be measured per candidate (#301).
  **More prompt text is not the remedy, and the evidence is inside the violations.** In the
  clearest cases the model states the rule correctly and files anyway, in the same issue: the
  incumbent identified a seam as an interior one — "this is the document's window boundary edge and
  not the document's own close" — and then asked that window 2 be verified, which is the specific
  thing this paragraph forbids, while Kimi put "window boundaries are not document defects" in the
  `suggested_action` of an issue whose entire content was the label. The failure is not
  comprehension, so the wording stays as it is. A keyword filter on "window" would be worse than
  the problem, for the reason the exemption exists: the same sentence, "ends mid-sentence", is a
  violation at an interior seam and a *required* finding at the last window's end — which the
  incumbent's other run got right. The code-side prose filter stays declined on its own measured
  ground (prose matching fails at 2%, and its false positives delete real findings).
  **The same behaviour has a wider form that is not about windows and is not about this prompt: an
  issue whose own `suggested_action` says nothing needs doing.** Per document, counting issues rather
  than documents, over the same four rounds: Kimi **1.10, 0.70, 1.25, 0.75** — roughly one per
  document at both prompts, 6%–9% of everything it files — the incumbent **0.00, 0.05** at `158e3d9`
  and **0.30, 0.05** at `e842faa`, Haiku **0.20, 0.25** then **0.15, 0.10**, and Luna **0.00** in all
  four. It is a standing charge on the models that do it, largest by an order of magnitude on the
  candidate these bullets measure most often, and it is *not* an effect of the appended
  sentence: Kimi's rate is unchanged across the two prompts, Haiku's falls, Luna's stays at zero, and
  the incumbent's rise is 6 issues in one run against 1 in the other (#307). Adding a clause that
  says a discarded observation is not written down anywhere — not as reasoning and not as an issue
  asking for no change — is a plausible fix and is *not* in the prompt, because the case for it rests
  on a per-model rate that one pair of runs cannot resolve, and because changing these bytes restales
  every Reader figure on this page. What would settle it: the clause as an arm against the shipped
  prompt, two runs each, on the incumbent and Kimi, scoring self-cancelling issues per document
  alongside issues per document so a drop in the first is not bought with a drop in the second.
  `node selfcancel.mjs <rounds> --rows` prints every match; its detector is a text heuristic rather
  than one of Iris's predicates, which is why it prints them.
  **What this asks of a Reader swap** is that the count travel with it, because it is a recurring
  charge: every violation reaches the Copy Editor as work on a document that is not broken, no edit
  can change Iris's prompt, so the issue is filed again next round. Compare **violations per
  multi-window document** — not per issue, since a model that files more issues is not thereby less
  compliant, and not per document, since a corpus of short bodies cannot show the defect at all (a
  single-chunk body carries no label; `test/no-content-pages.test.ts` pins that) — over **two runs,
  not one**. It costs nothing once a round exists: `node windowviol.mjs <round>` in
  `equalify-iris-bench`, which prints every row so the classification can be argued with. **Every
  figure above is labelled with the Iris sha it was measured at, because that is how the first
  version of this bullet went stale within the hour:** it was committed with figures from
  `runs-reader-probe` and `runs-reader-selfagree`, both at `158e3d9`, fifty minutes after `e842faa`
  changed `READER_SYSTEM` — the change the bullet below asks to have this very count re-measured on
  (#308). The `e842faa` figures are `runs-reader-newsha` and `runs-reader-newsha2`; all four rounds
  are re-derived here rather than quoted.
  The published $/doc figures are `runs-reader-newsha` and `runs-reader-newsha2`'s `usd` over their
  succeeded documents — the same pair as the `e842faa` violation counts, so both halves of the
  price-and-compliance sentence come from one pair of rounds, and a model's price spans exactly the
  rounds its violation count does. That leaves the four one-run models as one sample on both axes,
  `$0.0721` included, still at `158e3d9`. **These prices meter the Reader and nothing else**, which is
  what makes a price comparison across two shas an A/B on the prompt rather than on the four commits
  between them: every priced call in all five rounds is `agent: reader`, `step: read` — 945 of them,
  with no extraction, editor or verify call in any round. The harness drives `runReview` with
  `ctx.maxReviewIterations = 0`, and that is the part doing the work: `runReview` calls `runEditor`
  whenever the Reader returns issues, which on these rounds is every document, so it is the cap that
  breaks the loop before the editor, not the entry point.
  The four commits between the two shas do touch this file, but on the editor path — #295 and
  #300's truncation salvage — and the only change they make to `READER_SYSTEM` itself is the append,
  which is the one line of `git diff 158e3d9 e842faa -- src/pipeline/review.ts` that lands inside the
  template.
## The review loop

- **The Reader replies with JSON and nothing else, and that sentence is tuned to the model in the
  seat.** `READER_SYSTEM` has always ended "Respond with ONLY JSON:", and the incumbent narrated
  anyway: 40% of the characters it wrote sat outside the JSON envelope, over 5 documents. Nothing
  could see it, which is why it lasted — `extractJson` takes the *last* envelope in a reply, so a
  preamble parses, no call fails, and no log line says that a third of the step's output was prose
  billed at output rates. One appended sentence removes all of it: **output tokens −29%** (3,635 →
  2,574 per document), **$/doc −13%**, prose 40% → 0% of characters — and, in the unit the
  re-measure list below asks for, **91% → 0% of replies** (10 of 11 narrating in the control, 0 of 11
  in the treated arm, over the same five documents). Both units are given because a swap is told to
  record the second one.
  **The incumbent's half of this reproduces at eight times the size**, measured at the shipped prompt
  against the old one over 20 documents and two runs per side: output **2,698 → 1,778** tokens per
  document (**−34%**), **$/doc −13.2%** ($0.1072 → $0.0931), and prose **0.0% over 90 replies** — not
  one character outside the envelope, by Iris's own `extractJson`, with `` ```json `` fences excluded.
  The
  margin is what makes it a result rather than a draw: the incumbent's two runs at the shipped prompt
  price within **1.5%** of each other, so −13% is many times its round-to-round spread. Issues per
  document did not move (**9.93 → 10.28**, and the old prompt's three rounds — 9.35, 9.70, 10.75 —
  bracket both new ones) (#307). It also
  finds **more** rather than less —
  12.6 issues per document against 10.8, 129 quoted spans against 96, and a finding's cited page
  matching the page order 93% of the time against 84% (citations matching neither the order nor a
  printed folio: 15% → 2%). One metric moved the other way and belongs in any re-measurement of this:
  **quote fidelity 90% against 93%** — the share of quoted spans findable in the document — with
  off-document references at 0 in both arms. The comparison needs its floor stated or it reads
  backwards: two runs of the *identical* prompt over the identical documents reproduce only **57%** of
  each other's quote-anchored findings, so the terse arm reproducing the control at 61% is not damage
  — the Reader does not reproduce itself to begin with (#299).
  **The saving is a property of the model in the seat, not of the prompt**, and that is the part to
  carry forward — but the figure this bullet gave for the other seat was measured at five documents
  and does not survive forty, in either direction. It said the sentence takes `kimi-k2.5` from **13.6
  issues per document to 8.8** at **6% more** per document: fewer findings for more money. Over 20
  documents and two runs per side it is **11.75 → 12.80** issues per document at **−5.0%** $/doc, both
  signs reversed. Neither reading is the one to carry forward, because both changes are smaller than
  Kimi's own spread between two runs of the *identical* prompt: its issues per document are 13.8 and
  9.7 at the old prompt, 13.45 and 12.15 at the shipped one, and those two shipped runs price 8%
  apart. **The measured answer on Kimi is that neither its finding count nor its price moved
  resolvably** — the trade the old figures described, and the better trade their reversal describes,
  are both inside the noise (#307).
  **The reason first given for the "property of the seat" claim was wrong too, and correcting it
  changes which number a swap should record.** This bullet said Kimi's control "already writes 0% prose", from a 5-document
  draw. Re-asked at 20 and 50 documents over the same persisted replies, Kimi's character share is
  **38.8%, 30.0% and 9.6%** across three rounds — never 0%, and in one round higher than the
  incumbent's 36.1% over the same documents, so the claim inverted rather than merely wobbled
  (#305). And in the deciding round Kimi's *treated* arm wrote **more** prose than its control, not
  less: **1 of 11 replies narrating in the treated arm, 0 of 11 in the control**, and that one reply
  carried 51% of the treated arm's characters. The sentence did not suppress prose on that model; the
  number simply moved with one reply. At forty documents the same holds with the sentence *shipped*:
  Kimi's prose is **23.8% of characters in one run of 45 replies** — two replies, one of them 98% —
  and **0.0%** in the other. Where the incumbent goes to 0.0% over 90 replies and stays there, Kimi's
  share is decided by whether the run caught one of its rare narrating replies, prohibition or not.
  The 40% for the incumbent replicates: **33.0%–40.4%** over **202 replies** written, four
  rounds and two ways of cutting the same corpus — 201 of them classified, since one parses only
  through Iris's repair path, so its envelope's span cannot be pinned and it is excluded from the
  shares rather than estimated. A 5-document draw of that reads 0% in 0.0% of resamples.
  **The difference is the shape, not the sample size.** The incumbent narrates a little in most
  replies — **67%–75% of them** across the four twenty- and fifty-document rounds — so five documents
  see it. The ablation's own five-document control reads **91%**, which is not a fifth value so much
  as a demonstration of the band below: 91% is the top edge of what a five-document draw of these
  rounds produces (p95 86%–100%). Kimi's median reply is a bare envelope and it narrates in
  **7%–16%** of replies across its three large rounds, going to 87%–99% prose when it does, so any
  aggregate is decided by whether the draw caught one: five Kimi documents read exactly 0% in up to 46% of
  resamples and anywhere from 0% to 87% overall. Its median reply being prose-free is what makes the
  sentence buy it little, and that part holds in all three rounds.
  Since the Reader's model is a config key and not a code change (`providers.per_agent.reader`, plus
  block-wide `providers.bedrock.api: converse` for a non-Claude id — docs/models.md §3), **swapping it
  means re-measuring this**, and prose share is not a model trait to look up in either form.
  **What to re-measure**, then: the **share of replies containing any prose** — not the share of
  characters, because the reply share separates these two models in every round measured — the
  incumbent 67%–75% over the four large rounds and 91% in the ablation's control, Kimi 7%–16% over
  the three large rounds and 0% (control) to 9% (treated) in the ablation — where their character
  shares overlap, and because it is the population the sentence acts on.
  **It is not the cheaper measurement, and the reason is worth stating precisely,
  because the two statistics fail at n=5 differently.** Resampled at five documents the reply share's
  band is *wider* in points than the character share's on the incumbent (35–50 against 21–24) and
  *narrower* on Kimi (20–30 against 26–66) — so "tighter" is not a property either one has. What both
  have is the same failure on the model in question: the reply share still reads 0% for Kimi in
  **12%–48%** of draws, against the character share's 40%–46%. Five documents are adequate for the
  incumbent on either statistic and inadequate for Kimi on either, so the reply share buys a figure
  that holds from round to round and buys **nothing** at n=5 — measure two runs of twenty documents
  regardless of which unit you record.
  Then output tokens per document, issues per document, quote fidelity, and the same
  prompt run twice so the reproduction figures have a floor. Violations per multi-window document
  (#301) and self-cancelling issues per document (#307) are part of the same swap and want the same
  two runs, so measure them here rather than separately — the second one because it is a per-model
  charge on the Copy Editor, not a property of this prompt.
  All of it is free once a round exists — every Reader round persists its raw replies,
  and `node proseshare.mjs <round>` in `equalify-iris-bench` locates the envelope with Iris's own
  `extractJson` rather than a regex. The figures here are its four rounds `runs-reader-selfagree`,
  `runs-reader-probe`, `runs-reader-third` and `runs-reader-persource`, at Iris `158e3d9`, and the
  n=40 figures are `runs-reader-newsha` and `runs-reader-newsha2` at `e842faa`; the two
  arms of the trade — control and treated, each labelled, in both units — are the five documents of
  `runs-reader-ablate2`, which is the round the sentence was decided on and the only one holding a
  treated arm. A
  `` ```json `` fence is counted apart from narration: on a 670-character reply 12 characters of
  fence read as 1.8% and cross a 10% threshold, which is enough to rank the tersest model in the
  field as one that narrates. The prompt side of the trade is one 180-character sentence
  that rides inside the cached prefix on a Claude Reader and is paid in full on every chunk of every
  round on one that gets no breakpoint — the same population where it may buy nothing. (The filing
  measured that as +86 prompt tokens **per document**, 29,747 → 29,833, which is the sentence sent
  once per window rather than once per document.) The effect of any change here is visible without new
  instrumentation: `by_step.review.output_tokens` in the run's diagnostics is the number that moved.
- **Copy Editor image payload.** When every issue in a round is attributed to a page, the
  editor gets only those pages' images (logged per round as `editor_images`). Attaching every
  page's image on every round is the dominant per-round cost of the review loop — on a 25-page
  document that is 25 base64 PNGs × up to `max_review_iterations`. Narrowing requires *full*
  attribution: one unattributed issue re-broadens the round to every image. An unattributed issue
  is usually structural and fixable from the HTML alone, but it is also what a heavily
  editor-rewritten body looks like once it no longer matches the source excerpts — so narrowing
  wrongly can leave a real issue unfixed at the iteration cap, while broadening wrongly costs no
  more than the behavior this optimization replaced.
- **A correction round may not replace the document with a fraction of it, and the floor reads
  prose.** A reply that answered about one section, or summarised, or quoted the contract back
  after answering arrives shaped like a corrected document, and the blast radius is the
  deliverable rather than one page (issue #174). It applies to all three shapes a round can take:
  the joined result of a patch (a reply that empties most of the document's blocks), the whole
  body a model hands back under the old contract, and each section on the truncation fallback. A round that comes back with under half the prose
  of the body it was given is now refused, the body that entered is kept, and the loop is free to
  spend another round asking again (`editor_shrank`; the same floor per section, as
  `editor_section_failed` `reason: "shrank"`). Which of the three readings on the `editor` line
  carries the floor was the open question, and the measurement answered it: across the four
  legitimate rounds that record all three, the prose sizes land at 0.997–1.006 of the input while
  the other two move hard on rounds that were working. Unwrapping a mis-structured document keeps
  every word and loses half the *bytes*, which is one of the corrections this loop exists for; and
  one of those rounds rewrote a 55-item `<dl>` into list items — `terms` 55 → 3, a ratio of 0.055 —
  while its prose moved 0.3%, so no threshold on a *structure* count both permits that and refuses a
  reply carrying a fifth of the document. A half rather than the page path's quarter, because the
  populations are further apart here (one section of these bodies is 0.016–0.379 of it) and the
  costs are asymmetric: refusing a good round costs that round's corrections and says so in
  `@unresolved`, while accepting a fragment costs the document. The one legitimate round that can
  approach a half is the deletion the editor's own prompt sanctions — the same content rendered as
  both a form and a table, where dropping the table drops the copy carrying more prose — and on a
  body that is mostly such a pair the round is refused and its other fixes go with it; that cost is
  taken knowingly and is on the log with both sizes. Bodies with under 1,000 characters
  of prose are not judged at all — the legitimate deletions are otherwise fixed-size, so on a short
  body a single resolved `[page not fully transcribed]` marker is half the prose. The initial page render
  is the third path that adopts `html` wholesale and is deliberately still unguarded: it has no
  before-page to compare against, so a floor there is an absolute plausibility check on what a page
  image that carried text may produce, which is #116's question and not this one's.
- **The Copy Editor answers with the blocks it changed, not the document retyped (issue #250).**
  Asked for the complete corrected body, the length of the editor's answer was a property of the
  DOCUMENT rather than of how much was wrong with it: a mean reply of ~26,600 encoded tokens
  across 34 delivered documents, with 15 of the 34 unable to fit under the ceiling at all, which
  is the mechanical cause of a 58% `editor_truncated` rate — and a cause no choice of model can
  move, since a model cannot emit a reply longer than its output ceiling. The blocks a round
  actually touches come to ~1,211 tokens. So the body is shown to the editor with a
  `<!-- @block N -->` comment above each of its top-level elements, and the reply is
  `{ "edits": [ { "block": 7, "html": "..." } ] }` — every block nobody names is delivered byte for
  byte. `html: ""` deletes a block, which is how content the document prints twice goes; one edit
  may carry several top-level nodes, which is how a fix splits a block. The anchor is a block
  POSITION rather than an id because ids do not reach the work: of the 13 defect instances the
  structural checks of `src/pipeline/markup.ts` find in those documents, *none* sits on an element
  with a usable id and none has an ancestor carrying one, since Iris puts ids on what gets linked
  *to*. (Those figures were corrected in issue #268; the count this used to quote called a `lang`
  on a void element a defect whatever text it carried in an attribute, and 54 of its 73 instances
  were correct authoring. The correction runs the same way: an id anchor reached one defect in six,
  and reaches none of the 13 that survive the recount.) And the number is written above the block rather than
  counted by the editor, because a model counting for itself could be off by one, land in range,
  and have every replacement applied to the wrong block with each one well-formed — the one failure
  here that nothing downstream could see. A replacement that leaves an element open is refused and
  that block keeps its original text (splicing a fragment in would close its tags with whatever
  followed), and so is one carrying an end tag that closes nothing, which a parser ignores and which
  would put an unbalanced tag into the delivered bytes; an unknown or repeated block number, an
  unreadable entry and an echoed marker are each counted on `editor_patch`, so a reply that did not
  follow the contract says so in the log rather than in the document. Two cases are NOT applied in
  part, and `discarded` on that line says which: a reply where nothing could be used, and a reply
  holding a refusal alongside a block that gave content up — because a move is a pair of edits here,
  so taking the source half and refusing the landing half deletes a paragraph that no later pass can
  miss. Both forms of that source half count, since the prompt offers both: emptied (`deleted`), or
  returned with what is left of it (`shrunk`), and the shrinking one is the commoner. A shrink is
  read as the prose, so that unwrapping a mis-structured block is not taken for content leaving,
  plus the `<img>` and `<a>` counts, because a block that hands back its caption and drops the image
  gave up something no comparison of words can see — and, for the same reason, a heading that stops
  being a heading with every word left in place, which takes a reader's only means of finding that
  content while every size on the line says the round was clean. Headings are folded across `h1`-`h6`,
  so re-levelling one does not move the count. Each of those
  is an ordinary correction alone, so the rule only fires on a reply that already has a defect in it.
  What the DOCUMENT lost is a separate reading at a separate grain (`navigation_lost` on the same
  line): headings, list items and table rows counted on the body the blocks assemble into, so that a
  sanctioned reorder — a heading moved from one block to another — is silent where the per-block
  reading has to speak. The list items and table rows there are a measurement and do not gate at all,
  because content leaving one of those can land in another structure a reader can still navigate.
  Both hand the body back and let the loop retry. A model that answers with a whole `html` body anyway is
  still read, and logged as `editor_whole_body`: refusing it would spend the round, and the #174
  floor guards that path as it always did. What it does cost is measured on the same line — the
  document that model was shown carries the markers, so a reply that retypes it brings them back;
  they are stripped and counted, because delivering them would put Iris's request scaffolding in the
  HTML and would compound, a comment being a top-level node that becomes a block of its own next
  round. The section fallback
  stays for the case the contract does not fix — one top-level node bigger than the
  ceiling — and its prompt now says outright that a section request carries no numbered blocks,
  because it is built on the same system prompt and a prompt that is true about one request and
  silent about the other reads as true about both.
- **The flattened screen-reader view must never lose text.** `flatten.ts` has two
  consumers, and both fail *silently* when text goes missing: the Reader reviews this view
  instead of the source images, so anything absent from it cannot be reported as an issue; and
  `contentCoverage` measures a candidate agent against an accepted fixture using these words, so
  text the view can't see is absent from both sides of the comparison. The second is the sharp
  edge — the regression gate exists to stop an agent update from dropping content, and it scored
  a table whose every row had been deleted as *perfect*, because the old implementation emitted
  a table's `<caption>` and returned. Inline elements (`a`, `img`, `em`, …) are now announced
  within the surrounding phrase and block elements are separate stops, with tables expanded row
  by row; `test/flatten.test.ts` asserts the invariant mechanically by deriving the expected word
  set from the DOM independently of `flatten`. Both halves of that inline/block split recurse, so
  the same pathological nesting the assembler delivers rather than drops would overflow the stack
  here and throw — losing *all* the text, the worst form of the failure. The walk therefore falls
  back to an iterative pass that keeps words and reading order and gives up structure, which is
  the trade the view already makes for a block inside a table cell. Role markers are stripped
  before the coverage comparison anyway, so a marker-free view scores identically while a dropped
  word still registers.

  Two rules follow from `contentCoverage` stripping `[...]` before it compares words, and both
  are easy to break by accident. **Everything `flatten` adds itself must be inside brackets** —
  including annotations that read like prose (`[3 rows, 2 columns]`, `[empty]`, `[spans 3
  columns]`, `[alt missing]`) and a control's `type`, which a screen reader announces as its
  role. An unbracketed annotation is counted as a word the agent produced and is reproduced free
  by any candidate emitting a similar structure, which pads the ratio: `(2 rows, 3 columns)`
  alone moved a fixture that had dropped a table row from a true 0.833 to a reported 0.875,
  across the 0.85 gate. **And a field's text lives in its attributes, not its child nodes** — so
  every code path must announce fields through the one shared helper. When only the block path
  did, a field inside a table cell or an inline wrapper contributed nothing and a form-as-table
  with every value emptied scored 1.0. `test/flatten.test.ts` enforces the first rule generically
  (nothing outside brackets may be a word the source document doesn't contain) rather than by
  listing known markers, which is what let the parenthesised ones slip through initially.

  A third rule, learned the same way: **an accessible name can live in an attribute**
  (`aria-label`, `title`), so those count as announced content — an agent update that dropped
  every `aria-label` scored 1.0 before and 0.3 after. The test baseline deliberately collects a
  *wider* attribute set than `flatten` reads, because when the two lists matched the baseline
  shared the code's blind spot and no attribute loss could fail a test. A baseline derived from
  what the code looks at is not independent of the code.

  The prompt and the markers are one contract in the other direction too: `test/flatten.test.ts`
  asserts `READER_SYSTEM` advertises no marker `flatten` never emits (`[Option]` was documented
  and unreachable), and every annotation that explains *correct* markup — `[spans N columns]`,
  `[spans N rows]`, `[decorative, alt empty]` — exists because the prompt tells the Reader that
  an unexplained mismatch is a defect, and the Copy Editor is licensed to restructure tables.
  Adding a check to that prompt without the annotation that reconciles it turns the review loop
  into a false-positive generator aimed at accessible output.
## Learning from feedback

- **Both sides of the eval gate must score fixtures by the same rule.** Before proposing
  an agent update, Iris compares the candidate prompt's mean fixture coverage (from
  `regressionGate`) against the current prompt's (from `evalAgent`) and blocks a drop of more than
  `EVAL_REGRESSION_EPS` (0.02). That comparison is a subtraction between two means, so it is only
  valid if both are computed identically — and they were not. `contentCoverage` returns `null` for
  a fixture whose accepted text is under `MIN_COVERAGE_WORDS` (8) because one dropped word would
  swing the ratio; `regressionGate` excluded those from its mean, while `evalAgent` scored them a
  perfect **1**. Since abstention depends only on `accepted_html`, the *same* fixture abstained on
  both sides, so the 1 landed on the current-prompt side alone and inflated it. With
  `MAX_GATE_FIXTURES` = 3 that is large: two judgeable fixtures at 0.90 plus one unjudgeable gave
  current 0.933 vs candidate 0.900 — a 0.033 gap from padding alone, past the 0.02 threshold. The
  gate discarded updates whose measurable coverage was *identical*, logged as `eval_regression`:
  a reason naming a regression that had not happened. A single `fixtureScore` helper now defines
  the rule for both, and an abstaining fixture is absent from both sides rather than scored.
  Note the direction — the failure mode here is a **false block**, not a wave-through, which is
  why it was invisible: a learning loop that silently declines to learn looks like a loop with
  nothing to learn. A mean over zero measurements is `null`, not 0 — the caller treats that as
  "nothing to compare" and defers to the regression gate, since 0 would block every update and 1
  would assert a score no fixture demonstrated.

  No output at all is scored 0 rather than abstaining, because producing nothing is a *failure* on
  the fixture, not an absence of evidence — abstaining would let a prompt that returns nothing
  score as well as one that handles it. That is also the one input where abstention is **not**
  purely a property of the fixture: whether a prompt produced output is a property of *that
  prompt*, so one fixture can be scored 0 for one side and excluded from the other.
- **The eval gate is a *paired* comparison, per fixture.** The rule above is right about
  what a score means, but averaging each side over whatever it happened to measure compared two
  different fixture sets — and in one direction that waved a real regression through. If the
  **current** prompt flaked to no output on a fixture the candidate abstained on, the current mean
  was *deflated* and the bar dropped: one such fixture plus one judgeable at 0.98 gave current
  `(0 + 0.98)/2 = 0.49` against a candidate at 0.88, so `0.88 < 0.49 - 0.02` was false, 0.88
  cleared the 0.85 floor, and a real 0.10 coverage regression passed both gates. Note this is the
  *opposite* direction from the false block above — the same asymmetry, read from the other side.

  Both scorers now return per-fixture scores and `pairedMeans` averages only the fixtures **both**
  prompts could be scored on, so a per-prompt exclusion drops the fixture from both means instead
  of moving the threshold. Deliberately, a current-prompt flake is treated as evidence for neither
  side: it is a problem with the current library agent, and lowering the bar is the one response
  that hides both it and any regression behind it. It stays visible in the `eval_gate` log line's
  `unpaired` list. If no fixture is measurable on both sides, both means are `null` — "nothing to
  compare", deferring to the regression gate, rather than a pass.
## The provider adapters

These are the rules both adapters enforce on a model call. The README states the config keys
(`max_tokens`, `providers.bedrock.api`, `providers.per_agent`); this is why each rule exists.

- **A per-agent key Iris cannot route does not stop the run.** An unrecognized name in
  `providers.per_agent` simply finds no override and takes the normal fallback, so the swap does not
  happen and the document arrives at the price it would have cost anyway. Boot warns about a key it
  cannot route (`perAgentKeyWarning`), and that warning is the only place the *key* can be named —
  `by_agent.<agent>.models` in diagnostics names the model ids that agent's calls actually went out
  on, never what was ignored. Both of this repo's own example configs had carried an unroutable key:
  `config.example.yaml` a `table` no call site has ever dispatched, and the retired requirements
  document an `image_analysis` that went with the triage step it named.
- **A response that stops at the output ceiling is a failed call, not a short one.** It arrives as a
  200 with HTML cut mid-tag, which would otherwise be assembled into the deliverable as if it were
  genuine content. Both adapters reject it and the error names the knob to raise. A ceiling the
  *model* enforces below `max_tokens` is a different failure — several non-Claude models on Bedrock
  refuse the request rather than clamping it, so a config-only model swap would fail every call —
  and the Bedrock adapter survives it: the rejection states the model's own ceiling, so the call is
  sent again at that ceiling and that number is what every later call to the model asks for in the
  same process, with a warning (once per model) naming `max_tokens` as the setting to fix. The cost
  of the swap is therefore one rejected request per call already in flight when the first is refused,
  and none after that; a request Bedrock never read is not billed. Because the pages then arrive,
  the wrong setting has no other consequence anyone downstream can see — so every clamped call also
  carries `output_ceiling_clamped` on its `model_call` line, with the ceiling asked for and the one
  granted (§7 of [API.md](API.md)). The warning is once per process, the log line is once per call:
  an aggregate over run logs is the only place a `max_tokens` nobody chose shows up.
- **The limits are about *silence*, not duration.** Both adapters **stream**, to tell a stalled call
  apart from a slow one. A single non-streaming request cannot: "no answer yet" describes a dead
  socket and a large document being correctly rewritten equally well, so a total-duration cap kills
  both — and the review phase's document-level rewrite (the whole body in, and every block the
  editor changed back out) is the call slow enough to be killed. So there are three limits in both
  adapters. **120s** to produce anything at all, since before the first token a slow call and a dead
  one look identical and that phase is where the whole prompt — a document plus its page images —
  gets processed. Then **60s** of silence once output is arriving, where a gap really does mean the
  stream died. Work that keeps arriving runs as long as it needs, bounded only by a deliberately
  generous **15-minute** backstop for a stream that trickles without ever finishing. Protocol events
  keep a call alive but do not end the start-up phase: only actual output does, so a stream that
  opens with a role-only delta or a `message_start` still gets its full 120s. Each limit is a
  distinct error naming which one it hit and how much had streamed, since "never started", "stopped
  halfway" and "never converged" call for different responses.
- **A keepalive is not progress** in either adapter — Bedrock's `ping`, OpenRouter's
  `: OPENROUTER PROCESSING` comment. Letting one reset the clock would defeat the timeout in the one
  case it exists for: a generation that hangs behind a connection that stays chatty.
- **A stream ending is not a response completing**, and the two are checked in both directions. A
  terminal event (`message_stop` / `[DONE]`, or a stop reason) is required, because an event stream
  that stops early would otherwise deliver a half-corrected document as a successful result — the
  same failure the truncation guard exists to prevent, arriving by a different road. Conversely the
  terminal event ends the read then and there, so a connection held open after the message is
  finished cannot let the silence clock discard a whole document. *Which* event is terminal is a
  property of the wire format rather than of the word "stop": on Bedrock's Converse stream the
  `metadata` event carrying every token count arrives **after** `messageStop`, so the read ends at
  `metadata` there — breaking at the stop event, the literal translation of the Anthropic path, would
  report every Converse call as free. That tail gets a single short window of its own (**10s** from
  the stop event, not per frame) rather than the idle clock, and once the message has stopped **no
  tail failure fails the call**: running out of the window, a stream error, a throttling exception,
  even the 15-minute backstop all end the read and return the document. There is nothing left to
  protect at that point but a number, and spending a minute waiting for it and then discarding a
  finished document would be the worse trade. The price is that a Converse stream error arriving
  after the message is absorbed silently; what a reader sees of it is a call reporting no usage,
  which diagnostics already counts (`tokens.calls_reported`). The same failure one event *earlier*
  still fails the call, which is the line that makes absorbing it safe: before the stop event the
  document is not whole.
- **Stopping is not the same as finishing**, and which stop reasons mean "the answer is whole" is a
  shorter list than which exist. The Anthropic body stops only for `end_turn`, `max_tokens`,
  `stop_sequence`, `tool_use` or `refusal`, so one truncation check covered every incomplete case;
  Bedrock's own `StopReason` adds `model_context_window_exceeded`, `malformed_model_output`,
  `malformed_tool_use`, `content_filtered` and `guardrail_intervened` — each of which arrives on a
  well-formed stream and would otherwise pass every check above and deliver partial HTML as a
  success. The adapter therefore allowlists the reasons that mean whole and fails on the rest, so a
  reason a future model invents is refused rather than trusted. The allowlist governs **both**
  dialects: nothing an Anthropic body can send today falls outside it (Iris configures no server
  tools, guardrails or context management), so the live path does not move — what changes is the
  direction it fails in when that stops being true. The ceiling keeps its own error (it is the one
  with a knob to name); running out of context window is reported as a size problem, which routes it
  to the same retry-without-images path Iris already uses when a request is refused for size up
  front — one place where that path names a call that was billed in full rather than refused before
  it ran.
- **Provider retries are not symmetric in code, but are in behavior.** OpenRouter retries by hand
  (3 attempts, exponential backoff) because `fetch()` has no retry strategy. Bedrock has no retry
  loop *on purpose*: the AWS SDK already applies its `standard` strategy — also 3 attempts with
  exponential backoff — to throttling, 5xx, and node network errors, while failing fast on 4xx.
  Verified empirically against a stubbed request handler (3 wire attempts for 503/429/ECONNRESET,
  1 for a 400). Adding a loop around it would give Bedrock 9 attempts to OpenRouter's 3.
- **The Bedrock adapter speaks two dialects**, chosen by `providers.bedrock.api`. `invoke` (the
  default) is `InvokeModelWithResponseStream` carrying an Anthropic-native body, and it is what every
  published number in this repo was measured through. `converse` is `ConverseStream`, whose request
  and response shapes belong to Bedrock rather than to a model vendor — and it is the only one of the
  two that can reach a non-Anthropic model, which `providers.bedrock.default_model` has always looked
  like it could (#178). It is off by default because parity between them is an empirical question
  about a live endpoint: the request bodies differ in every field, and no test here talks to AWS. So
  the key is there to be measured with, not to be assumed — a one-page probe and one bench round on
  `converse` are what would move the default. An unrecognized value falls back to `invoke` and says
  so at boot, because both dialects just return text: without the warning, a deployment that meant to
  be trying Converse would be measuring the path it already had. Every `model_call` line carries the
  dialect it went out on (`api`), since the point of the switch is comparing the two and a comparison
  whose run log does not say which side produced a number is not one.

## Running the service

- **`GET /v1/sessions` pages on a compound cursor.** The endpoint was specified with a `cursor`
  parameter and no statement of what is in it, and the obvious reading — the last row's
  `created_at` — is unsound: `created_at` is a millisecond timestamp assigned by a request
  handler, so a burst of uploads ties on it, and paging on a non-unique key skips rows
  (`created_at < ?` drops the rest of a tied group) and can repeat them (nothing pins the
  order among ties). `next_cursor` is therefore `"<created_at>|<session_id>"`, the full sort
  key; clients pass it back verbatim. A cursor that doesn't parse is a `400`, not a silent
  restart at page one, and `next_cursor` is `null` on a full final page — so clients stop on
  a null cursor rather than on a short page.
- **Runs are queued, and the queue is in-process.** A bounded FIFO queue
  (`src/util/queue.ts`) caps concurrent pipelines at `defaults.max_concurrent_runs`; sessions over
  the cap wait in `queued`. Two things this deliberately does *not* do. It does not persist: the
  queue lives in the process, so a restart loses waiting runs — they are marked `failed`
  ("interrupted (server restarted)") by the same `failStaleSessions()` sweep that already handled
  interrupted `running` sessions, which is why that sweep covers `queued` too. And it does not
  bound upload memory: multer parses the whole body before any handler runs, so by the time the
  queue sees a session its images are already buffered in RAM (ceiling: multer's own
  `limits.fileSize` × part count) and any PDF is already rasterized to full-page 150-DPI PNGs.
  Both are consequences of the single-instance, single-process design the store declares.
- **The model's input limits are Iris's input limits, and they live in one file.** An uploaded
  image is handed to the vision model byte for byte — nothing resizes or re-encodes it — so what
  the model accepts is what Iris can accept, and every such number is therefore a fact about a
  configured model or provider rather than about Iris. `src/providers/imageLimits.ts` holds all
  of them (the per-provider per-image byte cap, the hard 8000 px ceiling, the per-generation long
  edge, the format allowlist, the one sentence of advice) and resolves them through the same
  `resolveAgentModel` the router uses, taking the *strictest* value on each axis independently
  across the four agents that are handed a page image. Everything downstream reads from there:
  the upload check and its `400`, `GET /v1/limits`, the demo page's hint and `accept` list, and
  the API docs. A PDF is measured *after* rasterizing rather than as uploaded — its pages are
  what reach the model, and at a fixed DPI a page image's size follows the physical page size, so
  a large-format page can break a limit its 20 MB parent file does not. This is not tidiness — the numbers had
  been stated in five places and enforced in none, so the demo, the docs and the specification all
  advertised **TIFF**, which Claude has never read (accepted, then failed inside the first model
  call) while rejecting **GIF**, which it does; and an oversized photo was accepted by multer's
  50 MB ceiling and died two to four minutes later as "no output arrived within 120s". Switching
  models now moves every one of those surfaces together. An operator can still override per
  provider (`providers.<name>.image_limits`) for a model newer than the table.

  One source sits behind all of it — Claude's vision documentation — and since
  `providers.bedrock.api: converse` can reach a model Anthropic did not make, the file now says
  which of its numbers it has actually read. A vision model it cannot place in the Claude
  generations resolves the same conservative limits (they are the right ones to serve an upload
  with while nobody has measured) but marks them `assumed`, and the *claims* change with that
  flag: the hint stops promising that re-saving at the long edge "loses nothing the conversion
  would have used" — a promise about the model's downscaling, and on an unmeasured model advice to
  destroy detail that may have been read — and the 8000 px rejection stops attributing itself to
  the model's refusal. Boot warns once, naming the agents, the model and the config path, because
  every downstream surface here is written to be quoted verbatim and none of them can qualify
  itself. Setting `image_limits.max_long_edge_px` is the operator answering, and it silences both —
  where it can be read as an answer. That setting is per provider **block** and the basis question is
  per **model**, so on a block that also serves a model Iris does have limits for, a number there is
  ambiguous about which of them it was read from, and Iris will not take it as one. A Bedrock
  deployment that sends a single agent to another vendor is always in that case, since `api` is a
  block setting and only a block named `bedrock` builds a Bedrock adapter: there is no per-model
  `image_limits` and nothing to set, so the warning says so and names the models the block is shared
  with rather than asking for a line that would not help. Such a deployment keeps the conservative
  numbers until someone publishes or measures that model's own.
  `GET /v1/limits` gains no field for this: the endpoint deliberately says nothing about which
  model serves the deployment, so the qualification is in the wording of `hint`.
- **Starting work on a session is a claim, not a check (`store.claimSession`).** The two endpoints
  that begin non-idempotent work — `POST /:id/feedback` (enqueues a pipeline) and `POST /:id/close`
  (files regression fixtures into the shared agent library, deletes the tmp tree) — used to read the
  status, compare it, then write. `claimSession` folds the comparison into the write
  (`UPDATE … WHERE session_id = ? AND status = ?`) and reports whether this caller is the one that
  changed the row, so of two concurrent callers exactly one is told it won.

  What this is and is not: both handlers are fully synchronous, so *today* nothing can interleave
  between the check and the write and the plain pattern was already correct. Racing two **processes**
  against a shared WAL database, both callers won — but a second instance is not the supported
  topology (see the in-process queue above). So this is defense in depth. It earns its place by
  being the cheaper invariant to hold: correctness stops depending on every future handler staying
  synchronous. Adding one `await` between the guard and the write — the ordinary thing to do when a
  check needs I/O — would silently reintroduce the race in-process, and a duplicated feedback run is
  invisible in the response (both callers get a `202`) while two pipelines write the same
  `output.html` and `fragments/final.json`.

  The claim sits *last* in the feedback handler (after request validation, so a malformed body still
  gets its `400` without disturbing the session) and *first* in close (before fixture capture and the
  `rmSync`, because a loser that discovers it lost afterwards has already filed the fixtures twice).
- **Feedback re-runs.** Re-runs are logged separately (a `feedback_rerun` event) and the
  prior `output.html` is snapshotted to `sessions/<id>/history/` so it can be reverted to. A
  revert *endpoint* is out of v1 API scope; the data is preserved to enable it.

  A re-run is **routed** first (`feedback_scoped` event). The Reader only ever sees the assembled
  HTML, by design — image access is the Copy Editor's — so feedback about what was *read off a page* ("the revenue figure on
  page 2 is wrong") raises no issue for the loop to act on and cannot be fixed there. The Feedback
  Agent's SCOPE task decides which case applies:
  - **`document`** — tone, wording, ordering, or an accessibility rule: re-lint the saved body
    and run the feedback-aware review loop on it. No source images, no re-extraction.
  - **`extraction`** — source-fidelity: the named pages go back to the page agent *with their
    source image and their previous output* attached, then the document is reassembled and
    reviewed. Untargeted pages keep their prior fragments byte-for-byte.

  Routing is deliberately biased toward the cheap path: an unavailable agent, an unparseable
  answer, pages it cannot localize, or a claim spanning more than half the document all fall
  back to `document`. A wrong `document` answer costs one review round; a wrong `extraction`
  answer costs a vision call per page.
- **One instance per `data_dir` — this is a hard constraint, not a preference.** Running two
  processes against the same `storage.data_dir` corrupts sessions, and it fails loudly in the
  wrong direction: on boot each instance runs `failStaleSessions()`, which marks every `running`
  and `queued` row `failed` with `interrupted (server restarted)`. Those rows include the *other*
  instance's live runs. A second instance starting therefore kills the first one's in-flight
  conversions from the client's point of view — the pipeline keeps going and still writes
  `output.html`, but the session reads `failed`, so the user is told their document failed while
  work continues on it. The sweep cannot tell "this row is orphaned" from "this row belongs to a
  peer" because nothing records which process owns a run.

  Two other single-process assumptions ride along: the run queue that enforces
  `max_concurrent_runs` is in-memory, so N instances allow N × the cap, and fixture and
  agent-memory writes under `data_dir` are unsynchronized between processes.

  To scale beyond one box, put a second `data_dir` behind it (independent instances, sessions not
  shared) rather than pointing two at one directory. Gating the sweep on an instance id, and
  moving the queue and locks out of process, is what a genuinely multi-instance version needs.

- **`phase` reports only phases that exist.** `extraction`, `assembly`, `review`, `done`. The
  designed `triage` and `reconciliation` phases are not implemented — reconciliation is
  unreachable while extraction hardcodes `edges: []` — so they are not in the enum and not
  emitted. New sessions start at `extraction`; they used to be created at `triage`
  and overwritten before a client could observe it.

## Designed for, and not built

Designed for and intentionally **not** built in v1, each having been framed as optional, as an
alternative, or as out of scope: PostgreSQL and S3 backends (SQLite + local filesystem is the v1
reference), a per-user configuration endpoint, and webhooks. Two endpoints go the other way and
were never specified: `GET /v1/health`, a standard liveness probe, and `GET /v1/stats`, the
public page tally described above.
