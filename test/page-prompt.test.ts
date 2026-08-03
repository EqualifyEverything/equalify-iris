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
