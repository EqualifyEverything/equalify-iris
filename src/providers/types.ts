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
