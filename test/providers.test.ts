// Provider-adapter behaviour, focused on the failure modes that have no downstream
// detector: a response cut off at the output-token ceiling, and a call abandoned
// because it went quiet.
//
// Truncation arrives as a 200 with partial content. A page of accessible HTML that
// stops mid-tag still parses well enough to be assembled into the deliverable,
// where it reads as content the source never had — so if the provider layer does
// not reject it, nothing else will. Both adapters must raise instead of returning
// the fragment.
//
// The Bedrock stall tests pin the distinction the streaming adapter exists to draw:
// slow-but-progressing work must survive, silence must not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMaxTokens, DEFAULT_MAX_TOKENS, type IrisConfig } from "../src/config.ts";
import { BedrockProvider } from "../src/providers/bedrock.ts";
import { OpenRouterProvider, normalizeUsage } from "../src/providers/openrouter.ts";
import { ProviderRouter } from "../src/providers/index.ts";
import { StalledStreamError, TruncatedResponseError, type Usage } from "../src/providers/types.ts";
import { summarizeRun } from "../src/diagnostics.ts";

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

// --- OpenRouter: streaming, truncation, payload ------------------------------

const sseDelta = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`;
const sseFinish = (finish_reason: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason }] })}`;
const SSE_DONE = "data: [DONE]";
// OpenRouter's keepalive while a request waits: an SSE comment, not an event.
const SSE_KEEPALIVE = ": OPENROUTER PROCESSING";

type Responder = (body: Record<string, unknown>) => {
  status?: number;
  errorBody?: string;
  lines?: string[];
  // Full control over framing/timing when the default one-shot body won't do.
  body?: (signal: AbortSignal) => AsyncIterable<Uint8Array>;
};

// Swap global fetch for one canned SSE response, capturing the request bodies.
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

const provider = (
  maxTokens?: number,
  timeouts?: { firstOutputTimeoutMs?: number; idleTimeoutMs?: number; maxTotalMs?: number },
) =>
  new OpenRouterProvider(
    {
      api_key: "test-key",
      base_url: "http://localhost:1/v1",
      default_model: "m",
      max_tokens: maxTokens,
    },
    timeouts,
  );

const req = {
  capability: "text" as const,
  model: "m",
  messages: [{ role: "user" as const, content: "hi" }],
};

test("a finish_reason of length is rejected, not returned as content", async () => {
  await withStream(
    () => ({ lines: [sseDelta("<table><tr><td>cut"), sseFinish("length"), SSE_DONE] }),
    async () => {
      await assert.rejects(
        () => provider(1000).complete(req),
        (e: Error) => {
          assert.ok(e instanceof TruncatedResponseError, `expected TruncatedResponseError, got ${e.name}`);
          // The message must name the knob to raise — this error is most likely to
          // be read by an operator who has never seen the code.
          assert.match(e.message, /output ceiling/);
          assert.match(e.message, /providers\.openrouter\.max_tokens/);
          // The fragment that did arrive is carried on the error rather than dropped, because the
          // review loop's log line quotes a few hundred characters of it and the round cannot be
          // asked again (#277). Both adapters, since either can be the one that truncates.
          assert.equal((e as TruncatedResponseError).text, "<table><tr><td>cut");
          return true;
        },
      );
    },
  );
});

