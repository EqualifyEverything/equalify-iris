// Issue #339: the verifier files a problem, reasons about it inside the same string, concludes
// there is no problem — and `correctPage` is handed that string under "resolve every problem"
// plus #132's scope clause, which makes the list the only thing that pass may touch. So a
// withdrawn item is not noise reaching a log, it is a licence to alter output the verifier had
// just confirmed was right, and #337 established that the page agent does as it is told.
// Measured over 45 undamaged control pages at three reads: 32 of 244 problems retracted inside
// their own text, 7 pages of 45, 14 of 71 rejections carrying one to the corrector. The
// candidate at the other vendor did it 0 of 273 times on those control pages, but 2.7% on a real
// 100-page document against 3.1% and 4.5% for the other two models — so EVERY model does it, the
// corpus sets the rate, and it is the SCHEMA the fix is addressed to. The 0 is not evidence the
// behaviour can be instructed away; an earlier revision of this header read it that way, and the
// round that produced it withdrew that reading once the control 13.1% failed to reproduce on a
// 10-page subset of the same pages. Which is why the two halves below are not equally supported.
//
// The fix is two clauses of prompt and no code change, so the whole of it is assertable only
// here. Two halves, and they fail differently:
//
//  - the INSTRUCTION (`agents/feedback.md`): a conclusion of "not a problem" is omitted rather
//    than narrated, and working-out has a destination. Naming a destination is #303's lesson
//    read the other way — the Reader was told to write no reasoning at all and some of it came
//    back as issues asking for no change, so reasoning relocates and the only choice is where.
//    A reword that drops the clause breaks nothing and no run reports anything; the pipeline
//    simply goes back to paying correction passes to undo confirmed-correct output.
//  - the PROMISE the clause makes about `notes` — "read by nothing: no correction pass, no
//    other agent, no part of the delivered document". That one is code, and it is the half a
//    later change could falsify: fold `notes` into the problem list for "context" and the
//    prompt is left telling the model its working-out is discarded while it is being acted on.
//    So it is asserted behaviourally, through `verifyAgentOutput`, and not by grepping.
//
// And a third the first draft of this file got wrong, which is why the last two tests exist. A
// field invited to hold prose is a field that quotes the contract back, `extractJson` returns the
// LAST readable object in a reply, and an unescaped `{ "faithful": true, "problems": [] }` inside
// `notes` is one — so the rejection above becomes `ok: true` with no problems and no `unjudged`
// marker, which `pages_unjudged` cannot count. The draft "pinned" that shape with a fixture built
// by `JSON.stringify`, which escapes the quotes for you, so the whole-text `JSON.parse` read the
// envelope and the span walk was never consulted: a test that could not fail asserting the one
// property that could. The unescaped shape is pinned below on both sides — read correctly when the
// reply is nothing but its object (`src/util/json.ts`), and refused as a verdict at all when it is
// fenced or prefixed, because a verdict answers both flags and a swallowed envelope answers one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { verifyAgentOutput, type VerifyVerdict } from "../src/pipeline/feedback.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";
import { loadAgent } from "../src/agents/loader.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const feedbackMd = readFileSync(join(repoRoot, "agents", "feedback.md"), "utf8");
const prompt = feedbackMd.replace(/\s+/g, " ");

