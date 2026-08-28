import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  InvokeModelWithResponseStreamCommand,
  type ContentBlock,
  type ConverseStreamOutput,
  type ImageFormat,
  type Message as ConverseMessage,
  type SystemContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
import { DEFAULT_MAX_TOKENS, type Capability, type ProviderBlock } from "../config.ts";
import {
  StalledStreamError,
  TruncatedResponseError,
  isRequestTooLargeError,
  type StallKind,
} from "./types.ts";
import type { CompletionRequest, CompletionResult, ModelProvider, Usage } from "./types.ts";
import {
  cacheableSystemPrompt,
  cacheableUserPrefix,
  cachePointBlock,
  cachedTextBlock,
  promptCacheEnabled,
  promptCacheTtl,
  type CacheTtl,
} from "./promptCache.ts";

// How long a call may send NOTHING before we give up on it.
//
// These are IDLE timeouts, not total ones, and the distinction is the whole reason
// this adapter streams. A single non-streaming InvokeModel gives you one datum —
// "the answer has not arrived yet" — which is equally true of a dead socket and of a
// large document being correctly rewritten. Capping total duration therefore kills
// both, and the review phase's document-level rewrite (whole body in, whole
// corrected body out, up to max_tokens) is slow enough to be the one that dies.
// Streaming separates the two cases: work in progress keeps arriving, a stall does
// not. A healthy stream is never silent for a minute.
//
// Getting started gets its own, more generous window, matching OpenRouter's. Nothing
// about message_start helps before message_start arrives: ahead of the first event a
// stream is as silent as a dead one, and that phase is where the whole prompt is
// processed — for the call that prompted this fix, an entire document plus eight page
// images. 60s there would fail that call sooner than the total cap it replaced, on
// the exact adapter and request the incident happened on. 120s is the old cap's
// value, which was never a bad bound on getting started, only on finishing.
const FIRST_OUTPUT_TIMEOUT_MS = 120_000;

// Once text is actually arriving, silence this long means the stream died
// mid-generation. A healthy stream mid-answer is never quiet for a minute.
const IDLE_TIMEOUT_MS = 60_000;

// How long the tail of a stream may take once the message itself has stopped. Only
// ConverseStream has a tail — its `metadata` event, carrying every token count, follows
// `messageStop` — and it arrives immediately in practice. Short on purpose, and running
// out of it is not a failure: the document is already in hand, so waiting a full idle
// minute for a number and then throwing the document away would be the worse trade.
const TRAILING_TIMEOUT_MS = 10_000;

// Absolute backstop for a stream that never stalls but never ends either — a token
// every 30 seconds would satisfy the idle timeout forever while holding a
// concurrency slot and leaving the session "running". Deliberately generous: it is
// here to bound the pathological case, not to bound normal slow work.
const MAX_TOTAL_MS = 15 * 60_000;

// What the upstream actually sends in a usage block, which is a superset of what
// `Usage` declares: today `service_tier` and a nested `cache_creation` breakdown ride
// along beside the four counts, and a model release can add more without notice.
type RawUsage = Record<string, unknown>;

// The four counts, and nothing else. The router spreads usage FLAT onto the
// `model_call` log event so diagnostics can sum it straight off the line, so an
// unknown field here is not inert: it lands in the run log, and a nested object lands
// there too, contradicting the one-level-deep shape that spread depends on. Picking is
// also what the OpenRouter adapter already does (`normalizeUsage`), so both adapters
// hand the router the same four keys whatever their upstream volunteers.
//
// A non-number is dropped rather than coerced: `Number(undefined)` is NaN and
// `Number(null)` is 0, and a 0 the upstream never sent would read as a free call
// instead of an unreported one — the distinction `tokens.calls_reported` exists for.
function pickUsage(raw?: RawUsage): Usage | undefined {
  if (!raw) return undefined;
  const usage: Usage = {};
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ] as const) {
    const v = raw[key];
    if (typeof v === "number" && Number.isFinite(v)) usage[key] = v;
  }
  return Object.keys(usage).length ? usage : undefined;
}

// Anthropic's streaming event shapes, narrowed to the fields this adapter reads.
// Deltas other than text (e.g. input_json_delta) are ignored: structured output
// here is prompt-driven, not tool-driven, so text is the only content that arrives.
interface StreamEvent {
  type?: string;
  delta?: { type?: string; text?: string; stop_reason?: string };
  error?: { type?: string; message?: string };
  // Token counts arrive in two places and never in one: message_start carries the
  // prompt's totals (input plus whatever was read from or written to the cache),
  // and the message_delta that closes the message carries the output total. Both
  // are read, because cost needs both and the input half is the one a stalled call
  // still knows.
  //
  // Typed as an open record rather than as `Usage`, because it is not one: the
  // upstream sends more than the four fields Usage declares (`service_tier`, a
  // nested `cache_creation` breakdown), and calling it `Usage` here would license
  // passing the whole object on — see `pickUsage`.
  message?: { usage?: RawUsage };
  usage?: RawUsage;
}

// Bedrock delivers mid-stream service failures as events on an otherwise-200
// response, one modeled exception per union member. Surface whichever arrived.
//
// Read off the member NAMES rather than the SDK's union types, because the two APIs
// this adapter speaks do not agree on the set: `InvokeModelWithResponseStream` has a
// `modelTimeoutException` member and `ConverseStream` does not. Every name is checked
// against both, which costs a handful of property reads and means neither stream can
// carry a failure this does not notice.
const EXCEPTION_MEMBERS = [
  "internalServerException",
  "modelStreamErrorException",
  "validationException",
  "throttlingException",
  "modelTimeoutException",
  "serviceUnavailableException",
] as const;

