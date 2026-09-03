import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractJson } from "../util/json.ts";
import { mapWithConcurrency } from "../util/concurrency.ts";
import { loadAgent, type AgentSpec } from "../agents/loader.ts";
import { feedbackPreamble, loadImage, type InputImage, type PipelineContext } from "./context.ts";
import { ACCESSIBILITY_REQUIREMENTS } from "./accessibility.ts";
import { unjudgedVerdict, verifyAgentOutput, type VerifyVerdict } from "./feedback.ts";
import {
  carriesContent,
  changedAnything,
  claimRecheck,
  correctionEffect,
  destroyedPage,
  recheckSampler,
  type RecheckSampler,
} from "./correction.ts";
import { examplesForPrompt } from "./memory.ts";
import { altTexts, genericAltProblem, genericAlts } from "./alt.ts";
import { missingLinkProblem, missingLinks, pageLinkContext, unexpectedHrefs } from "./links.ts";
import { STANDARD as STANDARD_AGENTS, isStandardType, logicalType } from "./contribute.ts";
import { isTruncatedResponseError, replyExcerpt, TruncatedResponseError } from "../providers/types.ts";
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

Output ONLY the body content (no <html>, <head>, <body> or <main> wrapper). Use the most appropriate
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
And the document your fragment is joined into already exists: it supplies <html>, <head>, <body>
and the <main> that holds every page's content. Emit none of those four, and nothing that claims to
be one — a <div role="main"> is the same landmark under another name. The <main> is the costly one
to duplicate: it is the landmark a screen-reader user jumps to in order to skip the furniture, so a
document holding two of them offers no such place to jump to. And the ordinary reason for reaching
for one — setting the page's content apart from a running head, a nav bar or a banner graphic — is a
distinction the surrounding document has already made, so what is left for you to do is mark the
furniture as what it is and leave the content unwrapped.
The page's own printed number is the one page-boundary thing worth marking, and it has exactly one
correct shape: <hr role="doc-pagebreak" aria-label="Page 5" id="page-5"> — the number the page
prints, carried in the label. That role marks the break itself rather than claiming a region, so it
says where the printed page turned without announcing a section that begins there, and the id gives
that boundary a name of its own in the delivered document. Emit one wherever the page prints its number, as the
first thing you emit for that page — the number marks where the page begins rather than being part
of what it says, so it goes there whether the page prints it at the head or the foot — and use the
number the page shows (iv, 5, A-3), never the position of the image you were given in the file.
A page with nothing else on it is the one exception, and the blank-page rule below is where it lives:
no marker there, whatever the paper prints.
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
only that something ended. Each page answers that on its own evidence — a run of pages that print
no number produces no markers at all, not one apiece, whatever the pages around them do.

A sentence that runs across the page turn is not yours to mend, and the marker is why: it is the
first thing you emit, so everything standing before it in the delivered document came off a page you
were never shown. Where your page opens in the middle of a sentence — or in the middle of a word,
"larly," beneath a "Simi-" printed on the sheet before it — transcribe what your page prints and
nothing more. Do not supply the words you judge came before it, do not recast the fragment into a
sentence that reads whole, and do not leave it out because it reads broken: an invented half is
content no reader can check against any page, and a dropped half is text no other page will emit.
Keep the printing as it stands, hyphen included, where the page breaks a word at its edge. A word
the paper broke at the end of a LINE is the opposite case, and what tells them apart is what you can
see: both halves of a line break are printed on your page, so a "condi-" ending one line with
"tions" beginning the next is one word split to fit the column — write it whole, "conditions", and do
not carry the break into the markup. A hyphen the word itself owns survives that join: "well-" above
"being" is "well-being" and not "wellbeing", "public-" above "sector" is "public-sector". Where you
cannot tell whose hyphen it is, keep it — a hyphen too many is a printing some page might have, and
two words run into one is a word no page printed. Only a break whose other half is on a sheet you
cannot see is kept as printed. The one thing to add is the fact itself, in the "log" field — that
this page opens mid-sentence, or ends mid-sentence, with the few words at the edge quoted — because only a pass holding both halves can
join them, and your log is what tells it there is a join to be made.

A page with nothing on it is a page you can answer completely. Return "html" as an empty string and
say in the "log" field that the page is blank — that is the whole answer, and it is a correct one:
there is no content to transcribe, so there is nothing to put in the document for this page. Emit no
page-break marker on such a page, whatever the paper prints: a page accepted as blank is delivered as
no fragment at all, so a marker written on one is dropped rather than placed, and a blank page that
did print its folio loses an anchor to a page with nothing to anchor to. Do not fill the page instead — not a note that it is blank, not [not legible], not a marker
standing for content you did not find. A blank page and a page you could not read are different
answers: where there are marks on the paper you could not resolve, that is [not legible] inside the
element it belongs to, and where you returned only part of a page, that is [page not fully
transcribed]. An empty "html" says the paper is empty, and it is read that way.

A page whose only printed content is its own number is one of those pages. The folio is not content
here: the rule above forbids transcribing it as text, and the marker its number may be carried in is
not delivered, so a sheet printing nothing but a page number has nothing on it a reader receives — and
the answer is the blank page's answer, an empty "html" and a log saying the page is blank. Answer it
that way rather than with a marker and nothing else: a fragment carrying nothing a reader receives is
not a page, and one that arrives with a log which does not say the page is empty is reported as a page
nobody transcribed.

Say that and nothing else in the same breath. A log that reports the page blank and then names
something on it — a heading, a caption, a signature, handwriting, an image — contradicts the answer
it is attached to, and the contradiction is what gets believed: the reply is refused and the page is
reported as one nobody transcribed, which is a worse outcome for it than either half of the log
alone. Anything on the paper worth naming in the log is worth putting in "html", and anything you
could see but not read is worth [not legible] inside the element it belongs to. Describing the
specks and dust that establish a page IS empty is not naming content and is welcome; naming
something you read is the answer to a different question than the one you just gave. The page's own
printed number is the one thing you may name and still be believed — "blank apart from the printed
page number", "blank except for its printed folio" are each read as the blank page they describe —
and only because that number is the one thing on the paper this pipeline never delivers. Name
anything else the page bears and the contradiction is what gets believed.

Thirteen structures are easy to render as something that merely looks right, so be explicit:
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
  Check a level against the headings it stands beside, not only against the one before it. Before
  you settle on a level, look at what this page has already headed at each tier and ask whether this
  heading is a peer of any of them: Family Income beside Personal Income, both breaking the same
  larger subject into its parts, is the level Personal Income got, and taking it up a tier says the
  page divides its subject in a way it does not. The nearest preceding heading is the wrong thing to
  step down from when that heading is the parent of both, and being the first of its tier to appear
  is no reason to sit higher than the one that follows it — two lines the page introduces parallel
  parts of the same subject with are the same level wherever each of them falls on the page. Where
  the tiers the page prints do not settle it, give the level the content supports and say in the
  "log" field which headings you weighed against each other. This check reaches only as far as your
  page: a peer printed on a sheet you were not shown cannot be weighed against, and guessing at one
  is worse than levelling from the evidence you have. Level it from this page, say in the "log" field
  that its peers may be elsewhere, and leave it — the pass that reads the assembled document is the
  one that can see two parallel sections opening at different levels, and it is told to.
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
  A label the page prints over a cluster of those sub-topics is their parent and not their peer:
  where two or more of them sit under a title that names the group, that title is the heading and
  they each step one level down under it — a group label at <h2> makes them <h3>, not a run of four
  <h2>s that says the cord warnings and the grinding instructions are the same kind of thing as
  each other and as the page's own subject. A lead-in sentence of the label's own, or a scope note
  under it, does not make it their peer: what puts it above them is that the sub-topics under it
  are the ones it names, and the question is whether it stands over them or beside them, not
  whether it was printed alone. The label has to be printed: a grouping heading is never invented,
  and sub-topics the page groups under nothing stay at the level their own content calls for.
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
  Otherwise a heading's words are the page's words, transcribed as printed. Do not prefix one, do
  not append a category to it, and do not extend it with the product or section name the heading
  above it already gives: "On Playback" for a line the page prints as Playback is a word no reader
  can check against the paper, and a heading is where a reader decides whether to read the section,
  so a word added there is a claim about the section the page never made. The clause above is the
  one place words join a heading, and it takes them from that section's own printing.
- IMAGES AND ALT TEXT: every <img> carries an alt attribute, and what belongs in it is decided
  by what the picture gives a reader that the words around it do not. An image is decorative —
  alt="" — only where a reader who cannot see it loses nothing: a rule, a border, a flourish, a
  bullet glyph, or a graphic whose content this page ALSO carries in full beside it (the notation
  under a stave, the data table under a chart), where describing it as well hands a screen-reader
  user the same content twice. Everything else is informative and is described: words printed
  inside the image, a logo, seal or badge, a diagram, a photograph, a chart, a cover whose
  appearance is itself the content. Where an image satisfies both of those clauses, informative
  wins: the also-carried-in-full exemption is for a graphic the page repeats BESIDE it, never for
  a graphic the page IS, so a cover, a title page or a designed divider is described even where
  every word printed on it is transcribed alongside. What that description carries is the
  appearance — the colours, the layout, the shape of the type — which is the half the
  transcription does not carry, and not the words, which it does.
  Sitting beside a heading that names the section does not make
  an image decorative, and neither does being hard to describe — a heading names the section, the
  alt text says what the picture shows. Where you cannot make an image out with confidence,
  describe what you can and say so in the "log" field: never leave the attribute off, and never
  leave a filename in it.
  A number the page prints about its own picture is transcribed evidence, and checking a description
  against it costs nothing: where the page states how many things a category holds — a subtitle's
  "eight of the twelve states", a total row, an "of which" — and your description enumerates that
  category's members, count your own list and make the two agree before you emit. Where they
  disagree it is the list that is wrong, because the number came off the page and the list is your
  reading of the picture: name only the members you can actually distinguish, and say that the page
  states this many while you could place that many — in the alt text itself, and in the "log" field
  either way, never as a sentence of your own added beside the figure, which is text the page does
  not print. Never pad the list to reach the number and never drop members to fit it. Transcribe the
  printed count where the page prints it, in the caption or label that carries it: it is the only
  thing a reader who cannot see the picture has to check the list against, and where the picture's
  own ink is ambiguous it is frequently the only thing that says which reading is right. A count
  standing in both places is not the repetition the next rule forbids: that rule is about the NAME
  of the thing pictured, which a caption beside the image already announces on its own, and a
  number is the opposite case — it is transcription where the page prints it, and in the alt text
  it is the bound on the list that only that text contains.
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
- UNDERLINED TEXT: an underline is ink on the page, not a destination. Underlining alone is never
  reason to emit an <a>. A link is somewhere a reader can go, and the only destinations you have
  are the ones you were given: a URL listed for this page under "Links on this page" where that
  section appears, a URL printed legibly in the text — which may link to itself, and to nothing
  else — and the in-document footnote anchors the footnote rule above prescribes. Where the page underlines text and none of those applies, the
  words are transcribed in full and no link is written — what is lost is the link, never the text.
  An <a href="#">, or an href built out of the underlined words or a guessed address, announces a
  destination that does not exist: the reader who follows it arrives nowhere, has nothing on the
  page to check it against, and no accessibility gate reports the loss, because a link that goes
  nowhere is valid markup. What the page did not print, this page does not link.
  Then keep the underline itself. Ask first whether a rule elsewhere in this list already owns it:
  an underlined line that introduces what follows is a heading, an underlined blank someone is
  meant to write on is a field in a form, an underlined label standing before its explanation is a
  <dt>, and a line ruled across the page under nothing is not underlined text at all. Where none of
  them owns it, wrap the run the page underlines in <u> — that word or phrase and no more, never
  the sentence around it — because an underline the page prints and the HTML leaves out is a
  distinction the document made that the delivered page no longer shows. <u> restores the ink and
  nothing else: it carries no meaning an assistive technology announces, which is why a rule that
  gives the underline a structure outranks it wherever one applies. Use <em> instead only where the
  page itself says
  its underline marks emphasis; <u> is right for an underline that is doing something else, or
  something the page does not name. The page's own underline may read to a sighted eye as though it
  were a link, and that ambiguity is the page's: transcribing it as <u> hands the reader the page
  as it is, where an <a> would add a promise the page never made. And add an underline nowhere the
  page does not print one — inventing one is the same fault as inventing a link, pointing the other
  way.
- LISTS: a group of discrete, parallel items is a list, whatever the page uses to separate them.
  Procedural steps, cleaning or maintenance tasks, a run of cautions, the ingredients of a recipe,
  a block of separate copyright and trademark notices — each of those is a set of items of one
  kind, and emitting it as a run of <p> elements, or as one <p> with line breaks in it, leaves a
  screen-reader user no way to know how many items there are, which one they are on, or where it
  ends. Use <ol> where the order is part of the instruction (do this, then that) and <ul> where it
  is not (a set of cautions, a list of parts), with one item's worth of text per <li>: never merge
  two instructions into one item, and never split one instruction across two — a block of four
  copyright and trademark notices is four <li> elements and not one. Typography does not
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
  groups them for the eye, and for nobody else. That holds whether or not the page sets the steps
  apart: three steps run together as one block of prose in a Directions cell are three <li>
  elements, because what makes them a list is that a reader does them in order, not the line breaks
  the page did or did not print.
  And the list stays in the cell. Never lift a cell's items out of the table to stand as <li>
  elements beside it or as a run of items after it: a cell says which row and which column its
  contents belong to, that is the whole of what a table adds, and four ingredients emitted at
  document level no longer belong to a row at all — the reader is left with Flour and Salt and no
  way back to the Ingredients column of step 3, which is less than even the <br> version would have
  given them. However the page separates the items inside that cell, the markup for them goes
  inside the <td>.
  A procedure the page runs as a paragraph outside a table is the same case — a cleaning routine, a
  maintenance sequence, an installation walk-through — and is an <ol> of its steps. Cut it on the
  page's own boundaries and no others: a sentence, a semicolon, a printed "then" or "finally". One
  step whose wording joins two actions ("add water and run for ten seconds") is one item, because
  the cut that separates them deletes the "and" the page prints. Only what the page tells the
  reader to DO is one of those steps: a sentence that warns, explains or states a fact — "Never
  immerse the base in water", "The housing may still be warm" — is not a step, and an <ol> that
  numbers it tells the reader the page put a prohibition third in an order it never printed. It
  stays the <p> it is, where the page printed it. Printed between two directions, that means the
  steps before it and the steps after it are two <ol>s with the caution as a <p> between them, and
  start on the second so its numbering carries on from the first: a list that begins again at 1
  tells the reader the page printed two procedures, and a reader told "list of 2 items, item 1"
  about what the page printed as step 3 has lost their place in it. (The start rule below is about
  numbers the page itself prints. Here the <ol> supplies them, and what it has to supply is the
  numbering the one procedure would have had.) Never move it to the end of the procedure to keep
  the list in one piece — a warning the page printed above step 3 announced after step 5 is the
  reading order this rule exists to keep. A run of cautions printed as a set of its own is a <ul>
  of cautions as at the top of this
  rule; what is excluded here is numbering one of them as a step of the procedure it interrupts. A
  paragraph left with one direction, or none, is a <p> and not a list of one, and where the page
  gives no boundary to cut on it stays a <p>.
  Two things this is not. Continuous prose is not a list: a paragraph that explains one thing, or a
  single direction written as one sentence, stays a <p>, and a list of one item is a paragraph. And
  a list is not a way to number things — an <ol> counts its own items, so the numbers the page
  itself prints are the subject of NUMBERS THE PAGE SHOWS below.
  When the numbering does not begin at 1, set start on the <ol> so the numbers match the source.
  Use <ul>/<ol>/<dl> for real lists, never dashes or manual numbering in paragraphs.
- NAMED ITEMS AND THEIR EXPLANATIONS: where a section runs through a series of named things and
  says what each one is — the controls of a machine and what each does, settings and their effects,
  basic operations, features, terms and their definitions — that is a <dl>: the name of each item
  as a <dt> and what the page says about it as the <dd> that follows, which may hold <p>, <ul> or
  <ol> where the explanation runs to more than a phrase. Setting them as paragraphs that open in
  bold (<p><strong>Power:</strong> …</p>) prints the same ink and keeps none of the structure:
  nothing says how many items there are, which one is being read, or where one explanation ends
  and the next name begins, and there is no way to move from term to term at all. Transcribe each
  <dt> exactly as the page prints the label and add nothing to it — <dt>Name</dt>, never
  <dt>CONTACT: Name</dt> — because the heading, <legend> or <dl> the term sits in already says
  which group it belongs to, and the prefix is a word only you can see.
  Two cases this is not. It is not a way to lay out prose: a paragraph that happens to begin with
  a capitalised phrase is a paragraph, and a <dl> is for a page that names items and explains them.
  And it is not the case where a named item has substantial content of its own — its own table, its
  own procedure, several paragraphs — which is a heading with that content under it by the heading
  rule above. A <dl> is right where an item's explanation is its own text and nothing more.
- TABLE ROW GROUPS: where a table gathers its rows under printed group labels — regions with their
  states indented beneath them, a category with its items, a tax class with the taxes in it — that
  grouping is structure and has to reach the markup. Open a <tbody> for each group, its first row
  holding a single <th scope="rowgroup" colspan="N"> with the group's label (N being the number of
  columns it spans), then the rows of that group as ordinary rows with <th scope="row"> for their own
  labels, and close the <tbody> where the group ends. The <tbody> is what makes the label mean what
  it says: scope="rowgroup" applies a header to the rest of ITS row group, so a table that runs every
  group through one <tbody> has "New England:" applying to the Southeast rows as well, and each group
  after the first inherits the labels of all the groups above it. One <tbody> per group is also the
  table saying where each group ends, which a label row on its own cannot. The same row emitted
  as <td colspan="4">Southeast:</td>, or as <td colspan="4"><strong>Southeast</strong></td>, prints
  the same ink and carries none of it: every member row is then announced with no group at all, and
  a reader who lands on one has no way back to which group it belongs to. Bold or larger type IS how
  a page marks the hierarchy where it prints no other sign, so what that emphasis becomes is the
  rowgroup header, not a <strong> inside a data cell.
  A group boundary is never a reason to start a second table, or to nest one inside a cell: if the
  columns are the same, it is the same table, and the group label is a row within it. Where the page
  reprints a group's name because the group runs on, that reprint opens another <tbody> carrying the
  same label as its rowgroup header, in the same table. A group's total or subtotal row belongs to the same table too, as a row with
  <th scope="row"> for its label, wherever the page prints it — above its rows or below them.
  Two things this is not. A row that names the columns again — a spanning "Federal" over the two
  columns beneath it — is a second tier of COLUMN headers and belongs in <thead> with the row it
  qualifies; this rule is for a row that names a group of the ROWS. And no grouping is invented — a
  table whose rows the page gathers under nothing is one <tbody> and one run of rows, and a label you
  supply is a group only you can see.
