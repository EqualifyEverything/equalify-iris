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
[spans N columns], [spans N rows], [alt missing] and [decorative, alt empty]. Two bracketed
tokens are the exception, because the extractor wrote them into the document rather than the
flattener adding them: [not legible] and [page not fully transcribed] are content — what a page
said where the source could not be read, or could not be returned in full — and are dealt with
below. A field's own announced name follows its marker, so [Field input text] with nothing after
it is a control with no accessible name at all. Tables are expanded row by row with cells separated by " | ".

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

A [not legible] marker is what the extractor wrote where the marks on its page did not resolve
into characters, and a [page not fully transcribed] marker is what it wrote where it could not
return the whole page. Report every one of them with the page it is on, and nothing more. The page
is what matters: the Copy Editor is given the images for the pages your issues name, and looking at
that page again is the only thing that can settle the first marker — the second is settled by
re-extracting that page, which is nobody's job in this loop, so it is reported and left standing.
You do not see the source images, so never suggest what a marker stood for, and never ask for one to
be deleted — a document that once said a word could not be read, or a page not finished, and now
says nothing tells every reader that the page arrived whole.

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
distinguish them. Those words come from that section's own content, which is one of the two texts you
may add here (the other is under the markers below, and there is no third); never write a subtitle
of your own, and never merge two sections that are merely named
alike. And where nothing you were given decides it — the reviewer says it could not tell, or the
pages those headings are on were not attached — leave both headings exactly as they are and resolve
the other issues. An outline that says the same thing twice is a smaller harm to a reader than a
section merged into another one or a heading dropped, and an issue left alone comes back next round
or is reported as unresolved, while content you removed on a guess is gone from the document.

A [not legible] marker is not a defect in the markup: it is the extractor saying the marks on that
page did not resolve into characters. Where that page's image IS attached, look at that region again
— if the marks resolve for you, put the words the page shows in the marker's place, which is the
second and last text you may add here, because it comes from the page and not from you. If they do
not resolve, or that page was not attached, leave the marker exactly where it stands. Never replace
it with a plausible word, and never simply delete it: a guess reaches a reader as something the page
says, and a deletion tells every later reader that the page was read in full. A number, a part code
or a measurement is the case to be strictest about — nothing in the surrounding sentence can confirm
one, and it is the string a reader will act on.

A [page not fully transcribed] marker is not yours to resolve at all, even with that page's image in
front of you. It stands where an extraction could not return the whole of one page, so filling it in
means returning the rest of that page on top of the complete corrected body — the one request in this
pipeline that can exceed what a response can hold, and hitting that ceiling does not degrade to a
smaller retry: it ends the run, and the document nobody has been given yet is the document nobody
gets. Re-extracting that page is what has a whole response to itself. So leave the marker exactly
where it stands, resolve the other issues around it, and never delete it — an unfinished page that
says so can be finished, and one that does not looks complete to everyone downstream.

A link's target is content, and it is the one kind you cannot recover: an href came from the
source FILE, not from the page image, so a URL you drop or alter is gone and a URL you invent
cannot be checked. Carry every href through exactly as written — including on content you
restructure or move — and never add a link that is not already in the document. You may change
the TEXT of a link when an issue calls for it (link text that does not describe its
destination is a real 2.4.4 problem); keep its href.

