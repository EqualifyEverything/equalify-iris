// Issue #145: a delivered document carried a SERIOUS `aria-prohibited-attr` violation from
// one empty element — `<p role="doc-pagebreak" aria-label="Page 5" id="page-5"></p>`. Six
// other markers in the same document had the identical attribute and were clean, because
// they carried their page number as text.
//
// `agents/page.md` now tells the page agent to put the number in as text and to leave
// aria-label/aria-labelledby off (asserted in test/page-prompt.test.ts). These tests pin the
// axe behaviour that rule is reasoning from, in the same spirit as
// test/lint-heading-order.test.ts: which shapes `aria-prohibited-attr` reports is an axe
// internal, and `package.json` takes axe-core on a caret range, so a version bump can move
// it under us. Two things would go stale silently without this file — the claim that the
// prompt's corrected form passes the gate, and the claim that the attribute beside text does
// NOT, which is the whole reason the rule forbids the attribute instead of just requiring
// text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAxe } from "../src/pipeline/lint.ts";
import { wrapDocument } from "../src/pipeline/assembly.ts";

// The rule ids this body violates, or null when axe could not run here — `runAxe` degrades
// to `ok: true, violations: []` with `error` set, which is not a clean document. Same helper
// and same early return as test/lint-heading-order.test.ts.
async function rules(body: string): Promise<string[] | null> {
  const lint = await runAxe(wrapDocument(`<h1>Report</h1>${body}`));
  if (lint.error) return null; // axe could not run here; see runAxe's degradation path
  assert.equal(lint.ok, lint.violations.length === 0, "lint.ok disagrees with its own violation list");
  return lint.violations.map((v) => v.id);
}

test("the reported marker — a name attribute on an empty page-break marker — fails the gate", async () => {
  const lint = await runAxe(wrapDocument('<h1>Report</h1><p role="doc-pagebreak" aria-label="Page 5" id="page-5"></p>'));
  if (lint.error) return;
  assert.deepEqual(
    lint.violations.map((v) => [v.id, v.impact]),
    [["aria-prohibited-attr", "serious"]],
    `expected one serious aria-prohibited-attr, got: ${lint.violations.map((v) => v.id).join(", ") || "none"}`,
  );
});

// aria-labelledby is prohibited on the role for the same reason, so a marker that moves the
// name into a hidden span rather than dropping it ships the same violation. page.md names
// both attributes because of this.
test("naming the empty marker with aria-labelledby instead is the same violation", async () => {
  const found = await rules('<p role="doc-pagebreak" id="page-5" aria-labelledby="pl-5"></p><span id="pl-5" hidden>Page 5</span>');
  if (found === null) return;
  assert.deepEqual(found, ["aria-prohibited-attr"]);
});

test("the form page.md now asks for is clean", async () => {
  const found = await rules('<p role="doc-pagebreak" id="page-iv">iv</p><p>Front matter.</p><p role="doc-pagebreak" id="page-5">5</p>');
  if (found === null) return;
  assert.deepEqual(found, [], `the fix page.md asks for does not pass the gate: ${found.join(", ")}`);
});

// The trap this rule exists for. axe reports the prohibited attribute only where the element
// has no text of its own, so the six markers that kept their number passed WITH the attribute
// on them — the gate cannot warn a maintainer that the pattern is one dropped character away
// from a serious violation. That is why page.md forbids the attribute rather than only asking
// for the text: this assertion failing (axe widening the rule to named-but-non-empty markers)
// would mean the prompt's rule has become enforceable, and this comment should be revisited.
test("the same attribute beside text is clean, which is why the prompt forbids the attribute", async () => {
  const found = await rules('<p role="doc-pagebreak" aria-label="Page 5" id="page-5">5</p>');
  if (found === null) return;
  assert.deepEqual(found, [], `axe now reports the named non-empty marker: ${found.join(", ")}`);
});

// The generalised half of the rule ("never on a <p>, <span> or <div> that is only holding
// text") is the same defect without the doc-pagebreak role: an implicit role=paragraph or
// role=generic prohibits a name too, so an empty element given one is the same barrier from
// a different direction — a Copy Editor rewrite naming a spacer, say.
test("an empty element with no role at all is caught the same way", async () => {
  for (const body of ['<p aria-label="Page 5"></p>', '<span aria-label="Page 5"></span>']) {
    const found = await rules(body);
    if (found === null) return;
    assert.deepEqual(found, ["aria-prohibited-attr"], `expected aria-prohibited-attr for ${body}`);
  }
});
