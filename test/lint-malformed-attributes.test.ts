// Two attributes whose names begin with a digit used to take the accessibility check offline for a
// WHOLE document (issue #257). On a real corpus that happened to 6 delivered 25-page documents:
// every defect on all 150 pages went unexamined because of an attribute on an `<hr>`.
//
// The chain, because the error message sends you looking in the wrong place. axe needs a unique CSS
// path for the elements it reports; where an id is unusable and a similar sibling has to be
// disambiguated it enumerates attributes instead, and a CSS escape is the hex codepoint — so a name
// beginning with `9` escapes to `\39`. nwsapi compiles selectors into JavaScript source, where `\39`
// is an octal escape, which is a SyntaxError in strict mode. "Octal escape sequences are not allowed
// in strict mode" on a document containing no escape sequences at all.
//
// It needs BOTH conditions, which is what makes the fix narrow: two or more such elements, because
// axe builds the attribute selector only when it must disambiguate, and a digit-leading name,
// because only those escape to something that looks octal. Those boundaries are the negative rows
// below — they are what says the strip is aimed at the right thing.
//
// `runAxe` now takes attributes no valid markup produces out of ITS OWN copy of the document before
// axe walks it, and reports what it found. The document that ships keeps every byte: this pipeline
// does not rewrite a user's markup on the way past (the rule `anchors.ts` declines reserialization
// for), and the leak that makes these is a bug one stage earlier, not something to paper over here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runAxe,
  lintDebrisFields,
  MAX_MALFORMED_NAMES,
  MALFORMED_NAME_CHARS,
} from "../src/pipeline/lint.ts";
import { runAssembly, wrapDocument } from "../src/pipeline/assembly.ts";
import type { Fragment } from "../src/pipeline/fragment.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";

// A real, reportable defect, so every row below can be read two ways: whether the gate RAN, and
// whether it still found what it was there to find.
const DEFECT = `<p>Body text.</p>\n<img src="a.png">`;
// The markup as it was delivered, JSON escaping and all. What the parser makes of
// `<hr role=\"doc-pagebreak\" aria-label=\"Page iii\" id=\"page-iii\">` is a `role` of
// `\"doc-pagebreak\"` (an invalid role, so not a page-break marker at all), an `aria-label` of
// `\"Page` (a marker that announces the wrong text), an `id` of `\"page-iii\"` (so every reference to
// `#page-iii` is dead — the family of #233 and #234), and then a leftover attribute NAMED `iii\"`.
// Only the last of those four harms is this file's, and it is the only one with no other symptom.
const marker = (label: string) => `<hr role=\\"doc-pagebreak\\" aria-label=\\"Page ${label}\\" id=\\"page-${label}\\">`;

function recorder(): { ctx: PipelineContext; events: { type: string; data: Record<string, unknown> }[] } {
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const ctx = {
    log: { event: (type: string, data: Record<string, unknown> = {}) => events.push({ type, data }) },
  } as unknown as PipelineContext;
  return { ctx, events };
}

function frag(order: number, innerHtml: string): Fragment {
  return { image: `page-00${order}.png`, order, agent: "page.md", region: "page", innerHtml, edges: [], log: "" };
}

test("two corrupted page-break markers no longer cost the whole document its lint", async () => {
  // The document from the issue, reproduced against `src/pipeline/lint.ts` rather than a port. This
  // returned no verdict at all before the strip: `error: "axe-core could not run in this
  // environment: Octal escape sequences are not allowed in strict mode.", errorWhere: "run"`, with
  // the `image-alt` violation present in the document and reported nowhere.
  const lint = await runAxe(wrapDocument(`${DEFECT}\n${marker("ii")}\n${marker("iii")}`));
  assert.equal(lint.error, undefined, "the gate is offline for a document it can lint every page of");
  // Both halves of the news. `image-alt` is the ordinary defect that went unexamined on all 150 pages
  // of each affected document, and `aria-roles` is the corrupted marker ITSELF being reported —
  // `role=\"doc-pagebreak\"` is not a role, and it is the one of that leak's four harms the rule set
  // can see for itself, on the documents it was allowed to look at.
  assert.deepEqual(
    lint.violations?.map((v) => `${v.id}:${v.nodes}`),
    ["aria-roles:2", "image-alt:1"],
    "the check ran but stopped finding the defects it exists to find",
  );
  // And the debris is on the record rather than merely gone. Two attributes, because each corrupted
  // marker leaves one — which is also the count that made the failure reachable.
  assert.equal(lint.malformedAttributes, 2);
  assert.deepEqual(lint.malformedAttributeNames, [`ii\\"`, `iii\\"`]);
});

