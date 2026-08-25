import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capEditorImages, imagesForIssues, runReview, type ReviewIssue } from "../src/pipeline/review.ts";
import { MAX_EDITOR_IMAGES } from "../src/providers/imageLimits.ts";
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

function pages(n: number): InputImage[] {
  return Array.from({ length: n }, (_, i) => img(i + 1));
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
  // Makes the editor call that CARRIES IMAGES fail with this message, the way a
  // provider refuses a request larger than the model's context window. A retry with
  // no images succeeds, which is the whole point of the fallback under test.
  behavior: { imageCallFailsWith?: string } = {},
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
        if (behavior.imageCallFailsWith && (opts.images?.length ?? 0) > 0) {
          throw new Error(behavior.imageCallFailsWith);
        }
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

// --- capEditorImages: what fits in one request -------------------------------

test("a selection within the cap is passed through untouched", () => {
  const selected = pages(MAX_EDITOR_IMAGES);
  const capped = capEditorImages(selected, []);
  assert.deepEqual(capped, selected, "same images, same order, nothing dropped at exactly the cap");
});

test("an over-cap selection is trimmed to the cap", () => {
  const capped = capEditorImages(pages(25), [
    { issue: "reading order is wrong somewhere", severity: "high", suggested_action: "reorder" },
  ]);
  assert.equal(capped.length, MAX_EDITOR_IMAGES);
  // Nothing is attributed, so there is no evidence to prefer by and document order wins.
  assert.deepEqual(capped.map((i) => i.order), Array.from({ length: MAX_EDITOR_IMAGES }, (_, i) => i + 1));
});

test("a page an issue named survives the cap ahead of earlier pages", () => {
  // The whole point of the preference: page 25 is the only page the editor cannot fix
  // this issue without, and it is last in document order — a plain head-slice loses it.
  const capped = capEditorImages(pages(25), [
    { issue: "table headers missing", severity: "high", suggested_action: "add th", pages: [25] },
    { issue: "duplicated content", severity: "medium", suggested_action: "dedupe" },
  ]);
  assert.equal(capped.length, MAX_EDITOR_IMAGES);
  assert.ok(capped.some((i) => i.order === 25), "the attributed page was kept");
  assert.deepEqual(
    capped.map((i) => i.order),
    [...Array.from({ length: MAX_EDITOR_IMAGES - 1 }, (_, i) => i + 1), 25],
    "survivors are re-sorted into document order, because the prompt names them in that order",
  );
});

test("more attributed pages than fit still yields exactly the cap", () => {
  const attributed = Array.from({ length: 20 }, (_, i) => i + 6);
  const capped = capEditorImages(pages(25), [
    { issue: "a", severity: "high", suggested_action: "x", pages: attributed },
  ]);
  assert.equal(capped.length, MAX_EDITOR_IMAGES);
  assert.ok(capped.every((i) => attributed.includes(i.order)), "only attributed pages took the slots");
});

test("a cap of zero still sends one image", () => {
  // Defensive: zero images at capability "vision" is a request shape the editor prompt
  // does not describe, so the floor is one page rather than none.
  const capped = capEditorImages(pages(3), [], 0);
  assert.deepEqual(capped.map((i) => i.order), [1]);
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

test("the all-images fallback on a long document is capped, and the drop is logged", async () => {
  await withTemp(async (dir) => {
    // The #134 shape: a 25-page upload (MAX_PDF_PAGES) plus one issue the Reader could
    // not attribute. Before the cap this sent all 25 page images and the provider
    // refused the request, ending a run that had already paid for extraction.
    const { ctx, rec } = ctxWith(dir, 25, [
      { issue: "reading order is wrong somewhere", severity: "high", suggested_action: "reorder" },
    ]);
    await runReview(ctx, { body: "<h1>Report</h1>", lint: { ok: true, violations: [] }, pages: PAGES });
    assert.equal(editorCall(rec)?.imageCount, MAX_EDITOR_IMAGES);
    const ev = rec.events.find((e) => e.type === "editor_images");
    assert.equal(ev?.data.attached, MAX_EDITOR_IMAGES);
    assert.equal(ev?.data.of, 25);
    assert.equal(ev?.data.dropped, 25 - MAX_EDITOR_IMAGES, "no silent cap: the round says what it lost");
  });
});

test("a refused payload is retried without the images rather than failing the run", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = ctxWith(
      dir,
      3,
      [{ issue: "table headers", severity: "high", suggested_action: "add th", pages: [2] }],
      // Bedrock's wording for a request over the context window. The cap is derived from
      // an estimate, so a body long enough to leave no room still gets here.
      { imageCallFailsWith: "ValidationException: Input is too long for requested model." },
    );
    const result = await runReview(ctx, {
      body: "<h1>Report</h1>",
      lint: { ok: true, violations: [] },
      pages: PAGES,
    });
    const editorCalls = rec.calls.filter((c) => c.agent === "copy_editor");
    assert.equal(editorCalls.length, 2, "the same prompt was re-sent once");
    assert.equal(editorCalls[1].imageCount, 0);
    assert.equal(editorCalls[1].capability, "text", "no images means no vision model is needed");
    assert.match(editorCalls[1].prompt, /No source images are available/, "the prompt stops promising attachments");
    assert.match(editorCalls[1].prompt, /table headers/, "the issues and body survive the retry");
    const ev = rec.events.find((e) => e.type === "editor_images_refused");
    assert.equal(ev?.data.attached, 1);
    assert.match(result.body, /Edited/, "the correction the text-only pass produced was kept");
  });
});

