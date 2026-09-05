// Issue #334 part B: a page that writes one word two ways has certainly got one of them wrong,
// whichever the paper prints, and that is decidable on the fragment for $0.
//
// The half of the hyphen family a strip cannot do. `stripSoftHyphens` (part A, #389) removes the
// INVISIBLE break, U+00AD, unconditionally, because there is no output where that character is
// right. Here the break is a visible `-`, Iris does not know which of the two spellings the page
// carries, and only the agent holding the image does — so this raises a problem and lets the
// correction pass settle it, on the same terms as a missing link or a placeholder `alt`.
//
// Measured before it was built, on #334's 100-page three-arm census. The self-contradiction column —
// the predicate implemented here, one word written both ways on one page — is non-zero on all three
// arms: `kimi-k2.5` (shipped) 6 words on 4 pages, `claude-sonnet-4-6` 3 on 3, `gpt-5.6-luna` 2 on 2.
// So unlike the alt rule (0 of 1,064) and the id rule (2 of 1,501), this one is EXPECTED to fire,
// which changes what the tests below have to spend their length on: not the zero printing, but the
// false-positive surface, since a rule that fires often is a rule whose wrong findings are bought.
//
// Three of the shipped model's six are `inter-state` and `non-farm` — forms a 1962 report genuinely
// prints, where the hyphen is right and the JOINED spelling is the defect. That is why nothing here
// names a winner, and why a decline on this check is a legitimate answer rather than the misuse
// `declined.code_checked` counts. `test/decline-false-problem.test.ts` holds that half.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitWordAudit, splitWordContradictions, splitWordProblem } from "../src/pipeline/hyphens.ts";
import { runExtraction } from "../src/pipeline/extraction.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// --- what the rule reads -------------------------------------------------------------

test("a word written both ways is one finding carrying both spellings as the page wrote them", () => {
  assert.deepEqual(splitWordContradictions(`<p>The Compos-ite index. The Composite index.</p>`), [
    { split: "Compos-ite", joined: "Composite" },
  ]);
  // Not lowercased on either side, and the joined form is the page's own rather than the split one
  // with its hyphen taken out: a corrector is being asked to find these strings in a document, and
  // quoting a spelling the page does not contain sends it looking for something that is not there.
  assert.deepEqual(splitWordContradictions(`<p>Compos-ite here. composite there.</p>`), [
    { split: "Compos-ite", joined: "composite" },
  ]);
  // Case-folded for the MATCH, which is the direction that finds the defect: `Compos-ite` at the
  // start of a table cell and `composite` mid-sentence are one word written two ways.
  assert.deepEqual(splitWordContradictions(`<p>compos-ite here. Composite there.</p>`), [
    { split: "compos-ite", joined: "Composite" },
  ]);
});

test("one word broken twice is one thing to fix", () => {
  // The opposite of `genericAlts`, which keeps duplicates: two images described `"image"` are two
  // descriptions to write, while two copies of one broken word are one spelling to settle.
  assert.deepEqual(
    splitWordContradictions(`<p>Compos-ite one. Compos-ite two. The Composite index.</p>`),
    [{ split: "Compos-ite", joined: "Composite" }],
  );
  // Deduped case-insensitively, so `Compos-ite` and `compos-ite` on one page are not two requests to
  // settle the same spelling.
  assert.deepEqual(
    splitWordContradictions(`<p>Compos-ite one. compos-ite two. The Composite index.</p>`),
    [{ split: "Compos-ite", joined: "Composite" }],
  );
  // Two different words broken on one page are two findings, in the order the split form appears.
  assert.deepEqual(
    splitWordContradictions(`<p>col-lections, Compos-ite, collections, Composite</p>`),
    [
      { split: "col-lections", joined: "collections" },
      { split: "Compos-ite", joined: "Composite" },
    ],
  );
});

