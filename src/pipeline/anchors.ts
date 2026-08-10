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
  // Bare ids that more than one page claimed. Namespaced, EXCEPT for whatever appears in
  // `pinned_ids` — see there, and do not read this field as "every one of these was
  // rewritten".
  collisions: string[];
  // Colliding ids whose first owner was deliberately left bare, because a page that could
  // not be rewritten holds a reference to it and a frozen reference can only find a bare
  // id. Reported for the same reason `skipped_pages` is: without it, a bare colliding id in
  // the delivered document is indistinguishable in the run log from the namespacing having
  // silently failed. The other owners of a pinned id are still renamed, so the id appears
  // here AND in `collisions`.
  pinned_ids: string[];
  // References that name a colliding id from a page that does not own it, so no page
  // can say which copy was meant. They are repointed at the first owner in document
  // order — what the un-namespaced document resolved them to — and reported here
  // because a reference disambiguated by document order rather than by the agent that
  // wrote it is a document worth a human's attention. Named `ambiguous` and not
  // `unresolved`: they do resolve, just not on the page's own authority.
  ambiguous: { page: number; ref: string }[];
  // Pages left exactly as written, either because rewriting them would have lost markup
  // (see `wouldChangeMarkup`) or because they could not be parsed at all (see
  // `parseFragment`), and which are relevant to the join: they own a colliding id or refer
  // to one. Either the page's own colliding ids keep their bare form — in
  // which case lint's `duplicate-id` / `duplicate-id-active` names the collision — or
  // an ambiguous reference on it keeps pointing at a bare id that other pages
  // renamed away, which is why the page is named here as well as in `ambiguous`.
  skipped_pages: number[];
}

const EMPTY_REPORT: AnchorReport = { collisions: [], pinned_ids: [], ambiguous: [], skipped_pages: [] };

// The characters that can sit immediately before an attribute name in source HTML, as a
// regex character class. Both passes below use a cheap regex over the unparsed source to
// decide whether a page is worth parsing at all, and each needs to be certain it cannot
// return false when a real attribute is present.
//
// `\s` and `/` are the obvious ones. `"` and `'` are here because a quoted attribute
// value can be followed IMMEDIATELY by the next attribute name: `<p class="note"id="x">`
// is a parse error the spec recovers from by reconsuming in before-attribute-name state,
// so jsdom reads a real `id` there. That one cost a round — the comment this replaces
// asserted `[\s/]` was the complete set, having reasoned about it rather than measured.
//
// So it is measured. Enumerating every ASCII character in each position where a preceding
// attribute can end, and recording the character sitting directly before every attribute
// jsdom actually parsed, yields exactly eight: `\t \n \f \r space " ' /`. All eight are in
// this class, and the enumeration lives in test/assembly-anchors.test.ts so a jsdom upgrade
// that widens the set fails a test rather than going unnoticed.
//
// One shared constant rather than the same class written twice: the two sniffs have now
// drifted apart twice, and both times the pass that was left behind was the bug.
//
// Exported only for that test. It is the class ITSELF that has to be measured, not a copy
// of it written out again in the test file — a copy would keep passing while this drifted.
export const ATTR_SEP = `[\\s/"']`;

// Start tags and text, in document order. Tags are `<name`, text is `#normalized`, so no
// text run can ever be mistaken for a tag (a run that decodes to `<div` becomes `#<div`).
//
// TEXT is in here, not just tags, because foster parenting moves text on its own. A tag
// sequence alone declared this page safe and reordered it:
//
//   <table><caption id="c1">Cap</caption>Continued from page 1<tr><td>x</td></tr></table>
//
// reserializes with `Continued from page 1` after the entire table instead of before the
// rows. Every tag is present and in order, so the tag-only sequence saw nothing — while
// text a page agent plausibly emits for a table continued across a break, on exactly the
// shape that produces these collisions, silently moved out of reading order.
// Quoted attribute values are consumed as units so a `>` inside one does not end the tag:
// `<p title="a > b">` is one tag, and treating it as a tag plus the text `b">` made the
// guard skip an ordinary page and leave a real collision unfixed. Unbalanced quotes fail to
// match at all and fall through to text, which is the over-skip direction — safe.
const SOURCE_TOKEN = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][^\s/>]*)(?:"[^"]*"|'[^']*'|[^>"'])*>/g;

