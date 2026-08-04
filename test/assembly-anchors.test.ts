import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleBody, assembleBodyWithReport, runAssembly, wrapDocument } from "../src/pipeline/assembly.ts";
import { runAxe } from "../src/pipeline/lint.ts";
import type { Fragment } from "../src/pipeline/fragment.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";

// Assembly is where per-page output becomes one document, and ids are the thing that
// cannot survive that join untouched. Each page is extracted alone and concurrently,
// so a page numbering its first footnote "1" has no way to know another page did the
// same — and the page prompt asks for exactly those ids by name (`id="fn-N"`,
// `href="#fn-N"`, "preserve the original numbering"). A multi-page scan where each
// page carries a footnote 1 is the ordinary case.
//
// That defect is invisible in every way that usually catches things: both notes are
// present, both are announced, the link works, and the axe gate passes it (WCAG 2.2
// dropped 4.1.1, so `duplicate-id` is tagged obsolete and filtered out). The only
// symptom is that a screen-reader user following the reference on page 3 arrives at
// page 1's note.
//
// The fix has a narrow correct scope, and both edges are pinned here. Renaming every
// id — the first attempt — fixed collisions and broke the references that legitimately
// span a page break: a `<label for>` whose input is on the next page, or endnotes with
// continuous numbering. Those resolved correctly BEFORE assembly touched them, and
// trading a wrong-target reference for a no-target one is not a fix; for
// `for`/`headers`/`aria-*` it is a real 1.3.1/4.1.2 failure introduced by the
// assembler. So only ids that more than one page claims are renamed.

function frag(order: number, innerHtml: string): Fragment {
  return {
    image: `page-00${order}.png`,
    order,
    agent: "page.md",
    region: "page",
    innerHtml,
    edges: [],
    log: "",
  };
}

// The shape the page prompt asks for, with the numbering the source shows.
const footnotePage = (n: number) =>
  `<p>Body text<sup><a href="#fn-${n}" id="fnref-${n}">${n}</a></sup></p>\n` +
  `<ol><li id="fn-${n}">Note ${n} on this page. <a href="#fnref-${n}">↩</a></li></ol>`;

const idsOf = (html: string) => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const fragHrefs = (html: string) => [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);

test("two pages that both numbered a footnote 1 do not collide in the document", () => {
  const body = assembleBody([frag(1, footnotePage(1)), frag(2, footnotePage(1))]);
  const ids = idsOf(body);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids survived assembly: ${ids.join(", ")}`);
  // Sanity: the ids are still there to be unique. A namespacing bug that dropped
  // them, or a test fixture that stopped emitting them, would otherwise pass.
  assert.equal(ids.length, 4, `expected 2 ids per page, got: ${ids.join(", ")}`);
});

test("each footnote reference still resolves to its own page's note", () => {
  const body = assembleBody([frag(1, footnotePage(1)), frag(2, footnotePage(1)), frag(3, footnotePage(1))]);
  // Uniqueness alone is not the property that matters — ids could be made unique
  // while every href still pointed at page 1. Check the pairing: within each page,
  // the marker's href must name that page's own note id.
  for (const page of [1, 2, 3]) {
    assert.match(body, new RegExp(`href="#p${page}-fn-1" id="p${page}-fnref-1"`), `page ${page}'s marker does not link to its own note`);
    assert.match(body, new RegExp(`<li id="p${page}-fn-1">Note 1`), `page ${page}'s note id was not namespaced`);
    assert.match(body, new RegExp(`<a href="#p${page}-fnref-1">↩`), `page ${page}'s back-reference was not rewritten`);
  }
  // Every fragment link resolves to an id that exists — no href was rewritten to a
  // target that is not there, and none was left pointing at another page's note.
  const ids = new Set(idsOf(body));
  for (const href of fragHrefs(body)) assert.ok(ids.has(href), `href="#${href}" resolves to nothing`);
});

