// A lint that threw used to be recorded as a lint that passed: `lint_ok: true,
// violations: 0` beside a `lint_error` (#164). That is the same pair a flawless document
// produces, so the review loop got no violations to act on, the document shipped as clean,
// and the deployment-wide tally counted it among the documents its rules had been measured
// on. This file pins the three halves of the fix — the verdict, the log line, the delivered
// document.
//
// The failure it was written against was a property of the DOCUMENT, not of the environment,
// and one document in four hit it on a real bench round. jsdom's selector engine (nwsapi)
// compiles a selector into JavaScript source and evaluates it with `Function`, whose body is
// strict; it converts the CSS escapes in an attribute VALUE but splices an attribute NAME in
// raw. axe escapes the names it builds selectors from, correctly — `1x` becomes `\31 x` — so
// the source reaches V8 as `e.getAttribute("\31 x")`, where `\31` is an octal escape and a
// SyntaxError in strict mode. The whole rule set died with it: one such attribute anywhere in
// a 25-page document and there was no verdict on any of it.
//
// An attribute name beginning with a digit is not exotic. The document that provoked #164 had
// leaked JSON in its body — `aria-label=\"Footnote 1\"` as text — which the HTML parser
// tokenises into an attribute named `1\"`, several dozen times over.
//
// #257 took that failure away: `runAxe` now removes attributes whose names no valid markup
// produces from its own copy of the document, and counts them, so the fixture below LINTS.
// Two consequences for this file, and both are deliberate. Its fixture is now a regression
// test for the strip and a watch on the jsdom bug underneath it — read the first two tests
// that way rather than deleting them. And the reporting the rest of it pins is still what has
// to happen for whatever fails next, so it is founded on a hand-built failure (unconditional,
// since every consumer here takes a `LintResult`) plus the deep-nesting document, which is the
// only failure this environment can still provoke through `runAxe` and provokes it only when
// the stack has the headroom to notice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM, VirtualConsole } from "jsdom";
import { runAxe, lintErrorFields, type LintResult } from "../src/pipeline/lint.ts";
import { runAssembly, wrapDocument } from "../src/pipeline/assembly.ts";
import { runReview } from "../src/pipeline/review.ts";
import type { Fragment } from "../src/pipeline/fragment.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// The minimal shape, and every part of it is load-bearing. `1x=""` is the attribute whose
// escaped name cannot be compiled. It has to sit on an element axe computes a selector for,
// which is why it is on a link (axe builds selectors for passing nodes too, and a link is in
// several rules' results). It has to repeat, because a feature axe finds on exactly one
// element is used alone and a lone `[\31 x=""]` is not the selector that fails; two of them
// among commoner links is what sends axe down `getThreeLeastCommonFeatures` and builds the
// compound attribute selector. Reduced from the real document by removing everything that
// did not stop it failing.
const MARKED = `<p>See <a href="#fn-1" 1x="">1</a></p>`;
const PLAIN = `<p>See <a href="#real">the note</a></p>`;
const UNCOMPILABLE = `<h1>Report</h1>${MARKED.repeat(2)}${PLAIN.repeat(3)}<p id="fn-1">A note.</p>`;
// The same document with the one attribute removed. It was here to keep the claim honest —
// what broke the gate was that attribute and not the shape around it — and it is now the
// control the strip is measured against: the two documents have to lint the same way.
const COMPILABLE = UNCOMPILABLE.replaceAll(` 1x=""`, "");

// Deep enough that walking the tree overflows the stack, and the one failure `runAxe` can
// still be made to return in this environment. Every threshold around it moves with the stack
// the caller already spent, so the tests that use it return instead of asserting when axe
// managed to run — see test/lint-error-detail.test.ts, which owns this fixture's own fields.
const DEEP = `${"<div>".repeat(6000)}<p>Buried</p>`;

// A failure as `runAxe` returns one, built rather than provoked, so that everything downstream
// of it can be asserted unconditionally. It is the #164 document's failure, verbatim; the test
// below pins its shape against a real one so it cannot drift into a shape nothing produces.
const UNAVAILABLE: LintResult = {
  ok: false,
  error: "axe-core could not run in this environment: Octal escape sequences are not allowed in strict mode.",
  errorWhere: "run",
  errorName: "SyntaxError",
  errorStack:
    "SyntaxError: Octal escape sequences are not allowed in strict mode\n" +
    "    at new Function (<anonymous>)\n" +
    "    at node_modules/nwsapi/src/nwsapi.js:1878:22",
};

function frag(order: number, innerHtml: string): Fragment {
  return { image: `page-00${order}.png`, order, agent: "page.md", region: "page", innerHtml, edges: [], log: "" };
}

