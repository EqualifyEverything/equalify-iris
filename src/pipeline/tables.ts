// A table that continues onto the next printed page arrives as TWO `<table>` elements with
// duplicate column headers and no structural connection between them (issue #239). A reader
// moving by table gets "Table 17" twice, each half looking complete, and the second half's row
// headers are the states the first half did not reach.
//
// Measured on the last bench round's delivered documents (`equalify-iris-bench/runs-231`, four
// 25-page chunks of one report): 18 of the 48 delivered tables declare themselves continuations,
// and none of the splits is a mistake anyone could have prevented upstream. Each printed page is
// its own page-agent call, so the agent that wrote the second half had ONE page image and the
// other half was not on it — it knew what it was writing (every one of the 18 captions says so)
// and emitted a fresh `<table>` because it had nothing to append to. That places the join here,
// after the pages are joined and before anything reviews the result, which is the first moment
// both halves exist in one string.
//
// Why the join is not deterministic, measured against the same corpus before this was built:
//
//   * 4 of the 18 pairs declare DIFFERENT header structures, two of them a different column count
//     (Tables 10 and 11: 17 against 18). Appending one half's rows under the other half's headers
//     puts numbers under labels that do not describe them, which is worse than the split.
//   * 13 of the 18 second halves carry ids in their repeated header block — 36 ids in all —
//     because that block holds the page's footnote REFERENCE anchors (`<th scope="col">Govern­ment
//     <sup><a href="#p7-fn-2" id="p7-fnref-2">`) and the endnote links back to them. Dropping the
//     duplicate header the obvious way trades a structural defect for a dangling IDREF, which is a
//     1.3.1/4.1.2 failure of its own.
//   * A repeated bracketed unit note (`[Per capita as a percent of U.S. average]` as a full-width
//     row) opens a continued page, and whether it belongs in a joined table is a judgement about
//     the document rather than about its markup.
//
// So the merge is asked of the Copy Editor wherever one of those judgements is real, and everything
// around it is deterministic: which tables are halves of one table, where their bytes are, and — the
// part that makes asking safe — whether the answer kept every row. See `verifyJoin`.
//
// Only three of the six rules the editor is given need a judgement at all, though, and two of them
// are the bullets above. The other three are "move these bytes and change nothing", so `joinInCode`
// tries the pair without a model first and stands down wherever the judgement is real.
//
// HOW MUCH of the pairs that takes is not a property of these rules, and this paragraph asserted that
// it was until #326. It read "that is 52% of them at no output tokens, and `verifyJoin` refuses none
// of what it produces" — both figures are one corpus's counts (26 of the 50 pairs of #276), and the
// same code on three later rounds of a 100-page corpus took 53%, 24% and 31% with this file,
// `agents/`, the prompt and the model all byte-identical. The share is a draw on how steadily the
// extraction read a printed header rather than a structural figure, and `verifyJoin`'s clean sheet was
// not re-derived on those rounds. `joinInCode`'s own comment carries the range with its corpus, the
// price that did NOT move, and the reason.
//
// The 26 of 50 is still worth stating for what it is: one corpus's count, and one arithmetic
// correction. It is 26 and not the 31 #276 first measured, and the difference is one rule — the
// filing's id check read the second half's HEADER ROWS, and `querySelectorAll` cannot see an id on the
// `<table>` or `<caption>` element it is called on. 17 of the 50 pairs carry an id there, 13 of those
// ids the target of a live `href="#…"` or IDREF in the delivered document, and none of it visible to
// `verifyJoin`. 8 of the 17 join here anyway, because such an id has a surviving counterpart to move
// onto; the 5 that carry an id on BOTH halves' same element are the whole of the gap between 31 pairs
// and 26, and they are not a shortfall — two live targets cannot become one element, and the editor is
// asked because it can renumber what points at them.
//
// Nothing here reserializes the BODY. `roles.ts` and `anchors.ts` both refuse a whole-body
// parse-and-reserialize on purpose, because a round trip moves content out of tables and
// `review_converged` compares body strings; the same prohibition applies with the same force to a
// stage that runs before review. This parses only to READ — which tables there are, what their
// captions and rows say — and edits the body as a string, splicing at spans it has checked against
// the DOM it read (see `tableSpans`).
//
// `joinInCode` is the one thing here that serializes anything, and it is bounded to the table it
// joins: the first half's element, with the second half's rows appended, written back over the two
// halves' spans. That is the same blast radius the editor's answer already has — a model reply
// replaces those same bytes — but a round trip over model-written table markup can lose content
// where a model reply cannot, because the parser FOSTERS a stray `<p>` inside a `<table>` out of the
// table, and `outerHTML` then does not carry it. `verifyJoin` cannot see that: it reads columns,
// header cells, row counts and data-row labels, and hoisted prose is none of those. So the code path
// declines outright wherever either half's span parses to anything outside its own table, which
// leaves that pair to the editor exactly as today.
import { JSDOM, VirtualConsole } from "jsdom";
import { extractJson } from "../util/json.ts";
import { isTruncatedResponseError } from "../providers/types.ts";
import type { PipelineContext } from "./context.ts";
import { feedbackPreamble } from "./context.ts";

// A caption that says the table is the rest of the one before it.
//
// The word alone would be too loose — "Table 5.—Programs continued from 1959" is a title, not a
// continuation marker — so what is matched is the word used as a SUFFIX MARKER: introduced by a
// dash or an opening paren, the way a printed table's continued page marks itself. All 18 of the
// corpus's continuation captions pass it, in four spellings that no narrower rule covers:
// `—Continued` at the end, `— Continued` mid-caption followed by a bracketed unit note
// (`…1960 1—Continued[In millions of dollars]`), `(Percentage distribution) — Continued`, and
// `Table 25 (continued).—States Arrayed…`. Requiring it at the END of the caption drops 4 of the
// 18; requiring the `Table N` stem to repeat drops 8, because a second half's caption often keeps
// the title and loses the number.
//
// A false positive costs one declined join: the pair is put to the editor, which holds both halves
// and can answer that they are not one table — and if it answers wrongly, `verifyJoin` still has to
// pass. A false negative costs the document nothing it was not already shipping.
export const CONTINUED_CAPTION = /[—–\-(]\s*continued\b/i;

// The most pairs one document may pay a request for. The corpus's worst chunk had 7 in 25 pages,
// so this is not a bound anything measured comes near; it is here because the loop below re-reads
// the body after every join and a body that somehow kept producing pairs would keep buying calls.
export const MAX_TABLE_JOINS = 12;

// One `<table>` in the body, read both ways: what the DOM says it contains, and where its bytes
// are. Both, because the join is decided on the parsed table and applied to the source.
export interface TablePiece {
  caption: string;
  rows: number;
  cols: number;
  // The header block: the rows that describe the columns rather than carrying data, and the `<th>`
  // cells in them. Both are read on each half so the join can be held to them — the header block is
  // the one thing a merge is allowed to remove a COPY of, so the row floor has to know how big it is,
  // and its cells being `<th>` is what makes the result a table with headers at all (`verifyJoin`).
  // The count is the block's cells and not every `<th>` in the table, so that it says one thing: a
  // table with a `<th scope="row">` per data row would otherwise scale this with its row count and
  // report a lost ROW as a lost header.
  //
  // A bracketed unit note row inside the block does not count, whichever tag it used, and that is not
  // a detail: rule 6 of the merge prompt tells the editor to carry that note into the caption once and
  // print no row for it, so counting its `<th colspan>` as a header cell made `header_cells_lost`
  // refuse the answer the prompt asks for — on the corpus's own ink, since one of the two phantom
  // `<thead>` rows the census found spells it `<th>` (`p029`) and 6 of the 8 across every round log do.
  // Refusing the EDITOR's answer ships both halves split, so this counted a note row out of the header
  // block at the price of a table. What the count is for survives: a reply that flattened the real
  // column headers to `<td>` still loses every one of them.
  headerRows: number;
  headerCells: number;
  // The bracketed note rows this half printed: for each, its text and whether the half printed it
  // inside the header block. Not read off `labels`, which drops header rows — a note row closing
  // `<thead>` is one, and the corpus has that shape. Both facts, because the check that uses this
  // (`verifyJoin`) is asking whether the merge kept a note where the page had it or MOVED it, and the
  // text alone cannot tell those apart: a note printed as a `<thead>` row and delivered as a `<tbody>`
  // cell of data matches on text and is the relocation being refused.
  noteRows: { text: string; header: boolean }[];
  // The first cell of every DATA row, normalized and non-empty: on these tables that is the row's
  // label — the state, the tax, the year — which is what a reader loses when a join drops rows,
  // and what `verifyJoin` requires to survive. Not the numbers: a label is a string worth looking
  // for, and a cell reading "4.1" says nothing about which row it came from.
  //
  // Header rows are excluded, because merging the two halves' header blocks into one is the
  // judgement being asked for: a header cell that reads "Col 1" in the input and something better
  // in the answer is the repair, not a loss. What counts as a header row is a row inside `<thead>`
  // — all 48 tables in the corpus put theirs there, and all 92 of their multi-cell all-`<th>` rows
  // are inside one — plus, wherever it sits, a row of more than one cell that is all `<th>`. That
  // second reading is deliberately not conditional on the table lacking a `<thead>`, and `rowFloor`
  // now rests on it: a reply that keeps the duplicate header block by repeating it mid-`<tbody>` is
  // only visible as a deeper joined header BECAUSE those rows count, and that depth is what the
  // credit's gate reads. A one-cell all-`<th>` row is NOT excluded: that is a
  // `<th scope="rowgroup">` group label (12 of them in the corpus), which is content the join must
  // keep and rule 5 of the prompt asks for.
  labels: string[];
  start: number;
  end: number;
  html: string;
}

export interface ContinuationPair {
  first: TablePiece;
  second: TablePiece;
}

// Soft hyphens out (a column header printed as `Govern­ment` is `Government`), whitespace folded.
// Both spellings of the same words have to compare equal or every check here reads as a change.
export function normalizeCell(text: string): string {
  return text.replace(/­/g, "").replace(/\s+/g, " ").trim();
}

// Every top-level `<table>` span in the SOURCE, by depth counting rather than by regex pairing, so
// a table nested inside a table is part of its parent's span and not a span of its own.
//
// Unbalanced markup is why each span is checked against the DOM before it is used. `runs-231`'s
// third chunk has 8 balanced spans against 16 tables in the parsed DOM, because one document in
// that round shipped an unclosed `<table>` (#240, since fixed) and the parser recovered it into
// tables the bytes do not delimit. A splice at a span that is not the table it was matched to
// would move rows out of one table and into another, so `continuationPairs` declines any pair
// whose two halves it cannot find in the source AS the DOM read them. On that document 14 of the
// 18 pairs are still locatable and 4 are declined; on the other two chunks, all of them are.
export function tableSpans(html: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  const re = /<\/?table\b[^>]*>/gi;
  let depth = 0;
  let start = -1;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    if (m[0][1] !== "/") {
      if (depth === 0) start = m.index;
      depth++;
      continue;
    }
    if (depth === 0) continue; // a stray `</table>`: not the end of anything this opened
    depth--;
    if (depth === 0) spans.push({ start, end: m.index + m[0].length });
  }
  return spans;
}

