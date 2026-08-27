// Issue #178, step one: a Bedrock adapter that speaks Bedrock's own API rather than
// Anthropic's, so that `providers.bedrock.default_model` can name a model Anthropic did
// not make. The evaluation the issue proposes — is Qwen3-VL 4x cheaper at acceptable
// quality — cannot start until the request shape stops being Claude-specific.
//
// Nothing here talks to Bedrock, so nothing here can prove parity; that is a live probe
// and a bench round, which is why `api: converse` is off by default. What these tests can
// pin is everything that would make such a probe uninterpretable:
//
//   1. The default did not move. A deployment that sets nothing sends the Anthropic body
//      it has always sent, byte for byte — otherwise the round that was supposed to
//      isolate one variable moved two.
//   2. The same text gets a cache breakpoint on both paths. Caching is 27% of the bill;
//      an adapter that quietly stopped asking for it would read as Converse being
//      expensive.
//   3. The token counts arrive under the names the rest of Iris sums. Converse renames
//      every one of them, and the router spreads them FLAT onto the log line — so a
//      missed rename is not a wrong number, it is a call that reports no cache write at
//      all, and the cost comparison the issue is for reads it as zero.
//   4. `metadata` arrives AFTER `messageStop` on this API. The natural translation of the
//      Anthropic path — stop reading at the stop event — throws the whole accounting away.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConverseStreamCommand, InvokeModelWithResponseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { BedrockProvider, bedrockApi } from "../src/providers/bedrock.ts";
import { cachePointBlock } from "../src/providers/promptCache.ts";
import { bedrockApiWarning } from "../src/config.ts";
import {
  StalledStreamError,
  TruncatedResponseError,
  isRequestTooLargeError,
  isTruncatedResponseError,
} from "../src/providers/types.ts";
import { ProviderRouter } from "../src/providers/index.ts";

// A model whose id `promptCache.ts` recognizes as cacheable, so the breakpoint tests are
// testing the adapter and not the model table.
const MODEL = "us.anthropic.claude-sonnet-4-6";

// Long enough to clear the minimum cacheable prefix (1024 tokens at 2 chars/token for a
// sonnet), which is what `cacheableSystemPrompt` asks of a system prompt or a declared
// head before it is worth a breakpoint.
const LONG = "x".repeat(3_000);

interface Captured {
  command: unknown;
  input: Record<string, any>;
}

// Replace the adapter's SDK client with one that records the command it was handed and
// returns a scripted `ConverseStream` response. `stream`, not `body`: the two APIs name
// the event stream differently, and a stub that got that wrong would pass a test the
// adapter fails.
function stubConverse(
  bedrock: BedrockProvider,
  script: (signal: AbortSignal) => AsyncIterable<unknown>,
): Captured {
  const captured: Captured = { command: null, input: {} };
  (bedrock as unknown as { client: unknown }).client = {
    send: async (cmd: any, opts: { abortSignal: AbortSignal }) => {
      captured.command = cmd;
      captured.input = cmd.input;
      return { stream: script(opts.abortSignal) };
    },
  };
  return captured;
}

const done = (stopReason = "end_turn", usage?: Record<string, number>) => [
  { messageStart: { role: "assistant" } },
  { contentBlockStop: { contentBlockIndex: 0 } },
  { messageStop: { stopReason } },
  ...(usage ? [{ metadata: { usage } }] : []),
];

function script(events: unknown[]): (signal: AbortSignal) => AsyncIterable<unknown> {
  return async function* () {
    for (const e of events) yield e;
  };
}

const req = (extra: Record<string, unknown> = {}) => ({
  capability: "vision" as const,
  model: MODEL,
  messages: [{ role: "user" as const, content: "fix this document" }],
  ...extra,
});

const converse = (cfg: Record<string, unknown> = {}) =>
  new BedrockProvider({ default_model: MODEL, api: "converse", ...cfg } as never);

// --- which API the calls go out on -----------------------------------------------------

