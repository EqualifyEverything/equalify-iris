// Issue #373 directive 3: settle in code the things that are free to settle, before the checker's
// word becomes an order.
//
// The defect is one page using an id twice. It is the one collision `namespaceAnchors` cannot fix —
// prefixing is per page, so both copies get the same `p3-` and stay collided — and its only
// remaining reporter is lint on the ASSEMBLED document, by which point the ids have been renamed and
// the finding names `p3-fn-1`, an id no page agent ever wrote, for a page nobody will look at again
// with the image in front of them. #373's own case is the other half of the same gap: asked whether
// ids are duplicated, nothing in the run knew, and the checker's guess became an instruction.
//
// Measured before it was built, over every page reply on disk (1,501 fragments, 1,421 carrying an
// id, no model call): 2 duplicate an id within themselves, both footnotes — `fnref-1` twice on
// `gpt-5.6-luna`, `numbering-note-1`/`-2` on `nova-2-lite` — and 0 of 328 on the deployed page model
// `kimi-k2.5`. So the rule fires on roughly one page in 750 and on none at all today, which is why
// the tests below spend most of their length on the half that carries information: what must NOT be
// flagged, and the zero printing with a denominator so a reader can tell "no page duplicated an id"
// from "the check never ran".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duplicateIdProblem, duplicateIds, idAudit } from "../src/pipeline/anchors.ts";
import { runExtraction } from "../src/pipeline/extraction.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// --- what the rule reads -------------------------------------------------------------

test("the duplicate is named once, however many copies there are, and the count is elements", () => {
  assert.deepEqual(idAudit(`<p id="a">1</p><p id="a">2</p>`), { ids: 2, duplicated: ["a"] });
  // Three copies is one defect with one repair sentence, and `ids` is what carries the multiplicity.
  assert.deepEqual(idAudit(`<p id="a">1</p><p id="a">2</p><p id="a">3</p>`), { ids: 3, duplicated: ["a"] });
  // Sorted, so a log read across rounds does not sort two identical findings differently.
  assert.deepEqual(duplicateIds(`<p id="b">1</p><p id="a">2</p><p id="b">3</p><p id="a">4</p>`), ["a", "b"]);
  assert.deepEqual(idAudit(`<p id="a">1</p><p id="b">2</p>`), { ids: 2, duplicated: [] });
});

test("a page with no ids reports a zero denominator rather than a clean bill", () => {
  // The distinction `ids_checked` exists for, one page down: 0 of 0 says nothing about this rule.
  assert.deepEqual(idAudit(`<h2>Page 1</h2><p>Ordinary prose.</p>`), { ids: 0, duplicated: [] });
  // And the screen that keeps the parse off the ordinary page's bill does not change the answer for
  // a fragment that writes the characters `id=` outside an attribute position.
  assert.deepEqual(idAudit(`<p>the attribute id= is written in prose here</p>`), { ids: 0, duplicated: [] });
});

test("ids are read off the parsed tree, so markup the parser DROPS invents no duplicate", () => {
  // The trade this rule makes, and it is the opposite of `sourceIds`' in the same file. There, a
  // missed id costs a duplicate lint reports, so over-collecting is safe; here an over-collected id
  // is a phantom duplicate, which buys a correction round against a defect the document does not
  // have — the exact failure #373 is about. So an orphan `<td>`, which the parser discards along
  // with its attributes, owns no id: this page has one `a`, not two.
  assert.deepEqual(idAudit(`<td id="a">x</td><p id="a">y</p>`), { ids: 1, duplicated: [] });
  // The same cell inside a table is a real element and a real collision.
  assert.deepEqual(idAudit(`<table><tr><td id="a">x</td></tr></table><p id="a">y</p>`), {
    ids: 2,
    duplicated: ["a"],
  });
  // A comment is not an element. The delivered fragments carry `@` markers that quote markup, and a
  // duplicate read out of one would buy a page call over text no reader is offered.
  assert.deepEqual(idAudit(`<p id="a">1</p><!-- <p id="a">2</p> -->`), { ids: 1, duplicated: [] });
  // And a value that quotes the attribute name is consumed as a unit, so there is no second id in it.
  assert.deepEqual(idAudit(`<p id="a" title="id=a">1</p>`), { ids: 1, duplicated: [] });
});

