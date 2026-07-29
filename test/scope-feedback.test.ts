import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopeFeedback } from "../src/pipeline/feedback.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// scopeFeedback decides whether a piece of feedback needs the SOURCE IMAGES
// (re-extract those pages) or only the assembled document (review loop). The
// safety property that matters: every uncertain path must resolve to "document",
// because a wrong "document" costs one review round while a wrong "extraction"
// costs a vision call per page.

interface Recorded {
  events: { type: string; data: Record<string, unknown> }[];
  prompts: string[];
}

// Builds a context whose router returns `reply` for the scope call. Only the
// pieces scopeFeedback touches are real: an agents dir holding feedback.md, the
// router, and the log.
function ctxWith(
  dir: string,
  feedback: string | undefined,
  reply: string,
  opts: { withAgent?: boolean } = {},
): { ctx: PipelineContext; rec: Recorded } {
  const agentsDir = join(dir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  if (opts.withAgent !== false) {
    writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\ntext\n");
  }
  const rec: Recorded = { events: [], prompts: [] };
  const ctx = {
    sessionId: "ses_test",
    feedback,
    extractionConcurrency: 4,
    paths: {
      agentsDir,
      tmpAgentsDir: () => join(dir, "tmp-agents"),
    } as unknown as Paths,
    router: {
      complete: async (_agent: string, _cap: string, messages: { role: string; content: string }[]) => {
        rec.prompts.push(messages.map((m) => m.content).join("\n"));
        return { text: reply };
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
  const dir = mkdtempSync(join(tmpdir(), "iris-scope-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FRAGS = [
  { order: 1, innerHtml: "<h1>Quarterly Report</h1>" },
  { order: 2, innerHtml: "<table><caption>Revenue</caption></table>" },
  { order: 3, innerHtml: "<p>Outlook for next year.</p>" },
  { order: 4, innerHtml: "<p>Appendix.</p>" },
];

test("source-fidelity feedback routes to extraction with the named pages", async () => {
  await withTemp(async (dir) => {
    const { ctx } = ctxWith(
      dir,
      "The revenue table on page 2 has the wrong numbers.",
      JSON.stringify({ target: "extraction", pages: [2], reason: "table misread" }),
    );
    const scope = await scopeFeedback(ctx, FRAGS);
    assert.equal(scope.target, "extraction");
    assert.deepEqual(scope.pages, [2]);
  });
});

test("document-level feedback stays on the review-only path", async () => {
  await withTemp(async (dir) => {
    const { ctx } = ctxWith(
      dir,
      "Keep headings distinct from body text.",
      JSON.stringify({ target: "document", pages: [], reason: "wording preference" }),
    );
    const scope = await scopeFeedback(ctx, FRAGS);
    assert.equal(scope.target, "document");
    assert.deepEqual(scope.pages, []);
  });
});

test("no feedback never triggers a re-extraction", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = ctxWith(dir, undefined, JSON.stringify({ target: "extraction", pages: [1] }));
    const scope = await scopeFeedback(ctx, FRAGS);
    assert.equal(scope.target, "document");
    assert.equal(rec.prompts.length, 0, "no model call without feedback");
  });
});

test("a missing feedback agent falls back to document without a model call", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = ctxWith(dir, "page 2 is wrong", JSON.stringify({ target: "extraction", pages: [2] }), {
      withAgent: false,
    });
    const scope = await scopeFeedback(ctx, FRAGS);
    assert.equal(scope.target, "document");
    assert.equal(rec.prompts.length, 0);
  });
});

test("an unparseable answer falls back to document", async () => {
  await withTemp(async (dir) => {
    const { ctx } = ctxWith(dir, "page 2 is wrong", "I think maybe page two? Not sure.");
    const scope = await scopeFeedback(ctx, FRAGS);
    assert.equal(scope.target, "document");
  });
});

test("extraction with no identifiable pages falls back to document", async () => {
  await withTemp(async (dir) => {
    // The agent is instructed to return an empty list rather than guess. Blindly
    // re-extracting the whole document would be the expensive wrong answer.
    const { ctx } = ctxWith(
      dir,
      "Something was misread somewhere.",
      JSON.stringify({ target: "extraction", pages: [], reason: "cannot localize" }),
    );
    const scope = await scopeFeedback(ctx, FRAGS);
    assert.equal(scope.target, "document");
    assert.match(scope.reason, /no pages identified/);
  });
});

