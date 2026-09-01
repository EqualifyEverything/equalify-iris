// Issue #285: a correction pass that ran to the deployment's 32,000-token output ceiling, was
// discarded for being truncated, and left an error telling an operator to RAISE that ceiling.
//
// The page it was correcting had cost 6,233 output tokens to render. So the run paid $0.48 of
// output — 5.13x the first pass — for text nothing ever read, and the only advice on record would
// have bought a larger discarded reply. A correction is the one page call whose size is known
// before it is made: it is handed a page and asked to return that page with named problems fixed.
//
// What is pinned here:
//   1. The cap's shape — a multiple, a floor, and a scaling for a document a specialist grew
//      (`correctionCeiling`) — against the numbers it was measured on: 111 correction attempts over
//      two model arms in the bench's `runs-extract100-1`, plus `runs-extract-1` for the lengths. A
//      cap that cuts a successful correction is not a saving, so the cases below are the successes
//      closest to being cut. There is deliberately no term in CHARACTERS: HTML ran at a median of
//      2.31 characters per output token and as few as 1.09 on a long page, so any fixed divisor is
//      a guess about a tokenizer, and one that binds only when it is the largest term is a guess
//      that decides the cap exactly where it is wrong.
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
  // case it was chosen for — 6,233 tokens rendered, 32,000 spent correcting. No specialist ran on
  // that page, so what it was handed is what it rendered and `growth` is 1.
  assert.equal(correctionCeiling({ outputTokens: 6233, chars: 14_287 }, 14_287), 12_466);
  // Which is a bound on the loss, not a fix: 12,466 tokens of output instead of 32,000 is
  // $0.187 instead of $0.480 at sonnet-4-6's rate, for the identical outcome.
  assert.ok(12_466 < 32_000);
});

test("the floor is what keeps a small page's correction from being cut", () => {
  // `acir-p001` on the luna arm: a 365-character page rendered in 314 output tokens, then
  // corrected in 1,573 — 5.01x, and the reason a bare multiple is the wrong rule. Every success
  // above 3x had a first pass under 1,000 output tokens; at 1,000 or more the worst was 1.65x.
  assert.equal(correctionCeiling({ outputTokens: 314, chars: 365 }, 365), CORRECTION_CEILING_FLOOR);
  assert.ok(CORRECTION_CEILING_FLOOR > 1573 * 1.2, "the floor has to clear the tail with room");
  // 2 x 314 would have cut it, which is what the issue's own proposal was.
  assert.ok(CORRECTION_CEILING_MULTIPLE * 314 < 1573);
});

test("the tightest success in the corpus still fits under its cap", () => {
  // `acir-p075`: 3,929 output tokens emitted against a cap of 5,094. Nothing in the 110
  // successes came closer, and this is the number that would move first if the multiple were
  // lowered — 1.5x puts it at 1.02x of the cap, which is not a margin.
  const cap = correctionCeiling({ outputTokens: 2547, chars: 6000 }, 6000);
  assert.equal(cap, 5094);
  assert.ok(cap > 3929, "0 of 110 successful corrections exceed their cap");
});

test("a longer document than the first pass produced raises the cap in proportion", () => {
  // The case the corpus cannot speak to: `dispatchSpecialist` can merge into the render, so the
  // correction is handed a document larger than the one whose tokens are being doubled, and it has
  // to be able to re-emit what it was given. A document k times longer needs about k times the
  // tokens — the conversion comes from THIS page's own first pass, not from a constant.
  //
  // `acir-p030` on the sonnet arm is the only attempt in either run set where a merge grew the
  // page: 8,287 characters rendered in 4,461 output tokens, 8,960 handed back.
  assert.equal(correctionCeiling({ outputTokens: 4461, chars: 8287 }, 8960), 9647);
  // Which is above what the unscaled multiple would have allowed, and that is the whole point.
  assert.ok(9647 > CORRECTION_CEILING_MULTIPLE * 4461);
  // A merge that doubles the document doubles the cap: 2 x 2 x 3,000.
  assert.equal(correctionCeiling({ outputTokens: 3000, chars: 5000 }, 10_000), 12_000);
});

test("a cap never shrinks because the fragment handed back is smaller than the render", () => {
  // The ORDINARY case, and the one a ratio gets wrong in the expensive direction: `innerHtml` is
  // the render unwrapped and trimmed, so it is normally a little shorter. 146 of the 147 comparable
  // attempts in the two run sets are here. Reading that as "this page needs fewer tokens than it
  // took" would tighten every cap the multiple was measured against — including the corpus's
  // tightest success, which has a 1.30x margin and no room to give any of it up.
  assert.equal(correctionCeiling({ outputTokens: 6233, chars: 14_287 }, 14_200), 12_466);
  assert.equal(correctionCeiling({ outputTokens: 6233, chars: 14_287 }, 1), 12_466);
  // A first pass whose length is unknown is the same case: scale by 1 rather than by a division
  // that has no denominator.
  assert.equal(correctionCeiling({ outputTokens: 6233, chars: 0 }, 99_999), 12_466);
});

