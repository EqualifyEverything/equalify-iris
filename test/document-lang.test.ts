import { test } from "node:test";
import assert from "node:assert/strict";
import { bodyLang, wrapDocument } from "../src/pipeline/assembly.ts";
import { titledAs } from "../src/util/outputNames.ts";
import { runAxe } from "../src/pipeline/lint.ts";

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
    ["a tag the canonicalizer refuses outright",
      `<section lang="ko-x"><p>가</p></section>`, null],
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
    // The attributes are read one at a time rather than searched for ` lang=`, because a search
    // finds the string inside another attribute's value — and `title`/`alt`/`aria-label` text
    // comes from the page, so a page whose caption mentions a language tag would set the
    // document's language.
    ["a language tag inside another attribute's value is not this element's language",
      `<section title="see lang=fr note"><p>English.</p></section>`, null],
    ["nor does it override a real one",
      `<section title="the lang=fr column" lang="ko"><p>가</p></section>`, "ko"],
    ["an attribute whose name merely starts with lang",
      `<section langue="ko"><p>가</p></section>`, null],
    // A page that omitted an end tag is not a page that said nothing: an unclosed element
    // swallows every page after it, so the one tag a top-level scan reads for that whole run is
    // the FIRST page's — which is one page's answer promoted to the root of a document mostly not
    // in it. Nothing here can tell a run holding one element from a run holding five, so the
    // derivation is refused. Omitted end tags are ordinary model output (`sections.ts` handles
    // implied ends for exactly that reason) and nothing rejects an unbalanced fragment, so this
    // is reachable input rather than a hypothetical.
    ["an unclosed element that swallows the English pages after it",
      `<section lang="ko"><p>가</p>\n\n<section><h1>English report</h1></section>\n<p>More English.</p>`, null],
    ["an unclosed div with English content after it",
      `<div lang="ko"><p>나</p>\n\n<h1>Hello</h1>\n<p>English body text.</p>`, null],
    ["and the same shape with nothing after it, since the two cannot be told apart",
      `<section lang="ko"><p>가</p>`, null],
    // Top-level text belongs to no element, so no `lang` covers it. The scan therefore reads a
    // segment only when it BEGINS with a start tag, which is also what refuses a stray end tag.
    ["stray prose before a labelled fragment",
      `Preamble text.\n<section lang="ko"><p>가</p></section>`, null],
    ["stray prose between two labelled fragments",
      `<section lang="ko"><p>가</p></section>\nContinued overleaf.\n<section lang="ko"><p>나</p></section>`, null],
    ["stray prose after a labelled fragment",
      `<section lang="ko"><p>가</p></section>\nEnd of document.`, null],
    ["a stray end tag at top level",
      `<section lang="ko"><p>가</p></section>\n</div>\n<section lang="ko"><p>나</p></section>`, null],
    // Whitespace between fragments is what `assembleBody` joins with, so it must not count as
    // text that nothing claims.
    ["the blank line assembly joins fragments with",
      `<section lang="ko"><p>가</p></section>\n\n<section lang="ko"><p>나</p></section>\n`, "ko"],
    // A tag with a preferred form is delivered IN that form. `kor` is what a page writes when
    // told to "use the BCP 47 tag", and measured against this repo's axe it fails
    // `html-lang-valid` — so refusing it (fall back to `en`) and promoting it as written (ship a
    // violation on the root) are both worse than answering with the tag it means.
    ["a deprecated three-letter code becomes the two-letter one it means",
      `<section lang="kor"><p>가</p></section>`, "ko"],
    ["and so does a deprecated two-letter one",
      `<section lang="iw"><p>טקסט</p></section>`, "he"],
    ["a three-letter code with no two-letter equivalent is a language and is kept",
      `<section lang="haw"><p>ʻōlelo</p></section>`, "haw"],
    ["ditto Cherokee, Filipino, Cantonese",
      `<section lang="chr"><p>ᏣᎳᎩ</p></section>`, "chr"],
    // Which makes two spellings of one language an agreement rather than a conflict — they are
    // the same language, and a document is not multilingual because two pages chose differently.
    ["two pages naming the same language two ways agree",
      `<section lang="ko"><p>가</p></section>\n\n<section lang="kor"><p>나</p></section>`, "ko"],
  ] as [string, string, string | null][]) {
    assert.equal(bodyLang(body), expected, what);
  }
});

