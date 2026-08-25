# Equalify Iris

**Image-to-Accessible-HTML parsing service.** Iris converts a sequential set of image files
(e.g. the rendered pages of a PDF) into a single content-only, WCAG 2.2 AA accessible HTML
document, using specialized per-content-type agents, a self-extending builder, and an
iterative reader/copy-editor review loop.

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
   `max_review_iterations` (default 3) — or until a round changes nothing, since an editor that
   answers and hands back the document it was given would answer the same way next round. A document that spans several chunks is read
   **in parallel** — the chunks are independent calls over one unchanging body — up to the same
   `defaults.extraction_concurrency` at a time, and the issues they raise stay in chunk order.

When Iris meets content a specialist agent would handle better than the general pass, it drafts
that agent and **automatically files a GitHub issue titled `New agent suggestion: <type>`** (with
the agent code + context) on the upstream repo. Maintainers triage those issues; merged agents
become part of the shared `agents/` library. (This replaces the PRD's fork+PR-on-close flow —
see Implementation notes.)

Those issues are identified by their **title prefix**, not by a label, and deliberately so: GitHub
silently drops labels set by anyone without push access to the repo, which is most of the people
this is built for. A label would therefore have been missing on exactly the issues that most needed
it, with nothing to say so — and the duplicate check that filtered on it would have refiled the same
suggestion every session, under a different person's name each time. If you want labels on these,
add a repository rule keyed on the title prefix; it applies them as the repo rather than as the
filer, so it works no matter who filed.

## Quick start