function streamException(event: object): string | null {
  for (const name of EXCEPTION_MEMBERS) {
    const found = (event as Record<string, { message?: string } | undefined>)[name];
    if (found) return `${name}: ${found.message ?? "no message"}`;
  }
  return null;
}

// Which Bedrock API this block's calls go out on.
//
// `invoke` is `InvokeModelWithResponseStream` carrying an Anthropic-native body, which
// is what this adapter has always sent and what every deployment runs today. `converse`
// is `ConverseStream`, whose request and response shapes belong to Bedrock rather than
// to a model vendor — the same call reaches a Claude, a Nova or a Qwen, which is what
// `providers.bedrock.default_model` has always implied it could and could not (#178).
//
// The default is `invoke`, and only an explicit, recognized `converse` moves it. Parity
// between the two is an empirical question about a live endpoint — the request bodies
// differ in every field, and no test in this repo talks to Bedrock — so the switch is
// here to be measured with, not to be assumed: a one-page probe and one bench round on
// `converse` are what would justify changing this default. Anything unrecognized is the
// default, for the same reason `prompt_cache_ttl` works that way, and is warned about at
// boot (config.ts `bedrockApiWarning`) because nothing downstream reports it: both APIs
// return text, and a deployment that meant to be testing Converse would otherwise be
// measuring the path it already had.
export type BedrockApi = "invoke" | "converse";

export function bedrockApi(cfg: Pick<ProviderBlock, "api">): BedrockApi {
  const v = cfg.api as unknown;
  return typeof v === "string" && v.trim().toLowerCase() === "converse" ? "converse" : "invoke";
}

// A page image as ConverseStream wants it: a format name from its own enum and RAW
// bytes, where the Anthropic-native body takes a media type and base64 text.
//
// An extension Iris does not recognize already arrives here as `image/png`
// (pipeline/context.ts `mediaTypeFor`), and the four types that table can produce are
// exactly the four this enum has, so the fallback below is unreachable through the
// pipeline. It is a fallback rather than a throw because a caller constructing an
// `Image` by hand is not a reason to fail a page: a wrong format name is rejected by
// Bedrock with a message that says so, while a throw here would be an Iris error about
// a picture that is very likely fine.
const CONVERSE_IMAGE_FORMATS: Record<string, ImageFormat> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function converseImageFormat(mediaType: string): ImageFormat {
  return CONVERSE_IMAGE_FORMATS[mediaType.trim().toLowerCase()] ?? "png";
}

// What one stream event told us, in the terms `complete` reasons about, so that the
// clocks, the accumulation and the completeness checks below are written once for both
// APIs. `null` is an event this adapter does not recognize — deliberately NOT counted as
// progress, so an unknown event repeating forever trips the idle clock instead of
// defeating it.
type Reading = {
  text?: string;
  stopReason?: string;
  usage?: Usage;
  // The upstream said the message is over. Kept distinct from `done` because on
  // ConverseStream they are two different events: collapsing them would make the
  // completeness check below ask one question twice instead of two questions once.
  stopped?: boolean;
  // Nothing further is coming that this adapter reads: stop rather than waiting for
  // the upstream to close the body.
  done?: boolean;
  // The transport saying it is alive, which is not the model producing anything.
  quiet?: boolean;
} | null;

// One event of an `InvokeModelWithResponseStream` body.
//
// Deltas other than text (e.g. input_json_delta) are ignored: structured output here is
// prompt-driven, not tool-driven, so text is the only content that arrives.
function readInvoke(event: object): Reading {
  const failure = streamException(event);
  if (failure) throw new Error(`bedrock: ${failure}`);
  const bytes = (event as { chunk?: { bytes?: Uint8Array } }).chunk?.bytes;
  // Not a chunk and not a modeled failure: an event shape this adapter does not know.
  if (!bytes) return null;
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as StreamEvent;
  if (parsed.type === "error") {
    throw new Error(`bedrock: stream error: ${parsed.error?.message ?? "no message"}`);
  }
  const reading: NonNullable<Reading> = {};
  if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
    reading.text = parsed.delta.text ?? "";
  }
  // stop_reason arrives once, on the message_delta that closes the message.
  if (parsed.delta?.stop_reason) reading.stopReason = parsed.delta.stop_reason;
  // message_start nests usage under `message`; message_delta puts it at the top level.
  // Both are checked rather than switching on `type`, so a future event carrying usage
  // anywhere is picked up rather than dropped.
  const usage = { ...pickUsage(parsed.message?.usage), ...pickUsage(parsed.usage) };
  if (Object.keys(usage).length) reading.usage = usage;
  // A keepalive is the transport saying it is alive; it is not the model producing
  // anything. Every other event (message_start, content_block_start, the deltas) is real
  // protocol progress and keeps the call alive.
  if (parsed.type === "ping") reading.quiet = true;
  // Here the two coincide: message_stop ends the message and nothing follows it.
  if (parsed.type === "message_stop") {
    reading.stopped = true;
    reading.done = true;
  }
  return reading;
}

