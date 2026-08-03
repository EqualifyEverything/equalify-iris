import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imagesForIssues, runReview, type ReviewIssue } from "../src/pipeline/review.ts";
import type { InputImage, PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// The Copy Editor is the most expensive call in the pipeline: it attaches source
// page images as base64 on EVERY review round (up to max_review_iterations). It
// only ever needs the pages the Reader actually attributed issues to.
//
// The safety property that matters: an issue with NO usable attribution must fall
// back to attaching every image. Losing the images silently removes the only way
// to fix a source-fidelity problem, which is the one thing the editor needs them
// for — so an unattributed issue is expensive, never wrong.

// Async on purpose: a sync try/finally would rmSync the temp dir the moment the
// test body returned its promise, deleting files the run still needs.
async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iris-review-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function img(order: number): InputImage {
  return { name: `page-00${order}.png`, order, path: `/dev/null/page-00${order}.png` };
}

interface Call {
  agent: string;
  capability: string;
  prompt: string;
  imageCount: number;
}

interface Recorded {
  calls: Call[];
  events: { type: string; data: Record<string, unknown> }[];
}

// A context whose Reader returns `issues` on every round (so the loop always
// reaches the editor and then hits the cap). Images are real 1x1 PNGs on disk
// because loadImage reads them.
function ctxWith(
  dir: string,
  pageCount: number,
  // `pages` is widened rather than intersected: `ReviewIssue & { pages?: unknown }`
  // keeps the stricter `number[]` from the intersection, but these tests
  // deliberately feed what a sloppy model returns (`["3", 3]`) to prove the
  // coercion works. Omit removes the declared type so the override applies.
  issues: (Omit<ReviewIssue, "pages"> & { pages?: unknown })[],
): { ctx: PipelineContext; rec: Recorded; images: InputImage[] } {
  const inputDir = join(dir, "input");
  mkdirSync(inputDir, { recursive: true });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64",
  );
  const images: InputImage[] = [];
  for (let order = 1; order <= pageCount; order++) {
    const path = join(inputDir, `page-00${order}.png`);
    writeFileSync(path, png);
    images.push({ name: `page-00${order}.png`, order, path });
  }

  const rec: Recorded = { calls: [], events: [] };
  const ctx = {
    sessionId: "ses_test",
    images,
    maxReviewIterations: 1,
    extractionConcurrency: 4,
    paths: {
      agentsDir: join(dir, "agents"),
      tmpAgentsDir: () => join(dir, "tmp-agents"),
      // No learned lessons in these tests.
      agentMemory: () => join(dir, "memory", "page.json"),
    } as unknown as Paths,
    router: {
      complete: async (
        agent: string,
        capability: string,
        messages: { role: string; content: string }[],
        opts: { images?: unknown[] } = {},
      ) => {
        rec.calls.push({
          agent,
          capability,
          prompt: messages.map((m) => m.content).join("\n"),
          imageCount: opts.images?.length ?? 0,
        });
        if (agent === "reader") return { text: JSON.stringify({ issues }) };
        return { text: JSON.stringify({ html: "<h1>Edited</h1>" }) };
      },
    },
    log: {
      event: (type: string, data: Record<string, unknown> = {}) => rec.events.push({ type, data }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
  return { ctx, rec, images };
}

const PAGES = [
  { order: 1, innerHtml: "<h1>Quarterly Report</h1>" },
  { order: 2, innerHtml: "<table><caption>Revenue</caption></table>" },
  { order: 3, innerHtml: "<p>Outlook for next year.</p>" },
];

const editorCall = (rec: Recorded) => rec.calls.find((c) => c.agent === "copy_editor");

// --- imagesForIssues: the selection rule in isolation ------------------------

test("only the images for the attributed pages are selected", () => {
  const images = [img(1), img(2), img(3)];
  const selected = imagesForIssues(images, [
    { issue: "table headers missing", severity: "high", suggested_action: "add th", pages: [2] },
  ]);
  assert.deepEqual(selected.map((i) => i.order), [2]);
});

test("attributions across several issues are unioned", () => {
  const images = [img(1), img(2), img(3)];
  const selected = imagesForIssues(images, [
    { issue: "a", severity: "low", suggested_action: "x", pages: [3] },
    { issue: "b", severity: "low", suggested_action: "x", pages: [1, 3] },
  ]);
  assert.deepEqual(selected.map((i) => i.order), [1, 3], "deduped and in document order");
});

test("an unattributed issue falls back to every image", () => {
  const images = [img(1), img(2), img(3)];
  // The expensive-but-safe direction: the editor edits the whole body, so an issue
  // that could be anywhere must still be fixable against the source.
  const selected = imagesForIssues(images, [
    { issue: "reading order is wrong somewhere", severity: "high", suggested_action: "reorder", pages: [] },
  ]);
  assert.deepEqual(selected.map((i) => i.order), [1, 2, 3]);
});

test("a missing pages field is treated as unattributed", () => {
  const images = [img(1), img(2)];
  const selected = imagesForIssues(images, [{ issue: "a", severity: "low", suggested_action: "x" }]);
  assert.deepEqual(selected.map((i) => i.order), [1, 2]);
});

test("one unattributed issue re-broadens the whole round", () => {
  const images = [img(1), img(2), img(3)];
  // Mixed round: one issue is tied to page 2, the other could not be localized.
  // Narrowing to [2] would be the cheaper guess, and usually harmless — an
  // unattributed issue is typically structural and fixable from the HTML. But it is
  // also what an editor-rewritten body looks like once it has drifted from the
  // source excerpts, and that drift is worst in the late rounds where the iteration
  // budget is thinnest. At the cap the issue would reach @unresolved having never
  // been shown its page. Broadening costs at most the pre-optimization payload.
  const selected = imagesForIssues(images, [
    { issue: "table headers", severity: "high", suggested_action: "add th", pages: [2] },
    { issue: "duplicated content", severity: "medium", suggested_action: "dedupe" },
  ]);
  assert.deepEqual(selected.map((i) => i.order), [1, 2, 3]);
});

test("an empty pages array counts as unattributed, not as a narrow selection", () => {
  // `pages: []` is what runReader produces when knownPages() drops every number the
  // model claimed — an attribution attempt that failed, not an attribution to
  // nothing. It must behave like a missing field.
  const selected = imagesForIssues([img(1), img(2)], [
    { issue: "a", severity: "low", suggested_action: "x", pages: [] },
    { issue: "b", severity: "low", suggested_action: "y", pages: [2] },
  ]);
  assert.deepEqual(selected.map((i) => i.order), [1, 2]);
});

test("attributions that match no available image fall back rather than sending none", () => {
  // Defensive: runReader already validates page numbers against the document, so
  // this shape shouldn't arise — but sending zero images would silently strip the
  // editor's only view of the source.
  const selected = imagesForIssues([img(1), img(2)], [
    { issue: "a", severity: "low", suggested_action: "x", pages: [9] },
  ]);
  assert.deepEqual(selected.map((i) => i.order), [1, 2]);
});

test("a document with no images selects nothing", () => {
  assert.deepEqual(imagesForIssues([], [{ issue: "a", severity: "low", suggested_action: "x" }]), []);
});

// --- runReview: the loop actually narrows the payload ------------------------

test("the editor receives only the attributed page's image", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = ctxWith(dir, 3, [
      { issue: "revenue table has no headers", severity: "high", suggested_action: "add th scope", pages: [2] },
    ]);
    await runReview(ctx, { body: "<h1>Quarterly Report</h1>", lint: { ok: true, violations: [] }, pages: PAGES });
    const editor = editorCall(rec);
    assert.ok(editor, "the editor ran");
    assert.equal(editor.imageCount, 1, "1 of 3 images attached");
    assert.equal(editor.capability, "vision");
  });
});

