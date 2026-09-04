import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captionClaims } from "../src/pipeline/correction.ts";
import { runExtraction } from "../src/pipeline/extraction.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// The strings are the corpus's own, trimmed. `p092` is the plate #356 is about — a caption that
// quantifies a category in words over a description that enumerates two — and `p095` is the region
// claim #358's clause was written for. Both are transcriptions of a 1962 ACIR report, so the
// abbreviations, the title case and the legend inside the caption are all as delivered.
const P092_ALT =
  "Cartogram of the United States showing states with above-average tax effort. " +
  "Above-average under both indexes (medium grey): ME., MASS., R.I., CONN., N.Y., N.J., DEL., D.C., " +
  "PA., MD., IND., VA., N.C., S.C., OHIO, KY., TENN., MICH., WIS., ILL., MO., MINN., IOWA, ALA., " +
  "MISS., LA., GA., FLA., COLO. Below-average effort under tax capacity index, above on income " +
  "index (crosshatch): N.D., S.D., NEBR., KAN., OKLA., TEX., N. MEX., ARIZ., UTAH, NEV., IDAHO, " +
  "MONT., WYO., WASH., OREG., CALIF.";
const P092_CAPTION =
  "<p><strong>Figure 8. States With Above-Average Tax Effort</strong></p>" +
  "<p><em>About Half the States Which Appear To Be Making Above-Average Tax Effort When " +
  "Collections Are Related to Income Shift Below the National Average When Collections Are " +
  "Related to Taxable Capacity.</em></p>";
const P095_ALT =
  "Choropleth map of the contiguous United States showing effective property tax rates in 1960 by " +
  "state, using four shading levels. States shaded lightest (less than 1%): South Carolina, " +
  "Georgia, Alabama, Mississippi, Louisiana, Arkansas. States with light-medium shading (1 thru " +
  "1.4%): Maryland, Delaware, D.C., New Jersey, Connecticut. States with darkest shading (2.0 and " +
  "over): Ohio, Wisconsin, and Wyoming.";
const P095_CAPTION =
  "<p><strong>Figure 10. Effective Property Tax Rates, 1960</strong></p>" +
  "<p><em>The South, in General, Has the Lowest Effective Rates; the New England and Mideastern " +
  "States, the Highest.</em></p>" +
  "<dl><dt>Less than 1%</dt><dt>1 Thru 1.4</dt><dt>1.5 Thru 1.9</dt><dt>2.0 and Over</dt></dl>";

const figure = (alt: string, caption: string): string =>
  `<figure><img src="fig.png" alt="${alt}"><figcaption>${caption}</figcaption></figure>`;

test("a caption that quantifies a category in words is recorded, and no proportion is computed", () => {
  const claims = captionClaims(figure(P092_ALT, P092_CAPTION));
  assert.equal(claims.length, 1);
  const [claim] = claims;
  assert.equal(claim.figure, 1);
  assert.equal(claim.quantifier, "About Half");
  assert.equal(claim.share, 0.5);
  // Two lists, which is what the caption's denominator would have to be built out of. The number is
  // deliberately not turned into one: on the sixteen reads of this plate on disk the same parse
  // answers 1, 2 or 3 lists for one unchanged legend.
  assert.equal(claim.enumerations, 2);
  assert.deepEqual(claim.declined, ["proportion"]);
  assert.equal(claim.band, undefined);
  assert.equal(claim.named, undefined);
  // No field on this record is a share of anything, and that is the point of it rather than an
  // omission: a reader regrading the log has the words, the fraction they name and the shape of the
  // enumeration, and can apply whatever tolerance a later corpus justifies.
  assert.deepEqual(Object.keys(claim).sort(), [
    "caption",
    "declined",
    "enumerations",
    "figure",
    "quantifier",
    "share",
  ]);
});

