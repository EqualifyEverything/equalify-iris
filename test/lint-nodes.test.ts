import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { runAxe, exampleNodes, MAX_EXAMPLE_NODES, NODE_HTML_CHARS, type LintResult } from "../src/pipeline/lint.ts";
import { wrapDocument } from "../src/pipeline/assembly.ts";
import { runReview, MAX_EXAMPLES_TOTAL } from "../src/pipeline/review.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// Issue #161: the review loop was told a rule had failed and how many elements it failed on,
// never which ones. axe reports every violation per node — a CSS selector and the element's
// markup — and `runAxe` kept only the length of that array, so the Reader had to find the
// failing element by reading the document for something that might break a rule it had been
// given no example of, and the Copy Editor then had to find it again from whatever the Reader
// wrote about it.
//
// The delivered document behind the issue is the worked example: one `aria-deprecated-role`,
// minor, one node, in a 140,003-character document carrying 26 elements with a `role` on them.
// Two of the three deprecated roles in all of ARIA differ from a valid neighbour by one
// character (`doc-endnote` beside `doc-endnotes`), so knowing that one of 26 roles is deprecated
// is not an instruction. Knowing which element it is on is a one-character edit.

function violation(lint: LintResult, id: string) {
  const v = (lint.violations ?? []).find((x) => x.id === id);
  assert.ok(v, `expected a ${id} violation; got ${(lint.violations ?? []).map((x) => x.id).join(", ")}`);
  return v;
}

// What axe actually hands over, run rather than asserted from memory: everything the bounds in
// `lint.ts` are chosen for is a property of this version of axe in this environment, and a
// version bump can move any of it. Both dependencies are pinned to exact versions for that
// reason (see the comment above `runAxe`), so this test is what says the pin still holds.
test("each violation carries the elements it was found on", async () => {
  const lint = await runAxe(
    wrapDocument(
      `<p><img src="chart.png"></p>\n` +
        `<h1>Report</h1>\n<h4 id="skipped">Detail</h4>\n` +
        `<ol role="doc-endnotes"><li role="doc-endnote">Note.</li></ol>\n` +
        `<p><a href="#ref"></a></p>`,
    ),
  );
  assert.equal(lint.ok, false);

  // The rule from the delivered document, and the whole of the issue in one row: the example
  // names the element, and the element is the one whose role is deprecated rather than one of
  // its two valid neighbours.
  const deprecated = violation(lint, "aria-deprecated-role");
  assert.equal(deprecated.nodes, 1);
  assert.equal(deprecated.examples?.length, 1);
  assert.match(deprecated.examples![0]!.html, /role="doc-endnote"/);
  assert.doesNotMatch(deprecated.examples![0]!.html, /doc-endnotes/);

  // An id in the document is what axe builds the selector out of when there is one, and it is
  // the selector that survives a rewrite of the markup around it.
  assert.equal(violation(lint, "heading-order").examples?.[0]?.target, "#skipped");

  // Every example says both things, for every rule: where, and what.
  for (const v of lint.violations!) {
    assert.ok(v.examples && v.examples.length > 0, `${v.id} reported no example element`);
    for (const n of v.examples) {
      assert.ok(n.target.length > 0, `${v.id} reported an element with no selector`);
      assert.match(n.html, /^</, `${v.id}'s markup excerpt should start at the element's tag`);
      // One frameless document, so one selector per element. `selector()` joins a frame path
      // with " >> " for the shape axe's type allows and this environment never produces; the
      // day it does, this row is what says the prompt started carrying a different thing.
      assert.doesNotMatch(n.target, / >> /, `${v.id}: a frame path in a document with no frames`);
    }
  }
});