test("a hyphenated word the page never writes whole is not a finding", () => {
  // The under-reporting direction, taken deliberately. A page that breaks a word and never writes it
  // whole is invisible here — the second spelling is what makes the first a contradiction — so this
  // rule's rate is a LOWER BOUND on #334's defect, not a measurement of it. #334's own cross-arm
  // version asks whether another arm delivered the word whole, and that is not available at run time
  // with one arm running.
  assert.deepEqual(splitWordContradictions(`<p>Agri-culture and Manu-facturing and Govern-ment.</p>`), []);
  // A hyphen the word itself owns, written consistently, is what the paper prints and is not touched.
  // `page.md:129` says so in as many words: "A hyphen the word itself owns survives that join."
  assert.deepEqual(splitWordContradictions(`<p>non-farm income and non-farm employment</p>`), []);
  // And only UNHYPHENATED words corroborate. `communications-related` is not evidence that
  // `Commu-nications` is broken: reading the parts of compounds as whole words makes every compound
  // its own corroboration, and turns `non-property` — printed with its hyphen on all three of #334's
  // arms — into a contradiction with itself.
  assert.deepEqual(
    splitWordContradictions(`<p>Commu-nications costs and communications-related outlays</p>`),
    [],
  );
});

test("a word broken in two places is skipped, and #334 named the cost of that", () => {
  // `Con-struc-tion` and `Trans-porta-tion` are on `p032` of that census, and its first detector
  // missed them for exactly this reason. Kept as a limit rather than fixed: neither word is written
  // whole anywhere on its own page, so admitting them adds nothing HERE on that corpus — which is a
  // fact about the corpus and not about the pattern.
  assert.deepEqual(splitWordContradictions(`<p>Con-struc-tion and Construction</p>`), []);
  // What one hyphen buys is the printed compound: `state-by-state` is skipped rather than compared
  // against a `statebystate` nothing writes.
  assert.deepEqual(splitWordContradictions(`<p>a state-by-state table and statebystate nowhere</p>`), []);

  // SKIPPED IN BOTH ROLES, which the first draft of this rule got wrong twice and this test could
  // not see. `WORD` matched at most one hyphen and matching restarts after the match, so a two-hyphen
  // word came out as its first two pieces PLUS its tail — and the tail then stood as evidence that
  // somebody else's break was a break.
  //
  // The assertion above passed for the wrong reason: it wrote `statebystate`, and the joined form the
  // tokeniser actually produced was `stateby`. That is the word to write.
  assert.deepEqual(splitWordContradictions(`<p>state-by-state and stateby</p>`), []);
  // And the tail as evidence: `date` is not a word this page writes, it is the end of `up-to-date`.
  assert.deepEqual(splitWordContradictions(`<p>up-to-date, the date is here, and dat-e</p>`), [
    { split: "dat-e", joined: "date" },
  ]);
  assert.deepEqual(splitWordContradictions(`<p>up-to-date, and dat-e</p>`), []);
  // Skipped from both roles, still counted in the denominator: `words` is how many words were read.
  assert.deepEqual(splitWordAudit(`<p>state-by-state and stateby</p>`), {
    words: 3,
    split: [],
  });
});

test("markup is not prose, so nothing inside a tag or a comment is evidence", () => {
  // Attributes are the false-positive surface, since `href`, `id` and `class` values carry hyphens by
  // convention. `id="non-tax"` beside the word `nontax` in the text is not a contradiction about
  // anything a reader is shown.
  assert.deepEqual(splitWordContradictions(`<p id="non-tax">the nontax total</p>`), []);
  assert.deepEqual(splitWordContradictions(`<p><a href="/inter-state">interstate commerce</a></p>`), []);
  // `alt` included, which is a stated limit and not a claim the case cannot happen: an `alt` is a
  // transcription surface, so a split word can live there and this will not find it. Admitting
  // attributes would mean either accepting `href`/`id` as evidence or building a second
  // attribute-aware reader, and nothing has measured the case.
  assert.deepEqual(splitWordContradictions(`<p><img src="f.png" alt="Compos-ite index"> Composite</p>`), []);
  // A comment is model-written prose ABOUT the document — `@unresolved` and the other markers, where
  // a model explains what it could not read — so it quotes the page's words freely. Counting one
  // would buy a correction for a page whose markup is fine.
  assert.deepEqual(splitWordContradictions(`<p>Composite</p><!-- Compos-ite was unclear -->`), []);
  // An unterminated comment eats to the end, as it does for the parser and for `alt.ts`.
  assert.deepEqual(splitWordContradictions(`<p>Composite</p><!-- Compos-ite`), []);
  // A `>` inside a quoted attribute value does not end the tag, so no attribute text leaks into the
  // comparison as prose.
  assert.deepEqual(splitWordContradictions(`<p title="a > Compos-ite b">Composite</p>`), []);
});

