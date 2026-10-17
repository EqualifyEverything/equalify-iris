import { test } from "node:test";
import assert from "node:assert/strict";
import { enrichMathNavigation, translateSpeechToSpanish } from "../src/pipeline/mathNav.ts";
import { runAxe } from "../src/pipeline/lint.ts";
import { wrapDocument } from "../src/pipeline/assembly.ts";

test("enrichMathNavigation: leaves documents without MathML untouched", () => {
  const plainHtml = "<!DOCTYPE html><html lang=\"en\"><head><title>Test</title></head><body><p>Hello world</p></body></html>";
  const result = enrichMathNavigation(plainHtml);
  assert.equal(result, plainHtml);
});

test("enrichMathNavigation: wraps block MathML into interactive navigable drawer", () => {
  const inputHtml = `<!DOCTYPE html>
<html lang="en">
<head><title>Math Test</title></head>
<body>
<main>
  <h1>Quadratic Equation</h1>
  <math display="block" aria-label="x equals fraction with numerator negative b plus or minus square root of b squared minus 4 a c and denominator 2 a">
    <mrow>
      <mi>x</mi>
      <mo>=</mo>
      <mfrac>
        <mrow>
          <mo>-</mo>
          <mi>b</mi>
          <mo>±</mo>
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
</main>
</body>
</html>`;

  const output = enrichMathNavigation(inputHtml);

  // Assertions for wrapper structure
  assert.ok(output.includes('class="interactive-equation-wrapper"'), "Should have interactive-equation-wrapper");
  assert.ok(output.includes('class="equation-container"'), "Should have equation-container");
  assert.ok(output.includes('class="in-place-nav-drawer"'), "Should have in-place-nav-drawer");
  assert.ok(output.includes('role="application"'), "Navigation drawer must have role=application for screen reader key passthrough");
  assert.ok(output.includes('class="eq-actions-overlay"'), "Should have actions overlay");
  assert.ok(output.includes('data-speech-es='), "Should support Spanish translation metadata");

  // Assertions for eliminating double-reading: math element should not retain aria-label
  assert.ok(!output.includes('<math display="block" aria-label='), "Inner math element must not have aria-label to prevent double reading");

  // Assertions for styles and script injection
  assert.ok(output.includes('data-math-nav="true"'), "Should inject navigation styles and script");
  assert.ok(output.includes(".interactive-equation-wrapper"), "CSS should be present");
  assert.ok(output.includes("initInPlaceNavTree"), "Navigation script should be present");
});

test("enrichMathNavigation: wraps inline MathML into inline-math-wrapper", () => {
  const inputHtml = `<!DOCTYPE html>
<html lang="en">
<head><title>Inline Math</title></head>
<body>
<main>
  <p>The energy is <math><mrow><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></mrow></math>.</p>
</main>
</body>
</html>`;

  const output = enrichMathNavigation(inputHtml);
  assert.ok(output.includes('class="inline-math-wrapper"'), "Should have inline-math-wrapper");
  assert.ok(output.includes('role="math"'), "Inline wrapper should have role=math");
});

test("wrapDocument: automatically enriches math equations and passes axe-core", async () => {
  const body = `
    <h1>Calculus Benchmark</h1>
    <figure>
      <math display="block" aria-label="definite integral from a to b of x squared d x equals fraction with numerator b cubed minus a cubed and denominator 3">
        <mrow>
          <msubsup><mo>∫</mo><mi>a</mi><mi>b</mi></msubsup>
          <msup><mi>x</mi><mn>2</mn></msup>
          <mi>d</mi><mi>x</mi>
          <mo>=</mo>
          <mfrac>
            <mrow><msup><mi>b</mi><mn>3</mn></msup><mo>-</mo><msup><mi>a</mi><mn>3</mn></msup></mrow>
            <mn>3</mn>
          </mfrac>
        </mrow>
      </math>
      <figcaption>Equation 1: Definite Integral</figcaption>
    </figure>
  `;

  const fullDoc = wrapDocument(body);

  assert.ok(fullDoc.includes('class="interactive-equation-wrapper"'));
  assert.ok(fullDoc.includes('class="in-place-nav-drawer"'));

  const axeResult = await runAxe(fullDoc);
  assert.equal(axeResult.ok, true, "Enriched math document must pass axe-core accessibility checks");
  assert.equal(axeResult.violations?.length ?? 0, 0);
});

test("translateSpeechToSpanish: correctly translates English math terms", () => {
  const en = "x equals fraction with numerator minus b plus or minus square root of b squared minus 4 a c over denominator 2 a";
  const es = translateSpeechToSpanish(en);
  assert.ok(es.includes("igual a"));
  assert.ok(es.includes("fracción con numerador"));
  assert.ok(es.includes("sobre denominador"));
  assert.ok(es.includes("raíz cuadrada de"));
  assert.ok(es.includes("al cuadrado"));
});
