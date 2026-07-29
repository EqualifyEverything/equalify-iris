// Provider-adapter behaviour, focused on the failure mode that has no downstream
// detector: a response cut off at the output-token ceiling.
//
// Truncation arrives as a 200 with partial content. A page of accessible HTML that
// stops mid-tag still parses well enough to be assembled into the deliverable,
// where it reads as content the source never had — so if the provider layer does
// not reject it, nothing else will. Both adapters must raise instead of returning
// the fragment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMaxTokens, DEFAULT_MAX_TOKENS } from "../src/config.ts";
import { OpenRouterProvider } from "../src/providers/openrouter.ts";
import { TruncatedResponseError } from "../src/providers/types.ts";

// --- normalizeMaxTokens -----------------------------------------------------

test("an unset max_tokens becomes the default, not zero", () => {
  // The trap this guards: YAML parses a valueless `max_tokens:` as null, and
  // Number(null) === 0 — a 0-token ceiling would empty every response.
  assert.equal(normalizeMaxTokens(undefined), DEFAULT_MAX_TOKENS);
  assert.equal(normalizeMaxTokens(null), DEFAULT_MAX_TOKENS);
  assert.equal(normalizeMaxTokens(""), DEFAULT_MAX_TOKENS);
  assert.equal(normalizeMaxTokens("   "), DEFAULT_MAX_TOKENS);
});

test("a garbage or meaningless max_tokens falls back rather than being obeyed", () => {
  assert.equal(normalizeMaxTokens("banana"), DEFAULT_MAX_TOKENS);
  assert.equal(normalizeMaxTokens(NaN), DEFAULT_MAX_TOKENS);
  // 0 and negatives are meaningless as an output ceiling and would silently empty
  // every response, so they mean "unset" rather than being passed through.
  assert.equal(normalizeMaxTokens(0), DEFAULT_MAX_TOKENS);
  assert.equal(normalizeMaxTokens(-500), DEFAULT_MAX_TOKENS);
});

test("a configured max_tokens is honoured, with no upper clamp", () => {
  assert.equal(normalizeMaxTokens(8192), 8192);
  assert.equal(normalizeMaxTokens("16000"), 16000);
  assert.equal(normalizeMaxTokens(4096.7), 4096); // floored
  // Deliberately unclamped: the provider rejects a value its model won't accept,
  // and that error names the real limit better than a guess compiled in here.
  assert.equal(normalizeMaxTokens(200_000), 200_000);
});

// --- OpenRouter truncation + payload ----------------------------------------

// Swap global fetch for one canned response, capturing the request body.
async function withFetch<T>(
  responder: (body: Record<string, unknown>) => { status?: number; json: unknown },
  fn: (calls: Record<string, unknown>[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push(body);
    const { status = 200, json } = responder(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
      text: async () => JSON.stringify(json),
    };
  }) as unknown as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const provider = (maxTokens?: number) =>
  new OpenRouterProvider({
    api_key: "test-key",
    base_url: "http://localhost:1/v1",
    default_model: "m",
    max_tokens: maxTokens,
  });

const req = {
  capability: "text" as const,
  model: "m",
  messages: [{ role: "user" as const, content: "hi" }],
};

test("a finish_reason of length is rejected, not returned as content", async () => {
  await withFetch(
    () => ({ json: { choices: [{ message: { content: "<table><tr><td>cut" }, finish_reason: "length" }] } }),
    async () => {
      await assert.rejects(
        () => provider(1000).complete(req),
        (e: Error) => {
          assert.ok(e instanceof TruncatedResponseError, `expected TruncatedResponseError, got ${e.name}`);
          // The message must name the knob to raise — this error is most likely to
          // be read by an operator who has never seen the code.
          assert.match(e.message, /output ceiling/);
          assert.match(e.message, /providers\.openrouter\.max_tokens/);
          return true;
        },
      );
    },
  );
});

test("a normal finish_reason returns the content untouched", async () => {
  await withFetch(
    () => ({ json: { choices: [{ message: { content: "<p>done</p>" }, finish_reason: "stop" }] } }),
    async () => {
      const res = await provider().complete(req);
      assert.equal(res.text, "<p>done</p>");
      assert.equal(res.provider, "openrouter");
    },
  );
});

test("a missing finish_reason is not treated as truncation", async () => {
  // Not every OpenRouter-compatible upstream returns the field. Absent must mean
  // "no evidence of truncation", not "assume the worst" — inventing a failure here
  // would break every such provider.
  await withFetch(
    () => ({ json: { choices: [{ message: { content: "<p>ok</p>" } }] } }),
    async () => {
      const res = await provider().complete(req);
      assert.equal(res.text, "<p>ok</p>");
    },
  );
});

test("the configured ceiling is sent on the request", async () => {
  await withFetch(
    () => ({ json: { choices: [{ message: { content: "x" }, finish_reason: "stop" }] } }),
    async (calls) => {
      await provider(12345).complete(req);
      assert.equal(calls[0].max_tokens, 12345);
    },
  );
});

test("a provider built without a ceiling still sends one", async () => {
  // Guards the regression this work fixes: OpenRouter previously sent NO
  // max_tokens, leaving the limit to whatever the upstream model defaulted to —
  // different per model, and silent when reached.
  await withFetch(
    () => ({ json: { choices: [{ message: { content: "x" }, finish_reason: "stop" }] } }),
    async (calls) => {
      await provider().complete(req);
      assert.equal(calls[0].max_tokens, DEFAULT_MAX_TOKENS);
    },
  );
});

test("truncation is not retried as if it were a network blip", async () => {
  // It is thrown from inside the retry loop, so this pins that it exits rather
  // than re-billing the same truncated generation three times.
  await withFetch(
    () => ({ json: { choices: [{ message: { content: "cut" }, finish_reason: "length" }] } }),
    async (calls) => {
      await assert.rejects(() => provider(50).complete(req), TruncatedResponseError);
      assert.equal(calls.length, 1, `expected 1 attempt, got ${calls.length}`);
    },
  );
});
