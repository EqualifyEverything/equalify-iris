// Issue #187: a delivered document shipped `aria-deprecated-role` from one node — a footnote
// list item, `<li id="p3-fn-1" role="doc-endnote">`, inside an `<ol role="doc-endnotes">` that
// is itself correct. The pipeline linted the document, the gate said no, the Copy Editor was
// told the rule had failed and rewrote five sections, and the role survived to delivery.
//
// Two things are pinned here. The axe facts the fix reasons from — which roles are deprecated,
// that the list role is not one of them, and that the shipped gate really does fail the
// reported markup and pass the stripped markup. And the strip itself (src/pipeline/roles.ts):
// what it removes, what it deliberately leaves for the gate, and that a document with nothing
// to strip comes back the same string, which is what the review loop's change detection and
// `anchors.ts`'s reserialization caution both depend on.
//
// The prompt half of the fix — the FOOTNOTES rule that tells the page agent not to emit these
// at all — is pinned in test/page-prompt.test.ts, the way #145's wording is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import axe from "axe-core";
import { runAxe } from "../src/pipeline/lint.ts";
import { wrapDocument, assembleBodyWithReport } from "../src/pipeline/assembly.ts";
import { stripDeprecatedRoles } from "../src/pipeline/roles.ts";
import { runReview } from "../src/pipeline/review.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// Same harness as test/pagebreak-marker.test.ts: a lint that could not run reports no
// `violations` (#164), which is not a clean document, so that case returns null and the test
// declines to conclude anything.
async function rules(body: string): Promise<string[] | null> {
  const lint = await runAxe(wrapDocument(`<h1>Operator's manual</h1>\n<p>Before use.</p>\n${body}`));
  if (!lint.violations) return null;
  assert.equal(lint.ok, lint.violations.length === 0, "lint.ok disagrees with its own violation list");
  return lint.violations.map((v) => `${v.id}[${v.impact}]`);
}

const REPORTED =
  '<ol role="doc-endnotes">\n' +
  '  <li id="p3-fn-1" role="doc-endnote"><sup>1</sup> Graduated rate schedule. See appendix B. ' +
  '<a href="#p3-fnref-1">↩</a></li>\n' +
  "</ol>";

test("the reported markup — role=doc-endnote on the list item — is a violation of the shipped gate", async () => {
  const found = await rules(REPORTED);
  if (found === null) return;
  assert.deepEqual(
    found,
    ["aria-deprecated-role[minor]"],
    `expected the reported violation alone, got: ${found.join(", ") || "none"}`,
  );
});

test("the same list with the item's role removed is clean, landmark role and all", async () => {
  const found = await rules(stripDeprecatedRoles(REPORTED).html);
  if (found === null) return;
  assert.deepEqual(found, [], `the stripped list should lint clean, got: ${found.join(", ")}`);
});

// The claim the strip rests on: these three and no others, so "remove the attribute" can be
// mechanical. If a version bump deprecates a fourth role, this fails and REDUNDANT_ON is the
// thing to revisit — the new role may have no host element that already says it, in which case
// stripping it is not the right remedy and the prompt is the only fix.
test("axe deprecates exactly the three roles the strip knows about", () => {
  const roles = axe.utils.getStandards().ariaRoles as unknown as Record<string, { deprecated?: boolean }>;
  const deprecated = Object.keys(roles)
    .filter((r) => roles[r].deprecated)
    .sort();
  assert.deepEqual(deprecated, ["directory", "doc-biblioentry", "doc-endnote"]);
  // And the role on the LIST is not one of them, which is why the strip is about items: taking
  // `doc-endnotes` off would remove a landmark the document is entitled to.
  assert.notEqual(roles["doc-endnotes"].deprecated, true, "doc-endnotes is now deprecated too");
  assert.notEqual(roles["doc-bibliography"].deprecated, true, "doc-bibliography is now deprecated too");
});

test("a deprecated role is removed from the element whose own role already says it", () => {
  for (const [before, after] of [
    ['<li role="doc-endnote">A note.</li>', "<li>A note.</li>"],
    ['<li id="fn-1" role="doc-endnote">A note.</li>', '<li id="fn-1">A note.</li>'],
    ['<li role="doc-endnote" id="fn-1">A note.</li>', '<li id="fn-1">A note.</li>'],
    ['<li role="doc-biblioentry">Smith, J.</li>', "<li>Smith, J.</li>"],
    ['<ul role="directory">\n<li>Ash</li>\n</ul>', "<ul>\n<li>Ash</li>\n</ul>"],
    ['<ol role="directory"><li>Ash</li></ol>', "<ol><li>Ash</li></ol>"],
    // Single-quoted and unquoted values are both legal HTML and both come back without the
    // attribute; the quoting of a value that survives is the page's own (below).
    ["<li role='doc-endnote'>A note.</li>", "<li>A note.</li>"],
    ["<li role=doc-endnote>A note.</li>", "<li>A note.</li>"],
    // Case in the attribute name and in the tag, since neither is case-sensitive in HTML.
    ['<LI Role="doc-endnote">A note.</LI>', "<LI>A note.</LI>"],
    // ARIA takes the first token it recognises, so this one was already inert — removed
    // anyway, because it is still text in the file saying the wrong thing.
    ['<li role="listitem doc-endnote">A note.</li>', '<li role="listitem">A note.</li>'],
    ['<li role="doc-endnote listitem">A note.</li>', '<li role="listitem">A note.</li>'],
    ["<li role='doc-endnote listitem'>A note.</li>", "<li role='listitem'>A note.</li>"],
  ]) {
    assert.equal(stripDeprecatedRoles(before).html, after, `strip of: ${before}`);
  }
});

