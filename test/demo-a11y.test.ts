// The demo page is the product's own front door, so it gets held to the standard
// Iris holds its output to. Two things are asserted here.
//
// 1. Anything that opens a new browser tab says so in its own label (issue #8).
//    A user who is moved to a new tab without warning has to work out where they
//    are and how to get back; a screen-reader user gets no window-change
//    announcement at all, and a magnifier user sees the viewport change with no
//    explanation (WCAG 3.2.5, technique G201 — warn before the change). Putting the
//    warning in the label rather than in nearby prose is what makes it reach both:
//    the label is what is announced on focus, and it is what the eye is on when the
//    control is about to be pressed.
//
// 2. axe-core reports no violations on the page. The pipeline lints every document
//    Iris produces (src/pipeline/lint.ts) but nothing was linting the page that
//    ships the pipeline, so "the demo still passes axe" was a manual step in a PR
//    checklist. Same linter, same rule set, so it stays honest by construction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";
import { runAxe } from "../src/pipeline/lint.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const demoHtml = readFileSync(join(repoRoot, "public", "demo.html"), "utf8");
// Scripts never run: this is a static read of the markup the browser is served.
const doc = new JSDOM(demoHtml).window.document;

// Accepts "tab" or "window" — which one a browser actually opens is a user setting,
// so either wording is truthful and neither should fail this test.
const WARNS = /\bopens in a new (tab|window)\b/i;

// What a screen reader announces for a link or button here: `aria-label` wins over
// the text when present. Neither control this file checks uses one today, but a
// future one might, and it would be a false failure to only read the text.
function spokenLabel(el: Element): string {
  return el.getAttribute("aria-label") ?? el.textContent ?? "";
}

test("every link that opens a new tab says so in its label", () => {
  const links = [...doc.querySelectorAll('a[target="_blank"]')];
  assert.ok(links.length > 0, "expected at least the GitHub device-flow link to target _blank");
  for (const a of links) {
    assert.match(spokenLabel(a), WARNS, `link "${a.textContent?.trim()}" opens a new tab without saying so`);
  }
});

// The buttons are found by reading the inline script rather than by hard-coding
// #view-btn, so a second button wired to window.open is covered the day it is
// added instead of the day someone remembers this file.
test("every button wired to window.open says so in its label", () => {
  const script = doc.querySelector("script:not([src])")?.textContent ?? "";
  // Matches the one wiring shape the demo uses, e.g.
  //   $('view-btn').onclick = () => window.open(currentBlobUrl, '_blank');
  // The id captured is the first `$('…')` on the line, which is the element being
  // wired; `[^\n]*` keeps the match on that one line.
  const wired = [...script.matchAll(/\$\('([\w-]+)'\)[^\n]*\bwindow\.open\(/g)].map((m) => m[1]);
  const calls = script.match(/\bwindow\.open\(/g) ?? [];
  // A window.open this test could not attribute to a control is the failure mode
  // that would otherwise pass silently, so count the calls and fail on the
  // difference rather than checking only what was matched.
  assert.equal(
    wired.length,
    calls.length,
    `found ${calls.length} window.open call(s) in public/demo.html but could only attribute ` +
      `${wired.length} to a control. Widen the pattern in this test so the new one is checked too.`,
  );
  assert.ok(wired.length > 0, "expected 'View converted document' to open the result in a new tab");
  for (const id of wired) {
    const el = doc.getElementById(id);
    assert.ok(el, `public/demo.html wires window.open to #${id}, which no element has`);
    assert.match(spokenLabel(el), WARNS, `#${id} opens a new tab without saying so`);
  }
});

test("the demo page has no axe-core violations", async () => {
  const lint = await runAxe(demoHtml);
  // `error` is set when axe could not run at all, in which case `ok` is true for
  // reasons that have nothing to do with the page (lint.ts degrades rather than
  // failing a session). Surface that instead of reporting a pass we did not earn.
  assert.equal(lint.error, undefined, `axe-core did not run: ${lint.error}`);
  assert.deepEqual(lint.violations, [], "public/demo.html has axe-core violations");
});
