import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

// The CI reviewer is told two things that pull against each other: flag docs prose that is not
// concise plain language, and do not flag style. Both are true only because the second names the
// first as its one exception — remove that sentence and the prompt holds a rule and its own
// prohibition, which is the shape that produces neither behaviour reliably.
//
// So this pins the reconciliation rather than the wording. It reads the prompt GitHub actually
// hands the model, not the file's bytes: the clause lives in a block scalar, so a byte-level grep
// matches indentation that is not part of the string, and would also match a copy of the sentence
// in a comment where it binds nothing.
//
// CONTRIBUTING.md is in here too because it is where the rules are stated for humans and the
// prompt only restates them. The two lists of bound files are what drift: a future PR that adds a
// documented directory to one and not the other leaves the reviewer enforcing a different scope
// than the one contributors are told about, and nothing else in this repo would notice.
const ROOT = join(import.meta.dirname, "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "code-review.yml");
const CONTRIBUTING = join(ROOT, "CONTRIBUTING.md");

// The file set CONTRIBUTING.md's Documentation section binds. Each is spelled as the inline code
// span both documents use, because that spelling is what a reader matches on — and a bare `docs`
// would match the word in prose.
const BOUND_FILES = ["`README.md`", "`docs/`", "`config.example.yaml`", "`agents/`"];

function reviewPrompt(): string {
  const doc = parse(readFileSync(WORKFLOW, "utf8")) as {
    jobs: Record<string, { steps?: { name?: string; with?: { prompt?: string } }[] }>;
  };
  const steps = Object.values(doc.jobs).flatMap((j) => j.steps ?? []);
  const step = steps.find((s) => s.name === "Claude review");
  assert.ok(step, "code-review.yml still has a step named `Claude review`");
  const prompt = step.with?.prompt;
  assert.ok(typeof prompt === "string" && prompt.length > 0, "and that step still carries a prompt");
  return prompt;
}

// A markdown section of the prompt, by heading text, so an assertion cannot be satisfied by the
// same sentence appearing under a different heading. `## Do NOT flag` and `## Should flag ...` are
// the two that have to agree.
function section(text: string, headingStartsWith: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex(
    (l) => l.startsWith("## ") && l.slice(3).trim().startsWith(headingStartsWith),
  );
  assert.notEqual(start, -1, `the prompt still has a \`## ${headingStartsWith}\` section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

// A phrase in a wrapped prompt is broken by a newline and the block scalar's own indentation, so
// every match here runs against text with its whitespace collapsed. Matching the raw string makes
// an assertion pass or fail on where the line happened to wrap.
function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// One list item, from its `- ` to the next one. The unit matters: both assertions below are about
// what a single bullet says, and a bullet that leans on its neighbour for a caveat is read alone.
function bullet(text: string, containing: string): string {
  const items = text.split(/\n(?=- )/).map(flat);
  const hit = items.filter((i) => i.includes(containing));
  assert.equal(
    hit.length,
    1,
    `exactly one bullet contains ${JSON.stringify(containing)}; found ${hit.length}`,
  );
  return hit[0]!;
}

test("the reviewer's docs-prose rule is scoped to the files CONTRIBUTING.md binds", () => {
  const prose = bullet(
    section(reviewPrompt(), "Should flag"),
    "Docs prose that is not concise plain language",
  );
  for (const file of BOUND_FILES) {
    assert.ok(
      prose.includes(file),
      `the docs-prose bullet names ${file}. A file set stated in CONTRIBUTING.md and not here is ` +
        `a scope the contributor is promised and the reviewer never applies:\n${prose}`,
    );
  }
  // Without a quotable anchor the finding is unfalsifiable, and an unfalsifiable style note is the
  // thing the rule below exists to keep out of reviews.
  assert.match(
    prose,
    /quote the sentence and name the rule/i,
    `the bullet still requires the sentence quoted and the rule named:\n${prose}`,
  );
});

test("the prompt's do-not-flag-style rule names the docs-prose exception", () => {
  const style = bullet(section(reviewPrompt(), "Do NOT flag"), "Style, formatting, or naming");
  assert.match(
    style,
    /docs-prose bullet above/,
    `the style bullet points at the docs-prose bullet as its exception. Without that pointer the ` +
      `prompt forbids what it asks for two sections earlier:\n${style}`,
  );
  // The exception has to stay narrow in the same breath, or "prose" widens into the formatting
  // review this repo has deliberately never had.
  for (const outOfScope of ["heading style", "line length"]) {
    assert.ok(
      style.includes(outOfScope),
      `the style bullet still holds ${outOfScope} out of scope inside those files:\n${style}`,
    );
  }
});

test("CONTRIBUTING.md's Documentation section binds the same files the prompt does", () => {
  const documentation = (() => {
    const text = readFileSync(CONTRIBUTING, "utf8");
    const start = text.indexOf("\n## Documentation\n");
    assert.notEqual(start, -1, "CONTRIBUTING.md still has a `## Documentation` section");
    const rest = text.slice(start + 1);
    const end = rest.indexOf("\n## ", 1);
    return end === -1 ? rest : rest.slice(0, end);
  })();
  for (const file of BOUND_FILES) {
    assert.ok(
      documentation.includes(file),
      `CONTRIBUTING.md's Documentation section names ${file}. The prompt enforces this list, so a ` +
        `file dropped here is one the reviewer keeps flagging with no stated rule behind it`,
    );
  }
});
