import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";

const execFileP = promisify(execFile);

// Max pages we will rasterize from one PDF — bounds cost/time on a public deploy.
export const MAX_PDF_PAGES = 25;
const DPI = 150; // enough for the vision model to read text; keeps images modest

export interface PageImage {
  name: string;
  buffer: Buffer;
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

// Rasterize a PDF into one PNG per page, in page order. Requires poppler-utils
// (pdftoppm + pdfinfo), which the Docker image installs.
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
    return pngs.map((f, i) => ({ name: `${base}-p${i + 1}.png`, buffer: readFileSync(join(dir, f)) }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
