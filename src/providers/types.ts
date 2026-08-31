import type { Capability } from "../config.ts";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
  // The leading part of `content` that is byte-identical from call to call, declared so
  // an adapter can put a cache breakpoint after it (providers/promptCache.ts). Only
  // meaningful on a user message, and only worth setting where a caller genuinely sends
  // the same head repeatedly — the verify task re-states the whole contract of the agent
  // it is judging on every page of a document, which is the case this exists for.
  //
  // It is a PREFIX OF `content`, not a replacement for part of it: `content` stays the
  // complete message, so anything reading a Message sees exactly the text it saw before
  // this field existed, and an adapter that ignores the field sends exactly the same
  // request. An adapter that honours it splits `content` at the prefix and sends two
  // text blocks whose concatenation is the same string. A value that is not actually a
  // prefix of `content` is ignored rather than trusted, since acting on it would send a
  // prompt the caller did not write.
  cachedPrefix?: string;
}

export interface Image {
  // Raw bytes of the source image plus its media type (e.g. image/png).
  data: Buffer;
  media_type: string;
}

// What a call actually consumed. Named after Anthropic's fields because that is the
// vocabulary the models themselves report in; other adapters normalize onto it.
//
// Two things to know before adding these up. First, `input_tokens` EXCLUDES cached
// tokens — the whole prompt is input + cache_read + cache_creation, so summing only
// `input_tokens` on a cache-hitting deployment understates the prompt. Second, the
// four numbers bill at four different rates, so they are deliberately kept apart
// rather than folded into one total.
//
// Every field is optional because reporting is not guaranteed: an upstream may omit
// usage entirely, and a call that fails partway through knows its prompt size but
// never learns its output size. Absent means "not reported", not zero — see
// `tokens.calls_reported` in diagnostics, which exists so a partial sum cannot be
// mistaken for a complete one.
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// A fact an adapter learned while serving one call that only the CALLER can record. Same
// shape of problem as `onUsage`, and unreportable for the same reason a return value cannot
// carry it: it is learned mid-call, it is worth having whether the call then succeeds or
// throws, and the layer that knows the session and writes the run log is the router
// (providers/index.ts) — an adapter has no logger and should not grow one.
//
// A discriminated union with one member today. A union rather than a free-form string so the
// router's handling is a `switch` a new kind has to be added to, instead of an unknown fact
// silently becoming a log field nobody declared.
export type ProviderNote = {
  // This call ran below the output ceiling its deployment configured, because Bedrock refused
  // that ceiling for this model and stated a lower one (providers/bedrock.ts, issues #249
  // and #254).
  //
  // This is the run's only record that `providers.<provider>.max_tokens` is wrong for the
  // model it is pointed at. The retry is what makes the pages arrive, which also means the
  // config error has no consequence anyone downstream can see: without this the run log shows
  // one call where two requests were made, a duration covering both, and nothing about the
  // ceiling — a deployment can run for a month at a number nobody chose, with a dense page
  // truncating occasionally, and the log will say only that a page truncated.
  kind: "output_ceiling_clamped";
  model: string;
  // The ceiling that was asked for and the one that was granted. Both, because either alone is
  // unactionable: the pair is what says which way to move `max_tokens` and how far.
  asked: number;
  stated: number;
  // Whether THIS call is the one that learned it, by having a request refused and re-sent. The
  // condition and its cost are different facts and both are worth having: the condition holds
  // for every call to a clamped model, while the cost — a rejected round-trip inside one
  // `complete`, and a `duration_ms` covering two requests — is paid by the first call in a
  // process and by none after it.
  refused: boolean;
};

export interface CompletionRequest {
  capability: Capability;
  messages: Message[];
  images?: Image[];
  schema?: Record<string, unknown>; // JSON Schema for structured_output
  model: string; // resolved by the router from deployment config
  // Called by the adapter whenever the running token totals change, with the full
  // snapshot known so far (the latest call wins). A return value cannot serve here:
  // the prompt's size is known at the start of a stream and the output's only at the
  // end, so a call that stalls or truncates — exactly the expensive kind — would
  // report nothing at all if usage only rode the successful return path.
  onUsage?: (usage: Usage) => void;
  // Called for a fact worth recording that is neither usage nor an error — see ProviderNote.
  // Called once per occurrence, and deliberately NOT deduplicated the way the adapter's own
  // stderr warning is: Bedrock says the paragraph about a wrong ceiling once per process
  // (`warnedCeilings`), because five paragraphs about one config problem read as five problems,
  // but every call that runs at the clamped ceiling still owes the run log its own line.
  // Copying that dedup here would put the fact on one `model_call` per process and leave every
  // document after the first reading clean.
  onNote?: (note: ProviderNote) => void;
}

