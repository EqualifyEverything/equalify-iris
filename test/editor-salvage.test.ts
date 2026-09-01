// A truncated Copy Editor round was thrown away unread, and it is the largest measured waste in
// the pipeline: 24 truncated editor calls across 10 deployment rounds, $17.23 of a $158.67 bill,
// every dollar of it spent on a response nothing looked at (issue #295). The reply is not nothing.
// The contract makes it a list of independent block edits (#250, pipeline/patch.ts), so a reply cut
// partway through the list still carries every edit the model finished writing — the one instrumented
// truncation in the bench logs names 17 blocks and stops mid-`<td>`.
//
// So the round now reads what it already paid for, and asks again only for the part the reply never
// reached. Three things are pinned here: what a prefix is allowed to be (util/json.ts's reader, and
// the four ways `salvageRound` refuses one), that the section calls see the REMAINDER and not the
// document, and that the delivered document says which half of it got which kind of correction.
//
// The two paths this sits in front of are unchanged and still pinned elsewhere: a reply with no
// usable prefix is sectioned whole (test/editor-sections.test.ts) and a round that rescues nothing
// is discarded (test/review-truncation.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readArrayPrefix } from "../src/util/json.ts";
import { splitBlocks, splitSections } from "../src/pipeline/sections.ts";
import {
  runReview,
  EDITOR_SECTION_SYSTEM,
  SECTION_HEADROOM,
  type ReviewIssue,
} from "../src/pipeline/review.ts";
import { TruncatedResponseError } from "../src/providers/types.ts";
import type { InputImage, PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// --- reading the prefix ---

test("the entries an array field finished are read out of a reply that stopped inside it", () => {
  const read = readArrayPrefix<{ block: number; html: string }>(
    `{"edits":[{"block":0,"html":"<p>a</p>"},{"block":2,"html":"<p>b</p>"},{"block":5,"html":"<p>`,
    "edits",
  );
  assert.deepEqual(read?.entries, [
    { block: 0, html: "<p>a</p>" },
    { block: 2, html: "<p>b</p>" },
  ]);
  // The entry that did not finish is not half an edit, and `closed` is what says so: the list
  // itself never ended, so nothing here knows what the model would have said next.
  assert.equal(read?.closed, false);
});

test("a list that closed is a complete answer, whatever the ceiling took afterwards", () => {
  // The cut fell in `fidelity_observed`, past the edits — so every block was considered and there
  // is nothing left to ask for. This is the difference `salvageRound` acts on and the reason the
  // reader reports it rather than only the entries.
  const read = readArrayPrefix<{ block: number }>(
    `{"edits":[{"block":0,"html":"<p>a</p>"}],"fidelity_observed":["the figures are as printed`,
    "edits",
  );
  assert.deepEqual(read?.entries, [{ block: 0, html: "<p>a</p>" }]);
  assert.equal(read?.closed, true);
  // An empty list that closed is an answer too: the editor changed nothing.
  assert.deepEqual(readArrayPrefix(`{"edits":[]}`, "edits"), { entries: [], closed: true });
});

test("a reply with no such field, and a field that is only quoted in one", () => {
  assert.equal(readArrayPrefix(`{"html":"<p>the whole document instead</p>"`, "edits"), null);
  assert.equal(readArrayPrefix(`I will now list the edits: `, "edits"), null);
  // A document that PRINTS the contract is not a document answering it — the key is inside a
  // string, so the backslash in front of it is what marks it as text.
  assert.equal(readArrayPrefix(`{"html":"<p>the reply is {\\"edits\\":[ … ]}</p>"}`, "edits"), null);
  // And the LAST occurrence wins, for the reason `extractJson` takes the last envelope: a model
  // that drafts before it answers writes the earlier list while thinking.
  const read = readArrayPrefix<{ block: number }>(
    `{"edits":[{"block":9,"html":"draft"}]} — on reflection: {"edits":[{"block":1,"html":"final"}]}`,
    "edits",
  );
  assert.deepEqual(read?.entries, [{ block: 1, html: "final" }]);
});

// --- the round ---

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iris-salvage-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ISSUES: ReviewIssue[] = [
  { issue: "table headers missing", severity: "high", suggested_action: "add th", pages: [2] },
  { issue: "reading order", severity: "medium", suggested_action: "reorder", pages: [1] },
];

const PAGES = [
  { order: 1, innerHtml: "<h1>Quarterly Report</h1>" },
  { order: 2, innerHtml: "<p>Revenue.</p>" },
];

// 24 top-level paragraphs, ~1kB each — the same body test/editor-sections.test.ts uses, so the two
// files describe one document taking two routes out of the same failure. Every paragraph is
// identifiable, which is what makes "this block carries the round's own correction and that one
// carries a section's" a thing a test can read off the delivered body.
const PARAS = Array.from({ length: 24 }, (_, i) => `<p id="p${i + 1}">${`word${i + 1} `.repeat(140)}</p>`);
const LONG = PARAS.join("\n\n");
const BLOCKS = splitBlocks(LONG);
// 20,000 characters came back before the ceiling cut it, so a section may be 10,000.
const CHARS = 20_000;
const BUDGET = Math.floor(CHARS * SECTION_HEADROOM);

// The editor's correction to one block: its own text with a marker in it. A correction has to keep
// the block's prose, and not because the fixture is being polite — a block handed back with less in
// it than it had may be the source half of a MOVE whose landing half is past the cut, so
// `salvageRound` refuses the whole prefix when it sees one (`loss_before_cut`, tested below).
const fixed = (i: number) => PARAS[i]!.replace("</p>", ` fixed ${i}</p>`);

// A reply that answered about `blocks` and then hit the ceiling. `closed` puts the cut past the
// edits list — a complete patch that ran out of room on its way out of the envelope — and otherwise
// the cut lands inside the next entry, which is the shape the logs hold.
//
// Padded to a length rather than left as short as its entries: `chars` is what the section budget is
// derived from, so a fixture whose length drifted with the number of blocks it names would change
// the sections under every test that varies the prefix.
function cutReply(blocks: number[], opts: { closed?: boolean; chars?: number } = {}): TruncatedResponseError {
  const entries = blocks.map((i) => JSON.stringify({ block: i, html: fixed(i) }));
  const head = `{"edits":[${entries.join(",")}`;
  const text = opts.closed
    ? `${head}],"fidelity_observed":["the table figures are as printed`.padEnd(opts.chars ?? CHARS, "x")
    : `${head},{"block":${Math.max(...blocks, -1) + 1},"html":"<p id="p`.padEnd(opts.chars ?? CHARS, "x");
  return new TruncatedResponseError("bedrock", "sonnet", 32_000, text);
}

interface Call {
  agent: string;
  system: string;
  user: string;
}
interface Recorded {
  calls: Call[];
  events: { type: string; data: Record<string, unknown> }[];
}

// The section text the editor is being asked about, read out of its own prompt.
function askedSection(user: string): { index: number; of: number; html: string } {
  const m = /^## Section (\d+) of (\d+) \(body content\)\n([\s\S]*?)\n\n## Issues/.exec(user);
  assert.ok(m, `not a section prompt: ${user.slice(0, 200)}`);
  return { index: Number(m[1]), of: Number(m[2]), html: m[3]! };
}

// `reply` is what the whole-document call does: a TruncatedResponseError is thrown, so every context
// here is one whose editor round did not fit — the state this file is about.
function ctxWith(
  dir: string,
  opts: {
    reply?: () => TruncatedResponseError;
    sectionAnswer?: (s: { index: number; of: number; html: string }) => string | Error | null;
  } = {},
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
    maxReviewIterations: 3,
    extractionConcurrency: 4,
    recheckSampleSize: 1,
    paths: {
      agentsDir: join(dir, "agents"),
      tmpAgentsDir: () => join(dir, "tmp-agents"),
      agentMemory: () => join(dir, "memory", "page.json"),
    } as unknown as Paths,
    router: {
      complete: async (agent: string, _cap: string, messages: { role: string; content: string }[]) => {
        const system = messages[0]?.content ?? "";
        const user = messages[messages.length - 1]?.content ?? "";
        rec.calls.push({ agent, system, user });
        // The Reader never runs out of issues, so the loop always reaches the editor.
        if (agent === "reader") return { text: JSON.stringify({ issues: ISSUES }) };
        if (system !== EDITOR_SECTION_SYSTEM) throw (opts.reply ?? (() => cutReply([0])))();
        const answer = (opts.sectionAnswer ?? ((s) => `${s.html}\n<p class="sec">section ${s.index}</p>`))(
          askedSection(user),
        );
        if (answer instanceof Error) throw answer;
        return { text: JSON.stringify(answer === null ? {} : { html: answer }) };
      },
    },
    log: {
      event: (type: string, data: Record<string, unknown> = {}) => rec.events.push({ type, data }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
  return { ctx, rec };
}

const review = (ctx: PipelineContext, body = LONG) =>
  runReview(ctx, { body, lint: { ok: true, violations: [] }, pages: PAGES });

// The blocks a reply naming 0..11 leaves behind: the tail of the body from block 12, character for
// character, which is what `splitBlocks`'s identity property guarantees can be cut out exactly.
const REACHED = 12;
const NAMED = Array.from({ length: REACHED }, (_, i) => i);
const REMAINDER = BLOCKS.slice(REACHED).map((b) => b.pre + b.html).join("");

test("what the reply reached is corrected by the reply, and only the rest is asked for again", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = ctxWith(dir, { reply: () => cutReply(NAMED) });
    const result = await review(ctx);

    // The prefix carries the editor's own whole-document corrections — made by a call that saw
    // every block and the page images — and nothing re-asked for them.
    for (const i of NAMED) assert.ok(result.body.includes(fixed(i)), `block ${i}'s own correction is missing`);
    // The remainder carries the section calls' corrections instead, and every paragraph in it
    // survived: a section nobody changed comes back byte for byte.
    const sections = rec.calls.filter((c) => c.system === EDITOR_SECTION_SYSTEM);
    assert.equal(sections.length, splitSections(REMAINDER, BUDGET).length);
    assert.ok(sections.length >= 2, "the fixture is not exercising the packing it was built for");
    for (let i = 1; i <= sections.length; i++) assert.match(result.body, new RegExp(`section ${i}`));
    for (let i = REACHED; i < PARAS.length; i++) {
      assert.ok(result.body.includes(PARAS[i]!), `${PARAS[i]!.slice(0, 14)} is missing from the document`);
    }
    // The point of the whole change: the blocks the reply already corrected were NOT sent to a
    // second, weaker call that cannot see them in context. Nothing in any section prompt is a
    // block the round had already answered about.
    for (const call of sections) {
      const asked = askedSection(call.user);
      assert.ok(REMAINDER.includes(asked.html), `a section call was given text outside the remainder`);
      for (const i of NAMED) {
        assert.ok(!asked.html.includes(`id="p${i + 1}"`), `block ${i} was paid for twice`);
      }
    }
  });
});

