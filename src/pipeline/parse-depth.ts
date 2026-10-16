// A depth check that runs BEFORE jsdom parses a document (#535).
//
// jsdom 25 threw `RangeError` on a deeply nested document, and every caller already treats a
// parse that throws as "could not read this". jsdom 30 parses instead, but its time grows with
// the square of the depth: 10,000 levels take about 3 s, and 200,000 would take hours. parse5 alone
// is quadratic too, so the tree cannot be measured first. This check reads the source in one
// pass and throws the same `RangeError`, so callers keep the behaviour they have.
//
// The limit is where jsdom 25 stopped. Measured: it parsed 10,000 levels in 8 s, and threw at
// 12,000 after about as long, so the limit sits between the two. jsdom 30 parses 10,000 in about
// 3 s. So every page jsdom 25 could read is still read, and the pages it could not
// read are refused in one pass instead of after a long parse. Some callers depend on that range:
// `flatten` must keep the text of a page 10,000 levels deep, because anchors.ts delivers such a
// page rather than dropping it.
//
// The count is an estimate, and it leans low on purpose. An end tag closes back to its matching
// open element, which models the parser's most common recovery. `</li>`, `</td>` and the like
// also close what was left open inside them, as does the next `<li>` or `<td>`. A new `<a>`,
// `<button>` or `<nobr>` closes an open one, and a heading closes a heading still open. Void elements, and elements whose
// end tag may be left out (`<p>`, `<li>`, `<td>` and the like), are not counted, because a table
// written `<td>a<td>b` is ordinary output and must not look deep. Each of those needs a counted
// element to nest inside, so a page built to beat the count can reach about four times the limit.
// Plain deep nesting, which is what model output and these tests produce, is counted exactly.
export const MAX_PARSE_DEPTH = 11_000;

const UNCOUNTED = new Set([
  // void
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
  "param", "keygen",
  // optional end tag
  "p", "li", "dt", "dd", "tr", "td", "th", "thead", "tbody", "tfoot", "option", "optgroup",
  "colgroup", "caption", "rb", "rt", "rtc", "rp", "html", "head", "body",
]);

// Comments and raw-text elements are skipped whole, so markup inside them is not counted.
const TOKEN =
  /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes)\b[\s\S]*?(?:<\/\1\s*>|$)|<(\/?)([a-zA-Z][^\s/>]*)[^>]*>/gi;

// Elements in UNCOUNTED whose end tag still closes what was opened inside them: `</li>`
// closes an `<em>` left open in the item. `<p>` and the table parts do the same.
const CLOSES_CONTENTS = new Set(["p", "li", "dt", "dd", "td", "th", "tr", "thead", "tbody", "tfoot", "caption", "option", "optgroup"]);

const CONTAINERS = new Set(["ul", "ol", "dl", "menu", "table", "select", "datalist"]);
const CLOSES_OWN_KIND = new Set(["a", "button", "nobr", "form", "select"]);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

// The estimated nesting depth of `html`. Stops counting once past `limit`.
export function sourceDepth(html: string, limit = Infinity): number {
  const stack: string[] = [];
  const open = new Map<string, number>();
  // For each CLOSES_CONTENTS element still open, the stack height and the number of open
  // CONTAINERS when it opened. A count, not a scan of the stack, keeps this one pass.
  const marks = new Map<string, [number, number][]>();
  let containers = 0;
  const closeTo = (height: number) => {
    while (stack.length > height) {
      const top = stack.pop()!;
      open.set(top, open.get(top)! - 1);
      if (CONTAINERS.has(top)) containers--;
    }
  };
  let max = 0;
  for (const m of html.matchAll(TOKEN)) {
    const name = m[3]?.toLowerCase();
    if (!name) continue;
    const end = m[2] === "/";
    if (CLOSES_CONTENTS.has(name)) {
      const heights = marks.get(name) ?? [];
      // A mark above the current stack belongs to an element its parent already closed.
      while (heights.length && heights.at(-1)![0] > stack.length) heights.pop();
      // A new `<li>` closes the open one, and what was left open in it, unless a list or
      // table was opened inside it since.
      if (!end && heights.length && containers <= heights.at(-1)![1]) closeTo(heights.pop()![0]);
      if (!end) heights.push([stack.length, containers]);
      else if (heights.length) closeTo(heights.pop()![0]);
      marks.set(name, heights);
      continue;
    }
    // `<x/>` is not counted. It is self-closing in SVG and MathML, and in HTML treating it so
    // can only count low.
    if (UNCOUNTED.has(name) || (!end && m[0].endsWith("/>"))) continue;
    if (!end) {
      // A new element in CLOSES_OWN_KIND closes or replaces the open one, and a heading closes
      // a heading left open directly above it, so `<a>x<a>y` and `<h2>x<h2>y` are not nested.
      if (CLOSES_OWN_KIND.has(name) && open.get(name)) closeTo(stack.lastIndexOf(name));
      else if (HEADINGS.has(name) && HEADINGS.has(stack.at(-1) ?? "")) closeTo(stack.length - 1);
      stack.push(name);
      open.set(name, (open.get(name) ?? 0) + 1);
      if (CONTAINERS.has(name)) containers++;
      if (stack.length > max) max = stack.length;
      if (max > limit) return max;
    } else if (open.get(name)) {
      // Close back to the matching element; a stray end tag closes nothing.
      closeTo(stack.lastIndexOf(name));
    }
  }
  return max;
}

// Throws the `RangeError` an over-deep parse used to throw, before the parse is attempted.
export function assertParseable(html: string): void {
  if (sourceDepth(html, MAX_PARSE_DEPTH) > MAX_PARSE_DEPTH) {
    throw new RangeError(`document is nested more than ${MAX_PARSE_DEPTH} levels deep and was not parsed`);
  }
}