// jsdom, quiet: these fragments are model output and a parse error is not news here — the whole
// point of reading them through a parser is to see what a browser would make of them.
function parse(html: string): Document {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", () => {});
  return new JSDOM(`<body>${html}</body>`, { virtualConsole }).window.document;
}

// See `TablePiece.labels` for why this reads `<thead>` first and the cells only as a fallback.
function isHeaderRow(row: Element): boolean {
  if (row.closest("thead") !== null) return true;
  const cells = [...row.children];
  return cells.length > 1 && cells.every((c) => c.tagName === "TH");
}

function read(table: Element, span?: { start: number; end: number }, html = ""): TablePiece {
  const rows = [...table.querySelectorAll("tr")];
  return {
    caption: normalizeCell(table.querySelector("caption")?.textContent ?? ""),
    rows: rows.length,
    // The widest row, counting `colspan`, which is the table's column count as a reader meets it.
    cols: rows.reduce(
      (widest, r) => Math.max(widest, [...r.children].reduce((n, c) => n + (Number(c.getAttribute("colspan")) || 1), 0)),
      0,
    ),
    headerRows: rows.filter(isHeaderRow).length,
    headerCells: rows
      .filter((r) => isHeaderRow(r) && !isUnitNoteRow(r))
      .reduce((n, r) => n + [...r.children].filter((c) => c.tagName === "TH").length, 0),
    labels: rows
      .filter((r) => !isHeaderRow(r))
      .map((r) => normalizeCell(r.children[0]?.textContent ?? ""))
      .filter(Boolean),
    // Every row of this half that is a bracketed note, header block included, each with the block it
    // was printed in. Read over ALL rows and not over `labels`, because `labels` drops header rows and
    // a note row printed inside `<thead>` is one — that is the `p068` shape the corpus has, and reading
    // this off `labels` made a note the pages did print as a row look like a note nobody printed.
    noteRows: rows
      .filter(isUnitNoteRow)
      .map((r) => ({ text: normalizeCell(r.textContent ?? ""), header: isHeaderRow(r) })),
    start: span?.start ?? 0,
    end: span?.end ?? 0,
    html: span ? html.slice(span.start, span.end) : "",
  };
}

// Which tables in this body are second (or third) halves of the table before them, with the bytes
// of both halves. Declines are returned rather than dropped, so the log can say why a split
// document shipped split.
export function continuationPairs(body: string): {
  pairs: ContinuationPair[];
  declined: { caption: string; reason: string }[];
  tables: number;
} {
  const doc = parse(body);
  const tables = [...doc.querySelectorAll("table")];
  const spans = tableSpans(body);
  // Each span read as its own document, so a span can be matched to the table it delimits by what
  // it contains rather than by its position: on a body whose tables and spans disagree in NUMBER,
  // position is exactly the thing that cannot be trusted.
  const spanPieces = spans.map((span) => {
    const t = parse(body.slice(span.start, span.end)).querySelector("table");
    return t ? read(t, span, body) : null;
  });
  // A balanced body's Nth top-level span IS its Nth table, so the mapping is the identity and the
  // content comparison becomes a self-check on that claim rather than a search. It is done this way
  // round because a search cannot tell twins apart: on a body carrying two tables with the same
  // caption and the same row count — a form printed twice, a table and its own summary — a search
  // resolves the second to the FIRST one's span, and a real pair after it then reads as
  // `not_adjacent`, which says something untrue about bytes that are in fact adjacent.
  //
  // The counts disagree exactly where position cannot be trusted: unbalanced markup (#240's
  // unclosed `<table>`, 8 spans against 16 tables) and a table nested inside another (part of its
  // parent's span, its own DOM node). There the search is the best available, ambiguity and all,
  // and a wrong resolution still cannot splice — it fails the content check or the adjacency one.
  const aligned = spanPieces.length === tables.length;
  const match = (piece: TablePiece, i: number): number => {
    if (aligned) {
      const p = spanPieces[i];
      return p !== null && p.caption === piece.caption && p.rows === piece.rows ? i : -1;
    }
    return spanPieces.findIndex((p) => p !== null && p.caption === piece.caption && p.rows === piece.rows);
  };

  const pairs: ContinuationPair[] = [];
  const declined: { caption: string; reason: string }[] = [];
  for (let i = 1; i < tables.length; i++) {
    const second = read(tables[i]);
    if (!CONTINUED_CAPTION.test(second.caption)) continue;
    const first = read(tables[i - 1]);
    const a = match(first, i - 1);
    const b = match(second, i);
    if (a === -1 || b === -1) {
      declined.push({ caption: second.caption, reason: "unmatched_source" });
      continue;
    }
    // Adjacent in the source too. Another table between the two halves means the pairing the DOM
    // suggested is not the pairing the bytes describe, and appending across it would move a third
    // table's rows. In the corpus every located pair is adjacent, including the three-piece chain
    // whose middle piece is an empty header stub.
    if (b !== a + 1) {
      declined.push({ caption: second.caption, reason: "not_adjacent" });
      continue;
    }
    pairs.push({ first: spanPieces[a]!, second: spanPieces[b]! });
  }
  return { pairs, declined, tables: tables.length };
}

// The other way to get a pair: from two halves' bytes alone, which is what the log lines carry
// (`html_first` / `html_second` on `table_join_code_declined` and on a code join). This is the reason
// those fields are worth their size — a re-score reads them back through THIS parse, the one the
// pipeline used, rather than through a probe's own reading of the same markup (#326).
//
// Everything a pair is asked for downstream is derived here and nothing is taken on the caller's word:
// `joinInCode` reads only the two `html` strings, and `verifyJoin` and `rowFloor` read the caption,
// row, column, header and label figures that `read` derives FROM those strings. So a replayed pair
// scores the whole free path — the guard AND the verification that would catch a wrong loosening of it
// — and not merely the guard.
//
// Null where either half holds no `<table>`, which is `joinInCode`'s own `unreadable`: a decline logged
// for that reason replays to it rather than to a pair that cannot be built.
//
// `start` and `end` are the half's offsets in ITSELF, because a logged half has no body to be an offset
// into. Nothing here reads them, and a merge produced from a replayed pair must therefore not be
// spliced anywhere: this builds a pair to SCORE, and the document it came from already shipped.
export function pairFromHalves(first: string, second: string): ContinuationPair | null {
  const f = parse(first).querySelector("table");
  const s = parse(second).querySelector("table");
  if (f === null || s === null) return null;
  return {
    first: read(f, { start: 0, end: first.length }, first),
    second: read(s, { start: 0, end: second.length }, second),
  };
}

export const TABLE_JOIN_SYSTEM = `You are the Copy Editor Agent, asked for one specific repair.

You are given two HTML tables. They are the two halves of a SINGLE table that was printed across a
page break: the second half's caption says so. Return them as one table.

Rules, in order of importance:

1. COPY EVERY DATA ROW EXACTLY, from both halves, in order — first half's rows, then second
   half's. Every cell's text, every number, every footnote marker, every attribute. You are moving
   rows, not re-transcribing them. Do not correct, round, reformat or summarise a value. Do not
   drop a row because it looks like a repeat: two rows may legitimately carry the same label.
2. Keep every id and every href. The repeated header block often carries the footnote reference
   anchors an endnote links BACK to (id="...fnref-2"), so deleting it leaves that link pointing at
   nothing. If both halves carry a marker for the same footnote, keep one of them and keep its id
   on it; if the two ids differ, keep the one from the FIRST half.
3. ONE header block, in <thead>, describing the columns of the joined table. Where the two halves
   describe their columns differently, use the structure that correctly describes the rows you are
   keeping — and if the two halves genuinely have different columns, say so and decline (see below).
4. ONE <caption>: the table's own title, WITHOUT the continuation marker. Do not write "Continued".
   Where EITHER half's caption carries a note of measure under the title ("[In millions of dollars]"),
   the note is part of the table's name and stays in the joined caption — including where only the
   continued half printed it, because a note is no less the table's own for having been set over the
   second half. The page agent is told to put it there, so a caption arriving with one is not carrying a
   stray row, and a joined table that loses it hands a reader the figures with nothing to read them in.
5. Keep <th scope="rowgroup"> group headers where either half has them, in place.
6. A bracketed unit note that both halves repeat as a full-width row (e.g. "[In millions of
   dollars]") belongs once, at the top. Keep the first and drop the repeat. The two halves need not
   print it in the same place: wherever the caption you are writing under rule 4 carries that note —
   because the first half's caption did, or because the caption you took from the continued half did —
   any row repeating it is the repeat, so drop it and do not also copy it in under rule 1. One note,
   once, and in the caption wherever rule 4 puts it there. Never the other way about: a note a half
   printed in its caption does not become a row of the joined table. A row holding it invents a cell of
   data the page never printed, and "at the top" above means the top of the table's own name and not a
   first row of data.

DECLINE if these are not two halves of one table — different columns that no single header block
describes, or two different tables whose captions merely look alike. Declining costs nothing: the
document ships as it is today.

Return ONLY this JSON object:

{ "html": "<table>…the joined table…</table>", "log": "one sentence on what you merged", "declined": false }

To decline: { "html": null, "log": "why", "declined": true }`;

