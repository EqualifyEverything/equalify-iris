// A sentence printed across a page turn ships in two paragraphs with a page-break marker between
// them, and neither page could have mended it: each printed page is its own call, and the marker is
// the first thing a page emits, so the half before it came off a sheet that call never saw (#248).
// Measured on the last bench round's artifacts — 4 chunks × 25 pages, 90 markers — 22 markers stood
// where a sentence carried on, 13 with the tail immediately before the marker, 9 with a footnote
// list in between, and 2 of the 13 split a word.
//
// The fixtures are that corpus's, reduced to the smallest thing that asks the same question. What is
// pinned hardest is what the join must NEVER do: create or drop a character, cut markup in half,
// join across a page that is missing, or move an anchor's target out from under a reference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { joinPageBreakProse, type PageHtml } from "../src/pipeline/prose.ts";
import { assembleBody, assembleBodyWithReport, runAssembly } from "../src/pipeline/assembly.ts";
import type { Fragment } from "../src/pipeline/fragment.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";

// The marker `agents/page.md` prescribes, first on the page it announces.
const marker = (n: number) => `<hr role="doc-pagebreak" aria-label="Page ${n}" id="page-${n}">`;

// A page's fragment: the marker, then its blocks.
function page(n: number, ...blocks: string[]): PageHtml {
  return { order: n, html: [marker(n), ...blocks].join("\n") };
}

const join = (...pages: PageHtml[]) => joinPageBreakProse(pages);
// What the body reads as, with the markup taken out — the reader's version of it.
const text = (html: string) => html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

// The corpus's own pair: page 73 ends mid-sentence after a finished one, page 74 carries on.
const TAIL = "<p>Only 12 States tax tourist courts. Simi-</p>";
const HEAD = "<p>larly, the more populous States do not tax them at all.</p>";

// --- the join ---

test("a sentence carrying on into the next page is delivered whole, after the marker", () => {
  const { pages, report } = join(
    page(73, "<p>Receipts are shown below.</p>", "<p>Only 12 States tax courts. The rate</p>"),
    page(74, "<p>varies by county.</p>"),
  );
  assert.equal(report.candidates, 1);
  assert.equal(report.joined, 1);
  // The tail moved FORWARD, past the marker: the sentence is whole and the anchor stands
  // immediately before it, rather than in the middle of it.
  assert.match(pages[1]!, /id="page-74">\s*<p>The rate varies by county\.<\/p>/);
  assert.equal(pages[0]!.includes("The rate"), false);
  // Only the finished sentence stays behind, and it stays intact.
  assert.match(pages[0]!, /<p>Only 12 States tax courts\.<\/p>/);
  assert.match(pages[0]!, /<p>Receipts are shown below\.<\/p>/);
});

test("no character is created or dropped", () => {
  // Compared with the whitespace taken out, which is the honest form of the invariant: whitespace is
  // the ONLY thing the join edits. It puts one space where a sentence continues and none where a
  // word was broken, and it drops the space that used to sit at the end of the head paragraph —
  // characters no reader receives, since a block element's trailing space is collapsed away.
  for (const before of [
    [page(73, TAIL), page(74, HEAD)],
    [page(73, "<p>Receipts. The rate</p>"), page(74, "<p>varies by county.</p>")],
  ]) {
    const bare = (s: string) => text(s).replace(/\s+/g, "");
    assert.equal(bare(join(...before).pages.join("\n")), bare(before.map((p) => p.html).join("\n")));
  }
});

test("a word the printer broke keeps its hyphen and is closed up", () => {
  const { pages, report } = join(page(73, TAIL), page(74, HEAD));
  assert.equal(report.joined, 1);
  assert.equal(report.wordSplits, 1);
  // THE HYPHEN STAYS. "Simi-" + "larly" wants it gone and "public-" + "sector" wants it kept, and
  // nothing at this seam can tell which a hyphen at a page's edge is — `agents/page.md` answers the
  // same wall from the page's side the same way, and dropping it would be the one place this pass
  // deleted a character the source printed. What the join fixes is the interruption: a reader hears
  // "Simi-larly" as one word rather than "Simi", a page-break announcement, then "larly".
  assert.match(text(pages[1]!), /^Simi-larly, the more populous States do not tax them at all\.$/);
  // The finished sentence before it stays on the page that printed it: only the sentence that runs
  // over moves, not the whole paragraph holding it.
  assert.match(pages[0]!, /<p>Only 12 States tax tourist courts\.<\/p>/);
  // No space was inserted at the break, which is the half of it a count cannot check.
  assert.equal(pages[1]!.includes("Simi- larly"), false);
  // And the word is on the log line, because the count alone cannot be checked against a document.
  assert.deepEqual(report.wordSplitExamples, ["Simi-larly,"]);
});

