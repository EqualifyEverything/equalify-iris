// The page agent's instructions exist twice: in `agents/page.md`, which is what
// actually runs, and in `DEFAULT_PAGE_PROMPT` in `src/pipeline/extraction.ts`,
// the fallback for a checkout without an agents/ directory. The duplication
// cannot be removed by having the code read the file — the fallback's entire
// purpose is the file being absent — so it has to be held together by a test.
//
// Without this, the two drift silently and in the worst direction: the file is
// what every normal deployment uses, so an edit there is exercised constantly
// while the fallback rots unnoticed, and the only deployments that get the stale
// copy are bare checkouts, which are also the ones least likely to be watched.
//
// #30 Tier 5: "Have the code read the file, or add that test."
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_PAGE_PROMPT } from "../src/pipeline/extraction.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pageMd = readFileSync(join(repoRoot, "agents", "page.md"), "utf8");

// A `## Heading` section's body, up to the next `##` or end of file.
function section(name: string): string | null {
  const m = pageMd.match(new RegExp(`##\\s*${name}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`));
  return m ? m[1].trim() : null;
}

// Compared on words, not bytes. The file wraps for reading and carries one
// markdown-only aside ("no code fences", which is about the .md rendering, not an
// instruction to the model), so a byte-exact assertion would fail on reflowing a
// paragraph — the kind of failure that gets a test deleted rather than heeded.
// Every word of instruction still has to be present, in order.
function normalize(s: string): string {
  // The leading whitespace is part of the match, so removing the aside from
  // "…this JSON (no code fences):" leaves "…this JSON:" rather than "JSON :".
  return s.replace(/\s*\(no code fences\)/g, "").replace(/\s+/g, " ").trim();
}

test("agents/page.md has the sections the loader and this test depend on", () => {
  assert.ok(section("System prompt"), "page.md is missing a '## System prompt' section");
  assert.ok(section("Output contract"), "page.md is missing an '## Output contract' section");
  assert.match(pageMd, /##\s*Required capability\s*\n[^#]*\bvision\b/i, "page.md must declare the vision capability");
});

// The signature-block rule (issue #67) came from user feedback on a part-signed
// page: one party's fields had been rendered as a <dl> and the other's as form
// controls, so a screen-reader user met the same block twice in two different
// shapes. Asserted on the clauses that carry the rule rather than on its prose —
// the wording may be reflowed, but drop one of these and the output is back to
// what the issue reported, or to the over-correction it invites (every label/value
// pair on the page turned into a control).
//
// Only `page.md` is checked: the test below holds the fallback copy to it word for
// word, so a rule present here and missing there fails there.
test("the page agent's signature-block rule keeps the clauses that make it a rule", () => {
  const prompt = normalize(section("System prompt")!);
  for (const [what, re] of [
    ["one fieldset per signing party", /<fieldset>\/<legend> per signing party or logical group/],
    ["a filled-in field is a readonly input, not static text", /<input readonly value="\.\.\."> rather than as a <dd>/],
    ["required is read off the page, not inferred from a blank field", /aria-required="true" only where the page itself marks a field as required/],
    ["printed metadata is still a <dl>", /not about every label\/value pair.*is still a <dl>/],
  ] as [string, RegExp][]) {
    assert.match(prompt, re, `agents/page.md no longer says: ${what}`);
  }
});

// The list of explicit structures is introduced by its own count, so adding a
// fifth bullet and leaving "Four" in place would have the prompt miscount itself.
test("the explicit-structures list agrees with the count that introduces it", () => {
  const prompt = section("System prompt")!;
  const NUMBERS: Record<string, number> = { Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8 };
  const intro = prompt.match(/(\w+) structures are easy to render/);
  assert.ok(intro, "page.md no longer introduces the list of explicit structures");
  const claimed = NUMBERS[intro![1]];
  assert.ok(claimed, `"${intro![1]} structures" is not a number this test knows — add it above`);
  // The bullets are the SHOUTED ones: "- FOOTNOTES:", "- SIGNATURE AND FILL-IN BLOCKS:".
  const bullets = prompt.match(/^- [A-Z][A-Z -]+:/gm) ?? [];
  assert.equal(bullets.length, claimed, `the intro says ${claimed} structures but ${bullets.length} are listed: ${bullets.join(" ")}`);
});

test("DEFAULT_PAGE_PROMPT matches agents/page.md's instructions", () => {
  const fromFile = normalize(`${section("System prompt")}\n\n${section("Output contract")}`);
  assert.equal(
    normalize(DEFAULT_PAGE_PROMPT),
    fromFile,
    "DEFAULT_PAGE_PROMPT in src/pipeline/extraction.ts has drifted from agents/page.md. " +
      "Edit both, or delete the fallback if a bare checkout no longer needs to run.",
  );
});

// The JSON contract is what the extractor parses (`html` / `log` /
// `suggested_agent`); a drift there is not a wording difference, it silently
// yields no fragment. Asserted separately so a failure names the cause.
//
// Scoped to the contract section, not the whole file: `"log"` and
// `"suggested_agent"` are also named in the prose above it, so searching the
// whole document would still find them after the response template lost a key —
// the test would pass while the model was told to return something else.
test("both copies promise the same JSON response keys", () => {
  for (const [label, text] of [
    ["agents/page.md '## Output contract'", section("Output contract")!],
    ["DEFAULT_PAGE_PROMPT's response template", DEFAULT_PAGE_PROMPT.slice(DEFAULT_PAGE_PROMPT.indexOf("Respond with ONLY"))],
  ] as const) {
    for (const key of ["html", "log", "suggested_agent"]) {
      assert.match(text, new RegExp(`"${key}"\\s*:`), `${label} must document the "${key}" response key`);
    }
  }
});
