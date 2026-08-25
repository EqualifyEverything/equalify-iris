// Prompt caching: does Iris actually ASK for it, and does it keep sending a prefix
// worth caching?
//
// Three real runs measured 1,478,688 input tokens with `cache_read_input_tokens` zero
// on every single call (issue #136). Nothing was broken — the adapters simply never
// sent a breakpoint, and the accounting that would have shown the saving was already in
// place, reporting a true zero. So these tests are about the request, which is the only
// place the intent is visible: no fixture can prove a cache HIT, because whether one
// happens is the model's answer and not ours.
//
// The second half is the part that rots. A cache breakpoint on the system prompt is
// worth exactly as much as that prompt is repeated byte for byte, so a later edit that
// moves one page-specific word into it — a filename, a page number — silently turns 24
// cache reads back into 24 full-price prefixes with nothing failing. The pipeline tests
// at the bottom pin the split.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cacheableSystemPrompt,
  cachedTextBlock,
  promptCacheTtl,
  claudeFamily,
  promptCacheEnabled,
} from "../src/providers/promptCache.ts";
import { promptCacheTtlWarning } from "../src/config.ts";
import { BedrockProvider } from "../src/providers/bedrock.ts";
import { OpenRouterProvider } from "../src/providers/openrouter.ts";
import { runExtraction } from "../src/pipeline/extraction.ts";
import { recordExample } from "../src/pipeline/memory.ts";
import { ACCESSIBILITY_REQUIREMENTS } from "../src/pipeline/accessibility.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// Long enough to clear the 1024-token minimum at the module's 2-chars-per-token floor,
// and to clear Haiku's 2048 where a test needs to sit between the two.
const LONG = "x".repeat(4200);
const MID = "x".repeat(2100);
const SHORT = "x".repeat(400);

// --- what the model will cache ----------------------------------------------

test("both providers' spellings of a model name resolve to the same family", () => {
  // Bedrock hyphenates and puts the version last; OpenRouter uses dots; older Bedrock
  // ids put the version in the middle. All three name a model whose minimum is 1024 —
  // which is a separate question from whether that model can cache at all (below).
  assert.equal(claudeFamily("us.anthropic.claude-sonnet-4-6"), "sonnet");
  assert.equal(claudeFamily("anthropic/claude-opus-4.7"), "opus");
  assert.equal(claudeFamily("anthropic.claude-3-5-sonnet-20240620-v1:0"), "sonnet");
  assert.equal(claudeFamily("us.anthropic.claude-haiku-4-5"), "haiku");
});

test("a model this cannot read gets no breakpoint at all", () => {
  // The safe direction, and the reason it is a null rather than a guessed minimum: an
  // id we do not recognize may not be a Claude model. `cache_control` is Anthropic's
  // field, and OpenRouter is a broker — an OpenAI model reached through it caches by
  // itself and takes no such field, so sending one is a request it could refuse.
  assert.equal(claudeFamily("mock-model"), null);
  assert.equal(claudeFamily("openai/gpt-5"), null);
  assert.equal(cacheableSystemPrompt("mock-model", LONG), false);
  assert.equal(cacheableSystemPrompt("openai/gpt-5", LONG), false);
});

test("a generation too old to cache is declined, family or no family", () => {
  // Recognizing the family is not the same as knowing the model can do this. Bedrock's
  // caching support starts at 3.7, and an upstream that has never heard of
  // `cache_control` rejects the whole request — so an id whose family reads fine but
  // whose generation predates caching has to get the same answer as an unreadable one.
  assert.equal(claudeFamily("anthropic.claude-3-5-sonnet-20240620-v1:0"), "sonnet");
  assert.equal(cacheableSystemPrompt("anthropic.claude-3-5-sonnet-20240620-v1:0", LONG), false);
  assert.equal(cacheableSystemPrompt("anthropic.claude-3-sonnet-20240229-v1:0", LONG), false);
  // And the first generation that can: both id spellings of it.
  assert.equal(cacheableSystemPrompt("anthropic.claude-3-7-sonnet-20250219-v1:0", LONG), true);
  assert.equal(cacheableSystemPrompt("anthropic/claude-3.7-sonnet", LONG), true);
});

