import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

// The jq half of `.github/workflows/quality-report.yml` (PRD §7.16), which turns the
// `/v1/quality` tally into the body of a public issue. It lives in
// `.github/scripts/quality-body.jq`.
//
// Worth testing rather than reading, because of WHEN it runs: only on a week a
// threshold is crossed, in a job nobody is watching. A syntax error in the body
// program does not fail a PR, does not fail the weekly run on a healthy week, and
// surfaces as a missing issue on the week the deployment finally had something to say —
// which is the week the workflow exists for. This file compiles the program on every
// test run instead.
//
// The specific error class that prompted it: a jq object VALUE does not accept an
// unparenthesised `+`, so `{a: "x" + "y"}` is a syntax error where `{a: ("x" + "y")}`
// is fine. Adding a sentence to one of the six finding bodies is exactly the edit that
// hits it.
//
// The program was inline in the workflow when this file was written, and lifting it out
// (the `run:` block was at 87% of GitHub's 21,000-character ceiling) is what the two
// wiring tests at the bottom are for: the program and its caller can now be edited
// separately, so nothing but a test says they still refer to each other.

const WORKFLOW = join(import.meta.dirname, "..", ".github", "workflows", "quality-report.yml");
const PROGRAM = join(import.meta.dirname, "..", ".github", "scripts", "quality-body.jq");

