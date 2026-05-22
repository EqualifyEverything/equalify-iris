import type { Capability, ProviderBlock } from "../config.ts";
import type { CompletionRequest, CompletionResult, ModelProvider } from "./types.ts";

// Fail a model call that stalls beyond this so it can't hang a session forever.
const REQUEST_TIMEOUT_MS = 120_000;
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

  constructor(cfg: ProviderBlock) {
    if (!cfg.api_key) throw new Error("openrouter: api_key is not configured");
    this.apiKey = cfg.api_key;
    this.baseUrl = cfg.base_url ?? "https://openrouter.ai/api/v1";
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

    const body: Record<string, unknown> = { model: req.model, messages };
    if (req.capability === "structured_output" && req.schema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "output", schema: req.schema, strict: true },
      };
    }
    const payload = JSON.stringify(body);

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Abort a stalled call so it fails fast instead of hanging the session.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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
          const text = await res.text();
          // Retry rate limits and transient server errors; fail fast on 4xx
          // (bad key/model/request) where retrying cannot help.
          if ([429, 500, 502, 503, 504].includes(res.status) && attempt < MAX_ATTEMPTS) {
            lastError = new Error(`openrouter ${res.status}: ${text}`);
            await sleep(400 * 2 ** (attempt - 1));
            continue;
          }
          throw new Error(`openrouter ${res.status}: ${text}`);
        }
        const json = (await res.json()) as {
          choices: { message: { content: string } }[];
        };
        return {
          text: json.choices[0]?.message?.content ?? "",
          model: req.model,
          provider: this.name,
        };
      } catch (e) {
        lastError = e;
        if (attempt < MAX_ATTEMPTS && isTransientNetworkError(e)) {
          await sleep(400 * 2 ** (attempt - 1));
          continue;
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