test("the Bedrock API is invoke unless a deployment asks for converse in as many words", () => {
  assert.equal(bedrockApi({}), "invoke");
  assert.equal(bedrockApi({ api: "converse" }), "converse");
  assert.equal(bedrockApi({ api: " Converse " }), "converse");
  assert.equal(bedrockApi({ api: "invoke" }), "invoke");
  // Everything unrecognized is the path that works today, never a guess: a typo must not
  // decide which API a deployment's whole bill goes through.
  assert.equal(bedrockApi({ api: "converse-stream" }), "invoke");
  assert.equal(bedrockApi({ api: "CONVERSESTREAM" }), "invoke");
  assert.equal(bedrockApi({ api: "" }), "invoke");
  assert.equal(bedrockApi({ api: null } as never), "invoke");
  assert.equal(bedrockApi({ api: true } as never), "invoke");
});

test("a Bedrock api nobody can spell is named at boot, because nothing else reports it", () => {
  const providers = (api: unknown) => ({ default: "bedrock", bedrock: { default_model: MODEL, api } });
  assert.equal(bedrockApiWarning(providers("converse") as never), undefined);
  assert.equal(bedrockApiWarning(providers("invoke") as never), undefined);
  // Unset, empty and a valueless YAML key are all an operator who chose the default.
  assert.equal(bedrockApiWarning({ default: "bedrock", bedrock: { default_model: MODEL } } as never), undefined);
  assert.equal(bedrockApiWarning(providers(null) as never), undefined);
  assert.equal(bedrockApiWarning(providers("") as never), undefined);

  const warned = bedrockApiWarning(providers("Converse-Stream") as never);
  assert.match(warned ?? "", /providers\.bedrock: "Converse-Stream"/);
  assert.match(warned ?? "", /must be "invoke" or "converse"/);
  // The consequence, not just the rule: the deployment is on the path it was leaving.
  assert.match(warned ?? "", /measuring the path it already had/);

  // The field means nothing to the OpenRouter adapter, so an operator is not sent looking
  // for a setting that block does not have.
  assert.equal(
    bedrockApiWarning({ default: "openrouter", openrouter: { default_model: "m", api: "nonsense" } } as never),
    undefined,
  );
  // Neither `default` (a string) nor `per_agent` (a map of overrides) is a provider block.
  assert.equal(bedrockApiWarning({ default: "bedrock", per_agent: { page: "bedrock" } } as never), undefined);
});

test("the default deployment still sends the Anthropic body, unchanged", async () => {
  const bedrock = new BedrockProvider({ default_model: MODEL });
  const captured = stubConverse(bedrock, script([]));
  // Deliberately an empty script: what is asserted is the command, and an empty stream
  // fails the completeness check afterwards, which is the existing path's behaviour.
  await assert.rejects(() => bedrock.complete(req()), /ended without completing/);
  assert.ok(captured.command instanceof InvokeModelWithResponseStreamCommand);
  const body = JSON.parse(String(captured.input.body));
  assert.equal(body.anthropic_version, "bedrock-2023-05-31");
  assert.equal(body.max_tokens, 32_000);
});

test("asking for converse sends a ConverseStream command and no Anthropic fields at all", async () => {
  const bedrock = converse({ max_tokens: 12_345 });
  const captured = stubConverse(bedrock, script(done("end_turn", { inputTokens: 1 })));
  await bedrock.complete(req({ messages: [{ role: "system", content: "be careful" }, { role: "user", content: "go" }] }));
  assert.ok(captured.command instanceof ConverseStreamCommand);
  assert.equal(captured.input.modelId, MODEL);
  // The ceiling moves into inferenceConfig, where a model-agnostic API has to keep it.
  assert.deepEqual(captured.input.inferenceConfig, { maxTokens: 12_345 });
  assert.equal(captured.input.body, undefined);
  assert.equal(captured.input.anthropic_version, undefined);
  assert.equal(JSON.stringify(captured.input).includes("anthropic_version"), false);
  assert.deepEqual(captured.input.system, [{ text: "be careful" }]);
  assert.deepEqual(captured.input.messages, [{ role: "user", content: [{ text: "go" }] }]);
});

test("no system prompt means no system field, not an empty one", async () => {
  const bedrock = converse();
  const captured = stubConverse(bedrock, script(done()));
  await bedrock.complete(req());
  assert.equal("system" in captured.input, false);
});

// --- the cache breakpoints, which are 27% of the bill ----------------------------------

