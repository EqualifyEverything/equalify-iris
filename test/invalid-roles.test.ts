// Issue #345: a delivered document shipped `role="doc-footnotes"`, which is not an ARIA role at
// all. DPUB defines `doc-footnote` for one note and `doc-endnotes` for a collection, and never a
// plural of the first. axe reports `aria-roles` at **critical** — the only critical violation any
// benchmarked arm produced across 274 delivered pages — the shipped page model emitted it on 3 of
// the 22 occasions it had to name that role, and both models in the loop passed it 4 times out of
// 4, twice on pages they had failed for other reasons and bought a correction for.
//
// Two halves are pinned here, the same division as test/deprecated-roles.test.ts. The axe facts
// the fix reasons from — that the name really is invalid, that the gate really does fail it at
// critical, that the alternatives the prompt now names really do pass, and that `isValidRole`
// agrees with the gate token for token, which is the only thing the strip trusts. And the strip
// itself (`stripInvalidRoles` in src/pipeline/roles.ts): what it removes, the one malformed shape
// it declines and why declining is right there, that an ordinary document comes back byte
// identical, and that it runs at both ends the deprecated strip runs at.
//
// The prompt half — the FOOTNOTES clause saying the plural does not exist — is pinned in
// test/page-prompt.test.ts beside the #187 clauses it sits next to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import axe from "axe-core";
import { runAxe } from "../src/pipeline/lint.ts";
import { wrapDocument, assembleBodyWithReport } from "../src/pipeline/assembly.ts";
import { stripInvalidRoles, stripDeprecatedRoles } from "../src/pipeline/roles.ts";
import { runReview } from "../src/pipeline/review.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// test/deprecated-roles.test.ts's harness: a lint that could not run reports no `violations`
// (#164), which is not a clean document, so that case returns null and the test declines to
// conclude anything rather than reading a degradation as a pass.
async function rules(body: string): Promise<string[] | null> {
  const lint = await runAxe(wrapDocument(`<h1>Operator's manual</h1>\n<p>Before use.</p>\n${body}`));
  if (!lint.violations) return null;
  assert.equal(lint.ok, lint.violations.length === 0, "lint.ok disagrees with its own violation list");
  return lint.violations.map((v) => `${v.id}[${v.impact}]`);
}

const NOTES = '<ol><li id="fn-1">Graduated rate schedule. <a href="#fnref-1">↩</a></li></ol>';
const REPORTED = `<section role="doc-footnotes">${NOTES}</section>`;

test("the reported markup is a critical violation of the shipped gate, and the strip clears it", async () => {
  const found = await rules(REPORTED);
  if (found === null) return;
  assert.deepEqual(
    found,
    ["aria-roles[critical]"],
    `expected the reported violation alone, got: ${found.join(", ") || "none"}`,
  );
  const stripped = stripInvalidRoles(REPORTED);
  assert.equal(stripped.html, `<section>${NOTES}</section>`);
  const after = await rules(stripped.html);
  if (after === null) return;
  assert.deepEqual(after, [], `the stripped block should lint clean, got: ${after.join(", ")}`);
});

// The three shapes the FOOTNOTES clause offers instead. The clause tells the agent all three pass,
// which is a promise about axe and not about taste, so it is checked rather than asserted — and
// `<section aria-label>` is the one that matters most, because it is the only one of them that
// leaves the block with a name. If a version bump made any of them fail, the prompt would be
// prescribing markup that fails on every footnote list.
test("every wrapper the prompt offers instead passes the gate", async () => {
  for (const shape of [
    `<aside>${NOTES}</aside>`,
    `<footer>${NOTES}</footer>`,
    NOTES,
    `<section aria-label="Footnotes">${NOTES}</section>`,
    // And the valid neighbour the invalid name is one letter from, which the strip must not touch.
    `<section role="doc-endnotes">${NOTES}</section>`,
  ]) {
    const found = await rules(shape);
    if (found === null) return;
    assert.deepEqual(found, [], `the prompt promises this passes: ${shape} — got ${found.join(", ")}`);
    assert.equal(stripInvalidRoles(shape).html, shape, `nothing to strip here: ${shape}`);
  }
});

