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
    writeFileSync(
      join(dir, "segv.test.ts"),
      'import { test } from "node:test";\n' +
        'test("segv first runs", () => {});\n' +
        'setTimeout(() => process.kill(process.pid, "SIGSEGV"), 50);\n' +
        'test("segv never reports", async () => { await new Promise((r) => setTimeout(r, 2000)); });\n',
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
  assert.match(OUT, /segv\.test\.ts: the process was killed by SIGSEGV without reporting a failure/);
  // And it says the count below is short, because the tests after the death never ran.
  assert.match(OUT, /never ran, so a green count below is short, not clean/);
  assert.match(OUT, /✔ segv first runs/);
  assert.ok(!OUT.includes("segv never reports"), "the test after the death should not have run");
});

test("a child that exits non-zero without reporting says the code, not a signal", () => {
  assert.match(OUT, /exits\.test\.ts: the process exited 3 without reporting a failure/);
  assert.ok(
    !/exits\.test\.ts: the process was killed/.test(OUT),
    "an exit code was reported as a signal",
  );
});

test("an ordinary assertion failure is left to the spec reporter", () => {
  assert.match(OUT, /✖ an ordinary assertion failure/);
  // Named by what the reporter PRINTS, not by what it omits. `event.data.name` on an
  // assertion failure is the TEST's name, not its file, so asserting that
  // `asserts.test.ts` never appears is a claim nothing could ever falsify — it passed with
  // the guard mutated to fire on every failure. Count the shouts instead: two event-time
  // lines and one summary header, and no shout naming a test.
  const shouted = OUT.split("\n").filter((line) => line.startsWith("‼"));
  assert.equal(shouted.length, 3, `expected two deaths and one summary header, got:\n${shouted.join("\n")}`);
  assert.ok(
    !shouted.some((line) => line.includes("an ordinary assertion failure")),
    "the reporter fired on a failing assertion, which is not a dead child",
  );
});

test("the deaths are repeated at the very end, where CI's tail can see them", () => {
  // Both workflows read `npm test` through `tail` (code-review.yml -120,
  // issue-to-pr.yml -40), so a file that dies early in a 1,500-test run is above the cut.
  const summary = OUT.slice(OUT.indexOf("‼ dead child processes in this run"));
  assert.ok(summary.length > 0, "no end-of-run summary");
  assert.match(summary, /segv\.test\.ts/);
  assert.match(summary, /exits\.test\.ts/);
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
