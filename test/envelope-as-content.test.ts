// A page agent's reply is either readable or it is not, and "not" is a reported outcome.
//
// Both page-agent calls in extraction.ts ended in the same fallback: `parsed?.html ??
// stripFences(res.text)`. It was there for a model that answers with bare HTML instead of the
// JSON envelope it was asked for, which is a real thing models do and should not cost a page.
// But it could not tell that reply apart from one that could not be read at all, so an
// envelope that failed to parse was delivered as the page's content — prose, braces, `"html":`
// and escaped markup and all (issue #168). Two things made that worse than a lost page:
//
//   * the run reported success. `pages_failed` was `[]`, `page_extraction_failed` never fired,
//     and the document said 100 of 100 pages delivered while one of them was a JSON object.
//   * the escaped markup inside the leaked string parses as tags whose ATTRIBUTE NAMES begin
//     with a digit or a backslash, which is what took axe-core down on the same documents
//     (#164). One unreadable reply cost the page AND the document's accessibility verdict.
//
// So the fallback now asks whether the text IS the page's HTML (`bareHtml`), and where it is
// not the page is lost the way every other unusable answer in this file is lost: an event, a
// `@page-failed` marker, and the page in `pages_failed` (test/page-failure.test.ts).
//
// One reply that used to be lost here is not unreadable at all: an envelope whose `html` is
// empty and whose `log` says the page is blank has answered the question completely, and it is
// now delivered as an empty page (`page_blank`, issue #179). That is the only empty reply that
// is — an absent `html` key, or an empty one that says nothing about why, is still the model
// giving up.
//
// The other half of the fix is upstream, in util/json.ts: most of these envelopes were
// complete, well-formed replies that `extractJson` refused only because the page's own
// quotation marks were unescaped inside the JSON string. Those are now parsed, so they never
// reach the fallback at all — which is the outcome to want, since a rescued envelope is a
// delivered page and a refused one is a lost one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExtraction, stripFences, bareHtml, declaredBlank, blankDeclaration } from "../src/pipeline/extraction.ts";
import { extractJson } from "../src/util/json.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// --- the four shapes real replies come in -------------------------------------

// Every fixture below was read off `agent_call.output` in an equalify-iris-bench run log,
// reduced to the smallest text that still fails the same way.

// The one the issue is about: a complete, well-formed envelope whose html string contains the
// document's own quotation marks, unescaped. `JSON.parse` stops at the quote before `(1)`.
const UNESCAPED_QUOTE =
  `{"html": "<blockquote><p>"(1) bring together representatives of the Federal, State and ` +
  `local governments</p></blockquote>", "log": ""}`;

// The output ceiling, mid-string. Nothing can finish it.
const TRUNCATED = `{"html": "<h1>Annual Report</h1><p>The committee met on`;

test("a fence's info string is not part of the page", () => {
  // `stripFences` knew only ```html, so a ```json fence — which is what a model writes when
  // it wraps the envelope it was asked for — kept the word `json` inside the text it returned.
  // Every leaked envelope in the bench logs begins with that line, which is how the shape was
  // first identified.
  assert.equal(stripFences("```json\n{\"html\": \"<p>Hi</p>\"}\n```"), '{"html": "<p>Hi</p>"}');
  assert.equal(stripFences("```html\n<p>Hi</p>\n```"), "<p>Hi</p>");
  assert.equal(stripFences("```\n<p>Hi</p>\n```"), "<p>Hi</p>");
  // And prose before the fence is not part of the page either: the fence says where the page
  // starts, so a model that introduces its answer costs nothing.
  assert.equal(stripFences("Here is the page:\n\n```html\n<p>Hi</p>\n```"), "<p>Hi</p>");
  // No fence at all is the commonest good reply, and passes through untouched.
  assert.equal(stripFences("<p>Hi</p>"), "<p>Hi</p>");
  // And when a model fences more than once, the page is the LAST block — the same rule
  // util/json.ts takes for the envelope, and for the same reason: a model that drafts,
  // reconsiders and answers puts its answer last. A non-greedy match on the first fence
  // returns the draft it abandoned, which is the bare-HTML half of issue #170.
  assert.equal(
    stripFences("```html\n<p>draft</p>\n```\n\nOn reflection:\n\n```html\n<p>the page</p>\n```"),
    "<p>the page</p>",
  );
  // A fence the model opened and never closed is not a block: what follows it is the reply,
  // not a page inside it, so this falls through to the whole text rather than returning the
  // draft above it.
  assert.equal(stripFences("```html\n<p>Hi</p>"), "```html\n<p>Hi</p>");
});