// The deliberate limit, and the reason it is one: deleting the role off a `<div>` would leave
// nothing at all marking the element as a note, trading a reported violation for a silent
// loss. DPUB's remedy there is to make it a list item, which is a restructure and not an
// attribute rewrite, so the gate keeps reporting it — as the second half of this test checks.
test("a deprecated role on an element that does NOT already say it is left for the gate", async () => {
  for (const kept of [
    '<div role="doc-endnote">A note.</div>',
    '<p role="doc-biblioentry">Smith, J.</p>',
    '<dl role="directory"><dt>Ash</dt><dd>2</dd></dl>',
    // A `<li>` is a listitem, an `<ol>` is not — a role on the wrong host is not redundant
    // with anything and this pass does not move it.
    '<ol role="doc-endnote"><li>A note.</li></ol>',
  ]) {
    const strip = stripDeprecatedRoles(kept);
    assert.equal(strip.html, kept, `should be left alone: ${kept}`);
    assert.deepEqual(strip.stripped, []);
  }
  const found = await rules('<div role="doc-endnote">A note.</div>');
  if (found === null) return;
  assert.deepEqual(
    found,
    ["aria-deprecated-role[minor]"],
    `the case the strip declines should still fail the gate, got: ${found.join(", ") || "none"}`,
  );
});

test("what was removed is reported, one entry per node, so a log can say how many", () => {
  const body =
    '<ol role="doc-endnotes"><li role="doc-endnote">1</li><li role="doc-endnote">2</li></ol>\n' +
    '<ul role="directory"><li>Ash</li></ul>';
  const strip = stripDeprecatedRoles(body);
  assert.deepEqual(strip.stripped, ["doc-endnote", "doc-endnote", "directory"]);
  assert.equal(strip.html.includes("doc-endnote>"), false);
  assert.match(strip.html, /<ol role="doc-endnotes">/, "the list's own landmark role must survive");
});

// The property the review loop depends on. `review_converged` decides a round changed nothing
// by comparing two body strings, so a pass that reformatted the document — a DOM round trip
// would — could make every round look like a change and spend the whole budget. It also has
// to hold for the documents that mention these roles in prose, which the pre-check matches.
test("a document with nothing to strip comes back byte-identical", () => {
  for (const body of [
    "<h1>Title</h1>\n<p>Plain content.</p>",
    '<ol role="doc-endnotes">\n  <li id="fn-1">A note. <a href="#fnref-1">↩</a></li>\n</ol>',
    '<p>The deprecated roles are <code>directory</code>, <code>doc-biblioentry</code> and <code>doc-endnote</code>.</p>',
    '<p>See the <a href="#directory">directory</a>, or the staff directory on page 4.</p>',
    // An unencoded `>` inside an attribute value: the tag scan reads quoted values as units,
    // so this neither ends the tag early nor is edited.
    '<img src="a.png" alt="If x > y, stop">\n<li role="listitem">Fine</li>',
    "<li>A note.</li>",
  ]) {
    const strip = stripDeprecatedRoles(body);
    assert.equal(strip.html, body, `should be unchanged: ${body}`);
    assert.deepEqual(strip.stripped, []);
  }
});

// Nothing in the tag scan should be able to reach text content, and the roles are ordinary
// enough words that a document will say them. Escaped markup in a code sample is the case
// that matters: the pipeline transcribes documents about HTML too.
test("the strip edits attributes, never text — including markup shown as an example", () => {
  const body =
    "<p>Do not write <code>&lt;li role=\"doc-endnote\"&gt;</code> — the role is deprecated.</p>\n" +
    '<pre><code>&lt;ul role="directory"&gt;&lt;/ul&gt;</code></pre>';
  assert.equal(stripDeprecatedRoles(body).html, body);
});

