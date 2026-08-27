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
  const match = (piece: TablePiece): number =>
    spanPieces.findIndex((p) => p !== null && p.caption === piece.caption && p.rows === piece.rows);

  const pairs: ContinuationPair[] = [];
  const declined: { caption: string; reason: string }[] = [];
  for (let i = 1; i < tables.length; i++) {
    const second = read(tables[i]);
    if (!CONTINUED_CAPTION.test(second.caption)) continue;
    const first = read(tables[i - 1]);
    const a = match(first);
    const b = match(second);
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
// The row check is on the LABELS and by set rather than by count. By set, because a legitimate join
// drops rows on purpose — the repeated header, the repeated unit note — and every label those rows
// carry still exists in the table once. As labels, because the alternative is a row count, and a
// row count cannot tell a dropped repeat from a dropped state.
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
  if (joined.rows < Math.max(pair.first.rows, pair.second.rows)) return "rows_lost";
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
    const found = continuationPairs(current);
    // What is left when the cap is what stopped this, rather than the document running out of
    // pairs. Read on the pass AFTER the last join, which is why the loop is allowed one more turn
    // than it may join: a "capped" line has to mean pairs remain, or it reads as a bound being hit
    // on a document that was in fact finished.
    pending = found.pairs.filter((p) => !refused.has(p.second.caption)).length;
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
    const pair = found.pairs.find((p) => !refused.has(p.second.caption));
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
      refused.add(pair.second.caption);
      continue;
    }
    const reason = answer.declined
      ? "declined"
      : answer.html === null
        ? "no_output"
        : verifyJoin(pair, answer.html);
    if (reason !== null) {
      ctx.log.event("table_join_failed", {
        reason,
        caption: pair.second.caption.slice(0, 200),
        rows_first: pair.first.rows,
        rows_second: pair.second.rows,
        ...(answer.log ? { editor_log: answer.log } : {}),
      });
      refused.add(pair.second.caption);
      continue;
    }
    const merged = answer.html!.trim();
    const result = read(parse(merged).querySelector("table")!);
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
