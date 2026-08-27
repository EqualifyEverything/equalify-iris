import { JSDOM, VirtualConsole } from "jsdom";

// Two questions about the delivered document that the lint gate structurally cannot ask
// (#240).
//
// axe lints a PARSED DOM, and an HTML parser's whole job is to turn malformed markup into a
// well-formed tree before anything downstream sees it. So a document delivered with an
// unclosed `<table>` reaches axe as sixteen tidy tables, and by the time a rule could fire
// the evidence has been repaired away. Measured on one bench round, a document shipped with
// `table 16/15` — sixteen `<table>` start tags, fifteen end tags — and reported
// `final_lint.ok: true`, `violations: []`, `ready_for_review`.
//
// What the parser cannot repair is content that is not there. The same document held a table
// with a caption, a two-row header block naming nine columns, and no rows: a screen reader
// announces the table, reads the caption and the headers, and there is nothing in it. axe has
// no rule for that either — `empty-table-header` is about a header CELL with no text — so
// zero violations was the honest answer to the question axe was asked.
//
// Both checks therefore run here, on the delivered bytes, and both are measurement only:
// nothing is repaired and no run is failed. A count with no threshold is deliberate for the
// same reason it was for #234 — one document of four in one round is a class worth seeing, not
// a rate anyone can calibrate yet.

// Elements whose end tag HTML requires, so an open/close mismatch in the source is a real
// defect rather than a legal shorthand.
//
// This is the list the issue proposed minus everything with an OPTIONAL end tag, which is the
// one substantive narrowing. `<tbody>`, `<thead>`, `<tr>`, `<td>`, `<th>`, `<li>`, `<p>`,
// `<dt>`, `<dd>`, `<caption>`, `<option>` and `<colgroup>` may all be closed implicitly by the
// next tag, so `<ul><li>a<li>b</ul>` is CORRECT markup that a naive balance check calls
// `li 2/0`. Reporting that would bury the one real finding under legal output — and worse,
// train whoever reads the line to ignore it.
//
// Restricted further to elements that carry structure a reader depends on, or whose imbalance
// silently swallows content. `<span>`/`<em>`/`<strong>` are left out: their end tags are
// required too, but an unclosed one costs formatting rather than structure, and the delivered
// documents are full of them, so including them widens the surface for no gain. Measured on
// the same bench round, this set and the wider one both report exactly `table 16/15`.
//
// `<a>` is in. An unclosed link is a structural defect a reader meets directly — the parser
// closes it at the next `<a>`, so the anchor text becomes everything up to the following link.
const BALANCED_ELEMENTS = [
  "table",
  "ul",
  "ol",
  "dl",
  "section",
  "article",
  "aside",
  "nav",
  "main",
  "header",
  "footer",
  "figure",
  "figcaption",
  "blockquote",
  "form",
  "fieldset",
  "details",
  "div",
  "label",
  "a",
];

export interface MarkupReport {
  // Elements whose start and end tag counts differ in the delivered source, in the order
  // above. Both directions: `open > close` is content the parser had to rescue, `close > open`
  // is a stray end tag it discarded, and either says the model's picture of the document's
  // structure and the document's own disagree.
  unbalanced: { element: string; open: number; close: number }[];
  // Tables in the PARSED document — what a reader's browser really gets, after recovery —
  // and how many of them have no row outside their `<thead>`.
  tables: number;
  tablesWithoutBody: number;
  // The captions of those tables, trimmed, so a maintainer knows which table to look at
  // without opening the document. Content from the user's file, so this stays in the run log
  // and never reaches the tally (see QualityStats).
  emptyTableCaptions: string[];
  // Set when the parse itself threw, in which case the two table numbers are zero because
  // they were never measured — not because the document is clean. The balance scan does not
  // need a parse and is filled in either way.
  parseError?: string;
}

// Start and end tag counts for one element name, over source with comments already removed.
//
// `(?=[\s/>])` after the name so `<table` does not match `<tablesomething`, and an end tag
// allows trailing whitespace because `</table >` is what the spec accepts.
//
// A `/` before the `>` is deliberately NOT treated as self-closing. In HTML it is ignored for
// these elements — `<div/>` opens a div and nothing closes it — so counting it as an open is
// the correct reading, and the exception is foreign content, where `<a/>` inside an `<svg>`
// really does self-close. A page agent emitting inline SVG with a self-closed `<a>` in it
// would be over-reported here; nothing is thresholded on this, and the alternative is
// tracking foreign-content boundaries in a regex.
function countTags(text: string, element: string): { open: number; close: number } {
  return {
    open: text.match(new RegExp(`<${element}(?=[\\s/>])`, "gi"))?.length ?? 0,
    close: text.match(new RegExp(`</${element}\\s*>`, "gi"))?.length ?? 0,
  };
}

// A table's rows that are not part of its header block, and only its own — `:scope` rather
// than a descendant search, or a nested table's rows would count as the outer table's body
// and an empty outer table would report as full.
//
// `<tbody>` is in the selector because the parser inserts one whether or not the source did,
// and `<tfoot>` because a footer row is content a reader can reach.
function bodyRowCount(table: Element): number {
  return table.querySelectorAll(":scope > tr, :scope > tbody > tr, :scope > tfoot > tr").length;
}

// What the delivered bytes say about their own structure.
export function markupReport(html: string): MarkupReport {
  // Comments first, and this is not optional: the delivered document carries the `@unresolved`
  // list and the other `@` markers, which are model-written prose ABOUT the document and quote
  // markup freely. Counting a `<table>` inside one puts the balance check permanently off by
  // an unpredictable amount — measured, the raw bytes of that bench round report `table 25/19`
  // on a document whose real imbalance is nothing at all, and the one genuinely broken document
  // reports `19/15` instead of `16/15`. Every number here would have been noise.
  const text = html.replace(/<!--[\s\S]*?-->/g, " ");
  const unbalanced: MarkupReport["unbalanced"] = [];
  for (const element of BALANCED_ELEMENTS) {
    const { open, close } = countTags(text, element);
    if (open !== close) unbalanced.push({ element, open, close });
  }

  // The table half needs the tree, because the whole point is what survives recovery. Its own
  // parse, not the lint step's: that one is handed the document WITHOUT the `@` markers
  // (review.ts wraps twice), and this runs on the delivered file.
  //
  // Allowed to fail without failing the run. A document is already written by the time this is
  // called, and a check that cannot run must be distinguishable from a check that found
  // nothing (#164) — hence `parseError` rather than a silent zero.
  let tables = 0;
  let tablesWithoutBody = 0;
  const emptyTableCaptions: string[] = [];
  let dom: JSDOM | undefined;
  try {
    dom = new JSDOM(html, { virtualConsole: new VirtualConsole() });
    for (const table of dom.window.document.querySelectorAll("table")) {
      tables++;
      if (bodyRowCount(table) > 0) continue;
      tablesWithoutBody++;
      const caption = table.querySelector(":scope > caption")?.textContent?.replace(/\s+/g, " ").trim();
      emptyTableCaptions.push(caption || "(no caption)");
    }
  } catch (err) {
    return { unbalanced, tables: 0, tablesWithoutBody: 0, emptyTableCaptions: [], parseError: String(err) };
  } finally {
    // Same allowed-to-fail cleanup as the lint gate's: `window.close()` recurses per level of
    // nesting, so a deep document can throw here, and a throw out of a `finally` would end a
    // session one step after the document was delivered.
    try {
      dom?.window.close();
    } catch {
      /* nothing to do about it, and nothing depending on it */
    }
  }
  return { unbalanced, tables, tablesWithoutBody, emptyTableCaptions };
}
