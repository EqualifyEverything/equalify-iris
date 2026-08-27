import { test } from "node:test";
import assert from "node:assert/strict";
import { markupReport } from "../src/pipeline/markup.ts";

// The delivered document's own structure (#240) — the two questions axe cannot be asked,
// because it lints a tree the parser has already repaired.

test("an unclosed table is reported on the bytes, where the evidence still is", () => {
  // The bench case, reduced: 16 `<table>` opens and 15 closes in one delivered document,
  // `final_lint.ok: true`, zero violations. The parser closes the open table implicitly when
  // the next `<table>` starts, so by the time axe sees it there is nothing wrong.
  const html = `<table><tr><td>a</td></tr><table><tr><td>b</td></tr></table>`;
  const report = markupReport(html);
  assert.deepEqual(report.unbalanced, [{ element: "table", open: 2, close: 1 }]);
  // And the recovery really is clean, which is the other half of the finding: two tables, not
  // one nested in the other, so a reader loses nothing to the tag itself.
  assert.equal(report.tables, 2);
  assert.equal(report.tablesWithoutBody, 0);
});

test("a stray end tag counts too, in the other direction", () => {
  // The parser discards it, so it costs a reader nothing — but the model's picture of the
  // document and the document still disagree, and one direction is as much a symptom as the
  // other. Reporting only `open > close` would have hidden half the class.
  assert.deepEqual(markupReport(`<ul><li>a</li></ul></ul>`).unbalanced, [{ element: "ul", open: 1, close: 2 }]);
});

test("an element whose end tag HTML makes optional is not a defect", () => {
  // The one substantive narrowing of the issue's proposal, and the reason for it: every one of
  // these is CORRECT markup that a naive balance check calls broken. Reporting them would bury
  // the real finding under legal output and teach whoever reads the line to skip it.
  const legal = [
    `<ul><li>a<li>b</ul>`,
    `<table><tr><td>a<td>b</table>`,
    `<table><thead><tr><th>h</thead><tbody><tr><td>d</table>`,
    `<p>one<p>two`,
    `<dl><dt>term<dd>definition</dl>`,
    `<select><option>a<option>b</select>`,
  ];
  for (const html of legal) {
    assert.deepEqual(markupReport(html).unbalanced, [], `reported legal markup as unbalanced: ${html}`);
  }
});

test("comments are stripped first, or every count is noise", () => {
  // Not a refinement — the delivered document carries the `@unresolved` list and the other `@`
  // markers, which are model-written prose ABOUT the document and quote markup freely. Measured
  // on the bench round, the raw bytes of a document with nothing wrong read `table 25/19`.
  const html = `<!-- @unresolved: the <table> on page 4 is missing its </table> --><table><tr><td>a</td></tr></table>`;
  assert.deepEqual(markupReport(html).unbalanced, []);
});

test("a tag name is matched whole, not as a prefix", () => {
  // `<tablet>` is not a `<table>`, and `<article>` must not be counted as an `<a>`. Both would
  // be permanent phantom imbalances on documents that have neither element.
  assert.deepEqual(markupReport(`<tablet></tablet>`).unbalanced, []);
  assert.deepEqual(markupReport(`<article>text</article>`).unbalanced, []);
  // And `<a>` itself is still counted, since an unclosed link swallows the text up to the next
  // one into its anchor text.
  assert.deepEqual(markupReport(`<p><a href="#x">one<a href="#y">two</a></p>`).unbalanced, [
    { element: "a", open: 2, close: 1 },
  ]);
});

test("a table with a header block and no rows under it is what survives the parser", () => {
  // The defect the parser cannot repair, because nothing is malformed: a caption, a two-row
  // header block naming nine columns, and no body. A screen reader announces the table, reads
  // the caption and every header, and there is nothing in it. axe has no rule for this —
  // `empty-table-header` is about a header CELL with no text.
  const html =
    `<table><caption>Table 15.—Estimated Yield, by State—Continued</caption>` +
    `<thead><tr><th scope="col">State</th><th scope="col">Total</th></tr></thead></table>` +
    `<table><caption>Table 16</caption><tr><td>real data</td></tr></table>`;
  const report = markupReport(html);
  assert.equal(report.tables, 2);
  assert.equal(report.tablesWithoutBody, 1);
  assert.deepEqual(report.emptyTableCaptions, ["Table 15.—Estimated Yield, by State—Continued"]);
  // Well-formed throughout, so the other half of the check says nothing — which is the point:
  // one document had both defects and either can occur without the other.
  assert.deepEqual(report.unbalanced, []);
});

test("a table whose body cells are all row headers is not empty", () => {
  // Why the test is "no row outside the header block" and not the issue's "no `<td>`". A table
  // whose every body cell is a `<th scope="row">` is legal and full of content, and counting
  // `<td>` would report it as an empty table on every document that has one.
  const html =
    `<table><thead><tr><th scope="col">Region</th></tr></thead>` +
    `<tbody><tr><th scope="row">Northeast</th></tr><tr><th scope="row">South</th></tr></tbody></table>`;
  assert.equal(markupReport(html).tablesWithoutBody, 0);
});

test("a nested table's rows do not rescue the table containing it", () => {
  // The mirror error, and the reason the row selector is scoped: a descendant search would find
  // the inner table's rows through the outer table's header block and call the outer one full.
  // Here the outer table's only row IS the one holding the nested table, so it is not empty; the
  // shape being pinned is that the two are counted separately at all.
  const html = `<table><thead><tr><th>outer</th></tr></thead><tbody><tr><td><table><tr><td>inner</td></tr></table></td></tr></tbody></table>`;
  const report = markupReport(html);
  assert.equal(report.tables, 2);
  assert.equal(report.tablesWithoutBody, 0);
  // And an empty OUTER table with a full inner one in its header is the case that would slip
  // through an unscoped search. It cannot occur through `<thead>` alone, so the check is on the
  // scoping itself: an empty table stays empty however deep the document around it is.
  const stub = `<table><caption>stub</caption><thead><tr><th>h</th></tr></thead></table>`;
  assert.equal(markupReport(`<div><section>${stub}</section></div>`).tablesWithoutBody, 1);
});

test("a tfoot row is a body row, because a reader can reach it", () => {
  const html = `<table><thead><tr><th>h</th></tr></thead><tfoot><tr><td>total</td></tr></tfoot></table>`;
  assert.equal(markupReport(html).tablesWithoutBody, 0);
});

test("a table with no rows at all is reported, with a caption that says so", () => {
  assert.deepEqual(markupReport(`<table></table>`).emptyTableCaptions, ["(no caption)"]);
});

test("a clean document reports nothing to say", () => {
  // What the orchestrator's "log only when something is wrong" test rests on: the ordinary
  // document must produce an empty report, or the log line appears on every run and stops
  // being read.
  const html =
    `<section><h1>Title</h1><ul><li>one</li><li>two</li></ul>` +
    `<table><caption>T</caption><thead><tr><th scope="col">a</th></tr></thead>` +
    `<tbody><tr><td>1</td></tr></tbody></table></section>`;
  const report = markupReport(html);
  assert.deepEqual(report.unbalanced, []);
  assert.equal(report.tablesWithoutBody, 0);
  assert.equal(report.tables, 1);
  assert.equal(report.parseError, undefined);
});
