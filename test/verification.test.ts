// What the verify-then-correct loop bought, and whether the log now says.
//
// Across three real 25-page runs the Feedback Agent rejected 58 of 75 pages, so the
// "correct if needed" pass is in practice always taken — and nothing recorded what it
// changed, whether it converged, or whether a call that ran produced anything at all
// (issue #137). The events under test are the measurement that question needs; they
// change no verdict and no delivered document, which is itself asserted below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { correctionEffect } from "../src/pipeline/correction.ts";
import { runExtraction } from "../src/pipeline/extraction.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";
import type { PdfLink } from "../src/util/pdf.ts";

// --- what a correction changed, read off the two fragments --------------------

test("an alt-text refinement is not a change to the page", () => {
  // The distinction the whole module exists for. This is the correction the issue
  // quotes — "orange kayak" becoming "orange-yellow kayak, facing away" — and it costs
  // a full page call while changing no text and no structure. A run whose corrections
  // all look like this is paying per page for image descriptions.
  const before = `<p>Our progress</p><img src="a.png" alt="a person in a red life jacket in an orange kayak">`;
  const after = `<p>Our progress</p><img src="a.png" alt="a person in a red life jacket in an orange-yellow kayak, back to the camera">`;
  const e = correctionEffect(before, after);
  assert.equal(e.alt_changed, true);
  assert.equal(e.text_changed, false);
  assert.equal(e.structure_changed, false);
  assert.equal(e.chars_before, before.length);
  assert.equal(e.chars_after, after.length);
});

test("content coming back is a change to both the text and the structure", () => {
  const before = `<table><tr><th>Year</th></tr><tr><td>2026</td></tr></table>`;
  const after = `<table><tr><th>Year</th><th>Total</th></tr><tr><td>2026</td><td>41</td></tr></table>`;
  const e = correctionEffect(before, after);
  assert.equal(e.text_changed, true);
  assert.equal(e.structure_changed, true);
  assert.equal(e.alt_changed, false);
});

test("a heading level correction is structural with the same words", () => {
  // The correction that matters most and shows up least: `<h2>` to `<h3>` moves no text
  // at all, so a measure built on text alone would call this pass a no-op.
  const e = correctionEffect(`<h2>Methodology</h2><p>x</p>`, `<h3>Methodology</h3><p>x</p>`);
  assert.equal(e.structure_changed, true);
  assert.equal(e.text_changed, false);
  assert.equal(e.alt_changed, false);
});

test("reformatting, re-indenting and re-spelling an entity are not changes", () => {
  // A model re-emits its own output with different whitespace all the time. Counting
  // that as a correction would report every pass as productive, which is the number
  // this measurement exists to be trusted on.
  const before = `<ul><li>Costs &amp; savings</li><li>Notes</li></ul>`;
  const after = `<ul>\n  <li>Costs & savings</li>\n  <li>Notes</li>\n</ul>\n`;
  const e = correctionEffect(before, after);
  assert.equal(e.text_changed, false);
  assert.equal(e.structure_changed, false);
  assert.equal(e.alt_changed, false);
  // The sizes still differ, and are reported, because "the same page, re-typed" is
  // worth being able to see.
  assert.notEqual(e.chars_before, e.chars_after);
});

test("moving a word from one image's description to the next is a change", () => {
  // Two alts that concatenate to the same string. Joined on a separator an attribute
  // value cannot hold, so the boundary between them counts.
  const before = `<img alt="a bar chart of revenue"><img alt="by quarter">`;
  const after = `<img alt="a bar chart"><img alt="of revenue by quarter">`;
  assert.equal(correctionEffect(before, after).alt_changed, true);
});

test("an unescaped > inside a description does not make an alt rewrite a text change", () => {
  // Model output does not always escape `>` in an attribute. A tag-strip that stops at the
  // first one leaves ` 2019">` behind as "visible text", and then this correction reports
  // text_changed and leaves `alt_only` — the bucket the module exists to isolate.
  const before = `<p>Revenue</p><img src="c.png" alt="a bar chart, 2020 > 2019">`;
  const after = `<p>Revenue</p><img src="c.png" alt="a bar chart, 2020 taller than 2019">`;
  const e = correctionEffect(before, after);
  assert.equal(e.alt_changed, true);
  assert.equal(e.text_changed, false);
  assert.equal(e.structure_changed, false);
});