// Did the answer keep the table? The merge is the model's judgement; this is the part that does not
// have to be taken on trust.
//
// Returns null when the join is sound, or the reason it is refused. The refusal is CONTAINED — the
// caller keeps both halves, byte for byte — which is what makes it safe to ask for a 60-row table
// in one reply at all. `destroyedBody` (#174) floors the editor's whole-body round at half the
// document's prose; a 60-row table coming back with 40 rows is nowhere near that floor on a
// 25-page document, so it needs its own check, and the check it needs is about rows rather than
// about size.
//
// The row check is in two parts, because neither half of it sees what the other does. The LABELS are
// checked as a set: a legitimate join drops rows on purpose — the repeated header, the repeated unit
// note — and every label those rows carry still exists in the table once, so a set is what survives
// a sound merge, and a label is a string worth looking for where a row count is not. And the COUNT
// is checked against the sum of both halves, because the label set is blind to a row that has no
// label: a printed statistical table gives its multi-line row labels a first line and then
// continuation lines whose first cell is EMPTY (`<tr><td></td><td>4.1</td>…`), and those rows are
// invisible to a check made of labels. Floored on the sum and not on the larger half, which is the
// mistake this replaced: with a 21-row half and a 39-row half, a floor of 39 permits losing the
// whole smaller one.
//
// The rows a sound join may drop, beyond one half's header block: rule 6's repeated bracketed unit
// note (`[In millions of dollars]` as a full-width row, reprinted at the top of the continued page).
// One, because rule 1 forbids every other kind of drop — "do not drop a row because it looks like a
// repeat: two rows may legitimately carry the same label" — so anything past this is a merge losing
// content. A document that legitimately repeats more than one such row is refused and ships split,
// with `rows_lost` in the log saying so, which is the direction this stage errs in everywhere else.
const JOIN_DROPPABLE_ROWS = 1;
// How many rows a sound join may lose to the duplicated header, which is the rest of the floor. It
// cannot be assumed to be one half's block — rule 3 asks for the structure that describes the rows,
// and that is sometimes the second half's, which may be a different DEPTH (4 of the corpus's 18 pairs
// declare different header structures). Two readings each get one case right and one wrong, so the
// credit is the more permissive of them, within the bound below:
//
//   * The joined table's own depth says what went: `first + second - joined`. Exact where a block was
//     dropped whole, and wrong where the merge PROMOTED a row into the header — rule 6's reprinted
//     unit note belongs "once, at the top" and reads naturally as a `<thead>` row, and a promotion
//     decrements this reading, charging the join for a row that is still in the table.
//   * One shared block goes: `min(first, second)`. Blind to a merge that dropped the DEEPER of two
//     unequal blocks, which is 3 rows credited as 1 on a 3-against-1 pair.
//
// Taking the larger of the two is not free, though, and the `min` is not the harmless ceiling it
// looks like. It wins exactly when the joined header is DEEPER than either half's — which is the
// promotion above, and is equally true of a reply that keeps BOTH header blocks, repeating the second
// one mid-table as all-`<th>` rows. That is the pre-PR duplicate-header state, nothing went, the
// correct credit is 0, and crediting a shared block instead hands back that block's worth of rows:
// measured on a pair of 3-row headers, a reply that kept the duplicate block and dropped 3 of the 5
// unlabelled continuation lines was accepted with `table_joined` in the log, four rows of numbers
// gone and invisible to the label set by construction.
//
// So the `min` reading is available only while the joined header can be READ as one block plus the
// row rule 6 lets a merge promote into it. Past that depth the extra rows are a second block kept,
// not a promotion, and the credit is what the joined table's depth says — floored at zero, since a
// header deeper than both blocks together means rows moved rather than went, and the row count does
// not change when a row moves. Counts alone cannot tell a promotion from a kept duplicate (both only
// raise the depth), so the depth is where the two are separated — and separated to within one row,
// not outright: a joined header exactly one row deeper than the deepest block is inside the gate, so
// a reply that kept ONE duplicated header row is still credited with a shared block and can lose one
// unlabelled row with it. That residual is the same size as the drop `JOIN_DROPPABLE_ROWS` already
// forgives, and closing it would mean refusing rule 6's promotion, which is the same shape. What is
// bounded, and all that is claimed here, is that the slack cannot be a header BLOCK deep.
// Deflating the depth instead —
// demoting the header block to plain rows — does raise the credit, and is refused before this by
// `header_cells_lost`.
function rowFloor(pair: ContinuationPair, joined: TablePiece): number {
  const deepest = Math.max(pair.first.headerRows, pair.second.headerRows);
  const byDepth = pair.first.headerRows + pair.second.headerRows - joined.headerRows;
  const headerDropped =
    joined.headerRows <= deepest + JOIN_DROPPABLE_ROWS
      ? Math.max(Math.min(pair.first.headerRows, pair.second.headerRows), byDepth)
      : Math.max(0, byDepth);
  return Math.max(0, pair.first.rows + pair.second.rows - headerDropped - JOIN_DROPPABLE_ROWS);
}