test("extractJson reads every envelope shape a model actually sends", () => {
  const html = (t: string): string | undefined => extractJson<{ html?: string }>(t)?.html;
  assert.equal(html('{"html": "<p>Hi</p>"}'), "<p>Hi</p>");
  assert.equal(html('```json\n{"html": "<p>Hi</p>"}\n```'), "<p>Hi</p>");
  assert.equal(html('```\n{"html": "<p>Hi</p>"}\n```'), "<p>Hi</p>");
  // A conversational preamble in front of the object, fenced or not.
  assert.equal(html('Here is the converted page:\n\n{"html": "<p>Hi</p>"}'), "<p>Hi</p>");
  assert.equal(html('Sure — here you go:\n\n```json\n{"html": "<p>Hi</p>"}\n```'), "<p>Hi</p>");
  // The one this pair exists for: the page quotes itself, and the model does not escape it.
  // Before util/json.ts learned to repair this, the whole reply went into the document.
  assert.match(String(html(UNESCAPED_QUOTE)), /^<blockquote><p>"\(1\) bring together/);
});

test("a backslash the page prints is a character, not a broken escape", () => {
  // The real reply: a title page whose log describes its own decoration. `\'` is not a JSON
  // escape, so the parse stopped at it and a whole page went with it.
  const reply =
    `{"html": "<h1>Measures of State and Local Fiscal Capacity</h1>",` +
    ` "log": "decorative diagonal slash marks (visible as '\\' before 'MEASURES')"}`;
  const parsed = extractJson<{ html?: string; log?: string }>(reply);
  assert.match(String(parsed?.html), /^<h1>Measures of State/);
  assert.match(String(parsed?.log), /visible as '\\' before/);
  // The escapes JSON does allow are still escapes when the repair pass runs over them, and
  // are not doubled on the way past: a `\n` turned into a literal backslash-n would put two
  // characters into the document where the model wrote a line break, and a doubled `é`
  // would put five where the page has an é.
  const repaired = extractJson<{ html?: string }>('{"html": "a\\nb "x" caf\\u00e9"}');
  assert.equal(repaired?.html, 'a\nb "x" café');
});

test("an envelope nothing can read stays unread, rather than being guessed at", () => {
  // Truncation is the case no repair can help: the rest of the page is not in the reply.
  assert.equal(extractJson(TRUNCATED), null);
  assert.equal(extractJson("I could not read this page."), null);
  // Nor is structure repaired. This is a real Feedback Agent verdict with a `}` where a `]`
  // belongs, and inferring which bracket the model meant is inventing structure — on a path
  // whose output is delivered to a reader as the document. Since #170 the search reads on
  // past a span it could not parse, so what comes back is the one sub-object that IS valid
  // JSON — but the outer braces are still not mended, and the verdict is what the caller
  // reads (`parsed?.issues ?? []` in review.ts, `parsed.faithful` in feedback.ts). So the
  // reply still says nothing, which is the outcome that matters here.
  assert.equal(extractJson<{ issues?: unknown[] }>('{"issues": [{"issue": "a column was dropped"}}]}')?.issues, undefined);
});

test("the answer is the model's last one, not the first thing shaped like one", () => {
  const html = (t: string): string | undefined => extractJson<{ html?: string }>(t)?.html;

  // A brace the agent quoted in its own prose. Before #170 the search stopped at the first
  // `{` in the text, which cost six Feedback Agent verdicts in the bench logs outright.
  assert.equal(html('The contract is {html, log}. My answer: {"html": "<p>Hi</p>"}'), "<p>Hi</p>");
  // And the harder version of the same thing: the quoted fragment PARSES. This is a real
  // Reader reply, whose prose quotes the JSON wrapper it is complaining about — and it
  // quotes it in the shape of an envelope, so binding it would answer with the decoy.
  const quoted =
    'The wrapper text (`{"html":"`, `\\n`, `","log":"..."}`) is read aloud.\n\n' +
    '{"issues": [{"issue": "raw JSON in the reading order", "pages": [9]}]}';
  assert.deepEqual(extractJson<{ issues?: { pages?: number[] }[] }>(quoted)?.issues?.[0]?.pages, [9]);

  // The reply this issue was filed for, in miniature: a reasoning model writes a scratch
  // template while thinking and its real answer at the end. The template parses cleanly, so
  // nothing downstream could tell — an 8,334-character page was delivered as three characters
  // and logged as a kept correction.
  const scratch =
    `I'll re-read the image.\n\n{ "html": "...", "log": "...", "suggested_agent": null }\n\n` +
    `Here is the corrected output:\n\n{"html": "<h2>Table 3</h2>", "log": "Page 17."}`;
  assert.equal(html(scratch), "<h2>Table 3</h2>");

  // Four fenced envelopes, three of them abandoned drafts that say so in their own `log`.
  // Also real, and the reason the fenced block is no longer a pre-step: the first fence is
  // the first draft, and `stripFences`'s non-greedy match ends at the first closing fence.
  const drafts = [
    ["RESTART — re-reading the image.", "<p>draft one</p>"],
    ["Intermediate attempt abandoned — the column count does not match.", "<p>draft two</p>"],
    ["Page 36. Southeast through Rocky Mountain rows, all values checked.", "<p>the page</p>"],
  ]
    .map(([log, body]) => "```json\n" + JSON.stringify({ html: body, log }) + "\n```")
    .join("\n\nLet me try again:\n\n");
  assert.equal(html(drafts), "<p>the page</p>");

  // A shorter last answer still wins, which is what separates "the last one" from "the
  // biggest one". Real reply: the model noticed it had used a forbidden inline event handler,
  // said so, and sent a corrected envelope 548 characters shorter than the one above it.
  const fixed =
    `{"html": "<img src=\\"x\\" onerror=\\"this.remove()\\"><p>Path to net zero</p>"}\n\n` +
    `**Correction pass** — the inline event handler is forbidden per contract:\n\n` +
    `{"html": "<img src=\\"x\\"><p>Path to net zero</p>"}`;
  assert.equal(html(fixed), '<img src="x"><p>Path to net zero</p>');

  // What "last" does not mean: the innermost. Everything inside an object that parsed belongs
  // to it, so a nested object is never read as a later answer.
  assert.equal(html('{"html": "<p>Hi</p>", "suggested_agent": {"name": "table-agent"}}'), "<p>Hi</p>");

  // The cost of the rule, stated so it is a decision and not a surprise: a decoy AFTER the
  // answer wins. Nothing in five bench rounds does this — every decoy in the logs is a draft
  // or a quotation, and both come before the answer a model settles on — and on the page path
  // a correction that comes back a fraction of the size it replaces is refused anyway.
  assert.equal(html('{"html": "<p>the page</p>"}\n\nThe contract was {"html": "..."}.'), "...");
});

test("bareHtml accepts an HTML answer and refuses an envelope", () => {
  // What the fallback was for, and what it must keep doing: a model that ignores the envelope
  // and returns the page is not a failure.
  assert.equal(bareHtml("<h1>Annual Report</h1><p>2026</p>"), "<h1>Annual Report</h1><p>2026</p>");
  assert.equal(bareHtml("```html\n<h1>Annual Report</h1>\n```"), "<h1>Annual Report</h1>");
  assert.equal(bareHtml("<!-- a comment first --><p>Hi</p>"), "<!-- a comment first --><p>Hi</p>");

  // And what it must refuse. Each of these was delivered to a user as a page's content.
  assert.equal(bareHtml(TRUNCATED), null, "a truncated envelope is not the page");
  assert.equal(bareHtml('```json\n{"html": "<p>Hi</p>"}\n```'), null, "a fenced envelope is not the page");
  assert.equal(bareHtml(UNESCAPED_QUOTE), null);
  // The `"html":` test is on the whole text, not the first character: a reply that opens with
  // a sentence and then quotes the envelope is the same content in a different order.
  assert.equal(bareHtml('I had trouble here.\n{"html": "<p>Hi</p>"'), null);
  assert.equal(bareHtml("I could not read this page."), null, "prose is not the page");
  assert.equal(bareHtml("   "), null);
});

test("only a reply that says the page is blank is read as a blank page", () => {
  // The whole distinction between a page delivered empty and a page reported lost. It has to
  // be a positive test: an empty `html` with a sentence about why is the commonest shape a
  // vision model GIVES UP in, and read as a declaration it leaves nothing in the delivered
  // document to look at — no marker, no notice, no entry in `pages_failed`.
  assert.equal(declaredBlank({ html: "", log: "This page is blank." }), true);
  assert.equal(declaredBlank({ html: "   ", log: "The page is empty; there is nothing to transcribe." }), true);
  assert.equal(declaredBlank({ html: "", log: "No visible content on this page." }), true);
  assert.equal(declaredBlank({ html: "", log: "This page is intentionally left blank." }), true);

  // The reply that most needs a human to look at the page. Every one of these stays a failure.
  assert.equal(declaredBlank({ html: "", log: "The scan is too dark to resolve any text." }), false);
  assert.equal(declaredBlank({ html: "", log: "I could not read this page." }), false);
  assert.equal(declaredBlank({ html: "", log: "The image is illegible." }), false);
  // A hedge is not a declaration: doubt about whether the paper is empty is the doubt that
  // decides this, so the unreadable wording has the last word over the blank wording.
  assert.equal(
    declaredBlank({ html: "", log: "The page appears blank, though the scan is too faint to be sure." }),
    false,
  );

  // A model describing the IMAGE's condition has said why its answer is unreliable without ever
  // saying it failed, which is the half a wordlist of ways to say "I could not" misses. Every one
  // of these read as a blank declaration until it was checked.
  assert.equal(declaredBlank({ html: "", log: "The page is very dark and appears empty." }), false);
  assert.equal(declaredBlank({ html: "", log: "The scan quality is too poor; no text is discernible." }), false);
  assert.equal(declaredBlank({ html: "", log: "Low resolution scan; no text." }), false);
  assert.equal(declaredBlank({ html: "", log: "The image is too noisy to read; no text." }), false);
  assert.equal(declaredBlank({ html: "", log: "The image did not load; no content." }), false);
  // The predicative form, which is how a model usually writes it — and the fixture above is
  // refused by `too poor` rather than by anything about quality, so without these two the
  // quality wording has no test at all.
  assert.equal(declaredBlank({ html: "", log: "The page appears empty; the scan quality is poor." }), false);
  assert.equal(declaredBlank({ html: "", log: "The page appears blank; the image quality is degraded." }), false);
  assert.equal(declaredBlank({ html: "", log: "The page is blank; the text is not in focus." }), false);
  // A hedge with no infinitive after it is still a hedge.
  assert.equal(declaredBlank({ html: "", log: "The page appears blank; the contrast is too low." }), false);
  assert.equal(declaredBlank({ html: "", log: "The page appears blank; the exposure is too low." }), false);
  // The veto leans wide, so a blank page whose log mentions the scan is a failed page. That costs
  // a glance, which is the cheap side of this trade.
  assert.equal(declaredBlank({ html: "", log: "The page is blank, and the scan is faint." }), false);
  // But only over words that carry doubt. These logs express none, and refusing them would put a
  // `@page-failed` marker and an incompleteness notice on a complete document — the #179 defect,
  // back again on the pages the veto overshot.
  assert.equal(declaredBlank({ html: "", log: "Page is empty. High quality scan, nothing printed." }), true);
  assert.equal(
    declaredBlank({ html: "", log: "The page is blank; the image is slightly rotated, no content." }),
    true,
    "geometry is not legibility: a rotated page reads fine",
  );

  // And the shapes that answered nothing at all.
  assert.equal(declaredBlank({ log: "no content" }), false, "no `html` key: the question went unanswered");
  assert.equal(declaredBlank({ html: "" }), false, "nothing said about why");
  assert.equal(declaredBlank({ html: "", log: "   " }), false);
  assert.equal(declaredBlank({ html: "", log: "Converted the page." }), false, "which says nothing about emptiness");
  assert.equal(declaredBlank(null), false);
  // A page with content in it is a page, whatever its log says.
  assert.equal(declaredBlank({ html: "<p>Hi</p>", log: "This page is blank." }), false);
});

test("a log describing the specks on an empty sheet is not a log doubting the scan", () => {
  // Round 9 of the bench delivered five blank pages and lost four, and all four were lost to one
  // word inside the agent's own explanation of WHY the page is blank (issue #190). The same
  // vocabulary means opposite things depending on what it is about: `faint specks` is what is on
  // the paper, `the scan is faint` is what is wrong with the image. Two pages of one document
  // opened with a verbatim identical sentence and only the one that went on to explain itself was
  // refused, which is the proof the wording was being measured and not the page.
  //
  // These four are the real logs, at the length the round produced them.
  assert.equal(
    declaredBlank({
      html: "",
      log: "Page is blank. Specks/dots are visible on the page but do not resolve into any characters or content.",
    }),
    true,
    "`do not resolve into characters` IS the blank declaration, stated about the marks",
  );
  assert.equal(
    declaredBlank({
      html: "",
      log:
        "Page is blank. The visible marks are artifacts of the scan (dust/noise) and do not resolve " +
        "into any characters or content.",
    }),
    true,
  );
  assert.equal(
    declaredBlank({ html: "", log: "Page is blank. A few faint specks/artifacts are visible but no legible text or content." }),
    true,
  );
  assert.equal(
    declaredBlank({
      html: "",
      log:
        "Page is blank. No printed page number is visible, so no page-break marker is emitted. The page " +
        "contains only a few scattered specks/dots that appear to be scanning artifacts, not legible text " +
        "or meaningful content.",
    }),
    true,
    "the page whose only difference from a delivered one was the sentence explaining itself",
  );

  // The prompt asks for both halves of the observation in one breath — name the marks, deny the
  // text — so a name for text only affirms text where it is not negated. Otherwise the MORE explicit
  // answer is the one that loses its page: the first two here are #190's own logs with a plain "no
  // text" added, and most of what a blank page's log names is a thing it is denying.
  for (const log of [
    "Page is blank. Specks/dots are visible on the page but no text and they do not resolve into any characters or content.",
    "Page is blank. The visible marks are artifacts of the scan with no text and do not resolve into any characters or content.",
    "Page is blank. Specks and dots are visible, no legible text, and they do not resolve into characters.",
    "Page is blank. Only scanner dust is present, no printed text, nothing that would resolve into words.",
    "Page is blank. Faint specks with no legible text do not resolve into characters.",
    "Page is blank. Specks are visible, no content, and they do not resolve into characters.",
    "Page is blank. Dust only, no figures or images, nothing that would resolve into characters.",
    "Page is blank. Scanner artifacts with no legible content do not resolve into characters.",
    // `marks` counts as a name for the marks only where something says they are not content, because
    // the page prompt uses the bare noun for the opposite case.
    "Page is blank. Stray marks do not resolve into characters.",
    "Page is blank. Stray markings are visible but they are not legible text.",
    // And the same observation, re-punctuated. The gap crosses one sentence or semicolon boundary, so
    // a full stop instead of a `but` is not what decides whether the page survives — which was
    // #190's finding about per-call wording, one level down. What may follow the boundary is a
    // CONTINUATION of the observation: the marks referred back to, no subject at all, or a denial.
    "Page is blank. Specks/dots are visible on the page. They do not resolve into any characters.",
    "Page is blank. A few specks are visible; they do not resolve into any characters.",
    "Page is blank. A few scattered specks/dots. Not legible text or meaningful content.",
    "Page is blank. A few specks are visible. Does not resolve into printed words.",
    "Page is blank. Some dust is present. The specks do not resolve into characters.",
    "Page is blank. A few specks. It does not resolve into words.",
    "Page is blank. A few specks. It is not legible text.",
    "Page is blank. A few specks. There is nothing that resolves into words.",
    "Page is blank. Some dust. But nothing resolves into words.",
    // What may follow the denial is the clause ending, more of the same denial, or the substrate —
    // naming the whole sheet is another way of saying it is empty.
    "Page is blank. A few specks. Not legible text on the page.",
    "Page is blank. A few specks. Not legible text at all.",
    "Page is blank. A few specks. Not legible text visible.",
    "Page is blank. A few specks. Not legible text present.",
    "Page is blank. Only scanner dust; not legible text of any sort.",
    "Page is blank. A few specks. Not legible text anywhere on the page.",
    "Page is blank. A few specks. Not legible print and no writing.",
    "Page is blank. A few specks. Not legible text or content of any kind.",
    // A comma, a semicolon or a line break ends a clause where what follows continues the denial:
    // these logs are written as loose notes.
    "Page is blank. A few specks.\nNot legible text\nNo page-break marker is emitted.",
    "Page is blank. A few specks, not legible characters, nothing else.",
    "Page is blank. A few specks. Not legible text\n- no page number\n- no content",
    // The marks named again are a continuation with or without a determiner, and `any` denies as
    // plainly as `no` where what follows it is a name for text.
    "Page is blank. A few specks. Not legible text, only dust.",
    "Page is blank. A few specks. Not legible text; only scanner dust.",
    "Page is blank. A few specks. Not legible text, nor any figures.",
    "Page is blank. A few specks. Not legible text or anything at all.",
    // What follows the denial is judged word by word rather than branch by branch, so wordings nobody
    // wrote a branch for pass on the same rule as the ones that were: every word in them is part of
    // the denial, and none of them names a thing the page bears.
    "Page is blank. A few specks. Not legible text anywhere.",
    "Page is blank. A few specks. Not legible text detected.",
    "Page is blank. A few specks. Not legible text whatsoever.",
    "Page is blank. A few specks. Not legible text seen anywhere on the sheet.",
    "Page is blank. A few specks. Not legible text across the page.",
    "Page is blank. A few specks. Not legible text, no numerals, nothing at all.",
    "Page is blank. Only dust. Not legible markings of any kind on this sheet.",
    // A name for text is read back over qualifiers, so a denial may go on qualifying what it denies.
    "Page is blank. A few specks. Not legible text or any other printed words.",
    // `image` is the substrate where a locative preposition introduces it, and these are the wordings
    // that spell the empty scan that way. The other reading of the same word is refused below.
    "Page is blank. A few specks. Not legible text in this image.",
    "Page is blank. A few specks. Not legible text anywhere in the image.",
    // And the object of `resolve into` is exempt from the tail read, because the `do not` ahead of the
    // construction is what governs it — these are the plainest wordings there are.
    "Page is blank. A few specks. They do not resolve into words.",
    "Page is blank. Only dust, nothing that would resolve into any legible characters.",
    // `detected` affirms in "and printing detected" and denies here, under the `not` that governs the
    // whole tail — so it is not read as a verb, and this wording is the reason why.
    "Page is blank. A few specks. Not legible text or content detected.",
    // A denial tail carries its own verbs, so the search for an affirming one stops at the negator that
    // opens the next denied clause. The last of these is #190's own log with the page-number clause the
    // page prompt asks for joined by a comma instead of a full stop — the same wording accident the
    // issue is about, one punctuation mark down.
    "Page is blank. A few specks. Not legible text or content, and no writing is visible.",
    "Page is blank. A few specks. Not legible text or content; no words are present.",
    "Page is blank. A few specks. Not legible text or content of any kind, nothing is printed on the sheet.",
    "Page is blank. A few specks. Not legible text or figures, none are visible.",
    "Page is blank. Specks/dots are visible on the page but do not resolve into any characters or content, and no page number is printed.",
    "Page is blank. Specks/dots are visible but do not resolve into any characters or content; no page-break marker is emitted.",
    "Page is blank. A few scattered specks/dots that appear to be scanning artifacts, not legible text or meaningful content, and no printed page number is visible.",
  ]) {
    assert.equal(declaredBlank({ html: "", log }), true, log);
  }

  // What is exempt is the PHRASE and not the sentence, which is the difference between narrowing
  // the veto and disabling it. Every one of these names the marks and denies text in the same
  // breath as describing the scan — the shape the real logs are written in — and the description of
  // the scan is still doubt: delivered blank, each would be an empty fragment with no
  // `@page-failed` marker and nothing in `pages_failed`, on a page that may well have text on it.
  for (const log of [
    "Page is blank. The scan is blurry, showing only faint specks and no legible text.",
    "Page is blank. The page is a low resolution scan with dust specks and no text.",
    "The page is blank: a grainy, washed-out scan with a few specks and no legible content.",
    "Page appears blank. Out of focus scan, only dust and no text visible.",
    "The page is blank. The scan is very dark and only specks/dots are visible, no legible text.",
    "Page is blank. Poor quality scan showing dust and no printed text.",
    "Page is blank. Only a partial scan is visible, with specks and no legible text.",
    // The same word as the marks phrase, about the image instead: `noise` is exempt only in a
    // joined tail (`dust/noise`), never on its own, because alone it is the scan being described.
    "Page is blank. The scan has noise, and no text.",
    "The page is blank; there is faint text on it.",
    // `resolve into` and `not legible <noun>` are exempt only where the marks are named ahead of
    // them in the same clause, which is the subject the exemption claims they are about. Each of
    // these says the opposite — there IS something printed, and it could not be read.
    "Page is blank. The text does not resolve into legible words.",
    "Page appears blank. Any printing that may exist does not resolve into readable text.",
    "Page is blank. Some ink is present on the page but it does not resolve into words.",
    "Page appears blank. There is printing in the margin, not legible text.",
    "Page is blank. The typed lines are not legible characters.",
    // And the anchor is a clause, not a log: marks in one sentence do not exempt the next.
    "Page is blank. A few specks are on the sheet. The printed lines do not resolve into words.",
    // Nor does naming the marks first exempt an affirmation of text later in the same sentence. The
    // anchor's gap cannot cross a name for text, which is what makes the marks what is being denied.
    "Page is blank. A few specks are visible, but the printed text does not resolve into words.",
    "Page is blank. Apart from dust, the typed lines are not legible text.",
    "Page is blank. Dust is present, and the handwriting does not resolve into words.",
    // What the gap must not cross is an affirmation that the page has something on it, and a page
    // bears more than text. `content` above all: the other half of this rule already counts it as a
    // name for text, and the two cannot disagree about the same word.
    "Page is blank. Apart from dust, the content is not legible text.",
    "Page is blank. A few specks are visible, but the figures do not resolve into words.",
    "Page is blank. Dust is present, and the stamp does not resolve into words.",
    "Page is blank. A few specks, and the signature does not resolve into words.",
    // The veto list has to match the inflections its own exemption matches. `resolve` was bare
    // between word boundaries, so the third person slipped past the veto entirely — and each of
    // these says printing exists and did not come out as characters.
    "Page is blank. The text resolves into no legible words.",
    "Page appears blank. The handwriting resolves into no characters.",
    "Page is blank. Whatever is printed here resolves into nothing legible.",
    // `marks` bare is the page prompt's own phrase for the case where the page HAS content that could
    // not be read ("where marks do not resolve into characters even then, write `[not legible]`"), so
    // it is a name for the marks only when something else says they are not content — `stray marks`
    // above. Otherwise the instruction for reporting unreadable content would be read as a blank page.
    "Page is blank. Handwritten marks do not resolve into characters.",
    "Page is blank. Pen marks do not resolve into characters.",
    "Page is blank. Tick marks and check marks do not resolve into characters.",
    "Page is blank. Blurry marks are visible, no text.",
    "Page is blank. The markings are not legible text.",
    // A dark streak or a dark spot is a condition of the capture and can cover content, which is why
    // `dark` is a veto word at all — the same reason `shadows` is not a name for the marks either.
    "Page is blank. The scan shows dark streaks.",
    "Page is blank. The scan shows dark spots.",
    "Page is blank. The scan shows dark blotches.",
    "Page is blank. The scan shows dark shadows.",
    "Page is blank. Only faint stains from the scanner are visible.",
    // A boundary may be crossed by a continuation of the observation, not by a second, different one.
    // Marks named in one sentence do not exempt a denial about another page object in the next, and
    // this is the one place the veto lists cannot catch it afterwards: the veto word IS the phrase
    // being stripped.
    "Page is blank. A few specks of dust are visible. The handwritten note in the corner does not resolve into words.",
    "Page is blank. Dust and specks. The photograph does not resolve into detail.",
    "Page is blank. Some smudges appear at the edge; the ink does not resolve into words.",
    "Page is blank. A few specks are visible. The graphic does not resolve into words.",
    // A pronoun or a conjunction is the other way a new subject gets across a boundary, so `it` and
    // `there` have to carry their verb with them and a conjunction is only a prefix to one of the
    // other openers. Each of these names a page object behind a word that looks like a back-reference.
    "Page is blank. A few specks. It is a photograph that does not resolve into detail.",
    "Page is blank. A few specks are visible. There is a handwritten note that does not resolve into words.",
    "Page is blank. Some dust. But the graphic does not resolve into words.",
    "Page is blank. Some dust. And the barcode does not resolve into words.",
    // Inversion is the third form of that door, so `nor`/`neither` are prefixes and a bare `does` has
    // to carry its `not`.
    "Page is blank. Some dust. Nor does the barcode resolve into words.",
    "Page is blank. Some dust. Nor the handwriting resolves into words.",
    // Where a name for text sits on the far side of `not legible`, the gap cannot see it. Being told
    // WHERE it is is what separates it from a denial: text in the margin is something the page bears.
    // What may follow is a whitelist and not a list of the prepositions that refuse, so the
    // preposition nobody thought of costs a glance rather than the page.
    "Page is blank. Some dust. Not legible printing in the margin.",
    "Page is blank. A few specks are visible. Not legible text in the header.",
    "Page is blank. Scanner dust only; not legible writing along the edge.",
    "Page is blank. A few specks. Not legible writing over the seal.",
    "Page is blank. A few specks. Not legible print between the lines.",
    // And a whitelisted tail may not carry a placement in behind it: `visible` is a denial where the
    // clause ends there and a hole where it goes on to say where.
    "Page is blank. A few specks. Not legible text visible in the margin.",
    "Page is blank. A few specks. Not legible text anywhere in the margin.",
    "Page is blank. A few specks. Not legible text on the page in the margin.",
    // Nor may a separator: a note breaks a line, or drops a comma, exactly where it would otherwise
    // place the text — which is the same hole one character further along.
    "Page is blank. A few specks. Not legible printing\nin the margin.",
    "Page is blank. A few specks. Not legible writing seen\nover the seal.",
    "Page is blank. A few specks. Not legible text, in the header.",
    "Page is blank. A few specks. Not legible text detected, in the header.",
    // Going on to deny something else is a denial; going on to place it is not.
    "Page is blank. A few specks. Not legible text or the printing in the margin.",
    "Page is blank. A few specks. Not legible text either in the margin.",
    "Page is blank. A few specks. Not legible text\n- the note in the margin",
    // A denial word and a name for the marks are both ways of continuing the denial, and both were
    // ways of introducing a placement while the tail was a list of what may follow rather than a
    // rule about all of it. What decides these is the noun: `margin`, `seal`, `spine`, `binding`,
    // `edge`, `note`, `signature`, `stamp` are things the page bears, wherever they sit in the clause
    // and whatever leads into them.
    "Page is blank. A few specks. Not legible text, any writing in the margin.",
    "Page is blank. A few specks. Not legible content, any figures on the seal.",
    "Page is blank. A few specks. Not legible markings, any letters along the spine.",
    "Page is blank. Some scanner dust. Not legible text, any content is cut off at the binding.",
    "Page appears blank. A few specks/dots, not legible text, any markings are along the left edge.",
    "Page is blank. A few specks. Not legible text: any writing sits in the margin.",
    "Page is blank. A few specks. Not legible text\nany writing in the margin.",
    "Page is blank. A few specks. Not legible text, smudges over the handwritten note.",
    "Page is blank. A few specks. Not legible text, artifacts across the signature.",
    "Page is blank. A few specks, not legible text, dust across the stamp in the corner.",
    "Page is blank. A few specks. Not legible text\n- dust in the margin",
    "Page is blank. A few specks. Not legible text; only dust in the header.",
    "Page is blank. A few specks. Not legible text, nor any figures in the footer.",
    "Page is blank. A few specks. Not legible text or anything beneath the stamp.",
    "Page is blank. A few specks. Not legible text, the note is in the corner.",
    // The words a denial is built from build the opposite claim too, so the vocabulary alone cannot
    // decide it: each of these is made entirely of listed words and each says the page HAS something
    // on it — which is the case the bare-`marks` exclusion exists for, at its most explicit. What
    // separates them is that a name for what the page bears is introduced here by a determiner and
    // not by a denial. Naming the substrate stays exempt: "not legible text on the page" denies.
    "Page is blank apart from a few specks. Not legible text, only a heading is visible.",
    "Page appears blank. A few specks. Not legible text, only a line of handwriting is visible.",
    "Page is blank. A few specks. Not legible text, some printing appears on the page.",
    "Page is blank. A few specks. Not legible text, the page contains figures.",
    "Page is blank. A few specks. Not legible text; the handwriting is present.",
    "Page is blank. A few specks. Not legible text, some words remain visible.",
    "Page is blank. A few specks. Not legible text, the numerals are printed on the page.",
    "Page is blank. A few specks. Not legible printing, characters are present.",
    "Page is blank. A few specks. Not legible text, a caption is visible.",
    "Page is blank. A few specks. Not legible text, these words appear on the sheet.",
    "Page is blank. A few specks. Not legible text, some marks are visible.",
    // A conjunction introduces an affirmed noun as readily as a denied one, and only what comes after
    // the noun tells them apart: `or content of any kind` denies, `and printing is present` does not.
    "Page is blank. A few specks. Not legible text, and printing is present.",
    "Page is blank. A few specks. Not legible text, and figures are visible.",
    "Page is blank. A few specks. Not legible text, and words remain visible.",
    "Page is blank. A few specks. Not legible text, or headings appear on the page.",
    // The verb may sit anywhere before the end of the statement, since everything that can come between
    // is a substrate word: this is the same claim with a locative dropped into the middle of it.
    "Page is blank. A few specks. Not legible text, and printing on the page is visible.",
    "Page is blank. A few specks. Not legible text, and writing across the sheet is visible.",
    "Page is blank. Specks/dots do not resolve into any characters, and printing on the page is visible.",
    // The other reading of `image`: introduced by anything but a locative, it is an object on the paper
    // and a page whose one object is a photograph is where the cost of guessing is the page.
    "Page is blank. A few specks. Not legible text, an image is visible.",
    "Page is blank. A few specks. Not legible text, the page contains an image.",
    "Page is blank. A few specks. Not legible text, images remain visible.",
    // `resolve into` is the commoner of the two constructions on these pages — three of #190's four
    // logs use it — and `resolve` is the veto word in the clause, so stripping it takes the doubt off
    // the whole rest of the statement. The rest of the statement therefore has to deny too: the first
    // three here are #190's own logs with one more clause on the end.
    "Page is blank. Specks/dots are visible on the page but do not resolve into any characters, only a heading in the margin.",
    "Page is blank. Specks/dots are visible on the page but do not resolve into any characters or content, and a heading is visible in the header.",
    "Page appears blank. The visible marks are artifacts of the scan (dust/noise) and do not resolve into characters, only a caption at the foot of the page.",
    "Page is blank. A few specks/dots that appear to be scanning artifacts, they do not resolve into characters over the handwritten note.",
    "Page is blank. A few specks. They do not resolve into words, only a heading is visible.",
    "Page is blank. A few specks. They do not resolve into words, the caption is in the margin.",
    // A question mark is a hedge and not a full stop, and a bare one is the shape `HARD_DOUBT` cannot
    // see: the model asking itself whether the page is empty is not the model saying that it is.
    "Page is blank. A few specks. Not legible text?",
    // `any` is allowed ahead of a name for text, and the name is left where the gap can still see it.
    "Page is blank. A few specks. Any printing that may exist does not resolve into readable text.",
    // `nothing but the text` affirms the text. A negative word ahead of a name for text does not make
    // it a denial when the negative is spent on the exception.
    "Page is blank. Dust and specks, nothing but the handwriting, which does not resolve into words.",
    "Page is blank. Dust and specks, nothing except the text, which does not resolve into words.",
    "Page is blank. Dust, no matter the text, it does not resolve into words.",
    // `printing|prints` without bare `print` was the same two-lists-disagree-about-one-word shape as
    // `content`: `NOT_LEGIBLE_TEXT`'s own lookahead has counted `print` as a name for text all along.
    "Page is blank. A few specks are visible, but the print does not resolve into words.",
  ]) {
    assert.equal(declaredBlank({ html: "", log }), false, log);
  }

  // And no exemption reaches a word that says the reading failed or that hedges the answer,
  // wherever in the log that word sits.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Dust and noise obscure the text." }), false);
  assert.equal(
    declaredBlank({ html: "", log: "Page is blank. A few specks are visible and no text is legible, the scan is too dark." }),
    false,
  );
  assert.equal(
    declaredBlank({ html: "", log: "Page is blank. Only faint specks, though the scan may not be reliable." }),
    false,
    "a concession is a concession even where the only doubt word modifies the marks",
  );
  assert.equal(
    declaredBlank({ html: "", log: "Page is blank. Faint specks and dust, no characters — I could not read this page." }),
    false,
  );
  // Two the exemption must not reach through a nearby noun: `noisy` is about the scan and `faint`
  // is about text that the log says IS there. Each is refused on its own, in one sentence, so
  // neither depends on a word elsewhere in the log to fail.
  assert.equal(declaredBlank({ html: "", log: "The page is blank; the scan is noisy with artifacts, no text." }), false);
  assert.equal(
    declaredBlank({
      html: "",
      log: "Page is blank. No printed page number is visible, but a few specks and faint printed text appear in the margin.",
    }),
    false,
    "a denial of a page NUMBER is not a denial of text, and the log affirms text",
  );
});

test("a refused blank declaration says which word refused it", () => {
  // What the log line owed whoever reads it. Every one of #190's four pages had to be traced from
  // `shape: "empty_html"` — which reads as "the model answered with no page", the opposite of what
  // happened — back to a word, by rerunning the regexes on the reply by hand.
  const vetoed = blankDeclaration({ html: "", log: "The page is blank; the scan is too dark to resolve any text." });
  assert.equal(vetoed.asserted, true, "the log did claim the page was blank");
  assert.equal(vetoed.blank, false);
  assert.deepEqual(vetoed.vetoes, ["too dark to", "resolve", "dark"], "in the order the lists are checked");

  // Nothing to say where nothing was refused, and nothing to say where no claim was made.
  const clean = blankDeclaration({ html: "", log: "Page is blank." });
  assert.deepEqual(clean, { asserted: true, blank: true, vetoes: [] });
  assert.deepEqual(blankDeclaration({ html: "", log: "Converted the page." }), {
    asserted: false,
    blank: false,
    vetoes: [],
  });
  assert.deepEqual(blankDeclaration({ log: "no content" }), { asserted: false, blank: false, vetoes: [] });
  // A word inside an exempt clause is not a veto and is not reported as one.
  assert.deepEqual(
    blankDeclaration({ html: "", log: "Page is blank. A few faint specks are visible but no legible text." }),
    { asserted: true, blank: true, vetoes: [] },
  );
});

// Issue #194. Everything above asks whether the log casts DOUBT on the blankness it claims; none of it
// asks whether the log CONTRADICTS it. A log that says the page is empty and then says, in plain
// affirmative words, that something is on it casts no doubt at all — it states both — so all five of
// these declared the page blank on `main`, and the page shipped as an empty fragment with nothing in
// `pages_failed` and no incompleteness notice: a complete-looking document missing a page.
//
// The refusal does not decide which half of the log is true, because the text cannot say. It picks the
// direction whose cost is a glance: a page reported lost is a re-extraction, a page dropped in silence
// is a page nobody knows to look for.
test("a log that says something is on the page contradicts its own blank claim", () => {
  for (const log of [
    // #194's own three, verbatim.
    "Page is blank. There is handwriting on the page.",
    "Page is blank. A few specks; and handwriting is present.",
    "Page is blank. A few specks. Handwriting is present.",
    // ...and its two that sit just outside #193's tail read, which is scoped to the statement the
    // construction it guards is in. These reach the document without either construction.
    "Page is blank. A few specks. Not legible text. A heading is visible at the top.",
    "Page is blank. A few specks. Not legible text or content, and printing, no page number, is visible.",
    // The same claim in the wordings these logs are otherwise written in. Each is a name for text with
    // an affirming verb after it, which is the whole rule.
    "Page is blank. A signature is visible in the corner.",
    "Page is blank. A table is present.",
    "Page is blank. Headings are visible.",
    "Page is blank. Some words remain visible.",
    "Page is blank. A caption was visible at the foot.",
    // The transitive shape, where the subject is the paper and the text is the object — invisible to a
    // subject-verb scan, and measured as delivered-blank before the branch that reads it existed.
    "Page is blank. The page contains handwriting.",
    "Page is blank. The sheet still bears a heading.",
    "Page is blank. It shows two headings.",
    "Page is blank. The page has handwriting on it.",
    // A count between the verb and its object is how a page with something on it is usually described,
    // and the object is still the object.
    "Page is blank. There is some handwriting on the page.",
    "Page is blank. There are several figures.",
    // An `image` introduced indefinitely is a thing on the paper — the same reading `LOCATIVE` gives
    // the denial tails, settled here by the article instead, since neither wording has a preposition.
    "Page is blank. An image is visible on the page.",
    // Order does not matter: a log that affirms before it declares has still done both.
    "There is handwriting on the page. Page is blank.",
    // The declaration and the contradiction in one statement, which is where a comma-set-off denial
    // could otherwise hide the affirmation ("…, no page number, is visible" above).
    "Page is blank. A few specks. Not legible text, an illustration is visible.",
    // A coordination of nouns nothing denies is an affirmation of every one of them, which is the
    // other half of `negatedInList`: a negator reaching the whole list is only right where there IS
    // a negator (#200's review).
    "Page is blank. Handwriting and a signature are visible.",
    "Page is blank. Text or handwriting is present.",
    // And a second clause's subject is its own, however the first clause denied: the walk back from
    // `handwriting` stops at the verb of `no text is visible`.
    "Page is blank. No text is visible and handwriting is present.",
    // The negator's own member was the MARKS phrase, which is stripped before any of this runs — so
    // `no … and handwriting is visible` arrives with nothing in front of the conjunction, and a
    // denial of the marks says nothing about text. Both would read as denied by a negator that never
    // governed them.
    "Page is blank. No stray marks, and handwriting is visible.",
    "Page is blank. No specks or dust; and a heading is visible.",
    // The other side of the post-verb denial: the negator has to be the word RIGHT AFTER the verb.
    // Both of these have one further along, and reaching for it would refuse an affirmation of
    // handwriting — a page with writing on it, shipped empty and in silence. That is #194's cost, and
    // it is the reason the check does not follow a `but` clause or step over a qualifier, even though
    // #200's review named these as the same axis: an extra affirmation costs a glance at a page that
    // was fine, and a missed one costs the page.
    "Page is blank. Handwriting is visible but no printed text is present.",
    "Page is blank. Handwriting is clear, nothing else is on the sheet.",
    // Show-through. The reading is deliberate: `Printing … is faintly visible` affirms printing, and
    // whether the ink is on this side of the paper is a question about the page rather than about the
    // sentence. Reported, so someone looks; the alternative is a page with printing named in its own
    // log delivered as empty.
    "Page is blank. Printing from the reverse side is faintly visible; nothing is printed on this side.",
    // Two denials make an affirmation, and a page with writing on it must not be delivered empty
    // because its log said so twice. Contrived beside `is not present` — pinned because the post-verb
    // read is what makes them reachable at all, and each costs one lookup to not get wrong.
    "Page is blank. Handwriting is not absent.",
    "Page is blank. Text is never absent from this sheet.",
    // `without` is not a post-verb denial: `is without doubt visible` is an affirmation idiom, and the
    // wording it would have bought — `The sheet is without printing.` — already delivers, because a
    // definite substrate is the scan and not a thing on the paper. So it stays where the other
    // functions need it, in front of a noun (#200's review measured this one as a page this check
    // would otherwise have dropped in silence). The mirror cost, taken knowingly: `Printed text is
    // without exception absent.` is refused. The same two words cannot be an affirmation idiom in
    // front of a complement and a denial behind a verb, and `without exception absent` is stilted
    // where `is without doubt visible` is not.
    "Page is blank. A heading is without doubt visible at the top.",
    "Page is blank. Printed text is without exception absent.",
    // A denial that covers PART of the page and says what is on the rest of it (#204, filed off #200's
    // third review pass and delivered empty until now). The denial is real, so nothing before this read
    // it as anything else: `is absent` denies, and the affirmation lands in the words after it — a
    // second complement sharing the subject, an exception, or a noun the denial presupposes.
    //
    // These four are the issue's own rows, measured. Each one names something a reader would have got
    // nothing of: the bottom half of a page, a stamp, a figure, a diagram.
    "Page is blank. Text is absent from the top half and present at the bottom.",
    "Page is blank. Printing is nowhere except a stamp at the top.",
    "Page is blank. A caption is missing from the figure on the page.",
    "Page is blank. The label is absent from the diagram shown here.",
    // The same three reads in the other wordings, including the shape with no subject for the scan to
    // start from at all — `No printing except a stamp` has its denial in front of the noun, so the
    // stamp it names has no verb of its own to be affirmed by.
    "Page is blank. No printing except a stamp at the top.",
    "Page is blank. No text besides the caption under the figure.",
    "Page is blank. Content is nowhere other than a stamp in the corner.",
    "Page is blank. Text is absent apart from the signature at the bottom.",
    "Page is blank. Text is absent except for the heading.",
    "Page is blank. Text is not present except a stamp at the top.",
    "Page is blank. Printed text is missing but a heading is visible.",
    "Page is blank. Text is absent from the upper half and printed at the foot.",
    "Page is blank. Printing is absent from the top and still visible at the bottom.",
    "Page is blank. Handwriting is missing from the label on the sheet.",
    // The object walk reads `printed` as the adjective it is here rather than as the name for text
    // `TEXT_NOUN` also matches (#204's review), and these hold that the real object is still found
    // when there is one: the noun is two words past the preposition instead of next to it.
    "Page is blank. Text is missing from the printed heading.",
    "Page is blank. Nothing is legible except the printed caption.",
    // A complement at the end of its statement is a predicate with no noun after it to be an
    // adjective on, and predicating is what makes it an affirmation.
    "Page is blank. Text is absent from the top and still visible.",
  ]) {
    assert.equal(declaredBlank({ html: "", log }), false, log);
  }
});

// The other direction, and the one this check was nearly not worth making: a genuinely blank page's log
// affirms things constantly, and every one of those affirmations is about the marks. #194 named these
// two as the pages a whole-log affirmation check would cost — they are #190's, the defect this area
// exists downstream of — and the rest are the wordings the corpus and the veto lists' own tails put
// around them. Refusing any of these is #190 again, from the other end.
//
// It costs nothing extra to keep them, because the affirmation is read over the text the marks phrases
// have already been stripped from: with the marks phrase gone those sentences have no subject left to
// affirm anything about. `TEXT_NOUN` is the subject list for the same reason — `marks` and `markings`
// are deliberately absent from it, which is #193's decision about bare `marks` inherited rather than
// taken again in the other direction.
test("the affirmations a blank page's own log is made of are not contradictions", () => {
  for (const log of [
    // #194's two named casualties.
    "Page is blank. Specks do not resolve into characters. The marks are artifacts.",
    "Page is blank. A few specks. Not legible text. The specks are scanner dust.",
    // The same shape in the other wordings the corpus uses for it.
    "Page is blank. The visible marks are artifacts of the scan.",
    "Page is blank. Some dust is present.",
    "Page is blank. Stray markings are visible.",
    "Page is blank. There are a few specks.",
    "Page is blank. There are several stray marks.",
    "Page is blank. The page contains only scanner dust.",
    // A denial is not an affirmation, however many names for text it contains — the scan stops at the
    // negator that owns them, which is what keeps the page-number clause the prompt asks for.
    "Page is blank. Nothing is printed on the sheet.",
    "Page is blank. No text is visible.",
    "Page is blank. A few specks. Not legible text or content, and no writing is visible.",
    "Page is blank. A few specks. Not legible text or meaningful content, and no printed page number is visible.",
    "Page is blank. A few specks. Not legible text or figures; neither is visible.",
    "Page is blank. A few specks. There is nothing that resolves into words.",
    "Page is blank. The page does not contain any legible text.",
    "Page is blank. A few specks. The specks have not resolved into characters.",
    // A definite `image` is the scan being described, not a photograph on the paper. The cost of that
    // reading is "The image in the corner is a photograph", which is missed; the alternative refused
    // this line, which is in the corpus as a page that must still be delivered — geometry is not
    // legibility.
    "The page is blank; the image is slightly rotated, no content.",
    "Page is blank. The frame contains the image, which is rotated.",
    // The paper itself, and what it is not doing.
    "The sheet is empty. No printing is present.",
    "Page is blank. The page has been scanned at low contrast.",
    // A denial with more than one noun in it, which is what the review of #200 measured: about eleven
    // of thirty realistic blank-page wordings flipped to reported-failed on a fixed three-word
    // lookback, because `no legible text or handwriting is present` puts the negator FOUR tokens
    // behind the last noun of the list, which then reads as un-negated and finds the list's own
    // shared verb. Every one of these was a delivered blank page before #194 and has to stay one:
    // the twenty pinned above are all two nouns or shorter, which is why they did not catch it.
    "Page is blank. No legible text or handwriting is present.",
    "Page is blank. No legible text or printed characters are visible.",
    "Page is blank. No printed or handwritten content is visible anywhere on the sheet.",
    "Page is blank. A few specks of dust. No printed page number or heading is visible.",
    "Page is blank. No printed words, lines, or characters are visible.",
    "Page is blank. No text, printing, figures or writing is present.",
    "Page is blank. A few specks. No writing, figures or stamps are present.",
    "Page is blank. No headings, captions or labels are visible.",
    "Page is blank. No visible text, images or diagrams are present.",
    "Page is blank. Nothing but faint specks; no words, lines or numerals are visible.",
    "Page is blank. No content of any kind, printed or handwritten, is present.",
    // The same shape with the other joiners and the longer lists these logs use. The fourth is the
    // page-number clause `agents/page.md` asks for with one more noun conjoined onto it, which is
    // #190's own log — the defect this whole area exists downstream of.
    "Page is blank. No text, no figures and no captions are present.",
    "Page is blank. Neither text nor handwriting is visible.",
    "Page is blank. No words, letters, digits, glyphs or numerals are visible.",
    "The sheet is empty. No printed text or page number is visible.",
    "Page is blank. Nothing printed or written is present on the page.",
    "Page is blank. No heading, caption or label of any kind is present.",
    // A denial written in the other order — subject, verb, then the negator — which #200's review
    // measured as reported-failed, with the negator quoted inside the evidence against the page
    // (`affirmed: "text is not"`). Nothing looked at the word after the verb: the words BEFORE the
    // noun are what `negatedInList` reads. `agents/page.md` asks for a log saying the page is empty
    // and does not dictate the wording, so this order is as ordinary an answer as `no text is
    // present`, and #190 is the record of what happens when which pages survive is decided by the
    // phrasing the model happened to choose.
    "Page is blank. Text is not present anywhere on the sheet.",
    "Page is blank. Handwriting is not present.",
    "Page is blank. A heading is not visible.",
    "Page is blank. Text was never printed on this sheet.",
    "The sheet is empty. Printed text is not present.",
    "Page is blank. Text and handwriting are not present.",
    "Page is blank. No text is present. Handwriting is not present either.",
    // A negator that opens a coordination and a clause of its own after it: the walk back from
    // `handwriting` finds the conjunction and the list's negator, so the whole line reads as one
    // denied list rather than a denial followed by an affirmation. Pinned as the reading chosen, not
    // as the only defensible one — the alternative refuses it, and #200's review raised it as the
    // cost of `negatedInList` reaching across a comma. The neighbouring `No text is visible and
    // handwriting is present.` (above) is refused, because there the walk stops at the first
    // clause's own verb; the comma is the whole difference, which is why both are pinned.
    "Page is blank. No printed text, and handwriting is present.",
    // The same denial with no negator in it at all — a negative complement, which #200's review
    // measured as eight more reported-failed blank pages. `absent` and `missing` are as ordinary in a
    // page log as `not present`, and the boundary was again which word the model reached for:
    // `A page number is absent.` and `The sheet is devoid of text.` (below, and delivered before this)
    // already survived because the subject-verb scan never reached their subjects.
    "Page is blank. Printed text is absent.",
    "Page is blank. A few specks. Printed text is absent.",
    "Page is blank. Handwriting is absent.",
    "Page is blank. Printed content is absent from this side.",
    "Page is blank. Text is missing.",
    "Page is blank. Handwriting is nowhere on the sheet.",
    "Page is blank. Text is nonexistent.",
    "Page is blank. A page number is absent.",
    "Page is blank. The sheet is devoid of text.",
    // What the partial-denial reads (#204) must not swallow: the same prepositions, exceptives and
    // conjunctions inside a denial that covers the WHOLE sheet. A blank page's log reaches for these
    // constantly — it says where the text is not — so each read is bounded by what it needs to see
    // and nothing more. The substrate: `the sheet`, `the page`, `this side`, `the margins`, `the
    // scan` are not names for text, so a prepositional object that names one affirms nothing.
    "Page is blank. No text is present on the page.",
    "Page is blank. Printing is absent from the entire sheet.",
    "Page is blank. Text is nowhere in the margins.",
    "Page is blank. Text is absent from the scan.",
    "Page is blank. Text is missing throughout the page.",
    "Page is blank. No characters are discernible across the sheet.",
    "Page is blank. No text of any kind on this side.",
    // `image` stays the scan when the log refers to it definitely, here as everywhere else in this
    // file — the reading `LOCATIVE_SUBSTRATE` and `definiteBefore` exist for.
    "Page is blank. No text is present in this image.",
    "Page is blank. Content is missing from the image on this scan.",
    // An exception whose object is not a name for text is not an affirmation of text. `marks`,
    // `markings`, `dust` and `specks` are outside `TEXT_NOUN` deliberately (#193), and this is where
    // that decision pays: a blank page's log names them in exactly this shape.
    "Page is blank. No writing except stray marks.",
    "Page is blank. No printing on the page except faint specks.",
    "Page is blank. Nothing except dust and speckling.",
    "Page is blank. No content other than dust.",
    // `other` is exceptive in `nowhere other THAN a stamp` and a qualifier in `no other text`, which
    // is the wording a blank page uses. The pair is required, so this stays a denial.
    "Page is blank. No other text is present.",
    // A conjunction after a denial joins a second denial as readily as an affirmation, and the
    // complement is what tells them apart: `and the page is clean`, `and nothing else is visible`,
    // `and no marks are visible` all continue the denial. The affirming complement also has to come
    // straight after the joiner — `Handwriting is not present either.` has `present` behind its
    // negator with nothing joining it, and stays the denial it is.
    "Page is blank. Text is absent from the page and the page is clean.",
    "Page is blank. Text is absent and nothing else is visible.",
    "Page is blank. Handwriting is missing and no marks are visible.",
    "Page is blank. Printing is absent from the front and the back.",
    "Page is blank. No legible text, and nothing else on the page.",
    // The two shapes #204's review measured as blank pages newly reported failed, and the reason the
    // contrast read now asks what its complement modifies and the object walk reads `printed` as an
    // adjective. A page with scanner dust on it, and a blank pre-printed form or verso.
    "Page is blank. Text is absent, but visible dust remains.",
    "Page is blank. Printing is absent, and still visible speckling covers the sheet.",
    "Page is blank. Text is absent and visible marks remain.",
    "Page is blank. No content is present in the printed area of the form.",
    "Page is blank. Text is absent within the printed border.",
    "Page is blank. No text is present under the printed rule at the top.",
    "Page is blank. No writing is present on the printed side.",
    "Page is blank. Nothing is legible except in the printed margin.",
    "Page is blank. No handwriting is present in the printed box.",
  ]) {
    assert.equal(declaredBlank({ html: "", log }), true, log);
  }
});

// What the refusal owes whoever reads the run. `blank_vetoed` exists because #190 had to be traced
// back to a word by hand; a contradiction is harder to spot in a log than a doubt word is, and it is a
// different finding with a different remedy — a doubt word means the page could not be read and wants
// a better image, an affirmation means the agent answered with no page for a page it says has content
// on it. So it is reported in its own field, in the words that made it.
test("a contradicted blank declaration says what the log claimed was there", () => {
  const contradicted = blankDeclaration({ html: "", log: "Page is blank. There is handwriting on the page." });
  assert.equal(contradicted.asserted, true, "the log did claim the page was blank");
  assert.equal(contradicted.blank, false);
  assert.deepEqual(contradicted.vetoes, [], "nothing here casts doubt on the reading; the log contradicts itself");
  assert.equal(contradicted.affirmed, "there is handwriting");
  assert.equal(
    blankDeclaration({ html: "", log: "Page is blank. A heading is visible at the top." }).affirmed,
    "heading is visible",
  );
  assert.equal(
    blankDeclaration({ html: "", log: "Page is blank. The page contains handwriting." }).affirmed,
    "contains handwriting",
  );
  // The two findings are read independently, so a log that does both fills both fields — which the
  // run log's own documentation used to deny (`docs/API.md`, #200's review). Which to act on first is
  // a judgement the line leaves to its reader, and the doubt is the one that decides whether the
  // contradiction can be believed at all.
  assert.deepEqual(
    blankDeclaration({ html: "", log: "Page is blank. The scan is blurry. There is handwriting on the page." }),
    { asserted: true, blank: false, vetoes: ["blurry"], affirmed: "there is handwriting" },
  );
  // And a declaration nothing contradicted carries no such field at all, so the log line of an
  // ordinary blank page is unchanged and `"affirmed" in d` reads as the question it looks like.
  assert.deepEqual(blankDeclaration({ html: "", log: "Page is blank." }), {
    asserted: true,
    blank: true,
    vetoes: [],
  });
  assert.equal("affirmed" in blankDeclaration({ html: "", log: "Page is blank. Some dust is present." }), false);
  // And the field never holds a negator, which is how #200's review spotted the post-verb order: an
  // `affirmed` of `text is not` is a refusal quoting the word that refutes it.
  assert.equal(
    "affirmed" in blankDeclaration({ html: "", log: "Page is blank. Text is not present anywhere." }),
    false,
  );
});

// --- through the pipeline ------------------------------------------------------

interface Event {
  type: string;
  [k: string]: unknown;
}

interface Behaviour {
  // The raw text the page agent returns for a page's first render — not wrapped, because
  // the shape of the reply IS the subject here.
  render: (order: number) => string;
  // The fidelity problems the Feedback Agent names, empty for a pass.
  problems?: (order: number) => string[];
  // The raw text the correction pass returns.
  correct?: (order: number) => string;
}

function makeCtx(dir: string, events: Event[], b: Behaviour, pages = 3): PipelineContext {
  const agentsDir = join(dir, "agents");
  const fragDir = join(dir, "fragments");
  const inputDir = join(dir, "input");
  for (const d of [agentsDir, fragDir, inputDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
  // Present only when a test drives the correction path: without it verifyAgentOutput
  // short-circuits to ok and no correction is ever asked for.
  if (b.problems) writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\nvision\n");
  const names = Array.from({ length: pages }, (_, i) => `page-00${i + 1}.png`);
  for (const n of names) writeFileSync(join(inputDir, n), "not-a-real-png");
  const orderOf = (user: string): number => names.findIndex((n) => user.includes(n)) + 1;

  return {
    sessionId: "ses_test",
    images: names.map((name, i) => ({ name, order: i + 1, path: join(inputDir, name), links: [] })),
    extractionConcurrency: pages,
    maxReviewIterations: 1,
    paths: {
      agentsDir,
      tmpAgentsDir: () => join(dir, "tmp-agents"),
      agentMemory: (agent: string) => join(dir, `mem-${agent.replace(/\.md$/, "")}.json`),
      sessionFragments: () => fragDir,
    } as unknown as Paths,
    router: {
      complete: async (_agent: string, _cap: string, messages: { role: string; content: string }[]) => {
        const user = messages.find((m) => m.role === "user")?.content ?? "";
        const order = orderOf(user);
        if (user.includes("TASK: verify")) {
          const problems = (b.problems ?? (() => []))(order);
          return { text: JSON.stringify({ faithful: problems.length === 0, accessible: true, problems }) };
        }
        if (user.includes("had fidelity/accessibility problems")) {
          return { text: (b.correct ?? (() => ""))(order) };
        }
        return { text: b.render(order) };
      },
    },
    log: {
      event: (type: string, fields: Record<string, unknown> = {}) => events.push({ type, ...fields }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iris-envelope-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const of = (events: Event[], type: string): Event[] => events.filter((e) => e.type === type);
const good = (order: number): string => JSON.stringify({ html: `<p>page ${order}</p>`, log: "" });

test("a truncated envelope costs the page, and the run says which page", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const { fragments, failedPages } = await runExtraction(
      makeCtx(dir, events, { render: (o) => (o === 2 ? TRUNCATED : good(o)) }),
    );
    // The whole point of the issue: this used to be a delivered document of 3 of 3 pages.
    assert.deepEqual(failedPages, [2]);
    const page2 = fragments.find((f) => f.order === 2)!;
    assert.match(page2.innerHtml, /@page-failed 2:/);
    assert.doesNotMatch(page2.innerHtml, /"html"/, "the envelope did not reach the document");
    assert.doesNotMatch(page2.innerHtml, /Annual Report/, "nor did the fragment of a page inside it");
    // Both events: one says what the reply was, the other is the failure every consumer
    // already reads (diagnostics `pages_failed`, docs/API.md §7c).
    const no = of(events, "page_no_output");
    assert.equal(no.length, 1);
    assert.equal(no[0].page, 2);
    assert.equal(no[0].shape, "truncated_envelope", "which names the remedy: the output ceiling");
    assert.equal(no[0].chars, TRUNCATED.length);
    assert.deepEqual(of(events, "page_extraction_failed").map((e) => e.page), [2]);
    // And the pages that worked are untouched.
    assert.deepEqual(
      fragments.filter((f) => f.order !== 2).map((f) => f.innerHtml),
      ["<p>page 1</p>", "<p>page 3</p>"],
    );
  });
});

test("a bare-HTML answer is still a page, fenced or not", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const { fragments, failedPages } = await runExtraction(
      makeCtx(dir, events, {
        render: (o) =>
          o === 1
            ? "<h1>Annual Report</h1>"
            : o === 2
              ? "```html\n<h2>Methods</h2>\n```"
              : "Here is the page:\n\n```html\n<h2>Results</h2>\n```",
      }),
    );
    assert.deepEqual(failedPages, [], "none of these is a failure, and none was before");
    assert.deepEqual(fragments.map((f) => f.innerHtml), ["<h1>Annual Report</h1>", "<h2>Methods</h2>", "<h2>Results</h2>"]);
    assert.equal(of(events, "page_no_output").length, 0);
  });
});

test("prose around a valid envelope is not the page, and does not cost it", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const { fragments, failedPages } = await runExtraction(
      makeCtx(dir, events, {
        render: (o) =>
          o === 1
            ? `I have converted the page.\n\n{"html": "<p>page 1</p>", "log": ""}`
            : o === 2
              ? `Sure:\n\n\`\`\`json\n{"html": "<p>page 2</p>"}\n\`\`\`\n\nLet me know if you need anything else.`
              : // The real one: a complete envelope the page's own quotation marks made
                // unparseable. It is a whole page, and it now arrives as one.
                UNESCAPED_QUOTE,
      }),
    );
    assert.deepEqual(failedPages, []);
    assert.equal(fragments[0].innerHtml, "<p>page 1</p>");
    assert.equal(fragments[1].innerHtml, "<p>page 2</p>");
    assert.match(fragments[2].innerHtml, /^<blockquote><p>"\(1\) bring together/);
    // Not one word of the model's conversation is in the document.
    const body = fragments.map((f) => f.innerHtml).join("");
    assert.doesNotMatch(body, /I have converted|Let me know|"html"/);
  });
});

