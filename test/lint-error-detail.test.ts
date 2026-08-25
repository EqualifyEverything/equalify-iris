// `runAxe` degrades rather than fails: when axe cannot run it returns `ok: true,
// violations: []` with `error` set, so a document the gate never examined ships. That
// trade is deliberate — a linter that cannot load must not cost a user their document —
// and it only stays honest if the failure can be chased down afterwards.
//
// It could not be. The first report of this happening on a real document (#144) carried
// one sentence: "Octal escape sequences are not allowed in strict mode". A JavaScript
// SyntaxError, which is not the case the code documented as reachable (a stack overflow
// on a page too deeply nested), which names no document, and which does not say whether
// axe's own source failed to evaluate or axe choked walking the output. Those two answers
// point at a version bump and at a page of HTML respectively, and nobody could tell which
// from the log. So the report now carries which step threw, the error's class, and the top
// of its stack; this test holds all three to the log line an operator actually reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runAxe } from "../src/pipeline/lint.ts";
import { runAssembly, wrapDocument } from "../src/pipeline/assembly.ts";
import type { Fragment } from "../src/pipeline/fragment.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";

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

// Deep enough that walking the tree overflows the stack. Every threshold here moves with
// the stack the caller already spent, so if axe manages to run the degradation never
// happened and there is nothing to report — each test below returns instead of asserting
// against a gate that worked.
const DEEP = `${"<div>".repeat(6000)}<p>Buried</p>`;

test("a lint that could not run says which step threw, and what threw", async () => {
  const lint = await runAxe(wrapDocument(DEEP));
  if (lint.error === undefined) return;

  // The distinction the message could not make. `run` is axe walking THIS document, which
  // sends an operator to the page of HTML; `inject` would be axe's own source failing to
  // evaluate, which sends them to a version. It is read off which call threw rather than
  // out of the text, which is why lint.ts keeps the two in separate try blocks.
  assert.equal(lint.errorWhere, "run", "the step is guessed from the message rather than recorded");
  assert.equal(lint.ok, true, "the degradation stopped being a degradation");
  assert.deepEqual(lint.violations, []);
  assert.ok(lint.errorName, "the error class is missing, which is the first thing to look at");
  assert.equal(lint.errorName, "RangeError", "a stack overflow is what this document provokes");
  assert.ok(lint.errorStack?.includes(lint.errorName), "the stack does not even name its own error");
  // Bounded, because this ends up in every run's log: enough frames to name the throwing
  // library and its caller, not a page of jsdom internals in a session record.
  const lines = lint.errorStack!.split("\n").length;
  assert.ok(lines <= 7, `the whole stack was logged (${lines} lines)`);
});

test("the three fields reach the log line an operator reads", async () => {
  // The fields only matter where they are read, and that is `runAssembly`'s `assembly`
  // event — the same line that records `lint_ok: true` for a gate that never ran.
  const { ctx, events } = recorder();
  const { lint } = await runAssembly(ctx, [frag(1, DEEP), frag(2, `<p>B</p>`)]);
  const logged = events.find((e) => e.type === "assembly")!;
  if (lint.error === undefined) {
    assert.ok(!("lint_error_where" in logged.data), "a gate that ran reported a failure step anyway");
    return;
  }
  assert.equal(logged.data.lint_error_where, lint.errorWhere);
  assert.equal(logged.data.lint_error_name, lint.errorName);
  assert.equal(logged.data.lint_error_stack, lint.errorStack);
  // Paired with the reading that makes them necessary: this run is on the record as clean.
  assert.equal(logged.data.lint_ok, true);
  assert.equal(logged.data.violations, 0);
});

test("an ordinary run carries none of them", async () => {
  // A key on every run is noise, and noise is how the one line that mattered gets skipped.
  const { ctx, events } = recorder();
  await runAssembly(ctx, [frag(1, `<h1>Report</h1><p>Clean</p>`)]);
  const clean = events.find((e) => e.type === "assembly")!;
  for (const key of ["lint_error", "lint_error_where", "lint_error_name", "lint_error_stack"]) {
    assert.ok(!(key in clean.data), `an ordinary run logged ${key}: ${JSON.stringify(clean.data)}`);
  }
});

test("a document that parses and lints reports no failure fields at all", async () => {
  const lint = await runAxe(wrapDocument(`<h1>Report</h1><p>Body</p>`));
  assert.equal(lint.error, undefined);
  assert.equal(lint.errorWhere, undefined);
  assert.equal(lint.errorName, undefined);
  assert.equal(lint.errorStack, undefined);
});

test("axe-core and jsdom are pinned to exact versions, and to the ones installed", () => {
  // This function is a gate. What it reports decides whether a document ships with a
  // violation; its rule set is tuned against axe internals (which of the three
  // duplicate-id rules claims which element, `duplicate-id-aria` arriving in
  // `incomplete`, which shapes `heading-order` reports), and the same rule ids are what
  // `GET /v1/quality` publishes deployment-wide. On a caret range that behaviour can
  // change on any redeploy with no commit to point at — including a change that makes a
  // failure like #144 appear or disappear — and an operator checking out this sha could
  // not be sure they had the same linter. equalify-iris-bench ports this configuration so
  // its accuracy numbers mean what Iris's mean, which only holds if both can name a version.
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const require = createRequire(import.meta.url);
  for (const name of ["axe-core", "jsdom"]) {
    const spec = pkg.dependencies[name];
    assert.ok(spec, `${name} is not a direct dependency`);
    assert.match(spec, /^\d+\.\d+\.\d+$/, `${name} is on a range (${spec}); a gate cannot float`);
    const installed = (require(`${name}/package.json`) as { version: string }).version;
    assert.equal(installed, spec, `${name} in node_modules is not what package.json pins`);
  }
});
