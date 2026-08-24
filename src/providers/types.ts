import type { Capability } from "../config.ts";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
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

  constructor(provider: string, model: string, maxTokens: number, chars: number) {
    super(
      `${provider}: response hit the ${maxTokens}-token output ceiling and was truncated ` +
        `(${chars} chars returned). Raise providers.${provider}.max_tokens.`,
    );
    this.name = "TruncatedResponseError";
    this.provider = provider;
    this.model = model;
    this.maxTokens = maxTokens;
    this.chars = chars;
  }
}

// A call the upstream REFUSED for size: the request carried more input than the
// model's context window holds, so it was rejected before anything was processed.
//
// Worth telling apart from every other failure because it is the one a caller can
// answer: the payload is Iris's own doing (page images, a whole document body), so
// dropping part of it and asking again is a real recovery, and the refusal is cheap
// — no prompt was read, so nothing was billed and it comes back in under a second.
//
// Matched on the message, because neither adapter is given anything better. Bedrock
// raises a ValidationException whose message is "Input is too long for requested
// model." with no code distinguishing it from any other validation failure, and
// OpenRouter forwards a 400 body from whichever upstream served the request, worded
// differently again ("maximum context length is N tokens"). Both reach a caller as a
// plain Error carrying that text.
//
// Deliberately a small set of phrasings rather than anything cleverer. The caller
// (pipeline/review.ts) reacts by retrying with a smaller payload, so a false positive
// costs one extra call that fails the same way, and a false negative is exactly the
// behaviour that existed before this function.
export function isInputTooLongError(e: unknown): boolean {
  const message = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    message.includes("input is too long") ||
    message.includes("prompt is too long") ||
    message.includes("context length") ||
    message.includes("context window") ||
    message.includes("too many tokens")
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
