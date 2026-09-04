import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { flatten } from "../src/pipeline/flatten.ts";
import { contentCoverage, MIN_CONTENT_COVERAGE } from "../src/pipeline/feedback.ts";
import { READER_SYSTEM } from "../src/pipeline/review.ts";

// `flatten` has one invariant: it may reorganize text, but it may not LOSE any.
// Both of its consumers fail silently when it does.
//
//   * The Reader reviews this view instead of the source images, so
//     anything missing here cannot be reported as an issue — the review loop has
//     nothing to act on.
//   * `contentCoverage` compares an agent's candidate output against an accepted
//     fixture using these words. Text that never reaches the view is absent from
//     BOTH sides, so a regression becomes unmeasurable and the gate scores it 1.0.
//
// The second is the dangerous one: the regression gate exists to stop an agent
// update from dropping content, and text `flatten` cannot see is exactly the
// content it cannot protect. That is why the assertions below are mostly about
// text survival rather than about exact formatting.

// Every word a screen reader would announce, derived independently of flatten.
//
// Text nodes are walked individually and joined with spaces: `body.textContent`
// concatenates without separators, which invents words like "failuresbody" and
// would make this baseline wrong rather than flatten wrong. Announced attribute
// values count as content too.
//
// ANNOUNCED is deliberately wider than the set of attributes `flatten` reads. When
// the two lists matched, this baseline shared the code's blind spot: a dropped
// `aria-label` could not fail any test here, because the baseline didn't expect it
// either. A baseline derived from what the code happens to look at is not
// independent of the code. It is derived from what a screen reader announces.
//
// `style`/`script` text is excluded for the same reason from the other direction:
// it is not announced, so treating it as expected content would require flatten to
// emit CSS.
const ANNOUNCED = ["alt", "placeholder", "value", "aria-label", "title"];
const NOT_ANNOUNCED = new Set(["STYLE", "SCRIPT", "TEMPLATE", "NOSCRIPT"]);

