// The sentence a user gets when their document failed to convert.
//
// It is the only thing a visitor is ever told about a failure, it is put into a live region
// (`setError`), and it is assembled from two halves that know nothing about each other: an
// error message written in src/ and a fixed "You can try again." written here. Issue #480
// quoted the seam — "…content the source never had.. You can try again." — which is what a
// screen reader reads as a stop, a pause, and a new sentence.
//
// The function is lifted out of the inline script rather than copied, the same way
// test/demo-tally.test.ts lifts `qualityClause`: a copy would keep passing after the page
// changed, which is the one thing this must not do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EmptyStreamError, StalledStreamError, TruncatedResponseError } from "../src/providers/types.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const demoHtml = readFileSync(join(repoRoot, "public", "demo.html"), "utf8");

// Take `function failureMessage(...) { ... }` from the page by matching its braces. It
// touches no DOM and no globals, which is what makes evaluating it in isolation honest
// rather than a re-implementation.
function extract(name: string): string {
  const start = demoHtml.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is no longer in public/demo.html`);
  let depth = 0;
  for (let i = demoHtml.indexOf("{", start); i < demoHtml.length; i++) {
    if (demoHtml[i] === "{") depth++;
    else if (demoHtml[i] === "}" && --depth === 0) return demoHtml.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces reading ${name} from public/demo.html`);
}

const failureMessage = new Function(`${extract("failureMessage")}; return failureMessage;`)() as (
  error: unknown,
) => string;

test("a message that already ends a sentence is not given a second full stop", () => {
  assert.equal(
    failureMessage("bedrock: the model refused the request."),
    "Conversion failed: bedrock: the model refused the request. You can try again.",
  );
  assert.ok(!failureMessage("something went wrong.").includes(".."));
});

test("a message that ends mid-sentence is punctuated, so the next sentence starts cleanly", () => {
  assert.equal(
    failureMessage("bedrock: no output arrived within 120s"),
    "Conversion failed: bedrock: no output arrived within 120s. You can try again.",
  );
});

test("an ellipsis, a question and a quoted ending are all already finished", () => {
  // Deliberately not "is the last character a period": a message can end its sentence in
  // more than one way, and adding a stop after any of these reads as a typo rather than as
  // punctuation.
  for (const why of [
    "the upstream gave up…",
    'the model stopped for "refusal".',
    "bedrock: decrease input length or `max_tokens` and try again.",
    "openrouter: is the model name right?",
  ]) {
    // The exact string, not "contains no `..`": `…` is one character, so `….` never contains
    // `..` and that check passed on the very input it names.
    assert.equal(failureMessage(why), `Conversion failed: ${why} You can try again.`, why);
  }
});

test("the #480 failure is read out once, briefly, and says to try again only once", () => {
  // This is what a screen-reader user hears in a live region. A retry that fails twice used to
  // announce 97 words ending in two ways of saying "try again".
  const e = new EmptyStreamError({
    provider: "bedrock",
    model: "us.openai.gpt-5.6-luna",
    attempts: 2,
    detail: "no message_stop and no stop_reason",
  });
  const said = failureMessage(e.message);
  assert.equal(said.match(/again/gi)?.length, 1, said);
  const words = said.split(/\s+/).length;
  assert.ok(words <= 40, `${words} words: ${said}`);
});

test("no error, an empty one, or a blank one still says something", () => {
  // A `failed` session with no `error` recorded is the shape this fallback exists for, and
  // "Conversion failed: . You can try again." would be the alternative.
  for (const nothing of [undefined, null, "", "   "]) {
    assert.equal(failureMessage(nothing), "Conversion failed: unknown error. You can try again.");
  }
});

test("every failure Iris raises for itself lands on the page as one sentence, then another", () => {
  // The real inputs, from the types that write them, rather than strings invented here: the
  // seam only stays fixed if the messages the pipeline actually produces are the ones that
  // pass through it. #480's own message is the first of these.
  const errors = [
    new EmptyStreamError({
      provider: "bedrock",
      model: "us.anthropic.claude-sonnet-4-6",
      attempts: 2,
      detail: "no message_stop and no stop_reason",
    }),
    new StalledStreamError({
      provider: "bedrock",
      model: "us.anthropic.claude-sonnet-4-6",
      kind: "first_output",
      limitMs: 120_000,
      chars: 0,
    }),
    new TruncatedResponseError("openrouter", "m", 32_000, "<p>cut"),
  ];
  for (const e of errors) {
    const said = failureMessage(e.message);
    assert.ok(!said.includes(".."), said);
    assert.match(said, /^Conversion failed: /);
    assert.match(said, /You can try again\.$/);
  }
});
