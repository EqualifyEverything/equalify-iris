import { extractJson } from "../util/json.ts";
import { VERIFY_KINDS, type VerifyKind } from "./feedback.ts";
import { mapWithConcurrency } from "../util/concurrency.ts";
import { MAX_EDITOR_IMAGES } from "../providers/imageLimits.ts";
import { isRequestTooLargeError, isTruncatedResponseError, TruncatedResponseError } from "../providers/types.ts";
import { feedbackPreamble, loadImage, type InputImage, type PipelineContext } from "./context.ts";
import { wrapDocument } from "./assembly.ts";
import { stripDeprecatedRoles } from "./roles.ts";
import { stripNestedMain } from "./landmarks.ts";
import { destroyedBody, EDITOR_SHRINK_FLOOR, structureCounts, visibleText } from "./correction.ts";
import { runAxe, lintErrorFields, type LintResult } from "./lint.ts";
import { joinSections, splitSections } from "./sections.ts";
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
  // True when a correction round's response hit the model's output ceiling, so the loop
  // stopped early (issue #143). Since #165 the round is re-made a section at a time before it
  // is given up on, so this no longer implies the delivered document is the one that entered
  // the round — `editorTruncatedLost` below is what says whether anything was lost.
  //
  // Returned rather than left in the run log for the same reason `droppedLinks` is: it
  // says something about the document the user received that the document itself cannot,
  // and one line in one session's log is invisible in aggregate. It is also what
  // distinguishes the two ways a document arrives with unresolved issues — the loop ran
  // its rounds and some issues survived them, or a round could not be completed at all.
  editorTruncated: boolean;
  // True when that round did not come back whole: no section could be made of the body, or a
  // section truncated in its turn and kept the text it went in with. Never true with
  // `editorTruncated` false.
  //
  // The delivered document has carried this distinction since #165 — `@editor-truncated
  // sections 3 of 4` against a bare `@editor-truncated` — and the quality tally had not, so a
  // deployment could not tell a ceiling it is paying to work around from one that is costing
  // its readers corrections. The two need separate rates because only this one can carry a
  // threshold: the other rises with document length by itself, since the editor's answer is as
  // long as the document it is rewriting (#159).
  editorTruncatedLost: boolean;
  // How many windows of the document the LAST read of it came back with no usable answer
  // for — an unparseable reply, or one carrying no issue list this code can read (issue
  // #186). 0 on a document that was reviewed in full, which is almost all of them.
  //
  // Returned for the same reason `droppedLinks` and `editorTruncated` are, and with a
  // sharper edge than either: it is what distinguishes a document the reviewer found
  // nothing wrong with from one the reviewer did not answer about. Those two are the same
  // shape here — an empty issue list, no correction rounds — so without this the second
  // arrives as the first, is delivered as clean, and is counted as clean deployment-wide.
  // An empty `unresolved` is only good news when this is 0.
  unreviewedWindows: number;
}

// Exported so a test can assert the marker vocabulary it advertises is the one
// `flatten` actually emits: a marker the prompt promises but the code never produces
// teaches the Reader to expect something that will not appear.
export const READER_SYSTEM = `You are the Reader Agent. You review accessible HTML for reading-order problems, semantic
inconsistencies, duplicated/redundant content, and missed WCAG 2.2 AA requirements. You do NOT
see source images — you read the document the way a screen-reader user would.

What you are shown is the BODY CONTENT of the delivered document, not the whole of it. The
document supplies the rest and already has it: a <!DOCTYPE html>, an <html> with a lang
attribute, a <head> with a <title>, a <body>, and a <main> that holds everything you can see.
So this document does have a main landmark, a title and a declared default language — none of
them is missing and none of them is yours to ask for. WHICH language it declares comes from the
content, and only where the content is unanimous and names a language a tag can carry: the shell
declares a language when EVERY top-level element of this body names that same language with a
real language tag — ko or kor, never Korean or ko_KR — and English in every other case,
including where only some of them carry one, since a half-labelled body gives it nothing it can
trust, and including where they agree on something that is not a tag. So content in the language the document ends up declaring needs no lang attribute of its
own, and lang="en" on the parts of a document that is English throughout adds nothing. Content
in any OTHER language does need one, and that is worth reporting: an English abstract inside a
document whose top-level parts all say Korean, the Korean quotation inside an English one, and —
because a half-labelled document falls back to English — an unlabelled Korean passage standing
next to a labelled one. Report what is IN the content you were given.

You get two views of the same content: the HTML (structural reference) and a flattened
text-only view (what a screen reader announces, in order). Cross-check them, and also consider
the axe-core lint results provided.

In the flattened view, anything in square brackets is a structural annotation, not content:
[Heading 1-6], [List item], [List item N], [Link], [Image], [Image alt], [Table],
[Header row], [Row], [Field input|textarea|select|button|summary], [Label], [Quote],
[Caption], [Term], [Definition], [Abbr title], plus [N rows, M columns], [empty], [no caption],
[spans N columns], [spans N rows], [alt missing] and [decorative, alt empty]. Two bracketed
tokens are the exception, because the extractor wrote them into the document rather than the
flattener adding them: [not legible] and [page not fully transcribed] are content — what a page
said where the source could not be read, or could not be returned in full — and are dealt with
below. A field's own announced name follows its marker, so [Field input text] with nothing after
it is a control with no accessible name at all. Tables are expanded row by row with cells separated by " | ".
[Abbr title] carries the name an abbreviation or a symbol holds in its title attribute: a glyph
followed by "[Abbr title] Stop" is a named control and correct markup, and only a symbol with
nothing after it is unnamed. Do not ask for that name to be moved into the text — the words
belong to the page and the attribute is where they are announced from.

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
outside the HTML you were given, and is to be reported anyway. Report every entry in that list as an issue,
and say which of the two cases it is; where the excerpts do not tell you, say that instead of
choosing. The list decides only that a pair EXISTS: no entry is a false positive to be argued
with, and finding a pair the list missed is still worth reporting.

One class of content marked up two ways is a defect of the same kind, and only the joined document
shows it either. The pages were extracted one at a time by calls that could not see each other, so
the line of website, e-mail and revision that every page prints may announce [Term]/[Definition]
pairs on one page and a plain sentence on the next, and sections of one sort may open at
[Heading 2] on four pages and [Heading 1] on the fifth. Report the group as ONE issue, naming the
pages on both sides and which shape most of them use, so what follows is a page brought into line
rather than a document rewritten. The words the fix needs have to be on the page: a footer printing
"Website: example.com" as a sentence carries its own labels, and those are what the [Term]s are
built from. Where one side prints no labels at all, a labelled footer against a line of bare
values, leave it alone — the difference is between the two pages and not in their markup, nobody
downstream may supply words a page never printed, and an issue that cannot be closed is reported
again every round. Two things have to hold first. The content has to be the same KIND on both pages and the
excerpts have to show you that — two footers with the same fields, two parts tables — since
sections that merely differ are not an inconsistency: a table of contents and a parts list are not
one class, and a page whose content has no counterpart is not either. And you can only judge what
you were given: where your HTML is one window of several, a shape you meet once here may be the
majority shape in the rest of the document, so report a difference between two pages you can both
see, never a page that looks unlike the pages you cannot.

A [not legible] marker is what the extractor wrote where the marks on its page did not resolve
into characters, and a [page not fully transcribed] marker is what it wrote where it could not
return the whole page. Report every one of them with the page it is on, and nothing more. The page
is what matters: the Copy Editor is given the images for the pages your issues name, and looking at
that page again is the only thing that can settle the first marker — the second is settled by
re-extracting that page, which is nobody's job in this loop, so it is reported and left standing.
You do not see the source images, so never suggest what a marker stood for, and never ask for one to
be deleted — a document that once said a word could not be read, or a page not finished, and now
says nothing tells every reader that the page arrived whole.

A sentence or a word broken at a page turn is not a defect in the markup, and it is not yours to
report. Where a paragraph ends "public serv-" and the next begins "ices in a State", or ends
mid-sentence with the next continuing it in lower case, those are two pages transcribed exactly as
they printed, by calls that could not see each other. The Copy Editor is told to leave both halves as
they are and to invent no completion, so an issue naming one is an issue nobody may close: reported
again every round, about text that is already right. Joining the halves belongs to a pass that holds
both, and is not this one. Say nothing about it. What tells you this is the case is a page break
between the two halves, and you have to look in the HTML view to find one: it is an <hr> carrying
role="doc-pagebreak", it announces nothing, and the flattened view shows the halves adjacent with
nothing in between. Where the HTML puts no page break between them, the page index below is the other sign, and you need
it: a page that prints no number emits no marker at all, so a document of unnumbered scans has page
turns and nothing marking them. Each entry in that index is the START of a page, which is
where the half that carries on will be: find "ices in a State" at or near the head of some page's
excerpt — a numbered page puts its marker there first, so the words may be a little way in — and this
is a page turn, marker or no marker, and there is nothing to report. Silence is also the answer where
you cannot place either half — the halves as printed are right, and an issue about them is one nobody
may close. Only where both halves and the words they break between sit inside one page's own excerpt
did the sentence break inside a page, and that is content the page did not return: a finding of the
ordinary kind, and yours to make.

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

Some entries in that index say the page contributed no content instead of showing an excerpt, and
neither kind of entry is an issue to report. A page whose extraction FAILED is content this pipeline
lost: the document already records it, both in that entry and in a @page-failed comment where the
content would have been, and no edit to the HTML can bring the page back — so reporting it spends a
correction round on the one defect this loop cannot fix, and reports it again on every round after.
A page that is BLANK in the source contributed nothing because there was nothing on it to
transcribe, which makes the document correct as it stands. Say nothing about either.

Be careful in the other direction too, about content you cannot find. Where the HTML section is
labelled as one window of several, the rest of the document is another call's to read, so a page
whose content is not in your window is not a missing page and is not yours to report. Where it
carries no such label you have the whole body, and content genuinely absent from it — a page the
index shows as extracted with nothing of it in the document — is a real finding and yours to make.

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
corrected body (no <html>/<head>/<body>/<main> wrapper — the document this body is placed into
supplies all four, so a <main> of your own would be a second one and would take away the landmark a
screen-reader user jumps to in order to skip the furniture).

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
pipeline that can exceed what a response can hold, and hitting that ceiling costs this reading of the
document: the round is re-made one section at a time, by requests that each see a piece of the
document and not the rest of it, and this is the last round either way. Re-extracting that page is
what has a whole response to itself. So leave the marker exactly
where it stands, resolve the other issues around it, and never delete it — an unfinished page that
says so can be finished, and one that does not looks complete to everyone downstream.

A sentence or a word broken at a page boundary is not a defect in the markup either, and finishing
one is the third text you may not add. Where a paragraph ends "public serv-" and the next begins
"ices in a State", or ends mid-sentence with the next continuing it in lower case, those halves came
off two pages extracted by calls that could not see each other, and the page-break marker between
them is why: it is the first thing a page emits, so the split falls between two replies rather than
inside either. Do not complete the word, do not rewrite either half into a sentence that reads
whole, and do not delete the fragment that looks broken — every word of both halves is a word some
page printed, and the completion is a word no page printed. Leave the text as it stands, and leave it
off your observation list as well: a split straddles two pages, usually neither of them one whose
image you hold, and none of the kinds below names it, so filing it there is a mistagged fidelity
report rather than a record anyone acts on. The record already exists — the page that opened
mid-sentence said so in its own log — and joining the halves belongs to a pass that holds both,
because a plausible completion reaches the reader as what the page says.

A link's target is content, and it is the one kind you cannot recover: an href came from the
source FILE, not from the page image, so a URL you drop or alter is gone and a URL you invent
cannot be checked. Carry every href through exactly as written — including on content you
restructure or move — and never add a link that is not already in the document. You may change
the TEXT of a link when an issue calls for it (link text that does not describe its
destination is a real 2.4.4 problem); keep its href.

On a page whose image IS attached you may notice a fidelity problem nobody asked you about:
content the page shows that the HTML does not have, a number or a name that disagrees with the
page, a table the page prints as a table and the HTML renders as paragraphs. REPORT those and do
NOT act on them. Fixing one means reading that page again in full, which is a re-extraction and not
this loop's job, and rewriting content the reviewer did not raise is worse than saying it looks
wrong: an observation costs someone a look at the page, and an edit made on one reading of an
image reaches the reader as what the page says. Report only pages whose image is attached —
anything else is a guess about a page you cannot see — and keep the list to what you would want a
person to check, not everything you might improve. An empty list is the ordinary answer.

This takes nothing off your list. An issue the reviewer raised is still yours to fix, and a
[not legible] marker on an attached page is still yours to resolve as described above, even though
both are content the page shows and the HTML does not: reporting is for what nobody asked you
about. When a problem is both — the reviewer raised it AND you can see more of it on the page than
the issue names — fix what was raised and report the rest.

Give each observation the page it is on, one sentence, and its kind: ${VERIFY_KINDS.join(", ")} —
the same five the fidelity check uses, by what a reader LOSES, with the earliest of them that
applies winning (content absent from the HTML is content_missing even though it is also a WCAG
failure; a11y_only is a problem the page's own content does not lose, and alt_quality is a
description that could be better rather than absent).

Respond with ONLY JSON, with the corrected body first:
{ "html": "<corrected body content>",
  "fidelity_observed": [ { "page": 7, "observation": "the second table's third row is absent from the HTML", "kind": "content_missing" } ] }`;

