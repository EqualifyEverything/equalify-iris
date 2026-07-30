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

// Role markers are always bracketed, and that includes the ones that read like
// prose: `[3 rows, 2 columns]`, `[empty]`, `[no caption]`, `[spans 3 columns]`.
// `contentCoverage` strips `[...]` before comparing words, so anything outside
// brackets is treated as content the agent produced.
//
// This is not cosmetic. Written as `(2 rows, 3 columns)` the words `rows` and
// `columns` join the compared word sets, and any candidate that emits a table at
// all reproduces them for free — two guaranteed hits per table fixture. On a
// fixture that lost one of three table rows that padding moved the reported
// coverage from 0.833 to 0.875, across `MIN_CONTENT_COVERAGE = 0.85`: the gate
// passed an update that had dropped a row. `MIN_COVERAGE_WORDS` is 8, so the
// shorter the fixture the more the padding dominates.
//
// Bracketing is the fix rather than also stripping `(...)` in `contentCoverage`,
// because parentheses appear in real extracted prose ("(see appendix)") and
// stripping them there would discard genuine content from both sides — trading
// this bug for a quieter version of the one this file exists to prevent.
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
    default: return null;
  }
}

// Interactive controls, announced with their role and accessible name. `select` is
// here rather than in INLINE because it needs the same treatment in both positions
// and INLINE membership alone would not give it one. `button` and `summary` are here
// because a control that flattens to bare prose is indistinguishable from a
// paragraph in the one view the Reader uses to judge control labelling — and an
// icon-only button (the common accessible-name defect) flattened to nothing at all.
const FIELD = new Set(["input", "textarea", "select", "button", "summary"]);

// Never announced and never transcribed content. Their text was being emitted as
// content, so injected CSS or JS became free hits in the coverage word sets — the
// gate would read as *healthier* the more style markup an agent leaked.
const SILENT = new Set(["style", "script", "template", "noscript"]);

// An accessible name can come from an attribute rather than from the subtree. A
// field labelled only by `aria-label` is correct, axe-clean markup, so dropping it
// both hid real content from the gate and made the Reader — told to treat a field
// with no nearby label as a defect — report a phantom issue on correct markup.
// `aria-labelledby` is deliberately not resolved: it references ids elsewhere in the
// document, which may be outside the chunk being flattened, and a wrong resolution
// would invent text rather than lose it.
function ariaName(el: El): string {
  return norm(el.getAttribute("aria-label") ?? el.getAttribute("title") ?? "");
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

// The number of columns a cell occupies. A `colspan` header is correct markup, so
// counting cells structurally and reporting a row as narrower than its table
// invents a defect in an already-accessible table — and the Reader is told to treat
// a cell-count mismatch as evidence of a real problem, while the Copy Editor is
// licensed to restructure table headers. Spanning header cells are common in the
// scanned tabular documents Iris takes as input, so the false positive would fire
// on ordinary work.
// `rowspan` gets the same treatment: a cell spanning rows leaves later rows with
// fewer cells than the table has columns, which is correct markup the Reader would
// otherwise be instructed to read as a defect.
function span(el: El, attr: "colspan" | "rowspan" = "colspan"): number {
  const n = parseInt(el.getAttribute(attr) ?? "", 10);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 1000) : 1;
}