export interface CompletionResult {
  text: string;
  model: string;
  provider: string;
  // Absent when the upstream reported nothing.
  usage?: Usage;
}

// PRD §10.3 provider interface. An agent declares a capability; the
// deployment decides which provider serves it.
export interface ModelProvider {
  name: string;
  capabilities: Capability[];
  // Which wire format the calls go out on, for a provider that has more than one.
  // Only Bedrock does (`providers.bedrock.api`, an Anthropic-native body or Bedrock's
  // own Converse API), and it is here rather than private to that adapter because the
  // router puts it on the `model_call` log event: the point of that switch is comparing
  // two dialects against each other, and a comparison whose run log does not say which
  // side produced a number is not one. Undefined for a provider with a single API.
  dialect?: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

// A model stopped because it hit the output-token ceiling, not because it was
// finished. This is a 200 response carrying partial content, so nothing below the
// provider layer can tell it from a complete answer — a page of HTML truncated
// mid-tag still parses well enough to be assembled into the deliverable, where it
// reads as content the source never had. Both adapters raise this rather than
// return the fragment, so the failure is visible in diagnostics and to the caller.
export class TruncatedResponseError extends Error {
  readonly provider: string;
  readonly model: string;
  readonly maxTokens: number;
  readonly chars: number;
  // What the model DID emit before the ceiling cut it. Carried rather than dropped, because the
  // caller cannot ask again — the next round would put the same question to the same model — so
  // this is the only evidence that will ever exist about why the answer did not fit, and a round
  // that hits it has already been paid for in full (issue #277). Nothing acts on it: the review
  // loop logs a short excerpt for a person and treats the round as having produced nothing, which
  // is the whole point of raising instead of returning the fragment.
  //
  // The length is derived from it rather than passed alongside it, so `chars` — which the message
  // quotes and which `sectionRound` sizes the next request from — cannot disagree with the text it
  // describes.
  readonly text: string;

  // `note` is for the one case where "raise it" is the wrong instruction: a ceiling the
  // MODEL enforces, below the one the deployment asked for, cannot be raised at all
  // (providers/bedrock.ts, issue #249). Appended rather than replacing the sentence,
  // because `isTruncatedResponseError` matches the fixed part of it and the review loop
  // acts on that.
  constructor(provider: string, model: string, maxTokens: number, text: string, note?: string) {
    super(
      `${provider}: response hit the ${maxTokens}-token output ceiling and was truncated ` +
        `(${text.length} chars returned). Raise providers.${provider}.max_tokens.` +
        (note ? ` ${note}` : ""),
    );
    this.name = "TruncatedResponseError";
    this.provider = provider;
    this.model = model;
    this.maxTokens = maxTokens;
    this.chars = text.length;
    this.text = text;
  }
}

// The same fact as a predicate, and the one the review loop acts on: a round whose
// response hit the ceiling is a round that produced nothing, which costs the round rather
// than the document (pipeline/review.ts, issue #143).
//
// `instanceof` is the check, because unlike `isRequestTooLargeError` below this error is
// Iris's own — raised in two places, both in this repo, with a message written here. The
// message fallback is for an error that reached the caller having lost its prototype: a
// boundary that re-wraps what it caught, or a second copy of this module in one process.
// It matches the fixed part of that one sentence rather than a phrasing some upstream
// chose, so it cannot be tripped by a provider rewording anything.
export function isTruncatedResponseError(e: unknown): boolean {
  if (e instanceof TruncatedResponseError) return true;
  const message = e instanceof Error ? e.message : String(e);
  return message.includes("output ceiling and was truncated");
}

// A call the upstream REFUSED for size, before processing any of it: too much input
// for the model's context window, or too many bytes for the endpoint to accept at all.
// Both are the same fact to a caller — this request is too big — and the same remedy.
//
// Worth telling apart from every other failure because it is the one a caller can
// answer: the payload is Iris's own doing (page images, a whole document body), so
// dropping part of it and asking again is a real recovery, and the refusal is usually
// cheap — no prompt was read, so nothing was billed and it comes back in under a second.
//
// "Usually" because one member of this set is not a refusal at all: Bedrock's Converse
// API can report `model_context_window_exceeded` as a STOP REASON, after a full
// generation that was billed in both directions (providers/bedrock.ts). It is matched
// here on purpose — the remedy is identical, and it is the only one Iris has — but it
// means the `editor_images_refused` event this routes to can name a call that cost a
// round of output rather than nothing. The event carries the error message, which is
// what tells the two apart.
//
// Matched on the message, because neither adapter is given anything better. Bedrock
// raises a ValidationException whose message is "Input is too long for requested
// model." with no code distinguishing it from any other validation failure, and
// OpenRouter forwards a 400 body from whichever upstream served the request, worded
// differently again ("maximum context length is N tokens"). Both reach a caller as a
// plain Error carrying that text.
//
// The byte-size phrasings are not redundant with the token ones, and the count-based
// bound upstream does not cover them: MAX_EDITOR_IMAGES is derived from what a
// rasterized page costs in TOKENS, while the request ceiling these APIs enforce is in
// bytes. Screenshots rather than rendered PDF pages are the shape that gets there —
// at the per-image ceiling GET /v1/limits publishes, a dozen of them is tens of
// megabytes once base64-encoded, which is refused for size without ever being weighed
// in tokens.
//
// Deliberately a small set of phrasings rather than anything cleverer. The caller
// (pipeline/review.ts) reacts by retrying with a smaller payload, so a false positive
// costs one extra call that fails the same way, and a false negative is exactly the
// behaviour that existed before this function.
export function isRequestTooLargeError(e: unknown): boolean {
  const message = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    // Over the context window.
    message.includes("input is too long") ||
    message.includes("prompt is too long") ||
    message.includes("context length") ||
    message.includes("context window") ||
    // The Anthropic body's own wording for the same thing, which is what an `invoke`
    // deployment gets: "input length and `max_tokens` exceed context limit: 199000 + 32000 >
    // 200000, decrease input length or `max_tokens` and try again". Matched here for two
    // reasons. It IS a prompt-size refusal, so the image-drop recovery in pipeline/review.ts
    // is the right answer to it and had no way to reach it before. And because this predicate
    // is checked first, matching it also keeps `refusedForOutputCeiling`
    // (providers/bedrock.ts) from reading it as a refusal over the model's output ceiling: it
    // names `max_tokens` and a limit, which is otherwise exactly that shape, and the
    // resulting diagnosis would be "the model is not being asked to do work it cannot do"
    // about a prompt that does not fit.
    message.includes("context limit") ||
    message.includes("too many tokens") ||
    // Over the transport's or endpoint's size limit.
    message.includes("payload size") ||
    message.includes("too large") ||
    // A 413 with no reason phrase ("failed with status code 413"). The status word is
    // required rather than matching a bare 413, because a TruncatedResponseError's
    // message carries a character count and a model's max_tokens — either of which can
    // be that number, and retrying a truncation with fewer images fixes nothing.
    (/\b413\b/.test(message) && /status|http|code/.test(message))
  );
}