// What the strip trusts, and the reason it asks axe instead of holding a list of role names: the
// guard and the gate have to be one judgement. This is the test the throw in roles.ts points at.
// It fails if an axe upgrade moves `isValidRole`, changes its default about abstract roles, or
// disagrees with the rule that reports the document — and each of those would otherwise show up as
// either a document delivering an invented role or a strip eating a real one.
//
// It is asked in LOWER CASE, which is the one place the two are not the same function: the rule
// case-folds a role token and `isValidRole` does not. Asking it as written cost `role="DOC-ENDNOTES"`
// its landmark in the first version of this pass, on a document the gate called clean — the case
// two rows down.
test("isValidRole is the same judgement as the aria-roles rule, token for token", async () => {
  const isValidRole = (axe as { commons?: { aria?: { isValidRole?: (r: string) => boolean } } }).commons?.aria
    ?.isValidRole;
  assert.equal(typeof isValidRole, "function", "roles.ts's oracle is gone: axe.commons.aria.isValidRole");
  for (const [role, valid] of [
    // The defect, and the two real roles it is built out of.
    ["doc-footnotes", false],
    ["doc-footnote", true],
    ["doc-endnotes", true],
    // Another plural a model could reach for the same way, so the strip is not one name wide.
    ["doc-bibliographies", false],
    // An abstract role: in axe's table, and still not something an author may use. `isValidRole`
    // has to say so with no second argument, because that is how roles.ts calls it.
    ["roletype", false],
    ["widget", false],
    ["doc-pagebreak", true],
  ] as [string, boolean][]) {
    assert.equal(isValidRole!(role), valid, `isValidRole("${role}") should be ${valid}`);
    const found = await rules(`<div role="${role}">x</div>`);
    if (found === null) continue;
    // The gate fails a role attribute exactly when no token in it is valid, which is what makes
    // "strip what isValidRole rejects" the same set the gate would have reported.
    assert.deepEqual(
      found,
      valid ? [] : ["aria-roles[critical]"],
      `the gate and isValidRole disagree about role="${role}": gate said ${found.join(", ") || "clean"}`,
    );
  }
});

// The one divergence, pinned on its own because it is the case that made the first version of this
// pass wrong. `isValidRole` is case-sensitive and the `aria-roles` rule is not, so an uppercase
// spelling of a REAL role is a role the gate accepts and a bare oracle rejects — and the strip must
// follow the gate, or it deletes a landmark off a document nothing was complaining about. The
// uppercase spelling of an INVENTED role fails both, and still goes.
test("an uppercase spelling of a real role is kept, and of an invented one is stripped", async () => {
  const isValidRole = (axe as { commons?: { aria?: { isValidRole?: (r: string) => boolean } } }).commons!.aria!
    .isValidRole!;
  assert.equal(isValidRole("DOC-ENDNOTES"), false, "isValidRole has become case-insensitive");
  assert.equal(isValidRole("doc-endnotes"), true);

  const real = '<section role="DOC-ENDNOTES"><ol><li id="fn-1">A note.</li></ol></section>';
  assert.equal(stripInvalidRoles(real).html, real, "an uppercase real role must survive the strip");
  const realFound = await rules(real);
  if (realFound !== null) {
    assert.deepEqual(realFound, [], `the gate accepts this document, so the strip must too: ${realFound.join(", ")}`);
  }

  const invented = '<section role="DOC-FOOTNOTES"><ol><li id="fn-1">A note.</li></ol></section>';
  const strip = stripInvalidRoles(invented);
  assert.equal(strip.html, '<section><ol><li id="fn-1">A note.</li></ol></section>');
  assert.deepEqual(strip.stripped, ["DOC-FOOTNOTES"], "the name is recorded as the page wrote it");
  const inventedFound = await rules(invented);
  if (inventedFound !== null) {
    assert.deepEqual(inventedFound, ["aria-roles[critical]"], `expected the gate to fail this: ${inventedFound.join(", ")}`);
  }
});

