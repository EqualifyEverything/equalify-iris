import { test } from "node:test";
import assert from "node:assert/strict";
import { runExtraction } from "../src/pipeline/extraction.ts";
import { stripStyleAttributes, tightenDigitGroups } from "../src/util/html.ts";
import { ev, makeCtx, ORDINARY, withTemp } from "./extraction-seams.ts";

// U+00A0, written as an escape for the reason `soft-hyphens.test.ts` writes U+00AD as one.
const NBSP = "\u00a0";

// #374 item 7: two repairs to markup a page agent wrote, on the same terms as #334's soft-hyphen
// strip — decidable on the reply alone, with no image, no second model and no page-specific
// knowledge, and with no output where the thing being removed is the right answer.
//
// The measurements behind them, on one 91-page arm of #374's census:
//
//   * 549 thousands separators split by the printer's alignment space (`4, 271`) on 6 pages from
//     `claude-sonnet-4-6`, 166 from `kimi-k2.5`, none from `gpt-5.6-luna`. 546 of the 549 sit in a
//     table cell whose whole content is a figure. `p028` and `p029` are the SAME table transcribed
//     twice, 174 groups spaced on one page and 39 tight on the other, which is what says this is a
//     per-cell coin flip rather than a considered house style.
//   * 52 `style` attributes, 46 of them `padding-left` and 40 of those on one page's row headings
//     (`p089`), plus an empty `<span>` given a coloured background as a legend swatch.
//
// What each repair CANNOT do is the part these tests pin hardest. Closing the digit gap must not
// touch prose, because the same pattern loose in a sentence turns `In 1954, 105 cases` into
// `In 1954,105 cases`; and stripping a style attribute does not rebuild what the declaration was
// carrying, which is why the properties are reported rather than silently dropped.

// --- The digit-group repair ------------------------------------------------------------------

test("a thousands separator split by the printer's space closes up, inside a numeric cell", () => {
  for (const [before, after, n] of [
    // The shape the census found, in a `<td>` and in a `<th>`, since a stub can hold a figure too.
    [`<td>4, 271</td>`, `<td>4,271</td>`, 1],
    [`<th>4, 271</th>`, `<th>4,271</th>`, 1],
    // Every group in the cell, counted per group: a figure can be split twice.
    [`<td>1, 234, 567</td>`, `<td>1,234,567</td>`, 2],
    // What a column of money and percentages prints around its figures. The bracketing characters
    // are why the cell test allows them: without them the cell is not recognised as a figure and its
    // gap survives.
    [`<td>$4, 271</td>`, `<td>$4,271</td>`, 1],
    [`<td>(1, 234)</td>`, `<td>(1,234)</td>`, 1],
    [`<td>-1, 234</td>`, `<td>-1,234</td>`, 1],
    [`<td>85, 000%</td>`, `<td>85,000%</td>`, 1],
    // A decimal point in the same cell is not in the way.
    [`<td>4, 271.50</td>`, `<td>4,271.50</td>`, 1],
    // Attributes are kept exactly, quoted `>` included — the cell is rewritten, not re-emitted from
    // parts. An `align` attribute is presentational and forbidden elsewhere; it is not this repair's
    // to remove, and a repair that quietly took a second thing with it would be unattributable.
    [`<td align="right" data-x="a>b">4, 271</td>`, `<td align="right" data-x="a>b">4,271</td>`, 1],
    // The non-breaking spellings of the space, for the reason `stripSoftHyphens` covers its entity
    // forms: they render identically and defeat find-in-page identically. The raw character is
    // written as `NBSP` and never as itself: an expectation whose only difference from the plain-space
    // case above is invisible is one the next reader cannot check.
    [`<td>4,${NBSP}271</td>`, `<td>4,271</td>`, 1],
    [`<td>4,&nbsp;271</td>`, `<td>4,271</td>`, 1],
    [`<td>4,&#160;271</td>`, `<td>4,271</td>`, 1],
    [`<td>4,&#xA0;271</td>`, `<td>4,271</td>`, 1],
    // More than one space, and a newline, which is what a wrapped reply looks like.
    [`<td>4,   271</td>`, `<td>4,271</td>`, 1],
    [`<td>4,\n271</td>`, `<td>4,271</td>`, 1],
    // Two cells in one row are two separate scopes.
    [`<tr><td>4, 271</td><td>9, 100</td></tr>`, `<tr><td>4,271</td><td>9,100</td></tr>`, 2],
  ] as [string, string, number][]) {
    assert.deepEqual(tightenDigitGroups(before), { html: after, tightened: n }, before);
  }
});

