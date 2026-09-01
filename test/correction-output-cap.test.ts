// Issue #285: one correction call asked for the deployment's whole 32,000-token output ceiling,
// ran for 420 seconds, was truncated, and was thrown away — $0.5091 on a single page, 4.6% of what
// the other 99 pages of that document cost together, and the page shipped with all six of the
// problems the call was bought to fix. Output tokens are billed whether or not the text is kept.
//
// The correction pass is the one model call in the pipeline whose answer has a size known before
// it is made: it is handed a page it has already rendered and asked to return that page with named
// problems fixed. So it is the one call that can say how much output it may buy, and this file
// pins the whole path that number travels:
//
//   1. the arithmetic (`correctionOutputCeiling`) and the floor under it, against the numbers
//      measured in the issue rather than against round ones;
//   2. both adapters honouring it, always as a CEILING — a call site can ask for less room than
//      the deployment configured and never for more;
//   3. the two things a cap must not be mistaken for. It is not the `output_ceiling_clamped`
//      condition (#249/#254), which says a config error is live; and a truncation at a cap must
//      not send whoever reads it to `providers.*.max_tokens`, which is already higher.
//   4. the cap and the failure reaching the run log, because whether 3x is the right multiple is
//      a question a run should be able to answer rather than one the comment asserts.
//
// The seams matter more than usual here. A cap that silently does nothing is a saving that reads
// as applied and is not, and the failure it exists to make cheaper is rare — 1 in 111 correction
// attempts — so a wire-level regression would not show up as anything for months.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORRECTION_OUTPUT_FLOOR,
  CORRECTION_OUTPUT_MULTIPLE,
  correctionOutputCeiling,
} from "../src/pipeline/correction.ts";
import { runExtraction } from "../src/pipeline/extraction.ts";
import { BedrockProvider } from "../src/providers/bedrock.ts";
import { OpenRouterProvider } from "../src/providers/openrouter.ts";
import { ProviderRouter } from "../src/providers/index.ts";
import { TruncatedResponseError } from "../src/providers/types.ts";
import type { ProviderNote } from "../src/providers/types.ts";
import type { IrisConfig } from "../src/config.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// --- 1. the number itself ----------------------------------------------------------------

test("the ceiling a correction asks for is the page it was handed, three times over", () => {
  // The failure the issue is about: a 14,287-character page whose correction emitted 96,709
  // characters at the 32,000-token ceiling. Half the page's characters is a generous token count
  // (`MIN_CHARS_PER_TOKEN` is a lower bound, not an average), so the cap it would have run under
  // is 7,144 × 3.
  assert.equal(correctionOutputCeiling(14_287), 21_432);
  // An odd character count rounds UP, not down: the page is the estimate and the estimate must
  // not come out below the page.
  assert.equal(correctionOutputCeiling(14_287), Math.ceil(14_287 / 2) * CORRECTION_OUTPUT_MULTIPLE);

  // Below the floor the floor wins, and it wins for every page small enough — including the
  // empty one, which is the page whose correction has the most to write.
  assert.equal(correctionOutputCeiling(0), CORRECTION_OUTPUT_FLOOR);
  assert.equal(correctionOutputCeiling(89), CORRECTION_OUTPUT_FLOOR);
  assert.equal(correctionOutputCeiling(5_332), CORRECTION_OUTPUT_FLOOR); // 2666 × 3 = 7998
  assert.equal(correctionOutputCeiling(5_334), 8_001); // 2667 × 3, just over it

  // And it only ever grows with the page, so no page size is quietly cheaper to correct than a
  // larger one.
  let previous = 0;
  for (const chars of [0, 1_000, 5_000, 10_000, 20_000, 60_000]) {
    const cap = correctionOutputCeiling(chars);
    assert.ok(cap >= previous, `${chars} chars: ${cap} < ${previous}`);
    previous = cap;
  }
});

