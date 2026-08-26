// A successful review round used to destroy the only copy of its own input.
//
// The Copy Editor is asked for the whole document and its `html` is adopted for the body verbatim,
// so once the round has run, the body that entered it is gone: nothing in the run log says how much
// of the document that round kept. That is the gap #174 is about. The path has no floor — a reply
// shaped like the contract rather than like the document would be adopted whole, and the blast
// radius is the document rather than one page — and a floor cannot be given a number without the
// distribution of a LEGITIMATE round to place it against.
//
// Which was measurable only on rounds that failed, where the delivered body is still the body that
// went in: three of them across four bench rounds, all three `editor_no_output`, all three removing
// about 1.7% of the body. Three samples, one document. So these four numbers go on the `editor`
// line, which turns that into one sample per round on the population that actually matters — and
// both pairs go on it, because the finding those three produced was that the two move
// independently: a round that un-wraps a mis-structured page moves structure counts hard and
// character count not at all, and one that deletes a duplicated heading does the reverse.
//
// This file pins what the numbers mean, not a threshold. There is no threshold yet, and picking one
// off n=3 is what #174 says not to do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview, type ReviewIssue } from "../src/pipeline/review.ts";
import type { InputImage, PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iris-round-size-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Recorded {
  events: { type: string; data: Record<string, unknown> }[];
}

// One issue on page 2, so the editor runs; one round, so the log has one `editor` line on it.
function ctxWith(dir: string, editorReply: string): { ctx: PipelineContext; rec: Recorded } {
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
  const issues: ReviewIssue[] = [
    { issue: "the revenue table has no headers", severity: "high", suggested_action: "add th scope", pages: [2] },
  ];
  const rec: Recorded = { events: [] };
  const ctx = {
    sessionId: "ses_test",
    images,
    maxReviewIterations: 1,
    extractionConcurrency: 4,
    paths: {
      agentsDir: join(dir, "agents"),
      tmpAgentsDir: () => join(dir, "tmp-agents"),
      agentMemory: () => join(dir, "memory", "page.json"),
    } as unknown as Paths,
    router: {
      complete: async (agent: string) => {
        if (agent === "reader") return { text: JSON.stringify({ issues }) };
        return { text: editorReply };
      },
    },
    log: {
      event: (type: string, data: Record<string, unknown> = {}) => rec.events.push({ type, data }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
  return { ctx, rec };
}

const PAGES = [
  { order: 1, innerHtml: "<h1>Quarterly Report</h1>" },
  { order: 2, innerHtml: "<table><caption>Revenue</caption></table>" },
];

const round = async (dir: string, body: string, html: string) => {
  const { ctx, rec } = ctxWith(dir, JSON.stringify({ html }));
  await runReview(ctx, { body, lint: { ok: true, violations: [] }, pages: PAGES });
  const editor = rec.events.find((e) => e.type === "editor");
  assert.ok(editor, "the round produced no editor line to measure");
  return { data: editor.data, rec };
};

test("a round records the body it was given as well as the body it returned", async () => {
  await withTemp(async (dir) => {
    const before = "<h1>Report</h1><table><tr><td>Revenue</td></tr></table>";
    const after = "<h1>Report</h1><table><tr><th scope='col'>Revenue</th></tr></table>";
    const { data } = await round(dir, before, after);

    assert.equal(data.changed, true);
    assert.equal(data.chars_before, before.length);
    assert.equal(data.chars_after, after.length);
    // The prose a reader receives, which is the other half of the question a floor would ask.
    // Stated as the strings themselves rather than as a recomputation of the code under test.
    assert.equal(data.text_chars_before, "Report Revenue".length);
    assert.equal(data.text_chars_after, "Report Revenue".length);
    // Not the wrapper: the `@`-comments and the `<main>` around it are added downstream, and are
    // not what the round returned. `chars_after` is the delivered body's own length.
    assert.ok((data.chars_after as number) < 200, "the sizes are the body, not the document");
  });
});

test("markup work and prose work are told apart, which one pair of numbers could not do", async () => {
  await withTemp(async (dir) => {
    // The shape the bench measurement actually found: the editor un-wraps a mis-structured page.
    // Every word survives, so a reader receives exactly what they did before — and the character
    // count moves by more than 20%, which is the size of change a naive floor would be placed to
    // catch. Reading `chars_*` alone here says a fifth of the document went missing.
    const before = "<section><div><h2>Outlook</h2><div><p>Steady growth.</p></div></div></section>";
    const after = "<h2>Outlook</h2><p>Steady growth.</p>";
    const { data } = await round(dir, before, after);

    assert.equal(data.text_chars_before, "Outlook Steady growth.".length);
    assert.equal(data.text_chars_after, data.text_chars_before, "no word moved, so no prose moved");
    assert.ok((data.chars_after as number) / (data.chars_before as number) < 0.5, "and yet half the markup went");
  });
});

test("prose the round deleted is visible in the prose sizes, where a floor would have to see it", async () => {
  await withTemp(async (dir) => {
    // The other direction, and the one the missing floor is about: the reply is well-formed HTML
    // and is most of the document short. Nothing here rejects it — that is #174's open half — but
    // the log now says by how much, which is what a threshold has to be chosen against.
    const before = "<h1>Report</h1><p>Revenue rose nine percent over the year.</p><p>Costs held flat.</p>";
    const after = "<h1>Report</h1>";
    const { data } = await round(dir, before, after);

    assert.equal(data.text_chars_after, "Report".length);
    assert.ok(
      (data.text_chars_after as number) / (data.text_chars_before as number) < 0.2,
      "a body that lost four fifths of its prose says so on its own line",
    );
    // And it was delivered, because there is no floor on this path yet. The point of the numbers
    // is that a run log now shows this; the point of #174 is that nothing stops it.
    assert.equal(data.changed, true);
  });
});

test("a round that returned nothing usable reports the ratio it is: unchanged, and beside the reason", async () => {
  await withTemp(async (dir) => {
    // The three samples the whole distribution was read off were replies with no usable body in
    // them, where the delivered body IS the body that went in — so their ratio is 1.000 by
    // construction, and a floor reading these numbers must not count them as a legitimate round
    // that happened to change nothing. `editor_no_output` on the same log is what says which it
    // was; `changed: false` alone cannot, because a converged round looks identical.
    const before = "<h1>Report</h1><p>Revenue rose nine percent.</p>";
    const { ctx, rec } = ctxWith(dir, "I have reviewed the document and have no changes to make.");
    await runReview(ctx, { body: before, lint: { ok: true, violations: [] }, pages: PAGES });

    const editor = rec.events.find((e) => e.type === "editor");
    assert.equal(editor?.data.changed, false);
    assert.equal(editor?.data.chars_before, before.length);
    assert.equal(editor?.data.chars_after, before.length);
    assert.equal(editor?.data.text_chars_before, editor?.data.text_chars_after);
    assert.ok(
      rec.events.some((e) => e.type === "editor_no_output"),
      "the line that says the round did not run is what the equal sizes have to be read with",
    );
  });
});
