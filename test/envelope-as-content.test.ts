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

test("a reply that is only its object is read as that object, not as something quoted inside it", () => {
  // The colon rule and its limit (issue #339). `repairedSpan` ends a string at a `"` followed by
  // `,` `}` `]` or `:`, and the `:` case is what breaks a reply whose prose quotes a field name
  // back — the value-string ends at the quote before the colon, the sentence after it is read as
  // object syntax, and the envelope does not parse. What DOES parse is the fragment the model was
  // quoting, because the search resumes inside a candidate it could not read. So the last readable
  // object in this reply was the decoy, and the decoy carries `faithful`.
  const decoyed =
    `{ "faithful": false, "accessible": false,\n` +
    `  "problems": [{ "kind": "content_missing", "problem": "the third data row is absent" }],\n` +
    `  "notes": "I first read the contract as { "faithful": true, "problems": [] }; it is not." }`;
  const read = extractJson<{ faithful?: boolean; problems?: { problem?: string }[] }>(decoyed);
  assert.equal(read?.faithful, false, "the decoy quoted in `notes` was read as the answer");
  assert.deepEqual(
    read?.problems?.map((p) => p.problem),
    ["the third data row is absent"],
  );

  // The same defect with the prose in a `problem` rather than in `notes`, so the quoted object names
  // exactly the fields the envelope does. Worth its own case because it is what a key-count gate
  // cannot see — the two readings tie — and it is the shape a verifier writes when it reasons
  // inside a problem, which is the behaviour #339 measured.
  const tied =
    `{ "faithful": false, "accessible": false,\n` +
    `  "problems": [{ "kind": "content_missing", "problem": "row 3 is absent — I first read the contract as ` +
    `{ "faithful": true, "accessible": true, "problems": [] } and it is not that" }] }`;
  assert.equal(extractJson<{ faithful?: boolean }>(tied)?.faithful, false);

  // Read that way only because the reply is nothing BUT the object, first character to last, which
  // is what every one of these prompts asks for. The narrow colon rule is confined to that shape
  // for a measured reason: applied to each candidate in the walk it changes 14 of the 4,100 agent
  // replies in the bench logs and loses on all 14. This is the shape of those — a Reader verdict
  // that quotes the page agent's envelope in its prose BEFORE answering — and under the narrow rule
  // the quoted `"html":"…` value never closes, so the prose candidate swallows the real verdict and
  // the walk returns one issue instead of two. It must keep returning both.
  const readerReply =
    `Looking at the excerpt, the extractor's own commentary was transcribed: the raw JSON blob\n` +
    "`{\"html\":\"...`, `\"log\": \"...\"`, `\"suggested_agent\": null}` is announced to the reader.\n\n" +
    "```json\n" +
    `{\n  "issues": [\n` +
    `    { "issue": "Extractor metadata is in the document text", "pages": [22, 23] },\n` +
    `    { "issue": "The table's totals row is inside <thead>", "pages": [24] }\n` +
    `  ]\n}\n` +
    "```\n";
  const issues = extractJson<{ issues?: { pages?: number[] }[] }>(readerReply)?.issues;
  assert.equal(issues?.length, 2, "the prose's quoted envelope swallowed part of the verdict");
  assert.deepEqual(
    issues?.map((i) => i.pages),
    [[22, 23], [24]],
  );

  // The narrow reading is preferred only where TWO gates allow it, and the shape both exist for is
  // an abandoned draft: the model gave up on an object mid-string and restarted inline. Its
  // unterminated string is the narrow rule's own failure case — the position tracker reads a value
  // where JSON meant a key — so the rule returns one object whose `html` is the abandoned prose with
  // `{"html": "` glued to the front, and that string is delivered to a reader as the page, which is
  // the whole subject of this file. The walk reads the restart, which is the answer.
  //
  // Each row below defeats a different version of this gate, and the first two are versions that
  // shipped. A KEY-SET gate (the narrow reading preferred where it carries every field the walk
  // found plus one more) sees only row 1: the abandoned string being the FIRST field is what makes
  // the two sets equal, and moving one complete field ahead of it makes the narrow reading a strict
  // superset, so it wins and the envelope reaches the page. A BRACE gate (every `{` inside a string
  // closes inside it) sees rows 1 and 2 and not row 3, because a single `}` in the restarted content
  // — a code listing, template syntax, a math brace, none of them exotic on a page — rebalances the
  // abandoned string. What holds for all three is that a restart is the TAIL of the reply: the walk's
  // answer closes on the reply's last character, and where it does, the narrow rule is not tried.
  for (const [where, restarted, page] of [
    [
      "first field",
      `{"html": "<p>Table 3 continues\n` +
        `{"html": "<table><tr><th>Year</th></tr></table>", "log": "ok", "suggested_agent": null}`,
      "<table><tr><th>Year</th></tr></table>",
    ],
    [
      "after a complete field",
      `{"log": "ok", "html": "<p>Table 3 continues\n` +
        `{"html": "<table><tr><th>Year</th></tr></table>", "suggested_agent": null}`,
      "<table><tr><th>Year</th></tr></table>",
    ],
    [
      "a brace in the restarted page content",
      `{"html": "<p>Table 3 continues\n` +
        `{"html": "<table><tr><th>Year} onwards</th></tr></table>", "log": "ok", "suggested_agent": null}`,
      "<table><tr><th>Year} onwards</th></tr></table>",
    ],
  ] as [string, string, string][]) {
    assert.equal(
      extractJson<{ html?: string }>(restarted)?.html,
      page,
      `${where}: the abandoned draft's prose was read as the page`,
    );
  }

  // The change is slightly wider than #339, and this is the half of it a verify fixture cannot show.
  // A PAGE whose content prints the contract — a document about this system, or any page quoting JSON —
  // used to lose the page to the fragment it printed: the walk's candidate failed at the quote before
  // the colon, resumed inside it, and returned `{faithful: true}` as the envelope. Now the envelope is
  // read. Pinned because the page path is the one with no floor under it (see the header: there is no
  // before-page to compare a first render against), so this rescue would regress silently.
  const pageQuotingTheContract = extractJson<{ html?: string; log?: string }>(
    '{"html": "<p>{ "faithful": true }</p>", "log": "ok", "suggested_agent": null}',
  );
  assert.equal(pageQuotingTheContract?.html, '<p>{ "faithful": true }</p>');
  assert.equal(pageQuotingTheContract?.log, "ok");

  // A page that legitimately prints a lone `{` fails the brace test too, and that costs nothing:
  // discarding the narrow reading answers with the walk's result, which is what this returned
  // before any of it. The direction is the safety property — head and base can differ only where
  // the narrow reading is PREFERRED, so a stricter gate can only ever return behaviour to base.
  assert.equal(
    extractJson<{ html?: string }>('{"html": "<p>A block opens with { and the "kind" attribute is set</p>", "log": "ok"}')?.html,
    '<p>A block opens with { and the "kind" attribute is set</p>',
  );

  // And the limits, stated so none of this is mistaken for coverage. Wrap the same verdict in a
  // fence or a sentence and the decoy is the last readable object again: the reply no longer opens
  // with `{`, so the whole-reply attempt does not apply, and one pass cannot tell that reply from a
  // page printing `She said "hello", he replied`.
  assert.equal(extractJson<{ faithful?: boolean }>("```json\n" + decoyed + "\n```")?.faithful, true);
  assert.equal(extractJson<{ faithful?: boolean }>("Here is my verdict.\n\n" + decoyed)?.faithful, true);
  // The third limit is the one the new `notes` field most invites, and it is a CLASS rather than a
  // shape: **any string value inside the quoted decoy** defeats the whole-reply repair. The `"` that
  // opens it is preceded by `:` and the `"` that closes it is followed by `,` `}` or `]`, which every
  // reading here treats as a terminator — so the real `notes` value ends inside the quoted sentence,
  // the span stops before the end of the reply, and there is no whole-reply object left to prefer.
  // The decoy wins, and it carries both flags as booleans, so `verifyAgentOutput`'s gate passes it
  // too: a page rejected for a missing data row ships under `page_verify_ok`, where `pages_unjudged`
  // cannot see it. What the change fixes is only the decoy with NO string values in it — the shape
  // #339 actually produced, and the one the two `verify-notes-field` fixtures use.
  //
  // An earlier revision of this comment called it "a decoy quoting an EMPTY string" and pinned only
  // that. The mechanism was right and the width was wrong in the more expensive direction: whoever
  // next tries to close this would have made the empty pin pass and believed the class was closed.
  // The empty string is the MINIMAL instance, so both are pinned. Both are `main`'s behaviour,
  // unchanged by this branch; what removes them is the prompt clause asking for no quoted JSON in
  // `notes` at all. If a later change closes the class, these are the assertions to invert.
  const real =
    `{ "faithful": false, "accessible": false,\n` +
    `  "problems": [{ "kind": "content_missing", "problem": "the third data row is absent" }],\n`;
  const emptyStringDecoy =
    real + `  "notes": "I read it as { "faithful": true, "accessible": true, "problems": [], "notes": "" }; it is not." }`;
  assert.equal(extractJson<{ faithful?: boolean }>(emptyStringDecoy)?.faithful, true);
  // Not empty, and not the last field of the quoted object either — the terminator needs neither.
  const nonEmptyStringDecoy =
    real + `  "notes": "First read: { "faithful": true, "accessible": true, "problems": [], "notes": "the table is fine" }. On review it is not." }`;
  const won = extractJson<{ faithful?: boolean; notes?: string }>(nonEmptyStringDecoy);
  assert.equal(won?.faithful, true);
  assert.equal(won?.notes, "the table is fine");
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

test("the declaration is read off what a reader receives, not off how long the fragment is", () => {
  // The empty `html` the prompt asks for is not the only way the model writes a blank page. Across
  // 818 initial renders in the bench logs, 78 replies handed a reader nothing and 33 of them spelled
  // it in markup — 18 a bare page-break marker, 13 a comment, 2 an empty paragraph (issue #219).
  // Read as content, each of those was a page that produced markup: `pages_blank` did not count it,
  // and the document carried the comment, or the empty `<p>`, or an anchor claiming the document's
  // page 14 begins here when the paper prints no folio. Each fixture below is one of those replies.
  assert.equal(
    declaredBlank({
      html: '<hr role="doc-pagebreak" aria-label="Page 14" id="page-14">',
      log: "Page 14 appears to be blank. No text, images, or other content is visible.",
    }),
    true,
    "a marker says where a page began, not what was on it",
  );
  assert.equal(
    declaredBlank({
      html: "<!-- blank page -->",
      log: "Page 2 appears to be entirely blank (white). No text, images, or other content is visible.",
    }),
    true,
  );
  assert.equal(
    declaredBlank({ html: "<!-- Page 16: blank page -->", log: "Page 16 appears to be entirely blank." }),
    true,
  );
  assert.equal(declaredBlank({ html: "<p> </p>", log: "Page 4 appears to be blank." }), true);
  assert.equal(
    declaredBlank({ html: '<p aria-label="Blank page"></p>', log: "Page 2 of 25 is entirely blank." }),
    true,
  );
  // Wrappers hold nothing either, however deep they go.
  assert.equal(declaredBlank({ html: "<section><div></div></section>", log: "The page is blank." }), true);
  // And a comment that talks about markup is prose about markup, not markup — the same reading
  // `visibleText` and `attrText` take (correction.ts).
  assert.equal(declaredBlank({ html: "<!-- the <img> is overleaf -->", log: "The page is blank." }), true);

  // What is still a page. PROSE first, and deliberately: one further render in that corpus answers
  // `<p><em>This page is blank.</em></p>`, and a page that PRINTS "This page intentionally left
  // blank" is a page whose correct transcription is that sentence. Nothing here can tell the two
  // apart, so the words are delivered as the page said them.
  assert.equal(declaredBlank({ html: "<p><em>This page is blank.</em></p>", log: "The page is blank." }), false);
  // Then the elements that are content with no text in them: the picture, the grid, the control. A
  // reader receives something from every one of them, and `visibleText` returns nothing for all three.
  assert.equal(declaredBlank({ html: '<img src="p4.png" alt="">', log: "The page is blank." }), false);
  assert.equal(declaredBlank({ html: "<table><tr><td></td></tr></table>", log: "The page is blank." }), false);
  assert.equal(declaredBlank({ html: '<input type="checkbox">', log: "The page is blank." }), false);
  // And the same three when an ATTRIBUTE is what says so (issue #224, raised by the review of #221).
  // A picture written on a `<div>` is a picture, announced as one and described to a reader, and the
  // element-name list read it as an empty wrapper: a page with a photograph on it, answered with a
  // blank-ish log, dropped in silence. Unreachable while `agents/page.md` asks for `<img>` and
  // `<figure>` and nothing else, which is exactly why it is pinned — the prompt change that makes it
  // reachable will not be made by anyone thinking about this file.
  assert.equal(
    declaredBlank({ html: '<div role="img" aria-label="A photo of the mayor"></div>', log: "The page is blank." }),
    false,
  );
  assert.equal(declaredBlank({ html: '<span role="math"></span>', log: "The page is blank." }), false);
  assert.equal(declaredBlank({ html: '<span role="button" tabindex="0"></span>', log: "The page is blank." }), false);
  // The role set is not a mirror of the element list, and these are where it would read as one (#229's
  // review). `figure`, `meter` and `progressbar` are absent because `<figure>`, `<meter>` and
  // `<progress>` are: a wrapper and a gauge with nothing in them hand a reader nothing, and a role
  // cannot make an empty box into a picture. Pinned in pairs so the two lists are read together.
  assert.equal(declaredBlank({ html: "<figure></figure>", log: "The page is blank." }), true);
  assert.equal(declaredBlank({ html: '<div role="figure"></div>', log: "The page is blank." }), true);
  assert.equal(declaredBlank({ html: "<meter></meter>", log: "The page is blank." }), true);
  assert.equal(declaredBlank({ html: '<div role="meter"></div>', log: "The page is blank." }), true);
  assert.equal(declaredBlank({ html: '<div role="progressbar"></div>', log: "The page is blank." }), true);
  // A `role` inside another attribute's VALUE is prose about markup, the same as one inside a comment:
  // the attribute scan consumes a quoted value whole rather than searching the tag for `role=`.
  assert.equal(declaredBlank({ html: '<span title="see role=button"></span>', log: "The page is blank." }), true);
  assert.equal(declaredBlank({ html: '<div role="img" title="role=none"></div>', log: "The page is blank." }), false);
  // A role list is read through rather than at its first token: ARIA takes the first valid one, and
  // being generous here costs a glance where being exact costs the page.
  assert.equal(declaredBlank({ html: '<div role="img presentation"></div>', log: "The page is blank." }), false);
  // A link is the one interactive thing whose element name is not in that list, so its accessible name
  // is what makes it something a reader receives — and the name has to be on the link.
  assert.equal(declaredBlank({ html: '<a href="#x" aria-label="Next"></a>', log: "The page is blank." }), false);
  assert.equal(declaredBlank({ html: "<a href='/p/2' aria-labelledby='lbl'></a>", log: "The page is blank." }), false);
  assert.equal(declaredBlank({ html: '<a href="#x" aria-label=" "></a>', log: "The page is blank." }), true);
  assert.equal(declaredBlank({ html: '<a href="#x"></a>', log: "The page is blank." }), true);
  assert.equal(declaredBlank({ html: '<a aria-label="Next"></a>', log: "The page is blank." }), true);
  // ...and `role="link"` is read as a link rather than as one of the roles above, so the two spellings
  // of the same control agree: named is content, bare is an empty box. `<a role="link" aria-label>` with
  // no `href` is the third spelling and read as the same claim — #229's review found it reading as
  // nothing because the element name decided which rule applied, and that is the arm that loses a page.
  // `<area href>` is here for the other half of the same gap: it is the one interactive element besides
  // `<a>` that `CONTENT_WITHOUT_TEXT` does not name.
  assert.equal(declaredBlank({ html: '<span role="link" aria-label="Next"></span>', log: "The page is blank." }), false);
  assert.equal(declaredBlank({ html: '<a role="link" aria-label="Next"></a>', log: "The page is blank." }), false);
  assert.equal(declaredBlank({ html: '<area href="#x" aria-label="Next">', log: "The page is blank." }), false);
  assert.equal(declaredBlank({ html: '<div role="link"></div>', log: "The page is blank." }), true);
  assert.equal(declaredBlank({ html: '<a role="link"></a>', log: "The page is blank." }), true);
  assert.equal(declaredBlank({ html: '<area href="#x">', log: "The page is blank." }), true);
  // A space is no name however it was spelled. `decodeEntities` names the five XML entities and nothing
  // else on purpose, so `&#160;` decoded to a non-breaking space and vanished under `trim` while
  // `&nbsp;` survived as six literal characters and read as a name (#229's review) — one non-breaking
  // space, two spellings, and the decoded arm was the page-dropping one. Undone where the question is
  // what a reader would hear, not in the decoder.
  assert.equal(declaredBlank({ html: '<a href="#x" aria-label="&#160;"></a>', log: "The page is blank." }), true);
  assert.equal(declaredBlank({ html: '<a href="#x" aria-label="&nbsp;"></a>', log: "The page is blank." }), true);
  assert.equal(declaredBlank({ html: '<a href="#x" aria-label="&#x200B;"></a>', log: "The page is blank." }), true);
  assert.equal(declaredBlank({ html: '<a href="#x" aria-label="&nbsp;Next"></a>', log: "The page is blank." }), false);
  // Double-encoded, which is the only spelling the numeric branches of that pattern can see: `&#160;`
  // is decoded before they run, and `&amp;#160;` decodes to it.
  assert.equal(declaredBlank({ html: '<a href="#x" aria-label="&amp;#160;"></a>', log: "The page is blank." }), true);
  // Either attribute having a value is the test, rather than one falling back to the other:
  // `aria-labelledby` outranks `aria-label` in the accessible-name computation, so reaching for the
  // label first read a link whose name comes from the reference as nameless (#229's review). Asking
  // whether either is non-empty makes the precedence moot, which is all this question can claim.
  assert.equal(
    declaredBlank({ html: '<a href="#x" aria-label="" aria-labelledby="lbl"></a>', log: "The page is blank." }),
    false,
  );
  assert.equal(
    declaredBlank({ html: '<a href="#x" aria-labelledby="" aria-label="Next"></a>', log: "The page is blank." }),
    false,
  );
  assert.equal(
    declaredBlank({ html: '<a href="#x" aria-label="" aria-labelledby=""></a>', log: "The page is blank." }),
    true,
  );
  // An `aria-labelledby` whose target is not in the fragment computes to no accessible name and counts
  // anyway (#229's review). Deliberate: both callers use this to decide blank-versus-REPORTED and
  // neither delivers the fragment, so a dangling reference costs a glance where refusing it would drop
  // a link the model meant to put on the page. Whitespace is still no name — that is an author writing
  // none rather than pointing at one that has gone missing.
  assert.equal(declaredBlank({ html: '<a href="#x" aria-labelledby="nope"></a>', log: "The page is blank." }), false);
  // A name on anything else labels a wrapper that holds nothing, which is the `<p aria-label="Blank
  // page">` above — one of the corpus's own 33 — and reading it as content would deliver every one of
  // them as a failed page. The roles that say the element is not content are out for the same reason a
  // page-break `<hr>` is, and `data-role` is not a role.
  assert.equal(declaredBlank({ html: '<div aria-label="Main content"></div>', log: "The page is blank." }), true);
  // The role the prompt actually mandates, and the assertion with something to lose (#229's review):
  // `agents/page.md` requires `<hr role="doc-pagebreak" aria-label="Page 5" id="page-5">`, and a bare
  // page-break marker is 18 of the corpus's 33 markup-spelled blanks — the largest bucket #219 counted.
  // It reads as nothing because `doc-pagebreak` is not a content role and a marker's `aria-label` is
  // not a link's, not because a blank-page fragment carries no `role`. Both are pinned, since the one
  // above is the shape the reader receives and this is the one the prompt writes.
  assert.equal(
    declaredBlank({
      html: '<hr role="doc-pagebreak" aria-label="Page 5" id="page-5">',
      log: "Page 5 appears to be blank. No text, images, or other content is visible.",
    }),
    true,
  );
  assert.equal(declaredBlank({ html: '<hr role="doc-pagebreak">', log: "The page is blank." }), true);
  assert.equal(declaredBlank({ html: '<hr role="separator">', log: "The page is blank." }), true);
  assert.equal(declaredBlank({ html: '<div role="presentation"></div>', log: "The page is blank." }), true);
  assert.equal(declaredBlank({ html: '<div role="none"></div>', log: "The page is blank." }), true);
  assert.equal(declaredBlank({ html: '<div data-role="img"></div>', log: "The page is blank." }), true);
  // A comment that talks about a role is prose about markup, on the same reading as the `<img>` above.
  assert.equal(
    declaredBlank({ html: '<!-- the <div role="img"> is overleaf -->', log: "The page is blank." }),
    true,
  );

  // The veto still has the last word, whichever way the fragment was written: how the model spelled
  // its empty page does not decide the routing (#220 is the wordings that refuse a real blank page).
  assert.equal(
    declaredBlank({ html: "<!-- blank page -->", log: "The scan is too dark to resolve any text." }),
    false,
  );
  const refused = blankDeclaration({
    html: "<!-- blank page -->",
    log: "Page 2 is blank, but the scan is too dark to be sure.",
  });
  assert.equal(refused.blank, false);
  assert.deepEqual(
    [refused.asserted, refused.vetoes],
    [true, ["too dark to", "dark"]],
    "asserted and refused, which is what puts the words on the failure line rather than on nothing",
  );
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
    // #220's seven, verbatim from the bench corpus — the same #190 case in wordings the exemption did
    // not reach, and every one of them a page reported as a hole in a document that has none. They
    // were latent until #219: each spells its empty page in markup, so none of them reached this
    // predicate at all.
    //
    // `scanning noise` names the class the specks belong to rather than the state of the capture.
    "Page 8 of 25 appears to be blank or nearly blank. Only a few scattered specks/artifacts are visible, consistent with scanning noise. No legible text, images, tables, or other content could be identified.",
    // …and so does `compression noise`, which names the process instead of the capture. Verbatim from
    // `runs-231` (2026-08-27), where it is one of the two pages the guard is on record for LOSING:
    // `blank_vetoed: ["noise"]`, `page_no_output`, `page_extraction_failed` (#429). #220 licensed the
    // three words for the scan and the head word was what decided the page — the same reply with
    // `scanning noise` in it was delivered.
    "Page is blank apart from minor scanning artifacts (specks and compression noise). No printed text, images, or other content is present.",
    "Page is blank apart from compression noise, no text.",
    "Page is blank. Only specks/compression noise is visible, no text.",
    // A stack of modifiers written as a list, with `isolated` letting bare `marks` be the marks.
    "Page 14 of 25 appears to be blank or nearly blank. Only faint, isolated marks are visible (a small dot near the upper-left area and a few very faint specks elsewhere) that do not resolve into any characters, words, diagrams, or other content. No text, images, tables, or other elements were transcribed.",
    // `do not resolve into` with more nouns conjoined onto the object than the tail read would follow:
    // the comma is the list continuing, not the denial ending.
    "Page 14 appears to be blank or nearly blank. No legible text or meaningful content is visible. A few faint specks or artifacts are present but do not resolve into any characters, images, or structure. No page number is printed on the page itself, so the page-break marker uses the sequential page number 14 from the file position.",
    "Page 14 appears to be blank. A few very faint specks or marks are visible but do not resolve into any legible text, images, or other content. No page number is printed on the page. The page-break marker has been emitted without a page number since none is visible; if a number is confirmed from document metadata it should be added. No content to transcribe.",
    // The same wording with the qualifier spelled the British way, which is a per-call choice.
    "Page 14 appears to be blank. No readable text or meaningful content is visible. A few faint specks or marks are present but do not resolve into characters or recognisable content. No page number is printed on the page; the page-break marker uses the sequential position (14) from the file metadata.",
    // The comma'd stack without the `Only` in front of it, and one written the other way round. The
    // guard that keeps a comma from reaching across a clause boundary is about what PRECEDES the
    // stack, so a stack that opens its own sentence or sits behind a count is still one phrase.
    "Page is blank. Faint, isolated marks are visible, no text.",
    "Page is blank. A few faint, scattered specks are visible, no text.",
    // A full stop and a semicolon reset the guard's reach, because a stack at the head of a new clause
    // has nothing to its left to describe. Pinned beside the dash form below, which is the same claim
    // refused: which verdict a log gets turns on the delimiter the model typed, and that asymmetry is on
    // record here rather than left to be read off a character class.
    "This page is blank; only faint, isolated marks are visible.",
    // A line break resets it on the other ground — layout — and outranks the evidence: a colon at the
    // end of a line is introducing a list ("Notes:", "Scan quality:") and the lines under it are its
    // items, so it does not reach them. The same colon INLINE refuses, and is pinned below. Filed here
    // under the line break rather than the clause, because a colon does not end a clause.
    "Page is blank:\nonly faint, isolated marks are visible, no text.",
    // A doubt word LEADING a stack that opens its own sentence is stripped, and this is the position
    // #220's nine all need. In it the two readings cannot be told apart — `blurry specks` is
    // grammatically the marks, which is what the exemption is for, and nothing in the sentence says the
    // model meant the capture — so these are accepted knowingly, not overlooked.
    "Page 12 appears blank. Dark, blurry, faint specks throughout, no legible text.",
    "Page 12 appears blank. Grainy, faint specks throughout, no legible text.",
    "Page 3 is blank. No text or images. Faint, grey speckling from the scan, nothing legible.",
    // `not legible` predicated on the marks by a relative clause, with and without the `as`.
    "Page 16 appears to be blank. No text, images, or other content is visible. Only a few scattered specks/artifacts are present, which are not legible as content.",
    "Page 16 appears to be blank. No text or meaningful content is visible. No page number is printed on the page; the page-break marker uses the sequence number 16 from the file metadata. Only a few scattered specks/artifacts are present, which are not legible marks.",
    // `smudges` is a mark left on the paper and stays exempt, which is the line the three nouns #226
    // added are measured against: this is delivered, and `an ink smear in the lower corner` is not.
    "Page is blank. A few faint smudges on the paper, no text.",
    // One word from OUTSIDE `MARK_MODIFIER` may stand between the stack and its noun, which is what
    // `faint specks` being delivered and `faint, indistinct specks` being refused was: a hand-written
    // list of adjectives, and the model reaching for one that is not on it (#429). The slot is one word
    // wide and sits immediately in front of the marks noun, so it widens which phrases are the marks and
    // never how far the run reaches for a doubt word — `The page is dark, with faint specks` above still
    // keeps its `dark`, because `with` is not where the slot is.
    "Page is blank. Only faint, indistinct specks are visible.",
    "Page is blank. Only faint indistinct specks are visible.",
    "Page is blank. Only a few faint, irregular dots are visible, no text.",
    // A joined tail, and the reason the slot asks base what IT stripped rather than asking a list what
    // base might have stripped: the slot reads `noise` here as an adjective of `speckles`, where base
    // reads it as the second word of the `scanner noise` marks noun. A revision that answered from a list
    // of words the stack carries handed `noise` back into the scope and lost this page, which is a real
    // reply — `runs-bystep-now`, honoured before #429 went near it.
    "Page is blank. No printed content or page number visible; only minor scanner noise/speckles present.",
    // The unlisted word may be plain dressing spelled with a hyphen behind a listed one, which base
    // honours unhyphenated (`Only dark specks are visible`) and refused here for the hyphen alone.
    "Page is blank. Only dark-shaded specks are visible.",
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
    // The doors #220's fix opens, each shut on the constraint the issue names. `noise` is the marks
    // only where a word in front of it says what made them: the scan being noisy is the scan.
    "Page is blank. The scan is noisy.",
    "Page appears blank. There is noise in the scan.",
    // `compression noise` is licensed above and `image noise` is not, and the reason is the same one:
    // `image` names the thing whose quality is in question, so this is the claim about the capture that
    // #220's three controls are. A licence attaches to a head word, so which words are on it is the whole
    // of the rule — and this is the boundary of the four the corpus contains (#429).
    "Page is blank. There is image noise.",
    // A comma may join two modifiers of a marks noun, and a description of the capture is not one:
    // the phrase starts after `with`, so both doubt words stay.
    "Page is blank. The scan is dark, blurry, with a few specks and no text.",
    // The other way a comma is not a list separator: it ends the clause the doubt word belongs to.
    // A comma'd stack of modifiers may not open a clause, so a copula or a colon in front of the
    // first one leaves it where the veto lists can see it — a grainy capture can cover content, and
    // accepted here it would ship as an empty page with no marker on it.
    "Page 12 appears to be blank; the scan is grainy, faint specks are all that appear.",
    "Page 12 appears blank. Scan quality: dark, blurry, faint specks throughout, no legible text.",
    "Page is blank. The image is dark, faint specks are visible. No legible text.",
    "Page is blank. The scan is noisy, scattered marks are visible, no text.",
    "Page 12 appears blank. The image is washed-out, faint specks are visible, no text.",
    // The same clause with something between the copula and the stack, or with a delimiter other than
    // a colon. What refuses these is not a list of the words that can sit there — that list has no end,
    // and three separate wordings walked through three versions of it — but the copula, colon or dash
    // being anywhere to the left of the stack inside the sentence.
    "Page 12 appears blank. The scan is very grainy, faint specks are all that appear.",
    "Page 12 appears blank. The scan seems quite dark, faint specks are all that appear.",
    "Page 12 appears blank. The scan is noticeably grainy, faint specks are all that appear.",
    "Page 12 appears blank. The scan is a little dark, faint specks are all that appear.",
    "Page 12 appears blank. The image is heavily grainy, faint specks are visible, no text.",
    // A quantifier between the copula and the stack is the same road: `only` is what the phrase's own
    // prefix is made of, so naming it there would have been a fourth patch on one wording.
    "Page 12 appears blank. The scan is only dark, blurry, faint specks throughout, no legible text.",
    // Every delimiter that says a description of something already named follows. A spaced hyphen is
    // the dash typed without one; unspaced it is inside `washed-out` and inside the phrase's own
    // separator, so that one is not a delimiter.
    "Page 12 appears blank. Scan quality — dark, blurry, faint specks throughout, no legible text.",
    "Page 12 appears blank. Scan quality - dark, blurry, faint specks throughout, no legible text.",
    "Page 12 appears blank. Scan quality: somewhat dark, blurry, faint specks throughout, no text.",
    // What this costs: a comma'd stack in a sentence that opened by saying the page is empty. The `is`
    // is to the left of the stack in the same sentence, so `faint` refuses — a glance, not a page, and
    // no corpus wording puts the marks anywhere but at the start of their own sentence.
    "Page is blank — only faint, isolated marks are visible, no text.",
    // The same colon as the accepted line-break form above, inline: here it has the clause it governs on
    // its own line, which is the case the evidence reading is for.
    "Page is blank: only faint, isolated marks are visible, no text.",
    // Bare `marks` is the marks behind `stray`, `scattered`, `isolated`, `random` or `residual` — the
    // words that say the marks are nowhere in particular — and behind nothing else. `agents/page.md`
    // uses the bare noun for a page that HAS content nobody could read, which is what these are.
    "Page is blank. Only faint marks are visible, no text.",
    "Page is blank. Handwritten marks are visible; they are not legible as content.",
    // …and the adjective slot does not change that: it decides what may DRESS a marks noun, and bare
    // `marks` is not one. This is #429's own fifth reply, which is why that one is not rescued by the
    // slot written for its wording — the fault it names is real and the noun under it is #193's.
    "Page is blank. Only faint, indistinct marks are visible, no text.",
    // The slot hands its word BACK into the scope instead of removing it, so a doubt word in it goes on
    // vetoing without the slot knowing which list carries it. That is the fix for both notes the first
    // review of #430 raised: the earlier version asked `DEGRADED_IMAGE_LOG` by name when the vetoes are
    // that list UNION `UNREADABLE_LOG`, so `partial` here became a declaration; and it asked `TEXT_NOUN`,
    // a list of SUBJECTS, in the one position where a log writes the participle, so `handwritten` walked
    // through the check meant for `handwriting`.
    "Page is blank. Only faint, streaked specks are visible, no text.",
    "Page is blank. Only faint, illegible specks are visible, no text.",
    "Page is blank. Only a few faint, partial specks are visible.",
    "Page is blank. Only faint, truncated specks are visible.",
    // A name for text is refused whichever part of speech names it, because only the participle can stand
    // here and only the noun is a subject `contentAffirmed` can read: these fall back to the phrase
    // WITHOUT the slot, which is what this file did before the slot existed. `text-like` is one token to
    // the slot, so its test is a boundary test and not `^text$`.
    "Page is blank. Only faint, text-like specks are visible, no text.",
    "Page is blank. Only faint, handwriting specks are visible, no text.",
    "Page is blank. Only faint, handwritten smudges are visible, no text.",
    "Page is blank. Only faint, stamped dots are visible, no text.",
    "Page is blank. Only faint, typed dots are visible.",
    "Page is blank. Only faint, signed smudges are visible.",
    "Page is blank. Only faint, watermark dots are visible.",
    // The second review of #430 read `NAMES_TEXT_FORM` as the only thing between an attributive naming
    // writing and a silent blank, and named five words it did not carry. It is not that — base declares
    // "Only <w> smudges are visible" blank for every one of these whether the word is listed or not, and
    // its contradiction check fires on 0 of 32 attributive wordings against 14 of 14 subject ones. What
    // the list does is keep this slot from making base worse, so the class is covered anyway: it costs
    // base's verdict and nothing else. The first five are the review's; the rest are words the corpus
    // writes in a page log (`footnote` 2,215 times, `italic` 403) and never in one asserting blankness.
    "Page is blank. Only faint, cursive smudges are visible.",
    "Page is blank. Only faint, pencilled smudges are visible, no text.",
    "Page is blank. Only faint, handprinted dots are visible.",
    "Page is blank. Only faint, barcode dots are visible.",
    "Page is blank. Only faint, drawing specks are visible.",
    "Page is blank. Only faint, footnote specks are visible.",
    "Page is blank. Only faint, italic smudges are visible, no text.",
    "Page is blank. Only faint, symbol dots are visible.",
    "Page is blank. Only faint, lettering specks are visible.",
    "Page is blank. Only faint, alphanumeric dots are visible.",
    // ...and the list is boundary-tested rather than anchored, because anchored it could not see a
    // hyphenated compound of a word it already carries — `stamped`, `written`, `lettered`, `annotated`
    // were all in it while these four walked through, found by the third review of #430. That gap is not
    // a missing word and the "add the word when a round writes one" policy cannot close it: `hand-`,
    // `pen-` and `rubber-` are how a log names the instrument, so the compounds are unbounded. The
    // suffixed form is the opposite case and IS a missing word, since one stem has finitely many:
    // `italicised` slipped through a list holding `italic` until the gerunds went in beside it.
    "Page is blank. Only faint, rubber-stamped smudges are visible.",
    "Page is blank. Only faint, pen-written smudges are visible.",
    "Page is blank. Only faint, hand-lettered smudges are visible.",
    "Page is blank. Only faint, hand-annotated smudges are visible.",
    "Page is blank. Only faint, italicised specks are visible, no text.",
    // A hyphen puts the slot's word mid-token: `dark` is the stack and `streaked` is the slot, so a check
    // reading whole words would answer that base had stripped `streaked` — base strips neither half — and
    // would take the span with base's `dark` veto in it. Both spellings refuse.
    "Page is blank. Only dark-streaked specks are visible.",
    "Page is blank. Only a few dark-handwritten dots are visible.",
    // The slot's extra word of reach may not begin behind a clause head, which is `NOT_CLAUSE_HEAD` — the
    // guard the comma'd form has carried since #220 — applied to the slotted plain form as well. Without
    // it, ANY word between a doubt word and a marks noun pulls the doubt word into the marks phrase and
    // the log's only doubt leaves with it: `with` is the wording a test above pins, and these are the same
    // sentence with the preposition replaced by a word no list could hold. Base's own reach stays
    // unguarded, so the phrases #220 exempts are untouched — three of them are in the delivered list.
    "Page is blank. The scan is noisy overall artifacts, no text.",
    "The page is blank. The image is grainy background specks, no text.",
    "Page is blank. The scan is dark uneven specks, no legible text.",
    // `as` between `not legible` and the noun is still anchored to a marks noun, so a log that names
    // none says its heading could not be read.
    "Page is blank. The heading is not legible as printed text.",
    "Page is blank. The pen marks are not legible as text.",
    // A smear, a streak and a blotch cover part of a sheet, so a log naming one has said the page might
    // have had something under it — the argument `MARK` already made for leaving them out of the marks
    // exemption, which bought nothing while none of the three was a doubt word in its own right (issue
    // #226). No corpus wording moves: none of the 818 first renders uses any of them.
    "Page is blank. There are smears on the page, no text.",
    "A streak covers most of the sheet; no text is visible. The page is blank.",
    "Page is blank. Blotches are visible, no text.",
    "Page is blank. Ink is smeared across the sheet, no text.",
    "Page is blank. The scan is blotchy, no text.",
    // What that costs, raised by #228's review: the noun decides on its own, so a smear the log puts in
    // one corner refuses too, though it covers no more than the `smudges` `MARK` exempts. Reading the
    // extent would mean trusting the same sentence whose reliability is the question, and the two nouns
    // are near-synonyms a log picks between freely. A glance at a page that was fine, pinned as the
    // price — `A few faint smudges on the paper, no text.` above is the other side of it, delivered.
    "Page is blank. An ink smear in the lower corner, nothing else.",
    "Page is blank. A small blotch of toner in the corner, no text.",
    // A comma-separated list continues the denial only while every word in it denies: a verb saying
    // the noun is there ends it, wherever in the list it sits.
    "Page is blank. A few specks. They do not resolve into any characters, printing is visible.",
    "Page is blank. A few specks. They do not resolve into any characters, words, a heading is visible.",
    // ...and the same affirmation with the verb left out, which is issue #227: a log written in
    // fragments says a page has something on it as `heading visible`, and there was no verb there for
    // the read above to find. What separates these from the denial lists beside them is the connector,
    // not the noun — a bare comma opens a fresh clause where `or` continues the denial — so the noun
    // has to OPEN its statement and carry nothing but a word saying it is there.
    "Page is blank. A few specks are visible, not legible text, heading visible.",
    "Page is blank. A few faint specks, not legible text, characters visible.",
    "Page is blank. Faint specks do not resolve into any characters, diagrams visible.",
    "Page is blank. A few specks, not legible text, printed heading visible.",
    "Page is blank. A few specks, not legible text, caption present.",
    "Page is blank. Scattered marks do not resolve into any characters, caption discernible.",
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

// The strip above removes the marks noun and leaves what was DRESSING it standing in the scope, so a log
// that calls the scan's own noise `print artifacts` hands the affirmation read the two words `print … are
// visible` with the noun that held them together gone — a blank page reported as a hole (#439). What
// decides it is the HEAD noun and not the dressing word: `print artifacts` is the scanner's and `print
// smudges` is smudged printing, and the test below the moved rows is the pin that settles which.
test("a name for text dressing a mark only the capture leaves goes with the mark (#439)", () => {
  // #439's table, the rows that move. Each was `blank_contradicted` → `page_no_output` for a page with
  // nothing on it, and the quote gave the defect away by being ungrammatical: `print are visible`.
  for (const log of [
    "Page is blank. Print artifacts are visible.",
    "Page is blank. Printing debris is visible.",
    "Page is blank. Image artifacts are visible.",
    "Page is blank. Print artifacts only.",
    "Page is blank. Printing debris visible.",
    "Page is blank. Some print dust.",
    "Page is blank. Image artifacts visible.",
    // Both paths, which the issue asks for in as many words: the four rows above with a copula reach the
    // defect through the verb read and predate the slot (a worktree at `8c9ef0b` behaves identically), the
    // three without it through #438's fragment read. One rule moves both because both read the same scope.
    "Page is blank. Print artifact visible.",
    "Page is blank. Image dust only.",
    "Page is blank. Line artifacts are visible.",
    "Page is blank. Text debris is visible.",
    // The joined spelling, which is how these logs write a pair of nouns. The unhyphenated form is the row
    // above; the hyphenated one never reached the defect, base having matched the whole compound.
    "Page is blank. Print/artifacts are visible.",
    "Page is blank. Print-artifacts are visible.",
  ]) {
    assert.equal(declaredBlank({ html: "", log }), true, log);
  }

  // A listed adjective in FRONT of the dressing word is a third position, and it is not this rule's to
  // take. Seven `MARK_MODIFIER` entries are `DEGRADED_IMAGE_LOG` veto words, so a first version of this
  // fix — replacing the whole match — turned `blank_vetoed` on `blurry` into a declaration and shipped a
  // page whose log says the scan is blurry empty, which is #226's failure reached from the other side.
  // The word is cut out of base's own output instead, so the stack stays in scope: the affirmation goes
  // and the doubt is kept, and each of these refuses on the adjective rather than on the noun.
  for (const [log, veto] of [
    ["Page is blank. Blurry print artifacts are visible.", "blurry"],
    ["Page is blank. Faint print artifacts are visible.", "faint"],
    ["Page is blank. Noisy image artifacts are visible.", "noisy"],
    ["Page is blank. Grainy print dust visible.", "grainy"],
  ] as const) {
    const r = blankDeclaration({ html: "", log });
    assert.equal(r.blank, false, log);
    assert.deepEqual(r.vetoes, [veto], log);
    assert.equal(r.affirmed, undefined, `${log}: refused as a doubt about the capture, not as a contradiction`);
  }
  // Which is a CHANGE of kind and not only of outcome, and the pair says so: base refused the first of
  // these by quoting `print are visible` — the ungrammatical contradiction #439 is about — where it now
  // refuses by naming the doubt word. Same page reported either way; the remedy on the line is different,
  // a doubt wanting a better scan and a contradiction wanting a re-extraction.
  assert.equal(
    blankDeclaration({ html: "", log: "Page is blank. Blurry print smudges are visible." }).affirmed,
    "print are visible",
    "a mark a pen also leaves keeps the dressing word, so this one is still the contradiction",
  );

  // The half that must not move, and the pin that chose the head noun over the dressing word. #431's grid
  // asserts this exact sentence refuses, for eight names for text against eight more in the other part of
  // speech — a rule keyed on `print` broke that cell. Keyed on the head, the same rule needs no exception
  // for it: `smudges` is a mark on the paper and `artifacts` is not.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Only print smudges are visible." }), false);
  // #435's own wordings, which are the reason `smudges`, `specks`, `dots`, `flecks`, `blemishes` and
  // `marks` all stay where they are: writing that is smudged is a page with writing on it.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Handwriting smudges are visible." }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Cursive smudges only." }), false);
  // Three of #439's ten rows do not move, and each has a mechanism that is not this rule's:
  //
  // `NOT_CLAUSE_HEAD` withholds the slot behind a copula (#220), so the phrase matched here is the bare
  // `dust` and `print` was never in the span this function is handed. The same sentence without `there is`
  // moves, and is in the list above — the pair is what says which bound owns this row.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. There is some print dust." }), false);
  // ...and these two are #431's class, not #439's: their head is a mark a pen also leaves, so the dressing
  // word is handed back exactly as `handwriting smudges` hands `handwriting` back. The issue tabled them
  // together with the rows above; they are two findings, and only one of them is this one.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Print smudges apparent." }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Typed specks visible." }), false);
  // The corpus's other head noun, deliberately outside the list: 7 of the 81 occurrences on disk dress
  // `dot(s)`, and a page can have real printed dots — `the table contains the printed dot leaders` is a
  // corpus statement about typographic CONTENT. So this stays reported, the same trade #193 made for bare
  // `marks`, and the row beside it is the one that pays for it.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Printed dots are visible." }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. The table contains the printed dot leaders." }), false);
  // What this costs, pinned as a price and not left to be re-found. Both corpus SENTENCES that change
  // reading are here: the first is a blank page now read as one, and the second is a page with content on
  // it — a character the model repaired — that would now be declared empty if the same reply also claimed
  // blankness. Neither reply does claim it, which is why 0 of the 204 declarations on disk move; the second
  // is the shape a future one would have to come in.
  assert.equal(
    declaredBlank({
      html: "",
      log:
        "Page is blank. Removed three stray dots (printing artifacts/dust specks in lower portion of page) " +
        "that were incorrectly transcribed as five separate <p>.</p> elements.",
    }),
    true,
  );
  assert.equal(
    declaredBlank({
      html: "",
      log:
        "Page is blank. The 'We·t Virginia' printing artifact in the source image has been transcribed as " +
        "'West Virginia' (the interpunct is a printing defect, not a character).",
    }),
    true,
    "a page with content on it, declared empty: the cost of the widening, and base reported this",
  );
  // The one corpus reply that both writes the phrase and declares the page blank, verbatim: blank before
  // this rule and blank after it, which is what "0 of the 204 declarations move" is made of.
  assert.equal(
    declaredBlank({
      html: "",
      log:
        "Page is blank. Only a few scattered specks/dots are present, which appear to be image artifacts " +
        "rather than content.",
    }),
    true,
  );

  // And the widening takes no veto with it, which is the claim `CAPTURE_ONLY_MARK`'s comment makes and
  // this is the check for it: the three words added are in neither veto list, so a sentence that doubts
  // the reading goes on refusing whether or not the phrase leaves with its head.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Print artifacts obscure the sheet." }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Image debris makes the page illegible." }), false);
  assert.equal(declaredBlank({ html: "", log: "The page is blank; the scan is noisy with artifacts, no text." }), false);
  // A doubt word the SLOT captured is untouched, because this branch only reaches words base was already
  // handing back: `smeared` goes back into the scope and `smear\w*` is a veto (#226), head noun or not.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Smeared artifacts are visible." }), false);
  // Nothing is stripped at all where the log holds a doubt this section will not argue with, so the whole
  // phrase stands and the read sees it entire — `text dust` quoted, rather than `text` alone.
  const doubted = blankDeclaration({ html: "", log: "Page is blank. Text dust; the scan is too dark." });
  assert.equal(doubted.blank, false);
  assert.equal(doubted.affirmed, "text dust");
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
    // `printed` behind a copula is a participle and not a subject (#220), and nothing is lost by
    // reading it that way: the affirmation here is `heading`, two words earlier, and it finds the same
    // verb. Pinned beside the denial it was costing ("No page number is printed on the page itself,
    // but…", above), because the two turn on the same word.
    "Page is blank. The heading is printed on the page.",
    "Page is blank. A caption is printed at the foot.",
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
    // The choice #204's review asked to be made deliberate: a blank pre-printed form whose locative
    // object is a form-structure noun `TEXT_NOUN` lists. Reported, on purpose. It is the issue's own
    // `missing from the figure` row with a different noun in it, and the presupposition is what the
    // read is: a log that speaks definitely of `the table` has named a thing on the paper that a
    // reader would have got nothing of, and the cost of being wrong is one glance at a form whose
    // cells are empty. `the printed border` and `the printed area` are refused for the opposite
    // reason — no noun there names anything a reader wanted.
    "Page is blank. Text is absent from the table on this blank form.",
    "Page is blank. No content is present in the label field of the form.",
    // The folio exemption (#222) is one SUBJECT skipped, not one statement excused: the loop keeps
    // reading, so a log that names the page number and then something else still affirms through the
    // something else. `page number` is required as a phrase for the same reason — a bare `number` names
    // a figure number or a total as readily as a folio.
    "Page is blank. The printed page number and a heading are visible.",
    "Page is blank. The printed folio is visible, and a caption is present at the foot.",
    "Page is blank. Printed numerals are visible.",
    // `page numeral` is as much a folio as `page number`, and is refused anyway: `numerals?` is in
    // `TEXT_NOUN` itself, so skipping the `printed` in front of it hands the affirmation to the noun two
    // words on. Pinned as the limit it is rather than covered — the only ways to cover it are taking
    // `numerals` out of the names for text or stepping the loop past a noun it would otherwise read, and
    // the second is what keeps `The printed page number and a heading are visible.` refused (#230's
    // review).
    "The page is blank. The printed page numeral 14 is visible at the foot.",
    "The page is blank. The printed page numerals are visible at the foot.",
    // The residuals, pinned as the cost they are, all three the same shape of cost: a folio-only page
    // reported is a glance, and the reads that would cover these would let a real affirmation through.
    //
    // An inverted cleft puts the folio behind a preposition and a verb (`the only thing printed on it IS
    // the page number`), where what the affirmation names cannot be read off the word after `printed`;
    // crossing a preposition to find out would take `Printing is visible beside the page number.` with
    // it.
    "Page 14 is blank; the only thing printed on it is the page number.",
    // And the post-verb shapes, where the folio is the OBJECT: `affirmedObjectAfter` returns the
    // `printed` it finds in the object gap without consulting `folioAt`, so these are unchanged from
    // before #222. What saves the `only` wordings of these exact three sentences — pinned as delivered
    // above — is that quantifier ending the object walk, not the folio.
    "The page is blank. There is a printed page number at the foot.",
    "The page is blank. The sheet contains a printed page number.",
    "The page is blank. It shows a printed page number at the foot.",
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
    // #220's two, verbatim from the corpus, and both are denials the walk stopped one word short of.
    // The first coordinates two nouns with a word between the second and its qualifier that names no
    // text and joins no clause, so `content` read as un-negated and found the list's own `is present`.
    "Page 14 appears to be blank. No readable text or meaningful visual content is present. A few faint specks/artifacts are visible but carry no informational content.",
    // The second is a denial of the page NUMBER, in the passive: `printed` is the one name for text in
    // this file that is also something a page can be, and read as a subject it reached the affirming
    // verb of the clause after the `but` — a clause about where the number came from.
    "Page 4 appears to be blank. Only a few scattered specks/dust marks are visible; no text, images, tables, or other content is present. No page number is printed on the page itself, but the file metadata indicates this is page 4 of 25, so the page-break marker has been emitted with that number.",
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
    // A negator that opens a coordination and a clause of its own after it used to be pinned here, as one
    // denied list: `No printed text, and handwriting is present.` The alternative reading was always the
    // other defensible one — #200's review raised it as the cost of `negatedInList` reaching across a comma
    // — and #436 took the choice again with the corpus counted rather than argued: 204 blank declarations on
    // disk, 69 of them reaching across a comma to a name for text, every one a list and not one of them
    // this shape. So it is refused now, by `secondClauseJoint`, and pinned in the #431 test below beside
    // the `scrawled` wording it used to disagree with. What still declares blank, and is the reason a bare
    // comma cannot be the rule, is a denial's own members: `No printed words, lines, or characters are
    // visible.` a few rows down, and 38 of those 204 declarations with it.
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
    // The denials the verbless-affirmation read (#227) must not swallow, and the whole boundary is the
    // connector: a denial coordinates the noun it goes on to deny, so `or diagrams visible` and `no
    // caption present` are the same `not legible text` continued, while `, heading visible` (refused
    // above) is a new clause. #220's own logs are written the coordinated way — "any characters, words,
    // diagrams, or other content" — and reading a predicated noun as an affirmation regardless of what
    // introduced it refused four of them.
    "Page is blank. Faint specks are visible, not legible text or diagrams visible.",
    "Page is blank. Faint specks are visible, not legible text or content visible.",
    "Page is blank. Faint specks are visible, not legible text and no heading visible.",
    "Page is blank. Faint specks are visible, not legible text, no caption present.",
    "Page is blank. Faint specks are visible, not legible text, nothing visible.",
    "Page is blank. Faint specks are visible, not legible text, none visible.",
    // A comma'd list with more than one name for text in it is a list and not a clause, whatever the
    // word after its last member is. Without that the middle noun's own index made the last one look
    // like a statement of its own. `no text, figures, captions visible` is an ordinary way to deny
    // three things at once, and it is the shape #228's review names as the residual — a log that says
    // `not legible text, words, heading visible` goes on being delivered blank. The two are the same
    // sentence to the word, so the reading is a choice about which is likelier and not an oversight,
    // and it costs the affirmation rather than these denials because a log naming two page objects and
    // predicating only the second, with no conjunction anywhere, is a wording nothing in the corpus
    // uses. The one-noun form it does use is refused above.
    "Page is blank. Faint specks do not resolve into any characters, words, diagrams present.",
    "Page is blank. A few specks, not legible text, figures, captions visible.",
    "Page is blank. A few specks, not legible text, headings, labels present.",
    "Page is blank. A few specks, not legible text, words, heading visible.",
    // And the denial's own noun, predicated: `not legible text visible` and `not legible text present`
    // are the commonest wordings in the corpus, and the word after the noun belongs to the denial.
    "Page is blank. Faint specks are visible, not legible text present.",
    "Page is blank. Faint specks are visible, not legible text visible.",
    "Page is blank. Faint specks are visible, not legible content discernible.",
    // The three nouns #226 left out of the doubt lists, and the reason is not the one their siblings
    // `smear`, `streak` and `blotch` are in for: these name something in ONE PLACE, which is what a
    // scanner leaves rather than how a covered page is described — and `spots` in particular is a word a
    // log may reach for to name the specks it is already allowed to describe.
    "Page is blank. Spots are visible, no text.",
    "Page is blank. Ink stains are visible, no text.",
    "Page is blank. Shadows fall across the sheet, no text.",
    // The page's own printed number named as the one thing on the sheet (#222). A folio is not content
    // here: `agents/page.md` forbids transcribing it as text, the only place its number may live is the
    // page-break marker's label, and `renderPage` discards that marker on every accepted declaration —
    // so a page printing nothing else has nothing on it a reader loses, and a log that says so
    // contradicts nothing. `printed` is what refused these: it is in `TEXT_NOUN` for the noun sense and
    // here it is an adjective on the number.
    "The page is blank. The printed page number 4 is visible at the foot.",
    "The page is blank; only the printed folio 14 is visible.",
    "The page is blank. Only the printed page number 14 is on the sheet.",
    "The page is blank except for its printed page number 14.",
    "Page 14 is blank apart from the printed page number.",
    "Page 14 is blank except for its printed folio.",
    // The two wordings `agents/page.md` now quotes to the model, which have to be the ones that survive.
    "The page is blank apart from the printed page number.",
    "The page is blank except for its printed folio.",
    // Already delivered before #222, because the subject-verb scan never reached their subjects —
    // `folio` and `pagination` are outside `TEXT_NOUN`, and `number` alone is outside it too.
    "The page is blank apart from the folio.",
    "Page is blank. The pagination is visible at the foot.",
    // The folio as the OBJECT of `there is` or of a transitive verb, delivered — and not by anything
    // #222 did: `only` is a quantifier that ends the object walk before it reaches the `printed`. Pinned
    // beside the same three sentences without it, which are refused (below), because the pair is the
    // whole difference and neither reading consults `folioAt`.
    "The page is blank. There is only a printed page number on the sheet.",
    "The page is blank. The page contains only its printed page number.",
    "The page is blank. It shows only a printed page number at the foot.",
    // What `printed` was accidentally covering, in the three shapes #230's review measured, each pinned
    // beside the same sentence with the folio phrase taken out — which is already delivered on the tree
    // before #222 and always was. So the exemption removed cover rather than opening a class: an
    // elliptical tail with no verb of its own, a noun behind a preposition, a noun with a verb outside
    // the affirming list, and a noun outside `TEXT_NOUN` are each undefended in their own right, and
    // whatever defends them later has to defend the second of each pair too. That is the point of pinning
    // both: a widening of `AFFIRMING_VERB` or `TEXT_NOUN` must not leave this exemption as the only thing
    // dropping the first of each pair.
    "Page is blank. The printed page number 4 is visible at the foot, and a heading at the top.",
    "Page is blank. A heading at the top.",
    "Page is blank. The printed page number is visible over the signature.",
    "Page is blank. A signature sits under the printed page number.",
    "Page is blank. The printed folio is visible; handwriting fills the margin.",
    "Page is blank. Handwriting fills the margin.",
    "Page is blank. Printed page numbers and a running title are visible.",
    "Page is blank. A running title is visible.",
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

// A name for text in the OTHER part of speech (#431). `TEXT_NOUN` holds `handwriting`, `stamps?` and
// `typing` and not `handwritten`, `stamped` or `cursive`, so a log naming writing with a participle or
// an adjective was a page delivered empty while the same claim in the noun form was refused.
//
// The axis is the LIST and not the POSITION, and that is the whole reason this test is a grid: #431 was
// filed claiming the opposite, off 14 wordings in subject position that all used listed words against 32
// in attributive position that all used unlisted ones. Two axes moved together, so the contrast measured
// neither. Crossed, the position column is flat and the list row is not — which also means the remedy the
// issue proposed, a rule about the modifier slot, would have left `cursive is visible` delivered empty.
test("a name for text affirms in either part of speech, and the position was never the axis", () => {
  // The grid. Every cell is the same eight names in the same two frames, and what moves is the list.
  for (const word of "handwriting writing typing text print stamp signature caption".split(" ")) {
    for (const frame of [`${word} is visible.`, `Only ${word} smudges are visible.`]) {
      assert.equal(declaredBlank({ html: "", log: `Page is blank. ${frame}` }), false, `listed: ${frame}`);
    }
  }
  for (const word of "handwritten cursive barcode typed scrawled italic watermark pencilled".split(" ")) {
    for (const frame of [`${word} is visible.`, `Only ${word} smudges are visible.`]) {
      assert.equal(declaredBlank({ html: "", log: `Page is blank. ${frame}` }), false, `unlisted: ${frame}`);
    }
  }
  // The modifier slot needed nothing taught to it, which is what the grid's flat column means:
  // `affirmingReach` already walks past an intervening noun, so the word in front of `smudges` is read
  // wherever it is read at all, and the span quoted skips the noun it dressed.
  assert.equal(
    blankDeclaration({ html: "", log: "Page is blank. Only cursive smudges are visible." }).affirmed,
    "cursive are visible",
  );
  // Each construction the reader has, in the new part of speech: the subject-verb scan, `there is`, a
  // transitive bearer, a contrast complement, and an exceptive object.
  for (const [log, affirmed] of [
    ["Page is blank. There is cursive on it.", "there is cursive"],
    ["Page is blank. The page contains a barcode.", "contains a barcode"],
    ["Page is blank. The sheet bears handwritten notes.", "bears handwritten"],
    ["Page is blank. Nothing typed, but handwritten notes remain.", "handwritten notes remain"],
    ["Page is blank. Text is nowhere except a barcode at the top.", "text is nowhere except a barcode"],
    // Boundary-tested rather than anchored, so the compound a log writes is read too — the reason
    // `NAMES_TEXT_FORM` is `\b`-tested is the reason it is the right list to have reached for here.
    ["Page is blank. hand-written notes are visible.", "hand-written notes are visible"],
    ["Page is blank. Rubber-stamped lettering is visible.", "rubber-stamped lettering is visible"],
  ] as [string, string][]) {
    assert.equal(blankDeclaration({ html: "", log }).affirmed, affirmed, log);
  }

  // The other direction, which is the one that costs pages: a blank page's log denies these nouns as
  // readily as a full page's affirms them, and widening what affirms without widening the walk that finds
  // the negator would hand the last member of a denial the verb of its own clause. That is #190's defect
  // arriving by the back door, and the first two rows are the ones that fail when the walk is left narrow —
  // measured by reverting that one call and re-running, not assumed.
  for (const log of [
    "Page is blank. No typed or stamped characters are present.",
    "Page is blank. No stamped or signed marks are present.",
    "Page is blank. No footnotes or annotations appear.",
    "Page is blank. No handwritten notes are visible.",
    "Page is blank. Nothing handwritten or cursive is visible.",
    "Page is blank. There is no barcode.",
    "Page is blank. No watermark is present.",
    "Page is blank. Nothing is stamped or signed.",
    // `The pre-printed form is empty; no handwritten entries.` was pinned here, moved to the end of this test
    // as a refusal by #437, and is pinned at the end as a DECLARATION again by #442 — beside its bare stem
    // and the reason, which is why it stays down there rather than coming back here: the stem was refused
    // too, so #437's row recorded a hyphen escaping a token-exact list and not a decision about blank forms,
    // and what decides both is the complement `empty`.
    // And the sentences a blank page is actually written in on the corpus, which name the marks and deny
    // the text. Unchanged, and the reason they are unchanged is that neither list has the marks
    // vocabulary in it (#193).
    "Page is blank. Some dust is present.",
    "Page is blank. Only scanner dust is present.",
    "Page is blank. Faint smudges, but visible dust remains.",
  ]) {
    assert.equal(declaredBlank({ html: "", log }), true, log);
  }

  // What that same widening must NOT buy, and the review of this change is what found it: the walk that
  // steps over a coordination's members steps into a SECOND clause just as readily, so a page whose log
  // says it carries handwriting was delivered empty — #431's own failure inverted, and the silent
  // direction. These sixty rows were the ones #434's comma bound moved; they are refused by
  // `secondClauseJoint` now, on the shape of the sentence rather than on the vocabulary of the word, and
  // the rows below are what that difference is worth. Both frames, because the negator's own member is a
  // noun in one and a bare qualifier in the other, and only one of those leaves an `AFFIRMED_NOUN` in the
  // walk's way.
  // BOTH JOINTS, and the second one is round 1 of #436's review: a clause can be spliced on with a bare
  // comma, and a rule that asked for `, and` shipped all 16 of the bare-comma rows empty — verdicts the
  // bound had got right, in the direction this file calls fatal. The joint word is not the discriminator;
  // the coordination continuing across the noun is.
  for (const word of "stamped scrawled inscribed cursive watermarked footnotes annotations barcodes".split(" ")) {
    for (const frame of [
      `No clear text, and ${word} words are visible.`,
      `Nothing legible, and ${word} content is present.`,
      `No clear text, ${word} words are visible.`,
      `Nothing legible, ${word} content is present.`,
    ]) {
      assert.equal(declaredBlank({ html: "", log: `Page is blank. ${frame}` }), false, frame);
    }
  }
  // THE ASYMMETRY #436 IS ABOUT, AND IT IS CLOSED HERE: the same sentence with a modifier the walk crossed
  // long before #431 in it. These three declared blank until #436 — `and scrawled words` refused while `and
  // printed words` shipped the page empty, one sentence answered by two mechanisms — and the deciding fact
  // was the form of the word rather than anything about the page. They are refused now for the reason the
  // rows above are: a verbless denial, one comma, an `and`, and a noun behind it with a finite verb of its
  // own. The first of them is #436's own title; the third is the reading #200's review weighed and chose,
  // and this is that choice being taken again with the corpus counted (0 of 204 declarations write it).
  for (const log of [
    "Page is blank. No clear text, and printed words are visible.",
    "Page is blank. Nothing legible, and handwritten content is present.",
    "Page is blank. No printed text, and handwriting is present.",
    "Page is blank. Nothing legible, and printing is visible.",
    // The same four with the joint spliced rather than coordinated, which is the class round 1 found: the
    // `and` was never what made them clauses.
    "Page is blank. No clear text, printed words are visible.",
    "Page is blank. No clear text, handwritten content is present.",
    "Page is blank. No printed text, handwriting is present.",
    "Page is blank. Nothing legible, printing is visible.",
    // The stated limit, pinned as the cost it is: a two-member denial with a plural verb has the same shape
    // as a second clause and is read as one, so this blank page is reported. Nothing in the sentence
    // separates them, the corpus writes neither, and a reported blank page is a glance where the other
    // direction is a sheet of handwriting delivered empty (#190, #371).
    "Page is blank. No text, and images are visible.",
    "Page is blank. No text, images are visible.",
  ]) {
    assert.equal(declaredBlank({ html: "", log }), false, log);
  }
  // And what the discriminator must not reach, which is the whole of the #200 trade it is scoped inside: a
  // denial's own members, separated by commas exactly as two clauses are. Three or more members, or a final
  // `or` joint, or a comma on the noun itself, or no verb of its own behind the comma — any one of those and
  // this is a list, and none of them is the joint word. The first
  // four are corpus-verbatim (the last of them #367's log), and on the 3,747 replies with a log on disk
  // this change moves none of the 204 declarations they come from.
  for (const log of [
    "Page is blank. No printed words, lines, or characters are visible.",
    "Page is blank. No text, images, or other content is visible.",
    "Page is blank. no printed text, numbers, or content of any kind is present.",
    "Page is blank. No legible text or content, and no writing is visible.",
    // A list whose last member carries its joiner BEHIND it, which is the shape a bare-comma joint takes
    // for a member rather than a clause: `figures` sits behind one comma with `or stamps` still to come,
    // and `stamps` sits behind the same comma with the `or` in front of it. The coordination scan is what
    // sees both, and this row is corpus-verbatim.
    "Page is blank. A few specks. No writing, figures or stamps are present.",
    // An ASYNDETIC list — members divided by bare commas with no joiner at all before the last — which is
    // round 2 of #436's review, and the one shape whose deciding comma sits ON the affirmed noun rather than
    // before or after it. The joint scan stops short of that comma and the coordination scan starts past it,
    // so all five of these were reported as holes for a page with nothing on it. They are members, and a
    // comma on the noun is now read as the coordination continuing across it.
    "Page is blank. No printed words, lines, characters are visible.",
    "Page is blank. No text, images, figures are visible.",
    "Page is blank. No text, handwriting, drawings are present.",
    "Page is blank. No writing, figures, stamps are present.",
    "Page is blank. No printed text, images, handwriting is visible.",
    // The same list with the first joint coordinated, which never reached the defect (the scan begins on the
    // second comma there) and is pinned so the two paths are held apart.
    "Page is blank. No printed words, and lines, characters are visible.",
    "Page is blank. No printed words, lines, characters, marks are visible.",
    // THE COST OF READING IT THAT WAY, pinned as a cost rather than a win, and it is the fatal direction: a
    // noun that heads an AFFIRMED list has the same shape as a member of a denied one, so if these logs meant
    // the stamps to be visible the page is delivered empty. #434's bound refused 24 of 24 rows like these on
    // the vocabulary of the modifier alone — with `printed` for `stamped` it declared them too — so one
    // reading now covers both wordings instead of two mechanisms disagreeing (round 3 of #436's review). 0 of
    // the 3,747 replies on record write it.
    "Page is blank. No clear text, stamped words, stamps are visible.",
    "Page is blank. Nothing legible, scrawled content, drawings are present.",
    "Page is blank. No printed text, and stamped words, marks are visible.",
    "Page is blank. No clear text, printed words, stamps are visible.",
    // No finite verb behind the joint: a fragment, so the noun is still a member. Whether a fragment
    // affirms at all is #435's question and `verblessAffirmation`'s answer, not this one's.
    "Page is blank. No printed text, and handwriting.",
    "Page is blank. No printed text, and printed words.",
    // And the marks strip's case, unchanged: a negator whose own next word is a conjunction never governed
    // the noun, so it is not read as a list either way (the veto refuses this page for the marks phrase).
    "Page is blank. No typed or stamped characters are present.",
    "Page is blank. No footnotes or annotations appear.",
  ]) {
    assert.equal(declaredBlank({ html: "", log }), true, log);
  }
  // The discriminators the #200 branch names — a determiner, an `only`, a verb in the second clause, a
  // `but` — all still end the walk, and none of them needs the clause read to do it.
  for (const log of [
    "Page is blank. No clear text, and the scrawled words are visible.",
    "Page is blank. No clear text, and only scrawled words are visible.",
    "Page is blank. No clear text is visible, and scrawled words are visible.",
    "Page is blank. No clear text, but scrawled words are visible.",
  ]) {
    assert.equal(declaredBlank({ html: "", log }), false, log);
  }

  // The wider vocabulary overlaps `QUALIFIER` in `typed` alone, and the two guards written for `printed`
  // therefore do NOT cover it by testing `QUALIFIER` membership — which is what this file claimed until the
  // review of #431's fix measured it, and the claim was wrong for 13 of the 13 participles it tried. Both
  // guards ask `modifierForm` instead, the union of the qualifier list with the names for text in their
  // adjective form: the copula guard (#220's blank page, a denial whose participle would otherwise take the
  // verb ten words along) and the folio guard (#222's page, which prints nothing but its own number). So
  // every one of these pairs has to agree, and what they agree on is the answer `printed` already gave.
  //
  // THE SCOPE OF THAT CLAIM WAS THE BARE TOKEN, and #437 widened it to the hyphenated compound as well —
  // the rows below this loop are that half. What this loop still measures is the bare word, because the
  // guards it names are the two that ask `modifierForm`.
  for (const word of "typed stamped signed embossed watermarked annotated engraved scrawled inscribed".split(" ")) {
    for (const [wide, printed] of [
      [`Page is blank. The ${word} page number is visible.`, "Page is blank. The printed page number is visible."],
      [
        `Page is blank. No page number is ${word} on the page itself, but the file metadata indicates this is page 4 of 25.`,
        "Page is blank. No page number is printed on the page itself, but the file metadata indicates this is page 4 of 25.",
      ],
    ] as [string, string][]) {
      assert.equal(declaredBlank({ html: "", log: wide }), declaredBlank({ html: "", log: printed }), wide);
    }
  }
  // Stated both ways round, because a pair that agrees proves nothing about which answer it agrees on.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. The typed page number is visible." }), true);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. The stamped page number is visible." }), true);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. The heading is typed on the page." }), false);
  // What the folio guard skips is the SUBJECT and not the sentence, for the wider vocabulary exactly as for
  // `printed`: a second noun still affirms, so only a log whose sole named subject is the folio is let
  // through.
  assert.equal(
    blankDeclaration({ html: "", log: "Page is blank. The stamped page number and a heading are visible." }).affirmed,
    "heading are visible",
  );

  // AND THE HYPHENATED COMPOUND ANSWERS AS ITS OWN STEM, which is #437 and is the half this file used to say
  // could not be closed. `NAMES_TEXT_FORM` is `\b`-tested and `TEXT_NOUN`/`QUALIFIER` are token-exact, so
  // before this a compound was read by whichever list happened to hold its stem: `typed` was in the
  // boundary-tested one so `pre-typed` was read, `printed` was in neither so `pre-printed` was not. 24 of
  // these 40 pairs answered differently from their bare stem — 6 in the affirmation path, 12 in the object
  // walk of a locative denial, 2 in a copula — and both directions were represented, with the fatal one
  // dominating: `A caption is missing from the machine-printed heading.` is a page with a heading on it
  // delivered empty, and it read that way for `typed` as much as for `printed`, so this was never a
  // consequence of the widening beside it. All 40 agree now, at three call sites: `printed` joining
  // `NAMES_TEXT_FORM`, and `qualifies` in place of `QUALIFIER.has` in `definiteBefore` and on both of
  // `exceptiveOrLocativeObject`'s reads of the object.
  //
  // What a pair pins is parity with the STEM and not that the stem is right — whether these frames get the
  // answer a page needs is what the rows further up ask, and here the claim is only that the hyphen decides
  // nothing.
  for (const frame of [
    (w: string) => `The ${w} notes are visible.`,
    (w: string) => `The ${w} form is empty.`,
    (w: string) => `The ${w} template is visible.`,
    (w: string) => `No content is present in the ${w}.`,
    (w: string) => `No content is present in the ${w} area of the form.`,
    (w: string) => `A caption is missing from the ${w} heading.`,
    (w: string) => `A caption is missing from the ${w} figure on the page.`,
    (w: string) => `Printing is nowhere except a ${w} stamp at the top.`,
    (w: string) => `The page is ${w}.`,
    (w: string) => `The ${w} page number is visible.`,
  ]) {
    for (const [stem, compound] of [
      ["printed", "machine-printed"],
      ["printed", "pre-printed"],
      ["typed", "pre-typed"],
      ["typed", "machine-typed"],
    ]) {
      assert.equal(
        declaredBlank({ html: "", log: `Page is blank. ${frame(compound!)}` }),
        declaredBlank({ html: "", log: `Page is blank. ${frame(stem!)}` }),
        frame(compound!),
      );
    }
  }
  // Both ways round again, one row per direction, because 40 agreeing pairs say nothing about what they
  // agree on. The first is the fatal one the walk had to keep crossing the compound to reach; the second is
  // the object phrase that ends AT the word, where the modifier is all there is and skipping it is right.
  assert.equal(
    declaredBlank({ html: "", log: "Page is blank. A caption is missing from the machine-printed heading." }),
    false,
  );
  assert.equal(declaredBlank({ html: "", log: "Page is blank. No content is present in the pre-typed." }), true);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. The machine-printed notes are visible." }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. The machine-printed page number is visible." }), true);
  // THE ROWS #431 COST, pinned as DECLARATIONS now, which is where they should have been all along. #431
  // pinned them as refusals and named the loss: a blank page reported is a real one. It was never a decision
  // about blank forms — the same sentence with the bare stem in it was refused here and before #431 too, so
  // what made the hyphenated wording a declaration was the hyphen (`printed` read as a name for text only
  // when token-exact), and the pin recorded that escape rather than an answer. The word that ought to decide
  // all five is `empty`, and #442 is where that got fixed: `ABSENCE_COMPLEMENT` reads the complement, so both
  // wordings move together now instead of only the one that happened to have a hyphen in it. The grid for
  // all six words is pinned further down.
  for (const log of [
    "Page is blank. The pre-printed form is empty; no handwritten entries.",
    "Page is blank. The printed form is empty; no handwritten entries.",
    "Page is blank. The printed form is empty.",
    "Page is blank. The heading is empty.",
    "Page is blank. The stamped area is blank.",
  ]) {
    assert.equal(declaredBlank({ html: "", log }), true, log);
  }
  // And the complements that ARE read, so the pairing above is a statement about `empty` and not about a
  // denial behind a copula generally.
  for (const log of [
    "Page is blank. The typed heading is absent.",
    "Page is blank. The machine-printed heading is absent.",
    "Page is blank. Handwriting is missing.",
    "Page is blank. Printing is absent.",
  ]) {
    assert.equal(declaredBlank({ html: "", log }), true, log);
  }

  // ALL THIRTEEN QUALIFIERS, not the two the overlap is about, because `qualifies` reads compounds of the
  // whole list and round 1 of #437's review was right that the evidence covered two of them. Swept — 13
  // words x 3 prefixes x the 4 frames the three call sites own, 156 cells — the compound disagreed with its
  // own bare stem in 75 cells on base and in 0 now, and every one of the 75 moved TO the stem's answer. The
  // split by direction is 36 toward a declaration and 39 toward a refusal, so this is not a widening with a
  // safe side; it is the same sentence being answered by one rule instead of two.
  for (const frame of [
    (w: string) => `The ${w} image is visible.`,
    (w: string) => `A caption is missing from the ${w} heading.`,
    (w: string) => `No content is present in the ${w}.`,
    (w: string) => `The ${w} heading is visible.`,
  ]) {
    for (const word of "meaningful legible readable printed typed visible discernible apparent recognizable recognisable clear other more".split(
      " ",
    )) {
      for (const prefix of ["semi", "machine", "barely"]) {
        assert.equal(
          declaredBlank({ html: "", log: `Page is blank. ${frame(`${prefix}-${word}`)}` }),
          declaredBlank({ html: "", log: `Page is blank. ${frame(word)}` }),
          frame(`${prefix}-${word}`),
        );
      }
    }
  }
  // One row per direction with the answer written down, and the control that says the walk still stops at a
  // compound it does not recognise. 33 of the 36 declaring rows are one interaction and it is the deliberate
  // one — the other 3 are `No content is present in the {semi,machine,barely}-typed.`, which declare through
  // the terminal-object exclusion and are pinned with the rest of that frame below, and they are named apart
  // because an aggregate covering two mechanisms hides one of them. The 33: a DEFINITE `image` is the scan
  // rather than a thing on the page (`LOCATIVE_SUBSTRATE`), and the
  // qualifier walk in `definiteBefore` is what finds the article in front of it. `The legible image is
  // visible.` declares on base as it does here; what changed is that the compound now reaches the same
  // reading instead of stopping short of the article and affirming the scan.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. The legible image is visible." }), true);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. The semi-legible image is visible." }), true);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. The foo-bar image is visible." }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. The rotated image is visible." }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. An image is visible." }), false);
  // The refusing direction, same word: the object walk crosses the compound to the noun behind it, so the
  // heading the log presupposes is read and the page is reported rather than delivered empty.
  assert.equal(
    declaredBlank({ html: "", log: "Page is blank. A caption is missing from the semi-legible heading." }),
    false,
  );
  assert.equal(declaredBlank({ html: "", log: "Page is blank. A caption is missing from the legible heading." }), false);
  // THE ONE PLACE A COMPOUND STILL DISAGREES WITH ANOTHER SPELLING OF ITSELF, pinned because round 1 of the
  // review found it and because the disagreement is not with the stem: `hand-printed` is read as a compound
  // of `printed` and skipped, while `handprinted` written solid matches only the standalone `hand-?printed`
  // entry and is read as a name for text. For this sentence the skipping answer is the right one — the log
  // denies content in a region and the page is blank — so what the pair exposes is the OTHER side: a
  // terminal object that is a name for text and not a qualifier refuses a page whose log denied content,
  // which is what `written`, `stamped`, `hand-written` and `handprinted` all do here and did before this
  // change. The frame is not log English (the natural wording puts a noun behind the modifier, and there all
  // five spellings agree on both arms), so this is recorded rather than widened.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. No content is present in the printed." }), true);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. No content is present in the machine-printed." }), true);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. No content is present in the hand-printed." }), true);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. No content is present in the handprinted." }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. No content is present in the written." }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. No content is present in the hand-written." }), false);
  // And with the noun behind the modifier, which is how a log writes it: every spelling agrees, both
  // directions, and none of these moved.
  for (const log of [
    "Page is blank. No content is present in the hand-printed area of the form.",
    "Page is blank. No content is present in the handprinted area of the form.",
    "Page is blank. Printing is nowhere except a hand-printed note at the top.",
    "Page is blank. Printing is nowhere except a handprinted note at the top.",
  ]) {
    assert.equal(declaredBlank({ html: "", log }), true, log);
  }
  for (const log of [
    "Page is blank. The hand-printed notes are visible.",
    "Page is blank. The handprinted notes are visible.",
    "Page is blank. The machine-printed notes are visible.",
  ]) {
    assert.equal(declaredBlank({ html: "", log }), false, log);
  }
});

// The one caller that reads the second list on different terms, and why it has to. The object of a
// denial's preposition is where the file's `printed` exception lives — `in the printed area of the form`,
// `on the printed side` are how a blank pre-printed form and a blank verso get described, and taking the
// adjective for the object reported all of them failed (#190's own truncated evidence). Most of
// `NAMES_TEXT_FORM` is participles, so the whole shape recurs there; `!QUALIFIER.has(object)` cannot
// cover it, because `printed` and `typed` are the only two members that list happens to hold.
//
// So what the word MODIFIES is the question asked, which is `contrastAffirmed`'s own device: an object
// phrase that ends at the word is one where the word is the object, and a word with a noun still behind
// it is an adjective on that noun. Refusing the list here outright would have been cheaper and is not
// free — `barcode`, `watermark`, `footnote`, `monogram`, `letterhead`, `drawing`, `sketch`, `annotation`,
// `inscription` and `symbol` are content by any reading, and `TEXT_NOUN` has none of them.
test("an exceptive object in the second part of speech is read by what it modifies", () => {
  // The phrase ends at the word: nothing after it, or a preposition or adverb opening the next phrase.
  for (const [log, affirmed] of [
    ["Page is blank. Text is nowhere except a barcode at the top.", "text is nowhere except a barcode"],
    ["Page is blank. Printing is nowhere except a watermark.", "printing is nowhere except a watermark"],
    ["Page is blank. Content is absent apart from a monogram here.", "content is absent apart from a monogram"],
  ] as [string, string][]) {
    assert.equal(blankDeclaration({ html: "", log }).affirmed, affirmed, log);
  }
  // A noun still behind it, so the word is an adjective on that noun and the page stays blank. These four
  // are the rows that fail when the phrase-end guard is dropped — the guard moves them, so it is not
  // decoration.
  for (const log of [
    "Page is blank. Nothing in the watermarked margin.",
    "Page is blank. No content is present on the typed side.",
    "Page is blank. Nothing is legible within the stamped border.",
    "Page is blank. No text is visible from the embossed edge inward.",
  ]) {
    assert.equal(declaredBlank({ html: "", log }), true, log);
  }
  // And the ordering, which is a defect this branch had before it was pinned: it runs in FRONT of the
  // `!QUALIFIER.has(object)` skip, so without the same exclusion on it, `typed` broke the walk where
  // `printed` is stepped over and the noun one word later affirms. Two wordings that differ only in which
  // of the two overlapping words they use have to agree, whatever they agree on — and that is asserted of
  // the bare tokens, for the reason given at the `modifierForm` pairs above: the exclusion is token-exact
  // and the list it protects the overlap against is boundary-tested, so a compound is a different question
  // and it is #437's.
  for (const pair of [
    ["Page is blank. A caption is missing from the typed heading.", "Page is blank. A caption is missing from the printed heading."],
    ["Page is blank. Text is nowhere except for the typed heading.", "Page is blank. Text is nowhere except for the printed heading."],
  ]) {
    const [a, b] = pair as [string, string];
    assert.equal(declaredBlank({ html: "", log: a }), false, a);
    assert.equal(declaredBlank({ html: "", log: b }), false, b);
  }
  // The qualifier reading still wins where it is the only right one, which is the case the exception was
  // written for and the case a wider list must not take back.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Nothing is legible in the printed area of the form." }), true);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Nothing is legible in the typed area of the form." }), true);
});

// The gap #431 recorded and #435 closed: a log naming writing in a VERBLESS fragment lost its page
// whichever list the word was in, because `affirmingReach` needs a verb to hand the noun and there is
// none in `handwriting smudges only.` Orthogonal to the vocabulary axis — `handwriting` was listed and
// delivered empty here — so both halves are pinned, listed word and unlisted-then-listed alike.
test("a name for text in a verbless fragment is a contradiction (#435)", () => {
  for (const log of [
    // #435's table, which is the spec: seven wordings measured declaring a page with writing on it blank.
    "Page is blank. handwriting visible.",
    "Page is blank. handwriting smudges visible.",
    "Page is blank. handwriting present.",
    "Page is blank. handwriting smudges only.",
    "Page is blank. handwriting only.",
    "Page is blank. Only handwriting smudges.",
    "Page is blank. A heading.",
    // The other vocabulary, which is #431's axis and is read here by the same `affirmsText` — so the two
    // fixes compose rather than each covering one wording of the pair.
    "Page is blank. cursive smudges only.",
    "Page is blank. Typed lines visible.",
    // A predicate, the end of the statement, and a closing particle are the three ways the read ends.
    "Page is blank. Just a heading.",
    "Page is blank. A caption only.",
    "Page is blank. Two headings.",
  ]) {
    assert.equal(declaredBlank({ html: "", log }), false, log);
  }
  // The words the refusal is reported in, which is the whole reason `affirmed` is a string: a fragment's
  // quote runs from the noun to what ends it, so `blank_vetoed` shows the fragment and not just the noun.
  assert.equal(
    blankDeclaration({ html: "", log: "Page is blank. handwriting smudges visible." }).affirmed,
    "handwriting visible",
  );
  assert.equal(blankDeclaration({ html: "", log: "Page is blank. A heading." }).affirmed, "heading");
  // The same sentence with a verb in it is the contradiction it always was, and the pair is what makes
  // the read above one about the noun phrase rather than one about the verb.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. handwriting smudges are present." }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. cursive smudges are present." }), false);
});

// The other direction, and the one that decides whether the read above is worth having: a blank page's
// own log is written in fragments too — 94 of the corpus's 204 blank-page logs have a verbless statement
// in them — and every one of those fragments is a DENIAL. Refusing any of these is #190 from the other
// end, so the bounds that keep them are asserted here beside the wordings that pay for them.
test("a blank page's own fragments are not affirmations (#435)", () => {
  for (const log of [
    // Fragments whose noun is not a name for text at all, which the noun lists already decided (#193).
    "Page is blank. Just specks.",
    "Page is blank. Only scanner dust.",
    "Page is blank. Nothing but dust.",
    "Page is blank. Only faint speckling.",
    "Page is blank. Nothing but scanner dust and light speckling.",
    // Fragments a negator owns, which `negatedInList` already read — and this is how the corpus writes
    // them: `No content to transcribe.`, `No page number printed.` and `Nothing to transcribe.` are
    // verbatim from blank-page logs on disk.
    "Page is blank. No content to transcribe.",
    "Page is blank. Nothing to transcribe.",
    "Page is blank. No page number printed.",
    "Page is blank. No page number printed on the page, so no page-break marker emitted.",
    "Page is blank. No text, nothing legible.",
    "Page is blank. no handwriting.",
    "Page is blank. Nothing printed.",
    "Page is blank. No text, images, or handwriting.",
    "Page is blank. Nothing legible; no words or characters.",
    "Page is blank. No printed text, only scanner noise.",
    "Page is blank. Only scattered dust/noise artifacts visible.",
    // A negative complement AFTER the noun, refused by the forward walk not crossing it rather than by
    // any list of complements: whatever says "not there" is a word the walk stops at.
    "Page is blank. Text absent.",
    "Page is blank. Text missing.",
    "Page is blank. Text nowhere.",
    "Page is blank. Text nowhere on the sheet.",
    // A negating word in FRONT of the noun that is in none of this file's negator lists — `devoid` and
    // `lacks` are deliberately outside `NEGATIVE_COMPLEMENT`, and nothing reads `free of`. These four are
    // the rows that fail when the opening bound is dropped, so the bound is not decoration; no corpus
    // wording fails with it dropped, which is why they are constructed and said to be.
    "Page is blank. Devoid of text.",
    "Page is blank. Lacking text.",
    "Page is blank. Free of text.",
    "Page is blank. Empty of text.",
    // Not a fragment about the page at all. `printed` is in `TEXT_NOUN` for its noun sense, and `number`
    // and `marker` are outside it, so the opening bound is again what decides — this one verbatim from a
    // corpus log.
    "Page is blank. the page-break marker uses the document sequence number 4 as given by the filename metadata.",
  ]) {
    assert.equal(declaredBlank({ html: "", log }), true, log);
  }
  // Where this read is NARROWER than the verb read, which looks like an inconsistency and is one: the verb
  // walk crosses any word to find its verb, and this one crosses only the words a noun phrase is made of
  // — and bare `marks` is deliberately not one of them (#193: `marks` is what a blank page calls the dust
  // on it). So the pair disagrees, and the pin says which way each goes rather than leaving it to be found.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Handwritten marks only." }), true);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Handwritten marks are visible." }), false);
  // The locative tail, not read here and not free to read: `A heading at the top.` is pinned as delivered
  // above with two more of its shape, and the paragraph there says a widening must defend both halves of
  // each pair. `Blank apart from a caption.` was the same kind of gap from the exceptive side — the
  // exceptive read needed a denial and this fragment had none. It HAS one now (#442: `blank` is a denial to
  // the scan that reads exceptives), so that half is closed and the locative half is not, which is why the
  // two are pinned in opposite directions on adjacent lines.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. handwriting only in the margin." }), true);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Blank apart from a caption." }), false);
  // What the comma bounds cost, pinned as the gap it is rather than left to be re-measured: a fragment cut
  // off at its own noun is a list member, and the list a blank page writes is a list of what is ABSENT
  // with the denial at either end. So a noun with a comma on it is not read, and the price is a fragment
  // whose denial stands BEHIND the noun — which the denial-anchored read at the end of `contentAffirmed`
  // cannot pick up either, because it only looks forward from the negator. Base delivers this page empty
  // too, so this is a defect left standing and not one bought.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. A signature, nothing else." }), true);
  // A statement that is the name and NOTHING else no longer affirms (#440). Statements split on `;` and on
  // line breaks as well as on `.`, so each of these is one word by the time the read sees it, and in the
  // third the denial is in the next statement where nothing here can reach it. A plain `tokens.length === 1`
  // guard was written for this and taken back out in `c43dff9`, because it also delivered the pair at the
  // bottom of this block empty; the two halves are pinned together here because the guard that ships has to
  // hold both at once, and what tells them apart is not the token count.
  assert.equal(declaredBlank({ html: "", log: "Blank page; text" }), true);
  assert.equal(declaredBlank({ html: "", log: "Blank page. Content" }), true);
  assert.equal(declaredBlank({ html: "", log: "Page is blank; images; nothing present." }), true);
  // Every boundary is one of these, `.` and `?` included, and the denial can be on either side of the
  // label — behind it in the first, ahead of it in the second.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. No printed text. Images." }), true);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Images. No text." }), true);
  // Not moved, and the row that says how narrow the guard is: `Any text` is TWO tokens, so a determiner in
  // front of the label puts the statement back outside the guard and the page is reported again. The answer
  // to the question is in the next statement, and nothing here reaches across a boundary to find it.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Any text? None found." }), false);
  // Already declared before the guard existed, and still declared: a label with its denial in the SAME
  // statement is more than one token, whatever punctuation joins them. These are the rows that would break
  // if the guard were written the other way round — refusing every statement whose only NOUN is a label.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Text: none." }), true);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Text (none)." }), true);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Text/handwriting: none detected." }), true);
  assert.equal(declaredBlank({ html: "", log: "Page is blank; no text; no images." }), true);
  // The other half, and why the guard asks whether the strip CUT this statement rather than how long it is:
  // after the marks strip these arrive as a single token too, because `vetoScope` removed the head noun —
  // and the phrase is #435's own, six of the seven wordings in that issue being this phrase with a predicate
  // on the end. Refusing the declaration is right here and wrong above, `tokens.length` is 1 in both, and
  // the word that separates them is the one the strip took. So `vetoScope` leaves `PHRASE_GONE` where it
  // cut, the statement carries the mark through to the guard, and these two stay reported.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Handwriting smudges." }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Cursive smudges." }), false);
  // What the guard costs, pinned as a loss and not left to be found: a lone name for text with no strip
  // behind it is exactly the shape the guard refuses, so a model that writes this to mean handwriting IS
  // there is now read as declaring the page empty. One wording against the five above, and no reply in the
  // 3,747-reply corpus writes either shape — the trade is between two unobserved sets, which is why the
  // corpus could not pick the guard and the pair below it had to.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. handwriting." }), true);
  // Not one of them, though it looks like one: `notes` is outside `TEXT_NOUN`, so this page ships empty
  // with the guard and without it, and no bound in this function is what decides it (#437's neighbourhood).
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Handwritten notes." }), true);
  // Nothing is stripped out of these two and they are two tokens either way, so the guard does not reach
  // them — pinned beside the rows above so a future one-token rule cannot be tested on them by mistake.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Typed lines." }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Printed text." }), false);
  // One token is not the whole statement either, and `words()` is why: it tokenizes `[A-Za-z][A-Za-z'’-]*`,
  // so a digit and a bullet are invisible to it and a guard counting tokens alone would read `2 images.` as
  // a bare label. It is a COUNT of what is on the page, and a bulleted list of a page's contents is one
  // token per line — so the guard asks the statement to BE the name, and each of these goes on reporting.
  // `two images.` was never at risk, being two tokens, and is pinned beside its digit so the pair cannot
  // drift apart. Raised by the review on PR #444.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. 2 images." }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. 1 signature." }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Two images." }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank.\n- text\n- images" }), false);
  // Where that leaves the boundary, pinned because the guard now turns on ANY non-letter decoration and the
  // bullet above is only one shape of it. A colon, markdown emphasis, brackets and quotes all keep the
  // affirmation, so `handwriting.` and `**handwriting**` reach opposite verdicts off the same word. That
  // asymmetry is deliberate and the corpus is what settles it: of the 3,402 one-token statements in the
  // 3,747-reply corpus only 1,073 are bare, 2,329 carry decoration (`,·` a table cell after a comma, and
  // digits), and ALL FOUR that name text are decorated — `' paragraph`, `Heading '9`, `heading '3`, `' line`.
  // So a guard reading through decoration would move four real statements toward shipped-empty and none
  // toward declaring, which is the losing direction (#190). Raised by the review on PR #444.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. handwriting:" }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. **handwriting**" }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. (handwriting)" }), false);
  assert.equal(declaredBlank({ html: "", log: 'Page is blank. "handwriting"' }), false);
  // Case and surrounding whitespace are NOT decoration by the time this read sees them, because the
  // comparison is made at `words()`'s own normalization and that is what folds them.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. HANDWRITING." }), true);
  assert.equal(declaredBlank({ html: "", log: "Page is blank.  handwriting  ." }), true);
  // A boundary is not always a sentence end, which is the third face of the same mistake and the one the
  // `bare` rule above created. A numbered list marker ENDS IN A `.`, so `1.` is a boundary and every line of
  // a numbered enumeration arrives as a bare single token — the whole list of what is on the page eaten, and
  // the page shipped empty, while the `-` spelling four lines up is rescued. The guard's premise is that a
  // name alone BETWEEN TWO BOUNDARIES is all there is to read, and that holds only where the boundary behind
  // it ended a sentence: a preceding statement with no letter in it is a marker, so the name is a list item.
  // Keyed on "no letter" and not on a marker vocabulary because the corpus says which spellings exist — 73
  // of 3,747 replies write a `1.` list line, 2 write a `-` one, and `1)`, `a.`, `a)` and roman numerals
  // appear in none. Every spelling is pinned here so a later narrowing has to say which it drops.
  // Raised by the review on PR #444.
  assert.equal(declaredBlank({ html: "", log: "Page is blank.\n1. text\n2. images" }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank.\n1. handwriting\n2. signature" }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. 1. handwriting" }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. 12. text" }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. 3.\ntext" }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank.\n1) text\n2) images" }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank.\n* text\n* images" }), false);
  // And a marker is not what makes a list — the SEQUENCE is. A model that lists a page's contents one per
  // line with no marker at all has a sentence behind every line, so the rule above helped none of them and
  // the guard ate the whole enumeration. A run of lone names is a list and one lone name is a lone name, so
  // the neighbour on either side decides. `i.` and `A.` fall out of the same clause, a marker that is itself
  // a letter being a lone name too. Raised by the review on PR #444.
  assert.equal(declaredBlank({ html: "", log: "Page is blank.\ntext\nimages" }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank.\nhandwriting\nsignature" }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Contents:\ntext\nimages" }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. i. text" }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. A. text" }), false);
  // A ONE-ITEM list is where it stops, and the row says so rather than leaving it to be found: this is
  // `Blank page; text` in everything this read can see, and it declares. The guard's cost is that shape and
  // not the `handwriting.` wording.
  assert.equal(declaredBlank({ html: "", log: "Page is blank.\ntext" }), true);
  // The letterless-neighbour clause reaches wider than a marker, which is deliberate and pinned: a statement
  // the marks strip reduced to `PHRASE_GONE` has no letter in it either, so the name behind it affirms. That
  // is base's own answer for both of these, and a narrowing of that clause toward real markers would have to
  // move them.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Print artifacts. text" }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Smudges. text" }), false);
  // A run of lone names does not have to be on separate lines: `;` is a boundary too, so a semicolon list of
  // labels is the same shape and reports, exactly as it did before any of this. Pinned beside the row it is
  // one token away from — `Page is blank; images; nothing present.` declares because `nothing present` is TWO
  // tokens and so is a sentence rather than a sibling — because that pair is the whole of what the sequence
  // clause turns on, and a rule that moved either of them would be a different rule. Raised by the review on
  // PR #444.
  assert.equal(declaredBlank({ html: "", log: "Page is blank; text; images" }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank; handwriting; signature" }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank; images; nothing present." }), true);
  // And the rule reaches no further than the boundary behind the name: a lone name whose preceding
  // statement is a SENTENCE still declares, which is the whole of what #440 asked for and the row the fix
  // above must not take with it.
  assert.equal(declaredBlank({ html: "", log: "Blank page; text" }), true);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. handwriting." }), true);
  // What the mark being a character in the text costs: a log could write one, and a forged one would hand
  // the guard back the affirmation it takes away. It cannot — `vetoScope` deletes `\f` and `\v` from its
  // input before inserting any — so a lone name for text with a form feed in front of it is read exactly
  // as the lone name above. Both of these DO report with that cleaning removed, which is what the cleaning
  // is buying and the reason it is a line of its own. `\v` is cleaned beside it though the guard reads only
  // `\f`, so a marker respelled later cannot become forgeable by moving one character.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. \ftext" }), true);
  assert.equal(declaredBlank({ html: "", log: "Blank page;\ftext" }), true);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. \vtext" }), true);
});

