import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { assembleBody, assembleBodyWithReport, runAssembly, wrapDocument } from "../src/pipeline/assembly.ts";
import { runAxe } from "../src/pipeline/lint.ts";
import { ATTR_SEP, sourceIds, sourceRefs } from "../src/pipeline/anchors.ts";
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

test("the prefix cannot land on an id a page already claims", async () => {
  // The rename must not manufacture the collision it exists to remove. `p1-total`,
  // `p2-name` and the like are what a paginated form or worksheet emits, and the page
  // agent has no idea the assembler reserves that shape.
  //
  // Here `x` collides across pages 1 and 2, and page 2 also carries a working
  // `<label for="p1-x">`/`<input id="p1-x">` pair. A prefix applied without checking
  // turns page 1's `x` into `p1-x`, so two elements own it and page 2's label — correct
  // before assembly touched anything — resolves to page 1's `<p>`, which is not
  // labelable. The field loses its accessible name, and nothing in the report says so:
  // page 2 owns `p1-x`, so the reference is not ambiguous, and no page was skipped.
  const frags = [
    frag(1, `<p id="x">page one x</p>`),
    frag(2, `<p id="x">two</p><label for="p1-x">Field</label><input id="p1-x">`),
  ];
  const { body } = assembleBodyWithReport(frags);
  const ids = idsOf(body);
  assert.equal(new Set(ids).size, ids.length, `the rename created a duplicate id: ${ids.join(", ")}`);
  // The pre-existing pair is what it was, and still points at its own field.
  assert.match(body, /<label for="p1-x">Field<\/label><input id="p1-x">/, "an id the page wrote itself was disturbed");
  const lint = await runAxe(wrapDocument(body));
  if (lint.error) return;
  assert.equal(
    lint.violations.map((v) => v.id).join(", "),
    "",
    "assembly introduced a duplicate id into a document that was clean",
  );
});

test("the reservation covers every page's prefix, not just the first", () => {
  // Same defect, one page over. `x` collides on pages 1 and 2, and it is page 2's own
  // rename that lands on an id already in the document — page 3 wrote `p2-x` itself.
  // A reservation that only checked `p1-` would pass every other test in this file
  // while still shipping the duplicate, since each of those fixtures happens to put the
  // occupied prefix on page 1.
  const { body } = assembleBodyWithReport([
    frag(1, `<p id="x">one</p>`),
    frag(2, `<p id="x">two</p>`),
    frag(3, `<label for="p2-x">Field</label><input id="p2-x">`),
  ]);
  const ids = idsOf(body);
  assert.equal(new Set(ids).size, ids.length, `the rename created a duplicate id: ${ids.join(", ")}`);
  assert.match(body, /<label for="p2-x">Field<\/label><input id="p2-x">/, "page 3's own pair was disturbed");
});

test("a document that has taken the escalated prefix too is stepped past", () => {
  // The separator grows until nothing claims it, so one occupied candidate is not
  // enough to prove the loop rather than a single hard-coded fallback. Pages 1 and 2
  // collide on `x` while page 2 also owns `p1-x` AND `p1--x`, so the first two
  // candidates are both taken. Termination is by construction: `claims` is finite and
  // each round is strictly longer.
  const { body } = assembleBodyWithReport([
    frag(1, `<p id="x">one</p>`),
    frag(2, `<p id="x">two</p><p id="p1-x">a</p><p id="p1--x">b</p>`),
  ]);
  const ids = idsOf(body);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids survived: ${ids.join(", ")}`);
  assert.match(body, /id="p1---x"/, "the separator did not grow past both occupied candidates");
});

test("an ordinary document keeps the short prefix", () => {
  // The escalation is driven by what the document claims, not applied defensively. A
  // scan whose pages simply numbered their footnotes 1 gets `p1-fn-1`, so the ids in a
  // delivered document stay legible and the pages 1 and 2 case is not penalised by an
  // unrelated `p9-` id elsewhere.
  const { body } = assembleBodyWithReport([
    frag(1, `<p id="x">one</p><p id="p9-y">y</p>`),
    frag(2, `<p id="x">two</p>`),
  ]);
  assert.match(body, /id="p1-x"/, "an id under a page number no page has took the short prefix away");
  assert.match(body, /id="p2-x"/);
  assert.match(body, /id="p9-y"/, "an id that looked like a prefix was rewritten");
});

test("a slash-separated id is still seen as a claim on that id", () => {
  // Pass 1's sniff decides whether a page is parsed for the ids it OWNS, and a page it
  // skips contributes nothing to the claims map — so a collision is not merely
  // unrepointed but never detected, and the whole join no-ops. `<p/id="fn-1">` is an
  // element with that id as far as the parser is concerned (`/` is the only character
  // besides whitespace the tokenizer accepts before an attribute name), so requiring
  // whitespace shipped two `id="fn-1"` with an empty report.
  //
  // Pass 2's reference sniff was fixed for exactly this and pass 1 was not, which is why
  // both directions are pinned rather than just the one that was reported.
  const { body, anchors } = assembleBodyWithReport([
    frag(1, `<p/id="fn-1">one</p>`),
    frag(2, `<p id="fn-1">two</p><a href="#fn-1">r</a>`),
  ]);
  assert.deepEqual(anchors.collisions, ["fn-1"], "the collision was never detected");
  const ids = idsOf(body);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids survived assembly: ${ids.join(", ")}`);
  // Page 2 owns its `fn-1`, so its own reference follows its own copy.
  assert.match(body, /href="#p2-fn-1"/, "page 2's reference did not follow its own note");
});