test("a normal finish_reason returns the content untouched", async () => {
  await withStream(
    () => ({ lines: [sseDelta("<p>done</p>"), sseFinish("stop"), SSE_DONE] }),
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
  // would break every such provider. [DONE] is the completeness signal instead.
  await withStream(() => ({ lines: [sseDelta("<p>ok</p>"), SSE_DONE] }), async () => {
    const res = await provider().complete(req);
    assert.equal(res.text, "<p>ok</p>");
  });
});

test("the configured ceiling is sent on the request, and streaming is asked for", async () => {
  await withStream(
    () => ({ lines: [sseDelta("x"), sseFinish("stop"), SSE_DONE] }),
    async (calls) => {
      await provider(12345).complete(req);
      assert.equal(calls[0].max_tokens, 12345);
      // Without this the upstream answers in one shot and every stall limit below
      // is unreachable — the adapter would silently be back to a total-duration cap.
      assert.equal(calls[0].stream, true);
    },
  );
});

test("a provider built without a ceiling still sends one", async () => {
  // Guards the regression this work fixes: OpenRouter previously sent NO
  // max_tokens, leaving the limit to whatever the upstream model defaulted to —
  // different per model, and silent when reached.
  await withStream(
    () => ({ lines: [sseDelta("x"), sseFinish("stop"), SSE_DONE] }),
    async (calls) => {
      await provider().complete(req);
      assert.equal(calls[0].max_tokens, DEFAULT_MAX_TOKENS);
    },
  );
});

test("truncation is not retried as if it were a network blip", async () => {
  // It is thrown from inside the retry loop, so this pins that it exits rather
  // than re-billing the same truncated generation three times.
  await withStream(
    () => ({ lines: [sseDelta("cut"), sseFinish("length"), SSE_DONE] }),
    async (calls) => {
      await assert.rejects(() => provider(50).complete(req), TruncatedResponseError);
      assert.equal(calls.length, 1, `expected 1 attempt, got ${calls.length}`);
    },
  );
});

test("events are framed by newline, not by read boundary", async () => {
  // SSE arrives in arbitrary byte chunks: one read can split an event mid-JSON or
  // carry several. Feeding it a byte at a time is the strongest version of that —
  // it also splits the multi-byte characters real documents contain, which a
  // decoder used without `stream: true` would corrupt into replacement chars.
  const payload = [sseDelta("café — naïve"), sseDelta(" 日本語"), sseFinish("stop"), SSE_DONE].join("\n\n");
  await withStream(
    () => ({
      body: () =>
        (async function* () {
          for (const byte of new TextEncoder().encode(payload)) yield new Uint8Array([byte]);
        })(),
    }),
    async () => {
      const res = await provider().complete(req);
      assert.equal(res.text, "café — naïve 日本語");
    },
  );
});

test("a slow but progressing stream outlives the idle window", async () => {
  // Same guarantee as Bedrock: total duration (~360ms) is well past the 200ms idle
  // limit, but no single gap is, so the call must finish. This is the copy_editor
  // call that died at two minutes under the old total-duration cap.
  await withStream(
    () => ({
      body: (signal) =>
        (async function* () {
          const enc = new TextEncoder();
          for (let i = 0; i < 6; i++) {
            await sleepUnlessAborted(60, signal);
            yield enc.encode(sseDelta(`chunk${i} `) + "\n\n");
          }
          yield enc.encode([sseFinish("stop"), SSE_DONE].join("\n\n") + "\n\n");
        })(),
    }),
    async () => {
      const res = await provider(undefined, { idleTimeoutMs: 200 }).complete(req);
      assert.equal(res.text, "chunk0 chunk1 chunk2 chunk3 chunk4 chunk5 ");
    },
  );
});

test("keepalive comments do not pass for progress", async () => {
  // `: OPENROUTER PROCESSING` says the provider is still there, not that the model
  // is producing anything. If it re-armed the clock, a hung generation behind a
  // chatty connection would run to the 15-minute backstop instead of failing.
  await withStream(
    () => ({
      body: (signal) =>
        (async function* () {
          const enc = new TextEncoder();
          for (;;) {
            await sleepUnlessAborted(30, signal);
            yield enc.encode(SSE_KEEPALIVE + "\n\n");
          }
        })(),
    }),
    async () => {
      await assert.rejects(
        () => provider(undefined, { firstOutputTimeoutMs: 150, maxTotalMs: 60_000 }).complete(req),
        (e: Error) => {
          assert.ok(e instanceof StalledStreamError, `expected StalledStreamError, got ${e.name}`);
          assert.equal((e as StalledStreamError).kind, "first_output");
          assert.match(e.message, /never started/);
          return true;
        },
      );
    },
  );
});

test("waiting for the first token is a different failure from stalling halfway", async () => {
  // Once output has started, the tighter idle window applies — and the error says
  // how much had arrived, which is what distinguishes the two diagnoses.
  await withStream(
    () => ({
      body: (signal) =>
        (async function* () {
          const enc = new TextEncoder();
          yield enc.encode(sseDelta("half a doc") + "\n\n");
          for (;;) {
            await sleepUnlessAborted(30, signal);
            yield enc.encode(SSE_KEEPALIVE + "\n\n"); // chatty, but producing nothing
          }
        })(),
    }),
    async () => {
      await assert.rejects(
        () =>
          provider(undefined, {
            firstOutputTimeoutMs: 60_000, // generous: this call DID start producing
            idleTimeoutMs: 150,
            maxTotalMs: 60_000,
          }).complete(req),
        (e: Error) => {
          assert.ok(e instanceof StalledStreamError, `expected StalledStreamError, got ${e.name}`);
          assert.equal((e as StalledStreamError).kind, "idle");
          assert.match(e.message, /10 chars had streamed/);
          return true;
        },
      );
    },
  );
});

test("an opening role delta does not spend the first-output window", async () => {
  // The OpenAI convention, which OpenRouter forwards: the stream opens with a
  // role-only delta as soon as the request is accepted, carrying no output. Treating
  // an event as "generation began" would swap the generous start-up window for the
  // tight idle one before a token existed — quietly halving the advertised budget on
  // exactly the slow-to-start call this work exists to keep alive.
  await withStream(
    () => ({
      body: (signal) =>
        (async function* () {
          const enc = new TextEncoder();
          yield enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "" } }] })}\n\n`);
          await sleepUnlessAborted(200, signal); // past idle, inside first-output
          yield enc.encode([sseDelta("finally"), sseFinish("stop"), SSE_DONE].join("\n\n") + "\n\n");
        })(),
    }),
    async () => {
      const res = await provider(undefined, {
        firstOutputTimeoutMs: 60_000,
        idleTimeoutMs: 80,
      }).complete(req);
      assert.equal(res.text, "finally");
    },
  );
});

test("[DONE] ends the read, so a body held open cannot fail a whole document", async () => {
  // Same rule as Bedrock's message_stop: the message ending and the connection
  // ending are different events, and waiting for the second would let the idle clock
  // fire on a response that is already complete.
  await withStream(
    () => ({
      body: (signal) =>
        (async function* () {
          const enc = new TextEncoder();
          yield enc.encode([sseDelta("<p>complete</p>"), sseFinish("stop"), SSE_DONE].join("\n\n") + "\n\n");
          await sleepUnlessAborted(60_000, signal); // upstream never closes
        })(),
    }),
    async () => {
      const res = await provider(undefined, { idleTimeoutMs: 100 }).complete(req);
      assert.equal(res.text, "<p>complete</p>");
    },
  );
});

test("a stream that ends early is not accepted as a finished document", async () => {
  await withStream(() => ({ lines: [sseDelta("<p>half")] }), async () => {
    await assert.rejects(
      () => provider().complete(req),
      (e: Error) => {
        assert.match(e.message, /ended without completing/);
        assert.match(e.message, /7 chars received/);
        return true;
      },
    );
  });
});

test("a failure reported mid-stream is raised, not returned as a short document", async () => {
  await withStream(
    () => ({ lines: [sseDelta("<p>partial"), `data: ${JSON.stringify({ error: { message: "upstream is down" } })}`] }),
    async () => {
      await assert.rejects(
        () => provider().complete(req),
        (e: Error) => {
          assert.match(e.message, /stream error/);
          assert.match(e.message, /upstream is down/);
          return true;
        },
      );
    },
  );
});

test("an unreadable event fails the call rather than being skipped", async () => {
  // A data line we cannot parse is content we cannot account for; dropping it is
  // how a short document passes for a whole one.
  await withStream(() => ({ lines: [sseDelta("<p>ok"), "data: {not json", SSE_DONE] }), async () => {
    await assert.rejects(
      () => provider().complete(req),
      (e: Error) => {
        assert.match(e.message, /unparseable stream event/);
        return true;
      },
    );
  });
});

test("a transient failure is retried only while nothing has been generated", async () => {
  // The retry exists for a proxy resetting a large request body, which happens
  // before any output. Once tokens have arrived, retrying re-bills a long
  // generation — and the accumulator must be per-attempt, or the retry would
  // concatenate onto the abandoned attempt and deliver the passage twice.
  await withStream(
    (body) => ({
      body: () =>
        (async function* () {
          void body;
          const enc = new TextEncoder();
          yield enc.encode(sseDelta("first half") + "\n\n");
          throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } });
        })(),
    }),
    async (calls) => {
      await assert.rejects(() => provider().complete(req), /ECONNRESET|fetch failed/);
      assert.equal(calls.length, 1, `expected no retry after output, got ${calls.length} attempts`);
    },
  );

  // The mirror case: nothing streamed, so the retry still happens — and the text
  // comes only from the attempt that succeeded.
  let attempt = 0;
  await withStream(
    () => {
      attempt++;
      return attempt === 1
        ? {
            body: () =>
              (async function* () {
                yield* [];
                throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } });
              })(),
          }
        : { lines: [sseDelta("clean run"), sseFinish("stop"), SSE_DONE] };
    },
    async (calls) => {
      const res = await provider().complete(req);
      assert.equal(res.text, "clean run");
      assert.equal(calls.length, 2, `expected 1 retry, got ${calls.length} attempts`);
    },
  );
});

// --- Bedrock streaming: slow work vs. a stalled stream ----------------------

const encode = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const textDelta = (text: string) => ({
  chunk: { bytes: encode({ type: "content_block_delta", delta: { type: "text_delta", text } }) },
});
const messageDelta = (stop_reason: string) => ({
  chunk: { bytes: encode({ type: "message_delta", delta: { stop_reason } }) },
});
const ping = () => ({ chunk: { bytes: encode({ type: "ping" }) } });

// Exactly what the AWS SDK throws when an abortSignal fires: a bare Error whose
// message is "Request aborted" (@smithy/node-http-handler/build-abort-error). The
// tests below assert this string never reaches the caller — it is the opaque
// failure the streaming adapter was written to replace.
const abortError = () => Object.assign(new Error("Request aborted"), { name: "AbortError" });

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Replace the adapter's SDK client with one returning a scripted event stream.
function stubStream(
  bedrock: BedrockProvider,
  script: (signal: AbortSignal) => AsyncIterable<unknown>,
): void {
  (bedrock as unknown as { client: unknown }).client = {
    send: async (_cmd: unknown, opts: { abortSignal: AbortSignal }) => ({
      body: script(opts.abortSignal),
    }),
  };
}

const bedrockReq = {
  capability: "vision" as const,
  model: "us.anthropic.claude-sonnet-4-6",
  messages: [{ role: "user" as const, content: "fix this document" }],
};

test("streamed text deltas are concatenated into the result", async () => {
  const bedrock = new BedrockProvider({ default_model: "m", region: "us-east-2" });
  stubStream(bedrock, async function* () {
    yield { chunk: { bytes: encode({ type: "message_start" }) } };
    yield textDelta("<h1>Title</h1>");
    yield textDelta("<p>Body</p>");
    yield messageDelta("end_turn");
  });
  const res = await bedrock.complete(bedrockReq);
  assert.equal(res.text, "<h1>Title</h1><p>Body</p>");
  assert.equal(res.provider, "bedrock");
  assert.equal(res.model, "us.anthropic.claude-sonnet-4-6");
});

test("a slow but progressing stream outlives the idle timeout", async () => {
  // The actual regression this work fixes. Total duration (~360ms) is well past the
  // 200ms idle limit, but no single gap is — so the call must complete. Under the
  // old total-duration timeout this is precisely the call that got killed.
  const bedrock = new BedrockProvider({ default_model: "m" }, { idleTimeoutMs: 200 });
  stubStream(bedrock, async function* (signal) {
    for (let i = 0; i < 6; i++) {
      await sleepUnlessAborted(60, signal);
      yield textDelta(`chunk${i} `);
    }
    yield messageDelta("end_turn");
  });
  const res = await bedrock.complete(bedrockReq);
  assert.equal(res.text, "chunk0 chunk1 chunk2 chunk3 chunk4 chunk5 ");
});

test("a stream that goes quiet fails with a message that explains itself", async () => {
  const bedrock = new BedrockProvider({ default_model: "m" }, { idleTimeoutMs: 120 });
  stubStream(bedrock, async function* (signal) {
    yield textDelta("some output");
    await sleepUnlessAborted(60_000, signal); // silence until the idle clock fires
    yield textDelta("never arrives");
  });
  await assert.rejects(
    () => bedrock.complete(bedrockReq),
    (e: Error) => {
      assert.ok(e instanceof StalledStreamError, `expected StalledStreamError, got ${e.name}`);
      assert.equal((e as StalledStreamError).kind, "idle");
      // The opaque SDK string must not be what an operator or user ends up reading.
      assert.doesNotMatch(e.message, /Request aborted/);
      // It must name the model, and how much had streamed — the two facts that
      // distinguish "stalled at the start" from "stalled three quarters through".
      assert.match(e.message, /us\.anthropic\.claude-sonnet-4-6/);
      assert.match(e.message, /11 chars had streamed/);
      return true;
    },
  );
});

test("a call that never produces anything is caught, and named as such", async () => {
  // The clock has to start before the request, not at the first chunk: a call that
  // sends nothing at all would otherwise run to the 15-minute backstop and report
  // itself as work that did not converge — the opposite diagnosis.
  const bedrock = new BedrockProvider(
    { default_model: "m" },
    { firstOutputTimeoutMs: 100, maxTotalMs: 60_000 },
  );
  stubStream(bedrock, async function* (signal) {
    await sleepUnlessAborted(60_000, signal);
    yield textDelta("never");
  });
  await assert.rejects(
    () => bedrock.complete(bedrockReq),
    (e: Error) => {
      assert.ok(e instanceof StalledStreamError);
      assert.equal((e as StalledStreamError).kind, "first_output");
      // "never started", not "stopped sending": a call that produced nothing must
      // not be reported as one that died halfway.
      assert.match(e.message, /before it produced anything/);
      assert.match(e.message, /never started/);
      assert.doesNotMatch(e.message, /Request aborted/);
      return true;
    },
  );
});

test("prompt processing gets the generous window, not the idle one", async () => {
  // Before the first token there is nothing to distinguish a slow start from a dead
  // socket, and that phase is where a whole document plus eight page images gets
  // processed — the request that prompted this work. If a protocol event handed over
  // to the shorter idle window here, this call would fail after 60s: sooner than the
  // total cap streaming replaced, on the very request it was meant to rescue.
  const bedrock = new BedrockProvider(
    { default_model: "m" },
    { firstOutputTimeoutMs: 400, idleTimeoutMs: 60, maxTotalMs: 60_000 },
  );
  stubStream(bedrock, async function* (signal) {
    await sleepUnlessAborted(120, signal);
    yield { chunk: { bytes: encode({ type: "message_start" }) } };
    await sleepUnlessAborted(120, signal); // longer than idle, shorter than first-output
    yield { chunk: { bytes: encode({ type: "content_block_start" }) } };
    await sleepUnlessAborted(120, signal);
    yield textDelta("finally");
    yield messageDelta("end_turn");
  });
  const res = await bedrock.complete(bedrockReq);
  assert.equal(res.text, "finally");
});

test("a stream that trickles forever is stopped by the absolute ceiling", async () => {
  // Never idle, never done: satisfies the idle timeout indefinitely while holding a
  // concurrency slot. The backstop must distinguish itself from a stall.
  const bedrock = new BedrockProvider({ default_model: "m" }, { idleTimeoutMs: 5_000, maxTotalMs: 150 });
  stubStream(bedrock, async function* (signal) {
    for (;;) {
      await sleepUnlessAborted(20, signal);
      yield textDelta("x");
    }
  });
  await assert.rejects(
    () => bedrock.complete(bedrockReq),
    (e: Error) => {
      assert.ok(e instanceof StalledStreamError, `expected StalledStreamError, got ${e.name}`);
      assert.equal((e as StalledStreamError).kind, "total");
      assert.match(e.message, /absolute ceiling/);
      assert.doesNotMatch(e.message, /Request aborted/);
      return true;
    },
  );
});

test("truncation is still caught when the stop reason arrives mid-stream", async () => {
  // stop_reason rides the closing message_delta rather than a top-level field now,
  // so the guard has to read it off the stream or truncated HTML flows downstream.
  const bedrock = new BedrockProvider({ default_model: "m", max_tokens: 32_000 });
  stubStream(bedrock, async function* () {
    yield textDelta("<table><tr><td>cut");
    yield messageDelta("max_tokens");
  });
  await assert.rejects(
    () => bedrock.complete(bedrockReq),
    (e: Error) => {
      assert.ok(e instanceof TruncatedResponseError, `expected TruncatedResponseError, got ${e.name}`);
      assert.match(e.message, /providers\.bedrock\.max_tokens/);
      assert.equal((e as TruncatedResponseError).chars, 18);
      assert.equal((e as TruncatedResponseError).text, "<table><tr><td>cut");
      return true;
    },
  );
});

test("keepalive pings do not pass for progress", async () => {
  // A ping is the transport saying it is alive, not the model producing anything.
  // If it reset the idle clock, a generation that hangs on a chatty connection
  // would defeat the timeout entirely and run to the 15-minute backstop — and then
  // report itself as too large, the opposite diagnosis.
  const bedrock = new BedrockProvider({ default_model: "m" }, { idleTimeoutMs: 150, maxTotalMs: 60_000 });
  stubStream(bedrock, async function* (signal) {
    yield textDelta("real output");
    for (;;) {
      await sleepUnlessAborted(30, signal); // chatty, but nothing is being produced
      yield ping();
    }
  });
  await assert.rejects(
    () => bedrock.complete(bedrockReq),
    (e: Error) => {
      assert.ok(e instanceof StalledStreamError, `expected StalledStreamError, got ${e.name}`);
      assert.equal((e as StalledStreamError).kind, "idle", "a ping stream must read as idle, not as work");
      return true;
    },
  );
});

test("protocol events between blocks still count as progress", async () => {
  // The other half of the ping rule, in the phase where the tight window applies:
  // once text has arrived a content_block_stop or a block boundary is real progress
  // and must re-arm the idle clock, or a model that pauses between blocks is killed
  // for being slow — the bug this work fixes, at a lower threshold.
  const bedrock = new BedrockProvider(
    { default_model: "m" },
    { firstOutputTimeoutMs: 60_000, idleTimeoutMs: 150 },
  );
  stubStream(bedrock, async function* (signal) {
    yield textDelta("first block");
    await sleepUnlessAborted(100, signal);
    yield { chunk: { bytes: encode({ type: "content_block_stop" }) } };
    await sleepUnlessAborted(100, signal);
    yield { chunk: { bytes: encode({ type: "content_block_start" }) } };
    await sleepUnlessAborted(100, signal); // 300ms total, past the 150ms idle limit
    yield textDelta(" second block");
    yield messageDelta("end_turn");
  });
  const res = await bedrock.complete(bedrockReq);
  assert.equal(res.text, "first block second block");
});

test("message_stop ends the read, so a body held open cannot fail a whole document", async () => {
  // The message being over and the connection being over are different events. If
  // the loop waited for the body to close, anything holding it open would let the
  // idle clock fire on a response that is already complete — discarding a finished
  // document as a stall, and leaving a live timer on every successful call.
  const bedrock = new BedrockProvider({ default_model: "m" }, { idleTimeoutMs: 100 });
  stubStream(bedrock, async function* (signal) {
    yield textDelta("<p>complete</p>");
    yield messageDelta("end_turn");
    yield { chunk: { bytes: encode({ type: "message_stop" }) } };
    await sleepUnlessAborted(60_000, signal); // upstream never closes
  });
  const res = await bedrock.complete(bedrockReq);
  assert.equal(res.text, "<p>complete</p>");
});

test("a stream that ends early is not accepted as a finished document", async () => {
  // The iterator finishing is not the response finishing. An event stream that
  // stops without erroring would otherwise return HTML cut mid-tag as a success,
  // which is what TruncatedResponseError exists to prevent — same delivered
  // failure, different road.
  const bedrock = new BedrockProvider({ default_model: "m" });
  stubStream(bedrock, async function* () {
    yield { chunk: { bytes: encode({ type: "message_start" }) } };
    yield textDelta("<table><tr><td>half a document");
    // no message_delta, no message_stop: the stream just ends
  });
  await assert.rejects(
    () => bedrock.complete(bedrockReq),
    (e: Error) => {
      assert.match(e.message, /ended without completing/);
      assert.match(e.message, /30 chars received/);
      return true;
    },
  );
});

test("an abort whose stream ends quietly still fails as a stall", async () => {
  // Not every abort surfaces as a throw — a stream can respond to the signal by
  // simply returning. `expired` is therefore re-checked after the loop, or this
  // path returns partial output as a success with no error anywhere.
  const bedrock = new BedrockProvider({ default_model: "m" }, { idleTimeoutMs: 100 });
  stubStream(bedrock, async function* (signal) {
    yield textDelta("partial");
    // Wait for the idle clock, then end the stream cleanly instead of throwing.
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  await assert.rejects(
    () => bedrock.complete(bedrockReq),
    (e: Error) => {
      assert.ok(e instanceof StalledStreamError, `expected StalledStreamError, got ${e.name}`);
      assert.equal((e as StalledStreamError).kind, "idle");
      assert.match(e.message, /7 chars had streamed/);
      return true;
    },
  );
});

test("a normal stream ending in message_stop needs no stop_reason", async () => {
  // Guards the completeness check against being too strict: message_stop alone is
  // a legitimate end, and demanding both would fail every healthy call.
  const bedrock = new BedrockProvider({ default_model: "m" });
  stubStream(bedrock, async function* () {
    yield textDelta("<p>done</p>");
    yield { chunk: { bytes: encode({ type: "message_stop" }) } };
  });
  const res = await bedrock.complete(bedrockReq);
  assert.equal(res.text, "<p>done</p>");
});

// --- Token accounting -------------------------------------------------------
//
// Tokens are what a run costs, and the two halves of the count arrive at opposite
// ends of a stream: the prompt's size with the first event, the output's with the
// last. So the tests below pin three things — that both halves survive into one
// result, that a call which never reaches the end still reports the half it knows
// (the expensive failures are exactly these), and that a cache hit is not counted
// twice when it arrives in OpenAI's vocabulary rather than Anthropic's.

const messageStartUsage = (usage: Usage) => ({
  chunk: { bytes: encode({ type: "message_start", message: { usage } }) },
});
const messageDeltaUsage = (stop_reason: string, usage: Usage) => ({
  chunk: { bytes: encode({ type: "message_delta", delta: { stop_reason }, usage }) },
});

test("the prompt's tokens and the output's are merged, not overwritten", async () => {
  // message_start carries one half and the closing message_delta the other. Replacing
  // rather than merging would silently drop the input counts — which on a vision call
  // carrying page images are the larger number.
  const bedrock = new BedrockProvider({ default_model: "m" });
  stubStream(bedrock, async function* () {
    yield messageStartUsage({
      input_tokens: 4200,
      cache_read_input_tokens: 1024,
      cache_creation_input_tokens: 0,
      output_tokens: 1,
    });
    yield textDelta("<p>done</p>");
    yield messageDeltaUsage("end_turn", { output_tokens: 830 });
  });
  const res = await bedrock.complete(bedrockReq);
  assert.deepEqual(res.usage, {
    input_tokens: 4200,
    cache_read_input_tokens: 1024,
    cache_creation_input_tokens: 0,
    output_tokens: 830,
  });
});

test("a call that reports nothing leaves usage absent rather than zero", async () => {
  // Absent and zero are different claims: one is "not reported", the other "free".
  // A cost summed over the second would look complete while covering nothing.
  const bedrock = new BedrockProvider({ default_model: "m" });
  stubStream(bedrock, async function* () {
    yield textDelta("<p>done</p>");
    yield messageDelta("end_turn");
  });
  const res = await bedrock.complete(bedrockReq);
  assert.equal(res.usage, undefined);
});

test("a truncated call still accounts for what it spent", async () => {
  // It has already paid for a full ceiling of output, so this is the last call whose
  // cost should go unrecorded. Nothing rides the return path here — complete() throws
  // — which is why usage is reported through a callback as it accumulates.
  const bedrock = new BedrockProvider({ default_model: "m", max_tokens: 32_000 });
  stubStream(bedrock, async function* () {
    yield messageStartUsage({ input_tokens: 9100 });
    yield textDelta("<table><tr><td>cut");
    yield messageDeltaUsage("max_tokens", { output_tokens: 32_000 });
  });
  let seen: Usage | undefined;
  await assert.rejects(
    () => bedrock.complete({ ...bedrockReq, onUsage: (u) => void (seen = u) }),
    TruncatedResponseError,
  );
  assert.deepEqual(seen, { input_tokens: 9100, output_tokens: 32_000 });
});

test("a stalled call reports the prompt it already paid for", async () => {
  // The prompt was processed before the silence began — on a vision call that is a
  // document's worth of page images, billed whether or not anything came back.
  const bedrock = new BedrockProvider({ default_model: "m" }, { idleTimeoutMs: 100 });
  stubStream(bedrock, async function* (signal) {
    yield messageStartUsage({ input_tokens: 15_400, cache_read_input_tokens: 2048 });
    yield textDelta("half a doc");
    await sleepUnlessAborted(60_000, signal);
  });
  let seen: Usage | undefined;
  await assert.rejects(
    () => bedrock.complete({ ...bedrockReq, onUsage: (u) => void (seen = u) }),
    StalledStreamError,
  );
  // No output_tokens key at all, rather than a zero: nothing finished, so no output
  // count exists to report. deepEqual is strict about the difference.
  assert.deepEqual(seen, { input_tokens: 15_400, cache_read_input_tokens: 2048 });
});

test("OpenRouter's usage chunk is read off a chunk that carries no choices", async () => {
  // It arrives late and on its own, after finish_reason and before [DONE] — so a
  // reader that only looked inside `choices[0]` would never see it.
  const sseUsage = (usage: Record<string, unknown>) =>
    `data: ${JSON.stringify({ choices: [], usage })}`;
  await withStream(
    () => ({
      lines: [
        sseDelta("<p>ok</p>"),
        sseFinish("stop"),
        sseUsage({
          prompt_tokens: 4300,
          completion_tokens: 820,
          prompt_tokens_details: { cached_tokens: 1024 },
        }),
        SSE_DONE,
      ],
    }),
    async () => {
      const res = await provider().complete(req);
      // 4300 - 1024: the cached tokens are inside prompt_tokens in this vocabulary,
      // and billing them at the full input rate as well as the cache rate would
      // overstate the cost of the one thing that makes it cheaper.
      assert.deepEqual(res.usage, {
        input_tokens: 3276,
        output_tokens: 820,
        cache_read_input_tokens: 1024,
      });
    },
  );
});

test("only the four token counts leave the adapter, not whatever else the upstream sent", async () => {
  // `message_start.message.usage` carries more than the four fields `Usage` declares —
  // `service_tier` and a nested `cache_creation` breakdown today, more after any model
  // release. It matters because the router spreads usage FLAT onto the `model_call` log
  // line: passed through, an unknown scalar becomes a log field nobody declared and a
  // nested object breaks the one-level-deep shape that spread depends on.
  const bedrock = new BedrockProvider({ default_model: "m" });
  stubStream(bedrock, async function* () {
    yield {
      chunk: {
        bytes: encode({
          type: "message_start",
          message: {
            usage: {
              input_tokens: 4200,
              cache_read_input_tokens: 1024,
              service_tier: "standard",
              cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
            },
          },
        }),
      },
    };
    yield textDelta("<p>done</p>");
    yield messageDeltaUsage("end_turn", { output_tokens: 830 });
  });
  const res = await bedrock.complete(bedrockReq);
  assert.deepEqual(res.usage, {
    input_tokens: 4200,
    cache_read_input_tokens: 1024,
    output_tokens: 830,
  });
});

test("a retried call is billed for both attempts, not only the one that survived", async () => {
  // Retries fire only while nothing has been generated, so usually little or nothing
  // has been reported yet — but where an attempt did report before dying, its tokens
  // were spent. Counting only the survivor understates the call INVISIBLY: the run
  // still reads as fully accounted for, because the call reported something and
  // `tokens.calls_reported` counts calls, not attempts.
  const usageChunk = (prompt: number, completion: number) =>
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion } })}`;
  let attempt = 0;
  await withStream(
    () => {
      attempt++;
      return attempt === 1
        ? {
            body: () =>
              (async function* () {
                yield new TextEncoder().encode(usageChunk(3000, 0) + "\n\n");
                throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } });
              })(),
          }
        : { lines: [sseDelta("clean run"), sseFinish("stop"), usageChunk(3000, 400), SSE_DONE] };
    },
    async (calls) => {
      const seen: Usage[] = [];
      const res = await provider().complete({ ...req, onUsage: (u) => void seen.push(u) });
      assert.equal(calls.length, 2, `expected 1 retry, got ${calls.length} attempts`);
      // The text comes from the surviving attempt alone; the prompt was paid for twice.
      assert.equal(res.text, "clean run");
      assert.deepEqual(res.usage, { input_tokens: 6000, output_tokens: 400 });
      // And the callback never reported less than the total spent so far, since it is
      // what the router logs when the call ends by throwing.
      assert.deepEqual(seen[0], { input_tokens: 3000, output_tokens: 0 });
      assert.deepEqual(seen[seen.length - 1], { input_tokens: 6000, output_tokens: 400 });
    },
  );
});

