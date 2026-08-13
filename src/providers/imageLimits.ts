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
const HIGH_RES_FROM_GENERATION = { major: 4, minor: 7 };

// Hard ceiling on either dimension, for every model. Above this the request is
// rejected outright rather than downscaled — which is why, unlike the long edge
// above, this one IS enforced at upload (see `imageRejection`).
const MAX_DIMENSION_PX = 8000;

// Above this many image (or, on Bedrock/Vertex, document) blocks in ONE request, a
// stricter per-image dimension limit kicks in and oversized images are rejected with
// an `invalid_request_error` about "many-image requests". Iris crosses it: a 25-page
// PDF (util/pdf.ts MAX_PDF_PAGES) is 25 image blocks in the review phase's call. It
// stays safe only because those pages are rasterized at 150 DPI, which puts a letter
// page at 1275x1650 — under the 2000 px the docs prescribe for staying under the
// limit on all platforms. Recorded here rather than left implicit because it is the
// constraint that makes that DPI load-bearing rather than merely economical.
//
// NEITHER NUMBER IS ENFORCED, and the pair of assumptions above is the whole control:
// 150 DPI, on a page no larger than letter or A4. A 21-page TABLOID PDF breaks it —
// 1650x2550 per page, over 2000 and under the 8000 that is enforced — and fails inside
// the model with an `invalid_request_error` rather than here. Not enforced at upload
// because it would be the wrong trade: the rule applies per REQUEST, only the review
// phase's unattributed path attaches every page to one call, and most such documents
// convert without ever making that call. Refusing them all at upload would reject
// documents that work today to pre-empt a failure some of them would never reach. The
// fix, when it is worth doing, is on the rasterizing side — render large pages down
// rather than refuse them.
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
// (`anthropic/claude-opus-4.7`). A bare major version has an implied minor of 0
// (`claude-opus-5` -> 5.0).
//
// A PAIR rather than a decimal, because minor versions are counters and not
// fractions: `Number("4.10")` is 4.1, which sorts below 4.7, so a `claude-*-4-10`
// would be read as older than the model before it and dropped to the standard tier.
// Nothing named that exists yet, which is exactly why the comparison should be right
// before one does.
//
// Returning null for anything unrecognized is the point of the signature: a mock
// model in a test, a fine-tune, or a naming scheme this file has not seen must fall
// to the standard tier — the SMALLER long edge — so the note stays true rather than
// promising resolution the model will silently throw away.
export interface ModelGeneration {
  major: number;
  minor: number;
}