test("a region claim whose group the description never sorts is the clause DECLINING, and says so", () => {
  const claims = captionClaims(figure(P095_ALT, P095_CAPTION));
  assert.equal(claims.length, 1);
  const [claim] = claims;
  assert.equal(claim.band, "lowest");
  // FOUR, over a description with three categories in it, and the fourth is the parse reading a
  // band label as a list of two: "States with darkest shading (2.0 and over)" has no comma in it, so
  // the conjunction is the only separator available and it separates. This is the same
  // over-reading the corpus shows on these plates, it is left visible here rather than fixtured
  // away, and it is the measured reason no share is computed from this number.
  assert.equal(claim.enumerations, 4);
  // The description sorts individual states; the caption's claim is about "The South" and "the New
  // England and Mideastern States". Nothing on the page says which states those are, so v1.12's
  // clause must refuse the comparison — and this is the line that says a silent round was a refusal
  // rather than a page with nothing wrong with it.
  assert.deepEqual(claim.declined, ["membership"]);
  assert.equal(claim.named, undefined);
  assert.equal(claim.quantifier, undefined);
});

test("...and the same claim is decidable where the description sorts the REGION, so nothing declines", () => {
  // The one shape in the corpus that reaches the check: an arm that described the map by region
  // rather than by state, so the membership the clause may not supply is on the page already.
  const alt =
    "Map of the United States by effective property tax rate. Lowest rates: New England, the " +
    "Mideast, the Plains. Highest rates: the Southeast, the Southwest.";
  const claims = captionClaims(figure(alt, "<p>New England Has the Lowest Effective Rates.</p>"));
  assert.deepEqual(claims, [
    {
      figure: 1,
      caption: "New England Has the Lowest Effective Rates.",
      band: "lowest",
      enumerations: 2,
      named: ["New England"],
    },
  ]);
  // A group name has to be the whole word in the caption too. "New Englanders" is a different word,
  // and reading it as the region would report a check as decidable on a page that never named the
  // group the description sorted.
  const inflected = captionClaims(figure(alt, "<p>New Englanders Have the Lowest Effective Rates.</p>"));
  assert.equal(inflected[0].named, undefined);
  assert.deepEqual(inflected[0].declined, ["membership"]);
});

test("a band word in the figure's own TITLE is not a claim about a group", () => {
  // `p071` and `p073` print exactly this above their region sentences: the title names the band the
  // whole plate is about, which contradicts nothing and has no group in it. Keyed on the band word
  // alone, both plates fired here — a decline counted where no check was ever available — so the
  // trigger is the band word as something a verb asserts.
  assert.deepEqual(captionClaims(figure(P095_ALT, "<p>Figure 3. States With Lowest Capacity</p>")), []);
  assert.deepEqual(captionClaims(figure(P095_ALT, "<p>Figure 5. States With Highest Capacity</p>")), []);
  // And the wording those two plates DO make their claim in, which is not a superlative at all.
  assert.equal(
    captionClaims(figure(P095_ALT, "<p>the Southeastern States Rank Lowest.</p>"))[0]?.band,
    "lowest",
  );
  assert.equal(
    captionClaims(figure(P095_ALT, "<p>Farming and Mineral States in the West Rank High.</p>"))[0]?.band,
    "high",
  );
});

test("a description that sorts nothing has no term for either check, and that is not a pass", () => {
  // The cheapest arm in every round measured describes this plate without enumerating a category at
  // all. A caption-versus-description check cannot fire on it, which is an arm escaping the check
  // rather than passing it, and the record says which of the two happened.
  const alt = "Cartogram of the United States showing states with above-average tax effort.";
  assert.deepEqual(captionClaims(figure(alt, P092_CAPTION)), [
    {
      figure: 1,
      caption:
        "Figure 8. States With Above-Average Tax Effort About Half the States Which Appear To Be " +
        "Making Above-Average Tax Effort When Collections Are Related to Income Shift Below the " +
        "National Average When Col",
      quantifier: "About Half",
      share: 0.5,
      enumerations: 0,
      declined: ["proportion", "no_enumeration"],
    },
  ]);
  // A band claim over the same description declines for that reason and not for membership: where
  // there are no bands, there is no band for a region's members to be missing from.
  assert.deepEqual(captionClaims(figure(alt, P095_CAPTION))[0].declined, ["no_enumeration"]);
});

test("the caption is clipped, and the clip is what a reader can check the claim against", () => {
  const claim = captionClaims(figure(P092_ALT, P092_CAPTION))[0];
  assert.equal(claim.caption.length, 200);
  assert.match(claim.caption, /^Figure 8\. States With Above-Average Tax Effort About Half the States/);
});