test("the field names the adapter emits are the ones diagnostics reads", async () => {
  // The seam this pins is two string literals in two files: `Usage`'s keys in
  // providers/types.ts, spread onto the `model_call` event by the router, read back by
  // name in diagnostics.ts. Nothing else exercises the join — the adapter tests stop at
  // complete(), the diagnostics tests start from hand-written log lines — so dropping
  // the spread, or renaming a key on one side, would turn every published count to 0
  // with the rest of the suite green. That is the failure this feature exists to fix:
  // `grep -rn usage src/` finding nothing while the bill kept arriving.
  const cfg = {
    providers: {
      default: "openrouter",
      openrouter: { api_key: "k", base_url: "http://localhost:1/v1", default_model: "m" },
    },
  } as unknown as IrisConfig;
  const lines: string[] = [];
  const router = new ProviderRouter(cfg, (type, data) =>
    // Exactly how RunLog writes it: one flat line per event, ts first.
    lines.push(JSON.stringify({ ts: new Date(0).toISOString(), type, ...data })),
  );
  await withStream(
    () => ({
      lines: [
        sseDelta("<p>ok</p>"),
        sseFinish("stop"),
        `data: ${JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: 5000,
            completion_tokens: 900,
            prompt_tokens_details: { cached_tokens: 1000 },
          },
        })}`,
        SSE_DONE,
      ],
    }),
    async () => {
      await router.complete("page", "vision", [{ role: "user", content: "hi" }], { step: "extract" });
    },
  );
  const d = summarizeRun(lines.join("\n") + "\n", {
    sessionId: "s",
    status: "ready_for_review",
    phase: "done",
    now: 1000,
  });
  assert.deepEqual(d.tokens, {
    input: 4000, // 5000 prompt tokens less the 1000 that came from the cache
    output: 900,
    cache_read: 1000,
    cache_write: 0,
    calls_reported: 1,
  });
  assert.equal(d.by_agent.page.input_tokens, 4000);
  assert.equal(d.by_agent.page.output_tokens, 900);
  // The cache counts cross the same seam, and a cache read is the one an agent-level
  // reader most needs: it is the difference between "this agent is cheap" and "this
  // agent is cheap because it is hitting the cache".
  assert.equal(d.by_agent.page.cache_read_input_tokens, 1000);
});

