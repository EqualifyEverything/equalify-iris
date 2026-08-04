import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExtraction } from "../src/pipeline/extraction.ts";
import { STANDARD } from "../src/pipeline/contribute.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// Specialist dispatch turns a free-text name the MODEL wrote ("chartDataAgent",
// "chart", "table.md ") into a library file to run. Every outcome is a page that
// looks plausible either way, so the log line is the only observable difference
// between "routed", "correctly declined" and "silently missed" — and getting the
// wrong one of those three is the failure mode.
//
// test/e2e.sh covers the two happy directions end to end (a resolvable name and a
// near-miss). These cover the branches a real model reaches through sloppier
// output: a standard type, whitespace around it, and an unusable name.

const SUGGEST_MARK = "suggested-by-test";

interface Recorded {
  events: { type: string; data: Record<string, unknown> }[];
  calls: { agent: string; prompt: string }[];
}

// One page, one library specialist (chartDataAgent.md), plus a `table.md` that the
// real library no longer ships. It is written here on purpose: `table` is a standard
// type, so the decline must hold even when a file of that name IS present and would
// resolve — which is the case a directory-listing-based decline would get wrong.
// No feedback.md, so verifyAgentOutput short-circuits to ok and these tests stay
// about dispatch.
function makeCtx(dir: string, suggestedName: string | null): { ctx: PipelineContext; rec: Recorded } {
  const agentsDir = join(dir, "agents");
  const fragDir = join(dir, "fragments");
  const inputDir = join(dir, "input");
  for (const d of [agentsDir, fragDir, inputDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
  writeFileSync(join(agentsDir, "chartDataAgent.md"), "# Chart Agent\n\n## Required capability\nvision\n");
  writeFileSync(join(agentsDir, "table.md"), "# Table Agent\n\n## Required capability\nvision\n");
  writeFileSync(join(inputDir, "page-001.png"), "not-a-real-png");

  const rec: Recorded = { events: [], calls: [] };
  const ctx = {
    sessionId: "ses_test",
    images: [{ name: "page-001.png", order: 1, path: join(inputDir, "page-001.png") }],
    extractionConcurrency: 1,
    maxReviewIterations: 1,
    paths: {
      agentsDir,
      tmpAgentsDir: () => join(dir, "tmp-agents"),
      agentMemory: (agent: string) => join(dir, `mem-${agent.replace(/\.md$/, "")}.json`),
      sessionFragments: () => fragDir,
    } as unknown as Paths,
    router: {
      complete: async (agent: string, _cap: string, messages: { role: string; content: string }[]) => {
        const sys = messages.find((m) => m.role === "system")?.content ?? "";
        const prompt = messages.map((m) => m.content).join("\n");
        rec.calls.push({ agent, prompt });
        // A specialist asked for just its own content type.
        if (prompt.includes("Extract ONLY the content your contract covers")) {
          return { text: JSON.stringify({ no_content: false, html: `<p>${SUGGEST_MARK} fragment</p>` }) };
        }
        // The page agent, called a second time to splice a fragment in.
        if (sys.includes("You merge a higher-fidelity HTML fragment")) {
          return { text: JSON.stringify({ html: `<p>page</p><p>${SUGGEST_MARK} merged</p>` }) };
        }
        // The general page pass, optionally naming a specialist it wants.
        return {
          text: JSON.stringify({
            html: "<p>page</p>",
            log: "",
            ...(suggestedName === null ? {} : { suggested_agent: { name: suggestedName, reason: "test" } }),
          }),
        };
      },
    },
    log: {
      event: (type: string, data: Record<string, unknown> = {}) => rec.events.push({ type, data }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
  return { ctx, rec };
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iris-dispatch-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ev = (rec: Recorded, type: string) => rec.events.filter((e) => e.type === type);
const ranSpecialist = (rec: Recorded) =>
  rec.calls.some((c) => c.prompt.includes("Extract ONLY the content your contract covers"));

test("a standard content type is declined, not dispatched", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = makeCtx(dir, "table");
    const { fragments, suggestions } = await runExtraction(ctx);
    // `table.md` IS in the library, so this would resolve — the decline is a
    // deliberate policy, not a lookup failure: the general page pass already
    // rendered the table, and splicing a second rendering of it over the first is
    // exactly the duplication the page prompt forbids.
    assert.deepEqual(ev(rec, "specialist_declined").map((e) => e.data.agent), ["table"]);
    assert.equal(ev(rec, "specialist_dispatched").length, 0);
    assert.equal(ranSpecialist(rec), false, "a standard agent was run anyway");
    assert.equal(fragments[0].innerHtml, "<p>page</p>", "the page output was rewritten");
    // A declined suggestion IS still collected (`dispatched` is false), and
    // runContribution's own STANDARD filter is what stops it becoming a new-agent
    // issue. Asserted as-is rather than "corrected" here: extraction reports what
    // the model asked for, one filter owns the standard-type policy, and moving it
    // would put the same decision in two places.
    assert.deepEqual(suggestions, [{ name: "table", reason: "test", image: "page-001.png" }]);
  });
});

test("whitespace and a .md extension around a standard type are still declined", async () => {
  await withTemp(async (dir) => {
    // The regression this pins: normalizing as `.replace(/\.md$/, "").trim()`
    // leaves "table.md " as "table.md", which STANDARD does not contain but
    // loadAgent resolves to agents/table.md — so the decline is skipped and a
    // standard specialist runs and merges. Two extra model calls and a duplicated
    // table, from a trailing space. " table " declines under either order, which is
    // what makes this shape the one worth asserting.
    const { ctx, rec } = makeCtx(dir, " table.md \n");
    const { fragments } = await runExtraction(ctx);
    assert.deepEqual(ev(rec, "specialist_declined").map((e) => e.data.agent), ["table"]);
    assert.equal(ranSpecialist(rec), false, "a padded standard name got past the decline");
    assert.equal(fragments[0].innerHtml, "<p>page</p>");
  });
});

test("an unusable name is logged as unresolved rather than silently dropped", async () => {
  await withTemp(async (dir) => {
    // A model that emits `"name": "  "` (or ".md") has still SUGGESTED something;
    // it just gave nothing to route on. Without this line the page is
    // indistinguishable from one that never suggested anything at all.
    const { ctx, rec } = makeCtx(dir, "  .md  ");
    await runExtraction(ctx);
    const events = ev(rec, "specialist_unresolved");
    assert.equal(events.length, 1);
    assert.equal(events[0].data.reason, "empty name");
    assert.equal(events[0].data.agent, "  .md  ", "the raw string it could not use is reported");
    assert.equal(ranSpecialist(rec), false);
  });
});

test("a resolvable non-standard name dispatches and merges", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = makeCtx(dir, "chartDataAgent");
    const { fragments, suggestions } = await runExtraction(ctx);
    assert.deepEqual(ev(rec, "specialist_dispatched").map((e) => e.data), [
      { agent: "chartDataAgent.md", image: "page-001.png", merged: true },
    ]);
    assert.match(fragments[0].innerHtml, new RegExp(`${SUGGEST_MARK} merged`), "the merge result is not in the page");
    assert.match(fragments[0].log, /merged chartDataAgent/);
    // A dispatched suggestion is already covered by the library, so it must not be
    // re-filed as a new agent to build.
    assert.deepEqual(suggestions, []);
  });
});