test("a prompt too short to be cacheable is not asked about", () => {
  // Below the minimum the breakpoint is ignored rather than refused, so this threshold
  // exists to avoid asking for nothing — not to prevent an error.
  assert.equal(cacheableSystemPrompt("us.anthropic.claude-sonnet-4-6", SHORT), false);
  assert.equal(cacheableSystemPrompt("us.anthropic.claude-sonnet-4-6", LONG), true);
});

test("Haiku's higher minimum is respected, not averaged with the others", () => {
  // A prompt between the two minimums: cacheable on Sonnet, not on Haiku. Getting this
  // wrong is invisible — the Haiku request would simply carry a field that does nothing.
  assert.equal(cacheableSystemPrompt("us.anthropic.claude-sonnet-4-6", MID), true);
  assert.equal(cacheableSystemPrompt("us.anthropic.claude-haiku-4-5", MID), false);
  assert.equal(cacheableSystemPrompt("us.anthropic.claude-haiku-4-5", LONG), true);
});

test("the real agent prompts clear the bar on the model this repo runs", () => {
  // The whole point of the change: `agents/page.md` and `agents/feedback.md` are the two
  // prompts re-sent once per page. If a rewrite ever shrinks one below the minimum, the
  // saving quietly disappears, and this says so.
  const model = "us.anthropic.claude-sonnet-4-6";
  for (const file of ["page.md", "feedback.md"]) {
    const content = readAgent(file);
    assert.equal(
      cacheableSystemPrompt(model, content),
      true,
      `agents/${file} is ${content.length} chars — too short to cache on ${model}`,
    );
  }
});

test("an operator can turn caching off, and only an explicit off counts", () => {
  assert.equal(promptCacheEnabled({}), true);
  assert.equal(promptCacheEnabled({ prompt_cache: true }), true);
  assert.equal(promptCacheEnabled({ prompt_cache: false }), false);
  // YAML traps: a valueless `prompt_cache:` parses as null, which is an operator who
  // set nothing rather than one who said no; a quoted "false" is a truthy string that
  // plainly means no.
  assert.equal(promptCacheEnabled({ prompt_cache: null as unknown as boolean }), true);
  assert.equal(promptCacheEnabled({ prompt_cache: "" as unknown as boolean }), true);
  assert.equal(promptCacheEnabled({ prompt_cache: "false" as unknown as boolean }), false);
  assert.equal(promptCacheEnabled({ prompt_cache: "FALSE" as unknown as boolean }), false);
});

// --- Bedrock: the native Anthropic payload ----------------------------------

const encode = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

// Replace the adapter's SDK client with one that records the request body and answers
// with the shortest valid stream. Unlike providers.test.ts's `stubStream`, what is
// being asserted here is the REQUEST, so the command is what gets kept.
function captureBedrock(bedrock: BedrockProvider): Record<string, unknown>[] {
  const sent: Record<string, unknown>[] = [];
  (bedrock as unknown as { client: unknown }).client = {
    send: async (cmd: { input: { body: string } }) => {
      sent.push(JSON.parse(cmd.input.body) as Record<string, unknown>);
      return {
        body: (async function* () {
          yield { chunk: { bytes: encode({ type: "content_block_delta", delta: { type: "text_delta", text: "ok" } }) } };
          yield { chunk: { bytes: encode({ type: "message_delta", delta: { stop_reason: "end_turn" } }) } };
        })(),
      };
    },
  };
  return sent;
}

const bedrockReq = (system: string) => ({
  capability: "vision" as const,
  model: "us.anthropic.claude-sonnet-4-6",
  messages: [
    { role: "system" as const, content: system },
    { role: "user" as const, content: "page 1 of 25" },
  ],
});