// The same editor, asked for one section of a document instead of the whole of it — because the
// whole of it did not fit in one response (issue #165, and `correctBySection` below for when
// this is used).
//
// Built on EDITOR_SYSTEM rather than written separately: every content rule above still holds
// for a section (a dropped href is just as lost, a [not legible] marker just as unresolvable
// without its page), and two prompts that had to be kept in step would drift. What follows
// overrides exactly one instruction — "the FULL body" — and adds the one hazard that only
// exists when the editor cannot see the rest of the document.
export const EDITOR_SECTION_SYSTEM = `${EDITOR_SYSTEM}

## This request is ONE SECTION of the document

The document was too long for its correction to be returned in a single response, so it has been
cut at top-level boundaries and each section is corrected on its own. Everything above still
applies, with one change and one warning.

The change: return the corrected version of THIS SECTION only, and nothing from outside it. The
other sections are being corrected by their own requests and will be joined back around yours in
order, so anything you repeat from elsewhere would be delivered twice, and anything you leave out
is simply gone. Do not add a heading, a wrapper or a summary to make the section read as a whole
document — it is not one, and the sections around it supply what it appears to be missing.

The warning: you cannot see the rest of the document, so some of the issues you are given are
about content that is not in front of you. Fix the ones that are here and return the rest of this
section unchanged; an issue you cannot find is in the section that holds it, and is that
request's to fix. Above all, never remove content because it looks duplicated: the copy you can
see may be the only one in the document. Two headings with the same words are yours to resolve
only when BOTH of them are in this section — a heading whose twin is elsewhere stays exactly as
it is, because dropping the one you can see is how a section loses its title.

Respond with ONLY JSON: { "html": "<corrected section>" }`;

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

// What the elements under each violation are, said once above the list.
//
// Here rather than in READER_SYSTEM for the same reason the no-verdict sentence is: the lines it
// describes are two lines below it, and every clause of it is a thing a Reader would otherwise
// have to infer from a selector it has never been told the provenance of.
//
// The last sentence is the half of #161 that is not about the Reader at all. The Copy Editor is
// never shown the lint — `editorCall` sends the body and the Reader's issue list, nothing else —
// so a selector that stops at the Reader has moved the search one agent down rather than ended
// it. Round 8's `aria-deprecated-role` is the worked example: the Reader named the rule in its
// analysis, the editor ran and changed the document, and the deprecated role shipped.
const LINT_NODE_NOTE =
  `Each violation lists the elements axe reported it on: a CSS selector, then that element's ` +
  `markup folded to one line and cut short. The list is computed from the WHOLE document ` +
  `rather than from the HTML you were given, and this call is the only one that has it, so an ` +
  `element it names may sit outside your window — report it anyway. Only the first few elements ` +
  `of a rule are listed and the node count is the whole of it, so a rule listing three elements ` +
  `out of forty is forty places to fix. Quote BOTH the selector and the markup in the issue you ` +
  `write: the Copy Editor is not shown these results, so what you write is all it has to find ` +
  `the element by — and it is sometimes given one section of the document rather than all of it, ` +
  `where a selector counting position (\`section:nth-child(4) > p\`) counts something else and ` +
  `the markup is what still identifies the element.`;

// The most elements the whole summary lists, across every rule.
//
// MAX_EXAMPLE_NODES bounds one rule; this bounds the section, which is the thing that competes
// with the document for the window. The two arguments are different: three of a rule's forty
// nodes is a sample, and there is no such thing as a sample of the rule LIST — ~60 rules are
// enabled, so a badly extracted scan failing fifteen of them would add every one of their
// examples to a prompt that also has to hold 24000 characters of document.
//
// Spent in the order the violations are listed, and what it cut is said in the prompt: a list
// that stops without saying so reads as the rules after it having had nothing to point at.
export const MAX_EXAMPLES_TOTAL = 24;

