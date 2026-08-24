import { extractJson } from "../util/json.ts";
import { mapWithConcurrency } from "../util/concurrency.ts";
import { MAX_EDITOR_IMAGES } from "../providers/imageLimits.ts";
import { isRequestTooLargeError } from "../providers/types.ts";
import { feedbackPreamble, loadImage, type InputImage, type PipelineContext } from "./context.ts";
import { wrapDocument } from "./assembly.ts";
import { runAxe, type LintResult } from "./lint.ts";
import { flatten } from "./flatten.ts";
import { examplesForPrompt } from "./memory.ts";
import { knownPages, pageIndex, type IndexedPage } from "./pageindex.ts";
import { droppedHrefs } from "./links.ts";
import { sameWordedHeadingNote, sameWordedHeadingRuns } from "./headings.ts";

export interface ReviewIssue {
  issue: string;
  severity: "low" | "medium" | "high";
  suggested_action: string;
  // Source attribution (PRD §7.8, amended v1.1): the 1-based source pages this
  // issue is on. Empty when the Reader could not attribute it — the document is
  // delivered without provenance comments (§7.4 v1.1), so page numbers are the
  // only reference available, and the Reader is told not to guess.
  pages?: number[];
}

export interface ReviewResult {
  html: string; // full document
  body: string;
  iterationsCompleted: number;
  unresolved: ReviewIssue[];
  lint: LintResult;
  // How many absolute hrefs the Copy Editor destroyed, totalled over the rounds it
  // ran (PRD §7.16). Summing across rounds does not double-count: each round
  // compares only its own before/after, so a link dropped in round 1 is already
  // absent from round 2's `before`.
  //
  // Returned rather than left in the run log because this is the loop's one
  // unrecoverable failure — an href came from the source FILE, so nothing later can
  // re-read it — and a per-session log line is invisible in aggregate. The COUNT is
  // what leaves this function: the URLs themselves are content from a user's
  // document and must not reach the quality tally (see Store.recordRunSignals).
  droppedLinks: number;
}

