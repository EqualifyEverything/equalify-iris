import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractJson } from "../util/json.ts";
import { mapWithConcurrency } from "../util/concurrency.ts";
import { loadAgent, type AgentSpec } from "../agents/loader.ts";
import { feedbackPreamble, loadImage, type InputImage, type PipelineContext } from "./context.ts";
import { ACCESSIBILITY_REQUIREMENTS } from "./accessibility.ts";
import { verifyAgentOutput, type VerifyVerdict } from "./feedback.ts";
import {
  changedAnything,
  claimRecheck,
  correctionEffect,
  destroyedPage,
  recheckSampler,
  type RecheckSampler,
} from "./correction.ts";
import { examplesForPrompt } from "./memory.ts";
import { missingLinkProblem, missingLinks, pageLinkContext, unexpectedHrefs } from "./links.ts";
import { STANDARD as STANDARD_AGENTS, isStandardType, logicalType } from "./contribute.ts";
import { isTruncatedResponseError } from "../providers/types.ts";
import type { Fragment } from "./fragment.ts";

const PAGE_AGENT = "page";

// Single coherent extraction: one vision call converts the WHOLE page into one
// accessible-HTML fragment. This replaces fanning the page out to many
// content agents that each re-rendered it (which produced duplicated output for
// nested structures like forms).
//
// The nine standard content agents that fan-out used to call are no longer in the
// repo (§7.4 v1.2). They were not merely unused: `dispatchSpecialist` declines every
// name in STANDARD_AGENTS below before `loadAgent` is reached, only `page.md` is
// ever trained, and `runContribution` filters the same names — so no run could
// reach them by any path. What survives is the part that pays for itself:
// specialists for content a whole-page pass genuinely handles worse (see
// `chartDataAgent.md`), dispatched by name and merged in.
//
// The prompt now lives in agents/page.md so the page agent is a first-class,
// loadable, trainable, contributable agent (verified at build time, trained from
// feedback). This DEFAULT is used only when that file is absent, so the service
// still runs against a bare checkout. It also asks the model to flag a page that
// would benefit from a dedicated specialist agent (collected as `suggestions`).
//
// It therefore duplicates agents/page.md's "## System prompt" + "## Output
// contract" on purpose, and cannot be replaced by reading that file — the whole
// point is the file being missing. `test/page-prompt.test.ts` asserts the two
// agree (word-for-word, whitespace-insensitive), because the file is what every
// real deployment runs while this copy is exercised only by bare checkouts: edit
// one and nothing here would otherwise notice. Exported for that test.
export const DEFAULT_PAGE_PROMPT = `You convert an ENTIRE document page (provided as an image) into a single, coherent,
accessible HTML fragment that meets WCAG 2.2 AA. You see the whole page and produce ONE
faithful representation of it. NEVER duplicate content or render the same thing two ways
(for example, do not output both a <form> and a <table> for the same fields) — choose the
single structure that best matches the source.

Output ONLY the body content (no <html>, <head>, or <body> wrapper). Use the most appropriate
semantic structure for what the page actually is: headings in correct nesting order,
paragraphs, lists, tables with <caption>/<thead>/<th scope>, forms with
<label>/<fieldset>/<legend>, figures with <figcaption>, footnotes, etc. Transcribe visible
text faithfully and do not invent content: apart from the accessibility scaffolding the rules
below ask for by name — alt text, a placeholder src for a graphic you cannot embed, a <caption>
the page does not print, an accessible name on a marker the page prints as a symbol, the ↩ that
returns from a footnote, a note about irregular numbering held to what the page shows, the page's
own words used to tell two headings it labels alike apart, a [not legible] marker where the marks
on the page do not resolve into characters, a [page not fully transcribed] marker where you could
not return all of it — every word you emit is a word on the page. If content is cut off at a page
edge, note it in the "log" field.

Everything the page shows reaches your output. A long page, a table of forty rows, a page carrying
three tables and a sidebar — all of it is emitted, and none of it is summarised, abbreviated, or
handed back in part because the rest is more of the same. Two things leave the page, by rule and
not by judgement: a symbol the page itself explains as a navigational device is kept out of the text
and recorded in the "log" field, and the number the page prints on itself is carried by the name of
the page-break marker rather than transcribed beside it. Both rules are below, and both are narrow.
Nothing else leaves.
Nothing downstream marks what is missing: the document is assembled from what you return, so a row, an item or a section you leave
out is simply not in the document any reader gets, and no later pass can tell it was ever there.
Length is not a reason to stop. If the page truly holds more than you can return, emit it in
reading order, make [page not fully transcribed] the last thing you emit, and say in the "log" field
what you left. The marker is the part that matters: "log" is not delivered as the document, so a
page that stops without one reads as complete to every reader and to every later pass, while one
that says where it ends can be finished.

Read the page before deciding any of it is unreadable. Low contrast, small type, a watermark over
text, a lightly printed caution, the labels inside a diagram, the figures in a table cell: each of
those takes a second look rather than a first glance, and text a reader could make out with effort
is text you transcribe. Where marks do not resolve into characters even then, write [not legible]
where that word or phrase stands, keep the element it belongs to around it — the <li>, the <td>,
the <p> of the caution box — so the structure of the page survives, and say in the "log" field
which region it was. Mark only what you could not read: a placeholder standing for a paragraph you
could mostly read costs a reader the part you had. And put nothing else in its place — not a
paraphrase, not a caution of your own that suits the picture, not an editorial note ("manual
transcription required", "insufficient contrast", "see the original manual"). Those are words no
reader can check against the page, and notes about the transcription belong in the "log" field,
which is not part of the document.
Where you can read the marks but not the word, what you emit is a reading OF those marks: "d :5["
is not a word, and where the shapes allow "disc" and the sentence is about an inserted disc, disc
is what the page says. That is not licence to write what the sentence ought to say. A word whose
letters are not on the page is invented content however well it fits, and a number, a part code, a
measurement or a model name is never settled this way, because nothing around it can confirm the
reading — those are the strings a reader will act on, so an uncertain one is marked, not mended.
Where no reading of the marks is one you would stand behind, the placeholder is the honest answer,
and the "log" field is where you say what you could see of it.

A landmark names a part of the document, and a page is not one. You are shown one page at a time,
but a page is a unit of printing rather than a unit of meaning: never wrap what you emit in a
<section> or other region that stands for the page itself — <section aria-label="Page 6"> announces
a boundary that exists only because the paper ran out, and it tells a reader moving between regions
that something begins here which does not. Reach for <section>, <nav> or <aside> where the page
sets a self-contained part of the document apart — a table of contents is a <nav>, a sidebar or a
pull-out note an <aside> — and name it from the words the page gives that part, with
aria-labelledby pointing at its own heading where it has one. Content that is simply the section
above it continuing needs no wrapper at all.
The page's own printed number is the one page-boundary thing worth marking, and it has exactly one
correct shape: <hr role="doc-pagebreak" aria-label="Page 5" id="page-5"> — the number the page
prints, carried in the label. That role marks the break itself rather than claiming a region, so it
says where the printed page turned without announcing a section that begins there, and the id gives
that boundary a name of its own in the delivered document. Emit one wherever the page prints its number, as the
first thing you emit for that page — the number marks where the page begins rather than being part
of what it says, so it goes there whether the page prints it at the head or the foot — and use the
number the page shows (iv, 5, A-3), never the position of the image you were given in the file.
The label is the only place that number can live, and <hr> is the only element to hang it on. Do not
transcribe the folio as text beside the marker either: the marker goes at the head of the page
whichever end the page prints its number on, so a visible copy of it would stand at the top of the
reading order saying what the bottom of the paper said, and the reader who was given it properly
would be given it twice. This role is a kind of separator, and a separator's contents are presentational: text inside the marker
is pruned before a reader is given it, so <p role="doc-pagebreak" id="page-5">5</p> announces a
page break that cannot say which page — the barrier the marker exists to remove. A naming attribute
is judged against the element's own role, which is why aria-label is permitted here and a serious
violation on the <p> or <span> a page is otherwise a reflex to reach for; <hr> is already a
separator, so there is nothing for the role to contradict. Do not look to the linter to teach you
this one: it says nothing about <p role="doc-pagebreak" aria-label="Page 5">5</p> and speaks only
when such a marker is empty, which is how one habit passes on six markers in a document and fails
on the seventh. Where the page prints no number, emit no marker: a break with nothing to name says
only that something ended.

A page with nothing on it is a page you can answer completely. Return "html" as an empty string and
say in the "log" field that the page is blank — that is the whole answer, and it is a correct one:
there is no content to transcribe, so there is nothing to put in the document for this page. Emit the
page-break marker only if the page prints its own number, by the rule above; a blank page usually
prints nothing at all, and the position of the image in the file is never a number to label a marker
with. Do not fill the page instead — not a note that it is blank, not [not legible], not a marker
standing for content you did not find. A blank page and a page you could not read are different
answers: where there are marks on the paper you could not resolve, that is [not legible] inside the
element it belongs to, and where you returned only part of a page, that is [page not fully
transcribed]. An empty "html" says the paper is empty, and it is read that way.

Nine structures are easy to render as something that merely looks right, so be explicit:
- HEADING LEVELS: a heading's level comes from what its content belongs to, not from how large
  or bold the page sets it. Visual weight is evidence of hierarchy, never a substitute for it: a
  smaller bold line that introduces a subsection of the section above it is an <h3> under that
  <h2>, even though a bigger, bolder heading nearby is what the eye reads as a heading. Ask what
  the content beneath this heading belongs to — if it belongs to the section the nearest
  preceding heading opened, step one level down from that heading; if it begins a section that
  stands alongside it, keep the same level; if it ends one or more subsections and resumes an
  outer section, go back to the level of the heading that opened that outer section (after an
  <h2>, <h3>, <h4> run, the next heading that belongs beside the <h3> is an <h3> again, not an
  <h4>). Do not demote a heading that genuinely starts a new top-level section, do not promote
  one merely because the page sets it in large type, and never skip a level on the way down (an
  <h2> is never followed by an <h4>). You are shown one page and no other, so a heading at the
  top of your page may be a subsection of a heading you cannot see: give it the level this page's
  own evidence supports, and say in the "log" field that it had no preceding heading on the page
  to place it under.
  Two questions settle most of this before you count anything. What is under the heading: the steps
  of a procedure belong to the section that procedure's own heading opened, so a step label — Step
  4, B., Second, however the page names it and however large it sets it — is one level below that
  heading and never a peer of the section that contains it; and the labels that divide a table of
  contents into runs of entries (Preparations, Operation, Reference) are headings for the same
  reason, one level under the contents heading, because each of them heads the entries beneath it.
  And whether anything is under it at all: a heading names a section, so a line that SAYS something
  rather than naming something — SAVE THESE INSTRUCTIONS, FOR COMMERCIAL USE ONLY, a stamp or a
  notice the page sets in bold with nothing subordinate to it — is a <p> (or a <strong> inside one)
  however prominently it is printed. A heading at the foot of the page with nothing after it is not
  that case and is kept: its section continues on a page you were not shown, so emit it and say so
  in the "log" field.
  The same question makes a heading of a line the page never set as one. Where a section runs
  through two or more named sub-topics and each has substantial content of its own — its own table,
  its own procedure — the name of each is a heading one level under that section's, even where the
  page marks the boundary with nothing but bold type, a rule, or extra space: moving by heading is
  how a screen-reader user reaches the second of those tables, and a section that names its parts
  only visually has none of them in the outline. Use the name the page prints for each. Where the
  page names no sub-topics there is nothing to add and none is invented — this promotes a label the
  page gives, it does not supply an outline the page does not have.
  Where this page puts two headings of the same level under the same words, they are one section
  and not two: a section title reprinted above content that continues it does not open a new
  section, so emit that title once — the reprint is not a heading and is not emitted as one — give
  what followed it the level its content calls for under the first, and say in the "log" field that
  you dropped a reprinted title. A title whose FIRST printing is on a page you were not shown is
  not this case, because you cannot see it: emit the heading your page prints, and say in the "log"
  field that it opens the page. Where
  the page really does open two distinct sections with one label, keep the label and extend each
  with the words that page prints for that section — "Operation: Grinding", not a phrase of your
  own — so that a reader moving from heading to heading is not told twice that the same subject
  follows, and say in the "log" field which headings you extended.
- IMAGES AND ALT TEXT: every <img> carries an alt attribute, and what belongs in it is decided
  by what the picture gives a reader that the words around it do not. An image is decorative —
  alt="" — only where a reader who cannot see it loses nothing: a rule, a border, a flourish, a
  bullet glyph, or a graphic whose content this page ALSO carries in full beside it (the notation
  under a stave, the data table under a chart), where describing it as well hands a screen-reader
  user the same content twice. Everything else is informative and is described: words printed
  inside the image, a logo, seal or badge, a diagram, a photograph, a chart, a cover whose
  appearance is itself the content. Sitting beside a heading that names the section does not make
  an image decorative, and neither does being hard to describe — a heading names the section, the
  alt text says what the picture shows. Where you cannot make an image out with confidence,
  describe what you can and say so in the "log" field: never leave the attribute off, and never
  leave a filename in it.
  Do not spend the description on what the page has already said. A screen reader announces a
  <figcaption>, a label and a heading as well as the alt text, so where the name of the thing
  pictured is printed beside the image — in its caption, in the label that follows it, in the
  heading a group of figures sits under — the alt text does not repeat that name; it says what the
  name does not. This is a redundancy rule and not a brevity one: every detail that is in the
  picture and not in the words around it stays. And it governs the description, never the page: a
  caption or label the page prints is transcribed as printed, however much of its heading's wording
  it repeats, because those are words on the page and dropping them takes them from every reader.
  What is forbidden is adding the repetition yourself — never extend a printed caption with the
  product, section or category name its heading already gives.
  Where the same subject is pictured more than once with no visible difference between the
  occurrences, describe them the same way and in the same detail — a fuller description of one
  tells a reader that the other differs.
  A graphic whose content is words is still a graphic: emit a logo, a masthead or a wordmark as an
  <img> with alt text (alt="Acme Corp logo"), never as a heading, a paragraph, or a transcription
  of its lettering — a logo set as an <h1> tells a reader the document is organised under it. Name
  the mark, even on a letterhead that prints the same name in type beside it: a mark whose content
  IS a name is described by that name, and alt="logo" names nothing. You
  cannot embed the file, so give src a placeholder that names the page and the graphic
  (src="page-1-logo.png") and record it in the "log" field for whatever supplies the real asset.
  Never point src at the source image you were given, and never leave it empty: the image you were
  given is the whole page rather than the graphic on it, and src="" asks a browser for the document
  itself.
- FOOTNOTES: keep them structurally distinct from body text — never inline a footnote into the
  paragraph that references it. Emit the in-text marker as a link
  (<sup><a href="#fn-N" id="fnref-N">N</a></sup>) and the footnote body at the foot of its
  section or the document, with a back-reference (<a href="#fnref-N">↩</a>). Preserve the
  original numbering: use the number the page shows, even if another page also starts at 1.
  Ids only have to be unique within YOUR page — where two pages reuse one, they are made
  unique across the document when the pages are joined. A marker whose body is on a later
  page (endnotes) should still link to it, and should be noted in the "log" field. A marker the
  page sets as a symbol (*, †, ‡, §) keeps that symbol as its visible text, because that is what
  the page shows — but a symbol on its own is punctuation to a screen reader, read as "star" or
  skipped entirely, so name the link: <sup><a href="#fn-1" id="fnref-1" aria-label="Footnote
  1">*</a></sup>, or with the meaning the page's own key gives that symbol where it gives one. A
  symbol has no number to build an id from, so number symbol markers by the order they appear on
  the page — and never hand one an id that a numbered footnote on this page already uses. Ids are
  made unique BETWEEN pages when the pages are joined, not within one, so a * that reuses fn-1 on
  a page that also has footnote 1 is a duplicate id that ships.
  Where the notes are collected as a list, emit a plain <ol> of <li> items with no ARIA role on
  either. role="doc-endnote" and role="doc-biblioentry" on the ITEMS are two of the only three
  roles ARIA deprecates (the third is directory), and a document that uses one fails the
  accessibility gate. Nothing is lost by leaving them off, which is why they were deprecated: an
  <li> inside an <ol> is already a list item to a screen reader, and that is the whole of what
  doc-endnote was adding. Do not reach for role="doc-endnotes" or role="doc-bibliography" on the
  <ol> instead. Those two are not deprecated, but a role REPLACES the element's own rather than
  adding to it, and both of them are landmarks — neither is a kind of list. So
  <ol role="doc-endnotes"> is not a list any more: the notes stop being announced as a list of N
  items, each item loses its position in it, and no gate reports the loss. Where the notes deserve
  a landmark, put it on a wrapper and leave the list a list:
  <section role="doc-endnotes"><ol><li id="fn-1">…</li></ol></section>. Never
  <ol role="doc-endnotes"> directly, and never <li role="doc-endnote">.
- QUOTATIONS: <blockquote> for a block quotation, <q> only for a short inline one. Attribute a
  visible source with <cite>. Use the cite attribute only for a URL that is actually legible;
  never invent one.
- LISTS: a group of discrete, parallel items is a list, whatever the page uses to separate them.
  Procedural steps, cleaning or maintenance tasks, a run of cautions, the ingredients of a recipe,
  a block of separate copyright and trademark notices — each of those is a set of items of one
  kind, and emitting it as a run of <p> elements, or as one <p> with line breaks in it, leaves a
  screen-reader user no way to know how many items there are, which one they are on, or where it
  ends. Use <ol> where the order is part of the instruction (do this, then that) and <ul> where it
  is not (a set of cautions, a list of parts), with one item's worth of text per <li>: never merge
  two instructions into one item, and never split one instruction across two. Typography does not
  decide this. Items set as separate lines, or run together in one paragraph with "first… then…
  finally", are a list where they are discrete and parallel, and the absence of bullet glyphs is
  not evidence that they are not. Re-cutting prose into items moves no words: "First, remove the
  cover" is one <li> transcribed as printed, ordering word and all. A printed digit is the list's
  marker and is carried by the count instead (NUMBERS THE PAGE SHOWS below), but "first", "then"
  and "finally" are words in the sentence — an <ol> numbering them as well is a small redundancy,
  where tidying them away is text gone from the document with nothing to say it went. It holds
  inside a table cell exactly as it does in the body: a
  Directions cell holding three steps is a cell containing an <ol>, an Ingredients cell holding
  four items is a cell containing a <ul>, and neither is <br>-separated text — the cell boundary
  groups them for the eye, and for nobody else.
  Two things this is not. Continuous prose is not a list: a paragraph that explains one thing, or a
  single direction written as one sentence, stays a <p>, and a list of one item is a paragraph. And
  a list is not a way to number things — an <ol> counts its own items, so the numbers the page
  itself prints are the subject of NUMBERS THE PAGE SHOWS below.
  When the numbering does not begin at 1, set start on the <ol> so the numbers match the source.
  Use <ul>/<ol>/<dl> for real lists, never dashes or manual numbering in paragraphs.
- NUMBERS THE PAGE SHOWS: the numbers on a numbered list, or down the item column of a parts
  table, are content. Transcribe the sequence exactly and never tidy it: do not renumber to close
  a gap, and do not drop or alter a number that appears twice — a table that reads 1, 2, 5, 5, 6
  reads 1, 2, 5, 5, 6 here. In a table those numbers are cell text, so transcribing them is enough;
  in a numbered list they are not text at all, because an <ol> counts 1, 2, 3 by itself whatever you
  put in it — so set value on any <li> whose number differs from the count (<li value="5">), the way
  start carries a list that does not begin at 1. Where the sequence skips or repeats, say so once in
  a <p> immediately after that list or table, give that <p> an id and point the table's or list's
  aria-describedby at it, so the note reaches a reader who arrives by moving from table to table
  rather than by reading every line. Number those ids by the order the annotated lists and tables
  appear on the page — numbering-note-1, numbering-note-2 — and never reuse one: a page whose two
  notes both take id="note" ships a duplicate id, since ids are made unique between pages at the
  join and not within one. Keep what you write to what this page shows: "Items 3 and 4 are
  not listed in this table" is something a reader can check against the rows above it, while "items
  3 and 4 do not appear in this assembly" is a claim about a document you were not shown — the
  missing numbers may be listed on another page, or left unlisted on purpose. Do this for
  EVERY irregular list and table on the page, and record each one in the "log" field as well: a
  skip in the first table counts exactly as much as one in the last, and annotating only the last
  tells a reader that the others were checked and found sound. Never write such a note for a
  sequence that is in fact unbroken, and where the page prints its own note about the numbering,
  transcribe that rather than adding a second one beside it.
- A SYMBOL THE PAGE EXPLAINS AS A DEVICE: where the page states that a symbol means something
  navigational rather than something about the content — "see the pages indicated by •", a ► that
  stands for "turn to" — that symbol belongs to the page's apparatus and not to the item it is
  printed beside. Leave it out of the text: a list whose every <li> ends in • hands a screen reader
  "bullet" at the end of every item, announced aloud, with nothing in the markup to say why, and
  the reader cannot see the sentence that explained it. Record the convention in the "log" field
  instead. This is narrow, and it is the page's own explanation that makes it apply. An unexplained
  symbol is ordinary text and is transcribed as printed — a bullet inside a sentence, a † beside a
  price — and a symbol the page explains LEXICALLY, by saying what it stands for, is the
  abbreviation rule below rather than this one.
- ABBREVIATIONS AND KEYS: where the page itself says what a short form means — a legend under a
  table, a key beside a diagram, a footnote, a parenthetical on first use — carry that meaning
  into the markup in the page's own words: <abbr title="not shown">NS</abbr>. Never supply an
  expansion the page does not state, however obvious it looks. Encode it ONCE, where the page
  keeps it: transcribe the legend or key as the structure it is (a <dl> of symbol and meaning, or
  the footnote it is written as) and do NOT also put a paragraph above the table restating what
  the legend below it already says — read in order, that is the same sentence twice, and the
  second copy is prose you wrote rather than content the page has. Inside a table, mark every
  cell that carries the abbreviation and not only the first: a row is read on its own, so an
  <abbr> in row 1 does nothing for someone who lands on row 20. In running prose the first
  occurrence is enough.
- SIGNATURE AND FILL-IN BLOCKS: a block of fields the page provides for someone to complete — a
  signature block, an application section, a run of fill-in lines — is a form even where it has
  already been filled in. Render the whole block as a <form> with one <fieldset>/<legend> per
  signing party or logical group, and every field in it (Signature, Printed Name, Title, Date)
  as an <input> with its own <label>. Transcribe a field that is already filled in as
  <input readonly value="..."> rather than as a <dd> or as plain text, so that every party in
  one block has the same structure: one party as a <dl> and another as controls tells a
  screen-reader user the two differ in kind, when the only difference is that one is filled in.
  Associate a handwritten-signature image with its field using aria-describedby. Set
  aria-required="true" only where the page itself marks a field as required, never merely
  because it is blank. This is about fields, not about every label/value pair: printed metadata
  nobody is meant to complete (a reference number, a "Prepared by" line) is still a <dl>.

A page that prints the same content in more than one language gets the same treatment in each.
Every rule above applies to the second column exactly as it does to the first: where the English
steps are an <ol> the French steps are an <ol>, where one recipe's ingredients are a <ul> so are the
other's, and a sub-topic that earns a heading in one language earns it in the other. Structure that
stops at the first language is worse than none, because the document then looks handled to everyone
except the reader it failed. Mark each change of language with lang on the element that holds it —
<section lang="ko">, or lang="es" on the single <td> that switches — using the BCP 47 tag for the
language the page prints there. A page wholly in one language changes language nowhere, and is the
case that needs the attribute most: put lang on every top-level element you emit for it. The
document you are writing into declares English around your fragment, so a Korean page returned with
no lang of its own is delivered as English text, pronounced as English, to the reader who has no way
to see that it is not.
And transcribe that language; do not translate it. Returning a Korean page in English is not
accessibility work but a different document: those words are not words on the page, the original is
not recoverable from what you emit, and a mistranslation is invisible to exactly the reader who
would be relying on it. What a screen reader needs in order to pronounce the passage at all is the
lang attribute, which is why that is the rule. Say in the "log" field which languages the page
holds.

If — and only if — this page contains a content type that a DEDICATED specialist agent would
handle clearly better than this general pass (something beyond the common types: paragraph,
heading, list, table, form field, image, quote, caption, footnote), include a
"suggested_agent". Suggest sparingly; omit it (or null) otherwise.

Respond with ONLY this JSON:
{ "html": "<accessible HTML for the whole page — body content only, no duplication>",
  "log": "notes, e.g. content cut off at an edge",
  "suggested_agent": { "name": "lowerCamelCase", "reason": "why a specialist is warranted" } }`;

