import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
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

// A warning band, because the ceiling on its own arrives at the worst moment. Pass/fail at
// 21,000 means the first PR to discover the limit exists is one editing whichever block is
// already closest to it, and that PR has to relocate the overflow then and there. The
// diagnostic below prints every block past this share of the ceiling on every run, so the
// heads-up arrives while there is still room to act on it. It does not fail: a long block
// is not a defect, and a test that failed here would be a test asking for prose to be cut
// from a workflow whose reasoning is the point of it.
const WARN_AT = 0.85;

// Everything GitHub parses, not just `.github/workflows`. The ceiling applies to any `run:`
// scalar it reads, and a composite action under `.github/actions/**` would carry those too —
// that directory does not exist today, which is exactly why scoping the scan to the one
// place blocks live now would go stale without anything noticing. `.github/ISSUE_TEMPLATE`
// is swept up harmlessly: an issue form has no `run:` key, so it contributes nothing.
const DIR = join(import.meta.dirname, "..", ".github");

function yamlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return yamlFiles(p);
    return /\.ya?ml$/.test(e.name) ? [p] : [];
  });
}

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

test("no workflow step's run: block is near GitHub's 21,000-character ceiling", (t) => {
  const files = yamlFiles(DIR);
  assert.ok(files.length > 0, "the .github tree is where this test thinks it is");

  const measured: { where: string; len: number }[] = [];
  for (const file of files) {
    const doc = parse(readFileSync(file, "utf8"));
    for (const { path, run } of runBlocks(doc)) {
      measured.push({ where: `${relative(DIR, file)} ${path}`, len: run.length });
    }
  }
  assert.ok(measured.length > 0, "and the parse found the run: blocks in it");

  measured.sort((a, b) => b.len - a.len);
  for (const m of measured) {
    if (m.len < MAX_RUN_LENGTH * WARN_AT) break;
    t.diagnostic(
      `${m.where} is ${m.len} of ${MAX_RUN_LENGTH} characters ` +
        `(${Math.round((m.len / MAX_RUN_LENGTH) * 100)}%, ${MAX_RUN_LENGTH - m.len} left)`,
    );
  }
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
