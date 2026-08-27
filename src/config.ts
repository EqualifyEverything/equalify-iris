import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
// Type-only: config decides what `trust proxy` becomes, and applyTrustProxy below has to
// hand it to the app to find out whether Express will take it.
import type { Express } from "express";

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
  // OPTIONAL override for what one uploaded page image may be. Leave unset: the
  // defaults come from providers/imageLimits.ts, which derives them from the model
  // and provider this block configures, so they follow a model switch on their own.
  // Set one only for something that table cannot know — a model released after it
  // was written, or a platform with its own cap. Normalized where it is read, not
  // here, because the fallback is a per-model lookup rather than a constant.
  image_limits?: {
    // Bytes on disk. Defaults to three quarters of max_base64_bytes (base64 is 4
    // characters per 3 bytes).
    max_image_bytes?: number;
    // The provider's cap on base64-encoded image data in one request.
    max_base64_bytes?: number;
    // Long edge above which the model downscales. Published, never enforced.
    max_long_edge_px?: number;
  };
  // Whether this provider's calls may ask the model to cache the prompt prefix they
  // re-send (providers/promptCache.ts). Defaults to true, and should stay that way:
  // it makes the same run cheaper and changes nothing about what the model returns.
  // Set false only for an upstream that REJECTS `cache_control` — a request the
  // upstream refuses is not a slow call, it is every call — which is a real risk only
  // behind a broker that chooses the upstream for us. Normalized where it is read.
  prompt_cache?: boolean;
  // How long those cache entries should live: `5m` (the default) or `1h`. A question
  // about this deployment's CADENCE and nothing else — see providers/promptCache.ts
  // `CacheTtl` for the arithmetic. Within one run the default never expires, because
  // every page call reads the same prefix and each read refreshes it; an hour is worth
  // asking for only where runs arrive in bursts more than five minutes and less than an
  // hour apart. Anything unrecognized reads as the default. Normalized where it is read.
  prompt_cache_ttl?: string;
  // BEDROCK ONLY, and off by default. Which Bedrock API the calls go out on: `invoke`
  // (the default — `InvokeModelWithResponseStream` with an Anthropic-native body, which
  // is what every deployment has always sent) or `converse` (`ConverseStream`, whose
  // request shape belongs to Bedrock rather than to a model vendor and therefore reaches
  // a non-Claude model at all). See providers/bedrock.ts `bedrockApi`: parity between the
  // two is an empirical question about a live endpoint, so this exists to be measured
  // with. Anything unrecognized is the default, and is warned about at boot.
  api?: string;
}

// How much one caller may ask of this deployment per minute, and how many uploads it
// will receive at once. Enforced in util/requestLimits.ts and published by
// `GET /v1/limits`; see that module for why each default is the size it is.
export interface RateLimitConfig {
  // Off switch for a deployment that limits request volume somewhere in front of Iris
  // and would rather not have two budgets to reason about. Not the way to widen a
  // limit — raise the numbers for that; this removes the bound entirely.
  enabled: boolean;
  // Requests per minute across all of `/v1`, per credential (or per address, before a
  // credential has been validated).
  general_per_minute: number;
  // Requests per minute to `/v1/auth`, per address. Necessarily per address: there is
  // no credential yet on the endpoint that issues one.
  auth_per_minute: number;
  // Session creations per minute, per user.
  upload_per_minute: number;
  // Megabytes of upload body being received at once, across all callers. A rate limit
  // counts requests over a window; this bounds the ones that OVERLAP, which is what
  // upload memory is actually spent by — multer buffers every part in memory.
  max_upload_memory_mb: number;
}

