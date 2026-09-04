// A page the agent declared blank used to be sent to the Feedback Agent anyway: the verifier was
// shown the source image and an empty code block and asked whether the one was faithful to the
// other. It passed every time it was asked — 36 judgements, 9 blank pages of a 100-page corpus,
// two page-model arms, two commits — for $0.0859 per arm, which is 0.77% of the deployed lineup's
// bill and 1.33% of the cheaper one the sprint is heading for (issue #294). A per-image cost does
// not shrink as models get cheaper, so the share grows.
//
// What these tests pin is the shape of the saving rather than the saving itself, because the part
// that could go wrong is not the arithmetic:
//
//   * the call is not made, and the run SAYS it was not made rather than reporting a pass. A
//     skipped page that reads as `page_verify_ok` would put pages nothing looked at into every
//     pass rate computed off these logs, which is the failure `unjudged` was added for (#211).
//   * the free checks still run. A blank page carrying link annotations is a page the FILE says
//     has content on it, and that is caught by code, costs nothing, and still buys a correction.
//     That detector is the reason the skip is safe to take without the model call.
//   * nothing else changed: a page with content on it is still verified, and a blank page still
//     ships as an empty fragment with `page_blank` on the log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExtraction } from "../src/pipeline/extraction.ts";
import { summarizeRun } from "../src/diagnostics.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";
import type { PdfLink } from "../src/util/pdf.ts";

interface Event {
  type: string;
  [k: string]: unknown;
}

interface Recorded {
  events: Event[];
  // Every model call, as `${step}:${page}` — the two facts a saving is counted in. `step` and not
  // the agent name: the verify call and the correction recheck are the same agent (#281).
  calls: string[];
  // The output ceiling each `correct` call asked for, in order. Only the correction is capped
  // (#285), and on a blank page there is no first pass to take a cap from.
  caps: (number | undefined)[];
  // The `user` message of every verify call, in order. Optional, and collected only by the tests that
  // are about what the JUDGE was told rather than about whether it was called (#371): a caution is only
  // worth adding if it reaches the message, and `page_blank`'s fields cannot show that.
  verifyUsers?: string[];
}

const BLANK = JSON.stringify({ html: "", log: "This page is blank." });
const good = (order: number): string => JSON.stringify({ html: `<p>page ${order}</p>`, log: "" });

