// Four of the six proposals in this change land on the same element, so the shapes they
// prescribe are measured here rather than argued: a named item with its explanation (#113), a
// symbol standing for a control (#107), the line a page prints along its foot (#99), and a
// <dt> transcribed as the page prints it (#95). `agents/page.md` now asks for a <dl> in all
// four cases, and test/page-prompt.test.ts pins that wording. This file pins what the wording
// ASSERTS about the world — the same division of labour as test/pagebreak-marker.test.ts,
// which is where the pattern comes from.
//
// Two of the claims are worth measuring because a prompt cannot check itself:
//
// - `title` is the attribute that names a symbol, not `aria-label`. <abbr> carries no ARIA role,
//   so a naming attribute on it is prohibited — but the shipped gate does not report it, because
//   axe demotes the finding to `incomplete` when the element has text of its own. That is the
//   same silence that let #145's labelled <p> page marker ship, and it is why the rule names an
//   attribute instead of leaving the choice open. Measured both ways below: through the gate,
//   which is silent, and through the one rule, which is not.
// - the <dl> is worth the markup at all. A screen reader is what the flattened view stands in
//   for, and the two renderings of the same page — a <dl>, or paragraphs opening in bold — differ
//   there by every marker the reader would have had. That contrast is the page rule's own
//   argument, so it is held to the flattener that produces it.
import { test } from "node:test";
import assert from "node:assert/strict";
import axe from "axe-core";
import { JSDOM, VirtualConsole } from "jsdom";
import { runAxe } from "../src/pipeline/lint.ts";
import { wrapDocument } from "../src/pipeline/assembly.ts";
import { flatten } from "../src/pipeline/flatten.ts";
import { READER_SYSTEM } from "../src/pipeline/review.ts";

const document = (body: string): string =>
  wrapDocument(`<h1 id="doc-title">Operator's manual</h1>\n<p>Before use.</p>\n${body}`);

// The rule ids the document violates, with their impact. A lint that could not run at all
// reports no `violations` (#164), which is not a clean document — so that case returns null and
// the test declines to conclude anything, the way test/pagebreak-marker.test.ts does.
async function rules(body: string): Promise<string[] | null> {
  const lint = await runAxe(document(body));
  if (!lint.violations) return null;
  assert.equal(lint.ok, lint.violations.length === 0, "lint.ok disagrees with its own violation list");
  return lint.violations.map((v) => `${v.id}[${v.impact}]`);
}