// What the Reader is told the linter found. The no-verdict case is spelled out rather than
// stated as a failure, because this text sits under a "## axe-core lint" heading in a prompt
// that also says the review is against "the axe-core lint results provided": a Reader given
// only an error message can read the section as an empty result and take the document to
// have been checked (#164). It is told the opposite, in the sentence it would otherwise
// have to infer.
//
// `withExamples` is false for every chunk but the first, and the elements are the reason. The
// lint is one verdict on the WHOLE document while the Reader is called per window, so a note
// telling every call to report an element outside its own window tells N calls to report the
// same one — the defect arrives N times and is carried to `@unresolved` N times if no editor
// round clears it (#192, through the lint path this time). It is the same constraint the
// duplicate-heading list is under and it takes the same answer: one call owns the
// whole-document input. What the other chunks keep is exactly what they had before this
// section listed elements at all — the rule, its impact, its description and its count.
function lintSummary(lint: LintResult, withExamples: boolean): string {
  if (lint.violations === undefined) {
    return (
      `axe-core could not run, so NOTHING in this document has been checked for ` +
      `accessibility violations. Treat this section as absent, not as empty: there is no ` +
      `machine verdict on this document either way, and anything a linter would have caught ` +
      `is still in it unless you catch it. (${lint.error ?? "no result"})`
    );
  }
  if (lint.ok) return "axe-core: no violations";
  let budget = withExamples ? MAX_EXAMPLES_TOTAL : 0;
  let listed = 0;
  let unlisted = 0;
  const lines = lint.violations.map((v) => {
    const head = `- ${v.id} (${v.impact}): ${v.description} [${v.nodes} nodes]`;
    const examples = (v.examples ?? []).slice(0, budget);
    if (examples.length === 0) {
      // Counted once the budget is gone, whether or not this rule HAD examples to spend it
      // on. The paragraph below points at "the last N rules", which is a claim about position
      // and is only true if N is every unlisted rule: a violation carrying no examples at all
      // (hand-built, or stored before #161) sitting between two that were cut would otherwise
      // be skipped in the tally and read as one of the rules whose elements are listed.
      if (withExamples && listed > 0 && budget === 0) unlisted++;
      return head;
    }
    budget -= examples.length;
    listed += examples.length;
    // The list says how much of the rule it is showing, on the line the selectors hang off. A
    // reader of three selectors under a `[40 nodes]` count has to be told that the three are a
    // sample and not the forty, or the count reads as having been enumerated.
    const shown = examples.length < v.nodes ? ` — showing ${examples.length} of ${v.nodes}:` : ":";
    return (
      head + shown + "\n" + examples.map((n) => `    - \`${n.target}\` — ${n.html}`).join("\n")
    );
  });
  // Only where there is something for it to describe. A lint whose violations carry no examples
  // — a chunk that is not the first, a violation built without them (see LintViolation) — would
  // otherwise be introduced by a paragraph about lines that are not there.
  const note = listed > 0 ? `${LINT_NODE_NOTE}\n\n` : "";
  const cut =
    unlisted > 0
      ? `\n(No elements are listed for the last ${unlisted} ${unlisted === 1 ? "rule" : "rules"} ` +
        `above: the list had already reached ${MAX_EXAMPLES_TOTAL}. Their counts are the whole of ` +
        `them and they are no less real for having no example here.)`
      : "";
  return note + lines.join("\n") + cut;
}

// The page index is repeated on every Reader call (once per chunk per round), so
// excerpts are shorter here than the scoping call's — just enough to match content
// back to a page.
const READER_INDEX_EXCERPT_CHARS = 200;

// What the index says instead of an excerpt for a page the document has no content for.
// Both are under READER_INDEX_EXCERPT_CHARS, so neither is delivered half-said.
//
// The two are worded apart because they are opposite facts about the run and a reader of a
// log or a prompt has to be able to tell them apart: one is content this pipeline lost, the
// other is a page with nothing on it, correctly delivered as such (issue #184). What they
// share is that no correction round can act on either, which is why each says so where the
// Reader reads it rather than only in READER_SYSTEM — the rule is one paragraph away from a
// numbered entry the Reader is matching content against, and the entry it is about is the
// one that used to read as a hole.
const FAILED_PAGE_NOTE =
  "(no content — this page could not be extracted, so the document has none of it. " +
  "Already recorded, and no edit can fix it: not an issue to report.)";
const BLANK_PAGE_NOTE =
  "(no content — this page is blank in the source, so there was nothing to extract. " +
  "The document is correct as it stands: not an issue to report.)";

// The pages the document has no content for, and which of the two reasons it is.
//
// `failed` comes from the caller, because only extraction knows it: the fragment of a failed
// page is not empty — it is the `@page-failed` comment that says where the hole is — so
// nothing about its own bytes distinguishes it from a page whose content happens to be short.
// `blank` is read off the fragment, because an empty fragment can only be a page the page
// agent declared blank: extraction throws on an empty reply it was not told to expect, and a
// throw takes the `failed` path above (see extraction.ts `declaredBlank`).
//
// Both are things the review loop is asked about today and can do nothing with. The failed
// page is the case runReview's `failedPages` comment already names — "the Reader would raise
// 'this page is missing' every round against a body no editor can repair" — and the guard it
// describes only kept the disclosure out of the editor's reach, never the question out of the
// Reader's prompt (issue #188). The blank page is the same shape with nothing wrong behind it:
// its index entry was an empty line, an empty line reads as a hole, and #184's correctly
// delivered blank pages came back as unresolved issues on the next round of the bench.
export function noContentPages(pages: IndexedPage[], failedPages: number[]): Map<number, "failed" | "blank"> {
  const failed = new Set(failedPages);
  const out = new Map<number, "failed" | "blank">();
  for (const p of pages) {
    if (failed.has(p.order)) out.set(p.order, "failed");
    else if (!p.innerHtml.trim()) out.set(p.order, "blank");
  }
  return out;
}

// The Reader's view of the index: those pages' entries say what they are instead of showing
// an excerpt of content that is not there.
//
// Annotated rather than REMOVED, which was the other half of #188's proposal. A removed entry
// leaves a gap in the numbering — page 7 then page 9 — and a gap is exactly what invites the
// report it was meant to prevent, from a Reader that now has to guess what happened to 8. It
// would also cost the entry its one honest use: a failed page still narrows a nearby issue's
// attribution, because "the content around here is on 7 and 9" is what the pages either side
// of it say.
//
// A copy, not a mutation: `pages` is the array runReview holds for the whole loop and hands to
// `knownPages`, and an attribution to a page with no content must stay valid — it is how the
// one report this still allows carries its page number.
export function readerIndexPages(pages: IndexedPage[], noContent: Map<number, "failed" | "blank">): IndexedPage[] {
  if (noContent.size === 0) return pages;
  return pages.map((p) => {
    const state = noContent.get(p.order);
    if (!state) return p;
    return { ...p, innerHtml: state === "failed" ? FAILED_PAGE_NOTE : BLANK_PAGE_NOTE };
  });
}

// One report per page with no content, however many chunks reported it.
//
// The prompt above is the primary fix and this is the backstop, in the order the pipeline
// prefers everywhere else: say it where it can be understood, then make the thing that cannot
// be understood impossible. The Reader is a sampled model told not to raise these, and on the
// round that filed #188 every chunk raised them anyway — six reports of one page in six
// different wordings, six of that document's 26 unresolved issues.
//
// Per CHUNK, and only the final round's chunks: `@unresolved` is written from `lastIssues`,
// which every round overwrites, so the delivered list is one read of the document and the
// number of copies in it is that read's chunk count. What the ROUNDS multiplied is the spend —
// every round's editor was handed the same reports about a page it cannot repair, and paid a
// whole-body correction to say nothing about them.
//
// Which is why the key is `(no content, page)` rather than the issue text. The reports come
// from independent calls that never see each other, so no two are worded alike and exact-string
// dedupe catches none of them; what makes them the same issue is the page, and the pipeline
// already knows which pages these are. An issue is one of them when it is attributed AND every
// page it names has no content in the document — a page with no content cannot hold content
// that is wrong, so an issue about nothing else is an issue about the absence.
//
// The FIRST is kept, not all of them dropped, and the difference is deliberate. Dropping them
// all would make this code decide that a report is worthless on evidence it does not have: the
// attribution is the Reader's, and a misattributed real issue — structure the Reader could not
// place, pinned on a failed page — would vanish with no trace anywhere. Keeping one costs a
// reader of `@unresolved` a line they can act on (it names the page, and the document's
// `@page-failed` comment says the rest) and leaves one copy where there was one per chunk. It
// does mean a document with a failed page still cannot end the loop clean, which is the
// behaviour it has today and a separate question from counting it once.
//
// Unattributed reports are not caught and cannot be: "the document is missing a page" with an
// empty `pages` list is indistinguishable here from any other issue the Reader could not place.
// The prompt is the only reach into that case, which is the other reason it is not the backstop.
export function dedupeNoContentIssues(
  issues: ReviewIssue[],
  noContent: Map<number, "failed" | "blank">,
): { issues: ReviewIssue[]; dropped: ReviewIssue[] } {
  if (noContent.size === 0) return { issues, dropped: [] };
  const reported = new Set<number>();
  const dropped: ReviewIssue[] = [];
  const kept = issues.filter((issue) => {
    const pages = issue.pages ?? [];
    if (pages.length === 0 || !pages.every((p) => noContent.has(p))) return true;
    if (pages.every((p) => reported.has(p))) {
      dropped.push(issue);
      return false;
    }
    for (const p of pages) reported.add(p);
    return true;
  });
  return { issues: kept, dropped };
}

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

// One window's worth of review: what the Reader said about it, and whether it said
// anything this code can read.
//
// The two are separate for the same reason `EditorRound.usable` is separate from its body:
// an empty issue list can mean the Reader read the window and found nothing — a verdict —
// or that the reply could not be used at all, which is a call paid for and no verdict
// obtained. Folding them together (which returning a bare `ReviewIssue[]` did) makes the
// second look like the first, and the first is the one thing that ends the loop clean.
interface ReaderWindow {
  issues: ReviewIssue[];
  // False when the reply carried no readable issue list: unparseable, `issues` missing or
  // not an array, or every entry in it too malformed to be an issue. NOT false for a reply
  // that legitimately said `{"issues": []}` — that is the verdict this whole loop is for.
  usable: boolean;
}

