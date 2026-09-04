// The Copy Editor answers with the blocks it changed, not with the document retyped (issue #250).
//
// Why that is the change worth making, in the numbers the bench measured. Asked for the complete
// corrected body, the editor's reply is a mean of ~26,600 encoded tokens across 34 delivered
// documents, and 15 of the 34 cannot fit under the ceiling at all — which is 58% of rounds
// truncating for a reason no choice of model can move: a model cannot emit a reply longer than its
// output ceiling. The blocks a round actually touches come to ~1,211 tokens. The editor was being
// billed for a document and asked a question about a paragraph.
//
// Why the anchor is a block POSITION. The first form of #250 asked for `{ id, html }` pairs and its
// own $0 check refuted it: of the 13 defect instances markup.ts's own checks find in those
// documents, NONE sits on an element with a usable id and none has an ancestor carrying one,
// because Iris puts ids on what gets linked TO. An id-anchored contract reaches none of those 13.
// (Corrected figures, #268 — the count this used to quote called a `lang` on a void element a
// defect whatever text it carried in an attribute; patch.ts's header has the full account.) A block
// is the cut sections.ts already makes for the truncation fallback, so there is one definition of
// where a top-level node ends.
//
// Three properties are pinned here, and they are what the contract rests on: a block nobody names
// comes back byte for byte, a replacement that is not whole markup is refused rather than spliced,
// and everything the reply gets wrong costs the block it was about and not the document.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { annotateBlocks, applyBlockEdits, blocksOf, readBlockEdits } from "../src/pipeline/patch.ts";
import { visibleText } from "../src/pipeline/correction.ts";
import { splitBlocks, topLevelComplete } from "../src/pipeline/sections.ts";
import { EDITOR_SYSTEM, runReview } from "../src/pipeline/review.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// --- the blocks ---

const BODY = `<h1>Manual</h1>\n\n<p>One.</p>\n<ul><li>a</li><li>b</li></ul>\n\n<hr role="doc-pagebreak" id="page-2">\n<p>Two.</p>\n`;

test("the blocks put the body back together character for character", () => {
  // The property everything else rests on. A block the editor did not name is delivered exactly as
  // it stands, so the join has to be exact — reserializing it, which parsing and re-emitting the
  // HTML would do, would rewrite parts of the delivered document nothing asked to change
  // (anchors.ts declines the same round trip for the same reason).
  const blocks = splitBlocks(BODY);
  assert.equal(blocks.map((b) => b.pre + b.html).join(""), BODY);
  assert.deepEqual(blocks.map((b) => b.html), [
    `<h1>Manual</h1>`,
    `<p>One.</p>`,
    `<ul><li>a</li><li>b</li></ul>`,
    `<hr role="doc-pagebreak" id="page-2">`,
    `<p>Two.</p>\n`,
  ]);
  // The whitespace between them is nobody's block: it is held in `pre` and re-attached by the
  // join, so a block the editor rewrote does not arrive glued to its neighbour.
  assert.deepEqual(blocks.map((b) => b.pre), ["", "\n\n", "\n", "\n\n", "\n"]);
});

test("a block is one top-level node, however deep it is", () => {
  // The cut is `splitSections` with nothing packed into it, which is the point: a table is one
  // block whatever it holds, because a cut inside one is not a place a correction can be joined.
  const table = `<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>`;
  assert.deepEqual(splitBlocks(`<h1>T</h1>${table}<p>End.</p>`).map((b) => b.html), [
    `<h1>T</h1>`,
    table,
    `<p>End.</p>`,
  ]);
  // And an omitted end tag does not swallow the rest of the document — `<p>one<p>two` is two
  // blocks, as it is two paragraphs to a browser.
  assert.deepEqual(splitBlocks(`<p>one<p>two`).map((b) => b.html), [`<p>one`, `<p>two`]);
  assert.deepEqual(splitBlocks("").length, 0);
});

test("the numbers are written above the blocks, not counted by the editor", () => {
  // The one failure under this contract that nothing downstream could see: a model counting
  // blocks itself could be off by one, land in range, and have every replacement applied to the
  // wrong block with each one well-formed. Copying a number written above the block cannot make
  // that mistake — so the marker is the anchor, and this is what it looks like.
  const shown = annotateBlocks(blocksOf(BODY));
  assert.equal(
    shown,
    `<!-- @block 0 -->\n<h1>Manual</h1>\n` +
      `<!-- @block 1 -->\n<p>One.</p>\n` +
      `<!-- @block 2 -->\n<ul><li>a</li><li>b</li></ul>\n` +
      `<!-- @block 3 -->\n<hr role="doc-pagebreak" id="page-2">\n` +
      `<!-- @block 4 -->\n<p>Two.</p>\n`,
  );
  // The numbering is computed on the body, so the markers are not themselves blocks and a second
  // pass over what the editor was shown would number them the same way.
  assert.equal(blocksOf(BODY).length, 5);
  // House style for a comment addressed to a reader of the markup rather than to a browser
  // (`@unresolved`, `@page-failed` in assembly.ts). It exists only in the request: nothing writes
  // one into a delivered document.
  assert.match(shown, /<!-- @block 0 -->/);
});

test("what is left open at the end of a replacement is not a replacement", () => {
  // Asked of every replacement before it is spliced in. A reply that ends inside an element has an
  // extent this code would have to guess at, and splicing it in would close its open tags with
  // whatever followed it in the document.
  assert.equal(topLevelComplete(`<p>a</p>`), true);
  assert.equal(topLevelComplete(`<p>a</p>\n<p>b</p>`), true, "several whole nodes are whole markup");
  assert.equal(topLevelComplete(`<table><tr><td>1</td></tr></table>`), true);
  assert.equal(topLevelComplete(``), true, "nothing at all is a deletion, and deletions are allowed");
  assert.equal(topLevelComplete(`   \n `), true);
  assert.equal(topLevelComplete(`<p>a`), false);
  assert.equal(topLevelComplete(`<div><p>a</p>`), false);
  assert.equal(topLevelComplete(`<table><tr><td>1</td></tr>`), false);
  assert.equal(topLevelComplete(`<p>a</p><p>b`), false);
  // Stricter than a parser in one place, and deliberately so: `<p>a<p>b` is two paragraphs to a
  // browser, which closes the second at the end of the input, and this reads the tail as an
  // element nothing closed. The cost is one refused replacement, logged, with that block keeping
  // its original text; the alternative is guessing where a truncated reply meant to end.
  assert.equal(topLevelComplete(`<p>a<p>b`), false);
});

test("an end tag that closes nothing is not a replacement either", () => {
  // The other end of the same question, and one a tail check alone lets through: a stray end tag
  // is IGNORED by `cutPoints`, because that is what a parser does with it, so the tail is clean
  // and the markup counts as whole nodes. Splicing it in writes an end tag into the document for
  // an element opened nowhere. A parser drops it, so a reader is not served anything wrong — but
  // the delivered BYTES are what `delivered_markup` counts (#240), and one spliced stray reports
  // there as an element whose tags do not balance, pointing at nothing.
  //
  // Not a hypothetical shape: a page answer emitting a stray `</main>` is what landmarks.ts
  // deletes and counts (#256), so a model returning an end tag for something it never opened is
  // measured behaviour in this pipeline, not a shape only a fuzzer reaches.
  assert.equal(topLevelComplete(`</figure><p>x</p>`), false, "at the front, where a parser ignores it");
  assert.equal(topLevelComplete(`<p>a</p></figure>`), false, "at the back, past the last real node");
  assert.equal(topLevelComplete(`<p>a</p></div><p>b</p>`), false, "between two whole nodes");
  // And the legitimate shapes it must not catch: an end tag that closes something the replacement
  // itself opened is the ordinary case, and `<li>`/`<td>` closing by implication is correct HTML.
  assert.equal(topLevelComplete(`<div><p>a</p></div>`), true);
  assert.equal(topLevelComplete(`<ul><li>a<li>b</ul>`), true);
  assert.equal(topLevelComplete(`<table><tr><td>1<td>2</table>`), true);
});

// --- the patch ---

const blocks = () => blocksOf(BODY);

test("a block nobody named is delivered byte for byte", () => {
  const patched = applyBlockEdits(blocks(), [{ block: 1, html: `<p>One, corrected.</p>` }]);
  assert.equal(
    patched.body,
    `<h1>Manual</h1>\n\n<p>One, corrected.</p>\n<ul><li>a</li><li>b</li></ul>\n\n<hr role="doc-pagebreak" id="page-2">\n<p>Two.</p>\n`,
  );
  assert.equal(patched.applied, 1);
  assert.equal(patched.deleted, 0);
  // An empty edits list is not an error and not a failure: it is the editor saying the markup
  // needs nothing, and the body comes back untouched.
  assert.equal(applyBlockEdits(blocks(), []).body, BODY);
});

test("an emptied block is how duplicated content goes", () => {
  // The editor's explicit job includes removing content the document prints twice (the same table
  // rendered as a form and as a table, a heading reprinted where its section carried on), so the
  // contract needs a way to say "this block should not be here". Its whitespace stays with the
  // document, which is assembly's and not the editor's.
  const patched = applyBlockEdits(blocks(), [{ block: 2, html: "" }]);
  assert.equal(patched.body, `<h1>Manual</h1>\n\n<p>One.</p>\n\n\n<hr role="doc-pagebreak" id="page-2">\n<p>Two.</p>\n`);
  assert.equal(patched.deleted, 1);
  assert.equal(patched.applied, 0);
  // A reply that is nothing but whitespace is the same instruction, not a replacement made of
  // spaces.
  assert.equal(applyBlockEdits(blocks(), [{ block: 2, html: "  \n" }]).deleted, 1);
});

test("which blocks gave content up, and not only how many", () => {
  // The counts say a round lost content somewhere; `lost` says where, which is what a caller applying
  // only PART of a reply has to know (#317: a truncated reply may be applied up to the first block
  // that gave content up and no further, `salvageRound`). Both kinds are in it — the block emptied and
  // the block handed back with less prose than it had — because either can be the source half of a
  // move, which is the distinction the caller is reading it for.
  const patched = applyBlockEdits(blocks(), [
    { block: 4, html: `<p>Two, corrected and longer.</p>` },
    { block: 2, html: "" },
    { block: 1, html: `<p>1</p>` },
  ]);
  assert.equal(patched.deleted, 1);
  assert.equal(patched.shrunk, 1);
  // In the order the edits were read, not block order: a reply whose list closed is under no ordering
  // obligation, so a caller wanting the earliest block takes the minimum rather than the head.
  assert.deepEqual(patched.lost, [2, 1]);
  // And empty when nothing did, so its length is the question "did this reply lose anything" asked
  // once rather than as a sum of two counts.
  assert.deepEqual(applyBlockEdits(blocks(), [{ block: 4, html: `<p>Two, corrected.</p>` }]).lost, []);
});

