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
  normalizeCell,
  tableSpans,
  verifyJoin,
} from "../src/pipeline/tables.ts";
import { assembleBody, runAssembly } from "../src/pipeline/assembly.ts";
import type { Fragment } from "../src/pipeline/fragment.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";

// A table half: a caption, a header row, and one row per label.
function piece(caption: string, labels: string[], cols = 3): string {
  const head = `<tr>${Array.from({ length: cols }, (_, c) => `<th scope="col">Col ${c + 1}</th>`).join("")}</tr>`;
  const rows = labels
    .map((l) => `<tr><th scope="row">${l}</th>${Array.from({ length: cols - 1 }, () => "<td>1.0</td>").join("")}</tr>`)
    .join("");
  return `<table><caption>${caption}</caption><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

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
  assert.equal(verifyJoin(pair, piece("Table 1.—Income", STATES)), "labels_lost:3");
  assert.equal(verifyJoin(pair, piece("Table 1.—Income", ["Alabama"])), "rows_lost");
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

// --- the splice ---

test("a joined pair becomes one table and the rest of the body is untouched", async () => {
  const first = piece("Table 1.—Income by State", STATES);
  const second = piece("Table 1.—Income by State—Continued", REST);
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
});

test("a table in three pieces closes by joining twice", async () => {
  // `runs-231`'s Table 15 ships as 21 + 0 + 39 rows, and its middle piece is an empty header stub.
  // The chain is not a special case: joining the first two produces a table the third continues,
  // so re-reading the body after each join closes it by running the same step again.
  const a = piece("Table 15.—Yield", ["Alabama", "Alaska"]);
  const b = piece("Table 15.—Yield—Continued", ["Arizona"]);
  const c = piece("Table 15.—Yield—Continued (Percentage distribution)", ["Arkansas", "California"]);
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

test("a pair the editor declined is left exactly as it arrived, and not asked again", async () => {
  // Declining is an answer. Two halves whose columns no single header block describes are better
  // shipped as they are — the corpus has four such pairs, two of them with different column counts
  // — and the document that results is the document this stage was added to.
  const body = piece("Table 10.—Collections", STATES) + piece("Table 10.—Collections—Continued", REST);
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
  const second = piece("Table 1.—Income—Continued", REST);
  const { ctx, rec } = ctxWith(() => envelope(piece("Table 1.—Income", STATES)));

  assert.equal(await joinContinuedTables(ctx, first + second), first + second);
  assert.equal(rec.calls.length, 1);
  const [failed] = events(rec, "table_join_failed");
  assert.equal(failed.data.reason, "labels_lost:3");
  assert.equal(failed.data.rows_first, STATES.length + 1);
  assert.equal(failed.data.rows_second, REST.length + 1);
});

test("one unjoinable pair does not starve the joinable pair after it", async () => {
  // Why a refused pair is remembered. Without it the loop re-reads the body, finds the same first
  // pair, and spends every one of its requests on the pair that cannot be joined.
  const bad = piece("Table 1.—Income", STATES) + piece("Table 1.—Income—Continued", REST);
  const good = piece("Table 2.—Costs", ["Steel", "Coal"]) + piece("Table 2.—Costs—Continued", ["Timber"]);
  const merged = goodJoin("Table 2.—Costs", ["Steel", "Coal"], ["Timber"]);
  const { ctx, rec } = ctxWith((user) => (user.includes("Steel") ? envelope(merged) : envelope(null)));

  const out = await joinContinuedTables(ctx, bad + good);

  assert.equal(out, bad + merged);
  assert.equal(rec.calls.length, 2, "one request for each pair, and no pair asked twice");
  assert.deepEqual(events(rec, "table_join_failed").map((e) => e.data.reason), ["no_output"]);
  assert.equal(events(rec, "table_joined").length, 1);
});

test("a request that fails leaves the body alone and says which failure it was", async () => {
  const body = piece("Table 1.—Income", STATES) + piece("Table 1.—Income—Continued", REST);
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
    frag(2, piece("Table 1.—Per Capita Personal Income, by State—Continued", REST)),
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