test("an unattributed issue still sends every image", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = ctxWith(dir, 3, [
      { issue: "reading order is wrong", severity: "high", suggested_action: "reorder", pages: [] },
    ]);
    await runReview(ctx, { body: "<h1>Report</h1>", lint: { ok: true, violations: [] }, pages: PAGES });
    assert.equal(editorCall(rec)?.imageCount, 3);
  });
});

test("a page number the document does not have is dropped, widening to all images", async () => {
  await withTemp(async (dir) => {
    // Page 9 does not exist. Attaching image 9 is impossible and attaching none
    // would be worse, so the round degrades to the old all-images behavior.
    const { ctx, rec } = ctxWith(dir, 3, [
      { issue: "footnote inlined", severity: "medium", suggested_action: "restore", pages: [9] },
    ]);
    await runReview(ctx, { body: "<h1>Report</h1>", lint: { ok: true, violations: [] }, pages: PAGES });
    assert.equal(editorCall(rec)?.imageCount, 3);
  });
});

test("string page numbers from a sloppy model still narrow the payload", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = ctxWith(dir, 3, [
      { issue: "heading level skipped", severity: "high", suggested_action: "fix", pages: ["3", 3] },
    ]);
    await runReview(ctx, { body: "<h1>Report</h1>", lint: { ok: true, violations: [] }, pages: PAGES });
    assert.equal(editorCall(rec)?.imageCount, 1, "coerced and deduped to one page");
  });
});

