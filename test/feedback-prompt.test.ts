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

// #347: the general clause above was not enough for one case, so that case is named. On the nine
// legend-bearing figure pages of a 100-page corpus the extraction read the shading key correctly
// and the verifier talked it out of it — "invented text not present as a legend label" against a
// `<dd>` describing the ink, twice, and the compliant correction deleted the description. The
// three serious accessibility violations in that arm's whole output were all created by the repair
// rather than found by it, and the verify-and-correct pair was 63.7% of what those pages cost.
//
// It is the same shape as the page-break marker above — output the contract demands, read as
// infidelity — but it needed naming rather than deriving, because the contract's own first clause
// ("never supply an expansion the page does not state") appears to forbid exactly what its `<dl>`
// clause requires here. A verifier applying the general rule reaches the prohibition first.
//
// The hedge half is the more expensive one. On `acir-p077` the extraction wrote "none visibly
// distinct from medium in this reproduction", which measurement off the source image confirms is
// the correct answer — the page's two light bands are 33 luminance units apart under a 113-unit
// lighting vignette — and the verifier called it "factually wrong", named thirteen states as the
// lightest shade of which seven carry the darkest fill, and bought the correction that installed
// it. Nothing downstream can see this: the corrected page is well-formed, specific and false, and
// every automated gate passes it.
test("the verify task will not score a described swatch as invented, or overturn a stated hedge", () => {
  for (const [what, re] of [
    ["the case is named rather than left to the general clause",
      /A graphical key is where that goes wrong most expensively, so it is named here/],
    ["a description of the ink is the transcription, because the page prints no words for it",
      /the page prints no words for that half, so a description of the ink standing as the term of the legend IS the transcription the contract asks for and is not invented text/],
    ["and the consequent report is prohibited by name",
      /do not send it back for naming a shade the page does not name/],
    // The root cause on p077: both agents assumed the legend's tones ran in the order of its
    // labels. Measured, they do not — 26, then 176, then 143 — so the assumption was written into
    // the markup as fact by the extraction and enforced as fact by the verifier.
    ["the tone is read off the swatch and not off the order of the labels",
      /Read a swatch's tone off the swatch and not off the order of the labels beside it, which is frequently not the order the shades run in/],
    ["a stated uncertainty is the contract being followed, and is checked before it is contradicted",
      /that hedge is the contract being followed — check it against the image before contradicting it/],
    ["and is never replaced by a confident assignment the verifier cannot see well enough to make",
      /never replace a stated uncertainty with a confident assignment you cannot see well enough to make/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/feedback.md no longer says: ${what}`);
  }
});

// Also #347, and the generalizable half of it. `correctPage` is told to resolve every problem and
// change nothing else, so each problem string is a licence — and the licence is shaped by the
// REASON, not only by the target. p093's third problem said a phrase in the markup was "invented
// text not present as a legend label". The phrase is the legend's own printed heading, set in two
// lines inside the legend box, and the correction deleted it. "This is a heading glued to the
// first label" would have licensed moving those words; "this text is not on the page" licenses
// only removing them. Same page, same words, opposite repairs, and the difference is entirely in
// the sentence the verifier chose.
test("the verify task states that a problem's reason is part of the licence it grants", () => {
  for (const [what, re] of [
    ["the reason is named as part of the licence rather than as commentary",
      /The REASON you give is part of that licence and not commentary on it/],
    ["with the two repairs a right finding can buy, contrasted",
      /"this heading sits at the wrong level" licenses moving it, while "this text is not on the page" licenses only deleting it/],
    ["and the consequence, so the rule is not read as a style note",
      /a right finding with a wrong reason buys the wrong repair. Say what you saw and where, not what you infer it means/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/feedback.md no longer says: ${what}`);
  }
});
