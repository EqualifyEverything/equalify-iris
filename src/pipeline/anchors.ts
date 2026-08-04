import { JSDOM, VirtualConsole } from "jsdom";

// Make one page's ids unique within the assembled document (PRD §7.7).
//
// Extraction is per page and independent: `extractPage` runs concurrently, each
// call sees one image, and no page knows what any other page emitted. Assembly is
// then a plain concatenation. So any id a page invents is a claim about the whole
// document that the page had no way to check — and the page prompt asks for ids by
// name, for footnotes: `id="fn-N"` with `href="#fn-N"`, numbering preserved from
// the source. A three-page scan whose pages each carry a footnote "1" is the normal
// case, not an edge case, and it produces three `id="fn-1"` in one file.
//
// The failure is silent and specific: every `href="#fn-1"` resolves to the FIRST
// one, so a screen-reader user following the reference on page 3 lands on page 1's
// note and the back-reference returns them to the wrong paragraph. The reference
// still looks like a working link. Both notes exist, both are announced, and
// nothing in the output says they are crossed.
//
// The axe gate does not see it. In the pinned axe-core, `duplicate-id` is tagged
// `wcag2a-obsolete`/`deprecated` (WCAG 2.2 dropped 4.1.1), so the tag filter in
// lint.ts excludes it; `duplicate-id-aria` is `wcag2a` but fires only for ids
// referenced from ARIA attributes, not from an `href`. `runAxe` on a document with
// the duplicated pairs returns `{ ok: true, violations: [] }`. lint.ts re-enables
// the rule explicitly as a backstop for what the review loop's editor may
// reintroduce; this function is what stops it arising in the first place.
//
// Rewriting the ids means rewriting everything that points AT them, in the same
// pass and from the same id set. Half of this — unique ids, stale references —
// would be worse than the collision: `<label for>` and `<th id>`/`<td headers>`
// are how a field gets its accessible name and how a data cell is attributed to
// its headers, so a dangling reference is a WCAG 1.3.1/4.1.2 failure on content
// that was correct before assembly touched it.
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

// A reference is rewritten ONLY when it resolves inside this same fragment, which
// is what makes a cross-page reference survive as a visibly broken link instead of
// a silently wrong one. A marker on page 3 whose body is on page 4 keeps
// `href="#fn-1"`, now pointing at nothing, because pointing at page 1's unrelated
// note is the outcome this function exists to prevent — and the page prompt already
// tells the agent to report that split in its "log" field.
export function namespaceAnchors(innerHtml: string, prefix: string): string {
  // A page with no ids cannot collide, and most pages have none — so it is returned
  // untouched rather than parsed and reserialized, which would rewrite the model's
  // markup for no benefit (jsdom canonicalizes: `required` becomes `required=""`, a
  // `<table>` gains a `<tbody>`). This regex is only the fast path; the guarantee is
  // the `owned.size === 0` return below, which holds even for a page whose only
  // "id=" is inside a text node.
  if (!/\sid\s*=/i.test(innerHtml)) return innerHtml;

  let dom: JSDOM;
  try {
    dom = new JSDOM(`<body>${innerHtml}</body>`, { virtualConsole: new VirtualConsole() });
  } catch {
    return innerHtml; // unparseable: leave the page exactly as the agent wrote it
  }
  try {
    const { document } = dom.window;
    const owned = new Set<string>();
    for (const el of document.querySelectorAll("[id]")) {
      const id = el.getAttribute("id");
      if (id) owned.add(id);
    }
    if (owned.size === 0) return innerHtml;

    const rename = (id: string) => `${prefix}${id}`;
    for (const el of document.querySelectorAll("[id]")) {
      const id = el.getAttribute("id");
      if (id) el.setAttribute("id", rename(id));
    }
    // Same-document fragment links: `#fn-1`, and `href="#"` / `#top` which name no
    // id and must not be prefixed into one.
    for (const el of document.querySelectorAll("[href^='#']")) {
      const target = el.getAttribute("href")!.slice(1);
      if (target && owned.has(target)) el.setAttribute("href", `#${rename(target)}`);
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
          .map((t) => (owned.has(t) ? rename(t) : t))
          .join(" ");
        if (rewritten !== value) el.setAttribute(attr, rewritten);
      }
    }
    return document.body.innerHTML;
  } catch {
    return innerHtml;
  } finally {
    dom.window.close();
  }
}