function recorder(): { ctx: PipelineContext; events: { type: string; data: Record<string, unknown> }[] } {
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const ctx = {
    log: { event: (type: string, data: Record<string, unknown> = {}) => events.push({ type, data }) },
  } as unknown as PipelineContext;
  return { ctx, events };
}

test("the document that used to take the gate offline now lints, and says what it carried", async () => {
  const lint = await runAxe(wrapDocument(UNCOMPILABLE));
  // This returned `error: "axe-core could not run in this environment: Octal escape sequences
  // are not allowed in strict mode.", errorWhere: "run", errorName: "SyntaxError"` for every
  // commit up to #257 — a document with nothing wrong with it, on which nothing could be
  // found. If this assertion starts failing, the strip in `runAxe` has stopped reaching
  // something it used to reach; the fixture is the reproduction and is worth keeping either way.
  assert.equal(lint.error, undefined, "the octal-escape failure is back on the document it was fixed for");
  assert.deepEqual(lint.violations, [], "the gate ran but on a different document than the one handed to it");
  // Both `1x=""` attributes, counted rather than silently dropped: the debris is evidence of a
  // leak one stage earlier and the count is the only symptom it has. Pinned in full, with the
  // names and the boundary of what the strip touches, in test/lint-malformed-attributes.test.ts.
  assert.equal(lint.malformedAttributes, 2);

  const clean = await runAxe(wrapDocument(COMPILABLE));
  assert.deepEqual(clean.violations, [], "the same document without that attribute lints differently");
  assert.equal(clean.malformedAttributes, undefined, "an attribute that is not there was counted");
});

test("what the selector engine cannot compile, at the layer that cannot compile it", () => {
  // One layer below axe, so a jsdom bump can be judged without reasoning about which selector
  // axe happened to build — and, since #257, the only place the bug is still observable at all.
  // That is the reason to keep it: the strip above is a workaround, and a workaround with no
  // test on the thing it works around is a workaround nobody can ever retire.
  const dom = new JSDOM(`<!DOCTYPE html><html><body><p id="9a" class="9c" rel="9r" 1x="">hi</p></body></html>`, {
    virtualConsole: new VirtualConsole(),
  });
  const doc = dom.window.document;
  assert.deepEqual(
    [...doc.querySelector("p")!.attributes].map((a) => a.name),
    ["id", "class", "rel", "1x"],
    "the HTML parser rejected an attribute name beginning with a digit, so this fixture is moot",
  );
  // `\31 x` is what CSS escaping of the attribute name `1x` produces — correct CSS, and the
  // only way to write that name in a selector.
  assert.throws(
    () => doc.querySelectorAll(`[\\31 x]`),
    /Octal escape sequences are not allowed in strict mode/,
    "jsdom now compiles this selector — the bug this fixture exists for is fixed",
  );
  // And the contrast that says it is the ESCAPED NAME and nothing else, which is what makes a
  // strip aimed at names sufficient rather than merely helpful. A digit-leading id, class or
  // attribute VALUE needs the same `\39` escape and compiles fine — nwsapi converts the escapes
  // in those and splices only the name in raw — so no document axe can build a selector for
  // survives the strip and still kills the run.
  for (const selector of [`#\\39 a`, `.\\39 c`, `[rel=\\39 r]`, `[rel="9r"]`]) {
    assert.equal(doc.querySelectorAll(selector).length, 1, `${selector} no longer compiles either`);
  }
  // The same name reached through the DOM rather than through a selector is unremarkable, which
  // is why the parser keeps it and the document ships with it.
  assert.equal(doc.querySelector("p")!.getAttribute("1x"), "");
});

test("the failure the rest of this file is built on is the one runAxe returns", async () => {
  // `UNAVAILABLE` is hand-built so that every consumer below can be asserted unconditionally,
  // and a hand-built fixture is worth exactly as much as its fidelity. So it is compared,
  // field for field, against a failure a real document provokes.
  const real = await runAxe(wrapDocument(DEEP));
  if (real.error === undefined) return; // axe had the stack to finish; nothing degraded, nothing to compare
  assert.deepEqual(
    Object.keys(real).sort(),
    Object.keys(UNAVAILABLE).sort(),
    "a real failure carries fields the fixture does not, so the tests below are asserting a shape nothing produces",
  );
  // The pair #164 was filed about, both halves inverted, on the real thing. `ok: false` because
  // a gate that did not run is not a gate the document passed; `violations` absent because the
  // number of violations in a check that did not happen is unknown, and `[]` is a claim that
  // there were none — one every caller that maps over the list was making on its behalf.
  assert.equal(real.ok, false, "a lint that threw still reports the document as having passed");
  assert.equal(real.violations, undefined, "a check that did not happen still reports a count");
  assert.equal(real.errorWhere, "run", "axe's own source loaded; it is this document that killed the run");
});