export function modelGeneration(model: string): ModelGeneration | null {
  const m = model.match(/claude-[a-z]+-(\d+)(?:[.-](\d+))?/i);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = m[2] === undefined ? 0 : Number(m[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return { major, minor };
}

// The long edge one model reads before downscaling.
export function longEdgeFor(model: string): number {
  const g = modelGeneration(model);
  if (g === null) return STANDARD_LONG_EDGE_PX;
  const highRes =
    g.major !== HIGH_RES_FROM_GENERATION.major
      ? g.major > HIGH_RES_FROM_GENERATION.major
      : g.minor >= HIGH_RES_FROM_GENERATION.minor;
  return highRes ? HIGH_RES_LONG_EDGE_PX : STANDARD_LONG_EDGE_PX;
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
// platform with its own cap.
//
// Each axis is resolved on each provider's OWN block before the strictest is taken,
// rather than reading the overrides off whichever block won on size. Two reasons, and
// both were live bugs when this took the shortcut. A deployment whose providers share
// a cap — which the table's two do today — has a tie, so "the strictest block" was
// always just the first agent's, and an override on the other provider was silently
// dropped: the route kept publishing 3.75 MB while a call on the tighter provider
// failed mid-run, which is the exact failure this module exists to prevent, walked
// back in through its own escape hatch. And the axes can disagree about who is
// strictest — a mixed deployment can have the tighter byte cap on one provider and
// the smaller long edge on the other — so one winning block cannot carry both.
export function resolveImageLimits(cfg: IrisConfig): ImageLimits {
  let base64Cap = Infinity;
  let rawCap = Infinity;
  let longEdge = Infinity;

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
    const override = (cfg.providers[resolved.provider] as ProviderBlock | undefined)?.image_limits;
    const cap = normalizeOverride(
      override?.max_base64_bytes,
      BASE64_CAP_BY_PROVIDER[resolved.provider] ?? DEFAULT_BASE64_CAP,
    );
    // Derived from THIS provider's cap, so an override of one number still moves the
    // other: raising the base64 cap for a platform that allows 10 MB raises the file
    // size that follows from it, without the operator restating the arithmetic.
    const raw = normalizeOverride(override?.max_image_bytes, rawBytesForBase64Cap(cap));
    const edge = normalizeOverride(override?.max_long_edge_px, longEdgeFor(resolved.model));
    if (cap < base64Cap) base64Cap = cap;
    if (raw < rawCap) rawCap = raw;
    if (edge < longEdge) longEdge = edge;
  }

  // Nothing resolved at all (a config with no reachable provider). Fall back to the
  // conservative defaults rather than publishing Infinity.
  if (!Number.isFinite(base64Cap)) base64Cap = DEFAULT_BASE64_CAP;
  if (!Number.isFinite(rawCap)) rawCap = rawBytesForBase64Cap(base64Cap);
  if (!Number.isFinite(longEdge)) longEdge = STANDARD_LONG_EDGE_PX;

  return {
    max_image_bytes: rawCap,
    max_base64_bytes: base64Cap,
    max_long_edge_px: longEdge,
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

// One image, as much of it as a check can know: its name for the message, its weight,
// and its pixel size when that could be read from the header (util/imageSize.ts) —
// absent for a format the reader does not recognize, which must never be the reason a
// file is refused.
export interface CandidateImage {
  name: string;
  bytes: number;
  width?: number;
  height?: number;
}

// Whether an image breaks the ONE dimension rule that is a rule: over this the model
// returns an error instead of downscaling. Shared by both rejections below so the
// uploaded and the rasterized case cannot enforce different ceilings.
function overDimension(image: { width?: number; height?: number }): boolean {
  return (
    (image.width !== undefined && image.width > MAX_DIMENSION_PX) ||
    (image.height !== undefined && image.height > MAX_DIMENSION_PX)
  );
}

// Why one uploaded file cannot be converted, or null if it can. A single function so
// the check and its explanation stay together: the route below it decides the status
// code, not the wording.
//
// Size first, then dimensions, because weight is what nearly every rejected upload
// will have failed on and a message should lead with the likely cause.
export function imageRejection(image: CandidateImage, limits: ImageLimits): string | null {
  if (image.bytes > limits.max_image_bytes) {
    return (
      `${image.name} is ${formatBytes(image.bytes)}, over the ${formatBytes(limits.max_image_bytes)} ` +
      `limit for one image. ${imageLimitsHint(limits)}`
    );
  }
  if (overDimension(image)) {
    return (
      `${image.name} is ${image.width}x${image.height} px, over the ` +
      `${limits.max_dimension_px} px limit on a side — the vision model refuses an image that ` +
      `large outright rather than shrinking it. ${imageLimitsHint(limits)}`
    );
  }
  return null;
}

// The same two limits, for a page Iris rasterized out of a PDF rather than one the
// caller uploaded.
//
// A separate message because the caller cannot act on the one above: they did not
// choose these pixels, Iris did, at the DPI util/pdf.ts renders with. The exemption
// this replaces assumed the DPI alone kept a page image modest, which is only true of
// the page sizes a document normally comes in.
export function rasterizedPageRejection(
  pdfName: string,
  pageNumber: number,
  page: { bytes: number; width?: number; height?: number },
  limits: ImageLimits,
): string | null {
  const where = `Page ${pageNumber} of ${pdfName}`;
  const rendered = page.width ? ` (${page.width}x${page.height} px)` : "";
  if (page.bytes > limits.max_image_bytes) {
    return (
      `${where} renders to ${formatBytes(page.bytes)}${rendered}, over the ` +
      `${formatBytes(limits.max_image_bytes)} limit for one page image. ${weightAdvice(page)}`
    );
  }
  if (overDimension(page)) {
    return (
      `${where} renders to ${page.width}x${page.height} px, over the ${limits.max_dimension_px} px ` +
      `limit on a side. ${LARGE_FORMAT_ADVICE}`
    );
  }
  return null;
}

// The long edge, in pixels, past which a rasterized page is bigger than the paper a
// document normally comes on. Letter at util/pdf.ts's 150 DPI is 1650 px and A4 is
// 1755; tabloid is 2550, and a drawing or a fold-out is larger still. Used only to
// decide which explanation to give, never to reject anything.
const NORMAL_PAGE_MAX_PX = 2000;

const LARGE_FORMAT_ADVICE =
  `Iris rasterizes every page at a fixed resolution, so the page image scales with the physical ` +
  `page: a page much larger than letter or A4 — a drawing, a poster, a fold-out — renders past ` +
  `what the vision model accepts. Export or split those pages at a smaller page size, or upload ` +
  `them as images you have resized.`;

// Two different documents reach the byte limit, and the remedy differs, so the message
// has to name the right one. A large-format page is over because of its SIZE. A
// letter-size page is over because of its CONTENT: pages are rendered as lossless
// 24-bit PNG, and a photographic or halftoned scan at 2.1 megapixels compresses badly
// enough to pass 3.7 MB. Telling the owner of a scanned magazine to "split the
// fold-outs" describes a document they do not have and a fix they cannot apply.
function weightAdvice(page: { width?: number; height?: number }): string {
  // Unmeasured, because the header would not parse. Neither branch below may be
  // claimed then — the message already prints no dimensions for this page, and
  // following that with "the page is letter- or A4-sized" would assert the very thing
  // that could not be read.
  if (page.width === undefined || page.height === undefined) {
    return (
      `A page renders past the limit when it is much larger than letter or A4, or when it is a ` +
      `dense photographic or halftoned scan — pages are rendered losslessly, so that kind of ` +
      `content does not compress. Split or re-export large pages at a smaller page size, or ` +
      `re-save the pages as JPEG images and upload those instead of the PDF.`
    );
  }
  const largeFormat = page.width > NORMAL_PAGE_MAX_PX || page.height > NORMAL_PAGE_MAX_PX;
  if (largeFormat) return LARGE_FORMAT_ADVICE;
  return (
    `The page is letter- or A4-sized, so this is density rather than page size: pages are ` +
    `rendered losslessly, and a photographic or halftoned scan does not compress. Re-save those ` +
    `pages as JPEG images and upload those instead of the PDF.`
  );
}