// Every role Iris's own code writes, and the DPUB vocabulary a page agent is likeliest to reach
// for. This pass removes anything it does not recognise, so a wrong oracle would not fail loudly —
// it would quietly take the page markers, the endnote landmarks and the figure roles out of every
// document. That is the failure this test exists to make impossible to ship.
test("the strip leaves every role the pipeline itself emits, and the DPUB set, alone", () => {
  for (const role of [
    "main", "banner", "region", "img", "link", "doc-pagebreak", "doc-endnotes", "doc-bibliography",
    "doc-footnote", "doc-noteref", "doc-biblioref", "doc-backlink", "doc-toc", "doc-index",
    "doc-glossary", "doc-appendix", "doc-chapter", "doc-part", "doc-preface", "doc-foreword",
    "doc-introduction", "doc-abstract", "doc-acknowledgments", "doc-afterword", "doc-conclusion",
    "doc-epilogue", "doc-prologue", "doc-colophon", "doc-cover", "doc-credit", "doc-dedication",
    "doc-epigraph", "doc-errata", "doc-example", "doc-notice", "doc-pullquote", "doc-qna",
    "doc-subtitle", "doc-tip",
  ]) {
    const markup = `<div role="${role}">x</div>`;
    assert.equal(stripInvalidRoles(markup).html, markup, `should be left alone: role="${role}"`);
  }
  // And the two roles ARIA deprecates that are still valid roles: they are the other strip's
  // business (roles.ts, #187), on the elements where they are redundant, and never this one's.
  for (const markup of ['<li role="doc-endnote">1</li>', '<div role="directory">x</div>']) {
    assert.equal(stripInvalidRoles(markup).html, markup, `not this pass's business: ${markup}`);
  }
});

test("an invented role is removed, whatever the page's quoting", () => {
  for (const [before, after] of [
    ['<section role="doc-footnotes">n</section>', "<section>n</section>"],
    ['<footer role="doc-footnotes">n</footer>', "<footer>n</footer>"],
    ['<aside id="notes" role="doc-footnotes">n</aside>', '<aside id="notes">n</aside>'],
    ['<aside role="doc-footnotes" id="notes">n</aside>', '<aside id="notes">n</aside>'],
    ["<section role='doc-footnotes'>n</section>", "<section>n</section>"],
    ["<section role=doc-footnotes>n</section>", "<section>n</section>"],
    // Case in the attribute name and the tag is HTML's business; case in the VALUE is ARIA's, and
    // the gate fails this one, so the strip takes it.
    ['<SECTION Role="DOC-FOOTNOTES">n</SECTION>', "<SECTION>n</SECTION>"],
    // A name nobody has emitted yet, which is the point of doing this by class: the next model to
    // invent one is covered by code written before it existed.
    ['<div role="doc-notes">n</div>', "<div>n</div>"],
    // ARIA takes the first token it recognises, so this pair was never a violation — the good
    // token survives with the page's own quoting, for the reason the deprecated strip gives.
    ['<section role="doc-footnotes doc-endnotes">n</section>', '<section role="doc-endnotes">n</section>'],
    ["<section role='doc-endnotes doc-footnotes'>n</section>", "<section role='doc-endnotes'>n</section>"],
    // An unencoded `>` in an earlier attribute value, which the tag scan reads quoted values as
    // units for. Ending the tag at that `>` would leave no `role` in the slice and the strip would
    // silently not happen.
    ['<div title="If x > y, stop" role="doc-footnotes">n</div>', '<div title="If x > y, stop">n</div>'],
  ]) {
    assert.equal(stripInvalidRoles(before).html, after, `strip of: ${before}`);
  }
});