// --- the output-ceiling clamp reaching the run log (#254) --------------------------------
//
// The adapter's side of this is test/bedrock-output-ceiling.test.ts, which stops at the
// `onNote` callback. What is pinned here is the other half of the seam: the router turning
// those notes into flat fields on `model_call`. Nothing else crosses it — a dropped spread
// would leave a wrong `providers.bedrock.max_tokens` exactly as invisible as it was before
// the feature, with both files' unit tests green.
const CLAMPED_NOVA = "amazon.nova-pro-v1:0";
const NOVA_CEILING_REFUSAL =
  "The maximum tokens you requested exceeds the model limit of 10000. " +
  "Try again with a maximum tokens value that is lower than 10000.";

// A router over one Bedrock block, with the adapter it will use already built and its SDK
// client scripted by the ceiling each attempt asks for. Scripted that way rather than by
// attempt number because the point of these tests is which request went out at which
// ceiling. Returns the `model_call*` events, flat, as RunLog would write them.
function clampingRouter(
  block: Record<string, unknown>,
  refuse: (asked: number) => string | null,
): { events: { type: string; data: Record<string, unknown> }[]; run: () => Promise<unknown> } {
  const cfg = {
    providers: { default: "bedrock", bedrock: block },
  } as unknown as IrisConfig;
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const router = new ProviderRouter(cfg, (type, data) => events.push({ type, data }));
  const bedrock = (router as unknown as { build(n: string): BedrockProvider }).build("bedrock");
  (bedrock as unknown as { client: unknown }).client = {
    send: async (cmd: { input: { inferenceConfig: { maxTokens: number } } }) => {
      const message = refuse(cmd.input.inferenceConfig.maxTokens);
      if (message) {
        const e = new Error(message);
        e.name = "ValidationException";
        throw e;
      }
      return {
        stream: (async function* () {
          yield { contentBlockDelta: { delta: { text: "<p>page</p>" }, contentBlockIndex: 0 } };
          yield { messageStop: { stopReason: "end_turn" } };
        })(),
      };
    },
  };
  return {
    events,
    run: () => router.complete("page", "vision", [{ role: "user", content: "hi" }], { step: "extract" }),
  };
}

