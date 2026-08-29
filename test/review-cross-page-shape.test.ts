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
    // terms the page never printed. So that case is left alone rather than reported — an issue
    // the editor is forbidden to close comes back every round and lands in @unresolved, which
    // `unresolved_rate` in GET /v1/quality counts and the weekly report threshold-compares.
    ["the fix has to be buildable from words the page prints",
      /The words the fix needs have to be on the page: a footer printing "Website: example\.com" as a sentence carries its own labels, and those are what the \[Term\]s are built from/],
    ["and where one side prints no labels at all, the difference is left alone",
      /Where one side prints no labels at all, a labelled footer against a line of bare values, leave it alone/],
    ["for the two reasons that make it unclosable",
      /nobody downstream may supply words a page never printed, and an issue that cannot be closed is reported again every round/],
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
  // given an image for are left alone. Since #250 that is also what the answer's shape does — a
  // block nobody names is delivered as it stands — but the instruction stays, because the two
  // guard different things: the shape stops a page from being rewritten by accident, and this
  // stops one from being rewritten on purpose.
  assert.match(editor, /Content on pages whose image is NOT attached is not yours to change unless an issue names it/);
});

// Issue #245's page-break half, and the same page/document split as the rule above. `agents/page.md`
// now commits a page to transcribing its own broken edge exactly — "public serv-" stays "public
// serv-", hyphen included — because the marker is the first thing a page emits, so the halves of a
// split sentence land in two replies and neither can join them (22 of 90 markers in the last bench
// round stand where a sentence carries on; 2 split a hyphenated word).
//
// That guarantee is worth nothing without this clause, which is what the review of the first version
// of #247 pointed out: the editor sees a whole document, so it sees both halves, and "public serv-"
// looks exactly like a text defect to fix. Nothing else would stop it — the correction guards
// measure SHRINKAGE (`isCorrectionShrunken`, src/pipeline/correction.ts), so a document that grew by
// an invented "ices" passes every gate Iris has, and axe has no rule for a word nobody printed. The
// fragments exist on main too; what is new is a prompt telling the page to keep them, which makes
// the editor's half load-bearing.
test("the editor is told a page-broken word is not a defect, and completing one is a text it may not add", () => {
  for (const [what, re] of [
    ["the case is named in the shape the corpus actually produces",
      /Where a paragraph ends "public serv-" and the next begins "ices in a State", or ends mid-sentence with the next continuing it in lower case/],
    // Bound to the same "two texts, there is no third" limit the guard above defers to, rather than
    // stated as a new prohibition of its own.
    ["completing one is named as the third text, which the editor may not add",
      /finishing one is the third text you may not add/],
    ["the cause is given: two replies, and the marker is why the split falls between them",
      /those halves came off two pages extracted by calls that could not see each other, and the page-break marker between them is why: it is the first thing a page emits, so the split falls between two replies rather than inside either/],
    // All three moves are forbidden, deletion included: a fragment dropped for reading broken is
    // text no other page will emit.
    ["neither half may be completed, rewritten, or deleted",
      /Do not complete the word, do not rewrite either half into a sentence that reads whole, and do not delete the fragment that looks broken/],
    ["and the reason is that the completion is a word no page printed",
      /every word of both halves is a word some page printed, and the completion is a word no page printed/],
    // The disposition is to leave it alone AND not report it, which is the opposite of the fidelity
    // rule below and deliberately so: the editor's only reporting channel is `fidelity_observed`,
    // whose contract excludes this twice over — "Report only pages whose image is attached" (a split
    // straddles two pages, usually neither attached) and a required `kind` from VERIFY_KINDS, none of
    // which describes a word broken at a page turn, since nothing is missing or wrong. Told to
    // "report it" the editor files a mistagged structure_wrong that lands as one
    // editor_fidelity_observed line with `unattached` incremented. The real record is the page
    // agent's own log, which is the half #248 can read.
    ["the disposition is to leave the text alone and off the observation list",
      /Leave the text as it stands, and leave it off your observation list as well/],
    ["because the channel excludes it: not an attached page, and no kind names it",
      /a split straddles two pages, usually neither of them one whose image you hold, and none of the kinds below names it, so filing it there is a mistagged fidelity report rather than a record anyone acts on/],
    ["the record that does exist is the page agent's log, and the join is a pass that holds both halves",
      /The record already exists — the page that opened mid-sentence said so in its own log — and joining the halves belongs to a pass that holds both/],
  ] as [string, RegExp][]) {
    assert.match(editor, re, `EDITOR_SYSTEM no longer says: ${what}`);
  }
});

