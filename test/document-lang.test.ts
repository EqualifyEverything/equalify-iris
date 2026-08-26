import { test } from "node:test";
import assert from "node:assert/strict";
import { bodyLang, wrapDocument } from "../src/pipeline/assembly.ts";

// Issue #163: a document assembled from Korean pages was delivered as `<html lang="en">`.
//
// The defect is one the accessibility gate cannot see and the delivered file does not look
// wrong: `html-has-lang` and `html-lang-valid` both pass, because a confident wrong answer
// is well-formed. What fails is WCAG 3.1.1 — the attribute names the page's default human
// language, a screen reader picks its voice and pronunciation rules from it, and a Korean
// document announced as English is read out by an English voice attempting Korean text. The
// reader who most needs the attribute is the one with no way to see that it is wrong.
//
// #163 has two halves, and they are separately breakable, which is why they are separately
// tested. The page half (test/page-prompt.test.ts) asks each page to say what language it is
// in, even when it never CHANGES language. This half reads that back off the joined body,
// and is only ever as good as the fragments: nothing here guesses.
//
// The rule is agreement, not majority or first-wins. `en` is kept unless every top-level
// element in the body carries a `lang` and they all carry the same one — because a document
// with two languages in it has no single default to declare (that is what per-element `lang`
// is for), and a body whose pages said nothing has nothing to derive from. Failing to `en`
// costs an English-voiced reading of a document that could have been labelled; failing the
// other way — promoting one page's language to the root of a document that is mostly not in
// it — costs a wrong reading of everything else and cannot be detected downstream either.
test("the shell's language is derived from the body only where every top-level element agrees", () => {
  for (const [what, body, expected] of [
    ["one page, one language",
      `<section lang="ko"><h1>보고서</h1></section>`, "ko"],
    ["several pages that agree",
      `<section lang="ko"><p>가</p></section>\n\n<section lang="ko"><p>나</p></section>`, "ko"],
    // Case matters to nobody reading the tag and the agreement is on the language, not on the
    // typing: `KO` and `ko` are the same language, and the first spelling seen is the one
    // declared rather than a normalized one, since either is valid and rewriting a page's own
    // answer buys nothing.
    ["pages that agree but were not typed the same way",
      `<div lang="ko"><p>가</p></div>\n\n<div lang="KO"><p>나</p></div>`, "ko"],
    ["a region subtag is carried through as written",
      `<section lang="zh-Hans"><p>报告</p></section>`, "zh-Hans"],
    ["an unquoted attribute value, which is legal HTML and what a model sometimes writes",
      `<section lang=ko><p>가</p></section>`, "ko"],
    ["single quotes, likewise",
      `<section lang='pt-BR'><p>Relatório</p></section>`, "pt-BR"],
    // The commonest document in the system, and the case that made this list necessary: the
    // page prompt prescribes `<hr role="doc-pagebreak">` between pages, so a multi-page body
    // has a top-level element with no text in it — and therefore no language — between every
    // pair of fragments. Asking it for a `lang` would veto every multi-page document there is.
    ["the page-break separator between fragments is not asked what language it is",
      `<section lang="ko"><p>가</p></section>\n` +
      `<hr role="doc-pagebreak" aria-label="Page 2" id="page-2">\n` +
      `<section lang="ko"><p>나</p></section>`, "ko"],
    // A page whose extraction threw is in the body as a comment (see extraction.ts,
    // `@page-failed`). It bears no content, so it has no language either — and a document
    // that lost a page has already said so; it should not also lose its voice.
    ["a failed page's marker comment does not count against agreement",
      `<!-- @page-failed 2: model returned no html -->\n\n<section lang="ko"><p>가</p></section>`, "ko"],
    ["a body of nothing but that marker has nothing to derive from",
      `<!-- @page-failed 1: model returned no html -->`, null],
    ["two languages: no single default to declare",
      `<section lang="ko"><p>가</p></section>\n\n<section lang="fr"><p>Bonjour</p></section>`, null],
    // Same content in two languages on the facing pages of one document is exactly what #130
    // reported, and the per-element `lang` the prompt asks for is the right answer for it. The
    // root is not.
    ["a language and a variant of it are still two languages at the root",
      `<section lang="en-GB"><p>Colour</p></section>\n\n<section lang="en-US"><p>Color</p></section>`, null],
    ["one silent page drops the whole document, and takes its labelled siblings with it",
      `<section lang="ko"><p>가</p></section>\n\n<section><p>나</p></section>`, null],
    ["a body that says nothing anywhere",
      `<h1>Report</h1>\n\n<p>Text.</p>`, null],
    ["an empty body",
      ``, null],
    // A near-miss value is treated as no value at all, and this is the one place where being
    // strict is the safe direction: `lang` is checked by axe on the root and nowhere else, so
    // promoting an unrecognizable value there would turn a silent 3.1.1 failure into a loud
    // `html-lang-valid` one — a regression bought with a fix.
    ["a language spelled out in words is not a language tag",
      `<section lang="Korean"><p>가</p></section>`, null],
    ["an underscore is not a subtag separator",
      `<section lang="ko_KR"><p>가</p></section>`, null],
    ["an empty attribute",
      `<section lang=""><p>가</p></section>`, null],
    ["whitespace is not a language",
      `<section lang="  "><p>가</p></section>`, null],
    // The attribute has to be `lang` and not merely end in it. `xml:lang` is excluded for the
    // same reason: it is not what `html-has-lang` reads on an HTML document, and a page that
    // wrote only that has not labelled itself where it counts.
    ["a different attribute that happens to end in lang",
      `<section data-lang="ko"><p>가</p></section>`, null],
    ["xml:lang alone is not the attribute the root needs",
      `<section xml:lang="ko"><p>가</p></section>`, null],
    // Only the top level is read. A `lang` on something inside a fragment is a change of
    // language WITHIN a page — the case the attribute exists for — and says nothing about
    // what the page as a whole is in.
    ["a lang deeper in a fragment does not speak for the page",
      `<section><p lang="ko">가</p><p>English text.</p></section>`, null],
    ["nor does one on a nested element of an otherwise labelled page",
      `<section lang="ko"><p>가</p><blockquote lang="en">Quoted.</blockquote></section>`, "ko"],
    // A `lang` value with a `>` in it would end the tag early for a naive scan and could take
    // the rest of the element with it. It is not a language either way.
    ["a value that tries to close the tag",
      `<section lang="ko><p>hidden</p>"><p>가</p></section>`, null],
  ] as [string, string, string | null][]) {
    assert.equal(bodyLang(body), expected, what);
  }
});