// Exported so a test can assert the marker vocabulary it advertises is the one
// `flatten` actually emits: a marker the prompt promises but the code never produces
// teaches the Reader to expect something that will not appear.
export const READER_SYSTEM = `You are the Reader Agent. You review accessible HTML for reading-order problems, semantic
inconsistencies, duplicated/redundant content, and missed WCAG 2.2 AA requirements. You do NOT
see source images — you read the document the way a screen-reader user would.

You get two views of the same content: the HTML (structural reference) and a flattened
text-only view (what a screen reader announces, in order). Cross-check them, and also consider
the axe-core lint results provided.

In the flattened view, anything in square brackets is a structural annotation, not content:
[Heading 1-6], [List item], [List item N], [Link], [Image], [Image alt], [Table],
[Header row], [Row], [Field input|textarea|select|button|summary], [Label], [Quote],
[Caption], [Term], [Definition], plus [N rows, M columns], [empty], [no caption],
[spans N columns], [spans N rows], [alt missing] and [decorative, alt empty]. A field's own
announced name follows its marker, so [Field input text] with nothing after it is a control
with no accessible name at all. Tables are expanded row by row with cells separated by " | ".

An item of an ORDERED list carries the number it is announced with — [List item 5] — and an
item of an unordered or definition list carries none, because there is no number there. Those
numbers are not in the items' text: an <ol> counts 1, 2, 3 by itself whatever the items
contain, so a source's own numbering survives only in start on the <ol> and value on an <li>.
Read them the way you read table cells that hold numbers, and report a contradiction you can
point at: a list numbered 1, 2, 3 sitting under a note that says items 3 and 4 are not listed,
a numbering note beside a sequence that is in fact unbroken, or an announced number that
disagrees with the same list in the source-page excerpt below. You do NOT see the source
images, so a plain 1, 2, 3 with nothing to contradict it is not evidence of anything — do not
report a list for being consecutive, and never suggest a number the document does not show.

Headings are the document's outline, and two defects in it only the assembled document shows.
The same words announced twice in a row at the same level — [Heading 2] Operation, then another
[Heading 2] Operation — tells a reader navigating by heading that the second section is the same
subject as the first, or a copy of it. And a section title reprinted at the top of every page it
continues on is that defect arriving one page at a time: each extractor saw one page and could not
know the title had already been used. Report both, with the pages both headings are on, and say
which of the two it looks like: one section whose title repeats, where the second heading goes and
what followed it belongs under the first, or two sections the document labels alike, where each
heading keeps the label and gains the words that tell it apart — words already in that section's
own content, never a phrase of your own. Do not report two same-level headings that merely share a
level, or identical headings with other sections in between: what is ambiguous is the pair with
nothing but its own subject's content between them.

Those pairs are found for you. Where the document has any, a section below lists them, computed
from the WHOLE document rather than from the HTML you were given — so a heading it names may sit
outside your excerpt, and is to be reported anyway. Report every entry in that list as an issue,
and say which of the two cases it is; where the excerpts do not tell you, say that instead of
choosing. The list decides only that a pair EXISTS: no entry is a false positive to be argued
with, and finding a pair the list missed is still worth reporting.

Treat a table that reports [0 rows], a [Field ...] with nothing announced after it, and an
[Image] [alt missing] as evidence of a real problem. Do NOT report these, which are correct
markup: [decorative, alt empty] (an empty alt is right for a decorative image); a row with
fewer cells than the table has columns, when some cell is marked [spans N columns] or
[spans N rows]; or a field whose name follows its marker but which has no separate [Label]
line, since the name may come from an attribute.

You are also given an index of the document's source pages (page number + an excerpt of the
HTML extracted from that page). For every issue, attribute it to the source "pages" it appears
on, by matching the offending content against those excerpts. This is what lets the Copy Editor
fetch the right page images. Name only pages you have concrete evidence for; if you cannot tell
which page an issue is on, return an empty "pages" list rather than guessing or listing them all.

Respond with ONLY JSON:
{ "issues": [ { "issue": "...", "pages": [3], "severity": "low|medium|high", "suggested_action": "..." } ] }
Return {"issues": []} when the document is clean.`;

// Exported for the same reason READER_SYSTEM is: the two halves of the duplicate-heading
// rule have to agree — the Reader classifies the pair and the editor resolves it — and a
// test pins both.
export const EDITOR_SYSTEM = `You are the Copy Editor Agent. You are given an accessible HTML document (body content only),
a list of issues found by the reviewer, and the source page image(s) for the pages those issues
were attributed to. Return a corrected version of the FULL body that resolves every issue you can.

You may do whatever it takes to fix the issues: remove duplicated or redundant content
(e.g. the same content rendered as both a form and a table — keep the best single
representation), reorder blocks, fix heading hierarchy, correct labels and table headers, etc.
Preserve all genuine content and transcribed text; do not invent content. Content on pages whose
image is NOT attached must be carried over unchanged unless an issue names it. Output ONLY the
corrected body (no <html>/<head>/<body> wrapper).

Two headings with the same words at the same level are yours to resolve — whether they sit next to
each other or with one page's worth of content between them, which is what a title reprinted where
its section continued looks like once the pages are joined. The source images say which way it
goes: a title the pages reprint because the section runs across them is ONE heading — drop the
repeat and put what followed it under the first, at the level its content calls for — while two
sections the document really does label alike keep the label and each gain the words that
distinguish them. Those words come from that section's own content, which is the one text you may
add here; never write a subtitle of your own, and never merge two sections that are merely named
alike. And where nothing you were given decides it — the reviewer says it could not tell, or the
pages those headings are on were not attached — leave both headings exactly as they are and resolve
the other issues. An outline that says the same thing twice is a smaller harm to a reader than a
section merged into another one or a heading dropped, and an issue left alone comes back next round
or is reported as unresolved, while content you removed on a guess is gone from the document.

A link's target is content, and it is the one kind you cannot recover: an href came from the
source FILE, not from the page image, so a URL you drop or alter is gone and a URL you invent
cannot be checked. Carry every href through exactly as written — including on content you
restructure or move — and never add a link that is not already in the document. You may change
the TEXT of a link when an issue calls for it (link text that does not describe its
destination is a real 2.4.4 problem); keep its href.

Respond with ONLY JSON: { "html": "<corrected body content>" }`;