export function verifyJoin(pair: ContinuationPair, merged: string): string | null {
  const trimmed = merged.trim();
  const doc = parse(trimmed);
  const tables = [...doc.querySelectorAll("table")];
  // Exactly one, and nothing around it: a reply that returned the two tables it was given, or a
  // table wrapped in a paragraph of explanation, is not a joined table and must not be spliced in
  // as one.
  if (tables.length !== 1) return "not_one_table";
  if (!/^<table\b/i.test(trimmed) || !/<\/table>$/i.test(trimmed)) return "not_one_table";
  const joined = read(tables[0]);
  if (!joined.caption) return "no_caption";
  // Still marked as a continuation, which would make the next read of the body pair it with the
  // table BEFORE it — a wrong join, and a loop that never runs out of pairs. Rule 4 of the prompt,
  // enforced because termination depends on it.
  if (CONTINUED_CAPTION.test(joined.caption)) return "still_continued";
  const cols = Math.max(pair.first.cols, pair.second.cols);
  if (joined.cols < cols) return "columns_lost";
  // A table whose header cells all came back as `<td>` is a data table with no headers, which is the
  // 1.3.1 failure this whole stage exists to reduce — and it would otherwise pass every check here:
  // the labels are all present (they are matched over `th,td` together), the columns are unchanged,
  // and the row count is unchanged. axe reports nothing on it either, so it would ship. Floored on
  // the SMALLER half's count rather than the larger, because collapsing two header blocks into one
  // legitimately loses header cells and the two halves may describe their columns at different
  // depths — a two-row spanned header merged down to the other half's single row is rule 3 being
  // followed.
  //
  // The `min` is over the halves that HAVE a header block, because what it exists to permit is two
  // blocks collapsing into one — and a half with no header cells has no block to collapse, so its
  // zero is not a smaller allowance, it is the absence of one. Read as a plain minimum it took the
  // floor to zero and the check with it: on a pair whose second half is a rowless header stub, a
  // reply flattening the first half's whole block to `<td>` would have passed. Zero on BOTH sides
  // leaves it inert, which is the right answer for a pair with no header cells to lose.
  const blocks = [pair.first.headerCells, pair.second.headerCells].filter((n) => n > 0);
  if (blocks.length > 0 && joined.headerCells < Math.min(...blocks)) return "header_cells_lost";
  // Less the rows the joined CAPTION absorbed. A note row promoted into the caption is a row that
  // stopped existing, and `rowFloor` counts it gone — so on a pair whose halves both printed the note as
  // a `<tbody>` row, an answer carrying it into the caption once was refused as `rows_lost`, and refusing
  // the editor's answer ships both halves split. The label check twelve lines down already has this
  // exemption for the same move, on the same reasoning, and this is the count `rowFloor` needs to see it.
  // Header-block rows are excluded because `rowFloor` nets those out through `headerDropped` already, and
  // forgiving them twice would buy a real data row's worth of slack. Bounded the same way the label
  // exemption is: a row whose text is a bracketed run the joined caption now carries, and no other.
  //
  // Counted as a REPLACEMENT for `JOIN_DROPPABLE_ROWS` and not an addition to it, which cost a round: that
  // one row exists to forgive rule 6's repeat drop, so a note row the caption accounts for was already
  // paid for once, and granting both let a pair lose a real row as well. Measured on three shapes,
  // `labels` blind to all of them because the row that goes is an unlabelled continuation line — the
  // census's commonest pair (note in the first half's caption, a row on the second) plus either promotion
  // shape, each of which stopped reporting a dropped data row. So the allowance is the larger of the two
  // and never the sum: rule 6's one row where no caption absorbed anything, and otherwise exactly the rows
  // it did absorb.
  const absorbed = [...pair.first.noteRows, ...pair.second.noteRows].filter(
    (n) => !n.header && captionNotes(joined.caption).has(n.text),
  ).length;
  if (joined.rows < rowFloor(pair, joined) - Math.max(0, absorbed - JOIN_DROPPABLE_ROWS)) return "rows_lost";
  // Every label from either half, somewhere in the joined table's cells — not necessarily as a
  // first cell, because a join that adds a column legitimately moves the label along one, and a
  // guard that refuses that would refuse the repair it exists to protect.
  const cells = new Set([...tables[0].querySelectorAll("th,td")].map((c) => normalizeCell(c.textContent ?? "")));
  // A unit note the merge moved out of a row and into the CAPTION is not a lost label, and without
  // this it read as one: a note row is a data row, so its bracketed text is the row's label, and
  // `cells` is read off `th,td` and never sees a caption. The mixed pair rule 6 now resolves — the
  // note in the first half's caption, still a row in the second — drops that row on purpose, so this
  // check would have refused exactly the join above it just made. Bounded to the bracketed runs the
  // joined caption actually carries: a row label that is not a bracketed run, or one whose note the
  // caption does not hold, is missing as before.
  for (const note of captionNotes(joined.caption)) cells.add(note);
  const lost = [...new Set([...pair.first.labels, ...pair.second.labels])].filter((l) => !cells.has(l));
  if (lost.length > 0) return `labels_lost:${lost.length}`;
  // A note of measure inside the caption ("[In millions of dollars]") is part of the table's name, and
  // rule 4 says to keep it. Checked rather than only asked for, because nothing else here can see it
  // go: the checks above read cells, columns and rows, and a joined caption holding the bare title
  // passes every one of them while handing a reader the figures and nothing to read them in. The shape
  // only became reachable when `page.md` was told to put the note in the caption at all — before that
  // it arrived as a full-width row, which is rule 6's case and is held by the label and row checks.
  //
  // LAST of the five, and deliberately, because the reason is what a failed pair reports: a merge that
  // dropped the note AND lost rows should say `rows_lost`. This is the cheapest of the losses and it
  // would otherwise mask the dearest.
  //
  // EITHER half's caption, which is a different question from the one `fNotes` asks and was wrong here
  // for a while because the two got answered together. `fNotes` asks what rule 6 may DROP, and there
  // the asymmetry is right: a note only the continued half carries is a first appearance and not a
  // repeat. This asks what the joined caption must still SAY, and a note is no less part of the table's
  // name for having been printed over the second half. Keyed on the first half alone, the free path
  // dropped it silently — `joinInCode` keeps the first half's caption and discards the second's, so a
  // second half whose caption carried the note and whose rows carried none passed every check with the
  // units gone from the delivered table. Not a constructed shape: `p049`/`p050` are two halves of one
  // continued table where each arm dropped the note on exactly one half.
  //
  // What a refusal costs here is one editor call and not the table. A code join that trips this logs
  // its decline and the pair goes on to the Copy Editor, whose rule 4 asks for the note either half's
  // caption carries — so the check is one the prompt can satisfy, which is what makes refusing the
  // right answer rather than a dead end.
  //
  // What counts as KEPT is the joined caption, and — for a note the DISCARDED caption carried, which is
  // the qualification the next-but-one paragraph is about — a note row some half printed in that same
  // part of the table, header block or body. Reading the caption alone refused the mirror of the pair
  // rule 6 now joins for free: the first half printing the note as a ROW and the second in its caption
  // leaves the row in the merged table, nothing lost, and a caption-only reading called that a loss.
  // Both placements are reachable — #374's census has the note inside the caption on 56 arm-pages and
  // outside it on 12 — so the pair whose halves disagree about which is a shape to expect and not one
  // to construct.
  //
  // "Printed as a row" and not "is a row in the answer", which is the weaker thing this asked at first
  // and is a hole rather than a licence: a note that arrived in a caption and left as a row has been
  // DEMOTED into the phantom row `page.md` forbids in as many words — a `<td>` invents a cell of data
  // the page never printed, a `<th>` names a column that does not exist — and counting any note row as
  // proof of keeping would pass exactly that, including the `<thead>`-closing form the census counts as
  // harm. `joinInCode` never demotes, so the shape is the Copy Editor's: rule 6's "belongs once, at the
  // top" can be read as licence for the row while rule 4 asks for the caption, and a model that
  // satisfies one and not the other must not clear this.
  //
  // The distinction is already on the pair: `noteRows` is every bracketed note row each half printed,
  // header block included, WITH the block it was printed in. Read off `labels` first, which was wrong in
  // one direction — `labels` drops header rows, so a note row printed inside `<thead>` counted as printed
  // by nobody and a merge that carried that row through untouched was refused. That is the `p068` shape
  // the census counts. Widening it to every `tr` and matching on the TEXT then failed the other way, and
  // on the pair the census makes likeliest: the note in the first half's caption (56 arm-pages, the
  // placement `agents/page.md` asks for) and printed as a `<thead>` row by the second (of the 12
  // outside it). A merge that struck the caption note and delivered it as a `<tbody>` cell of data
  // matched the second half's text and cleared — the exact demotion this check exists to refuse, with
  // both harms `page.md` names in as many words. So the two facts are matched together (`noteKey`).
  //
  // A row precedent excuses the caption for only ONE of the two captions, though, and reading it as
  // excusing both left the same demotion clearing in the commoner spelling. The two shapes are mirror
  // images of each other and were being read as one:
  //
  //   * the note in the SECOND half's caption and printed as a row by the first. Rule 4 discards the
  //     second half's caption whole — marker, title and all — so a note going with it is a duplicate
  //     caption being dropped, and the row still stands in the half and the block that printed it.
  //     Nothing moved. This is the pair rule 6 joins for free, and it has to keep joining.
  //   * the note in the caption the join is BUILT ON and printed as a row by the other half. Here the
  //     surviving caption has been EDITED: text struck out of the one caption rule 4 says to copy. That
  //     the other half printed the same note as a row does not make the striking a move of nothing —
  //     the delivered caption stops naming the units and a reader moving by row meets them as data,
  //     which are the two harms `page.md` names.
  //
  // So a note in the title caption is owed the joined CAPTION and nothing else will do, and only a note
  // carried by the discarded caption may be answered by a row. Four reasons rather than one, because a
  // decline is all a run log has: `caption_note_lost` is a note in neither the joined caption nor a row
  // some half printed, `caption_note_struck` is a note gone from the caption the join was told to copy
  // but still in the table as a row a half printed, `note_shipped_twice` is the joined table holding one
  // note in both places, and `note_row_lost` is a note NEITHER caption carried, printed as a row and
  // dropped — the pair the first three cannot see, since each of them is keyed on a caption note. All
  // four point at rule 4 or rule 6 and the repair is the same sentence, so this buys the log and not the
  // model. Which of the four a pair gets is decided by the ORDER they are asked in, below, and not by
  // these definitions — `caption_note_struck` says "still in the table" only because the lenient check
  // has already answered every pair where it is not.
  //
  // The title caption is the first half's, or the second half's where the first has none. That is rule
  // 4, and it is NOT the same predicate `joinInCode` branches on: this reads the caption's normalized
  // TEXT and `joinInCode` asks whether the caption ELEMENT is there. They part over one shape, a first
  // half whose `<caption>` holds markup and no text — where `joinInCode` keeps that empty caption and
  // imports nothing, so `no_caption` above answers the pair before any of this is reached, and on the
  // editor's path falling to the second half's caption is what rule 4 asks for anyway. No outcome turns
  // on the difference; it is written out because the two readings are easy to state as one and this
  // check has been wrong three times in a comment that did exactly that.
  //
  // The lenient half is asked FIRST, and that ordering is what makes each reason mean something. A note
  // in neither the joined caption nor an excusable row is gone from the delivered table, which is
  // `caption_note_lost`; `caption_note_struck` is then left saying the one thing the lenient half cannot
  // refuse — the note is still in the table, as a row a half printed in the place it printed it, and
  // missing only from the caption the join was told to copy. That is the demotion, and nothing else
  // reaches this line. Asked the other way round, the strict half answered first for every pair whose
  // note simply vanished, and reported a striking-out on pairs where nothing was struck.
  //
  // Which also makes the free path's reach here derivable rather than asserted. The only thing that can
  // remove text from the copied title caption is `stripMarker`, and it eats a run introduced by
  // `[—–\-(]` — so `caption_note_struck` on a code join would need the printed note to CONTAIN the
  // continuation marker (`[In millions of dollars—Continued]`) and a half to have printed that same run
  // as a row to excuse it past the lenient half. Absent that, the free path copies the caption verbatim
  // minus the marker and every note in it survives by construction; this reason is the editor's.
  //
  // Then the same doubling from the other side: a note the joined caption keeps AND emits as a row.
  // Rule 6 says "drop it, and do not also copy it in under rule 1", and nothing here read that half of
  // it — `printedAsRow` is only ever an EXCUSE for a note missing from the caption, so a note row that
  // is not excusing anything was never looked at. A reader moving by row still meets the units as a
  // cell of data, which is the harm `page.md` names, with the caption merely also correct. No half's
  // printing excuses it: the check is on the delivered table, because "one note, once" is what both
  // rule 6 and `page.md` ask for and a doubled note is the phantom row whichever page printed it.
  //
  // That last one can refuse a free join, and what it may refuse there had to be narrowed to one shape
  // nothing has measured: a half that printed the note in its caption AND as a row of its own, which
  // `joinInCode` carries through because it drops repeats and not a first appearance printed twice. That
  // pair goes to the editor, whose rule 6 asks for exactly the table this wants, so the refusal is
  // satisfiable rather than a dead end, and it is left unexempted on purpose — an exemption for "the page
  // printed it twice" is a distinction drawn on no measured pair, since #374's census has the note in a
  // caption on 56 arm-pages and outside one on 12 and never both on one page.
  //
  // What this check must NOT refuse for free is the doubling the merge itself makes, and it could: where
  // the first half has no caption, `joinInCode` imports the second's WITH its note and used to keep the
  // first half's note row beside it — both placements measured, so a pair the page printed once bought an
  // editor call and shipped split if that call declined. That is fixed where it is made, by dropping the
  // row the imported caption now repeats, and not by an exemption here; the same rule 6 licence, applied
  // one step earlier, and a pair that would need more drops than the licence allows declines there too.
  // Both spellings of that row are dropped, `<td>` and `<th>`, which took `header_cells_lost` being
  // asked on the right cells first — see `read`. Guarding the drop instead, so a `<th>` note row stayed
  // and this answered `note_shipped_twice`, treated the collision as the free path's problem: the same
  // count refused an EDITOR answer that carried the note into the caption exactly as rule 6 asks, and
  // there the price is not one call, it is both halves shipped split.
  //
  // And last, the note neither caption ever carried: printed by a half as a row, and gone from the
  // delivered table without arriving in the caption. Every reason above is keyed on a CAPTION note —
  // `owed` and `titleNotes` are read off the halves' captions and are empty on such a pair — so the whole
  // harm the placement rule exists to remove had nothing looking for it where the page never used a
  // caption, on the corpus's 12 outside-caption placements.
  //
  // What it adds is bounded, and the bound is the block the row sat in. A note row in `<tbody>` is a data
  // row whose LABEL is the bracketed run, so deleting it was already refused above — `labels_lost:1`, or
  // `rows_lost` where both halves printed it — and it still is, because those are asked first. That is
  // not the wrong order: an answer that dropped the note row and three state rows should report the four,
  // not the one. So the case this reason is for is the row inside the HEADER BLOCK, where `labels` skips
  // it and `rowFloor` forgives it, in either spelling — and it is the reason the `<tbody>` case deserves
  // too, which it does not get. What narrowing `headerCells` a commit ago changed is that `<th>` in
  // `<thead>` stopped being caught as a lost header cell, which was the wrong name for it and the only
  // name it had. Asked LAST so the caption reasons keep the pairs that have a caption note to lose, and
  // on the note's TEXT rather than its key: a note the merge moved from `<thead>` into `<tbody>` is a
  // relocation, which is a different defect and not this one, and calling it a deletion would point the
  // repair at the wrong rule.
  //
  // What all of this compares is a note's text, the block it sits in, which caption owed it, and whether
  // the delivered table holds it in two places at once — nothing finer. A note MOVED is invisible here,
  // within one block or between them, and so is a `<td>` note row delivered as a `<th>` one: `page.md`
  // forbids both spellings of the row, but the note in them has not been lost, and none of these reasons
  // is the right one to refuse a table over — which is now true of the two spellings on every path here,
  // and was not for one commit. A refusal of the EDITOR's answer ships both halves split, so a reason
  // that names the wrong defect buys a split table and points the repair at the wrong rule.
  const printedAsRow = new Set([...pair.first.noteRows, ...pair.second.noteRows].map(noteKey));
  const joinedNoteRows = [...tables[0].querySelectorAll("tr")]
    .filter(isUnitNoteRow)
    .map((r) => ({ text: normalizeCell(r.textContent ?? ""), header: isHeaderRow(r) }));
  const rowNotes = joinedNoteRows.filter((n) => printedAsRow.has(noteKey(n))).map((n) => n.text);
  const inCaption = captionNotes(joined.caption);
  const kept = new Set([...inCaption, ...rowNotes]);
  const owed = new Set([...captionNotes(pair.first.caption), ...captionNotes(pair.second.caption)]);
  if ([...owed].some((n) => !kept.has(n))) return "caption_note_lost";
  const titleNotes = captionNotes(pair.first.caption !== "" ? pair.first.caption : pair.second.caption);
  if ([...titleNotes].some((n) => !inCaption.has(n))) return "caption_note_struck";
  if (joinedNoteRows.some((n) => inCaption.has(n.text))) return "note_shipped_twice";
  const stillThere = new Set([...inCaption, ...joinedNoteRows.map((n) => n.text)]);
  const printedTexts = [...pair.first.noteRows, ...pair.second.noteRows].map((n) => n.text);
  if (printedTexts.some((t) => !stillThere.has(t))) return "note_row_lost";
  return null;
}

// A candidate join that passed: the bytes to splice in, and the joined table as read back.
interface Checked {
  reason: null;
  merged: string;
  result: TablePiece;
}

// The verdict on one candidate join and the joined table's own figures, together — because both of
// them parse the candidate and a parse can throw (see `attempt`). Null means the candidate could not
// be read at all, which is `read_failed` for this pair and not for the document.
//
// Both the code path and the editor path go through here, so they are held to the same bar by
// construction rather than by two call sites agreeing to. `declined` is the editor's answer to a pair
// it will not merge; the code path has its own reasons and passes false.
function checkJoin(
  pair: ContinuationPair,
  html: string | null,
  declined: boolean,
): { reason: string | null; merged: string; result: TablePiece | null } | null {
  return attempt(() => {
    const reason = declined ? "declined" : html === null ? "no_output" : verifyJoin(pair, html);
    const merged = html?.trim() ?? "";
    return { reason, merged, result: reason === null ? read(parse(merged).querySelector("table")!) : null };
  });
}

