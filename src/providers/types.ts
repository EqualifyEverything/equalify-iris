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