// The guard in the scan, and the reason it is not tidiness. The JSON-escaping leak
// (#233/#234/#257) delivers `role=\"doc-pagebreak\"`, where the unquoted value reads as the single
// character `\`. Stripping that would cut one character out of the middle of an attribute and glue
// the rest to the tag name — markup mangled worse than the violation it was fixing. The document is
// left exactly as it arrived, and everything that was reporting the leak goes on reporting it.
test("a role the scan cannot read whole is declined, not edited", async () => {
  for (const leaked of [
    '<hr role=\\"doc-pagebreak\\" aria-label=\\"Page 34\\">',
    '<section role=\\"doc-footnotes\\">n</section>',
    // The same hazard without a backslash: a bare value running into a quote.
    '<div role=x"y">n</div>',
  ]) {
    const strip = stripInvalidRoles(leaked);
    assert.equal(strip.html, leaked, `should be left exactly as it arrived: ${leaked}`);
    assert.deepEqual(strip.stripped, []);
    assert.equal(strip.nodes, 0);
  }
  // And the gate is still reporting it, so declining costs no evidence.
  const found = await rules('<hr role=\\"doc-pagebreak\\" aria-label=\\"Page 34\\">');
  if (found === null) return;
  assert.ok(
    found.includes("aria-roles[critical]"),
    `the declined case should still fail the gate, got: ${found.join(", ") || "none"}`,
  );
});

test("what was removed is reported, one entry per token and one node per element", () => {
  const body =
    '<section role="doc-footnotes"><ol><li id="fn-1">1</li></ol></section>\n' +
    '<div role="doc-notes">x</div>';
  const strip = stripInvalidRoles(body);
  assert.deepEqual(strip.stripped, ["doc-footnotes", "doc-notes"]);
  assert.equal(strip.nodes, 2, "two elements were edited, which is what aria-roles would have reported");
  // Token-wise and element-wise come apart only on markup nothing real produces. `nodes` is the
  // number a log reports, so the difference is pinned.
  const two = stripInvalidRoles('<div role="doc-footnotes doc-notes">x</div>');
  assert.deepEqual(two.stripped, ["doc-footnotes", "doc-notes"]);
  assert.equal(two.nodes, 1);
  assert.equal(two.html, "<div>x</div>");
  // A recorded name is cut, because unlike the three deprecated names these are unbounded text out
  // of a user's document and this field is logged.
  const long = stripInvalidRoles(`<div role="${"z".repeat(200)}">x</div>`);
  assert.equal(long.stripped.length, 1);
  assert.equal(long.stripped[0]!.length, 40, "an invented name is cut before it reaches a log line");
});

// The property the review loop depends on, the same one the deprecated strip is held to:
// `review_converged` decides a round changed nothing by comparing two body strings, so a pass that
// reformatted the document would make every round look like a change and spend the whole budget.
// It has to hold for the documents that mention these names in prose too — the pre-check matches
// any `role` attribute at all, so most documents reach the scan.
test("a document with nothing to strip comes back byte-identical", () => {
  for (const body of [
    "<h1>Title</h1>\n<p>Plain content.</p>",
    '<hr role="doc-pagebreak" aria-label="Page 3">\n<ol><li id="fn-1">A note.</li></ol>',
    "<p>There is no such role as <code>doc-footnotes</code>; the plural was never defined.</p>",
    // Escaped markup in a code sample. The pipeline transcribes documents about HTML too, and
    // nothing in the tag scan should be able to reach text content.
    '<p>Never write <code>&lt;section role="doc-footnotes"&gt;</code>.</p>',
    // An empty role is ignored by ARIA and by the gate, so there is nothing here to remove and no
    // token to report.
    '<div role="">x</div>',
    '<div role>x</div>',
    // `role=` INSIDE another attribute's value. The words here are alt text and accessible names —
    // the thing this whole pass exists to protect — and a locator that searched the attribute slice
    // for `\s+role=` deleted a word out of the middle of each of them. See the test below for what
    // makes them reachable and why the spaced form matters.
    '<img src="p3.png" alt="Permissions table: each user and role = admin, editor or viewer">',
    '<p aria-label="Table 3 role=guest counts">x</p>',
    '<div title="see role=footer for details">x</div>',
    // The same thing where the pseudo-value is the LAST thing in the value, so nothing follows it
    // to look like a separator.
    '<img src="p4.png" alt="the column headed role=admin">',
  ]) {
    const strip = stripInvalidRoles(body);
    assert.equal(strip.html, body, `should be unchanged: ${body}`);
    assert.deepEqual(strip.stripped, []);
    assert.equal(strip.nodes, 0);
  }
});

