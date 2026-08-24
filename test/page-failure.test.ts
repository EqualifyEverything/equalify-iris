import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExtraction, reExtractPages } from "../src/pipeline/extraction.ts";
import { assembleBody, wrapDocument } from "../src/pipeline/assembly.ts";
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
    // Two pages, one failing: a document where every page fails is a failed run, so a
    // surviving page is what keeps the marker reachable at all.
    const { ctx } = makeCtx(dir, 2, [1], () => new Error("bad -- input --> here"));
    const { fragments } = await runExtraction(ctx);
    const inner = fragments[0].innerHtml;
    assert.match(inner, /^<!-- @page-failed 1: /);
    assert.equal(inner.indexOf("-->"), inner.length - 3, "the only comment terminator is the last one");
  });
});

test("every page failing is a failed run, not an empty document", async () => {
  await withTemp(async (dir) => {
    // Containment trades a thrown run for the pages that DID work. With none of them
    // there is nothing to trade: assembly and review would run happily on a body of
    // failure markers and the session would end `ready_for_review`, serving a document
    // containing none of the source's words — worse than the failure it replaced, which
    // named the ceiling and the knob to raise (test/e2e.sh §9d).
    const { ctx, rec } = makeCtx(dir, 3, [1, 2, 3], truncated);
    await assert.rejects(runExtraction(ctx), (e: Error) => {
      // The page's own error, unwrapped: it is the diagnosis, and a message written at
      // the document level would drop the provider's account of why.
      assert.match(e.message, /output ceiling/);
      assert.match(e.message, /max_tokens/);
      return true;
    });
    assert.deepEqual(ev(rec, "extraction_complete")[0].data, { pages: 3, failed: [1, 2, 3] });
    assert.equal(ev(rec, "extraction_failed").length, 1, "the log says why the run ended, not just that a page did");
  });
});

test("a single-page document that fails fails the run", async () => {
  await withTemp(async (dir) => {
    // The one-page case is the same rule, and the one that matters most: "1 of 1 failed"
    // is 100% of the document, so there is no partial success to deliver.
    const { ctx } = makeCtx(dir, 1, [1], truncated);
    await assert.rejects(runExtraction(ctx), /output ceiling/);
  });
});

test("the document itself admits the hole, out of the editor's reach", async () => {
  await withTemp(async (dir) => {
    // The in-fragment marker is part of the body handed to the Copy Editor with "return
    // the complete corrected body", so a round that rewrites the document may drop it.
    // wrapDocument re-states it after the loop, where no editor round can reach it —
    // the same guarantee @unresolved already had.
    const { ctx } = makeCtx(dir, 3, [2], truncated);
    const { fragments, failedPages } = await runExtraction(ctx);
    // The editor deleted the marker, which it is free to do.
    const rewritten = assembleBody(fragments).replace(/<!-- @page-failed[\s\S]*?-->/g, "");
    assert.doesNotMatch(rewritten, /@page-failed/, "the body no longer says anything about page 2");
    const html = wrapDocument(rewritten, { failedPages });
    assert.match(html, /@page-failed 2/);
    assert.match(html, /This document is incomplete/);
  });
});

test("a whole document says nothing about failed pages", () => {
  // No empty marker on an ordinary document: a comment about failure in a document with
  // none reads as a defect to whoever finds it.
  assert.doesNotMatch(wrapDocument("<p>fine</p>", { failedPages: [] }), /@page-failed/);
  assert.doesNotMatch(wrapDocument("<p>fine</p>"), /@page-failed/);
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
    // NOT reported as a failed page: that means the document has no content for it, and
    // this document has page 2's prior content. It is whole, just not improved.
    assert.deepEqual(failedPages, []);
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

test("re-extracting a page that was missing fills the hole", async () => {
  await withTemp(async (dir) => {
    // The set is a property of the DOCUMENT, not of the run that lost the page, and this
    // is the only thing that shrinks it: a failed page's fragment is a marker, but it IS
    // a fragment, so the page is re-extractable and a clean round fills it in.
    const { ctx, rec } = makeCtx(dir, 3, [], truncated);
    const { fragments, failedPages } = await reExtractPages(ctx, [prior(1), prior(2), prior(3)], [2], [2]);
    assert.deepEqual(failedPages, [], "page 2 has content now");
    assert.equal(fragments.find((f) => f.order === 2)!.innerHtml, "<p>page</p>");
    assert.deepEqual(ev(rec, "page_recovered")[0].data, { pages: [2] });
  });
});

test("a page that was missing and failed again is still missing", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = makeCtx(dir, 3, [2], truncated);
    const { failedPages } = await reExtractPages(ctx, [prior(1), prior(2), prior(3)], [2], [2]);
    assert.deepEqual(failedPages, [2], "it kept its marker, so the document still has no page 2");
    assert.equal(ev(rec, "page_recovered").length, 0);
  });
});

test("a page nobody re-extracted stays in the set", async () => {
  await withTemp(async (dir) => {
    // Feedback about page 3 does not fix the hole on page 7, and a document that stops
    // admitting the hole because a later round did not touch it is the failure the
    // durable marker exists to prevent.
    const { ctx } = makeCtx(dir, 3, [], truncated);
    const { failedPages } = await reExtractPages(ctx, [prior(1), prior(2), prior(3)], [3], [2]);
    assert.deepEqual(failedPages, [2]);
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

test("a page that kept its prior content is not reported as missing", () => {
  // The feedback path logs the same event with `kept: "prior"`, and it means the
  // opposite: the re-extraction threw, so the page kept the content it already had and
  // the document is whole. Naming it here sends a client looking for a hole that is not
  // there — docs/API.md §7c tells it to check this field for exactly that.
  const log = [
    { ts: "2026-08-24T00:00:00.000Z", type: "run_start", images: 3 },
    { ts: "2026-08-24T00:00:10.000Z", type: "page_extraction_failed", image: "page-002.png", page: 2, error: "x", kept: "prior" },
    { ts: "2026-08-24T00:00:20.000Z", type: "run_complete" },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
  const d = summarizeRun(log, {
    sessionId: "ses_test",
    status: "ready_for_review",
    phase: "done",
    now: Date.parse("2026-08-24T00:00:30.000Z"),
  });
  assert.deepEqual(d.pages_failed, []);
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
