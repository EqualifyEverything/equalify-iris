import { DEFAULT_MAX_TOKENS, type Capability, type ProviderBlock } from "../config.ts";
import { StalledStreamError, TruncatedResponseError, type StallKind } from "./types.ts";
import type { CompletionRequest, CompletionResult, ModelProvider } from "./types.ts";

// This adapter streams for the same reason the Bedrock one does: a single
// non-streaming request cannot tell a stalled call from a slow one, so capping total
// duration kills both, and the review phase's document-level rewrite (whole body in,
// whole corrected body out) is the call slow enough to be killed. Streaming replaces
// that one cap with limits that describe what actually went wrong.
//
// How long the call may produce NOTHING before we give up. Deliberately the old
// total cap's value: 120s was never a bad bound on *getting started*, only on
// finishing. Unlike Bedrock, an OpenAI-style stream has no "generation began" event
// to lean on — before the first token the only thing on the wire is a keepalive
// comment, which must not count (see the line handler) — so the wait for first
// output gets its own, more generous window rather than sharing the idle one.
const FIRST_OUTPUT_TIMEOUT_MS = 120_000;
// Once output has started, silence this long means the stream died mid-generation.
const IDLE_TIMEOUT_MS = 60_000;
// Absolute backstop for a stream that never stalls and never ends: a token every
// 30s would satisfy the idle window forever while holding a concurrency slot.
const MAX_TOTAL_MS = 15 * 60_000;
// Bounded retry for transient failures (connection resets, timeouts, 429/5xx).
// Corporate proxies frequently reset large vision-request bodies mid-flight
// (ECONNRESET); a couple of retries clears those without failing the session.
const MAX_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Transient network errors worth retrying. fetch() surfaces the OS/undici code
// on `error.cause.code` (e.g. ECONNRESET) behind a generic "fetch failed".
function isTransientNetworkError(e: unknown): boolean {
  const err = e as
    | { code?: string; message?: string; name?: string; cause?: { code?: string } }
    | null
    | undefined;
  const code = err?.cause?.code ?? err?.code ?? "";
  const transient = new Set([
    "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EPIPE",
    "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  ]);
  if (code && transient.has(code)) return true;
  const msg = String(err?.message ?? "");
  return /fetch failed|terminated|socket hang up|network|ECONNRESET/i.test(msg);
}

// OpenRouter adapter (PRD §10.3). Speaks the OpenAI-compatible chat
// completions API that OpenRouter exposes, including image content parts.
export class OpenRouterProvider implements ModelProvider {
  name = "openrouter";
  capabilities: Capability[] = ["text", "vision", "structured_output"];

  private apiKey: string;
  private baseUrl: string;
  private maxTokens: number;
  private firstOutputTimeoutMs: number;
  private idleTimeoutMs: number;
  private maxTotalMs: number;

  // `timeouts` is a test seam: the defaults are what production runs, but a test for
  // stall handling cannot wait two minutes to observe it.
  constructor(
    cfg: ProviderBlock,
    timeouts: { firstOutputTimeoutMs?: number; idleTimeoutMs?: number; maxTotalMs?: number } = {},
  ) {
    if (!cfg.api_key) throw new Error("openrouter: api_key is not configured");
    this.apiKey = cfg.api_key;
    this.baseUrl = cfg.base_url ?? "https://openrouter.ai/api/v1";
    // loadConfig normalizes this, but a directly-constructed provider (tests,
    // embedders) may pass a raw block — so fall back rather than send undefined.
    this.maxTokens = cfg.max_tokens ?? DEFAULT_MAX_TOKENS;
    this.firstOutputTimeoutMs = timeouts.firstOutputTimeoutMs ?? FIRST_OUTPUT_TIMEOUT_MS;
    this.idleTimeoutMs = timeouts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.maxTotalMs = timeouts.maxTotalMs ?? MAX_TOTAL_MS;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const messages = req.messages.map((m) => {
      // Attach images to the final user message as OpenAI-style content parts.
      if (m.role === "user" && req.images?.length) {
        const parts: unknown[] = [{ type: "text", text: m.content }];
        for (const img of req.images) {
          const b64 = img.data.toString("base64");
          parts.push({
            type: "image_url",
            image_url: { url: `data:${img.media_type};base64,${b64}` },
          });
        }
        return { role: m.role, content: parts };
      }
      return { role: m.role, content: m.content };
    });

    // An explicit ceiling, matching Bedrock. Left unset, the limit is whatever
    // default the upstream model happens to apply — which differs per model and is
    // silent when reached, so the same document could truncate on one model and
    // not another with nothing in the config to explain it.
    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      max_tokens: this.maxTokens,
      stream: true,
    };
    if (req.capability === "structured_output" && req.schema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "output", schema: req.schema, strict: true },
      };
    }
    const payload = JSON.stringify(body);

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      let expired: StallKind | null = null;
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      // One timer, re-armed with whichever window currently applies: waiting for the
      // first output is a different failure from going quiet halfway through.
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

      // Per-attempt, not per-call: a retry has to start from an empty document, or
      // it would concatenate onto the abandoned attempt's partial output and deliver
      // the same passage twice.
      let text = "";
      let finishReason: string | undefined;
      let sawDone = false;
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

      // One SSE line. Returns nothing; accumulates into the closure above.
      const handleLine = (line: string): void => {
        if (!line) return;
        // A comment (`: OPENROUTER PROCESSING`) is the provider saying it is still
        // there, not the model producing anything. Counting it as progress would
        // defeat the idle window in the one case it exists for — a generation that
        // hangs behind a chatty connection — so it is skipped without re-arming.
        if (line.startsWith(":")) return;
        if (!line.startsWith("data:")) return;
        const data = line.slice("data:".length).trim();
        if (data === "[DONE]") {
          sawDone = true;
          return;
        }
        let parsed: {
          choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
          error?: { message?: string; code?: string | number };
        };
        try {
          parsed = JSON.parse(data);
        } catch {
          // Not skipped: a data line we cannot read is content we cannot account
          // for, and silently dropping it is how a short document passes for whole.
          throw new Error(`openrouter: unparseable stream event: ${data.slice(0, 200)}`);
        }
        // OpenRouter reports mid-stream failures as an event on an otherwise-200
        // response, so this is the only place such a failure is visible.
        if (parsed.error) {
          throw new Error(`openrouter: stream error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
        }
        // Any real event means generation is under way, so the idle window takes
        // over from the first-output one from here on.
        arm("idle", this.idleTimeoutMs);
        const choice = parsed.choices?.[0];
        if (choice?.delta?.content) text += choice.delta.content;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      };

      arm("first_output", this.firstOutputTimeoutMs);
      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: payload,
          signal: controller.signal,
        });
        if (!res.ok) {
          const errText = await res.text();
          // Retry rate limits and transient server errors; fail fast on 4xx
          // (bad key/model/request) where retrying cannot help.
          if ([429, 500, 502, 503, 504].includes(res.status) && attempt < MAX_ATTEMPTS) {
            lastError = new Error(`openrouter ${res.status}: ${errText}`);
            await sleep(400 * 2 ** (attempt - 1));
            continue;
          }
          throw new Error(`openrouter ${res.status}: ${errText}`);
        }
        if (!res.body) throw new Error("openrouter: response carried no body to stream");

        // SSE arrives in arbitrary byte chunks, so events are framed by newline
        // rather than by chunk boundary: a single read can split one event or carry
        // several. The decoder is given `stream: true` so a multi-byte character
        // straddling two reads is not mangled into a replacement char.
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(bytes, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            handleLine(line);
          }
        }
        handleLine(buffer.trim()); // a final event with no trailing newline

        // The stream ending is not the response ending. Without this, an abort that
        // closes the stream quietly, or a connection dropped between events, returns
        // a half-corrected document as a success — the same delivered failure
        // TruncatedResponseError exists to prevent, by a different road.
        if (expired) throw stalled(expired);
        if (!sawDone && !finishReason) {
          throw new Error(
            `openrouter: the response stream ended without completing (${text.length} chars ` +
              `received, no [DONE] and no finish_reason). Treating a partial document as a whole ` +
              `one would deliver content the source never had.`,
          );
        }

        // Same truncation guard as Bedrock: "length" means the model stopped at the
        // ceiling, not at the end of its answer. Thrown from inside the retry loop
        // deliberately — it is not transient, so isTransientNetworkError() rejects
        // it and the loop exits rather than re-billing the same truncation twice.
        if (finishReason === "length") {
          throw new TruncatedResponseError(this.name, req.model, this.maxTokens, text.length);
        }
        return { text, model: req.model, provider: this.name };
      } catch (e) {
        // Our own clock firing is a diagnosis, not a blip: never retried, and never
        // reported as the opaque abort the runtime actually threw.
        if (expired) throw stalled(expired);
        lastError = e;
        // Retry a transient failure only while nothing has been generated yet. This
        // is the case the retry was added for (a proxy resetting a large request
        // body, which happens before any output), and it keeps the loop from
        // re-billing a long generation that died three quarters of the way through.
        if (attempt < MAX_ATTEMPTS && !text && isTransientNetworkError(e)) {
          await sleep(400 * 2 ** (attempt - 1));
          continue;
        }
        throw e;
      } finally {
        clearTimeout(stallTimer);
        clearTimeout(totalTimer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
