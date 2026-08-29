// Issue #251: 18% of page answers emit a `<main>` of their own, `wrapDocument` puts the assembled
// body inside one, and the delivered document ships a `main` inside a `main` — which takes away the
// landmark a screen-reader user jumps to in order to skip the furniture. Three axe rules describe
// it, all three are tagged `best-practice`, and this pipeline's WCAG-only tag filter dropped all
// three, so the gate reported the document clean.
//
// Three things are pinned here, because the fix has three parts and they fail differently.
//
// The REWRITE (landmarks.ts) is where the defect actually stops: a `<main>` that reaches the body
// is taken out of it, and the interesting half is what it does with a tag carrying attributes,
// since unwrapping one would silently drop a `lang` the document's root declaration is derived from
// or an `id` an `href` elsewhere resolves to.
//
// The GATE is the check that the rewrite worked, and its exact rule set is a decision worth
// pinning: two rules enabled by name, and a third — `landmark-unique` — deliberately left off
// because it fires on shapes this pipeline produces on purpose. Which rule reports which shape is
// an axe internal that a version bump can move, so the quiet cases are asserted as firmly as the
// loud ones (the same argument as test/lint-heading-order.test.ts).
//
// The PROMPTS are what stops it being emitted in the first place. All six models in the bench's
// lineup did this, at rates that do not separate them, which is the signature of a missing
// instruction rather than a weak model: nothing told them the shell already exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripNestedMain } from "../src/pipeline/landmarks.ts";
import { assembleBody, bodyLang, wrapDocument } from "../src/pipeline/assembly.ts";
import { runAxe } from "../src/pipeline/lint.ts";
import { EDITOR_SYSTEM, READER_SYSTEM } from "../src/pipeline/review.ts";
import { DEFAULT_PAGE_PROMPT } from "../src/pipeline/extraction.ts";
import type { Fragment } from "../src/pipeline/fragment.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pageMd = readFileSync(join(repoRoot, "agents", "page.md"), "utf8");

function page(order: number, innerHtml: string): Fragment {
  return { image: `p${order}.png`, order, agent: "page.md", region: "page", innerHtml, edges: [], log: "" };
}

// The rule ids a document violates, or null when the lint could not run at all (#164) — the
// same shape test/lint-heading-order.test.ts uses, and for the same reason: a lint that threw is
// neither a clean document nor a dirty one, and asserting on it would be asserting on the
// environment.
async function rules(body: string): Promise<string[] | null> {
  const lint = await runAxe(wrapDocument(body));
  if (!lint.violations) return null;
  return lint.violations.map((v) => v.id).sort();
}

// ---------------------------------------------------------------- the rewrite

test("a bare <main> loses its tags and its children are promoted", () => {
  const out = stripNestedMain("<main><h2>Controls</h2><p>Text.</p></main>");
  assert.equal(out.html, "<h2>Controls</h2><p>Text.</p>");
  assert.deepEqual([out.unwrapped, out.downgraded, out.declined], [1, 0, 0]);
});

// The reason a `<main>` with attributes is not simply unwrapped. `bodyLang` derives the document's
// root `lang` from the top-level elements of the body (assembly.ts, #163/#195), so dropping this
// tag would deliver a Korean document as English — the exact defect that derivation exists to
// prevent — and an `id` is what an `href="#p3"` on another page resolves to.
test("a <main> carrying attributes becomes a <div> and keeps every one of them", () => {
  const out = stripNestedMain('<main id="p3" lang="ko" aria-label="3쪽"><h2>가</h2></main>');
  assert.equal(out.html, '<div id="p3" lang="ko" aria-label="3쪽"><h2>가</h2></div>');
  assert.deepEqual([out.unwrapped, out.downgraded, out.declined], [0, 1, 0]);
});