// What one read of the whole document came to: the issues, and how much of the document
// nobody got an answer about (see ReaderWindow).
interface ReaderRead {
  issues: ReviewIssue[];
  unread: number;
  windows: number;
}

async function runReader(
  ctx: PipelineContext,
  body: string,
  lint: LintResult,
  pages: IndexedPage[],
  // Only so the line this logs can say which round it belongs to, the way `reader` and
  // `editor` already do. Nothing here reads it.
  iteration: number,
  // The pages extraction lost, so this call can say so in the index instead of showing an
  // empty entry and being asked about it once per chunk (see noContentPages).
  failedPages: number[],
): Promise<ReaderRead> {
  const noContent = noContentPages(pages, failedPages);
  const index = pages.length ? pageIndex(readerIndexPages(pages, noContent), READER_INDEX_EXCERPT_CHARS) : "";
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
    // Whether this call has the whole body or a window of it, said where the body is handed
    // over. The Reader is told not to report a page as missing on the strength of content it
    // cannot find (READER_SYSTEM, issue #188) — which is right for a window and wrong for the
    // whole document, where a page whose content an editor round dropped is a finding nothing
    // else in this loop can make. `contentCoverage` and `destroyedPage` guard extraction, not
    // this loop, so on a single-chunk document the Reader is the only check there is. Absent
    // rather than "window 1 of 1", because a label that has to be read as "you have all of it"
    // is one more thing to get wrong.
    const window = chunks.length > 1 ? ` (window ${i + 1} of ${chunks.length} of the document)` : "";
    const user =
      head +
      // `i === 0` for the offending elements, on the same argument as `duplicateHeadings` two
      // lines down: the lint is one verdict on the whole document, and a whole-document input
      // given to every independent chunk call comes back as the same finding once per chunk.
      // See lintSummary.
      `## HTML${window}\n\`\`\`html\n${c}\n\`\`\`\n\n## Flattened screen-reader view\n${flatten(c)}\n\n## axe-core lint\n${lintSummary(lint, i === 0)}` +
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
    // Nothing about the reply's SHAPE is ours, so none of it is assumed. `issues` arrives
    // as `unknown` and is narrowed here, which is two fixes in one place: a reply whose
    // `issues` is a string used to throw a TypeError out of the loop — a failed session,
    // extraction and assembly discarded, for a badly shaped answer — and a reply with no
    // issue list at all used to read as `{"issues": []}`, i.e. as a clean document (#186).
    const parsed = extractJson<{ issues?: unknown }>(res.text);
    const raw = Array.isArray(parsed?.issues) ? parsed.issues : null;
    // An entry that is not an object cannot be an issue, and reading `.pages` off one
    // throws — `null` in the list is the same crash as a string `issues`, one level in.
    // Dropped rather than fatal, for the reason the whole file is built on: a reply that is
    // partly usable is worth its usable part.
    const shaped = (raw ?? []).filter(
      (issue): issue is ReviewIssue & { pages?: unknown } => typeof issue === "object" && issue !== null,
    );
    if (raw !== null && shaped.length < raw.length) {
      ctx.log.event("reader_issues_dropped", {
        iteration,
        window: i + 1,
        of: chunks.length,
        dropped: raw.length - shaped.length,
        of_entries: raw.length,
      });
    }
    // A reply that listed issues and had none of them survive the shape check said nothing
    // readable either, so it is not a verdict — while `{"issues": []}` IS one, which is why
    // this is not simply `shaped.length > 0`. That empty list is what the whole loop is for.
    if (raw === null || (raw.length > 0 && shaped.length === 0)) {
      // Said the way `editor_no_output` is said, because it is the same event about the other
      // agent: a call that was paid for and produced nothing to act on. One line per window
      // that has no verdict, whichever way it failed — `window` and `of` because a document
      // is read in windows and only one of them may have failed, and `reason` because "there
      // was no list" and "there was a list of nothing usable" are different replies.
      ctx.log.event("reader_no_output", {
        iteration,
        window: i + 1,
        of: chunks.length,
        reason: raw === null ? "no_issue_list" : "no_readable_issue",
        chars: res.text.length,
      });
      return { issues: [], usable: false };
    }
    // Drop hallucinated page numbers here rather than downstream, so a bad
    // attribution degrades to "no attribution" (all images) instead of
    // silently sending the editor the wrong page.
    return {
      issues: shaped.map((issue) => ({ ...issue, pages: knownPages(issue.pages, pages) })),
      usable: true,
    };
  });
  // mapWithConcurrency returns results in INPUT order, so the issue list is the one a
  // serial loop produced — which matters downstream: `imagesForIssues` unions the pages
  // and `unresolved` is written in this order, so a document's unresolved list must not
  // depend on which chunk's call happened to finish first.
  //
  // Which is also why the dedupe runs here, on the flattened list, rather than inside the
  // per-chunk callback: what it removes is the SECOND report of a page, and which report is
  // second is a fact about the assembled list. Applied per chunk it would be a no-op — no
  // chunk reports a page twice on its own — and applied to whichever call finished first it
  // would keep a different one each run.
  const { issues, dropped } = dedupeNoContentIssues(
    perChunk.flatMap((w) => w.issues),
    noContent,
  );
  // Logged only when something was dropped, and with the reports themselves rather than a count
  // alone. The count says how much of `@unresolved` this round would have spent on repeats and
  // the pages say which entries the kept report stands for, but neither would let anyone read
  // what went: keeping the first is defended above on the grounds that a misattributed real
  // issue must not vanish without a trace, and WHICH report is first is an accident of chunk
  // order — the chunk that pinned a real defect on a lost page may not be chunk 0. So the text
  // and severity of each dropped report are here, whitespace-folded and bounded the way every
  // other model-written string this pipeline logs is bounded.
  if (dropped.length > 0) {
    ctx.log.event("reader_page_reports_deduped", {
      iteration,
      dropped: dropped.length,
      pages: [...new Set(dropped.flatMap((i) => i.pages ?? []))].sort((a, b) => a - b),
      // `String(... ?? "")` because these two fields are the model's own: `runReader` normalizes
      // only `pages`, and everything else that touches an issue interpolates the text into a
      // prompt or a comment, where a missing one prints as `undefined` and costs a line. This is
      // the first place that calls a METHOD on it, and a reply that omitted `issue` would throw a
      // TypeError out of the review loop into the orchestrator's outer catch — a failed session,
      // extraction and assembly discarded, for a log line about a report being dropped.
      reports: dropped.map(
        (i) => `${i.severity ?? "unrated"}: ${String(i.issue ?? "").replace(/\s+/g, " ").trim().slice(0, 300)}`,
      ),
    });
  }
  return { issues, unread: perChunk.filter((w) => !w.usable).length, windows: chunks.length };
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
  // True when the whole-body response hit the model's output ceiling (issue #143). A third
  // answer to the same question, and the only one that also says the NEXT round cannot
  // succeed: the response length is a function of how long the document is, and the document
  // has not got shorter. The loop must not treat this as the retryable case that
  // `usable: false` otherwise means.
  //
  // It no longer implies `usable: false`, which is issue #165: the round is retried a section
  // at a time before it is given up on, so a truncated round can come back with corrections in
  // it. `truncated` still says the ceiling was hit and the loop still ends on it; `sections`
  // says what was rescued.
  truncated: boolean;
  // Set when the round was answered section by section: how many sections the body was cut
  // into, and how many of them came back corrected. Absent on a round that was answered whole
  // and on one that could not be sectioned at all — so its presence is what distinguishes a
  // truncation the document survived with corrections from one it survived without them.
  sections?: { of: number; corrected: number };
}