// Whitespace-collapsed, and entity-decoded when there is an entity to decode, because the
// parsed side is compared against text nodes: `a &amp; b` in the source is `a & b` there.
// The decode is a parse, so it is skipped unless the run contains `&` — which also keeps
// the parser away from runs holding a bare `<` that is only prose.
function normalizeText(raw: string, document: Document): string {
  let text = raw;
  if (text.includes("&")) {
    const decoder = document.createElement("div");
    decoder.innerHTML = text; // A text run by construction: no tag to be moved by this parse.
    text = decoder.textContent ?? "";
  }
  return text.replace(/\s+/g, " ").trim();
}

// The sequence the source ASKS for. Computed from the source text and not from the parsed
// document, because the whole question is what parsing changed.
//
// Over-inclusive by design, in both the tag and the text direction: an attribute value
// containing `>` splits into a tag plus a text run that the parsed document will not have,
// and a comment or doctype the pattern does not match becomes text. Each of those is an
// extra token that fails to match, so the page is left as written — the safe direction. The
// unsafe direction is a token this MISSES, which is what let both previous versions through.
function sourceSequence(source: string, document: Document): string[] {
  const out: string[] = [];
  let last = 0;
  const pushText = (raw: string) => {
    const text = normalizeText(raw, document);
    if (text) out.push(`#${text}`);
  };
  for (const m of source.matchAll(SOURCE_TOKEN)) {
    pushText(source.slice(last, m.index));
    last = m.index + m[0].length;
    // Start tags only. A close tag is not a position in the reading order — the parser
    // supplies missing ones and moves them freely, and `<b>1<p>2</b>3</p>` legitimately
    // ends up with more of them than the source wrote.
    if (!m[0].startsWith("<!--") && m[1] === "") out.push(`<${m[2].toLowerCase()}`);
  }
  pushText(source.slice(last));
  return out;
}

// The same sequence, read off the parsed document. Comments are skipped on both sides.
function parsedSequence(document: Document): string[] {
  const out: string[] = [];
  const visit = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === child.ELEMENT_NODE) {
        out.push(`<${(child as Element).tagName.toLowerCase()}`);
        visit(child);
      } else if (child.nodeType === child.TEXT_NODE) {
        const text = (child.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text) out.push(`#${text}`);
      }
    }
  };
  visit(document.body);
  return out;
}

// Would reserializing this page change its markup as anything more than a rewrite of the
// ids? True means leave the page exactly as its agent wrote it.
//
// The source's sequence of tags AND text must appear in order in the parsed document — a
// subsequence, not an equality and not a multiset. That form is what it is because of what
// each relaxation has to allow and what it must still catch:
//
//   * Extra tokens in the parsed output are fine, so a subsequence rather than equality. A
//     well-formed `<table><tr>` gains the `<tbody>` the source omitted, and the adoption
//     agency algorithm DUPLICATES a tag to repair misnesting — `<b>1<p>2</b>3</p>` becomes
//     `<b>1</b><p><b>2</b>3</p>`, two `<b>` from one. An equality check abandons the
//     rewrite on both, leaving exactly the collisions this exists to fix.
//   * Order matters, which is why this is a sequence and not the COUNTS it used to be.
//     Counting cannot see a MOVE, and foster parenting moves things: a `<p>` inside a
//     `<table>` is hoisted out to before the table, so
//     `<table>…<p id="fn-1">note</p></table><p>tail</p>` reserializes with the note ahead
//     of the table it followed. Every count is identical, so that guard called the page
//     safe and rewrote it — a reading-order change, on the one property this codebase
//     exists to protect, and on precisely the shape (content inside a table) that a table
//     spanning a page break produces, which is also what produces these collisions.
//   * Text is a token, not just tags, which is the same failure one level down. Bare prose
//     inside a table foster-parents out with every tag still in place and in order, so a
//     tag-only sequence declared the page safe and moved the text — see SOURCE_TOKEN. The
//     `<p>`-wrapped version of that content was caught only because `<p>` is a tag.
//
// Skipping the page costs a duplicate id that lint reports. Rewriting it costs silently
// reordered content. The header's rule applies: that is not a trade to make.
function wouldChangeMarkup(source: string, document: Document): boolean {
  const wanted = sourceSequence(source, document);
  const got = parsedSequence(document);
  let next = 0;
  for (const token of got) {
    if (next < wanted.length && wanted[next] === token) next++;
  }
  return next < wanted.length;
}

