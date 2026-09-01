// Issue #285: a correction pass that ran to the deployment's 32,000-token output ceiling, was
// discarded for being truncated, and left an error telling an operator to RAISE that ceiling.
//
// The page it was correcting had cost 6,233 output tokens to render. So the run paid $0.48 of
// output — 5.13x the first pass — for text nothing ever read, and the only advice on record would
// have bought a larger discarded reply. A correction is the one page call whose size is known
// before it is made: it is handed a page and asked to return that page with named problems fixed.
//
// What is pinned here:
//   1. The cap's shape and its two floors (`correctionCeiling`), against the numbers it was
//      measured on — 111 correction attempts over two model arms in the bench's
//      `runs-extract100-1`. A cap that cuts a successful correction is not a saving, so the
//      cases below are the successes closest to being cut.
//   2. That the pipeline asks for it on the correction and NOT on the first pass, that the number
//      it asks for is the number the failure line reports, and that a provider reporting no usage
//      leaves the call uncapped rather than guessing.
//   3. That both adapters honour it, can never be raised BY it, and — the half of the issue that
//      is about the error message — say the cap was the caller's when a capped call truncates.
//      Getting that wrong is the same defect the issue was filed about, one layer along.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  correctionCeiling,
  CORRECTION_CEILING_FLOOR,
  CORRECTION_CEILING_MULTIPLE,
  runExtraction,
} from "../src/pipeline/extraction.ts";
import { BedrockProvider } from "../src/providers/bedrock.ts";
import { OpenRouterProvider } from "../src/providers/openrouter.ts";
import { ProviderRouter } from "../src/providers/index.ts";
import type { IrisConfig } from "../src/config.ts";
import { TruncatedResponseError } from "../src/providers/types.ts";
import type { ProviderNote } from "../src/providers/types.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// --- the cap itself, against the corpus it was measured on -------------------------------

test("the cap is twice what the first pass spent", () => {
  // The ratio of a correction's output to its first pass's, over 110 successful corrections:
  // median 1.01x, p90 1.33x, max 5.01x. Two is the multiple, and the page from the issue is the
  // case it was chosen for — 6,233 tokens rendered, 32,000 spent correcting.
  assert.equal(correctionCeiling(6233, 14_287), 12_466);
  // Which is a bound on the loss, not a fix: 12,466 tokens of output instead of 32,000 is
  // $0.187 instead of $0.480 at sonnet-4-6's rate, for the identical outcome.
  assert.ok(12_466 < 32_000);
});

test("the floor is what keeps a small page's correction from being cut", () => {
  // `acir-p001` on the luna arm: a 365-character page rendered in 314 output tokens, then
  // corrected in 1,573 — 5.01x, and the reason a bare multiple is the wrong rule. Every success
  // above 3x had a first pass under 1,000 output tokens; at 1,000 or more the worst was 1.65x.
  assert.equal(correctionCeiling(314, 365), CORRECTION_CEILING_FLOOR);
  assert.ok(CORRECTION_CEILING_FLOOR > 1573 * 1.2, "the floor has to clear the tail with room");
  // 2 x 314 would have cut it, which is what the issue's own proposal was.
  assert.ok(CORRECTION_CEILING_MULTIPLE * 314 < 1573);
});

test("the tightest success in the corpus still fits under its cap", () => {
  // `acir-p075`: 3,929 output tokens emitted against a cap of 5,094. Nothing in the 110
  // successes came closer, and this is the number that would move first if the multiple were
  // lowered — 1.5x puts it at 1.02x of the cap, which is not a margin.
  const cap = correctionCeiling(2547, 6000);
  assert.equal(cap, 5094);
  assert.ok(cap > 3929, "0 of 110 successful corrections exceed their cap");
});

test("a document much larger than the reply that made it sets its own floor", () => {
  // The case the corpus cannot speak to: a specialist merge can leave `previous` far larger than
  // the render whose tokens are being doubled, and a correction has to be able to re-emit what it
  // was handed. `/ 4` under-estimates HTML's tokens deliberately, so this binds only when the
  // document is many times the first reply. No attempt in the corpus reached it.
  assert.equal(correctionCeiling(500, 120_000), 30_000);
  // And it is a floor, not a formula: where the doubled first pass is larger, that wins.
  assert.equal(correctionCeiling(9000, 12_000), 18_000);
});

