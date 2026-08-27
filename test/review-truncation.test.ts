// A correction round asks the Copy Editor for the whole document: "Return the complete
// corrected body." So the LENGTH of its response is a function of how long the document is,
// not of how much is wrong with it — and `max_tokens` is one fixed number for every call
// (config.ts DEFAULT_MAX_TOKENS). At a large `max_pages`, an ordinary document doing exactly
// what it was told hits that ceiling, and the provider raises `TruncatedResponseError`
// rather than return half a document (issue #143).
//
// That error used to end the run, and it ended it at the most expensive moment there is:
// extraction, assembly and a Reader pass all paid for, the assembled document sitting in a
// local variable, and the user handed a failure instead of it. Two documents of four in one
// bench round failed this way, for $8.59 of a $13.19 round — 65% of the spend, every dollar
// of it spent before the call that failed.
//
// So a truncation costs the round and not the document, which is #135's per-page containment
// one layer up. The loop stops, because the next round would send the same body and get the
// same ceiling, and what is delivered is the body that entered the round with that round's
// issues recorded as unresolved — a state the loop already supports and reports.
//
// This file is that containment, and its fixture body is 67 characters long: a document with no
// top-level boundary worth cutting at, so the round is discarded exactly as it was when #143 was
// fixed. The other half — a body long enough to be re-made a section at a time, which is what a
// 25-page document actually gets (issue #165) — is `editor-sections.test.ts`. Read together they
// are the two ways a truncated round can end, and the tests here are the ones that must keep
// passing unchanged: salvage that changed the no-salvage path would be a regression, not a
// feature.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview, type ReviewIssue } from "../src/pipeline/review.ts";
import { TruncatedResponseError, isTruncatedResponseError } from "../src/providers/types.ts";
import type { InputImage, PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iris-truncation-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Call {
  agent: string;
  imageCount: number;
}
interface Recorded {
  calls: Call[];
  events: { type: string; data: Record<string, unknown> }[];
}

const ISSUES: ReviewIssue[] = [
  { issue: "table headers missing", severity: "high", suggested_action: "add th", pages: [2] },
  { issue: "reading order", severity: "medium", suggested_action: "reorder", pages: [1] },
];

const PAGES = [
  { order: 1, innerHtml: "<h1>Quarterly Report</h1>" },
  { order: 2, innerHtml: "<table><caption>Revenue</caption></table>" },
];

const BODY = "<h1>Quarterly Report</h1><table><caption>Revenue</caption></table>";

// `fails` decides what an editor call does, by whether it carried images. Returning
// undefined means "answer normally".
function ctxWith(
  dir: string,
  fails: (imageCount: number) => Error | undefined,
  opts: { maxReviewIterations?: number } = {},
): { ctx: PipelineContext; rec: Recorded } {
  const inputDir = join(dir, "input");
  mkdirSync(inputDir, { recursive: true });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64",
  );
  const images: InputImage[] = [];
  for (let order = 1; order <= 2; order++) {
    const path = join(inputDir, `page-00${order}.png`);
    writeFileSync(path, png);
    images.push({ name: `page-00${order}.png`, order, path });
  }

  const rec: Recorded = { calls: [], events: [] };
  const ctx = {
    sessionId: "ses_test",
    images,
    maxReviewIterations: opts.maxReviewIterations ?? 3,
    extractionConcurrency: 4,
    paths: {
      agentsDir: join(dir, "agents"),
      tmpAgentsDir: () => join(dir, "tmp-agents"),
      agentMemory: () => join(dir, "memory", "page.json"),
    } as unknown as Paths,
    router: {
      complete: async (agent: string, _cap: string, _messages: unknown, o: { images?: unknown[] } = {}) => {
        const imageCount = o.images?.length ?? 0;
        rec.calls.push({ agent, imageCount });
        // The Reader never runs out of issues, so the loop always reaches the editor.
        if (agent === "reader") return { text: JSON.stringify({ issues: ISSUES }) };
        const failure = fails(imageCount);
        if (failure) throw failure;
        return { text: JSON.stringify({ html: "<h1>Edited</h1>" }) };
      },
    },
    log: {
      event: (type: string, data: Record<string, unknown> = {}) => rec.events.push({ type, data }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
  return { ctx, rec };
}

const truncated = (): TruncatedResponseError => new TruncatedResponseError("bedrock", "sonnet", 32_000, 78_006);

test("a truncated round delivers the document that entered it", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = ctxWith(dir, () => truncated());
    const result = await runReview(ctx, { body: BODY, lint: { ok: true, violations: [] }, pages: PAGES });

    // The delivery. Everything that was paid for before this round is in the user's hands.
    assert.equal(result.body, BODY, "the body that entered the round is what is delivered");
    assert.ok(result.html.includes(BODY));
    assert.equal(result.editorTruncated, true);
    // A 67-character body has no boundary to cut at, so the sectioned retry declines and this
    // is the round lost in full — the case a threshold is put on, as against a truncation the
    // retry absorbs (`editor-sections.test.ts`, issue #159).
    assert.equal(result.editorTruncatedLost, true);
    // And the round's issues are reported rather than silently forgotten: the loop's own
    // way of saying a document shipped with known problems.
    assert.deepEqual(result.unresolved.map((i) => i.issue), ISSUES.map((i) => i.issue));
    assert.match(result.html, /@unresolved/);
    assert.match(result.html, /table headers missing/);
  });
});

