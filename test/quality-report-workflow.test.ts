import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The jq half of `.github/workflows/quality-report.yml` (PRD §7.16), which turns the
// `/v1/quality` tally into the body of a public issue.
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

const WORKFLOW = join(import.meta.dirname, "..", ".github", "workflows", "quality-report.yml");

function hasJq(): boolean {
  try {
    execFileSync("jq", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const skip = hasJq() ? false : "jq not installed";

// The body program, lifted out of the `run:` block by its own delimiters rather than by
// line number, so moving the step does not silently extract nothing. `'"'"'` is how a
// literal apostrophe survives single-quoted shell, and jq never sees that form — the
// shell hands it over as one `'`, so the extraction has to as well or the program under
// test is not the program that runs.
function bodyProgram(): string {
  const lines = readFileSync(WORKFLOW, "utf8").split("\n");
  const start = lines.findIndex((l) => l.includes("--slurpfile tallyfile /tmp/quality.json '"));
  assert.ok(start >= 0, "the body step still assembles the issue with --slurpfile");
  const end = lines.findIndex((l, i) => i > start && l.trim().startsWith("' <<<\"$finding\""));
  assert.ok(end > start, "and still closes the program by feeding it the finding on stdin");
  return lines
    .slice(start + 1, end)
    .join("\n")
    .replaceAll(`'"'"'`, "'");
}

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
    const prog = join(dir, "body.jq");
    const tallyPath = join(dir, "quality.json");
    writeFileSync(prog, bodyProgram());
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
        prog,
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
