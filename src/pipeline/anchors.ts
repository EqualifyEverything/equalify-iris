import { JSDOM, VirtualConsole } from "jsdom";

// Make the ids of independently extracted pages unique across the assembled
// document (PRD §7.7 v1.2), while leaving every reference that already worked
// alone.
//
// Why this is needed at all: extraction is per page and concurrent. `extractPage`
// sees one image and nothing of what any other page emitted, and assembly is a
// plain concatenation — so an id is a claim about the whole document that no page
// is in a position to make. The page prompt asks for ids by name for footnotes
// (`id="fn-N"`, `href="#fn-N"`, "preserve the original numbering"), so a scan whose
// pages each carry a footnote 1 emits several `id="fn-1"` in one file. Then every
// `href="#fn-1"` resolves to the first: a screen-reader user following the
// reference on page 3 lands on page 1's note and the back-reference returns them to
// the wrong paragraph. Both notes exist, both are announced, the link works. The
// lint gate does not see it either — WCAG 2.2 dropped 4.1.1, so axe tags
// `duplicate-id` obsolete and lint.ts's tag filter excludes it (`duplicate-id-aria`
// is current but fires only for ids referenced from ARIA attributes, not an `href`),
// which is why lint.ts re-enables it by name.
//
// **Only ids that more than one page claims are renamed.** A first version prefixed
// every id with its page number, which fixed collisions and broke everything that
// legitimately pointed across a page break: a `<label for="q1">` whose `<input
// id="q1">` fell on the next page, or endnotes with continuous numbering where the
// markers are in the body and the notes are collected at the back. Those references
// resolved correctly before assembly touched them, and renaming one end of the pair
// made them dangle — which for `for`/`headers`/`aria-*` is a real 1.3.1/4.1.2
// failure (that is how a field gets its accessible name and how a data cell is
// attributed to its headers) on content that was correct when the page produced it.
// Trading a wrong-target reference for a no-target one is not a fix.
//
// Renaming only the collisions makes the common document a no-op, and it is also
// the honest scope: a unique id needs nothing done to it, and a colliding one has no
// correct cross-page interpretation to preserve.
const IDREF_ATTRS = [
  "for", // <label for> — the field's accessible name
  "form",
  "list", // <input list> → <datalist>
  "headers", // <td headers> — which <th> describes this cell
  "aria-labelledby",
  "aria-describedby",
  "aria-details",
  "aria-errormessage",
  "aria-controls",
  "aria-owns",
  "aria-flowto",
  "aria-activedescendant",
];

export interface AnchorReport {
  // Bare ids that more than one page claimed, and were therefore namespaced.
  collisions: string[];
  // References that name a colliding id from a page that does not own it. There is
  // no correct target: the id existed on two pages, so the pre-namespacing
  // resolution (the first one in document order) was arbitrary. Left as written,
  // which makes them resolve to nothing — a visibly broken link rather than a
  // silently wrong one. Reported because a deliverable with a dead reference must
  // be debuggable; today's alternative was silence.
  unresolved: { page: number; ref: string }[];
  // Pages whose rewrite was abandoned to avoid losing markup (see `wouldLoseTags`).
  // The collision survives on these pages and lint's `duplicate-id` will name it.
  skipped_pages: number[];
}

const EMPTY_REPORT: AnchorReport = { collisions: [], unresolved: [], skipped_pages: [] };