test("one edit may return several blocks, which is how a fix splits one", () => {
  // A heading lifted out of a section, a run of paragraphs where a list belongs: the corrections
  // this loop exists for change how many top-level nodes there are, so a replacement is one or
  // more whole nodes rather than exactly one.
  const patched = applyBlockEdits(blocks(), [{ block: 2, html: `<h2>Steps</h2>\n<ul><li>a</li><li>b</li></ul>` }]);
  assert.match(patched.body, /<p>One\.<\/p>\n<h2>Steps<\/h2>\n<ul>/);
  assert.equal(patched.applied, 1);
});

test("everything the reply gets wrong costs the block it was about", () => {
  // The contract's containment, and the difference from the one it replaces: a bad whole-body
  // reply cost the document's corrections, and a bad edit costs its own block. So an unusable
  // edit beside three usable ones leaves the three applied.
  const patched = applyBlockEdits(blocks(), [
    { block: 0, html: `<h1>Manual, corrected</h1>` },
    { block: 1, html: `<p>One, unclosed` },
    { block: 9, html: `<p>a block this document does not have</p>` },
    { block: 4, html: `<p>Two, corrected.</p>` },
  ]);
  assert.match(patched.body, /<h1>Manual, corrected<\/h1>/);
  assert.match(patched.body, /<p>One\.<\/p>/, "the block whose replacement was unfinished keeps its own text");
  assert.match(patched.body, /<p>Two, corrected\.<\/p>/);
  assert.doesNotMatch(patched.body, /unclosed/);
  assert.doesNotMatch(patched.body, /this document does not have/);
  assert.equal(patched.applied, 2);
  assert.equal(patched.incomplete, 1);
  // Kept as numbers rather than counted: which block was named is the difference between a model
  // that invented an anchor and one that answered about a different document.
  assert.deepEqual(patched.unknown, [9]);
  // A negative or fractional index is the same fact as an out-of-range one, and neither may be
  // read as an offset from the end.
  assert.deepEqual(applyBlockEdits(blocks(), [{ block: -1, html: `<p>x</p>` }]).unknown, [-1]);
  assert.deepEqual(applyBlockEdits(blocks(), [{ block: 1.5, html: `<p>x</p>` }]).unknown, [1.5]);
});

test("a reply that contradicts itself about one block keeps the first answer", () => {
  // Whichever is taken has to be deterministic, and position is not authority: a second edit for
  // the same block is no more considered than the first. Counted, because a reply that does this
  // is a reply that was not written against the contract.
  const patched = applyBlockEdits(blocks(), [
    { block: 1, html: `<p>First.</p>` },
    { block: 1, html: `<p>Second.</p>` },
  ]);
  assert.match(patched.body, /<p>First\.<\/p>/);
  assert.doesNotMatch(patched.body, /Second/);
  assert.equal(patched.duplicate, 1);
  assert.equal(patched.applied, 1);
});

test("a block the editor returned unchanged is counted, not credited", () => {
  // Output spent to say nothing, which is the cost this contract exists to remove — so it is
  // counted apart from a correction rather than folded into one. Whitespace around it is not a
  // change either: a reply that differs from its block only in the spaces around it has changed
  // nothing about the document, and calling that a correction would report work not done.
  const same = applyBlockEdits(blocks(), [{ block: 1, html: `<p>One.</p>` }]);
  assert.equal(same.body, BODY);
  assert.equal(same.unchanged, 1);
  assert.equal(same.applied, 0);
  assert.equal(applyBlockEdits(blocks(), [{ block: 1, html: `\n<p>One.</p>  ` }]).unchanged, 1);
});

test("a marker the editor copied back is taken out again, and recorded", () => {
  // A model that echoes the `<!-- @block 1 -->` it was shown is following the contract loosely
  // rather than breaking it, so the marker is stripped and the edit stands. The count is the
  // evidence for how well the contract reads, which is why it is on the record at all.
  const patched = applyBlockEdits(blocks(), [{ block: 1, html: `<!-- @block 1 -->\n<p>One, corrected.</p>` }]);
  assert.match(patched.body, /<p>One, corrected\.<\/p>/);
  assert.doesNotMatch(patched.body, /@block/);
  assert.equal(patched.markers, 1);
  assert.equal(patched.applied, 1);
  // An echoed marker with nothing after it is a deletion, not a replacement made of a comment.
  assert.equal(applyBlockEdits(blocks(), [{ block: 1, html: `<!-- @block 1 -->` }]).deleted, 1);
});

test("the shapes a model sends for an integer field are read, and the rest are not guessed at", () => {
  // `block` as a string is the commonest of them and costs one line to read. Everything else is
  // dropped rather than coerced — `Number(null)` is 0, which would apply an unreadable edit to the
  // first block of the document.
  assert.deepEqual(readBlockEdits([{ block: "3", html: `<p>x</p>` }]), {
    edits: [{ block: 3, html: `<p>x</p>` }],
    unreadable: 0,
  });
  const read = readBlockEdits([
    { block: null, html: `<p>x</p>` },
    { block: "seven", html: `<p>x</p>` },
    { block: 2 },
    "not an object",
    null,
    // `html: ""` is the deletion instruction, so it has to survive the check that drops a missing
    // field: absent and empty are different answers.
    { block: 2, html: "" },
  ]);
  assert.deepEqual(read.edits, [{ block: 2, html: "" }]);
  assert.equal(read.unreadable, 5);
  // Not an array at all — a model that answered `"edits": "none"` said nothing this can apply,
  // and nothing this should report as a refused edit either.
  assert.deepEqual(readBlockEdits("none"), { edits: [], unreadable: 0 });
});

// --- the round ---

const ISSUES = [
  { issue: "the list has no heading over it", severity: "medium", suggested_action: "add one", pages: [] },
];

// The review loop against an editor whose reply is a function of the numbered document it was
// shown. The harness is test/review-converge.test.ts's, cut down to one round.
async function round(reply: (shown: string) => unknown, body = BODY, maxReviewIterations = 1) {
  const dir = mkdtempSync(join(tmpdir(), "iris-patch-"));
  try {
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const prompts: string[] = [];
    const ctx = {
      sessionId: "ses_test",
      images: [],
      maxReviewIterations,
      extractionConcurrency: 4,
      recheckSampleSize: 1,
      paths: {
        agentsDir: join(dir, "agents"),
        tmpAgentsDir: () => join(dir, "tmp-agents"),
        agentMemory: () => join(dir, "memory", "page.json"),
      } as unknown as Paths,
      router: {
        complete: async (agent: string, _cap: string, messages: { content: string }[]) => {
          if (agent === "reader") return { text: JSON.stringify({ issues: ISSUES }) };
          const user = messages[messages.length - 1]?.content ?? "";
          prompts.push(user);
          const shown = /## Current document \(body content, in numbered blocks\)\n([\s\S]*?)\n\n## Issues to fix/.exec(user);
          assert.ok(shown, "the editor prompt no longer carries the numbered document");
          return { text: JSON.stringify(reply(shown[1])) };
        },
      },
      log: {
        event: (type: string, data: Record<string, unknown> = {}) => events.push({ type, data }),
        agentCall: () => {},
      },
    } as unknown as PipelineContext;
    const result = await runReview(ctx, { body, lint: { ok: true, violations: [] } });
    return { result, events, prompts };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the round applies the editor's edits and says what became of each one", async () => {
  const { result, events } = await round(() => ({
    edits: [
      { block: 2, html: `<h2>Steps</h2>\n<ul><li>a</li><li>b</li></ul>` },
      { block: 4, html: `<p>One, unclosed` },
      { block: 11, html: `<p>x</p>` },
    ],
  }));
  assert.match(result.body, /<h2>Steps<\/h2>/);
  assert.match(result.body, /<p>Two\.<\/p>/, "the block whose replacement was unfinished keeps its text");
  // The counters are the round's own evidence about the contract — how many blocks a round
  // touches is the number the whole change rests on, and a whole-body reply cannot report it.
  const patch = events.find((e) => e.type === "editor_patch");
  assert.equal(patch?.data.blocks, 5);
  assert.equal(patch?.data.edits, 3);
  assert.equal(patch?.data.applied, 1);
  assert.equal(patch?.data.incomplete, 1);
  assert.deepEqual(patch?.data.unknown, [11]);
  // The fields that are absent on a round that went well, so a line carrying any of them is a
  // reply that did not follow the contract and says which way.
  assert.ok(!("duplicate" in (patch?.data ?? {})));
  assert.ok(!("markers" in (patch?.data ?? {})));
  assert.ok(!("unreadable" in (patch?.data ?? {})));
});

test("edits that could none of them be used are a retry, not a decision", async () => {
  // The same fact about the round as an unparseable reply: nothing came back that can be used as
  // this document. So the loop runs another round rather than reading the unchanged body as the
  // editor having found the document fine — and `review_converged` in particular must not fire.
  const { result, events } = await round(() => ({ edits: [{ block: 99, html: `<p>x</p>` }] }), BODY, 2);
  assert.equal(result.body, BODY);
  assert.equal(events.filter((e) => e.type === "editor_patch").length, 2, "every round the cap allows is spent");
  // Which of the two ways the round was unusable, on the line: what became of the round and not
  // only what became of each edit.
  assert.equal(events.find((e) => e.type === "editor_patch")?.data.discarded, "all_refused");
  assert.equal(events.filter((e) => e.type === "review_converged").length, 0);
  // And an empty list is the other case, which is an answer: the editor read the document and
  // said the markup needs nothing.
  const clean = await round(() => ({ edits: [] }), BODY, 2);
  assert.equal(clean.result.body, BODY);
  assert.equal(clean.events.filter((e) => e.type === "review_converged").length, 1);
  assert.equal(clean.events.filter((e) => e.type === "editor_patch").length, 1);
});