// --- blankness the reply STATES, rather than blankness read out of its prose (#371) ---------------
//
// Everything above decides whether an English sentence means "this page is empty", and five pages have
// been lost to five different words while it was being got right: #190 to `resolve`, #194 to a
// contradiction that was not one, #220 to a negator four tokens behind its noun, #343 to `image`,
// #367 to `document`. Each fix bought the word it was written for. The reply can now say so in a field
// instead, which is the one change that is not about a word — the tests here are what that field is and
// is not allowed to do.
test("a reply that states blankness in a field does not have to say it in a sentence", () => {
  // A log about a page that is empty, read as saying something is on it, verbatim from the bench corpus:
  // `Source image is entirely` affirms because the exemption for naming the substrate wants a determiner
  // DIRECTLY beside `image`, and one word in between stops it applying (#429's fault C, which is a reach
  // measured in tokens and is deliberately not fixed by adding a word to a list).
  //
  // Two other logs stood here and neither does now, which is the relationship between the field and the
  // prose read rather than a redundancy. #367's went when `document` became a modifier (#379, and the test
  // below it); #343's went when a sentence about the file's NAME stopped affirming (#429, and the test
  // beside the substrate read). The field carries the replies that send it, the walk carries the ones that
  // do not — every reply sent before the field existed, and every model that ignores it — and each fix to
  // the walk takes a row off this list rather than making the field matter less.
  const lost: [string, string][] = [
    [
      "the bench corpus's one refused declaration, which says the page is blank three times",
      "Source image is entirely blank/white with no visible content, text, graphics, or printed page number. No page-break marker can be emitted because no folio number is visible on the page. No content to transcribe.",
    ],
  ];
  for (const [name, log] of lost) {
    assert.equal(declaredBlank({ html: "", log }), false, `${name}: the prose read still loses this page`);
    assert.equal(declaredBlank({ html: "", log, blank: true }), true, `${name}: the field states it and is believed`);
    // And what the prose read decided is still on the record, because it is the thing that costs a
    // verify call now instead of a page: `affirmed` survives the field.
    assert.ok(blankDeclaration({ html: "", log, blank: true }).affirmed, `${name}: the misreading is kept`);
  }
});