test("an unreadable reply that answers with nothing at all is the same lost page", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const { failedPages } = await runExtraction(
      makeCtx(dir, events, { render: (o) => (o === 2 ? "I'm sorry, I can't read this page." : good(o)) }),
    );
    assert.deepEqual(failedPages, [2]);
    assert.equal(of(events, "page_no_output")[0].shape, "prose", "which names the remedy: the prompt");
    // The apology is not the page's content, which is what a document containing it would say.
    assert.match(String(of(events, "page_extraction_failed")[0].error), /returned no HTML/);
  });
});

test("an envelope that was read and carried no page is not blamed on the parser", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The one shape that reaches the guard through `parsed` rather than through `bareHtml`:
    // `??` does not fall through on an empty string. And the reply is perfect JSON — so
    // reporting it as an `envelope` would send an operator to look at escaping, the one thing
    // that worked.
    const { failedPages } = await runExtraction(
      makeCtx(dir, events, {
        // Page 1 did not answer the question (no `html` key at all); page 2 answered with an
        // empty page and said nothing about why. Neither is a declaration that the page is
        // blank, and both are the model giving up — which is what `empty_html` names.
        render: (o) => (o === 1 ? '{"log": "no content"}' : o === 2 ? '{"html": "   "}' : good(o)),
      }),
    );
    assert.deepEqual(failedPages, [1, 2]);
    assert.deepEqual(of(events, "page_no_output").map((e) => e.shape), ["empty_html", "empty_html"]);
    assert.equal(of(events, "page_blank").length, 0, "neither reply claimed the page was blank");
  });
});