test("a broken word is closed up on a fragment that is not on one line", () => {
  // Pretty-printed HTML is what a model emits, and nothing between the extractor and here collapses
  // it, so the tail arrives as "Simi-\n  ". Left in, the document says "Simi- larly" — WORSE than the
  // split it replaced, because a screen reader still reads "Simi", pause, "larly", and now there is
  // no page-break announcement to explain the pause.
  const { pages, report } = join(
    page(73, "<p>\n  Only 12 States tax tourist courts. Simi-\n</p>"),
    page(74, "<p>\n  larly, the more populous States do not tax them at all.\n</p>"),
  );
  assert.equal(report.wordSplits, 1);
  assert.equal(/Simi-\s+larly/.test(pages[1]!), false, "whitespace was left between the halves");
  assert.match(text(pages[1]!), /^Simi-larly, the more populous/);
});

test("the emptied paragraph goes rather than shipping as an empty <p>", () => {
  const { pages } = join(page(73, "<p>Receipts follow.</p>", TAIL), page(74, HEAD));
  // The whole of the tail paragraph moved, so nothing of it is left to hold.
  assert.equal(pages[0]!.includes("<p></p>"), false);
  assert.equal(pages[0]!.includes("Simi-"), false);
  assert.match(pages[0]!, /<p>Receipts follow\.<\/p>/);
});

test("a page turn with no marker is joined too, and counted apart", () => {
  // A page printing no number emits no marker, so a document of unnumbered scans has page turns
  // with nothing between the halves at all. The join there moves no anchor.
  const { report, pages } = join(
    { order: 4, html: "<p>The Commission met and</p>" },
    { order: 5, html: "<p>adjourned at noon.</p>" },
  );
  assert.equal(report.markers, 0);
  assert.equal(report.joined, 1);
  assert.equal(report.unmarked, 1);
  assert.equal(text(pages.join(" ")), "The Commission met and adjourned at noon.");
});

test("a sentence beginning inside an inline element keeps its markup", () => {
  const { pages, report } = join(
    page(73, "<p><em>Table 4 follows. The rate</em> varies</p>"),
    page(74, "<p>little by county.</p>"),
  );
  // The only sentence boundary sits inside an `<em>` that opened earlier, so there is no cut that
  // leaves both halves balanced. Declined rather than cut anyway: half an `<em>` in each of two
  // pages is worse than the split sentence.
  assert.equal(report.candidates, 1);
  assert.equal(report.joined, 0);
  assert.equal(report.declined.noCut, 1);
  assert.equal(pages[0]!.includes("<em>Table 4 follows. The rate</em>"), true);
});

test("markup around the moved words moves with them", () => {
  const { pages, report } = join(
    page(73, "<p>See below. The <em>ad valorem</em> rate</p>"),
    page(74, "<p>is 2 percent.</p>"),
  );
  assert.equal(report.joined, 1);
  assert.match(pages[1]!, /<p>The <em>ad valorem<\/em> rate is 2 percent\.<\/p>/);
  assert.equal(pages[0]!.includes("<em>"), false);
});

// --- what it refuses ---

test("a footnote list between the halves is not joined across", () => {
  // 9 of the corpus's 22 mid-sentence markers look like this. The marker is then not what
  // interrupts the sentence, and moving text over the notes would reorder the page.
  const { pages, report } = join(
    page(73, "<p>Only 12 States tax courts. The rate</p>", '<ol><li id="fn-1">Excludes Alaska.</li></ol>'),
    page(74, "<p>varies by county.</p>"),
  );
  assert.equal(report.candidates, 1);
  assert.equal(report.joined, 0);
  assert.equal(report.declined.interrupted, 1);
  assert.equal(pages[0]!.includes("The rate"), true);
});

