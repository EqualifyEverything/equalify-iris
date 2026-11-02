import { DEFAULT_MAX_TOKENS, type Capability, type ProviderBlock } from "../config.ts";
import { StalledStreamError, TruncatedResponseError, type StallKind } from "./types.ts";
import type { CompletionRequest, CompletionResult, ModelProvider, Usage } from "./types.ts";
import { normalizeUsage } from "./openrouter.ts";

const FIRST_OUTPUT_TIMEOUT_MS = 240_000;
const IDLE_TIMEOUT_MS = 60_000;
const MAX_TOTAL_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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

function addUsage(a?: Usage, b?: Usage): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  const sum: Usage = { ...a };
  for (const key of Object.keys(b) as (keyof Usage)[]) {
    const v = b[key];
    if (v == null) continue;
    sum[key] = (sum[key] ?? 0) + v;
  }
  return sum;
}

/**
 * Google Gemini Model Provider.
 * Communicates with Google's Gemini API via OpenAI-compatible endpoints or Google endpoints.
 */
export class GeminiProvider implements ModelProvider {
  name = "gemini";
  capabilities: Capability[] = ["text", "vision", "structured_output"];

  private apiKey: string;
  private baseUrl: string;
  private maxTokens: number;
  private firstOutputTimeoutMs: number;
  private idleTimeoutMs: number;
  private maxTotalMs: number;

  constructor(
    cfg: ProviderBlock,
    timeouts: { firstOutputTimeoutMs?: number; idleTimeoutMs?: number; maxTotalMs?: number } = {},
  ) {
    const apiKey = cfg.api_key || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("gemini: api_key is not configured (set GOOGLE_API_KEY or GEMINI_API_KEY)");
    }
    this.apiKey = apiKey;
    this.baseUrl = (cfg.base_url ?? "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/$/, "");
    this.maxTokens = cfg.max_tokens ?? DEFAULT_MAX_TOKENS;
    this.firstOutputTimeoutMs = timeouts.firstOutputTimeoutMs ?? FIRST_OUTPUT_TIMEOUT_MS;
    this.idleTimeoutMs = timeouts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.maxTotalMs = timeouts.maxTotalMs ?? MAX_TOTAL_MS;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const messages = req.messages.map((m) => {
      // Attach images to user messages as content parts
      if (m.role === "user" && req.images?.length) {
        const parts: unknown[] = [];
        if (m.content) parts.push({ type: "text", text: m.content });
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

    const maxTokens = Math.min(this.maxTokens, req.maxOutputTokens ?? Infinity);
    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      max_tokens: maxTokens,
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
    let spent: Usage | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      let expired: StallKind | null = null;
      let stallTimer: ReturnType<typeof setTimeout> | undefined;

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
      let finishReason: string | undefined;
      let sawDone = false;
      let usage: Usage | undefined;

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

      const handleLine = (line: string): void => {
        if (!line) return;
        if (line.startsWith(":")) return; // SSE comment
        if (!line.startsWith("data:")) return;
        const data = line.slice("data:".length).trim();
        if (data === "[DONE]") {
          sawDone = true;
          return;
        }

        let parsed: {
          choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
          error?: { message?: string; code?: string | number };
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
          };
        };

        try {
          parsed = JSON.parse(data);
        } catch {
          throw new Error(`gemini: unparseable stream event: ${data.slice(0, 200)}`);
        }

        if (parsed.error) {
          throw new Error(`gemini: stream error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
        }

        const reported = normalizeUsage(parsed.usage);
        if (reported) {
          usage = { ...usage, ...reported };
          const total = addUsage(spent, usage);
          if (total) req.onUsage?.(total);
        }

        const choice = parsed.choices?.[0];
        if (choice?.delta?.content) text += choice.delta.content;
        if (choice?.finish_reason) finishReason = choice.finish_reason;

        if (text) arm("idle", this.idleTimeoutMs);
        else arm("first_output", this.firstOutputTimeoutMs);
      };

      arm("first_output", this.firstOutputTimeoutMs);

      try {
        const url = this.baseUrl.endsWith("/chat/completions")
          ? this.baseUrl
          : `${this.baseUrl}/chat/completions`;

        const res = await fetch(url, {
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
          if ([429, 500, 502, 503, 504].includes(res.status)) {
            const isQuotaExhausted = /quota|RESOURCE_EXHAUSTED/i.test(errText);
            if (isQuotaExhausted) {
              throw new Error(`gemini ${res.status}: ${errText}`);
            }
            if (attempt < MAX_ATTEMPTS) {
              lastError = new Error(`gemini ${res.status}: ${errText}`);
              let waitMs = 1000 * 2 ** (attempt - 1);
              if (res.status === 429) {
                const match = /retry in ([\d.]+)s/i.exec(errText);
                if (match) {
                  waitMs = Math.ceil(parseFloat(match[1]) * 1000) + 1000;
                } else {
                  const header = res.headers?.get?.("retry-after");
                  if (header) {
                    const sec = parseFloat(header);
                    if (Number.isFinite(sec)) waitMs = Math.ceil(sec * 1000) + 1000;
                  } else {
                    waitMs = 15_000 * attempt;
                  }
                }
              }
              await sleep(waitMs);
              continue;
            }
          }
          throw new Error(`gemini ${res.status}: ${errText}`);
        }

        if (!res.body) throw new Error("gemini: response carried no body to stream");

        const decoder = new TextDecoder();
        let buffer = "";

        read: for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(bytes, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            handleLine(line);
            if (sawDone) break read;
          }
        }

        if (!sawDone) handleLine(buffer.trim());

        if (expired) throw stalled(expired);
        if (!sawDone && !finishReason) {
          throw new Error(
            `gemini: the response stream ended without completing (${text.length} chars ` +
              `received, no [DONE] and no finish_reason). Treating a partial document as a whole ` +
              `one would deliver content the source never had.`,
          );
        }

        if (finishReason === "length") {
          throw new TruncatedResponseError(
            this.name,
            req.model,
            maxTokens,
            text,
            maxTokens < this.maxTokens
              ? `That ceiling is this call's own: it asked for at most ${maxTokens} output ` +
                  `tokens, below the ${this.maxTokens} in providers.gemini.max_tokens, so ` +
                  `raising that setting will not move it.`
              : undefined,
          );
        }

        return { text, model: req.model, provider: this.name, usage: addUsage(spent, usage) };
      } catch (e) {
        spent = addUsage(spent, usage);
        if (expired) throw stalled(expired);
        lastError = e;
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