export interface ExtractionResult {
  fragments: Fragment[];
  suggestions: { name: string; reason: string; image: string }[];
  // Source pages (1-based order) the delivered document has NO content for: their own
  // extraction threw and they are in the document as a failure marker — see
  // `failedPage`. Empty on an ordinary run. Returned rather than only logged because a
  // document delivered with a page missing is a different deliverable, and the caller
  // records it alongside the run's other outcome counts.
  //
  // From `reExtractPages` this is the set the document ALREADY had, minus any page the
  // re-extraction filled in. A re-extraction that throws does not add to it: that path
  // only runs for pages which already have a fragment, so the page keeps the content it
  // had and the document is no less whole than it was. Those are reported as
  // `reextract_complete.failed` instead — folding them in would tell a client its
  // document is missing a page that is in it.
  failedPages: number[];
  // Pages that WERE in `failedPages` and are not any more, because this re-extraction
  // produced content for them. Returned rather than logged here: "the document has this
  // page now" only becomes true once the round's document is persisted, and a round that
  // throws after re-extracting (in the Reader, the editor, the lint) leaves the client
  // holding the document that still has the hole. Logged by the caller, after the write
  // (pipeline/orchestrator.ts) — diagnostics folds the event straight into
  // `pages_failed`, so a premature line there claims a document is whole when it is not.
  recovered?: number[];
}