test("a miss names the standard agents among the candidates too", async () => {
  await withTemp(async (dir) => {
    // "tables" is the commonest near-miss shape: a plural of a standard type. It is
    // not in STANDARD (so it is never declined) and resolves to no file, so it
    // arrives here — and a candidate list that hid `table` would omit the one name
    // that explains the miss.
    const { ctx, rec } = makeCtx(dir, "tables");
    const { suggestions } = await runExtraction(ctx);
    const miss = ev(rec, "specialist_unresolved")[0];
    assert.equal(miss?.data.agent, "tables");
    assert.deepEqual(miss?.data.candidates, [...STANDARD, "chartDataAgent"].sort());
    assert.equal(ranSpecialist(rec), false);
    // Unresolved IS reported for contribution: this is the path that proposes a new
    // agent for a type the library genuinely lacks.
    assert.deepEqual(suggestions, [{ name: "tables", reason: "test", image: "page-001.png" }]);
  });
});

test("standard types are named as candidates with no agent files on disk", async () => {
  await withTemp(async (dir) => {
    // The real library ships no standard agent files — the nine were deleted as
    // unreachable (§7.4 v1.2). The near-miss explanation above must therefore come
    // from STANDARD, not from a directory listing: with `table.md` absent, a
    // readdir-only candidate list drops `table` and the commonest miss ("tables")
    // becomes unexplainable in exactly the deployment everyone runs.
    //
    // This is the same assertion as above with the file removed, which is the whole
    // point: the other test writes `table.md` to prove the DECLINE is not
    // file-driven, and this one removes it to prove the CANDIDATES are not either.
    const { ctx, rec } = makeCtx(dir, "tables");
    rmSync(join(dir, "agents", "table.md"));
    await runExtraction(ctx);
    const candidates = ev(rec, "specialist_unresolved")[0]?.data.candidates as string[];
    assert.deepEqual(candidates, [...STANDARD, "chartDataAgent"].sort());
    assert.ok(candidates.includes("table"), "the name that explains the miss is absent");
  });
});

test("no suggestion means no dispatch events at all", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = makeCtx(dir, null);
    await runExtraction(ctx);
    for (const type of ["specialist_dispatched", "specialist_declined", "specialist_unresolved"]) {
      assert.deepEqual(ev(rec, type), [], `${type} logged without a suggestion`);
    }
  });
});