test("a page the agent reports blank is a page, not a lost one", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const { fragments, failedPages } = await runExtraction(
      makeCtx(dir, events, {
        render: (o) => (o === 2 ? '{"html": "", "log": "This page is blank."}' : good(o)),
      }),
    );
    // What this used to be: `failedPages: [2]`, a `@page-failed 2` marker where the page's
    // content would go, and the whole-document notice after `</main>` saying the delivered
    // document is incomplete — for a document that is complete (issue #179).
    assert.deepEqual(failedPages, [], "the document is whole: there was nothing on that page");
    assert.equal(of(events, "page_extraction_failed").length, 0);
    assert.equal(of(events, "page_no_output").length, 0, "nothing about this reply was unreadable");
    const blank = of(events, "page_blank");
    assert.equal(blank.length, 1);
    assert.equal(blank[0].page, 2);
    assert.equal(blank[0].log, "This page is blank.", "the agent's own words, for whoever reads the run");
    // An empty fragment rather than a marker: assembly drops it, which for a page with
    // nothing on it is what the document should say.
    assert.equal(fragments.find((f) => f.order === 2)!.innerHtml, "");
    assert.deepEqual(
      fragments.filter((f) => f.order !== 2).map((f) => f.innerHtml),
      ["<p>page 1</p>", "<p>page 3</p>"],
    );
  });
});