test("a round that emptied most of the document is refused whole", async () => {
  // #174's floor, on the joined body. The patch contract makes a catastrophic loss harder to
  // reach — an untouched block cannot be lost — but not impossible, and the blast radius is the
  // same deliverable: an editor that empties two thirds of the blocks has destroyed the document
  // as thoroughly as one that summarised it. The prose has to clear
  // `EDITOR_FLOOR_MIN_TEXT` before the floor applies at all, which is why this body is long.
  const long = [
    `<h1>Manual</h1>`,
    `<p>${"word ".repeat(300)}</p>`,
    `<p>${"other ".repeat(300)}</p>`,
    `<p>keep this one</p>`,
  ].join("\n\n");
  const { result, events } = await round(
    () => ({ edits: [{ block: 1, html: "" }, { block: 2, html: "" }] }),
    long,
    1,
  );
  assert.equal(result.body, long, "the body that entered the round is what is delivered");
  const shrank = events.find((e) => e.type === "editor_shrank");
  assert.equal(shrank?.data.stage, "patch");
  assert.equal(shrank?.data.deleted, 2, "what a shrink under this contract is made of");
  assert.equal(shrank?.data.shrunk, 0);
  assert.equal(shrank?.data.of, 4);
  // Reported as a round that ran and changed nothing, not as one that converged: the editor said
  // something and it could not be used.
  assert.equal(events.filter((e) => e.type === "review_converged").length, 0);
  // And the shape this line is likeliest to be asked about, which `deleted` alone cannot describe:
  // the floor is only reached when NOTHING was refused (a refusal beside a block that gave content
  // up is discarded before this), so the commonest reply that lands here empties nothing and returns
  // blocks with a fifth of their prose in them. `deleted: 0` with no `shrunk` beside it would leave
  // the line saying where the document went nowhere at all.
  const summarised = await round(
    () => ({ edits: [{ block: 1, html: `<p>word</p>` }, { block: 2, html: `<p>other</p>` }] }),
    long,
    1,
  );
  assert.equal(summarised.result.body, long);
  const summary = summarised.events.find((e) => e.type === "editor_shrank");
  assert.equal(summary?.data.deleted, 0);
  assert.equal(summary?.data.shrunk, 2);
});

test("an editor that answers with the whole document is still read", async () => {
  // Backward compatibility, and the reason for it: a model that hands back a corrected body is
  // answering a question this prompt no longer asks, but it IS answering. Refusing the reply would
  // spend the round — and on a model that reverts to a familiar shape under load, every round of
  // the run — while accepting it costs nothing, because the floor that guarded that path is still
  // the floor. It is logged, because a deployment whose editor answers this way is paying #250's
  // bill in full and is not truncating any less for the new prompt.
  const { result, events } = await round(() => ({ html: `<h1>Manual</h1>\n<p>Whole body.</p>` }));
  assert.match(result.body, /<p>Whole body\.<\/p>/);
  const whole = events.find((e) => e.type === "editor_whole_body");
  assert.equal(whole?.data.blocks, 5);
  assert.equal(events.find((e) => e.type === "editor_patch"), undefined);
  // An `edits` array wins where a reply carries both, because it is the answer to the question
  // that was asked.
  const both = await round(() => ({ edits: [{ block: 1, html: `<p>Edited.</p>` }], html: `<p>Whole.</p>` }));
  assert.match(both.result.body, /<p>Edited\.<\/p>/);
  assert.doesNotMatch(both.result.body, /Whole/);
  assert.equal(both.events.find((e) => e.type === "editor_whole_body"), undefined);
});

test("a whole-body reply that hands back what it was SHOWN does not deliver the markers", async () => {
  // The likeliest whole-body reply under this contract, and the one the fallback exists for: the
  // model is shown the document with a marker line above every top-level element and returns that
  // document. Adopted verbatim it would write Iris's own request scaffolding into the delivered
  // HTML — the `@source`-leak class — and it compounds, because a comment is a top-level node: the
  // next round is shown the markers as blocks in their own right, so the body doubles every round,
  // every round reads as `changed`, and a 4-block document arrives carrying 16 comments.
  //
  // A cap of three rounds, because one round cannot tell a strip from a body that happened to
  // survive intact. Two rounds is what this spends: the second returns what the first settled on,
  // so the body stops moving and the loop converges — which is the symptom read from the other
  // side, since a body that doubles every round can never converge and always runs to the cap.
  const { result, events } = await round((shown) => ({ html: shown }), BODY, 3);
  assert.doesNotMatch(result.body, /@block/, "no request scaffolding in the delivered body");
  const whole = events.filter((e) => e.type === "editor_whole_body");
  assert.equal(whole.length, 2);
  assert.equal(events.filter((e) => e.type === "review_converged").length, 1);
  for (const line of whole) {
    assert.equal(line.data.blocks, 5, "the body is not growing a set of comment blocks each round");
    // On the record, because how often a model does this is the evidence for how the contract
    // reads — and a reply that echoed the markers is a reply written against the old one.
    assert.equal(line.data.markers, 5);
  }
  // The one cost of answering the old way that remains, named so nobody reads it as a bug:
  // `annotateBlocks` separates blocks with a newline and leaves out the whitespace assembly put
  // between them, so a model retyping what it was shown returns the same nodes with different
  // gaps around them. Whitespace between blocks, not content.
  // (Compared trimmed because the body's trailing newline is part of its last block — only the
  // final block can carry trailing whitespace — and that is the same whitespace fact.)
  assert.notEqual(result.body, BODY);
  assert.deepEqual(
    blocksOf(result.body).map((b) => b.html.trim()),
    blocksOf(BODY).map((b) => b.html.trim()),
  );
});

// The outline reading on the whole-body path (#375). A body with two headings, a list and enough
// prose that dropping a word or two stays well clear of `EDITOR_SHRINK_FLOOR`.
const WHOLE_OUTLINE = `<h1>Report</h1>\n\n<h2>Costs</h2>\n\n<p>${"word ".repeat(80)}</p>\n\n<ul><li>a</li><li>b</li><li>c</li></ul>\n`;

test("a whole-body reply that demotes a heading is delivered, and the fall is on the record", async () => {
  // #375: #331's guard lives in `applyBlockEdits`, so until now this path had one check on it —
  // `destroyedBody`, a prose floor at half the document. A demotion cannot move that floor by
  // construction: `<h2>Costs</h2>` -> `<p><strong>Costs</strong></p>` keeps every word and grows the
  // bytes. So the outline fell here with nothing said about it anywhere.
  //
  // It is still delivered, deliberately. There are no blocks on this path, so the only refusal
  // expressible is the whole reply — which is what #331 did on the patch path in its first version
  // and was changed away from, because the commonest false positive is a correction axe asks for by
  // name. What this needs first is the rate, and the rate is what this line is.
  const demoted = `<h1>Report</h1>\n\n<p><strong>Costs</strong></p>\n\n<p>${"word ".repeat(80)}</p>\n\n<ul><li>a</li><li>b</li><li>c</li></ul>\n`;
  const { result, events } = await round(() => ({ html: demoted }), WHOLE_OUTLINE, 1);
  assert.match(result.body, /<p><strong>Costs<\/strong><\/p>/, "the reply is applied, not refused");
  assert.equal(events.filter((e) => e.type === "editor_patch").length, 0, "this is the whole-body path");
  const nav = events.filter((e) => e.type === "editor_navigation");
  assert.equal(nav.length, 1);
  assert.equal(nav[0]!.data.stage, "whole_body");
  assert.equal(nav[0]!.data.headings, 1);
  // The two kinds that are reported and never gate are collected on the same line, because deciding
  // whether they ever COULD gate is what the population is for: a `<ul>` flattened into paragraphs
  // is a real loss and a `<ul>` rewritten as the `<dl>` agents/page.md asks for is a correction, and
  // no round on file separates them.
  const flattened = await round(
    () => ({ html: `<p><strong>Report</strong></p>\n\n<h2>Costs</h2>\n\n<p>${"word ".repeat(80)}</p>\n\n<p>a</p>\n<p>b</p>\n<p>c</p>\n` }),
    WHOLE_OUTLINE,
    1,
  );
  const both = flattened.events.find((e) => e.type === "editor_navigation");
  assert.equal(both?.data.headings, 1);
  assert.equal(both?.data.items, 3);
});

test("the whole-body line prints on a round that lost nothing, because a rate needs its denominator", async () => {
  // A log that speaks only when it has a finding cannot tell a path nothing fell on from a path
  // nothing took, and #375 is asking how OFTEN this happens. So the line is per delivered reply and
  // the counts are what is conditional.
  const { events } = await round(
    () => ({ html: `<h1>Report</h1>\n\n<h2>Costs</h2>\n\n<p>${"word ".repeat(80)} And a sentence.</p>\n\n<ul><li>a</li><li>b</li><li>c</li></ul>\n` }),
    WHOLE_OUTLINE,
    1,
  );
  const nav = events.find((e) => e.type === "editor_navigation");
  assert.deepEqual(nav?.data, { stage: "whole_body" }, "a clean round is a row in the denominator");
});

test("a whole-body reply that shortened the prose says so, instead of reading as nothing lost", async () => {
  // The third state, and the reason it is named rather than left as an empty reading: the structure
  // reading is silenced wherever the prose shortened, because a deletion the prompt sanctions takes
  // its own words and that is the ordinary shape of a correction rather than damage. An empty
  // reading there means "not asked", and folding it in with "nothing fell" would put rounds this
  // never looked at into the denominator of a rate about rounds it did.
  //
  // Both at once, so the round that is sanctioned and silent in one reply — the shape patch.ts
  // names as the one this contract cannot tell apart — is on the line as the silence it is: the
  // heading is demoted AND a paragraph is shortened, and `headings` is absent.
  const { result, events } = await round(
    () => ({ html: `<h1>Report</h1>\n\n<p><strong>Costs</strong></p>\n\n<p>${"word ".repeat(40)}</p>\n\n<ul><li>a</li><li>b</li><li>c</li></ul>\n` }),
    WHOLE_OUTLINE,
    1,
  );
  assert.match(result.body, /<p><strong>Costs<\/strong><\/p>/, "still not refused: the floor is at half");
  const nav = events.find((e) => e.type === "editor_navigation");
  assert.deepEqual(nav?.data, { stage: "whole_body", shortened: true });
});

