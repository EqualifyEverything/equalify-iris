// `heading-order` is enabled by name in `src/pipeline/lint.ts` even though axe tags
// it `best-practice` and the gate's tag filter is otherwise WCAG-only. Issue #114 is
// why: `agents/page.md` has forbidden skipping a level since #96 ("an <h2> is never
// followed by an <h4>") and a document shipped with exactly that, because no check
// after extraction could see it — the Reader Agent gets no source images, so it cannot
// know which heading the page subordinated to which, and the lint gate was passing the
// blatant case with zero violations.
//
// These tests pin the shapes, not the wiring. Which rule reports which shape is an
// axe internal: `heading-order`'s after() function compares each heading against the
// previous one across the whole page, and a version bump could widen it to shapes this
// pipeline produces on purpose — a body that opens deeper than <h2> is the ordinary
// output of a page whose parent heading fell on a page the extractor was never shown.
// If that happens, every such document starts failing the gate and spending review
// iterations on a non-defect, so the quiet cases are asserted as firmly as the loud one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAxe } from "../src/pipeline/lint.ts";
import { wrapDocument } from "../src/pipeline/assembly.ts";

// The rule ids this document violates, or null when there is no verdict to report: a lint
// that could not run at all returns no `violations` (#164), which is not a clean document
// and not a dirty one either, and the callers in this repo return early on it.
async function rules(body: string): Promise<string[] | null> {
  const lint = await runAxe(wrapDocument(body));
  if (!lint.violations) return null; // axe could not run here; see runAxe
  assert.equal(lint.ok, lint.violations.length === 0, "lint.ok disagrees with its own violation list");
  return lint.violations.map((v) => v.id);
}

test("the reported case — an <h2> followed by an <h4> — no longer passes the lint gate", async () => {
  const found = await rules("<h2>Basic controls</h2><p>Before use.</p><h4>Timer positions</h4><p>Set the dial.</p>");
  if (found === null) return;
  assert.deepEqual(found, ["heading-order"], `expected heading-order alone, got: ${found.join(", ") || "none"}`);
});

// The same skip written with ARIA rather than with a tag. Worth its own case because
// the page prompt asks for heading ELEMENTS, so this is the shape that would arrive
// from a Copy Editor rewrite rather than from extraction — and it is the same barrier.
test("a skipped level declared with aria-level is caught too", async () => {
  const found = await rules('<h2>Controls</h2><div role="heading" aria-level="4">Timer</div><p>x</p>');
  if (found === null) return;
  assert.deepEqual(found, ["heading-order"]);
});

test("the corrected form of the same document is clean", async () => {
  const found = await rules("<h2>Basic controls</h2><p>Before use.</p><h3>Timer positions</h3><p>Set the dial.</p>");
  if (found === null) return;
  assert.deepEqual(found, [], `the fix page.md asks for does not pass the gate: ${found.join(", ")}`);
});

// The three shapes the pipeline produces legitimately. Each of these failing would put
// the gate at odds with `agents/page.md`, which tells the page agent to do them.
test("a body that opens deeper than <h1> is not a skip", async () => {
  // page.md: "a heading at the top of your page may be a subsection of a heading you
  // cannot see: give it the level this page's own evidence supports". A page-2 fragment
  // opening at <h3> is that instruction being followed, and there is no <h1> anywhere
  // in the shell for it to skip from (`wrapDocument` emits a <title>, not a heading).
  for (const body of ["<h2>Controls</h2><p>x</p>", "<h3>Rear panel</h3><p>x</p>"]) {
    const found = await rules(body);
    if (found === null) return;
    assert.deepEqual(found, [], `a document opening at its own level was reported: ${body}`);
  }
});

test("returning to an outer level after a run of subsections is not a skip", async () => {
  // page.md's rule for the same shape: "after an <h2>, <h3>, <h4> run, the next heading
  // that belongs beside the <h3> is an <h3> again". Going back UP is the correction, so
  // a gate that reported it would be asking for the defect.
  const found = await rules("<h2>A</h2><h3>B</h3><h4>C</h4><h3>D</h3><h2>E</h2><p>x</p>");
  if (found === null) return;
  assert.deepEqual(found, []);
});

test("a document with a single heading, or none, is clean", async () => {
  for (const body of ["<h2>Only</h2><p>x</p>", "<p>x</p>"]) {
    const found = await rules(body);
    if (found === null) return;
    assert.deepEqual(found, [], `a document with no heading sequence was reported: ${body}`);
  }
});