// The floor under every reply that does not send that field — which is every reply sent before it
// existed, and any model that ignores it (#379, from #367 and #371's appendix). A denial distributes over
// a coordination, and #190 and #194 got that axis right; what it could not reach was a member spelled
// with a noun in front of it. `no page content` shipped and `no other DOCUMENT content` did not, so
// which noun the model happened to write decided whether the page survived — the same shape as `image`
// (#343) and a negator four tokens back (#220), one word further along.
//
// The two axes are measured separately here because a widened rule has more than one, and the cuts say
// which one binds. Cutting the sentence's coordination away leaves the page lost; cutting the modifier
// away delivers it on `main` too. So the coordination axis was never what refused this log, and pinning
// only the full sentence would pass for the reason #371 warned about.
test("a denial reaches its noun through a noun-modifier, alone or inside a coordination", () => {
  const specks =
    "The page is blank apart from a few scattered specks/dots that appear to be artifacts rather than content. ";
  for (const [axis, log] of [
    // #367's log, verbatim from the run that lost the page. Both axes at once: four coordinated nouns and
    // a modifier on the last of them. `affirmed` was `content is visible` and the reader got
    // `<!-- @page-failed 86: page agent returned no HTML -->` for a white sheet with a few specks.
    ["both axes, #367 verbatim", specks + "No text, images, tables, or other document content is visible."],
    // The modifier axis alone, which is the one that binds: lost on `main` with the list taken out.
    ["modifier alone", specks + "No other document content is visible."],
    ["modifier alone, two words", "The page is blank. No document content is visible."],
    // The coordination axis alone — delivered on `main` and before #379, pinned so that what this change
    // did and did not buy stays legible. It is the same sentence with `document` deleted, and it is
    // already in the #220 list above in the corpus wording it arrived in.
    ["coordination alone", specks + "No text, images, tables, or other content is visible."],
    // `body` is the other spelling of the same axis, and it was lost the same way: `affirmed` was
    // `text is visible`, the list's own verb handed to a noun the `No` had already denied.
    ["modifier alone, `body`", "Page is blank. No body text is visible."],
    ["both axes, `body`", "Page is blank. No headings, captions, or other body text is visible."],
    // And a modifier in a denial written in the other order the corpus uses, where the coordination is of
    // two nouns and the modifier dresses the first.
    ["modifier on the first member", "Page is blank. No document text or figures are present."],
  ] as [string, string][]) {
    assert.equal(declaredBlank({ html: "", log }), true, axis);
  }

  // The whole record for #367's log, because "delivered" is the one thing `declaredBlank` can say and
  // this line is what a run would have shown: an ordinary blank page, declared in prose, with no doubt
  // word picked out of `scattered`/`artifacts`, nothing quoted against it, and no `stated` — the field
  // was not sent, and the page no longer needs it.
  assert.deepEqual(
    blankDeclaration({ html: "", log: specks + "No text, images, tables, or other document content is visible." }),
    { asserted: true, blank: true, vetoes: [] },
  );

  // What the widening must not reach, and the reason it cannot: these words make the walk transparent,
  // they do not start it. Neither is in `TEXT_NOUN`, so a positive sentence built from the same two words
  // still affirms and still refuses the page — which is what makes the modifier axis safe to widen at all.
  for (const [log, affirmed] of [
    ["Page is blank. Body text is visible.", "text is visible"],
    ["Page is blank. Document content is visible at the top.", "content is visible"],
    ["Page is blank. The document contains handwriting.", "contains handwriting"],
    // And a longer walk still ends where it always did — at a `but`, at a determiner, at a verb. Each of
    // these has a negator somewhere behind the affirmed noun and none of them governs it.
    ["Page is blank. No caption, but body text is visible.", "text is visible"],
    ["Page is blank. No page number is visible, and the document heading is visible.", "heading is visible"],
    ["Page is blank. No page number is visible and document headings are visible.", "headings are visible"],
  ] as [string, string][]) {
    assert.equal(declaredBlank({ html: "", log }), false, log);
    assert.equal(blankDeclaration({ html: "", log }).affirmed, affirmed, log);
  }

  // Where the widened walk lands when the FIRST clause has no verb of its own, which #391's review asked
  // to have written down rather than discovered. `negatedInList` steps over these words without requiring
  // a verb, so a denial with no verb in it reaches across the comma and takes the next clause's noun into
  // its list — and the next clause's own `is visible` then belongs to a noun read as denied. The page
  // ships as an accepted declaration, which for a log that named a heading is the fatal direction.
  //
  // It is the branch `No printed text, and handwriting is present.` was pinned on until #436, as the
  // reading chosen when #200's review raised exactly this cost. What `document` and `body` change is how
  // often it is reached, not what it does: the identical sentences built from the modifiers that were
  // already in the set are delivered on `main` too, and the second and third of these are — pinned here so
  // the shape cannot be read as something this change introduced.
  //
  // #436 CHANGED THE FIRST TWO OF THESE, and the change is a contract change rather than a fix to this
  // widening: a verbless denial, one comma, and a name for text behind it with a finite verb of its own is
  // read as two clauses now, whether the joint is `, and` or a bare comma. So the log that names a heading
  // is reported instead of delivered empty. What decided it was not the count but the alternative: the
  // identical sentence with `scrawled` in place of `document` was refused already, so leaving these
  // declared kept the vocabulary deciding which pages survive, which is the defect #436 is about. On the
  // corpus neither reading moves anything — 0 of the 204 declarations on record are this shape.
  //
  // The third still declares, and it is the boundary of the change rather than an exception to it: `page`
  // and `numbers` are modifiers and `page numbers` names no text this pipeline delivers, so there is no
  // affirming noun for the clause read to reach.
  for (const log of [
    "Page is blank. No printed text or images, and body text is visible.",
    "Page is blank. No text or images, document headings are visible.",
  ]) {
    assert.equal(declaredBlank({ html: "", log }), false, log);
  }
  assert.equal(
    declaredBlank({ html: "", log: "Page is blank. No text or images, page numbers are visible." }),
    true,
  );
  // And how narrow that line is, which is the other half of the same decision: one determiner, one `only`
  // or one verb in the second clause and the walk stops before the negator, as it does for every negative
  // above. The pair is what makes the branch legible — the words are the same, the reading is opposite.
  for (const log of [
    "Page is blank. No text or images, the document heading is visible.",
    "Page is blank. No text or images, only document headings are visible.",
  ]) {
    assert.equal(declaredBlank({ html: "", log }), false, log);
  }

  // The four self-contradictions this check exists for, pinned to THIS widening as well as to #194's own
  // test above. They are the property that makes widening the walk the safe fix: the defect is a denial
  // the walk could not reach, and these have no denial in them at all, so nothing added to the list can
  // hand one of them a negator. A later widening that breaks any of these has stopped being this axis.
  for (const log of [
    "Page is blank. There is handwriting on the page.",
    "Page is blank. A heading is visible at the top.",
    "Page is blank. The page contains handwriting.",
    "Page is blank. The scan is blurry. There is handwriting on the page.",
  ]) {
    assert.equal(declaredBlank({ html: "", log }), false, log);
  }
});

