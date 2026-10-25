// GET /v1/settings (routes/settings.ts): every non-secret setting as Iris uses it, and no secret.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { IrisConfig } from "../src/config.ts";
import { deploymentSettings } from "../src/routes/settings.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "SECRET-SHOULD-NOT-APPEAR";

// Every value that must stay private carries the same marker, so one search finds any of them.
function cfg(): IrisConfig {
  return {
    server: {
      port: 8080,
      base_url: `https://${SECRET}.example`,
      api_token: SECRET,
      quality_token: SECRET,
      audit: "true",
    },
    storage: { data_dir: `/${SECRET}/data`, agents_dir: join(root, "agents"), database: `/${SECRET}/db`, session_retention_days: 30 },
    tagged_pdf: { command: `/${SECRET}/no-such-iris-pdf`, timeout_seconds: 90 },
    branding: { logo_file: `/${SECRET}/logo.png` },
    providers: {
      default: "bedrock",
      per_agent: { page: { provider: "bedrock", model: "us.openai.gpt-5.6-luna" } },
      bedrock: {
        region: "us-east-2",
        api: "converse",
        default_model: "us.anthropic.claude-sonnet-4-6",
        inference_profiles: { "us.anthropic.claude-sonnet-4-6": `arn:aws:bedrock:us-east-2:111122223333:application-inference-profile/${SECRET}` },
        prices: { "us.anthropic.claude-sonnet-4-6": { input: 3.3, output: 16.5, cache_read: 0.33, cache_write: 4.125 }, "us.bad": { input: "3", output: 1 } } as never,
      },
      openrouter: { api_key: SECRET, base_url: `https://${SECRET}.example`, default_model: "anthropic/claude-sonnet-4.6", max_tokens: 0 },
    },
    defaults: { max_review_iterations: 2, extraction_concurrency: 5, max_concurrent_runs: 2, recheck_sample_size: 1 },
  } as IrisConfig;
}

test("no secret, URL, path or profile ARN appears anywhere in the settings", () => {
  const out = JSON.stringify(deploymentSettings(cfg()));
  assert.ok(!out.includes(SECRET), out);
  assert.ok(!out.includes("111122223333"), "no account id from an ARN");
});

test("the settings are the values Iris uses, and each agent's model is resolved as a call resolves it", () => {
  const s = deploymentSettings(cfg()) as {
    access: Record<string, boolean>;
    run: Record<string, number>;
    retention_days: number;
    tagged_pdf: { on: boolean; timeout_seconds: number };
    providers: { default: string; blocks: Record<string, Record<string, unknown>> };
    agents: { agent: string; kind: string; models: Record<string, { provider: string; model: string } | null> }[];
  };
  assert.deepEqual(s.access, { api_key_required: true, audit: true, quality_report: true });
  assert.deepEqual(s.run, { max_review_iterations: 2, extraction_concurrency: 5, max_concurrent_runs: 2, recheck_sample_size: 1 });
  assert.equal(s.retention_days, 30);
  assert.deepEqual(s.tagged_pdf, { on: false, version: null, timeout_seconds: 90 }, "a command that does not run is off");
  assert.deepEqual(s.providers.blocks.bedrock.inference_profiles, ["us.anthropic.claude-sonnet-4-6"]);
  assert.ok((s.providers.blocks.openrouter.max_tokens as number) > 0, "a 0 ceiling is shown as the default Iris uses instead");
  const page = s.agents.find((a) => a.agent === "page")!;
  assert.deepEqual(page.models.vision, { provider: "bedrock", model: "us.openai.gpt-5.6-luna" });
  const reader = s.agents.find((a) => a.agent === "reader")!;
  assert.deepEqual(reader.models.text, { provider: "bedrock", model: "us.anthropic.claude-sonnet-4-6" });
  assert.deepEqual(s.agents.filter((a) => a.kind === "core").map((a) => a.agent), ["page", "reader", "copy_editor", "feedback"]);
  assert.ok(s.agents.some((a) => a.kind === "specialist" && a.agent === "chartDataAgent"), "specialists come from agents/");
  const purpose = (n: string) => (s.agents.find((a) => a.agent === n) as unknown as { purpose: string | null }).purpose;
  assert.match(purpose("chartDataAgent")!, /^Convert charts and graphs/, "an agent's purpose comes from its file");
  assert.ok(s.agents.every((a) => !(a as unknown as { purpose: string | null }).purpose || (a as unknown as { purpose: string }).purpose.length <= 250), "each purpose is short");
  assert.equal(purpose("reader"), null, "an agent with no file in agents/ has none");
});

test("prices are shown as set, a price that is not a number is left out and named at boot", async () => {
  const { priceWarning } = await import("../src/config.ts");
  const s = deploymentSettings(cfg()) as { providers: { blocks: Record<string, { prices: Record<string, unknown> }> } };
  assert.deepEqual(s.providers.blocks.bedrock.prices, { "us.anthropic.claude-sonnet-4-6": { input: 3.3, output: 16.5, cache_read: 0.33, cache_write: 4.125 } });
  assert.deepEqual(s.providers.blocks.openrouter.prices, {});
  assert.match(priceWarning(cfg().providers)!, /^providers\.bedrock\.prices\.us\.bad is not usable/);
  assert.equal(priceWarning({ default: "x", x: { default_model: "m" } } as never), undefined);
});
