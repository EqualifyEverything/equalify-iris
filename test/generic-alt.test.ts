// Issue #290: a placeholder where a description belongs — `alt="image"` — is a defect only the
// expensive verifier saw.
//
// Bench gutted a real alt on two pages, three repeats each, and read off whether the verifier's
// reply says in prose that the alt is a placeholder: Sonnet 4.6 (deployed) 6/6, Luna 5/6,
// qwen3-vl-235b 2/6, Haiku 4.5 1/6 with a false alarm on clean HTML, nova-2-lite 0/6. axe raises
// nothing on any of it, because `image-alt` asks whether the attribute is present. So the verifier
// downgrade #246 recommends is close to free on every other defect class and expensive here, and
// this file pins the free rule that buys it back.
//
// Two halves, and only one of them is evidence. That the rule flags the injected defects is true
// by construction — the same person chose the injection and the word list — so the tests below
// spend most of their length on the other half: the alts Iris actually writes, which must not be
// flagged. `1,064 non-empty alt occurrences across 32 bench run directories, 406 distinct values,
// 0 flagged` is the measurement, and the distinct values that come closest to the rule are
// asserted here so a widening of the list cannot quietly break it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { altTexts, genericAltProblem, genericAlts } from "../src/pipeline/alt.ts";
import { runExtraction } from "../src/pipeline/extraction.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

const img = (alt: string | null) => (alt === null ? `<img src="a0.png">` : `<img src="a0.png" alt="${alt}">`);

// --- what the rule reads -------------------------------------------------------------

test("only <img> is scanned, and only a non-empty alt is an alt", () => {
  assert.deepEqual(altTexts(`<p>x</p>${img("A sunset over water")}`), ["A sunset over water"]);
  // The three spellings source HTML allows for a value.
  assert.deepEqual(altTexts(`<img src=a alt='Home icon'>`), ["Home icon"]);
  assert.deepEqual(altTexts(`<img src=a alt=Home>`), ["Home"]);
  // An empty alt is a decision, not a missing description, so it is not in the corpus at all —
  // which is what keeps it out of the rule below without the rule having to know about it.
  assert.deepEqual(altTexts(img("")), []);
  assert.deepEqual(altTexts(img("   ")), [], "whitespace-only trims to the same decision");
  assert.deepEqual(altTexts(img(null)), [], "no attribute is axe's `image-alt`, not this rule's finding");
  // `alt` is legal on `<area>` and `<input type=image>` and the page agents emit neither. The
  // alternative — scanning for the attribute NAME across the document — reads the characters
  // `alt=` out of prose and out of a query string, which is the trap links.ts's `unresolvedRefs`
  // is built around.
  assert.deepEqual(altTexts(`<area alt="image"><input type="image" alt="image">`), []);
  assert.deepEqual(altTexts(`<p>write alt="image" in the tag</p>`), []);
  // Both images, in order, and duplicates kept: two images described "image" are two images a
  // reader gets nothing from, and the correction has to name each.
  assert.deepEqual(altTexts(`${img("image")}${img("image")}`), ["image", "image"]);
});

test("a > inside an alt does not cut the tag in half", () => {
  // `<img[^>]*>` stops at the first `>`, which for this legal tag is inside the value — and the
  // alt is then invisible, so the naive form under-reports in the one direction that hides a
  // finding rather than inventing one.
  assert.deepEqual(altTexts(`<img src="a.png" alt="a > b, roughly">`), ["a > b, roughly"]);
  assert.deepEqual(altTexts(`<img src="a.png" alt="1 > 2">${img("image")}`), ["1 > 2", "image"]);
});

test("entities are decoded, because the reader is announced the decoded value", () => {
  assert.deepEqual(genericAlts(`<img src="a.png" alt="&#105;mage">`), ["image"]);
  assert.deepEqual(genericAlts(`<img src="a.png" alt="Home &amp; Away">`), []);
  assert.deepEqual(altTexts(`<img src="a.png" alt="Home &amp; Away">`), ["Home & Away"]);
});

// --- what it flags -------------------------------------------------------------------

