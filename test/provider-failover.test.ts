import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderRouter } from "../src/providers/index.ts";
import type { IrisConfig } from "../src/config.ts";

const sseDelta = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`;
const sseFinish = (finish_reason: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason }] })}`;
const SSE_DONE = "data: [DONE]";

const mockCfg: IrisConfig = {
  server: { port: 8080, base_url: "http://localhost:8080" },
  storage: { data_dir: "./data", agents_dir: "./agents", database: "./data/iris.sqlite" },

  providers: {
    default: "gemini",
    fallback: "ollama",
    gemini: {
      api_key: "test-gemini-key",
      default_model: "gemini-3.1-flash-lite",
      fallback: "ollama",
    },
    ollama: {
      default_model: "minicpm-v",
      base_url: "http://localhost:11434/v1",
    },
  },
  defaults: {
    max_review_iterations: 3,
    extraction_concurrency: 1,
    max_concurrent_runs: 2,
    recheck_sample_size: 1,
  },
};

test("ProviderRouter: auto-failover to Ollama when Gemini hits 429 quota error", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const events: { type: string; data: Record<string, unknown> }[] = [];

  globalThis.fetch = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url, body });

    // If request is directed to Google Gemini, simulate 429 Resource Exhausted error
    if (url.includes("generativelanguage.googleapis.com")) {
      return {
        ok: false,
        status: 429,
        text: async () => JSON.stringify({
          error: {
            code: 429,
            message: "Resource has been exhausted (e.g. check quota).",
            status: "RESOURCE_EXHAUSTED",
          },
        }),
      };
    }

    // If request is directed to Ollama fallback, return successful SSE stream
    return {
      ok: true,
      status: 200,
      text: async () => "",
      body: (async function* () {
        yield new TextEncoder().encode(
          [sseDelta("<main><h1>Recovered with Local Ollama</h1></main>"), sseFinish("stop"), SSE_DONE].join("\n\n") + "\n\n",
        );
      })(),
    };
  }) as unknown as typeof fetch;

  try {
    const router = new ProviderRouter(mockCfg, (type, data) => {
      events.push({ type, data });
    });

    const result = await router.complete("page", "vision", [{ role: "user", content: "Convert page" }], {
      step: "extract",
    });

    assert.equal(result.provider, "ollama");
    assert.equal(result.text, "<main><h1>Recovered with Local Ollama</h1></main>");

    // Verify failover event was recorded
    const failoverEvents = events.filter((e) => e.type === "provider_failover");
    assert.equal(failoverEvents.length, 1);
    assert.equal(failoverEvents[0].data.from_provider, "gemini");
    assert.equal(failoverEvents[0].data.to_provider, "ollama");
    assert.equal(failoverEvents[0].data.agent, "page");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