test("a page the agent could not read is still a lost page, not a blank one", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // Same reply shape as a blank declaration — a perfect envelope with an empty `html` — and
    // the opposite meaning. If this were delivered as an empty page, the one page that most
    // needs someone to look at it would be the one the document says nothing about.
    const { fragments, failedPages } = await runExtraction(
      makeCtx(dir, events, {
        render: (o) =>
          o === 2 ? '{"html": "", "log": "The scan of this page is too dark to resolve any text."}' : good(o),
      }),
    );
    assert.deepEqual(failedPages, [2]);
    assert.equal(of(events, "page_blank").length, 0);
    assert.equal(of(events, "page_no_output")[0].shape, "empty_html");
    assert.match(fragments.find((f) => f.order === 2)!.innerHtml, /@page-failed 2:/);
  });
});

test("a blank page that explains itself is delivered, and a refusal names the word", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // Page 2 is #190's `p1-25` page 4, verbatim: a blank leaf whose log describes the specks that
    // establish it is blank. It was reported lost. Page 3 is the reply the veto is FOR, and its
    // failure line now carries the words that refused it, so the next round of this can be read
    // out of the log instead of reconstructed from the regexes.
    const { fragments, failedPages } = await runExtraction(
      makeCtx(dir, events, {
        render: (o) =>
          o === 2
            ? '{"html": "", "log": "Page is blank. Specks/dots are visible on the page but do not resolve into any characters or content."}'
            : o === 3
              ? '{"html": "", "log": "Page is blank, but the scan is too dark to be sure."}'
              : good(o),
      }),
    );
    assert.deepEqual(failedPages, [3], "the described blank page is not a loss; the doubtful one is");
    assert.deepEqual(of(events, "page_blank").map((e) => e.page), [2]);
    assert.equal(fragments.find((f) => f.order === 2)!.innerHtml, "");
    assert.match(fragments.find((f) => f.order === 3)!.innerHtml, /@page-failed 3:/);
    const refused = of(events, "page_no_output");
    assert.equal(refused.length, 1);
    assert.equal(refused[0].shape, "empty_html");
    assert.deepEqual(refused[0].blank_vetoed, ["too dark to", "dark"]);
    assert.equal(refused[0].log, "Page is blank, but the scan is too dark to be sure.");
  });
});

