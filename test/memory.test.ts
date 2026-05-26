import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordExample,
  eligibleExamples,
  examplesForPrompt,
  CORROBORATION_THRESHOLD,
} from "../src/pipeline/memory.ts";
import type { Paths } from "../src/store/paths.ts";

// memory.ts only ever calls paths.agentMemory(agentFile), so a duck-typed stub is
// enough to exercise it against a temp directory.
function fakePaths(dir: string): Paths {
  return { agentMemory: (agent: string) => join(dir, `${agent.replace(/\.md$/, "")}.json`) } as unknown as Paths;
}

function withTemp(fn: (paths: Paths) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "iris-mem-"));
  try {
    fn(fakePaths(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const LESSON = "Mark decorative images with empty alt text";

test("a generalizable lesson needs corroboration before it is eligible to inject", () => {
  withTemp((paths) => {
    recordExample(paths, {
      agent: "page.md",
      kind: "generalizable",
      instruction: LESSON,
      before: "<img src='x'>",
      after: "<img src='x' alt=''>",
      feedback: "this image is decorative",
      session: "ses_1",
    });
    assert.equal(eligibleExamples(paths, "page.md").length, 0, "one session: not yet corroborated");
    assert.equal(examplesForPrompt(paths, "page.md"), "", "nothing eligible -> empty injection");

    // Same lesson, a different session -> corroborated.
    const entry = recordExample(paths, {
      agent: "page.md",
      kind: "generalizable",
      instruction: LESSON,
      before: "<img src='y'>",
      after: "<img src='y' alt=''>",
      feedback: "another decorative image",
      session: "ses_2",
    });
    assert.equal(entry.count, CORROBORATION_THRESHOLD, "two distinct sessions counted");
    const eligible = eligibleExamples(paths, "page.md");
    assert.equal(eligible.length, 1, "corroborated -> eligible");
    assert.match(examplesForPrompt(paths, "page.md"), /decorative|alt/i);
  });
});

test("re-recording within the same session does not inflate the corroboration count", () => {
  withTemp((paths) => {
    recordExample(paths, { agent: "page.md", kind: "generalizable", instruction: LESSON, before: "", after: "", feedback: "x", session: "ses_1" });
    const entry = recordExample(paths, { agent: "page.md", kind: "generalizable", instruction: LESSON, before: "", after: "", feedback: "x again", session: "ses_1" });
    assert.equal(entry.count, 1, "same session should count once");
    assert.equal(eligibleExamples(paths, "page.md").length, 0);
  });
});

test("an a11y_policy lesson is eligible immediately, without corroboration", () => {
  withTemp((paths) => {
    recordExample(paths, {
      agent: "page.md",
      kind: "a11y_policy",
      instruction: "Headings must not skip levels",
      before: "",
      after: "",
      feedback: "h1 jumped to h3",
      session: "ses_1",
    });
    assert.equal(eligibleExamples(paths, "page.md", ["a11y_policy"]).length, 1);
    assert.match(examplesForPrompt(paths, "page.md", ["a11y_policy"]), /Headings must not skip levels/);
  });
});
