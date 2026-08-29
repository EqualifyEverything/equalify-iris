// Issue #249: `providers.bedrock.max_tokens` is 32000, several Bedrock models cap output
// well below that, and they REFUSE the request rather than clamping it. So the change
// `providers` exists for — swapping a capability to another model by editing config —
// fails every call for every page of every document, and nothing in the rejection names
// `max_tokens` as the setting at fault. The pipeline reports it as pages lost, which reads
// as a model that cannot do the work.
//
// Both rejections quoted here are verbatim from Bedrock in us-east-1 on 2026-08-28, and the
// command that produced each is in the comment above `OUTPUT_CEILING_STATED` in
// `src/providers/bedrock.ts`. That matters more than usual: the whole fix reads a number out
// of a sentence AWS wrote, so a test using invented wording would prove nothing about the
// only input this code has.
//
// What is pinned:
//   1. The number is read from "the model limit of N" — the part both APIs print — and the
//      call is sent again at N, once, on both dialects.
//   2. N is remembered per MODEL, so a 50-page document pays one rejected request rather
//      than fifty, and a Nova's ceiling never clamps a Claude served by the same block.
//   3. A refusal this code cannot answer still names the knob, because that is the half of
//      the issue an operator needs at 3am ("a page lost to a config ceiling and a page lost
//      to a model that can't read tables need different responses").
//   4. A prompt-size refusal is NOT taken for this one: it has a working recovery of its
//      own (the review loop drops page images), and stealing it would replace that with a
//      retry that changes nothing.
//   5. Nothing moved for a deployment whose model accepts 32000: same request, one attempt,
//      no warning.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BedrockProvider,
  refusedForOutputCeiling,
  statedOutputCeiling,
} from "../src/providers/bedrock.ts";
import { TruncatedResponseError, isRequestTooLargeError } from "../src/providers/types.ts";

// The model the issue was found on, and one Anthropic model on the same provider block, so
// "remembered per model" is testable against the case that makes it necessary.
const NOVA = "amazon.nova-pro-v1:0";
const CLAUDE = "us.anthropic.claude-sonnet-4-6";

// Verbatim. The Converse rejection carries the advisory second sentence and the InvokeModel
// one does not, which is why the ceiling is read from the first.
const NOVA_REFUSAL =
  "The maximum tokens you requested exceeds the model limit of 10000. " +
  "Try again with a maximum tokens value that is lower than 10000.";
const CLAUDE_REFUSAL = "The maximum tokens you requested exceeds the model limit of 128000";

// How the AWS SDK delivers it: "ValidationException" in `name`, the bare sentence in
// `message`. Only the CLI prints them joined, so a check that read `message` alone would
// pass here and fail in production on any wording that needs the name.
function validationException(message: string): Error {
  const e = new Error(message);
  e.name = "ValidationException";
  return e;
}

type Reply = { throws: unknown } | { events: unknown[] };

// One scripted reply per ATTEMPT, and the inputs of every command that was sent. An attempt
// with no script throws, so a test that expected two calls and got three fails loudly
// rather than reusing the last reply.
function stubAttempts(bedrock: BedrockProvider, replies: Reply[]): Record<string, any>[] {
  const inputs: Record<string, any>[] = [];
  (bedrock as unknown as { client: unknown }).client = {
    send: async (cmd: any) => {
      const reply: Reply = replies[inputs.length] ?? {
        throws: new Error(`stub: attempt ${inputs.length + 1} was not scripted`),
      };
      inputs.push(cmd.input);
      if ("throws" in reply) throw reply.throws;
      const events = (async function* () {
        for (const e of reply.events) yield e;
      })();
      // `stream` on Converse and `body` on InvokeModelWithResponseStream. Keyed off the
      // adapter's own dialect so one helper serves both paths.
      return bedrock.dialect === "converse" ? { stream: events } : { body: events };
    },
  };
  return inputs;
}

// A finished ConverseStream response.
const converseDone = (text: string): unknown[] => [
  { messageStart: { role: "assistant" } },
  { contentBlockDelta: { delta: { text }, contentBlockIndex: 0 } },
  { messageStop: { stopReason: "end_turn" } },
  { metadata: { usage: { inputTokens: 3, outputTokens: 52 } } },
];