test("the document's derived language survives the downgrade, and can only improve on the unwrap", () => {
  // Downgraded: the tag that carried the answer is still a top-level element carrying it.
  assert.equal(bodyLang(stripNestedMain('<main lang="ko"><h2>가</h2></main>').html), "ko");
  // Unwrapped: the wrapper had no `lang`, so the derivation was refused before — one segment with
  // nothing to read. Promoting the children exposes the answer they were carrying all along.
  assert.equal(bodyLang('<main><section lang="ko"><p>가</p></section></main>'), null);
  assert.equal(bodyLang(stripNestedMain('<main><section lang="ko"><p>가</p></section></main>').html), "ko");
});

// `role="main"` is the one attribute a downgrade cannot keep: it would put the landmark straight
// back on the element whose tags were rewritten to remove it.
test("a role=main token is dropped on the way to <div>, and any other role is kept", () => {
  assert.equal(stripNestedMain('<main role="main" id="p1"><h2>A</h2></main>').html, '<div id="p1"><h2>A</h2></div>');
  assert.equal(stripNestedMain('<main role="main region"><h2>A</h2></main>').html, '<div role="region"><h2>A</h2></div>');
  assert.equal(stripNestedMain("<main role=main><h2>A</h2></main>").html, "<div><h2>A</h2></div>");
});

test("two <main> wrappers in one body are both taken out", () => {
  const out = stripNestedMain("<main><h2>A</h2></main>\n\n<main><h2>B</h2></main>");
  assert.equal(out.html, "<h2>A</h2>\n\n<h2>B</h2>");
  assert.deepEqual([out.unwrapped, out.downgraded, out.declined], [2, 0, 0]);
});

// `<main>` cannot legally contain another one, but a model is not a validator, and pairing by depth
// is what stops the inner one's `</main>` being read as the outer one's.
test("a <main> inside a <main> is paired by depth, not by the next end tag", () => {
  const out = stripNestedMain('<main><main lang="ko"><p>가</p></main><p>b</p></main>');
  assert.equal(out.html, '<div lang="ko"><p>가</p></div><p>b</p>');
  assert.deepEqual([out.unwrapped, out.downgraded, out.declined], [1, 1, 0]);
});

// There is no correct edit for half a wrapper: the element's extent is whatever the parser decides,
// and both guesses move content into or out of a landmark. Left alone and counted, which is what
// makes the enabled axe rules the thing that reports it.
test("half a wrapper is declined and the string is left exactly as it was", () => {
  for (const body of ["<main><h2>A</h2>", "<h2>A</h2></main>"]) {
    const out = stripNestedMain(body);
    assert.equal(out.html, body, `declined input was rewritten: ${body}`);
    assert.deepEqual([out.unwrapped, out.downgraded, out.declined], [0, 0, 1]);
  }
});

// A partial pairing is not all-or-nothing, and this is the shape that says so: two start tags and
// one end tag. An HTML parser closes the INNERMOST open element, so that end tag really does pair
// with the second `<main>` — which is therefore a whole wrapper and is removed — while the first is
// half of one and is left for the gate. Handling only what it can pair is what keeps this rewrite
// from having to guess at an extent.
test("an unmatched start tag does not stop the pair inside it being handled", () => {
  const out = stripNestedMain("<main><main><h2>A</h2></main>");
  assert.equal(out.html, "<main><h2>A</h2>");
  assert.deepEqual([out.unwrapped, out.downgraded, out.declined], [1, 0, 1]);
});

test("a body with no <main> comes back byte-identical", () => {
  // Which the review loop depends on: it decides a round changed nothing by comparing two body
  // strings (`review_converged` in review.ts).
  const body = '<h2>Controls</h2><p>A mainsail is not a landmark.</p><hr role="doc-pagebreak" aria-label="Page 2">';
  const out = stripNestedMain(body);
  assert.equal(out.html, body);
  assert.deepEqual([out.unwrapped, out.downgraded, out.declined], [0, 0, 0]);
});

test("the tag name is matched on a word boundary, so <mainsail> is untouched", () => {
  const body = "<mainsail><p>x</p></mainsail>";
  assert.equal(stripNestedMain(body).html, body);
});

