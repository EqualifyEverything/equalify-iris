// Issue #145: a delivered document shipped a SERIOUS `aria-prohibited-attr` violation
// from one element — `<p role="doc-pagebreak" aria-label="Page 5" id="page-5"></p>`.
// Naming attributes are prohibited on `doc-pagebreak`, so the page agent's habit of
// labelling its page-break markers was always wrong; what made it invisible is that axe
// only reports it when the element has no text of its own. Six markers in that document
// carried their number as text and passed, the seventh was empty and failed.
//
// `agents/page.md` now prescribes one shape for the marker, and the wording is pinned in
// test/page-prompt.test.ts. This file pins the part the wording ASSERTS about the world:
// that the prescribed shape is clean and the forbidden ones are not. Without it the rule
// rests on one observation in one bench round, and the pipeline's own gate is the thing
// that can confirm it — `runAxe` is the check that decides whether a document ships with
// a violation, and `axe-core` is pinned to an exact version precisely so its verdicts are
// a fact about a commit rather than about a redeploy (see src/pipeline/lint.ts).
//
// It also pins the asymmetry, which is the reason the rule has to be about the shape and
// not about the attribute alone: a labelled marker WITH text is axe-clean, so a prompt
// that only said "never leave the marker empty" would keep producing documents that pass
// today and fail the moment a model returns the same element with nothing in it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAxe } from "../src/pipeline/lint.ts";
import { wrapDocument } from "../src/pipeline/assembly.ts";

// The rule ids the document violates, with their impact. `runAxe` degrades to
// `ok: true, violations: []` with `error` set when axe cannot run at all, which is not a
// clean document — so that case returns null and the test declines to conclude anything,
// the same way test/lint-heading-order.test.ts does.
async function rules(body: string): Promise<string[] | null> {
  const lint = await runAxe(wrapDocument(`<h1 id="doc-title">Operator's manual</h1>\n<p>Before use.</p>\n${body}`));
  if (lint.error) return null;
  assert.equal(lint.ok, lint.violations.length === 0, "lint.ok disagrees with its own violation list");
  return lint.violations.map((v) => `${v.id}[${v.impact}]`);
}

test("the reported marker — labelled and empty — is a serious violation of the shipped gate", async () => {
  const found = await rules('<p role="doc-pagebreak" aria-label="Page 5" id="page-5"></p>');
  if (found === null) return;
  assert.deepEqual(
    found,
    ["aria-prohibited-attr[serious]"],
    `expected the reported violation alone, got: ${found.join(", ") || "none"}`,
  );
});

// aria-labelledby is prohibited on the role for the same reason and is the shape a model
// reaches for when told not to use aria-label — so the prompt names both, and both are
// pinned. Pointed at a real heading, so this fails for being prohibited rather than for
// dangling.
test("naming the marker with aria-labelledby instead is the same violation", async () => {
  const found = await rules('<p role="doc-pagebreak" aria-labelledby="doc-title" id="page-5"></p>');
  if (found === null) return;
  assert.deepEqual(found, ["aria-prohibited-attr[serious]"]);
});

test("the shape the page agent is now told to emit is clean", async () => {
  for (const marker of [
    '<p role="doc-pagebreak" id="page-5">5</p>', // the prescribed shape, verbatim
    '<p role="doc-pagebreak" id="page-iv">iv</p>', // front matter, as printed
    '<p role="doc-pagebreak" id="page-A-3">A-3</p>', // a sectioned number, as printed
  ]) {
    const found = await rules(marker);
    if (found === null) return;
    assert.deepEqual(found, [], `${marker} should lint clean, got: ${found.join(", ")}`);
  }
});

// The two cases that show why "carry the number as text" is the rule rather than "drop
// the label".
//
// A labelled marker with text passes, which is what made the defect intermittent — the
// same instruction produced a passing document and a failing one on the same input. And
// an empty marker with no label passes too, so axe is not the reason the prompt forbids
// it: an element with a role, no text and no permitted way to be named announces a page
// break to a screen-reader user and cannot say which page. That is a barrier the gate
// does not see, which is why it is closed in the prompt.
test("the shapes the gate does NOT catch are the reason the rule is about the marker's text", async () => {
  const labelledWithText = await rules('<p role="doc-pagebreak" aria-label="Page 5" id="page-5">5</p>');
  if (labelledWithText === null) return;
  assert.deepEqual(
    labelledWithText,
    [],
    "a labelled marker WITH text still passes axe — if this starts failing, the prompt rule is " +
      "now enforced by the gate and this test's argument needs rewriting, not deleting",
  );

  const emptyUnlabelled = await rules('<p role="doc-pagebreak" id="page-5"></p>');
  if (emptyUnlabelled === null) return;
  assert.deepEqual(emptyUnlabelled, [], "an empty, unnamed marker passes axe; the prompt is what forbids it");
});
