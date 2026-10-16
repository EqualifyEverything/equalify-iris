// Attributes whose names no valid markup produces, such as `1\"` from leaked JSON escaping.
// Up to jsdom 25, two digit-leading names took the accessibility check offline for a WHOLE document
// (#257): jsdom's selector engine, nwsapi, could not compile axe's escaped selector `\39 `. So
// `runAxe` removed those names from its own copy. jsdom 30 dropped nwsapi, so the removal is gone
// (#535). Every malformed name is still COUNTED, because the count is the only symptom of a leak one
// stage earlier. Nothing is removed, because removing an attribute takes the rules that read it
// away too, including `aria-valid-attr`, which fires *because* a name is malformed.
//
// The document that ships keeps every byte either way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM, VirtualConsole } from "jsdom";
import axe from "axe-core";
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
// `<hr role=\"doc-pagebreak\" aria-label=\"Page 1\" id=\"page-1\">` is a `role` of
// `\"doc-pagebreak\"` (an invalid role, so not a page-break marker at all), an `aria-label` of
// `\"Page` (a marker that announces the wrong text), an `id` of `\"page-1\"` (so every reference to
// `#page-1` is dead — the family of #233 and #234), and then a leftover attribute NAMED `1\"`.
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

test("two corrupted page-break markers lint, with nothing removed", async () => {
  // The document from #257. On jsdom 25 with no removal it returned no verdict — `error:
  // "axe-core could not run in this environment: Octal escape sequences are not allowed in strict
  // mode.", errorWhere: "run"` — with the `image-alt` violation in it reported nowhere.
  const lint = await runAxe(wrapDocument(`${DEFECT}\n${marker("1")}\n${marker("2")}`));
  assert.equal(lint.error, undefined, "the gate is offline for a document it can lint every page of");
  // Both halves of the news. `image-alt` is the ordinary defect that went unexamined on all 150
  // pages of each affected document, and `aria-roles` is the corrupted marker ITSELF being reported
  // — `role=\"doc-pagebreak\"` is not a role, and it is the one of that leak's four harms the rule
  // set can see for itself, on the documents it was allowed to look at.
  assert.deepEqual(
    lint.violations?.map((v) => `${v.id}:${v.nodes}`),
    ["aria-roles:2", "image-alt:1"],
    "the check ran but stopped finding the defects it exists to find",
  );
  // And the debris is on the record rather than merely gone. Two attributes, because each corrupted
  // marker leaves one — which is also the count that made the failure reachable.
  assert.equal(lint.malformedAttributes, 2);
  assert.deepEqual(lint.malformedAttributeNames, [`1\\"`, `2\\"`]);
});

test("every malformed name is counted, and the document lints either way", async () => {
  // Letter-leading names always linted; digit-leading ones broke jsdom 25 once there were two.
  // The count has to appear on both, or it cannot answer "is the leak upstream fixed?".
  const rows: [string, string, number][] = [
    ["one, plus a clean unique id", `${DEFECT}\n<hr 9\\"="" id="a">`, 1],
    ["one, with no id at all", `${DEFECT}\n<hr 9\\"="">`, 1],
    ["two, letter-leading names", `${DEFECT}\n<hr iii\\"="" id=\\"a\\">\n<hr jjj\\"="" id=\\"b\\">`, 2],
    // the pair that broke jsdom 25
    ["two, digit-leading names", `${DEFECT}\n<hr 9\\"="" id=\\"a\\">\n<hr 8\\"="" id=\\"b\\">`, 2],
    ["one of each", `${DEFECT}\n<hr 9\\"="" id="a">\n<hr jjj\\"="" id="b">`, 2],
  ];
  for (const [what, body, expected] of rows) {
    const lint = await runAxe(wrapDocument(body));
    assert.equal(lint.error, undefined, `${what}: the gate did not run`);
    assert.deepEqual(lint.violations?.map((v) => v.id), ["image-alt"], `${what}: the defect went unreported`);
    assert.equal(lint.violations?.[0]?.nodes, 1, `${what}: the count moved`);
    assert.equal(lint.malformedAttributes, expected, `${what}: the debris was not counted`);
  }
});

test("an attribute a rule reports BECAUSE its name is broken is counted and left alone", async () => {
  // Why nothing is removed. One lost quote on an ARIA attribute in a page answer is a single
  // attribute named `aria-label"note"`, and `aria-valid-attr` reports it: critical, wcag2a/wcag412.
  // Measured: with every malformed name removed, the violation disappeared and the document passed.
  const lint = await runAxe(wrapDocument(`<p>Body.</p>\n<img src="a.png" alt="A chart" aria-label"Note">`));
  assert.equal(lint.error, undefined);
  assert.deepEqual(
    lint.violations?.map((v) => `${v.id}/${v.impact}`),
    ["aria-valid-attr/critical"],
    "a critical WCAG A finding was removed from the document before the rules saw it",
  );
  assert.equal(lint.malformedAttributes, 1, "the debris is still counted, because the leak is still worth knowing");
  assert.deepEqual(lint.malformedAttributeNames, [`aria-label"note"`]);

  // A backslash before a digit, which escapes to a backslash and a digit with no escape in it.
  const looksEscaped = await runAxe(wrapDocument(`<p>Body.</p>\n<img src="a.png" alt="A chart" aria-label\\1="x">`));
  assert.equal(looksEscaped.error, undefined, "a selector built from this name did compile after all");
  assert.deepEqual(looksEscaped.violations?.map((v) => v.id), ["aria-valid-attr"]);
  assert.equal(looksEscaped.malformedAttributes, 1);
});

