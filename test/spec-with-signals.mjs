// A second reporter, run alongside `spec`, that prints the two fields spec throws away.
//
// The spec reporter renders a test file whose PROCESS died exactly like a test that failed
// an assertion: one `✖ path/to/file.test.ts` and the bare string `'test failed'`, with no
// assertion, no diff, and nothing on stderr. The fields that tell those apart — `signal`
// and `exitCode` — are on the event, and only the tap reporter prints them, in its YAML
// diagnostic. Switching the whole suite to tap to find that out costs the readable output,
// so it only ever happens after someone has already spent an afternoon on the wrong
// hypothesis. #405 was that afternoon: two silent deaths in the editor-patch tests read as
// a flake in that file's own harness, while the machine had six crash reports across the
// same four days, every one of them a SIGSEGV inside node's own garbage collector.
//
// Registered as a second `--test-reporter` rather than a `spec` subclass because
// `node:test/reporters`' spec carries no `_transform` on its prototype (its class body
// declares no prototype methods at all), so an override of it is never called. Two
// reporters aimed at stdout interleave in event order.
export default async function* specWithSignals(source) {
  const deaths = [];
  for await (const event of source) {
    // `test:complete`, not `test:fail`. When a subtest of the file has ALREADY failed, node
    // reports the file's own failure as `failureType: 'subtestsFailed'` and emits NO
    // `test:fail` for the file at all — spec then prints the assertion and nothing else,
    // and the death is invisible even though `signal` is right there on the event. That is
    // the one shape this reporter exists for arriving in a file that is red for an
    // unrelated reason, which is an ordinary bisect. `test:complete` carries the two fields
    // in BOTH shapes, and a file that finished normally carries no `details.error`, so
    // reading it instead of `test:fail` covers the gap without ever reporting twice.
    if (event.type !== "test:complete") continue;
    const error = event.data?.details?.error;
    const signal = error?.signal ?? null;
    const exitCode = error?.exitCode ?? null;
    // `test:complete` carries these on every failing FILE, not just a dead one, so a
    // non-zero code is not on its own a death. The five shapes, all measured against the
    // real runner:
    //
    //   subtestsFailed  exitCode 1     signal null      a file whose tests failed  — no
    //   testCodeFailure exitCode 1     signal null      a syntax error / bad import — YES
    //   testCodeFailure exitCode 3     signal null      an explicit process.exit(3) — YES
    //   testCodeFailure exitCode null  signal SIGKILL   killed outright            — YES
    //   subtestsFailed  exitCode null  signal SIGKILL   failed a test, then killed — YES
    //
    // So: a signal is always a death, and a non-zero code is a death unless the runner
    // itself produced it, which it does as exactly `subtestsFailed` + 1. The blind spot
    // that leaves is a file that fails a test and THEN dies with code 1 — an unhandled
    // rejection after a failing assertion — which is indistinguishable here from a file
    // that simply failed. That one prints its rejection on stderr unprompted; a signal and
    // every other exit code do not, which is why they are the ones worth a line.
    const runnerReportedItsOwnFailure = error?.failureType === "subtestsFailed" && exitCode === 1;
    if (
      signal === null &&
      (exitCode === null || exitCode === 0 || runnerReportedItsOwnFailure)
    ) {
      continue;
    }
    const how = signal !== null ? `was killed by ${signal}` : `exited ${exitCode}`;
    // The two ways in want opposite advice, and giving both the same tail is how this
    // reporter would start misdirecting people itself: a syntax error or a failed import is
    // the ORDINARY way a test child exits non-zero without reporting, and telling its
    // author to go read crash logs — in CI, where `tail` has already cut the SyntaxError
    // off the top — is the inverse of the problem #405 was about.
    const advice =
      signal !== null
        ? "A fatal signal here is a crash inside node itself (#405); look for a fresh\n" +
          "  node-*.ips under ~/Library/Logs/DiagnosticReports (macOS). One whose top frame is\n" +
          "  __kill is a deliberate kill, not a crash."
        : "A non-zero exit with no test event is usually a syntax error or a failed import in\n" +
          "  this file — look on stderr, above. A fatal SIGNAL instead is the #405 shape.";
    deaths.push(`${event.data.name}: the process ${how} without reporting a failure`);
    yield (
      `\n‼ ${event.data.name}: the process ${how} without reporting a failure.\n` +
      `  A dead child, NOT a failing assertion — the tests after the last one this file\n` +
      `  reported never ran, so the count below is short, not clean. ${advice}\n\n`
    );
  }
  // Again at the end, because both CI workflows read this run through `tail` — `tail -120`
  // in code-review.yml, `tail -40` in issue-to-pr.yml. A file that dies early in a
  // 1,500-test run is thousands of lines above the cut, so the line explaining the `✖`
  // would be the one part of the failure CI never shows.
  if (deaths.length > 0) {
    yield `\n‼ dead child process${deaths.length > 1 ? "es" : ""} in this run (see #405):\n${deaths.map((d) => `  - ${d}\n`).join("")}\n`;
  }
}
