# PRD: Equalify Iris

**Image-to-Accessible-HTML Parsing Service**

**Status**: Draft v0.8
**Author**: Blake Bertuccelli-Booth
**Last updated**: 2026-05-22

---

## 1. Overview

**Equalify Iris** (Iris for short) is a multi-agent service that converts a sequential set of image files (e.g., the rendered pages of a PDF) into a single accessible HTML document. The system is composed of specialized agents that each handle a narrow content type, a self-extending mechanism that builds new agents per session when it encounters unsupported content, and a review loop that iteratively corrects reading order and inconsistencies. Output is content-only accessible HTML — styling is out of scope.

Iris is Open Source and designed to improve over time, but improvement flows through a single channel: agents built during a session are ephemeral, and a session-built agent only becomes permanently available to a user (or anyone else) after it has been submitted as a pull request, reviewed and merged upstream, and pulled into the user's local repository. This makes upstream review the gatekeeper for every agent that ever runs.

## 2. Problem

Converting image-based documents (scanned PDFs, page exports, photographed forms) into accessible HTML today requires either expensive proprietary OCR pipelines that produce structurally weak output, or hand remediation. Neither path produces consistently WCAG-conformant HTML at scale, and neither improves with use.

The deeper difficulty is content variety. PDFs in the wild contain an open-ended set of structures — multi-column layouts, complex forms, scientific notation, decorative versus semantic graphics, footnotes, signature blocks, marginalia, domain-specific diagrams — that no fixed extraction pipeline and no single team can fully anticipate. A useful solution has to be a framework, not a product: extensible by design, contributable by anyone who encounters a content type the current library does not handle well.

## 3. Goals

- Accept a sequential set of images and return a single accessible HTML file.
- Produce content-only HTML that meets WCAG 2.2 AA structural and semantic requirements (headings, landmarks, lists, tables with headers, form labels, alt text, reading order).
- **Provide an extensible framework for building and contributing agents.** PDF content is too varied for any single author or team to forecast. The framework must make adding a new agent a small, well-scoped task with a clear contract (input, output, accessibility requirements), and must make contributing that agent back to the shared library frictionless. The compounding capability comes from many hands, not from one comprehensive build.
- **Portable, no vendor lock-in.** The service must run on a single machine — laptop, workstation, Mac Mini, or self-hosted server — without requiring any specific cloud account. Every external dependency is replaceable by configuration: LLM access goes through a provider abstraction with multiple supported backends (Amazon Bedrock and OpenRouter at v1, more planned including direct provider APIs and self-hosted models), and no managed cloud service is mandatory. An Open Source maintainer or a small organization should be able to stand up a working deployment in minutes.
- Decompose the problem by content type so each agent's prompt and model can be tuned narrowly.
- **Self-extend within a session**: when no agent exists for a content type encountered in a job, build one for use in that session only. Session-built agents do not persist locally.
- **Make upstream GitHub PR the only path to permanent agents.** A session-built agent persists in a user's local `agents/` directory only after the user opens a PR, the upstream maintainer merges it, and the user pulls the updated repo. There is no local promotion path. This enforces upstream review as the floor of trust for every agent that ever runs. **Amended (v1.2):** the contribution is a labeled **issue** rather than a PR (§7.13 v1.2); upstream merge plus `git pull` is still the only path, and upstream review is still the floor of trust.
- **Make every user a contributor (v1.2).** GitHub is the only SSO layer and a user's GitHub token is required on every API call, because that token is what files the session's contributions under the user's own identity. Consuming the agent library and refilling it are the same act; there is no anonymous mode, no alternative credential, and no opt-out (§12).
- Reconcile fragments that span image boundaries.
- Verify output with a reader-style agent that flags reading-order and consistency issues, with a bounded refinement loop.
- Accept user feedback and re-run the pipeline with that feedback as a first-class input.

## 4. Non-Goals

- **Styling**: no CSS, no visual fidelity to the source. Content and semantics only.
- **Pixel-perfect layout reproduction**: a two-column source becomes linear semantic HTML.
- **Auth providers other than GitHub (v1.2)**: no API keys, no pasted PATs, no basic auth, no second SSO provider, and no anonymous mode. This is a design boundary rather than deferred work — the GitHub token is what files each session's contributions under the user's identity, so any credential that cannot do that would admit callers who consume the agent library without refilling it (§12, §9.1).
- **Opting out of contributing (v1.2)**: there is no parameter, config key or account setting that finalizes a session without filing what it produced. See §7.13 v1.2.

## 5. Users and Use Cases

- **Accessibility engineers** remediating large document backlogs.
- **Faculty and instructional designers** preparing course materials from scanned originals.
- **Civic and nonprofit teams** publishing accessible versions of government forms.
- **Open Source contributors** extending the agent library for new content types.

## 6. System Architecture

The pipeline runs in five phases:

1. **Triage** — per-image analysis produces notes.
2. **Extraction** — content agents convert their assigned regions to accessible HTML.
3. **Reconciliation** — fragments spanning image boundaries are stitched.
4. **Assembly** — content blocks combine into a single HTML document; in-pipeline provenance comments are stripped from the deliverable (§7.4, v1.1) and recorded in the run log.
5. **Review** — reader / copy editor / assembler loop refines the document until clean or until max iterations reached.

After phase 5, the document is returned to the user, who may submit feedback (re-running phases 1–5 with feedback injected) or accept the result and optionally submit any newly built agents as a PR.

**Amended (v1.2): contribution is not a step the user takes at the end.** Newly built agents and generalizable feedback are filed as GitHub issues *during* the run, by the phase that produced them, using the user's own token (§7.13 v1.2, §12). Accepting the document (`/close`) locks the HTML and cleans up `tmp/`; it opens nothing and offers no choice about contributing.

```
       ┌─────────────────────────────────────────────────────────────┐
       │  (user feedback re-run: feedback injected as top-level      │
       │   instruction passed to all downstream agents)              │
       │                                                             │
       ↓                                                             │
[images] → Image Analysis Agent → notes/*.md                         │
                                       ↓                             │
                          Orchestrator (sequential or concurrent)    │
                                       ↓                             │
                  ┌────────────┬───────┴───────┬────────────┐        │
                  ↓            ↓               ↓            ↓        │
            table agent  formField agent  paragraph agent  (Builder  │
                  │            │               │            Agent if │
                  │            │               │            no match)│
                  │            │               │            ──→ new  │
                  │            │               │            agent   │
                  │            │               │            (logged)│
                  ↓            ↓               ↓            ↓        │
                  └────────────┴───────┬───────┴────────────┘        │
                                       ↓                             │
                           Reconciliation Agent (fragments)          │
                                       ↓                             │
                            Assembly (single HTML file)              │
                                       ↓                             │
                    ┌──→ Reader Agent ──→ issues? ──no──→ Return to user
                    │         │ yes                              │
                    │         ↓                                  ↓
                    │   Copy Editor Agent                   user feedback?
                    │         ↓                              ├── no → POST /close
                    │   Assembler Agent                      │       (opens PRs for any
                    │         ↓                              │        session-built agents
                    │         │                              │        and updates, then
                    │         │                              │        clears tmp) → done
                    │         │                              └── yes ┘
                    └─────────┘  (max N iterations, default 3)
                                                              (loops back to top)
```

**Amended (v1.2): the extraction fan-out in the diagram above is withdrawn.** The row of per-content-type agents (`table` / `formField` / `paragraph`) and the Reconciliation step below it describe a shape that is not built and is not coming: extraction is **one vision call per page** to the page agent, optionally merging a specialist for content that call handles worse (§7.4 v1.2). Read that band of the diagram as:

```
[images] → page agent (one call per page, sees the whole page)
                 │
                 ├── flags a content type a specialist handles better?
                 │        └─→ specialist agent → merged into the page
                 ↓
           Assembly (single HTML file)
```

Phase 2 in the list above ("content agents convert their assigned regions") and phase 3 (Reconciliation) are superseded accordingly — there are no assigned regions and no per-region fragments to stitch. §7.4 v1.2 gives the reasoning.

## 7. Detailed Requirements

### 7.1 Input

- An ordered set of image files (PNG, JPEG, TIFF, WebP). Order is significant.
- Optional run configuration:
  - `max_review_iterations` (default `3`)
  - `feedback` (string, optional — present on re-runs)

Accessibility target is fixed at WCAG 2.2 AA for v1 and is not user-configurable. The pipeline runs sequentially — there is no concurrency option in v1.

### 7.2 Image Analysis Agent (Triage)

