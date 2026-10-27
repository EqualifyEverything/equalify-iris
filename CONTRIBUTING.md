# Contributing to Equalify Iris

Thanks for helping make document remediation more accessible! Iris is Open Source under
**AGPL-3.0** (see [LICENSE](LICENSE)) and maintained by [Equalify Inc.](https://equalify.app/),
the **University of Illinois Chicago**, and **California State University**.

By participating you agree to our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report an accessibility barrier** — in the app/demo or in the HTML Iris produces. Use the
  **Accessibility issue** template. These are our highest priority. See [ACCESSIBILITY.md](ACCESSIBILITY.md)
  for reporting guidance and accessibility checks for contributions.
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

A well-written issue may get a pull request without you doing anything else. An owner first labels
it `maintainer` (a bot tags them when it's time). A scheduled workflow then ranks those issues
Sun–Wed and opens one PR for the most pressing one it can finish well
([details](docs/ci.md#scheduled-issue-triage)) — accessibility barriers rank first, and small
user-visible fixes reported against the demo rank well because they review cleanly. It never
touches an issue labelled `no-auto-pr`, never files a second PR for an issue it has already tried,
and stops entirely when nothing is eligible. If you'd rather own the fix yourself, say so on the
issue and ask for the `no-auto-pr` label.

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

Set up as in the README's [Quick start](README.md#quick-start).

**Read [docs/design-notes.md](docs/design-notes.md) before changing code.** It is one bullet per
decision, and most of what looks arbitrary here is a bullet in there with a measurement attached.

Before opening a PR:

```bash
npm run typecheck               # tsc --noEmit
npm test                        # the unit suite (node --test; run it through npm, see below)
./test/e2e.sh                   # full API lifecycle against mock GitHub + mock model (needs jq)
```

Run the unit suite through `npm`, not as a bare `node --test`. The script carries two
things a bare run does not:

- **A second reporter** (`test/spec-with-signals.mjs`) that prints `signal` and `exitCode`
  when a test file's *process* dies. Node's default reporter shows that as `✖ some.test.ts`
  and `'test failed'` — identical to a failed assertion, with nothing on stderr — and the
  tests after the death simply never run, so the pass count reads clean while being short.
- **`--no-sparkplug`**, which avoids a V8 bug that segfaults test children inside the
  garbage collector roughly once in ten full runs on macOS arm64. The crash needs code
  Sparkplug generates, so turning that tier off removes the path; it cost nothing
  measurable here (two runs each, 55.8 s either way). It is on the test script only: `npm start`
  and `npm run dev` keep the Sparkplug path on purpose, because one dev server dying is loud,
  where a dead test child reads as a clean run with a short count. **Drop the flag when
  [nodejs/node#65753](https://github.com/nodejs/node/pull/65753) ships in a 24.x release** —
  it is the backport of the V8 fix, and no released 24.x has it yet.

Both exist because of #405, which has the crash stack and the evidence.

The demo page must stay accessible — it's audited with the project's own axe-core lint and
should report **0 violations**.

## Documentation

**Docs here are written in concise plain language. That is a requirement, not a preference.** It
covers `README.md`, everything under `docs/`, the comments in `config.example.yaml`, and the agent
prompts in `agents/` — every one of them is read by someone deciding whether to trust Iris with a
document, and the prompts are read by a model as well.

What it asks for:

- **One idea per sentence.** If a sentence needs a second read, split it.
- **The claim first, the caveat after.** Never the reverse.
- **A number instead of an adjective.** "About 10.7¢ a page" beats "cost-effective". Anything you
  assert about behaviour should be checkable against code, a test, or a named benchmark round.
- **No jargon without a gloss on first use**, and no new term where a plain one exists.
- **No repetition.** A paragraph that restates the one above it gets deleted, not softened.
- **One job per document, and no restating another one.** A claim lives in the document whose job it
  is, and the others link to it — that is what keeps this set DRY and cheap to correct, since a claim
  written twice is a claim that goes stale in one place. [Which doc a change belongs
  in](#which-doc-a-change-belongs-in) says which document holds what.
- **Shorter over completer.** A page nobody finishes documents nothing.

Two things this is not. It is not a ban on detail — an exact number, a file path, or a caveat that
saves a reader an hour all belong in. And it is not about formatting: there is no linter here, and
nothing checks heading style, line length or word choice.

**Who checks it:** the automated review, then a maintainer. On a PR touching those files the
reviewer quotes a sentence that breaks one of the rules above and names the rule, as a
[non-blocking note](#what-the-automated-review-will-say) — at most three, the worst ones. It is the
only prose it comments on, and a note is not a merge gate. It checks the last rule on what a PR
adds: a new file or section where a line in an existing doc would do, or a paragraph that could be a
sentence. It quotes the addition and writes the shorter version.

A PR that only makes an existing doc plainer is welcome, with no code change attached.


## Which doc a change belongs in

Put the doc change in the same PR as the change.

| If you change… | Update | Which holds |
| --- | --- | --- |
| behaviour, or the reason for it | [docs/design-notes.md](docs/design-notes.md) | the reasoning, the benchmark evidence, superseded behaviour, and what a rule cost before it existed |
| an endpoint, a parameter or a response field | [docs/openapi.yaml](docs/openapi.yaml) | the exact contract, which `/how-it-works` builds its API section from; tests fail if a route or error code is missing |
| a run-log event, a diagnostics or quality-tally field | [docs/run-log.md](docs/run-log.md) | what fires a line and what its fields hold |
| which model runs an agent | [docs/models.md](docs/models.md) | **suggested** models. Every model is declared in config, never in the code, so no doc may say Iris "uses" one |
| the price of a step | [docs/cost.md](docs/cost.md) | prices with the round each came from. Iris costs nothing per token on self-hosted open-weight models; only a suggested config has a price |
| accessibility reporting, testing, or support information | [ACCESSIBILITY.md](ACCESSIBILITY.md) | reporting and triage guidance, contributor checks, and testing limitations |
| a workflow in `.github/` | [docs/ci.md](docs/ci.md) | the workflows, including the bot that reviews your PR |
| the gate, or what a 401 means | [docs/access.md](docs/access.md) | who may call the API, and an older database |
| a pipeline step, or a run-log event a person needs explained | [`public/how-it-works.html`](public/how-it-works.html) | the walkthrough. An event's one-line meaning comes from run-log.md's index, so only a new step or a plainer sentence (`SAY`) needs an edit here |
| a config key | [`config.example.yaml`](config.example.yaml) | the key list, documented inline. README states only the decisions |
| one of the five words in [Terms](#terms) | every doc that uses it | each is narrower here than in English and each has an unrelated sense |

Three more things that catch most mistakes:

- **Deleting a mechanism leaves its claims behind.** Sweep every doc, code comment and deployment
  manifest for sentences about what you removed. A claim can sit twenty lines from its own
  contradiction, and a key you promote to *required* breaks every manifest that never passed it.
- **A number needs its corpus.** Anything asserted about behaviour or cost has to be checkable against
  code, a test, or a named round — and the named round has to say which pages it covers.
- **Do not write a closing keyword next to an issue number** you do not mean to close. GitHub closes
  issues from PR bodies and commit messages, including from prose.

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
- **One exception: docs prose.** On a PR touching the files the [Documentation](#documentation)
  section covers, it checks prose against those rules — quoting the sentence, naming the rule, three
  at most, always as a non-blocking note. The list of files lives in that section, not in this
  bullet, so this bullet cannot fall out of date with it. Not in scope even there: heading style,
  line length, Markdown layout, or wording it would have chosen differently.
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
  CI session's structured output in this file and [docs/ci.md](docs/ci.md),
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
    contribute.ts        # saves suggested agents for the filing workflow
    calibration.ts       # does the fidelity verifier discriminate? (docs/verifier-calibration.md)
  tools/calibrate.ts     # CLI for that measurement; nothing in a run imports it
  util/queue.ts          # bounded FIFO run queue (cross-session concurrency cap)
  auth/                  # the optional API gate
  store/                 # node:sqlite metadata store + on-disk session layout
  routes/                # /v1 endpoints
  version.ts             # the running build's version, reported by GET /v1/health
  index.ts               # server entry point
public/demo.html         # the browser app served at /, driving the same /v1 API
public/how-it-works.html # the technical walkthrough served at /how-it-works
data/                    # sessions/, tmp/, and the SQLite DB (created at runtime)
```