test("the round says what it rescued and how much of the document that was", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = ctxWith(dir, { reply: () => cutReply(NAMED) });
    await review(ctx);

    const salvaged = rec.events.find((e) => e.type === "editor_salvaged");
    assert.equal(salvaged?.data.edits, REACHED);
    assert.equal(salvaged?.data.applied, REACHED);
    assert.equal(salvaged?.data.reached, REACHED);
    assert.equal(salvaged?.data.of, BLOCKS.length, "the share of the document a truncated call had answered");
    assert.equal(salvaged?.data.chars, CHARS);
    assert.equal(salvaged?.data.rest, REMAINDER.length);
    assert.equal(salvaged?.data.closed, undefined, "this reply's edits list never ended");
    // The sections are of the REMAINDER, and a log reader must not have to work that out: a budget
    // of 10,000 against a body of 22,000 is one story and against a remainder of 11,000 another.
    const started = rec.events.find((e) => e.type === "editor_sections");
    assert.equal(started?.data.covers, "remainder");
    assert.equal(started?.data.chars, REMAINDER.length);
    assert.equal(started?.data.budget, BUDGET, "the budget is still measured from the response that did not fit");
    // And the ceiling was still hit, which is what the deployment counts (#143): the remedy for a
    // document that cannot be corrected in one response is the deployment's either way.
    assert.equal(rec.events.some((e) => e.type === "editor_truncated"), true);
  });
});