// One event of a `ConverseStream`, read into the same shape.
//
// Two differences from the Anthropic stream, both of which are about WHEN the accounting
// arrives rather than what it says:
//
//   - Usage comes ONCE, in the `metadata` event, where the Anthropic stream reports the
//     prompt's counts up front in `message_start` and the output's at the end. So a call
//     that stalls mid-generation on this API reports no usage at all, where on the other
//     it still reports what the prompt cost. There is no earlier event to read it from:
//     that is accounting lost on a FAILED call, and none lost on a successful one.
//   - `metadata` arrives AFTER `messageStop`, so it and not the stop event is what ends
//     the read. Breaking on `messageStop` — the natural translation of the Anthropic
//     path's `message_stop` — would throw away every token count this deployment bills
//     on. So `stopped` and `done` come from different events here, and a stream that ends
//     after `messageStop` without a `metadata` event is still a complete response.
//   - There is no keepalive event, so `quiet` never arises: every member recognized here
//     is real progress.
function readConverse(event: object): Reading {
  const failure = streamException(event);
  if (failure) throw new Error(`bedrock: ${failure}`);
  const e = event as ConverseStreamOutput;
  const reading: NonNullable<Reading> = {};
  let known = false;
  if (e.contentBlockDelta) {
    known = true;
    const delta = e.contentBlockDelta.delta;
    if (delta && "text" in delta && typeof delta.text === "string") reading.text = delta.text;
  }
  if (e.messageStart || e.contentBlockStart || e.contentBlockStop) known = true;
  if (e.messageStop) {
    known = true;
    reading.stopped = true;
    if (e.messageStop.stopReason) reading.stopReason = e.messageStop.stopReason;
  }
  if (e.metadata) {
    known = true;
    const usage = converseUsage(e.metadata.usage);
    if (usage) reading.usage = usage;
    reading.done = true;
  }
  return known ? reading : null;
}

// The stop reasons that mean the text in hand is the whole answer.
//
// An ALLOWLIST, and the direction matters. On the Anthropic body a single `max_tokens`
// check covered every incomplete case, because that body stops only for `end_turn`,
// `max_tokens`, `stop_sequence`, `tool_use` or `refusal`. ConverseStream's `StopReason`
// is Bedrock's own and larger: it adds `model_context_window_exceeded`,
// `malformed_model_output`, `malformed_tool_use`, `content_filtered` and
// `guardrail_intervened` — five ways to arrive with a set stop reason, satisfy the
// completeness check, and return partial HTML as a successful result. That is the exact
// failure TruncatedResponseError exists to prevent, and a page cut short this way scores
// as model inaccuracy rather than as an adapter bug, which would corrupt the very
// measurement the `converse` switch exists to enable.
//
// Listing what is whole rather than what is broken also fails closed: a reason a future
// model or SDK adds is unrecognized, and an unrecognized reason to stop is not a promise
// that the answer is finished. `refusal` is in the list because a refusal IS a complete
// response — an unhelpful one, which the verify pass downstream is what judges.
//
// It governs BOTH dialects, not just the new one. Today the Anthropic body cannot produce
// a reason outside this list plus `max_tokens` — Iris sends no server tools (so no
// `pause_turn`), no guardrail config and no context management — so nothing about the
// live path changes. What changes is the direction it fails in when that stops being
// true, and there is no version of "a stop reason we have never seen" that should ship a
// document.
const WHOLE_ANSWER_STOP_REASONS = new Set(["end_turn", "stop_sequence", "tool_use", "refusal"]);

// ConverseStream's token counts under the names the rest of Iris uses.
//
// The mapping is not cosmetic: `cacheWriteInputTokens` is the same quantity Anthropic
// calls `cache_creation_input_tokens`, and the router spreads these keys FLAT onto the
// `model_call` log event, where diagnostics and the cost accounting sum them by name. A
// `cacheWrite…` key reaching the log would be a call that reported no cache write.
//
// `totalTokens` is dropped rather than passed through. It is the sum of the others as
// this API counts them, and `Usage` has no field for it — carrying it would put a fifth
// number on the log line whose relationship to the four is a claim nothing here checks.
function converseUsage(raw?: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}): Usage | undefined {
  if (!raw) return undefined;
  const usage: Usage = {};
  const put = (key: keyof Usage, v: unknown): void => {
    if (typeof v === "number" && Number.isFinite(v)) usage[key] = v;
  };
  put("input_tokens", raw.inputTokens);
  put("output_tokens", raw.outputTokens);
  put("cache_read_input_tokens", raw.cacheReadInputTokens);
  put("cache_creation_input_tokens", raw.cacheWriteInputTokens);
  return Object.keys(usage).length ? usage : undefined;
}

// What one attempt asked for, and whether it cost anything. `maxTokens` because the ceiling
// a call asks for is not always `this.maxTokens` — once Bedrock has stated a lower one for a
// model, that is what the next call asks for, and the truncation error has to name the
// number actually sent or it points an operator at the wrong figure.
//
// `spent` is what makes sending a refused request again free: it is true as soon as anything
// about this attempt has been paid for, which is output having streamed OR an upstream
// having reported usage for it. Both, not just the first: the Anthropic stream reports the
// PROMPT's counts in `message_start`, before a single delta, so a failure arriving after that
// event has been billed for the whole prompt while having produced no text at all. Bedrock
// delivers this refusal as an HTTP error today, before any of that — but a guard that has to
// be re-derived from where AWS currently validates is not a guard.
interface Attempt {
  maxTokens: number;
  spent: boolean;
}

