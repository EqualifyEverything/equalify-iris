// Issue #182: `verify_failed` was 74 of 94 pages in one benchmark round and 76 of 100 in
// another, and nothing in the log said what those pages had wrong with them. A page that lost
// three table rows and a page whose alt text was refined from "orange kayak" to
// "orange-yellow kayak" wrote the same `page_verify_failed` line, so the count could not be
// read as an accuracy signal at all — only as the number of pages the verifier had an opinion
// about.
//
// VERIFY now tags each problem with one of five kinds (agents/feedback.md), and the verdict
// carries the distinct set. This file pins the two halves that are code: how a reply is read
// into that set, and how a log of those lines folds into `verification.verify_kinds`.
//
// The reading is deliberately forgiving in one direction only. A tag is a label on a problem,
// so a tag this code cannot understand must never remove the PROBLEM — that would turn a page
// the verifier rejected into a page that shipped unquestioned, which is the whole page against
// a lost label. Every case below where something is unrecognizable therefore keeps the prose
// and gives up only the kind, and `untagged` counts what was given up so a split can never be
// mistaken for a split of the whole run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyAgentOutput, VERIFY_KINDS, type VerifyVerdict } from "../src/pipeline/feedback.ts";
import { summarizeRun } from "../src/diagnostics.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";
import { loadAgent } from "../src/agents/loader.ts";