const CHUNK_BUDGET = 24000;
const CHUNK_OVERLAP = 2000;

function chunk(s: string): string[] {
  if (s.length <= CHUNK_BUDGET) return [s];
  const out: string[] = [];
  let start = 0;
  while (start < s.length) {
    out.push(s.slice(start, start + CHUNK_BUDGET));
    start += CHUNK_BUDGET - CHUNK_OVERLAP;
  }
  return out;
}

function lintSummary(lint: LintResult): string {
  if (lint.error) return `axe-core could not run (${lint.error})`;
  if (lint.ok) return "axe-core: no violations";
  return lint.violations.map((v) => `- ${v.id} (${v.impact}): ${v.description} [${v.nodes} nodes]`).join("\n");
}

// The page index is repeated on every Reader call (once per chunk per round), so
// excerpts are shorter here than the scoping call's — just enough to match content
// back to a page.
const READER_INDEX_EXCERPT_CHARS = 200;

async function runReader(
  ctx: PipelineContext,
  body: string,
  lint: LintResult,
  pages: IndexedPage[],
): Promise<ReviewIssue[]> {
  const index = pages.length ? pageIndex(pages, READER_INDEX_EXCERPT_CHARS) : "";
  // Computed over the whole body, once, and given to the FIRST chunk only. Both halves
  // of that matter. Whole-body, because a chunk is a character window and the pair this
  // finds is a page apart (see sameWordedHeadingRuns). First chunk only, because every
  // call that receives the list reports it, and the chunks are independent calls — the
  // same defect would arrive two or three times and be carried to @unresolved that many
  // times if no editor round cleared it.
  const duplicateHeadings = sameWordedHeadingNote(sameWordedHeadingRuns(body));
  // The two per-run tails of the prompt, read once instead of once per chunk:
  // `examplesForPrompt` reads and parses the agent's example bank off disk, and it
  // cannot change while a round is in flight.
  const tail = feedbackPreamble(ctx) + examplesForPrompt(ctx.paths, "page.md", ["a11y_policy"]);
  const chunks = chunk(body);
  // Chunks are independent calls over disjoint windows of a body nothing mutates while
  // they run, so they are sent CONCURRENTLY rather than one after another. On a long
  // document this is the review loop's dominant latency term and it was strictly serial:
  // a 25-page body is several CHUNK_BUDGET windows, each a full text call, and the whole
  // ladder is re-climbed on every round of the loop (up to max_review_iterations + 1
  // times) because the Reader has to re-read what the editor changed.
  //
  // Nothing about what is SENT changes — same prompts, same chunk order — so this costs
  // no extra tokens and cannot change a verdict. Only the waiting is removed.
  //
  // Bounded by the same knob as page extraction: it is the deployment's answer to how
  // many model calls one run may have in flight (`defaults.extraction_concurrency`), and
  // a Reader chunk is that same kind of call. So a run's peak stays where the operator
  // set it, in this phase as in the other, and an operator who lowered it for a
  // rate-limited provider gets the review bounded too. Defensive `|| 1` for a
  // directly-constructed context (tests, embedders) that never set it: serial is what
  // this function did before, so an unset knob degrades to exactly the old behaviour.
  const limit = Math.max(1, Math.floor(ctx.extractionConcurrency) || 1);
  const perChunk = await mapWithConcurrency(chunks, limit, async (c, i) => {
    const user =
      `## HTML\n\`\`\`html\n${c}\n\`\`\`\n\n## Flattened screen-reader view\n${flatten(c)}\n\n## axe-core lint\n${lintSummary(lint)}` +
      (i === 0 && duplicateHeadings
        ? `\n\n## Headings with the same words at the same level, nothing but their own content between them (whole document)\n${duplicateHeadings}`
        : "") +
      (index ? `\n\n## Source pages in this document (extracted HTML, truncated)\n${index}` : "") +
      tail;
    const res = await ctx.router.complete("reader", "text", [
      { role: "system", content: READER_SYSTEM },
      { role: "user", content: user },
    ]);
    ctx.log.agentCall({
      agent: { name: "reader", file: "reader.md", content: READER_SYSTEM, capabilities: ["text"], sha: null, sessionBuilt: false },
      phase: "review",
      output: res.text,
    });
    const parsed = extractJson<{ issues?: (ReviewIssue & { pages?: unknown })[] }>(res.text);
    // Drop hallucinated page numbers here rather than downstream, so a bad
    // attribution degrades to "no attribution" (all images) instead of
    // silently sending the editor the wrong page.
    return (parsed?.issues ?? []).map((issue) => ({ ...issue, pages: knownPages(issue.pages, pages) }));
  });
  // mapWithConcurrency returns results in INPUT order, so the issue list is the one a
  // serial loop produced — which matters downstream: `imagesForIssues` unions the pages
  // and `unresolved` is written in this order, so a document's unresolved list must not
  // depend on which chunk's call happened to finish first.
  return perChunk.flat();
}

