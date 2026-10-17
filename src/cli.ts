#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, extname, basename, dirname, join } from "node:path";
import { rasterizePdf } from "./util/pdf.ts";
import { OllamaProvider } from "./providers/ollama.ts";
import { GeminiProvider } from "./providers/gemini.ts";
import { wrapDocument } from "./pipeline/assembly.ts";
import { enrichMathNavigation } from "./pipeline/mathNav.ts";

function printHelp(): void {
  console.log(`
Equalify Iris CLI - Accessible Document & Math Converter (WCAG 2.2 AA)

Usage:
  node src/cli.ts <input-file> [options]
  npm run convert -- <input-file> [options]

Arguments:
  <input-file>                Input PDF, image (.png, .jpg, .webp), or HTML file

Options:
  -i, --input <file>          Input file path (alternative to positional argument)
  -o, --output <file>         Output HTML file path (default: <input-basename>.html)
  -p, --provider <name>       AI Provider: 'auto' (Gemini with Ollama fallback, default),
                              'gemini', or 'ollama'
  -m, --model <name>          Vision model name (default: 'gemini-2.5-flash' or 'minicpm-v')
  --api-key <key>             Google API key (or set GOOGLE_API_KEY / GEMINI_API_KEY)
  --ollama-url <url>          Local Ollama base URL (default: http://localhost:11434/v1)
  -h, --help                  Show this help documentation

Examples:
  # Convert a PDF with Gemini and automatic Ollama fallback:
  node src/cli.ts document.pdf -o accessible.html

  # Force offline conversion with local Ollama:
  node src/cli.ts document.pdf -o accessible.html -p ollama

  # Direct HTML MathML navigation enrichment:
  node src/cli.ts raw_math.html -o navigable_math.html
`);
}

