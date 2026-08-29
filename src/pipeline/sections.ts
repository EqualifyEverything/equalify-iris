// Cutting a document body into pieces small enough that a model can return one of them.
//
// A reply the Copy Editor cannot fit in one response is a round that corrects nothing, and a
// 25-page document reaches that ceiling (issue #165). What this file provides is the cut: the
// body split at TOP-LEVEL boundaries into pieces under a character budget, so a round that
// cannot be answered whole can be answered a section at a time (review.ts, and see
// `splitSections` for the properties the caller relies on).
//
// The same cut serves the ordinary round now as well. The editor answers with the blocks it
// changed rather than the document (#250, patch.ts), and a block is one of these boundaries with
// nothing packed into it — `splitBlocks` at the bottom of this file. So there is one definition
// of where a top-level node ends, used by the contract and by the fallback for when the contract
// still does not fit.
//
// Top-level, because that is the only cut a section can be corrected at. A section that ends
// halfway through a table is not HTML the editor can return "corrected" — it would close the
// tags itself, and the join would then have a table inside a table — so a boundary is only a
// boundary where the whole prefix before it is balanced.
//
// A scan rather than a parse, for the reason correction.ts and links.ts give: this runs on
// model output mid-pipeline, and the pieces that are NOT sent anywhere must come back byte for
// byte. jsdom would reserialize them — re-quoting attributes, re-escaping entities, dropping
// the `/` from a void tag — which is a change to the delivered document that nobody asked for,
// and exactly what anchors.ts declines to risk on a page it cannot rewrite safely.
export interface Section {
  // Whitespace (and anything else outside an element) that sits before this section's first
  // tag. Kept out of what the editor is sent and re-attached by `joinSections`, so the gaps
  // assembly put between pages survive a round in which only one section changed.
  pre: string;
  // The section itself: whole top-level nodes, in document order, `pre` excluded.
  html: string;
}

// Elements with no end tag. An opening tag for one of these does not nest.
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

// Elements whose content is text, not markup: a `<` inside them opens nothing. None of these
// should appear in an extracted body (flatten.ts SILENT names the same set for the same
// reason), but a `<` inside one would unbalance the scan for the rest of the document, and the
// cost of handling them is three lines.
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);

// Block-level starts, which is the set that ends an open `<p>`.
//
// This and `impliedEnd` below are why the scan can be trusted on real output: HTML lets an end
// tag be omitted, and a page agent writing `<p>one<p>two` or `<ul><li>a<li>b</ul>` has written
// a document a browser reads as four balanced elements and a depth counter reads as one
// element that never ends. Without these rules a single omitted `</p>` anywhere would leave
// the stack non-empty to the end of the document, the body would have no cut points at all,
// and a section-at-a-time round would silently decline on a document that is perfectly
// ordinary. The list is HTML5's own (the elements whose start tag closes an open `p`).
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main", "menu", "nav",
  "ol", "p", "pre", "section", "table", "ul",
]);

const TABLE_SECTION = new Set(["thead", "tbody", "tfoot"]);

// Does opening `open` end the element `top` that is currently open? Only the omissions HTML
// actually permits, so nothing here can close an element that was legally nested: a `<td>`
// inside a `<tr>` is content, while a second `<tr>` is the first one's end tag.
function impliedEnd(open: string, top: string): boolean {
  if (top === "p") return BLOCK.has(open);
  if (top === "li") return open === "li";
  if (top === "dt" || top === "dd") return open === "dt" || open === "dd";
  if (top === "option") return open === "option" || open === "optgroup";
  if (top === "optgroup") return open === "optgroup";
  if (top === "td" || top === "th") return open === "td" || open === "th" || open === "tr" || TABLE_SECTION.has(open);
  if (top === "tr") return open === "tr" || TABLE_SECTION.has(open);
  if (TABLE_SECTION.has(top)) return TABLE_SECTION.has(open);
  return false;
}

// The tag's name, at a `<` — sticky, so it matches there or not at all and a `<` in prose
// ("a < b") is read as the text it is.
const TAG_HEAD = /<(\/?)([a-z][a-z0-9-]*)/iy;

interface Tag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  // One past the `>`, or the end of the string for a tag the model never closed.
  end: number;
}