test("a page whose log contradicts its own blank claim is reported, not quietly dropped", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // #194 through the pipeline, which is where the cost was: page 2's reply declares the page blank
    // and names handwriting on it, and it used to be delivered as an empty fragment — no marker in the
    // document, nothing in `failedPages`, no incompleteness notice — so the run reported a whole
    // document and the reader simply did not get that page. Page 3 is the blank page it must not cost.
    const { fragments, failedPages } = await runExtraction(
      makeCtx(dir, events, {
        render: (o) =>
          o === 2
            ? '{"html": "", "log": "Page is blank. A few specks. Not legible text. A heading is visible at the top."}'
            : o === 3
              ? '{"html": "", "log": "Page is blank. A few specks. Not legible text. The specks are scanner dust."}'
              : good(o),
      }),
    );
    assert.deepEqual(failedPages, [2], "the page the log says has a heading on it is a page to look at");
    assert.deepEqual(of(events, "page_blank").map((e) => e.page), [3], "and the described blank page is still blank");
    assert.match(fragments.find((f) => f.order === 2)!.innerHtml, /@page-failed 2:/);
    assert.equal(fragments.find((f) => f.order === 3)!.innerHtml, "");
    const refused = of(events, "page_no_output");
    assert.equal(refused.length, 1);
    assert.equal(refused[0].shape, "empty_html");
    // The words that refused it, in their own field. `blank_vetoed` is still there and still empty,
    // which is the pair a reader needs: no doubt was cast on the reading, and the log contradicted
    // itself — a page to re-extract, not a page to re-scan.
    assert.equal(refused[0].blank_contradicted, "heading is visible");
    assert.deepEqual(refused[0].blank_vetoed, []);
    assert.equal(refused[0].log, "Page is blank. A few specks. Not legible text. A heading is visible at the top.");
  });
});