test("what the digit-group repair must not touch", () => {
  for (const one of [
    // THE case this is scoped for. A sentence's comma is followed by a space and three digits as
    // often as a figure's is, and the global version of this pattern rewrites the sentence: `In
    // 1954, 105 cases were filed` becomes `In 1954,105 cases were filed`, which is a number the page
    // does not print and a date that has lost its year. The `(?!\d)` guard does not save it — `105`
    // is three digits — so the guard that matters is the enclosing cell holding nothing but a figure.
    `<p>In 1954, 105 cases were filed</p>`,
    `In 1954, 105 cases were filed`,
    // The same sentence inside a cell: still prose, still untouched, because the cell's content is
    // not a figure.
    `<td>In 1954, 105 cases were filed</td>`,
    `<td>Table 5, 100 counties reporting</td>`,
    // A list of years in a numeric cell — four digits after the comma, so no group matches. This is
    // what the `(?!\d)` lookahead is for, and it is the case a `\d{3}` pattern without it corrupts.
    `<td>1954, 1955</td>`,
    `<td>1954, 1955, 1956</td>`,
    // A list of short numbers: three digits are required, and these are one.
    `<td>1, 2, 3</td>`,
    `<td>1, 22</td>`,
    // A cell carrying a tag is out of scope entirely, which is the stated limit: on the census that
    // is 3 of 549 groups, all of them cells with a footnote marker beside the figure. They stay as
    // written rather than being handled by a second, looser pattern nothing has measured.
    `<td>4, 271<sup>1</sup></td>`,
    `<td><span>4, 271</span></td>`,
    // Not inside a cell at all.
    `<caption>4, 271</caption>`,
    `<li>4, 271</li>`,
    // A `<td>` closed by `</th>` is not a cell this recognises: the closing tag is matched against
    // the name that opened it, so a page with broken markup is left for the lint to report rather
    // than half-repaired here.
    `<td>4, 271</th>`,
    // Nothing to do: already tight, or no separator at all.
    `<td>4,271</td>`,
    `<td>4271</td>`,
    `<td>4.271</td>`,
    `<td></td>`,
    `<td>   </td>`,
  ]) {
    assert.deepEqual(tightenDigitGroups(one), { html: one, tightened: 0 }, one);
  }
});

// --- The style strip ------------------------------------------------------------------------

test("a style attribute comes out, and its properties are reported", () => {
  // `p089`'s shape: forty row headings whose rank is in the indentation. The strip loses nothing a
  // reader was getting — a style attribute is not announced — but `padding-left` in the log is what
  // says this page's row groups were in ink, and that rebuilding them is a re-ask against the image.
  assert.deepEqual(stripStyleAttributes(`<th style="padding-left:2em" scope="row">Ohio</th>`), {
    html: `<th scope="row">Ohio</th>`,
    stripped: 1,
    spans: 0,
    props: ["padding-left"],
  });
  // Several declarations in one attribute, and a value with a colon in it, which must not be read as
  // a second property. `props` is a sorted set and not a reading order: the empty-span pass runs
  // before the attribute walk, so first-seen order would look like document order without being it.
  assert.deepEqual(
    stripStyleAttributes(`<td style="padding-left:2em;background:url(http://x/y.png)">1</td>`),
    { html: `<td>1</td>`, stripped: 1, spans: 0, props: ["background", "padding-left"] },
  );
  // Every quoting a model writes one in, including unquoted (legal for a value with no space) and a
  // shouted attribute name.
  for (const one of [
    `<td style="color:red">1</td>`,
    `<td style='color:red'>1</td>`,
    `<td style=color:red>1</td>`,
    `<td STYLE="color:red">1</td>`,
    `<td style = "color:red">1</td>`,
  ]) {
    assert.deepEqual(stripStyleAttributes(one), { html: `<td>1</td>`, stripped: 1, spans: 0, props: ["color"] }, one);
  }
  // Two on one page: counted twice, properties deduped, so the list says what the page was doing
  // rather than how many times it did it.
  assert.deepEqual(
    stripStyleAttributes(`<th style="padding-left:2em">A</th><th style="padding-left:4em">B</th>`),
    { html: `<th>A</th><th>B</th>`, stripped: 2, spans: 0, props: ["padding-left"] },
  );
});

