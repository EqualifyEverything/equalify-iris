import type { Capability, IrisConfig, ProviderBlock } from "../config.ts";
import { BedrockProvider } from "./bedrock.ts";
import { OpenRouterProvider } from "./openrouter.ts";
import type { CompletionResult, Image, Message, ModelProvider, ProviderNote, Usage } from "./types.ts";

export type { Image, Message, CompletionResult, ProviderNote, Usage } from "./types.ts";

// The router maps (agent, capability) -> concrete provider + model using the
// deployment config (PRD §10.3). Providers are constructed lazily so a
// deployment only needs credentials for the providers it actually references.
export type TelemetryFn = (type: string, data: Record<string, unknown>) => void;

// Normalize a per_agent entry (string shorthand or object) to its parts.
function agentOverride(cfg: IrisConfig["providers"], agentName: string): { provider?: string; model?: string } {
  const entry = cfg.per_agent?.[agentName];
  if (entry == null) return {};
  return typeof entry === "string" ? { provider: entry } : entry;
}

// Which provider and concrete model an (agent, capability) pair resolves to, with
// the documented fallbacks: per-agent provider override -> `providers.default`, and
// per-agent model override -> the provider's per_capability model -> its
// default_model.
//
// A free function rather than only a ProviderRouter method because it has a second
// caller that must not disagree with the first: providers/imageLimits.ts publishes
// the input limits of the vision model in use, and a resolution rule copied there
// would drift from the one that picks the model actually called. Nothing else should
// re-derive this.
export function resolveAgentModel(
  cfg: IrisConfig["providers"],
  agentName: string,
  capability: Capability,
): { provider: string; model: string } {
  const override = agentOverride(cfg, agentName);
  const provider = override.provider ?? cfg.default;
  if (override.model) return { provider, model: override.model };
  const block = cfg[provider] as ProviderBlock | undefined;
  if (!block) throw new Error(`provider "${provider}" is not configured`);
  return { provider, model: block.per_capability?.[capability] ?? block.default_model };
}

export class ProviderRouter {
  private cfg: IrisConfig["providers"];
  private cache = new Map<string, ModelProvider>();
  private onEvent?: TelemetryFn;

  constructor(cfg: IrisConfig, onEvent?: TelemetryFn) {
    this.cfg = cfg.providers;
    this.onEvent = onEvent;
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

  // Run a completion for a given agent + capability. The agent declares the
  // capability; the deployment config decides the provider and concrete model.
  async complete(
    agentName: string,
    capability: Capability,
    messages: Message[],
    opts: { images?: Image[]; schema?: Record<string, unknown> } = {},
  ): Promise<CompletionResult> {
    const { provider: providerName, model } = resolveAgentModel(this.cfg, agentName, capability);
    const provider = this.build(providerName);

    // Emit a start marker BEFORE the call so a hung/in-flight call is visible
    // in diagnostics (a start with no matching end), and time the call.
    // `api` only when the adapter has more than one (Bedrock: invoke vs converse), so
    // every other provider's log line is unchanged and a bench round on the new dialect
    // says so on every call rather than only in the config that started it.
    const meta = {
      agent: agentName,
      capability,
      model,
      provider: providerName,
      ...(provider.dialect ? { api: provider.dialect } : {}),
    };
    this.onEvent?.("model_call_start", meta);
    const startedAt = Date.now();
    // Collected through the callback rather than read off the result, so a call that
    // throws still reports what it spent. The expensive failures are precisely the
    // ones worth accounting for: a truncation has already paid for a full ceiling of
    // output, and a stall has already paid for a prompt carrying page images.
    let usage: Usage | undefined;
    const onUsage = (u: Usage): void => {
      usage = u;
    };
    // Facts an adapter learned that nothing else can carry: today, a Bedrock model refusing the
    // deployment's output ceiling and stating its own, which costs a rejected round-trip inside
    // one `complete` and is otherwise invisible here (#254). A `switch` rather than a spread of
    // whatever arrives, so a second kind of note has to be given a shape on this line
    // deliberately instead of becoming a field nobody declared.
    //
    // The WIDEST span rather than the last note: a call refused twice reports the ceiling it
    // started at and the one it ended at, which is the pair that says what `max_tokens` should
    // have been. Keeping only the latest would name a number the deployment never asked for.
    // `refused` is an OR for the same reason — it says this call paid a rejected round-trip,
    // and one of two notes carrying it is enough to have paid for it.
    let clamped: { asked: number; stated: number; refused: boolean } | undefined;
    const onNote = (note: ProviderNote): void => {
      switch (note.kind) {
        case "output_ceiling_clamped":
          clamped = {
            asked: Math.max(clamped?.asked ?? note.asked, note.asked),
            stated: Math.min(clamped?.stated ?? note.stated, note.stated),
            refused: (clamped?.refused ?? false) || note.refused,
          };
          break;
      }
    };
    // Flat, and read at event time rather than at call time, for the same two reasons as usage:
    // the run log stays one level deep, and a call that ends by throwing has still learned this.
    //
    // `output_ceiling_refused` is present only when true, like `output_ceiling_clamped`: the
    // fields exist to be grepped for, and a `false` on every clamped line is one more thing to
    // read past. Absent means the call ran at the lower ceiling without paying to discover it.
    const ceiling = (): Record<string, number | boolean> =>
      clamped
        ? {
            output_ceiling_clamped: true,
            output_ceiling_asked: clamped.asked,
            output_ceiling_stated: clamped.stated,
            ...(clamped.refused ? { output_ceiling_refused: true } : {}),
          }
        : {};
    // Spread flat onto the event, alongside duration_ms, so the run log stays one
    // level deep and `tokens` in diagnostics can be summed straight off it.
    try {
      const result = await provider.complete({
        capability,
        messages,
        model,
        images: opts.images,
        schema: opts.schema,
        onUsage,
        onNote,
      });
      this.onEvent?.("model_call", {
        ...meta,
        duration_ms: Date.now() - startedAt,
        ok: true,
        ...(result.usage ?? usage ?? {}),
        ...ceiling(),
      });
      return result;
    } catch (e) {
      this.onEvent?.("model_call", {
        ...meta,
        duration_ms: Date.now() - startedAt,
        ok: false,
        error: (e as Error).message,
        ...(usage ?? {}),
        ...ceiling(),
      });
      throw e;
    }
  }
}