function announcedWords(html: string): Set<string> {
  const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`);
  const doc = dom.window.document;
  const parts: string[] = [];
  const walk = (n: Node): void => {
    if (n.nodeType === 3) {
      parts.push(n.textContent ?? "");
      return;
    }
    if (n.nodeType === 1 && NOT_ANNOUNCED.has((n as unknown as { tagName: string }).tagName)) return;
    for (const c of Array.from(n.childNodes)) walk(c);
  };
  walk(doc.body);
  for (const el of Array.from(doc.querySelectorAll(ANNOUNCED.map((a) => `[${a}]`).join(",")))) {
    for (const a of ANNOUNCED) parts.push(el.getAttribute(a) ?? "");
  }
  dom.window.close();
  return wordsOf(parts.join(" "));
}

const wordsOf = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1),
  );

// Role markers are bracketed and stripped before comparison, exactly as
// contentCoverage does it — otherwise a marker would count as content.
const flattenedWords = (html: string): Set<string> => wordsOf(flatten(html).replace(/\[[^\]]*\]/g, " "));

function assertNoTextLost(html: string, label: string): void {
  const expected = announcedWords(html);
  const got = flattenedWords(html);
  const missing = [...expected].filter((w) => !got.has(w));
  assert.deepEqual(missing, [], `${label}: flatten dropped ${missing.length} word(s): ${missing.join(", ")}`);
}

const REPORT = `
<h1>Annual Accessibility Report</h1>
<p>Prepared by the <strong>Equalify</strong> team, <em>fiscal year 2026</em>.</p>
<h2>Findings</h2>
<ul>
  <li>Contrast failures<ul><li>Body copy on tinted panels</li><li>Disabled button labels</li></ul></li>
  <li>Missing form labels</li>
</ul>
<table>
  <caption>Issues by severity</caption>
  <thead><tr><th>Severity</th><th>Count</th><th>Owner</th></tr></thead>
  <tbody>
    <tr><td>Critical</td><td>12</td><td>Platform</td></tr>
    <tr><td>Serious</td><td>34</td><td>Design</td></tr>
  </tbody>
</table>
<blockquote><p>Remediation is scheduled for Q1.</p><footer>— Programme office</footer></blockquote>
<form>
  <label for="email">Work email</label>
  <input id="email" type="email" placeholder="you@example.org">
  <label for="notes">Notes</label>
  <textarea id="notes">Existing draft text</textarea>
  <label for="team">Team</label>
  <select id="team"><option>Platform</option><option>Design</option></select>
</form>
<figure><img alt="Bar chart of issues by quarter"><figcaption>Quarterly trend</figcaption></figure>
<dl><dt>WCAG</dt><dd>Web Content Accessibility Guidelines</dd></dl>
<p>See the <a href="/appendix">appendix</a> for methodology.</p>`;

// --- the invariant ---

test("no announced text is lost, across the structures a real page contains", () => {
  assertNoTextLost(REPORT, "full report");
  for (const [label, html] of [
    ["table body", `<table><caption>Cap</caption><tr><th>Region</th></tr><tr><td>Northeast</td></tr></table>`],
    ["nested table", `<table><tr><td>Outer <table><tr><td>Inner cell</td></tr></table></td></tr></table>`],
    ["link inside heading", `<h3>Read the <a href="/x"><em>full</em> policy</a> now</h3>`],
    ["image inside link", `<a href="/home"><img alt="Equalify home"></a>`],
    ["image inside list item", `<li>Chart: <img alt="rising trend"></li>`],
    ["list inside blockquote", `<blockquote><p>Because:</p><ul><li>First</li></ul></blockquote>`],
    ["list inside a table cell", `<table><tr><td><ul><li>Alpha</li><li>Beta</li></ul></td></tr></table>`],
    ["label wrapping its field", `<label>Postcode <input value="E1 6AN"></label>`],
    // Every field in the list above is a direct child of a block, which was the one
    // path that read a field's attributes. These reach it through the inline path.
    ["input in a table cell", `<table><tr><th>Name</th><td><input value="Ada Lovelace"></td></tr></table>`],
    ["input under an inline wrapper", `<p>Name <span><input value="Ada Lovelace"></span></p>`],
    ["select in a table cell", `<table><tr><td><select><option>Platform</option></select></td></tr></table>`],
    ["colspan header", `<table><tr><th colspan="2">Fiscal year</th></tr><tr><td>A</td><td>B</td></tr></table>`],
    ["deeply nested inline", `<p>A <span>b <strong>c <em>d</em></strong></span> e</p>`],
    ["definition list", `<dl><dt>Term</dt><dd>Meaning</dd></dl>`],
    ["renumbered ordered list", `<ol start="2"><li>Alpha</li><li value="9">Beta</li></ol>`],
  ] as [string, string][]) {
    assertNoTextLost(html, label);
  }
});

test("a table's rows reach the flattened view, not just its caption", () => {
  // The specific regression. `case "table"` used to emit the caption and return,
  // so every row was invisible — to the Reader and to the coverage gate.
  const view = flatten(`
    <table><caption>Revenue by region</caption>
      <thead><tr><th>Region</th><th>Revenue</th></tr></thead>
      <tbody><tr><td>Northeast</td><td>4,200,000</td></tr></tbody>
    </table>`);
  assert.match(view, /Revenue by region/);
  for (const cell of ["Region", "Revenue", "Northeast", "4,200,000"]) {
    assert.ok(view.includes(cell), `cell "${cell}" missing from:\n${view}`);
  }
  // Cells are announced per row, not merged into one run-on line.
  assert.match(view, /\[Row\] Northeast \| 4,200,000/);
  assert.match(view, /\[Header row\] Region \| Revenue/);
});

test("deleting a table's body is visible to the regression gate", () => {
  // The reason this bug mattered. `contentCoverage` compares flattened words, so
  // when flatten couldn't see rows, deleting every row of a table was a no-op to
  // the gate — it scored a content-destroying agent update as perfect.
  const accepted = `<h2>Q3 Revenue</h2><table><caption>Revenue by region</caption>
    <thead><tr><th>Region</th><th>Revenue</th></tr></thead>
    <tbody><tr><td>Northeast</td><td>4200000</td></tr><tr><td>Midwest</td><td>3100000</td></tr></tbody></table>`;
  const gutted = `<h2>Q3 Revenue</h2><table><caption>Revenue by region</caption></table>`;

  const cov = contentCoverage(accepted, gutted);
  assert.notEqual(cov, null, "the accepted text must be long enough to score, or the gate abstains");
  assert.ok(
    cov! < MIN_CONTENT_COVERAGE,
    `coverage ${cov} should be below the ${MIN_CONTENT_COVERAGE} gate — a gutted table must not pass`,
  );
  // And an unchanged document still scores perfectly, so the check above is not
  // passing because coverage is broken in general.
  assert.equal(contentCoverage(accepted, accepted), 1);
});

// --- announcement quality ---
//
// These are about the Reader's ability to spot a real accessibility problem. They
// assert behavior, not formatting, so they should survive reasonable rewording of
// the markers.

test("word boundaries survive nesting", () => {
  // textContent concatenation used to produce "FruitApple" — a word that is in
  // neither the source nor the output, which pollutes coverage on both sides.
  const view = flatten(`<ul><li>Fruit<ul><li>Apple</li></ul></li></ul>`);
  assert.ok(!view.includes("FruitApple"), `words ran together:\n${view}`);
  assert.match(view, /Fruit/);
  assert.match(view, /Apple/);
});

test("reading order is preserved when a block interrupts inline text", () => {
  // "Fruit" is announced before the nested list, not after it.
  const view = flatten(`<ul><li>Fruit<ul><li>Apple</li></ul></li></ul>`);
  assert.ok(view.indexOf("Fruit") < view.indexOf("Apple"), `out of order:\n${view}`);

  const doc = flatten(REPORT).split("\n").join("|");
  assert.ok(
    doc.indexOf("Annual Accessibility Report") < doc.indexOf("Findings"),
    "document order lost",
  );
  assert.ok(doc.indexOf("Findings") < doc.indexOf("Issues by severity"), "document order lost");
});

test("an image keeps its alt text even inside a link", () => {
  // An <img> inside an <a> supplies the link's accessible name. Treating either
  // as a leaf loses the other, and a missing alt is the single most common real
  // finding — the Reader has to be able to see it.
  const view = flatten(`<a href="/home"><img alt="Equalify home"></a>`);
  assert.match(view, /Link/);
  assert.match(view, /Equalify home/);
  assert.match(flatten(`<img src="x.png">`), /\[alt missing\]/, "a missing alt must be announced as missing");
});

test("headings keep their level", () => {
  // Level is what makes a skipped-heading issue detectable at all.
  for (const n of [1, 2, 3, 4, 5, 6]) {
    assert.match(flatten(`<h${n}>Title</h${n}>`), new RegExp(`\\[Heading ${n}\\] Title`));
  }
});

test("form fields announce their label, type and value", () => {
  const view = flatten(
    `<label for="e">Work email</label><input id="e" type="email" placeholder="you@example.org">`,
  );
  assert.match(view, /\[Label\] Work email/);
  // The control's type is inside the marker: a screen reader announces it as the
  // field's role, so it is an annotation rather than transcribed content.
  assert.match(view, /\[Field input email\]/);
  assert.match(view, /you@example\.org/, "an announced placeholder must survive");
  // A select's options are content, not chrome.
  const sel = flatten(`<select><option>Platform</option><option>Design</option></select>`);
  assert.match(sel, /Platform/);
  assert.match(sel, /Design/);
});

test("every role marker is bracketed", () => {
  // contentCoverage strips `[...]` before comparing. An unbracketed annotation
  // would be counted as a word the agent produced, diluting the ratio on both
  // sides — so the stripping and the markers are one contract.
  const view = flatten(REPORT);
  const stripped = view.replace(/\[[^\]]*\]/g, " ");
  for (const noise of ["Heading", "List item", "Row", "Header row", "Field", "Label", "Caption", "Quote", "Term", "Definition", "Option", "Table", "Link", "Image"]) {
    assert.ok(!stripped.includes(noise), `marker text "${noise}" leaked into content after stripping`);
  }
  // ...and the markers really are present before stripping, so the check above
  // is not passing because nothing was emitted.
  assert.match(view, /\[Heading 1\]/);
  assert.match(view, /\[Row\]/);
});

test("nothing flatten adds itself survives the bracket strip", () => {
  // The general form of the check above, and the one that matters: the version
  // that only listed marker NAMES missed "(N rows, M columns)", "(empty)" and
  // "(no caption)", whose words joined the compared sets and padded coverage.
  //
  // Every word in the output must trace back to the input. Anything left after
  // stripping `[...]` that the source document does not contain is an annotation
  // masquerading as content.
  const cases = [
    REPORT,
    `<table><caption>Fees</caption><tr><th colspan="2">Both</th></tr><tr><td>A</td><td></td></tr></table>`,
    `<table></table>`,
    `<img src="x.png">`,
    `<img src="x.png" alt="">`,
    `<p>Plain paragraph</p>`,
    `<select><option>Platform</option></select>`,
    `<input type="email" placeholder="you@example.org" value="ada@example.org">`,
    // A list ordinal is the newest annotation, and a number is the easiest kind to
    // leak: `9` outside the brackets would be counted as a word the agent transcribed.
    `<ol start="2"><li>Alpha</li><li value="9">Beta</li></ol>`,
  ];
  for (const html of cases) {
    const emitted = wordsOf(flatten(html).replace(/\[[^\]]*\]/g, " "));
    const source = announcedWords(html);
    const invented = [...emitted].filter((w) => !source.has(w));
    assert.deepEqual(
      invented,
      [],
      `flatten invented ${invented.length} word(s) outside brackets for ${html.slice(0, 60)}: ${invented.join(", ")}` +
        `\n(they would be counted as content by contentCoverage)\n${flatten(html)}`,
    );
  }
});

test("the table summary does not pad a coverage comparison", () => {
  // The concrete gate consequence of unbracketed annotations. `rows`, `columns`,
  // `empty` and `caption` are reproduced free by any candidate that emits a table at
  // all, so they were guaranteed hits on every table fixture — enough to move a
  // fixture that had lost a row from a true 0.833 to a reported 0.875, across the
  // 0.85 gate. `MIN_COVERAGE_WORDS` is 8, so the shorter the fixture the more the
  // padding dominates.
  const accepted = `<table><caption>Membership fees by tier</caption>
    <tr><th>Tier</th><th>Annual cost</th></tr>
    <tr><td>Basic</td><td>Ninety</td></tr>
    <tr><td>Standard</td><td>Fourteen</td></tr>
    <tr><td>Premium</td><td>Twenty</td></tr></table>`;
  const candidate = accepted.replace("<tr><td>Premium</td><td>Twenty</td></tr>", "");
  const cov = contentCoverage(accepted, candidate);
  assert.notEqual(cov, null, "the fixture must be long enough to score");
  assert.ok(
    cov! < MIN_CONTENT_COVERAGE,
    `a fixture that lost a table row scored ${cov}, at or above the ${MIN_CONTENT_COVERAGE} gate`,
  );
});

test("empty and degenerate input does not throw", () => {
  for (const html of ["", "   ", "<p></p>", "<table></table>", "<div><span></span></div>", "<ul></ul>", "<img>"]) {
    assert.equal(typeof flatten(html), "string", `threw or returned non-string for ${JSON.stringify(html)}`);
  }
  assert.equal(flatten(""), "");
  // An empty table still reports itself: a table with no rows is a finding, and
  // silence would be indistinguishable from no table at all.
  assert.match(flatten("<table></table>"), /\[Table\]/);
});

test("a table reports its shape, so a gutted one is visible without reading cells", () => {
  // Row/column counts are what let the Reader (and a human reading the log) see
  // "0 rows" on a table that should have data.
  assert.match(flatten(`<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>`), /\[2 rows, 2 columns\]/);
  assert.match(flatten(`<table><caption>Cap</caption></table>`), /\[0 rows, 0 columns\]/);
});

test("an empty cell is announced rather than silently collapsing the row", () => {
  // Otherwise "A | | C" and "A | C" flatten identically, and a dropped cell — a
  // real extraction failure — is invisible.
  const view = flatten(`<table><tr><td>A</td><td></td><td>C</td></tr></table>`);
  assert.match(view, /A \| \[empty\] \| C/);
});

test("a form field announces its value wherever it sits", () => {
  // A field's text lives in its ATTRIBUTES, so any path that recurses into child
  // nodes drops it — `<input>` has no children at all. When only the block path
  // handled fields, every field in a table cell (cells are announced through the
  // inline path) and every field under an inline wrapper contributed nothing.
  for (const [label, html] of [
    ["direct block child", `<form><input value="Ada Lovelace"></form>`],
    ["inside a table cell", `<table><tr><th>Name</th><td><input value="Ada Lovelace"></td></tr></table>`],
    ["under an inline wrapper", `<p>Name <span><input value="Ada Lovelace"></span></p>`],
    ["inside a link", `<a href="/x"><input value="Ada Lovelace"></a>`],
    ["textarea in a cell", `<table><tr><td><textarea>Ada Lovelace</textarea></td></tr></table>`],
    ["select in a cell", `<table><tr><td><select><option>Ada Lovelace</option></select></td></tr></table>`],
  ] as [string, string][]) {
    const view = flatten(html);
    assert.match(view, /\[Field (input|textarea|select)\]/, `${label}: no field marker in:\n${view}`);
    assert.match(view, /Ada Lovelace/, `${label}: the field's text was dropped from:\n${view}`);
    assertNoTextLost(html, `field ${label}`);
  }
});

