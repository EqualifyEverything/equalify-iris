// Issue #145: a delivered document shipped a SERIOUS `aria-prohibited-attr` violation
// from one element — `<p role="doc-pagebreak" aria-label="Page 5" id="page-5"></p>`. Six
// other markers in that document carried their number as text instead of a label and
// passed; the seventh was empty and failed.
//
// The report is about the HOST ELEMENT, not about the role. `aria-prohibited-attr` judges
// a naming attribute against the element's own role — `paragraph` and the roleless `<span>`
// prohibit naming, `separator` does not — and the check does not resolve `doc-*` roles at
// all, so on a `<p>` it reads `paragraph` and fires. Nothing in ARIA forbids naming a page
// break; the first version of this rule read the report as if something did, and prescribed
// `<p role="doc-pagebreak">5</p>` with the number as the element's text. That shape is
// axe-clean and still wrong: `doc-pagebreak` subclasses `separator`, whose contents are
// presentational, so the number is pruned before a reader is given it and the marker
// announces a page break that cannot say which page — #145's barrier, rebuilt.
//
// So `agents/page.md` now prescribes `<hr role="doc-pagebreak" aria-label="Page 5"
// id="page-5">`: `<hr>`'s own role is already `separator`, which permits a name from the
// author, and the label is the only place the number survives. The wording is pinned in
// test/page-prompt.test.ts; this file pins what the wording ASSERTS about the world.
//
// Two of those assertions the gate can settle, and both are pinned below: the reported
// shape fails, the prescribed shape passes. `runAxe` is the check that decides whether a
// document ships with a violation, and `axe-core` is pinned to an exact version precisely
// so its verdicts are a fact about a commit rather than about a redeploy (see
// src/pipeline/lint.ts).
//
// The third — that the pruned number never reaches a reader — no axe API can settle, and
// this file does not pretend otherwise. axe's own `accessibleText` returns "5" for the
// pruned shape, because its name computation is `doc-*`-blind in the same way the rule is.
// What is pinned instead is the shipped role table, which is where axe records the two
// facts the prompt reasons from, and a clean verdict on a shape the prompt forbids anyway
// — so nothing here can be misread as the gate endorsing it.
import { test } from "node:test";
import assert from "node:assert/strict";
import axe from "axe-core";
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

test("the reported marker — a labelled, empty <p> — is a serious violation of the shipped gate", async () => {
  const found = await rules('<p role="doc-pagebreak" aria-label="Page 5" id="page-5"></p>');
  if (found === null) return;
  assert.deepEqual(
    found,
    ["aria-prohibited-attr[serious]"],
    `expected the reported violation alone, got: ${found.join(", ") || "none"}`,
  );
});

// aria-labelledby is prohibited on `paragraph` for the same reason and is the shape a model
// reaches for when told not to use aria-label — so the prompt's example is pinned in both
// forms. Pointed at a real heading, so this fails for being prohibited rather than for
// dangling. A `<span>` host is here too: it is the other element a model reaches for, and
// it fails for its own reason — a roleless generic may not be named either.
test("the same marker fails on aria-labelledby, and on a <span> host", async () => {
  for (const marker of [
    '<p role="doc-pagebreak" aria-labelledby="doc-title" id="page-5"></p>',
    '<span role="doc-pagebreak" aria-label="Page 5" id="page-5"></span>',
  ]) {
    const found = await rules(marker);
    if (found === null) return;
    assert.deepEqual(found, ["aria-prohibited-attr[serious]"], `${marker} should be the reported violation`);
  }
});

test("the shape the page agent is now told to emit is clean", async () => {
  for (const marker of [
    '<hr role="doc-pagebreak" aria-label="Page 5" id="page-5">', // the prescribed shape, verbatim
    '<hr role="doc-pagebreak" aria-label="Page iv" id="page-iv">', // front matter, as printed
    '<hr role="doc-pagebreak" aria-label="Page A-3" id="page-A-3">', // a sectioned number, as printed
  ]) {
    const found = await rules(marker);
    if (found === null) return;
    assert.deepEqual(found, [], `${marker} should lint clean, got: ${found.join(", ")}`);
  }
});

// The two facts the prompt reasons from, as axe-core itself records them. They are the
// reason the rule is a shape and not "avoid aria-label": if a version bump ever moved
// either one, the prompt's stated reasoning would be wrong even though every verdict above
// still held, and nothing else in the suite would notice.
test("axe's own role table is why the marker is a named <hr> and not a <p> with text", () => {
  const roles = axe.utils.getStandards().ariaRoles;

  // Naming is permitted on the role: the report above is the host element's doing.
  assert.equal(roles["doc-pagebreak"].prohibitedAttrs, undefined, "doc-pagebreak now prohibits attributes itself");
  assert.deepEqual(roles["doc-pagebreak"].superclassRole, ["separator"]);
  assert.deepEqual(roles.paragraph.prohibitedAttrs, ["aria-label", "aria-labelledby"]);

  // And the reason a name is the only way to say which page: the marker's contents are not
  // exposed, so a number written as text is not a name and is not read as content either.
  assert.equal(roles["doc-pagebreak"].childrenPresentational, true);
});

// A shape the gate does NOT catch, kept because it is the trap: a labelled marker WITH text
// passes, which is what made #145 intermittent — the same instruction produced a passing
// document and a failing one on the same input. The prescribed `<p>` shape of this rule's
// first version passes too, and that silence is what this test exists to label. axe having
// nothing to say about `<p role="doc-pagebreak">5</p>` is not evidence that the 5 reaches a
// reader; it is the gate declining to resolve the role at all.
test("axe's silence on a <p> marker is not evidence the number reaches a reader", async () => {
  for (const marker of [
    '<p role="doc-pagebreak" aria-label="Page 5" id="page-5">5</p>', // named AND texted: passes
    '<p role="doc-pagebreak" id="page-5">5</p>', // the withdrawn shape: passes, prunes the 5
    '<p role="doc-pagebreak" id="page-5"></p>', // no name, nothing to prune: passes, says nothing
  ]) {
    const found = await rules(marker);
    if (found === null) return;
    assert.deepEqual(
      found,
      [],
      `${marker} still passes axe — if this starts failing, the gate has caught up with the prompt ` +
        `and this test's argument needs rewriting, not deleting`,
    );
  }
});
