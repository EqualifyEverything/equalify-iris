# Contributing to Equalify Iris

Thanks for helping make document remediation more accessible! Iris is Open Source under
**AGPL-3.0** (see [LICENSE](LICENSE)) and maintained by [Equalify Inc.](https://equalify.app/),
the **University of Illinois Chicago**, and **California State University**.

By participating you agree to our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report an accessibility barrier** — in the app/demo or in the HTML Iris produces. Use the
  **Accessibility issue** template. These are our highest priority.
- **Report a bug / request a feature** — use the matching issue template.
- **Improve a prompt** — the agent files are in [`agents/`](agents/), and `agents/page.md`
  renders every page, so a PR that sharpens it changes the product. (The Reader and Copy Editor
  prompts are code, in `src/pipeline/review.ts`.) Iris also opens `New agent suggestion: <type>`
  issues when it meets content a specialist would handle better, and you're welcome to open one
  yourself — but note that `agents/` is not a directory of content types: a file added for a type
  the whole-page pass already covers is never loaded — the
  [design notes](docs/design-notes.md#the-pipelines-shape) say why, under "One agent per page, not
  one per content type". `chartDataAgent.md` is the shape that earns its place.
- **Code** — bug fixes and improvements via pull request.

A well-written issue may get a pull request without you doing anything else. A scheduled workflow
ranks the open issues Sun–Wed and opens one PR for the most pressing one it can finish well
([details](docs/ci.md#scheduled-issue-triage)) — accessibility barriers rank first, and small
user-visible fixes reported against the demo rank well because they review cleanly. It never
touches an issue labelled `no-auto-pr`, never files a second PR for an issue it has already tried,
and stops entirely when nothing is eligible. If you'd rather own the fix yourself, say so on the
issue and add that label.

**You get the credit for it.** A PR from that workflow names you in its body and carries a
`Co-authored-by` trailer for your account on the commit, so the merged commit is attributed to you
as well as to the bot that typed it — the report is the contribution. The trailer uses your
GitHub `users.noreply` address, never your real email.

**It also stays off any issue that already has an open PR — including yours.** Open a PR for an
issue and the workflow leaves it alone; if every open issue has one, it opens nothing at all. Two
things claim an issue: **`Closes #<n>` in your PR body** (which also closes the issue on merge, so
this is the one to use) or an `issue-<n>` in your branch name. Merely mentioning `#<n>` in prose
does *not* claim it — too many PRs reference issues they aren't fixing — so if you are working on
something, say `Closes #<n>` and the robot will stay out of your way.

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
npm test                        # the unit suite (node --test; run it through npm, see below)
./test/e2e.sh                   # full API lifecycle against mock GitHub + mock model (needs jq)
```

Run the unit suite through `npm`, not as a bare `node --test`. The `npm test` script
registers a second reporter (`test/spec-with-signals.mjs`) that prints `signal` and
`exitCode` when a test file's *process* dies. Node's default reporter shows that as `✖
some.test.ts` and `'test failed'` — identical to a failed assertion, with nothing on
stderr — and the tests after the death simply never run, so the pass count reads clean
while being short. See #405.

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
([details](docs/ci.md#automated-code-review)). Useful things to know:

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
  only ignored paths never triggers it at all, and a fork PR's skipped job counts as satisfied
  with nothing having reviewed the code. If you think a blocking finding is wrong, reply on the
  PR — the reviewer sees its earlier reviews on re-runs, but it is the maintainer you're actually
  talking to.
- **Fork PRs aren't reviewed automatically** (a fork PR gets no CI secrets). A maintainer
  dispatches the review manually; nothing is needed from you.
- **A PR touching `.github/workflows/**` gets a CI-security review first.** The workflows are part
  of the app, so expect questions about `permissions:`, secrets reaching PR-authored code, and
  `${{ }}` in `run:` blocks before anything about accessibility. Changing `code-review.yml` itself
  also works now, with one visible difference: the review posts as **github-actions[bot]** rather
  than claude[bot], and the PR gets a comment explaining why and asking for a human read as well.
- **`iris-auto/*` PRs aren't reviewed automatically either.** Those come from the scheduled triage
  workflow, and GitHub doesn't start workflow runs for events raised by `GITHUB_TOKEN`. Each one
  carries a comment saying so with the dispatch command. Nothing is needed from contributors.

## Architecture (orientation)

`src/pipeline` (extraction → assembly → review), `src/providers` (LLM provider abstraction),
`src/routes` (the `/v1` API), `src/auth` (GitHub OAuth), `agents/` (the agent prompt files).
See [README.md](README.md) and [docs/API.md](docs/API.md).
