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

The pipeline runs in five phases (PRD §6):

1. **Triage** — the Image Analysis Agent analyzes each image and writes a notes file listing
   content types, fragment edges, and which content agents to call.
2. **Extraction** — the listed content agents convert their regions to accessible HTML
   fragments. If no agent exists for a content type, the **Builder Agent** drafts one for the
   session.
3. **Reconciliation** — fragments cut off at image boundaries are conservatively stitched.
4. **Assembly** — fragments are combined into one accessible document shell, provenance
   comments preserved, and validated with axe-core.
5. **Review** — the Reader flags reading-order / semantic / accessibility issues; the Copy
   Editor proposes fixes against the source image; the Assembler applies them. Loops up to
   `max_review_iterations` (default 3).

Agents built during a session are ephemeral. The **only** way one becomes permanent is the
GitHub PR workflow on session close: Iris opens a PR upstream, a maintainer merges it, and the
user pulls the updated `agents/` library (PRD §7.13).

## Quick start

Requires **Node.js 24+** (the service runs TypeScript directly via Node's built-in type
stripping and uses the built-in `node:sqlite`), and a **git** checkout of the agent library
(this repo's `agents/` directory works).

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
- **GitHub** (§9.1): OAuth is the only auth mechanism. The token that authenticates a request
  is the same token used to open PRs on `/close`, so `repo` scope is required. By default the
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
| `POST /v1/sessions` | Create a session, upload images (`multipart/form-data`) |
| `GET  /v1/sessions/{id}` | Poll status; preview pending PRs when ready |
| `GET  /v1/sessions/{id}/output` | Fetch the HTML when ready |
| `POST /v1/sessions/{id}/feedback` | Submit feedback, trigger a re-run |
| `POST /v1/sessions/{id}/close` | Accept output, open PRs, clean tmp (`?skip_prs=true` to skip) |
| `GET  /v1/sessions/{id}/logs` | Fetch the run log (ndjson) |

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
  pipeline/              # triage, extraction, builder, reconciliation, assembly, review
  auth/                  # GitHub OAuth + device flow + bearer middleware
  github/                # fork + PR contribution workflow (§7.13)
  store/                 # node:sqlite metadata store + on-disk session layout (§8.1)
  routes/                # /v1 endpoints
  index.ts               # server entry point
data/                    # sessions/, tmp/, and the SQLite DB (created at runtime)
```

## Implementation notes & PRD coverage

A few places where the PRD left a decision open, and where v1 intentionally stops:

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
- **Feedback re-runs (§7.12).** Re-runs are logged separately (a `feedback_rerun` event) and the
  prior `output.html` is snapshotted to `sessions/<id>/history/` so it can be reverted to. A
  revert *endpoint* is out of v1 API scope (not in §9); the data is preserved to enable it.
- **PR contents (§7.13).** The PRD calls for committing test fixtures (input image, produced
  output, lint pass) alongside the agent. We deviate to keep the agent library code-only:
  a new-agent PR commits **only the agent file**, and puts the produced sample output (in a
  collapsible block) and the axe-core lint result in the **PR description** instead. The
  produced HTML isn't a deterministic regression artifact anyway, so the description serves the
  reviewer without cluttering the tree with per-agent fixture directories.

Intentionally **not** built in v1 (the PRD frames each as optional / alternative / out of scope):
PostgreSQL and S3 backends (§10.2 — "supported alternative," SQLite + local FS is the v1
reference), the per-user config endpoint (§9.1 — "not specified in v1"), automated detection of
agent-*updates* (§7.13 names no producer; the close flow opens update PRs if a
`agent-updates.md` JSON file is present), and webhooks (§9.4 — out of scope, API structured to
add them later). The only endpoint beyond the PRD is `GET /v1/health`, a standard liveness probe.

## License

MIT. See the Sustainability notice above — and please consider hiring Equalify to host or
support your instance.
