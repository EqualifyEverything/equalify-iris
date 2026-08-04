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
- **Make upstream GitHub PR the only path to permanent agents.** A session-built agent persists in a user's local `agents/` directory only after the user opens a PR, the upstream maintainer merges it, and the user pulls the updated repo. There is no local promotion path. This enforces upstream review as the floor of trust for every agent that ever runs.
- Reconcile fragments that span image boundaries.
- Verify output with a reader-style agent that flags reading-order and consistency issues, with a bounded refinement loop.
- Accept user feedback and re-run the pipeline with that feedback as a first-class input.

## 4. Non-Goals

- **Styling**: no CSS, no visual fidelity to the source. Content and semantics only.
- **Pixel-perfect layout reproduction**: a two-column source becomes linear semantic HTML.

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

## 7. Detailed Requirements

### 7.1 Input

- An ordered set of image files (PNG, JPEG, TIFF, WebP). Order is significant.
- Optional run configuration:
  - `max_review_iterations` (default `3`)
  - `feedback` (string, optional — present on re-runs)

Accessibility target is fixed at WCAG 2.2 AA for v1 and is not user-configurable. The pipeline runs sequentially — there is no concurrency option in v1.

### 7.2 Image Analysis Agent (Triage)

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

**Initial agent set (v1)**:
- `paragraph.md`
- `heading.md`
- `list.md`
- `table.md`
- `formField.md`
- `image.md` (for embedded images requiring alt text)
- `quote.md`
- `caption.md`
- `footnote.md`

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
- Logs the creation to `runs/<run-id>/new-agents.md` with a summary of what the new agent does, why it was created, and the image region that triggered it.
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

### 7.7 Assembly

**Purpose**: Combine all fragments into one HTML document in image order.

**Behavior**:
- Wraps the content in a minimal accessible document shell: `<html lang>`, `<head>` with `<title>`, `<body>` with `<main>`.
- Strips the `@source`, `@agent`, `@fragment`, and `@reconciled` provenance comments — they served the pipeline up to this point and are not part of the deliverable (see the v1.1 amendment in §7.4). Provenance is recorded in the run log instead.
- Validates the document parses and basic accessibility lint passes (axe-core in headless mode).
- Lint failures are surfaced to the Reader as input.

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

- The user's GitHub credential is the same credential they authenticated with (see §9.1). OAuth requires `repo` scope, so every authenticated user can open PRs. **Amended (v1.1): the requested scope defaults to `public_repo` and is per-deployment — see §9.1 "What the token grants".** Nothing in this section is implemented (contributions are filed as labeled issues), so the scope it assumes is not requested; a deployment that later builds this flow has to raise the scope deliberately.
- The upstream repository is determined by the service's `agents/` git checkout — its `origin` remote is the PR target. This is a per-deployment setting, not a per-user one.
- PRs are opened from the user's fork of the upstream. The service creates the fork on the user's account on first close, if it does not already exist.
- All PR activity is logged in the session record. Closing or rejecting a PR upstream does not affect the produced HTML — the HTML has already been generated using the session-built agent recorded inline in `log.jsonl`.

**Opt-out**:

- A user who does not want to contribute the agents from a given session can pass `?skip_prs=true` to `/close`. The HTML is finalized and the session-built agents are discarded without PRs being opened.

## 8. File and Directory Layout

### 8.1 Layout

```
project/
├── agents/                 # the agent library — modified ONLY by `git pull` from upstream
│   ├── paragraph.md
│   ├── heading.md
│   ├── table.md
│   ├── formField.md
│   └── …
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

GitHub OAuth is the only auth mechanism. See §9.1 for why.

### 9.1 Authentication

Authentication is GitHub OAuth. A user *is* their GitHub account. The first time a GitHub user authenticates, an account is provisioned automatically — login is signup. There is no separate signup form, no email or password, and no service-issued credential to manage.

**OAuth is required, not optional.** The token that authenticates a request is the same token used to open pull requests on `/close`. Without OAuth the service has no way to push a PR on the user's behalf, and PR push is the only path by which agents persist (§7.13). Alternative auth schemes (API keys, pasted PATs, basic auth) would either skip the PR step or require the user to manage a credential manually — both are non-goals.

#### OAuth flow (web clients)

1. Client redirects the user to `GET /v1/auth/github/start`.
2. Server redirects to the GitHub consent screen requesting `github.oauth_scope` (`public_repo` by default — see "What the token grants" below; `repo` in the original spec).
3. User approves; GitHub redirects to `GET /v1/auth/github/callback?code=…`.
4. Server exchanges the code for a GitHub access token, calls `GET https://api.github.com/user` to identify the user, provisions the account if new, and returns the token to the client.
5. Subsequent requests use `Authorization: Bearer <github_token>`.