Respond with ONLY JSON: { "html": "<corrected body content>" }`;

// The two markers the page agent writes INTO the body: what it could not read, and what it
// could not finish. Both sit inside a fragment, which is the position assembly.ts deliberately
// keeps its own @page-failed marker out of — a round that returns "the complete corrected body"
// can drop anything in there, and nothing else in the pipeline would notice. `droppedHrefs`
// exists for the same reason one file over; `contentCoverage` strips [...] before comparing
// words, so a marker the editor deleted costs the document nothing any gate can see, and what
// ships is the one outcome this rule argues a reader cannot detect: a document that reads as
// transcribed in full.
//
// Counted, not restored, and the asymmetry between the two is the reason. A [not legible] marker
// SHOULD disappear when the editor reads that region off the attached page image — that is the
// resolution EDITOR_SYSTEM asks for — so a fall in its count is a record and not a verdict.
// [page not fully transcribed] is never the editor's to resolve, so every one of those that goes
// missing is a loss. Re-inserting either has no honest position: the words that surrounded it
// were rewritten by the same round that dropped it.
//
// Both directions, because the other one is the harm the page prompt spends a paragraph on. A
// round that ADDS a marker has put a placeholder where words were — "a placeholder standing for a
// paragraph you could mostly read costs a reader the part you had" — and it reaches a reader as
// the source being unreadable when no pass that saw the source said so. The editor is never given
// that as an option (nothing in EDITOR_SYSTEM writes a marker), which is exactly why an appearance
// is worth a line: it is the closed enumeration having failed, and the words it replaced are
// invisible to contentCoverage, which strips [...] before comparing.
export const BODY_MARKERS = ["[not legible]", "[page not fully transcribed]"] as const;

export function markerCounts(body: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of BODY_MARKERS) out[m] = body.split(m).length - 1;
  return out;
}

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

// The index, as the head of a Reader prompt.
//
// It is the one part of that prompt which is about the DOCUMENT rather than about the
// chunk in front of it, and it does not change while the loop runs: it is built from the
// fragments as they entered review and deliberately not rebuilt as the editor rewrites
// the body, because it exists to attribute content to a SOURCE page and the source does
// not change (see runReview). So every chunk of every round sends these same bytes — on a
// 25-page document ~1.5k tokens, over several chunks and up to `max_review_iterations + 1`
// rounds, which is the same paragraph re-sent dozens of times at full price.
//
// Which is why it LEADS the message now, where it used to sit near the end: a cache
// breakpoint marks a prefix, so what repeats has to come before what varies or it cannot
// be cached at all. Nothing else moved, and the sections are self-labelled — the Reader
// is told it is "given an index of the document's source pages", not told where to look
// for it — so this is the same prompt with its stable half first. Below the minimum
// length the breakpoint is declined and the message is sent as one piece, which is what
// it was: at READER_INDEX_EXCERPT_CHARS that is a document of fewer than about ten pages,
// which is also where there was least to save.
//
// This entry's economics are NOT the system prompt's, and the argument a few lines below
// for why concurrent chunks may all pay a write does not transfer. READER_SYSTEM is static
// across sessions, so a busy deployment finds it warm; an index is built from THIS
// document, so it is cold once per session by construction and the chunks of the first
// round — sent together — each pay 1.25x where they used to pay 1x. That is the whole
// cost, and one further round clears it several times over: every later chunk reads the
// index at 0.1x instead of paying for it again. Concretely, three chunks pay +0.75 of one
// index on the first round and save 2.7 of it on each round after, so break-even is at
// roughly a quarter of a second round — where "each round after" means each round that
// arrives while the entry is still live. The TTL is ~5 minutes refreshed on read, and what
// sits between two Reader rounds is an editor pass carrying page images, which is the
// slowest call in the loop: a round that arrives after it expires writes again instead of
// reading, saving nothing and costing the same +0.25x it cost on the first. That is the
// floor of this trade rather than a regression — the bytes are the bytes either way. The document that does not win is the one that
// reads clean on the first look and has no second round — it pays about a quarter of its
// index, ~300 tokens per chunk on a 25-page document — and that is the trade: a small
// certain cost on the documents that need no fixing, against a large one on every
// document that iterates, which is the expensive case.
function readerIndexHead(index: string): string {
  return index ? `## Source pages in this document (extracted HTML, truncated)\n${index}\n\n` : "";
}

