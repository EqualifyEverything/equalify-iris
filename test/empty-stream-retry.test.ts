// A response stream that opens, sends nothing, and closes (issue #480: a user's document
// failed with "0 chars received, no message_stop and no stop_reason", and the whole
// conversion was lost).
//
// The distinction every test here turns on is between a stream that ended SHORT and one
// that ended EMPTY. They used to share one message and one outcome, and they are opposite
// diagnoses:
//
//   - Ended short: a document is in hand, missing its end. Sending it again would have to
//     discard what was generated or resume mid-document, so it fails — and must keep
//     failing, which is what the "not retried" tests below pin.
//   - Ended empty: nothing is in hand. Nothing to discard, nothing that can ship short, and
//     nothing about the request the upstream objected to — so it is sent again.
//
// Two things are pinned as hard as the retry itself, because both are ways a retry does
// damage rather than good. A stalled call must not become a retried one: it would double
// the time a wedged session takes to fail, and `expired` is checked before the completeness
// check that raises this, which is what makes that true. And the abandoned attempt's token
// counts must survive into the surviving attempt's report: the Anthropic stream reports the
// prompt's counts in `message_start`, so an attempt that got that far and closed was billed,
// and a call that paid for two prompts must not be logged as having paid for one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BedrockProvider } from "../src/providers/bedrock.ts";
import { OpenRouterProvider } from "../src/providers/openrouter.ts";
import { EmptyStreamError, StalledStreamError, type Usage } from "../src/providers/types.ts";

const encode = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const messageStart = (usage?: Record<string, number>) => ({
  chunk: { bytes: encode({ type: "message_start", message: usage ? { usage } : {} }) },
});
const textDelta = (text: string) => ({
  chunk: { bytes: encode({ type: "content_block_delta", delta: { type: "text_delta", text } }) },
});
const messageDelta = (stop_reason: string, usage?: Record<string, number>) => ({
  chunk: { bytes: encode({ type: "message_delta", delta: { stop_reason }, ...(usage ? { usage } : {}) }) },
});

// Replace the adapter's SDK client with one that serves a fresh scripted stream per send
// and counts the sends. The count IS the assertion in most of these tests: whether the
// request was sent again is not visible in the result, only in how many times the upstream
// was asked.
//
// `events` is a function of the send number (1-based), because what makes the retry
// meaningful is that the second attempt can go differently from the first.
function stubSends(
  bedrock: BedrockProvider,
  events: (send: number) => unknown[],
  key: "body" | "stream" = "body",
): { count: () => number } {
  let sends = 0;
  (bedrock as unknown as { client: unknown }).client = {
    send: async () => {
      const script = events(++sends);
      return {
        [key]: (async function* () {
          for (const e of script) yield e;
        })(),
      };
    },
  };
  return { count: () => sends };
}

const bedrockReq = {
  capability: "vision" as const,
  model: "us.anthropic.claude-sonnet-4-6",
  messages: [{ role: "user" as const, content: "fix this document" }],
};

// Warnings are captured rather than left to print, matching bedrock-output-ceiling.test.ts:
// the retry says something an operator has to act on, so it is asserted in the first test
// below and kept out of the suite's output in the rest.
async function capturingWarnings<T>(body: () => Promise<T>): Promise<[T, string[]]> {
  const said: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => said.push(args.join(" "));
  try {
    return [await body(), said];
  } finally {
    console.warn = original;
  }
}

test("a Bedrock stream that closes having sent nothing is sent again, and the retry is delivered", async () => {
  const bedrock = new BedrockProvider({ default_model: "m" });
  // The shape of the reported failure: the stream opens and closes with no events at all.
  const sends = stubSends(bedrock, (send) =>
    send === 1 ? [] : [messageStart(), textDelta("<h1>Whole</h1>"), messageDelta("end_turn")],
  );
  const [res, said] = await capturingWarnings(() => bedrock.complete(bedrockReq));
  assert.equal(res.text, "<h1>Whole</h1>");
  assert.equal(sends.count(), 2);
  // A call that succeeds on its second attempt is otherwise invisible — the `model_call`
  // line reports one call with a longer duration — so the warning is the run's only record
  // that this deployment is meeting the failure at all, and its frequency is the whole
  // question a reader would have.
  assert.equal(said.length, 1);
  assert.match(said[0], /sent nothing at all/);
  assert.match(said[0], /paid for, a second time/);
});

