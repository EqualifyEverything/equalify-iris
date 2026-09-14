# Implementation notes

Decisions the code makes that are worth knowing before you read it.

This file is for someone about to change the code. If you only want to run Iris, the
[README](../README.md) is enough.

`fragment`, `block`, `verdict`, `declaration` and `round` are used here in the senses
[README § Terms](../README.md#terms) gives them. That section also lists the ordinary sense each one
carries. This file uses those wherever they are the ones meant, so **read the sentence rather than
the word.** `block`, for one, arrives here as a document element, as a table's header rows, as a
provider block in the config and as a code block. Two glosses a reader cannot infer:

- A `round` is a round of the reader/editor loop, and also a captured run of a corpus, named as a
  **bench round** or by its run directory (`runs-reader-newsha`).
- A `declaration` is the page agent's claim that a page holds no content everywhere except one bullet
  under [Assembly](#assembly-one-document-out-of-many-pages), where it is the `lang` declaration on
  the document's root element.

Several of these decisions reverse an earlier design, so they are written as decisions rather than
as a diff against it. Iris was specified up front in a requirements document. That document was
amended twenty-odd times as the build disagreed with it, and it has now been retired. The design
record is the git history and the issues each decision cites. What is true today is here, in
[API.md](API.md), in [models.md](models.md) and in the code.

**Write plainly and directly, and give each document one job.** Both are requirements rather than
preferences ([CONTRIBUTING.md § Documentation](../CONTRIBUTING.md#documentation) states them;
[README § Working on Iris](../README.md#working-on-iris--including-if-you-are-an-ai-agent) says which
document holds what). What that means for this file: a rule's rationale and its evidence belong here
even when a reference doc is where you met the rule, and a cross-link carries the reader the other
way. A sentence that restates another document gets deleted rather than softened. A claim written
once has one place to be corrected.

Each decision below is one bullet, and the headings only group them:

- [The pipeline's shape](#the-pipelines-shape) — what got built, what got deleted, and how your
  corrections get back to the library
- [What the lint checks](#what-the-lint-checks) — and the things it repairs without telling anyone
- [Assembly: one document out of many pages](#assembly-one-document-out-of-many-pages) — id
  collisions, and tables and sentences cut in half by a page break
- [Joining a table split across a page turn](#joining-a-table-split-across-a-page-turn) — when two
  half-tables are one table, and what the join refuses to guess
- [Extraction: verdicts and empty pages](#extraction-verdicts-and-empty-pages)
- [Correcting a page against its image](#correcting-a-page-against-its-image) — what a correction's
  fields can see, the ceiling it asks for, and why a page is redrawn only once
- [Reading a blank-page declaration](#reading-a-blank-page-declaration) — the rule that decides
  whether a page is empty or lost, and what each clause of it cost before it existed
- [The review loop](#the-review-loop) — the Reader, the Copy Editor, and the floors a round cannot go under
- [Learning from feedback](#learning-from-feedback) — the eval gate
- [The provider adapters](#the-provider-adapters) — output ceilings, timeouts, and Bedrock's two dialects
- [Running the service](#running-the-service) — the queue, upload limits, one instance per `data_dir`
- [Designed for, and not built](#designed-for-and-not-built)

## The pipeline's shape

- **Three phases, not five.** The original design had a Triage pass writing per-image notes and a
  Reconciliation pass stitching fragments across images. Neither is built. Extraction is a single
  general page agent rather than triage → per-region fan-out; the fan-out was removed because it
  duplicated output for nested structures like forms. Reconciliation also cannot run until
  extraction emits fragment edge data, and it currently emits none. A Builder Agent that drafts
  session-scoped agents into `tmp/<id>/agents/` is likewise designed for and not built — what ships
  instead files the drafted agent as an issue (below).

  Reconciliation's *within-page* job is gone for the same reason. It was there to clean up after the
  fan-out, and one page now yields one fragment from one agent, so there are never two fragments
  competing to represent the same content.

  Across pages the problem is real, and it is now closed both ways: a **table** printed across a
  page break is rejoined where the pages are joined, and so is a **sentence** (the two bullets
  further down describe how). Prose was the harder half, and it was never a gap anyone could close
  in the page agent. The page-break marker is the first thing a page emits, so a split sentence
  lands with its halves in two different replies, and the agent that wrote `public serv-` was never
  shown the page that says `ices`. Neither can emit that sentence whole without inventing the half
  it cannot see. So the page agent's job there is to transcribe its own edge exactly, hyphen
  included, and to declare in its `log` that the page opens or ends mid-sentence; the join is done
  by the pass that holds both halves. Measured on the last bench round before it: 22 of 90
  page-break markers stood where a sentence carried on, and 2 of those split a hyphenated word.
- **One agent per page, not one per content type.** Nine per-content-type agents (`paragraph.md`,
  `table.md`, `formField.md`, …) once shipped and have been **deleted**. This is the decision on
  whether the agent library is the product: it is, but the library is not a taxonomy of content
  types. Those nine were not merely unused. They were unreachable through every path that can reach
  an agent file — dispatch declines each of their names *before* the file is looked up, only
  `page.md` is ever trained, and the contribution filter blocks the same names — so no fixture,
  lesson or prompt improvement could ever accrue to one. Nine prompt files that cannot run are
  worse than none, because they read as the live extraction path to anyone opening `agents/`.

  Seeing the whole page is the capability, so per-region fan-out is not coming back. Nine agents
  re-rendering one image produced two representations of one thing — a `<form>` and a `<table>` for
  the same fields — and then needed a reconciliation phase to remove a duplication the architecture
  had just created, at nine times the cost and latency of the single call that already produces the
  answer.

  What is left is specialization that *earns* its place: `page.md` as the general, trainable pass,
  plus specialists for content a whole-page pass demonstrably handles worse, dispatched by name and
  merged in. `chartDataAgent.md` is the shape. Reading precise values off a chart's axes into a data
  table is a different task, it needs its own long contract, and it would bloat the page prompt for
  every page containing no chart. A `paragraph` specialist is not that shape; "wrap prose in `<p>`"
  is one line of the page prompt. This is also why the context pressure that motivates splitting
  agents up is answered per-*capability* rather than per-content-type: a specialist's contract is
  loaded only for the pages that need it, whereas nine near-duplicate prompts relieve nothing.

  The nine type *names* survive as data (`STANDARD` in `src/pipeline/contribute.ts`). That list is
  what declines a suggestion the page pass already covers, and what keeps it from being re-filed as
  a new agent to build. It was never a mirror of the library — it is the boundary of what one
  whole-page call handles — so it stays data rather than a directory listing, and dropping a
  `table.md` into `agents/` does not start splicing a second table over the page's own.

  The names are matched case-insensitively, through one shared normalizer used by both the dispatch
  decline and the contribution filter. A suggestion's name is prose a model wrote, not a filename
  (`STANDARD` itself spells one entry `formField`), so `"Table"` is ordinary output. While the nine
  files existed, `agents/Table.md` resolved on a case-insensitive volume and absorbed it. With them
  gone, an exact-match filter would draft an agent and file a public issue on the upstream repo —
  under the deployment's own GitHub account, the only identity Iris has — for a type the page pass
  covers.
- **No provenance comments in the output.** `@source` / `@agent` / `@fragment` wrappers travel with
  a fragment through the pipeline, and an early design kept them in the final HTML. Iris delivers
  clean content-only HTML instead. The comments leak pipeline internals into a document meant to be
  handed to end users, and every consumer would have to strip them. Provenance is recorded in the
  run log (`GET /v1/sessions/{id}/logs`) rather than in the deliverable.

  What does survive in the delivered HTML is the comments that tell a reader what the document is
  missing. `@unresolved` is emitted when the review loop stops with issues outstanding: at its
  iteration cap, on a round that changed nothing, or on a round whose response hit the model's
  output ceiling. That last exit adds a second comment, `@editor-truncated`, saying what the round
  managed. A round too long to answer is re-made a section at a time, and the comment reports how
  many sections came back — or, where nothing could be, that no editor pass ever worked on the
  issues `@unresolved` lists. A third comment, `@lint-unavailable`, is emitted when axe-core could
  not run on the document at all. Nothing in it was checked, so an `@unresolved` list that is short
  — or absent — is not evidence that there is nothing left to fix.

  Those three are not the whole set: `wrapDocument` emits six statements of this kind
  (`assembly.ts`). `@page-failed` stands where the content of a page whose extraction was lost would
  have been, emitted as that page's own fragment (`extraction.ts`, and the rejoin list below).
  `wrapDocument` adds a document-level trailer of the same name listing every such page.
  `@page-uncorrected` lists pages whose content IS in the document and never passed Iris's own
  fidelity check. `@review-unread` gives how many of the windows the document was read in came back
  with no usable answer — `@lint-unavailable`'s warning, about a different gate.
- **Contributions are issues, not PRs.** Instead of fork+PR-on-close, when the extractor flags
  content a specialist would handle better, Iris drafts that agent and files a
  `New agent suggestion: <type>` GitHub issue with the agent code + context. Feedback that
  generalizes files an
  `Agent update proposal: <agent> — <lesson>` issue the same way. Both are simpler to triage, and
  they need no write access to a fork — so nothing forks and nothing pushes. The `pending_prs` and
  `prs_opened` response fields, the `skip_prs` parameter and the `fork_repo` field on `/v1/me`
  belonged to that flow and are **not** part of the API. Issues are filed with the deployment's one
  token, `github.token` — there is
  [no per-user identity to file as](../README.md#one-github-identity-and-no-sign-in), which costs the
  attribution and buys the whole login flow being gone. Filing fails softly, and there is now one
  credential a 403 or 404 can be about, so the hint logged with the failure names it rather than
  having to work out which of three was used.

  The update title carries a slug of the **lesson**, not just the agent, because the agent on that
  path is always `page.md`. With the agent alone, every proposal ever made computed one title, and
  the title-based dedupe then skipped every one of them after the first — silently, for as long as
  that first issue stayed open. That was observed on the UIC deployment, where one issue blocked the
  path for a day. A repeat report of the same lesson now comments on its issue with the new session
  and corroboration count instead of being dropped, so no lesson leaves without a trace.
- **Review issues are attributed by page, not by `@source` region.** The Reader's issue format was
  designed around the `@source` region ids of the per-region fan-out, which extraction no longer
  produces and which are stripped from the deliverable anyway (above). Issues instead carry
  `pages: number[]` — the source pages the Reader matched the offending content to, from an index of
  page-number + extracted-HTML excerpt. Attribution is what scopes the Copy Editor's image payload
  (below). The two-view (HTML + flattened) cross-check is implemented as specified.

Places where a decision was left open, and where v1 intentionally stops:

- **`runs/<run-id>` vs `sessions/<session-id>`.** The design named both. This implementation treats
  the run id as the session id and writes the log, `agent-updates.md`, etc. under
  `sessions/<session-id>/`, which is the layout above. Two files that tree once named,
  `new-agents.md` and `prs.md`, are not written at all — they belong to the withdrawn fork-and-PR
  flow.
- **Reader chunking.** Chunks use a fixed character budget with overlap rather than a literal
  30%-of-context computation, since the per-model context window is not exposed through the provider
  abstraction. The two-view (HTML + flattened) cross-check is implemented as designed.

## What the lint checks

- **Color-contrast lint.** Output is content-only with no styling, so axe-core's `color-contrast`
  rule is disabled — it cannot be assessed without rendering and is out of scope.
- **Skipped heading levels are linted for, though they are not a conformance failure.** axe tags
  `heading-order` `best-practice`, so the WCAG-only tag filter drops it. It is enabled by name on
  the same argument as the duplicate-id rules below: headings are how a screen-reader user navigates
  a long document, the levels here are decided one page at a time by a model looking at type size,
  and nothing after extraction could see the result. The page prompt has forbidden skipping a level
  since #96 and #114 reported one shipped anyway.

  The rule fires only where a level goes *down* by more than one, so it stays quiet on the two
  shapes the page prompt asks for. One is a body that opens at `<h2>` or `<h3>`, because a page may
  be a subsection of a heading the extractor was never shown. The other is a heading that returns to
  an outer level after a run of subsections. It cannot see the other half of the bug — an `<h2>`
  that should have been an `<h3>` is a level the page decided, not a gap — so it narrows the
  prompt's job rather than replacing it. Two consequences are worth knowing. A document that used to
  pass may now spend review iterations on heading levels. And `heading-order` can now appear in the
  quality tally, where it has been the worked example in
  [`docs/API.md`'s quality tally](API.md#quality-tally-shared-secret-off-by-default) all along
  without once being reportable.
- **A `<main>` inside the delivered `<main>` is linted for, and removed before it gets there.**
  `wrapDocument` puts the assembled body inside `<main>`, and 18% of page answers across a six-model
  bench lineup emitted one of their own. That ships a `main` inside a `main`, which takes away the
  landmark a screen-reader user jumps to in order to skip the furniture. axe has three rules for it
  and tags all three `best-practice`, so the WCAG-only filter dropped every one and the gate called
  the document clean.

  `landmark-no-duplicate-main` and `landmark-main-is-top-level` are now enabled by name, on the same
  argument as `heading-order` above. The third, `landmark-unique`, is deliberately left off.
  Measured, it fires on two `<nav>` elements with no accessible name, on two `<aside>`, and on two
  `<section>` the page names alike — repeatable page furniture, not a defect — and it is quiet on a
  nested `<main>` that carries a label, so it would cost false positives without covering the case.
  The rules are a backstop, not the fix: `landmarks.ts` takes the tags out of the body first (below).
- **Duplicate ids are linted for three separate ways.** Obsolete as a *conformance criterion* is not
  the same as harmless here. This document is assembled from independently extracted pages, so a
  duplicate id is the specific defect concatenation produces, and it breaks navigation rather than
  conformance. Two `id="fn-1"` means every `href="#fn-1"` reaches the first one, so a footnote
  reference on a later page silently goes to the wrong note while the link still looks like it
  works. Covering that takes three rules, because axe splits the check by what the element *is* and
  each rule skips the others' elements:

  - `duplicate-id` (elements nothing references and nothing focuses) and `duplicate-id-active`
    (focusable ones) are both tagged `wcag2a-obsolete` — WCAG 2.2 dropped 4.1.1 — so the tag filter
    would skip them and each is enabled by name.
  - `duplicate-id-aria` covers ids something actually *references*, is still live WCAG 4.1.2, and
    needs no enabling. But axe marks it `reviewOnFail`, so its findings arrive as `incomplete`
    rather than `violations`. That left the worst case invisible: two `<input id="q1">` under one
    `<label for="q1">` returned **zero** violations even with both obsolete rules on. A duplicate id
    needs no human judgement to confirm, so this rule's incomplete results are promoted to
    violations — only this rule, since the rest of `incomplete` genuinely cannot be decided without
    rendering.

  This widens what the gate reports, which is the point, and it has a cost worth knowing: a
  document that used to pass now spends review iterations on duplicate ids, and can reach
  `max_review_iterations` with them still listed in `unresolved.md`. Assembly namespaces the
  *cross-page* duplicates itself. So what reaches the review loop is the ids duplicated **within a
  single page** — which the assembler cannot fix, because there is no second page to attribute the
  copy to — plus the collisions on any page the reserialization guard left as written.
- **The delivered document's own structure is measured outside the lint gate, because axe cannot see
  it.** axe lints a parsed DOM, and an HTML parser's job is to turn malformed markup into a
  well-formed tree before anything downstream looks at it. A document delivered with an unclosed
  `<table>` therefore reaches axe as sixteen tidy tables: on one bench round, a document whose bytes
  read sixteen `<table>` start tags and fifteen end tags reported `final_lint.ok: true`, zero
  violations, `ready_for_review`.

  The other half is content that is not there for the parser to repair. A table in the same document
  had a caption, a two-row header block naming nine columns, and no rows, which a screen reader
  announces and reads out as an empty table. axe has no rule for that either (`empty-table-header`
  is about a header *cell* with no text), so zero violations was the honest answer to the question
  axe was asked. Both are checked on the delivered bytes instead (`markup.ts`), reported as
  `delivered_markup` in the run log, and tallied as `iris:markup-unbalanced` /
  `iris:table-no-body`.

  Two narrowings are worth knowing. Only elements whose end tag HTML *requires* are
  balance-checked: `<ul><li>a<li>b</ul>` is correct markup, and counting it would bury the real
  finding under legal output. And a table counts as empty when it holds no row a reader receives as
  *content*, not when it has no `<td>` — a table whose body cells are all `<th scope="row">` is
  legal and full of content. So what is counted is a table with no rows at all, none outside a
  declared `<thead>`, or — where the model declared no header block, which is the shape it writes
  when it has drifted from the page prompt — none that is anything but column headers. Nothing here
  is repaired and no run fails on it: a count with no threshold, on the same argument as
  `internal_links`, until there is enough of a rate to calibrate.
- **Four more questions are asked in the same pass, about promises the document makes and does not
  keep (issue #255).** These are not malformed markup, which is why they needed their own checks.
  Each is a promise with nothing behind it: a reference to an `id` no page defines
  (`aria-labelledby`, `aria-describedby`, `label[for]`), a `<dl>` with terms and no definitions, a
  `lang` on an element with no text for it to apply to, and a `<nav>`, `<aside>` or *named*
  `<section>` with nothing in it. "No text" means neither a text node nor text in an attribute:
  `<img alt="Un graphique" lang="fr">` is correct authoring and is not counted, the same image with
  `alt=""` is.

  The gate is clean on every one of them, each for a different reason. axe reports a dead ARIA
  reference as `incomplete` rather than a violation (`aria-valid-attr-value` is `reviewOnFail`, so
  it never reaches a rule the review loop acts on). `<dl><div><dt>Term</dt></div></dl>` *passes*
  `definition-list` because the wrapper is legal HTML. `lang` is a global attribute, so putting one
  on an empty `<img>` breaks nothing. And an empty `<nav>` has no rule at all. They are reported
  together as `delivered_structure` in the run log, with the elements named, and three of the four
  are tallied as `iris:structural-defect`.

  Two decisions are worth knowing. The checks run on the **joined** document, not per page, because
  a reference to an id a *later* page defines is correct and a per-page scan would report it as
  dead. And a `lang` on an empty element is measured but deliberately kept **out** of the tally: it
  is wasted output, not something a reader loses, and mixing it into a rate about harm would move
  that rate for the wrong reason. Like the two above, nothing here is repaired and no run fails on
  it.
- **The lint counts every attribute name no valid markup produces, and removes the few that stop it
  running (issue #257).** Not tidying: an attribute name beginning with a digit took the entire rule
  set offline. axe needs a unique CSS path for the elements it reports; where an id is unusable and
  a similar sibling must be disambiguated it enumerates attributes, and a CSS escape is the hex
  codepoint, so a name starting `9` escapes to `\39`. jsdom's selector engine compiles selectors
  into JavaScript source, where `\39` is an octal escape and a SyntaxError in strict mode. One such
  attribute pair anywhere in a 25-page document and there was no verdict on any of it — which
  happened to six delivered documents, 150 pages, every defect on them unexamined.

  `runAxe` removes those names from **its own copy** of the document before axe walks it. The
  delivered bytes are untouched, because what a name like `1\"` was meant to be is a question for
  the stage that produced it.

  The removal is limited to the escape shape the compiler chokes on, and everything else malformed is
  counted and left where it is, because **removing an attribute takes the rules that read it away
  too**. `aria-valid-attr` (critical, WCAG 2 A) fires on a name that lost a quote —
  `aria-label"Note"` — *because* the name is malformed, so a wider strip turns that document into a
  clean pass with a log-line number as the only trace. What the predicate is, is
  checked against both libraries it makes a claim about: axe's own `escapeSelector` and nwsapi
  itself, name by name.

  The count is reported (`malformed_attributes`, plus `malformed_attributes_removed` when the linted
  copy differed, on the `assembly` line or `lint_debris`), because the name is the only symptom of
  the leak. Its other three harms — an invalid `role`, a marker announcing the wrong text, an `id` no
  reference resolves to — are findable only by reading the document (#233, #234). It is counted on
  **every** document rather than only on ones that break, since a number that appears only after a
  crash cannot answer whether the leak upstream is fixed. Two boundaries are worth knowing. An
  attribute VALUE beginning with a digit, and an id or class beginning with one, are escaped
  correctly by the same engine and are never removed. And `<template>` content is reached by neither
  the strip nor axe, so debris there is uncounted and also harmless.

## Assembly: one document out of many pages

- **Colliding ids are namespaced during assembly.** A page is extracted alone and concurrently, so
  it cannot know that another page also numbered its first footnote 1 — and the page prompt asks it
  to preserve the source numbering. `assembleBody` prefixes the ids that more than one page claimed
  with their page number (`fn-1` → `p3-fn-1`), and rewrites everything that points at them in the
  same pass: `href="#…"`, plus `for`, `headers`, `list`, `form` and the `aria-*` references. Unique
  ids with dangling references would be a worse defect than the collision.

  The scope is deliberately one id at a time, not one page at a time. Prefixing every id on a page
  also breaks the references that legitimately span a page break — a `<label for>` whose input is on
  the next page, or endnotes with continuous numbering — which resolved correctly before assembly
  touched them. That trade is a no-target reference in place of a wrong-target one.

  The prefix is reserved against every id the document already claims, growing its separator (`p1-`
  → `p1--` → …) until nothing collides with it. `p1-total` and `p2-name` are what a paginated form
  emits, and a blind prefix would manufacture the duplicate it exists to remove. An ordinary
  document keeps the short form.

  The prefix is *labelled* with the page number, but it does not depend on that number being unique.
  Two fragments sharing an `order` would otherwise take the same prefix and stay collided, with the
  log reporting the id as namespaced. Ownership is tracked per fragment position, and a repeated
  label becomes `p1_2-`.

  Every reference to a colliding id is repointed rather than abandoned. If the page owns the id, the
  reference goes to the page's own copy: reference and target were written together by one agent
  looking at one image. If it does not, the reference is ambiguous and goes to the first page in
  document order that claims the id — where a browser sent the bare reference before any of this
  ran. Leaving it dangling instead was the same defect in a new place. With a `<label for="q1">` on
  page 1 and an `<input id="q1">` on pages 2 *and* 3, every owner is renamed and the label points at
  nothing, so the field loses its accessible name and axe reports `label` on a document a plain
  concatenation passed. Ambiguous references are named in the run log as `assembly_anchors`.

  A *link* is aimed slightly differently: it takes the first owner that does not already link to its
  own copy. That owner's target is spoken for. A footnote marker on page 3 pointing at `#fn-1`,
  where pages 1 and 2 each carry their own `fn-1` *and* their own marker for it, is not a tie
  document order can break — aiming it at page 1 gives one note two markers while page 3's note
  stays unreachable. An owner that does *not* link its own copy is a footnote continued from an
  earlier page, so a link is still repointed there. Only when every owner has its own marker is the
  link left bare. Those are listed in the same log line as `unrepointed`, a subset of `ambiguous`,
  and the references themselves are counted as unresolved in the delivered document
  (`internal_links`). Links only: a `for`, `headers` or `aria-*` reference with no target is an axe
  violation, so those still take the first owner.

  A page whose markup would not survive a reserialization is left exactly as written, keeping its
  collision for lint to report and its bare ids for anything resolved to it. If such a page holds a
  *reference* instead, the referenced id's first owner keeps its bare form so that reference still
  resolves. Only the first owner, so every other copy is still renamed — and only when none of that
  id's *owners* was skipped, since a skipped owner is already keeping the bare id and pinning a
  second copy would ship a duplicate. Any id pinned this way is listed in the same log line as
  `pinned_ids`. It is a colliding id that deliberately was *not* renamed, so without that list a
  bare colliding id in the delivered document would be indistinguishable from namespacing that
  silently failed.

  A page too deeply *nested* to rewrite is delivered as written for the same reason, and takes the
  same treatment. Rewriting recurses per level in three places, so past 500 levels, measured on the
  parsed tree, the page is refused rather than allowed to overflow one of them. It counts as an
  owner — or the collision would go undetected for its copy, and the pin would fire on top of the
  bare id it is already keeping — and its frozen references pin their first owner.

  Its ids and references are read from its **DOM**, which such a page keeps: `querySelectorAll` does
  not recurse, so it works at any depth the parse survived, and the reading is exact. Only a page
  whose *parse* threw falls back to scanning the source. That scan follows the parser's own rules:
  attributes only from real tag positions, elements whose content is not markup (`<textarea>`,
  `<script>`, `<template>` and the rest) skipped, character references decoded, first of a repeated
  attribute. A *phantom* id read out of non-markup text is worse than a missed one — it suppresses
  the pin, the real owner is renamed, and a `<label for>` elsewhere is left naming nothing.

  Reading the tree is what closed that class, rather than modelling more of the parser. The scan
  cannot see tree *construction*, so it invented owners for markup the parser drops outright (an
  orphan `<tr>`/`<td>`, a stray `<caption>`/`<col>`/`<thead>`, anything after `<plaintext>`) and
  missed real references inside a `<select>`, whose `<option>` children survive parsing even though
  most tags in there do not. Reading the tree covers foster parenting in both directions: a `<tr>`
  outside a `<table>` is dropped to bare text, and content inside one is *hoisted out past the
  table*, which is a reading-order change and worse than the duplicate id it would be fixing. The
  guard compares the source's sequence of tags **and text** against the parsed document as a
  subsequence. Counts cannot see a move, equality would refuse every page where the parser
  legitimately adds a tag, and a tag-only sequence misses bare prose being hoisted out of a table
  with every tag left in place.
- **A deprecated ARIA role redundant with its element is dropped, not reported.** ARIA deprecates
  exactly three roles — `directory`, `doc-biblioentry`, `doc-endnote` — and all three were folded
  into list semantics, so each has a host element whose implicit role already *is* the role. An
  `<li role="doc-endnote">` inside an `<ol>` is announced identically without it. Removing the
  attribute is therefore a rewrite with no judgement in it, and it happens where the pages are
  joined and again after every correction round, logged as `deprecated_roles_stripped`.

  Both ends are needed. Extraction reached for the DPUB pair on its own and took the deprecated half
  (issue #187), and the round that was told the rule had failed rewrote five sections and left it. A
  body a feedback re-run picks up without re-extracting is stripped for the same reason, since that
  path runs no assembly at all.

  The prompt is still the primary fix. `agents/page.md`'s FOOTNOTES rule now asks for a plain `<ol>`
  of `<li>` with no role on either, and says why the *landmark* roles do not belong on the list
  either. A role replaces the element's own, and `doc-endnotes` is a landmark that is not a kind of
  list, so `<ol role="doc-endnotes">` stops being announced as a list of N items and no gate reports
  it. This pass is the part that does not depend on a model obeying any of that.

  Only where the role is redundant. A `<div role="doc-endnote">` is left to fail the gate, because
  deleting the attribute there loses the only thing marking the element as a note, and DPUB's own
  remedy is to make it a list item — a restructure, not an attribute rewrite. A document with no
  such role comes back byte-identical, which is what the loop's change detection and the
  reserialization caution above both need.
- **A `<main>` a page emitted for itself is taken out of the body, not reported.** Same division of
  labour, at the same three points, logged as `page_main_stripped`. A bare `<main>` loses its tags
  and its children are promoted. A `<main lang="ko" id="p3">` becomes a `<div>` keeping those
  attributes, because unwrapping it would drop the `lang` the document's root declaration is derived
  from or an `id` an `href` elsewhere resolves to — and a `<div>` is generic, so the landmark is gone
  either way. An explicit `role="main"` is the one attribute the downgrade cannot keep, and any later
  spelling of `role` goes with it, since removing the first one is what makes the second live.

  What it declines is a `<main>` with no `</main>`: the element's extent is whatever the parser
  decides, so both guesses move content into or out of a landmark, and the gate reports it. A stray
  `</main>` is the reverse and is deleted. A parser discards it, so nothing is being weighed, and it
  is the one unpaired shape no rule reports — inside the shell it closes the document's own `<main>`
  early, and everything after it ships outside the landmark with the lint clean. A `role="main"` on
  an element that was never a `<main>` is left to the gate as well: that is a role a model chose on
  an element whose own semantics do not cover it, the same judgement the role strip above refuses to
  make.

  All three points are needed for the usual reason. The assembly join is where extraction's wrappers
  arrive, an editor round rewrites blocks of the body and can introduce one of its own, and a
  feedback re-run resumes a stored body that was written before any of this existed. The prompt is
  still the primary fix: `agents/page.md` now says the document supplies `<html>`, `<head>`, `<body>`
  and the `<main>`, which is the fact all six benched models were missing.
- **A table printed across a page break is rejoined into one table**, and the merge is tried in code
  before a Copy Editor is asked: 26 of 50 measured pairs join for nothing. What the rules are, what
  each refusal costs, and the four reasons that police the bracketed unit note are their own section
  — [joining a table split across a page turn](#joining-a-table-split-across-a-page-turn). Logged as
  `table_continuations`, `table_joined`, `table_join_code_declined`, `table_join_failed` and
  `table_joins_capped`.
- **A sentence printed across a page break is delivered whole.** Same seam as the table, same reason
  no page could have fixed it, and a different answer: this one needs no model call, because there is
  no judgement in it (issue #248). 22 of 90 page-break markers in the reference corpus stand where a
  sentence carries on, 13 with the sentence's tail in the paragraph immediately before the marker,
  and a reader hears "Only 12 States tax tourist courts. Simi-", then "Page 74", then "larly, the
  more populous States…".

  The rule is the measured one: the next page opens with a `<p>` beginning with a lowercase letter,
  the paragraph before it ends on a letter, digit, comma or hyphen, and the sentence that runs over
  is moved **forward, past the marker**. That direction is the decision here, and it is about what a
  page anchor means rather than a detail. `<hr>` cannot sit inside a `<p>`, so text has to cross the
  marker one way or the other, and moving the tail forward leaves `#page-74` standing immediately
  before a whole sentence — where pulling the next page's head back would land that anchor *after*
  the sentence it should open on.

  "A few words" is held to rather than hoped for: at most 500 characters may cross a marker. A
  paragraph with no sentence boundary in it moves *entire*, and for a page of unpunctuated prose that
  would be the whole page's text delivered after the next page's anchor, which the argument for the
  direction does not cover.

  A word the printer broke **keeps its hyphen** and is closed up. Nothing at this seam can tell
  "Simi-" + "larly" from "public-" + "sector", `agents/page.md` answers the same wall from the page's
  side the same way, and dropping it would be the one place this pass deleted a character the source
  printed. So what is fixed is the interruption, and `word_splits` in the log is what would let a
  later pass decide the hyphen with data.

  What it refuses matters more than what it joins, and each refusal is counted:

  - A footnote list between the halves — 9 of the 22. The marker is then not what interrupts the
    sentence. A page that *failed* extraction is the same shape, since its `@page-failed` comment is
    a node standing between them.
  - A page between them that returned nothing at all. The middle of the sentence may be what is
    missing, and only this stage can tell, because an empty fragment is dropped from the body and
    leaves nothing but a hole in the page numbering.
  - A sentence beginning inside an inline element that opened earlier.
  - Two paragraphs disagreeing about `lang`.
  - A paragraph carrying an `id` something may refer to.
  - A page being shipped byte for byte because the parser and its bytes disagree about it.
  - More text than the bound above.

  The lowercase test has no signal in Hangul, Chinese, Japanese, Arabic or Hebrew, so those sentences
  still ship split — a join missed rather than a join got wrong, and left there because the 22 were
  measured on an English corpus. Logged as `prose_joined`.

## Joining a table split across a page turn

The run log entries [`table_continuations`](API.md#table_continuations),
[`table_joined`](API.md#table_joined),
[`table_join_code_declined`](API.md#table_join_code_declined),
[`table_join_failed`](API.md#table_join_failed) and
[`table_joins_capped`](API.md#table_joins_capped) say what a caller does about each outcome. This
section is why the rules behind them have the shape they have. The figures are from the 100-page
reference corpus and the round logs, and for several of these rules they are the only evidence there
is.

- **A table printed across a page break is rejoined into one table.** Each page is extracted alone,
  so the agent that wrote the second half had one image and the rest of the table was not on it. It
  ships as a fresh `<table>` repeating the header, and a screen-reader user reading down the column
  gets the header row again mid-data with nothing saying the two are one table (issue #239).

  The halves are *findable* because the second one says so: all 18 continuation captions measured in
  the reference corpus carry a "Continued" marker, in four different spellings, against 48 tables.
  The rule reads that marker anywhere in the caption after a dash, a bracket or a parenthesis.
  Requiring it at the *end* drops 4 of the 18, and requiring the `Table N` stem to repeat drops 8,
  because a second half often keeps the title and loses the number. The predecessor is the
  immediately preceding table in document order in all 18.

- **The merge needs a Copy Editor call wherever the halves do not agree on what to concatenate.** Two
  of the 18 pairs declare a different column count from their own first half, 13 repeat a header
  block carrying footnote-*reference* ids that an endnote links back to, and a bracketed unit note is
  reprinted with the header and belongs in the joined table once.

  Only three of the editor's six rules hold a judgement, though — the other three are "move these
  bytes and change nothing" — so the join is **tried in code first** and stands down wherever the
  judgement is real. Measured on 50 pairs read out of already-delivered documents, 26 join with no
  model call and no output tokens, and `verifyJoin` refuses none of what the code path produces
  (issue #276). The 24 that stand down are 17 whose second half describes its columns differently —
  the commonest reason on that corpus — and 7 carrying an id with nowhere to move to.

  An id on the dropped half's own `<caption>` or `<table>` element does move, onto the counterpart
  that survives the join, and only where that counterpart carries no id of its own. Two live link
  targets collapsing onto one element is a choice about which link keeps working, and that choice is
  the editor's. Both paths go through the same verification and the same splice, and `table_joined`
  says `by: "code"` or `by: "editor"`, so the ledger can tell a pair the editor was asked about from
  a pair it was not.

- **How large the free share is belongs to the extraction and not to this code.** Three later rounds
  of the same corpus, with this stage, `agents/` and the model byte-identical, took 9 of 17 pairs,
  then 4 of 17, then 5 of 16 — 24–53%, a $0.72-per-100-pages swing in a step that is 11.5% of the
  bill, all of it in call count. Two readings of one printed header agree 48–61% of the time, so
  `header_differs` is usually a disagreement between two readings of one header rather than two
  different headers, and three separate guards were seen firing on pairs that had joined for free a
  round earlier (issue #326).

  That is why the decline line carries both headers on **every** decline rather than only on
  `header_differs`: a header comparison is evidence about a `columns_differ` decline too, and a field
  present on some declines only would have its denominator chosen by the reason. `headers_identical`
  is computed at the line rather than left to a reader of the two capped signatures, because a cap
  that cut both at the same prefix would read as agreement and manufacture the stability the field
  exists to measure — the cap is 1,200 characters, which this corpus's widest real headers (about
  750) do not reach. The block sizes are four numbers rather than two `rows x cells` strings so that
  nothing has to parse a count back out of a string, and because the cell counts are the only thing
  separating a declared header block from a header row that holds none — a distinction a rows-only
  reading turns into a disagreement, which is why the entry names the cell count as the field that
  says whether a half declared a block at all.

- **The guards are not loosened here, and the reason for not loosening them has been removed rather
  than restated.** #326's recommendation against it rested on there being no artifact a looser rule
  could be run against. What a loosening has to be scored on is not the pre-join body — which is
  still persisted nowhere — but the **pairs**, so both halves' bytes go on the decline line and on a
  free join's line, beside the header signatures that say why the pair was declined. A candidate rule
  is then run against the pairs a paid round already bought, its upside on the declines and its
  regressions on the joins it must not break, through the same parse the pipeline used
  (`pairFromHalves`) and the same `verifyJoin`.

  The bound on those bytes **refuses rather than truncates**, which is the one place it differs from
  the capped signatures: a cut signature still compares cell by cell as far as it goes, while half a
  table's bytes parse to a *different* table — fewer rows, no closing markup — so a rule scored
  against them returns a verdict that is not the rule's. It is 64,000 characters for the pair,
  measured against every pair the reference corpus's 75 delivered submissions produce: 200 of them,
  5,898–25,938 characters, median 11,026. So it is 2.5x the largest and drops none of them, and it is
  not quietly choosing which of that corpus's declines are scorable. What it protects against is one
  pathological document, and the per-document ceiling follows from the loop rather than from that
  range: at most 12 pairs reach a verdict in a run, so at most 12 of these blocks are written, which
  is 750 KB against round logs that run 220–940 KB. What the 200 real pairs add is 9–111 KB per
  submission, median 66 KB, and all 200 replay to the verdict their line recorded.

  That range is a corpus's cost and not a bound. This corpus's continued tables are all two-piece — 0
  of its 200 lines took the previous line's merge as its first half, on 47 that had a free join
  immediately before them — and a document of longer chains logs the growing merge on each pass.

  What the bytes still cannot score is upstream. A change to which tables are **paired** (the caption
  rule, the span match, adjacency) reads the whole assembled body, and a pair that was never formed
  left no bytes behind. A change to the **extraction** that produced the halves is a different
  document, so replaying it means buying a round — which is where the round-to-round instability #326
  measured lives. The
  price of all of it is that the run log holds page markup verbatim where it used to hold captions
  and signatures: still readable only by the owner of the session the page was submitted to, and
  still absent from `/v1/quality`, but a log is now a copy of part of the document rather than a
  description of it.

### The bracketed unit note

Four of the verification's reasons are about one thing: the `[In millions of dollars]` note a
continued page reprints. It is the part of this stage that took the most rounds to get right, and
every reason below was bought by a pair that shipped split or a defect that shipped clean.

- **The four reasons, and why they are four.** The 18 measured continuation pairs count the note as a
  full-width ROW, which is how it arrived before `page.md` said where it goes; the page rule now puts
  it inside the `<caption>`, so the shape the merge meets should shift from a repeated row to a
  repeated caption and rule 6's forgiveness of the promoted row should get rarer rather than holding at
  the rate measured then. Either way the note has to survive the merge exactly once. A joined caption
  that drops it is refused as `caption_note_lost` or
  `caption_note_struck`, by whether a row still carries it; a joined table that keeps it in the
  caption *and* as a row is `note_shipped_twice`; and a note **neither** caption carried, printed
  inside the header block by a half and gone from the delivered table, is `note_row_lost` — the pair
  the other three cannot see, because each of them is keyed on a caption note. Four reasons rather
  than one because a decline is all a run log has and they send a reader to different places: whether
  a row survived at all, the caption the merge was told to copy, a note delivered in two places, or a
  note no caption ever carried. They ask for the same one-sentence repair, so the split buys the log
  and not the model.

  The same note printed as a `<tbody>` row was refused all along, as `labels_lost` or `rows_lost`:
  its label *is* the bracketed run, so the row checks see it go.

- **`caption_note_lost` reads both halves' captions while rule 6's repeat set reads only the first
  half's.** Those answer different questions: what the merge may **drop** is a repeat and not a first
  appearance, while what the joined caption must still **say** includes a note printed over the
  continued half. Keyed on the first half alone it was a silent loss on the free path — `joinInCode`
  keeps the first half's caption and discards the second's — and `p049`/`p050` are a measured pair of
  that shape. A refusal costs one editor call rather than the table: the pair goes on to the Copy
  Editor, whose rule 4 asks for the note either half's caption carries.

  Rule 6's repeat set also ignores the block, where `caption_note_lost` compares it, and that is the
  same distinction and not two readers disagreeing about one fact: whether the second half is
  printing the same note **again** turns on the note, which is the same note wherever the printer set
  it, while whether the merge **kept or moved** it turns on the place, because the place is the harm.

- **A note counts as kept in the joined caption, or — where the caption that carried it is the one
  rule 4 discards — as a note row one of the halves printed in that same part of the table.** Reading
  the caption alone refused the mirror of the pair rule 6 joins for free: the note a ROW on the first
  half and a caption note on the second, where the row survives the merge and nothing is lost.
  Reading any note row in the answer is the opposite hole — a note that arrived in a caption and left
  as a row has been demoted into the phantom row `page.md` forbids, `<thead>`-closing form included,
  and counting it as proof of keeping would clear exactly that. `joinInCode` never demotes, so the
  shape is the Copy Editor's: rule 6's "belongs once, at the top" can be read as licence for the row
  while rule 4 asks for the caption, and rule 6 now says so.

  The distinction is on the pair: each half records the bracketed note rows it printed — over every
  row and not over its labels, because a label list drops header rows and a note row printed inside
  `<thead>` is one, the `p068` shape the census counts — **and the block it printed each one in.**
  Both facts, because matching on the text alone failed on the pair the census makes likeliest: the
  note in the first half's caption (56 of the 77 arm-pages, the placement `page.md` asks for) and
  printed as a `<thead>` row by the second (1 of the 12 outside the caption). A merge that struck the
  caption note and delivered it as a `<tbody>` cell of data matched the second half's text and
  cleared — the same demotion, with the caption no longer naming the units and a reader moving by row
  meeting them as data.

  A row precedent excuses only one of the two captions, and reading it as excusing both left the same
  demotion clearing in the commoner spelling: the note in the first half's caption and printed as a
  **body** row by the second, which the block comparison cannot see because the delivered row and the
  printed row sit in the same block. Of the twelve notes printed outside a caption, seven are a `<th>`
  row and two a `<td>` row against two closing `<thead>`, so that is the likelier mixed pair of the
  two.

  So the two shapes are mirror images and were being read as one. A note in the caption rule 4
  **discards** goes with a duplicate caption being dropped whole, while the row stands in the half and
  the block that printed it: nothing moved, and that is the pair rule 6 joins for free — for free
  whether or not the first half has a caption of its own, which took a round to make true. A note in
  the caption the join is **built on** is different: the surviving caption has been edited, text
  struck out of the one caption rule 4 says to copy, and the other half having printed the same note
  as a row does not make that a move of nothing. A note in the title caption is therefore owed the
  joined caption and nothing else will do, and only a note the discarded caption carried may be
  answered by a row. The title caption is the first half's, or the second half's where the first has
  none, which is rule 4.

  That is **not** the same predicate `joinInCode` branches on, and stating the two as one would be
  the fourth comment on this check to claim an invariant it does not hold. The verification reads the
  caption's normalized **text**; `joinInCode` asks whether the caption **element** is there. They
  part over one shape — a first half whose `<caption>` holds markup and no text — where `joinInCode`
  keeps that empty caption and imports nothing, so the merged caption normalizes to `""` and
  `no_caption` answers the pair before any note check runs; on the editor's path, falling to the
  second half's caption is what rule 4 asks for anyway. No outcome turns on the difference.

- **Rule 6's condition for dropping the repeat row is the caption the editor is writing, not the half
  that printed the note.** It used to read "where the first half already carries that note in its
  caption", which is false of the pair whose first half has no caption at all: rule 4 puts the note in
  the joined caption because the continued half's caption carried it, the first half's note row
  repeats it, and no sentence said to drop that row. Rules 4 and 6 together asked for the shape
  `note_shipped_twice` refuses — a refusal the prompt could not avoid, which is a permanent decline
  rather than a repair. Pinned in `test/table-continuation.test.ts`, both routes to the caption and
  the forbidden direction with them.

- **The lenient reason is asked first, and that ordering is what makes each reason mean something.** A
  note in neither the joined caption nor an excusable row is gone from the delivered table, which is
  `caption_note_lost`; `caption_note_struck` is then left saying the one thing the lenient half cannot
  refuse — the note is still in the table, as a row a half printed where it printed it, and missing
  only from the copied caption. That is the demotion, and nothing else reaches the line. Asked the
  other way round, the strict half answered first for every pair whose note simply vanished and
  reported a striking-out on pairs where nothing was struck.

  Which makes the free path's reach here derivable rather than asserted. The only thing that can
  remove text from the copied title caption is the marker strip, and it eats a run introduced by `—`,
  `–`, `-` or `(` — so `caption_note_struck` on a code join would need the printed note to **contain**
  the continuation marker (`[In millions of dollars—Continued]`) and a half to have printed that same
  run as a row to get it past the lenient reason. Absent that shape, the free path copies the caption
  verbatim minus the marker and every note in it survives by construction, so this reason is the
  editor's.

- **`note_shipped_twice` reads the delivered table and no half's printing excuses it.** Rule 6 says
  drop the repeat and do not also copy it in under rule 1, and nothing here read that half of it — a
  printed row is only ever an **excuse** for a note missing from the caption, so a note row excusing
  nothing was never looked at. A reader moving by row still meets the units as a cell of data, which
  is the harm `page.md` names, with the caption merely also correct. One note once is what both rule 6
  and `page.md` ask for, and a doubled note is the phantom row whichever page printed it.

  What it may refuse on a **free** join had to be narrowed to one shape nothing has measured: a half
  that printed the note in its caption **and** as a row of its own, which `joinInCode` carries through
  because it drops repeats and not a first appearance printed twice. That pair goes to the editor,
  whose rule 6 asks for exactly the table this wants, so the refusal is satisfiable rather than a dead
  end, and it is left unexempted on purpose — an exemption for "the page printed it twice" is a
  distinction drawn on no measured pair, since the census has the note in a caption on 56 arm-pages
  and outside one on 12, and never both on one page.

  What it must **not** refuse for free is the doubling the merge itself makes, and at first it did.
  Where the first half has no caption, the code path imports the second half's **with** its note
  (rule 4's `no_caption_available` exception) and used to keep the first half's note row beside it —
  both placements the census's measured ones, so a pair whose page printed the note once bought an
  editor call and shipped split wherever that call declined or failed. Fixed where it is made rather
  than by an exemption in the verification: the imported caption now names the units, so the first
  half's row saying the same thing is the repeat rule 6 licenses dropping, and it is dropped there.
  Two limits on that drop, both in the code path so the reason can name them — a row carrying an
  **id** declines as `id_would_be_lost`, since where a footnote anchor belongs on the surviving markup
  is rule 2's reading for the editor, and more than one dropped repeat in one join declines as
  `note_repeats_exceed_licence`, because past that the verification would answer `rows_lost`: a reason
  about rows for a note the caption still carries.

- **The row allowance is the larger of two numbers and never their sum.** Rule 6's one row
  (`JOIN_DROPPABLE_ROWS`) and the rows the finished **caption** accounts for, because the row floor
  and the drop licence have to agree about the same table. A row whose note the caption carries is a
  note promoted rather than a row lost, and the row check forgives it by name, so counting it against
  the licence declines a pair this path's own verifier accepts: the one the two-drop bound used to
  refuse is ordinary — the first half printing the note as a row with no caption of its own, the
  second printing it in **both** places, so the import carries the note and two rows repeating it go,
  which is rule 6's own answer refused for being it twice. Counting it as free on **top** is the
  opposite error and the worse one, because the pair then joins and comes back `rows_lost`: an editor
  paid for an answer the same floor refuses again, and then the halves ship split. Both readings were
  shipped, one commit apart, before the `max` that is neither.

  The absorbed rows **replace** the one forgiven row for the same reason, which took a round to see:
  that row is there to forgive rule 6's repeat drop, so a note row the caption accounts for has
  already been paid for once, and granting both let a pair lose a real row on top. On the census's
  commonest pair — the note in the first half's `<caption>`, printed as a row by the second — a reply
  that dropped one unlabelled continuation line as well went from `rows_lost` to clean, and so did
  both promotion shapes. The label check cannot cover for it, because the row a lossy reply drops need
  not have a label, and `rowFloor`'s own comment names those continuation lines as the loss it exists
  to catch.

  What the bound is left holding is the drop no caption accounts for — a repeat of a note the first
  half prints as a row while its caption does not — where each dropped row is just a row and declining
  is `rows_lost` one editor call earlier. Two shapes get past it, neither measured: such a row dropped
  **twice**, which needs the **continued** half printing it twice itself, and **two distinct notes on
  one table**, which is 0 of the 769 tables in the round logs. Not the first half printing it twice —
  the bound counts drops, and a first-half duplicate is never one: with a caption of its own nothing
  in the first half's rows is removed, and without one the import carries the second's note, so every
  drop the removal makes is covered. Not the mixed pair above either, though it is the pair the bound
  refused two commits ago and so the one a reader is likeliest to come looking for. The second shape
  is a genuine over-refusal rather than a decline in the right direction: a correct join of it exists
  — rule 6 to the letter, keep the first half's second note row, drop both of the second half's — and
  the floor refuses that answer too, since it licenses the caption's rows and one repeat, not two. So
  the pair ships split, from the code path and from the editor alike. Widening the floor to license a
  repeat per distinct note is the fix, and it is not worth doing against no measured pair.

- **Both spellings of the repeat row are dropped, `<td>` and `<th>`, and that took `header_cells_lost`
  being asked on the right cells first.** A bracketed note row inside the header block is **not** a
  header cell — `read`'s `headerCells` skips it whichever tag it used — because rule 6 tells the
  editor to carry that note into the caption once and print no row for it, so counting its
  `<th colspan>` made the check refuse the answer the prompt asks for. On the corpus's own ink: of the
  two phantom `<thead>` rows the census located, `p068` spells it `<td colspan="8">` and `p029` spells
  it `<th>`, and 6 of the 8 across every round log are `<th>`. Guarding the free path's drop instead —
  leaving a `<th>` note row in place so the reason came out as `note_shipped_twice` — treated this as
  the code path's problem, and it is not: the same count refused an **editor** answer that obeyed rule
  6, where the price is not one call but both halves shipped split. What the count exists for
  survives, because a reply that flattened the real column headers to `<td>` still loses every one of
  them.

- **`note_row_lost` is bounded by the block the row sat in.** Every reason above it is keyed on a
  caption note, so on a pair whose halves printed the note only as a row there was nothing to compare
  and the harm the placement rule exists to remove had nothing looking for it — on the census's 12
  outside-caption placements. A note row in `<tbody>` is a data row whose **label** is the bracketed
  run, so deleting it was refused all along as `labels_lost:1`, or `rows_lost` where both halves
  printed it, and still is, because both are asked first. That order is right: an answer that dropped
  the note row and three state rows should report the four and not the one. So the case this reason is
  for is the row inside the **header block**, in either spelling, where `labels` skips it and
  `rowFloor` forgives it; the `<tbody>` case deserves the same name and does not get it. What
  narrowing `headerCells` changed is that `<th>` in `<thead>` stopped being caught as a lost header
  **cell** — the wrong name for it, and the only name it had. Asked last so the caption reasons keep
  the pairs that have a caption note to lose, and compared on the note's **text** and not its key: a
  note the merge moved from `<thead>` into `<tbody>` is a relocation, a different defect, and naming
  it a deletion would point the repair at rule 6 instead of at `page.md`.

  The block decided **deletion**, and for one commit it also decided the answer `page.md` wants.
  Promotion into the caption — the note in the caption once, the rows it was printed as gone — was
  accepted for the header-block row and refused for the `<tbody>` one as `rows_lost`, because
  `rowFloor` nets header rows out through `headerDropped` while a `<tbody>` note row counts against a
  floor that forgives one row. The two answers differ in where the printed page put a row, which is
  nothing the merge chose and nothing a reader of the delivered table can see, and the refusal ships
  both halves split. Hence the exemption at the row check. An outright deletion is refused exactly as
  before under all three names, and a promotion that also drops a data row still reports one — as
  `rows_lost` now rather than `labels_lost:1`, since a row did go and the row check is asked first.

- **What all four compare is a note's text, the block it sits in, which caption owed it, and whether
  the delivered table holds it in two places at once — nothing finer.** A note **moved** is invisible,
  within one block or between them, and so is a `<td>` note row delivered as a `<th>` one: `page.md`
  forbids both spellings, but the note in them has not been lost and none of these reasons is the
  right one to refuse a table over. That now holds for both spellings on every path through this
  stage, which it did not for one commit. Refusing the **editor's** answer ships both halves split, so
  a reason naming the wrong defect buys a split table and points the repair at the wrong rule.

  Stated as a property rather than a list of cases, because the list was written twice and was short
  both times: **a note the merge kept in any form this cannot see reads as a note lost.** Each such
  refusal is safe — the pair declines and both halves ship — and each costs a join that lost nothing,
  which is the reason the match is not loosened instead: a looser one would forgive the drops it
  exists to catch. The measured residue is the spellings it does not read: a parenthesised note (6 of
  the 68 delimited notes in the reference corpus) and a note printed with no delimiter at all (3
  arm-pages) can go missing without this seeing it, and a check demanding every parenthesised run
  survive would demand the survival of `(continued`, which rule 4 requires dropped.

  It is a shape test and not a reading, so what it owes is every bracketed run in either caption and
  not only a note of measure. A caption carrying `[Sheet 2 of 3]` is owed too, and two captions
  carrying different runs — `[In millions of dollars]` against `[In thousands]` — can be satisfied by
  no joined caption that does not invent, so that pair declines for good and reports the loss rather
  than the units disagreement that actually happened. Left that way on purpose: every caption bracket
  in the reference corpus is a note of measure, so a reason for the disagreement would be a
  distinction drawn on no measured pair.

### What is deterministic, and what the answer is checked against

- **Everything around the ask is deterministic:** which tables are halves (the caption rule), where
  their bytes are, whether the answer kept the table, and the splice. The body is never reserialized.
  The halves' source spans are found by a depth-counting scan and checked against the parsed DOM, and
  the reply is spliced in as a string, for the same reason `anchors.ts` refuses a whole-body round
  trip. A pair whose bytes the source does not delimit is left alone (`unmatched_source`); that is
  what an unclosed `<table>` on a page does, since an unclosed opener swallows the table after it.

- **The answer is verified:** one table, a caption without the marker, no column lost, a header block
  still made of `<th>` cells, and the rows accounted for two ways. Labels as a **set**, because the
  duplicated header block legitimately goes and a legitimately dropped duplicate row must not read as
  loss — and over all cells, not first cells, so a label the merge moved along a column still counts.
  And a **count** floored on both halves' rows, less one header block and less the larger of one row
  and the note rows the joined caption absorbed — [never their
  sum](#the-bracketed-unit-note).

  The header credit is the more permissive of two readings: one shared block, at the smaller of the
  two declared depths, or whatever the joined table's own depth says went. Each of them is wrong once.
  The halves declare headers of different depths in 4 of the 18 pairs, so the smaller depth alone
  under-credits a merge that kept the deeper block. And reading the drop off the joined table alone
  charges a merge that *promoted* the reprinted unit note into `<thead>` for a row that is still in
  the table, which cancels the one drop the prompt asks for and refuses the same content for sitting
  on the other side of `<thead>`.

  The shared-block reading is bounded by that same one row, because the two things that deepen a
  joined header are a row promoted into it and a header block *kept*. Past one block plus one row, the
  merge is carrying the duplicate header this stage exists to remove, nothing went, and the
  shared-block credit would hand back that block's worth of unlabelled rows. To within one row, that
  is: a reply that keeps a single duplicated header row is inside the bound and can lose one
  unlabelled row with it, which is the size of the drop the floor forgives anyway and indivisible
  from the promotion the prompt asks for. What is ruled out is slack a whole header block deep.

  The count is needed at all because the label set is blind to a row that has no label. A printed
  statistical table gives a multi-line row label continuation lines whose first cell is empty, and
  neither a label set nor a floor at the larger half can see those disappear. Header cells are checked
  because nothing else would: a merged header block returned as `<td>` keeps every label, every column
  and every row, and axe reports nothing on a data table with no headers, so it would ship having
  removed the header association from the tables this stage exists to improve. That check is floored
  on the **smaller** half's count, because collapsing two header blocks into one legitimately loses
  header cells and the halves may describe their columns at different depths — and only over the
  halves that declared a block, since a half with no header cells has no block to collapse and its
  zero is the absence of an allowance rather than a smaller one. Read as a plain minimum it took the
  floor to zero and the check with it: on a pair whose second half is a rowless header stub, a reply
  flattening the first half's whole block to `<td>` would have passed.

  The order of the reasons is only which one a failed pair reports, since every one of them refuses
  the join. The four note reasons are last on purpose: a merge that dropped the note *and* lost rows
  should say `rows_lost`, because the note is the cheapest of these losses and would otherwise mask
  the dearest.

- **Three guards belong to the code path alone**, none of them visible to the verification, which
  reads columns, header cells, rows and labels and never reads an id. A half whose span parses to
  anything *outside* its own table is declined, since the parser fosters a stray `<p>` out of a
  `<table>` and `outerHTML` then does not carry it — the one thing this path does that can lose
  content where a model reply cannot. A join that would print one id twice is declined. And so is a
  continued page whose rows run wider than the first half already is, which is what a page that
  reprinted no header at all can do, since then there are no two header blocks to compare.

- **Any failure keeps both halves byte for byte**, which is what makes this safe to ask a model for.
  Unlike a correction round, which adopts a whole new body, a refusal here costs one table's structure
  and not the document. That includes markup no parser can read: jsdom parses by recursion and a body
  nested a few hundred thousand levels deep overflows it — about 200,000 levels is reachable, because
  `anchors.ts` delivers a page past 500 levels as written — so the failure is caught and the document
  ships as it arrived rather than the phase failing.

- **A failed pair is not asked twice**, and it is remembered by its two halves' bytes rather than by
  its caption, since two pairs in one chain share a caption and one refusal must not silently cover
  both. It runs where the pages are joined, before the shell and before the lint, so the document the
  gate cleared and the document the Reader reads are the document that ships.

## Extraction: verdicts and empty pages

- **A verdict that cannot be obtained is not a page that cannot be extracted.** `verifyAgentOutput`
  is non-blocking for an absent Feedback Agent and for a reply that will not parse, but a provider
  error is *rethrown*, and the first verify call had nothing to catch it. So a throttled or over-long
  **check** propagated out of the page's own extraction, logged `page_extraction_failed`, and shipped
  a `@page-failed` comment for a page that had rendered fine (issue #364).

  Measured once on a 100-page bench arm: a page extracted as 8,855 characters of HTML — a complete
  statistical table, 568 words — delivered as a 156-byte comment, and **$0.5051 of that page's
  $0.6634 was the call that deleted it**, 3.2x what the extraction it was checking cost.

  The fix is the policy this pipeline already applies to every other specialist, arriving one call
  earlier. A specialist that fails leaves the page as the general pass wrote it, and a fidelity check
  that cannot run is nothing to correct — so no correction is bought and the page ships as extracted.
  On a page whose only repair would have come from the verdict, that is exactly what an unconfigured
  deployment delivers.

  **Exactly, but not on every page**, and the exception is worth stating because it is the one axis a
  reader can check. With no Feedback Agent loaded, `verifyAgentOutput` returns a passing unjudged
  verdict at *both* call sites, so a links- or alt-triggered correction reaches the binding recheck,
  is judged unjudged-ok, and is **kept**. Under a throttle that recheck throws too, and the
  correction is discarded. So a page with a dropped `href` ships without it here and with it there.
  That is the discard decision below, taken knowingly; what is not claimed is equivalence on the page
  it costs something.

  Three things the misattribution cost besides the page, and they are why this is its own
  `page_verify_error` event rather than a quiet `catch`:

  - The delivered document asserted the source pages "could not be extracted", which was false.
  - `pages_failed` and every triage of *why* pages fail recorded a vision failure, so anyone tuning
    the page agent on that signal was tuning the wrong agent.
  - The marker told the operator to raise `providers.*.max_tokens`, which buys the verifier room to
    write **more** about a page it has already judged — the wrong lever, pushed the wrong way, on the
    one line the operator was given.

  **The second unguarded call site was not in the report and cost more when it fired:** the
  `recheck_binding` gate, which throws away a page that had rendered, *passed*, and been corrected —
  two calls' work, not one. There the failure is a decision rather than a default, and it is taken
  the conservative way. That recheck exists to stop a correction bought for one link or one
  placeholder alt from damaging a page that had already passed, so no verdict is no licence, the
  correction is discarded, and the page ships as it was — which is the same answer the branch gives a
  verdict that *fails*. The correction is billed either way, and `correction_discarded` on the line is
  what says the money bought nothing.

  **The two failures are counted in different places, because they are not the same kind of page.** A
  failed first check makes the page *unjudged*, so it counts as `pages_verify_error`, a subset of
  `pages_unjudged` and so of `pages_verified`, and no published rate moves. A failed binding recheck
  does not: that page has a real first verdict and it **passed**, so counting it as unjudged would put
  a judged page inside the unjudged total. It counts as `rechecks.binding_error` instead — disjoint
  from `binding`, `binding_ok` and `binding_unjudged`, which are fed from the recheck's own verdict
  line and so cannot see a recheck that produced none.

  Giving it a number rather than only a sentence is the point: it is the more expensive shape, and its
  only other trace is `page_corrected` `result: "rejected"`, pooled there with the shrink floor and
  with a rewrite a second verdict actually refused — and those were judged, while this one never was.
  `pages_verify_error` in turn is kept apart from `pages_skipped_blank` because those two point
  opposite ways in money. A blank skip is a call not made and is a saving; an error is a full ceiling
  of output billed for no verdict. Adding them would price the most expensive shape of verification
  failure as a saving. The third verify call, the *sampled* recheck, was guarded already
  and keeps its own older `page_correction_recheck_failed`: it decides nothing whether it answers or
  not.
- **A page the document has no content for is reported once, not once per chunk.** Two kinds of
  source page contribute nothing. One is an extraction *lost* (`pages_failed`, and a `@page-failed`
  comment where the content would have been); the other is *blank in the source*, delivered as an
  empty page because that is what the paper says (`page_blank`). No correction round can act on
  either — a page that was never extracted is not something an editor can repair — but the Reader was
  asked about both, once per chunk.

  `runReader` gives every chunk the same page index so the bytes can be cached. A lost page's entry
  there was the failure's own marker and a blank page's was an empty line, and every call that saw one
  reported it in its own wording: no two reports matched, and exact-string dedupe caught none of them.
  On the round that filed issue #188 that was 6 of one document's 26 unresolved issues for a single
  page, and a longer document has more chunks.

  The delivered list is the *final* round's read (`@unresolved` is written from it), so that read's
  chunk count is the multiplier. What the iterations multiplied was the spend, since every round's
  editor was handed the same reports about a page it cannot repair. Both entries now say what the
  page is and that it is not an issue to report, `READER_SYSTEM` says the same with the reasons, and a
  round's repeats are reduced to one report per page (`reader_page_reports_deduped`, which logs what
  it dropped).

  The FIRST report is kept rather than all of them dropped. An issue attributed entirely to pages
  with no content can only be about the absence, but that attribution is the Reader's, so a
  misattributed real issue must not vanish without a trace. An issue naming any page that *does* have
  content is never touched. And the Reader is now told which case it is in: the HTML section says
  `window N of M` when the body was split, and only then is a page whose content it cannot find
  someone else's to read. On a single-chunk document the Reader is the only check that content went
  missing at all, and it keeps that licence.

  **The label is also named as never being a defect itself, and so are the window's own cut edges
  (#274).** Telling the Reader what the label means turned out not to be the same as telling it the
  label is not part of the document. Benchmarked in the Reader seat, Claude Haiku 4.5 filed the
  windowing apparatus as an accessibility problem in 7 of 163 issues where Sonnet 4.6 filed it in 0
  of 197. Three of the seven were the label proper, once suggesting the fix was to "review the
  complete document (all 3 windows)"; two were the cut edge; one was the corpus artefact the filing
  disclosed; one was a `(CONT.)` report too truncated in the log to attribute.

  Each of those costs an editor call, and
  that round's page images, on a document that is not broken. Since nothing downstream can edit the
  prompt, the issue returns every round.

  The cut edges are the same shape one step down: `chunk()` slices on a character count, so a window
  can open mid-sentence or mid-tag, which one model reported as content lost. Both prohibitions were
  written because a Reader swap is a live option and this is how a prompt that misleads the field
  goes unnoticed — but not because the risk belongs to the cheaper model, which is what the
  measurement below took away.

  **The incumbent is not exempt — and one pair of runs locates a model, it does not give it a rate.**
  The measure is violations per multi-window document, over 20 documents (18 of them long enough to
  be windowed, 45 windows) and two runs of the identical prompt. It is measured at both Reader
  prompts this repo has shipped: `158e3d9`, and the current `e842faa`, whose *Reader prompt* differs
  from it only by the appended sentence in the bullet below. The builds are four commits apart; the
  provenance paragraph below says why that does not reach these figures.

  **At `158e3d9`:** `gpt-5.6-luna` **0.00** (0 and
  0), the incumbent `claude-sonnet-4-6` **0.03** (0 then 1), `kimi-k2.5` **0.25** (6 then 3),
  `claude-haiku-4-5` **0.31** (6 then 5). **At `e842faa`,** same corpus and same design: Luna **0.00**
  (0 and 0), the incumbent **0.14** (4 then 1), Kimi **0.08** (1 then 2), Haiku **0.28** (5 then 5).
  The thesis is stronger at the shipped prompt — the incumbent is second-worst of four rather than
  nearly clean — but the arithmetic that carried it is gone: it is five violations against thirteen
  over the same 36 document-runs, and the incumbent's five is *more* than Kimi's three (#308).

  **The prompt change is not the lever, which is what four models measured at both shas are for.**
  All four were given the same appended sentence. The incumbent rose by four violations, Kimi fell by
  six, Haiku fell by one and Luna did not move. There is no common direction, and every per-model
  shift is the size of that model's own spread between two runs of the *identical* prompt: Kimi's two
  runs at `158e3d9` differ by 3 violations, the incumbent's two at `e842faa` by 3. So a pair of runs
  resolves a model to within a few events on 18 windowed documents, and no more than that — which is
  also why #274's "0 of 197" was a sample rather than a property.

  What does reproduce is what has four runs behind it: **Haiku is the worst violator at both prompts**
  (6, 5, 5, 5) and **Luna files none at either** (0, 0, 0, 0). Four more models file 0 violations and
  never mention a window at all, on one run each at `158e3d9`: `pixtral-large-2502` (231 issues),
  `gemma-3-27b-it` (111), `nova-2-lite` (75), `qwen3-vl` (11). Read the last two as silence rather
  than compliance, but `pixtral-large` files more issues than the incumbent's 187 in the same round,
  so it is a second credible zero on a quarter of the evidence.

  **Compliance does not track price, in either direction**, which is the part to carry into a swap,
  and it reads more sharply at the shipped prompt than it did before. The cheapest model in the field
  is the most compliant (Luna **$0.0165** per document at 0.00), the second-cheapest is the worst
  (Haiku **$0.0358** at 0.28), and the dearest sits between them (the incumbent **$0.0931** at 0.14),
  with Kimi at **$0.0207** and 0.08. `pixtral-large` files 0 at **$0.0721** — dearer than Haiku, and
  still one round at `158e3d9`, its price as much a single sample as its zero.
  So "a cheaper Reader is the risk" is not the rule, and neither is its inverse. The number has to be
  measured per candidate (#301).

  **More prompt text is not the remedy, and the evidence is inside the violations.** In the clearest
  cases the model states the rule correctly and files anyway, in the same issue. The incumbent
  identified a seam as an interior one — "this is the document's window boundary edge and not the
  document's own close" — and then asked that window 2 be verified, which is the specific thing this
  paragraph forbids. Kimi put "window boundaries are not document defects" in the `suggested_action`
  of an issue whose entire content was the label. The failure is not comprehension, so the wording
  stays as it is. A keyword filter on "window" would be worse than the problem, for the reason the
  exemption exists: the same sentence, "ends mid-sentence", is a violation at an interior seam and a
  *required* finding at the last window's end — which the incumbent's other run got right. The
  code-side prose filter stays declined on its own measured ground (prose matching fails at 2%, and
  its false positives delete real findings).

  **The same behaviour has a wider form that is not about windows and is not about this prompt: an
  issue whose own `suggested_action` says nothing needs doing.** Per document, counting issues rather
  than documents, over the same four rounds: Kimi **1.10, 0.70, 1.25, 0.75** — roughly one per
  document at both prompts, 6%–9% of everything it files. The incumbent is **0.00, 0.05** at
  `158e3d9` and **0.30, 0.05** at `e842faa`, Haiku **0.20, 0.25** then **0.15, 0.10**, and Luna
  **0.00** in all four.

  It is a standing charge on the models that do it, largest by an order of magnitude on the candidate
  these bullets measure most often. And it is *not* an effect of the appended sentence: Kimi's rate is
  unchanged across the two prompts, Haiku's falls, Luna's stays at zero, and the incumbent's rise is 6
  issues in one run against 1 in the other (#307).

  Adding a clause that says a discarded observation is not written down anywhere — not as reasoning
  and not as an issue asking for no change — is a plausible fix and is *not* in the prompt. The case
  for it rests on a per-model rate that one pair of runs cannot resolve, and changing these bytes
  restales every Reader figure on this page. What would settle it: the clause as an arm against the
  shipped prompt, two runs each, on the incumbent and Kimi, scoring self-cancelling issues per
  document alongside issues per document so a drop in the first is not bought with a drop in the
  second. `node selfcancel.mjs <rounds> --rows` prints every match; its detector is a text heuristic
  rather than one of Iris's predicates, which is why it prints them.

  **What this asks of a Reader swap** is that the count travel with it, because it is a recurring
  charge: every violation reaches the Copy Editor as work on a document that is not broken, no edit
  can change Iris's prompt, so the issue is filed again next round. Compare **violations per
  multi-window document** — not per issue, since a model that files more issues is not thereby less
  compliant, and not per document, since a corpus of short bodies cannot show the defect at all (a
  single-chunk body carries no label; `test/no-content-pages.test.ts` pins that) — over **two runs,
  not one**. It costs nothing once a round exists: `node windowviol.mjs <round>` in
  `equalify-iris-bench`, which prints every row so the classification can be argued with.

  **Every figure above is labelled with the Iris sha it was measured at, because that is how the
  first version of this bullet went stale within the hour.** It was committed with figures from
  `runs-reader-probe` and `runs-reader-selfagree`, both at `158e3d9`, fifty minutes after `e842faa`
  changed `READER_SYSTEM` — the change the bullet below asks to have this very count re-measured on
  (#308). The `e842faa` figures are `runs-reader-newsha` and `runs-reader-newsha2`. All four rounds
  are re-derived here rather than quoted.

  The published $/doc figures are `runs-reader-newsha` and `runs-reader-newsha2`'s `usd` over their
  succeeded documents. That is the same pair as the `e842faa` violation counts, so both halves of the
  price-and-compliance sentence come from one pair of rounds, and a model's price spans exactly the
  rounds its violation count does. That leaves the four one-run models as one sample on both axes,
  `$0.0721` included, still at `158e3d9`.

  **These prices meter the Reader and nothing else**, which is what makes a price comparison across
  two shas an A/B on the prompt rather than on the four commits between them. Every priced call in
  all five rounds is `agent: reader`, `step: read` — 945 of them, with no extraction, editor or
  verify call in any round. The harness drives `runReview` with `ctx.maxReviewIterations = 0`, and
  that is the part doing the work: `runReview` calls `runEditor` whenever the Reader returns issues,
  which on these rounds is every document, so it is the cap that breaks the loop before the editor,
  not the entry point.

  The four commits between the two shas do touch this file, but on the editor path — #295 and #300's
  truncation salvage — and the only change they make to `READER_SYSTEM` itself is the append, which
  is the one line of `git diff 158e3d9 e842faa -- src/pipeline/review.ts` that lands inside the
  template.

## Correcting a page against its image

A page whose fidelity check failed, or that code found a defect in, goes back to the page agent with
the image. The run log entries [`page_corrected`](API.md#page_corrected),
[`page_correction_failed`](API.md#page_correction_failed),
[`page_correction_recheck`](API.md#page_correction_recheck) and
[`page_redrawn`](API.md#page_redrawn) say what a caller does with each outcome. This section is why
the rules behind them have the shape they have. What happens when the verdict itself cannot be
obtained is [above](#extraction-verdicts-and-empty-pages).

- **Five things can send a page back, and that number grew**: two until #290, three until #373 and
  four until #334. So a share taken over [`trigger`](API.md#page_corrected) across rounds is taken
  over a population that changed under it — the older rounds had fewer sources to fire on.

### What a correction's alt fields can and cannot see

A correction re-emits the image description entire, so new WORDS are ordinary and a rewritten clause
is full of them. What is not ordinary is a named member moving between two of the description's
enumerations, or joining a list the earlier reply had already written. Those are the two reviewable
shapes issues #355 and #373 asked for, and neither is a boolean: a flag saying something moved
somewhere is not a claim anyone can check afterwards, so `alt_relocated` and `alt_added` name the
members instead.

- **The two readings are not the same match, and the asymmetry is deliberate.** "Named nowhere" folds
  case and reads the normalised member, since a generous reading there only makes the field quieter.
  "Still names it" matches the member exactly as the earlier reply wrote it, capital and abbreviating
  dot included, because a generous reading on that side puts a WRONG name on the line — a member
  whose abbreviation is also an ordinary English word (`Or.`, `Miss.`) is otherwise found in the
  corrected description's prose and its expansion reported as an arrival. That is the one thing these
  fields must not do: a name here sends a reader to look for a member that arrived, and a wrong one
  sends them looking for one that never did.

- **What the exact test costs, in its own terms**, since it is wider than the re-spelling it was
  written for. It is reached only for a member in NO category of the corrected description, so it
  bites where a member was re-banded out of every list AND re-typed — and then for ANY re-typing, an
  abbreviation losing its dot (`Wis.` written `Wis`) or a name losing its capitals (`MISSOURI`
  written `Missouri`) as much as an expansion — and every arrival in that description goes
  unreported. Either condition on its own still reports, for a re-typing that leaves the KEY intact,
  since case and trailing dots are normalised out of it. A re-typing that changes the key needs no
  re-banding at all — `N.D.` written `North Dakota` inside the list it was already in — and is caught
  by the guard rather than costing anything. That is the direction every bound in this module errs
  in.

- **Read across the whole description rather than per band**, because a re-spelling can re-band in
  the same stroke, and a check scoped to the band the new name landed in would report a place newly
  asserted into a band whose predecessor had already classified it.

- **Six names per field, budgeted separately rather than between them.** A shared budget would let a
  description that moved six members hide every one it added behind a cap spent on the other field.

- **The partition holds by construction rather than by a rule**, and what makes it hold is that the
  first test reads the earlier description's TEXT rather than its parsed lists. A band of one leaves
  no list behind, so a member read off the lists alone read as new — and the one move `alt_relocated`
  declines on purpose, out of a category of one, which has no first company to compare a second
  against, landed in `alt_added` instead.

- **A member merely dropped is on neither line**, because #373's evidence is about assertions the
  corrector makes rather than ones it withdraws, and the two text sizes already say a description
  lost prose.

- **`markers_added` is additions only, deliberately.** This corrector is handed the page image and
  resolving an illegible passage is its job, so a marker LEAVING is as often the repair as the harm;
  and where prose arrived the two text sizes say so, whereas for a marker no such number exists,
  because the marker is itself the prose. The copy editor's `editor_markers_changed` records both
  directions off the same shared constants, for the opposite reason — that stage is handed no image,
  so a marker leaving its body is a claim dropped rather than answered.

### The output ceiling a correction asks for

A correction is capped at twice what the first pass of that page spent — scaled up where a specialist
handed it a document longer than that pass produced — with a 4,000-token floor (`correctionCeiling`
in `src/pipeline/extraction.ts`). Before issue #285 it ran at the deployment's ceiling: one uncapped
correction ran to 32,000 tokens on a page whose render cost 6,233 and was discarded for being
truncated, and the error it raised advised raising the ceiling, which would only have bought a larger
discarded reply.

- **`ceiling_bound` exists because `ceiling` cannot say which term produced the number**, and the
  answer decides which constant a truncated correction is evidence about. Of the three corrections
  that truncated in one bench round, one is a `floor` line — a 1,618-token first pass capped at 4,000
  rather than 3,236 — so triaging all three as evidence about the multiple counts a line the multiple
  never bound, and raising the multiple would move that page's cap not at all (issue #365). Reading
  the term off the number instead is wrong on exactly one page: the one whose doubling lands on
  4,000, where the multiple is what bound it and `ceiling === 4000` says otherwise.

- **The head-and-tail excerpts are the evidence `ceiling` only poses a question about (issue #293).**
  The same cap is either too tight for a page that genuinely needs more room than its first pass
  took, or exactly right for a model that went on rewriting the page it was given, and nothing else
  on the line can tell those apart: two truncations at 34,573 and 41,959 characters against pages of
  11,908 and 11,456 were argued both ways off the same log, and the round cannot be asked again,
  because a truncation has already been billed for a full ceiling of output. Read as a ratio against
  the page, those two are 2.9x and 3.7x.

- **`shape` says where the reply BEGAN and not where the output went.** `bare_html` is how 24 of the
  180 corrections in that round answered, and the shape both of its page-shaped truncations had; a
  correction that starts the page and then narrates at it carries the same value as one that
  transcribed to its last character, both happened in that round on the same model, and the tail is
  still what tells them apart (issue #365).

- **Nothing is retried**, because a correction truncating because the PAGE is large will truncate
  again for a second full ceiling of output. The same argument turns the other way for a first draw,
  where the page does not survive its failure — see below.

- **`problems` and `kinds` are spelled exactly as `page_corrected` spells them (issue #182)**, so a
  failed correction and a kept one can be grouped by what was asked. Without it, the failures were
  the one part of the correction path that could not be grouped: 205 successful corrections in a
  bench round were split by whether the verdict named `content_missing`, the kind that asks a model
  for content its first pass never produced, and not one failed correction could be put in either
  half.

- **A correction that throws costs the correction and not the page (issue #171).** Before this, the
  error propagated out of the page's own task, the run logged `page_extraction_failed`, and a
  `@page-failed` marker shipped for a page the run still had — naming a stage that had worked.

### The recheck, and what a sample of one can say

- **At the default the sample is a count and not a rate.** One draw per run, so `1 of 1 cleared` is
  everything it says. Reading a proportion off it is what the field invited and got — four draws
  split 2/2 quoted as "half", and the same instrument reading 50% on one model's four draws and 25%
  on another's over one 100-page corpus (issue #288).

- **A census is what answers the question, and it has been run.** At a sample size at or above the
  page count the recheck costs one Feedback Agent call per correction; replayed off 57 corrected
  bench pages, **26%** of corrected pages clear their recheck against a **2%** floor for re-asking
  about the page as it was — 19 pages better and 2 worse, p = 0.000.

- **Which pages answer, between those two settings, is a deterministic threshold spread across the
  batch** rather than a random draw, and it is not evidence that any position is representative. It
  replaced a rule that handed the slot to whichever corrected page finished FIRST, which under
  concurrency is the front of the batch: on one 8-run corpus that put all 8 slots on six pages of
  100.

- **The four code-found counts are kept out of `problems_before`** because this verdict judges the
  fragment against the IMAGE and names the Feedback Agent's own problems. A link target does not
  appear in the image at all, and a placeholder alt or a duplicated id was found by code, so none of
  them could be counted coming out; folding them in would make a page with one fidelity problem and
  two gutted alts read as three-in-one-out — a correction that fixed nothing, logged as converging.
  `words_before` is the exception, because a visible hyphen is on the page and #334 found both
  candidate verifiers raising that family unprompted.

- **A failing recheck's problems go to `rechecks.failures` and not to `diagnostics.errors`**, which
  is failures of the run, and which rendered every one of these `"unknown"` while the diagnosis sat
  on the recheck line (issue #296).

### A draw that claimed nothing, and the corpus behind redrawing once

The gate on a redraw is that the reply asserted nothing, not that it was short — issue #365's
directive 5 asked for a floor of HTML characters. A floor reads what the parse produced, and a reply
Iris refused whole is 0 characters of HTML however much page it was carrying.

- **Replaying every candidate is what decided it.** Over every bench run log on disk — 2,639 files in
  the 80 round directories — 20 replies reach this branch, landing on **20 distinct round-and-page
  pairs**: **1.05%** of the 1,913 pages drawn at least once, and at least **0.48%** of individual
  draws. The distinctness is counted rather than assumed, because those pairs average 2.2 page-agent
  calls each. All 20 are `page_no_output` events and can only be, since every round on disk predates
  this branch. Replayed through today's parser, **three** survive: the other 17 are blank pages whose
  declaration [`page_blank`](API.md#page_blank) honours, and a character floor would have redrawn
  every one of them. The three that still arrive carry no declaration to read at all — no envelope
  survives the parse, so there is no `log` — and each of the three wanted the redraw. So the
  declaration test is right about all 20 where a character floor is right about 3.

- **Two of those 17 were refusals until issue #429**, one on the doubt word `noise` for a log reading
  *"blank apart from minor scanning artifacts (specks and compression noise)"*, one as
  self-contradicting for a log naming the image filename; both readings are
  [below](#reading-a-blank-page-declaration). Both pages are blank on more than one log's word —
  every page-agent reply on disk for those two images declares the page blank, 14 replies on one and
  8 on the other from three different models, and none of the 22 carries content — so the redraw they
  used to get bought a second copy of the same sentence at a full page's price.

- **The per-draw rate is a lower bound rather than a figure, and two shipped versions of this got it
  wrong.** `phase: "extraction"` carries 8,049 `agent_call`s, of which 4,147 name the page agent and
  3,902 the fidelity check on the same pages — but `agent_call` records no `step`
  (`src/store/runlog.ts`), and THREE call sites log under that agent and that phase: the draw, the
  correction pass and the specialist merge. So 4,147 bounds the draws from above and does not count
  them. In this corpus the third site contributes nothing and the inflation is corrections alone:
  `4,147 + 3,902` is the whole phase and `mergeSpecialist` runs only after a specialist returns a
  fragment, so no specialist agent ever logged a row here. That sum carries the claim by itself,
  where 0 `specialist_merge` `model_call`s is a fact about the 60 files that emit `step` and says
  nothing about the other 2,579. `model_call` does carry `step`, and only recent rounds emit it: in
  those 60 log files, 954 of 1,558 page-agent calls are draws and 604 are corrections, which puts the
  rate nearer **0.8%** if that mix holds. A correction always follows a draw of the same page in the
  same run (`correctPage`'s only caller is inside `extractPage`), which is what makes *pages drawn at
  least once* a sound reading of a population that counts corrections. The **1,913 is exact** —
  distinct round-and-page pairs counted off page-agent calls alone, where a mixed count gives 2,042,
  because 129 pairs carry a checker call and no draw.

- **Which files the corpus is is part of the figure.** A repo-wide `find` counts 2,657 `*.jsonl`, and
  the 18 not counted are two different things: 11 corpus manifests in the bench root, holding no
  extraction call, and 7 `*-dry.jsonl` probe logs under `bench-data/`, which DO carry extraction
  calls — 12 page-agent calls and 12 checks on 3 pages — and which any walker descending every
  top-level directory folds in silently. Page-agent calls, not draws: they are `agent_call`s, which
  is the word the paragraph above cannot narrow. It could not be narrowed here either, since those 7
  files log **0** page `model_call`s at all, so none of them is among the 60 that carry `step` —
  which is why 60 / 954 / 604 / 1,558 are the only figures this exclusion leaves alone. An earlier
  version of this got 4,159 calls and 1,916 pages, and it moves the headline: 20/1,913 is 1.0455%
  where 20/1,916 was 1.0438% and rounded to 1.04%. Four digits, because three would be 1.045, the
  half that cannot decide its own rounding. The 0.255% first shipped was wrong twice over: 20/7,843
  off a corpus missing the round directory named `runs`, where the phase-wide figure on the whole
  corpus is 20/8,049 = **0.248%**.

- **What the declaration test does not cover, in two spellings.** A blank page whose declaration
  `blankDeclaration` cannot see. One is **markup-only** — `<!-- blank page -->` is #219's own
  spelling, and with no envelope there is no `blank` field or `log` to read. The other is an envelope
  whose `html` is **not a string**, so `{"html": null, "log": "This page is blank.", "blank": true}`
  answers the question and is redrawn anyway. Each costs one call and changes no outcome: the second
  draw declares the page blank the same way, and the page is refused exactly as it is today. Nothing
  on disk has produced either shape — every one of the 17 honoured declarations sent `html` as a
  string. Believing a declaration whose `html` is null would change the **blank routing** (it would
  deliver such a page rather than refuse it), which is a separate question from this branch.

- **A truncated first draw is redrawn where a truncated correction is not**, because a correction's
  page survives its failure and a first render's does not. The choice is one more call or a hole in
  the document, and the one instance on disk is not a ceiling at all but an envelope one `}` short of
  a 3,437-character table of contents. A page that genuinely exceeds the ceiling loses the second
  draw as well, and its remedy is still `providers.*.max_tokens`.


## Reading a blank-page declaration

The run log entries [`page_blank`](API.md#page_blank) and [`page_no_output`](API.md#page_no_output)
say what a caller does about each outcome. This section is why the rule that separates them has the
shape it has. Every word of it was bought by a page that had been lost, and the errors it can still
make run in one direction on purpose.

- **A blank page is a reply that says the page is blank AND carries nothing a reader receives.** Both
  halves are required, and the second is *present and carrying nothing* rather than *empty markup*,
  because the empty `html` the prompt asks for is not the only way a model writes a blank page: of 78
  such replies in 818 initial renders of the bench logs, 33 spelled it in markup — 18 a bare
  page-break marker, 13 a comment (`<!-- blank page -->`), 2 an empty paragraph. Read as content,
  each of those was a page counted as having produced markup, with the comment or the anchor
  delivered into the document (issue #219). Prose is content whatever it says, so
  `<p>This page is blank.</p>` is delivered as the page's words — a page that *prints* "This page
  intentionally left blank" has that sentence as its correct transcription, and nothing in the
  pipeline can tell the two apart.

- **`dropped` is what makes a refused declaration triageable from a run rather than by replaying every
  reply.** The fragment delivered is `""` whichever spelling arrived, so without the field the line says
  a page produced nothing readable and not whether that was an empty envelope, a comment, or a marker
  naming a folio the paper never printed — `chars` is the length of the whole reply and not of the
  fragment. That is the half of #219's reconstruction its own fix left behind (issue #223). What
  `dropped` discards on the marker spelling is a `doc-pagebreak` anchor, and deliberately: every one of
  those logs says the paper prints no number, which makes the label the image's position in the file and
  the anchor a claim that the document's page 14 begins there.

- **`bare_html` earns its keep on [`page_correction_failed`](API.md#page_correction_failed)**, where 24
  of 180 corrections in one bench round answered in bare markup and were being read as `prose` (issue
  #365). On [`page_no_output`](API.md#page_no_output) the value is two findings with opposite remedies
  and cannot separate them by itself, which is why `dropped` sits on the same line.

- **The declaration is a field first, a sentence second, and the field states without being able to
  deny.** `"blank": true` is what the prompt has asked for since issue #371, and `blank_stated: true`
  records that it arrived that way. Five blank pages had been lost to five different words while the
  sentence reading was being got right — `resolve` (#190), a contradiction that was not one (#194), a
  negator four tokens behind its noun (#220), `image` (#343), `document` (#367) — and each fix bought
  only the word it was written for, so a reply that can simply state the answer is the one change
  that is not about a word. `"blank": false` is read as no answer at all and the sentence decides,
  exactly as it did before the field existed, so every error the field can make is in one direction.
  It is read loosely enough for `"true"` as a string and no further: `1`, `"yes"` and `"blank"` are
  silence, because a field loose enough to accept them deletes a page on a typo. And it cannot
  declare a page blank that came back with a page on it.

  How much the field now covers is **unmeasured** — `blank_stated` postdates every bench round on
  disk, so nothing recorded says what share of today's declarations state blankness rather than leave
  it to be read out of a sentence. The sentence reading is therefore the floor under every reply the
  field cannot reach, which is every reply sent before it and any model that ignores it.

- **The sentence reading is one axis, not a vocabulary.** A noun modifying the name for text is a
  modifier: `document` and `body` since issue #379, as `page` and `number` always were
  (`no printed page number or heading`). So
  `No text, images, tables, or other document content is visible.` is a declaration, while
  `only document headings are visible` and `the document heading is visible` are contradictions — a
  determiner, an `only` or a verb in front of the noun ends the walk before it reaches the negator.
  The axis is what decides, not the length of the list: the same sentence with `document` deleted was
  already delivered, and with the coordination deleted was not.

- **A comma alone does not end the walk, and a comma with a whole clause behind it does.** A denial
  with no verb of its own reaches across a bare comma, because the members of a denial are divided by
  bare commas exactly as two clauses are — and on the corpus the denials are the case that occurs: of
  the 204 blank declarations in the 3,747 page replies on record, 69 have a denial reaching across a
  comma **and a conjunction** to a name for text and 81 across a **bare comma**, and every one of
  those 150 is a list. Ending the walk at a comma stops honouring 38 of the 204, so a fifth of every
  blank page on record would be reported as a hole (issue #436, which measured it).

  What ends it is the sentence being **two clauses**: a denial with no verb in it, exactly one comma,
  a name for text behind it carrying a finite verb of its own, and no further conjunction or comma
  between them — the coordination stopping is what says the second half is not another member.
  `No printed text, and handwriting is present.` is refused on that, as are
  `No clear text, scrawled words are visible.` (spliced rather than coordinated),
  `No clear text, and printed words are visible.` and
  `No printed text or images, and body text is visible.` — the log said there is writing on the
  sheet. A denial keeps every escape route: three or more members
  (`No printed words, lines, or characters are visible.`), a final `or` joint
  (`No text, images, or other content is visible.`), a joiner behind its last member
  (`No writing, figures or stamps are present.`), a comma on the named noun itself even with no
  joiner anywhere (`No printed words, lines, characters are visible.`), or no verb behind the comma
  at all (`No printed text, and handwriting.`).

- **Two shapes this reads wrongly, stated because nothing in the sentence distinguishes them.** A
  **two-member** denial written `No text, and images are visible.` or
  `No text or images, document headings are visible.` is read as a clause and the blank page is
  reported as a hole; that direction costs a glance, and the other costs a sheet of handwriting
  delivered empty. The second was documented as a declaration until #436 — `document` and `body` are
  modifiers, so the sentence was delivered — and is refused now, because the identical sentence with
  `scrawled` in place of `document` was refused already, and leaving the two apart is the vocabulary
  deciding which pages survive.

  The fatal direction is the price of reading a continuing coordination as a list: a named noun
  heading an **affirmed** list is read as a member of the denied one, so
  `No clear text, stamped words, stamps are visible.` and
  `No printed text, and stamped words, marks are visible.` are delivered empty. The two readings are
  one sentence — `No printed words, and lines, characters are visible.` has that shape and denies
  three things — and none of the 3,747 replies on record writes it. Every wording above is pinned in
  `test/envelope-as-content.test.ts` so the class cannot widen unobserved.

- **The rule this replaced read the FORM of the word, and one sentence was answered by two
  mechanisms.** A comma ended the walk only once it had crossed one of the participles #431 added, so
  `and stamped words` was refused while `and printed words` was declared; that rule also refused pure
  denials whose participle member carried a comma of its own
  (`No inscriptions, watermarks, or logos are visible.`), and removing it honours those again. It had
  refused 24 of 24 such wordings on the modifier's form alone. Replaying every one of the 3,747
  replies through both implementations moves **no verdict** — a verdict replay rather than a count of
  sentence shapes, because a count can only see the shapes its own pattern was written for, and two
  rounds of review found the old rule's failures one shape past whatever had been counted. Over the
  300-row grid #431 was measured on, the new rule refuses all 60 second-clause rows the old one did,
  refuses the 60 spliced ones, leaves every list row blank, and gives back the 30 denials the old rule
  cost.

- **Two things a log may name without contradicting its own declaration.** The first is the page's own
  printed number (issue #222): a folio is not content that page could have delivered, so
  `blank apart from the printed page number` and `blank except for its printed folio` are declarations
  rather than refusals, while `the printed page number and a heading are visible` still refuses —
  through the heading, which is what a reader would have got nothing of. The second is the **name of the
  image file** (issue #429): in `Image filename indicates this is page 14 of 25` the word `image` names
  the file Iris handed the model, not imagery on the paper, and that sentence is where a model told to
  read the folio and unable to goes looking for the page number instead. It needs no determiner —
  `Image filename`, `Filename`, `Image file name` and `The image filename` all declare — and reaches no
  further than the two words: `Image name is printed at the top of the sheet` refuses, so does
  `Image filename indicates page 14, and a heading is visible`, and `The image filename is illegible` is
  still a doubt word.

- **What counts as naming content is a word, not a position (issue #431).**
  `Only handwritten smudges are visible` contradicts a declaration exactly as
  `Only handwriting smudges are visible` does, and `cursive is visible` as `writing is visible` — the
  reader holds the same vocabulary in both parts of speech, so which form of a name the model happened
  to write does not decide whether the page survives. Before that it did: the noun forms were read and
  the participles and adjectives were not, and a log naming writing with one of those was a page
  delivered empty and reported to nobody.

  Two places read the two forms differently, both deliberately. The first is the object of a denial's
  preposition, where a participle with a noun behind it is an adjective on that noun:
  `nowhere except a barcode at the top` refuses, `nothing legible within the stamped border` is a blank
  page describing its own pre-printed form and declares. The second is the walk back from an affirming
  name looking for the negator that denies it — that walk crosses the participles, so
  `No stamped or signed marks are present.` is one denied list rather than an affirmation of marks. What
  stops it crossing a second clause is the two-clause rule above and has nothing to do with the
  participles; for one release it did, and `No clear text, and stamped words are visible` was refused
  while `No clear text, and printed words are visible` shipped the page empty. Everywhere else the two
  forms are one class, and the copula reading and the folio exemption both test that class rather than
  the shorter list of qualifiers they were written against.

- **A hyphenated compound is read as the word it is a compound of, and until issue #437 it was not.**
  The adjective list is matched at word boundaries, so a compound of a word it holds was always read
  (`hand-written`, `rubber-stamped`); the noun and qualifier lists are matched whole, so a compound of a
  word only they held was not. `printed` was only in those two — so
  `The machine-printed notes are visible.` was a page whose log names notes on it, delivered empty,
  while `hand-printed notes` were seen, and `pre-typed` was read where `pre-printed` was not. Across the
  five readings that ask about a modifier, 24 of 40 (bare word, compound) pairs answered differently
  from their own bare stem; all 40 agree now. Twelve of the 24 were the object of a denial's preposition
  and went the silent way: `A caption is missing from the machine-printed heading.` is a heading
  presupposed by the log and a page delivered empty, and it read that way for `typed` as much as for
  `printed`.

  The rule reads a compound of any of the thirteen qualifiers, not only the two overlapping the names
  for text: 13 words × 3 prefixes × the 4 frames the three readings own is 156 cells, the compound
  disagreed with its own bare word in 75 of them before and in none after, and every one of the 75 moved
  to the bare word's answer. Thirty-six moved toward a declaration and 39 toward a refusal, so there is
  no safe side to it. Thirty-three of the 36 are one interaction decided elsewhere: a **definite**
  `image` is the scan rather than a thing on the page, so `The legible image is visible.` declares, and
  `The semi-legible image is visible.` now reaches the same reading instead of stopping short of the
  article. A compound built on a word none of the lists holds still stops it
  (`The foo-bar image is visible.` is refused). The other three are a different mechanism —
  `No content is present in the machine-typed.` and two siblings, which declare because a denial's
  terminal object that is only a modifier is skipped, as the bare `typed` is.

  What that buys is parity with the bare word, not a claim that the bare word's answer is right: whether
  `The pre-printed notes are visible.` should be refused or `The pre-printed form is empty.` kept is
  still decided by the noun behind the modifier. A compound whose prefix negates is read as the word it
  negates (`un-printed`, `un-written`), which is what boundary-matching costs and errs toward reporting a
  page rather than losing one. Nothing on the corpus turns on it either way: of 3,747 page replies with
  a log, 4 write a hyphenated compound of `printed` or `typed` anywhere, and all 4 are pages whose HTML
  carries content, so none reaches the blank reading. Replayed, 0 of 3,747 verdicts move — an empty
  denominator rather than a measured zero. The evidence is the 40 pairs; the corpus only says it breaks
  nothing on record.

- **A copula has two ways of denying its subject, and until #442 the reader knew one of them.**
  `Handwriting is absent.` says the handwriting is not there and declares. `The heading is empty.` says
  the heading holds nothing, which is the same news about text — but nothing denied `heading`, so the
  sentence read as an affirmation and the blank page was reported as a hole, with the word that denied it
  quoted inside the evidence (`affirmed: "heading is empty"`). Six wordings do this: `is empty`,
  `is blank`, `is unmarked`, `is unfilled`, `is featureless` and `is void of content`. All six are read
  now, and the grid says the fix is about the complement and not the subject — 6 complements × 4 subjects
  that name text moved from 0 of 24 declared to 24 of 24, while the same complements against 4 subjects
  naming none were 24 of 24 before and are unchanged (`The sheet is empty.` always declared).

  `void` is taken only with its preposition: a stamp that "is void" is a mark **on** the paper — the word
  is printed across a cancelled form — so bare `void` is the one member of that vocabulary whose plain
  reading says something is there, and reading it would lose the page in silence. `is illegible` is out
  for a related reason rather than by omission: marks that cannot be read are not an absence of marks, so
  an illegible heading is still a heading and the page is reported.

  Two page-**losing** defects came off the same fix. `The heading is not empty.` declared the page blank
  before it, because the `not` denied a clause and nothing read what it denied — a double negative
  arriving as an absence, on all 24 grid rows, each a page lost without a line. And the scan anchored on
  a denial now counts these complements as denials, which is what `Blank apart from a caption.` needed:
  that fragment had no negator in it and shipped empty, a caption lost. Six exceptive wordings come back
  with it, and which nouns survive an exceptive is decided where it already was rather than again here —
  each of the eight rows checked answers exactly as the negator wording saying the same thing answers, so
  `Blank apart from a watermark.` reports (a watermark is a name for marks) and `Blank apart from dust.`
  declares.

  The **contracted** spelling was the losing side of the same sentence. A contraction is in none of the
  verb lists on purpose — `The heading isn't visible.` denies its subject — so
  `The heading isn't empty.` found no verb at all and went out as a blank page while `is not empty` was
  reported: the apostrophe decided whether the page was lost. It is read at the one construction where
  the contraction's own negation is cancelled by the complement behind it, and the contraction is
  **walked to** rather than read at the next word, because the subject of one of these is a noun phrase
  (`The printed form isn't empty.` puts it two words along).

  The complement is read at the word **right after the verb**, and after a **linking** verb only. The
  first part is what the wordings a real form log writes need — `is empty; no handwritten entries.` past
  the statement boundary and `is empty and unused.` past the coordination both declare — and is also the
  whole of the limit: anything between the verb and the word puts it out of reach, so
  `The heading is completely empty.` is still reported, as is `is unused and empty.` where the
  coordination runs the other way. That is the same failure as before the fix and in the cheap direction —
  attention spent on an empty page, not a page lost — and closing it means walking those positions in the
  verb read, not adding to this vocabulary. The second part is why `The heading contains empty rows.` is
  not a denial: half the affirming verbs take an object rather than a complement, and `empty`, `blank`
  and `unmarked` are the ordinary adjectives for a cell, a field or a row. `absent` and `missing` need no
  such gate, neither being attributive — nothing contains missing rows.

  The denial-anchored scan tries **every** denial position rather than the first. A negator stands where
  its denial begins, so first-hit was the right anchor while the vocabulary was negators alone; a
  complement stands *behind* the negator of its own sentence, and the backward walk that finds an
  exceptive object stops at a negator. So anchoring on `empty` in
  `The page is empty, nothing on it except handwriting.` put the stopped position between the anchor and
  the object, and eight wordings of that shape — the shape a real form log writes — shipped a page with
  content on it as blank. Trying each position in order can only add an affirmation, the first-hit
  position still being among them.

  One family of wordings **loses** a page to this, and it is the comma bound rather than the complement:
  `The heading is empty, handwriting only.` and seven siblings go out blank where they were reported
  before. A fragment cut off at its own comma is read as a member of the list a blank page writes, and
  that list is a list of what is *absent*, so a denial standing behind the noun reaches nothing — the
  defect `A signature, nothing else.` is pinned against. These eight only join it because `is empty` is
  now a denial, which is the pairing rule holding rather than breaking:
  `The heading is absent, handwriting only.` lost the same page before the fix and still does, so the two
  wordings say the same thing and answer the same way, and the repair belongs at the comma. Base reported
  them by affirming `heading` off the very complement that denied it.

  No log on record moves. Of 3,747 page replies with a log, 153 write one of these complements and 135 of
  those sit inside a blank declaration, 0 in the negated form and 0 in the contracted one, and 0 verdicts
  move — because the subject a real log uses is the page and not its heading. The all-positions scan has
  a real population rather than an empty denominator, 1,583 of the 3,747 logs carrying more than one
  negator, and none of those moves either. So the corpus cannot separate reading the vocabulary at the
  verb alone from also reading it at the denial scan, and the wider read rests on the constructed rows.

- **Either form of the name also reaches a clause with no verb in it, which it did not until #435.**
  `handwriting smudges only.`, `handwriting visible.`, `Only handwriting smudges.` and `A heading.` each
  declared the page blank, because the affirmation is found by handing a name for text the verb that
  predicates over it, and a fragment has none to hand it. A fragment is now read on its own — a predicate
  after the noun (`visible`, `present`, `apparent`, `discernible`, the four words the denial read already
  uses for the same dropped copula) or the end of the statement, optionally past a closer (`only`,
  `alone`, `too`, `also`, read at the end of the statement and nowhere else, so the `only` in
  `handwriting only in the margin.` is not mistaken for one).

  The risk runs the other way from everything above, because a blank page's own log is written in
  fragments as often as not — 94 of the 204 blank declarations on record have a verbless statement in
  them, and every one of those is a denial. So the noun phrase must **open** its statement, with nothing
  in front of it but a determiner, a count, a qualifier, an opener (`only`, `just`, `merely`, `simply`,
  `solely` — `Only handwriting smudges.` is #435's own title), or another name for text or marks. That is
  what keeps `Devoid of text.`, `Lacking text.` and `Free of text.` blank: none of those words is in the
  negator lists, and each is a page that would otherwise be reported lost. A comma is a boundary on both
  sides of the noun, for a reason the corpus supplies rather than a hypothetical one: the doubt-word
  scope has the marks and the `not legible text` phrase stripped out of it, so
  `A few specks, not legible text, figures, captions visible.` arrives at this read as
  `A few figures, captions visible` with the words that denied those nouns already gone. What the commas
  cost is a fragment whose denial stands **behind** its noun: `A signature, nothing else.` is a page with
  a signature on it, delivered empty. The read that would catch it is the denial-anchored one, and that
  only looks forward from the negator. Unchanged by #435 and stated rather than left to be re-measured.

- **A statement that is a name for text and nothing else no longer affirms (issue #440).** So
  `Blank page; text`, `Blank page. Content`, `Page is blank; images; nothing present.`,
  `Page is blank. No printed text. Images.` and `Page is blank. Images. No text.` declare the page blank
  instead of reporting it as a hole. Statements end at a `.`, `!`, `?`, `;` or a line break alike, and in
  three of those the denial is in a neighbouring statement — ahead of the label in one, behind it in
  another — which this read cannot reach either way, the boundaries being what limit how far a subject
  may look for its verb.

  Counting the tokens is not what does it, and the reason is the shape of the rest of this section. The
  doubt-word scope has the marks phrase stripped out of it, so **one token is not one word**:
  `Handwriting smudges.` and `Cursive smudges.` reach this read as a single token, their head noun having
  been removed upstream, and that phrase is the one #435 is about — six of its seven wordings are it with
  a predicate on the end. A plain one-token guard was written for #440 and taken back out for exactly
  that, because it delivered a page of handwriting empty. What ships instead is the strip leaving a
  **mark where it cut**, so a statement can say it lost a word: the mark is a form feed, whitespace to
  every other pattern here and invisible to the tokenizer, and a log cannot forge one because the scope's
  input has form feeds and vertical tabs removed before any is inserted. A statement of one token that
  was cut declares nothing; a statement of one token that was always one word affirms nothing.

  One token is not the **whole statement** either. The tokenizer reads letters, so a digit and a list
  bullet are invisible to it and `2 images.` and a `- text` line are one token each — a page that says
  what is on it, which counting tokens alone would deliver empty. The statement therefore has to BE the
  token: nothing in it but the name, whitespace and the cut mark. `2 images.`, `1 signature.` and a
  bulleted list of a page's contents all keep their affirmations, and `Two images.` was never at risk
  because it is two tokens. That makes the guard sensitive to **any** non-letter decoration, so
  `Page is blank. **handwriting**`, `handwriting:`, `(handwriting)` and `"handwriting"` all report where
  a bare `handwriting.` declares. The asymmetry is deliberate and the corpus settles it: of 3,402
  one-token statements only 1,073 are bare, 2,329 carry decoration, and all four that name text are
  decorated ones. A guard reading through decoration would move four real statements toward being shipped
  empty and none toward declaring, which is the losing direction.

  A **boundary is not always a sentence end**, and that is the third face of the same mistake. A numbered
  list marker ends in a `.`, so `1.` is a boundary and every line of
  `Page is blank.\n1. text\n2. images` arrives as a bare one-token statement — the whole enumeration of
  what is on the page eaten and the page shipped empty, where the `-` spelling is rescued. The guard's
  premise is that a name alone *between two boundaries* is all there is to read, and that holds only
  where the boundary behind it ended a sentence: a preceding statement with **no letter in it** is a
  marker, so the name is a list item and affirms. The corpus says which spellings exist rather than a
  marker vocabulary guessing — 73 of 3,747 replies write a `1.` list line, 2 write a `-` one, and `1)`,
  `a.`, `a)` and roman numerals appear in none. That test reaches a little wider than "a marker" on
  purpose: a statement the marks strip reduced to its cut mark has no letter in it either, so
  `Page is blank. Print artifacts. text` hands `text` back, which is what the pipeline did before any of
  this. And a marker is not what makes a list — **the sequence is**. A model that lists a page's contents
  one per line with no marker at all has a sentence behind every line, so the rule above helps none of
  them: `Page is blank.\ntext\nimages` had the whole enumeration eaten. A run of lone names is a list and
  one lone name is a lone name, so the neighbour on either side decides, and the lettered spellings `i.`
  and `A.` fall out of the same clause, a marker that is itself a letter being a lone name too. Of the
  1,073 bare one-token statements on record, 147 are in an enumeration by this rule — 2 by the letterless
  neighbour and 145 by the sequence — and none of the 147 names text.

  **The guard's cost is a shape and not a wording:** any bare one-token statement whose neighbours are
  sentences, of which `Page is blank. handwriting.` is one spelling and a **one-item list**
  (`Page is blank.\ntext`) is the other. Nothing this read can see separates that from `Blank page; text`,
  which is the thing #440 asked to have declared, so both declare and the page ships empty. Both sides
  are unobserved: one-token statements are common on the corpus (1,129 of 3,747 replies write one) but
  only four name text, all in replies that make no blank claim, so 0 of the 204 declarations on record
  move. The near misses say how narrow the guard is — `Any text? None found.` is two tokens and reports,
  and `Text: none.`, `Text (none).`, `Text/handwriting: none detected.` and
  `Page is blank; no text; no images.` declared before it and still do. Every one is pinned in
  `envelope-as-content.test.ts`.

- **The marks strip decides one more case, and there the head noun is what the reading turns on (issue
  #439).** A log calling the scan's own noise `print artifacts` had the mark removed and the word
  dressing it left standing where a subject goes, with the mark's verb behind it —
  `Page is blank. Print artifacts are visible.` was reported as a lost page, quoting the two words
  `print are visible`. A name for text now leaves **with** the mark where the mark is one only the
  capture leaves (`artifact`, `debris`, `dust`), so those pages declare. It is the head and not the
  dressing word that decides, because the same dressing word means the opposite in front of a mark a pen
  also leaves: `Only print smudges are visible.` is smudged printing and goes on being reported, as
  `handwriting smudges` does. `Printed dots are visible.` is reported too — `dot` is outside the list, a
  page can have real printed dots, and `the table contains the printed dot leaders` is a corpus statement
  about typographic content. Of the 81 places the corpus writes a name for text in front of a mark, 74
  have an `artifact(s)` head and 7 a `dot(s)` one; 0 of the 204 declarations change verdict, and the two
  whole sentences that change reading are one of each kind — a blank page now read as one, and a page
  whose log describes repairing a character, which a declaration around it would now be believed about.

  What leaves is **that one word and nothing else**, and the doubt words in front of it stay. Seven of
  the adjectives this strip can absorb are themselves doubt words, so
  `Page is blank. Blurry print artifacts are visible.` has to go on being refused on `blurry` — a page
  whose log says the scan is blurry wants a better scan, and shipping it empty is the same loss from the
  other side. Transplanted across the corpus's 17 wordings in three frames, all 18 cells this widening
  moves were refused by a contradiction and none by a doubt word; put `blurry`, `faint` or `grainy` in
  front and all 51 cells stay refused.

- **The test is positive and doubt is fatal.** An absent `html` key, an empty one with nothing said
  about it, one whose `log` says the page could not be *read* (illegible, too dark to resolve,
  truncated — including a hedge like "appears blank, though the scan is very faint"), and one
  describing the **image's** condition rather than the paper's ("the page is very dark and appears
  empty", "low resolution scan; no text") are all the model giving up, and stay `page_no_output`.
  That reply is the one that most needs a human to look at the page, and reading it as a declaration
  would leave nothing in the document to look at. A blank page whose wording falls outside both
  patterns is reported as a failed page, which is the safe direction: a page wrongly reported failed
  costs a glance, a page wrongly dropped costs the page.

- **Marks on an empty sheet are not doubt, and the exemption is a phrase rather than a word.**
  "Specks/dots are visible but do not resolve into any characters", "a few faint specks/artifacts …
  no legible text" is the blank declaration itself, stated positively; reading `resolve`, `faint` and
  `noise` there as doubt about the scan cost four blank pages of 100 on one bench round, while an
  agent that answered "Page is blank." and stopped was believed (issue #190 — two pages of one
  document opened with a verbatim identical sentence and only the one that explained itself was
  refused). So `faint specks` is the paper and `faint scan` is the image, and a log describing both in
  one sentence still refuses: "the scan is blurry, showing only faint specks and no legible text"
  loses `faint` and keeps `blurry`. The marks have to be named *as* marks —
  `stray marks do not resolve into characters` is the paper, bare
  `marks do not resolve into characters` is the phrase the page prompt uses for content that could
  not be read, and a `dark streak`, `dark spot` or `dark shadow` is the capture and can cover
  content. It reaches across one sentence or semicolon boundary only where the next clause continues
  the same observation — the marks referred back to, no subject at all, or a denial — so "a few specks
  of dust are visible. The handwritten note in the corner does not resolve into words" is still a
  failed page.

- **Two edges of that phrase, because a wording just outside either one costs a blank page (issue
  #429).** `noise` belongs to the paper only where the capture that made it is named: `scan`,
  `scanner`, `scanning` and `compression noise`, which is the corpus's entire vocabulary for it —
  four wordings across the 205 replies on disk that carried no page — while bare `noise`,
  `image noise` and `the scan is noisy` describe the image and stay doubt. And one word Iris has no
  list for may sit **immediately** before the marks noun, so "only faint, indistinct specks are
  visible" declares. It is one word, in that one position, in a clause with no copula, colon or dash
  in front of it: "the scan is noisy with artifacts" and "the image is grainy background specks" are
  still failed pages, because a stack behind `is` describes something the sentence has already named
  and the marks are not it. That slot moves no reply on disk — it is there because the words it admits
  appear in none of the 3,935 replies that *did* carry a page, so admitting one cannot let content
  through as a blank declaration.

  The word is put **back** into the text the doubt and contradiction checks read, rather than removed
  with the phrase, so a doubt word or a name for what the page bears goes on being one without this
  rule holding a list of them. Three words are not put back. Two fall back to the reading that has no
  slot in it: a function word, which dresses nothing (handing `with` back keeps the preposition while
  `noisy`, the whole doubt, leaves with the phrase); and a name for what a page bears written as an
  **attributive** — `handwritten`, `stamped`, `cursive`, and their hyphenated compounds — which is
  the form this rule reads as a modifier. Until #431 that was also the form the contradiction check
  could not see, so the word was handed back and nothing downstream did anything with it; the check
  now reads both parts of speech, and handing it back is what lets it. The third is a word the
  slot-less reading had already removed, and there the phrase goes in full, slot included: nothing is
  handed back because base kept nothing to hand back, which is what makes this rule able only ever to
  strip **more** than the slot-less reading and never less.

- **A place on the paper names content; the substrate is another way of saying the sheet is empty.**
  "not legible printing in the margin" names what the page bears, while "not legible text on the
  page" says the sheet is empty. The whole rest of the statement has to be denial for it to count as
  one, so a word for a place on the paper — `margin`, `header`, `corner`, `seal`, `spine` — refuses
  whatever punctuation or preposition leads into it; a name for what the page bears has to be
  introduced by a denial (`or content`, `nor any figures`, `no writing`) rather than by a determiner,
  and not handed on to a verb that says it is there, because "not legible text, only a heading is
  visible" and "not legible text, and printing on the page is visible" are built from the same words
  as a denial and say the opposite — while a tail that goes on to deny something else carries verbs of
  its own ("not legible text or content, and no writing is visible") and is read as the denial it is.
  The same read applies to "do not resolve into …", one noun further on: that construction's object is
  what the `do not` denies and everything after it has to deny too, so "do not resolve into any
  characters or content" is a blank page and "do not resolve into any characters, only a heading in
  the margin" is a failed one. No exemption applies at all to a log that anywhere says the reading
  failed or hedges the answer (`illegible`, `obscured`, `too dark`, `could not`, `though`), which are
  claims about the page wherever they sit.

- **The claim is not paid to be checked, and it used to be.** The empty fragment went to the Feedback
  Agent like any other page, shown the source image and an empty code block and asked whether the one
  was faithful to the other. In 36 such judgements — 9 pages of a 100-page corpus, two page-model
  arms, two shas — it passed every one, for $0.0859 an arm (issue #294). So the call is not made and
  `page_verify_ok` says so with `skipped: "blank"` and `unjudged`.

  The single exception is the only spend issue #371 adds: a declaration **stated** in the field whose
  own log names something on the page is delivered *and* judged, with the log's claim quoted to the
  verifier in its own words beside the empty fragment. A log that was right about the heading it named
  buys a correction and the reader gets the page; a log the regex misread costs a verify call instead
  of a page. Before the field there were two answers and both were worse: believe the prose and drop
  the page in silence, or refuse it and report a page nobody has. The cost is bounded by how rarely
  the two halves disagree — 1 of the 125 blank declarations in every bench round on disk, off 2,189
  page renders — and that one is a page whose log says it is blank three times, refused today by a
  misread first clause. A declaration made in prose alone is unchanged and still refused on a
  contradiction, because for a prose declaration refusing remains the cheaper of the two errors
  available.

  What still checks the claim are the checks that cost nothing, and they are the ones that can prove
  it wrong: the veto refuses a hedged declaration before it is ever accepted, whether the reply stated
  blankness or described it — a page the model says it could not read is not a page it can state
  anything about, including that it is empty — the contradiction refuses a self-contradicting one
  described in prose, and a page reported blank whose **source file** carries link annotations for it
  is one the document itself contradicts, so `page_links_missing` fires on it as on any other page,
  buys a re-render against the image, and that fragment is verified in turn.

- **What is no longer caught is a *confident* wrong declaration about a page whose file says
  nothing.** It is delivered as an empty page, and the `page_blank` line is the whole of the evidence
  it leaves — so a run triaged off those lines is not evidence that no such page occurred. Before any
  of this existed, six of 100 bench pages across three of four documents were well-formed envelopes
  correctly saying the page was blank, and every one shipped a `@page-failed` marker and counted as a
  lost source page (issue #179).

- **No page-break marker is delivered for a blank page, and a blank page that printed its folio loses
  an anchor.** The prompt no longer asks for a marker on such a page whatever the paper prints — it
  did, which was an instruction the pipeline could not honour once every accepted declaration returned
  an empty fragment (issue #222) — so a marker that arrives anyway goes to `dropped` with the rest of
  the fragment. Losing the anchor is the cheaper mistake, and a page whose only printed content **is**
  its folio is a blank page by decision rather than by accident: the folio is never transcribed as
  text and the marker it may be carried in is never delivered, so such a sheet has nothing on it a
  reader receives, and a marker-only fragment is not a page. The alternative — delivering a lone
  `doc-pagebreak` where no declaration was asserted — was refused because that gate also passes a
  reply whose log says the page's table was too faint to transcribe, which is a page silently dropped
  while the run reports it delivered, and because every one of the 18 bare markers measured in the
  corpus carried a label the paper never printed.

- **The blank count is the declarations that were made, not the pages that ended up empty.** Since
  #371 a page delivered empty can have content put back by the correction its judgement earns, and it
  still counts here; the count is kept that way deliberately, because
  [Diagnostics](API.md#diagnostics-timing--hang-detection) reads the declarations that cost a verify
  call off it as `pages_blank - pages_skipped_blank`. A page whose content came back that way is the
  `page_corrected` line beside it, with `trigger: "verify"`.

## The review loop

- **The Reader replies with JSON and nothing else, and that sentence is tuned to the model in the
  seat.** `READER_SYSTEM` has always ended "Respond with ONLY JSON:", and the incumbent narrated
  anyway: 40% of the characters it wrote sat outside the JSON envelope, over 5 documents.

  Nothing could see it, which is why it lasted. `extractJson` takes the *last* envelope in a reply,
  so a preamble parses and no call fails, and no log line says that a third of the step's output was
  prose billed at output rates.

  One appended sentence removes all of it: **output tokens −29%** (3,635 → 2,574 per document),
  **$/doc −13%**, prose 40% → 0% of characters. In the unit the re-measure list below asks for, that
  is **91% → 0% of replies** — 10 of 11 narrating in the control, 0 of 11 in the treated arm, over
  the same five documents. Both units are given because a swap is told to record the second one.

  **The incumbent's half of this reproduces at eight times the size**, measured at the shipped prompt
  against the old one over 20 documents and two runs per side: output **2,698 → 1,778** tokens per
  document (**−34%**), **$/doc −13.2%** ($0.1072 → $0.0931), and prose **0.0% over 90 replies**. That
  last figure is not one character outside the envelope, by Iris's own `extractJson`, with
  `` ```json `` fences excluded.

  The margin is what makes it a result rather than a draw: the incumbent's two runs at the shipped
  prompt price within **1.5%** of each other, so −13% is many times its round-to-round spread. Issues
  per document did not move (**9.93 → 10.28**, and the old prompt's three rounds — 9.35, 9.70, 10.75
  — bracket both new ones) (#307).

  It also finds **more** rather than less — 12.6 issues per document against 10.8, 129 quoted spans
  against 96, and a finding's cited page matching the page order 93% of the time against 84%
  (citations matching neither the order nor a printed folio: 15% → 2%).

  One metric moved the other way and belongs in any re-measurement of this: **quote fidelity 90%
  against 93%**, the share of quoted spans findable in the document, with off-document references at
  0 in both arms. The comparison needs its floor stated or it reads backwards. Two runs of the
  *identical* prompt over the identical documents reproduce only **57%** of each other's
  quote-anchored findings, so the terse arm reproducing the control at 61% is not damage — the Reader
  does not reproduce itself to begin with (#299).

  **The saving is a property of the model in the seat, not of the prompt**, and that is the part to
  carry forward. But the figure this bullet gave for the other seat was measured at five documents
  and does not survive forty, in either direction. It said the sentence takes `kimi-k2.5` from **13.6
  issues per document to 8.8** at **6% more** per document: fewer findings for more money.

  Over 20 documents and two runs per side it is **11.75 → 12.80** issues per document at **−5.0%**
  $/doc, both signs reversed. Neither reading is the one to carry forward, because both changes are
  smaller than Kimi's own spread between two runs of the *identical* prompt: its issues per document
  are 13.8 and 9.7 at the old prompt, 13.45 and 12.15 at the shipped one, and those two shipped runs
  price 8% apart. **The measured answer on Kimi is that neither its finding count nor its price moved
  resolvably** — the trade the old figures described, and the better trade their reversal describes,
  are both inside the noise (#307).

  **The reason first given for the "property of the seat" claim was wrong too, and correcting it
  changes which number a swap should record.** This bullet said Kimi's control "already writes 0% prose",
  from a 5-document draw. Re-asked at 20 and 50 documents over the same persisted replies, Kimi's
  character share is **38.8%, 30.0% and 9.6%** across three rounds — never 0%, and in one round
  higher than the incumbent's 36.1% over the same documents, so the claim inverted rather than merely
  wobbled (#305).

  And in the deciding round Kimi's *treated* arm wrote **more** prose than its control, not less:
  **1 of 11 replies narrating in the treated arm, 0 of 11 in the control**, and that one reply
  carried 51% of the treated arm's characters. The sentence did not suppress prose on that model; the
  number simply moved with one reply.

  At forty documents the same holds with the sentence *shipped*: Kimi's prose is **23.8% of
  characters in one run of 45 replies** — two replies, one of them 98% — and **0.0%** in the other.
  Where the incumbent goes to 0.0% over 90 replies and stays there, Kimi's share is decided by
  whether the run caught one of its rare narrating replies, prohibition or not.

  The 40% for the incumbent replicates: **33.0%–40.4%** over **202 replies** written, four rounds and
  two ways of cutting the same corpus. 201 of them are classified, since one parses only through
  Iris's repair path, so its envelope's span cannot be pinned and it is excluded from the shares
  rather than estimated. A 5-document draw of that reads 0% in 0.0% of resamples.

  **The difference is the shape, not the sample size.** The incumbent narrates a little in most
  replies — **67%–75% of them** across the four twenty- and fifty-document rounds — so five documents
  see it. The ablation's own five-document control reads **91%**, which is not a fifth value so much
  as a demonstration of the band below: 91% is the top edge of what a five-document draw of these
  rounds produces (p95 86%–100%).

  Kimi's median reply is a bare envelope, and it narrates in **7%–16%** of replies across its three
  large rounds, going to 87%–99% prose when it does. So any aggregate is decided by whether the draw
  caught one: five Kimi documents read exactly 0% in up to 46% of resamples and anywhere from 0% to
  87% overall. Its median reply being prose-free is what makes the sentence buy it little, and that
  part holds in all three rounds.

  Since the Reader's model is a config key and not a code change (`providers.per_agent.reader`, plus
  block-wide `providers.bedrock.api: converse` for a non-Claude id — [docs/models.md § How a swap
  fails quietly](models.md#how-a-swap-fails-quietly)), **swapping
  it means re-measuring this**, and prose share is not a model trait to look up in either form.

  **What to re-measure**, then: the **share of replies containing any prose**, not the share of
  characters. The reply share separates these two models in every round measured — the incumbent
  67%–75% over the four large rounds and 91% in the ablation's control, Kimi 7%–16% over the three
  large rounds and 0% (control) to 9% (treated) in the ablation — where their character shares
  overlap, and it is the population the sentence acts on.

  **It is not the cheaper measurement, and the reason is worth stating precisely, because the two
  statistics fail at n=5 differently.** Resampled at five documents the reply share's band is *wider*
  in points than the character share's on the incumbent (35–50 against 21–24) and *narrower* on Kimi
  (20–30 against 26–66), so "tighter" is not a property either one has.

  What both have is the same failure on the model in question: the reply share still reads 0% for
  Kimi in **12%–48%** of draws, against the character share's 40%–46%. Five documents are adequate
  for the incumbent on either statistic and inadequate for Kimi on either, so the reply share buys a
  figure that holds from round to round and buys **nothing** at n=5 — measure two runs of twenty
  documents regardless of which unit you record.

  Then output tokens per document, issues per document, quote fidelity, and the same prompt run twice
  so the reproduction figures have a floor. Violations per multi-window document (#301) and
  self-cancelling issues per document (#307) are part of the same swap and want the same two runs, so
  measure them here rather than separately — the second one because it is a per-model charge on the
  Copy Editor, not a property of this prompt.

  All of it is free once a round exists. Every Reader round persists its raw replies, and
  `node proseshare.mjs <round>` in `equalify-iris-bench` locates the envelope with Iris's own
  `extractJson` rather than a regex.

  The figures here are its four rounds `runs-reader-selfagree`, `runs-reader-probe`,
  `runs-reader-third` and `runs-reader-persource`, at Iris `158e3d9`, and the n=40 figures are
  `runs-reader-newsha` and `runs-reader-newsha2` at `e842faa`. The two arms of the trade — control
  and treated, each labelled, in both units — are the five documents of `runs-reader-ablate2`, which
  is the round the sentence was decided on and the only one holding a treated arm.

  A `` ```json `` fence is counted apart from narration: on a 670-character reply 12 characters of
  fence read as 1.8% and cross a 10% threshold, which is enough to rank the tersest model in the
  field as one that narrates.

  The prompt side of the trade is one 180-character sentence. It rides inside the cached prefix on a
  Claude Reader and is paid in full on every chunk of every round on one that gets no breakpoint —
  the same population where it may buy nothing. (The filing measured that as +86 prompt tokens
  **per document**, 29,747 → 29,833, which is the sentence sent once per window rather than once per
  document.)

  The effect of any change here is visible without new instrumentation:
  `by_step.review.output_tokens` in the run's diagnostics is the number that moved.
- **Copy Editor image payload.** When every issue in a round is attributed to a page, the editor gets
  only those pages' images (logged per round as `editor_images`). Attaching every page's image on
  every round is the dominant per-round cost of the review loop — on a 25-page document that is 25
  base64 PNGs × up to `max_review_iterations`.

  Narrowing requires *full* attribution: one unattributed issue re-broadens the round to every image.
  An unattributed issue is usually structural and fixable from the HTML alone, but it is also what a
  heavily editor-rewritten body looks like once it no longer matches the source excerpts. So
  narrowing wrongly can leave a real issue unfixed at the iteration cap, while broadening wrongly
  costs no more than the behavior this optimization replaced.
- **A correction round may not replace the document with a fraction of it, and the floor reads
  prose.** A reply that answered about one section, or summarised, or quoted the contract back after
  answering arrives shaped like a corrected document, and the blast radius is the deliverable rather
  than one page (issue #174). It applies to all three shapes a round can take: the joined result of a
  patch (a reply that empties most of the document's blocks), the whole body a model hands back under
  the old contract, and each section on the truncation fallback.

  A round that comes back with under half the prose of the body it was given is now refused, the body
  that entered is kept, and the loop is free to spend another round asking again (`editor_shrank`;
  the same floor per section, as `editor_section_failed` `reason: "shrank"`).

  Which of the three readings on the `editor` line carries the floor was the open question, and the
  measurement answered it. Across the four legitimate rounds that record all three, the prose sizes
  land at 0.997–1.006 of the input while the other two move hard on rounds that were working.

  Unwrapping a mis-structured document keeps every word and loses half the *bytes*, which is one of
  the corrections this loop exists for. And one of those rounds rewrote a 55-item `<dl>` into list
  items — `terms` 55 → 3, a ratio of 0.055 — while its prose moved 0.3%. So no threshold on a
  *structure* count both permits that and refuses a reply carrying a fifth of the document.

  A half rather than the page path's quarter, because the populations are further apart here (one
  section of these bodies is 0.016–0.379 of it) and the costs are asymmetric: refusing a good round
  costs that round's corrections and says so in `@unresolved`, while accepting a fragment costs the
  document.

  The one legitimate round that can approach a half is the deletion the editor's own prompt sanctions
  — the same content rendered as both a form and a table, where dropping the table drops the copy
  carrying more prose. On a body that is mostly such a pair the round is refused and its other fixes
  go with it; that cost is taken knowingly and is on the log with both sizes.

  Bodies with under 1,000 characters of prose are not judged at all — the legitimate deletions are
  otherwise fixed-size, so on a short body a single resolved `[page not fully transcribed]` marker is
  half the prose.

  The initial page render is the third path that adopts `html` wholesale and is deliberately still
  unguarded: it has no before-page to compare against, so a floor there is an absolute plausibility
  check on what a page image that carried text may produce, which is #116's question and not this
  one's.
- **The Copy Editor answers with the blocks it changed, not the document retyped (issue #250).**
  Asked for the complete corrected body, the length of the editor's answer was a property of the
  DOCUMENT rather than of how much was wrong with it: a mean reply of ~26,600 encoded tokens across
  34 delivered documents, with 15 of the 34 unable to fit under the ceiling at all. That is the
  mechanical cause of a 58% `editor_truncated` rate, and a cause no choice of model can move, since a
  model cannot emit a reply longer than its output ceiling. The blocks a round actually touches come
  to ~1,211 tokens.

  So the body is shown to the editor with a `<!-- @block N -->` comment above each of its top-level
  elements, and the reply is `{ "edits": [ { "block": 7, "html": "..." } ] }` — every block nobody
  names is delivered byte for byte. `html: ""` deletes a block, which is how content the document
  prints twice goes. One edit may carry several top-level nodes, which is how a fix splits a block.

  The anchor is a block POSITION rather than an id because ids do not reach the work. Of the 13
  defect instances the structural checks of `src/pipeline/markup.ts` find in those documents, *none*
  sits on an element with a usable id and none has an ancestor carrying one, since Iris puts ids on
  what gets linked *to*. (Those figures were corrected in issue #268; the count this used to quote
  called a `lang` on a void element a defect whatever text it carried in an attribute, and 54 of its
  73 instances were correct authoring. The correction runs the same way: an id anchor reached one
  defect in six, and reaches none of the 13 that survive the recount.)

  And the number is written above the block rather than counted by the editor. A model counting for
  itself could be off by one, land in range, and have every replacement applied to the wrong block
  with each one well-formed — the one failure here that nothing downstream could see.

  A replacement that leaves an element open is refused and that block keeps its original text, since
  splicing a fragment in would close its tags with whatever followed. So is one carrying an end tag
  that closes nothing, which a parser ignores and which would put an unbalanced tag into the
  delivered bytes. An unknown or repeated block number, an unreadable entry and an echoed marker are
  each counted on `editor_patch`, so a reply that did not follow the contract says so in the log
  rather than in the document.

  Two cases are NOT applied in part, and `discarded` on that line says which: a reply where nothing
  could be used, and a reply holding a refusal alongside a block that gave content up. A move is a
  pair of edits here, so taking the source half and refusing the landing half deletes a paragraph
  that no later pass can miss. Both forms of that source half count, since the prompt offers both:
  emptied (`deleted`), or returned with what is left of it (`shrunk`), and the shrinking one is the
  commoner.

  A shrink is read as the prose, so that unwrapping a mis-structured block is not taken for content
  leaving, plus the `<img>` and `<a>` counts. A block that hands back its caption and drops the image
  gave up something no comparison of words can see. For the same reason a heading that stops being a
  heading with every word left in place counts too, which takes a reader's only means of finding that
  content while every size on the line says the round was clean. Headings are folded across `h1`-`h6`,
  so re-levelling one does not move the count. Each of those is an ordinary correction alone, so the
  rule only fires on a reply that already has a defect in it.

  What the DOCUMENT lost is a separate reading at a separate grain (`navigation_lost` on the same
  line): headings, list items and table rows counted on the body the blocks assemble into, so that a
  sanctioned reorder — a heading moved from one block to another — is silent where the per-block
  reading has to speak. The list items and table rows there are a measurement and do not gate at all,
  because content leaving one of those can land in another structure a reader can still navigate.
  Both hand the body back and let the loop retry.

  A model that answers with a whole `html` body anyway is still read, and logged as
  `editor_whole_body`: refusing it would spend the round, and the #174 floor guards that path as it
  always did. What it does cost is measured on the same line. The document that model was shown
  carries the markers, so a reply that retypes it brings them back; they are stripped and counted,
  because delivering them would put Iris's request scaffolding in the HTML and would compound, a
  comment being a top-level node that becomes a block of its own next round.

  The section fallback stays for the case the contract does not fix — one top-level node bigger than
  the ceiling. Its prompt now says outright that a section request carries no numbered blocks, because
  it is built on the same system prompt, and a prompt that is true about one request and silent about
  the other reads as true about both.
- **The flattened screen-reader view must never lose text.** `flatten.ts` has two consumers, and both
  fail *silently* when text goes missing. The Reader reviews this view instead of the source images,
  so anything absent from it cannot be reported as an issue; and `contentCoverage` measures a
  candidate agent against an accepted fixture using these words, so text the view can't see is absent
  from both sides of the comparison.

  The second is the sharp edge. The regression gate exists to stop an agent update from dropping
  content, and it scored a table whose every row had been deleted as *perfect*, because the old
  implementation emitted a table's `<caption>` and returned. Inline elements (`a`, `img`, `em`, …) are
  now announced within the surrounding phrase and block elements are separate stops, with tables
  expanded row by row; `test/flatten.test.ts` asserts the invariant mechanically by deriving the
  expected word set from the DOM independently of `flatten`.

  Both halves of that inline/block split recurse, so the same pathological nesting the assembler
  delivers rather than drops would overflow the stack here and throw — losing *all* the text, the
  worst form of the failure. The walk therefore falls back to an iterative pass that keeps words and
  reading order and gives up structure, which is the trade the view already makes for a block inside
  a table cell. Role markers are stripped before the coverage comparison anyway, so a marker-free
  view scores identically while a dropped word still registers.

  Two rules follow from `contentCoverage` stripping `[...]` before it compares words, and both are
  easy to break by accident. **Everything `flatten` adds itself must be inside brackets** — including
  annotations that read like prose (`[3 rows, 2 columns]`, `[empty]`, `[spans 3 columns]`,
  `[alt missing]`) and a control's `type`, which a screen reader announces as its role. An
  unbracketed annotation is counted as a word the agent produced and is reproduced free by any
  candidate emitting a similar structure, which pads the ratio: `(2 rows, 3 columns)` alone moved a
  fixture that had dropped a table row from a true 0.833 to a reported 0.875, across the 0.85 gate.

  **And a field's text lives in its attributes, not its child nodes** — so every code path must
  announce fields through the one shared helper. When only the block path did, a field inside a table
  cell or an inline wrapper contributed nothing and a form-as-table with every value emptied scored
  1.0. `test/flatten.test.ts` enforces the first rule generically (nothing outside brackets may be a
  word the source document doesn't contain) rather than by listing known markers, which is what let
  the parenthesised ones slip through initially.

  A third rule, learned the same way: **an accessible name can live in an attribute** (`aria-label`,
  `title`), so those count as announced content — an agent update that dropped every `aria-label`
  scored 1.0 before and 0.3 after. The test baseline deliberately collects a *wider* attribute set
  than `flatten` reads, because when the two lists matched the baseline shared the code's blind spot
  and no attribute loss could fail a test. A baseline derived from what the code looks at is not
  independent of the code.

  The prompt and the markers are one contract in the other direction too. `test/flatten.test.ts`
  asserts `READER_SYSTEM` advertises no marker `flatten` never emits (`[Option]` was documented and
  unreachable).

  **An ordered item's marker is the number rendered in the list's style, not the number.** The
  ordinal an `<li>` carries is always a number — that is what `start`, `value` and `reversed`
  compute — but what a reader hears is that number rendered through `type`, and reading only the
  number announced `<ol type="a">` as `[List item 1]`: a marker the delivered document renders
  nowhere, in the one view the Reader has for checking markers against a page. It is the wrong
  marker rather than a missing one, which is the same trade `reversed` was already honoured for.
  `<li value="5">` inside `<ol type="a">` is `[List item e]`, because the two attributes mean the
  count and its rendering and not two competing markers. A style that cannot represent the ordinal
  falls back to the decimal — zero, a negative, a roman numeral past 3999 — because that is what
  CSS does, and an approximation of it would put a third marker in the view that no reader hears.
  On the bench corpus 31 of the 3,591 parseable page replies use `<ol type=…>`, every one of them a
  style HTML renders, and those 31 are exactly the replies whose view this changes — with no text
  outside the brackets moving on any of them, so `contentCoverage` cannot move either.
  `agents/page.md` now asks for the attribute by name, so the view had to be able to see it before
  the rule asking for it could be checked at all.

  **A marker that lives in an attribute has to be named to the pass that rewrites blocks.** Asking
  the extractor to put the letters in `type` and *not* in the item's text moves them out of the one
  thing `EDITOR_SYSTEM` protects: that pass returns whole replacement blocks, and until now the only
  attribute it was told to carry through by name was `href` — "the one kind no later pass can
  recover". A copy-edit round rewriting a block for an unrelated issue could hand back a bare `<ol>`,
  and nothing would notice: the marker sits inside brackets, which `contentCoverage` strips before
  comparing words, and the editor path's other loss checks watch links (`droppedHrefs`) and the body
  markers (`markerCounts`) only. So `EDITOR_SYSTEM` names `type`, `start`, `value` and `reversed` the
  way it names `href` — all four, because `flatten` announces a different marker without any one of
  them, and a list stated one member short reads as complete. That gap pre-dated `type`: a dropped
  `start` was already unrecoverable and already unmeasured. It stays a rule rather than a check for
  the reason the double marker stayed one: `editor_links_dropped` has fired once in the 151 logs on
  disk that ran the copy editor, and `editor_markers_changed` never, so the instrument this would add
  is one whose whole class shows up about as often as the defect it is watching for.

  The Reader's side of the same asymmetry is that a double marker has two resolutions and only one is
  right. `[List item a] (a) Estimating` clears if the text drops its copy, and it also clears if the
  `<ol>` loses its `type` — which leaves a list printing 1, 2, 3 where the page printed letters, and
  no gate can see that either. `READER_SYSTEM` therefore says which copy goes — **the text's, where the
  two markers agree in kind**, which is the condition the next paragraph is about, and never the
  duplication reported with the direction left to whoever fixes it.

  **And the direction reverses on the shape that actually occurs.** Counting the corpus by whether a
  list's marker is on the list or in its items: of the 1,075 replies with an `<ol>`, **7 have a bare
  `<ol>` whose every item's text opens with a letter or roman marker — one distinct list, the same one
  #334 reports — and 0 have a typed `<ol>` whose item text repeats the marker the list already
  announces.** So the shape the "delete the text's copy" direction fires on is the one with no
  occurrences, and the one with all of them flattens to `[List item 1] (a) Estimating`: a digit
  announced beside a printed letter. There the letters are the document's ONLY record of what the page
  printed, and deleting them is the single repair that loses a marker, so the rule splits on whether
  the two markers agree in kind. Where they agree the text's copy goes; where the list announces a
  digit and the items print letters, the list is what is missing its marker and the text must stay
  until the list carries it.

  That leaves who may repair it. Only the extractor sees the page, so the loop's default answer is
  nobody — which would report the defect every round with no legal fix and converge it as unresolved.
  `EDITOR_SYSTEM` gets one narrow licence instead, because this repair needs no page at all: the
  letters are already in the document's text, so moving them onto the list adds nothing. It applies
  only to a bare `<ol>` whose EVERY item opens with one sequence's marker, running consecutively from
  the ordinal the list counts from, and it is atomic — set the `type` and strip the markers, or change
  nothing. Each half alone is its own defect, which is why the rule says "one change, not two": the
  `type` without the strip reads the letter out twice, and the strip without the `type` is the
  deletion the paragraph above exists to prevent. A broken sequence, an unmarked item, or markers that
  do not start where the list does all fall back to reporting it, because a list converted on a guess
  announces a marker no page printed while one left alone still reads its letters out.

  **A licensed removal of visible text needs its own check, because the two halves of it are defects
  and the prose gate cannot see either.** `listMarkerHalfEdit` (`review.ts`) reads the announced
  marker and the item's own printed marker off `flatten` — the view where `type="a"` and a transcribed
  `(a)` are visible at once — and reports the two states the licence forbids: `marker_announced_twice`,
  an item printing **the marker the list announces**, which is #334's defect arriving from the
  review loop instead of from an extraction; and `text_markers_gone`, lettered markers leaving the items
  with the list not gaining them, which is the page's letters deleted outright. A complete conversion
  moves both counts together and is silent, which is why this compares two counts instead of watching
  the prose shorten. It sits beside `droppedHrefs` and `markerCounts` in the correction round, the other
  two records of something a round took away that no gate sees. It has **two stated silences**: a round
  that changed the number of items is not read at all, because a deleted item takes its printed marker
  with it and a signal that fires on the loop's own licensed deletions is one nobody reads; and every
  count is a BLOCK total, so one list's correct conversion pays for another's destruction in the same
  reply. The second is not narrowed because `flatten` marks items and never the list they belong to —
  splitting per list means a second renderer of the announced marker beside `markerStyle`, and the cheap
  substitute of starting a new list wherever the sequence restarts is wrong on any list carrying `start`.

  **A check on a licensed edit has to be counted at the grain the edit is made at, and the loss branch
  has to exclude the marker the list supplies itself.** The first version of this compared per-list
  totals and counted every printed marker alike, and all three of its defects followed from that.
  Counting a **digit** leaving an item's text as a loss put "the page's letters deleted" on the branch a
  reviewer meets first — an `<ol>` prints 1, 2, 3 by itself, so a digit the text repeats is the second
  copy the prompt asks for, and #334's own list is the digit shape. The loss branch therefore reads a
  lettered-only count. Comparing totals also made a **partial** strip — the `type` set and only some
  items stripped — satisfy neither condition and log nothing, which is exactly the half-edit the check
  exists for; counting `doubled` **per item** catches it, because the item that kept its own marker is
  the one a reader meets whatever the totals say. And a marker shape wide enough to match any letter
  followed by a stop matched an **initial**, so recasting "J. Smith chaired the committee" logged a lost
  marker: a printed marker is now three digits at most, a roman *number* (which `cm.` and `ml.` are not),
  or a single letter closed by `)` or `]`. The stated cost is a marker genuinely printed `a.` with no
  bracket, which this misses — the trade for not calling an ordinary sentence a deletion.

  **Both of those repairs then had to be applied on the side I had not looked at, which is the actual
  lesson.** The kind narrowing went one way only: a digit leaving an item's text stopped counting as a
  loss, but a digit *arriving* still counted as a doubling under a lettered list, where `(a) 12.
  Payments…` is a statute's clause number and a reader hears one marker and a number — while the digit
  doubling that does occur, `(1)` put back into a bare `<ol>`, moved nothing the check read. Both went
  away at once when `doubled` began matching the two markers **in kind** — one rule instead of two
  exceptions, though see the paragraph below for why kind was not the end of it either. And the
  punctuation narrowing stopped at the bare initial, leaving `(e.g. the
  totals)` — the same initial with an opening bracket — a printed lettered marker, so a single letter now
  needs the CLOSER and not merely a bracket. Two rounds, one shape of error each time: **a rule that
  splits on a property has to be checked on every value of that property, including the one the failing
  example did not have.**

  **The kind test was itself an approximation of the value test, and the round after found the two shapes
  it let through.** `(a) (i) Payments` is a marker and a roman SUB-marker — both non-digits, so a kind
  match called it a doubling — and a bare `<ol>` whose item prints `12.` announces "1" and reads "12",
  both digits: the same clause number in the other alphabet, on the side the kind test did not look at.
  `doubled` now compares the announced marker's own VALUE against the printed token, case-insensitively,
  which is what the rule always meant — an item repeating the marker it is announced with. It is also what
  `READER_SYSTEM`'s own SAME MARKER branch says — labelled "where the two AGREE" until the round that
  found the branches were not complementary — and reading that closely is what settles it: its examples are
  `[List item a] (a)` and `[List item 1] (1)`, which agree in **value**, so the kind test was never the
  prompt's split but a looser thing that admitted it. The prompt's two named branches are not
  complementary either, which is the reason a kind test looked like a fit: announced `1` with `12.`
  printed is the same *kind* and a different marker, so it falls outside both, and only the prompt's
  catch-all covered it. It is now a third case in `READER_SYSTEM` in as many words — not one marker printed
  twice, so neither copy may be dropped — because the Reader was reaching the right answer through a
  prohibition rather than through a rule, and a rule stated as two branches invites reading the second as
  everything the first is not. **Writing that third case then cost a round of its own, in the way this
  whole note keeps describing.** Its first version said "leave the list and the text exactly as they are",
  which forbids more than the prohibition it replaced: the prohibition only barred *dropping* the text's
  marker, while a blanket "change nothing" also barred the report `EDITOR_SYSTEM` asks for on the same
  input (*"where the markers do not begin where the list's own count does … report it instead"*) and the
  one the Reader is asked for a dozen lines earlier. And its reason — a reader hears "one marker and then a
  number" — was true of the digit example and false of `[List item a] (c)`, which the branch also covers
  and where a reader hears two letters. **A remedy for a rule stated at the wrong
  grain can be stated at the wrong grain itself, in both directions at once: too wide in what it forbids,
  too narrow in what it justifies.**

  The round after that found the replacement wrong on its own second example, which is the same lesson at
  the next level down: the case split on whether the printed markers were "one run consecutive from
  wherever it starts", a condition stated for **every** list, and the repair it then names does not exist
  for half of them. `type` carries a marker's kind and `start` carries only its count, so `start="12"` on
  an `<ol type="a">` announces `l.`, `m.`, `n.` — a marker no page printed, and the invention the same
  prompt forbids nine lines later. The report is only true where the printed run is the **same kind** as
  the announced marker, and then it is exactly true: `start="3"` on an `<ol type="a">` printing `(c)`,
  `(d)` announces `c`, `d`. So the split is now on what `start` can announce — same kind and one
  consecutive run is a missing `start`; a different kind, or no single run, is the document's own clause
  numbering and stays in the text with no repair asked for at all. **A remedy that names a repair has to
  be scoped to the inputs the repair exists for, and the example list under a rule is where that shows:
  the sentence covered two examples and the mechanism it invoked reached one of them.** The same round
  found the second branch still labelled "where they DISAGREE in kind", which literally covers the third
  case's own new example (announced `a`, printed `12.`) and whose repair — "the list is missing the type
  that would announce the letters" — is nonsense on a list already carrying `type="a"`. Naming a branch
  by the shape its repair is true of, rather than by a property that shape happens to have, is what makes
  "NEITHER of those" a condition and not a hope.

  One consequence of that scoping was raised and **declined**, with the reason written down rather than
  left implicit: the missing-`start` report names a repair `EDITOR_SYSTEM` forbids ("Never add one"), so it
  converges as unresolved, and widening the licence to cover a same-kind consecutive run would close the
  loop. It is not widened, because the half-edit detector cannot police the change it would license. On the
  digit half of that shape the destructive half-edit — markers stripped, no `start` set, which deletes the
  document's only record of its numbering — produces the SAME five counts as the whole conversion, since
  `printed_lettered` was already 0 and stays 0; the lettered half is caught. **A licence is only as safe as
  the check that can see its half-edits, so the check comes first and the licence second.** The report
  itself stands: it names a defect nothing else in the document records, which is the class the
  `[not legible]` and fidelity reports are in, and the editor's own precondition already sends that shape
  to a report rather than a change.

  Back to the predicate, and the thread the two paragraphs above interrupt: `docs/API.md` had the same
  shape of error as those branch labels, in the
  other direction — it defined the field by kind and *illustrated* it by value, so the examples were more
  precise than the definition above them. Three rounds on one predicate, each approximation defensible
  until the next value showed up: **when a check can be stated as "the same thing twice", compare the
  thing and not a property of it** — and when a rule already exists in a prompt or a doc, read its
  examples, because they are the specification and the sentence over them may be an approximation.

  That check is also what makes the licensed strip legible where it collides with the loss machinery,
  which it does and is left doing. `proseShortened` is a comparison of visible text, so the strip is a
  `shrunk` block like any other: a reply that converts a list **and** carries a refusal is refused
  whole as `refusal_with_loss`, and on a truncated round `lostAt` stops the claim at the converted
  block. Both cost a round rather than shipping wrong markup, and the overlap is not new — a licensed
  link-text rewrite shortens prose too. An exemption would have to live inside `gaveContentUp`, the gate
  whose whole job is refusing silent content loss, to spare one corpus list's worth of conversions; the
  thing that was actually missing was a maintainer's ability to tell a sanctioned strip from a real one
  in the log, and that is a line rather than a change to the gate.

  And every annotation that explains *correct* markup — `[spans N columns]`,
  `[spans N rows]`, `[decorative, alt empty]` — exists because the prompt tells the Reader that an
  unexplained mismatch is a defect, and the Copy Editor is licensed to restructure tables. Adding a
  check to that prompt without the annotation that reconciles it turns the review loop into a
  false-positive generator aimed at accessible output.

## Learning from feedback

- **Both sides of the eval gate must score fixtures by the same rule.** Before proposing an agent
  update, Iris compares the candidate prompt's mean fixture coverage (from `regressionGate`) against
  the current prompt's (from `evalAgent`) and blocks a drop of more than `EVAL_REGRESSION_EPS`
  (0.02). That comparison is a subtraction between two means, so it is only valid if both are
  computed identically — and they were not.

  `contentCoverage` returns `null` for a fixture whose accepted text is under `MIN_COVERAGE_WORDS`
  (8), because one dropped word would swing the ratio. `regressionGate` excluded those from its mean,
  while `evalAgent` scored them a perfect **1**. Since abstention depends only on `accepted_html`,
  the *same* fixture abstained on both sides, so the 1 landed on the current-prompt side alone and
  inflated it.

  With `MAX_GATE_FIXTURES` = 3 that is large: two judgeable fixtures at 0.90 plus one unjudgeable
  gave current 0.933 vs candidate 0.900 — a 0.033 gap from padding alone, past the 0.02 threshold.
  The gate discarded updates whose measurable coverage was *identical*, logged as `eval_regression`:
  a reason naming a regression that had not happened. A single `fixtureScore` helper now defines the
  rule for both, and an abstaining fixture is absent from both sides rather than scored.

  Note the direction — the failure mode here is a **false block**, not a wave-through, which is why
  it was invisible: a learning loop that silently declines to learn looks like a loop with nothing to
  learn. A mean over zero measurements is `null`, not 0. The caller treats that as "nothing to compare"
  and defers to the regression gate, since 0 would block every update and 1 would assert a score no
  fixture demonstrated.

  No output at all is scored 0 rather than abstaining, because producing nothing is a *failure* on
  the fixture, not an absence of evidence — abstaining would let a prompt that returns nothing score
  as well as one that handles it. That is also the one input where abstention is **not** purely a
  property of the fixture: whether a prompt produced output is a property of *that prompt*, so one
  fixture can be scored 0 for one side and excluded from the other.
- **The eval gate is a *paired* comparison, per fixture.** The rule above is right about what a score
  means, but averaging each side over whatever it happened to measure compared two different fixture
  sets — and in one direction that waved a real regression through.

  If the **current** prompt flaked to no output on a fixture the candidate abstained on, the current
  mean was *deflated* and the bar dropped. One such fixture plus one judgeable at 0.98 gave current
  `(0 + 0.98)/2 = 0.49` against a candidate at 0.88. So `0.88 < 0.49 - 0.02` was false, 0.88 cleared
  the 0.85 floor, and a real 0.10 coverage regression passed both gates. Note this is the *opposite*
  direction from the false block above — the same asymmetry, read from the other side.

  Both scorers now return per-fixture scores and `pairedMeans` averages only the fixtures **both**
  prompts could be scored on, so a per-prompt exclusion drops the fixture from both means instead of
  moving the threshold.

  Deliberately, a current-prompt flake is treated as evidence for neither side: it is a problem with
  the current library agent, and lowering the bar is the one response that hides both it and any
  regression behind it. It stays visible in the `eval_gate` log line's `unpaired` list. If no fixture
  is measurable on both sides, both means are `null` — "nothing to compare", deferring to the
  regression gate, rather than a pass.
- **A suggestion issue is identified by its title prefix, not by a label.** GitHub silently drops
  labels set by anyone without push access to the repo, which is most of the people this is built for.
  A label would therefore have been missing on exactly the issues that most needed it, with nothing to
  say so — and the duplicate check that filtered on it would have refiled the same suggestion every
  session, under a different person's name each time. An operator who wants labels adds a repository
  rule keyed on the prefix: it applies them as the repo rather than as the filer, so it works no matter
  who filed.

## The provider adapters

These are the rules both adapters enforce on a model call. The README states the config keys
(`max_tokens`, `providers.bedrock.api`, `providers.per_agent`); this is why each rule exists.

- **A per-agent key Iris cannot route does not stop the run.** An unrecognized name in
  `providers.per_agent` simply finds no override and takes the normal fallback, so the swap does not
  happen and the document arrives at the price it would have cost anyway.

  Boot warns about a key it cannot route (`perAgentKeyWarning`), and that warning is the only place
  the *key* can be named. `by_agent.<agent>.models` in diagnostics names the model ids that agent's
  calls actually went out on, never what was ignored. Both of this repo's own example configs had
  carried an unroutable key: `config.example.yaml` a `table` no call site has ever dispatched, and the
  retired requirements document an `image_analysis` that went with the triage step it named.
- **A response that stops at the output ceiling is a failed call, not a short one.** It arrives as a
  200 with HTML cut mid-tag, which would otherwise be assembled into the deliverable as if it were
  genuine content. Both adapters reject it and the error names the knob to raise.

  A ceiling the *model* enforces below `max_tokens` is a different failure — several non-Claude models
  on Bedrock refuse the request rather than clamping it, so a config-only model swap would fail every
  call. The Bedrock adapter survives it: the rejection states the model's own ceiling, so the call is
  sent again at that ceiling, and that number is what every later call to the model asks for in the
  same process. A warning (once per model) names `max_tokens` as the setting to fix.

  The cost of the swap is therefore one rejected request per call already in flight when the first is
  refused, and none after that; a request Bedrock never read is not billed.

  Because the pages then arrive, the wrong setting has no other consequence anyone downstream can
  see. So every clamped call also carries `output_ceiling_clamped` on its `model_call` line, with
  the ceiling asked for and the one granted ([API.md's run log](API.md#run-log)). The warning is
  once per process, the log line is once per call: an aggregate over run logs is the only place a
  `max_tokens` nobody chose shows up.
- **The limits are about *silence*, not duration.** Both adapters **stream**, to tell a stalled call
  apart from a slow one. A single non-streaming request cannot: "no answer yet" describes a dead
  socket and a large document being correctly rewritten equally well, so a total-duration cap kills
  both — and the review phase's document-level rewrite (the whole body in, and every block the editor
  changed back out) is the call slow enough to be killed.

  So there are three limits in both adapters. **120s** to produce anything at all, since before the
  first token a slow call and a dead one look identical, and that phase is where the whole prompt — a
  document plus its page images — gets processed. Then **60s** of silence once output is arriving,
  where a gap really does mean the stream died. Work that keeps arriving runs as long as it needs,
  bounded only by a deliberately generous **15-minute** backstop for a stream that trickles without
  ever finishing.

  Protocol events keep a call alive but do not end the start-up phase: only actual output does, so a
  stream that opens with a role-only delta or a `message_start` still gets its full 120s. Each limit
  is a distinct error naming which one it hit and how much had streamed, since "never started",
  "stopped halfway" and "never converged" call for different responses.
- **A keepalive is not progress** in either adapter — Bedrock's `ping`, OpenRouter's
  `: OPENROUTER PROCESSING` comment. Letting one reset the clock would defeat the timeout in the one
  case it exists for: a generation that hangs behind a connection that stays chatty.
- **A stream ending is not a response completing**, and the two are checked in both directions. A
  terminal event (`message_stop` / `[DONE]`, or a stop reason) is required, because an event stream
  that stops early would otherwise deliver a half-corrected document as a successful result — the
  same failure the truncation guard exists to prevent, arriving by a different road. Conversely the
  terminal event ends the read then and there, so a connection held open after the message is finished
  cannot let the silence clock discard a whole document.

  *Which* event is terminal is a property of the wire format rather than of the word "stop". On
  Bedrock's Converse stream the `metadata` event carrying every token count arrives **after**
  `messageStop`, so the read ends at `metadata` there — breaking at the stop event, the literal
  translation of the Anthropic path, would report every Converse call as free.

  That tail gets a single short window of its own (**10s** from the stop event, not per frame) rather
  than the idle clock. Once the message has stopped **no tail failure fails the call**: running out of
  the window, a stream error, a throttling exception, even the 15-minute backstop all end the read and
  return the document. There is nothing left to protect at that point but a number, and spending a
  minute waiting for it and then discarding a finished document would be the worse trade.

  The price is that a Converse stream error arriving after the message is absorbed silently; what a
  reader sees of it is a call reporting no usage, which diagnostics already counts
  (`tokens.calls_reported`). The same failure one event *earlier* still fails the call, which is the
  line that makes absorbing it safe: before the stop event the document is not whole.
- **Stopping is not the same as finishing**, and which stop reasons mean "the answer is whole" is a
  shorter list than which exist. The Anthropic body stops only for `end_turn`, `max_tokens`,
  `stop_sequence`, `tool_use` or `refusal`, so one truncation check covered every incomplete case.
  Bedrock's own `StopReason` adds `model_context_window_exceeded`, `malformed_model_output`,
  `malformed_tool_use`, `content_filtered` and `guardrail_intervened` — each of which arrives on a
  well-formed stream and would otherwise pass every check above and deliver partial HTML as a success.

  The adapter therefore allowlists the reasons that mean whole and fails on the rest, so a reason a
  future model invents is refused rather than trusted. The allowlist governs **both** dialects:
  nothing an Anthropic body can send today falls outside it (Iris configures no server tools,
  guardrails or context management), so the live path does not move. What changes is the direction it
  fails in when that stops being true.

  The ceiling keeps its own error, since it is the one with a knob to name. Running out of context
  window is reported as a size problem, which routes it to the same retry-without-images path Iris
  already uses when a request is refused for size up front — one place where that path names a call
  that was billed in full rather than refused before it ran.
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
  like it could (#178).

  It is off by default because parity between them is an empirical question about a live endpoint: the
  request bodies differ in every field, and no test here talks to AWS. So the key is there to be
  measured with, not to be assumed — a one-page probe and one bench round on `converse` are what would
  move the default.

  An unrecognized value falls back to `invoke` and says so at boot, because both dialects just return
  text: without the warning, a deployment that meant to be trying Converse would be measuring the path
  it already had. Every `model_call` line carries the dialect it went out on (`api`), since the point
  of the switch is comparing the two and a comparison whose run log does not say which side produced a
  number is not one.

## Running the service

- **`GET /v1/sessions` pages on a compound cursor.** The endpoint was specified with a `cursor`
  parameter and no statement of what is in it, and the obvious reading — the last row's `created_at` —
  is unsound. `created_at` is a millisecond timestamp assigned by a request handler, so a burst of
  uploads ties on it, and paging on a non-unique key skips rows (`created_at < ?` drops the rest of a
  tied group) and can repeat them (nothing pins the order among ties).

  `next_cursor` is therefore `"<created_at>|<session_id>"`, the full sort key; clients pass it back
  verbatim. A cursor that doesn't parse is a `400`, not a silent restart at page one, and
  `next_cursor` is `null` on a full final page — so clients stop on a null cursor rather than on a
  short page.
- **Runs are queued, and the queue is in-process.** A bounded FIFO queue (`src/util/queue.ts`) caps
  concurrent pipelines at `defaults.max_concurrent_runs`; sessions over the cap wait in `queued`.

  Two things this deliberately does *not* do. It does not persist: the queue lives in the process, so
  a restart loses waiting runs — they are marked `failed` ("interrupted (server restarted)") by the
  same `failStaleSessions()` sweep that already handled interrupted `running` sessions, which is why
  that sweep covers `queued` too.

  And it does not bound upload memory: multer parses the whole body before any handler runs, so by the
  time the queue sees a session its images are already buffered in RAM (ceiling: multer's own
  `limits.fileSize` × part count) and any PDF is already rasterized to full-page 150-DPI PNGs. Both
  are consequences of the single-instance, single-process design the store declares.
- **The model's input limits are Iris's input limits, and they live in one file.** An uploaded image
  is handed to the vision model byte for byte — nothing resizes or re-encodes it — so what the model
  accepts is what Iris can accept. Every such number is therefore a fact about a configured model or
  provider rather than about Iris.

  `src/providers/imageLimits.ts` holds all of them (the per-provider per-image byte cap, the hard
  8000 px ceiling, the per-generation long edge, the format allowlist, the one sentence of advice) and
  resolves them through the same `resolveAgentModel` the router uses, taking the *strictest* value on
  each axis independently across the four agents that are handed a page image. Everything downstream
  reads from there: the upload check and its `400`, `GET /v1/limits`, the demo page's hint and
  `accept` list, and the API docs.

  A PDF is measured *after* rasterizing rather than as uploaded. Its pages are what reach the model,
  and at a fixed DPI a page image's size follows the physical page size, so a large-format page can
  break a limit its 20 MB parent file does not.

  This is not tidiness. The numbers had been stated in five places and enforced in none, so the demo,
  the docs and the specification all advertised **TIFF**, which Claude has never read (accepted, then
  failed inside the first model call) while rejecting **GIF**, which it does. And an oversized photo
  was accepted by multer's 50 MB ceiling and died two to four minutes later as
  "no output arrived within 120s". Switching models now moves every one of those surfaces together.
  An operator can still override per provider (`providers.<name>.image_limits`) for a model newer
  than the table.

  One source sits behind all of it — Claude's vision documentation — and since
  `providers.bedrock.api: converse` can reach a model Anthropic did not make, the file now says which
  of its numbers it has actually read. A vision model it cannot place in the Claude generations
  resolves the same conservative limits (they are the right ones to serve an upload with while nobody
  has measured) but marks them `assumed`.

  The *claims* change with that flag. The hint stops promising that re-saving at the long edge
  "loses nothing the conversion would have used" — a promise about the model's downscaling, and on an
  unmeasured model advice to destroy detail that may have been read. And the 8000 px rejection stops
  attributing itself to the model's refusal.

  Boot warns once, naming the agents, the model and the config path, because every downstream surface
  here is written to be quoted verbatim and none of them can qualify itself. Setting
  `image_limits.max_long_edge_px` is the operator answering, and it silences both — where it can be
  read as an answer.

  That setting is per provider **block** and the basis question is per **model**, so on a block that
  also serves a model Iris does have limits for, a number there is ambiguous about which of them it
  was read from, and Iris will not take it as one.

  A Bedrock deployment that sends a single agent to another vendor is always in that case, since `api`
  is a block setting and only a block named `bedrock` builds a Bedrock adapter. There is no per-model
  `image_limits` and nothing to set, so the warning says so and names the models the block is shared
  with rather than asking for a line that would not help. Such a deployment keeps the conservative
  numbers until someone publishes or measures that model's own.

  `GET /v1/limits` gains no field for this: the endpoint deliberately says nothing about which model
  serves the deployment, so the qualification is in the wording of `hint`.
- **Starting work on a session is a claim, not a check (`store.claimSession`).** The two endpoints
  that begin non-idempotent work — `POST /:id/feedback` (enqueues a pipeline) and `POST /:id/close`
  (files regression fixtures into the shared agent library, deletes the tmp tree) — used to read the
  status, compare it, then write. `claimSession` folds the comparison into the write
  (`UPDATE … WHERE session_id = ? AND status = ?`) and reports whether this caller is the one that
  changed the row, so of two concurrent callers exactly one is told it won.

  What this is and is not: both handlers are fully synchronous, so *today* nothing can interleave
  between the check and the write and the plain pattern was already correct. Racing two **processes**
  against a shared WAL database, both callers won — but a second instance is not the supported
  topology (see the in-process queue above).

  So this is defense in depth. It earns its place by being the cheaper invariant to hold: correctness
  stops depending on every future handler staying synchronous. Adding one `await` between the guard
  and the write — the ordinary thing to do when a check needs I/O — would silently reintroduce the
  race in-process. A duplicated feedback run is invisible in the response (both callers get a `202`)
  while two pipelines write the same `output.html` and `fragments/final.json`.

  The claim sits *last* in the feedback handler (after request validation, so a malformed body still
  gets its `400` without disturbing the session) and *first* in close (before fixture capture and the
  `rmSync`, because a loser that discovers it lost afterwards has already filed the fixtures twice).
- **Feedback re-runs.** Re-runs are logged separately (a `feedback_rerun` event) and the prior
  `output.html` is snapshotted to `sessions/<id>/history/` so it can be reverted to. A revert
  *endpoint* is out of v1 API scope; the data is preserved to enable it.

  A re-run is **routed** first (`feedback_scoped` event). The Reader only ever sees the assembled
  HTML, by design — image access is the Copy Editor's. So feedback about what was *read off a page*
  ("the revenue figure on page 2 is wrong") raises no issue for the loop to act on and cannot be fixed
  there. The Feedback Agent's SCOPE task decides which case applies:
  - **`document`** — tone, wording, ordering, or an accessibility rule: re-lint the saved body
    and run the feedback-aware review loop on it. No source images, no re-extraction.
  - **`extraction`** — source-fidelity: the named pages go back to the page agent *with their
    source image and their previous output* attached, then the document is reassembled and
    reviewed. Untargeted pages keep their prior fragments byte-for-byte.

  Routing is deliberately biased toward the cheap path: an unavailable agent, an unparseable
  answer, pages it cannot localize, or a claim spanning more than half the document all fall
  back to `document`. A wrong `document` answer costs one review round; a wrong `extraction`
  answer costs a vision call per page.
- **One instance per `data_dir` — this is a hard constraint, not a preference.** Running two processes
  against the same `storage.data_dir` corrupts sessions, and it fails loudly in the wrong direction:
  on boot each instance runs `failStaleSessions()`, which marks every `running` and `queued` row
  `failed` with `interrupted (server restarted)`. Those rows include the *other* instance's live runs.

  A second instance starting therefore kills the first one's in-flight conversions from the client's
  point of view. The pipeline keeps going and still writes `output.html`, but the session reads
  `failed`, so the user is told their document failed while work continues on it.
  The sweep cannot tell "this row is orphaned" from "this row belongs to a peer" because nothing
  records which process owns a run.

  Two other single-process assumptions ride along: the run queue that enforces
  `max_concurrent_runs` is in-memory, so N instances allow N × the cap, and fixture and
  agent-memory writes under `data_dir` are unsynchronized between processes.

  To scale beyond one box, put a second `data_dir` behind it (independent instances, sessions not
  shared) rather than pointing two at one directory. Gating the sweep on an instance id, and
  moving the queue and locks out of process, is what a genuinely multi-instance version needs.

- **`phase` reports only phases that exist.** `extraction`, `assembly`, `review`, `done`. The
  designed `triage` and `reconciliation` phases are not implemented — reconciliation is unreachable
  while extraction hardcodes `edges: []` — so they are not in the enum and not emitted. New sessions
  start at `extraction`; they used to be created at `triage` and overwritten before a client could
  observe it.
- **A PDF's page range is divided between several `pdftoppm` processes, and the uploader waits for it.**
  `pdftoppm` renders one page at a time on one core, so Iris shards the range — up to one process per
  core the host reports, and never more than the document has pages. A 25-page document that took
  12.5 s in one process takes 3.9 s across four; past about a dozen cores it stops getting faster,
  the shards already being down to two pages each. The route rasterizes before it answers, which is
  why cores are worth giving a deployment that takes PDFs.

  The budget is shared across concurrent uploads rather than granted to each, so a second document
  arriving mid-render takes what is left, down to the single process it would have had before. Sharing
  it is the same decision as the global run cap: the resource being protected is the machine's, not the
  caller's.

## Designed for, and not built

Designed for and intentionally **not** built in v1: PostgreSQL and S3 backends (SQLite + local
filesystem is the v1 reference), a per-user configuration endpoint, and webhooks. Each was framed as
optional, as an alternative, or as out of scope.

Two endpoints go the other way and were never specified: `GET /v1/health`, a standard liveness probe,
and `GET /v1/stats`, the public page tally described above.