test("half a move is not applied: a refusal beside a block that gave content up costs the round", async () => {
  // Per-edit refusal is the right rule for independent edits and the wrong one for a MOVE, which
  // this contract makes a pair — the block the content lands in, and the block it came from. Take
  // the source half and refuse the landing half and the content is simply gone: the floor cannot
  // see one paragraph, the next Reader round reads a document that no longer mentions it, and the
  // block it was moving out of is left without it.
  //
  // So a reply holding a refusal beside either form of the source half is not applied in part,
  // whether or not those two edits were actually a pair. Being wrong about that costs one round;
  // being wrong the other way costs the deliverable.
  const { result, events } = await round(() => ({
    edits: [
      { block: 4, html: `<p>Two. And the list's items.` }, // where the content was to land
      { block: 2, html: "" }, // and the block it was to come from
    ],
  }), BODY, 1);
  assert.equal(result.body, BODY, "the body that entered the round is what is delivered");
  assert.match(result.body, /<ul><li>a<\/li>/, "the block the reply emptied still has its content");
  const patch = events.find((e) => e.type === "editor_patch");
  assert.equal(patch?.data.deleted, 1, "the counters still say what became of each edit");
  assert.equal(patch?.data.incomplete, 1);
  assert.equal(patch?.data.discarded, "refusal_with_loss");
  // A retry, not a decision: the loop must not read the untouched body as a convergence.
  assert.equal(events.filter((e) => e.type === "review_converged").length, 0);
  // The OTHER form of the source half, and the commoner one: the prompt offers "with what is left
  // of it, or `""` if nothing is", so a move usually leaves the block it came from standing with
  // less in it than before. A rule that read only the emptying would let this through — and this
  // one is worse to miss, because a shrunken block looks like an ordinary correction on the line.
  const shrinking = await round(() => ({
    edits: [
      { block: 4, html: `<p>Two. And item b.` }, // the landing half, malformed
      { block: 2, html: `<ul><li>a</li></ul>` }, // the source half, one item lighter
    ],
  }), BODY, 1);
  assert.equal(shrinking.result.body, BODY, "the block that gave an item up still has it");
  const shrank = shrinking.events.find((e) => e.type === "editor_patch");
  assert.equal(shrank?.data.shrunk, 1);
  assert.equal(shrank?.data.deleted, 0, "nothing was emptied, which is why `deleted` alone is not the test");
  assert.equal(shrank?.data.discarded, "refusal_with_loss");
  // And the rule is narrow. A refusal beside a replacement that gave nothing up is still contained
  // to its own block — that is the containment the contract is for — and a block that gave content
  // up with nothing refused is an ordinary correction.
  const contained = await round(() => ({
    // Longer than the block it replaces, so no content left the document and there is no half of a
    // move for the refusal below to be the other side of.
    edits: [{ block: 0, html: `<h1>Manual, corrected</h1>` }, { block: 4, html: `<p>Two.` }],
  }), BODY, 1);
  assert.match(contained.result.body, /<h1>Manual, corrected<\/h1>/);
  assert.ok(!("discarded" in (contained.events.find((e) => e.type === "editor_patch")?.data ?? {})));
  const deleting = await round(() => ({ edits: [{ block: 2, html: "" }] }), BODY, 1);
  assert.doesNotMatch(deleting.result.body, /<ul>/);
  assert.ok(!("discarded" in (deleting.events.find((e) => e.type === "editor_patch")?.data ?? {})));
  // A shrinking replacement on its own is how this contract removes content the document printed
  // twice, so it applies and is counted — the count is worth reading whether or not a round was
  // thrown away.
  const trimming = await round(() => ({ edits: [{ block: 2, html: `<ul><li>a</li></ul>` }] }), BODY, 1);
  assert.match(trimming.result.body, /<ul><li>a<\/li><\/ul>/);
  const trimmed = trimming.events.find((e) => e.type === "editor_patch");
  assert.equal(trimmed?.data.shrunk, 1);
  assert.ok(!("discarded" in (trimmed?.data ?? {})));
});

test("the half of a move that carries no words counts too: an image or a link leaving a block", async () => {
  // A source block can give up something that is not prose. `visibleText` throws tags and
  // attributes away, so a figure that hands back its caption and drops the image compares EQUAL on
  // the words — and an image with its alt text leaving the deliverable is a worse loss than a
  // sentence, not a smaller one. Same for a link: the words stay, the destination goes.
  //
  // Read with `structureCounts`, which already counts both for this reason (correction.ts: "`<a>` is
  // counted although `droppedHrefs` already watches URLs … Same for `<img>`, whose alt text has its
  // own signal in this module and whose disappearance has none").
  const FIGURED = `<h1>M</h1>\n<figure><img src="a.png" alt="A bar chart of yields"><figcaption>Fig 1. Yields</figcaption></figure>\n<p>Two.</p>\n`;
  const moved = await round(() => ({
    edits: [
      { block: 2, html: `<p>Two.<figure><img src="a.png" alt="A bar chart of yields">` }, // landing, cut off
      { block: 1, html: `<figure><figcaption>Fig 1. Yields</figcaption></figure>` }, // source, image gone
    ],
  }), FIGURED, 1);
  assert.equal(moved.result.body, FIGURED, "the figure keeps its image");
  const fig = moved.events.find((e) => e.type === "editor_patch");
  assert.equal(fig?.data.shrunk, 1, "one image fewer is content given up, though the prose is identical");
  assert.equal(fig?.data.discarded, "refusal_with_loss");
  const LINKED = `<h1>M</h1>\n<p>See <a href="#appendix-a">Appendix A</a>.</p>\n<p>Two.</p>\n`;
  const unlinked = await round(() => ({
    edits: [
      { block: 2, html: `<p>Two. See <a href="#appendix-a">Appendix A</a>.` }, // landing, cut off
      { block: 1, html: `<p>See Appendix A.</p>` }, // source, the same words with nowhere to go
    ],
  }), LINKED, 1);
  assert.equal(unlinked.result.body, LINKED, "the reference keeps its href");
  assert.equal(unlinked.events.find((e) => e.type === "editor_patch")?.data.discarded, "refusal_with_loss");
  // And it stays narrow in the direction that matters: the structural fix this contract is FOR must
  // not read as a loss. Unwrapping a mis-structured block is shorter markup carrying every word,
  // every image and every link.
  const WRAPPED = `<h1>M</h1>\n<div><p>See <a href="#page-2">page 2</a>.</p><figure><img src="a.png" alt="A chart"></figure></div>\n<p>Two.</p>\n`;
  const unwrapped = await round(() => ({
    edits: [
      { block: 1, html: `<p>See <a href="#page-2">page 2</a>.</p>\n<figure><img src="a.png" alt="A chart"></figure>` },
      { block: 2, html: `<p>Two.` }, // a refusal in the same reply, which is what would discard the round
    ],
  }), WRAPPED, 1);
  const unwrap = unwrapped.events.find((e) => e.type === "editor_patch");
  assert.equal(unwrap?.data.applied, 1);
  assert.ok(!("shrunk" in (unwrap?.data ?? {})), "fewer bytes, the same document");
  assert.ok(!("discarded" in (unwrap?.data ?? {})), "so the refusal beside it costs its own block only");
  assert.match(unwrapped.result.body, /<h1>M<\/h1>\n<p>See <a href="#page-2">page 2<\/a>\.<\/p>/);
});

// --- the loss with no words in it (issue #271) ---

// A document whose whole value to a screen-reader user is in its structure: an outline to jump by,
// a list announced as having two items, a table walked row by row.
const OUTLINED = `<h1>Manual</h1>
<h2>Cleaning the filter</h2>
<ul><li>Unclip the cover</li><li>Rinse the mesh</li></ul>
<table><tr><th>Part</th><th>Code</th></tr><tr><td>Filter</td><td>A1</td></tr><tr><td>Cover</td><td>A2</td></tr></table>
`;

test("a structure a reader navigates by can leave a block with no word leaving with it", () => {
  // The third shape of loss, after prose and after the two wordless things. Each of these
  // replacements is a faithful transcription of its block — every word in the same order, and the
  // last two are LONGER in bytes — and each takes away the only means a reader had of finding that
  // content: the heading list, the "list, 2 items" announcement, the row-by-row walk.
  const patched = applyBlockEdits(blocksOf(OUTLINED), [
    { block: 1, html: `<p>Cleaning the filter</p>` },
    { block: 2, html: `<p>Unclip the cover</p>\n<p>Rinse the mesh</p>` },
    { block: 3, html: `<table><tr><th>Part</th><th>Code</th></tr><tr><td>Filter</td><td>A1</td><td>Cover</td><td>A2</td></tr></table>` },
  ]);
  assert.equal(patched.applied, 3);
  // Every one of them is prose-identical, which is the whole point: `text_chars_*` on the `editor`
  // line, `destroyedBody`'s floor and `shrunk`'s prose reading all say this round was clean.
  assert.equal(visibleText(OUTLINED), visibleText(patched.body));
  // Counted per kind and by how many went, summed over the blocks: one heading is a repeated title
  // resolved too thoroughly, and 84 is a document flattened.
  assert.deepEqual(patched.navigation_lost, { headings: 1, items: 2, rows: 1 });
  // Only the heading counts as content given up, and the other two are reported without gating —
  // `GATED` has the reason, which is that a `<ul>` rewritten as a `<dl>` and a table corrected into
  // the list it should have been move `items` and `rows` down on rounds that are doing their job.
  assert.equal(patched.shrunk, 1);
});

test("the corrections this loop asks for are not that, and none of them costs the round", () => {
  // The direction that decides whether the reading above is worth having, since a signal that fires
  // on the work is worse than no signal. Each of these is a correction EDITOR_SYSTEM sanctions by
  // name or a fix the Reader raises, and each moves some structure count down.
  const patched = applyBlockEdits(blocksOf(OUTLINED), [
    // "fix heading hierarchy" — which is why `structureCounts` folds h1-h6 into one number, and why
    // this reading can be had at all: re-levelling does not move it.
    { block: 1, html: `<h3>Cleaning the filter</h3>` },
    // A list rewritten as the definition list `agents/page.md` asks for. This is the one that
    // decided the shape of the rule: `items` 2 -> 0 with every word in place, on a round that did
    // exactly what it should — so `items` is reported and not gated. (`terms` is not read at all;
    // the reverse rewrite is the measured round `EDITOR_SHRINK_FLOOR` is placed off, 55 terms to 3
    // with the prose moving 0.3%.)
    { block: 2, html: `<dl><dt>Unclip</dt><dd>the cover</dd><dt>Rinse</dt><dd>the mesh</dd></dl>` },
    // "correct labels and table headers": `<td>` -> `<th>` takes `cells` down by exactly the number
    // corrected, so a rule that read cells would fire on every table it fixed.
    { block: 3, html: `<table><tr><th scope="col">Part</th><th scope="col">Code</th></tr><tr><th scope="row">Filter</th><td>A1</td></tr><tr><th scope="row">Cover</th><td>A2</td></tr></table>` },
  ]);
  assert.equal(patched.applied, 3);
  assert.equal(patched.shrunk, 0, "not one of them may cost the round the rest of its corrections");
  // The heading is not merely un-gated, it did not move: folding h1-h6 is what makes the reading
  // above possible at all. The `<dl>` rewrite is reported, and that is all it is.
  assert.deepEqual(patched.navigation_lost, { items: 2 });
  // And the container counts, for the same reason: two of anything the extractor split across a page
  // turn, merged back into one, is a fall on a round that did its job.
  const merged = applyBlockEdits(blocksOf(`<div><p>One.</p><p>Two.</p></div>\n`), [
    { block: 0, html: `<p>One. Two.</p>` },
  ]);
  assert.equal(merged.shrunk, 0, "paragraphs 2 -> 1, every word in place");
});

