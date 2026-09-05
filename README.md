# Equalify Iris

**Image-to-Accessible-HTML parsing service.** Iris converts a sequential set of image files
(e.g. the rendered pages of a PDF) into a single content-only, WCAG 2.2 AA accessible HTML
document: one vision call per page against a prompt anyone can improve, then an iterative
reader/copy-editor review loop over the assembled document.

Three constraints shape the whole design, and the code is written to hold them:

- **Content only.** No CSS, no visual fidelity, no pixel-perfect layout. A two-column source
  becomes linear semantic HTML. WCAG 2.2 AA is the fixed target and is not a per-run option.
- **One machine, no vendor lock-in.** A laptop, a Mac Mini or a self-hosted box are all
  first-class targets, with no AWS/GCP/Azure account required. Every external dependency —
  model provider, database, object store — is replaceable by configuration, and the defaults
  (SQLite + local filesystem) need nothing hosted. That is also why in-process work is
  budgeted rather than assumed: see the concurrency and request-limit knobs below.
- **GitHub, deliberately not replaceable.** GitHub is the only sign-in, and a token is
  required on every call, because that token is what files each session's contributions under
  the user's own name. There is no anonymous mode and no opt-out —
  [why](#github-is-the-only-sso-layer-and-tokens-are-required).

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
become part of the shared `agents/` library. (An earlier design forked the repo and opened a PR
when the session closed; nothing forks now — see [design notes](docs/design-notes.md).)

Those issues are identified by their **title prefix**, not by a label, and deliberately so: GitHub
silently drops labels set by anyone without push access to the repo, which is most of the people
this is built for. A label would therefore have been missing on exactly the issues that most needed
it, with nothing to say so — and the duplicate check that filtered on it would have refiled the same
suggestion every session, under a different person's name each time. If you want labels on these,
add a repository rule keyed on the title prefix; it applies them as the repo rather than as the
filer, so it works no matter who filed.

## Terms

Five words in this repo mean something narrower than they do in ordinary English. Every document
here uses them in the senses below. **Every one of the five also carries at least one unrelated
sense**, listed with it, and the text has to say which it means.

- **fragment** — one page's extracted HTML, plus the record of where it came from. A fragment
  carries the source page image, the page's position in the submitted document, which agent
  produced it, the agent's own log line, and any edges where content looked cut off (`Fragment` in
  `src/pipeline/fragment.ts`). Assembly joins fragments in that order; it does not re-read pages.
  Two unrelated uses: a **URL fragment identifier**, the `#id` a link points at, which is what
  [docs/API.md](docs/API.md)'s `links_unresolved_rate` is about; and an `issue-<n>` **fragment of a
  branch name** in [docs/ci.md](docs/ci.md).
- **block** — one top-level element of the assembled document, with everything nested inside it. The
  document is normally shown to the Copy Editor with a `<!-- @block N -->` comment above each one,
  and the editor replies with replacements for the blocks it wants to change rather than with a new
  document. A document too long to correct in one reply is instead cut **at those same boundaries**
  into sections, and a section request carries no `@block` markers and is answered whole
  (`EDITOR_SYSTEM` and `EDITOR_SECTION_SYSTEM` in `src/pipeline/review.ts`). Three unrelated uses:
  a mapping in the config file — the `providers` block, the `bedrock` block; a `run:` block in a
  GitHub Actions workflow; and a group of table rows, as in [docs/models.md](docs/models.md)'s "once
  per corrector block" and [docs/cost.md](docs/cost.md)'s "those three blocks".
- **verdict** — the Feedback Agent's decision about one page: two booleans, `faithful` and
  `accessible`, plus the problems it lists. Both booleans have to be there. A reply missing either
  one is not a verdict on that page and is not counted as one (`VerifyOutput` in
  `src/pipeline/feedback.ts`). In [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/ci.md](docs/ci.md),
  a verdict is the CI review bot's advisory decision about a pull request. That is a different
  thing, about your code rather than about a page.