test("every word on the list is flagged on its own, in any case, with trailing punctuation", () => {
  const words = [
    "image", "images", "photo", "photograph", "picture", "pic", "graphic", "graphics",
    "figure", "fig", "img", "icon", "logo", "chart", "graph", "diagram", "screenshot",
    "untitled", "placeholder", "alt", "alt text", "description", "thumbnail",
    // Added on measurement rather than suspicion: `alt="null"` is in the bench corpus, written
    // by nvidia.nemotron-nano-12b-v2, and Iris's own Reader complained about it in the same run
    // ("Image with alt='null' announces as [Image alt] null"). The other three are that
    // serialization leak's other spellings.
    "null", "undefined", "nan", "n/a",
  ];
  for (const w of words) {
    for (const spelling of [w, w.toUpperCase(), `${w.slice(0, 1).toUpperCase()}${w.slice(1)}`, `${w}.`, `${w} `, `${w}:`, `${w} -`]) {
      // Trimmed, because the value the rule reads is the value a reader is announced: `alt="image "`
      // and `alt="image"` are one defect written two ways, and reporting the whitespace would put
      // two spellings of one finding in a log meant to be counted.
      assert.deepEqual(genericAlts(img(spelling)), [spelling.trim()], `not flagged: ${JSON.stringify(spelling)}`);
    }
  }
});

test("the alts Iris actually writes are not flagged, including the one-word ones", () => {
  // The false-positive half, and the only half that carries information. These are the distinct
  // values from the bench corpus that sit closest to the rule: the three shortest alts Iris
  // writes are all logos and icons, where ONE WORD is the correct description — which is why
  // this is a closed word list and not a length threshold. A rule keyed on length flags every
  // row here.
  const real = [
    "M", "Home", "Meta", "Meta logo", "Home icon", "Meta home", "Meta logo.", "Home icon.",
    "globe icon", "Meta favicon", "Meta wordmark", "Building icon", "Dark circle", "Pink circle",
    "Teal circle", "Black circle", "Green circle", "∞ Meta",
    "Solid gray fill pattern", "Dotted fill pattern",
    "A warm sunset sky with orange and yellow light on the horizon",
    "A bar chart of quarterly revenue, rising from $1.2M to $4.8M",
    "Screenshot of the settings panel with two-factor authentication enabled",
    "Diagram of the request path from client to store",
  ];
  for (const alt of real) {
    assert.deepEqual(genericAlts(img(alt)), [], `flagged real alt text: ${JSON.stringify(alt)}`);
  }
  // Anchored at both ends is what makes that true of the commonest value in the corpus: 258 of
  // the 1,064 occurrences are `"Meta logo"`, and `logo` is on the list.
  assert.deepEqual(genericAlts(img("Meta logo")), []);
  assert.deepEqual(genericAlts(img("logo")), ["logo"]);
});

test("punctuation alone is not a finding, because the corpus has some and says nothing about it", () => {
  // `alt="..."` occurs in bench output. It is not a description either, but the remedy depends on
  // whether the image carries information, and this rule has no way to tell — so flagging it
  // would buy a page call on a judgement the rule does not have. Named here rather than left as
  // an accident of the regex.
  for (const alt of ["...", ".", "-", ":", " . "]) {
    assert.deepEqual(genericAlts(img(alt)), [], `flagged punctuation-only: ${JSON.stringify(alt)}`);
  }
});

test("the correction names the alt and both of the two legitimate answers", () => {
  const sentence = genericAltProblem("image");
  assert.match(sentence, /alt="image"/, "the model has to be told which image");
  assert.match(sentence, /what the image shows/);
  // The second remedy matters as much as the first: an image that carries nothing a reader needs
  // should end up `alt=""`, and a correction that only ever asked for prose would push the agent
  // into describing decoration.
  assert.match(sentence, /alt=""/);
  assert.match(sentence, /Change nothing else/);
});

// --- through the pipeline ------------------------------------------------------------

interface Event {
  type: string;
  [k: string]: unknown;
}

interface PageSpec {
  // The fragment the first pass returns for this page.
  first: string;
  // Problems the Feedback Agent names on its FIRST look. Empty is the page passing.
  verifyProblems?: string[];
  // What the correction returns, if one is bought. Defaults to the first fragment with the
  // placeholder replaced, i.e. the pass working.
  corrected?: string;
  // Problems the second look names — the binding re-check on a page that had passed, or the
  // sampled one on a page that had not.
  recheckProblems?: string[];
}

