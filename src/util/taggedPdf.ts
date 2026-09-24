// The optional tagged-PDF output: the uploaded PDF, tagged from Iris's HTML and with any
// form values filled in. The `iris-pdf` command from equalify-iris-pdf makes it
// (https://github.com/EqualifyEverything/equalify-iris-pdf). Iris has no PDF library of
// its own. It runs the command the way it runs poppler, and a deployment without the
// command works exactly as before.
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { IrisConfig } from "../config.ts";

const execFileP = promisify(execFile);

export const DEFAULT_TAG_TIMEOUT_SECONDS = 300;
// Room for a 25-page document's PDF.
const MAX_BUFFER = 64 * 1024 * 1024;

// The first line `iris-pdf fields --help` prints, per command, or null when it did not run.
// Probed once per process: config does not change without a restart.
const probed = new Map<string, string | null>();

function probe(command: string): string | null {
  if (!probed.has(command)) {
    const r = spawnSync(command, ["fields", "--help"], { encoding: "utf8", timeout: 30_000 });
    const first = (r.stdout ?? "").split("\n")[0].trim();
    probed.set(command, r.status === 0 && first.startsWith("iris-pdf ") ? first : null);
  }
  return probed.get(command)!;
}

// The command to run, or null when the feature is off: `tagged_pdf.command` is blank, or
// it is set and does not run.
export function taggedPdfCommand(cfg: IrisConfig): string | null {
  const command = cfg.tagged_pdf?.command?.trim();
  return command && probe(command) ? command : null;
}

// For the startup log: what is on, or why it is off.
export function taggedPdfStatus(cfg: IrisConfig): string | null {
  const command = cfg.tagged_pdf?.command?.trim();
  if (!command) return null;
  const version = probe(command);
  return version
    ? `Tagged PDFs on (${version}).`
    : `WARNING: tagged_pdf.command is "${command}", but "${command} fields --help" did not run. Tagged PDFs are off.`;
}

export function tagTimeoutSeconds(cfg: IrisConfig): number {
  const t = Number(cfg.tagged_pdf?.timeout_seconds);
  return Number.isFinite(t) && t > 0 ? t : DEFAULT_TAG_TIMEOUT_SECONDS;
}

// One form field, as `iris-pdf fields --json` prints it. Passed through unchanged.
export type PdfField = {
  name: string;
  type: string;
  page: number;
  options: string[];
  required: boolean;
  readonly: boolean;
  maxlen: number | null;
  editable: boolean;
  multiSelect: boolean;
};

// The command refused or failed. `code` is its own (`iris-pdf: <code>: <message>` on
// stderr), or `timeout`, or `tagger_failed` when it printed no such line.
export class TaggedPdfError extends Error {
  code: string;
  exit: number | null;
  constructor(code: string, message: string, exit: number | null) {
    super(message);
    this.code = code;
    this.exit = exit;
  }
}

function failure(e: unknown): TaggedPdfError {
  const err = e as { code?: unknown; killed?: boolean; stderr?: string; message?: string };
  if (err.killed) return new TaggedPdfError("timeout", "Tagging the PDF took too long.", null);
  const exit = typeof err.code === "number" ? err.code : null;
  const line = (err.stderr ?? "").split("\n").find((l) => l.startsWith("iris-pdf: "));
  const m = line?.match(/^iris-pdf: ([a-z_]+): (.*)$/);
  if (m) return new TaggedPdfError(m[1], m[2], exit);
  return new TaggedPdfError("tagger_failed", "iris-pdf failed without saying why.", exit);
}

export async function readFields(command: string, pdfPath: string): Promise<PdfField[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileP(command, ["fields", "--pdf", pdfPath, "--json"], { maxBuffer: MAX_BUFFER, timeout: 60_000 }));
  } catch (e) {
    throw failure(e);
  }
  try {
    return JSON.parse(stdout) as PdfField[];
  } catch {
    throw new TaggedPdfError("tagger_failed", "iris-pdf printed fields that are not JSON.", 0);
  }
}

export type TagInput = { lang?: string; title?: string; pages: { sourcePage: number; html: string }[] };

// Tag `pdfPath`. The values are personal data. They go to the child in a file only it and
// this process can read, in a scratch directory deleted before this returns. Iris keeps
// neither them nor the tagged PDF.
export async function tagPdf(
  command: string,
  args: { pdfPath: string; input: TagInput; values: Record<string, unknown>; scratchRoot: string; timeoutSeconds: number },
): Promise<{ pdf: Buffer; report: unknown }> {
  mkdirSync(args.scratchRoot, { recursive: true });
  const dir = mkdtempSync(join(args.scratchRoot, "pdf-"));
  const f = (name: string) => join(dir, name);
  try {
    writeFileSync(f("pages.json"), JSON.stringify(args.input));
    writeFileSync(f("values.json"), JSON.stringify(args.values), { mode: 0o600 });
    const argv = ["tag", "--pdf", args.pdfPath, "--pages", f("pages.json"), "--values", f("values.json"), "--out", f("out.pdf"), "--report", f("report.json")];
    try {
      await execFileP(command, argv, { maxBuffer: MAX_BUFFER, timeout: args.timeoutSeconds * 1000 });
    } catch (e) {
      throw failure(e);
    }
    return { pdf: readFileSync(f("out.pdf")), report: JSON.parse(readFileSync(f("report.json"), "utf8")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