test("a reply whose list closed needs no sections at all, and costs the document nothing", async () => {
  await withTemp(async (dir) => {
    // The ceiling was reached on the way OUT of the envelope — in `fidelity_observed` — so the patch
    // itself is complete: every block was considered, and silence about a block is an answer about
    // it. This is the one truncation that leaves a reader nothing to be told they are missing.
    const { ctx, rec } = ctxWith(dir, { reply: () => cutReply([0, 5, 23], { closed: true }) });
    const result = await review(ctx);

    assert.equal(rec.calls.filter((c) => c.system === EDITOR_SECTION_SYSTEM).length, 0);
    for (const i of [0, 5, 23]) assert.ok(result.body.includes(fixed(i)), `block ${i}'s correction is missing`);
    for (const i of [1, 2, 3]) assert.ok(result.body.includes(PARAS[i]!), "a block nobody named came back changed");
    const salvaged = rec.events.find((e) => e.type === "editor_salvaged");
    assert.equal(salvaged?.data.closed, true);
    assert.equal(salvaged?.data.reached, BLOCKS.length);
    assert.equal(salvaged?.data.rest, 0);
    assert.equal(result.editorTruncated, true, "the ceiling was hit and the deployment is told so");
    assert.equal(result.editorTruncatedLost, false, "but no part of this document went uncorrected");
    assert.match(result.html, /@editor-truncated blocks 24 of 24/);
    assert.match(result.html, /nothing was left to ask\n {2}for again/);
  });
});

