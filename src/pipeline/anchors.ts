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

// How deeply a page's PARSED tree may nest before this module refuses to rewrite it.
//
// Rewriting a page recurses per level of nesting in three places — jsdom's serializer
// (`body.innerHTML`), its `window.close()`, and this file's own `parsedSequence` — so a deep
// enough page overflows the stack in one of them. Which one goes first is not worth relying
// on: measured, serialization and `close()` throw from about 4,000 levels while the parse
// itself survives past 10,000, so the band between them PARSED and then threw out of the
// rewrite, while a DEEPER page whose parse failed cleanly was delivered fine. Behaviour that
// was non-monotonic in depth, with the worse outcome on the shallower input. And each
// threshold moves with how much stack the caller has already used, so none of them is a
// number to build on.
//
// Hence one limit, far below all of them. Past it the page is delivered exactly as written,
// which is the same outcome as tripping the reserialization guard and is handled by the same
// code. Real documents do not nest 500 elements deep; the limit is for pathological input,
// and refusing a page that did not need refusing costs a duplicate id that lint reports —
// the trade this file's header makes in that direction.
//
// With one qualification worth stating where the number is chosen, because it is the one
// place the trade is weaker than it sounds: axe overflows on a deep document too, from a few
// thousand levels, and `runAxe` degrades to `ok: true` with an `error` rather than failing the
// session. So past that depth the duplicate id ships with no lint finding naming it. That is
// not a reason to fail the run over nesting — a delivered document with a duplicate id beats
// no document — but it does mean the fallback reporter is silent exactly where this guard is
// most likely to fire, which is why `runAssembly` logs `lint_error` alongside `lint_ok`.
const MAX_NESTING = 500;

// The exact depth of the PARSED tree, measured with an explicit stack rather than recursion
// (the recursion is what is being guarded against) and stopping as soon as the limit is
// passed.
//
// The parsed tree and not the source, because the source cannot be counted. The first
// version of this guard counted start tags that had not been closed, which is not a depth:
// void elements and implied end tags never came back down, so a 120-row table written
// `<tr><td>a<td>b` — real depth 4 — and a page with 600 `<br>` — real depth 1 — were both
// refused. Both are ordinary page-agent output, and refusing them shipped the duplicate id
// this module exists to remove. A table continued across a page break is the very scenario
// that produces these collisions, so that regression was not a corner case. Estimating
// depth from source means modelling the parser's implied-end-tag and void-element rules,
// which is exactly what `sourceAttrs` had to stop doing; measuring the tree needs no model.
function exceedsNesting(document: Document): boolean {
  // Depth of `body`'s children is 1, matching "how deeply nested is this page".
  const stack: { node: Element; depth: number }[] = [...document.body.children].map((node) => ({ node, depth: 1 }));
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > MAX_NESTING) return true;
    for (const child of node.children) stack.push({ node: child, depth: depth + 1 });
  }
  return false;
}

// What parsing a page yielded. Three outcomes, and the middle one is the reason this is a
// result type rather than `JSDOM | null`:
//
//   * `dom` set and `rewritable` true — the ordinary page.
//   * `dom` set and `rewritable` FALSE — too deep to rewrite, but its tree can still be
//     READ. Reading it is exact, where scanning its source is a guess (see `readable`).
//   * `dom` null — the parse itself threw, so there is no tree at all and the source scan is
//     the only reading available.
type ParsedPage = { dom: JSDOM | null; rewritable: boolean };

