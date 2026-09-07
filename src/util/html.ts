// Named and numeric character references, decoded. Shared because the same
// decoding is needed on both sides of a link comparison: poppler writes XML entities
// into the hrefs it reports (`&amp;` in a query string), and the page agent writes
// them into the HTML it produces — so `?y=2026&q=1` and `?y=2026&amp;q=1` are the
// same URL, and a comparison that does not know that reports a link as missing while
// it sits in the document.
//
// Only the five XML entities are named here, plus `&#39;`. That is deliberate: this
// decodes attribute values and anchor text for comparison, not arbitrary prose, and
// the full HTML5 named-reference table (2000+ entries) is a dependency's worth of
// data for characters that do not change whether two URLs match. Numeric references
// cover the rest.
//
// Null-prototype, and that is load-bearing: a plain object literal answers
// `NAMED["constructor"]` with a function inherited from Object.prototype, so a URL
// containing the literal text `&constructor;` would decode to `function Object() {
// [native code] }` on one side of a comparison and stay written as it is on the
// other — turning a link that IS in the document into a reported miss, which is the
// exact failure this file exists to prevent.
const NAMED: Record<string, string> = Object.assign(Object.create(null), {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
});

// U+00AD SOFT HYPHEN, in every spelling a model can write it, including as a raw
// character. `&shy` without the semicolon is deliberately NOT matched: it is legal
// HTML5, but requiring the semicolon is what keeps this from eating the literal text
// `&shy` out of a page about HTML entities, and a model that omits it is a case nothing
// has produced. `&amp;shy;` is safe by construction — the `&` is consumed by `amp`, so
// there is no `&` immediately before `shy;` for this to match.
//
// Written as an escape and not as the character itself, because the character itself is
// invisible: a regex with one in it looks to the next reader like `/|&shy;/`.
const SOFT_HYPHEN = /\u00ad|&shy;|&#0*173;|&#x0*ad;/gi;

// Take soft hyphens out of markup a model wrote, and say how many there were.
//
// There is no page where one is the right answer, which is what makes this a code repair
// rather than a prompt clause (issue #334). `agents/page.md` already forbids the thing
// that produces them — a word the printing broke at the end of a LINE is written whole,
// the break is not carried into the markup — and three models from three labs carry it
// anyway. What ships when they do is worse than a visible hyphen in one respect: nothing
// renders, so a page reads as clean, while find-in-page silently fails. A reader
// searching a delivered document for `Insurance` does not match `Insur&shy;ance`, and the
// words this lands on are table row labels and column headings, which are the words a
// reader searches for.
//
// The count is returned rather than logged here so the caller names the reply it came
// from: the same character from the first render, from the correction pass and from a
// specialist are three different facts about three different calls.
export function stripSoftHyphens(html: string): { html: string; removed: number } {
  let removed = 0;
  const out = html.replace(SOFT_HYPHEN, () => {
    removed++;
    return "";
  });
  return { html: out, removed };
}

// A space in the markup, in the spellings a model writes one that is not a plain U+0020. `\s` already
// covers a raw U+00A0, so what this adds is the entity forms of it — included for the reason
// `SOFT_HYPHEN` includes its own: they render identically and defeat a find-in-page identically, so a
// repair that matched only the codepoint would fix a cell and leave its neighbour looking the same.
const SPACE_SRC = "(?:\\s|&nbsp;|&#0*160;|&#x0*a0;)";

// A cell whose whole content is one figure. `<` is not in the class, and that is the scope: a cell
// carrying a tag — a <sup> footnote marker beside the number, an <abbr> — does not match at all, so
// its digits are left exactly as written. On #374's census that is 3 of 549 separated groups, and
// they stay as they are rather than being handled by a second, looser pattern nothing has measured.
//
// The bracketing characters are what a column of money and percentages prints around its figures: a
// leading `$`, a `(` … `)` pair for a negative, a trailing `%`. They are allowed so that `$4, 271` and
// `(1, 234)` are still recognised as a figure; nothing else is, because the point of the test is that
// the cell holds no prose the gap could belong to.
const NUMERIC_CELL = new RegExp(`^[$(]?-?(?:[\\d,.]|${SPACE_SRC})+[)%]?$`, "i");