// Which source images the Copy Editor needs this round: the union of the pages the
// Reader attributed its issues to — but ONLY when it attributed every issue.
//
// One unattributed issue re-broadens the whole round to every image. This follows
// the same asymmetric-cost bias as the rest of the pipeline: narrowing wrongly can
// leave an issue permanently unfixable, while broadening wrongly costs no more than
// the behaviour this optimization replaced.
//
// The tempting alternative — narrow to whatever WAS attributed and let the loop
// recover later — is worse than it looks. An unattributed issue is usually
// structural (duplication, reading order, heading levels) and fixable from the HTML
// alone, but it is also what you get when the editor has rewritten the body far
// enough that the Reader can no longer match it to a source excerpt. That drift
// grows every round, so a genuine content issue can go unattributed in exactly the
// late rounds where the iteration budget is thinnest. Recovery costs a full
// iteration (the leftover must become the ONLY issue before images come back), and
// at the cap it never happens — the issue is written to @unresolved having never
// been shown its own page.
//
// The cost of being generous is bounded by `capEditorImages` below, which is what
// makes the paragraph above true. It did not used to be: the claim was that a
// chronically unattributable issue pins the document to all-images, "which is
// precisely the status quo" — and that reasoning holds only while all-images is
// merely expensive. At MAX_PDF_PAGES it is over the context window, so on a 25-page
// document the fallback was not a cost bound but a refused request, arriving after
// extraction and assembly had both been paid for and ending the run with nothing
// delivered (issue #134). The savings case — every issue attributed — is unchanged.
export function imagesForIssues(images: InputImage[], issues: ReviewIssue[]): InputImage[] {
  if (issues.some((i) => !i.pages?.length)) return images;
  const wanted = new Set(issues.flatMap((i) => i.pages ?? []));
  if (wanted.size === 0) return images;
  const selected = images.filter((img) => wanted.has(img.order));
  return selected.length ? selected : images;
}

