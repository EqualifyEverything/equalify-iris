import type { IrisConfig, ProviderBlock } from "../config.ts";
import { resolveAgentModel } from "./index.ts";

// What one uploaded image may be, for the vision model THIS deployment is running.
//
// Iris hands an uploaded image to the model byte for byte — nothing in the pipeline
// resizes or re-encodes it (see pipeline/context.ts `loadImage`) — so the model's
// own input limits are Iris's input limits, and they are what a user needs to know
// before choosing a file. Until this module existed they were documented nowhere and
// enforced nowhere: `POST /v1/sessions` accepted anything up to multer's 50 MB and a
// heavy photo then died two to four minutes later inside a model call, surfacing to
// the user as "Conversion failed: bedrock: no output arrived within 120s".
//
// Everything is collected HERE, in one place, because every number below is a fact
// about a model or a provider rather than about Iris — and this project switches
// models. Pointing `providers.<name>.per_capability.vision` at a different Claude
// generation moves the long-edge limit; pointing `providers.default` at a different
// provider moves the per-image byte cap. One table means the upload check, the 400 a
// caller gets, `GET /v1/limits`, the demo's hint and the API docs all move with it,
// instead of five hand-written sentences slowly becoming untrue about a model nobody
// is using any more.
//
// Sources (checked 2026-08-13):
//   https://platform.claude.com/docs/en/build-with-claude/vision  (Request limits,
//   Supported formats, Resolution and token cost)

// Per-image cap, in BASE64 characters — the unit the platform documents, and the one
// that binds: both adapters send images base64-encoded, which is 4 characters on the
// wire for every 3 bytes on disk.
const BASE64_CAP_BY_PROVIDER: Record<string, number> = {
  // Amazon Bedrock and Google Cloud allow half of what the Claude API does (5 MB vs
  // 10 MB per image).
  bedrock: 5 * 1024 * 1024,
  // OpenRouter is a broker: it forwards Claude traffic to upstreams it chooses,
  // Bedrock and Vertex among them, and does not tell us which one served a request.
  // So the stricter of the two documented caps is the only one that can be relied on
  // here — the Claude API's 10 MB would be a limit this deployment cannot promise.
  openrouter: 5 * 1024 * 1024,
};

// A provider with no row above. The stricter documented cap on purpose: being wrong
// in this direction costs a user one immediate "make it smaller" message, and being
// wrong in the other costs them a run that fails minutes later inside a model call
// with a message about streams and timeouts.
const DEFAULT_BASE64_CAP = 5 * 1024 * 1024;

// Long edge, in pixels, above which the model DOWNSCALES an image before looking at
// it — server-side, silently, preserving aspect ratio. Not an error, and deliberately
// not enforced. It is published because pixels above it buy nothing: a 6000 px scan
// is charged upload time, base64 overhead and (on the way to the byte cap) a failed
// run, for detail the model never sees.
//
// THESE TWO NUMBERS AND THE GENERATION BELOW ARE WHAT CHANGES WHEN THE MODEL DOES.
// High-resolution is Claude 4.7 and later; every earlier model is the standard tier.
const HIGH_RES_LONG_EDGE_PX = 2576;
const STANDARD_LONG_EDGE_PX = 1568;
const HIGH_RES_FROM_GENERATION = 4.7;

// Hard ceiling on either dimension, for every model. Above this the request is
// rejected outright rather than downscaled.
const MAX_DIMENSION_PX = 8000;

// Above this many image (or, on Bedrock/Vertex, document) blocks in ONE request, a
// stricter per-image dimension limit kicks in and oversized images are rejected with
// an `invalid_request_error` about "many-image requests". Iris crosses it: a 25-page
// PDF (util/pdf.ts MAX_PDF_PAGES) is 25 image blocks in the review phase's call. It
// stays safe only because those pages are rasterized at 150 DPI, which puts a letter
// page at 1275x1650 — under the 2000 px the docs prescribe for staying under the
// limit on all platforms. Recorded here rather than left implicit because it is the
// constraint that makes that DPI load-bearing rather than merely economical.
export const MANY_IMAGE_THRESHOLD = 20;
export const MANY_IMAGE_MAX_DIMENSION_PX = 2000;

