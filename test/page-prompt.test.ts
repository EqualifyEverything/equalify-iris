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
// Nothing downstream can recover this. The lint gate does not see heading levels at
// all: axe-core tags `heading-order` `best-practice`, and `src/pipeline/lint.ts`
// restricts `runOnly` to the WCAG tags and re-enables only the two duplicate-id
// rules by name — so even the blatant case (<h2> then <h4>) lints clean here, let
// alone an <h2> that should have been an <h3>. The Reader Agent never sees the
// source image either (see READER_SYSTEM in src/pipeline/review.ts), so it cannot
// know which heading the page subordinated to which. The extraction prompt is the
// only place the information exists, which is why this is asserted rather than left
// to the review loop.
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

// The list of explicit structures is introduced by its own count, so adding a
// fifth bullet and leaving "Four" in place would have the prompt miscount itself.
test("the explicit-structures list agrees with the count that introduces it", () => {
  const prompt = section("System prompt")!;
  const NUMBERS: Record<string, number> = { Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8 };
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
