// Issue #99, the half `agents/page.md` cannot hold: one class of content marked up two ways on
// two pages.
//
// The user's report was a document whose footer line was a definition list on some pages and a
// sentence on others, and whose parallel sections opened at <h1> on one page and <h2> on the
// rest. The page agent is shown one page and no other — it says so in its own prompt — so it
// cannot know which shape its neighbours used, and the rule it CAN follow (a labelled footer is a
// <dl>, the same way on every page that prints one) still leaves the pages that already went
// through a call that decided otherwise. Nothing else reaches it either: axe has no rule for
// "page 4 marks this up differently from page 5", and the fidelity verifier judges one page
// against one image, so both shapes are faithful.
//
// The Reader Agent is the only pass that sees the joined document, which is why this rule lives
// beside the duplicate-heading rule (test/review-headings.test.ts) rather than in the page prompt.
// What is pinned here is the instruction and its three guards, plus the one thing the instruction
// depends on being true: that the flattened view the Reader is given actually distinguishes the
// two shapes. If it did not, this would be a rule asking for a report nobody can make.
import { test } from "node:test";
import assert from "node:assert/strict";
import { READER_SYSTEM, EDITOR_SYSTEM } from "../src/pipeline/review.ts";
import { flatten } from "../src/pipeline/flatten.ts";
import { wrapDocument } from "../src/pipeline/assembly.ts";

const normalize = (s: string): string => s.replace(/\s+/g, " ").trim();
const reader = normalize(READER_SYSTEM);
const editor = normalize(EDITOR_SYSTEM);

test("the Reader is told to report one class of content marked up two ways", () => {
  for (const [what, re] of [
    ["the defect is named as one only the joined document shows",
      /One class of content marked up two ways is a defect of the same kind, and only the joined document shows it either/],
    // Why it happens, so the Reader does not read a difference as two different kinds of
    // content: the pages were rendered by calls that could not see each other.
    ["its cause is stated: pages extracted one at a time by calls that could not see each other",
      /The pages were extracted one at a time by calls that could not see each other/],
    // The reported case, in the vocabulary the Reader actually receives — [Term]/[Definition]
    // against a plain sentence, and a heading level that differs across parallel pages.
    ["the reported shapes are named in the markers the Reader is given",
      /may announce \[Term\]\/\[Definition\] pairs on one page and a plain sentence on the next, and sections of one sort may open at \[Heading 2\] on four pages and \[Heading 1\] on the fifth/],
    // One issue, not one per page. Twelve footers reported separately would spend the round's
    // whole issue list on one defect and attribute each to a different page.
    ["it is reported as one issue, naming both sides and the majority shape",
      /Report the group as ONE issue, naming the pages on both sides and which shape most of them use/],
    ["so that what follows is a page brought into line rather than a document rewritten",
      /so what follows is a page brought into line rather than a document rewritten/],
  ] as [string, RegExp][]) {
    assert.match(reader, re, `READER_SYSTEM no longer says: ${what}`);
  }
});

test("the rule's guards keep it from reporting differences that are not the defect", () => {
  for (const [what, re] of [
    // Guard one, and the one that keeps this from swallowing the document: two sections are
    // comparable only where the excerpts show they are the same KIND of thing.
    ["the content has to be the same kind on both pages, shown by the excerpts",
      /The content has to be the same KIND on both pages and the excerpts have to show you that/],
    ["sections that merely differ are not an inconsistency",
      /a table of contents and a parts list are not one class, and a page whose content has no counterpart is not either/],
    // Guard two: the Reader is given the body in windows (CHUNK_BUDGET), so "every other page
    // does it the other way" is a claim it often cannot check. Same containment as the
    // missing-content rule further down the prompt.
    ["a windowed read judges only the pages it can see",
      /where your HTML is one window of several, a shape you meet once here may be the majority shape in the rest of the document/],
    ["so the report is a difference between two pages, not a page unlike the ones it cannot see",
      /report a difference between two pages you can both see, never a page that looks unlike the pages you cannot/],
    // Guard three, and the one that ties this to what the Copy Editor is allowed to do: a
    // footer of bare values cannot be brought into line with a labelled one without writing
    // terms the page never printed.
    ["a difference the document's own words cannot close is reported as that",
      /where one side carries words the other does not print, a labelled footer against a line of bare values, say so, because the fix cannot supply words a page never had/],
  ] as [string, RegExp][]) {
    assert.match(reader, re, `READER_SYSTEM no longer says: ${what}`);
  }
});

// The other side of that last guard, held to the editor's own limit rather than assumed. The
// Reader is told the fix cannot supply words because EDITOR_SYSTEM says so: there are exactly two
// texts the editor may add, and a <dt> for an unlabelled value is neither. A rule asking the
// Reader to report something the editor cannot act on would come back as unresolved every round.
test("what the editor may add is what the Reader's guard defers to", () => {
  assert.match(
    editor,
    /which is one of the two texts you may add here \(the other is under the markers below, and there is no third\)/,
    "EDITOR_SYSTEM no longer bounds what text it may add, so the Reader's guard has nothing to defer to",
  );
  // And the standing instruction that makes a per-page fix safe at all: pages the editor was not
  // given an image for are carried over.
  assert.match(editor, /Content on pages whose image is NOT attached must be carried over unchanged unless an issue names it/);
});

// The instruction above is only worth giving if the difference is visible in what the Reader
// receives. It is: the flattened view is where the two shapes stop being the same words.
test("the two footer shapes are different in the view the Reader is actually given", () => {
  const announced = (body: string): string => flatten(wrapDocument(body)).replace(/\s+/g, " ").trim();
  const asList = announced(
    "<dl><dt>Website</dt><dd>example.com</dd><dt>E-mail</dt><dd>help@example.com</dd></dl>",
  );
  const asSentence = announced("<p>Website: example.com | E-mail: help@example.com</p>");

  assert.match(asList, /\[Term\] Website \[Definition\] example\.com \[Term\] E-mail \[Definition\] help@example\.com/);
  assert.doesNotMatch(asSentence, /\[Term\]|\[Definition\]/);
  // Same words on both pages, which is why nothing that counts text can see this: the fidelity
  // verifier compares a page against its image and finds both faithful.
  for (const flat of [asList, asSentence]) {
    for (const word of ["Website", "example.com", "E-mail", "help@example.com"]) {
      assert.ok(flat.includes(word), `"${word}" should survive both shapes`);
    }
  }
});