// Parse a page and decide what may be done with it.
//
// Parsing FIRST and measuring the tree is deliberate. The parse is not what overflows first
// — it survives to roughly twice the depth the serializer does — so it is the one step that
// can be run in order to find out how deep the page really is. Malformed markup reaches
// neither failure exit: the HTML parser has a recovery rule for everything and raises
// nothing.
//
// A too-deep page KEEPS its DOM rather than discarding it, which is the point. The recursive
// steps are serialization, `window.close()` and this file's `parsedSequence`; `querySelectorAll`
// is iterative and works at any depth, so ids and references can be read off the tree exactly.
// The earlier version threw the DOM away and fell back to `sourceIds`, which reads the source
// without the parser's tree-construction rules and so invented owners for markup the parser
// DROPS — an orphan `<tr><td id="c">`, a stray `<caption>`, a `<col>`, anything after
// `<plaintext>`. Each phantom manufactured a collision no delivered element had, renamed the
// real owner, suppressed the pin and left a `<label for>` naming nothing: the 1.3.1/4.1.2
// failure the pin exists to prevent, on an id that never collided. Modelling more of the
// parser was the wrong direction — reading the tree it already built needs no model.
function parseFragment(innerHtml: string): ParsedPage {
  let dom: JSDOM;
  try {
    dom = new JSDOM(`<body>${innerHtml}</body>`, { virtualConsole: new VirtualConsole() });
  } catch {
    return { dom: null, rewritable: false };
  }
  return { dom, rewritable: !exceedsNesting(dom.window.document) };
}

// The ids a page's SOURCE claims, read without parsing. Used only when `parseFragment`
// refused the page (nested past `MAX_NESTING`, or the parse threw), where the alternative is
// recording that the page owns nothing — and that is not a
// neutral default but a false statement with teeth. Such a page is delivered
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