- **declaration** — the page agent's answer that a page holds no content. It is a claim, not an
  absence. The agent asserts blankness with `"blank": true` or says so in its log, and the pipeline
  can refuse the claim: a page too dark to read is not a blank page (`blankDeclaration` in
  `src/pipeline/extraction.ts`). One unrelated use: the **`lang` declaration** on the document's root
  element, which is [docs/design-notes.md](docs/design-notes.md)'s only use of the word and appears
  once in [docs/API.md](docs/API.md), under `page_main_stripped`.
- **round** — one pass of the review loop. The Reader reads the whole document, and the Copy Editor
  answers what it raised. `max_review_iterations` (default 3) caps the editor rounds, so the Reader
  can read up to four times. The measurement documents mean something else by the word. A
  **benchmark round** or a **deployed round** is one captured run of a corpus through the pipeline,
  named like `runs-postswap-312` and kept with its own logs and prices; the two labels say where it
  ran.
  All six documents that use the word that way say so at the top — [docs/API.md](docs/API.md),
  [docs/cost.md](docs/cost.md), [docs/design-notes.md](docs/design-notes.md),
  [docs/models.md](docs/models.md), [docs/sprint-246.md](docs/sprint-246.md) and
  [docs/verifier-calibration.md](docs/verifier-calibration.md). One line of
  verifier-calibration.md uses it for a third thing, a page's correction pass ("wasted rounds").

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

Deployment is configured in `config.yaml`. `${ENV_VAR}` references are expanded
from the environment at startup; changes require a restart.