test("a page missing between the halves is not joined across", () => {
  // Page 74 failed extraction or came back blank, so it contributes no fragment and the only trace
  // of it here is the hole in the numbering. The middle of the sentence may be what is missing, so
  // these two edges do not meet and joining them would invent a sentence neither page printed.
  const { report, pages } = join(page(73, "<p>Receipts. The rate</p>"), page(75, "<p>varies widely.</p>"));
  assert.equal(report.candidates, 1);
  assert.equal(report.joined, 0);
  assert.equal(report.declined.pageGap, 1);
  assert.equal(pages[0]!.includes("The rate"), true);
});

test("a finished sentence is not joined to what follows it", () => {
  const { report } = join(page(73, "<p>The rate varies by county.</p>"), page(74, "<p>see table 4 below.</p>"));
  assert.equal(report.candidates, 1);
  assert.equal(report.joined, 0);
  assert.equal(report.declined.notContinuing, 1);
});

test("a footnote reference at the page's edge is not read as a sentence still running", () => {
  // `<sup><a href="#fn-1" id="fnref-1">1</a></sup>` is the reference shape the page prompt
  // prescribes, so a paragraph that ends a sentence and cites a note ends, read as text, in a
  // DIGIT. Without ignoring it, "…tourist courts.1" looks mid-sentence and a whole finished
  // sentence would be moved onto the next page.
  const { report, pages } = join(
    page(73, '<p>Only 12 States tax tourist courts.<sup><a href="#fn-1" id="fnref-1">1</a></sup></p>'),
    page(74, "<p>see table 4 for the rates.</p>"),
  );
  assert.equal(report.declined.notContinuing, 1);
  assert.equal(report.joined, 0);
  assert.match(pages[0]!, /courts\.<sup>/);
});

test("a footnote reference inside the tail does not move the cut", () => {
  // Same shape, one sentence earlier: the reference belongs to the finished sentence, and the cut
  // must fall after it rather than in front of it.
  const { pages, report } = join(
    page(73, '<p>Only 12 States tax courts.<sup><a href="#fn-1" id="fnref-1">1</a></sup> The rate</p>'),
    page(74, "<p>varies by county.</p>"),
  );
  assert.equal(report.joined, 1);
  assert.match(pages[0]!, /<p>Only 12 States tax courts\.<sup><a href="#fn-1" id="fnref-1">1<\/a><\/sup><\/p>/);
  assert.match(pages[1]!, /<p>The rate varies by county\.<\/p>/);
});

test("a page beginning a new sentence is not a candidate at all", () => {
  const { report, pages } = join(page(73, "<p>Receipts. The rate</p>"), page(74, "<p>Table 4 follows.</p>"));
  assert.equal(report.markers, 1);
  assert.equal(report.candidates, 0);
  assert.equal(report.joined, 0);
  assert.deepEqual(pages, [page(73, "<p>Receipts. The rate</p>").html, page(74, "<p>Table 4 follows.</p>").html]);
});

test("a page opening with something other than a paragraph is left alone", () => {
  // A heading, a table or a list at the head of a page is not a sentence carrying on, whatever case
  // its first letter is in.
  const { report } = join(page(73, "<p>Receipts. The rate</p>"), page(74, "<h2>tourist courts</h2>"));
  assert.equal(report.candidates, 0);
  assert.equal(report.joined, 0);
});

test("a whole paragraph that is named stays where the reference expects it", () => {
  // Nothing of this paragraph would stay behind, and it carries an id — one that `namespaceAnchors`
  // may already have repointed a reference at. Moving it into the next page's paragraph would drop
  // the id with the element.
  const { pages, report } = join(
    page(73, '<p id="p-73-1">the rate for tourist courts</p>'),
    page(74, "<p>varies by county.</p>"),
  );
  assert.equal(report.joined, 0);
  assert.equal(report.declined.attrsKept, 1);
  assert.match(pages[0]!, /<p id="p-73-1">/);
});

test("words do not move between paragraphs that disagree about their language", () => {
  // The moved words would arrive under the other paragraph's `lang`, so they would be delivered in a
  // language nothing said they were in — and `bodyLang` reads these same attributes to decide what
  // the whole document declares (#163).
  const { report, pages } = join(
    page(73, '<p lang="fr">Les recettes. Le taux</p>'),
    page(74, "<p>varies by county.</p>"),
  );
  assert.equal(report.candidates, 1);
  assert.equal(report.joined, 0);
  assert.equal(report.declined.langMismatch, 1);
  assert.match(pages[0]!, /<p lang="fr">Les recettes\. Le taux<\/p>/);
});

