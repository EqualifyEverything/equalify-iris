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
import { normalizeMaxTokens, DEFAULT_MAX_TOKENS } from "../src/config.ts";
import { BedrockProvider } from "../src/providers/bedrock.ts";
import { OpenRouterProvider } from "../src/providers/openrouter.ts";
import { StalledStreamError, TruncatedResponseError } from "../src/providers/types.ts";

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

test("time-to-first-token counts as idle time, not a grace period", async () => {
  // A call that never sends anything at all must still be caught; the idle clock
  // therefore has to start before the request, not at the first chunk.
  const bedrock = new BedrockProvider({ default_model: "m" }, { idleTimeoutMs: 100 });
  stubStream(bedrock, async function* (signal) {
    await sleepUnlessAborted(60_000, signal);
    yield textDelta("never");
  });
  await assert.rejects(
    () => bedrock.complete(bedrockReq),
    (e: Error) => {
      assert.ok(e instanceof StalledStreamError);
      assert.match(e.message, /nothing had streamed/);
      return true;
    },
  );
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

test("a message_start keeps a slow first token alive", async () => {
  // The other half of the ping rule: real protocol events must still count, or a
  // model that takes its time before the first token is killed for being slow —
  // reintroducing the bug this work fixes, at a lower threshold.
  const bedrock = new BedrockProvider({ default_model: "m" }, { idleTimeoutMs: 200 });
  stubStream(bedrock, async function* (signal) {
    await sleepUnlessAborted(120, signal);
    yield { chunk: { bytes: encode({ type: "message_start" }) } };
    await sleepUnlessAborted(120, signal);
    yield { chunk: { bytes: encode({ type: "content_block_start" }) } };
    await sleepUnlessAborted(120, signal);
    yield textDelta("finally");
    yield messageDelta("end_turn");
  });
  const res = await bedrock.complete(bedrockReq);
  assert.equal(res.text, "finally");
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
