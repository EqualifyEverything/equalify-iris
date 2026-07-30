import { JSDOM } from "jsdom";

// Produce a flattened, text-only view of an HTML chunk that approximates what a
// screen reader announces, in order (PRD §7.8). The Reader cross-checks this
// against the HTML structure to surface reading-order problems.
//
// The one invariant: **no text may be dropped.** This function has two consumers
// and losing content breaks both, in ways that look like success:
//
//   * The Reader reviews this view instead of the source images, so anything
//     missing here is invisible to review — no issue is raised and the loop has
//     nothing to act on.
//   * `contentCoverage` (pipeline/feedback.ts) measures a candidate agent against
//     an accepted fixture by comparing THESE words. Text that never reaches the
//     output is absent from both sides, so dropping it makes a regression
//     unmeasurable: the gate that exists to stop an agent update from losing
//     content scores it 1.0 and waves it through.
//
// An earlier version emitted a role marker and `return`ed for `table`, `li`, `a`,
// `img`, `label`, `blockquote` and headings, which meant a table contributed only
// its `<caption>` — delete every row of a table and this view, and therefore the
// regression gate, could not tell the difference. It also built each line from
// `node.textContent`, which concatenates without separators, so a nested list came
// out as the single nonsense word "FruitApple" and an image inside a link lost its
// alt text entirely.
//
// The fix is an inline/block split, which is also closer to how a screen reader
// actually works: inline elements are announced *within* the surrounding phrase,
// block elements are separate stops.

// Announced as part of the surrounding line rather than as a stop of their own.
// `a` and `img` are here because their whole point is appearing mid-sentence: an
// `<img>` inside an `<a>` supplies the link's accessible name, so treating either
// as a leaf loses the other.
const INLINE = new Set([
  "a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "dfn", "em", "i",
  "img", "kbd", "mark", "q", "rp", "rt", "ruby", "s", "samp", "small", "span",
  "strong", "sub", "sup", "time", "u", "var", "wbr",
]);

const HEADING = /^h([1-6])$/;
const ELEMENT = 1;
const TEXT = 3;

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

// Role markers are always bracketed. `contentCoverage` strips `[...]` before
// comparing words, so a marker must never look like content — an unbracketed
// annotation would be counted as a word the agent "produced" and would dilute the
// coverage ratio on both sides.
function blockMarker(tag: string): string | null {
  const h = HEADING.exec(tag);
  if (h) return `[Heading ${h[1]}]`;
  switch (tag) {
    case "li": return "[List item]";
    case "blockquote": return "[Quote]";
    case "label": return "[Label]";
    case "figcaption": case "caption": return "[Caption]";
    case "dt": return "[Term]";
    case "dd": return "[Definition]";
    case "option": return "[Option]";
    default: return null;
  }
}

interface El {
  tagName: string;
  getAttribute(n: string): string | null;
  childNodes: ArrayLike<Node>;
  children: ArrayLike<El & Node>;
  querySelectorAll(s: string): ArrayLike<El & Node>;
  closest(s: string): unknown;
  textContent: string | null;
}

const asEl = (n: Node): El => n as unknown as El;
const tagOf = (el: El): string => el.tagName.toLowerCase();

export function flatten(html: string): string {
  const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`);
  const doc = dom.window.document;
  const out: string[] = [];

  // The announcement text of an inline subtree, joined with spaces so word
  // boundaries survive (`textContent` would give "FruitApple"). Block tags
  // encountered here — a list inside a table cell, say — are flattened rather
  // than dropped: the structure is lost but every word is kept, which is the
  // property both consumers depend on.
  const inlineText = (node: Node): string => {
    if (node.nodeType === TEXT) return norm(node.textContent ?? "");
    if (node.nodeType !== ELEMENT) return "";
    const el = asEl(node);
    const tag = tagOf(el);
    if (tag === "img") return `[Image] alt="${el.getAttribute("alt") ?? "(missing)"}"`;
    if (tag === "br") return "";
    const kids = Array.from(el.childNodes).map(inlineText).filter(Boolean).join(" ");
    // A link's name can come from its text, its nested image's alt, or both, so
    // the marker precedes whatever the subtree produced instead of replacing it.
    if (tag === "a") return norm(`[Link] ${kids}`);
    if (tag === "select") return norm(`[Field select] ${kids}`);
    return kids;
  };

  // A table is announced cell by cell, so it is expanded row by row here. Nested
  // tables are left to `inlineText` (their rows are excluded below by the
  // `closest` check, so nothing is emitted twice).
  const table = (el: El): void => {
    const rows = Array.from(el.querySelectorAll("tr")).filter((r) => r.closest("table") === el);
    const caption = Array.from(el.querySelectorAll("caption")).filter((c) => c.closest("table") === el)[0];
    const cols = rows.length ? Math.max(...rows.map((r) => Array.from(r.children).filter((c) => /^(td|th)$/.test(tagOf(c))).length)) : 0;
    const label = caption ? norm(caption.textContent ?? "") : "(no caption)";
    out.push(norm(`[Table] ${label} (${rows.length} rows, ${cols} columns)`));
    for (const row of rows) {
      const cells = Array.from(row.children).filter((c) => /^(td|th)$/.test(tagOf(c)));
      const headerRow = cells.length > 0 && cells.every((c) => tagOf(c) === "th");
      const text = cells.map((c) => inlineText(c) || "(empty)").join(" | ");
      out.push(norm(`${headerRow ? "[Header row]" : "[Row]"} ${text}`));
    }
  };

  // Walk a block element's children, accumulating runs of inline content into
  // lines and recursing into block children. `marker` is attached to the first
  // line this element produces — or emitted alone, ahead of its block children,
  // when it has no inline content of its own.
  const block = (parent: El, marker: string | null): void => {
    let pending = marker;
    let run: string[] = [];
    const flush = (): void => {
      const text = norm(run.join(" "));
      run = [];
      if (pending !== null) {
        if (!text && !pending) return;
        out.push(norm(`${pending} ${text}`));
        pending = null;
      } else if (text) {
        out.push(text);
      }
    };

    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === TEXT) {
        const t = norm(child.textContent ?? "");
        if (t) run.push(t);
        continue;
      }
      if (child.nodeType !== ELEMENT) continue;
      const el = asEl(child);
      const tag = tagOf(el);
      if (INLINE.has(tag)) {
        const t = inlineText(child);
        if (t) run.push(t);
        continue;
      }
      // A block child ends the current line. Flushing first is what keeps
      // reading order intact: "Fruit" is announced before the nested list.
      flush();
      if (tag === "table") {
        table(el);
      } else if (tag === "input" || tag === "textarea") {
        // Leaf fields. The attributes are included because a screen reader
        // announces them, and `textarea` carries its value as text.
        const bits = [el.getAttribute("type"), el.getAttribute("placeholder"), el.getAttribute("value"), norm(el.textContent ?? "")];
        out.push(norm(`[Field ${tag}] ${bits.filter(Boolean).join(" ")}`));
      } else {
        block(el, blockMarker(tag));
      }
    }
    flush();
  };

  block(asEl(doc.body), null);
  dom.window.close();
  return out.join("\n");
}