test("two paragraphs that agree about their language are joined", () => {
  // Agreement is the ordinary case in a document that declares a language at all: `agents/page.md`
  // puts `lang` on every top-level element of such a page, so a rule that declined whenever the
  // attribute was present would switch this join off for every non-English document.
  const { report, pages } = join(
    { order: 73, html: '<p lang="fr">Les recettes. Le taux</p>' },
    { order: 74, html: '<p lang="fr">varie selon le comté.</p>' },
  );
  assert.equal(report.joined, 1);
  assert.match(pages[1]!, /<p lang="fr">Le taux varie selon le comté\.<\/p>/);
});

test("a page in a script with no upper and lower case is left alone", () => {
  // The candidate test is the issue's: the next page begins with a LOWERCASE letter. Hangul, Chinese,
  // Japanese, Arabic and Hebrew have no such letter, so the rule simply never fires on them and their
  // sentences ship split as they do today. That is a join missed, not a join got wrong — and there is
  // no measurement of what the signal should be for those scripts, so the rule stays where the
  // evidence is rather than guessing at a corpus nobody has run.
  const pages = [{ order: 73, html: '<p lang="ko">문장이 여기서</p>' }, { order: 74, html: '<p lang="ko">계속됩니다.</p>' }];
  const { pages: out, report } = join(...pages);
  assert.equal(report.candidates, 0);
  assert.deepEqual(out, pages.map((p) => p.html));
});

test("a page delivered exactly as written is not touched from either side", () => {
  // `skipped_pages`: the parser and this page's bytes disagree about its structure, so it ships as
  // the agent wrote it. A pass that reads that structure to find the paragraph at the page's edge is
  // reading the half of the disagreement a browser will not honour — and, whatever it read, editing
  // the bytes is the one thing that page's contract forbids.
  const written = "<p>Receipts. The rate</p>";
  for (const [a, b] of [
    [{ order: 73, html: written, asWritten: true }, { order: 74, html: "<p>varies by county.</p>" }],
    [{ order: 73, html: written }, { order: 74, html: "<p>varies by county.</p>", asWritten: true }],
  ]) {
    const { pages, report } = join(a!, b!);
    assert.equal(report.candidates, 1);
    assert.equal(report.joined, 0);
    assert.equal(report.declined.asWritten, 1);
    assert.deepEqual(pages, [a!.html, b!.html]);
  }
});

test("a whole unnamed paragraph with no sentence end in it moves entire", () => {
  const { pages, report } = join(page(73, "<p>the rate for tourist courts</p>"), page(74, "<p>varies by county.</p>"));
  assert.equal(report.joined, 1);
  assert.match(pages[1]!, /<p>the rate for tourist courts varies by county\.<\/p>/);
});

test("only a few words may cross a marker, so a page cannot empty itself into the next one", () => {
  // The direction is justified by what it costs a reader following `#page-74`: a few words of page 73
  // before page 74's own text. A paragraph with no sentence boundary in it moves ENTIRE, which for a
  // page of unpunctuated prose is that page's whole text delivered after the NEXT page's anchor —
  // not a few words, and not what the direction was chosen for.
  const long = `<p>${"the rate for tourist courts and motels ".repeat(20)}</p>`;
  const { pages, report } = join(page(73, long), page(74, "<p>varies by county.</p>"));
  assert.equal(report.candidates, 1);
  assert.equal(report.joined, 0);
  assert.equal(report.declined.tooFar, 1);
  assert.match(pages[0]!, /id="page-73">\n<p>the rate for tourist courts/);
  // And the bound is generous against what it has to allow: a real sentence's tail is nowhere near it.
  const sentence = `<p>Receipts follow. ${"the rate for tourist courts and motels ".repeat(8)}</p>`;
  assert.equal(join(page(73, sentence), page(74, "<p>varies by county.</p>")).report.joined, 1);
});

test("a document with nothing to join comes back byte-identical", () => {
  const pages = [
    page(1, "<h1>Report</h1>", "<p>Receipts are shown below.</p>"),
    page(2, "<p>The rates are fixed.</p>", '<table><caption>Table 1</caption><tr><td>1.0</td></tr></table>'),
    page(3, "<p>Nothing further.</p>"),
  ];
  const { pages: out, report } = join(...pages);
  assert.deepEqual(out, pages.map((p) => p.html));
  assert.equal(report.markers, 2);
  assert.equal(report.candidates, 0);
});

