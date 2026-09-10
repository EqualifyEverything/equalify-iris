// A table printed across a page break ships as two tables with duplicate headers and no
// connection between them, and no page agent can fix it: each printed page is its own call, so the
// agent that wrote the second half had one image and the other half was not on it (#239). It knew —
// all 18 continuation captions in `runs-231` say "Continued" — and emitted a fresh `<table>`
// because it had nothing to append to.
//
// So the join is asked of the Copy Editor once the pages are joined, and everything around the ask
// is deterministic and pinned here: which tables are halves of one table (the caption rule),
// where their bytes are (the span match), whether the answer kept the table (`verifyJoin`), and
// what the splice does to the body. The last one matters most: this stage edits the delivered
// document, so a bug here is content lost from output nobody re-reads.
//
// The numbers in these tests are the corpus's. Each fixture is the shape of a real pair, reduced
// to the smallest thing that still asks the same question.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTINUED_CAPTION,
  MAX_TABLE_JOINS,
  TABLE_JOIN_SYSTEM,
  continuationPairs,
  headerSignatures,
  joinContinuedTables,
  joinInCode,
  normalizeCell,
  pairFromHalves,
  tableSpans,
  verifyJoin,
} from "../src/pipeline/tables.ts";
import { assembleBody, runAssembly } from "../src/pipeline/assembly.ts";
import type { Fragment } from "../src/pipeline/fragment.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";