test("a Bedrock stream that closes after message_start alone is still empty, and still retried", async () => {
  // The likelier shape of #480 on this API, and the one that decides whether the retry is
  // reachable at all in production: `message_start` has arrived, so the prompt has been read
  // and billed, and only then does the stream close. Nothing was GENERATED, which is the
  // condition — a guard written on "has this call cost anything" instead would refuse to
  // retry exactly the case the issue was filed about.
  const bedrock = new BedrockProvider({ default_model: "m" });
  const sends = stubSends(bedrock, (send) =>
    send === 1
      ? [messageStart({ input_tokens: 900 })]
      : [messageStart({ input_tokens: 900 }), textDelta("<p>second time</p>"), messageDelta("end_turn")],
  );
  const [res] = await capturingWarnings(() => bedrock.complete(bedrockReq));
  assert.equal(res.text, "<p>second time</p>");
  assert.equal(sends.count(), 2);
});

test("the abandoned attempt's tokens stay in the call's reported usage", async () => {
  // What a retry must not do quietly: bill two prompts and report one. `tokens.calls_reported`
  // would still count this call as fully accounted for, so the undercount would not show up
  // anywhere as a gap — it would just make the run cheaper than it was.
  const bedrock = new BedrockProvider({ default_model: "m" });
  stubSends(bedrock, (send) =>
    send === 1
      ? [messageStart({ input_tokens: 900, cache_read_input_tokens: 100 })]
      : [
          messageStart({ input_tokens: 900, cache_read_input_tokens: 100 }),
          textDelta("<p>ok</p>"),
          messageDelta("end_turn", { output_tokens: 40 }),
        ],
  );
  const reported: Usage[] = [];
  const [res] = await capturingWarnings(() =>
    bedrock.complete({ ...bedrockReq, onUsage: (u) => reported.push(u) }),
  );
  // Both prompts, once each, and the output of the attempt that produced some.
  assert.deepEqual(res.usage, {
    input_tokens: 1800,
    cache_read_input_tokens: 200,
    output_tokens: 40,
  });
  // The router reads usage off the callback when a call throws and off the result when it
  // returns, so the last thing the callback said has to agree with the result. A call whose
  // retry then truncated would be reported entirely through the callback.
  assert.deepEqual(reported.at(-1), res.usage);
});

test("two empty Bedrock streams fail, saying so, and do not describe a document that never arrived", async () => {
  const bedrock = new BedrockProvider({ default_model: "m" });
  const sends = stubSends(bedrock, () => []);
  await capturingWarnings(() =>
    assert.rejects(
      () => bedrock.complete(bedrockReq),
      (e: Error) => {
        assert.ok(e instanceof EmptyStreamError);
        assert.equal(e.attempts, 2);
        // The retry was reached and did not help. Without this the surviving message is the
        // second attempt's own, which says nothing about the first.
        assert.match(e.message, /Sent 2 times/);
        assert.match(e.message, /ended without completing/);
        assert.match(e.message, /having sent nothing/);
        // The old message's wording, which was the actual defect in #480: an operator
        // reading "a partial document" about a response of zero characters is being
        // pointed at a truncation that did not happen.
        assert.doesNotMatch(e.message, /partial document/);
        return true;
      },
    ),
  );
  assert.equal(sends.count(), 2);
});

test("a Bedrock stream that ends SHORT is not retried, and still reports what it received", async () => {
  // The safety pin. Text in hand means a retry would either discard it or deliver the same
  // passage twice, so this failure stays exactly as it was — one send, and a message naming
  // the characters that arrived.
  const bedrock = new BedrockProvider({ default_model: "m" });
  const sends = stubSends(bedrock, () => [messageStart(), textDelta("<table><tr><td>half a document")]);
  await assert.rejects(
    () => bedrock.complete(bedrockReq),
    (e: Error) => {
      assert.ok(!(e instanceof EmptyStreamError));
      assert.match(e.message, /30 chars received/);
      assert.match(e.message, /partial document/);
      return true;
    },
  );
  assert.equal(sends.count(), 1);
});

test("a Bedrock call that stalls before any output is a stall, not an empty stream", async () => {
  // The other safety pin, and the reason the retry cannot lengthen a wedged session: a call
  // abandoned by our own clock has also received 0 characters, so if the completeness check
  // were reached first it would look identical to #480 and be sent again — turning a
  // 120-second failure into a 240-second one. `expired` is checked first, and this is what
  // says so.
  const bedrock = new BedrockProvider({ default_model: "m" }, { firstOutputTimeoutMs: 50 });
  let sends = 0;
  (bedrock as unknown as { client: unknown }).client = {
    send: async (_cmd: unknown, opts: { abortSignal: AbortSignal }) => {
      sends++;
      return {
        body: (async function* () {
          // Silent until the first-output clock fires, then end without throwing — the
          // abort shape that reaches the completeness check rather than the catch.
          await new Promise<void>((resolve) =>
            opts.abortSignal.addEventListener("abort", () => resolve(), { once: true }),
          );
        })(),
      };
    },
  };
  await assert.rejects(() => bedrock.complete(bedrockReq), (e: Error) => {
    assert.ok(e instanceof StalledStreamError);
    assert.equal(e.kind, "first_output");
    return true;
  });
  assert.equal(sends, 1);
});

