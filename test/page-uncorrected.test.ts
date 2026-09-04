import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExtraction, reExtractPages } from "../src/pipeline/extraction.ts";
import { wrapDocument } from "../src/pipeline/assembly.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Fragment } from "../src/pipeline/fragment.ts";
import type { Paths } from "../src/store/paths.ts";

// A page the fidelity check REJECTED, naming what was wrong, whose one correction pass repaired
// nothing. What the document carries for that page is content Iris named a defect in and never
// fixed — and until #328 the document said nothing about it at all. `@page-failed` announces a page
// with no content, which anyone who opens the file can see for themselves; a page whose statistical
// table lost its six aggregate rows looks finished and no longer adds up.
//
// "Rejected and never corrected" is deliberately not among the cases below, because it is not a
// state that exists: `failedCheck` requires a named problem, so a failed verdict always buys a
// correction. What these pin down is the five ways that one pass ends without repairing the page —
// it threw, it answered with nothing, it answered with the page it was given, it answered at a
// fraction of the size and was refused, or it answered with a different STRING carrying the same
// page — and that all five are one fact about the delivered document. The last of them is the one
// that looks like a repair, so it has a test of its own below rather than a row in the table.

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iris-uncorrected-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Recorded {
  events: { type: string; data: Record<string, unknown> }[];
}

// How this page's one correction pass ends. `kept` is the adopted correction, which is the case
// that must NOT be marked.
type Correction = "throw" | "empty" | "identical" | "restyle" | "shrink" | "kept";

interface PageSpec {
  // What the fidelity check says about the first pass. Absent, or empty, is a page that passes.
  problems?: string[];
  correction?: Correction;
  // Placeholder alt text in the fragment, which buys a correction from a code check rather than
  // from a verdict — the one way a correction runs on a page nothing rejected.
  genericAlt?: true;
  // The first pass throws, so the page has no content at all. That is `failedPages`, and the two
  // sets have to stay disjoint.
  renderThrows?: true;
}

// Long enough that a quarter of it is a visible shrink (`CORRECTION_SHRINK_FLOOR`), and unlike
// per page so a correction call can be traced back to the page it is about: that prompt names no
// filename, only the previous output it is asking to have fixed.
const body = (order: number, tag = "page"): string =>
  `<h2>Page ${order}</h2><p>${tag} ${order} ${"content ".repeat(20)}</p>`;
const withAlt = (order: number): string => `${body(order)}<p><img src="f.png" alt="image"></p>`;
// The same page as a DIFFERENT string: a model that re-indents its own output. `corrected !== before`
// so this is adopted and delivered, but every axis `correctionEffect` observes is unchanged — text
// with whitespace collapsed, the descriptions, the attributes, the tag sequence — so `changedAnything`
// is false and the page the verifier named problems in is still the page that ships.
const restyled = (order: number): string => body(order).replace("</h2>", "</h2>\n  ");
const frag = (order: number, innerHtml: string): Fragment => ({
  image: `page-00${order}.png`,
  order,
  agent: "page.md",
  region: "page",
  innerHtml,
  edges: [],
  log: "",
});

