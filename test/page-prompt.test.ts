// The page agent's instructions exist twice: in `agents/page.md`, which is what
// actually runs, and in `DEFAULT_PAGE_PROMPT` in `src/pipeline/extraction.ts`,
// the fallback for a checkout without an agents/ directory. The duplication
// cannot be removed by having the code read the file — the fallback's entire
// purpose is the file being absent — so it has to be held together by a test.
//
// Without this, the two drift silently and in the worst direction: the file is
// what every normal deployment uses, so an edit there is exercised constantly
// while the fallback rots unnoticed, and the only deployments that get the stale
// copy are bare checkouts, which are also the ones least likely to be watched.
//
// #30 Tier 5: "Have the code read the file, or add that test."
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_PAGE_PROMPT } from "../src/pipeline/extraction.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pageMd = readFileSync(join(repoRoot, "agents", "page.md"), "utf8");

// A `## Heading` section's body, up to the next `##` or end of file.
function section(name: string): string | null {
  const m = pageMd.match(new RegExp(`##\\s*${name}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`));
  return m ? m[1].trim() : null;
}

// Compared on words, not bytes. The file wraps for reading and carries one
// markdown-only aside ("no code fences", which is about the .md rendering, not an
// instruction to the model), so a byte-exact assertion would fail on reflowing a
// paragraph — the kind of failure that gets a test deleted rather than heeded.
// Every word of instruction still has to be present, in order.
function normalize(s: string): string {
  // The leading whitespace is part of the match, so removing the aside from
  // "…this JSON (no code fences):" leaves "…this JSON:" rather than "JSON :".
  return s.replace(/\s*\(no code fences\)/g, "").replace(/\s+/g, " ").trim();
}

