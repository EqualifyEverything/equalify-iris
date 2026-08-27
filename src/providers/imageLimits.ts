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
//
// That is the ONLY source here, which is now something the file has to admit rather than
// assume: a deployment can point its vision agents at a model Anthropic did not make, and
// then the pixel limits and the format list below are guesses about it. See `LimitsBasis`
// — the numbers stay conservative, the sentences stop claiming to be facts, and boot says
// so once.

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
// an `invalid_request_error` about "many-image requests". Iris used to cross it: a
// 25-page PDF (util/pdf.ts MAX_PDF_PAGES) was 25 image blocks in the review phase's
// call, and stayed safe only because those pages are rasterized at 150 DPI, which
// puts a letter page at 1275x1650 — under the 2000 px the docs prescribe for staying
// under the limit on all platforms. A 21-page TABLOID PDF broke that assumption
// (1650x2550 per page, over 2000 and under the 8000 that is enforced) and failed
// inside the model rather than here.
//
// It no longer crosses it: `MAX_EDITOR_IMAGES` below is the only path that ever
// attached every page to one request, and it is now the smaller number. Neither
// number here is enforced at upload, and that stays deliberate — the rule applies per
// REQUEST, so refusing large-format documents at upload would reject ones that
// convert fine to pre-empt a call they no longer make. The remaining fix, if a request
// ever needs more image blocks than this, is on the rasterizing side: render large
// pages down rather than refuse them.
export const MANY_IMAGE_THRESHOLD = 20;
export const MANY_IMAGE_MAX_DIMENSION_PX = 2000;

// The most source page images ONE Copy Editor call may carry (pipeline/review.ts).
//
// This is a bound on the whole request, not a preference. The editor's prompt already
// holds the entire assembled body and every issue the Reader raised, and it has to be
// able to emit a full `max_tokens` ceiling of corrected body on top — so the images
// are the one term that can be capped, and until they were, they were unbounded: an
// issue the Reader could not attribute to a page fell back to attaching EVERY page,
// which on a 25-page document is a request the model refuses outright. That refusal
// arrives after extraction and assembly have both been paid for, so an unbounded
// fallback is not an expensive round — it is a lost run (issue #134).
//
// Derived, not picked. An image block costs roughly (width x height) / 750 tokens, so
// at util/pdf.ts's 150 DPI a letter page is ~2.8k and a tabloid page — the largest
// Iris rasterizes without refusing it — is ~5.6k. Twelve of the latter is ~67k, which
// leaves well over half of the 200k context window that is the SMALLEST any Claude
// vision model has for the body, the issue list and the output. It is also under
// MANY_IMAGE_THRESHOLD, so the stricter per-image dimension rule above never applies
// to this call either.
//
// Being wrong here is survivable in both directions, which is why one number is
// enough: too low costs the editor a page image it might have used (recoverable — the
// next round re-attributes, and the pages an issue actually named are attached first),
// and too high is caught by the text-only retry in `runEditor`.
export const MAX_EDITOR_IMAGES = 12;

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