test("emptying every field of a form-as-table is visible to the regression gate", () => {
  // The same failure this file exists to prevent, reached through the field path
  // instead of the table path. EDITOR_SYSTEM names "the same content rendered as
  // both a form and a table" as a case the pipeline produces, so this shape is not
  // hypothetical.
  const accepted = `<table><caption>Contact details</caption>
    <tr><th>Full name</th><td><input value="Ada Lovelace"></td></tr>
    <tr><th>Institution</th><td><input value="Cambridge University"></td></tr></table>`;
  const gutted = accepted.replace(/value="[^"]*"/g, 'value=""');
  const cov = contentCoverage(accepted, gutted);
  assert.notEqual(cov, null, "the accepted text must be long enough to score");
  assert.ok(cov! < MIN_CONTENT_COVERAGE, `every field value was emptied yet coverage was ${cov}`);
  assert.equal(contentCoverage(accepted, accepted), 1);
});

test("a half-signed signature block keeps every transcribed value", () => {
  // `agents/page.md` tells the page agent to render a signature block as one uniform
  // form, with the fields that are already filled in on the source page as
  // `<input readonly value="…">` rather than as a <dd> (issue #67). That moves
  // transcribed text out of the document's text nodes and into an attribute, which is
  // the direction this file exists to police: a value the flattened view cannot see is
  // absent from both sides of the gate, so emptying it would score 1.0.
  const block = `<form>
    <fieldset><legend>Contractor</legend>
      <label for="c-sig">Signature</label>
      <input id="c-sig" readonly value="Ada Lovelace" aria-describedby="c-mark">
      <img id="c-mark" src="sig.png" alt="Handwritten signature reading Ada Lovelace">
      <label for="c-date">Date</label>
      <input id="c-date" readonly value="fourth of June">
    </fieldset>
    <fieldset><legend>Client</legend>
      <label for="k-sig">Signature</label><input id="k-sig" aria-required="true">
      <label for="k-date">Date</label><input id="k-date" aria-required="true">
    </fieldset>
  </form>`;
  const view = flatten(block);
  assertNoTextLost(block, "signature block");
  // Both legends, so the two parties are distinguishable, and the signed party's
  // values, which live only in an attribute.
  for (const want of ["Contractor", "Client", "Ada Lovelace", "fourth of June"]) {
    assert.ok(view.includes(want), `"${want}" was dropped from:\n${view}`);
  }
  // A field left blank for the reader still announces its label. Otherwise the
  // Reader — told that a field with nothing after its marker is a real defect —
  // cannot tell an unlabelled control from one waiting to be filled in.
  assert.match(view, /\[Label\] Signature\n\[Field input\]$/m, `a blank field lost its label:\n${view}`);
  // And emptying the signed party's values is visible to the regression gate, the
  // same way it is for the form-as-table above.
  const gutted = block.replace(/readonly value="[^"]*"/g, "readonly");
  const cov = contentCoverage(block, gutted);
  assert.notEqual(cov, null, "the block must be long enough to score");
  assert.ok(cov! < 1, `a filled-in field was emptied yet coverage was ${cov}`);
});