// A table half: a caption, a header row, and one row per label.
function piece(caption: string, labels: string[], cols = 3, colName = "Col"): string {
  const head = `<tr>${Array.from({ length: cols }, (_, c) => `<th scope="col">${colName} ${c + 1}</th>`).join("")}</tr>`;
  const rows = labels
    .map((l) => `<tr><th scope="row">${l}</th>${Array.from({ length: cols - 1 }, () => "<td>1.0</td>").join("")}</tr>`)
    .join("");
  return `<table><caption>${caption}</caption><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

// A half whose header block words the same columns differently. Two of these do not join in code —
// `joinInCode` will not choose between two header blocks, which is `header_differs`, the corpus's
// commonest decline at 17 of its 50 pairs — so every test below that means to exercise the EDITOR
// builds its second half with this. With `piece` on both sides the code path joins the pair itself
// and the model is never asked, and a test naming a request would pass while asserting nothing
// about one.
const reworded = (caption: string, labels: string[], cols = 3) => piece(caption, labels, cols, "Column");

const STATES = ["Alabama", "Alaska", "Arizona", "Arkansas", "California"];
const REST = ["Vermont", "Virginia", "Washington"];

interface Recorded {
  events: { type: string; data: Record<string, unknown> }[];
  calls: string[];
}

// A context whose only agent is the join, answering with `reply(userPrompt, nth)`.
function ctxWith(reply: (user: string, nth: number) => string): { ctx: PipelineContext; rec: Recorded } {
  const rec: Recorded = { events: [], calls: [] };
  const ctx = {
    router: {
      complete: async (_agent: string, _cap: string, messages: { role: string; content: string }[]) => {
        const user = messages[messages.length - 1].content;
        rec.calls.push(user);
        return { text: reply(user, rec.calls.length - 1) };
      },
    },
    log: {
      event: (type: string, data: Record<string, unknown> = {}) => rec.events.push({ type, data }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
  return { ctx, rec };
}

const envelope = (html: string | null, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ html, log: "merged", ...extra });

// A join that keeps everything: both halves' rows under the first half's header, caption unmarked.
function goodJoin(caption: string, first: string[], second: string[], cols = 3): string {
  return piece(caption, [...first, ...second], cols);
}

const events = (rec: Recorded, type: string) => rec.events.filter((e) => e.type === type);

// --- which tables are halves of one table ---

test("the caption rule reads a continuation marker and not the word", () => {
  // All four spellings in the corpus, and the shape that makes the loose rule wrong. Requiring the
  // marker at the END of the caption drops 4 of the corpus's 18; requiring the `Table N` stem to
  // repeat drops 8, because a second half often keeps the title and loses the number.
  for (const yes of [
    "Table 1.—Per Capita Personal Income, by State—Continued",
    "Composition of Personal Income, by State, 1960 (Percentage distribution) — Continued",
    "TABLE 10.—State and Local Tax Collections, by Source, by State, 1960 1—Continued[In millions of dollars]",
    "Table 25 (continued).—States Arrayed in Order of Tax Effort Indexes",
  ]) {
    assert.ok(CONTINUED_CAPTION.test(yes), `should read as a continuation: ${yes}`);
  }
  for (const no of [
    "Table 5.—Programs continued from 1959 to 1960",
    "Table 6.—Continuing Resolutions",
    "Table 7.—Per Capita Income",
  ]) {
    assert.ok(!CONTINUED_CAPTION.test(no), `should not: ${no}`);
  }
});

test("a continuation is paired with the table before it, and its bytes are found", () => {
  const body = `<h2>Income</h2>${piece("Table 1.—Income by State", STATES)}<hr role="doc-pagebreak">${piece("Table 1.—Income by State—Continued", REST)}`;
  const { pairs, declined, tables } = continuationPairs(body);

  assert.equal(tables, 2);
  assert.equal(declined.length, 0);
  assert.equal(pairs.length, 1);
  // The spans are the bytes, so a splice at them is an edit to the source and not a
  // reserialization of it — which is the constraint roles.ts and anchors.ts both hold.
  assert.equal(body.slice(pairs[0].first.start, pairs[0].first.end), piece("Table 1.—Income by State", STATES));
  assert.equal(body.slice(pairs[0].second.start, pairs[0].second.end), piece("Table 1.—Income by State—Continued", REST));
  // The DATA rows' labels. The header block's cells are not in here: merging the two halves'
  // headers into one is the judgement being asked for, so a header cell that changes is the repair
  // rather than a loss.
  assert.deepEqual(pairs[0].first.labels, STATES);
  assert.deepEqual(pairs[0].second.labels, REST);
});

test("a table between the halves is not a seam", () => {
  // The corpus has an adjacent, header-identical pair that is Table 13's continuation followed by
  // Table 14 — three tables sharing a byte-identical header block. Pairing is by position, so what
  // protects that case is the requirement that the two halves be adjacent in the source as well as
  // in the DOM: here the continuation's predecessor in the DOM is the table between them, and no
  // pair reaches across it.
  const body =
    piece("Table 13.—Yield", STATES) + piece("Table 14.—Yield by Type", STATES) + piece("Table 13.—Yield—Continued", REST);
  const { pairs } = continuationPairs(body);
  assert.equal(pairs.length, 1);
  // Paired with the table it is adjacent to, which is Table 14 — the wrong table, and the reason
  // `verifyJoin` and the editor's own decline both have to exist. What is pinned here is that the
  // pairing is local: nothing searches backwards for a better match, so nothing can reach past a
  // table to find one.
  assert.equal(pairs[0].first.caption, "Table 14.—Yield by Type");
});

test("a source whose tables the bytes do not delimit is declined rather than spliced", () => {
  // `runs-231`'s third chunk: 8 balanced `<table>` spans against 16 tables in the parsed DOM,
  // because that document shipped an unclosed `<table>` (#240, since fixed) and the parser
  // recovered tables the bytes do not bound. 14 of the corpus's 18 pairs are still locatable there
  // and 4 are declined — a splice at a span that is not the table it was matched to would move rows
  // out of one table and into another.
  const body = `${piece("Table 1.—Income", STATES).replace("</table>", "")}${piece("Table 1.—Income—Continued", REST)}`;
  const { pairs, declined } = continuationPairs(body);

  assert.equal(pairs.length, 0);
  assert.deepEqual(declined.map((d) => d.reason), ["unmatched_source"]);
  // The span scan is what disagrees with the DOM here, and it disagrees the safe way: the unclosed
  // opener swallows the table after it and never closes, so the bytes delimit NOTHING and there is
  // no span for either half to be matched to. Two tables in the DOM, zero in the source.
  assert.equal(tableSpans(body).length, 0);
  assert.equal(continuationPairs(body).tables, 2);
});

test("a body with no marker in it is not parsed at all", async () => {
  const body = `<h2>Report</h2>${piece("Table 1.—Income", STATES)}${piece("Table 2.—Costs", REST)}`;
  const { ctx, rec } = ctxWith(() => envelope(null));
  assert.equal(await joinContinuedTables(ctx, body), body);
  assert.deepEqual(rec.events, [], "a document that cannot have a pair says nothing and buys nothing");
  assert.equal(rec.calls.length, 0);
});

// --- whether the answer kept the table ---

test("a join that came back short of rows is refused", () => {
  // The failure this guard exists for, and the reason #174's floor cannot cover it: asking for a
  // 60-row table in one reply is asking the model to reproduce 60 rows of numbers, and a reply
  // carrying 40 of them is nowhere near half the prose of a 25-page document. It has to be caught
  // on the table.
  const body = piece("Table 1.—Income", STATES) + piece("Table 1.—Income—Continued", REST);
  const [pair] = continuationPairs(body).pairs;

  assert.equal(verifyJoin(pair, goodJoin("Table 1.—Income", STATES, REST)), null);
  // The count is floored on the SUM of the two halves, less one header block and one droppable row,
  // so a reply that returned only the half it was fondest of is caught by the count before the
  // labels are even looked at. Floored on the larger half instead — which is what this was — the
  // 5-row reply below passed the count and was caught only because its rows happened to carry
  // labels: the check that sees a dropped row with no label at all is this one.
  assert.equal(verifyJoin(pair, piece("Table 1.—Income", STATES)), "rows_lost");
  assert.equal(verifyJoin(pair, piece("Table 1.—Income", ["Alabama"])), "rows_lost");
  // One row dropped, and it is one of the unlabelled continuation lines a printed table gives a
  // multi-line row label — invisible to the label set by construction, since it has no label.
  const withBlanks = (labels: string[]) =>
    labels.map((l) => `<tr><th scope="row">${l}</th><td>1.0</td><td>2.0</td></tr><tr><td></td><td>4.1</td><td>4.2</td></tr>`).join("");
  const cap = `<table><caption>Table 1.—Income</caption><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead><tbody>`;
  const withBlanksPair = continuationPairs(
    `${cap}${withBlanks(STATES)}</tbody></table>${cap.replace("Income</caption>", "Income—Continued</caption>")}${withBlanks(REST)}</tbody></table>`,
  ).pairs[0];
  const BLANK = `<tr><td></td><td>4.1</td><td>4.2</td></tr>`;
  const joinedWithBlanks = withBlanks([...STATES, ...REST]);
  assert.equal(verifyJoin(withBlanksPair, `${cap}${joinedWithBlanks}</tbody></table>`), null);
  // ONE dropped row is inside the floor's slack, and deliberately: rule 6 lets the join drop the
  // bracketed unit note a continued page reprints, and that row is not distinguishable from this one
  // by counting. Two is not, and every one of these rows is invisible to the label check.
  assert.equal(verifyJoin(withBlanksPair, `${cap}${joinedWithBlanks.replace(BLANK, "")}</tbody></table>`), null);
  assert.equal(
    verifyJoin(withBlanksPair, `${cap}${joinedWithBlanks.replaceAll(BLANK, "")}</tbody></table>`),
    "rows_lost",
  );
});

test("the rows the floor forgives are one, not one per level of header the halves disagree by", () => {
  // Halves that describe their columns at different depths are 4 of the corpus's 18 pairs, and a
  // floor that subtracted "the larger header block" forgave the DIFFERENCE between the two depths as
  // well: a 3-row header against a 1-row one left three rows of slack, which is exactly enough for a
  // reply to keep every labelled row, drop three unlabelled continuation lines, and be accepted. The
  // floor reads the JOINED table's header depth instead, so what it forgives is what actually went.
  const rows = (labels: string[]) =>
    labels.map((l) => `<tr><th scope="row">${l}</th><td>1.0</td><td>2.0</td></tr><tr><td></td><td>4.1</td><td>4.2</td></tr>`).join("");
  const head = (n: number) =>
    `<thead>${Array.from({ length: n }, (_, i) => `<tr><th>A${i}</th><th>B${i}</th><th>C${i}</th></tr>`).join("")}</thead>`;
  const half = (caption: string, headRows: number, labels: string[]) =>
    `<table><caption>${caption}</caption>${head(headRows)}<tbody>${rows(labels)}</tbody></table>`;
  const [pair] = continuationPairs(
    half("Table 8.—Yield", 3, ["Alabama", "Alaska", "Arizona"]) + half("Table 8.—Yield—Continued", 1, ["Vermont"]),
  ).pairs;
  assert.deepEqual([pair.first.rows, pair.first.headerRows, pair.second.rows, pair.second.headerRows], [9, 3, 3, 1]);

  const kept = `<table><caption>Table 8.—Yield</caption>${head(3)}<tbody>${rows(["Alabama", "Alaska", "Arizona", "Vermont"])}</tbody></table>`;
  assert.equal(verifyJoin(pair, kept), null);
  // Every labelled row kept, three of the four unlabelled continuation lines dropped: three rows of
  // numbers gone, invisible to the label set by construction, columns and header cells intact. The
  // old floor was 8 and this reply has 8 rows, so it was accepted and logged as a join.
  const labelledOnly = (labels: string[]) =>
    labels.map((l) => `<tr><th scope="row">${l}</th><td>1.0</td><td>2.0</td></tr>`).join("");
  const lossy =
    `<table><caption>Table 8.—Yield</caption>${head(3)}` +
    `<tbody>${rows(["Alabama"])}${labelledOnly(["Alaska", "Arizona", "Vermont"])}</tbody></table>`;
  assert.equal(lossy.match(/<tr/g)!.length, 8);
  assert.equal(verifyJoin(pair, lossy), "rows_lost");
});

test("a row the join moved into the header is not charged as a row lost", () => {
  // Rule 6's own case: both halves reprint a bracketed unit note as a full-width row, the note
  // belongs once and "at the top", and `<thead>` is where a note at the top reads naturally. Reading
  // the dropped header rows off the joined table alone charges that promotion as a header row that
  // never went — which cancels the one drop rule 6 asks for, so the same content is accepted or
  // refused depending only on which side of `<thead>` the note lands.
  const note = `<tr><td colspan="3">[In millions of dollars]</td></tr>`;
  const data = (labels: string[]) => labels.map((l) => `<tr><th scope="row">${l}</th><td>1.0</td><td>2.0</td></tr>`).join("");
  const head = `<thead><tr><th>State</th><th>A</th><th>B</th></tr></thead>`;
  const half = (caption: string, labels: string[]) =>
    `<table><caption>${caption}</caption>${head}<tbody>${note}${data(labels)}</tbody></table>`;
  const [pair] = continuationPairs(
    half("Table 3.—Collections", ["Alabama", "Alaska", "Arizona"]) + half("Table 3.—Collections—Continued", ["Vermont", "Virginia"]),
  ).pairs;
  assert.deepEqual([pair.first.rows, pair.first.headerRows, pair.second.rows, pair.second.headerRows], [5, 1, 4, 1]);

  // The same join twice: one header row, the note once, all five data rows. Only the note moves.
  const inBody = `<table><caption>Table 3.—Collections</caption>${head}<tbody>${note}${data(["Alabama", "Alaska", "Arizona", "Vermont", "Virginia"])}</tbody></table>`;
  const inHead = `<table><caption>Table 3.—Collections</caption>${head.replace("</thead>", `${note}</thead>`)}<tbody>${data(["Alabama", "Alaska", "Arizona", "Vermont", "Virginia"])}</tbody></table>`;
  assert.equal(inBody.match(/<tr/g)!.length, 7);
  assert.equal(inHead.match(/<tr/g)!.length, 7);
  assert.equal(verifyJoin(pair, inBody), null);
  assert.equal(verifyJoin(pair, inHead), null, "the same content was refused for sitting in <thead>");
});

test("a join that kept the second header block is credited with dropping nothing", () => {
  // The other side of the promotion credit, and the direction that costs content: "one shared block
  // went" also wins whenever the joined header is deeper than either half's, which a reply keeping
  // BOTH blocks — the second one repeated mid-table as all-`<th>` rows, i.e. exactly the state this
  // stage exists to remove — satisfies without having dropped a thing.
  const spanned = `<tr><th>State</th><th colspan="2">Amount</th></tr><tr><th></th><th>1959</th><th>1960</th></tr>`;
  const head = `<thead><tr><th colspan="3">Receipts</th></tr>${spanned}</thead>`;
  const labelled = (labels: string[]) => labels.map((l) => `<tr><th scope="row">${l}</th><td>1.0</td><td>2.0</td></tr>`).join("");
  const blank = `<tr><td></td><td>3.0</td><td>4.0</td></tr>`;
  const withRuns = (labels: string[]) => labels.map((l) => labelled([l]) + blank).join("");
  const half = (caption: string, labels: string[]) =>
    `<table><caption>${caption}</caption>${head}<tbody>${withRuns(labels)}</tbody></table>`;
  const [pair] = continuationPairs(
    half("Table 5.—Receipts", ["Alabama", "Alaska", "Arizona"]) + half("Table 5.—Receipts—Continued", ["Vermont", "Virginia"]),
  ).pairs;
  assert.deepEqual([pair.first.rows, pair.first.headerRows, pair.second.rows, pair.second.headerRows], [9, 3, 7, 3]);

  // Keeps its own header, repeats the second half's block mid-table, and drops 3 of the 5 unlabelled
  // continuation lines. 12 rows, which cleared a floor of 16 − 3 − 1 while the shared-block credit
  // was unconditional: three rows of numbers shipped gone under a `table_joined` line, with the
  // duplicated header still in the delivered table.
  const lossy =
    `<table><caption>Table 5.—Receipts</caption>${head}<tbody>` +
    `${labelled(["Alabama", "Alaska", "Arizona"])}${blank}${spanned}${labelled(["Vermont", "Virginia"])}${blank}</tbody></table>`;
  assert.equal(lossy.match(/<tr/g)!.length, 12);
  assert.equal(verifyJoin(pair, lossy), "rows_lost");

  // And the same reply with every row present is accepted — the refusal above is the missing rows,
  // not the kept block, which no count can see and which rule 3 is what asks for.
  const whole =
    `<table><caption>Table 5.—Receipts</caption>${head}<tbody>` +
    `${withRuns(["Alabama", "Alaska", "Arizona"])}${spanned}${withRuns(["Vermont", "Virginia"])}</tbody></table>`;
  assert.equal(whole.match(/<tr/g)!.length, 15);
  assert.equal(verifyJoin(pair, whole), null);
});

test("a join that turned the header cells into data cells is refused", () => {
  // The one property a data table cannot lose here and still be the fix: its header cells. A reply
  // that emitted the merged header block as `<td>` keeps every label (the label set is matched over
  // `th,td` together), every column and every row, and axe reports nothing on a data table with no
  // header cells — so without this check it would ship, having removed the header association from
  // exactly the tables this stage exists to improve.
  const body = piece("Table 1.—Income", STATES) + piece("Table 1.—Income—Continued", REST);
  const [pair] = continuationPairs(body).pairs;
  const flattened = goodJoin("Table 1.—Income", STATES, REST).replace(/<th([^>]*)>/g, "<td>").replace(/<\/th>/g, "</td>");

  assert.equal(verifyJoin(pair, flattened), "header_cells_lost");
  // And the join that legitimately collapses two header blocks into one is not refused by it: the
  // floor is the smaller half's count, so merging a two-row header down to one row is allowed.
  assert.equal(verifyJoin(pair, goodJoin("Table 1.—Income", STATES, REST)), null);

  // A floor of zero is no check at all, so the flattening is refused on its own terms too. Reachable
  // wherever one half has no header cells to floor against — a header stub that came back rowless is
  // the shape, and it is one of the corpus's three-piece chains.
  const stub = `<table><caption>Table 1.—Income—Continued</caption><tbody><tr><td>1.0</td><td>2.0</td><td>3.0</td></tr></tbody></table>`;
  const [stubPair] = continuationPairs(piece("Table 1.—Income", STATES) + stub).pairs;
  assert.equal(stubPair.second.headerCells, 0, "the fixture is not the case being tested");
  assert.equal(verifyJoin(stubPair, flattened), "header_cells_lost");
});

test("a row the join dropped is caught by its label even when the count is right", () => {
  // Why the check is on the labels and not on a row count: a reply can return the right NUMBER of
  // rows and still have lost a state, by repeating one. A count sees nothing; the label set does.
  const body = piece("Table 1.—Income", STATES) + piece("Table 1.—Income—Continued", REST);
  const [pair] = continuationPairs(body).pairs;
  const swapped = [...STATES, ...REST].map((l) => (l === "Virginia" ? "Vermont" : l));

  assert.equal(piece("Table 1.—Income", swapped).match(/<tr/g)!.length, goodJoin("Table 1.—Income", STATES, REST).match(/<tr/g)!.length);
  assert.equal(verifyJoin(pair, piece("Table 1.—Income", swapped)), "labels_lost:1");
});

test("a label the join moved along a column still counts as kept", () => {
  // The set is over CELLS rather than over first cells, deliberately. A join that adds a column —
  // the corpus has two pairs whose halves declare 17 and 18 columns — moves the row label along
  // one, and a guard that read only the first cell would refuse exactly the repair it is here to
  // protect.
  const body = piece("Table 1.—Income", STATES) + piece("Table 1.—Income—Continued", REST);
  const [pair] = continuationPairs(body).pairs;
  const shifted = [...STATES, ...REST]
    .map((l) => `<tr><td>1959</td><th scope="row">${l}</th><td>1.0</td><td>2.0</td></tr>`)
    .join("");
  const merged = `<table><caption>Table 1.—Income</caption><thead><tr><th>Year</th><th>State</th><th>A</th><th>B</th></tr></thead><tbody>${shifted}</tbody></table>`;

  assert.equal(verifyJoin(pair, merged), null);
});

test("a reply that is not one table is not spliced in as one", () => {
  const body = piece("Table 1.—Income", STATES) + piece("Table 1.—Income—Continued", REST);
  const [pair] = continuationPairs(body).pairs;
  const good = goodJoin("Table 1.—Income", STATES, REST);

  // The two tables it was given, handed back.
  assert.equal(verifyJoin(pair, body), "not_one_table");
  // A table with a sentence of explanation around it, which is the commonest way a model answers
  // a repair request in prose.
  assert.equal(verifyJoin(pair, `<p>Here is the joined table:</p>${good}`), "not_one_table");
  assert.equal(verifyJoin(pair, good.replace("<caption>Table 1.—Income</caption>", "")), "no_caption");
  // Fewer columns than either half declared: a join that dropped a column of numbers.
  assert.equal(verifyJoin(pair, goodJoin("Table 1.—Income", STATES, REST, 2)), "columns_lost");
});

test("a joined table may not still call itself a continuation", () => {
  // Termination depends on this. A merged table whose caption still says "Continued" is a table
  // the next read pairs with whatever precedes it — a wrong join, and a loop that never runs out
  // of pairs — so the caption rule is enforced on the answer and not only read off the input.
  const body = piece("Table 1.—Income", STATES) + piece("Table 1.—Income—Continued", REST);
  const [pair] = continuationPairs(body).pairs;
  assert.equal(verifyJoin(pair, goodJoin("Table 1.—Income—Continued", STATES, REST)), "still_continued");
});

test("a joined caption may not drop the note of measure the first half's caption carried", () => {
  // The shape this exists for was created by the page rule that puts the note of measure inside the
  // <caption> rather than in a full-width row. As a row the note is held by the label and row checks
  // above; in the caption nothing here could see it go, because every other check reads cells,
  // columns or rows and the caption is only tested for existence and for "Continued". A joined table
  // whose caption reads "Table 1.—Income" alone passes all of them and hands a reader every figure
  // with nothing to read it in.
  const titled = "Table 1.—Income [In millions of dollars]";
  const body = piece(titled, STATES) + piece("Table 1.—Income—Continued", REST);
  const [pair] = continuationPairs(body).pairs;
  assert.equal(pair.first.caption, titled, "the fixture is not the case being tested");

  // `caption_note_lost` and not `caption_note_struck`, because on this pair no half printed the note as
  // a row: it is not in the joined caption and there is nothing anywhere else in the table to find it
  // in, so it is gone rather than moved. `caption_note_struck` is reserved for the merge that kept the
  // note as a row and took it out of the caption, which is the one thing the lost-check cannot refuse.
  assert.equal(verifyJoin(pair, goodJoin("Table 1.—Income", STATES, REST)), "caption_note_lost");
  // And it does not refuse the right answer: the note kept, the continuation marker gone.
  assert.equal(verifyJoin(pair, goodJoin(titled, STATES, REST)), null);

  // The reason a failed pair reports is the dearest loss and not this one. A merge that dropped the
  // note AND lost rows says `rows_lost`: the note is the cheapest of the losses to take, and
  // reported first it would mask the one worth reading. Only the reported string differs — every one
  // of them refuses the join — so this is what a human debugging `table_join_failed` sees.
  const alsoShort = goodJoin("Table 1.—Income", STATES, REST.slice(0, 1));
  assert.equal(verifyJoin(pair, alsoShort), "rows_lost");
});

test("a parenthesised caption note is not held, because the marker rule needs that shape dropped", () => {
  // Square brackets only, and the reason is a collision rather than a preference: CONTINUED_CAPTION
  // matches "(continued", so a check demanding every parenthesised run survive the merge would demand
  // the one run rule 4 requires to be dropped. In #374's corpus the parenthesised spelling is 6 of 68
  // delimited notes and the bracketed one is 61, so the shape left unheld is the rarer one — and a
  // note printed with no delimiter at all is not separable from the title by any string test.
  const body = piece("Table 1.—Income (In millions of dollars)", STATES) + piece("Table 1.—Income—Continued", REST);
  const [pair] = continuationPairs(body).pairs;
  assert.equal(verifyJoin(pair, goodJoin("Table 1.—Income", STATES, REST)), null);
});

// --- the join that needs no model ---
//
// Three of the editor's six rules are a move of bytes, so `joinInCode` tries the pair first and hands
// over wherever a rule asks what the table means (#276). What is pinned here is both halves of that:
// the moves it makes, and every judgement it stands down from. A code path that guessed at one of
// those would ship a table nothing downstream reads — `verifyJoin` is made of columns, header cells,
// row counts and labels, so it cannot see a dropped id or a note row that changed meaning.

// The one pair a fixture body holds, so a fixture that stopped being one pair fails here and not four
// assertions later.
function onePair(body: string) {
  const found = continuationPairs(body);
  assert.equal(found.pairs.length, 1, `the fixture is not one pair: ${JSON.stringify(found.declined)}`);
  return found.pairs[0]!;
}

// A pair built from two fragments directly. `joinInCode` reads nothing off a pair but the two halves'
// html, and this reaches shapes `continuationPairs` cannot hand it — see the caption test below for
// the one that matters.
const asPair = (first: string, second: string) =>
  ({ first: { html: first }, second: { html: second } }) as unknown as Parameters<typeof joinInCode>[0];

const HEAD = `<thead><tr><th scope="col">Col 1</th><th scope="col">Col 2</th><th scope="col">Col 3</th></tr></thead>`;
const dataRow = (label: string, attrs = "") => `<tr><th scope="row"${attrs}>${label}</th><td>1.0</td><td>1.0</td></tr>`;
const noteRow = (text: string) => `<tr><td colspan="3">${text}</td></tr>`;

test("the rules that are a move of bytes are joined with no request", async () => {
  const body = piece("Table 1.—Income", ["Alabama"]) + piece("Table 1.—Income—Continued", ["Vermont"]);
  const pair = onePair(body);

  const joined = joinInCode(pair);
  assert.ok("html" in joined, JSON.stringify(joined));
  // One caption without the marker, one header block, both halves' rows in printed order.
  assert.equal(joined.html, piece("Table 1.—Income", ["Alabama", "Vermont"]));
  // And held to the bar the editor's answer is held to, by the caller that splices either one.
  assert.equal(verifyJoin(pair, joined.html), null);
});

test("a second half with no header block of its own has nothing to collapse", async () => {
  // The middle piece of a chain arrives as rows under a caption and nothing else. Rule 3 asks which
  // header block describes the joined rows, and where the second half declares none there is no
  // question to ask.
  const first = `<table><caption>Table 8.—Yield</caption>${HEAD}<tbody>${dataRow("Alabama")}</tbody></table>`;
  const second = `<table><caption>Table 8.—Yield—Continued</caption><tbody>${dataRow("Vermont")}</tbody></table>`;
  const joined = joinInCode(onePair(first + second));

  assert.ok("html" in joined, JSON.stringify(joined));
  assert.equal(
    joined.html,
    `<table><caption>Table 8.—Yield</caption>${HEAD}<tbody>${dataRow("Alabama")}${dataRow("Vermont")}</tbody></table>`,
  );
});

test("a second half that describes its columns differently is the editor's", async () => {
  // 17 of the corpus's 50 pairs, and the reason the editor is asked at all: appending one half's rows
  // under the other half's headers puts numbers under labels that do not describe them.
  const body = piece("Table 10.—Collections", STATES) + reworded("Table 10.—Collections—Continued", REST);
  assert.deepEqual(joinInCode(onePair(body)), { reason: "header_differs" });
});

test("a header block one row deeper than the other is a difference, not a match", async () => {
  // Compared on structure and not on text, because the case where rule 3 is a real question is the
  // halves declaring their columns at different depths — and the deeper block's text is usually the
  // flat one's, spread over two rows.
  const spanned =
    `<thead><tr><th scope="col">Col 1</th><th scope="col" colspan="2">Amount</th></tr>` +
    `<tr><th scope="col">Col 1</th><th scope="col">Col 2</th><th scope="col">Col 3</th></tr></thead>`;
  const first = `<table><caption>Table 11.—Debt</caption>${spanned}<tbody>${dataRow("Alabama")}</tbody></table>`;
  const second = `<table><caption>Table 11.—Debt—Continued</caption>${HEAD}<tbody>${dataRow("Vermont")}</tbody></table>`;
  assert.deepEqual(joinInCode(onePair(first + second)), { reason: "header_differs" });
});

test("content the parser lifted out of a table is never joined in code", async () => {
  // A `<p>` inside a `<table>` is fostered OUT of it, so the joined table's `outerHTML` does not carry
  // it: serializing the first half's element is the one thing this path does that can lose content
  // where a model reply cannot.
  const first = `<table><caption>Table 2.—Costs</caption>${HEAD}<tbody>${dataRow("Alabama")}</tbody></table>`;
  const second =
    `<table><caption>Table 2.—Costs—Continued</caption>${HEAD}<tbody>${dataRow("Vermont")}</tbody>` +
    `<p>Note: preliminary figures.</p></table>`;
  const pair = onePair(first + second);

  assert.deepEqual(joinInCode(pair), { reason: "content_outside_table" });
  // Why the guard is the only thing standing there: this is what the join would have produced, the
  // note is gone from it, and the check that refuses a bad merge says it is sound.
  const lossy = `<table><caption>Table 2.—Costs</caption>${HEAD}<tbody>${dataRow("Alabama")}${dataRow("Vermont")}</tbody></table>`;
  assert.ok(!lossy.includes("preliminary"));
  assert.equal(verifyJoin(pair, lossy), null, "verifyJoin can see hoisted prose after all");
});

test("an id on the half being dropped moves onto the element that survives it", async () => {
  // `#table7-continued` points at the second half; after the join the joined table IS what that half
  // was, so the link lands where its text always meant. Nothing about the table has to be read to
  // know that a caption's counterpart is a caption.
  const first = `<table><caption>Table 7.—Grants</caption>${HEAD}<tbody>${dataRow("Alabama")}</tbody></table>`;
  const second =
    `<table id="table7-continued"><caption id="table7-continued-label">Table 7.—Grants—Continued</caption>` +
    `${HEAD}<tbody>${dataRow("Vermont")}</tbody></table>`;
  const joined = joinInCode(onePair(first + second));

  assert.ok("html" in joined, JSON.stringify(joined));
  assert.equal(
    joined.html,
    `<table id="table7-continued"><caption id="table7-continued-label">Table 7.—Grants</caption>` +
      `${HEAD}<tbody>${dataRow("Alabama")}${dataRow("Vermont")}</tbody></table>`,
  );
});