test("the blank field can state blankness and cannot deny it", () => {
  // One direction, deliberately. A field that could say `false` would let one wrong token delete a page
  // the prose describes correctly — the same class of loss as the five above, arriving through the
  // remedy for them — so a `false` is read as no answer at all and the prose read decides, exactly as
  // it does for every reply sent before this field existed.
  assert.deepEqual(blankDeclaration({ html: "", log: "Page is blank.", blank: false }), {
    asserted: true,
    blank: true,
    vetoes: [],
  });
  assert.equal("stated" in blankDeclaration({ html: "", log: "Page is blank.", blank: false }), false);
  // The shapes that ARE a statement. `"true"` because a JSON field a prompt asks for comes back as a
  // string often enough to be worth reading (the same reason `extractJson` types it `unknown`), and
  // case and space because that is what a model's string looks like.
  for (const blank of [true, "true", "True", " TRUE "]) {
    const d = blankDeclaration({ html: "", log: "", blank });
    assert.equal(d.blank, true, JSON.stringify(blank));
    assert.equal(d.stated, true, JSON.stringify(blank));
  }
  // And everything else is silence, including the truthy things. `1` and `"yes"` and `"blank"` are not
  // the answer the prompt asks for, and a field read loosely enough to accept them is a field that
  // deletes a page on a typo.
  for (const blank of [false, "false", "yes", 1, "1", {}, [], null, undefined, "blank"]) {
    assert.equal(blankDeclaration({ html: "", log: "", blank }).asserted, false, JSON.stringify(blank) ?? "undefined");
  }
  // A stated blank needs no log at all — the log is where the prose read looks, and the field does not
  // need it. `BLANK_LOG` is still what a prose-only declaration turns on.
  assert.deepEqual(blankDeclaration({ html: "", blank: true }), {
    asserted: true,
    blank: true,
    vetoes: [],
    stated: true,
  });
  assert.equal(blankDeclaration({ html: "", log: "Converted the page." }).asserted, false);
  // And the field cannot declare a page blank that came back with a page on it: `carriesContent` decides
  // that, as it did before, so a reply that says both is not a declaration at all.
  assert.equal(blankDeclaration({ html: "<p>Chapter 1</p>", log: "Page is blank.", blank: true }).asserted, false);
  // A marker and nothing else still is one, which is a third of the declarations in the bench corpus.
  assert.deepEqual(
    blankDeclaration({ html: '<hr role="doc-pagebreak" aria-label="Page 14" id="page-14">', blank: true }),
    { asserted: true, blank: true, vetoes: [], stated: true },
  );
});

