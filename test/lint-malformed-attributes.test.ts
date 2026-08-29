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
// It needs BOTH conditions, which is what makes the removal narrow: two or more such elements,
// because axe builds the attribute selector only when it must disambiguate, and a name whose CSS
// escape looks octal, because nothing else reaches the compiler as one. Those boundaries are the
// rows below — they are what says the removal is aimed at the right thing.
//
// And it is aimed narrowly on purpose. Every malformed name is COUNTED, because the count is the
// only symptom of a leak one stage earlier; only the ones that defeat the selector compiler are
// REMOVED, because removing an attribute takes the rules that read it away too — including
// `aria-valid-attr`, which fires *because* a name is malformed. That is a whole test below.
//
// `runAxe` does this to ITS OWN copy of the document. The document that ships keeps every byte:
// this pipeline does not rewrite a user's markup on the way past (the rule `anchors.ts` declines
// reserialization for), and the leak that makes these is a bug one stage earlier, not something to
// paper over here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM, VirtualConsole } from "jsdom";
import axe from "axe-core";
import {
  runAxe,
  lintDebrisFields,
  breaksSelectorEngine,
  escapeAttributeName,
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

test("two corrupted page-break markers no longer cost the whole document its lint", async () => {
  // The document from the issue, reproduced against `src/pipeline/lint.ts` rather than a port.
  // Verified against axe with no strip at all: this document returns no verdict — `error:
  // "axe-core could not run in this environment: Octal escape sequences are not allowed in strict
  // mode.", errorWhere: "run"` — with the `image-alt` violation present in it and reported nowhere.
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
  assert.equal(lint.malformedAttributesRemoved, 2, "the lint linted a document it did not change");
  assert.deepEqual(lint.malformedAttributeNames, [`1\\"`, `2\\"`]);
});

test("the boundary: which names are removed, which are only counted, and the whole leak either way", async () => {
  // The table from the issue plus the narrowing, and the negatives matter as much as the positive.
  // Three of these five linted fine BEFORE any of this existed, which is why a fix aimed only at
  // the crash would have counted nothing on them — and a count that appears only on documents that
  // break is a count that cannot answer "is the leak upstream fixed?", the question #257 was filed
  // unable to settle.
  const rows: [string, string, number, number | undefined][] = [
    // one corrupted element, so axe never needs the attribute selector — removed anyway, because
    // the predicate is a property of the NAME and a document's luck is not something to depend on
    ["one, plus a clean unique id", `${DEFECT}\n<hr 9\\"="" id="a">`, 1, 1],
    ["one, with no id at all", `${DEFECT}\n<hr 9\\"="">`, 1, 1],
    // two, but letter-leading: `iii\"` escapes to `iii\\\"`, which compiles. Counted, left in
    // place, and verified to lint with no strip at all — the same leak with roman-numeral page
    // labels instead of arabic ones, which is a real document and never had this failure.
    ["two, letter-leading names", `${DEFECT}\n<hr iii\\"="" id=\\"a\\">\n<hr jjj\\"="" id=\\"b\\">`, 2, undefined],
    // and the pair that did break it
    ["two, digit-leading names", `${DEFECT}\n<hr 9\\"="" id=\\"a\\">\n<hr 8\\"="" id=\\"b\\">`, 2, 2],
    // a mixture, which is what a real page of leaked JSON looks like
    ["one of each", `${DEFECT}\n<hr 9\\"="" id="a">\n<hr jjj\\"="" id="b">`, 2, 1],
  ];
  for (const [what, body, expected, removed] of rows) {
    const lint = await runAxe(wrapDocument(body));
    assert.equal(lint.error, undefined, `${what}: the gate did not run`);
    assert.deepEqual(lint.violations?.map((v) => v.id), ["image-alt"], `${what}: the defect went unreported`);
    assert.equal(lint.violations?.[0]?.nodes, 1, `${what}: the count moved`);
    assert.equal(lint.malformedAttributes, expected, `${what}: the debris was not counted`);
    assert.equal(lint.malformedAttributesRemoved, removed, `${what}: the wrong number of attributes was taken out`);
  }
});

test("an attribute a rule reports BECAUSE its name is broken is counted and left alone", async () => {
  // The cost of removing more than the compiler needs, and the reason the two numbers above are
  // separate. One lost quote on an ARIA attribute in a page answer — the same escaping-leak family
  // as #233/#234/#257 — is a single attribute named `aria-label"note"`, and `aria-valid-attr`
  // reports it: critical, wcag2a/wcag412, so inside this gate's tag filter, because its matcher is
  // a prefix test on the raw attribute name.
  //
  // Measured on the same document with a removal that took every malformed name: the violation
  // disappeared and the document passed the gate clean, with a number on a run-log line as the only
  // trace and `/v1/quality` counting it among `documents_linted` with no rule against it. A gate
  // that loses a critical finding to protect itself has given away what it is for.
  const lint = await runAxe(wrapDocument(`<p>Body.</p>\n<img src="a.png" alt="A chart" aria-label"Note">`));
  assert.equal(lint.error, undefined);
  assert.deepEqual(
    lint.violations?.map((v) => `${v.id}/${v.impact}`),
    ["aria-valid-attr/critical"],
    "a critical WCAG A finding was removed from the document before the rules saw it",
  );
  assert.equal(lint.malformedAttributes, 1, "the debris is still counted, because the leak is still worth knowing");
  assert.equal(lint.malformedAttributesRemoved, undefined, "an attribute a rule reads was taken out of the document");
  assert.deepEqual(lint.malformedAttributeNames, [`aria-label"note"`]);

  // The same rule, on the name that comes closest to looking like one the compiler cannot take: a
  // backslash immediately before a digit. Escaped, it ends `\\1` — a backslash and a digit, with no
  // escape in it — so a predicate that read the finished string instead of what the escaper did
  // would remove this one and lose the finding on it. It is the only shape where those two readings
  // differ, and this is the end-to-end version of that.
  const looksEscaped = await runAxe(wrapDocument(`<p>Body.</p>\n<img src="a.png" alt="A chart" aria-label\\1="x">`));
  assert.equal(looksEscaped.error, undefined, "a selector built from this name did compile after all");
  assert.deepEqual(looksEscaped.violations?.map((v) => v.id), ["aria-valid-attr"]);
  assert.equal(looksEscaped.malformedAttributes, 1);
  assert.equal(looksEscaped.malformedAttributesRemoved, undefined, "a name that compiles was taken out anyway");
});

test("what gets removed is the escape shape, and that is checked against axe and against nwsapi", async () => {
  // The predicate is a claim about two libraries, so it is tested against both rather than against
  // a reading of them. `escapeAttributeName` is a port of axe's own `escapeSelector` — the function
  // axe uses to build the selectors it hands the engine — ported because jsdom has no `CSS.escape`
  // and axe's copy only exists inside a window that already has axe injected, which is after the
  // point the strip has to run.
  const escapeSelector = (axe as unknown as { utils: { escapeSelector: (s: string) => string } }).utils.escapeSelector;
  const doc = new JSDOM(`<!DOCTYPE html><html><body><p>x</p></body></html>`, {
    virtualConsole: new VirtualConsole(),
  }).window.document;

  // Names a leak, a page agent or an adversary could produce, including every punctuation shape the
  // escaper treats differently and the control characters whose hex escape is the octal-looking one.
  const names = [
    `1x`,
    `9"`,
    `1\\"`,
    `ii"`,
    `iii\\"`,
    `aria-label"note"`,
    `aria-label'note'`,
    `-9x`,
    `-x`,
    `-`,
    `0`,
    "a\u0001b",
    "a\u000bb",
    "a\u007fb",
    `data-título`,
    `xml:lang`,
    `aria-label`,
    `a=b`,
    `a[b]`,
    `a.b`,
    `a\\b`,
    `a&b`,
    `a#b`,
    `a*b`,
    // A backslash already in the name, immediately before a digit. The escaper emits `\\` for it,
    // so the finished string ends in a backslash and a digit while containing no escape — the one
    // shape where reading the escaped text and reading what the escaper did disagree. These compile,
    // and the first two are names a rule reads, so a predicate that matched the text would remove
    // exactly what the narrow removal exists to protect.
    `aria-label\\1`,
    `data-x\\2`,
    `a\\9`,
  ];
  for (const name of names) {
    assert.equal(escapeAttributeName(name), escapeSelector(name), `the port disagrees with axe on ${name}`);
    // And the predicate against the engine itself: it says a name breaks the compiler exactly when
    // the compiler refuses the selector axe would have built from it. If a future jsdom fixes the
    // octal bug, every row here flips to "compiles" and this test is what says the workaround can
    // be retired — read a failure that way before widening anything.
    let threw = false;
    try {
      doc.querySelectorAll(`[${escapeAttributeName(name)}]`);
    } catch {
      threw = true;
    }
    assert.equal(breaksSelectorEngine(name), threw, `the predicate and the selector engine disagree on ${name}`);
  }
  // The two claims the narrowing rests on, stated rather than left implicit: a name that breaks the
  // compiler has to start with a digit, a `-` and a digit, or a control character, so it can never
  // be an `aria-*` or `data-*` attribute — nothing a rule reads is ever removed.
  for (const name of names.filter(breaksSelectorEngine)) {
    assert.doesNotMatch(name, /^(aria-|data-)/, "a removable name could be an attribute the rules read");
  }
  // ...and nothing inside the legal name shape breaks it, so "malformed" is a superset of
  // "removed" and the two counters can never disagree in the other direction.
  for (const legal of ["aria-label", "data-page", "xml:lang", "role", "for", "scope", "headers", "aria-describedby"]) {
    assert.equal(breaksSelectorEngine(legal), false, `${legal} would be stripped from every document`);
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
  // change the verdict rather than rescue it, which is the failure mode to check for here. The
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

test("the debris is reported per name, bounded, removals first, and long names cut", async () => {
  // Bounded because these are characters out of a user's document and they go in a log line — the
  // same argument the node excerpts are bounded on. The count stays exact: how much debris there is
  // is the number that says whether a leak is systematic, and it is unbounded and cheap.
  const long = `9${"long".repeat(20)}`;
  const many = Array.from({ length: 6 }, (_, i) => `<hr ${i}x="" ${long}="">`).join("\n");
  const lint = await runAxe(wrapDocument(`${DEFECT}\n${many}`));
  assert.equal(lint.error, undefined);
  assert.equal(lint.malformedAttributes, 12, "the count is a sample too, so it cannot say how much there is");
  assert.equal(lint.malformedAttributesRemoved, 12, "every one of these is digit-leading");
  assert.equal(lint.malformedAttributeNames?.length, MAX_MALFORMED_NAMES);
  const cut = lint.malformedAttributeNames!.find((n) => n.endsWith("…"));
  assert.equal(cut?.length, MALFORMED_NAME_CHARS + 1, "the excerpt is the bound plus the character that says so");
  assert.deepEqual(lintDebrisFields(lint), {
    malformed_attributes: 12,
    malformed_attributes_removed: 12,
    malformed_attribute_names: lint.malformedAttributeNames,
  });

  // The sample leads with what was REMOVED, even when the document's first debris was not. Those
  // names are the ones that changed what axe was shown, and on a document with debris on every page
  // the three slots would otherwise be filled long before reaching one of them.
  const mixed = await runAxe(
    wrapDocument(`<p aaa\\"="">One.</p>\n<p bbb\\"="">Two.</p>\n<p ccc\\"="">Three.</p>\n<p 7x="">Four.</p>`),
  );
  assert.equal(mixed.malformedAttributes, 4);
  assert.equal(mixed.malformedAttributesRemoved, 1);
  assert.equal(mixed.malformedAttributeNames?.[0], "7x", "the one name that changed the linted document is not shown");
  assert.equal(mixed.malformedAttributeNames?.length, MAX_MALFORMED_NAMES);
});

test("the document that ships keeps the bytes the lint could not read, and the log line says so", async () => {
  // Nothing is serialized out of the lint's own parse of the document, so the delivered HTML is
  // unchanged — deliberately, and for the attributes that WERE taken out of the linted copy as much
  // as for the others. Rewriting a user's markup here would be this pipeline deciding what an
  // attribute it cannot describe was meant to be, on a document it has already been told to deliver
  // as written; and the corrupted `role`, `aria-label` and `id` beside it are a bug one stage
  // earlier, which this stage can report and must not hide.
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
  assert.equal(logged.data.malformed_attributes_removed, 2);
  assert.deepEqual(logged.data.malformed_attribute_names, [`1\\"`, `2\\"`]);

  // And absent on the ordinary run, so its presence is a signal.
  const { ctx: ctx2, events: events2 } = recorder();
  await runAssembly(ctx2, [frag(1, `<h1>Report</h1><p>Clean.</p>`)]);
  const ok = events2.find((e) => e.type === "assembly")!;
  for (const key of ["malformed_attributes", "malformed_attributes_removed", "malformed_attribute_names"]) {
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
