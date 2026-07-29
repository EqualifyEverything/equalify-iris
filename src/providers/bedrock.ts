import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { DEFAULT_MAX_TOKENS, type Capability, type ProviderBlock } from "../config.ts";
import { TruncatedResponseError } from "./types.ts";
import type { CompletionRequest, CompletionResult, ModelProvider } from "./types.ts";

// Fail a model call that stalls beyond this so it can't hang a session forever.
const REQUEST_TIMEOUT_MS = 120_000;

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
export class BedrockProvider implements ModelProvider {
  name = "bedrock";
  capabilities: Capability[] = ["text", "vision", "structured_output"];

  private client: BedrockRuntimeClient;
  private maxTokens: number;

  constructor(cfg: ProviderBlock) {
    this.client = new BedrockRuntimeClient({ region: cfg.region ?? "us-east-1" });
    // loadConfig normalizes this, but a directly-constructed provider (tests,
    // embedders) may pass a raw block — so fall back rather than send undefined.
    this.maxTokens = cfg.max_tokens ?? DEFAULT_MAX_TOKENS;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const system = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");

    const messages = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => {
        if (m.role === "user" && req.images?.length) {
          const content: unknown[] = [{ type: "text", text: m.content }];
          for (const img of req.images) {
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
    if (system) payload.system = system;

    const command = new InvokeModelCommand({
      modelId: req.model,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(payload),
    });
    // Abort a stalled call so it fails fast instead of hanging forever (the SDK
    // has no default request timeout). Without this a stuck call strands the
    // whole session in "running".
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await this.client.send(command, { abortSignal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const decoded = JSON.parse(new TextDecoder().decode(response.body)) as {
      content: { type: string; text?: string }[];
      stop_reason?: string;
    };
    const text = decoded.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    // A response cut off at the ceiling is NOT a valid result. Its HTML ends
    // mid-tag but still parses well enough to flow downstream and be assembled
    // into the deliverable, where it reads as genuine content loss. Fail loudly
    // instead: the SDK will not retry this (it is a 200), so the error surfaces to
    // the caller and is recorded as a failed model call in diagnostics.
    if (decoded.stop_reason === "max_tokens") {
      throw new TruncatedResponseError(this.name, req.model, this.maxTokens, text.length);
    }
    return { text, model: req.model, provider: this.name };
  }
}