test("what counts as a word keeps ranges, table cells and identifiers out", () => {
  // Letters only. A printed year range and a table reference are not broken words, and admitting
  // digits would make a rule that fires on every statistical page in the corpus.
  assert.deepEqual(splitWordContradictions(`<td>1962-63</td><td>196263</td>`), []);
  assert.deepEqual(splitWordContradictions(`<td>12-4</td><td>124</td>`), []);
  // `_` is excluded too, so an identifier that leaked out of a code span is not read as a word.
  assert.deepEqual(splitWordContradictions(`<p>page_split_words and pagesplitwords</p>`), []);
});

test("an entity-spelled hyphen is still a hyphen in the markup", () => {
  // Decoded because a hyphen has spellings, and a page that writes one of them has still carried the
  // break into the markup. Decoded AFTER the tags are gone: decoding first turns a `&lt;` in prose
  // into a `<` and the tag pattern then eats the prose after it as a tag.
  assert.deepEqual(splitWordContradictions(`<p>Compos&#45;ite and Composite</p>`), [
    { split: "Compos-ite", joined: "Composite" },
  ]);
  assert.deepEqual(splitWordContradictions(`<p>Compos&#x2d;ite and Composite</p>`), [
    { split: "Compos-ite", joined: "Composite" },
  ]);
  // And a `&lt;` in prose is prose: the sentence after it is still read.
  assert.deepEqual(splitWordContradictions(`<p>a &lt; b. Compos-ite and Composite.</p>`), [
    { split: "Compos-ite", joined: "Composite" },
  ]);
});

test("the audit reports a denominator, so a zero can be told from a fragment with no prose", () => {
  // The pair `idAudit` returns, for its reason: 0 of 0 says nothing about the rule and 0 of 900 says
  // something. Occurrences and not distinct spellings, since what the number is for is telling a
  // fragment with prose in it from one without.
  assert.deepEqual(splitWordAudit(`<p>one two two three</p>`), { words: 4, split: [] });
  assert.deepEqual(splitWordAudit(`<table><tr><td>1962</td></tr></table>`), { words: 0, split: [] });
  const audit = splitWordAudit(`<p>The Compos-ite index and the Composite index.</p>`);
  assert.equal(audit.words, 7, "the hyphenated form counts once, as one word");
  assert.equal(audit.split.length, 1);
});