function ownedIds(document: Document): Set<string> {
  const ids = new Set<string>();
  for (const el of document.querySelectorAll("[id]")) {
    const id = el.getAttribute("id");
    if (id) ids.add(id);
  }
  return ids;
}

// Null when the page cannot be parsed at all. Reachable: jsdom builds its tree
// recursively, so a deeply nested fragment throws `RangeError: Maximum call stack size
// exceeded` somewhere between 8,000 and 16,000 nested elements. Malformed markup does NOT
// get here — the HTML parser has a recovery rule for everything and raises nothing — so
// this is the depth case and cases like it, not the ordinary bad-input case.
function parseFragment(innerHtml: string): JSDOM | null {
  try {
    return new JSDOM(`<body>${innerHtml}</body>`, { virtualConsole: new VirtualConsole() });
  } catch {
    return null;
  }
}

// The ids a page's SOURCE claims, read without parsing. Used only when the parse failed,
// where the alternative is recording that the page owns nothing — and that is not a
// neutral default but a false statement with teeth. An unparseable page is delivered
// byte-for-byte, so every id in its source is in the output; a page missing from `claims`
// is invisible as an owner to both readers of `skipped`, so the collision goes undetected
// AND the pin below sees no skipped owner and fires, putting a second bare copy of the id
// in the document. The duplicate that whole condition exists to prevent, reached by the
// one route that reports nothing.
//
// This one must NOT be over-inclusive, which is the opposite of the rule everywhere else in
// this file, because a phantom owner is worse than a missed one. Both readers of `skipped`
// rest on "a skipped owner is ALREADY keeping the bare id", and a phantom owner never had
// one: an `id=x` read out of prose on an unparseable page made that page a `claims` owner,
// so the pin declined to fire and every REAL owner was renamed — leaving a `<label for="x">`
// on another page pointing at nothing, the unnamed-field failure (1.3.1/4.1.2) the pin
// exists to prevent, on an id that was never a collision in the first place. Missing a real
// id costs a duplicate id that lint's `duplicate-id` reports, which is the trade this file's
// header makes in that direction and only that direction.
//
// So ids are read from real attribute positions only — see `sourceAttrs`.
//
// Exported for the test that measures it against jsdom, for the same reason `ATTR_SEP` is:
// reaching it through `namespaceAnchors` needs a fragment too deep for jsdom to parse, which
// costs ~10s per shape, so an enumeration would dominate the suite. The end-to-end route has
// its own tests; this export is what lets the scan's agreement with the parser be checked
// shape by shape.
export function sourceIds(innerHtml: string): Set<string> {
  return new Set(sourceAttrs(innerHtml).get("id") ?? []);
}

// The references a page's SOURCE makes, read without parsing — the mirror of `sourceIds`,
// needed for the same reason. An unparseable page is delivered as written, so its
// `for="q1"` is frozen in bare form exactly like a page the reserialization guard skipped.
// Without this the pin never learns the reference exists, every owner of `q1` is renamed,
// and the reference names nothing — an unnamed field, 1.3.1/4.1.2, which is the trade this
// file's header refuses and the defect the pin was added to fix. It was fixed for the guard
// route and left open for this one.
//
// Here over-inclusiveness IS the safe direction, unlike `sourceIds` above: a reference that
// is not really there pins a first owner that did not need pinning, which leaves one
// colliding id bare and renames the rest — no duplicate, no dangling reference. Missing one
// is the dangling reference. The two functions read the same source through the same scan
// and want opposite error directions, which is why that asymmetry is stated at both ends
// rather than left to a shared comment.
//
// `headers` and the `aria-*` list attributes are space-separated, so each token counts.
//
// Exported for the test that measures it against jsdom, for the same reason `sourceIds` is.
export function sourceRefs(innerHtml: string): Set<string> {
  const refs = new Set<string>();
  const attrs = sourceAttrs(innerHtml);
  for (const value of attrs.get("href") ?? []) {
    if (value.startsWith("#") && value.length > 1) refs.add(value.slice(1));
  }
  for (const attr of IDREF_ATTRS) {
    for (const value of attrs.get(attr) ?? []) {
      for (const token of value.split(/\s+/)) if (token) refs.add(token);
    }
  }
  return refs;
}

