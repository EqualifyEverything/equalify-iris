import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reExtractPages } from "../src/pipeline/extraction.ts";
import type { PipelineContext, InputImage } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";
import type { Fragment } from "../src/pipeline/fragment.ts";

// reExtractPages is the feedback path that puts SOURCE IMAGES back in front of
// the page agent for just the pages a correction names. The properties that
// matter: untargeted pages come through byte-identical, the result stays in
// document order, and only the targeted pages cost model calls.

interface Recorded {
  events: { type: string; data: Record<string, unknown> }[];
  // Page-agent prompts, keyed by the image the call carried.
  calls: { agent: string; prompt: string }[];
}

const IMAGE_NAMES = ["page-001.png", "page-002.png", "page-003.png", "page-004.png"];

function priorFragments(): Fragment[] {
  return IMAGE_NAMES.map((name, i) => ({
    image: name,
    order: i + 1,
    agent: "page.md",
    region: "page",
    innerHtml: `<p>original page ${i + 1}</p>`,
    edges: [],
    log: "",
  }));
}

// Only the pieces reExtractPages touches are real: an agents dir with page.md and
// feedback.md, on-disk source images, the router, and the log.
function makeCtx(
  dir: string,
  opts: { feedback?: string; images?: InputImage[] } = {},
): { ctx: PipelineContext; rec: Recorded } {
  const agentsDir = join(dir, "agents");
  const fragDir = join(dir, "fragments");
  const inputDir = join(dir, "input");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(fragDir, { recursive: true });
  mkdirSync(inputDir, { recursive: true });
  writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
  // No feedback.md: verifyAgentOutput then short-circuits to ok, keeping these
  // tests focused on re-extraction rather than the verify sub-call.
  for (const name of IMAGE_NAMES) writeFileSync(join(inputDir, name), "not-a-real-png");

  const images: InputImage[] =
    opts.images ??
    IMAGE_NAMES.map((name, i) => ({ name, order: i + 1, path: join(inputDir, name) }));

  const rec: Recorded = { events: [], calls: [] };
  const ctx = {
    sessionId: "ses_test",
    feedback: opts.feedback ?? "The table on page 2 has the wrong numbers.",
    images,
    extractionConcurrency: 4,
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
        messages: { role: string; content: string }[],
      ) => {
        const prompt = messages.map((m) => m.content).join("\n");
        rec.calls.push({ agent, prompt });
        const page = prompt.match(/page (\d+) of/)?.[1] ?? "?";
        return { text: JSON.stringify({ html: `<p>corrected page ${page}</p>`, log: "" }) };
      },
    },
    log: {
      event: (type: string, data: Record<string, unknown> = {}) => rec.events.push({ type, data }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
  return { ctx, rec };
}

// Async on purpose: a sync try/finally would rmSync the temp dir the moment the
// test body returned its promise, deleting files the run still needs.
async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iris-reextract-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("only the targeted page is re-extracted; the rest are untouched", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = makeCtx(dir);
    const prior = priorFragments();
    const { fragments } = await reExtractPages(ctx, prior, [2]);

    assert.equal(fragments.length, 4);
    assert.equal(fragments[1].innerHtml, "<p>corrected page 2</p>", "page 2 was re-extracted");
    for (const i of [0, 2, 3]) {
      assert.deepEqual(fragments[i], prior[i], `page ${i + 1} came through unchanged`);
    }
    assert.equal(rec.calls.length, 1, "one page targeted => one page-agent call");
  });
});

test("re-extracted fragments stay in document order", async () => {
  await withTemp(async (dir) => {
    const { ctx } = makeCtx(dir);
    const { fragments } = await reExtractPages(ctx, priorFragments(), [3, 1]);
    assert.deepEqual(
      fragments.map((f) => f.order),
      [1, 2, 3, 4],
    );
    assert.equal(fragments[0].innerHtml, "<p>corrected page 1</p>");
    assert.equal(fragments[1].innerHtml, "<p>original page 2</p>");
    assert.equal(fragments[2].innerHtml, "<p>corrected page 3</p>");
  });
});