test("a stated blank is still refused where the log doubts the reading", () => {
  // The half of the trade the field must NOT buy. A doubt word says the model could not see the page,
  // and a page it could not see is not a page it can state anything about — including that it is empty.
  // #190's four pages are the record of what the veto is for, and the field does not override it.
  for (const [log, vetoes] of [
    ["The page is blank; the scan is too dark to resolve any text.", ["too dark to", "resolve", "dark"]],
    ["The page appears blank, though the scan is too faint to be sure.", ["too faint to", "faint"]],
    ["Page is blank. The image is illegible.", ["illegible"]],
  ] as [string, string[]][]) {
    const d = blankDeclaration({ html: "", log, blank: true });
    assert.equal(d.blank, false, log);
    assert.deepEqual(d.vetoes, vetoes, log);
    // The field it declined to act on is still recorded, so a run can tell this refusal from the same
    // refusal of a reply that never used the field.
    assert.equal(d.stated, true, log);
  }
  // A contradiction is the other answer and behaves the other way, which is the whole of #371's third
  // route: nothing here doubts the reading, so the page is delivered as the field says AND the claim is
  // carried out of this function for the verifier to be shown (`blankContradicted`, extractPage).
  const contradicted = blankDeclaration({
    html: "",
    log: "Page is blank. There is handwriting on the page.",
    blank: true,
  });
  assert.equal(contradicted.blank, true);
  assert.equal(contradicted.affirmed, "there is handwriting");
  assert.equal(contradicted.stated, true);
  // Without the field the same reply is the refusal #194 made it, unchanged.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. There is handwriting on the page." }), false);
});