// The Reader's half of the same rule, and the reason it is not optional: with EDITOR_SYSTEM now
// declining to complete a page-broken word, a Reader that reports one has raised an issue nobody may
// close. An issue the editor does not fix is reported as unresolved, comes back every round, and
// lands in `unresolved_rate` on GET /v1/quality (`src/store/db.ts`) — the exact cost READER_SYSTEM
// itself gives as the reason for leaving an unlabelled footer alone. So the clause sits beside the
// [not legible] / [page not fully transcribed] clauses, which exist for the same reason.
test("the Reader is told a page-broken sentence is not a defect and not its to report", () => {
  for (const [what, re] of [
    ["it is named as neither a markup defect nor a thing to report",
      /A sentence or a word broken at a page turn is not a defect in the markup, and it is not yours to report/],
    ["in the shapes the flattened view actually shows",
      /Where a paragraph ends "public serv-" and the next begins "ices in a State", or ends mid-sentence with the next continuing it in lower case/],
    ["with the cause given: two pages, two calls that could not see each other",
      /those are two pages transcribed exactly as they printed, by calls that could not see each other/],
    // The load-bearing half: the reason is the editor's refusal, so the two prompts have to agree or
    // one of them is spending a round every time this appears in a scanned document.
    ["and the reason tied to what the editor will do with such an issue",
      /The Copy Editor is told to leave both halves as they are and to invent no completion, so an issue naming one is an issue nobody may close: reported again every round, about text that is already right/],
    // Without this the rule is unusable in the direction that loses content. The distinguisher is a
    // page break, and it is invisible in the flattened view the Reader is told to read for reading
    // order: `flatten` has no case for <hr> or doc-pagebreak, and the bracket vocabulary above lists
    // no page-break token, so `…public serv-` and `ices in a State…` are adjacent with nothing
    // between them — indistinguishable from a paragraph one page truncated. A model that cannot see
    // the sign reads "say nothing" as covering both, and the in-page case is real content loss. So
    // the clause names the view the sign is actually in, and says what to do when it is absent.
    ["the sign is named, and the view it is actually in",
      /What tells you this is the case is a page break between the two halves, and you have to look in the HTML view to find one: it is an <hr> carrying role="doc-pagebreak", it announces nothing, and the flattened view shows the halves adjacent with nothing in between/],
    // The marker is conditional on the page printing a folio — `agents/page.md`: "Where the page
    // prints no number, emit no marker" — so "no marker between them" cannot mean "not a page turn".
    // On a document of unnumbered scans it would mean the opposite, and the Reader would file the
    // issue the editor is forbidden to close, which is the recurrence this whole pair of clauses
    // exists to prevent. The page index is the sign that survives an unnumbered page: two excerpts
    // means two pages.
    ["the page index is named as the sign that survives a page printing no number",
      /the page index below is the other sign, and you need it: a page that prints no number emits no marker at all, so a document of unnumbered scans has page turns and nothing marking them/],
    // The sign has to be one the index can actually show. Each entry is a HEAD slice —
    // `innerHtml.slice(0, excerptChars)` in `src/pipeline/pageindex.ts`, cut at
    // READER_INDEX_EXCERPT_CHARS = 200 for the Reader — so the first half of a split sits at the END
    // of its page's HTML and matches no excerpt at all. What is findable is the half that carries on,
    // because that is the head of the next page.
    // "at or near", because on a numbered page the marker is the first thing the page emits, so the
    // entry begins `<hr role="doc-pagebreak" …>` and the continuing words are a few tens of
    // characters in. Only on an unnumbered page are they at position 0.
    ["the sign is the continuing half at or near the head of a page's excerpt",
      /Each entry in that index is the START of a page, which is where the half that carries on will be: find "ices in a State" at or near the head of some page's excerpt — a numbered page puts its marker there first, so the words may be a little way in — and this is a page turn, marker or no marker, and there is nothing to report/],
    // And silence is the default when the index shows nothing either way, which is what actually keeps
    // an unclosable issue from being filed on a document the index cannot resolve.
    ["silence is also the answer when neither half can be placed",
      /Silence is also the answer where you cannot place either half — the halves as printed are right, and an issue about them is one nobody may close/],
    // Not "the break": this sentence sits inside the branch that begins "Where the HTML puts no page
    // break between them", so a break is the one thing there is none of, and naming it made the
    // condition unsatisfiable on a literal reading. What the Reader can point at is the words.
    ["and the reportable case names the words, not a break that branch has none of",
      /Only where both halves and the words they break between sit inside one page's own excerpt did the sentence break inside a page, and that is content the page did not return: a finding of the ordinary kind, and yours to make/],
  ] as [string, RegExp][]) {
    assert.match(reader, re, `READER_SYSTEM no longer says: ${what}`);
  }
});

// The clause above tells the Reader the page break is in the HTML view and not the flattened one,
// which is only worth saying while it stays true: a [Page break] token in `flatten` would make the
// instruction send the Reader to the wrong view. So the absence is pinned rather than assumed. If this
// fails because a token was added — which #248 has a reason to want — the fix is to point the clause
// at the flattened view, not to delete this test.
test("the page-break marker really is invisible in the flattened view", () => {
  const flat = flatten(wrapDocument(
    '<p>the cost of public serv-</p><hr role="doc-pagebreak" aria-label="Page 8" id="page-8"><p>ices in a State</p>',
  )).replace(/\s+/g, " ").trim();
  assert.match(flat, /public serv- ices in a State/);
  assert.doesNotMatch(flat, /Page 8|doc-pagebreak|\[Page/);
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
