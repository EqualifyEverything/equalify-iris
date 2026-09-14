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
- **One GitHub identity, held by the server.** There is no sign-in. You set one GitHub token; Iris
  uses it to file every session's contributions. Callers send nothing — or a shared secret, if you
  gate the deployment. Simple, and it costs per-user attribution and session isolation:
  [what that means](#one-github-identity-and-no-sign-in).

---

## How it works

The pipeline as **implemented today** runs in three phases:

1. **Extraction** — for each page image, the `page` agent (`agents/page.md`) converts the whole
   page to an accessible HTML fragment in one vision call. The output is then verified, and
   corrected if the verifier objects. If the page agent names a content type a specialist would
   handle better, that specialist is dispatched and its output merged. Pages are independent, so
   they are extracted **in parallel** — up to `defaults.extraction_concurrency` at a time — and
   fragments keep submitted document order regardless of which page finishes first.
2. **Assembly** — fragments are joined in page order into a minimal accessible document shell
   (`<html lang>`, `<title>`, `<main>`) and validated with axe-core.
3. **Review** — the Reader reads the document in chunks as two views (HTML + a flattened
   screen-reader view) and flags reading-order / semantic / accessibility issues, attributing
   each to the source page(s) it appears on; the Copy Editor proposes fixes against **just those
   pages'** source images; fixes are applied and the document re-linted. Loops up to
   `max_review_iterations` (default 3), or until a round changes nothing. A document that spans
   several chunks is read in parallel under the same concurrency cap, and the issues the chunks
   raise stay in chunk order.

When Iris meets content a specialist agent would handle better than the general pass, it drafts
that agent and **files a GitHub issue titled `New agent suggestion: <type>`** (with the agent code
and context) on `upstream_repo`. Maintainers triage those issues; merged agents become part of the
shared `agents/` library. The title prefix is what identifies them — not a label, for a reason worth
knowing before you change it
([design notes](docs/design-notes.md#learning-from-feedback)).

## Terms

Five words in this repo mean something narrower than in ordinary English, and every document here
uses them in these senses. **Each also carries at least one unrelated sense**, so the text has to say
which it means.

- **fragment** — one page's extracted HTML plus the record of where it came from: the source image,
  the page's position, the agent, its log line, and any edges where content looked cut off (`Fragment`
  in `src/pipeline/fragment.ts`). *Also:* a URL fragment identifier (the `#id` a link points at), and
  the `issue-<n>` part of a branch name in [docs/ci.md](docs/ci.md).
- **block** — one top-level element of the assembled document, with everything nested inside it. The
  Copy Editor is normally shown the document with a `<!-- @block N -->` comment above each one and
  replies with replacements for just the blocks it changed; a document too long for one reply is cut
  into sections at those same boundaries (`src/pipeline/review.ts`). *Also:* a mapping in the config
  file, a `run:` block in a workflow, and a group of table rows in the measurement docs.
- **verdict** — the Feedback Agent's decision about one page: two booleans, `faithful` and
  `accessible`, plus the problems it lists. **Both booleans have to be there** — a reply missing either
  is not a verdict and is not counted as one (`VerifyOutput` in `src/pipeline/feedback.ts`). *Also:* a
  CI session's structured output in [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/ci.md](docs/ci.md),
  which is about your repository rather than a page.
- **declaration** — the page agent's claim that a page holds no content. It is a claim, not an
  absence: the pipeline can refuse it, because a page too dark to read is not a blank page
  (`blankDeclaration` in `src/pipeline/extraction.ts`, and
  [how the claim is read](docs/design-notes.md#reading-a-blank-page-declaration)). *Also:* the `lang`
  declaration on the document's root element.
- **round** — one pass of the review loop. `max_review_iterations` (default 3) caps the editor rounds,
  so the Reader can read up to four times. *Also:* one captured run of a corpus through the pipeline,
  named like `runs-postswap-312` and kept with its own logs and prices — a **benchmark round** if it
  ran here, a **deployed round** if it ran on a deployment. [docs/models.md](docs/models.md) and
  [docs/cost.md](docs/cost.md) each gloss the difference themselves.

## Quick start

Requires **Node.js 24+** (the service runs TypeScript directly via Node's built-in type stripping and
uses the built-in `node:sqlite`), and a **git** checkout of the agent library (this repo's `agents/`
directory works). For **PDF uploads**, install **poppler-utils** (`pdftoppm`/`pdfinfo`, plus
`pdftohtml` to carry the PDF's links into the output) — `brew install poppler` on macOS,
`apt-get install poppler-utils` on Debian/Ubuntu; the Docker image includes it. Rasterizing is what
the uploader waits for and Iris spreads it across cores, so **give a PDF deployment cores**
([how much they buy](docs/design-notes.md#running-the-service)).

```bash
git clone https://github.com/EqualifyEverything/equalify-iris
cd equalify-iris
npm install

cp .env.example .env          # a model provider key, and your GitHub token
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

Or just open the **accessible browser app** at `http://localhost:8080/` for a no-API walkthrough — no
sign-in, no token (upload page images → convert → view the accessible HTML).

## Configuration

Deployment is configured in `config.yaml`. `${ENV_VAR}` references are expanded from the environment
at startup; changes require a restart. **[`config.example.yaml`](config.example.yaml) documents every
key inline** — this section is the decisions an operator has to make, not the key list.

- **GitHub — required.** `github.token` is a fine-grained PAT with `Issues: read and write` on
  `upstream_repo`, and Iris will not start without it. There is no app to register and no OAuth app:
  nothing here runs a login flow. See [One GitHub identity](#one-github-identity-and-no-sign-in).
- **Who may call the API.** `server.api_token` is a shared secret, blank by default. Blank means
  **open** — anyone who can reach the port can convert documents and spend your model budget. Set it
  on a public deployment.
- **Storage.** Local filesystem plus a single SQLite file. `agents/` is a git checkout modified only
  by `git pull` from upstream. These are the only backends v1 ships; Postgres and S3 were designed for
  and deliberately not built ([design notes](docs/design-notes.md#designed-for-and-not-built)).
- **Model providers** ([docs/models.md](docs/models.md)). Each agent declares a *capability*
  (`vision`, `structured_output`, `text`) and the deployment maps capabilities to a provider and a
  concrete model, with an optional per-agent override. Resolution falls back: per-agent model →
  provider `per_capability` → provider `default_model`. v1 ships **OpenRouter** and **Amazon Bedrock**;
  adding one is a small adapter implementing `ModelProvider` in `src/providers/types.ts`. **Getting a
  `providers.per_agent` key wrong does not stop the run** — it silently swaps nothing, so confirm a
  swap against `by_agent.<agent>.models` in diagnostics. Two keys are easy to get wrong for the same
  reason: `max_tokens` is the per-call **output** ceiling and a reply that stops at it counts as a
  **failed** call, and on Bedrock `api` chooses the wire dialect — `invoke` (the default, and what
  every published number here was measured through) or `converse`, the only one that reaches a
  non-Anthropic model. Why each adapter rule exists:
  [design notes](docs/design-notes.md#the-provider-adapters).
- **Concurrency.** Two independent knobs under `defaults`. `extraction_concurrency` (default 5) is
  *within* a run and covers both phases' parallel calls; `max_concurrent_runs` (default 2) is *across*
  sessions, and is the one that bounds what the machine is doing — peak in-flight calls is the product
  of the two, and each run also holds a jsdom+axe instance. Uploads beyond the cap **wait**, in FIFO
  order, in `status: "queued"`, and the wait shows up as `run_queued` / `run_dequeued` in the session's
  run log. Nothing is rejected: the upload is already on disk, so a 429 would discard work.
- **Request limits.** `server.rate_limits` bounds what can be **asked** of the deployment, which is a
  different problem from the run cap — the cheap endpoints never reach the queue and each queries
  SQLite synchronously on the one event loop. These gates **refuse** (429 with `Retry-After`) rather
  than wait, since nothing has been received yet. Every request counts against its **address**, there
  being one identity here, so callers behind one NAT share a bucket. `GET /v1/limits` publishes
  whatever is in effect; `enabled: false` turns it off where a proxy already does the job.
- **Behind a reverse proxy.** Set `server.trust_proxy` to the number of proxies in front of Iris (1
  for a single Caddy/nginx). Without it every caller presents as the proxy's address and shares one
  bucket; the log warns when it sees an `X-Forwarded-For` while this is unset. Anything Iris cannot
  interpret warns and trusts nothing rather than failing startup.

### One GitHub identity, and no sign-in

Iris holds **one** GitHub token, server-side, and callers never present a GitHub credential. That
token is what files each session's feedback back to the shared agent library as an issue on
`upstream_repo`. **Contributing back is the sustainability model, not an implementation detail:** the
agents in `agents/` get better because sessions run against real documents and real corrections, and a
deployment that consumed the service without contributing would be taking from a library nobody was
refilling.

What the single identity costs, all of which Iris warns about at boot:

- **No attribution.** Every issue is filed as your token's account. It says what a session found, not
  who found it.
- **No session isolation.** `GET /v1/sessions` lists *the deployment's* sessions, and a session id is
  all it takes to read that document. Visitors are not walled off from each other, because there is
  nobody to wall off.
- **Limits per address**, since the only credential a caller can present is shared.

**So decide who may call it.** `server.api_token` gates `/v1/me` and `/v1/sessions` behind a shared
secret you hand out; blank leaves them open. Health, limits, stats and quality stay reachable either
way — none of them touches a document. Gating also turns off the bundled browser app, which holds no
credential: that is the trade.

**Nothing about a caller is stored.** Callers do not authenticate, so there is nothing to store about
them. There is no `github_token` column in `data/iris.sqlite` and no token file: a stolen copy of the
database holds your deployment's own GitHub user ID and login plus session history, not GitHub access.
Your token lives in your environment, like any other server secret.

Everything an operator needs — making the token, what an expired one breaks (filing, and nothing
else), the two 401s, and why a `data/iris.sqlite` from an earlier build has to go — is in
**[docs/github-auth.md](docs/github-auth.md)**.

## API

All endpoints are under `/v1`. **No endpoint takes a GitHub token.** Where `server.api_token` is set,
`/v1/me` and everything under `/v1/sessions` need `Authorization: Bearer <server.api_token>`; where it
is blank they need no header at all. Health, limits and stats never do. `/v1/quality` is the exception
in the other direction: it has its own shared secret and 404s unless you set it.

| Method & path | Purpose |
| --- | --- |
| `GET  /v1/health` | Liveness probe (never gated) |
| `GET  /v1/stats` | Public tally of pages converted, plus a two-number quality summary (never gated; aggregate only) |
| `GET  /v1/quality` | Deployment-wide tally of output *quality* (own shared secret, off by default; aggregate only) |
| `GET  /v1/limits` | What an upload may be — formats, per-image size, page cap (never gated) |
| `GET  /v1/me` | What this deployment is: its GitHub account, upstream repo and defaults. Also the probe for whether it is gated |
| `GET  /v1/sessions` | List **the deployment's** sessions — see the note above on isolation |
| `POST /v1/sessions` | Create a session, upload images and/or PDFs (`multipart/form-data`) |
| `GET  /v1/sessions/{id}` | Poll status |
| `GET  /v1/sessions/{id}/output` | Fetch the HTML when ready |
| `POST /v1/sessions/{id}/feedback` | Submit feedback, trigger a re-run |
| `POST /v1/sessions/{id}/close` | Finalize the session and clean tmp |
| `GET  /v1/sessions/{id}/logs` | Fetch the run log (ndjson) |
| `GET  /v1/sessions/{id}/diagnostics` | Cost/timing/health summary (token counts per run and per agent, phase + per-call durations, in-flight/hung call) |

Example — create a session (order of `images` parts is the processing order):

```bash
curl -X POST http://localhost:8080/v1/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -F "images=@page-001.png" \
  -F "images=@page-002.png"
```

Then poll `GET /v1/sessions/{id}` until `status` is `ready_for_review`, fetch
`GET /v1/sessions/{id}/output`, and `POST /v1/sessions/{id}/close` to finalize.

Copy-pasteable `curl` for every endpoint, and every run-log event's fields:
**[docs/API.md](docs/API.md)**. To prove the endpoints work end to end with no credentials (mock
GitHub, mock model): `./test/e2e.sh`.

**What it costs is a config choice, because every model is named in your config and never in Iris's
code:** nothing per token against a self-hosted open-weight model, or about **10.7 cents a page** for
the suggested setup, measured over 100 scanned pages. Which model to run each agent on, and how a
swap fails quietly: **[docs/models.md](docs/models.md)**. The price per step, and why cost per page
is a worse number than it looks: **[docs/cost.md](docs/cost.md)**.

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
  auth/                  # resolves the deployment's one GitHub identity; gate middleware
  github/                # files agent-suggestion issues, identified by title prefix
  store/                 # node:sqlite metadata store + on-disk session layout
  routes/                # /v1 endpoints
  index.ts               # server entry point
data/                    # sessions/, tmp/, and the SQLite DB (created at runtime)
```

## Working on Iris — including if you are an AI agent

**Read [docs/design-notes.md](docs/design-notes.md) before changing code.** It is one bullet per
decision, written for someone about to change the thing the bullet is about, and most of what looks
arbitrary in this codebase is a bullet in there with a measurement attached.

Every doc has one job, and a change belongs in the doc whose job it is. Put it in the same PR as the
change:

| If you change… | Update | Which holds |
| --- | --- | --- |
| behaviour, or the reason for it | [docs/design-notes.md](docs/design-notes.md) | the reasoning, the benchmark evidence, superseded behaviour, and what a rule cost before it existed |
| an endpoint, response field, or run-log event | [docs/API.md](docs/API.md) | what fires a line, what its fields hold, and the remedy — a reference for API consumers, not the rationale |
| which model runs an agent | [docs/models.md](docs/models.md) | **suggested** models. Every model is declared in config, never in the code, so no doc may say Iris "uses" one |
| the price of a step | [docs/cost.md](docs/cost.md) | prices with the round each came from. Iris costs nothing per token on self-hosted open-weight models; only a suggested config has a price |
| a workflow in `.github/` | [docs/ci.md](docs/ci.md) | the five workflows, including the bot that reviews your PR |
| the token, the gate, or what a 401 means | [docs/github-auth.md](docs/github-auth.md) | the operator's side of the one identity |
| a config key | [`config.example.yaml`](config.example.yaml) | the key list, documented inline. This README states decisions, not keys |
| one of the five words in [Terms](#terms) | every doc that uses it | each is narrower here than in English and each has an unrelated sense |

Four things that catch most mistakes:

- **Concise plain language is a requirement, not a preference** — see
  [CONTRIBUTING.md § Documentation](CONTRIBUTING.md#documentation) for what it asks for. The automated
  review checks docs prose against it as a non-blocking note.
- **Deleting a mechanism leaves its claims behind.** Sweep every doc, code comment and deployment
  manifest for sentences about what you removed. A claim can sit twenty lines from its own
  contradiction, and a key you promote to *required* breaks every manifest that never passed it.
- **A number needs its corpus.** Anything asserted about behaviour or cost has to be checkable against
  code, a test, or a named round — and the named round has to say which pages it covers.
- **Do not write a closing keyword next to an issue number** you do not mean to close. GitHub closes
  issues from PR bodies and commit messages, including from prose.

Commands: `npm test` is `node --test` over `test/*.test.ts` (not vitest), `npm run typecheck` is
`tsc --noEmit`, and `./test/e2e.sh` runs the whole lifecycle against mocks with no credentials.

## Further reading

| Document | What is in it |
|---|---|
| [docs/API.md](docs/API.md) | Every endpoint, with copy-pasteable `curl`. The run log's fields. |
| [docs/design-notes.md](docs/design-notes.md) | Why the code is the way it is. Read this before changing it. |
| [docs/models.md](docs/models.md) | Which model to run on which agent, what each was measured at, and the four ways a swap fails. |
| [docs/github-auth.md](docs/github-auth.md) | The GitHub token: making it, what one identity costs, gating the API, an older database. |
| [docs/cost.md](docs/cost.md) | What a page costs, measured, and why that number hides more than it says. |
| [docs/ci.md](docs/ci.md) | The five workflows that run this repo, including the bot that will review your PR. |
| [docs/verifier-calibration.md](docs/verifier-calibration.md) | How to re-measure whether the page verifier catches damage. |
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