test("the cap is never expressed in characters, at any size", () => {
  // What this replaced was `handedBackChars / 4` as a third floor, and it could not work: over the
  // 390 page replies in the two run sets whose HTML and token count can both be recovered, HTML ran
  // at a median of 2.31 characters per output token and as few as 1.09 on the long pages where such
  // a term would bind. `/ 4` therefore provides a quarter to a half of the tokens the same HTML
  // costs, and it binds only when it is the largest term — so it decided the cap exactly where it
  // was too low. A 120,000-character page rendered in 500 tokens is not a 30,000-token correction.
  const cap = correctionCeiling({ outputTokens: 500, chars: 120_000 }, 120_000);
  assert.equal(cap, CORRECTION_CEILING_FLOOR);
  assert.notEqual(cap, 30_000, "no character-count term survives here");
});

test("no usage from the provider means no cap, not a guessed one", () => {
  // A ceiling derived from the character count alone would be a guess about a tokenizer standing
  // in for a measurement, on the path where getting it wrong throws away a correction that was
  // about to work. Undefined is "whatever the deployment allows", which is what ran before #285.
  assert.equal(correctionCeiling({ outputTokens: undefined, chars: 20_000 }, 20_000), undefined);
  assert.equal(correctionCeiling({ outputTokens: 0, chars: 20_000 }, 20_000), undefined);
});

// --- the pipeline: which call is capped, and what the log says about it ------------------

interface Asked {
  step: string;
  maxOutputTokens?: number;
}

// The first pass's own HTML, so a test can compute what `growth` should be from the two lengths
// the pipeline works with. Returned verbatim by the fake router below.
const PAGE_HTML = `<h2>Findings</h2><table><tr><td>A</td></tr></table>`;