// The same as an Anthropic-native stream, which arrives as JSON inside `chunk.bytes`.
const chunk = (event: unknown): unknown => ({
  chunk: { bytes: new TextEncoder().encode(JSON.stringify(event)) },
});
const invokeDone = (text: string): unknown[] => [
  chunk({ type: "message_start", message: { usage: { input_tokens: 3 } } }),
  chunk({ type: "content_block_delta", delta: { type: "text_delta", text } }),
  chunk({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 52 } }),
  chunk({ type: "message_stop" }),
];

const provider = (cfg: Record<string, unknown>): BedrockProvider =>
  new BedrockProvider(cfg as never);

const req = (model: string, extra: Record<string, unknown> = {}) => ({
  capability: "vision" as const,
  model,
  messages: [{ role: "user" as const, content: "transcribe this page" }],
  ...extra,
});

// Warnings are asserted on rather than allowed to print: the retry says something an
// operator has to act on, and a test suite that swallowed it could not tell the difference
// between saying it and not.
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

// --- reading the ceiling out of what Bedrock actually says ------------------------------

test("the stated ceiling is read from the sentence both Bedrock APIs print", () => {
  assert.equal(statedOutputCeiling(validationException(NOVA_REFUSAL)), 10_000);
  assert.equal(statedOutputCeiling(validationException(CLAUDE_REFUSAL)), 128_000);
  // The value to retry at is the one the message calls the limit, NOT the one its advice
  // says to stay under — they are the same number, and asking Nova Pro for exactly 10000
  // succeeds (verified against Bedrock; 52 output tokens came back). Subtracting one to
  // satisfy "lower than" would give away output nothing refused.
  assert.equal(statedOutputCeiling(validationException(NOVA_REFUSAL.split(".")[0])), 10_000);
  // Whatever else an upstream is saying, this is not it.
  assert.equal(statedOutputCeiling(validationException("Input is too long for requested model.")), null);
  assert.equal(statedOutputCeiling(new Error("socket hang up")), null);
  assert.equal(statedOutputCeiling("not an error at all"), null);
});

test("a refusal over the PROMPT's size is never taken for a refusal over the output ceiling", () => {
  // The two read alike and have opposite remedies: this one the review loop recovers from
  // by dropping page images (pipeline/review.ts), and it must keep reaching that recovery.
  const prompt = [
    "Input is too long for requested model.",
    // One phrasing in the wild says both at once, and it is a CONTEXT refusal: lowering the
    // output ceiling would not have helped it. Found in the bench's own run logs.
    "This model's maximum context length is 4096 tokens. However, you requested 4096 output" +
      " tokens and your prompt contains 27901 characters",
  ];
  for (const message of prompt) {
    const e = validationException(message);
    assert.equal(isRequestTooLargeError(e), true, `should still be a size refusal: ${message}`);
    assert.equal(refusedForOutputCeiling(e), false, `should not be read as a ceiling refusal: ${message}`);
  }
});

test("the Anthropic body's context refusal names max_tokens and is still a size refusal", () => {
  // The wording an `invoke` deployment gets when the PROMPT plus the ceiling will not fit the
  // window. It names `max_tokens` and a limit, which is the shape `refusedForOutputCeiling`'s
  // broad branch looks for, and reading it as an output-ceiling refusal would tell an operator
  // "the model is not being asked to do work it cannot do" about a prompt that does not fit.
  // Two things follow from matching it in `isRequestTooLargeError` instead: the diagnosis is
  // right, and the review loop's image-drop recovery (pipeline/review.ts) can reach a refusal
  // it previously had no way to answer.
  const e = validationException(
    "input length and `max_tokens` exceed context limit: 199000 + 32000 > 200000, " +
      "decrease input length or `max_tokens` and try again",
  );
  assert.equal(isRequestTooLargeError(e), true);
  assert.equal(refusedForOutputCeiling(e), false);
});

test("a validation refusal naming the ceiling in other words is still recognized", () => {
  // No number to retry at, so nothing is retried — but it is worth recognizing anyway,
  // because naming the knob is most of what the issue asks for and a wording AWS changes
  // tomorrow should not cost that.
  assert.equal(
    refusedForOutputCeiling(validationException("max_tokens: 32000 > 8192, which is the maximum allowed")),
    true,
  );
  assert.equal(statedOutputCeiling(validationException("max_tokens: 32000 > 8192, which is the maximum allowed")), null);
  // A validation failure about something else entirely is left alone.
  assert.equal(
    refusedForOutputCeiling(validationException("Conversation roles must alternate user/assistant")),
    false,
  );
  assert.equal(refusedForOutputCeiling(new Error("ThrottlingException: slow down")), false);
});

