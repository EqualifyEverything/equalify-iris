import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExtraction, reExtractPages } from "../src/pipeline/extraction.ts";
import { assembleBody } from "../src/pipeline/assembly.ts";
import { summarizeRun } from "../src/diagnostics.ts";
import { TruncatedResponseError } from "../src/providers/types.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Fragment } from "../src/pipeline/fragment.ts";
import type { Paths } from "../src/store/paths.ts";

// One page's model call throwing used to end the whole run: mapWithConcurrency
// rejects with the first error any item throws, so page 26 of 50 discarded 25 pages
// that had already been rendered, verified and corrected, and delivered nothing
// (issue #135).
//
// What these pin down is that the containment is not a silent one. A missing page
// that nobody recorded is worse than a failed run, because the document still looks
// finished — so the page carries a marker, the run log carries the page number, and
// diagnostics reports the set.

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iris-pagefail-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Recorded {
  events: { type: string; data: Record<string, unknown> }[];
  calls: string[];
}

// A document of `pageCount` pages where the page agent throws `error` for the pages
// named in `failing`, and returns ordinary HTML for the rest.
//
// No feedback.md, so verifyAgentOutput short-circuits to ok and these tests stay about
// the failure path rather than about self-correction. Concurrency is 2 so the failing
// page really is running alongside others, which is the shape the bug needed.
function makeCtx(
  dir: string,
  pageCount: number,
  failing: number[],
  error: () => Error,
): { ctx: PipelineContext; rec: Recorded } {
  const agentsDir = join(dir, "agents");
  const fragDir = join(dir, "fragments");
  const inputDir = join(dir, "input");
  for (const d of [agentsDir, fragDir, inputDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");

  const images = [];
  for (let order = 1; order <= pageCount; order++) {
    const name = `page-00${order}.png`;
    writeFileSync(join(inputDir, name), "not-a-real-png");
    images.push({ name, order, path: join(inputDir, name) });
  }
  const failingNames = new Set(failing.map((p) => `page-00${p}.png`));

  const rec: Recorded = { events: [], calls: [] };
  const ctx = {
    sessionId: "ses_test",
    images,
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
        const prompt = messages.map((m) => m.content).join("\n");
        rec.calls.push(prompt);
        // The prompt names the page it is about (`filename: page-002.png`), which is
        // the only handle a stub has on which concurrent call it is serving.
        for (const name of failingNames) {
          if (prompt.includes(`filename: ${name}`)) throw error();
        }
        return { text: JSON.stringify({ html: `<p>page</p>`, log: "" }) };
      },
    },
    log: {
      event: (type: string, data: Record<string, unknown> = {}) => rec.events.push({ type, data }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
  return { ctx, rec };
}

const truncated = () => new TruncatedResponseError("bedrock", "claude-test", 32000, 87851);
const ev = (rec: Recorded, type: string) => rec.events.filter((e) => e.type === type);

test("one page's failure does not take the document with it", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = makeCtx(dir, 4, [2], truncated);
    const { fragments, failedPages } = await runExtraction(ctx);
    assert.deepEqual(fragments.map((f) => f.order), [1, 2, 3, 4], "every page is still accounted for");
    assert.deepEqual(failedPages, [2]);
    assert.equal(fragments.filter((f) => f.innerHtml === "<p>page</p>").length, 3, "the other 3 pages survived");
    assert.deepEqual(ev(rec, "page_extraction_failed").map((e) => e.data.page), [2]);
    assert.match(String(ev(rec, "page_extraction_failed")[0].data.error), /output ceiling/);
  });
});

test("the failed page is a marker in the document, not an absence", async () => {
  await withTemp(async (dir) => {
    const { ctx } = makeCtx(dir, 3, [2], truncated);
    const { fragments } = await runExtraction(ctx);
    const failed = fragments.find((f) => f.order === 2)!;
    assert.match(failed.innerHtml, /@page-failed 2:/);
    assert.match(failed.log, /extraction failed:/);
    // Assembly filters empty fragments, so an empty one here would leave a document
    // that is missing a page with nothing at all to say so.
    const body = assembleBody(fragments);
    assert.match(body, /@page-failed 2:/, "the marker reached the delivered body");
    assert.equal(body.split("<p>page</p>").length - 1, 2);
  });
});

test("the failure note cannot end the comment it lives in", async () => {
  await withTemp(async (dir) => {
    // A `--` inside an HTML comment closes it early, which would spill the note into
    // the document as visible text — the same reason wrapDocument sanitizes @unresolved.
    const { ctx } = makeCtx(dir, 1, [1], () => new Error("bad -- input --> here"));
    const { fragments } = await runExtraction(ctx);
    const inner = fragments[0].innerHtml;
    assert.match(inner, /^<!-- @page-failed 1: /);
    assert.equal(inner.indexOf("-->"), inner.length - 3, "the only comment terminator is the last one");
  });
});