test("a quote-adjacent id is still seen as a claim on that id", () => {
  // The third and fourth separators, and the ones the header comment used to deny existed:
  // `<p class="note"id="fn-1">` omits the space between two attributes, which is a parse
  // error the spec recovers from by reading the next attribute name anyway. Both quote
  // styles, since a page agent writing one writes the other.
  //
  // Same consequence as the slash case above and the reason it is a separate test: pass 1
  // skipping the page means the id is never CLAIMED, so the collision is not detected, the
  // report comes back empty, and two `id="fn-1"` ship. This is the third separator bug in
  // this pair of sniffs, which is why they now share one ATTR_SEP constant.
  for (const first of [`<p class="note"id="fn-1">one</p>`, `<p class='note'id='fn-1'>one</p>`]) {
    const { body, anchors } = assembleBodyWithReport([
      frag(1, first),
      frag(2, `<p id="fn-1">two</p><a href="#fn-1">r</a>`),
    ]);
    assert.deepEqual(anchors.collisions, ["fn-1"], `collision not detected for ${first}`);
    const ids = idsOf(body).concat([...body.matchAll(/\sid='([^']+)'/g)].map((m) => m[1]));
    assert.equal(new Set(ids).size, ids.length, `duplicate ids survived assembly: ${ids.join(", ")}`);
    assert.match(body, /href="#p2-fn-1"/, "page 2's reference did not follow its own note");
  }
});

test("the separator class covers every character jsdom accepts before an attribute name", () => {
  // ATTR_SEP is a claim about the parser, and the last two versions of that claim were
  // wrong because they were reasoned about instead of measured. So this measures it, and
  // will fail if a jsdom upgrade widens the set rather than letting the sniffs silently
  // start missing attributes.
  //
  // Every way a preceding attribute can end, crossed with every gap that could follow it;
  // for each source jsdom parses as carrying a real `id`, the character sitting directly
  // before the `id` in the SOURCE is what the sniff's class has to match.
  const prev = ["", `a="b"`, `a='b'`, `a=b`, "a", `a=""`, `a=''`, `a="b/"`, `data-x="1"`];
  const gaps = ["", " ", "  ", "\t", "\n", "\r", "\f", "/", "//", " / ", "\t/"];
  const seen = new Set<string>();
  for (const p of prev) {
    for (const g of gaps) {
      const src = `<p ${p}${g}id="fn-1">t</p>`;
      const el = new JSDOM(`<body>${src}`).window.document.body.querySelector("*");
      if (el?.getAttribute("id") !== "fn-1") continue;
      seen.add(src[src.lastIndexOf(`id="fn-1"`) - 1]);
    }
  }
  // The eight the enumeration finds today. Asserted as a set equality, not a superset: a
  // character DISAPPEARING would mean the probe stopped exercising a case it thinks it
  // covers, which is how the false-negative fixtures above go stale.
  assert.deepEqual([...seen].sort(), ["\t", "\n", "\f", "\r", " ", '"', "'", "/"].sort());
  // The real constant, imported rather than restated: a copy of the class here would keep
  // passing while the one the sniffs use drifted, which is the failure this pins.
  const attrSep = new RegExp(ATTR_SEP);
  for (const ch of seen) {
    assert.ok(attrSep.test(ch), `ATTR_SEP does not match ${JSON.stringify(ch)}`);
  }
});

test("a page the parser would REORDER is left as the agent wrote it", () => {
  // The skip guard used to compare per-tag COUNTS, which cannot see a move. Foster
  // parenting moves things: a `<p>` inside a `<table>` is hoisted out to before the
  // table, so this page reserializes with the note ahead of the table it followed —
  // every count identical, so the guard called it safe and rewrote it.
  //
  // A reading-order change is the worst thing this file could do, and it lands on
  // precisely the shape that produces the collisions in the first place: content inside a
  // table that continues across a page break. Skipping the page costs a duplicate id
  // lint reports, which is the trade the header's rule demands.
  const source = `<table><caption>Q1</caption><tbody><tr><td>1</td></tr></tbody><p id="fn-1">note after table</p></table><p>tail</p>`;
  const { body, anchors } = assembleBodyWithReport([frag(1, source), frag(2, `<p id="fn-1">two</p>`)]);
  assert.deepEqual(anchors.skipped_pages, [1], "the reordering page was rewritten instead of skipped");
  assert.ok(body.startsWith(source), "page 1 was not delivered exactly as written");
  // The note still follows the table, which is the property at stake.
  assert.ok(
    body.indexOf("<table>") < body.indexOf(`<p id="fn-1">note after table`),
    "the note was hoisted ahead of the table it followed",
  );
  // And the skip is reported, so the surviving duplicate is not silent.
  assert.deepEqual(anchors.collisions, ["fn-1"]);
});

test("a page whose bare TEXT the parser would move is left as written too", () => {
  // The same defect one level down, and the reason the guard compares text and not only
  // tags. Wrapping that content in a `<p>` was caught (the test above); leaving it as bare
  // prose was not — foster parenting hoists the text run out past the whole table with
  // every tag still present and in order, so a tag-only sequence saw nothing to object to.
  //
  // Bare prose inside a table is a plausible page-agent emission for a table continued
  // across a break ("Continued from page 1"), which is the same shape that produces the
  // duplicate `<caption>` id in the first place — so the two arrive together.
  const source = `<table><caption id="c1">Cap</caption>Continued from page 1<tr><td>x</td></tr></table>`;
  const { body, anchors } = assembleBodyWithReport([
    frag(1, source),
    frag(2, `<table><caption id="c1">Cap2</caption><tr><td>y</td></tr></table>`),
  ]);
  assert.deepEqual(anchors.skipped_pages, [1], "the text-moving page was rewritten instead of skipped");
  assert.ok(body.startsWith(source), "page 1 was not delivered exactly as written");
  assert.ok(
    body.indexOf("Continued from page 1") < body.indexOf("</table>"),
    "the continuation text was moved out past the table",
  );
  assert.deepEqual(anchors.collisions, ["c1"]);
});

test("the skip guard does not fire on markup the parser only ADDS to", () => {
  // The guard's cost is over-skipping: a page it skips keeps its duplicate id, so a guard
  // that fires on ordinary markup quietly stops fixing the thing this module exists for.
  // Both directions are pinned together because every past version of this check erred in
  // one of them — counts under-fired, and a first text-aware draft over-fired on
  // `title="a > b"`, where a `>` inside a quoted attribute value split one tag into a tag
  // plus a phantom text run.
  const rewritten = [
    ["a well-formed table gains a tbody", `<table><tr><td id="x">c</td></tr></table>`],
    ["the adoption agency duplicates a tag", `<b>1<p id="x">2</b>3</p>`],
    ["entities decode", `<p id="x">Tom &amp; Jerry &lt;br&gt; ok</p>`],
    ["nbsp decodes", `<p id="x">a&nbsp;b</p>`],
    ["a quoted attribute value contains >", `<p id="x" title="a > b">t</p>`],
    ["prose contains escaped angle brackets", `<p id="x">5 &lt; 6 and a &gt; b</p>`],
    ["a comment sits between blocks", `<p id="x">a</p><!-- note --><p>b</p>`],
    ["void elements", `<p id="x">a<br>b<hr></p>`],
    ["source newlines and indentation", `<p id="x">\n  spaced\n  out\n</p>\n<p>next</p>`],
    ["nested inline markup", `<p id="x">a <em>b <strong>c</strong></em> d</p>`],
    ["a figure with a caption", `<figure><img src="a.png" alt="a"><figcaption id="x">c</figcaption></figure>`],
    ["an explicit thead/tbody table", `<table><thead><tr><th id="x">h</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table>`],
  ] as const;
  for (const [what, source] of rewritten) {
    const { anchors } = assembleBodyWithReport([frag(1, source), frag(2, `<p id="x">two</p>`)]);
    assert.deepEqual(anchors.skipped_pages, [], `over-skipped when ${what}: ${source}`);
    assert.deepEqual(anchors.collisions, ["x"], `collision not namespaced when ${what}`);
  }

  // And the moves that must still fire, so this test cannot pass by never firing at all.
  const skipped = [
    ["a <p> inside a table is hoisted", `<table><tbody><tr><td>1</td></tr></tbody><p id="x">note</p></table>`],
    ["bare text inside a table is hoisted", `<table><caption id="x">Cap</caption>Continued<tr><td>c</td></tr></table>`],
    ["a <tr> outside a table is dropped", `<p id="x">A</p><tr><td>DATA</td></tr>`],
  ] as const;
  for (const [what, source] of skipped) {
    const { anchors } = assembleBodyWithReport([frag(1, source), frag(2, `<p id="x">two</p>`)]);
    assert.deepEqual(anchors.skipped_pages, [1], `did not skip when ${what}: ${source}`);
  }
});

test("an unquoted href on a page that owns no id is still repointed", () => {
  // The pre-parse sniff in pass 2 decides whether a page that owns no `id=` gets parsed
  // for its references at all, and a page it skips is never repointed. It used to
  // require a QUOTE after `href=`, so this page — whose only reference is
  // `href=#fn-1` — was skipped while pages 1 and 3 were renamed out from under it.
  //
  // That is worse than the defect the file exists to fix. Before assembly the link
  // resolved to page 1's note: the wrong note, but a target. After, it resolved to
  // nothing — and silently, since the page lands in neither `ambiguous` nor
  // `skipped_pages`, so no `assembly_anchors` line mentions it and axe has no rule for a
  // broken same-document anchor.
  //
  // Unquoted attributes are valid HTML and a model writes them occasionally; the sniff
  // is the only thing between that and a dangling reference.
  const { body, anchors } = assembleBodyWithReport([
    frag(1, `<ol><li id="fn-1">Note one</li></ol>`),
    frag(2, `<p>see <a href=#fn-1>1</a></p>`),
    frag(3, `<ol><li id="fn-1">Note three</li></ol>`),
  ]);
  assert.deepEqual(anchors.collisions, ["fn-1"]);
  assert.deepEqual(anchors.ambiguous, [{ page: 2, ref: "fn-1" }], "the page was skipped, so nothing reported it");
  // Repointed at the first owner, which is where the bare reference went before.
  assert.match(body, /href="#p1-fn-1"/, "the unquoted reference was left dangling");
  assert.doesNotMatch(body, /href="?#fn-1/, "a bare reference to a renamed id survived");
});

test("a slash-separated reference attribute is not missed either", () => {
  // The same sniff's other alternative required whitespace before the attribute name.
  // jsdom parses `<label/for="q1">` — so a page whose sole reference is written that way
  // was skipped for the same reason and with the same consequence, a `for` that names no
  // element being a 1.3.1/4.1.2 failure rather than just a dead link.
  const { body, anchors } = assembleBodyWithReport([
    frag(1, `<input id="q1" type="text">`),
    frag(2, `<p>text</p><label/for="q1">Your name</label>`),
    frag(3, `<input id="q1" type="text">`),
  ]);
  assert.deepEqual(anchors.ambiguous, [{ page: 2, ref: "q1" }]);
  assert.match(body, /for="p1-q1"/, "the slash-separated `for` was left dangling");
});

test("a quote-adjacent reference attribute is not missed either", () => {
  // `/` was not the last separator, and this is the case that says so. A quoted attribute
  // value can be followed immediately by the next attribute name, so `<label class="l"for=
  // "q1">` carries a real `for` — and the sniff skipped the page, leaving that `for`
  // naming an id both owners had been renamed away from.
  //
  // Worse than the pass-1 direction because nothing reports it: page 2 appears in neither
  // `ambiguous` nor `skipped_pages`, axe has no rule for a dangling `for` (the input still
  // has an id, the label still has text), and `duplicate-id` no longer fires because the
  // duplicate really was resolved. A working label association became a broken one and the
  // document looked cleaner afterwards.
  for (const label of [`<label class="l"for="q1">Your name</label>`, `<label class='l'for='q1'>Your name</label>`]) {
    const { body, anchors } = assembleBodyWithReport([
      frag(1, `<input id="q1" type="text">`),
      frag(2, `<p>text</p>${label}`),
      frag(3, `<input id="q1" type="text">`),
    ]);
    assert.deepEqual(anchors.ambiguous, [{ page: 2, ref: "q1" }], `page 2 was not visited for ${label}`);
    assert.match(body, /for="p1-q1"/, `the quote-adjacent \`for\` was left dangling: ${label}`);
  }
});

test("no reference a page can write escapes the pre-parse sniff", async () => {
  // The sniff is asserted to be unfailable in the false-negative direction, so the
  // spellings are enumerated rather than sampled: quoted, unquoted and slash-separated
  // `href`, an `aria-*` reference with each separator, and an unquoted `headers` token
  // list. Every page owns no id of its own, so each depends entirely on the sniff to be
  // parsed at all.
  //
  // One spelling per page, which is the part that makes this a test rather than a
  // demonstration. A first version put three `href` forms on one page, and the quoted one
  // pulled the page in and repointed all three — so the case survived a sabotage that
  // reinstated the mandatory quote. A page is the unit the sniff decides on, so a spelling
  // is only covered when it is the sole reason its page gets parsed.
  //
  // Checked by resolution rather than by matching prefixes: the property is that every
  // href and every IDREF names something in the document, which is what a dangling
  // reference violates and what a prefix assertion would only approximate.
  const referrers = [
    `<p>quoted <a href="#t">a</a></p>`,
    `<p>unquoted <a href=#t>b</a></p>`,
    `<p>slash <a/href="#t">c</a></p>`,
    `<p aria-describedby="t">space-separated aria</p>`,
    `<p/aria-labelledby="t">slash-separated aria</p>`,
    // Quote-adjacent, the two spellings this test asserted coverage of before the code
    // had it: a quoted attribute value can be followed immediately by the next attribute
    // name, and the tokenizer recovers rather than giving up on the rest of the tag.
    `<p class="note"aria-details="t">double-quote-adjacent aria</p>`,
    `<p class='note'aria-controls='t'>single-quote-adjacent aria</p>`,
  ];
  const target = `<ol><li id="t">Target</li></ol><table><tr><th id="h">H</th></tr></table>`;
  const frags = [
    frag(1, target),
    ...referrers.map((html, i) => frag(i + 2, html)),
    // `headers` last, so the pages above stay free of the cross-table `headers` shape.
    frag(referrers.length + 2, `<table><tr><td headers=h>cell</td></tr></table>`),
    frag(referrers.length + 3, `<ol><li id="t">Other target</li></ol><table><tr><th id="h">H2</th></tr></table>`),
  ];
  const { body, anchors } = assembleBodyWithReport(frags);
  assert.deepEqual(anchors.collisions, ["h", "t"], "the fixture stopped producing collisions");
  const ids = new Set(idsOf(body));
  for (const href of fragHrefs(body)) assert.ok(ids.has(href), `href="#${href}" resolves to nothing`);
  for (const attr of ["aria-describedby", "aria-labelledby", "aria-details", "aria-controls", "headers"]) {
    for (const m of body.matchAll(new RegExp(`\\s${attr}="([^"]+)"`, "g"))) {
      for (const token of m[1].split(/\s+/)) assert.ok(ids.has(token), `${attr}="${token}" resolves to nothing`);
    }
  }
  // Every referring page had to be repointed, so a sniff that dropped any one of them
  // shows up here as a missing entry — naming the page, and so the spelling — rather than
  // only as a dangling reference somewhere in the body.
  assert.deepEqual(
    anchors.ambiguous,
    [
      { page: 2, ref: "t" },
      { page: 3, ref: "t" },
      { page: 4, ref: "t" },
      { page: 5, ref: "t" },
      { page: 6, ref: "t" },
      { page: 7, ref: "t" },
      { page: 8, ref: "t" },
      { page: 9, ref: "h" },
    ],
    "a page holding only references was not visited",
  );
  const lint = await runAxe(wrapDocument(body));
  if (lint.error) return;
  // `td-headers-attr` is excluded, and only it: axe requires a `headers` token to name a
  // cell in the SAME table, so a `headers` reference spanning a page break violates that
  // rule whatever assembly does — verified by running the same fixture through a plain
  // concatenation with no namespacing at all, which reports it too. Excluding the rule by
  // name rather than dropping the lint check keeps the rest of the gate on this document,
  // including the `duplicate-id` family that would catch a prefix collision here.
  const remaining = lint.violations.map((v) => v.id).filter((id) => id !== "td-headers-attr");
  assert.equal(remaining.join(", "), "", "assembly left the document with a lint violation");
});

test("two fragments sharing an order still get distinct prefixes", () => {
  // `order` is an input, and it is the one input that can silently defeat the whole
  // function: if the prefix were `p${order}` outright, two fragments numbered 1 would
  // both become `p1-x` and the collision the rename exists to remove would survive it —
  // with a report claiming `x` was namespaced. The current pipeline takes `order` from
  // the image index so it does not happen today, but nothing in the type says so, and
  // the failure is invisible (unique-looking report, duplicate ids in the document).
  //
  // Ownership is tracked per array position and the page LABEL is deduplicated, so the
  // second page numbered 1 becomes `p1_2-`. The label still leads with the page number,
  // because that is what the Reader and the `assembly_anchors` log cite.
  const { body, anchors } = assembleBodyWithReport([frag(1, `<p id="x">one</p>`), frag(1, `<p id="x">two</p>`)]);
  const ids = idsOf(body);
  assert.equal(new Set(ids).size, ids.length, `two pages with the same order shared a prefix: ${ids.join(", ")}`);
  assert.deepEqual(anchors.collisions, ["x"], "the collision was not even detected");
  assert.deepEqual(ids, ["p1-x", "p1_2-x"]);
});

test("a reference from a page sharing an order goes to its own copy, not the other's", () => {
  // The deduplication has to line up with ownership, not just produce two strings. Both
  // pages are numbered 1 and each owns an `fn-1` it references itself. If the reference
  // resolved by `order` it would find the first page claiming 1 and both markers would
  // land on the first note — the original wrong-note defect, arriving through the
  // duplicate-order path rather than through concatenation.
  const { body } = assembleBodyWithReport([frag(1, footnotePage(1)), frag(1, footnotePage(1))]);
  const ids = new Set(idsOf(body));
  for (const href of fragHrefs(body)) assert.ok(ids.has(href), `href="#${href}" resolves to nothing`);
  assert.deepEqual(idsOf(body), ["p1-fnref-1", "p1-fn-1", "p1_2-fnref-1", "p1_2-fn-1"]);
  assert.deepEqual(fragHrefs(body), ["p1-fn-1", "p1-fnref-1", "p1_2-fn-1", "p1_2-fnref-1"]);
});

test("the reservation covers a deduplicated label too", () => {
  // The prefix reservation reads the page LABELS, not `p${order}`, so an id shaped like
  // a deduplicated label is protected the same way `p1-x` is. Two pages numbered 1
  // collide on `x` while page 2 owns a working `<label for="p1_2-x">` pair, which the
  // second page-1's rename would otherwise land on.
  const { body } = assembleBodyWithReport([
    frag(1, `<p id="x">one</p>`),
    frag(1, `<p id="x">two</p>`),
    frag(2, `<label for="p1_2-x">Field</label><input id="p1_2-x">`),
  ]);
  const ids = idsOf(body);
  assert.equal(new Set(ids).size, ids.length, `the rename created a duplicate id: ${ids.join(", ")}`);
  assert.match(body, /<label for="p1_2-x">Field<\/label><input id="p1_2-x">/, "page 2's own pair was disturbed");
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

test("a REFERRING page left as written keeps its first owner bare, so its idref still resolves", async () => {
  // The mirror of the test above, and the direction that was missing. There the skipped
  // page OWNED the id; here it holds the reference. Its `for="q1"` is frozen in bare form
  // by the skip, so renaming every owner leaves it naming nothing — and an unnamed field
  // is a 1.3.1/4.1.2 failure, where the wrong-target name it had at least named something.
  // A plain concatenation gave page 1's input its name from page 3's label; the assembler
  // must not take that away.
  //
  // So the FIRST owner keeps the bare id — what a browser resolved that reference to
  // before any of this ran — while the other owners are still renamed. Pinning the whole
  // id instead would abandon the collision on account of one unrewritable page.
  // Page 2 carries its own label, so the only unnamed field this document can produce is
  // the one whose name comes across the page break — which is what the axe check below is
  // then actually testing. (Without it, page 2's input is unlabelled on its own page and
  // `label` fires either way.)
  const { body, anchors } = assembleBodyWithReport([
    frag(1, `<input id="q1" type="text">`),
    frag(2, `<label for="q1">Second</label><input id="q1" type="text">`),
    frag(3, `<label for="q1">Name</label><tr><td>IMPORTANT DATA</td></tr>`),
  ]);
  assert.deepEqual(anchors.skipped_pages, [3]);
  assert.deepEqual(anchors.ambiguous, [{ page: 3, ref: "q1" }]);
  // And the pin is disclosed. `collisions` on its own says `q1` was claimed twice and would
  // be read as "so it was renamed" — which the pin makes false for the first owner on
  // purpose. Without this field, the bare `q1` two assertions down is indistinguishable in
  // the run log from the namespacing having silently failed. `q1` appears in BOTH lists:
  // it collided, and one of its owners was deliberately left alone.
  assert.deepEqual(anchors.collisions, ["q1"]);
  assert.deepEqual(anchors.pinned_ids, ["q1"], "the pin was not disclosed");
  assert.match(body, /<label for="q1">Name<\/label>/, "the skipped page was rewritten after all");
  // Page 2 owns its `q1`, so its own label follows its own renamed copy.
  assert.match(body, /<label for="p2-q1">Second<\/label>/, "page 2's own label did not follow its own input");
  // Page 1 keeps the bare id the label needs; page 2 is still de-duplicated.
  assert.match(body, /<input id="q1"/, "the first owner was renamed out from under the frozen reference");
  assert.match(body, /<input id="p2-q1"/, "the collision was abandoned instead of narrowed to the first owner");
  const ids = idsOf(body);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids survived: ${ids.join(", ")}`);
  // The property underneath both assertions: every idref in the delivered document names
  // something in it.
  const idSet = new Set(ids);
  for (const m of body.matchAll(/\sfor="([^"]+)"/g)) {
    assert.ok(idSet.has(m[1]), `for="${m[1]}" resolves to nothing`);
  }

  // A NORMAL page referencing the same pinned id is the other half of the fix, and it is
  // the half the id rename alone does not cover: page 4 IS rewritten, so it goes through
  // `resolve`, resolves to the first owner by document order, and that owner is the one
  // holding the bare id. Prefixing here would break page 4's link instead of page 3's
  // label — the defect moved rather than fixed.
  const withNormalReferrer = assembleBodyWithReport([
    frag(1, `<input id="q1" type="text">`),
    frag(2, `<label for="q1">Second</label><input id="q1" type="text">`),
    frag(3, `<label for="q1">Name</label><tr><td>IMPORTANT DATA</td></tr>`),
    frag(4, `<p>See <a href="#q1">the field</a></p>`),
  ]);
  assert.match(withNormalReferrer.body, /href="#q1"/, "a rewritten page's reference was pointed at a renamed owner");
  const laterIds = new Set(idsOf(withNormalReferrer.body));
  for (const href of fragHrefs(withNormalReferrer.body)) {
    assert.ok(laterIds.has(href), `href="#${href}" resolves to nothing`);
  }
  // And the field really is named, which is the accessibility claim rather than a proxy
  // for it — axe's `label` rule is what fires when this regresses.
  const lint = await runAxe(wrapDocument(body));
  if (lint.error) return;
  assert.deepEqual(
    lint.violations.filter((v) => v.id === "label").map((v) => v.id),
    [],
    "the input lost its accessible name",
  );
});

test("pinning is per-id and only for the first owner", () => {
  // The narrowness is the point, so it is asserted rather than assumed. Two colliding ids,
  // each referenced by a different skipped page: each id pins its own first owner, and
  // nothing else in the document stops being namespaced.
  const { body, anchors } = assembleBodyWithReport([
    frag(1, `<input id="a" type="text"><input id="b" type="text">`),
    frag(2, `<input id="a" type="text"><input id="b" type="text">`),
    frag(3, `<label for="a">A</label><tr><td>x</td></tr>`),
    frag(4, `<label for="b">B</label><tr><td>y</td></tr>`),
  ]);
  assert.deepEqual(anchors.skipped_pages, [3, 4]);
  assert.deepEqual(anchors.collisions, ["a", "b"]);
  const ids = idsOf(body);
  assert.deepEqual(ids, ["a", "b", "p2-a", "p2-b"]);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids survived: ${ids.join(", ")}`);
});

test("nothing is pinned when an OWNER of the id was itself skipped", async () => {
  // The case the tests above could not reach, because in every one of them the skipped
  // pages are pure referrers that own no colliding id. Here a skipped page OWNS `q1` while
  // a different skipped page REFERS to it, and pinning unconditionally shipped two bare
  // `id="q1"` — a duplicate id, which is the defect this whole module exists to remove.
  //
  // The premise the pin rests on is that a frozen reference can only ever find the bare id,
  // so some owner has to keep it. That premise is already satisfied here: page 2 is
  // delivered byte-for-byte as written, so its `q1` IS the bare one page 3's `for` finds.
  // Pinning page 1 on top of that adds a second copy and fixes nothing.
  //
  // The shape is an ordinary one — a form continued across a page break. Two pages number
  // their first field `q1`, and the page carrying the continued table's orphaned `<tr>`s is
  // one the reserialization guard will not rewrite.
  const { body, anchors } = assembleBodyWithReport([
    frag(1, `<input id="q1" type="text">`),
    frag(2, `<input id="q1" type="text"><tr><td>IMPORTANT DATA</td></tr>`),
    frag(3, `<label for="q1">Name</label><tr><td>MORE DATA</td></tr>`),
  ]);
  assert.deepEqual(anchors.skipped_pages, [2, 3]);
  assert.deepEqual(anchors.collisions, ["q1"]);
  // Nothing was pinned, so the report says so — the bare `q1` in the output is page 2's own,
  // not a pin.
  assert.deepEqual(anchors.pinned_ids, []);
  const ids = idsOf(body);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids survived assembly: ${ids.join(", ")}`);
  // Page 1 is the only owner that CAN be renamed, so it is — the skipped owner keeps the
  // bare id, which is what the frozen reference needs.
  assert.deepEqual(ids, ["p1-q1", "q1"]);
  assert.match(body, /<label for="q1">/, "the skipped referrer was rewritten after all");
  // And the duplicate really is gone as far as the gate is concerned. `for="q1"` makes the
  // id ARIA-referenced, so the live rule lint.ts promotes out of `incomplete` is the one
  // that fired when this regressed.
  const lint = await runAxe(wrapDocument(body));
  if (lint.error) return;
  assert.deepEqual(
    lint.violations.filter((v) => v.id.startsWith("duplicate-id")).map((v) => v.id),
    [],
    "assembly delivered a duplicate id",
  );
});

test("a skipped owner does not suppress pinning for a DIFFERENT id", () => {
  // The condition above is per-id, not per-document: one id having a skipped owner must not
  // switch the pin off for an unrelated id whose owners are all rewritable. Page 3 owns `a`
  // (and is skipped) while referring to `b`, whose owners are pages 1 and 2 — so `b` still
  // pins its first owner and `a` does not.
  const { body, anchors } = assembleBodyWithReport([
    frag(1, `<input id="b" type="text">`),
    frag(2, `<input id="b" type="text">`),
    frag(3, `<input id="a" type="text"><label for="b">B</label><tr><td>x</td></tr>`),
    frag(4, `<input id="a" type="text">`),
  ]);
  assert.deepEqual(anchors.skipped_pages, [3]);
  assert.deepEqual(anchors.collisions, ["a", "b"]);
  const ids = idsOf(body);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids survived: ${ids.join(", ")}`);
  // `b` pinned its first owner (page 1) so page 3's frozen `for="b"` resolves; `a` did not
  // pin, so page 3 keeps its bare `a` and page 4's copy is renamed.
  assert.deepEqual(ids, ["b", "p2-b", "a", "p4-a"]);
  const idSet = new Set(ids);
  for (const m of body.matchAll(/\sfor="([^"]+)"/g)) {
    assert.ok(idSet.has(m[1]), `for="${m[1]}" resolves to nothing`);
  }
});

// A fragment `parseFragment` refuses to give a DOM: it nests past `MAX_NESTING` (500), so
// the page is delivered exactly as written and everything it contributes is read from its
// source. That is the live route to a null DOM; the parser's own `RangeError` is a backstop
// behind it. See `MAX_NESTING` for why the guard exists rather than letting the parse fail:
// between roughly 4,000 and 10,000 levels jsdom PARSES and then overflows in
// serialization or `window.close()`, throwing out of assembly and failing the session, so
// the depth at which the parse itself gives up was never a boundary worth relying on.
//
// Real input, not a stub. Stubbing was tried and abandoned: `anchors.ts` imports `JSDOM`
// directly and ESM namespace objects are read-only, so a test that reassigned it would have
// exercised nothing while appearing to pass.
const tooDeepToParse = "<div>".repeat(600);

test("an unparseable OWNER suppresses the pin, so no duplicate ships", () => {
  // The pin leaves a colliding id's first owner bare for the sake of a frozen reference. An
  // unparseable owner is ALREADY keeping that bare id, so pinning on top of it ships two
  // copies — the duplicate the pin's own condition exists to rule out, reached by the one
  // route that used to report nothing. Page 3 is guard-skipped and refers to `q1`; page 4
  // cannot be parsed and owns `q1`.
  const { body, anchors } = assembleBodyWithReport([
    frag(1, `<input id="q1" type="text">`),
    frag(2, `<input id="q1" type="text">`),
    frag(3, `<label for="q1">Name</label><tr><td>DATA</td></tr>`),
    frag(4, `${tooDeepToParse}<input id="q1" type="text">`),
  ]);
  assert.deepEqual(anchors.pinned_ids, [], "the pin fired even though an owner was unparseable");
  assert.deepEqual(anchors.skipped_pages, [3, 4]);
  const ids = idsOf(body);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids survived: ${ids.join(", ")}`);
  // Page 4's bare copy is the one page 3's frozen `for="q1"` finds, so the reference still
  // resolves without any pin.
  assert.deepEqual(ids, ["p1-q1", "p2-q1", "q1"]);
  const idSet = new Set(ids);
  for (const m of body.matchAll(/\sfor="([^"]+)"/g)) {
    assert.ok(idSet.has(m[1]), `for="${m[1]}" resolves to nothing`);
  }
});

test("an unparseable page's REFERENCES still pin their first owner", () => {
  // The mirror, and the direction with an accessibility cost rather than a lint one. An
  // unparseable page's `for="q1"` is frozen in bare form exactly like a guard-skipped page's,
  // so if every owner is renamed the field loses its accessible name (1.3.1/4.1.2). Its
  // references have to be read from the source for the same reason its ids are: there is no
  // DOM to read them from and there never will be.
  const { body, anchors } = assembleBodyWithReport([
    frag(1, `<input id="q1" type="text">`),
    frag(2, `<label for="q1">Second</label><input id="q1" type="text">`),
    frag(3, `${tooDeepToParse}<label for="q1">Name</label>`),
  ]);
  assert.deepEqual(anchors.pinned_ids, ["q1"], "the frozen reference did not pin its first owner");
  assert.deepEqual(anchors.ambiguous, [{ page: 3, ref: "q1" }]);
  assert.deepEqual(anchors.skipped_pages, [3]);
  const ids = idsOf(body);
  assert.deepEqual(ids, ["q1", "p2-q1"]);
  const idSet = new Set(ids);
  for (const m of body.matchAll(/\sfor="([^"]+)"/g)) {
    assert.ok(idSet.has(m[1]), `for="${m[1]}" resolves to nothing`);
  }
});

test("an unparseable page with nothing at stake is not named in the report", () => {
  // `skipped_pages` is documented as "may still carry a collision or a stranded reference"
  // and a human is asked to act on it. A page that fails to parse while owning no colliding
  // id and referring to none carries neither, so naming it would be noise.
  const { anchors } = assembleBodyWithReport([
    frag(1, `<p id="fn-1">one</p>`),
    frag(2, `<p id="fn-1">two</p>`),
    frag(3, `${tooDeepToParse}<a href="#elsewhere">x</a>`),
  ]);
  assert.deepEqual(anchors.collisions, ["fn-1"]);
  assert.deepEqual(anchors.skipped_pages, []);
  assert.deepEqual(anchors.ambiguous, []);
});

test("an id-shaped string that is not an attribute does not make an unparseable page an owner", () => {
  // The source scan that reads an unparseable page's ids must not be over-inclusive, which
  // is the opposite of the rule everywhere else here — a PHANTOM owner is worse than a
  // missed one.
  //
  // Both readers of `skipped` rest on "a skipped owner is ALREADY keeping the bare id", and
  // a phantom owner never had one. A first version scanned for `id\s*=` anywhere in the
  // source, so `id=x` in prose made page 2 an owner of `x`: `x` became a collision that no
  // element had twice, the pin declined to fire because an owner was skipped, page 3's real
  // id was renamed to `p3-x`, and page 1's `<label for="x">` pointed at nothing. An unnamed
  // field — 1.3.1/4.1.2 — manufactured out of prose.
  //
  // One end-to-end proof, with the delivered document as the evidence. The exhaustive
  // position-by-position check is the test below, which does not pay for a parse per shape.
  const { body, anchors } = assembleBodyWithReport([
    frag(1, `<label for="x">Name</label>`),
    frag(2, `${tooDeepToParse}<p>the field labelled id=x on the form</p>`),
    frag(3, `<input id="x" type="text">`),
  ]);
  assert.deepEqual(anchors.collisions, [], "`id=x` in prose was read as a claim on `x`");
  assert.deepEqual(anchors.skipped_pages, []);
  // Nothing collided, so nothing is renamed and the label keeps the field it named before
  // assembly ran.
  assert.match(body, /<input id="x"/, "the input's id was renamed");
  const idSet = new Set(idsOf(body));
  for (const m of body.matchAll(/\sfor="([^"]+)"/g)) {
    assert.ok(idSet.has(m[1]), `for="${m[1]}" resolves to nothing`);
  }
});

test("a tag inside a <textarea> is text, so it does not make a skipped page an owner", () => {
  // The same manufactured-dangling-reference defect as the test above, reached through markup
  // rather than prose: the tag-aware scan walked a `<p id="x">` sitting INSIDE a `<textarea>`,
  // which the parser treats as text. A page agent transcribing a filled-in form field emits
  // exactly this. `x` became a collision no element had twice, the phantom owner suppressed
  // the pin, page 3's real id was renamed, and page 1's label named nothing.
  const { body, anchors } = assembleBodyWithReport([
    frag(1, `<label for="x">Name</label>`),
    frag(2, `${tooDeepToParse}<textarea><p id="x"></textarea>`),
    frag(3, `<input id="x" type="text">`),
  ]);
  assert.deepEqual(anchors.collisions, [], "a tag inside <textarea> was read as an id claim");
  assert.deepEqual(anchors.skipped_pages, []);
  assert.match(body, /<input id="x"/, "the input's id was renamed");
  const idSet = new Set(idsOf(body));
  for (const m of body.matchAll(/\sfor="([^"]+)"/g)) {
    assert.ok(idSet.has(m[1]), `for="${m[1]}" resolves to nothing`);
  }
});

test("a character-referenced for= on a skipped page still pins its owner", () => {
  // The mirror direction, on the reference side. `for="q&#49;"` IS a reference to `q1` — the
  // parser decodes attribute values — but the scan read it literally, so the pin never learned
  // the reference existed. Both owners of `q1` were renamed, page 3's frozen `for` named
  // nothing, and the report was empty: the defect the pin was added to fix, reached through
  // the route that reports least.
  const { body, anchors } = assembleBodyWithReport([
    frag(1, `<input id="q1" type="text">`),
    frag(2, `<label for="q1">Second</label><input id="q1" type="text">`),
    frag(3, `${tooDeepToParse}<label for="q&#49;">Name</label>`),
  ]);
  assert.deepEqual(anchors.collisions, ["q1"]);
  assert.deepEqual(anchors.pinned_ids, ["q1"], "the decoded reference did not pin its owner");
  assert.deepEqual(anchors.skipped_pages, [3]);
  const ids = idsOf(body);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids survived: ${ids.join(", ")}`);
  // Page 1 keeps `q1` bare so page 3's frozen reference finds it; page 2's copy is renamed.
  assert.deepEqual(ids, ["q1", "p2-q1"]);
});

