// Every specialist in agents/ answers runSpecialist's JSON request and returns a fragment the page can
// take as is. Nothing else checks a new agent file against that (review of #569).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const AGENTS_DIR = fileURLToPath(new URL("../agents", import.meta.url));
const specialists = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md") && f !== "page.md" && f !== "feedback.md");

test("every specialist returns its fragment as the html field, with no comments", () => {
  assert.ok(specialists.includes("chartDataAgent.md"));
  for (const f of specialists) {
    const text = readFileSync(join(AGENTS_DIR, f), "utf8");
    const contract = text.split(/^## Output contract$/m)[1] ?? "";
    assert.match(contract, /as\s+the\s+"html"\s+field,\s+with\s+no\s+HTML\s+comments/, `${f}: output contract`);
    assert.doesNotMatch(text, /@source|@end-source/, `${f}: asks for @source comments`);
    assert.match(text, /## Required capability\n[^\n]*\bvision\b[^\n]*\bstructured_output\b/, `${f}: capability`);
  }
});
