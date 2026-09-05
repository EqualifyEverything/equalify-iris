import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const REPORTER = join(import.meta.dirname, "spec-with-signals.mjs");

// `node --test` refuses to run files when NODE_TEST_CONTEXT is PRESENT in the environment
// ("run() is being called recursively within a test file. skipping running files."), which
// this spawn inherits from the suite running it. Setting it to "" is not enough — the check
// is presence, not truthiness — so the key has to go.
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// One spawn covering every branch, against the real runner rather than hand-built events.
// The shape this reporter reads (`details.error.signal`, `details.error.exitCode`) is
// node's, not ours, so a fixture of it would keep passing after node changed it — which is
// the one way this reporter can go quietly blind.
function runProbe(): { stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "iris-reporter-"));
  try {
    // Killed by a signal, part-way through: the #405 shape. `first runs` reports, the
    // timer fires, `never reports` never does.
    //
    // SIGKILL, not SIGSEGV. macOS reports a FATAL signal through ReportCrash whether or not
    // it came from `kill(2)`, so a self-sent SIGSEGV writes a real `node-*.ips` into
    // ~/Library/Logs/DiagnosticReports on every run — the exact directory this reporter
    // tells the reader to go and trust. The first draft of this file put seven of them there
    // in under an hour. SIGKILL exercises the same branch and is not reported.
    writeFileSync(
      join(dir, "killed.test.ts"),
      'import { test } from "node:test";\n' +
        'test("killed first runs", () => {});\n' +
        'setTimeout(() => process.kill(process.pid, "SIGKILL"), 50);\n' +
        'test("killed never reports", async () => { await new Promise((r) => setTimeout(r, 2000)); });\n',
    );
    // A file that fails an assertion AND THEN dies. Node reports the file's own failure as
    // `subtestsFailed` here and emits no `test:fail` for it at all, so spec prints the
    // assertion and nothing else — the death is invisible unless the reporter reads
    // `test:complete`. An ordinary shape during a bisect, and the one this reporter exists
    // for.
    writeFileSync(
      join(dir, "both.test.ts"),
      'import { test } from "node:test";\n' +
        'import assert from "node:assert/strict";\n' +
        'test("a failing assertion before the death", () => { assert.equal(1, 2); });\n' +
        'setTimeout(() => process.kill(process.pid, "SIGKILL"), 100);\n' +
        'test("both never reports", async () => { await new Promise((r) => setTimeout(r, 2000)); });\n',
    );
    // Non-zero exit with no signal: the other way a child dies without reporting.
    writeFileSync(
      join(dir, "exits.test.ts"),
      'import { test } from "node:test";\n' +
        'test("exits first runs", () => {});\n' +
        "setTimeout(() => process.exit(3), 50);\n" +
        'test("exits never reports", async () => { await new Promise((r) => setTimeout(r, 2000)); });\n',
    );
    // An ordinary failure. Carries neither field, and must stay quiet — a reporter that
    // shouts on every red build is one nobody reads on the build that matters.
    writeFileSync(
      join(dir, "asserts.test.ts"),
      'import { test } from "node:test";\n' +
        'import assert from "node:assert/strict";\n' +
        'test("an ordinary assertion failure", () => { assert.equal(1, 2); });\n',
    );
    // Fails a test AND exits non-zero with a code the runner would never choose. This is
    // what forces the discriminator to be `subtestsFailed` + exitCode 1 specifically,
    // rather than "any file that failed a test exits 1, so ignore non-zero codes there".
    writeFileSync(
      join(dir, "failsthenexits.test.ts"),
      'import { test } from "node:test";\n' +
        'import assert from "node:assert/strict";\n' +
        'test("a failing assertion before the exit", () => { assert.equal(1, 2); });\n' +
        "setTimeout(() => process.exit(4), 100);\n" +
        'test("failsthenexits never reports", async () => { await new Promise((r) => setTimeout(r, 2000)); });\n',
    );
    writeFileSync(
      join(dir, "passes.test.ts"),
      'import { test } from "node:test";\ntest("a test that passes", () => {});\n',
    );
    const r = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-reporter=spec",
        "--test-reporter-destination=stdout",
        `--test-reporter=${pathToFileURL(REPORTER).href}`,
        "--test-reporter-destination=stdout",
        join(dir, "*.test.ts"),
      ],
      { encoding: "utf8", timeout: 60_000, env: childEnv() },
    );
    // Kept apart: the reporters write to stdout, and folding stderr in would let a
    // node warning satisfy an assertion about reporter output — which it did once.
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PROBE = runProbe();
const OUT = PROBE.stdout;