test("hallucinated page numbers are dropped, not re-extracted", async () => {
  await withTemp(async (dir) => {
    const { ctx } = ctxWith(
      dir,
      "The table is wrong.",
      JSON.stringify({ target: "extraction", pages: [2, 99, -1, 0], reason: "table misread" }),
    );
    const scope = await scopeFeedback(ctx, FRAGS);
    assert.equal(scope.target, "extraction");
    assert.deepEqual(scope.pages, [2], "only pages that exist in this document survive");
  });
});

test("string page numbers from a sloppy model are coerced and deduped", async () => {
  await withTemp(async (dir) => {
    const { ctx } = ctxWith(
      dir,
      "Pages 3 and 1 are wrong.",
      JSON.stringify({ target: "extraction", pages: ["3", 1, "1"], reason: "misread" }),
    );
    const scope = await scopeFeedback(ctx, FRAGS);
    assert.deepEqual(scope.pages, [1, 3], "coerced, deduped, and sorted");
  });
});

test("feedback claiming most of the document is too broad to re-extract", async () => {
  await withTemp(async (dir) => {
    // 3 of 4 pages is past the half-document guard: at that point a re-extraction
    // costs about as much as a fresh run, which a targeted correction should not.
    const { ctx } = ctxWith(
      dir,
      "The whole thing is wrong.",
      JSON.stringify({ target: "extraction", pages: [1, 2, 3], reason: "everything misread" }),
    );
    const scope = await scopeFeedback(ctx, FRAGS);
    assert.equal(scope.target, "document");
    assert.match(scope.reason, /too broad/);
  });
});

test("half the document is still allowed through", async () => {
  await withTemp(async (dir) => {
    const { ctx } = ctxWith(
      dir,
      "Pages 1 and 2 misread the header.",
      JSON.stringify({ target: "extraction", pages: [1, 2], reason: "header misread" }),
    );
    const scope = await scopeFeedback(ctx, FRAGS);
    assert.equal(scope.target, "extraction");
    assert.deepEqual(scope.pages, [1, 2]);
  });
});

test("a single-page document can still be re-extracted", async () => {
  await withTemp(async (dir) => {
    // The fraction guard would round 1 * 0.5 down to 0; the floor of 1 keeps a
    // one-page document fixable.
    const { ctx } = ctxWith(
      dir,
      "The heading is wrong.",
      JSON.stringify({ target: "extraction", pages: [1], reason: "heading misread" }),
    );
    const scope = await scopeFeedback(ctx, [{ order: 1, innerHtml: "<h1>Report</h1>" }]);
    assert.equal(scope.target, "extraction");
    assert.deepEqual(scope.pages, [1]);
  });
});

test("the scope prompt carries the feedback and per-page excerpts, not the whole document", async () => {
  await withTemp(async (dir) => {
    const long = "<p>" + "word ".repeat(500) + "</p>";
    const { ctx, rec } = ctxWith(
      dir,
      "The revenue table is wrong.",
      JSON.stringify({ target: "extraction", pages: [2] }),
    );
    await scopeFeedback(ctx, [...FRAGS, { order: 5, innerHtml: long }]);
    const prompt = rec.prompts[0];
    assert.match(prompt, /TASK: scope/);
    assert.match(prompt, /The revenue table is wrong\./);
    assert.match(prompt, /### Page 5/);
    assert.ok(prompt.length < long.length, "long pages are excerpted, not sent whole");
  });
});

test("pages are presented in document order regardless of fragment array order", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = ctxWith(dir, "something", JSON.stringify({ target: "document" }));
    await scopeFeedback(ctx, [
      { order: 3, innerHtml: "<p>third</p>" },
      { order: 1, innerHtml: "<p>first</p>" },
      { order: 2, innerHtml: "<p>second</p>" },
    ]);
    const prompt = rec.prompts[0];
    assert.ok(
      prompt.indexOf("### Page 1") < prompt.indexOf("### Page 2") &&
        prompt.indexOf("### Page 2") < prompt.indexOf("### Page 3"),
      "page list is ordered so page numbers mean what the agent thinks they mean",
    );
  });
});

test("an empty prior document cannot be re-extracted", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = ctxWith(dir, "fix page 1", JSON.stringify({ target: "extraction", pages: [1] }));
    const scope = await scopeFeedback(ctx, []);
    assert.equal(scope.target, "document");
    assert.equal(rec.prompts.length, 0, "nothing to scope against, so no model call");
  });
});