// Attribute name (lowercased) -> every value the source gives it, read without parsing.
//
// Tag-aware, not a bare regex over the whole string, because `sourceIds` needs a name that
// is really in attribute position: a plain `id\s*=` scan matched `id=x` in prose and
// `title='id="x"'`, and each phantom cost a dangling reference (see `sourceIds`). Tags are
// found with the same SOURCE_TOKEN the reserialization guard uses — so comments are skipped
// and a quoted value containing `>` does not end the tag — and each tag's attributes are
// then walked in order, so a value is consumed by the name it belongs to and can never be
// re-read as a name itself.
//
// A tag SOURCE_TOKEN cannot match (an unbalanced quote, say) contributes nothing. For
// references that is the unsafe direction and is why `sourceRefs` is only ever consulted for
// pages already being delivered as written, where a missed reference leaves the same
// wrong-target it had before assembly rather than a new dangling one; for ids it is the safe
// direction, per `sourceIds`.
function sourceAttrs(innerHtml: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const tag of innerHtml.matchAll(SOURCE_TOKEN)) {
    if (tag[0].startsWith("<!--")) continue;
    // Past the tag name: `<` + optional `/` + the name.
    const interior = tag[0].slice(1 + tag[1].length + tag[2].length, -1);
    for (const attr of interior.matchAll(TAG_ATTR)) {
      const name = attr[1].toLowerCase();
      const value = attr[2] ?? attr[3] ?? attr[4];
      if (value === undefined || value === "") continue;
      out.set(name, [...(out.get(name) ?? []), value]);
    }
  }
  return out;
}