// Names of the start tags in a fragment, counted from the raw source.
//
// This exists to catch losses that happen during PARSING, so it cannot be computed
// from the parsed document. `<td>` outside a `<table>` — a plausible thing for a
// page agent to emit for a table continuing across a page break — is foster-parented
// out of existence: jsdom parses `<p id="a">A</p><tr><td>DATA</td></tr>` to
// `<p id="a">A</p>DATA`, keeping the text and dropping the row and cell, and does not
// throw. Reserializing that would silently discard structure the review loop and the
// user should have seen.
//
// A regex over the source can over-count (a literal `<b` inside prose or an
// attribute value), which fails in the safe direction: the page keeps its collision
// and lint reports it, rather than the document quietly losing a table row.
function tagCounts(html: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of html.matchAll(/<([a-zA-Z][^\s/>]*)/g)) {
    const name = m[1].toLowerCase();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function wouldLoseTags(source: string, document: Document): boolean {
  const parsed = new Map<string, number>();
  for (const el of document.body.querySelectorAll("*")) {
    const name = el.tagName.toLowerCase();
    parsed.set(name, (parsed.get(name) ?? 0) + 1);
  }
  // Only a DECREASE matters, and only for tags the source actually wrote. Two kinds
  // of increase are normal and neither loses anything: a tag the source omitted
  // entirely (a well-formed `<table><tr>` gains a `<tbody>`, which is absent from
  // `tagCounts` and so never compared), and a tag the parser DUPLICATES to repair
  // misnesting — the adoption agency algorithm turns `<b>1<p>2</b>3</p>` into
  // `<b>1</b><p><b>2</b>3</p>`, two `<b>` from one. An equality check would abandon
  // the rewrite on both, leaving exactly the collisions this function exists to fix.
  for (const [name, n] of tagCounts(source)) {
    if ((parsed.get(name) ?? 0) < n) return true;
  }
  return false;
}

function ownedIds(document: Document): Set<string> {
  const ids = new Set<string>();
  for (const el of document.querySelectorAll("[id]")) {
    const id = el.getAttribute("id");
    if (id) ids.add(id);
  }
  return ids;
}

function parseFragment(innerHtml: string): JSDOM | null {
  try {
    return new JSDOM(`<body>${innerHtml}</body>`, { virtualConsole: new VirtualConsole() });
  } catch {
    return null;
  }
}

// Every reference a page makes, so the report can name the ones left dangling.
function referencesIn(document: Document): string[] {
  const refs: string[] = [];
  for (const el of document.querySelectorAll("[href^='#']")) {
    const target = el.getAttribute("href")!.slice(1);
    if (target) refs.push(target);
  }
  for (const attr of IDREF_ATTRS) {
    for (const el of document.querySelectorAll(`[${attr}]`)) {
      for (const token of el.getAttribute(attr)!.split(/\s+/)) if (token) refs.push(token);
    }
  }
  return refs;
}

// Namespace colliding ids across a document's pages. Input is one entry per page in
// document order; output is the rewritten inner HTML in the same order, plus what
// was done. Pages are processed as a set because a collision is not visible from
// inside any single one of them.
export function namespaceAnchors(pages: { order: number; innerHtml: string }[]): {
  pages: string[];
  report: AnchorReport;
} {
  // Pass 1: who owns what. A page with no ids cannot contribute a collision, and
  // needs no parse for the rewrite either, so most documents stop here.
  const doms: (JSDOM | null)[] = [];
  const owned: Set<string>[] = [];
  const claims = new Map<string, number>(); // bare id -> how many pages claim it
  for (const page of pages) {
    if (!/\sid\s*=/i.test(page.innerHtml)) {
      doms.push(null);
      owned.push(new Set());
      continue;
    }
    const dom = parseFragment(page.innerHtml);
    const ids = dom ? ownedIds(dom.window.document) : new Set<string>();
    doms.push(dom);
    owned.push(ids);
    for (const id of ids) claims.set(id, (claims.get(id) ?? 0) + 1);
  }

  const collisions = [...claims].filter(([, n]) => n > 1).map(([id]) => id);
  // Pages parsed only to collect their references (see pass 2). Declared out here so
  // `finally` closes them along with pass 1's.
  const reportOnly: (JSDOM | null)[] = [];
  try {
    if (collisions.length === 0) {
      // The overwhelmingly common case: nothing to rename, so nothing is parsed and
      // reserialized and every page is delivered exactly as its agent wrote it. (A
      // page that used the same id twice by itself is a collision no prefix can fix
      // — both copies would get the same one — and is left to lint's
      // `duplicate-id`.)
      return { pages: pages.map((p) => p.innerHtml), report: EMPTY_REPORT };
    }

    const colliding = new Set(collisions);
    const out: string[] = [];
    const report: AnchorReport = { collisions: collisions.sort(), unresolved: [], skipped_pages: [] };

    for (const [i, page] of pages.entries()) {
      const dom = doms[i];
      const mine = owned[i];
      const prefix = `p${page.order}-`;
      const rename = (id: string) => `${prefix}${id}`;
      // A colliding id this page owns, so this page has work to do.
      const toRename = [...mine].filter((id) => colliding.has(id));

      // Anything this page points at that names a colliding id it does NOT own is
      // ambiguous, whether or not the page is being rewritten. A page with no ids of
      // its own was not parsed in pass 1 and still has to be checked — the page that
      // holds the markers while the notes live elsewhere is exactly that shape, and
      // it is the one whose references go dead. Parsed here rather than in pass 1 so
      // the cost is paid only by documents that actually have a collision.
      let refDom = dom;
      if (!refDom) {
        refDom = parseFragment(page.innerHtml);
        reportOnly.push(refDom);
      }
      for (const ref of refDom ? referencesIn(refDom.window.document) : []) {
        if (colliding.has(ref) && !mine.has(ref)) report.unresolved.push({ page: page.order, ref });
      }

      if (!dom || toRename.length === 0) {
        out.push(page.innerHtml);
        continue;
      }

      const { document } = dom.window;
      if (wouldLoseTags(page.innerHtml, document)) {
        report.skipped_pages.push(page.order);
        out.push(page.innerHtml);
        continue;
      }

      for (const el of document.querySelectorAll("[id]")) {
        const id = el.getAttribute("id");
        if (id && colliding.has(id)) el.setAttribute("id", rename(id));
      }
      // Same-page references to the ids just renamed. `href="#"` and `#top` name no
      // colliding id and are left alone, as is any reference to an id this page does
      // not own — including one that resolves on another page, which is the whole
      // point of renaming collisions only.
      for (const el of document.querySelectorAll("[href^='#']")) {
        const target = el.getAttribute("href")!.slice(1);
        if (target && mine.has(target) && colliding.has(target)) el.setAttribute("href", `#${rename(target)}`);
      }
      for (const attr of IDREF_ATTRS) {
        for (const el of document.querySelectorAll(`[${attr}]`)) {
          const value = el.getAttribute(attr)!;
          // Treated as a token list throughout: `headers` and the aria-* plural
          // attributes genuinely are, and a single-valued attribute whose value
          // contains a space was never a valid reference anyway.
          const rewritten = value
            .split(/\s+/)
            .filter((t) => t.length > 0)
            .map((t) => (mine.has(t) && colliding.has(t) ? rename(t) : t))
            .join(" ");
          if (rewritten !== value) el.setAttribute(attr, rewritten);
        }
      }
      out.push(document.body.innerHTML);
    }
    return { pages: out, report };
  } finally {
    for (const dom of [...doms, ...reportOnly]) dom?.window.close();
  }
}