- **Storage**: local filesystem + a single SQLite file by default. `agents/` is a git
  checkout modified only by `git pull` from upstream. These are the only backends v1 ships —
  a Postgres or S3 backend was designed for and is deliberately not built
  ([design notes](docs/design-notes.md#designed-for-and-not-built)).
- **Model providers** ([docs/models.md](docs/models.md)): each agent declares a *capability*
  (`vision`, `structured_output`, `text`); the deployment maps capabilities to a provider + concrete
  model. v1 ships **OpenRouter** and **Amazon Bedrock** adapters, and adding one is a small adapter
  implementing the `ModelProvider` interface in `src/providers/types.ts`. Models are set per provider
  (`default_model` + `per_capability`), and can be overridden **per agent** via
  `providers.per_agent` — either a string (provider only) or `{ provider, model }`. Resolution falls
  back: per-agent model → provider `per_capability` → provider `default_model`.
  The per-agent key has to be an agent Iris actually dispatches — `page`, `reader`, `copy_editor`,
  `feedback`, `builder`, or any specialist file in `agents/`. There is no `table` key, because
  joining a table split across a page break is a `copy_editor` call. **Getting the key wrong does
  not stop the run**, it just silently doesn't swap anything, so confirm a swap against
  `by_agent.<agent>.models` in diagnostics rather than assuming it.
  Two other keys per provider: `max_tokens` (default 32000) is the per-call **output** ceiling, and a
  reply that stops at it counts as a **failed** call rather than a short one; on Bedrock, `api`
  chooses the wire dialect — `invoke` (the default, and what every published number here was measured
  through) or `converse`, the only one that can reach a non-Anthropic model. Both adapters stream and
  enforce three silence timeouts. Why each of those behaves as it does:
  [design notes](docs/design-notes.md#the-provider-adapters).
- **Concurrency**: two independent knobs under `defaults`.
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
- **Request limits**: the run cap bounds work the deployment has *accepted*;
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
- **GitHub**: GitHub is the auth mechanism — a user *is* their GitHub account, and a token
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

**That is the sustainability model, not an implementation detail.** The agents in
`agents/` get better because sessions run against real documents and real corrections; a user who
could consume the service without contributing would be taking from a library nobody was refilling.
Requiring GitHub auth is how using Iris and improving it become the same act, and how each
contribution is credited to the person who produced it. If you would rather your users not
contribute, this is not the service to deploy.

**A user's token is never written to disk.** It arrives in the `Authorization` header, is used in
memory for the request and for the run it authorizes, and is gone when the run ends. There is no
`github_token` column in `data/iris.sqlite` and no token file — a stolen copy of the database is a
list of GitHub user IDs and logins, not GitHub access. Revoking at github.com is the whole
mechanism; there is nothing here to rotate or purge.

Everything an operator needs beyond that is in **[docs/github-auth.md](docs/github-auth.md)**:
registering your own GitHub App, what a **private** `upstream_repo` can and cannot accept,
`github.issue_token` and what it trades away, the 5-minute identity cache, and — if you are coming
from an earlier build — the two config changes that can stop a working deployment, plus why a
`data/iris.sqlite` from back then has to be deleted rather than adopted.

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

Which model to run each agent on and what each one costs: **[docs/models.md](docs/models.md)**. What
the whole pipeline costs a page — **10.7 cents, broken down by step**:
**[docs/cost.md](docs/cost.md)**. How it got there — **19.4 cents when the model-selection sprint
started, 10.7 measured after two lines of config and no code change** — with the recommended approach
for every step and the evidence under each one:
**[docs/sprint-246.md](docs/sprint-246.md)**.

Example — create a session (order of `images` parts is the processing order):

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
                         #   and specialists dispatched by name
src/
  config.ts              # config loader (${ENV} expansion)
  providers/             # ModelProvider interface + openrouter & bedrock adapters
  agents/loader.ts       # loads agent .md files, pins git SHA
  pipeline/
    orchestrator.ts      # runs the phases, persists results, drives learning
    extraction.ts        # per-page vision pass (+ verify, correct, specialist merge)
    assembly.ts          # joins fragments into the document shell
    review.ts            # reader -> copy editor -> re-lint loop (scoped image payload)
    pageindex.ts         # page-number index shared by the reader + feedback scoping
    lint.ts              # axe-core in jsdom (color-contrast disabled)
    flatten.ts           # screen-reader text view, used by reader + coverage
    feedback.ts          # verify / scope / classify / train + regression gate
    memory.ts            # per-agent example bank of learned corrections
    regression.ts        # fixture capture + pruning on close
    contribute.ts        # drafts suggested agents, files issues
    calibration.ts       # does the fidelity verifier discriminate? (docs/verifier-calibration.md)
  tools/calibrate.ts     # CLI for that measurement; nothing in a run imports it
  util/queue.ts          # bounded FIFO run queue (cross-session concurrency cap)
  auth/                  # GitHub OAuth + device flow + bearer middleware
  github/                # auto-files labeled agent-suggestion issues
  store/                 # node:sqlite metadata store + on-disk session layout
  routes/                # /v1 endpoints
  index.ts               # server entry point
data/                    # sessions/, tmp/, and the SQLite DB (created at runtime)
```

## Further reading

Four of these — the design notes, the CI reference, the verifier calibration and the GitHub-auth
guide — used to be inside this file, and were moved out rather than rewritten: a README should be
readable in one sitting. The only prose dropped instead of moved was a paragraph restating figures
that [docs/models.md](docs/models.md) already carries, with more of the context they need. The rest
of these were always their own documents.

| Document | What is in it |
|---|---|
| [docs/API.md](docs/API.md) | Every endpoint, with copy-pasteable `curl`. The run log's fields. |
| [docs/design-notes.md](docs/design-notes.md) | Why the code is the way it is. Read this before changing it. |
| [docs/models.md](docs/models.md) | Which model runs which agent, and what each choice is worth. |
| [docs/github-auth.md](docs/github-auth.md) | Deploying the GitHub sign-in: your own app, a private upstream, an older database. |
| [docs/cost.md](docs/cost.md) | What a page costs, measured. |
| [docs/ci.md](docs/ci.md) | The five workflows that run this repo, including the bot that will review your PR. |
| [docs/verifier-calibration.md](docs/verifier-calibration.md) | How to re-measure whether the page verifier catches damage. |
| [docs/sprint-246.md](docs/sprint-246.md) | The cost sprint's findings, including what it got wrong. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to open a PR here, and what the agent library is. |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md). Found an
accessibility barrier — in the app or in the HTML it produces? Please open an
[Accessibility issue](.github/ISSUE_TEMPLATE/accessibility.yml); those are our top priority.

PRs get an automated review before a human reads them — see
[Automated code review](docs/ci.md#automated-code-review) for what it looks at and, more usefully,
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