// Fit `imagesForIssues`'s selection inside one request (providers/imageLimits.ts
// MAX_EDITOR_IMAGES for why that number).
//
// Kept separate from the selection rule on purpose: which pages the editor WANTS is a
// question about the issues, and how many of them fit is a question about the model.
// Folding the second into the first would make the answer to the first untestable, and
// the two change for different reasons.
//
// Pages an issue actually NAMED come first, because those are the ones the editor
// cannot fix without them — an unattributed issue is usually structural and fixable
// from the HTML alone, which is the fallback's own justification for being safe to
// broaden. Past the cap, attribution is the only evidence available about which image
// is worth a slot. What survives is re-sorted into document order, since the prompt
// tells the editor the images arrive in the order it names them.
export function capEditorImages(
  selected: InputImage[],
  issues: ReviewIssue[],
  max: number = MAX_EDITOR_IMAGES,
): InputImage[] {
  if (selected.length <= max) return selected;
  const attributed = new Set(issues.flatMap((i) => i.pages ?? []));
  const preferred = [
    ...selected.filter((img) => attributed.has(img.order)),
    ...selected.filter((img) => !attributed.has(img.order)),
  ];
  return preferred.slice(0, Math.max(1, max)).sort((a, b) => a.order - b.order);
}

// Document-level correction: the editor sees the whole body + all issues + the
// source images and returns a corrected document, so it can fix structural
// problems (dedup, reorder, heading hierarchy) that per-block editing cannot.
//
// It sees only the images for the pages the Reader attributed issues to. On a
// 25-page document that is the difference between re-uploading 25 base64 PNGs on
// every one of up to max_review_iterations rounds and uploading the one or two
// that are actually in question.
//
// Two things bound the request, in that order, because they answer different
// questions: `capEditorImages` decides what fits BEFORE sending, and the retry below
// handles a payload the model refuses anyway — a document body large enough to leave
// no room, a page whose image is heavier than the estimate the cap is derived from.
// Neither alone is sufficient: without the cap the refusal is the common case on a
// long document, and without the retry the cap has to be right about a limit it can
// only estimate.
async function runEditor(ctx: PipelineContext, body: string, issues: ReviewIssue[]): Promise<string> {
  const wanted = imagesForIssues(ctx.images, issues);
  const selected = capEditorImages(wanted, issues);
  // Logged only when the cap actually dropped something, so an ordinary round's line
  // is unchanged — but never silently: a page the editor asked for and did not get is
  // the only reason it could fail to fix an issue it was shown.
  const dropped = wanted.length - selected.length;
  ctx.log.event("editor_images", {
    attached: selected.length,
    of: ctx.images.length,
    pages: selected.map((i) => i.order),
    ...(dropped > 0 ? { dropped } : {}),
  });

  try {
    return await editorCall(ctx, body, issues, selected);
  } catch (e) {
    // The images are the only part of this request Iris can give up, and giving them
    // up is far better than what refusing to do so costs: the run ends here, after
    // extraction and assembly have been paid for in full, and the user gets nothing
    // (issue #134). A text-only correction pass still has the whole body and every
    // issue the Reader raised — which are already text — so it can fix everything
    // except a fidelity problem that has to be checked against the source.
    //
    // Only for a size refusal, and only when there were images to drop. Anything else
    // (a stall, a stream error, a bad key) is not made better by asking again, and
    // retrying it would double the cost of every real failure.
    if (!selected.length || !isRequestTooLargeError(e)) throw e;
    ctx.log.event("editor_images_refused", {
      attached: selected.length,
      of: ctx.images.length,
      error: e instanceof Error ? e.message : String(e),
    });
    return await editorCall(ctx, body, issues, []);
  }
}

