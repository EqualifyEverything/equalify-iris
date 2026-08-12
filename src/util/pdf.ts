import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { decodeEntities } from "./html.ts";

const execFileP = promisify(execFile);

// Max pages we will rasterize from one PDF — bounds cost/time on a public deploy.
export const MAX_PDF_PAGES = 25;
const DPI = 150; // enough for the vision model to read text; keeps images modest

// One of a page's link annotations: where it points, and the text it sits on.
export interface PdfLink {
  text: string; // the anchor text, as extracted (approximate — see extractPdfLinks)
  href: string; // the annotation's URI, verbatim from the file
}

export interface PageImage {
  name: string;
  buffer: Buffer;
  // The page's link annotations. A rasterized page cannot carry them — a link is
  // a PDF annotation, not ink, so "click here" arrives at the vision model as
  // four pixels-worth of words with no target. Extracted separately and handed to
  // the page agent as ground truth (see pipeline/links.ts).
  links: PdfLink[];
}

// Thrown when a PDF exceeds the page cap, so the route can return a clean 400.
export class PdfTooLargeError extends Error {
  constructor(pages: number) {
    super(`This PDF has ${pages} pages; the maximum supported is ${MAX_PDF_PAGES}. Please split it.`);
  }
}

function pageNum(file: string): number {
  const m = file.match(/-(\d+)\.png$/);
  return m ? parseInt(m[1], 10) : 0;
}

// Schemes we will re-emit as an href. A PDF URI action is arbitrary text the file
// controls, and it ends up in a document we hand to a browser — `javascript:` and
// `data:` are script injection, and a bare `file:`/relative path points at the
// reader's own machine. Only the schemes a linked document legitimately uses get
// through; anything else is dropped rather than sanitized, since a link we cannot
// safely reproduce is not a link.
//
// Internal destinations (GoTo) are dropped by the same rule: poppler renders them
// as `<basename>.html#<page>`, which names a file that does not exist here. They
// are not lost content in the way an external URL is — the page they point at is in
// the same delivered document — and the page agent already builds real in-document
// links for the references it can see (footnotes, see anchors.ts).
const SAFE_SCHEME = /^(?:https?|mailto|tel|ftps?):/i;

// Bounds on what one page contributes to a prompt. A page of endnotes can carry a
// hundred links; past a few dozen the list stops being context and starts crowding
// out the page itself. Truncation is logged by the caller (pipeline/links.ts), never
// silent.
export const MAX_LINKS_PER_PAGE = 40;
const MAX_LINK_TEXT = 160;

// Join two runs of the same link's text. poppler emits one <text> element per line,
// so a link spanning a line break arrives in pieces: "Read the full " + "annual
// report here", or "our accessibility" + "policy" with no space anywhere. Gluing
// them raw runs the words together; always inserting a space breaks a hyphenated
// split ("accessi-" + "bility"). So a space goes in only where neither side already
// has one and the break is not hyphenated.
function joinRuns(prev: string, next: string): string {
  if (!prev) return next;
  // \u00ad is a soft hyphen — a hyphenated break the file marked as one.
  if (/[\s\u00ad-]$/.test(prev) || /^\s/.test(next)) return prev + next;
  return `${prev} ${next}`;
}

// Parse pdftohtml's XML into per-page link lists. Exported for the test: this is
// the whole of the format's contract, and it is cheaper (and more honest) to test
// against captured poppler output than to mock the subprocess.
//
// The parse is a scan rather than an XML parse because that is what the input
// affords: poppler prefixes stray document text to the stream (an outline title
// lands ahead of the first <page> element in real files), so the document is not
// reliably well-formed, and a parser that rejects it would lose every link over a
// stray character. A scan that tracks the last page marker it saw degrades to
// "some links, attributed correctly" instead.
export function parsePdfHtmlLinks(xml: string): Map<number, PdfLink[]> {
  const byPage = new Map<number, PdfLink[]>();
  // Page markers and anchors in one pass, so an anchor is always attributed to the
  // page marker that preceded it.
  const token = /<page\b[^>]*\bnumber="(\d+)"|<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let page = 0;
  for (const m of xml.matchAll(token)) {
    if (m[1] !== undefined) {
      page = parseInt(m[1], 10);
      continue;
    }
    // An anchor before the first <page> marker belongs to no page we can name.
    if (page < 1) continue;
    const href = decodeEntities(m[2]).trim();
    if (!SAFE_SCHEME.test(href)) continue;
    // Inner markup (<b>, <i>) is styling on the anchor text, not part of it.
    const text = decodeEntities(m[3].replace(/<[^>]*>/g, ""));
    const links = byPage.get(page) ?? [];
    // Same href continuing across lines: one link, not several.
    const last = links[links.length - 1];
    if (last && last.href === href) last.text = joinRuns(last.text, text);
    else links.push({ text, href });
    byPage.set(page, links);
  }
  // Tidy up the accumulated text once, at the end — collapsing whitespace earlier
  // would destroy the run boundaries joinRuns reads.
  for (const links of byPage.values()) {
    for (const l of links) {
      const clean = l.text.replace(/\s+/g, " ").trim();
      l.text = clean.length > MAX_LINK_TEXT ? `${clean.slice(0, MAX_LINK_TEXT)}…` : clean;
    }
  }
  return byPage;
}

