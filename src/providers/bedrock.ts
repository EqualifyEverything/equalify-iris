import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
  type ResponseStream,
} from "@aws-sdk/client-bedrock-runtime";
import { DEFAULT_MAX_TOKENS, type Capability, type ProviderBlock } from "../config.ts";
import { StalledStreamError, TruncatedResponseError, type StallKind } from "./types.ts";
import type { CompletionRequest, CompletionResult, ModelProvider } from "./types.ts";

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
  private firstOutputTimeoutMs: number;
  private idleTimeoutMs: number;
  private maxTotalMs: number;

  // `timeouts` is a test seam: the defaults are what production runs, but a test
  // for stall handling cannot wait a minute to observe it.
  constructor(
    cfg: ProviderBlock,
    timeouts: { firstOutputTimeoutMs?: number; idleTimeoutMs?: number; maxTotalMs?: number } = {},
  ) {
    this.client = new BedrockRuntimeClient({ region: cfg.region ?? "us-east-1" });
    // loadConfig normalizes this, but a directly-constructed provider (tests,
    // embedders) may pass a raw block — so fall back rather than send undefined.
    this.maxTokens = cfg.max_tokens ?? DEFAULT_MAX_TOKENS;
    this.firstOutputTimeoutMs = timeouts.firstOutputTimeoutMs ?? FIRST_OUTPUT_TIMEOUT_MS;
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
    const totalTimer = setTimeout(() => {
      expired = "total";
      controller.abort();
    }, this.maxTotalMs);

    let text = "";
    let stopReason: string | undefined;
    let sawStop = false;
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
      const response = await this.client.send(command, { abortSignal: controller.signal });
      if (!response.body) throw new Error("bedrock: response carried no event stream");
      for await (const event of response.body) {
        const failure = streamException(event);
        if (failure) throw new Error(`bedrock: ${failure}`);
        const bytes = event.chunk?.bytes;
        // Not a chunk and not a modeled failure: an event shape this adapter does
        // not know. Deliberately not counted as progress — an unknown event
        // repeating forever should trip the idle clock, not defeat it.
        if (!bytes) continue;
        const parsed = JSON.parse(new TextDecoder().decode(bytes)) as StreamEvent;
        if (parsed.type === "error") {
          throw new Error(`bedrock: stream error: ${parsed.error?.message ?? "no message"}`);
        }
        // A keepalive is the transport saying it is alive; it is not the model
        // producing anything. Letting it reset the clock would defeat the timeout
        // in the one case it exists for — a generation that hangs on a connection
        // that stays chatty would then run to the 15-minute backstop and report
        // itself as too large, which is the opposite diagnosis. Every other event
        // (message_start, content_block_start, the deltas) is real protocol
        // progress and keeps the call alive.
        if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
          text += parsed.delta.text ?? "";
        }
        // stop_reason arrives once, on the message_delta that closes the message.
        if (parsed.delta?.stop_reason) stopReason = parsed.delta.stop_reason;
        // Re-armed after accumulating, so `text` reflects this event when choosing
        // the window.
        if (parsed.type !== "ping") progressed();
        // The message is over, so stop reading rather than waiting for the upstream
        // to close the body. Nothing today holds it open past message_stop, but if
        // anything did, the idle clock would fire on a response that is already
        // whole and the completeness check below would discard a finished document
        // as a stall. It also stops every successful call from carrying a live
        // 60-second timer through the tail of the read.
        if (parsed.type === "message_stop") {
          sawStop = true;
          break;
        }
      }
    } catch (e) {
      // An abort surfaces from the SDK as an opaque AbortError. If one of our own
      // clocks fired, that is the real cause and it can be described precisely.
      if (expired) throw stalled(expired);
      throw e;
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
    return { text, model: req.model, provider: this.name };
  }
}