test("the same text gets a breakpoint on converse as on invoke, spelled Bedrock's way", async () => {
  const bedrock = converse();
  const captured = stubConverse(bedrock, script(done()));
  await bedrock.complete(
    req({
      messages: [
        { role: "system", content: LONG },
        { role: "user", content: `${LONG}|the page itself`, cachedPrefix: LONG },
      ],
    }),
  );
  // A breakpoint is its own block AFTER the text it applies to, and the pieces still
  // concatenate to the message the caller wrote.
  assert.deepEqual(captured.input.system, [{ text: LONG }, { cachePoint: { type: "default" } }]);
  assert.deepEqual(captured.input.messages[0].content, [
    { text: LONG },
    { cachePoint: { type: "default" } },
    { text: "|the page itself" },
  ]);
  const said = captured.input.messages[0].content
    .filter((b: any) => typeof b.text === "string")
    .map((b: any) => b.text)
    .join("");
  assert.equal(said, `${LONG}|the page itself`);
});

test("an hour is asked for on this path too, not silently downgraded to five minutes", async () => {
  assert.deepEqual(cachePointBlock(), { type: "default" });
  assert.deepEqual(cachePointBlock("5m"), { type: "default" });
  assert.deepEqual(cachePointBlock("1h"), { type: "default", ttl: "1h" });

  const bedrock = converse({ prompt_cache_ttl: "1h" });
  const captured = stubConverse(bedrock, script(done()));
  await bedrock.complete(req({ messages: [{ role: "system", content: LONG }, { role: "user", content: "go" }] }));
  assert.deepEqual(captured.input.system, [{ text: LONG }, { cachePoint: { type: "default", ttl: "1h" } }]);
});

test("a deployment that turned caching off asks for nothing on this path either", async () => {
  const bedrock = converse({ prompt_cache: false });
  const captured = stubConverse(bedrock, script(done()));
  await bedrock.complete(
    req({
      messages: [
        { role: "system", content: LONG },
        { role: "user", content: `${LONG}|tail`, cachedPrefix: LONG },
      ],
    }),
  );
  assert.deepEqual(captured.input.system, [{ text: LONG }]);
  assert.deepEqual(captured.input.messages[0].content, [{ text: `${LONG}|tail` }]);
});

test("a declared head that is the whole message sends no empty trailing block", async () => {
  const bedrock = converse();
  const captured = stubConverse(bedrock, script(done()));
  await bedrock.complete(req({ messages: [{ role: "user", content: LONG, cachedPrefix: LONG }] }));
  // Converse rejects an empty text block, so the guarantee that declaring a head never
  // breaks a call would fail on the one input that needs no tail.
  assert.deepEqual(captured.input.messages[0].content, [{ text: LONG }, { cachePoint: { type: "default" } }]);
});

test("a cachedPrefix that is not a prefix of the message is ignored, not trusted", async () => {
  const bedrock = converse();
  const captured = stubConverse(bedrock, script(done()));
  await bedrock.complete(
    req({ messages: [{ role: "user", content: "the page", cachedPrefix: LONG }] }),
  );
  assert.deepEqual(captured.input.messages[0].content, [{ text: "the page" }]);
});

// --- images ----------------------------------------------------------------------------

test("a page image goes as raw bytes and a format name, not as base64 and a media type", async () => {
  const bedrock = converse();
  const captured = stubConverse(bedrock, script(done()));
  const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  await bedrock.complete(req({ images: [{ data, media_type: "image/png" }] }));
  const blocks = captured.input.messages[0].content;
  assert.deepEqual(blocks[0], { text: "fix this document" });
  assert.equal(blocks[1].image.format, "png");
  assert.ok(blocks[1].image.source.bytes instanceof Uint8Array);
  assert.deepEqual([...blocks[1].image.source.bytes], [0x89, 0x50, 0x4e, 0x47]);
  // The bytes, not their base64 text: a picture sent twice over is a picture billed twice.
  assert.equal(JSON.stringify(captured.input).includes(data.toString("base64")), false);
});

test("every media type the pipeline can produce has a format name here", async () => {
  for (const [media, format] of [
    ["image/png", "png"],
    ["image/jpeg", "jpeg"],
    ["image/gif", "gif"],
    ["image/webp", "webp"],
    ["IMAGE/PNG", "png"],
    // Unreachable through the pipeline — `mediaTypeFor` already falls back to image/png —
    // so this is a caller building an Image by hand, and a wrong format name is Bedrock's
    // to reject with a message that says so, not a reason for Iris to fail a page.
    ["application/pdf", "png"],
  ] as const) {
    const bedrock = converse();
    const captured = stubConverse(bedrock, script(done()));
    await bedrock.complete(req({ images: [{ data: Buffer.from("x"), media_type: media }] }));
    assert.equal(
      captured.input.messages[0].content[1].image.format,
      format,
      `${media} should go as ${format}`,
    );
  }
});