test("the boundary: which documents used to break, and every one of them reports its debris now", async () => {
  // The table from the issue, and the negatives matter as much as the positive. Three of these four
  // linted fine BEFORE the strip, which is why a fix aimed only at the crash would have counted
  // nothing on them — and a count that appears only on documents that break is a count that cannot
  // answer "is the leak upstream fixed?", the question #257 was filed unable to settle.
  const rows: [string, string, number][] = [
    // one corrupted element, so axe never needs the attribute selector
    ["one, plus a clean unique id", `${DEFECT}\n<hr 9\\"="" id="a">`, 1],
    ["one, with no id at all", `${DEFECT}\n<hr 9\\"="">`, 1],
    // two, but letter-leading: `iii\"` escapes to `iii\\\"`, which compiles
    ["two, letter-leading names", `${DEFECT}\n<hr iii\\"="" id=\\"a\\">\n<hr jjj\\"="" id=\\"b\\">`, 2],
    // and the pair that did break it
    ["two, digit-leading names", `${DEFECT}\n<hr 9\\"="" id=\\"a\\">\n<hr 8\\"="" id=\\"b\\">`, 2],
  ];
  for (const [what, body, expected] of rows) {
    const lint = await runAxe(wrapDocument(body));
    assert.equal(lint.error, undefined, `${what}: the gate did not run`);
    assert.deepEqual(lint.violations?.map((v) => v.id), ["image-alt"], `${what}: the defect went unreported`);
    assert.equal(lint.violations?.[0]?.nodes, 1, `${what}: the count moved`);
    assert.equal(lint.malformedAttributes, expected, `${what}: the debris was not counted`);
  }
});

test("an ordinary document says nothing about attributes, and a valid odd-looking one is not debris", async () => {
  const clean = await runAxe(wrapDocument(DEFECT));
  assert.equal(clean.malformedAttributes, undefined, "a field on every run is a field that means nothing");
  assert.equal(clean.malformedAttributeNames, undefined);
  assert.deepEqual(lintDebrisFields(clean), {}, "so it can be spread into any log line unconditionally");

  // The names this pipeline's own output carries. `xml:lang` and `data-*` are the shapes most likely
  // to be mistaken for debris by a rule tighter than the one in lint.ts, and `aria-describedby`,
  // `scope` and `headers` are attributes the rule set READS — a strip that took any of them would
  // change the verdict rather than rescue it, which is the failure mode to check for here.
  const ordinary = await runAxe(
    wrapDocument(
      `<p xml:lang="cy" data-page="3">Pennod.</p>\n` +
        `<table><caption>T</caption><tr><th scope="col" id="h">A</th></tr><tr><td headers="h">1</td></tr></table>\n` +
        `<img src="a.png" alt="A chart" aria-describedby="d">\n<p id="d">Described here.</p>`,
    ),
  );
  assert.equal(ordinary.malformedAttributes, undefined, "a legal attribute was read as parser debris");
  assert.deepEqual(ordinary.violations, [], "...or one the rules read was taken away from them");
});