// A run of `specs.length` pages, serial, with the sampled recheck off unless asked for: the
// question here is what the alt rule buys, and a measurement slot landing on one of these pages
// would put a second `page_correction_recheck` in the log for an unrelated reason.
function makeCtx(dir: string, events: Event[], specs: PageSpec[], prompts: string[], size = 0): PipelineContext {
  const agentsDir = join(dir, "agents");
  const fragDir = join(dir, "fragments");
  const inputDir = join(dir, "input");
  for (const d of [agentsDir, fragDir, inputDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
  writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\nvision\n");
  const names = specs.map((_, i) => `page-${String(i + 1).padStart(3, "0")}.png`);
  for (const n of names) writeFileSync(join(inputDir, n), "not-a-real-png");
  // A correction prompt carries the previous fragment and the image bytes and never the file's
  // name, so the page is read back out of the heading the first pass wrote — the same reason
  // test/recheck-sample.test.ts does it.
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
  const dir = mkdtempSync(join(tmpdir(), "iris-generic-alt-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const of = (events: Event[], type: string): Event[] => events.filter((e) => e.type === type);

// A page long enough that a correction of it is not read as a page being deleted
// (`CORRECTION_SHRINK_FLOOR`), since the only difference between the two fragments here is one
// attribute value.
const body = (alt: string) =>
  `<h2>Page 1</h2><p>The quarterly report opens with a summary of revenue, headcount and ` +
  `regional performance, and the figure below is referred to twice in that summary.</p>${img(alt)}`;

test("a page that PASSES its check and has a placeholder alt buys a correction, and the rewrite is gated", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const prompts: string[] = [];
    // The case that did not exist before #290: nothing was wrong as far as the verifier was
    // concerned — which, after the downgrade #246 recommends, is exactly the verifier that would
    // miss this — and the free rule bought the fix.
    await runExtraction(makeCtx(dir, events, [{ first: body("image"), corrected: body("A bar chart of revenue by region") }], prompts));

    const [found] = of(events, "page_generic_alt");
    assert.deepEqual(found.alts, ["image"], "the log names the value, not just the count");
    assert.equal(found.page, 1);

    const [corrected] = of(events, "page_corrected");
    assert.equal(corrected.trigger, "alt", "one source, so the trigger names it rather than reading `both`");
    assert.equal(corrected.result, "kept");
    assert.equal(corrected.problems, 1);

    // The problem sentence reached the model, with the image. That is the whole reason this is a
    // correction and not an assertion at assembly: the fix is to describe the picture.
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /placeholder for alt text/);

    // And the rewrite had to earn the standing the original had, from code written for the link
    // case: this page had PASSED, so its correction is re-verified and the verdict is binding.
    const [recheck] = of(events, "page_correction_recheck");
    assert.equal(recheck.binding, true);
    assert.equal(recheck.ok, true);
    assert.equal(recheck.alt_before, 1, "the alt share of the bill, kept apart from the verdict's");
    assert.equal(recheck.links_before, 0);
    assert.equal(recheck.problems_before, 0, "the page had passed, so the verifier had named nothing");

    // The placeholder is gone from what shipped, and the run says so with a denominator.
    const [complete] = of(events, "extraction_complete");
    assert.equal(complete.alts_checked, 1);
    assert.equal(complete.alts_generic, 0);
    assert.equal(of(events, "page_generic_alt_unrecovered").length, 0);
  });
});

test("a correction that leaves the placeholder in is reported, not assumed to have worked", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The pair a decision about the verifier's model actually needs: the rule found something,
    // and the rule got nothing fixed. Both are free to establish, because the check that raised
    // the complaint can be run again on the answer — which is the one thing a model that finds
    // the same defect cannot do for nothing.
    await runExtraction(
      makeCtx(dir, events, [{ first: body("image"), corrected: `${body("photo")}<p>Figures are in millions.</p>` }], prompts()),
    );

    const [unrecovered] = of(events, "page_generic_alt_unrecovered");
    assert.deepEqual(unrecovered.alts, ["photo"], "the value that is still there, not the one that was");
    assert.equal(of(events, "page_corrected")[0].result, "kept", "the rewrite was still an improvement to keep");
    // And the delivered document is where it counts: `alts_generic` here is a placeholder Iris
    // SHIPPED, which is a different statement from the per-page finding above.
    const [complete] = of(events, "extraction_complete");
    assert.equal(complete.alts_checked, 1);
    assert.equal(complete.alts_generic, 1);
  });
});