test("the assembly log line says the gate did not run instead of reporting zero violations", async () => {
  const { ctx, events } = recorder();
  const { lint } = await runAssembly(ctx, [frag(1, DEEP), frag(2, `<p>Page two.</p>`)]);
  const logged = events.find((e) => e.type === "assembly")!;
  if (lint.error !== undefined) {
    assert.equal(logged.data.lint_ok, false);
    assert.ok(
      !("violations" in logged.data),
      `the line still carries a violation count: ${JSON.stringify(logged.data)}`,
    );
    assert.equal(logged.data.lint_error_where, "run");
    assert.equal(logged.data.lint_error_name, "RangeError");
  }

  // The ordinary line, for contrast, and unconditional: the count is present when it means
  // something, so its absence above is a signal rather than a field nobody logs.
  const { ctx: ctx2, events: events2 } = recorder();
  await runAssembly(ctx2, [frag(1, COMPILABLE)]);
  const ok = events2.find((e) => e.type === "assembly")!;
  assert.equal(ok.data.lint_ok, true);
  assert.equal(ok.data.violations, 0);
});

test("every place that lints reports the failure with the same fields", async () => {
  // Three modules lint a body — `runAssembly`, the review loop's re-lint of a corrected
  // body, and the feedback re-run that skips extraction and re-lints the body it saved —
  // and a failure that reads differently depending on which one reported it is a failure
  // nobody greps for. They share these fields; this is the shape all three emit.
  assert.deepEqual(Object.keys(lintErrorFields(UNAVAILABLE)).sort(), [
    "lint_error",
    "lint_error_name",
    "lint_error_stack",
    "lint_error_where",
  ]);
  // Empty rather than a set of nulls when the lint ran, so it can be spread into any log
  // line unconditionally and a present field always means something (the same convention
  // the `assembly` line's omitted `violations` follows).
  assert.deepEqual(lintErrorFields(await runAxe(wrapDocument(COMPILABLE))), {});

  // The third caller — `orchestrator.ts`'s `stage: "feedback_relint"` — has no unit test of
  // its own: reaching it means a whole `runPipeline` with a store, a config and saved
  // fragments, which is `test/e2e.sh`'s job. What is asserted here is the part that could
  // silently differ between the three, which is the fields.
});

test("the delivered document says it was never checked", () => {
  const html = wrapDocument(`<h1>Report</h1>`, {
    lintUnavailable: "axe-core could not run in this environment: Octal escape sequences are not allowed.",
  });
  assert.match(html, /@lint-unavailable/);
  assert.match(html, /NOT been checked for accessibility violations/);
  assert.match(html, /Octal escape sequences/, "the reason is carried, not only the fact");
  // Placed like the other three wrapper statements: outside <main>, so it is not content,
  // and after the body, so a later feedback round's editor is never handed it to fix.
  assert.ok(html.indexOf("@lint-unavailable") > html.indexOf("</main>"));
  // And absent when the gate ran, whatever it found: a document that carries this comment on
  // every run is a document where it means nothing.
  assert.doesNotMatch(wrapDocument(`<h1>Report</h1>`), /@lint-unavailable/);
});

test("an axe message cannot close the comment that reports it", () => {
  // The only text in `wrapDocument` that comes from outside the function: `runAxe` builds it
  // from an Error's `message`, and an error message can contain anything. A `-->` in it would
  // end the comment early and put the rest of it — and the document's own `</body>` — in a
  // place the parser reads as content; a newline would break the shape a reader scans for.
  const html = wrapDocument(`<h1>R</h1>`, { lintUnavailable: `broke --> here\nand on a second line` });
  assert.match(html, /broke — here and on a second line/, "the message was not folded onto one line");
  const [comment] = html.slice(html.indexOf("@lint-unavailable")).split("-->");
  assert.ok(comment.includes("second line"), "the message closed the comment before its own last line");
  // Parsed rather than pattern-matched, because what matters is what a browser makes of it:
  // one comment, and a body containing nothing but the document.
  const body = new JSDOM(html, { virtualConsole: new VirtualConsole() }).window.document.body;
  assert.deepEqual(
    [...body.childNodes].filter((n) => n.nodeType === 3 && n.textContent!.trim()).map((n) => n.textContent),
    [],
    "part of the comment was parsed as text in the body",
  );

  // And bounded, because an error's message has no length limit and this one is quoted whole.
  const long = wrapDocument(`<h1>R</h1>`, { lintUnavailable: "x".repeat(5_000) });
  assert.ok(long.length < 2_000, `a single error message grew the document to ${long.length} bytes`);
});