test("prior fragments in scrambled order are still assembled in page order", async () => {
  await withTemp(async (dir) => {
    const { ctx } = makeCtx(dir);
    const scrambled = [priorFragments()[2], priorFragments()[0], priorFragments()[3], priorFragments()[1]];
    const { fragments } = await reExtractPages(ctx, scrambled, [1]);
    assert.deepEqual(
      fragments.map((f) => f.order),
      [1, 2, 3, 4],
    );
  });
});

test("the re-extraction prompt carries both the feedback and the prior page output", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = makeCtx(dir, { feedback: "The revenue figure on page 2 should be 4.2M." });
    await reExtractPages(ctx, priorFragments(), [2]);
    const prompt = rec.calls[0].prompt;
    // Feedback must reach the page agent — this is the whole point of the path.
    assert.match(prompt, /The revenue figure on page 2 should be 4\.2M\./);
    // Prior output is shown so untouched content carries over instead of drifting.
    assert.match(prompt, /## Your previous output for this page/);
    assert.match(prompt, /<p>original page 2<\/p>/);
  });
});

test("a page with no prior fragment is skipped rather than invented", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = makeCtx(dir);
    // Page 9 exists in neither the prior fragments nor the images.
    const { fragments } = await reExtractPages(ctx, priorFragments(), [9]);
    assert.equal(rec.calls.length, 0, "nothing to re-extract");
    assert.deepEqual(fragments, priorFragments(), "document returned unchanged");
    const skipped = rec.events.find((e) => e.type === "reextract_skipped");
    assert.ok(skipped, "the skip is logged rather than silent");
    assert.deepEqual(skipped?.data.pages, [9]);
  });
});

test("a page whose source image is gone is skipped, keeping its prior fragment", async () => {
  await withTemp(async (dir) => {
    // Prior run had 4 pages; only pages 1 and 2 still have source images.
    const inputDir = join(dir, "input");
    const { ctx, rec } = makeCtx(dir, {
      images: [
        { name: IMAGE_NAMES[0], order: 1, path: join(inputDir, IMAGE_NAMES[0]) },
        { name: IMAGE_NAMES[1], order: 2, path: join(inputDir, IMAGE_NAMES[1]) },
      ],
    });
    const prior = priorFragments();
    const { fragments } = await reExtractPages(ctx, prior, [2, 4]);
    assert.equal(rec.calls.length, 1, "only page 2 could be re-extracted");
    assert.equal(fragments[1].innerHtml, "<p>corrected page 2</p>");
    assert.deepEqual(fragments[3], prior[3], "page 4 kept its prior fragment");
    assert.deepEqual(rec.events.find((e) => e.type === "reextract_skipped")?.data.pages, [4]);
  });
});

test("an empty target list is a no-op that preserves the document", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = makeCtx(dir);
    const { fragments } = await reExtractPages(ctx, priorFragments(), []);
    assert.equal(rec.calls.length, 0);
    assert.deepEqual(fragments, priorFragments());
  });
});

test("fragments.json is rewritten with the merged document", async () => {
  await withTemp(async (dir) => {
    const { ctx } = makeCtx(dir);
    await reExtractPages(ctx, priorFragments(), [2]);
    const onDisk = JSON.parse(readFileSync(join(dir, "fragments", "fragments.json"), "utf8")) as Fragment[];
    assert.deepEqual(
      onDisk.map((f) => f.order),
      [1, 2, 3, 4],
    );
    assert.equal(onDisk[1].innerHtml, "<p>corrected page 2</p>");
    assert.equal(onDisk[0].innerHtml, "<p>original page 1</p>");
  });
});

test("the re-extraction is logged with the pages it touched", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = makeCtx(dir);
    await reExtractPages(ctx, priorFragments(), [3, 1]);
    const start = rec.events.find((e) => e.type === "reextract_start");
    assert.deepEqual(start?.data.pages, [1, 3], "logged in document order");
    assert.equal(start?.data.of, 4);
    assert.deepEqual(rec.events.find((e) => e.type === "reextract_complete")?.data.pages, [1, 3]);
  });
});