// The selectors are only worth sending if they resolve, and the open question in #161 was
// whether they do: axe computes them against the document it was handed, and the review loop
// lints `wrapDocument(body)` fresh each round. So the answer is per round — which is the round
// that hands the same body to the editor. This runs each selector back over that document.
test("every selector resolves to exactly one element of the document that was linted", async () => {
  // Positional selectors are the case worth pinning, so the body is deliberately made of
  // elements nothing distinguishes: no ids, no attributes, same tag, same content.
  const body =
    `<section><p><img src="a.png"></p></section>\n`.repeat(4) +
    `<h1>A</h1><h4>B</h4>\n<p><a href="#x"></a></p>`;
  const html = wrapDocument(body);
  const lint = await runAxe(html);
  const dom = new JSDOM(html);
  try {
    const targets = (lint.violations ?? []).flatMap((v) => (v.examples ?? []).map((n) => n.target));
    assert.ok(targets.length >= 4, "the body must actually produce several violations");
    for (const t of targets) {
      assert.equal(
        dom.window.document.querySelectorAll(t).length,
        1,
        `selector ${t} does not name exactly one element of the linted document`,
      );
    }
    // And at least one of them is positional, so the row above is not passing on ids alone.
    assert.ok(
      targets.some((t) => /nth-child/.test(t)),
      "expected axe to fall back to a positional selector where nothing else distinguishes an element",
    );
  } finally {
    dom.window.close();
  }
});

// Both bounds are bounds on a PROMPT: `lintSummary` puts this text in every Reader chunk of
// every round, so a rule with hundreds of nodes must not crowd out the document it is about.
test("a rule with many nodes is sampled, and its count still counts all of them", async () => {
  const lint = await runAxe(wrapDocument(Array.from({ length: 12 }, (_, i) => `<p><img src="a${i}.png"></p>`).join("\n")));
  const images = violation(lint, "image-alt");
  // The count is the number `/v1/quality` records per rule (orchestrator.ts writes it as
  // `count` in `run_signals`), so it is the whole count and not the number of examples.
  assert.equal(images.nodes, 12);
  assert.equal(images.examples?.length, MAX_EXAMPLE_NODES);
});

test("an element too long to send is cut, and one written over several lines is folded", async () => {
  // 40 attributes, each of which axe keeps about 20 characters of: measured at 279 characters
  // of start tag, and nothing bounds how many attributes a page agent can write.
  const attrs = Array.from({ length: 40 }, (_, i) => `data-field-number-${i}="value-${i}"`).join(" ");
  const long = violation(await runAxe(wrapDocument(`<img ${attrs}>`)), "image-alt").examples![0]!;
  assert.equal(long.html.length, NODE_HTML_CHARS + 1, "the excerpt is the bound plus the character that says so");
  assert.match(long.html, /…$/);

  // axe's `html` keeps the document's own newlines, and each example is one line of a prompt
  // list. Folded, so a multi-line element cannot break the list it is an item of.
  const wrapped = violation(await runAxe(wrapDocument(`<p>\n  <a href="#q">\n\n  </a>\n</p>`)), "link-name");
  assert.doesNotMatch(wrapped.examples![0]!.html, /[\n\r]/);
  assert.equal(wrapped.examples![0]!.html, `<a href="#q"> </a>`);
});

// The node fields cross a realm boundary out of jsdom, so they are read as `unknown` and
// narrowed — and what narrowing throws away must not leave a line behind. None of these shapes
// is reachable through `runAxe` here (the test above measures that every real node has both
// halves), which is why they are handed over directly rather than provoked.
test("a node that cannot say which element it is does not become an empty line", () => {
  // Neither half: a bullet reading "    - `` — ``" would tell the Reader an element exists and
  // refuse to name it, which is worse than the count it already had.
  assert.deepEqual(exampleNodes([{ target: [], html: "" }, { target: undefined }]), []);
  // One half is enough to be worth sending, and either half can be the one that is missing.
  assert.deepEqual(exampleNodes([{ target: ["#a"], html: 42 }]), [{ target: "#a", html: "" }]);
  assert.deepEqual(exampleNodes([{ html: "<p id=\"a\">" }]), [{ target: "", html: `<p id="a">` }]);
  // Skipped in place rather than shortening the sample: three usable nodes are still three.
  assert.equal(
    exampleNodes([{}, { target: ["#a"] }, { target: null }, { target: ["#b"] }, { target: ["#c"] }, { target: ["#d"] }])
      .length,
    MAX_EXAMPLE_NODES,
  );
  // The frame path axe's type allows and this environment never produces: joined, so it reaches
  // a prompt as a path a human can read rather than as `[object Array]`.
  assert.deepEqual(exampleNodes([{ target: ["#frame", ["#inner", "#el"]], html: "<p>" }]), [
    { target: "#frame >> #inner >> #el", html: "<p>" },
  ]);
});