// One attribute inside a tag: a name, then optionally `=` and a quoted or bare value.
// Matched repeatedly over a tag's interior so each value is consumed by its own name.
const TAG_ATTR = /([^\s/>="']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g;

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
//
// **`pages` must already be in document order** — a precondition, not a preference.
// `resolve` sends a reference the page does not own to the FIRST page in the array
// claiming that id, on the grounds that this is what a browser resolved the bare
// reference to before any renaming. Array order is what that reads, so an unsorted
// input would silently repoint at a different owner than the pre-assembly document
// used. `assembleBodyWithReport`, the only caller, sorts by `.order` first. Sorting
// again here would be the wrong fix: `order` is caller-supplied and can repeat (see
// the label deduplication below), so a sort would not establish the property, and it
// would hide a caller that had lost track of its own ordering.
export function namespaceAnchors(pages: { order: number; innerHtml: string }[]): {
  pages: string[];
  report: AnchorReport;
} {
  // Pass 1: who owns what. A page with no ids cannot contribute a collision, and
  // needs no parse for the rewrite either, so most documents stop here.
  const doms: (JSDOM | null)[] = [];
  const owned: Set<string>[] = [];
  // Pages whose parse was ATTEMPTED and failed, as against merely not attempted. Both leave
  // `doms[i]` null and pass 2 must not conflate them: a page pass 1 skipped for owning no id
  // can still be parsed there for its references, while one that already failed cannot be
  // parsed at all and is delivered as written. The first version of pass 2 ran the second
  // kind through the first kind's path, so it exited at the reference sniff and was never
  // recorded as skipped — the duplicate id survived with an empty report.
  const unparseable = new Set<number>();
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
    // The same ATTR_SEP class pass 2's reference sniff uses. A false negative is
    // worse here than there: the page contributes nothing to `claims`, so the collision is
    // not merely unrepointed but never DETECTED, and the whole join no-ops on a document
    // that ships two `id="fn-1"` with an empty report. Lint's `duplicate-id` still catches
    // that one, which is the difference between a reported defect and a silent one, but
    // the fix belongs here.
    if (!new RegExp(`${ATTR_SEP}id\\s*=`, "i").test(page.innerHtml)) {
      doms.push(null);
      owned.push(new Set());
      continue;
    }
    const dom = parseFragment(page.innerHtml);
    // A failed parse still owns its ids: the page is delivered as written, so they are in
    // the document whether or not anything here could read them from a DOM. See `sourceIds`
    // for why recording nothing is worse than recording an over-inclusive set.
    const ids = dom ? ownedIds(dom.window.document) : sourceIds(page.innerHtml);
    if (!dom) unparseable.add(i);
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
    const report: AnchorReport = { collisions: collisions.sort(), pinned_ids: [], ambiguous: [], skipped_pages: [] };
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
    // with `wouldChangeMarkup`. Deciding the skips HERE, before anything is rewritten, is
    // what lets the rename targets below be computed once: a skipped page keeps its
    // bare ids, so what a reference to it should say depends on the skip decision.
    const work: { index: number; dom: JSDOM; mine: Set<string>; refs: Set<string> }[] = [];
    // Indexes, not `order`s: `skipped_pages` is the report and reports in `order`, but
    // the skip decision is consulted per page below and two pages can share an `order`.
    const skipped = new Set<number>();
    // Colliding ids that a skipped page REFERS to but does not own — the references that
    // are stuck in their bare form, whatever the rest of the document does. See `pinned`.
    const refsOfSkipped = new Map<number, Set<string>>();
    for (const [i, page] of pages.entries()) {
      const mine = owned[i];
      const ownsCollision = [...mine].some((id) => colliding.has(id));
      let dom = doms[i];
      if (!dom && !unparseable.has(i)) {
        // No `id=` at all, so pass 1 skipped it. It can still hold a reference, so it is
        // parsed unless the source contains nothing that could be one.
        //
        // Deliberately over-inclusive, like `sourceSequence`: the attribute alternatives match
        // ordinary prose too (`<p>see the headers for details</p>`), and the cost of a
        // false positive is one parse whose reference set comes back empty. A false
        // NEGATIVE would leave a page's references unrepointed, so the test has to be
        // impossible to fail in that direction — and an earlier version was not.
        //
        // It required a QUOTE after `href=`, so a page owning no `id=` whose only
        // cross-page reference was `href=#fn-1` was skipped here and never repointed,
        // while the pages owning `fn-1` were renamed out from under it. That link had
        // resolved to the wrong note before assembly; afterwards it resolved to nothing,
        // and nothing said so — the page appears in neither `ambiguous` nor
        // `skipped_pages`, so no `assembly_anchors` line names it, and axe has no rule for
        // a broken same-document anchor. Exactly the trade this file's header rejects,
        // reached through the one branch that claimed it could not be.
        //
        // So the quote after `href=` is optional, and the attribute separator is the
        // ATTR_SEP class rather than `\s`. Both of those were bugs found one at a time,
        // each one a page whose references went unrepointed.
        if (!new RegExp(`href\\s*=\\s*["']?#|${ATTR_SEP}(?:for|form|list|headers|aria-)`, "i").test(page.innerHtml)) continue;
        dom = parseFragment(page.innerHtml);
        if (!dom) unparseable.add(i);
        reportOnly.push(dom);
      }
      if (!dom) {
        // The parse failed, so this page cannot be rewritten and is delivered byte-for-byte
        // — the same OUTCOME as tripping the reserialization guard below, so it joins the
        // same set. Two rules read `skipped` that way: `resolve` keeps a reference to a
        // skipped owner bare, and the pin refuses to fire when an owner was skipped.
        //
        // Membership in `skipped` is not by itself enough to reach either reader, which was
        // the bug in the first version of this branch: both reach a page THROUGH `claims`,
        // so a page absent from `claims` is invisible as an owner no matter what this set
        // says. Hence pass 1's `sourceIds` fallback. The record here is one of three halves.
        //
        // Everything this page contributes is therefore read from its SOURCE — ids in pass
        // 1, references here. There is no DOM and there never will be one, so the
        // alternative is not a degraded answer but no answer: the page's frozen `for="q1"`
        // would be unknown to the pin, every owner of `q1` would be renamed, and the
        // reference would name nothing. That is the mirror defect the pin exists to prevent,
        // fixed for the reserialization-guard route and left open for this one.
        //
        // Recorded only when the page is relevant to the join: it owns a colliding id, or it
        // refers to one it does not own. `skipped_pages` is documented as "may still carry a
        // collision or a stranded reference" and a human is asked to act on it, so a page
        // that fails to parse while doing neither is noise there.
        const frozenRefs = new Set([...sourceRefs(page.innerHtml)].filter((r) => colliding.has(r) && !mine.has(r)));
        if (!ownsCollision && frozenRefs.size === 0) continue;
        for (const ref of frozenRefs) report.ambiguous.push({ page: page.order, ref });
        skipped.add(i);
        report.skipped_pages.push(page.order);
        if (frozenRefs.size > 0) refsOfSkipped.set(i, frozenRefs);
        continue;
      }
      const { document } = dom.window;
      const refs = new Set(referencesIn(document).filter((r) => colliding.has(r) && !mine.has(r)));
      if (!ownsCollision && refs.size === 0) continue;
      // Reported whether or not the page can be rewritten — an ambiguity a skipped page
      // has to live with is still one a human should see.
      for (const ref of refs) report.ambiguous.push({ page: page.order, ref });
      if (wouldChangeMarkup(page.innerHtml, document)) {
        report.skipped_pages.push(page.order);
        skipped.add(i);
        if (refs.size > 0) refsOfSkipped.set(i, refs);
        continue;
      }
      work.push({ index: i, dom, mine, refs });
    }

    // Colliding ids whose FIRST owner must keep its bare form, because a page that could
    // not be rewritten holds a reference to it.
    //
    // The skip guard leaves a page byte-for-byte as its agent wrote it, which means a
    // reference on that page keeps pointing at a bare id. If that id's owners are all
    // renamed anyway, the reference names nothing — and for `for`/`headers`/`aria-*` a
    // no-target reference is a 1.3.1/4.1.2 failure, where the wrong-target one it replaced
    // at least gave the field a name. That is the trade this file's header refuses, and
    // `resolve` already refuses it in the mirror direction (a reference TO a skipped page
    // stays bare). This is the same rule applied to a reference FROM one.
    //
    // Only the first owner is pinned, not every owner and not the whole id. First owner is
    // what a browser resolved the bare reference to in the concatenated document, so the
    // skipped page keeps exactly the association it had; the remaining owners are still
    // renamed, so the duplicate is still fixed for everyone else. Pinning the whole id
    // would abandon the collision entirely on account of one unrewritable page.
    //
    // And nothing is pinned when an OWNER of the id was itself skipped, which is the
    // condition that makes this rule safe rather than self-defeating. A skipped owner keeps
    // its bare id by definition — it is delivered byte-for-byte as written — so the frozen
    // reference already finds a real element, and pinning a second copy on top of that
    // manufactures the duplicate id this whole module exists to remove. Without this check
    // a form continued across a page break (two pages claiming `q1`, one of them holding
    // orphaned `<tr>`s the guard will not rewrite) shipped two `id="q1"`, which axe reports
    // as `duplicate-id-aria`. The premise "the frozen reference can only ever find the bare
    // one" is what needs the qualification: when an owner is skipped, the bare one is
    // already there.
    const pinned = new Set<string>();
    for (const i of skipped) {
      for (const ref of refsOfSkipped.get(i) ?? []) {
        if ((claims.get(ref) ?? []).some((owner) => skipped.has(owner))) continue;
        pinned.add(ref);
      }
    }
    // Reported, because a pinned id is a colliding id that was deliberately NOT renamed.
    // `collisions` alone would say it was, so the run log could not tell an intentional
    // bare id from namespacing that silently failed.
    report.pinned_ids = [...pinned].sort();

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
      if (skipped.has(owner)) return token;
      // And the first owner of a pinned id keeps its bare form for a skipped page's
      // reference, so a reference resolved TO that owner has to stay bare as well —
      // otherwise this page's reference is the one left naming nothing.
      if (pinned.has(token) && owner === claims.get(token)![0]) return token;
      return `${prefixFor(owner)}${token}`;
    };

    // Whether this page's copy of a colliding id gets renamed. False only for the first
    // owner of a pinned id — the one a skipped page's bare reference has to keep finding.
    const renames = (index: number, id: string) =>
      !(pinned.has(id) && index === claims.get(id)![0]);

    // Pass 3: rewrite. One loop, because by now every decision has been made.
    for (const { index, dom, mine } of work) {
      const { document } = dom.window;
      for (const el of document.querySelectorAll("[id]")) {
        const id = el.getAttribute("id");
        if (id && colliding.has(id) && renames(index, id)) el.setAttribute("id", `${prefixFor(index)}${id}`);
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