// The content of the LAST fenced block, or the text as it stands.
//
// Any info string, not only `html`: a ```json fence is what a page agent writes when it
// wraps the envelope, and a regex that knew only `html` left the word "json" INSIDE the
// content it returned — which is why every leaked envelope in issue #168 begins with the
// literal line `json`. `extractJson` has always known both spellings; this now does too.
//
// The last rather than the first, for the reason `extractJson` prefers the last object
// (util/json.ts): a model that drafts and then corrects itself sends both, and the bench logs
// have a page correction with FOUR fenced envelopes whose first three logs say they were
// abandoned ("RESTART", "Intermediate attempt abandoned"). Binding the first delivered a draft
// the model had already rejected (issue #170). This is the bare-HTML half of that fix — the
// same reply shape, answered in markup instead of an envelope, reaches the page through here.
//
// Exported for test/envelope-as-content.test.ts: the four reply shapes this and `bareHtml`
// have to agree about were all read off real bench logs, and a unit test names them.
export function stripFences(t: string): string {
  const blocks = [...t.matchAll(/```[a-z]*[ \t]*\r?\n?([\s\S]*?)```/gi)];
  const last = blocks[blocks.length - 1];
  return (last ? last[1] : t).trim();
}

// A reply that is not the JSON envelope, but IS plainly the page's HTML.
//
// The page agent is asked for `{"html": "…"}`, and a model that answers with bare HTML
// instead should not cost a page — that is the fallback this replaces, and it was right to
// want it. What it could not do is tell "answered with HTML" from "answered with anything at
// all": on a reply whose envelope did not parse it handed back the envelope, prose and all,
// and that text was delivered to the user as the page's content (issue #168). It is not only
// wrong content. The escaped markup inside a leaked envelope parses as tags whose ATTRIBUTE
// NAMES begin with a digit or a backslash, which is what took axe-core down on the same
// documents (#164) — so one unreadable reply cost the page AND the whole document's
// accessibility verdict.
//
// So the raw text is accepted only when nothing about it suggests an envelope: it does not
// begin with `{`, it carries no `"html":` key anywhere, and it starts at a tag rather than
// at prose about the page. Anything else is a reply that could not be read, which is a
// reported outcome and not a page's content.
//
// Unfenced prose followed by markup ("Here is the page:\n<h1>…") is therefore refused, and
// deliberately: nothing here can say where the sentence ends and the page begins, and the
// old fallback's answer — deliver both — put a sentence Iris wrote into a document whose
// whole contract is that every word in it is a word on the page. Prose around a FENCED block
// costs nothing, because `stripFences` finds the fence wherever it starts.
export function bareHtml(text: string): string | null {
  const t = stripFences(text);
  if (!t || !t.startsWith("<")) return null;
  if (/"html"\s*:/.test(t)) return null;
  return t;
}

// What an unreadable reply looked like, for the log line. The point of the field is that the
// shapes have DIFFERENT remedies, so it is worth the few lines to name them apart: a
// `truncated_envelope` is the output ceiling (raise `max_tokens`), an `envelope` that will not
// parse is escaping the page's own punctuation (util/json.ts), `prose` is the agent answering
// conversationally and `empty_html` is it answering with no page at all — both prompt problems,
// and nothing about the parser.
//
// `parsed` decides the first question, because it settles it: if the envelope was read, then
// whatever is missing was missing from a reply this pipeline understood, and pointing the
// operator at escaping would be pointing at the one thing that worked. What `empty_html` means
// is now narrower than it was: a blank page DECLARED as one is `declaredBlank` below and not a
// failure at all, so what reaches this shape is an envelope that carried no page and did not
// say why — the model that gave up, which is the prompt problem this field names.
function replyShape(text: string, parsed: unknown): string {
  if (parsed) return "empty_html";
  const t = stripFences(text);
  if (t.startsWith("{") || /"html"\s*:/.test(t)) return /}\s*$/.test(t) ? "envelope" : "truncated_envelope";
  return t ? "prose" : "empty";
}

// A page the agent says has nothing on it: `html` PRESENT and empty, with a `log` line saying
// so. Both halves are load-bearing.
//
// This used to be a reported page failure, and the comment here defended that on the grounds
// that `agents/page.md` did not say what to return for a page with nothing on it, so `""` was
// as likely to be a model that gave up as a page that is blank. Then round 7 of the bench
// measured the rate: six pages of 100, in three of four documents, every one a well-formed
// 155–210-character envelope saying correctly that the page is blank, every one delivered as a
// `@page-failed` marker and counted as a lost source page (issue #179). A document that
// declares a hole where there is no hole is its own defect — it costs a reviewer a glance per
// page and it makes the run's own report untrue — so the prompt now names the case and this
// reads the answer it asks for.
//
// The key must be PRESENT: `{"log": "no content"}` is a reply that did not answer the question,
// and it stays a failure, which is the distinction the issue's fallback asks for. And the `log`
// must SAY the page is blank, not merely be non-empty: the commonest shape a vision model gives
// up in is an empty `html` with a sentence about why, and `{"html": "", "log": "the scan is too
// dark to resolve any text"}` is the reply that most needs a human to look at the page. Read as a
// declaration it would leave nothing in the delivered document to look at — no marker, no notice,
// no entry in `pages_failed` — and `pages_blank` would positively assert the paper was empty.
// The fidelity check does not cover that case either: it is shown the same unreadable image by
// the same model, so it agrees there is nothing there.
//
// So the test is positive and the doubt is fatal. `BLANK_LOG` wants the log to assert emptiness
// in some words; `UNREADABLE_LOG` and `DEGRADED_IMAGE_LOG` refuse the declaration whatever else
// the log says, so a hedge ("appears blank, though the scan is very faint") and a description of
// the image's own condition ("the page is very dark and appears empty") are failures. A blank
// page whose log is phrased outside both patterns is reported as a failed page, which is the
// direction to be wrong in: a page wrongly reported as failed costs a glance, a page wrongly
// dropped costs the page.
//
// The one place the doubt is not fatal is a veto word MODIFYING the marks on the paper
// (`MARKS_PHRASE` below): "a few faint specks, no legible text" describes an empty sheet, and
// reading `faint` there as doubt about the scan cost the bench four pages. Only the phrase is
// exempt, so the same word about the scan itself in the same sentence still refuses, and a log
// that anywhere says the reading failed is not exempt at all — the exemption narrows what the
// veto words are ABOUT without moving where a real doubt lands. Not done here is the
// issue's preferred fix, sending a vetoed declaration to the fidelity check instead of reporting
// the page failed: the paragraph above is why — the check is the same model on the same image, so
// on the unreadable page it agrees there is nothing there, and a page delivered blank on that
// agreement has no marker, no notice and no entry in `pages_failed` to look at. The failure path
// is the disclosure. What a refusal now leaves behind is the `blank_vetoed` field on
// `page_no_output`, so which word refused which page is a log read rather than an investigation.
//
// What is NOT done here is the issue's preferred fix — a page-break marker labelled with the
// page's position in the file. The prompt forbids exactly that ("use the number the page shows
// (iv, 5, A-3), never the position of the image you were given in the file"), and it is the
// same rule that produced the split the issue reports: the three blank pages that were
// delivered carried `aria-label="Page 4"` from the file position, and the two that failed had
// obeyed the rule and emitted nothing. An anchor named for a position rather than a printed
// folio claims the document's page 4 is here, which on front matter or an insert is false — and
// the marker's whole contract is that its label is the number the paper shows. A page that
// prints no folio has no anchor whether it is blank or not, so the gap the issue notes in the
// anchor sequence is not new and not a defect.
// The page has nothing on it. Wide enough for the phrasings the bench replies used and for the
// wording the prompt now asks for ("say in the log field that the page is blank"), and no wider.
const BLANK_LOG =
  /\b(blank|empty|no (visible |printed |discernible )?(content|text|markings?|marks|words)|nothing (on|printed|visible|at all)|intentionally left blank)\b/i;