test("a span this strip empties goes with it, and one it did not empty stays", () => {
  // The legend swatch: an empty `<span>` with a coloured background, which paints nothing for a
  // reader who cannot see it and announces nothing either. Removing the attribute and leaving
  // `<span></span>` behind would swap one defect for a different one.
  assert.deepEqual(stripStyleAttributes(`<p><span style="background:#ccc"></span> under 5%</p>`), {
    html: `<p> under 5%</p>`,
    stripped: 1,
    spans: 1,
    props: ["background"],
  });
  // Scoped to the residue THIS strip creates, which is the whole of the rule. An empty span the model
  // wrote empty is not this repair's business.
  assert.deepEqual(stripStyleAttributes(`<p><span></span>x</p>`), {
    html: `<p><span></span>x</p>`,
    stripped: 0,
    spans: 0,
    props: [],
  });
  // A span with another attribute is still a span someone put there on purpose: the style goes, the
  // element stays, and whether a bare `class` should go too is a different question from this one.
  assert.deepEqual(stripStyleAttributes(`<span class="swatch" style="background:#ccc"></span>`), {
    html: `<span class="swatch"></span>`,
    stripped: 1,
    spans: 0,
    props: ["background"],
  });
  // A span with content is not empty, whatever the strip took off it.
  assert.deepEqual(stripStyleAttributes(`<span style="font-weight:bold">Southeast</span>`), {
    html: `<span>Southeast</span>`,
    stripped: 1,
    spans: 0,
    props: ["font-weight"],
  });
  // A styled span emptied but for whitespace counts as emptied: the space is layout, not content.
  assert.deepEqual(stripStyleAttributes(`<span style="background:#ccc"> </span>`), {
    html: ``,
    stripped: 1,
    spans: 1,
    props: ["background"],
  });
});

test("what the style strip must not touch", () => {
  for (const one of [
    // The text `style="…"` where the page PRINTS it — a report on markup, a code sample. Rewriting
    // that is the same fault as repairing a misspelling: it is what the page says.
    `<p>write <code>style="color:red"</code> in the tag</p>`,
    `<p>&lt;td style="color:red"&gt;</p>`,
    // The same text inside an attribute VALUE, which is why the attribute region is walked pair by
    // pair instead of searched: a pattern that scans the whole tag for a style attribute finds this
    // one and cuts a hole in the alt.
    `<img alt='the style="color:red" attribute' src="a.png">`,
    // A `<style>` element is a different thing from a style attribute and is not this function's:
    // `flatten.ts`'s SILENT set is what keeps its content out of the text.
    `<style>td { color: red }</style>`,
    // An attribute whose NAME merely ends in style.
    `<td data-style="x">1</td>`,
    // Nothing to strip.
    `<td class="num">1</td>`,
    `plain text`,
  ]) {
    assert.deepEqual(stripStyleAttributes(one), { html: one, stripped: 0, spans: 0, props: [] }, one);
  }
});

test("a tag the style strip rewrites keeps everything else it carried", () => {
  // Rebuilt from its parsed attributes, so this asserts what survives that: the other attributes,
  // their quoting, a quoted `>` inside a value, and a self-closing slash `ATTR` cannot match.
  assert.deepEqual(
    stripStyleAttributes(`<img src="a.png" alt="a > b" style="border:0" loading=lazy />`).html,
    `<img src="a.png" alt="a > b" loading=lazy />`,
  );
  // A boolean attribute has no value at all and must not acquire one.
  assert.deepEqual(stripStyleAttributes(`<input disabled style="color:red">`).html, `<input disabled>`);
  // The whitespace between attributes is normalized on a tag this touched — stated here rather than
  // in a comment alone, because it is the visible cost of parsing pairs instead of cutting a
  // substring out, and a tag with no style attribute is returned byte-for-byte by the guard above.
  assert.deepEqual(stripStyleAttributes(`<td   class="a"    style="color:red">1</td>`).html, `<td class="a">1</td>`);
});