test("the strip is reported per name, bounded, and long names are cut", async () => {
  // Bounded because these are characters out of a user's document and they go in a log line — the
  // same argument the node excerpts are bounded on. The count stays exact: how much debris there is
  // is the number that says whether a leak is systematic, and it is unbounded and cheap.
  const long = `9${"long".repeat(20)}`;
  const many = Array.from({ length: 6 }, (_, i) => `<hr ${i}x="" ${long}="">`).join("\n");
  const lint = await runAxe(wrapDocument(`${DEFECT}\n${many}`));
  assert.equal(lint.error, undefined);
  assert.equal(lint.malformedAttributes, 12, "the count is a sample too, so it cannot say how much there is");
  assert.equal(lint.malformedAttributeNames?.length, MAX_MALFORMED_NAMES);
  const cut = lint.malformedAttributeNames!.find((n) => n.endsWith("…"));
  assert.equal(cut?.length, MALFORMED_NAME_CHARS + 1, "the excerpt is the bound plus the character that says so");
  assert.deepEqual(lintDebrisFields(lint), {
    malformed_attributes: 12,
    malformed_attribute_names: lint.malformedAttributeNames,
  });
});

test("the document that ships keeps the bytes the lint could not read, and the log line says so", async () => {
  // The strip is on the lint's own parse of the document and nothing is serialized out of it, so the
  // delivered HTML is unchanged — deliberately. Rewriting a user's markup here would be this
  // pipeline deciding what an attribute it cannot describe was meant to be, on a document it has
  // already been told to deliver as written; and the corrupted `role`, `aria-label` and `id` beside
  // it are a bug one stage earlier, which this stage can report and must not hide.
  const { ctx, events } = recorder();
  const { html, lint } = await runAssembly(ctx, [frag(1, `${DEFECT}\n${marker("ii")}\n${marker("iii")}`), frag(2, `<p>Page two.</p>`)]);
  // The escaping as the page agent's answer carried it, byte for byte. `ii\"` is only what the PARSER
  // makes of the tail of `aria-label=\"Page ii\"` — there is no such attribute in the text, which is
  // half of why this leak was hard to see. Compared as a string rather than a pattern, because a
  // regex for markup this shape is a second escaping problem on top of the one under test.
  assert.ok(
    html.includes(marker("ii")),
    `the delivered document was rewritten by a check that only reads it: ${html}`,
  );
  assert.equal(lint.error, undefined);

  const logged = events.find((e) => e.type === "assembly")!;
  assert.equal(logged.data.lint_ok, false, "the document has a real violation, so the gate ran and failed it");
  // Two: the `<img>` with no `alt`, and `aria-roles` on the two markers whose `role` the leak
  // corrupted — the defect that used to be unreportable because it took the whole gate down with it.
  assert.equal(logged.data.violations, 2);
  // Spread onto the line the stage already logs, the way the `lint_error*` fields are: an operator
  // reading a run sees the debris count beside the verdict it belongs to.
  assert.equal(logged.data.malformed_attributes, 2);
  assert.deepEqual(logged.data.malformed_attribute_names, [`ii\\"`, `iii\\"`]);

  // And absent on the ordinary run, so its presence is a signal.
  const { ctx: ctx2, events: events2 } = recorder();
  await runAssembly(ctx2, [frag(1, `<h1>Report</h1><p>Clean.</p>`)]);
  const ok = events2.find((e) => e.type === "assembly")!;
  for (const key of ["malformed_attributes", "malformed_attribute_names"]) {
    assert.ok(!(key in ok.data), `an ordinary run logged ${key}: ${JSON.stringify(ok.data)}`);
  }
});

test("what the strip does not reach, stated rather than assumed", async () => {
  // `querySelectorAll("*")` does not enter a `<template>`, whose content is a separate fragment. Not
  // a hole in the defence, because axe does not walk it either — a template's content is not in the
  // document's flat tree, so no rule reports it and no selector is built for it — but it IS a hole in
  // the counting, and this is where that is written down. Asserted both ways, so a future axe that
  // does walk template content fails here and says which half changed.
  const lint = await runAxe(
    wrapDocument(`${DEFECT}\n<template><hr 9\\"="" id=\\"a\\"><hr 8\\"="" id=\\"b\\"></template>`),
  );
  assert.equal(lint.error, undefined, "axe now walks template content — the strip has to as well");
  assert.equal(lint.malformedAttributes, undefined, "the strip reaches template content but the count says nothing");
});
