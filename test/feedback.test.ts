import { test } from "node:test";
import assert from "node:assert/strict";
import { contentCoverage, MIN_CONTENT_COVERAGE } from "../src/pipeline/feedback.ts";

// contentCoverage backs the regression gate's content-preservation check: it
// measures how much of a fixture's accepted output a candidate (re-run with an
// updated agent) still reproduces, by screen-reader-flattened text.

test("identical content scores full coverage", () => {
  const html = "<p>one two three four five six seven eight nine ten</p>";
  assert.equal(contentCoverage(html, html), 1);
});

test("a superset candidate still scores full coverage", () => {
  const accepted = "<p>one two three four five six seven eight nine ten</p>";
  const candidate = "<h2>one two three four five six seven eight nine ten eleven twelve</h2>";
  assert.equal(contentCoverage(accepted, candidate), 1);
});

test("structure-only change (heading vs paragraph) is not a content drop", () => {
  const accepted = "<h2>alpha bravo charlie delta echo foxtrot golf hotel</h2>";
  const candidate = "<p>alpha, bravo. charlie! delta? echo: foxtrot; golf hotel</p>";
  const cov = contentCoverage(accepted, candidate);
  assert.ok(cov !== null && cov >= MIN_CONTENT_COVERAGE, `expected >= ${MIN_CONTENT_COVERAGE}, got ${cov}`);
});

test("dropping half the content falls below the threshold", () => {
  const accepted = "<p>one two three four five six seven eight nine ten</p>";
  const candidate = "<p>one two three four five</p>";
  const cov = contentCoverage(accepted, candidate);
  assert.ok(cov !== null && cov < MIN_CONTENT_COVERAGE, `expected < ${MIN_CONTENT_COVERAGE}, got ${cov}`);
});

test("an empty candidate scores zero coverage against substantial accepted text", () => {
  const accepted = "<p>one two three four five six seven eight nine ten</p>";
  assert.equal(contentCoverage(accepted, ""), 0);
});

test("returns null when the accepted text is too short to judge", () => {
  assert.equal(contentCoverage("<p>tiny bit here</p>", "<p>totally different words instead</p>"), null);
});
