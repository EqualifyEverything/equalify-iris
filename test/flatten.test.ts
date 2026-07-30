import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { flatten } from "../src/pipeline/flatten.ts";
import { contentCoverage, MIN_CONTENT_COVERAGE } from "../src/pipeline/feedback.ts";

// `flatten` has one invariant: it may reorganize text, but it may not LOSE any.
// Both of its consumers fail silently when it does.
//
//   * The Reader reviews this view instead of the source images (§7.8), so
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
function announcedWords(html: string): Set<string> {
  const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`);
  const doc = dom.window.document;
  const parts: string[] = [];
  const walk = (n: Node): void => {
    if (n.nodeType === 3) {
      parts.push(n.textContent ?? "");
      return;
    }
    for (const c of Array.from(n.childNodes)) walk(c);
  };
  walk(doc.body);
  for (const el of Array.from(doc.querySelectorAll("[alt],[placeholder],[value]"))) {
    for (const a of ["alt", "placeholder", "value"]) parts.push(el.getAttribute(a) ?? "");
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
    ["deeply nested inline", `<p>A <span>b <strong>c <em>d</em></strong></span> e</p>`],
    ["definition list", `<dl><dt>Term</dt><dd>Meaning</dd></dl>`],
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
  assert.match(flatten(`<img src="x.png">`), /\(missing\)/, "a missing alt must be announced as missing");
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
  assert.match(view, /\[Field input\]/);
  assert.match(view, /email/);
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
  assert.match(flatten(`<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>`), /2 rows, 2 columns/);
  assert.match(flatten(`<table><caption>Cap</caption></table>`), /0 rows, 0 columns/);
});

test("an empty cell is announced rather than silently collapsing the row", () => {
  // Otherwise "A | | C" and "A | C" flatten identically, and a dropped cell — a
  // real extraction failure — is invisible.
  const view = flatten(`<table><tr><td>A</td><td></td><td>C</td></tr></table>`);
  assert.match(view, /A \| \(empty\) \| C/);
});