// The reason attributes are stepped through from the front of the tag instead of searched: a
// search for `role` finds one inside another attribute's VALUE and splices it out of that value,
// which is a silent content edit — the same hazard assembly.ts documents for ` lang=` and avoids
// the same way.
test("role= inside another attribute's value is text, not an attribute", () => {
  const out = stripNestedMain('<main title="see role=main note" id="p1"><p>x</p></main>');
  assert.equal(out.html, '<div title="see role=main note" id="p1"><p>x</p></div>');
  // And the real one is still found when it comes after such a value.
  assert.equal(
    stripNestedMain('<main title="see role=main note" role="main"><p>x</p></main>').html,
    '<div title="see role=main note"><p>x</p></div>',
  );
});

test("only the first spelling of role is read, which is the one a parser sees", () => {
  assert.equal(stripNestedMain('<main role="region" role="main"><p>x</p></main>').html, '<div role="region" role="main"><p>x</p></div>');
});

// A `<main>` inside a comment is not an element. Counting it would put a `page_main_stripped`
// line in the run log with `declined: 1`, which promises a violation the gate cannot report,
// because axe does not see comments either. This body carries comments by design (`@page-failed`
// marks a lost page), so the shape is a live one.
test("a <main> inside a comment is neither counted nor edited", () => {
  const body = "<!-- <main> --><h2>A</h2>";
  const out = stripNestedMain(body);
  assert.equal(out.html, body);
  assert.deepEqual([out.unwrapped, out.downgraded, out.declined], [0, 0, 0]);
});

test("a commented end tag does not close a real <main>, and nothing is edited inside the comment", () => {
  const out = stripNestedMain("<main><p>x</p><!-- </main> --><p>y</p></main>");
  assert.equal(out.html, "<p>x</p><!-- </main> --><p>y</p>");
  assert.deepEqual([out.unwrapped, out.downgraded, out.declined], [1, 0, 0]);
});

test("a > inside an attribute value does not end the start tag early", () => {
  const out = stripNestedMain('<main title="a > b" id="p1"><p>x</p></main>');
  assert.equal(out.html, '<div title="a > b" id="p1"><p>x</p></div>');
});

// The `replace`-through-a-function reason, spelled out as a case: a `$&` in a surviving attribute
// value is a character and not a back-reference.
test("a $ in a kept attribute value survives the rewrite", () => {
  const out = stripNestedMain('<main role="main" title="$& $\'"><p>x</p></main>');
  assert.equal(out.html, '<div title="$& $\'"><p>x</p></div>');
});

test("tag names and the role token are matched case-insensitively", () => {
  assert.equal(stripNestedMain("<MAIN><p>x</p></Main>").html, "<p>x</p>");
  assert.equal(stripNestedMain('<Main ROLE="MAIN"><p>x</p></MAIN>').html, "<div><p>x</p></div>");
});

test("whitespace inside the start tag still counts as no attributes", () => {
  assert.equal(stripNestedMain("<main ><p>x</p></main >").html, "<p>x</p>");
});

// ------------------------------------------------------------- the assembly

test("the reported case: a page that emits its own <main> no longer ships one", async () => {
  const body = assembleBody([
    page(1, "<main><h2>Controls</h2><p>Before use.</p></main>"),
    page(2, "<h2>Operation</h2><p>Turn the dial.</p>"),
  ]);
  assert.ok(!/<\/?main\b/i.test(body), `a <main> reached the delivered body: ${body}`);
  assert.match(body, /<h2>Controls<\/h2>/);
  assert.match(body, /<h2>Operation<\/h2>/);
  const found = await rules(body);
  if (found === null) return;
  assert.deepEqual(found, [], `the assembled document is not clean: ${found.join(", ")}`);
});

test("the same document, before the strip, is what the gate now catches", async () => {
  const found = await rules("<main><h2>Controls</h2><p>Before use.</p></main>");
  if (found === null) return;
  assert.deepEqual(found, ["landmark-main-is-top-level", "landmark-no-duplicate-main"]);
});

// -------------------------------------------------------------- the gate

