// `agents/feedback.md`'s TASK: verify is the pass that compares one agent's HTML against
// the source image, and `verifyAgentOutput` hands it the agent's whole contract to judge
// against (src/pipeline/feedback.ts embeds `agent.content` in the prompt). This pins the
// clause that says what to do when the two disagree — when the contract requires output
// that does not look like the page.
//
// The page agent has three such rules, and #145's page-break marker made the third the
// sharpest: `<hr role="doc-pagebreak" aria-label="Page 5">` puts the page's printed number
// in an attribute, placed at the head of the page whether the page prints it at the head or
// the foot. A verifier comparing text to image sees a number on the paper and no number in
// the HTML, which is a transcription miss by every rule it knows. Reporting it costs a
// `correctPage` call whose only way to satisfy the report is to break the page rule — and
// the resulting lesson can be banked and applied to later runs (see src/pipeline/memory.ts),
// so one such verdict does not stay one.
//
// Pinned rather than left to the wording because the clause is invisible in normal
// operation: nothing fails when it is dropped, the pipeline simply starts spending rounds
// arguing with itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const feedbackMd = readFileSync(join(repoRoot, "agents", "feedback.md"), "utf8");
const prompt = feedbackMd.replace(/\s+/g, " ");

test("the verify task judges HTML against the agent's contract, not the image alone", () => {
  for (const [what, re] of [
    ["the contract is a standard the HTML is judged by, alongside the image",
      /Judge the HTML against that contract as well as against the image/],
    // The three shapes named are the page agent's three, in the order they cost a round:
    // the page-break marker's placement, its number-in-an-attribute, and #110's symbol.
    ["the shapes that will not look like the page are named",
      /a marker it places by rule rather than where the page prints it, a number or name it asks for in an attribute instead of in text, a symbol it asks to be left out/],
    ["following the contract is not an infidelity, and the cost of saying it is is named",
      /following the contract is not an infidelity, and reporting it as one spends a correction round on undoing the rule/],
    // The inversion is the operative half: "missing" is defined against the contract, so a
    // verifier has a test it can apply rather than a list of exceptions to remember.
    ["what counts as missing is defined against the contract",
      /What is missing is what the contract asked for and the HTML does not have/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/feedback.md no longer says: ${what}`);
  }
});