// The attribute is found by WALKING the attributes as a parser does, and this is the test that
// requires it. A search for `\s+role=` anywhere in the slice matches inside a quoted value, and
// what sits in quoted values is exactly the prose this pass exists to protect: `alt`,
// `aria-label`, `title`. `role\s*=\s*` accepts the spaced form too, which is how the phrase
// actually appears in English — "each user and role = admin" — so a screenshot of a permissions
// table, a figure showing ARIA markup, or a manual about user roles all reach it with no config or
// code change.
//
// The loss is unreportable, which is why it is worse than the violation it was fixing: the alt is
// still non-empty and not generic, so nothing in the gate or in `delivered_alt` can see a word has
// gone, and the only trace is an `invalid_roles_stripped` line naming `admin,` as an invented role
// — evidence pointing at the page agent for something this pass did.
test("a `role=` inside another attribute's value is prose, and is not an attribute", () => {
  // The mangling cases, byte-for-byte, so a locator that regresses says which word it ate.
  for (const body of [
    '<img src="p3.png" alt="Permissions table: each user and role = admin, editor or viewer">',
    '<p aria-label="Table 3 role=guest counts">x</p>',
    '<div title="see role=footer for details">x</div>',
    "<div title='single quotes role=footer too'>x</div>",
  ]) {
    assert.equal(stripInvalidRoles(body).html, body, `prose is not an attribute: ${body}`);
  }
  // The worse half of the same defect: the pseudo-value came FIRST, and the locator stops at the
  // first thing it matches, so the old pass damaged the `title` and left the real invalid role in
  // place. The document went on failing `aria-roles` at critical, now with mangled markup, and the
  // log said a strip had happened. Walking finds the real attribute wherever it sits.
  const both = stripInvalidRoles('<div title="see role=footer for details" role="doc-footnotes">x</div>');
  assert.equal(both.html, '<div title="see role=footer for details">x</div>');
  assert.deepEqual(both.stripped, ["doc-footnotes"]);
  assert.equal(both.nodes, 1);
  // And a real role BEFORE the prose, which the old locator happened to get right — pinned so the
  // fix is not one-directional.
  const first = stripInvalidRoles('<div role="doc-footnotes" title="see role=footer for details">x</div>');
  assert.equal(first.html, '<div title="see role=footer for details">x</div>');
  assert.deepEqual(first.stripped, ["doc-footnotes"]);
  // The other half of the fix, and a second way the old pass could edit the wrong text: the
  // replacement is spliced BY POSITION rather than searched for. Here the attribute text of the
  // real `role` occurs verbatim inside the `title` before it, and a search-and-replace edits the
  // first copy — deleting from the accessible name and leaving the invalid role standing.
  const twin = stripInvalidRoles('<div title=\' role="doc-notes"\' role="doc-notes">n</div>');
  assert.equal(twin.html, '<div title=\' role="doc-notes"\'>n</div>');
  assert.deepEqual(twin.stripped, ["doc-notes"]);
});

// A repeated attribute is the first one, because that is the element the browser builds and the
// element axe sees: rewriting the second would edit a string nothing reads, and report a strip that
// changed nothing about the document. The valueless case is the same rule — an empty role is
// ignored, so the element has nothing invalid on it however the second copy is spelled.
test("a repeated role is the first one, which is the only one that exists", () => {
  const inert = '<li role="listitem" role="doc-notes">n</li>';
  assert.equal(stripInvalidRoles(inert).html, inert);
  assert.deepEqual(stripInvalidRoles(inert).stripped, []);
  const valueless = '<div role role="doc-notes">n</div>';
  assert.equal(stripInvalidRoles(valueless).html, valueless);
  // The other order does strip, and leaves the repeat behind — the pass is not in the business of
  // tidying duplicate attributes, only of removing a role that is not a role.
  assert.equal(stripInvalidRoles('<li role="doc-notes" role="listitem">n</li>').html, '<li role="listitem">n</li>');
});