// What the log line about a truncation says. The ceiling and the size of the response are
// the two numbers an operator needs — they are the difference between "raise max_tokens"
// and "this document cannot fit under any ceiling" — and they are on the error when Iris
// raised it, which is every case except one that lost its prototype on the way here.
function truncation(e: unknown): Record<string, unknown> {
  const message = e instanceof Error ? e.message : String(e);
  if (!(e instanceof TruncatedResponseError)) return { error: message };
  return { max_tokens: e.maxTokens, chars: e.chars, error: message };
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
    return { ...(await editorCall(ctx, body, issues, selected)), truncated: false };
  } catch (e) {
    // A response that hit the output ceiling is this round producing nothing usable,
    // arriving as an exception instead of as an empty string — and `editorCall` already
    // treats nothing usable as "keep the current body" two dozen lines down. Left to
    // throw, it ends the run: extraction, assembly and a Reader pass have all been paid
    // for, the assembled document is sitting in `body`, and the user is handed a failure
    // instead of it. On the two documents that reported this (#143) that was $8.59 of a
    // $13.19 round, every dollar spent before the call that failed.
    //
    // Delivering with the round's issues unfixed is a state the loop already supports
    // and reports — @unresolved in the document, `unresolved` in the result,
    // `unresolved_rate` deployment-wide — so this is #135's principle one layer up: a
    // round may fail without the document. It is NOT the same case as the size refusal
    // below and must not be retried, either: the refusal is about the request, which
    // Iris can make smaller by dropping images, while a truncation is about the
    // response, and "return the complete corrected body" is the same length however it
    // is asked for. The caller stops the loop instead.
    if (isTruncatedResponseError(e)) {
      ctx.log.event("editor_truncated", { attached: selected.length, of: ctx.images.length, ...truncation(e) });
      // The round is not over yet: what cannot be returned in one response can be returned in
      // several, and the ceiling has just measured how long one of them may be (#165). If that
      // comes to nothing the result is what it always was — `usable: false` for the same reason
      // an unparseable reply is, nothing came back to use — but either way the caller must
      // branch on `truncated` FIRST. An unusable round is allowed to run again, because the
      // editor never said anything; this one has said all it can say about a document asked for
      // whole.
      return sectionRound(ctx, body, issues, e);
    }
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
    // `error` is on the event because "refused" is not always literally true: one case
    // this predicate matches is a Converse stop reason that arrives after a full, billed
    // generation (see isRequestTooLargeError), so the message is what distinguishes a
    // request that cost nothing from one that cost a round of output.
    ctx.log.event("editor_images_refused", {
      attached: selected.length,
      of: ctx.images.length,
      error: e instanceof Error ? e.message : String(e),
    });
    // A retry without images can truncate in its turn — same document, same
    // instruction — so it is contained the same way rather than left to end the run.
    try {
      return { ...(await editorCall(ctx, body, issues, [])), truncated: false };
    } catch (retryError) {
      if (!isTruncatedResponseError(retryError)) throw retryError;
      ctx.log.event("editor_truncated", {
        attached: 0,
        of: ctx.images.length,
        ...truncation(retryError),
        after: "images_refused",
      });
      // And salvaged the same way. The section calls carry no images either (see
      // `editorSectionCall`), so a request the model refused with them is not made again with
      // them — this path arrives already text-only and stays that way.
      return sectionRound(ctx, body, issues, retryError);
    }
  }
}

// One Copy Editor call, with whichever images it was given. Split out so the same
// prompt can be re-sent without them; `selected` empty is a normal shape here, and the
// prompt says so rather than promising attachments that are not there.
//
// It answers about the reply it got, and a truncation is not one: the provider raises it
// instead of returning a reply, so `truncated` is `runEditor`'s to fill in from the catch
// and this function cannot state it either way.
async function editorCall(
  ctx: PipelineContext,
  body: string,
  issues: ReviewIssue[],
  selected: InputImage[],
): Promise<Omit<EditorRound, "truncated">> {
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
  const parsed = extractJson<{ html?: string; fidelity_observed?: unknown }>(res.text);
  // Read before the usable check, because an unusable BODY does not make the observations
  // unusable: the editor was looking at the page either way, and a reply this code cannot use
  // as a document is one of the cases where knowing what it saw is worth most.
  logFidelityObserved(ctx, parsed?.fidelity_observed, selected);
  // If the editor returns nothing usable, keep the current body unchanged — and say
  // that is what happened, so the loop does not read a reply it could not use as the
  // editor having decided the document was fine.
  const corrected = parsed?.html?.trim();
  if (!corrected) {
    ctx.log.event("editor_no_output", { chars: res.text.length });
    return { body, usable: false };
  }
  // And the floor #174 asked for: a reply that came back with less than half the prose of the
  // document it was given did not correct that document, whatever it parsed as. This is the one
  // path where the model's `html` is adopted for the WHOLE body with nothing compared against what
  // went in, and the blast radius is the deliverable — so the reply that answers and then quotes
  // the contract back, the reply that returned section three, the reply that summarised, all
  // arrive here indistinguishable from a corrected document. See `destroyedBody` for the number
  // and for why it reads the visible text rather than the characters or the structure counts.
  //
  // Reported as `usable: false`, the same as an unparseable reply, because the two are the same
  // fact about the round: nothing came back that can be used as this document. That keeps the body
  // that entered — the loop reads `body === before` with `usable` false and runs another round
  // rather than crediting a convergence — so a floor that fires on a sampled fluke costs one
  // request, not the document's corrections. Both length pairs on the line, because the ratio
  // that tripped and the ratio that did not are the evidence for moving this number.
  if (destroyedBody(body, corrected)) {
    ctx.log.event("editor_shrank", {
      chars_before: body.length,
      chars_after: corrected.length,
      text_chars_before: visibleText(body).length,
      text_chars_after: visibleText(corrected).length,
      floor: EDITOR_SHRINK_FLOOR,
    });
    return { body, usable: false };
  }
  return { body: corrected, usable: true };
}

// One fidelity discrepancy the Copy Editor noticed on a page whose image it had, and was not
// asked about (issue #183).
export interface FidelityObservation {
  // The source page it is on, or null when the reply named none — which is not the same
  // thing as page 0, and is counted apart below for that reason.
  page: number | null;
  kind: VerifyKind | null;
  observation: string;
}

// Fidelity — does the HTML say what the page says — was checked at exactly one point in the
// pipeline, and that check's blind spots are correlated with the transcriber's by construction:
// same model family, same image, same failure modes. Neither half of the review loop could
// originate a second opinion. The Reader cannot see the source images at all and is told not to
// speculate about what it cannot see, so a dropped table row is perfectly self-consistent to it
// and a misread number contradicts nothing. The Copy Editor CAN — `imagesForIssues` hands it the
// images for the pages the Reader's issues name, which is the one position in the pipeline where
// an image and the HTML are side by side after extraction — but it was asked to fix what the
// issues named and carry everything else over unchanged, so it could be looking straight at a
// dropped row on a page it was sent to fix a heading level and have nowhere to say so (#183).
//
// So it reports them, as observations and not as edits. Reporting is the whole of the change: it
// costs no model call (the images are attached and the model is already reading them), and the
// marginal output is a sentence. Acting on one would mean re-reading that page in full, which is
// a re-extraction, and an edit made from one reading of an image reaches a reader as what the
// page says — where an observation costs a person a look.
//
// What it is NOT is a rate. The pages the editor sees are the pages the Reader flagged for some
// other reason, which is not a sample of the document — it skews toward pages that already had
// problems, and a document the Reader found nothing wrong with attaches no images at all. So it
// is evidence that misses exist and roughly where, and the calibration issue (#180) and a
// sampled second opinion (#183's second proposal, which does cost calls) are what could turn it
// into a number.
//
// Nothing is dropped for being unreadable, the same rule `readProblems` follows one file over:
// an entry with no recognizable prose key is stringified rather than discarded, because a lost
// label costs a label and a lost observation costs whatever it was about. `unattached` and
// `unplaced` are counted apart from each other and reported beside the total, because an
// observation about a page whose image was not attached is a guess about a page the editor could
// not see — the prompt says to report only attached pages — and one that names no page cannot be
// checked at all. Both are still logged: a reader who wants only the checkable ones can subtract.
export function readFidelityObserved(
  raw: unknown,
  attached: number[],
): { observations: FidelityObservation[]; unattached: number; unplaced: number } {
  if (!Array.isArray(raw)) return { observations: [], unattached: 0, unplaced: 0 };
  const observations: FidelityObservation[] = [];
  let unattached = 0;
  let unplaced = 0;
  for (const entry of raw) {
    if (entry === null || entry === undefined) continue;
    let text: string;
    let page: number | null = null;
    let kind: VerifyKind | null = null;
    if (typeof entry === "string") {
      text = entry;
    } else if (typeof entry === "object") {
      const rec = entry as Record<string, unknown>;
      const prose = [rec.observation, rec.problem, rec.text, rec.description].find(
        (v) => typeof v === "string" && v.trim(),
      );
      text = typeof prose === "string" ? prose : JSON.stringify(entry);
      // A page number, however the reply wrote it: `page: 7`, `page: "7"`, or the `pages` list
      // the Reader's own issues use — the editor is given those issues and echoing their shape
      // is the likelier mistake than inventing a third one. Only a whole positive number is a
      // page; anything else is left unplaced rather than rounded into a page that exists.
      const named = rec.page ?? (Array.isArray(rec.pages) ? rec.pages[0] : undefined);
      const n = typeof named === "number" ? named : typeof named === "string" ? Number(named.trim()) : NaN;
      if (Number.isInteger(n) && n > 0) page = n;
      const label = typeof rec.kind === "string" ? rec.kind.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
      kind = VERIFY_KINDS.find((k) => k === label) ?? null;
    } else {
      text = String(entry);
    }
    if (!text.trim()) continue;
    observations.push({ page, kind, observation: text.trim() });
    if (page === null) unplaced += 1;
    else if (!attached.includes(page)) unattached += 1;
  }
  return { observations, unattached, unplaced };
}