// Rule 6's shape: a full-width row whose whole text is a bracketed note, reprinted at the top of a
// continued page. Matched on the row being a SINGLE cell as well as on the text, so an ordinary data
// row whose first cell happens to start with a bracket is not eligible to be dropped as a repeat.
//
// Both bracket widths, and the same two as `captionNotes` deliberately: a note the first half writes
// in its caption and the second half repeats as a row is one note, and a reader here that could not
// see the row form of a spelling the caption reader CAN see would copy that row in under rule 1 and
// ship the note twice — the harm the caption rule exists to remove, reintroduced by the two readers
// disagreeing about what a note looks like.
function isUnitNoteRow(row: Element): boolean {
  const cells = [...row.children];
  if (cells.length !== 1) return false;
  return /^[[［].*[\]］]$/.test(normalizeCell(cells[0].textContent ?? ""));
}

// The same note as `isUnitNoteRow` finds, in the other place a half can print it: inside the caption
// under the title, which is where `page.md` now asks for it. Returned as a set of the bracketed runs
// so a note the FIRST half carries in its caption and the second half repeats as a row is recognisable
// as one note in two spellings — `isUnitNoteRow` matches a cell that is wholly `[...]`, and the run
// this pulls out of a caption carries its brackets too, so the two agree without either normalizing
// the other's shape away. Read by `verifyJoin`, which will not let a joined caption lose one, and by
// `joinInCode`, which counts one as grounds to drop the second half's repeat.
//
// Brackets, ASCII and fullwidth, and the whole of #374's delimiter census accounted for rather than
// the part that was convenient: of its 68 delimited notes, 61 are ASCII `[...]`, 6 are parenthesised
// and 1 is the fullwidth `［...］` one arm printed on `p041`. The fullwidth pair is read because it
// costs a character class; the PARENTHESISED spelling is not, and that is a collision rather than a
// preference — `CONTINUED_CAPTION` matches "(continued", so reading parenthesised runs would make a
// kept-note check demand the survival of the one run rule 4 requires to be dropped.
//
// Two shapes are therefore out of reach, and neither is a false refusal — both are a note that can go
// missing without this noticing. A parenthesised note, 6 of the 68. And a note printed with no
// delimiter at all — 3 arm-pages, unanimous across the arms that read them, so it is the ink and not a
// model's invention — which no string test separates from the title.
//
// The delimiters are compared as printed, not folded together: `normalizeCell` takes out soft hyphens
// and collapses whitespace and does nothing to bracket width, so a merge that reprinted an ASCII note
// in fullwidth brackets reads as a note dropped and one added.
//
// Stated as the property rather than as a list of cases, because the list was written twice here and
// was short both times: a note the merge kept in any form this cannot see reads as a note lost. It
// matches on the run's exact characters and finds it only in a caption or a note row, so a rewritten
// delimiter, a reworded note, or a note moved somewhere else in the table all refuse. Every one of
// those refusals is safe — the pair declines and both halves ship — but every one costs a join that
// lost nothing, and the cost is the reason the match is not loosened instead: a looser one would start
// forgiving the drops this exists to catch.
//
// It is also a SHAPE test and not a reading, so what it owes is every bracketed run in either caption
// and not only a note of measure. A caption carrying `[Sheet 2 of 3]` is owed that too, and two
// captions carrying different runs — `[In millions of dollars]` against `[In thousands]` — can be
// satisfied by no joined caption that does not invent, so the pair declines for good and reports the
// loss rather than the disagreement, which is the thing that actually happened and which nothing here
// can name. Left as it is on purpose: every caption bracket in the reference corpus is a note of
// measure, so a reason for the disagreement would be a distinction drawn on no measured pair.
function captionNotes(caption: string): Set<string> {
  return new Set((caption.match(/[[［][^\]］]+[\]］]/g) ?? []).map((n) => normalizeCell(n)));
}

// A note row identified by both of the facts `verifyJoin` compares: its text, and whether it was
// printed inside the header block. Keyed as one string so the two are matched together and neither
// reader can match on one of them alone, which is the failure this replaced.
//
// The pair `fNotes` in `joinInCode` deliberately does NOT use this, and that is not the same
// disagreement over one fact that the header-block reading was: it answers a different question. What
// may be dropped as a REPEAT turns on whether the second half is printing the same note again, and it
// is the same note wherever the printer set it. Whether a note was KEPT or MOVED turns on the place,
// because the place is the harm.
function noteKey(note: { text: string; header: boolean }): string {
  return `${note.header ? "head" : "body"} ${note.text}`;
}

// The header block written as a string that changes whenever anything a reader would notice about it
// changes: every header row's cells in order, each with its tag and its `colspan`. Rule 3 asks which
// structure describes the rows being kept, and the case where that is a real question is the halves
// declaring their columns at different DEPTHS or with different spans — 4 of the corpus's 18 pairs.
// Text alone would call a two-row spanned header equal to the flat one-row header of the other half.
function headerSignature(rows: Element[]): string {
  return rows
    .filter(isHeaderRow)
    .map((r) =>
      [...r.children]
        .map((c) => `${c.tagName}:${c.getAttribute("colspan") ?? 1}:${normalizeCell(c.textContent ?? "")}`)
        .join("|"),
    )
    .join(" // ");
}

// What one half declares as its header block, for the DECLINE LINE rather than for the merge (#326
// ask 2). `joinInCode` needs only the equality above; a round asking why the free path's coverage
// moved needs the two strings that were unequal, and today's event carries a reason and a caption,
// which is enough to count declines and not enough to explain one.
//
// `rows` and `cells` are counted off the DOM and not by splitting `signature` back up, because a
// header cell's own text can contain the separators — `normalizeCell` folds whitespace and drops soft
// hyphens and leaves `|` and `/` alone, so a column headed `Farm | Non-farm` writes a signature no
// reader can re-split correctly. Equality never cared; a count does.
//
// `cells` is every CHILD of a header row and not every `<th>` in one, which is deliberately not
// `read`'s `headerCells` one screen up: this number exists to describe the string beside it, the
// signature is built from all the children, and a `<td>` sitting in a `<thead>` is one of the
// differences worth being able to see — it is the whole of `header_cells_lost`. Two counts of the
// same block under two definitions is a trap, so neither name is shared with the other.
export interface HeaderRead {
  signature: string;
  rows: number;
  cells: number;
}

// Both halves' header blocks, or null if either half is not a table this can read — which is the
// same `null` `read` and `checkJoin` use for markup no parser could handle, and it means "not
// measured", never "no header".
//
// A half with no header ROWS is a different thing and reports `rows: 0` with an empty signature: the
// continued page that reprinted no header is the case rule 3 skips and the width check catches, and
// it is a normal shape in this corpus rather than a failure. The two must stay distinguishable at the
// log line, since one is a fact about the page and the other a fact about the parser.
export function headerSignatures(pair: ContinuationPair): { first: HeaderRead; second: HeaderRead } | null {
  const first = headerRead(pair.first.html);
  const second = headerRead(pair.second.html);
  return first === null || second === null ? null : { first, second };
}

// A signature on a log line is bounded, and the bound says so when it bites. 1,200 rather than the
// 200 the captions use, because the point of the field is a header a reader can compare cell by cell:
// this corpus's widest printed headers are three rows of eleven columns with short labels, which is
// about 750 characters, so a cap here truncates a pathological page and not a real one. Nothing is
// concluded from a capped string — `headers_identical` and the shapes beside it are computed on the
// full text — so the worst a truncation costs is a reader who cannot see WHICH cell moved.
const MAX_SIGNATURE_CHARS = 1200;

function capSignature(s: string): string {
  return s.length <= MAX_SIGNATURE_CHARS ? s : `${s.slice(0, MAX_SIGNATURE_CHARS)}…`;
}

// The two halves' source bytes, so a decline can be RE-SCORED for nothing (#326). The signatures above
// explain a decline; these reproduce it: `pairFromHalves` reads them back into the pair `joinInCode` and
// `verifyJoin` were given, so a candidate loosening of a guard can be run against the pairs a paid round
// already bought instead of against a round that has to be bought to see it. That was the open half of
// #326 — its recommendation against touching a guard rested on the pre-join body being persisted
// nowhere, and the pairs are the part of that body this stage decides on.
//
// Bounded, and the bound REFUSES rather than truncates, which is the one place this block departs from
// `capSignature` above. A cut signature still compares cell by cell as far as it goes; half a table's
// bytes are not a table — they parse to a DIFFERENT table, with fewer rows and no closing markup, and a
// rule scored against them would return a verdict that is not the rule's. A truncation here would be
// silent damage of the kind this pipeline exists to find, so an over-large pair logs its sizes and no
// bytes, and says which it did.
//
// 64,000 characters against every pair this corpus's 75 delivered submissions produce — 200 of them over
// 37 submissions, running 5,898 to 25,938 characters (median 11,026), so the bound is 2.5x the largest
// and drops none of them. That is what it is for: not a size a real pair reaches, but a stop on one
// pathological document. What those 200 pairs actually add is 9–111 KB per submission, median 66 KB.
//
// The ceiling is per line and the per-document one follows from the loop, not from that median. A
// document cannot log more of these blocks than the loop below emits: it runs `pass <= MAX_TABLE_JOINS`
// but breaks at the last pass before choosing a pair, so 12 pairs reach a verdict and 12 blocks is
// 750 KB, against round logs that run 220–940 KB.
//
// The median is a corpus's cost and not a ceiling, and the reason is chains. A table printed across three
// pages is joined one pass at a time, so pass 2's pair is (the pass-1 merge, the third piece) and the
// first two pieces' rows go on a second line — correctly, because that merge is the bytes pass 2 actually
// judged, and a replay of that line has to have them. So a document of long chains sits above the range
// and under the 750 KB, and this corpus has no chains at all: 0 of its 200 lines took the previous line's
// merge as its first half, on 47 lines that had a code join immediately before them.
const MAX_REPLAY_CHARS = 64_000;

// `halves` is on the line whether the bytes are or not, because presence alone cannot be counted: a
// re-score has to be able to say "N of M declines replayable" from the log, and the bound is a constant
// in this file that a reader of an old log has no way to know. Its two values have one producer each —
// the bound, and everything else.
//
// The sizes are always there, so what the bound dropped is measurable when it bites. On a code join
// they are also `chars_before` split in two; that field stays because it is on the PAID joins as well,
// where this block is deliberately absent.
function replayHalves(pair: ContinuationPair): Record<string, unknown> {
  const first = pair.first.html;
  const second = pair.second.html;
  const oversize = first.length + second.length > MAX_REPLAY_CHARS;
  return {
    chars_first: first.length,
    chars_second: second.length,
    halves: oversize ? "too_large" : "logged",
    ...(oversize ? {} : { html_first: first, html_second: second }),
  };
}

function headerRead(html: string): HeaderRead | null {
  const table = parse(html).querySelector("table");
  if (table === null) return null;
  const rows = [...table.querySelectorAll("tr")].filter(isHeaderRow);
  return {
    signature: headerSignature(rows),
    rows: rows.length,
    cells: rows.reduce((n, r) => n + r.children.length, 0),
  };
}