// One `<td>` or `<th>` with no tag inside it, quoted attribute regions consumed as units so an
// attribute value containing `>` does not cut the tag short (the reason `hyphens.ts` writes its `TAG`
// the same way). The closing tag is matched against the captured name, so a `<td>` closed by `</th>`
// is not treated as a cell.
const PLAIN_CELL = /<(td|th)((?:[^>"']|"[^"]*"|'[^']*')*)>([^<]*)<\/\1\s*>/gi;

// The printer's alignment space, inside a thousands group. `(?!\d)` is the whole of the guard: the
// group after the comma must be exactly three digits, so `1954, 1955` in a list of years does not
// match (four digits) and `1, 2, 3` does not match (one), while `4, 271` does.
const DIGIT_GROUP_GAP = new RegExp(`(\\d),${SPACE_SRC}+(?=\\d{3}(?!\\d))`, "gi");

// Close up a thousands separator a page split with the printer's alignment space — `4, 271` back to
// `4,271` — inside numeric table cells only, and say how many were closed.
//
// This is the same kind of repair as `stripSoftHyphens` and the same argument for doing it in code:
// the gap is the column being aligned rather than part of the figure, `agents/page.md` says so ("a
// figure keeps its digits and loses the printer's space"), and a model does it anyway — 549 separated
// groups on 6 of 91 pages of one arm, 166 on another, none on a third (#374). What ships is worse than
// it looks: a reader searching a delivered document for `4,271` does not match `4, 271`, and a total
// written that way is two numbers to anything that adds a column up. `p028` and `p029` are the same
// table transcribed twice, 174 groups spaced on one page and 39 tight on the other, which is what
// makes this a per-cell coin flip rather than a page's considered style.
//
// Scoped to the cell and never applied to the document, because the same pattern loose in prose
// changes text that is right: `In 1954, 105 cases were filed` becomes `In 1954,105 cases`. The `(?!\d)`
// guard is not enough on its own for that one — `105` is three digits — so the guard that matters is
// the enclosing cell holding nothing but a figure. 546 of #374's 549 groups sit in such a cell.
//
// One case the two guards together still cannot separate, stated because it is the shape a false
// positive would take: a numeric cell holding a comma-separated LIST whose next element is exactly
// three digits (`9, 100` meaning nine and one hundred) is written the same way as one split separator,
// and this closes it up. Nothing distinguishes them inside the cell — only the column's other rows do,
// which this does not read — and the census found none: 0 false positives over 91 pages, which is a
// count on one corpus rather than a property of the rule.
export function tightenDigitGroups(html: string): { html: string; tightened: number } {
  let tightened = 0;
  const out = html.replace(PLAIN_CELL, (whole, name: string, attrs: string, content: string) => {
    if (!NUMERIC_CELL.test(content.trim())) return whole;
    // The digit before the comma is put back from the capture rather than as `$1`: a replacer
    // FUNCTION gets no substitution, so returning "$1," would write those two characters into the
    // cell and delete the digit.
    const fixed = content.replace(DIGIT_GROUP_GAP, (_m, digit: string) => {
      tightened += 1;
      return `${digit},`;
    });
    if (fixed === content) return whole;
    return `<${name}${attrs}>${fixed}</${name}>`;
  });
  return { html: out, tightened };
}

// One `style` attribute, in every quoting a model writes. Unquoted values are matched too — legal
// HTML for a value with no space in it, `style=color:red` — because the point is that none of these
// reach the output.
// The value is captured, because the properties it sets are half of what this reports.
const STYLE_ATTR_SRC = `\\s+style\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`;
const STYLE_ATTR = new RegExp(STYLE_ATTR_SRC, "gi");

// A `<span>` whose only attributes are `style`, holding nothing but whitespace. Matched BEFORE the
// strip and as a whole element, which is what scopes the removal to this strip's own residue: a
// `<span></span>` the model wrote empty is not touched, and neither is `<span class="x" style="…">`,
// which still has an attribute after the strip and so is still a span someone put there on purpose.
//
// The gap between the tags is CAPTURED and handed back rather than removed with the element, because
// the two things it can be are not distinguishable here and the errors are not the same size. A space
// inside a legend swatch is layout, and putting it back costs nothing — HTML collapses it, so
// `<span style="…"> </span> under 5%` renders the same either way. A space between two text runs
// (`Ohio<span style="…"> </span>5%`) is the word boundary, and taking it out delivers `Ohio5%`: text
// the page prints nowhere, produced by the repair, which is the harm this family exists to stop. So
// the one-directional error licenses the one side, and what is removed is the element, never content.
const EMPTY_STYLED_SPAN = new RegExp(`<span(?:${STYLE_ATTR_SRC})+\\s*>(\\s*)</span\\s*>`, "gi");

// One tag, with its name and its attribute region apart, so the strip runs on attributes and not on
// prose. A page about HTML that prints `style="color:red"` in its text is transcribing what the paper
// prints, and rewriting that would be the same fault as repairing a misspelling.
const ANY_TAG = /<([a-z][a-z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;

// One attribute inside that region, name and value apart. The region is walked pair by pair rather
// than searched for `style`, and that is not tidiness: an attribute VALUE can contain the text
// `style="…"` — an alt describing a tag, a code sample the page prints — and a pattern that scans the
// whole tag for a style attribute finds it there and cuts a hole in the alt. Walking pairs means the
// name has to be in name position.
const ATTR = /([^\s=/>]+)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*))?/g;

// The CSS property names a declaration block sets, lowercased — `padding-left:2em;background:#ccc`
// gives `padding-left` and `background`. Only the part before each colon, so a value containing a
// colon (`background:url(http://…)`) does not add a property of its own.
const DECLARATION = /(?:^|;)\s*([a-z-]+)\s*:/gi;

// A `<td>` or `<th>` holding nothing but whitespace. Used to count what the strip left behind, never
// to change anything: `agents/page.md` calls an empty cell the one encoding a reader cannot undo,
// because the cell then asserts the paper printed nothing there.
const EMPTY_CELL = /<(td|th)(?:[^>"']|"[^"]*"|'[^']*')*>\s*<\/\1\s*>/gi;

// Elements the HTML parser reads as TEXT to their close tag, so a `<` inside one opens nothing. A page
// transcribing a report about markup can put a tag's source inside `<textarea>` or `<script>` without
// escaping it, and rewriting that is the same fault as rewriting `<code>style="color:red"</code>` —
// the difference is only that the `<` is bare, so the tag walk below sees a tag where the browser sees
// a string.
//
// `src/pipeline/anchors.ts` keeps a WIDER set for the same shape of skip, and the two are deliberately
// not shared. Its question is whether a parser could attribute an `id` or a `for` to something in
// there, which is also true of `<template>` and `<select>`, whose interiors ARE parsed as markup. This
// one's question is whether a `style` attribute in there is an attribute at all — and inside a
// `<template>` or an `<option>` it is, so skipping those would leave the strip a hole. `noscript` is
// out for the same reason: with scripting off, which is how this HTML is read, its content is markup.
//
// `plaintext` never ends, which the scan below handles as "no close tag runs to the end of the page" —
// the parser's own rule.
const RAW_TEXT = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "plaintext",
]);

// The content spans of those elements, as [start, end) offsets — the opening tag itself is NOT in the
// range, because a `style` attribute ON a `<textarea>` is a real attribute and is this strip's to take.
// Not nesting-aware, matching the parser: raw text ends at the first close tag of that name.
function rawTextRanges(html: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  // `ANY_TAG` is a shared global regex, so its `lastIndex` is reset before the walk and moved forward
  // over each skipped region afterwards; a `<script>` inside a `<script>`'s text is not a tag either.
  ANY_TAG.lastIndex = 0;
  let tag: RegExpExecArray | null;
  while ((tag = ANY_TAG.exec(html)) !== null) {
    if (!RAW_TEXT.has(tag[1].toLowerCase())) continue;
    const start = tag.index + tag[0].length;
    const close = html.slice(start).search(new RegExp(`</${tag[1]}(?:\\s[^>]*)?>`, "i"));
    const end = close === -1 ? html.length : start + close;
    ranges.push([start, end]);
    ANY_TAG.lastIndex = end;
  }
  return ranges;
}

// Take `style` attributes out of markup a model wrote, and say what was in them.
//
// `agents/page.md` forbids these outright — a style attribute is not announced, does not survive being
// read aloud, and is dropped by anything that reformats the document — and #374 measured 52 of them
// shipped anyway. The strip loses nothing a reader was getting, which is the argument for doing it in
// code rather than asking again: whatever the declaration was carrying, it was already carrying it
// only to someone who could see it.
//
// `props` is the part that is not bookkeeping, and the reason this returns more than a count. 46 of
// those 52 are `padding-left`, 40 of them on one page's row headings, and that is a table's row groups
// written in ink instead of in markup — information the page HAS and the document now does not.
// Stripping the attribute does not lose that; it was never reaching a reader. But it does make the
// page look clean, so the properties are handed back and logged: a run whose log says `padding-left`
// names the pages whose hierarchy needs the <tbody>/scope="rowgroup" treatment the prompt asks for,
// and one whose log says `background-color` names a legend swatch that painted nothing. Rebuilding
// either is a re-ask against the image and not something this can do — the stated limit of the repair.
//
// `spans` is counted apart from `stripped` because it is a different edit: an element removed, not an
// attribute. Both are reported; a style attribute on a span this drops still counts in `stripped`.
//
// `cells_emptied` is the count that names the one place the residue is not neutral. A legend swatch
// written as `<td><span style="background:#ccc"></span></td>` leaves `<td></td>`, and this commit's own
// prompt clause calls an empty cell the encoding a reader cannot undo. The strip does not CREATE that —
// the cell held no text before it either, so a screen reader announced an empty cell both ways — but it
// removes the last trace that the page had a mark there, and a re-ask against the image is what would
// recover it. So the trace moves to the log, for the same reason `props` does.
export function stripStyleAttributes(html: string): {
  html: string;
  stripped: number;
  spans: number;
  cellsEmptied: number;
  props: string[];
} {
  let stripped = 0;
  let spans = 0;
  const props: string[] = [];
  const seen = new Set<string>();
  // One style attribute accounted for: counted, and its properties added to the set. The value arrives
  // as it was written, quotes and all, so the quotes come off before the declarations are read — with
  // them on, the first property is `"padding-left` and matches nothing.
  const note = (value: string | undefined): void => {
    stripped += 1;
    const body = (value ?? "").replace(/^\s*=\s*/, "").replace(/^["']|["']$/g, "");
    for (const [, prop] of body.matchAll(DECLARATION)) {
      const key = prop.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      props.push(key);
    }
  };
  // Both passes are offset-aware, and the ranges are recomputed between them because the first pass
  // moves everything after its first edit.
  let raw = rawTextRanges(html);
  const inRawText = (at: number): boolean => raw.some(([from, to]) => at >= from && at < to);
  // Repeated until it stops changing anything, because one pass cannot see a styled span whose only
  // content is another one: `replace` has advanced past the outer span's start by the time the inner is
  // removed, so the outer would reach only the attribute walk and survive as a bare `<span></span>` —
  // the residue this rule exists to prevent, with `spans` and `cells_emptied` both short by one on a
  // mark that is just as gone. Bounded by construction: a pass that changes anything has removed at
  // least a `<span></span>` pair, so the string strictly shortens.
  //
  // The nesting is not a shape anything has been seen to write — 0 of 69 styled spans over 1,741 of the
  // bench's kept HTML files, and #374's own 52 are flat swatches and row headings. So this is here
  // because a counter that names a lost mark should not go quiet on a shape it was not looking at,
  // rather than because the shape has been observed.
  let out = html;
  for (;;) {
    // The replacer's arguments are (match, …groups, offset, whole string); `EMPTY_STYLED_SPAN` has two
    // groups, the last style value and the gap, so the offset is the fourth.
    const pass = out.replace(EMPTY_STYLED_SPAN, (whole: string, _value: string, gap: string, at: number) => {
      if (inRawText(at)) return whole;
      spans += 1;
      for (const [, value] of whole.matchAll(STYLE_ATTR)) note(value);
      return gap;
    });
    if (pass === out) break;
    out = pass;
    // The offsets moved with the edit, so the skip regions are re-read before the next pass rather than
    // carried over — a stale range would let the strip into raw text or keep it out of real markup.
    raw = rawTextRanges(out);
  }
  raw = rawTextRanges(out);
  out = out.replace(ANY_TAG, (tag, name: string, attrs: string, at: number) => {
    if (inRawText(at)) return tag;
    if (!/\sstyle\s*=/i.test(attrs)) return tag;
    const kept: string[] = [];
    let found = false;
    for (const [, key, value] of attrs.matchAll(ATTR)) {
      if (key.toLowerCase() === "style") {
        found = true;
        note(value);
        continue;
      }
      kept.push(`${key}${value ?? ""}`);
    }
    if (!found) return tag;
    // Rebuilt rather than cut out, since the pairs were parsed rather than located: whitespace between
    // attributes is normalized to one space on a tag this touched, which is why the guard above returns
    // early on every tag that has no style attribute at all. A trailing slash is put back because
    // `ATTR` cannot match one — its name class excludes `/` — and a self-closing tag that loses it
    // still parses, but the markup a page wrote is not this function's to change.
    const slash = /\/\s*$/.test(attrs) ? " /" : "";
    return `<${name}${kept.length ? ` ${kept.join(" ")}` : ""}${slash}>`;
  });
  // Counted on the finished output against the input, rather than inside the span pass, so that any
  // route to an empty cell is counted and not only the one route in mind. The strip only ever removes,
  // so this cannot go negative.
  const cellsEmptied = (out.match(EMPTY_CELL) ?? []).length - (html.match(EMPTY_CELL) ?? []).length;
  // Sorted, and NOT in the order the properties were met. Empty styled spans are removed in a pass of
  // their own before the attributes are walked, so first-seen order is that pass and then the rest of
  // the document — an order that reads like document order and is not one. Sorting says what the list
  // actually is, a set of properties this page used, and makes two runs' lines comparable.
  return { html: out, stripped, spans, cellsEmptied, props: props.sort() };
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    const key = ref.toLowerCase();
    if (NAMED[key] !== undefined) return NAMED[key];
    // A malformed code point (`&#xZZ;`, or one past the Unicode range) throws in
    // String.fromCodePoint; leave it as written rather than failing the caller.
    try {
      if (key.startsWith("#x")) return String.fromCodePoint(parseInt(key.slice(2), 16));
      if (key.startsWith("#")) return String.fromCodePoint(parseInt(key.slice(1), 10));
    } catch {
      return whole;
    }
    return whole;
  });
}