test("a reply that made no blank claim says nothing about a veto", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The `empty_html` line's original meaning — an envelope that carried no page and did not say
    // why — is unchanged, and it must not grow a field implying a declaration was refused.
    await runExtraction(makeCtx(dir, events, { render: (o) => (o === 2 ? '{"html": ""}' : good(o)) }));
    const no = of(events, "page_no_output");
    assert.equal(no.length, 1);
    assert.equal("blank_vetoed" in no[0], false);
    assert.equal("log" in no[0], false);
  });
});

test("a page wrongly reported blank is still caught by the fidelity check", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The reason the blank claim is not short-circuited: it is checked against the source
    // image like any other page, so a page that DOES have content on it fails that check and
    // is corrected on the normal path, at the normal cost. Trusting the claim would buy one
    // saved call by trading a reported failure for a silent hole.
    const { fragments, failedPages } = await runExtraction(
      makeCtx(dir, events, {
        render: (o) => (o === 2 ? '{"html": "", "log": "This page is blank."}' : good(o)),
        problems: (o) => (o === 2 ? ["The page has a table on it. The output has nothing."] : []),
        // Not keyed to the page: the correction prompt does not carry the image filename, so
        // `orderOf` cannot see which page it is about. Page 2 is the only one corrected.
        correct: () => '{"html": "<table><tr><td>1</td></tr></table>"}',
      }),
    );
    assert.deepEqual(failedPages, []);
    assert.equal(of(events, "page_blank").length, 1, "the claim was made and recorded");
    assert.deepEqual(of(events, "page_verify_failed").map((e) => e.image), ["page-002.png"]);
    assert.equal(
      fragments.find((f) => f.order === 2)!.innerHtml,
      "<table><tr><td>1</td></tr></table>",
      "the content the page actually had is in the document",
    );
    assert.equal(of(events, "page_corrected")[0].result, "kept");
  });
});

