// The Reader is told to reply with JSON and nothing else, and this holds the prompt to the exact
// bytes that claim was measured on, in the exact place it was measured in (issue #299).
//
// The rule exists because "Respond with ONLY JSON:" was not enough: over 5 documents on the
// incumbent Reader model, 40% of the characters the model wrote sat outside the JSON envelope, and
// nothing in the pipeline could see it — `extractJson` takes the LAST envelope in a reply (#173),
// so narration parses, no call fails and no log line records that a third of the step's output
// was prose billed at output rates.
//
// Three things about the appended sentence are worth a test rather than a comment, because each of
// them is load-bearing for a number this repo publishes:
//
//   1. THE BYTES. What was benchmarked was one sentence, not a paraphrase of it. A prompt tuned by
//      measurement and then reworded is a prompt whose measurement no longer applies to it, and
//      nothing else would notice — the reply parses either way, which is the whole problem this
//      rule addresses.
//   2. THE PLACE. It goes last. "the JSON object" and "before or after it" refer to the schema
//      above them, so a sentence moved above the schema is a sentence with no referent. That is
//      the positional-cross-reference failure the Reader prompt has hit before, and a prompt still
//      reads plausibly after it happens.
//   3. NOTHING WAS EDITED TO MAKE ROOM. The sentence is an append; Iris's own JSON instruction,
//      its schema and its clean-document line are the same bytes in the same order they were in
//      when every other Reader figure in this repo was measured.
//
// The last test is about the cost claim rather than the text. The comment on `READER_JSON_ONLY`
// says the tokens it adds are nearly free on the incumbent because they land inside a
// cached prefix, and not free on a Reader that gets no cache breakpoint at all — which is the same
// population where nothing this sentence does has been resolved: on `kimi-k2.5` the finding count
// and the price both move by less than the gap between two runs of the identical prompt (#307).
// Both halves of the cache claim are decidable here, so neither is left as an assertion in prose.
// The measurements behind that trade are NOT decidable here, and none of them is asserted anywhere in
// this repo as a model trait — the figures that once justified this sentence on a second model were
// 5-document draws and reversed at 40 (#307), as did the prose share they rested on (#305). So the
// constant this file pins is the prompt text, never a number that argued for it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { READER_SYSTEM, READER_JSON_ONLY } from "../src/pipeline/review.ts";
import { cacheableSystemPrompt } from "../src/providers/promptCache.ts";

test("the JSON-only sentence is the one that was measured, to the byte", () => {
  assert.equal(
    READER_JSON_ONLY,
    "Your entire reply must be the JSON object and nothing else. Do not write any reasoning, " +
      "preamble, commentary or summary before or after it. Do the thinking without writing it down.",
  );
  // One line, because the arm that produced the -29% appended one line. Every other paragraph in
  // this prompt is hard-wrapped, so wrapping this one to match the file would have been the
  // natural thing to do and would have shipped bytes nobody measured.
  assert.equal(READER_JSON_ONLY.includes("\n"), false, "the measured sentence carries no newline");
});

test("it is the last thing the Reader is told, after the schema it refers to", () => {
  assert.ok(
    READER_SYSTEM.endsWith(`\n\n${READER_JSON_ONLY}`),
    "the sentence must end the prompt, separated as its own paragraph",
  );
  // And after the schema specifically, which is what gives "the JSON object" a referent.
  const schema = READER_SYSTEM.indexOf(`{ "issues": [ { "issue"`);
  assert.ok(schema > 0, "the schema is still in the prompt");
  assert.ok(schema < READER_SYSTEM.indexOf(READER_JSON_ONLY), "the schema comes first");
  // Once. A prompt that says this twice is a prompt someone appended to without reading the end.
  assert.equal(READER_SYSTEM.split(READER_JSON_ONLY).length - 1, 1);
});

test("Iris's own instruction was appended to, not rewritten", () => {
  // The three lines that were the tail of this prompt before #299, contiguous and in order. Every
  // Reader measurement this repo publishes was taken with these bytes in place.
  assert.ok(
    READER_SYSTEM.includes(
      'Respond with ONLY JSON:\n' +
        '{ "issues": [ { "issue": "...", "pages": [3], "severity": "low|medium|high", "suggested_action": "..." } ] }\n' +
        'Return {"issues": []} when the document is clean.',
    ),
  );
});

test("the added tokens are a cache read on the incumbent and full price off it", () => {
  // The claim is about the prompt as shipped, so it is asked of the whole prompt rather than of
  // the sentence: a breakpoint is worth having on a prefix this long, so the sentence rides
  // inside it at 0.1x on a warm deployment.
  assert.equal(cacheableSystemPrompt("anthropic/claude-sonnet-4.6", READER_SYSTEM), true);
  assert.equal(cacheableSystemPrompt("us.anthropic.claude-sonnet-4-6", READER_SYSTEM), true);
  // And the other half, which is why #299's condition is a condition: a Reader swapped onto a
  // non-Claude model gets no breakpoint, so it pays these tokens in full on every chunk of every
  // round — and it is a non-Claude model that the same sentence was measured to cost findings on.
  assert.equal(cacheableSystemPrompt("moonshotai/kimi-k2.5", READER_SYSTEM), false);
});