test("a reorder is two blocks changing places, not a heading lost, and the two readings say so differently", () => {
  // The grain the measurement is read at, and why it is not the grain `shrunk` is read at.
  // EDITOR_SYSTEM sanctions "reorder blocks", and under this contract a reorder is a pair of edits:
  // one block gives the heading up and another takes it. A sum of per-block FALLS would report that
  // as a heading lost, on a document that kept every one — which is the same class of false positive
  // the prose condition exists to exclude, and worse here, because this number's whole use is to be
  // the clean population.
  const ORDERED = `<h1>Manual</h1>\n<h2>Notes</h2>\n<p>Body text here.</p>\n`;
  const swapped = applyBlockEdits(blocksOf(ORDERED), [
    { block: 1, html: `<p>Body text here.</p>` },
    { block: 2, html: `<h2>Notes</h2>` },
  ]);
  // The same words in a different order, which is what a reorder is — so the length the reading
  // compares is equal while the text is not.
  assert.equal(visibleText(swapped.body).length, visibleText(ORDERED).length);
  assert.deepEqual(swapped.navigation_lost, {}, "the document has the heading it started with");
  // `shrunk` still counts both halves, and that is correct rather than a leftover: its job is to spot
  // the source half of a move, so that a refusal on the landing half cannot take the heading with it.
  // Read on the joined body it would be silent here, and a reorder whose landing half was refused
  // would ship a document with one heading fewer and nothing to say so.
  assert.equal(swapped.shrunk, 2);
});

test("a navigable count falling beside a word loss is the sanctioned deletion, and stays out of the new number", async () => {
  // The rule's substantive half. Dropping a title the pages reprinted is the removal EDITOR_SYSTEM
  // spends a paragraph asking for, and it takes that title's words with it — so it is already
  // `shrunk` on the prose, and counting it here as well would put the sanctioned case and the silent
  // one in one number and leave neither readable.
  const REPRINTED = `<h1>Manual</h1>\n<div><h2>Operation</h2><p>More.</p></div>\n<p>End.</p>\n`;
  const deduped = await round(() => ({ edits: [{ block: 1, html: `<div><p>More.</p></div>` }] }), REPRINTED, 1);
  const dedupe = deduped.events.find((e) => e.type === "editor_patch");
  assert.equal(dedupe?.data.shrunk, 1);
  assert.ok(!("navigation_lost" in (dedupe?.data ?? {})), "a heading gone with its words is the old signal's business");
  // And therefore not gated by #331 either, which is the half of that rule doing the work: the
  // deletion EDITOR_SYSTEM asks for takes the title's words with it, so the prose shortens, so
  // `navigationLost` is silent and the round is applied. A gate read off `structureCounts` alone
  // would refuse this round — the commonest correction the loop makes — every time.
  assert.ok(!("discarded" in (dedupe?.data ?? {})), "the sanctioned deletion still ships");
  assert.match(deduped.result.body, /<div><p>More\.<\/p><\/div>/);

  // Whereas the same heading demoted, words intact, reaches the line — and since #331 that block is
  // handed back, with no refusal anywhere in the reply. The count is still on the line, because the
  // magnitude is what says whether this was one repeated title resolved too thoroughly or a document
  // being flattened.
  const demoted = await round(() => ({ edits: [{ block: 1, html: `<div><p>Operation</p><p>More.</p></div>` }] }), REPRINTED, 1);
  const demote = demoted.events.find((e) => e.type === "editor_patch");
  assert.equal(demoted.result.body, REPRINTED, "the heading is still a heading in the delivered body");
  // `applied: 0` and `headings_reverted: [1]` rather than `applied: 1`: the one edit in this reply is
  // the demotion, so handing that block back leaves nothing applied at all. The counts on this line are
  // what SHIPPED, which is the same thing they mean beside `incomplete` or `unknown`.
  assert.equal(demote?.data.applied, 0, "the demoted block was handed back, so nothing applied");
  assert.deepEqual(demote?.data.headings_reverted, [1]);
  assert.ok(!("shrunk" in (demote?.data ?? {})), "the block that shrank is not in the delivered body");
  assert.deepEqual(demote?.data.navigation_lost, { headings: 1 }, "the reply AS SENT is what this reads");
  // And still `discarded`, because a reply whose every edit was handed back changes nothing — crediting
  // that as usable would read an untouched document as a converged one.
  assert.equal(demote?.data.discarded, "headings_lost");

  // And beside a refusal it is the half of a move that gates, which is what `shrunk` is for: take
  // the source half of a move and refuse the landing half and the heading is simply gone.
  const halved = await round(() => ({
    edits: [
      { block: 2, html: `<div><p>End.</p><h2>Operation</h2>` }, // landing, left open
      { block: 1, html: `<div><p>Operation</p><p>More.</p></div>` }, // source, the outline gone
    ],
  }), REPRINTED, 1);
  assert.equal(halved.result.body, REPRINTED, "the round costs itself, not the document");
  const half = halved.events.find((e) => e.type === "editor_patch");
  assert.equal(half?.data.discarded, "refusal_with_loss");
  assert.deepEqual(half?.data.navigation_lost, { headings: 1 }, "on the line whether or not the round survived");
});

// --- the heading gate (#331) ---

// The round #331 was filed on, in the shape it arrived in: every edit applied, nothing refused,
// nothing unknown, nothing incomplete, the visible text the same length either side — and five `<h2>`
// headings rewritten to `<p><strong>` on blocks no issue had named. Every guard in patch.ts passed it
// and `refused > 0` was the conjunct that kept the gate shut, so the document shipped without them.
//
// Five, and the imitation left in place, because both are the point. `<strong>` keeps the rendered
// page identical, so nothing a sighted reviewer looks at moves; the words are all there, so no length
// pair moves and `destroyedBody` cannot see it; and what a screen-reader user lost is the whole
// heading outline of the document, which is the only means they had of reaching the third of five
// sections. `navigation_lost` was on the log line for all of it and gated nothing.
const OUTLINE =
  `<h1>Pay Schedules</h1>\n` +
  [
    ["Standby Pay.", "Paid at one half of the base rate for each hour on call."],
    ["Holiday Pay.", "Paid at twice the base rate for each hour worked."],
    ["Shift Differential.", "Paid at one tenth of the base rate for evening hours."],
    ["Overtime.", "Paid at one and one half of the base rate beyond forty hours."],
    ["Severance.", "Paid at the base rate for one week of each year served."],
  ]
    .map(([h, p]) => `<h2>${h}</h2>\n<p>${p}</p>`)
    .join("\n") +
  `\n`;

// Every `<h2>` in the document as it was SHOWN, demoted to the paragraph that imitates it, one block
// edit each. Read off the annotated copy rather than off the body, because that is the copy the model
// answers about and the block numbers in it are the ones it would quote back.
const demoteEveryHeading = (shown: string) =>
  [...shown.matchAll(/<!-- @block (\d+) -->\n<h2>(.*?)<\/h2>/g)].map((m) => ({
    block: Number(m[1]),
    html: `<p><strong>${m[2]}</strong></p>`,
  }));

test("a heading demoted out of the document is handed back, with nothing refused beside it", async () => {
  const { result, events } = await round((shown) => ({ edits: demoteEveryHeading(shown) }), OUTLINE, 1);
  const patch = events.find((e) => e.type === "editor_patch");
  // The reply was well-formed and every edit in it was one of the five demotions, so all five blocks
  // are handed back and nothing survives to be applied. `headings_reverted` is the record of that,
  // named by block, and it is what distinguishes this from every other guard on this line.
  assert.equal(patch?.data.applied, 0);
  assert.deepEqual(patch?.data.headings_reverted, [1, 3, 5, 7, 9], "the five `<h2>` blocks, by number");
  for (const clean of ["unknown", "duplicate", "incomplete", "unreadable"]) {
    assert.ok(!(clean in (patch?.data ?? {})), `nothing was refused, so no \`${clean}\` on the line`);
  }
  assert.deepEqual(patch?.data.navigation_lost, { headings: 5 });
  assert.equal(patch?.data.discarded, "headings_lost");
  // Not the unattributable case: no block in this reply GAINED a heading, which is the licence for
  // handing the source blocks back at all.
  assert.ok(!("headings_gained" in (patch?.data ?? {})));
  // Not `refusal_with_loss`, although #331 proposed reusing it: there is no refusal in this reply,
  // and a reader of the log told there was would go looking for an edit that was never sent.
  assert.notEqual(patch?.data.discarded, "refusal_with_loss");

  // What the gate is for. The delivered body is the one that entered, headings and all.
  assert.equal(result.body, OUTLINE);
  assert.equal((result.body.match(/<h2>/g) ?? []).length, 5);
  assert.doesNotMatch(result.body, /<p><strong>Standby Pay\.<\/strong><\/p>/);
  // And the round is a retry, not an answer: the loop must not read the untouched body as the editor
  // having decided the document was fine. The whole cost of a false positive here is this one round.
  assert.equal(events.filter((e) => e.type === "review_converged").length, 0);
  // The one fact about it that outlives the round, for the deployment-wide rate (#331's second ask).
  assert.equal(result.editorHeadingsGated, true);
});