export interface IrisConfig {
  server: {
    port: number;
    base_url: string;
    // Shared secret that gates `GET /v1/quality`, the deployment-wide quality tally
    // the weekly workflow files issues from (PRD §7.16). Unset by default, and the
    // endpoint answers 404 until it is set — an operator opts in rather than
    // discovering they exposed it.
    //
    // Deliberately NOT the GitHub user auth every other endpoint uses. That answers
    // "which user is this", and this data belongs to no user: it is an aggregate over
    // every document the deployment has converted, so there is no user whose token
    // should unlock it and no user who should be denied their own. It is also read by
    // a CI job, which has no GitHub user to be.
    quality_token?: string;
    // How many reverse proxies sit in front of this deployment, as a hop count (1 for a
    // single Caddy or nginx). Passed to Express's `trust proxy` setting, which is what
    // decides whether `req.ip` is the caller's address or the proxy's.
    //
    // It is a rate-limiting knob before it is anything else: unset behind a proxy, every
    // caller presents as the same address and the per-address limits treat the whole
    // deployment as one client. Left off by default because the opposite mistake is
    // worse — trusting a hop that does not exist means believing an `X-Forwarded-For`
    // the client wrote, which turns a per-address limit into no limit at all. A hop
    // count is the safe form: with 1, only the address the proxy appended is read, and
    // whatever the client claimed before it is ignored.
    //
    // Also accepts an Express-recognized string (`loopback`, a subnet) for a deployment
    // whose topology a count cannot describe. Boolean `true` is coerced to 1 with a
    // warning (trustProxyWarning), and a string Express cannot compile is refused with one
    // rather than crashing the process at startup (applyTrustProxy).
    trust_proxy?: number | boolean | string;
    // Optional overrides for the request-volume budget. Normalized by loadConfig, and
    // resolved through resolveRateLimits at every read, so a config that omits the block
    // (or a hand-built one in a test) still gets a complete, usable set.
    rate_limits?: Partial<RateLimitConfig>;
  };
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
    // Reader/editor rounds a document gets before the review loop stops and lists
    // what is left in `unresolved.md`. Read once, at first auth, to seed the
    // account default every session inherits — a session cannot override it
    // (§9.2 "Amended"). Normalized by loadConfig, so it is always >= 1.
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

// The request-volume budget when the deployment doesn't say. Each is per minute; see
// util/requestLimits.ts for the traffic each one was sized against, which is the thing
// to re-check before changing one. In short: the demo polls a running session every
// 2.5s (24/min) and a device-flow login polls every 5s (12/min) for as long as the user
// takes to approve it, so these sit an order of magnitude above a working client and
// still bound a loop that has come off its leash.
export const DEFAULT_GENERAL_PER_MINUTE = 240;
export const DEFAULT_AUTH_PER_MINUTE = 60;
export const DEFAULT_UPLOAD_PER_MINUTE = 12;
// Upload body being received at once, in megabytes — the only one of these that bounds
// MEMORY rather than request count, and so the first to reduce on a small machine. 256 MB
// is two uploads at the 128 MB per-request ceiling (util/requestLimits.ts), or any number
// of ordinary ones: a full 25-page session of images is ~92 MB and a typical one a few MB,
// so this refuses concurrent uploads only when they are genuinely large.
export const DEFAULT_MAX_UPLOAD_MEMORY_MB = 256;

// Coerce one configured limit into a usable positive integer. Same "absent means the
// default, not zero" trap as the concurrency normalizers, and here the consequence of
// letting a 0 through is the most severe of the set: express-rate-limit reads a limit of
// 0 as "allow nothing", so a valueless `general_per_minute:` in YAML (null, and
// Number(null) is 0) would answer 429 to every request the deployment ever receives. A
// non-positive value is therefore treated as unset rather than obeyed; `enabled: false`
// is how a deployment turns limiting off, which says so in one place instead of being
// inferred from a number.
function normalizePositiveInt(value: unknown, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n < 1 ? fallback : Math.floor(n);
}

/**
 * The complete request-volume budget for a config that may specify none, some, or all of
 * it. Idempotent, and deliberately called at every read (util/requestLimits.ts,
 * routes/limits.ts) as well as once by loadConfig: `server.rate_limits` is optional, so
 * the alternative is every consumer carrying its own fallback and one of them eventually
 * disagreeing about what the default is.
 *
 * Only an explicit `false` disables limiting. Anything else — including a config that
 * says nothing at all — is on, because the failure mode of a typo'd key silently
 * removing the bound is exactly the state this feature exists to prevent.
 */
export function resolveRateLimits(raw: Partial<RateLimitConfig> | undefined): RateLimitConfig {
  const enabled = !(raw?.enabled === false || String(raw?.enabled) === "false");
  return {
    enabled,
    general_per_minute: normalizePositiveInt(raw?.general_per_minute, DEFAULT_GENERAL_PER_MINUTE),
    auth_per_minute: normalizePositiveInt(raw?.auth_per_minute, DEFAULT_AUTH_PER_MINUTE),
    upload_per_minute: normalizePositiveInt(raw?.upload_per_minute, DEFAULT_UPLOAD_PER_MINUTE),
    max_upload_memory_mb: normalizePositiveInt(raw?.max_upload_memory_mb, DEFAULT_MAX_UPLOAD_MEMORY_MB),
  };
}

/**
 * Coerce a configured `trust_proxy` into the shape Express's `trust proxy` setting takes.
 *
 * Absent, empty, `false`, `"false"`, `0` -> false (trust nothing, the safe default).
 * A number or numeric string -> that many hops. Any other string is passed through for
 * Express to interpret (`loopback`, a subnet list) — whether it CAN interpret it is
 * applyTrustProxy's business, not this function's. `true` becomes 1, because trusting every
 * hop means believing an `X-Forwarded-For` the client wrote — see trustProxyWarning, which
 * says so out loud rather than silently obeying or silently correcting.
 */
export function normalizeTrustProxy(value: unknown): number | boolean | string {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value ? 1 : false;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.floor(value) : false;
  const text = String(value).trim();
  if (text === "" || text.toLowerCase() === "false") return false;
  if (text.toLowerCase() === "true") return 1;
  const n = Number(text);
  if (Number.isFinite(n)) return n > 0 ? Math.floor(n) : false;
  return text;
}

// A boot-time warning for the one `trust_proxy` value that is accepted and unsafe.
// Returned rather than logged, like the two GitHub warnings above, so it is testable and
// the caller decides where it goes.
export function trustProxyWarning(value: unknown): string | undefined {
  if (value !== true && String(value).trim().toLowerCase() !== "true") return undefined;
  return (
    `server.trust_proxy is "true", which tells Express to trust the whole X-Forwarded-For chain — ` +
    `including the part a client wrote, so any caller could present a fresh address per request and ` +
    `the per-address rate limits would bound nothing. Using 1 hop instead. Set it to the number of ` +
    `proxies actually in front of this deployment.`
  );
}

/**
 * Put a configured `trust_proxy` on an Express app, and hand back the warning it earned.
 *
 * Express compiles this setting EAGERLY through proxy-addr and throws on anything proxy-addr
 * cannot parse, so a typo in this one key used to take the process down at startup with a
 * `TypeError: invalid IP address: yes` naming neither the key nor the file it came from.
 * Every other unusable value in this file warns and falls back to a working default; this
 * one now does the same.
 *
 * Validated by ATTEMPTING it rather than by checking the string against a copy of
 * proxy-addr's grammar, because that grammar has corners a copy gets wrong: the three names
 * are case-sensitive (`Loopback` is an error), `/0` is not a valid range, an IPv4 mask must
 * be contiguous. A second implementation of it would be a second thing to disagree with
 * Express — and it would disagree in the direction that crashes, since a value it wrongly
 * approved is a value Express refuses. What Express accepts is what Express accepts.
 */
export function applyTrustProxy(app: Pick<Express, "set">, value: unknown): string | undefined {
  try {
    app.set("trust proxy", normalizeTrustProxy(value));
    return trustProxyWarning(value);
  } catch {
    app.set("trust proxy", false);
    return (
      `server.trust_proxy is ${JSON.stringify(String(value).trim())}, which Express cannot interpret. It ` +
      `takes a number of proxies in front of this deployment (1 behind a single Caddy/nginx), one of ` +
      `"loopback", "linklocal" or "uniquelocal" (lower case), or a comma-separated list of proxy ` +
      `addresses and subnets. Trusting nothing instead, which means every caller behind a proxy shares ` +
      `one rate-limit bucket.`
    );
  }
}

// Reader/editor rounds a document gets when the deployment doesn't say. Since the
// per-request override was removed (§9.2 "Amended"), this config value is the ONLY
// input to the cap — it seeds every account default on first auth — so the values
// it must not silently become are the ones that would quietly stop the review loop
// from reviewing: `0` buys one reader pass with no fix ever applied, and a negative
// skips review outright (src/pipeline/review.ts). Both are floored to 1 by the
// normalizer below.
export const DEFAULT_MAX_REVIEW_ITERATIONS = 3;

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