// One Copy Editor call, with whichever images it was given. Split out so the same
// prompt can be re-sent without them; `selected` empty is a normal shape here, and the
// prompt says so rather than promising attachments that are not there.
async function editorCall(
  ctx: PipelineContext,
  body: string,
  issues: ReviewIssue[],
  selected: InputImage[],
): Promise<string> {
  const images = selected.map(loadImage);
  const pageList = selected.map((i) => i.order).join(", ");
  const user =
    `## Current document (body content)\n${body}\n\n` +
    `## Issues to fix\n${issues
      .map((i) => {
        const where = i.pages?.length ? ` (page ${i.pages.join(", ")})` : "";
        return `- [${i.severity}]${where} ${i.issue} — ${i.suggested_action}`;
      })
      .join("\n")}\n\n` +
    (images.length
      ? `The source image(s) for page ${pageList} are attached, in that order. ` +
        `Return the complete corrected body.`
      : `No source images are available. Return the complete corrected body.`) +
    feedbackPreamble(ctx);
  const res = await ctx.router.complete(
    "copy_editor",
    images.length ? "vision" : "text",
    [
      { role: "system", content: EDITOR_SYSTEM },
      { role: "user", content: user },
    ],
    { images },
  );
  ctx.log.agentCall({
    agent: { name: "copy_editor", file: "copy_editor.md", content: EDITOR_SYSTEM, capabilities: ["vision"], sha: null, sessionBuilt: false },
    phase: "review",
    output: res.text,
  });
  const parsed = extractJson<{ html?: string }>(res.text);
  // If the editor returns nothing usable, keep the current body unchanged.
  return parsed?.html?.trim() || body;
}

// Reader -> Editor -> re-verify, looping until the Reader reports zero issues or
// the iteration cap is reached. The loop only stops clean when the Reader has
// actually re-confirmed it, so reported issues are verified-fixed, not assumed.
export async function runReview(
  ctx: PipelineContext,
  initial: { body: string; lint: LintResult; pages?: IndexedPage[]; failedPages?: number[] },
): Promise<ReviewResult> {
  let body = initial.body;
  let lint = initial.lint;
  let iterations = 0;
  let lastIssues: ReviewIssue[] = [];
  let droppedLinks = 0;
  // The page index is built from the fragments as they entered review. Pages are
  // deliberately NOT re-indexed as the editor rewrites the body: the index exists
  // to attribute content to a SOURCE page, and the source doesn't change.
  const pages = initial.pages ?? [];
  // Carried through the loop only to be re-stated in the wrapper at the end. The review
  // loop cannot fix a page that was never extracted, and must not be asked to: the
  // Reader would raise "this page is missing" every round against a body no editor can
  // repair, spending the whole iteration budget on it. See wrapDocument.
  const failedPages = initial.failedPages ?? [];

  while (iterations <= ctx.maxReviewIterations) {
    const issues = await runReader(ctx, body, lint, pages);
    lastIssues = issues;
    ctx.log.event("reader", { iteration: iterations, issues: issues.length });
    if (issues.length === 0) {
      return {
        html: wrapDocument(body, { failedPages }),
        body,
        iterationsCompleted: iterations,
        unresolved: [],
        lint,
        droppedLinks,
      };
    }
    if (iterations === ctx.maxReviewIterations) break; // cap reached, issues remain

    iterations++;
    const before = body;
    body = await runEditor(ctx, body, issues);
    lint = await runAxe(wrapDocument(body));
    ctx.log.event("editor", { iteration: iterations });
    // A link the editor dropped is unrecoverable and invisible to every later check
    // in the loop — see droppedHrefs for why this is checked here and in code.
    const dropped = droppedHrefs(before, body);
    if (dropped.length) {
      droppedLinks += dropped.length;
      ctx.log.event("editor_links_dropped", { iteration: iterations, hrefs: dropped });
    }
  }

  // Cap reached with issues remaining (§7.11): record them as a comment, with the
  // source page reference the Reader attributed (§7.8) so a human can find them.
  const unresolvedLines = lastIssues.map(
    (i) => `${i.issue} (severity: ${i.severity}${i.pages?.length ? `, page ${i.pages.join(", ")}` : ""})`,
  );
  return {
    html: wrapDocument(body, { unresolved: unresolvedLines, failedPages }),
    body,
    iterationsCompleted: iterations,
    unresolved: lastIssues,
    lint,
    droppedLinks,
  };
}
