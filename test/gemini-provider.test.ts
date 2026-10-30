import { test } from "node:test";
import assert from "node:assert/strict";
import { GeminiProvider } from "../src/providers/gemini.ts";
import { TruncatedResponseError } from "../src/providers/types.ts";

const sseDelta = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`;
const sseFinish = (finish_reason: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason }] })}`;
const SSE_DONE = "data: [DONE]";

type Responder = (body: Record<string, unknown>) => {
  status?: number;
  errorBody?: string;
  lines?: string[];
  body?: (signal: AbortSignal) => AsyncIterable<Uint8Array>;
};

async function withStream<T>(
  responder: Responder,
  fn: (calls: Record<string, unknown>[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string, init: { body: string; signal: AbortSignal }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push(body);
    const { status = 200, errorBody, lines = [], body: custom } = responder(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => errorBody ?? "",
      body: custom
        ? custom(init.signal)
        : (async function* () {
            yield new TextEncoder().encode(lines.join("\n\n") + "\n\n");
          })(),
    };
  }) as unknown as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const req = {
  capability: "text" as const,
  model: "gemini-2.5-flash",
  messages: [{ role: "user" as const, content: "hello" }],
};

test("GeminiProvider: normal completion with stream", async () => {
  await withStream(
    () => ({ lines: [sseDelta("<p>Hello Gemini</p>"), sseFinish("stop"), SSE_DONE] }),
    async (calls) => {
      const provider = new GeminiProvider({
        api_key: "test-key",
        default_model: "gemini-2.5-flash",
      });
      const res = await provider.complete(req);
      assert.equal(res.text, "<p>Hello Gemini</p>");
      assert.equal(res.provider, "gemini");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].model, "gemini-2.5-flash");
      assert.equal(calls[0].stream, true);
    },
  );
});

test("GeminiProvider: finish_reason of length throws TruncatedResponseError", async () => {
  await withStream(
    () => ({ lines: [sseDelta("<p>Partial"), sseFinish("length"), SSE_DONE] }),
    async () => {
      const provider = new GeminiProvider({
        api_key: "test-key",
        default_model: "gemini-2.5-flash",
        max_tokens: 100,
      });
      await assert.rejects(
        () => provider.complete(req),
        (err: Error) => {
          assert.ok(err instanceof TruncatedResponseError);
          assert.equal((err as TruncatedResponseError).text, "<p>Partial");
          return true;
        },
      );
    },
  );
});

test("GeminiProvider: missing api_key throws informative error", () => {
  const oldGoogle = process.env.GOOGLE_API_KEY;
  const oldGemini = process.env.GEMINI_API_KEY;
  try {
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    assert.throws(
      () => new GeminiProvider({ default_model: "gemini-2.5-flash" }),
      /api_key is not configured/,
    );
  } finally {
    if (oldGoogle) process.env.GOOGLE_API_KEY = oldGoogle;
    if (oldGemini) process.env.GEMINI_API_KEY = oldGemini;
  }
});