test("what does not name a fraction is not turned into one", () => {
  // Each of these quantifies a category and none of them names a value. A report that read "most"
  // as a number would be inventing the number it then compared, so the caption is not a subject at
  // all: no record, rather than a record with a guess in it.
  for (const words of [
    "Most of the States Which Shift Are in the South.",
    "A Majority of the States Shift Below the National Average.",
    "Many States Shift Below the National Average.",
    "Nearly All the States Shift Below the National Average.",
    "Few States Shift Below the National Average.",
    // A printed integer is v1.11's axis and a rule in both prompts already.
    "Eight of the Twelve States That Shift Are in the South.",
  ]) {
    assert.deepEqual(captionClaims(figure(P092_ALT, `<p>${words}</p>`)), [], words);
  }
  // And a word that merely contains one of the fraction words is not it.
  assert.deepEqual(captionClaims(figure(P092_ALT, "<p>Rates Are Reported Half-Yearly.</p>")), []);
});

test("every fraction word this reads, with the hedge kept as the page printed it", () => {
  const cases: [string, string, number][] = [
    ["About Half the States Shift.", "About Half", 1 / 2],
    ["Nearly one-half of the States Shift.", "Nearly one-half", 1 / 2],
    ["Approximately a Third of the States Shift.", "Approximately a Third", 1 / 3],
    ["Two-Thirds of the States Shift.", "Two-Thirds", 2 / 3],
    ["Roughly One Quarter of the States Shift.", "Roughly One Quarter", 1 / 4],
    ["Three Quarters of the States Shift.", "Three Quarters", 3 / 4],
    ["Some a fifth of the States Shift.", "Some a fifth", 1 / 5],
  ];
  for (const [words, quantifier, share] of cases) {
    const claim = captionClaims(figure(P092_ALT, `<p>${words}</p>`))[0];
    assert.equal(claim.quantifier, quantifier, words);
    assert.equal(claim.share, share, words);
  }
});

test("a band LABEL the caption prints is not a group the description sorted", () => {
  // `p095`'s legend is inside its figcaption, so its band labels are in the caption text — and the
  // same labels are what the description's lists are introduced by, which puts them in the parse as
  // members. Counting one as a named group would report a declining check as a decidable one on the
  // very plate the clause exists for. A place or a region is a proper noun; each label here is either
  // numeric or a lowercase preposition, and the same test drops both.
  const alt =
    "Choropleth map. 1 thru 1.4: Maryland, Delaware. 2.0 and over: Ohio, Wisconsin. " +
    "states with the deepest fill, over 2.0, are the industrial ones.";
  const claim = captionClaims(figure(alt, P095_CAPTION))[0];
  assert.deepEqual(claim.declined, ["membership"]);
  assert.equal(claim.named, undefined);
});

test("a state's abbreviation is not an ordinary word the caption happens to use", () => {
  // `p071`, verbatim from the round on disk: the description labels the map with postal
  // abbreviations, so "OR" is one of its members, and the caption's own sentence contains the word
  // "or". Matched without regard to case, that plate reports a named group and so a decidable check —
  // on the one plate whose claim is about "the Southeastern States", which nothing on the page sorts.
  // It is the only place in 1,302 pages where the case test changes an answer, and it changes it from
  // wrong to right.
  const alt =
    "Black-and-white map of the contiguous United States divided into states and labeled with state " +
    "abbreviations. State labels visible on the map include WA, OR, CA, NV, ID, UT, AZ, MT, WY, CO, " +
    "NM, ND, SD, NE, KS, OK, TX, MN, IA, MO, ARK., LA, WI, IL, IN, OHIO, MI, KY, TENN., MISS., " +
    "ALA., GA., FLA., S.C., N.C., VA., W. VA., MD., DEL., N.J., PA., N.Y., CONN., R.I., MASS., " +
    "N.H., VT., and ME.";
  const caption =
    "<p><strong>Figure 3. States With Lowest Capacity</strong></p>" +
    "<p><em>Whether Per Capita Income or Per Capita Yield of a Representative Tax System Is Used as " +
    "an Indicator, the Southeastern States Rank Lowest.</em></p>";
  const claim = captionClaims(figure(alt, caption))[0];
  assert.equal(claim.band, "lowest");
  assert.equal(claim.named, undefined);
  assert.deepEqual(claim.declined, ["membership"]);
});