// The same defect, in the pass that has been shipping since #187, and this half is live on `main`.
// The review that found the hazard read the name-plus-host table as protection: a token is removed
// only when it is one of three names AND the element is a host for it. But `directory` is an
// ordinary English word — the pre-check comment in roles.ts says so in as many words — and `<ul>`
// is one of its hosts, so a list whose accessible name mentions a staff directory lost the word.
// Nothing about it is specific to the new pass; it is the locator, which both passes share.
test("the deprecated strip does not read prose inside an attribute value either", () => {
  for (const body of [
    '<ul aria-label="the role=directory column">x</ul>',
    // The spaced form, which is the one an English sentence actually uses. Armed deliberately with
    // a word in front of `role`: the old locator needed `\s+` before it, so a `role=` sitting flush
    // against the opening quote was safe by accident and would have been a true negative here.
    '<ol title="marked role = directory in the source">x</ol>',
    '<li aria-label="marked role=doc-endnote in the source">n</li>',
  ]) {
    const strip = stripDeprecatedRoles(body);
    assert.equal(strip.html, body, `prose is not an attribute: ${body}`);
    assert.deepEqual(strip.stripped, []);
    assert.equal(strip.nodes, 0);
  }
  // Still strips the real thing when both are present, and from wherever it sits.
  assert.equal(
    stripDeprecatedRoles('<ul aria-label="the role=directory column" role="directory">x</ul>').html,
    '<ul aria-label="the role=directory column">x</ul>',
  );
});

test("the strip runs where pages are joined, and reports what it removed", () => {
  const fragments = [
    { order: 1, innerHtml: "<h1>Manual</h1>\n<p>Before use.</p>", page: 1, source: "p1.png" },
    {
      order: 2,
      innerHtml: '<section role="doc-footnotes"><ol><li id="fn-1">A note.</li></ol></section>',
      page: 2,
      source: "p2.png",
    },
  ] as unknown as Parameters<typeof assembleBodyWithReport>[0];
  const { body, invalidRoles } = assembleBodyWithReport(fragments);
  assert.deepEqual(invalidRoles.stripped, ["doc-footnotes"]);
  assert.equal(invalidRoles.nodes, 1);
  assert.match(body, /<section><ol><li id="fn-1">A note\.<\/li><\/ol><\/section>/, "only the role should have gone");
});

test("an ordinary join reports no strip and is not rewritten", () => {
  const fragments = [
    { order: 1, innerHtml: "<h1>Manual</h1>", page: 1, source: "p1.png" },
    { order: 2, innerHtml: '<section role="doc-endnotes"><ol><li id="fn-1">A note.</li></ol></section>', page: 2, source: "p2.png" },
  ] as unknown as Parameters<typeof assembleBodyWithReport>[0];
  const { body, invalidRoles } = assembleBodyWithReport(fragments);
  assert.deepEqual(invalidRoles.stripped, []);
  assert.equal(invalidRoles.nodes, 0);
  assert.match(body, /<section role="doc-endnotes">/);
});