test("the residue the rewrite declines is reported rather than delivered quietly", async () => {
  // Half a wrapper — `stripNestedMain` leaves it, so this is what the gate is for.
  const found = await rules("<main><h2>Controls</h2>");
  if (found === null) return;
  assert.deepEqual(found, ["landmark-main-is-top-level", "landmark-no-duplicate-main"]);
});

test("a role=main on an element that was never a <main> is reported, not rewritten", async () => {
  const body = '<div role="main"><h2>Controls</h2></div>';
  // Not this rewrite's business: deleting a role a model chose, on an element whose own semantics
  // do not cover it, is the judgement roles.ts deliberately refuses to make.
  assert.equal(stripNestedMain(body).html, body);
  const found = await rules(body);
  if (found === null) return;
  assert.deepEqual(found, ["landmark-main-is-top-level", "landmark-no-duplicate-main"]);
});

// `landmark-unique` is the third rule axe fires on a nested main, and it is deliberately NOT
// enabled. These are the shapes that would light up if it were — every one of them ordinary output
// from a document that prints the same furniture on more than one page. If a future change enables
// it, this test is the argument to answer, not a test to delete.
test("the rule left off stays off: repeated page furniture is not a violation", async () => {
  for (const [what, body] of [
    ["two navigation regions with no accessible name", '<nav><a href="#a">A</a></nav><h2>T</h2><nav><a href="#b">B</a></nav>'],
    ["two pull-out notes", "<aside><p>1</p></aside><h2>T</h2><aside><p>2</p></aside>"],
    ["two regions the page names alike", '<section aria-label="Notes"><p>a</p></section><section aria-label="Notes"><p>b</p></section>'],
  ] as [string, string][]) {
    const found = await rules(body);
    if (found === null) return;
    assert.deepEqual(found, [], `${what} is now a violation: ${found.join(", ")}`);
  }
});

// And the reason it would not be a good gate for this defect even at the cost of those false
// positives: it is quiet on exactly the nested `<main>` that carries a label, because the accessible
// names differ. The two rules enabled fire on it.
test("a labelled nested <main> is caught by the rules that are enabled", async () => {
  const found = await rules('<main aria-label="Page 1"><h2>Controls</h2></main>');
  if (found === null) return;
  assert.deepEqual(found, ["landmark-main-is-top-level", "landmark-no-duplicate-main"]);
});

test("an ordinary assembled body is still clean under the added rules", async () => {
  const found = await rules(
    '<h2>Controls</h2><p>Text.</p><hr role="doc-pagebreak" aria-label="Page 2" id="page-2">' +
      "<h2>Operation</h2><table><caption>Settings</caption><tbody><tr><th scope=\"row\">A</th><td>1</td></tr></tbody></table>",
  );
  if (found === null) return;
  assert.deepEqual(found, [], `a legitimate document now fails the gate: ${found.join(", ")}`);
});

// ------------------------------------------------------------- the prompts

// The missing fact, in both copies of the page agent's contract. `DEFAULT_PAGE_PROMPT` is held
// word-for-word identical to `agents/page.md` by test/page-prompt.test.ts, so this asserts the
// clause in both rather than trusting that.
test("both copies of the page contract say the shell already supplies <main>", () => {
  for (const [label, text] of [
    ["agents/page.md", pageMd],
    ["DEFAULT_PAGE_PROMPT", DEFAULT_PAGE_PROMPT],
  ] as [string, string][]) {
    assert.match(text, /no <html>, <head>, <body> or <main> wrapper/, `${label} must forbid a <main> wrapper by name`);
    assert.match(
      text,
      /it supplies <html>, <head>, <body>\s*\n?\s*and the <main> that holds every page's content/,
      `${label} must say the document supplies the four wrappers`,
    );
    assert.match(text, /a <div role="main"> is the same landmark under another name/, `${label} must close the role spelling`);
    assert.match(
      text,
      /the landmark a screen-reader user jumps to in order to skip the furniture/,
      `${label} must say what a second <main> costs`,
    );
  }
});