test("a page too deep to rewrite is delivered as written rather than throwing", () => {
  // Every step of the rewrite recurses per level of nesting, and they do not all give up at
  // the same depth: measured, jsdom's serializer and `window.close()` overflow from about
  // 4,000 levels while the parse survives to about 10,000. So the band in between used to
  // PARSE and then throw `RangeError` out of assembly, failing the session — while a DEEPER
  // page, whose parse failed cleanly, was delivered fine. Non-monotonic in depth, and the
  // worse outcome was the shallower one.
  //
  // `MAX_NESTING` (500) is checked before anything recursive runs, so the whole band is now
  // one behaviour. The depths here span it: just over the limit, the old serializer/close
  // band, and past the old parse threshold.
  for (const depth of [600, 5000, 9000, 12000]) {
    const deep = "<div>".repeat(depth);
    const { body, anchors } = assembleBodyWithReport([
      frag(1, `<input id="q1" type="text">`),
      frag(2, `<input id="q1" type="text">`),
      frag(3, `${deep}<label for="q1">Name</label>`),
    ]);
    assert.deepEqual(anchors.skipped_pages, [3], `depth ${depth}`);
    assert.deepEqual(anchors.pinned_ids, ["q1"], `depth ${depth}`);
    const ids = idsOf(body);
    assert.equal(new Set(ids).size, ids.length, `duplicate ids survived at depth ${depth}`);
    // The page is delivered byte-for-byte, so its nesting is still in the output.
    assert.ok(body.includes(deep), `depth ${depth}: the page was not delivered as written`);
    const idSet = new Set(ids);
    for (const m of body.matchAll(/\sfor="([^"]+)"/g)) {
      assert.ok(idSet.has(m[1]), `depth ${depth}: for="${m[1]}" resolves to nothing`);
    }
  }
});