test("the scan the model was handed is not a thing on the page, whichever word names it", () => {
  // #343's mechanism, and the second half of this branch. The reply describes an IMAGE of a page, so
  // "visible in the image" locates the specks on the scan — but `image` is in `TEXT_NOUN`, because "an
  // image is visible" is a page with a picture on it, and standing in the middle of #343's log it broke
  // the anchor that exempts a marks phrase. The denial's own verb then refused the page: `resolve`.
  //
  // Stripped by the relation and not the phrase: a locative preposition, a definite determiner, and a
  // name for the input. All four of these are the same sentence with one noun changed, and every one of
  // them lost the page.
  for (const log of [
    "Page is blank. Dust/specks visible in the image; no marks that resolve into characters.",
    "Page is blank. Dust/specks visible in the figure; no marks that resolve into characters.",
    "Page is blank. Dust/specks visible in the scan; no marks that resolve into characters.",
    "Page is blank. Dust/specks visible in this photograph; no marks that resolve into characters.",
    // A modifier or two in front of the noun is the same relation.
    "Page is blank. Dust/specks visible in the scanned image; no marks that resolve into characters.",
    // And the substrate the affirmation read already knew about is unaffected: this one was delivered
    // before this branch and still is.
    "Page is blank. Dust/specks visible on the page; no marks that resolve into characters.",
  ]) {
    assert.equal(declaredBlank({ html: "", log }), true, log);
  }
  // An INDEFINITE one is left alone, and stays a refused page even with the field: "in an image" is as
  // likely to be a picture on the paper as the scan, and the definite article is the discriminator the
  // affirmation machinery already uses for exactly this ambiguity (`LOCATIVE_SUBSTRATE` with
  // `definiteBefore`). Pinned as the reading chosen rather than the only defensible one — what it costs
  // is this page, refused, with `resolve` as the reason given, and that reason names the marks anchor
  // rather than anything about the scan.
  const indefinite = "Page is blank. Dust/specks visible in an image; no marks that resolve into characters.";
  assert.deepEqual(blankDeclaration({ html: "", log: indefinite }).vetoes, ["resolve"]);
  assert.equal(declaredBlank({ html: "", log: indefinite, blank: true }), false, "a doubt veto is not overridden");
  // What the strip must not take with it: the veto words. It removes a preposition, a determiner and a
  // noun, and every doubt word in both lists is outside that phrase — so a log that names the input AND
  // says the reading failed still refuses, whether the veto word sits inside the stripped phrase's
  // clause or beside it.
  assert.deepEqual(blankDeclaration({ html: "", log: "Page is blank. Everything in the image is dark." }).vetoes, [
    "dark",
  ]);
  assert.deepEqual(blankDeclaration({ html: "", log: "Page is blank. The text in the image is blurry." }).vetoes, [
    "blurry",
  ]);
});

