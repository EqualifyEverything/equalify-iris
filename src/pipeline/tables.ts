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
// So the merge itself is asked of the Copy Editor, one pair at a time, and everything around it is
// deterministic: which tables are halves of one table, where their bytes are, and — the part that
// makes asking safe — whether the answer kept every row. See `verifyJoin`.
//
// Nothing here reserializes the body. `roles.ts` and `anchors.ts` both refuse a whole-body
// parse-and-reserialize on purpose, because a round trip moves content out of tables and
// `review_converged` compares body strings; the same prohibition applies with the same force to a
// stage that runs before review. This parses only to READ — which tables there are, what their
// captions and rows say — and edits the body as a string, splicing at spans it has checked against
// the DOM it read (see `tableSpans`).
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
  headerRows: number;
  headerCells: number;
  // The first cell of every DATA row, normalized and non-empty: on these tables that is the row's
  // label — the state, the tax, the year — which is what a reader loses when a join drops rows,
  // and what `verifyJoin` requires to survive. Not the numbers: a label is a string worth looking
  // for, and a cell reading "4.1" says nothing about which row it came from.
  //
  // Header rows are excluded, because merging the two halves' header blocks into one is the
  // judgement being asked for: a header cell that reads "Col 1" in the input and something better
  // in the answer is the repair, not a loss. What counts as a header row is a row inside `<thead>`
  // — all 48 tables in the corpus put theirs there, and all 92 of their multi-cell all-`<th>` rows
  // are inside one — plus, for a table that has no `<thead>` at all, a row of more than one cell
  // that is all `<th>`. A one-cell all-`<th>` row is NOT excluded: that is a
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
      .filter(isHeaderRow)
      .reduce((n, r) => n + [...r.children].filter((c) => c.tagName === "TH").length, 0),
    labels: rows
      .filter((r) => !isHeaderRow(r))
      .map((r) => normalizeCell(r.children[0]?.textContent ?? ""))
      .filter(Boolean),
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
5. Keep <th scope="rowgroup"> group headers where either half has them, in place.
6. A bracketed unit note that both halves repeat as a full-width row (e.g. "[In millions of
   dollars]") belongs once, at the top. Keep the first and drop the repeat.

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
// raise the depth), so the depth gate is where the two are separated. Deflating the depth instead —
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
  if (joined.rows < rowFloor(pair, joined)) return "rows_lost";
  // Every label from either half, somewhere in the joined table's cells — not necessarily as a
  // first cell, because a join that adds a column legitimately moves the label along one, and a
  // guard that refuses that would refuse the repair it exists to protect.
  const cells = new Set([...tables[0].querySelectorAll("th,td")].map((c) => normalizeCell(c.textContent ?? "")));
  const lost = [...new Set([...pair.first.labels, ...pair.second.labels])].filter((l) => !cells.has(l));
  if (lost.length > 0) return `labels_lost:${lost.length}`;
  return null;
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
    {},
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
    // The verdict and the joined table's own figures together, because both of them parse the reply
    // and a parse can throw (see `attempt`). A reply this stage cannot read is a reply it cannot
    // check, which is `read_failed` for this pair and not for the document: the rest of it is still
    // joinable and the pass after this one goes on to the next pair.
    const checked = attempt(() => {
      const reason = answer.declined ? "declined" : answer.html === null ? "no_output" : verifyJoin(pair, answer.html);
      const merged = answer.html?.trim() ?? "";
      return { reason, merged, result: reason === null ? read(parse(merged).querySelector("table")!) : null };
    });
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
    const { merged, result } = checked as { merged: string; result: TablePiece };
    // The splice: the first half's span becomes the joined table and the second half's span goes.
    // Whatever sat BETWEEN them — a page-break `<hr>`, a `<p>` carrying the printed page's running
    // head — is left exactly where it is, which is now after the joined table. Moving it there is
    // a change to reading order and is the honest one available: dropping it would lose content,
    // and there is no inside of a table for it to sit in.
    current =
      current.slice(0, pair.first.start) +
      merged +
      current.slice(pair.first.end, pair.second.start) +
      current.slice(pair.second.end);
    joined++;
    ctx.log.event("table_joined", {
      caption: result.caption.slice(0, 200),
      rows_first: pair.first.rows,
      rows_second: pair.second.rows,
      rows_joined: result.rows,
      chars_before: pair.first.html.length + pair.second.html.length,
      chars_after: merged.length,
      ...(answer.log ? { editor_log: answer.log } : {}),
    });
  }
  if (pending > 0) {
    ctx.log.event("table_joins_capped", { joined, pending, max: MAX_TABLE_JOINS });
  }
  return current;
}