test("a select keeps its field marker in the ordinary block position", () => {
  // The marker used to fire only from the inline path, so it appeared when a select
  // sat in a table cell and was missing in the common case — leaving the Reader
  // unable to tell a select from a bare run of [Option] lines, and so unable to see
  // that the control has no accessible name.
  for (const html of [
    `<form><label for="t">Team</label><select id="t"><option>Platform</option></select></form>`,
    `<p><select><option>Platform</option></select></p>`,
    `<select><option>Platform</option></select>`,
  ]) {
    const view = flatten(html);
    assert.match(view, /\[Field select\]/, `no select marker in:\n${view}`);
    assert.match(view, /Platform/);
  }
});

test("a colspan cell does not make correct markup look broken", () => {
  // The Reader is told a table that reports [0 rows] is a defect, and the Copy
  // Editor may restructure table headers. Counting cells structurally reported a
  // spanning header row as narrower than the table, which would have the editor
  // rewrite an already-accessible table. Spanning headers are common in the scanned
  // tabular documents Iris takes as input.
  const view = flatten(`<table><caption>Budget</caption>
    <tr><th colspan="3">Fiscal year 2026</th></tr>
    <tr><th>Item</th><th>Q1</th><th>Q2</th></tr>
    <tr><td>Training</td><td>10</td><td>12</td></tr></table>`);
  assert.match(view, /\[3 rows, 3 columns\]/, `column count should measure columns, not cells:\n${view}`);
  assert.match(view, /Fiscal year 2026 \[spans 3 columns\]/, `the span must be announced:\n${view}`);
  // A malformed colspan must not corrupt the count.
  assert.match(flatten(`<table><tr><td colspan="abc">A</td></tr></table>`), /\[1 rows, 1 columns\]/);
  assert.match(flatten(`<table><tr><td colspan="-2">A</td></tr></table>`), /\[1 rows, 1 columns\]/);
});