test("the name of the file is not a thing on the page, and it takes no determiner to say so", () => {
  // The other half of #343's reply, and the half that outlived the fix above. Its `resolve` veto is gone
  // — the test before this one is why — and the sentence it ends with went on refusing it: `Image filename
  // indicates this is page 14 of 25 in document acir.` reads `image` as a name for text, finds the `is` in
  // `this is page 14` five words along, and reports a page the model read correctly as a page that failed
  // (`affirmed: "image filename indicates this is page"`, `runs-extract-kimi100`, kimi-k2.5, 2026-09-03,
  // #429). Two independent faults on one reply, fixed one issue apart.
  //
  // What decided it was the determiner the model happened to omit: every wording with `The` in front was
  // already delivered, because `definiteBefore` reads it. So the fix asks for the noun AFTER the name for
  // the input rather than the word before it — which is the whole shape of #190, #220 and #371's
  // objection, a page lost to a wording rather than to a reading.
  for (const log of [
    "Page 14 is blank. Contains only minimal dust/specks visible in the image; no printed content, no page number, no marks that resolve into characters. Image filename indicates this is page 14 of 25 in document acir.",
    "Page is blank. Image filename indicates this is page 14 of 25.",
    "Page is blank. Image file name indicates this is page 14 of 25.",
    // The wordings that were already delivered, pinned beside them: with a determiner the substrate read
    // above does this, and with no name for the input at all there is no subject here to affirm anything.
    "Page is blank. The image filename indicates this is page 14 of 25.",
    "Page is blank. Filename indicates this is page 14 of 25.",
  ]) {
    assert.equal(declaredBlank({ html: "", log }), true, log);
  }
  // `name` alone is not the file's name: "Image name is printed at the top" is a page with something on
  // it, and a log that means the file says `file` or `filename`. Two words, both closed, for that reason.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. Image name is printed at the top of the sheet." }), false);
  // And only the SUBJECT is skipped. The loop reads on, so a second noun in the same sentence still
  // contradicts the declaration — which is the guarantee `folioAt` is written to keep, and the one that
  // makes this incapable of buying #194's defect.
  const affirming = "Page is blank. Image filename indicates page 14, and a heading is visible.";
  assert.equal(declaredBlank({ html: "", log: affirming }), false);
  assert.equal(blankDeclaration({ html: "", log: affirming }).affirmed, "heading is visible");
  // A doubt word in the same sentence is untouched by any of this: the skip is about which subject
  // affirms, and a page the model could not read is not a page it can call empty.
  assert.deepEqual(blankDeclaration({ html: "", log: "Page is blank. The image filename is illegible." }).vetoes, [
    "illegible",
  ]);
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
    recheckSampleSize: 1,
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
    // already reads (diagnostics `pages_failed`, docs/API.md "Partial documents").
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

test("a blank page spelled in markup is a blank page, and the markup stays out of the document", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The two commonest markup spellings in the corpus, both verbatim. What they used to be:
    // `page_blank` empty, both pages counted as pages that produced markup, and the document
    // carrying `<!-- blank page -->` for one of them and a `doc-pagebreak` anchor for the other —
    // an anchor whose label is the image's position in the file, on a page whose own log says no
    // number is printed (issue #219).
    const marker =
      '{"html": "<hr role=\\"doc-pagebreak\\" aria-label=\\"Page 2\\" id=\\"page-2\\">", ' +
      '"log": "Page 2 appears to be blank. No text, images, or other content is visible. No page number is printed on the page."}';
    const comment = '{"html": "<!-- Page 3: blank page -->", "log": "Page 3 appears to be entirely blank."}';
    const { fragments, failedPages } = await runExtraction(
      makeCtx(dir, events, { render: (o) => (o === 2 ? marker : o === 3 ? comment : good(o)) }),
    );
    assert.deepEqual(failedPages, [], "two blank pages are not two holes");
    assert.deepEqual(of(events, "page_blank").map((e) => e.page), [2, 3]);
    assert.equal(of(events, "page_no_output").length, 0);
    // The same empty fragment an empty `html` produces, so one shape of fragment stands for a blank
    // page however the model wrote it — and nothing a reader receives is lost, because there was
    // nothing in either reply for a reader.
    assert.equal(fragments.find((f) => f.order === 2)!.innerHtml, "");
    assert.equal(fragments.find((f) => f.order === 3)!.innerHtml, "");
    // What was discarded is on the log line, which is the field #219 had to replay 818 replies to
    // reconstruct: a run can now tell the empty `html` spelling from this one with a grep.
    assert.equal(of(events, "page_blank")[0].dropped, '<hr role="doc-pagebreak" aria-label="Page 2" id="page-2">');
    assert.equal(of(events, "page_blank")[1].dropped, "<!-- Page 3: blank page -->");
  });
});

// The page the marker rule and the blank rule used to disagree about: a sheet whose only printed
// content IS its folio. `agents/page.md` prescribes a marker and nothing else for a page that prints
// its number, and forbids transcribing the folio as text — so the correct answer to such a page was a
// marker-only fragment, which carries nothing a reader receives, and where the log named the number
// instead of declaring the page blank the page was reported lost (issue #222). Both halves are now
// answered in one direction: the prompt says a folio-only page IS a blank page, and the log a model
// writes about it — the number named as the one thing on the sheet — no longer contradicts that.
//
// A folio is the one thing a page can bear that this pipeline never delivers, which is why naming it
// is not naming content: the marker its number may live in is discarded here for every declaration,
// and that is the trade `page_blank` above already takes.
test("a page printing nothing but its own number is a blank page, not a lost one", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const marker = '<hr role=\\"doc-pagebreak\\" aria-label=\\"Page 2\\" id=\\"page-2\\">';
    const { fragments, failedPages } = await runExtraction(
      makeCtx(dir, events, {
        render: (o) =>
          o === 2
            ? `{"html": "${marker}", "log": "Page 2 is blank apart from the printed page number."}`
            : good(o),
      }),
    );
    assert.deepEqual(failedPages, [], "a page with nothing on it but its folio is not a hole");
    assert.deepEqual(of(events, "page_blank").map((e) => e.page), [2]);
    assert.equal(of(events, "page_no_output").length, 0);
    // The anchor goes with the rest of the fragment, as it does for every accepted declaration: a
    // marker in front of nothing names a boundary with nothing after it to begin.
    assert.equal(fragments.find((f) => f.order === 2)!.innerHtml, "");
    assert.equal(of(events, "page_blank")[0].dropped, '<hr role="doc-pagebreak" aria-label="Page 2" id="page-2">');
    assert.equal(of(events, "page_blank")[0].log, "Page 2 is blank apart from the printed page number.");
  });
});

test("a markup-spelled declaration the veto refuses is the failed page an empty one already was", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The spelling of the fragment does not decide the routing: this reply says the page could not be
    // read, and a page nobody could read is a page to look at whether the model wrote `""` or a
    // comment. Nine renders in the corpus are refused this way, and #220 is the argument about the
    // wordings — what this pins is that they reach the failure line at all, with the word that did it
    // on it, instead of being delivered as a comment nobody counted.
    const { fragments, failedPages } = await runExtraction(
      makeCtx(dir, events, {
        render: (o) =>
          o === 2
            ? '{"html": "<!-- blank page -->", "log": "Page 2 is blank, but the scan is too dark to be sure."}'
            : good(o),
      }),
    );
    assert.deepEqual(failedPages, [2]);
    assert.equal(of(events, "page_blank").length, 0);
    const refused = of(events, "page_no_output");
    assert.equal(refused.length, 1);
    assert.equal(refused[0].shape, "empty_html", "an envelope that was read perfectly and carried no page");
    assert.deepEqual(refused[0].blank_vetoed, ["too dark to", "dark"]);
    // And the line that has to be triaged carries the markup the veto word was written beside, which
    // is what makes a wording like #220's a grep rather than a corpus replay (#223). `chars` is the
    // whole reply, so it cannot stand in for the fragment.
    assert.equal(refused[0].dropped, "<!-- blank page -->");
    // The message says what arrived. `no HTML` for a reply that sent a comment is the same wrong
    // reading of `empty_html` that sent #190's four pages to be traced by hand, and this string is
    // what `page_extraction_failed.error` carries into the run.
    const error = String(of(events, "page_extraction_failed")[0].error);
    assert.match(error, /no page in 19 chars of HTML/);
    assert.doesNotMatch(error, /no HTML/);
    assert.match(fragments.find((f) => f.order === 2)!.innerHtml, /@page-failed 2:/);
  });
});

test("the same declaration sent as bare markup is `bare_html`, and only `dropped` says it was not a page", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The other half of the shape above, and the reason `bare_html` cannot be read as "a page the
    // parser refused" on this line (#365). This reply is not an envelope at all: `bareHtml` accepts
    // it, so nothing about the parse went wrong, and it reaches the failure line only because what
    // it accepted carries nothing a reader receives. Its remedy is the prompt — exactly the remedy
    // `prose` used to point at for this input — where the OTHER `bare_html` on this line is a whole
    // page behind a fence that never closed. The shape is identical for both, which is why the
    // markup is on the line: `dropped` is what a triage reads, and `chars` is the whole reply.
    const { fragments, failedPages } = await runExtraction(
      makeCtx(dir, events, { render: (o) => (o === 2 ? "<!-- blank page -->" : good(o)) }),
    );
    assert.deepEqual(failedPages, [2]);
    assert.equal(of(events, "page_blank").length, 0, "nothing declared this page blank");
    const lost = of(events, "page_no_output");
    assert.equal(lost.length, 1);
    assert.equal(lost[0].shape, "bare_html");
    assert.equal(lost[0].dropped, "<!-- blank page -->");
    assert.equal(lost[0].chars, "<!-- blank page -->".length);
    // And the page is lost the way any unreadable reply is lost, which is what it was before this
    // label existed: the value renames the finding, it does not route it anywhere new.
    assert.match(fragments.find((f) => f.order === 2)!.innerHtml, /@page-failed 2:/);
  });
});