test("no correction measured to have worked could be refused by this cap", () => {
  // The property that makes the cap safe to ship, and the reason the floor is 8,000 rather than a
  // tidier number. Across the 111 correction attempts in the issue's first comment, the largest
  // reply that SUCCEEDED was 7,060 output tokens (6,891 on the other model), against the 32,000
  // they were all allowed. The floor is above that, so the cap cannot refuse any of them at ANY
  // page size — the multiple can only add room.
  const LARGEST_SUCCESSFUL_CORRECTION = 7_060;
  assert.ok(
    CORRECTION_OUTPUT_FLOOR > LARGEST_SUCCESSFUL_CORRECTION,
    `the floor ${CORRECTION_OUTPUT_FLOOR} must clear the largest measured success`,
  );
  for (const chars of [0, 89, 1_000, 14_287, 40_000]) {
    assert.ok(correctionOutputCeiling(chars) >= LARGEST_SUCCESSFUL_CORRECTION, `${chars} chars`);
  }
  // The runaway, meanwhile, is refused: 96,709 characters is ~48,000 tokens at the same bound,
  // more than twice what its page's cap allowed. That is the call this exists to stop paying for
  // in full — not because the capped attempt would have succeeded, but because it would have cost
  // a third of what it did before failing the same way.
  assert.ok(Math.ceil(96_709 / 2) > correctionOutputCeiling(14_287));
});

// --- 2. and 3. the adapters --------------------------------------------------------------

// A model that accepts the deployment's 32,000, and one that refuses it and states 10,000 — the
// pair from #249, because a caller's cap and a model's own ceiling are two different reasons to
// run below the config and they must not be reported as each other.
const CLAUDE = "us.anthropic.claude-sonnet-4-6";
const NOVA = "amazon.nova-pro-v1:0";
const NOVA_REFUSAL =
  "The maximum tokens you requested exceeds the model limit of 10000. " +
  "Try again with a maximum tokens value that is lower than 10000.";

function validationException(message: string): Error {
  const e = new Error(message);
  e.name = "ValidationException";
  return e;
}

type Reply = { throws: unknown } | { events: unknown[] };

// One scripted reply per attempt, and the input of every command sent, so a test can say which
// ceiling went out on which request. An unscripted attempt throws rather than reusing the last
// reply.
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
      return bedrock.dialect === "converse" ? { stream: events } : { body: events };
    },
  };
  return inputs;
}

const converseDone = (text: string): unknown[] => [
  { contentBlockDelta: { delta: { text }, contentBlockIndex: 0 } },
  { messageStop: { stopReason: "end_turn" } },
  { metadata: { usage: { inputTokens: 3, outputTokens: 52 } } },
];
const converseCut = (text: string): unknown[] => [
  { contentBlockDelta: { delta: { text }, contentBlockIndex: 0 } },
  { messageStop: { stopReason: "max_tokens" } },
];

// The same, as the Anthropic-native stream an `invoke` deployment gets.
const chunk = (event: unknown): unknown => ({
  chunk: { bytes: new TextEncoder().encode(JSON.stringify(event)) },
});
const invokeDone = (text: string): unknown[] => [
  chunk({ type: "message_start", message: { usage: { input_tokens: 3 } } }),
  chunk({ type: "content_block_delta", delta: { type: "text_delta", text } }),
  chunk({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 52 } }),
  chunk({ type: "message_stop" }),
];

const bedrockProvider = (cfg: Record<string, unknown>): BedrockProvider =>
  new BedrockProvider(cfg as never);

const req = (model: string, extra: Record<string, unknown> = {}) => ({
  capability: "vision" as const,
  model,
  messages: [{ role: "user" as const, content: "correct this page" }],
  ...extra,
});

// What the request asked for, read off whichever dialect sent it.
const askedFor = (input: Record<string, any>, dialect: string): number =>
  dialect === "converse" ? input.inferenceConfig.maxTokens : JSON.parse(String(input.body)).max_tokens;

async function quietly<T>(body: () => Promise<T>): Promise<T> {
  const original = console.warn;
  console.warn = () => {};
  try {
    return await body();
  } finally {
    console.warn = original;
  }
}

test("a caller's cap is the ceiling that goes on the wire, on both Bedrock dialects", async () => {
  for (const api of ["invoke", "converse"]) {
    const bedrock = bedrockProvider({ default_model: CLAUDE, ...(api === "converse" ? { api } : {}) });
    const inputs = stubAttempts(bedrock, [
      { events: api === "converse" ? converseDone("<p>page</p>") : invokeDone("<p>page</p>") },
    ]);
    const res = await bedrock.complete(req(CLAUDE, { maxTokens: 8_000 }));
    assert.equal(res.text, "<p>page</p>", api);
    assert.equal(inputs.length, 1, api);
    // Not 32000. Both dialects, because a saving that applies on one wire format and not the
    // other is a saving nobody can quote.
    assert.equal(askedFor(inputs[0], bedrock.dialect), 8_000, api);
  }
});