// Three pages, the middle one blank unless a test says otherwise. `links` is per page so the
// annotated-blank-page case can be built without touching the rest.
function makeCtx(
  dir: string,
  rec: Recorded,
  opts: {
    render?: (order: number) => string;
    links?: (order: number) => PdfLink[];
    // The verdict for a page that IS verified. Empty means faithful.
    problems?: (order: number) => string[];
    correct?: (order: number) => string;
    feedback?: boolean;
  } = {},
): PipelineContext {
  const agentsDir = join(dir, "agents");
  const fragDir = join(dir, "fragments");
  const inputDir = join(dir, "input");
  for (const d of [agentsDir, fragDir, inputDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
  // Present by default: with no feedback.md `verifyAgentOutput` short-circuits to unjudged for
  // EVERY page, and a test that cannot tell that apart from the skip proves nothing.
  if (opts.feedback !== false) {
    writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\nvision\n");
  }
  const names = ["page-001.png", "page-002.png", "page-003.png"];
  for (const n of names) writeFileSync(join(inputDir, n), "not-a-real-png");
  const orderOf = (user: string): number => names.findIndex((n) => user.includes(n)) + 1;
  const render = opts.render ?? ((o: number) => (o === 2 ? BLANK : good(o)));

  return {
    sessionId: "ses_test",
    images: names.map((name, i) => ({
      name,
      order: i + 1,
      path: join(inputDir, name),
      links: opts.links?.(i + 1) ?? [],
    })),
    extractionConcurrency: 3,
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
        o: { step: string; maxOutputTokens?: number },
      ) => {
        const user = messages.find((m) => m.role === "user")?.content ?? "";
        const order = orderOf(user);
        rec.calls.push(`${o.step}:${order}`);
        if (o.step === "correct") rec.caps.push(o.maxOutputTokens);
        if (user.includes("TASK: verify")) {
          rec.verifyUsers?.push(user);
          const problems = (opts.problems ?? (() => []))(order);
          return { text: JSON.stringify({ faithful: problems.length === 0, accessible: true, problems }) };
        }
        if (user.includes("had fidelity/accessibility problems")) {
          return { text: (opts.correct ?? ((o2: number) => JSON.stringify({ html: `<p>fixed ${o2}</p>` })))(order) };
        }
        // `usage` on the render and nowhere else, because the correction's cap is derived from what
        // the FIRST pass spent (#285): without it every cap is `undefined` for the uninteresting
        // reason that nothing was measured, and the caps asserted below would say nothing.
        return { text: render(order), usage: { output_tokens: 40 } };
      },
    },
    log: {
      event: (type: string, fields: Record<string, unknown> = {}) => rec.events.push({ type, ...fields }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iris-blankskip-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const of = (rec: Recorded, type: string): Event[] => rec.events.filter((e) => e.type === type);

// `summarizeRun` reads a log FILE, so the events are handed to it the way a run writes them — one
// JSON object per line — rather than as the array this harness collected. Going through the parser is
// the point: the fold reads `skipped` off a line, and a test that skipped the serialisation could not
// catch a field that never reaches the file.
const fold = (rec: Recorded) =>
  summarizeRun(rec.events.map((e) => JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", ...e })).join("\n"), {
    sessionId: "ses_test",
    status: "ready_for_review",
    phase: "review",
    now: Date.parse("2026-01-01T00:01:00.000Z"),
  });

test("a page declared blank is not verified, and the run says so rather than reporting a pass", async () => {
  await withTemp(async (dir) => {
    const rec: Recorded = { events: [], calls: [], caps: [] };
    const { fragments } = await runExtraction(makeCtx(dir, rec));
    // The saving: three pages extracted, two verified.
    assert.deepEqual(rec.calls.filter((c) => c.startsWith("extract:")).sort(), ["extract:1", "extract:2", "extract:3"]);
    assert.deepEqual(rec.calls.filter((c) => c.startsWith("verify:")).sort(), ["verify:1", "verify:3"]);
    assert.equal(rec.calls.includes("verify:2"), false, "the blank page's verify call is the whole point");

    // And it is a page nothing judged, not a page that passed. `unjudged` keeps it out of any pass
    // rate; `skipped` says the call was not bought rather than could not be made, which is the
    // difference between this saving and a Feedback Agent that would not load.
    const ok = of(rec, "page_verify_ok");
    assert.deepEqual(ok.map((e) => e.image).sort(), ["page-001.png", "page-002.png", "page-003.png"]);
    const blankLine = ok.find((e) => e.image === "page-002.png")!;
    assert.equal(blankLine.unjudged, true);
    assert.equal(blankLine.skipped, "blank");
    // The pages that WERE judged carry neither field: a log full of `unjudged: false` says nothing,
    // and a `skipped` on a page that was verified would be a line contradicting itself.
    for (const image of ["page-001.png", "page-003.png"]) {
      const line = ok.find((e) => e.image === image)!;
      assert.equal("unjudged" in line, false, image);
      assert.equal("skipped" in line, false, image);
    }

    // Nothing about the page itself changed: still declared blank, still an empty fragment, still
    // not a failure.
    assert.deepEqual(of(rec, "page_blank").map((e) => e.page), [2]);
    assert.equal(of(rec, "page_extraction_failed").length, 0);
    assert.equal(fragments.find((f) => f.order === 2)!.innerHtml, "");
  });
});

test("the skipped page is counted, so a saving cannot be read as a broken verifier", async () => {
  await withTemp(async (dir) => {
    const rec: Recorded = { events: [], calls: [], caps: [] };
    await runExtraction(makeCtx(dir, rec));
    const { verification, pages_blank } = fold(rec);
    // A subset of a subset: the blank page is still in `pages_verified`, so the number every
    // published round is compared on does not move, and it is in `pages_unjudged`, so it is out of
    // `verify_failed / (pages_verified - pages_unjudged)`.
    assert.equal(verification.pages_verified, 3);
    assert.equal(verification.pages_unjudged, 1);
    assert.equal(verification.pages_skipped_blank, 1);
    assert.equal(verification.verify_failed, 0);
    // Which is what makes the two cases distinguishable at all. Same three pages, no Feedback
    // Agent: every page is unjudged, and the blank one is still the only SKIP, because the skip is a
    // decision this pipeline made and the other two are a verifier that could not be loaded.
    //
    // So `pages_skipped_blank` is a count of calls not bought, and it is only a count of MONEY not
    // spent where there was a verifier to spend it on — on this run there was not. The equality
    // `pages_unjudged == pages_verified` is consistent with that and does not prove it: a run whose
    // Feedback Agent loaded and whose every verify reply failed to parse produces the same two
    // numbers with the calls bought and paid for. What settles it is that no verify call was made at
    // all, which is asserted below and is `by_step.verify` on a real run's diagnostics. Making the
    // flag conditional on a loaded Feedback Agent was the alternative and it is worse: it would make
    // the field mean two things at once and put a disk check in extraction.ts to decide a label.
    //
    // Its own directory, not this one: `makeCtx` writes `agents/feedback.md` and cannot unwrite it,
    // so a second context built over the same temp dir would still find the first one's Feedback
    // Agent and verify two of the three pages.
    const none: Recorded = { events: [], calls: [], caps: [] };
    await withTemp(async (bare) => runExtraction(makeCtx(bare, none, { feedback: false })));
    const broken = fold(none).verification;
    assert.equal(broken.pages_verified, 3);
    assert.equal(broken.pages_unjudged, 3);
    assert.equal(broken.pages_skipped_blank, 1);
    assert.equal(none.calls.filter((c) => c.startsWith("verify:")).length, 0);
    // The blank page is on the record either way, which is the evidence a wrong declaration leaves
    // now that no verdict is bought for it.
    assert.deepEqual(pages_blank, [2]);
  });
});

test("a blank page the FILE says has a link on it is still corrected, without the verifier", async () => {
  await withTemp(async (dir) => {
    // The case that makes the skip safe to take: the page came back empty and the source file
    // carries a link annotation for it, so the document itself contradicts the declaration. That
    // comparison is exact, costs nothing, and is not the Feedback Agent's to make — it verifies
    // against the IMAGE, where a link target does not appear at all.
    const rec: Recorded = { events: [], calls: [], caps: [] };
    const link: PdfLink = { text: "Annual Report", href: "https://example.gov/report.pdf" };
    const { fragments } = await runExtraction(
      makeCtx(dir, rec, {
        links: (o) => (o === 2 ? [link] : []),
        correct: () => JSON.stringify({ html: `<p><a href="${link.href}">Annual Report</a></p>` }),
      }),
    );
    // Still no verify call on it — the skip is unconditional on the declaration, not on the links.
    assert.equal(rec.calls.includes("verify:2"), false);
    // But the correction IS bought, on the links trigger, and it recovers the page.
    assert.deepEqual(of(rec, "page_links_missing").map((e) => e.image), ["page-002.png"]);
    // Counted by step, not by page: the correction prompt is the one page call that does not name
    // the image file (it sends the previous output and the problem list), so this harness cannot
    // attribute it from the message. `page_corrected` below is where the page number lives.
    assert.equal(rec.calls.filter((c) => c.startsWith("correct:")).length, 1, "a blank page with a link is re-rendered");
    const corrected = of(rec, "page_corrected");
    assert.deepEqual(corrected.map((e) => e.trigger), ["links"]);
    assert.match(String(fragments.find((f) => f.order === 2)!.innerHtml), /href="https:\/\/example\.gov\/report\.pdf"/);
    // And the recovered fragment is verified in turn, because the check had not failed — so the page
    // that came back from a wrong blank declaration is the one page here that gets TWO verdicts'
    // worth of scrutiny, and the skip did not reduce it to none.
    assert.equal(rec.calls.includes("recheck_binding:2"), true);
    // That re-render asks for no output ceiling of its own, and this is the one repair where that
    // matters. The correction cap is `2x` the first pass with a 4,000-token floor (#285), and a
    // page declared blank rendered NOTHING: the cap would be the bare floor, about 16,000
    // characters of HTML on the measured 2.31 chars/token, which is less than one dense page (this
    // corpus has a 17,721-character one). A truncated reply is discarded, so a cap taken from the
    // reply that got the page wrong would lose the page in exactly the case the skip above relies
    // on this repair to catch. A first pass is bounded by the deployment, and this is a first pass.
    assert.deepEqual(rec.caps, [undefined], "the blank page's re-render is not capped by its own empty render");
  });
});

test("a page with content on it is verified exactly as it always was", async () => {
  await withTemp(async (dir) => {
    // The regression the skip could plausibly cause: `blank` is a flag on a render, and a flag read
    // one page too widely would stop verifying the document. Two of these pages are ordinary and
    // one of them fails its check, which is the path the skip must not touch.
    const rec: Recorded = { events: [], calls: [], caps: [] };
    await runExtraction(
      makeCtx(dir, rec, {
        render: good,
        problems: (o) => (o === 3 ? ["The second table row is missing."] : []),
      }),
    );
    assert.deepEqual(rec.calls.filter((c) => c.startsWith("verify:")).sort(), ["verify:1", "verify:2", "verify:3"]);
    assert.equal(of(rec, "page_verify_ok").length, 2);
    assert.deepEqual(of(rec, "page_verify_failed").map((e) => e.image), ["page-003.png"]);
    assert.equal(rec.calls.filter((c) => c.startsWith("correct:")).length, 1);
    // And the other side of the uncapped blank re-render above: an ordinary page's correction is
    // still capped from its own first pass, which is the whole of #285. Only a page that rendered
    // nothing is exempt.
    assert.equal(typeof rec.caps[0], "number", "a page with content still caps its correction");
    const { verification } = fold(rec);
    assert.equal(verification.pages_skipped_blank, 0, "no page was declared blank, so nothing was skipped");
    assert.equal(verification.pages_unjudged, 0);
  });
});

// The reply can now STATE blankness in a field instead of leaving it to be read out of a sentence
// (#371). The saving above is unchanged by that — a stated blank is a blank page and buys no verdict —
// but the field adds one page that IS judged, and these two tests are the pair: which of them a reply
// gets, and what the judgement it buys is told.
const STATED = JSON.stringify({ html: "", log: "This page is blank.", blank: true });
const STATED_CONTRADICTED = JSON.stringify({
  html: "",
  log: "Page is blank. A heading is visible at the top.",
  blank: true,
});

test("a page that states blankness in the field costs no more than one that said it in prose", async () => {
  await withTemp(async (dir) => {
    const rec: Recorded = { events: [], calls: [], caps: [] };
    await runExtraction(makeCtx(dir, rec, { render: (o) => (o === 2 ? STATED : good(o)) }));
    assert.equal(rec.calls.includes("verify:2"), false, "the saving is the same saving");
    assert.deepEqual(rec.calls.filter((c) => c.startsWith("verify:")).sort(), ["verify:1", "verify:3"]);
    // And the run can count how often the field is actually used, which is the thing #371 turns on:
    // `blank_stated` says this declaration came from the field rather than from the prose read, and
    // the two behave differently from here on, so a log that could not tell them apart could not price
    // either. The `skipped` line is unchanged, because the page is unchanged.
    const blankLine = of(rec, "page_blank")[0];
    assert.equal(blankLine.page, 2);
    assert.equal(blankLine.blank_stated, true);
    assert.equal("blank_contradicted" in blankLine, false, "nothing in this log claims anything is on the page");
    const ok = of(rec, "page_verify_ok").find((e) => e.image === "page-002.png")!;
    assert.equal(ok.skipped, "blank");
    assert.equal(fold(rec).verification.pages_skipped_blank, 1);
    // A prose declaration carries no such field, so the flag reads as the question it looks like.
    const plain: Recorded = { events: [], calls: [], caps: [] };
    await withTemp(async (other) => runExtraction(makeCtx(other, plain)));
    assert.equal("blank_stated" in of(plain, "page_blank")[0], false);
  });
});

test("a stated blank its own log contradicts is judged, and the judge is shown the contradiction", async () => {
  await withTemp(async (dir) => {
    // #371's third answer. Before the field there were two: believe the prose and drop the page in
    // silence (#194's loss), or refuse it and report a page nobody has. Where the reply STATES the page
    // is empty and its log names a heading on it, the page can be delivered AND looked at — so a log
    // that was right buys a correction, and a log the regex misread costs a verify call instead of a
    // page. The one such declaration in the whole bench corpus is the second kind.
    const rec: Recorded = { events: [], calls: [], caps: [], verifyUsers: [] };
    const { fragments, failedPages } = await runExtraction(
      makeCtx(dir, rec, {
        render: (o) => (o === 2 ? STATED_CONTRADICTED : good(o)),
        problems: (o) => (o === 2 ? ["The page has a heading on it. The output has nothing."] : []),
        correct: () => JSON.stringify({ html: "<h2>Appendix B</h2>" }),
      }),
    );
    // The page is not a loss, and it is not a skip either: it is the one blank page that buys a verdict.
    assert.deepEqual(failedPages, []);
    assert.equal(rec.calls.includes("verify:2"), true);
    // And the arithmetic docs/API.md §7b now states off these two counts: the declarations that cost a
    // verify call are `pages_blank - pages_skipped_blank`, which is this page and only this page.
    const folded = fold(rec);
    assert.equal(folded.verification.pages_skipped_blank, 0, "a contradicted declaration is not a saving");
    assert.deepEqual(folded.pages_blank, [2], "it is still a blank page, and still counted as one");
    const ok = of(rec, "page_verify_ok").map((e) => e.image);
    assert.equal(ok.includes("page-002.png"), false, "it failed its check rather than skipping one");
    assert.deepEqual(of(rec, "page_verify_failed").map((e) => e.image), ["page-002.png"]);
    // And the verdict recovers the page, which is the whole reason to spend the call.
    assert.deepEqual(of(rec, "page_corrected").map((e) => e.page), [2]);
    assert.match(String(fragments.find((f) => f.order === 2)!.innerHtml), /Appendix B/);
    // What the judge was TOLD. Without this the call asks whether an empty fragment is faithful to the
    // image — the question answered "no problems" on all 36 blank pages it was ever put (#294) — so the
    // contradiction rides in the caution channel, in the log's own words, as something the agent under
    // test said about its own output.
    const asked = rec.verifyUsers!.find((u) => u.includes("page-002.png"))!;
    assert.match(asked, /returned NO page for this image/);
    assert.match(asked, /"heading is visible"/);
    assert.match(asked, /disagree about whether this page has anything on it/);
    // And nothing like it is sent for the ordinary pages, whose replies said nothing of the sort.
    for (const image of ["page-001.png", "page-003.png"]) {
      assert.equal(rec.verifyUsers!.find((u) => u.includes(image))!.includes("returned NO page"), false, image);
    }
    // The line a reader triages from, with both fields: the field was used, and the log contradicted
    // it. `blank_contradicted` is the same field name `page_no_output` carries for the refusal, so one
    // grep finds the pages this cost and the pages it did not.
    const blankLine = of(rec, "page_blank")[0];
    assert.equal(blankLine.blank_stated, true);
    assert.equal(blankLine.blank_contradicted, "heading is visible");
  });
});

test("a contradicted stated blank the verifier passes ships empty, and its line says it was judged", async () => {
  await withTemp(async (dir) => {
    // The other half of the branch above, and the case the change trades INTO: the verify call is
    // bought, the verifier looks at the image and the empty fragment and says the fragment is faithful.
    // Then the page ships empty and no marker in the document says a reader lost anything — the log's
    // named heading is simply unresolved. It is the shape docs/API.md §7b states as the invariant (a
    // contradicted stated blank carries no `skipped` on its own line), and it is only reachable on a
    // PASSING verdict, so the failing-verdict test above cannot pin it: `page_verify_failed` has no
    // `skipped` field to omit.
    const rec: Recorded = { events: [], calls: [], caps: [], verifyUsers: [] };
    const { fragments, failedPages } = await runExtraction(
      makeCtx(dir, rec, { render: (o) => (o === 2 ? STATED_CONTRADICTED : good(o)) }),
    );
    assert.equal(rec.calls.includes("verify:2"), true, "the call is bought whatever the answer is");
    // Judged, not skipped and not unjudged. A `skipped` here would put the page back in the saving it
    // is deliberately outside of, and an `unjudged` would keep a page a verdict WAS paid for out of
    // every pass rate computed off these logs — the two mistakes the fields exist to tell apart.
    const line = of(rec, "page_verify_ok").find((e) => e.image === "page-002.png")!;
    assert.equal("skipped" in line, false, "a page a verdict was bought for is not a skip");
    assert.equal("unjudged" in line, false, "and it is not unjudged either");
    assert.equal(of(rec, "page_verify_failed").length, 0);
    // Nothing was repaired, because nothing was found: the page is delivered as the empty fragment it
    // was declared as. This is the loss the design accepts in exchange for #194's page — stated on the
    // PR and in docs/API.md §7a — and the only evidence it leaves is the `page_blank` line's own
    // two fields.
    assert.equal(of(rec, "page_corrected").length, 0);
    assert.equal(fragments.find((f) => f.order === 2)!.innerHtml, "");
    assert.deepEqual(failedPages, [], "an empty page delivered is not a failed page, so no marker names it");
    const blankLine = of(rec, "page_blank")[0];
    assert.equal(blankLine.blank_stated, true);
    assert.equal(blankLine.blank_contradicted, "heading is visible");
    // And the arithmetic reads the same either way: the declaration cost a call, so it is not a saving.
    const { verification, pages_blank } = fold(rec);
    assert.equal(verification.pages_skipped_blank, 0);
    assert.equal(verification.pages_unjudged, 0);
    assert.equal(verification.pages_verified, 3);
    assert.deepEqual(pages_blank, [2]);
    // The judge was still told what the reply said about itself; a pass on a page nobody warned is a
    // different (and cheaper) event than a pass on a page the caution named.
    assert.match(rec.verifyUsers!.find((u) => u.includes("page-002.png"))!, /returned NO page for this image/);
  });
});