test("no usage from the provider means no cap, not a guessed one", () => {
  // A ceiling derived from the character count alone would be a guess about a tokenizer standing
  // in for a measurement, on the path where getting it wrong throws away a correction that was
  // about to work. Undefined is "whatever the deployment allows", which is what ran before #285.
  assert.equal(correctionCeiling(undefined, 20_000), undefined);
  assert.equal(correctionCeiling(0, 20_000), undefined);
});

// --- the pipeline: which call is capped, and what the log says about it ------------------

interface Asked {
  step: string;
  maxOutputTokens?: number;
}

// A router that records what each call site asked for and reports `outputTokens` for the first
// pass, so the correction has something to be twice of. `usage` on the RESULT rather than through
// `onUsage`, because that is where `renderPage` reads it.
function ctxWith(
  dir: string,
  asked: Asked[],
  events: { type: string; fields: Record<string, unknown> }[],
  opts: { outputTokens?: number; correctionThrows?: () => unknown },
): PipelineContext {
  const agentsDir = join(dir, "agents");
  const inputDir = join(dir, "input");
  const fragDir = join(dir, "fragments");
  for (const d of [agentsDir, inputDir, fragDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
  writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\nvision\n");
  writeFileSync(join(inputDir, "page-001.png"), "not-a-real-png");
  const page = `<h2>Findings</h2><table><tr><td>A</td></tr></table>`;
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
        o: { step: string; maxOutputTokens?: number },
      ) => {
        asked.push({ step: o.step, maxOutputTokens: o.maxOutputTokens });
        const user = messages.find((m) => m.role === "user")?.content ?? "";
        if (user.includes("TASK: verify")) {
          const first = asked.filter((a) => a.step === "verify").length === 1;
          return {
            text: JSON.stringify({
              faithful: !first,
              accessible: true,
              problems: first ? [{ kind: "structure_wrong", problem: "the table has no header row" }] : [],
            }),
          };
        }
        if (user.includes("had fidelity/accessibility problems")) {
          if (opts.correctionThrows) throw opts.correctionThrows();
          return { text: JSON.stringify({ html: `<h2>Findings</h2><table><tr><th>A</th></tr></table>` }) };
        }
        return {
          text: JSON.stringify({ html: page, log: "" }),
          ...(opts.outputTokens === undefined ? {} : { usage: { output_tokens: opts.outputTokens } }),
        };
      },
    },
    log: {
      event: (type: string, fields: Record<string, unknown> = {}) => events.push({ type, fields }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iris-ceiling-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the correction call carries a ceiling and the first pass does not", async () => {
  await withTemp(async (dir) => {
    const asked: Asked[] = [];
    const events: { type: string; fields: Record<string, unknown> }[] = [];
    await runExtraction(ctxWith(dir, asked, events, { outputTokens: 6233 }));
    // Only the correction. The first pass has nothing to estimate from — it is the estimate —
    // and the fidelity check's own reply is short by construction, so capping either would be
    // bounding a call this issue measured nothing about.
    assert.deepEqual(
      asked.map((a) => [a.step, a.maxOutputTokens]),
      [
        ["extract", undefined],
        ["verify", undefined],
        ["correct", 12_466],
        ["recheck_sampled", undefined],
      ],
      JSON.stringify(asked),
    );
  });
});

test("a correction that truncates at its own cap says so on the log line", async () => {
  await withTemp(async (dir) => {
    const asked: Asked[] = [];
    const events: { type: string; fields: Record<string, unknown> }[] = [];
    const result = await runExtraction(
      ctxWith(dir, asked, events, {
        outputTokens: 6233,
        correctionThrows: () => new TruncatedResponseError("bedrock", "some-model", 12_466, "<p>cut"),
      }),
    );
    // The page is still delivered — a correction that fails costs the correction (#171).
    assert.equal(result.failedPages.length, 0);
    const failed = events.filter((e) => e.type === "page_correction_failed");
    assert.equal(failed.length, 1);
    // `truncated: true` beside a 32,000-token config used to be enough to name the number that
    // was hit. With a per-call cap it is not, and the two have opposite remedies, so the ceiling
    // that was actually asked for is on the line — and it is the same number the call sent.
    assert.equal(failed[0].fields.truncated, true);
    assert.equal(failed[0].fields.ceiling, 12_466);
    assert.equal(failed[0].fields.ceiling, asked.find((a) => a.step === "correct")?.maxOutputTokens);
  });
});

test("a provider that reports no usage leaves the correction uncapped", async () => {
  await withTemp(async (dir) => {
    const asked: Asked[] = [];
    await runExtraction(ctxWith(dir, asked, [], { outputTokens: undefined }));
    assert.deepEqual(asked.map((a) => a.maxOutputTokens), [undefined, undefined, undefined, undefined]);
    assert.deepEqual(asked.map((a) => a.step), ["extract", "verify", "correct", "recheck_sampled"]);
  });
  // And the field stays off the failure line rather than appearing as a null: absent means the
  // call ran at the deployment's ceiling, which is a different fact from a cap of nothing. A
  // second directory and a second recorder, because the fake verifier decides "first check" by
  // counting the calls it has been given.
  await withTemp(async (dir) => {
    const events: { type: string; fields: Record<string, unknown> }[] = [];
    await runExtraction(
      ctxWith(dir, [], events, { correctionThrows: () => new Error("ThrottlingException") }),
    );
    const failed = events.filter((e) => e.type === "page_correction_failed");
    assert.equal(failed.length, 1);
    assert.equal("ceiling" in failed[0].fields, false);
  });
});

// --- the adapters: honoured, never raising, and honest about whose ceiling it was --------

const MODEL = "us.anthropic.claude-sonnet-4-6";
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

// One scripted Converse reply per attempt, capturing what each request asked for.
function stubBedrock(bedrock: BedrockProvider, replies: Reply[]): Record<string, any>[] {
  const inputs: Record<string, any>[] = [];
  (bedrock as unknown as { client: unknown }).client = {
    send: async (cmd: any) => {
      const reply = replies[inputs.length] ?? { throws: new Error(`unscripted attempt ${inputs.length + 1}`) };
      inputs.push(cmd.input);
      if ("throws" in reply) throw reply.throws;
      return { stream: (async function* () { for (const e of reply.events) yield e; })() };
    },
  };
  return inputs;
}

const done = (text: string): unknown[] => [
  { contentBlockDelta: { delta: { text }, contentBlockIndex: 0 } },
  { messageStop: { stopReason: "end_turn" } },
];
const cutOff = (text: string): unknown[] => [
  { contentBlockDelta: { delta: { text }, contentBlockIndex: 0 } },
  { messageStop: { stopReason: "max_tokens" } },
];

const bedrockReq = (model: string, maxOutputTokens?: number) => ({
  capability: "vision" as const,
  model,
  messages: [{ role: "user" as const, content: "correct this page" }],
  maxOutputTokens,
});

test("bedrock asks for the caller's ceiling, and cannot be talked into a higher one", async () => {
  const bedrock = new BedrockProvider({ default_model: MODEL, api: "converse" } as never);
  const inputs = stubBedrock(bedrock, [{ events: done("<p>page</p>") }, { events: done("<p>page</p>") }]);
  await bedrock.complete(bedrockReq(MODEL, 12_466));
  // A cap above the deployment's ceiling is not a request for more output. It only ever lowers.
  await bedrock.complete(bedrockReq(MODEL, 99_000));
  assert.deepEqual(inputs.map((i) => i.inferenceConfig.maxTokens), [12_466, 32_000]);
});

test("a capped call is not reported as a deployment running under a ceiling it did not choose", async () => {
  // `output_ceiling_clamped` exists so an aggregate can count deployments whose `max_tokens` a
  // model refuses (#254). A capped correction on every page is working as intended, and counting
  // it there would drown the signal in calls nobody needs to act on.
  const bedrock = new BedrockProvider({ default_model: MODEL, api: "converse" } as never);
  stubBedrock(bedrock, [{ events: done("<p>page</p>") }]);
  const notes: ProviderNote[] = [];
  await bedrock.complete({ ...bedrockReq(MODEL, 4000), onNote: (n: ProviderNote) => notes.push(n) });
  assert.deepEqual(notes, []);
});

test("a truncation at the caller's cap does not send an operator to the deployment's config", async () => {
  const bedrock = new BedrockProvider({ default_model: MODEL, api: "converse" } as never);
  stubBedrock(bedrock, [{ events: cutOff("<p>cut mid-") }]);
  await assert.rejects(() => bedrock.complete(bedrockReq(MODEL, 12_466)), (e: Error) => {
    assert.ok(e instanceof TruncatedResponseError);
    assert.equal(e.maxTokens, 12_466);
    assert.match(e.message, /12466-token output ceiling/);
    assert.match(e.message, /That ceiling is this call's own/);
    assert.match(e.message, /raising that setting will not move it/);
    // The standing sentence is still there and still says "Raise providers.bedrock.max_tokens",
    // because `isTruncatedResponseError` matches the fixed part of the message and the review loop
    // acts on that (providers/types.ts). So the requirement is ORDER: the advice is taken back
    // after it is given, in the same message, rather than left as the only instruction.
    assert.ok(
      e.message.indexOf("Raise providers.bedrock.max_tokens.") <
        e.message.indexOf("That ceiling is this call's own"),
      e.message,
    );
    // And it is not confused with the other case that cannot be raised: a model whose OWN ceiling
    // is below the deployment's needs a different model, not a different caller.
    assert.doesNotMatch(e.message, new RegExp(`That ceiling is ${MODEL}'s own`));
    return true;
  });
});

test("an uncapped call's truncation message is exactly what it always was", async () => {
  // The regression this whole change most has to avoid: docs/API.md quotes this sentence, and a
  // deployment that never caps anything must not see a word of the new machinery.
  const bedrock = new BedrockProvider({ default_model: MODEL, api: "converse" } as never);
  stubBedrock(bedrock, [{ events: cutOff("<p>cut mid-") }]);
  await assert.rejects(() => bedrock.complete(bedrockReq(MODEL)), (e: Error) => {
    assert.equal(
      e.message,
      "bedrock: response hit the 32000-token output ceiling and was truncated " +
        "(11 chars returned). Raise providers.bedrock.max_tokens.",
    );
    return true;
  });
});

test("a caller's cap and a model's own ceiling coexist, and the binding one is the one named", async () => {
  // Both mechanisms lower the same number, so the message has to say which one did it. A model
  // that refuses the deployment's ceiling is still reported as one (`output_ceiling_clamped` on
  // every later call), and a cap below what it granted is still the caller's problem.
  const bedrock = new BedrockProvider({ default_model: NOVA, api: "converse" } as never);
  const inputs = stubBedrock(bedrock, [
    { throws: validationException(NOVA_REFUSAL) },
    { events: done("<p>page</p>") },
    { events: cutOff("<p>cut") },
    { events: cutOff("<p>cut") },
  ]);
  const warn = console.warn;
  console.warn = () => {};
  try {
    // Call one teaches the adapter that this model grants 10,000.
    await bedrock.complete(bedrockReq(NOVA));
    // Call two is capped below that: it asks for the cap, and the config is still reported as
    // wrong, because it still is.
    const notes: ProviderNote[] = [];
    await assert.rejects(
      () => bedrock.complete({ ...bedrockReq(NOVA, 4000), onNote: (n: ProviderNote) => notes.push(n) }),
      (e: Error) => {
        assert.match(e.message, /4000-token output ceiling/);
        assert.match(e.message, /That ceiling is this call's own/);
        return true;
      },
    );
    assert.deepEqual(notes, [
      { kind: "output_ceiling_clamped", model: NOVA, asked: 32_000, stated: 10_000, refused: false },
    ]);
    // Call three caps at exactly what the model grants. The model's ceiling wins the tie: raising
    // the caller's cap would move nothing, so naming it would send someone to the wrong knob.
    await assert.rejects(() => bedrock.complete(bedrockReq(NOVA, 10_000)), (e: Error) => {
      assert.match(e.message, new RegExp(`That ceiling is ${NOVA}'s own`));
      return true;
    });
    assert.deepEqual(inputs.map((i) => i.inferenceConfig.maxTokens), [32_000, 10_000, 4000, 10_000]);
  } finally {
    console.warn = warn;
  }
});

// The same on the other adapter, because a cap must not be a thing that quietly stops applying
// when a deployment changes provider.
async function withFetch<T>(
  lines: string[],
  fn: (bodies: Record<string, unknown>[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
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

const openrouter = (): OpenRouterProvider =>
  new OpenRouterProvider({
    api_key: "test-key",
    base_url: "http://localhost:1/v1",
    default_model: "m",
    max_tokens: 32_000,
  } as never);

const orReq = (maxOutputTokens?: number) => ({
  capability: "vision" as const,
  model: "m",
  messages: [{ role: "user" as const, content: "correct this page" }],
  maxOutputTokens,
});

test("openrouter sends the caller's ceiling and cannot be raised by it", async () => {
  const stop = [`data: ${JSON.stringify({ choices: [{ delta: { content: "<p>x</p>" } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`, "data: [DONE]"];
  await withFetch(stop, async (bodies) => {
    await openrouter().complete(orReq(12_466));
    await openrouter().complete(orReq(99_000));
    await openrouter().complete(orReq());
    assert.deepEqual(bodies.map((b) => b.max_tokens), [12_466, 32_000, 32_000]);
  });
});

test("the router forwards the cap to the adapter and puts it on the log line", async () => {
  // The seam neither test above reaches: the pipeline tests stop at a fake router, and the
  // adapter tests start at `provider.complete`. A router that accepted `maxOutputTokens` in its
  // opts and forgot to forward it would leave both of them green and cap nothing (#267's lesson —
  // assert on the call site, not on the file).
  const cfg = {
    providers: {
      default: "openrouter",
      openrouter: { api_key: "k", base_url: "http://localhost:1/v1", default_model: "m", max_tokens: 32_000 },
    },
  } as unknown as IrisConfig;
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const router = new ProviderRouter(cfg, (type, data) => events.push({ type, data }));
  const stop = [`data: ${JSON.stringify({ choices: [{ delta: { content: "<p>x</p>" } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`, "data: [DONE]"];
  await withFetch(stop, async (bodies) => {
    await router.complete("page", "vision", [{ role: "user", content: "correct this" }], {
      step: "correct",
      maxOutputTokens: 12_466,
    });
    await router.complete("page", "vision", [{ role: "user", content: "read this" }], { step: "extract" });
    assert.deepEqual(bodies.map((b) => b.max_tokens), [12_466, 32_000]);
  });
  // On the start line as well as the end one, and absent on the uncapped call rather than null:
  // a truncation is a `model_call` with `ok: false`, and that is the line that has to say which
  // ceiling was hit.
  assert.deepEqual(
    events.map((e) => [e.type, e.data.step, e.data.max_output_tokens]),
    [
      ["model_call_start", "correct", 12_466],
      ["model_call", "correct", 12_466],
      ["model_call_start", "extract", undefined],
      ["model_call", "extract", undefined],
    ],
    JSON.stringify(events),
  );
  assert.equal("max_output_tokens" in events[3].data, false);
});

test("openrouter's truncation at a caller's cap names the caller, not the config", async () => {
  const cut = [`data: ${JSON.stringify({ choices: [{ delta: { content: "<p>cut" } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}`, "data: [DONE]"];
  await withFetch(cut, async () => {
    await assert.rejects(() => openrouter().complete(orReq(12_466)), (e: Error) => {
      assert.ok(e instanceof TruncatedResponseError);
      assert.equal(e.maxTokens, 12_466);
      assert.match(e.message, /12466-token output ceiling/);
      assert.match(e.message, /That ceiling is this call's own/);
      return true;
    });
  });
  await withFetch(cut, async () => {
    // And the uncapped message is untouched here too.
    await assert.rejects(() => openrouter().complete(orReq()), (e: Error) => {
      assert.equal(
        e.message,
        "openrouter: response hit the 32000-token output ceiling and was truncated " +
          "(6 chars returned). Raise providers.openrouter.max_tokens.",
      );
      return true;
    });
  });
});
