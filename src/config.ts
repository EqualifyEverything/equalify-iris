import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

export type Capability = "text" | "vision" | "structured_output";

export interface ProviderBlock {
  api_key?: string;
  base_url?: string;
  region?: string;
  default_model: string;
  per_capability?: Partial<Record<Capability, string>>;
}

export interface IrisConfig {
  server: { port: number; base_url: string };
  storage: { data_dir: string; agents_dir: string; database: string };
  github: {
    client_id: string;
    client_secret: string;
    upstream_repo: string;
    // Overridable for GitHub Enterprise (and for testing). Defaults below.
    api_base_url: string; // e.g. https://api.github.com
    oauth_base_url: string; // e.g. https://github.com
    // Service token (PAT) used to auto-file agent-suggestion issues on the
    // upstream repo. When empty, issue filing is disabled (safe no-op).
    issue_token?: string;
  };
  providers: {
    default: string;
    // Per-agent override. A string is shorthand for a provider name (model then
    // comes from that provider's per_capability/default_model). The object form
    // also allows pinning a specific model for that agent.
    per_agent?: Record<string, string | { provider?: string; model?: string }>;
    openrouter?: ProviderBlock;
    bedrock?: ProviderBlock;
    [key: string]: unknown;
  };
  defaults: { max_review_iterations: number };
}

// Recursively expand ${ENV_VAR} references against process.env.
function expandEnv(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => process.env[name] ?? "");
  }
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandEnv(v);
    return out;
  }
  return value;
}

// Bundled OAuth App client_id for the device flow (PRD §9.1). This is the
// single place to embed Equalify's registered "Equalify Iris" OAuth App so the
// default deployment needs no per-operator app setup — the same pattern the
// GitHub CLI uses. The client_id is NOT a secret (it is sent openly in every
// OAuth flow); the client secret is never bundled and is only needed for the
// web redirect flow. A deployment can override this via config/env.
//
// Equalify's "Equalify Iris" OAuth App client_id. Non-secret; ships embedded so
// the default device-flow deployment needs no per-operator app setup. Override
// via config/env to point at your own app.
const DEFAULT_CLIENT_ID = "Ov23liGG4MfEn0DM4vTA";

let cached: IrisConfig | null = null;

export function loadConfig(path = process.env.IRIS_CONFIG ?? "config.yaml"): IrisConfig {
  if (cached) return cached;
  const raw = readFileSync(resolve(path), "utf8");
  const parsed = expandEnv(parse(raw)) as IrisConfig;
  // Resolve filesystem paths to absolutes so the service is CWD-independent.
  parsed.storage.data_dir = resolve(parsed.storage.data_dir);
  parsed.storage.agents_dir = resolve(parsed.storage.agents_dir);
  parsed.storage.database = resolve(parsed.storage.database);
  // GitHub host defaults (overridable for GitHub Enterprise / testing).
  parsed.github.api_base_url = parsed.github.api_base_url || "https://api.github.com";
  parsed.github.oauth_base_url = parsed.github.oauth_base_url || "https://github.com";
  // Fall back to the bundled OAuth App so the default device-flow deployment
  // works with no per-operator app setup (PRD §9.1).
  parsed.github.client_id = parsed.github.client_id || DEFAULT_CLIENT_ID;
  cached = parsed;
  return parsed;
}
