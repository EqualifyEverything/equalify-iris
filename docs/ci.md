# The repo's own automation

Five GitHub Actions workflows run this repository: they review pull requests, close duplicate
issues, triage and rank open ones, tell the deployment when `main` moves, and file a weekly
quality report. Each section below says what one does, what it costs, and what it deliberately
does not do.

This is for maintainers and for anyone whose PR just got reviewed by a bot. Nothing here is
needed to run Iris — see the [README](../README.md) for that, and
[CONTRIBUTING.md](../CONTRIBUTING.md) for how to open a PR in the first place.

## Automated code review

Every PR is reviewed by Claude in CI before a human reads it
([`.github/workflows/code-review.yml`](../.github/workflows/code-review.yml)). This is
not convenience tooling. Iris's agent library only improves through upstream merge, so
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
reviewer and the issue-triage one are what the review promise above actually rests on, and they hold
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

[`.github/workflows/issue-triage.yml`](../.github/workflows/issue-triage.yml) runs **when an issue is
opened or reopened**. It reads the new issue, finds the open issue it most resembles, and — only
when a second, independent session fails to refute the claim — closes the new one as a duplicate
with a comment naming the survivor. Anything short of that is commented and reported, never closed.

It exists because the dedupe already in the app cannot do this, and was never trying to.
`src/github/issue.ts` refuses to file an `Agent update proposal:` whose title exactly matches an
open one, which is the right check to have there: cheap, deterministic, no model. What it cannot see
is that "procedure steps must be marked up at heading" and "when steps are nested inside a named
section" are one rule described twice. Iris files these speculatively from content it met once,
so semantic overlap between them is the normal case rather than the exception, and it
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

That step's body is [`.github/scripts/triage-decide.sh`](../.github/scripts/triage-decide.sh) rather
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

[`.github/workflows/issue-to-pr.yml`](../.github/workflows/issue-to-pr.yml) runs **Sun–Wed at 22:00
UTC**. It reads the open issues, ranks them by what most improves Iris, and opens
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
  `issue-triage.yml`'s enforcement step is `.github/scripts/triage-decide.sh` and the body of every
  issue the weekly quality report files is `.github/scripts/quality-body.jq`. One decides whether an
  issue closes and the other writes public prose about the deployment's own output, which is why the
  boundary follows the privilege rather than the directory's name. CI is the sharp case, and it stays forbidden
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

It needs one secret, `UIC_DEPLOY_DISPATCH_TOKEN` — a fine-grained PAT with
**`Contents: read and write` on the deployment repo only**, which is the least that
`POST /dispatches` accepts. It grants nothing here: the job runs with `permissions: {}`.

Nothing about this is load-bearing. With the secret absent — a fork, or before it is added — the
step prints why and exits 0; if the token is revoked or the API is unreachable it warns instead.
A deployment nobody else runs must never be able to turn this project's `main` red.

## Weekly quality report

[`.github/workflows/quality-report.yml`](../.github/workflows/quality-report.yml) runs **Saturdays at
20:00 UTC**. It reads `GET /v1/quality` on a live deployment, compares a handful of
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

The *prose* of those issues — the paragraph that says what a crossed rate means and which file to
open first — is [`.github/scripts/quality-body.jq`](../.github/scripts/quality-body.jq), a jq program
the job checks out, and it is where to edit an explanation that has gone stale. It is a file for the
same mechanical reason [`triage-decide.sh`](#closing-duplicate-issues) is: 13,000 characters of
prose inside a `run:` block had that step at 87% of the 21,000-character ceiling, in the one part of
this workflow designed to grow. `.github/scripts/**` is on the forbidden-paths list too, so moving
it there did not hand the automation a way to rewrite what the report says about itself.
`test/quality-report-workflow.test.ts` renders it for every finding the thresholds can emit on every
`npm test`, because otherwise a syntax error in it would first be discovered by the Saturday that
had something to report.

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
Agent read in full and left nothing open on — not documents whose final axe pass came back empty —
so it credits the reviewer instead of saying the output was clean, which is what a visitor would
otherwise take away. The percentage is floored rather than rounded, too: 99.6% is excellent, and
publishing it as 100% would be a claim of perfection about work Iris did not do perfectly.

**"Read in full" is load-bearing, and it was not there at first.** The rate is a subtraction —
delivered documents minus the ones carrying a signal — so the *absence* of a signal was the whole
evidence of cleanliness, and a document whose reviewer answered nothing has none for the worst
possible reason: no issues were found because no issues were looked for. A long document is read in
windows, and a reply carrying no issue list this code can read (prose, an apology, `{"issues":
"none"}`) used to be indistinguishable from `{"issues": []}` — delivered as clean, with no
correction rounds, counted clean deployment-wide. It is now recorded as `iris:review-unread`,
subtracted from the clean count alongside the unresolved ones, published as `review_unread_rate` on
the authenticated endpoint, and stated in the delivered document as a `@review-unread` comment —
because an empty `@unresolved` list only means "nothing is wrong" if all of the document was read
(issue #186).

**Below 20 documents in the window the object is `null` and the line simply is not there.** Same
floor as the weekly job, for a stronger reason — on a quiet deployment the aggregate is the
individual, and a rate over four documents shown next to a document count is a statement about
identifiable people's uploads. The floor is enforced in the store rather than in the route, so a
later route change cannot publish a number this refused to. See `docs/API.md` §0b for the fields.