test("one page, or none, is not a page turn", () => {
  assert.deepEqual(join().pages, []);
  assert.equal(join(page(1, "<p>the rate</p>")).report.markers, 0);
});

// --- through assembly ---

function fragment(order: number, innerHtml: string): Fragment {
  return { image: `p${order}.png`, order, agent: "page.md", region: "page", innerHtml, edges: [], log: "" };
}

test("the join happens in assembly, where a missing page is still visible", () => {
  const { body, prose } = assembleBodyWithReport([
    fragment(74, HEAD),
    fragment(73, `${marker(73)}\n${TAIL}`),
  ]);
  assert.equal(prose.joined, 1);
  assert.match(text(body), /courts\. Simi-larly, the more populous/);
  // And the one-line caller agrees with it, since it is the same join.
  assert.equal(assembleBody([fragment(73, `${marker(73)}\n${TAIL}`), fragment(74, HEAD)]), body);
});

test("a page that came back empty is a hole the join declines across", () => {
  // An empty fragment is dropped from the body (#194), so the only trace of that page is the hole in
  // the numbering — the fact that exists at this stage and nowhere downstream, and the reason the
  // join lives here.
  const { prose } = assembleBodyWithReport([
    fragment(73, `${marker(73)}\n<p>Receipts. The rate</p>`),
    fragment(74, "   "),
    fragment(75, `${marker(75)}\n<p>varies by county.</p>`),
  ]);
  assert.equal(prose.candidates, 1);
  assert.equal(prose.joined, 0);
  assert.equal(prose.declined.pageGap, 1);
});

test("a page that FAILED extraction declines as an interruption, not as a gap", () => {
  // A failed page is not an absence: `extraction.ts` gives it the `@page-failed` comment, so it is a
  // fragment, the numbering stays contiguous, and the comment itself is a node standing between the
  // halves. Same refusal either way; different reason on the log line, and the reason is what an
  // operator reads.
  const { prose } = assembleBodyWithReport([
    fragment(73, `${marker(73)}\n<p>Receipts. The rate</p>`),
    fragment(74, "<!-- @page-failed 74: extraction failed -->"),
    fragment(75, `${marker(75)}\n<p>varies by county.</p>`),
  ]);
  assert.equal(prose.candidates, 1);
  assert.equal(prose.joined, 0);
  assert.equal(prose.declined.pageGap, 0);
  assert.equal(prose.declined.interrupted, 1);
});

test("the run log says how many turns there were, how many were joined, and why the rest were not", async () => {
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const ctx = {
    router: { complete: async () => ({ text: "" }) },
    log: { event: (type: string, data: Record<string, unknown> = {}) => events.push({ type, data }), agentCall: () => {} },
  } as unknown as PipelineContext;
  await runAssembly(ctx, [
    fragment(73, `${marker(73)}\n${TAIL}`),
    fragment(74, `${HEAD}\n<ol><li id="fn-1">Excludes Alaska.</li></ol>`),
    fragment(75, `${marker(75)}\n<p>see table 4.</p>`),
  ]);
  const [line] = events.filter((e) => e.type === "prose_joined");
  assert.ok(line, "a document with a candidate turn logs the line");
  assert.equal(line.data.markers, 1);
  assert.equal(line.data.candidates, 2);
  assert.equal(line.data.joined, 1);
  assert.equal(line.data.word_splits, 1);
  assert.equal(line.data.declined_interrupted, 1);
  assert.deepEqual(line.data.word_split_examples, ["Simi-larly,"]);
});

test("a document with no candidate page turn adds no line", async () => {
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const ctx = {
    router: { complete: async () => ({ text: "" }) },
    log: { event: (type: string, data: Record<string, unknown> = {}) => events.push({ type, data }), agentCall: () => {} },
  } as unknown as PipelineContext;
  await runAssembly(ctx, [
    fragment(1, `${marker(1)}\n<p>Receipts are shown below.</p>`),
    fragment(2, `${marker(2)}\n<p>The rates are fixed.</p>`),
  ]);
  assert.deepEqual(events.filter((e) => e.type === "prose_joined"), []);
});