function readTag(html: string, at: number): Tag | null {
  TAG_HEAD.lastIndex = at;
  const m = TAG_HEAD.exec(html);
  if (!m) return null;
  let i = at + m[0].length;
  // To the `>` that actually closes the tag, stepping over whole quoted values on the way:
  // `<img alt="revenue > 2019">` cut at the first `>` would leave the rest of the attribute
  // being scanned as markup (correction.ts's TAG makes the same allowance for the same
  // output).
  while (i < html.length) {
    const c = html[i];
    if (c === '"' || c === "'") {
      const close = html.indexOf(c, i + 1);
      i = close < 0 ? html.length : close + 1;
      continue;
    }
    if (c === ">") {
      return { name: m[2].toLowerCase(), closing: m[1] === "/", selfClosing: html[i - 1] === "/", end: i + 1 };
    }
    i++;
  }
  return { name: m[2].toLowerCase(), closing: m[1] === "/", selfClosing: false, end: html.length };
}

// Offsets where a top-level node ends, in increasing order — the only places the body may be
// cut. Every one of them is a position at which nothing is open, so the text before it and the
// text after it are both complete HTML.
//
// Exported for the test that reads the cut points directly: reaching an interesting one
// through `splitSections` needs a budget tuned to the fixture, which tests the packing rather
// than the scan.
export function cutPoints(html: string): number[] {
  const out: number[] = [];
  const stack: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    // A comment, a doctype or a processing instruction: opaque, and it opens nothing. Read to
    // its end rather than to the next `>`, since a comment may contain one — and to the end of
    // the document if it was never closed, which is how a parser reads it too.
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt);
      i = end < 0 ? html.length : end + 3;
      if (stack.length === 0) out.push(i);
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt);
      i = end < 0 ? html.length : end + 1;
      if (stack.length === 0) out.push(i);
      continue;
    }
    const tag = readTag(html, lt);
    if (!tag) {
      i = lt + 1;
      continue;
    }
    i = tag.end;
    if (tag.closing) {
      // An end tag closes the nearest matching start and everything still open inside it. One
      // that matches nothing open (`</p>` where no `<p>` is) is ignored, as a parser ignores
      // it, rather than being allowed to unbalance the stack the other way.
      const at = stack.lastIndexOf(tag.name);
      if (at >= 0) stack.length = at;
      if (stack.length === 0) out.push(i);
      continue;
    }
    // Implied ends are settled before anything else about this tag, because a tag that opens
    // nothing can still CLOSE something: `<hr>` ends an open `<p>` (which is what `hr` is in
    // BLOCK for), and a check that returned early for void elements would never apply the rule.
    //
    // An omitted end tag ends its element HERE, at the `<` of the tag that implies it — so the
    // cut point is `lt` and not `i`: the element that just ended is behind us, and the one whose
    // tag we have just read belongs to the next section. Recorded only when something was
    // actually popped, because a tag that opens with nothing already open is a new top-level
    // node whose boundary was recorded when the previous one closed.
    const openBefore = stack.length;
    while (stack.length && impliedEnd(tag.name, stack[stack.length - 1])) stack.pop();
    if (openBefore > 0 && stack.length === 0) out.push(lt);
    if (RAW_TEXT.has(tag.name)) {
      const close = new RegExp(`</${tag.name}\\s*>`, "i").exec(html.slice(i));
      i = close ? i + close.index + close[0].length : html.length;
      if (stack.length === 0) out.push(i);
      continue;
    }
    if (tag.selfClosing || VOID.has(tag.name)) {
      if (stack.length === 0) out.push(i);
      continue;
    }
    stack.push(tag.name);
  }
  // A cut at the very end of the body is not a cut: it would open a section with nothing in
  // it. The caller's contract is about the pieces, so it is dropped here rather than there.
  return out.filter((p) => p < html.length);
}

