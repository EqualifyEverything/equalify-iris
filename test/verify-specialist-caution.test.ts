import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExtraction } from "../src/pipeline/extraction.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// The page agent can ask for a specialist it does not get, and that request is the agent saying it
// could not do this content reliably. `dispatchSpecialist` has always logged the outcome; nothing
// used it. In one 100-page bench round every one of the 7 requests asked for a map specialist, on
// the 5 pages whose verdicts turned on reading ink, and on one of them the verify step — never told
// — asserted a state into a category the page does not put it in, which the correction then wrote
// into the delivered document (#353).
//
// So the request is carried to the verifier. These tests are about the CARRYING, driven through
// `runExtraction` rather than by calling `verifyAgentOutput` directly: the caution has to survive
// the producer that computes it, and the branch that decides whether there is one is in
// `extractPage`, not in the verifier.
//
// The three things that can go wrong here are all silent. A caution that never reaches the prompt
// leaves the prompt clause in `agents/feedback.md` addressing a message it never sees. A caution on
// a page that DID get its specialist tells the verifier to distrust a fragment a specialist wrote.
// And a caution inside the cached prefix costs every other page in the document its cache read —
// nothing fails, the bill just goes up, which is the failure this file can catch and a bench round
// cannot attribute.

const CAUTION_HEADING = "## What the agent said about its own output";

interface Recorded {
  // `content` is every message joined, which is what a "is this in the prompt at all" assertion
  // wants; `user` is the one message the cached prefix belongs to, kept apart because a prefix check
  // against the joined text compares against the system prompt sitting in front of it and fails for
  // a reason that has nothing to do with caching.
  calls: { agent: string; step: string | undefined; content: string; user: string; cachedPrefix: string }[];
}

// One page and one library specialist, plus a feedback.md so the fidelity check actually runs —
// without it `verifyAgentOutput` short-circuits to unjudged and there is no prompt to inspect. The
// verifier passes the page, so nothing here reaches a correction: this is about the first verify
// call's message.
function makeCtx(dir: string, suggestedName: string | null): { ctx: PipelineContext; rec: Recorded } {
  const agentsDir = join(dir, "agents");
  const fragDir = join(dir, "fragments");
  const inputDir = join(dir, "input");
  for (const d of [agentsDir, fragDir, inputDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
  writeFileSync(join(agentsDir, "chartDataAgent.md"), "# Chart Agent\n\n## Required capability\nvision\n");
  writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\nvision\n");
  writeFileSync(join(inputDir, "page-001.png"), "not-a-real-png");

  const rec: Recorded = { calls: [] };
  const ctx = {
    sessionId: "ses_test",
    images: [{ name: "page-001.png", order: 1, path: join(inputDir, "page-001.png") }],
    extractionConcurrency: 1,
    recheckSampleSize: 1,
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
        opts?: { step?: string },
      ) => {
        const sys = messages.find((m) => m.role === "system")?.content ?? "";
        const user = messages.find((m) => m.role === "user");
        rec.calls.push({
          agent,
          step: opts?.step,
          content: messages.map((m) => m.content).join("\n"),
          user: user?.content ?? "",
          cachedPrefix: user?.cachedPrefix ?? "",
        });
        if (agent === "feedback") {
          return { text: JSON.stringify({ faithful: true, accessible: true, problems: [] }) };
        }
        if (messages.map((m) => m.content).join("\n").includes("Extract ONLY the content your contract covers")) {
          return { text: JSON.stringify({ no_content: false, html: "<p>specialist</p>" }) };
        }
        if (sys.includes("You merge a higher-fidelity HTML fragment")) {
          return { text: JSON.stringify({ html: "<p>page</p><p>specialist</p>" }) };
        }
        return {
          text: JSON.stringify({
            html: "<p>page</p>",
            log: "",
            ...(suggestedName === null
              ? {}
              : { suggested_agent: { name: suggestedName, reason: "the map's per-state classification" } }),
          }),
        };
      },
    },
    log: { event: () => {}, agentCall: () => {} },
  } as unknown as PipelineContext;
  return { ctx, rec };
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iris-caution-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The verify call, found by the step it was filed under rather than by position: the page pass, the
// specialist and the merge are all calls on the same router, and asserting on "the second call"
// would pass for the wrong one as soon as a step is added anywhere upstream.
const verifyCall = (rec: Recorded) => rec.calls.find((c) => c.agent === "feedback" && c.step === "verify");

test("a specialist the page asked for and did not get is carried into the verify prompt", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = makeCtx(dir, "choroplethMapAgent");
    await runExtraction(ctx);
    const verify = verifyCall(rec);
    assert.ok(verify, "no verify call was made, so there is no prompt to check");

    assert.ok(verify.content.includes(CAUTION_HEADING), "the caution section is missing from the verify prompt");
    // The NAME, because six spellings of one concept turned up in a single round and a maintainer
    // reading a rejected page needs the one the model actually wrote.
    assert.ok(verify.content.includes('"choroplethMapAgent"'), "the requested name is not in the prompt");
    // And the REASON, which is the half that says WHICH content the agent was unsure of. Without it
    // the caution says "some part of this page is weak" and licenses distrusting all of it.
    assert.ok(
      verify.content.includes("the map's per-state classification"),
      "the agent's stated reason is not in the prompt",
    );
    // What the caution must NOT do is read as a problem to fix. It says what the agent said, and the
    // narrowing it implies lives in agents/feedback.md where the verifier's own instructions are.
    assert.ok(
      verify.content.indexOf(CAUTION_HEADING) > verify.content.indexOf("```html"),
      "the caution precedes the output it is about",
    );
  });
});