// Whether the PIXEL limits and the format list are documented facts about the model
// this deployment is actually running, or Iris's conservative stand-ins for one it
// cannot recognize. The byte cap is not in question either way — that one is a fact
// about the provider's endpoint, which serves every model it hosts the same.
//
// The distinction did not exist while every model Iris could reach was a Claude. It does
// now: `providers.bedrock.api: converse` sends a request shape that belongs to Bedrock
// rather than to a model vendor (providers/bedrock.ts), so `per_capability.vision` can
// name a Qwen or a Nova. Then `modelGeneration()` answers null — correctly, it is not a
// Claude — `longEdgeFor()` returns the standard tier, and everything downstream states
// 1568 px as what the model reads. Wrong in the reading direction as well as the
// writing one: the sentence tells a user to throw away pixels the model may well have
// used, which is the same class of undiagnosable damage this module was written to end,
// only quieter, because nothing fails.
//
// The NUMBERS do not move with this flag. Every one of them is already the conservative
// end of what Iris knows, which is the right thing to serve an upload with while nobody
// has checked. What moves is the CLAIM: what a hint promises, and whose refusal a
// rejection is attributed to.
export type LimitsBasis = "documented" | "assumed";

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
  // Whether the two pixel numbers above describe the configured vision model or are
  // Iris's guess at it. Not published by `GET /v1/limits`: the endpoint deliberately
  // says nothing about which model serves the deployment, and this is the wording of
  // `hint` rather than a field of its own.
  basis: LimitsBasis;
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
  // The family name is optional in the middle because the older ids put the version
  // FIRST — `anthropic.claude-3-5-sonnet-20240620-v1:0` against
  // `us.anthropic.claude-sonnet-4-6`. Reading only the current order would answer null
  // for every legacy id, which is the same answer as "this is not a Claude at all" and
  // costs a caller that has to tell them apart (see promptCache.ts, which declines to
  // cache on a generation too old to support it).
  const m = model.match(/claude-(?:[a-z]+-)?(\d+)(?:[.-](\d+))?/i);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = m[2] === undefined ? 0 : Number(m[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return { major, minor };
}

// Whether a model is at least a given generation. False for an id this cannot read,
// because every caller is asking whether a capability that arrived in some generation
// is present, and "I do not know which model this is" must not answer yes.
//
// Compared as a PAIR and never as a decimal, for the reason ModelGeneration documents:
// `Number("4.10")` is 4.1, which sorts below 4.7.
export function generationAtLeast(model: string, min: ModelGeneration): boolean {
  const g = modelGeneration(model);
  if (g === null) return false;
  return g.major !== min.major ? g.major > min.major : g.minor >= min.minor;
}

// The long edge one model reads before downscaling.
export function longEdgeFor(model: string): number {
  return generationAtLeast(model, HIGH_RES_FROM_GENERATION)
    ? HIGH_RES_LONG_EDGE_PX
    : STANDARD_LONG_EDGE_PX;
}

// Whether this file has read documentation about a model id's images, or is guessing.
//
// Claude only, because the source at the top of this file is Claude's vision docs and
// there is nothing else here to be documented BY. Deliberately the same question
// `modelGeneration` answers rather than a second list of names to keep in step: an id
// this file cannot place in the Claude generations is an id whose pixel limits it does
// not know, and those are the same id.
//
// This is not a judgement about the model. A vision model Anthropic did not make may
// read larger images than any Claude; the point is that Iris has not been told, so it
// must not speak for it.
export function limitsBasisFor(model: string): LimitsBasis {
  return modelGeneration(model) === null ? "assumed" : "documented";
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
  const perAgent = perAgentImageLimits(cfg);

  // Nothing resolved at all (a config with no reachable provider). Fall back to the
  // conservative defaults rather than publishing Infinity — and to "assumed", because
  // limits resolved from no model at all are not documented about anything.
  if (perAgent.length === 0) {
    const base64Cap = DEFAULT_BASE64_CAP;
    return published(rawBytesForBase64Cap(base64Cap), base64Cap, STANDARD_LONG_EDGE_PX, "assumed");
  }

  return published(
    Math.min(...perAgent.map((a) => a.rawCap)),
    Math.min(...perAgent.map((a) => a.base64Cap)),
    Math.min(...perAgent.map((a) => a.longEdge)),
    // Documented only when it is documented for EVERY agent an upload passes through,
    // for the same reason the strictest number wins above: one sentence is published,
    // and it has to hold for every call the upload makes. A deployment that extracts on
    // a Claude and verifies on something else is a deployment whose published pixel
    // limits are a guess about half its calls.
    perAgent.every((a) => a.basis === "documented") ? "documented" : "assumed",
  );
}

// The fixed parts, assembled in one place so the two returns above cannot drift.
function published(
  rawCap: number,
  base64Cap: number,
  longEdge: number,
  basis: LimitsBasis,
): ImageLimits {
  return {
    max_image_bytes: rawCap,
    max_base64_bytes: base64Cap,
    max_long_edge_px: longEdge,
    max_dimension_px: MAX_DIMENSION_PX,
    media_types: [...new Set(Object.values(IMAGE_MEDIA_TYPES))],
    extensions: Object.keys(IMAGE_MEDIA_TYPES),
    basis,
  };
}

// What ONE agent's own provider block and model say, before the strictest across them
// is taken. Split out because two callers need the identical walk — the limits this
// deployment publishes, and the boot warning about a model those limits were not written
// for — and a warning derived from its own second walk would eventually describe
// something other than the numbers it is warning about.
interface AgentImageLimits {
  agent: string;
  provider: string;
  model: string;
  base64Cap: number;
  rawCap: number;
  longEdge: number;
  basis: LimitsBasis;
}

function perAgentImageLimits(cfg: IrisConfig): AgentImageLimits[] {
  const resolvedAgents: { agent: string; provider: string; model: string }[] = [];
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
    resolvedAgents.push({ agent, ...resolved });
  }

  // Which blocks serve NOTHING this file can read. An `image_limits.max_long_edge_px` is
  // the operator's own number, and on one of these blocks it can only have been written
  // about a model this file cannot place — there is no other model on it for the operator
  // to have been reading about. That is what lets the override answer the basis question
  // below, and why it cannot answer it anywhere else: a block whose default_model is a
  // Claude and whose `per_agent` sends one agent to a Qwen accepts the same override,
  // and reading it as an answer would publish "reads at most 2576 px … loses nothing"
  // about the Qwen — the exact sentence this flag exists to prevent, re-entered through
  // the escape hatch.
  const foreignOnly = new Set(
    [...new Set(resolvedAgents.map((a) => a.provider))].filter((provider) =>
      resolvedAgents
        .filter((a) => a.provider === provider)
        .every((a) => limitsBasisFor(a.model) === "assumed"),
    ),
  );

  const out: AgentImageLimits[] = [];
  for (const { agent, provider, model } of resolvedAgents) {
    const override = (cfg.providers[provider] as ProviderBlock | undefined)?.image_limits;
    const base64Cap = normalizeOverride(
      override?.max_base64_bytes,
      BASE64_CAP_BY_PROVIDER[provider] ?? DEFAULT_BASE64_CAP,
    );
    // Derived from THIS provider's cap, so an override of one number still moves the
    // other: raising the base64 cap for a platform that allows 10 MB raises the file
    // size that follows from it, without the operator restating the arithmetic.
    const rawCap = normalizeOverride(override?.max_image_bytes, rawBytesForBase64Cap(base64Cap));
    // Asked for as a USABLE number rather than a present key, because that is what the
    // basis turns on: `max_long_edge_px:` with nothing after it is YAML for null, which
    // normalizeOverride sends to the fallback, and treating it as an operator's answer
    // would silence the warning below with a line that changed nothing.
    const edgeOverride = normalizeOverride(override?.max_long_edge_px, 0);
    const known = limitsBasisFor(model);
    out.push({
      agent,
      provider,
      model,
      base64Cap,
      rawCap,
      longEdge: edgeOverride > 0 ? edgeOverride : longEdgeFor(model),
      // Documented when this file knows the model, or when the operator has said what
      // they know about it: a long edge set on a block that serves nothing else is them
      // answering the question this asks, and their number stops being anyone's guess.
      basis: known === "documented" || (edgeOverride > 0 && foreignOnly.has(provider))
        ? "documented"
        : "assumed",
    });
  }
  return out;
}