// Every image format Claude vision accepts, mapped to the media type sent with it.
// This is the whole allowlist: an upload whose extension is not a key here cannot be
// converted, so `POST /v1/sessions` rejects it (routes/sessions.ts) rather than
// accepting a file the model will refuse.
//
// TIFF used to be on Iris's list — advertised in the demo, in the API docs and in the
// upload validator — and was never supported by the model. A .tif upload was accepted
// and then failed inside the first vision call, which is the same undiagnosable
// failure this module exists to remove. GIF is the reverse case: supported by the
// model and missing from Iris's list. Animations are not supported; only the first
// frame is read.
export const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// The agents that are handed a page image, and whose model therefore has to be able
// to accept it: the page agent (extraction), the Feedback Agent (fidelity verify),
// the Copy Editor (review, when the pages are attached) and the builder (drafting a
// suggested agent). The published limit is the STRICTEST across them, so a deployment
// that runs verification on a different model than extraction — which the config
// example recommends — gets a number that is true of every call an upload makes,
// not just the first.
//
// A specialist dispatched by the page agent is not in the list because the set is
// dynamic (any file in agents/). One with its own `per_agent` entry on a
// tighter-limited model would not be reflected here; that is the one direction this
// can be too generous, and it is a deliberate trade against enumerating a directory
// at upload time.
const IMAGE_AGENTS = ["page", "feedback", "copy_editor", "builder"] as const;

export interface ImageLimits {
  // The largest file, in bytes on disk, that may be uploaded as one page.
  max_image_bytes: number;
  // Where max_image_bytes came from: the provider's cap on base64-encoded image data.
  max_base64_bytes: number;
  // Above this, the model downscales rather than failing.
  max_long_edge_px: number;
  // Above this, the request is rejected.
  max_dimension_px: number;
  media_types: string[];
  extensions: string[];
}

// Raw bytes that fit inside a base64 cap. Base64 is 4 characters per 3 bytes, so a
// file on disk may be three quarters of the documented limit. Floored to a whole
// 3-byte group so the encoded form cannot land a character over.
export function rawBytesForBase64Cap(cap: number): number {
  return Math.floor(cap / 4) * 3;
}

// The Claude generation in a model id, or null for an id this cannot read.
//
// Both spellings, because the two providers version the same models differently:
// Bedrock hyphenates (`us.anthropic.claude-sonnet-4-6`) and OpenRouter uses dots
// (`anthropic/claude-opus-4.7`). A bare major version is a whole number
// (`claude-opus-5` -> 5).
//
// Returning null for anything unrecognized is the point of the signature: a mock
// model in a test, a fine-tune, or a naming scheme this file has not seen must fall
// to the standard tier — the SMALLER long edge — so the note stays true rather than
// promising resolution the model will silently throw away.
export function modelGeneration(model: string): number | null {
  const m = model.match(/claude-[a-z]+-(\d+)(?:[.-](\d+))?/i);
  if (!m) return null;
  const generation = Number(`${m[1]}.${m[2] ?? 0}`);
  return Number.isFinite(generation) ? generation : null;
}

// The long edge one model reads before downscaling.
export function longEdgeFor(model: string): number {
  const generation = modelGeneration(model);
  return generation !== null && generation >= HIGH_RES_FROM_GENERATION
    ? HIGH_RES_LONG_EDGE_PX
    : STANDARD_LONG_EDGE_PX;
}