- TABLES AND THEIR NAMES: a table is named by its <caption>, and that is the whole of it. The number
  and title the page prints over a table — "Table 8.—Per Capita Income for Selected Income Series,
  by State, 1959" — IS that caption, transcribed into <caption> as the page prints it, number
  included. Do not emit it a second time as a heading, and do not wrap the table in a <section> to
  hang one on. A heading opens a part of the document, so a heading whose whole content is one table
  announces a division the paper never printed, and a reader moving through the outline is told the
  document is organized in a way it is not. The title arriving twice, once from the heading and once
  from the caption, is the smaller half of the harm. The larger half is what the wrapper invites: a
  heading is not a name for a table, so a table given a heading INSTEAD of a caption has no
  accessible name at all — and no linter says so, which means a document can pass every check and
  still hand a reader a table they cannot identify or find again. So where the words over a table are
  its number and title, that is a caption whichever element you reached for first: give the table the
  <caption> the page prints — the title's own words, number included — and emit no heading for it.
  A heading over a table is right where the page's own structure prints one: the heading introduces a
  section of the document, and the table is part of what that section holds. Keep such a heading, and
  give the table its <caption> as well — the two then say different things, one naming the section and
  one naming the table, and neither stands in for the other. What must not happen is a heading you
  supplied because a table looked like it needed one. The rest of the document is the best evidence of
  which you are looking at: where its other tables sit under headings of their own, this heading is
  the page's doing, and one table out of forty wearing an <h2> is the sign the wrapper is yours. You
  are shown one page, so where the rest of the document is not in front of you, decide it on what this
  page prints — a title over a table is a caption, a heading that opens a section with a table inside
  it is a heading — and say in the "log" field which you took it to be.
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
  A symbol that stands for a control is this rule's case: the ■ or ▶‖ printed on a machine's keys,
  a glyph in a table cell that means a button. Transcribe the symbol the page draws and never
  substitute a different one because it is the commoner way to draw that control — the reader is
  being told which key to press, and the drawing is the instruction. Name it from the page: where
  the page collects the symbols as a key or a legend, transcribe that where the page puts it, as a
  <dl> of symbol and control name, and where the page names a control in prose, a caption or a
  column heading, carry that name onto the symbol where it stands (<abbr title="Stop">■</abbr>) so
  a row read on its own still says which key it means — but not both for one symbol, since a
  legend already read is not repeated. A name is the page's or it is nobody's: where nothing on the
  page says what a symbol operates, transcribe it as printed with no expansion invented for it, and
  say in the "log" field which symbols went unexplained. Guessing costs more here than elsewhere,
  because a reader acts on this one — a mislabelled key is a wrong button pressed on a machine.
  title is the attribute for this, and aria-label is not: <abbr> carries no ARIA role of its own, so
  a naming attribute on it is prohibited. The gate demotes that finding rather than reporting it,
  because the element has text of its own, which is the same silence that let a labelled <p> page
  marker ship.
  A key whose symbol is an area of ink is this rule's other case: the bands of a shaded map, the
  fills of a cartogram, the hatchings of a chart. Its symbol half has no words anywhere on the
  page, so the words are yours to write and writing them is transcription rather than the invented
  expansion the first clause forbids — describe the ink as the <dt> and transcribe the page's
  printed wording as its <dd>. Describe it in words and never in markup: a style attribute or a
  coloured <span> hands a screen-reader user nothing, and the description has to survive being
  read aloud. Read each swatch's tone off the swatch itself and never off the order of its labels
  — a key's shades run in the order the printer chose and frequently not in the order its entries
  are listed, so an assumed ramp is a guess that reaches the reader as a fact. Say how many
  entries the key prints — in the alt text where you are describing the key there, since a
  description is scaffolding this prompt asks for by name, and in the "log" field either way.
  Never as a sentence of your own beside the <dl>: that is the prose this rule forbids two
  paragraphs above, and it reads to a verifier as text the page does not print.
  And where two swatches are not distinguishable in the reproduction you
  were given, say exactly that — in the <dt> describing the ink, or in the alt text where you are
  describing the key there, and in the "log" field either way — rather than dividing
  items between them: an item you cannot match to a swatch is left unclassified and said to be
  unclassified, because a reader loses less from a gap the page admits than from a confident
  assignment to the wrong band.
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
  The line a page prints along its head or foot is that same case. A website, an e-mail address, a
  revision or a document number, printed with the words that label them, is a <dl> — not a <p> of
  pipe-separated text, which announces one sentence of run-together values, and not a <ul>, which
  says these are four things of one kind rather than four labelled ones. Mark it the same way on
  every page that prints it: a footer that is a <dl> on page 4 and a sentence on page 5 tells a
  reader the two pages carry different things. What the page prints no label for has no term to
  write — a foot that gives bare values is transcribed as what it is, and writing "Website" over a
  URL the page labelled with nothing puts a word of your own in a <dt>. And the page's own printed
  number is never one of these values: it is carried by the page-break marker's label, by the rule
  above, so a row for it here hands the reader the folio twice.

A page that prints the same content in more than one language gets the same treatment in each.
Every rule above applies to the second column exactly as it does to the first: where the English
steps are an <ol> the French steps are an <ol>, where one recipe's ingredients are a <ul> so are the
other's, and a sub-topic that earns a heading in one language earns it in the other. Structure that
stops at the first language is worse than none, because the document then looks handled to everyone
except the reader it failed. Mark each change of language with lang on the element that holds it —
<section lang="ko">, or lang="es" on the single <td> that switches — using the BCP 47 tag for the
language the page prints there. A page wholly in one language OTHER THAN ENGLISH changes language
nowhere, and is the case that needs the attribute most: put lang on every top-level element you emit
for it. The document you are writing into takes its language from the pages inside it, and can only
do that where they all say what they are: one fragment returned with no lang of its own leaves the
whole document declared English, so a Korean page is delivered as English text, pronounced as
English, to the reader who has no way to see that it is not.
An English page is the case that needs nothing, and the sentence above is not asking for it: English
is what the document declares when its pages give it nothing else to read, so lang="en" on the
elements of an English page changes what a reader is given in no way at all. A page that omits it is
correct and is not to be reported for omitting it. On an element that holds no text of its own — an
<img>, an <hr> — the attribute is meaningless whatever the language.
And transcribe that language; do not translate it. Returning a Korean page in English is not
accessibility work but a different document: those words are not words on the page, the original is
not recoverable from what you emit, and a mistranslation is invisible to exactly the reader who
would be relying on it. What a screen reader needs in order to pronounce the passage at all is the
lang attribute, which is why that is the rule. Say in the "log" field which languages the page
holds.

Where the prompt shows you your previous output for this page, that output is the starting point
and not a draft to replace. Change what you were asked to change — the problem named, the feedback
given — re-check that content against the image, and carry everything else over as it stands: the
same heading at the same level, the same table with the same cells, the same list, the same alt
text, the same lang. Re-deriving the page from the image instead is how the second pass costs a
reader what the first one got right, and nothing downstream can tell that it did: a level that
moved, a cell's list flattened, a <dl> turned back into paragraphs all arrive as this page's
content, and the version that had them right is not kept anywhere. If you can see that something
outside the problem is wrong, fix the problem, leave that alone, and say what you saw in the "log"
field.

If — and only if — this page contains a content type that a DEDICATED specialist agent would
handle clearly better than this general pass (something beyond the common types: paragraph,
heading, list, table, form field, image, quote, caption, footnote), include a
"suggested_agent". Suggest sparingly; omit it (or null) otherwise.
Sheet music is the example to reason from. A page whose content is musical notation cannot be
carried by a description of the staves: what a reader needs is the music — an audio rendering, and
a machine-readable notation such as ABC or MusicXML — and neither is derivable from one look at the
page, which is what a specialist agent is for. So name one, and do not write a measure-by-measure
account of the notation into alt text as a stand-in: "quarter note D, eighth note F sharp" for
forty bars is not the music, and is not usable by anyone.
Then render the page in full anyway. A suggestion is a request and not a delivery — the agent you
name may not exist in this deployment, in which case nothing runs and what ships is exactly what
you returned. So transcribe every word the page prints (title, composer, tempo, lyrics, rehearsal
marks, the caption), put the score itself in a <figure> whose <figcaption> says what the image is —
instrument, key, time signature, how many systems — and say in the "log" field that the audio and
the notation are the specialist's part. A page held back to a stub for a specialist that never runs
is a page that ships as a stub.

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