test("the document says a round was abandoned, not merely that issues remain", async () => {
  await withTemp(async (dir) => {
    // @unresolved on its own reads as "the editor tried and could not fix these". Here no
    // editor pass ever worked on them, and the difference is what a human opening the file
    // needs — one is a hard document, the other is a ceiling to raise.
    const { ctx } = ctxWith(dir, () => truncated());
    const { html } = await runReview(ctx, { body: BODY, lint: { ok: true, violations: [] }, pages: PAGES });
    assert.match(html, /@editor-truncated/);
    assert.match(html, /response hit the model's output ceiling/);
    assert.match(html, /issues listed below were not corrected/);
    assert.match(html, /editor_truncated/, "the log line to look up is named");
    // Placed like the other two wrapper statements: outside <main>, so it is not content,
    // and after the body, so the editor of a later feedback round cannot be handed it as
    // something to fix.
    assert.ok(html.indexOf("@editor-truncated") > html.indexOf("</main>"));
  });
});

test("a run that ends this way is not counted as a run that came back clean", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = ctxWith(dir, () => truncated());
    const result = await runReview(ctx, { body: BODY, lint: { ok: true, violations: [] }, pages: PAGES });
    // The round happened and was billed in full — a whole ceiling of output — so it counts.
    assert.equal(result.iterationsCompleted, 1);
    const event = rec.events.find((e) => e.type === "editor_truncated");
    assert.ok(event, "the most expensive line in the log was not written");
    assert.equal(event.data.max_tokens, 32_000, "the ceiling that was hit");
    assert.equal(event.data.chars, 78_006, "and how much came back, which says whether raising it would help");
    assert.equal(event.data.attached, 2);
    assert.equal(event.data.of, 2);
    // The completed-round line is for rounds that produced something. A truncated round
    // logging `editor` too would make the two indistinguishable in the log.
    assert.equal(rec.events.find((e) => e.type === "editor"), undefined);
  });
});

test("the loop stops rather than asking for the same length again", async () => {
  await withTemp(async (dir) => {
    // maxReviewIterations 3 with a Reader that always finds issues: without the break this
    // spends two more Reader passes and two more ceilings of output to learn the same fact,
    // because the response length follows the document and the document has not changed.
    const { ctx, rec } = ctxWith(dir, () => truncated(), { maxReviewIterations: 3 });
    await runReview(ctx, { body: BODY, lint: { ok: true, violations: [] }, pages: PAGES });
    assert.equal(rec.calls.filter((c) => c.agent === "copy_editor").length, 1, "the editor was asked twice");
    assert.equal(rec.calls.filter((c) => c.agent === "reader").length, 1, "a Reader pass was spent on the same body");
  });
});