// A streamed call was abandoned. Three ways, because they are three different
// diagnoses and an operator reading one of these needs to know which: nothing ever
// arrived ("first_output"), output started and then stopped ("idle"), or output kept
// coming without the message ever finishing ("total").
//
// This type exists because the alternative is unreadable. Aborting a call makes the
// underlying client throw something opaque — the AWS SDK a bare
// `Error("Request aborted")`, fetch() a DOMException — which the orchestrator stores
// verbatim as the session's error and the UI shows to the user, naming neither the
// cause, the phase, nor anything to do about it. A slow document rewrite and a
// genuinely dead connection produced the identical string.
export type StallKind = "first_output" | "idle" | "total";

export class StalledStreamError extends Error {
  readonly provider: string;
  readonly model: string;
  readonly kind: StallKind;
  readonly limitMs: number;
  readonly chars: number;

  constructor(args: {
    provider: string;
    model: string;
    kind: StallKind;
    limitMs: number;
    chars: number;
  }) {
    const seconds = Math.round(args.limitMs / 1000);
    const streamed = args.chars
      ? `${args.chars} chars had streamed`
      : "nothing had streamed";
    let message: string;
    if (args.kind === "first_output") {
      message =
        `${args.provider}: no output arrived within ${seconds}s on ${args.model}, so the call ` +
        `was abandoned before it produced anything. The request was accepted and then went ` +
        `quiet — a queue that never cleared, or a model that never started.`;
    } else if (args.kind === "idle") {
      message =
        `${args.provider}: the model stopped sending output for ${seconds}s ` +
        `(${streamed}) on ${args.model}, so the call was abandoned. The connection ` +
        `stalled rather than the work being too slow — a healthy stream is never ` +
        `silent this long.`;
    } else {
      message =
        `${args.provider}: the call was still producing output after ${seconds}s ` +
        `(${streamed}) on ${args.model} without ever finishing its message, and hit the ` +
        `absolute ceiling. Nothing stalled — the work itself did not converge, which usually ` +
        `means the document is too large to correct in one call.`;
    }
    super(message);
    this.name = "StalledStreamError";
    this.provider = args.provider;
    this.model = args.model;
    this.kind = args.kind;
    this.limitMs = args.limitMs;
    this.chars = args.chars;
  }
}