// Coerce a configured `image_limits` number: absent, unparseable or nonsensical
// falls back to what the table says. Same trap as config.ts's other normalizers —
// YAML parses a valueless `max_image_bytes:` as null and Number(null) is 0, which
// here would reject every upload ever made with "the maximum is 0 bytes".
function normalizeOverride(value: unknown, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

// What this deployment accepts for one page image, resolved from the model and
// provider actually configured for the agents that see uploads.
//
// An operator can override either number per provider block
// (`providers.<name>.image_limits`), which is the escape hatch for the case this
// file cannot know about: a model released after it was written, or a partner
// platform with its own cap. The override is read from the block of the provider that
// serves the STRICTEST agent, for the same reason the limits are.
export function resolveImageLimits(cfg: IrisConfig): ImageLimits {
  let base64Cap = Infinity;
  let longEdge = Infinity;
  let strictestBlock: ProviderBlock | undefined;

  for (const agent of IMAGE_AGENTS) {
    // A per_agent entry naming a provider with no config block is a startup error
    // (config.ts validateConfig), but this must not be the thing that throws while
    // answering an upload — skip what cannot be resolved and let the run report it.
    let resolved: { provider: string; model: string };
    try {
      resolved = resolveAgentModel(cfg.providers, agent, "vision");
    } catch {
      continue;
    }
    const block = cfg.providers[resolved.provider] as ProviderBlock | undefined;
    const cap = BASE64_CAP_BY_PROVIDER[resolved.provider] ?? DEFAULT_BASE64_CAP;
    const edge = longEdgeFor(resolved.model);
    if (cap < base64Cap) {
      base64Cap = cap;
      strictestBlock = block;
    }
    if (edge < longEdge) longEdge = edge;
  }

  // Nothing resolved at all (a config with no reachable provider). Fall back to the
  // conservative defaults rather than publishing Infinity.
  if (!Number.isFinite(base64Cap)) base64Cap = DEFAULT_BASE64_CAP;
  if (!Number.isFinite(longEdge)) longEdge = STANDARD_LONG_EDGE_PX;

  const override = strictestBlock?.image_limits;
  const maxBase64 = normalizeOverride(override?.max_base64_bytes, base64Cap);
  return {
    max_image_bytes: normalizeOverride(override?.max_image_bytes, rawBytesForBase64Cap(maxBase64)),
    max_base64_bytes: maxBase64,
    max_long_edge_px: normalizeOverride(override?.max_long_edge_px, longEdge),
    max_dimension_px: MAX_DIMENSION_PX,
    media_types: [...new Set(Object.values(IMAGE_MEDIA_TYPES))],
    extensions: Object.keys(IMAGE_MEDIA_TYPES),
  };
}

// Sizes as a person reads them, for messages and for the published limits. One
// decimal place and no trailing ".0": "3.7 MB", "512 KB".
//
// Floored, not rounded, because the number this mostly renders is a LIMIT. Bedrock's
// cap is 3,932,160 bytes, which is 3.75 MB: rounded, that publishes "3.8 MB", and a
// user who trusts it and sends a 3.78 MB file is rejected by the very sentence that
// invited the upload. Understating a limit by a tenth of a megabyte costs nothing;
// overstating one contradicts the check.
export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${Math.floor(mb * 10) / 10} MB`;
  return `${Math.floor(bytes / 1024)} KB`;
}

// The one sentence that says what to do about the limits, written once so the demo
// page, the API docs and the 400 a caller gets cannot word it differently.
//
// It leads with the byte cap because that is the rule an upload is actually rejected
// by, and follows with the long edge because that is the reason a big image can be
// shrunk at no cost — a user told only "too large" reasonably fears losing detail the
// conversion needs, and the answer is that the model was going to discard those
// pixels anyway.
export function imageLimitsHint(limits: ImageLimits): string {
  return (
    `Each image must be under ${formatBytes(limits.max_image_bytes)} and in one of ` +
    `${limits.media_types.map((t) => t.replace("image/", "").toUpperCase()).join(", ")} format. ` +
    `The vision model reads at most ${limits.max_long_edge_px} px on the long edge and downscales ` +
    `anything larger, so re-saving a big photo or scan at ${limits.max_long_edge_px} px — or as a ` +
    `JPEG — loses nothing the conversion would have used.`
  );
}

// Why one uploaded file cannot be converted, or null if it can. A single function so
// the check and its explanation stay together: the route below it decides the status
// code, not the wording.
export function imageRejection(
  file: { name: string; bytes: number },
  limits: ImageLimits,
): string | null {
  if (file.bytes <= limits.max_image_bytes) return null;
  return (
    `${file.name} is ${formatBytes(file.bytes)}, over the ${formatBytes(limits.max_image_bytes)} ` +
    `limit for one image. ${imageLimitsHint(limits)}`
  );
}
