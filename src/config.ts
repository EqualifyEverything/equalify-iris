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
    client_id: string;        // GitHub App client ID for user-to-server OAuth flow
    client_secret: string;    // GitHub App client secret
    upstream_repo: string;
    // Overridable for GitHub Enterprise (and for testing). Defaults below.
    api_base_url: string; // e.g. https://api.github.com
    oauth_base_url: string; // e.g. https://github.com
    app_id?: string;          // GitHub App ID (optional, for future app-to-server auth)
    private_key?: string;     // GitHub App private key (optional, for future app-to-server auth)
    private_key_path?: string; // GitHub App private key file path (optional)
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

// Default GitHub App client_id for user-to-server OAuth flow (web redirect auth).
// This is Equalify's registered GitHub App. Non-secret; can be embedded.
// Override via config/env to point at your own app.
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
  // Fall back to the bundled GitHub App for user-to-server OAuth flow.
  parsed.github.client_id = parsed.github.client_id || DEFAULT_CLIENT_ID;
  // Load private key from file if path is provided.
  if (parsed.github.private_key_path && !parsed.github.private_key) {
    try {
      parsed.github.private_key = readFileSync(resolve(parsed.github.private_key_path), "utf8");
    } catch (e) {
      console.warn(`Failed to load GitHub App private key from ${parsed.github.private_key_path}:`, (e as Error).message);
    }
  }
  cached = parsed;
  return parsed;
}