// The other end, and the one #187 showed was needed: assembly cannot see a rewrite that has not
// happened yet, and the Copy Editor writes fresh markup on every round. The harness is
// test/deprecated-roles.test.ts's.
async function loop(editorReply: (shown: string) => string, body: string): Promise<{
  result: Awaited<ReturnType<typeof runReview>>;
  events: { type: string; data: Record<string, unknown> }[];
  editors: number;
}> {
  const dir = mkdtempSync(join(tmpdir(), "iris-invalid-roles-"));
  try {
    let editors = 0;
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const ctx = {
      sessionId: "ses_test",
      images: [],
      maxReviewIterations: 3,
      extractionConcurrency: 4,
      recheckSampleSize: 1,
      paths: {
        agentsDir: join(dir, "agents"),
        tmpAgentsDir: () => join(dir, "tmp-agents"),
        agentMemory: () => join(dir, "memory", "page.json"),
      } as unknown as Paths,
      router: {
        complete: async (agent: string, _cap: string, messages: { content: string }[]) => {
          if (agent === "reader") {
            return {
              text: JSON.stringify({
                issues: [{ issue: "the footnote block is unnamed", severity: "low", suggested_action: "name it", pages: [] }],
              }),
            };
          }
          editors++;
          const prompt = messages.map((m) => m.content).join("\n");
          const given = prompt.match(
            /## Current document \(body content, in numbered blocks\)\n([\s\S]*?)\n\n## Issues to fix/,
          );
          assert.ok(given, "the editor prompt no longer carries the body where this test reads it");
          return { text: editorReply(given[1]) };
        },
      },
      log: {
        event: (type: string, data: Record<string, unknown> = {}) => events.push({ type, data }),
        agentCall: () => {},
      },
    } as unknown as PipelineContext;
    const result = await runReview(ctx, { body, lint: { ok: true, violations: [] } });
    return { result, events, editors };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CLEAN_NOTES = '<h1>Manual</h1>\n<ol><li id="fn-1">A note.</li></ol>';

test("an invented role the copy editor introduces does not reach the delivered document", async () => {
  // The role arrives on the first round beside a real edit, so later rounds hand back what they
  // were given and the loop converges: one round that introduced one, one strip to show for it.
  let first = true;
  const round = await loop((shown) => {
    if (!first) return JSON.stringify({ edits: [] });
    // Only on the first round: after the strip, block 1 is the `<section>` the round left behind,
    // which is the whole point of the assertions below.
    assert.match(shown, /<!-- @block 1 -->\n<ol>/, "block 1 is not the note list");
    first = false;
    // One edit standing for two top-level nodes, which is how a fix that splits a block is
    // written (#250) — so the round has a real change in it beside the role.
    return JSON.stringify({
      edits: [{ block: 1, html: '<section role="doc-footnotes"><ol><li id="fn-1">A note.</li></ol></section>\n<p>Note.</p>' }],
    });
  }, CLEAN_NOTES);
  assert.doesNotMatch(round.result.body, /doc-footnotes/, "the invented role reached the body");
  assert.doesNotMatch(round.result.html, /doc-footnotes/, "the invented role reached the document");
  assert.match(round.result.body, /<section><ol><li id="fn-1">A note\.<\/li><\/ol><\/section>/, "only the role should have gone");
  assert.match(round.result.body, /<p>Note\.<\/p>/, "the round's real edit was lost");

  const logged = round.events.filter((e) => e.type === "invalid_roles_stripped");
  assert.equal(logged.length, 1, "the strip is the only trace left, so it has to be logged");
  assert.deepEqual(logged[0].data, {
    stage: "correction_round",
    iteration: 1,
    roles: ["doc-footnotes"],
    nodes: 1,
  });
});

// The ordering claim in review.ts: the strip runs before the loop compares bodies, so a round whose
// only effect was a role this removes is a round that changed nothing — which ends the loop instead
// of buying another round to undo the same attribute.
test("a round whose only change is a role this strips is not credited as a change", async () => {
  const round = await loop(
    () => JSON.stringify({ edits: [{ block: 1, html: '<ol role="doc-footnotes"><li id="fn-1">A note.</li></ol>' }] }),
    CLEAN_NOTES,
  );
  assert.equal(round.editors, 1, "the loop should have stopped on the round that changed nothing");
  assert.equal(round.result.body, CLEAN_NOTES);
  const editor = round.events.filter((e) => e.type === "editor");
  assert.equal(editor[0].data.changed, false, "the `editor` line should report the body that ships");
  assert.equal(round.events.filter((e) => e.type === "review_converged").length, 1);
});