test("a cap can only lower the ceiling, never raise it", async () => {
  // The direction of the guarantee. `maxTokens` on a request is a ceiling and never a floor: a
  // call site that asks for more than the deployment configured gets what the deployment
  // configured, so this cannot become a back door around `providers.bedrock.max_tokens`.
  const bedrock = bedrockProvider({ default_model: CLAUDE, api: "converse", max_tokens: 12_000 });
  const inputs = stubAttempts(bedrock, [
    { events: converseDone("<p>a</p>") },
    { events: converseDone("<p>b</p>") },
  ]);
  await bedrock.complete(req(CLAUDE, { maxTokens: 40_000 }));
  await bedrock.complete(req(CLAUDE, { maxTokens: 5_000 }));
  assert.deepEqual(inputs.map((i) => i.inferenceConfig.maxTokens), [12_000, 5_000]);
});

test("a call that capped itself is not a deployment whose ceiling was clamped", async () => {
  // The distinction that makes the field usable. `output_ceiling_clamped` means a config error is
  // live and its remedy is to edit `providers.bedrock.max_tokens` or route the capability
  // elsewhere (#249, #254). A correction asking for 8,000 tokens on purpose is the opposite of
  // that, and emitting the note for it would send an operator to a setting that is right — on
  // every corrected page of every document, which is where the note is loudest.
  const bedrock = bedrockProvider({ default_model: CLAUDE, api: "converse" });
  stubAttempts(bedrock, [{ events: converseDone("<p>page</p>") }]);
  const notes: ProviderNote[] = [];
  await bedrock.complete(req(CLAUDE, { maxTokens: 8_000, onNote: (n: ProviderNote) => notes.push(n) }));
  assert.deepEqual(notes, []);
});

test("a clamped model's note reports the model and the deployment, not the cap", async () => {
  // And the two facts coexist: this deployment IS misconfigured, and the call also capped itself.
  // The note is about the first — the numbers an operator acts on are the 32000 in config and the
  // 10000 this model grants — while the 8000 the correction chose is a third number that belongs
  // on the `model_call` line (`output_cap`) and not in this pair. Reporting the cap as `asked`
  // here would read as "your config says 8000", which is not a setting anyone can find.
  const bedrock = bedrockProvider({ default_model: NOVA, api: "converse" });
  const inputs = stubAttempts(bedrock, [
    { throws: validationException(NOVA_REFUSAL) }, // the uncapped call that learns the ceiling
    { events: converseDone("<p>learned</p>") },
    { events: converseDone("<p>capped</p>") },
  ]);
  const notes: ProviderNote[] = [];
  await quietly(async () => {
    await bedrock.complete(req(NOVA, { onNote: (n: ProviderNote) => notes.push(n) }));
    await bedrock.complete(req(NOVA, { maxTokens: 8_000, onNote: (n: ProviderNote) => notes.push(n) }));
  });
  assert.deepEqual(inputs.map((i) => i.inferenceConfig.maxTokens), [32_000, 10_000, 8_000]);
  assert.deepEqual(notes, [
    // The call that paid the rejected round-trip.
    { kind: "output_ceiling_clamped", model: NOVA, asked: 32_000, stated: 10_000, refused: true },
    // The capped call, still saying the config is wrong, still with the model's own number.
    { kind: "output_ceiling_clamped", model: NOVA, asked: 32_000, stated: 10_000, refused: false },
  ]);
});