test("the caution stays out of the verify prompt's cached prefix", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = makeCtx(dir, "choroplethMapAgent");
    await runExtraction(ctx);
    const verify = verifyCall(rec);
    assert.ok(verify, "no verify call was made");

    // The prefix is the invariant head every page of a document re-sends and reads back from cache
    // (providers/promptCache.ts). A per-page string in it changes the head on the page that has one,
    // so that page pays a write and no other page can read what it wrote.
    assert.ok(verify.cachedPrefix.length > 0, "the verify call sent no cached prefix at all");
    assert.ok(
      !verify.cachedPrefix.includes(CAUTION_HEADING),
      "the caution is inside the cached prefix, which costs the document its cache reads",
    );
    assert.ok(
      !verify.cachedPrefix.includes("choroplethMapAgent"),
      "the requested name is inside the cached prefix",
    );
    assert.ok(verify.user.startsWith(verify.cachedPrefix), "the prefix is no longer a prefix of its own message");
  });
});

test("a page that suggested nothing carries no caution", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = makeCtx(dir, null);
    await runExtraction(ctx);
    const verify = verifyCall(rec);
    assert.ok(verify, "no verify call was made");
    // Byte-for-byte what it always sent: a section that appears on every page says nothing about
    // any page, and it would be paid for on all of them.
    assert.ok(!verify.content.includes(CAUTION_HEADING), "a page with no request still sent a caution section");
  });
});

test("a specialist that ran leaves no caution behind it", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = makeCtx(dir, "chartDataAgent");
    await runExtraction(ctx);
    const verify = verifyCall(rec);
    assert.ok(verify, "no verify call was made");
    // `chartDataAgent.md` is in this library, so the request was MET. Telling the verifier the agent
    // was unsure would invite it to distrust the fragment the specialist wrote, which is the
    // higher-fidelity half of the page.
    assert.ok(
      verify.content.includes("specialist"),
      "the specialist never ran, so this test is not making the distinction it claims",
    );
    assert.ok(!verify.content.includes(CAUTION_HEADING), "a dispatched specialist still produced a caution");
  });
});