test("a stated blank the veto refuses says on the failure line that the field was sent", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The one shape the new prompt paragraph forbids in as many words — "never send it for a page you
    // could not read" — so it is the signal that would say the field had gone wrong, and it lands on a
    // line that would otherwise not mention the field at all. `blank_stated` is on all three lines a
    // declaration can reach for that reason: a run that recorded it only where it was BELIEVED could
    // count the field working and never count it failing.
    const { failedPages } = await runExtraction(
      makeCtx(dir, events, {
        render: (o) =>
          o === 2
            ? JSON.stringify({ html: "", log: "The page is blank, though the scan is too dark to be sure.", blank: true })
            : good(o),
      }),
    );
    assert.deepEqual(failedPages, [2], "the field does not override the doubt veto");
    assert.equal(of(events, "page_blank").length, 0);
    const refused = of(events, "page_no_output");
    assert.equal(refused.length, 1);
    assert.equal(refused[0].blank_stated, true, "the field was sent, and this line is where that is visible");
    assert.deepEqual(refused[0].blank_vetoed, ["too dark to", "dark"]);
    // A prose declaration refused the same way carries no such field, so the flag reads as the question
    // it looks like rather than as a default.
    const prose: Event[] = [];
    await withTemp(async (other) =>
      runExtraction(
        makeCtx(other, prose, {
          render: (o) =>
            o === 2 ? JSON.stringify({ html: "", log: "The page is blank, though the scan is too dark to be sure." }) : good(o),
        }),
      ),
    );
    assert.equal("blank_stated" in of(prose, "page_no_output")[0], false);
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

test("a blank declaration is taken at its word, and the page says nothing judged it", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // What issue #294 changed here. The blank claim used to be checked against the source image
    // like any other page, so a page that DID have content on it failed that check and was
    // corrected on the normal path — this test asserted exactly that. The check never once said
    // no: 36 judgements over 9 blank pages of a 100-page corpus, two page-model arms, two
    // commits, all faithful, for $0.0859 an arm spent being told that the empty page the model
    // described is the empty page in the image. So the call is not made any more.
    //
    // The saving is taken on the terms this file cares about, which is what the assertions below
    // are: a page nothing looked at must not read as a page that passed. The verifier is rigged
    // to reject page 2 — the wrong declaration this test used to catch — and page 3, an
    // ordinary page. Only page 3's rejection can happen now.
    const { fragments, failedPages } = await runExtraction(
      makeCtx(dir, events, {
        render: (o) => (o === 2 ? '{"html": "", "log": "This page is blank."}' : good(o)),
        problems: (o) =>
          o === 2
            ? ["The page has a table on it. The output has nothing."]
            : o === 3
              ? ["The second table row is missing."]
              : [],
        // Not keyed to the page: the correction prompt does not carry the image filename, so
        // `orderOf` cannot see which page it is about. Page 3 is the only one corrected.
        correct: () => '{"html": "<table><tr><td>1</td></tr></table>"}',
      }),
    );
    assert.deepEqual(failedPages, []);
    assert.equal(of(events, "page_blank").length, 1, "the claim was made and recorded");
    // The page the verifier would have rejected is now a page nothing judged, and its line says
    // which of the two silences it is: `unjudged` keeps it out of every pass rate computed off
    // these logs (#211), `skipped` says the call was not bought rather than could not be made.
    const blankLine = of(events, "page_verify_ok").find((e) => e.image === "page-002.png")!;
    assert.equal(blankLine.unjudged, true);
    assert.equal(blankLine.skipped, "blank");
    assert.equal(fragments.find((f) => f.order === 2)!.innerHtml, "", "and it ships as the empty page it claimed");
    // The fidelity check is otherwise untouched: page 3 is rejected and corrected exactly as it
    // was, so what changed is one page's verdict and not the pipeline's.
    assert.deepEqual(of(events, "page_verify_failed").map((e) => e.image), ["page-003.png"]);
    assert.deepEqual(of(events, "page_corrected").map((e) => e.page), [3]);
    assert.equal(of(events, "page_corrected")[0].result, "kept");
    // What is given up, plainly: a confident wrong declaration about a page the FILE says nothing
    // about now ships as an empty page, with `page_blank` as the whole of the evidence. The wrong
    // declarations that are still caught are the ones caught for nothing — a log that contradicts
    // its own claim, two tests above, and a page carrying link annotations, in
    // test/blank-verify-skip.test.ts.
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
    // docs/API.md "Quality tally" does not move because of this event.
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

// --- one more draw of a reply that claimed nothing -------------------------------------------
//
// #365 directive 5. The gate is `blankDeclaration`'s `asserted` and not a floor of characters, and
// these four tests are the difference: a reply that ANSWERED the question is never redrawn however
// few characters it carries, and a reply that answered nothing is redrawn once whatever its shape.
// The measurement is in the comment at the branch — 20 replies on 20 distinct pages, 1.05% of the 1,913
// pages drawn at least once and at least 0.48% of individual draws (a bound: `agent_call` carries no
// `step`, so the 4,147 page-agent calls in the phase include corrections). Three survive today's parser
// — five did until #429 widened two of the guard's wordings — and `asserted` is right about all 20 where
// a length redraws all 20 and is right about those same 3.

test("a draw that carried no page is asked once more, and the second draw is the page", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // `render` is a function of the page order rather than a queue, so a redraw that has to SUCCEED
    // has to count its own calls. Page 2 loses the first draw and delivers the second, which is the
    // 47-character `<h1><cite role="doc-bibliography"></cite></h1>` case from the corpus: a page the
    // same model rendered as 7.6-9.8 KB in three other draws.
    const draws: number[] = [];
    const { fragments, failedPages } = await runExtraction(
      makeCtx(dir, events, {
        render: (o) => {
          draws.push(o);
          return o === 2 && draws.filter((d) => d === 2).length === 1 ? '{"html": "", "log": ""}' : good(o);
        },
      }),
    );
    assert.deepEqual(failedPages, [], "the page is not lost, which is the whole point");
    assert.equal(fragments.find((f) => f.order === 2)!.innerHtml, "<p>page 2</p>");
    const again = of(events, "page_redrawn");
    assert.equal(again.length, 1);
    assert.equal(again[0].page, 2);
    assert.equal(again[0].shape, "empty_html", "the draw that lost is on the line, for triage");
    assert.equal(again[0].reextract, undefined, "a first pass, not a feedback re-extraction");
    // The invariant every existing count depends on: `page_no_output` still means "this page was
    // given up on", so nothing that reads it (diagnostics `pages_failed`, `@page-failed`, docs/API.md
    // "Partial documents") starts counting discarded draws.
    assert.equal(of(events, "page_no_output").length, 0);
    assert.equal(of(events, "page_extraction_failed").length, 0);
    assert.equal(draws.filter((d) => d === 2).length, 2, "one extra call, and only one");
  });
});

test("a reply that said the page is blank is not redrawn", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const draws: number[] = [];
    await runExtraction(
      makeCtx(dir, events, {
        render: (o) => {
          draws.push(o);
          return o === 2 ? '{"html": "", "log": "Page 2 is blank."}' : good(o);
        },
      }),
    );
    // Fifteen of the twenty replies that reach the branch are this: a floor of characters redraws
    // every one of them at a full page's price, and each second draw says the same thing again.
    assert.deepEqual(of(events, "page_blank").map((e) => e.page), [2]);
    assert.equal(of(events, "page_redrawn").length, 0);
    assert.equal(draws.filter((d) => d === 2).length, 1);
  });
});

test("a declaration a guard refused is not redrawn either — it is the guard's wording that is wrong", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const draws: number[] = [];
    const { failedPages } = await runExtraction(
      makeCtx(dir, events, {
        render: (o) => {
          draws.push(o);
          return o === 2
            ? '{"html": "<!-- blank page -->", "log": "Page 2 is blank, but the scan is too dark to be sure."}'
            : good(o);
        },
      }),
    );
    // The shape a character floor gets wrong, and the reason this gate cannot be "simplified" into one
    // later. The model answered the question — `asserted` is true — and a doubt word stopped Iris
    // believing the answer, so a redraw would buy a second copy of the same sentence. Two corpus pages
    // used to sit here ("blank apart from minor scanning artifacts (specks and compression noise)" and a
    // log naming the image filename): #429 measured them, every extraction reply on disk for those two
    // images declaring the page blank — 14 on one, 8 on the other from three models, none of the 22
    // carrying content — and widened the guard's wording, which is what a refusal of this shape wants.
    // This test's own wording is one the guard still keeps: "too dark to be sure" is doubt about the
    // reading, not a named mark, and no widening in #220 or #429 reaches it.
    assert.equal(of(events, "page_redrawn").length, 0, "asserted, so nothing here is unanswered");
    assert.equal(draws.filter((d) => d === 2).length, 1);
    assert.deepEqual(failedPages, [2], "and the page is refused exactly as it was before");
    assert.deepEqual(of(events, "page_no_output").map((e) => e.blank_vetoed), [["too dark to", "dark"]]);
  });
});

test("a blank page whose `html` is not a string is redrawn, and the second draw changes nothing", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const draws: number[] = [];
    // The stated limit of the gate, pinned so it cannot be discovered later as a surprise.
    // `blankDeclaration` requires `typeof parsed.html === "string"`, so this reply ANSWERS the question
    // and `asserted` is false anyway: it is redrawn once. Nothing on disk sends it — all 17 honoured
    // declarations in the corpus spell `html` as a string — and it costs one call and no outcome,
    // which is what this asserts. Believing it would change the blank routing (the page would be
    // DELIVERED as blank rather than refused), and that is #219's argument, not this branch's.
    const { failedPages } = await runExtraction(
      makeCtx(dir, events, {
        render: (o) => {
          draws.push(o);
          return o === 2 ? '{"html": null, "log": "Page 2 is blank.", "blank": true}' : good(o);
        },
      }),
    );
    assert.equal(draws.filter((d) => d === 2).length, 2, "redrawn, and only once");
    assert.equal(of(events, "page_redrawn").length, 1);
    assert.equal(of(events, "page_blank").length, 0, "not believed before this change either");
    assert.deepEqual(failedPages, [2], "the outcome is the one it already was");
  });
});

test("a redrawn page's repair lines say which draw they counted", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const draws: number[] = [];
    // `where` attributes a repair count to the call it was billed under, and a redraw makes two
    // `extract` calls for one page. Both draws here carry a `style` attribute, so without the flag an
    // offline census reads two styled pages, or one page styled twice, off a page that was styled once
    // and delivered on its second draw. Nothing in src/ reads these lines, so the flag is for the
    // census, and it is absent on a first draw so a run with no redraw is unchanged.
    const styled = (o: number) => JSON.stringify({ html: `<p style="color:red">page ${o}</p>`, log: "" });
    const { fragments, failedPages } = await runExtraction(
      makeCtx(dir, events, {
        render: (o) => {
          draws.push(o);
          return o === 2 && draws.filter((d) => d === 2).length === 1 ? '{"html": "", "log": ""}' : styled(o);
        },
      }),
    );
    assert.deepEqual(failedPages, []);
    assert.equal(fragments.find((f) => f.order === 2)!.innerHtml, "<p>page 2</p>");
    // Page 2's second draw is flagged; pages 1 and 3 were never redrawn and carry no flag at all.
    assert.deepEqual(
      of(events, "page_style_attributes").map((e) => [e.page, e.where, e.redrawn]),
      [
        [1, "extract", undefined],
        [3, "extract", undefined],
        [2, "extract", true],
      ],
    );
  });
});

test("a page that loses two draws in a row is given up on, in that order", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const draws: number[] = [];
    // A reply the model cut short, twice: the class where a second call can buy nothing but the page
    // is lost either way, so it is spent once and not again.
    const { fragments, failedPages } = await runExtraction(
      makeCtx(dir, events, {
        render: (o) => {
          draws.push(o);
          return o === 2 ? TRUNCATED : good(o);
        },
      }),
    );
    assert.equal(draws.filter((d) => d === 2).length, 2, "never a third");
    assert.deepEqual(failedPages, [2]);
    assert.deepEqual(
      events.filter((e) => e.type === "page_redrawn" || e.type === "page_no_output").map((e) => e.type),
      ["page_redrawn", "page_no_output"],
      "the losing draw is recorded before the page is given up on, not instead of it",
    );
    // Both lines describe the same reply, because both draws were the same reply — and the shape is
    // the one that names the remedy, on the give-up line where every consumer already reads it.
    assert.deepEqual(of(events, "page_redrawn").map((e) => e.shape), ["truncated_envelope"]);
    assert.deepEqual(of(events, "page_no_output").map((e) => e.shape), ["truncated_envelope"]);
    assert.match(fragments.find((f) => f.order === 2)!.innerHtml, /@page-failed 2:/);
  });
});

test("a complement saying the subject holds nothing is a denial, as the negator meaning it is (#442)", () => {
  // A copula has two ways of denying its subject and `NEGATIVE_COMPLEMENT` only knew one of them. `The
  // heading is absent.` says the heading is not there; `The heading is empty.` says the heading holds
  // nothing — which is the same news about text and the opposite reading to the one the walk took, because
  // `heading` names text and nothing denied it, so the sentence came out as an affirmation with the word
  // that denied it quoted inside the evidence (`affirmed: "heading is empty"`). Every such page was a
  // blank page reported as a hole. THE GRID, both axes, because the fix is a claim about the complement and
  // not about the subject: 6 complements x 4 subjects that name text, 0 of 24 declared on base and 24 of 24
  // here, against 4 subjects that name none, 24 of 24 on base and unchanged — so the rows that move are
  // exactly the rows where the subject is what made the sentence read as an affirmation.
  const COMPLEMENTS = ["empty", "blank", "unmarked", "unfilled", "featureless", "void of content"];
  for (const complement of COMPLEMENTS) {
    for (const subject of ["The heading is", "The printed form is", "The typed entry is", "The caption is"]) {
      assert.equal(declaredBlank({ html: "", log: `Page is blank. ${subject} ${complement}.` }), true, complement);
    }
    for (const subject of ["The page is", "The sheet is", "The reverse is", "The area is"]) {
      assert.equal(declaredBlank({ html: "", log: `Page is blank. ${subject} ${complement}.` }), true, complement);
    }
    // THE EXPENSIVE HALF, and the one worth the fix: base declared all 24 of these blank and every one of
    // them says text IS there, so each was a page lost in silence. `not` denied the clause and nothing read
    // what it denied, so the denial cancelled a reading the walk had never taken — the double negative came
    // out as an absence. 24 of 24 on base, 0 of 24 here.
    for (const subject of ["The heading is", "The printed form is", "The typed entry is", "The caption is"]) {
      assert.equal(declaredBlank({ html: "", log: `Page is blank. ${subject} not ${complement}.` }), false, complement);
    }
  }
  // `void` only with its preposition, which is why the list member is `void of` and not `void`. A stamp
  // that "is void" is a mark ON the paper — the word is printed across a cancelled form — so bare `void` is
  // the one member of this vocabulary whose plain reading says something IS there. Unchanged in both
  // directions: the stamp page was reported before this and is reported now, for the same reason.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. The stamp is void." }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. The form is void of content." }), true);
  // Out of scope on purpose, and pinned so that a later widening has to argue with it: marks that cannot be
  // read are not an absence of marks. An illegible heading is a heading, and the page is reported so the
  // text gets another look, which is the whole point of reporting it.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. The heading is illegible." }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. The page is illegible." }), false);
  // WHAT THIS DOES NOT REACH, pinned as the cost rather than left to be re-found: the complement is read at
  // the word right after the verb, so an adverb between them puts it out of reach and the blank page is
  // reported again. Same failure as before the fix, in the cheap direction — attention spent on a page that
  // had nothing on it, not a page lost — and closing it means walking the qualifiers, which is a change to
  // the verb read and not to this vocabulary.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. The heading is completely empty." }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. The heading is entirely blank." }), false);
  // The two reaches #442 asked for by name, because they are the wordings a real form log writes: past a
  // `;`, where the statement boundary does the work, and past a coordination, where the complement is still
  // the word right after the verb and the rest of the clause is somebody else's business.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. The heading is empty; no handwritten entries." }), true);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. The printed form is empty and unused." }), true);
  assert.equal(
    declaredBlank({ html: "", log: "Page is blank. The heading is empty, and no entries were made." }),
    true,
  );
  // And the same limit from the other end: a coordination whose absence word comes SECOND puts it out of
  // reach, exactly as an adverb does, so `is unused and empty` reports where `is empty and unused` declares.
  // One rule, one position, and both of its blind spots cost a glance rather than a page.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. The heading is unused and empty." }), false);
  assert.equal(declaredBlank({ html: "", log: "Page is blank. The printed form is unused and blank." }), false);
  // Not a blind spot but the right answer: `present` says the heading IS there, so a page whose log says
  // that is a page to look at, and the complement read does not overrule the rest of the clause.
  assert.equal(declaredBlank({ html: "", log: "Page is blank. The heading is empty but present." }), false);
  // The other read that had to see this vocabulary, and the check that says what the widening buys. The scan
  // that reads exceptives starts at a denial, so `Blank apart from a caption.` had none and shipped empty on
  // base — a caption lost. Rather than assert a hand-picked answer for each noun, each is paired with the
  // NEGATOR wording that says the same thing, whose answer base already gives and which this change leaves
  // untouched (8 of 8): the complement wording now answers the way the negator wording does, and the nouns
  // themselves are decided where they were already decided. That is why `watermark` reports and `dust` does
  // not — `watermark` is a `TEXT_NOUN` and always was. All 8 complement rows shipped empty on base.
  for (const [negator, complement] of [
    ["No text apart from a caption.", "Blank apart from a caption."],
    ["No text except for handwriting.", "unmarked except for handwriting"],
    ["No text except for a signature.", "Unfilled except for a signature."],
    ["No text apart from a watermark.", "Blank apart from a watermark."],
    ["No text apart from dust.", "Blank apart from dust."],
    ["No text apart from specks.", "Empty except for specks."],
    ["No text except for the folio.", "Empty except for the folio."],
    ["No text except for a printed page number.", "Blank apart from a printed page number."],
  ]) {
    assert.equal(
      declaredBlank({ html: "", log: `Page is blank. ${complement}` }),
      declaredBlank({ html: "", log: `Page is blank. ${negator}` }),
      complement,
    );
  }
  // Where the same word is NOT a complement, because the scan opens at any of these words and whatever
  // names text after it becomes the affirmation — which is how this read could invent a hole. `empty of
  // text` is the complement's own prepositional form and declares; the rest are attributive (`blank form`,
  // `empty rows`) or a second clause, and all of them were declarations on base and still are.
  for (const log of [
    "Page is blank. The heading is empty of text.",
    "Page is blank. The margin is blank of handwriting.",
    "Page is blank. The blank form carries no entries.",
    "Page is blank. The blank areas surround no text.",
    "Page is blank. The empty rows have no printing.",
    "Page is blank. The unmarked field has nothing in it.",
    "Page is blank. Nothing is printed; the form is blank.",
    "Page is blank. The page is blank; the header is empty; nothing else.",
  ]) {
    assert.equal(declaredBlank({ html: "", log }), true, log);
  }
  // And the corpus, so the figures behind the choice are written down where the next change can find them:
  // over 3,747 replies with a parseable log, 153 write one of these complements and 135 of those sit inside
  // a blank declaration, 0 in the negated form — and NO verdict moves, on either read. The corpus cannot
  // tell the two apart, so the wide read was chosen on the 8 rows above and not on a measured rate.
});