// The adapter says its paragraph on stderr and these tests are not about that.
async function quietly<T>(body: () => Promise<T>): Promise<T> {
  const original = console.warn;
  console.warn = () => {};
  try {
    return await body();
  } finally {
    console.warn = original;
  }
}

const modelCalls = (events: { type: string; data: Record<string, unknown> }[]) =>
  events.filter((e) => e.type === "model_call").map((e) => e.data);

test("a clamped call names both ceilings on its model_call line, and every later page does too", async () => {
  const { events, run } = clampingRouter(
    { default_model: CLAMPED_NOVA, api: "converse" },
    (asked) => (asked > 10_000 ? NOVA_CEILING_REFUSAL : null),
  );
  await quietly(async () => {
    for (const _ of [1, 2, 3]) await run();
  });
  const calls = modelCalls(events);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.ok, true);
    // The pair an operator acts on: `max_tokens` says 32000, this model grants 10000.
    assert.equal(call.output_ceiling_clamped, true);
    assert.equal(call.output_ceiling_asked, 32_000);
    assert.equal(call.output_ceiling_stated, 10_000);
    // Flat, like usage: a nested object here would not be summable off the line, and
    // diagnostics reads these by name.
    assert.equal(call.model, CLAMPED_NOVA);
  }
  // Only the first call paid for the lesson, and `duration_ms` on that one line covers two
  // requests. That is the whole of what the extra field says, and it is why the fields are not
  // read as a count of rejected round-trips.
  assert.equal(calls[0].output_ceiling_refused, true);
  assert.equal("output_ceiling_refused" in calls[1], false);
  assert.equal("output_ceiling_refused" in calls[2], false);
  // The start marker is emitted before the call and cannot know any of this.
  const started = events.filter((e) => e.type === "model_call_start");
  assert.equal(started.length, 3);
  for (const s of started) assert.equal("output_ceiling_clamped" in s.data, false);
});