// The one thing worth saying at boot about images: this deployment's vision model is not
// one this file has limits for, so what it publishes and enforces about images is a
// guess. Null when every agent that sees an upload resolves to a model it does know.
//
// A warning and not a startup error, and nothing is refused. Pointing
// `per_capability.vision` at a model Anthropic did not make is a supported thing to do
// (providers/bedrock.ts, `api: converse`), and the guesses are the conservative end of
// what Iris knows, which is the right way to serve an upload nobody has measured. What
// is not supportable is publishing them in the same voice as a checked number:
// `GET /v1/limits`, the demo's hint and the `400` a caller gets are all written to be
// quoted, and boot is the only place an operator can be told which of the two they are
// quoting. The hint qualifies itself for the user; this line is for whoever can fix it.
//
// It goes quiet as soon as that is done: an `image_limits.max_long_edge_px` on the
// provider block serving the agent is the operator saying they have read the model's
// documentation, which is exactly what this asks for.
export function visionModelWarning(cfg: IrisConfig): string | null {
  const guessed = perAgentImageLimits(cfg).filter((a) => a.basis === "assumed");
  if (guessed.length === 0) return null;
  const limits = resolveImageLimits(cfg);
  const formats = limits.media_types.map((t) => t.replace("image/", "").toUpperCase()).join("/");
  const blocks = [...new Set(guessed.map((a) => `providers.${a.provider}.image_limits`))];
  return (
    `the vision model for ${guessed.map((a) => a.agent).join(", ")} ` +
    `(${[...new Set(guessed.map((a) => a.model))].join(", ")}) is not one Iris has documented ` +
    `image limits for, so what it publishes about an image's pixels and formats is a ` +
    `conservative guess: ${limits.max_long_edge_px} px on the long edge, ` +
    `${limits.max_dimension_px} px per side, ${formats}. Those are the documented limits for the ` +
    `models this build does know, and GET /v1/limits, the upload check and the demo all read ` +
    `them — for this model they may be wrong in either direction, including refusing an image it ` +
    `would have accepted. The ${formatBytes(limits.max_image_bytes)} per-image cap is the ` +
    `provider's own and holds whatever the model. Set ${blocks.join(" / ")} to the numbers this ` +
    `model's documentation gives.`
  );
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
//
// That answer is only available when the model's downscaling is documented, which is
// what the second half switches on. "Loses nothing" is a promise about the model, and on
// a model this build has no limits for it would be advice to destroy detail that may
// have been read — a worse outcome than the rejection it is explaining, and one the user
// would never learn about. So the same pixel number is offered as a size that is known
// to work rather than as a size above which nothing counts.
export function imageLimitsHint(limits: ImageLimits): string {
  const lead =
    `Each image must be under ${formatBytes(limits.max_image_bytes)} and in one of ` +
    `${limits.media_types.map((t) => t.replace("image/", "").toUpperCase()).join(", ")} format. `;
  if (limits.basis === "documented") {
    return (
      lead +
      `The vision model reads at most ${limits.max_long_edge_px} px on the long edge and downscales ` +
      `anything larger, so re-saving a big photo or scan at ${limits.max_long_edge_px} px — or as a ` +
      `JPEG — loses nothing the conversion would have used.`
    );
  }
  return (
    lead +
    `The reliable way to bring a big photo or scan under that is to re-save it as a JPEG, or at ` +
    `${limits.max_long_edge_px} px on the long edge — the size this deployment's vision model is ` +
    `assumed to read, since no published limit for it was available.`
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
      `${limits.max_dimension_px} px limit on a side — ${dimensionReason(limits)}. ` +
      `${imageLimitsHint(limits)}`
    );
  }
  return null;
}