test("a truncation costs the document only the blocks the reply never reached", async () => {
  await withTemp(async (dir) => {
    // The loss this reports is the REMAINDER's, not the round's: the blocks the reply reached were
    // corrected by the round itself. So a salvaged round whose every section also came back is not
    // a lost document, and one whose sections failed has lost exactly the tail.
    const { ctx } = ctxWith(dir, { reply: () => cutReply(NAMED) });
    assert.equal((await review(ctx)).editorTruncatedLost, false);

    const { ctx: partial } = ctxWith(dir, {
      reply: () => cutReply(NAMED),
      sectionAnswer: (s) => (s.index === 1 ? null : `${s.html}\n<p class="sec">section ${s.index}</p>`),
    });
    const result = await review(partial);
    assert.equal(result.editorTruncatedLost, true, "a section that kept its own text is a part with no editor pass");
    // And the tail is still the text it went in with rather than anything invented for it.
    for (let i = REACHED; i < PARAS.length; i++) assert.ok(result.body.includes(PARAS[i]!));
  });
});

test("the document says which half of it got which kind of correction", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = ctxWith(dir, { reply: () => cutReply(NAMED) });
    const { html } = await review(ctx);
    const of = splitSections(REMAINDER, BUDGET).length;

    assert.match(html, new RegExp(`@editor-truncated blocks ${REACHED} of ${BLOCKS.length}`));
    assert.match(html, /had already said was read and kept/);
    assert.match(html, new RegExp(`${of} of ${of} sections came back corrected`));
    assert.match(html, new RegExp(`remaining ${BLOCKS.length - REACHED} blocks were asked for again`));
    // The two things a reader of this document cannot work out for themselves, and they are the
    // same two the sectioned round discloses: a problem spanning two sections may be untouched,
    // and the @unresolved list below was taken before all of this and never taken again.
    assert.match(html, /a problem spanning two of them may be untouched/);
    assert.match(html, /some may already be fixed/);
    assert.match(html, /editor_salvaged/, "the log line to look up is named");
    // Outside <main>, like every other wrapper statement: it is not content.
    assert.ok(html.indexOf("@editor-truncated") > html.indexOf("</main>"));
    // And neither of the other two roundings is what this document gets. A reader told the round
    // was discarded would go looking elsewhere for corrections that are in fact here, and one told
    // only "sections 2 of 2" would read the first half as text no editor ever saw.
    assert.doesNotMatch(html, /that round was\n  discarded/);
    assert.doesNotMatch(html, /@editor-truncated sections/);
    assert.equal(rec.events.find((e) => e.type === "editor")?.data.sections, of);
  });
});