test("an id with no free counterpart to move to is the editor's", async () => {
  // Two live link targets collapsing onto one element is a choice about which link keeps working, and
  // that choice is not a move of bytes. 5 of the corpus's pairs, and the editor cannot put two ids on
  // one caption either — it can renumber the document's references, which is why it is asked.
  const first = `<table><caption id="t7a">Table 7.—Grants</caption>${HEAD}<tbody>${dataRow("Alabama")}</tbody></table>`;
  const second = `<table><caption id="t7b">Table 7.—Grants—Continued</caption>${HEAD}<tbody>${dataRow("Vermont")}</tbody></table>`;
  assert.deepEqual(joinInCode(onePair(first + second)), { reason: "id_would_be_lost" });
});

test("a footnote anchor in the repeated header block is the editor's", async () => {
  // 70 of the corpus's 87 dropped ids, 60 of them live: the repeated header block holds the page's
  // footnote REFERENCE anchors, and rule 3 is what drops that block. Which cell of the surviving block
  // the anchor belongs on is a reading of the table.
  const anchored =
    `<thead><tr><th scope="col">Col 1</th><th scope="col">Col 2</th>` +
    `<th scope="col">Col 3<sup><a href="#p7-fn-2" id="p7-fnref-2">2</a></sup></th></tr></thead>`;
  const first = `<table><caption>Table 9.—Aid</caption>${anchored}<tbody>${dataRow("Alabama")}</tbody></table>`;
  const second = `<table><caption>Table 9.—Aid—Continued</caption>${anchored.replace("p7-fnref-2", "p8-fnref-2").replace("#p7-fn-2", "#p8-fn-2")}<tbody>${dataRow("Vermont")}</tbody></table>`;
  assert.deepEqual(joinInCode(onePair(first + second)), { reason: "id_would_be_lost" });
});

test("an id the join itself would print twice is the editor's", async () => {
  // A duplicate id is a 4.1.1 defect the JOIN introduced, and it is invisible to everything else here:
  // `verifyJoin` never reads an id, and rule 2 is satisfied — the id survives, twice.
  const first = `<table><caption>Table 3.—Rates</caption>${HEAD}<tbody>${dataRow("Alabama", ' id="row-1"')}</tbody></table>`;
  const second = `<table><caption>Table 3.—Rates—Continued</caption>${HEAD}<tbody>${dataRow("Vermont", ' id="row-1"')}</tbody></table>`;
  assert.deepEqual(joinInCode(onePair(first + second)), { reason: "id_would_collide" });
});

test("a bracketed unit note the first half prints too is dropped once, and any other is the editor's", async () => {
  // Rule 6 licenses dropping a REPEAT. A note the first half does not carry says something about the
  // continued rows, and both keeping it mid-table and dropping it change how the table reads.
  const note = noteRow("[In millions of dollars]");
  const first = `<table><caption>Table 5.—Debt</caption>${HEAD}<tbody>${note}${dataRow("Alabama")}</tbody></table>`;
  const repeat = `<table><caption>Table 5.—Debt—Continued</caption>${HEAD}<tbody>${note}${dataRow("Vermont")}</tbody></table>`;
  const other = `<table><caption>Table 5.—Debt—Continued</caption>${HEAD}<tbody>${noteRow("[Percentage distribution]")}${dataRow("Vermont")}</tbody></table>`;

  const pair = onePair(first + repeat);
  const joined = joinInCode(pair);
  assert.ok("html" in joined, JSON.stringify(joined));
  assert.equal(
    joined.html,
    `<table><caption>Table 5.—Debt</caption>${HEAD}<tbody>${note}${dataRow("Alabama")}${dataRow("Vermont")}</tbody></table>`,
  );
  assert.equal(verifyJoin(pair, joined.html), null, "the note this dropped is a row verifyJoin wants");

  assert.deepEqual(joinInCode(onePair(first + other)), { reason: "note_repeat_unclear" });
});

test("the halves need not print the unit note in the same place for it to be a repeat", async () => {
  // The mixed pair, which `page.md` asking for the note in the <caption> is what makes reachable: the
  // first half carries the note under its title, the second still prints it as a full-width row. That
  // is one note printed twice, and judging rule 6 on the note ROWS alone called it a note the first
  // half does not carry — `note_repeat_unclear`, which declines the free join and buys a Copy Editor
  // call for a pair with no judgement in it. Worse on the model path: rule 6 licensed no drop, rule 1
  // says copy every data row, so the sound reading shipped the note in the caption AND as a phantom
  // row, which is the harm the page rule exists to remove.
  const note = noteRow("[In millions of dollars]");
  const first = `<table><caption>Table 5.—Debt [In millions of dollars]</caption>${HEAD}<tbody>${dataRow("Alabama")}</tbody></table>`;
  const second = `<table><caption>Table 5.—Debt—Continued</caption>${HEAD}<tbody>${note}${dataRow("Vermont")}</tbody></table>`;

  const pair = onePair(first + second);
  const joined = joinInCode(pair);
  assert.ok("html" in joined, JSON.stringify(joined));
  // The row is gone and the caption's copy is the one that survived — one note, once, where the first
  // half had it.
  assert.equal(
    joined.html,
    `<table><caption>Table 5.—Debt [In millions of dollars]</caption>${HEAD}<tbody>${dataRow("Alabama")}${dataRow("Vermont")}</tbody></table>`,
  );
  assert.equal(verifyJoin(pair, joined.html), null, "the free path must not trip its own caption check");

  // And the asymmetry is deliberate: a note only the CONTINUED half carries is a first appearance and
  // not a repeat, so folding in the second half's caption would license dropping it.
  const onlySecond = `<table><caption>Table 5.—Debt</caption>${HEAD}<tbody>${dataRow("Alabama")}</tbody></table>`;
  assert.deepEqual(joinInCode(onePair(onlySecond + second)), { reason: "note_repeat_unclear" });
});

test("a note only the continued half's caption carries is not the free path's to lose", () => {
  // The other side of that asymmetry, and the one it hid: rule 6 declining to call this a repeat is not
  // a licence to drop it. `joinInCode` keeps the FIRST half's caption and discards the second's, so a
  // second half whose caption carried the note and whose rows carried none used to pass every check
  // with the units gone from the delivered table, on the free path, with no reason logged. Measured
  // shape rather than a constructed one — p049 and p050 are two halves of one continued table where
  // each arm drops the note on exactly one half, so a first half without it and a second half with it
  // is a pair the corpus produces.
  const first = `<table><caption>Table 5.—Debt</caption>${HEAD}<tbody>${dataRow("Alabama")}</tbody></table>`;
  const second = `<table><caption>Table 5.—Debt [In millions of dollars]—Continued</caption>${HEAD}<tbody>${dataRow("Vermont")}</tbody></table>`;
  const pair = onePair(first + second);

  const coded = joinInCode(pair);
  assert.ok("html" in coded, JSON.stringify(coded));
  // The code path still produces the bytes it always did — it is the verification that refuses them,
  // which is what sends this pair to the editor rather than shipping it.
  assert.equal(verifyJoin(pair, coded.html), "caption_note_lost");
  // And the answer rule 4 asks for clears it: the note kept, the marker gone.
  assert.equal(
    verifyJoin(pair, `<table><caption>Table 5.—Debt [In millions of dollars]</caption>${HEAD}<tbody>${dataRow("Alabama")}${dataRow("Vermont")}</tbody></table>`),
    null,
  );
});

test("a note the merge kept as a row is not a note the merge lost", () => {
  // The mirror of the pair rule 6 joins for free: the note is a ROW on the first half and in the
  // CAPTION on the second. `joinInCode` keeps the first half's caption and its note row, so the note is
  // in the delivered table and nothing went — but a kept-check reading the caption alone called that a
  // loss and refused a join with nothing wrong with it. Both placements are reachable (#374's census:
  // 56 arm-pages with the note inside the caption, 12 outside), so a pair whose halves disagree about
  // which is a shape to expect.
  const first = `<table><caption>Table 5.—Debt</caption>${HEAD}<tbody>${noteRow("[In millions of dollars]")}${dataRow("Alabama")}</tbody></table>`;
  const second = `<table><caption>Table 5.—Debt [In millions of dollars]—Continued</caption>${HEAD}<tbody>${dataRow("Vermont")}</tbody></table>`;
  const pair = onePair(first + second);

  const coded = joinInCode(pair);
  assert.ok("html" in coded, JSON.stringify(coded));
  assert.ok(coded.html.includes("[In millions of dollars]"), "the fixture is not the case being tested");
  assert.equal(verifyJoin(pair, coded.html), null);

  // And it is still refused when the merge keeps it in neither place — as `labels_lost` rather than as
  // `caption_note_lost`, because on THIS pair the note is also a row, its bracketed text is that row's
  // label, and the label check runs first. Both name the same single loss; the order is the one chosen
  // deliberately, so the reason a pair reports is the dearest thing it lost.
  const neither = `<table><caption>Table 5.—Debt</caption>${HEAD}<tbody>${dataRow("Alabama")}${dataRow("Vermont")}</tbody></table>`;
  assert.equal(verifyJoin(pair, neither), "labels_lost:1");
});

test("a caption note the merge demoted into a row has not been kept", () => {
  // The hole in counting any note row as proof of keeping. Both halves print the note in the caption —
  // the placement page.md asks for — and the merge strips the caption and emits it as a row instead.
  // That is not a note kept, it is a note DEMOTED into the phantom row page.md forbids in as many
  // words: a <td> invents a cell of data the page never printed, a <th> names a column that does not
  // exist. All three shapes below are what #374's census counts as harm, two of the twelve being
  // exactly a <thead>-closing row. joinInCode never demotes, so this is the Copy Editor's shape —
  // rule 6's "belongs once, at the top" reads as licence for the row while rule 4 asks for the caption,
  // and a model satisfying one rule and not the other must not clear the check.
  const note = "[In millions of dollars]";
  const first = `<table><caption>Table 5.—Debt ${note}</caption>${HEAD}<tbody>${dataRow("Alabama")}</tbody></table>`;
  const second = `<table><caption>Table 5.—Debt—Continued</caption>${HEAD}<tbody>${dataRow("Vermont")}</tbody></table>`;
  const pair = onePair(first + second);
  const rows = `${dataRow("Alabama")}${dataRow("Vermont")}`;
  assert.ok(![...pair.first.labels, ...pair.second.labels].includes(note), "no half printed it as a row");

  // As a data row, as a row closing <thead>, and as a <th> row: the three the review of this PR ran.
  for (const demoted of [
    `<table><caption>Table 5.—Debt</caption>${HEAD}<tbody>${noteRow(note)}${rows}</tbody></table>`,
    `<table><caption>Table 5.—Debt</caption><thead><tr><th scope="col">Col 1</th><th scope="col">Col 2</th><th scope="col">Col 3</th></tr>${noteRow(note)}</thead><tbody>${rows}</tbody></table>`,
    `<table><caption>Table 5.—Debt</caption>${HEAD}<tbody><tr><th colspan="3">${note}</th></tr>${rows}</tbody></table>`,
  ]) {
    assert.equal(verifyJoin(pair, demoted), "caption_note_lost", demoted.slice(0, 90));
  }

  // The same note left where the page printed it clears, so this refuses the demotion and not the join.
  assert.equal(verifyJoin(pair, `<table><caption>Table 5.—Debt ${note}</caption>${HEAD}<tbody>${rows}</tbody></table>`), null);
});