test("a size refusal still degrades to a text-only retry, and a truncated retry is contained too", async () => {
  await withTemp(async (dir) => {
    // The two failures are about opposite ends of one call and both are now survivable:
    // the request being refused is answered by dropping the images (#134), and the answer
    // not fitting is answered by keeping the body (#143). A round can hit both in turn.
    const { ctx, rec } = ctxWith(dir, (imageCount) =>
      imageCount > 0
        ? new Error("ValidationException: Input is too long for requested model.")
        : truncated(),
    );
    const result = await runReview(ctx, { body: BODY, lint: { ok: true, violations: [] }, pages: PAGES });
    const editorCalls = rec.calls.filter((c) => c.agent === "copy_editor");
    assert.equal(editorCalls.length, 2, "the images-refused retry did not happen");
    assert.equal(editorCalls[1].imageCount, 0);
    assert.ok(rec.events.some((e) => e.type === "editor_images_refused"));
    const event = rec.events.find((e) => e.type === "editor_truncated");
    assert.equal(event?.data.after, "images_refused", "which of the two calls truncated is not recoverable otherwise");
    assert.equal(event?.data.attached, 0);
    assert.equal(result.body, BODY);
    assert.equal(result.editorTruncated, true);
    assert.equal(result.editorTruncatedLost, true, "the retry truncated too, so the round is still lost");
  });
});

test("any other failure still ends the run", async () => {
  await withTemp(async (dir) => {
    // The containment is for one diagnosis. A stall, a stream error or a bad key is not a
    // round that produced nothing usable — it is a deployment that is not working, and
    // swallowing it would deliver an uncorrected document while reporting nothing wrong.
    const { ctx } = ctxWith(dir, () => new Error("bedrock: stream error: boom"));
    await assert.rejects(
      runReview(ctx, { body: BODY, lint: { ok: true, violations: [] }, pages: PAGES }),
      /stream error: boom/,
    );
  });
});

test("an ordinary round is unchanged", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = ctxWith(dir, () => undefined, { maxReviewIterations: 1 });
    const result = await runReview(ctx, { body: BODY, lint: { ok: true, violations: [] }, pages: PAGES });
    assert.equal(result.editorTruncated, false);
    assert.equal(result.editorTruncatedLost, false, "and neither rate counts a round that fitted");
    assert.match(result.body, /Edited/, "the correction was kept");
    assert.doesNotMatch(result.html, /@editor-truncated/);
    assert.equal(rec.events.find((e) => e.type === "editor_truncated"), undefined);
    assert.ok(rec.events.some((e) => e.type === "editor"));
  });
});

test("the predicate answers for the error Iris raises, and for one that lost its prototype", () => {
  // `instanceof` is the check, because this error is ours: both adapters raise it, and its
  // message is written in one place. The fallback matches the fixed part of that sentence,
  // for an error re-wrapped at some boundary — and it must not fire on the OTHER size
  // failure, which is about the request and does have a remedy worth trying.
  assert.equal(isTruncatedResponseError(truncated()), true);
  assert.equal(
    isTruncatedResponseError(
      new Error(
        "bedrock: response hit the 32000-token output ceiling and was truncated (78006 chars returned). " +
          "Raise providers.bedrock.max_tokens.",
      ),
    ),
    true,
  );
  assert.equal(isTruncatedResponseError(new Error("ValidationException: Input is too long for requested model.")), false);
  assert.equal(isTruncatedResponseError(new Error("Request failed with status code 413")), false);
  assert.equal(isTruncatedResponseError("bedrock: stream error"), false);
});