test("a remainder short enough to ask for in one call is asked for in one call", async () => {
  await withTemp(async (dir) => {
    // The `budget_exceeds_body` decline is about a request that would be the identical request at
    // the identical length. A remainder is not that: it is strictly smaller than the body that
    // truncated, it carries no images, and it is under a length this model has just been measured
    // producing. So one section is the cheapest way this round can end, not a reason to give up.
    const named = Array.from({ length: 20 }, (_, i) => i);
    const { ctx, rec } = ctxWith(dir, { reply: () => cutReply(named) });
    const result = await review(ctx);

    const sections = rec.calls.filter((c) => c.system === EDITOR_SECTION_SYSTEM);
    assert.equal(sections.length, 1);
    assert.ok(askedSection(sections[0]!.user).html.length < BUDGET);
    assert.match(result.body, /section 1/);
    assert.equal(rec.events.find((e) => e.type === "editor_sections_declined"), undefined);
    assert.equal(result.editorTruncatedLost, false);
  });
});

test("a block that gave content up refuses the whole prefix", async () => {
  await withTemp(async (dir) => {
    // The strictest rule here, and the one the contract forces. A MOVE is a pair of edits — the
    // block the content came from and the block it lands in — so a cut between the two halves would
    // take the source half alone and delete content nothing downstream can miss. Under the ordinary
    // contract that fires only where the reply already holds a refusal; here the CUT is the refusal,
    // of everything after it, so an emptied block gives up the salvage rather than the content.
    const emptied = new TruncatedResponseError(
      "bedrock",
      "sonnet",
      32_000,
      `{"edits":[${JSON.stringify({ block: 0, html: fixed(0) })},{"block":1,"html":""},{"block":2,"html":"<p id="p`.padEnd(
        CHARS,
        "x",
      ),
    );
    const { ctx, rec } = ctxWith(dir, { reply: () => emptied });
    const result = await review(ctx);

    const declined = rec.events.find((e) => e.type === "editor_salvage_declined");
    assert.equal(declined?.data.reason, "loss_before_cut");
    assert.equal(declined?.data.deleted, 1);
    assert.equal(declined?.data.reached, 2);
    assert.equal(rec.events.find((e) => e.type === "editor_salvaged"), undefined);
    // Which leaves the round exactly where it was before any of this existed: the WHOLE body is
    // asked for a section at a time, and no block keeps a correction from the refused prefix.
    const started = rec.events.find((e) => e.type === "editor_sections");
    assert.equal(started?.data.chars, LONG.length);
    assert.equal(started?.data.covers, undefined, "an ordinary sectioned round's line is the one it always was");
    assert.ok(!result.body.includes(fixed(0)), "a refused prefix must not leave half of itself behind");
    assert.ok(result.body.includes(PARAS[1]!), "the emptied block still has its content");
  });
});

