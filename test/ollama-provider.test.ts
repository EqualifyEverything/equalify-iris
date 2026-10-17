import { test } from "node:test";
import assert from "node:assert/strict";
import { OllamaProvider } from "../src/providers/ollama.ts";
import { TruncatedResponseError, StalledStreamError } from "../src/providers/types.ts";

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
  model: "minicpm-v",
  messages: [{ role: "user" as const, content: "hello ollama" }],
};

test("OllamaProvider: normal completion with stream", async () => {
  await withStream(
    () => ({ lines: [sseDelta("<p>Hello Ollama</p>"), sseFinish("stop"), SSE_DONE] }),
    async (calls) => {
      const provider = new OllamaProvider({
        default_model: "minicpm-v",
      });
      const res = await provider.complete(req);
      assert.equal(res.text, "<p>Hello Ollama</p>");
      assert.equal(res.provider, "ollama");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].model, "minicpm-v");
      assert.equal(calls[0].stream, true);
    },
  );
});

test("OllamaProvider: image multimodal request payload formatting", async () => {
  await withStream(
    () => ({ lines: [sseDelta("<p>Visual parsed</p>"), sseFinish("stop"), SSE_DONE] }),
    async (calls) => {
      const provider = new OllamaProvider({
        default_model: "minicpm-v",
      });
      const imgBuffer = Buffer.from("fake-png-bytes");
      const res = await provider.complete({
        capability: "vision",
        model: "minicpm-v",
        messages: [{ role: "user", content: "Transcribe this page" }],
        images: [{ data: imgBuffer, media_type: "image/png" }],
      });
      assert.equal(res.text, "<p>Visual parsed</p>");
      assert.equal(calls.length, 1);
      const userMsg = (calls[0].messages as any[])[0];
      assert.equal(userMsg.role, "user");
      assert.ok(Array.isArray(userMsg.content));
      assert.equal(userMsg.content[0].text, "Transcribe this page");
      assert.equal(userMsg.content[1].type, "image_url");
      assert.ok(userMsg.content[1].image_url.url.startsWith("data:image/png;base64,"));
    },
  );
});

test("OllamaProvider: finish_reason of length throws TruncatedResponseError", async () => {
  await withStream(
    () => ({ lines: [sseDelta("<p>Partial truncated"), sseFinish("length"), SSE_DONE] }),
    async () => {
      const provider = new OllamaProvider({
        default_model: "minicpm-v",
        max_tokens: 100,
      });
      await assert.rejects(
        () => provider.complete(req),
        (err: Error) => {
          assert.ok(err instanceof TruncatedResponseError);
          assert.equal((err as TruncatedResponseError).text, "<p>Partial truncated");
          return true;
        },
      );
    },
  );
});

test("OllamaProvider: stalls on first output aborts with StalledStreamError", async () => {
  const provider = new OllamaProvider(
    { default_model: "minicpm-v" },
    { firstOutputTimeoutMs: 30 },
  );

  await withStream(
    () => ({
      body: (_signal) =>
        (async function* () {
          await new Promise((r) => setTimeout(r, 100));
          yield new TextEncoder().encode(sseDelta("late"));
        })(),
    }),
    async () => {
      await assert.rejects(
        () => provider.complete(req),
        (err: Error) => {
          assert.ok(err instanceof StalledStreamError);
          assert.equal((err as StalledStreamError).kind, "first_output");
          return true;
        },
      );
    },
  );
});