async function runReader(
  ctx: PipelineContext,
  body: string,
  lint: LintResult,
  pages: IndexedPage[],
  // Only so the line this logs can say which round it belongs to, the way `reader` and
  // `editor` already do. Nothing here reads it.
  iteration: number,
): Promise<ReviewIssue[]> {
  const index = pages.length ? pageIndex(pages, READER_INDEX_EXCERPT_CHARS) : "";
  // Computed over the whole body, once, and given to the FIRST chunk only. Both halves
  // of that matter. Whole-body, because a chunk is a character window and the pair this
  // finds is a page apart (see sameWordedHeadingRuns). First chunk only, because every
  // call that receives the list reports it, and the chunks are independent calls — the
  // same defect would arrive two or three times and be carried to @unresolved that many
  // times if no editor round cleared it.
  const duplicateHeadings = sameWordedHeadingNote(sameWordedHeadingRuns(body));
  // The invariant head of every chunk's prompt (see readerIndexHead).
  const head = readerIndexHead(index);
  // The two per-run tails of the prompt, read once instead of once per chunk:
  // `examplesForPrompt` reads and parses the agent's example bank off disk, and it
  // cannot change while a round is in flight.
  //
  // These stay at the END, where they were, rather than joining the cached head. Both are
  // instructions rather than reference material — the user's feedback for this run, and
  // the lessons past corrections taught — and where an instruction sits in a prompt is a
  // question about whether it is followed, not about what it costs. The index has no such
  // claim on a position: the Reader is told it is "given an index of the document's source
  // pages" and matches content against it wherever it appears. Between them they are a
  // fraction of the index's size on any document with pages in it.
  const tail = feedbackPreamble(ctx) + examplesForPrompt(ctx.paths, "page.md", ["a11y_policy"]);
  const chunks = chunk(body);
  // Chunks are independent calls over disjoint windows of a body nothing mutates while
  // they run, so they are sent CONCURRENTLY rather than one after another. On a long
  // document this is the review loop's dominant latency term and it was strictly serial:
  // a 25-page body is several CHUNK_BUDGET windows, each a full text call, and the whole
  // ladder is re-climbed on every round of the loop (up to max_review_iterations + 1
  // times) because the Reader has to re-read what the editor changed.
  //
  // Nothing about what is SENT changes — same prompts, same chunk order — so no verdict
  // can move and no extra token goes over the wire.
  //
  // What a COLD round is billed does change, on one term. READER_SYSTEM clears
  // `cacheableSystemPrompt`, so it carries a cache breakpoint: serially, chunk 0 paid the
  // 1.25x write and the rest read it at 0.1x, while chunks sent together all miss an entry
  // that does not exist yet and each pay a write. That is ~1.15x of one system prompt per
  // extra chunk (~1.4k tokens), once, and only on a round whose cache entry has expired —
  // the prompt is static across sessions and every read refreshes the five-minute TTL, so
  // a deployment doing any work at all is warm and pays none of it. Priming the entry with
  // a serial first chunk would buy that back by putting a whole call's latency into every
  // round, warm ones included, to save a fraction of one prompt on the rare cold one.
  //
  // Bounded by the same knob as page extraction: it is the deployment's answer to how
  // many model calls one run may have in flight (`defaults.extraction_concurrency`), and
  // a Reader chunk is that same kind of call. So a run's peak stays where the operator
  // set it, in this phase as in the other, and an operator who lowered it for a
  // rate-limited provider gets the review bounded too. Defensive `|| 1` for a
  // directly-constructed context (tests, embedders) that never set it: serial is what
  // this function did before, so an unset knob degrades to exactly the old behaviour.
  const limit = Math.max(1, Math.floor(ctx.extractionConcurrency) || 1);
  ctx.log.event("reader_start", { iteration, chunks: chunks.length, concurrency: limit });
  // The first error any chunk threw. `mapWithConcurrency` rejects with it — matching the
  // serial loop, and the round is discarded either way — but its workers go on pulling
  // items until the list is exhausted, so a chunk that fails early would otherwise be
  // followed by a full-price call for every chunk still queued behind it. Whoever fails
  // first records it here and the rest decline to send. This is the first caller that can
  // reject at all: extraction contains each page in a `.catch`, so nothing before it ever
  // reached this path.
  //
  // Whether one failed is its own flag rather than a test on the error, because the value
  // thrown is not ours: a `throw undefined` from an adapter or a mock is still a chunk
  // that failed, and reading the guard off the error itself would leave it disarmed on
  // exactly that call — every queued chunk then paying in full, which is the case the
  // guard exists for.
  let failed = false;
  let failure: unknown = null;
  const perChunk = await mapWithConcurrency(chunks, limit, async (c, i) => {
    if (failed) throw failure;
    const user =
      head +
      `## HTML\n\`\`\`html\n${c}\n\`\`\`\n\n## Flattened screen-reader view\n${flatten(c)}\n\n## axe-core lint\n${lintSummary(lint)}` +
      (i === 0 && duplicateHeadings
        ? `\n\n## Headings with the same words at the same level, nothing but their own content between them (whole document)\n${duplicateHeadings}`
        : "") +
      tail;
    let res;
    try {
      res = await ctx.router.complete("reader", "text", [
        { role: "system", content: READER_SYSTEM },
        // The head is this run's page index and nothing else, so it is the same bytes on
        // every chunk of every round — declared so the adapter can cache it rather than
        // charge for it dozens of times (providers/types.ts `cachedPrefix`). Undefined
        // rather than "" when there is no index, which is a document with no pages to
        // attribute to: an empty head is not a prefix worth naming.
        { role: "user", content: user, cachedPrefix: head || undefined },
      ]);
    } catch (e) {
      // The first one wins, so the error the round rejects with is the one that
      // actually happened rather than whichever chunk noticed the flag.
      if (!failed) {
        failed = true;
        failure = e;
      }
      throw e;
    }
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
// the loop may not have one to spend: at the cap it never happens, and since the loop
// also stops on a round that changes nothing, a round whose issues are all
// unattributable can end it sooner than that — the editor answers with the body it was
// handed and there is no later round to narrow in. That makes this the stronger reason
// to broaden, not a weaker one: the issue is written to @unresolved having never
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

// What one editor round produced, and whether the editor actually answered.
//
// The two are separate because they are separate questions and the loop acts on both.
// `body` unchanged can mean the editor read every issue and decided the document was
// better left alone — a decision, and one it would make again on the same input — or it
// can mean the reply could not be used at all, which is a call paid for and nothing
// learned. Folding them together (which returning a bare string did) makes the second
// look like the first.
interface EditorRound {
  body: string;
  // False when the model returned nothing usable — an unparseable reply, or an empty
  // `html` — in which case `body` is what went in. Not evidence about what the editor
  // would do next time, because it never said.
  usable: boolean;
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
async function runEditor(ctx: PipelineContext, body: string, issues: ReviewIssue[]): Promise<EditorRound> {
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
): Promise<EditorRound> {
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
  // If the editor returns nothing usable, keep the current body unchanged — and say
  // that is what happened, so the loop does not read a reply it could not use as the
  // editor having decided the document was fine.
  const corrected = parsed?.html?.trim();
  if (!corrected) {
    ctx.log.event("editor_no_output", { chars: res.text.length });
    return { body, usable: false };
  }
  return { body: corrected, usable: true };
}

// Reader -> Editor -> re-verify, with three ways out: the Reader reports zero issues,
// a round changes nothing (see `review_converged` below), or the iteration cap is
// reached. The loop only stops CLEAN on the first of those — the Reader has actually
// re-confirmed it — so reported issues are verified-fixed, not assumed; the other two
// deliver the body with what is left written to @unresolved.
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
    const issues = await runReader(ctx, body, lint, pages, iterations);
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
    const round = await runEditor(ctx, body, issues);
    body = round.body;
    ctx.log.event("editor", { iteration: iterations, changed: body !== before });

    // A round that changed nothing has said what the next one would say.
    //
    // The Reader is about to be handed the same body, the same lint and the same page
    // index, and — if it raises the same issues, which is what an unchanged document
    // invites — the editor would be handed the same request it has just answered with
    // "no change". So the remaining rounds are the most expensive call in the run (whole
    // body in, a whole body out at max_tokens) plus a full re-read of the document,
    // spent to deliver the document already in hand. That is not hypothetical: a
    // [page not fully transcribed] marker is reported by the Reader every round BY
    // DESIGN and can only be settled by re-extracting the page, which is nobody's job in
    // this loop — so a document with one spends its whole budget rewriting itself into
    // itself.
    //
    // What is delivered is unchanged: this body, with the issues just raised written to
    // @unresolved — which is what the cap would have produced, since neither the body nor
    // the issues about it were going to move.
    //
    // Exactly so for the BODY. The @unresolved list is one Reader sample short of it: the
    // cap path takes a final read of the finished body, and that read can come back with
    // nothing — the same body, the same prompt, a different sample — which returns early
    // and credits the document clean. Breaking here stops at the read that preceded this
    // round, so a document that would have won that coin toss is now reported with the
    // issues it actually has. The direction is the conservative one (this rate goes up,
    // never down, and the delivered HTML is the same either way), and the reading it
    // costs is the less trustworthy of the two: a Reader that says "issues" and then
    // "clean" about one unchanged document has not found the document clean, it has
    // disagreed with itself.
    //
    // Only when the editor ANSWERED. A reply that could not be parsed leaves the body
    // untouched for a different reason — the editor never said anything — and the next
    // round is a real retry rather than a repeat, so it is allowed to run.
    //
    // The honest caveat: the editor is sampled, so a second identical request could
    // decide differently. `review_converged` is logged for exactly that reason — how
    // often this fires, and on which issues, is measurable from a run log, so the policy
    // can be revisited from evidence rather than from either of our guesses.
    if (round.usable && body === before) {
      ctx.log.event("review_converged", {
        iteration: iterations,
        issues: issues.length,
        rounds_left: ctx.maxReviewIterations - iterations,
      });
      break;
    }
    // Skipped when nothing changed, because every one of these answers a question about
    // a difference: the lint of an unedited body is the lint already in hand, and a link
    // or marker diff against an identical string is empty by construction.
    if (body === before) continue;

    lint = await runAxe(wrapDocument(body));
    // A link the editor dropped is unrecoverable and invisible to every later check
    // in the loop — see droppedHrefs for why this is checked here and in code.
    const dropped = droppedHrefs(before, body);
    if (dropped.length) {
      droppedLinks += dropped.length;
      ctx.log.event("editor_links_dropped", { iteration: iterations, hrefs: dropped });
    }
    // See BODY_MARKERS: the only place a marker's arrival or disappearance is recorded.
    const was = markerCounts(before);
    const now = markerCounts(body);
    const fewer = BODY_MARKERS.filter((m) => now[m] < was[m]);
    const more = BODY_MARKERS.filter((m) => now[m] > was[m]);
    if (fewer.length || more.length) {
      ctx.log.event("editor_markers_changed", {
        iteration: iterations,
        ...(fewer.length ? { fewer } : {}),
        ...(more.length ? { more } : {}),
        before: was,
        after: now,
      });
    }
  }

  // Issues remain and the loop has stopped — at the cap, or on a round that changed
  // nothing (§7.11). Either way they are recorded as a comment, with the source page
  // reference the Reader attributed (§7.8) so a human can find them.
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
