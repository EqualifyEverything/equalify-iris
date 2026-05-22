# Contributing to Equalify Iris

Thanks for helping make document remediation more accessible! Iris is Open Source under
**AGPL-3.0** (see [LICENSE](LICENSE)) and built/stewarded by [Equalify Inc](https://equalify.app/).

By participating you agree to our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report an accessibility barrier** — in the app/demo or in the HTML Iris produces. Use the
  **Accessibility issue** template. These are our highest priority.
- **Report a bug / request a feature** — use the matching issue template.
- **Suggest or improve a content agent** — Iris automatically opens `iris-agent-suggestion`
  issues when it meets content a specialist agent would handle better. You're welcome to open
  one yourself, or send a PR adding/improving a file in [`agents/`](agents/).
- **Code** — bug fixes and improvements via pull request.

## Development

Requires **Node 24+** (runs TypeScript directly; uses built-in `node:sqlite`), **git**, and —
for PDF uploads — **poppler-utils** (`brew install poppler` / `apt-get install poppler-utils`).

```bash
npm install
cp .env.example .env            # GitHub OAuth (optional) + a model provider key
cp config.example.yaml config.yaml
npm start                       # http://localhost:8080  (app at /, API under /v1)
```

Before opening a PR:

```bash
npm run typecheck               # tsc --noEmit
./test/e2e.sh                   # full API lifecycle against mock GitHub + mock model (needs jq)
```

The demo page must stay accessible — it's audited with the project's own axe-core lint and
should report **0 violations**.

## Pull requests

- Branch from `main`, keep PRs focused, and describe the change + how you tested it.
- Match the surrounding code style (the codebase favors small, well-commented modules).
- New runtime dependencies should be justified — Iris aims to stay portable and lightweight.
- AGPL-3.0: contributions are licensed under the same terms.

## Architecture (orientation)

`src/pipeline` (extraction → assembly → review), `src/providers` (LLM provider abstraction),
`src/routes` (the `/v1` API), `src/auth` (GitHub OAuth), `agents/` (the content-agent library).
See [README.md](README.md) and [docs/API.md](docs/API.md).
