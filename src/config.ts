import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { DEFAULT_OAUTH_SCOPE } from "./auth/github.ts";

export type Capability = "text" | "vision" | "structured_output";

export interface ProviderBlock {
  api_key?: string;
  base_url?: string;
  region?: string;
  default_model: string;
  per_capability?: Partial<Record<Capability, string>>;
  // Output-token ceiling for this provider's calls. A dense page of accessible
  // HTML is the binding case: hit the ceiling and the model stops mid-tag.
  // Normalized by loadConfig, so providers can trust it.
  max_tokens?: number;
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
    // OPTIONAL service token (PAT) that files every issue under one bot account
    // instead of under the user who ran the session.
    //
    // Off by default, and deliberately not recommended: filing under each user's
    // own identity is the point of authenticating with GitHub at all (PRD §12 —
    // every user gives back to the shared agent library, credited to them). A bot
    // account erases that attribution. Set it only when a deployment cannot file as
    // its users — e.g. an org policy that forbids it.
    issue_token?: string;
    // OAuth scope requested from the user. `public_repo` (the default) is the FLOOR,
    // not a starting point to lower: it is exactly what filing an issue on a public
    // upstream needs, and filing is required of every user, not optional. Raise it
    // to `repo` only for a PRIVATE upstream.
    //
    // There is no "request nothing" setting. A scopeless token can identify a user
    // but cannot contribute, which is not a mode this service has (see
    // validateConfig). loadConfig normalizes this, so by the time anything reads it,
    // it is a non-empty string.
    oauth_scope: string;
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
    // How many pipeline runs execute at once ACROSS sessions. Unlike
    // extraction_concurrency (within one run), this bounds what the machine as a
    // whole is doing: each run holds jsdom+axe and up to extraction_concurrency
    // model calls, so the real peak is the product of the two. Runs over the cap
    // wait in `queued`; they are not rejected. Normalized by loadConfig.
    max_concurrent_runs: number;
  };
}

// Pages extracted in parallel when the deployment doesn't say. Modest on purpose:
// a burst of concurrent calls is the most likely way to trip a provider's rate
// limit, and while both adapters retry throttling responses (OpenRouter by hand,
// Bedrock via the AWS SDK's standard strategy), backing off repeatedly is slower
// than not being throttled in the first place.
export const DEFAULT_EXTRACTION_CONCURRENCY = 5;
// Upper bound. Past this, added parallelism buys little (provider-side rate
// limits dominate) and each in-flight call holds a base64 page image in memory.
export const MAX_EXTRACTION_CONCURRENCY = 16;

// Pipeline runs allowed to execute simultaneously when the deployment doesn't
// say. Deliberately small: 2 concurrent runs on a default config already means
// up to 10 in-flight vision calls (2 × DEFAULT_EXTRACTION_CONCURRENCY) plus two
// live jsdom+axe instances, on a machine that per PRD §10.1 may be a laptop.
// The knob to reach for first on a bigger box is this one, not the extraction
// concurrency — waiting is cheap and visible (`status: "queued"`), whereas
// over-subscribing degrades every run at once.
export const DEFAULT_MAX_CONCURRENT_RUNS = 2;
// Upper bound. This is a cap on how much of the machine one deployment will
// commit, not a statement about what a provider will serve; an operator who
// genuinely needs more concurrency than this wants multiple instances and a
// shared Postgres store (§10.2), which v1 does not implement.
export const MAX_CONCURRENT_RUNS_CEILING = 32;

// Output-token ceiling when a provider block doesn't set one. 8192 was the old
// hardcoded Bedrock value and is comfortably too small for a dense page: a
// full-page table or form of accessible HTML can exceed it, and the model then
// stops mid-tag. Raised to a value current Claude models all accept, because the
// failure it prevents (silently truncated HTML flowing downstream as if valid) is
// far worse than the cost of a ceiling that is rarely reached — output is billed
// per token emitted, not per token allowed.
export const DEFAULT_MAX_TOKENS = 32_000;

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

  // A scopeless token is rejected outright rather than paired with anything.
  //
  // Iris authenticates with GitHub so that using it and contributing back to the
  // shared agent library are the same act (PRD §12): every session's feedback is
  // filed as an issue under the user's own identity. A token that can identify a
  // user but not file on their behalf breaks that, and GitHub's 403 would show up
  // only as one `agent_issue_failed` line in a run log — the deployment would look
  // healthy while the thing it exists to feed was dead.
  //
  // `github.issue_token` does NOT rescue this configuration, and the rejection is
  // unconditional — there is no pairing check here any more. Note what that means
  // precisely, because the mechanics point the other way: both filing paths resolve
  // `issue_token || ctx.githubToken`, so while the PAT is set, filing works and the
  // user's scope is never used. The floor is not a functional requirement in that
  // state; it is required so that leaving that state cannot be silent. Unset the PAT
  // (rotated, expired, moved to another deployment) and every user token in the
  // database is suddenly the credential that files — and a fleet of scopeless tokens
  // cannot, so contribution stops with one `agent_issue_failed` line per run while
  // the service keeps answering 200. Rejecting the scope at startup makes that
  // transition impossible instead of quiet, at the cost of storing tokens with
  // `public_repo` in a deployment that does not currently need it (§9.1 v1.2 weighs
  // that trade the other way for the token store, which is why nothing is persisted).
  //
  // Checked after normalizeScope, which never produces "" from a valid config, so
  // reaching this means the operator wrote something that meant "no scope".
  if (cfg.github?.oauth_scope === "") {
    problems.push(
      `github.oauth_scope requests no scope, which cannot work — a scopeless token can ` +
        `identify a user but not file the feedback issues every session contributes ` +
        `(GitHub answers 403). The minimum is "${DEFAULT_OAUTH_SCOPE}" (the default; ` +
        `remove the key to get it), or "repo" for a private upstream_repo`,
    );
  }

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

