// The one sentence on the demo page that makes a claim about how good Iris is.
//
// `GET /v1/stats` decides whether there is anything to say (see test/quality.test.ts
// for the floor); this file covers what the page does with the answer, which is where
// the claim gets its wording and its rounding. Both are easy to get wrong in the
// service's favour and impossible to notice afterwards: `Math.round` publishes 99.6%
// as "100% of documents", and a NaN from an older or broken deployment publishes
// "NaN%" on the front page of an accessibility tool.
//
// The function is lifted out of the inline script rather than duplicated here, the
// same way test/demo-a11y.test.ts reads that script instead of hardcoding ids: a copy
// would keep passing after the page changed, which is the one thing this must not do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const demoHtml = readFileSync(join(repoRoot, "public", "demo.html"), "utf8");

// Take `function qualityClause(...) { ... }` from the page by matching its braces.
// It touches no DOM and no globals, which is what makes evaluating it in isolation
// honest rather than a re-implementation.
function extract(name: string): string {
  const start = demoHtml.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is no longer in public/demo.html`);
  let depth = 0;
  for (let i = demoHtml.indexOf("{", start); i < demoHtml.length; i++) {
    if (demoHtml[i] === "{") depth++;
    else if (demoHtml[i] === "}" && --depth === 0) return demoHtml.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces reading ${name} from public/demo.html`);
}

const qualityClause = new Function(`${extract("qualityClause")}; return qualityClause;`)() as (
  q: unknown,
) => string;

const OK = { window_days: 30, documents: 212, clean_rate: 0.93, mean_rounds: 1.8 };

test("the clause reads as a sentence continuation of the tally", () => {
  const out = qualityClause(OK);
  assert.equal(
    out,
    " — over the last 30 days, <strong>93% of documents finished with the reviewer finding" +
      " nothing left to fix</strong>, averaging 1.8 editor passes",
  );
  // The caller appends the full stop, so a clause that brought its own would end the
  // sentence twice.
  assert.ok(!out.endsWith("."), "the clause must not punctuate the sentence itself");
  // And the wording is only as strong as the measurement. `clean_rate` counts documents
  // the reviewer left nothing open on, which is NOT the same as the final axe pass
  // coming back empty: the orchestrator records both from one call, and a violation the
  // reviewer never raised still leaves the document counted as clean. "Came out clean",
  // or anything mentioning errors or violations, would claim more than the number can
  // support — which is exactly the claim a visitor would take away from the shorter
  // sentence, so the reviewer stays named in it.
  assert.doesNotMatch(out, /\bclean\b|violation|\berrors?\b|flawless|perfect/i);
});

test("a rate is floored, never rounded", () => {
  // THE assertion this file exists for. 99.6% clean is excellent and a claim of
  // perfection about work Iris did not do perfectly is not — on a page whose whole
  // subject is not overstating accessibility.
  assert.match(qualityClause({ ...OK, clean_rate: 0.996 }), /99% of documents/);
  assert.match(qualityClause({ ...OK, clean_rate: 0.9999 }), /99% of documents/);
  // And a genuine 1 still reads as 100, so flooring does not cost the real case.
  assert.match(qualityClause({ ...OK, clean_rate: 1 }), /100% of documents/);
});

test("the floor is of the rate, not of a binary rounding artefact", () => {
  // `0.58 * 100` is 57.99999999999999, so a bare Math.floor publishes 57% for a
  // deployment that was exactly 58% clean. Every value here is a ratio of two
  // plausible document counts — 29/50, 43/100, 71/100 — which is precisely what this
  // field carries, so the bug is not an edge case but the ordinary case on the round
  // denominators a real window lands on.
  for (const [clean_rate, pct] of [
    [0.58, 58],
    [0.57, 57],
    [0.29, 29],
    [0.55, 55],
    [0.87, 87],
  ] as const) {
    assert.match(qualityClause({ ...OK, clean_rate }), new RegExp(`>${pct}% of documents`), `${clean_rate}`);
  }
  // And the correction stays well under one percentage point of the truth, so it
  // cannot promote a genuine 99.99% to 100%.
  assert.match(qualityClause({ ...OK, clean_rate: 0.9999 }), />99% of documents/);
});