// The page could not be READ, whatever else the log says about it. Checked second and given the
// last word, because these two overlap in exactly the reply that must not be trusted: a page the
// model calls blank because it cannot make anything out is not a page it read.
//
// Two families, and the second is why this is not a list of ways to say "I could not": a model
// describing the IMAGE's condition ("the page is very dark and appears empty", "low resolution
// scan; no text") has told you why its answer is unreliable without ever saying it failed. Those
// words veto the declaration too. Both lists lean wide — a page wrongly reported as failed costs a
// glance, and a page wrongly dropped costs the page — but only over words that carry doubt: `too
// low` vetoes with or without an infinitive after it, while `quality` is scoped to the poor kind
// (it matches "high quality" as readily as the other), and geometry is not legibility, so a
// rotated or skewed page says nothing about whether its words could be read.
const UNREADABLE_LOG =
  /\b(illegible|unreadable|not legible|could ?n[o']?t|can ?not|can'?t|unable|failed|truncat\w*|too \w+ to|too (low|light|dark|faint|poor|noisy|blurry)|blurr\w*|obscur\w*|resolve|corrupt\w*|partial\w*|error)\b/i;
const DEGRADED_IMAGE_LOG =
  /\b(dark|faint|washed|blurry|blurred|noisy|noise|grainy|pixelat\w*|low[- ]?res\w*|resolution|(poor|low|bad|degraded)( \w+)? quality|quality (is|was|of)|(out of|not in|soft) focus|did ?n[o']?t load|not load\w*)\b/i;

// The marks a scanner leaves on an empty sheet, and the exemption for describing them. The words
// for the marks and the words for a bad image overlap almost completely (`faint`, `noise`, `dark`),
// and round 9 of the bench lost four blank pages of 100 to that overlap: an agent that answered the
// prompt's request for a description ("Specks/dots are visible on the page but do not resolve into
// any characters or content") was punished for it, while an agent that said only "Page is blank."
// was believed (issue #190). Two pages of one document opened with a verbatim identical sentence
// and only the one that went on to explain itself was refused, so what was being measured was the
// wording.
//
// What is exempt is a PHRASE, not a sentence, and that distinction is the whole safety of this: the
// veto words come out where they modify the marks and stay in everywhere else, so a log that
// mentions the marks AND the state of the scan in one breath — "the scan is blurry, showing only
// faint specks and no legible text", which is how these logs are actually written — still refuses
// the declaration on `blurry`. Dropping the sentence instead would deliver that page blank with no
// marker and nothing in `pages_failed`, which is the failure mode the whole file is built against.
// None of these nouns is a veto word, which is what makes the exemption below narrow: the only
// words it can ever remove are the veto words used AS MODIFIERS of one of them.
const MARK = String.raw`specks?|speckles?|flecks?|dots?|dust|debris|smudges?|blemishes?|artifacts?|stray marks?`;
// What may stand between a quantifier and that noun. The veto words are here on purpose — `faint
// specks` is the paper and `faint scan` is the image — alongside the words that are not veto words
// at all, because the run has to reach the noun in one piece to match ("a few scattered
// specks/dots", "scanning artifacts").
const MARK_MODIFIER = String.raw`faint|light|pale|grey|gray|dark|darker|noisy|grainy|blurry|blurred|washed(?:-out)?|pixelated|tiny|small|minor|stray|scattered|random|isolated|residual|scan|scanner|scanning|dust|paper|toner|ink`;
// A phrase whose head is one of those nouns, with its quantifiers and modifiers. Replaced with a
// space before the veto lists run, so a doubt word inside it is not read as doubt about the scan —
// and a doubt word anywhere ELSE in the same sentence still is, which is the whole difference
// between this and dropping the sentence: "The scan is blurry, showing only faint specks and no
// legible text" loses `faint` and keeps `blurry`.
//
// `noise` is only in the joined tail (`dust/noise`, `specks, noise`) and never a head, because it
// is a veto word itself and standing alone it is a claim about the image: "the scan has noise"
// must go on refusing the declaration.
const MARKS_PHRASE = new RegExp(
  String.raw`\b(?:(?:a|an|the|only|just|some|few|several|couple|of)\s+){0,4}` +
    String.raw`(?:(?:${MARK_MODIFIER})[\s/-]+){0,3}` +
    `(?:${MARK})(?:\\s*[/,&]\\s*(?:${MARK}|noise))*`,
  "gi",
);
// Two constructions that say the marks are not text, and so are the declaration rather than a
// failure to read. Both are anchored to a marks noun earlier in the sentence with NO NAME FOR TEXT
// in between, which is what makes the marks the thing being denied. Without the anchor they read as
// exempt wherever they sit, including in a log that affirms the text is there ("the text does not
// resolve into legible words"); with a plain same-sentence anchor, a marks noun anywhere ahead of
// the affirmation exempts it ("a few specks are visible, but the printed text does not resolve into
// words") — and either way a page that has text on it is delivered as an empty fragment with no
// marker and nothing in `pages_failed`.
//
// It has to be a gap and not adjacency: the real logs put the whole predicate between them ("Specks
// /dots are visible on the page but do not resolve into any characters", "artifacts of the scan
// (dust/noise) and do not resolve into…", "specks/dots that appear to be scanning artifacts, not
// legible text"), so requiring the noun immediately before the verb, or refusing to cross a comma,
// `but` or `and`, would cost three of the four pages this exists for.
// Every name for something printed on a page, not only for text: what the gap must not cross is an
// affirmation that the page HAS something on it, and `the content is not legible text` affirms as
// plainly as `the lines` do. `content` matters most because `NOT_LEGIBLE_TEXT`'s own lookahead
// counts it as a name for text, and the two must not disagree about the same word. None of this
// costs the four round-9 logs: they all put `content` after the veto word ("do not resolve into any
// characters or content"), never in the gap ahead of it, which is the only region examined.
const TEXT_NOUN = String.raw`text|texts|content|printing|prints|lines?|words?|characters?|letters?|glyphs?|digits?|numerals?|handwriting|writing|typing|paragraphs?|sentences?|headings?|captions?|figures?|images?|illustrations?|diagrams?|tables?|stamps?|signatures?|labels?|logos?|seals?`;
// The gap: anything up to the end of the sentence that does not name text.
const MARKS_ANCHOR = String.raw`(?<=\b(?:${MARK})\b(?:(?!\b(?:${TEXT_NOUN})\b)[^.;])*)`;
// "…specks/dots … do not resolve into any characters": `resolve` is in `UNREADABLE_LOG` for "could
// not resolve", and a destination after it turns the sentence into a denial that the marks are
// characters.
const MARKS_NOT_TEXT = new RegExp(`${MARKS_ANCHOR}\\bresolves?\\s+(?:in)?to\\b`, "gi");
// "specks/dots … not legible text" denies the marks are text; "the text is not legible" is a claim
// about text that exists. Both the word order and the anchor are needed: `the typed lines are not
// legible characters` has the noun after it too, and names no marks.
const NOT_LEGIBLE_TEXT = new RegExp(
  `${MARKS_ANCHOR}\\bnot legible(?=\\s+(?:text|content|words?|characters?|print(?:ed|ing)?|writing|markings?))`,
  "gi",
);
// Terms no exemption reaches, checked over the WHOLE log rather than a phrase: a failure to read
// ("the scan is too dark"), something hidden ("dust and noise obscure the text" — which names
// marks and denies nothing), or a concession ("a few specks, though the scan is very faint"). A
// concession word is free to include here, because every exemption above needs a marks noun to
// reach anything, so blocking them on `though` costs nothing in a log that names none. This list
// only disables the exemptions — the verdict is still the two veto lists', and six of these words
// are in neither, so "Page is blank. Only a few specks, though." is a blank page today and was one
// before any of this.
const HARD_DOUBT =
  /\b(illegible|unreadable|could ?n[o']?t|can ?not|can'?t|unable|failed|truncat\w*|too \w+ to|too (low|light|dark|faint|poor|noisy|blurry|grainy)|obscur\w*|hidden|corrupt\w*|error|did ?n[o']?t load|not load\w*|though|although|however|uncertain|not (entirely |fully )?(sure|certain))\b/i;

// The text the veto lists are run over: the log with the marks phrases in it removed, or the log
// untouched where anything in it says the reading failed.
// The two anchored strips run FIRST: `MARKS_PHRASE` removes the very nouns they are anchored to.
function vetoScope(log: string): string {
  if (HARD_DOUBT.test(log)) return log;
  return log.replace(MARKS_NOT_TEXT, " ").replace(NOT_LEGIBLE_TEXT, " ").replace(MARKS_PHRASE, " ");
}

function matches(re: RegExp, text: string): string[] {
  return [...text.matchAll(new RegExp(re.source, "gi"))].map((m) => m[0].toLowerCase());
}

export interface BlankDeclaration {
  // The log says the page has nothing on it, in some words.
  asserted: boolean;
  // ...and nothing in it casts doubt on that, so the page is delivered empty.
  blank: boolean;
  // The doubt words that refused an assertion, for the log line. Without this the only record of
  // a refusal was the reply itself, and working out WHICH word did it is a regex read per page —
  // which is what issue #190 had to do by hand for four pages.
  vetoes: string[];
}

// Exported for the unit test: this predicate is the whole distinction between a page delivered
// empty and a page reported lost, and it is worth pinning on the reply shapes directly.
export function blankDeclaration(parsed: { html?: string; log?: string } | null): BlankDeclaration {
  const none = { asserted: false, blank: false, vetoes: [] };
  if (typeof parsed?.html !== "string" || parsed.html.trim()) return none;
  const log = parsed.log?.trim();
  if (!log || !BLANK_LOG.test(log)) return none;
  const scope = vetoScope(log);
  const vetoes = [...new Set([...matches(UNREADABLE_LOG, scope), ...matches(DEGRADED_IMAGE_LOG, scope)])];
  return { asserted: true, blank: vetoes.length === 0, vetoes };
}

export function declaredBlank(parsed: { html?: string; log?: string } | null): boolean {
  return blankDeclaration(parsed).blank;
}

// Load the page agent, preferring a session-built/trained copy (tmp/), then the
// committed agents/page.md, and finally the built-in default. Whatever is loaded
// is also what build-time verification and feedback-driven training operate on.
function loadPageAgent(ctx: PipelineContext): AgentSpec {
  const loaded = loadAgent(PAGE_AGENT, {
    agentsDir: ctx.paths.agentsDir,
    tmpAgentsDir: ctx.paths.tmpAgentsDir(ctx.sessionId),
  });
  if (loaded) return loaded;
  return {
    name: PAGE_AGENT,
    file: "page.md",
    content: DEFAULT_PAGE_PROMPT,
    capabilities: ["vision"],
    sha: null,
    sessionBuilt: false,
  };
}

interface PageRender {
  html: string;
  log: string;
  suggestion?: { name: string; reason: string };
}

// Everything the page agent is told that is NOT about the page in front of it: its own
// prompt, the accessibility contract, and whatever this deployment has learned from
// past corrections. One function, used by every page-agent call, so all of them send
// one byte-identical prefix — which is the condition a cache breakpoint needs to hit
// (providers/promptCache.ts). On a 25-page document that is one cache write and two
// dozen reads at a tenth of the price, on the largest single line in the bill: `page`
// was 779,855 input tokens of the 1.48M measured in issue #136.
//
// The requirements moved here from the user message, where they were re-sent per page
// after the "convert this page" line. That is where the accessibility.ts comment says
// they belong anyway ("appended to each content-agent system prompt", which is how
// `runSpecialist` has always used them) — and being instructions that hold for every
// page, they were never page-specific text. Same for the lessons. What stays in the
// user message is what actually differs per call: the filename and page number, that
// page's link targets, the user's feedback, and the page's previous output.
function pageSystem(agent: AgentSpec, lessons: string): string {
  return `${agent.content}\n\n${ACCESSIBILITY_REQUIREMENTS}${lessons}`;
}

async function renderPage(
  ctx: PipelineContext,
  agent: AgentSpec,
  img: InputImage,
  lessons: string,
  // On a feedback re-extraction, the HTML this page produced last time. Shown so
  // the agent corrects what the feedback names and carries everything else over,
  // rather than re-deriving the page from scratch and drifting elsewhere.
  previous?: string,
): Promise<PageRender> {
  const priorSection = previous
    ? `\n\n## Your previous output for this page\n\`\`\`html\n${previous}\n\`\`\`\n` +
      `Apply the user feedback above to this page. Keep everything the feedback does NOT ` +
      `concern exactly as it was, and re-check the affected content against the source image.\n`
    : "";
  // The page's own link targets, which the image cannot show (pipeline/links.ts).
  const links = pageLinkContext(img.links);
  if (links.shown.length) {
    ctx.log.event("page_links", { image: img.name, links: links.shown.length, dropped: links.dropped });
  }
  const user =
    `Convert this document page image (filename: ${img.name}, page ${img.order} of ${ctx.images.length}) ` +
    `to accessible HTML.${links.section}${feedbackPreamble(ctx)}${priorSection}`;
  const res = await ctx.router.complete(
    PAGE_AGENT,
    "vision",
    [
      { role: "system", content: pageSystem(agent, lessons) },
      { role: "user", content: user },
    ],
    { images: [loadImage(img)] },
  );
  ctx.log.agentCall({ agent, phase: "extraction", image: img.name, output: res.text });
  const parsed = extractJson<{ html?: string; log?: string; suggested_agent?: { name?: string; reason?: string } }>(res.text);
  const html = parsed?.html ?? bareHtml(res.text);
  // No HTML in this reply at all. Throwing hands the page to `failedPage`, which is what
  // every other unusable answer in this file already does: the page is lost, and the run
  // SAYS the page is lost (`page_extraction_failed`, `pages_failed`, a @page-failed
  // comment where the content would have been). The alternative — the old fallback's —
  // was to deliver whatever the model wrote as the page, which reports 100 of 100 pages
  // delivered while one of them is a JSON envelope with prose around it. On a feedback
  // re-extraction the throw is cheaper still: `previous` is kept, so the page keeps the
  // content it already had.
  if (!html?.trim()) {
    // Unless the agent said the page is blank, in which case an empty page is the answer and
    // not the absence of one (see `declaredBlank`). Reported on its own event and counted apart
    // from failure, because the two need different things from whoever reads the run: a failed
    // page is work to redo, a blank page is nothing to do. The empty fragment is dropped at
    // assembly, which for a page with nothing on it is what the document should say.
    //
    // The claim is not taken on trust. This returns like any other page, so the fidelity check
    // runs on it exactly as it runs on the rest — the Feedback Agent is shown the source image
    // and an empty fragment, and a page that in fact has content on it fails that check and is
    // corrected, on the same path and at the same cost as any other page that arrived wrong.
    // Short-circuiting here would buy one saved call by trading a reported failure for a silent
    // hole, which is the wrong side of the trade this whole file is built around.
    //
    // And not on a page Iris already has content for. `previous` is set only on a feedback
    // re-extraction, and only for a page whose fragment is real content (`previousFor` in
    // reExtractPages withholds it from a failed page, so a lost page CAN come back blank and be
    // recovered). Where it is set, the model has been shown that content and is now saying the
    // paper is empty, which contradicts evidence this pipeline already holds — so the throw is
    // taken after all, and the containment on that path keeps the prior fragment rather than
    // deleting it (`page_extraction_failed` with `kept: "prior"`). Nothing else on the
    // re-extraction path would catch it: `destroyedPage` guards the correction pass, where
    // `before` is this round's own render, so prior → empty never reaches a size comparison.
    const declaration = blankDeclaration(parsed);
    if (declaration.blank && previous?.trim()) {
      ctx.log.event("page_blank_refused", {
        image: img.name,
        page: img.order,
        chars_kept: previous.trim().length,
        log: parsed?.log ?? "",
      });
      throw new Error(
        `page agent declared a blank page that already had ${previous.trim().length} chars of content`,
      );
    }
    if (declaration.blank) {
      ctx.log.event("page_blank", { image: img.name, page: img.order, log: parsed?.log ?? "" });
      return { html: "", log: parsed?.log ?? "" };
    }
    const shape = replyShape(res.text, parsed);
    // A declaration the veto refused is recorded as the refusal it is, with the words that did it:
    // the failure line alone reads as "the model answered with no page", which is the opposite of
    // what happened, and every page issue #190 recovered had to be traced back to a word by hand.
    ctx.log.event("page_no_output", {
      image: img.name,
      page: img.order,
      chars: res.text.length,
      shape,
      ...(declaration.asserted ? { blank_vetoed: declaration.vetoes, log: parsed?.log ?? "" } : {}),
    });
    throw new Error(`page agent returned no HTML (${shape}, ${res.text.length} chars)`);
  }
  const sa = parsed?.suggested_agent;
  return {
    html,
    log: parsed?.log ?? "",
    suggestion: sa?.name ? { name: sa.name, reason: sa.reason ?? "" } : undefined,
  };
}

// Re-run the page agent with the fidelity problems it was told about, so it can
// fix them against the source image. Used only when verification fails.
async function correctPage(
  ctx: PipelineContext,
  agent: AgentSpec,
  img: InputImage,
  previous: string,
  problems: string[],
  lessons: string,
): Promise<string | null> {
  // The link list is repeated here, not just in the first pass: a dropped link is one
  // of the problems this pass exists to fix, and it cannot re-attach a URL it can no
  // longer see. The image still does not show them.
  const user =
    `Your previous accessible-HTML output for this page had fidelity/accessibility problems:\n` +
    `${problems.map((p) => `- ${p}`).join("\n")}\n\n` +
    `## Your previous output\n\`\`\`html\n${previous}\n\`\`\`\n\n` +
    `Look at the source image again and return a corrected version that resolves every problem.` +
    `${pageLinkContext(img.links).section}`;
  const res = await ctx.router.complete(
    PAGE_AGENT,
    "vision",
    [
      // The same prefix the first pass sent, down to the byte, so this call reads the
      // cache the first one wrote instead of paying for a near-copy of it. It also
      // gains the lessons, which this pass never had: a correction that re-derives the
      // page without them can undo the very thing a past correction taught.
      { role: "system", content: pageSystem(agent, lessons) },
      { role: "user", content: user },
    ],
    { images: [loadImage(img)] },
  );
  ctx.log.agentCall({ agent, phase: "extraction", image: img.name, output: res.text });
  const parsed = extractJson<{ html?: string }>(res.text);
  const corrected = (parsed?.html ?? bareHtml(res.text) ?? "").trim();
  // A correction that cannot be read is not a correction. Null keeps the version this
  // page already had, which passed everything except the fidelity check — strictly better
  // than replacing it with the reply's own envelope, and the caller has always treated a
  // null here as "nothing to correct".
  if (!corrected) {
    ctx.log.event("page_correction_no_output", {
      image: img.name,
      page: img.order,
      chars: res.text.length,
      shape: replyShape(res.text, parsed),
    });
    return null;
  }
  return corrected;
}

// Merge instruction for splicing a specialist fragment into the page output.
const MERGE_SYSTEM = `You merge a higher-fidelity HTML fragment, produced by a specialist agent, into an
existing accessible HTML page. Replace the page's weaker representation of that SAME content
with the specialist fragment and change nothing else — keep all other content, order,
headings, and structure exactly, and never leave both representations (no duplication).
Output body content only (no <html>/<head>/<body> wrapper).
Respond with ONLY this JSON: { "html": "<merged body content>" }`;

// Run a library specialist agent against the whole page image, asking it to
// extract only the content its contract covers. Returns its HTML fragment, or
// null when it finds nothing.
async function runSpecialist(ctx: PipelineContext, agent: AgentSpec, img: InputImage): Promise<string | null> {
  const system = `${agent.content}\n\n${ACCESSIBILITY_REQUIREMENTS}`;
  const user =
    `Extract ONLY the content your contract covers from this page image (filename: ${img.name}). ` +
    `If none is present, return {"no_content": true}. Otherwise respond with ONLY this JSON: ` +
    `{ "no_content": false, "html": "<your accessible HTML fragment>" }`;
  const capability = agent.capabilities.includes("vision") ? "vision" : "text";
  const res = await ctx.router.complete(
    agent.name,
    capability,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { images: [loadImage(img)] },
  );
  ctx.log.agentCall({ agent, phase: "extraction", image: img.name, output: res.text });
  const parsed = extractJson<{ no_content?: boolean; html?: string }>(res.text);
  if (!parsed || parsed.no_content || !parsed.html?.trim()) return null;
  return parsed.html.trim();
}

// Splice a specialist fragment into the page body, replacing the page's own
// (weaker) representation of that content. Returns the merged body, or null on
// failure (caller keeps the original page output).
async function mergeSpecialist(
  ctx: PipelineContext,
  img: InputImage,
  pageHtml: string,
  specialistName: string,
  reason: string,
  fragment: string,
): Promise<string | null> {
  const user =
    `## Current page (body HTML)\n\`\`\`html\n${pageHtml}\n\`\`\`\n\n` +
    `## Specialist (${specialistName}) fragment for the ${reason || "flagged"} content on this page\n` +
    `\`\`\`html\n${fragment}\n\`\`\`\n\n` +
    `Replace the page's existing representation of that content with this specialist fragment; ` +
    `keep everything else unchanged.`;
  const res = await ctx.router.complete(PAGE_AGENT, "text", [
    { role: "system", content: MERGE_SYSTEM },
    { role: "user", content: user },
  ]);
  ctx.log.agentCall({
    agent: { name: PAGE_AGENT, file: "page.md", content: MERGE_SYSTEM, capabilities: ["text"], sha: null, sessionBuilt: false },
    phase: "extraction",
    image: img.name,
    output: res.text,
  });
  const parsed = extractJson<{ html?: string }>(res.text);
  return parsed?.html?.trim() || null;
}

// The agent names a suggestion could have resolved to, for the
// `specialist_unresolved` log line. Session-built agents (tmp/) are included
// because loadAgent prefers them, so they are genuinely dispatchable. Sorted so
// two runs of the same library produce comparable log lines. Best-effort: this
// exists to explain a miss, so it must never turn one into a failed run.
//
// `page` and `feedback` are excluded because they are the pipeline's own agents,
// not content types anything should route to.
//
// Standard-type names are NOT in here, even though they are the commonest
// near-miss. They are reported alongside, under `declined_types` (see
// `unresolvedCandidates`), because the two answer different questions and merging
// them makes the answer to the first one false: `candidates` reads as "what I could
// have asked for", and a standard type is not that — it is declined by policy
// before the file is ever looked up, and since §7.4 v1.2 there is no file either.
function libraryAgentNames(ctx: PipelineContext): string[] {
  const names = new Set<string>();
  for (const dir of [ctx.paths.agentsDir, ctx.paths.tmpAgentsDir(ctx.sessionId)]) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // tmp/ may not exist yet, or agents_dir may be misconfigured
    }
    for (const f of entries) {
      if (!f.endsWith(".md")) continue;
      const logical = f.slice(0, -3);
      if (logical === PAGE_AGENT || logical === "feedback") continue;
      names.add(logical);
    }
  }
  return [...names].sort();
}

// The two lists a `specialist_unresolved` line needs, kept apart on purpose.
//
// `candidates` is what WAS dispatchable — real files, so a near-miss against one of
// them ("chart" for `chartDataAgent`) is readable as a near-miss rather than needing
// a second run to investigate.
//
// `declined_types` is the other half of the explanation, and the commonest one: the
// most frequent near-miss is a plural or variant of a standard type. A suggestion of
// "tables" is not in STANDARD_AGENTS, so it never reaches the decline branch, and it
// resolves to no file — so it lands in the unresolved branch, where omitting "table"
// hides the whole reason. Naming these separately says what is true of them: had the
// model written "table", it would have been declined, not dispatched. Reporting them
// as `candidates` would claim the opposite.
function unresolvedCandidates(ctx: PipelineContext): { candidates: string[]; declined_types: string[] } {
  return { candidates: libraryAgentNames(ctx), declined_types: [...STANDARD_AGENTS].sort() };
}

// If a page flagged a content type that an EXISTING library agent handles, run
// that specialist on the page and merge its higher-fidelity fragment into the
// page output. Non-blocking: any failure leaves the page output unchanged.
// dispatched=true means a library specialist ran (so the suggestion is already
// covered and should not be re-filed as a new-agent issue).
async function dispatchSpecialist(
  ctx: PipelineContext,
  img: InputImage,
  pageHtml: string,
  suggestion: { name: string; reason: string },
): Promise<{ html: string; dispatched: boolean }> {
  // Normalized by the shared `logicalType`, and tested for standardness by the shared
  // `isStandardType`, so this site and `runContribution` cannot disagree about what a
  // name means. They did once: trim-then-strip versus strip-then-trim differed on
  // `"table.md "`, which slipped past one filter and not the other.
  //
  // The decline below is keyed on the STANDARD list rather than on what is on disk,
  // because a deployment that drops a `table.md` into `agents/` must not get the
  // original bug back: a standard specialist splicing its fragment over content the
  // general page pass already rendered, which is the two-representations-of-one-thing
  // duplication the page prompt forbids. The two outcomes also differ observably — a
  // `specialist_unresolved` line blaming the name versus a `specialist_declined` line
  // stating the policy — and the decline is the true one.
  const logical = logicalType(suggestion.name);
  // Every path out of here is logged, including the ones that do nothing.
  // `logical` is free text the model wrote, resolved to a file by name, so a
  // specialist silently fails to run whenever the model's wording and the
  // library's filenames disagree — `chart` for `chartDataAgent.md`, a display
  // name, a plural. Without a log line for the miss, "routing was never
  // attempted" and "routing was attempted and the name did not resolve" are the
  // same observation: a page that came out of the general pass. `candidates`
  // names what WAS available, so a miss can be read as a near-miss rather than
  // needing a second run to investigate.
  //
  // `agent` carries the same meaning on every branch, so one filter on
  // `type=="specialist_unresolved"` can read `.agent` regardless of which branch
  // produced it. The empty-name case reports the raw string it could not use.
  if (!logical) {
    ctx.log.event("specialist_unresolved", {
      agent: suggestion.name,
      image: img.name,
      reason: "empty name",
      ...unresolvedCandidates(ctx),
    });
    return { html: pageHtml, dispatched: false };
  }
  if (isStandardType(logical)) {
    // Not a failure: the general page pass already covers the standard types, so
    // this suggestion is correctly declined. Logged to keep the counts of
    // suggested / declined / dispatched / unresolved reconcilable from one run.
    //
    // Case-insensitive, so `"Table"` declines here rather than falling through to a
    // file lookup — which on a case-insensitive volume would find `agents/table.md` if
    // a deployment added one, and dispatch the very specialist this rule forbids. The
    // name is logged as the model wrote it, since that is what a maintainer reading the
    // log has to recognize.
    ctx.log.event("specialist_declined", { agent: logical, image: img.name, reason: "standard type" });
    return { html: pageHtml, dispatched: false };
  }
  const specialist = loadAgent(logical, {
    agentsDir: ctx.paths.agentsDir,
    tmpAgentsDir: ctx.paths.tmpAgentsDir(ctx.sessionId),
  });
  if (!specialist) {
    ctx.log.event("specialist_unresolved", {
      agent: logical,
      image: img.name,
      reason: "no agent file of that name",
      ...unresolvedCandidates(ctx),
    });
    return { html: pageHtml, dispatched: false };
  }
  try {
    const fragment = await runSpecialist(ctx, specialist, img);
    if (!fragment) {
      ctx.log.event("specialist_no_content", { agent: specialist.file, image: img.name });
      return { html: pageHtml, dispatched: true };
    }
    const merged = await mergeSpecialist(ctx, img, pageHtml, specialist.name, suggestion.reason, fragment);
    ctx.log.event("specialist_dispatched", { agent: specialist.file, image: img.name, merged: Boolean(merged) });
    return { html: merged ?? pageHtml, dispatched: true };
  } catch (e) {
    ctx.log.event("specialist_dispatch_failed", { agent: specialist.file, image: img.name, error: (e as Error).message });
    return { html: pageHtml, dispatched: true };
  }
}

interface PageOutcome {
  fragment: Fragment;
  // A genuinely-new content type to file for contribution, if any. A suggestion
  // already covered by a dispatched library specialist is not reported.
  suggestion?: { name: string; reason: string; image: string };
  // Set when this page's own extraction threw and the fragment is a stand-in rather
  // than the page's content (`failedPage`). Carried explicitly rather than inferred
  // from the fragment, because a caller must not have to pattern-match HTML to find
  // out whether the document it was handed is whole.
  failed?: true;
  // The error that page threw, kept so it can be re-raised if it turns out EVERY page
  // failed (see runExtraction). Containment replaces one message with a document; when
  // there is no document, the message is all there is, and a fresh one written here
  // would be a worse diagnosis than the provider's own.
  error?: unknown;
}

// What one page leaves behind when its own extraction throws.
//
// Everything else in this file already degrades a PAGE rather than a document: a
// specialist that fails is logged and the page is kept as the general pass wrote it
// (`dispatchSpecialist`), a fidelity check that cannot run counts as nothing to
// correct (`failedCheck`), a correction that comes back empty is discarded. Only the
// page's own render was fatal to the whole run — so a model call that hit the output
// ceiling on page 26 of 50 threw away 24 pages that had already been rendered,
// verified and corrected, and delivered nothing (issue #135). "This page's output is
// unusable" and "this document is unrecoverable" are different claims, and the caller
// is better placed than this function to decide whether 24 good pages are acceptable.
//
// The page is NOT silently dropped. An empty fragment is filtered out at assembly, so
// the delivered document would simply be missing a page with nothing to say so — and
// a page absent for a reason nobody recorded is the failure this function exists to
// avoid re-creating one level down. The marker is a comment because the alternative is
// worse: a visible note is prose Iris wrote into a document whose whole contract is
// that every word in it is a word on the page. A comment is invisible to a reader,
// inert to axe and to `flatten`, and findable by tooling — the same trade
// `wrapDocument` makes for @unresolved, and it sanitizes runs of dashes for the same
// reason (a `--` inside a comment ends it early).
function failedPage(ctx: PipelineContext, pageAgent: AgentSpec, img: InputImage, e: unknown): PageOutcome {
  const message = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim();
  ctx.log.event("page_extraction_failed", { image: img.name, page: img.order, error: message });
  const note = message.slice(0, 300).replace(/--+/g, "—");
  return {
    fragment: {
      image: img.name,
      order: img.order,
      agent: pageAgent.file,
      region: "page",
      innerHtml: `<!-- @page-failed ${img.order}: ${note} -->`,
      edges: [],
      log: `extraction failed: ${message}`,
    },
    failed: true,
    error: e,
  };
}

// Did the fidelity check actually find something? `verifyAgentOutput` is deliberately
// non-blocking: it answers ok=false with an empty problem list when the check could
// not be made at all (no Feedback Agent configured, an unusable reply). That has
// always counted as "nothing to correct", and both uses below depend on it meaning the
// same thing — one to decide whether to correct, the other to decide whether a
// correction may replace a fragment that had passed.
function failedCheck(verdict: VerifyVerdict): boolean {
  return !verdict.ok && verdict.problems.length > 0;
}

// Everything one page needs: render -> optional specialist merge -> verify ->
// optional self-correction. Pages share no mutable state, so this is safe to run
// concurrently for several pages at once (see runExtraction).
async function extractPage(
  ctx: PipelineContext,
  pageAgent: AgentSpec,
  img: InputImage,
  lessons: string,
  sampler: RecheckSampler,
  previous?: string,
): Promise<PageOutcome> {
  const { html, log, suggestion } = await renderPage(ctx, pageAgent, img, lessons, previous);
  let innerHtml = html;
  let logNote = log;
  let dispatched = false;

  // Specialist dispatch: if the page flagged a content type that an existing
  // library agent handles (e.g. a chart), run that agent and merge its
  // higher-fidelity fragment into the page BEFORE the fidelity check.
  if (suggestion?.name) {
    const result = await dispatchSpecialist(ctx, img, innerHtml, suggestion);
    dispatched = result.dispatched;
    if (result.html !== innerHtml) {
      innerHtml = result.html;
      logNote = logNote ? `${logNote}; merged ${suggestion.name}` : `merged ${suggestion.name}`;
    }
  }

  const verdict = await verifyAgentOutput(ctx, pageAgent, img, [{ html: innerHtml }]);

  // Whether the page's links arrived is checked here rather than left to the
  // Feedback Agent: it verifies the output against the IMAGE, which is the one place
  // a link target does not appear, so a dropped link is invisible to it and a
  // fabricated one unfalsifiable. The comparison against the file's own annotations
  // is exact, so it is made in code and handed to the same self-correction pass as
  // any other fidelity problem.
  const missing = missingLinks(img.links, innerHtml);
  if (missing.length) {
    ctx.log.event("page_links_missing", { image: img.name, links: missing.map((l) => l.href) });
  }

  // page_verify_ok / page_verify_failed report the Feedback Agent's verdict and
  // nothing else, exactly as they did before links existed — a missing link is not
  // part of that verdict, and folding it in would make the two events mean different
  // things in old logs and new ones. `page_links_missing` above is the signal for a
  // correction driven by a link.
  const verifyFailed = failedCheck(verdict);
  if (verifyFailed) {
    ctx.log.event("page_verify_failed", { image: img.name, problems: verdict.problems });
  } else {
    ctx.log.event("page_verify_ok", { image: img.name });
  }

  const problems = [
    ...(verifyFailed ? verdict.problems : []),
    ...missing.map(missingLinkProblem),
  ];
  if (problems.length) {
    // What the correction was asked to fix, for the event below. Both triggers can fire
    // on one page, and they cost the same call but mean different things: a link the
    // model dropped is an exact, code-checked miss, while a fidelity problem is the
    // Feedback Agent's judgement.
    const trigger = verifyFailed ? (missing.length ? "both" : "verify") : "links";
    const before = innerHtml.trim();
    // A correction that cannot complete costs the CORRECTION, not the page.
    //
    // This page has already been rendered, verified, and — on the links path — found to be
    // good. The correction is an improvement step, and an improvement step that throws must
    // not be able to delete the thing it was improving: before this, a provider error here
    // propagated out of `extractPage` into `failedPage`, which logged
    // `page_extraction_failed` and shipped a `@page-failed` marker for a page whose
    // extraction had succeeded minutes earlier and was sitting in `innerHtml`. On a real
    // 50-page run that cost page 25 outright — a valid 17,721-character extraction deleted
    // because its correction hit the 32,000-token output ceiling, 522 seconds and a full
    // ceiling of output spent to lose a page the run already had, and the two problems the
    // correction was asked to fix were a transcribed folio and an unwarranted `<section>`
    // (issue #171). It also named the wrong stage: anything reading
    // `page_extraction_failed` — `pages_failed`, the markers, any triage of why pages fail —
    // concluded the vision call could not read the page. It read it fine.
    //
    // Which is the trade PR #151 already makes one layer up for the Copy Editor (a round the
    // editor cannot finish costs that round, not the document) and that this file makes
    // everywhere else: a specialist that fails leaves the page as the general pass wrote it,
    // a fidelity check that cannot run counts as nothing to correct, a sampled recheck that
    // throws is a sample not taken. The correction was the last of those still fatal.
    //
    // Every error, not only a truncation. A throttle, a stall and a ceiling all leave the
    // same thing behind — a page that is good enough to have been worth correcting — and a
    // list of which provider failures are survivable would go stale in exactly the direction
    // that loses pages. Nothing is retried: a correction truncating because the PAGE is large
    // will truncate again, and the retry would buy a second full ceiling of output to prove
    // it (the providers agree — `TruncatedResponseError` is thrown from inside their retry
    // loops precisely so it is not re-billed).
    const attempt = await correctPage(ctx, pageAgent, img, innerHtml, problems, lessons).then(
      (html) => ({ html, error: null as unknown }),
      (error: unknown) => ({ html: null, error }),
    );
    const corrected = attempt.html;
    if (attempt.error !== null) {
      const message = (attempt.error instanceof Error ? attempt.error.message : String(attempt.error))
        .replace(/\s+/g, " ")
        .trim();
      ctx.log.event("page_correction_failed", {
        image: img.name,
        page: img.order,
        trigger,
        problems: problems.length,
        error: message,
        // Named rather than left to be read out of the message, because it is the one shape
        // with a configuration remedy (`providers.*.max_tokens`) and the one that says the
        // model wrote an essay where a page was asked for — a 32,000-token correction of a
        // 17,721-character page is not a rewrite of it.
        truncated: isTruncatedResponseError(attempt.error),
        // What the page kept, so the log shows this was a page retained and not a page lost.
        chars_kept: before.length,
      });
    }
    // What the pass changed, measured but NOT used to decide what ships. Whether the
    // fragment is adopted stays on string identity, exactly as it was before any of this:
    // `correctionEffect` observes the text, the descriptions, the attributes and the tag
    // sequence, and a delivery decision must not turn on a signal being complete — a
    // correction whose only change is one this cannot see would be silently reverted, and
    // the page would keep the defect the pass had already fixed. The effect decides the
    // LABEL, which is all the note it answers asked for: a model that re-indents its own
    // page, or writes `&` where it wrote `&amp;`, returns a different string and the same
    // page, and counting that under `results.kept` beside a restored table row is what makes
    // the number unreadable — `text` and `structure` overlap, so the fold cannot subtract it
    // out afterwards.
    const effect = corrected ? correctionEffect(before, corrected) : null;
    const moved = effect !== null && changedAnything(effect);
    // A correction that produced nothing usable, or produced the page it was given back, is
    // a page call paid for and nothing delivered. Recorded because it was previously
    // invisible: the log said a page failed its check and said nothing about what the
    // pass bought, so the loop's value could only be guessed at from call counts (issue
    // #137). See `correctionEffect` for why the kept case reports what it changed.
    //
    // `failed` is kept apart from `empty` because the bill and the remedy are different: an
    // `empty` correction answered and carried no HTML, while a `failed` one never answered —
    // and the expensive case is precisely that one, since a truncation has already paid for a
    // full ceiling of output. Folding them together would hide the most costly correction
    // shape inside the cheapest.
    if (!corrected || corrected === before) {
      ctx.log.event("page_corrected", {
        image: img.name,
        page: img.order,
        trigger,
        problems: problems.length,
        result: corrected ? "identical" : attempt.error !== null ? "failed" : "empty",
      });
    }
    if (corrected && corrected !== before) {
      // A page that PASSED its fidelity check is being re-rendered here only to
      // recover a link, so the rewrite has to earn the standing the original already
      // had: it is verified in turn, and a rewrite that lost something is discarded
      // in favour of the fragment that was known to be good. A link is additive, and
      // paying for it with the structure of a page that already checked out — a
      // heading level, a `<th scope>` — would make the document worse than it was
      // before this feature. When the check had already failed, the original has no
      // standing to protect and the correction is accepted as it always was.
      //
      // Before either of those: a correction may change a page and may not delete one. A reply
      // that comes back at a fraction of the size it was given has not corrected the page, and
      // no verdict on it is worth buying — so this is decided first, and it short-circuits both
      // rechecks below (the links one would ask the Feedback Agent to judge a fragment nothing
      // will deliver; the sampled one would spend the batch's single measurement slot on it).
      // See `CORRECTION_SHRINK_FLOOR` for where a quarter comes from and why the guard is worth
      // having even now that util/json.ts reads the right envelope out of the replies that
      // prompted it.
      let keep = !destroyedPage(before, corrected);
      let recheck: VerifyVerdict | null = null;
      if (!keep) {
        ctx.log.event("page_correction_rejected", {
          image: img.name,
          page: img.order,
          trigger,
          reason: "shrank",
          chars_before: before.length,
          chars_after: corrected.length,
        });
      } else if (!verifyFailed) {
        recheck = await verifyAgentOutput(ctx, pageAgent, img, [{ html: corrected }]);
        keep = !failedCheck(recheck);
        if (!keep) {
          ctx.log.event("page_links_correction_rejected", {
            image: img.name,
            links: missing.map((l) => l.href),
            problems: recheck.problems,
          });
        }
      } else if (moved && claimRecheck(sampler)) {
        // Measurement only, on at most one page per batch: does a corrected page pass
        // the check it just failed? A page the pass did not actually change is not worth
        // the batch's one slot — there is nothing to check, and the answer would be the
        // verdict already on record. Nothing here decides anything — a verify-driven
        // correction is accepted exactly as it always was, whatever this says — because
        // whether to keep re-rendering until a page passes is a policy question, and the
        // answer to it needs the rate this event exists to produce (issue #137). See
        // `RECHECKS_PER_BATCH` for why it is one page and not all of them.
        //
        // Two bench rounds later that is the thing being asked about: 200 pages, 8 samples,
        // 2 of them ok, every correction kept regardless, and the note is that a check with no
        // consequence is decorative (issue #166). Three reasons it stays as it is, in the
        // order they bind.
        //
        // What discarding buys. A rejected correction does not restore a good page — it ships
        // the fragment that FAILED this same verifier minutes earlier. On those rounds the
        // verifier rejected 71% and 74% of first renders, so the choice is not a good page
        // against a bad one, it is a page with fewer named problems against a page with more,
        // and `problems_before`/`problems_after` on the line below is the number that says
        // which. The links path is the case where discarding does make sense and it is
        // binding there: those pages had PASSED, so the original has standing to protect.
        //
        // Whose page it would apply to. This is one page per batch. Binding it would put a
        // gate on page 4 that page 5 never sees, and the delivered document would differ by
        // which page happened to win the sample slot. Binding it for everyone means a Feedback
        // Agent call per corrected page — 71 of them on a 100-page round, roughly doubling the
        // 24% verification share that is under investigation in the first place.
        //
        // And how much the sample says. Eight verdicts, of which round 3 supplied 0 ok and
        // round 4 supplied 2, is not a rate yet. This is a measurement whose whole purpose is
        // to be accumulated across runs before anything is decided on it, and binding it now
        // would spend the pages it was collected to protect.
        //
        // And nothing here can cost a page either. `verifyAgentOutput` is non-blocking
        // for an absent Feedback Agent and an unparseable reply, but a PROVIDER error is
        // rethrown (providers/index.ts logs `model_call ok:false` and throws), so an
        // uncaught throttle on this one extra call would propagate out of extractPage
        // into `failedPage` and ship a `@page-failed` marker for a page that had already
        // rendered, verified and corrected — the corrected fragment sitting in a local
        // variable and thrown away. A measurement that decides nothing must not be able
        // to delete a page of accessible content, so a failed sample is a sample not
        // taken: it is logged, the slot stays spent (a refund would let a throttled
        // provider be retried once per corrected page, which is the cost this bounds),
        // and the page ships exactly as it would have with no measurement at all.
        recheck = await verifyAgentOutput(ctx, pageAgent, img, [{ html: corrected }]).catch(
          (e: unknown) => {
            ctx.log.event("page_correction_recheck_failed", {
              image: img.name,
              page: img.order,
              error: (e as Error).message,
            });
            return null;
          },
        );
      }
      if (recheck) {
        // `ok` is "the verifier named no problem", which is also what an unavailable
        // Feedback Agent looks like (see `failedCheck`). On this branch the sampled
        // recheck can only follow a verdict it gave, so the ambiguity is confined to the
        // links path, where it was already the standing behaviour.
        ctx.log.event("page_correction_recheck", {
          image: img.name,
          page: img.order,
          ok: !failedCheck(recheck),
          problems: recheck.problems,
          // How many problems the page went in with and came out with. `ok` alone made this
          // event unreadable in exactly the way issue #166 reports: four sampled rechecks,
          // four not-ok, and no way to tell a correction that fixed nothing from one that
          // fixed four of five problems and left the fifth. The pass is single-shot, so
          // "fewer" is the outcome it can realistically produce and "none" is not the bar it
          // was built to clear.
          //
          // The FIDELITY problems only, which is not the same as the problems the correction
          // was given: `problems` above is the Feedback Agent's verdict plus one entry per
          // missing link, and the second verdict comes from the same agent judging the
          // fragment against the IMAGE, where a link target does not appear at all (see the
          // comment on `missing`). So a link can be counted going in and cannot be counted
          // coming out, whether the correction re-attached it or not, and a page with one
          // fidelity problem and three missing links would read as four-in-one-out — a
          // correction that fixed nothing the verifier named, logged as converging. Which is
          // the reading this pair exists to remove, so the two sides are made comparable
          // instead: `links_before` carries the other share, `page_links_unrecovered` says
          // whether the links came back, and `page_corrected`'s `problems` is still the
          // correction's whole bill.
          //
          // On the links path that leaves `problems_before: 0` — those pages PASSED their
          // check — and it is the right zero: a binding verdict naming a problem there is a
          // rewrite of a good page that lost something, which is exactly what that check is
          // for, and reading it as "one problem in, one out" hid that.
          problems_before: verifyFailed ? verdict.problems.length : 0,
          links_before: missing.length,
          problems_after: recheck.problems.length,
          // Whether this verdict was allowed to change what is delivered. False for the
          // sample, so a consumer cannot read it as the loop having gained a gate.
          binding: !verifyFailed,
        });
      }
      // What the pass actually changed about the page, and whether that change is what
      // the document carries. `correctionEffect` reads both fragments rather than the
      // verdict, so "the alt text was refined" and "a table came back" are separable in
      // a log where both were `page_verify_failed` — which is the measurement issue #137
      // asks for and the one the verdict cannot give about itself.
      //
      // `kept` is reserved for a correction that changed something, so a fragment adopted
      // because it differs as a string while being the same page is `identical` here: the
      // page call was paid for and bought nothing, whichever of the two strings ships.
      ctx.log.event("page_corrected", {
        image: img.name,
        page: img.order,
        trigger,
        problems: problems.length,
        result: keep ? (moved ? "kept" : "identical") : "rejected",
        ...effect,
      });
      if (keep) {
        innerHtml = corrected;
        logNote = logNote
          ? `${logNote}; self-corrected after fidelity check`
          : "self-corrected after fidelity check";
        // Whether the correction actually re-attached them is worth recording: the pass
        // is single-shot, so a link still missing here is missing from the delivered
        // document, and that is the whole failure this feature has to be able to see.
        const stillMissing = missingLinks(img.links, innerHtml);
        if (stillMissing.length) {
          ctx.log.event("page_links_unrecovered", { image: img.name, links: stillMissing.map((l) => l.href) });
        }
      }
    }
  }

  // Checked last, on the fragment that is actually delivered: a correction pass
  // re-writes the anchors, so an href invented there is the one worth seeing.
  // Logged, not corrected — a visible URL linked to itself is legitimate. See
  // `unexpectedHrefs` for why the list is worth having anyway.
  const unexpected = unexpectedHrefs(img.links, innerHtml);
  if (unexpected.length) {
    ctx.log.event("page_links_unexpected", { image: img.name, hrefs: unexpected });
  }

  return {
    fragment: {
      image: img.name,
      order: img.order,
      agent: pageAgent.file,
      region: "page",
      innerHtml,
      edges: [],
      log: logNote,
    },
    suggestion:
      suggestion?.name && !dispatched
        ? { name: suggestion.name, reason: suggestion.reason, image: img.name }
        : undefined,
  };
}

// One fragment per page, in submitted order. Each page is verified for source
// fidelity at build time (PRD §7.5/§7.12); a page that fails gets one self-
// correction pass. Verification is non-blocking — a run never fails because the
// Feedback Agent is unavailable or unsure. When a page flags a content type that an
// existing library agent handles, that specialist is dispatched and merged in;
// otherwise the suggestion is collected for the contribution step.
//
// Pages are extracted CONCURRENTLY (defaults.extraction_concurrency), which is
// the dominant latency term for a multi-page document: each page costs up to
// several sequential model calls, and pages are fully independent. Document order
// is preserved by mapWithConcurrency returning results in input order — never
// rely on completion order here.
export async function runExtraction(ctx: PipelineContext): Promise<ExtractionResult> {
  const pageAgent = loadPageAgent(ctx);
  // Inject corroborated lessons learned from past feedback into the page agent
  // prompt (#1), so it improves without rewriting agents/page.md.
  const lessons = examplesForPrompt(ctx.paths, pageAgent.file);
  if (lessons) ctx.log.event("page_lessons_injected", { chars: lessons.length });

  const limit = ctx.extractionConcurrency;
  ctx.log.event("extraction_start", { pages: ctx.images.length, concurrency: limit });

  // Contained per page: mapWithConcurrency rejects with the first error any item
  // throws (matching a serial loop), so without this one page takes the document with
  // it. See `failedPage`.
  // One measurement-only re-verify for the whole batch, claimed by whichever corrected
  // page gets there first (correction.ts). Created here rather than inside extractPage so
  // it cannot become one per page, which is the cost it exists to bound.
  const sampler = recheckSampler();
  const outcomes = await mapWithConcurrency(ctx.images, limit, (img) =>
    extractPage(ctx, pageAgent, img, lessons, sampler).catch((e) => failedPage(ctx, pageAgent, img, e)),
  );

  // Results come back in input order, so fragments are already in page order.
  const fragments = outcomes.map((o) => o.fragment);
  const suggestions = outcomes
    .map((o) => o.suggestion)
    .filter((s): s is NonNullable<typeof s> => s !== undefined);
  const failedPages = outcomes.filter((o) => o.failed).map((o) => o.fragment.order);
  // Always logged, including the zero case, so "no page failed" and "this run predates
  // per-page containment" are not the same observation in a log.
  ctx.log.event("extraction_complete", { pages: fragments.length, failed: failedPages });

  // Nothing was extracted. Containment trades a thrown run for the pages that DID
  // work, and with none of them there is nothing to trade: assembly and the review
  // loop would run happily on a body of failure markers (the Reader and Editor are
  // text calls, so whatever killed the page images need not touch them), and the
  // session would end `ready_for_review` serving a document containing none of the
  // source's words. That is worse than the failure it replaced, which at least named
  // the ceiling and the knob to raise (test/e2e.sh §9d).
  //
  // The FIRST page's error, unwrapped, because it is the diagnosis: a message written
  // here would say "every page failed" and drop the provider's account of why. The
  // remaining pages' errors are already in the log, one event each.
  //
  // A page reported BLANK produces no content either, and the test is on the content rather
  // than on `failedPages` for that reason: a source whose every page is empty — one blank scan
  // uploaded alone, a rasterization that yielded white pages — would otherwise walk past this
  // guard and be delivered as `<main>\n\n</main>`, a document of no words that says nothing
  // about why, with no marker and no notice, from a run reporting success. Failing names it: the
  // message says how many pages were blank, which is a statement about the source and answers
  // the question an empty file would leave.
  const produced = outcomes.filter((o) => !o.failed && o.fragment.innerHtml.trim().length > 0);
  if (outcomes.length > 0 && produced.length === 0) {
    const blank = outcomes.length - failedPages.length;
    ctx.log.event("extraction_failed", {
      pages: failedPages.length,
      blank,
      reason: "no page produced content",
    });
    // The `??` is unreachable — `failed` is only ever set alongside `error` — but a
    // thrown `undefined` would reach the operator as the string "undefined", which is
    // the one outcome this branch exists to prevent.
    if (blank === 0) throw outcomes[0].error ?? new Error("extraction failed for every page");
    throw new Error(
      `no page produced any content: ${blank} of ${outcomes.length} source pages were reported blank` +
        (failedPages.length ? ` and ${failedPages.length} could not be extracted` : ""),
    );
  }

  writeFileSync(
    join(ctx.paths.sessionFragments(ctx.sessionId), "fragments.json"),
    JSON.stringify(fragments, null, 2),
  );
  return { fragments, suggestions, failedPages };
}

// Re-extract only the pages a piece of feedback actually concerns (PRD §7.12),
// leaving every other page's prior fragment untouched.
//
// This is the path for feedback the review loop structurally cannot serve: the
// Reader only ever sees the assembled HTML (by design, §7.8), so a misreading of
// the source raises no issue and the loop has nothing to act on. "You misread the
// table on page 3" can only be fixed by putting page 3's IMAGE back in front of
// the page agent. Each targeted page goes through the same
// render -> verify -> correct path as a first run, with its previous output shown
// so untouched content carries over.
//
// Returns fragments for the WHOLE document in page order — re-extracted pages
// replaced, the rest as they were.
export async function reExtractPages(
  ctx: PipelineContext,
  priorFragments: Fragment[],
  pages: number[],
  // Pages the document being refined has no content for, from the run that lost them.
  // Passed in because this function is the only thing that can shrink that set: a page
  // whose fragment is a failure marker still HAS a fragment, so it is re-extractable, and
  // a round that succeeds on it fills the hole. Anything else about the set is unchanged
  // by this path.
  priorFailedPages: number[] = [],
): Promise<ExtractionResult> {
  const targets = new Set(pages);
  const pageAgent = loadPageAgent(ctx);
  const lessons = examplesForPrompt(ctx.paths, pageAgent.file);
  if (lessons) ctx.log.event("page_lessons_injected", { chars: lessons.length });

  // Only re-extract a targeted page we still have BOTH the source image and a
  // prior fragment for.
  const priorByOrder = new Map(priorFragments.map((f) => [f.order, f]));
  const toRun = ctx.images.filter((img) => targets.has(img.order) && priorByOrder.has(img.order));
  const missing = [...targets].filter((p) => !toRun.some((img) => img.order === p));
  if (missing.length) ctx.log.event("reextract_skipped", { pages: missing, reason: "no source image or prior fragment" });

  ctx.log.event("reextract_start", {
    pages: toRun.map((i) => i.order),
    of: priorFragments.length,
    concurrency: ctx.extractionConcurrency,
  });

  // A page with no content has nothing worth showing the agent as "your previous
  // output": its fragment is the failure comment, and handing that back invites the
  // model to treat a note about a truncated response as prose to preserve — on the one
  // round whose whole job is to produce the page from scratch. So this page starts clean.
  const stillFailed = new Set(priorFailedPages);
  const previousFor = (order: number): string | undefined =>
    stillFailed.has(order) ? undefined : priorByOrder.get(order)?.innerHtml;

  // Contained per page as in runExtraction, but degrading to the PRIOR fragment rather
  // than to a failure marker: this path only runs for pages that already have one, and
  // a re-extraction that throws is a page Iris could not improve, not a page it lost.
  // Replacing good prior content with a marker would make a feedback round destructive.
  // A feedback round gets its own sample, for the same reason the first pass does: these
  // pages are corrected too, and a round that re-extracts three pages is as much a place
  // for the rate to come from as a full run.
  const sampler = recheckSampler();
  const outcomes = await mapWithConcurrency(toRun, ctx.extractionConcurrency, (img) =>
    extractPage(ctx, pageAgent, img, lessons, sampler, previousFor(img.order)).catch(
      (e): PageOutcome => {
        const message = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim();
        ctx.log.event("page_extraction_failed", {
          image: img.name,
          page: img.order,
          error: message,
          kept: "prior",
        });
        return { fragment: priorByOrder.get(img.order)!, failed: true };
      },
    ),
  );

  const replaced = new Map(outcomes.map((o) => [o.fragment.order, o.fragment]));
  const fragments = [...priorFragments]
    .sort((a, b) => a.order - b.order)
    .map((f) => replaced.get(f.order) ?? f);
  const suggestions = outcomes
    .map((o) => o.suggestion)
    .filter((s): s is NonNullable<typeof s> => s !== undefined);
  // Pages left as they were because their re-extraction threw. NOT reported as
  // `failedPages`: that field means the document has no content for the page, and these
  // pages have their prior content — the document is whole, it is just not improved.
  // Conflating the two tells a client following docs/API.md §7c that it received a
  // partial document when it did not.
  const keptPrior = outcomes.filter((o) => o.failed).map((o) => o.fragment.order);
  // A page that WAS missing and re-extracted cleanly is no longer missing. One that was
  // missing and threw again keeps its marker, so it stays in the set.
  const filled = new Set(outcomes.filter((o) => !o.failed).map((o) => o.fragment.order));
  const failedPages = priorFailedPages.filter((p) => !filled.has(p));
  const recovered = priorFailedPages.filter((p) => filled.has(p));

  writeFileSync(
    join(ctx.paths.sessionFragments(ctx.sessionId), "fragments.json"),
    JSON.stringify(fragments, null, 2),
  );
  // `pages` is what was actually re-extracted, so a page that threw is not counted
  // among them — its entry in `replaced` is its own prior fragment, which is the
  // opposite of a page this run produced.
  ctx.log.event("reextract_complete", {
    pages: outcomes.filter((o) => !o.failed).map((o) => o.fragment.order).sort((a, b) => a - b),
    ...(keptPrior.length ? { failed: keptPrior } : {}),
  });
  return { fragments, suggestions, failedPages, recovered };
}
