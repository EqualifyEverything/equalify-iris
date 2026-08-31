// A source page the document has no content for is not something the review loop can act
// on, and until issue #188 it was asked about anyway — once per Reader chunk, per round.
// On the round that filed the issue that was 6 of one document's 26 unresolved issues: one
// lost page, six differently worded reports of it, and no two of them alike enough for an
// exact-string dedupe to catch. Per CHUNK of the final round — `@unresolved` is written from
// `lastIssues`, which every round overwrites, so the delivered list is one read of the
// document — while what the ROUNDS multiplied was the spend, every one of them handing the
// editor the same unrepairable reports. `unresolved` is not a private number either way: it
// is the `iris:unresolved` signal, it is what `unresolved.md` and the session summary count,
// and it is what the bench reports per document.
//
// Two pages have no content, for opposite reasons, and both arrived by the same route: the
// page index, which `runReader` gives to every chunk by design (it leads the prompt so the
// bytes can be cached). A FAILED page's entry was the `@page-failed` marker, which reads as
// a hole because it is one; a BLANK page's entry was an empty line, which reads as a hole
// and is not — #184 delivers a blank page correctly, and the next round of the bench had its
// successes coming back as unresolved issues.
//
// So the fix is in two halves, in the order this pipeline prefers: READER_SYSTEM says what
// such an entry means and that neither kind is an issue to report, and the code makes the
// thing a sampled model can still do — report it from three chunks at once — count once.
// This test holds both halves, and holds the second to the bound it deliberately keeps: the
// first report of a page is KEPT, and an issue that names any page with content in it is not
// touched at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  READER_SYSTEM,
  runReview,
  noContentPages,
  readerIndexPages,
  dedupeNoContentIssues,
  type ReviewIssue,
} from "../src/pipeline/review.ts";
import type { IndexedPage } from "../src/pipeline/pageindex.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// The prompt wraps for reading, so clauses are matched on words rather than bytes.
const reader = READER_SYSTEM.replace(/\s+/g, " ").trim();

