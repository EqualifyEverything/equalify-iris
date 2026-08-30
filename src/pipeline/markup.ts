import { JSDOM, VirtualConsole } from "jsdom";

// Questions about the delivered document that the lint gate structurally cannot ask
// (#240, #255).
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
//
// #255 adds four more of the same kind, from the other direction: bench rounds measured six
// models on the Feedback Agent's `verify` task against defects a script can PROVE are present,
// and in the tie-break between the three of those six still in contention, the best found 6 of 7
// instances at 5.72¢ a judgement — against 0.54¢ for the cheapest of the three, and $0 for the
// four checks below. These four are the ones no
// rule in the gate reports, each measured against this repo's own axe config before it was
// written (see each check for what the gate does and does not already say). They are structure,
// so they belong beside the two above rather than in the lint: they are decidable from the
// bytes, they cost one `querySelectorAll` each, and they are right by construction rather than
// by measurement — which is the whole argument for not paying a model to guess at them.
//
// Those judge figures are corrected ones (#268), and the correction runs AGAINST the argument
// they support. The published "6 of 11 at 5.76¢" had four instances in its denominator that were
// correct authoring — a `lang` on a void element carrying text in `alt`, which is exactly what
// TEXT_BEARING_ATTRIBUTES below excludes — and all three of that tie-break's judges were scored
// 0/4 for declining to report them. Correcting it moved every judge UP (6/7, 3/7, 2/7) and left
// the ranking alone, so
// a model is considerably better at this than the old number said. What remains is cost and
// certainty rather than a model being bad at the job, and that is enough on its own: these checks
// find every instance for nothing and are right by construction rather than on average. The 5.76¢
// was the round's pre-flight price estimate; 5.72¢ is what it spent, per judgement not per page.
//
// Three of the four reach the deployment-wide tally as one signal, `iris:structural-defect`, and
// `lang_on_void` deliberately does not: a language tag on an element holding no text is wasted
// output rather than something a reader loses, and folding it into a rate about harm would move
// that rate for the wrong reason. One signal rather than three because the rate answers one
// question — did this document ship promising a reader something absent — and which class it was
// is on the log line, where the elements are named (see SIGNAL_STRUCTURAL_DEFECT).
//
// Deliberately not here: the fifth check in that issue, a fragment emitting its own `<main>`.
// That one is fixed rather than counted — `landmarks.ts` takes it out of the body and two axe
// rules report what it cannot (#251, #256) — so counting it here would report a defect the
// pipeline no longer delivers. And dangling `href="#x"`, for the reason the issue itself gives:
// Iris resolves anchors across pages at assembly, so a fragment-level check cannot tell a
// forward reference from an invented one. The id-reference check below is not that check, and
// the difference is the scope: it runs on the JOINED document, where every page's ids exist.

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
  // Tables in the PARSED document — what a reader's browser really gets, after recovery — and
  // how many of them have no row a reader receives as content: no row outside a declared
  // `<thead>`, or, where none was declared, no row that is anything but column headers. A table
  // with no rows at all is counted too, and so is one that put its only data row inside its
  // `<thead>` — in both the reader is announced a table and given nothing under its headers,
  // which is the finding. It is deliberately not narrowed to "has a header block and no body":
  // an empty `<table></table>` is the same defect with less evidence about how it happened.
  tables: number;
  tablesWithoutBody: number;
  // The captions of those tables, trimmed, so a maintainer knows which table to look at
  // without opening the document. Content from the user's file, so this stays in the run log
  // and never reaches the tally (see QualityStats).
  emptyTableCaptions: string[];
  // The four structural defect classes of #255, each an exact count plus a few instances to find
  // them by. Always present, all four, even at zero — a line carrying `dangling_idrefs: 2` says
  // the other three classes were looked for in that document and are clean, which is the
  // distinction the count exists to make (#164, and the issue's own argument for reporting a
  // zero). All four are zero on an ordinary document, which is why the whole line is logged only
  // when one of them is not.
  structure: {
    danglingIdrefs: StructuralCount;
    dlWithoutDd: StructuralCount;
    langOnVoid: StructuralCount;
    emptyLandmarks: StructuralCount;
  };
  // Set when the parse itself threw, in which case the two table numbers and every structural
  // count are zero because they were never measured — not because the document is clean. The
  // balance scan does not need a parse and is filled in either way.
  parseError?: string;
}

