import type { Capability, IrisConfig, ProviderBlock } from "../config.ts";
import { BedrockProvider } from "./bedrock.ts";
import { OpenRouterProvider } from "./openrouter.ts";
import type { CompletionResult, Image, Message, ModelProvider } from "./types.ts";

export type { Image, Message, CompletionResult } from "./types.ts";

// The router maps (agent, capability) -> concrete provider + model using the
// deployment config (PRD §10.3). Providers are constructed lazily so a
// deployment only needs credentials for the providers it actually references.
export class ProviderRouter {
  private cfg: IrisConfig["providers"];
  private cache = new Map<string, ModelProvider>();

  constructor(cfg: IrisConfig) {
    this.cfg = cfg.providers;
  }

  private build(name: string): ModelProvider {
    const cached = this.cache.get(name);
    if (cached) return cached;
    const block = this.cfg[name] as ProviderBlock | undefined;
    if (!block) throw new Error(`provider "${name}" is referenced but not configured`);
    let provider: ModelProvider;
    switch (name) {
      case "openrouter":
        provider = new OpenRouterProvider(block);
        break;
      case "bedrock":
        provider = new BedrockProvider(block);
        break;
      default:
        throw new Error(`unknown provider "${name}"`);
    }
    this.cache.set(name, provider);
    return provider;
  }

  // Normalize a per_agent entry (string shorthand or object) to its parts.
  private agentOverride(agentName: string): { provider?: string; model?: string } {
    const entry = this.cfg.per_agent?.[agentName];
    if (entry == null) return {};
    return typeof entry === "string" ? { provider: entry } : entry;
  }

  // Resolve the provider name for an agent: per-agent override, else default.
  private providerNameFor(agentName: string): string {
    return this.agentOverride(agentName).provider ?? this.cfg.default;
  }

  // Resolve the concrete model with fallbacks: per-agent model override ->
  // provider's per_capability model -> provider's default_model.
  private modelFor(agentName: string, providerName: string, capability: Capability): string {
    const override = this.agentOverride(agentName).model;
    if (override) return override;
    const block = this.cfg[providerName] as ProviderBlock | undefined;
    if (!block) throw new Error(`provider "${providerName}" is not configured`);
    return block.per_capability?.[capability] ?? block.default_model;
  }

  // Run a completion for a given agent + capability. The agent declares the
  // capability; the deployment config decides the provider and concrete model.
  async complete(
    agentName: string,
    capability: Capability,
    messages: Message[],
    opts: { images?: Image[]; schema?: Record<string, unknown> } = {},
  ): Promise<CompletionResult> {
    const providerName = this.providerNameFor(agentName);
    const provider = this.build(providerName);
    const model = this.modelFor(agentName, providerName, capability);
    return provider.complete({ capability, messages, model, images: opts.images, schema: opts.schema });
  }
}
