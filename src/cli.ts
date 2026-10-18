#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, extname, basename, join } from "node:path";
import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { loadConfig } from "./config.ts";
import { Store } from "./store/db.ts";
import { Paths } from "./store/paths.ts";
import { runPipeline } from "./pipeline/orchestrator.ts";
import {
  rasterizePdf,
  rasterizePageToFit,
  PdfTooLargeError,
  MAX_PDF_PAGES,
  type PageImage,
} from "./util/pdf.ts";
import { safeStem } from "./util/outputNames.ts";
import { imageDimensions } from "./util/imageSize.ts";
import {
  IMAGE_MEDIA_TYPES,
  imageRejection,
  rasterizedPageRejection,
  refitLongEdge,
  resolveImageLimits,
  shrunkPageRejection,
} from "./providers/imageLimits.ts";
import { taggedPdfCommand } from "./util/taggedPdf.ts";
import { keepPdfFields } from "./routes/sessions.ts";

function printHelp(): void {
  console.log(`
Equalify Iris CLI - Accessible Document Converter (WCAG 2.2 AA)

Usage:
  node src/cli.ts <input-file> [options]
  npm run convert -- <input-file> [options]

Arguments:
  <input-file>                Input PDF or image (.png, .jpg, .jpeg, .webp, .gif) file

Options:
  -i, --input <file>          Input file path (alternative to positional argument)
  -o, --output <file>         Output HTML file path (default: <input-stem>_converted.html)
  -c, --config <file>         Path to config.yaml (default: config.yaml)
  -h, --help                  Show this help documentation

Examples:
  npm run convert -- document.pdf
  npm run convert -- document.pdf -o output.html
  npm run convert -- page.png -o page.html
`);
}