test("the correction request names both spellings and refuses to pick one", () => {
  const sentence = splitWordProblem({ split: "Compos-ite", joined: "Composite" });
  assert.match(sentence, /"Compos-ite"/, "the model has to be told which word");
  assert.match(sentence, /"Composite"/, "and what it is being contradicted by");
  assert.match(sentence, /source image/, "the image is what settles it");
  // The part to preserve through any rewording. Iris knows the page contradicts itself and cannot
  // know which way the printing goes — #334 has `non-tax` and `Agri-culture` as the same shape with
  // opposite answers, and three of the shipped model's six contradictions are forms the paper keeps
  // the hyphen on — so a request naming the winner would be Iris guessing at a fact the image
  // settles, and on a page that genuinely prints both it would introduce the defect.
  assert.match(sentence, /keep the hyphen if the word itself owns one/);
  assert.match(sentence, /drop it if it was only there to break the line/);
  // The licence to disagree, in the wording `correctPage` establishes for it. This problem has a real
  // refusal case, and without this sentence the alternative is a model repairing a faithful
  // transcription.
  assert.match(sentence, /If the page really does print both spellings, say so and change nothing/);
  assert.match(sentence, /Change nothing else/);
  // What it does NOT contain: an instruction to join, in any of the shapes a rewording might reach
  // for. Half of the measured cases would be damaged by one.
  assert.doesNotMatch(sentence, /remove the hyphen|join the|write it whole/i);
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

// The harness test/duplicate-ids.test.ts and test/generic-alt.test.ts use, for its reason: the
// sampled recheck is off unless asked for, so a measurement slot landing on one of these pages
// cannot put a second `page_correction_recheck` in the log for an unrelated reason.
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
  const dir = mkdtempSync(join(tmpdir(), "iris-split-words-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const of = (events: Event[], type: string): Event[] => events.filter((e) => e.type === type);

// A page long enough that a correction of it is not read as a page being deleted
// (`CORRECTION_SHRINK_FLOOR`), carrying #334's own case: `Compos-ite` against `Composite` on `p069`.
// Both spellings are arguments, so a test can say what the first pass wrote and what the correction
// wrote in the same terms.
const body = (first: string, second: string) =>
  `<h2>Page 1</h2><p>The quarterly report opens with a summary of revenue, headcount and regional ` +
  `performance, and the table below carries two index series. The ${first} index is given for each ` +
  `region, and the ${second} index for the nation as a whole, on the same 1957-59 base.</p>`;

function prompts(): string[] {
  return [];
}

test("a page that PASSES its check and wrote one word two ways buys a correction, and the rewrite is gated", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const captured: string[] = [];
    // The case a verifier reaches only by chance. #334 found both candidate verifiers raising this
    // family unprompted on four pages, so unlike a dropped link or a duplicate id it is not
    // structurally invisible to a verdict — but the incumbent raised soft hyphens on exactly one of
    // 45 control pages, so relying on it is relying on a 1-in-45 read. This is exact and free.
    await runExtraction(
      makeCtx(dir, events, [{ first: body("Compos-ite", "Composite"), corrected: body("Composite", "Composite") }], captured),
    );

    const [found] = of(events, "page_split_words");
    assert.deepEqual(found.words, ["Compos-ite / Composite"], "both spellings, which is the evidence");
    assert.equal(found.page, 1);

    const [corrected] = of(events, "page_corrected");
    assert.equal(corrected.trigger, "words", "one source, so the trigger names it rather than reading `both`");
    assert.equal(corrected.result, "kept");
    assert.equal(corrected.problems, 1);

    // The sentence reached the model, and it is a correction rather than a rewrite in code because
    // only the agent holding the image can say which spelling the printing carries.
    assert.equal(captured.length, 1);
    assert.match(captured[0], /writes one word two ways: "Compos-ite" in one place and "Composite" in another/);
    // The ENTRY, not the whole request — the licence paragraph below it names both marks, so a
    // whole-request search cannot tell which one this problem carries.
    const [entry] = captured[0]
      .split("\n")
      .filter((l) => /^\d+\. /.test(l))
      .map((l) => l.replace(/\s+/g, " "));
    assert.match(
      entry,
      /\(Iris checked in code that both spellings are on this page, not which one is right\.\)$/,
      "its own mark, which says what was settled and what was not",
    );
    assert.doesNotMatch(
      entry,
      /\(Iris checked this one in code\.\)/,
      "and NOT the mark whose licence sentence ends `so fix it`",
    );

    // And the rewrite had to earn the standing the original had: this page had PASSED, so its
    // correction is re-verified and that verdict is binding.
    const [recheck] = of(events, "page_correction_recheck");
    assert.equal(recheck.binding, true);
    assert.equal(recheck.ok, true);
    assert.equal(recheck.words_before, 1, "the word share of the bill, kept apart from the verdict's");
    assert.equal(recheck.ids_before, 0);
    assert.equal(recheck.alt_before, 0);
    assert.equal(recheck.problems_before, 0, "the page had passed, so the verifier had named nothing");

    const [complete] = of(events, "extraction_complete");
    assert.equal(complete.words_split, 0, "the contradiction is gone from what shipped");
    assert.ok((complete.words_checked as number) > 30, "and the denominator is the fragment's words");
    assert.equal(of(events, "page_split_words_unrecovered").length, 0);
  });
});

test("the request does not order a fix for the one problem whose remedy it cannot know", async () => {
  // The pin the counting depends on, and the defect the first draft shipped. `declined.words`,
  // `page_split_words_unrecovered`'s "may be the model declining" reading and the docs' "the licence
  // working rather than being stretched" all assume the corrector is allowed to refuse this one. That
  // permission lives in a THIRD text — not the problem, not the accounting, but the licence paragraph
  // — and giving the split-word entry `CHECKED_IN_CODE` put "so fix it" and "say so and change
  // nothing" in one message about one numbered entry. On `non-farm` beside `nonfarm`, a form a 1962
  // report really prints, obeying the general sentence puts a word the page does not print into
  // delivered content.
  //
  // So the two texts are pinned against each other here, in each other's words, the way
  // `test/decline-false-problem.test.ts` pins the licence against `CHECKED_IN_CODE`.
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const captured: string[] = [];
    await runExtraction(
      makeCtx(dir, events, [{ first: body("non-farm", "nonfarm"), corrected: body("non-farm", "non-farm") }], captured),
    );
    assert.equal(captured.length, 1);
    const request = captured[0].replace(/\s+/g, " ");

    // The sentence that ends "so fix it" names ONE mark, and it is not this problem's.
    assert.match(
      request,
      /A problem marked "\(Iris checked this one in code\.\)" is not one of these: it was settled against the source file or this page's own markup before you were asked, so fix it\./,
    );
    // And the sentence that governs this problem's mark says the opposite, in the terms the rest of
    // the paragraph rules out everywhere else.
    assert.match(
      request,
      /A problem marked "\(Iris checked in code that both spellings are on this page, not which one is right\.\)" is settled in one part and open in the other/,
    );
    assert.match(request, /which one this page prints is a question only the image answers/);
    assert.match(
      request,
      /If the image shows the page printing both spellings, make no change for it and say so — for this one problem, what the image shows IS a reason not to act\./,
    );
    // The problem's own closing sentence and the licence's now say one thing rather than two.
    assert.match(request, /If the page really does print both spellings, say so and change nothing\./);
  });
});