// A document of `pageCount` pages, each behaving as `spec` says and passing its check otherwise.
//
// Unlike test/page-failure.test.ts this writes a feedback.md, because the whole subject here is
// what the verifier decided: with no Feedback Agent `verifyAgentOutput` short-circuits to the
// unjudged verdict and no page is ever rejected. Calls are told apart by `step` rather than by
// pattern-matching the prompt, so a verify call and the render it is judging cannot be confused.
function makeCtx(
  dir: string,
  pageCount: number,
  spec: Record<number, PageSpec>,
): { ctx: PipelineContext; rec: Recorded } {
  const agentsDir = join(dir, "agents");
  const fragDir = join(dir, "fragments");
  const inputDir = join(dir, "input");
  for (const d of [agentsDir, fragDir, inputDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
  writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\nvision\n");

  const images: { name: string; order: number; path: string }[] = [];
  for (let order = 1; order <= pageCount; order++) {
    const name = `page-00${order}.png`;
    writeFileSync(join(inputDir, name), "not-a-real-png");
    images.push({ name, order, path: join(inputDir, name) });
  }

  const rec: Recorded = { events: [] };
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
      complete: async (
        _agent: string,
        _cap: string,
        messages: { role: string; content: string }[],
        opts?: { step?: string },
      ) => {
        const prompt = messages.map((m) => m.content).join("\n");
        const step = opts?.step;
        if (step === "verify" || step === "recheck_binding" || step === "recheck_sampled") {
          // The verify prompt names the source image; the fragment it is judging is whatever the
          // caller handed it. Only the FIRST check answers with the verdict under test — a recheck
          // is asked about a corrected fragment, and on the verify path it decides nothing.
          const img = images.find((i) => prompt.includes(`source image "${i.name}"`))!;
          const problems = step === "verify" ? (spec[img.order]?.problems ?? []) : [];
          return { text: JSON.stringify({ faithful: problems.length === 0, accessible: true, problems }) };
        }
        if (step === "correct") {
          const img = images.find((i) => prompt.includes(body(i.order)))!;
          const outcome = spec[img.order]?.correction ?? "kept";
          if (outcome === "throw") throw new Error("ThrottlingException");
          if (outcome === "empty") return { text: JSON.stringify({ html: "" }) };
          if (outcome === "identical") return { text: JSON.stringify({ html: body(img.order) }) };
          if (outcome === "restyle") return { text: JSON.stringify({ html: restyled(img.order) }) };
          // A reply at well under a quarter of what it was given, which `destroyedPage` refuses
          // before either recheck can be bought for it.
          if (outcome === "shrink") return { text: JSON.stringify({ html: `<p>${img.order}</p>` }) };
          return { text: JSON.stringify({ html: body(img.order, "corrected") }) };
        }
        const img = images.find((i) => prompt.includes(`filename: ${i.name}`))!;
        if (spec[img.order]?.renderThrows) throw new Error("ThrottlingException");
        const html = spec[img.order]?.genericAlt ? withAlt(img.order) : body(img.order);
        return { text: JSON.stringify({ html, log: "" }) };
      },
    },
    log: {
      event: (type: string, data: Record<string, unknown> = {}) => rec.events.push({ type, data }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
  return { ctx, rec };
}

const ev = (rec: Recorded, type: string) => rec.events.filter((e) => e.type === type);
const rejected = ["The table on this page lost its six aggregate rows."];

// Four of the five ways one correction pass ends without repairing the page — the fifth is tested on
// its own, because it is the one where the reply IS adopted — and what each of them is called in
// the log. `page_corrected`'s `result` is the field a reader who has the marker goes to for which it
// was; the marker itself does not distinguish them, because for the delivered document they are the
// same fact.
const ENDINGS: { correction: Correction; result: string; also?: string }[] = [
  { correction: "throw", result: "failed", also: "page_correction_failed" },
  { correction: "empty", result: "empty" },
  { correction: "identical", result: "identical" },
  { correction: "shrink", result: "rejected", also: "page_correction_rejected" },
];

for (const ending of ENDINGS) {
  test(`a rejected page whose correction ${ending.result} ships as the fragment that failed`, async () => {
    await withTemp(async (dir) => {
      const { ctx, rec } = makeCtx(dir, 3, { 2: { problems: rejected, correction: ending.correction } });
      const { fragments, failedPages, uncorrectedPages } = await runExtraction(ctx);

      assert.deepEqual(uncorrectedPages, [2]);
      // The point of the set: the page is here, and what is here is the rejected markup. A
      // marker that fired on a page whose content had changed would be describing something
      // else.
      assert.equal(fragments.find((f) => f.order === 2)!.innerHtml, body(2));
      // And disjoint from the no-content set, which is the distinction the two markers exist to
      // keep: nothing was lost here.
      assert.deepEqual(failedPages, []);

      assert.deepEqual(ev(rec, "page_verify_failed").map((e) => e.data.image), ["page-002.png"]);
      const corrected = ev(rec, "page_corrected");
      assert.equal(corrected.length, 1, "one correction was bought, for the one rejected page");
      assert.equal(corrected[0].data.result, ending.result);
      assert.equal(corrected[0].data.trigger, "verify");
      if (ending.also) assert.equal(ev(rec, ending.also).length, 1, `${ending.also} names how it ended`);

      const complete = ev(rec, "extraction_complete")[0].data;
      assert.deepEqual(complete.uncorrected, [2], "the run's own roll-up, without joining two events");

      const doc = wrapDocument("<p>x</p>", { uncorrectedPages });
      assert.match(doc, /@page-uncorrected 2\b/, "the delivered document admits to it");
      assert.match(doc, /never passed Iris's\n  own fidelity check/);
    });
  });
}

test("a correction ADOPTED that changed the string and not the page is still marked", async () => {
  await withTemp(async (dir) => {
    // The fifth ending, and the only one that looks like a repair from the outside: the reply
    // differs from the fragment it was given, so `corrected !== before` and it is kept and
    // delivered — and it is the same page, re-indented. Nothing the verifier objected to has been
    // touched. The marker is therefore driven off `moved` (did the page change) rather than off
    // `keep` (was the reply adopted), and `page_corrected` labels this `identical` for exactly the
    // same reason, which is what makes the rule readable off the log as one line: a page whose
    // verdict failed is in the set unless its `result` is `kept`.
    const { ctx, rec } = makeCtx(dir, 3, { 2: { problems: rejected, correction: "restyle" } });
    const { fragments, uncorrectedPages } = await runExtraction(ctx);

    assert.deepEqual(uncorrectedPages, [2]);
    // The reply WAS adopted — this is not the `corrected === before` branch wearing a different
    // name, and a test that let these two collapse would leave the case with no assertion at all.
    const shipped = fragments.find((f) => f.order === 2)!.innerHtml;
    assert.equal(shipped, restyled(2));
    assert.notEqual(shipped, body(2), "the string changed, which is the whole point of this case");

    const corrected = ev(rec, "page_corrected");
    assert.equal(corrected.length, 1);
    assert.equal(corrected[0].data.result, "identical", "adopted, and not a repair");
    assert.deepEqual(ev(rec, "extraction_complete")[0].data.uncorrected, [2]);
    assert.match(wrapDocument("<p>x</p>", { uncorrectedPages }), /@page-uncorrected 2\b/);
  });
});

test("a correction the pass adopted is not marked, however wrong the page may still be", async () => {
  await withTemp(async (dir) => {
    // The boundary that keeps the marker worth reading. Replaying the check over 57 corrected
    // pages put their pass rate at 26% (#288), so a marker covering them would fire on most of
    // the pages of an ordinary round — the verifier rejects 71–74% of first renders — and stop
    // meaning anything. What the absence of this marker says is that no page shipped as the
    // fragment its own verifier rejected, not that every page was checked after correction.
    const { ctx, rec } = makeCtx(dir, 2, { 1: { problems: rejected, correction: "kept" } });
    const { fragments, uncorrectedPages } = await runExtraction(ctx);
    assert.deepEqual(uncorrectedPages, []);
    assert.equal(fragments.find((f) => f.order === 1)!.innerHtml, body(1, "corrected"));
    assert.equal(ev(rec, "page_corrected")[0].data.result, "kept");
    // Present and empty, not absent. A field that only appeared when it fired could not tell
    // "every rejected page was repaired" from "this run predates the count".
    assert.deepEqual(ev(rec, "extraction_complete")[0].data.uncorrected, []);
    assert.doesNotMatch(wrapDocument("<p>x</p>", { uncorrectedPages }), /@page-uncorrected/);
  });
});

test("a correction bought by the alt rule on a page that PASSED is not a failed verification", async () => {
  await withTemp(async (dir) => {
    // The gate is `verifyFailed`, not "a correction was bought and did not land". This page's
    // check passed; what failed is a repair for a placeholder alt, and that is already reported
    // by name (`page_generic_alt`). A marker saying the page did not pass verification would be
    // false about it.
    const { ctx, rec } = makeCtx(dir, 2, { 1: { genericAlt: true, correction: "throw" } });
    const { uncorrectedPages } = await runExtraction(ctx);
    assert.deepEqual(uncorrectedPages, []);
    assert.equal(ev(rec, "page_verify_failed").length, 0, "nothing rejected this page");
    assert.equal(ev(rec, "page_generic_alt").length, 1);
    const failed = ev(rec, "page_correction_failed");
    assert.equal(failed.length, 1, "the repair was still bought and still failed");
    assert.equal(failed[0].data.trigger, "alt");
  });
});

test("a page with no content at all is the other marker, not this one", async () => {
  await withTemp(async (dir) => {
    // `@page-failed` and `@page-uncorrected` are disjoint by construction: a page whose render
    // threw never reaches a verdict, so it cannot be in the rejected set, and a reader adding the
    // two counts together is counting two different failures rather than double-counting one.
    const { ctx } = makeCtx(dir, 3, {
      1: { renderThrows: true },
      3: { problems: rejected, correction: "identical" },
    });
    const { failedPages, uncorrectedPages } = await runExtraction(ctx);
    assert.deepEqual(failedPages, [1]);
    assert.deepEqual(uncorrectedPages, [3]);
    const doc = wrapDocument("<p>x</p>", { failedPages, uncorrectedPages });
    // In that order, which is the order the preamble explains them in: the incomplete document
    // first, then the complete one with known-wrong content in it.
    assert.ok(doc.indexOf("@page-failed") < doc.indexOf("@page-uncorrected"));
  });
});

test("a feedback round carries the set forward page by page", async () => {
  await withTemp(async (dir) => {
    // Re-extracting a page is the only way a rejected page gets a second answer, so this is the
    // only path that can take one out of the set — and it has to leave every page it did not
    // re-run exactly as it found it.
    const { ctx, rec } = makeCtx(dir, 5, {
      // Re-run and accepted this time: it leaves.
      1: {},
      // Re-run, rejected again, correction failed again: it stays.
      2: { problems: rejected, correction: "throw" },
      // Not re-run at all: it stays, on the prior round's verdict.
      3: { problems: rejected, correction: "throw" },
      // Re-run and the render threw, so the prior fragment ships — and with it the prior
      // verdict, which is the one that describes those bytes.
      4: { renderThrows: true },
      // Not in the prior set, rejected in THIS round: it joins.
      5: { problems: rejected, correction: "identical" },
    });
    const prior = [1, 2, 3, 4, 5].map((o) => frag(o, body(o)));
    const { failedPages, uncorrectedPages } = await reExtractPages(ctx, prior, [1, 2, 4, 5], [], [1, 2, 3, 4]);
    assert.deepEqual(uncorrectedPages, [2, 3, 4, 5]);
    // A page whose re-extraction threw kept its prior content, so it is not a page the document
    // is missing — the same distinction `reextract_complete`'s `failed` field draws.
    assert.deepEqual(failedPages, []);
    assert.deepEqual(ev(rec, "reextract_complete")[0].data.uncorrected, [2, 3, 4, 5]);
  });
});