// A router that records what each call site asked for and reports `outputTokens` for the first
// pass, so the correction has something to be twice of. `usage` on the RESULT rather than through
// `onUsage`, because that is where `renderPage` reads it.
function ctxWith(
  dir: string,
  asked: Asked[],
  events: { type: string; fields: Record<string, unknown> }[],
  opts: { outputTokens?: number; correctionThrows?: () => unknown; mergeTo?: string },
): PipelineContext {
  const agentsDir = join(dir, "agents");
  const inputDir = join(dir, "input");
  const fragDir = join(dir, "fragments");
  for (const d of [agentsDir, inputDir, fragDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
  writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\nvision\n");
  // Only for the merge case: a non-standard specialist, so `dispatchSpecialist` runs rather than
  // declining the suggestion the way it declines `table`.
  writeFileSync(join(agentsDir, "chartDataAgent.md"), "# Chart Agent\n\n## Required capability\nvision\n");
  writeFileSync(join(inputDir, "page-001.png"), "not-a-real-png");
  const page = PAGE_HTML;
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
        // The two calls a specialist dispatch adds, in the order `extractPage` makes them: the
        // specialist's own fragment, then the page agent merging it in. The merge is what makes the
        // document handed to the correction longer than the render whose tokens are being doubled.
        if (user.includes("Extract ONLY the content your contract covers")) {
          return { text: JSON.stringify({ no_content: false, html: `<table><tr><th>A</th></tr></table>` }) };
        }
        const sys = messages.find((m) => m.role === "system")?.content ?? "";
        if (sys.includes("You merge a higher-fidelity HTML fragment")) {
          return { text: JSON.stringify({ html: opts.mergeTo }) };
        }
        return {
          text: JSON.stringify({
            html: page,
            log: "",
            ...(opts.mergeTo === undefined ? {} : { suggested_agent: { name: "chartDataAgent", reason: "test" } }),
          }),
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

test("a specialist that grows the page grows the cap, through the pipeline", async () => {
  // The call site has two lengths available and they are easy to confuse: what the render produced
  // (`html`, which is what `outputTokens` bought) and what the correction is handed (`innerHtml`,
  // which a merge may have made longer). Passing the same one twice makes `growth` 1 by definition
  // and deletes the term silently — nothing type-checks it and no unit test of the helper can see
  // it — so this drives a real dispatch through `runExtraction` and reads the number off the call.
  const merged = PAGE_HTML.repeat(3);
  await withTemp(async (dir) => {
    const asked: Asked[] = [];
    const events: { type: string; fields: Record<string, unknown> }[] = [];
    await runExtraction(ctxWith(dir, asked, events, { outputTokens: 6233, mergeTo: merged }));
    const cap = asked.find((a) => a.step === "correct")?.maxOutputTokens;
    // The merge is what the correction has to be able to re-emit, so the cap is scaled by how much
    // longer it is: three times the page here.
    assert.equal(cap, Math.ceil(2 * 6233 * (merged.length / PAGE_HTML.length)));
    assert.equal(cap, 37_398);
    // And the un-scaled cap is what a call site reading `innerHtml` for both lengths would produce.
    assert.notEqual(cap, 12_466);
    // The dispatch really did happen — otherwise this test would be asserting about a merge that
    // never ran and a cap that was never scaled.
    assert.equal(events.filter((e) => e.type === "specialist_dispatched").length, 1);
    assert.equal(events.find((e) => e.type === "page_corrected")?.fields.chars_before, merged.length);
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

test("a refused capped call still files the DEPLOYMENT's ceiling as what was asked", async () => {
  // The #254 aggregate reads `output_ceiling_asked` as "what `providers.bedrock.max_tokens` says"
  // (docs/API.md) and pairs it with `output_ceiling_stated` as the remedy. A capped call that gets
  // refused must not file its own cap there: a row reading 12466 against a config reading 32000
  // sends whoever aggregates it to edit a number that is already what the row claims it should be.
  const bedrock = new BedrockProvider({ default_model: NOVA, api: "converse" } as never);
  const inputs = stubBedrock(bedrock, [
    { throws: validationException(NOVA_REFUSAL) },
    { events: done("<p>page</p>") },
  ]);
  const warn = console.warn;
  const said: string[] = [];
  console.warn = (m: string) => said.push(m);
  try {
    const notes: ProviderNote[] = [];
    // 20,000 is a cap, and it is still above this model's 10,000 — so the cap is what gets refused.
    await bedrock.complete({ ...bedrockReq(NOVA, 20_000), onNote: (n: ProviderNote) => notes.push(n) });
    assert.deepEqual(inputs.map((i) => i.inferenceConfig.maxTokens), [20_000, 10_000]);
    assert.deepEqual(notes, [
      { kind: "output_ceiling_clamped", model: NOVA, asked: 32_000, stated: 10_000, refused: true },
    ]);
    // The stderr paragraph is about the config, so it keeps the number that was actually refused
    // and says whose it was — rounding it up to 32,000 would report a request nobody made.
    assert.match(said[0], /refused 20000 output tokens \(this call's own cap, not the configured ceiling\)/);
    assert.match(said[0], /providers\.bedrock\.max_tokens is 32000/);
  } finally {
    console.warn = warn;
  }
});

test("a refusal the adapter cannot answer blames the caller only when the caller set the number", async () => {
  // Two refusals with the same shape and opposite remedies, which is why the provenance is carried
  // rather than re-derived from `asked < max_tokens` — both of these are below 32,000.
  const warn = console.warn;
  console.warn = () => {};
  try {
    // (a) The cap itself is refused, and the model states a ceiling that is not below it, so there
    // is nothing to retry at. Lowering `max_tokens` would change nothing: the request was already
    // under it.
    const capped = new BedrockProvider({ default_model: NOVA, api: "converse" } as never);
    stubBedrock(capped, [{ throws: validationException(NOVA_REFUSAL) }]);
    await assert.rejects(() => capped.complete(bedrockReq(NOVA, 4000)), (e: Error) => {
      assert.equal(e.name, "OutputCeilingRefusedError");
      assert.match(e.message, /That 4000 is this call's own cap, below the 32000/);
      assert.match(e.message, /lowering that setting will not move it/);
      assert.doesNotMatch(e.message, /providers\.bedrock\.max_tokens is the setting at fault/);
      return true;
    });
    // (b) The SECOND refusal, on a call that also carried a cap: the number refused there is the
    // one the MODEL named, not the cap, and it is below 32,000 as well. Blaming the caller for it
    // would be this issue's own defect one layer along.
    const twice = new BedrockProvider({ default_model: NOVA, api: "converse" } as never);
    stubBedrock(twice, [
      { throws: validationException(NOVA_REFUSAL) },
      { throws: validationException("The maximum tokens you requested exceeds the model limit of 8000") },
    ]);
    await assert.rejects(() => twice.complete(bedrockReq(NOVA, 20_000)), (e: Error) => {
      assert.equal(e.name, "OutputCeilingRefusedError");
      assert.match(e.message, /refused a request asking for 10000 output tokens/);
      assert.match(e.message, /providers\.bedrock\.max_tokens is the setting at fault/);
      assert.doesNotMatch(e.message, /this call's own cap/);
      return true;
    });
    // (c) An UNCAPPED call, refused at a ceiling this process already learned from an earlier
    // refusal. `asked` is 10,000 here and the config says 32,000, so a message chosen by comparing
    // the two would call the model's own remembered ceiling a caller's cap — which is why the
    // provenance is carried on the attempt and not recomputed at the throw. This is the case that
    // separates the two rules, and nothing else in the suite reaches it.
    const learned = new BedrockProvider({ default_model: NOVA, api: "converse" } as never);
    stubBedrock(learned, [
      { throws: validationException(NOVA_REFUSAL) },
      { events: done("<p>page</p>") },
      { throws: validationException(NOVA_REFUSAL) },
    ]);
    await learned.complete(bedrockReq(NOVA));
    await assert.rejects(() => learned.complete(bedrockReq(NOVA)), (e: Error) => {
      assert.equal(e.name, "OutputCeilingRefusedError");
      assert.match(e.message, /refused a request asking for 10000 output tokens/);
      assert.match(e.message, /providers\.bedrock\.max_tokens is the setting at fault/);
      assert.doesNotMatch(e.message, /this call's own cap/);
      return true;
    });
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