// Logged only when there is something to say, so an ordinary round's log is unchanged — and the
// pages the editor HAD are on the line too, because an observation is only as good as whether
// its page was in front of the model, and `editor_images` is a separate line that a reader of
// this one may not have. Section calls carry no images (see `editorSectionCall`), so there is
// nothing for them to observe and they do not read this field.
function logFidelityObserved(ctx: PipelineContext, raw: unknown, selected: InputImage[]): void {
  const attached = selected.map((i) => i.order);
  const { observations, unattached, unplaced } = readFidelityObserved(raw, attached);
  if (!observations.length) return;
  ctx.log.event("editor_fidelity_observed", {
    count: observations.length,
    attached,
    ...(unattached > 0 ? { unattached } : {}),
    ...(unplaced > 0 ? { unplaced } : {}),
    observations,
  });
}

// --- a round the editor could not answer in one response ---

// How much of one response is known to fit, as a fraction of what came back when the ceiling
// was hit.
//
// Measured, not estimated, and that distinction is what makes this safe to do at all.
// `TruncatedResponseError.chars` is how many characters THIS model produced for THIS document
// before it ran out of ceiling, so it prices this document's HTML in characters per token
// without anyone having to guess at a ratio — and the guess is the thing PRD §7.11 v1.3 rules out,
// because measured characters per token vary enough between documents that a wrong one skips
// corrections the editor would have made. Nothing here is computed until the ceiling has
// actually been reached, which is why this is a measurement and not a pre-flight estimate.
//
// Half of it, so a corrected section has room to come back longer than it went in: a correction
// adds characters (a `<th>`, a caption, a heading gaining the words that tell it from its twin)
// and the budget is applied to the section's ORIGINAL text. The same factor absorbs the
// difference in the other direction — `chars` counts the escaped `{"html":"…"}` the model
// wrote, which is longer than the HTML inside it — so the headroom is wider than it reads.
export const SECTION_HEADROOM = 0.5;

// Under this, sectioning is declined. A budget this small would cut a document into dozens of
// pieces, each carrying the whole issue list and none of them holding enough of the document to
// be judged in context. It also means the response was cut off almost immediately, which says
// something went wrong with the call rather than that the document is long — the failure this
// exists for is a full ceiling of correct output that had nowhere left to go.
export const MIN_SECTION_BUDGET = 4_000;

// The most requests one salvaged round may make. Every section is a full text call, so this is
// the round's cost bound, and a document that needs more than this is one whose ceiling is too
// low for it by more than a factor this loop should be papering over: the deployment's remedy
// (raise `providers.<name>.max_tokens`, or lower `max_pages`) is the honest one, and
// `editor_sections_declined` names the number that says so.
export const MAX_SECTIONS = 12;

// One section, corrected. Returns null when the editor answered with nothing usable, which the
// caller keeps the original section for.
async function editorSectionCall(
  ctx: PipelineContext,
  section: string,
  issues: ReviewIssue[],
  index: number,
  of: number,
): Promise<string | null> {
  const user =
    `## Section ${index + 1} of ${of} (body content)\n${section}\n\n` +
    `## Issues found in the whole document — some are in other sections\n${issues
      .map((i) => {
        const where = i.pages?.length ? ` (page ${i.pages.join(", ")})` : "";
        return `- [${i.severity}]${where} ${i.issue} — ${i.suggested_action}`;
      })
      .join("\n")}\n\n` +
    `No source images are available. Return the corrected version of THIS SECTION only.` +
    feedbackPreamble(ctx);
  // Text-only, deliberately. The images are what made the failed whole-body call expensive and
  // they would be re-sent with every section — the same pages, several times over, on a round
  // that has already paid for one ceiling of output. What that costs is the corrections only a
  // page image can settle: a [not legible] marker stays where it is, which is what EDITOR_SYSTEM
  // tells the editor to do when the page is not attached, so the loss is bounded to the issues
  // the images were for and is the same trade `editor_images_refused` already makes.
  const res = await ctx.router.complete("copy_editor", "text", [
    { role: "system", content: EDITOR_SECTION_SYSTEM },
    { role: "user", content: user },
  ]);
  ctx.log.agentCall({
    agent: {
      name: "copy_editor",
      file: "copy_editor.md",
      content: EDITOR_SECTION_SYSTEM,
      capabilities: ["text"],
      sha: null,
      sessionBuilt: false,
    },
    phase: "review",
    output: res.text,
  });
  const corrected = extractJson<{ html?: string }>(res.text)?.html?.trim();
  if (!corrected) {
    ctx.log.event("editor_section_failed", { section: index + 1, of, reason: "no_output", chars: res.text.length });
    return null;
  }
  // #174's floor at the other unit. The same reply shapes reach here — this prompt asks for one
  // section and a model that answers with a sentence about it, or with the first paragraph of it,
  // produces markup that parses — and the same containment already exists for them: a section that
  // came back unusable keeps the text it went in with (`joinSections`), so this costs that
  // section's corrections rather than the document's.
  //
  // Same number as the whole-body path, and the sectioned rounds are part of what places it: 13
  // section calls across three rounds, every one of them answered, and the joined bodies land at
  // 0.998–1.006 of their input. A section that had returned under half its own prose would have
  // moved a five-section join by a tenth, and none of them moved by more than 0.6%.
  if (destroyedBody(section, corrected)) {
    ctx.log.event("editor_section_failed", {
      section: index + 1,
      of,
      reason: "shrank",
      chars_before: section.length,
      chars_after: corrected.length,
      text_chars_before: visibleText(section).length,
      text_chars_after: visibleText(corrected).length,
      floor: EDITOR_SHRINK_FLOOR,
    });
    return null;
  }
  return corrected;
}

// The round again, a section at a time, after the whole-document answer did not fit.
//
// Why this exists: the editor is asked to return the complete corrected body, so the length of
// its answer follows the length of the DOCUMENT rather than the number of things wrong with it,
// and a 25-page document is longer than one response may be. Under a fixed ceiling that scales
// the wrong way — the bigger the document, the more certain it is that its corrections cannot be
// applied, which is the opposite of where corrections matter most. Two documents of four in one
// bench round were delivered whole and uncorrected for exactly this reason (issue #165). Cutting
// the body at top-level boundaries makes the response length a property of the SECTION instead,
// and a section's size is something this code chooses.
//
// What it costs, honestly: one text call per section, on a round that has already paid for a
// full ceiling of output it could not use. That is roughly one more body's worth of output for
// the document, and it buys corrections where the alternative buys none. What it loses is the
// corrections that need the whole document in view at once — deduplicating content that appears
// on two pages, resolving a heading whose twin is in another section — and the editor is told
// exactly that (EDITOR_SECTION_SYSTEM), because a section that guesses at what is outside it can
// delete the only copy of something. Those issues stay unresolved and are reported as such,
// which is where they already were.
//
// Returns null when nothing was attempted or nothing came back, and the caller then behaves as
// it did before this existed. Every decline is logged with the reason: a round that quietly
// declines to try is indistinguishable in a log from one that tried and failed.
async function correctBySection(
  ctx: PipelineContext,
  body: string,
  issues: ReviewIssue[],
  e: unknown,
): Promise<{ body: string; of: number; corrected: number } | null> {
  // No measurement, no budget. `chars` is on the error Iris raised, which is every truncation
  // except one that lost its prototype at some boundary (see `isTruncatedResponseError`), and
  // inventing a budget for that case would be the pre-flight guess this deliberately is not.
  if (!(e instanceof TruncatedResponseError) || !Number.isFinite(e.chars)) {
    ctx.log.event("editor_sections_declined", { reason: "unmeasured" });
    return null;
  }
  const budget = Math.floor(e.chars * SECTION_HEADROOM);
  if (budget < MIN_SECTION_BUDGET) {
    ctx.log.event("editor_sections_declined", { reason: "budget_too_small", budget, chars: e.chars });
    return null;
  }
  // A budget that already covers the whole body says the response was longer than the document
  // it was correcting, so the sections would be one section: the same request, at the same
  // length, to the same ceiling. That is a reply that ran away with itself — a repetition, a
  // preamble that never ended — and not a document too long to answer, so it is reported as
  // what it is rather than as a body that could not be cut. Reachable, on a short document
  // whose editor call returned more than twice its characters.
  if (budget >= body.length) {
    ctx.log.event("editor_sections_declined", {
      reason: "budget_exceeds_body",
      budget,
      chars: e.chars,
      body: body.length,
    });
    return null;
  }
  const sections = splitSections(body, budget);
  // One section is the body itself: a document with no top-level boundary under the budget —
  // one enormous table, say — cannot be cut, and asking for it again in one piece would hit the
  // same ceiling. This is the case a section-size bound genuinely does not solve, and it is
  // reported rather than retried.
  if (sections.length < 2) {
    ctx.log.event("editor_sections_declined", { reason: "indivisible", budget, chars: body.length });
    return null;
  }
  if (sections.length > MAX_SECTIONS) {
    ctx.log.event("editor_sections_declined", {
      reason: "too_many_sections",
      sections: sections.length,
      max: MAX_SECTIONS,
      budget,
      chars: body.length,
    });
    return null;
  }
  // Concurrent, bounded by the same knob as page extraction and the Reader's chunks: these are
  // independent calls over disjoint slices of a body nothing mutates while they run, and the
  // operator's answer to "how many model calls may one run have in flight" is the answer here
  // too. `|| 1` for a directly-constructed context that never set it (tests, embedders).
  const limit = Math.max(1, Math.floor(ctx.extractionConcurrency) || 1);
  ctx.log.event("editor_sections", {
    sections: sections.length,
    budget,
    chars: body.length,
    concurrency: limit,
  });
  const corrected = await mapWithConcurrency(sections, limit, async (section, i) => {
    try {
      return await editorSectionCall(ctx, section.html, issues, i, sections.length);
    } catch (err) {
      // Per-section containment, and only for the two failures that are about the size of one
      // request or one response: a section that cannot be returned costs that section, and its
      // original text is what goes back into the document (`joinSections`). Anything else — a
      // stall, a stream error, a bad key — is a deployment that is not working, and swallowing
      // it here would deliver a partly corrected document while reporting nothing wrong.
      if (!isTruncatedResponseError(err) && !isRequestTooLargeError(err)) throw err;
      ctx.log.event("editor_section_failed", {
        section: i + 1,
        of: sections.length,
        reason: isTruncatedResponseError(err) ? "truncated" : "too_large",
        ...truncation(err),
      });
      return null;
    }
  });
  const kept = corrected.filter((c) => c !== null).length;
  return { body: joinSections(sections, corrected), of: sections.length, corrected: kept };
}