test("the demotion costs its own block and nothing else in the reply", async () => {
  // The finding that narrowed this gate, asserted. The first version discarded the whole reply, so a
  // heading correctly re-expressed as a `<label>` — a fix for axe's `label` rule, which is `wcag2a` and
  // in the active tag set, so a violation the Reader raises and the editor is TOLD to make — cost every
  // other correction in the same reply. On every round, because the retry re-sends the same body and
  // the same issues to the same model.
  //
  // So: one block handed back, the rest of the reply delivered. This is the shape that reaches a real
  // deployment, and it is the one the old behaviour got most wrong.
  const FORM =
    `<h1>Claim Form</h1>\n` +
    `<form><h4>Name</h4><input id="name"><h4>Date</h4><input id="date"></form>\n` +
    `<p>Return the form to the address below.</p>\n` +
    `<img src="seal.png">\n`;
  const { result, events } = await round(() => ({
    edits: [
      // The false positive: every word kept, `headings` down by two, and `structureCounts` cannot see
      // a `<label>` arriving because it does not count `<label>` at all.
      { block: 1, html: `<form><label for="name">Name</label><input id="name"><label for="date">Date</label><input id="date"></form>` },
      // The corrections that used to go down with it.
      { block: 3, html: `<img src="seal.png" alt="Department seal.">` },
    ],
  }), FORM, 1);
  const patch = events.find((e) => e.type === "editor_patch");
  assert.deepEqual(patch?.data.navigation_lost, { headings: 2 }, "the fall is still read and still on the record");
  assert.deepEqual(patch?.data.headings_reverted, [1], "the block that dropped them, and only that block");
  assert.equal(patch?.data.applied, 1, "the other edit shipped");
  // The whole point: the alt text is in the delivered document.
  assert.match(result.body, /alt="Department seal\."/);
  // And the form's headings are back, exactly as they were.
  assert.equal((result.body.match(/<h4>/g) ?? []).length, 2);
  assert.doesNotMatch(result.body, /<label for="name">/);
  // The round is USABLE — a correction was delivered, so `body` moves on and the loop is not spending a
  // round on nothing. That is the difference from the version this replaces, and it is why the signal
  // below cannot be read off `discarded`.
  assert.ok(!("discarded" in (patch?.data ?? {})), "part of the reply was kept, so the round was not refused");
  assert.equal(result.editorHeadingsGated, true, "the guard still says it fired");
});

test("a block that gave its words to another block is not re-seated, because that would print them twice", async () => {
  // The mirror image of the reorder case, and the one `headings_gained` cannot see: the thing that
  // migrated is not a heading. The extractor emits the field label as a stray `<h4>` SIBLING of the
  // form — the ordinary shape, not the same-wrapper shape — so the fix axe's `label` rule asks for is
  // two edits: empty the stray block, seat the label inside the form. The document keeps every word
  // (`navigation_lost` is populated at all only because "Name" is still in the body) and `headings`
  // falls by one, so this reaches the salvage with `headings_gained: 0`.
  //
  // Handing block 1 back would put its `<h4>Name</h4>` next to the `<label>Name</label>` that now
  // holds the same words: content duplicated and a heading invented that heads nothing, in a body
  // neither the editor nor the extractor produced. The re-applied check cannot catch it, because with
  // the `<h4>` back the count is whole again. So a block that gave content up is never re-seated, and
  // a reply with nothing left to hand back is refused whole.
  const SIBLING =
    `<h1>Form</h1>\n` +
    `<h4>Name</h4>\n` +
    `<form><p>Enter it.</p><input id="name"></form>\n`;
  const { result, events } = await round(() => ({
    edits: [
      { block: 1, html: `` },
      { block: 2, html: `<form><p>Enter it.</p><label for="name">Name</label><input id="name"></form>` },
    ],
  }), SIBLING, 1);
  const patch = events.find((e) => e.type === "editor_patch");
  assert.deepEqual(patch?.data.navigation_lost, { headings: 1 }, "the fall is read: the words stayed, the heading did not");
  assert.ok(!("headings_gained" in (patch?.data ?? {})), "nothing arrived as a heading, which is why the other guard is blind to this");
  assert.ok(!("headings_reverted" in (patch?.data ?? {})), "and the block that dropped it is the block that emptied, so it is not handed back");
  assert.equal(patch?.data.discarded, "headings_lost", "leaving nothing to seat, which is refused whole");
  assert.deepEqual(patch?.data.headings_dropped, [1], "and the line says WHICH block fell and could not be handed back");
  assert.equal(result.body, SIBLING, "the document that entered — not one carrying `Name` twice");
  assert.equal((result.body.match(/Name/g) ?? []).length, 1, "once, in one place");
  assert.equal(result.editorHeadingsGated, true);
});

test("a block that sheds the heading's words while GROWING is not re-seated either", async () => {
  // The reading is an inequality, not a shortfall, and this is the input that settles which. A block
  // can hand the heading's words to another edit and come back LONGER — reword what survives, gain a
  // piece of alt text — and "did this block get shorter" calls that no loss at all. The block would
  // then be re-seated over an edit already holding those words, and the fail-closed re-check cannot
  // see it: with the `<h4>` back the document's count is whole again.
  //
  // Nothing else separates this from the case above. The document's own prose GREW, so the joined
  // reading is populated; no heading arrived, so `headings_gained` is 0; the block is not shorter, so a
  // shortfall test passes it. Only "the words it gave up are in block 2 now" refuses it — and the
  // length licence #376 refutes passes it by a mile, the re-applied body being 24 characters of prose
  // against the patched body's 59, because the edit that grew is the one being reverted.
  const GROWN =
    `<h1>Form</h1>\n` +
    `<div><h4>Name</h4><p>Enter it.</p></div>\n` +
    `<form><input id="name"></form>\n`;
  const { result, events } = await round(() => ({
    edits: [
      { block: 1, html: `<div><p>Enter it. Please print clearly in block capitals.</p></div>` },
      { block: 2, html: `<form><label for="name">Name</label><input id="name"></form>` },
    ],
  }), GROWN, 1);
  const patch = events.find((e) => e.type === "editor_patch");
  // `shrunk` is on the line, and it is on it for the HEADING and not for the words: `gaveContentUp`
  // reads a heading fall as content given up, so every block that drops one is `shrunk` and in `lost`
  // whatever became of its text. That is why neither can be the seatability reading, and why this
  // needed one of its own.
  assert.equal(patch?.data.shrunk, 1);
  assert.deepEqual(patch?.data.navigation_lost, { headings: 1 }, "and the document still lost a heading");
  assert.ok(!("headings_reverted" in (patch?.data ?? {})), "so it is not handed back");
  assert.equal(patch?.data.discarded, "headings_lost");
  assert.equal(result.body, GROWN, "the document that entered");
  assert.equal((result.body.match(/Name/g) ?? []).length, 1, "`Name` once, not once in the heading and once in the label");
  assert.deepEqual(patch?.data.headings_dropped, [1], "the block that fell and could not be handed back");
  assert.ok(!("headings_recheck" in (patch?.data ?? {})), "refused because the words landed, not by the fail-closed re-check");
});

test("a block that demoted a heading and corrected its own words is handed back, not the round", async () => {
  // The case #336 left paying the whole-round price (#376). A block can demote a heading AND fix a typo
  // in the same edit — one `<div>`, two things done to it, one of them wanted — and "are these the words
  // it had" is false for the typo, so the block was unseatable, so a reply whose only demotion was this
  // block was refused entire. Nothing moved anywhere: the words the block gave up are `teh`, and no
  // other edit took them.
  //
  // The typo has to be length-preserving for the round to reach the gate at all, and that is the
  // reading's documented coarseness rather than a property of this test: a correction that SHORTENS the
  // document's prose silences `navigation_lost` for the whole round (see `navigationLost`), so the
  // demotion beside it ships unseen. `teh` -> `the` is a transposition, so the prose is 34 characters
  // either side and the fall is read.
  const TYPO =
    `<h1>Pay</h1>\n` +
    `<div><h2>Standby Pay.</h2><p>Paid at teh rate.</p></div>\n` +
    `<img src="seal.png">\n`;
  const { result, events } = await round(() => ({
    edits: [
      { block: 1, html: `<div><p><strong>Standby Pay.</strong></p><p>Paid at the rate.</p></div>` },
      { block: 2, html: `<img src="seal.png" alt="Department seal.">` },
    ],
  }), TYPO, 1);
  const patch = events.find((e) => e.type === "editor_patch");
  assert.deepEqual(patch?.data.navigation_lost, { headings: 1 }, "the fall is read: the prose did not move");
  assert.deepEqual(patch?.data.headings_reverted, [1], "and the block is handed back, which is what #376 asked for");
  assert.ok(!("discarded" in (patch?.data ?? {})), "the round is NOT refused — this is the whole change");
  assert.ok(!("headings_dropped" in (patch?.data ?? {})), "nothing was unattributable");
  assert.equal(patch?.data.applied, 1, "so the other correction in the reply ships");
  assert.match(result.body, /alt="Department seal\."/, "the alt text is in the delivered document");
  assert.match(result.body, /<h2>Standby Pay\.<\/h2>/, "and the heading is back");
  // What the re-seat costs, stated rather than hidden: the block goes back as it stood, so its typo fix
  // goes back with it. The alternative was losing that fix AND the alt text AND the round.
  assert.match(result.body, /Paid at teh rate\./, "the typo the same edit fixed is reverted with the block");
  assert.equal(result.editorHeadingsGated, true, "the guard fired, and says so, on a round it did not refuse");
});

test("the revert cannot take the re-applied body under the prose floor and ship a held block's demotion", async () => {
  // Found in review round 2 of #383 and it was a REGRESSION, not the latent case it was filed as: this
  // reply is refused on `main` and was delivered here, one heading short of the document that entered.
  //
  // The route is the guard's own remedy defeating its own check. `navigationLost` is silent wherever the
  // body it reads is shorter in prose than the body that went in, and REVERTING AN EDIT THAT ADDED PROSE
  // is a way under that floor:
  //
  //   - block 1 demotes a heading and sheds a duplicated sentence, and block 2's edit happens to take the
  //     words it shed, so block 1 is `content_landed` and is held — it keeps its edit;
  //   - block 2 demotes a heading and adds MORE prose than block 1 shed, so the fully patched body is not
  //     shorter and the fall is read (48 -> 95 characters of prose);
  //   - block 2 is the only seatable block, so it is handed back, and the re-applied body is the input
  //     minus block 1's sentence: 36 against 48, under the floor, `navigation_lost` empty.
  //
  // So the joined reading cannot be the whole test. `kept.headings_dropped` is asked first and does not
  // depend on the prose: block 1 still has its edit, so its fall is still named.
  const FLOOR =
    `<h1>Doc</h1>\n` +
    `<div><h2>Fees</h2><p>Fees apply. Fees apply.</p></div>\n` +
    `<div><h3>Notes</h3><p>See page.</p></div>\n`;
  const { result, events } = await round(() => ({
    edits: [
      { block: 1, html: `<div><p><strong>Fees</strong></p><p>Fees apply.</p></div>` },
      { block: 2, html: `<div><p><strong>Notes</strong></p><p>See page. Fees apply here as well, and then some more prose besides.</p></div>` },
    ],
  }), FLOOR, 1);
  const patch = events.find((e) => e.type === "editor_patch");
  assert.deepEqual(patch?.data.navigation_lost, { headings: 2 }, "the reply as sent lost two");
  assert.equal(patch?.data.discarded, "headings_lost", "and the round is refused rather than part-delivered");
  assert.deepEqual(patch?.data.headings_dropped, [1, 2]);
  assert.ok(!("headings_recheck" in (patch?.data ?? {})), "block 1 accounts for the surviving fall");
  assert.equal(result.body, FLOOR, "the document that entered, with every heading it entered with");
  assert.equal((result.body.match(/<h[1-6][ >]/g) ?? []).length, 3, "h1, h2 and h3 all still there");
});