Requires **Node.js 24+** (the service runs TypeScript directly via Node's built-in type
stripping and uses the built-in `node:sqlite`), and a **git** checkout of the agent library
(this repo's `agents/` directory works). For **PDF uploads**, install **poppler-utils**
(`pdftoppm`/`pdfinfo`, plus `pdftohtml` to carry the PDF's links into the output) —
`brew install poppler` on macOS, `apt-get install poppler-utils` on Debian/Ubuntu. (The
Docker image includes it.) `pdftoppm` renders one page at a time on one core, so Iris
divides a PDF's page range between several of them — up to one per core the host
reports, and never more than the document has pages: a 25-page document that took 12.5 s
in one process takes 3.9 s across four. (Past about a dozen cores a 25-page document
stops getting faster, since the shards are already down to two pages each.) It is the
uploader who waits for this — the route rasterizes before it answers — so cores are
worth giving a deployment that takes PDFs. The budget is shared across concurrent
uploads rather than granted to each: a second document arriving mid-render takes what is
left, down to the single process it would have had before.

```bash
git clone https://github.com/EqualifyEverything/equalify-iris
cd equalify-iris
npm install

cp .env.example .env          # a model provider key; GitHub App settings are optional
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
  Both adapters **stream** their responses, to tell a stalled call apart from a slow one. A
  single non-streaming request cannot: "no answer yet" describes a dead socket and a large
  document being correctly rewritten equally well, so a total-duration cap kills both — and the
  review phase's document-level rewrite (whole body in, whole corrected body out) is the call
  slow enough to be killed. The limits are therefore about *silence*, not duration, and there
  are three of them in both adapters. **120s** to produce anything at all, since before the
  first token a slow call and a dead one look identical and that phase is where the whole
  prompt — a document plus its page images — gets processed. Then **60s** of silence once
  output is arriving, where a gap really does mean the stream died. Work that keeps arriving
  runs as long as it needs, bounded only by a deliberately generous **15-minute** backstop for
  a stream that trickles without ever finishing. Protocol events keep a call alive but do not
  end the start-up phase: only actual output does, so a stream that opens with a role-only
  delta or a `message_start` still gets its full 120s. Each limit is a distinct error naming
  which one it hit and how much had streamed, since "never started", "stopped halfway" and
  "never converged" call for different responses.
  A **keepalive is not progress** in either adapter — Bedrock's `ping`, OpenRouter's
  `: OPENROUTER PROCESSING` comment. Letting one reset the clock would defeat the timeout in the
  one case it exists for: a generation that hangs behind a connection that stays chatty.
  Finally, a stream **ending** is not a response completing, and the two are checked in both
  directions. A terminal event (`message_stop` / `[DONE]`, or a stop reason) is required, because
  an event stream that stops early would otherwise deliver a half-corrected document as a
  successful result — the same failure the truncation guard exists to prevent, arriving by a
  different road. Conversely the terminal event ends the read then and there, so a connection
  held open after the message is finished cannot let the silence clock discard a whole document.
- **Concurrency** (§9.4): two independent knobs under `defaults`.
  `extraction_concurrency` is *within* a run — pages in parallel during extraction, and during
  review both the Reader's chunk reads and the section calls a too-long correction round is
  re-made with, all under that one cap, so a run's in-flight calls never exceed it in either
  phase; `max_concurrent_runs` is *across* sessions. Peak in-flight model calls is the product of the
  two, so the second is the one that bounds what the machine is doing — each run also holds a
  jsdom+axe instance. Uploads beyond the cap **wait**, in FIFO order, in `status: "queued"`; the
  wait appears in the session's run log as `run_queued` / `run_dequeued` (`waited_ms`). Nothing
  is rejected — the upload is already received and on disk, so a 429 would discard work the user
  has already paid for. The cap is global rather than per user because the resources it protects
  (memory, jsdom, the provider's rate limit) are global.
- **Request limits** (§9.4): the run cap bounds work the deployment has *accepted*;
  `server.rate_limits` bounds what can be **asked** of it, which is a different problem — the cheap
  endpoints never reach the queue, and every one of them queries SQLite *synchronously* on the one
  event loop. Per minute: `general_per_minute` across `/v1` (240, liveness probe exempt),
  `auth_per_minute` on `/v1/auth` (60 — each device-flow poll costs an outbound call to GitHub, so
  this protects your GitHub rate limit rather than a password), `upload_per_minute` on session
  creation (12), plus `max_upload_memory_mb` (256), which meters the **bytes** of upload body
  arriving at once so that concurrent *small* uploads never wait on each other. These gates
  **refuse** (429 with `Retry-After` and the standard error body) rather than wait, since nothing
  has been received yet — the opposite of the run cap, for the same reason. A request counts
  against its GitHub token once validated and against its address otherwise, so one user's polling
  cannot spend everyone's budget from behind a shared NAT. `GET /v1/limits` publishes whatever is in
  effect. Set `enabled: false` to turn it off where a proxy already does the job.
- **Behind a reverse proxy**: set `server.trust_proxy` to the number of proxies in front of Iris
  (1 for a single Caddy/nginx). Without it every caller presents as the proxy's address and shares
  one rate-limit bucket — the log warns when it sees an `X-Forwarded-For` while this is unset.
  `true` is coerced to 1 with a warning: trusting the whole chain means trusting the part of the
  header a client wrote, which would make the per-address limits bound nothing. Express's own
  vocabulary (`loopback`, or a list of proxy addresses and subnets) works too; anything it cannot
  interpret warns and trusts nothing, rather than taking the process down at startup.
- **GitHub** (§9.1): GitHub is the auth mechanism — a user *is* their GitHub account, and a token
  is **required** on every call. By default the
  service uses a **bundled GitHub App via the device flow** — no per-operator app setup, no
  secret (the same approach the `gh` CLI uses). Set `github.client_id` only to point at your
  own GitHub App; `client_secret` is needed only if you enable the web redirect flow.
  **No OAuth scope is requested at all** — the app's one permission comes from installing it on
  `upstream_repo` — see [GitHub is the only SSO layer](#github-is-the-only-sso-layer-and-tokens-are-required).

### GitHub is the only SSO layer, and tokens are required

There is no anonymous mode, no API key, and no second identity provider. Every request carries a
user's GitHub token, and that token is what files the session's feedback back to the shared agent
library — as an issue, under that user's own GitHub identity.

**That is the sustainability model, not an implementation detail** (PRD §12). The agents in
`agents/` get better because sessions run against real documents and real corrections; a user who
could consume the service without contributing would be taking from a library nobody was refilling.
Requiring GitHub auth is how using Iris and improving it become the same act, and how each
contribution is credited to the person who produced it. If you would rather your users not
contribute, this is not the service to deploy.

Two consequences an operator should know before deploying:

**1. The permission lives with the installation, not with your users.** The token does exactly two
things: `GET /user` to identify the caller, and file issues on `upstream_repo`. Iris is registered as
a **GitHub App**, so the second one is granted once — by installing the app on `upstream_repo` with
`issues: write` — and users only *authorize*. Their consent screen requests **no repository access
at all**, because there is nothing left for it to ask for.

One limit worth knowing if your `upstream_repo` is **private**: a user's token is the *intersection*
of the installation's permissions and that user's own access, so installing the app does not give a
user access they did not already have. On a private upstream, filing works for users who can see the
repo and 404s for everyone else. Set `github.issue_token` if you need a private upstream to accept
contributions from users who are not collaborators — it files everything under one account, which
trades away the per-user attribution below. A public `upstream_repo` (the assumption here, since the
agent library is meant to be shared) has no such limit.

This replaced an OAuth App requesting `public_repo`, and the reason is worth stating plainly: there
is no OAuth scope meaning "open issues on one repository". `public_repo` was the narrowest one that
could file, and it grants read **and write** to every public repository the user can reach —
code, commit statuses, collaborators, webhooks — none of which Iris touches. Nothing pushes and
nothing opens pull requests. So the old consent screen asked for orders of magnitude more than the
service uses, and the app is the only way to fix that rather than merely document it.

What the user's token still carries is their **identity**. A user-to-server token acts as the user,
so issues are filed under their own account and each contribution is credited to the person whose
session produced it — the whole reason users authorize at all instead of the app filing as itself.

Two registration settings the service depends on, if you point `client_id` at your own app:

| Setting | Value | Why |
| --- | --- | --- |
| **Enable Device Flow** | on | Off by default for a new app, and the device flow is the default deployment's only login path (it returns `device_flow_disabled` without it). |
| **Expire user authorization tokens** | **off** | With expiry on, user tokens last 8 hours and come with a refresh token. Nothing here persists or refreshes a credential, so turning expiry on means building refresh plumbing first. |

The misconfiguration this *cannot* catch at startup is the app not being installed on
`upstream_repo` — that state lives on github.com, not in config. It surfaces as a **403 or 404**
during filing, logged with a `hint` saying so. Both statuses, because GitHub does not reveal
repositories a credential cannot see: an app that was never installed reads as `404 Not Found`
rather than as a permissions error. (A misspelled `upstream_repo` looks identical, and the hint says
so rather than blaming the installation.) When `issue_token` is set, the hint names the **service
PAT** instead, since the installation governs only tokens issued to users.

**If you are coming from an earlier build,** three things changed, and two of them can stop a
working deployment:

- **A configured OAuth App id is now a hard startup failure.** An `Ov…` `client_id` is refused,
  because Iris no longer sends any OAuth scope: such an app would authenticate users and then be
  unable to file a single issue. Register a GitHub App (`Iv…`) and install it on your
  `upstream_repo`, or leave `client_id` blank for the bundled one.
- **`upstream_repo` is no longer independent of `client_id`.** Under the old OAuth App, the
  `public_repo` scope could file on any public repo, so leaving `client_id` blank and repointing
  `upstream_repo` at your own agent library worked. A GitHub App's `issues: write` comes from its
  *installation* on one specific repository, and the bundled app is installed on this repo — so that
  same config now files nothing, for anyone. You need your own app installed on your repo (or ask us
  to install ours there). This combination warns at startup rather than failing, since we cannot see
  from config whether the bundled app was installed on your repo.
- **`github.oauth_scope` is gone.** A config that still sets it — including `oauth_scope: none`,
  which used to be a startup error — now starts fine and ignores the key. Delete it.

There is no user-facing migration: no one had authorized the OAuth App, and any existing
authorization can be revoked at
[github.com/settings/applications](https://github.com/settings/applications).

**2. `github.issue_token` is an override, and not a recommended one.** Set it to a service-account
PAT and every issue is filed under that bot account instead of under the user who produced it. It is
off by default because it erases the attribution that is the point of the design. Use it only where
a deployment genuinely cannot file as its users — an org policy that forbids it, say.

### What happens to your token

**It is never written to disk.** The token arrives in the `Authorization` header, is used in memory
for the request and for the pipeline run it authorizes, and is gone when the run ends. There is no
`github_token` column in `data/iris.sqlite` and no token file — a stolen copy of the database is a
list of GitHub user IDs and logins, not GitHub access.

Two smaller things follow from that, both worth knowing:

- Identity lookups (`GET /user`) are cached in memory for **5 minutes**, keyed by the token, so a
  revoked token keeps working for up to that long. The cache is bounded (10,000 entries, oldest
  evicted) and entries are *not* renewed on use — deliberately, so that a busy token cannot outlive
  its revocation indefinitely. It is empty on restart.
- Because nothing is stored, there is nothing to rotate, re-encrypt or purge when a user revokes
  access. Revocation at github.com is the whole mechanism.

**If you have a `data/iris.sqlite` from an earlier build, delete it.** Tokens *were* stored in a
`github_token` column once, and there is no migration — every user re-authorizes from scratch. The
service refuses to start against such a file and names the fix, rather than adopting it: the old
table's `github_token TEXT NOT NULL` would survive `CREATE TABLE IF NOT EXISTS`, so first-time
logins would fail with a SQLite constraint error returned as `401 unauthorized` (users who already
had a row would keep working, which makes it look like flaky GitHub auth rather than a schema
mismatch) — and the claim above would be false for that file, since it still holds live plaintext
tokens for everyone who ever logged in. Delete it rather than archiving it; users lose only their
session history.

## API

All endpoints are under `/v1` and (except auth, health, stats and limits) require
`Authorization: Bearer <github_token>`. `/v1/quality` is the one exception in the other
direction: it takes a bearer token too, but its own shared secret rather than a GitHub one.

| Method & path | Purpose |
| --- | --- |
| `GET  /v1/health` | Liveness probe |
| `GET  /v1/stats` | Public tally of pages converted, plus a two-number quality summary (no token; aggregate only) |
| `GET  /v1/quality` | Deployment-wide tally of output *quality* (own shared secret, off by default; aggregate only) |
| `GET  /v1/limits` | What an upload may be — formats, per-image size, page cap (no token) |
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
| `GET  /v1/sessions/{id}/diagnostics` | Cost/timing/health summary (token counts per run and per agent, phase + per-call durations, in-flight/hung call) |

Full copy-pasteable bash/curl walkthrough of every endpoint: **[docs/API.md](docs/API.md)**.
To prove the endpoints work end-to-end (mock GitHub + mock model, no credentials needed):
`./test/e2e.sh`.

Example — create a session (order of `images` parts is the processing order, §9.2):

```bash
curl -X POST http://localhost:8080/v1/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -F "images=@page-001.png" \
  -F "images=@page-002.png"
```

Then poll `GET /v1/sessions/{id}` until `status` is `ready_for_review`, fetch
`GET /v1/sessions/{id}/output`, and `POST /v1/sessions/{id}/close` to finalize.

## Layout

```
agents/                  # the agent library: page.md (the general pass), feedback.md,
                         #   and specialists dispatched by name (§7.4 v1.2)
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

  Reconciliation's *within-page* job also no longer exists: it was there to clean up after the
  fan-out, and one page now yields one fragment from one agent, so there are never two fragments
  competing to represent the same content. Across pages the problem is real and open — a
  paragraph or table can span a page break, and the page agent notes the cut-off edge rather
  than joining anything (§7.6 v1.2).
- **One agent per page, not one per content type (§7.4 v1.2).** The PRD's nine per-content-type
  agents (`paragraph.md`, `table.md`, `formField.md`, …) have been **deleted**, and this is the
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
- **No provenance comments in the output (§7.4/§7.7).** The PRD specifies `@source` / `@agent` /
  `@fragment` wrappers preserved into the final HTML. Iris delivers clean content-only HTML
  instead: the comments leak pipeline internals into a document meant to be handed to end users,
  and every consumer would have to strip them. Provenance is recorded in the run log
  (`GET /v1/sessions/{id}/logs`) rather than in the deliverable. `@unresolved` **is** emitted
  when the review loop stops with issues outstanding — at its iteration cap, on a round that
  changed nothing, or on a round whose response hit the model's output ceiling (§7.11). That
  last exit adds a second comment, `@editor-truncated`, saying what that round managed: the
  editor is asked for the whole document, so a round too long to answer is re-made a section at a
  time, and the comment reports how many sections came back — or, where nothing could be, that
  no editor pass ever worked on the issues `@unresolved` lists. A third comment,
  `@lint-unavailable`, is emitted when axe-core could not run on the document at all: nothing in
  it was checked, so an `@unresolved` list that is short — or absent — is not evidence that there
  is nothing left to fix (§7.7).
- **Contributions are issues, not PRs (§7.13/§9.2).** Instead of fork+PR-on-close, when the
  extractor flags content a specialist would handle better, Iris drafts that agent and files a
  `New agent suggestion: <type>` GitHub issue with the agent code + context; feedback that
  generalizes files an `Agent update proposal: <agent> — <lesson>` issue the same way. Simpler to
  triage, and it needs no write access to a fork — so nothing forks and nothing pushes. Consequently
  the PRD's `pending_prs` and `prs_opened` response fields, the `skip_prs` parameter and the
  `fork_repo` field on `/v1/me` are **not** part of the API.
  Issues are filed with the logged-in user's token, which is
  [required, and the point](#github-is-the-only-sso-layer-and-tokens-are-required);
  `github.issue_token` overrides that with a service account, at the cost of the attribution.
  The update title carries a slug of the **lesson**, not just the agent, because the agent on that
  path is always `page.md`: with the agent alone, every proposal ever made computed one title, and
  the title-based dedupe then skipped every one of them after the first — silently, for as long as
  that first issue stayed open (observed on the UIC deployment, where one issue blocked the path for
  a day). A repeat report of the same lesson now comments on its issue with the new session and
  corroboration count instead of being dropped, so no lesson leaves without a trace.
- **Review issues are attributed by page, not by `@source` region (§7.8/§7.9).** The PRD's issue
  format references `@source` region ids from the per-region fan-out, which extraction no longer
  produces and which are stripped from the deliverable anyway (§7.4 v1.1). Issues instead carry
  `pages: number[]` — the source pages the Reader matched the offending content to, from an index
  of page-number + extracted-HTML excerpt. Attribution is what scopes the Copy Editor's image
  payload (below); the two-view (HTML + flattened) cross-check is implemented as specified.

Places where the PRD left a decision open, and where v1 intentionally stops:

- **`runs/<run-id>` vs `sessions/<session-id>`.** The PRD references both (§7.3/§7.5 vs §8.1).
  This implementation treats the run id as the session id and writes the log, `agent-updates.md`,
  etc. under `sessions/<session-id>/`, matching the authoritative layout in §8.1. (Two files in
  that tree, `new-agents.md` and `prs.md`, are not written at all — they belong to the withdrawn
  fork-and-PR flow; see §8.1 v1.2.)
- **Reader chunking (§7.8).** Chunks use a fixed character budget with overlap rather than a
  literal 30%-of-context computation, since the per-model context window is not exposed through
  the provider abstraction. The two-view (HTML + flattened) cross-check is implemented as
  specified.
- **Color-contrast lint.** Output is content-only with no styling (§4), so axe-core's
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
- **Duplicate ids are linted for three separate ways (§7.7 v1.2).** Obsolete as a *conformance
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
- **Colliding ids are namespaced during assembly (§7.7 v1.2).** A page is extracted alone and
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
  concatenation passed. Ambiguous references are named in the run log as `assembly_anchors`. A page
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
  purely a property of the fixture: whether a prompt produced output is a property of *that
  prompt*, so one fixture can be scored 0 for one side and excluded from the other.
- **The eval gate is a *paired* comparison, per fixture (§7.12).** The rule above is right about
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
  been stated in five places and enforced in none, so the demo, the docs and the PRD all
  advertised **TIFF**, which Claude has never read (accepted, then failed inside the first model
  call) while rejecting **GIF**, which it does; and an oversized photo was accepted by multer's
  50 MB ceiling and died two to four minutes later as "no output arrived within 120s". Switching
  models now moves every one of those surfaces together. An operator can still override per
  provider (`providers.<name>.image_limits`) for a model newer than the table.
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
out of scope). The endpoints beyond the PRD are `GET /v1/health`, a standard liveness probe, and
`GET /v1/stats`, the public page tally described above.

## Automated code review

Every PR is reviewed by Claude in CI before a human reads it
([`.github/workflows/code-review.yml`](.github/workflows/code-review.yml), PRD §7.14). This is
not convenience tooling. Iris's agent library only improves through upstream merge (§7.13), so
review capacity is the bottleneck on the whole contribution model — and a three-institution
maintainership with no full-time reviewer cannot be the only thing between a contributed prompt
and every future session.

What it does, in order:

1. Runs `npm ci`, `tsc --noEmit`, the unit suite, `./test/e2e.sh`, `actionlint` over the workflow
   files and `shellcheck` over `.github/scripts/*.sh`, and hands the model their **actual output**. The reviewer is told not to re-run them, so a claim that a
   check failed is quoted rather than predicted.
2. Builds a context file: the diff, plus full source for files that are new or substantially
   rewritten, plus up to the 3 most recent prior reviews on **earlier commits of the same PR** —
   so a re-review knows what it already said instead of repeating it. Source is capped at 800
   lines per file and says so where it cuts — an unmarked cut reads as a whole file, and the
   reviewer then reports as missing what is merely further down.
3. Reviews against a ranked list: accessibility of the output, upstream side effects and filing
   identity, auth/tokens/secrets, provider routing and cost, correctness, failing checks, missing
   tests, and the PR template's own contract.
4. Posts exactly one review ending with a one-line `Accessibility impact:`.

**Blocking is decided by reachability, not by category.** A finding blocks only if a real user, a
real request, or CI reaches it on input the code accepts today, and each blocking finding has to
name that input. A defect that's real but unreachable is a note on an **approval**, with what
would have to change to reach it. This was tuned in response to a measured problem: the findings
were reproduced and specific, but *everything* arrived as blocking — 34 `CHANGES_REQUESTED` to 17
`APPROVED` across the repo's history, individual PRs at 12-to-1, including reviews that called
their own finding latent and requested changes anyway. `main` carried no branch protection then, so
the cost was never blocked merges; it was author attention, and a reviewer that always blocks trains
you to skim the one time it matters. Three things stay blocking even when unreachable, because
their value is holding when something else breaks: auth/token/secret handling, publishing under
the wrong identity, and path handling that could escape the data dir.

**Depth was not what got trimmed.** The model gets ~19 minutes and is told to dig exactly as hard
as before; the bar governs the verdict, not the investigation. It appends findings as it confirms
them, so if it's cut off, a fallback step posts the partial findings plus the check summary as a
`--request-changes` — an incomplete review must not read as a pass. A final step fails the job if
no review was posted at all, since the action can exit 0 without posting one.

**The workflows are reviewed like the rest of the app**, because they are part of it. This
reviewer and the issue-triage one are what §7.14's review promise actually rests on, and they hold
`id-token: write` and the Bedrock role; every workflow here holds a secret, a token or write
access, and a defect in one is reachable by definition, since CI runs it. So a diff touching
`.github/workflows/**` or `.github/scripts/**` gets a CI-security checklist
ahead of the accessibility one — PR-authored code reaching secrets, `${{ }}` interpolated into a
`run:` block, widened `permissions:`, an unpinned third-party action, lost review coverage, the
shell traps that have actually bitten here, and the timeout arithmetic — and the reviewer reads
each changed workflow in full against its `main` copy rather than only the hunks.

Reviewing changes to `code-review.yml` itself takes one extra step, and it is worth knowing why.
`claude-code-action` normally trades its OIDC token for a Claude App token, and that exchange
refuses while the invoking workflow file differs from the copy on `main` — the action then skips
itself, which is why every PR editing this file used to merge unreviewed. Handing the action an
explicit `github_token` short-circuits the exchange, so the job passes `GITHUB_TOKEN` on exactly
those PRs. The review runs; it posts as **github-actions[bot]** instead of claude[bot], and the
workflow says so on the PR. (A previous attempt covered this from a second workflow on
`pull_request_target`. It produced no review in six runs and was the repo's only PR-triggered job
holding `id-token: write`, so it was deleted; this approach needs no such job.)

One gap remains: **fork PRs are skipped.** `pull_request` from a fork gets no secrets, so the OIDC
role assumption would fail confusingly. Review one with
`gh workflow run code-review.yml -f pr_number=<n>` — which runs the fork's code in a job holding
the Bedrock role, so read the diff first.

The verdict stays advisory: `main` is protected, but this check is deliberately not required. A PR
touching only `paths-ignore`d files never triggers the workflow, so the check would never report
and the PR could never merge. A fork PR's job is skipped by its own `if:`, which should satisfy a
required check the same vacuous way — GitHub's documented handling of a skipped job. The third
case used to be the worst of them: a PR editing this workflow ran to completion and reported
**success** with the steps that post and verify a review both gated off, so a required check would
have put a green tick on a PR nothing had read (measured on #70). That one is now a real review
with a real verdict, and both gates are gone with it. A human still merges. What changes is what
that human is reading, not whether they read it.

## Closing duplicate issues

[`.github/workflows/issue-triage.yml`](.github/workflows/issue-triage.yml) runs **when an issue is
opened or reopened**. It reads the new issue, finds the open issue it most resembles, and — only
when a second, independent session fails to refute the claim — closes the new one as a duplicate
with a comment naming the survivor. Anything short of that is commented and reported, never closed.

It exists because the dedupe already in the app cannot do this, and was never trying to.
`src/github/issue.ts` refuses to file an `Agent update proposal:` whose title exactly matches an
open one, which is the right check to have there: cheap, deterministic, no model. What it cannot see
is that "procedure steps must be marked up at heading" and "when steps are nested inside a named
section" are one rule described twice. Iris files these speculatively from content it met once
(§7.13), so semantic overlap between them is the normal case rather than the exception, and it
accumulates faster than anyone reads it.

**Two sessions, and the second one is not shown the first one's argument.** The whole risk of
automatic closing is a plausible-but-wrong duplicate call, and a session asked to check its own
work draws the second opinion from the context that produced the first. So the *find* session reads
the new issue against every other open issue and proposes the nearest one; the *refute* session is
handed only that pair, told to argue against closing, and told to default to "not a duplicate" when
it cannot decide. A close needs the first to say `duplicate` at high confidence and the second to
fail to refute it. Disagreement is not a tie to be broken — it is the answer, and the answer is
"leave it open and tell a human".

The pair the second session reads is fetched fresh from the API, not taken from the corpus the first
one was given, and the second session gets no repository and no corpus — just the two issues. Losing
`Glob` and `Grep` is not what makes that true, and it is worth being exact, because the earlier
version of this paragraph said it was: `Read` alone still reaches `agents/page.md` and `src/**` by
path, and a session that can open the prompt can answer the question its instructions tell it is
unanswerable, then confirm a close on the answer. So the checkout and `/tmp/triage` are denied to
its `Read` by path, in both the project-relative and absolute spellings, and the pair file was moved
to a directory of its own so that denying the corpus wholesale does not deny the one file the
session is meant to read. Independence has to cover the input, not only the argument: the first session runs first
and in the same workspace, so anything it could leave behind is evidence it could choose. Restate
issue A's body as a copy of B's and the refutation opens a file in which the two really are
identical; edit `agents/page.md` and the rule B proposes looks like it is already in the prompt,
which is the question the refutation turns on. Neither is reachable now that no session has `Write`,
but the fresh read stays: it is cheap, and it does not depend on a claim about what the other session
could touch. Withholding the repository does cost the refutation some accuracy, in the direction of
refusing to close.

**Neither session can close anything.** Neither has `Bash`, so neither can reach `gh`. Every close,
label and comment happens in a shell step that reads the two verdicts and the GitHub API, the same
division as [Scheduled issue triage](#scheduled-issue-triage): the prompt is the layer an injected
issue body argues with, so the rules live somewhere it cannot reach.

That step's body is [`.github/scripts/triage-decide.sh`](.github/scripts/triage-decide.sh) rather
than an inline block, for a mechanical reason worth knowing before writing a long step: GitHub parses
a `run:` block as one expression and refuses the whole workflow file when one exceeds 21000. The
enforcement step's reasoning is longer than that, and an unparseable workflow file fails *every* run
with no jobs and no annotation — the loudest possible failure for the quietest possible reason, and
the Actions UI will only say the file has an issue. `gh api
repos/OWNER/REPO/actions/workflows/FILE/dispatches` is what names the line and the limit.

Do not budget against 21000 directly. The block that broke this workflow held 20,893 bytes over 408
lines and was rejected anyway — 21,301 with CRLF line endings, which is what the limit appears to
count. Roughly 20,500 bytes of content is the usable ceiling, and `code-review.yml`'s context builder
is the other block in this repo close enough to it to matter.

**Neither session has `Write`, either.** A verdict is the session's structured output — `--json-schema`
has the runtime validate it and the action publishes it as a step output — so nothing needs to create
a file and neither session is given the means to. That is worth more than scoping `Write` could be. A
checkout is not inert: `.git/config` defines filters that any later `git` command executes,
`agents/*.md` is evidence a later step might read, and a `CLAUDE.md` at the root is project
instructions for whatever runs next in the same job, which is the refutation. An earlier version of
this workflow ran `git checkout -- .` between the sessions to undo writes, which was worse than the
problem: `git checkout` applies smudge filters, so a filter written into `.git/config` executes during
the repair and the "restored" file comes back with whatever the filter returned. A `.git` you do not
trust cannot be repaired with `git`, because every `git` command reads its config first. Having no
`Write` is the version that works — and it retires the two `rm -f`s that used to guard against a
verdict file left on the runner by an earlier run being read as this one's.

That design replaced one where both sessions wrote verdict files into `/tmp/triage`, and the reason is
worth recording, because the scoping looked right and was not. **A path-scoped `Write(...)` *allow*
rule grants nothing** — probed directly: every spelling denied the write, absolute or relative, target
existing or not, while a bare `Write` succeeded. So the first live run ended with a permission denial
and no verdict, which `Decide and act` correctly turned into a red run. Deny rules *do* work, probed
the same way, which is why the reading side below is a broad allow plus denies.

Reading is scoped from the other end. These sessions run in a step holding the Bedrock credentials
and a token, and the verdict's prose is posted to a public issue comment — so whatever a session can
read, it can publish. Both get `Read` with `/proc`, `/sys`, the runner's temp directory and `~/.aws`
denied; the find session also gets `Grep` and `Glob`, denied the same paths, since a tool that returns
matching lines is also a way to read a file and one that returns only names still says which secrets
exist and where. The temp-directory deny carries more weight than it looks: that is where the action
writes its execution log, so it is what keeps "the refutation cannot see the first session's argument"
a fact about the sandbox rather than a claim about the prompt. `persist-credentials: false` on the
checkout keeps the token off disk entirely, which costs nothing because no step here runs `git`. Every
deny is written in both `/x` and `//x` form, because a deny that resolves the wrong way fails *open*
and silently.

Then `Decide and act` flattens each model-authored prose field to one line, caps it at 600
characters and redacts it against the live credential values before it can reach a comment. That
last layer catches verbatim copying and not a re-encoded value — which is why the reading is scoped
rather than the publishing merely filtered. `verdict` and `confidence` are not sanitized but held to
their allowed values — twice, once by the schema in the runtime and again in the shell, because a
control that only holds while the action keeps behaving is not a control. That is stronger than
sanitizing where it applies: a string outside the enum is not a malformed verdict, it is not a
verdict, so it is discarded rather than repeated back — and a discarded verdict fails the run.

The shell also normalises case and space before checking, and that buys less than it was written to.
It went in so a `Duplicate` would not be thrown out for a cosmetic slip, since being discarded costs
the issue its comment too. But the schema pins the same three words in the runtime and sits in front
of the shell, so a `Duplicate` never gets this far: validation rejects it, the verdict arrives empty,
and the run goes red having posted nothing. The normalisation is therefore not a nicety with an
effect today — it is the layer that still means something if the action stops validating, which is
the same reason the type checks run at all. Where it is reached, the gates accept one *normalised*
value, so a mis-cased `duplicate` can close, and it is blunt enough that `dup licate` would too.
Either way nothing standing between a verdict and a close moves: the refutation and the four rules
below are unchanged.

**Four rules hold regardless of what either session says**, because that step re-derives them:

- **Only the newer issue of a pair can close.** The survivor must have the lower number. This is
  what makes the outcome independent of which issue happened to be triaged first — without it, two
  issues opened a minute apart could each close the other and the tracker would lose both. A
  verdict naming a *newer* issue is still reported; it just cannot close anything.
- **An issue an open PR claims never closes** — anyone's PR, by a closing-issue link or an
  `issue-<n>` branch fragment, the same two precise signals used for ranking.
- **An issue with human discussion never closes.** A comment from anyone who is not the filer and
  not a bot means a person engaged with it.
- **`no-auto-close` is an unconditional veto.** No dispatch input overrides it — a manual `force`
  bypasses only the record of an earlier triage, nothing about the issue itself. The label does not
  exist in the repo yet; an absent label matches nothing.

The last three are checked twice — once in the preflight, so an ineligible issue costs no model call
at all, and again after both sessions, because a PR, a reply or a label can land inside the minutes
they take and that is exactly when closing does the most damage. The first rule needs a verdict to
check, so it is only checked after. A read that *fails* counts as a blocker rather than as a clean
bill of health: `gh` prints API error bodies to stdout, so a check that treated an unreadable answer
as an empty one would be reading `{"message":"Not Found"}` as "nobody has commented".

A close also applies the `duplicate` label, which is what takes the issue out of
[Scheduled issue triage](#scheduled-issue-triage)'s candidate list — that workflow reads labels,
not close reasons. GitHub offers no `duplicate` close reason, so the state closes as `not planned`
and the comment carries the actual reason, along with an invitation to reopen and say what the
survivor misses. A reopened issue is not triaged again.

There is no schedule, and the backlog that predates the workflow is triaged one dispatch at a time
so a human sees each verdict as it lands:

```
gh workflow run issue-triage.yml -f issue_number=<n> -f dry_run=true
```

`dry_run` does the full triage, both sessions, and reports exactly what it would have done without
touching the issue. Add `-f force=true` to re-triage an issue that has already been triaged.

## Scheduled issue triage

[`.github/workflows/issue-to-pr.yml`](.github/workflows/issue-to-pr.yml) runs **Sun–Wed at 22:00
UTC** (PRD §7.15). It reads the open issues, ranks them by what most improves Iris, and opens
**one** pull request for the top issue it can finish well, with a review requested from
**@bbertucc**.

[Automated code review](#automated-code-review) raised the ceiling on how much review this
maintainership can absorb; this spends some of that headroom on the other side of the same
bottleneck — issues that are correct, small, and never picked up. A reported barrier that sits open
for three months is a barrier shipped to every session in between.

The schedule is built around the reviewer rather than the runner. Four runs, late afternoon
Central, each landing a PR the day before it gets read — so the review queue is Mon–Thu and Friday
stays clear. Thu–Sat runs would produce PRs nobody opens until Monday, by which point `main` has
moved and the branch needs a rebase before it can be read at all. Actions cron is UTC and never
shifts for DST, and an evening-local schedule crosses midnight UTC onto the next UTC day, so a
naive "Sunday evening" cron would run Saturday evening Central; 22:00 UTC is before that boundary
in both DST states.

The same reasoning is why it refuses to run more often than it is useful:

- **No eligible issue, no run.** The preflight step stops before Node, before OIDC, before a token
  is spent. An automation that always finds something to change is one that invents work, and an
  invented PR costs the same review attention as a real one.
- **An issue an open PR already claims is not eligible** — anyone's PR, not just this workflow's.
  If every open issue is claimed, the run does nothing. A PR claims an issue two ways: GitHub's
  closing-issue link (`Closes #6`, in any of the keyword forms GitHub recognises) or an `issue-<n>`
  fragment in its head branch. A bare `#<n>` mention is *reported but not excluded* — it appears in
  the run summary and is handed to the model to judge against the actual diff, and it stays in the
  candidate list.

  That last distinction was learned the hard way, on the first live run. The prompt requires each
  PR body to name the higher-ranked issues it passed over — which is what makes the ranking
  auditable — so [#75](https://github.com/EqualifyEverything/equalify-iris/pull/75) listed ten
  issue numbers, a mention-tier check read all ten as claimed, and the next run found zero
  candidates and declined. One PR had switched the workflow off until it was merged. The failure
  isn't tunable, it's a loop: the PRs guaranteed to enumerate the backlog are the ones this
  workflow writes. Nothing is really lost by dropping it, either — GitHub's linked-issue data
  already covers every closing keyword, so mentions only ever added the ambiguous references
  ("related to #5 but doesn't fix it"), which are exactly the ones a person should judge.
- **Two open `iris-auto/*` PRs is the cap.** This is the pacing control and the reason the workflow
  is worth having: a queue that grows faster than one person reads it is a backlog with a robot
  attached. At 2, the maintainer can be a day behind without the workflow piling on, and a week of
  no reviews caps the mess at two branches instead of four.
- **It does not re-litigate.** An issue whose `iris-auto` PR was closed unmerged is off the list —
  coming back with a fresh attempt every Sunday is how an automation becomes something you mute. An
  issue whose PR *merged* is eligible again, since the next attempt starts from different code. The
  `no-auto-pr` label is the explicit opt-out for tracking issues and discussions.

Ranking, highest first: accessibility of the output or the app; a red `main` (baseline `npm ci` /
typecheck / unit results are measured on untouched `main` and handed over, so a pre-existing failure
is never mistaken for the diff's); correctness and data-safety bugs; a
[measured quality regression](#weekly-quality-report); small user-visible fixes
reported against the demo; agent-library work; then docs that contradict the code. Ranking is
filtered by *can this be finished well in one focused PR* — an open-ended issue like "Stress Test
Iris" is not a PR, and the PR body has to name the higher-ranked issues that were passed over and
why. Deciding nothing is worth a PR is a supported outcome, recorded in the run summary.

Two things about it are worth reading closely, because they are where an automation that writes to
the repo would go wrong:

- **Issue text is untrusted input.** Anyone can open an issue, so every body and comment reaches the
  model fenced as data, and none of it is ever interpolated into a `run:` block — a title full of
  shell metacharacters or an Actions expression is inert. But the prompt is the layer an injected
  issue argues with, so it is not the control. The control is a verify step that re-reads the
  **pushed diff** against a path allowlist: a PR touching `.github/workflows/**`,
  `.github/scripts/**`, `.github/CODEOWNERS`, `LICENSE`, `infra/**` or `.env*` is converted to a
  draft with a comment saying why, and the job goes red. `.github/scripts/` is on the list because
  a workflow may keep part of itself there: GitHub refuses a `run:` block past 21000 characters, so
  `issue-triage.yml`'s enforcement step is `.github/scripts/triage-decide.sh`. CI is the sharp case, and it stays forbidden
  even though `code-review.yml` now reviews workflow diffs: CI is where this job's own privilege is
  defined — the Bedrock role, `contents: write`, and that allowlist — so a run talked into editing
  it could widen what the next run may do. That is a privilege boundary, not a review gap.
- **These PRs are not automatically reviewed.** GitHub does not start workflow runs for events
  raised by `GITHUB_TOKEN`, so `code-review.yml` never fires on them. The verify step says so on the
  PR itself, with the dispatch command, because the absence of a signal is not something a reader
  notices. Configuring an `AUTO_PR_TOKEN` secret (a PAT or App token, used only for `gh pr create`)
  closes the gap; until then, `gh workflow run code-review.yml -f pr_number=<n>`.

**The reporter is credited on the work.** The PR names whoever opened the issue, and the commit
carries a `Co-authored-by` trailer for them, so their account is on the merged commit rather than
only a bot's. The report is the contribution here — the patch does not exist without it. GitHub
only resolves that trailer in its numeric-ID `noreply` form, so the address is precomputed from the
public profile (never a real email) and handed to the model ready to paste; the verify step checks
the pushed commits for it and, if it is missing, puts the exact line in the PR body for whoever
runs the squash merge. Issues Iris filed itself are skipped — crediting a bot as co-author of the
fix to its own report says nothing.

Run it by hand with `gh workflow run issue-to-pr.yml`, optionally with `-f issue_number=<n>` to
name the issue yourself, or `-f dry_run=true` to get the ranking and the plan with no branch, no
commit and no PR. Naming an issue overrides the skip labels, a past rejection and the
already-claimed check — you have made those calls yourself — but not the two-open-PR cap, and the
run still warns if the issue looks claimed so you know what you are walking into.

One duplicate the preflight cannot prevent is the race: a contributor opens a PR for the same issue
during the 45 minutes the job is working. The verify step catches that afterwards, comparing the new
PR's own target issues against every other open PR, and comments on the PR asking for the two to be
compared. It warns rather than drafting one of them — which of the pair to keep is a judgement about
two diffs, not something to decide by timestamp.

## Telling a deployment that main moved

`notify-uic-deploy.yml` posts a `repository_dispatch` on every push to `main`, so the UIC test
deployment at `iris.equalify.uic.edu` can ship the exact SHA that just landed. That is all it
does: it holds no infrastructure knowledge, and whether or how the commit is rolled out is the
private deployment repo's business.

It needs one secret, `UIC_DEPLOY_DISPATCH_TOKEN` — a fine-grained PAT with **`Contents: read
and write` on the deployment repo only**, which is the least that `POST /dispatches` accepts. It
grants nothing here: the job runs with `permissions: {}`.

Nothing about this is load-bearing. With the secret absent — a fork, or before it is added — the
step prints why and exits 0; if the token is revoked or the API is unreachable it warns instead.
A deployment nobody else runs must never be able to turn this project's `main` red.

## Weekly quality report

[`.github/workflows/quality-report.yml`](.github/workflows/quality-report.yml) runs **Saturdays at
20:00 UTC** (PRD §7.16). It reads `GET /v1/quality` on a live deployment, compares a handful of
rates against thresholds held in that workflow file, and opens one issue per crossed threshold.
[Scheduled issue triage](#scheduled-issue-triage) then ranks those issues with everything else and
may open a PR against one.

Everything before this depended on somebody typing. An issue, or a session's feedback — the loop is
good, but a person has to start it. Meanwhile Iris grades itself on every single run: how many
reader/editor rounds a document needed, which axe-core rules its HTML still violates, whether a
hyperlink present before the copy editor was missing after it. All of that went into a per-session
log that nothing ever read back. The app could tell that one axe rule fails on a third of everything
it produces, and had no way to say so.

So the runs now write those measurements to a `run_signals` table, `GET /v1/quality` aggregates them
over a window, and this workflow turns a crossed threshold into an issue. **It spends no model
tokens** — it is curl, `jq` and arithmetic, and every judgement call it could make is left to the
triage workflow that is already good at that. Its only permission is `issues: write`; it needs no
Bedrock role, no OIDC and no Node.

What gets measured is only what cannot be argued with: an axe violation, a round count, a missing
`href`, a lint pass that errored. The Reader Agent's opinion about a document is deliberately *not*
recorded even though it is the richest thing Iris produces — an automation that files issues from
model opinions manufactures work at whatever rate the model will opine. Only the *count* of
unresolved issues crosses the line.

**The endpoint cannot return document text, and that is a constraint on the schema rather than a
convention.** These values get copied into public GitHub issues, and the documents behind them are
user uploads — at the UIC deployment, student records. axe rule ids are a fixed safe vocabulary;
unresolved-issue descriptions are model-written prose about one identifiable person's document, and
dropped `href`s came from that person's PDF, so only their counts exist in the aggregate at all.

Turning it on is deliberate and per-deployment — three values, in one place each:

1. **On the deployment:** `server.quality_token` (`IRIS_QUALITY_TOKEN` in the environment) — one long
   random value, then restart.

   ```bash
   openssl rand -hex 32     # keep this; step 3 needs the same value
   ```

   Until it is set the endpoint answers **404**, not 401: a deployment that has not opted in does not
   acknowledge it at all, so scanning for it reveals nothing about whether an operator merely forgot.

2. **`QUALITY_URL`, a repository *variable*** — the deployment's **origin only**, no path:

   ```bash
   gh variable set QUALITY_URL --body https://iris.equalify.uic.edu
   ```

   The job appends `/v1/quality` itself, so a value ending in `/v1` produces a 404 that looks exactly
   like a deployment that never opted in. A trailing slash is tolerated. It must be `https://` — the
   token is a bearer token, and the job fails the run rather than putting one on the wire in
   cleartext. A variable rather than a secret because it is a public hostname, and because a run log
   that cannot name the host it failed to reach is not much of a run log.

3. **`QUALITY_TOKEN`, a repository *secret*** — byte-for-byte the value from step 1:

   ```bash
   gh secret set QUALITY_TOKEN
   ```

   A mismatch goes **red**: the endpoint answers 401 and the job says the two have diverged. It is
   not the only red path — a non-https `QUALITY_URL`, a non-numeric `days` and a 200 that is not a
   tally all fail the run too — so read what the run says rather than reaching for the token first.

Then verify before waiting a week for the schedule:

```bash
gh workflow run quality-report.yml -f dry_run=true
```

That reads the tally and prints every issue body it *would* file, filing none. A green run reporting
"below the minimum document count" is a success, not a failure — it proves the URL and the token work
on a deployment that has not yet converted 20 documents in the window.

Without the variable and the secret, the job posts a notice saying what to set and exits **green** —
the deliberate "not configured" path, so a repo that never opted in does not accumulate red runs. The
consequence worth knowing: an unconfigured quality loop looks exactly like a healthy one from the
Actions tab. If you expect weekly issues and see none, check that both values exist before assuming
there is nothing to report.

Filing nothing is the normal weekly outcome, and
four things produce it: fewer than **20 documents** in the window (a rate over four documents is
noise wearing a percentage sign); an issue for that threshold **already open** — titles are stable
and carry no numbers, so this week's rate cannot make a new title; an issue for it **closed within
30 days**, because on the day a fix merges the 30-day rate still contains a month of pre-fix
documents; and a cap of **two issues per run**, with anything over it named in the run summary
rather than dropped quietly. A fifth condition silences the **rule table alone** rather than the
whole run: rule shares divide by `documents_linted`, so fewer than 20 documents the linter could
actually examine leaves that table unevaluated even when 20 were delivered — one lint error in a
20-document window is enough. The run summary says so when it happens, since "no rule crossed its
threshold" must not stand for "no rule was measured".

The thresholds live in the workflow rather than on the server, so retuning "how bad is too bad" is a
one-line PR with a reviewer. That has a deliberate consequence: `.github/workflows/**` is on the
triage workflow's forbidden-paths list, so **the automation cannot close one of these issues by
moving the number that produced it.** If the threshold is what is wrong, say so on the issue and
change it yourself — that is a better outcome than muting the workflow, and the issue body says so.

When the measurement itself breaks — endpoint unreachable, token rejected, a 200 that is not a tally
— the run goes **red**. A quality loop that quietly stops reporting is indistinguishable from a
deployment with no problems, which is the whole failure this exists to prevent.

Run it by hand with `gh workflow run quality-report.yml`, `-f days=90` for a wider window, or
`-f dry_run=true` to print the tally and every issue body it would file without filing any.

### Two of those numbers are public

The demo page already says how *much* Iris has converted. Someone deciding whether to hand it a
document wants to know how *well* that went, so `GET /v1/stats` — no token, the tally the page
already loads — carries a `quality` object alongside the page count, and the page appends it to the
sentence:

> Iris has made 1,284 pages accessible across 212 documents since May 2026 — over the last 30 days,
> **93% of documents finished with the reviewer finding nothing left to fix**, averaging 1.8 editor
> passes.

It is the same `run_signals` rows, read through `Store.publicQuality`, so the public claim and the
weekly job's rates cannot drift apart by anything except their window (volume is all-time; quality
is windowed, because an all-time rate converges and stops responding to a fix). Two numbers a
visitor can interpret, and no rule ids: a standing list of what Iris still fails at belongs in front
of the people who would fix it, not on a front page.

The sentence is deliberately no stronger than the measurement. That rate counts documents the Reader
Agent left nothing open on — not documents whose final axe pass came back empty — so it credits the
reviewer instead of saying the output was clean, which is what a visitor would otherwise take away.
The percentage is floored rather than rounded, too: 99.6% is excellent, and publishing it as 100%
would be a claim of perfection about work Iris did not do perfectly.

**Below 20 documents in the window the object is `null` and the line simply is not there.** Same
floor as the weekly job, for a stronger reason — on a quiet deployment the aggregate is the
individual, and a rate over four documents shown next to a document count is a statement about
identifiable people's uploads. The floor is enforced in the store rather than in the route, so a
later route change cannot publish a number this refused to. See `docs/API.md` §0b for the fields.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md). Found an
accessibility barrier — in the app or in the HTML it produces? Please open an
[Accessibility issue](.github/ISSUE_TEMPLATE/accessibility.yml); those are our top priority.

PRs get an automated review before a human reads them — see
[Automated code review](#automated-code-review) above for what it looks at and, more usefully,
what it deliberately does **not** flag (style, formatting, naming, "you could also do X",
pre-existing issues your PR doesn't touch).

## License

**[GNU AGPL-3.0-or-later](LICENSE).** Iris is copyleft: if you modify it and run it as a
network service, you must make your modified source available to its users (AGPL §13).

Iris is maintained by **Equalify Inc.**, the **University of Illinois Chicago**, and
**California State University**.

**Commercial hosting and support are offered by [Equalify Inc.](https://equalify.app/)** The
hosted and self-hosted versions are functionally identical — what you are paying for is
operational (managed deployment, monitoring, accessibility consulting), not features withheld
from this repo. Please consider hiring them to host or support your instance.