test("a note row a half printed inside <thead> was printed by somebody", () => {
  // What a half PRINTED as a row is read over every row and not off its labels, because labels drop
  // header rows and a note row closing <thead> is one — the p068 shape the census counts. Read off
  // labels, that note was printed by nobody, so a merge carrying the row through untouched was refused
  // for demoting a note it had not moved at all. Rule 6's repeat set had been reading the same fact the
  // other way round, over every tr, so the two readers of one fact disagreed.
  const note = "[In millions of dollars]";
  const headNote = `<thead><tr><th scope="col">Col 1</th><th scope="col">Col 2</th><th scope="col">Col 3</th></tr>${noteRow(note)}</thead>`;
  const first = `<table><caption>Table 5.—Debt</caption>${headNote}<tbody>${dataRow("Alabama")}</tbody></table>`;
  const second = `<table><caption>Table 5.—Debt ${note}—Continued</caption>${headNote}<tbody>${dataRow("Vermont")}</tbody></table>`;
  const pair = onePair(first + second);

  assert.ok(!pair.first.labels.includes(note), "the fixture is not the case being tested");
  assert.deepEqual(pair.first.noteRows, [{ text: note, header: true }]);

  const coded = joinInCode(pair);
  assert.ok("html" in coded, JSON.stringify(coded));
  assert.equal(verifyJoin(pair, coded.html), null);
  // And the demotion is still refused, because neither half printed THIS note as a row.
  const other = "[Percentage distribution]";
  const promoted = `<table><caption>Table 6.—Shares ${other}</caption>${HEAD}<tbody>${dataRow("Alabama")}</tbody></table>`;
  const plain = `<table><caption>Table 6.—Shares—Continued</caption>${HEAD}<tbody>${dataRow("Vermont")}</tbody></table>`;
  const demotedPair = onePair(promoted + plain);
  const demoted = `<table><caption>Table 6.—Shares</caption>${HEAD}<tbody>${noteRow(other)}${dataRow("Alabama")}${dataRow("Vermont")}</tbody></table>`;
  assert.equal(verifyJoin(demotedPair, demoted), "caption_note_lost");
});

test("a note row printed in the header block and delivered as a cell of data has been moved, not kept", () => {
  // The pair the census makes likeliest, and the one a text-only reading of what a half "printed as a
  // row" cleared: the note in the FIRST half's caption — 56 of the 77 arm-pages, and the placement
  // page.md asks for — and printed as a <thead>-closing row by the second, which is 1 of the 12 outside
  // the caption. A merge that strikes the caption note and delivers it as a <tbody> row matches the
  // second half's text, and matching on text alone is what let that through: the delivered caption no
  // longer names the units and a reader moving by row meets them as data. Both harms page.md names in
  // as many words, so the block a half printed the note in is compared and not only the characters.
  const note = "[In millions of dollars]";
  const headNote = `<thead><tr><th scope="col">Col 1</th><th scope="col">Col 2</th><th scope="col">Col 3</th></tr>${noteRow(note)}</thead>`;
  const first = `<table><caption>Table 5.—Debt ${note}</caption>${HEAD}<tbody>${dataRow("Alabama")}</tbody></table>`;
  const second = `<table><caption>Table 5.—Debt—Continued</caption>${headNote}<tbody>${dataRow("Vermont")}</tbody></table>`;
  const pair = onePair(first + second);
  assert.deepEqual(pair.second.noteRows, [{ text: note, header: true }]);

  const rows = `${dataRow("Alabama")}${dataRow("Vermont")}`;
  const demoted = `<table><caption>Table 5.—Debt</caption>${HEAD}<tbody>${noteRow(note)}${rows}</tbody></table>`;
  assert.equal(verifyJoin(pair, demoted), "caption_note_lost");
  // The <th> spelling of the same invention — page.md names a column that does not exist for this one.
  const asTh = `<table><caption>Table 5.—Debt</caption>${HEAD}<tbody><tr><th colspan="3">${note}</th></tr>${rows}</tbody></table>`;
  assert.equal(verifyJoin(pair, asTh), "caption_note_lost");
  // And the answer rule 4 asks for on this pair clears, so what is refused above is the placement and
  // not the pair: a check no answer can satisfy would decline this shape for good. The note lands in
  // the caption once — the second half's <thead> row is a header row, which rule 3 drops on the merge.
  const inCaption = `<table><caption>Table 5.—Debt ${note}</caption>${HEAD}<tbody>${rows}</tbody></table>`;
  assert.equal(verifyJoin(pair, inCaption), null);
  // Keeping that row as well as the caption is the same units twice, which is its own refusal: a reader
  // moving by row meets them again as a cell, and rule 3 said to drop the second half's header block.
  const both = `<table><caption>Table 5.—Debt ${note}</caption>${headNote}<tbody>${rows}</tbody></table>`;
  assert.equal(verifyJoin(pair, both), "note_shipped_twice");
});

test("a note row a half printed in the body is not kept by promoting it into the header block", () => {
  // The same comparison read the other way. Neither caption is owed anything here until the second
  // half's is — that is the mirror pair rule 6 joins for free, first half printing the note as a body
  // row and second carrying it in its caption — so the joined caption may drop it only because the row
  // still stands where the page had it. Moved into <thead>, the note is announced as a column heading
  // for columns it does not head, and the row the page printed is gone.
  const note = "[Percentage distribution]";
  const first = `<table><caption>Table 6.—Shares</caption>${HEAD}<tbody>${noteRow(note)}${dataRow("Alabama")}</tbody></table>`;
  const second = `<table><caption>Table 6.—Shares ${note}—Continued</caption>${HEAD}<tbody>${dataRow("Vermont")}</tbody></table>`;
  const pair = onePair(first + second);
  assert.deepEqual(pair.first.noteRows, [{ text: note, header: false }]);

  const rows = `${dataRow("Alabama")}${dataRow("Vermont")}`;
  const head = `<thead><tr><th scope="col">Col 1</th><th scope="col">Col 2</th><th scope="col">Col 3</th></tr>${noteRow(note)}</thead>`;
  const promoted = `<table><caption>Table 6.—Shares</caption>${head}<tbody>${rows}</tbody></table>`;
  assert.equal(verifyJoin(pair, promoted), "caption_note_lost");
  // Left where the page had it, it clears — and the free path is what produces that, so this leg is
  // the one that says the refusal above costs no join the code already makes.
  const coded = joinInCode(pair);
  assert.ok("html" in coded, JSON.stringify(coded));
  assert.equal(verifyJoin(pair, coded.html), null);
});

test("a row on the other half does not excuse a note struck out of the caption the join is built on", () => {
  // The same demotion again, in the spelling comparing the BLOCK cannot see: the note in the first
  // half's caption and printed as a BODY row by the second, so the merge's <tbody> note row matches the
  // second half's text and block and cleared. This is the commoner half of the census's mixed pair —
  // of the twelve notes printed outside a caption, seven are a <th> row and two a <td> row, against two
  // closing <thead> — and the fixture is the one the fullwidth test below already uses, which is how
  // reachable it is: that pair joins for free today.
  //
  // The discriminator is not the block but WHICH caption owed the note. Rule 4 discards the second
  // half's caption entire, so a note that goes with it is a duplicate caption being dropped while the
  // row stands where it was printed — the mirror pair, and it must keep joining. The first half's
  // caption is the one rule 4 says to COPY, so a note missing from the joined caption was struck out of
  // it, and no row on the other half makes that a move of nothing.
  const note = "[Percentage distribution]";
  const first = `<table><caption>Table 6.—Shares ${note}</caption>${HEAD}<tbody>${dataRow("Alabama")}</tbody></table>`;
  const second = `<table><caption>Table 6.—Shares—Continued</caption>${HEAD}<tbody>${noteRow(note)}${dataRow("Vermont")}</tbody></table>`;
  const pair = onePair(first + second);
  assert.deepEqual(pair.second.noteRows, [{ text: note, header: false }]);

  const rows = `${dataRow("Alabama")}${dataRow("Vermont")}`;
  const demoted = `<table><caption>Table 6.—Shares</caption>${HEAD}<tbody>${noteRow(note)}${rows}</tbody></table>`;
  assert.equal(verifyJoin(pair, demoted), "caption_note_struck");
  const asTh = `<table><caption>Table 6.—Shares</caption>${HEAD}<tbody><tr><th colspan="3">${note}</th></tr>${rows}</tbody></table>`;
  assert.equal(verifyJoin(pair, asTh), "caption_note_struck");
  // The free path's own answer on this pair is the one rule 4 asks for — the second half's row dropped
  // as rule 6's repeat, the note kept in the caption — so nothing the code produces is newly refused.
  const coded = joinInCode(pair);
  assert.ok("html" in coded, JSON.stringify(coded));
  assert.equal(verifyJoin(pair, coded.html), null);

  // And the mirror stays joinable: the same two placements, swapped between the halves. Here the note
  // leaves the DISCARDED caption and the surviving row is the first half's own, which is nothing moved.
  const rowFirst = `<table><caption>Table 6.—Shares</caption>${HEAD}<tbody>${noteRow(note)}${dataRow("Alabama")}</tbody></table>`;
  const capSecond = `<table><caption>Table 6.—Shares ${note}—Continued</caption>${HEAD}<tbody>${dataRow("Vermont")}</tbody></table>`;
  const mirror = onePair(rowFirst + capSecond);
  const mirrorJoin = `<table><caption>Table 6.—Shares</caption>${HEAD}<tbody>${noteRow(note)}${rows}</tbody></table>`;
  assert.equal(verifyJoin(mirror, mirrorJoin), null);
});

test("a first half with no caption of its own has no title caption to be strict about", () => {
  // Rule 4's exception, and the reason the strict reading is keyed on the title caption rather than on
  // the first half: where the first half has no caption, the caption the join is built on is the SECOND
  // half's, minus its marker. So a note in it is owed the joined caption too, and a row on the first
  // half does not excuse striking it out — the same rule, read at the caption the merge actually copies.
  const note = "[In millions of dollars]";
  const first = `<table>${HEAD}<tbody>${noteRow(note)}${dataRow("Alabama")}</tbody></table>`;
  const second = `<table><caption>Table 7.—Grants ${note}—Continued</caption>${HEAD}<tbody>${dataRow("Vermont")}</tbody></table>`;
  const pair = onePair(first + second);
  assert.equal(pair.first.caption, "", "the fixture is not the case being tested");

  const rows = `${noteRow(note)}${dataRow("Alabama")}${dataRow("Vermont")}`;
  const struck = `<table><caption>Table 7.—Grants</caption>${HEAD}<tbody>${rows}</tbody></table>`;
  assert.equal(verifyJoin(pair, struck), "caption_note_struck");
  // And the note in the caption while the row it was promoted from stays is the doubling, not the
  // answer: this leg asserted `null` when it was written, and the check below found it. Rule 6's "one
  // note, once" leaves exactly one clearing answer on this pair — the caption keeps it and the row goes.
  const both = `<table><caption>Table 7.—Grants ${note}</caption>${HEAD}<tbody>${rows}</tbody></table>`;
  assert.equal(verifyJoin(pair, both), "note_shipped_twice");
  const kept = `<table><caption>Table 7.—Grants ${note}</caption>${HEAD}<tbody>${dataRow("Alabama")}${dataRow("Vermont")}</tbody></table>`;
  assert.equal(verifyJoin(pair, kept), null);
  // And the free path produces it, which is the point: both placements here are the census's measured
  // ones — the note in a caption on 56 arm-pages, as a row on 12 — so this pair must stay free. It
  // imports the second half's caption WITH the note, so the first half's row is the repeat rule 6 drops,
  // and the join emits the note once. It cost a round to see: this asserted `note_shipped_twice` when
  // written, which was the merge buying an editor call for a doubling the merge itself had made.
  const coded = joinInCode(pair);
  assert.ok("html" in coded, JSON.stringify(coded));
  assert.equal(verifyJoin(pair, coded.html), null);
  assert.ok(coded.html.includes(`<caption>Table 7.—Grants ${note}</caption>`), coded.html);
  assert.equal([...coded.html.matchAll(/In millions/g)].length, 1, coded.html);

  // An id inside that row has nowhere to go — the id checks read the second half's ids against the
  // finished table and never the first's, because this is the only first-half row a free join drops.
  const withId = `<table>${HEAD}<tbody><tr><td colspan="3" id="p7-units">${note}</td></tr>${dataRow("Alabama")}</tbody></table>`;
  assert.deepEqual(joinInCode(onePair(withId + second)), { reason: "id_would_be_lost" });

  // Two rows carrying the note — the first half's and the second half's — with the imported caption
  // carrying it too. That is two drops against rule 6's licence of ONE, and it used to decline; it joins
  // now, because the licence is counted over the drops the joined CAPTION cannot answer for and this
  // caption answers for both. Declining it was buying an editor call to reach the table already in hand.
  const twice = `<table><caption>Table 7.—Grants ${note}—Continued</caption>${HEAD}<tbody>${noteRow(note)}${dataRow("Vermont")}</tbody></table>`;
  const twicePair = onePair(first + twice);
  const twiceJoin = joinInCode(twicePair);
  assert.ok("html" in twiceJoin, JSON.stringify(twiceJoin));
  assert.equal(verifyJoin(twicePair, twiceJoin.html), null);
  assert.equal([...twiceJoin.html.matchAll(/In millions/g)].length, 1, twiceJoin.html);
  assert.ok(twiceJoin.html.includes(dataRow("Alabama")) && twiceJoin.html.includes(dataRow("Vermont")));

  // What the licence still holds: a repeat of a note the first half prints as a ROW and its caption does
  // not, so the joined caption never names it and each dropped row is a row gone. Past one, the free path
  // declines rather than handing `verifyJoin` a table it refuses as `rows_lost`, which is the same answer
  // one editor call earlier. One of the two shapes that reach the bound, neither measured; the other is the
  // pair with two distinct notes, pinned at the end of this test, where the decline is over-refusal rather
  // than a refusal in the right direction. The pair the free-join legs above cover reaches it in neither
  // spelling: with no caption of its own the import covers every row dropped after it, and with one, the
  // only row dropped is the second half's.
  const titled = `<table><caption>Table 7.—Grants</caption>${HEAD}<tbody>${noteRow(note)}${dataRow("Alabama")}</tbody></table>`;
  const twoRepeats = `<table><caption>Table 7.—Grants—Continued</caption>${HEAD}<tbody>${noteRow(note)}${noteRow(note)}${dataRow("Vermont")}</tbody></table>`;
  const overPair = onePair(titled + twoRepeats);
  assert.deepEqual(joinInCode(overPair), { reason: "note_repeats_exceed_licence" });
  // And that decline is not a taste: the table it would have produced is refused, by the row check.
  const wouldBe = `<table><caption>Table 7.—Grants</caption>${HEAD}<tbody>${noteRow(note)}${dataRow("Alabama")}${dataRow("Vermont")}</tbody></table>`;
  assert.equal(verifyJoin(overPair, wouldBe), "rows_lost");
  // One repeat of the same shape stays free, so the bound is what moved and not the case.
  const oneRepeat = `<table><caption>Table 7.—Grants—Continued</caption>${HEAD}<tbody>${noteRow(note)}${dataRow("Vermont")}</tbody></table>`;
  const okPair = onePair(titled + oneRepeat);
  const okJoin = joinInCode(okPair);
  assert.ok("html" in okJoin, JSON.stringify(okJoin));
  assert.equal(verifyJoin(okPair, okJoin.html), null);

  // The licence is asked the way `rowFloor` asks it — `max` of rule 6's one row and the rows the finished
  // caption accounts for, never the sum — because a pair dropping one COVERED row and one UNCOVERED one
  // otherwise passes here and comes back `rows_lost`, which is an editor call spent on an answer the same
  // floor refuses again. Two distinct notes on one table — the second of the two shapes, and 0 of the 769
  // tables in the round logs have it.
  const other = "[Percentage distribution]";
  const twoNotes = onePair(
    `<table><caption>Table 7.—Grants ${note}</caption>${HEAD}<tbody>${noteRow(other)}${dataRow("Alabama")}</tbody></table>` +
      `<table><caption>Table 7.—Grants ${note}—Continued</caption>${HEAD}<tbody>${noteRow(note)}${noteRow(other)}${dataRow("Vermont")}</tbody></table>`,
  );
  assert.deepEqual(joinInCode(twoNotes), { reason: "note_repeats_exceed_licence" });
  // And the residue, pinned rather than described: the correct join of that pair — rule 6 to the letter,
  // every data row kept — is refused, because the floor licenses the caption's rows and ONE repeat, not
  // two. So the pair ships split. Nothing measured has this shape, and the fix is a wider floor.
  const correct = `<table><caption>Table 7.—Grants ${note}</caption>${HEAD}<tbody>${noteRow(other)}${dataRow("Alabama")}${dataRow("Vermont")}</tbody></table>`;
  assert.equal(verifyJoin(twoNotes, correct), "rows_lost");

  // And the other spelling of the mixed pair, which the comment above says cannot reach the bound: a first
  // half with a caption of its own that lacks the note, printing the note as a row, against a second half
  // carrying it in the caption AND repeating the row. No import here, so only the second half's row is
  // dropped, which is one. Asserted rather than reasoned, because that comment is the kind that goes stale.
  const mixedTitled = onePair(
    titled + `<table><caption>Table 7.—Grants ${note}—Continued</caption>${HEAD}<tbody>${noteRow(note)}${dataRow("Vermont")}</tbody></table>`,
  );
  const mixedJoin = joinInCode(mixedTitled);
  assert.ok("html" in mixedJoin, JSON.stringify(mixedJoin));
  assert.equal(verifyJoin(mixedTitled, mixedJoin.html), null);

  // And the half that has to do the repeating for shape 1 is the CONTINUED one, which the comment above
  // said as "a half" for one commit. The bound counts DROPS, and a first half printing the note row twice
  // never supplies two: with a caption of its own, nothing in its rows is dropped at all, and with none,
  // the import carries the second's note so both drops are covered. Both spellings pinned, because a
  // reader chasing this reason out of a run log who builds it off the first half finds a free join.
  const firstTwiceTitled = onePair(
    `<table><caption>Table 7.—Grants</caption>${HEAD}<tbody>${noteRow(note)}${noteRow(note)}${dataRow("Alabama")}</tbody></table>` +
      oneRepeat,
  );
  const firstTwiceJoin = joinInCode(firstTwiceTitled);
  assert.ok("html" in firstTwiceJoin, JSON.stringify(firstTwiceJoin));
  assert.equal(verifyJoin(firstTwiceTitled, firstTwiceJoin.html), null);
  const firstTwiceBare = onePair(
    `<table>${HEAD}<tbody>${noteRow(note)}${noteRow(note)}${dataRow("Alabama")}</tbody></table>` + second,
  );
  const bareJoin = joinInCode(firstTwiceBare);
  assert.ok("html" in bareJoin, JSON.stringify(bareJoin));
  assert.equal(verifyJoin(firstTwiceBare, bareJoin.html), null);
});