// A page the agent says has nothing on it: `html` PRESENT and carrying nothing a reader receives,
// with a `log` line saying so. Both halves are load-bearing.
//
// "Carrying nothing" rather than "empty", because the reply the prompt asks for is not the only reply
// the model writes. Across 818 initial renders in the bench logs, 78 delivered a fragment with nothing
// in it for a reader; 45 spelled it as the empty `html` this asked for, and 33 put the blankness into
// markup instead — 18 a bare page-break marker, 13 a comment (`<!-- blank page -->`), 2 an empty
// paragraph — every one of them with a log saying the page is blank (issue #219). Read as content,
// those 33 cost three things: `pages_blank` counted them as pages that produced markup, the document
// carried the comment or the empty `<p>` or an anchor claiming a folio the paper never printed (see
// the marker paragraph below, which recorded this shape from #179 and left it delivering), and the
// refusal at `renderPage` — the one thing on the re-extraction path that stops a declaration deleting
// content Iris already holds (#194) — could not see them at all, so a re-extraction answering
// `<!-- blank page -->` for a page with content replaced the content with the comment.
//
// What a reader receives is `carriesContent` (correction.ts), which is `visibleText` plus the elements
// that are content with no text in them, plus the attributes that make a neutral element one of those
// (#224). So a comment, an empty wrapper and a page-break marker are nothing; a picture, a table, a
// form control and a `<div role="img">` are something. PROSE is something too, deliberately:
// one further render answers `<p><em>This page is blank.</em></p>`, and a page that prints "This page
// intentionally left blank" is a page whose correct transcription is that sentence. Nothing here can
// tell the two apart, so the sentence is delivered as the page said it.
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
// That holds whatever the fragment looked like: how the model spelled its empty page does not decide
// the routing, so a comment or a bare marker with a REFUSED log is the failed page an empty `html`
// with the same log already was. Nine of the 33 markup-spelled declarations above are refused that
// way, and their wordings are #220 — two read as self-contradictions that are not there, seven the
// #190 case in phrasings the exemption below does not reach. Until that issue is settled those nine
// are pages reported as holes in documents that have none, which is the cost this paragraph accepts
// and #179 measured; what they are not any more is invisible, since a refused declaration now reaches
// `page_no_output` with `blank_vetoed` on it whichever way the fragment was written.
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
  /\b(illegible|unreadable|not legible|could ?n[o']?t|can ?not|can'?t|unable|failed|truncat\w*|too \w+ to|too (low|light|dark|faint|poor|noisy|blurry)|blurr\w*|obscur\w*|resolves?|corrupt\w*|partial\w*|error)\b/i;
//
// `smear`, `streak` and `blotch` are here for the reason `dark` is: each names something that can lie
// OVER content, and a sheet with a streak on it is one where "no text is visible" and "the text is
// covered" are the same sentence. `MARK` excludes all three from its exemption on that argument, but
// the argument bought nothing while none of them was a doubt word — "a streak covers most of the sheet;
// no text is visible" had no veto word in it and was delivered blank (issue #226).
//
// The NOUN is what decides, not what the sentence says about its extent: "an ink smear in the lower
// corner, nothing else" refuses, though a smear in a corner covers no more than the `smudges` `MARK`
// exempts two lines up. Reading extent would mean trusting the same sentence whose reliability is in
// question, and the words are near-synonyms a log picks between freely — so the split is which word a
// log reaches for and nothing finer: `smudges` is #193's, with corpus wordings behind it, and these
// three are the ones a covering is described with. What that costs is a glance at a page that was
// fine, which is the trade this file makes everywhere; what reading extent would risk is the page.
//
// Their siblings `spots`, `stains` and `shadows` are deliberately NOT here, and the comment on `MARK`
// says why: they name something in one place, which a page with writing on it is not described as
// having, and `spots` is a word a log may use for the specks it is already allowed to describe.
const DEGRADED_IMAGE_LOG =
  /\b(dark|faint|washed|blurry|blurred|noisy|noise|grainy|pixelat\w*|low[- ]?res\w*|resolution|smear\w*|streak\w*|blotch\w*|(poor|low|bad|degraded)( \w+)? quality|quality (is|was|of)|(out of|not in|soft) focus|did ?n[o']?t load|not load\w*)\b/i;

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
// words it can ever remove are the veto words used AS MODIFIERS of one of them. Two exclusions are
// deliberate, and both were tried the other way and reverted:
//
// `marks` and `markings` are here only as `stray marks`, never bare, because `agents/page.md` uses
// the bare noun for the OPPOSITE case: "where marks do not resolve into characters even then, write
// `[not legible]`" is the instruction for a page that HAS content the agent could not read, where
// empty `html` is the wrong answer. `handwritten marks`, `pen marks` and `blurry marks` therefore go
// on refusing, and `NOT_LEGIBLE_TEXT` below can go on counting `markings` as a name for something
// worth reporting — both as the noun it strips and in `PAGE_BEARS`, where it needs a denial in front
// of it — which bare `marks?` here contradicted.
//
// `spots`, `streaks`, `blotches`, `smears` and `stains` are not here, for the same reason `shadows`
// is not: a dark streak or a dark spot is a condition of the capture rather than something on the
// sheet, and either can cover content — which is why `dark` is a veto word at all. Adding them made
// "the scan shows dark streaks" a blank page. `smudges` stays, as a mark left on the paper.
//
// That argument only bit on the three that name something a reader would have lost content under, and
// only once they were doubt words in their own right: `smear`, `streak` and `blotch` are in
// `DEGRADED_IMAGE_LOG`, so leaving them out here is what keeps them refusing (issue #226) — and the
// comment there says why the noun decides that on its own, without reading how big the log says it is.
// `spots`, `stains` and `shadows` are
// out of both lists on purpose, and the reason is narrower than the one above: they name something in
// ONE PLACE, which is what a scanner leaves and not how a covered page is described — and `spots` is a
// word a log may reach for to name the specks it is already allowed to describe. So a log that says
// only "spots are visible, no text" is believed, and "a streak covers most of the sheet" is not.
//
// What lets bare `marks` in behind one of these words is what the word says about them: `stray`,
// `scattered`, `isolated`, `random` and `residual` place the marks nowhere in particular, which is
// what a scanner leaves and not how a page with writing on it is described. `stray` was here alone
// and the other four are #220's wordings ("Only faint, isolated marks are visible … that do not
// resolve into any characters"). Bare `marks` still refuses on its own, so `handwritten marks`, `pen
// marks` and `blurry marks` are the content-bearing pages #193 kept them for.
const SPARSE = String.raw`stray|scattered|isolated|random|residual`;
// `noise` is a veto word and standing alone it is a claim about the image, but named for the thing
// that made it — `scanning noise`, `scanner noise`, `scan noise` — it names the marks instead: it is
// the class the specks belong to, which is what "consistent with scanning noise" says about them.
// `the scan is noisy` and `there is noise in the scan` have no such word in front of the noun and go
// on refusing (#220).
const MARK = String.raw`specks?|speckles?|speckling|flecks?|dots?|dust|debris|smudges?|blemishes?|artifacts?|(?:${SPARSE})\s+mark(?:s|ings?)?|(?:scan|scanner|scanning)[\s/-]?noise`;
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
// A comma may stand between two of the modifiers, because a stack of them is written as a list as
// often as not: "Only faint, isolated marks are visible" is one phrase, and matching it from
// `isolated` left `faint` behind to veto the page as a doubt about the scan (#220). The head is still
// a marks noun, so the comma widens what may dress those nouns and nothing else — "The page is dark,
// with faint specks" keeps its `dark`, since `with` is not a modifier and the phrase starts after it.
//
// But a comma ends a clause as readily as it separates a list, and that is the one thing the stack
// must not reach across: "the scan is grainy, faint specks are all that appear" and "Scan quality:
// dark, blurry, faint specks throughout" put a doubt word about the IMAGE exactly where a modifier of
// the marks goes, and stripping it ships a grainy capture as a blank page with no marker on it. So
// the comma'd form may not open the clause that describes the capture, while the form without a comma
// is untouched from before #220 and goes on exempting `the visible artifacts are faint specks` as it
// always did. Written as two alternatives rather than one guarded stack for that reason: only the comma
// needs the guard, and the plain form is left free to match further along the same sentence — which is
// what makes a refused comma'd stack behave exactly as it did before #220 rather than keeping words the
// old pattern stripped.
const MARK_QUANTIFIER = String.raw`(?:(?:a|an|the|only|just|some|few|several|couple|of)\s+){0,4}`;
// The guard asks about the CLAUSE, not about the token in front of the stack, because the token is a
// class with no end to it: `is grainy,` was closed by naming the copula, `is very grainy,` by naming
// the degree word, and `is noticeably grainy,` / `is a little dark,` / `is only dark,` were next —
// three roads into the same wording, each of which a list closes one instance of. So the stack may not
// have a copula, a colon or a dash anywhere to its left within its own clause: what those say is that
// the sentence is describing something already named — the scan, the image, the quality of the capture
// — and a modifier of that thing is not a modifier of the marks. Bounded to the sentence, since
// `[^.!?;\n]` cannot cross a full stop, a semicolon or a line break, and bounded in length for the
// reason `DENIAL_STATEMENT_MAX` is: the work per match stays flat.
//
// A hyphen counts only with a space in front of it — spaced it is the dash somebody typed on a
// keyboard without one, unspaced it is inside `washed-out` and inside the phrase's own separator.
//
// Which punctuation resets the reach and which is evidence is the whole of what this decides, so it is
// worth stating rather than leaving to be read off the character class. A full stop and a semicolon
// RESET it: they end a clause, and a stack at the head of a new one has nothing to its left to describe.
// A colon and a dash do not reset it, because they are the evidence — they say what follows describes
// the thing just named. So the same claim gets opposite verdicts on the delimiter the model typed:
// "This page is blank; only faint, isolated marks are visible" declares blank and "Page is blank — only
// faint, isolated marks are visible" does not, because the dash's own reading is that `blank` is what
// the stack is about. Both are pinned, and the second is the cost this guard pays: that page is
// reported failed, which is a glance rather than a page.
//
// A line break resets it too, and on a different ground — layout, not grammar. It ends a note the way a
// full stop ends a sentence, and it OUTRANKS the evidence: `[^.!?;\n]` cannot span it, so a colon at the
// end of a line does not reach the line below, while the same colon inline does ("Page is blank:\nonly
// faint, isolated marks are visible" declares blank; "Page is blank: only faint, isolated marks are
// visible" does not). Both are pinned. That ranking is deliberate and it is a claim about how these logs
// are laid out rather than about what a colon means: a colon at the end of a line is introducing a list
// — "Notes:", "Scan quality:" — and the lines under it are its items, so reading it as a description of
// what the colon named would refuse a blank page for the shape of the note it came in. Inline, the same
// colon has the clause it governs on the same line, which is the case the evidence reading is for.
//
// One thing that follows and is NOT closed: a doubt word leading a stack that opens its own sentence is
// stripped, because there is nothing to its left to say otherwise — "Dark, blurry, faint specks
// throughout, no legible text" is read as the marks and would have refused on `dark` before #220. That
// position is exactly the one #220's nine need (each starts the sentence its marks are in: "Only faint,
// isolated marks are visible…", "A few faint specks or artifacts are present…"), and in it the two
// readings are indistinguishable — `blurry specks` is grammatically the marks, which is the reading the
// exemption exists for, and no wording in the sentence says the model meant the capture. Closing it
// would cost #220 its wordings to catch a sentence nobody has written yet.
const NOT_CLAUSE_HEAD = String.raw`(?<!(?:\b(?:is|are|was|were|be|been|being|appears?|appeared|seems?|seemed|looks?|looked|shows?|showed|showing|remains?|has|have|had)\b|[:—–]|\s-)[^.!?;\n]{0,200})`;
const MARKS_PHRASE = new RegExp(
  String.raw`\b(?:` +
    String.raw`${MARK_QUANTIFIER}${NOT_CLAUSE_HEAD}(?:${MARK_MODIFIER}),[\s/-]+(?:(?:${MARK_MODIFIER}),?[\s/-]+){0,2}` +
    "|" +
    String.raw`${MARK_QUANTIFIER}(?:(?:${MARK_MODIFIER})[\s/-]+){0,3}` +
    ")" +
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
// plainly as `the lines` do. `content` matters most because `NOT_LEGIBLE_TEXT` counts it as a name
// for text on both sides — as the noun it strips and in `PAGE_BEARS` — and no two of the three may
// disagree about the same word. None of this
// costs the four round-9 logs: they all put `content` after the veto word ("do not resolve into any
// characters or content"), never in the gap ahead of it, which is the only region examined.
//
// This list is where the exemption stops being provably safe, and that is a decision rather than an
// oversight. A hand-written list of nouns is as complete as someone's memory: "the graphic does not
// resolve into words" gets through, and so does the next noun after that. The structural version
// would invert it — forbid ANY subject in the gap except the words for the paper itself (`page`,
// `sheet`, `scan`, `margin`), so an unknown noun refuses the declaration instead of exempting it.
// It is not taken because the risk lands on the pages this exists for: the real logs put a subject
// in the gap ("Specks/dots are visible on the page but…", "artifacts of the scan (dust/noise) and…"),
// so the safe direction there is a whitelist of substrate words, which is the same completeness
// problem pointed the other way, and getting it wrong reports a blank page as lost — the #190 defect
// again. The wording needed to reach what this list misses asserts blankness, names the marks, and
// AFFIRMS an unlisted page object between them — denying it is what a blank page's log does, and
// `NEGATED` reads that correctly — with no doubt word anywhere in the log, which nothing in nine
// bench rounds has produced. If a round ever produces one, the noun goes in the list.
const TEXT_NOUN = String.raw`text|texts|content|print(?:s|ing|ed)?|lines?|words?|characters?|letters?|glyphs?|digits?|numerals?|handwriting|writing|typing|paragraphs?|sentences?|headings?|captions?|figures?|images?|illustrations?|diagrams?|tables?|stamps?|signatures?|labels?|logos?|seals?`;
// A name for text only affirms it where it is not NEGATED, which is the difference between "the
// printed text does not resolve" and "no printed text". The prompt asks the agent for both halves of
// the observation in one breath — name the marks, deny the text — so without this the more explicit
// answer is the one that loses its page: adding `no text` to one of #190's own logs took it from
// delivered to lost, and most of what `TEXT_NOUN` lists is a noun a blank page's log DENIES (no
// signature, no stamp, no figures). The one shape where a negative word does not negate the noun
// after it is `nothing but the text` / `nothing except the text` / `no matter the text`, which affirm
// it, so those three are excluded — otherwise which member of the pair got caught also depended on
// how long the phrase was, the 2-word window reaching `handwriting` but falling short of
// `printed text`.
const NEGATED = String.raw`(?<!\b(?:no|not|without|nor|none|nothing|neither)\s(?!(?:but|except|matter)\b)(?:[\w'-]+\s){0,2})`;
// The gap between the marks and the construction: anything that does not affirm text. It may cross
// ONE sentence or semicolon boundary, so the same observation split into two clauses is read the same
// way — "Specks/dots are visible on the page. They do not resolve into any characters." is the same
// answer as the version with a `but` in it, and #190's whole finding was that which pages get lost
// was being decided by wording the agent picks per call.
const MARKS_GAP = String.raw`(?:(?!${NEGATED}\b(?:${TEXT_NOUN})\b)[^.;])*`;
// What the clause after a crossed boundary must open with: a back-reference to the marks just named,
// no subject at all, or a denial. Crossing a boundary is only safe for a CONTINUATION of the
// observation, which is all the comment above claims; without this the marks in one sentence exempt a
// denial about a different page object in the next, and "A few specks of dust are visible. The
// handwritten note in the corner does not resolve into words." reported the page as blank. That is
// the one place where "the veto lists run over the whole log anyway" does not save it, because the
// veto word IS the construction being stripped. Unknown openers refuse, so the list being incomplete
// costs a glance rather than a page.
//
// `it` and `there` carry a verb with them, and a conjunction is only a prefix to one of the others,
// because those three are how a new subject gets across a boundary that a determiner cannot: "It is a
// photograph that does not resolve into detail", "There is a handwritten note that does not resolve
// into words", "But the graphic does not resolve into words" — all three name a page object, and all
// three opened with a word that looked like a back-reference. Bare `does|do|did` has to stay, for the
// subject-less "Does not resolve into printed words.", so it carries its `not` too — otherwise the
// inverted form is the same door again ("Nor does the barcode resolve into words"). `nor` and
// `neither` are prefixes only for the same reason: inversion is what they are for, and a bare one
// swallowed the subject that followed it.
// Names for what a page bears, and what may qualify one, for the `any` branch below. `recogni[sz]able`
// is the one word in any of these lists whose British and American spellings both arrive — one #220
// log is written "recognisable content" — and the spelling a log picks is a per-call choice, so every
// list that names the word names both spellings.
const TAIL_NOUN = String.raw`(?:text|texts|content|words?|characters?|print(?:s|ed|ing)?|writing|markings?|lines?|letters?|glyphs?|digits?|numerals?|figures?|images?|handwriting|anything|something)`;
const TAIL_QUALIFIER = String.raw`(?:a|an|any|no|the|some|other|more|meaningful|legible|readable|printed|typed|visible|discernible|recogni[sz]able|clear)`;
const CONT_CORE =
  String.raw`(?:(?:they|these|those)\b` +
  String.raw`|(?:it|this)\s+(?:doesn'?t|isn'?t|wasn'?t)\b` +
  String.raw`|(?:it|this)\s+(?:does|do|did|is|was)\s+(?=not\b)` +
  String.raw`|there\s+(?:is|are|was|were)\s+(?:no|none|nothing)\b` +
  String.raw`|(?:does|do|did)\s+(?=not\b)` +
  String.raw`|(?:no|none|nothing|not)\b` +
  // `any` names what is denied without being a denial itself, so it is allowed only ahead of a name
  // for text and only as a lookahead — "Not legible text, nor any figures" continues the denial, while
  // "Any printing that may exist does not resolve into readable text" leaves `printing` in the gap,
  // where it still refuses.
  String.raw`|any\s+(?=(?:${TAIL_QUALIFIER}\s+){0,2}${TAIL_NOUN}\b)` +
  // The marks themselves, named again with or without a determiner: `only dust` is as much a
  // continuation as `only the dust`, and requiring the determiner cost the commoner wording.
  String.raw`|(?:(?:a|an|any|some|few|several|more|the|these|those|their)\s+){0,3}(?:(?:${MARK_MODIFIER})[\s/-]+)*(?:${MARK})\b)`;
const CONTINUATION = String.raw`(?:(?:and|but|or|only|just|also|so|then|nor|neither)\s+)?${CONT_CORE}`;
const MARKS_ANCHOR = String.raw`(?<=\b(?:${MARK})\b${MARKS_GAP}(?:[.;]\s*(?:${CONTINUATION}${MARKS_GAP})?)?)`;
// "…specks/dots … do not resolve into any characters": `resolve` is in `UNREADABLE_LOG` for "could
// not resolve", and a destination after it turns the sentence into a denial that the marks are
// characters.
const MARKS_NOT_TEXT = new RegExp(`${MARKS_ANCHOR}\\bresolves?\\s+(?:in)?to\\b`, "gi");
// "specks/dots … not legible text" denies the marks are text; "the text is not legible" is a claim
// about text that exists. Both the word order and the anchor are needed: `the typed lines are not
// legible characters` has the noun after it too, and names no marks.
//
// The trailing guard is for the noun on the FAR side of the construction, which the gap cannot see
// and `TEXT_NOUN` therefore cannot help with: "Some dust. Not legible printing in the margin." names
// marks, then names something the page bears, and being told WHERE it is is what distinguishes it
// from "not legible text or meaningful content", which denies.
//
// So the REST OF THE STATEMENT has to be made of nothing but denial. Not a list of the prepositions
// that refuse — the preposition nobody thought of ("not legible writing over the seal") would cost the
// page — and not a list of the words that may follow either, because each such branch was a door a
// placement walked through one word further along: first `visible in the margin`, then `or the printing
// in the margin`, then a line break before `in the margin`, then `any writing in the margin`. Every one
// of those was the same shape, and each fix bought exactly the wording it named.
//
// A word-by-word whitelist is the version with no next door. What a denial is made of is a small closed
// vocabulary — denials, names for text, names for the marks, names for the whole substrate — and a page
// object is named with a word that is not in it: `margin`, `header`, `corner`, `seal`, `spine`, `note`,
// `signature`. So `not legible text on the page` denies (every word listed) and `not legible text in the
// margin` does not (`margin` is not), whatever punctuation or preposition connects them. A word nobody
// thought of costs a glance, which is the way round this file chooses everywhere else.
//
// The statement ends at a full stop, a `!`, or the end of the log; a comma, a semicolon, a colon or a
// line break does not end it, because these logs are written as loose notes ("Not legible text\nNo
// page-break marker is emitted", sometimes as a `-` list) and a note breaks its line exactly where it
// would otherwise place the text. A `?` anywhere in the statement refuses: "Not legible text?" is the
// model asking whether the page is empty rather than saying it is, and a bare one is the one hedge
// `HARD_DOUBT` cannot see.
// `as` between the two is the same denial with the noun made a predicate of the marks rather than the
// object of the reading: "specks/artifacts are present, which are not legible AS content" and "…are
// not legible content" say the one thing, and only the first was refused (#220). And `marks` joins
// `markings` in the noun list for the same reason it is a `MARK` behind one of the `SPARSE` words: the
// anchor is what decides whether marks are the subject at all, and it has already found a marks noun
// with no name for text since — "The typed lines are not legible marks." reaches no anchor and goes on
// refusing, as does anything the anchor cannot cross a boundary into.
const NOT_LEGIBLE_TEXT = new RegExp(
  `${MARKS_ANCHOR}\\bnot legible\\s+(?:as\\s+)?(?:text|content|words?|characters?|print(?:ed|ing)?|writing|mark(?:s|ings?)?)\\b`,
  "gi",
);
// Nothing here is a veto word except by describing the marks, so a doubt word smuggled into the tail is
// still refused by the two lists afterwards — this decides only whether `not legible` is the denial.
const DENIAL_WORD = new Set(
  (
    "or and nor either neither no not none nothing anything something else any only just more other " +
    "meaningful legible readable printed typed visible present discernible apparent detected seen found " +
    "recognizable clear at all whatsoever anywhere of kind sort type a an the this that these those some " +
    "few several couple is are was were be been being isn't aren't wasn't weren't there it they " +
    "do does did don't doesn't didn't resolve resolves resolving " +
    "resolved remain remains remaining appear appears appearing emitted emit written contain contains " +
    "holds hold marker markers number numbers break page pages sheet sheets scan scans paper image images " +
    "document documents leaf leaves on in across throughout within text texts content contents word words " +
    "character characters letter letters glyph glyphs digit digits numeral numerals figure figures line " +
    "lines print prints printing writing handwriting typing marking markings mark marks paragraph " +
    "paragraphs sentence sentences heading headings caption captions label labels legend legends " +
    "dust speck specks speckle speckles speckling fleck flecks dot dots debris smudge smudges blemish " +
    "blemishes artifact artifacts scanner scanning stray scattered faint tiny small minor isolated random " +
    "residual noise grain " +
    // The rest of the list a denial of content is written as. `structure`, `diagrams` and
    // `illustrations` are #220's wordings ("do not resolve into any characters, images, or
    // structure", "…any characters, words, diagrams, or other content") and are the same kind of
    // word as the `figures` beside them; `recognisable` is `recognizable` as a log spelled it, and
    // every list that names one names both, because which spelling arrives is a per-call choice.
    "structure structures diagram diagrams illustration illustrations recognisable"
  ).split(" "),
);
// The vocabulary above is what a denial is BUILT from, and the same bricks build the opposite claim:
// `only a heading is visible`, `the page contains figures`, `some words remain visible` are made
// entirely of listed words and each says the page has something on it. So a name for what a page
// bears has to be introduced by a denial where it appears — `or content`, `nor any figures`, `no
// writing` — and not by a determiner that affirms it. Naming the substrate is exempt, because `on the
// page` is another way of saying the sheet is empty; that asymmetry is the whole difference between
// the two, and it is the same rule `NEGATED` applies to the gap on the near side of the construction.
//
// Reading back over qualifiers (`or any other printed words`) but never over a determiner is what
// separates `nor the words` — a glance — from `only a heading is visible` — a page.
const PAGE_BEARS = new Set(
  (
    "text texts content contents word words character characters letter letters glyph glyphs digit " +
    "digits numeral numerals figure figures line lines print prints printing writing handwriting " +
    "typing mark marks marking markings paragraph paragraphs sentence sentences heading headings " +
    "caption captions label labels legend legends diagram diagrams illustration illustrations " +
    "structure structures"
  ).split(" "),
);
const DENIAL_CONNECTOR = new Set("no not nor neither none nothing or and any".split(" "));
// Two of those connectors are conjunctions, which introduce an affirmed noun as readily as a denied
// one: `or content of any kind` denies and `and printing is present` affirms, and only what comes
// AFTER the noun tells them apart. So a conjunction may not hand a name for text to a verb that says
// it is there. Nothing else needs this — a determiner is refused already, and a real negator (`no
// writing`, `nor any figures`) has spent itself on the noun.
//
// The verb is looked for past the noun rather than only next to it, because a locative may sit in
// between: `and printing on the page is visible` is `and printing is present` with three words in the
// middle. But the search stops at the first real negator, because that is where the NEXT denied clause
// begins and its verb has nothing to do with this noun. A blank page's log goes on denying in exactly
// that shape — "not legible text or content, and no writing is visible", "…or content; nothing is
// printed", and above all the page-number clause the page prompt asks for ("…not legible text or
// meaningful content, and no printed page number is visible"), which is #190's own log with a comma
// where it happened to have a full stop. Scanning past the negator refused all of those.
const CONJUNCTION = new Set("or and".split(" "));
const NEGATOR = new Set("no not nor neither none nothing".split(" "));
// `detected`, `seen`, `found` and `present` are deliberately NOT here, though they affirm as plainly:
// the tail is governed by the `not` in front of the construction, so they are the denial's own words
// there ("not legible text or content detected" is the commoner wording, and "not legible text
// present" is in the corpus). That leaves `and printing detected` exempt, which is a stilted way to
// say a page has printing on it — and the trade is the same one the file makes everywhere: the
// alternative refuses a wording blank pages are actually written in.
const AFFIRMING_VERB = new Set("is are was were appear appears remain remains contain contains hold holds".split(" "));
const QUALIFIER = new Set(
  "meaningful legible readable printed typed visible discernible apparent recognizable recognisable clear other more".split(" "),
);
// The words that affirm a noun with no verb between them: "heading visible" is "a heading is visible"
// with the copula dropped, which is how a log written in fragments says a page has something on it.
// `detected`, `seen` and `found` are left out for the reason `AFFIRMING_VERB` leaves them out — they are
// the wording a denial reaches for — and `legible` and `readable` are left out because they are read as
// qualifiers in front of the noun everywhere else in the file, and a post-nominal one is not a wording
// these logs use. Every word here is one `DENIAL_WORD` also lists, which is the only way the read is
// reached at all: a statement with a word outside that list in it has already refused a line above.
const PREDICATED = new Set("visible present apparent discernible".split(" "));
// `image` is the one word the lists genuinely disagree about: it is the substrate in "not legible text
// in this image" and a thing the page bears in "an image is visible", and both wordings are ones these
// logs use. So it is read by what introduces it — a locative preposition makes it the scan, anything
// else makes it an object on the paper — rather than being assigned to one list and losing either a
// blank page or a photograph. Only `image` gets this; every other name for a page object is refused by
// `DENIAL_WORD` not listing it at all.
const LOCATIVE_SUBSTRATE = new Set("image images".split(" "));
const LOCATIVE = new Set("in on across throughout within".split(" "));
const DETERMINER = new Set("a an the this that these those".split(" "));
// What may stand between a verb and its object besides a determiner or a qualifier: a count. "There is
// some handwriting", "it shows two headings" are the wordings a page with something on it is described
// in, and without these the gap ended at the count and the affirmation was missed. Safe to allow
// because the negator check runs first, so `no`, `nothing` and `none` still end the object — and
// because a count in front of a marks noun ("a few specks", "several stray marks") is not an
// affirmation subject at all: `TEXT_NOUN` does not list those. Digits need no entry: the tokenizer
// reads letters, so "shows 2 headings" already puts the noun next to the verb.
const QUANTIFIER = new Set(
  "some any both few several many numerous multiple one two three four five six seven eight nine ten".split(" "),
);
// A denial made of nothing but these words is a short one, so a statement that runs past this refuses
// rather than being read further. That keeps the work per match bounded — a log with a thousand
// `not legible text`s in it and no full stop anywhere would otherwise re-read its own tail a thousand
// times — and it keeps the direction right: the cap costs a glance, never a page.
const DENIAL_STATEMENT_MAX = 300;
// The statement after `not legible <noun>`: is every word in it part of the denial?
function deniesToStatementEnd(log: string, start: number): boolean {
  let end = start;
  while (end < log.length && end - start < DENIAL_STATEMENT_MAX) {
    const char = log[end];
    if (char === "." || char === "!") break;
    if (char === "?") return false;
    end++;
  }
  if (end - start >= DENIAL_STATEMENT_MAX) return false;
  const words = log
    .slice(start, end)
    .replace(/[’‘]/g, "'")
    .split(/[^A-Za-z']+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  if (!words.every((word) => DENIAL_WORD.has(word))) return false;
  return words.every((word, i) => {
    if (!PAGE_BEARS.has(word) && !LOCATIVE_SUBSTRATE.has(word)) return true;
    let before = i - 1;
    // Over a qualifier, and over an earlier member of the same list: what governs the first noun in
    // `any characters, words, diagrams, or other content` governs all four, and each of them is
    // checked at its own index anyway, so a name for text between this noun and its connector is one
    // more list member and not a new claim. The same coordination rule `negatedInList` applies from
    // the other side. A determiner still stops the walk, which is what keeps `only a heading is
    // visible` the affirmation it is.
    let listMember = false;
    while (before >= 0 && (QUALIFIER.has(words[before]!) || PAGE_BEARS.has(words[before]!))) {
      if (PAGE_BEARS.has(words[before]!)) listMember = true;
      before--;
    }
    // A noun that OPENS the statement is in the same position as one a conjunction introduced, and for
    // the same reason: the denial in front of the construction is what governs it, and the only thing
    // between them is the comma the list is written with. "…do not resolve into any characters,
    // images, or structure" denies three nouns, and reading the comma as the end of the denial refused
    // four of #220's nine logs on the `resolve` in front of them. Read exactly as `or` is, not more
    // loosely — a verb saying the noun is there still refuses, so "…into any characters, printing is
    // visible" is the failure notice it always was.
    const openedStatement = before < 0;
    if (openedStatement || DENIAL_CONNECTOR.has(words[before]!)) {
      if (!openedStatement && !CONJUNCTION.has(words[before]!)) return true;
      // An affirmation written without a verb has none for the tail read to find: "not legible text,
      // heading visible" and "…do not resolve into any characters, diagrams visible" say the page has
      // something on it in the same words a denial is built from, and the verb the read looks for is
      // simply missing (issue #227). What tells the two apart is the CONNECTOR, not the noun: a denial
      // coordinates its list ("not legible text or diagrams visible" denies both, and #220's own logs
      // are written that way — "any characters, words, diagrams, or other content"), while an
      // affirmation is a fresh clause dropped in behind a bare comma. So only a noun that OPENS the
      // statement is read this way, and a conjunction in front of it keeps the denial it always had.
      //
      // `listMember` is the rest of that same rule: a comma'd list needs no conjunction until its last
      // member, so a noun with an earlier name for text behind it is one more item in the denial and not
      // a new clause, however the item after it reads. That is what keeps "…any characters, words,
      // diagrams, or other content" whole. The narrow reading is the deliberate one: a single noun, then
      // a word saying it is there, and nothing else between it and the comma.
      if (openedStatement && !listMember && PREDICATED.has(words[i + 1] ?? "")) return false;
      const tail = words.slice(i + 1);
      const nextDenial = tail.findIndex((later) => NEGATOR.has(later));
      const governed = nextDenial === -1 ? tail : tail.slice(0, nextDenial);
      return !governed.some((later) => AFFIRMING_VERB.has(later));
    }
    if (!LOCATIVE_SUBSTRATE.has(word)) return false;
    while (before >= 0 && DETERMINER.has(words[before]!)) before--;
    return before >= 0 && LOCATIVE.has(words[before]!);
  });
}
// `resolve into` needs the same tail read, one noun further on. `resolve` is the veto word in that
// clause, so stripping it takes the doubt off the whole rest of the statement with nothing looking at
// what the rest says — and it is the commoner of the two constructions on the pages this exists for
// (three of #190's four logs are written with it), so every placement and every affirmation the
// `not legible` branch refuses was reaching the document through this one.
//
// The object of `into` is exempt from the read, because the `do not` ahead of the construction is what
// governs it: "do not resolve into any characters" denies the characters, and starting the read at
// `characters` would refuse the plainest wording there is ("nothing that would resolve into words").
// Everything after that object is read exactly as the other branch's tail is — so "…into any
// characters or content" still declares the page blank and "…into any characters, only a heading in
// the margin" does not.
const RESOLVE_OBJECT = new RegExp(
  String.raw`^\s*(?:(?:a|an|any|the|some|few|several|more|other|meaningful|legible|readable|printed|typed|visible|discernible|apparent|recogni[sz]able|clear)\s+)*[A-Za-z][A-Za-z'-]*`,
);
function deniesAfterResolveObject(log: string, start: number): boolean {
  // Bounded so the scan stays O(1) per match, the same reason `DENIAL_STATEMENT_MAX` exists.
  const object = RESOLVE_OBJECT.exec(log.slice(start, start + DENIAL_STATEMENT_MAX));
  return deniesToStatementEnd(log, start + (object ? object[0].length : 0));
}
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
  return log
    .replace(MARKS_NOT_TEXT, (match, offset: number, whole: string) =>
      deniesAfterResolveObject(whole, offset + match.length) ? " " : match,
    )
    .replace(NOT_LEGIBLE_TEXT, (match, offset: number, whole: string) =>
      deniesToStatementEnd(whole, offset + match.length) ? " " : match,
    )
    .replace(MARKS_PHRASE, " ");
}

// The other question, and the one nothing above asks: does the log CONTRADICT its own declaration?
// Everything before this decides whether a log casts DOUBT on the blankness it asserts — a failure to
// read, a bad image, a hedge — and a log that says the page is empty and then says, in plain
// affirmative words, that something is on it casts no doubt at all. It states both. So
// `declaredBlank({ html: "", log: "Page is blank. There is handwriting on the page." })` was `true`
// (#194), and the page shipped as an empty fragment with no `@page-failed` marker, nothing in
// `pages_failed` and no incompleteness notice: the run reported a complete document and the reader
// simply did not get that page.
//
// An affirmation refuses the declaration; it does not decide which half of the log is true. There is
// no way to tell from the text, and the two answers cost differently — a page reported lost is a
// glance at a re-extraction, a page dropped in silence is a page nobody knows to look for. Which is
// the direction every rule in this section is chosen for.
//
// Read over the SAME text the veto lists see — the log with the marks phrases removed — because that
// is what makes the check affordable at all. The logs a genuinely blank page is written in affirm
// things constantly, and every one of those affirmations is about the marks: "Some dust is present",
// "Stray markings are visible", "Only scanner dust is present", "The specks are scanner dust". With
// the marks phrase gone, those sentences have no subject left to affirm anything about, so they need
// no exception here — the exemption that already exists for describing the paper does the work.
//
// The subject list is `TEXT_NOUN`, which is where the marks vocabulary is deliberately absent: `mark`
// and `markings` are things a blank page's log identifies ("The visible marks are artifacts of the
// scan") as readily as things a page bears, and #193 settled that ambiguity by keeping bare `marks`
// out of the exemption rather than out of the noun lists. Reusing `TEXT_NOUN` inherits that decision
// instead of taking it again in the other direction — which is what an affirmation check written
// around `PAGE_BEARS` would have done, since `PAGE_BEARS` has `marks` in it and "The marks are
// artifacts." would then have reported a blank page as lost. That is the #190 defect, and the issue
// named it as the thing a fix must not buy.
const AFFIRMED_NOUN = new RegExp(`^(?:${TEXT_NOUN})$`, "i");
// `there is/are` puts the noun after the verb, so the subject-verb order below never sees it, and
// "There is handwriting on the page." is the plainest of the five wordings #194 measured.
const EXISTENTIAL = new Set("is are was were".split(" "));
// The transitive shape puts the noun after the verb too, for a different reason: the subject is the
// PAPER and the text is the object. "The page contains handwriting", "the sheet still bears a
// heading", "it shows two headings" are each an affirmation the subject-verb scan below cannot see,
// because the word in front of the verb is not a name for text. Measured: without this branch, "Page
// is blank. The page contains handwriting." declared the page blank.
//
// The object is read with the same rules `there is` uses — a gap of determiners and qualifiers, a
// negator ends it — since the two constructions differ only in what stands in front of the verb. And
// no particular subject is required: whatever the log says bears the text, the object is what it says
// is on the page, and the wordings a blank page uses are denials of that object ("the page contains
// no legible text", "the specks show nothing", "the marks do not resolve into characters"), which the
// negator rules refuse either side of the verb. A list of allowed bearer nouns would only add a way
// to miss one.
const TRANSITIVE_AFFIRM = new Set(
  "contain contains contained hold holds held bear bears show shows has have had carries carry".split(" "),
);
// How far back a negator reaches for a VERB it governs (`does not contain`, `the specks have not
// resolved`). Three words covers a determiner and two qualifiers, which is what these logs put
// between the two, and stopping there is what keeps `and printing` — three words past a `not` that
// governs a different noun — an affirmation. A coordination is a list of NOUNS, so a verb is never a
// member of one and this window is all the reach it needs; the noun's own reach is `negatedInList`.
const AFFIRM_LOOKBACK = 3;
// Words that may stand between a verb and the noun it introduces (`there is`, `contains`).
const OBJECT_GAP = 3;

interface Word {
  word: string;
  // Whether a comma closes this word. The one piece of punctuation the scan needs: see the
  // parenthetical rule in `affirmingVerbAfter`.
  comma: boolean;
}

function words(statement: string): Word[] {
  const out: Word[] = [];
  for (const m of statement.matchAll(/([A-Za-z][A-Za-z'’-]*)(\s*,)?/g)) {
    out.push({ word: m[1]!.toLowerCase().replace(/[’]/g, "'"), comma: Boolean(m[2]) });
  }
  return out;
}

// `image` is the word the lists genuinely disagree about, and it disagrees here too: "the image is
// slightly rotated" is the scan and "an image is visible" is something on the paper, and both are
// wordings these logs use — the first is in the corpus as a page that must still be delivered
// (geometry is not legibility, so `DEGRADED_IMAGE_LOG` lets it through on purpose). `LOCATIVE`
// settles the same ambiguity for the denial tails, but it cannot settle this one: there is no
// preposition in front of either.
//
// What separates them is the article. The scan is referred to definitely, because the log has been
// talking about it all along — `the` image, `this` image — and a thing on the page is introduced
// indefinitely, because it is being mentioned for the first time. So a definite `image` is not an
// affirmation subject, and every other name for a page object is one however it is introduced.
// The cost is "The image in the corner is a photograph", which is missed; the alternative was
// refusing a measured blank page, which is the defect (#179) this file exists downstream of.
const DEFINITE = new Set("the this that these those its their".split(" "));
function definiteBefore(tokens: Word[], i: number): boolean {
  let k = i - 1;
  while (k >= 0 && QUALIFIER.has(tokens[k]!.word)) k--;
  return k >= 0 && DEFINITE.has(tokens[k]!.word);
}

// A word that is both a name for text and something a page can BE is a participle behind a copula, and
// there is exactly one of those: `printed` is in `TEXT_NOUN` and in `QUALIFIER` both, the same overlap
// `exceptiveOrLocativeObject` settles for the object of a denial. "No page number IS PRINTED on the
// page itself, but the file metadata indicates this is page 4 of 25" is a denial of the page number,
// and taking `printed` for a subject of its own handed it the next affirming verb in the sentence —
// ten words and a `but` away, in a clause about where the number came from — which reported a blank
// page as lost (#220). Nothing is missed by skipping it: "The heading is printed on the page" affirms
// through `heading`, which is a subject the loop reads two words earlier and finds the same `is` for.
const COPULA = new Set("is are was were be been being isn't aren't wasn't weren't".split(" "));
function participleAfterCopula(tokens: Word[], i: number): boolean {
  if (!QUALIFIER.has(tokens[i]!.word)) return false;
  const before = tokens[i - 1];
  return before !== undefined && COPULA.has(before.word);
}

// The page's own printed number is the one thing a page can bear that a reader never receives. The
// prompt forbids transcribing the folio as text (`agents/page.md`: "Do not transcribe the folio as
// text beside the marker either"), the only place its number may live is the page-break marker's
// label, and `renderPage` discards that marker on every accepted declaration. So a log that says the
// page is empty and then names its printed page number contradicts nothing: there is no content a
// reader loses on that page, which is the only question this check asks. Before this, a page whose
// only printed content WAS its folio — a correct answer to the prompt, and a page with nothing to
// transcribe — was refused in three of the four wordings it reports itself in and lost as a failed
// page (#222).
//
// The refusal came from `printed` every time. It is in `TEXT_NOUN` for the noun sense ("printing is
// visible") and here it is an adjective on the number, the same overlap `participleAfterCopula`
// settles for the copula shape; the intersection of `TEXT_NOUN` and `QUALIFIER` is that one word, so
// reading the qualifier list is a way of asking whether this subject could be an adjective at all.
//
// What is skipped is the SUBJECT, not the statement: the loop keeps reading, so "The printed page
// number and a heading are visible." still affirms through `heading` two words later, and only a log
// whose sole named subject is the folio is let through. `page number` is required as a phrase —
// `number` alone names a figure number or a total as readily as a folio, and `numbers are visible` is
// a page with content on it.
// `numeral` and `numerals` are deliberately NOT here, though `page numeral` is as much a folio as
// `page number` is: `numerals?` is itself in `TEXT_NOUN`, so skipping the `printed` in front of it
// hands the affirmation to the noun two words on and the verdict does not move — only the span
// `blank_contradicted` quotes does (#230's review measured both trees). An entry that cannot change an
// answer is an entry claiming a coverage it does not have, and covering those two would mean taking
// `numerals` out of the names for text or stepping the loop past a noun it would otherwise read.
// `number` and `numbers` are outside `TEXT_NOUN`, which is what makes them the entries doing the work.
const FOLIO_HEAD = new Set("folio folios pagination".split(" "));
const FOLIO_COUNT = new Set("number numbers".split(" "));
function folioAt(tokens: Word[], i: number): boolean {
  const word = tokens[i]?.word;
  if (word === undefined) return false;
  if (FOLIO_HEAD.has(word)) return true;
  return (word === "page" || word === "pages") && FOLIO_COUNT.has(tokens[i + 1]?.word ?? "");
}

function negatedBefore(tokens: Word[], i: number): boolean {
  for (let k = Math.max(0, i - AFFIRM_LOOKBACK); k < i; k++) {
    if (NEGATOR.has(tokens[k]!.word) || tokens[k]!.word === "without") return true;
  }
  return false;
}

// The vocabulary a coordination of nouns is built from, beyond the names for text themselves and the
// qualifiers that dress them: the conjunctions that join the members, the `of any kind` that trails
// one, and the page's own furniture named inside such a list (`no printed page number or heading`).
// Deliberately not a determiner, not a count, not a verb and not a pronoun — each of those ends the
// walk below, which is what keeps `an illustration is visible`, `only a heading is visible`, `it
// shows two headings` and `some words remain visible` the affirmations they are.
//
// `handwritten` and its spellings are here rather than in `QUALIFIER`, which four other functions
// read: what they are needed for is reaching back over `no printed or handwritten content`, and
// widening the qualifier list would change how the denial tails and the object gaps are read too.
//
// `visual` is here for the same reason and from the same measurement: "No readable text or meaningful
// VISUAL content is present." is one denial of two coordinated nouns, and the one word between the
// second noun and the qualifier in front of it was enough to end the walk — so `content` found the
// list's shared `is present` and a blank page was reported lost (#220).
const CHAIN_LINK = new Set(
  ("or and either handwritten hand-written typewritten of any all at whatsoever else kind sort type " +
    "page pages number numbers visual").split(" "),
);
// A coordination has no length limit, so this walk needs one: a log with two hundred conjoined nouns
// in it should not be re-read from every one of them. Sixteen tokens is longer than any denial the
// corpus contains (the longest, `no content of any kind, printed or handwritten`, is seven), and
// running past the cap stops the walk, which reports the page failed — a glance, not a lost page.
const NEGATOR_CHAIN_MAX = 16;

// Whether a negator governs this noun. A negator distributes over the whole coordination it opens —
// `no legible text or handwriting`, `no printed words, lines, or characters`, `no text, printing,
// figures or writing` — and how long that coordination is is a wording the model picks per call. A
// fixed window therefore decided by LIST LENGTH whether the last noun in a denial read as denied:
// with a three-word lookback `no legible text or handwriting is present` put `no` four tokens back,
// so `handwriting` read as un-negated, found the list's own shared verb, and a page with nothing on
// it was reported lost. Eleven of about thirty realistic blank-page wordings flipped that way, which
// is #190's defect from the other end — the one thing #194 says a fix must not buy.
//
// So the walk is over the words a coordination is MADE of and stops at anything else, the same shape
// `deniesToStatementEnd` uses for the far side of a denial. It cannot reach past a verb, which is
// what keeps a second clause's subject its own (`no text is visible and handwriting is present`
// affirms `handwriting`), and it cannot reach past a determiner or a count, which is what keeps the
// affirmations #194 measured. `and printing, no page number, is visible` — the shape this must not
// swallow — reaches the document with its `not legible text` already stripped from the veto scope, so
// there is no negator left in front of `printing` to find.
// A negator distributes over a coordination only if it has a member of its own to distribute FROM,
// and one case in this file can take that member away: the marks phrase is stripped before any of
// this runs, so "No stray marks, and handwriting is visible" arrives as `no … and handwriting` with
// the noun the `no` denied gone from the text. Reading the conjunction as a coordination there would
// hand `handwriting` a negator that never governed it, and denying the marks says nothing about text
// — which is the same asymmetry `TEXT_NOUN` encodes everywhere else in this section. So a negator
// whose own next word is a conjunction is not one this noun sits in a list with.
function negatedInList(tokens: Word[], i: number): boolean {
  for (let k = i - 1; k >= 0 && i - k <= NEGATOR_CHAIN_MAX; k--) {
    const { word } = tokens[k]!;
    if (NEGATOR.has(word) || word === "without") {
      return !(k + 1 < tokens.length && CONJUNCTION.has(tokens[k + 1]!.word));
    }
    if (QUALIFIER.has(word) || CHAIN_LINK.has(word) || AFFIRMED_NOUN.test(word)) continue;
    return false;
  }
  return false;
}

// Where the verb that affirms the noun at each position is, if there is one. The scan STOPS at a negator, because a
// negator is where the next denied clause begins and its verb has nothing to do with this noun —
// which is the rule `deniesToStatementEnd` already applies for the same reason, and the reason a
// blank page's own log survives this: "not legible text or content, and no writing is visible" has an
// `is` in it, three words past a `no` that owns it.
//
// The exception is a denial set off by COMMAS. "…and printing, no page number, is visible" is a
// parenthetical with `printing` as the subject of `is visible`, and it was the one of #194's five
// shapes that the stop rule alone would have let through. So a negator whose phrase both opens after
// a comma and closes on one is stepped over rather than stopped at. Nothing a blank page is written in
// has that shape: the negators in those logs open on `and`, on `or` or on a fresh clause ("…or
// content, and no printed page number is visible"), where the closing comma never comes.
//
// Computed for every position of the statement in one backwards pass rather than scanned forward per
// noun. Same answers — each position is the answer for the position after it, unless the token is
// itself a verb or a negator — and it is the one scan in this section that was quadratic in the
// length of a statement with no full stop in it, which is the shape `DENIAL_STATEMENT_MAX` caps for
// the same reason. A cap would not do here: a statement too long to read is one whose contradiction
// goes unfound, and that costs the page rather than a glance.
function affirmingReach(tokens: Word[]): number[] {
  const reach = new Array<number>(tokens.length + 1).fill(-1);
  for (let k = tokens.length - 1; k >= 0; k--) {
    const token = tokens[k]!;
    if (AFFIRMING_VERB.has(token.word)) {
      reach[k] = k;
      continue;
    }
    if (NEGATOR.has(token.word)) {
      if (k === 0 || !tokens[k - 1]!.comma) continue; // stays -1: the clause here is denied
      let close = k;
      while (close < tokens.length && !tokens[close]!.comma) close++;
      if (close < tokens.length) reach[k] = reach[close + 1]!;
      continue;
    }
    reach[k] = reach[k + 1]!;
  }
  return reach;
}

// A verb the negator FOLLOWS denies its clause, and the subject-verb scan is the one shape in this
// section that could not see it: `negatedInList` reads the words in front of the noun and
// `affirmingReach` marks a verb from its own position, so nothing looked one word to the right of the
// verb and `Text is not present.` read as an affirmation of `text` — a blank page reported lost, with
// the negator quoted inside the evidence for it (`affirmed: "text is not"`, which is the tell).
// `agents/page.md` asks the agent to say in the log that the page is empty and does not fix the wording
// of the denial, so subject-verb-`not` is as ordinary an answer as `no text is present`, and #190
// recorded that which pages get lost was being decided by the wording the model happened to pick.
//
// The negator must be the word RIGHT AFTER the verb, with no gap allowed. Every wording on this axis
// puts it there (`is not present`, `was never printed`, `are not present`), and a gap would cost a
// page rather than a glance: "Handwriting is clear, nothing else is on the sheet." affirms
// handwriting, and reaching past `clear` to that `nothing` would refuse the affirmation and ship the
// page as empty in silence — the #194 defect this check exists to close. Same reason `but` is not
// followed: "Handwriting is visible but no printed text is present." is a page with writing on it.
//
// `never` and the complements below earn their place here rather than in `NEGATOR`, which five other
// functions read: "text was never printed" and "printed text is absent" are denials, but widening the
// negator vocabulary would change how the denial tails, the object gaps and the coordination walk all
// read at once, and each of those trades in the other direction.
//
// A negative complement is how the same denial is written without a negator at all — `is absent`,
// `is missing`, `is nowhere on the sheet` — and #200's review measured eight such wordings reported
// failed. The list is closed and short on purpose: each word means "not there" on its own, with no
// reading where it says something IS on the paper, which is what separates it from an open-ended
// widening. `devoid` and `lacks` are absent because they take a preposition or an object and the
// subject-verb scan does not reach them anyway. A qualifier between the verb and the complement
// ("Text is entirely absent.") is still refused, for the same reason no gap is allowed above: the gap
// costs a page and the refusal costs a glance.
// A denial does not have to cover the whole sheet, and #204 is the shape where it does not: the log
// denies one part of the page and says in the same breath what is on the rest of it.
// `denialAffirmations` below reads that, and the three constructions it reads are the three the corpus
// and #200's review put on record.
const NEGATIVE_COMPLEMENT = new Set(["absent", "missing", "nowhere", "nonexistent", "lacking"]);

// The complements that say something IS there, for the coordination read: `absent from the top half
// and PRESENT at the bottom`. Overlaps `QUALIFIER` on purpose rather than reusing it — a qualifier is
// what may stand between a verb and its noun, and half of that list (`meaningful`, `other`, `more`)
// says nothing about whether anything is on the paper, while `printed` and `written` belong here and
// are the wording a partial denial reaches for ("absent from the top and printed at the bottom").
// The overlap with `TEXT_NOUN` on `printed` is NOT deliberate in the same way: see the object walk.
const AFFIRMING_COMPLEMENT = new Set(
  "present visible legible readable discernible apparent recognizable recognisable shown printed typed written handwritten stamped".split(" "),
);
// What a predicate complement may tail into. A complement standing at the end of its clause, or
// running on into a place, is the clause's own predicate — `and present at the bottom`, `and still
// visible`. One with a noun after it is an adjective ON that noun, and the noun decides: `but visible
// dust remains` is scanner dust on a page that is still blank. Closed and short, like every list
// here; a wording that tails into something not on it costs a page that says so twice.
const AFTER_COMPLEMENT = new Set(
  "at in on within across throughout near under above below beneath over beside along to toward towards here there elsewhere everywhere only also too instead".split(
    " ",
  ),
);
// How many adverbs may stand between the joiner and the complement. `and still clearly visible` is
// two, and no wording in the corpus has three; the bound is here rather than absent because the walk
// runs at every position of the statement and an unbounded run of them is a second quadratic.
const ADVERB_GAP = 3;
// What may join the two halves. `or` is deliberately absent: `absent or present` is not a statement
// about a page, and every `or` in these logs joins members of a denied list, which is the one thing
// this section may not start reading as an affirmation (`negatedInList`'s eleven pinned wordings).
const CONTRAST = new Set("and but yet while whilst though although".split(" "));
// An adverb that may stand between the joiner and the complement: `and still present`, `but clearly
// visible`. Kept apart from `QUALIFIER` for the reason above.
const CONTRAST_ADVERB = new Set("still also clearly plainly instead however again nevertheless".split(" "));
// The exceptive prepositions. What follows one of these after a denial is asserted to be on the page
// — that is the whole job of the word — so no article is required, which is what separates this read
// from the prepositional one below: `nowhere except a stamp at the top` introduces the stamp for the
// first time. `but` is here as well as in `CONTRAST` (`nothing but a stamp`), and is safe in both
// because the object walk refuses anything that is not a name for text.
const EXCEPTIVE = new Set("except excepting besides but apart aside save excluding".split(" "));
// `other` is exceptive in `nowhere other THAN a stamp` and is not exceptive in `no other text is
// present`, where it is the qualifier five other functions in this file read it as — the second is a
// wording a blank page uses and the first is a page with a stamp on it. So the pair is required, and
// nothing else in this file has to change.
const EXCEPTIVE_PAIR = new Map([["other", "than"]]);
// What may stand between an exceptive and its object: `except for the heading`, `other than a stamp`,
// `apart from the signature`.
const EXCEPTIVE_GAP = new Set("for than from of".split(" "));
// A locative preposition whose object is a thing the page bears — `missing from the figure on the
// page`, `absent from the diagram shown here`. The object has to be DEFINITE here, and that is the
// whole safety of this read: a denial names the substrate indefinitely as often as not (`absent from
// a page this faint`), while a definite noun is one the log has been talking about, so it exists.
// `into` is deliberately not a member: `do not resolve into characters` and `nothing that resolves
// into words` are the commonest denials in the corpus, and their objects are exactly what is NOT
// there.
const DENIAL_PREPOSITION = new Set("from on in at within across beside under above near beneath over".split(" "));

// The affirmation hiding behind a denial, as the index of the word that carries it, or -1. Reached
// only once the clause has already been read as denied, so everything here is about what the log says
// about the REST of the page.
//
// Three reads, and the direction of error is what picks each one. An affirmation this misses ships a
// page with a stamp on it as blank paper, in silence and with no marker (#179/#190/#194); an
// affirmation it invents reports a blank page as failed, which costs a glance. So each read is written
// to fire on the shapes the corpus contains and to stay off the denials pinned in
// `test/envelope-as-content.test.ts`, and where the two could not both be had, the glance wins.
//
//   1. A contrast whose complement affirms. `Text is absent from the top half and present at the
//      bottom.` — one subject, two complements, and the second says the text is there. The joiner
//      must come FIRST and the complement immediately after it, which is what keeps `Handwriting is
//      not present either.` a denial: its `present` sits behind the negator with no joiner in front
//      of it. Only reached with a subject in hand, since the affirmation is about that subject.
//   2. An exception. `Printing is nowhere except a stamp at the top.` The exception is the content:
//      a log that says what is NOT on the page and then names the one thing that is has described a
//      page with something on it, whatever the proportions.
//   3. A definite noun in a locative object. `A caption is missing from the figure on the page.`
//      denies the caption and presupposes the figure. `the`/`this`/`its` is required, for the reason
//      `LOCATIVE_SUBSTRATE` and `definiteBefore` exist: an indefinite noun there is as likely to be
//      the scan or the paper as a thing on it, and `image` stays the scan however it is introduced.
//
// The walk stops at a negator, because a second denial in the same statement is a second denial and
// not the affirmation this is looking for ("Text is absent and no handwriting is present." is a blank
// page). It does not stop at a new subject: a clause of its own is found by the caller's own loop,
// which reads every name for text in the statement, so anything this walk reaches past has already
// been offered a verb of its own.
//
// Read 1, at one position. -1 for no affirmation here, which is not terminal: a joiner that leads
// nowhere is just a joiner.
function contrastAffirmed(tokens: Word[], k: number): number {
  if (!CONTRAST.has(tokens[k]!.word)) return -1;
  let j = k + 1;
  while (j < tokens.length && j <= k + ADVERB_GAP && CONTRAST_ADVERB.has(tokens[j]!.word)) j++;
  const complement = tokens[j];
  if (complement === undefined || !AFFIRMING_COMPLEMENT.has(complement.word)) return -1;
  // The complement has to be its clause's predicate and not an adjective on some other noun. Reads 2
  // and 3 below ask their object to be a name for text and this read has no object to ask about, so
  // the question it can ask is what the complement modifies: `and present at the bottom` predicates
  // over the subject the caller is holding, while `but visible dust remains` says something about
  // dust, and `dust` is outside `TEXT_NOUN` for the reason #193 put it there. Without this the one
  // read that cannot see the noun class reported blank pages with scanner dust on them as failed.
  // A name for text after the complement affirms whichever way it is read, so it passes too.
  const next = tokens[j + 1];
  if (next === undefined || complement.comma || AFTER_COMPLEMENT.has(next.word) || AFFIRMED_NOUN.test(next.word)) {
    return j;
  }
  return -1;
}

// Reads 2 and 3, at one position: the object of an exceptive or of a locative preposition. `null` for
// no affirmation here, -1 for a stop — a negator standing where the object goes denies the rest of
// the statement as surely as one standing on its own.
function exceptiveOrLocativeObject(tokens: Word[], k: number): number | null {
  const { word } = tokens[k]!;
  const paired = EXCEPTIVE_PAIR.get(word);
  const exceptive = EXCEPTIVE.has(word) || (paired !== undefined && tokens[k + 1]?.word === paired);
  if (!exceptive && !DENIAL_PREPOSITION.has(word)) return null;
  const definiteOnly = !exceptive;
  for (let m = k + 1; m < tokens.length && m <= k + 1 + OBJECT_GAP; m++) {
    const object = tokens[m]!.word;
    if (NEGATOR.has(object)) return -1;
    // `printed` is in `TEXT_NOUN` and in `QUALIFIER` both, and here the qualifier reading is the only
    // one that can be right: `in the printed area of the form`, `within the printed border`, `on the
    // printed side` are how a blank pre-printed form and a blank verso are described, and taking the
    // adjective for the object reported all of them failed — with the same truncated evidence #190
    // left behind (`affirmed: "no content is present in the printed"`). Definiteness cannot help,
    // since `the` is what makes the read fire at all. Skipping it loses nothing, because the real
    // object is still ahead when there is one: `from the printed heading` affirms one word later.
    // `affirmedObjectAfter` keeps reading the word as a noun, because a match there ADDS an
    // affirmation and the error runs toward a glance; here it runs toward a false failure notice.
    if (AFFIRMED_NOUN.test(object) && !QUALIFIER.has(object)) {
      if (LOCATIVE_SUBSTRATE.has(object)) break;
      if (definiteOnly && !definiteBefore(tokens, m)) break;
      return m;
    }
    if (!DETERMINER.has(object) && !QUALIFIER.has(object) && !QUANTIFIER.has(object) && !EXCEPTIVE_GAP.has(object)) {
      break;
    }
  }
  return null;
}

// Both walks, for every position of the statement, in one backwards pass. Same answers as scanning
// forward from each denial — the answer at a position is the answer at the position after it unless
// the token there carries a hit or a stop — and computed this way for the reason `affirmingReach`
// is: forward-per-denial was quadratic in the length of a statement with no terminator in it, which
// is the one input shape that has no bound. #204's review measured it at 36k words: 9.8ms before the
// walk existed, 7.8s after, on a server that runs one request at a time. A cap will not do here for
// the reason given there — a statement too long to read is one whose contradiction goes unfound, and
// that costs the page rather than a glance.
//
// `subject` is a yes/no rather than a position, so two arrays are enough: read 1 predicates over the
// subject the caller has in hand, and is off in the scan that has none.
function denialAffirmations(tokens: Word[]): { withSubject: number[]; plain: number[] } {
  const withSubject = new Array<number>(tokens.length + 1).fill(-1);
  const plain = new Array<number>(tokens.length + 1).fill(-1);
  for (let k = tokens.length - 1; k >= 0; k--) {
    const { word } = tokens[k]!;
    if (NEGATOR.has(word) || word === "never") continue; // both stay -1: this is where the walk stops
    const object = exceptiveOrLocativeObject(tokens, k);
    plain[k] = object === null ? plain[k + 1]! : object;
    // Read 1 first at the same position, which is what makes `nothing but a stamp` an exception and
    // `absent but still visible` a contrast: `but` is in both lists and the complement decides.
    const contrast = contrastAffirmed(tokens, k);
    withSubject[k] = contrast >= 0 ? contrast : object === null ? withSubject[k + 1]! : object;
  }
  return { withSubject, plain };
}

function deniedAfterVerb(tokens: Word[], verb: number): boolean {
  const next = tokens[verb + 1];
  if (next === undefined) return false;
  if (NEGATIVE_COMPLEMENT.has(next.word)) return true;
  if (!NEGATOR.has(next.word) && next.word !== "never") return false;
  // A negator in front of a negative complement is two denials making an affirmation: "Handwriting is
  // not absent." is a page with writing on it, and reading it as a denial would ship that page empty
  // in silence. Contrived beside `is not present`, and it costs one lookup to not get wrong.
  const after = tokens[verb + 2];
  return after === undefined || !NEGATIVE_COMPLEMENT.has(after.word);
}

// The noun a post-verb construction affirms — the object of `there is` or of a transitive verb — or
// -1. Shared by both because both ask the same question of the same words.
function affirmedObjectAfter(tokens: Word[], verb: number): number {
  for (let k = verb + 1; k < tokens.length && k <= verb + OBJECT_GAP; k++) {
    const { word } = tokens[k]!;
    // A negator ends it: "there is nothing to transcribe", "there is no text", "the page contains no
    // legible printing" are how a blank page says it, and they are the commonest of these in the
    // corpus.
    if (NEGATOR.has(word)) return -1;
    if (AFFIRMED_NOUN.test(word)) {
      // `image` is read by its article here as it is everywhere else in this file: "the frame
      // contains the image" is the scan being described, not a photograph on the paper.
      return LOCATIVE_SUBSTRATE.has(word) && definiteBefore(tokens, k) ? -1 : k;
    }
    if (!DETERMINER.has(word) && !QUALIFIER.has(word) && !QUANTIFIER.has(word)) return -1;
  }
  return -1;
}

// The affirmation, as the words that make it, or null. Returned rather than a boolean so the refusal
// can say what it saw: `blank_vetoed` exists because #190 had to trace four pages back to a word by
// hand, and a contradiction is harder to spot in a log than a doubt word is.
export function contentAffirmed(scope: string): string | null {
  // A statement is what a `.`, `!`, `?`, `;` or a line break ends. Looser than the denial reads
  // above, which have to cross a line break because these logs put one where a comma belongs — here
  // the boundaries only limit how far a subject may reach for its verb, so a boundary the denial
  // scan crosses is one this one is free to stop at.
  for (const statement of scope.split(/[.!?;\n]+/)) {
    const tokens = words(statement);
    const reach = affirmingReach(tokens);
    const affirmed = denialAffirmations(tokens);
    for (let i = 0; i < tokens.length; i++) {
      const { word } = tokens[i]!;
      if (word === "there" && i + 1 < tokens.length && EXISTENTIAL.has(tokens[i + 1]!.word)) {
        const noun = affirmedObjectAfter(tokens, i + 1);
        if (noun >= 0) return tokens.slice(i, noun + 1).map((t) => t.word).join(" ");
        continue;
      }
      if (TRANSITIVE_AFFIRM.has(word) && !negatedBefore(tokens, i)) {
        const noun = affirmedObjectAfter(tokens, i);
        if (noun >= 0) return tokens.slice(i, noun + 1).map((t) => t.word).join(" ");
        continue;
      }
      if (!AFFIRMED_NOUN.test(word) || negatedInList(tokens, i) || participleAfterCopula(tokens, i)) continue;
      if (LOCATIVE_SUBSTRATE.has(word) && definiteBefore(tokens, i)) continue;
      // `printed page number`, `printed folio` — a name for text dressing the one thing on the paper
      // this pipeline never delivers (`folioAt`).
      if (QUALIFIER.has(word) && folioAt(tokens, i + 1)) continue;
      const verb = reach[i + 1]!;
      if (verb < 0) continue;
      if (!deniedAfterVerb(tokens, verb)) {
        return tokens
          .slice(i, Math.min(verb + 2, tokens.length))
          .map((t) => t.word)
          .join(" ");
      }
      // Denied — but a denial can cover part of the page and say what is on the rest of it, and the
      // affirmation then sits past the complement that denied this clause (#204). The span quoted
      // runs from the subject, so `blank_vetoed` shows the whole shape and not just the half that
      // affirms: "text is absent from the top half and present" reads as the contradiction it is.
      const rest = affirmed.withSubject[Math.min(verb + 2, tokens.length)]!;
      if (rest >= 0) {
        return tokens
          .slice(i, rest + 1)
          .map((t) => t.word)
          .join(" ");
      }
    }
    // The same shapes with the denial written in front of its noun, where the loop above never
    // reaches a subject at all: `No printing except a stamp at the top.` is denied by
    // `negatedInList`, and the stamp it names has no verb of its own for `affirmingReach` to find.
    // Read from the denial rather than from a subject, so the contrast rule is off here — it needs a
    // subject to be a contrast about, and `no printed text, and handwriting is present` is pinned as
    // one denied list rather than as a denial and an affirmation.
    const denial = tokens.findIndex(
      (t) => NEGATOR.has(t.word) || t.word === "never" || NEGATIVE_COMPLEMENT.has(t.word),
    );
    if (denial >= 0) {
      const named = affirmed.plain[denial + 1]!;
      if (named >= 0) {
        return tokens
          .slice(denial, named + 1)
          .map((t) => t.word)
          .join(" ");
      }
    }
  }
  return null;
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
  // The self-contradiction that refused it, where there was one (#194): the log asserted the page is
  // empty and then said something is on it. Kept apart from `vetoes` because it is a different
  // finding with a different remedy — a doubt word means the page could not be read and wants a
  // better image, an affirmation means the agent answered with no page for a page it says has
  // content on it, and `agents/page.md` already tells it to write `[not legible]` instead.
  affirmed?: string;
}

// Exported for the unit test: this predicate is the whole distinction between a page delivered
// empty and a page reported lost, and it is worth pinning on the reply shapes directly.
export function blankDeclaration(parsed: { html?: string; log?: string } | null): BlankDeclaration {
  const none = { asserted: false, blank: false, vetoes: [] };
  if (typeof parsed?.html !== "string" || carriesContent(parsed.html)) return none;
  const log = parsed.log?.trim();
  if (!log || !BLANK_LOG.test(log)) return none;
  const scope = vetoScope(log);
  const vetoes = [...new Set([...matches(UNREADABLE_LOG, scope), ...matches(DEGRADED_IMAGE_LOG, scope)])];
  const affirmed = contentAffirmed(scope);
  return {
    asserted: true,
    blank: vetoes.length === 0 && affirmed === null,
    vetoes,
    ...(affirmed === null ? {} : { affirmed }),
  };
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
  // What the first pass spent producing this page, which is the correction pass's estimate of
  // its own size (`correctionCeiling`). Optional because it is the provider's number, not this
  // file's: an adapter that reports no usage leaves it undefined and the correction runs uncapped,
  // exactly as it did before. Never inferred from the HTML — a length is not a token count, and a
  // wrong estimate here truncates a correction that would have worked.
  outputTokens?: number;
  // The agent declared this page blank and the fragment is `""` on purpose (`page_blank`). Set
  // rather than inferred from an empty `html`, which is the same string for two different
  // answers: today every other unusable reply throws before it can get here, so the two happen
  // to coincide, and a future path that returns an empty page without declaring one would
  // silently inherit the caller's decision not to verify it (#294).
  blank?: true;
}

// The output ceiling for a correction call, or undefined for "whatever the deployment allows".
//
// A correction is the one page call whose size is known before it is made: it is handed a page
// and asked to return that page with named problems fixed, so its reply should be about as long
// as the reply it is correcting. The deployment's ceiling is 32,000 tokens, which for this call
// is not a safety limit but a budget for a runaway — and a runaway here is pure loss, because the
// pipeline discards a truncated correction and ships the page it already had (`page_correction_failed`,
// `chars_kept`). Issue #285 is one: 32,000 tokens of output on a page whose first pass spent 6,233,
// $0.48 of output for text nothing read, and a `TruncatedResponseError` advising an operator to
// RAISE `max_tokens` — which would only buy a larger discarded reply.
//
// Every term measured, none assumed. The multiple and the floor over the 111 correction attempts in
// the bench's `runs-extract100-1` (two arms, 100 pages each, sonnet-4-6 and gpt-5.6-luna;
// `page_corrected` and `page_correction_failed` paired with the page calls in the same run logs):
//
//   * `2 x` the first pass, because the ratio of a correction's output to its first pass's is
//     tightly held around 1: median 1.01x, p90 1.33x, max 5.01x over 110 successful corrections.
//     A multiple is the right shape and a *character* ratio is not — chars-before/4 as a predictor
//     has a median of 1.92x and a maximum of 33.12x, which is a cap that either cuts successes or
//     saves nothing.
//   * the 4,000-token FLOOR, because the 5.01x tail is entirely small pages: every success above
//     3x had a first pass under 1,000 output tokens, and at 1,000 or more the worst case is 1.65x.
//     Without the floor, `acir-p001` on the luna arm (314 tokens, then 1,573) is cut. With it, the
//     cap cuts 0 of 110 and the tightest margin is 1.30x (`acir-p075`: 3,929 emitted, cap 5,094).
//   * `growth`, for the case the corpus cannot speak to: a specialist merge can hand the
//     correction a document larger than the render whose tokens are being doubled
//     (`dispatchSpecialist` in extractPage), and a correction has to be able to re-emit what it
//     was given. A document k times longer needs about k times the tokens, so the multiple is
//     scaled by k rather than a second term being added in characters.
//
//     In characters is what this was first written as — `handedBackChars / 4` as a third floor —
//     and it could not do the job, which is worth recording because the shape is tempting. A
//     character count converts to tokens at a rate nothing here knows. Measured over every page
//     reply in both run sets whose HTML and token count can both be recovered (390 of 458:
//     `runs-extract-1`, 7 models on an 11-page document, plus `runs-extract100-1`), HTML came out
//     at a median of 2.31 characters per output token, and on the pages long enough for such a
//     term to bind at all (over 4,000 characters) as few as 1.09. `/ 4` therefore provides a
//     quarter to a half of the tokens the same HTML actually costs — it under-provides for 356 of
//     those 390 replies, and `/ 3` for 279 — and a term that binds only when it is the largest is,
//     by construction, too low exactly where it decides the cap. The divisor that survives the
//     corpus is about 1, which is not a conservative constant but a different rule.
//
//     `growth` needs no constant: it is a ratio of two lengths, and it converts to tokens through
//     THIS page's own first pass, which is the measurement the 2x already rests on. Being >= 1 it
//     can only ever raise a cap, so the counts above still hold, and the corpus says it is almost
//     always 1: of the 184 correction attempts across both run sets, 147 have a first-pass length
//     to compare against, 146 of those were handed back no more than the render itself, and one
//     merge grew it by 8% (`acir-p030`, sonnet arm: 8,287 -> 8,960 characters and a first pass of
//     4,461 tokens, so a cap of 9,647 where the unscaled multiple would have given 8,922).
//
// On the one runaway this bounds the loss at 12,466 tokens rather than 32,000 — $0.187 of output
// instead of $0.480 — for an identical outcome (no specialist ran on that page, so growth is 1),
// and the error it throws now says the cap is this caller's rather than sending someone to the
// deployment's config (providers/bedrock.ts, `truncationRemedy`). What it does NOT claim is that
// the correction would then have succeeded: nothing measured here can say that, and a cap is a
// bound on a failure's cost, not a fix for it.
export const CORRECTION_CEILING_MULTIPLE = 2;
export const CORRECTION_CEILING_FLOOR = 4000;
// One object and one number rather than three numbers: `outputTokens`, `chars` and
// `handedBackChars` are three counts of the same page whose transposition would type-check and
// would be silent — swapping the two lengths turns `growth` upside down, and a cap that shrinks
// when the document grows is the failure this exists to prevent.
export function correctionCeiling(
  firstPass: { outputTokens?: number; chars: number },
  handedBackChars: number,
): number | undefined {
  // No number, no cap. The alternative — a ceiling derived from the character count alone — is a
  // guess about a provider's tokenizer standing in for a measurement, on the path where getting it
  // wrong throws away a correction that was about to work.
  if (!firstPass.outputTokens || firstPass.outputTokens <= 0) return undefined;
  // Never below 1: a correction handed LESS than the render produced is the ordinary case (the
  // fragment is unwrapped and trimmed), and reading that as "this page needs fewer tokens than it
  // took" would tighten every cap on the corpus the multiple was measured against.
  const growth = firstPass.chars > 0 ? Math.max(1, handedBackChars / firstPass.chars) : 1;
  return Math.max(
    Math.ceil(CORRECTION_CEILING_MULTIPLE * growth * firstPass.outputTokens),
    CORRECTION_CEILING_FLOOR,
  );
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
    { step: "extract", images: [loadImage(img)] },
  );
  ctx.log.agentCall({ agent, phase: "extraction", image: img.name, output: res.text });
  const parsed = extractJson<{ html?: string; log?: string; suggested_agent?: { name?: string; reason?: string } }>(res.text);
  const html = parsed?.html ?? bareHtml(res.text);
  // Nothing for a reader in this reply. Throwing hands the page to `failedPage`, which is what
  // every other unusable answer in this file already does: the page is lost, and the run
  // SAYS the page is lost (`page_extraction_failed`, `pages_failed`, a @page-failed
  // comment where the content would have been). The alternative — the old fallback's —
  // was to deliver whatever the model wrote as the page, which reports 100 of 100 pages
  // delivered while one of them is a JSON envelope with prose around it. On a feedback
  // re-extraction the throw is cheaper still: `previous` is kept, so the page keeps the
  // content it already had.
  //
  // `carriesContent` rather than a length, because a fragment can be several dozen characters of
  // markup and still hand a reader nothing: a comment, an empty paragraph, a bare page-break marker.
  // 33 of 818 initial renders in the bench logs are exactly that, all of them the model's way of
  // saying the page is blank, and read as content they were counted as pages that produced markup and
  // delivered into the document (issue #219). Everything below then treats them as what they are: a
  // declaration if the log makes one, and the same failure an empty `html` is if it does not.
  if (!html?.trim() || !carriesContent(html)) {
    // Unless the agent said the page is blank, in which case an empty page is the answer and
    // not the absence of one (see `declaredBlank`). Reported on its own event and counted apart
    // from failure, because the two need different things from whoever reads the run: a failed
    // page is work to redo, a blank page is nothing to do. The empty fragment is dropped at
    // assembly, which for a page with nothing on it is what the document should say.
    //
    // This still returns like any other page, and everything that runs on a page still runs on
    // this one — what no longer runs is the paid one. `extractPage` reads `blank` and does not buy
    // the Feedback Agent's verdict on an empty fragment (#294); the free checks are unchanged, and
    // the paragraph at that call site is where the reasoning and the numbers are. Short-circuiting
    // HERE, by returning early out of the page's own function, is a different thing and is still
    // refused: it would take the link and alt checks with it, and those are the two detectors of a
    // wrong blank declaration that cost nothing.
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
    // What the model sent instead of the page, where it sent anything: the markup a declaration was
    // spelled in, bounded, on both lines that discard it. Without it a run says a page was declared
    // blank and not whether the reply was the empty `html` the prompt asks for or a marker naming a
    // folio the paper never printed — which is the difference #219 had to reconstruct by replaying
    // 818 replies, and the field that would have shown it in one grep.
    const dropped = html?.trim() ? { dropped: html.trim().slice(0, 200) } : {};
    if (declaration.blank && previous?.trim()) {
      ctx.log.event("page_blank_refused", {
        image: img.name,
        page: img.order,
        chars_kept: previous.trim().length,
        log: parsed?.log ?? "",
        ...dropped,
      });
      throw new Error(
        `page agent declared a blank page that already had ${previous.trim().length} chars of content`,
      );
    }
    if (declaration.blank) {
      ctx.log.event("page_blank", { image: img.name, page: img.order, log: parsed?.log ?? "", ...dropped });
      // `""` whatever the reply held, so one shape of fragment stands for a blank page however the
      // model wrote it. What that discards is a page-break marker on 18 of the 33 markup-spelled
      // declarations — and every one of those logs says the paper prints no number, which makes the
      // marker's label the image's position in the file and its anchor a claim that the document's
      // page 14 begins here. The prompt forbids exactly that and the paragraph at `blankDeclaration`
      // has the reasoning; a blank page that DID print its folio loses an anchor to nothing, which is
      // the cheaper mistake. The markup is on the log line above either way.
      return { html: "", log: parsed?.log ?? "", outputTokens: res.usage?.output_tokens, blank: true };
    }
    const shape = replyShape(res.text, parsed);
    // A declaration the veto refused is recorded as the refusal it is, with the words that did it:
    // the failure line alone reads as "the model answered with no page", which is the opposite of
    // what happened, and every page issue #190 recovered had to be traced back to a word by hand.
    //
    // `dropped` belongs here as much as on the two lines above, and for the same reason one line
    // further on: this is where a refused declaration lands, so this is the line that has to be
    // triaged, and `chars` counts the whole reply rather than the fragment. Without it the wording that
    // walked into the veto is on record and the markup it was written beside is not — the half of
    // #219's reconstruction the fix left behind (#223).
    ctx.log.event("page_no_output", {
      image: img.name,
      page: img.order,
      chars: res.text.length,
      shape,
      ...dropped,
      ...(declaration.asserted ? { blank_vetoed: declaration.vetoes, log: parsed?.log ?? "" } : {}),
      ...(declaration.affirmed ? { blank_contradicted: declaration.affirmed } : {}),
    });
    // The message says what arrived, which for a fragment carrying nothing is not "no HTML": a reply
    // that sent a comment or a bare marker sent HTML, and it is `page_extraction_failed.error` that
    // carries this string to whoever reads the run.
    const arrived = html?.trim()
      ? `no page in ${html.trim().length} chars of HTML`
      : `no HTML (${shape}, ${res.text.length} chars)`;
    throw new Error(`page agent returned ${arrived}`);
  }
  const sa = parsed?.suggested_agent;
  return {
    html,
    log: parsed?.log ?? "",
    suggestion: sa?.name ? { name: sa.name, reason: sa.reason ?? "" } : undefined,
    // Read off the result rather than through the router's `onUsage`, because this is the
    // surviving path: a render that threw has no page to correct.
    outputTokens: res.usage?.output_tokens,
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
  // The output ceiling this call asks for, from `correctionCeiling`, or undefined for whatever the
  // deployment allows. Computed by the caller rather than here so the number asked for and the
  // number on `page_correction_failed` are one number and cannot drift apart. Asked for is not
  // always sent: an adapter lowers it to the deployment's ceiling if it is higher, and never the
  // other way round — see the call site for what a larger number on that log line means.
  maxOutputTokens?: number,
): Promise<string | null> {
  // The link list is repeated here, not just in the first pass: a dropped link is one
  // of the problems this pass exists to fix, and it cannot re-attach a URL it can no
  // longer see. The image still does not show them.
  const user =
    `Your previous accessible-HTML output for this page had fidelity/accessibility problems:\n` +
    `${problems.map((p) => `- ${p}`).join("\n")}\n\n` +
    `## Your previous output\n\`\`\`html\n${previous}\n\`\`\`\n\n` +
    `Look at the source image again and return a corrected version that resolves every problem. ` +
    // The scope clause, which this path did not have and the feedback path always did
    // (`priorSection` in renderPage: "Keep everything the feedback does NOT concern exactly as it
    // was"). Both calls show the model its own previous output; only one of them said what to do
    // with the rest of it, and the asymmetry is what #132 was filed about — a second pass that
    // re-derives the page from the image undoes work the first pass got right, and nothing
    // downstream can see that it did, because the corrected fragment IS the page from here on.
    // The page prompt now carries the same rule for both paths; this says it where the problems
    // are listed, so "resolve every problem" reads as a scope rather than as a licence.
    `Change nothing the list above does not name: every heading, table, list, label and attribute ` +
    `that is not part of a problem is carried over exactly as it stands.` +
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
    {
      step: "correct",
      images: [loadImage(img)],
      // The one capped call in the pipeline (#285).
      maxOutputTokens,
    },
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
Output body content only (no <html>/<head>/<body>/<main> wrapper).
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
    { step: "specialist", images: [loadImage(img)] },
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
  const res = await ctx.router.complete(
    PAGE_AGENT,
    "text",
    [
      { role: "system", content: MERGE_SYSTEM },
      { role: "user", content: user },
    ],
    { step: "specialist_merge" },
  );
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

// Both unresolved branches below report the same thing, and say it from one place: a name the
// model wrote that no available agent answers to. They differ only in whether the name was empty
// or merely unknown, which is a distinction for the log line and not for the verifier.
const NO_SUCH_AGENT = "No agent of that name was available";

// If a page flagged a content type that an EXISTING library agent handles, run
// that specialist on the page and merge its higher-fidelity fragment into the
// page output. Non-blocking: any failure leaves the page output unchanged.
// dispatched=true means a library specialist ran (so the suggestion is already
// covered and should not be re-filed as a new-agent issue).
//
// `unmet` is a separate question from `dispatched`, and they disagree on four of the six
// exits below, so `dispatched` cannot stand in for it (it was tried, and mislabelled all
// four). Three of the four were silent — no content, a throw, and a fragment that would not
// merge all return `dispatched: true` and so said nothing about a request that went unmet.
// The fourth is the standard-type decline, and it is the one that shipped a wrong ANSWER
// rather than none: `dispatched: false` there, so the verifier was told "no agent of that
// name was available" about a type declined by policy, on the commonest suggestion shape
// there is. Counting only the silent three reads as `dispatched` being incomplete, which
// undersells it. `dispatched` answers "is this suggestion already covered, or should it be filed
// as a new-agent issue"; `unmet` answers "did specialist content reach the HTML the
// verifier is about to judge". A dispatch that ran and returned nothing, threw, or produced
// a fragment that would not merge is dispatched-and-unmet: the delivered page is the page
// agent's own unaided work, which is exactly the case the caution exists to report. Set as
// a phrase rather than a flag because the four ways a request goes unmet are not
// interchangeable in the message — telling the verifier "no agent of that name was
// available" about a specialist that ran and failed is simply false.
async function dispatchSpecialist(
  ctx: PipelineContext,
  img: InputImage,
  pageHtml: string,
  suggestion: { name: string; reason: string },
): Promise<{ html: string; dispatched: boolean; unmet?: string }> {
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
    return { html: pageHtml, dispatched: false, unmet: NO_SUCH_AGENT };
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
    // No `unmet`, and this is the one exit where that is a judgement rather than a fact. No
    // specialist ran, so the page agent's request was literally not granted — but it was
    // ANSWERED, by a policy that says the general pass is this type's intended handler and not
    // a fallback for it. Cautioning here would narrow what the verifier may assert on the
    // commonest suggestion shape there is (see the STANDARD list), which on a table page means
    // declining to say a cell reads wrongly, and it would buy nothing measured: of the 7
    // requests behind #353, 0 were standard types — every one named a map specialist and every
    // one landed on the unresolved branch below. A narrowed licence on the pages where the
    // pipeline believes the general pass is adequate is cost without a case.
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
    return { html: pageHtml, dispatched: false, unmet: NO_SUCH_AGENT };
  }
  try {
    const fragment = await runSpecialist(ctx, specialist, img);
    if (!fragment) {
      ctx.log.event("specialist_no_content", { agent: specialist.file, image: img.name });
      return { html: pageHtml, dispatched: true, unmet: "The specialist that ran returned no content of its type" };
    }
    const merged = await mergeSpecialist(ctx, img, pageHtml, specialist.name, suggestion.reason, fragment);
    ctx.log.event("specialist_dispatched", { agent: specialist.file, image: img.name, merged: Boolean(merged) });
    // The only exit that met the request, and only when the merge produced something: a
    // fragment that was written and then not spliced leaves the same page behind as no
    // fragment at all, so it is reported as unmet even though the specialist did its part.
    return merged
      ? { html: merged, dispatched: true }
      : { html: pageHtml, dispatched: true, unmet: "The specialist's fragment could not be merged into the page" };
  } catch (e) {
    ctx.log.event("specialist_dispatch_failed", { agent: specialist.file, image: img.name, error: (e as Error).message });
    return { html: pageHtml, dispatched: true, unmet: "The specialist call failed" };
  }
}

// What the page agent said about its own weakest work, in the words it used, for the verifier to be
// told alongside the output. A page that asked for a specialist and did not get one is a page whose
// own author said it could not do this content reliably — the request names the content and carries
// its reason — and until now `dispatchSpecialist` was the only thing that read it: the request was
// routed, the outcome logged (`specialist_unresolved`), and the judgement of the page never heard
// about it.
//
// What that cost, measured. In one 100-page bench round across two page-model arms there were 7
// requests on 5 pages under 6 different names, every one of them a map specialist, 0 dispatched. The
// 5 pages were every page in the round whose verdict turned on reading ink. On one of them the page
// agent asked for help producing "a structured data table of each state's classification", got the
// classification wrong, and the verify step — not told any of this — ADDED a state to a category the
// page does not put it in; the correction obeyed, and a false sentence shipped in the delivered
// document (#353).
//
// Two limits, stated because the prompt is written to survive them rather than to rely on their
// being better than they are. It is page-level and not per-arm: 4 of those 7 requests came from the
// OTHER arm's reader on the same images, so a run reads its own reader's suggestions and not the
// union that made the count look strong. And it missed 2 of that round's hard pages outright. So
// this is not a detector and `agents/feedback.md` does not treat it as one — it narrows what the
// verifier may assert on a page rather than deciding anything about the page, which is a use that
// costs nothing when the flag is wrong.
//
// The test is `unmet` and not `dispatched`: those two answer different questions and disagree on
// four of `dispatchSpecialist`'s six exits, so keying on `dispatched` claimed "no agent of that
// name was available" about a standard type that was declined by policy, and said nothing at all
// about a specialist that ran and returned nothing, threw, or produced a fragment that would not
// merge — the last three being verbatim the case this caution is for. `unmet` carries the phrase
// too, so the sentence names which of the four it was.
//
// Both interpolated strings are free text a model wrote, landing in a message that already
// carries a fenced ```html block, so they are flattened and clipped: an unbounded reason
// containing a fence of its own would restructure the message after the block, and a long one
// buries the block it is supposed to annotate. The cap is generous for a sentence and short of
// anything that could crowd the output being judged.
function specialistCaution(
  suggestion: { name: string; reason: string } | undefined,
  unmet: string | undefined,
): string | undefined {
  if (!suggestion?.name || !unmet) return undefined;
  const name = oneLine(suggestion.name, 80);
  const why = oneLine(suggestion.reason, 300);
  if (!name) return undefined;
  return (
    `The page agent asked for a specialist it did not get: "${name}"` +
    `${why ? `, because "${why}"` : ""}. ${unmet}, so the HTML above is ` +
    `its own unaided attempt at the content it wanted help with.`
  );
}

// Backticks and newlines out, then clipped to a sentence's worth. Backticks rather than only
// the triple: a single one opens inline code, which is enough to swallow the punctuation the
// sentence around it depends on. Flattening the newlines is the sharper half of the two,
// though, and not only a tidiness measure: the verify message is structured by `##` headings,
// and a string that cannot start a line cannot forge one.
function oneLine(s: string, max: number): string {
  const flat = s.replace(/`/g, "'").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
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
// What a page failure says about the reply, when the reply is the thing that failed (issue #293).
// Empty for every other error — a throttle, a stall, a stream that stopped: `error` is the whole of
// what is known about those, and a `reply_chars: 0` on such a line would read as a model that
// answered with nothing.
//
// Every page path that loses a reply to the ceiling gets it from here rather than assembling its own
// fields, because there are three of them — a first pass, a re-extraction a user asked for, and a
// correction — and the evidence is worth nothing if the round that produced it is the one round that
// did not record it. It is what `editor_truncated` has carried since #277, at the same width, from
// the same `replyExcerpt`: what the reply reached, and both of its ends. A tail mid-sentence in
// content the head has not reached is a page that needed the room; a tail repeating rows already in
// the head is a model rewriting the page it was given. Nothing in the pipeline reads any of it — the
// question is a person's, and it is otherwise unanswerable, because a truncated round has already
// been billed for a full ceiling of output and cannot be asked again.
//
// `instanceof` and not `isTruncatedResponseError`: the predicate also matches an error that arrived
// having lost its prototype, which has a message and no `text` to quote.
//
// A truncation that wrote NOTHING is therefore `truncated: true` with no `reply_head` and
// `reply_chars: 0` — a call that spent a whole ceiling of output and never began the page, which is a
// model problem and not a room problem (`EMPTY_REPLY`, providers/types.ts). It is the shape a
// reasoning model produces, so it is the one to watch when the page model changes.
function truncationEvidence(e: unknown): Record<string, unknown> {
  if (!(e instanceof TruncatedResponseError)) return {};
  return { truncated: true, reply_chars: e.chars, ...replyExcerpt(e.text) };
}

function failedPage(ctx: PipelineContext, pageAgent: AgentSpec, img: InputImage, e: unknown): PageOutcome {
  const message = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim();
  // No `ceiling` beside the evidence, unlike `page_correction_failed`: a first pass asks for no cap
  // of its own, so the number that was hit is the deployment's and the error already names it.
  ctx.log.event("page_extraction_failed", { image: img.name, page: img.order, error: message, ...truncationEvidence(e) });
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
  const { html, log, suggestion, outputTokens, blank } = await renderPage(ctx, pageAgent, img, lessons, previous);
  let innerHtml = html;
  let logNote = log;
  let dispatched = false;
  let unmet: string | undefined;

  // Specialist dispatch: if the page flagged a content type that an existing
  // library agent handles (e.g. a chart), run that agent and merge its
  // higher-fidelity fragment into the page BEFORE the fidelity check.
  if (suggestion?.name) {
    const result = await dispatchSpecialist(ctx, img, innerHtml, suggestion);
    dispatched = result.dispatched;
    unmet = result.unmet;
    if (result.html !== innerHtml) {
      innerHtml = result.html;
      logNote = logNote ? `${logNote}; merged ${suggestion.name}` : `merged ${suggestion.name}`;
    }
  }

  // A page the agent declared blank is not sent to the verifier. The fidelity question this call
  // asks is whether the fragment is faithful to the image, and an empty fragment has no content to
  // be unfaithful with: the Feedback Agent is shown the source image and an empty code block, and
  // in 36 such judgements — 9 pages of a 100-page corpus, two page-model arms, two shas — it
  // passed every one (#294). What that bought was $0.0859 per arm, 0.77% of the deployed lineup's
  // bill and 1.33% of the cheaper one the sprint is heading for, which is the direction the share
  // moves: a per-image cost that does not shrink is a growing fraction of a shrinking bill.
  //
  // `blank` AND an empty fragment, not `blank` alone. The flag says what the model answered; the
  // emptiness is what makes the argument above true. A specialist cannot reach a blank page today
  // (the declaration returns before a `suggested_agent` is read), so the conjunction is a belt —
  // and if some later path does put content into a page that was declared blank, the check comes
  // back on rather than being skipped on the strength of a stale flag.
  //
  // What is NOT given up. The two code-level checks below still run on this page, and both are
  // detectors of a wrong declaration that the verifier is not needed for: a page carrying link
  // annotations that came back empty fails `missingLinks` exactly as before, and buys a correction
  // — which for a blank page means the page is re-rendered against the image with a named problem,
  // and the corrected fragment is then verified in turn (`recheck_binding`, because the check did
  // not fail). So a "blank" page that the FILE says has content in it is still caught, for free.
  //
  // What is: a page with content on it that the agent declared blank confidently and that carries
  // no annotations. The model call was the only thing that could catch that, and it never has —
  // 0 of 36. The failure mode it was written for was observed (#190, four pages) and is now caught
  // one step earlier and for nothing by the doubt-word veto in `blankDeclaration`, which refuses a
  // hedged declaration before it can reach this line at all (`blank_vetoed` on `page_no_output`).
  // A confident-but-wrong declaration would leave a `page_blank` line and a blank count in
  // diagnostics as its evidence, and no verdict.
  // Computed once, above the check and both rechecks: it is a fact about this page's render, so a
  // recheck of a correction to that render carries the same one. It is read from `suggestion` and
  // the dispatch's own return rather than from the log, so the caution and the routing line cannot
  // disagree about whether the request was met. `unmet` stays undefined when no suggestion was made
  // at all, which is the same no-caution answer by a different route.
  const caution = specialistCaution(suggestion, unmet);
  const blankSkip = blank === true && innerHtml === "";
  const verdict = blankSkip
    ? unjudgedVerdict()
    : await verifyAgentOutput(ctx, pageAgent, img, [{ html: innerHtml, caution }], "verify");

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

  // And whether any image on the page was described with a placeholder instead of a
  // description, checked here for the same reason and on the same terms: it has an exact answer,
  // it costs nothing, and it runs on every page rather than on the ones a sampled verifier
  // happens to look at. The difference from a missing link is which way the model fails — a
  // dropped link is invisible to the Feedback Agent, while a gutted alt is something the
  // DEPLOYED verifier catches 6 times out of 6 and the cheap ones catch 0–2 times out of 6
  // (#290, and see alt.ts for the whole table). So this is not a blind spot being covered, it is
  // a capability being moved off the model's bill: it is the one defect class where dropping the
  // verifier to a cheaper model costs real detection, and a free rule is what buys it back.
  const generic = genericAlts(innerHtml);
  if (generic.length) {
    ctx.log.event("page_generic_alt", { image: img.name, page: img.order, alts: generic });
  }

  // page_verify_ok / page_verify_failed report the Feedback Agent's verdict and
  // nothing else, exactly as they did before links existed — a missing link is not
  // part of that verdict, and folding it in would make the two events mean different
  // things in old logs and new ones. `page_links_missing` above is the signal for a
  // correction driven by a link.
  const verifyFailed = failedCheck(verdict);
  if (verifyFailed) {
    // `kinds` is what a reader of this log can subtract from `verify_failed`: the SET of
    // problem kinds the verdict named (feedback.ts `VERIFY_KINDS`), so a page that lost
    // three table rows and a page whose alt text was polished stop being the same line
    // (issue #182). A set rather than one label per problem, because the question it answers
    // is what was wrong with the PAGE, and a page with two missing rows lost content once.
    // `untagged` is how many problems arrived with no kind this code knows — a split
    // computed while most of a round was untagged would be a split of the tagged half
    // reported as the whole, and this is the only field that would say so.
    ctx.log.event("page_verify_failed", {
      image: img.name,
      problems: verdict.problems,
      kinds: verdict.kinds,
      untagged: verdict.untagged,
    });
  } else {
    // `unjudged` where the verdict is the non-blocking default rather than a pass — no
    // Feedback Agent, nothing to verify, or a reply that would not parse (feedback.ts).
    // The event stays `page_verify_ok` because that is what the run did with it, and every
    // reader of this log still counts it as one verified page. The field is for the reader
    // that has to tell "the verifier looked and was satisfied" from "nobody looked": a
    // measurement OF the verifier drawn from these lines would otherwise take pages nothing
    // judged as its population (issue #180, src/pipeline/calibration.ts). Omitted, not
    // false, on the ordinary pass — a log full of `unjudged: false` says nothing.
    //
    // `skipped` says which kind of unjudged this is: a call that could not be made, or one that was
    // not bought. Both must stay out of any pass rate — that is what `unjudged` is for and it is set
    // either way — but they are different facts about a run, and only one of them is a saving. A
    // reader counting these lines is the only way to price the skip after the fact, so the reason is
    // on the line rather than inferred from a `page_blank` on the same image (issue #294).
    ctx.log.event("page_verify_ok", {
      image: img.name,
      ...(verdict.unjudged ? { unjudged: true } : {}),
      ...(blankSkip ? { skipped: "blank" } : {}),
    });
    // The verdict that describes a defect and then passes the page. `ok` is the verdict's
    // `faithful`/`accessible` FLAGS, and `failedCheck` needs a false flag AND a named problem
    // before the run will spend a correction — so a verdict that names one while both flags
    // stay true ships the page, and the sentence it wrote goes nowhere: `page_verify_ok`
    // above carries no `problems`, and nothing downstream looks at the image again.
    //
    // Measured while calibrating the verifier against injected defects: of 30 damaged pages
    // it perceived 28 and flagged 25, and 3 of the 5 it did not flag it described in full —
    // a swapped pair of paragraphs quoted back verbatim, an `<h4>` among `<h2>` siblings
    // named as such, `faithful: true` on both (issue #210). Which is a different repair from
    // a verifier that cannot see: what it needs is for the flag to follow the prose.
    //
    // Logged and not acted on, deliberately. The one-line fix — any named problem fails the
    // page — would buy a correction round for every `alt_quality` suggestion the same agent
    // is asked to volunteer, which is the class of finding least likely to be worth a page
    // call, on top of a verification share already under investigation for costing 24%. The
    // kind-gated version (a `content_missing`, `content_wrong` or `structure_wrong` problem
    // fails the page whatever the flags say) is the one worth having, and pricing it needs
    // this count over a fleet rather than over an 11-page corpus. So this event decides
    // nothing and costs nothing: the page ships exactly as it did.
    //
    // #290's placeholder-alt rule is not a reversal of that, and the difference is the whole
    // reason it is a code check: what is refused above is buying a page call on the verifier's
    // OPINION that a description could be better, which it volunteers on request and which has
    // no exact answer. What is bought below is a placeholder — an alt that is one word for the
    // medium — which is decidable from the bytes, costs nothing to find, and fires on 0 of the
    // 1,064 alts in the bench corpus, so it is not a share of the bill at all. If the verifier
    // ever names an `alt_quality` problem that IS a placeholder, the free rule has it already.
    //
    // Only the first verdict, which is the one that decides whether a correction is bought.
    // A recheck's own disagreement is already readable on its line, since
    // `page_correction_recheck` carries both its `ok` and its `problems`.
    if (verdict.problems.length > 0) {
      ctx.log.event("page_verify_inconsistent", {
        image: img.name,
        page: img.order,
        // The prose, because the prose is the finding: "the HTML reverses this order" is what
        // says the verifier saw the defect, and no count of it can be re-read as that.
        problems: verdict.problems,
        // And the kinds, because they are what a kind-gated rule would act on — a page whose
        // problems are all `alt_quality` is not this bug, it is the agent doing what it was
        // asked. `untagged` is the honest reading of a verdict in plain prose, which is what
        // an agent file predating the kinds returns and what makes a kind-gated rule a no-op
        // on that page: it cannot be counted for or against.
        kinds: verdict.kinds,
        untagged: verdict.untagged,
      });
    }
  }

  const problems = [
    ...(verifyFailed ? verdict.problems : []),
    ...missing.map(missingLinkProblem),
    ...generic.map(genericAltProblem),
  ];
  if (problems.length) {
    // What the correction was asked to fix, for the event below. Any of the three can fire on one
    // page, and they cost the same call but mean different things: a link the model dropped and a
    // placeholder alt are exact, code-checked misses, while a fidelity problem is the Feedback
    // Agent's judgement.
    //
    // `both` is more than one source, which is what it has always counted — until #290 there
    // were two sources, so every line an old log calls `both` is still one, and no reading of an
    // old log changes. What it no longer does is name WHICH pair, and that is on purpose rather
    // than traded away: the alternative is seven buckets for three sources, and the per-source
    // detail is already exact on `page_links_missing` and `page_generic_alt`, both keyed by the
    // same `image` as this line.
    const sources = [verifyFailed ? "verify" : null, missing.length ? "links" : null, generic.length ? "alt" : null]
      .filter((s): s is string => s !== null);
    const trigger = sources.length > 1 ? "both" : sources[0];
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
    // What this call may spend on output, bounded by what the first pass spent (#285). Computed
    // here, from `before`, so the number this caller ASKED for is the number the failure line below
    // reports — a cap an operator cannot read off the log is a cap they will debug as a config
    // problem, which is the mistake this whole change is about.
    //
    // Asked for, and not necessarily sent: `growth` has no upper bound, so a merge that grew the
    // page enough can compute a ceiling above `providers.<provider>.max_tokens`, and the adapters
    // take the smaller of the two (`Math.min` in bedrock.ts and openrouter.ts — a caller may lower
    // a call's ceiling and never raise it). A `ceiling` on the line below that is larger than the
    // deployment's is therefore a call the DEPLOYMENT bounded, and the error on that same line says
    // so: the truncation message names the config, because the config is what bound it. Clamping
    // this number to make the two agree is not available here — the provider's ceiling is the
    // adapter's to know, and re-deriving it in the pipeline is how it comes to disagree.
    //
    // `html`, not `innerHtml`, is what `outputTokens` bought: `innerHtml` is what a specialist may
    // have merged into it since, and it is the pair (tokens, the length they produced) that gives
    // this page its own characters-per-token. Handing the same string as both would make `growth`
    // 1 by definition and quietly delete the term.
    //
    // A page that rendered as NOTHING is the one case where the first pass bounds nothing, so it
    // gets no caller ceiling at all. `correctionCeiling` cannot tell that page apart from a first
    // pass whose length is merely unknown — both arrive as `chars: 0`, and for an unknown length
    // scaling by 1 is right — but the caller can, and here the emptiness is a measurement. Such a
    // page is a page declared blank (nothing else empty survives to a correction), and its
    // correction is not an edit of a page: it is a re-render of the page from the image, which is a
    // first pass, and first passes are bounded by the deployment rather than by a caller. Left to
    // the floor it was 4,000 tokens — roughly 16,000 characters of HTML, where this file's own
    // worked example of a dense page is 17,721 — so a dense page wrongly declared blank whose file
    // carries a link annotation would have its one free repair truncated and ship empty. That
    // repair is the safety net the skip above rests on, so capping it at a bound taken from the
    // reply that got the page wrong is the wrong side of #285's own argument (the cap exists to
    // bound a runaway, and this call has nothing to run away from being asked to produce).
    const ceiling = html === "" ? undefined : correctionCeiling({ outputTokens, chars: html.length }, before.length);
    const attempt = await correctPage(ctx, pageAgent, img, innerHtml, problems, lessons, ceiling).then(
      (html) => ({ html, error: null as unknown }),
      (error: unknown) => ({ html: null, error }),
    );
    const corrected = attempt.html;
    if (attempt.error !== null) {
      const message = (attempt.error instanceof Error ? attempt.error.message : String(attempt.error))
        .replace(/\s+/g, " ")
        .trim();
      // Deliberately narrower than the `truncated` field below, which is the predicate: an error that
      // arrived having lost its prototype has a message and no `text` to quote. So this line can say
      // `truncated: true` and carry no excerpt, which is the one case where their disagreement is the
      // truth — and it is why `reply_chars: 0`, and not the absence of `reply_head`, is what names the
      // zero-character shape HERE. On `page_extraction_failed` both come from the same `instanceof`.
      const evidence = truncationEvidence(attempt.error);
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
        // And the ceiling it was truncated AT, which since #285 is usually this call's own and not
        // the deployment's. `truncated: true` beside a 32,000-token config used to be enough to
        // name the number; with a per-call cap it is not, and the difference decides whether the
        // remedy is a config edit or `correctionCeiling`'s multiple. Absent where the call ran
        // uncapped, which is two causes and not one: the first pass reported no usage, so there was
        // no measurement to cap from, or the page rendered nothing and was delivered blank, whose
        // correction is a re-render rather than an edit (#294, and the only trigger that reaches it
        // there is `links`). Both leave the deployment's ceiling as the one that bound the call, so
        // the remedy on the line is the same; what differs is whether anything here could have
        // capped it, which is what an operator reading this field is asking.
        ...(ceiling !== undefined ? { ceiling } : {}),
        // What the reply reached, and both of its ends — the evidence that decides the question the
        // `ceiling` above only poses (issue #293). A cap this page hit is either a page that
        // genuinely needs more room than its first pass took, in which case the multiple in
        // `correctionCeiling` is too tight, or a model that went on rewriting the same page, in
        // which case the multiple is doing its job. Nothing on this line could tell those apart:
        // two truncations at 34,573 and 41,959 characters against pages of 11,908 and 11,456 were
        // argued both ways off the same log, and the round could not be asked again to settle it
        // because a truncation has already been billed for a full ceiling of output.
        //
        // A head and a tail settle it by inspection: a tail mid-sentence in content the head has
        // not reached is a page that needed the room, and a tail repeating rows already in the head
        // is a model looping. `reply_chars` rather than `chars` because `chars_kept` is on this same
        // line and a bare `chars` here would read as the page's own length; it is the number
        // `editor_truncated` calls `chars`, and it is a ratio against `chars_kept` for free.
        //
        // Only for a truncation, and only for one that kept its prototype: every other failure —
        // a throttle, a stall, a stream that stopped — has no reply to quote, and `error` above is
        // the whole of what is known about it. Like `editor_truncated`'s excerpts this is the
        // user's own document coming back, so it stays in the run log on the deployment and never
        // reaches `GET /v1/quality`. Its `truncated: true` restates what the predicate above already
        // said on every line where both fire, and the two paths above spell the field the same way.
        ...evidence,
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
        // What the verifier said was wrong going in, so this line pairs with the effect
        // fields on the other `page_corrected` below without a join back to
        // `page_verify_failed` (issue #182). `identical` on a page flagged
        // `content_missing` is the sharpest case there is of a page call that bought
        // nothing that mattered. Empty on the links trigger: a dropped link is found by
        // code against the file's own annotations, not named by the verdict, and giving it
        // a kind would put a count in this field the verifier never made.
        kinds: verifyFailed ? verdict.kinds : [],
        result: corrected ? "identical" : attempt.error !== null ? "failed" : "empty",
      });
    }
    if (corrected && corrected !== before) {
      // A page that PASSED its fidelity check is being re-rendered here only to
      // recover a link, or to replace a placeholder alt, so the rewrite has to earn the
      // standing the original already had: it is verified in turn, and a rewrite that lost
      // something is discarded in favour of the fragment that was known to be good. Both of
      // those repairs are LOCAL — one href, one attribute — and paying for either with the
      // structure of a page that already checked out (a heading level, a `<th scope>`) would
      // make the document worse than it was before the feature. Which is why #290's check
      // lands here rather than as its own pass: a page that passed and has a gutted alt gets
      // this protection for free, from code that was already written for the link case. When
      // the check had already failed, the original has no standing to protect and the
      // correction is accepted as it always was.
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
        recheck = await verifyAgentOutput(ctx, pageAgent, img, [{ html: corrected, caution }], "recheck_binding");
        keep = !failedCheck(recheck);
        if (!keep) {
          // Named `page_links_correction_rejected` since before there was anything else on this
          // branch, and kept: it is the rejection of a correction bought for a page that had
          // PASSED, and renaming it would split one measurement across two event names in a log
          // that is read across rounds. `trigger` is what says which repair was refused — `links`
          // reads exactly as it always did, and `alt` or `both` is a line no older log holds.
          ctx.log.event("page_links_correction_rejected", {
            image: img.name,
            trigger,
            links: missing.map((l) => l.href),
            // The placeholder alts that bought the call, for the same reason `links` names the
            // hrefs: without them a rejected alt correction is a line saying a good page was
            // re-rendered for nothing and not saying what for.
            ...(generic.length ? { alts: generic } : {}),
            problems: recheck.problems,
          });
        }
      } else if (moved && claimRecheck(sampler, img.order)) {
        // Measurement only, on the batch's sampled pages — one by default: does a
        // corrected page pass the check it just failed? A page the pass did not actually
        // change is not worth a slot — there is nothing to check, and the answer would be
        // the verdict already on record. Nothing here decides anything — a verify-driven
        // correction is accepted exactly as it always was, whatever this says — because
        // whether to keep re-rendering until a page passes is a policy question, and the
        // answer to it needs the rate this event exists to produce (issue #137). See
        // `recheckSampler` for how many pages and which, and `DEFAULT_RECHECK_SAMPLE_SIZE`
        // for why the default is not all of them.
        //
        // Two bench rounds later that is the thing being asked about: 200 pages, 8 samples,
        // 2 of them ok, every correction kept regardless, and the note is that a check with no
        // consequence is decorative (issue #166). Three reasons it stays as it is, in the
        // order they bind. The rate itself has since been measured, by replaying this same
        // call over 57 corrected pages in the bench: **26%** of them pass, against 2% for
        // re-asking about the page as it was, 19 pages better and 2 worse, p = 0.000 (issue
        // #288). So the pass does real work and finishes the job on about a quarter of the
        // pages it is bought for — which is an argument about the step's cost, not about
        // this line, and none of the three below turns on the number.
        //
        // What discarding buys. A rejected correction does not restore a good page — it ships
        // the fragment that FAILED this same verifier minutes earlier. On those rounds the
        // verifier rejected 71% and 74% of first renders, so the choice is not a good page
        // against a bad one, it is a page with fewer named problems against a page with more,
        // and `problems_before`/`problems_after` on the line below is the number that says
        // which. The links path is the case where discarding does make sense and it is
        // binding there: those pages had PASSED, so the original has standing to protect.
        //
        // Whose page it would apply to. This is a sample, so at any setting below a census
        // binding it would put a gate on page 4 that page 5 never sees, and the delivered
        // document would differ by which pages the thresholds fell on. Binding it for
        // everyone means a Feedback Agent call per corrected page — 71 of them on a 100-page
        // round, roughly doubling the 24% verification share that is under investigation in
        // the first place. That is now a configured number rather than a compiled one
        // (`defaults.recheck_sample_size`), and raising it still buys measurement only: a
        // deployment can pay for the census without any page's fate depending on it.
        //
        // And how much the sample says. Eight verdicts, of which round 3 supplied 0 ok and
        // round 4 supplied 2, is not a rate yet — and the two 100-page rounds after them made
        // the point again, reading 50% and 25% off four draws each on one corpus. This is a
        // measurement whose whole purpose is to be accumulated across runs before anything is
        // decided on it, and binding it now would spend the pages it was collected to protect.
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
        recheck = await verifyAgentOutput(ctx, pageAgent, img, [{ html: corrected, caution }], "recheck_sampled").catch(
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
        // links path — where with no Feedback Agent every page passes its first check, so
        // every corrected page's recheck is the binding one and every one of them is a
        // "checked and passed" line for a page nobody looked at.
        //
        // `unjudged` is what tells those apart, on the same terms as `page_verify_ok`: the
        // flag rather than a second event, omitted rather than false on a real verdict, and
        // `ok` unchanged either way because the recheck is not allowed to cost the page
        // anything it would not have cost with no measurement at all.
        ctx.log.event("page_correction_recheck", {
          image: img.name,
          page: img.order,
          ok: !failedCheck(recheck),
          ...(recheck.unjudged ? { unjudged: true } : {}),
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
          // The third share of the same bill (#290). Kept apart from `problems_before` for the
          // reason `links_before` is: `problems_after` is the Feedback Agent's verdict on the
          // corrected fragment, and a placeholder alt going in was found by code, so folding it
          // into the before-count would make a page with one fidelity problem and two gutted alts
          // read as three-in-one-out — a correction that fixed nothing, logged as converging.
          // Whether the alts came back is answered exactly and for free by
          // `page_generic_alt_unrecovered`, not by this verdict.
          alt_before: generic.length,
          problems_after: recheck.problems.length,
          // The same two sides as kinds (issue #182), which is what turns "the recheck did
          // not pass" into an answer about the CORRECTION: `content_missing` going in and
          // `alt_quality` coming out is a page whose content came back and whose description
          // is now the complaint, and `content_missing` on both sides is a correction that
          // did not do the one thing it was asked to. Both are `ok: false` and five-in-one-out
          // says nothing about which. Empty before on the links path, for the same reason
          // `problems_before` is 0 there — the page had passed, so nothing was named.
          kinds_before: verifyFailed ? verdict.kinds : [],
          kinds_after: recheck.kinds,
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
        // The verdict's side of the same line: what was wrong going in, beside what the
        // correction changed. That pair is the reading issue #182 asks for — a page flagged
        // `content_missing` whose only effect is `alt_changed` did not get fixed, and until
        // both were on one line neither field could say it alone.
        kinds: verifyFailed ? verdict.kinds : [],
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
        // The same question about the placeholder alts, and the reason this rule is worth having
        // over a model that finds the same defect: the check that raised the complaint can be run
        // again on the answer, exactly and for nothing. So "the free rule found something" and
        // "the free rule got it fixed" are separable, which is the pair a decision about the
        // verifier's model actually needs (#290, #246). Only when the correction was bought for an
        // alt in the first place — re-reporting a page whose alts were never a complaint would put
        // this rule's failures and the page agent's ordinary output in one count.
        if (generic.length) {
          const stillGeneric = genericAlts(innerHtml);
          if (stillGeneric.length) {
            ctx.log.event("page_generic_alt_unrecovered", {
              image: img.name,
              page: img.order,
              alts: stillGeneric,
            });
          }
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

  // Contained per page: mapWithConcurrency rejects with the first error any item
  // throws (matching a serial loop), so without this one page takes the document with
  // it. See `failedPage`.
  // The batch's measurement-only re-verifications — `defaults.recheck_sample_size` of
  // them, one by default, claimable by a corrected page that reaches the next threshold
  // (correction.ts). Created here rather than inside extractPage so it cannot become one
  // per page, which is the cost it exists to bound.
  const sampler = recheckSampler(
    ctx.images.map((i) => i.order),
    ctx.recheckSampleSize,
  );
  // Logged with the sampler rather than before it, so a round says what it was going to
  // measure and where — `recheck_sample_size` is the setting, `recheck_thresholds` the
  // page orders it resolved to. Without them a log with no `page_correction_recheck` in it
  // reads three ways at once: measurement off, no page corrected, or every correction
  // landing below the first threshold. Only the last is a sample that was available and
  // went unspent, and it is the one that changes how the fleet's counts should be read.
  ctx.log.event("extraction_start", {
    pages: ctx.images.length,
    concurrency: limit,
    recheck_sample_size: ctx.recheckSampleSize,
    recheck_thresholds: [...sampler.thresholds],
  });
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
  ctx.log.event("extraction_complete", {
    pages: fragments.length,
    failed: failedPages,
    // The generic-alt rule over the fragments the document is assembled FROM, which is a different
    // question from the per-page `page_generic_alt` above: this one is asked after any correction,
    // so a non-zero `alts_generic` here is a placeholder this step could not repair.
    //
    // Deliberately not read as what shipped, and the distinction is not pedantic: the review loop
    // runs after this line and rewrites the assembled document a top-level block at a time
    // (`applyBlockEdits`), replacing a block's markup wholesale — `<img>` and its `alt` with it —
    // so a copy-edit round that guts an alt ships a placeholder these counts never saw. The
    // delivered bytes are measured where every other claim about them is, on the file the caller
    // receives (`delivered_alt`, orchestrator.ts).
    //
    // Present at zero on every run for the reason `failed` is — a class that is only ever reported when it
    // fires cannot distinguish "it never happened" from "the check never ran", and this rule's
    // whole claim is that it fires on nothing Iris writes (0 of 1,064 alts in the bench corpus,
    // #290). A count that prints 0 is the thing that can be seen to be working.
    //
    // `alts_checked` is the denominator, and it is the number that makes the zero readable: a run
    // whose pages hold no images at all reports 0 of 0, which says nothing about the rule, and a
    // run reporting 0 of 40 says something. Free either way — one regex over strings already in
    // memory.
    alts_checked: fragments.reduce((n, f) => n + altTexts(f.innerHtml).length, 0),
    alts_generic: fragments.reduce((n, f) => n + genericAlts(f.innerHtml).length, 0),
  });

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
  // for the rate to come from as a full run. Its thresholds are spread over the pages
  // being RE-EXTRACTED, which is why the sampler is given their orders rather than a
  // count — see `recheckSampler`.
  const sampler = recheckSampler(
    toRun.map((i) => i.order),
    ctx.recheckSampleSize,
  );
  // After the sampler, and carrying the same two fields as `extraction_start`, for the
  // same reason: a feedback round's sample is drawn from the pages it re-extracts, so its
  // thresholds are different numbers from the first pass's and are only readable here.
  ctx.log.event("reextract_start", {
    pages: toRun.map((i) => i.order),
    of: priorFragments.length,
    concurrency: ctx.extractionConcurrency,
    recheck_sample_size: ctx.recheckSampleSize,
    recheck_thresholds: [...sampler.thresholds],
  });
  const outcomes = await mapWithConcurrency(toRun, ctx.extractionConcurrency, (img) =>
    extractPage(ctx, pageAgent, img, lessons, sampler, previousFor(img.order)).catch(
      (e): PageOutcome => {
        const message = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim();
        ctx.log.event("page_extraction_failed", {
          image: img.name,
          page: img.order,
          error: message,
          kept: "prior",
          // The same evidence as a first pass that truncated, on the round a USER asked for. Left off
          // here at first, and that was the wrong half to leave: this round is the one someone is
          // waiting on an answer about, and a reader following docs/API.md's row would have read the
          // absence of these fields as "not a truncation" (#293, review of #297).
          ...truncationEvidence(e),
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
    // Over the WHOLE document this round delivers, not the pages it re-ran, which is what makes
    // it comparable with the same two fields on `extraction_complete`: `fragments` here is the
    // prior round's pages with the re-extracted ones substituted in, so a feedback round reports
    // the same denominator as the first round did rather than a count of the subset it touched.
    // Without that a session's log would read as the alt corpus shrinking every time a client
    // sends feedback (#290).
    alts_checked: fragments.reduce((n, f) => n + altTexts(f.innerHtml).length, 0),
    alts_generic: fragments.reduce((n, f) => n + genericAlts(f.innerHtml).length, 0),
  });
  return { fragments, suggestions, failedPages, recovered };
}
