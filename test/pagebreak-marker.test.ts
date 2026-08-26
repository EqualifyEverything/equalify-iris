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
// A clean verdict from that gate is a narrower fact than a clean verdict from axe, and the last
// test in this file is about the difference: the six markers that passed in #145's document were
// findings axe DEMOTED to `incomplete`, not findings it never made.
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
import { JSDOM, VirtualConsole } from "jsdom";
import { runAxe } from "../src/pipeline/lint.ts";
import { wrapDocument } from "../src/pipeline/assembly.ts";

// The rule ids the document violates, with their impact. A lint that could not run at all
// reports no `violations` (#164), which is not a clean document — so that case returns null
// and the test declines to conclude anything, the same way test/lint-heading-order.test.ts
// does.
async function rules(body: string): Promise<string[] | null> {
  const lint = await runAxe(wrapDocument(`<h1 id="doc-title">Operator's manual</h1>\n<p>Before use.</p>\n${body}`));
  if (!lint.violations) return null;
  assert.equal(lint.ok, lint.violations.length === 0, "lint.ok disagrees with its own violation list");
  return lint.violations.map((v) => `${v.id}[${v.impact}]`);
}

// The same document put to axe directly, for the ONE rule this file is about, so a shape the
// gate is silent about can be asked why. `runAxe` returns violations and nothing else — the
// promotion out of `incomplete` happens inside it and only for `duplicate-id-aria`
// (src/pipeline/lint.ts) — so a `[]` from `rules()` above means "nothing the gate reports",
// which is not the same claim as "nothing axe found".
//
// Deliberately not a copy of `runAxe`'s tag filter and rule tuning: `runOnly` by rule name
// needs none of it, and a second copy of that configuration in a test would drift from the
// gate it is supposed to be reasoning about. What this measures is one rule's own verdict.
async function prohibitedAttr(body: string): Promise<{ violations: number; incomplete: number }> {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(
    wrapDocument(`<h1 id="doc-title">Operator's manual</h1>\n<p>Before use.</p>\n${body}`),
    { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole },
  );
  try {
    const { window } = dom;
    window.eval(axe.source);
    const w = window as unknown as {
      axe: {
        run: (
          ctx: unknown,
          opts: unknown,
        ) => Promise<{ violations: { nodes: unknown[] }[]; incomplete: { nodes: unknown[] }[] }>;
      };
    };
    const r = await w.axe.run(window.document, { runOnly: { type: "rule", values: ["aria-prohibited-attr"] } });
    const nodes = (l: { nodes: unknown[] }[]): number => l.reduce((n, v) => n + v.nodes.length, 0);
    return { violations: nodes(r.violations), incomplete: nodes(r.incomplete) };
  } finally {
    dom.window.close();
  }
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
  // axe's shipped `AriaRoles` type declares none of these members, though every entry in
  // the table carries them — so the assertions below are cast to the shape axe actually
  // ships. Widening it rather than picking members out keeps the assertion honest: an
  // absent key reads as `undefined` and fails on comparison, which is what the first
  // assertion depends on.
  const roles = axe.utils.getStandards().ariaRoles as unknown as Record<
    string,
    { prohibitedAttrs?: string[]; superclassRole?: string[]; childrenPresentational?: boolean }
  >;

  // Naming is permitted on the role: the report above is the host element's doing.
  assert.equal(roles["doc-pagebreak"].prohibitedAttrs, undefined, "doc-pagebreak now prohibits attributes itself");
  assert.deepEqual(roles["doc-pagebreak"].superclassRole, ["separator"]);
  assert.deepEqual(roles.paragraph.prohibitedAttrs, ["aria-label", "aria-labelledby"]);

  // And the reason a name is the only way to say which page: the marker's contents are not
  // exposed, so a number written as text is not a name and is not read as content either.
  assert.equal(roles["doc-pagebreak"].childrenPresentational, true);
});

// Shapes the gate does NOT catch, kept because they are the trap: a labelled marker WITH text
// passes, which is what made #145 intermittent — the same instruction produced a passing
// document and a failing one on the same input. The prescribed `<p>` shape of this rule's
// first version passes too, and that silence is what this test exists to label. A clean verdict
// on `<p role="doc-pagebreak">5</p>` is not evidence that the 5 reaches a reader; it is the gate
// declining to resolve the role at all.
test("the gate's silence on a <p> marker is not evidence the number reaches a reader", async () => {
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
      `${marker} still passes the gate — if this starts failing, the gate has caught up with the ` +
        `prompt and this test's argument needs rewriting, not deleting`,
    );
  }
});

// ...and the two silences above are not the same silence, which is the correction this test
// exists for. Reviewing the withdrawn version of this rule (PR #148) turned up the claim that
// axe "has nothing to say" about a texted marker; measured, axe has plenty to say about one of
// them and Iris's gate is what drops it:
//
//   <p role="doc-pagebreak" aria-label="Page 5">5</p>   1 incomplete, 0 violations
//   <p role="doc-pagebreak" id="page-5">5</p>           0 incomplete, 0 violations
//   <p role="doc-pagebreak" aria-label="Page 5"></p>    0 incomplete, 1 violation
//
// `aria-prohibited-attr` returns `undefined` rather than `false` when the element has text of
// its own — the attribute is prohibited either way, but whether the reader loses anything
// depends on what that text says, which axe will not decide — so the finding lands in
// `incomplete`, and `runAxe` promotes only `duplicate-id-aria` out of `incomplete`
// (src/pipeline/lint.ts, pinned in test/assembly-anchors.test.ts).
//
// Which is a sharper answer to why #145 was intermittent than "six markers were clean": six
// markers were DEMOTED, and the seventh had no text to demote it. So the number in the middle
// row is the one to read if this file ever seems to disagree with axe — and if the promotion
// list grows to include this rule, this test fails and says so, instead of the failure reading
// as an axe regression somewhere else in the suite.
test("the labelled marker with text is a finding the gate demotes, not one axe missed", async () => {
  assert.deepEqual(
    await prohibitedAttr('<p role="doc-pagebreak" aria-label="Page 5" id="page-5">5</p>'),
    { violations: 0, incomplete: 1 },
    "axe now reports the texted <p> marker as a violation: lint.ts's promotion list, or this test's argument, is out of date",
  );
  // The withdrawn shape has no naming attribute at all, so there is nothing for this rule to
  // judge and the silence really is silence. That is the row that makes the contrast a contrast.
  assert.deepEqual(await prohibitedAttr('<p role="doc-pagebreak" id="page-5">5</p>'), {
    violations: 0,
    incomplete: 0,
  });
  // And the reported element, through the same measurement: a violation because it has no text
  // of its own to make the attribute's effect a judgement call.
  assert.deepEqual(await prohibitedAttr('<p role="doc-pagebreak" aria-label="Page 5" id="page-5"></p>'), {
    violations: 1,
    incomplete: 0,
  });
  // The prescribed shape is clean by this rule's own reckoning too, not merely unreported by the
  // gate — the distinction the rest of this test is about.
  assert.deepEqual(await prohibitedAttr('<hr role="doc-pagebreak" aria-label="Page 5" id="page-5">'), {
    violations: 0,
    incomplete: 0,
  });
});