// The output ceiling a Bedrock rejection states, as Bedrock states it. Both messages below
// are verbatim, and both are one command to reproduce (us-east-1, 2026-08-28):
//
//   aws bedrock-runtime converse --model-id amazon.nova-pro-v1:0 \
//     --messages '[{"role":"user","content":[{"text":"hi"}]}]' \
//     --inference-config '{"maxTokens":32000}'
//   → ValidationException: The maximum tokens you requested exceeds the model limit of
//     10000. Try again with a maximum tokens value that is lower than 10000.
//
//   aws bedrock-runtime invoke-model --model-id us.anthropic.claude-sonnet-4-6 \
//     --body '{"anthropic_version":"bedrock-2023-05-31","max_tokens":200000,...}' out.json
//   → ValidationException: The maximum tokens you requested exceeds the model limit of
//     128000
//
// So the sentence is Bedrock's own on both APIs, and the second one shows the trailing
// advice is optional — which is why the number is read from "the model limit of N" and not
// from "lower than N". "Lower than" is also wrong as an instruction: asking Nova Pro for
// exactly 10000 succeeds (same command, `maxTokens: 10000`, 52 output tokens returned), so
// the stated limit is the value to retry AT, not one to subtract from.
const OUTPUT_CEILING_STATED = /maximum tokens you requested exceeds the model limit of\s*([\d,]+)/i;

// Name and message together, because the AWS SDK puts "ValidationException" in `name` and
// leaves the message the bare sentence. Only the CLI above prints them joined.
function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

export function statedOutputCeiling(e: unknown): number | null {
  const found = OUTPUT_CEILING_STATED.exec(errorText(e));
  if (!found) return null;
  const ceiling = Number(found[1].replace(/,/g, ""));
  return Number.isSafeInteger(ceiling) && ceiling > 0 ? ceiling : null;
}

// Whether Bedrock refused the request over the model's OUTPUT ceiling, which is the one
// refusal `providers.bedrock.max_tokens` answers.
//
// `isRequestTooLargeError` comes first and wins, because the two refusals read alike and
// have opposite remedies: a call refused for the size of its PROMPT is one the review loop
// recovers by dropping page images (pipeline/review.ts), and stealing it here would replace
// a working recovery with a retry that changes nothing about the prompt. One phrasing in
// the wild says both at once — a marketplace model rejecting with "This model's maximum
// context length is 4096 tokens. However, you requested 4096 output tokens..." — and it is
// a context refusal, so lowering the output ceiling would not have helped it.
//
// Past the sentence this adapter has seen, the test is a validation refusal that names the
// output ceiling in some other words. Such an error is not retried — there is no number to
// retry at — but it is still worth recognizing, because naming the knob is most of what
// issue #249 asks for and a wording AWS changes tomorrow should not cost that.
export function refusedForOutputCeiling(e: unknown): boolean {
  if (isRequestTooLargeError(e)) return false;
  const text = errorText(e).toLowerCase();
  if (OUTPUT_CEILING_STATED.test(text)) return true;
  return (
    text.includes("validationexception") &&
    /max_tokens|maxtokens|maximum tokens|output token/.test(text) &&
    /limit|exceed|lower than|less than|maximum allowed/.test(text)
  );
}

// The failure #249 is about, said in a way that names the setting at fault. Bedrock's own
// message does not: an operator reading "the maximum tokens you requested exceeds the model
// limit" beside a run of pages that all failed has no reason to look in config at all, and
// the pipeline reports it as pages lost, which reads as a model that could not do the work.
//
// Deliberately worded clear of every phrase `isRequestTooLargeError` matches ("too large",
// "context length", "too many tokens"): this call was refused over its OUTPUT ceiling, and
// a caller that read it as a prompt-size refusal would drop the page images and ask again
// with the same ceiling.
function outputCeilingRefused(model: string, asked: number, cause: unknown): Error {
  const said = cause instanceof Error ? cause.message : String(cause);
  const error = new Error(
    `bedrock: ${model} refused a request asking for ${asked} output tokens, and its own ` +
      `ceiling is what it refused — the model is not being asked to do work it cannot do. ` +
      `providers.bedrock.max_tokens is the setting at fault: lower it, or route this ` +
      `capability to a model whose ceiling is at least that high (providers.per_agent). ` +
      `Bedrock said: ${said}`,
    { cause },
  );
  error.name = "OutputCeilingRefusedError";
  return error;
}

// Amazon Bedrock adapter (PRD §10.3). Uses the Anthropic Messages format
// that Bedrock's Claude models accept. Credentials come from the standard
// AWS credential chain (env vars, shared profile, or IAM role).
//
// Retries are NOT implemented here. The AWS SDK already applies its `standard`
// retry strategy — 3 attempts with exponential backoff — to exactly the classes
// worth retrying (throttling/429, 5xx, and node network errors like ECONNRESET),
// while failing fast on 4xx validation errors. Verified empirically against a
// stubbed request handler: 3 wire attempts for 503/429/ECONNRESET, 1 for a 400.
// Wrapping that in another loop would give Bedrock 9 attempts where OpenRouter
// (which retries by hand because fetch() has no such strategy) gets 3.
//
// Known gap, inherent to streaming: that strategy covers establishing the request.
// A failure delivered as an event mid-stream (see streamException) rides a 200, so
// the SDK never classifies it and cannot retry it. Such a call now fails where the
// non-streaming version would have retried it. Left alone deliberately — a retry
// here would have to either discard streamed output or resume mid-document, and
// neither is worth building before the logs show it happening.
export class BedrockProvider implements ModelProvider {
  name = "bedrock";
  capabilities: Capability[] = ["text", "vision", "structured_output"];

  // Which of the two APIs this provider's calls go out on. Public because the router
  // puts it on every `model_call` (see ModelProvider.dialect), so a run log says which
  // dialect produced its numbers rather than leaving that to the config that started it.
  dialect: BedrockApi;

