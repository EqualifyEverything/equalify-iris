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
import { StalledStreamError, TruncatedResponseError, type StallKind } from "./types.ts";
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

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const system = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    // Sent from inside the branch rather than after it, because the SDK's `send` is typed
    // per command: a union of two commands matches neither overload, and widening it to
    // make one call site work would be casting away the one check that says a Converse
    // request is being sent to the Converse API.
    if (this.dialect === "converse") {
      const command = this.converseCommand(req, system);
      return this.stream(req, (signal) => this.client.send(command, { abortSignal: signal }), readConverse);
    }
    const command = this.invokeCommand(req, system);
    return this.stream(req, (signal) => this.client.send(command, { abortSignal: signal }), readInvoke);
  }

  // The Anthropic Messages body, sent through `InvokeModelWithResponseStream`. What every
  // deployment runs, and the reference the `converse` path has to match.
  private invokeCommand(req: CompletionRequest, system: string): InvokeModelWithResponseStreamCommand {
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
      max_tokens: this.maxTokens,
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
  private converseCommand(req: CompletionRequest, system: string): ConverseStreamCommand {
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
      inferenceConfig: { maxTokens: this.maxTokens },
    });
  }

  // Everything that is true of a Bedrock stream whichever API produced it: the two idle
  // clocks, the accumulation, and the two checks that refuse to return a partial document
  // as a whole one. Both paths share this so that a stall on one is diagnosed exactly as
  // it is on the other.
  private async stream(
    req: CompletionRequest,
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
    // armed, so it ends the read rather than failing the call (see the catch below).
    let trailingCutoff = false;
    const armTrailing = (): void => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        trailingCutoff = true;
        controller.abort();
      }, this.trailingTimeoutMs);
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
        if (reading.text) text += reading.text;
        if (reading.stopReason) stopReason = reading.stopReason;
        mergeUsage(reading.usage);
        // Re-armed after accumulating, so `text` reflects this event when choosing the
        // window. A keepalive is skipped: letting it reset the clock would defeat the
        // timeout in the one case it exists for — a generation that hangs on a connection
        // that stays chatty would then run to the 15-minute backstop and report itself as
        // too large, which is the opposite diagnosis.
        if (!reading.quiet) progressed();
        // Once the upstream says the message is over, the silence clocks have nothing
        // left to protect: the document is in hand, and only the accounting can still
        // be arriving. So the wait for it gets its own short window, and running out of
        // it returns the response rather than failing the call — a connection that sends
        // messageStop and then hangs would otherwise spend 60 seconds and then throw
        // away a complete document, which is the failure this window exists to avoid,
        // not one to accept for the sake of a token count.
        if (reading.stopped) {
          sawStop = true;
          armTrailing();
        }
        // Nothing further this adapter reads. Stop rather than waiting for the upstream
        // to close the body: nothing today holds it open, but if anything did, a live
        // clock would fire on a response that is already whole. It also stops every
        // successful call from carrying a timer through the tail of the read.
        if (reading.done) break;
      }
    } catch (e) {
      // An abort surfaces from the SDK as an opaque AbortError. If one of our own
      // clocks fired, that is the real cause and it can be described precisely — except
      // the trailing one, which is not a failure: the message had already stopped, so the
      // only thing lost is the usage block, and an unreported call is something
      // diagnostics already counts (`tokens.calls_reported`).
      if (!trailingCutoff) {
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
    if (expired) throw stalled(expired);
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
      throw new TruncatedResponseError(this.name, req.model, this.maxTokens, text.length);
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
