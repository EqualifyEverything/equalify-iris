import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordExample,
  eligibleExamples,
  examplesForPrompt,
  lessonSlug,
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

// ---------------------------------------------------------------------------
// lessonSlug: the dedupe key of the issue a lesson gets proposed on
// ---------------------------------------------------------------------------
//
// The slug's job is to make the title of an `Agent update proposal:` issue depend on
// WHICH lesson it proposes. Without it that title had exactly one possible value on the
// feedback path (`agentFile` is hardcoded to page.md), so the first open issue deduped
// away every later lesson from every user for as long as it stayed open.
//
// Two properties matter and they pull against each other: the slug must agree with the
// bank's own notion of lesson identity — or a repeat report opens a second issue — and it
// must differ between different lessons, or one issue swallows unrelated ones.

test("the slug agrees with the bank on which lessons are the same lesson", () => {
  withTemp((paths) => {
    // `recordExample` dedupes on the instruction normalized (case, punctuation and
    // whitespace folded), so two reports it corroborates into ONE entry have to slug
    // identically — otherwise they land on two issues while the bank counts them as one.
    const a = "Preserve all hyperlinks from the source document";
    const b = "  preserve ALL hyperlinks, from the source document!  ";
    for (const [i, instruction] of [a, b].entries()) {
      const entry = recordExample(paths, {
        agent: "page.md",
        kind: "generalizable",
        instruction,
        before: "",
        after: "",
        feedback: "links were dropped",
        session: `ses_${i}`,
      });
      assert.equal(entry.count, i + 1, "the bank did not treat these as the same lesson");
    }
    assert.equal(lessonSlug(a), lessonSlug(b));
  });
});

test("different lessons get different slugs", () => {
  // The whole point: two lessons for the same agent must not compute one title. Both of
  // these are real page.md lessons from user feedback on the UIC deployment.
  assert.notEqual(
    lessonSlug("Preserve all hyperlinks from the source document"),
    lessonSlug("Transcribe visible text faithfully, including typos in the source"),
  );
});

test("a slug is short, whole-worded, and does not end mid-thought", () => {
  const slug = lessonSlug(
    "Preserve all hyperlinks from the source document, including inline links within body text, " +
      "so that anchor elements and their href values are carried over faithfully",
  );
  assert.ok(slug.length <= 60, `slug too long for a title: ${slug.length} chars`);
  assert.equal(slug, "preserve all hyperlinks from the source document");
  // Truncation must not leave a dangling connective ("…from the source document
  // including"), which reads as a bug in the title of a public issue.
  assert.doesNotMatch(slug, /\b(and|or|the|a|an|of|to|in|for|from|with|including)$/);
});

test("an unsluggable lesson yields nothing rather than a fragment", () => {
  // The empty case has a caller behind it: `createAgentUpdateIssue` falls back to the
  // bare title when the slug is empty, rather than titling an issue with a fragment.
  assert.equal(lessonSlug(""), "");
  assert.equal(lessonSlug("   ...!!!   "), "");
  assert.equal(lessonSlug("Use <th> for header cells"), "use th for header cells");
  // One word longer than the cap is kept whole: a single word still discriminates
  // between lessons, an empty slug does not.
  const long = "a".repeat(80);
  assert.equal(lessonSlug(long), long);
});