test("the id compared is the one the browser resolves, not the characters in the source", () => {
  // Decoded, because that is the value a fragment identifier is matched against — two spellings of
  // one id are one collision, and a source scan would report a clean page.
  assert.deepEqual(idAudit(`<p id="&#97;">1</p><p id="a">2</p>`), { ids: 2, duplicated: ["a"] });
  // Unquoted is a legal spelling and the same id.
  assert.deepEqual(idAudit(`<p id="a">1</p><p id=a>2</p>`), { ids: 2, duplicated: ["a"] });
  // Case-SENSITIVE, which is the direction that reports no defect where there is none: `fn-1` and
  // `FN-1` are two ids in HTML, and calling them a collision would buy a correction on a page whose
  // references all resolve.
  assert.deepEqual(idAudit(`<p id="fn-1">1</p><p id="FN-1">2</p>`), { ids: 2, duplicated: [] });
});

test("a blank id is not this rule's finding", () => {
  // Not a claim that `id=""` is fine — it is invalid markup, and two of them are two elements a
  // reference cannot reach. What does not fit is the remedy: "renumber every copy after the first"
  // is not the repair for an id with no name, and the sentence would quote an empty string back at
  // the model as the thing to rename. Never seen in 1,501 page replies.
  assert.deepEqual(idAudit(`<p id="">1</p><p id="">2</p>`), { ids: 0, duplicated: [] });
  assert.deepEqual(idAudit(`<p id="  ">1</p><p id="  ">2</p>`), { ids: 0, duplicated: [] });
});

test("the correction names the id, the references, and the repair on both ends", () => {
  const sentence = duplicateIdProblem("fn-1");
  assert.match(sentence, /id="fn-1"/, "the model has to be told which id");
  // Both duplicates measured on disk are footnote ids, which is where this matters most: renaming
  // the id and leaving the link behind turns a wrong target into a dangling one.
  assert.match(sentence, /href="#fn-1"/);
  assert.match(sentence, /repoint the reference/);
  assert.match(sentence, /Change nothing else/);
});

// --- through the pipeline ------------------------------------------------------------

interface Event {
  type: string;
  [k: string]: unknown;
}

interface PageSpec {
  first: string;
  verifyProblems?: string[];
  corrected?: string;
  recheckProblems?: string[];
}