export interface StructuralCount {
  // Every instance in the document, not the length of `examples`: the count is the incidence and
  // the examples are a locator.
  count: number;
  // Up to five of them, each written as the element and the attribute that made it a finding, so
  // a maintainer can find it with one search. Attribute values are content out of the user's own
  // document — an id a model invented, a language tag it applied — so they are cut short for the
  // same reason `emptyTableCaptions` stays on the run log and out of the tally.
  examples: string[];
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

// A row that holds nothing but column headers, which is what a header-only table's one row is
// when the model wrote no `<thead>` around it. `.every` on a row with no cells at all is true
// by the same reading: an empty `<tr>` is not content either.
//
// `scope="row"`/`"rowgroup"` is the carve-out and the reason this is not simply "every cell is
// a `<th>`": a table whose body cells are all `<th scope="row">` is legal and full of content,
// and calling those rows headers would report every such table as empty. That was the whole
// argument against the `<td>`-absence test, and it applies here too.
//
// The residual, worth knowing when the first real rate comes back: a table with no `<thead>`
// whose data cells are unscoped `<th>` reads as all headers and is over-reported. The carve-out
// covers the shape `agents/page.md` asks for, and an unscoped `<th>` data cell arrives on the
// same prompt drift that produces the defect this counts — so for a count with no threshold,
// over-reporting a table that has no data cell in it at all is the side to err on.
function isHeaderRow(row: Element): boolean {
  const cells = [...row.querySelectorAll(":scope > th, :scope > td")];
  return cells.every(
    (cell) => cell.tagName === "TH" && !/^row(group)?$/i.test(cell.getAttribute("scope") ?? ""),
  );
}

// A table's rows that a reader receives as content, and only its own — `:scope` rather than a
// descendant search, or a nested table's rows would count as the outer table's body and an
// empty outer table would report as full.
//
// `<tbody>` is in the selector because the parser inserts one whether or not the source did,
// and `<tfoot>` because a footer row is content a reader can reach.
//
// A table that declared a `<thead>` is taken at its word: it said where its header ends, so
// everything outside is content and nothing here second-guesses it. Only a table that declared
// no header block gets its rows inspected — the parser drops a bare `<tr><th scope="col">` into
// the implicit `<tbody>`, so without this a header-only table written without `<thead>` reads as
// a table with one body row. That is the same defect this exists to count, in the shape a page
// agent produces exactly when it has drifted from the prompt's `<caption>`/`<thead>`/`<th scope>`
// instruction — i.e. on the runs where it turns up.
function bodyRowCount(table: Element): number {
  const rows = [...table.querySelectorAll(":scope > tr, :scope > tbody > tr, :scope > tfoot > tr")];
  if (table.querySelector(":scope > thead")) return rows.length;
  return rows.filter((row) => !isHeaderRow(row)).length;
}

// How many instances are named on the log line, and how much of each. Same bound and the same
// reason as `emptyTableCaptions` and the lint's malformed names: this is content out of a user's
// document going into a log line, and five instances is enough to recognise a class.
const MAX_EXAMPLES = 5;
const MAX_EXAMPLE_CHARS = 40;

function counted(instances: string[]): StructuralCount {
  return {
    count: instances.length,
    examples: instances
      .slice(0, MAX_EXAMPLES)
      .map((i) => (i.length <= MAX_EXAMPLE_CHARS ? i : `${i.slice(0, MAX_EXAMPLE_CHARS)}…`)),
  };
}

// The elements that can hold no text NODES. Only the ones a document body can contain: `<meta>`,
// `<link>` and `<base>` are head-only, and the shell's head is not a page agent's output.
//
// Not the same thing as "no text": four of these carry text in an ATTRIBUTE instead, which is
// why the check below asks a second question rather than counting everything in this list.
const VOID_ELEMENTS = ["img", "br", "hr", "input", "area", "col", "embed", "source", "track", "wbr"];

// The attributes that carry text a reader receives, so a `lang` on the element around them is
// meaningful even though the element holds no text node. HTML scopes `lang` to "the element's
// contents AND any of the element's attributes that contain text", and the accessible name
// computed from `alt` (or `value`/`placeholder` on an `<input>`, `label` on a `<track>`) takes its
// language from here — which is what a screen reader switching voices reads.
//
// So `<img alt="Un graphique" lang="fr">` in an English document is correct authoring and is NOT
// counted. Counting it would be the opposite of the drift this check exists to find, and worse: a
// maintainer reading the number would be being asked for a prompt change that strips correct
// language markup off every non-English figure. An `alt=""` image is decorative, has no name to
// give a language to, and is still counted.
const TEXT_BEARING_ATTRIBUTES = ["alt", "value", "placeholder", "label", "aria-label", "title"];

// An id reference that names nothing in the delivered document, in the three attributes whose
// whole function is to name another element: `aria-labelledby`, `aria-describedby`, and `for` on
// a `<label>`. The reference resolves to nothing, so the accessible-name computation yields
// nothing and the element ends up unnamed — the defect is not the attribute, it is the missing
// name it promised.
//
// What the gate says about this today, measured on this repo's axe config before writing the
// check: the two ARIA attributes land in `incomplete` (`aria-valid-attr-value`, `reviewOnFail`)
// and never in `violations`, so the gate is CLEAN on `<img alt="A chart" aria-labelledby="nope">`
// and on `<p aria-describedby="nope">`. `<label for>` reaches the gate only through the `label`
// rule and therefore only when the input has no other name: a dangling `for` beside an
// `<input aria-label="Name">`, or with no input at all, is also clean.
//
// Not promoted into the gate the way `duplicate-id-aria` is, even though the question is just as
// decidable, because the rule is wider than the finding: `aria-valid-attr-value` is
// `reviewOnFail` for shapes that genuinely cannot be decided statically — `aria-controls` naming
// an element that appears on activation is the standard one — and promoting the rule id would
// fail runs on those. This check answers only the part that is decidable.
//
// The whole document, not a fragment. A page agent writes one page at a time and an id it
// references may belong to another page, which is legitimate in the document those pages join
// into — so a fragment-scope version of this check reports correct output as broken, exactly as
// it would for `href="#x"`. This runs after the join, where the reference either resolves or
// does not.
//
// `for` on `<output>` is an id reference too and is not looked at: nothing in this pipeline emits
// an `<output>`, and reading `for` on anything else — a `<div for="x">`, which is not a reference
// at all — would manufacture findings.
//
// `headers` on a `<td>` is the fourth id reference the pipeline treats as load-bearing
// (`anchors.ts` renames its tokens alongside the ids), and it is out of this check because the gate
// already reports it: `td-headers-attr` is `wcag2a`/`wcag131`, so it passes the lint's tag filter
// and a `headers` naming nothing is a violation the review loop acts on. That is exactly what the
// three attributes above are not.
function danglingIdrefs(document: Document): string[] {
  const ids = new Set([...document.querySelectorAll("[id]")].map((e) => e.getAttribute("id")));
  const out: string[] = [];
  // One pass over the elements rather than one per attribute, so the instances come out in
  // DOCUMENT order: these are a locator, and "the first five in the document" is what someone
  // reading the log line will go looking for.
  for (const element of document.querySelectorAll("[aria-labelledby], [aria-describedby], [for]")) {
    const name = element.tagName.toLowerCase();
    for (const attribute of REFERENCE_ATTRIBUTES) {
      if (attribute === "for" && name !== "label") continue;
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      // A token LIST, so one resolving reference does not excuse the rest: `aria-labelledby="h2
      // subtitle"` names two elements and gets half a name.
      for (const ref of value.split(/\s+/).filter(Boolean)) {
        if (!ids.has(ref)) out.push(`${name}[${attribute}=${ref}]`);
      }
    }
  }
  return out;
}

const REFERENCE_ATTRIBUTES = ["aria-labelledby", "aria-describedby", "for"];

// A `<dl>` holding terms and no definitions: every term in the list has had its meaning dropped.
// Invalid per the spec's content model as well, which is the part axe reports — `definition-list`
// (serious, wcag2a via 1.3.1) fires on `<dl><dt>Term</dt></dl>`, so the gate already sees the
// bare shape and this check duplicates it there.
//
// It is here for the shape the gate does NOT see. HTML permits a `<div>` between a `<dl>` and its
// `<dt>`/`<dd>` groups, and axe's rule passes as soon as one is present: measured,
// `<dl><div><dt>Term</dt></div></dl>` is a clean lint. So the search is for the `<dt>`/`<dd>`
// belonging to THIS list at any depth of wrapper, and `closest("dl")` is what keeps a nested
// list's own terms from being read as the outer list's definitions.
//
// Deliberately not the other direction: a `<dl>` with definitions and no terms is reported by
// the gate in every shape measured, and "a definition with no term" is a different defect from
// the one the issue is about.
function dlWithoutDd(document: Document): string[] {
  const out: string[] = [];
  for (const dl of document.querySelectorAll("dl")) {
    const own = (selector: string) =>
      [...dl.querySelectorAll(selector)].filter((e) => e.closest("dl") === dl);
    const terms = own("dt");
    if (terms.length && own("dd").length === 0) out.push(`dl(${terms.length} dt, 0 dd)`);
  }
  return out;
}

// `lang` on an element with no text at all — no text node, and nothing text-bearing in an
// attribute either (see TEXT_BEARING_ATTRIBUTES, which is the difference between this and "a `lang`
// on a void element"). Nothing a reader meets changes, which is why this is on its own line as
// waste rather than harm: the attribute declares the language of an element's text and the element
// has none, so no announcement, no voice and no verdict differs.
//
// Worth counting anyway because of where it comes from. It is a symptom of the page contract's
// language rule being applied by rote, and that rule's other failure mode is the expensive one: a
// `lang` the document does not need on elements that do have text, which changes how a screen
// reader pronounces them. This is the visible half of a prompt drift whose other half is invisible.
//
// The drift is commoner than this count will ever be, and the two must not be quoted for each
// other (#268). Read as "any `lang` on a void element", 9 of the bench's 108 page answers carry
// it, 8 of them from one model (#252) — and of the 55 such instances in its 34 delivered
// documents, 54 are `<img lang="en" alt="Meta logo">` and `<hr lang="en" aria-label="Page 33">`,
// which this check excludes on purpose. By the rule above the incidence is 0 of those 108 answers
// and 1 across those documents. Rote `lang="en"` is the frequent thing; what this line reports is
// the corner of it where the attribute reaches no text at all.
//
// No rule in the gate reports it, and correctly: `lang` is a global attribute, valid on every
// element including these, so the markup is legal and there is nothing for axe to fail.
function langOnVoid(document: Document): string[] {
  const out: string[] = [];
  for (const element of document.querySelectorAll(VOID_ELEMENTS.map((e) => `${e}[lang]`).join(", "))) {
    if (TEXT_BEARING_ATTRIBUTES.some((attribute) => element.getAttribute(attribute)?.trim())) continue;
    out.push(`${element.tagName.toLowerCase()}[lang=${element.getAttribute("lang")}]`);
  }
  return out;
}

// A landmark a screen reader announces with nothing inside it: the reader is offered a region in
// the landmark list, jumps to it, and arrives at nothing.
//
// `<nav>` and `<aside>` are landmarks whether or not they are named, so an empty one is always
// this defect. A `<section>` is not: it is exposed as a `region` only when it has an accessible
// name, and an unnamed `<section>` is a generic container that no reader is offered and no reader
// can land in. So an empty unnamed `<section>` costs nothing and is not counted — which is the
// one place this differs from the bench's fragment-level version of the check, and it agrees with
// it on the sample that mattered, where the class had zero instances either way.
//
// Named through `aria-labelledby` counts only if the reference RESOLVES, since a name that
// resolves to nothing is no name: `<section aria-labelledby="nope"></section>` is not announced
// as a region, so it is one finding (a dangling reference) and not two.
//
// Empty means empty to a reader, not empty of nodes: no text, and nothing that carries content
// without carrying words — an image, a table, or a form field a reader can land in and operate.
// `<textarea>` and `<select>` are in that list beside `<input>` though nothing in the pipeline
// emits one today (the page contract's fill-in block asks for `<input readonly value>`): they cost
// one selector, and the day that contract grows a dropdown, the alternative is a false finding in
// a rate. `<hr>` is deliberately NOT one of them — a page-break marker is furniture, and a region
// holding nothing but furniture is the defect, not an exception to it.
function emptyLandmarks(document: Document): string[] {
  const out: string[] = [];
  for (const element of document.querySelectorAll("nav, aside, section")) {
    if (element.textContent?.trim()) continue;
    if (element.querySelector("img, svg, table, input, textarea, select")) continue;
    if (element.tagName === "SECTION" && !isNamed(element)) continue;
    out.push(element.tagName.toLowerCase());
  }
  return out;
}

// Whether an element has an accessible name of its own. Only the three ways a `<section>` in this
// pipeline's output can get one — its content cannot name it, since this is only ever asked about
// an element with no content.
function isNamed(element: Element): boolean {
  if (element.getAttribute("aria-label")?.trim()) return true;
  if (element.getAttribute("title")?.trim()) return true;
  const refs = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
  return refs.some((ref) => element.ownerDocument.getElementById(ref) !== null);
}

// What the delivered bytes say about their own structure.
export function markupReport(html: string): MarkupReport {
  // Comments first, and this is not optional: the delivered document carries the `@unresolved`
  // list and the other `@` markers, which are model-written prose ABOUT the document and quote
  // markup freely. Counting a `<table>` inside one puts the balance check permanently off by
  // an unpredictable amount — measured, the raw bytes of that bench round report `table 25/19`
  // on a document whose real imbalance is nothing at all, and the one genuinely broken document
  // reports `19/15` instead of `16/15`. Every number here would have been noise.
  //
  // An unterminated `<!--` runs to the end, because that is what the parser does with one: a
  // comment with no `-->` swallows the rest of the document, and matching that is both correct
  // and the safe direction. Stopping at `-->` only would have left every `<table>` quoted after
  // a stray `<!--` counted as real markup — a document whose bytes are fine reporting an
  // imbalance, which is the one failure that would make these counts worth ignoring.
  // `wrapDocument` always closes its markers, so this needs a stray `<!--` in model body text.
  const text = html.replace(/<!--[\s\S]*?(?:-->|$)/g, " ");
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
  let structure = emptyStructure();
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
    // The same parse, because these are four more questions about the tree this document
    // delivers and re-parsing a document to ask them would double the cost of the check for
    // nothing. The `@` markers cost these four nothing either, unlike the balance scan above: a
    // comment is a comment to a parser, so markup quoted inside one is not an element and no
    // selector here can reach it.
    const document = dom.window.document;
    structure = {
      danglingIdrefs: counted(danglingIdrefs(document)),
      dlWithoutDd: counted(dlWithoutDd(document)),
      langOnVoid: counted(langOnVoid(document)),
      emptyLandmarks: counted(emptyLandmarks(document)),
    };
  } catch (err) {
    return {
      unbalanced,
      tables: 0,
      tablesWithoutBody: 0,
      emptyTableCaptions: [],
      structure: emptyStructure(),
      parseError: String(err),
    };
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
  return { unbalanced, tables, tablesWithoutBody, emptyTableCaptions, structure };
}

// Four zeros, for the two paths where nothing was measured: a document whose parse threw, and the
// initial value the measured one replaces. `parseError` is what tells those apart from a clean
// document, exactly as it does for the table counts.
function emptyStructure(): MarkupReport["structure"] {
  // A fresh object each, not one shared four ways: nothing here mutates them today, and a
  // counter that four fields share is the kind of thing a later edit gets wrong once.
  const none = (): StructuralCount => ({ count: 0, examples: [] });
  return {
    danglingIdrefs: none(),
    dlWithoutDd: none(),
    langOnVoid: none(),
    emptyLandmarks: none(),
  };
}
