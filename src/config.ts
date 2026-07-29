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
  defaults: {
    max_review_iterations: number;
    // How many pages to extract in parallel within one run. Pages are
    // independent (one vision call each), so this is a pure speed knob; it is
    // capped to keep a burst of concurrent calls from tripping provider rate
    // limits. Normalized by loadConfig, so it is always a valid integer.
    extraction_concurrency: number;
  };
}

// Pages extracted in parallel when the deployment doesn't say. Modest on
// purpose: the Bedrock adapter has no retry yet, so a rate-limit burst there
// fails a run rather than backing off.
export const DEFAULT_EXTRACTION_CONCURRENCY = 5;
// Upper bound. Past this, added parallelism buys little (provider-side rate
// limits dominate) and each in-flight call holds a base64 page image in memory.
export const MAX_EXTRACTION_CONCURRENCY = 16;

// Recursively expand ${ENV_VAR} references against process.env, recording which
// variables resolved to nothing. An unset variable still expands to "" (a config
// may legitimately reference a provider it doesn't use), but the names are kept
// so validateConfig can name the likely cause of an empty required field.
function expandEnv(value: unknown, unset: Set<string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
      const found = process.env[name];
      if (found === undefined || found === "") {
        unset.add(name);
        return "";
      }
      return found;
    });
  }
  if (Array.isArray(value)) return value.map((v) => expandEnv(v, unset));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandEnv(v, unset);
    return out;
  }
  return value;
}

// Fail at startup on config that cannot work, instead of surfacing it as a
// confusing mid-pipeline error (an unset ${OPENROUTER_API_KEY} used to expand to
// "" and reappear later as a 401 partway through a run).
//
// Only providers this deployment can actually reach are checked — `default` plus
// anything named in `per_agent` — so a config that carries an unused second
// provider block stays valid without its credentials.
function validateConfig(cfg: IrisConfig, unset: Set<string>, path: string): void {
  const problems: string[] = [];

  if (!cfg.providers?.default) problems.push("providers.default is not set");

  const referenced = new Set<string>([cfg.providers.default]);
  for (const entry of Object.values(cfg.providers.per_agent ?? {})) {
    const name = typeof entry === "string" ? entry : entry?.provider;
    if (name) referenced.add(name);
  }

  for (const name of referenced) {
    if (!name) continue;
    const block = cfg.providers[name] as ProviderBlock | undefined;
    if (!block) {
      problems.push(`providers.${name} is referenced but has no configuration block`);
      continue;
    }
    if (!block.default_model) problems.push(`providers.${name}.default_model is not set`);
    // Bedrock authenticates through the standard AWS credential chain, so there
    // is no key in config to check.
    if (name === "openrouter" && !block.api_key) {
      problems.push(`providers.openrouter.api_key is empty (set OPENROUTER_API_KEY)`);
    }
  }

  if (problems.length === 0) return;
  const hint = unset.size > 0 ? ` Unset environment variables: ${[...unset].sort().join(", ")}.` : "";
  throw new Error(`Invalid config ${path}:\n  - ${problems.join("\n  - ")}\n${hint}`);
}

// Coerce a configured extraction_concurrency into a usable integer: missing or
// non-numeric falls back to the default, and anything valid is clamped to
// [1, MAX_EXTRACTION_CONCURRENCY]. Exported for tests.
export function normalizeConcurrency(value: unknown): number {
  // "Not specified" must mean the default, not 1. Guard null/""/whitespace up
  // front: YAML parses a valueless `extraction_concurrency:` as null, and
  // Number(null) is 0 — which is finite, so it would otherwise clamp to 1 and
  // silently disable parallelism.
  if (value === null || value === undefined) return DEFAULT_EXTRACTION_CONCURRENCY;
  if (typeof value === "string" && value.trim() === "") return DEFAULT_EXTRACTION_CONCURRENCY;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_EXTRACTION_CONCURRENCY;
  return Math.min(MAX_EXTRACTION_CONCURRENCY, Math.max(1, Math.floor(n)));
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

let cached: { path: string; config: IrisConfig } | null = null;

export function loadConfig(path = process.env.IRIS_CONFIG ?? "config.yaml"): IrisConfig {
  const resolved = resolve(path);
  // Cache per resolved path: a caller passing a different config file must get
  // that file, not whichever one happened to load first.
  if (cached && cached.path === resolved) return cached.config;
  const raw = readFileSync(resolved, "utf8");
  const unset = new Set<string>();
  const parsed = expandEnv(parse(raw), unset) as IrisConfig;
  // Resolve filesystem paths to absolutes so the service is CWD-independent.
  parsed.storage.data_dir = resolve(parsed.storage.data_dir);
  parsed.storage.agents_dir = resolve(parsed.storage.agents_dir);
  parsed.storage.database = resolve(parsed.storage.database);
  // GitHub host defaults (overridable for GitHub Enterprise / testing).
  parsed.github.api_base_url = parsed.github.api_base_url || "https://api.github.com";
  parsed.github.oauth_base_url = parsed.github.oauth_base_url || "https://github.com";
  // Normalize the extraction concurrency knob once, here, so every consumer can
  // trust it: absent/garbage -> default, out-of-range -> clamped. A deployment
  // that sets 0 or a negative value means "don't parallelize" -> 1.
  parsed.defaults = parsed.defaults ?? ({} as IrisConfig["defaults"]);
  parsed.defaults.extraction_concurrency = normalizeConcurrency(
    parsed.defaults.extraction_concurrency,
  );
  // Fall back to the bundled OAuth App so the default device-flow deployment
  // works with no per-operator app setup (PRD §9.1).
  parsed.github.client_id = parsed.github.client_id || DEFAULT_CLIENT_ID;
  validateConfig(parsed, unset, path);
  cached = { path: resolved, config: parsed };
  return parsed;
}