// The same harness as test/generic-alt.test.ts, for the same reason: the sampled recheck is off
// unless asked for, so a measurement slot landing on one of these pages cannot put a second
// `page_correction_recheck` in the log for an unrelated reason.
function makeCtx(dir: string, events: Event[], specs: PageSpec[], prompts: string[], size = 0): PipelineContext {
  const agentsDir = join(dir, "agents");
  const fragDir = join(dir, "fragments");
  const inputDir = join(dir, "input");
  for (const d of [agentsDir, fragDir, inputDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
  writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\nvision\n");
  const names = specs.map((_, i) => `page-${String(i + 1).padStart(3, "0")}.png`);
  for (const n of names) writeFileSync(join(inputDir, n), "not-a-real-png");
  const orderOf = (user: string): number => {
    const byName = names.findIndex((n) => user.includes(n)) + 1;
    if (byName > 0) return byName;
    const inHtml = /<h2>Page (\d+)<\/h2>/.exec(user);
    return inHtml ? Number(inHtml[1]) : 0;
  };
  const verifies = new Map<number, number>();

  return {
    sessionId: "ses_test",
    images: names.map((name, i) => ({ name, order: i + 1, path: join(inputDir, name), links: [] })),
    extractionConcurrency: 1,
    recheckSampleSize: size,
    maxReviewIterations: 1,
    paths: {
      agentsDir,
      tmpAgentsDir: () => join(dir, "tmp-agents"),
      agentMemory: (agent: string) => join(dir, `mem-${agent.replace(/\.md$/, "")}.json`),
      sessionFragments: () => fragDir,
    } as unknown as Paths,
    router: {
      complete: async (_agent: string, _cap: string, messages: { role: string; content: string }[]) => {
        const user = messages.find((m) => m.role === "user")?.content ?? "";
        const order = orderOf(user);
        const spec = specs[order - 1];
        if (user.includes("TASK: verify")) {
          const n = (verifies.get(order) ?? 0) + 1;
          verifies.set(order, n);
          const problems = n === 1 ? (spec?.verifyProblems ?? []) : (spec?.recheckProblems ?? []);
          return { text: JSON.stringify({ faithful: problems.length === 0, accessible: problems.length === 0, problems }) };
        }
        if (user.includes("had fidelity/accessibility problems")) {
          prompts.push(user);
          return { text: JSON.stringify({ html: spec?.corrected ?? "" }) };
        }
        return { text: JSON.stringify({ html: spec?.first ?? "", log: "" }) };
      },
    },
    log: {
      event: (type: string, fields: Record<string, unknown>) => events.push({ type, ...fields }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iris-duplicate-ids-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const of = (events: Event[], type: string): Event[] => events.filter((e) => e.type === type);

// A page long enough that a correction of it is not read as a page being deleted
// (`CORRECTION_SHRINK_FLOOR`), carrying the shape both measured duplicates had: a footnote marker
// and its back-reference. Both marker ids are arguments, so a test can say what the first pass
// wrote and what the correction wrote in the same terms.
const body = (first: string, second: string) =>
  `<h2>Page 1</h2><p>The quarterly report opens with a summary of revenue, headcount and ` +
  `regional performance, and two of its sentences carry a footnote.<sup id="${first}">` +
  `<a href="#fn-1">1</a></sup> The second is on the paragraph below.<sup id="${second}">` +
  `<a href="#fn-2">2</a></sup></p>`;

// A throwaway sink for the tests that do not read the correction prompts back.
function prompts(): string[] {
  return [];
}

test("a page that PASSES its check and used one id twice buys a correction, and the rewrite is gated", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const captured: string[] = [];
    // The case the run could not see before: the verifier judges the fragment against the IMAGE,
    // where an id does not appear at all, so this defect is invisible to it — and lint, the only
    // component that does report it, sees the assembled document after every id has been renamed.
    await runExtraction(
      makeCtx(dir, events, [{ first: body("fnref-1", "fnref-1"), corrected: body("fnref-1", "fnref-2") }], captured),
    );

    const [found] = of(events, "page_duplicate_ids");
    assert.deepEqual(found.ids, ["fnref-1"], "the log names the id, not just the count");
    assert.equal(found.page, 1);

    const [corrected] = of(events, "page_corrected");
    assert.equal(corrected.trigger, "ids", "one source, so the trigger names it rather than reading `both`");
    assert.equal(corrected.result, "kept");
    assert.equal(corrected.problems, 1);

    // The sentence reached the model. This is a correction and not a rewrite in code because the
    // repair is to repoint whichever reference meant each copy, and only the agent that wrote the
    // page knows which sentence that was.
    assert.equal(captured.length, 1);
    assert.match(captured[0], /has id="fnref-1"/);

    // And the rewrite had to earn the standing the original had: this page had PASSED, so its
    // correction is re-verified and that verdict is binding.
    const [recheck] = of(events, "page_correction_recheck");
    assert.equal(recheck.binding, true);
    assert.equal(recheck.ok, true);
    assert.equal(recheck.ids_before, 1, "the id share of the bill, kept apart from the verdict's");
    assert.equal(recheck.alt_before, 0);
    assert.equal(recheck.links_before, 0);
    assert.equal(recheck.problems_before, 0, "the page had passed, so the verifier had named nothing");

    const [complete] = of(events, "extraction_complete");
    assert.equal(complete.ids_checked, 2);
    assert.equal(complete.ids_duplicated, 0, "the collision is gone from what shipped");
    assert.equal(of(events, "page_duplicate_ids_unrecovered").length, 0);
  });
});

test("a correction that moves the collision instead of clearing it is reported by name", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The pair a decision about the verifier's model needs, and the reason a free rule is worth
    // having over a model that finds the same defect: the check that raised the complaint can be
    // run again on the answer, exactly and for nothing. Here the rewrite renumbered BOTH copies to
    // the same new id, so `fnref-1` is clear and `fnref-2` now collides — a repair that moved the
    // defect rather than one that changed nothing, and only the ids on the line can tell those apart.
    await runExtraction(
      makeCtx(dir, events, [{ first: body("fnref-1", "fnref-1"), corrected: body("fnref-2", "fnref-2") }], prompts()),
    );

    const [unrecovered] = of(events, "page_duplicate_ids_unrecovered");
    assert.deepEqual(unrecovered.ids, ["fnref-2"], "the id that is still doubled, not the one that was");
    assert.equal(of(events, "page_corrected")[0].result, "kept", "the rewrite still changed the page");
    const [complete] = of(events, "extraction_complete");
    assert.equal(complete.ids_checked, 2);
    assert.equal(complete.ids_duplicated, 1, "a collision this step could not repair");
  });
});