// Split `body` into sections of at most `budget` characters, cutting only at the top-level
// boundaries `cutPoints` found.
//
// Three properties the caller depends on:
//   * `sections.map((s) => s.pre + s.html).join("")` is the body, character for character. A
//     section the editor did not change, or could not answer, is put back exactly as it was.
//   * every section is complete HTML on its own, so "return this corrected" is a question that
//     can be answered about it.
//   * a section is over budget ONLY when one top-level node is, since a node cannot be cut.
//     The caller sees that as a section that may truncate in its turn, and containing that is
//     its business (review.ts keeps the original for a section it could not get back).
//
// One section is returned for a body with no usable cut point — a single enormous table, say.
// That is not a failure to report from here: it is the same body the caller already has, and
// the caller decides what a document it cannot divide is worth.
export function splitSections(body: string, budget: number): Section[] {
  const cuts = cutPoints(body);
  const pieces: string[] = [];
  let from = 0;
  for (const at of cuts) {
    pieces.push(body.slice(from, at));
    from = at;
  }
  if (from < body.length) pieces.push(body.slice(from));
  if (pieces.length === 0) return body ? [{ pre: "", html: body }] : [];

  // Greedy, in document order: a section takes whole nodes until the next one would put it
  // over budget. Greedy rather than balanced because the sections are corrected
  // independently and a fuller section is a section with more of its own context in it —
  // the editor cannot see what it is not sent.
  const groups: string[] = [];
  for (const piece of pieces) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.length + piece.length <= budget) groups[groups.length - 1] = last + piece;
    else groups.push(piece);
  }
  // A group of nothing but whitespace has no section in it to correct — it happens when an
  // over-budget node is followed by the newlines that separated it from the next one — so it
  // is carried by its neighbour instead of becoming a request that asks for nothing.
  const merged: string[] = [];
  for (const g of groups) {
    if (/^\s*$/.test(g) && merged.length) merged[merged.length - 1] += g;
    else merged.push(g);
  }
  return merged.map((g) => {
    const pre = /^\s*/.exec(g)![0];
    return { pre, html: g.slice(pre.length) };
  });
}

// Put the sections back together, taking each one's correction where there is one. `null` (a
// section the editor did not answer, or answered unusably) keeps the original text.
export function joinSections(sections: Section[], corrected: (string | null)[]): string {
  return sections.map((s, i) => s.pre + (corrected[i] ?? s.html)).join("");
}

// The body as its individual top-level nodes, one Section each, in document order.
//
// The same cut as `splitSections` with nothing packed into it, and deliberately the same code
// path: what `patch.ts` needs to name a block is exactly the boundary the editor's own
// section fallback already corrects at, and two scans that had to agree about where a top-level
// node ends would be two scans that eventually did not. `joinSections` therefore works on these
// as it does on sections, and the identity property holds here too —
// `splitBlocks(body).map((b) => b.pre + b.html).join("")` is the body, character for character.
//
// A budget of 0 is what "do not pack" is: no piece fits with another, so every piece becomes
// its own group, and the whitespace-only merge below it still folds a gap into its neighbour
// rather than offering a block with nothing in it to correct.
export function splitBlocks(body: string): Section[] {
  return splitSections(body, 0);
}

// Is `html` a whole number of top-level nodes — nothing left open at the end of it?
//
// Asked of a replacement the editor sends back for one block. A reply that ends inside an
// element is a reply whose extent this code would have to guess at, and splicing it in would
// close the tags with whatever followed in the document: the failure mode `splitSections` cuts
// at top-level boundaries to avoid, arriving from the other direction.
//
// The `<!---->` trick and the reason for it are `bodyLang`'s (assembly.ts): `cutPoints` drops a
// boundary that lands on the last character, so a string that ends properly and one whose last
// element was never closed both come back with no boundary at the end. Scanning with a comment
// appended makes every real node end fall before the end of the string, and the appended
// comment's own boundary is the one dropped — so whatever is left after the last boundary is
// text no element closed.
//
// The other end of the same question, and the one a tail check alone misses: an end tag that
// closes NOTHING. `cutPoints` ignores one, because that is what a parser does with it, so
// `</figure><p>x</p>` has a clean tail and is a whole number of nodes by the reading above — and
// splicing it into a block writes an end tag into the document for an element opened nowhere.
// A parser drops it, so nothing is delivered wrong to a reader, but the delivered BYTES are what
// `delivered_markup` counts (#240), and one spliced stray reports there as an element whose tags
// do not balance. It is refused for the reason its mirror image is: this code cannot tell what
// the editor meant by it, and the block it was about is safe to keep instead.
//
// Detected through `cutPoints` rather than by a second scan of the tags — two scanners that
// disagree about what a top-level node is would be the worse bug. A stray end tag is ignored by
// the stack and closes nothing, so it becomes a top-level node of its own, and a node that STARTS
// with `</` is exactly that stray.
export function topLevelComplete(html: string): boolean {
  const boundaries = cutPoints(html + "<!---->").filter((p) => p <= html.length);
  if (html.slice(boundaries.at(-1) ?? 0).trim() !== "") return false;
  let from = 0;
  for (const to of boundaries) {
    if (html.slice(from, to).trimStart().startsWith("</")) return false;
    from = to;
  }
  return true;
}