test("a note row inside the header block is not a header cell in either spelling", () => {
  // The corpus prints that phantom row both ways — `p068`'s `<td colspan="8">` and `p029`'s `<th>`, one
  // each of the two the census located inside `<thead>`, and 6 of 8 across every round log are `<th>` —
  // and rule 6 says the same thing about both: carry the note into the caption once, print no row. While
  // `headerCells` counted the `<th>` one, `header_cells_lost` refused the merge for obeying that, and it
  // is asked before any note reason, so the log named the header block collapsing. Guarding the free
  // path's drop is not the fix: the same count refuses the EDITOR's answer, where the price is a split
  // table rather than one call. So the count is on the cells that describe columns.
  const note = "[Percentage distribution]";
  const cols = `<tr><th scope="col">Col 1</th><th scope="col">Col 2</th><th scope="col">Col 3</th></tr>`;
  const headWith = (cell: string) => `<thead>${cols}<tr>${cell}</tr></thead>`;

  for (const cell of [`<td colspan="3">${note}</td>`, `<th colspan="3">${note}</th>`]) {
    const head = headWith(cell);
    // The editor's answer first, because that is the expensive path: rule 6 obeyed to the letter.
    const kept = `<table><caption>Table 9.—Revenue</caption>${head}<tbody>${dataRow("Alabama")}</tbody></table>`;
    const cont = `<table><caption>Table 9.—Revenue—Continued</caption>${head}<tbody>${dataRow("Vermont")}</tbody></table>`;
    const paid = onePair(kept + cont);
    const rule6 = `<table><caption>Table 9.—Revenue ${note}</caption><thead>${cols}</thead><tbody>${dataRow("Alabama")}${dataRow("Vermont")}</tbody></table>`;
    assert.equal(verifyJoin(paid, rule6), null, cell);
    // And a reply that dropped a real column header still loses one, which is what the count is for.
    const flat = `<table><caption>Table 9.—Revenue ${note}</caption><thead><tr><th scope="col">Col 1</th><th scope="col">Col 2</th><td>Col 3</td></tr></thead><tbody>${dataRow("Alabama")}${dataRow("Vermont")}</tbody></table>`;
    assert.equal(verifyJoin(paid, flat), "header_cells_lost", cell);

    // Then the free path, where the same row is the repeat the imported caption already carries.
    const capless = `<table>${head}<tbody>${dataRow("Alabama")}</tbody></table>`;
    const noted = `<table><caption>Table 9.—Revenue ${note}—Continued</caption>${head}<tbody>${dataRow("Vermont")}</tbody></table>`;
    const free = onePair(capless + noted);
    assert.equal(free.first.caption, "", "the fixture is not the caption-importing case");
    const coded = joinInCode(free);
    assert.ok("html" in coded, `${cell}: ${JSON.stringify(coded)}`);
    assert.equal(verifyJoin(free, coded.html), null, cell);
    assert.equal([...coded.html.matchAll(/Percentage distribution/g)].length, 1, coded.html);
  }
});