test("a correction that settles it the other way is a repair, not a failure", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The direction half of #334's measured cases go, and the reason nothing in this rule names a
    // winner: on `non-farm` and `inter-state` the paper keeps the hyphen, so the JOINED spelling is
    // the defect and the repair is to break the other one. Iris cannot tell these from `Agri-culture`
    // and does not try; a correction that hyphenates both is as much a repair as one that joins both.
    await runExtraction(
      makeCtx(dir, events, [{ first: body("non-farm", "nonfarm"), corrected: body("non-farm", "non-farm") }], prompts()),
    );

    assert.deepEqual(of(events, "page_split_words")[0].words, ["non-farm / nonfarm"]);
    assert.equal(of(events, "page_corrected")[0].result, "kept");
    assert.equal(of(events, "page_split_words_unrecovered").length, 0, "the page no longer contradicts itself");
    assert.equal(of(events, "extraction_complete")[0].words_split, 0);
  });
});

test("a correction that moves the contradiction instead of settling it is reported by name", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // Recomputed rather than intersected with the list going in, for `page_duplicate_ids_unrecovered`'s
    // reason: a rewrite that joins `Compos-ite` and breaks `collections` in the same reply has moved
    // the defect rather than failed to touch it, and only the words on the line separate those.
    await runExtraction(
      makeCtx(dir, events, [
        {
          first: `${body("Compos-ite", "Composite")}<p>collections of data and collections again</p>`,
          corrected: `${body("Composite", "Composite")}<p>col-lections of data and collections again</p>`,
        },
      ], prompts()),
    );

    const [unrecovered] = of(events, "page_split_words_unrecovered");
    assert.deepEqual(
      unrecovered.words,
      ["col-lections / collections"],
      "the word that is still written two ways, not the one that was",
    );
    assert.equal(of(events, "page_corrected")[0].result, "kept", "the rewrite still changed the page");
    assert.equal(of(events, "extraction_complete")[0].words_split, 1, "a contradiction this step did not settle");
  });
});