test("a reply that demotes in two places, one of them a migration, is the migrated case and not a re-check", async () => {
  // Found by the review of #383, reproduced before it was believed. Only the SEATABLE blocks are handed
  // back, so a block that dropped a heading and gave its content away keeps its edit — and keeps its
  // fall. The re-applied body therefore still has a fall in it, and the fail-closed re-check catches a
  // round that is nothing more unusual than two demotions in one reply, one of them the `<label>`
  // migration this file calls the commonest form of the hazard.
  //
  // The outcome was right (the round is refused, the body handed back untouched) and the LABEL was
  // wrong: `headings_recheck` told whoever greps it that the reading is broken. So the branch splits on
  // whether any block still dropping a heading accounts for the fall. Here block 1 does.
  const MIXED =
    `<h1>Form</h1>\n` +
    `<h4>Name</h4>\n` +
    `<form><input id="name"></form>\n` +
    `<div><h2>Standby Pay.</h2><p>Paid at the rate.</p></div>\n`;
  const { result, events } = await round(() => ({
    edits: [
      { block: 1, html: `` },
      { block: 2, html: `<form><label for="name">Name</label><input id="name"></form>` },
      { block: 3, html: `<div><p><strong>Standby Pay.</strong></p><p>Paid at the rate.</p></div>` },
    ],
  }), MIXED, 1);
  const patch = events.find((e) => e.type === "editor_patch");
  assert.deepEqual(patch?.data.navigation_lost, { headings: 2 }, "two demotions, both read");
  assert.equal(patch?.data.discarded, "headings_lost", "and the round is refused, which is unchanged");
  assert.equal(result.body, MIXED, "the document that entered");
  assert.deepEqual(patch?.data.headings_dropped, [1, 3], "both blocks that fell are named");
  assert.ok(
    !("headings_recheck" in (patch?.data ?? {})),
    "NOT the re-check marker: block 1's fall is accounted for, so nothing here says the reading is wrong");
  assert.ok(!("headings_reverted" in (patch?.data ?? {})), "and nothing was delivered, so nothing was handed back");
});

test("the words are matched as words, so a label that repunctuates them is still not re-seated", async () => {
  // Why the containment reading is not a string comparison. The words are RE-EXPRESSED where they land
  // rather than copied: `<h4>Name</h4>` emptied while the `<label>` that takes its place writes `Name:`.
  // A comparison of the block's visible text against the landing block's would see two different
  // strings and hand the `<h4>` back over a `<label>` already holding it.
  const COLON =
    `<h1>Form</h1>\n` +
    `<h4>Name</h4>\n` +
    `<form><p>Enter it.</p><input id="name"></form>\n`;
  const { result, events } = await round(() => ({
    edits: [
      { block: 1, html: `` },
      { block: 2, html: `<form><p>Enter it.</p><label for="name">Name:</label><input id="name"></form>` },
    ],
  }), COLON, 1);
  const patch = events.find((e) => e.type === "editor_patch");
  assert.deepEqual(patch?.data.navigation_lost, { headings: 1 });
  assert.equal(patch?.data.discarded, "headings_lost", "the words landed, so there is nothing to seat");
  assert.deepEqual(patch?.data.headings_dropped, [1]);
  assert.equal(result.body, COLON, "and the document is the one that entered");
  assert.equal((result.body.match(/Name/g) ?? []).length, 1);
});

test("a block that already had the word is still a landing block, so the arrival is counted not looked up", async () => {
  // The input that decides multiset against set, which is the mutation this reading has to survive. The
  // `<form>` already says `Name` in a sentence of its own, so `Name` is in that block before the reply
  // and after it — a set comparison sees nothing arrive and hands the emptied `<h4>` back over a
  // `<label>` that is now holding the same word. Counted, the block went from one `Name` to two.
  const HELD =
    `<h1>Form</h1>\n` +
    `<h4>Name</h4>\n` +
    `<form><p>Name is required.</p><input id="name"></form>\n`;
  const { result, events } = await round(() => ({
    edits: [
      { block: 1, html: `` },
      { block: 2, html: `<form><p>Name is required.</p><label for="name">Name</label><input id="name"></form>` },
    ],
  }), HELD, 1);
  const patch = events.find((e) => e.type === "editor_patch");
  assert.deepEqual(patch?.data.navigation_lost, { headings: 1 });
  assert.equal(patch?.data.discarded, "headings_lost");
  assert.ok(!("headings_reverted" in (patch?.data ?? {})), "the emptied block is not handed back");
  assert.equal(result.body, HELD);
  assert.equal((result.body.match(/Name/g) ?? []).length, 2, "the two the document already had, not three");
});

// The media half of the same question, in both directions. A block can hand over something that carries
// no words at all — an `<img>` or an `<a>` — and no reading of the prose can see it move.
const FIGURE =
  `<h1>Report</h1>\n` +
  `<div><h2>Chart</h2><img src="c.png" alt="Sales by month."></div>\n` +
  `<p>See the chart.</p>\n`;

test("a block that gave its IMAGE to another block is not re-seated either", async () => {
  // Demote the heading and hand the image to the `<figure>` another edit builds. Not a word moves in
  // either block, so nothing but the media reading separates this from a safe re-seat — and re-seating
  // block 1 would put `c.png` in the document twice.
  const { result, events } = await round(() => ({
    edits: [
      { block: 1, html: `<div><p><strong>Chart</strong></p></div>` },
      { block: 2, html: `<figure><img src="c.png" alt="Sales by month."><figcaption>See the chart.</figcaption></figure>` },
    ],
  }), FIGURE, 1);
  const patch = events.find((e) => e.type === "editor_patch");
  assert.deepEqual(patch?.data.navigation_lost, { headings: 1 }, "the fall is read: the prose did not move");
  assert.equal(patch?.data.discarded, "headings_lost", "and there is nothing left to seat");
  assert.deepEqual(patch?.data.headings_dropped, [1]);
  assert.equal(result.body, FIGURE, "the document that entered");
  assert.equal((result.body.match(/c\.png/g) ?? []).length, 1, "one copy of the image, not two");
});

test("media is matched by kind, so a link arriving is not an image that left", async () => {
  // The same shape with the arrival a different kind of thing. Block 1 demotes and drops the image, which
  // therefore leaves the DOCUMENT — nothing took it — and block 2 gains a link. Read as "did any media
  // arrive anywhere", that refuses the round and ships a body with no image and no heading; read by kind,
  // block 1 goes back with its image and its heading, and the link is delivered.
  const { result, events } = await round(() => ({
    edits: [
      { block: 1, html: `<div><p><strong>Chart</strong></p></div>` },
      { block: 2, html: `<p>See the <a href="#chart">chart</a>.</p>` },
    ],
  }), FIGURE, 1);
  const patch = events.find((e) => e.type === "editor_patch");
  assert.deepEqual(patch?.data.navigation_lost, { headings: 1 });
  assert.deepEqual(patch?.data.headings_reverted, [1], "handed back, because nothing took what it gave up");
  assert.ok(!("discarded" in (patch?.data ?? {})));
  assert.equal(patch?.data.applied, 1, "and the link ships");
  assert.match(result.body, /<h2>Chart<\/h2>/);
  assert.match(result.body, /<img src="c\.png"/, "with the image the round would otherwise have dropped");
  assert.match(result.body, /href="#chart"/);
});

test("size cannot tell the two shapes apart, and where the words are can", async () => {
  // The measurement behind #376, pinned so the length licence is not re-proposed. Both shapes are run
  // through `applyBlockEdits` twice — the whole reply, and the reply with the demoting block's edit
  // dropped — and compared on the joined prose, which is the comparison that suggests itself.
  const SHAPES = [
    {
      what: "demote and reword in place, safe to re-seat",
      body: `<h1>Pay</h1>\n<div><h2>Standby Pay.</h2><p>Paid at teh rate.</p></div>\n`,
      edits: [{ block: 1, html: `<div><p><strong>Standby Pay.</strong></p><p>Paid at the rate.</p></div>` }],
      landed: [] as number[],
    },
    {
      what: "shed the words and grow, the duplication hazard",
      body: `<h1>Form</h1>\n<div><h4>Name</h4><p>Enter it.</p></div>\n<form><input id="name"></form>\n`,
      edits: [
        { block: 1, html: `<div><p>Enter it. Please print clearly in block capitals.</p></div>` },
        { block: 2, html: `<form><label for="name">Name</label><input id="name"></form>` },
      ],
      landed: [1],
    },
  ];
  const sizes: [number, number][] = [];
  for (const shape of SHAPES) {
    const blocks = splitBlocks(shape.body);
    const patched = applyBlockEdits(blocks, shape.edits);
    const kept = applyBlockEdits(blocks, shape.edits.filter((e) => e.block !== 1));
    sizes.push([visibleText(patched.body).length, visibleText(kept.body).length]);
    assert.deepEqual(patched.headings_dropped, [1], `${shape.what}: the same fall, in the same block`);
    assert.equal(patched.headings_gained, 0, `${shape.what}: and no heading arrived, so the other guard is blind`);
    assert.deepEqual(patched.content_landed, shape.landed, `${shape.what}: this is the reading that separates them`);
  }
  // `kept <= patched` is true on BOTH — 34 against 34, and 24 against 59 — so it licenses the hazard as
  // readily as the safe shape. It passes the hazard because the edit that GREW is the one being
  // reverted, which is the trap: the more content another edit took, the safer the re-seat looks.
  assert.deepEqual(sizes, [[34, 34], [59, 24]]);
  for (const [patched, kept] of sizes) assert.ok(kept <= patched, "which is why size is not the licence");
  // And what the hazard's re-applied body actually contains, which is the reason it must be refused.
  const hazard = SHAPES[1]!;
  const kept = applyBlockEdits(splitBlocks(hazard.body), hazard.edits.filter((e) => e.block !== 1));
  assert.equal((visibleText(kept.body).match(/Name/g) ?? []).length, 2, "`Name` twice, printed by the guard itself");
});