// --- the review loop ---

const PAGES = [{ order: 1, innerHtml: "<h1>Report</h1>" }];

// By default a Reader that finds nothing, so the loop takes the clean return — the path where
// the absence of a verdict matters most, because that return means "looked again, nothing
// left". `editorReturns` opts into one correction round instead: the Reader reports an issue
// and the editor answers with that body.
function reviewCtx(editorReturns?: string): {
  ctx: PipelineContext;
  prompts: string[];
  events: { type: string; data: Record<string, unknown> }[];
} {
  const prompts: string[] = [];
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const issues = editorReturns
    ? [{ issue: "a table has no headers", severity: "high", suggested_action: "add <th>", pages: [1] }]
    : [];
  const ctx = {
    sessionId: "ses_test",
    images: [],
    maxReviewIterations: 1,
    extractionConcurrency: 4,
    paths: { agentsDir: "agents", tmpAgentsDir: () => "tmp", agentMemory: () => "memory.json" } as unknown as Paths,
    router: {
      complete: async (agent: string, _cap: string, messages: { content?: unknown }[]) => {
        prompts.push(JSON.stringify(messages));
        if (agent === "copy_editor") return { text: JSON.stringify({ html: editorReturns }) };
        return { text: JSON.stringify({ issues }) };
      },
    },
    log: {
      event: (type: string, data: Record<string, unknown> = {}) => events.push({ type, data }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
  return { ctx, prompts, events };
}

test("the Reader is told the document was not checked, not handed an empty result", async () => {
  const { ctx, prompts } = reviewCtx();
  const result = await runReview(ctx, { body: `<h1>Report</h1>`, lint: UNAVAILABLE, pages: PAGES });

  // Under a "## axe-core lint" heading, in a prompt that says the review is against "the
  // axe-core lint results provided", an error message alone reads as a section with nothing
  // in it — i.e. as a clean bill of health from the one check the Reader cannot perform
  // itself. So it is told the opposite in as many words.
  const prompt = prompts.join("\n");
  assert.match(prompt, /NOTHING in this document has been checked/);
  assert.match(prompt, /Treat this section as absent, not as empty/);

  // And the document the user receives says the same thing. This is the clean return: no
  // unresolved issues, nothing left for an editor — and no machine verdict behind it.
  assert.deepEqual(result.unresolved, []);
  assert.match(result.html, /@lint-unavailable/);
});

test("a document whose lint ran carries no such statement", async () => {
  const { ctx, prompts } = reviewCtx();
  const lint = await runAxe(wrapDocument(COMPILABLE));
  const result = await runReview(ctx, { body: `<h1>Report</h1>`, lint, pages: PAGES });
  assert.match(prompts.join("\n"), /axe-core: no violations/);
  assert.doesNotMatch(result.html, /@lint-unavailable/);
});

test("a lint the correction round broke is logged, where nothing used to be", async () => {
  // The re-lint inside the loop is the gate on the body that actually SHIPS — `assembly`
  // reports the lint of the body before any correction — and its failure was logged nowhere
  // at all. An editor can produce a body axe cannot examine, which is what this stands in
  // for: it is handed a clean body and answers with one that degrades the gate. Guarded on
  // the same fixture's own behaviour, because the failure is a stack overflow and how much
  // stack is left depends on the caller.
  if ((await runAxe(wrapDocument(DEEP))).error === undefined) return;
  const { ctx, events } = reviewCtx(DEEP);
  const clean = await runAxe(wrapDocument(COMPILABLE));
  assert.equal(clean.error, undefined, "the body entering the round lints fine");

  const result = await runReview(ctx, { body: COMPILABLE, lint: clean, pages: PAGES });

  const logged = events.filter((e) => e.type === "lint_unavailable");
  assert.equal(logged.length, 1, `expected one lint_unavailable, got ${events.map((e) => e.type).join(", ")}`);
  // Per iteration, because which round broke it is the next question a person asks — and with
  // the same fields as the `assembly` line, so both failures read the same way in a run log.
  assert.equal(logged[0].data.stage, "correction_round", "which lint failed is what a reader needs first");
  assert.equal(logged[0].data.iteration, 1);
  assert.match(String(logged[0].data.lint_error), /Maximum call stack size exceeded/);
  assert.equal(logged[0].data.lint_error_where, "run");
  assert.equal(logged[0].data.lint_error_name, "RangeError");
  assert.ok(String(logged[0].data.lint_error_stack ?? "").length > 0, "no stack to locate it by");

  // And the document goes out saying so, though the failure arrived after assembly.
  assert.match(result.html, /@lint-unavailable/);
});
