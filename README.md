# Equalify Iris

Iris turns the pages of a PDF into one accessible HTML document that meets WCAG 2.2 AA. A vision
model reads each page, using prompts anyone can improve. Then a reader and a copy editor review the
whole document and fix what they find. With the optional
[equalify-iris-pdf](https://github.com/EqualifyEverything/equalify-iris-pdf), the HTML can also go
back into a tagged PDF.

**To see how it works, open `/how-it-works` on a running Iris.** It takes one document through every
step in plain language, with each step's settings and the API calls it made.

- **Content only.** No CSS and no visual layout: a two-column page becomes linear, semantic HTML.
  Styling is left to the tools that use Iris, such as the
  [WordPress plugin](https://github.com/EqualifyEverything/equalify-iris-wp) and the
  [Drupal module](https://github.com/oshrizak/equalify-iris-drupal).
- **Runs on one machine.** A laptop or a self-hosted box is enough. The model provider, database and
  file store are set in the config.
- **No sign-in.** Every session belongs to the deployment, so anyone who can call it can read every
  document. `server.api_token` gates it ([docs/access.md](docs/access.md)).

We're focused on the most accessible HTML conversion we can deliver. Success rate, speed and cost are
measured in [equalify-iris-bench](https://github.com/EqualifyEverything/equalify-iris-bench).

## Quick start

Requires **Node.js 24.15+** and **git**. For PDF uploads, also **poppler-utils** (`brew install
poppler` or `apt-get install poppler-utils`; the Docker image has it). Turning pages into images is
what an upload waits for, so give a PDF deployment cores
([how much they buy](docs/design-notes.md#running-the-service)).

```bash
git clone https://github.com/EqualifyEverything/equalify-iris
cd equalify-iris
npm install

cp .env.example .env          # a model provider key
cp config.example.yaml config.yaml

# load env and run
set -a; source .env; set +a
npm start                     # -> http://localhost:8080
```

Or with Docker (multi-arch; Mac Mini / Linux ARM are first-class targets):

```bash
cp .env.example .env          # fill in values

# Linux only, and only if your user is not uid 1000: the container runs as uid 1000 and writes
# sessions to ./data, which keeps its ownership from the host. macOS and Windows need nothing,
# because Docker runs in a VM that remaps ownership.
sudo chown -R 1000:1000 ./data

docker compose up
```

Check it's alive, and which build it is:

```bash
curl http://localhost:8080/v1/health
# {"status":"ok","service":"equalify-iris","version":"1.3.0"}
```

Then open `http://localhost:8080/` to convert a document in the browser (off once you set
`server.api_token`), or `http://localhost:8080/how-it-works` to watch each step.

## Command line

Convert a file with your `config.yaml`, without running the server:

```bash
npm run convert -- document.pdf -o output.html
```

`npm run convert -- --help` lists the options.

## Configuration

[`config.example.yaml`](config.example.yaml) documents every key inline. `${ENV_VAR}` references are
read from the environment at startup. The decisions to make:

- **Who may call the API:** `server.api_token`. Blank means anyone who can reach the port
  ([docs/access.md](docs/access.md)).
- **Which model runs each agent:** [docs/models.md](docs/models.md). A wrong `providers.per_agent`
  key does not stop a run; it swaps nothing, so check the model a step names on `/how-it-works`.
- **Behind a reverse proxy:** set `server.trust_proxy`, or every caller shares the proxy's rate
  limit.
- **Tagged PDFs:** set `tagged_pdf.command` to the `iris-pdf` command. Off by default.
- **Storage** is local files and one SQLite file. Postgres and S3 were designed for and not built
  ([design notes](docs/design-notes.md#designed-for-and-not-built)).

## API

Every endpoint, who may call it, and its exact request and answer:
[docs/openapi.yaml](docs/openapi.yaml), served as `GET /v1/openapi.json`. The basic flow:

```bash
curl -X POST http://localhost:8080/v1/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -F "images=@page-001.png" \
  -F "images=@page-002.png"
```

The order of the `images` parts is the processing order. Then poll `GET /v1/sessions/{id}` until
`status` is `ready_for_review`, fetch `GET /v1/sessions/{id}/output`, and
`POST /v1/sessions/{id}/close`. Leave out the `Authorization` header on an open deployment.

## Contributing back

When Iris meets content a specialist agent would handle better, or feedback that improves an agent,
it saves a suggestion. A workflow groups these and files one GitHub issue per idea
([Agent suggestions](docs/ci.md#agent-suggestions)), and merged agents join the shared `agents/`
library. **This is the sustainability model:** the agents improve because sessions run against real
documents and real corrections.

## Documentation

| Document | What is in it |
|---|---|
| `/how-it-works` on a running Iris | Each step, its settings and API calls, on a real document. Open a session there to see what went wrong. Start here. |
| [docs/openapi.yaml](docs/openapi.yaml) | Every endpoint: what it takes and returns. |
| [docs/run-log.md](docs/run-log.md) | Every field Iris reports about a run: the run log, diagnostics, the quality tally, partial documents, failure messages. |
| [docs/design-notes.md](docs/design-notes.md) | Why the code is the way it is. Read it before changing the code. |
| [docs/models.md](docs/models.md) | Which model to run on which agent, and what each was measured at. |
| [docs/cost.md](docs/cost.md) | What a page costs, measured, and why that number hides more than it says. |
| [docs/access.md](docs/access.md) | Gating the API, what a shared deployment means, an older database. |
| [docs/ci.md](docs/ci.md) | The workflows that run this repo, including the bot that reviews PRs. |
| [docs/verifier-calibration.md](docs/verifier-calibration.md) | How to re-measure whether the page verifier catches damage. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to work on Iris: setup, layout, terms, which doc a change belongs in. |
| [ACCESSIBILITY.md](ACCESSIBILITY.md) | Reporting a barrier, and how Iris's accessibility is tested. |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md). Found an
accessibility barrier, in the app or in the HTML it produces? Please open an
[Accessibility issue](.github/ISSUE_TEMPLATE/accessibility.yml); those are our top priority.

## License

**[GNU AGPL-3.0-or-later](LICENSE).** Iris is copyleft: if you modify it and run it as a
network service, you must make your modified source available to its users (AGPL §13).

Iris is maintained by **Equalify Inc.**, the **University of Illinois Chicago**, and
**California State University**.

**Commercial hosting and support are offered by [Equalify Inc.](https://equalify.app/)** The
hosted and self-hosted versions are functionally identical — what you are paying for is
operational (managed deployment, monitoring, accessibility consulting), not features withheld
from this repo. Please consider hiring them to host or support your instance.
