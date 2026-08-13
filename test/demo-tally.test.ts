// The one sentence on the demo page that makes a claim about how good Iris is.
//
// `GET /v1/stats` decides whether there is anything to say (see test/quality.test.ts
// for the floor); this file covers what the page does with the answer, which is where
// the claim gets its wording and its rounding. Both are easy to get wrong in the
// service's favour and impossible to notice afterwards: `Math.round` publishes 99.6%
// as "100% finished with nothing left unresolved", and a NaN from an older or broken
// deployment publishes "NaN%" on the front page of an accessibility tool.
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
    " — over the last 30 days, <strong>93% finished with nothing left unresolved</strong>," +
      " averaging 1.8 editor passes",
  );
  // The caller appends the full stop, so a clause that brought its own would end the
  // sentence twice.
  assert.ok(!out.endsWith("."), "the clause must not punctuate the sentence itself");
});

test("a rate is floored, never rounded", () => {
  // THE assertion this file exists for. 99.6% clean is excellent and "100% finished
  // with nothing left unresolved" is a claim of perfection about work Iris did not
  // do perfectly — on a page whose whole subject is not overstating accessibility.
  assert.match(qualityClause({ ...OK, clean_rate: 0.996 }), /99% finished/);
  assert.match(qualityClause({ ...OK, clean_rate: 0.9999 }), /99% finished/);
  // And a genuine 1 still reads as 100, so flooring does not cost the real case.
  assert.match(qualityClause({ ...OK, clean_rate: 1 }), /100% finished/);
});

test("no editor passes is said in words rather than as 0.0", () => {
  // 0 is the BEST value — the review loop returns as soon as the Reader finds nothing
  // — and "averaging 0.0 editor passes" reads like a number that failed to load.
  assert.match(qualityClause({ ...OK, mean_rounds: 0 }), /needing no editor passes at all$/);
  assert.match(qualityClause({ ...OK, mean_rounds: 0.04 }), /needing no editor passes at all$/);
  // Just above the threshold it is a number again, to one decimal.
  assert.match(qualityClause({ ...OK, mean_rounds: 0.06 }), /averaging 0\.1 editor passes$/);
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
    assert.equal(out, " — over the last 30 days, <strong>93% finished with nothing left unresolved</strong>");
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
