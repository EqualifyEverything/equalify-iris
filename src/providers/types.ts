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

export interface CompletionRequest {
  capability: Capability;
  messages: Message[];
  images?: Image[];
  schema?: Record<string, unknown>; // JSON Schema for structured_output
  model: string; // resolved by the router from deployment config
}

export interface CompletionResult {
  text: string;
  model: string;
  provider: string;
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

// A streamed call was abandoned: either it went quiet for longer than the idle
// timeout ("idle"), or it kept trickling past the absolute ceiling ("total").
//
// This type exists because the alternative is unreadable. Aborting an AWS SDK call
// makes the SDK throw a bare `Error("Request aborted")`, which the orchestrator
// stores verbatim as the session's error and the UI shows to the user — a message
// that names neither the cause, the phase, nor anything to do about it. A slow
// document rewrite and a genuinely dead connection produced the identical string.
export class StalledStreamError extends Error {
  readonly provider: string;
  readonly model: string;
  readonly kind: "idle" | "total";
  readonly limitMs: number;
  readonly chars: number;

  constructor(args: {
    provider: string;
    model: string;
    kind: "idle" | "total";
    limitMs: number;
    chars: number;
  }) {
    const seconds = Math.round(args.limitMs / 1000);
    const streamed = args.chars
      ? `${args.chars} chars had streamed`
      : "nothing had streamed";
    super(
      args.kind === "idle"
        ? `${args.provider}: the model stopped sending output for ${seconds}s ` +
            `(${streamed}) on ${args.model}, so the call was abandoned. The connection ` +
            `stalled rather than the work being too slow — a healthy stream is never ` +
            `silent this long.`
        : `${args.provider}: the call was still streaming after ${seconds}s ` +
            `(${streamed}) on ${args.model} and hit the absolute ceiling. The document ` +
            `is probably too large to correct in one call.`,
    );
    this.name = "StalledStreamError";
    this.provider = args.provider;
    this.model = args.model;
    this.kind = args.kind;
    this.limitMs = args.limitMs;
    this.chars = args.chars;
  }
}
