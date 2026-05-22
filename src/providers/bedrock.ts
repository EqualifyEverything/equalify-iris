import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { Capability, ProviderBlock } from "../config.ts";
import type { CompletionRequest, CompletionResult, ModelProvider } from "./types.ts";

// Amazon Bedrock adapter (PRD §10.3). Uses the Anthropic Messages format
// that Bedrock's Claude models accept. Credentials come from the standard
// AWS credential chain (env vars, shared profile, or IAM role).
export class BedrockProvider implements ModelProvider {
  name = "bedrock";
  capabilities: Capability[] = ["text", "vision", "structured_output"];

  private client: BedrockRuntimeClient;

  constructor(cfg: ProviderBlock) {
    this.client = new BedrockRuntimeClient({ region: cfg.region ?? "us-east-1" });
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
      max_tokens: 8192,
      messages,
    };
    if (system) payload.system = system;

    const command = new InvokeModelCommand({
      modelId: req.model,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(payload),
    });
    const response = await this.client.send(command);
    const decoded = JSON.parse(new TextDecoder().decode(response.body)) as {
      content: { type: string; text?: string }[];
    };
    const text = decoded.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    return { text, model: req.model, provider: this.name };
  }
}