// Every id this element carries or contains. The element ITSELF counts: a `<table id>` or a
// `<caption id>` on the half being dropped is a link target like any other, and `querySelectorAll`
// alone would not see it.
function idsIn(el: Element): string[] {
  return [el, ...el.querySelectorAll("[id]")].filter((e) => e.id !== "").map((e) => e.id);
}

// Did this fragment parse to its table and NOTHING else? A `<p>`, or a run of text between two rows,
// sitting inside a `<table>` is fostered OUT of the table by the HTML parser: it lands beside the
// table in the tree, and the `outerHTML` of the table does not carry it. This is the only place the
// code path can see that, because `verifyJoin` is made of columns, header cells, row counts and
// data-row labels and hoisted prose is none of them. Text is compared as well as elements, so a
// hoisted sentence is caught and insignificant whitespace is not.
function onlyTable(doc: Document, table: Element): boolean {
  if (doc.body.children.length !== 1 || doc.body.children[0] !== table) return false;
  return normalizeCell(doc.body.textContent ?? "") === normalizeCell(table.textContent ?? "");
}

// Take the continuation marker out of a caption WITHOUT flattening it: the marker goes from the one
// text node that carries it and any markup around it is left alone. Assigning `textContent` instead
// — the obvious way to write this — would drop a `<sup>` footnote reference and the `<a id>` an
// endnote links back to, which is rule 2's dangling-IDREF case arriving through a different door.
//
// True when the caption no longer reads as a continuation, including when it never did. False when
// the marker is not wholly inside one text node (`Table 5 —<em>Continued</em>`), which is a caption
// to hand to the editor rather than to guess at; the tried edit is put back first, so the caller
// gets the caption it passed in.
function stripMarker(caption: Element): boolean {
  if (!CONTINUED_CAPTION.test(normalizeCell(caption.textContent ?? ""))) return true;
  for (const node of [...caption.childNodes]) {
    if (node.nodeType !== 3) continue; // TEXT_NODE
    const before = node.nodeValue ?? "";
    const after = before.replace(/\s*[—–\-(]\s*continued\b\)?\.?/i, "");
    if (after === before) continue;
    node.nodeValue = after;
    if (!CONTINUED_CAPTION.test(normalizeCell(caption.textContent ?? ""))) return true;
    node.nodeValue = before;
    return false;
  }
  return false;
}

// Join the two halves with no model call, or say why not.
//
// Three of the six rules the editor is given are "move these bytes and change nothing", and this is
// them: rule 1 (copy every data row from both halves, in order) is an append; rule 2 (keep every id
// and href) is not touching them; rule 4 (one caption, without the marker) is the FIRST half's
// caption, which already has none — only the second's carries it; rule 5 (keep the
// `<th scope="rowgroup">` group labels in place) comes free, because they arrive as ordinary rows in
// the order they were printed.
//
// Rules 3 and 6 ask what the table MEANS, and a decline below is a case where that question CAN be
// real. Declining is the design and not a shortfall in it: the pair goes to the editor exactly as it
// did before this path existed, so a decline costs what today costs and a wrong guess would cost a
// table nothing downstream can see is wrong.
//
// How OFTEN it declines is not a property of this code, and the first draft of this comment stated it
// as one: "on 50 pairs, 26 join here" (#276), which reproduced at 9 of 17 pairs in one round and then
// gave 4 of 17 and 5 of 16 on the same 100-page corpus with this file, `agents/`, the model and the
// prompt all byte-identical — a $0.72/100-page swing in `table_join`, entirely in call count (#326).
// The coverage belongs to the EXTRACTION: two readings of one printed header agree 48–61% of the
// time, so `header_differs` is usually a disagreement between two readings of the same header rather
// than two different headers, and three separate guards were seen firing on pairs that had joined for
// free a round earlier. So the honest figure is a range with its corpus attached — **24–53% of pairs
// over three rounds of ACIR M-16 pp.1-100** — and any change credited with moving it by less than
// about 2x is inside that spread. What has NOT moved is the price of a decline: $0.1124–$0.1285 per
// paid call across the same three rounds, so the whole swing is how many pairs were bought and none
// of it is the pairs getting dearer. On the 50 pairs of #276, `verifyJoin` refused none of the 26 code
// joins; #326 did not re-derive that on its three rounds, so it is one corpus's figure and not a
// standing property either.
//
// The guards are still NOT loosened here, but the reason #326 gave for not touching them has now been
// removed rather than restated: the pre-join assembled body is persisted nowhere, and what a loosening
// has to be scored on is not the body but the pairs, so both halves' bytes go on the decline line and on
// a free join's line (`replayHalves`). A candidate rule is therefore run against the pairs a paid round
// already bought — its upside on the declines and its regressions on the joins it must not break — for
// nothing, and `verifyJoin` runs in that replay too, because `pairFromHalves` rebuilds the same pair
// this function was handed. `headerSignatures` above answers a different question on the same line: why
// a pair was declined, which is the part a reader needs before deciding what to loosen at all.
//
// Two things a decline line still cannot score, both of them upstream of this function. A change to
// which tables are PAIRED (`continuationPairs`: the caption rule, the span match, adjacency) reads the
// whole body, and a pair it never formed leaves no bytes behind — the `unmatched_source` and
// `not_adjacent` declines carry a caption and nothing else. And a change to the EXTRACTION that
// produced the halves is a different document, so replaying it is buying a round. The instability
// measured above lives there, which is why the range in this comment is still one corpus's figure.
//
// A caller must still put the result through `verifyJoin`. Nothing here is trusted on its own —
// which is the whole reason this is safe to add rather than merely cheap: a bad code join is refused
// by the same check that already refuses a bad model join, and falls through to the model.
export function joinInCode(pair: ContinuationPair): { html: string } | { reason: string } {
  const fdoc = parse(pair.first.html);
  const sdoc = parse(pair.second.html);
  const ftab = fdoc.querySelector("table");
  const stab = sdoc.querySelector("table");
  if (ftab === null || stab === null) return { reason: "unreadable" };
  // Before anything is read off them, because what this refuses is content that is no longer INSIDE
  // the table by the time either half has been parsed. See `onlyTable`.
  if (!onlyTable(fdoc, ftab) || !onlyTable(sdoc, stab)) return { reason: "content_outside_table" };

  const frows = [...ftab.querySelectorAll("tr")];
  const srows = [...stab.querySelectorAll("tr")];
  const sHeader = srows.filter(isHeaderRow);

  // Rule 3. Two identical blocks collapse into one by dropping the copy, and a second half with no
  // header block at all — the empty header stub in the middle of a three-piece chain — has nothing
  // to collapse. Anything else is a reading of the table.
  if (sHeader.length > 0 && headerSignature(srows) !== headerSignature(frows)) {
    return { reason: "header_differs" };
  }
  // Where there is no block to compare, the WIDTHS still have to agree: a signature is not the only
  // thing that says how many columns a row may have. A printer that did not reprint the header on
  // the continued page leaves the signature nothing to read, and without this a four-cell row gets
  // appended under a three-column `<thead>` — cells with no header, which is the 1.3.1 defect this
  // stage exists to reduce. `verifyJoin` cannot catch it: `columns_lost` compares the joined table's
  // widest row against the halves' widest, and the appended row IS the widest. Measured against how
  // wide the first half ALREADY is rather than against its header block, because a first half whose
  // own rows already run wider carries a defect this join neither introduced nor deepens. Like
  // `id_would_collide` below, the corpus never reaches it — every continued page in it reprints its
  // header, so rule 3 answers first — and that is the point: it costs nothing measured and it covers
  // the page that does not.
  const width = (row: Element): number =>
    [...row.children].reduce((n, c) => n + (Number(c.getAttribute("colspan")) || 1), 0);
  const fwidth = Math.max(0, ...frows.map(width));
  if (srows.some((r) => !isHeaderRow(r) && width(r) > fwidth)) return { reason: "columns_differ" };

  // Rule 4, before rule 2 below, because what the caption does decides which ids survive. Usually a
  // copy: the first half's caption is the table's title and carries no marker. The exception is the
  // middle piece of a chain, whose caption says "Continued" because it is itself a continued page —
  // shipping that would leave the marker in, and `verifyJoin` refuses it as `still_continued`
  // because the next pass would otherwise pair the joined table with the table BEFORE it, forever.
  const fcap = ftab.querySelector("caption");
  const scap = stab.querySelector("caption");
  // Which bracketed note rows this join drops as repeats, across both halves, checked against rule 6's
  // licence after the append below. The TEXTS and not a count, because whether the joined caption ends up
  // carrying the note decides whether `verifyJoin` sees a row lost or a note promoted.
  const notesDropped: string[] = [];
  if (fcap !== null) {
    if (!stripMarker(fcap)) return { reason: "caption_unclear" };
  } else {
    // No caption to copy, and `verifyJoin` requires one. The second half's caption minus its marker
    // is the printed page's own words for this table, so it is still a move rather than an invention
    // — imported as an ELEMENT, markup, ids and all, for the reason `stripMarker` gives.
    if (scap === null) return { reason: "no_caption_available" };
    const made = fdoc.importNode(scap, true) as Element;
    if (!stripMarker(made) || normalizeCell(made.textContent ?? "") === "") return { reason: "caption_unclear" };
    ftab.insertBefore(made, ftab.firstChild);

    // Rule 6 on the doubling this import CREATES rather than finds. The imported caption now names the
    // units, so a note row the FIRST half printed saying the same thing is the repeat rule 6 licenses
    // dropping, and dropping it here is what keeps this pair free. Both placements are the census's
    // measured ones — the note in a caption on 56 arm-pages, as a row on 12 — so leaving the doubling for
    // `verifyJoin` to refuse as `note_shipped_twice` would buy an editor call on a pair whose page printed
    // the note once, and ship the halves SPLIT wherever that call declined or failed. Not read off
    // `fNotes` below: that set is what may be dropped from the SECOND half, and this is the first half's
    // own row against a caption it did not print.
    const importedNotes = captionNotes(made.textContent ?? "");
    for (const row of frows) {
      const text = normalizeCell(row.textContent ?? "");
      if (!isUnitNoteRow(row) || !importedNotes.has(text)) continue;
      // Both spellings of the row are dropped, `<td>` and `<th>`, and the note reasons below are what
      // judges the result. This needed `read`'s `headerCells` to stop counting a note row's `<th>` as a
      // header cell first: `header_cells_lost` is asked before any note reason, so while it did, dropping
      // a `<th colspan>` note row out of `<thead>` reported a header block collapsing — rule 3's defect —
      // for a drop rule 6 licensed. Guarding the drop here was the wrong half of that: the same count
      // refused the EDITOR's rule-6-obedient answer too, and there the price is a split table.
      // An id inside that row has nowhere to go, and nothing else would say so: the id checks at the end
      // read the SECOND half's ids against the finished table, because this is the only place a FIRST
      // half's row is dropped. Declined rather than moved — where a footnote anchor belongs on the
      // surviving markup is a reading of the table, which is rule 2's case for the editor.
      if (idsIn(row).length > 0) return { reason: "id_would_be_lost" };
      row.remove();
      notesDropped.push(text);
    }
  }

  // Rule 2, over the WHOLE half being dropped and not only its repeated header block, because the
  // ids that half carries do not all sit in the same kind of place. Measured over the corpus's 50
  // pairs, a join that drops the second half wholesale would drop 87 ids, and 73 of them are pointed
  // at by something in the delivered document — an endnote's back-link, a contents entry, an
  // `aria-labelledby`. None of that is visible to `verifyJoin`, which reads columns, header cells,
  // rows and labels and never reads an id.
  //
  // Two kinds, with different answers:
  //
  //  * An id on the dropped half's own `<caption>` or `<table>` element has a counterpart that
  //    SURVIVES this join, so the id MOVES onto it. `#table7-continued-label` pointed at the second
  //    half of table 7; after the join, the joined table's caption is what that half was, so the
  //    link lands where its text always meant. This is 17 of the 87, 13 of them live, and it is
  //    mechanical — no reading of the table is involved in knowing that a caption's counterpart is a
  //    caption. Only onto a counterpart with NO id of its own: two live targets collapsing into one
  //    element is a choice about which link keeps working, and that choice is the editor's.
  //  * Anything else has no counterpart, because the markup holding it is what rule 3 and rule 4
  //    drop: 70 ids in this corpus, 60 of them live — 52 footnote-reference anchors and 15 header
  //    cells inside the repeated header block, and 3 anchors inside the dropped half's own caption.
  //    Deciding which cell of the SURVIVING block a footnote anchor belongs on is a reading of the
  //    table, so the pair goes to the editor.
  const moveId = (from: Element | null, to: Element | null): boolean => {
    if (from === null || from.id === "") return true; // nothing to move
    if (to === null || to.id !== "") return false; // nowhere to put it that is not already a target
    to.id = from.id;
    return true;
  };
  if (!moveId(stab, ftab)) return { reason: "id_would_be_lost" };
  // The caption only where the first half HAS one. Where it does not, the second half's caption was
  // imported whole above and brought its id with it.
  if (fcap !== null && !moveId(scap, fcap)) return { reason: "id_would_be_lost" };

  // Rule 6's repeats are judged against the note the first half already carries — in a row, or in its
  // CAPTION, which is where `page.md` now asks for it. Both, because the two halves need not agree: a
  // pair whose first half puts the note under the title and whose second half still prints it as a
  // full-width row is one note printed twice, and reading only the rows would call it a note the first
  // half does not carry. That answer is `note_repeat_unclear`, which declines the free join and buys a
  // Copy Editor call for a pair with nothing to judge — and the placements do vary within one arm
  // (#374's census: 56 of 68 in the caption, 12 outside it), so the disagreement is reachable as soon
  // as the page rule lands. What is NOT folded in is the second half's caption: a note only the
  // continued half carries says something about the continued rows, and rule 6 licenses dropping a
  // repeat rather than a first appearance.
  //
  // That asymmetry is about DROPPING and about nothing else. What the joined caption must still say is
  // `verifyJoin`'s question, and it is answered over both halves' captions there — a note printed over
  // the second half is still part of the table's name, and this half of the code declining to call it a
  // repeat is not a licence to lose it.
  const fNotes = new Set(frows.filter(isUnitNoteRow).map((r) => normalizeCell(r.textContent ?? "")));
  for (const note of captionNotes(fcap?.textContent ?? "")) fNotes.add(note);

  // Where the second half's rows go: the first half's last `<tbody>`, or the table itself when it
  // has none. Appending to the element the first half's data rows already live in is what keeps rule
  // 5's group labels in place. A first half with a `<tfoot>` and no `<tbody>` is declined rather
  // than appended to — rows written after a `<tfoot>` read as coming after the table's own summary,
  // which is a change to reading order and not a move of bytes.
  const bodies = [...ftab.querySelectorAll("tbody")];
  const target = bodies.length > 0 ? bodies[bodies.length - 1]! : ftab;
  if (target === ftab && ftab.querySelector("tfoot") !== null) return { reason: "tfoot_no_tbody" };

  for (const row of srows) {
    if (isHeaderRow(row)) continue; // the duplicate block, dropped by rule 3
    if (isUnitNoteRow(row)) {
      // Rule 6 licenses dropping a REPEAT. A bracketed note the first half does not carry says
      // something about the continued rows, and both keeping it mid-table and dropping it change how
      // the table reads.
      if (fNotes.has(normalizeCell(row.textContent ?? ""))) {
        notesDropped.push(normalizeCell(row.textContent ?? ""));
        continue;
      }
      return { reason: "note_repeat_unclear" };
    }
    target.appendChild(fdoc.importNode(row, true));
  }

  // Rule 6 licenses dropping A repeat, and `JOIN_DROPPABLE_ROWS` is the one row `verifyJoin`'s floor
  // forgives for it. Asked the way the floor asks it — `max` of that one row and the rows the finished
  // CAPTION accounts for, never their sum — because the two have to agree about the same table. A row whose
  // note the caption carries is forgiven at the `rows_lost` site by name, so counting it here would decline
  // a pair this path's own verifier accepts; counting it as free on TOP produces one the verifier refuses,
  // and that is the worse of the two errors, because the refusal arrives as a row count after the editor
  // has been paid for an answer the same floor refuses again, and then the halves ship split. This comment
  // claimed the second could not happen, for one commit: a pair dropping one covered row and one uncovered
  // one passed a licence that counted only the uncovered ones. Ways past the bound, none of them measured
  // — a half printing such a row twice itself, a mixed pair whose first half prints the note as a row while
  // the second prints it in both places, and two distinct notes on one table, which is 0 of the 769 tables
  // in the round logs. On the last of those a correct join exists and this declines it, and the editor's
  // answer would be refused too: the floor licenses the caption's rows and ONE repeat, not two.
  const keptNotes = captionNotes(ftab.querySelector("caption")?.textContent ?? "");
  const covered = notesDropped.filter((t) => keptNotes.has(t)).length;
  if (notesDropped.length > Math.max(JOIN_DROPPABLE_ROWS, covered)) {
    return { reason: "note_repeats_exceed_licence" };
  }

  // Both id checks, off the FINISHED table, in one traversal.
  //
  // Rule 2's, first, because the appending above is what decides which of the dropped half's ids
  // actually survived and a check written before it has to PREDICT that. The prediction was wrong for
  // an id inside a note row rule 6 drops as a repeat: counted as surviving because the row is not a
  // header row, then dropped with the row, and nothing downstream reads ids. Read after the fact
  // instead, so what it reports is what the join did.
  //
  // Then: nothing may carry an id twice. A duplicate is a 4.1.1 defect the join itself would have
  // INTRODUCED, and it is invisible everywhere else too — `verifyJoin` does not read ids, and the
  // label set is matched over cell TEXT. It covers the appended rows, the moved caption id and the
  // moved table id together. The corpus never hits it — the page agent prefixes its anchors with the
  // page number (`p7-fnref-2`), so two halves cannot collide — which is the point: it costs nothing
  // measured and it covers the day that stops holding.
  const all = idsIn(ftab);
  const survived = new Set(all);
  if (idsIn(stab).some((id) => !survived.has(id))) return { reason: "id_would_be_lost" };
  if (survived.size !== all.length) return { reason: "id_would_collide" };
  return { html: ftab.outerHTML };
}

