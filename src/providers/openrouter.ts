import type { Capability, ProviderBlock } from "../config.ts";
import type { CompletionRequest, CompletionResult, ModelProvider } from "./types.ts";

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

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
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
  }
}