test("a rejected alt correction says what it was bought for", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The binding re-check refusing the rewrite. The page that ships is the one that passed, so
    // the placeholder stays — which the log has to be able to say, or a run reads as having
    // repaired an alt it did not.
    await runExtraction(
      makeCtx(dir, events, [
        {
          first: body("image"),
          corrected: body("A bar chart of revenue by region").replace("headcount and ", ""),
          recheckProblems: ["the sentence about headcount is gone"],
        },
      ], prompts()),
    );

    const [rejected] = of(events, "page_links_correction_rejected");
    assert.equal(rejected.trigger, "alt", "the event predates this trigger; the field is what disambiguates it");
    assert.deepEqual(rejected.alts, ["image"]);
    assert.deepEqual(rejected.links, [], "and no link was involved, which the old shape could not say");
    assert.equal(of(events, "page_corrected")[0].result, "rejected");

    const [complete] = of(events, "extraction_complete");
    assert.equal(complete.alts_generic, 1, "the page that shipped is the one with the placeholder");
    assert.equal(of(events, "page_generic_alt_unrecovered").length, 0, "nothing was kept, so nothing was unrecovered");
  });
});

test("a page that fails its check AND has a placeholder alt is one correction, triggered by both", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const captured: string[] = [];
    // Both sources on one page: they cost the same call, and `both` has always meant more than
    // one of them — which is why adding a third source does not change what an old log's `both`
    // counted. What it no longer does is name which pair, and the per-source detail is exact on
    // `page_generic_alt` and `page_links_missing`, keyed by the same image.
    await runExtraction(
      makeCtx(dir, events, [
        {
          first: body("image"),
          verifyProblems: ["the table has no header row"],
          corrected: `${body("A bar chart of revenue by region")}<table><tr><th>Region</th></tr></table>`,
        },
      ], captured),
    );

    const [corrected] = of(events, "page_corrected");
    assert.equal(corrected.trigger, "both");
    assert.equal(corrected.problems, 2, "one verdict problem and one alt, in one page call");
    // Both sentences went in the one prompt.
    assert.match(captured[0], /no header row/);
    assert.match(captured[0], /placeholder for alt text/);
    // No binding re-check: this page had failed, so the original has no standing to protect and
    // the correction is accepted as it always was. The sample is off in this harness, so the
    // absence is the policy and not a threshold that happened to miss.
    assert.equal(of(events, "page_correction_recheck").length, 0);
  });
});

test("a run whose alts are all real reports the zero with its denominator", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The instrument this rule needs most, because its whole claim is that it fires on nothing:
    // a class reported only when it fires cannot distinguish "it never happened" from "the check
    // never ran". `alts_checked` is what makes the zero readable — 0 of 0 says nothing about the
    // rule and 0 of 3 says something.
    await runExtraction(
      makeCtx(dir, events, [
        { first: `<h2>Page 1</h2><p>Opening.</p>${img("Meta logo")}${img("M")}` },
        { first: `<h2>Page 2</h2><p>Body.</p>${img("A warm sunset sky over the harbour")}` },
        { first: `<h2>Page 3</h2><p>No images on this page at all.</p>` },
      ], prompts()),
    );

    assert.equal(of(events, "page_generic_alt").length, 0);
    assert.equal(of(events, "page_corrected").length, 0, "and no page call was bought");
    const [complete] = of(events, "extraction_complete");
    assert.equal(complete.alts_checked, 3);
    assert.equal(complete.alts_generic, 0);
  });
});

// A throwaway sink for the tests that do not read the correction prompts back.
function prompts(): string[] {
  return [];
}