// One pair, put to the editor. Null when nothing usable came back — including a decline, which is
// an answer and not a failure.
async function joinCall(
  ctx: PipelineContext,
  pair: ContinuationPair,
): Promise<{ html: string | null; declined: boolean; log?: string }> {
  const user =
    `## First half\n${pair.first.html}\n\n` +
    `## Second half (its caption says it continues the first)\n${pair.second.html}\n\n` +
    `Return the two halves as one table.` +
    feedbackPreamble(ctx);
  // No page images. The judgement asked for is structural and both halves are in the prompt in
  // full, including their captions and their header blocks — which is everything the printed page
  // could add about whether these are one table, since the page is what printed them as two. It
  // also keeps this off the vision path, so a document with seven splits buys seven text calls
  // rather than fourteen image uploads. If a measurement ever shows the join needs the page, the
  // attribution is available: assembly holds the fragments these spans came from.
  const res = await ctx.router.complete(
    "copy_editor",
    "text",
    [
      { role: "system", content: TABLE_JOIN_SYSTEM },
      { role: "user", content: user },
    ],
    { step: "table_join" },
  );
  ctx.log.agentCall({
    agent: {
      name: "copy_editor",
      // A different file name from the review round's editor for the same agent NAME: the model and
      // any per-agent override are the deployment's copy-editor ones, deliberately, because this is
      // copy-editing — while the ledger has to be able to tell a join call from a correction round,
      // which share neither prompt nor contract. `phase` says it too; the name says it in the field
      // anything reading these records already groups by.
      file: "copy_editor_table_join.md",
      content: TABLE_JOIN_SYSTEM,
      capabilities: ["text"],
      sha: null,
      sessionBuilt: false,
    },
    phase: "assembly",
    output: res.text,
  });
  const parsed = extractJson<{ html?: string | null; declined?: boolean; log?: string }>(res.text);
  return {
    html: parsed?.html?.trim() || null,
    declined: parsed?.declined === true,
    log: typeof parsed?.log === "string" ? parsed.log.replace(/\s+/g, " ").trim().slice(0, 300) : undefined,
  };
}

// A pair, identified by what it IS rather than by where it is or what it is called. Two things rule
// out the easier keys. A caption is not unique: the three-piece chain below has a middle piece and a
// third piece that both caption as "…—Continued", so keying on the caption makes a refusal of the
// first pair silently refuse the second — a joinable pair abandoned with nothing in the log, since
// `pending` counts by the same key and would read 0. And an offset is not stable: a splice earlier in
// the body moves every span after it, so a refused pair would be asked again on the next pass. The
// bytes of both halves are both unique and stable, and two pairs whose bytes are identical would get
// identical answers, so sharing one refusal between them is correct rather than merely tolerable.
// The separator is written as an escape and not as a literal control byte: a raw NUL in the source
// makes every ordinary text tool, `grep` included, read this file as binary and stop reading it.
const pairKey = (p: ContinuationPair) => `${p.first.html}\u0000${p.second.html}`;

// A parse, which is the one thing in this stage that can throw, and the reason "never throws" below
// needs enforcing rather than asserting. jsdom builds the tree by recursion, so a body nested a few
// hundred thousand levels deep — measured: 200,000 `<div>`s, or the same nesting inside a table cell
// — raises `RangeError: Maximum call stack size exceeded` out of the parser itself. That shape is not
// hypothetical here: `anchors.ts` refuses to rewrite a page past 500 levels and delivers it as
// written, so a document reaching this stage can carry arbitrary nesting, and `assembly.ts` already
// names it as the reachable case for the LINT overflowing. The lint's throw is caught and delivered
// as `@lint-unavailable` (#164); an uncaught one here would fail the session instead, on a document
// that shipped before this stage existed. Returns null so the caller can decline the pair — or the
// whole document — the way it declines everything else.
function attempt<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