test("the reader prompt carries the page index and the editor prompt names the pages", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = ctxWith(dir, 3, [
      { issue: "revenue table has no headers", severity: "high", suggested_action: "add th scope", pages: [2] },
    ]);
    await runReview(ctx, { body: "<h1>Report</h1>", lint: { ok: true, violations: [] }, pages: PAGES });
    const reader = rec.calls.find((c) => c.agent === "reader");
    assert.match(reader!.prompt, /### Page 2/, "the reader can see which page is which");
    assert.match(reader!.prompt, /Revenue/);
    const editor = editorCall(rec);
    assert.match(editor!.prompt, /page 2 are attached/);
    assert.match(editor!.prompt, /\(page 2\)/, "the issue list carries its attribution");
  });
});

test("the reader page index is excerpted, not the whole page", async () => {
  await withTemp(async (dir) => {
    // A distinctive tail word: if the whole page were indexed it would appear in
    // the prompt. Asserting on the CONTENT rather than on total prompt length,
    // because the recorded prompt includes the system message — comparing its
    // length to the page's makes the test a proxy for "the system prompt is
    // shorter than 400 words", which is unrelated and breaks when it is edited.
    const long = "<p>" + "word ".repeat(400) + "tailmarker</p>";
    const { ctx, rec } = ctxWith(dir, 1, []);
    await runReview(ctx, {
      body: "<h1>Report</h1>",
      lint: { ok: true, violations: [] },
      pages: [{ order: 1, innerHtml: long }],
    });
    const reader = rec.calls.find((c) => c.agent === "reader");
    assert.ok(!reader!.prompt.includes("tailmarker"), "the whole page reached the index instead of an excerpt");
    // ...and the head of the page IS there, so this isn't passing because the
    // index was omitted entirely.
    assert.match(reader!.prompt, /page 1/i);
    assert.match(reader!.prompt, /word/);
  });
});

test("without a page index the editor keeps the all-images behavior", async () => {
  await withTemp(async (dir) => {
    // No `pages` passed: the reader cannot attribute anything, so nothing narrows.
    const { ctx, rec } = ctxWith(dir, 3, [
      { issue: "something is off", severity: "low", suggested_action: "fix", pages: [2] },
    ]);
    await runReview(ctx, { body: "<h1>Report</h1>", lint: { ok: true, violations: [] } });
    const reader = rec.calls.find((c) => c.agent === "reader");
    assert.doesNotMatch(reader!.prompt, /Source pages in this document/);
    assert.equal(editorCall(rec)?.imageCount, 3, "page 2 is unverifiable, so all images are sent");
  });
});

test("the images attached are logged for each editor round", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = ctxWith(dir, 3, [
      { issue: "table", severity: "high", suggested_action: "fix", pages: [2] },
    ]);
    await runReview(ctx, { body: "<h1>Report</h1>", lint: { ok: true, violations: [] }, pages: PAGES });
    const ev = rec.events.find((e) => e.type === "editor_images");
    assert.deepEqual(ev?.data, { attached: 1, of: 3, pages: [2] });
  });
});

test("a clean document never calls the editor at all", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = ctxWith(dir, 3, []);
    const result = await runReview(ctx, {
      body: "<h1>Report</h1>",
      lint: { ok: true, violations: [] },
      pages: PAGES,
    });
    assert.equal(editorCall(rec), undefined);
    assert.equal(result.iterationsCompleted, 0);
    assert.deepEqual(result.unresolved, []);
  });
});

test("unresolved issues keep their source page reference", async () => {
  await withTemp(async (dir) => {
    const { ctx } = ctxWith(dir, 3, [
      { issue: "revenue table has no headers", severity: "high", suggested_action: "add th scope", pages: [2] },
    ]);
    const result = await runReview(ctx, {
      body: "<h1>Report</h1>",
      lint: { ok: true, violations: [] },
      pages: PAGES,
    });
    assert.deepEqual(result.unresolved[0].pages, [2]);
    assert.match(result.html, /page 2/, "the @unresolved comment records where to look");
  });
});