// The truncated round's result, with whatever the section calls rescued. Shared by both
// truncation paths in `runEditor` — the first call and the images-refused retry — because the
// remedy for a response that did not fit is the same whatever the request that produced it
// looked like.
async function sectionRound(
  ctx: PipelineContext,
  body: string,
  issues: ReviewIssue[],
  e: unknown,
): Promise<EditorRound> {
  const sectioned = await correctBySection(ctx, body, issues, e);
  // Nothing to use: either the round could not be divided at all, or it was and no section came
  // back. Both are the state this feature started in — the body that entered the round is the
  // body that leaves it — and both are reported as that, WITHOUT `sections`. `sections` is what
  // tells the delivered document it carries corrections made a piece at a time, and a round
  // that rescued nothing carries none; the `editor_sections` and `editor_section_failed` lines
  // are where a log reader sees that the attempt was made.
  if (!sectioned || sectioned.corrected === 0) return { body, usable: false, truncated: true };
  return {
    body: sectioned.body,
    // `usable` is about whether the editor SAID anything, and a section it answered is the
    // editor having answered.
    usable: true,
    truncated: true,
    sections: { of: sectioned.of, corrected: sectioned.corrected },
  };
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
  // The last read's answer about how much of the document it did not answer about, and out
  // of how many windows (see ReaderRead). The LAST read, like `lastIssues`, because what
  // ships is one reading of the document: an earlier round's unreadable window says nothing
  // about the body that is being delivered, which a later round re-read in full.
  let lastUnread = 0;
  let lastWindows = 0;
  let droppedLinks = 0;
  let editorTruncated = false;
  let editorTruncatedLost = false;
  // What the truncated round's section calls rescued, when there was one: the difference
  // between "this document was not corrected" and "it was corrected a piece at a time, and the
  // pieces could not see each other". The document says it in those terms and the store says it
  // as a boolean (`editorTruncatedLost`), because a rate over documents cannot use "3 of 4" —
  // but it is the same fact and this local is where both readings are taken from.
  let editorSections: { of: number; corrected: number } | undefined;
  // The page index is built from the fragments as they entered review. Pages are
  // deliberately NOT re-indexed as the editor rewrites the body: the index exists
  // to attribute content to a SOURCE page, and the source doesn't change.
  const pages = initial.pages ?? [];
  // Re-stated in the wrapper at the end, and — since #188 — given to the Reader as well. The
  // review loop cannot fix a page that was never extracted, and must not be asked to: the
  // Reader would raise "this page is missing" every round against a body no editor can
  // repair, spending the whole iteration budget on it. See wrapDocument.
  //
  // "Must not be asked to" was the intent all along; for a while it was only the disclosure that
  // was kept out of the editor's reach, and the question went to the Reader unchanged — once per
  // chunk, per round, so a longer document raised the same lost page more times. `runReader` is
  // where that is now said (noContentPages), which is also the only place that can say it: the
  // index it builds is the route the reports came in by.
  const failedPages = initial.failedPages ?? [];

  while (iterations <= ctx.maxReviewIterations) {
    const read = await runReader(ctx, body, lint, pages, iterations, failedPages);
    const issues = read.issues;
    lastIssues = issues;
    lastUnread = read.unread;
    lastWindows = read.windows;
    // `unread` only when there is any, so an ordinary round's line is the one it always was.
    ctx.log.event("reader", {
      iteration: iterations,
      issues: issues.length,
      ...(read.unread ? { unread: read.unread, windows: read.windows } : {}),
    });
    // Clean, and only on a read that was clean AND answered. A read with an unreadable
    // window has no verdict on that window — see ReviewResult.unreviewedWindows — and this
    // is the return that says the document was reviewed and found to need nothing, which is
    // the claim the deployment's public clean rate is made of (#186).
    if (issues.length === 0 && read.unread === 0) {
      return {
        // `editorTruncated` is false on this path today, because a truncated round breaks
        // out of the loop instead of reaching another Reader pass. It is passed anyway:
        // the one thing this feature must not do is report a truncation to the store while
        // handing the user a document that does not say so, and a later change that lets
        // the loop continue past a truncation would otherwise create exactly that
        // disagreement here, in the return that looks like the clean one.
        //
        // `lintUnavailable` matters most on THIS return, which is the one that means "the
        // Reader looked again and found nothing left". That verdict is the Reader's alone
        // when the linter could not run, and a document that says so is the difference
        // between a clean document and an unchecked one (#164).
        html: wrapDocument(body, { failedPages, editorTruncated, editorSections, lintUnavailable: lint.error }),
        body,
        iterationsCompleted: iterations,
        unresolved: [],
        lint,
        droppedLinks,
        editorTruncated,
        editorTruncatedLost,
        // 0 by the guard above. Passed rather than written as a literal for the same reason
        // `editorTruncated` is: the field's value is the loop's, and a return that states it
        // itself is a place where the two can come apart.
        unreviewedWindows: lastUnread,
      };
    }
    // Nothing to correct and no verdict either — the read came back empty because part of it
    // could not be read, not because the document is right. There is nothing to hand an
    // editor (inventing an issue to fix would be worse than the silence), so the loop ends
    // here and the document is delivered saying what happened, with `unresolved` empty
    // because nothing was found rather than because nothing is there.
    if (issues.length === 0) break;
    if (iterations === ctx.maxReviewIterations) break; // cap reached, issues remain

    iterations++;
    const before = body;
    const round = await runEditor(ctx, body, issues);
    // The round could not be answered as one response, and the next one would make the same
    // request against the same body — the response length follows the length of the document,
    // not the number of issues in it. So this is the loop's last round however it turned out:
    // another Reader pass and another ceiling of output would only learn the same thing. See
    // runEditor for why the whole-body call is not retried and not fatal, and
    // `correctBySection` for what is asked instead.
    //
    // Read before `body` is taken from the round, and before the two exits below, because both
    // of those would read this round as something it is not. A round that came back with
    // nothing leaves `body === before`, as a converged round does — but a converged round is
    // one the editor ANSWERED and would answer the same way again, which is why it stops the
    // loop with rounds to spare and nothing to disclose; and `usable` is false here, which is
    // the state the loop otherwise treats as a retryable non-answer. A truncation is neither:
    // it is the one outcome that says this document cannot be corrected at this length at all.
    const lastRound = round.truncated;
    if (round.truncated) {
      // The ceiling was hit, whatever was rescued afterwards. This is what the store counts
      // and what the document discloses, because the remedy is the deployment's either way:
      // `providers.<name>.max_tokens` is too low for the documents it accepts, or `max_pages`
      // is too high for that ceiling.
      editorTruncated = true;
      editorSections = round.sections;
      // And whether it cost the document anything, which is the half of this a threshold can
      // be put on. `sections` absent is a round given up on entirely — declined, or every
      // section failed (`sectionRound`) — and `corrected` short of `of` is a section that kept
      // the text it went in with. Either way those issues are in the delivered document
      // uncorrected and this is the last round, so nothing looks for them again.
      editorTruncatedLost = !round.sections || round.sections.corrected < round.sections.of;
      // Nothing came back from the section calls either — or there were none to make — so the
      // round ends where it used to: the body that entered it is delivered with that round's
      // issues unresolved. It still counts as a round; it was made and paid for, a full
      // ceiling of output at that, so `iterationsCompleted` reporting it is the honest
      // arithmetic and the `editor_truncated` line beside it is what says it changed nothing.
      if (!round.usable) break;
    }
    body = round.body;
    // A deprecated role the editor introduced is dropped on the way in, the same way assembly
    // drops one extraction introduced (roles.ts, issue #187). Both ends are needed and for
    // different reasons: assembly cannot see a rewrite that has not happened yet, and this
    // loop is where #187's role actually survived — the Copy Editor was told the rule failed,
    // rewrote five sections, and left it. Ahead of `changed`, the re-lint and the marker diff
    // below, so every one of them is about the body that will ship rather than about a
    // predecessor of it, and ahead of the `body === before` comparisons so a round whose only
    // effect was a role this strips is not credited as a change. A round that introduced none
    // leaves the string untouched.
    const roles = stripDeprecatedRoles(body);
    if (roles.nodes > 0) {
      body = roles.html;
      ctx.log.event("deprecated_roles_stripped", {
        stage: "correction_round",
        iteration: iterations,
        roles: [...new Set(roles.stripped)].sort(),
        nodes: roles.nodes,
      });
    }
    // A `<main>` the editor introduced, dropped here for the same reason and at the same point
    // (landmarks.ts, issue #251). This end is not redundant with assembly's: EDITOR_SYSTEM asks
    // for "the FULL body" and never mentions the shell, so a round that retypes the whole
    // document is a fresh chance to write one — and on the section path each call is handed a
    // piece of the document, which is exactly the prompt under which a model reaches for a
    // wrapper to stand for what it was given. Ahead of `changed` and the re-lint, so a round
    // whose only effect was a `<main>` this removes is not credited as a change.
    const mains = stripNestedMain(body);
    if (mains.unwrapped > 0 || mains.downgraded > 0 || mains.dropped > 0 || mains.declined > 0) {
      body = mains.html;
      ctx.log.event("page_main_stripped", {
        stage: "correction_round",
        iteration: iterations,
        unwrapped: mains.unwrapped,
        downgraded: mains.downgraded,
        dropped: mains.dropped,
        declined: mains.declined,
      });
    }
    // `sections` on this line is how a run log tells a round that was answered whole from one
    // answered piece by piece — and `corrected` from `of` says how much of the document the
    // second kind actually reached, since a section that truncated in its turn kept its
    // original text.
    //
    // The four sizes are what #174 asked for, and the reason is that a successful whole-body
    // replacement used to destroy the only copy of its own input: `parsed.html` is adopted for the
    // body verbatim, so once the round has run, the body that went in is gone and the ratio it
    // moved by is unrecoverable from the log. That left the size distribution of a legitimate
    // review round measurable only on the rounds that FAILED — where the delivered body is still
    // the body that entered — which is n=3 across four bench rounds, all three of them
    // `editor_no_output`. #174's whole point is that a floor on the whole-body path cannot be
    // given a number off three samples, and this is what turns three into one per round.
    //
    // Both length pairs, because a length cannot answer the question a floor is asked, which is whether a
    // round lost CONTENT or lost wrappers. `chars_*` is the whole fragment and `text_chars_*` is
    // what a reader receives; markup-only work leaves the second pair equal and moves the first, and
    // a round that deleted a paragraph moves both. That is the same argument, and the same two
    // readings, that #166 needed on `page_corrected` — so a round and a page correction can be read
    // against each other, which is why `visibleText` is shared rather than reimplemented.
    //
    // Note what the three measured rounds do NOT establish, and what quantity they are. Their
    // 0.982–0.984 span is the REPLY against the body that went in, reconstructed off `agent_call`,
    // and this line reports the DELIVERED body against it — which for those same three rounds is
    // 1.000, because a reply with nothing usable in it is a body handed back untouched. Same
    // caveat as the `sections` one below: read as one population, a fresh 1.000 here and a
    // published 0.982 there are the same round measured two ways. What the three do show beyond
    // length is their structure counts moving (0.714–1.333, one round dropping 5 of 7 lists and 13
    // of 47 list items while its length moved 1.6%), so the evidence for a second signal is
    // evidence for a STRUCTURE count — which is why `structure_before`/`structure_after` are on this
    // line as well.
    //
    // The next round settled which of them a floor reads, and it was not the structure counts: see
    // `EDITOR_SHRINK_FLOOR`, placed on `text_chars_*` because the whole-body round in `runs-231`
    // moved `terms` from 55 to 3 while moving its prose 0.3%. The direction of the evidence above
    // is what that confirmed — the structure counts are the LESS stable number, moving in both
    // directions on rounds that were doing their job — and the conclusion is that a floor on them
    // catches nothing a useful threshold could survive. All three readings stay on this line
    // regardless: two of them are now what a person reads when the third has fired.
    // The `text_chars_*` corpus for a review round is four rounds deep and starts here: 0.997 on
    // the round answered whole, 0.998 / 1.006 / 1.001 on the three answered section by section.
    // Note it is not the same quantity as the published page span — 0.62–2.32 over 265 page
    // corrections is RAW length, delivered against given — so the two cannot be read as one band,
    // and the review floor is set off these four rather than off that one.
    //
    // Measured on the body, which is the `<main>` content: the wrapper and the markers after
    // `</main>` are added downstream and are not what any round returned. Taken AFTER the role
    // strip above for the same reason `changed` is — this is the body that will ship. And a
    // sectioned round's pair is the whole body either way, so `sections` on this line is what
    // separates the two populations: a section reply is 0.016–0.379 of the body it belongs to,
    // because it IS one section, and anything reading these numbers as one distribution would
    // read every sectioned round as a catastrophe.
    ctx.log.event("editor", {
      iteration: iterations,
      changed: body !== before,
      chars_before: before.length,
      chars_after: body.length,
      text_chars_before: visibleText(before).length,
      text_chars_after: visibleText(body).length,
      // The third reading, and the one the three measured rounds actually moved (see
      // `structureCounts`): a length pair cannot tell a round that deleted a list from a round
      // that unwrapped one, and both pairs above answer in characters. Full counts rather than
      // only what changed, because a ratio needs its denominator — the question a threshold is
      // chosen against is "how much of the structure is left", not "did any of it move", and the
      // second question is already answered by `changed` on this same line.
      structure_before: structureCounts(before),
      structure_after: structureCounts(body),
      ...(round.sections ? { sections: round.sections.of, corrected: round.sections.corrected } : {}),
    });

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
    //
    // And not for a round that was answered section by section, even when every section came
    // back as it went in. `review_converged` claims the editor read the whole document and
    // decided it was better left alone, with rounds to spare — here it was never shown the
    // whole document, and there are no rounds to spare because the next one would truncate
    // before any section call was made. Those are different facts and the log must not
    // conflate them; `editor_truncated` beside `editor` is what this round has to say.
    if (round.usable && body === before && !lastRound) {
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
    if (body === before) {
      if (lastRound) break;
      continue;
    }

    lint = await runAxe(wrapDocument(body));
    // The re-lint is the gate on the document that actually ships — the `assembly` event
    // reports the lint of the body BEFORE any correction round — and until now a failure
    // here was logged nowhere at all: the editor could introduce the very attribute that
    // breaks the selector engine (see runAxe) and the only trace would be one signal in
    // the quality table. Logged with the same fields as `assembly`, so both failures read
    // the same way in a run log, and per iteration, because which round broke it is the
    // question a person reading this asks next.
    if (lint.error) {
      ctx.log.event("lint_unavailable", { stage: "correction_round", iteration: iterations, ...lintErrorFields(lint) });
    }
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
    // Last, so a round that was answered a section at a time is measured like any other — its
    // lint, its dropped links, its markers — before the loop ends on it. Those checks are
    // about the difference between two bodies and this round made one; ending the loop above
    // them would deliver a corrected document with none of them recorded, which is precisely
    // the disclosure the section calls make more likely (each one sees less of the document
    // than a whole-body round does).
    if (lastRound) break;
  }

  // Issues remain and the loop has stopped — at the cap, on a round that changed nothing,
  // or on a round whose response hit the output ceiling (§7.11). All three record them as
  // a comment, with the source page reference the Reader attributed (§7.8) so a human can
  // find them; the third also states itself in the document, because "the editor tried and
  // could not fix these" and "no editor pass ever worked on these" are different facts.
  //
  // On the third, these are the issues the Reader raised BEFORE the section calls ran, and
  // some of them may since have been fixed — nothing re-read the document, because the round
  // that would have done so is the one that could not be made. Over-reporting is the
  // conservative direction and the same one the converged break takes: the list says what is
  // known to have been found, the `@editor-truncated` comment says it was not re-checked, and
  // an issue reported as unresolved that was quietly fixed costs a reader a second look, while
  // the reverse costs them the belief that the document was finished.
  const unresolvedLines = lastIssues.map(
    (i) => `${i.issue} (severity: ${i.severity}${i.pages?.length ? `, page ${i.pages.join(", ")}` : ""})`,
  );
  return {
    html: wrapDocument(body, {
      unresolved: unresolvedLines,
      failedPages,
      editorTruncated,
      editorSections,
      lintUnavailable: lint.error,
      // Said in the document whether or not `unresolved` is empty, because it changes how
      // that list is to be read either way: an empty one is not a clean bill of health, and
      // a non-empty one may be missing whatever the unread windows held.
      ...(lastUnread ? { reviewUnread: { windows: lastUnread, of: lastWindows } } : {}),
    }),
    body,
    iterationsCompleted: iterations,
    unresolved: lastIssues,
    lint,
    droppedLinks,
    editorTruncated,
    editorTruncatedLost,
    unreviewedWindows: lastUnread,
  };
}