test("agents/page.md has the sections the loader and this test depend on", () => {
  assert.ok(section("System prompt"), "page.md is missing a '## System prompt' section");
  assert.ok(section("Output contract"), "page.md is missing an '## Output contract' section");
  assert.match(pageMd, /##\s*Required capability\s*\n[^#]*\bvision\b/i, "page.md must declare the vision capability");
});

// The heading-level rule (issue #82) came from user feedback on a page whose
// subsection headings were set smaller than the section heading above them: the
// extractor gave them the same <h2>, so a screen-reader user browsing by heading
// met a flat list of siblings where the page had two levels.
//
// Almost nothing downstream can recover this. The lint gate catches the blatant half
// and only that half: `src/pipeline/lint.ts` enables `heading-order` by name (issue
// #114 — axe tags it `best-practice`, so the WCAG-only tag filter drops it), which
// reports an <h2> followed by an <h4> but says nothing about an <h2> that should have
// been an <h3>, since that is a level the page decided and not a gap in the sequence.
// The Reader Agent never sees the source image either (see READER_SYSTEM in
// src/pipeline/review.ts), so it cannot know which heading the page subordinated to
// which. For the reported case the extraction prompt is the only place the information
// exists, which is why this is asserted rather than left to the review loop.
//
// Asserted on the clauses, like the signature-block test below, and including both
// guards against over-correction: the rule has to demote a subordinate heading
// without flattening genuine sibling sections into one level, and the prompt
// carried "headings in correct nesting order" already while still producing what
// the issue reported — so the clauses that distinguish this from that sentence are
// the ones worth pinning. The last two pin the parts a page-at-a-time extractor
// gets wrong even once it is levelling correctly within a section: resuming an
// outer section after a run of subsections, and a page that opens on a heading
// whose parent is on a page this call was never shown.
test("the page agent's heading-level rule keeps the clauses that make it a rule", () => {
  const prompt = normalize(section("System prompt")!);
  for (const [what, re] of [
    ["level comes from the content's place in the hierarchy, not from type size",
      /level comes from what its content belongs to, not from how large or bold the page sets it/],
    ["the reported case: a smaller bold subsection heading is an <h3> under the <h2>",
      /smaller bold line that introduces a subsection of the section above it is an <h3> under that <h2>/],
    ["subordinate content steps one level down from the nearest preceding heading",
      /step one level down from that heading/],
    ["a genuine new top-level section is not demoted",
      /Do not demote a heading that genuinely starts a new top-level section/],
    ["a heading is not promoted for being set large",
      /do not promote one merely because the page sets it in large type/],
    ["levels are never skipped downward", /never skip a level on the way down/],
    ["a heading that resumes an outer section returns to that section's level",
      /ends one or more subsections and resumes an outer section, go back to the level of the heading that opened that outer section/],
    ["a page-opening heading with no parent on the page is levelled from the page and logged",
      /shown one page and no other.*may be a subsection of a heading you cannot see.*say in the "log" field/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/page.md no longer says: ${what}`);
  }
});

// Six more sessions landed on the same outline (issues #108, #111, #116, #119, #120,
// #128), and between them they say a heading's level is not the only thing a page can
// get wrong about a heading: whether a line is a heading at all, what a heading's parts
// belong under, and what two headings with one label mean. Each is pinned here because
// each was reported as output that shipped.
//
// Two of these are cross-page defects that a per-page extractor cannot see on its own —
// a title reprinted on every page it continues on (#111), and adjacent same-level
// headings that only sit adjacent once the pages are joined (#119). The prompt carries
// the half a single page shows; READER_SYSTEM and EDITOR_SYSTEM in
// src/pipeline/review.ts carry the document-wide half, pinned in
// test/review-headings.test.ts. Neither half is sufficient alone, which is why both
// exist.
//
// The over-correction guards matter as much as the rules. "A line with nothing under it
// is not a heading" would delete a heading at the foot of a page whose section continues
// overleaf, and "two headings with one label are one section" would merge two sections
// the page really does label alike — so the clauses that separate those cases are pinned
// alongside.
test("the page agent's heading rules keep the clauses that place a section's parts", () => {
  const prompt = normalize(section("System prompt")!);
  for (const [what, re] of [
    // #116, #120: "Step 6" and its siblings came out as <h2>s inside the <h2> section
    // whose procedure they are steps of. Reported twice by the same user, on two runs.
    ["a step of a procedure is one level below the procedure's own heading",
      /a step label — Step 4, B\., Second, however the page names it and however large it sets it — is one level below that heading and never a peer of the section that contains it/],
    // #108: the labels that group a table of contents into runs of entries were emitted as
    // paragraphs, so the one structure a reader navigates a manual with was unnavigable.
    ["a table of contents' group labels are headings under the contents heading",
      /the labels that divide a table of contents into runs of entries \(Preparations, Operation, Reference\) are headings for the same reason, one level under the contents heading/],
    // #128: SAVE THESE INSTRUCTIONS and FOR COMMERCIAL USE ONLY were promoted to <h2>
    // for being set in bold, putting two entries in the outline that head nothing.
    ["a line that says something rather than naming a section is not a heading",
      /a line that SAYS something rather than naming something — SAVE THESE INSTRUCTIONS, FOR COMMERCIAL USE ONLY.*is a <p> \(or a <strong> inside one\) however prominently it is printed/],
    // The guard on that rule. This agent is shown one page, so "nothing under it" is also
    // what a real heading looks like when its section continues on the next page — and
    // dropping it there loses the only place that section is named.
    ["a heading at the foot of the page is kept, because its section continues overleaf",
      /A heading at the foot of the page with nothing after it is not that case and is kept/],
    // #111: a section title reprinted on the page its section continued onto became a
    // second <h2> of the same name, when the previous run had produced one <h2> with the
    // page's own subsection headings under it.
    ["a section title reprinted above continuing content does not open a second section",
      /two headings of the same level under the same words, they are one section and not two: a section title reprinted above content that continues it does not open a new section/],
    // #119: three <h2>Operation</h2> headings in one document. The guard against merging
    // them is the other half — where the page really does label two sections alike, the
    // label stays and each gains the words that page prints for that section, which keeps
    // this inside the fidelity rule instead of inviting a subtitle of the agent's own.
    ["two sections the page labels alike keep the label and gain the page's own words",
      /keep the label and extend each with the words that page prints for that section — "Operation: Grinding", not a phrase of your own/],
    ["an extended heading is recorded, since the words came from elsewhere on the page",
      /say in the "log" field which headings you extended/],
    // #107: <h3>s that had gained an "On" they were never printed with. The clause above is the
    // only place a heading gains words, and it takes them from the page — so the general case
    // has to say so, or "extend each with the words that page prints" reads as a licence to
    // extend any heading. A heading is where a reader decides whether to read the section, which
    // is what makes an added word there worse than an added word in a paragraph.
    ["a heading is transcribed as printed, with no prefix or category added",
      /Otherwise a heading's words are the page's words, transcribed as printed\. Do not prefix one, do not append a category to it/],
    ["the reported prefix is named, and the extension clause is bounded to the one case",
      /"On Playback" for a line the page prints as Playback.*The clause above is the one place words join a heading/],
    // #128's second half: a <section aria-label="Page 6"> wrapper around each page's
    // content. Nothing in the pipeline emits that — the shared accessibility requirements
    // ask for semantic elements over <div>s (src/pipeline/accessibility.ts) and the agent
    // reached for the one boundary it can always see — so the prompt is where it is closed.
    ["a page is not a landmark, and the page's own boundary is not wrapped in one",
      /never wrap what you emit in a <section> or other region that stands for the page itself/],
    ["the reported wrapper is named, so the rule cannot be read as being about something else",
      /<section aria-label="Page 6"> announces a boundary that exists only because the paper ran out/],
    // And the positive half, so the rule does not read as "no landmarks": the page's own
    // self-contained parts are still regions, named from the words the page gives them.
    ["a part the page really does set apart is still a region, named from the page",
      /a table of contents is a <nav>, a sidebar or a pull-out note an <aside> — and name it from the words the page gives that part/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/page.md no longer says: ${what}`);
  }
});

// The other half of the page boundary (#145). The rule above tells the agent not to wrap
// its page in a landmark; this one tells it what the page's own printed number IS, because
// forbidding the wrapper left the agent to invent something for the one boundary it can
// always see. What it invented was `<p role="doc-pagebreak" aria-label="Page 5"
// id="page-5"></p>`, on one of seven markers in a 25-page document, and that shipped a
// SERIOUS `aria-prohibited-attr` violation: naming attributes are prohibited on that role.
//
// The lint gate does see this one, unlike the alt-text and heading-level rules above — so
// the argument for pinning it here is different. It is that the gate sees it too late to
// help: `lintSummary` (src/pipeline/review.ts) hands the Reader the rule id, its
// description and a node COUNT with no selector, the deployment that reported this runs
// `iterations_max: 1` so the re-lint after the editor's pass is the last thing that
// happens, and a document that has to spend a correction round on a defect the prompt
// could have prevented has already paid for it. The same document came back clean on an
// earlier round with three markers, every one carrying its number and every one carrying
// the same prohibited attribute — so this is output variation around a rule that was never
// stated, and the place to state it is the prompt.
//
// Pinned as clauses, and both directions of the shape: the prescribed element AND why an
// empty one is wrong independently of axe. test/pagebreak-marker.test.ts holds the gate to
// the same claims.
test("the page agent's page-break rule keeps the clauses that make it a rule", () => {
  const prompt = normalize(section("System prompt")!);
  for (const [what, re] of [
    ["there is one correct shape, and it is written out",
      /exactly one correct shape: <hr role="doc-pagebreak" aria-label="Page 5" id="page-5"> — the number the page prints, carried in the label/],
    // Why this role rather than the <section> wrapper the rule above forbids: it marks the
    // break instead of claiming a region, so it does not announce a section beginning where
    // only the paper ran out.
    ["the role marks the break rather than claiming a region",
      /That role marks the break itself rather than claiming a region, so it says where the printed page turned without announcing a section that begins there/],
    // Why the number goes in the label and not in the element's text, which is the half of
    // this rule a page agent is likeliest to "improve": the role is a separator, and a
    // separator's children are presentational, so a number written as text is pruned before
    // a reader gets it. A marker naming no page is the barrier #145 was filed about, whether
    // or not axe reports it — so the clause has to give the reason, not just the shape.
    // The folio is not transcribed beside the marker either, and the reason is stated rather
    // than asserted because this is the clause a reader of the delivered HTML will question:
    // the printed number stops being visible text. It is the placement that settles it — the
    // marker moves to the head of the page whichever end the page printed the number on, so a
    // visible copy would put the bottom of the paper at the top of the reading order and
    // announce the number twice to the one reader who was given it properly. A permissive
    // "may also transcribe it" would put that decision back on each page, which is the
    // intermittency #145 was.
    ["the folio is not also transcribed as text, and the reason is the marker's placement",
      /Do not transcribe the folio as text beside the marker either: the marker goes at the head of the page whichever end the page prints its number on, so a visible copy of it would stand at the top of the reading order saying what the bottom of the paper said/],
    ["the number lives in the label because a separator's contents are presentational",
      /separator's contents are presentational: text inside the marker is pruned before a reader is given it, so <p role="doc-pagebreak" id="page-5">5<\/p> announces a page break that cannot say which page/],
    // And why <hr> rather than the <p> or <span> that reported the violation: the naming
    // attribute is judged against the element's OWN role (`paragraph` and `generic` prohibit
    // it, `separator` does not), which is the mechanism the first version of this rule got
    // wrong by reading the report as "naming is prohibited on doc-pagebreak".
    ["the element is an <hr> because the naming attribute is judged against its own role",
      /A naming attribute is judged against the element's own role, which is why aria-label is permitted here and a serious violation on the <p> or <span>/],
    // The asymmetry is what made it intermittent, and stating it is what stops the rule
    // being read as "only empty markers are a problem" — with the warning that the gate is
    // not the teacher here, since the shape it stays quiet about is also wrong.
    ["the linter is not the teacher, because only the empty marker reports it",
      /Do not look to the linter to teach you this one: it says nothing about <p role="doc-pagebreak" aria-label="Page 5">5<\/p> and speaks only when such a marker is empty, which is how one habit passes on six markers in a document and fails on the seventh/],
    // A page with no printed number gets no marker: there would be nothing to name it with,
    // and an unnamed break is the same dead end as a pruned one.
    ["a page that prints no number gets no marker",
      /Where the page prints no number, emit no marker: a break with nothing to name says only that something ended/],
    // The consistency half of the report: seven markers in a 25-page document is arbitrary,
    // and a page-local rule is what makes it not arbitrary.
    ["a marker is emitted wherever the page prints its number, first in the page's output",
      /Emit one wherever the page prints its number, as the first thing you emit for that page/],
    // The number is the page's own, not the position of the image in the upload — which is
    // the other number this agent is given (`page N of M` in the user message).
    ["the number is the one the page shows, never the image's position in the file",
      /use the number the page shows \(iv, 5, A-3\), never the position of the image you were given in the file/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/page.md no longer says: ${what}`);
  }
});

// Issue #187: a footnote list item shipped `role="doc-endnote"`, which axe deprecates, and the
// FOOTNOTES rule had prescribed the markup in detail while saying nothing about roles at all —
// so the model reached for the DPUB pair on its own and picked up the deprecated half. The
// clauses below are the ones that make this a rule rather than a preference: the shape, the
// deprecated pair, that the gate fails a document using one, and why nothing is lost by leaving
// it off.
//
// The last four are the correction to this rule's own first version, which said the landmark
// role "may" go on the `<ol>`. A role replaces the host element's implicit one, so that shape
// silently cost every footnote list its list semantics — the notes stop being a list, the items
// lose their position in it — and no axe rule reports it, so the prompt is the only place it can
// be said. test/deprecated-roles.test.ts pins those facts about axe; src/pipeline/roles.ts is
// the half of the fix that does not depend on the agent obeying any of this.
test("the page agent's footnote-role rule keeps the clauses that make it a rule", () => {
  const prompt = normalize(section("System prompt")!);
  for (const [what, re] of [
    // The shape first, because it is the whole rule for the ordinary case: a plain list.
    ["the notes are a plain list with no role on either element",
      /emit a plain <ol> of <li> items with no ARIA role on either/],
    ["the deprecated pair is named, and named as deprecated",
      /role="doc-endnote" and role="doc-biblioentry" on the ITEMS are two of the only three roles ARIA deprecates \(the third is directory\)/],
    // Stated as a consequence, because "deprecated" alone reads as a style note: this is the
    // accessibility gate failing the document, which is what happened.
    ["using one fails the gate",
      /a document that uses one fails the accessibility gate/],
    // The reason nothing is lost, which is the clause that stops the rule being read as a
    // trade of semantics for a clean lint — the `<li>` was already saying it.
    ["nothing is lost, because the list item already says it",
      /an <li> inside an <ol> is already a list item to a screen reader, and that is the whole of what doc-endnote was adding/],
    // The clause the first version of this rule got wrong, by prescribing the landmark on the
    // list. A role replaces the element's own, so the shape it prescribed cost every footnote
    // list its list semantics — and no gate reports that, which is why the prompt must.
    ["the landmark roles are not to be reached for on the list instead",
      /Do not reach for role="doc-endnotes" or role="doc-bibliography" on the <ol> instead/],
    ["the reason: a role replaces the element's own, and these are landmarks, not lists",
      /a role REPLACES the element's own rather than adding to it, and both of them are landmarks — neither is a kind of list/],
    ["what that costs, including that nothing reports it",
      /<ol role="doc-endnotes"> is not a list any more: the notes stop being announced as a list of N items, each item loses its position in it, and no gate reports the loss/],
    ["where the landmark does go, with the shape written out",
      /put it on a wrapper and leave the list a list: <section role="doc-endnotes"><ol><li id="fn-1">…<\/li><\/ol><\/section>/],
    ["both wrong shapes are named at the end",
      /Never <ol role="doc-endnotes"> directly, and never <li role="doc-endnote">/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/page.md no longer says: ${what}`);
  }
});

// What the agent may say about what it could not read, and how much of the page has to
// arrive at all (issues #112, #117, #133, and the legibility half of #116).
//
// Three reports, one shape: the output was quieter than the page. A user compared the
// result against Preview on their own Mac and found far more readable than the run had
// transcribed (#117); a run emitted "d :5[" where the sentence was about an inserted disc
// (#112); a run dropped whole sections and tables (#133). Nothing downstream recovers any
// of it. The Reader Agent never sees the source image by design (READER_SYSTEM in
// src/pipeline/review.ts), the verify pass compares the output against the image but
// judges it by this file, and the assembled document is exactly what the page calls
// returned — so a row that never arrived is not missing anywhere, it simply is not there.
//
// Two of the four asks were declined and the reasons are pinned as clauses too, since a
// later reading of the issues would otherwise re-add them: #116 asks for
// `<span aria-label="text not legible">[not legible]</span>`, which hands a screen reader
// the same words twice and overrides the visible text with a copy of itself, and asks for
// "suggested_agent" on an illegible page, where that field means a content-type specialist
// and the contract says so. The location of an unreadable region goes in "log", which is
// not delivered as part of the document.
test("the page agent says what to do with what it cannot read, and emits the whole page", () => {
  const prompt = normalize(section("System prompt")!);
  for (const [what, re] of [
    // #133: entire sections and tables absent from the output. Length is the reason a model
    // stops, so length is named as not being one.
    ["everything on the page reaches the output",
      /Everything the page shows reaches your output/],
    ["nothing is summarised or handed back in part",
      /none of it is summarised, abbreviated, or handed back in part because the rest is more of the same/],
    // Every subtraction a rule below asks for is enumerated HERE, in the absolute clause,
    // because this paragraph is what would otherwise contradict them — #110's explained symbol
    // and #145's printed folio, which the page-break marker carries as a name instead. Both
    // halves have to stay in step: a rule elsewhere that removes something the page shows,
    // with this paragraph still calling the list closed, leaves a model reconciling two
    // unconditional sentences page by page, which is the per-page variation #145 was.
    //
    // It also has to be stated here for a second reader: `verifyAgentOutput` quotes this whole
    // file into the verify prompt (src/pipeline/feedback.ts), so the verifier reads the
    // absolute rule too and would score a rule-compliant omission as a fidelity problem,
    // spending a correction round on re-adding what the rule removed.
    ["the things that leave the page by rule are enumerated where the absolute rule is stated",
      /Two things leave the page, by rule and not by judgement: a symbol the page itself explains as a navigational device is kept out of the text and recorded in the "log" field, and the number the page prints on itself is carried by the name of the page-break marker rather than transcribed beside it\. Both rules are below, and both are narrow\. Nothing else leaves/],
    ["the reason it matters: no later pass can tell a dropped row was ever there",
      /the document is assembled from what you return, so a row, an item or a section you leave out is simply not in the document any reader gets/],
    // A page that stops early is recorded only in `fragment.log` otherwise, and "log" is not
    // delivered: `wrapDocument`'s @page-failed block covers pages whose extraction THREW, so a
    // self-limited page would ship as a silently short document — the very shape #133 reported.
    ["length is not a reason to stop, and stopping is marked in the document",
      /Length is not a reason to stop.*make \[page not fully transcribed\] the last thing you emit/],
    ["the marker is the part that matters, because the log is not delivered",
      /"log" is not delivered as the document, so a page that stops without one reads as complete to every reader/],
    // #117: "[not legible]" over text the user could read in Preview. The rule is an order of
    // operations — read first, mark second — and it names the regions that get skimmed.
    ["the page is read before any of it is called unreadable",
      /Read the page before deciding any of it is unreadable/],
    ["the regions that take a second look are named",
      /Low contrast, small type, a watermark over text, a lightly printed caution, the labels inside a diagram, the figures in a table cell/],
    ["text a reader could make out with effort is transcribed",
      /text a reader could make out with effort is text you transcribe/],
    // #116's legibility half: the placeholder keeps the structure around it, and the mark is
    // scoped to the words that could not be read rather than to the block they sit in.
    ["the placeholder stands where the words stand, inside the element they belong to",
      /write \[not legible\] where that word or phrase stands, keep the element it belongs to around it — the <li>, the <td>, the <p> of the caution box/],
    ["only what could not be read is marked",
      /Mark only what you could not read: a placeholder standing for a paragraph you could mostly read costs a reader the part you had/],
    // #117's other half. A paraphrase and an invented caution are the dangerous ones on a
    // safety page; an editorial note is the one the user actually saw in the body.
    ["nothing else may stand in that place, including an editorial note",
      /not a paraphrase, not a caution of your own that suits the picture, not an editorial note \("manual transcription required", "insufficient contrast", "see the original manual"\)/],
    ["notes about the transcription go where they are not delivered",
      /notes about the transcription belong in the "log" field, which is not part of the document/],
    // #112: "d :5[" for "disc". A reading has to be a reading of the marks, which is what
    // keeps this from becoming licence to write the word the sentence wants.
    ["an ambiguous run of marks is read as the word its shapes allow",
      /what you emit is a reading OF those marks: "d :5\[" is not a word, and where the shapes allow "disc" and the sentence is about an inserted disc, disc is what the page says/],
    ["a word that fits but is not on the page is still invented content",
      /A word whose letters are not on the page is invented content however well it fits/],
    // The bound that matters most on a manual: context can confirm a word and cannot confirm
    // a torque figure or a part number, and those are the strings a reader acts on.
    ["a number, a code or a measurement is marked rather than mended",
      /a number, a part code, a measurement or a model name is never settled this way.*an uncertain one is marked, not mended/],
    // The fidelity sentence is a closed enumeration of what may be emitted that the page does
    // not print, and the Feedback Agent judges against it (agents/feedback.md), so a
    // placeholder that is not named there can be sent back as invented content.
    ["the placeholders are named where fidelity is demanded",
      /a \[not legible\] marker where the marks on the page do not resolve into characters, a \[page not fully transcribed\] marker where you could not return all of it/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/page.md no longer says: ${what}`);
  }
});

// The prompt half of #194. Downstream, `blankDeclaration` (src/pipeline/extraction.ts) now refuses an
// empty `html` whose log says something is on the page, because believing such a reply ships a page
// nobody is told about — and the refusal reports the page as lost, which is not a good outcome for it
// either. Both halves of that trade are the agent's to avoid, and this is where it can: the reply that
// names a heading and returns no page is a reply that had the heading.
//
// The rule has to say the cost, because the shape it forbids reads as diligence: a log describing what
// is on the page is exactly what the "log" field is asked for elsewhere in this prompt. What separates
// the welcome case from the refused one is the answer it accompanies, so the clause names the specks
// and dust a blank page IS described by, and keeps them welcome. Without that half, the rule reads as
// "say less in the log" — which would cost the described blank pages of #190 all over again, from the
// other end.
test("the page agent is told not to contradict its own blank answer, and why that costs the page", () => {
  const prompt = normalize(section("System prompt")!);
  for (const [what, re] of [
    ["naming content in the log of a blank answer is the shape that is forbidden",
      /A log that reports the page blank and then names something on it — a heading, a caption, a signature, handwriting, an image — contradicts the answer it is attached to/],
    ["what it costs: the contradiction is believed, and the page is reported as untranscribed",
      /the contradiction is what gets believed: the reply is refused and the page is reported as one nobody transcribed/],
    ["the way out is the content, not a quieter log",
      /Anything on the paper worth naming in the log is worth putting in "html", and anything you could see but not read is worth \[not legible\] inside the element it belongs to/],
    ["describing the specks that establish a blank page stays welcome",
      /Describing the specks and dust that establish a page IS empty is not naming content and is welcome/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/page.md no longer says: ${what}`);
  }
});

// The numbering and abbreviation rules (issues #98, #100, #101) came from one
// session's feedback on a parts manual: item numbers that skipped were annotated
// under the last table and nowhere else, a repeat went unremarked, the "NS" key
// under each table was ALSO restated as a paragraph above it, and the symbols the
// page used as footnote markers reached a screen reader as bare punctuation.
//
// The three issues contradict each other as filed — two ask for prose notes the
// third asks to stop emitting — so what is pinned here is the resolution: a meaning
// the page states goes into the markup where the page already puts it (`<abbr
// title>`, an accessible name on a symbol marker) and is not restated as a
// paragraph, while an observation about the numbering is allowed as prose but bounded
// to what this page shows. That bound is the load-bearing half: the agent sees one
// page, so "items 3 and 4 are not listed in this table" is checkable against the
// rows above it and "items 3 and 4 do not appear in this assembly" is a claim about
// a document it was never given.
//
// The consistency half is the reported bug rather than a refinement of it. An
// irregularity annotated on the last table and not the first tells a reader the
// others were checked and found sound, which is worse than annotating none.
test("the page agent's numbering and abbreviation rules keep the clauses that make them rules", () => {
  const prompt = normalize(section("System prompt")!);
  for (const [what, re] of [
    // "Do not invent content" governs the whole prompt and is read by two audiences:
    // the page agent, and the Feedback Agent that judges its output for fidelity
    // (agents/feedback.md) and sends a page back to correctPage when it decides
    // something was invented. Both need the numbering note named as sanctioned, or the
    // rule below and the sentence above it can be read as contradicting each other.
    ["the text these rules add is named where fidelity is demanded",
      /do not invent content: apart from the accessibility scaffolding the rules below ask for by name/],
    // The exception list is an enumeration, so it reads as closed: anything the rules below ask
    // for and it omits is text the Feedback Agent can call invented. Both of these are text no
    // page prints — aria-label="Footnote 1" and the ↩ of a footnote's back-reference — and both
    // are asked for by name a few lines below, so both have to be named here.
    ["the accessible name on a symbol marker is one of the named exceptions",
      /an accessible name on a marker the page prints as a symbol/],
    ["the footnote back-reference is one of the named exceptions",
      /the ↩ that returns from a footnote/],
    ["a shown sequence is transcribed, not tidied", /Transcribe the sequence exactly and never tidy it/],
    ["a repeated number is kept as it appears", /do not drop or alter a number that appears twice/],
    // Without this, "never renumber" is unachievable on the very structure the rule
    // names: an <ol> counts 1..n whatever the <li>s contain, so a gapped list closes
    // its own gap and the only markup that shows the page's numbers is value.
    ["a list keeps the page's numbers with value, since an <ol> counts for itself",
      /an <ol> counts 1, 2, 3 by itself whatever you put in it — so set value on any <li> whose number differs from the count/],
    ["an irregularity is annotated in the document, immediately after the element",
      /say so once in a <p> immediately after that list or table/],
    // Adjacency is linear-reading-order only. A reader moving between tables lands on
    // the table, not on the paragraph after it, so the note is associated as well as
    // placed — which is also what makes "checkable against the rows above it" true for
    // the reader the rule is written for.
    ["the note is associated with its table, not merely placed after it",
      /give that <p> an id and point the table's or list's aria-describedby at it/],
    // The rule above asks for one note per irregular list or table, so a multi-table parts
    // manual gets several — and two <p>s that both pick id="note" are an intra-page duplicate,
    // the same collision the symbol-marker clause closes and the same one assembly does not:
    // namespaceAnchors renames ids more than one PAGE claims (src/pipeline/anchors.ts:611-615).
    ["the note ids are ordered and never reused, since one page may need several",
      /Number those ids by the order the annotated lists and tables appear on the page.*never reuse one/],
    ["the note claims only what this page shows, not what the document contains",
      /not listed in this table" is something a reader can check.*is a claim about a document you were not shown/],
    ["a note the page itself prints is transcribed rather than duplicated",
      /where the page prints its own note about the numbering, transcribe that rather than adding a second one/],
    ["no note is written for a sequence that is not actually irregular",
      /Never write such a note for a sequence that is in fact unbroken/],
    ["every irregular list and table is annotated, not just the most prominent one",
      /Do this for EVERY irregular list and table on the page, and record each one in the "log" field as well/],
    ["an abbreviation is expanded only in the page's own words",
      /<abbr title="not shown">NS<\/abbr>.*Never supply an expansion the page does not state/],
    ["the meaning is encoded once, where the page keeps it",
      /do NOT also put a paragraph above the table restating what the legend below it already says/],
    ["every cell carrying an abbreviation is marked, because a row is read on its own",
      /mark every cell that carries the abbreviation and not only the first/],
    ["a symbolic footnote marker keeps its glyph and gains an accessible name",
      /keeps that symbol as its visible text.*aria-label="Footnote 1">\*<\/a>/],
    // The example hands a * the id fn-1 while the rule above derives ids from "the
    // number the page shows". A page with both footnote 1 and a * footnote, followed
    // literally, emits two id="fn-1" — and assembly namespaces ids between pages, not
    // within one, so that collision is not the kind assembly resolves.
    ["a symbol marker cannot reuse an id a numbered footnote on the page already has",
      /never hand one an id that a numbered footnote on this page already uses/],
    // #107: a machine's button symbols. Routed here by the device rule's own last clause — a
    // symbol the page explains lexically is this rule — so what is added is the control case
    // and its two edges. The proposal asked for the control's plain-language name wherever a
    // symbol appears; that is granted only where the PAGE names it, because "never supply an
    // expansion the page does not state" is this rule's first clause and a guessed key is the
    // one wrong word a reader acts on rather than reads past.
    ["a symbol standing for a control is this rule's case, with the page's own drawing kept",
      /A symbol that stands for a control is this rule's case.*never substitute a different one because it is the commoner way to draw that control/],
    ["a collected key is transcribed as a <dl> of symbol and control name",
      /where the page collects the symbols as a key or a legend, transcribe that where the page puts it, as a <dl> of symbol and control name/],
    ["and the name reaches a symbol standing in a row on its own",
      /carry that name onto the symbol where it stands \(<abbr title="Stop">■<\/abbr>\) so a row read on its own still says which key it means/],
    ["a name the page does not give is not invented, and the omission is logged",
      /A name is the page's or it is nobody's.*say in the "log" field which symbols went unexplained/],
    // Pinned as an attribute rather than left open because the gate cannot teach it: axe demotes
    // `aria-prohibited-attr` to `incomplete` on an element that has text, which is exactly the
    // silence #145 shipped through. Measured in test/page-definition-lists.test.ts.
    ["title is the attribute, and the reason the gate does not say so is stated",
      /title is the attribute for this, and aria-label is not: <abbr> carries no ARIA role of its own.*The gate demotes that finding rather than reporting it/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/page.md no longer says: ${what}`);
  }
});

// The signature-block rule (issue #67) came from user feedback on a part-signed
// page: one party's fields had been rendered as a <dl> and the other's as form
// controls, so a screen-reader user met the same block twice in two different
// shapes. Asserted on the clauses that carry the rule rather than on its prose —
// the wording may be reflowed, but drop one of these and the output is back to
// what the issue reported, or to the over-correction it invites (every label/value
// pair on the page turned into a control).
//
// Only `page.md` is checked: the test below holds the fallback copy to it word for
// word, so a rule present here and missing there fails there.
test("the page agent's signature-block rule keeps the clauses that make it a rule", () => {
  const prompt = normalize(section("System prompt")!);
  for (const [what, re] of [
    ["one fieldset per signing party", /<fieldset>\/<legend> per signing party or logical group/],
    ["a filled-in field is a readonly input, not static text", /<input readonly value="\.\.\."> rather than as a <dd>/],
    ["required is read off the page, not inferred from a blank field", /aria-required="true" only where the page itself marks a field as required/],
    ["printed metadata is still a <dl>", /not about every label\/value pair.*is still a <dl>/],
    // #99: the footer line of website, e-mail and revision, which the user asked to be a <dl>
    // "just like the list in the main body". It is the printed-metadata case above, so it is
    // stated here rather than given a bullet — with the two limits the issue as filed would have
    // broken. A label the page does not print has no <dt> to go in (the same rule as #95's
    // verbatim terms), and the folio is not one of these values at all: the page-break marker
    // carries it, so a row for it would hand the reader the number twice.
    ["the head-or-foot line is that same case, and not a <p> or a <ul>",
      /The line a page prints along its head or foot is that same case.*is a <dl> — not a <p> of pipe-separated text.*and not a <ul>/],
    ["the same shape on every page that prints it, since a reader reads the difference as content",
      /a footer that is a <dl> on page 4 and a sentence on page 5 tells a reader the two pages carry different things/],
    ["a value the page gives no label for has no term to write",
      /What the page prints no label for has no term to write/],
    ["and the page's own number stays with the page-break marker",
      /the page's own printed number is never one of these values: it is carried by the page-break marker's label/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/page.md no longer says: ${what}`);
  }
});

// The image rule is eight sessions of feedback that all landed on the same element
// (issues #83, #93, #122, #123, #124, #125, #126, #127), and they pull in two
// directions: half report descriptions that were missing or empty, half report
// descriptions that said what the page had already said beside the image. So what is
// pinned here is the resolution — an image's description is decided by what the picture
// gives a reader that the words around it do not — plus each reported case, because a
// rule that keeps only one direction is the other half's bug.
//
// Nothing downstream can recover any of this. `src/pipeline/lint.ts` runs axe, which
// proves a MISSING alt attribute and nothing about what an alt says: a filename, the
// heading repeated, or "image" all pass `image-alt`. The Reader Agent never sees the
// source image (READER_SYSTEM in src/pipeline/review.ts), so it cannot tell a
// description that matches the picture from one that does not, and the Copy Editor is
// rewriting the same words. For every one of these the extraction prompt is the only
// place the information exists.
test("the page agent's image rule keeps the clauses that make it a rule", () => {
  const prompt = normalize(section("System prompt")!);
  for (const [what, re] of [
    // #123: an image shipped with no alt attribute at all, and the user asked for either a
    // description or its removal.
    ["every image carries the attribute, and the description follows from what the picture adds",
      /every <img> carries an alt attribute, and what belongs in it is decided by what the picture gives a reader that the words around it do not/],
    ["decorative is bounded to an image a reader loses nothing by not seeing",
      /decorative — alt="" — only where a reader who cannot see it loses nothing/],
    // #93: the page carried ABC Notation for the stave beside it, so describing the image as
    // well handed the same music to a screen-reader user twice.
    ["a graphic the page itself carries in full beside it is the decorative case",
      /a graphic whose content this page ALSO carries in full beside it \(the notation under a stave, the data table under a chart\)/],
    // #127: a logo and a back cover were both given alt="" as "decorative".
    ["what counts as informative is enumerated, so a logo or a cover cannot be called decorative",
      /words printed inside the image, a logo, seal or badge, a diagram, a photograph, a chart, a cover whose appearance is itself the content/],
    ["a heading beside an image does not make it decorative",
      /Sitting beside a heading that names the section does not make an image decorative/],
    ["an image that is hard to describe is described as far as it can be, and logged",
      /neither does being hard to describe.*describe what you can and say so in the "log" field/],
    ["the attribute is never dropped and never left holding a filename",
      /never leave the attribute off, and never leave a filename in it/],
    // #122, #124, #125: the position title, the product name and the caption were each
    // repeated into the alt text of the image they sat beside.
    ["a name the page prints beside the image is not repeated in its description",
      /the alt text does not repeat that name; it says what the name does not/],
    // #126: the same user's third report on this, after two rounds that trimmed detail
    // instead of trimming the repetition.
    ["it is a redundancy rule and not a licence to describe less",
      /This is a redundancy rule and not a brevity one: every detail that is in the picture and not in the words around it stays/],
    // And it is a rule about the description, not about the page. A `<figcaption>` here is
    // transcribed page text — the fidelity sentence above sanctions "a <caption> the page does
    // not print" and pointedly not a figcaption — so trimming the heading's words out of a
    // printed caption would delete words from the delivered document for every reader, and
    // would be sent back as unfaithful by the very next verify call. What #126 reported is
    // the other thing: the category name appended to a caption that did not print it.
    ["a caption the page prints is transcribed as printed, repetition and all",
      /a caption or label the page prints is transcribed as printed, however much of its heading's wording it repeats/],
    ["what is forbidden is appending the heading's words to a printed caption",
      /never extend a printed caption with the product, section or category name its heading already gives/],
    // #122: the same position pictured twice, described fully once and vaguely the second
    // time — which tells a reader the two pictures differ when they do not.
    ["the same subject pictured twice is described the same way",
      /pictured more than once with no visible difference between the occurrences, describe them the same way and in the same detail/],
    // #83: a black-and-white logo was transcribed as text rather than emitted as an image.
    ["a logo is an image with a description, never a heading or a transcription of its lettering",
      /emit a logo, a masthead or a wordmark as an <img> with alt text \(alt="Acme Corp logo"\), never as a heading, a paragraph, or a transcription of its lettering/],
    ["the unembeddable file gets a named placeholder src, recorded for whoever supplies the asset",
      /give src a placeholder that names the page and the graphic \(src="page-1-logo.png"\) and record it in the "log" field/],
    // The issue as filed asked for src="", which is not a neutral placeholder: a browser
    // resolves it against the current URL and re-requests the document. And the only image
    // file this agent has a name for is the whole page it was given.
    ["src is neither the source page image nor empty",
      /Never point src at the source image you were given, and never leave it empty/],
    // The redundancy rule above and this example pull against each other on a letterhead,
    // where the company name is printed in type beside the mark: read together they would
    // license alt="logo" on the one image whose entire content is that name.
    ["a mark whose content is a name is described by that name, printed beside it or not",
      /Name the mark, even on a letterhead that prints the same name in type beside it/],
    // The fidelity sentence enumerates what the agent may emit that the page does not print,
    // and the Feedback Agent judges against that list (agents/feedback.md). A placeholder src
    // is not a word on the page, so it has to be named there or the pass that adds one can be
    // sent back for inventing content.
    ["the placeholder src is named where fidelity is demanded",
      /alt text, a placeholder src for a graphic you cannot embed, a <caption> the page does not print/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/page.md no longer says: ${what}`);
  }
});

// Four sessions reported the same class of defect: content that is a set of items came
// back as prose (#129, #130, #131), and a symbol that is not content came back as text
// (#110). All four are structure a reader navigates by, and all four were invisible to
// everything downstream — axe has no rule for "these six paragraphs are a list", the
// Reader Agent gets no source image so it cannot tell parallel items from continuous
// prose, and the flattened view it does get reads a <p> run and a <ul> almost alike.
//
// What is pinned is the resolution and its guards, in both directions, because the two
// directions are each other's bug: "parallel items are a list" applied to continuous
// prose invents a structure the page does not have, and #131's own report ("Nothing
// changed! Bad Claude!") is what a rule that hedges produces.
test("the page agent's list rule keeps the clauses that make it a rule", () => {
  const prompt = normalize(section("System prompt")!);
  for (const [what, re] of [
    // #129: a cleaning-and-maintenance section came back as a run of <p> elements.
    ["a set of discrete parallel items is a list however the page separates them",
      /a group of discrete, parallel items is a list, whatever the page uses to separate them/],
    ["what a run of paragraphs costs a reader is named, not asserted",
      /leaves a screen-reader user no way to know how many items there are, which one they are on, or where it ends/],
    // #129, #131: which list, and the item boundary — the reported cells had several steps
    // run together as one string.
    ["<ol> where order is part of the instruction, <ul> where it is not",
      /Use <ol> where the order is part of the instruction \(do this, then that\) and <ul> where it is not/],
    ["one item's worth of text per <li>, neither merged nor split",
      /never merge two instructions into one item, and never split one instruction across two/],
    // #129: the page presented the items as separated lines with no bullet glyphs, which is
    // what the previous wording ("real lists") left open.
    ["missing bullet glyphs are not evidence that something is not a list",
      /the absence of bullet glyphs is not evidence that they are not/],
    // Re-cutting a "first… then… finally" paragraph into <li>s is the one clause here that
    // asks for prose to be broken up, and every neighbouring rule says words leave the page
    // only under a named exception — so it has to say what happens to the connectives, or a
    // model tidies them away as an unlogged omission. They stay; the printed DIGIT does not,
    // and the difference is stated because the rule directly below says digits are not text.
    ["the ordering words stay in the item, unlike a printed digit",
      /Re-cutting prose into items moves no words: "First, remove the cover" is one <li> transcribed as printed, ordering word and all\. A printed digit is the list's marker and is carried by the count instead/],
    // #130, #131: the Ingredients and Directions columns of a recipe table. Reported twice
    // from one session, the second time after a round that changed nothing.
    ["a table cell holding several items or steps contains the list, not <br>-separated text",
      /a Directions cell holding three steps is a cell containing an <ol>, an Ingredients cell holding four items is a cell containing a <ul>, and neither is <br>-separated text/],
    // #131's second ask: a block of separate trademark and copyright notices. Named in the
    // rule's own examples rather than given a bullet of its own — the reason it is a list is
    // that it is a set of discrete items of one kind, which is this rule.
    ["the reported blocks are named as examples: steps, cautions, ingredients, notices",
      /Procedural steps, cleaning or maintenance tasks, a run of cautions, the ingredients of a recipe, a block of separate copyright and trademark notices/],
    // The guard. Without it this rule turns every explanatory paragraph into a bulleted
    // outline, which is the same defect with the structure invented instead of lost.
    ["continuous prose stays a paragraph, and a single direction is not a one-item list",
      /Continuous prose is not a list: a paragraph that explains one thing, or a single direction written as one sentence, stays a <p>, and a list of one item is a paragraph/],
    // And the boundary with the rule below it, which owns the numbers the page prints.
    ["a list is not a way to number things",
      /a list is not a way to number things — an <ol> counts its own items/],
    // #132's second half: the same recipe table again, one iteration later. The items had
    // stopped being <br>-separated text and had become <li>s at document level instead, which
    // the clause above does not forbid — it says what goes IN the cell, not that the cell keeps
    // it. What a table adds is the row and the column, and that is what leaving is what costs.
    ["a cell's items are never lifted out of the table",
      /Never lift a cell's items out of the table to stand as <li> elements beside it or as a run of items after it/],
    ["what leaving the cell costs is the row and the column, named",
      /the reader is left with Flour and Salt and no way back to the Ingredients column of step 3/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/page.md no longer says: ${what}`);
  }
});

// #110: a manual explained "see the pages indicated in •" and the extractor then appended
// the bullet to every <li> in the list it annotated, so a screen reader said "bullet" at
// the end of every item with nothing to say why.
//
// This is the one rule in the prompt that takes something OFF the page, so its guards carry
// more weight than usual: the fidelity sentence above governs what may be added, and the
// verify pass compares the output against the image but judges it by this file — which is
// what makes a deliberate omission safe here and an undeclared one unfaithful.
test("the page agent's rule for a symbol the page explains as a device keeps its guards", () => {
  const prompt = normalize(section("System prompt")!);
  for (const [what, re] of [
    ["a symbol the page explains as navigational belongs to the apparatus, not the item",
      /that symbol belongs to the page's apparatus and not to the item it is printed beside/],
    ["the reported convention is quoted, so the rule cannot be read as being about bullets in general",
      /"see the pages indicated by •", a ► that stands for "turn to"/],
    ["what it costs a reader is named",
      /hands a screen reader "bullet" at the end of every item, announced aloud, with nothing in the markup to say why/],
    // The omission is recorded, because "log" is where anything not delivered as the
    // document goes — the same discipline the legibility rules use.
    ["the convention is recorded in the log rather than silently dropped",
      /Record the convention in the "log" field instead/],
    // Guard one: only the page's own explanation triggers it. Without this, every † and •
    // on every page is a candidate for deletion.
    ["an unexplained symbol is ordinary text, transcribed as printed",
      /An unexplained symbol is ordinary text and is transcribed as printed — a bullet inside a sentence, a † beside a price/],
    // Guard two: the neighbouring rule. A symbol the page explains LEXICALLY is an <abbr>,
    // and deleting one would take the page's own key out of the document.
    ["a symbol the page explains lexically is the abbreviation rule, not this one",
      /a symbol the page explains LEXICALLY, by saying what it stands for, is the abbreviation rule below rather than this one/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/page.md no longer says: ${what}`);
  }
});

// #130 and #121, both on multilingual pages, and they pull in opposite directions: one
// user asked for the structure to be applied to every language variant, the other asked
// for a Korean page to be translated into English.
//
// The parity half is a rule. The translation half is declined, and the reason is pinned as
// a clause so a later reading of #121 does not re-add it: a translation is not a word on
// the page (the fidelity sentence above), the original cannot be recovered from what this
// agent emits, and a mistranslation is undetectable to precisely the reader who would be
// relying on it. What that reader actually needs from the markup is `lang`, which is a
// pronunciation fact a screen reader cannot get anywhere else.
test("the page agent's multilingual rule keeps parity, lang, and the refusal to translate", () => {
  const prompt = normalize(section("System prompt")!);
  for (const [what, re] of [
    // #130: the reporter's page repeated its recipes in several languages and only the first
    // got the list markup they had asked for.
    ["every rule applies to each language variant of the same content",
      /A page that prints the same content in more than one language gets the same treatment in each/],
    ["parity is stated on the structures it was reported on",
      /where the English steps are an <ol> the French steps are an <ol>, where one recipe's ingredients are a <ul> so are the other's/],
    ["structure that stops at the first language is worse than none, and why",
      /the document then looks handled to everyone except the reader it failed/],
    // #121: the language was never identified anywhere in the output. The shared
    // accessibility requirements ask for language attributes in one line
    // (src/pipeline/accessibility.ts); this says which element carries it and in what form.
    ["lang goes on the element that holds the change, with a BCP 47 tag",
      /Mark each change of language with lang on the element that holds it — <section lang="ko">, or lang="es" on the single <td> that switches — using the BCP 47 tag/],
    // And the case #121 actually reported: a page wholly in one language, which contains no
    // CHANGE of language, so a rule keyed on changes never fires for it. `wrapDocument`
    // (src/pipeline/assembly.ts) now derives the shell's lang from the body, but only where
    // every top-level element agrees — so a page that says nothing does not merely go
    // unlabelled itself, it drops the whole document back to lang="en" and takes its Korean
    // siblings with it. This is the other half of #163, and the incentive the sentence below
    // has to carry, because a page cannot see what the other pages said.
    ["a page wholly in another language carries lang on what it emits, change or no change",
      /A page wholly in one language changes language nowhere, and is the case that needs the attribute most: put lang on every top-level element you emit for it/],
    ["and the reason: the shell's language is derived from the pages, and only if they all say",
      /The document you are writing into takes its language from the pages inside it, and can only do that where they all say what they are: one fragment returned with no lang of its own leaves the whole document declared English, so a Korean page is delivered as English text, pronounced as English/],
    // The declined ask, with all three reasons, since any one of them alone reads as a
    // technicality.
    ["translation is refused",
      /And transcribe that language; do not translate it/],
    ["and the refusal gives its reasons: not the page's words, unrecoverable, undetectable",
      /those words are not words on the page, the original is not recoverable from what you emit, and a mistranslation is invisible to exactly the reader who would be relying on it/],
    ["what the reader actually needs is the attribute",
      /What a screen reader needs in order to pronounce the passage at all is the lang attribute/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/page.md no longer says: ${what}`);
  }
});

// #130's other ask: a section that runs through two named sub-topics, each with its own
// table, where the page marked the boundaries with bold type rather than with headings —
// so neither sub-topic was in the outline and the second table was unreachable by heading.
//
// This is the mirror image of #128 (a bold line that says something is not a heading), and
// the two are one page apart in the prompt, so the guard is what keeps them from cancelling
// each other: what makes a bold line a heading is that something is under it, which is the
// question the paragraph above already asks.
//
// #130 also asked for a parent <section> with an invented <h2> over two coordinate
// sub-topics ("Grounding Instructions" and "Extension Cords" grouped under a cord/electrical
// heading the page does not print). Declined: that heading is not a word on the page, and
// the outline it produces is one no reader can check against the source. The "none is
// invented" clause is pinned here for that reason.
test("the page agent promotes a sub-topic the page names, and invents no outline", () => {
  const prompt = normalize(section("System prompt")!);
  for (const [what, re] of [
    ["a named sub-topic with substantial content of its own is a heading under its section",
      /the name of each is a heading one level under that section's, even where the page marks the boundary with nothing but bold type, a rule, or extra space/],
    ["what it costs: moving by heading is how the second table is reached",
      /moving by heading is how a screen-reader user reaches the second of those tables/],
    ["the name is the page's own", /Use the name the page prints for each/],
    ["and where the page names nothing, no outline is supplied",
      /this promotes a label the page gives, it does not supply an outline the page does not have/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/page.md no longer says: ${what}`);
  }
});

// #113: the controls and basic operations of a machine, each with its explanation, came back as
// a run of paragraphs — and #95 reported the other end of the same element, a <dt> that had
// gained the group's name ("CONTACT: Name") from the fieldset around it. Both are the <dl>, so
// they are one bullet.
//
// Nothing downstream reaches this either. axe has no rule for "these six paragraphs name items
// and explain them", and the Reader Agent gets no source image, so it cannot tell a page that
// named its items from one that wrote continuous prose. The flattened view it does get is where
// the difference shows, and what it shows is measured in test/page-definition-lists.test.ts:
// identical words, and every [Term]/[Definition] marker gone.
//
// The guards are the reason this is a rule and not a preference. Applied to prose it turns
// paragraphs into terms; applied to a named sub-topic with a table under it, it buries a section
// that the heading rule promotes — which is the rule directly above it in the file, pulling the
// other way.
test("the page agent's definition-list rule keeps the clauses that make it a rule", () => {
  const prompt = normalize(section("System prompt")!);
  for (const [what, re] of [
    ["a series of named items with explanations is a <dl>, term and definition",
      /that is a <dl>: the name of each item as a <dt> and what the page says about it as the <dd> that follows/],
    // The reported case is exactly this shape, so it is quoted: a model that writes it has to be
    // able to recognise its own output in the rule.
    ["the bold-paragraph shape it replaces is named",
      /Setting them as paragraphs that open in bold \(<p><strong>Power:<\/strong> …<\/p>\) prints the same ink and keeps none of the structure/],
    ["what that costs a reader is named, not asserted",
      /nothing says how many items there are, which one is being read, or where one explanation ends and the next name begins/],
    // #113 asked for block content in the <dd> ("which may contain <p>, <ul>, or <ol>"), which
    // is granted: an explanation that runs to a list is the case that makes a <dl> better than a
    // table here. Pinned because it is the clause a model needs in order not to flatten one.
    ["an explanation longer than a phrase keeps its own blocks",
      /which may hold <p>, <ul> or <ol> where the explanation runs to more than a phrase/],
    // #95: the term is the page's word and nothing else. Same claim as the heading rule's
    // "transcribed as printed", on the other element.
    ["a <dt> is transcribed as printed, with no group name prepended",
      /Transcribe each <dt> exactly as the page prints the label and add nothing to it — <dt>Name<\/dt>, never <dt>CONTACT: Name<\/dt>/],
    ["and the reason the prefix is redundant is stated",
      /the heading, <legend> or <dl> the term sits in already says which group it belongs to/],
    // Guard one, the same guard the list rule needs: prose is not a structure to be imposed.
    ["a paragraph that merely opens with a capitalised phrase stays a paragraph",
      /a paragraph that happens to begin with a capitalised phrase is a paragraph/],
    // Guard two, and the boundary with the heading rule above. #113's own user wondered whether
    // level-3 headings would be better; they are, for an item with substantial content, and the
    // page agent has to be told which case it is looking at or the two rules contradict.
    ["a named item with substantial content of its own is a heading, not a term",
      /it is not the case where a named item has substantial content of its own — its own table, its own procedure, several paragraphs — which is a heading with that content under it/],
    ["and the <dl> is bounded to the case where the explanation is the item's own text",
      /A <dl> is right where an item's explanation is its own text and nothing more/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/page.md no longer says: ${what}`);
  }
});

// Two rules about the second pass rather than about the page.
//
// #132: a re-render regressed heading levels, table cells and semantic markup that the previous
// iteration had right — "a clear regression", reported by a user who had already accepted that
// output. Both paths that re-render a page show the model its own previous output, and only one
// of them said what to do with the parts nobody complained about (`priorSection` in
// renderPage against `correctPage`'s user message, src/pipeline/extraction.ts). The prompt is
// where the rule holds for both, and it has to name what "everything else" means, because a
// second pass re-deriving the page from the image produces defensible-looking output with the
// first pass's correct decisions quietly gone.
//
// #92: sheet music rendered as alt text. The suggestion half is straightforward; the half that
// needed amending is the issue's own instruction to keep the HTML minimal and defer to the
// specialist. A suggestion resolves to an agent FILE — `dispatchSpecialist` logs
// `specialist_unresolved` and returns the page unchanged when there is none, and `agents/` ships
// one specialist — so a page held back for a specialist that never runs is the page a reader gets.
test("the page agent is told what a second pass keeps, and what a suggestion does not deliver", () => {
  const prompt = normalize(section("System prompt")!);
  for (const [what, re] of [
    ["a previous output is the starting point, not a draft to replace",
      /Where the prompt shows you your previous output for this page, that output is the starting point and not a draft to replace/],
    ["what carries over is enumerated, so 'everything else' is not left to judgement",
      /the same heading at the same level, the same table with the same cells, the same list, the same alt text, the same lang/],
    ["what re-deriving costs is named, and that nothing downstream sees it",
      /Re-deriving the page from the image instead is how the second pass costs a reader what the first one got right, and nothing downstream can tell that it did/],
    // The escape valve, so the rule does not forbid mentioning a real defect it was not asked
    // about: it goes in "log", which is where everything not delivered as the document goes.
    ["a defect outside the problem is logged rather than fixed or ignored",
      /If you can see that something outside the problem is wrong, fix the problem, leave that alone, and say what you saw in the "log" field/],
    ["sheet music is the worked example of a page needing a specialist",
      /Sheet music is the example to reason from/],
    ["what a description of notation cannot be a substitute for is stated",
      /what a reader needs is the music — an audio rendering, and a machine-readable notation such as ABC or MusicXML/],
    ["and the alt-text transcription the issue reported is refused by name",
      /do not write a measure-by-measure account of the notation into alt text as a stand-in/],
    // The amendment. Without it this rule trades a bad page for an empty one.
    ["a suggestion is a request, not a delivery, because the named agent may not exist",
      /A suggestion is a request and not a delivery — the agent you name may not exist in this deployment, in which case nothing runs and what ships is exactly what you returned/],
    ["so the page is rendered in full anyway, and what that means for a score is spelled out",
      /transcribe every word the page prints \(title, composer, tempo, lyrics, rehearsal marks, the caption\), put the score itself in a <figure>/],
    ["and the failure mode is named: a stub ships as a stub",
      /A page held back to a stub for a specialist that never runs is a page that ships as a stub/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/page.md no longer says: ${what}`);
  }
});

// The list of explicit structures is introduced by its own count, so adding a
// fifth bullet and leaving "Four" in place would have the prompt miscount itself.
test("the explicit-structures list agrees with the count that introduces it", () => {
  const prompt = section("System prompt")!;
  const NUMBERS: Record<string, number> = { Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9, Ten: 10 };
  const intro = prompt.match(/(\w+) structures are easy to render/);
  assert.ok(intro, "page.md no longer introduces the list of explicit structures");
  const claimed = NUMBERS[intro![1]];
  assert.ok(claimed, `"${intro![1]} structures" is not a number this test knows — add it above`);
  // The bullets are the SHOUTED ones: "- FOOTNOTES:", "- SIGNATURE AND FILL-IN BLOCKS:".
  const bullets = prompt.match(/^- [A-Z][A-Z -]+:/gm) ?? [];
  assert.equal(bullets.length, claimed, `the intro says ${claimed} structures but ${bullets.length} are listed: ${bullets.join(" ")}`);
});

test("DEFAULT_PAGE_PROMPT matches agents/page.md's instructions", () => {
  const fromFile = normalize(`${section("System prompt")}\n\n${section("Output contract")}`);
  assert.equal(
    normalize(DEFAULT_PAGE_PROMPT),
    fromFile,
    "DEFAULT_PAGE_PROMPT in src/pipeline/extraction.ts has drifted from agents/page.md. " +
      "Edit both, or delete the fallback if a bare checkout no longer needs to run.",
  );
});

// The JSON contract is what the extractor parses (`html` / `log` /
// `suggested_agent`); a drift there is not a wording difference, it silently
// yields no fragment. Asserted separately so a failure names the cause.
//
// Scoped to the contract section, not the whole file: `"log"` and
// `"suggested_agent"` are also named in the prose above it, so searching the
// whole document would still find them after the response template lost a key —
// the test would pass while the model was told to return something else.
test("both copies promise the same JSON response keys", () => {
  for (const [label, text] of [
    ["agents/page.md '## Output contract'", section("Output contract")!],
    ["DEFAULT_PAGE_PROMPT's response template", DEFAULT_PAGE_PROMPT.slice(DEFAULT_PAGE_PROMPT.indexOf("Respond with ONLY"))],
  ] as const) {
    for (const key of ["html", "log", "suggested_agent"]) {
      assert.match(text, new RegExp(`"${key}"\\s*:`), `${label} must document the "${key}" response key`);
    }
  }
});