test("a rejected id correction says what it was bought for", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The binding re-check refusing the rewrite. The page that ships is the one that passed, so the
    // duplicate stays — which the log has to be able to say, or the run reads as having repaired an
    // id it did not. `trigger` says a source fired and `both` would not say which, so the field is
    // what makes the refused call readable.
    await runExtraction(
      makeCtx(dir, events, [
        {
          first: body("fnref-1", "fnref-1"),
          corrected: body("fnref-1", "fnref-2").replace("headcount and ", ""),
          recheckProblems: ["the mention of headcount is gone"],
        },
      ], prompts()),
    );

    const [rejected] = of(events, "page_links_correction_rejected");
    assert.equal(rejected.trigger, "ids", "the event predates this trigger; the field is what disambiguates it");
    assert.deepEqual(rejected.ids, ["fnref-1"]);
    assert.deepEqual(rejected.links, [], "and no link was involved");
    assert.equal(rejected.alts, undefined, "nor an alt, which is omitted rather than reported empty");
    assert.equal(of(events, "page_corrected")[0].result, "rejected");

    const [complete] = of(events, "extraction_complete");
    assert.equal(complete.ids_duplicated, 1, "the page that shipped is the one with the collision");
    assert.equal(
      of(events, "page_duplicate_ids_unrecovered").length,
      0,
      "nothing was kept, so nothing was unrecovered",
    );
  });
});

test("a page that fails its check AND duplicates an id is one correction, triggered by both", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const captured: string[] = [];
    // `both` is more than one source, which is what it has always counted — so adding this fourth
    // one re-reads no line in an older log. What it does not do is name which sources, and that is
    // on purpose: the alternative is fifteen buckets, and the per-source detail is already exact on
    // `page_duplicate_ids`, keyed by the same image.
    await runExtraction(
      makeCtx(dir, events, [
        {
          first: body("fnref-1", "fnref-1"),
          verifyProblems: ["the table has no header row"],
          corrected: `${body("fnref-1", "fnref-2")}<table><tr><th>Region</th></tr></table>`,
        },
      ], captured),
    );

    const [corrected] = of(events, "page_corrected");
    assert.equal(corrected.trigger, "both");
    assert.equal(corrected.problems, 2, "one verdict problem and one id, in one page call");
    assert.match(captured[0], /no header row/);
    assert.match(captured[0], /has id="fnref-1"/);
    // No binding re-check: this page had failed, so the original has no standing to protect. The
    // sample is off in this harness, so the absence is the policy rather than a threshold that
    // happened to miss.
    assert.equal(of(events, "page_correction_recheck").length, 0);
  });
});

test("a run whose ids are all unique reports the zero with its denominator", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The instrument this rule needs most, because it fires on nothing the deployed model writes:
    // 0 of 328 page replies on `kimi-k2.5`. A field appearing only when it fires cannot tell "no
    // page duplicated an id" from "this run predates the check", and `ids_checked` is what makes
    // the zero a measurement rather than a silence.
    //
    // Page 3 is the case that makes the per-fragment count the only honest one: it reuses page 1's
    // ids, which is not a defect here — `namespaceAnchors` prefixes each page at assembly — and a
    // rule pooling the document's ids would report that fix as a failure.
    await runExtraction(
      makeCtx(dir, events, [
        { first: `<h2>Page 1</h2><p>Opening.<sup id="fnref-1"><a href="#fn-1">1</a></sup></p>` },
        { first: `<h2>Page 2</h2><p>No ids on this page at all.</p>` },
        { first: `<h2>Page 3</h2><p>Closing.<sup id="fnref-1"><a href="#fn-1">1</a></sup></p>` },
      ], prompts()),
    );

    assert.equal(of(events, "page_duplicate_ids").length, 0);
    assert.equal(of(events, "page_corrected").length, 0, "and no page call was bought");
    const [complete] = of(events, "extraction_complete");
    assert.equal(complete.ids_checked, 2, "one <sup> each on pages 1 and 3; the anchors carry no id");
    assert.equal(complete.ids_duplicated, 0);
  });
});