async function main(): Promise<void> {
  const optionsConfig = {
    input: { type: "string" as const, short: "i" },
    output: { type: "string" as const, short: "o" },
    provider: { type: "string" as const, short: "p", default: "auto" },
    model: { type: "string" as const, short: "m" },
    "api-key": { type: "string" as const },
    "ollama-url": { type: "string" as const, default: "http://localhost:11434/v1" },
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
  const inputStem = basename(inputPath, ext);
  const outputPath = values.output
    ? resolve(values.output)
    : join(dirname(inputPath), `${inputStem}_accessible.html`);

  // Direct HTML enrichment (no model call required)
  if (ext === ".html" || ext === ".htm") {
    console.log(`Processing HTML file with accessible MathML navigation: ${inputPath}`);
    const raw = readFileSync(inputPath, "utf8");
    const enriched = enrichMathNavigation(raw);
    writeFileSync(outputPath, enriched, "utf8");
    console.log(`Successfully generated accessible HTML: ${outputPath} (${enriched.length} bytes)`);
    return;
  }

  // Resolve API Key
  const apiKey =
    values["api-key"] ||
    process.env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY ||
    "";

  const providerArg = (values.provider || "auto").toLowerCase();
  const ollamaUrl = values["ollama-url"] || "http://localhost:11434/v1";

  // Setup Primary and Fallback providers
  let geminiProvider: GeminiProvider | null = null;
  let ollamaProvider: OllamaProvider | null = null;

  try {
    geminiProvider = new GeminiProvider({
      api_key: apiKey,
      default_model: values.model || "gemini-2.5-flash",
      max_tokens: 8192,
    });
  } catch {
    // Gemini key missing or invalid
  }

  try {
    ollamaProvider = new OllamaProvider({
      default_model: values.model || "minicpm-v",
      base_url: ollamaUrl,
      max_tokens: 8192,
    });
  } catch {
    // Ollama not reachable
  }

  console.log(`=== Equalify Iris Document Conversion ===`);
  console.log(`Input:       ${inputPath}`);
  console.log(`Output:      ${outputPath}`);
  console.log(`Mode:        ${providerArg}`);
  console.log(`Gemini:      ${geminiProvider ? "Enabled (gemini-2.5-flash)" : "Disabled"}`);
  console.log(`Ollama:      ${ollamaProvider ? `Enabled (${ollamaUrl})` : "Disabled"}`);

  // Dispatch vision call with automated failover
  async function completeVision(imgData: Buffer, promptText: string): Promise<string> {
    if (providerArg === "ollama") {
      if (!ollamaProvider) throw new Error("Local Ollama provider is not configured.");
      const res = await ollamaProvider.complete({
        capability: "vision",
        model: values.model || "minicpm-v",
        images: [{ media_type: "image/png", data: imgData }],
        messages: [{ role: "user", content: promptText }],
      });
      return res.text;
    }

    if (providerArg === "gemini") {
      if (!geminiProvider) throw new Error("Gemini provider is not configured (missing API key).");
      const res = await geminiProvider.complete({
        capability: "vision",
        model: values.model || "gemini-2.5-flash",
        images: [{ media_type: "image/png", data: imgData }],
        messages: [{ role: "user", content: promptText }],
      });
      return res.text;
    }

    // Auto Mode: Try Gemini first, fallback to Ollama on quota or network error
    if (geminiProvider) {
      try {
        const res = await geminiProvider.complete({
          capability: "vision",
          model: values.model || "gemini-2.5-flash",
          images: [{ media_type: "image/png", data: imgData }],
          messages: [{ role: "user", content: promptText }],
        });
        return res.text;
      } catch (geminiErr) {
        console.warn(`[Auto-Failover] Gemini request failed: ${(geminiErr as Error).message}`);
        if (ollamaProvider) {
          console.log(`[Auto-Failover] Falling back to local Ollama (minicpm-v)...`);
          const fallbackRes = await ollamaProvider.complete({
            capability: "vision",
            model: "minicpm-v",
            images: [{ media_type: "image/png", data: imgData }],
            messages: [{ role: "user", content: promptText }],
          });
          return fallbackRes.text;
        }
        throw geminiErr;
      }
    }

    if (ollamaProvider) {
      const res = await ollamaProvider.complete({
        capability: "vision",
        model: values.model || "minicpm-v",
        images: [{ media_type: "image/png", data: imgData }],
        messages: [{ role: "user", content: promptText }],
      });
      return res.text;
    }

    throw new Error("No usable model provider found. Please supply a Gemini API key or start local Ollama.");
  }

  const pagePrompt = `You are Equalify Iris Page Agent. Convert this document page into a clean, accessible HTML fragment meeting WCAG 2.2 AA.
Rule 15: MATH EQUATIONS AND FORMULAS. Transcribe all mathematical formulas as semantic HTML5 MathML (<math display="block"> for standalone equations, <math display="inline"> for inline formulas). Never emit raw LaTeX or ASCII approximations.
Output ONLY the semantic HTML body content (headings, paragraphs, lists, math) with no <html>, <head>, or <body> tags.`;

  const fragments: string[] = [];

  if (ext === ".pdf") {
    console.log(`Rasterizing PDF pages...`);
    const pdfBuffer = readFileSync(inputPath);
    const pages = await rasterizePdf(pdfBuffer, basename(inputPath));
    console.log(`Rasterized ${pages.length} pages.`);

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i]!;
      console.log(`Extracting page ${i + 1}/${pages.length}...`);
      try {
        const text = await completeVision(page.buffer, pagePrompt);
        console.log(`Page ${i + 1} transcribed (${text.length} chars).`);
        const cleanText = text.replace(/^```html\s*/i, "").replace(/```\s*$/i, "").trim();
        fragments.push(cleanText);
      } catch (err) {
        console.error(`Error transcribing page ${i + 1}:`, err);
        fragments.push(`<!-- @page-failed ${i + 1} -->`);
      }
    }
  } else if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
    console.log(`Extracting single image page...`);
    const imageBuffer = readFileSync(inputPath);
    const text = await completeVision(imageBuffer, pagePrompt);
    const cleanText = text.replace(/^```html\s*/i, "").replace(/```\s*$/i, "").trim();
    fragments.push(cleanText);
  } else {
    console.error(`Error: Unsupported file format: ${ext}`);
    process.exit(1);
  }

  console.log(`Assembling document and enriching accessible math navigation...`);
  const joinedBody = fragments.join("\n\n<hr role=\"doc-pagebreak\">\n\n");
  const finalHtml = wrapDocument(joinedBody);

  writeFileSync(outputPath, finalHtml, "utf8");
  console.log(`\nConversion complete!`);
  console.log(`Saved accessible document: ${outputPath} (${finalHtml.length} bytes)`);
}

main().catch((err) => {
  console.error("CLI Execution failed:", err);
  process.exit(1);
});