test("an attribute that merely ends in alt is not an alt", () => {
  // `\b` opens on the `alt` of `data-alt`, so a rewrite of a data attribute would be
  // reported as a change to a description no reader ever hears.
  const e = correctionEffect(`<img src="a.png" alt="a kayak" data-alt="one">`, `<img src="a.png" alt="a kayak" data-alt="two">`);
  assert.equal(e.alt_changed, false);
  assert.equal(e.text_changed, false);
});

test("a page rewritten to nothing reports what it lost", () => {
  const e = correctionEffect(`<p>The whole page</p>`, ``);
  assert.equal(e.text_changed, true);
  assert.equal(e.structure_changed, true);
  assert.equal(e.chars_after, 0);
});

// --- through the pipeline -----------------------------------------------------

interface Event {
  type: string;
  [k: string]: unknown;
}

interface Behaviour {
  // Initial render per page order.
  html: (order: number) => string;
  // First verdict per page order: the problems it names, empty for a pass.
  problems: (order: number) => string[];
  // What the correction pass returns, or "" for a call that produced nothing.
  corrected: (order: number) => string;
  // The re-verification's verdict, for pages that get one.
  recheck?: (order: number) => string[];
  // A provider error on the re-verification, the way ProviderRouter.complete raises one.
  recheckThrows?: boolean;
  links?: PdfLink[];
}

function makeCtx(dir: string, events: Event[], b: Behaviour, pages = 2): PipelineContext {
  const agentsDir = join(dir, "agents");
  const fragDir = join(dir, "fragments");
  const inputDir = join(dir, "input");
  for (const d of [agentsDir, fragDir, inputDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
  writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\nvision\n");
  const names = Array.from({ length: pages }, (_, i) => `page-00${i + 1}.png`);
  for (const n of names) writeFileSync(join(inputDir, n), "not-a-real-png");
  const orderOf = (user: string): number => names.findIndex((n) => user.includes(n)) + 1;
  // Which verify call this is for a given page: the first is the fidelity check, a
  // second is a re-verification of the corrected fragment.
  const verifies = new Map<number, number>();

  return {
    sessionId: "ses_test",
    images: names.map((name, i) => ({
      name,
      order: i + 1,
      path: join(inputDir, name),
      links: b.links ?? [],
    })),
    extractionConcurrency: pages,
    maxReviewIterations: 1,
    paths: {
      agentsDir,
      tmpAgentsDir: () => join(dir, "tmp-agents"),
      agentMemory: (agent: string) => join(dir, `mem-${agent.replace(/\.md$/, "")}.json`),
      sessionFragments: () => fragDir,
    } as unknown as Paths,
    router: {
      complete: async (_agent: string, _cap: string, messages: { role: string; content: string }[]) => {
        const user = messages.find((m) => m.role === "user")?.content ?? "";
        const order = orderOf(user);
        if (user.includes("TASK: verify")) {
          const n = (verifies.get(order) ?? 0) + 1;
          verifies.set(order, n);
          if (n > 1 && b.recheckThrows) throw new Error("ThrottlingException: Too many requests");
          const problems = n === 1 ? b.problems(order) : (b.recheck ?? (() => []))(order);
          return {
            text: JSON.stringify({
              faithful: problems.length === 0,
              accessible: true,
              problems,
            }),
          };
        }
        if (user.includes("had fidelity/accessibility problems")) {
          return { text: JSON.stringify({ html: b.corrected(order) }) };
        }
        return { text: JSON.stringify({ html: b.html(order), log: "" }) };
      },
    },
    log: {
      event: (type: string, fields: Record<string, unknown>) => events.push({ type, ...fields }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iris-verification-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const of = (events: Event[], type: string): Event[] => events.filter((e) => e.type === type);

test("a correction that changed the page says what it changed", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const rendered = `<h2>Findings</h2><img src="a.png" alt="a kayak">`;
    const fixed = `<h2>Findings</h2><img src="a.png" alt="a kayak, the paddler facing away">`;
    const ctx = makeCtx(dir, events, {
      html: () => rendered,
      problems: (o) => (o === 1 ? ["the alt text omits that the person faces away"] : []),
      corrected: () => fixed,
    });
    const result = await runExtraction(ctx);

    const corrected = of(events, "page_corrected");
    assert.equal(corrected.length, 1, "one page failed its check, so one correction");
    assert.deepEqual(
      { ...corrected[0] },
      {
        type: "page_corrected",
        image: "page-001.png",
        page: 1,
        trigger: "verify",
        problems: 1,
        result: "kept",
        chars_before: rendered.length,
        chars_after: fixed.length,
        text_changed: false,
        alt_changed: true,
        structure_changed: false,
      },
    );
    // And the document is the corrected page, unchanged by any of this.
    assert.match(result.fragments[0].innerHtml, /facing away/);
  });
});

test("a correction that returned the page it was given is recorded as buying nothing", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const same = `<p>Unchanged</p>`;
    await runExtraction(
      makeCtx(dir, events, {
        html: () => same,
        problems: (o) => (o === 1 ? ["a column of the table was dropped"] : []),
        corrected: () => same,
      }),
    );
    const corrected = of(events, "page_corrected");
    assert.equal(corrected.length, 1);
    assert.equal(corrected[0].result, "identical");
    // No effect fields: there was no difference to describe, and reporting three
    // `false`s would read as a change measured rather than a call wasted.
    assert.equal("text_changed" in corrected[0], false);
    // A call that changed nothing does not spend the batch's one measurement slot
    // either — there is nothing to re-verify.
    assert.equal(of(events, "page_correction_recheck").length, 0);
  });
});

