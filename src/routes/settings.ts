// GET /v1/settings — how this deployment is set up, for /how-it-works and for anyone checking what
// a run will do. Behind the same optional key as /v1/sessions (index.ts), so a deployment that
// requires one does not publish its setup to everyone.
//
// Built from an allow-list, never by copying the config and removing secrets: a key added to the
// config later is not shown until it is added here. So API keys, tokens, provider URLs, file paths
// and inference-profile ARNs never appear. Each value is the one Iris uses, after its defaults and
// normalising, and each agent's model is resolved the way a call resolves it.
//
// Built once: the config is read at boot and does not change while the process runs.
import { Router } from "express";
import { readdirSync } from "node:fs";
import { basename } from "node:path";
import {
  apiToken,
  auditOn,
  DISPATCHED_AGENTS,
  normalizeMaxTokens,
  type Capability,
  type IrisConfig,
  type ProviderBlock,
} from "../config.ts";
import { resolveAgentModel } from "../providers/index.ts";
import { promptCacheEnabled, promptCacheTtl } from "../providers/promptCache.ts";
import { retentionDays } from "../store/retention.ts";
import { taggedPdfStatus, tagTimeoutSeconds } from "../util/taggedPdf.ts";
import { VERSION } from "../version.ts";

const CAPABILITIES: Capability[] = ["vision", "text", "structured_output"];

export function deploymentSettings(cfg: IrisConfig): Record<string, unknown> {
  const p = cfg.providers;
  const blocks = Object.entries(p).filter(
    ([name, b]) => name !== "default" && name !== "per_agent" && b && typeof b === "object" && !Array.isArray(b),
  ) as [string, ProviderBlock][];
  let specialists: string[] = [];
  try {
    const core = new Set<string>(DISPATCHED_AGENTS);
    specialists = readdirSync(cfg.storage.agents_dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => basename(f, ".md"))
      .filter((n) => !core.has(n))
      .sort();
  } catch {
    // no readable agents folder: no specialists to list
  }
  const route = (agent: string) =>
    Object.fromEntries(
      CAPABILITIES.map((c) => {
        try {
          return [c, resolveAgentModel(p, agent, c)];
        } catch {
          return [c, null];
        }
      }),
    );
  const pdf = taggedPdfStatus(cfg);
  return {
    version: VERSION,
    access: {
      api_key_required: Boolean(apiToken(cfg)),
      audit: auditOn(cfg),
      quality_report: Boolean(cfg.server.quality_token?.trim()),
    },
    run: {
      max_review_iterations: cfg.defaults.max_review_iterations,
      extraction_concurrency: cfg.defaults.extraction_concurrency,
      max_concurrent_runs: cfg.defaults.max_concurrent_runs,
      recheck_sample_size: cfg.defaults.recheck_sample_size,
    },
    retention_days: retentionDays(cfg),
    tagged_pdf: {
      on: Boolean(pdf && !pdf.startsWith("WARNING")),
      // "Tagged PDFs on (iris-pdf 1.2.0)." -> "iris-pdf 1.2.0"
      version: pdf && !pdf.startsWith("WARNING") ? (/\((.*)\)/.exec(pdf)?.[1] ?? null) : null,
      timeout_seconds: tagTimeoutSeconds(cfg),
    },
    providers: {
      default: p.default,
      blocks: Object.fromEntries(
        blocks.map(([name, b]) => [
          name,
          {
            ...(b.api ? { api: b.api } : {}),
            ...(b.region ? { region: b.region } : {}),
            default_model: b.default_model,
            per_capability: b.per_capability ?? {},
            max_tokens: normalizeMaxTokens(b.max_tokens),
            prompt_cache: promptCacheEnabled(b),
            prompt_cache_ttl: promptCacheTtl(b),
            // Which models are called through a tagged inference profile. The ARNs are not shown.
            inference_profiles: Object.keys(b.inference_profiles ?? {}),
          },
        ]),
      ),
    },
    agents: [
      ...DISPATCHED_AGENTS.map((a) => ({ agent: a, kind: "core", models: route(a) })),
      ...specialists.map((a) => ({ agent: a, kind: "specialist", models: route(a) })),
    ],
  };
}

export function settingsRouter(cfg: IrisConfig): Router {
  const r = Router();
  const body = deploymentSettings(cfg);
  r.get("/", (_req, res) => res.json(body));
  return r;
}