test("the source id scan agrees with the parser on where an attribute is", () => {
  // Both directions of the scan `sourceIds` uses, measured against jsdom rather than
  // asserted from a list, since the whole question is what the parser considers an
  // attribute. Every shape is checked in both directions at once: the ids the parser found
  // must be exactly the ids the scan found.
  //
  // `sourceIds` directly rather than through `assembleBodyWithReport`: the end-to-end route
  // needs a collision and a deep page per shape, and what is being measured here is the scan
  // against the parser, one shape at a time, with the disagreement named in the failure. The
  // route itself is covered end to end by the unparseable-page tests above. And it is the
  // real function, not a copy of its regex: a copy would keep passing while the original
  // drifted.
  //
  // The over-inclusive direction is the one with teeth (see the test above), but a MISS is
  // the pin's premise failing too, so both are errors here.
  const shapes = [
    // Ids the parser does see, in every position it accepts one.
    `<p id="x">t</p>`,
    `<p id='x'>t</p>`,
    `<p id=x>t</p>`,
    `<p class="note"id="x">t</p>`, // quote-adjacent — what ATTR_SEP exists for
    `<p/id="x">t</p>`, // slash-separated
    `<p\tid="x">t</p>`,
    `<p\nid="x">t</p>`,
    `<p ID="x">t</p>`, // attribute names are case-insensitive
    `<p id = "x">t</p>`,
    `<img id="x"/>`,
    `<p title="a > b" id="x">t</p>`, // a `>` inside a quoted value does not end the tag
    `<p id="fn&#45;1">t</p>`, // a character reference: the parser decodes, so this must too
    `<p id="a&amp;b">t</p>`,
    `<p id="a&ampb">t</p>`, // NOT decoded in attribute position, unlike in text
    `<p id="&#x41;x">t</p>`,
    // And the phantoms: id-shaped strings in positions that are not attributes.
    `<p>id=phantom in prose</p><p id="x">t</p>`,
    `<!-- <p id="phantom"> --><p id="x">t</p>`,
    `<p title='id="phantom"' id="x">t</p>`,
    `<p data-id="phantom" id="x">t</p>`, // `data-id` is not `id`
    `<p id="a" id="b">t</p>`, // repeated name: the parser keeps the first
    // Elements whose content is not markup, so a tag inside one is text. The plausible one
    // is `<textarea>`: a page agent transcribing a filled-in form field emits exactly this.
    `<textarea><p id="phantom"></textarea><p id="x">t</p>`,
    `<script>var s='<p id="phantom">'</script><p id="x">t</p>`,
    `<style>/* <p id="phantom"> */</style><p id="x">t</p>`,
    `<title><p id="phantom"></title><p id="x">t</p>`,
    `<template><p id="phantom"></template><p id="x">t</p>`,
    `<xmp><p id="phantom"></xmp><p id="x">t</p>`,
    `<iframe><p id="phantom"></iframe><p id="x">t</p>`,
    `<noembed><p id="phantom"></noembed><p id="x">t</p>`,
    `<noframes><p id="phantom"></noframes><p id="x">t</p>`,
    `<select><b id="phantom"></select><p id="x">t</p>`,
    `<textarea rows="2"><p id="phantom"></textarea><p id="x">t</p>`, // its OWN attributes are real
    `<textarea id="real"><p id="phantom"></textarea><p id="x">t</p>`,
    `<textarea><p id="phantom"></textarea foo="bar"><p id="x">t</p>`, // junk in the close tag
    `<TEXTAREA><p id="phantom"></TEXTAREA><p id="x">t</p>`,
    `<textarea><textarea><p id="phantom"></textarea><p id="x">t</p>`, // raw text does not nest
    // A raw-text element with no close tag runs to the end of the page, so the ids after it
    // are MISSED rather than invented — `sourceIds`' safe direction, asserted so a change
    // that flipped it to the phantom direction would fail here.
    `<textarea><p id="missed">`,
    // `noscript` content IS parsed (scripting is disabled in these fragments), so it is not
    // in RAW_CONTENT and its ids are real.
    `<noscript><p id="real"></noscript><p id="x">t</p>`,
  ];
  for (const shape of shapes) {
    const parsed = new JSDOM(`<body>${shape}</body>`).window.document;
    const fromParser = [...parsed.querySelectorAll("[id]")].map((el) => el.getAttribute("id")!).sort();
    assert.deepEqual([...sourceIds(shape)].sort(), fromParser, `disagreed with the parser on: ${JSON.stringify(shape)}`);
  }
});

