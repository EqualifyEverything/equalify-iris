import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { ProviderRouter, Image } from "../providers/index.ts";
import type { Paths } from "../store/paths.ts";
import type { RunLog } from "../store/runlog.ts";
import type { IrisConfig } from "../config.ts";

export interface InputImage {
  name: string; // filename, e.g. page-001.png
  order: number; // 1-based processing order
  path: string;
}

// Everything a pipeline phase needs. Created once per run.
export interface PipelineContext {
  sessionId: string;
  cfg: IrisConfig;
  paths: Paths;
  router: ProviderRouter;
  log: RunLog;
  images: InputImage[];
  feedback?: string; // present on feedback re-runs (PRD §7.12)
  maxReviewIterations: number;
  // The logged-in user's GitHub token — used to file agent-suggestion issues
  // attributed to them (unless a service token override is configured).
  githubToken?: string;
}

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
};

export function mediaTypeFor(filename: string): string {
  return MEDIA_TYPES[extname(filename).toLowerCase()] ?? "image/png";
}

export function loadImage(img: InputImage): Image {
  return { data: readFileSync(img.path), media_type: mediaTypeFor(img.name) };
}

// PRD §7.12: feedback is injected as a top-level instruction available to every
// downstream agent in the run.
export function feedbackPreamble(ctx: PipelineContext): string {
  if (!ctx.feedback) return "";
  return `\n\n## User feedback (top-level instruction — applies to this whole run)\n${ctx.feedback}\n`;
}