test("a page re-typed to no effect is counted with the calls that bought nothing", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The model returns its own page re-indented, with `&` where it wrote `&amp;`. That is a
    // different string and the same page, so bucketing on string identity would file it as
    // `kept` — a page call that bought nothing counted beside one that restored a table, and
    // not recoverable from the fold afterwards, since `text` and `structure` overlap and
    // cannot be subtracted from `kept`.
    const rendered = `<ul><li>Costs &amp; savings</li></ul>`;
    const retyped = `<ul>\n  <li>Costs & savings</li>\n</ul>`;
    const result = await runExtraction(
      makeCtx(dir, events, {
        html: () => rendered,
        problems: (o) => (o === 1 ? ["a list item was dropped"] : []),
        corrected: () => retyped,
      }),
    );
    const corrected = of(events, "page_corrected");
    assert.equal(corrected.length, 1);
    assert.equal(corrected[0].result, "identical");
    // The sizes still say which kind of nothing this was: a model that re-typed the page
    // and one that handed back the exact string it was given cost the same and are not the
    // same event.
    assert.equal(corrected[0].chars_before, rendered.length);
    assert.equal(corrected[0].chars_after, retyped.length);
    assert.equal("text_changed" in corrected[0], false);
    // And it buys no re-verification either: there is no change to check.
    assert.equal(of(events, "page_correction_recheck").length, 0);
    assert.match(result.fragments[0].innerHtml, /Costs/);
  });
});

test("a correction that came back empty is recorded, and the page keeps its content", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const result = await runExtraction(
      makeCtx(dir, events, {
        html: () => `<p>What the page says</p>`,
        problems: (o) => (o === 1 ? ["the heading level is wrong"] : []),
        corrected: () => "",
      }),
    );
    const corrected = of(events, "page_corrected");
    assert.equal(corrected.length, 1);
    assert.equal(corrected[0].result, "empty");
    assert.match(result.fragments[0].innerHtml, /What the page says/);
  });
});

test("one page per run is re-verified, however many were corrected", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // Every page fails, which is the run the issue reports (25 of 25). Re-verifying all
    // of them would roughly double the Feedback Agent's share of the bill, which is the
    // number under investigation.
    await runExtraction(
      makeCtx(
        dir,
        events,
        {
          html: (o) => `<p>page ${o}</p>`,
          problems: () => ["a figure is missing its caption"],
          corrected: (o) => `<p>page ${o}</p><figcaption>Figure ${o}</figcaption>`,
          recheck: () => [],
        },
        4,
      ),
    );
    assert.equal(of(events, "page_verify_failed").length, 4);
    assert.equal(of(events, "page_corrected").length, 4);
    const rechecks = of(events, "page_correction_recheck");
    assert.equal(rechecks.length, 1, "the sample is one page, not one per correction");
    assert.equal(rechecks[0].ok, true);
    // Not a gate: this verdict decided nothing, and a consumer must be able to tell
    // that from the event rather than from reading the pipeline.
    assert.equal(rechecks[0].binding, false);
  });
});

