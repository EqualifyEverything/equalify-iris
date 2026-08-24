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

// The page-break rule (issue #145) came from a delivered document that shipped a SERIOUS
// axe violation from one empty element: six of its seven `role="doc-pagebreak"` markers
// carried their page number as text and the seventh was `<p role="doc-pagebreak"
// aria-label="Page 5" id="page-5"></p>`, which is `aria-prohibited-attr`.
//
// The gate does catch this one — unlike the heading and image rules above, the shape is
// decidable from the document, and test/lint-pagebreak.test.ts pins that it fires. What it
// cannot do is stop it shipping: the marker is the page agent's own invention (nothing in
// src/ emits one), the re-lint that would have raised it is the last thing a deployment
// running `iterations_max: 1` does, and the document was delivered with it. So the rule is
// asserted here as well, on the two clauses that make it a rule rather than a preference —
// the number goes in as text, and the attribute stays off even when text is present. The
// second is the load-bearing one: an `aria-label` beside text lints clean, which is exactly
// how the same pattern passed six times in one document and failed once.
test("the page agent's page-break rule keeps the clauses that make it a rule", () => {
  const prompt = normalize(section("System prompt")!);
  for (const [what, re] of [
    ["the marker carries its page number as text and no name attribute",
      /the marker carries the page number the page prints as its text content, and carries no aria-label and no aria-labelledby: <p role="doc-pagebreak" id="page-5">5<\/p>/],
    ["the attribute is prohibited on the role rather than merely redundant",
      /role="doc-pagebreak" is named by its own contents, which makes a name supplied as an attribute prohibited on it rather than merely redundant/],
    // Without this the rule reads as "put the number in", which the failing document's six
    // healthy markers already did while still carrying the prohibited attribute — one lost
    // its text and the attribute became a violation.
    ["the reported shape is named as the serious violation it is",
      /<p role="doc-pagebreak" aria-label="Page 5" id="page-5"><\/p> is a SERIOUS violation, because the prohibition only bites when the element is empty/],
    ["an empty marker is not emitted in any form", /Never emit an empty marker in any form/],
    ["a boundary with no legible number is logged instead of marked",
      /Where the page prints no number you can read, leave the marker out and note the boundary in the "log" field/],
    // The generalisation has to stay compatible with the footnote rule a few bullets up,
    // which puts aria-label on an <a> (a link takes a name) — so it is written as where the
    // attribute belongs, not as a blanket ban.
    ["a name attribute belongs only on an element whose role takes one",
      /aria-label belongs on an element whose role takes one — a link, a button, a table, a region — never on a <p>, <span> or <div> that is only holding text/],
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
