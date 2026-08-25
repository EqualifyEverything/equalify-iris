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
import { runExtraction, stripFences, bareHtml } from "../src/pipeline/extraction.ts";
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