test("an unreadable correction keeps the page it could not correct", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // Page 1 fails its fidelity check and the correction comes back as a truncated envelope.
    // Delivering that would replace a page that passed everything except one fidelity problem
    // with a JSON fragment — strictly worse than the page it was asked to improve.
    const { fragments, failedPages } = await runExtraction(
      makeCtx(dir, events, {
        render: (o) => good(o),
        problems: (o) => (o === 1 ? ["the second column of the table was dropped"] : []),
        correct: () => TRUNCATED,
      }),
    );
    assert.deepEqual(failedPages, [], "a correction is not a page: failing one loses nothing");
    assert.equal(fragments[0].innerHtml, "<p>page 1</p>", "the pre-correction page is what is delivered");
    const no = of(events, "page_correction_no_output");
    assert.equal(no.length, 1);
    assert.equal(no[0].page, 1);
    assert.equal(no[0].shape, "truncated_envelope");
    // A correction whose envelope parsed and held no HTML is the same outcome — the page is
    // kept — under the shape that names the right remedy.
    const blank: Event[] = [];
    await runExtraction(
      makeCtx(dir, blank, {
        render: (o) => good(o),
        problems: (o) => (o === 1 ? ["the heading level is wrong"] : []),
        correct: () => '{"html": ""}',
      }),
    );
    assert.equal(of(blank, "page_correction_no_output")[0].shape, "empty_html");
    // The existing record of a correction that bought nothing still fires, so the rate in
    // docs/API.md §0c does not move because of this event.
    assert.equal(of(events, "page_corrected")[0].result, "empty");
  });
});

test("a correction that answered in bare HTML is still a correction", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const { fragments } = await runExtraction(
      makeCtx(dir, events, {
        render: (o) => good(o),
        problems: (o) => (o === 1 ? ["the heading level is wrong"] : []),
        correct: () => "```html\n<h2>page 1</h2>\n```",
      }),
    );
    assert.equal(fragments[0].innerHtml, "<h2>page 1</h2>");
    assert.equal(of(events, "page_correction_no_output").length, 0);
    assert.equal(of(events, "page_corrected")[0].result, "kept");
  });
});