  private client: BedrockRuntimeClient;
  private maxTokens: number;
  // Output ceilings Bedrock has stated in a rejection, per model id, learned in this
  // process and never read from a table. Per MODEL rather than per provider because one
  // provider block serves several: `per_capability` and `providers.per_agent` can put a
  // Nova on vision and a Claude on text, and clamping the Claude because the Nova refused
  // would lose output nothing had refused. Nothing persists it — a process that restarts
  // pays one rejected request per model to learn it again, which is the cost of having no
  // catalogue to go stale (issue #249).
  private ceilings = new Map<string, number>();
  // Which models the paragraph about `max_tokens` has already been printed for. See the warn
  // in `complete`: the first several calls of a run are in flight together and all refused.
  private warnedCeilings = new Set<string>();
  private promptCache: boolean;
  private cacheTtl: CacheTtl;
  private firstOutputTimeoutMs: number;
  private idleTimeoutMs: number;
  private trailingTimeoutMs: number;
  private maxTotalMs: number;

  // `timeouts` is a test seam: the defaults are what production runs, but a test
  // for stall handling cannot wait a minute to observe it.
  constructor(
    cfg: ProviderBlock,
    timeouts: {
      firstOutputTimeoutMs?: number;
      idleTimeoutMs?: number;
      trailingTimeoutMs?: number;
      maxTotalMs?: number;
    } = {},
  ) {
    this.client = new BedrockRuntimeClient({ region: cfg.region ?? "us-east-1" });
    this.dialect = bedrockApi(cfg);
    // loadConfig normalizes this, but a directly-constructed provider (tests,
    // embedders) may pass a raw block — so fall back rather than send undefined.
    this.maxTokens = cfg.max_tokens ?? DEFAULT_MAX_TOKENS;
    this.promptCache = promptCacheEnabled(cfg);
    this.cacheTtl = promptCacheTtl(cfg);
    this.firstOutputTimeoutMs = timeouts.firstOutputTimeoutMs ?? FIRST_OUTPUT_TIMEOUT_MS;
    this.idleTimeoutMs = timeouts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.trailingTimeoutMs = timeouts.trailingTimeoutMs ?? TRAILING_TIMEOUT_MS;
    this.maxTotalMs = timeouts.maxTotalMs ?? MAX_TOTAL_MS;
  }

  // The invariant head of a user message, or null when it must not be split off.
  //
  // Shared by both request builders so that WHICH text gets a breakpoint cannot differ
  // between the two APIs — only how the breakpoint is spelled. Declined for a model that
  // cannot cache, for a head too short to be worth it, and for a `cachedPrefix` that is
  // not actually a prefix of `content`; in every one of those cases the message is sent
  // exactly as it was. See Message.cachedPrefix: the pieces concatenate to the string
  // `content` already is, so this changes what is BILLED and not what is said.
  private cachedHead(req: CompletionRequest, m: CompletionRequest["messages"][number]): string | null {
    return m.role === "user" &&
      m.cachedPrefix &&
      m.content.startsWith(m.cachedPrefix) &&
      this.promptCache &&
      cacheableUserPrefix(req.model, m.cachedPrefix)
      ? m.cachedPrefix
      : null;
  }

  // Whether the system prompt is worth a cache breakpoint. It is the ONE part of the
  // request that is byte-identical from call to call — an agent file, the same for every
  // page of every document — while the page image and the page's own text sit after it in
  // the user message, which is exactly the shape a cached prefix wants.
  private cacheSystem(req: CompletionRequest, system: string): boolean {
    return this.promptCache && cacheableSystemPrompt(req.model, system);
  }

  // What this call may ask for: the deployment's ceiling, or the model's own where Bedrock
  // has already stated a lower one.
  private ceilingFor(model: string): number {
    const stated = this.ceilings.get(model);
    return stated === undefined ? this.maxTokens : Math.min(this.maxTokens, stated);
  }