test("every page failing is still a document, not a thrown run", async () => {
  await withTemp(async (dir) => {
    // The degenerate end of containment. It delivers nothing usable — but it delivers
    // it with all three pages named, where the old behavior surfaced one error and left
    // the other two pages' fate unrecorded.
    const { ctx, rec } = makeCtx(dir, 3, [1, 2, 3], truncated);
    const { fragments, failedPages } = await runExtraction(ctx);
    assert.deepEqual(failedPages, [1, 2, 3]);
    assert.equal(fragments.length, 3);
    assert.deepEqual(ev(rec, "extraction_complete")[0].data, { pages: 3, failed: [1, 2, 3] });
  });
});

test("a whole run logs an empty failed list rather than no list", async () => {
  await withTemp(async (dir) => {
    // "No page failed" and "this run predates per-page containment" must not be the
    // same observation in a log.
    const { ctx, rec } = makeCtx(dir, 2, [], truncated);
    const { failedPages } = await runExtraction(ctx);
    assert.deepEqual(failedPages, []);
    assert.deepEqual(ev(rec, "extraction_complete")[0].data, { pages: 2, failed: [] });
  });
});

// --- re-extraction: failing must not be destructive --------------------------

const prior = (order: number): Fragment => ({
  image: `page-00${order}.png`,
  order,
  agent: "page.md",
  region: "page",
  innerHtml: `<p>prior ${order}</p>`,
  edges: [],
  log: "",
});

test("a failed re-extraction keeps the page it could not improve", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = makeCtx(dir, 3, [2], truncated);
    const { fragments, failedPages } = await reExtractPages(ctx, [prior(1), prior(2), prior(3)], [2, 3]);
    assert.deepEqual(failedPages, [2]);
    assert.equal(
      fragments.find((f) => f.order === 2)!.innerHtml,
      "<p>prior 2</p>",
      "replacing good prior content with a failure marker would make feedback destructive",
    );
    assert.equal(fragments.find((f) => f.order === 3)!.innerHtml, "<p>page</p>", "page 3 was re-extracted");
    assert.equal(fragments.find((f) => f.order === 1)!.innerHtml, "<p>prior 1</p>", "untargeted page untouched");
    assert.equal(ev(rec, "page_extraction_failed")[0].data.kept, "prior");
  });
});

test("a page that threw is not counted among the pages re-extracted", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = makeCtx(dir, 3, [2], truncated);
    await reExtractPages(ctx, [prior(1), prior(2), prior(3)], [2, 3]);
    assert.deepEqual(ev(rec, "reextract_complete")[0].data, { pages: [3], failed: [2] });
  });
});

// --- diagnostics -------------------------------------------------------------

test("diagnostics reports which pages are missing from the document", async () => {
  // A run that ends `ready_for_review` with a page missing is otherwise
  // indistinguishable here from one that delivered the whole document: the failed
  // model call underneath appears in `errors` exactly as a retried-and-recovered one
  // does, and `status` says the run succeeded — which it did, on 2 of 3 pages.
  const log = [
    { ts: "2026-08-24T00:00:00.000Z", type: "run_start", images: 3 },
    { ts: "2026-08-24T00:00:10.000Z", type: "page_extraction_failed", image: "page-003.png", page: 3, error: "x" },
    { ts: "2026-08-24T00:00:11.000Z", type: "page_extraction_failed", image: "page-002.png", page: 2, error: "x" },
    // A feedback re-run logs the same page again over the life of one session's log;
    // the field answers "which pages are not in the document", which is a set.
    { ts: "2026-08-24T00:00:12.000Z", type: "page_extraction_failed", image: "page-003.png", page: 3, error: "x" },
    { ts: "2026-08-24T00:00:20.000Z", type: "run_complete", failed_pages: [2, 3] },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
  const d = summarizeRun(log, {
    sessionId: "ses_test",
    status: "ready_for_review",
    phase: "done",
    now: Date.parse("2026-08-24T00:00:30.000Z"),
  });
  assert.deepEqual(d.pages_failed, [2, 3], "sorted and deduped");
});

test("a whole run reports no failed pages", () => {
  const log = JSON.stringify({ ts: "2026-08-24T00:00:00.000Z", type: "run_complete" });
  const d = summarizeRun(log, {
    sessionId: "ses_test",
    status: "ready_for_review",
    phase: "done",
    now: Date.parse("2026-08-24T00:00:30.000Z"),
  });
  assert.deepEqual(d.pages_failed, []);
});
