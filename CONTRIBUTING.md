# Contributing to Equalify Iris

Thanks for helping make document remediation more accessible! Iris is Open Source under
**AGPL-3.0** (see [LICENSE](LICENSE)) and maintained by [Equalify Inc.](https://equalify.app/),
the **University of Illinois Chicago**, and **California State University**.

By participating you agree to our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report an accessibility barrier** — in the app/demo or in the HTML Iris produces. Use the
  **Accessibility issue** template. These are our highest priority.
- **Report a bug / request a feature** — use the matching issue template.
- **Suggest or improve a content agent** — Iris automatically opens `New agent suggestion: <type>`
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
- **`main` is protected: every change lands as a merged pull request.** Direct pushes are
  refused for everyone — maintainers included — and force-pushes and branch deletion are
  blocked. **@bbertucc** merges; a review from them is requested automatically
  ([CODEOWNERS](.github/CODEOWNERS)).
- **No formal approval is required to merge**, so don't wait for a green review checkmark that
  never comes. The gate is a maintainer reading the PR, not a count of approvals — GitHub won't
  let anyone approve their own work, and requiring approvals would block the maintainer's
  changes rather than yours.
- Match the surrounding code style (the codebase favors small, well-commented modules).
- New runtime dependencies should be justified — Iris aims to stay portable and lightweight.
- AGPL-3.0: contributions are licensed under the same terms.

### What the automated review will say

Your PR gets a review from Claude in CI before a maintainer reads it
([details](README.md#automated-code-review)). Useful things to know:

- **It runs the checks itself** and quotes their real output, so a failing `typecheck` or `e2e`
  comes back as a blocking finding with the relevant lines.
- **It will not nit-pick style, formatting or naming.** There's no linter or formatter in this
  repo on purpose. It's also told not to suggest alternatives when your approach is correct, and
  not to raise pre-existing issues your PR doesn't touch. If it does one of those anyway, that's a
  bug in the prompt — say so on the PR.
- **`### Non-blocking notes` means "merge-ready".** A finding only blocks if something reaches it
  on input the code accepts today; real-but-unreachable findings are notes on an *approval*. You
  don't have to resolve them to merge, and you don't have to argue your way out of them.
- **Its verdict is advisory, and its check is not a merge gate.** A human merges. The check is
  deliberately not required on `main`, because it could not be a trustworthy gate: a PR touching
  only ignored paths never triggers it at all, a PR editing the workflow makes it report success,
  and a fork PR's skipped job counts as satisfied — the last two with nothing having reviewed the
  code. If you think a blocking finding is wrong, reply on the PR — the reviewer sees its earlier
  reviews on re-runs, but it is the maintainer you're actually talking to.
- **Fork PRs aren't reviewed automatically** (a fork PR gets no CI secrets). A maintainer
  dispatches the review manually; nothing is needed from you.
- **Editing `.github/workflows/code-review.yml` disables its own review.** Expect a warning
  saying so and a slower human read.

## Architecture (orientation)

`src/pipeline` (extraction → assembly → review), `src/providers` (LLM provider abstraction),
`src/routes` (the `/v1` API), `src/auth` (GitHub OAuth), `agents/` (the content-agent library).
See [README.md](README.md) and [docs/API.md](docs/API.md).