  // The scope validation this function used to do is gone: it rejected a scopeless
  // `github.oauth_scope` at startup, because a token that could identify a user but
  // not file on their behalf broke the contribution model (PRD §12) and failed
  // silently — one swallowed `agent_issue_failed` line per run while the service kept
  // answering 200. Iris now authenticates as a GitHub App, so a user's authorization
  // carries no repository permission to get wrong: `issues: write` comes from
  // INSTALLING the app on `upstream_repo` (see src/auth/github.ts).
  //
  // What DID survive is the failure shape, one level up. An operator who points
  // `client_id` at an OAuth App gets exactly the state the old check existed to
  // prevent: no scope is requested (this code no longer has one to send), so the
  // token identifies users and cannot file, `GET /user` keeps working, the service
  // keeps answering 200, and contribution is dead with one log line per run. So the
  // one thing about the credential that config CAN see is checked here.
  //
  // Only the unambiguous case is fatal. `Ov`-prefixed ids are OAuth Apps on
  // github.com and nothing else, and no GitHub App has that prefix. Everything else
  // non-`Iv` gets a warning instead (see clientIdWarning) rather than a refusal —
  // legacy OAuth App ids are bare hex, GitHub Enterprise Server mints its own, and
  // refusing a format this code has not seen would break a deployment that works.
  if (cfg.github?.client_id?.startsWith("Ov")) {
    problems.push(
      `github.client_id "${cfg.github.client_id}" is an OAuth App (Ov…), and Iris needs a GitHub App (Iv…). ` +
        `An OAuth App would authenticate users fine and then be unable to file issues: Iris requests no OAuth ` +
        `scope, because a GitHub App takes its issues:write from being INSTALLED on upstream_repo. Register a ` +
        `GitHub App (device flow enabled, user-token expiry off), install it on upstream_repo, and use its ` +
        `client id — or leave github.client_id unset to use the bundled app.`,
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

// A boot-time warning for a `client_id` that is probably not a GitHub App, or
// undefined if it looks fine. Returned rather than logged so this is testable and so
// the caller decides where it goes; src/index.ts prints it.
//
// Not an error, unlike the `Ov` case validateConfig rejects: GitHub Enterprise
// Server mints its own id formats and pre-2022 OAuth Apps used bare hex, so a
// refusal here could break a working deployment over a format this code has not
// seen. But the consequence of being wrong is invisible at boot and expensive — an
// OAuth App files nothing while looking healthy — so it is worth a line.
export function clientIdWarning(clientId: string): string | undefined {
  if (!clientId || clientId.startsWith("Iv")) return undefined;
  return (
    `github.client_id "${clientId}" does not look like a GitHub App id (those start "Iv"). ` +
    `If it is an OAuth App, logins will work and issue filing will fail on every run: Iris requests no OAuth ` +
    `scope, because a GitHub App gets issues:write from its installation on upstream_repo. Ignore this if you ` +
    `are on GitHub Enterprise Server, where id formats differ.`
  );
}

// A boot-time warning for a `prompt_cache_ttl` that is set to something this does not
// recognize (providers/promptCache.ts `promptCacheTtl`).
//
// This one has to be said out loud because it is the only place it CAN be. An
// unrecognized value is ignored, and the two TTLs differ in what they are billed at
// rather than in what they report: the same prefix written either way produces the same
// `cache_creation_input_tokens`, so no diagnostics field distinguishes them and an
// operator who typed `60m` would go on believing they had bought the hour. Every other
// unusable value in this config already says so at startup.
//
// It warns for a block with `prompt_cache: false` too, where no entry is written at all
// and neither TTL is in play. That is deliberate — the value is still one nobody can
// use, and it would become live the day caching is turned back on — so the wording says
// the value is ignored rather than naming a TTL that block does not have.
//
// Returns one warning naming every provider block that has one, since a deployment
// configures more than one and fixing the first would otherwise hide the second.
export function promptCacheTtlWarning(providers: IrisConfig["providers"]): string | undefined {
  const bad: string[] = [];
  for (const [name, block] of Object.entries(providers)) {
    // `default` is a string and `per_agent` is a map of agent overrides; neither is a
    // provider block. Skipped BY NAME, the way loadConfig's own pass over this object
    // does it, rather than by shape: `per_agent` is an object and would otherwise reach
    // the lookup below and be searched for a key belonging to a provider.
    if (name === "default" || name === "per_agent") continue;
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const v = (block as ProviderBlock).prompt_cache_ttl as unknown;
    if (v === null || v === undefined) continue;
    const text = String(v).trim();
    // An empty value is an operator who set nothing, which is what the default is for.
    if (text === "") continue;
    const normalized = text.toLowerCase();
    if (normalized !== "5m" && normalized !== "1h") bad.push(`${name}: "${text}"`);
  }
  if (bad.length === 0) return undefined;
  return (
    `providers.${bad.join(", providers.")} — prompt_cache_ttl must be "5m" or "1h". ` +
    `This one is ignored. Nothing downstream will report that: the two TTLs differ in ` +
    `what a cache write is BILLED at (1.25x against 2x), not in the token counts ` +
    `diagnostics publishes, so a deployment that meant to hold its cache for an hour ` +
    `would never find out from Iris.`
  );
}

// The same kind of warning for `api`, which picks the Bedrock API a block's calls go out
// on (providers/bedrock.ts `bedrockApi`).
//
// Same asymmetry as the TTL above and the same treatment: an unrecognized value falls back
// to `invoke`, which is the path that works, and nothing downstream can tell you it did.
// Both APIs return the same text through the same interface, so an operator who wrote
// `Converse` or `converse-stream` and set out to measure the new path against the old
// would be measuring the old path twice.
//
// Named blocks rather than a bare complaint, and only Bedrock blocks: the field is
// meaningless to the OpenRouter adapter, and warning about it there would send an operator
// looking for a setting that does not exist. Which blocks are Bedrock is decided by the
// provider NAME, the same way loadConfig decides which adapter to construct.
export function bedrockApiWarning(providers: IrisConfig["providers"]): string | undefined {
  const bad: string[] = [];
  for (const [name, block] of Object.entries(providers)) {
    if (name !== "bedrock") continue;
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const v = (block as ProviderBlock).api as unknown;
    if (v === null || v === undefined) continue;
    const text = String(v).trim();
    // An empty value is an operator who set nothing, which is what the default is for.
    if (text === "") continue;
    const normalized = text.toLowerCase();
    if (normalized !== "invoke" && normalized !== "converse") bad.push(`${name}: "${text}"`);
  }
  if (bad.length === 0) return undefined;
  return (
    `providers.${bad.join(", providers.")} — api must be "invoke" or "converse". ` +
    `This one is ignored and the calls go out on "invoke", the Anthropic-native path. ` +
    `Nothing downstream will report that: both APIs return the same text through the same ` +
    `interface, so a deployment that meant to be testing ConverseStream would be measuring ` +
    `the path it already had.`
  );
}

// A boot-time warning for the other combination config can see is broken: the bundled
// app plus an `upstream_repo` it is not installed on.
//
// This became possible to get wrong only by moving to a GitHub App. `issues: write`
// used to come from the user's `public_repo` scope, which reached any public repo, so
// leaving `client_id` blank and repointing `upstream_repo` at your own agent library
// worked. Now the permission comes from an installation on one specific repository,
// and the bundled app is installed on Equalify's. So that same edit — one documented,
// first-class knob (`IRIS_UPSTREAM_REPO`), changed on its own — yields a deployment
// where every login succeeds and no contribution can ever be filed, for anyone.
//
// Warned rather than refused, and this is the whole reason it is not fatal: a
// deployment can legitimately be in this state. Equalify can install the bundled app
// on someone else's repo, and an operator can ask them to; nothing in config could
// tell. Refusing would break that. But the failure is invisible at boot and silent at
// runtime, so it gets a line — the property the deleted `oauth_scope` check used to
// provide, restored for the case that replaced it.
//
// Deliberately not comparing against `api_base_url`: on GitHub Enterprise Server the
// bundled app does not exist at all, `client_id` must be set, and this warning cannot
// fire because the bundled default is not in use.
export function bundledAppWarning(clientId: string, upstreamRepo: string): string | undefined {
  if (clientId !== DEFAULT_CLIENT_ID) return undefined;
  // Compared on owner/repo rather than on the URL: `upstream_repo` is documented as a
  // URL and accepts the shapes parseRepo does (with or without `.git`, ssh or https),
  // so a string compare would warn about a spelling of the right repo.
  const m = upstreamRepo?.replace(/\.git$/, "").match(/github\.com[/:]([^/]+)\/([^/]+)/);
  const slug = m ? `${m[1]}/${m[2]}` : undefined;
  if (slug?.toLowerCase() === BUNDLED_APP_REPO.toLowerCase()) return undefined;
  return (
    `github.upstream_repo is "${upstreamRepo}" while github.client_id is unset, so Iris is using the bundled ` +
    `Equalify Iris GitHub App — which is installed on ${BUNDLED_APP_REPO}, not on your repo. A GitHub App's ` +
    `issues:write comes from its INSTALLATION, so logins will work and every issue filing will fail for every ` +
    `user, logged once per run as agent_issue_failed. Either register your own GitHub App (device flow enabled, ` +
    `user-token expiry off) and install it on ${slug ?? "your upstream_repo"}, then set github.client_id to its ` +
    `id — or ask Equalify to install the bundled app there, and ignore this.`
  );
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

// Coerce a configured max_review_iterations into a usable integer: missing or
// non-numeric falls back to the default, and anything valid is floored to 1.
// Exported for tests.
export function normalizeReviewIterations(value: unknown): number {
  // The same "absent means the default, not zero" trap as the other normalizers —
  // YAML parses a valueless `max_review_iterations:` as null and Number(null) is 0
  // — but here it had a second failure on top of a bad cap: null flows through
  // makeAuthMiddleware to upsertUser, whose `= 3` parameter default only fires for
  // `undefined`, so it reached a NOT NULL column and every first-time login on that
  // deployment failed as `401 unauthorized: Token validation failed`. A config typo
  // reported as the caller's token being bad.
  if (value === null || value === undefined) return DEFAULT_MAX_REVIEW_ITERATIONS;
  if (typeof value === "string" && value.trim() === "") return DEFAULT_MAX_REVIEW_ITERATIONS;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_MAX_REVIEW_ITERATIONS;
  // Floored, not clamped: unlike the two concurrency knobs there is no ceiling
  // here, deliberately. Rounds are sequential, so a big number costs the operator
  // who chose it latency and tokens on their own deployment — it does not
  // over-subscribe the machine and degrade every other run the way concurrency
  // does. Silently capping a deliberate 20 would be the more surprising behavior.
  return Math.max(1, Math.floor(n));
}

// Bundled GitHub App client_id for the device flow (PRD §9.1). This is the single
// place to embed Equalify's registered "Equalify Iris" GitHub App so the default
// deployment needs no per-operator app setup — the same pattern the GitHub CLI uses.
// The client_id is NOT a secret (it is sent openly in every authorization flow); the
// client secret is never bundled and is only needed for the web redirect flow. A
// deployment can override this via config/env.
//
// A GitHub App, not an OAuth App — the `Iv23` prefix rather than `Ov23`. That is what
// keeps the consent screen free of any repository grant: `issues: write` comes from
// installing the app on `upstream_repo`, not from the user (see src/auth/github.ts).
//
// Pointing this at your own app means registering a GitHub App with device flow
// enabled and user-token expiry off, and installing it on your `upstream_repo`.
export const DEFAULT_CLIENT_ID = "Iv23liv73tlbX0VfoEkr";

// The one repository the bundled app above is installed on. Its only purpose is
// bundledAppWarning below: `issues: write` now comes from an installation, and an
// installation is per-repository, so "which repo" is part of whether the bundled
// credential works at all. Under the old OAuth App it was not — `public_repo` filed
// on any public repo the user could reach, so `upstream_repo` and `client_id` were
// independent knobs and a self-hoster could repoint the upstream alone.
const BUNDLED_APP_REPO = "EqualifyEverything/equalify-iris";

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
  // Normalize the request-volume budget here too, so the numbers `GET /v1/limits`
  // publishes are the same object the limiters were built from. `trust_proxy` is
  // deliberately NOT normalized here: index.ts needs the value as written to decide
  // whether to warn about it (a `true` coerced to 1 in this function is a `true` nobody
  // can warn about afterwards).
  parsed.server = parsed.server ?? ({} as IrisConfig["server"]);
  parsed.server.rate_limits = resolveRateLimits(parsed.server.rate_limits);
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
  // Same treatment for the cross-session run cap, so the queue can be built
  // straight from config with no fallback at the construction site.
  parsed.defaults.max_concurrent_runs = normalizeMaxConcurrentRuns(
    parsed.defaults.max_concurrent_runs,
  );
  // And for the review cap. This one is normalized here rather than at the point of
  // use because there is no longer a point of use to guard: the value is read once,
  // at first auth, to seed the account default that every later session inherits.
  parsed.defaults.max_review_iterations = normalizeReviewIterations(
    parsed.defaults.max_review_iterations,
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
  // Fall back to the bundled GitHub App so the default device-flow deployment
  // works with no per-operator app setup (PRD §9.1). Applied BEFORE validateConfig,
  // so its client_id check sees the effective value rather than an empty string.
  parsed.github.client_id = parsed.github.client_id || DEFAULT_CLIENT_ID;
  validateConfig(parsed, unset, path);
  cached = { path: resolved, config: parsed };
  return parsed;
}