test("a truncation at the caller's cap does not send anyone to providers.bedrock.max_tokens", async () => {
  // The cap makes a truncation shape possible that has never existed: a response cut off at a
  // ceiling BELOW the configured one, on a model that would have granted more. The standing
  // advice is wrong for it in both halves — the setting is already higher, and a reply that did
  // not fit in three times its page is a model running away with the request, which more room
  // does not fix. Whoever reads this at 3am is the only person who ever meets the cap, so the
  // message has to say where the number came from.
  const bedrock = bedrockProvider({ default_model: CLAUDE, api: "converse" });
  stubAttempts(bedrock, [{ events: converseCut("<p>cut mid-") }]);
  await assert.rejects(
    () => bedrock.complete(req(CLAUDE, { maxTokens: 8_000 })),
    (e: Error) => {
      assert.ok(e instanceof TruncatedResponseError);
      // The ceiling named is the one the call actually ran under, so `chars` and `maxTokens`
      // describe the same request.
      assert.equal(e.maxTokens, 8_000);
      assert.equal(e.text, "<p>cut mid-");
      assert.match(e.message, /hit the 8000-token output ceiling/);
      assert.match(e.message, /the call site asked for at most 8000 output tokens/);
      assert.match(e.message, /below the 32000 in providers\.bedrock\.max_tokens/);
      assert.match(e.message, /Raising that setting will not move it/);
      // And it is not attributed to the model, which granted the full ceiling and refused
      // nothing. That sentence would send someone hunting for a model with more room.
      assert.doesNotMatch(e.message, /is us\.anthropic[^ ]*'s own/);
      // Still the same error class and the same fixed clause the review loop matches on
      // (`isTruncatedResponseError`), because a capped truncation costs the round exactly as any
      // other truncation does.
      assert.match(e.message, /output ceiling and was truncated/);
      return true;
    },
  );
});

test("a cap above a clamped model's own ceiling still gets the model's sentence", async () => {
  // Both reasons to be under the configured ceiling at once, and the one that BIT is the model's:
  // the request went out at 20,000, was refused, and was re-sent at the 10,000 the model states.
  // A message blaming the cap would be false — the cap was not the ceiling that cut this off, and
  // lowering the multiple would not have changed anything about it.
  const bedrock = bedrockProvider({ default_model: NOVA, api: "converse" });
  const inputs = stubAttempts(bedrock, [
    { throws: validationException(NOVA_REFUSAL) },
    { events: converseCut("<p>cut mid-") },
  ]);
  await quietly(() =>
    assert.rejects(
      () => bedrock.complete(req(NOVA, { maxTokens: 20_000 })),
      (e: Error) => {
        assert.equal((e as TruncatedResponseError).maxTokens, 10_000);
        assert.match(e.message, new RegExp(`That ceiling is ${NOVA.replace(/\./g, "\\.")}'s own`));
        assert.doesNotMatch(e.message, /the call site asked for at most/);
        return true;
      },
    ),
  );
  assert.deepEqual(inputs.map((i) => i.inferenceConfig.maxTokens), [20_000, 10_000]);
});

test("a cap that ties with the deployment's ceiling says what it has always said", async () => {
  // A caller asking for exactly what the deployment allows has capped nothing, and the message it
  // gets is the one docs/API.md quotes verbatim — no clause about a call site, because there is
  // no lower number for a reader to go looking for.
  const bedrock = bedrockProvider({ default_model: CLAUDE, api: "converse" });
  stubAttempts(bedrock, [{ events: converseCut("<p>cut mid-") }]);
  await assert.rejects(() => bedrock.complete(req(CLAUDE, { maxTokens: 32_000 })), (e: Error) => {
    assert.equal(
      e.message,
      "bedrock: response hit the 32000-token output ceiling and was truncated " +
        "(11 chars returned). Raise providers.bedrock.max_tokens.",
    );
    return true;
  });
});

// --- OpenRouter, the other adapter -------------------------------------------------------

const sseDelta = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`;
const sseFinish = (finish_reason: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason }] })}`;
const SSE_DONE = "data: [DONE]";

// Captures the request bodies the adapter posts and answers with a fixed SSE stream.
async function withStream<T>(lines: string[], fn: (bodies: Record<string, any>[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const bodies: Record<string, any>[] = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      text: async () => "",
      body: (async function* () {
        yield new TextEncoder().encode(lines.join("\n\n") + "\n\n");
      })(),
    };
  }) as unknown as typeof fetch;
  try {
    return await fn(bodies);
  } finally {
    globalThis.fetch = original;
  }
}

const openrouter = (maxTokens?: number) =>
  new OpenRouterProvider({
    api_key: "k",
    base_url: "http://localhost:1/v1",
    default_model: "m",
    max_tokens: maxTokens,
  } as never);