#### OAuth device flow (CLI clients)

CLI clients without a browser use GitHub's OAuth device flow, surfaced by the service:

1. Client calls `POST /v1/auth/github/device`. Server initiates the device flow with GitHub and returns a `user_code` and `verification_uri`.
2. Client displays both to the user and instructs them to visit the URL in a browser and enter the code.
3. Client polls `POST /v1/auth/github/device/poll` until the user approves or the request times out.
4. On approval, the polling endpoint returns a GitHub access token. The CLI stores it locally.
5. Subsequent requests use `Authorization: Bearer <github_token>`.

This is the same pattern GitHub's own CLI uses.

#### What the token grants

The token authenticates the caller (via GitHub's user endpoint) and opens PRs on `/close`. Required scope is `repo`. The consent screen requests it; a user who declines `repo` cannot complete OAuth, and therefore cannot use the service. This is deliberate — the system has no useful mode for an authenticated user who cannot contribute back.

**Amended (v1.1): the requested scope is per-deployment and defaults to `public_repo`.** This section derives `repo` from a premise that no longer holds: nothing opens PRs or pushes (§7.13's fork-and-PR flow was never built — contributions are filed as issues), so the token needs only two things. Identifying the caller via `GET /user` requires **no scope at all** — `id` and `login` are public fields. Filing an agent-suggestion issue on a public upstream requires `public_repo`. `repo` additionally grants read *and write* to every private repository the user can reach, for a capability the service does not have.

That over-grant compounds with how the token is stored (below) rather than sitting beside it: it is persisted in plaintext, so the requested scope is exactly the answer to "what does a copy of the database allow". The scope is therefore configurable per deployment (`github.oauth_scope`) with three intended settings:

| Value | Rationale |
| --- | --- |
| `none` | The deployment sets `github.issue_token`, so the user's token only ever identifies them. Recommended for production. |
| `public_repo` | Default. Public upstream; each user files their own issues. |
| `repo` | Required only when the upstream repository is private. |

`none` is sent as **no** `scope` parameter rather than as `scope=`, which is the form GitHub documents for requesting no scopes. It is a word rather than an empty string because `${VAR}` expansion turns an unset variable into `""` before the config is normalized, so an empty value cannot be distinguished from a missing one — every empty form falls back to `public_repo`, and only the literal `none` disables the scope. And narrowing what is requested does not narrow a grant already made: tokens issued under `repo` retain it until the user revokes the authorization, so a deployment that has been running with `repo` should treat existing rows as `repo`-scoped.

The last sentence above still holds in spirit — a user who declines cannot use the service — but the thing being declined is now much smaller.

#### How the token is stored (v1.1)

This specification never said, and the implementation's answer is worth stating rather than leaving to be discovered: **the user's access token is stored in plaintext**, in `users.github_token` in the service's SQLite database. It has to be replayable, because it *is* the credential used to call GitHub on the user's behalf, so it is not hashed.

The consequence follows directly: **read access to the database file is GitHub API access as every user who has ever authenticated**, at whatever scope those tokens carry. A backup, a synced directory, another process on a shared host, or a lost laptop are all sufficient.

This is an accepted v1 limitation, not an oversight, and it is why the scope default above matters as much as it does:

- **Encryption at rest does not fix it here.** §10.1 requires a deployment to run on a laptop with no managed dependencies, so the key would live on the same machine as the database — which is most of the way back to plaintext. A real fix needs a KMS or an operator-managed secret, and therefore a dependency §10.1 forbids requiring.
- **Not holding the credential is the actual fix.** Short-lived tokens need a refresh credential, which needs the same key management. Moving the GitHub surface out of this service (so it holds no long-lived user credential at all) removes the reason to store anything — storing nothing beats encrypting something.
- **What v1 does instead**, and what an operator must be told: request the narrowest scope that works (above), and state the exposure in the deployment documentation so the risk can be weighed rather than discovered. A deployment that sets `github.issue_token` and `oauth_scope: none` stores tokens that grant nothing beyond reading a public profile, which is the recommended shape. Those two keys are validated as a pair at startup, since `none` without a service token leaves issue filing unable to work and GitHub's 403 would otherwise surface only in a run log.

#### User identity and isolation

The user is identified by their GitHub numeric user ID (stable across login renames). Sessions are scoped to that user; a token cannot see or modify sessions owned by a different GitHub user.

#### Per-deployment configuration (not per-user)

Two things are configured at deployment time, not per user:

- **The agent library upstream.** The service's local `agents/` directory is a git checkout of one upstream repo (its `origin` remote). All PRs target that upstream. Users who want a different upstream run their own deployment pointing at their own checkout.
- **PR fork behavior.** PRs are opened from each user's GitHub fork of the upstream. If the user does not already have a fork, the service creates one on their account (this is what `repo` scope is for) before pushing. **Amended (v1.1):** unimplemented, and the scope it assumes is no longer requested by default — see §9.1 "What the token grants" and §7.13.

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
  -F "images=@page-003.png" \
  -F 'config={"max_review_iterations": 3}'
```

Each `-F "images=@…"` adds another image part to the request body. The server reads them in order.

Request parts:

- `images` (repeated): one image file per part (PNG, JPEG, TIFF, WebP). At least one required. No fixed maximum in v1; per-account limits are enforced at the account level.
- `config` (single JSON part, optional):
  ```json
  { "max_review_iterations": 3 }
  ```

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

## 11. Success Metrics

- **Accessibility conformance**: percentage of output documents passing axe-core with zero violations at WCAG 2.2 AA.
- **Structural fidelity**: human-rated agreement between source document structure and output structure on a benchmark set.
- **Reading order accuracy**: human-rated reading-order correctness on a multi-column / mixed-layout benchmark set.
- **Agent library growth**: number of community-contributed agents and agent updates merged upstream per quarter.
- **Review loop efficiency**: distribution of iterations-to-clean across sessions; target median ≤ 2.
- **Feedback re-run rate**: fraction of sessions requiring a user feedback re-run; should trend down as agents mature.
- **PR-to-merge rate**: fraction of opened PRs that get merged upstream — signal for Builder Agent quality.
- **Deployment reach**: number of distinct self-hosted deployments contributing PRs upstream — signal that the portability goal is being realized in practice.

## 12. Sustainability

Equalify Iris is Open Source. Continued development, security review, and accessibility expertise — the work that keeps the agent library current and trustworthy — require a sustainable funding stream. The model:

- The code is free to use, modify, fork, and contribute to under the project's Open Source license.
- Iris is built and stewarded by **Equalify Inc** ([https://equalify.app/](https://equalify.app/)). Commercial hosting and support are offered by Equalify and fund continued development of the Open Source project.
- The hosted and self-hosted versions are functionally identical. Equalify's value to paying customers is operational (managed deployment, monitoring, accessibility consulting), not feature gating.

**README requirement**: the repository's `README.md` must include a sustainability notice prominently, placed above install or usage instructions so anyone landing on the repo sees it on first scroll. The same notice should appear in any hosted UI's footer or About page.

Suggested copy:

> ## Sustainability
>
> **Equalify Iris is Open Source.** Sustainability is key to sustaining its growth. With that in mind, we hope you use and alter the codebase.
>
> Iris is built by **Equalify Inc** ([https://equalify.app/](https://equalify.app/)). Continued support and development are paid for when you hire us to host or support any instance. Please consider hiring us.

---

## Appendix A: Example Content Agent File (`agents/table.md`)

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
