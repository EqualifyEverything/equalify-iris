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
  // The reply for a page that is not in `failing`, when a test needs something other than
  // ordinary HTML — a blank declaration, say. Keyed by page number.
  reply?: (order: number) => string | undefined,
): { ctx: PipelineContext; rec: Recorded } {
  const agentsDir = join(dir, "agents");
  const fragDir = join(dir, "fragments");
  const inputDir = join(dir, "input");
  for (const d of [agentsDir, fragDir, inputDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");

  const images: { name: string; order: number; path: string }[] = [];
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
    recheckSampleSize: 1,
    maxReviewIterations: 1,
    paths: {
      agentsDir,
      tmpAgentsDir: () => join(dir, "tmp-agents"),
      agentMemory: (agent: string) => join(dir, `mem-${agent.replace(/\.md$/, "")}.json`),
      sessionFragments: () => fragDir,
    } as unknown as Paths,
    router: {
      complete: async (_agent: string, _cap: string, messages: { role: string; content: string }[]) => {
        const prompt = messages.map((m) => m.content).join("\n");
        rec.calls.push(prompt);
        // The prompt names the page it is about (`filename: page-002.png`), which is
        // the only handle a stub has on which concurrent call it is serving.
        for (const name of failingNames) {
          if (prompt.includes(`filename: ${name}`)) throw error();
        }
        if (reply) {
          for (const img of images) {
            if (prompt.includes(`filename: ${img.name}`)) {
              const custom = reply(img.order);
              if (custom !== undefined) return { text: custom };
            }
          }
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

// 87,851 characters of a page came back before the ceiling cut it. The fragment rides on the error
// (#277) and since #293 this path quotes both of its ends on the failure line — the page's content
// is gone, so the excerpt is the only record of what the model had written when the ceiling cut it.
const truncated = () => new TruncatedResponseError("bedrock", "claude-test", 32000, "<p>cut".padEnd(87_851, "x"));
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

test("a page lost to the ceiling records what the model had written", async () => {
  await withTemp(async (dir) => {
    // This is the destructive truncation — the page's content is gone and nothing recovers it — so
    // the fields matter more here than on `page_correction_failed`, where the page survives. Same
    // three, so the two lines can be read against each other (#293).
    const { ctx, rec } = makeCtx(dir, 2, [1], truncated);
    await runExtraction(ctx);
    const failed = ev(rec, "page_extraction_failed")[0].data;
    assert.equal(failed.truncated, true);
    assert.equal(failed.reply_chars, 87_851);
    assert.match(String(failed.reply_head), /^<p>cutx+$/);
    assert.equal(String(failed.reply_head).length, 240);
    assert.equal(String(failed.reply_tail).length, 240);
    // No `ceiling` field, and its absence is a fact rather than an omission: a first pass carries no
    // cap of its own, so the number that was hit is the deployment's and the error names it.
    assert.equal("ceiling" in failed, false);
    assert.match(String(failed.error), /32000-token output ceiling/);
  });
});

test("a first pass that spent its ceiling and wrote nothing is a different failure", async () => {
  await withTemp(async (dir) => {
    // The shape measured on a 100-page round: 32,000 output tokens, 0 characters. A model that
    // streams reasoning as its own channel can spend the whole ceiling before the page begins, and
    // the standing advice — raise `max_tokens` — buys a larger burn rather than a longer answer.
    // Here it is `truncated: true` with no excerpt at all, and the error's own sentence (#293).
    const empty = () => new TruncatedResponseError("bedrock", "claude-test", 32000, "");
    const { ctx, rec } = makeCtx(dir, 2, [1], empty);
    const { fragments } = await runExtraction(ctx);
    const failed = ev(rec, "page_extraction_failed")[0].data;
    assert.equal(failed.truncated, true);
    assert.equal(failed.reply_chars, 0);
    assert.equal("reply_head" in failed, false, "a head of \"\" would read as a model answering with nothing");
    assert.match(String(failed.error), /No text was returned at all/);
    // Still contained the same way: the page is a marker and the other page is delivered. Nothing
    // about this shape changes what the run does — it changes what an operator is told to do.
    assert.match(fragments.find((f) => f.order === 1)!.innerHtml, /@page-failed 1:/);
  });
});

test("a page that failed for any other reason has no reply to quote", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = makeCtx(dir, 2, [1], () => new Error("ThrottlingException"));
    const failed = await runExtraction(ctx).then(() => ev(rec, "page_extraction_failed")[0].data);
    // Absent rather than false: this line has carried `error` alone since it existed, and a
    // `truncated: false` on every throttle would suggest the field is a partition of the failures.
    assert.equal("truncated" in failed, false);
    assert.equal("reply_chars" in failed, false);
    assert.equal("reply_head" in failed, false);
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
    assert.deepEqual(ev(rec, "extraction_complete")[0].data, {
      pages: 3,
      failed: [1, 2, 3],
      // No `<img>` in these fixtures, so 0 of 0 — a run that checked nothing rather than a run
      // whose alts were clean. The distinction is why the denominator is on the line (#290).
      alts_checked: 0,
      alts_generic: 0,
    });
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
    assert.deepEqual(ev(rec, "extraction_complete")[0].data, { pages: 2, failed: [], alts_checked: 0, alts_generic: 0 });
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
    const failed = ev(rec, "page_extraction_failed")[0].data;
    assert.equal(failed.kept, "prior");
    // And the same evidence a first pass would have recorded (#293). This is the round a USER asked
    // for, so it is the worst one to leave silent: someone is waiting on an answer about this page,
    // and a reader following docs/API.md's row reads a missing `truncated` as "not a truncation".
    assert.equal(failed.truncated, true);
    assert.equal(failed.reply_chars, 87_851);
    assert.equal(String(failed.reply_head).length, 240);
    assert.equal(String(failed.reply_tail).length, 240);
  });
});

test("re-extracting a page that was missing fills the hole", async () => {
  await withTemp(async (dir) => {
    // The set is a property of the DOCUMENT, not of the run that lost the page, and this
    // is the only thing that shrinks it: a failed page's fragment is a marker, but it IS
    // a fragment, so the page is re-extractable and a clean round fills it in.
    const { ctx, rec } = makeCtx(dir, 3, [], truncated);
    const { fragments, failedPages, recovered } = await reExtractPages(ctx, [prior(1), prior(2), prior(3)], [2], [2]);
    assert.deepEqual(failedPages, [], "page 2 has content now");
    assert.equal(fragments.find((f) => f.order === 2)!.innerHtml, "<p>page</p>");
    assert.deepEqual(recovered, [2]);
    // Reported, not yet announced: diagnostics folds `page_recovered` straight into
    // `pages_failed`, and this round can still throw in review — which would leave the
    // client holding the document that has the hole and a diagnostics answer saying it
    // does not. The caller logs it once the new state is written (orchestrator.ts).
    assert.equal(ev(rec, "page_recovered").length, 0, "the recovery is not logged before it is durable");
  });
});

test("a page that was missing and failed again is still missing", async () => {
  await withTemp(async (dir) => {
    const { ctx } = makeCtx(dir, 3, [2], truncated);
    const { failedPages, recovered } = await reExtractPages(ctx, [prior(1), prior(2), prior(3)], [2], [2]);
    assert.deepEqual(failedPages, [2], "it kept its marker, so the document still has no page 2");
    assert.deepEqual(recovered, []);
  });
});

test("the page it lost is re-extracted from scratch, not from its own failure note", async () => {
  await withTemp(async (dir) => {
    // A missing page's fragment is the `@page-failed` comment, and this path shows the
    // agent its prior fragment as "your previous output ... keep everything the feedback
    // does not concern exactly as it was". Handing it the comment invites a page whose
    // content is a note about a truncated response — on the one round whose whole job is
    // to produce the page from nothing.
    const failed: Fragment = { ...prior(2), innerHtml: "<!-- @page-failed 2: hit the output ceiling -->" };
    const { ctx, rec } = makeCtx(dir, 3, [], truncated);
    await reExtractPages(ctx, [prior(1), failed, prior(3)], [2, 3], [2]);
    const forPage = (n: number) => rec.calls.find((c) => c.includes(`filename: page-00${n}.png`))!;
    assert.doesNotMatch(forPage(2), /@page-failed/, "the failure note is not shown back to the agent");
    assert.doesNotMatch(forPage(2), /## Your previous output for this page/);
    // And only for the page with nothing in it: page 3 has real content, and dropping
    // that would make every re-extraction a from-scratch one, which is the drift the
    // previous-output section exists to prevent.
    assert.match(forPage(3), /<p>prior 3<\/p>/, "a page that HAS content still gets it back");
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

const BLANK = JSON.stringify({ html: "", log: "This page is blank." });

test("a re-extraction cannot blank a page the document has content for", async () => {
  await withTemp(async (dir) => {
    // The declaration is refused rather than believed: the agent was shown page 2's own
    // previous output and then said the paper was empty, which contradicts what Iris already
    // holds. Believing it would replace real content with an empty fragment and report
    // nothing missing — a feedback round that deletes a page, which is exactly what the
    // `kept: "prior"` containment exists to prevent.
    const { ctx, rec } = makeCtx(dir, 3, [], truncated, (o) => (o === 2 ? BLANK : undefined));
    const { fragments, failedPages } = await reExtractPages(ctx, [prior(1), prior(2), prior(3)], [2, 3]);
    assert.deepEqual(failedPages, [], "the document is whole: page 2 still has its content");
    assert.equal(fragments.find((f) => f.order === 2)!.innerHtml, "<p>prior 2</p>");
    const refused = ev(rec, "page_blank_refused");
    assert.equal(refused.length, 1);
    assert.equal(refused[0].data.page, 2);
    assert.equal(refused[0].data.chars_kept, "<p>prior 2</p>".length);
    assert.equal(ev(rec, "page_blank").length, 0, "nothing recorded the page as blank");
    assert.equal(ev(rec, "page_extraction_failed")[0].data.kept, "prior");
    assert.deepEqual(ev(rec, "reextract_complete")[0].data, {
      pages: [3],
      failed: [2],
      alts_checked: 0,
      alts_generic: 0,
    });
  });
});

test("a re-extraction cannot blank that page by writing the declaration as markup either", async () => {
  await withTemp(async (dir) => {
    // The refusal above is the only thing on this path that stops a declaration deleting content Iris
    // already holds (#194), and it used to look at whether `html` was empty — so a re-extraction
    // answering `<!-- blank page -->` walked past it and the page's content became that comment, with
    // the run reporting nothing missing. 13 renders in the bench corpus are that reply (#219).
    const comment = JSON.stringify({ html: "<!-- Page 2: blank page -->", log: "Page 2 appears to be blank." });
    const { ctx, rec } = makeCtx(dir, 3, [], truncated, (o) => (o === 2 ? comment : undefined));
    const { fragments, failedPages } = await reExtractPages(ctx, [prior(1), prior(2), prior(3)], [2, 3]);
    assert.deepEqual(failedPages, []);
    assert.equal(fragments.find((f) => f.order === 2)!.innerHtml, "<p>prior 2</p>", "the content is still there");
    const refused = ev(rec, "page_blank_refused");
    assert.equal(refused.length, 1);
    assert.equal(refused[0].data.chars_kept, "<p>prior 2</p>".length);
    // And what arrived instead, so the line says which spelling walked into the refusal.
    assert.equal(refused[0].data.dropped, "<!-- Page 2: blank page -->");
    assert.equal(ev(rec, "page_blank").length, 0);
    assert.equal(ev(rec, "page_extraction_failed")[0].data.kept, "prior");
  });
});

test("a page that was lost can come back blank, and that fills the hole", async () => {
  await withTemp(async (dir) => {
    // The other side of the refusal: a failed page is shown no previous output (its fragment
    // is the failure marker), so there is no content for the declaration to contradict. "There
    // was nothing on it" is an answer, and an answered page is not a missing one.
    const failed: Fragment = { ...prior(2), innerHtml: "<!-- @page-failed 2: hit the output ceiling -->" };
    const { ctx, rec } = makeCtx(dir, 3, [], truncated, (o) => (o === 2 ? BLANK : undefined));
    const { fragments, failedPages, recovered } = await reExtractPages(ctx, [prior(1), failed, prior(3)], [2], [2]);
    assert.deepEqual(failedPages, []);
    assert.deepEqual(recovered, [2]);
    assert.equal(fragments.find((f) => f.order === 2)!.innerHtml, "", "and the marker is gone with it");
    assert.equal(ev(rec, "page_blank").length, 1);
    assert.equal(ev(rec, "page_blank_refused").length, 0);
  });
});

test("a source whose every page is blank is a failed run, not an empty document", async () => {
  await withTemp(async (dir) => {
    // Same rule as every page failing, and the test is on the content rather than on the
    // failed set for that reason: one blank scan uploaded alone, or a rasterization that
    // yielded white pages, would otherwise be delivered as `<main></main>` — a document of no
    // words, with no marker and no notice, from a run reporting success. The error says how
    // many pages were blank, which is a statement about the source that an empty file is not.
    const { ctx, rec } = makeCtx(dir, 3, [], truncated, () => BLANK);
    await assert.rejects(runExtraction(ctx), /3 of 3 source pages were reported blank/);
    assert.deepEqual(ev(rec, "extraction_complete")[0].data, { pages: 3, failed: [], alts_checked: 0, alts_generic: 0 });
    assert.deepEqual(ev(rec, "extraction_failed")[0].data, {
      pages: 0,
      blank: 3,
      reason: "no page produced content",
    });
  });
});

test("a document with one page of content and the rest blank is delivered", async () => {
  await withTemp(async (dir) => {
    // The guard is "no page produced content", not "any page was blank": one page of words is
    // a document, and the two blank pages contribute nothing because there was nothing on them.
    const { ctx, rec } = makeCtx(dir, 3, [], truncated, (o) => (o === 1 ? undefined : BLANK));
    const { fragments, failedPages } = await runExtraction(ctx);
    assert.deepEqual(failedPages, []);
    assert.equal(assembleBody(fragments).split("<p>page</p>").length - 1, 1);
    // Sorted, because the pages run concurrently and the log order is whichever finished first.
    assert.deepEqual(ev(rec, "page_blank").map((e) => Number(e.data.page)).sort((a, b) => a - b), [2, 3]);
    assert.equal(ev(rec, "extraction_failed").length, 0);
  });
});

test("a page that threw is not counted among the pages re-extracted", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = makeCtx(dir, 3, [2], truncated);
    await reExtractPages(ctx, [prior(1), prior(2), prior(3)], [2, 3]);
    assert.deepEqual(ev(rec, "reextract_complete")[0].data, {
      pages: [3],
      failed: [2],
      alts_checked: 0,
      alts_generic: 0,
    });
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

// The log of a session outlives any one run, so this field is a fold over it rather than
// a filter: the same page can be lost, filled in by a feedback round, and lost again.
const diag = (events: Record<string, unknown>[]) =>
  summarizeRun(events.map((e) => JSON.stringify({ ts: "2026-08-24T00:00:00.000Z", ...e })).join("\n"), {
    sessionId: "ses_test",
    status: "ready_for_review",
    phase: "done",
    now: Date.parse("2026-08-24T00:00:30.000Z"),
  });

test("a page a later round recovered is no longer reported as missing", () => {
  // Otherwise the field only ever grows, and the client Iris told to check it (docs/API.md
  // §7c) is sent looking for a hole the round it just paid for filled — on a document that
  // no longer carries any marker to corroborate it.
  const d = diag([
    { type: "page_extraction_failed", image: "page-002.png", page: 2, error: "x" },
    { type: "page_extraction_failed", image: "page-003.png", page: 3, error: "x" },
    { type: "page_recovered", pages: [2] },
    { type: "run_complete", failed_pages: [3] },
  ]);
  assert.deepEqual(d.pages_failed, [3]);
});

test("a recovered page stays recovered when a later round fails on it", () => {
  // The sequence a session really produces: once the hole is filled the page HAS content,
  // so a later re-extraction that throws keeps it — `kept: "prior"`, which this excludes.
  // Reporting the page as missing again would be the same lie in the other direction.
  const d = diag([
    { type: "page_extraction_failed", image: "page-002.png", page: 2, error: "x" },
    { type: "page_recovered", pages: [2] },
    { type: "page_extraction_failed", image: "page-002.png", page: 2, error: "x", kept: "prior" },
    { type: "run_complete" },
  ]);
  assert.deepEqual(d.pages_failed, []);
});

test("a page reported missing again after a recovery is missing again", () => {
  // Nothing emits this today: only the from-scratch extraction logs the event without
  // `kept: "prior"`, and a session extracts from scratch once. It pins the SHAPE of the
  // computation — the last word wins — so that a second from-scratch pass (a re-run whose
  // saved state is gone) cannot report a whole document, which a set difference would.
  const d = diag([
    { type: "page_extraction_failed", image: "page-002.png", page: 2, error: "x" },
    { type: "page_recovered", pages: [2] },
    { type: "page_extraction_failed", image: "page-002.png", page: 2, error: "x" },
    { type: "run_complete", failed_pages: [2] },
  ]);
  assert.deepEqual(d.pages_failed, [2]);
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
  assert.deepEqual(d.pages_blank, [], "and no blank ones, which is a different empty set");
});

// --- blank pages -------------------------------------------------------------

test("a blank page is reported apart from a failed one", () => {
  // The two mean opposite things to whoever reads the run: page 2 is work to redo, page 4 is
  // work already finished. Six of 100 bench pages were blank versos counted as lost source
  // pages, which made three of four complete documents read as partial (issue #179).
  const d = diag([
    { type: "page_extraction_failed", image: "page-002.png", page: 2, error: "x" },
    { type: "page_blank", image: "page-004.png", page: 4, log: "This page is blank." },
    { type: "run_complete", failed_pages: [2] },
  ]);
  assert.deepEqual(d.pages_failed, [2]);
  assert.deepEqual(d.pages_blank, [4]);
});

test("a page re-extracted with content is no longer reported blank", () => {
  // Feedback can name a page the agent reported empty ("you missed the table on page 4"), and
  // a round that finds content there means the page was not blank after all. Same rule as
  // `pages_failed`: what the log says LAST about a page is what is true of the document.
  const d = diag([
    { type: "page_blank", image: "page-004.png", page: 4, log: "This page is blank." },
    { type: "reextract_start", pages: [4], of: 5 },
    { type: "reextract_complete", pages: [4] },
    { type: "run_complete" },
  ]);
  assert.deepEqual(d.pages_blank, []);
});

test("a page that came back blank again is still blank", () => {
  const d = diag([
    { type: "page_blank", image: "page-004.png", page: 4, log: "This page is blank." },
    { type: "reextract_start", pages: [4], of: 5 },
    { type: "page_blank", image: "page-004.png", page: 4, log: "There is nothing on this page." },
    { type: "reextract_complete", pages: [4] },
    { type: "run_complete" },
  ]);
  assert.deepEqual(d.pages_blank, [4]);
});

test("a re-extraction that threw leaves a blank page blank", () => {
  // The one path that produces no new answer: the throw keeps the page's prior fragment,
  // which for a blank page is the empty one. Dropping it here would put the page in neither
  // set while the document has no content for it — the reading this field exists to prevent.
  const d = diag([
    { type: "page_blank", image: "page-004.png", page: 4, log: "This page is blank." },
    { type: "reextract_start", pages: [4], of: 5 },
    { type: "page_extraction_failed", image: "page-004.png", page: 4, error: "x", kept: "prior" },
    { type: "reextract_complete", pages: [], failed: [4] },
    { type: "run_complete" },
  ]);
  assert.deepEqual(d.pages_blank, [4]);
  assert.deepEqual(d.pages_failed, [], "and the round that failed to improve it lost nothing");
});

test("a page that failed and came back blank leaves the failed set", () => {
  // The document is whole once the page has been answered, and "nothing on it" is an answer.
  // The two sets stay disjoint: the page is in exactly one of them at every point.
  const d = diag([
    { type: "page_extraction_failed", image: "page-004.png", page: 4, error: "x" },
    { type: "reextract_start", pages: [4], of: 5 },
    { type: "page_blank", image: "page-004.png", page: 4, log: "This page is blank." },
    { type: "reextract_complete", pages: [4] },
    { type: "page_recovered", pages: [4] },
    { type: "run_complete" },
  ]);
  assert.deepEqual(d.pages_failed, []);
  assert.deepEqual(d.pages_blank, [4]);
});

// --- pages with no log -------------------------------------------------------

// A page rescued by `bareHtml`: the reply was markup rather than the envelope, so it delivered a
// usable page and carried no `"log"` field at all. It is in neither set above — it did not fail and
// it is not blank — which is why it shipped unnamed until #349, at 13.7% of pages across four
// deployed rounds of one PDF. What is lost is everything `agents/page.md` asks for in the log and
// nowhere else, unmet and unreported on about one page in seven.
test("a page whose reply carried no envelope is reported apart from a failed or blank one", () => {
  const d = diag([
    { type: "page_extraction_failed", image: "page-002.png", page: 2, error: "x" },
    { type: "page_blank", image: "page-003.png", page: 3, log: "This page is blank." },
    { type: "page_bare_html", image: "page-004.png", page: 4, chars: 1800, html_chars: 1800 },
    { type: "run_complete", failed_pages: [2] },
  ]);
  assert.deepEqual(d.pages_failed, [2]);
  assert.deepEqual(d.pages_blank, [3]);
  // Three states, three fields: page 4's HTML is in the document and its log is not, and a reader
  // told only about 2 and 3 has no way to ask about it.
  assert.deepEqual(d.pages_bare_html, [4]);
});

test("a page re-extracted with a proper envelope has a log and leaves the set", () => {
  // The withdrawal is what does the work: there is no `page_enveloped` event, so the round that
  // delivers a log says so by NOT saying the page was bare. Same rule as `pages_blank` — what the
  // log says last about a page is what is true of the document it shipped.
  const d = diag([
    { type: "page_bare_html", image: "page-004.png", page: 4, chars: 1800, html_chars: 1800 },
    { type: "reextract_start", pages: [4], of: 5 },
    { type: "reextract_complete", pages: [4] },
    { type: "run_complete" },
  ]);
  assert.deepEqual(d.pages_bare_html, []);
});

test("a page that came back bare again still has no log", () => {
  const d = diag([
    { type: "page_bare_html", image: "page-004.png", page: 4, chars: 1800, html_chars: 1800 },
    { type: "reextract_start", pages: [4], of: 5 },
    { type: "page_bare_html", image: "page-004.png", page: 4, chars: 1750, html_chars: 1750, reextract: true },
    { type: "reextract_complete", pages: [4] },
    { type: "run_complete" },
  ]);
  assert.deepEqual(d.pages_bare_html, [4]);
});

test("a re-extraction that threw leaves a page with no log", () => {
  // The one path that produces no new answer: the throw keeps the prior fragment, and the prior
  // fragment is the one that came without a log. Dropping the page here would report a document
  // whose logs are complete when nothing about it changed.
  const d = diag([
    { type: "page_bare_html", image: "page-004.png", page: 4, chars: 1800, html_chars: 1800 },
    { type: "reextract_start", pages: [4], of: 5 },
    { type: "page_extraction_failed", image: "page-004.png", page: 4, error: "x", kept: "prior" },
    { type: "reextract_complete", pages: [], failed: [4] },
    { type: "run_complete" },
  ]);
  assert.deepEqual(d.pages_bare_html, [4]);
  assert.deepEqual(d.pages_failed, [], "and the round that failed to improve it lost nothing");
});

test("a round that re-extracts other pages leaves a bare page where it was", () => {
  // The withdrawal is scoped to the pages the round actually re-ran. A round targeting page 2 says
  // nothing about page 4, and a fold that cleared the whole set on `reextract_start` would report a
  // document whose logs are complete because one unrelated page was refined.
  const d = diag([
    { type: "page_bare_html", image: "page-004.png", page: 4, chars: 1800, html_chars: 1800 },
    { type: "reextract_start", pages: [2], of: 5 },
    { type: "reextract_complete", pages: [2] },
    { type: "run_complete" },
  ]);
  assert.deepEqual(d.pages_bare_html, [4]);
});

test("a whole run reports no pages without a log", () => {
  const d = diag([{ type: "run_complete" }]);
  // Always an array, like the two sets beside it: a client reading `[]` learns that the run looked
  // and found none, which is not what a missing field says.
  assert.deepEqual(d.pages_bare_html, []);
});