test("Bedrock sends the system prompt as a cached block", async () => {
  const bedrock = new BedrockProvider({ default_model: "m" });
  const sent = captureBedrock(bedrock);
  await bedrock.complete(bedrockReq(LONG));
  assert.deepEqual(sent[0].system, [{ type: "text", text: LONG, cache_control: { type: "ephemeral" } }]);
  // The breakpoint marks the end of the prefix, so everything after it — the page's own
  // text, and the image — must stay where it was.
  assert.deepEqual(sent[0].messages, [{ role: "user", content: "page 1 of 25" }]);
});

test("Bedrock leaves a short system prompt a plain string", async () => {
  // Not merely an optimization: the block form exists to carry the breakpoint, and a
  // request that cannot benefit from one should be the request it always was.
  const bedrock = new BedrockProvider({ default_model: "m" });
  const sent = captureBedrock(bedrock);
  await bedrock.complete(bedrockReq(SHORT));
  assert.equal(sent[0].system, SHORT);
});

test("Bedrock asks for nothing when the deployment turned caching off", async () => {
  const bedrock = new BedrockProvider({ default_model: "m", prompt_cache: false });
  const sent = captureBedrock(bedrock);
  await bedrock.complete(bedrockReq(LONG));
  assert.equal(sent[0].system, LONG);
});

test("a request with no system prompt still sends no system field", async () => {
  const bedrock = new BedrockProvider({ default_model: "m" });
  const sent = captureBedrock(bedrock);
  await bedrock.complete({
    capability: "text" as const,
    model: "us.anthropic.claude-sonnet-4-6",
    messages: [{ role: "user" as const, content: "hi" }],
  });
  assert.equal("system" in sent[0], false);
});

// --- OpenRouter: OpenAI-style content parts ---------------------------------