// --- the seam between the code and the prompt --------------------------------

// What the Reader is actually sent. `lintSummary` is private to review.ts and the thing worth
// asserting is not its return value but that the lint reaches the prompt, so this goes through
// `runReview` the way the heading-list test does.
async function readerPrompts(lint: LintResult, body = "<h1>Report</h1>"): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "iris-lint-nodes-"));
  try {
    const prompts: string[] = [];
    const ctx = {
      sessionId: "ses_test",
      images: [],
      maxReviewIterations: 0,
      extractionConcurrency: 4,
      paths: {
        agentsDir: join(dir, "agents"),
        tmpAgentsDir: () => join(dir, "tmp-agents"),
        agentMemory: () => join(dir, "memory", "page.json"),
      } as unknown as Paths,
      router: {
        complete: async (agent: string, _cap: string, messages: { content: string }[]) => {
          if (agent === "reader") prompts.push(messages.map((m) => m.content).join("\n"));
          return { text: JSON.stringify({ issues: [] }) };
        },
      },
      log: { event: () => {}, agentCall: () => {} },
    } as unknown as PipelineContext;
    await runReview(ctx, { body, lint });
    return prompts;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function readerPrompt(lint: LintResult): Promise<string> {
  const prompts = await readerPrompts(lint);
  assert.equal(prompts.length, 1, "this body should be one chunk");
  return prompts[0]!;
}

const DEPRECATED_ROLE = {
  id: "aria-deprecated-role",
  impact: "minor",
  description: "Ensure elements do not use deprecated roles",
  nodes: 1,
  examples: [{ target: "ol > li", html: `<li role="doc-endnote">` }],
};

test("the Reader is given the elements, told what they are, and told to pass them on", async () => {
  const prompt = await readerPrompt({
    ok: false,
    violations: [
      DEPRECATED_ROLE,
      {
        id: "image-alt",
        impact: "critical",
        description: "Ensure <img> elements have alternate text",
        nodes: 12,
        examples: [
          { target: "section:nth-child(2) > p > img", html: `<img src="a1.png">` },
          { target: "section:nth-child(3) > p > img", html: `<img src="a2.png">` },
          { target: "section:nth-child(4) > p > img", html: `<img src="a3.png">` },
        ],
      },
    ],
  });

  // The line the loop had before is unchanged, down to the count in brackets: it is what the
  // whole rule amounts to, and the examples hang off it rather than replacing it.
  assert.match(prompt, /- aria-deprecated-role \(minor\): Ensure elements do not use deprecated roles \[1 nodes\]/);
  assert.match(prompt, /    - `ol > li` — <li role="doc-endnote">/);
  assert.match(prompt, /    - `section:nth-child\(3\) > p > img` — <img src="a2.png">/);

  // A sample has to say it is one. Three selectors under a `[12 nodes]` count read as an
  // enumeration otherwise, and the editor is sent to three of twelve places.
  assert.match(prompt, /\[12 nodes\] — showing 3 of 12:/);
  // A rule whose examples ARE all of it says nothing of the kind.
  assert.doesNotMatch(prompt, /\[1 nodes\] — showing/);

  // The note, and the three things about these selectors a Reader cannot infer from one: what
  // they are against, that a listed element may be outside its own window, and that quoting one
  // is the only way it reaches the editor — which is never shown the lint at all.
  assert.match(prompt, /CSS selector/);
  assert.match(prompt, /may sit outside your window/);
  assert.match(prompt, /the Copy Editor is not shown these results/);
});

// The lint is one verdict on the whole document and the Reader is called per window, so the
// elements are a whole-document input in a per-chunk prompt — the shape `duplicateHeadings` is
// already handled for, and for the same reason: the chunk calls are independent, nothing
// downstream dedupes their text (`dedupeNoContentIssues` keys on no-content pages, and reports
// from calls that never saw each other are worded differently anyway), so a note telling every
// call to report an element outside its own window puts N copies of one defect in the editor's
// issue list and N entries in the delivered @unresolved comment (#192, by another path).
test("the offending elements are given to one chunk, however many the body takes", async () => {
  // Two same-worded <h2>s are not the point here, but the filler is: 40k of it puts the body
  // over CHUNK_BUDGET (24000), which is roughly a five-page scan and the ordinary case.
  const filler = "<p>Fill the hopper and press start.</p>".repeat(1100);
  const prompts = await readerPrompts(
    { ok: false, violations: [DEPRECATED_ROLE] },
    `<h1>Report</h1>${filler}<p>end</p>`,
  );
  assert.ok(prompts.length > 1, "the body must actually span more than one chunk to prove anything");

  const withElements = prompts.filter((p) => /`ol > li`/.test(p));
  assert.equal(withElements.length, 1, "the elements reached more than one independent call");
  assert.equal(withElements[0], prompts[0], "and it should be the first chunk, as the heading list is");
  assert.equal(prompts.filter((p) => /CSS selector/.test(p)).length, 1, "as did the note about them");

  // What the other chunks keep is what every chunk had before this section listed elements at
  // all: the rule, its impact, its description, its count.
  for (const p of prompts) {
    assert.match(p, /- aria-deprecated-role \(minor\): Ensure elements do not use deprecated roles \[1 nodes\]/);
  }
});

test("a document failing many rules does not fill the window with selectors", async () => {
  // Twelve rules failing three nodes each is 36 elements; ~60 rules are enabled, so this is
  // well inside what one badly extracted scan can produce.
  const violations = Array.from({ length: 12 }, (_, r) => ({
    id: `rule-${r}`,
    impact: "serious",
    description: `Ensure rule ${r}`,
    nodes: 3,
    examples: Array.from({ length: 3 }, (_, n) => ({ target: `#r${r}n${n}`, html: `<p id="r${r}n${n}">` })),
  }));
  const prompt = await readerPrompt({ ok: false, violations });

  const listed = (prompt.match(/^    - `#r/gm) ?? []).length;
  assert.equal(listed, MAX_EXAMPLES_TOTAL, "the whole section is bounded, not just each rule");
  // Spent in the order the rules are listed, so the last rules are the ones without examples.
  assert.match(prompt, /- rule-0 \(serious\): Ensure rule 0 \[3 nodes\]:/);
  assert.doesNotMatch(prompt, /#r11n0/);
  // And what was cut is said. A list that stops without saying so reads as the rules after it
  // having had nothing to point at, which is the opposite of what is true of them.
  assert.match(prompt, /No elements are listed for the last 4 rules above/);
  assert.match(prompt, new RegExp(`had already reached ${MAX_EXAMPLES_TOTAL}`));

  // Every rule still has its own line and its own count, listed or not.
  for (let r = 0; r < 12; r++) assert.match(prompt, new RegExp(`- rule-${r} \\(serious\\)`));
});

test("a lint with nothing to point at reads exactly as it did before", async () => {
  // A violation carrying no examples — a hand-built one, a stored one from before #161 — is
  // rendered as the single line it always was, with no paragraph introducing elements that are
  // not listed.
  const bare = await readerPrompt({
    ok: false,
    violations: [{ id: "heading-order", impact: "moderate", description: "Ensure the order of headings", nodes: 2 }],
  });
  assert.match(bare, /- heading-order \(moderate\): Ensure the order of headings \[2 nodes\]/);
  assert.doesNotMatch(bare, /CSS selector/);
  assert.doesNotMatch(bare, /— showing/);

  // And the two non-violation cases are untouched: a clean document, and one the gate could not
  // run on — which is told it was not checked rather than shown an empty list (#164).
  assert.match(await readerPrompt({ ok: true, violations: [] }), /axe-core: no violations/);
  const noVerdict = await readerPrompt({ ok: false, error: "axe-core could not run: boom", errorWhere: "inject" });
  assert.match(noVerdict, /NOTHING in this document has been checked/);
  assert.doesNotMatch(noVerdict, /CSS selector/);
});