  // A config-only model swap is what `providers` exists for, and `max_tokens: 32000` is
  // more output than several Bedrock models will accept: Amazon Nova Pro caps at 10000 and
  // REFUSES the request rather than clamping it, so every page of every document fails
  // until someone reads the rejection and knows to change a second setting (issue #249).
  //
  // The refusal carries the remedy in it — Bedrock states the model's actual ceiling — so
  // the call is sent again at that ceiling and the number is remembered for the rest of the
  // process. No per-model table: a catalogue of ceilings would need editing every time AWS
  // adds a model, and would be silently wrong for the one nobody remembered.
  //
  // Retried ONCE and only from the refusal, which is safe in the two ways that matter: a
  // validation refusal happens before generation, so nothing was billed and no output was
  // discarded (`attempt.chars`, held rather than assumed), and the second attempt asks for
  // strictly less than the first, so this cannot recur. A second refusal is reported, not
  // retried again.
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const system = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const asked = this.ceilingFor(req.model);
    const first: Attempt = { maxTokens: asked, spent: false };
    try {
      return await this.send(req, system, first);
    } catch (e) {
      // `first.spent` is the guarantee that sending it again costs nothing: a refusal
      // arrives before generation, so a failure that had already been billed for is not
      // this one however its message reads, and re-sending would pay for the prompt twice.
      if (!refusedForOutputCeiling(e) || first.spent) throw e;
      const stated = statedOutputCeiling(e);
      // Refused over the ceiling with nothing to retry at: either the message did not state
      // a number, or it stated one that is not below what was asked, which is a rejection
      // this adapter does not understand well enough to answer. Both still get to say which
      // knob is wrong, which is the half of #249 that matters most on call.
      if (stated === null || stated >= asked) throw outputCeilingRefused(req.model, asked, e);
      this.ceilings.set(req.model, stated);
      // Once per model per process, and said with a flag of its own rather than left to the
      // line above: pages are extracted five at a time (DEFAULT_EXTRACTION_CONCURRENCY), so
      // on a fresh process every call already in flight asks for the deployment's ceiling
      // before any of them has learned better, and all five are refused. The rejections are
      // free — nothing is billed for a request that was never read — but five copies of a
      // paragraph about config would read as five different problems.
      //
      // Not an error, either: the call is about to succeed, and a deployment that never reads
      // its logs still gets its pages. Worth saying anyway, because the config is wrong, later
      // calls pay nothing for that only because of the line above, and a ceiling the MODEL
      // enforces is not one the shrink floor and section headroom were sized against.
      if (!this.warnedCeilings.has(req.model)) {
        this.warnedCeilings.add(req.model);
        console.warn(
          `bedrock: ${req.model} refused ${asked} output tokens and stated its own ceiling of ` +
            `${stated}, so the call was sent again at ${stated} and every later call to this ` +
            `model in this process will ask for ${stated}. providers.bedrock.max_tokens is ` +
            `${this.maxTokens}, which this model does not accept: nothing has to change for ` +
            `the run to finish, but ${stated} is now the ceiling a dense page has to fit ` +
            `under, and the shrink floor and section headroom were sized against ` +
            `${this.maxTokens}.`,
        );
      }
      const second: Attempt = { maxTokens: stated, spent: false };
      try {
        return await this.send(req, system, second);
      } catch (again) {
        if (!refusedForOutputCeiling(again) || second.spent) throw again;
        // This page is lost either way — a third attempt is not on offer, since a model that
        // refuses the ceiling it just named is one this adapter has no model of. But the
        // number it named the second time is still the best thing known about it, so the next
        // call starts from there rather than re-learning the same two refusals. `ceilingFor`
        // takes the lower of this and the deployment's, so a larger one changes nothing.
        const narrower = statedOutputCeiling(again);
        if (narrower !== null && narrower < stated) this.ceilings.set(req.model, narrower);
        throw outputCeilingRefused(req.model, stated, again);
      }
    }
  }

  // One attempt at one ceiling.
  //
  // Sent from inside the branch rather than after it, because the SDK's `send` is typed
  // per command: a union of two commands matches neither overload, and widening it to
  // make one call site work would be casting away the one check that says a Converse
  // request is being sent to the Converse API.
  private send(req: CompletionRequest, system: string, attempt: Attempt): Promise<CompletionResult> {
    if (this.dialect === "converse") {
      const command = this.converseCommand(req, system, attempt.maxTokens);
      return this.stream(req, attempt, (signal) => this.client.send(command, { abortSignal: signal }), readConverse);
    }
    const command = this.invokeCommand(req, system, attempt.maxTokens);
    return this.stream(req, attempt, (signal) => this.client.send(command, { abortSignal: signal }), readInvoke);
  }

  // The Anthropic Messages body, sent through `InvokeModelWithResponseStream`. What every
  // deployment runs, and the reference the `converse` path has to match.
  private invokeCommand(
    req: CompletionRequest,
    system: string,
    maxTokens: number,
  ): InvokeModelWithResponseStreamCommand {
    const messages = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => {
        const prefix = this.cachedHead(req, m);
        if (m.role === "user" && (prefix || req.images?.length)) {
          const content: unknown[] = [];
          if (prefix) content.push(cachedTextBlock(prefix, this.cacheTtl));
          const tail = prefix ? m.content.slice(prefix.length) : m.content;
          // Only when there is one. A caller whose whole message is invariant leaves
          // nothing after the head, and an empty text block is rejected by the API — so
          // the guarantee that a declared head never breaks a call would fail on the one
          // input that needs no tail at all.
          if (tail) content.push({ type: "text", text: tail });
          for (const img of req.images ?? []) {
            content.push({
              type: "image",
              source: {
                type: "base64",
                media_type: img.media_type,
                data: img.data.toString("base64"),
              },
            });
          }
          return { role: m.role, content };
        }
        return { role: m.role, content: m.content };
      });

    const payload: Record<string, unknown> = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: maxTokens,
      messages,
    };
    // The system prompt, and a cache breakpoint on it when it is worth one
    // (`cacheSystem`). A breakpoint requires the block form; a plain string stays a
    // plain string.
    if (system) {
      payload.system = this.cacheSystem(req, system)
        ? [cachedTextBlock(system, this.cacheTtl)]
        : system;
    }

    return new InvokeModelWithResponseStreamCommand({
      modelId: req.model,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(payload),
    });
  }

  // The same request in Bedrock's own vocabulary, sent through `ConverseStream` (#178).
  //
  // Every field differs from the Anthropic body above, and three differences are worth
  // naming because they are where parity could quietly fail:
  //
  //   - A cache breakpoint is its OWN content block placed after the text it applies to,
  //     rather than a property of that text block. Same text, same boundary, different
  //     spelling — `cachePointBlock` keeps both spellings in promptCache.ts.
  //   - An image is raw bytes and a format name from Bedrock's enum, not base64 and a
  //     media type. So the wire is a third smaller for the same picture, while
  //     `GET /v1/limits` keeps publishing the base64 cap: that is the stricter number of
  //     the two, and a published limit that is tighter than the truth costs a caller a
  //     retry, where a looser one costs them a rejected request.
  //   - `max_tokens` moves into `inferenceConfig`, which is where a model-agnostic API
  //     has to put it — the ceiling is a fact about the request, not about Claude.
  private converseCommand(
    req: CompletionRequest,
    system: string,
    maxTokens: number,
  ): ConverseStreamCommand {
    const messages: ConverseMessage[] = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => {
        const prefix = this.cachedHead(req, m);
        const content: ContentBlock[] = [];
        if (prefix) {
          content.push({ text: prefix });
          content.push({ cachePoint: cachePointBlock(this.cacheTtl) });
        }
        const tail = prefix ? m.content.slice(prefix.length) : m.content;
        // Same rule as the Anthropic body: only when there is one. Converse rejects an
        // empty text block too, so a caller whose whole message is invariant must not be
        // sent a trailing empty one.
        if (tail) content.push({ text: tail });
        if (m.role === "user") {
          for (const img of req.images ?? []) {
            content.push({
              image: {
                format: converseImageFormat(img.media_type),
                source: { bytes: new Uint8Array(img.data) },
              },
            });
          }
        }
        return { role: m.role === "assistant" ? "assistant" : "user", content };
      });

    const systemBlocks: SystemContentBlock[] = [];
    if (system) {
      systemBlocks.push({ text: system });
      if (this.cacheSystem(req, system)) {
        systemBlocks.push({ cachePoint: cachePointBlock(this.cacheTtl) });
      }
    }

    return new ConverseStreamCommand({
      modelId: req.model,
      messages,
      // Omitted rather than sent empty when there is no system prompt: an empty list is
      // not the same request as no list, and the one this replaces sent no field at all.
      ...(systemBlocks.length ? { system: systemBlocks } : {}),
      inferenceConfig: { maxTokens },
    });
  }

  // Everything that is true of a Bedrock stream whichever API produced it: the two idle
  // clocks, the accumulation, and the two checks that refuse to return a partial document
  // as a whole one. Both paths share this so that a stall on one is diagnosed exactly as
  // it is on the other.
  private async stream(
    req: CompletionRequest,
    attempt: Attempt,
    send: (signal: AbortSignal) => Promise<{
      body?: AsyncIterable<object>;
      stream?: AsyncIterable<object>;
    }>,
    read: (event: object) => Reading,
  ): Promise<CompletionResult> {
    // Both clocks abort the same controller; `expired` records which one fired so
    // the failure can say so. Without it we would be back to "Request aborted".
    const controller = new AbortController();
    let expired: StallKind | null = null;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    // One timer, re-armed with whichever window currently applies: never producing
    // anything is a different failure from going quiet halfway through.
    const arm = (kind: "first_output" | "idle", ms: number): void => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        expired = kind;
        controller.abort();
      }, ms);
    };
    // The wait for whatever follows the stop event, which on ConverseStream is the
    // `metadata` event carrying every token count. Aborts the same controller and is
    // deliberately NOT a StallKind: the message is already complete by the time this is
    // armed, so running out of it ends the read rather than failing the call — which is
    // `sawStop` in the catch below, not a flag of its own, because every other way the
    // tail can go wrong is decided the same way.
    const armTrailing = (): void => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => controller.abort(), this.trailingTimeoutMs);
    };
    const totalTimer = setTimeout(() => {
      expired = "total";
      controller.abort();
    }, this.maxTotalMs);

    let text = "";
    let stopReason: string | undefined;
    let sawStop = false;
    // Merged field-by-field rather than replaced: on the Anthropic stream the two events
    // that carry usage each carry only their own half, so overwriting would discard the
    // prompt's counts the moment the output's arrived. Reported as it accumulates so a
    // call that later stalls or truncates still accounts for what it spent.
    let usage: Usage | undefined;
    const mergeUsage = (u?: Usage): void => {
      if (!u) return;
      // An upstream that has counted anything has billed for it, whether or not any text has
      // arrived yet — see Attempt.spent.
      attempt.spent = true;
      usage = { ...usage, ...u };
      req.onUsage?.(usage);
    };
    // Which window an event re-arms is decided by whether any text has arrived, not
    // by the event's own type. Protocol events (message_start, content_block_start)
    // are real progress and must keep the call alive, but they are not output, and
    // letting one of them hand over to the shorter window would quietly spend the
    // generous start-up budget before a single token existed.
    const progressed = (): void => {
      if (text) arm("idle", this.idleTimeoutMs);
      else arm("first_output", this.firstOutputTimeoutMs);
    };
    const stalled = (kind: StallKind): StalledStreamError =>
      new StalledStreamError({
        provider: this.name,
        model: req.model,
        kind,
        limitMs:
          kind === "first_output"
            ? this.firstOutputTimeoutMs
            : kind === "idle"
              ? this.idleTimeoutMs
              : this.maxTotalMs,
        chars: text.length,
      });

    // The clock starts before the request: time-to-first-token is exactly as much of
    // a stall risk as a gap mid-stream, and prompt processing happens in here too.
    arm("first_output", this.firstOutputTimeoutMs);
    try {
      const response = await send(controller.signal);
      // `InvokeModelWithResponseStream` calls it `body` and `ConverseStream` calls it
      // `stream`. Whichever the response carries is the events; carrying neither is the
      // failure this reports, and it is the same failure either way.
      const events = response.body ?? response.stream;
      if (!events) throw new Error("bedrock: response carried no event stream");
      for await (const event of events) {
        const reading = read(event);
        // An event shape this adapter does not know. Deliberately not counted as
        // progress — an unknown event repeating forever should trip the idle clock,
        // rather than defeat it.
        if (!reading) continue;
        if (reading.text) {
          text += reading.text;
          // Reported out as it arrives, for the same reason usage is: the caller decides
          // whether a failed call may be sent again, and "this attempt cost nothing" is a
          // fact only this loop holds.
          attempt.spent = true;
        }
        if (reading.stopReason) stopReason = reading.stopReason;
        mergeUsage(reading.usage);
        // Which clock the read runs on. Before the stop event, the silence windows,
        // re-armed after accumulating so `text` reflects this event when choosing between
        // them. A keepalive is skipped: letting it reset the clock would defeat the
        // timeout in the one case it exists for — a generation that hangs on a connection
        // that stays chatty would then run to the 15-minute backstop and report itself as
        // too large, which is the opposite diagnosis.
        //
        // The stop event hands the read over to the tail window ONCE and nothing re-arms
        // it after that, so the whole tail is bounded rather than each frame of it: those
        // windows have nothing left to protect (the document is in hand, and only the
        // accounting can still be arriving), and a tail that kept sending recognized
        // frames would otherwise run to the 15-minute backstop to deliver a page that was
        // already whole. Letting a post-stop frame re-arm the idle clock instead would be
        // worse still: a stream that sends `messageStop`, one more frame, then hangs would
        // spend a full minute and then discard a finished document.
        if (!sawStop) {
          if (reading.stopped) {
            sawStop = true;
            armTrailing();
          } else if (!reading.quiet) progressed();
        }
        // Nothing further this adapter reads. Stop rather than waiting for the upstream
        // to close the body: nothing today holds it open, but if anything did, a live
        // clock would fire on a response that is already whole. It also stops every
        // successful call from carrying a timer through the tail of the read.
        if (reading.done) break;
      }
    } catch (e) {
      // An abort surfaces from the SDK as an opaque AbortError. If one of our own clocks
      // fired, that is the real cause and it can be described precisely.
      //
      // Unless the message had already stopped, in which case nothing that goes wrong
      // afterwards is about the document: the text is whole and in hand, and what was
      // still arriving is only the accounting. So a tail that times out, errors, or hits
      // the total backstop ends the read rather than throwing away a finished document —
      // the call is then simply one that reported no usage, which diagnostics already
      // counts (`tokens.calls_reported`). Discarding a page over a token count would be
      // the worse trade in either direction.
      if (!sawStop) {
        if (expired) throw stalled(expired);
        throw e;
      }
    } finally {
      clearTimeout(stallTimer);
      clearTimeout(totalTimer);
    }

    // Reaching here means the iterator finished, which is not the same as the
    // response having finished. Two ways to arrive with a partial document and no
    // error to show for it: an abort whose stream ends by returning rather than
    // throwing, and an event stream that simply stops early. Both would otherwise
    // return HTML cut mid-tag as a successful result — the exact failure
    // TruncatedResponseError exists to prevent, arriving by a different road.
    //
    // `!sawStop` for the same reason as the catch above: a clock that fired in the tail
    // of a message that had already stopped took nothing from the document.
    if (expired && !sawStop) throw stalled(expired);
    if (!sawStop && !stopReason) {
      throw new Error(
        `bedrock: the response stream ended without completing (${text.length} chars received, ` +
          `no message_stop and no stop_reason). Treating a partial document as a whole one would ` +
          `deliver content the source never had.`,
      );
    }

    // A response cut off at the ceiling is NOT a valid result. Its HTML ends
    // mid-tag but still parses well enough to flow downstream and be assembled
    // into the deliverable, where it reads as genuine content loss. Fail loudly
    // instead: the SDK will not retry this (it is a 200), so the error surfaces to
    // the caller and is recorded as a failed model call in diagnostics.
    if (stopReason === "max_tokens") {
      // `attempt.maxTokens` and not `this.maxTokens`: on a model whose own ceiling is lower
      // than the deployment's, what this response hit is the model's, and an operator told
      // to raise a number the request never asked for would be chasing the wrong one. On
      // that model the standing advice is wrong too — the ceiling cannot be raised, because
      // the model refuses more — so the error says so rather than sending someone to edit a
      // setting that is already higher than the answer.
      throw new TruncatedResponseError(
        this.name,
        req.model,
        attempt.maxTokens,
        text.length,
        attempt.maxTokens < this.maxTokens
          ? `That ceiling is ${req.model}'s own, below the ${this.maxTokens} in ` +
              `providers.bedrock.max_tokens, so raising that setting will not move it: this ` +
              `model refuses a larger request outright. A document this long needs a model ` +
              `with a higher ceiling, or fewer pages per call.`
          : undefined,
      );
    }
    // Every other way of stopping short. The ceiling above is the one with a knob to
    // name; these need their own message because raising max_tokens fixes none of them,
    // and an operator told to raise it would be chasing the wrong number.
    //
    // `model_context_window_exceeded` is worded to say "context window" deliberately:
    // that is what `isRequestTooLargeError` matches (providers/types.ts), so the review
    // loop drops the page images and retries text-only — the same response it already
    // gives when Bedrock refuses an oversized request up front, which is the right one
    // here too, because prompt plus response is what overflowed.
    if (stopReason && !WHOLE_ANSWER_STOP_REASONS.has(stopReason)) {
      const detail =
        stopReason === "model_context_window_exceeded"
          ? `the prompt and the response together exceeded the model's context window`
          : `the model stopped for "${stopReason}"`;
      throw new Error(
        `bedrock: ${detail} on ${req.model}, so the response is incomplete ` +
          `(${text.length} chars received). Returning it would deliver a partial document as a ` +
          `whole one.`,
      );
    }
    return { text, model: req.model, provider: this.name, usage };
  }
}