test("the selector engine compiles every attribute selector axe can build (#535)", () => {
  // Why the #257 removal could go. axe escapes an attribute name with its own `escapeSelector` and
  // puts it in `[name="value"]`. jsdom 25's nwsapi threw on the digit-leading shapes; jsdom 30 must
  // compile all of them. If this fails after a jsdom bump, the removal has to come back.
  const escapeSelector = (axe as unknown as { utils: { escapeSelector: (s: string) => string } }).utils.escapeSelector;
  const doc = new JSDOM(`<!DOCTYPE html><html><body><p 1x="" 9\\"="">x</p></body></html>`, {
    virtualConsole: new VirtualConsole(),
  }).window.document;
  const names = [`1x`, `9"`, `1\\"`, `iii\\"`, `aria-label"note"`, `-9x`, `0`, "a\u0001b", "a\u007fb", `a\\9`, `c:\\`];
  for (const name of names) {
    assert.doesNotThrow(() => doc.querySelectorAll(`[${escapeSelector(name)}=""]`), `${name} does not compile`);
  }
  // And it matches, so axe's selectors find the element they were built for.
  assert.equal(doc.querySelectorAll(`[${escapeSelector("1x")}=""]`).length, 1);
});

test("an ordinary document says nothing about attributes, and a valid odd-looking one is not debris", async () => {
  const clean = await runAxe(wrapDocument(DEFECT));
  assert.equal(clean.malformedAttributes, undefined, "a field on every run is a field that means nothing");
  assert.equal(clean.malformedAttributeNames, undefined);
  assert.deepEqual(lintDebrisFields(clean), {}, "so it can be spread into any log line unconditionally");

  // The names this pipeline's own output carries. `xml:lang` and `data-*` are the shapes most likely
  // to be mistaken for debris by a rule tighter than the one in lint.ts, and `aria-describedby`,
  // `scope` and `headers` are attributes the rule set READS. The
  // non-ASCII `data-*` is in for the same reason in the other direction: it is a legal custom
  // attribute, no rule reads it, and counting it would put noise into the one number whose job is
  // answering whether a leak upstream is fixed.
  const ordinary = await runAxe(
    wrapDocument(
      `<p xml:lang="cy" data-page="3" data-título="3">Pennod.</p>\n` +
        `<table><caption>T</caption><tr><th scope="col" id="h">A</th></tr><tr><td headers="h">1</td></tr></table>\n` +
        `<img src="a.png" alt="A chart" aria-describedby="d">\n<p id="d">Described here.</p>`,
    ),
  );
  assert.equal(ordinary.malformedAttributes, undefined, "a legal attribute was read as parser debris");
  assert.deepEqual(ordinary.violations, [], "...or one the rules read was taken away from them");
});

test("the debris is reported per name, bounded, and long names cut", async () => {
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
  // Nothing is serialized out of the lint's own parse, so the delivered HTML is unchanged. The
  // corrupted `role`, `aria-label` and `id` are a bug one stage earlier, which this stage reports.
  const { ctx, events } = recorder();
  const { html, lint } = await runAssembly(ctx, [
    frag(1, `${DEFECT}\n${marker("1")}\n${marker("2")}`),
    frag(2, `<p>Page two.</p>`),
  ]);
  // The escaping as the page agent's answer carried it, byte for byte. `1\"` is only what the PARSER
  // makes of the tail of `aria-label=\"Page 1\"` — there is no such attribute in the text, which is
  // half of why this leak was hard to see. Compared as a string rather than a pattern, because a
  // regex for markup this shape is a second escaping problem on top of the one under test.
  assert.ok(
    html.includes(marker("1")),
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
  assert.deepEqual(logged.data.malformed_attribute_names, [`1\\"`, `2\\"`]);

  // And absent on the ordinary run, so its presence is a signal.
  const { ctx: ctx2, events: events2 } = recorder();
  await runAssembly(ctx2, [frag(1, `<h1>Report</h1><p>Clean.</p>`)]);
  const ok = events2.find((e) => e.type === "assembly")!;
  for (const key of ["malformed_attributes", "malformed_attribute_names"]) {
    assert.ok(!(key in ok.data), `an ordinary run logged ${key}: ${JSON.stringify(ok.data)}`);
  }
});

test("what the count does not reach, stated rather than assumed", async () => {
  // `querySelectorAll("*")` does not enter a `<template>`, whose content is a separate fragment.
  // axe does not walk it either, so no rule reads it, but the count misses it. Written down here.
  const lint = await runAxe(
    wrapDocument(`${DEFECT}\n<template><hr 9\\"="" id=\\"a\\"><hr 8\\"="" id=\\"b\\"></template>`),
  );
  assert.equal(lint.error, undefined);
  assert.equal(lint.malformedAttributes, undefined, "the count now reaches template content; update this test");
});
