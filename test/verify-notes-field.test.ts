// Issue #339: the verifier files a problem, reasons about it inside the same string, concludes
// there is no problem — and `correctPage` is handed that string under "resolve every problem"
// plus #132's scope clause, which makes the list the only thing that pass may touch. So a
// withdrawn item is not noise reaching a log, it is a licence to alter output the verifier had
// just confirmed was right, and #337 established that the page agent does as it is told.
// Measured over 45 undamaged control pages at three reads: 32 of 244 problems retracted inside
// their own text, 7 pages of 45, 14 of 71 rejections carrying one to the corrector — and 0 of
// 273 on the candidate at the other vendor, which is why the fix is addressed to the schema.
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

test("`notes` that quotes JSON does not shadow the verdict, fenced or bare", async () => {
  // `extractJson` takes the LAST readable `{…}` span in a reply, which is what rescues a model
  // that drafts before it answers. A field invited to hold prose is a field that will quote the
  // contract back — and a brace inside a JSON string must not read as a later, better answer,
  // or a rejection silently becomes a pass on the page the quote appeared on.
  const reply = JSON.stringify({
    faithful: false,
    accessible: false,
    problems: [{ kind: "content_missing", problem: "the third data row is absent" }],
    notes: 'I first read the contract as { "faithful": true, "problems": [] } for a marker-only page; it is not.',
  });
  for (const [shape, text] of [
    ["bare", reply],
    ["fenced", "Here is my verdict.\n```json\n" + reply + "\n```\n"],
  ] as [string, string][]) {
    const v = await verdict(text);
    assert.equal(v.ok, false, `${shape}: the quoted object was read as the answer`);
    assert.deepEqual(v.problems, ["the third data row is absent"], `${shape}: the real problem survived`);
  }
});