test("the strip runs where pages are joined, and reports what it removed", () => {
  const fragments = [
    { order: 1, innerHtml: "<h1>Manual</h1>\n<p>Before use.</p>", page: 1, source: "p1.png" },
    {
      order: 2,
      innerHtml: '<ol role="doc-endnotes"><li id="fn-1" role="doc-endnote">A note.</li></ol>',
      page: 2,
      source: "p2.png",
    },
  ] as unknown as Parameters<typeof assembleBodyWithReport>[0];
  const { body, deprecatedRoles } = assembleBodyWithReport(fragments);
  assert.deepEqual(deprecatedRoles, ["doc-endnote"]);
  assert.match(body, /<li id="fn-1">A note\.<\/li>/, "the item should have lost only its role");
  assert.match(body, /<ol role="doc-endnotes">/, "the list should keep its landmark");
});

// The other end of the fix, and the one #187 actually needed: the role survived a Copy Editor
// round that was told the rule had failed and rewrote five sections. Assembly cannot see a
// rewrite that has not happened yet, so the loop strips what a round hands back.
//
// The harness is test/review-converge.test.ts's, cut down: a Reader that always reports the
// same issue and an editor whose reply is a function of the body it was given.
async function loop(editorReply: (body: string) => string, body: string): Promise<{
  result: Awaited<ReturnType<typeof runReview>>;
  events: { type: string; data: Record<string, unknown> }[];
  editors: number;
}> {
  const dir = mkdtempSync(join(tmpdir(), "iris-roles-"));
  try {
    let editors = 0;
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const ctx = {
      sessionId: "ses_test",
      images: [],
      maxReviewIterations: 3,
      extractionConcurrency: 4,
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
                issues: [
                  {
                    issue: "the deprecated ARIA role on the footnote item",
                    severity: "low",
                    suggested_action: "remove it",
                    pages: [],
                  },
                ],
              }),
            };
          }
          editors++;
          const prompt = messages.map((m) => m.content).join("\n");
          const given = prompt.match(/## Current document \(body content\)\n([\s\S]*?)\n\n## Issues to fix/);
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

const CLEAN_NOTES = '<h1>Manual</h1>\n<ol role="doc-endnotes"><li id="fn-1">A note.</li></ol>';

test("a deprecated role the copy editor introduces does not reach the delivered document", async () => {
  // The role arrives on the first round only, alongside a real edit, so the rounds after it
  // hand back the body they were given and the loop converges — one round that introduced
  // one, and one strip to show for it.
  let first = true;
  const round = await loop((body) => {
    const html = first ? body.replace('<li id="fn-1">', '<li id="fn-1" role="doc-endnote">') + "\n<p>Note.</p>" : body;
    first = false;
    return JSON.stringify({ html });
  }, CLEAN_NOTES);
  assert.doesNotMatch(round.result.body, /doc-endnote"/, "the item's deprecated role reached the body");
  assert.doesNotMatch(round.result.html, /doc-endnote"/, "the item's deprecated role reached the document");
  assert.match(round.result.body, /<ol role="doc-endnotes">/, "the list lost its landmark too");
  assert.match(round.result.body, /<p>Note\.<\/p>/, "the round's real edit was lost");

  const logged = round.events.filter((e) => e.type === "deprecated_roles_stripped");
  assert.equal(logged.length, 1, "the strip is the only trace left, so it has to be logged");
  assert.deepEqual(logged[0].data, {
    stage: "correction_round",
    iteration: 1,
    roles: ["doc-endnote"],
    nodes: 1,
  });
});

// The ordering claim in review.ts: the strip runs before the loop compares bodies, so a round
// whose only effect was a role the strip removes is a round that changed nothing — which ends
// the loop instead of buying another whole-body rewrite to undo the same attribute.
test("a round whose only change is a role this strips is not credited as a change", async () => {
  const round = await loop(
    (body) => JSON.stringify({ html: body.replace('<li id="fn-1">', '<li id="fn-1" role="doc-endnote">') }),
    CLEAN_NOTES,
  );
  assert.equal(round.editors, 1, "the loop should have stopped on the round that changed nothing");
  assert.equal(round.result.body, CLEAN_NOTES);
  const editor = round.events.filter((e) => e.type === "editor");
  assert.equal(editor[0].data.changed, false, "the `editor` line should report the body that ships");
  assert.equal(round.events.filter((e) => e.type === "review_converged").length, 1);
});

test("an ordinary join reports no strip and is not rewritten", () => {
  const fragments = [
    { order: 1, innerHtml: "<h1>Manual</h1>", page: 1, source: "p1.png" },
    { order: 2, innerHtml: '<ol role="doc-endnotes"><li id="fn-1">A note.</li></ol>', page: 2, source: "p2.png" },
  ] as unknown as Parameters<typeof assembleBodyWithReport>[0];
  const { body, deprecatedRoles } = assembleBodyWithReport(fragments);
  assert.deepEqual(deprecatedRoles, []);
  assert.equal(body, '<h1>Manual</h1>\n\n<ol role="doc-endnotes"><li id="fn-1">A note.</li></ol>');
});
