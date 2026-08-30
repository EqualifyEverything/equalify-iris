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