test("images ride the user message, never an assistant turn", async () => {
  const bedrock = converse();
  const captured = stubConverse(bedrock, script(done()));
  await bedrock.complete(
    req({
      messages: [
        { role: "user", content: "here is a page" },
        { role: "assistant", content: "I read it" },
      ],
      images: [{ data: Buffer.from("x"), media_type: "image/png" }],
    }),
  );
  assert.equal(captured.input.messages[0].content.length, 2);
  assert.deepEqual(captured.input.messages[1], { role: "assistant", content: [{ text: "I read it" }] });
});

// --- reading the stream ----------------------------------------------------------------

test("streamed text deltas are concatenated into the result", async () => {
  const bedrock = converse();
  stubConverse(
    bedrock,
    script([
      { messageStart: { role: "assistant" } },
      { contentBlockStart: { contentBlockIndex: 0 } },
      { contentBlockDelta: { delta: { text: "<h1>Title</h1>" }, contentBlockIndex: 0 } },
      { contentBlockDelta: { delta: { text: "<p>Body</p>" }, contentBlockIndex: 0 } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: "end_turn" } },
      { metadata: { usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } } },
    ]),
  );
  const res = await bedrock.complete(req());
  assert.equal(res.text, "<h1>Title</h1><p>Body</p>");
  assert.equal(res.provider, "bedrock");
  assert.equal(res.model, MODEL);
});

test("a delta that is not text is ignored rather than stringified into the document", async () => {
  const bedrock = converse();
  stubConverse(
    bedrock,
    script([
      { contentBlockDelta: { delta: { text: "kept" }, contentBlockIndex: 0 } },
      // Reasoning and tool-use deltas share the union. Structured output here is
      // prompt-driven, so anything but text is not this document.
      { contentBlockDelta: { delta: { reasoningContent: { text: "thinking out loud" } }, contentBlockIndex: 1 } },
      { contentBlockDelta: { delta: { toolUse: { input: '{"a":1}' } }, contentBlockIndex: 2 } },
      { messageStop: { stopReason: "end_turn" } },
    ]),
  );
  const res = await bedrock.complete(req());
  assert.equal(res.text, "kept");
});

test("the token counts arrive under the names the rest of Iris sums", async () => {
  const bedrock = converse();
  const seen: unknown[] = [];
  stubConverse(
    bedrock,
    script([
      { contentBlockDelta: { delta: { text: "hi" }, contentBlockIndex: 0 } },
      { messageStop: { stopReason: "end_turn" } },
      {
        metadata: {
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadInputTokens: 900,
            cacheWriteInputTokens: 50,
            totalTokens: 1_070,
          },
          metrics: { latencyMs: 1_234 },
        },
      },
    ]),
  );
  const res = await bedrock.complete(req({ onUsage: (u: unknown) => seen.push(u) }));
  assert.deepEqual(res.usage, {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 900,
    // The rename that matters most: Converse's cacheWrite is Anthropic's cache_creation,
    // and diagnostics sums by name off a flat log line.
    cache_creation_input_tokens: 50,
  });
  // Nothing the upstream volunteered beyond the four: `totalTokens` and `metrics` would
  // land on the `model_call` event, where a fifth number's relationship to the four is a
  // claim nothing checks.
  assert.deepEqual(Object.keys(res.usage ?? {}).sort(), [
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "input_tokens",
    "output_tokens",
  ]);
  assert.equal(seen.length, 1, "usage arrives once on this API, in the metadata event");
});

test("a metadata event after the stop event is still read, so the call accounts for itself", async () => {
  // The whole hazard of translating this API from the other one: `metadata` comes AFTER
  // `messageStop`, so stopping the read at the stop event — which is what the Anthropic
  // path does, for good reasons of its own — silently discards every token count.
  const bedrock = converse();
  stubConverse(
    bedrock,
    script([
      { contentBlockDelta: { delta: { text: "done" }, contentBlockIndex: 0 } },
      { messageStop: { stopReason: "end_turn" } },
      { metadata: { usage: { inputTokens: 7, outputTokens: 2 } } },
    ]),
  );
  const res = await bedrock.complete(req());
  assert.equal(res.text, "done");
  assert.deepEqual(res.usage, { input_tokens: 7, output_tokens: 2 });
});