test("a rejected split-word correction says what it was bought for", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The binding re-check refusing the rewrite. The page that ships is the one that passed, so the
    // contradiction stays — which the log has to be able to say, or the run reads as having settled a
    // spelling it did not. `both` would not say which source fired, so `words` on the line is what
    // makes the refused call readable.
    await runExtraction(
      makeCtx(dir, events, [
        {
          first: body("Compos-ite", "Composite"),
          corrected: body("Composite", "Composite").replace("headcount and ", ""),
          recheckProblems: ["the mention of headcount is gone"],
        },
      ], prompts()),
    );

    const [rejected] = of(events, "page_links_correction_rejected");
    assert.equal(rejected.trigger, "words", "the event predates this trigger; the field is what disambiguates it");
    assert.deepEqual(rejected.words, ["Compos-ite / Composite"]);
    assert.deepEqual(rejected.links, [], "and no link was involved");
    assert.equal(rejected.alts, undefined, "nor an alt, which is omitted rather than reported empty");
    assert.equal(rejected.ids, undefined);
    assert.equal(of(events, "page_corrected")[0].result, "rejected");
    assert.equal(of(events, "extraction_complete")[0].words_split, 1, "the page that shipped is the one that split it");
    assert.equal(of(events, "page_split_words_unrecovered").length, 0, "nothing was kept, so nothing was unrecovered");
  });
});

test("a page that fails its check AND writes one word two ways is one correction, triggered by both", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const captured: string[] = [];
    // `both` is more than one source, which is what it has always counted — so adding this fifth one
    // re-reads no line in an older log. What it does not do is name which sources, and that is on
    // purpose: the alternative is thirty-one buckets where four sources gave fifteen, and the
    // per-source detail is already exact on `page_split_words`, keyed by the same image.
    await runExtraction(
      makeCtx(dir, events, [
        {
          first: body("Compos-ite", "Composite"),
          verifyProblems: ["the table has no header row"],
          corrected: `${body("Composite", "Composite")}<table><tr><th>Region</th></tr></table>`,
        },
      ], captured),
    );

    const [corrected] = of(events, "page_corrected");
    assert.equal(corrected.trigger, "both");
    assert.equal(corrected.problems, 2, "one verdict problem and one split word, in one page call");
    assert.match(captured[0], /no header row/);
    assert.match(captured[0], /"Compos-ite" in one place/);
    // No binding re-check: this page had failed, so the original has no standing to protect.
    assert.equal(of(events, "page_correction_recheck").length, 0);
  });
});

test("a word split on one page and whole on another is not a finding, and the zero prints", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The case that makes the per-fragment count the only honest one, and it is not the reason the id
    // rule counts per fragment. There, two pages sharing an id is fixed at assembly. Here it is not a
    // defect at all: a printing breaks a word wherever the column falls, so page 1 writing
    // `Compos-ite` and page 3 writing `Composite` is two pages transcribing what each shows. Pooling
    // the document's words would manufacture contradictions out of the corpus's whole vocabulary.
    await runExtraction(
      makeCtx(dir, events, [
        { first: `<h2>Page 1</h2><p>The Compos-ite index for each region is given in the table above.</p>` },
        { first: `<h2>Page 2</h2><p>No index series appears on this page at all.</p>` },
        { first: `<h2>Page 3</h2><p>The Composite index for the nation is given in the table below.</p>` },
      ], prompts()),
    );

    assert.equal(of(events, "page_split_words").length, 0);
    assert.equal(of(events, "page_corrected").length, 0, "and no page call was bought");
    const [complete] = of(events, "extraction_complete");
    assert.equal(complete.words_split, 0);
    // The denominator is what makes that zero a measurement rather than a silence — and on this rule
    // the zero is the reading to be suspicious of, since every arm on #334's census contradicted
    // itself somewhere.
    assert.ok((complete.words_checked as number) > 30, "three pages of prose were read");
  });
});
