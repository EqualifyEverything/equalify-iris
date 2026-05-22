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
