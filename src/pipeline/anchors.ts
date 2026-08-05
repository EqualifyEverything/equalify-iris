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
//
// A reference to a colliding id is then repointed rather than abandoned: to the
// page's own copy if it has one, otherwise to the first page in document order that
// claims the id — which is what a browser resolved the bare reference to before any
// of this ran. See pass 2 below for why leaving it dangling was the worse of the two.
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
  // References that name a colliding id from a page that does not own it, so no page
  // can say which copy was meant. They are repointed at the first owner in document
  // order — what the un-namespaced document resolved them to — and reported here
  // because a reference disambiguated by document order rather than by the agent that
  // wrote it is a document worth a human's attention. Named `ambiguous` and not
  // `unresolved`: they do resolve, just not on the page's own authority.
  ambiguous: { page: number; ref: string }[];
  // Pages left exactly as written because rewriting them would have lost markup (see
  // `wouldLoseTags`). Either the page's own colliding ids keep their bare form — in
  // which case lint's `duplicate-id` / `duplicate-id-active` names the collision — or
  // an ambiguous reference on it keeps pointing at a bare id that other pages
  // renamed away, which is why the page is named here as well as in `ambiguous`.
  skipped_pages: number[];
}

const EMPTY_REPORT: AnchorReport = { collisions: [], ambiguous: [], skipped_pages: [] };

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
  // Bare id -> the pages claiming it, in document order, identified by ARRAY INDEX
  // and not by `order`. The FIRST entry is what a browser resolves that bare id to in
  // the un-namespaced document, which is what a reference from a non-owning page has
  // to keep pointing at.
  //
  // Index rather than `order` because index is unique by construction and `order` is
  // an input: two fragments carrying the same `order` would be one page as far as
  // ownership went, both get the same prefix, and their colliding ids stay collided —
  // the one input that silently defeats this whole function. `order` is still what the
  // prefix and the report SAY (see `labelFor`), since that is the page numbering
  // everything else reports.
  const claims = new Map<string, number[]>();
  for (const [i, page] of pages.entries()) {
    if (!/\sid\s*=/i.test(page.innerHtml)) {
      doms.push(null);
      owned.push(new Set());
      continue;
    }
    const dom = parseFragment(page.innerHtml);
    const ids = dom ? ownedIds(dom.window.document) : new Set<string>();
    doms.push(dom);
    owned.push(ids);
    for (const id of ids) claims.set(id, [...(claims.get(id) ?? []), i]);
  }

  const collisions = [...claims].filter(([, owners]) => owners.length > 1).map(([id]) => id);
  // Pages pass 1 did not parse because they own no id, parsed in pass 2 for their
  // references. Declared out here so `finally` closes them along with pass 1's.
  const reportOnly: (JSDOM | null)[] = [];
  try {
    if (collisions.length === 0) {
      // The overwhelmingly common case: nothing to rename, so nothing is parsed and
      // reserialized and every page is delivered exactly as its agent wrote it.
      //
      // A page that used one id twice BY ITSELF is deliberately not a collision here:
      // ids are collected per page as a set, and no prefix could fix it anyway since
      // both copies would get the same one. It needs a human or the review loop, so it
      // is left to lint's `duplicate-id` / `duplicate-id-active`, which see the
      // assembled document and report it.
      return { pages: pages.map((p) => p.innerHtml), report: EMPTY_REPORT };
    }

    const colliding = new Set(collisions);
    const report: AnchorReport = { collisions: collisions.sort(), ambiguous: [], skipped_pages: [] };
    const out = pages.map((p) => p.innerHtml);

    // The prefix has to be one no id in the document already uses, or the rename
    // manufactures the very collision it exists to remove — and does it silently.
    //
    // `p1-total`, `p2-name` and the like are exactly what a paginated form or worksheet
    // emits, and the page agent has no idea the assembler reserves that shape. Given
    // `id="x"` on pages 1 and 2 plus a working `<label for="p1-x">`/`<input id="p1-x">`
    // pair on page 2, page 1's `x` becomes `p1-x` and now two elements own it. Page 2's
    // label, which named its own field correctly before assembly touched anything,
    // resolves to page 1's `<p>` — not a labelable element, so the field loses its
    // accessible name (1.3.1 / 4.1.2). Nothing in the report says so either: page 2
    // owns `p1-x`, so the reference is not ambiguous, and the page was not skipped. The
    // only symptom is a duplicate-id violation on a document that was clean before.
    //
    // So the separator is grown until no page claims anything starting with it. One
    // extra `-` per round terminates: `claims` is finite, each round is strictly longer,
    // and a document would have to contain a literal `p1--…-x` for every length below
    // the winner to push it far.
    //
    // The label a page contributes to its prefix is its `order` — the page numbering
    // the Reader, the `assembly_anchors` log and `fragments.json` all use, so a
    // delivered `p3-fn-1` names the page a human can find. But the prefix has to be
    // unique per page or the rename is a no-op for the pages that share one, and
    // `order` is caller-supplied, so a repeat is deduplicated here rather than trusted.
    const labels: string[] = [];
    const usedLabels = new Set<string>();
    for (const page of pages) {
      let label = `p${page.order}`;
      for (let n = 2; usedLabels.has(label); n++) label = `p${page.order}_${n}`;
      usedLabels.add(label);
      labels.push(label);
    }
    let sep = "-";
    const taken = [...claims.keys()];
    while (taken.some((id) => labels.some((label) => id.startsWith(`${label}${sep}`)))) sep += "-";
    const prefixFor = (index: number) => `${labels[index]}${sep}`;

    // Pass 2: which pages the join has to touch, and which of those it must not.
    //
    // A page has work to do if it owns a colliding id (its ids get prefixed) or if it
    // references one it does NOT own (that reference has to be repointed at whatever
    // the owner's id became). The second kind is easy to miss and is the shape that
    // breaks: a page carrying only the footnote markers, with the notes collected at
    // the back, owns nothing at all — so a version that only visited owners would
    // leave precisely those references dangling.
    //
    // A page needing work is parsed if pass 1 did not already do it, and then checked
    // with `wouldLoseTags`. Deciding the skips HERE, before anything is rewritten, is
    // what lets the rename targets below be computed once: a skipped page keeps its
    // bare ids, so what a reference to it should say depends on the skip decision.
    const work: { index: number; dom: JSDOM; mine: Set<string>; refs: Set<string> }[] = [];
    // Indexes, not `order`s: `skipped_pages` is the report and reports in `order`, but
    // the skip decision is consulted per page below and two pages can share an `order`.
    const skipped = new Set<number>();
    for (const [i, page] of pages.entries()) {
      const mine = owned[i];
      const ownsCollision = [...mine].some((id) => colliding.has(id));
      let dom = doms[i];
      if (!dom) {
        // No `id=` at all, so pass 1 skipped it. It can still hold a reference, so it is
        // parsed unless the source contains nothing that could be one.
        //
        // Deliberately over-inclusive, like `tagCounts`: the attribute alternatives match
        // ordinary prose too (`<p>see the headers for details</p>`), and the cost of a
        // false positive is one parse whose reference set comes back empty. A false
        // NEGATIVE would leave a page's references unrepointed, so the test is written to
        // be impossible to fail in that direction.
        if (!/href\s*=\s*["']#|\s(?:for|form|list|headers|aria-)/i.test(page.innerHtml)) continue;
        dom = parseFragment(page.innerHtml);
        reportOnly.push(dom);
      }
      if (!dom) continue;
      const { document } = dom.window;
      const refs = new Set(referencesIn(document).filter((r) => colliding.has(r) && !mine.has(r)));
      if (!ownsCollision && refs.size === 0) continue;
      // Reported whether or not the page can be rewritten — an ambiguity a skipped page
      // has to live with is still one a human should see.
      for (const ref of refs) report.ambiguous.push({ page: page.order, ref });
      if (wouldLoseTags(page.innerHtml, document)) {
        report.skipped_pages.push(page.order);
        skipped.add(i);
        continue;
      }
      work.push({ index: i, dom, mine, refs });
    }

    // What each colliding id becomes, from the point of view of the page naming it.
    //
    // If the page OWNS the id, it means its own copy: the reference and its target were
    // written together by one agent looking at one image, so no other page's copy can
    // have been meant — whatever the concatenation happened to resolve it to.
    //
    // Otherwise the reference is ambiguous, and it is repointed at the FIRST page in
    // document order that claims the id. Leaving it alone was the first answer and it
    // was the wrong one: consider a form whose `<label for="q1">` is on page 1 while
    // pages 2 and 3 each carry an `<input id="q1">`. Every owner gets renamed, so the
    // label — which named the right control before assembly touched anything — points
    // at an id no element has, the field loses its accessible name, and axe reports
    // `label` on a document a plain concatenation passed. Same shape for a notes page
    // back-referencing `#fnref-1` while two body pages both carry a marker numbered 1.
    // First-owner is what a browser resolved the bare reference to before any of this
    // ran: arbitrary between the owners, but exactly as arbitrary as the behaviour it
    // replaces, and it keeps the association `for`/`headers`/`aria-*` depend on rather
    // than destroying it.
    const resolve = (index: number, mine: Set<string>, token: string) => {
      if (!colliding.has(token)) return token; // includes `href="#"`, whose token is ""
      const owner = mine.has(token) ? index : claims.get(token)![0];
      // A page left as written kept its bare ids, so a reference to it must stay bare.
      return skipped.has(owner) ? token : `${prefixFor(owner)}${token}`;
    };

    // Pass 3: rewrite. One loop, because by now every decision has been made.
    for (const { index, dom, mine } of work) {
      const { document } = dom.window;
      for (const el of document.querySelectorAll("[id]")) {
        const id = el.getAttribute("id");
        if (id && colliding.has(id)) el.setAttribute("id", `${prefixFor(index)}${id}`);
      }
      for (const el of document.querySelectorAll("[href^='#']")) {
        const target = el.getAttribute("href")!.slice(1);
        const next = resolve(index, mine, target);
        if (next !== target) el.setAttribute("href", `#${next}`);
      }
      for (const attr of IDREF_ATTRS) {
        for (const el of document.querySelectorAll(`[${attr}]`)) {
          const value = el.getAttribute(attr)!;
          // Treated as a token list throughout: `headers` and the aria-* plural
          // attributes genuinely are, and a single-valued attribute whose value
          // contains a space was never a valid reference anyway.
          const next = value
            .split(/\s+/)
            .filter((t) => t.length > 0)
            .map((t) => resolve(index, mine, t))
            .join(" ");
          if (next !== value) el.setAttribute(attr, next);
        }
      }
      out[index] = document.body.innerHTML;
    }

    report.ambiguous.sort((a, b) => a.page - b.page || a.ref.localeCompare(b.ref));
    report.skipped_pages.sort((a, b) => a - b);
    return { pages: out, report };
  } finally {
    for (const dom of [...doms, ...reportOnly]) dom?.window.close();
  }
}