// Whose refusal the one hard ceiling is. Documented for Claude, which returns an error
// for an image over it instead of downscaling. On a model with no published limit Iris
// enforces the same number anyway — the conservative end of what it knows, and better
// than discovering the answer four minutes into a run — but says so as its own rule
// rather than putting a refusal in the model's mouth.
function dimensionReason(limits: ImageLimits): string {
  return limits.basis === "documented"
    ? "the vision model refuses an image that large outright rather than shrinking it"
    : "Iris does not send an image that large to any vision model, because the ones it has " +
        "published limits for refuse it outright rather than shrinking it";
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

// Says "what this deployment accepts" rather than "what the vision model accepts", which
// is what it used to say. Both limits it explains are reached by the same page: the byte
// cap belongs to the provider's endpoint and the 8000 px ceiling is Iris's own rule on any
// model it has no published limits for (see `dimensionReason`), so neither is the vision
// model's refusal to attribute — and the page's owner cannot act on whose rule it is
// anyway. The one sentence that IS about the model is in the hint, which qualifies itself.
const LARGE_FORMAT_ADVICE =
  `Iris rasterizes every page at a fixed resolution, so the page image scales with the physical ` +
  `page: a page much larger than letter or A4 — a drawing, a poster, a fold-out — renders past ` +
  `what this deployment accepts for one page image. Export or split those pages at a smaller ` +
  `page size, or upload them as images you have resized.`;

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