async function main(): Promise<void> {
  if (existsSync(".env") && typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile();
    } catch {
      // Ignore .env loading failure
    }
  }

  const optionsConfig = {
    input: { type: "string" as const, short: "i" },
    output: { type: "string" as const, short: "o" },
    config: { type: "string" as const, short: "c" },
    help: { type: "boolean" as const, short: "h" },
  };

  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: optionsConfig,
    allowPositionals: true,
  });

  if (values.help) {
    printHelp();
    return;
  }

  const inputArg = values.input || positionals[0];
  if (!inputArg) {
    console.error("Error: No input file specified.\n");
    printHelp();
    process.exit(1);
  }

  const inputPath = resolve(inputArg);
  if (!existsSync(inputPath)) {
    console.error(`Error: Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const ext = extname(inputPath).toLowerCase();
  const isPdf = ext === ".pdf";
  const isImage = ext in IMAGE_MEDIA_TYPES;

  if (!isPdf && !isImage) {
    const allowed = [...Object.keys(IMAGE_MEDIA_TYPES).map((e) => e.slice(1).toUpperCase()), "PDF"].join(", ");
    console.error(`Error: Unsupported file type: ${ext} (allowed: ${allowed})`);
    process.exit(1);
  }

  const inputStem = basename(inputPath, ext);
  const outputPath = values.output
    ? resolve(values.output)
    : resolve(`${inputStem}_converted.html`);

  let cfg;
  try {
    cfg = loadConfig(values.config);
  } catch (err) {
    console.error(`Error loading configuration: ${(err as Error).message}`);
    process.exit(1);
  }

  mkdirSync(join(cfg.storage.data_dir, "sessions"), { recursive: true });
  mkdirSync(join(cfg.storage.data_dir, "tmp"), { recursive: true });

  const store = new Store(cfg.storage.database);
  const paths = new Paths(cfg);
  const imageLimits = resolveImageLimits(cfg);

  const pages: PageImage[] = [];
  const refits: { pdf: string; page: number; long_edge_px: number; from: string }[] = [];
  const inputBuffer = readFileSync(inputPath);

  if (isPdf) {
    let rendered: PageImage[];
    try {
      rendered = await rasterizePdf(inputBuffer, basename(inputPath));
    } catch (e) {
      if (e instanceof PdfTooLargeError) {
        console.error(`Error: ${e.message}`);
      } else {
        console.error(`Error rasterizing PDF: ${(e as Error).message}`);
      }
      process.exit(1);
    }

    if (rendered.length === 0) {
      console.error("Error: No pages found in the PDF.");
      process.exit(1);
    }
    if (rendered.length > MAX_PDF_PAGES) {
      console.error(`Error: Too many pages (${rendered.length}); the maximum is ${MAX_PDF_PAGES}.`);
      process.exit(1);
    }

    for (const [i, p] of rendered.entries()) {
      const page = p.page ?? i + 1;
      const size = imageDimensions(p.buffer);
      const why = rasterizedPageRejection(
        basename(inputPath),
        page,
        { bytes: p.buffer.length, width: size?.width, height: size?.height },
        imageLimits,
      );
      if (!why) continue;

      const target = refitLongEdge({ width: size?.width, height: size?.height }, imageLimits);
      if (target === null || !size || p.page === undefined) {
        console.error(`Error: Page ${page} of ${basename(inputPath)} exceeds model image limits: ${why}`);
        process.exit(1);
      }

      try {
        const smaller = await rasterizePageToFit(inputBuffer, p.page, target);
        const shrunk = imageDimensions(smaller);
        const still = shrunkPageRejection(
          basename(inputPath),
          page,
          target,
          { bytes: smaller.length, width: shrunk?.width, height: shrunk?.height },
          imageLimits,
        );
        if (still) {
          console.error(`Error: Page ${page} of ${basename(inputPath)} exceeds model image limits after resizing: ${still}`);
          process.exit(1);
        }
        refits.push({
          pdf: basename(inputPath),
          page,
          long_edge_px: target,
          from: `${size.width}x${size.height}`,
        });
        p.buffer = smaller;
      } catch (err) {
        console.error(`Error refitting page ${page}: ${(err as Error).message}`);
        process.exit(1);
      }
    }
    pages.push(...rendered);
  } else {
    const size = imageDimensions(inputBuffer);
    const why = imageRejection(
      {
        name: basename(inputPath),
        bytes: inputBuffer.length,
        width: size?.width,
        height: size?.height,
      },
      imageLimits,
    );
    if (why) {
      console.error(`Error: ${basename(inputPath)} exceeds model image limits: ${why}`);
      process.exit(1);
    }
    const pageName = safeStem(basename(inputPath), "page") + ext.toLowerCase();
    pages.push({
      name: pageName,
      buffer: inputBuffer,
      links: [],
    });
  }

  const sessionId = `ses_${ulid()}`;
  paths.initSession(sessionId);

  writeFileSync(paths.sessionSourceName(sessionId), inputStem);

  pages.forEach((p, i) => {
    const order = String(i + 1).padStart(4, "0");
    writeFileSync(join(paths.sessionInput(sessionId), `${order}__${p.name}`), p.buffer);
  });

  const linksByOrder: Record<string, unknown> = {};
  pages.forEach((p, i) => {
    if (p.links && p.links.length) linksByOrder[String(i + 1)] = p.links;
  });
  if (Object.keys(linksByOrder).length) {
    writeFileSync(paths.sessionLinks(sessionId), JSON.stringify(linksByOrder, null, 2));
  }

  if (isPdf && taggedPdfCommand(cfg)) {
    writeFileSync(paths.sessionSourcePdf(sessionId), inputBuffer);
    try {
      await keepPdfFields(taggedPdfCommand(cfg)!, paths, sessionId);
    } catch {
      // Best-effort form fields
    }
  }

  const sha256 = createHash("sha256").update(inputBuffer).digest("hex");
  const maxIter = cfg.defaults.max_review_iterations;

  store.createSession({
    session_id: sessionId,
    image_count: pages.length,
    iterations_max: maxIter,
    source_sha256: sha256,
  });

  console.log(`Converting ${basename(inputPath)} (${pages.length} page${pages.length === 1 ? "" : "s"})...`);

  try {
    await runPipeline({
      cfg,
      store,
      sessionId,
      maxReviewIterations: maxIter,
    });
  } catch (err) {
    console.error(`Pipeline error: ${(err as Error).message}`);
    process.exit(1);
  }

  const session = store.getSession(sessionId);
  if (!session || session.status === "failed") {
    console.error(`Conversion failed: ${session?.error || "Unknown error"}`);
    process.exit(1);
  }

  const generatedHtmlPath = paths.sessionOutput(sessionId);
  if (!existsSync(generatedHtmlPath)) {
    console.error(`Error: Expected output file not found at ${generatedHtmlPath}`);
    process.exit(1);
  }

  const htmlContent = readFileSync(generatedHtmlPath, "utf8");
  writeFileSync(outputPath, htmlContent, "utf8");
  console.log(`Converted output saved to: ${outputPath}`);
}

main().catch((err) => {
  console.error("CLI Execution failed:", err);
  process.exit(1);
});