test("the Reader is told what a no-content entry is, and that neither kind is its to report", () => {
  for (const [what, re] of [
    // Without this the entries are just index entries, and an entry that says the page
    // contributed nothing is the strongest possible invitation to report it.
    ["the index can say a page contributed no content instead of showing an excerpt",
      /Some entries in that index say the page contributed no content instead of showing an excerpt, and neither kind of entry is an issue to report/],
    // The two states are named apart because they are opposite facts about the run, and a
    // Reader told only "no content" would treat a correctly blank page as a lost one.
    ["a failed page is named as content the pipeline lost", /A page whose extraction FAILED is content this pipeline lost/],
    ["a blank page is named as a page with nothing on it, correctly delivered",
      /A page that is BLANK in the source contributed nothing because there was nothing on it to transcribe, which makes the document correct as it stands/],
    // The index is one of two routes: the failed page's fragment IS the `@page-failed`
    // comment, so the chunk that holds it sees the same fact in the HTML. Saying only
    // "ignore the index entry" leaves that chunk reporting it.
    ["the @page-failed comment in the document is named as the same fact",
      /the document already records it, both in that entry and in a @page-failed comment where the content would have been/],
    // The reason, which is what makes it a rule rather than a preference: no edit to the
    // HTML can bring a page back, so the report costs a correction round and returns.
    ["the reason is that no edit can fix it, and the cost is a round",
      /no edit to the HTML can bring the page back — so reporting it spends a correction round on the one defect this loop cannot fix/],
    ["a report on every later round is named as the cost too", /and reports it again on every round after/],
    // The Reader reads one CHUNK_BUDGET window. Absence of a page's content from that
    // window is not evidence of anything, and this is the inference behind the reports
    // that carried no page attribution at all — which the code half cannot reach.
    ["inferring a missing page from a labelled window is forbidden",
      /Where the HTML section is labelled as one window of several, the rest of the document is another call's to read, so a page whose content is not in your window is not a missing page and is not yours to report/],
    // And only there. Most documents Iris converts are one chunk, and on those the premise
    // is false: there is no other call, `contentCoverage` and `destroyedPage` guard
    // extraction rather than this loop, so a correction round that dropped a page's content
    // has the Reader as its only check — and an attributed report is what would attach that
    // page's image to the round that could restore it.
    ["an unlabelled section means the whole body, and genuinely absent content is a real finding",
      /Where it carries no such label you have the whole body, and content genuinely absent from it — a page the index shows as extracted with nothing of it in the document — is a real finding and yours to make/],
    // #274: the paragraph above tells the Reader what the label MEANS for a page it cannot
    // find, and a cheaper model read the label as the finding instead — Haiku 4.5 filed it in
    // 7 of 163 issues where Sonnet 4.6 filed it in 0 of 197. Each of those buys an editor
    // call, and the round's images, to work on a document that is not broken.
    ["the label itself is named as never a defect",
      /That label is never itself a defect, and neither is the window it describes/],
    // The three shapes measured, in the order they were quoted on #274: the label reported as
    // a reading-order issue, the window reported as making the document unverifiable, and
    // "review the complete document (all 3 windows)" as the suggested fix. The last is the
    // expensive one — it asks a human to do the review this call was paid for.
    ["reporting the windowing, and asking for the other windows, are both forbidden",
      /do not report that the HTML is one window of several, do not report that reading one window leaves the rest unverified, and never ask for the other windows to be reviewed/],
    // The reason has to be the unclosable-issue one rather than "it is not a defect", because
    // that is the reason the rest of this prompt gives and the one that survives a model
    // disagreeing about whether the label is part of the document.
    ["the cost is named: nothing can close it, so it returns every round",
      /no edit to the document could close an issue whose subject is this prompt, so it would come back every round/],
    // A separate shape from the label, and two of Haiku's seven rather than one: `chunk()` is
    // `s.slice(start, start + CHUNK_BUDGET)`, a raw character window, so a window genuinely
    // can open mid-sentence. Without the mechanism the prohibition reads as a denial of
    // something the Reader can see is true.
    ["the cut edge is explained by how the window is cut, not merely forbidden",
      /cut by character count rather than at an element or a sentence, so the edges it shares with the windows either side of it may begin or end mid-sentence, mid-word or mid-tag: that edge is the cut, not content the document lost/],
    // `chunk()` only manufactures INTERIOR seams, so the exemption has to be scoped or it hands
    // back the one case a single-chunk document depends on: with no label emitted at all, the
    // Reader is the only check that a body truly ending mid-tag is a defect. Reviewed on #275 —
    // the first draft said "its first and last lines" and covered the document's real ends too.
    ["the document's own ends are excluded from the cut-edge exemption",
      /The document's own opening and its own close are never a cut — where window 1 begins, where the last window ends, and both ends of an unlabelled body are the document as it really is, so a body that ends mid-sentence there is a real finding and yours to make/],
    // The exemption, because the two reports this must NOT silence are the floor under
    // `unresolved_rate` and the one page-internal break the Reader is the only check on.
    ["the marker and a within-page break are exempted by name",
      /a \[page not fully transcribed\] marker is still reported wherever you meet one, and a break you can see both sides of inside one page's own excerpt is still a real finding/],
  ] as [string, RegExp][]) {
    assert.match(reader, re, `READER_SYSTEM no longer says: ${what}`);
  }
});

// --- which pages have no content --------------------------------------------------

const page = (order: number, innerHtml: string): IndexedPage => ({ order, innerHtml });

test("a failed page is known from the caller's list, a blank one from its own fragment", () => {
  const pages = [
    page(1, "<p>Real content.</p>"),
    page(2, "<!-- @page-failed 2: page agent returned no HTML (empty_html, 262 chars) -->"),
    page(3, ""),
    page(4, "   \n  "),
  ];
  assert.deepEqual(
    [...noContentPages(pages, [2])],
    [
      [2, "failed"],
      [3, "blank"],
      [4, "blank"],
    ],
    "page 1 has content; 2 failed; 3 and 4 are the empty fragment a declared-blank page leaves",
  );
});

test("a failed page is failed even when its fragment is empty", () => {
  // The two states are not exclusive in principle — the marker is what `failedPage` writes
  // today, and a future failure path could leave nothing — and the caller's list is the
  // stronger evidence: it is the pipeline's own record of what it lost. Reading this off the
  // fragment alone would report a lost page to the Reader as a correct blank one.
  assert.deepEqual([...noContentPages([page(5, "")], [5])], [[5, "failed"]]);
});

test("a document with nothing missing has no no-content pages and an untouched index", () => {
  const pages = [page(1, "<p>One.</p>"), page(2, "<p>Two.</p>")];
  const none = noContentPages(pages, []);
  assert.equal(none.size, 0);
  assert.equal(readerIndexPages(pages, none), pages, "the ordinary document must not be rebuilt at all");
});

test("the annotated index replaces the entry's text and leaves every other page alone", () => {
  const pages = [
    page(1, "<p>One.</p>"),
    page(2, "<!-- @page-failed 2: page agent returned no HTML (empty_html, 262 chars) -->"),
    page(3, ""),
  ];
  const annotated = readerIndexPages(pages, noContentPages(pages, [2]));
  assert.equal(annotated[0].innerHtml, "<p>One.</p>");
  assert.match(annotated[1].innerHtml, /^\(no content — this page could not be extracted/);
  assert.match(annotated[1].innerHtml, /not an issue to report\.\)$/);
  assert.match(annotated[2].innerHtml, /^\(no content — this page is blank in the source/);
  assert.doesNotMatch(annotated[1].innerHtml, /empty_html/, "the failure's own wording is what the Reader quoted back");
  // `pages` is the array runReview holds for the whole loop and hands to `knownPages`: an
  // attribution to page 2 has to stay valid, because the one report this still allows carries
  // its page number that way.
  assert.equal(pages[1].innerHtml, "<!-- @page-failed 2: page agent returned no HTML (empty_html, 262 chars) -->");
  assert.equal(pages[2].innerHtml, "");
});

// --- one report per page ----------------------------------------------------------

const issue = (text: string, pages?: number[]): ReviewIssue => ({
  issue: text,
  severity: "high",
  suggested_action: "none",
  ...(pages ? { pages } : {}),
});

const lost = (entries: [number, "failed" | "blank"][]): Map<number, "failed" | "blank"> => new Map(entries);

test("three chunks reporting one lost page in three wordings leave one report", () => {
  // The wordings are round 9's, verbatim from the issue: exact-string dedupe catches none of
  // them, which is why the key is the page.
  const { issues, dropped } = dedupeNoContentIssues(
    [
      issue("Page 25 failed to extract (page agent returned no HTML). The content of this page is entirely missing…", [25]),
      issue("Page 25 failed extraction entirely — the page agent returned no HTML. Any content on this page is completely missing…", [25]),
      issue("Page 25 failed extraction: the source page index records '@page-failed 25: page agent returned no HTML'…", [25]),
    ],
    lost([[25, "failed"]]),
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0].issue, /^Page 25 failed to extract/, "the FIRST is kept, so the list is the one a serial read produced");
  assert.equal(dropped.length, 2);
});

test("a blank page's reports are counted once too", () => {
  // #184 delivers this page correctly and the Reader reports it anyway — inconsistently, at
  // that: on the document in the issue one blank page was reported and another was not.
  const { issues, dropped } = dedupeNoContentIssues(
    [issue("Page 13 returned no HTML — the source page index entry for page 13 is empty.", [13]), issue("Page 13 is missing.", [13])],
    lost([[13, "blank"]]),
  );
  assert.equal(issues.length, 1);
  assert.equal(dropped.length, 1);
});

test("a report that names a page not yet reported is kept, even beside one already reported", () => {
  const { issues, dropped } = dedupeNoContentIssues(
    [issue("page 8 is missing", [8]), issue("pages 8 and 13 are missing", [8, 13]), issue("page 13 is missing", [13])],
    lost([
      [8, "failed"],
      [13, "failed"],
    ]),
  );
  assert.deepEqual(
    issues.map((i) => i.issue),
    ["page 8 is missing", "pages 8 and 13 are missing"],
    "the second report is the only one that says anything about 13, so dropping it would lose that page",
  );
  assert.equal(dropped.length, 1);
});

test("an issue that names any page with content is never touched, however often it repeats", () => {
  // The bound this keeps: `pages` is the Reader's attribution, and an issue about content
  // that IS in the document is an issue about content, whatever else it names. Three chunks
  // reporting the same real defect are three reports of a defect that may genuinely appear
  // three times — nothing here knows which, and the editor is the pass that can tell.
  const noContent = lost([[8, "failed"]]);
  const repeated = [
    issue("Inconsistent heading levels", [2]),
    issue("Inconsistent heading levels", [2]),
    issue("Content from page 8 belongs after this table", [7, 8]),
    issue("Content from page 8 belongs after this table", [7, 8]),
  ];
  const { issues, dropped } = dedupeNoContentIssues(repeated, noContent);
  assert.equal(issues.length, 4);
  assert.equal(dropped.length, 0);
});

test("an unattributed report is out of reach here, which is why the prompt is the primary fix", () => {
  const { issues, dropped } = dedupeNoContentIssues(
    [issue("some page is missing from the document"), issue("some page is missing from the document")],
    lost([[8, "failed"]]),
  );
  assert.equal(issues.length, 2, "an empty attribution is indistinguishable from any other unplaceable issue");
  assert.equal(dropped.length, 0);
});

test("a document with no lost pages returns the list it was given, unchanged", () => {
  const issues = [issue("a", [1]), issue("a", [1])];
  const result = dedupeNoContentIssues(issues, lost([]));
  assert.equal(result.issues, issues, "the ordinary document must not be rebuilt at all");
  assert.deepEqual(result.dropped, []);
});

// --- through the loop -------------------------------------------------------------

// CHUNK_BUDGET is 24000 with a 2000-char overlap, so chunks start every 22000 characters
// (see test/review-concurrency.test.ts, which measures the same seam).
const STRIDE = 22000;

function markedBody(chunks: number): string {
  let body = "";
  for (let i = 0; i < chunks; i++) {
    const marker = `<p>MARK${i}</p>`;
    body += marker + "<p>filler</p>".repeat(Math.ceil((STRIDE - marker.length) / 13));
    body = body.slice(0, (i + 1) * STRIDE);
  }
  return body;
}

const chunkOf = (prompt: string): number => {
  const m = prompt.match(/MARK(\d+)/);
  return m ? Number(m[1]) : -1;
};

interface Round {
  unresolved: ReviewIssue[];
  prompts: string[];
  events: { name: string; data: Record<string, unknown> }[];
  html: string;
}

// One Reader read of a `chunks`-chunk body, with every chunk answering `issuesFor(chunk)`.
// `maxReviewIterations: 0` stops the loop after that read, so `unresolved` is exactly what
// `runReader` returned.
async function readerRound(opts: {
  chunks: number;
  pages: IndexedPage[];
  failedPages?: number[];
  issuesFor: (chunk: number) => ReviewIssue[];
  // Overrides `markedBody`, for the one case that needs a body whose chunk seam does NOT
  // fall on an element boundary. `markedBody` places a marker at every seam by
  // construction, which is what makes the other tests readable and what makes it useless
  // for measuring where `chunk()` actually cuts.
  body?: string;
}): Promise<Round> {
  const dir = mkdtempSync(join(tmpdir(), "iris-no-content-"));
  try {
    const prompts: string[] = [];
    const events: { name: string; data: Record<string, unknown> }[] = [];
    const ctx = {
      sessionId: "ses_test",
      images: [],
      maxReviewIterations: 0,
      extractionConcurrency: 4,
      paths: {
        agentsDir: join(dir, "agents"),
        tmpAgentsDir: () => join(dir, "tmp-agents"),
        agentMemory: () => join(dir, "memory", "page.json"),
      } as unknown as Paths,
      router: {
        complete: async (agent: string, _cap: string, messages: { content: string }[]) => {
          if (agent !== "reader") return { text: JSON.stringify({ html: "" }) };
          const user = messages.map((m) => m.content).join("\n");
          prompts.push(user);
          return { text: JSON.stringify({ issues: opts.issuesFor(chunkOf(user)) }) };
        },
      },
      log: {
        event: (name: string, data: Record<string, unknown>) => events.push({ name, data }),
        agentCall: () => {},
      },
    } as unknown as PipelineContext;
    const result = await runReview(ctx, {
      body: opts.body ?? markedBody(opts.chunks),
      lint: { ok: true, violations: [] },
      pages: opts.pages,
      failedPages: opts.failedPages,
    });
    return { unresolved: result.unresolved, prompts, events, html: result.html };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The document of the issue, in miniature: three chunks, one lost page, three wordings.
const THREE_PAGES = [page(1, "<p>One.</p>"), page(2, "<!-- @page-failed 2: page agent returned no HTML (empty_html, 262 chars) -->"), page(3, "<p>Three.</p>")];

test("every chunk sees the no-content entry whole, and none of them sees the failure's own words", async () => {
  const round = await readerRound({ chunks: 3, pages: THREE_PAGES, failedPages: [2], issuesFor: () => [] });
  assert.equal(round.prompts.length, 3, "the body must actually span three chunks for this to prove anything");
  for (const p of round.prompts) {
    // From the heading through the closing paren, which is what fails if the note ever grows
    // past READER_INDEX_EXCERPT_CHARS and is delivered half-said.
    assert.match(
      p,
      /### Page 2\n\(no content — this page could not be extracted, so the document has none of it\. Already recorded, and no edit can fix it: not an issue to report\.\)/,
    );
    assert.doesNotMatch(p, /empty_html/, "the marker text is what the Reader quoted back when it reported the page");
    assert.match(p, /### Page 1\n<p>One\.<\/p>/, "the pages that have content still show it");
  }
});

test("a blank page's entry says it is blank instead of being an empty line", async () => {
  const pages = [page(1, "<p>One.</p>"), page(2, ""), page(3, "<p>Three.</p>")];
  const round = await readerRound({ chunks: 1, pages, issuesFor: () => [] });
  assert.match(
    round.prompts[0],
    /### Page 2\n\(no content — this page is blank in the source, so there was nothing to extract\. The document is correct as it stands: not an issue to report\.\)/,
  );
});

test("one lost page reported by three chunks reaches @unresolved once", async () => {
  const wordings = [
    "Page 2 failed to extract (page agent returned no HTML). The content of this page is entirely missing.",
    "Page 2 failed extraction entirely — any content on this page is completely missing from the document.",
    "Page 2 failed extraction: the source page index records '@page-failed 2'. Content from this page is gone.",
  ];
  const round = await readerRound({
    chunks: 3,
    pages: THREE_PAGES,
    failedPages: [2],
    issuesFor: (c) => [issue(wordings[c], [2])],
  });
  assert.deepEqual(
    round.unresolved.map((i) => i.issue),
    [wordings[0]],
  );
  // The delivered document is where this is actually counted: `unresolved` is written into it
  // one line per issue, and that list is the `iris:unresolved` signal.
  assert.equal((round.html.match(/Page 2 failed/g) ?? []).length, 1);
  const deduped = round.events.filter((e) => e.name === "reader_page_reports_deduped");
  assert.equal(deduped.length, 1, "the drop must leave a trace, or two reports vanish with nothing saying why");
  assert.equal(deduped[0].data.dropped, 2);
  assert.deepEqual(deduped[0].data.pages, [2]);
  assert.equal(deduped[0].data.iteration, 0);
  // The text as well as the count, because which report is FIRST is an accident of chunk
  // order: keeping the first is defended on the grounds that a misattributed real issue must
  // not vanish without a trace, and a count is not a trace of one.
  assert.deepEqual(deduped[0].data.reports, [`high: ${wordings[1]}`, `high: ${wordings[2]}`]);
});

test("the dropped report's text is folded and bounded, like every other model-written string", async () => {
  const long = `Page 2 failed\n\n  to extract. ${"x".repeat(400)}`;
  const round = await readerRound({
    chunks: 2,
    pages: THREE_PAGES,
    failedPages: [2],
    issuesFor: () => [issue(long, [2])],
  });
  const [logged] = round.events.filter((e) => e.name === "reader_page_reports_deduped");
  const reports = logged.data.reports as string[];
  assert.equal(reports.length, 1);
  assert.match(reports[0], /^high: Page 2 failed to extract\. x+$/, "a newline in a log line hides the rest of it");
  assert.equal(reports[0].length, "high: ".length + 300);
});

test("a reply that omits the issue text costs a log line, not the session", async () => {
  // The Reader's reply is the model's own: `runReader` normalizes `pages` and nothing else, so
  // `issue` and `severity` arrive exactly as sent. Everywhere else they are interpolated, where
  // a missing one prints as `undefined`; this line calls a method on the text, and a TypeError
  // here leaves the review loop through the orchestrator's outer catch — a failed session, with
  // extraction and assembly paid for and discarded.
  const round = await readerRound({
    chunks: 2,
    pages: THREE_PAGES,
    failedPages: [2],
    issuesFor: () => [{ pages: [2] } as unknown as ReviewIssue],
  });
  assert.equal(round.unresolved.length, 1, "the round survived a reply with no issue text in it");
  const [logged] = round.events.filter((e) => e.name === "reader_page_reports_deduped");
  assert.deepEqual(logged.data.reports, ["unrated: "]);
});

test("a body that fits in one chunk carries no window label; a split one labels every chunk", async () => {
  // The label is what conditions the missing-page rule above, so its absence on a
  // single-chunk document is the whole of what gives the Reader that finding back.
  const whole = await readerRound({ chunks: 1, pages: THREE_PAGES, failedPages: [2], issuesFor: () => [] });
  assert.equal(whole.prompts.length, 1);
  assert.match(whole.prompts[0], /## HTML\n```html/);
  assert.doesNotMatch(whole.prompts[0], /window \d+ of/);

  const split = await readerRound({ chunks: 3, pages: THREE_PAGES, failedPages: [2], issuesFor: () => [] });
  assert.deepEqual(
    split.prompts.map((p) => p.match(/## HTML \(window (\d+) of (\d+) of the document\)/)?.slice(1, 3)),
    [
      ["1", "3"],
      ["2", "3"],
      ["3", "3"],
    ],
  );
});

test("a window can open in the middle of an element, which is the fact the prompt explains", async () => {
  // `chunk()` is `s.slice(start, start + CHUNK_BUDGET)` — a character window, with no regard
  // for elements or sentences — so a later window begins partway through whatever tag the
  // count landed in. #274's third quoted example is a model reporting exactly that as content
  // loss ("text begins mid-sentence … suggesting content was cut off when this window (3 of 3)
  // was extracted"), and READER_SYSTEM now says the edge is the cut rather than a defect.
  //
  // That sentence is a claim about this function, so it is pinned here: a chunker changed to
  // split on element boundaries would leave the prompt explaining a shape nothing emits, and
  // the prohibition would then be denying something the Reader can see is not true.
  const body = "<p>filler</p>".repeat(2600);
  const round = await readerRound({ chunks: 2, body, pages: THREE_PAGES, failedPages: [2], issuesFor: () => [] });
  assert.equal(round.prompts.length, 2, "the body must actually span two windows for this to prove anything");
  const second = round.prompts[1].match(/## HTML \(window 2 of 2 of the document\)\n```html\n([\s\S]*?)\n```/)?.[1];
  assert.ok(second, "the second window's HTML section is in the prompt");
  assert.ok(
    !second.startsWith("<"),
    `window 2 must open mid-element for the prompt's explanation to be true, got ${JSON.stringify(second.slice(0, 24))}`,
  );
});

test("a round that dropped nothing logs nothing", async () => {
  const round = await readerRound({
    chunks: 2,
    pages: THREE_PAGES,
    failedPages: [2],
    issuesFor: (c) => (c === 0 ? [issue("Inconsistent heading levels", [1])] : []),
  });
  assert.equal(round.unresolved.length, 1);
  assert.equal(round.events.filter((e) => e.name === "reader_page_reports_deduped").length, 0);
});

test("the lost page still costs the loop nothing it did not already cost", async () => {
  // The bound stated plainly: this counts the report once, it does not decide the document is
  // clean. A kept report is still an issue, so the loop still runs its rounds and the document
  // still says the page is missing — in the `@page-failed` comment as well as the one
  // `@unresolved` line. Widening this to drop every report would change `clean_rate` on a
  // claim only the Reader's attribution supports, which is a different question.
  const round = await readerRound({
    chunks: 2,
    pages: THREE_PAGES,
    failedPages: [2],
    issuesFor: () => [issue("Page 2 failed to extract.", [2])],
  });
  assert.equal(round.unresolved.length, 1);
  assert.match(round.html, /@page-failed 2/);
  assert.match(round.html, /@unresolved/);
});