test("a reorder in the same reply as a demotion is refused whole, because neither can be told from the other", async () => {
  // The one shape the per-block revert cannot attribute, and the reason it is not applied blindly.
  // EDITOR_SYSTEM sanctions "reorder blocks", written as two edits — the block content lands in and the
  // block it came from. Put that in one reply with a demotion elsewhere and THREE blocks' heading counts
  // move while the document's falls by one. Handing back every block that dropped one would restore the
  // reorder's source while its landing block still has the heading: one heading printed twice, invented
  // here. Nothing binds a departure to an arrival, so this does not guess.
  const MOVED =
    `<h1>Manual</h1>\n` +
    `<div><h2>Operation</h2><p>Start here.</p></div>\n` +
    `<div><p>Then this.</p></div>\n` +
    `<div><h2>Appendix</h2><p>Tables.</p></div>\n`;
  const { result, events } = await round(() => ({
    edits: [
      { block: 1, html: `<div><p>Start here.</p></div>` }, // the reorder's source
      { block: 2, html: `<div><h2>Operation</h2><p>Then this.</p></div>` }, // where it lands
      { block: 3, html: `<div><p><strong>Appendix</strong></p><p>Tables.</p></div>` }, // the demotion
    ],
  }), MOVED, 1);
  const patch = events.find((e) => e.type === "editor_patch");
  assert.deepEqual(patch?.data.navigation_lost, { headings: 1 }, "the document lost exactly one");
  assert.equal(patch?.data.headings_gained, 1, "and one arrived somewhere, which is what makes it unreadable");
  assert.ok(!("headings_reverted" in (patch?.data ?? {})), "nothing is handed back on a reply this cannot attribute");
  assert.equal(patch?.data.discarded, "headings_lost", "so the round is refused whole — the old behaviour, kept for the case that needs it");
  assert.equal(result.body, MOVED, "and the document is the one that entered");
  assert.equal((result.body.match(/<h2>/g) ?? []).length, 2, "both headings, neither duplicated");
  assert.equal(result.editorHeadingsGated, true);
});

test("the gate is headings only: a list re-expressed as a definition list is a working round", async () => {
  // The limit of the claim, and why the gate is not `navigation_lost` entire. `items` and `rows` fall
  // on corrections agents/page.md asks for BY NAME — a `<ul>` that should have been a `<dl>`, a list
  // mis-extracted as a single-column table — because there the content lands in a DIFFERENT structure
  // the reader can still navigate, with every word intact. Refusing those would report the loop
  // working as damage. No sanctioned correction removes a heading and keeps its text, which is the
  // asymmetry the gate rests on.
  const LIST = `<h2>Terms</h2>\n<ul><li>Folio: the number the page prints.</li><li>Verso: the left page.</li></ul>\n`;
  const { result, events } = await round(() => ({
    // The colon stays in the `<dd>`, so the prose is no shorter — which it has to be for
    // `navigationLost` to read this round at all, a fall beside a word loss being the sanctioned
    // deletion and silent there. So this is squarely inside the gate's reach, and still not gated.
    edits: [{ block: 1, html: `<dl><dt>Folio</dt><dd>: the number the page prints.</dd><dt>Verso</dt><dd>: the left page.</dd></dl>` }],
  }), LIST, 1);
  const patch = events.find((e) => e.type === "editor_patch");
  assert.deepEqual(patch?.data.navigation_lost, { items: 2 }, "two list items stopped existing");
  assert.ok(!("discarded" in (patch?.data ?? {})), "and the round is applied, because that is the fix");
  assert.match(result.body, /<dl><dt>Folio<\/dt>/);
  assert.equal(result.editorHeadingsGated, false);
});

test("a gated round is retried, and the round after it is delivered", async () => {
  // The gate's cost, measured rather than asserted: one round. The editor demotes on its first pass,
  // that round is thrown away, and the second pass makes the correction the issue actually asked for
  // — which is what ships, with the headings the first round would have taken.
  let call = 0;
  const { result, events } = await round((shown) => {
    call++;
    if (call === 1) return { edits: demoteEveryHeading(shown) };
    return { edits: [{ block: 0, html: `<h1>Pay Schedules, 1962</h1>` }] };
  }, OUTLINE, 2);
  const patches = events.filter((e) => e.type === "editor_patch");
  assert.equal(patches.length, 2, "the refused round did not end the loop");
  assert.equal(patches[0]?.data.discarded, "headings_lost");
  assert.ok(!("discarded" in (patches[1]?.data ?? {})));
  // The second round's correction is in the delivered document AND the five headings are still there.
  assert.match(result.body, /<h1>Pay Schedules, 1962<\/h1>/);
  assert.equal((result.body.match(/<h2>/g) ?? []).length, 5);
  // Recorded on a document that came out of the loop corrected, which is the pairing to expect: the
  // signal says the editor tried it, not that anything was delivered damaged.
  assert.equal(result.editorHeadingsGated, true);
});

test("an editor that demotes every round spends the budget and the document keeps its headings", async () => {
  // The worst case, where the editor's ONLY edits are demotions. Nothing here can force it to stop, so
  // a model that demotes deterministically runs out the rounds and the document is delivered as it
  // entered with its issues in @unresolved — the loop's ordinary way of saying it could not fix
  // something. That is the direction to be wrong in: the alternative is a document whose heading outline
  // is gone and which nothing looks at again.
  const { result, events } = await round((shown) => ({ edits: demoteEveryHeading(shown) }), OUTLINE, 3);
  const patches = events.filter((e) => e.type === "editor_patch");
  assert.equal(patches.length, 3, "bounded by max_review_iterations, not unbounded");
  for (const p of patches) assert.equal(p.data.discarded, "headings_lost");
  assert.equal(result.body, OUTLINE);
  assert.equal((result.body.match(/<h2>/g) ?? []).length, 5);
  assert.equal(result.stoppedAt, "cap", "and the tally can tell this apart from a document that converged");
  assert.equal(result.unresolved.length, ISSUES.length, "the issue is declared open rather than silently dropped");
  assert.equal(result.editorHeadingsGated, true);
});

test("an editor that demotes every round still delivers what it corrected on the way", async () => {
  // The same worst case with one correction beside the demotions, which is what makes it the review's
  // finding rather than a hypothetical. Under the version this replaces, three rounds of this delivered
  // a document with NOTHING corrected in it: each round was thrown away whole, and the retry asked the
  // same model the same question about the same body. Now every round keeps its correction and hands
  // back only the demoted blocks — so the budget is still spent and the headings are still there, but
  // the document that comes out has been edited.
  const { result, events } = await round((shown) => ({
    edits: [...demoteEveryHeading(shown), { block: 0, html: `<h1>Pay Schedules, 1962</h1>` }],
  }), OUTLINE, 3);
  const patches = events.filter((e) => e.type === "editor_patch");
  assert.deepEqual(patches[0]?.data.headings_reverted, [1, 3, 5, 7, 9], "the five demoted blocks, every round");
  assert.equal(patches[0]?.data.applied, 1, "and the correction beside them");
  assert.ok(!("discarded" in (patches[0]?.data ?? {})), "so the round is not thrown away");
  // The delivered document: corrected, and with all five headings.
  assert.match(result.body, /<h1>Pay Schedules, 1962<\/h1>/);
  assert.equal((result.body.match(/<h2>/g) ?? []).length, 5);
  assert.doesNotMatch(result.body, /<p><strong>Standby Pay\.<\/strong><\/p>/);
  assert.equal(result.editorHeadingsGated, true);
});

test("a reply with neither shape in it is a call that said nothing", async () => {
  const { result, events } = await round(() => ({ fidelity_observed: [] }));
  assert.equal(result.body, BODY);
  assert.ok(events.some((e) => e.type === "editor_no_output"));
});

// --- the prompt ---

test("the editor is told to return the blocks it changed, and what a block is", () => {
  // The instruction and the code have to describe the same contract: the parse reads `edits`, the
  // apply refuses a replacement that is not whole markup, and an unnamed block is delivered as it
  // stands. A prompt that asked for anything else would produce replies this code discards.
  assert.match(EDITOR_SYSTEM, /Return the blocks you are CHANGING, and only those/);
  assert.match(EDITOR_SYSTEM, /a comment of the form <!-- @block 7 --> stands\nbefore each of the body's top-level elements/);
  assert.match(EDITOR_SYSTEM, /Every block you do\nnot name is delivered exactly as it stands, character for character/);
  assert.match(EDITOR_SYSTEM, /Do not return a\nblock whose markup you did not change/);
  // The mechanics, each of which is a branch in `applyBlockEdits`: complete markup, deletion,
  // several nodes under one number, a move written as two edits, one edit per block, and no
  // markers in the reply.
  assert.match(EDITOR_SYSTEM, /what you write must be complete markup: whole elements, opened and closed, and\nnever a piece of one/);
  assert.match(EDITOR_SYSTEM, /A block left open at the end of your replacement cannot be used/);
  assert.match(EDITOR_SYSTEM, /block keeps its original text instead/);
  assert.match(EDITOR_SYSTEM, /Say "html": "" to remove a block entirely/);
  assert.match(EDITOR_SYSTEM, /return them all under that one block number/);
  assert.match(EDITOR_SYSTEM, /name both: the block it lands in with the content in\nplace, and the block it came from with what is left of it/);
  assert.match(EDITOR_SYSTEM, /a second edit for a block already named is discarded/);
  assert.match(EDITOR_SYSTEM, /Do not copy the <!-- @block N -->\ncomments into what you return/);
  // The answer's shape, and the empty answer, which is the editor's way of saying the markup is
  // clean rather than a reply this code cannot use.
  assert.match(EDITOR_SYSTEM, /Respond with ONLY JSON, with the edits first/);
  assert.match(EDITOR_SYSTEM, /Return \{"edits": \[\]\} when there is nothing in the markup to change/);
  // And what it must NOT still say. The old contract is the thing this issue removed; a prompt
  // carrying both would produce a document-length reply from a model resolving the conflict the
  // wrong way, which is the 58% truncation rate coming back with a passing test suite.
  assert.doesNotMatch(EDITOR_SYSTEM, /corrected version of the FULL body/);
  assert.doesNotMatch(EDITOR_SYSTEM, /Return the complete corrected body/);
});
