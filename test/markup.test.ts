import { test } from "node:test";
import assert from "node:assert/strict";
import { markupReport } from "../src/pipeline/markup.ts";
import { runAxe } from "../src/pipeline/lint.ts";
import { wrapDocument } from "../src/pipeline/assembly.ts";

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

test("a comment nobody closed runs to the end, because that is what the parser does", () => {
  // Stopping at `-->` only would strip nothing here, and then every `<table>` quoted inside the
  // marker is counted as real markup — a document whose bytes are fine reporting `table 2/1`,
  // which is the one failure that would make these counts worth ignoring. `wrapDocument` always
  // closes its markers, so reaching this takes a stray `<!--` in model body text; the point is
  // that when it happens the check goes quiet rather than wrong.
  const html = `<table><tr><td>a</td></tr></table><!-- @unresolved: the <table> on page 4 never closes`;
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

test("a header-only table written without a thead is still a header-only table", () => {
  // The shape the check would otherwise miss entirely, and it is the likely one: the parser drops
  // a bare `<tr><th scope="col">` into the implicit `<tbody>`, so a row of column headers reads as
  // a body row. To a reader this is the same defect as the `<thead>` version — caption and column
  // headers announced, nothing under them — and a page agent writes it precisely when it has
  // drifted from the prompt's `<caption>`/`<thead>`/`<th scope>` instruction, i.e. on the runs
  // where the defect appears at all.
  const html = `<table><caption>Table 4. Yield</caption><tr><th scope="col">State</th><th scope="col">Total</th></tr></table>`;
  const report = markupReport(html);
  assert.equal(report.tablesWithoutBody, 1);
  assert.deepEqual(report.emptyTableCaptions, ["Table 4. Yield"]);
  // One row of headers and one of data is an ordinary table, header block or not.
  assert.equal(
    markupReport(`<table><tr><th scope="col">State</th></tr><tr><td>TX</td></tr></table>`).tablesWithoutBody,
    0,
  );
});

test("a declared thead is taken at its word, so an unscoped th below it is content", () => {
  // The limit of the rule above, deliberately: a table that said where its header ends is not
  // second-guessed. Without this, a body row of `<th>` cells with no `scope` — legal, if not what
  // the prompt asks for — would read as a second header block and the table would report empty
  // while a reader gets both rows.
  const html = `<table><thead><tr><th scope="col">Region</th></tr></thead><tbody><tr><th>Northeast</th></tr></tbody></table>`;
  assert.equal(markupReport(html).tablesWithoutBody, 0);
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
  // And nothing from the four structural classes either, for the same reason: the whole
  // `delivered_structure` line is gated on one of them having fired.
  assert.deepEqual(counts(report), { idrefs: 0, dl: 0, lang: 0, landmarks: 0 });
});

// The four structural defect classes of #255 — decidable from the delivered HTML, and reported by
// no rule in the gate. Each test that says "the gate is clean on this" checks it rather than
// asserting it: `runAxe` on the same document, through the real config, so the day axe starts
// reporting one of these the suite says so instead of the check quietly becoming redundant.

const counts = (report: ReturnType<typeof markupReport>) => ({
  idrefs: report.structure.danglingIdrefs.count,
  dl: report.structure.dlWithoutDd.count,
  lang: report.structure.langOnVoid.count,
  landmarks: report.structure.emptyLandmarks.count,
});

test("an id reference that names nothing is counted, and the gate is clean on all three", async () => {
  // The three attributes whose whole function is to name another element. Each of these promises a
  // name and delivers none: the reference resolves to nothing, so the accessible-name computation
  // yields nothing and the element ships unnamed.
  const body =
    `<h1>Title</h1>\n<p>Body text.</p>\n` +
    `<img src="a.png" alt="A chart" aria-labelledby="chart-note">\n` +
    `<p aria-describedby="footnote-3">A paragraph.</p>\n` +
    `<label for="q1">Name</label>\n<input id="real" type="text" aria-label="Name">`;
  const report = markupReport(wrapDocument(body));
  assert.equal(report.structure.danglingIdrefs.count, 3);
  assert.deepEqual(report.structure.danglingIdrefs.examples, [
    `img[aria-labelledby=chart-note]`,
    `p[aria-describedby=footnote-3]`,
    `label[for=q1]`,
  ]);
  // Why the check exists rather than a promoted rule or an axe filter: the gate says nothing at
  // all here. The two ARIA attributes land in `incomplete` (`aria-valid-attr-value` is
  // `reviewOnFail`), and `<label for>` reaches the `label` rule only when the input has no other
  // name — this one has `aria-label`, so that rule passes too.
  const lint = await runAxe(wrapDocument(body));
  assert.equal(lint.error, undefined);
  assert.deepEqual(lint.violations, [], "the gate now reports these, so read this check again");
});

test("a reference that resolves on another page is not dangling, which is why this runs on the join", async () => {
  // The distinction that makes this a delivered-document check and not the fragment-level one the
  // bench ran: a page agent writes one page at a time, so a reference to an id defined on page 40
  // is correct in the document those pages join into. The same argument the issue makes for NOT
  // checking `href="#x"` at fragment scope applies to these three attributes — at this scope it
  // holds either way.
  const joined =
    `<p>Page one.</p>\n<hr role="doc-pagebreak" aria-label="Page 2">\n` +
    `<h2 id="appendix-a">Appendix A</h2>\n<p aria-describedby="appendix-a">Refers forward.</p>`;
  assert.equal(markupReport(wrapDocument(joined)).structure.danglingIdrefs.count, 0);

  // A token list is read a token at a time, because one resolving reference does not excuse the
  // rest: this element is named by half of what it asked for.
  const half = `<h2 id="h2">Heading</h2>\n<p aria-labelledby="h2 subtitle">Text.</p>`;
  const report = markupReport(wrapDocument(half));
  assert.equal(report.structure.danglingIdrefs.count, 1);
  assert.deepEqual(report.structure.danglingIdrefs.examples, [`p[aria-labelledby=subtitle]`]);

  // And `for` is an id reference on a `<label>` and nowhere else. A `<div for="x">` is not a
  // reference at all, and reading it as one would manufacture a finding out of nothing.
  assert.equal(markupReport(wrapDocument(`<div for="nope">Text.</div>`)).structure.danglingIdrefs.count, 0);

  // `headers` is the fourth id reference the pipeline treats as load-bearing (anchors.ts renames its
  // tokens alongside the ids) and the one attribute deliberately left out of this check, because
  // unlike the three above the GATE reports it: `td-headers-attr` is wcag2a/wcag131, so it passes
  // the lint's tag filter and a dangling `headers` is a violation the review loop already acts on.
  // Pinned rather than argued: if that ever stops being true, this check has a gap.
  const headers = wrapDocument(
    `<table><caption>T</caption><tr><th scope="col" id="h1">H</th></tr><tr><td headers="nope">1</td></tr></table>`,
  );
  assert.deepEqual((await runAxe(headers)).violations?.map((v) => v.id), ["td-headers-attr"]);
  assert.equal(markupReport(headers).structure.danglingIdrefs.count, 0);
});

test("a term list with no definitions is counted, including the shape axe passes", async () => {
  // The bare shape IS reported by the gate — `definition-list`, serious, wcag2a via 1.3.1 — so on
  // this one the check duplicates it.
  const bare = wrapDocument(`<p>Body text.</p>\n<dl><dt>Term one</dt><dt>Term two</dt></dl>`);
  assert.equal(markupReport(bare).structure.dlWithoutDd.count, 1);
  assert.deepEqual(markupReport(bare).structure.dlWithoutDd.examples, ["dl(2 dt, 0 dd)"]);
  assert.deepEqual((await runAxe(bare)).violations?.map((v) => v.id), ["definition-list"]);

  // And this is the shape it is here for. HTML allows a `<div>` between a `<dl>` and its
  // `<dt>`/`<dd>` groups, and axe's rule passes as soon as one is present — measured, a clean
  // lint on a list of terms with every definition missing.
  const wrapped = wrapDocument(`<p>Body text.</p>\n<dl><div><dt>Term one</dt></div></dl>`);
  assert.deepEqual((await runAxe(wrapped)).violations, [], "axe now sees this, so read this check again");
  assert.equal(markupReport(wrapped).structure.dlWithoutDd.count, 1);

  // A complete list is not a finding in either shape.
  assert.equal(markupReport(wrapDocument(`<dl><dt>Term</dt><dd>Meaning.</dd></dl>`)).structure.dlWithoutDd.count, 0);
  assert.equal(
    markupReport(wrapDocument(`<dl><div><dt>Term</dt><dd>Meaning.</dd></div></dl>`)).structure.dlWithoutDd.count,
    0,
  );
});

test("a nested term list's terms belong to the list they are in", () => {
  // The mirror of the nested-table scoping above, and the reason the search is not a plain
  // descendant one: the inner list's `<dd>` must not answer for the outer list's terms.
  const outerIncomplete = `<dl><dt>Outer term</dt><div><dl><dt>Inner</dt><dd>Inner meaning.</dd></dl></div></dl>`;
  const report = markupReport(wrapDocument(outerIncomplete));
  assert.equal(report.structure.dlWithoutDd.count, 1);
  assert.deepEqual(report.structure.dlWithoutDd.examples, ["dl(1 dt, 0 dd)"], "the outer list, one term");

  // And the other way round: a complete outer list containing an incomplete inner one is one
  // finding, the inner one.
  const innerIncomplete = `<dl><dt>Outer</dt><dd>Meaning, with <dl><dt>Inner term</dt></dl> in it.</dd></dl>`;
  assert.equal(markupReport(wrapDocument(innerIncomplete)).structure.dlWithoutDd.count, 1);
});

test("lang on an element that holds no text is waste, and nothing else in the pipeline sees it", async () => {
  // Legal markup — `lang` is a global attribute — so there is nothing for axe to fail, and the
  // gate is right to be quiet. It is counted because of where it comes from: the page contract's
  // language rule applied by rote (#252). The 9 of 108 bench answers that figure comes from is the
  // count under "any `lang` on a void element"; by the narrower rule this test pins below, it is 0
  // of those answers and 1 across the corpus's 34 delivered documents (#268). Rote `lang="en"` is
  // the frequent thing, and the part of it that reaches no text at all is what this reports.
  const body = `<p>Body text.</p>\n<img src="a.png" alt="" lang="fr">\n<hr lang="de">\n<p>More.<br lang="es"></p>`;
  const report = markupReport(wrapDocument(body));
  assert.equal(report.structure.langOnVoid.count, 3);
  assert.deepEqual(report.structure.langOnVoid.examples, ["img[lang=fr]", "hr[lang=de]", "br[lang=es]"]);
  assert.deepEqual((await runAxe(wrapDocument(body))).violations, [], "a rule now covers this, so read it again");

  // The same attribute on elements that DO hold text is the rule being followed, not broken — and
  // the shell's own `<html lang>` and labelled `<title>` must never be counted, or every
  // non-English document would report two findings for being correct.
  const legitimate = markupReport(wrapDocument(`<p lang="fr">Bonjour.</p>\n<span lang="de">Guten Tag</span>`));
  assert.equal(legitimate.structure.langOnVoid.count, 0);

  // And the case that makes this a narrower check than "a `lang` on a void element": HTML scopes
  // `lang` to the element's contents AND its text-bearing attributes, so the language of an
  // accessible name computed from `alt` comes from here. `<img alt="Un graphique" lang="fr">` in an
  // English document is correct authoring, and counting it would ask a maintainer for a prompt
  // change that strips correct language markup off every non-English figure. Same for the text an
  // `<input>` or a `<track>` carries in an attribute.
  const named = markupReport(
    wrapDocument(
      `<p>Body.</p>\n<img src="a.png" alt="Un graphique" lang="fr">\n` +
        `<input readonly value="Dupont" lang="fr">\n<img src="b.png" alt="" aria-label="Un logo" lang="fr">`,
    ),
  );
  assert.equal(named.structure.langOnVoid.count, 0, "a language on text a reader receives is not waste");
});

test("an empty nav or aside is an announced region with nothing in it; an unnamed section is not", () => {
  // `<nav>` and `<aside>` are landmarks named or not, so a reader is offered them in the landmark
  // list, jumps, and arrives at nothing.
  const report = markupReport(wrapDocument(`<p>Body text.</p>\n<nav></nav>\n<aside>   </aside>`));
  assert.equal(report.structure.emptyLandmarks.count, 2);
  assert.deepEqual(report.structure.emptyLandmarks.examples, ["nav", "aside"]);

  // A `<section>` is exposed as a `region` only when it has an accessible name. An unnamed empty
  // one is a generic container no reader is offered and none can land in — nothing is announced,
  // so nothing is lost, and counting it would report every stray wrapper in the document.
  assert.equal(markupReport(wrapDocument(`<p>Text.</p><section></section>`)).structure.emptyLandmarks.count, 0);
  assert.equal(
    markupReport(wrapDocument(`<p>Text.</p><section aria-label="Notes"></section>`)).structure.emptyLandmarks.count,
    1,
  );
  assert.equal(
    markupReport(wrapDocument(`<h2 id="n">Notes</h2><section aria-labelledby="n"></section>`)).structure.emptyLandmarks
      .count,
    1,
  );
});

test("a name that resolves to nothing is not a name, so that section is one finding and not two", () => {
  // The interaction between two of the four checks, stated because both readings look defensible:
  // `<section aria-labelledby="nope">` is not announced as a region at all, so the defect is the
  // dead reference and nothing else. Counting it twice would make one mistake look like two.
  const report = markupReport(wrapDocument(`<p>Text.</p>\n<section aria-labelledby="nope"></section>`));
  assert.deepEqual(counts(report), { idrefs: 1, dl: 0, lang: 0, landmarks: 0 });
});

test("empty means empty to a reader, not empty of nodes", () => {
  // A region holding an image holds content: the image has alt text, and a reader who lands there
  // is given it. Same for a table or a form field.
  assert.equal(
    markupReport(wrapDocument(`<p>Text.</p><aside><img src="a.png" alt="A chart"></aside>`)).structure.emptyLandmarks
      .count,
    0,
  );
  // Every form field a reader can land in and operate, not only `<input>`. Nothing in the pipeline
  // emits a `<textarea>` or a `<select>` today — the page contract's fill-in block asks for
  // `<input readonly value>` — so this is the list being right in advance rather than in response
  // to a delivered document, and the reason it is worth pinning is that this class reaches a rate:
  // an unnoticed gap here is a false finding in `structural_defect_rate`, not just a log line.
  for (const field of [`<textarea readonly></textarea>`, `<select><option></option></select>`]) {
    assert.equal(
      markupReport(wrapDocument(`<p>Text.</p><section aria-label="Signature">${field}</section>`)).structure
        .emptyLandmarks.count,
      0,
      field,
    );
  }
  // A page-break marker is not content. A region holding nothing but furniture is the defect
  // itself, not an exception to it — which is why `<hr>` is not in the list above.
  assert.equal(
    markupReport(wrapDocument(`<p>Text.</p><nav><hr role="doc-pagebreak" aria-label="Page 3"></nav>`)).structure
      .emptyLandmarks.count,
    1,
  );
});

test("markup quoted in an @ marker is a comment, not an element", () => {
  // Where these four differ from the balance scan above, and the reason they need no stripping of
  // their own: the `@unresolved` list is model-written prose that quotes markup freely, and the
  // balance count had to be taught to ignore it. A parser does that already — a comment holds no
  // elements — so a `<nav></nav>` written inside one is reachable by no selector here.
  const report = markupReport(
    wrapDocument(`<p>Body text.</p>`, {
      unresolved: [`An empty <nav></nav> and an <img lang="fr"> and a <dl><dt>term</dt></dl>, described in prose`],
    }),
  );
  assert.deepEqual(counts(report), { idrefs: 0, dl: 0, lang: 0, landmarks: 0 });
});

test("the instances are bounded and cut, because they are text out of a user's document", () => {
  // Same bound and the same reason as the empty-table captions and the lint's malformed attribute
  // names: an exact count, and enough of the instances to recognise the class.
  const long = "x".repeat(80);
  const body =
    `<p>Body text.</p>\n` +
    [...Array(7)].map((_, i) => `<p aria-describedby="note-${i}">Paragraph ${i}.</p>`).join("\n") +
    `\n<p aria-labelledby="${long}">Last.</p>`;
  const idrefs = markupReport(wrapDocument(body)).structure.danglingIdrefs;
  assert.equal(idrefs.count, 8, "the count is every instance, not the length of the examples");
  assert.equal(idrefs.examples.length, 5);
  assert.deepEqual(idrefs.examples[0], "p[aria-describedby=note-0]");
  // And the cut, on the one field where a value can be arbitrarily long.
  const cut = markupReport(wrapDocument(`<p aria-labelledby="${long}">Only.</p>`)).structure.danglingIdrefs.examples[0];
  assert.equal(cut?.length, 41, "40 characters and the ellipsis that says there was more");
  assert.match(cut ?? "", /…$/);
});

test("a document whose parse threw reports zeros that are not a clean bill of health", () => {
  // The same distinction `parseError` already makes for the table counts (#164). Four zeros beside
  // a `parse_error` mean the checks never ran; four zeros without one mean the document is clean.
  const deep = `<div>`.repeat(9000);
  const report = markupReport(deep);
  if (report.parseError === undefined) return; // more stack headroom here than the parse needs
  assert.deepEqual(counts(report), { idrefs: 0, dl: 0, lang: 0, landmarks: 0 });
});