test("a caption with block children does not run its words together", () => {
  // The last `textContent` call in the file, and the same invented-word bug the rest
  // of it was rewritten to remove. Worse than a plain drop: "feesapple" is in neither
  // the accepted fixture nor the candidate, so it pollutes both compared word sets
  // while "fees" and "apple" vanish from both.
  const view = flatten(`<table><caption><p>Fees</p><p>Apple</p></caption><tr><td>A</td></tr></table>`);
  assert.ok(!view.includes("FeesApple"), `caption words ran together:\n${view}`);
  assert.match(view, /Fees/);
  assert.match(view, /Apple/);
  assertNoTextLost(`<table><caption><p>Fees</p><p>Apple</p></caption><tr><td>A</td></tr></table>`, "block caption");
});

test("an accessible name in an attribute is announced", () => {
  // A field labelled only by `aria-label` is correct, axe-clean markup. Dropping the
  // name hid real content from the gate AND made the Reader — told a field with no
  // announced name is a defect — report a phantom issue on correct markup.
  for (const [label, html, want] of [
    ["aria-label on a field", `<input type="text" aria-label="Work email" value="a@b.c">`, /Work email/],
    ["title on a link", `<a href="/x" title="Read more"></a>`, /Read more/],
    ["aria-label on a link", `<a href="/x"><span></span></a>`.replace("<a ", `<a aria-label="Skip to content" `), /Skip to content/],
    ["aria-label on an image with no alt", `<img src="x.png" aria-label="Bar chart">`, /Bar chart/],
    ["aria-label on a button", `<button aria-label="Close dialog"></button>`, /Close dialog/],
  ] as [string, string, RegExp][]) {
    const view = flatten(html);
    assert.match(view, want, `${label}: accessible name dropped from:\n${view}`);
    assertNoTextLost(html, label);
  }
  // A visible name is not announced twice just because an attribute also exists.
  const both = flatten(`<a href="/x" title="Home page">Home</a>`);
  assert.equal(both.match(/Home/g)?.length, 1, `announced twice:\n${both}`);
});