test("a byte-size refusal is retried too, not only a context-window one", async () => {
  await withTemp(async (dir) => {
    // MAX_EDITOR_IMAGES bounds what a page costs in TOKENS; the request ceiling these
    // APIs enforce is in bytes. A dozen screenshots at the published per-image ceiling is
    // tens of megabytes base64-encoded, and is refused for size without ever being
    // weighed in tokens — the same fact about the same request, so the same remedy.
    const { ctx, rec } = ctxWith(
      dir,
      3,
      [{ issue: "table headers", severity: "high", suggested_action: "add th", pages: [2] }],
      { imageCallFailsWith: "Request failed with status code 413" },
    );
    await runReview(ctx, { body: "<h1>Report</h1>", lint: { ok: true, violations: [] }, pages: PAGES });
    const editorCalls = rec.calls.filter((c) => c.agent === "copy_editor");
    assert.equal(editorCalls.length, 2);
    assert.equal(editorCalls[1].imageCount, 0);
    assert.ok(rec.events.some((e) => e.type === "editor_images_refused"));
  });
});

test("a truncated editor response is not mistaken for a payload that was too big", async () => {
  await withTemp(async (dir) => {
    // A TruncatedResponseError's message carries a character count and the model's
    // max_tokens, either of which can contain "413". Retrying it with fewer images fixes
    // nothing and hides the one diagnosis that names the knob to raise: the request was
    // accepted and read: it is the ANSWER that did not fit, and asking again for the
    // complete corrected body asks for the same length.
    //
    // What it does instead is deliver the body that entered the round — see
    // test/review-truncation.test.ts for that half (issue #143). Here the property is
    // only that it is not the images that get blamed.
    const { ctx, rec } = ctxWith(
      dir,
      3,
      [{ issue: "table headers", severity: "high", suggested_action: "add th", pages: [2] }],
      {
        imageCallFailsWith:
          "bedrock: response hit the 32000-token output ceiling and was truncated (413 chars returned). " +
          "Raise providers.bedrock.max_tokens.",
      },
    );
    const result = await runReview(ctx, {
      body: "<h1>Report</h1>",
      lint: { ok: true, violations: [] },
      pages: PAGES,
    });
    assert.equal(rec.calls.filter((c) => c.agent === "copy_editor").length, 1, "the round was retried");
    assert.equal(rec.events.find((e) => e.type === "editor_images_refused"), undefined);
    assert.equal(result.body, "<h1>Report</h1>", "the body that entered the round is what is delivered");
    assert.equal(result.editorTruncated, true);
  });
});

test("a failure that is not about size is not retried", async () => {
  await withTemp(async (dir) => {
    // Retrying a stall or a stream error would double the cost of every real failure
    // and change nothing about the outcome.
    const { ctx, rec } = ctxWith(
      dir,
      3,
      [{ issue: "table headers", severity: "high", suggested_action: "add th", pages: [2] }],
      { imageCallFailsWith: "bedrock: stream error: boom" },
    );
    await assert.rejects(
      runReview(ctx, { body: "<h1>Report</h1>", lint: { ok: true, violations: [] }, pages: PAGES }),
      /stream error: boom/,
    );
    assert.equal(rec.calls.filter((c) => c.agent === "copy_editor").length, 1);
    assert.equal(rec.events.find((e) => e.type === "editor_images_refused"), undefined);
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