test("the other ways a prefix is refused, and each one is a different failure", async () => {
  await withTemp(async (dir) => {
    const reason = async (reply: () => TruncatedResponseError) => {
      const { ctx, rec } = ctxWith(dir, { reply });
      await review(ctx);
      const declined = rec.events.find((e) => e.type === "editor_salvage_declined");
      return { reason: declined?.data.reason, sections: rec.events.find((e) => e.type === "editor_sections")?.data };
    };

    // A reply in some other shape altogether: the model answered with the document, or with prose
    // about the document. That is a prompt that was not followed, and it is not evidence that this
    // document is too big for its ceiling.
    const prose = new TruncatedResponseError("bedrock", "sonnet", 32_000, `I will work through the issues in order`.padEnd(CHARS, "x"));
    assert.equal((await reason(() => prose)).reason, "no_edits_list");

    // The contract followed and the ceiling reached inside the FIRST block — one enormous table,
    // typically. This is the shape that really does mean the document cannot be answered whole,
    // and it is the only one of the four that says so.
    const first = new TruncatedResponseError("bedrock", "sonnet", 32_000, `{"edits":[{"block":3,"html":"<p>`.padEnd(CHARS, "x"));
    assert.equal((await reason(() => first)).reason, "no_complete_edit");

    // Names that jump backwards. The edits would still apply, but the blocks BETWEEN two named
    // ones cannot be read as deliberately left alone, so the coverage the round rests on is not
    // claimable — and applying the prefix and then sectioning the whole body would pay for the
    // same blocks twice and let the weaker call overwrite the stronger one's work.
    const back = await reason(() => cutReply([2, 9, 4]));
    assert.equal(back.reason, "out_of_order");

    // Entries that were read and cannot be used: a replacement that ends inside an element is one
    // this code would have to guess the extent of, so `applyBlockEdits` keeps the block — and a
    // prefix where that happened to every block is a prefix with nothing in it.
    const halves = new TruncatedResponseError(
      "bedrock",
      "sonnet",
      32_000,
      `{"edits":[{"block":0,"html":"<p id=\\"p1\\">word1 unclosed"},{"block":1,"html":"<p`.padEnd(CHARS, "x"),
    );
    assert.equal((await reason(() => halves)).reason, "all_refused");

    // All three end where the round used to: the whole body, a section at a time.
    assert.equal(back.sections?.chars, LONG.length);
    assert.equal(back.sections?.covers, undefined);
  });
});

test("a reply that names a block this document does not have is not about this document", async () => {
  await withTemp(async (dir) => {
    // The ordinary round tolerates an unknown block: it applies what it recognises and reports the
    // rest. This one cannot, and the difference is what the salvage rests on — coverage of every
    // block up to the last one named is an INFERENCE about a reply walking this document in order,
    // and a block number the document has no such block for is evidence the walk was of something
    // else. This shape is also the fixture the discard tests use (test/review-truncation.test.ts,
    // where a 39-edit reply meets a two-block body), so a rule that read it as coverage would have
    // salvaged a document from a reply about another one.
    const wrong = new TruncatedResponseError(
      "bedrock",
      "sonnet",
      32_000,
      `{"edits":[{"block":0,"html":${JSON.stringify(fixed(0))}},{"block":91,"html":"<p>b</p>"},{"block":92,"html":"<p`.padEnd(
        CHARS,
        "x",
      ),
    );
    const { ctx, rec } = ctxWith(dir, { reply: () => wrong });
    const result = await review(ctx);
    const declined = rec.events.find((e) => e.type === "editor_salvage_declined");
    assert.equal(declined?.data.reason, "unknown_block");
    assert.equal(declined?.data.unknown, 1);
    assert.equal(declined?.data.edits, 2);
    assert.ok(!result.body.includes(fixed(0)), "block 0's edit was readable, and the prefix is still refused");

    // And an entry this cannot read at all, which is the same problem arriving from the other side:
    // an edit whose block is not a number might have named a block past the cut.
    const garbled = new TruncatedResponseError(
      "bedrock",
      "sonnet",
      32_000,
      `{"edits":[{"block":"the first","html":"<p>a</p>"},{"block":1,"html":"<p`.padEnd(CHARS, "x"),
    );
    const { ctx: second, rec: rec2 } = ctxWith(dir, { reply: () => garbled });
    await review(second);
    const second_declined = rec2.events.find((e) => e.type === "editor_salvage_declined");
    assert.equal(second_declined?.data.reason, "unreadable_edit");
    assert.equal(second_declined?.data.unreadable, 1);
  });
});
