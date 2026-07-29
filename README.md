# Equalify Iris

**Image-to-Accessible-HTML parsing service.** Iris converts a sequential set of image files
(e.g. the rendered pages of a PDF) into a single content-only, WCAG 2.2 AA accessible HTML
document, using specialized per-content-type agents, a self-extending builder, and an
iterative reader/copy-editor review loop.

> ## Sustainability
>
> **Equalify Iris is Open Source.** Sustainability is key to sustaining its growth. With that
> in mind, we hope you use and alter the codebase.
>
> Iris is built by **Equalify Inc** ([https://equalify.app/](https://equalify.app/)). Continued
> support and development are paid for when you hire us to host or support any instance. Please
> consider hiring us.

---

## How it works

The pipeline as **implemented today** runs in three phases:

1. **Extraction** — for each page image, the `page` agent (`agents/page.md`) converts the whole
   page to an accessible HTML fragment in one vision call. The output is then verified, and
   corrected if the verifier objects. If the page agent names a content type a specialist would
   handle better, that specialist is dispatched and its output merged. Pages are independent, so
   they are extracted **in parallel** — up to `defaults.extraction_concurrency` at a time
   (default 5, clamped to 1..16). Fragments keep submitted document order regardless of which
   page finishes first; lower it if your provider rate-limits you, or set `1` for fully serial.
2. **Assembly** — fragments are joined in page order into a minimal accessible document shell
   (`<html lang>`, `<title>`, `<main>`) and validated with axe-core.
3. **Review** — the Reader reads the document in chunks as two views (HTML + a flattened
   screen-reader view) and flags reading-order / semantic / accessibility issues, attributing
   each to the source page(s) it appears on; the Copy Editor proposes fixes against **just those
   pages'** source images; fixes are applied and the document re-linted. Loops up to
   `max_review_iterations` (default 3).

> **The PRD (§6) specifies five phases** — Triage → Extraction → Reconciliation → Assembly →
> Review. **Triage, Reconciliation, and the Builder Agent's session-scoped drafting are not
> implemented.** Extraction runs one general page agent instead of triage-then-fan-out, because
> the fan-out produced duplicated output for nested structures like forms. Reconciliation is
> currently unreachable: `extraction.ts` emits no fragment edge data, which is the input
> reconciliation would need. Treat the three phases above — not the PRD's five — as the
> description of what runs. See [Implementation notes](#implementation-notes--prd-coverage).

When Iris meets content a specialist agent would handle better than the general pass, it drafts
that agent and **automatically files a labeled `iris-agent-suggestion` GitHub issue** (with the
agent code + context) on the upstream repo. Maintainers triage those issues; merged agents
become part of the shared `agents/` library. (This replaces the PRD's fork+PR-on-close flow —
see Implementation notes.)

## Quick start

Requires **Node.js 24+** (the service runs TypeScript directly via Node's built-in type
stripping and uses the built-in `node:sqlite`), and a **git** checkout of the agent library
(this repo's `agents/` directory works). For **PDF uploads**, install **poppler-utils**
(`pdftoppm`/`pdfinfo`) — `brew install poppler` on macOS, `apt-get install poppler-utils` on
Debian/Ubuntu. (The Docker image includes it.)

```bash
git clone https://github.com/EqualifyEverything/equalify-iris
cd equalify-iris
npm install

cp .env.example .env          # fill in GitHub OAuth + a model provider key
cp config.example.yaml config.yaml

# load env and run
set -a; source .env; set +a
npm start                     # -> http://localhost:8080
```

Or with Docker (multi-arch; Mac Mini / Linux ARM are first-class targets):

```bash
cp .env.example .env          # fill in values
docker compose up
```

Check it's alive:

```bash
curl http://localhost:8080/v1/health
```

Or just open the **accessible browser app** at the root for a no-API walkthrough (sign in with
GitHub → upload page images → convert → view the accessible HTML):

```
http://localhost:8080/
```

## Configuration

Deployment is configured in `config.yaml` (PRD §10.3). `${ENV_VAR}` references are expanded
from the environment at startup; changes require a restart.

- **Storage** (§10.2): local filesystem + a single SQLite file by default. `agents/` is a git
  checkout modified only by `git pull` from upstream.
- **Model providers** (§10.3): each agent declares a *capability* (`vision`,
  `structured_output`, `text`); the deployment maps capabilities to a provider + concrete
  model. v1 ships **OpenRouter** and **Amazon Bedrock** adapters. Adding a provider is a small
  adapter implementing the `ModelProvider` interface in `src/providers/types.ts`. Models are
  set per provider (`default_model` + `per_capability`), and can be overridden **per agent** via
  `providers.per_agent` — either a string (provider only) or `{ provider, model }`. Resolution
  falls back: per-agent model → provider `per_capability` → provider `default_model`.
  Each provider also takes `max_tokens` (default 32000), the per-call **output** ceiling. A
  response that stops at the ceiling is a **failed** call, not a short one: it arrives as a 200
  with HTML cut mid-tag, which would otherwise be assembled into the deliverable as if it were
  genuine content. Both adapters reject it and the error names the knob to raise.
- **GitHub** (§9.1): OAuth is the auth mechanism — a user *is* their GitHub account. By default the
  service uses a **bundled OAuth App via the device flow** — no per-operator app setup, no
  secret (the same approach the `gh` CLI uses). Set `github.client_id` only to point at your
  own OAuth App; `client_secret` is needed only if you enable the web redirect flow.

## API

All endpoints are under `/v1` and (except auth and health) require
`Authorization: Bearer <github_token>`.

| Method & path | Purpose |
| --- | --- |
| `GET  /v1/health` | Liveness probe |
| `GET  /v1/auth/github/start` | Begin OAuth (web clients) |
| `GET  /v1/auth/github/callback` | OAuth callback → returns access token |
| `POST /v1/auth/github/device` | Begin device flow (CLI clients) |
| `POST /v1/auth/github/device/poll` | Poll device flow (send `{ "device_code": ... }`) |
| `GET  /v1/me` | Current GitHub user + config |
| `GET  /v1/sessions` | List the caller's sessions |
| `POST /v1/sessions` | Create a session, upload images and/or PDFs (`multipart/form-data`) |
| `GET  /v1/sessions/{id}` | Poll status |
| `GET  /v1/sessions/{id}/output` | Fetch the HTML when ready |
| `POST /v1/sessions/{id}/feedback` | Submit feedback, trigger a re-run |
| `POST /v1/sessions/{id}/close` | Finalize the session and clean tmp |
| `GET  /v1/sessions/{id}/logs` | Fetch the run log (ndjson) |
| `GET  /v1/sessions/{id}/diagnostics` | Timing/health summary (phase + per-call durations, in-flight/hung call) |

Full copy-pasteable bash/curl walkthrough of every endpoint: **[docs/API.md](docs/API.md)**.
To prove the endpoints work end-to-end (mock GitHub + mock model, no credentials needed):
`./test/e2e.sh`.

Example — create a session (order of `images` parts is the processing order, §9.2):

```bash
curl -X POST http://localhost:8080/v1/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -F "images=@page-001.png" \
  -F "images=@page-002.png" \
  -F 'config={"max_review_iterations": 3}'
```

Then poll `GET /v1/sessions/{id}` until `status` is `ready_for_review`, fetch
`GET /v1/sessions/{id}/output`, and `POST /v1/sessions/{id}/close` to finalize.

## Layout

```
agents/                  # the agent library (git checkout; v1 content agents)
src/
  config.ts              # config loader (${ENV} expansion)
  providers/             # ModelProvider interface + openrouter & bedrock adapters
  agents/loader.ts       # loads agent .md files, pins git SHA (§7.3)
  pipeline/
    orchestrator.ts      # runs the phases, persists results, drives learning
    extraction.ts        # per-page vision pass (+ verify, correct, specialist merge)
    assembly.ts          # joins fragments into the document shell
    review.ts            # reader -> copy editor -> re-lint loop (scoped image payload)
    pageindex.ts         # page-number index shared by the reader + feedback scoping
    lint.ts              # axe-core in jsdom (color-contrast disabled, see §4)
    flatten.ts           # screen-reader text view, used by reader + coverage
    feedback.ts          # verify / scope / classify / train + regression gate
    memory.ts            # per-agent example bank of learned corrections
    regression.ts        # fixture capture + pruning on close
    contribute.ts        # drafts suggested agents, files issues
  auth/                  # GitHub OAuth + device flow + bearer middleware
  github/                # auto-files labeled agent-suggestion issues
  store/                 # node:sqlite metadata store + on-disk session layout (§8.1)
  routes/                # /v1 endpoints
  index.ts               # server entry point
data/                    # sessions/, tmp/, and the SQLite DB (created at runtime)
```

## Implementation notes & PRD coverage

Where v1 **diverges from the PRD** (read these before assuming a PRD section describes the
code — tracked in [#30](https://github.com/EqualifyEverything/equalify-iris/issues/30)):

- **Three phases, not five (§6).** Triage and Reconciliation are not implemented, and the
  Builder Agent does not draft session-scoped agents into `tmp/<id>/agents/`. Extraction is a
  single general page agent rather than triage → per-region fan-out; the fan-out was removed
  because it duplicated output for nested structures like forms. Reconciliation additionally
  cannot run until extraction emits fragment edge data (it currently emits none).
- **No provenance comments in the output (§7.4/§7.7).** The PRD specifies `@source` / `@agent` /
  `@fragment` wrappers preserved into the final HTML. Iris delivers clean content-only HTML
  instead: the comments leak pipeline internals into a document meant to be handed to end users,
  and every consumer would have to strip them. Provenance is recorded in the run log
  (`GET /v1/sessions/{id}/logs`) rather than in the deliverable. `@unresolved` **is** emitted
  when the review loop hits its iteration cap with issues outstanding (§7.11).
- **Contributions are issues, not PRs (§7.13/§9.2).** Instead of fork+PR-on-close, when the
  extractor flags content a specialist would handle better, Iris drafts that agent and files a
  labeled `iris-agent-suggestion` GitHub issue with the agent code + context. Simpler to triage,
  and it needs no write access to a fork. Consequently the PRD's `pending_prs` and `prs_opened`
  response fields and the `skip_prs` parameter are **not** part of the API.
  By default the issue is filed with the logged-in user's token; set `IRIS_GITHUB_TOKEN` to file
  everything under a service account instead.
- **Review issues are attributed by page, not by `@source` region (§7.8/§7.9).** The PRD's issue
  format references `@source` region ids from the per-region fan-out, which extraction no longer
  produces and which are stripped from the deliverable anyway (§7.4 v1.1). Issues instead carry
  `pages: number[]` — the source pages the Reader matched the offending content to, from an index
  of page-number + extracted-HTML excerpt. Attribution is what scopes the Copy Editor's image
  payload (below); the two-view (HTML + flattened) cross-check is implemented as specified.

Places where the PRD left a decision open, and where v1 intentionally stops:

- **`runs/<run-id>` vs `sessions/<session-id>`.** The PRD references both (§7.3/§7.5 vs §8.1).
  This implementation treats the run id as the session id and writes the log, `new-agents.md`,
  etc. under `sessions/<session-id>/`, matching the authoritative layout in §8.1.
- **Reader chunking (§7.8).** Chunks use a fixed character budget with overlap rather than a
  literal 30%-of-context computation, since the per-model context window is not exposed through
  the provider abstraction. The two-view (HTML + flattened) cross-check is implemented as
  specified.
- **Color-contrast lint.** Output is content-only with no styling (§4), so axe-core's
  `color-contrast` rule is disabled — it cannot be assessed without rendering and is out of
  scope.
- **Copy Editor image payload (§7.9).** When every issue in a round is attributed to a page, the
  editor gets only those pages' images (logged per round as `editor_images`). Attaching every
  page's image on every round is the dominant per-round cost of the review loop — on a 25-page
  document that is 25 base64 PNGs × up to `max_review_iterations`. Narrowing requires *full*
  attribution: one unattributed issue re-broadens the round to every image. An unattributed issue
  is usually structural and fixable from the HTML alone, but it is also what a heavily
  editor-rewritten body looks like once it no longer matches the source excerpts — so narrowing
  wrongly can leave a real issue unfixed at the iteration cap, while broadening wrongly costs no
  more than the behavior this optimization replaced.
- **Provider retries are not symmetric in code, but are in behavior.** OpenRouter retries by hand
  (3 attempts, exponential backoff) because `fetch()` has no retry strategy. Bedrock has no retry
  loop *on purpose*: the AWS SDK already applies its `standard` strategy — also 3 attempts with
  exponential backoff — to throttling, 5xx, and node network errors, while failing fast on 4xx.
  Verified empirically against a stubbed request handler (3 wire attempts for 503/429/ECONNRESET,
  1 for a 400). Adding a loop around it would give Bedrock 9 attempts to OpenRouter's 3.
- **Feedback re-runs (§7.12).** Re-runs are logged separately (a `feedback_rerun` event) and the
  prior `output.html` is snapshotted to `sessions/<id>/history/` so it can be reverted to. A
  revert *endpoint* is out of v1 API scope (not in §9); the data is preserved to enable it.

  A re-run is **routed** first (`feedback_scoped` event). The Reader only ever sees the assembled
  HTML (by design, §7.8), so feedback about what was *read off a page* ("the revenue figure on
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
Intentionally **not** built in v1 (the PRD frames each as optional / alternative / out of scope):
PostgreSQL and S3 backends (§10.2 — "supported alternative," SQLite + local FS is the v1
reference), the per-user config endpoint (§9.1 — "not specified in v1"), and webhooks (§9.4 —
out of scope). The only endpoint beyond the PRD is `GET /v1/health`, a standard liveness probe.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md). Found an
accessibility barrier — in the app or in the HTML it produces? Please open an
[Accessibility issue](.github/ISSUE_TEMPLATE/accessibility.yml); those are our top priority.

## License

**[GNU AGPL-3.0-or-later](LICENSE).** Iris is copyleft: if you modify it and run it as a
network service, you must make your modified source available to its users (AGPL §13). The
hosted and self-hosted versions are functionally identical — see the Sustainability notice
above, and please consider hiring Equalify to host or support your instance.