test("a corrected page that still fails is reported as still failing, and still kept", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const result = await runExtraction(
      makeCtx(dir, events, {
        html: () => `<p>first pass</p>`,
        problems: (o) => (o === 1 ? ["the second column of the table was dropped"] : []),
        corrected: () => `<p>second pass</p>`,
        recheck: () => ["the second column of the table is still missing"],
      }),
    );
    const rechecks = of(events, "page_correction_recheck");
    assert.equal(rechecks.length, 1);
    assert.equal(rechecks[0].ok, false);
    assert.deepEqual(rechecks[0].problems, ["the second column of the table is still missing"]);
    // The measurement is measurement only. A verify-driven correction is accepted
    // exactly as it was before this event existed — whether to re-render until a page
    // passes is a policy question the rate has to answer first.
    assert.match(result.fragments[0].innerHtml, /second pass/);
    assert.equal(of(events, "page_corrected")[0].result, "kept");
  });
});

test("a link-driven correction's own re-verification is logged as the binding one", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const link = { text: "the full report", href: "https://example.org/report" };
    // The page passes its fidelity check but dropped the link, so the correction runs
    // for a reason the Feedback Agent never named — and that path already re-verifies,
    // because a rewrite of a page that had passed has to earn its place.
    const result = await runExtraction(
      makeCtx(dir, events, {
        html: () => `<p>Read the full report</p>`,
        problems: () => [],
        corrected: () => `<p>Read <a href="https://example.org/report">the full report</a></p>`,
        recheck: () => [],
        links: [link],
      }),
    );
    const corrected = of(events, "page_corrected");
    assert.equal(corrected.length, 2, "both pages dropped the link, so both were corrected");
    assert.equal(corrected[0].trigger, "links");
    assert.equal(corrected[0].result, "kept");
    assert.equal(corrected[0].structure_changed, true);
    const rechecks = of(events, "page_correction_recheck");
    // Two, not one: these are not the sample. The links path pays for its own
    // re-verification because it decides whether to keep the rewrite.
    assert.equal(rechecks.length, 2);
    assert.deepEqual(rechecks.map((r) => r.binding), [true, true]);
    assert.match(result.fragments[0].innerHtml, /href="https:\/\/example\.org\/report"/);
  });
});

test("a provider error on the sample costs the measurement, not the page", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The sampled recheck is one more Feedback Agent call, and `verifyAgentOutput` is
    // non-blocking only for an absent agent and an unparseable reply — a provider error is
    // rethrown. Uncaught, it would leave extractPage through the per-page catch and ship a
    // `@page-failed` marker for a page that had rendered, verified AND corrected: a whole
    // page of accessible content lost to a measurement that decides nothing.
    const result = await runExtraction(
      makeCtx(dir, events, {
        html: () => `<p>first pass</p>`,
        problems: () => ["a figure is missing its caption"],
        corrected: (o) => `<p>first pass</p><figcaption>Figure ${o}</figcaption>`,
        recheckThrows: true,
      }),
    );
    // Both pages are delivered, corrected, and neither carries a failure marker.
    assert.equal(result.failedPages.length, 0);
    for (const f of result.fragments) assert.match(f.innerHtml, /<figcaption>/);
    assert.doesNotMatch(result.fragments.map((f) => f.innerHtml).join(""), /@page-failed/);
    // The sample is recorded as not taken, rather than silently absent, and there is no
    // verdict for it.
    const missed = of(events, "page_correction_recheck_failed");
    assert.equal(missed.length, 1);
    assert.match(String(missed[0].error), /ThrottlingException/);
    assert.equal(of(events, "page_correction_recheck").length, 0);
    // And the slot stays spent: a throttled provider is not asked again for every
    // corrected page in the batch.
    assert.equal(of(events, "page_corrected").length, 2);
  });
});

test("a page that passed and kept its links costs no correction and no event", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    await runExtraction(
      makeCtx(dir, events, {
        html: () => `<p>Clean</p>`,
        problems: () => [],
        corrected: () => `<p>should never be asked for</p>`,
      }),
    );
    assert.equal(of(events, "page_verify_ok").length, 2);
    assert.equal(of(events, "page_corrected").length, 0);
    assert.equal(of(events, "page_correction_recheck").length, 0);
  });
});
