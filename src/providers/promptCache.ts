import type { ProviderBlock } from "../config.ts";
import { generationAtLeast } from "./imageLimits.ts";

// What the model will cache, and when it is worth asking it to.
//
// Iris says the same thing over and over. Every page call re-sends the page agent's
// whole prompt; every fidelity check re-sends the Feedback Agent's; the Reader and the
// Copy Editor re-send theirs on each review round. Three real runs measured 1,478,688
// input tokens with `cache_read_input_tokens` ZERO on every single call (issue #136) —
// the adapters read the cache counters carefully (see types.ts `Usage`) and never
// asked for a cache in the first place.
//
// A cache read bills at 0.1x the input rate and a cache write at 1.25x. So a prefix
// used twice has already more than paid for the write, and the page agent's prompt on
// a 25-page document — one write, two dozen reads — costs roughly a tenth of what it
// costs today.
//
// Everything below is a fact about a MODEL rather than about Iris, and this project
// switches models often, so it is collected HERE and nowhere else — the same reason
// imageLimits.ts exists. One table means a model switch moves the threshold instead of
// leaving a number in an adapter that is quietly no longer true.
//
// Sources (checked 2026-08-24):
//   https://platform.claude.com/docs/en/build-with-claude/prompt-caching
//   (Cache limitations — minimum cacheable prompt length; Pricing; What can be cached)

// The shortest prefix that can be cached at all, in TOKENS, per model family.
//
// Asking for less than this is not an error and not a surcharge: the breakpoint is
// ignored and the request is served exactly as it would have been without one. That
// asymmetry is why the check below only has to be roughly right.
const MIN_CACHEABLE_TOKENS = { opus: 1024, sonnet: 1024, haiku: 2048 } as const;

// The generation from which asking is safe on every platform Iris speaks to.
//
// This is a floor, not the full picture, and deliberately so. The Claude API has
// supported caching since 3.0 on some models; Bedrock's support starts at 3.7 (with
// 3.5 Haiku as its one earlier exception) and it is Bedrock that Iris is deployed on.
// The intersection is what a single number can honestly promise, and being under it in
// one direction costs a legacy deployment its saving, while being over it in the other
// costs that deployment EVERY CALL — an upstream that does not know the field rejects
// the request, not just the caching.
const CACHING_FROM_GENERATION = { major: 3, minor: 7 };

// A LOWER BOUND on characters per token — not an average. It is used only to decide
// when a prompt is too short to be worth a breakpoint, and the two directions of being
// wrong are not symmetric: asking on a prompt below the minimum costs nothing (see
// above), while declining to ask on one above it silently gives up the whole saving.
// So this is set where no plausible English or markdown prompt tokenizes denser,
// meaning a prompt skipped here genuinely cannot reach the minimum.
const MIN_CHARS_PER_TOKEN = 2;

export type ClaudeFamily = keyof typeof MIN_CACHEABLE_TOKENS;

// Which Claude the model id names, or null for an id this cannot read.
//
// Both id shapes, because the providers spell the same model differently and put the
// family in different places: Bedrock has `us.anthropic.claude-sonnet-4-6` and, for
// older generations, `anthropic.claude-3-5-sonnet-20240620-v1:0`; OpenRouter has
// `anthropic/claude-opus-4.7`. Everything between "claude" and the family name is a
// version, so it is skipped rather than parsed — this needs the family and nothing
// else.
export function claudeFamily(model: string): ClaudeFamily | null {
  const m = model.match(/claude[-.\d\s]*(opus|sonnet|haiku)/i);
  return m ? (m[1].toLowerCase() as ClaudeFamily) : null;
}

// One text block with a cache breakpoint on it, in the shape both adapters need.
//
// `ephemeral` is the only cache type there is; the name refers to the ~5 minute TTL,
// refreshed on each read. Shared so the two adapters cannot drift into asking for
// caching in two different ways — the field is Anthropic's, and both of them speak the
// Anthropic Messages format for it (Bedrock natively, OpenRouter by forwarding
// OpenAI-style content parts to an Anthropic upstream).
export function cachedTextBlock(text: string): {
  type: "text";
  text: string;
  cache_control: { type: "ephemeral" };
} {
  return { type: "text", text, cache_control: { type: "ephemeral" } };
}

// Whether this provider block permits explicit caching at all. On by default; an
// operator sets `prompt_cache: false` to turn it off.
//
// The escape hatch exists because of the one way this can fail badly. `cache_control`
// is an Anthropic field, and an upstream that does not accept it rejects the REQUEST —
// which would not be one slow call but every call this deployment makes. Iris cannot
// always know which upstream serves it: OpenRouter is a broker that forwards Claude
// traffic to Bedrock, Vertex or Anthropic as it chooses and does not say which. So a
// deployment that meets such an upstream needs a way back that is not a redeploy of
// Iris.
//
// Only an explicit false disables it, and the string form counts: YAML parses a
// valueless `prompt_cache:` as null (which must not read as "off" — it is an operator
// who set nothing), and a quoted `"false"` is a truthy string that plainly means off.
export function promptCacheEnabled(cfg: Pick<ProviderBlock, "prompt_cache">): boolean {
  const v = cfg.prompt_cache as unknown;
  if (v === false) return false;
  if (typeof v === "string" && v.trim().toLowerCase() === "false") return false;
  return true;
}

// Whether a system prompt is worth a cache breakpoint on this model.
//
// Only the size question and the "is this even a Claude" question. Deliberately NOT a
// question about whether the prefix will be reused, which the issue proposed keying on
// ("will this session make more than one call with this prefix"): every system prompt
// Iris sends is a static agent file, identical on every call and across every session
// this deployment runs, so within the cache's window the answer is essentially always
// yes — and a prediction threaded down from the pipeline to the adapters would be a
// new seam to be wrong at. The case it would protect is a deployment quiet enough that
// each write expires unread, which pays 0.25x of one agent prompt per run: ~600 tokens
// for `agents/page.md`, against the six figures a busy one saves.
//
// An id this cannot read gets no breakpoint, and neither does one whose generation
// predates caching. Both are the same safe direction, and the reason neither guesses:
// an unreadable id may not be a Claude model at all — an OpenAI model reached through
// OpenRouter caches automatically and takes no such field, and a test's mock model has
// no cache to ask for — while a recognizable but old one is a model whose platform may
// reject the field outright. Recognizing the FAMILY is not enough on its own; a name
// only says which Claude, not which generation of it.
export function cacheableSystemPrompt(model: string, system: string): boolean {
  const family = claudeFamily(model);
  if (!family) return false;
  if (!generationAtLeast(model, CACHING_FROM_GENERATION)) return false;
  return system.length >= MIN_CACHEABLE_TOKENS[family] * MIN_CHARS_PER_TOKEN;
}
