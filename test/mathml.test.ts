import { test } from "node:test";
import assert from "node:assert/strict";
import { markupReport } from "../src/pipeline/markup.ts";
import { runAxe } from "../src/pipeline/lint.ts";

test("markupReport identifies balanced MathML elements", () => {
  const html = `
    <main>
      <h1>Math Section</h1>
      <p>Einstein's equation is <math><mrow><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></mrow></math>.</p>
      <figure>
        <math display="block" aria-label="x equals fraction with numerator negative b plus or minus square root of b squared minus 4 a c, and denominator 2 a">
          <mrow>
            <mi>x</mi>
            <mo>=</mo>
            <mfrac>
              <mrow>
                <mo>-</mo>
                <mi>b</mi>
                <mo>&plusmn;</mo>
                <msqrt>
                  <mrow>
                    <msup><mi>b</mi><mn>2</mn></msup>
                    <mo>-</mo>
                    <mn>4</mn>
                    <mi>a</mi>
                    <mi>c</mi>
                  </mrow>
                </msqrt>
              </mrow>
              <mrow>
                <mn>2</mn>
                <mi>a</mi>
              </mrow>
            </mfrac>
          </mrow>
        </math>
        <figcaption>Equation 1: Quadratic formula</figcaption>
      </figure>
    </main>
  `;

  const report = markupReport(html);
  assert.equal(report.unbalanced.length, 0, "MathML document should have no unbalanced tags");
});

test("markupReport flags unclosed MathML elements", () => {
  const html = `
    <main>
      <p>Broken formula: <math><mi>x</mi><mo>+</mo><mi>y</mi></p>
    </main>
  `;

  const report = markupReport(html);
  const mathUnbalanced = report.unbalanced.find((u) => u.element === "math");
  assert.ok(mathUnbalanced, "Unclosed <math> tag should be detected");
  assert.equal(mathUnbalanced.open, 1);
  assert.equal(mathUnbalanced.close, 0);
});

test("runAxe validates accessibility of MathML documents", async () => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head><title>Accessible Math</title></head>
<body>
<main>
  <h1>Physics Constants</h1>
  <p>The energy-mass equivalence is expressed as:</p>
  <math display="block" aria-label="E equals m c squared">
    <mrow>
      <mi>E</mi>
      <mo>=</mo>
      <mi>m</mi>
      <msup><mi>c</mi><mn>2</mn></msup>
    </mrow>
  </math>
</main>
</body>
</html>`;

  const result = await runAxe(html);
  assert.equal(result.ok, true, "MathML document should pass axe-core accessibility checks");
  assert.equal(result.violations?.length ?? 0, 0);
});