test("a child killed by a signal says so, where spec says only 'test failed'", () => {
  // Spec's own account of the same file, which is all #405 had to go on.
  assert.match(OUT, /'test failed'/);
  assert.match(
    OUT,
    /killed\.test\.ts: the process was killed by SIGKILL without reporting a failure/,
  );
  // And it says the count is short, because the tests after the death never ran.
  assert.match(OUT, /never ran, so the count below is short, not clean/);
  assert.match(OUT, /✔ killed first runs/);
  assert.ok(!OUT.includes("killed never reports"), "the test after the death should not have run");
  // Only a signal sends the reader to the crash logs.
  assert.match(OUT, /A fatal signal here is a crash inside node itself \(#405\)/);
});

test("a file that fails an assertion and THEN dies still reports the death", () => {
  // The gap that `test:fail` left: node reports this file as `subtestsFailed`, with the
  // signal on the event and no `test:fail` for the file, so spec prints only the assertion.
  assert.match(OUT, /✖ a failing assertion before the death/);
  assert.match(
    OUT,
    /both\.test\.ts: the process was killed by SIGKILL without reporting a failure/,
  );
  assert.ok(!OUT.includes("both never reports"), "the test after the death should not have run");
});

test("a child that exits non-zero without reporting says the code, and not to read crash logs", () => {
  assert.match(OUT, /exits\.test\.ts: the process exited 3 without reporting a failure/);
  assert.ok(
    !/exits\.test\.ts: the process was killed/.test(OUT),
    "an exit code was reported as a signal",
  );
  // The advice differs by branch: a non-zero exit is nearly always a syntax error or a bad
  // import, and sending its author to ~/Library/Logs/DiagnosticReports — in CI, where
  // `tail` has already cut the SyntaxError off the top — is the inverse of #405's problem.
  const paragraph = OUT.slice(OUT.indexOf("exits.test.ts: the process exited 3"));
  const untilBlank = paragraph.slice(0, paragraph.indexOf("\n\n"));
  assert.match(untilBlank, /usually a syntax error or a failed import/);
  assert.ok(
    !untilBlank.includes("node-*.ips"),
    "a non-zero exit was sent to the crash logs, where a syntax error is not",
  );
});

test("a file whose tests merely failed is left to the spec reporter", () => {
  assert.match(OUT, /✖ an ordinary assertion failure/);
  const shouted = OUT.split("\n").filter((line) => line.startsWith("‼"));
  // Four deaths (killed, exits 3, assertion-then-killed, assertion-then-exit 4) and one
  // summary header. Counting is the point: a file whose tests simply failed exits 1 and its
  // `test:complete` carries that code, so reading `test:complete` instead of `test:fail`
  // made every red build shout until the discriminator was narrowed to the runner's own
  // `subtestsFailed` + 1.
  assert.equal(
    shouted.length,
    5,
    `expected four deaths and one summary header, got:\n${shouted.join("\n")}`,
  );
  assert.ok(
    !shouted.some((line) => line.includes("asserts.test.ts")),
    "the reporter fired on a file whose tests merely failed",
  );
  // `event.data.name` on a subtest failure is the TEST's name, not its file, so this is a
  // second, independent way for a stray shout to show up.
  assert.ok(
    !shouted.some((line) => line.includes("an ordinary assertion failure")),
    "the reporter fired on an individual failing test",
  );
});

test("a file that fails a test and then exits with its own code is a death", () => {
  // Not covered by "the runner exits 1 when tests fail": the code is 4, so the exit did not
  // come from the runner, even though the file also has a real failure to report.
  assert.match(OUT, /✖ a failing assertion before the exit/);
  assert.match(
    OUT,
    /failsthenexits\.test\.ts: the process exited 4 without reporting a failure/,
  );
  assert.ok(
    !OUT.includes("failsthenexits never reports"),
    "the test after the exit should not have run",
  );
});

test("the deaths are repeated at the very end, where CI's tail can see them", () => {
  // Both workflows read `npm test` through `tail` (code-review.yml -120,
  // issue-to-pr.yml -40), so a file that dies early in a 1,500-test run is above the cut.
  // On the index, not on the slice: with the summary absent, `indexOf` is -1 and
  // `slice(-1)` is the LAST CHARACTER of the output, whose length is 1, so a `length > 0`
  // check here holds no matter what and its message never prints.
  const at = OUT.indexOf("‼ dead child processes in this run");
  assert.notEqual(at, -1, "no end-of-run summary");
  const summary = OUT.slice(at);
  assert.match(summary, /killed\.test\.ts/);
  assert.match(summary, /exits\.test\.ts/);
  assert.match(summary, /both\.test\.ts/);
  assert.match(summary, /failsthenexits\.test\.ts/);
  assert.ok(!summary.includes("asserts.test.ts"), "the summary listed an assertion failure");
  // Last, so no tail depth can cut it. Which of the two deaths is last depends on which
  // child died first, so assert on the placement, not on the file.
  assert.match(OUT.trimEnd().split("\n").at(-1) ?? "", /the process (was killed by|exited)/);
});

test("the reporter spec runs the suite with is the one this file tests", () => {
  // The reporter is only reached through package.json. Without this, dropping the two
  // flags would leave every test above passing while `npm test` went back to printing
  // `'test failed'` and nothing else.
  const pkg = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.match(pkg.scripts.test, /--test-reporter=\.\/test\/spec-with-signals\.mjs/);
  assert.match(pkg.scripts.test, /--test-reporter=spec/);
  // Two reporters need two destinations; node pairs them positionally, and one missing
  // destination silently sends both to the same place in the wrong order.
  assert.equal(pkg.scripts.test.match(/--test-reporter-destination=/g)?.length, 2);
});
