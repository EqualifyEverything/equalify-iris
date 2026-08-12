import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
  type ResponseStream,
} from "@aws-sdk/client-bedrock-runtime";
import { DEFAULT_MAX_TOKENS, type Capability, type ProviderBlock } from "../config.ts";
import { StalledStreamError, TruncatedResponseError } from "./types.ts";
import type { CompletionRequest, CompletionResult, ModelProvider } from "./types.ts";

// How long a call may send NOTHING before we give up on it.
//
// This is an IDLE timeout, not a total one, and the distinction is the whole reason
// this adapter streams. A single non-streaming InvokeModel gives you one datum —
// "the answer has not arrived yet" — which is equally true of a dead socket and of a
// large document being correctly rewritten. Capping total duration therefore kills
// both, and the review phase's document-level rewrite (whole body in, whole
// corrected body out, up to max_tokens) is slow enough to be the one that dies.
// Streaming separates the two cases: work in progress keeps arriving, a stall does
// not. A healthy stream is never silent for a minute.
const IDLE_TIMEOUT_MS = 60_000;

// Absolute backstop for a stream that never stalls but never ends either — a token
// every 30 seconds would satisfy the idle timeout forever while holding a
// concurrency slot and leaving the session "running". Deliberately generous: it is
// here to bound the pathological case, not to bound normal slow work.
const MAX_TOTAL_MS = 15 * 60_000;

// Anthropic's streaming event shapes, narrowed to the fields this adapter reads.
// Deltas other than text (e.g. input_json_delta) are ignored: structured output
// here is prompt-driven, not tool-driven, so text is the only content that arrives.
interface StreamEvent {
  type?: string;
  delta?: { type?: string; text?: string; stop_reason?: string };
  error?: { type?: string; message?: string };
}

// Bedrock delivers mid-stream service failures as events on an otherwise-200
// response, one modeled exception per union member. Surface whichever arrived.
function streamException(event: ResponseStream): string | null {
  const found =
    event.internalServerException ??
    event.modelStreamErrorException ??
    event.validationException ??
    event.throttlingException ??
    event.modelTimeoutException ??
    event.serviceUnavailableException;
  if (!found) return null;
  const name = Object.keys(event).find((k) => k !== "chunk") ?? "streamError";
  return `${name}: ${found.message ?? "no message"}`;
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

  private client: BedrockRuntimeClient;
  private maxTokens: number;
  private idleTimeoutMs: number;
  private maxTotalMs: number;

  // `timeouts` is a test seam: the defaults are what production runs, but a test
  // for stall handling cannot wait a minute to observe it.
  constructor(cfg: ProviderBlock, timeouts: { idleTimeoutMs?: number; maxTotalMs?: number } = {}) {
    this.client = new BedrockRuntimeClient({ region: cfg.region ?? "us-east-1" });
    // loadConfig normalizes this, but a directly-constructed provider (tests,
    // embedders) may pass a raw block — so fall back rather than send undefined.
    this.maxTokens = cfg.max_tokens ?? DEFAULT_MAX_TOKENS;
    this.idleTimeoutMs = timeouts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.maxTotalMs = timeouts.maxTotalMs ?? MAX_TOTAL_MS;
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

    const command = new InvokeModelWithResponseStreamCommand({
      modelId: req.model,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(payload),
    });

    // Both clocks abort the same controller; `expired` records which one fired so
    // the failure can say so. Without it we would be back to "Request aborted".
    const controller = new AbortController();
    let expired: "idle" | "total" | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        expired = "idle";
        controller.abort();
      }, this.idleTimeoutMs);
    };
    const totalTimer = setTimeout(() => {
      expired = "total";
      controller.abort();
    }, this.maxTotalMs);

    let text = "";
    let stopReason: string | undefined;
    // The idle clock starts before the request: time-to-first-token is exactly as
    // much of a stall risk as a gap mid-stream.
    resetIdle();
    try {
      const response = await this.client.send(command, { abortSignal: controller.signal });
      if (!response.body) throw new Error("bedrock: response carried no event stream");
      for await (const event of response.body) {
        resetIdle(); // any event is progress, including a keepalive ping
        const failure = streamException(event);
        if (failure) throw new Error(`bedrock: ${failure}`);
        const bytes = event.chunk?.bytes;
        if (!bytes) continue;
        const parsed = JSON.parse(new TextDecoder().decode(bytes)) as StreamEvent;
        if (parsed.type === "error") {
          throw new Error(`bedrock: stream error: ${parsed.error?.message ?? "no message"}`);
        }
        if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
          text += parsed.delta.text ?? "";
        }
        // stop_reason arrives once, on the message_delta that closes the message.
        if (parsed.delta?.stop_reason) stopReason = parsed.delta.stop_reason;
      }
    } catch (e) {
      // An abort surfaces from the SDK as an opaque AbortError. If one of our own
      // clocks fired, that is the real cause and it can be described precisely.
      if (expired) {
        throw new StalledStreamError({
          provider: this.name,
          model: req.model,
          kind: expired,
          limitMs: expired === "idle" ? this.idleTimeoutMs : this.maxTotalMs,
          chars: text.length,
        });
      }
      throw e;
    } finally {
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
    }

    // A response cut off at the ceiling is NOT a valid result. Its HTML ends
    // mid-tag but still parses well enough to flow downstream and be assembled
    // into the deliverable, where it reads as genuine content loss. Fail loudly
    // instead: the SDK will not retry this (it is a 200), so the error surfaces to
    // the caller and is recorded as a failed model call in diagnostics.
    if (stopReason === "max_tokens") {
      throw new TruncatedResponseError(this.name, req.model, this.maxTokens, text.length);
    }
    return { text, model: req.model, provider: this.name };
  }
}