test("no editor passes is said in words rather than as 0.0", () => {
  // 0 is the BEST value — the review loop returns as soon as the reviewer finds nothing
  // — and "averaging 0.0 editor passes" reads like a number that failed to load.
  assert.match(qualityClause({ ...OK, mean_rounds: 0 }), /needing no editor passes at all$/);
  // Just above zero it is a number again, to one decimal.
  assert.match(qualityClause({ ...OK, mean_rounds: 0.06 }), /averaging 0\.1 editor passes$/);
});

test("a mean above zero never claims that no document needed a pass", () => {
  // The mean is over documents, so any value in (0, 0.05) is a window in which a
  // document DID need an editor pass: 0.04 is 25 documents of which one took a single
  // pass. "Needing no editor passes at all" is then false, in the flattering direction
  // this function refuses everywhere else — and on the front page of an accessibility
  // tool, where the whole point of the sentence is that it can be believed.
  for (const mean_rounds of [0.04, 0.01, 0.0001]) {
    const out = qualityClause({ ...OK, mean_rounds });
    assert.doesNotMatch(out, /no editor passes/, `mean_rounds=${mean_rounds}`);
    // Hedged words rather than "averaging 0.0 editor passes", which reads like a
    // number that failed to load — the reason the exact-zero case gets words too.
    assert.match(out, /averaging under 0\.1 editor passes$/, `mean_rounds=${mean_rounds}`);
  }
  // Only an exact 0 earns the claim, and it is reachable: every document in the window
  // read clean on the first look.
  assert.match(qualityClause({ ...OK, mean_rounds: 0 }), /needing no editor passes at all$/);
});

test("nothing to say is said as nothing", () => {
  // Every one of these is a real response shape: `null` is the server declining below
  // its document floor, and the rest are an older deployment, a proxy that mangled the
  // body, or a field that changed type. The page's rule throughout is that one fewer
  // sentence beats a broken one — an empty boast is worse than no boast.
  for (const q of [null, undefined, "quality", 42, [], {}]) {
    assert.equal(qualityClause(q), "", `expected silence for ${JSON.stringify(q) ?? "undefined"}`);
  }
  for (const clean_rate of [NaN, Infinity, -0.1, 1.5, null, "0.93"]) {
    assert.equal(qualityClause({ ...OK, clean_rate }), "", `clean_rate=${String(clean_rate)}`);
  }
  for (const window_days of [NaN, 0, -30, null, "30"]) {
    assert.equal(qualityClause({ ...OK, window_days }), "", `window_days=${String(window_days)}`);
  }
});

test("an unusable rounds figure drops its clause without taking the rate with it", () => {
  // The two halves fail independently on purpose: the clean rate is the part a visitor
  // is deciding on, so a garbled `mean_rounds` must not delete it.
  for (const mean_rounds of [NaN, -1, null, "1.8", undefined]) {
    const out = qualityClause({ ...OK, mean_rounds });
    assert.equal(
      out,
      " — over the last 30 days, <strong>93% of documents finished with the reviewer finding" +
        " nothing left to fix</strong>",
      `mean_rounds=${String(mean_rounds)}`,
    );
  }
});

test("no interpolated value can carry markup", () => {
  // The clause is written into `innerHTML`, so this matters even though every field
  // comes from our own endpoint: the numbers are all formatted from `Number(...)`
  // here, which is what makes that safe rather than trusted.
  const hostile = {
    window_days: '30<img src=x onerror="alert(1)">',
    documents: "<script>",
    clean_rate: '0.93"><script>alert(1)</script>',
    mean_rounds: "<b>1.8</b>",
  };
  // Both string rates are non-numeric, so the honest outcome is silence rather than
  // an escaped rendering of an attack.
  assert.equal(qualityClause(hostile), "");
  // And a numeric rate alongside a hostile-but-numeric-looking window still emits no
  // tag beyond the <strong> this function writes itself.
  const out = qualityClause({ ...OK, documents: "<script>alert(1)</script>" });
  assert.ok(!out.includes("<script"), out);
  assert.deepEqual(out.match(/<[^>]+>/g), ["<strong>", "</strong>"]);
});
