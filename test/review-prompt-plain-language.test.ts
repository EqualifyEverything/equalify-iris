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
// CONTRIBUTING.md and docs/ci.md are in here too. CONTRIBUTING.md is where the rules are stated for
// humans and the prompt only restates them; docs/ci.md is where this workflow's behaviour is
// documented. Three copies of one file set is what drifts: a PR that adds a documented directory to
// one and not the others leaves the reviewer enforcing a different scope than the one contributors
// are told about, and nothing else in this repo would notice.
const ROOT = join(import.meta.dirname, "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "code-review.yml");
const CONTRIBUTING = join(ROOT, "CONTRIBUTING.md");
const CI_DOC = join(ROOT, "docs", "ci.md");

// The file set CONTRIBUTING.md's Documentation section binds, spelled as the inline code span both
// documents use — a bare `docs` would match the word in prose.
//
// Pinned here as well as compared between the two files, and that is the point: the comparison
// alone is a LOWER bound, so a PR adding a path to both lists at once widens what the reviewer
// enforces with nothing failing. The prompt names CONTRIBUTING.md as the authority, so that
// section is the enforced scope at PR head, and widening it should be a deliberate edit to this
// line rather than a side effect of a docs change. Adding a code directory here would put runtime
// code under a prose rule.
const BOUND_FILES = ["`README.md`", "`agents/`", "`config.example.yaml`", "`docs/`"];

// The same set without its backticks, for the one place that has to recognise a path written as
// plain prose.
const BOUND_BARE = BOUND_FILES.map((s) => s.replaceAll("`", "")).sort();

// Every inline code span, sorted, deduplicated. Both lists are prose, so this reads what a
// contributor reads rather than a structure neither file has.
function codeSpans(text: string): string[] {
  return [...new Set(text.match(/`[^`\n]+`/g) ?? [])].sort();
}

// A file or a directory, however it is spelled: a known extension, a trailing slash, or the bare word
// `agents`. `docs/ci.md` matches as a file and not also as a directory, because the lookahead requires
// the slash to end the token.
//
// Bare `docs` is deliberately NOT matched, and that asymmetry is measured rather than assumed. Stripped
// of their code spans, the four regions this file reads use `docs` as an ordinary word in 4 of 4 —
// starting with the prompt's own "Docs prose that is not concise plain language" — and `agents` in 0 of
// 4, where it appears only inside `agents/` or as the singular "agent prompts". So matching bare `docs`
// would fire on prose that binds nothing and the pin would be deleted by the first person it annoyed,
// while matching bare `agents` costs nothing. Both halves of that measurement are asserted below — the
// `docs` half as a floor, the `agents` half exactly — so a document that starts using `agents` as
// English fails a test instead of quietly making this regex wrong.
//
// The limit that remains, stated because this is where someone reaches for a wider regex: a scope
// member with no extension, no slash and no name this regex knows — "anything under src" — is
// invisible, and both readers accept an empty result. Reaching it needs a commit that widens the scope
// AND spells the new member that way.
const PATH_RE =
  /\b[A-Za-z0-9_.-]+\.(?:md|ya?ml|ts|tsx|json|sh|mjs)\b|\b[a-z0-9_.-]+\/(?![/\w])|\b[Aa]gents\b/g;

// Path-like tokens that are NOT inside a code span, minus CONTRIBUTING.md itself.
//
// This exists because every assertion below compares CODE SPANS, and a path written without
// backticks is invisible to all of them: a fifth path added as prose leaves a four-span list that
// `deepEqual` still accepts, while the reviewer reads the sentence and enforces five. So rather than
// teach each comparison to read prose — which would then have to tell a scope member apart from a
// mention — every one of these regions is required to keep its paths in backticks, and a bare one
// fails with a message saying to backtick it.
//
// CONTRIBUTING.md is excluded by name: it is the authority these regions cite, it is never a member
// of the set, and the citation is what makes the scope traceable.
function barePaths(text: string): string[] {
  const outsideSpans = text.replace(/`[^`\n]+`/g, " ");
  const hits = [...new Set(outsideSpans.match(PATH_RE) ?? [])];
  return hits.filter((t) => t !== "CONTRIBUTING.md").sort();
}

// Assert a region keeps its paths where the code-span comparisons can see them.
//
// `why` is a parameter because the reason differs by region and a message that states the wrong one is
// a message a reader cannot act on. Three of the four regions are compared with `codeSpans`, where a
// bare path is genuinely invisible; the fourth reads prose too, so its complaint is not invisibility.
function assertNoBarePaths(
  region: string,
  where: string,
  why = "A bare path is invisible to the set comparison in this test, so a widening written as prose " +
    "would pass — backtick it.",
): void {
  assert.deepEqual(barePaths(region), [], `${where} spells every path as an inline code span. ${why}\n${region}`);
}

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

// The four regions that state the scope. Named once each, because the last test compares them as a
// set and a region sliced twice is a region that can drift between two assertions.
//
// None of these locators may contain `docs` or `agents`. The last test asserts how those two words are
// used in each region, and a locator carrying one means rewording a region trips the locator FIRST —
// so the failure arrives as "step 4 is missing" instead of as the reconsider-the-regex message that
// test exists to print. Three of the four read that way before this was noticed.
function promptProseBullet(): string {
  return bullet(section(reviewPrompt(), "Should flag"), "that is not concise plain language");
}

// CONTRIBUTING.md's Documentation section, OPENING paragraph only, ended by `\n\n`: that paragraph is
// where the requirement states what it covers, and the rest of the section is free to name a file as
// an example without binding it.
function contributingBinding(): string {
  const text = readFileSync(CONTRIBUTING, "utf8");
  const start = text.indexOf("\n## Documentation\n");
  assert.notEqual(start, -1, "CONTRIBUTING.md still has a `## Documentation` section");
  const afterHeading = text.slice(start + "\n## Documentation\n".length);
  const binding = afterHeading.slice(0, afterHeading.indexOf("\n\n", afterHeading.indexOf("\n") + 1));
  assert.ok(binding.length > 0, "and that section still opens with a paragraph");
  return binding;
}

function contributingReviewBullet(): string {
  return bullet(readFileSync(CONTRIBUTING, "utf8"), "One exception:");
}

// The one numbered step in docs/ci.md that describes this check, `4.` to `5.`. Read as a step rather
// than by searching for a sentence: a copy of the file set is what is being pinned, and a search that
// misses would pass on an empty match.
function ciDocStep(): string {
  const text = readFileSync(CI_DOC, "utf8");
  const start = text.indexOf("\n4. Checks ");
  assert.notEqual(start, -1, "docs/ci.md still describes this check as review step 4");
  const rest = text.slice(start + 1);
  const end = rest.indexOf("\n5. ");
  assert.notEqual(end, -1, "and step 5 still follows it");
  const step = rest.slice(0, end);
  // The locator above is deliberately word-free, so it would select whatever step 4 happens to be if
  // the steps were reordered. This is what keeps it honest, and it names the rule rather than the
  // subject so that it is not itself a locator carrying `docs`.
  assert.match(
    step,
    /plain-language requirement/,
    `and step 4 is still the one describing the plain-language check, not a renumbered neighbour:\n${step}`,
  );
  return step;
}

test("the reviewer's docs-prose rule is scoped to the files CONTRIBUTING.md binds", () => {
  const prose = promptProseBullet();
  // Equality, not `includes` per path. A missing path is a scope contributors are promised and the
  // reviewer never applies; an extra one is a scope nothing in CONTRIBUTING.md justifies, and only
  // an exact comparison catches the second.
  assert.deepEqual(
    codeSpans(prose),
    BOUND_FILES,
    `the docs-prose bullet's file set matches BOUND_FILES exactly. If this widening is intended, ` +
      `edit BOUND_FILES and CONTRIBUTING.md's Documentation section in the same commit:\n${prose}`,
  );
  assertNoBarePaths(prose, "the prompt's docs-prose bullet");
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
  const binding = contributingBinding();
  assert.deepEqual(
    codeSpans(binding),
    BOUND_FILES,
    `CONTRIBUTING.md's Documentation section binds exactly BOUND_FILES. The prompt treats this ` +
      `section as the authority, so a path added here widens what the reviewer enforces — which is ` +
      `a change to make deliberately, in the same commit as BOUND_FILES and the prompt:\n${binding}`,
  );
  assertNoBarePaths(binding, "CONTRIBUTING.md's Documentation section");
});

// The fourth place a reader meets this scope, and the one a contributor is likeliest to read: the
// bullet under CONTRIBUTING.md's "What the automated review will say". It now points at the
// Documentation section instead of repeating the list, which is why this test allows NO paths as well
// as all of them. A partial copy is the failure — four lists agreeing today and a widening commit
// updating three of them leaves this bullet promising the old, narrower scope.
test("CONTRIBUTING.md's automated-review bullet does not keep its own copy of the scope", () => {
  const item = contributingReviewBullet();
  // Backticks stripped, so this reads a list written as prose as well as a backticked one. Unlike the
  // other three regions, which compare `codeSpans` and cannot see a prose path at all.
  const paths = [...new Set([...(item.replaceAll("`", "").match(PATH_RE) ?? [])])]
    .filter((t) => t !== "CONTRIBUTING.md")
    .sort();
  if (paths.length > 0 && JSON.stringify(paths) !== JSON.stringify(BOUND_BARE)) {
    // Two different failures, and calling both "a partial copy" sends a reader hunting for a missing
    // member that is right there. "README.md, docs/, config.example.yaml or agents" names every bound
    // path and spells one of them without its trailing slash; the set is complete and the spelling is
    // what fails.
    const names = (xs: string[]): string => JSON.stringify(xs.map((x) => x.replace(/\/$/, "")).sort());
    assert.fail(
      names(paths) === names(BOUND_BARE)
        ? `this bullet names every bound path but spells at least one without its trailing slash ` +
            `(${paths.join(", ")} against ${BOUND_BARE.join(", ")}). Nothing is missing — add the ` +
            `slash, and the backticks with it if the member is bare, which is how the other three ` +
            `copies of this set are written:\n${item}`
        : `this bullet either names no files or names all of BOUND_FILES. It names ${paths.join(", ")}, ` +
            `which is a partial copy of the scope — the shape that goes stale when the set widens. The ` +
            `fix is to delete the list and let the Documentation link carry it, NOT to backtick it. One ` +
            `member may also be missing from that list only because it is spelled \`docs\` without its ` +
            `slash, which PATH_RE cannot see; count what the bullet names before adding a path:\n${item}`,
    );
  }
  // AFTER the comparison above, deliberately, and the ordering is the whole point rather than a detail.
  // Both fire on a partial list written as prose, and their remedies are not equal: deleting the copy
  // leaves nothing to backtick, while backticking it leaves the copy partial and spends a second red run
  // reaching the message that names the defect. So the comparison speaks first, and this assertion prints
  // for the shape the comparison TOLERATES — a complete copy, where the content is accepted and the
  // spelling is the only complaint left.
  assertNoBarePaths(
    item,
    "CONTRIBUTING.md's automated-review bullet",
    "The comparison above reads prose, so this list is not invisible the way a bare path is in the " +
      "other three regions — the complaint is only the spelling, and those three write theirs as code " +
      "spans. If you did not mean to keep a copy of the set here at all, delete it and let the " +
      "Documentation link carry it.",
  );
  // Naming no files is only safe while the bullet says where the list does live. Without this, the
  // pointer could be deleted and the assertion above would still pass on a bullet that promises a
  // scope check and names no scope at all.
  assert.match(
    item,
    /\(#documentation\)/,
    `and it links the Documentation section, which is where the list it does not repeat lives:\n${item}`,
  );
});

test("docs/ci.md describes the same scope it documents", () => {
  const step = ciDocStep();
  assert.deepEqual(
    codeSpans(step),
    BOUND_FILES,
    `docs/ci.md's step 4 names exactly BOUND_FILES. This is the copy a deployer reads, so a path ` +
      `here that the prompt does not enforce is a promise nothing keeps:\n${step}`,
  );
  assertNoBarePaths(step, "docs/ci.md's step 4");
});

// Which bare words `PATH_RE` may match is a measurement of these four documents, not a property of the
// regex, so it is checked here rather than asserted in a comment — a comment should not be what talks
// the next reader out of changing it.
//
// Per word, and in both directions, because an `assert.match(/\b(docs|agents)\b/)` passes on either and
// so cannot report that one half has become false. `docs` is bare in 4 of 4 regions today and `agents`
// in 0 of 4, which is what licenses matching one and not the other.
//
// The two halves are pinned differently, and the asymmetry is the point rather than an oversight. One
// region is enough to keep `docs` OUT; one region is enough to keep `agents` IN only until that region
// changes. So the `docs` half is existential and the `agents` half universal, and each fails with the
// change its own quantifier licenses.
test("PATH_RE's bare-word list still matches how these four documents use those words", () => {
  const regions: [string, string][] = [
    ["the prompt's docs-prose bullet", promptProseBullet()],
    ["CONTRIBUTING.md's Documentation section", contributingBinding()],
    ["CONTRIBUTING.md's automated-review bullet", contributingReviewBullet()],
    ["docs/ci.md's step 4", ciDocStep()],
  ];
  const outsideSpans = (region: string): string => region.replace(/`[^`\n]+`/g, " ");

  // Existential, deliberately. Bare `docs` has to stay out of PATH_RE while ANY region uses it as an
  // ordinary word, because `assertNoBarePaths` would then report "backtick it" on that region — checked
  // rather than reasoned about: adding `\b[Dd]ocs\b` to PATH_RE today fails tests 1, 3 and 5 exactly
  // that way. A per-region version of this assertion would therefore print the wrong remedy the moment
  // the FIRST region was reworded, telling a reader to make a change that reddens three other tests.
  const withBareDocs = regions.filter(([, region]) => /\bdocs\b/i.test(outsideSpans(region)));
  assert.ok(
    withBareDocs.length > 0,
    `at least one of these ${regions.length} regions uses "docs" as an ordinary word outside a code ` +
      `span, which is why PATH_RE does not match it: the match would fire on prose that binds nothing, ` +
      `and a pin that cries wolf gets deleted. None does any more, so adding \`\\b[Dd]ocs\\b\` to ` +
      `PATH_RE is now safe and closes another part of the bare-word gap.`,
  );

  // Universal, and for the opposite reason: one bare use is enough to make this match cry wolf.
  //
  // The lookahead is not decoration. `\b` sits between `s` and `/`, so a plain `/\bagents\b/` matches the
  // `agents` inside a prose `agents/` — a path, not the English word, and its remedy is the "backtick it"
  // that `assertNoBarePaths` prints, not either of the two this message offers. Excluding a following
  // slash leaves exactly the readings named below.
  for (const [where, region] of regions) {
    assert.doesNotMatch(
      outsideSpans(region),
      /\bagents\b(?!\/)/i,
      `${where} still keeps "agents" inside a code span or writes the singular "agent", which is why ` +
        `PATH_RE DOES match it bare. Two things reach this, and they want opposite fixes: a region ` +
        `has started using "agents" as an ordinary word, in which case the match has to come out of ` +
        `PATH_RE — or a scope list spells \`agents/\` without its trailing slash, in which case add ` +
        `the slash, and the backticks with it since a bare member fails its region's bare-path check ` +
        `too, and leave PATH_RE alone. The failing text says which:\n${outsideSpans(region)}`,
    );
  }
});