test("OpenRouter honours the same cap, and gives the same reason when it is hit", async () => {
  // Honoured in both adapters rather than only in the one this deployment happens to run: a cap
  // that silently does nothing on OpenRouter is a saving that reads as applied and is not, which
  // is worse than not having it.
  await withStream([sseDelta("<p>page</p>"), sseFinish("stop"), SSE_DONE], async (bodies) => {
    await openrouter().complete(req("m", { capability: "text", maxTokens: 8_000 }) as never);
    assert.equal(bodies[0].max_tokens, 8_000);
  });
  // Never above the configured ceiling, same as Bedrock.
  await withStream([sseDelta("<p>page</p>"), sseFinish("stop"), SSE_DONE], async (bodies) => {
    await openrouter(12_000).complete(req("m", { capability: "text", maxTokens: 40_000 }) as never);
    assert.equal(bodies[0].max_tokens, 12_000);
  });
  await withStream([sseDelta("<p>cut"), sseFinish("length"), SSE_DONE], async () => {
    await assert.rejects(
      () => openrouter().complete(req("m", { capability: "text", maxTokens: 8_000 }) as never),
      (e: Error) => {
        assert.equal((e as TruncatedResponseError).maxTokens, 8_000);
        assert.match(e.message, /hit the 8000-token output ceiling/);
        assert.match(e.message, /the call site asked for at most 8000 output tokens/);
        assert.match(e.message, /below the 32000 in providers\.openrouter\.max_tokens/);
        return true;
      },
    );
  });
  // And an uncapped truncation is untouched, which is every call docs/API.md quotes this message
  // for.
  await withStream([sseDelta("<p>cut"), sseFinish("length"), SSE_DONE], async () => {
    await assert.rejects(() => openrouter().complete(req("m", { capability: "text" }) as never), (e: Error) => {
      assert.equal(
        e.message,
        "openrouter: response hit the 32000-token output ceiling and was truncated " +
          "(6 chars returned). Raise providers.openrouter.max_tokens.",
      );
      return true;
    });
  });
});

// --- 4. the router, and the run log ------------------------------------------------------

test("the cap reaches the wire through the router, and both model_call lines say it", async () => {
  // Two seams in one test, because neither is exercised anywhere else. The router is what turns a
  // call site's `maxTokens` into a request — a dropped field there would leave every correction
  // asking for 32,000 with `correctionOutputCeiling` fully unit-tested and green. And it is what
  // publishes `output_cap`, which is the only way to answer whether the multiple is set right: a
  // capped truncation is indistinguishable from any other unless the line says what the cap was.
  const cfg = {
    providers: { default: "bedrock", bedrock: { default_model: CLAUDE, api: "converse" } },
  } as unknown as IrisConfig;
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const router = new ProviderRouter(cfg, (type, data) => events.push({ type, data }));
  const bedrock = (router as unknown as { build(n: string): BedrockProvider }).build("bedrock");
  const inputs = stubAttempts(bedrock, [
    { events: converseDone("<p>a</p>") },
    { events: converseDone("<p>b</p>") },
  ]);

  await router.complete("page", "vision", [{ role: "user", content: "correct" }], {
    step: "correct",
    maxTokens: 21_432,
  });
  await router.complete("page", "vision", [{ role: "user", content: "render" }], { step: "extract" });

  assert.deepEqual(inputs.map((i) => i.inferenceConfig.maxTokens), [21_432, 32_000]);
  // On the START line as well as the end one: a correction that hangs or is still running is the
  // call this number is most often asked about, and it has no end line yet.
  const capped = events.filter((e) => e.data.step === "correct");
  assert.deepEqual(capped.map((e) => e.type), ["model_call_start", "model_call"]);
  for (const e of capped) assert.equal(e.data.output_cap, 21_432, e.type);
  // And absent — not zero, not the deployment's ceiling — on the calls that passed no cap, so the
  // field means "this call was bounded on purpose" and an aggregate can count it.
  for (const e of events.filter((ev) => ev.data.step === "extract")) {
    assert.ok(!("output_cap" in e.data), `${e.type} should carry no output_cap`);
  }
});

// --- the call site: extraction's correction pass -----------------------------------------

// A page long enough that the multiple, and not the floor, decides — so the test would fail if
// the cap stopped being derived from the page at all.
const BIG_PAGE =
  `<h2>Regional detail</h2>` +
  `<p>Southeast through Rocky Mountain, restated by county with the revisions noted.</p>`.repeat(240);

interface Asked {
  step: string;
  maxTokens: number | undefined;
}