// One VERIFY call against a canned reply — the same harness `verify-kinds.test.ts` uses, and for
// the same reason: the shapes worth testing are raw model text no typed helper would let a test
// build. The fixture `feedback.md` here is a stub, so nothing below depends on the real prompt.
async function verdict(reply: string): Promise<VerifyVerdict> {
  const dir = mkdtempSync(join(tmpdir(), "iris-verify-notes-"));
  try {
    const agentsDir = join(dir, "agents");
    const inputDir = join(dir, "input");
    for (const d of [agentsDir, inputDir]) mkdirSync(d, { recursive: true });
    writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
    writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\nvision\n");
    writeFileSync(join(inputDir, "page-001.png"), "not-a-real-png");
    const ctx = {
      sessionId: "ses_test",
      paths: { agentsDir, tmpAgentsDir: () => join(dir, "tmp-agents") } as unknown as Paths,
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

test("the verify task says a withdrawn item is omitted, not narrated inside a problem", () => {
  for (const [what, re] of [
    // Why, before what: the clause has to survive a reword by someone who does not know that
    // `problems` is the correction pass's only licence, and the reason is the part that carries.
    ["a problem is named as the licence the correction pass acts on",
      /Every string in "problems" is handed to a correction pass verbatim, under the instruction to resolve every problem and to change nothing the list does not name/],
    ["an item concluded not to be a problem is omitted rather than withdrawn in its own text",
      /must therefore be OMITTED from "problems" rather than reported and then withdrawn inside its own text/],
    ["a problem is the conclusion and not the working-out",
      /Each "problem" is the conclusion only/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/feedback.md no longer says: ${what}`);
  }
});

test("the working-out has a named destination, and the reply shape it is named in", () => {
  // #303's lesson is that suppressing the behaviour relocates it, so the prohibition above is
  // worth nothing on its own: the clause must name somewhere for the reasoning to go, and the
  // schema must show the field, or "notes" is a destination with no referent in the reply.
  assert.match(prompt, /Working-out goes in "notes" instead/, "the destination is named");
  assert.match(
    prompt,
    /"notes" is read by nothing: no correction pass, no other agent, no part of the delivered document/,
    "the promise that makes the field safe to write into is stated to the model",
  );
  // One per reply, not one per problem. A `{ "kind": …, "notes": … }` entry with no `problem`
  // is stringified whole into the correction prompt by `readProblems` — never dropped, since a
  // lost problem ships the page — which would put the working-out straight back where this
  // change removes it from. The prompt is the only thing preventing that shape.
  assert.match(
    prompt,
    /It is ONE string for the whole reply, never a field on a problem, and every entry of "problems" still needs its "problem" text/,
    "the field is scoped to the reply, so it cannot re-enter the correction prompt per item",
  );
  // And no JSON inside it. `extractJson` returns the last readable object in a reply, so a quoted
  // `{ "faithful": … }` can BE the reply — the shape the two tests below are about. Asking for it
  // is the cheapest of the three defences and the only one that reaches a fenced reply, where the
  // parser cannot help; it is not the only one, because a prompt cannot be relied on for this.
  assert.match(
    prompt,
    /Write no JSON, no braces and no quoted field names inside it/,
    "the field is not invited to quote the contract back at the parser",
  );
  assert.match(
    prompt,
    /"notes": "working-out, read by nothing — omit when you have none" \}/,
    "the schema the model is told to answer with carries the field",
  );
  // Position: the clause explains the schema, so it comes before it. Read the other way round
  // the model meets `"notes"` in the JSON with nothing yet said about what it is for.
  const clause = feedbackMd.indexOf('Working-out goes in "notes"');
  const schema = feedbackMd.indexOf('"notes": "working-out');
  assert.ok(clause > 0 && schema > 0 && clause < schema, "the clause introduces the field, not the reverse");
  // And both sit in TASK: verify, not in one of the other three tasks, which have no
  // `problems` array and no correction pass reading their replies. The task SECTION heads, not
  // the four names listed in the opening sentence — `TASK: scope` is mentioned there too, ahead
  // of everything, so `indexOf` on the bare string puts every clause after it.
  const head = (task: string): number => {
    const at = feedbackMd.search(new RegExp(`^TASK: ${task}$`, "m"));
    assert.ok(at > 0, `agents/feedback.md has no TASK: ${task} section head`);
    return at;
  };
  assert.ok(head("verify") < clause, "the clause is inside TASK: verify");
  assert.ok(schema < head("scope"), "the field is inside TASK: verify, which TASK: scope ends");
});

test("`notes` reaches nothing: a reply with it verdicts identically to the same reply without", async () => {
  // The promise the prompt makes, asserted where it can be broken. Same problems, same flags,
  // one reply carrying 300 characters of withdrawn reasoning in `notes`.
  const problems = [
    { kind: "content_wrong", problem: "the 1990 column reads 2,029 where the page prints 2029" },
    { kind: "structure_wrong", problem: "the totals row is inside <thead>" },
  ];
  const bare = await verdict(JSON.stringify({ faithful: false, accessible: true, problems }));
  const withNotes = await verdict(
    JSON.stringify({
      faithful: false,
      accessible: true,
      problems,
      notes:
        "Checked whether the page-break marker should carry the folio rather than the file " +
        "position — the contract says the printed folio and the output has it, so that is fine " +
        "and I am not reporting it. Re-read the caption rule for the second table: also fine.",
    }),
  );
  assert.deepEqual(withNotes, bare, "`notes` changed the verdict, so something is reading it");
  assert.deepEqual(
    withNotes.problems,
    [
      "the 1990 column reads 2,029 where the page prints 2029",
      "the totals row is inside <thead>",
    ],
    "the correction pass is given the two conclusions and nothing from `notes`",
  );
});

test("a passing page's `notes` does not become a problem, which is where the old defect landed", async () => {
  // The exact shape #339 measured, expressed the way the new contract asks for it: the page is
  // fine, the verifier did think about it, and the thinking must not arrive anywhere. Before
  // the clause this reply's prose was an entry of `problems` — with `faithful: false` beside it
  // on 14 of 71 rejections, and `failedCheck` needs only a false flag and a non-empty list.
  const v = await verdict(
    JSON.stringify({
      faithful: true,
      accessible: true,
      problems: [],
      notes: "The <ol> nesting looked wrong at first. On closer inspection it matches the image. Disregard.",
    }),
  );
  assert.equal(v.ok, true);
  assert.deepEqual(v.problems, []);
  assert.equal(v.unjudged, undefined, "the page was judged — this is a pass, not an absent verdict");
});

test("`notes` that quotes JSON does not shadow the verdict, escaped or not", async () => {
  // `extractJson` takes the LAST readable `{…}` span in a reply, which is what rescues a model
  // that drafts before it answers. A field invited to hold prose is a field that will quote the
  // contract back — and a brace inside a JSON string must not read as a later, better answer,
  // or a rejection silently becomes a pass on the page the quote appeared on.
  const notes = 'I first read the contract as { "faithful": true, "problems": [] } for a marker-only page; it is not.';
  const body = { faithful: false, accessible: false, problems: [{ kind: "content_missing", problem: "the third data row is absent" }] };
  // Escaped, which is what a model that gets JSON right sends — and, because `JSON.stringify`
  // escapes for it, the case this test USED to stop at. The whole-text `JSON.parse` reads it and
  // the span walk is never consulted, so on its own it pins nothing about the decoy.
  const escaped = JSON.stringify({ ...body, notes });
  // The shape the prompt actually invites, and the one #339 is about: the same sentence with the
  // model's own quotes unescaped, which is the commonest way a model gets a JSON string wrong
  // (`repairedSpan` exists for it — 67 of 1,596 bench replies are unreadable strictly). Here the
  // `"` before each `:` inside the sentence ended the value early, the envelope stopped parsing,
  // and `{ "faithful": true, "problems": [] }` was the last thing in the reply that read.
  const unescaped =
    `{ "faithful": false, "accessible": false,\n` +
    `  "problems": [{ "kind": "content_missing", "problem": "the third data row is absent" }],\n` +
    `  "notes": "${notes}" }`;
  for (const [shape, text] of [
    ["escaped", escaped],
    ["unescaped", unescaped],
  ] as [string, string][]) {
    const v = await verdict(text);
    assert.equal(v.ok, false, `${shape}: the quoted object was read as the answer`);
    assert.deepEqual(v.problems, ["the third data row is absent"], `${shape}: the real problem survived`);
    assert.equal(v.unjudged, undefined, `${shape}: this is a verdict, not an absent one`);
  }
});

test("a reply carrying only one decision flag is not a verdict, and does not become a pass", async () => {
  // The half the parser cannot reach. Wrap that unescaped verdict in a fence or a sentence and the
  // decoy is the last readable object again — one pass cannot tell it from a page printing
  // `She said "hello", he replied` (see `repairedSpan`). So the shape is refused HERE instead: a
  // verdict answers both flags, and all 1,342 readable verify replies in the bench logs do. What
  // arrives from a swallowed envelope answers one, and the difference between reading it and
  // refusing it is the difference between `page_verify_ok` on a page with a missing table row and
  // a page counted in `pages_unjudged`.
  const decoy = '{ "faithful": true, "problems": [] }';
  for (const [shape, text] of [
    ["fenced", "```json\n{ \"faithful\": false, \"accessible\": false, \"problems\": [{ \"problem\": \"a row is missing\" }],\n  \"notes\": \"I read it as " + decoy + " at first.\" }\n```"],
    ["faithful only", decoy],
    ["accessible only", '{ "accessible": true }'],
    ["neither", '{ "kind": "content_missing", "problem": "the third data row is absent" }'],
    ["flag not a boolean", '{ "faithful": "yes", "accessible": true, "problems": [] }'],
  ] as [string, string][]) {
    const v = await verdict(text);
    assert.equal(v.unjudged, true, `${shape}: read as a verdict when it answers only part of one`);
    assert.deepEqual(v.problems, [], `${shape}: an unjudged page names no problems`);
    // Still non-blocking: verification never costs a page, which is why the flag exists at all.
    assert.equal(v.ok, true, `${shape}: an unjudged page is not a failed one`);
  }
  // And the complete verdict is still read, so the check is a shape test and not a stricter judge.
  const good = await verdict('{ "faithful": true, "accessible": true, "problems": [] }');
  assert.equal(good.unjudged, undefined);
  assert.equal(good.ok, true);
});

test("the flags check is not free in one direction, and this is the direction", async () => {
  // What the check costs, pinned rather than left as a footnote. A rejection that names its problems
  // but omits `accessible` used to buy a correction pass; it is now a page nothing judged, so the
  // defect ships — counted in `pages_unjudged`, and not fixed. No reply in the bench logs does this
  // (1,342 of 1,342 answer both flags) and the trade is deliberate: the shape it refuses is the
  // swallowed envelope of #339, where reading one flag turns a rejection into a confident PASS on a
  // page with a missing table row. A pass that never happens is visible; a pass that did is not.
  const v = await verdict('{ "faithful": false, "problems": [{ "kind": "content_missing", "problem": "the third data row is absent" }] }');
  assert.equal(v.unjudged, true);
  assert.deepEqual(v.problems, [], "the problems this reply named do not reach `correctPage`");
  assert.equal(v.ok, true, "and the page ships, because verification never costs a page");
  // The same reply WITH the flag it omitted is the rejection it was meant to be.
  const both = await verdict('{ "faithful": false, "accessible": true, "problems": [{ "kind": "content_missing", "problem": "the third data row is absent" }] }');
  assert.equal(both.ok, false);
  assert.deepEqual(both.problems, ["the third data row is absent"]);
});