test("a button or summary announces as a control, not as prose", () => {
  // In the one view the Reader uses to judge control labelling, a button that
  // flattens to bare text is indistinguishable from a paragraph — and an icon-only
  // button, the common accessible-name defect, flattened to nothing at all:
  // invisible to review and unmeasurable by the gate.
  assert.match(flatten(`<button type="submit">Send request</button>`), /\[Field button submit\] Send request/);
  assert.match(flatten(`<details><summary>More</summary><p>Body</p></details>`), /\[Field summary\] More/);
  const icon = flatten(`<button><img src="x.png"></button>`);
  assert.match(icon, /\[Field button\]/, `an icon-only button vanished entirely:\n${icon}`);
});

test("a rowspan cell does not make correct markup look broken either", () => {
  // Same phantom defect as colspan, one row later: a cell spanning rows leaves the
  // next row with fewer cells than the table has columns.
  const view = flatten(`<table><caption>Staff</caption>
    <tr><th>Name</th><th>Role</th></tr>
    <tr><td rowspan="2">Ada</td><td>Lead</td></tr>
    <tr><td>Eng</td></tr></table>`);
  assert.match(view, /Ada \[spans 2 rows\]/, `the row span must be announced:\n${view}`);
  assert.match(flatten(`<table><tr><td rowspan="abc">A</td></tr></table>`), /^\[Table\][^\n]*\n\[Row\] A$/m);
});

test("style and script text is not treated as content", () => {
  // CSS and JS are neither announced nor transcribed, so emitting them made them
  // free hits in the coverage word sets — an agent leaking style markup would have
  // made the gate read as healthier.
  const view = flatten(`<style>.a{color:red}</style><script>var x=1</script><p>Text</p>`);
  assert.ok(!view.includes("color"), `stylesheet text leaked into the view:\n${view}`);
  assert.ok(!view.includes("var x"), `script text leaked into the view:\n${view}`);
  assert.match(view, /Text/);
});

test("a marker stays attached to its text when the text is in a block child", () => {
  // `<li><p>x</p></li>` and `<label><div>x</div></label>` are ordinary shapes. A bare
  // `[Heading 2]` or `[Label]` alone on a line reads to the Reader as an empty
  // heading or an unlabelled control, and the prompt teaches it to treat empty
  // structures as real problems.
  assert.match(flatten(`<h2><div>Q3 Revenue</div></h2>`), /\[Heading 2\] Q3 Revenue/);
  assert.match(flatten(`<li><p>First item</p></li>`), /\[List item\] First item/);
  assert.match(flatten(`<label><div>Work email</div></label>`), /\[Label\] Work email/);
  // Both markers survive when they nest.
  assert.match(flatten(`<li><h3>Nested heading</h3></li>`), /\[List item\] \[Heading 3\] Nested heading/);
  // And a marker still precedes content it cannot merge with, in reading order.
  const t = flatten(`<li><table><tr><td>Cell</td></tr></table></li>`);
  assert.ok(t.indexOf("[List item]") < t.indexOf("Cell"), `reading order lost:\n${t}`);
});