test("a stream that ends after the stop event without metadata is a whole document", async () => {
  // Nothing to account for, but the response IS complete: the stop reason is what says so.
  const bedrock = converse();
  stubConverse(
    bedrock,
    script([
      { contentBlockDelta: { delta: { text: "whole" }, contentBlockIndex: 0 } },
      { messageStop: { stopReason: "end_turn" } },
    ]),
  );
  const res = await bedrock.complete(req());
  assert.equal(res.text, "whole");
  assert.equal(res.usage, undefined);
});

test("a stream that stops early is not accepted as a finished document", async () => {
  const bedrock = converse();
  stubConverse(
    bedrock,
    script([{ contentBlockDelta: { delta: { text: "<p>half a page" }, contentBlockIndex: 0 } }]),
  );
  await assert.rejects(() => bedrock.complete(req()), (e: Error) => {
    assert.match(e.message, /ended without completing/);
    assert.match(e.message, /14 chars received/);
    return true;
  });
});

test("a response cut off at the ceiling fails instead of being delivered", async () => {
  const bedrock = converse({ max_tokens: 32_000 });
  stubConverse(
    bedrock,
    script([
      { contentBlockDelta: { delta: { text: "<p>cut mid-" }, contentBlockIndex: 0 } },
      { messageStop: { stopReason: "max_tokens" } },
      { metadata: { usage: { inputTokens: 5, outputTokens: 32_000 } } },
    ]),
  );
  await assert.rejects(
    () => bedrock.complete(req()),
    (e: Error) => {
      assert.ok(e instanceof TruncatedResponseError);
      assert.match(e.message, /providers\.bedrock\.max_tokens/);
      return true;
    },
  );
});

test("a truncated converse call still accounts for what it spent", async () => {
  const bedrock = converse();
  const seen: any[] = [];
  stubConverse(
    bedrock,
    script([
      { contentBlockDelta: { delta: { text: "cut" }, contentBlockIndex: 0 } },
      { messageStop: { stopReason: "max_tokens" } },
      { metadata: { usage: { inputTokens: 9, outputTokens: 32_000 } } },
    ]),
  );
  await assert.rejects(() => bedrock.complete(req({ onUsage: (u: unknown) => seen.push(u) })));
  // The error carries no usage, so the callback is the only record of an expensive call.
  assert.deepEqual(seen.at(-1), { input_tokens: 9, output_tokens: 32_000 });
});

test("a service failure delivered mid-stream is raised, not returned as a short document", async () => {
  const bedrock = converse();
  stubConverse(
    bedrock,
    script([
      { contentBlockDelta: { delta: { text: "<p>partial" }, contentBlockIndex: 0 } },
      { modelStreamErrorException: { message: "the model stream broke" } },
    ]),
  );
  await assert.rejects(() => bedrock.complete(req()), (e: Error) => {
    assert.match(e.message, /modelStreamErrorException: the model stream broke/);
    return true;
  });
});

test("a modeled exception this API does not have is still recognized if it arrives", async () => {
  // The two APIs do not agree on the exception set — `modelTimeoutException` is on the
  // Anthropic stream's union and not on this one — and every name is checked against both
  // rather than trusting the union to be exhaustive.
  const bedrock = converse();
  stubConverse(bedrock, script([{ modelTimeoutException: { message: "took too long" } }]));
  await assert.rejects(() => bedrock.complete(req()), /modelTimeoutException: took too long/);
});

test("an event shape this adapter does not know is not counted as progress", async () => {
  // Same rule as the Anthropic path's keepalive: an unknown event repeating forever should
  // trip the idle clock rather than defeat it, or a hung generation on a chatty connection
  // runs to the 15-minute backstop and reports itself as too large — the opposite diagnosis.
  const bedrock = new BedrockProvider(
    { default_model: MODEL, api: "converse" } as never,
    { idleTimeoutMs: 120, firstOutputTimeoutMs: 5_000 },
  );
  stubConverse(bedrock, async function* (signal: AbortSignal) {
    yield { contentBlockDelta: { delta: { text: "started" }, contentBlockIndex: 0 } };
    for (let i = 0; i < 20; i++) {
      await sleepUnlessAborted(40, signal);
      yield { somethingNewAws: { shipped: "after this was written" } };
    }
  });
  await assert.rejects(
    () => bedrock.complete(req()),
    (e: Error) => {
      assert.ok(e instanceof StalledStreamError);
      // 120ms rounds to 0s in the message, which is what a test seam looks like; the
      // sentence that matters is the diagnosis, not the number.
      assert.match(e.message, /the model stopped sending output for/);
      assert.match(e.message, /7 chars had streamed/);
      return true;
    },
  );
});