// Issue #252. One sentence read, to four of six models, as "put `lang` on every top-level element
// of every page", and they quoted it back as their authority for flagging English pages that have
// no `lang` — a false claim that costs a re-extraction each time (`accessible: false` in
// feedback.ts). The condition was only ever implied by the Korean example two sentences later.
//
// This file is what the verify pass quotes as the contract it judges against (feedback.ts sends
// `agents/page.md` verbatim), so the sentence is the fix on both sides: the extractor stops
// decorating English pages with a redundant attribute, and the judge stops having grounds to
// report one for lacking it.
test("the lang rule names the condition instead of leaving it to the example", () => {
  for (const [label, text] of [
    ["agents/page.md", pageMd],
    ["DEFAULT_PAGE_PROMPT", DEFAULT_PAGE_PROMPT],
  ] as [string, string][]) {
    const flat = text.replace(/\s+/g, " ");
    assert.match(
      flat,
      /A page wholly in one language OTHER THAN ENGLISH changes language nowhere/,
      `${label}'s lang rule must say which pages it is about`,
    );
    assert.match(
      flat,
      /An English page is the case that needs nothing, and the sentence above is not asking for it/,
      `${label} must say plainly that an English page needs no lang`,
    );
    assert.match(
      flat,
      /A page that omits it is correct and is not to be reported for omitting it/,
      `${label} must tell a judge reading this contract that the omission is not a defect`,
    );
    // Sonnet put `lang` on an `<img>`, and another judge correctly observed that the attribute is
    // meaningless there — so the literal reading produced markup that does nothing as well as a
    // false claim.
    assert.match(flat, /On an element that holds no text of its own — an <img>, an <hr> — the attribute is meaningless/, `${label} must close the void-element case`);
    // The derivation this rule feeds is still asked for, which is the half that must NOT be lost:
    // a Korean document whose pages say nothing is delivered as English (#195).
    assert.match(flat, /put lang on every top-level element you emit for it/, `${label} must keep the rule the derivation depends on`);
  }
});

test("the editor is told the shell exists too, since it retypes the whole body", () => {
  assert.match(EDITOR_SYSTEM, /no <html>\/<head>\/<body>\/<main> wrapper/);
  assert.match(EDITOR_SYSTEM, /a <main> of your own would be a second one/);
});

// The Reader reads body content and never saw the shell, so a missing `<main>`, `<title>` or
// document `lang` is a WCAG requirement it is structurally invited to report against a document
// that has all three. Its own false claim would cost an editor round.
//
// The language half of that has to be stated as the shell's RULE and not as a fact about English,
// which is what the first version of this paragraph got wrong: `READER_SYSTEM` is a static const,
// the root language is `bodyLang(body) ?? "en"`, and telling a Reader that the document declares
// English is false for every document whose pages agree on Korean — and in exactly that document,
// an unlabelled English abstract IS a 3.1.2 Language-of-Parts failure that only the Reader can
// report, since axe cannot see a missing `lang` on a part (#163). So the prompt must leave that
// report available while removing the redundant `lang="en"` ask.
test("the reader is told what it cannot see, so it does not report the shell as missing", () => {
  const flat = READER_SYSTEM.replace(/\s+/g, " ");
  assert.match(flat, /What you are shown is the BODY CONTENT of the delivered document/);
  assert.match(flat, /a <main> that holds everything you can see/);
  assert.match(
    flat,
    /the shell declares the one language every top-level element of the body agrees on, and English only where they gave it nothing else to read/,
    "the reader must be told how the root language is derived, not that it is English",
  );
  assert.match(flat, /content in the document's own language needs no lang attribute of its own/);
  assert.match(
    flat,
    /A passage in a DIFFERENT language from the rest of the document is the opposite case and still needs one/,
    "the reader must keep its grounds for a language-of-parts report",
  );
  // The claim that cost the first version of this paragraph a blocking review: it is not English
  // that the document declares, it is whatever its pages agreed on.
  assert.doesNotMatch(flat, /English is what the document declares/);
});
