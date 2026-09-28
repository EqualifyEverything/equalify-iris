import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rasterizePdf, rasterizePageToFit } from "../src/util/pdf.ts";
import { imageDimensions } from "../src/util/imageSize.ts";

// A page Iris rendered too big to send (issue #485).
//
// Rasterizing happens at a fixed DPI, so a page image's pixel count follows the PHYSICAL
// page: a letter page lands at 1275x1650 and a 55-inch poster or fold-out at 8334x8334,
// past the one ceiling above which the vision model errors instead of downscaling. The
// upload route used to refuse the whole document for that, with advice — re-export the
// page smaller — that asks the caller to do by hand what the renderer can do exactly.
// They never chose those pixels; Iris did.
//
// These tests are about the renderer's half of the fix: that the page really does come
// out too large at the DPI, and that rendering it again produces a smaller image of the
// SAME page. Which size to ask for is the limits module's decision and is tested in
// test/image-limits.test.ts (`refitLongEdge`), because it turns on whether the model's
// long edge is a documented fact or Iris's guess.

// Built byte by byte, like test/pdf-links.test.ts's fixture and for the same reason: what
// is under test is what poppler does with a real file, and the property here is a page
// SIZE, which no mock of the subprocess could exercise.
//
// Two pages of deliberately different shapes — a letter page and a 4000x4000 pt square —
// so an assertion can tell which one came back. That is the whole risk in re-rendering
// one page of a document: `-f`/`-l` counting in the PDF's own numbering, not the array
// index the caller happens to hold.
function twoPagePdf(): Buffer {
  const ink = (y: number) => `BT /F1 24 Tf 72 ${y} Td (Iris) Tj ET`;
  const stream = (s: string) => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
  const objs: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> " +
      "/Contents 4 0 R >>",
    stream(ink(700)),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    // 4000 pt square: a 55-inch fold-out, which is a page size a drawing or a poster
    // really comes in.
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 4000 4000] /Resources << /Font << /F1 5 0 R >> >> " +
      "/Contents 7 0 R >>",
    stream(ink(3900)),
  ];
  let body = "%PDF-1.7\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const startxref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function hasPoppler(): boolean {
  try {
    execFileSync("pdftoppm", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const skip = hasPoppler() ? false : "poppler-utils not installed";

test("a large-format page renders past what can be sent, and says which page it is", { skip }, async () => {
  const pages = await rasterizePdf(twoPagePdf(), "foldout.pdf");
  assert.equal(pages.length, 2);
  // The ordinary page, for contrast: the size the blanket "a rasterized page is modest"
  // assumption was reasoning from, and it is fine.
  assert.deepEqual(imageDimensions(pages[0].buffer), { width: 1275, height: 1650 });
  // And the reason the document was refused. Not asserted to the pixel — the exact
  // rounding is poppler's — but it has to be square and well past the 8000 px ceiling.
  const big = imageDimensions(pages[1].buffer);
  assert.ok(big, "the rendered page's header did not parse");
  assert.ok(big.width > 8000 && big.height > 8000, `expected a page past 8000 px, got ${big.width}x${big.height}`);
  assert.equal(big.width, big.height);
  // The PDF's own page number travels with the image, which is what a second render has
  // to ask for. Without it the retry would name an index and render another page's ink.
  assert.deepEqual(
    pages.map((p) => p.page),
    [1, 2],
  );
});

test("the page that does not fit is rendered again, smaller, and it is the same page", { skip }, async () => {
  const pdf = twoPagePdf();
  // To the hard ceiling: what Iris gives up on a model it has no published limits for —
  // only the pixels it could not have sent at all.
  const toCeiling = imageDimensions(await rasterizePageToFit(pdf, 2, 8000));
  assert.deepEqual(toCeiling, { width: 8000, height: 8000 });
  // To the size a documented model reads. Square, so this is page 2: page 1 at the same
  // request is 1212x1568, and a render that quietly took the first page of the range
  // would show up here rather than in a delivered document.
  const toLongEdge = imageDimensions(await rasterizePageToFit(pdf, 2, 1568));
  assert.deepEqual(toLongEdge, { width: 1568, height: 1568 });
  // Which that page really is, and the aspect ratio held: the page is rendered smaller,
  // never cropped, so nothing that was on it is lost beyond resolution.
  assert.deepEqual(imageDimensions(await rasterizePageToFit(pdf, 1, 1568)), { width: 1212, height: 1568 });
});

test("asking for a page the document does not have fails rather than returning another", { skip }, async () => {
  // pdftoppm exits non-zero for a range past the end, and that has to stay an error: a
  // silent fallback to "the first image in the directory" is how a retry hands page 1's
  // ink back under page 9's name.
  await assert.rejects(() => rasterizePageToFit(twoPagePdf(), 9, 1568));
});
