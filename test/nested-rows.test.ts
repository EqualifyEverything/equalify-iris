// A `<tr>` opened directly inside another `<tr>` (#639). The second closes the first, which leaves an
// empty row: invisible in a browser, a table row with no cells in a tagged PDF.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runExtraction } from "../src/pipeline/extraction.ts";
import { closeNestedRows } from "../src/util/html.ts";
import { ev, makeCtx, withTemp } from "./extraction-seams.ts";

test("a row opened inside another row loses the stray opening tag, and is counted", () => {
  // The shape #639 found, in "Table 4. Newborn Oral Cavity Findings".
  const got = closeNestedRows(`<tr><th scope="row">Bohn nodules</th><td>12</td></tr>\n<tr><tr><th scope="row">Epstein pearls</th><td>40</td></tr>`);
  assert.equal(got.html, `<tr><th scope="row">Bohn nodules</th><td>12</td></tr>\n<tr><th scope="row">Epstein pearls</th><td>40</td></tr>`);
  assert.equal(got.dropped, 1);
  // The space between the two tags stays, and the tag name is read in any case.
  assert.deepEqual(closeNestedRows(`<TR class="a">\n  <TR><td>x</td></TR>`), { html: `\n  <TR><td>x</td></TR>`, dropped: 1 });
  assert.deepEqual(closeNestedRows(`<tr><tr><tr><td>x</td></tr>`), { html: `<tr><td>x</td></tr>`, dropped: 2 });
  // A rowspan of 1 covers nothing below, and a rowspan two rows up is not the row just before.
  assert.equal(closeNestedRows(`<tr><td rowspan="1">a</td></tr><tr><tr><td>b</td></tr>`).dropped, 1);
  assert.equal(closeNestedRows(`<tr><td rowspan="2">a</td></tr><tr><td>b</td></tr><tr><tr><td>c</td></tr>`).dropped, 1);
});

test("what the nested-row repair must not touch", () => {
  for (const html of [
    // A row with cells, even empty ones, and an empty row: `<tr></tr>` under a rowspan is valid.
    `<tr><td></td></tr><tr></tr><tr><td>x</td></tr>`,
    // A table inside a cell: a `<td>` stands between the two rows.
    `<tr><td><table><tr><td>x</td></tr></table></td></tr>`,
    // A stray row with an id: dropping it would remove a link target.
    `<tr id="row-3"><tr><td>x</td></tr>`,
    // Inside an element whose content is text, a tag is not a tag.
    `<pre></pre><textarea><tr><tr></textarea><script>"<tr><tr>"</script>`,
    // A comment between them is not "directly inside".
    `<tr><!-- note --><tr><td>x</td></tr>`,
    // Right after a row with a rowspan, the empty row may be the covered one: dropping it would
    // shift every later cell up a row.
    `<tr><th rowspan="2">Group</th><td>a</td></tr><tr><tr><td>b</td></tr>`,
    `<tr><td ROWSPAN=3>x</td></tr>\n<tr><tr><td>y</td></tr>`,
  ]) assert.deepEqual(closeNestedRows(html), { html, dropped: 0 }, html);
});

test("the page step repairs it and says so, and a clean page says nothing", async () => {
  await withTemp("iris-rows-", async (dir) => {
    const render = `<table><caption>Table 4.</caption><tr><th scope="row">Bohn nodules</th><td>12</td></tr><tr><tr><th scope="row">Epstein pearls</th><td>40</td></tr></table>` + `<p>${"content ".repeat(20)}</p>`;
    const { ctx, rec } = makeCtx(dir, { render });
    const { fragments } = await runExtraction(ctx);
    assert.ok(!/<tr>\s*<tr/i.test(fragments[0].innerHtml), fragments[0].innerHtml);
    assert.match(fragments[0].innerHtml, /<\/tr><tr><th scope="row">Epstein pearls<\/th>/);
    assert.deepEqual(ev(rec, "page_nested_rows").map((e) => e.data), [{ image: "page-001.png", page: 1, where: "extract", dropped: 1 }]);
  });
  await withTemp("iris-rows-", async (dir) => {
    const { ctx, rec } = makeCtx(dir, { render: `<table><caption>T</caption><tr><td>x</td></tr></table><p>${"content ".repeat(20)}</p>` });
    await runExtraction(ctx);
    assert.deepEqual(ev(rec, "page_nested_rows"), []);
  });
});