test("the source reference scan agrees with the parser too", () => {
  // The other half of what an unparseable page contributes. Same method as the id scan
  // above, and it matters for the same reason: this is the only reading of that page's
  // references there will ever be, so a miss leaves a frozen `for=`/`aria-*` unpinned and
  // its owners renamed out from under it — the dangling reference this whole mechanism
  // exists to avoid.
  //
  // Over-inclusiveness is the SAFE direction here, unlike ids (a reference that is not
  // really there pins a first owner that did not need pinning: one colliding id left bare,
  // no duplicate). The exact agreement is asserted anyway — a phantom reference is still a
  // collision left half-fixed, and asserting equality is what makes a drift in either
  // direction visible.
  const shapes = [
    `<a href="#t">a</a>`,
    `<a href='#t'>a</a>`,
    `<a href=#t>a</a>`,
    `<a/href="#t">a</a>`,
    `<label for="t">L</label>`,
    `<label for=t>L</label>`,
    `<p aria-describedby="t">x</p>`,
    `<p/aria-labelledby="t">x</p>`,
    `<p class="note"aria-details="t">x</p>`, // quote-adjacent
    `<p class='note'aria-controls='t'>x</p>`,
    `<p aria-labelledby="a b c">x</p>`, // space-separated token list
    // And the non-references: an external URL's fragment, a bare `#`, prose, a reference
    // inside another attribute's value or a comment, and a `data-` lookalike.
    `<a href="http://e.com/#t">x</a>`,
    `<a href="#">top</a>`,
    `<p>see the headers for details</p>`,
    `<p title="href=#phantom">x</p>`,
    `<!-- <a href="#phantom">x</a> -->`,
    `<p data-for="phantom">x</p>`,
    // Character references, which the parser decodes. Reading these literally left a frozen
    // `for=` unseen, so its owners were renamed and the reference named nothing — the exact
    // defect the pin exists to prevent, and `sourceRefs`' unsafe direction.
    `<label for="q&#49;">L</label>`,
    `<a href="&#35;t">a</a>`,
    `<p aria-labelledby="a&#32;b">x</p>`,
    `<label for="a&amp;b">L</label>`,
    // And references inside elements whose content is not markup.
    `<textarea><label for="phantom"></textarea>`,
    `<script>var s='<label for="phantom">'</script>`,
    `<template><a href="#phantom">x</a></template>`,
    `<label for="a" for="b">L</label>`, // repeated name: first wins
  ];
  const IDREF_ATTRS = ["for", "form", "list", "headers", "aria-labelledby", "aria-describedby", "aria-details", "aria-errormessage", "aria-controls", "aria-owns", "aria-flowto", "aria-activedescendant"];
  for (const shape of shapes) {
    const parsed = new JSDOM(`<body>${shape}</body>`).window.document;
    const fromParser = new Set<string>();
    for (const el of parsed.querySelectorAll("[href^='#']")) {
      const target = el.getAttribute("href")!.slice(1);
      if (target) fromParser.add(target);
    }
    for (const attr of IDREF_ATTRS) {
      for (const el of parsed.querySelectorAll(`[${attr}]`)) {
        for (const token of el.getAttribute(attr)!.split(/\s+/)) if (token) fromParser.add(token);
      }
    }
    assert.deepEqual([...sourceRefs(shape)].sort(), [...fromParser].sort(), `disagreed with the parser on: ${JSON.stringify(shape)}`);
  }
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