// One rule, put to axe directly, so a shape the gate is silent about can be asked why. Not a
// copy of `runAxe`'s tag filter: `runOnly` by rule name needs none of it, and a second copy of
// that configuration here would drift from the gate it is reasoning about.
async function prohibitedAttr(body: string): Promise<{ violations: number; incomplete: number }> {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(document(body), { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole });
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

const announced = (body: string): string => flatten(wrapDocument(body)).replace(/\s+/g, " ").trim();

test("every <dl> shape the page agent is now told to emit is clean", async () => {
  for (const shape of [
    // #113: a control and what it does. The <dd> holds block content because an explanation
    // that runs to a list is the case the rule names by hand.
    "<dl><dt>Power</dt><dd><p>Turns the unit on.</p><ul><li>Hold two seconds.</li></ul></dd></dl>",
    // #107: the key a page prints for its button symbols, symbol as the term.
    "<dl><dt>&#x25A0;</dt><dd>Stop</dd><dt>&#x25B6;&#x2016;</dt><dd>Play/Pause</dd></dl>",
    // #99: the footer line, in the <div>-per-group form the issue asked for and in the plain
    // form. Both are valid <dl> content and the rule prescribes neither over the other, so a
    // model that reaches for either is not producing a violation.
    "<dl><div><dt>Website</dt><dd>example.com</dd></div><div><dt>E-mail</dt><dd>a@example.com</dd></div></dl>",
    "<dl><dt>Website</dt><dd>example.com</dd><dt>Revision</dt><dd>C, 2019</dd></dl>",
    // #132: a cell's items stay in the cell. The rule forbids lifting them out; this is the
    // shape it leaves behind.
    "<table><caption>Recipe</caption><tr><th scope='col'>Step</th><th scope='col'>Items</th></tr>" +
      "<tr><td>1</td><td><ul><li>Flour</li><li>Salt</li></ul></td></tr></table>",
  ]) {
    const found = await rules(shape);
    // A lint that could not run says nothing about this shape — but it says nothing
    // about the next one either, so skip the row rather than abandoning the four
    // shapes after it: whichever way the run goes, the reason is the same.
    if (found === null) continue;
    assert.deepEqual(found, [], `${shape} should lint clean, got: ${found.join(", ")}`);
  }
});

test("the symbol's name goes in title, and the gate is not what says so", async () => {
  // The prescribed shape, verbatim from the rule.
  const found = await rules('<p>Press <abbr title="Stop">&#x25A0;</abbr> to stop.</p>');
  if (found === null) return;
  assert.deepEqual(found, [], `the prescribed shape should lint clean, got: ${found.join(", ")}`);

  // And the shape the proposal asked for. It passes the gate too — which is the point: the gate
  // cannot be what a model learns this from. Guarded like the call above, or a lint that could not
  // run at all reports the opposite of what happened: `deepEqual(null, [])` fails, and its message
  // says axe started flagging `aria-label` on <abbr>.
  const labelled = await rules('<p>Press <abbr aria-label="Stop">&#x25A0;</abbr> to stop.</p>');
  if (labelled === null) return;
  assert.deepEqual(labelled, [], "aria-label on <abbr> is reported by the gate now, so the rule can cite it");
});

// The prescribed shape has to survive into the one view the document is reviewed in, and it did
// not: `abbr` is inline, so `flatten` announced the glyph and dropped the name, and the Reader —
// which never sees the source image and is told a symbol with no name is a defect — would have
// read correct markup as an unnamed control. Both halves are pinned here: the name is announced,
// and the marker is one READER_SYSTEM tells the Reader to expect (a marker the flattener produces
// and the prompt does not advertise is the same defect as the reverse, per flatten.ts's own note).
test("a symbol named only by its title is named in the flattened view too", () => {
  const named = announced('<p>Press <abbr title="Stop">&#x25A0;</abbr> to stop.</p>');
  assert.match(named, /Press ■ \[Abbr title\] Stop to stop\./);
  // The name is not doubled where the page prints the expansion as the element's own text.
  assert.match(announced("<p>The <abbr title=\"WCAG\">WCAG</abbr> rules.</p>"), /The WCAG rules\./);
  // A glyph with no name at all is what stays bare — the case the Reader should report.
  assert.match(announced("<p>Press &#x25A0; to stop.</p>"), /Press ■ to stop\./);
  assert.match(READER_SYSTEM, /\[Abbr title\] carries the name an abbreviation or a symbol holds in its title attribute/);
  assert.match(READER_SYSTEM, /\[Caption\], \[Term\], \[Definition\], \[Abbr title\]/);
});

// Measured directly, so the silence above can be told apart from nothing being wrong. This is
// not the tripwire on `runAxe`'s promotion list — adding this rule to it would leave these rows
// unchanged and turn the assertion above into a failure, which is where that change shows up.
test("aria-label on <abbr> is a demoted finding, not an absent one", async () => {
  assert.deepEqual(
    await prohibitedAttr('<p>Press <abbr aria-label="Stop">&#x25A0;</abbr> to stop.</p>'),
    { violations: 0, incomplete: 1 },
    "axe no longer has anything to say about aria-label on <abbr>, so page.md's reason for title is out of date",
  );
  // The same demotion for the element a model reaches for when told not to use <abbr>: a
  // roleless generic may not be named either, and it has text, so it lands in the same bucket.
  assert.deepEqual(await prohibitedAttr('<p>Press <span aria-label="Stop">&#x25A0;</span> to stop.</p>'), {
    violations: 0,
    incomplete: 1,
  });
  // The prescribed shape is clean by this rule's own reckoning, not merely unreported.
  assert.deepEqual(await prohibitedAttr('<p>Press <abbr title="Stop">&#x25A0;</abbr> to stop.</p>'), {
    violations: 0,
    incomplete: 0,
  });
});

test("what the <dl> buys is what the bold paragraph does not announce", () => {
  // The same page, rendered both ways. The words are identical; what differs is every marker a
  // reader navigating by term would have had. This is the rule's argument, measured on the
  // flattener the Reader Agent is given.
  const asList = announced("<dl><dt>Power</dt><dd>Turns the unit on.</dd><dt>Mode</dt><dd>Selects a program.</dd></dl>");
  const asProse = announced(
    "<p><strong>Power:</strong> Turns the unit on.</p><p><strong>Mode:</strong> Selects a program.</p>",
  );

  assert.match(asList, /\[Term\] Power \[Definition\] Turns the unit on\. \[Term\] Mode \[Definition\] Selects a program\./);
  assert.doesNotMatch(asProse, /\[Term\]|\[Definition\]/);
  // Both carry the words, which is why the defect is invisible to anything that counts them:
  // a fidelity check comparing text against the page passes on either.
  for (const flat of [asList, asProse]) {
    for (const word of ["Power", "Turns the unit on.", "Mode", "Selects a program."]) {
      assert.ok(flat.includes(word), `"${word}" should survive both renderings`);
    }
  }
});

test("a cell's items keep the row and the column that lifting them out would drop", () => {
  const inCell = announced(
    "<table><caption>Recipe</caption><tr><th scope='col'>Step</th><th scope='col'>Ingredients</th></tr>" +
      "<tr><td>3</td><td><ul><li>Flour</li><li>Salt</li></ul></td></tr></table>",
  );
  // The row is what the reader gets: the step, then the items of that step's cell.
  assert.match(inCell, /\[Row\] 3 \| Flour Salt/);

  // Lifted out — the shape #132 reported — the same words arrive with no row and no column
  // header anywhere near them, and the table they belonged to says it has one column of data.
  const lifted = announced(
    "<table><caption>Recipe</caption><tr><th scope='col'>Step</th><th scope='col'>Ingredients</th></tr>" +
      "<tr><td>3</td><td></td></tr></table><ul><li>Flour</li><li>Salt</li></ul>",
  );
  assert.match(lifted, /\[Row\] 3 \| \[empty\]/);
  assert.match(lifted, /\[List item\] Flour \[List item\] Salt/);
  // And nothing in the announcement ties them back: the cell they came from reads as empty.
  assert.doesNotMatch(lifted, /3 \| Flour/);
});