// The measurement the strictness above rests on, run rather than asserted from memory: axe
// validates a `lang` against the registry's PREFERRED values, so the three-letter codes that have
// a two-letter equivalent are the ones it refuses. If that ever stops being true, the rule in
// `preferredTag` is either too strict or not strict enough and this is the test that says so.
// `html-lang-valid` is the rule that judges the root and only the root; `valid-lang` judges every
// other element. So the third column is the fragment's own answer being reported where it was
// written — a body issue the review loop can correct, which is not something the root should paper
// over — while the first two say the root itself is never the violation.
test("every language the shell will declare is one the linter accepts", async () => {
  for (const [written, root, fragmentFlagged] of [
    ["ko", "ko", false], ["zh-Hans", "zh-Hans", false], ["pt-BR", "pt-BR", false],
    ["haw", "haw", false], ["chr", "chr", false],
    // The interesting rows: written by the page in a form axe refuses, delivered in one it accepts.
    ["kor", "ko", true], ["spa", "es", true], ["eng", "en", true],
    // A deprecated two-letter code axe happens to accept is still delivered in its preferred form.
    ["iw", "he", false],
    // And the ones that derive nothing, where the root has to be a clean `en` all the same.
    ["Korean", "en", true], ["ko_KR", "en", true],
  ] as [string, string, boolean][]) {
    const html = wrapDocument(`<section lang="${written}"><h1>제목</h1><p>본문 텍스트</p></section>`);
    assert.match(html, new RegExp(`<html lang="${root}">`), `lang="${written}" should derive ${root}`);
    const lint = await runAxe(html);
    const ids = (lint.violations ?? []).map((v) => v.id);
    assert.ok(!ids.includes("html-lang-valid"), `lang="${written}" delivered a root axe rejects`);
    assert.ok(!ids.includes("html-has-lang"), `lang="${written}" delivered a root with no language`);
    assert.equal(ids.includes("valid-lang"), fragmentFlagged,
      `lang="${written}": the fragment's own attribute should ${fragmentFlagged ? "" : "not "}be reported`);
  }
});

// #163's fix labelled the shell's `<title lang="en">` on a non-English document, and the served
// title is patched by a regex one module away (`titledAs`, used by GET /output). The two met badly:
// a pattern matching only a bare `<title>` no-opped on precisely the documents that had just been
// given a truthful root language, so a Korean document was delivered with the placeholder name
// while its download filename still mirrored the upload — WCAG 2.4.2 lost where 3.1.1 was won.
test("the served title mirrors the upload whatever attributes the shell put on it", () => {
  const korean = titledAs(wrapDocument(`<section lang="ko"><h1>보고서</h1></section>`), "보고서-2026");
  assert.match(korean, /<title lang="en">보고서-2026<\/title>/);
  const english = titledAs(wrapDocument(`<h1>Report</h1>`), "quarterly");
  assert.match(english, /<title>quarterly<\/title>/);
  // The name is user input on its way into markup, and into a replacement string.
  assert.match(titledAs(wrapDocument(`<h1>x</h1>`), `a&b<script>`), /<title>a&amp;b&lt;script><\/title>/);
  assert.match(titledAs(wrapDocument(`<h1>x</h1>`), `$&$1`), /<title>\$&amp;\$1<\/title>/);
  // One title, and only the title: the shell's is the first `<title>` in the document, and a body
  // that contains the string must not be rewritten by it.
  assert.equal((titledAs(wrapDocument(`<h1>x</h1>`), "y").match(/<title/g) ?? []).length, 1);
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