test("the Converse path retries an empty stream too", async () => {
  // Both APIs go through one `stream`, so this is pinning that the retry sits above the
  // dialect rather than inside one of them — and the events differ enough between them
  // (`stream` rather than `body`, `messageStop` rather than `message_stop`) that a retry
  // wired into the Anthropic path alone would pass every test above and fail here.
  const bedrock = new BedrockProvider({ default_model: "m", api: "converse" } as never);
  const sends = stubSends(
    bedrock,
    (send) =>
      send === 1
        ? []
        : [
            { messageStart: { role: "assistant" } },
            { contentBlockDelta: { delta: { text: "<p>converse</p>" }, contentBlockIndex: 0 } },
            { messageStop: { stopReason: "end_turn" } },
          ],
    "stream",
  );
  const [res] = await capturingWarnings(() => bedrock.complete(bedrockReq));
  assert.equal(res.text, "<p>converse</p>");
  assert.equal(sends.count(), 2);
});

// --- OpenRouter: the same event, arriving as a 200 with an empty body --------

const sseDelta = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`;
const sseFinish = (finish_reason: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason }] })}`;
const SSE_DONE = "data: [DONE]";

// Swap global fetch for one that serves a fresh canned SSE body per call and counts them.
async function withFetch<T>(
  lines: (call: number) => string[],
  fn: (calls: () => number) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    const body = lines(++calls).join("\n\n") + "\n\n";
    return {
      ok: true,
      status: 200,
      text: async () => "",
      body: (async function* () {
        yield new TextEncoder().encode(body);
      })(),
    };
  }) as unknown as typeof fetch;
  try {
    return await fn(() => calls);
  } finally {
    globalThis.fetch = original;
  }
}

const openrouter = () =>
  new OpenRouterProvider({
    api_key: "test-key",
    base_url: "http://localhost:1/v1",
    default_model: "m",
  });

const openrouterReq = {
  capability: "text" as const,
  model: "m",
  messages: [{ role: "user" as const, content: "hi" }],
};

test("an OpenRouter stream that ends with no events is retried, not failed", async () => {
  // #480 was reported on Bedrock, but nothing about it is Bedrock's: a 200 whose body says
  // nothing is the same transient upstream event as the connection reset this loop already
  // retried, and `isTransientNetworkError` was never going to recognize it because no socket
  // error was raised. Fixing one adapter and not the other would leave the two disagreeing
  // about whether an empty response is fatal.
  await withFetch(
    (call) => (call === 1 ? [] : [sseDelta("<p>whole</p>"), sseFinish("stop"), SSE_DONE]),
    async (calls) => {
      const res = await openrouter().complete(openrouterReq);
      assert.equal(res.text, "<p>whole</p>");
      assert.equal(calls(), 2);
    },
  );
});

test("an OpenRouter stream that ends SHORT is not retried", async () => {
  await withFetch(
    () => [sseDelta("<p>half")],
    async (calls) => {
      await assert.rejects(
        () => openrouter().complete(openrouterReq),
        (e: Error) => {
          assert.ok(!(e instanceof EmptyStreamError));
          assert.match(e.message, /7 chars received/);
          return true;
        },
      );
      assert.equal(calls(), 1);
    },
  );
});

test("an OpenRouter upstream that answers three times with nothing fails, naming the attempts", async () => {
  // Three, not two, because this adapter's retry budget is its own (MAX_ATTEMPTS) and the
  // empty stream joins it rather than bringing a budget of its own.
  await withFetch(
    () => [],
    async (calls) => {
      await assert.rejects(
        () => openrouter().complete(openrouterReq),
        (e: Error) => {
          assert.ok(e instanceof EmptyStreamError);
          assert.equal(e.attempts, 3);
          assert.match(e.message, /Sent 3 times/);
          assert.doesNotMatch(e.message, /partial document/);
          return true;
        },
      );
      assert.equal(calls(), 3);
    },
  );
});