// --- The seams ------------------------------------------------------------------------------
//
// Both repairs run at all four calls that turn a reply into markup Iris keeps, for the reason the
// soft-hyphen strip does: a page's own output is an INPUT further along. `soft-hyphens.test.ts` makes
// that argument at length and covers each seam one at a time; these tests cover the two new repairs
// on the seams and the fields their events carry.

test("the first render's styling and split figures never reach the fragment", async () => {
  await withTemp("iris-marks-", async (dir) => {
    const render =
      `<table><caption>Table 8.</caption>` +
      `<tr><th style="padding-left:2em" scope="row">Ohio</th><td>4, 271</td></tr>` +
      `<tr><th scope="row">Iowa</th><td>1, 234, 567</td></tr>` +
      `</table><p><span style="background:#ccc"></span> under 5% ${"content ".repeat(20)}</p>`;
    const { ctx, rec } = makeCtx(dir, { render });
    const { fragments } = await runExtraction(ctx);

    assert.equal(
      fragments[0].innerHtml,
      `<table><caption>Table 8.</caption>` +
        `<tr><th scope="row">Ohio</th><td>4,271</td></tr>` +
        `<tr><th scope="row">Iowa</th><td>1,234,567</td></tr>` +
        `</table><p> under 5% ${"content ".repeat(20)}</p>`,
    );
    assert.deepEqual(ev(rec, "page_style_attributes").map((e) => e.data), [
      { image: "page-001.png", page: 1, where: "extract", stripped: 2, spans: 1, props: ["background", "padding-left"] },
    ]);
    assert.deepEqual(ev(rec, "page_digit_groups").map((e) => e.data), [
      { image: "page-001.png", page: 1, where: "extract", tightened: 3 },
    ]);
  });
});

test("a page with neither says nothing about either", async () => {
  await withTemp("iris-marks-", async (dir) => {
    const { ctx, rec } = makeCtx(dir, { render: ORDINARY });
    const { fragments } = await runExtraction(ctx);
    assert.equal(fragments[0].innerHtml, ORDINARY);
    // So a run with no line of either kind is a run in which no reply carried one, rather than a run
    // where the count happened to be written as zero.
    assert.deepEqual(ev(rec, "page_style_attributes"), []);
    assert.deepEqual(ev(rec, "page_digit_groups"), []);
  });
});

test("the correction pass and both specialist seams are repaired too", async () => {
  await withTemp("iris-marks-", async (dir) => {
    const { ctx, rec } = makeCtx(dir, {
      render: ORDINARY,
      problems: ["The table on this page lost its six aggregate rows."],
      // A correction pass that re-typed the page it was given and split a figure on the way past.
      correction: `${ORDINARY}<table><tr><td style="text-align:right">4, 271</td></tr></table>`,
      specialist: {
        fragment: `<table><tr><td>9, 100</td></tr></table>`,
        merged: `${ORDINARY}<table><tr><td style="color:red">9, 100</td></tr></table>`,
      },
    });
    const { fragments } = await runExtraction(ctx);

    // The page that ships is the correction's, which replaced the merged one — so the fragment is
    // where the LAST seam is observable and the events are where the other three are. Both repairs
    // reached it: the figure the correction split is closed and its style attribute is gone.
    assert.equal(
      fragments[0].innerHtml,
      `${ORDINARY}<table><tr><td>4,271</td></tr></table>`,
      "the correction's own reply is repaired before it is adopted",
    );
    assert.deepEqual(
      ev(rec, "page_digit_groups").map((e) => [e.data.where, e.data.tightened]),
      [["specialist", 1], ["specialist_merge", 1], ["correct", 1]],
      "the digit repair fires at each seam that carried one, correction last",
    );
    assert.deepEqual(
      ev(rec, "page_style_attributes").map((e) => [e.data.where, e.data.props]),
      [["specialist_merge", ["color"]], ["correct", ["text-align"]]],
      "and the style strip too, on the two replies that carried an attribute",
    );
  });
});