test("the prefix follows the page's order, not its position in the array", () => {
  // Fragments arrive in whatever order the concurrent extractions finished;
  // `assembleBody` sorts by `.order`. If the prefix came from the array index, the
  // ids in a delivered document would depend on scheduling — different on a re-run
  // of the same input, and not matching the page numbers the Reader attributes
  // issues to or the unresolved comment cites.
  const body = assembleBody([frag(3, footnotePage(1)), frag(1, footnotePage(1))]);
  assert.deepEqual(idsOf(body), ["p1-fnref-1", "p1-fn-1", "p3-fnref-1", "p3-fn-1"]);
});

// The other edge, and the reason renaming is scoped to collisions. These two shapes
// worked before any namespacing existed, so breaking them would mean the assembler
// introducing a defect into content that was correct when the page produced it.
test("a form split across a page break keeps its label associated", () => {
  // `<label for="q1">` on page 1, `<input id="q1">` on page 2. No collision, so
  // nothing is renamed and the reference still resolves. Prefixing the input's id
  // (and not the label's `for`, which the label's page does not own) is what an
  // unconditional rename does, and it costs the field its accessible name.
  const body = assembleBody([
    frag(1, `<h1>Form</h1><label for="q1">Your name</label>`),
    frag(2, `<input id="q1" type="text"><p>rest</p>`),
  ]);
  assert.match(body, /<label for="q1">/, "the label's `for` was rewritten");
  assert.match(body, /id="q1"/, "the input's id was rewritten away from its label");
  assert.doesNotMatch(body, /id="p2-q1"/, "the input's id was namespaced despite no collision");
});

test("a form split across a page break is still axe-clean", async () => {
  // The assertion above is about the markup; this is about the consequence. A
  // dangling `for` is not a stylistic matter — axe reports it as a `label`
  // violation, so the review loop would spend iterations on a defect assembly
  // created.
  const body = assembleBody([
    frag(1, `<h1>Form</h1><label for="q1">Your name</label>`),
    frag(2, `<input id="q1" type="text"><p>rest</p>`),
  ]);
  const lint = await runAxe(wrapDocument(body));
  if (lint.error) return; // axe could not run here; runAxe degrades to a parse check
  assert.equal(
    lint.violations.map((v) => v.id).join(", "),
    "",
    "assembly introduced a lint violation into a document that was clean",
  );
});