// What the derivation is for. `wrapDocument` is the only place the root attribute is written,
// and the assertion is on the shell rather than on `bodyLang` because the shell is what ships.
test("the delivered shell declares the language the body agreed on, and falls back to English", () => {
  const korean = wrapDocument(`<section lang="ko"><h1>보고서</h1></section>`);
  assert.match(korean, /<html lang="ko">/);
  // The one English string in the shell, now sitting inside a root that says `ko`. Without a
  // `lang` of its own it inherits that root and is announced as Korean — WCAG 3.1.2, and
  // audible in the tab title and in whatever reads the document's name aloud. It is only
  // labelled where it needs to be: an `en` document does not want `lang="en"` repeated on it.
  assert.match(korean, /<title lang="en">Accessible document<\/title>/);

  const english = wrapDocument(`<h1>Report</h1>`);
  assert.match(english, /<html lang="en">/);
  assert.match(english, /<title>Accessible document<\/title>/);

  // A regional variant of English is still English for the title's purposes; the label would
  // be noise.
  assert.match(wrapDocument(`<section lang="en-GB"><p>Colour</p></section>`), /<html lang="en-GB">/);
  assert.match(wrapDocument(`<section lang="en-GB"><p>Colour</p></section>`), /<title>Accessible/);

  // A body deriving nothing is delivered exactly as it was before #163 — the fallback is the
  // old behaviour, not a new one, and every other document in the test suite depends on it.
  assert.match(wrapDocument(`<section lang="ko"><p>가</p></section>\n\n<section><p>나</p></section>`),
    /<html lang="en">/);

  // The value reaches an attribute, so it has to be a value that cannot leave one. `bodyLang`
  // refuses anything that is not shaped like a language tag, which is what makes that true;
  // this pins the consequence rather than the mechanism, since it is the consequence a later
  // change to the tag pattern would have to keep.
  assert.match(wrapDocument(`<section lang="ko&quot;><script>alert(1)</script>"><p>가</p></section>`),
    /<html lang="en">/);
});