// One VERIFY call against a canned reply. The reply is the raw text the Feedback Agent would
// have returned, so a test can hand over a shape no typed helper would let it build — which
// is the point: every shape below has been a real model reply somewhere in this project's
// logs, and the ones that have not are the ones a future model will invent.
async function verdict(reply: string): Promise<VerifyVerdict> {
  const dir = mkdtempSync(join(tmpdir(), "iris-verify-kinds-"));
  try {
    const agentsDir = join(dir, "agents");
    const inputDir = join(dir, "input");
    for (const d of [agentsDir, inputDir]) mkdirSync(d, { recursive: true });
    writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
    writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\nvision\n");
    writeFileSync(join(inputDir, "page-001.png"), "not-a-real-png");
    const ctx = {
      sessionId: "ses_test",
      paths: {
        agentsDir,
        tmpAgentsDir: () => join(dir, "tmp-agents"),
      } as unknown as Paths,
      router: { complete: async () => ({ text: reply }) },
      log: { event: () => {}, agentCall: () => {} },
    } as unknown as PipelineContext;
    const page = loadAgent("page", { agentsDir, tmpAgentsDir: join(dir, "tmp-agents") });
    assert.ok(page, "the fixture page agent should load");
    return await verifyAgentOutput(
      ctx,
      page,
      { name: "page-001.png", order: 1, path: join(inputDir, "page-001.png"), links: [] },
      [{ html: "<p>x</p>" }],
      "verify",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tagged = (...problems: { kind: string; problem: string }[]): string =>
  JSON.stringify({ faithful: false, accessible: false, problems });

test("the current contract: each problem's kind, as a distinct set in severity order", async () => {
  // Named by the agent in the order it noticed them; reported in `VERIFY_KINDS` order, so a
  // fold over a fleet of runs is comparing the same list positions every time.
  const v = await verdict(
    tagged(
      { kind: "alt_quality", problem: "the alt text omits that the paddler faces away" },
      { kind: "content_missing", problem: "the last three rows of the totals table are absent" },
    ),
  );
  assert.equal(v.ok, false);
  assert.deepEqual(v.kinds, ["content_missing", "alt_quality"]);
  assert.equal(v.untagged, 0);
  // The prose is untouched: it is what the correction pass is given, and a correction prompt
  // wants the sentence rather than the label.
  assert.deepEqual(v.problems, [
    "the alt text omits that the paddler faces away",
    "the last three rows of the totals table are absent",
  ]);
});

test("two problems of one kind are one kind: this counts what the PAGE lost", async () => {
  const v = await verdict(
    tagged(
      { kind: "content_missing", problem: "the totals row is absent" },
      { kind: "content_missing", problem: "the footnote under the table is absent" },
      { kind: "content_missing", problem: "the figure has no description at all" },
    ),
  );
  assert.deepEqual(v.kinds, ["content_missing"]);
  assert.equal(v.problems.length, 3, "the correction is still told all three");
});

test("the old contract still reads: plain strings are problems with no kind", async () => {
  // An agent file that predates the kinds, a session-built agent, a trained one whose
  // contract was rewritten without them, or a model that answered in strings anyway. All of
  // them still name real problems, and a page that fails must still be corrected.
  const v = await verdict(
    JSON.stringify({
      faithful: false,
      accessible: true,
      problems: ["a column of the table was dropped", "the heading level skips one"],
    }),
  );
  assert.equal(v.ok, false);
  assert.deepEqual(v.problems, ["a column of the table was dropped", "the heading level skips one"]);
  assert.deepEqual(v.kinds, [], "no kind was named, and none is guessed from the prose");
  assert.equal(v.untagged, 2);
});

test("a partly tagged reply is counted on both sides, not rounded to either", async () => {
  const v = await verdict(
    JSON.stringify({
      faithful: false,
      accessible: false,
      problems: [
        { kind: "structure_wrong", problem: "the table is marked up as divs" },
        "the second column is missing",
      ],
    }),
  );
  assert.deepEqual(v.kinds, ["structure_wrong"]);
  assert.equal(v.untagged, 1, "one problem carried no kind, and the line has to say so");
  assert.equal(v.problems.length, 2);
});

test("a kind written the way a model writes it is still that kind", async () => {
  // Hyphens, capitals and stray whitespace are typing, not a different judgement. Anything
  // that is not one of the five after that is a kind this code does not know — including one
  // that would be a live JavaScript property name if these were looked up rather than matched.
  const v = await verdict(
    tagged(
      { kind: "Content-Missing", problem: "the totals row is absent" },
      { kind: " ALT QUALITY ", problem: "the description could be better" },
      { kind: "severity: high", problem: "the page is a mess" },
      { kind: "constructor", problem: "the heading is a bold paragraph" },
    ),
  );
  assert.deepEqual(v.kinds, ["content_missing", "alt_quality"]);
  assert.equal(v.untagged, 2, "the two unrecognized kinds are untagged, not new buckets");
  assert.equal(v.problems.length, 4, "and all four problems still reach the correction");
});

test("an entry whose prose this cannot find is kept, not lost", async () => {
  // The rule that matters most here: a problem entry in a shape this code did not expect is
  // still a problem the verifier named. Dropping it would leave `problems` empty, and an
  // empty list is what `failedCheck` reads as "nothing actionable" — so the page would ship
  // with the defect and a verdict that said so. Kept as its own JSON instead, which is at
  // least readable in the correction prompt, unlike the "[object Object]" a plain join gave.
  const v = await verdict(
    JSON.stringify({
      faithful: false,
      accessible: false,
      problems: [{ kind: "content_wrong", detail: "the Alabama total reads 1,204 and prints 1,240" }],
    }),
  );
  assert.equal(v.problems.length, 1);
  assert.match(v.problems[0]!, /Alabama/, "the text the agent did write survives");
  assert.deepEqual(v.kinds, ["content_wrong"], "and the kind beside it is still usable");
  assert.equal(v.untagged, 0);
});

test("the other prose keys a model reaches for are read as the problem", async () => {
  const v = await verdict(
    JSON.stringify({
      faithful: false,
      accessible: false,
      problems: [
        { kind: "a11y_only", text: "the link is named \"here\"" },
        { kind: "structure_wrong", description: "the reading order puts the caption first" },
      ],
    }),
  );
  assert.deepEqual(v.problems, ['the link is named "here"', "the reading order puts the caption first"]);
  assert.deepEqual(v.kinds, ["structure_wrong", "a11y_only"]);
  assert.equal(v.untagged, 0);
});

test("a null entry is not a problem, and a `problems` that is not a list is not a crash", async () => {
  // The shape that took down a whole run in issue #186's sibling case: `.map` on a string.
  // Here it must cost nothing at all — a reply that names no readable problem leaves the page
  // as it is, which is the rule `failedCheck` has always applied to a verdict that set a flag
  // and named nothing.
  const nulls = await verdict(JSON.stringify({ faithful: false, accessible: false, problems: [null, null] }));
  assert.deepEqual(nulls.problems, []);
  assert.deepEqual(nulls.kinds, []);
  assert.equal(nulls.untagged, 0, "nothing was named, so nothing went untagged");

  const notAList = await verdict(JSON.stringify({ faithful: false, accessible: false, problems: "none" }));
  assert.deepEqual(notAList.problems, []);
  assert.deepEqual(notAList.kinds, []);
  assert.equal(notAList.untagged, 0);
});

test("a passing page carries an empty set, and an unreadable reply is still non-blocking", async () => {
  const pass = await verdict(JSON.stringify({ faithful: true, accessible: true, problems: [] }));
  assert.equal(pass.unjudged, undefined, "a real verdict carries no flag");
  assert.deepEqual(pass, { ok: true, problems: [], kinds: [], untagged: 0 });

  // No JSON at all: verification is non-blocking, and that has not changed. What the flag
  // adds is that the two lines above and below now say different things — a page that
  // passed, and a page nobody could read a verdict about. `ok` is true in both, because
  // nothing in a run may be costed on a reply the model garbled; `unjudged` is how a
  // measurement OF the verifier tells them apart (issue #180, src/pipeline/calibration.ts).
  const prose = await verdict("I was unable to compare the HTML with the image.");
  assert.deepEqual(prose, { ok: true, problems: [], kinds: [], untagged: 0, unjudged: true });
});

// --- the fold (src/diagnostics.ts) ------------------------------------------

const T = (s: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const log = (...events: Record<string, unknown>[]): string => events.map((e) => JSON.stringify(e)).join("\n");
const done = (now: number) => ({ sessionId: "s", status: "ready_for_review", phase: "done", now });

test("the tally splits verify_failed by kind, in pages, and does not partition", () => {
  const text = log(
    { ts: T(0), type: "run_start" },
    { ts: T(1), type: "page_verify_ok", image: "page-001.png" },
    // One page, two kinds: it counts in both, which is why these do not sum to `verify_failed`.
    { ts: T(2), type: "page_verify_failed", image: "page-002.png", untagged: 0,
      problems: ["the totals row is absent", "the alt text is thin"],
      kinds: ["content_missing", "alt_quality"] },
    // One page, one kind, named twice: still one page.
    { ts: T(3), type: "page_verify_failed", image: "page-003.png", untagged: 0,
      problems: ["a row is absent", "a caption is absent"], kinds: ["content_missing"] },
    { ts: T(4), type: "run_complete" },
  );
  const d = summarizeRun(text, done(Date.parse(T(4))));
  assert.equal(d.verification.pages_verified, 3);
  assert.equal(d.verification.verify_failed, 2);
  assert.deepEqual(d.verification.verify_kinds, {
    content_missing: 2, content_wrong: 0, structure_wrong: 0, a11y_only: 0, alt_quality: 1, untagged_pages: 0,
  });
  assert.equal(d.verification.verify_untagged_problems, 0, "every problem on both lines carried a kind");
});

test("a log that names no kind is untagged, not clean and not spread across the buckets", () => {
  // Every log written before this existed, and every run against an agent file whose VERIFY
  // contract does not mention kinds. The pages are in `verify_failed` and in no kind, and
  // `untagged` is the only field that would tell a reader the split covers none of them.
  const text = log(
    { ts: T(0), type: "run_start" },
    { ts: T(1), type: "page_verify_failed", image: "page-001.png", problems: ["the alt text is thin"] },
    { ts: T(2), type: "page_verify_failed", image: "page-002.png", problems: ["a table row is missing"] },
    { ts: T(3), type: "run_complete" },
  );
  const d = summarizeRun(text, done(Date.parse(T(3))));
  assert.equal(d.verification.verify_failed, 2);
  assert.deepEqual(d.verification.verify_kinds, {
    content_missing: 0, content_wrong: 0, structure_wrong: 0, a11y_only: 0, alt_quality: 0, untagged_pages: 2,
  });
  // No `untagged` field at all on either line, so the problems each one lists are the untagged
  // ones: an old log's problems are untagged by definition, and counting zero would read as a
  // fully tagged run.
  assert.equal(d.verification.verify_untagged_problems, 2);
});

test("a page that tagged some of its problems is in its kind AND in untagged", () => {
  const text = log(
    { ts: T(0), type: "run_start" },
    { ts: T(1), type: "page_verify_failed", image: "page-001.png", untagged: 2,
      problems: ["the table is divs", "something else", "and another"], kinds: ["structure_wrong"] },
    // A kind no version of this reader knows, including one that names a function on
    // Object.prototype — matched against the closed list, so it lands nowhere but `untagged`.
    { ts: T(2), type: "page_verify_failed", image: "page-002.png", untagged: 0,
      problems: ["the page is a mess"], kinds: ["toString", "urgent"] },
    { ts: T(3), type: "run_complete" },
  );
  const d = summarizeRun(text, done(Date.parse(T(3))));
  assert.deepEqual(d.verification.verify_kinds, {
    content_missing: 0, content_wrong: 0, structure_wrong: 1, a11y_only: 0, alt_quality: 0, untagged_pages: 2,
  });
  // Two pages, three untagged problems: the second line named a kind for none of its one
  // problem and the first named one for one of its three. Both pages are in `untagged_pages`,
  // and only this number says the first page's split is mostly there and the second's is not.
  assert.equal(d.verification.verify_untagged_problems, 3);
});

test("the tally's buckets are the agent's five kinds, and nothing else", () => {
  // src/diagnostics.ts declares its own copy of the list, the way it declares its own
  // `CORRECTION_RESULTS` — it reads a log file and depends on nothing else. This is what
  // holds the two copies equal: a kind added to the contract and not to the fold would show
  // up here as a bucket the tally has no key for.
  const d = summarizeRun(log({ ts: T(0), type: "run_start" }), done(Date.parse(T(0))));
  assert.deepEqual(Object.keys(d.verification.verify_kinds), [...VERIFY_KINDS, "untagged_pages"]);
});
