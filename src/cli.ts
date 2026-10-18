#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, extname, basename, join } from "node:path";
import { loadConfig } from "./config.ts";
import { Store } from "./store/db.ts";
import { Paths } from "./store/paths.ts";
import { runPipeline } from "./pipeline/orchestrator.ts";
import { PdfTooLargeError } from "./util/pdf.ts";
import { resolveImageLimits } from "./providers/imageLimits.ts";
import { renderUploads, stageSession, UploadRejectedError, uploadRejection, unsupportedType } from "./pipeline/stage.ts";

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

  const unsupported = unsupportedType(basename(inputPath));
  if (unsupported) {
    console.error(`Error: ${unsupported}`);
    process.exit(1);
  }

  const ext = extname(inputPath).toLowerCase();
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
  const files = [{ originalname: basename(inputPath), buffer: readFileSync(inputPath) }];

  // The same checks, rendering and staging as an upload to the server (pipeline/stage.ts).
  const rejected = uploadRejection(files, imageLimits);
  if (rejected) {
    console.error(`Error: ${rejected}`);
    process.exit(1);
  }
  let rendered: Awaited<ReturnType<typeof renderUploads>>;
  try {
    rendered = await renderUploads(files, imageLimits);
  } catch (e) {
    const known = e instanceof UploadRejectedError || e instanceof PdfTooLargeError;
    console.error(known ? `Error: ${(e as Error).message}` : `Error: Could not process a PDF: ${(e as Error).message}`);
    process.exit(1);
  }
  const { session_id: sessionId, image_count: pageCount } = await stageSession(cfg, store, paths, files, rendered.pages, rendered.refits);
  const maxIter = cfg.defaults.max_review_iterations;

  console.log(`Converting ${basename(inputPath)} (${pageCount} page${pageCount === 1 ? "" : "s"})...`);

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