test("a call refused twice logs the ceiling it started at and the one it ended at", async () => {
  // Two notes on one `complete`, and the router keeps the widest span across them. Keeping only
  // the latest would log `asked: 10000` — a number this deployment never configured — and the
  // line would stop saying what `max_tokens` is wrong against.
  const { events, run } = clampingRouter(
    { default_model: CLAMPED_NOVA, api: "converse" },
    (asked) =>
      asked > 10_000
        ? NOVA_CEILING_REFUSAL
        : "The maximum tokens you requested exceeds the model limit of 4096",
  );
  await quietly(async () => {
    await assert.rejects(run, /providers\.bedrock\.max_tokens is the setting at fault/);
  });
  const calls = modelCalls(events);
  assert.equal(calls.length, 1, "one complete is one model_call, however many requests it made");
  // A lost page is the one most worth knowing ran into a config ceiling, so the fields ride the
  // throwing path too — same reason usage does.
  assert.equal(calls[0].ok, false);
  assert.match(String(calls[0].error), /setting at fault/);
  assert.equal(calls[0].output_ceiling_clamped, true);
  assert.equal(calls[0].output_ceiling_asked, 32_000);
  assert.equal(calls[0].output_ceiling_stated, 4_096);
  assert.equal(calls[0].output_ceiling_refused, true);
});