test("a figure is skipped where either string is missing, and the index still counts it", () => {
  const bare = `<figure><img src="a.png" alt="${P095_ALT}"></figure>`;
  const captionless = `<figure><figcaption>${P095_CAPTION}</figcaption></figure>`;
  const altless = `<figure><img src="a.png"><figcaption>${P095_CAPTION}</figcaption></figure>`;
  const empty = `<figure><img src="a.png" alt=""><figcaption>${P095_CAPTION}</figcaption></figure>`;
  for (const html of [bare, captionless, altless, empty]) assert.deepEqual(captionClaims(html), []);
  // The number is the figure's place on the page, because that is what a reader opening the
  // delivered document counts to find it — not the place in a list of the ones that had a claim.
  // And ONE record off those two figures: a caption is compared with the description of the picture
  // it captions, so the first figure's caption does not reach the second figure's alt.
  const pair = captionClaims(altless + figure(P095_ALT, P095_CAPTION));
  assert.equal(pair.length, 1);
  assert.equal(pair[0].figure, 2);
});

test("a page whose last figure was cut off still has its caption compared", () => {
  // Model output mid-pipeline: the fragment ends inside the figure, which is the page most likely to
  // have lost something and the one a scan requiring `</figure>` would drop.
  const cut = `<figure><img src="a.png" alt="${P095_ALT}"><figcaption>${P095_CAPTION}`;
  assert.equal(captionClaims(cut)[0].band, "lowest");
});

// ——— the record is written where the verifier sees the page, whether or not it is corrected ———

interface Recorded {
  events: { type: string; data: Record<string, unknown> }[];
}

const ORDINARY = `<h2>Page 1</h2><p>${"content ".repeat(20)}</p>`;

function makeCtx(dir: string, render: string): { ctx: PipelineContext; rec: Recorded } {
  const agentsDir = join(dir, "agents");
  const fragDir = join(dir, "fragments");
  const inputDir = join(dir, "input");
  for (const d of [agentsDir, fragDir, inputDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
  writeFileSync(join(inputDir, "page-001.png"), "not-a-real-png");
  const rec: Recorded = { events: [] };
  const ctx = {
    sessionId: "ses_test",
    images: [{ name: "page-001.png", order: 1, path: join(inputDir, "page-001.png") }],
    extractionConcurrency: 1,
    recheckSampleSize: 1,
    maxReviewIterations: 1,
    paths: {
      agentsDir,
      tmpAgentsDir: () => join(dir, "tmp-agents"),
      agentMemory: (agent: string) => join(dir, `mem-${agent.replace(/\.md$/, "")}.json`),
      sessionFragments: () => fragDir,
    } as unknown as Paths,
    router: {
      complete: async () => ({ text: JSON.stringify({ html: render, log: "" }) }),
    },
    log: {
      event: (type: string, data: Record<string, unknown> = {}) => rec.events.push({ type, data }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
  return { ctx, rec };
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iris-caption-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the record names the page, and it is written on a page nothing corrects", async () => {
  await withTemp(async (dir) => {
    // No `feedback.md`, so every page is unjudged-ok and no correction pass runs anywhere in this
    // run. That is the condition the record has to survive: most pages carrying a caption claim are
    // never corrected, so a field on `page_corrected` would be silent on exactly them.
    const { ctx, rec } = makeCtx(dir, ORDINARY + figure(P092_ALT, P092_CAPTION));
    await runExtraction(ctx);
    const claims = rec.events.filter((e) => e.type === "page_caption_claim");
    assert.equal(claims.length, 1);
    assert.equal(claims[0].data.image, "page-001.png");
    assert.equal(claims[0].data.page, 1);
    assert.equal(claims[0].data.quantifier, "About Half");
    assert.deepEqual(claims[0].data.declined, ["proportion"]);
    assert.equal(rec.events.filter((e) => e.type === "page_corrected").length, 0);
  });
});

test("a page whose caption claims nothing leaves no line at all", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = makeCtx(dir, ORDINARY + figure(P092_ALT, "<p>Figure 8. Tax Effort by State</p>"));
    await runExtraction(ctx);
    assert.deepEqual(rec.events.filter((e) => e.type === "page_caption_claim"), []);
  });
});
