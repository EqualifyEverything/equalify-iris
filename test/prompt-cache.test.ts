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
  claudeFamily,
  promptCacheEnabled,
} from "../src/providers/promptCache.ts";
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
  // ids put the version in the middle. All three name a model whose minimum is 1024.
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
      complete: async (agent: string, _cap: string, messages: { role: string; content: string }[]) => {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        const user = messages.find((m) => m.role === "user")?.content ?? "";
        calls.push({ agent, system, user });
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