// Join the halves of every table this body split across a page break, and return the body that
// results. Never throws: a document that cannot be joined is the document this stage was added to,
// so every failure here leaves the body exactly as it arrived.
//
// One pair per pass, re-reading the body after each join, which is what makes a three-piece table
// work: `runs-231`'s Table 15 ships as 21 + 0 + 39 rows, and the middle piece is an empty header
// stub. Joining the first two produces a table the third then continues, so the chain closes by
// running the same step again rather than by a special case. Termination is the caption rule — a
// successful join is one whose caption no longer says "Continued" (`verifyJoin`), so each pass
// leaves one fewer marked table — with `MAX_TABLE_JOINS` behind it.
export async function joinContinuedTables(ctx: PipelineContext, body: string): Promise<string> {
  // Before any parsing. `continuationPairs` reads the body with jsdom and then reads every table
  // span again, and on this pipeline's documents that is the one thing here with a cost worth
  // avoiding on the documents that cannot need it — a body with no `<table>` in it, or no
  // continuation marker anywhere in its bytes, has no pair by construction. The marker test is the
  // caption rule applied to the whole body, so it over-matches (prose saying "(continued on page
  // 4)") in the safe direction: it lets the parse run and the parse finds nothing.
  if (!/<table\b/i.test(body) || !CONTINUED_CAPTION.test(body)) return body;

  let current = body;
  let joined = 0;
  let pending = 0;
  const refused = new Set<string>();
  for (let pass = 0; pass <= MAX_TABLE_JOINS; pass++) {
    const found = attempt(() => continuationPairs(current));
    // The body could not be read at all, so there is nothing to join and nothing to say about what
    // it holds. It ships as it arrived — which is the same body every other failure here ships —
    // and the line says which failure it was, because a document with continuation markers in it
    // and no `table_continuations` line would otherwise look like a document with none.
    if (found === null) {
      ctx.log.event("table_join_failed", { reason: "read_failed", stage: "body" });
      return current;
    }
    // What is left when the cap is what stopped this, rather than the document running out of
    // pairs. Read on the pass AFTER the last join, which is why the loop is allowed one more turn
    // than it may join: a "capped" line has to mean pairs remain, or it reads as a bound being hit
    // on a document that was in fact finished.
    pending = found.pairs.filter((p) => !refused.has(pairKey(p))).length;
    if (pass === MAX_TABLE_JOINS) break;
    if (pass === 0) {
      if (found.pairs.length === 0 && found.declined.length === 0) return current;
      ctx.log.event("table_continuations", {
        tables: found.tables,
        pairs: found.pairs.length,
        ...(found.declined.length ? { declined: found.declined.length } : {}),
      });
      // Logged per pair on the first pass only: a pair the source cannot locate is a fact about
      // the bytes as they arrived, and re-stating it on every later pass would multiply one
      // document's defect by the number of joins the rest of it happened to need.
      for (const d of found.declined) {
        ctx.log.event("table_join_failed", { reason: d.reason, caption: d.caption.slice(0, 200) });
      }
    }
    // A pair the editor already refused, or answered badly, is not asked again: the next pass would
    // send the same two tables to the same prompt. Without this the loop spends MAX_TABLE_JOINS
    // requests on one unjoinable pair and never reaches the joinable one after it.
    const pair = found.pairs.find((p) => !refused.has(pairKey(p)));
    if (!pair) break;

    // The splice, shared by both paths: the first half's span becomes the joined table and the
    // second half's span goes. Whatever sat BETWEEN them — a page-break `<hr>`, a `<p>` carrying the
    // printed page's running head — is left exactly where it is, which is now after the joined
    // table. Moving it there is a change to reading order and is the honest one available: dropping
    // it would lose content, and there is no inside of a table for it to sit in.
    //
    // `by` is on the line because it is what a cost round has to read: the same repair now arrives
    // two ways, and the one that spent output tokens is the one worth counting.
    const splice = (checked: Checked, by: "code" | "editor", editorLog?: string) => {
      current =
        current.slice(0, pair.first.start) +
        checked.merged +
        current.slice(pair.first.end, pair.second.start) +
        current.slice(pair.second.end);
      joined++;
      ctx.log.event("table_joined", {
        by,
        caption: checked.result.caption.slice(0, 200),
        rows_first: pair.first.rows,
        rows_second: pair.second.rows,
        rows_joined: checked.result.rows,
        chars_before: pair.first.html.length + pair.second.html.length,
        chars_after: checked.merged.length,
        // The halves on a FREE join only, and the presence rule is `by` — which is on every line, so
        // the population is countable rather than chosen by a missing field. A loosening cannot be
        // scored on the declines alone: those are its upside, and the pairs it must not break are the
        // ones the free path already takes, so those need their bytes too.
        //
        // A paid join does not repeat them because the decline line immediately before it is the same
        // pair's bytes — every editor call in this loop is preceded by one — and `pairKey` is those two
        // strings, so the two lines can be matched on the bytes themselves rather than on their order.
        ...(by === "code" ? replayHalves(pair) : {}),
        ...(editorLog ? { editor_log: editorLog } : {}),
      });
    };

    // Code first. `joinInCode` stands down wherever the merge needs a reading of the table, and
    // whatever it does produce is put through the same `verifyJoin` the editor's answer has to
    // clear — so this adds no new trust, only a cheaper first attempt at the pairs where the rules
    // are "move these bytes". The reason it stood down is logged on every pair it did not take,
    // because the share it takes is the number a later round has to be able to re-measure, and a
    // round that only sees `table_joined` cannot tell a code join from a paid one.
    const coded = attempt(() => joinInCode(pair));
    const codeChecked = coded !== null && "html" in coded ? checkJoin(pair, coded.html, false) : null;
    if (codeChecked !== null && codeChecked.reason === null) {
      splice(codeChecked as Checked, "code");
      continue;
    }
    // Both halves' header blocks go on the line, on EVERY decline and not only on `header_differs`
    // (#326 ask 2). Two reasons it is not scoped to the rule that reads them. One, the finding that
    // asked for this is that the coverage of this whole path tracks how steadily the extraction reads
    // a printed header, and three different guards — rule 3, the width check and the id rule — were
    // seen firing on pairs that had joined for free a round earlier, so a header comparison is
    // evidence about a `columns_differ` decline too. Two, a field present on some declines and absent
    // on others cannot be counted: the denominator would be chosen by the reason.
    //
    // Absent altogether when a half holds no `<table>` for `headerRead` to find, or when parsing a half
    // throws. Absence therefore does NOT mean the `unreadable` reason, and this comment said it did:
    // `read_failed` has TWO producers below and they differ on exactly this. `coded === null` is
    // `joinInCode` throwing on a half no parser can read (`attempt`'s 200,000-level case, which
    // `anchors.ts` delivers as written), and `headerSignatures` reads those same two halves — so that
    // line carries `read_failed` with all seven fields absent. The other one, `codeChecked === null`, is
    // `checkJoin` throwing on the MERGED candidate, where both halves read fine and all seven fields are
    // present. So neither direction of the shorthand holds: absence does not name a reason, and
    // `read_failed` does not predict absence.
    //
    // `headers_identical` is string equality on the FULL signatures and is computed here rather than
    // left to a reader of the two capped strings, because a cap that cut both at the same prefix would
    // read as agreement — the truncation would manufacture the stability this line exists to measure.
    // It is not the same question rule 3 asked: rule 3 skips the comparison where the second half has
    // no header block at all, and that pair reports `false` here beside a zero cell count, which is a
    // page that reprinted no header rather than two readings disagreeing.
    //
    // The four counts are what lets whoever counts exclude that case, and they are four NUMBERS rather
    // than the two `rows x cells` strings this line carried first, because a consumer had to parse the
    // rows back out of a string prefix to find it — and a header ROW holding no cells (`1x0`) has an
    // empty signature while reading as a real row, so it slipped a `rows`-based test and inflated the
    // very denominator the shapes were added to protect. `cells` is the field that answers "was there a
    // header block here at all"; `rows` stays because it separates a page that reprinted nothing
    // (`0`/`0`) from one that reprinted an empty row.
    const headers = attempt(() => headerSignatures(pair));
    ctx.log.event("table_join_code_declined", {
      reason:
        coded === null
          ? "read_failed"
          : "reason" in coded
            ? coded.reason
            : codeChecked === null
              ? "read_failed"
              : `verify:${codeChecked.reason}`,
      caption: pair.second.caption.slice(0, 200),
      // Present on every decline, INCLUDING the two where the header fields below are absent — those
      // are the declines a parse threw on, and the bytes that threw are exactly what a fix has to be
      // run against. So absence of the header block does not travel with absence of the halves.
      ...replayHalves(pair),
      ...(headers === null
        ? {}
        : {
            headers_identical: headers.first.signature === headers.second.signature,
            header_rows_first: headers.first.rows,
            header_cells_first: headers.first.cells,
            header_rows_second: headers.second.rows,
            header_cells_second: headers.second.cells,
            header_first: capSignature(headers.first.signature),
            header_second: capSignature(headers.second.signature),
          }),
    });

    let answer: Awaited<ReturnType<typeof joinCall>>;
    try {
      answer = await joinCall(ctx, pair);
    } catch (e) {
      // A join is a repair of something already delivered, so nothing it does is worth failing a
      // session over. Truncation is named because it is the one with a remedy an operator can act
      // on — the two halves together are longer than this deployment's `max_tokens` will answer —
      // and it is not pre-empted by a size estimate for the reason `correctBySection` gives: the
      // measurement is on the error, and a guess in front of the call is not one.
      ctx.log.event("table_join_failed", {
        reason: isTruncatedResponseError(e) ? "truncated" : "call_failed",
        caption: pair.second.caption.slice(0, 200),
        error: (e as Error).message.slice(0, 300),
      });
      refused.add(pairKey(pair));
      continue;
    }
    // The rest of the pair's fate is `checkJoin`'s, the same as the code attempt above: a reply this
    // stage cannot read is a reply it cannot check, which is `read_failed` for this pair and not for
    // the document — the rest of it is still joinable and the pass after this one goes on to the
    // next pair.
    const checked = checkJoin(pair, answer.html, answer.declined);
    const reason = checked === null ? "read_failed" : checked.reason;
    if (checked === null || checked.reason !== null) {
      ctx.log.event("table_join_failed", {
        reason,
        caption: pair.second.caption.slice(0, 200),
        rows_first: pair.first.rows,
        rows_second: pair.second.rows,
        ...(answer.log ? { editor_log: answer.log } : {}),
      });
      refused.add(pairKey(pair));
      continue;
    }
    splice(checked as Checked, "editor", answer.log);
  }
  if (pending > 0) {
    ctx.log.event("table_joins_capped", { joined, pending, max: MAX_TABLE_JOINS });
  }
  return current;
}