> **Not implemented, and its `# Agent Calls` list is withdrawn (v1.2).** Nothing writes
> `notes/<image>.md`; `notes/` is not created and `paths.ts` has no `sessionNotes()`. A
> session starts at `extraction`, and `triage` is not in the phase enum (§9.2 v1.1).
> Read this section as a design for a phase that may be built (#30 Tier 4) rather than a
> description of what runs — and read the `# Agent Calls` block below as naming agents
> that **no longer exist**: `table.md`, `formField.md`, `paragraph.md` and `heading.md`
> were deleted with the per-content-type fan-out (§7.4 v1.2). A triage phase built today
> would name `page.md` plus any specialist the page warrants.

**Purpose**: For each image, produce a notes file describing (a) the content types present and (b) which edges may contain fragments continuing onto adjacent images.

**Required capability**: a vision-capable LLM with strong structured-output behavior. The specific model is determined by the deployment's configured provider for the `vision` capability (see §10.3). One image at a time.

**Output**: `notes/<image-name>.md` with the schema below.

**Notes file schema**:

```markdown
---
image: page-003.png
order: 3
---

# Content Types
- table
- formField
- paragraph
- heading

# Fragment Indicators
- top-edge: paragraph appears to continue from previous image
- bottom-edge: table appears truncated, continues on next image
- left-edge: none
- right-edge: none

# Agent Calls
- table.md
- formField.md
- paragraph.md
- heading.md

# Notes for downstream agents
- Page header repeats across the document; treat as decorative unless it changes.
- Form field at lower left has no visible label — check adjacent page for label.
```

**Why this format**: human-readable, diffable in Git, easy for the orchestrator to parse, and reviewable by a person mid-run if anything goes wrong.

### 7.3 Orchestrator

> **The dispatch model in this section is superseded (v1.2).** There are no notes files to
> read (§7.2 above) and no list of per-content-type agents to dispatch: the orchestrator
> calls `page.md` once per image, concurrently rather than sequentially, and merges a named
> specialist only where one is warranted (§7.4 v1.2). Everything below about **agent version
> pinning** is implemented as written and is not affected.

**Purpose**: Read each notes file, dispatch the listed content agents against the relevant image, and collect their outputs.

**Behavior**:
- Processes images sequentially in their submitted order.
- If a referenced agent file does not exist in the agents directory, invoke the **Builder Agent** (see 7.5) and resume. The built agent is session-scoped (see §7.5 and §8).
- When a content agent is called on an image and finds nothing matching its declared content type, it returns a `no-content` signal. The orchestrator logs this and surfaces it later so the Reader can cross-check against the Image Analysis Agent's triage.
- All agent calls and their outputs are logged to `runs/<run-id>/log.jsonl`.

**Reproducibility — agent version pinning**:
- For every agent invoked, the orchestrator records the agent file's git SHA at the time of the call.
- For session-built agents (which have no upstream SHA), the orchestrator records the full agent file content directly in the log.
- A run can be replayed later by checking out the recorded SHAs and substituting the inline content for any session-built agents that were never merged upstream.

### 7.4 Content Agents

> **"One agent per content type" is withdrawn, and the nine files this section names are
> deleted — see the v1.2 amendment below**, which is the authority for this section. The
> prose and the **Initial agent set** list that follow describe the withdrawn shape and are
> kept because the amendment argues against them. The parts that survived and still govern
> every agent: the input contract (full uncropped image, no baseline OCR pass), the output
> contract (a fragment accessible by itself, plus a fragment log), and the accessibility
> requirements. `agents/table.md` and `agents/formField.md` below are examples of the file
> *format*, not of files that exist.

**Purpose**: One agent per content type. Each agent is defined by its own markdown file (e.g., `agents/table.md`, `agents/formField.md`) containing its system prompt, the model capability it requires (e.g., `vision`, `structured_output`), and its input/output contract. The concrete model used at runtime is chosen by the deployment's provider configuration (§10.3), not by the agent file. An agent specifies what it needs; the deployment decides which provider serves that need.

**Contract** (every content agent must follow):

- **Input**: the full source image (not cropped) plus the notes file for that image. Cropping is intentionally avoided because region extraction is its own failure surface and often strips contextual cues an agent depends on (a table needs its caption above it, a form field needs its label, a footnote needs the body text it references). If token cost becomes a constraint at scale, this can be revisited per-agent.
- **OCR**: the system does not run a baseline OCR pass before invoking content agents. Modern vision-capable LLMs read in-image text well enough for most cases, and inserting an OCR layer at the system level introduces another error source that propagates as confident-wrong text downstream. An individual content agent that benefits from OCR (e.g., a dense-form specialist) may invoke OCR as its own internal tool; the system does not impose it.
- **Output**:
  - An HTML fragment that is accessible by itself (semantic elements, headers on tables, labels on form fields, alt text on images, etc.).
  - A fragment log entry noting any edges where content appears cut off, with enough text/context to allow reconciliation.

**Output wrapper** (so Assembly can place each fragment correctly):

```html
<!-- @source: page-003.png#region-table-1 -->
<!-- @agent: table.md -->
<!-- @fragment: bottom-edge -->
<table>
  <caption>Quarterly results</caption>
  <thead><tr><th scope="col">…</th></tr></thead>
  <tbody>…</tbody>
</table>
<!-- @end-source -->
```

These comments travel with the fragment through Reconciliation, Assembly, and the review loop: they preserve provenance for the Reader and Copy Editor and let users re-run targeted fixes without re-processing the whole document.

**Amended (v1.1): provenance comments are stripped from the delivered HTML.** An earlier revision of this section required them to survive into the final document. They do not. The deliverable is a document handed to end users — often published as-is — and pipeline internals do not belong in it: every consumer would have to strip them, and `@source` references to page images are meaningless outside the session that produced them. Provenance is retained where it is actually useful, in the run log (`GET /v1/sessions/{id}/logs`), which records the agent, its pinned git SHA, and the source image for every fragment. Anything the *user* must see stays in the document: the `@unresolved` block (§7.11) is emitted as before.

**Initial agent set (v1)** — *all nine deleted; see the v1.2 amendment immediately below*:
- `paragraph.md`
- `heading.md`
- `list.md`
- `table.md`
- `formField.md`
- `image.md` (for embedded images requiring alt text)
- `quote.md`
- `caption.md`
- `footnote.md`

#### Amended (v1.2): one agent per *page*, plus specialists that earn their place

The nine files above have been **deleted**, and "one agent per content type" is withdrawn as the default shape. This is a decision about extraction, and it resolves the open question of whether the agent library is the product: it is, but the library is not the *type taxonomy*.

**Why the nine went.** They were not merely unused — they were **unreachable by construction**, through all three paths that can reach an agent file:

- *Dispatch* declines every name in the standard set before the file is ever looked up. That is deliberate (below), so it was not a bug to fix.
- *Training* only ever targets `page.md`; nothing routes feedback to a content agent.
- *Contribution* filters the same standard names, so none could be re-suggested either.

So no run could reach them by any path, and a fixture, a lesson or a prompt improvement could never accrue to one. Keeping nine prompt files that cannot run is worse than not having them: they read as the live extraction path to anyone opening `agents/`, and the PRD's §7.4 contract described a data flow (cropped-free regions, `@source` wrappers, reconciliation) that nothing executes.

**Why per-region fan-out is not coming back.** One vision call already sees the whole page, and *seeing the whole page is the capability*. Fanning one page out to nine specialists made each of them re-render the same page from the same image, which produced two representations of one thing — a `<form>` and a `<table>` for the same fields — and then required a reconciliation phase to remove a duplication the architecture had just created. Nine calls per page also multiplies the dominant latency and cost term by nine to get output a single call already produces.

**What the library is instead.** Specialization is justified where it handles content *better*, not where it partitions content by name:

- **The page agent** (`page.md`) is the general pass and the trainable core. It is a real agent file — versioned, fixture-gated, improvable by feedback — so the contribution story runs through the agent every session exercises, rather than through nine that no session touches.
- **Specialists** exist for content a whole-page pass demonstrably handles worse, and are dispatched by name and merged into the page (§7.4 dispatch). `chartDataAgent.md` is the shape: reading precise values off a chart's axes into a data table is a different task from transcribing a page, needs its own long contract, and would bloat the page prompt for the majority of pages that contain no chart. A `paragraph` specialist is not that shape — "wrap prose in `<p>`" is one line of the page prompt.

This is also the answer to the context concern that motivates specialization: the pressure is real, but it is per-*capability*, not per-content-type. Nine near-duplicate prompts do not relieve it; one page prompt plus a few deep specialists does, because each specialist's contract is loaded only for the pages that need it.

**The standard-type list survives as data, not as files.** `STANDARD` in `src/pipeline/contribute.ts` still names those nine types, and still drives both the dispatch decline and the new-agent filter. It was never a mirror of the library: it is the boundary of what one whole-page call covers, which is exactly the question a suggestion asks. Holding it as data rather than as a directory listing also keeps the decline independent of what is on disk — dropping a `table.md` into `agents/` does not start splicing a second rendering of a table over the page's own.

**The list is matched case- and whitespace-insensitively, through one shared pair of functions** (`logicalType` and `isStandardType`), because deleting the files removed the accident that had been covering for a loose match. A suggestion's name is free text a model wrote — prose describing a content type, not a filename, and `STANDARD` itself spells one entry `formField` — so `"Table"` and `"FormField"` are ordinary output. Previously `loadAgent` resolved `agents/Table.md` on a case-insensitive volume and the suggestion was dropped for the wrong reason; with the files gone, an exact-match filter would instead draft an agent and file a **public issue on the upstream repo under the user's own GitHub identity** (§12), proposing a specialist for a type the page pass has always handled. The two call sites also normalized separately once and disagreed about `"table.md "`, which is why there is now one function rather than two conventions.

**Consequences elsewhere in this document.** §6's diagram (a page fanned out to `table agent` / `formField agent` / `paragraph agent`) and §8.1's tree (which lists the deleted files) describe the withdrawn shape. §7.6 Reconciliation was the phase that existed to merge per-region fragments; with no fan-out there are no competing fragments to reconcile, which is why it is unimplemented rather than pending. The **Output wrapper** above (`@source` / `@agent` / `@fragment` comments) is likewise a per-region artifact: the page agent returns body content and provenance lives in the run log (v1.1 amendment above).

#### Amended (v1.2): the page agent is given the page's link targets, because the image cannot carry them

This document's premise is that a page is an **image** and extraction is a vision problem (§1, §7.4). For a PDF that premise silently loses one whole class of content: a link is an *annotation* laid over the page — a rectangle plus a URI — not something drawn on it. Rasterizing for the vision model keeps the ink and discards every target, so "read the full report" reaches the page agent as three words that happen to be blue, and there is nothing for it to build an `<a href>` out of. The output was a document whose text was faithful and whose every link was gone, which for a screen-reader user is worse than it sounds: the destination is not merely hidden, there is no indication a destination ever existed, and 2.4.4 ("Link Purpose") cannot be met by a document with no links in it.

**Uploaded PDFs therefore contribute more than pixels.** Alongside the per-page PNGs, the upload extracts each page's link annotations (URI + the text they sit on) and persists them with the session (`links.json`, §8.1); the extraction phase puts that list in the page-agent prompt as ground truth the image does not show. It is stated to the model asymmetrically, because that is what is true of it: **the URL is exact, the anchor text is approximate** — it comes from a text layer, so it can be split across lines, clipped by a rectangle that does not quite cover the phrase, or differ in spacing from what the image shows.

**Attaching them is the model's job; checking they arrived is not.** Deciding which text an annotation's rectangle covers, inside the structure the model chose to emit, is the same judgement the extraction itself is — a search-and-wrap over generated HTML would as happily wrap a heading, a table cell, or half an attribute value. But whether a target reached the output has an exact answer, so it is computed rather than asked: a page whose links did not all arrive is sent back through the **same self-correction pass as any other fidelity problem** (§7.5), told which URL is missing and shown the list again. This part cannot be delegated to the Feedback Agent, which verifies output against the *image* — the one place a link target does not appear, making a dropped link invisible to it and a fabricated one unfalsifiable.

**Three kinds of link are dropped on purpose**, and all of them are named in the log rather than left to be inferred:

- **Anything outside `http(s)` / `mailto` / `tel` / `ftp`.** A URI action is text the *file* controls and it ends up in a document handed to a browser, so `javascript:` and `data:` are script injection with extra steps. These are dropped, not sanitized: a link we cannot safely reproduce is not a link.
- **Any URL carrying a character that ends the attribute it is written into** — a quote, `<`, `>`, whitespace, a control character. The scheme allowlist alone does not hold here: poppler escapes a quote inside a URI action rather than truncating the URL, so `https://ok.example/a" onmouseover="…` arrives intact under an allowlisted scheme, and the model is told to reproduce each URL exactly. No legitimate URL carries these unencoded, so rejecting them costs nothing real and holds whether or not a given poppler build escapes them and whether or not the model obeys "exactly".
- **Destinations inside the same document** (a PDF "go to page 12"). The page they point at is already in the delivered HTML, so this is not lost content in the way an external URL is, and the in-document anchors the page agent *can* see (footnotes) are already built and namespaced at assembly (§7.4 v1.2 anchors).

A link over an image with no text beneath it has nothing to attach to, and is lost.

**A link is additive, and it is never paid for with the page's structure.** Before this amendment the self-correction pass ran only on output the Feedback Agent had already judged bad, so its rewrite could only be an improvement on something known to be broken. A link miss changes that: it sends back a page that may have *passed*. So when the fidelity check passed and the only problem is a missing link, the correction is verified in turn, and a rewrite that lost something — a heading level, a `<th scope>` — is discarded in favour of the fragment that passed (`page_links_correction_rejected`). Recovering a target must not cost a page the accessibility it already had; that would make the document worse than it was before any of this existed. The `page_verify_ok` / `page_verify_failed` events keep reporting the Feedback Agent's verdict and only that, so a missing link does not turn a page that passed into one that failed in the log.

**The review loop is where a surviving link is most quietly at risk.** The Copy Editor rewrites the whole body from the HTML plus the source images (§7.9), and an `href` is the one piece of content in neither: not in the text it is editing, not in the image it is checking against. So it is told that a target is content it cannot recover — carry every one through, change link *text* freely where 2.4.4 calls for it — and a round that loses one is logged (`editor_links_dropped`). Logged rather than repaired: re-inserting a link into a document the editor has just restructured is the string-substitution this amendment declines to do at extraction time, for the same reason.

**Accessibility requirements that every agent must satisfy**:
- Semantic HTML elements only (no `<div>` where `<section>`, `<nav>`, `<article>`, `<aside>`, `<header>`, `<footer>` apply).
- Headings used in correct nesting order.
- Tables have `<caption>`, `<thead>`, `<th scope>`, and association attributes where required.
- Form fields have programmatically associated labels; required fields are marked accessibly; error messaging hooks present.
- Images have meaningful `alt` text or `alt=""` if decorative, justified in the fragment log.
- Lists use `<ul>`/`<ol>`/`<dl>` rather than visual list-likes.
- Language attributes are set when language changes are detected.
- No reliance on color alone; no inline event handlers; no styling.

### 7.5 Builder Agent

**Purpose**: When the orchestrator encounters a content type with no matching agent file, the Builder Agent creates one.

**Behavior**:
- Reads the notes file references to the new content type and the source image.
- Drafts a new agent markdown file matching the content agent contract (§7.4).
- Saves the draft to the session's `tmp/<session-id>/agents/<type>.md`. This location is ephemeral — it exists only for the duration of the session and is deleted on close (see §8.2 for lifecycle).
- Logs the creation to `runs/<run-id>/new-agents.md` with a summary of what the new agent does, why it was created, and the image region that triggered it. *(v1.2: this file is not written — see §8.1 v1.2. The creation is logged to `log.jsonl` with the draft's content inline, and the summary of what it does and why goes in the filed issue.)*
- The orchestrator then calls the new agent for the current image and any subsequent images in the same session that reference the same type.

**Lifecycle of session-built agents**:
- A session-built agent has effect only inside the session in which it was built.
- At end of session, the user decides per agent: submit upstream as a PR, or dismiss.
- There is no local-keep option. The agent either becomes a candidate for upstream review or it goes away when `tmp/` is cleared.
- If the upstream maintainer merges the PR, the agent becomes available to the user (and everyone else) the next time they pull the upstream repo. This is the only path by which a session-built agent persists.

**Why no local persistence**:
- Auto-promotion based on "no one complained" is the wrong trust signal for accessibility tooling — many accessibility failures are silent for sighted reviewers.
- Allowing untrusted local agents to accumulate would also fragment the shared agent library and undermine the framework goal in §3.
- Forcing every persistent agent through upstream review keeps the trust floor at one well-understood place.

### 7.6 Reconciliation Agent

**Purpose**: Resolve fragments that span image boundaries before assembly.

**Behavior**:
- Reads all fragment log entries.
- For each adjacent image pair, identifies fragments on the bottom edge of image N that may match fragments on the top edge of image N+1.
- Conservative by default: a stitch only happens when content type matches AND textual or structural similarity at the edges meets a high threshold. A false stitch is silently wrong (the Reader sees a coherent-looking document with no obvious tell); a missed stitch is visibly two adjacent blocks that the Reader can flag. The asymmetry of failure modes favors caution.
- For each high-confidence match, requests both source images and proposes a joined HTML fragment.
- Joined fragments replace the original two fragments and gain a `@reconciled` comment marker:

```html
<!-- @reconciled: page-003.png+page-004.png -->
<!-- @agent: paragraph.md (reconciled) -->
<p>…full paragraph text…</p>
<!-- @end-source -->
```

- Low-confidence candidates are left as separate blocks with a `@suspected-continuation` comment so the Reader is alerted but the document does not silently fabricate joined content.
- Unmatched fragments remain as-is and are flagged for the Reader Agent's attention.

**Note (v1.2): half of this section's premise is gone, and the remaining half is still open.** Not implemented, and the reason splits in two:

- **Within a page, there is nothing to reconcile.** The per-region fan-out this phase was designed to clean up after does not exist (§7.4 v1.2): one page yields one fragment from one agent, so there are never two fragments competing to represent the same content. The `@agent: paragraph.md (reconciled)` example above refers to a deleted agent.
- **Across pages, the problem is real and unsolved.** A paragraph, table or list genuinely can span a page boundary, and the page agent notes a cut-off edge in its fragment log rather than joining anything. So the document can still contain two adjacent blocks that were one block in the source. What is withdrawn is the *mechanism* above (edge-matching over per-region fragments with `@`-comment markers), not the requirement. A page-level design would compare the tail of page N's fragment with the head of page N+1's, and the conservatism argument above — a false stitch is silently wrong, a missed stitch is visible to the Reader — carries over unchanged and is the reason not to approximate it.

### 7.7 Assembly

**Purpose**: Combine all fragments into one HTML document in image order.

**Behavior**:
- Wraps the content in a minimal accessible document shell: `<html lang>`, `<head>` with `<title>`, `<body>` with `<main>`.
- Strips the `@source`, `@agent`, `@fragment`, and `@reconciled` provenance comments — they served the pipeline up to this point and are not part of the deliverable (see the v1.1 amendment in §7.4). Provenance is recorded in the run log instead.
- Validates the document parses and basic accessibility lint passes (axe-core in headless mode).
- Lint failures are surfaced to the Reader as input.

#### Amended (v1.2): colliding ids are namespaced as the fragments are joined

This section said "combine all fragments in image order" and left it there, which is right about the text and wrong about the ids. **An id is a claim about the whole document, and no page is in a position to make it.** Extraction is per page and concurrent (§7.4 v1.2): a page sees one image and nothing of what any other page emitted. §7.4's page prompt then asks for ids by name — footnote markers as `<sup><a href="#fn-N" id="fnref-N">` with the body at the foot of the page and *"preserve the original numbering"* — so a three-page scan whose pages each carry a footnote 1 emits three `id="fn-1"`, which is the ordinary case rather than an edge one.

Concatenation makes that a navigation defect: every `href="#fn-1"` resolves to the first, so a screen-reader user following the reference on page 3 lands on page 1's note and the back-reference returns them to the wrong paragraph. Nothing about it looks wrong — both notes exist, both are announced, the link works — and the lint gate passed it, because WCAG 2.2 dropped 4.1.1 and axe therefore tags `duplicate-id` obsolete and excludes it from the tag filter this section's lint step uses (`duplicate-id-aria`, which is current, fires only for ids referenced from ARIA attributes, not from an `href`).

So assembly prefixes the colliding ids with their page number (`fn-1` → `p3-fn-1`), and assembly is the only place that can: a page cannot know what another page did, and this is the first moment the whole document exists.

**The scope is one id at a time, not one page at a time**, and that distinction is the whole correctness argument. Prefixing *every* id on a page — the obvious reading of "namespace per page" — fixes the collisions and breaks every reference that legitimately spans a page break:

- a `<label for="q1">` on one page whose `<input id="q1">` falls on the next, which axe reports as a real `label` violation;
- endnotes with continuous numbering, where the markers are in the body and the notes are collected at the back — the normal shape for a scanned report, and one where nothing collides at all. Both directions break, including the back-reference on the page that *does* own the note.

Those references resolved correctly before assembly touched them, so renaming one end of the pair is the assembler introducing a 1.3.1/4.1.2 failure into content that was correct when the page produced it. **Trading a wrong-target reference for a no-target one is not a fix.** Renaming only what actually collides makes the ordinary document a no-op and is the honest scope: a unique id needs nothing done to it, and a colliding one has no correct cross-page interpretation to preserve.

Four properties then make the rewrite safe rather than merely unique:

- **Everything that points at a renamed id is rewritten with it, in the same pass** — `href="#…"`, and also `for`, `headers`, `list`, `form` and the `aria-*` references. Unique ids with stale references are the failure described above.
- **Every reference to a colliding id is repointed, never abandoned.** A reference to a *non*-colliding id is untouched, which is what keeps the split form and the endnotes working. A reference to a colliding id the page **owns** goes to the page's own copy: reference and target were written together by one agent looking at one image, so no other page's copy can have been meant. A reference to a colliding id the page does *not* own is genuinely ambiguous, and goes to the **first page in document order that claims the id** — which is where a browser sent the bare reference before any of this ran.

  Leaving that last case as written was the first answer and it was wrong, in exactly the direction the previous paragraph warns about. Take a form whose `<label for="q1">` is on page 1 while pages 2 *and* 3 each carry an `<input id="q1">`. Now `q1` collides, every owner is renamed, and page 1's label — which named the right control before assembly touched anything — points at an id no element has. The field loses its accessible name and axe reports `label` on a document a plain concatenation passed. First-owner is arbitrary between the owners, but it is *exactly as* arbitrary as the behaviour it replaces, and it keeps the association rather than destroying it. Every such reference is still named in the run log (`assembly_anchors`), because a reference disambiguated by document order rather than by the agent that wrote it deserves an eye.
- **The prefix is labelled with the page's `order`, not its position in the arrival array**, so the ids in a delivered document are stable across runs of the same input and match the page numbers the Reader attributes issues to. But `order` is an *input*, and it is the one input that would silently defeat the whole mechanism: two fragments sharing an `order` would take the same prefix, their colliding ids would stay collided, and the run log would report the id as namespaced. So ownership is tracked per fragment position — unique by construction — and a repeated label is disambiguated (`p1-`, then `p1_2-`) rather than trusted.
- **The prefix is reserved against every id the document already claims**, or the rename manufactures the collision it exists to remove — silently, since the reference it breaks is one the page owns and is therefore not ambiguous. `p1-total`, `p2-name` and the like are what a paginated form or worksheet emits, and the page agent has no idea the assembler reserves that shape. Given `id="x"` on pages 1 and 2 plus a working `<label for="p1-x">`/`<input id="p1-x">` pair on page 2, prefixing turns page 1's `x` into `p1-x`, two elements own it, and page 2's label resolves to page 1's `<p>` — not a labelable element, so the field loses its accessible name. The separator is therefore grown (`p1-` → `p1--` → …) until no page claims anything starting with it; the ordinary document keeps the short form.
- **A page whose markup would not survive a reserialization is left exactly as its agent wrote it**, with its collision intact. Two things count as not surviving, and both are foster parenting — the same parser behaviour, in its two directions. A `<tr>` outside a `<table>` is **dropped**: the row and cell vanish, only their text survives, no error raised. Content *inside* a `<table>` is **moved**: a `<p>` is hoisted out to before the table, and bare prose — "Continued from page 1", say — out past the whole table, so content that sat with the rows is delivered away from them. That is a reading-order change, which is worse than the duplicate id being fixed. Both are plausible emissions for a table continuing across a page break, which is also the scenario that produces these collisions. The guard therefore compares the source's sequence of tags *and text* against the parsed document as a *subsequence*, not as counts and not as tags alone: counting cannot see a move, an equality check would refuse every page where the parser legitimately adds a tag (`<tbody>`, or the adoption agency algorithm duplicating one to repair misnesting), and a tag-only sequence misses text moving on its own, since foster-parented prose leaves every tag present and in order. Keeping a duplicate id that lint will report is strictly better than either silently dropping a table row or silently reordering content. Such a page keeps its *bare* ids, so a reference resolved to it by document order stays bare too — and the mirror holds as well: if a skipped page *refers* to a colliding id, that id's **first owner** keeps its bare form, since a reference frozen in place can only find a bare id. Only the first owner is pinned, so the remaining owners are still renamed and the duplicate is still fixed for everything else in the document; pinning the whole id would abandon the collision on account of one unrewritable page. And nothing is pinned at all when one of that id's **owners** was itself skipped — a skipped owner is delivered as written, so it is *already* keeping the bare id the frozen reference needs, and pinning a second copy on top of it would ship the duplicate id this exists to remove. A page too deeply **nested** to rewrite reaches the same delivered-as-written outcome by a different route, and gets the same treatment, with its ids and references read from its **own DOM**, which it keeps rather than discards: `querySelectorAll` does not recurse, so it works at any depth the parse survived and the reading is exact, and only a page whose *parse* threw is left with a source scan. It counts as an owner, so its copy of a colliding id is not silently uncounted and the pin does not fire on top of the bare id it is already keeping, and its own frozen references pin their first owner exactly as a guard-skipped page's do. The nesting limit is a fixed 500 levels, measured on the *parsed tree* rather than estimated from the source, and it is a chosen number rather than a natural threshold because there is no single natural one: rewriting a page recurses per level of nesting in three places — jsdom's serializer, its `window.close()`, and the reserialization guard's own tree walk — and they do not give up at the same depth. Measured, serialization and `close()` overflow from around 4,000 levels while the parse itself survives past 10,000, so the band between them *parsed* and then threw out of the rewrite, while a *deeper* page whose parse failed cleanly was delivered fine — worse behaviour from shallower input, and every threshold moving with how much stack the caller had already used. One limit far below all of them makes the boundary a real one. Real documents are nowhere near it, and refusing a page that did not need refusing costs only a duplicate id — which lint reports up to the point where axe itself overflows, a few thousand levels in. Past that the gate degrades to `ok: true` with an `error`, so the honest statement of the trade is that at pathological depth the duplicate id ships **unreported by lint**; the `assembly` event therefore logs `lint_error`, since a gate that could not run must be distinguishable in the log from a gate that found nothing. The depth is measured rather than estimated because the source cannot be counted: a version that counted unclosed start tags was counting neither depth nor anything useful, since void elements and implied end tags never bring the count down — a 120-row table written `<tr><td>a<td>b` (real depth 4) and a page of 600 `<br>` (real depth 1) were both refused, so ordinary page-agent output shipped the duplicate id this exists to remove. Estimating from source means modelling the parser's implied-end-tag and void-element rules; parsing first and walking the tree needs no model, and the parse is the one step that survives to roughly twice the depth the others do. Because such a page is then delivered *as written*, its nesting reaches every module downstream of the decision, and two of them had to be taught to survive it. The lint gate's own `window.close()` is one of the recursive steps, so that cleanup is allowed to fail without failing the run — a throw from a `finally` would otherwise replace the gate's graceful degradation and end the session one module after the decision to deliver was made. The flattened screen-reader view (§7.8) recurses per level as well, in both halves of its inline/block split, and it threw where the whole point of the function is to lose no text; it now falls back to an iterative pass that keeps words and order and gives up structure, and closes its own jsdom under the same allowed-to-fail rule. The remaining source scan — used only for a page whose parse threw outright — follows the parser's rules rather than approximating them — attributes only from real tag positions, elements whose content is not markup (`<textarea>`, `<script>`, `<template>` and the rest) skipped, character references decoded, first value of a repeated attribute — because on the id side a **phantom** owner is worse than a missed one: an `id` read out of non-markup text makes the page an owner, which suppresses the pin, renames the real owner, and leaves a `<label for>` elsewhere naming nothing (1.3.1/4.1.2) on an id that never collided. On the reference side the asymmetry is reversed — a phantom reference only pins an owner that did not need pinning — so the scan is measured against jsdom in both directions, shape by shape. Reading the tree, rather than modelling still more of the parser, is what finally closed that class: a scan of source positions cannot see tree *construction*, so it invented owners for markup the parser drops outright (an orphan `<tr>`/`<td>`, a stray `<caption>`/`<col>`/`<thead>`/`<tbody>`, anything following `<plaintext>` — the first of which a transcription starting mid-table emits directly) and missed real references inside a `<select>`, whose `<option>` and `<optgroup>` children survive parsing even though most tags in there do not. Each successive round of that work fixed one modelled rule and left the next, which is the argument for using the parser's own output where it is available at all. A pinned id is disclosed in the run log as `pinned_ids`, alongside `collisions` and `skipped_pages` and for the same reason: `collisions` on its own reads as "these were namespaced", which a pin makes false on purpose, so without the second list a bare colliding id in the delivered document is indistinguishable from the namespacing having silently failed.

The lint step is the backstop rather than the fix — the review loop re-lints after the Copy Editor has rewritten the whole body, and that is a model rewrite that can reintroduce a collision assembly had already resolved — and covering duplicate ids there takes three separate things, because axe splits the check across three rules by what the element *is*, each skipping the others' elements:

- `duplicate-id` (elements nothing references and nothing focuses) and `duplicate-id-active` (focusable ones) are both tagged obsolete, so the tag filter excludes them and each is re-enabled by name.
- `duplicate-id-aria` covers ids that something actually *references*, is still live WCAG 4.1.2, and arrives via the tag filter — but axe marks it `reviewOnFail`, so its findings land in `incomplete` rather than `violations`. That made the case with the clearest user harm the one the gate could not see: two `<input id="q1">` under one `<label for="q1">` returned zero violations even with both obsolete rules enabled. A duplicate id needs no human judgement to confirm, so this rule's incomplete results are promoted to violations. Only this rule — the rest of `incomplete` is genuinely undecidable without rendering.

### 7.8 Reader Agent

**Purpose**: Review the assembled HTML for reading-order issues, semantic inconsistencies, and missed accessibility requirements.

**Behavior**:
- Receives the HTML in chunks sized to fit comfortably under the model's context limit (target ~30% of context per chunk, with overlap between chunks).
- For each chunk receives **two views**:
  1. The HTML chunk itself (the structural reference).
  2. A flattened text-only view of the same chunk that simulates what a screen reader would announce, in order.
- Does **not** receive source images directly; it reads the document the way a screen reader user would consume it. Image access is reserved for the Copy Editor.
- Cross-checks the two views: reading-order issues are most visible in the flattened view, structural issues in the HTML, and the two together let the Reader identify when an out-of-order announcement is the symptom of a structural problem (e.g., flattened view says "Heading: Results" before "Heading: Methods" → HTML shows nesting that produces that order → flag both).
- Also cross-checks against the orchestrator's `no-content` signals from §7.3 and the `@suspected-continuation` markers from §7.6 to catch likely Image Analysis or Reconciliation misses.
- Flags issues with the `@source` reference of the offending block so the Copy Editor can fetch the right image.

**Issue format**:

```json
{
  "issue": "Heading level skipped — H2 follows H4",
  "source": "page-005.png#region-heading-2",
  "severity": "high",
  "suggested_action": "review heading hierarchy across surrounding blocks"
}
```

- If no issues remain, document is returned to user.
- If issues exist, they pass to the Copy Editor.

**Amended (v1.1): source attribution is by page number, not by `@source` region reference.** The `@source` region ids this section assumed are a product of the per-region fan-out that §7.4's v1.1 amendment stripped from the deliverable and that extraction no longer produces — there are no region ids to reference. Attribution is still required, because it is what lets the Copy Editor fetch the right image (§7.9); it is expressed as the source **pages** an issue appears on:

```json
{
  "issue": "Heading level skipped — H2 follows H4",
  "pages": [5],
  "severity": "high",
  "suggested_action": "review heading hierarchy across surrounding blocks"
}
```

The Reader is given an index of the document's pages (page number + an excerpt of the HTML extracted from each) and matches offending content against it. It is instructed to name only pages it has evidence for and to return an empty list rather than guess, so `pages` may be empty — see §7.9 for what that means downstream.

### 7.9 Copy Editor Agent

**Purpose**: Given a flagged HTML block plus its source image, propose a corrected HTML block.

**Behavior**:
- Inputs: the problem block(s), the relevant source image(s), the issue list, the surrounding HTML (for context, read-only).
- Output: proposed replacement HTML for each flagged block. Does not modify the document directly.

**Amended (v1.1): "the relevant source image(s)" is enforced, and is the pages the Reader attributed the issues to (§7.8 v1.1).** Sending the whole document's images is the naive reading of this section and is the dominant per-round cost of the review loop — every page's image, re-uploaded on every one of up to `max_review_iterations` rounds. When every issue in a round is attributed, the editor receives only the union of those pages.

Narrowing requires *full* attribution: if any issue in the round could not be attributed, every image is attached. That is the expensive direction on purpose. An unattributed issue is usually structural (duplication, reading order, heading levels) and correctable from the HTML alone — but it is also what an editor-rewritten body looks like once it has drifted too far from the source excerpts to match, and that drift is worst in the late rounds where the iteration budget is thinnest. Narrowing wrongly can leave an issue at the cap having never been shown its own page; broadening wrongly costs no more than the unoptimized behavior this replaces.

### 7.10 Assembler Agent

**Purpose**: Apply the Copy Editor's proposed changes to the document.

**Behavior**:
- Replaces flagged blocks with proposed blocks.
- Preserves in-pipeline provenance comments (updates `@agent` to reflect the copy-edit pass); these are stripped from the delivered document per the v1.1 amendment in §7.4.
- Re-runs axe-core lint.
- Passes the document back to the Reader for re-verification.

### 7.11 Review Loop

- Default `max_review_iterations = 3`.
- Each iteration: Reader → Copy Editor → Assembler → Reader.
- Loop exits when Reader returns no issues, or when iteration cap is reached.
- If iteration cap is reached with issues remaining, the document is still returned but with an `@unresolved` block at the end listing remaining issues and their source references (the attributed page numbers — see §7.8 v1.1 — where the Reader could attribute them).

### 7.12 User Feedback Re-Run

- After the document is returned, the user may submit free-text feedback.
- A new run is initiated with the feedback injected as a top-level instruction passed to the Image Analysis Agent and made available to every downstream agent in the run.
- Feedback re-runs are logged separately and can be reverted to the prior output.

**Amended (v1.1): a feedback re-run is routed by scope rather than always re-running every phase.** A re-run builds on the prior run's saved state so rounds converge instead of regenerating the document from scratch. The Feedback Agent classifies the feedback first (logged as `feedback_scoped`):

- **Document-scoped** feedback (tone, wording, ordering, an accessibility rule) re-runs the review loop over the saved body. The source images are not revisited.
- **Extraction-scoped** feedback — something misread, missed, or mis-structured relative to a source page — sends *only the affected pages* back to the page agent with their source image and their previous output attached; the document is then reassembled and reviewed. Pages the feedback does not concern keep their prior fragments unchanged.

This preserves the intent above (feedback reaches the agent that reads the images) while making a re-run proportional to what was actually wrong. Routing is biased toward the document path: feedback that cannot be localized to specific pages, or that spans more than half the document, is treated as document-scoped.

**Amended (v1.2): when a re-run proposes an agent update, the eval gate is a *paired* comparison, fixture by fixture.** Feedback that generalizes past its own document becomes a proposed agent update, and it is only filed (§7.13 v1.2) if the candidate prompt holds or improves on the current one over that agent's stored fixtures. Two rules define that comparison, and they are separate:

- **What a score means.** A fixture whose accepted text is too short to measure abstains — it is absent from the scores rather than scored 0, because no evidence is not a failure. A prompt that produces *no output at all* is the exception: that scores 0, since producing nothing is a failure on the fixture, and abstaining would let it tie a prompt that handled the page.
- **What the mean is taken over.** Only fixtures **both** prompts have a score for. Whether a prompt produced output is a property of *that prompt*, so the two sides can end up measuring different fixture sets — and averaging each over whatever it happened to measure moves the threshold instead of comparing prompts. Concretely: a current prompt that flakes to no output on one fixture (0) and scores 0.98 on another averages 0.49, so a candidate at 0.88 — a real 0.10 regression — clears both this gate and the coverage floor. Pairing drops such a fixture from both means.

A current-prompt flake is therefore evidence for neither side. It is a defect in the library agent, and lowering the bar is the one response that would hide both it and any regression behind it; it is logged instead, in the gate's `unpaired` list. If no fixture is measurable on both sides, there is no comparison to make: the update defers to the coverage gate rather than passing on an unmeasured claim.

### 7.13 GitHub PR Workflow for Agent Contributions

**This is the only path by which any agent ever becomes available outside the session it was created in.** No agent persists locally except by way of upstream merge plus a subsequent `git pull`.

The workflow is automatic on session close:

- When the user closes a session (signalling acceptance of the HTML), the system opens a PR for every session-built agent and every proposed update to an existing agent that was generated during the session.
- There is no per-contribution accept/dismiss step in v1. The premise: if the user is willing to accept the HTML, the agents and updates that produced it are worth review upstream. The upstream maintainer is the gatekeeper of merge.
- The user can preview what will be PR'd by inspecting the session detail response (`GET /v1/sessions/{id}`) before closing.

**Per-PR behavior**:

- *New session-built agents* are PR'd on a branch named `new-agent/<type>-<short-hash>`. The PR includes the agent file plus test fixtures (input image, produced output, accessibility lint pass) and a templated description (what content type, why existing agents didn't cover it, sample output).
- *Updates to existing agents* are PR'd on a branch named `agent-update/<agent-name>-<short-hash>`. The PR includes the diff, the session log excerpt that motivated the change, and before/after test fixtures.

**Auth and configuration**:

- The user's GitHub credential is the same credential they authenticated with (see §9.1). This section's premise — that authenticating grants `repo`, so every authenticated user can push — no longer holds in any form: **no scope is requested, and none can be.** Iris is a GitHub App, and its permissions come from its installation, which grants `issues: write` and nothing else (§9.1 "What the token grants"). Nothing in this section is implemented, so the write access it assumes is not held; a deployment that later builds this flow has to add `contents: write` and `pull_requests: write` to the app's installation deliberately.
- The upstream repository is determined by the service's `agents/` git checkout — its `origin` remote is the PR target. This is a per-deployment setting, not a per-user one.
- PRs are opened from the user's fork of the upstream. The service creates the fork on the user's account on first close, if it does not already exist.
- All PR activity is logged in the session record. Closing or rejecting a PR upstream does not affect the produced HTML — the HTML has already been generated using the session-built agent recorded inline in `log.jsonl`.

**Opt-out**:

- A user who does not want to contribute the agents from a given session can pass `?skip_prs=true` to `/close`. The HTML is finalized and the session-built agents are discarded without PRs being opened.

**Amended: contributions are issues filed during the run, and there is no opt-out.** This section is superseded in its mechanism *and* in its "Opt-out" clause. What ships:

- **Issues, not PRs.** When the extractor meets content a specialist agent would handle better, the drafted agent is filed on `upstream_repo` as an issue titled `New agent suggestion: <type>`, carrying the agent code and context; feedback that generalizes past its own document is filed as `Agent update proposal: <agent>` with the diff, once it has passed the agent's regression fixtures. Nothing forks, nothing pushes, no branch is created. Simpler for a maintainer to triage, and it needs no write access to a fork. **The title prefix is the issue's identity** — see the amendment at the end of this section for why it is not a label.
- **Filed during the run, not on `/close`.** Contribution is a side effect of the phase that produced it, so it does not depend on a client reaching the close endpoint.
- **Filed under the user's own GitHub identity**, which is the point rather than an implementation choice (§12) — the user's token is required on every call precisely so that this can happen, and the credit for the contribution is theirs.
- **No `skip_prs`, and no equivalent.** The opt-out above is withdrawn deliberately, not dropped for lack of time: an opt-out is exactly the mode §12 exists to prevent, since it lets a session take from the agent library without refilling it. There is no request parameter, config key or account setting that disables filing. There is no back door through the credential either: a user's authorization carries no repository permission to withhold, since filing comes from the app's installation (§9.1 "What the token grants").
- **Failure is soft in one direction only.** A GitHub outage or a permissions problem is logged as `agent_issue_failed` (with a diagnostic `hint` when the failure looks like a permissions problem — usually the app not being installed on `upstream_repo`) and never fails a document the user has already paid for. That is a failure-handling property, not an opt-out.
- Consequently the `pending_prs` and `prs_opened` response fields (§9.2) and the `skip_prs` parameter are not part of the API. `github.issue_token` is an optional service-account override for *who authors* the issues, documented as not recommended (§12).

The framing sentence at the top of this section still holds, with "upstream merge" reached by issue rather than by PR: an agent becomes available outside its session only via upstream merge plus a subsequent `git pull`.

**Amended: the issues carry no label, and their TITLE PREFIX is their identity.** An earlier revision labeled them `iris-agent-suggestion` and `iris-agent-update`, and read-or-created the label before each filing. Both are gone. The labels could not survive contact with the users this section is about.

GitHub documents that "any user with pull access to a repository can create an issue" — so filing itself works for any authenticated user, and §12's model is sound — but also that "only users with push access can set labels for new issues. Labels are silently dropped otherwise." Every ordinary contributor is in the second group. Filing returned `201`, the issue appeared under the user's own name, and the label was discarded with nothing in the response to say so.

That made both purposes of the label fail silently, and only for the majority:

| | With labels | Without |
| --- | --- | --- |
| Maintainer triage | `label:iris-agent-suggestion` — misses every issue filed by a non-collaborator | search the title prefix, or apply labels with a repo-side rule keyed on it |
| Dedupe | filtered on the label, so it could never match an unlabeled issue: **every later session refiled the same suggestion, under a different real person's name** | exact-title comparison over an `in:title` search — behaves the same for every filer |
| Pre-filing calls | `getLabel` then `createLabel`, both needing push access, both swallowed | none |

A title prefix is set by the same request that creates the issue and cannot be stripped by permissions, so it behaves identically for a maintainer and a first-time contributor. The exact-title comparison after the search is therefore load-bearing rather than defensive: GitHub's `in:title` is a full-text phrase match, not an equality test, so the search returns a superset and the comparison decides. A maintainer who wants labels can add them with a repository rule keyed on the prefix — applied as the repository rather than as the filer, so it works regardless of who filed.

This is a deliberate removal of a signal, so it is worth stating what was lost: nothing that worked for the users §12 is about. The labels worked only for people who could already have labeled the issue by hand.

### 7.14 Automated Code Review (v1.2)

**§7.13 makes upstream review the gatekeeper for every agent that ever runs, and §1 says so in the Overview. That is a promise about review capacity, and this section is how it is kept.** A three-institution maintainership (§12) with no full-time reviewer cannot be the only thing standing between a contributed prompt and every future session, so each PR is reviewed by Claude in CI before a human reads it. This is not developer convenience tooling; it is load-bearing for the contribution model, which is why it belongs in Detailed Requirements rather than in §10.

Implemented as a single workflow, `.github/workflows/code-review.yml`, on `pull_request` (`opened`, `synchronize`, `ready_for_review`) plus `workflow_dispatch` for manual re-runs.

**What is in scope.** `paths-ignore` skips only files that cannot affect behaviour (`LICENSE`, the code of conduct, issue and PR templates). Two categories deliberately stay in scope and must not be added to that list:

- **`agents/*.md`.** Agent markdown files are executable prompts, loaded at runtime and sent to the model (§7.4). A change to `page.md` changes what every session produces. Treating them as documentation would exempt the most consequential files in the repo from review.
- **`docs/**` and `prd.md`.** The API docs are part of the contract (§9), so a docs change that contradicts the code is a real defect.

**The job runs the checks itself and hands the model their output.** Before the model is invoked, one step runs `npm ci`, `tsc --noEmit`, the unit suite, `./test/e2e.sh`, and `actionlint` (version-pinned, and its download verified against a recorded SHA-256 — an unverified linter installer would be a supply-chain path into a job holding `id-token: write`), then assembles a context file: PR metadata, a "Check summary" of those five results, the full diff, and the full source of files that are new or substantially rewritten. The model reads that file first and is told not to re-run the checks. This exists so the reviewer reasons about *measured* results rather than predicted ones — a claim that a test fails is either quoted from the summary or it is not made.

**Severity is decided by reachability, not by category.** The reviewer has a ranked list of what to *look at* — accessibility correctness of the output (§7.7), upstream side effects and filing identity (§7.13), auth and tokens (§9.1), provider routing and cost (§10.3), general correctness, failing checks, missing tests, the PR's own template contract, and — conditionally, ahead of all of them — CI and workflow security when the diff touches `.github/workflows/**`. That list does not determine the verdict. Blocking requires that a real user, a real request, or CI reach the defect on input the code accepts today; a defect that is real and correctly reasoned but unreachable is posted as a note on an **approval**, stating what would have to change to reach it. Each blocking finding must name the input that reaches it, and a review whose every finding is latent is required to be an approval.

The bar exists because the failure mode observed in practice was not false findings — the findings were reproduced, measured and specific — but **severity flattening**: every finding arriving as blocking regardless of whether anything reached it. Measured across every model-authored review before the bar was introduced, they ran 34 `CHANGES_REQUESTED` to 17 `APPROVED`, with individual PRs at 12-to-1 (#49), 5-to-1 (#56) and 3-to-0 (#44) — including reviews that stated in their own text that a finding was latent and requested changes anyway. `main` carried no branch protection at the time, so the cost was never blocked merges; it was author attention, and a reviewer that always requests changes teaches authors to discount the one time it matters. Three exceptions stay blocking even when unreachable, because their whole value is holding when something else breaks: auth/token/secret handling, publishing under the wrong identity (§7.13), and path handling that could escape the data dir (§8.1).

**Depth is explicitly not the tuning axis.** Review latency is accepted. The model gets ~19 minutes of wall clock (a 22-minute step cap minus dependency install) and is instructed to investigate exactly as hard as before — the bar governs the verdict attached to a finding, not how far the reviewer digs. Findings are appended to a scratch file as they are confirmed, so an interrupted review still delivers what it found: if the model step times out, a fallback step posts those partial findings plus the check summary as a `--request-changes` review, because an incomplete review must not read as a pass. A final step fails the job if no review exists for the head sha at all, since the action can exit 0 without ever posting.

**A re-review sees its own earlier reviews.** Up to the 3 most recent prior reviews on *other* commits of the same PR (each body capped) are included in the context, and the reviewer is told to read them before the diff. Reviews on the current sha are excluded — a per-commit guard means one already exists only in a race, and feeding the model its own verdict for the commit under review invites it to restate it. Both bounds are calibrated against a ~131KB context that has already caused one timeout (PR #38), so raising either trades review depth for review memory.

**The CI workflows are in scope as product, not as tooling.** `.github/workflows/code-review.yml` is what this section's promise is made of, `issue-to-pr.yml` opens pull requests on a schedule under §7.15, and both hold `id-token: write` and the Bedrock role; every other workflow in the directory holds a secret, a token, or write access to something. A defect in one is reachable by construction — CI runs it — so the reachability bar above softens nothing here, and a diff touching `.github/workflows/**` or `.github/actions/**` is reviewed against a CI-security checklist taken *before* the accessibility list: PR-authored code reaching secrets, `${{ }}` interpolated into `run:`, widened `permissions:` or a changed OIDC role, secret exposure and unpinned third-party actions, lost review coverage (a weakened verify step, a broadened skip condition, a `paths-ignore` entry that starts excluding behaviour), §7.15's path allowlist being narrowed, the shell failure modes this repo has actually shipped (SIGPIPE under `pipefail`, `set -u` against a variable absent from that step's `env:`, an Actions escape that becomes a bash parameter expansion), and the timeout arithmetic. Each changed workflow is read in full against its default-branch copy rather than as hunks, and stale rationale comments count as defects because those comments are the documentation for a security control.

**Reviewing changes to `code-review.yml` needs one deliberate exception.** `claude-code-action` exchanges its OIDC token for a Claude App token, and that exchange fails with `workflow_not_found_on_default_branch` while the invoking workflow file differs from the default-branch copy; the action treats that as a reason to skip itself, so **a PR modifying `code-review.yml` used to get no automated review at all** while every other check went green. Supplying the action an explicit `github_token` short-circuits the exchange before it is attempted, so the job passes `GITHUB_TOKEN` on exactly those PRs and nothing else. The review then runs and posts as `github-actions[bot]` rather than `claude[bot]` — the per-commit idempotency guard counts both identities for that reason, while still excluding the timeout fallback's own body so that dispatching a re-run over a fallback is not a no-op. The earlier attempt at this gap is why the narrow fix is preferred: between PR #43 and PR #63 a second workflow ran on `pull_request_target` to get the default branch's definition, produced no model-written review in six runs, and was the repo's only PR-triggered job holding secrets, so it was deleted. The identity switch is disclosed on the PR in a step summary, an Actions warning and a comment, which also ask for a human read of the workflow diff — the reviewer here is the file that decides whether anything is reviewed.

**Fork PRs are skipped by design.** The reviewer reaches its model through the repository's own Bedrock role, assumed via OIDC — CI infrastructure, unrelated to the `ModelProvider` configuration a deployment uses (§10.3). A `pull_request` from a fork receives no secrets, so that role assumption would fail with a confusing error. A maintainer reviews a fork PR with `gh workflow run code-review.yml -f pr_number=<n>`, which runs the fork's code in a job holding the Bedrock role — a deliberate manual step, not an automatic one.

**This does not make merge automatic.** The reviewer's verdict is advisory: `main` requires a pull request but deliberately does not require this check, and §7.13's gatekeeper is still a human maintainer. Two kinds of PR get no review at all, and requiring the check would mishandle them in opposite directions rather than uniformly: a PR touching only `paths-ignore`d files never triggers the workflow, so the check never reports and the PR is unmergeable; a fork PR's job is skipped by its own `if:`, which should satisfy a required check the same vacuous way — GitHub's documented handling of a skipped job, not a measurement here. A third case used to be the dangerous one, and it was the reason for this paragraph: a PR editing `code-review.yml` ran the job to completion with the fallback-review step and the verify step both gated off, so the check reported **success** with no review behind it (observed on PR #70) — indistinguishable from a real pass exactly where a human read matters most. It is now a real review with a real verdict, and both gates were removed with the case they were covering; the fallback and the verify step run on those PRs like any other. What remains is one case that blocks a mergeable PR forever and one that is vacuously green, which is why the check stays advisory. What the workflow changes is what the maintainer is reading — a diff already checked, already searched for the categories above, and already carrying a stated accessibility impact — not whether they read it.

### 7.15 Scheduled Issue Triage (v1.3)

**§7.14 raised the ceiling on how much review one maintainership can absorb. This section spends some of that headroom on the other side of the same bottleneck: issues that are correct, small and never picked up.** §7.13 makes upstream merge the only path for an agent, and §12 describes a maintainership with no full-time engineer, so the queue that accumulates is not disputed work — it is work nobody had an afternoon for. A reported barrier that sits open for three months is a barrier shipped to every session in between.

Implemented as `.github/workflows/issue-to-pr.yml`, on `schedule` (Sun–Wed, 22:00 UTC) plus `workflow_dispatch` with an optional `issue_number` and a `dry_run` flag. Claude reads the open issues, ranks them, and opens **one** pull request for the top issue it can finish well, with a review requested from the maintainer who merges.

**The schedule is a property of the reviewer, not of the runner.** Four runs, late afternoon Central, each landing a PR the day before it is read: a Mon–Thu queue with Friday clear. Thu–Sat runs would produce PRs nobody opens until Monday, by which point `main` has moved and the branch needs a rebase before it can be read at all. Day-of-week is the part that is easy to get wrong — Actions cron is UTC and never shifts for DST, and anything scheduled in the local *evening* crosses midnight UTC onto the next UTC day, so a "Sunday evening" job written naively runs Saturday evening Central. 22:00 UTC is before that boundary in both DST states.

**Declining to run is a feature, and four separate conditions exercise it.** This is the part that decides whether the workflow is worth having, because the failure mode of a generative automation is not a bad PR, it is a *steady supply* of plausible ones.

- **No eligible issue, no run.** The preflight is shell and `gh` only; it stops before Node, before the OIDC role assumption, and before a token is spent. An automation that always finds something to change is one that invents work, and an invented PR costs the same review attention as a real one.
- **An issue that any open PR already claims is not eligible, and if every open issue is claimed the run does nothing.** Restricting this to the workflow's own `iris-auto/` branches would leave the gap open from the one direction that matters most: a contributor's PR closing an issue is the case where a duplicate wastes *two* people's work, and it is invisible to a branch-prefix check. Two signals claim an issue, and both are precise: GitHub's `closingIssuesReferences` (every closing keyword it recognises, in any tense) and an `issue-<n>` fragment in the head branch. Every reference is first intersected with the set of currently-open issues, which discards PR numbers, closed issues and invented numbers without judgement. A manual dispatch overrides the check, with a warning naming the PR.

  **A bare `#<n>` mention is reported and deliberately does not exclude, and this is the one thing in this section that was learned by running it rather than by reasoning.** The first live run opened PR #75, whose body — as *this section requires*, so that the ranking is auditable — named the ten higher-ranked issues it passed over. A mention-tier check read all ten as claimed; the next run found zero candidates and declined. One PR had disabled the workflow for the entire backlog until it was merged. That is not a threshold to tune, it is a feedback loop, and the only PRs guaranteed to enumerate the backlog are the ones this workflow writes. Little is given up by narrowing it: `closingIssuesReferences` already covers every closing keyword, so mentions uniquely contributed the *ambiguous* references — "related to #5 but does not fix it" is textually identical to a fix — which are precisely the ones that want a person's judgement rather than a regex's. They are still computed, printed in the run summary, and handed to the model with an instruction to read the referenced PR's diff before writing code. Reported, not enforced.
- **Two open `iris-auto/*` PRs is the cap.** A queue that grows faster than one person reads it is not throughput; it is a backlog with a robot attached. At 2 the maintainer can be a day behind without the workflow piling on, and a week of no reviews caps the mess at two branches rather than four.
- **A rejected attempt is not retried.** An issue whose `iris-auto` PR was closed unmerged is removed from the candidate list permanently — returning with a fresh attempt every Sunday is how an automation becomes something a maintainer mutes, and muting it costs more than the PRs were worth. An issue whose PR *merged* becomes eligible again, since the next attempt starts from different code and a still-open issue means the merge only partly closed it. A `no-auto-pr` label is the explicit opt-out for tracking issues and discussions, and a manual dispatch naming an issue overrides a past rejection, because asking again by hand is how a human overrules one.

**One duplicate is reported rather than prevented.** A contributor can open a PR for the same issue during the 45 minutes the job is working, which no preflight can see. The verify step re-checks afterwards — comparing the new PR's own target issues against every other open PR's, both sides taken from `Closes` links and branch names only — and comments on the PR asking for the two to be compared. Mentions are excluded from *both* sides here for the reason above, and on the other PR's side it matters twice over: one earlier auto-PR listing the backlog in its body would otherwise make every later PR look like a duplicate of it. It warns rather than drafting one of the pair, unlike the path-allowlist rule below: which of two diffs to keep is a judgement about both, not something to settle by timestamp, and a duplicate costs a review slot rather than raising a safety question.

**Ranking is a stated order, and it is filtered by finishability.** Accessibility of the output or the app first (§7.7 — it is the product); then a red `main`, which outranks the whole issue queue; then correctness and data-safety bugs (§9.1); then a measured quality regression (`Quality regression:` issues filed under §7.16, ranked above a single report because a rate carries a denominator — a barrier on a third of documents was shipped to a third of users); then small user-visible fixes reported against the demo, which are cheap and review cleanly; then agent-library work (`New agent suggestion:` / `Agent update proposal:` issues that Iris filed itself under §7.13, ranked below a human report because the agent files them speculatively from content it met once); then docs that contradict the code. The filter applied over that order is *can this be finished well in one focused PR* — an open-ended issue is not a PR, and turning one into a PR produces something nobody can review. The PR body must name the higher-ranked issues that were passed over and why, so the ranking is auditable rather than asserted. Baseline `npm ci`, `tsc --noEmit` and unit results are measured on untouched `main` and handed over, for the same reason §7.14 hands over check output: without a baseline a pre-existing failure is attributed to the diff, and gets either blocked or "fixed" by an unrelated change smuggled into the PR.

**Issue text is untrusted input, and the prompt is not the control.** Anyone can open an issue on a public repo, so every body and comment reaches the model inside explicit fence markers, labelled as data describing a problem rather than as instructions; none of it is ever interpolated into a `run:` block, which makes a title full of shell metacharacters or an Actions expression inert. But instructions in a prompt are exactly the layer an injected issue argues with, so they are the weaker half. The control is a verify step that re-reads the **pushed diff** against a path allowlist and is unreachable from the model: a PR touching `.github/workflows/**`, `.github/CODEOWNERS`, `LICENSE`, `infra/**` or `.env*` is converted to a draft with a comment saying why, and the job fails. `.github/workflows/**` is the sharp case, and it stays forbidden now that §7.14 reviews workflow diffs: CI is where this workflow's own privilege is written down — the Bedrock role, `contents: write`, and the allowlist itself — so a run argued into editing it could widen what the next run may do. That is a privilege boundary, and it is not an automated reviewer's job to hold one. The same step is what guarantees the review request, since a CODEOWNERS request is skipped when the author is the code owner and the model can simply forget the flag.

**Known coverage gap, disclosed rather than hidden.** GitHub does not start workflow runs for events raised by `GITHUB_TOKEN`, so **§7.14's review does not fire on these PRs**. The verify step therefore says so on the PR itself, with the dispatch command, rather than only in a run log — the absence of a signal is not something a reader notices, and on a PR whose other checks never ran either there is nothing red to prompt a second look. An optional `AUTO_PR_TOKEN` secret (a PAT or GitHub App token, used only for `gh pr create`) closes the gap; until one is configured, these PRs are the third category of PR in this repo that a human reads unassisted, alongside the two in §7.14.

**The reporter is credited on the merged history.** A PR from this workflow names whoever opened the issue in its body and carries a `Co-authored-by` trailer for them on the commit, so the merged commit records the person whose report caused it and not only the bot that typed it — the report *is* the contribution under §7.13's model, where an issue Iris filed about content it met once is how the agent library learns at all. GitHub resolves that trailer only in its numeric-`id` `noreply` form, which is not derivable from the issue payload, so the address is looked up from the public profile during the context build and handed to the model ready to copy; a reporter's real email address is never used, since this workflow does not get to publish one into permanent history. Bot-filed issues are excluded. As with the review request, the prompt is not the guarantee: the verify step re-derives the reporter from the linked issue, reads the pushed commits, and on a missing trailer writes the exact line into the PR body for whoever runs the squash merge rather than force-pushing an amended commit under a review that has already started.

**This creates no new authority.** The workflow proposes; it does not merge, it does not close issues except through `Closes #<n>` on a PR a human merged, and it reaches `main` by exactly the route a contributor does (§7.13's protected-branch rule). It reuses §7.14's Bedrock role — a `schedule` run presents a `refs/heads/*` OIDC subject, which the existing trust policy already covers, so no widening of CI privilege was needed to add it.

### 7.16 Measured Quality Regressions (v1.4)

**§7.14 and §7.15 built a loop that turns a written report into a merged fix. This section supplies the loop with something nobody has to write.** Every path into that loop until now started with a person typing: an issue, or the feedback of §7.12. Meanwhile Iris already measures its own output on every single run — how many reader/editor rounds a document needed (§7.11), which axe-core rules its HTML still violates (§7.7), whether a hyperlink present before the copy editor was missing after it (§7.9) — and wrote all of it to a per-session log that nothing ever read back. Every session graded itself and threw the grade away. The app was capable of noticing that one axe rule fails on a third of everything it produces, and structurally incapable of telling anyone.

Three pieces, and the boundary between them is the design:

- **`run_signals`**, a table written once per delivered document (`Store.recordRunSignals`, called from the orchestrator). One row per measurement: `iris:rounds` for every delivered document, plus `iris:unresolved`, `iris:links-dropped`, `iris:lint-error` and one row per violated axe rule id when applicable.
- **`GET /v1/quality`**, which aggregates that table over a window and returns rates. Documented in `docs/API.md` §0c rather than under §9 here, alongside `/v1/stats` — §9 specifies the session lifecycle, and neither tally is part of it.
- **`.github/workflows/quality-report.yml`**, which reads the endpoint weekly, compares the rates against thresholds **held in the workflow**, and files one issue per crossed threshold. §7.15's triage then ranks those issues alongside every other open issue, and may open a PR against one.

**Only facts that cannot be argued with are recorded, and that is what makes filing an issue from them defensible.** An axe violation, a round count, a missing `href` and a lint pass that errored are all mechanically checkable; a reviewer of the resulting PR can confirm or refute each one without trusting anything the model said. The Reader Agent's judgement about a document (§7.8) is deliberately *not* recorded, even though it is the richest signal Iris produces: it is a model's opinion about one document, and an automation that files issues from model opinions manufactures work at whatever rate the model is willing to opine. Only the **count** of unresolved issues crosses the boundary.

**The response cannot carry document content, and this is a hard constraint on the schema rather than a convention.** The consumer copies values from it into a *public* GitHub issue, and the documents behind those values are user uploads — at the reference deployment (§12), student records. Rule ids come from axe-core's fixed vocabulary and are safe to publish. Unresolved-issue descriptions are model-written prose about one identifiable person's document, and dropped `href`s came from that person's own PDF, so only their counts exist in the aggregate at all — the endpoint cannot leak them because it never receives them. A field added here that quoted a document would reach a public issue through a path no reviewer of the workflow would think to check, which is why the constraint is stated in `src/routes/quality.ts`, in `docs/API.md` §0c, and asserted by a test that pins the response's key set.

**Its authentication is deliberately not §9.1's.** Every other endpoint requires the caller's GitHub token, because every other endpoint returns one user's data and files that user's contributions under their own identity. This one returns an aggregate over every document the deployment has ever converted: it belongs to no user, and its caller is a CI job with no GitHub identity. It is therefore gated by `server.quality_token`, a shared secret compared in constant time, and **unset means 404** rather than 401 — a deployment that has not opted in does not acknowledge the endpoint, so scanning for it reveals nothing about whether an operator merely forgot a token. Opting in is per-deployment and deliberate.

**The thresholds live in the workflow, not the server, and the reason is the review path.** Retuning "how bad is too bad" is then a repo edit with a diff and a reviewer, rather than a config change and a restart on one machine — and the thresholds are guesses that will need revising against real numbers, so the version of them that is easy to change well matters more than the version that is easy to change quickly. The interaction with §7.15 is the part worth stating: `.github/workflows/**` is on that workflow's forbidden-paths list, so **the automation cannot close one of these issues by moving the number that produced it.** Retuning is a human decision. The prompt says so explicitly, because a model that discovered the restriction by having its PR drafted would waste a whole run learning it.

**Four failure modes here are silent, and each is designed against rather than tested for afterwards.** They share a shape: the tally keeps returning a plausible percentage while meaning something else, and a workflow comparing that percentage to a threshold cannot tell.

- **The denominator.** A clean run writes no violation rows, so counting "documents that had a problem" divides by the bad documents alone and reports every rate near 100%. Hence `iris:rounds`, written for *every* delivered document precisely so the flawless ones are countable.
- **The re-run.** §7.12's feedback re-converts the same session, so signals must be *replaced* rather than appended — and replaced by delete-then-insert in one transaction, not upserted, or a rule the feedback actually fixed keeps being reported as present. Appending would also bias every rate upward on exactly the documents users asked Iris to retry.
- **The broken linter.** `runAxe` degrades to "no violations" when axe cannot run in its jsdom environment at all (§7.7), so a broken lint pass drives every accessibility rate to zero and reads as a deployment that got *better*. `iris:lint-error` is recorded explicitly for that reason, is the only threshold set to zero, and sorts first among findings because it means every other number in the same report is understated.
- **The endpoint that stops answering.** A quality loop that silently stops reporting is indistinguishable from a deployment with no problems. So the workflow fails the run — loudly, where someone sees it — on an unreachable endpoint, a rejected token, or a 200 that is not a tally. The two cases that are *not* failures are the two that are legitimately "not configured": no `QUALITY_URL`/`QUALITY_TOKEN` in the repo, and a 404 from a deployment that has not opted in.

**Declining to file is the normal outcome, and four conditions produce it.** Same discipline as §7.15, for the same reason — a generative automation's failure mode is a steady supply of plausible work. Below **20 documents** in the window nothing is evaluated at all, because a rate over four documents is noise wearing a percentage sign and one odd PDF would cross every threshold. Titles are **stable and carry no numbers**, so an issue already open is not refiled — a title containing this week's rate is a different title every week, which is the same dedupe failure §7.13 already paid for from the other direction. A **closed** issue starts a cooldown as wide as the window itself, because on the day a fix merges the 30-day rate still contains a month of pre-fix documents, and refiling then would tell the maintainer their fix did not work a week after they made it. And **two issues per run** is the cap, with anything over it named in the run summary rather than dropped quietly — a cap that hides what it dropped reads exactly like a week with fewer problems.

**It is weekly rather than daily, and Saturday specifically.** The rate is measured over 30 days: reading it daily produces thirty nearly-identical numbers, and a fix landing on Monday cannot move a 30-day rate by Tuesday, so daily polling would add noise rather than resolution. Saturday afternoon puts a new issue on §7.15's candidate list for the very next triage run; filing on Sunday evening would make it wait a week.

**No model tokens, no new CI privilege, and no new authority.** The workflow is curl, `jq` and arithmetic — every judgement call it could make is left to §7.15, which is already good at that, and keeping this job dumb is also what makes it safe to run weekly against a production deployment. It needs no Bedrock role, no OIDC and no Node; its only permission is `issues: write`. It proposes an issue. A human still merges the PR (§7.13).

## 8. File and Directory Layout

### 8.1 Layout

```
project/
├── agents/                 # the agent library — modified ONLY by `git pull` from upstream
│   ├── page.md             # the general extraction pass (v1.2: what actually runs)
│   ├── feedback.md         # verification + agent-update drafting
│   ├── chartDataAgent.md   # a specialist, dispatched by name (§7.4 v1.2)
│   └── …                   # (the nine per-content-type agents were deleted — §7.4 v1.2)
├── tmp/
│   └── <session-id>/
│       └── agents/         # session-built agents (ephemeral)
│           └── …
└── sessions/
    └── <session-id>/        # persisted session record
        ├── input/           # original source images
        ├── notes/           # *.md from Image Analysis Agent
        ├── fragments/       # fragment log
        ├── output.html      # final accepted document
        ├── log.jsonl        # full agent call log (with SHA pinning + inline content for session-built agents)
        ├── new-agents.md    # summary of any session-built agents (whether PR'd or dismissed)
        ├── agent-updates.md # summary of any proposed updates to existing agents
        ├── prs.md           # links to any PRs opened from this session
        └── unresolved.md    # issues remaining at iteration cap, if any
```

**Amended (v1.2): `new-agents.md` and `prs.md` are not written.** They are the last two entries of the fork-and-PR flow withdrawn in §7.13 v1.2, and this tree is the place that outlived the withdrawal — every other consequence got an amendment note, so the one that reads as a file layout got a stale line instead. `prs.md` cannot exist: nothing opens a PR. `new-agents.md` was a summary of session-built agents *"whether PR'd or dismissed"*, which is a distinction about PRs; the draft itself lives in `tmp/<session-id>/agents/` for the session and the proposal survives as a filed issue under the user's identity. `paths.ts` carried `sessionNewAgents()` and `sessionPrs()` with zero callers until they were deleted with the flow. The line in §7.6 about logging a session-built agent to `runs/<run-id>/new-agents.md` goes with them.

What the current build actually writes is the same tree minus those two, plus five the original never named: `source-name.txt` (the upload's base name, for the output title and download filename), `fragments/final.json` (the reviewed fragments a feedback re-run refines instead of re-extracting, §7.12), `lint.json` (the final axe result), `history/` (snapshots of prior outputs, since a re-run overwrites `output.html`), and `links.json` (the link annotations found in the uploaded PDFs, keyed by page order — §7.4 v1.2 links).

`links.json` is a file of its own, beside `input/` rather than inside it, and is written only for a document that has links. Both follow from how `input/` is read back: every `<order>__<name>` file in that directory is enumerated as a page image, so a sidecar named to sit next to its own page would be extracted as one. Its absence and an empty object mean the same thing — no links — which is also what a session created before links were extracted at all reports, so the reader treats a missing, empty, or unparseable file identically. Links are additive: without them a run produces exactly the document it produced before.

### 8.2 Session lifecycle

1. **Open**: `POST /v1/sessions` (see §9) creates a session ID, allocates `tmp/<session-id>/` and `sessions/<session-id>/`.
2. **Run**: pipeline executes sequentially. Session-built agents (if any) live in `tmp/<session-id>/agents/`. The orchestrator may call them during the session.
3. **Review and feedback**: HTML is returned when the session reaches `ready_for_review`. The user may inspect the output and any pending contributions via `GET /v1/sessions/{id}`. They may submit feedback (which re-runs the pipeline within the same session) any number of times.
4. **Close**: `POST /v1/sessions/{id}/close` finalizes the session. The system opens PRs for all session-built agents and proposed updates, then deletes `tmp/<session-id>/` entirely.
5. **What persists** in `sessions/<session-id>/`: the original input images, the final HTML, the logs, the summaries of any new agents or proposed updates, and links to the PRs that were opened. The session-built agents themselves are no longer on disk as separately usable files; their content is preserved inline in `log.jsonl` for reproducibility of that session's output.
6. **Local availability of session-built agents**: only after the upstream maintainer merges the PR and the user runs `git pull` against the configured upstream repo. There is no other path.

## 9. API Specification

The service exposes a REST API. All endpoints are versioned under `/v1`. Requests and responses are JSON unless otherwise noted. Every endpoint requires authentication (§9.1). The API is intentionally small for v1: it manages sessions and exposes the current user's identity. The local agent library is not managed via API — it is a git working copy modified only by `git pull` from upstream.

Client flow:

```
GET  /v1/auth/github/start                 → begin OAuth (web clients)
GET  /v1/auth/github/callback              → OAuth callback (web clients)
POST /v1/auth/github/device                → begin device flow (CLI clients)
POST /v1/auth/github/device/poll           → poll device flow (CLI clients)
GET  /v1/me                                → current GitHub user
GET  /v1/sessions                          → list this user's sessions
POST /v1/sessions                          → create session, upload images
GET  /v1/sessions/{id}                     → poll status; preview pending PRs when ready
GET  /v1/sessions/{id}/output              → fetch HTML when ready
POST /v1/sessions/{id}/feedback            → submit feedback, triggers re-run
POST /v1/sessions/{id}/close               → accept output, open PRs, clean tmp
GET  /v1/sessions/{id}/logs                → fetch the run log
```

GitHub is the only auth mechanism. See §9.1 for why.

### 9.1 Authentication

Authentication is GitHub, and Iris is registered as a **GitHub App** — not an OAuth App. A user *is* their GitHub account. The first time a GitHub user authenticates, an account is provisioned automatically: login is signup. There is no separate signup form, no email or password, and no service-issued credential to manage.

**A GitHub token is required on every API call, and that requirement is load-bearing rather than incidental.** The user's token is what files their session's contributions under their own identity (§7.13, §12), which makes authenticating and contributing the same act. Alternative auth schemes — API keys, pasted PATs, basic auth, a second SSO provider, anonymous mode — are non-goals for that reason and not for lack of time: any credential that cannot file would admit callers who consume the agent library without refilling it, and refilling it is the only reason the library improves.

#### Web redirect flow

1. Client redirects the user to `GET /v1/auth/github/start`.
2. Server redirects to the GitHub consent screen. **No scope is requested** — see "What the token grants".
3. User approves; GitHub redirects to `GET /v1/auth/github/callback?code=…`.
4. Server exchanges the code for a user access token, calls `GET /user` to identify the user, provisions the account if new, and returns the token to the client.
5. Subsequent requests use `Authorization: Bearer <github_token>`.

This flow needs `github.client_secret`. The device flow below does not, which is why it is the default deployment's path.

#### Device flow (CLI clients)

1. Client calls `POST /v1/auth/github/device`. Server initiates the device flow with GitHub and returns a `user_code` and `verification_uri`.
2. Client displays both and instructs the user to visit the URL and enter the code.
3. Client polls `POST /v1/auth/github/device/poll` until the user approves or the request times out.
4. On approval, the polling endpoint returns a user access token. The CLI stores it locally.
5. Subsequent requests use `Authorization: Bearer <github_token>`.

The same pattern GitHub's own CLI uses, and the same reason: no browser redirect to receive, and no client secret to distribute.

#### What the token grants

**No repository access, because the consent screen requests none.** A GitHub App's repository permission does not come from the user at all — it comes from the app's **installation** on `upstream_repo`, which grants exactly `issues: write` on exactly that repository. The user's authorization contributes only their **identity**: a user-to-server token acts as the user, so an issue Iris files appears under that person's own account and each contribution is credited to whoever's session produced it (§12). That is the whole reason users authorize the app rather than the app filing everything as itself.

This is why there is no scope configuration and nothing about the credential's breadth to validate. An OAuth App could not express "file an issue on one repository": the narrowest scope that can file is `public_repo`, which grants read *and write* to every public repository the user can reach — code, commit statuses, collaborators, webhooks — none of which this service touches. That gap was a property of OAuth scopes, not of how the app was configured, so it was not fixable by configuration.

| | What Iris needs | What it asks the user for |
| --- | --- | --- |
| Identify the caller (`GET /user`) | `id` and `login` | nothing — they are public fields |
| File an issue on `upstream_repo` | `issues: write` on one repo | nothing — it comes from the installation |
| Everything else | — | — |

Five consequences, each of which the implementation depends on:

- **The one misconfiguration that matters is not in config, and this is a real loss.** If the app is not installed on `upstream_repo` — never installed, installation removed, or Issues write revoked — filing breaks for *every user at once*, and startup cannot catch it, because the install state lives on github.com. It surfaces during filing as a 403, or (since GitHub does not reveal repositories a credential cannot see) a **404**, diagnosed in the log line by `installHintFor`. Under a scope this was a config value a startup check could read; now it is not.
- **What config CAN check, it does.** An `Ov…` `client_id` is an OAuth App and is **refused at startup**: it would authenticate users perfectly and then be unable to file a single issue, with the service answering `200` throughout — a silent consumer-only deployment, which §12 exists to prevent. Any other non-`Iv…` id gets a boot warning instead of a refusal, since GitHub Enterprise Server mints its own id formats and refusing an unrecognized shape could break a working deployment.
- **`upstream_repo` is no longer independent of `client_id`.** An installation is per-repository, so the bundled Equalify Iris app can only file on the repository it is installed on. Leaving `client_id` blank while pointing `upstream_repo` at your own agent library therefore files nothing, for anyone — and `upstream_repo` is a first-class documented knob, so that edit is an easy one to make alone. It **warns at startup** rather than failing, because the state is legitimately reachable: Equalify can install the bundled app on another organization's repo, and no config value could reveal that it did.
- **A private `upstream_repo` needs more than the installation.** A user-to-server token is the *intersection* of the installation's permissions and the authorizing user's own access — GitHub will not let an installation grant a user access they lack — so on a private upstream, filing succeeds for users who can already see the repo and 404s for everyone else. Per-user rather than deployment-wide, which is how it is told apart from a missing installation. The remedy is `github.issue_token`, and it costs §12 attribution. The public-upstream case, which this design assumes, is unaffected.
- **Two registration settings are load-bearing and invisible from the code.** Device flow must be **enabled** (off by default for a new app, and the device flow is the default deployment's only login path). User-token expiry must be **off** (GitHub's default is an 8-hour token plus a refresh token; nothing here persists or refreshes a credential — see "How the token is stored" — so enabling expiry means building refresh plumbing first). Neither is checkable at startup either, so both flows log a warning when GitHub returns an `expires_in`, which is the one observable symptom of the second.

#### How the token is stored

**It is not stored.** There is no `users.github_token` column, no token file, and therefore no encryption question to answer. The user's token arrives in the `Authorization` header, is held in memory for the request and for the pipeline run it authorizes, and is discarded when that run ends. **A copy of `data/iris.sqlite` is a list of GitHub user IDs, logins and session metadata — it is not GitHub access.**

This was not always true, and the reasoning is worth keeping because it explains why the fix was so small. An earlier revision stored the token in plaintext, on the grounds that a credential used to call GitHub on the user's behalf has to be replayable and so cannot be hashed. The consequence followed directly: read access to the database file was GitHub API access as every user who had ever authenticated — a backup, a synced directory, another process on a shared host, or a lost laptop all sufficient. Encryption at rest was no answer, because §10.1 requires a deployment to run on a laptop with no managed dependencies, so the key would live beside the database. What made the problem dissolve instead was noticing that **nothing ever read the stored token**: it was written on every authenticated request and read by no code path, since every GitHub call already uses the token from the current request, threaded through the run in memory. The column was a liability maintained in exchange for nothing.

Three properties follow, all worth specifying rather than leaving to the implementation:

- **Identity lookups are cached in memory, keyed by the token, for 5 minutes.** This is what keeps `GET /user` off every request. It means a token revoked at github.com keeps working here for up to that long, which is the reason not to raise the TTL — the only cost of a miss is one API call. The cache is bounded (10,000 entries; oldest insertions evicted first) because it holds live credentials, and entries are **not** renewed on read: a busy token must not be able to outlive its revocation indefinitely, which is the failure the TTL exists to bound. It is empty on restart.
- **There is nothing to rotate, re-encrypt or purge**, and no cleanup owed when a user revokes access. Revocation at [github.com/settings/applications](https://github.com/settings/applications) is the entire mechanism.
- **A database carrying the old token column is refused at startup, not migrated.** Every user starts from scratch, so such a file is a leftover rather than a deployment to upgrade — but the check is required, because `CREATE TABLE IF NOT EXISTS` keeps the old table silently. Two failures would follow, and neither names its cause: `github_token TEXT NOT NULL` makes every FIRST-TIME login throw a constraint error that the auth middleware returns as `401 unauthorized` (while anyone with an existing row keeps working, so it reads as flaky GitHub auth), and the file's plaintext tokens remain — never refreshed, never cleared, still returned by `getUser`'s `SELECT *` — so the claim above would be false for exactly that deployment. The startup error names the fix (delete the file, do not archive it). Refusing rather than rebuilding-and-vacuuming is deliberate: erasing live credentials is the operator's decision, not something the service should do to a file it was pointed at.

This does not resolve §9.1's dependency on GitHub (see §10.5), and it is not a claim that the credential is harmless: a token in flight is still a real credential, and it still acts as the user for as long as it is valid. It removes one specific hazard — the one that was persistent and silent. What bounds the rest is that the token grants no repository access to begin with (see "What the token grants").

#### User identity and isolation

The user is identified by their GitHub numeric user ID (stable across login renames). Sessions are scoped to that user; a token cannot see or modify sessions owned by a different GitHub user.

#### Per-deployment configuration (not per-user)

Two things are configured at deployment time, not per user:

- **The agent library upstream.** The service's local `agents/` directory is a git checkout of one upstream repo (its `origin` remote). All PRs target that upstream. Users who want a different upstream run their own deployment pointing at their own checkout.
- **PR fork behavior.** PRs are opened from each user's GitHub fork of the upstream. If the user does not already have a fork, the service creates one on their account (this is what `repo` scope is for) before pushing. **Amended (v1.1):** unimplemented, and the scope it assumes is no longer requested by default — see §9.1 "What the token grants" and §7.13. **Amended (v1.2):** withdrawn, not merely unimplemented — contributions are issues, so no fork is ever created and there is nothing per-deployment to configure here (§7.13 v1.2).

Per-user defaults (e.g., `max_review_iterations`) live on the user's account record, populated on first auth and updateable via a config endpoint not specified in v1.

#### `GET /v1/me`

Return the authenticated GitHub user and current configuration.

Response `200 OK`:
```json
{
  "github_login": "blakebertuccelli",
  "github_user_id": 12345,
  "upstream_repo": "https://github.com/example/accessible-html-agents",
  "fork_repo": "https://github.com/blakebertuccelli/accessible-html-agents",
  "defaults": { "max_review_iterations": 3 }
}
```

`fork_repo` is `null` until the first `/close` (the fork is created lazily).

**Amended (v1.2): there is no `fork_repo` field.** Nothing forks and nothing pushes — contributions are filed as issues (§7.13) — so the field could only ever be `null`. It was returned as a literal `null` for one release for response-shape stability; that is now withdrawn, since a permanently-null field documenting an unbuilt feature is worse than its absence. The response is `github_login`, `github_user_id`, `upstream_repo` and `defaults`.

### 9.2 Sessions

#### `GET /v1/sessions`

List sessions owned by the authenticated user, newest first.

Query parameters (optional): `status` (filter), `limit` (default `20`, max `100`), `cursor` (pagination).

**Amended (v1.1): `limit` has one rule for every unusable value — it falls back to the default.** This section gave a default and a maximum but said nothing about what happens below the range, and the first implementation answered inconsistently: `?limit=0` fell through the `|| 20` default (`0` is falsy) while `?limit=-1` clamped to `1`, so two equally invalid requests got page sizes differing by a factor of twenty. Anything that is not an integer of at least 1 — `0`, negative, fractional, non-numeric, absent — is now `20`; anything above `100` is `100`. The low end is clamped at all because a negative value is destructive rather than merely odd: SQLite reads `LIMIT -4` as *no* limit, so one list request reads the user's entire session table, and the over-fetch slice then trims rows off the end of the page while still emitting a `next_cursor` — a short page that claims there is more, about rows the client was never shown. That symptom is invisible in the response, so the floor is enforced in the query itself as well as at the route.

Response `200 OK`:
```json
{
  "sessions": [
    {
      "session_id": "ses_01HXYZ…",
      "status": "ready_for_review",
      "image_count": 12,
      "created_at": "2026-05-22T18:00:00Z",
      "updated_at": "2026-05-22T18:14:22Z"
    }
  ],
  "next_cursor": null
}
```

**Amended (v1.1): `next_cursor` is a compound keyset cursor, `"<created_at>|<session_id>"`.** This section left the cursor's contents unspecified, and the natural reading — the last row's `created_at`, since the list is ordered by it — is wrong. `created_at` is a millisecond timestamp assigned by an HTTP handler, so two sessions created in the same millisecond are indistinguishable by it; that is not a corner case but what a burst of uploads looks like. Paging on a non-unique sort key both **skips** rows (`created_at < ?` excludes the rest of the tied group, so those sessions appear on no page at all) and can **repeat** them (nothing pins the order among tied rows between two queries). Neither is visible at small volume, and both silently corrupt the only thing pagination is for: walking pages to build a complete list. The cursor therefore carries the full sort key `(created_at, session_id)` and the order is `created_at DESC, session_id DESC` — the id half is an arbitrary tie-break, but a total one, which is what keyset pagination requires. Clients pass the value back verbatim and treat it as opaque; a cursor that does not parse is a `400 invalid_request` rather than being compared as a raw string, which previously matched every row and handed back page one indefinitely. `next_cursor` is `null` on the last page even when that page is full, so clients stop on a null cursor rather than on a short page.

One accepted gap, for the length of a deploy window: a cursor issued *before* this change is a bare `created_at`, and it is honored rather than rejected — it parses to an empty `session_id`, which degrades the predicate to the old `created_at < ?`. So a client mid-pagination across the upgrade still skips the rows tied on that one timestamp, i.e. the exact bug described above, on the single page where it cannot be avoided. Rejecting the cursor instead would break that client outright; the pre-existing behavior is the better of two wrong answers, and it is self-clearing — the next cursor the client receives is compound. Worth knowing when a client reports a gap during an upgrade.

#### `POST /v1/sessions`

Create a new session and upload the input images. The request is `multipart/form-data`. Multiple images are sent as multiple parts that share the same field name `images`, in the order they should be processed. Order is determined by the order the parts appear in the multipart body — not by filename.

A concrete `curl` example:

```bash
curl -X POST https://api.example.com/v1/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -F "images=@page-001.png" \
  -F "images=@page-002.png" \
  -F "images=@page-003.png"
```

Each `-F "images=@…"` adds another image part to the request body. The server reads them in order.

Request parts:

- `images` (repeated): one image file per part (PNG, JPEG, TIFF, WebP). At least one required. No fixed maximum in v1; per-account limits are enforced at the account level.

**Amended: the `config` part is withdrawn — `images` is the only part, and a session has no per-request options.** This section specified a single optional JSON part carrying `{ "max_review_iterations": N }`, and it shipped that way (the demo page even asked for the number, as "Review passes"). It is removed, from the endpoint and from the demo, because it asked the uploader to decide something they are not in a position to decide. **How many review rounds a document needs is a property of the document, and the loop is what discovers it** — it stops as soon as the Reader finds nothing (§7.11), so the cap is only ever reached by documents that still had issues. A caller choosing the number can therefore only do one of two things: leave it at the deployment's cap, or ask for fewer rounds than budgeted, which means asking for a document with more unresolved issues in it. Neither is a decision worth an API surface, and the second is a foot-gun the person uploading a scan has no way to evaluate. The value was also never validated — `0` bought one Reader pass with no fix ever applied, and a negative skipped review outright.

The cap now comes from one place per deployment: `defaults.max_review_iterations` in config, which seeds each user's account record on first auth (§9.1) and is reported by `GET /v1/me`. A request that still sends a `config` part is **ignored, not rejected**, so an older client keeps working at the deployment's cap.

Response `201 Created`:
```json
{
  "session_id": "ses_01HXYZ…",
  "status": "queued",
  "image_count": 3,
  "created_at": "2026-05-22T18:00:00Z"
}
```

#### `GET /v1/sessions/{session_id}`

Retrieve session status. When `status` is `ready_for_review`, the response also includes a preview of what `/close` will do (which PRs will be opened) so the user can inspect before closing.

**Amended (v1.1): `phase` enumerates only the phases the pipeline enters, and `queued` is a documented status.** `triage` and `reconciliation` were removed from the enum. Neither is implemented — nothing writes the triage notes of §7.2, and reconciliation (§7.6) cannot run at all while extraction produces `edges: []` — so a client switching on them was branching on states no session could ever report. Worse, a new session was *created* at `phase: "triage"`, held it for the length of one INSERT, and was overwritten by `extraction` before any client could poll: the one phase that appeared in responses was the one that does not exist. New sessions now start at `extraction`. This narrows the API to what ships; it does not decide whether either phase gets built (see the tracking issue's Tier 4) — restoring a phase means restoring its enum value with it. `queued` was already returned by the run queue (§9.4) but was missing from this list.

Response `200 OK`:
```json
{
  "session_id": "ses_01HXYZ…",
  "status": "queued" | "running" | "ready_for_review" | "closed" | "failed",
  "phase": "extraction" | "assembly" | "review" | "done",
  "iterations_completed": 1,
  "iterations_max": 3,
  "image_count": 12,
  "created_at": "…",
  "updated_at": "…",
  "pending_prs": {
    "new_agents": [
      {
        "agent_name": "scientificNotation",
        "summary": "Built to handle inline mathematical notation not covered by paragraph.md.",
        "triggered_by": "page-007.png#region-eq-2"
      }
    ],
    "agent_updates": [
      {
        "agent_name": "table.md",
        "summary": "Copy Editor corrected scope=row vs scope=col 4 times in this session.",
        "diff_preview": "@@ -12,7 +12,10 @@ …"
      }
    ]
  }
}
```

`pending_prs` is only present when `status` is `ready_for_review`. It is empty if no contributions were generated.

**Amended (v1.2): there is no `pending_prs` field.** It described a queue of contributions awaiting `/close`, and no such queue exists: contributions are filed as issues during the run, at the moment the phase that produced them finishes (§7.13 v1.2). By the time a client can read this response the filing has already happened or already failed, so there is nothing pending to preview and no decision left for the user to make. What was actually filed is in the run log (`GET /v1/sessions/{id}/logs`) as `agent_issue` events carrying the issue URL — or as `agent_issue_failed` with a reason.

#### `GET /v1/sessions/{session_id}/output`

Retrieve the current HTML output. Available when `status` is `ready_for_review` or `closed`.

Response `200 OK`: `Content-Type: text/html` (clean content-only HTML; provenance comments are stripped — see the v1.1 amendment in §7.4).

Response `409 Conflict` if the session is still running.

#### `POST /v1/sessions/{session_id}/feedback`

Submit user feedback and trigger a re-run within the same session.

Request:
```json
{ "feedback": "The footnote on page 4 was inlined as body text. Please keep footnotes structurally distinct." }
```

Response `202 Accepted`:
```json
{ "session_id": "ses_01HXYZ…", "status": "running", "phase": "extraction" }
```

#### `POST /v1/sessions/{session_id}/close`

Finalize the session. This single action:

1. Locks the HTML as the accepted output.
2. Opens a GitHub PR for each session-built agent and each proposed update to an existing agent (see §7.13). PR URLs are returned in the response.
3. Deletes `tmp/<session-id>/`. The `sessions/<session-id>/` record is preserved.

Query parameters (optional):

- `skip_prs=true` — finalize without opening any PRs. Use when the user does not want to contribute the agents from this session. The session-built agents are discarded.

Response `200 OK`:
```json
{
  "session_id": "ses_01HXYZ…",
  "status": "closed",
  "prs_opened": [
    {
      "kind": "new_agent",
      "agent_name": "scientificNotation",
      "pr_url": "https://github.com/example/accessible-html-agents/pull/142",
      "branch": "new-agent/scientific-notation-a3f9"
    },
    {
      "kind": "agent_update",
      "agent_name": "table.md",
      "pr_url": "https://github.com/example/accessible-html-agents/pull/143",
      "branch": "agent-update/table-7c12"
    }
  ]
}
```

Response `409 Conflict` if the session is not in `ready_for_review`.

**Amended (v1.2): `/close` neither opens PRs nor accepts `skip_prs`, and returns no `prs_opened`.** Step 2 above does not happen here — contributions are filed as issues during the run (§7.13 v1.2) — so `/close` does exactly two things: lock the HTML as accepted, and delete `tmp/<session-id>/`. The response is `{ "session_id", "status": "closed" }`.

`skip_prs=true` is not accepted, and its absence is a decision rather than a consequence of the mechanism change: it was the one supported way to consume the agent library without contributing to it, which §12 makes unsupportable. There is no replacement parameter.

#### `GET /v1/sessions/{session_id}/logs`

Retrieve the structured run log (`log.jsonl` content).

Response `200 OK`: `Content-Type: application/x-ndjson`.

### 9.3 Errors

All errors use the standard structure:
```json
{
  "error": {
    "code": "session_not_found" | "invalid_state" | "agent_build_failed" | "unauthorized" | …,
    "message": "Human-readable description",
    "details": { … }
  }
}
```

### 9.4 Asynchrony

All long-running operations (session create, feedback re-run) are asynchronous. Clients poll `GET /v1/sessions/{id}` for state changes. Webhooks for state transitions are out of scope for v1 but the API is structured to add them without breaking changes.

**Amended (v1.1): `queued` is a real, observable state, bounded by a deployment-wide run cap.** This section (and the `status` enum in §9.2) always listed `queued`, but said nothing about what bounds concurrent work — so the natural reading was that every accepted session starts immediately, and the first implementation did exactly that. That does not survive §10.1's portability constraint: a deployment may be a laptop or a Mac Mini, and each run holds a jsdom+axe instance plus up to `extraction_concurrency` in-flight vision calls, so N simultaneous uploads degrade the service for everyone rather than making one user wait.

A deployment therefore runs at most `defaults.max_concurrent_runs` pipelines at once (default 2), with the rest **waiting in `queued`**, FIFO:

- **Waiting, not rejection.** By the time the cap is consulted the upload has been received, rasterized, and written to disk. A 429 would discard work the user has already paid for — potentially a 25-page PDF — to save a few seconds of queueing, so the queue takes the expensive-but-safe direction and holds the session instead. Nothing is dropped and nothing needs re-uploading.
- **Global, not per user.** The resources being protected (memory, jsdom instances, the provider's rate limit) are global, so a per-user cap would let ten users each start a run and still exhaust the machine. The cost is fairness — a burst from one user delays others — which is the right trade for a single-instance deployment and would need a real scheduler, not a counter, to do better.
- **Observable.** A waiting session is otherwise indistinguishable from a hung one, so the wait is recorded in the session's own run log: `run_queued` (how busy the queue was on admission) and `run_dequeued` (`waited_ms`). A feedback re-run is subject to the same cap and its `202` reports `queued` when it has to wait, rather than claiming `running`.

Two limits this does **not** address, both consequences of the single-process design: the queue is in-memory, so a restart loses waiting runs (they are marked `failed` by the same startup sweep that handles interrupted `running` sessions); and it cannot bound upload memory, because the multipart body is fully buffered before any handler — and therefore any cap — runs.

## 10. Deployment and Model Providers

### 10.1 Portability requirements

The service must run on a single machine without requiring any specific cloud account. Portability is a design constraint:

- **No required cloud dependencies.** A user must be able to run the service on a laptop, desktop, Mac Mini, or self-hosted server with no AWS, GCP, Azure, or other hosted-service account required. No required managed database, queue, object store, or model provider.
- **No vendor lock-in at any layer.** Every external service the system depends on — LLM provider, optional object store, optional database — is replaceable by configuration. Sensible defaults exist; no default is mandatory.
- **One-command local deploy.** A reference `docker-compose.yml` brings up a working service against the user's configured upstream agent repo and chosen model provider. Setup time from clone to first session should be measured in minutes, not hours.

These constraints serve two ends: keeping the service Open Source compatible (no part of the system requires a paid hosted dependency to function), and keeping the operating-cost floor low enough that universities, nonprofits, and individual developers can run their own deployments.

### 10.2 Storage

Default storage is the local filesystem:

- `agents/` is a git checkout.
- `tmp/<session-id>/` and `sessions/<session-id>/` are directories on disk.
- The session metadata store is a single SQLite file by default. PostgreSQL is a supported alternative for multi-instance deployments.

Optional pluggable backends (e.g., S3-compatible object store for `sessions/` artifacts, Postgres for the session DB) are supported but never required.

### 10.3 Model providers

LLM calls go through a provider abstraction. The system does not bind any agent to a specific model or vendor. A deployment configures one or more model providers; each agent declares the capability it needs (e.g., `vision`, `structured_output`), and the provider routes the call to a concrete model.

**Initial providers (v1)**:

- **OpenRouter.** Pay-per-use aggregator with access to many models from one credential. Good for users who want flexibility without per-vendor signup.
- **Amazon Bedrock.** For users already on AWS who want regional compliance, IAM-scoped access, or volume pricing.

**Planned providers**:

- Direct Anthropic API
- Direct OpenAI API
- Self-hosted (Ollama, vLLM, LM Studio) — for users running local models on a workstation or Mac with sufficient unified memory
- Free-tier and credit-friendly inference (Groq, Cerebras, Together AI, Cloudflare Workers AI)

Adding a provider is a small adapter that implements the provider interface; new providers are expected over time and contributions are welcomed.

**Provider interface (sketch)**:

```typescript
interface ModelProvider {
  name: string;
  capabilities: ("text" | "vision" | "structured_output")[];

  complete(request: {
    capability: "text" | "vision" | "structured_output";
    messages: Message[];
    images?: Image[];
    schema?: JSONSchema; // for structured_output
  }): Promise<CompletionResult>;
}
```

**Provider selection per agent**:

Each agent declares its required capability in its markdown file (see Appendix A). The deployment configures which provider serves each capability. Defaults can be set globally; per-agent overrides are supported.

Example deployment config (`config.yaml`):

```yaml
providers:
  default: openrouter
  per_agent:
    image_analysis: bedrock      # specific provider for the triage agent
    table: openrouter
    # everything else uses default

openrouter:
  api_key: ${OPENROUTER_API_KEY}
  default_model: anthropic/claude-opus-4.7
  per_capability:
    vision: anthropic/claude-opus-4.7
    structured_output: openai/gpt-5

bedrock:
  region: us-east-2
  default_model: anthropic.claude-opus-4-7-v1
```

The system reads this config at startup; changes require a restart in v1. Hot-reload is out of scope.

### 10.4 Packaging

- **Container**: official Docker image, multi-arch (`linux/amd64`, `linux/arm64`). Mac Mini and Linux ARM workstations are first-class targets.
- **Compose**: a reference `docker-compose.yml` is published. SQLite + local filesystem + one configured model provider is enough for a single-user deployment.
- **Bare metal**: the service can also be run directly without containers for development.

### 10.5 GitHub as a dependency

GitHub itself is a non-replaceable dependency in v1 because the agent contribution workflow (§7.13) and the auth model (§9.1) are built on it. Supporting GitLab or Gitea would require generalizing the git host abstraction; this is recognized but out of scope for v1. The rest of the system carries no such dependency.

**Amended (v1.2): non-replaceable by design, not by scope.** The two reasons above are one reason. GitHub is the only SSO layer *because* it is the contribution host: requiring a GitHub token on every call is what makes every user a contributor under their own identity (§12), and a second identity provider would break that by admitting callers who cannot file. Generalizing the *git host* remains a legitimate future direction — a deployment whose upstream lives on GitLab would authenticate with GitLab, for the same reason — but adding an auth provider that is not the contribution host is a non-goal, not deferred work.

## 11. Success Metrics

- **Accessibility conformance**: percentage of output documents passing axe-core with zero violations at WCAG 2.2 AA.
- **Structural fidelity**: human-rated agreement between source document structure and output structure on a benchmark set.
- **Reading order accuracy**: human-rated reading-order correctness on a multi-column / mixed-layout benchmark set.
- **Agent library growth**: number of community-contributed agents and agent updates merged upstream per quarter.
- **Review loop efficiency**: distribution of iterations-to-clean across sessions; target median ≤ 2.
- **Feedback re-run rate**: fraction of sessions requiring a user feedback re-run; should trend down as agents mature.
- **PR-to-merge rate**: fraction of opened PRs that get merged upstream — signal for Builder Agent quality. **Amended:** contributions are filed as issues, not PRs (§7.13), so the measurable form is **issue-to-merge rate** — the fraction of filed suggestion/update issues that result in a merged change. Counted by **title prefix** (`New agent suggestion:` / `Agent update proposal:`), not by label: the issues carry no label, and counting by one would have undercounted anyway, since GitHub dropped it for any filer without push access (§7.13).
- **Contribution rate (v1.2)**: fraction of sessions that file at least one issue when the pipeline produced one to file. This measures §12's central claim — that using Iris and improving it are the same act — and separates "nothing to contribute" from "could not contribute": a deployment trending to zero here is misconfigured (a scope too narrow for a private upstream, a revoked service PAT), and the failures are otherwise only visible as `agent_issue_failed` lines in individual run logs.
- **Deployment reach**: number of distinct self-hosted deployments contributing PRs upstream — signal that the portability goal is being realized in practice.
- **Review verdict mix (v1.2)**: the ratio of `CHANGES_REQUESTED` to `APPROVED` among automated reviews (§7.14). This is a calibration metric, and it is two-sided — it has no target value and a low number is not automatically good. Measured baseline before the reachability bar: **34 blocking to 17 approving**, with single PRs reaching 12-to-1. Count model-authored reviews only — the timeout fallback always posts `--request-changes` by design, so including it inflates the numerator without saying anything about calibration. Drifting back toward that says the bar has eroded and blocking is being assigned by category again; a run of approvals on PRs that later needed fixes says the opposite. Read it against **reviews per merged PR**, since the same flattening also shows up as re-review churn on a PR whose delivered behaviour was already correct.

## 12. Sustainability

Equalify Iris is Open Source. Continued development, security review, and accessibility expertise — the work that keeps the agent library current and trustworthy — require a sustainable funding stream. The model:

- The code is free to use, modify, fork, and contribute to under the project's Open Source license.
- Iris is maintained by **Equalify Inc.**, the **University of Illinois Chicago**, and **California State University**. **Amended (v1.2):** maintenance is shared across those three institutions rather than held by one company. That is a fact about the project's governance with a consequence for this section: no single maintainer's commercial interest can be the whole funding story, and the design must not assume one — which is why the agent library's growth is tied to *users* contributing (below) rather than to a vendor's roadmap.
- Commercial hosting and support are offered by **[Equalify Inc.](https://equalify.app/)** and fund its share of continued development.
- The hosted and self-hosted versions are functionally identical. A commercial maintainer's value to paying customers is operational (managed deployment, monitoring, accessibility consulting), not feature gating.

#### Every user contributes

Money is one input; the other is **the agent library itself**, and that one cannot be bought. The agents in `agents/` improve because real sessions run against real documents and real corrections — a page the general extractor handled badly, a piece of feedback that generalizes past the document that produced it. Nothing else supplies that signal.

So it is not left to goodwill. **GitHub is the only SSO layer, and a user's GitHub token is required on every API call**, because that token is what files the session's contributions (§7.13 as implemented: issues, not PRs) under the user's own GitHub identity. Three things follow, and they are requirements on the implementation rather than observations about it:

- **There is no anonymous or API-key mode, and there will not be one.** An alternative credential would let a caller consume the library without refilling it, which is exactly the mode this design exists to prevent. This is why §9.1's "a GitHub token is required" survives even though its original justification (PR pushes) does not.
- **A deployment that cannot contribute is not a supported configuration**, and what enforces that has moved. There is no scope to set a floor on — a user's authorization carries no repository permission at all (§9.1 "What the token grants") — so a token can no longer be *configured* too narrowly to file. What can be wrong is the app: an OAuth App `client_id` is **refused at startup**, and the bundled app pointed at an `upstream_repo` it is not installed on **warns at startup**. Both exist for the reason the old scope floor did: the alternative symptom is a swallowed 403/404 in a run log while the deployment answers `200` and looks healthy. The one state neither can catch — the app not installed at all — is diagnosed at filing time instead.
- **Contributions are credited to the user who produced them.** Filing under the user's own identity is the reciprocity being asked for: the issue carries their name, and the library's growth is visibly the work of the people using it. It is also the *only* thing the user's authorization provides, which is why they authorize the app rather than it filing as itself. `github.issue_token` (a service PAT that files everything under one bot account) is an override for deployments an org policy forbids from filing as users; it is off by default and documented as not recommended.

Filing is a **soft** side effect in the failure direction only: a GitHub outage is logged (`agent_issue_failed`) and never fails a document the user has already paid for. It is not soft in the configuration direction — there is no request parameter, config key, or account setting that turns contribution off.

**Success metric (§11):** contribution rate — the fraction of sessions that produce at least one filed issue when the pipeline generated one to file. A deployment where that trends to zero is misconfigured, not frugal.

**Amended: the README requirement is about the contribution model, not a marketing notice.** This section used to require a "Sustainability notice" above the install instructions, with suggested copy pitching Equalify's hosting. That top-of-README notice was **removed deliberately** (commit `874e665`), and this amendment follows the decision rather than treating the README as out of compliance: whether the repo opens with a pitch is an editorial call for whoever owns the README, and a PRD that hardcodes promotional copy makes an ordinary edit look like a spec violation.

What the PRD does still require of the documentation, because these are claims about how the service behaves rather than positioning:

- **The token requirement and its reason must be documented where an operator will hit them** — that a GitHub token is required on every call, that it is required *so that every session contributes*, and that there is no way to opt out. Currently satisfied by the README's "GitHub is the only SSO layer, and tokens are required" section, `docs/API.md` §1, and `config.example.yaml`.
- **The absence of a scope must be documented as deliberate** (§9.1 "What the token grants"): the consent screen requests no repository access because `issues: write` comes from the app's installation. The operator-facing failures to document are consequences of that, not of a misconfigured scope — the app not being installed on `upstream_repo`, and `upstream_repo` pointed somewhere the app in use is not installed.
- **Maintainership and the funding model must be stated somewhere in the repo** — that Iris is maintained by Equalify Inc., the University of Illinois Chicago, and California State University; that commercial hosting and support fund Equalify's share; and that hosted and self-hosted are functionally identical with no feature gating. Currently in the README's License section and `CONTRIBUTING.md`. Placement and tone are not specified here, but the three maintainers should be named together wherever any one of them is.

A hosted UI should surface the contribution model at the point of login, where it is a fact the user needs (their token files issues under their name), not in a footer.

---

## Appendix A: Example Content Agent File (`agents/table.md`)

**Note (v1.2): this file no longer exists.** It is kept here as an illustration of the *file format* — the `## Purpose` / `## Required capability` / `## System prompt` / `## Output contract` sections the loader parses — which is unchanged and is what a specialist agent still looks like. What it is not is an example of a live agent: `table` is a type the general page pass covers, so a `table.md` is never dispatched (§7.4 v1.2). For a specialist that actually runs, see `agents/chartDataAgent.md`. The `@source` / `@end-source` wrapper in its output contract is also superseded (§7.4 v1.1).

```markdown
# Table Agent

## Purpose
Convert table content in source images to accessible HTML tables.

## Required capability
vision, structured_output
(The deployment's configured provider for these capabilities determines
which concrete model runs. See PRD §10.3.)

## System prompt
You are a specialist that converts tables visible in an image into accessible
HTML. You MUST:
- Use <table>, <caption>, <thead>, <tbody>, <th scope="col"|"row"> appropriately.
- Add <caption> describing the table's purpose if a title is visible nearby.
- Preserve row and column order exactly as in the image.
- Use <th scope="row"> for row headers when the leftmost column functions as labels.
- Mark any cells that appear cut off in the fragment log.
- Do NOT add any CSS, classes, or styling.

## Output contract
Return a single HTML fragment wrapped in @source / @end-source comments
(see PRD §7.4) and a fragment log entry listing any cut-off edges.
```