test("an ordered list's items are announced with their numbers", () => {
  // The numbers are the whole point: an <ol> counts 1..n by itself whatever its items
  // contain, so a list whose numbering was tidied — the gap closed, the repeat dropped
  // — used to flatten identically to one that kept it. `[List item]` with no number is
  // the one form of altered content the review loop could not see.
  const plain = flatten(`<ol><li>Alpha</li><li>Beta</li></ol>`);
  assert.match(plain, /\[List item 1\] Alpha/);
  assert.match(plain, /\[List item 2\] Beta/);
  // `start` carries a list that does not begin at 1, and `value` sets one item's number
  // AND the count that follows it — 1, 5, 6, as the HTML ordinal algorithm has it.
  assert.match(flatten(`<ol start="5"><li>Fifth</li><li>Sixth</li></ol>`), /\[List item 5\] Fifth\n\[List item 6\] Sixth/);
  const skipped = flatten(`<ol><li>One</li><li value="5">Five</li><li>Six</li></ol>`);
  assert.match(skipped, /\[List item 1\] One\n\[List item 5\] Five\n\[List item 6\] Six/);
  // A reversed list counts down from its own length, because that is what is
  // announced; a countdown read out as 1, 2, 3 would be a wrong number, which is
  // worse than no number.
  assert.match(flatten(`<ol reversed><li>Second</li><li>First</li></ol>`), /\[List item 2\] Second\n\[List item 1\] First/);
  assert.match(flatten(`<ol reversed start="10"><li>Ten</li><li>Nine</li></ol>`), /\[List item 10\] Ten\n\[List item 9\] Nine/);
  // An unordered or definition list has no number to lose, so nothing is invented for
  // it — a number there would be one the document does not show.
  const ul = flatten(`<ul><li>Alpha</li><li>Beta</li></ul>`);
  assert.match(ul, /\[List item\] Alpha/);
  assert.ok(!/\[List item \d/.test(ul), `an unordered list was numbered:\n${ul}`);
});

test("a list item's number reaches it however the item is announced", () => {
  // The marker travels down to a block child (`<li><p>x</p></li>`) and combines with
  // that child's own marker, so the number has to survive both paths — a `[List item]`
  // that loses its number on the ordinary `<li><p>` shape would leave the gap open for
  // most real markup.
  assert.match(flatten(`<ol><li><p>First item</p></li><li><p>Second item</p></li></ol>`), /\[List item 1\] First item\n\[List item 2\] Second item/);
  assert.match(flatten(`<ol start="3"><li><h3>Nested heading</h3></li></ol>`), /\[List item 3\] \[Heading 3\] Nested heading/);
  const t = flatten(`<ol start="4"><li><table><tr><td>Cell</td></tr></table></li></ol>`);
  assert.ok(t.indexOf("[List item 4]") < t.indexOf("Cell"), `reading order lost:\n${t}`);
  // Each list counts its own items: a nested list restarts, and the outer one resumes
  // where it left off rather than continuing from the child's count.
  const nested = flatten(`<ol><li>Alpha<ol><li>Inner</li></ol></li><li>Beta</li></ol>`);
  assert.match(nested, /\[List item 1\] Alpha\n\[List item 1\] Inner\n\[List item 2\] Beta/);
  // Only `<li>` children advance the count, and only the ones this list owns.
  assert.match(flatten(`<ol><p>Intro</p><li>Alpha</li></ol>`), /\[List item 1\] Alpha/);
  // A number the browser would ignore leaves the count alone rather than emitting NaN.
  assert.match(flatten(`<ol start="abc"><li value="x">Alpha</li><li>Beta</li></ol>`), /\[List item 1\] Alpha\n\[List item 2\] Beta/);
});

test("the number is inside the brackets, so it is visible to the Reader and not to coverage", () => {
  // Both halves matter. The Reader has to see the number; `contentCoverage` must not,
  // because an annotation outside the brackets is padding every candidate reproduces
  // for free — the same defect that once moved a gutted table from 0.833 to 0.875 and
  // past the gate.
  const faithful = `<h2>Parts list</h2><ol><li>Bean hopper</li><li value="5">Burr carrier ring</li><li>Grind adjuster knob</li></ol>`;
  const tidied = `<h2>Parts list</h2><ol><li>Bean hopper</li><li>Burr carrier ring</li><li>Grind adjuster knob</li></ol>`;
  assert.notEqual(flatten(faithful), flatten(tidied), "a renumbered list must not flatten identically to a faithful one");
  // The words are the same on both sides, so the gate is unmoved: the numbering
  // regression is the Reader's to catch, and this must not become a coverage failure
  // that flags every list whose numbering merely differs.
  assert.equal(contentCoverage(faithful, tidied), 1);
  assert.equal(contentCoverage(tidied, faithful), 1);
  // And no digit escapes into the compared word set.
  const stripped = flatten(`<ol start="42"><li>Alpha</li></ol>`).replace(/\[[^\]]*\]/g, " ");
  assert.ok(!/\d/.test(stripped), `a list ordinal leaked into content: ${stripped}`);
});

