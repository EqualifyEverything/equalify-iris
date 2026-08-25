import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir, availableParallelism } from "node:os";
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

// Characters that make a URL unsafe to reproduce regardless of its scheme, because
// they end the attribute it is written into. An allowlisted scheme is not enough on
// its own: poppler escapes a quote inside a URI action as `&quot;` (verified against
// poppler 26.04.0), decodeEntities faithfully restores it, and the page agent is
// told to copy the URL EXACTLY — so `https://ok.example/a" onmouseover="alert(1)`
// would arrive whole in a document served as text/html. Nothing downstream sanitizes
// agent output; wrapDocument concatenates it verbatim.
//
// None of these can appear unencoded in a legitimate URL — a real URL percent-encodes
// them — so dropping is not a loss of anything valid, and it holds whether or not a
// given poppler build escapes them and whether or not the model obeys "exactly".
// Control characters are in the set for the same reason: a newline inside an
// attribute value is another way out of it.
const UNSAFE_CHARS = /["'<>`\s\u0000-\u001f\u007f]/;

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
    // Decoded before both checks, not after: an href is only safe if what finally
    // reaches the document is safe, and `&quot;`/`&#34;` are the same character to a
    // browser as a raw quote. Checking the still-encoded form would pass a payload
    // that decodeEntities then unwraps.
    const href = decodeEntities(m[2]).trim();
    if (!SAFE_SCHEME.test(href) || UNSAFE_CHARS.test(href)) continue;
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

// How many pdftoppm processes one rasterization is split across.
//
// pdftoppm renders pages one after another in a single thread, so a 25-page document
// is 25 page renders on one core while the rest of the machine idles. That is the
// whole of `rasterizePdf`, and it is time an uploader spends waiting: the route
// rasterizes before it answers, so nothing else in the run has started yet. Measured
// on a 25-page text document at 150 DPI, `rasterizePdf` took 12.5 s; splitting the
// page range across four processes on four cores takes 3.9 s, and the PNGs are
// byte-identical either way — a page render reads only that page.
//
// Bounded by the CPU count because the work is CPU-bound and local — this is not the
// question `defaults.extraction_concurrency` answers, which is how many MODEL calls a
// run may have in flight, and borrowing that knob would tie a provider's rate limit to
// this machine's core count.
//
// Over-subscription is deliberately not guarded against. `availableParallelism` reports
// cores, not a container's CPU quota, and two runs may rasterize at once
// (`defaults.max_concurrent_runs`), so more shards than usable cores is a normal case.
// It degrades gracefully rather than badly: eight pdftoppm shards on four cores
// measured 3.6 s against 3.8 s for four — the scheduler time-slices them and it is the
// same work either way. A shard holds one page's raster (~6 MB at this DPI), so the
// memory this costs is bounded by the shard count too.
export function rasterShards(pages: number, cpus: number = availableParallelism()): number {
  return Math.max(1, Math.min(Math.floor(cpus) || 1, pages));
}

// The `-f`/`-l` page ranges those shards cover: contiguous, in order, and together
// exactly 1..pages with no page in two of them.
//
// Every range must be inside the document. pdftoppm exits non-zero on a `-f` past the
// last page ("the first page can not be after the last page"), so a shard count that
// outran a short document would turn a working conversion into a failed one — which is
// why `rasterShards` never returns more shards than there are pages, and why this is
// derived from the page count rather than from a fixed chunk size.
export function pageRanges(pages: number, shards: number): [number, number][] {
  const per = Math.ceil(pages / shards);
  const ranges: [number, number][] = [];
  for (let first = 1; first <= pages; first += per) {
    ranges.push([first, Math.min(first + per - 1, pages)]);
  }
  return ranges;
}

// Render pages 1..`pages` into `dir` as `pg-NN.png`, across `rasterShards` processes.
//
// `pages` null means pdfinfo could not say how long the document is, and then this is
// the single capped call it always was: a range needs a last page to stay inside, and
// guessing one is how a shard lands past the end.
//
// allSettled rather than all, so cleanup cannot race a process that is still writing.
// The caller deletes the temp directory in a `finally`, and a rejection from `all`
// arrives while the other shards are mid-render — deleting the directory under them
// leaves a live poppler writing files nothing will remove. Waiting for every shard
// costs a failed conversion the tail of one page render, and the error re-thrown is
// still the first one, so what the caller sees is unchanged.
async function rasterizePages(pdfPath: string, dir: string, pages: number | null): Promise<void> {
  const out = join(dir, "pg");
  const opts = ["-png", "-r", String(DPI)];
  if (pages === null) {
    await execFileP("pdftoppm", [...opts, "-l", String(MAX_PDF_PAGES), pdfPath, out]);
    return;
  }
  const ranges = pageRanges(pages, rasterShards(pages));
  const settled = await Promise.allSettled(
    ranges.map(([first, last]) =>
      execFileP("pdftoppm", [...opts, "-f", String(first), "-l", String(last), pdfPath, out]),
    ),
  );
  const failed = settled.find((s) => s.status === "rejected");
  if (failed) throw (failed as PromiseRejectedResult).reason;
}

// How many pages this PDF has, or null if pdfinfo could not say.
//
// Throws PdfTooLargeError for a document over the cap, which is the reason this ran
// first before it was also the shard count: rejecting up front keeps cost predictable.
// Everything else — pdfinfo missing, a malformed report, no `Pages:` line — is null
// rather than a failure, and the caller falls back to the capped single-process render
// that never needed a page count.
async function pdfPageCount(pdfPath: string): Promise<number | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileP("pdfinfo", [pdfPath]));
  } catch {
    return null; // pdfinfo unavailable/failed — pdftoppm -l still caps pages.
  }
  const m = stdout.match(/Pages:\s+(\d+)/);
  if (!m) return null;
  const pages = parseInt(m[1], 10);
  if (pages > MAX_PDF_PAGES) throw new PdfTooLargeError(pages);
  return pages > 0 ? pages : null;
}