test("protocol events between blocks do keep the call alive", async () => {
  const bedrock = new BedrockProvider(
    { default_model: MODEL, api: "converse" } as never,
    { idleTimeoutMs: 200, firstOutputTimeoutMs: 200 },
  );
  stubConverse(bedrock, async function* (signal: AbortSignal) {
    yield { messageStart: { role: "assistant" } };
    for (let i = 0; i < 4; i++) {
      await sleepUnlessAborted(120, signal);
      yield { contentBlockStart: { contentBlockIndex: i } };
      yield { contentBlockStop: { contentBlockIndex: i } };
    }
    yield { contentBlockDelta: { delta: { text: "arrived in the end" }, contentBlockIndex: 4 } };
    yield { messageStop: { stopReason: "end_turn" } };
  });
  const res = await bedrock.complete(req());
  assert.equal(res.text, "arrived in the end");
});

// --- the other ways this API stops short ------------------------------------------------

test("every stop reason that means the answer is not whole fails the call", async () => {
  // The Anthropic body can only stop for end_turn/max_tokens/stop_sequence/tool_use, so one
  // max_tokens check covered every incomplete case there. Bedrock's own StopReason adds five
  // more, and each of them arrives as a SET stop reason on an otherwise well-formed stream —
  // which satisfies the completeness check and would return partial HTML as a success.
  for (const stopReason of [
    "malformed_model_output",
    "malformed_tool_use",
    "content_filtered",
    "guardrail_intervened",
    // Not in today's SDK union at all: an allowlist means a reason invented next year is
    // refused rather than trusted.
    "some_reason_aws_ships_in_2027",
  ]) {
    const bedrock = converse();
    stubConverse(
      bedrock,
      script([
        { contentBlockDelta: { delta: { text: "<p>most of a page" }, contentBlockIndex: 0 } },
        { messageStop: { stopReason } },
        { metadata: { usage: { inputTokens: 3, outputTokens: 4 } } },
      ]),
    );
    await assert.rejects(
      () => bedrock.complete(req()),
      (e: Error) => {
        assert.match(e.message, new RegExp(`stopped for "${stopReason}"`), stopReason);
        assert.match(e.message, /response is incomplete \(17 chars received\)/, stopReason);
        // Not the ceiling error: raising max_tokens fixes none of these, and the review
        // loop's truncation salvage would be the wrong response to them.
        assert.ok(!(e instanceof TruncatedResponseError), stopReason);
        assert.ok(!isTruncatedResponseError(e), stopReason);
        assert.ok(!isRequestTooLargeError(e), stopReason);
        return true;
      },
    );
  }
});