test("a note neither caption carried and no row keeps is a note the merge deleted", () => {
  // The pair whose halves printed the note ONLY as a row: every other note reason is keyed on a caption
  // note, so `owed` and `titleNotes` are empty here and the whole harm the placement rule exists to
  // remove was invisible — on the corpus's 12 outside-caption placements. True of `<td>` from the day
  // the note checks went in, and of `<th>` from the commit that stopped counting a note row's cell as a
  // header cell, which was the only thing that had ever caught it and by the wrong name.
  const note = "[Percentage distribution]";
  const cols = `<tr><th scope="col">Col 1</th><th scope="col">Col 2</th><th scope="col">Col 3</th></tr>`;
  const both = `${dataRow("Alabama")}${dataRow("Vermont")}`;

  for (const cell of [`<td colspan="3">${note}</td>`, `<th colspan="3">${note}</th>`]) {
    const head = `<thead>${cols}<tr>${cell}</tr></thead>`;
    const a = `<table><caption>Table 9.—Revenue</caption>${head}<tbody>${dataRow("Alabama")}</tbody></table>`;
    const b = `<table><caption>Table 9.—Revenue—Continued</caption>${head}<tbody>${dataRow("Vermont")}</tbody></table>`;
    const pair = onePair(a + b);
    assert.doesNotMatch(pair.first.caption + pair.second.caption, /\[/, "the fixture has a caption note");
    assert.equal(pair.first.noteRows.length, 1, "the fixture's half did not print the note as a row");

    const gone = `<table><caption>Table 9.—Revenue</caption><thead>${cols}</thead><tbody>${both}</tbody></table>`;
    assert.equal(verifyJoin(pair, gone), "note_row_lost", cell);
    // The three answers that are not a deletion, and none of them may be called one. Rule 6's promotion
    // into the caption is the answer the prompt asks for; the row kept where the halves had it is the
    // pair where nothing moved; and a note moved out of `<thead>` into `<tbody>` is a RELOCATION, which
    // this must not name — the reason would send the repair at rule 6 instead of at `page.md`.
    const promoted = `<table><caption>Table 9.—Revenue ${note}</caption><thead>${cols}</thead><tbody>${both}</tbody></table>`;
    assert.equal(verifyJoin(pair, promoted), null, cell);
    const asRow = `<table><caption>Table 9.—Revenue</caption>${head}<tbody>${both}</tbody></table>`;
    assert.equal(verifyJoin(pair, asRow), null, cell);
    const moved = `<table><caption>Table 9.—Revenue</caption><thead>${cols}</thead><tbody><tr><td colspan="3">${note}</td></tr>${both}</tbody></table>`;
    assert.equal(verifyJoin(pair, moved), null, cell);
  }

  // And the bound on what this reason adds, which two rounds of comment overstated: only the row inside
  // the HEADER BLOCK was ever invisible. A note row in `<tbody>` is a data row whose label is the
  // bracketed run, so `labels_lost` and `rows_lost` answered it from the day they existed and still do,
  // being asked first — right, because an answer that dropped this row and three state rows should report
  // the four. The `<tbody>` case is refused under a name about a missing row label rather than the units.
  const row = `<tr><td colspan="3">${note}</td></tr>`;
  const plain = `<table><caption>Table 9.—Revenue</caption><thead>${cols}</thead>`;
  const onlyFirst = onePair(
    `${plain}<tbody>${row}${dataRow("Alabama")}${dataRow("Georgia")}</tbody></table>` +
      `<table><caption>Table 9.—Revenue—Continued</caption><thead>${cols}</thead><tbody>${dataRow("Vermont")}</tbody></table>`,
  );
  const kept3 = `${plain}<tbody>${dataRow("Alabama")}${dataRow("Georgia")}${dataRow("Vermont")}</tbody></table>`;
  assert.equal(verifyJoin(onlyFirst, kept3), "labels_lost:1");
  const bothHalves = onePair(
    `${plain}<tbody>${row}${dataRow("Alabama")}</tbody></table>` +
      `<table><caption>Table 9.—Revenue—Continued</caption><thead>${cols}</thead><tbody>${row}${dataRow("Vermont")}</tbody></table>`,
  );
  assert.equal(verifyJoin(bothHalves, `${plain}<tbody>${both}</tbody></table>`), "rows_lost");
});

test("a note row the joined caption absorbed is not a row the merge lost", () => {
  // The promotion `page.md` wants, from a `<tbody>` note row both halves printed: the note goes into the
  // caption once and its two rows stop existing. `rowFloor` counted them gone and answered `rows_lost` —
  // the wrong name, and refusing the EDITOR's answer ships both halves split, which is what the whole
  // note block has been paying rounds to stop doing. The label check twelve lines further on already
  // forgave this exact move; the row check had no equivalent. It does now, bounded the same way, and the
  // slack must not extend one row past the ones the caption took: the last two legs are why.
  const note = "[Percentage distribution]";
  const cols = `<thead><tr><th scope="col">Col 1</th><th scope="col">Col 2</th><th scope="col">Col 3</th></tr></thead>`;
  const row = `<tr><td colspan="3">${note}</td></tr>`;
  const a = ["A1", "A2", "A3", "A4"].map((l) => dataRow(l)).join("");
  const b = ["B1", "B2", "B3", "B4"].map((l) => dataRow(l)).join("");
  const cap = (extra = "") => `<caption>Table 9.—Revenue${extra}</caption>`;
  const answer = (capText: string, body: string) => `<table>${capText}${cols}<tbody>${body}</tbody></table>`;
  const pair = onePair(
    `<table>${cap()}${cols}<tbody>${row}${a}</tbody></table>` +
      `<table>${cap("—Continued")}${cols}<tbody>${row}${b}</tbody></table>`,
  );

  assert.equal(verifyJoin(pair, answer(cap(` ${note}`), a + b)), null, "promoted into the caption");
  // Rule 6 to the letter — keep the first half's row, drop the repeat — was accepted before and still is.
  assert.equal(verifyJoin(pair, answer(cap(), row + a + b)), null, "rule 6 literal");
  // Deleted outright, no caption note: still refused, and by the row check as before.
  assert.equal(verifyJoin(pair, answer(cap(), a + b)), "rows_lost", "deleted");
  // The bound. Promotion buys forgiveness for the two rows the caption took and not one row more, and it
  // is the ROW check that has to hold it: the row a lossy reply drops need not have a label, and the one
  // this leg drops does not. It cost a round to get right — the exemption was first written as an addition
  // to `JOIN_DROPPABLE_ROWS`, which is rule 6's own repeat row, so an absorbed row was paid for twice and a
  // real data row went with it. Both legs here passed under that reading, and `labels` saw neither.
  const blank = `<tr><td></td><td>9</td><td>9</td></tr>`;
  const wide = onePair(
    `<table>${cap()}${cols}<tbody>${row}${a}${blank}</tbody></table>` +
      `<table>${cap("—Continued")}${cols}<tbody>${row}${b}${blank}</tbody></table>`,
  );
  assert.equal(verifyJoin(wide, answer(cap(` ${note}`), a + blank + b + blank)), null, "promoted, nothing lost");
  assert.equal(verifyJoin(wide, answer(cap(` ${note}`), a + blank + b)), "rows_lost", "and one unlabelled gone");
  // A labelled row going is the same answer, since the row check is asked first and a row did go.
  assert.equal(verifyJoin(pair, answer(cap(` ${note}`), a + b.replace(dataRow("B4"), ""))), "rows_lost");
  const lessTwo = b.replace(dataRow("B4"), "").replace(dataRow("B3"), "");
  assert.equal(verifyJoin(pair, answer(cap(` ${note}`), a + lessTwo)), "rows_lost");

  // And the pair the census makes commonest, which has nothing promoted: the note in the FIRST half's
  // caption and printed as a row by the second, where the dropped row is rule 6's repeat and the one row
  // the floor forgives is what pays for it. The exemption must add nothing here, or this pair buys two.
  const withNote = (extra = "") => `<caption>Table 9.—Revenue ${note}${extra}</caption>`;
  const mixed = onePair(
    `<table>${withNote()}${cols}<tbody>${a}${blank}</tbody></table>` +
      `<table>${withNote("—Continued")}${cols}<tbody>${row}${b}${blank}</tbody></table>`,
  );
  assert.equal(verifyJoin(mixed, answer(withNote(), a + blank + b + blank)), null, "rule 6 to the letter");
  assert.equal(verifyJoin(mixed, answer(withNote(), a + blank + b)), "rows_lost", "and one unlabelled gone");
});

test("a note the joined table keeps in its caption and prints as a row as well is shipped twice", () => {
  // Rule 6 says of the second half's repeat "drop it, and do not also copy it in under rule 1", and
  // nothing read that half of the rule. Every check here treated a note row as an EXCUSE for a note
  // missing from the caption, so a note row excusing nothing was never looked at: the caption was right,
  // the row was extra, and a reader moving by row still met the units as a cell of data. Nothing else
  // catches it — rows are only floored, `labels_lost` counts the caption's bracketed runs as present,
  // and axe reports nothing about a full-width `<td>` row.
  const note = "[In millions of dollars]";
  const first = `<table><caption>Table 5.—Debt ${note}</caption>${HEAD}<tbody>${dataRow("Alabama")}</tbody></table>`;
  const second = `<table><caption>Table 5.—Debt—Continued</caption>${HEAD}<tbody>${noteRow(note)}${dataRow("Vermont")}</tbody></table>`;
  const pair = onePair(first + second);
  const rows = `${dataRow("Alabama")}${dataRow("Vermont")}`;
  const cap = `<caption>Table 5.—Debt ${note}</caption>`;

  // The three the review of this PR ran: the row the second half printed copied in under rule 1, the
  // `<th>` spelling of it, and — on a pair where NO half printed a note row at all — a row invented.
  for (const twice of [
    `<table>${cap}${HEAD}<tbody>${noteRow(note)}${rows}</tbody></table>`,
    `<table>${cap}${HEAD}<tbody><tr><th colspan="3">${note}</th></tr>${rows}</tbody></table>`,
    `<table>${cap}<thead><tr><th scope="col">Col 1</th><th scope="col">Col 2</th><th scope="col">Col 3</th></tr>${noteRow(note)}</thead><tbody>${rows}</tbody></table>`,
  ]) {
    assert.equal(verifyJoin(pair, twice), "note_shipped_twice", twice.slice(0, 90));
  }
  const plain = `<table><caption>Table 5.—Debt—Continued</caption>${HEAD}<tbody>${dataRow("Vermont")}</tbody></table>`;
  const noRowAnywhere = onePair(first + plain);
  const invented = `<table>${cap}${HEAD}<tbody>${noteRow(note)}${rows}</tbody></table>`;
  assert.equal(verifyJoin(noRowAnywhere, invented), "note_shipped_twice");

  // Once is once, in either place: the caption alone clears, and so does the row alone on the pair whose
  // discarded caption carried the note — so what this refuses is the second copy and not either place.
  assert.equal(verifyJoin(pair, `<table>${cap}${HEAD}<tbody>${rows}</tbody></table>`), null);
  const coded = joinInCode(pair);
  assert.ok("html" in coded, JSON.stringify(coded));
  assert.equal(verifyJoin(pair, coded.html), null);
});

test("rule 6 names the caption the editor is writing, not the half that printed the note", () => {
  // A refusal the prompt cannot avoid is a permanent decline, and this one nearly was. Rule 4 tells the
  // editor to put the note in the joined caption where EITHER half's caption carries it — including a
  // caption taken from the continued half because the first has none. Rule 6 used to license dropping the
  // repeat row only "where the first half already carries that note in its caption", which is false of
  // exactly that pair: the note is in the caption the editor is writing and in a row of the first half,
  // and no sentence said to drop the row. The two rules together asked for the shape `note_shipped_twice`
  // refuses. So rule 6's condition is the caption being WRITTEN, which covers both routes to it.
  assert.match(TABLE_JOIN_SYSTEM, /wherever the caption you are writing under rule 4 carries that note/);
  assert.match(TABLE_JOIN_SYSTEM, /because the caption you took from the continued half did/);
  assert.doesNotMatch(TABLE_JOIN_SYSTEM, /in the caption if that is where the first half has it/);
  // And the other direction stays forbidden, which is the clause the census's 12 outside-caption pages
  // are about: the note does not travel the other way, out of a caption and into a row.
  assert.match(TABLE_JOIN_SYSTEM, /does not become a row of the joined table/);
});

test("a fullwidth-bracketed note is a note in both readers, or it ships twice", () => {
  // One arm writes ［Percentage distribution］ with fullwidth brackets — 1 of the 68 delimited notes in
  // #374's corpus. It is read because the cost is a character class, and because the two readers have
  // to agree: a caption reader that saw this spelling while the ROW reader did not would leave the
  // second half's repeat looking like an ordinary data row, copy it in under rule 1, and ship the note
  // in the caption AND as a phantom row — the harm the caption rule exists to remove, put back by the
  // two halves of the code disagreeing about what a note looks like.
  const note = noteRow("［Percentage distribution］");
  const first = `<table><caption>Table 6.—Shares ［Percentage distribution］</caption>${HEAD}<tbody>${dataRow("Alabama")}</tbody></table>`;
  const second = `<table><caption>Table 6.—Shares—Continued</caption>${HEAD}<tbody>${note}${dataRow("Vermont")}</tbody></table>`;
  const pair = onePair(first + second);

  const coded = joinInCode(pair);
  assert.ok("html" in coded, JSON.stringify(coded));
  assert.ok(!coded.html.includes("<td colspan"), "the repeat row survived, so the row reader missed the spelling");
  assert.equal(verifyJoin(pair, coded.html), null);
});

test("an id inside the note row rule 6 drops has not survived the join", async () => {
  // Rule 6 and rule 2 meet here: the note repeats on both pages, and each page's copy carries its own
  // footnote anchor. Dropping the repeat as a duplicate ROW drops the anchor with it, and it is the one
  // dropped id no other check can reach — the duplicate-id read cannot see an id that is already gone,
  // and `verifyJoin` never reads an id at all. Which is why rule 2 is read off the FINISHED table
  // rather than off the rows this function expects to keep: the expectation was wrong here.
  // Inside the brackets, because that is what makes the two rows the same NOTE: rule 6 matches on the
  // row's text, and an anchor's digit is part of it.
  const marked = (page: number) =>
    noteRow(`[In millions of dollars<sup><a href="#p${page}-fn-1" id="p${page}-fnref-1">1</a></sup>]`);
  const first = `<table><caption>Table 5.—Debt</caption>${HEAD}<tbody>${marked(7)}${dataRow("Alabama")}</tbody></table>`;
  const second = `<table><caption>Table 5.—Debt—Continued</caption>${HEAD}<tbody>${marked(8)}${dataRow("Vermont")}</tbody></table>`;
  const pair = onePair(first + second);

  assert.deepEqual(joinInCode(pair), { reason: "id_would_be_lost" });
  // The two notes ARE the same note, so rule 6 is right about the row; what makes it the editor's is
  // the anchor. This is the table the drop would have shipped, and the check that refuses a bad merge
  // calls it sound.
  const lossy =
    `<table><caption>Table 5.—Debt</caption>${HEAD}` +
    `<tbody>${marked(7)}${dataRow("Alabama")}${dataRow("Vermont")}</tbody></table>`;
  assert.ok(!lossy.includes("p8-fnref-1"));
  assert.equal(verifyJoin(pair, lossy), null, "verifyJoin can see a dropped id after all");
});

test("a second half with no header block is still held to the first half's width", async () => {
  // Rule 3 has nothing to compare where the continued page did not reprint the header — but the rows
  // still have to fit. A four-cell row appended under a three-column `<thead>` is a cell with no
  // header, the 1.3.1 defect this whole stage exists to reduce, and `columns_lost` cannot see it: the
  // appended row is the widest row in the joined table, so the joined table is not narrower than
  // either half. Held to how wide the first half already is, not to its header block, because a first
  // half whose own rows already run wider carries a defect this join did not introduce.
  const first = `<table><caption>Table 12.—Loans</caption>${HEAD}<tbody>${dataRow("Alabama")}</tbody></table>`;
  const wide = `<tr><th scope="row">Vermont</th><td>1.0</td><td>1.0</td><td>1.0</td></tr>`;
  const second = `<table><caption>Table 12.—Loans—Continued</caption><tbody>${wide}</tbody></table>`;
  const pair = onePair(first + second);

  assert.deepEqual(joinInCode(pair), { reason: "columns_differ" });
  const widened =
    `<table><caption>Table 12.—Loans</caption>${HEAD}<tbody>${dataRow("Alabama")}${wide}</tbody></table>`;
  assert.equal(verifyJoin(pair, widened), null, "verifyJoin can see a widened join after all");
});

test("a marker that is not wholly inside one text node is the editor's", async () => {
  // The middle piece of a chain carries the marker itself, and it has to come off or `verifyJoin`
  // refuses the result as `still_continued`. Where markup splits the marker, taking it off means
  // deciding what to do with an `<em>` — and rewriting the caption as text instead would drop the
  // `<sup>` footnote reference some captions carry, which is rule 2's case by another door.
  const middle = `<table><caption>Table 6.—Yield —<em>Continued</em></caption>${HEAD}<tbody>${dataRow("Arizona")}</tbody></table>`;
  const last = `<table><caption>Table 6.—Yield—Continued</caption>${HEAD}<tbody>${dataRow("Vermont")}</tbody></table>`;
  assert.deepEqual(joinInCode(onePair(middle + last)), { reason: "caption_unclear" });

  // The ordinary chain middle, whose marker is plain text, is a move: it comes off and the join stands.
  const plain = `<table><caption>Table 6.—Yield—Continued</caption>${HEAD}<tbody>${dataRow("Arizona")}</tbody></table>`;
  const joined = joinInCode(onePair(plain + last));
  assert.ok("html" in joined, JSON.stringify(joined));
  assert.ok(!CONTINUED_CAPTION.test(joined.html), "a joined table still calling itself a continuation");
});

test("a first half with no caption borrows the second half's, markup and ids and all", async () => {
  // `verifyJoin` requires a caption, and the second half's is the printed page's own words for this
  // table, so taking it is still a move rather than an invention. Imported as an ELEMENT: written back
  // as text it would lose the `<a id>` an endnote links to.
  const first = `<table>${HEAD}<tbody>${dataRow("Alabama")}</tbody></table>`;
  const second =
    `<table><caption>Table 12.—Outlays<sup><a href="#p9-fn-1" id="p9-fnref-1">1</a></sup>—Continued</caption>` +
    `${HEAD}<tbody>${dataRow("Vermont")}</tbody></table>`;
  const joined = joinInCode(onePair(first + second));

  assert.ok("html" in joined, JSON.stringify(joined));
  assert.equal(
    joined.html,
    `<table><caption>Table 12.—Outlays<sup><a href="#p9-fn-1" id="p9-fnref-1">1</a></sup></caption>` +
      `${HEAD}<tbody>${dataRow("Alabama")}${dataRow("Vermont")}</tbody></table>`,
  );
});

test("a pair with no caption anywhere is the editor's", async () => {
  // Built by hand because `continuationPairs` cannot produce it: a pair exists because the SECOND
  // half's caption says "Continued", so that caption is always there. The guard is what makes the
  // branch above safe to write, and it would be the answer if the pairing rule ever read something
  // else.
  const bare = `<table>${HEAD}<tbody>${dataRow("Alabama")}</tbody></table>`;
  assert.deepEqual(joinInCode(asPair(bare, bare)), { reason: "no_caption_available" });
});

test("rows are not appended after a table's own summary", async () => {
  // Where the second half's rows go is the first half's last `<tbody>`, which is what keeps rule 5's
  // group labels in place. A first half whose rows are all in `<thead>` and `<tfoot>` has no `<tbody>`
  // to append to, and appending to the table itself would put data rows after the summary — a change
  // to reading order rather than a move of bytes. The corpus has none; the guard is one line.
  const first =
    `<table><caption>Table 4.—Rates</caption>${HEAD}<tfoot>${noteRow("Source: Census.")}</tfoot></table>`;
  const second = `<table><caption>Table 4.—Rates—Continued</caption>${HEAD}<tbody>${dataRow("Vermont")}</tbody></table>`;
  assert.deepEqual(joinInCode(onePair(first + second)), { reason: "tfoot_no_tbody" });
});

test("a half the parser cannot read is the editor's rather than the document's problem", async () => {
  const deep = `<table>${"<div>".repeat(200_000)}</table>`;
  const ok = `<table><caption>Table 1.—Income—Continued</caption>${HEAD}<tbody>${dataRow("Vermont")}</tbody></table>`;
  // `attempt` at the call site turns the throw into a decline; here it is the throw itself that is
  // pinned, so a future rewrite that swallowed it would still be seen to.
  assert.throws(() => joinInCode(asPair(deep, ok)));
  // And the header fields are read off these same two halves, so they cannot be on that decline either.
  // This is why absence of them does NOT identify the `unreadable` reason: `read_failed` has two
  // producers, and this one — the join throwing — emits it with all seven fields missing, while the
  // other — the verifier throwing on the merged candidate — emits it with all seven present.
  assert.throws(() => headerSignatures(asPair(deep, ok)));
});

// --- what a decline says about the two headers (#326) ---

// The free path's coverage is not a property of this code: the same rules on the same corpus took 9 of
// 17 pairs one round and 4 the next, because two readings of one printed header agree 48-61% of the
// time. `headerSignatures` is what puts that on the decline line, so the next round's declines can be
// re-scored without paying for a round.

test("a decline carries both halves' header blocks, as rule 3 compared them", async () => {
  const first = piece("Table 10.—Collections", STATES);
  const second = reworded("Table 10.—Collections—Continued", REST);
  const read = headerSignatures(onePair(first + second));

  assert.ok(read !== null);
  assert.deepEqual(read, {
    first: { signature: "TH:1:Col 1|TH:1:Col 2|TH:1:Col 3", rows: 1, cells: 3 },
    second: { signature: "TH:1:Column 1|TH:1:Column 2|TH:1:Column 3", rows: 1, cells: 3 },
  });
});

test("a header cell's own text can hold the separators, so the counts are not read off the string", async () => {
  // `normalizeCell` folds whitespace and drops soft hyphens and leaves `|` alone, and a printed census
  // header really does write `Farm | Non-farm`. Splitting the signature back up would call this four
  // cells; the DOM says three, and the DOM is what the signature was built from.
  const piped = `<thead><tr><th scope="col">Farm | Non-farm</th><th scope="col">Col 2</th><th scope="col">Col 3</th></tr></thead>`;
  const first = `<table><caption>Table 3.—Income</caption>${piped}<tbody>${dataRow("Alabama")}</tbody></table>`;
  const second = `<table><caption>Table 3.—Income—Continued</caption>${HEAD}<tbody>${dataRow("Vermont")}</tbody></table>`;
  const read = headerSignatures(onePair(first + second));

  assert.equal(read?.first.cells, 3);
  assert.equal(read?.first.signature.split("|").length, 4, "the string has one more piece than the block has cells");
});

test("no header block and no readable table are different answers", async () => {
  // The middle piece of a chain declares no header block at all, which is a fact about the printing —
  // `rows: 0` and an empty signature. A half no parser can read is a fact about the parser, and the
  // whole reading is withheld: null, never a zero that would be counted as a stable header.
  const first = `<table><caption>Table 8.—Yield</caption>${HEAD}<tbody>${dataRow("Alabama")}</tbody></table>`;
  const second = `<table><caption>Table 8.—Yield—Continued</caption><tbody>${dataRow("Vermont")}</tbody></table>`;

  assert.deepEqual(headerSignatures(onePair(first + second))?.second, { signature: "", rows: 0, cells: 0 });
  assert.equal(headerSignatures(asPair(first, "<p>no table here</p>")), null);
});

// --- the splice ---

test("a joined pair becomes one table and the rest of the body is untouched", async () => {
  const first = piece("Table 1.—Income by State", STATES);
  const second = reworded("Table 1.—Income by State—Continued", REST);
  const body = `<h2>Income</h2>${first}<hr role="doc-pagebreak">${second}<p>Source: Census.</p>`;
  const merged = goodJoin("Table 1.—Income by State", STATES, REST);
  const { ctx, rec } = ctxWith(() => envelope(merged));

  const out = await joinContinuedTables(ctx, body);

  // Byte-exact, because this stage edits the document that ships: the first half's span becomes
  // the joined table, the second half's span goes, and everything else — including the page-break
  // marker that sat at the seam, which is now after the joined table — is where it was.
  assert.equal(out, `<h2>Income</h2>${merged}<hr role="doc-pagebreak"><p>Source: Census.</p>`);
  assert.equal(rec.calls.length, 1);
  // Both halves in the prompt, in full: the join is decided on the bytes and not on a description
  // of them.
  assert.ok(rec.calls[0].includes(first) && rec.calls[0].includes(second));

  const [found] = events(rec, "table_continuations");
  assert.deepEqual(found.data, { tables: 2, pairs: 1 });
  const [joined] = events(rec, "table_joined");
  assert.equal(joined.data.rows_first, STATES.length + 1);
  assert.equal(joined.data.rows_second, REST.length + 1);
  assert.equal(joined.data.rows_joined, STATES.length + REST.length + 1);
  assert.equal(joined.data.caption, "Table 1.—Income by State");
  assert.equal(joined.data.by, "editor", "a pair the code path declined was booked to it anyway");
  // And the log says why the request was bought, which is the only way to tell a pair the code path
  // cannot do from a pair it was never offered.
  const [stood] = events(rec, "table_join_code_declined");
  assert.equal(stood.data.reason, "header_differs");
  assert.equal(stood.data.caption, "Table 1.—Income by State—Continued");
  // And the two headers themselves, which is what a later round needs to tell a pair whose halves
  // really describe different columns from a pair whose header was read twice and came out differently
  // (#326). A reason and a caption can count declines; only these can explain one.
  assert.equal(stood.data.headers_identical, false);
  assert.equal(stood.data.header_rows_first, 1);
  assert.equal(stood.data.header_cells_first, 3);
  assert.equal(stood.data.header_rows_second, 1);
  assert.equal(stood.data.header_cells_second, 3);
  assert.equal(stood.data.header_first, "TH:1:Col 1|TH:1:Col 2|TH:1:Col 3");
  assert.equal(stood.data.header_second, "TH:1:Column 1|TH:1:Column 2|TH:1:Column 3");
});

test("a decline for another reason still says whether the headers agreed", async () => {
  // The point of putting the comparison on every decline rather than on `header_differs` alone. This
  // pair stands down over an id in a repeated note row, and its two header blocks are the same block:
  // `headers_identical: true` beside a decline is the shape that keeps the stability count honest,
  // because the alternative — filtering declines to `header_differs` — reads one guard's verdict as
  // the measurement, and #326 watched the width check and the id rule fire on pairs that had joined
  // for free a round earlier.
  const marked = (page: number) =>
    noteRow(`[In millions of dollars<sup><a href="#p${page}-fn-1" id="p${page}-fnref-1">1</a></sup>]`);
  const first = `<table><caption>Table 5.—Debt</caption>${HEAD}<tbody>${marked(7)}${dataRow("Alabama")}</tbody></table>`;
  const second = `<table><caption>Table 5.—Debt—Continued</caption>${HEAD}<tbody>${marked(8)}${dataRow("Vermont")}</tbody></table>`;
  // The editor's answer is not what this test is about; it fails, and the document keeps both halves.
  const { ctx, rec } = ctxWith(() => envelope(null));

  await joinContinuedTables(ctx, first + second);

  const [stood] = events(rec, "table_join_code_declined");
  assert.equal(stood.data.reason, "id_would_be_lost");
  assert.equal(stood.data.headers_identical, true);
  assert.equal(stood.data.header_first, stood.data.header_second);
});

test("a capped signature cannot be read as agreement, because the line already answered that", async () => {
  // A header wider than the 1,200-character cap, differing only past it: both strings arrive at the log
  // CUT AT THE SAME PREFIX, which is exactly the reading that would manufacture the stability this
  // field exists to measure. So `headers_identical` is computed on the full text before either is cut,
  // and the truncation is visible.
  const wide = (last: string) =>
    `<thead><tr>${Array.from({ length: 50 }, (_, c) => `<th scope="col">Column heading number ${c + 1}</th>`).join("")}` +
    `<th scope="col">${last}</th></tr></thead>`;
  const first = `<table><caption>Table 20.—Wide</caption>${wide("Alpha")}<tbody>${dataRow("Alabama")}</tbody></table>`;
  const second = `<table><caption>Table 20.—Wide—Continued</caption>${wide("Omega")}<tbody>${dataRow("Vermont")}</tbody></table>`;
  const { ctx, rec } = ctxWith(() => envelope(null));

  await joinContinuedTables(ctx, first + second);

  const [stood] = events(rec, "table_join_code_declined");
  assert.equal(stood.data.reason, "header_differs");
  assert.equal(stood.data.headers_identical, false, "the difference is past the cap and still counted");
  assert.equal(stood.data.header_first, stood.data.header_second, "the capped strings are identical");
  assert.equal(String(stood.data.header_first).length, 1201, "1,200 characters and the marker");
  assert.ok(String(stood.data.header_first).endsWith("…"));
  // The counts are computed on the whole block too, so the cells past the cap are still counted.
  assert.equal(stood.data.header_rows_first, 1);
  assert.equal(stood.data.header_cells_first, 51);
});

// --- replaying a decline ---

test("a declined pair replays to the same verdict from its log line alone", async () => {
  // #326's open half. The bytes on the line ARE the pair, so a candidate loosening of a guard is scored
  // against the pairs a paid round already bought: read them back with `pairFromHalves` and the free
  // path returns the verdict it returned in the round, with no model and no round.
  const first = piece("Table 4.—Revenue", STATES);
  const second = reworded("Table 4.—Revenue—Continued", REST);
  const { ctx, rec } = ctxWith(() => envelope(null));

  await joinContinuedTables(ctx, first + second);

  const [stood] = events(rec, "table_join_code_declined");
  assert.equal(stood.data.halves, "logged");
  assert.equal(stood.data.chars_first, first.length);
  assert.equal(stood.data.chars_second, second.length);
  // Byte for byte and not a normalization of them: a re-score has to parse what the round parsed.
  assert.equal(stood.data.html_first, first);
  assert.equal(stood.data.html_second, second);

  const replayed = pairFromHalves(String(stood.data.html_first), String(stood.data.html_second));
  assert.ok(replayed !== null);
  // Against the reason the line carries rather than against a literal, which is the claim that matters:
  // the replay agrees with the round, whatever the round said.
  assert.deepEqual(joinInCode(replayed), { reason: stood.data.reason });
});

test("a free join carries its halves too, because those are the pairs a loosening must not break", async () => {
  // Two populations and one question. A loosening's upside is on the declines; the joins the free path
  // ALREADY takes are what it could break, so those carry their bytes as well — and a replayed pair
  // reaches `verifyJoin`, which is the check that would catch a wrong loosening rather than the guard
  // being loosened.
  const first = piece("Table 1.—Income", STATES);
  const second = piece("Table 1.—Income—Continued", REST);
  const { ctx, rec } = ctxWith(() => {
    throw new Error("a pair the code could join was put to the editor");
  });

  await joinContinuedTables(ctx, first + second);

  const [joined] = events(rec, "table_joined");
  assert.equal(joined.data.by, "code");
  assert.equal(joined.data.halves, "logged");
  assert.equal(Number(joined.data.chars_first) + Number(joined.data.chars_second), joined.data.chars_before);

  const replayed = pairFromHalves(String(joined.data.html_first), String(joined.data.html_second));
  assert.ok(replayed !== null);
  const again = joinInCode(replayed);
  assert.ok("html" in again, JSON.stringify(again));
  assert.equal(again.html, goodJoin("Table 1.—Income", STATES, REST));
  assert.equal(verifyJoin(replayed, again.html), null, "the replay scores the verification, not only the guard");
});

test("a paid join does not repeat the bytes its own decline line already carries", async () => {
  const first = piece("Table 1.—Income", STATES);
  const second = reworded("Table 1.—Income—Continued", REST);
  const merged = goodJoin("Table 1.—Income", STATES, REST);
  const { ctx, rec } = ctxWith(() => envelope(merged));

  await joinContinuedTables(ctx, first + second);

  const [joined] = events(rec, "table_joined");
  assert.equal(joined.data.by, "editor");
  // Absent, and `by` is the rule for that — a field on every line, so the population is countable.
  // Every editor call in this loop is preceded by the decline that bought it, and `pairKey` is those
  // two strings, so the pair is recovered by matching the bytes and not by trusting two lines' order.
  assert.equal(joined.data.halves, undefined);
  assert.equal(joined.data.html_first, undefined);
  const [stood] = events(rec, "table_join_code_declined");
  assert.equal(stood.data.html_first, first);
  assert.equal(stood.data.html_second, second);
});

test("a three-page table logs the intermediate merge, because that is the pair the second pass judged", async () => {
  // What the per-submission size range does NOT bound. The loop joins one pair per pass, so a table
  // printed across three pages is joined twice and the second pass's first half IS the first pass's
  // merge — the first two pieces' rows are on two lines. That is the correct thing to log, since the
  // merge is what pass 2 decided on and a replay of that line needs it, but it means a document of long
  // chains logs more than a corpus of two-piece tables and the ceiling is the loop's 12 pairs.
  const a = piece("Table 7.—Effort", ["Alabama", "Alaska"]);
  const b = piece("Table 7.—Effort—Continued", ["Arizona", "Arkansas"]);
  const c = piece("Table 7.—Effort—Continued", REST);
  const { ctx, rec } = ctxWith(() => {
    throw new Error("a pair the code could join was put to the editor");
  });

  await joinContinuedTables(ctx, a + b + c);

  const [one, two] = events(rec, "table_joined");
  assert.equal(one.data.html_first, a);
  assert.equal(two.data.chars_first, one.data.chars_after, "pass 2's first half is pass 1's merge");
  assert.equal(two.data.html_first, goodJoin("Table 7.—Effort", ["Alabama", "Alaska"], ["Arizona", "Arkansas"]));
  // And the re-logged bytes replay like any other line's, which is the reason to keep them.
  const replayed = pairFromHalves(String(two.data.html_first), String(two.data.html_second));
  assert.ok(replayed !== null);
  const again = joinInCode(replayed);
  assert.ok("html" in again, JSON.stringify(again));
  assert.equal(again.html, goodJoin("Table 7.—Effort", ["Alabama", "Alaska", "Arizona", "Arkansas"], REST));
});

test("a pair past the bound logs no bytes rather than half a table", async () => {
  // The one place this departs from the capped signatures above. A cut signature still compares cell by
  // cell as far as it goes; half a table's bytes parse to a DIFFERENT table — fewer rows, no closing
  // markup — so a rule scored against them returns a verdict that is not the rule's. So the bound
  // refuses, the line says which it did, and the sizes stay, which is what makes the drop measurable.
  const many = Array.from({ length: 600 }, (_, i) => `Row ${i}`);
  const first = piece("Table 30.—Long", many);
  const second = reworded("Table 30.—Long—Continued", many);
  assert.ok(first.length + second.length > 64_000, "the fixture has to reach the bound to test it");
  const { ctx, rec } = ctxWith(() => envelope(null));

  await joinContinuedTables(ctx, first + second);

  const [stood] = events(rec, "table_join_code_declined");
  assert.equal(stood.data.halves, "too_large");
  assert.equal(stood.data.html_first, undefined);
  assert.equal(stood.data.html_second, undefined);
  assert.equal(stood.data.chars_first, first.length);
  assert.equal(stood.data.chars_second, second.length);
  // What the bound drops is the replay. Why the pair was declined, and the headers behind that, are
  // still on the line.
  assert.equal(stood.data.reason, "header_differs");
  assert.equal(stood.data.headers_identical, false);
});

test("a half no parser can read builds no pair, which is the decline it was logged as", async () => {
  // `unreadable` is a half holding no `<table>`. Replaying that line has nothing to score, and says so
  // with null rather than building a pair out of the other half and reporting what it makes of it.
  const half = piece("Table 9.—Effort", REST);
  assert.equal(pairFromHalves("<p>no table here</p>", half), null);
  // A rebuilt half's offsets are into ITSELF, because a logged half has no body to be an offset into —
  // so a merge produced from a replay cannot be spliced into a document by arithmetic that looks right.
  const pair = pairFromHalves(half, half);
  assert.deepEqual([pair?.first.start, pair?.first.end], [0, half.length]);
  assert.equal(pair?.first.html, half);
  assert.deepEqual(pair?.second.labels, REST, "and the figures are derived from the bytes, not supplied");
});

test("a pair the code path can join costs no request and splices the same way", async () => {
  // The same body, differing only in that its second half describes its columns the way the first
  // half does — which was 26 of the corpus's 50 pairs (#276) and 24–53% of them across three later
  // rounds of the same corpus with nothing here changing (#326). The splice is one closure for both
  // paths, so what is pinned here is that reaching it without a model changes nothing about the
  // document: same bytes, same figures, and `by` saying which path paid.
  const first = piece("Table 1.—Income by State", STATES);
  const second = piece("Table 1.—Income by State—Continued", REST);
  const body = `<h2>Income</h2>${first}<hr role="doc-pagebreak">${second}<p>Source: Census.</p>`;
  const { ctx, rec } = ctxWith(() => {
    throw new Error("a pair the code could join was put to the editor");
  });

  const out = await joinContinuedTables(ctx, body);

  assert.equal(rec.calls.length, 0);
  assert.equal(
    out,
    `<h2>Income</h2>${goodJoin("Table 1.—Income by State", STATES, REST)}<hr role="doc-pagebreak"><p>Source: Census.</p>`,
  );
  const [joined] = events(rec, "table_joined");
  assert.equal(joined.data.by, "code");
  assert.equal(joined.data.rows_joined, STATES.length + REST.length + 1);
  assert.equal(events(rec, "table_join_code_declined").length, 0);
});

test("a table in three pieces closes by joining twice", async () => {
  // `runs-231`'s Table 15 ships as 21 + 0 + 39 rows, and its middle piece is an empty header stub.
  // The chain is not a special case: joining the first two produces a table the third continues,
  // so re-reading the body after each join closes it by running the same step again.
  const a = piece("Table 15.—Yield", ["Alabama", "Alaska"]);
  const b = reworded("Table 15.—Yield—Continued", ["Arizona"]);
  const c = reworded("Table 15.—Yield—Continued (Percentage distribution)", ["Arkansas", "California"]);
  const { ctx, rec } = ctxWith((user) =>
    envelope(
      user.includes("Arkansas")
        ? goodJoin("Table 15.—Yield", ["Alabama", "Alaska", "Arizona"], ["Arkansas", "California"])
        : goodJoin("Table 15.—Yield", ["Alabama", "Alaska"], ["Arizona"]),
    ),
  );

  const out = await joinContinuedTables(ctx, a + b + c);

  assert.equal(rec.calls.length, 2);
  assert.equal(events(rec, "table_joined").length, 2);
  assert.equal(events(rec, "table_continuations").length, 1, "the document is announced once, not once per join");
  assert.equal(out, goodJoin("Table 15.—Yield", ["Alabama", "Alaska", "Arizona"], ["Arkansas", "California"]));
  assert.equal(continuationPairs(out).pairs.length, 0);
});

test("two pairs in one chain that share a caption are two pairs", async () => {
  // A refusal is remembered per PAIR, and the identity is the halves' bytes rather than the second
  // half's caption, because captions collide: in a three-piece chain the second and third pieces
  // both caption as "…—Continued". Keyed on the caption, the first pair being declined marked the
  // second pair refused too — a joinable pair abandoned with nothing in the log to say so, since
  // `pending` counted by the same key and read 0.
  const a = piece("Table 15.—Yield", ["Alabama", "Alaska"]);
  // B is worded so that neither pair it belongs to joins in code: A + B and B + C both reach the
  // editor, which is what makes the two pairs distinguishable by anything at all.
  const b = reworded("Table 15.—Yield—Continued", ["Arizona"]);
  const c = piece("Table 15.—Yield—Continued", ["Arkansas", "California"]);
  const merged = goodJoin("Table 15.—Yield (rest)", ["Arizona"], ["Arkansas", "California"]);
  const { ctx, rec } = ctxWith((user) =>
    // The first pair (A + B) is declined; the second (B + C) is not, and has to be asked.
    user.includes("Alabama") ? envelope(null, { declined: true, log: "not one table" }) : envelope(merged),
  );

  const out = await joinContinuedTables(ctx, a + b + c);

  assert.equal(rec.calls.length, 2, "the second pair was never asked");
  assert.equal(events(rec, "table_joined").length, 1);
  assert.equal(out, a + merged, "B and C were not joined, or A did not survive the splice");
});

test("a body the parser cannot read ships as it arrived rather than failing the phase", async () => {
  // jsdom builds the tree by recursion, so this body raises `RangeError: Maximum call stack size
  // exceeded` inside the parse — and a page nested this deeply reaches assembly delivered as
  // written, because `anchors.ts` refuses to rewrite past 500 levels. Before this was guarded the
  // throw failed the assembly phase and the session, on a document that shipped fine without this
  // stage. The lint one line later treats its own overflow the same way (`@lint-unavailable`, #164).
  const deep = "<div>".repeat(200_000);
  const body = deep + piece("Table 1.—Income", STATES) + piece("Table 1.—Income—Continued", REST);
  const { ctx, rec } = ctxWith(() => {
    throw new Error("a document that could not be read was put to the editor");
  });

  assert.equal(await joinContinuedTables(ctx, body), body);
  assert.equal(rec.calls.length, 0);
  const [failed] = events(rec, "table_join_failed");
  assert.deepEqual(failed.data, { reason: "read_failed", stage: "body" });
  assert.equal(events(rec, "table_continuations").length, 0);
});

test("a reply the parser cannot read costs that pair and not the document", async () => {
  const bad = piece("Table 1.—Income", STATES) + reworded("Table 1.—Income—Continued", REST);
  const good = piece("Table 2.—Costs", ["Steel", "Coal"]) + reworded("Table 2.—Costs—Continued", ["Timber"]);
  const { ctx, rec } = ctxWith((user) =>
    user.includes("Steel")
      ? envelope(goodJoin("Table 2.—Costs", ["Steel", "Coal"], ["Timber"]))
      : envelope(`<table>${"<div>".repeat(200_000)}</table>`),
  );

  const out = await joinContinuedTables(ctx, bad + good);

  assert.equal(events(rec, "table_join_failed")[0].data.reason, "read_failed");
  assert.equal(events(rec, "table_joined").length, 1, "the second pair was refused with the first");
  assert.ok(out.startsWith(bad), "an unreadable reply was spliced in");
});

test("an earlier twin of the first half does not steal its span", async () => {
  // The span a table is spliced at is resolved by position on a body whose tables and spans agree in
  // number, and only searched for by content when they do not. Searching first is what this replaced,
  // and on this body — a table printed twice, then a continuation of the second copy — the search
  // resolved the first half to the EARLIER twin's span, leaving the real pair one table apart and
  // logged `not_adjacent`: a reason that says the bytes could not delimit the pair, about bytes that
  // are adjacent.
  const twin = piece("Table 4.—Rates", ["Alabama", "Alaska"]);
  const body = twin + twin + piece("Table 4.—Rates—Continued", ["Arizona"]);
  const merged = goodJoin("Table 4.—Rates", ["Alabama", "Alaska"], ["Arizona"]);
  const { ctx, rec } = ctxWith(() => envelope(merged));

  const found = continuationPairs(body);
  assert.deepEqual(found.declined, []);
  assert.equal(found.pairs.length, 1);

  const out = await joinContinuedTables(ctx, body);
  assert.equal(out, twin + merged, "the join landed on the wrong copy");
  assert.equal(events(rec, "table_joined").length, 1);
});

test("a pair the editor declined is left exactly as it arrived, and not asked again", async () => {
  // Declining is an answer. Two halves whose columns no single header block describes are better
  // shipped as they are — the corpus has four such pairs, two of them with different column counts
  // — and the document that results is the document this stage was added to.
  const body = piece("Table 10.—Collections", STATES) + reworded("Table 10.—Collections—Continued", REST);
  const { ctx, rec } = ctxWith(() => envelope(null, { declined: true, log: "the halves declare different columns" }));

  assert.equal(await joinContinuedTables(ctx, body), body);
  assert.equal(rec.calls.length, 1, "the same two tables are not put to the same prompt twice");
  const [failed] = events(rec, "table_join_failed");
  assert.equal(failed.data.reason, "declined");
  assert.equal(failed.data.editor_log, "the halves declare different columns");
  assert.equal(events(rec, "table_joined").length, 0);
});

test("a lossy answer costs one request and the document keeps both halves", async () => {
  const first = piece("Table 1.—Income", STATES);
  const second = reworded("Table 1.—Income—Continued", REST);
  const { ctx, rec } = ctxWith(() => envelope(piece("Table 1.—Income", STATES)));

  assert.equal(await joinContinuedTables(ctx, first + second), first + second);
  assert.equal(rec.calls.length, 1);
  const [failed] = events(rec, "table_join_failed");
  assert.equal(failed.data.reason, "rows_lost");
  assert.equal(failed.data.rows_first, STATES.length + 1);
  assert.equal(failed.data.rows_second, REST.length + 1);
});

test("one unjoinable pair does not starve the joinable pair after it", async () => {
  // Why a refused pair is remembered. Without it the loop re-reads the body, finds the same first
  // pair, and spends every one of its requests on the pair that cannot be joined.
  const bad = piece("Table 1.—Income", STATES) + reworded("Table 1.—Income—Continued", REST);
  const good = piece("Table 2.—Costs", ["Steel", "Coal"]) + reworded("Table 2.—Costs—Continued", ["Timber"]);
  const merged = goodJoin("Table 2.—Costs", ["Steel", "Coal"], ["Timber"]);
  const { ctx, rec } = ctxWith((user) => (user.includes("Steel") ? envelope(merged) : envelope(null)));

  const out = await joinContinuedTables(ctx, bad + good);

  assert.equal(out, bad + merged);
  assert.equal(rec.calls.length, 2, "one request for each pair, and no pair asked twice");
  assert.deepEqual(events(rec, "table_join_failed").map((e) => e.data.reason), ["no_output"]);
  assert.equal(events(rec, "table_joined").length, 1);
});

test("a request that fails leaves the body alone and says which failure it was", async () => {
  const body = piece("Table 1.—Income", STATES) + reworded("Table 1.—Income—Continued", REST);
  const rec: Recorded = { events: [], calls: [] };
  const ctx = {
    router: {
      complete: async () => {
        throw new Error("provider exploded");
      },
    },
    log: {
      event: (type: string, data: Record<string, unknown> = {}) => rec.events.push({ type, data }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;

  // A join repairs something already deliverable, so nothing it does is worth failing a session
  // over: assembly's contract is that this returns the body it was given whenever it cannot do
  // better.
  assert.equal(await joinContinuedTables(ctx, body), body);
  const [failed] = rec.events.filter((e) => e.type === "table_join_failed");
  assert.equal(failed.data.reason, "call_failed");
  assert.equal(failed.data.error, "provider exploded");
});

test("more pairs than the cap allows leaves the rest split and says how many", async () => {
  // The cap is not a bound anything measured comes near — the corpus's worst chunk has 7 pairs in
  // 25 pages — but the loop buys a request per pass, so it needs one.
  const pairs = MAX_TABLE_JOINS + 2;
  let body = "";
  for (let i = 1; i <= pairs; i++) {
    body += piece(`Table ${i}.—Income`, ["Alabama"]) + piece(`Table ${i}.—Income—Continued`, ["Alaska"]);
  }
  const { ctx, rec } = ctxWith((user) => {
    const n = /Table (\d+)\.—Income/.exec(user)![1];
    return envelope(goodJoin(`Table ${n}.—Income`, ["Alabama"], ["Alaska"]));
  });

  const out = await joinContinuedTables(ctx, body);

  assert.equal(events(rec, "table_joined").length, MAX_TABLE_JOINS);
  const [capped] = events(rec, "table_joins_capped");
  assert.deepEqual(capped.data, { joined: MAX_TABLE_JOINS, pending: 2, max: MAX_TABLE_JOINS });
  // The two that did not fit are still two tables each, which is what they were.
  assert.equal(continuationPairs(out).pairs.length, 2);
});

test("a document that joined every pair does not report a cap", async () => {
  const body = piece("Table 1.—Income", STATES) + piece("Table 1.—Income—Continued", REST);
  const { ctx, rec } = ctxWith(() => envelope(goodJoin("Table 1.—Income", STATES, REST)));
  await joinContinuedTables(ctx, body);
  assert.equal(events(rec, "table_joins_capped").length, 0);
});

// --- where the join sits in the pipeline ---

function frag(order: number, innerHtml: string): Fragment {
  return { image: `page-00${order}.png`, order, agent: "page.md", region: "page", innerHtml, edges: [], log: "" };
}

test("the document assembly lints and returns is the joined one, not the two halves", async () => {
  // The halves arrive on separate pages, which is the only way they ever arrive: each page is
  // extracted alone. This test is about placement rather than about the merge — the join has to
  // happen before `wrapDocument` and before `runAxe`, or the document the gate cleared and the
  // document the Reader reads are not the document that ships.
  const fragments = [
    frag(1, `<h1>Income</h1>` + piece("Table 1.—Per Capita Personal Income, by State", STATES)),
    frag(2, reworded("Table 1.—Per Capita Personal Income, by State—Continued", REST)),
  ];
  // Sanity: without the join this is two tables, so the assertions below are about the join and
  // not about a fixture that only ever held one.
  assert.equal((assembleBody(fragments).match(/<table\b/g) ?? []).length, 2);

  const { ctx, rec } = ctxWith(() =>
    envelope(goodJoin("Table 1.—Per Capita Personal Income, by State", STATES, REST)),
  );
  const result = await runAssembly(ctx, fragments);

  assert.equal(rec.calls.length, 1, "the join was not asked");
  assert.equal((result.body.match(/<table\b/g) ?? []).length, 1);
  assert.equal((result.html.match(/<table\b/g) ?? []).length, 1, "the linted document still holds both halves");
  assert.ok(!CONTINUED_CAPTION.test(result.html), "the continuation caption reached the delivered document");
  for (const label of [...STATES, ...REST]) assert.ok(result.body.includes(label), `lost a row: ${label}`);
  assert.equal(events(rec, "table_joined").length, 1);
  // The lint that ran is the joined document's, so a table the join broke would be caught by the
  // gate rather than shipped past it.
  assert.equal(result.lint.ok, true, JSON.stringify(result.lint.violations));
});

test("an ordinary document costs assembly no request and no line", async () => {
  const { ctx, rec } = ctxWith(() => {
    throw new Error("the join was asked about a document with no continued table");
  });
  const result = await runAssembly(ctx, [frag(1, `<h1>Report</h1>` + piece("Table 1.—Income", STATES))]);
  assert.equal(rec.calls.length, 0);
  assert.equal(rec.events.filter((e) => e.type.startsWith("table_")).length, 0);
  assert.equal((result.body.match(/<table\b/g) ?? []).length, 1);
});

test("a soft hyphen in a column header is the same header", () => {
  // The corpus's headers are printed with soft hyphens (`Govern­ment`), so every comparison here
  // folds them out. Without it a label and the same label compare unequal and a sound join reads
  // as having lost a row.
  assert.equal(normalizeCell("Govern­ment"), "Government");
  assert.equal(normalizeCell("  Per capita\n  income "), "Per capita income");
});