test("endnotes collected on a later page still round-trip", () => {
  // Continuous numbering with the notes at the back — the normal shape for a scanned
  // report, and one where no id collides. Both directions have to survive: the
  // marker's link forward to the note, and the note's back-reference to the marker.
  const body = assembleBody([
    frag(1, `<p>Claim<sup><a href="#fn-1" id="fnref-1">1</a></sup></p>`),
    frag(2, `<p>More<sup><a href="#fn-2" id="fnref-2">2</a></sup></p>`),
    frag(3, `<ol><li id="fn-1">First <a href="#fnref-1">↩</a></li><li id="fn-2">Second <a href="#fnref-2">↩</a></li></ol>`),
  ]);
  const ids = new Set(idsOf(body));
  for (const href of fragHrefs(body)) assert.ok(ids.has(href), `href="#${href}" no longer resolves`);
  assert.equal(ids.size, 4, `expected 4 ids, got: ${[...ids].join(", ")}`);
  assert.doesNotMatch(body, /id="p\d+-/, "ids were namespaced although nothing collided");
});

test("a cross-page reference survives in a document that DOES have a collision", () => {
  // The case that matters, and the one the two tests above cannot reach. They contain
  // no colliding id at all, so they are protected by the document-level "nothing
  // collides, change nothing" short-circuit — they would still pass if every id on a
  // rewritten page were renamed. A real document mixes the two: per-page footnotes
  // numbered 1 (colliding, must be renamed) alongside a form or an endnote reference
  // that spans a page break (not colliding, must be left alone). Renaming per PAGE
  // rather than per ID breaks the second while fixing the first.
  const body = assembleBody([
    frag(1, `${footnotePage(1)}<label for="q1">Your name</label>`),
    frag(2, `${footnotePage(1)}<input id="q1" type="text">`),
  ]);
  // The colliding footnote ids are namespaced and each marker points at its own note.
  assert.match(body, /href="#p1-fn-1" id="p1-fnref-1"/);
  assert.match(body, /href="#p2-fn-1" id="p2-fnref-1"/);
  // The non-colliding pair, on the same rewritten pages, is untouched.
  assert.match(body, /<label for="q1">/, "a non-colliding `for` was rewritten on a page that had a collision");
  assert.match(body, /<input id="q1"/, "a non-colliding id was rewritten because its page had a collision");
  assert.doesNotMatch(body, /"p\d+-q1"/, "the label/input pair was namespaced and no longer matches");
  const ids = new Set(idsOf(body));
  for (const href of fragHrefs(body)) assert.ok(ids.has(href), `href="#${href}" resolves to nothing`);
});

test("a document with nothing colliding is passed through untouched", () => {
  // The overwhelmingly common case. Nothing is parsed and reserialized, so each page
  // is delivered exactly as its agent wrote it. The fixture is markup jsdom rewrites
  // on a round-trip — bare `required` becomes `required=""`, a `<table>` gains a
  // `<tbody>` — because already-canonical HTML would come back identical either way
  // and assert nothing.
  const p1 = `<h1 id="title">Title</h1>\n<label>Name <input type="text" required></label>`;
  const p2 = `<table><tr><td>1994</td></tr></table>`;
  const { body, anchors } = assembleBodyWithReport([frag(1, p1), frag(2, p2)]);
  assert.equal(body, `${p1}\n\n${p2}`);
  assert.deepEqual(anchors.collisions, []);
});

test("references that are not ids at all are untouched", () => {
  const body = assembleBody([
    frag(1, `<p id="top">Top</p><p><a href="#">Nowhere</a> <a href="#top">Up</a> <a href="https://example.org/#top">Out</a></p>`),
    frag(2, `<p id="top">Also top</p>`), // forces `top` to collide, so page 1 is rewritten
  ]);
  assert.match(body, /href="#"/, "a bare #href was prefixed into an id reference");
  assert.match(body, /href="#p1-top"/, "an in-page reference to a colliding id was not rewritten");
  assert.match(body, /href="https:\/\/example\.org\/#top"/, "an external URL's fragment was rewritten");
});

// Namespacing ids without namespacing what points at them would be worse than the
// collision it fixes. `for`, `headers` and the aria-* references are how a field
// gets its accessible name and how a data cell is attributed to its headers.
test("every kind of id reference is rewritten with the id, not just href", () => {
  const page = (suffix: string) =>
    `<label for="q1">Name</label><input id="q1" aria-describedby="h1 h2">` +
    `<p id="h1">Hint one${suffix}</p><p id="h2">Hint two</p>` +
    `<table><tr><th id="c1">Year</th><td headers="c1">1994</td></tr></table>` +
    `<div aria-labelledby="h1"></div>`;
  // Two pages of the same form, so every id collides and both pages are rewritten.
  const body = assembleBody([frag(1, page("")), frag(2, page(" again"))]);
  assert.match(body, /<label for="p2-q1">/, "label/for lost its target — the field has no accessible name");
  assert.match(body, /aria-describedby="p2-h1 p2-h2"/, "a multi-token idref list was not fully rewritten");
  assert.match(body, /headers="p2-c1"/, "a data cell lost its header association");
  assert.match(body, /aria-labelledby="p2-h1"/, "aria-labelledby was not rewritten");
  const ids = new Set(idsOf(body));
  for (const ref of [...body.matchAll(/(?:for|headers|aria-describedby|aria-labelledby)="([^"]+)"/g)].flatMap((m) => m[1].split(" "))) {
    assert.ok(ids.has(ref), `"${ref}" is referenced but no element has that id`);
  }
});

test("a reference to a colliding id the page does not own goes to the first owner, and is reported", () => {
  // The genuinely ambiguous case: `fn-1` exists on pages 1 and 2, and page 3 links to
  // it. No page can say which copy was meant. Leaving it as written was the first
  // answer and it was the wrong one — every owner gets renamed, so the reference then
  // resolves to nothing at all, and the assembler has turned a wrong-target link into
  // a dead one. It is repointed at the FIRST owner in document order instead: exactly
  // where a browser sent the bare reference before any of this ran, so nothing is made
  // worse, and the association survives. Reported either way, because a reference
  // disambiguated by document order rather than by the agent that wrote it deserves an
  // eye.
  //
  // Page 3 owns a colliding id of its own (`fn-9`) as well as referencing `fn-1`.
  // Without that it would exit before the reference-rewriting loop is even reached,
  // and this test would be asserting the has-nothing-to-rename shortcut rather than
  // the ownership rule — a version that rewrote every reference to a colliding id
  // would still pass.
  const { body, anchors } = assembleBodyWithReport([
    frag(1, `<ol><li id="fn-1">One</li></ol>`),
    frag(2, `<ol><li id="fn-1">Two</li></ol><p id="fn-9">Nine here too</p>`),
    frag(3, `<p>See<sup><a href="#fn-1">1</a></sup> and<sup><a href="#fn-9">9</a></sup></p><ol start="9"><li id="fn-9">Nine</li></ol>`),
  ]);
  assert.match(body, /href="#p1-fn-1"/, "an ambiguous reference was not sent to the first owner");
  assert.doesNotMatch(body, /href="#fn-1"/, "an ambiguous reference was left pointing at an id nothing has");
  // The reference page 3 DOES own goes to page 3's own copy, not to page 2's — which
  // is the first owner of `fn-9`. Ownership wins over document order, and this also
  // proves the page reached the rewriting loop rather than being skipped.
  assert.match(body, /href="#p3-fn-9"/, "page 3's own colliding reference was not rewritten to its own copy");
  assert.deepEqual(anchors.collisions, ["fn-1", "fn-9"]);
  assert.deepEqual(anchors.ambiguous, [{ page: 3, ref: "fn-1" }]);
  const ids = new Set(idsOf(body));
  for (const href of fragHrefs(body)) assert.ok(ids.has(href), `href="#${href}" resolves to nothing`);
});

test("a page with no ids of its own has its ambiguous references repointed and reported", () => {
  // The marker page: it links `#fn-1` and `#fn-2` and emits no id at all, while the
  // notes are duplicated across two later pages. That shape is the one whose links go
  // dead, and it is also the one the ownership pass skips — a page with no ids cannot
  // contribute a collision, so it is never parsed for ownership and its references are
  // invisible unless they are looked for separately. Fixing only the pages that own a
  // colliding id would move the dangling-reference bug here rather than remove it.
  const { body, anchors } = assembleBodyWithReport([
    frag(1, `<p>See<sup><a href="#fn-1">1</a></sup> and<sup><a href="#fn-2">2</a></sup></p>`),
    frag(2, `<ol><li id="fn-1">One</li><li id="fn-2">Two</li></ol>`),
    frag(3, `<ol><li id="fn-1">One again</li><li id="fn-2">Two again</li></ol>`),
  ]);
  assert.deepEqual(anchors.collisions, ["fn-1", "fn-2"]);
  assert.deepEqual(anchors.ambiguous, [
    { page: 1, ref: "fn-1" },
    { page: 1, ref: "fn-2" },
  ]);
  assert.match(body, /href="#p2-fn-1"/, "the marker page's reference was left dangling");
  assert.match(body, /href="#p2-fn-2"/, "the marker page's reference was left dangling");
  const ids = new Set(idsOf(body));
  for (const href of fragHrefs(body)) assert.ok(ids.has(href), `href="#${href}" resolves to nothing`);
});

test("a third page claiming an id does not cost a label its field", async () => {
  // Where leaving an ambiguous reference alone showed its cost as a real violation,
  // not just a dead anchor. A form whose `<label for="q1">` is on page 1 and whose
  // `<input id="q1">` is on page 2 is the split-form case above and works untouched —
  // until a THIRD page carries a repeat of the same field. Now `q1` collides, every
  // owner is renamed, and page 1's label, which named the right control before
  // assembly existed, points at nothing: the field loses its accessible name and axe
  // reports `label` on a document that was clean under a plain concatenation.
  const frags = [
    frag(1, `<h1>Form</h1><label for="q1">Your name</label>`),
    frag(2, `<form><input id="q1" type="text"></form>`),
    frag(3, `<form><label for="q1">Your name</label><input id="q1" type="text"></form>`),
  ];
  const { body, anchors } = assembleBodyWithReport(frags);
  assert.deepEqual(anchors.collisions, ["q1"]);
  assert.deepEqual(anchors.ambiguous, [{ page: 1, ref: "q1" }]);
  // Page 1's `for` follows document order to page 2's input; page 3's label and input
  // were written together, so they stay paired with each other.
  assert.match(body, /<label for="p2-q1">Your name<\/label>/, "the orphaned label was not repointed");
  assert.match(body, /<label for="p3-q1">Your name<\/label><input id="p3-q1"/, "page 3's own pair was broken");
  const lint = await runAxe(wrapDocument(body));
  if (lint.error) return;
  assert.equal(
    lint.violations.map((v) => v.id).join(", "),
    "",
    "assembly introduced a violation into a document a plain concatenation passed",
  );
});

test("runAssembly logs what the join did, and only when it did something", async () => {
  // The report's whole purpose is that a reference resolved by document order rather
  // than by the agent that wrote it is findable. It reaches a human through this log
  // line, so an unlogged report is the same as no report — and a line on every ordinary
  // run is noise that gets ignored, which comes to the same thing.
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const ctx = {
    log: { event: (type: string, data: Record<string, unknown> = {}) => events.push({ type, data }) },
  } as unknown as PipelineContext;

  await runAssembly(ctx, [frag(1, `<p id="intro">Clean</p>`), frag(2, `<p>Nothing to collide</p>`)]);
  assert.deepEqual(events.filter((e) => e.type === "assembly_anchors"), [], "an ordinary document logged an anchor line");

  events.length = 0;
  await runAssembly(ctx, [
    frag(1, `<ol><li id="fn-1">One</li></ol>`),
    frag(2, `<ol><li id="fn-1">Two</li></ol>`),
    frag(3, `<p>See<sup><a href="#fn-1">1</a></sup></p>`),
  ]);
  const logged = events.filter((e) => e.type === "assembly_anchors");
  assert.equal(logged.length, 1, "the namespacing was not reported");
  assert.deepEqual(logged[0].data.collisions, ["fn-1"]);
  assert.deepEqual(logged[0].data.ambiguous, ["page 3: #fn-1"], "the ambiguous reference was not named");
});

test("a page that would lose markup on reserialization is left as the agent wrote it", () => {
  // A stray `<tr>` outside a `<table>` — a plausible emission for a table continuing
  // across a page break — is foster-parented by the HTML parser: the row and cell
  // vanish and only their text survives, without any error. Reserializing that would
  // silently discard structure. So the rewrite is abandoned for that page: the
  // collision survives (and lint's `duplicate-id` reports it), which is strictly
  // better than losing a table row from the deliverable.
  const stray = `<p id="fn-1">A</p><tr><td>IMPORTANT DATA</td></tr>`;
  const { body, anchors } = assembleBodyWithReport([frag(1, `<p id="fn-1">B</p>`), frag(2, stray)]);
  assert.match(body, /<tr><td>IMPORTANT DATA<\/td><\/tr>/, "a table row was dropped by reserialization");
  assert.deepEqual(anchors.skipped_pages, [2]);
  assert.match(body, /<p id="fn-1">A<\/p>/, "page 2 was rewritten despite the markup risk");
});

test("a reference whose first owner was left as written stays bare, so it still resolves", () => {
  // The two mechanisms meeting. Page 1 owns `fn-1` and cannot be rewritten (the stray
  // `<tr>` would be foster-parented away), so it keeps the BARE id. Page 2 owns `fn-1`
  // too and is renamed. Page 3 references `fn-1` and owns neither copy, so it follows
  // document order to page 1 — which means the reference has to stay bare as well.
  // Prefixing it unconditionally would point it at `p1-fn-1`, an id that page 1 never
  // got, and the reference would resolve to nothing: exactly the dangling-reference
  // defect, reintroduced through the skip path.
  const { body, anchors } = assembleBodyWithReport([
    frag(1, `<p id="fn-1">A</p><tr><td>IMPORTANT DATA</td></tr>`),
    frag(2, `<p id="fn-1">B</p>`),
    frag(3, `<p>See<sup><a href="#fn-1">1</a></sup></p>`),
  ]);
  assert.deepEqual(anchors.skipped_pages, [1]);
  assert.deepEqual(anchors.ambiguous, [{ page: 3, ref: "fn-1" }]);
  assert.match(body, /href="#fn-1"/, "the reference was prefixed to an id its owner never received");
  assert.match(body, /id="p2-fn-1"/, "page 2 was not renamed, so this asserts nothing about the skip");
  const ids = new Set(idsOf(body));
  for (const href of fragHrefs(body)) assert.ok(ids.has(href), `href="#${href}" resolves to nothing`);
});

test("parsing that legitimately adds elements is not mistaken for a loss", () => {
  // Two shapes where the parse produces MORE than the source wrote, both harmless:
  //
  //   * A well-formed `<table><tr>` gains the `<tbody>` the source omitted. That tag
  //     is absent from the source counts, so it is never compared — but a check
  //     written as "the counts must match" would abandon the rewrite on most real
  //     tables, leaving exactly the collisions this function exists to fix.
  //   * The parser DUPLICATES a tag to repair misnesting: `<b>1<p>2</b>3</p>` becomes
  //     `<b>1</b><p><b>2</b>3</p>`, two `<b>` from one source `<b>`. An
  //     inequality check catches this one even though no content was lost, which is
  //     why the comparison is one-directional.
  const page = `<table><tr><th id="c1">Year</th><td headers="c1">1994</td></tr></table><b>1<p>2</b>3</p>`;
  const { body, anchors } = assembleBodyWithReport([frag(1, page), frag(2, page)]);
  assert.deepEqual(anchors.skipped_pages, [], "a page that loses nothing was skipped");
  assert.match(body, /id="p2-c1"/, "the rewrite was skipped for a page that loses nothing");
  assert.match(body, /<tbody>/, "the fixture no longer exercises tbody insertion");
  assert.match(body, /<b>1<\/b><p><b>2<\/b>3<\/p>/, "the fixture no longer exercises tag duplication");
});

test("no content is lost on a page the rewrite actually touches", () => {
  // namespaceAnchors is not a validator. Whatever the agent emitted is what the rest
  // of the pipeline reviews, so this must never drop text — the review loop and the
  // lint gate are what judge the markup.
  //
  // Both pages carry `fn-1` so the rewrite runs; a single page would collide with
  // nothing and be returned by the short-circuit, which would make this test assert
  // the pass-through rather than the rewrite. The markup is deliberately sloppy
  // (unclosed tags, misnesting) because that is what a page whose content ran off an
  // edge tends to look like, and it is where a reserialization bug would bite.
  const { body } = assembleBodyWithReport([
    frag(1, `<p id="fn-1">Unclosed <div><span>nested one`),
    frag(2, `<p id="fn-1">Second <b>page<i>text</b> tail</p>`),
  ]);
  for (const word of ["Unclosed", "nested one", "Second", "page", "text", "tail"]) {
    assert.match(body, new RegExp(word), `"${word}" was lost`);
  }
  assert.match(body, /id="p1-fn-1"/, "the rewrite did not run, so this asserts nothing");
  assert.match(body, /id="p2-fn-1"/, "the rewrite did not run, so this asserts nothing");
});

// The two halves of the fix are independent and both load-bearing: assembly prevents
// the collision, and lint catches one the Copy Editor reintroduces when it rewrites
// the whole body. Asserting the gate directly, because the tag filter is what hid
// this in the first place.
test("axe reports a duplicate id, which the WCAG tag filter alone does not", async () => {
  const colliding = `${footnotePage(1)}\n\n${footnotePage(1)}`;
  const lint = await runAxe(wrapDocument(colliding));
  if (lint.error) return;
  assert.equal(lint.ok, false, 'a document with two id="fn-1" passed the lint gate');
  assert.ok(
    lint.violations.some((v) => v.id.startsWith("duplicate-id")),
    `expected a duplicate-id violation, got: ${lint.violations.map((v) => v.id).join(", ") || "none"}`,
  );
});

// axe splits duplicate ids across three rules by what the element IS, and each skips
// the others' elements. Enabling `duplicate-id` alone covered only the least harmful
// third of the problem. Each case below was clean under some earlier version of this
// gate; they are separate tests so a regression names which third came back.
test("the duplicate-id backstop covers a static element", async () => {
  const lint = await runAxe(wrapDocument(`<ul><li id="y">1</li><li id="y">2</li></ul>`));
  if (lint.error) return;
  assert.deepEqual(lint.violations.map((v) => v.id), ["duplicate-id"]);
});

test("the duplicate-id backstop covers a focusable element", async () => {
  // `duplicate-id` requires that NO element with the id is focusable, so two `<a id>`
  // fall to `duplicate-id-active` — obsolete-tagged, therefore excluded by the WCAG tag
  // filter and enabled by name.
  const lint = await runAxe(wrapDocument(`<p><a id="x" href="/a">a</a><a id="x" href="/b">b</a></p>`));
  if (lint.error) return;
  assert.deepEqual(lint.violations.map((v) => v.id), ["duplicate-id-active"]);
});

test("the duplicate-id backstop covers a referenced element, which axe reports as incomplete", async () => {
  // The case with the clearest user harm, and the last one to be caught: an id that
  // something REFERENCES belongs to neither obsolete rule (both require that the id is
  // not an accessibility reference target) but to `duplicate-id-aria` — which is live
  // WCAG 4.1.2 and in via the tag filter, yet `reviewOnFail`, so axe files it under
  // `incomplete` and a gate reading only `violations` passes it. Two `<input id="q1">`
  // under one `<label for="q1">` is exactly the shape assembly can produce, and exactly
  // what makes a control announce the wrong name.
  const lint = await runAxe(wrapDocument(`<form><label for="q1">A</label><input id="q1"><input id="q1"></form>`));
  if (lint.error) return;
  assert.deepEqual(lint.violations.map((v) => v.id), ["duplicate-id-aria"]);
});

test("promoting duplicate-id-aria does not drag the rest of incomplete in with it", async () => {
  // The promotion is scoped to one rule by name, because the rest of `incomplete` is
  // genuinely can't-tell-without-rendering and promoting it would fail runs over
  // nothing. `frame-title-unique` is the fixture: it is another `reviewOnFail` rule in
  // the same tag set, and two same-titled iframes put it in `incomplete` — so widening
  // the filter to all of `incomplete` shows up here as a failure. A document without an
  // ambiguous id must stay clean.
  const lint = await runAxe(wrapDocument(`<iframe title="Chart" src="a"></iframe><iframe title="Chart" src="b"></iframe>`));
  if (lint.error) return;
  assert.equal(lint.violations.map((v) => v.id).join(", "), "", "an incomplete result other than duplicate-id-aria was promoted");
  assert.equal(lint.ok, true);
});

test("the assembled document passes the gate that the colliding one fails", async () => {
  // The same content, joined properly. Without this the test above would pass for a
  // gate that fails everything, and the fix would be indistinguishable from a
  // permanently red lint.
  const lint = await runAxe(wrapDocument(assembleBody([frag(1, footnotePage(1)), frag(2, footnotePage(1))])));
  if (lint.error) return;
  // Compared as a joined string, not with deepEqual: `runAxe` builds this array with
  // the jsdom realm's `Array.prototype.map`, so it fails deepStrictEqual's prototype
  // check against a literal `[]` even when both are empty.
  assert.equal(lint.violations.map((v) => v.id).join(", "), "", "the namespaced document does not pass lint");
  assert.equal(lint.ok, true);
});
