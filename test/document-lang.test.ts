import { test } from "node:test";
import assert from "node:assert/strict";
import { documentLang, runAssembly, wrapDocument } from "../src/pipeline/assembly.ts";
import { runAxe } from "../src/pipeline/lint.ts";
import type { Fragment } from "../src/pipeline/fragment.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";

// `wrapDocument` hardcoded `<html lang="en">`, so a document assembled from Korean pages
// declared itself English (issue #163). A screen reader picks its voice from that attribute,
// which makes the hardcoded value a wrong statement rather than a missing one — and it is
// invisible to every check the pipeline runs: `html-has-lang` and `html-lang-valid` are both
// satisfied by a confidently wrong `en`, so no round of the review loop and no axe gate ever
// had anything to say about it.
//
// The half of this that lives in `agents/page.md` already landed (#121/#162): a page wholly in
// another language is told to put `lang` on every top-level element it emits. That lands inside
// `<main>` and covers what a reader reads; what it cannot reach is the root, and assembly is the
// first place that can see that every page agrees.
//
// So these pin two things in opposite directions. That the value is DERIVED where the fragments
// all say the same thing, and that it is NOT derived — `en` stays — where they do not: a
// multilingual document has no single primary language to declare, and a page that reported no
// language must not have one invented from the pages that did.

function frag(order: number, innerHtml: string): Fragment {
  return { image: `page-00${order}.png`, order, agent: "page.md", region: "page", innerHtml, edges: [], log: "" };
}

test("a document whose every top-level element says the same language declares it at the root", () => {
  const body = `<section lang="ko"><h1>보고서</h1><p>내용</p></section>\n\n<section lang="ko"><p>둘째 장</p></section>`;
  assert.equal(documentLang(body), "ko");
  const html = wrapDocument(body);
  assert.match(html, /<html lang="ko">/);
  // The shell's own English string is then labelled, because the document around it is not
  // English any more and "Accessible document" is not a Korean phrase.
  assert.match(html, /<title lang="en">Accessible document<\/title>/);
});

test("an English document is unchanged, and its title carries no redundant attribute", () => {
  const body = `<h1>Report</h1>\n\n<p>Body</p>`;
  assert.equal(documentLang(body), "en");
  const html = wrapDocument(body);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>Accessible document<\/title>/, "the title repeated a root lang that already said en");
});

test("subtags survive, and agreement is case-insensitive the way BCP 47 is", () => {
  assert.equal(documentLang(`<section lang="zh-Hant-TW"><p>一</p></section>`), "zh-Hant-TW");
  assert.equal(documentLang(`<p lang="es-419">uno</p>\n\n<p lang="es-419">dos</p>`), "es-419");
  // `KO` and `ko` are one declaration, so the pages agree; the first spelling is delivered,
  // since what is established here is which language they name and not how they typed it.
  assert.equal(documentLang(`<p lang="KO">하나</p>\n\n<p lang="ko">둘</p>`), "KO");
});

test("nothing is derived where the pages do not all say the same thing", () => {
  for (const [what, body] of [
    // A multilingual document. Declaring either of these at the root is a worse statement
    // than declaring the shell's own language, and the per-element `lang` inside `<main>`
    // already tells a reader which passage is which.
    ["pages in different languages", `<section lang="ko"><p>하나</p></section>\n\n<section lang="es"><p>uno</p></section>`],
    // One page reported its language and one did not. The silent page is not evidence of
    // anything, least of all of the other page's language.
    ["one page silent", `<section lang="ko"><p>하나</p></section>\n\n<section><p>Unmarked</p></section>`],
    ["the first page silent", `<section><p>Unmarked</p></section>\n\n<section lang="ko"><p>하나</p></section>`],
    // `lang` deeper in the document says which passage changes language, not what the
    // document is: this is the ordinary English page with a quoted Spanish sentence.
    ["lang only on a nested element", `<p>He said <span lang="es">buenos días</span> and left.</p>`],
    // Text with no element on it cannot carry `lang`, so this document has content whose
    // language is unaccounted for either way.
    ["bare text at the top level", `<section lang="ko"><p>하나</p></section>\n\nStray words the join could not attribute.`],
    // Nothing to derive from: every page failed, or every fragment came back blank.
    ["an empty body", ``],
    ["nothing but whitespace", `\n\n  \n`],
  ] as [string, string][]) {
    assert.equal(documentLang(body), "en", `derived a root language from ${what}`);
  }
});