function hasJq(): boolean {
  try {
    execFileSync("jq", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const skip = hasJq() ? false : "jq not installed";

// The program needs no extraction any more, and that is the whole benefit of the move:
// `renderBody` below hands jq the same path with the same `-f` the workflow uses. It used
// to be lifted out of the `run:` block by its delimiters, with every `'"'"'` — how a
// literal apostrophe survives single-quoted shell — folded back to one `'`, because
// otherwise the program under test was not the program that ran.

// A tally shaped like the one that produced #263: 6 of 70 documents could not be
// linted, and 4 of those name the step they failed at.
const TALLY = {
  window_days: 30,
  documents: 70,
  documents_linted: 64,
  since: "2026-08-13T16:45:08.867Z",
  mean_rounds: 0.8857142857142857,
  unresolved_rate: 0.8428571428571429,
  links_dropped_rate: 0.014285714285714285,
  links_unresolved_rate: 0.04285714285714286,
  markup_unbalanced_rate: 0,
  table_no_body_rate: 0,
  structural_defect_rate: 0,
  lint_error_rate: 0.08571428571428572,
  lint_error_where: [
    { where: "parse", documents: 0 },
    { where: "inject", documents: 0 },
    { where: "run", documents: 4 },
  ],
  editor_truncated_rate: 0.3142857142857143,
  editor_truncated_lost_rate: 0,
  review_unread_rate: 0,
  // The three #264 added, in a shape consistent with the rest of this tally: 59 of the 70
  // documents shipped with something open, and the loop reached the cap on none of them.
  // The exits sum to the 70 documents; the severities are per document and sum past 59,
  // because one document can carry issues of three severities at once.
  review_stopped: [
    { where: "clean", documents: 11 },
    { where: "unread", documents: 0 },
    { where: "converged", documents: 55 },
    { where: "truncated", documents: 4 },
    { where: "cap", documents: 0 },
  ],
  unresolved_severity: [
    { severity: "high", documents: 6 },
    { severity: "medium", documents: 40 },
    { severity: "low", documents: 20 },
    { severity: "unrated", documents: 0 },
  ],
  unfinished_page_rate: 0.2,
  rules: [{ id: "list", impact: "serious", documents: 4, share: 0.0625, nodes: 5 }],
};

// Every finding the threshold step can emit, in the shape it emits them. `rule-*` is
// the one whose key is computed, and the body program branches on `.rule` rather than
// on the key for exactly that reason.
const FINDINGS: Record<string, Record<string, unknown>> = {
  "lint-error": { metric: "lint_error_rate", value: TALLY.lint_error_rate, threshold: 0 },
  "links-dropped": { metric: "links_dropped_rate", value: 0.014, threshold: 0.01 },
  "truncated-lost": { metric: "editor_truncated_lost_rate", value: 0.05, threshold: 0.02 },
  unresolved: { metric: "unresolved_rate", value: TALLY.unresolved_rate, threshold: 0.15 },
  "mean-rounds": { metric: "mean_rounds", value: 2.4, threshold: 2 },
  "rule-list": {
    metric: 'rules["list"].share',
    value: 0.0625,
    threshold: 0.05,
    rule: "list",
    impact: "serious",
    rule_documents: 4,
    nodes: 5,
  },
};

function renderBody(key: string, tally: unknown = TALLY): string {
  const dir = mkdtempSync(join(tmpdir(), "iris-qreport-"));
  try {
    const tallyPath = join(dir, "quality.json");
    writeFileSync(tallyPath, JSON.stringify(tally));
    return execFileSync(
      "jq",
      [
        "-r",
        "--arg",
        "url",
        "https://iris.example.edu",
        "--argjson",
        "cooldown",
        "30",
        "--slurpfile",
        "tallyfile",
        tallyPath,
        "-f",
        PROGRAM,
      ],
      { input: JSON.stringify({ key, ...FINDINGS[key] }), encoding: "utf8" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("every finding the thresholds can emit renders a body", { skip }, () => {
  // Both halves at once: the program compiles (jq exits non-zero on a syntax error,
  // which `execFileSync` throws on), and each branch produces prose rather than the
  // lookup table's fallback. A key that reaches the fallback files an issue whose whole
  // explanation is "No description available", which is worse than not filing one.
  for (const key of Object.keys(FINDINGS)) {
    const body = renderBody(key);
    assert.ok(
      !body.includes("No description available"),
      `${key} has no branch in the body program`,
    );
    assert.match(body, /\*\*Measured:\*\* /, `${key} states what it measured`);
    assert.match(body, /### How this was filed/, `${key} says a workflow wrote it`);
    // The tally is attached in full to every finding, so the reader can check the
    // number in the prose against the response it came from.
    assert.ok(body.includes('"window_days"'), `${key} attaches the tally`);
  }
});

// The job's steps as GitHub parses them. Read as a sequence rather than grepped, because
// both wiring tests below are about WHICH step does something: a `run:` block that
// supplies a variable, or fetches a file, helps only the steps after it and only if it is
// the step doing the work.
interface Step {
  name?: string;
  if?: string;
  uses?: string;
  with?: Record<string, string>;
  run?: string;
}
function reportSteps(): Step[] {
  const doc = parse(readFileSync(WORKFLOW, "utf8")) as { jobs: { report: { steps: Step[] } } };
  return doc.jobs.report.steps;
}

test("the workflow runs the program this file renders, with every variable it declares", () => {
  // What the inline version could not get wrong. The program names three variables it
  // does not define — `$tallyfile`, `$url`, `$cooldown` — and jq resolves those at
  // COMPILE time, so one added to the program and not to the invocation is not a wrong
  // issue body, it is no issue at all on the week a threshold is crossed. Derived from
  // the program rather than listed, so the next variable is covered before it is added.
  const program = readFileSync(PROGRAM, "utf8");
  const bound = new Set([...program.matchAll(/\bas \$([A-Za-z_]\w*)/g)].map((m) => m[1]));
  const free = [...new Set([...program.matchAll(/\$([A-Za-z_]\w*)/g)].map((m) => m[1]))]
    .filter((v) => !bound.has(v))
    .sort();
  assert.deepEqual(free, ["cooldown", "tallyfile", "url"], "the program's inputs changed");

  // Per CALL SITE, not per file. There are two of them, they are checked separately, and
  // the whole point is the asymmetry between them: the probe supplying `$foo` says nothing
  // about the filing step, and a variable added to the program and to the probe alone
  // would pass a whole-file search while still refusing to compile on the week a threshold
  // is crossed — which is the exact failure this test is named for.
  const steps = reportSteps();
  const callers = [
    { what: "the filing step", run: steps.find((s) => (s.run ?? "").includes("quality-body.jq <<<"))?.run },
    { what: "the compile probe", run: steps.find((s) => (s.run ?? "").includes("quality-body.jq </dev/null"))?.run },
  ];
  for (const { what, run } of callers) {
    assert.ok(run, `${what} no longer runs the program`);
    // Any of the three forms is a definition; which one is the caller's business.
    for (const v of free) {
      assert.match(
        run,
        new RegExp(`--(arg|argjson|slurpfile) ${v} `),
        `${what} never supplies \`$${v}\`, so jq will refuse the program`,
      );
    }
  }
  assert.match(
    callers[0].run ?? "",
    /-f \.github\/scripts\/quality-body\.jq <<<"\$finding"/,
    "the filing step still runs this program on the finding, on stdin",
  );
});

test("the program is on disk before the step that needs it", () => {
  // The other thing the move introduced: a `run:` block is always there, and a checked-out
  // file is there only if something checked it out. Order matters and YAML does not
  // enforce it, so this reads the steps in sequence — a checkout added after the filing
  // step would look right in a diff and fail on a filing week.
  const steps = reportSteps();
  const checkout = steps.findIndex((s) => (s.uses ?? "").startsWith("actions/checkout@"));
  assert.ok(checkout >= 0, "the job no longer checks out the program it runs with -f");
  assert.match(
    steps[checkout].with?.["sparse-checkout"] ?? "",
    /\.github\/scripts/,
    "the sparse checkout no longer includes the directory the program is in",
  );
  const uses = steps.findIndex((s) => (s.run ?? "").includes("quality-body.jq <<<"));
  assert.ok(uses > checkout, "the program is used before it is fetched");

  // And the compile probe, which is the reason a broken checkout is a loud failure on a
  // quiet week rather than a silent one on the week the report matters. It carries no
  // `if:`, deliberately: every other step in this job is conditional.
  const probe = steps.findIndex((s) => (s.run ?? "").includes("-f .github/scripts/quality-body.jq </dev/null"));
  assert.ok(probe > checkout && probe < uses, "nothing proves the program arrived");
  assert.equal(steps[probe].if, undefined, "the probe runs on every run or it is not a probe");
});

test("the keys the thresholds emit are the keys the body program answers", { skip }, () => {
  // The two jq programs live in different steps and share a vocabulary by convention
  // only. A finding key renamed in one and not the other is a clean run that files an
  // issue with no explanation in it.
  const yaml = readFileSync(WORKFLOW, "utf8");
  const emitted = new Set(
    [...yaml.matchAll(/^\s+\[ \{ key: "([a-z-]+)",/gm)].map((m) => m[1]),
  );
  assert.ok(emitted.size > 0, "the threshold step still emits findings with literal keys");
  for (const key of emitted) {
    assert.ok(key in FINDINGS, `${key} is emitted by the workflow but not exercised here`);
  }
});

test("the lint-error body names which step failed, from the tally", { skip }, () => {
  const body = renderBody("lint-error");
  assert.match(body, /\*\*Which step failed:\*\* `parse` 0, `inject` 0, `run` 4/);
  // The reason the sentence exists: `run` is the one step with a known cause, and
  // saying so is what makes a NEW cause recognisable as new.
  assert.match(body, /#257/);
  // 0.0857… × 70 documents, rounded — the number the three counts are read against,
  // printed rather than left to the reader to multiply out.
  assert.match(body, /A sum below the 6 document\(s\) in the rate/);
});

test("a deployment that records no step gets no breakdown sentence, not three zeroes", { skip }, () => {
  // The upgrade window, which is every deployment's state the week this ships: the
  // rate is non-zero and the field is absent because nothing was writing a step down
  // when those documents ran. "0 parse, 0 inject, 0 run" beside a 8.6% failure rate
  // reads as a contradiction, so the sentence is skipped instead.
  const { lint_error_where: _omitted, ...older } = TALLY;
  const body = renderBody("lint-error", older);
  assert.ok(!body.includes("Which step failed"), "no breakdown is claimed");
  // And the rest of the body is unaffected — the omission costs a sentence, not the
  // finding.
  assert.match(body, /had a lint pass that errored instead of running/);
  assert.match(body, /Start with `src\/pipeline\/lint\.ts`/);
});

test("the unresolved body names the exit each document left by, and what each one asks for", { skip }, () => {
  // The sentence that replaced a guess. This body used to say it was "worth checking
  // whether `defaults.max_review_iterations` (3) is simply too low" — advice that the
  // numbers printed two lines above it already refuted, since 0.886 mean rounds against a
  // cap of 3 is a budget going unspent. Now the report says which exit, so the reader does
  // not have to guess and cannot be pointed at the wrong file.
  const body = renderBody("unresolved");
  assert.match(body, /\*\*Why the loop stopped:\*\* `clean` 11, `unread` 0, `converged` 55, `truncated` 4, `cap` 0/);
  assert.match(
    body,
    /these describe 70 of the 70 documents above, which is all of them/,
    "the count they are read against is printed, not left to be worked out",
  );
  // The two exits that look identical from outside the loop, told apart with their
  // opposite remedies attached — which is the whole point of recording the exit.
  assert.match(body, /`cap` is the only one raising `defaults\.max_review_iterations` can help/);
  assert.match(body, /`converged` is the editor having been shown the issues/);
  assert.match(body, /`agents\/copy_editor\.md`/);
  // And the round budget is never mentioned except as the remedy for `cap`. A reader who
  // skims this finding must not come away with the old advice.
  assert.ok(
    !/too low/.test(body),
    "the body should no longer suggest the round budget is too low without measuring it",
  );
  assert.equal(
    (body.match(/max_review_iterations/g) ?? []).length,
    1,
    "the round budget is named once, beside the one exit it answers",
  );
});

test("a breakdown that covers part of the window says so, and refuses to be scaled up", { skip }, () => {
  // The live deployment's first report of this field: 7 of 77 documents had an exit recorded,
  // because the field is written when a run happens and a 30-day window holds runs from before
  // it existed. The rate is over all 77 and the split is over 7, so the two are different
  // denominators — and a reader who multiplied the split up to the rate would be inventing 70
  // documents' exits. The counts alone cannot say that; the sentence has to.
  const body = renderBody("unresolved", {
    ...TALLY,
    review_stopped: [
      { where: "clean", documents: 2 },
      { where: "unread", documents: 0 },
      { where: "converged", documents: 0 },
      { where: "truncated", documents: 2 },
      { where: "cap", documents: 3 },
    ],
  });
  assert.match(body, /these describe 7 of the 70 documents above and NOT the window/);
  assert.match(body, /the other 63 were delivered before this breakdown was recorded/);
  assert.match(body, /do not scale up to the rate/);
  // And it says which numbers it governs, because the paragraphs after the split are NOT over
  // the attributed documents: `unfinished_page_rate` below is `count / documents` over the whole
  // window, and its own instruction is to subtract it from `unresolved_rate`. A reader who took
  // "the shares below" literally and rescaled the floor by 77/7 first would get it an order of
  // magnitude wrong — the exact mistake this paragraph exists to prevent.
  assert.match(body, /both over all 70 documents/);
  assert.match(body, /do not rescale it first/);
  // And the gap is still not an exit. The old body said this about a shortfall and it is the
  // one wrong way to read one.
  assert.match(body, /not a sixth kind of exit/);
  // And the reading that made the live report's `cap` count mean something other than what it
  // looks like: three documents exited at the cap while `mean_rounds` was exactly 1.0, which is
  // only possible if that deployment's cap is 1 — so `cap` there was one round spent, not three.
  // The tally cannot carry the config, so the body says to derive it.
  assert.match(body, /check what the cap on this deployment actually IS before assuming the default of 3/);
});

test("the unresolved body splits the rate by what the open list is about", { skip }, () => {
  // The finding #264 was filed for: `unresolved_rate` counts a document that was re-read and
  // still had problems, and a document whose list may predate the bytes that shipped, as one
  // number. The loop re-reads at the top of every round, so `cap` and `converged` are the first
  // kind and `truncated` is the second — 55 and 4 in this tally. Printed as counts rather than
  // left to the reader to add, because the whole complaint was that the report made them guess.
  const body = renderBody("unresolved");
  assert.match(body, /\*\*What the open list is a statement about:\*\*/);
  assert.match(body, /55 document\(s\) here are that/, "cap + converged, the part that is about the document");
  assert.match(body, /those 4 over-report on purpose/, "truncated, the part that is about the round");
  assert.match(body, /`src\/pipeline\/review\.ts`/, "and where the reason for that is written down");
  // The reason the threshold has not been split as well: the two halves want different numbers
  // and there is not yet a fully attributed window to set either from.
  assert.match(body, /One threshold over both cannot be set honestly/);
});

test("the unresolved body rates what was left, and says it is not a partition", { skip }, () => {
  // Severity is what decides whether an 84% rate describes a defect at all: the rate counts
  // any open issue, and a Reader reporting nits would produce the same number as one
  // reporting barriers. Printed as documents, with the arithmetic warning attached, because
  // 6 + 40 + 20 exceeds the 59 documents in the rate and a reader checking the sum would
  // otherwise conclude the report is broken.
  const body = renderBody("unresolved");
  assert.match(body, /\*\*How the Reader rated what was left:\*\* `high` 6, `medium` 40, `low` 20, `unrated` 0 document\(s\)/);
  assert.match(body, /NOT a partition of the rate above/);
  assert.match(body, /`high` is the part a reader would call a barrier/);
  assert.match(body, /`unrated` is the Reader having written something outside the three/);
  // The floor, which is the one number that says how much of the rate is not ours to fix.
  assert.match(body, /\*\*The floor:\*\* 20% of documents shipped with a `\[page not fully transcribed\]` marker/);
  assert.match(body, /cannot finish clean at ANY budget/);
});

test("a floor measured at zero is printed, and only an unrecorded one is skipped", { skip }, () => {
  // The case `> 0` would have thrown away, and the most useful one in the report: a
  // measured 0% says none of the unresolved rate is inherent, so all of it is ours. In jq
  // only `false` and `null` are falsy, so testing the number itself keeps that sentence.
  const zero = renderBody("unresolved", { ...TALLY, unfinished_page_rate: 0 });
  assert.match(zero, /\*\*The floor:\*\* 0% of documents/);

  const { unfinished_page_rate: _omitted, ...older } = TALLY;
  const absent = renderBody("unresolved", older);
  assert.ok(!absent.includes("**The floor:**"), "a deployment that never measured it claims nothing");
});

test("a tally from before #264 renders the unresolved finding without the three breakdowns", { skip }, () => {
  // Every deployment's state on the week this ships, for the same reason the lint-error
  // case above has one: the rate is computed from signals written when the run happened, so
  // no run before this deploys can be broken down after the fact. Five zeroes beside an 84%
  // rate would read as a contradiction, and "cap 0" specifically would be a false statement
  // about where those documents stopped.
  const { review_stopped: _a, unresolved_severity: _b, unfinished_page_rate: _c, ...older } = TALLY;
  const body = renderBody("unresolved", older);
  for (const claim of ["**Why the loop stopped:**", "**How the Reader rated what was left:**", "**The floor:**"]) {
    assert.ok(!body.includes(claim), `${claim} is claimed on a tally that cannot support it`);
  }
  // And the finding is still a finding: the rate, the threshold, and the one sentence that
  // says why the descriptions are not in here.
  assert.match(body, /84\.3% of 70 documents/);
  assert.match(body, /Only the \*\*count\*\* is available here/);
});

test("a step that failed on nothing is still printed, once the field is there", { skip }, () => {
  // The distinction the sentence turns on, and the reason the store always emits all
  // three entries: with the field present, `inject` 0 is the measurement "axe's own
  // source has never failed to evaluate here", which is a useful thing to have said.
  const body = renderBody("lint-error", {
    ...TALLY,
    lint_error_where: [
      { where: "parse", documents: 6 },
      { where: "inject", documents: 0 },
      { where: "run", documents: 0 },
    ],
  });
  assert.match(body, /`parse` 6, `inject` 0, `run` 0/);
});