// Coerce a configured max_tokens into a usable integer. Same "absent means the
// default, not zero" trap as normalizeConcurrency: YAML parses a valueless
// `max_tokens:` as null, and Number(null) is 0 — which would cap every call at
// zero output tokens and make every response empty. There is no upper clamp; the
// provider rejects a value its model won't accept, and that error names the real
// limit better than a guess compiled in here would. Exported for tests.
export function normalizeMaxTokens(value: unknown): number {
  if (value === null || value === undefined) return DEFAULT_MAX_TOKENS;
  if (typeof value === "string" && value.trim() === "") return DEFAULT_MAX_TOKENS;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_MAX_TOKENS;
  // A configured 0 or negative is meaningless for an output ceiling (and would
  // silently empty every response), so treat it as "unset" rather than obeying it.
  return n < 1 ? DEFAULT_MAX_TOKENS : Math.floor(n);
}

// Coerce a configured max_concurrent_runs into a usable integer. Same
// "absent means the default, not zero" trap as the other two normalizers, but
// with a worse consequence if it slipped through: a limit of 0 would leave the
// queue accepting every session and starting none, so uploads would sit in
// `queued` forever with nothing logged to say why. Clamped to
// [1, MAX_CONCURRENT_RUNS_CEILING]. Exported for tests.
export function normalizeMaxConcurrentRuns(value: unknown): number {
  if (value === null || value === undefined) return DEFAULT_MAX_CONCURRENT_RUNS;
  if (typeof value === "string" && value.trim() === "") return DEFAULT_MAX_CONCURRENT_RUNS;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_MAX_CONCURRENT_RUNS;
  return Math.min(MAX_CONCURRENT_RUNS_CEILING, Math.max(1, Math.floor(n)));
}

// The word an operator might reach for to turn the scope off. There is no such
// setting — a scopeless token cannot file the feedback issues every session
// contributes (PRD §12), so this is recognized only in order to be REJECTED with an
// explanation by validateConfig, rather than passed to GitHub as a literal scope
// named "none" and failing later at the consent screen.
//
// Recognized case-insensitively because YAML parses `None`/`NONE` as strings, not as
// null (only `null`, `Null`, `NULL`, `~` and empty are null), so all three spellings
// arrive here as text.
export const NO_OAUTH_SCOPE = "none";

// Coerce a configured github.oauth_scope into the string to send to GitHub:
//
//   (key absent)          -> DEFAULT_OAUTH_SCOPE  ("didn't say" — take the floor)
//   oauth_scope:          -> DEFAULT_OAUTH_SCOPE  (null; a valueless key is a typo)
//   oauth_scope: ${UNSET} -> DEFAULT_OAUTH_SCOPE  (expandEnv already made it "")
//   oauth_scope: ""       -> DEFAULT_OAUTH_SCOPE  (same, and not distinguishable)
//   oauth_scope: none     -> ""                   -> REJECTED by validateConfig
//
// Every empty form becomes the default rather than "no scope", which is the
// convention every other key in this block follows (`api_base_url` a few lines down
// in loadConfig). It matters here beyond consistency: `expandEnv` turns an unset
// `${VAR}` into `""` before this runs, and `config.example.yaml`'s house style is the
// `${...}` form — so a mistyped variable name must not be able to quietly strip the
// scope out of a deployment. `none` returns "" rather than throwing here so that
// validateConfig can report it with the full reason; this function has no error
// channel.
//
// Exported for tests.
export function normalizeScope(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_OAUTH_SCOPE;
  // Trimmed because " repo " in YAML would otherwise be sent verbatim in the
  // scope parameter and GitHub would reject it.
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_OAUTH_SCOPE;
  if (trimmed.toLowerCase() === NO_OAUTH_SCOPE) return "";
  return trimmed;
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
  parsed.github.oauth_scope = normalizeScope(parsed.github.oauth_scope);
  // Normalize the extraction concurrency knob once, here, so every consumer can
  // trust it: absent/garbage -> default, out-of-range -> clamped. A deployment
  // that sets 0 or a negative value means "don't parallelize" -> 1.
  parsed.defaults = parsed.defaults ?? ({} as IrisConfig["defaults"]);
  parsed.defaults.extraction_concurrency = normalizeConcurrency(
    parsed.defaults.extraction_concurrency,
  );
  // Same treatment for the cross-session run cap, so the queue can be built
  // straight from config with no fallback at the construction site.
  parsed.defaults.max_concurrent_runs = normalizeMaxConcurrentRuns(
    parsed.defaults.max_concurrent_runs,
  );
  // Same treatment for each provider's output ceiling, so an adapter can read
  // block.max_tokens directly and never has to re-derive a default. Applied to
  // every provider block present, not just the referenced ones: validateConfig
  // deliberately skips unreferenced providers, but normalizing is free and keeps
  // the invariant "if the block exists, its max_tokens is a valid integer".
  for (const [key, block] of Object.entries(parsed.providers)) {
    if (key === "default" || key === "per_agent") continue;
    if (!block || typeof block !== "object") continue;
    const b = block as ProviderBlock;
    b.max_tokens = normalizeMaxTokens(b.max_tokens);
  }
  // Fall back to the bundled OAuth App so the default device-flow deployment
  // works with no per-operator app setup (PRD §9.1).
  parsed.github.client_id = parsed.github.client_id || DEFAULT_CLIENT_ID;
  validateConfig(parsed, unset, path);
  cached = { path: resolved, config: parsed };
  return parsed;
}