// Elements whose CONTENT the parser does not build a tree from, so a tag-shaped string
// inside one is text and its attributes are not attributes. Measured, not listed from the
// spec: for every element name a `<b id="phantom">` was placed inside it and the parsed
// document was asked whether `phantom` came back. These are the ones where it did not.
//
// `template` is in here for a different reason than the rest — its content IS parsed, into
// a separate document fragment `querySelectorAll` on the body never sees — but the
// consequence for this scan is identical, so the distinction does not earn a branch.
//
// `select` is here too, and it is the odd one: the parser drops most tags inside it rather
// than treating them as text, so `<select><b id="x"></select>` yields no `x` — but
// `<option id="x">`, `<optgroup>` and `<hr>` ARE kept. Skipping the whole element therefore
// MISSES real ids rather than inventing phantoms, which is `sourceIds`' safe direction and
// `sourceRefs`' unsafe one; both are the same trade the unmatched-tag case already makes
// below, and a scan that modelled select's content rules would be modelling the parser.
//
// `plaintext` and `noscript` are deliberately absent, for opposite reasons.
//
// `plaintext` never ends: everything after it is text, so the parser keeps no id that
// follows one. Omitting it here therefore invents a phantom for every such id — the unsafe
// direction for `sourceIds`, and a real gap while this scan was the only reading of a
// too-deep page. Adding it would be the safe (miss) direction, since the skip would run to a
// `</plaintext>` that cannot exist and so to the end of the page. It stays out because that
// choice no longer decides anything: `parseFragment` keeps the too-deep DOM and ids are read
// from the tree, so this scan now runs only for a page with no tree at all, where the id
// count is a guess either way. Left as-is rather than "fixed" in a function whose remaining
// caller cannot tell the difference.
//
// `noscript` is absent because its content IS parsed when scripting is disabled, which is how
// jsdom parses these fragments — skipping it would miss ids the parser really kept.
const RAW_CONTENT = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "template",
  "xmp",
  "noembed",
  "noframes",
  "iframe",
  "select",
]);

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
// Being in a tag is not sufficient, though: a tag inside a `<textarea>` or `<script>` is
// TEXT, and the tag-aware version still walked it. `<textarea><p id="x"></textarea>` on an
// unparseable page made that page a phantom owner of `x`, suppressing the pin and renaming
// the real owner — the manufactured dangling `for=` that `sourceIds` describes, reached
// through markup a page agent transcribing a form field plausibly emits. So RAW_CONTENT
// elements are skipped to their close tag.
//
// Values are DECODED, because the parser decodes them: `for="q&#49;"` is a reference to
// `q1`, and reading it literally left the frozen reference unseen, every owner of `q1`
// renamed, and nothing in the report — `sourceRefs`' unsafe direction. `id="fn&#45;1"` is
// the mirror on the id side, where an undecoded value is a phantom.
//
// First value wins per name, because that is the parser's rule for a repeated attribute:
// `<p id="a" id="b">` is `a`, and collecting both made `b` a phantom.
//
// A tag SOURCE_TOKEN cannot match (an unbalanced quote, say) contributes nothing. For
// references that is the unsafe direction and is why `sourceRefs` is only ever consulted for
// pages already being delivered as written, where a missed reference leaves the same
// wrong-target it had before assembly rather than a new dangling one; for ids it is the safe
// direction, per `sourceIds`.
function sourceAttrs(innerHtml: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  // A scratch document, only to decode attribute values. One per call, not one per value.
  const scratch = new JSDOM("<body></body>", { virtualConsole: new VirtualConsole() });
  try {
    const holder = scratch.window.document.createElement("div");
    // Re-parsed in attribute position, which is where the value came from and where the
    // decoding rules differ from text: `a&ampb` stays literal in an attribute and becomes
    // `a&b` in text. A raw `"` can only have arrived from a single-quoted or unquoted value,
    // so re-encoding it round-trips. Measured against the parser over every quoting style.
    const decode = (raw: string) => {
      if (!raw.includes("&")) return raw;
      holder.innerHTML = `<i x="${raw.replace(/"/g, "&#34;")}">`;
      return holder.firstElementChild?.getAttribute("x") ?? raw;
    };
    let skipTo = 0;
    for (const tag of innerHtml.matchAll(SOURCE_TOKEN)) {
      if (tag.index < skipTo) continue;
      if (tag[0].startsWith("<!--")) continue;
      const name = tag[2].toLowerCase();
      // Past the tag name: `<` + optional `/` + the name.
      const interior = tag[0].slice(1 + tag[1].length + tag[2].length, -1);
      // The element's own attributes are real either way — it is its CONTENT that is not
      // markup — so they are read before skipping. A close tag has none to read.
      if (tag[1] === "") {
        // Per TAG, so a repeated name keeps this tag's first value — the parser's rule.
        // Accumulated across tags, because every tag's `id` is a separate id.
        const seen = new Set<string>();
        for (const attr of interior.matchAll(TAG_ATTR)) {
          const attrName = attr[1].toLowerCase();
          const value = attr[2] ?? attr[3] ?? attr[4];
          if (value === undefined || value === "") continue;
          if (seen.has(attrName)) continue;
          seen.add(attrName);
          out.set(attrName, [...(out.get(attrName) ?? []), decode(value)]);
        }
      }
      if (tag[1] === "" && RAW_CONTENT.has(name)) {
        // To the matching close tag, which the parser accepts with trailing junk
        // (`</textarea foo>`) and in any case. No close tag means the element runs to the
        // end of the page — the parser's rule, and the miss rather than phantom direction.
        // Not nesting-aware, which matches the parser: raw text ends at its first close tag,
        // and a nested `<template>` inside one already-skipped `<template>` only widens the
        // skip, never narrows it.
        const close = new RegExp(`</${name}(?:${ATTR_SEP}[^>]*)?>`, "i");
        const rest = innerHtml.slice(tag.index + tag[0].length);
        const found = rest.search(close);
        skipTo = found === -1 ? innerHtml.length : tag.index + tag[0].length + found;
      }
    }
  } finally {
    scratch.window.close();
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
  // Pages that were parsed and CANNOT be rewritten — the parse threw, or the tree is deeper
  // than `MAX_NESTING`. As against merely not parsed yet: a page pass 1 skipped for owning no
  // id can still be parsed in pass 2 for its references, while one of these is delivered as
  // written whatever pass 2 finds. The first version of pass 2 ran the second kind through the
  // first kind's path, so it exited at the reference sniff and was never recorded as skipped —
  // the duplicate id survived with an empty report.
  //
  // Not the same as `doms[i] == null`, which is why it is its own set: a too-deep page keeps a
  // readable DOM (see `parseFragment`), so it is in here WITH a `doms` entry.
  const unrewritable = new Set<number>();
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
    const { dom, rewritable } = parseFragment(page.innerHtml);
    // A page that cannot be REWRITTEN still owns its ids: it is delivered as written, so they
    // are in the document either way, and recording nothing would be a false statement with
    // teeth (see `sourceIds`). Read from the tree whenever there is one — exact, and available
    // even for a too-deep page, since `querySelectorAll` does not recurse. The source scan is
    // only for a page that has no tree at all.
    const ids = dom ? ownedIds(dom.window.document) : sourceIds(page.innerHtml);
    if (!rewritable) unrewritable.add(i);
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
      if (!dom && !unrewritable.has(i)) {
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
        const parsed = parseFragment(page.innerHtml);
        dom = parsed.dom;
        if (!parsed.rewritable) unrewritable.add(i);
        reportOnly.push(dom);
      }
      if (unrewritable.has(i)) {
        // This page cannot be rewritten — the parse threw, or its tree is deeper than
        // `MAX_NESTING` — so it is delivered byte-for-byte. That is the same OUTCOME as
        // tripping the reserialization guard below, so it joins the same set. Two rules read
        // `skipped` that way: `resolve` keeps a reference to a skipped owner bare, and the pin
        // refuses to fire when an owner was skipped.
        //
        // Membership in `skipped` is not by itself enough to reach either reader, which was
        // the bug in the first version of this branch: both reach a page THROUGH `claims`,
        // so a page absent from `claims` is invisible as an owner no matter what this set
        // says. Hence pass 1 records its ids either way. The record here is one of three halves.
        //
        // References come from the TREE when there is one, even though it is too deep to
        // rewrite: `querySelectorAll` does not recurse, so the reading is exact. Only a page
        // whose parse threw has no tree, and there the source scan is the sole option —
        // without it the page's frozen `for="q1"` would be unknown to the pin, every owner of
        // `q1` would be renamed, and the reference would name nothing. That is the mirror
        // defect the pin exists to prevent, fixed for the guard route and left open for this
        // one. What this branch must NOT do is fall through to `wouldChangeMarkup`, which
        // walks the tree recursively and is one of the steps that overflows at this depth.
        //
        // Recorded only when the page is relevant to the join: it owns a colliding id, or it
        // refers to one it does not own. `skipped_pages` is documented as "may still carry a
        // collision or a stranded reference" and a human is asked to act on it, so a page
        // that cannot be rewritten while doing neither is noise there.
        const readRefs = dom ? referencesIn(dom.window.document) : [...sourceRefs(page.innerHtml)];
        const frozenRefs = new Set(readRefs.filter((r) => colliding.has(r) && !mine.has(r)));
        if (!ownsCollision && frozenRefs.size === 0) continue;
        for (const ref of frozenRefs) report.ambiguous.push({ page: page.order, ref });
        skipped.add(i);
        report.skipped_pages.push(page.order);
        if (frozenRefs.size > 0) refsOfSkipped.set(i, frozenRefs);
        continue;
      }
      if (!dom) continue;
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
    for (const dom of [...doms, ...reportOnly]) {
      // `close()` walks the tree recursively, so it overflows on a page kept for reading but
      // too deep to rewrite. A throw from a `finally` would replace this function's return
      // value with a `RangeError`, turning a document the caller had already been handed into
      // a failed run — so cleanup is allowed to fail. What it releases early is otherwise left
      // to the collector.
      try {
        dom?.window.close();
      } catch {
        // Deliberately empty: see above.
      }
    }
  }
}