export function flatten(html: string): string {
  const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`);
  const doc = dom.window.document;
  const out: string[] = [];

  // A form control's announcement. Shared by `inlineText` and `block` because a
  // field's text lives in its ATTRIBUTES, not its child nodes, so any path that
  // recurses into children instead of calling this drops the value entirely — and
  // `<input>` has no children at all. When only `block` handled fields, every field
  // inside a table cell (cells are announced via `inlineText`) and every field under
  // an inline wrapper contributed nothing: a form-as-table with all its values
  // emptied scored `contentCoverage` 1.0, the exact failure this file exists to
  // prevent. A form rendered as both a table and a form is not hypothetical —
  // EDITOR_SYSTEM names it as a case the pipeline produces.
  const fieldText = (el: El): string => {
    const tag = tagOf(el);
    // `input` has no children and carries its value as an attribute; everything else
    // here announces its subtree (a select's options, a button's or summary's label).
    // A select's options are announced as its value, separated so two options never
    // run together into an invented word. `[Option]` is deliberately not emitted per
    // option: it is not a stop of its own inside a control, and a marker the code
    // never produces but the prompt advertises teaches the Reader to expect something
    // that will not appear.
    const inner =
      tag === "input"
        ? ""
        : tag === "select"
          ? Array.from(el.children)
              .map((c) => inlineText(c))
              .filter(Boolean)
              .join(", ")
          : Array.from(el.childNodes).map(inlineText).filter(Boolean).join(" ");
    // `type` goes INSIDE the marker: a screen reader announces it as the control's
    // role ("email text field"), so it is an annotation, not content the agent
    // transcribed. Left outside, "email"/"checkbox"/"submit" would be counted as
    // words in the coverage comparison and reproduced free by any candidate that
    // emits a similar control.
    const type = norm(el.getAttribute("type") ?? "");
    const bits = [ariaName(el), el.getAttribute("placeholder"), el.getAttribute("value"), inner];
    return norm(`[Field ${tag}${type ? ` ${type}` : ""}] ${bits.filter(Boolean).join(" ")}`);
  };

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
    if (SILENT.has(tag)) return "";
    // The alt text itself is content and stays outside the brackets; the fact that
    // it is absent is an annotation and goes inside, for the same reason the table
    // summary does. `alt=""` is distinguished from a missing `alt`: the first is
    // correct markup for a decorative image, the second is a defect, and the Reader
    // is told to treat only the second as one. An `aria-label`/`title` name is used
    // when there is no `alt` at all, since that is what a screen reader announces.
    if (tag === "img") {
      const alt = el.getAttribute("alt");
      if (alt === null) {
        const aria = ariaName(el);
        return aria ? norm(`[Image alt] ${aria}`) : "[Image] [alt missing]";
      }
      return alt.trim() ? norm(`[Image alt] ${alt}`) : "[Image] [decorative, alt empty]";
    }
    if (tag === "br") return "";
    if (FIELD.has(tag)) return fieldText(el);
    const kids = Array.from(el.childNodes).map(inlineText).filter(Boolean).join(" ");
    // A link's name can come from its text, its nested image's alt, an attribute, or
    // several of those, so the marker precedes whatever the subtree produced instead
    // of replacing it. The attribute name is added only when the subtree yielded
    // nothing, so a normal link is not announced twice.
    if (tag === "a") return norm(`[Link] ${kids || ariaName(el)}`);
    return norm(`${kids} ${kids ? "" : ariaName(el)}`);
  };

  // A table is announced cell by cell, so it is expanded row by row here. Nested
  // tables are left to `inlineText` (their rows are excluded below by the
  // `closest` check, so nothing is emitted twice).
  const table = (el: El): void => {
    const rows = Array.from(el.querySelectorAll("tr")).filter((r) => r.closest("table") === el);
    const caption = Array.from(el.querySelectorAll("caption")).filter((c) => c.closest("table") === el)[0];
    const cellsOf = (r: El): (El & Node)[] => Array.from(r.children).filter((c) => /^(td|th)$/.test(tagOf(c)));
    // Column count is the widest row measured in COLUMNS, not in cells, so a
    // `colspan` header does not make the table look narrower than its body rows.
    const width = (r: El): number => cellsOf(r).reduce((n, c) => n + span(c), 0);
    const cols = rows.length ? Math.max(...rows.map(width)) : 0;
    // `inlineText`, not `textContent`: a caption with block children
    // (`<caption><p>Fees</p><p>Apple</p></caption>`) concatenated to "FeesApple" —
    // the same invented-word bug the rest of this file was rewritten to remove, and
    // worse than a plain drop, since the invented word pollutes both compared word
    // sets while the real ones vanish from both.
    const label = caption ? inlineText(caption as unknown as Node) : "[no caption]";
    out.push(norm(`[Table] ${label} [${rows.length} rows, ${cols} columns]`));
    for (const row of rows) {
      const cells = cellsOf(row);
      const headerRow = cells.length > 0 && cells.every((c) => tagOf(c) === "th");
      const text = cells
        .map((c) => {
          // Spans are announced on the cell so a row that is narrower in cells than
          // the table is in columns still reconciles — otherwise the Reader, told to
          // treat a cell-count mismatch as a defect, reports a phantom issue and the
          // Copy Editor restructures correct markup. `rowspan` produces exactly the
          // same short row as `colspan`, one row later.
          const cs = span(c);
          const rs = span(c, "rowspan");
          const notes = [cs > 1 ? `[spans ${cs} columns]` : "", rs > 1 ? `[spans ${rs} rows]` : ""];
          return norm(`${inlineText(c) || "[empty]"} ${notes.filter(Boolean).join(" ")}`);
        })
        .join(" | ");
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
      if (SILENT.has(tag)) continue;
      if (INLINE.has(tag)) {
        const t = inlineText(child);
        if (t) run.push(t);
        continue;
      }
      // A block child ends the current line. Flushing first is what keeps
      // reading order intact: "Fruit" is announced before the nested list.
      //
      // Unless this element has produced no line yet: then its marker travels down
      // to the child instead of being emitted alone. `<li><p>text</p></li>` and
      // `<label><div>Work email</div></label>` are ordinary shapes, and a bare
      // `[List item]` or `[Label]` on its own line reads to the Reader as an empty
      // list item or an unlabelled control — the phantom-defect direction, since the
      // prompt teaches it to treat empty structures as real problems.
      const inherit = pending !== null && !run.length && tag !== "table" && !FIELD.has(tag);
      if (inherit) {
        const own = blockMarker(tag);
        const combined = own ? `${pending} ${own}` : (pending as string);
        pending = null;
        block(el, combined);
        continue;
      }
      flush();
      if (tag === "table") {
        table(el);
      } else if (FIELD.has(tag)) {
        // Same helper as the inline path, so a field announces identically wherever
        // it sits. `select` included: recursing into it instead would emit a bare run
        // of `[Option]` lines with no `[Field select]`, leaving the Reader unable to
        // see that the control has no accessible name.
        out.push(fieldText(el));
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