// Read the link annotations out of a PDF, per page, using poppler's own renderer
// (pdftohtml -xml) so we inherit its mapping from annotation rectangles to the text
// underneath them. That mapping is the hard part, and the reason this shells out
// rather than reading the annotation dictionaries directly: /Annots gives a
// rectangle, and turning a rectangle back into "the words it covers" is the text
// layout problem poppler has already solved.
//
// The anchor text is therefore approximate: it comes from poppler's text layer, so
// it can be split across lines, clipped by a rectangle that does not quite cover the
// phrase, or differ in whitespace from what the image shows. The page agent is told
// as much — the URL is exact, the text is a hint for locating it.
//
// Best-effort by construction. A link is additive: if this returns nothing, the run
// produces exactly the document it produced before links were extracted at all.
// So every failure mode here (poppler missing, a malformed file, output past
// maxBuffer) resolves to "no links for that page" rather than a failed conversion.
// Links over an image with no text under them are lost the same way, since there is
// no anchor text for poppler to emit.
async function extractPdfLinks(pdfPath: string): Promise<Map<number, PdfLink[]>> {
  try {
    const { stdout } = await execFileP(
      "pdftohtml",
      ["-xml", "-stdout", "-i", "-q", "-f", "1", "-l", String(MAX_PDF_PAGES), pdfPath],
      // The default 1 MB would truncate a text-heavy document's XML mid-stream —
      // every page's text passes through here, not just its links.
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return parsePdfHtmlLinks(stdout);
  } catch {
    return new Map();
  }
}

// Rasterize a PDF into one PNG per page, in page order, each carrying the link
// annotations on that page. Requires poppler-utils (pdftoppm + pdfinfo +
// pdftohtml), which the Docker image installs.
export async function rasterizePdf(pdf: Buffer, originalName: string): Promise<PageImage[]> {
  const dir = mkdtempSync(join(tmpdir(), "iris-pdf-"));
  try {
    const pdfPath = join(dir, "in.pdf");
    writeFileSync(pdfPath, pdf);

    // Reject oversized PDFs up front for predictable cost.
    try {
      const { stdout } = await execFileP("pdfinfo", [pdfPath]);
      const m = stdout.match(/Pages:\s+(\d+)/);
      if (m && parseInt(m[1], 10) > MAX_PDF_PAGES) throw new PdfTooLargeError(parseInt(m[1], 10));
    } catch (e) {
      if (e instanceof PdfTooLargeError) throw e;
      // pdfinfo unavailable/failed — fall through; pdftoppm -l still caps pages.
    }

    const base = basename(originalName, ".pdf").replace(/[^A-Za-z0-9._-]/g, "_") || "page";
    await execFileP("pdftoppm", ["-png", "-r", String(DPI), "-l", String(MAX_PDF_PAGES), pdfPath, join(dir, "pg")]);
    const pngs = readdirSync(dir).filter((f) => f.endsWith(".png")).sort((a, b) => pageNum(a) - pageNum(b));
    if (pngs.length === 0) throw new Error("no pages produced — is this a valid PDF?");
    const links = await extractPdfLinks(pdfPath);
    // Keyed by the PDF's own page number (`pageNum(f)`), not the array index: a PDF
    // whose first rendered page is not page 1 would otherwise get another page's
    // links. pdftoppm and pdftohtml are both given the same 1..MAX_PDF_PAGES range,
    // so the numbering they report is the same numbering.
    return pngs.map((f, i) => ({
      name: `${base}-p${i + 1}.png`,
      buffer: readFileSync(join(dir, f)),
      links: links.get(pageNum(f)) ?? [],
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