// --- the retry, on both dialects --------------------------------------------------------

test("a model that refuses the deployment's ceiling is asked again at its own", async () => {
  const bedrock = provider({ default_model: NOVA, api: "converse" });
  const inputs = stubAttempts(bedrock, [
    { throws: validationException(NOVA_REFUSAL) },
    { events: converseDone("<p>the page</p>") },
  ]);
  const [result, warnings] = await capturingWarnings(() => bedrock.complete(req(NOVA)));

  assert.equal(result.text, "<p>the page</p>");
  assert.equal(inputs.length, 2, "the refusal should be answered by exactly one more attempt");
  assert.deepEqual(inputs[0].inferenceConfig, { maxTokens: 32_000 });
  assert.deepEqual(inputs[1].inferenceConfig, { maxTokens: 10_000 });
  // Same request otherwise: the ceiling is the only thing that changed, because nothing
  // about the prompt was refused.
  assert.deepEqual(inputs[1].messages, inputs[0].messages);
  assert.equal(inputs[1].modelId, NOVA);

  // The config is still wrong, and the run only survived it because of this code. So it is
  // said once, with both numbers and the key.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /providers\.bedrock\.max_tokens is 32000/);
  assert.match(warnings[0], /stated its own ceiling of 10000/);
  assert.match(warnings[0], new RegExp(NOVA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("the same rescue works on the Anthropic body, where the ceiling is max_tokens", async () => {
  // `invoke` is what every deployment runs today, so a fix that only worked on the API
  // nobody has turned on yet would not be a fix. The wording here is the InvokeModel form
  // observed above — Bedrock's own sentence with no advisory second one — and 8192 stands
  // for any ceiling below the deployment's, since this path reaches Claude models only and
  // what is being pinned is which field the lowered ceiling lands in.
  const bedrock = provider({ default_model: CLAUDE });
  assert.equal(bedrock.dialect, "invoke");
  const inputs = stubAttempts(bedrock, [
    { throws: validationException("The maximum tokens you requested exceeds the model limit of 8192") },
    { events: invokeDone("<p>the page</p>") },
  ]);
  const [result] = await capturingWarnings(() => bedrock.complete(req(CLAUDE)));

  assert.equal(result.text, "<p>the page</p>");
  assert.equal(inputs.length, 2);
  assert.equal(JSON.parse(String(inputs[0].body)).max_tokens, 32_000);
  assert.equal(JSON.parse(String(inputs[1].body)).max_tokens, 8_192);
  // The Anthropic body is otherwise the one it always was, ceiling apart.
  const [before, after] = inputs.map((i) => JSON.parse(String(i.body)));
  assert.equal(after.anthropic_version, "bedrock-2023-05-31");
  assert.deepEqual(after.messages, before.messages);
});

test("a ceiling at or above what was asked for is reported, not retried", async () => {
  // Bedrock refusing 32000 while naming a limit of 128000 is a rejection this adapter does
  // not understand: retrying at 128000 would ask for MORE than what was just refused, and
  // retrying at 32000 would send the identical request. So it stops, and says which knob.
  const bedrock = provider({ default_model: CLAUDE, api: "converse" });
  const inputs = stubAttempts(bedrock, [{ throws: validationException(CLAUDE_REFUSAL) }]);
  const [, warnings] = await capturingWarnings(async () => {
    await assert.rejects(() => bedrock.complete(req(CLAUDE)), (e: Error) => {
      assert.match(e.message, /providers\.bedrock\.max_tokens is the setting at fault/);
      // The operator's other option, since one block can serve several models.
      assert.match(e.message, /route this capability to a model whose ceiling is at least that high/);
      // And what Bedrock said, so the diagnosis is not only ours.
      assert.match(e.message, /Bedrock said: The maximum tokens you requested exceeds/);
      assert.equal((e as Error & { cause?: unknown }).cause instanceof Error, true);
      return true;
    });
  });
  assert.equal(inputs.length, 1, "nothing should be sent again");
  assert.equal(warnings.length, 0, "a call that failed is reported by failing, not by a warning");
});

test("a refusal with no number in it still names the knob, and is not retried", async () => {
  const bedrock = provider({ default_model: NOVA, api: "converse" });
  const inputs = stubAttempts(bedrock, [
    { throws: validationException("maxTokens exceeds the maximum allowed for this model") },
  ]);
  await assert.rejects(() => bedrock.complete(req(NOVA)), (e: Error) => {
    assert.equal(e.name, "OutputCeilingRefusedError");
    assert.match(e.message, /asking for 32000 output tokens/);
    assert.match(e.message, /providers\.bedrock\.max_tokens is the setting at fault/);
    // Deliberately clear of every phrase `isRequestTooLargeError` matches: read as a
    // prompt-size refusal, this would send the review loop dropping page images and asking
    // again at the same ceiling.
    assert.equal(isRequestTooLargeError(e), false);
    return true;
  });
  assert.equal(inputs.length, 1);
});

test("a second refusal is reported rather than retried again", async () => {
  const bedrock = provider({ default_model: NOVA, api: "converse" });
  const inputs = stubAttempts(bedrock, [
    { throws: validationException(NOVA_REFUSAL) },
    { throws: validationException("The maximum tokens you requested exceeds the model limit of 4096") },
  ]);
  await capturingWarnings(async () => {
    await assert.rejects(() => bedrock.complete(req(NOVA)), (e: Error) => {
      assert.equal(e.name, "OutputCeilingRefusedError");
      // The number the SECOND attempt asked for, which is the request that was refused.
      assert.match(e.message, /asking for 10000 output tokens/);
      return true;
    });
  });
  assert.equal(inputs.length, 2, "two attempts, never a third");
});

test("a failure that had already streamed output is not sent again", async () => {
  // The guarantee that makes the retry free is that a refusal happens BEFORE generation, so
  // nothing was billed. Held rather than argued: a failure carrying the same sentence after
  // text has arrived is a different event, and re-sending it would pay for the prompt twice.
  const bedrock = provider({ default_model: NOVA, api: "converse" });
  const inputs = stubAttempts(bedrock, [
    {
      events: [
        { contentBlockDelta: { delta: { text: "<p>half a page" }, contentBlockIndex: 0 } },
        { validationException: { message: NOVA_REFUSAL } },
      ],
    },
  ]);
  await assert.rejects(() => bedrock.complete(req(NOVA)), (e: Error) => {
    assert.match(e.message, /validationException: The maximum tokens you requested exceeds/);
    return true;
  });
  assert.equal(inputs.length, 1);
});

test("an error that is not about the ceiling passes through exactly as it arrived", async () => {
  const bedrock = provider({ default_model: NOVA, api: "converse" });
  const thrown = new Error("ThrottlingException: Too many requests");
  const inputs = stubAttempts(bedrock, [{ throws: thrown }]);
  await assert.rejects(() => bedrock.complete(req(NOVA)), (e: Error) => {
    assert.equal(e, thrown, "the caller must get the error it would have got before");
    return true;
  });
  assert.equal(inputs.length, 1);
});

// --- remembering it, which is what keeps a document from paying per page ----------------

test("the stated ceiling is remembered, so the next page does not pay for the lesson again", async () => {
  const bedrock = provider({ default_model: NOVA, api: "converse" });
  const inputs = stubAttempts(bedrock, [
    { throws: validationException(NOVA_REFUSAL) },
    { events: converseDone("<p>page one</p>") },
    { events: converseDone("<p>page two</p>") },
    { events: converseDone("<p>page three</p>") },
  ]);
  const [, warnings] = await capturingWarnings(async () => {
    for (const _ of [1, 2, 3]) await bedrock.complete(req(NOVA));
  });
  // Four sends for three pages: the first page paid one rejected request, and no page after
  // it did. On a 50-page document that is the difference between 1 and 50.
  assert.equal(inputs.length, 4);
  assert.deepEqual(
    inputs.map((i) => i.inferenceConfig.maxTokens),
    [32_000, 10_000, 10_000, 10_000],
  );
  assert.equal(warnings.length, 1, "said once per model, not once per page");
});

test("the pages already in flight when the first one is refused are not five reports of one problem", async () => {
  // Pages are extracted five at a time (DEFAULT_EXTRACTION_CONCURRENCY), so on a fresh
  // process every call in the first batch asks for the deployment's ceiling before any of
  // them has learned better, and all five are refused. That is what a real run looks like,
  // not an edge case: the rejections are free, but the paragraph about `max_tokens` is only
  // worth reading once. Scripted by the ceiling ASKED FOR rather than by attempt number, so
  // this test says nothing about the order five concurrent calls happen to resolve in.
  const bedrock = provider({ default_model: NOVA, api: "converse" });
  const asked: number[] = [];
  (bedrock as unknown as { client: unknown }).client = {
    send: async (cmd: any) => {
      const ceiling: number = cmd.input.inferenceConfig.maxTokens;
      asked.push(ceiling);
      if (ceiling > 10_000) throw validationException(NOVA_REFUSAL);
      return {
        stream: (async function* () {
          for (const e of converseDone("<p>page</p>")) yield e;
        })(),
      };
    },
  };

  const [results, warnings] = await capturingWarnings(() =>
    Promise.all([1, 2, 3, 4, 5].map(() => bedrock.complete(req(NOVA)))),
  );
  assert.equal(results.length, 5);
  for (const r of results) assert.equal(r.text, "<p>page</p>");
  // Five refusals is what concurrency costs, and it costs nothing: a request Bedrock never
  // read is not billed. What is bounded is the talking.
  assert.equal(asked.filter((n) => n === 32_000).length, 5);
  assert.equal(asked.filter((n) => n === 10_000).length, 5);
  assert.equal(warnings.length, 1, "one paragraph about the config, not one per in-flight page");

  // And the batch after it has learned: no rejection at all.
  const [, later] = await capturingWarnings(() => bedrock.complete(req(NOVA)));
  assert.equal(asked.at(-1), 10_000);
  assert.equal(later.length, 0);
});

test("a second refusal is at least learned from, so the next page does not repeat both of them", async () => {
  // The page that met a model refusing the ceiling it had just named is lost — a third
  // attempt is not on offer. But the number that model gave the second time is still the
  // best thing known about it, and throwing it away would make the next call re-learn the
  // same two refusals.
  const bedrock = provider({ default_model: NOVA, api: "converse" });
  const inputs = stubAttempts(bedrock, [
    { throws: validationException(NOVA_REFUSAL) },
    { throws: validationException("The maximum tokens you requested exceeds the model limit of 4096") },
    { events: converseDone("<p>the next page</p>") },
  ]);
  const [, warnings] = await capturingWarnings(async () => {
    await assert.rejects(() => bedrock.complete(req(NOVA)), /OutputCeilingRefused|setting at fault/);
    const next = await bedrock.complete(req(NOVA));
    assert.equal(next.text, "<p>the next page</p>");
  });
  // Two paragraphs on purpose, where every other case gets one: the first said later calls
  // would ask for 10000, and after the second refusal that is no longer true. A number in the
  // log the process has stopped using is worse than the repetition `warnedCeilings` prevents.
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /will ask for 10000/);
  assert.match(warnings[1], /refused 10000 as well and stated a ceiling of 4096/);
  assert.match(warnings[1], /not the 10000 named above/);
  assert.deepEqual(
    inputs.map((i) => i.inferenceConfig.maxTokens),
    [32_000, 10_000, 4_096],
    "the third request should start from what the second refusal named",
  );
});

test("the correction is said once too, however many in-flight pages found it out", async () => {
  // Same reason the first paragraph is gated: pages run five at a time, so every call already
  // in flight at the refused ceiling meets the same second refusal, and one paragraph
  // correcting one figure is the same amount of news however many pages discovered it.
  const bedrock = provider({ default_model: NOVA, api: "converse" });
  (bedrock as unknown as { client: unknown }).client = {
    send: async (cmd: any) => {
      const ceiling: number = cmd.input.inferenceConfig.maxTokens;
      throw validationException(
        ceiling > 10_000
          ? NOVA_REFUSAL
          : "The maximum tokens you requested exceeds the model limit of 4096",
      );
    },
  };
  const [, warnings] = await capturingWarnings(async () => {
    const settled = await Promise.allSettled([1, 2, 3].map(() => bedrock.complete(req(NOVA))));
    for (const s of settled) assert.equal(s.status, "rejected");
  });
  assert.equal(warnings.length, 2, "one paragraph and one correction, not one pair per page");
  assert.match(warnings[1], /stated a ceiling of 4096/);
});

test("a refusal that arrives after the prompt was billed is not sent again", async () => {
  // `spent`, not "no text yet": the Anthropic stream reports the PROMPT's token counts in
  // `message_start`, before any delta, so a failure arriving after that event has been paid
  // for in full while having produced nothing. Re-sending it would buy the same prompt twice
  // and — because the router keeps only the latest usage snapshot — lose the first attempt's
  // input tokens from the `model_call` line entirely. Bedrock delivers this refusal as an
  // HTTP error today; the guard does not depend on that staying true.
  const bedrock = provider({ default_model: CLAUDE });
  const seen: unknown[] = [];
  const inputs = stubAttempts(bedrock, [
    {
      events: [
        chunk({ type: "message_start", message: { usage: { input_tokens: 9_000 } } }),
        { validationException: { message: NOVA_REFUSAL } },
      ],
    },
  ]);
  await assert.rejects(
    () => bedrock.complete(req(CLAUDE, { onUsage: (u: unknown) => seen.push(u) })),
    /validationException: The maximum tokens you requested exceeds/,
  );
  assert.equal(inputs.length, 1, "the prompt was already paid for, so this is not free to repeat");
  assert.deepEqual(seen.at(-1), { input_tokens: 9_000 });
});

test("one model's ceiling does not clamp another served by the same provider block", async () => {
  // `per_capability` and `providers.per_agent` can put a Nova on vision and a Claude on
  // text through one block. Lowering the block's ceiling because the Nova refused would give
  // away output the Claude never refused — quietly, as truncated pages.
  const bedrock = provider({ default_model: CLAUDE, api: "converse" });
  const inputs = stubAttempts(bedrock, [
    { throws: validationException(NOVA_REFUSAL) },
    { events: converseDone("<p>nova page</p>") },
    { events: converseDone("<p>claude page</p>") },
  ]);
  await capturingWarnings(async () => {
    await bedrock.complete(req(NOVA));
    await bedrock.complete(req(CLAUDE));
  });
  assert.deepEqual(
    inputs.map((i) => [i.modelId, i.inferenceConfig.maxTokens]),
    [[NOVA, 32_000], [NOVA, 10_000], [CLAUDE, 32_000]],
  );
});

test("a truncation on a clamped model names the model's ceiling, not the deployment's", async () => {
  // With the ceiling lowered, a dense page can now hit it — and the standing advice ("raise
  // providers.bedrock.max_tokens") is then wrong twice over: the setting is already higher
  // than what was asked for, and this model refuses more than it granted.
  const bedrock = provider({ default_model: NOVA, api: "converse" });
  stubAttempts(bedrock, [
    { throws: validationException(NOVA_REFUSAL) },
    {
      events: [
        { contentBlockDelta: { delta: { text: "<p>cut mid-" }, contentBlockIndex: 0 } },
        { messageStop: { stopReason: "max_tokens" } },
        { metadata: { usage: { inputTokens: 5, outputTokens: 10_000 } } },
      ],
    },
  ]);
  await capturingWarnings(async () => {
    await assert.rejects(() => bedrock.complete(req(NOVA)), (e: Error) => {
      assert.ok(e instanceof TruncatedResponseError);
      assert.equal(e.maxTokens, 10_000);
      assert.match(e.message, /hit the 10000-token output ceiling/);
      assert.match(e.message, /below the 32000 in providers\.bedrock\.max_tokens/);
      assert.match(e.message, /raising that setting will not move it/);
      return true;
    });
  });
});

test("a truncation on a model that accepted the ceiling reads exactly as it always did", async () => {
  // The note above is for the clamped case only. Nothing about the message an operator has
  // been reading for a year moves for the deployment that never met a lower ceiling —
  // docs/API.md quotes it verbatim.
  const bedrock = provider({ default_model: CLAUDE, api: "converse" });
  stubAttempts(bedrock, [
    {
      events: [
        { contentBlockDelta: { delta: { text: "<p>cut mid-" }, contentBlockIndex: 0 } },
        { messageStop: { stopReason: "max_tokens" } },
      ],
    },
  ]);
  await assert.rejects(() => bedrock.complete(req(CLAUDE)), (e: Error) => {
    assert.equal(
      e.message,
      "bedrock: response hit the 32000-token output ceiling and was truncated " +
        "(11 chars returned). Raise providers.bedrock.max_tokens.",
    );
    return true;
  });
});

// --- and nothing moved for a deployment whose model accepts 32000 -----------------------

test("a model that accepts the deployment's ceiling is called once, at that ceiling, silently", async () => {
  for (const api of ["invoke", "converse"]) {
    const bedrock = provider({ default_model: CLAUDE, ...(api === "converse" ? { api } : {}) });
    const inputs = stubAttempts(bedrock, [
      { events: api === "converse" ? converseDone("<p>page</p>") : invokeDone("<p>page</p>") },
    ]);
    const [result, warnings] = await capturingWarnings(() => bedrock.complete(req(CLAUDE)));
    assert.equal(result.text, "<p>page</p>", api);
    assert.equal(inputs.length, 1, api);
    assert.equal(warnings.length, 0, api);
    const asked = api === "converse"
      ? inputs[0].inferenceConfig.maxTokens
      : JSON.parse(String(inputs[0].body)).max_tokens;
    assert.equal(asked, 32_000, api);
  }
});

test("an explicit max_tokens is still the ceiling asked for, and still the one clamped from", async () => {
  const bedrock = provider({ default_model: NOVA, api: "converse", max_tokens: 12_345 });
  const inputs = stubAttempts(bedrock, [
    { throws: validationException(NOVA_REFUSAL) },
    { events: converseDone("<p>page</p>") },
  ]);
  const [, warnings] = await capturingWarnings(() => bedrock.complete(req(NOVA)));
  assert.deepEqual(
    inputs.map((i) => i.inferenceConfig.maxTokens),
    [12_345, 10_000],
  );
  assert.match(warnings[0], /providers\.bedrock\.max_tokens is 12345/);
});

// --- and it is told to the caller, not only to stderr (#254) -----------------------------
//
// The warning above is the operator's copy and is deliberately said once per process. The
// note is the RUN LOG's copy, and the two have opposite dedup rules: a paragraph repeated
// per page is noise, while a document whose second page silently omits the fact reads as a
// document that did not hit it. Nothing here asserts what the router does with the note —
// that seam is test/providers.test.ts.
//
// `refused` is what keeps one note doing two jobs honestly: `false` is the CONDITION (this
// call ran below the configured ceiling), `true` adds the COST (this call had a request
// refused and re-sent, so its duration covers two).

test("a clamped call tells its caller which ceiling was asked for and which was granted", async () => {
  // Both dialects, each paired with a model and a refusal that actually occur on it: the
  // Anthropic body reaches Claude models only, and its rejection is the shorter wording.
  const cases = [
    { api: "converse", model: NOVA, refusal: NOVA_REFUSAL, stated: 10_000, done: converseDone },
    {
      api: "invoke",
      model: CLAUDE,
      refusal: "The maximum tokens you requested exceeds the model limit of 8192",
      stated: 8_192,
      done: invokeDone,
    },
  ] as const;
  for (const c of cases) {
    const bedrock = provider({ default_model: c.model, ...(c.api === "converse" ? { api: c.api } : {}) });
    assert.equal(bedrock.dialect, c.api);
    stubAttempts(bedrock, [
      { throws: validationException(c.refusal) },
      { events: c.done("<p>page</p>") },
    ]);
    const notes: unknown[] = [];
    const [result] = await capturingWarnings(() =>
      bedrock.complete(req(c.model, { onNote: (n: unknown) => notes.push(n) })),
    );
    assert.equal(result.text, "<p>page</p>", c.api);
    // Both numbers, because either alone is unactionable: the pair is what says which way to
    // move `max_tokens` and how far.
    assert.deepEqual(
      notes,
      [{ kind: "output_ceiling_clamped", model: c.model, asked: 32_000, stated: c.stated, refused: true }],
      c.api,
    );
  }
});

test("every page that runs at a clamped ceiling says so, however quiet stderr has gone", async () => {
  // The one behaviour the note does NOT share with the warning, and the reason it reports the
  // condition rather than only the refusal. `warnedCeilings` says the paragraph once per
  // process on purpose — and `ceilings` remembers the number for just as long, so a note that
  // only rode the retry would land on ONE `model_call` in the life of a server. Booted a month
  // ago, that is one clamped call in the first run log and nothing in the thirty documents
  // since: the "no trace anyone aggregates" this is supposed to fix.
  //
  // Page one pays a rejected request and pages two and three do not, which is exactly the
  // difference `refused` carries.
  const bedrock = provider({ default_model: NOVA, api: "converse" });
  stubAttempts(bedrock, [
    { throws: validationException(NOVA_REFUSAL) },
    { events: converseDone("<p>page one</p>") },
    { events: converseDone("<p>page two</p>") },
    { events: converseDone("<p>page three</p>") },
  ]);
  const notes: unknown[][] = [];
  const [, warnings] = await capturingWarnings(async () => {
    for (const _ of [1, 2, 3]) {
      const mine: unknown[] = [];
      notes.push(mine);
      await bedrock.complete(req(NOVA, { onNote: (n: unknown) => mine.push(n) }));
    }
  });
  assert.equal(warnings.length, 1, "stderr is still told once");
  const clamped = (refused: boolean) => ({
    kind: "output_ceiling_clamped",
    model: NOVA,
    asked: 32_000,
    stated: 10_000,
    refused,
  });
  assert.deepEqual(notes, [[clamped(true)], [clamped(false)], [clamped(false)]]);
});

test("a call refused twice reports both steps, so the log names the ceiling it ended at", async () => {
  // The pair the router folds into one span. Reported as two notes rather than one covering
  // 32000 -> 4096, because that is what happened and the adapter is not the layer that decides
  // how a run log summarizes it.
  const bedrock = provider({ default_model: NOVA, api: "converse" });
  stubAttempts(bedrock, [
    { throws: validationException(NOVA_REFUSAL) },
    { throws: validationException("The maximum tokens you requested exceeds the model limit of 4096") },
  ]);
  const notes: unknown[] = [];
  await capturingWarnings(async () => {
    await assert.rejects(
      () => bedrock.complete(req(NOVA, { onNote: (n: unknown) => notes.push(n) })),
      /setting at fault/,
    );
  });
  // Including on the call that then FAILED: a lost page is exactly the one worth knowing ran
  // into a config ceiling, and a note that only rode the success path would omit it.
  assert.deepEqual(notes, [
    { kind: "output_ceiling_clamped", model: NOVA, asked: 32_000, stated: 10_000, refused: true },
    { kind: "output_ceiling_clamped", model: NOVA, asked: 10_000, stated: 4_096, refused: true },
  ]);
});

test("one model's clamp puts no note on another served by the same provider block", async () => {
  // The condition is per MODEL, like the ceiling it reports. A block serving a Nova on vision
  // and a Claude on text (`per_capability`) would otherwise mark every Claude call as running
  // below the deployment's ceiling, which is a config error to go and fix that is not there.
  const bedrock = provider({ default_model: CLAUDE, api: "converse" });
  stubAttempts(bedrock, [
    { throws: validationException(NOVA_REFUSAL) },
    { events: converseDone("<p>nova page</p>") },
    { events: converseDone("<p>claude page</p>") },
  ]);
  const nova: unknown[] = [];
  const claude: unknown[] = [];
  await capturingWarnings(async () => {
    await bedrock.complete(req(NOVA, { onNote: (n: unknown) => nova.push(n) }));
    await bedrock.complete(req(CLAUDE, { onNote: (n: unknown) => claude.push(n) }));
  });
  assert.equal(nova.length, 1);
  assert.deepEqual(claude, []);
});

test("a refusal nothing was clamped from is reported by failing, not by a note", async () => {
  // Bedrock refusing 32000 while naming a limit of 128000: no lower ceiling was adopted and
  // nothing was re-sent, so there is no clamp to record. The call throws, and the message
  // already names the knob — a note here would put `output_ceiling_stated: 128000` on a log
  // line where 128000 is not a ceiling anyone is running at.
  const bedrock = provider({ default_model: CLAUDE, api: "converse" });
  stubAttempts(bedrock, [{ throws: validationException(CLAUDE_REFUSAL) }]);
  const notes: unknown[] = [];
  await assert.rejects(
    () => bedrock.complete(req(CLAUDE, { onNote: (n: unknown) => notes.push(n) })),
    /setting at fault/,
  );
  assert.deepEqual(notes, []);
});

test("a model that accepts the deployment's ceiling produces no note at all", async () => {
  // The invariant that keeps the new log fields meaningful: their presence means a ceiling was
  // lowered. A deployment whose models accept `max_tokens` must never show them.
  const bedrock = provider({ default_model: CLAUDE, api: "converse" });
  stubAttempts(bedrock, [{ events: converseDone("<p>page</p>") }]);
  const notes: unknown[] = [];
  const [result] = await capturingWarnings(() =>
    bedrock.complete(req(CLAUDE, { onNote: (n: unknown) => notes.push(n) })),
  );
  assert.equal(result.text, "<p>page</p>");
  assert.deepEqual(notes, []);
});

test("a caller that passes no onNote is served exactly as before", async () => {
  // Every caller but the router does this — the adapters are constructed directly in several
  // tests and in providers/imageLimits.ts's neighbourhood — so the callback being absent has
  // to be ordinary rather than a crash inside the retry.
  const bedrock = provider({ default_model: NOVA, api: "converse" });
  const inputs = stubAttempts(bedrock, [
    { throws: validationException(NOVA_REFUSAL) },
    { events: converseDone("<p>page</p>") },
  ]);
  const [result] = await capturingWarnings(() => bedrock.complete(req(NOVA)));
  assert.equal(result.text, "<p>page</p>");
  assert.equal(inputs.length, 2);
});