// One page, rendered, failing its fidelity check, and a correction that hits its ceiling — the
// shape of #285's failure. Records what each call asked for and every event the run logged.
function cappedRunCtx(dir: string, asked: Asked[], events: Record<string, unknown>[]): PipelineContext {
  const agentsDir = join(dir, "agents");
  const inputDir = join(dir, "input");
  const fragDir = join(dir, "fragments");
  for (const d of [agentsDir, inputDir, fragDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
  writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\nvision\n");
  writeFileSync(join(inputDir, "page-001.png"), "not-a-real-png");
  return {
    sessionId: "ses_test",
    images: [{ name: "page-001.png", order: 1, path: join(inputDir, "page-001.png"), links: [] }],
    extractionConcurrency: 1,
    maxReviewIterations: 1,
    paths: {
      agentsDir,
      tmpAgentsDir: () => join(dir, "tmp-agents"),
      agentMemory: (a: string) => join(dir, `mem-${a.replace(/\.md$/, "")}.json`),
      sessionFragments: () => fragDir,
    } as unknown as Paths,
    router: {
      complete: async (
        _agent: string,
        _cap: string,
        messages: { role: string; content: string }[],
        opts: { step: string; maxTokens?: number },
      ) => {
        asked.push({ step: opts.step, maxTokens: opts.maxTokens });
        const user = messages.find((m) => m.role === "user")?.content ?? "";
        if (user.includes("TASK: verify")) {
          return {
            text: JSON.stringify({
              faithful: false,
              accessible: true,
              problems: [{ kind: "structure_wrong", problem: "the table has no header row" }],
            }),
          };
        }
        if (user.includes("had fidelity/accessibility problems")) {
          // What the runaway did: emitted far more than the page and was cut off. The adapter
          // raises rather than returning the fragment, and the ceiling it names is the cap.
          throw new TruncatedResponseError("bedrock", CLAUDE, opts.maxTokens ?? 32_000, "<p>runaway");
        }
        return { text: JSON.stringify({ html: BIG_PAGE, log: "" }) };
      },
    },
    log: {
      event: (type: string, fields: Record<string, unknown> = {}) => events.push({ type, ...fields }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
}

test("extraction's correction is the one call that caps itself, and the log says what it capped at", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-cap-"));
  try {
    const asked: Asked[] = [];
    const events: Record<string, unknown>[] = [];
    const result = await runExtraction(cappedRunCtx(dir, asked, events));

    // Only the correction. The first render of a page image has no prior about how long its
    // answer should be — the page is what it is asked to discover — and neither does the check
    // over it, so capping either would be guessing with a page as the stake.
    assert.deepEqual(
      asked.map((a) => a.step),
      ["extract", "verify", "correct"],
      JSON.stringify(asked),
    );
    assert.deepEqual(
      asked.filter((a) => a.step !== "correct").map((a) => a.maxTokens),
      [undefined, undefined],
    );

    const failed = events.filter((e) => e.type === "page_correction_failed");
    assert.equal(failed.length, 1);
    const cap = asked.find((a) => a.step === "correct")!.maxTokens;
    // The seam this exists for: the ceiling the CALL got is the ceiling for the page the LOG
    // reports. `chars_kept` is where the number came from and `output_cap` is what it came to, so
    // a reader can check the arithmetic on a real failure instead of trusting a comment — and the
    // pair is what would say the multiple is too small, if it is.
    assert.equal(failed[0].output_cap, cap);
    assert.equal(cap, correctionOutputCeiling(Number(failed[0].chars_kept)));
    // Derived from the page and not the floor, on a page this size.
    assert.ok(Number(failed[0].chars_kept) > 10_000, `page was ${failed[0].chars_kept} chars`);
    assert.ok(Number(cap) > CORRECTION_OUTPUT_FLOOR, `cap ${cap} is the floor, not the page`);
    // Far below what this call used to be allowed to spend, which is the whole saving.
    assert.ok(Number(cap) < 32_000);

    // And the page still ships. The cap changes what a runaway costs, not what happens after one:
    // the page keeps the version that passed everything but its fidelity check (#171), and the
    // truncation is still recorded as a truncation.
    assert.equal(result.failedPages.length, 0);
    assert.equal(failed[0].truncated, true);
    assert.equal(events.filter((e) => e.type === "page_extraction_failed").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
