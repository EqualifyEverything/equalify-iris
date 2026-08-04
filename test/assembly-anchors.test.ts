import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleBody, wrapDocument } from "../src/pipeline/assembly.ts";
import { namespaceAnchors } from "../src/pipeline/anchors.ts";
import { runAxe } from "../src/pipeline/lint.ts";
import type { Fragment } from "../src/pipeline/fragment.ts";

// Assembly is where per-page output becomes one document, and ids are the thing that
// cannot survive that join untouched. Each page is extracted alone and concurrently,
// so a page numbering its first footnote "1" has no way to know another page did the
// same — and the page prompt asks for exactly those ids by name (`id="fn-N"`,
// `href="#fn-N"`, "preserve the original numbering"). A multi-page scan where each
// page carries a footnote 1 is the ordinary case.
//
// The resulting defect is invisible in every way that usually catches things: both
// notes are present, both are announced, the link works, and the axe gate passes it
// (WCAG 2.2 dropped 4.1.1, so `duplicate-id` is tagged obsolete and filtered out).
// The only symptom is that a screen-reader user following the reference on page 3
// arrives at page 1's note. So it is pinned here, at the join.

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

test("a reference to an id on another page is left broken rather than pointed at the wrong note", () => {
  // A marker whose body is on the NEXT page: page 2 links `#fn-7` but emits no
  // `fn-7`. Prefixing it would be a guess; leaving it as `#fn-7` makes it resolve
  // to nothing, which is the honest outcome and the one a lint or a human notices.
  // Rewriting it to page 1's unrelated note would be the silent version of this
  // whole bug class.
  //
  // Page 2 carries an id of its own (`fn-9`) on purpose. Without one it never gets
  // past `namespaceAnchors`' no-ids bail-out, and this test would pass for a
  // version that prefixes every href blindly — it would be asserting the bail-out,
  // not the resolves-locally rule.
  const body = assembleBody([
    frag(1, `<ol><li id="fn-7">An unrelated note that happens to be numbered 7.</li></ol>`),
    frag(2, `<p>See<sup><a href="#fn-7">7</a></sup> and<sup><a href="#fn-9" id="fnref-9">9</a></sup></p>` +
      `<ol start="9"><li id="fn-9">A note this page does own.</li></ol>`),
  ]);
  assert.match(body, /href="#fn-7"/, "a cross-page reference was rewritten");
  assert.doesNotMatch(body, /href="#p[12]-fn-7"/, "a cross-page reference was pointed at another page's note");
  assert.match(body, /id="p1-fn-7"/, "page 1's own id was not namespaced");
  // The same page's local reference IS rewritten, which is what proves the page
  // reached the rewriting path at all.
  assert.match(body, /href="#p2-fn-9"/, "page 2's own reference was not rewritten");
});

test("references that are not ids at all are untouched", () => {
  const body = assembleBody([
    frag(1, `<p id="top">Top</p><p><a href="#">Nowhere</a> <a href="#top">Up</a> <a href="https://example.org/#frag">Out</a></p>`),
  ]);
  assert.match(body, /href="#"/, "a bare #href was prefixed into an id reference");
  assert.match(body, /href="#p1-top"/, "an in-page reference was not rewritten");
  assert.match(body, /href="https:\/\/example\.org\/#frag"/, "an external URL's fragment was rewritten");
});

// Namespacing ids without namespacing what points at them would be worse than the
// collision it fixes. `for`, `headers` and the aria-* references are how a field
// gets its accessible name and how a data cell is attributed to its headers, so a
// dangling one is a real WCAG failure introduced by assembly on content that was
// correct when the page produced it.
test("every kind of id reference is rewritten with the id, not just href", () => {
  const page =
    `<label for="q1">Name</label><input id="q1" aria-describedby="h1 h2">` +
    `<p id="h1">Hint one</p><p id="h2">Hint two</p>` +
    `<table><tr><th id="c1">Year</th><td headers="c1">1994</td></tr></table>` +
    `<div aria-labelledby="h1"></div>`;
  const body = assembleBody([frag(2, page)]);
  assert.match(body, /<label for="p2-q1">/, "label/for lost its target — the field has no accessible name");
  assert.match(body, /aria-describedby="p2-h1 p2-h2"/, "a multi-token idref list was not fully rewritten");
  assert.match(body, /headers="p2-c1"/, "a data cell lost its header association");
  assert.match(body, /aria-labelledby="p2-h1"/, "aria-labelledby was not rewritten");
  const ids = new Set(idsOf(body));
  for (const ref of [...body.matchAll(/(?:for|headers|aria-describedby|aria-labelledby)="([^"]+)"/g)].flatMap((m) => m[1].split(" "))) {
    assert.ok(ids.has(ref), `"${ref}" is referenced but no element has that id`);
  }
});

test("a page with no ids is passed through byte for byte", () => {
  // The common case, and the reason for the early bail-out: a page that cannot
  // collide should not be reshaped on the way through. The markup here is
  // deliberately the kind jsdom rewrites when it reserializes — a bare `required`
  // becomes `required=""` and a `<table>` gains a `<tbody>` — because a fixture of
  // already-canonical HTML would come back identical either way and assert nothing.
  const html =
    `<h1>Title</h1>\n<p>Plain text with <em>emphasis</em>.</p>\n` +
    `<label>Name <input type="text" required></label>\n` +
    `<table><tr><td>1994</td></tr></table>`;
  assert.equal(namespaceAnchors(html, "p1-"), html);
  assert.equal(assembleBody([frag(1, html)]), html);
});

test("unparseable page content is delivered as the agent wrote it", () => {
  // namespaceAnchors is not a validator. Whatever the agent emitted is what the
  // rest of the pipeline reviews, so a failure here must not silently rewrite or
  // drop content — the review loop and the lint gate are what judge it.
  const html = `<p id="a">Unclosed <div><span>nested`;
  const out = namespaceAnchors(html, "p1-");
  assert.match(out, /Unclosed/, "content was lost");
  assert.match(out, /nested/, "content was lost");
});

// The two halves of the fix are independent and both are load-bearing: assembly
// prevents the collision, and lint catches one the Copy Editor reintroduces when it
// rewrites the whole body. Asserting the gate directly, because the tag filter is
// what hid this in the first place.
test("axe reports a duplicate id, which the WCAG tag filter alone does not", async () => {
  const colliding = `${footnotePage(1)}\n\n${footnotePage(1)}`;
  const lint = await runAxe(wrapDocument(colliding));
  if (lint.error) return; // axe could not run here; runAxe degrades to a parse check
  assert.equal(lint.ok, false, "a document with two id=\"fn-1\" passed the lint gate");
  assert.ok(
    lint.violations.some((v) => v.id.startsWith("duplicate-id")),
    `expected a duplicate-id violation, got: ${lint.violations.map((v) => v.id).join(", ") || "none"}`,
  );
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
