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
// reporters aimed at stdout interleave in event order, which puts this immediately below
// the `✖` line it explains.
export default async function* specWithSignals(source) {
  const deaths = [];
  for await (const event of source) {
    if (event.type !== "test:fail") continue;
    const error = event.data?.details?.error;
    // Both absent on an assertion failure. On a dead child, one of: a signal with
    // `exitCode: null`, or a non-zero code with `signal: null`. `exitCode: 0` cannot reach
    // here, but treat it as "not a death" rather than resting on that.
    const signal = error?.signal ?? null;
    const exitCode = error?.exitCode ?? null;
    if (signal === null && (exitCode === null || exitCode === 0)) continue;
    const how = signal !== null ? `was killed by ${signal}` : `exited ${exitCode}`;
    deaths.push(`${event.data.name}: the process ${how} without reporting a failure`);
    yield (
      `\n‼ ${event.data.name}: the process ${how} without reporting a failure.\n` +
      `  A dead child, NOT a failing assertion — every test after the last one printed\n` +
      `  above never ran, so a green count below is short, not clean. A SIGSEGV here is a\n` +
      `  crash inside node itself (#405); look for a fresh node-*.ips under\n` +
      `  ~/Library/Logs/DiagnosticReports (macOS) before suspecting the test file.\n\n`
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