test("a deployment whose model accepts its ceiling logs none of these fields", async () => {
  // What makes the fields worth grepping for: present means a ceiling was lowered. The
  // reference deployment runs Sonnet 4.6, whose Bedrock ceiling is 128000, so every line in
  // every run log today must be unchanged by this feature.
  const { events, run } = clampingRouter(
    { default_model: "us.anthropic.claude-sonnet-4-6", api: "converse" },
    () => null,
  );
  await run();
  const [call] = modelCalls(events);
  assert.equal(call.ok, true);
  assert.deepEqual(
    Object.keys(call).filter((k) => k.startsWith("output_ceiling")),
    [],
  );
});

test("normalizeUsage subtracts cache reads and leaves cache writes alone", () => {
  // cached_tokens is specified as a subset of prompt_tokens, so it must come out.
  // Whether cache_write_tokens is also inside it is not documented — subtracting a
  // number that was never in the total would understate the input, and over-counting
  // input is the safer error for a cost estimate.
  assert.deepEqual(
    normalizeUsage({
      prompt_tokens: 1000,
      completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 200 },
    }),
    {
      input_tokens: 600,
      output_tokens: 100,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 200,
    },
  );
  // Nothing reported stays nothing: an empty object would read as a free call.
  assert.equal(normalizeUsage(undefined), undefined);
  assert.equal(normalizeUsage({}), undefined);
  // Never negative, however the upstream's arithmetic disagrees with itself.
  assert.equal(normalizeUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 99 } })?.input_tokens, 0);
});

test("a service failure delivered mid-stream is raised, not silently truncated", async () => {
  // These ride an otherwise-successful 200, so ignoring them would return whatever
  // partial text had arrived as if it were the finished document.
  const bedrock = new BedrockProvider({ default_model: "m" });
  stubStream(bedrock, async function* () {
    yield textDelta("<p>partial");
    yield { throttlingException: { message: "Too many tokens, please wait" } };
  });
  await assert.rejects(
    () => bedrock.complete(bedrockReq),
    (e: Error) => {
      assert.match(e.message, /throttlingException/);
      assert.match(e.message, /Too many tokens/);
      return true;
    },
  );
});