test("running out of context window is reported as the size problem it is", async () => {
  // Distinguished from the others on purpose: prompt-plus-response overflowing the window is
  // a request Iris can make smaller, and the review loop already knows how — drop the page
  // images and retry text-only, which is what it does when Bedrock refuses an oversized
  // request up front. `isRequestTooLargeError` is the predicate that routes it there.
  const bedrock = converse();
  stubConverse(
    bedrock,
    script([
      { contentBlockDelta: { delta: { text: "<p>most of a page" }, contentBlockIndex: 0 } },
      { messageStop: { stopReason: "model_context_window_exceeded" } },
    ]),
  );
  await assert.rejects(
    () => bedrock.complete(req()),
    (e: Error) => {
      assert.match(e.message, /exceeded the model's context window/);
      assert.ok(isRequestTooLargeError(e), "the size-refusal path must recognize it");
      assert.ok(!isTruncatedResponseError(e), "it is not the output ceiling");
      return true;
    },
  );
});

test("a refusal is a complete response, and stop_sequence and tool_use are too", async () => {
  // The allowlist is what is whole, not what is useful: judging an unhelpful answer is the
  // verify pass's job downstream, and failing here would turn it into a dead call instead.
  for (const stopReason of ["end_turn", "stop_sequence", "tool_use", "refusal"]) {
    const bedrock = converse();
    stubConverse(
      bedrock,
      script([
        { contentBlockDelta: { delta: { text: "an answer" }, contentBlockIndex: 0 } },
        { messageStop: { stopReason } },
      ]),
    );
    const res = await bedrock.complete(req());
    assert.equal(res.text, "an answer", stopReason);
  }
});

test("a connection that hangs after the stop event returns the document it already sent", async () => {
  // The clocks exist to tell a dead stream from a slow one; once the message has stopped
  // there is no document left to protect, only the token counts. So the wait for metadata
  // gets its own short window, and running out of it returns the response — spending a
  // whole idle minute and then throwing away a finished document to punish a missing
  // number would be the worse trade.
  const bedrock = new BedrockProvider(
    { default_model: MODEL, api: "converse" } as never,
    { trailingTimeoutMs: 60, idleTimeoutMs: 5_000, firstOutputTimeoutMs: 5_000 },
  );
  stubConverse(bedrock, async function* (signal: AbortSignal) {
    yield { contentBlockDelta: { delta: { text: "<p>a whole page</p>" }, contentBlockIndex: 0 } };
    yield { messageStop: { stopReason: "end_turn" } };
    // Never sends metadata, and never closes either.
    await sleepUnlessAborted(10_000, signal);
    yield { metadata: { usage: { inputTokens: 1 } } };
  });
  const res = await bedrock.complete(req());
  assert.equal(res.text, "<p>a whole page</p>");
  // Unreported rather than zero, which is the distinction `tokens.calls_reported` exists for.
  assert.equal(res.usage, undefined);
});

test("an event between the stop and the hang does not put the idle clock back", async () => {
  // The window is re-armed by every event after the stop, not only by the stop itself: if a
  // recognized event in the tail handed the read back to the 60s clock, a stream that sent
  // messageStop, one more frame, and then hung would be back to discarding a whole document.
  const bedrock = new BedrockProvider(
    { default_model: MODEL, api: "converse" } as never,
    { trailingTimeoutMs: 60, idleTimeoutMs: 5_000, firstOutputTimeoutMs: 5_000 },
  );
  stubConverse(bedrock, async function* (signal: AbortSignal) {
    yield { contentBlockDelta: { delta: { text: "<p>a whole page</p>" }, contentBlockIndex: 0 } };
    yield { messageStop: { stopReason: "end_turn" } };
    yield { contentBlockStop: { contentBlockIndex: 0 } };
    await sleepUnlessAborted(10_000, signal);
  });
  const res = await bedrock.complete(req());
  assert.equal(res.text, "<p>a whole page</p>");
});

test("the tail is bounded as a whole, not one window per frame", async () => {
  // Nothing re-arms the window after the stop event, so a tail that keeps sending frames
  // this adapter recognizes cannot hold the call open: the alternative bound is the
  // 15-minute backstop, spent on a document that was already complete.
  let frames = 0;
  const bedrock = new BedrockProvider(
    { default_model: MODEL, api: "converse" } as never,
    { trailingTimeoutMs: 60, idleTimeoutMs: 5_000, firstOutputTimeoutMs: 5_000 },
  );
  stubConverse(bedrock, async function* (signal: AbortSignal) {
    yield { contentBlockDelta: { delta: { text: "<p>a whole page</p>" }, contentBlockIndex: 0 } };
    yield { messageStop: { stopReason: "end_turn" } };
    for (let i = 0; i < 200; i++) {
      await sleepUnlessAborted(20, signal);
      frames++;
      yield { contentBlockStop: { contentBlockIndex: i } };
    }
  });
  const res = await bedrock.complete(req());
  assert.equal(res.text, "<p>a whole page</p>");
  assert.ok(frames < 20, `the tail should be cut off in one window, not re-armed 200 times (${frames})`);
});

test("a failure in the tail does not take the document with it", async () => {
  // Same rule from the other side: the message had already stopped, so a throttling or
  // stream error arriving afterwards is about the accounting, not about the page. The
  // document is delivered and the call simply reports no usage.
  const bedrock = converse();
  stubConverse(
    bedrock,
    script([
      { contentBlockDelta: { delta: { text: "<p>a whole page</p>" }, contentBlockIndex: 0 } },
      { messageStop: { stopReason: "end_turn" } },
      { throttlingException: { message: "slow down" } },
    ]),
  );
  const res = await bedrock.complete(req());
  assert.equal(res.text, "<p>a whole page</p>");
  assert.equal(res.usage, undefined);
});

test("a failure BEFORE the message stops still fails the call", async () => {
  // The boundary that makes the two tests above safe: the same exception one event earlier
  // is a partial document, and partial documents are never returned.
  const bedrock = converse();
  stubConverse(
    bedrock,
    script([
      { contentBlockDelta: { delta: { text: "<p>half" }, contentBlockIndex: 0 } },
      { throttlingException: { message: "slow down" } },
      { messageStop: { stopReason: "end_turn" } },
    ]),
  );
  await assert.rejects(() => bedrock.complete(req()), /throttlingException: slow down/);
});

test("the trailing window does not rescue a stream that stopped before the message did", async () => {
  // The short window is armed by the stop event and by nothing else, so a stream that goes
  // quiet mid-generation still gets the idle diagnosis rather than a 10-second one.
  const bedrock = new BedrockProvider(
    { default_model: MODEL, api: "converse" } as never,
    { trailingTimeoutMs: 60, idleTimeoutMs: 120, firstOutputTimeoutMs: 5_000 },
  );
  stubConverse(bedrock, async function* (signal: AbortSignal) {
    yield { contentBlockDelta: { delta: { text: "<p>half" }, contentBlockIndex: 0 } };
    await sleepUnlessAborted(10_000, signal);
  });
  await assert.rejects(
    () => bedrock.complete(req()),
    (e: Error) => {
      assert.ok(e instanceof StalledStreamError);
      assert.equal((e as StalledStreamError).kind, "idle");
      return true;
    },
  );
});

// --- which dialect a run used ------------------------------------------------------------

test("the dialect rides on every model_call, so a bench round says which one produced it", async () => {
  // The point of the switch is comparing two APIs against each other; a comparison whose run
  // log does not say which side a number came from is not one. Reported per call rather than
  // once at boot, because a deployment can be reconfigured between runs of the same session.
  assert.equal(converse().dialect, "converse");
  assert.equal(new BedrockProvider({ default_model: MODEL } as never).dialect, "invoke");

  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const router = new ProviderRouter(
    { providers: { default: "bedrock", bedrock: { default_model: MODEL, api: "converse" } } } as never,
    (type, data) => events.push({ type, data }),
  );
  const provider = (router as unknown as { build(n: string): BedrockProvider }).build("bedrock");
  stubConverse(provider, script(done("end_turn", { inputTokens: 4, outputTokens: 5 })));
  await router.complete("page", "vision", [{ role: "user", content: "hi" }]);
  for (const e of events) {
    assert.equal(e.data.api, "converse", e.type);
    assert.equal(e.data.provider, "bedrock", e.type);
  }
  assert.deepEqual(
    events.map((e) => e.type),
    ["model_call_start", "model_call"],
  );
});

test("a provider with one API adds no api field, so today's log lines are unchanged", async () => {
  const events: Array<Record<string, unknown>> = [];
  const router = new ProviderRouter(
    { providers: { default: "openrouter", openrouter: { default_model: "m", api_key: "k" } } } as never,
    (_type, data) => events.push(data),
  );
  const provider = (router as unknown as { build(n: string): { complete: unknown } }).build("openrouter");
  (provider as { complete: unknown }).complete = async () => ({
    text: "ok",
    model: "m",
    provider: "openrouter",
  });
  await router.complete("page", "vision", [{ role: "user", content: "hi" }]);
  assert.ok(events.length > 0);
  for (const data of events) assert.ok(!("api" in data), JSON.stringify(data));
});

test("a response carrying neither stream nor body fails as one, whichever API sent it", async () => {
  const bedrock = converse();
  (bedrock as unknown as { client: unknown }).client = { send: async () => ({}) };
  await assert.rejects(() => bedrock.complete(req()), /carried no event stream/);
});

// Exactly what the AWS SDK throws when an abortSignal fires (see providers.test.ts): a
// bare Error named AbortError, which the adapter must replace with a stall it can explain.
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  const abortError = () => Object.assign(new Error("Request aborted"), { name: "AbortError" });
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