test("a lang the fragments got wrong is not hoisted into the shell", () => {
  // The value comes out of model-written markup, so the two ways it could be wrong both
  // matter, and both end at `en`.
  //
  // A tag that is not a tag would fail axe's `html-lang-valid` at the root — where no review
  // round can reach it to fix it, since the loop only ever edits the body. In the fragment
  // it fails `valid-lang` instead, on an element the Copy Editor can rewrite, which is where
  // that defect should be reported.
  for (const bad of [`korean`, `english (US)`, `en_US`, `zh-Hant-TW-x-far-too-many-subtags`, `e`]) {
    assert.equal(documentLang(`<p lang="${bad}">text</p>`), "en", `hoisted an invalid tag: ${bad}`);
  }
  // And a value carrying a quote would close the attribute this is interpolated into and add
  // markup of its own to the shell. The parser hands it over decoded, so the check is on the
  // decoded value.
  const injected = `<p lang="ko&quot; onmouseover=&quot;alert(1)">text</p>`;
  assert.equal(documentLang(injected), "en");
  const html = wrapDocument(injected);
  assert.match(html, /<html lang="en">/);
  assert.doesNotMatch(html.split("<body>")[0], /onmouseover/, "an attribute escaped into the shell");
});

test("a derived declaration still passes the gate it is invisible to", async () => {
  // `html-has-lang` / `html-lang-valid` pass on the wrong `en` too — that is the reason this
  // defect shipped — so this is not evidence the value is right. What it does check is the
  // direction that could regress: a derived tag must not fail a gate the hardcoded one passed.
  for (const tag of ["ko", "es-419", "zh-Hant-TW"]) {
    const lint = await runAxe(wrapDocument(`<h1 lang="${tag}">Título</h1>\n\n<p lang="${tag}">Texto</p>`));
    assert.ok(lint.ok, `a ${tag} document failed the gate: ${JSON.stringify(lint.violations)}`);
  }
});

test("the markers appended after the body do not change the language it derived", () => {
  // `@page-failed`, `@unresolved` and the rest are English prose, and they are comments
  // outside `<main>`. They are added after the derivation, so a Korean document keeps its
  // declaration when a page of it failed.
  const body = `<section lang="ko"><p>하나</p></section>`;
  const html = wrapDocument(body, { unresolved: ["Heading order is wrong on page 2"], failedPages: [3] });
  assert.match(html, /<html lang="ko">/);
  assert.match(html, /@page-failed 3/);
});

test("runAssembly reports a document that moved off the shell's language, and only then", async () => {
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const ctx = {
    log: { event: (type: string, data: Record<string, unknown> = {}) => events.push({ type, data }) },
  } as unknown as PipelineContext;

  // The ordinary document gains no field, so the line does not grow noise on every run.
  await runAssembly(ctx, [frag(1, `<h1>Report</h1>`), frag(2, `<p>Body</p>`)]);
  const english = events.find((e) => e.type === "assembly")!;
  assert.ok(!("lang" in english.data), `an English run logged a language: ${JSON.stringify(english.data)}`);

  // A document delivered announcing another language should be findable in the log without
  // opening the file: this is the only line that says the pages asked for it.
  events.length = 0;
  await runAssembly(ctx, [frag(1, `<section lang="ko"><h1>보고서</h1></section>`), frag(2, `<section lang="ko"><p>내용</p></section>`)]);
  const korean = events.find((e) => e.type === "assembly")!;
  assert.equal(korean.data.lang, "ko");
});