// Rasterize a PDF into one PNG per page, in page order, each carrying the link
// annotations on that page. Requires poppler-utils (pdftoppm + pdfinfo +
// pdftohtml), which the Docker image installs.
export async function rasterizePdf(pdf: Buffer, originalName: string): Promise<PageImage[]> {
  const dir = mkdtempSync(join(tmpdir(), "iris-pdf-"));
  try {
    const pdfPath = join(dir, "in.pdf");
    writeFileSync(pdfPath, pdf);

    // Reject oversized PDFs up front for predictable cost — and, when it answers, tell
    // the render below how many pages there are to divide between processes.
    const pages = await pdfPageCount(pdfPath);

    const base = basename(originalName, ".pdf").replace(/[^A-Za-z0-9._-]/g, "_") || "page";
    await rasterizePages(pdfPath, dir, pages);
    const pngs = readdirSync(dir).filter((f) => f.endsWith(".png")).sort((a, b) => pageNum(a) - pageNum(b));
    if (pngs.length === 0) throw new Error("no pages produced — is this a valid PDF?");
    const links = await extractPdfLinks(pdfPath);
    // Keyed by the PDF's own page number (`pageNum(f)`), not the array index: a PDF
    // whose first rendered page is not page 1 would otherwise get another page's
    // links. Both tools number by the PDF's own pages and neither is given a range
    // that starts past page 1, so the numbering they report is the same numbering —
    // and pdftoppm's shards divide that range without renaming anything, since the
    // digit width poppler pads to comes from the document's length, not the shard's.
    return pngs.map((f, i) => ({
      name: `${base}-p${i + 1}.png`,
      buffer: readFileSync(join(dir, f)),
      links: links.get(pageNum(f)) ?? [],
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