test("every marker the Reader prompt advertises is one flatten emits", () => {
  // `[Option]` was documented and unreachable: options reach the inline path, where
  // `option` is neither inline nor a field, so it recursed to bare text. A marker the
  // prompt promises but the code never emits teaches the Reader to expect something
  // that will not appear.
  const view = flatten(`<select><option>Platform</option><option>Design</option></select>`);
  assert.match(view, /\[Field select\] Platform, Design/);
  assert.ok(!READER_SYSTEM.includes("[Option]"), "the prompt advertises a marker flatten never emits");
  // The mirror of that failure: a marker the code emits and the prompt never names. An
  // ordered list's items are numbered now, so the prompt has to say so — otherwise the
  // Reader is told everything in brackets is an annotation from a list that does not
  // include this one.
  assert.match(flatten(`<ol><li>Alpha</li></ol>`), /\[List item 1\]/);
  assert.ok(READER_SYSTEM.includes("[List item N]"), "flatten emits a marker the prompt does not name");
  // Options are still content, and are separated so they cannot run together.
  assertNoTextLost(`<select><option>Platform</option><option>Design</option></select>`, "select options");
});

test("a page too deep for the recursive walk keeps its text instead of throwing", () => {
  // `block` and `inlineText` both recurse, so a pathologically nested page overflowed the
  // stack and threw `RangeError` — dropping ALL the text, the worst version of the failure
  // this file exists to prevent, and failing the session from a helper the caller expects
  // to always return. The depth is reachable: `anchors.ts` deliberately DELIVERS a page too
  // deep to rewrite rather than dropping it, so it arrives in the body that `review.ts`
  // flattens for the Reader and that `contentCoverage` flattens on both sides of the gate.
  //
  // Depths straddle where the recursive walk gives out (~5,000 here) so both the ordinary
  // path and the fallback are covered by the same assertions. Every threshold moves with
  // how much stack the caller already spent, which is why the assertion is "the words
  // survived" and not "the fallback ran at depth N".
  for (const depth of [600, 5000, 9000, 10000]) {
    const content = `<p>hello</p><ul><li>apple</li><li>pear</li></ul><img alt="Bar chart"><input value="Ada">`;
    const html = "<div>".repeat(depth) + content;
    let view: string;
    try {
      view = flatten(html);
    } catch (e) {
      assert.fail(`depth ${depth}: flatten threw ${(e as Error).constructor.name}`);
    }
    // Structure may be lost at these depths; text may not.
    const got = wordsOf(view.replace(/\[[^\]]*\]/g, " "));
    for (const w of ["hello", "apple", "pear", "bar", "chart", "ada"]) {
      assert.ok(got.has(w), `depth ${depth}: lost "${w}" from the view:\n${view.slice(0, 200)}`);
    }
    // Not doubled: the recursive attempt dies mid-document, and its partial lines have to
    // be discarded rather than prepended to the pass that replaces them.
    assert.equal(view.match(/apple/g)?.length, 1, `depth ${depth}: partial output was repeated`);
  }
});

test("the coverage gate still measures dropped content at fallback depth", () => {
  // The fallback would be worthless if it fixed the throw and broke the measurement:
  // structure-free output that scores every candidate 1.0 is the silent-success failure
  // in the header, just reached by a different route. A word missing from the candidate
  // must still register as missing when the page is deep enough to take the fallback.
  const deep = "<div>".repeat(6000);
  const accepted = `${deep}<p>alpha bravo charlie delta echo foxtrot golf hotel india</p>`;
  assert.equal(contentCoverage(accepted, accepted), 1, "identical deep documents must score 1.0");

  // One word of nine missing: detected at all. It scores 0.889, which is ABOVE the 0.85 bar
  // by design — the gate tolerates small differences, and asserting otherwise here would be
  // asserting a threshold this test does not own.
  const one = contentCoverage(accepted, `${deep}<p>alpha bravo charlie delta echo foxtrot golf hotel</p>`);
  assert.ok(one !== null && one < 1, `a dropped word went unmeasured at fallback depth: scored ${one}`);

  // Enough missing to actually fail the gate, which is the property that matters: the
  // fallback must not merely register a difference but let a real regression be blocked.
  const many = contentCoverage(accepted, `${deep}<p>alpha bravo charlie delta</p>`);
  assert.ok(
    many !== null && many < MIN_CONTENT_COVERAGE,
    `losing five words of nine must fail the ${MIN_CONTENT_COVERAGE} bar, but scored ${many}`,
  );
});

test("a decorative image is distinguished from a missing alt", () => {
  // alt="" is correct markup for a decorative image; a missing alt is a defect. The
  // Reader is told to treat only the second as one, so they must not flatten alike.
  assert.match(flatten(`<img src="x.png">`), /\[alt missing\]/);
  assert.doesNotMatch(flatten(`<img src="x.png" alt="">`), /\[alt missing\]/);
  assert.match(flatten(`<img src="x.png" alt="">`), /decorative/);
  assert.match(flatten(`<img src="x.png" alt="Bar chart">`), /\[Image alt\] Bar chart/);
});
