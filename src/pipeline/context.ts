import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { ProviderRouter, Image } from "../providers/index.ts";
import { IMAGE_MEDIA_TYPES } from "../providers/imageLimits.ts";
import type { Paths } from "../store/paths.ts";
import type { RunLog } from "../store/runlog.ts";
import type { IrisConfig } from "../config.ts";
import type { PdfLink } from "../util/pdf.ts";

export interface InputImage {
  name: string; // filename, e.g. page-001.png
  order: number; // 1-based processing order
  path: string;
  // The link annotations on this page, when it came from a PDF that had any —
  // targets the image itself cannot carry (see pipeline/links.ts). Optional because
  // most pages have none, and because callers that synthesize an InputImage from
  // something other than an upload (the regression gate's fixture images) have no
  // links to give it.
  links?: PdfLink[];
}

// Everything a pipeline phase needs. Created once per run.
export interface PipelineContext {
  sessionId: string;
  cfg: IrisConfig;
  paths: Paths;
  router: ProviderRouter;
  log: RunLog;
  images: InputImage[];
  feedback?: string; // present on feedback re-runs
  maxReviewIterations: number;
  // Pages extracted in parallel in this run. Always a valid integer >= 1
  // (normalized by loadConfig), so consumers need no fallback.
  extractionConcurrency: number;
  // Corrected pages this run re-verifies for measurement only (config
  // `defaults.recheck_sample_size`; pipeline/correction.ts `recheckSampler`). Always a
  // valid integer >= 0, where 0 means the measurement is off. Carried here rather than
  // read off `cfg` at the claim site for the same reason as the line above: one place
  // resolves it, and a phase cannot disagree with the number the run was started with.
  recheckSampleSize: number;
  // The logged-in user's GitHub token — used to file agent-suggestion issues
  // attributed to them (unless a service token override is configured).
  githubToken?: string;
}

// The extension -> media type map lives with the rest of the model's input limits
// (providers/imageLimits.ts), so the formats the upload route accepts and the media
// types sent to the model cannot disagree — this file used to claim image/tiff for a
// format the model does not read.
export function mediaTypeFor(filename: string): string {
  return IMAGE_MEDIA_TYPES[extname(filename).toLowerCase()] ?? "image/png";
}

export function loadImage(img: InputImage): Image {
  return { data: readFileSync(img.path), media_type: mediaTypeFor(img.name) };
}

// Feedback is injected as a top-level instruction available to every
// downstream agent in the run. It is phrased as a required change so that, on an
// iterative feedback re-run, the Reader surfaces it as an issue (sourced to the
// affected block) and the Copy Editor applies it — rather than the round no-opping
// when the document is otherwise accessibility-clean.
export function feedbackPreamble(ctx: PipelineContext): string {
  if (!ctx.feedback) return "";
  return (
    `\n\n## User feedback (top-level instruction — applies to this whole run)\n` +
    `${ctx.feedback}\n\n` +
    `Treat this feedback as a REQUIRED change. Wherever it applies, flag the affected ` +
    `block(s) by their @source reference and make the change in your output.\n`
  );
}
