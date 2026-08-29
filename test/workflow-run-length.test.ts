import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

// GitHub parses each `run:` block as a single expression and refuses one longer than
// 21,000 characters. It refuses the whole FILE for it, so the workflow fails every run
// with no jobs at all — the loudest possible failure for the quietest possible reason,
// and one that nothing in this repository would otherwise catch: the YAML is valid, the
// shell is valid, and no PR check reads it.
//
// That limit has already been hit once, which is why `issue-triage.yml`'s enforcement
// step is `.github/scripts/triage-decide.sh` instead of an inline block (see the comment
// above that step). The workflows here are long because their reasoning is written down
// in them, so the ceiling is a live constraint rather than a theoretical one, and every
// added paragraph of issue-body prose spends some of it.
const MAX_RUN_LENGTH = 21_000;

const DIR = join(import.meta.dirname, "..", ".github", "workflows");

// Measured on the PARSED value, not on the file's bytes. The difference decides whether
// this test is true: block-scalar indentation is not part of the string GitHub sees, and
// counting it says `code-review.yml` is 23,097 characters and already over the limit —
// while that workflow demonstrably runs. Approximating the dedent by hand is the same
// mistake one step removed, so the repo's own `yaml` dependency does it.
function runBlocks(node: unknown, path: string[] = []): { path: string; run: string }[] {
  if (Array.isArray(node)) return node.flatMap((v, i) => runBlocks(v, [...path, String(i)]));
  if (node && typeof node === "object") {
    return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
      k === "run" && typeof v === "string"
        ? [{ path: [...path, k].join("."), run: v }]
        : runBlocks(v, [...path, k]),
    );
  }
  return [];
}

test("no workflow step's run: block is near GitHub's 21,000-character ceiling", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  assert.ok(files.length > 0, "the workflows directory is where this test thinks it is");

  const measured: { where: string; len: number }[] = [];
  for (const file of files) {
    const doc = parse(readFileSync(join(DIR, file), "utf8"));
    for (const { path, run } of runBlocks(doc)) {
      measured.push({ where: `${file} ${path}`, len: run.length });
    }
  }
  assert.ok(measured.length > 0, "and the parse found the steps in them");

  measured.sort((a, b) => b.len - a.len);
  for (const m of measured) {
    // The message carries the headroom rather than only the failure, because the
    // interesting number when this trips is how much prose has to come out — or, as
    // `triage-decide.sh` decided, that the step belongs in a checked-out script instead.
    assert.ok(
      m.len < MAX_RUN_LENGTH,
      `${m.where} is ${m.len} characters, at or past GitHub's ${MAX_RUN_LENGTH} ceiling; ` +
        `move it to .github/scripts/ the way issue-triage.yml did`,
    );
  }
});
