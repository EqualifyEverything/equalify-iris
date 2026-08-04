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
   Across sessions, `defaults.max_concurrent_runs` (default 2, clamped to 1..32) bounds how many
   runs execute at once; further uploads wait in `status: "queued"` rather than being rejected.
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
- **Concurrency** (§9.4): two independent knobs under `defaults`.
  `extraction_concurrency` is *within* a run (pages in parallel);
  `max_concurrent_runs` is *across* sessions. Peak in-flight model calls is the product of the
  two, so the second is the one that bounds what the machine is doing — each run also holds a
  jsdom+axe instance. Uploads beyond the cap **wait**, in FIFO order, in `status: "queued"`; the
  wait appears in the session's run log as `run_queued` / `run_dequeued` (`waited_ms`). Nothing
  is rejected — the upload is already received and on disk, so a 429 would discard work the user
  has already paid for. The cap is global rather than per user because the resources it protects
  (memory, jsdom, the provider's rate limit) are global.
- **GitHub** (§9.1): OAuth is the auth mechanism — a user *is* their GitHub account. By default the
  service uses a **bundled OAuth App via the device flow** — no per-operator app setup, no
  secret (the same approach the `gh` CLI uses). Set `github.client_id` only to point at your
  own OAuth App; `client_secret` is needed only if you enable the web redirect flow.
  `github.oauth_scope` is the scope requested from the user, **`public_repo`** by default —
  see [Read this before you deploy](#read-this-before-you-deploy-token-storage) for why that
  default matters and when to change it.

### Read this before you deploy: token storage

**The user's GitHub token is stored in plaintext.** `users.github_token` in
`data/iris.sqlite` holds the OAuth access token as-is — no encryption, no hashing (it has to
be replayable, since it *is* the credential used to call GitHub). So **read access to that
file is API access to GitHub as every user who has ever logged in.** Anything with the
database has it: a backup, a synced folder, a stray `scp`, another process on a shared box, a
laptop that walks off.

What that is worth to an attacker depends entirely on the scope those tokens carry, which is
why `github.oauth_scope` defaults to the narrowest thing that works:

| `oauth_scope` | What a stolen database allows | When to use it |
| --- | --- | --- |
| `none` | Read the user's public profile | **Requires `issue_token`** — issues are filed by the service account and the user's token only identifies them |
| `public_repo` *(default)* | Write to the user's **public** repos | The default: upstream is public, users file their own issues |
| `repo` | **Push to every private repo the user can reach** | Only if your upstream is private |

"Request nothing" is spelled `none`, not `""`, and that is deliberate. An unset `${VAR}`
expands to an empty string before the config is read, so `oauth_scope: ${IRIS_SCOPE}` with the
variable missing would otherwise silently mean "ask for no scope" — and the resulting 403 when
a user tries to file an issue is swallowed as one log line. Every empty form (absent key,
valueless key, unset variable, quoted `""`) falls back to `public_repo`; only the literal word
turns the scope off.

The service needs exactly two things from a user's token: `GET /user` to identify them (no
scope required) and filing an agent-suggestion issue on the upstream (`public_repo` for a
public upstream). Nothing opens pull requests and nothing pushes — the fork-and-PR flow in
PRD §7.13 was never built. `repo` was requested until this default changed, which granted
read *and write* to all of a user's private repositories for a feature that does not exist.

**If you set `github.issue_token`**, every issue is filed by that service account and the
user's token does nothing but prove who they are — so set `oauth_scope: none` and the stored
tokens stop being worth stealing. That is the recommended production shape.

The two keys go together, and the service **refuses to start** if you set `none` without an
`issue_token`: a scopeless user token cannot file issues, and GitHub's 403 would otherwise turn
up only as an `agent_issue_failed` line in a run log. One consequence worth stating plainly:
there is no supported way to run with users identified but *nothing ever filed on their behalf*.
That shape would be `none` with no `issue_token`, which is the combination startup rejects — if
you want no contributions at all, the way to say so is to leave `oauth_scope` at its default and
ignore the issues, since the filing is a soft side effect either way. The two combinations startup *cannot*
check for are a private `upstream_repo` left on the `public_repo` default, and tokens issued
before you narrowed the scope — for those, a 403 during issue filing is logged with a `hint`
naming the configured scope.

Narrowing the request does **not** shrink a grant a user already made. Tokens issued under
`repo` keep it until revoked at
[github.com/settings/applications](https://github.com/settings/applications); only new
authorizations get the narrower scope. If you have been running with `repo`, treat the
existing rows as `repo`-scoped and consider clearing them so users re-authorize.

This is an accepted, documented limitation of v1, not an oversight — encrypting at rest on a
box that must also hold the key is close to no protection, and the real fix is to not hold a
long-lived credential at all (tracked in
[#29](https://github.com/EqualifyEverything/equalify-iris/issues/29), which moves the GitHub
surface out of this service). Until then: keep `data_dir` off shared storage, keep backups
encrypted, and prefer the `issue_token` + `oauth_scope: none` shape above.

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
  util/queue.ts          # bounded FIFO run queue (cross-session concurrency cap)
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
- **The flattened screen-reader view must never lose text (§7.8).** `flatten.ts` has two
  consumers, and both fail *silently* when text goes missing: the Reader reviews this view
  instead of the source images, so anything absent from it cannot be reported as an issue; and
  `contentCoverage` measures a candidate agent against an accepted fixture using these words, so
  text the view can't see is absent from both sides of the comparison. The second is the sharp
  edge — the regression gate exists to stop an agent update from dropping content, and it scored
  a table whose every row had been deleted as *perfect*, because the old implementation emitted
  a table's `<caption>` and returned. Inline elements (`a`, `img`, `em`, …) are now announced
  within the surrounding phrase and block elements are separate stops, with tables expanded row
  by row; `test/flatten.test.ts` asserts the invariant mechanically by deriving the expected word
  set from the DOM independently of `flatten`.

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
- **Both sides of the eval gate must score fixtures by the same rule (§7.12).** Before proposing
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
  purely a property of the fixture, and a **still-open hole**: if the *current* prompt flakes to no
  output on a fixture the candidate handles, the current side is deflated and the bar drops. One
  unjudgeable fixture the current prompt flakes on plus one judgeable at 0.98 gives current
  `(0 + 0.98)/2 = 0.49`, while the candidate abstains on the short one and scores 0.88 — so
  `0.88 < 0.49 - 0.02` is false, 0.88 clears the 0.85 floor, and a real 0.10 regression passes both
  gates. Closing it means distinguishing "this prompt failed" from "this fixture cannot be judged"
  per side, which changes what the mean measures; it is not a scoring-rule question, and no test
  covers that direction yet.
- **`GET /v1/sessions` pages on a compound cursor (§9.2 v1.1).** The PRD names a `cursor`
  parameter without saying what is in it, and the obvious reading — the last row's
  `created_at` — is unsound: `created_at` is a millisecond timestamp assigned by a request
  handler, so a burst of uploads ties on it, and paging on a non-unique key skips rows
  (`created_at < ?` drops the rest of a tied group) and can repeat them (nothing pins the
  order among ties). `next_cursor` is therefore `"<created_at>|<session_id>"`, the full sort
  key; clients pass it back verbatim. A cursor that doesn't parse is a `400`, not a silent
  restart at page one, and `next_cursor` is `null` on a full final page — so clients stop on
  a null cursor rather than on a short page.
- **Runs are queued, and the queue is in-process (§9.4).** A bounded FIFO queue
  (`src/util/queue.ts`) caps concurrent pipelines at `defaults.max_concurrent_runs`; sessions over
  the cap wait in `queued`. Two things this deliberately does *not* do. It does not persist: the
  queue lives in the process, so a restart loses waiting runs — they are marked `failed`
  ("interrupted (server restarted)") by the same `failStaleSessions()` sweep that already handled
  interrupted `running` sessions, which is why that sweep covers `queued` too. And it does not
  bound upload memory: multer parses the whole body before any handler runs, so by the time the
  queue sees a session its images are already buffered in RAM (ceiling: multer's own
  `limits.fileSize` × part count) and any PDF is already rasterized to full-page 150-DPI PNGs.
  Both are consequences of the single-instance, single-process design the store declares.
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
  PRD's `triage` (§7.2) and `reconciliation` (§7.6) are not implemented — reconciliation is
  unreachable while extraction hardcodes `edges: []` — so they are not in the enum and not
  emitted (§9.2 v1.1). New sessions start at `extraction`; they used to be created at `triage`
  and overwritten before a client could observe it.

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
