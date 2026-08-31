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
  continuationPairs,
  joinContinuedTables,
  joinInCode,
  normalizeCell,
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
});

test("a pair the code path can join costs no request and splices the same way", async () => {
  // The same body, differing only in that its second half describes its columns the way the first
  // half does — which is 26 of the corpus's 50 pairs (#276). The splice is one closure for both
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