// One canned SSE response, capturing the request bodies. Same seam as
// providers.test.ts uses; kept local because this file needs only the happy path.
async function withStream<T>(fn: (calls: Record<string, unknown>[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const calls: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    calls.push(JSON.parse(init.body) as Record<string, unknown>);
    return {
      ok: true,
      status: 200,
      text: async () => "",
      body: (async function* () {
        yield new TextEncoder().encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n` +
            `data: [DONE]\n\n`,
        );
      })(),
    };
  }) as unknown as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const openrouter = (prompt_cache?: boolean) =>
  new OpenRouterProvider({
    api_key: "test-key",
    base_url: "http://localhost:1/v1",
    default_model: "m",
    prompt_cache,
  });

const orReq = (system: string) => ({
  capability: "vision" as const,
  model: "anthropic/claude-sonnet-4.6",
  messages: [
    { role: "system" as const, content: system },
    { role: "user" as const, content: "page 1 of 25" },
  ],
  images: [{ media_type: "image/png", data: Buffer.from("png") }],
});

test("OpenRouter carries the breakpoint on a system content part", async () => {
  await withStream(async (calls) => {
    await openrouter().complete(orReq(LONG));
    const messages = calls[0].messages as { role: string; content: unknown }[];
    assert.deepEqual(messages[0], {
      role: "system",
      content: [{ type: "text", text: LONG, cache_control: { type: "ephemeral" } }],
    });
    // The image is still attached to the user message, after the breakpoint.
    const parts = messages[1].content as { type: string }[];
    assert.deepEqual(parts.map((p) => p.type), ["text", "image_url"]);
  });
});

test("OpenRouter leaves a short system prompt, or a disabled one, alone", async () => {
  await withStream(async (calls) => {
    await openrouter().complete(orReq(SHORT));
    await openrouter(false).complete(orReq(LONG));
    const first = calls[0].messages as { content: unknown }[];
    const second = calls[1].messages as { content: unknown }[];
    assert.equal(first[0].content, SHORT);
    assert.equal(second[0].content, LONG);
  });
});

// --- the invariant head of a user message ------------------------------------

// A message whose head repeats call to call: the verify task re-states the whole
// contract of the agent it is judging on every page. `content` stays the complete
// message, so the split is invisible to everything except the billing.
const userReq = (content: string, cachedPrefix?: string) => ({
  capability: "vision" as const,
  model: "us.anthropic.claude-sonnet-4-6",
  messages: [
    { role: "system" as const, content: SHORT },
    { role: "user" as const, content, cachedPrefix },
  ],
});

// The text the parts of one message add up to, whatever shape they arrived in.
function userText(message: { content: unknown }): string {
  if (typeof message.content === "string") return message.content;
  return (message.content as { type: string; text?: string }[])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("");
}

test("Bedrock splits a declared prefix into its own cached block", async () => {
  const bedrock = new BedrockProvider({ default_model: "m" });
  const sent = captureBedrock(bedrock);
  await bedrock.complete(userReq(LONG + "page 1 of 25", LONG));
  const messages = sent[0].messages as { role: string; content: unknown }[];
  assert.deepEqual(messages[0].content, [
    { type: "text", text: LONG, cache_control: { type: "ephemeral" } },
    { type: "text", text: "page 1 of 25" },
  ]);
  // The whole point: the model is asked the same question, in the same words.
  assert.equal(userText(messages[0]), LONG + "page 1 of 25");
});

test("Bedrock keeps the message whole when the head cannot carry a breakpoint", async () => {
  // Four ways to decline, all of which must send the request that was sent before this
  // field existed: no prefix declared, a head too short to be worth a breakpoint, a
  // deployment that turned caching off, and — the one that is not about caching — a
  // "prefix" that is not a prefix, which must never be trusted to slice the message.
  for (const [what, provider, req] of [
    ["nothing declared", new BedrockProvider({ default_model: "m" }), userReq(LONG + "tail")],
    ["a short head", new BedrockProvider({ default_model: "m" }), userReq(SHORT + "tail", SHORT)],
    ["caching off", new BedrockProvider({ default_model: "m", prompt_cache: false }), userReq(LONG + "tail", LONG)],
    // Long enough to pass every caching test, so what declines it is the one check that
    // is not about caching: this is not the start of the message. A short non-prefix
    // would be declined for its length and prove nothing.
    ["a head that is not the head", new BedrockProvider({ default_model: "m" }), userReq(LONG + "tail", "z" + LONG)],
  ] as [string, BedrockProvider, ReturnType<typeof userReq>][]) {
    const sent = captureBedrock(provider);
    await provider.complete(req);
    const messages = sent[0].messages as { role: string; content: unknown }[];
    assert.equal(messages[0].content, req.messages[1].content, `${what}: the message should be untouched`);
  }
});

test("a message that is all head sends no empty block after it", async () => {
  // An empty text block is rejected by the API, so a caller whose whole message is
  // invariant — nothing after the head — would have every one of its calls 400 inside
  // the adapter. Nothing does that today; the field accepts it, so it has to hold.
  const bedrock = new BedrockProvider({ default_model: "m" });
  const sentBedrock = captureBedrock(bedrock);
  await bedrock.complete(userReq(LONG, LONG));
  assert.deepEqual((sentBedrock[0].messages as { content: unknown }[])[0].content, [
    { type: "text", text: LONG, cache_control: { type: "ephemeral" } },
  ]);

  await withStream(async (calls) => {
    await openrouter().complete({
      capability: "text" as const,
      model: "anthropic/claude-sonnet-4.6",
      messages: [{ role: "user" as const, content: LONG, cachedPrefix: LONG }],
    });
    const parts = (calls[0].messages as { content: { type: string }[] }[])[0].content;
    assert.deepEqual(parts.map((p) => p.type), ["text"]);
  });
});

test("Bedrock keeps the image after the breakpoint, and the text before it", async () => {
  // A page image is what follows the head on every verify call, and it must stay on the
  // variable side: an image inside the cached prefix would be a different prefix per page.
  const bedrock = new BedrockProvider({ default_model: "m" });
  const sent = captureBedrock(bedrock);
  await bedrock.complete({
    ...userReq(LONG + "page 1 of 25", LONG),
    images: [{ media_type: "image/png", data: Buffer.from("png") }],
  });
  const parts = (sent[0].messages as { content: { type: string }[] }[])[0].content;
  assert.deepEqual(parts.map((p) => p.type), ["text", "text", "image"]);
  assert.equal((parts[0] as { cache_control?: unknown }).cache_control !== undefined, true);
  assert.equal((parts[1] as { cache_control?: unknown }).cache_control, undefined);
});

test("OpenRouter splits a declared prefix the same way", async () => {
  await withStream(async (calls) => {
    await openrouter().complete({
      capability: "vision" as const,
      model: "anthropic/claude-sonnet-4.6",
      messages: [
        { role: "system" as const, content: SHORT },
        { role: "user" as const, content: LONG + "page 1 of 25", cachedPrefix: LONG },
      ],
      images: [{ media_type: "image/png", data: Buffer.from("png") }],
    });
    const messages = calls[0].messages as { role: string; content: unknown }[];
    const parts = messages[1].content as { type: string; text?: string; cache_control?: unknown }[];
    assert.deepEqual(parts.map((p) => p.type), ["text", "text", "image_url"]);
    assert.deepEqual(parts[0].cache_control, { type: "ephemeral" });
    assert.equal(parts[1].cache_control, undefined);
    assert.equal(userText(messages[1]), LONG + "page 1 of 25");
  });
});

test("OpenRouter keeps the message whole when the head cannot carry a breakpoint", async () => {
  await withStream(async (calls) => {
    const req = (content: string, cachedPrefix?: string) => ({
      capability: "text" as const,
      model: "anthropic/claude-sonnet-4.6",
      messages: [{ role: "user" as const, content, cachedPrefix }],
    });
    await openrouter().complete(req(LONG + "tail"));
    await openrouter().complete(req(SHORT + "tail", SHORT));
    await openrouter(false).complete(req(LONG + "tail", LONG));
    // Long enough to pass every caching test, so what declines it is the one check that
    // is not about caching: this is not the start of the message.
    await openrouter().complete(req(LONG + "tail", "z" + LONG));
    for (const call of calls) {
      const messages = call.messages as { content: unknown }[];
      assert.equal(typeof messages[0].content, "string", "an image-less, uncacheable message stays a plain string");
    }
  });
});

// --- through the pipeline: what belongs in the cached prefix -----------------

// The agent prompt as it ships, read from the repo root (this file's parent).
function readAgent(file: string): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "agents", file), "utf8");
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iris-prompt-cache-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Call {
  agent: string;
  system: string;
  user: string;
  // What the call declared as its user message's invariant head, if anything.
  prefix?: string;
}

// Same shape as reextract.test.ts's context: only what extraction touches is real. A
// Feedback Agent IS written, because the fidelity verdict is what triggers the
// self-correction call — the second page-agent call whose prefix has to match the first.
function makeCtx(dir: string, calls: Call[]): PipelineContext {
  const agentsDir = join(dir, "agents");
  const fragDir = join(dir, "fragments");
  const inputDir = join(dir, "input");
  for (const d of [agentsDir, fragDir, inputDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
  writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\nvision\n");
  const names = ["page-001.png", "page-002.png"];
  for (const n of names) writeFileSync(join(inputDir, n), "not-a-real-png");

  return {
    sessionId: "ses_test",
    images: names.map((name, i) => ({ name, order: i + 1, path: join(inputDir, name), links: [] })),
    extractionConcurrency: 2,
    maxReviewIterations: 1,
    paths: {
      agentsDir,
      tmpAgentsDir: () => join(dir, "tmp-agents"),
      agentMemory: (agent: string) => join(dir, `mem-${agent.replace(/\.md$/, "")}.json`),
      sessionFragments: () => fragDir,
    } as unknown as Paths,
    router: {
      complete: async (
        agent: string,
        _cap: string,
        messages: { role: string; content: string; cachedPrefix?: string }[],
      ) => {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        const userMessage = messages.find((m) => m.role === "user");
        const user = userMessage?.content ?? "";
        calls.push({ agent, system, user, prefix: userMessage?.cachedPrefix });
        // Page 1 fails its fidelity check, which is what buys a correction call for it;
        // page 2 passes, so the two pages between them cover both paths.
        if (user.includes("TASK: verify")) {
          const page1 = user.includes("page-001.png");
          return {
            text: JSON.stringify({
              faithful: !page1,
              accessible: true,
              problems: page1 ? ["the second column of the table was dropped"] : [],
            }),
          };
        }
        return { text: JSON.stringify({ html: `<p>page</p>`, log: "" }) };
      },
    },
    log: { event: () => {}, agentCall: () => {} },
  } as unknown as PipelineContext;
}

test("every page-agent call in a run sends one identical prefix", async () => {
  await withTemp(async (dir) => {
    const calls: Call[] = [];
    const ctx = makeCtx(dir, calls);
    // A lesson that WOULD be injected, so the prefix under test is the full one:
    // an a11y-policy lesson is eligible from its first session (memory.ts).
    recordExample(ctx.paths, {
      agent: "page.md",
      kind: "a11y_policy",
      instruction: "Give a heading the level its place in the hierarchy calls for.",
      before: "<h2>Sub</h2>",
      after: "<h3>Sub</h3>",
      feedback: "the subheadings are all h2",
      session: "ses_old",
    });

    await runExtraction(ctx);

    const pageCalls = calls.filter((c) => c.agent === "page");
    // Two pages, plus the correction page 1 earned by failing its check.
    assert.equal(pageCalls.length, 3, pageCalls.map((c) => c.user.slice(0, 60)).join(" | "));
    const prefixes = new Set(pageCalls.map((c) => c.system));
    assert.equal(prefixes.size, 1, `expected one shared prefix, got ${prefixes.size}`);

    // And it is the prefix worth caching: the agent prompt, the accessibility contract
    // and the injected lessons — the three things that do not vary by page.
    const [prefix] = [...prefixes];
    assert.match(prefix, /# Page Agent/);
    assert.ok(prefix.includes(ACCESSIBILITY_REQUIREMENTS), "the requirements are not in the prefix");
    assert.match(prefix, /Lessons from past corrections/);
    assert.match(prefix, /the level its place in the hierarchy calls for/);
  });
});

test("nothing page-specific leaks into the prefix, and nothing invariant is re-sent", async () => {
  await withTemp(async (dir) => {
    const calls: Call[] = [];
    await runExtraction(makeCtx(dir, calls));
    const pageCalls = calls.filter((c) => c.agent === "page");

    for (const c of pageCalls) {
      // The filename and page number are the two things that MUST stay out of the
      // prefix: either one in there gives every page a prefix of its own, and a
      // per-page prefix is a cache write per page instead of one read.
      assert.doesNotMatch(c.system, /page-00[12]\.png/, "an image filename reached the prefix");
      assert.doesNotMatch(c.system, /page \d+ of \d+/, "a page number reached the prefix");
      // The other half of the split: the requirements used to be re-sent inside each
      // page's user message, which is the copy this change removes. Leaving both would
      // pay for them per page anyway, on top of caching them.
      assert.equal(
        c.user.includes(ACCESSIBILITY_REQUIREMENTS),
        false,
        "the requirements are still being re-sent per page",
      );
    }
  });
});

// The verify task's own prefix. The Feedback Agent's prompt is the system message and is
// already cached; what was not was the contract of the agent under test, which the task
// re-states in full on every page — `agents/page.md` is 16 KB of it, so on a 25-page
// document that was 25 full-price copies of the single largest constant Iris sends.
test("every verify call in a run declares one identical invariant head", async () => {
  await withTemp(async (dir) => {
    const calls: Call[] = [];
    await runExtraction(makeCtx(dir, calls));
    const verifies = calls.filter((c) => c.agent === "feedback");
    assert.ok(verifies.length >= 2, `expected a verify per page, got ${verifies.length}`);

    const prefixes = new Set(verifies.map((c) => c.prefix));
    assert.equal(prefixes.size, 1, `expected one shared head, got ${prefixes.size}`);
    const [prefix] = [...prefixes];
    assert.ok(prefix, "the verify call declares no head at all, so nothing is cached");
    // What is in it: the task marker the Feedback Agent switches on, and the whole
    // contract it is judging against.
    assert.match(prefix, /^TASK: verify/);
    assert.match(prefix, /## Agent under test: page\.md/);
    assert.match(prefix, /# Page Agent/);
    // And what must never be: one page-specific word in here gives every page a head of
    // its own, which is a cache write per page instead of one read.
    assert.doesNotMatch(prefix, /page-00[12]\.png/, "an image filename reached the head");
  });
});

test("the head is the head, and the message is still whole", async () => {
  // The adapters slice `content` at this string, so a head that is not actually the
  // start of the message would send a prompt nobody wrote. Both halves are asserted
  // here rather than left to the adapter tests, because this is the caller that has to
  // keep them in step: the message still reads exactly as it did before it was split.
  await withTemp(async (dir) => {
    const calls: Call[] = [];
    await runExtraction(makeCtx(dir, calls));
    for (const c of calls.filter((c) => c.agent === "feedback")) {
      assert.ok(c.user.startsWith(c.prefix!), "the declared head is not the start of the message");
      assert.match(c.user, /## The agent's output for source image "page-00[12]\.png"/);
      assert.match(c.user, /Compare the output against the attached source image\.$/);
    }
  });
});

// --- how long an entry should live -------------------------------------------

// A write costs 1.25x at five minutes and 2x at an hour; a read costs 0.1x either way.
// So five minutes pays for itself on the second use of a prefix and an hour needs a
// third — which makes this a question about a DEPLOYMENT's cadence, not about Iris.
// Within one run it never arises: every page call reads the page agent's prefix and each
// read refreshes the clock. What an hour buys is the gap between runs.
test("the default deployment sends the request it always sent", () => {
  // Byte-identical, not "5m" spelled out: `ttl` is a field an upstream can refuse, and a
  // default nobody chose must not be the request that finds that out.
  assert.deepEqual(cachedTextBlock("x"), { type: "text", text: "x", cache_control: { type: "ephemeral" } });
  assert.deepEqual(cachedTextBlock("x", "5m"), { type: "text", text: "x", cache_control: { type: "ephemeral" } });
  assert.equal("ttl" in cachedTextBlock("x").cache_control, false);
});

test("an hour is asked for explicitly, and only when it is recognized", () => {
  assert.deepEqual(cachedTextBlock("x", "1h"), {
    type: "text",
    text: "x",
    cache_control: { type: "ephemeral", ttl: "1h" },
  });
  assert.equal(promptCacheTtl({ prompt_cache_ttl: "1h" }), "1h");
  assert.equal(promptCacheTtl({ prompt_cache_ttl: " 1H " }), "1h", "spacing and case are an operator's, not a directive");
  // Everything else is the default, because the two ways of being wrong are not equal:
  // falling back costs one prefix's saving per run, while forwarding something
  // unrecognized could take out every call the upstream serves.
  for (const v of [undefined, null, "", "   ", "5m", "1 hour", "60m", "3600", 1, true, {}]) {
    assert.equal(promptCacheTtl({ prompt_cache_ttl: v as unknown as string }), "5m", `${JSON.stringify(v)}`);
  }
});

test("a provider block's choice reaches the wire, on both adapters", async () => {
  const bedrock = new BedrockProvider({ default_model: "m", prompt_cache_ttl: "1h" });
  const sent = captureBedrock(bedrock);
  await bedrock.complete(bedrockReq(LONG));
  assert.deepEqual(sent[0].system, [
    { type: "text", text: LONG, cache_control: { type: "ephemeral", ttl: "1h" } },
  ]);

  await withStream(async (calls) => {
    const or = new OpenRouterProvider({
      api_key: "test-key",
      base_url: "http://localhost:1/v1",
      default_model: "m",
      prompt_cache_ttl: "1h",
    });
    await or.complete(orReq(LONG));
    const messages = calls[0].messages as { content: unknown }[];
    assert.deepEqual(messages[0].content, [
      { type: "text", text: LONG, cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
  });
});

test("an hour on the head of a user message too, since that is where the largest constant is", async () => {
  // agents/page.md re-stated per page is the biggest prefix Iris sends (#152); a
  // deployment that asked for an hour meant it for that one as well.
  const bedrock = new BedrockProvider({ default_model: "m", prompt_cache_ttl: "1h" });
  const sent = captureBedrock(bedrock);
  await bedrock.complete(userReq(LONG + "page 1 of 25", LONG));
  const parts = (sent[0].messages as { content: { cache_control?: unknown }[] }[])[0].content;
  assert.deepEqual(parts[0].cache_control, { type: "ephemeral", ttl: "1h" });
});

test("turning caching off outranks any TTL", () => {
  // The escape hatch is for an upstream that refuses `cache_control` at all, and a TTL
  // is a field ON that object: honouring it here would send the very thing being
  // escaped from.
  const bedrock = new BedrockProvider({ default_model: "m", prompt_cache: false, prompt_cache_ttl: "1h" });
  const sent = captureBedrock(bedrock);
  return bedrock.complete(bedrockReq(LONG)).then(() => {
    assert.equal(sent[0].system, LONG, "a disabled cache sends a plain string, TTL or no TTL");
  });
});

test("a TTL nobody can spell is caught at boot, because nothing else can catch it", () => {
  // The fallback is silent by design — an unrecognized value must not reach an upstream —
  // and it is invisible afterwards: the two TTLs differ in what a write is BILLED at, not
  // in the token counts diagnostics publishes, so `60m` would read exactly like `1h` in
  // every field Iris reports. Boot is the only place an operator finds out.
  const ok = { default: "bedrock", bedrock: { default_model: "m", prompt_cache_ttl: "1h" } };
  assert.equal(promptCacheTtlWarning(ok as never), undefined);
  assert.equal(promptCacheTtlWarning({ default: "b", b: { default_model: "m" } } as never), undefined);
  assert.equal(
    promptCacheTtlWarning({ default: "b", b: { default_model: "m", prompt_cache_ttl: "5M" } } as never),
    undefined,
    "case is an operator's, not a typo",
  );
  // A valueless YAML key is an operator who set nothing, which is what the default is for.
  assert.equal(
    promptCacheTtlWarning({ default: "b", b: { default_model: "m", prompt_cache_ttl: null } } as never),
    undefined,
  );

  const warned = promptCacheTtlWarning({
    default: "bedrock",
    bedrock: { default_model: "m", prompt_cache_ttl: "60m" },
  } as never);
  assert.match(warned ?? "", /providers\.bedrock: "60m"/);
  assert.match(warned ?? "", /is ignored/);
  // And it says why no dashboard will show it, so the operator does not go looking.
  assert.match(warned ?? "", /BILLED/);

  // Every block that has one, not just the first: fixing one and rebooting must not
  // reveal the next as a surprise.
  const both = promptCacheTtlWarning({
    default: "bedrock",
    per_agent: { page: "bedrock" },
    bedrock: { default_model: "m", prompt_cache_ttl: "1 hour" },
    openrouter: { default_model: "m", prompt_cache_ttl: "3600" },
  } as never);
  assert.match(both ?? "", /providers\.bedrock: "1 hour"/);
  assert.match(both ?? "", /providers\.openrouter: "3600"/);

  // `default` is a string and `per_agent` is a map of agent overrides; neither is a
  // provider block, and both are skipped by NAME rather than by shape — `per_agent` is
  // an object, so a shape test would send it to the lookup and search it for a key that
  // belongs to a provider.
  assert.equal(
    promptCacheTtlWarning({
      default: "bedrock",
      per_agent: { prompt_cache_ttl: "60m" },
      bedrock: { default_model: "m" },
    } as never),
    undefined,
    "an agent override is not a provider block, whatever it happens to be named",
  );

  // A block that caches nothing still gets its typo named — the value is unusable either
  // way, and it goes live the day caching is turned back on — so the wording says the
  // value is ignored rather than claiming a TTL that block does not have.
  const off = promptCacheTtlWarning({
    default: "b",
    b: { default_model: "m", prompt_cache: false, prompt_cache_ttl: "60m" },
  } as never);
  assert.match(off ?? "", /providers\.b: "60m"/);
  assert.doesNotMatch(off ?? "", /Using 5m/, "nothing is cached there, so no TTL is in play");
  assert.match(off ?? "", /is ignored/);
});
