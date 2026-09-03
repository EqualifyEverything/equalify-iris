// What the verify-then-correct loop bought, and whether the log now says.
//
// Across three real 25-page runs the Feedback Agent rejected 58 of 75 pages, so the
// "correct if needed" pass is in practice always taken — and nothing recorded what it
// changed, whether it converged, or whether a call that ran produced anything at all
// (issue #137). The events under test are the measurement that question needs; they
// change no verdict and no delivered document, which is itself asserted below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedAnything, correctionEffect, destroyedPage } from "../src/pipeline/correction.ts";
import { runExtraction } from "../src/pipeline/extraction.ts";
import { summarizeRun } from "../src/diagnostics.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";
import type { PdfLink } from "../src/util/pdf.ts";
import { TruncatedResponseError } from "../src/providers/types.ts";

// 93,039 characters of a correction came back before the ceiling cut it. The error carries the
// fragment as well as its length (#277), and since #293 this path quotes both of its ends on the
// failure line — nothing in the pipeline reads them, a correction that truncated being a correction
// not applied either way, but they are what says whether the cap was too tight or the model was
// running away, and the round cannot be asked again.
const TRUNCATED_REPLY = "<p>cut".padEnd(93_039, "x");

// --- what a correction changed, read off the two fragments --------------------

test("an alt-text refinement is not a change to the page", () => {
  // The distinction the whole module exists for. This is the correction the issue
  // quotes — "orange kayak" becoming "orange-yellow kayak, facing away" — and it costs
  // a full page call while changing no text and no structure. A run whose corrections
  // all look like this is paying per page for image descriptions.
  const before = `<p>Our progress</p><img src="a.png" alt="a person in a red life jacket in an orange kayak">`;
  const after = `<p>Our progress</p><img src="a.png" alt="a person in a red life jacket in an orange-yellow kayak, back to the camera">`;
  const e = correctionEffect(before, after);
  assert.equal(e.alt_changed, true);
  assert.equal(e.text_changed, false);
  assert.equal(e.structure_changed, false);
  assert.equal(e.chars_before, before.length);
  assert.equal(e.chars_after, after.length);
});

test("content coming back is a change to both the text and the structure", () => {
  const before = `<table><tr><th>Year</th></tr><tr><td>2026</td></tr></table>`;
  const after = `<table><tr><th>Year</th><th>Total</th></tr><tr><td>2026</td><td>41</td></tr></table>`;
  const e = correctionEffect(before, after);
  assert.equal(e.text_changed, true);
  assert.equal(e.structure_changed, true);
  assert.equal(e.alt_changed, false);
});

test("markup added to a complete page leaves the reader's share of it the same size", () => {
  // The distinction issue #166 asks for: a 71% fidelity-failure rate reads very differently
  // depending on whether the corrections that followed brought content back or added markup
  // to pages that already had it all. `chars_*` cannot say — both grow the fragment — so the
  // prose is measured on its own, and here it does not move by a character.
  const before = `<table><tr><th>Year</th><th>Total</th></tr><tr><td>2026</td><td>41</td></tr></table>`;
  const after = `<table><tr><th scope="col">Year</th><th scope="col">Total</th></tr><tr><td>2026</td><td>41</td></tr></table>`;
  const e = correctionEffect(before, after);
  assert.equal(e.attrs_changed, true);
  assert.equal(e.text_changed, false);
  assert.equal(e.text_chars_before, e.text_chars_after);
  // And the fragment did grow, which is the pair of numbers that would have been read as
  // content arriving.
  assert.ok(e.chars_after > e.chars_before);
});

test("content coming back raises the reader's share and content lost lowers it", () => {
  const short = `<p>Fees apply. See schedule B for the amounts.</p>`;
  const long = `<p>Fees apply. See schedule B for the amounts, and the appeal window is thirty days.</p>`;
  const restored = correctionEffect(short, long);
  assert.equal(restored.text_changed, true);
  assert.ok(restored.text_chars_after > restored.text_chars_before);
  // The same measure, the other way round: a correction that drops a sentence. It is kept —
  // the shrink floor is a quarter, not a sentence — and this is what makes it visible.
  const dropped = correctionEffect(long, short);
  assert.ok(dropped.text_chars_after < dropped.text_chars_before);
  assert.equal(destroyedPage(long, short), false);
});

test("a heading level correction is structural with the same words", () => {
  // The correction that matters most and shows up least: `<h2>` to `<h3>` moves no text
  // at all, so a measure built on text alone would call this pass a no-op.
  const e = correctionEffect(`<h2>Methodology</h2><p>x</p>`, `<h3>Methodology</h3><p>x</p>`);
  assert.equal(e.structure_changed, true);
  assert.equal(e.text_changed, false);
  assert.equal(e.alt_changed, false);
});

test("reformatting, re-indenting and re-spelling an entity are not changes", () => {
  // A model re-emits its own output with different whitespace all the time. Counting
  // that as a correction would report every pass as productive, which is the number
  // this measurement exists to be trusted on.
  const before = `<ul><li>Costs &amp; savings</li><li>Notes</li></ul>`;
  const after = `<ul>\n  <li>Costs & savings</li>\n  <li>Notes</li>\n</ul>\n`;
  const e = correctionEffect(before, after);
  assert.equal(e.text_changed, false);
  assert.equal(e.structure_changed, false);
  assert.equal(e.alt_changed, false);
  // The sizes still differ, and are reported, because "the same page, re-typed" is
  // worth being able to see.
  assert.notEqual(e.chars_before, e.chars_after);
});

test("moving a word from one image's description to the next is a change", () => {
  // Two alts that concatenate to the same string. Joined on a separator an attribute
  // value cannot hold, so the boundary between them counts.
  const before = `<img alt="a bar chart of revenue"><img alt="by quarter">`;
  const after = `<img alt="a bar chart"><img alt="of revenue by quarter">`;
  assert.equal(correctionEffect(before, after).alt_changed, true);
});

test("an unescaped > inside a description does not make an alt rewrite a text change", () => {
  // Model output does not always escape `>` in an attribute. A tag-strip that stops at the
  // first one leaves ` 2019">` behind as "visible text", and then this correction reports
  // text_changed and leaves `alt_only` — the bucket the module exists to isolate.
  const before = `<p>Revenue</p><img src="c.png" alt="a bar chart, 2020 > 2019">`;
  const after = `<p>Revenue</p><img src="c.png" alt="a bar chart, 2020 taller than 2019">`;
  const e = correctionEffect(before, after);
  assert.equal(e.alt_changed, true);
  assert.equal(e.text_changed, false);
  assert.equal(e.structure_changed, false);
});

test("an attribute that merely ends in alt is not an alt", () => {
  // `\b` opens on the `alt` of `data-alt`, so a rewrite of a data attribute would be
  // reported as a change to a description no reader ever hears. It is an attribute change,
  // which is a different signal.
  const e = correctionEffect(`<img src="a.png" alt="a kayak" data-alt="one">`, `<img src="a.png" alt="a kayak" data-alt="two">`);
  assert.equal(e.alt_changed, false);
  assert.equal(e.attrs_changed, true);
  assert.equal(e.text_changed, false);
});

// --- a member that crossed between two lists (#355) ---------------------------

// The p095 shape, at its own scale. A shaded map of state property tax rates, the verify pass made
// exactly ONE edit to the description's bands, and the edit moved Missouri out of the darkest list
// and into the cross-hatched one. Measuring the plate put Missouri on the flat side of the legend's
// own dispersion gap by 1.9×, so the $0.045 pass turned a classification the image permits into the
// one it excludes — and nothing in the log said a state had crossed, because nothing compared the
// two replies.
const BANDS_BEFORE =
  `<figure><img src="p095-map.png" alt="A map of the United States shaded in four bands. ` +
  `Darkest, 2.0 percent and over: Ohio, Wisconsin, Wyoming, Missouri; ` +
  `cross-hatched, 1.5 thru 1.9 percent: Michigan, Iowa, Kansas, N.D., Illinois, Minnesota">` +
  `<figcaption>Effective Property Tax Rates Vary.</figcaption></figure>`;
const BANDS_AFTER = BANDS_BEFORE
  .replace("Ohio, Wisconsin, Wyoming, Missouri", "Ohio, Wisconsin, Wyoming")
  .replace("Michigan, Iowa", "Michigan, Missouri, Iowa");

test("a member the correction moved into another list is named", () => {
  const e = correctionEffect(BANDS_BEFORE, BANDS_AFTER);
  assert.deepEqual(e.alt_relocated, ["Missouri"]);
  // It is an alt change and nothing else: no word of the page moved, so a log line built on the
  // four booleans alone reports this page as an alt refinement — the same bucket as "orange kayak"
  // becoming "orange-yellow kayak".
  assert.equal(e.alt_changed, true);
  assert.equal(e.text_changed, false);
  assert.equal(e.structure_changed, false);
  // And the two sizes are three characters apart, which is the other thing that would have had to
  // stand in for a reclassification.
  assert.equal(e.chars_before - e.chars_after, 0);
});

test("the member is named from the description that carried it, whatever the correction typed", () => {
  // Read on the normalised key and reported as it was written: a correction that lowercases a name
  // has still moved it, and the name a reader of the log needs is the one they can search the
  // fragment for.
  const e = correctionEffect(BANDS_BEFORE, BANDS_AFTER.replace("Michigan, Missouri", "Michigan, missouri"));
  assert.deepEqual(e.alt_relocated, ["Missouri"]);
});

test("a list reordered, or reworded around, is not a member changing lists", () => {
  // Every correction re-emits the whole description, so a pass asked to fix one thing rewrites
  // everything else in place. None of these may report a relocation.
  const reordered = BANDS_BEFORE.replace(
    "Ohio, Wisconsin, Wyoming, Missouri",
    "Wisconsin, Missouri, Ohio, Wyoming",
  );
  assert.equal(correctionEffect(BANDS_BEFORE, reordered).alt_relocated, undefined);
  // The list intact and the prose around it rewritten.
  const reworded = BANDS_BEFORE.replace("A map of the United States shaded in four bands.", "A U.S. map, four bands.");
  assert.equal(correctionEffect(BANDS_BEFORE, reworded).alt_relocated, undefined);
  // A member added to one list and a member dropped from another. Both change what the page says
  // and neither is a member asserted into a category the same reply had denied it — there is no pair
  // of lists to compare — and the sizes on the effect are what report them.
  const added = BANDS_BEFORE.replace("Michigan, Iowa", "Michigan, Indiana, Iowa");
  assert.equal(correctionEffect(BANDS_BEFORE, added).alt_relocated, undefined);
  const dropped = BANDS_BEFORE.replace("Ohio, Wisconsin, Wyoming, Missouri", "Ohio, Wisconsin, Wyoming");
  assert.equal(correctionEffect(BANDS_BEFORE, dropped).alt_relocated, undefined);
});

test("a two-part description whose halves are reworded is not a relocation", () => {
  // The false positive this is bounded to avoid: an alt of two comma-separated phrases has the same
  // shape as a list of two, so any rewording of one phrase leaves the other sitting with entirely
  // new company. Corrections do this constantly. What refuses it is the destination clause and not a
  // size floor — the "list" the surviving half joins holds one name, and one name cannot have been
  // listed with two others beforehand. That is measured rather than assumed: a draft that also
  // demanded three names at each end was mutated back to one, and this test stayed green either way.
  const e = correctionEffect(
    `<img src="a.png" alt="a bar chart, revenue by quarter"><img src="b.png" alt="a map, three shades">`,
    `<img src="a.png" alt="a bar chart, quarterly revenue"><img src="b.png" alt="a map, four bands">`,
  );
  assert.equal(e.alt_changed, true);
  assert.equal(e.alt_relocated, undefined);
});

test("a member whose new neighbours are all new text moved nowhere", () => {
  // The third condition, on its own. Missouri leaves a real list of four, and what it is listed with
  // afterwards is a clause that did not exist in the description being corrected — so the evidence
  // is that this sentence was rewritten, not that a category was reassigned. One shared name would
  // be a coincidence between any two sentences about the same map; two is a list.
  const rewritten = BANDS_BEFORE
    .replace("Ohio, Wisconsin, Wyoming, Missouri", "Ohio, Wisconsin, Wyoming")
    .replace(
      "cross-hatched, 1.5 thru 1.9 percent: Michigan, Iowa, Kansas, N.D., Illinois, Minnesota",
      "hard to place at this scale: Missouri, two Gulf states, several plains states",
    );
  assert.equal(correctionEffect(BANDS_BEFORE, rewritten).alt_relocated, undefined);
});

test("a member leaving a two-name band for one that already existed is still a move", () => {
  // The shape a floor of three at the SOURCE end declined in silence. Two states share the darkest
  // band and one of them crosses into the cross-hatched list, and nothing about that evidence is
  // weaker than p095's: the band it joined is the band it was not in, named by the same six members
  // in both replies. The floor that remains is two names, so that a member has a sibling it can be
  // listed with at all, and the destination clause is what makes the reading safe.
  const before = BANDS_BEFORE.replace("Ohio, Wisconsin, Wyoming, Missouri", "Wyoming, Missouri");
  const after = before
    .replace("Wyoming, Missouri", "Wyoming")
    .replace("Michigan, Iowa", "Michigan, Missouri, Iowa");
  assert.deepEqual(correctionEffect(before, after).alt_relocated, ["Missouri"]);
});

test("a name that contains \"and\" is one member, and can move like one", () => {
  // Raised by the review of this change. A conjunction joins a list at its end, so it is only opened
  // on there: split anywhere earlier, "Trinidad and Tobago" is two phantom members that travel
  // together, they share company in both replies, and the disjointness test can then never hold —
  // the member becomes unreportable however far it moves.
  const before = `<img alt="Darkest: Trinidad and Tobago, Guyana, Suriname; lightest: Belize, Panama, Costa Rica">`;
  const after = `<img alt="Darkest: Guyana, Suriname; lightest: Belize, Trinidad and Tobago, Panama, Costa Rica">`;
  assert.deepEqual(correctionEffect(before, after).alt_relocated, ["Trinidad and Tobago"]);
  // And a list that ends in a conjunction is still a list of its names, which is what the split is
  // there for: Wyoming crosses out of a three whose last two are joined by "and".
  const joined = `<img alt="Darkest: Ohio, Wisconsin and Wyoming; cross-hatched: Iowa, Kansas and Minnesota">`;
  const movedOut = `<img alt="Darkest: Ohio and Wisconsin; cross-hatched: Iowa, Wyoming, Kansas and Minnesota">`;
  assert.deepEqual(correctionEffect(joined, movedOut).alt_relocated, ["Wyoming"]);
  // The same name in the position English usually writes a list's last member in, which the first
  // version of this fix still split: the last piece is opened on its FIRST conjunction, so
  // "Suriname and Trinidad and Tobago" separates into the member and the name rather than into the
  // name's two halves.
  const last = `<img alt="Darkest: Guyana, Suriname and Trinidad and Tobago; lightest: Belize, Panama, Costa Rica">`;
  const lastMoved = `<img alt="Darkest: Guyana and Suriname; lightest: Belize, Panama, Costa Rica and Trinidad and Tobago">`;
  assert.deepEqual(correctionEffect(last, lastMoved).alt_relocated, ["Trinidad and Tobago"]);
});

test("a run written with no commas is separated by every conjunction in it", () => {
  // The other side of that rule, and the second thing the review of this branch caught. A bucket with
  // commas in it has said what its separator is; a bucket with none has not, and there the conjunction
  // is doing the work every comma would have done. Read as two, the key for the tail is a name nobody
  // wrote — "Wisconsin and Wyoming" — so the member that moved is not a key at all and the move is
  // lost in silence.
  const runOn = `<img alt="Darkest: Ohio and Wisconsin and Wyoming; light: Iowa, Kansas, Nebraska">`;
  const runOnMoved = `<img alt="Darkest: Ohio and Wisconsin; light: Iowa, Kansas, Nebraska and Wyoming">`;
  assert.deepEqual(correctionEffect(runOn, runOnMoved).alt_relocated, ["Wyoming"]);
  // And a conjunction NAME inside such a run costs only itself: "Health" and "Human Services" are two
  // phantoms that travel together, so neither is ever reported, while the real member beside them is.
  const depts = `<img alt="Fully funded: Health and Human Services and Education; partly: Interior, Commerce, Labor">`;
  const deptsMoved = `<img alt="Fully funded: Health and Human Services; partly: Interior, Commerce, Labor and Education">`;
  assert.deepEqual(correctionEffect(depts, deptsMoved).alt_relocated, ["Education"]);
});

test("a member that was alone in its clause did not leave a list", () => {
  // The other side of that floor, and why it is two rather than one. Missouri is the only name in the
  // clause it sits in beforehand, so there is no set of names it was listed WITH — and this reports a
  // member listed with one company and then another, which needs both. A lone name in a clause is as
  // likely to be prose as a category of one, and reading it as a category would report a relocation
  // off the strength of the destination alone.
  const before = `<img alt="Too faint to place: Missouri; cross-hatched, 1.5 thru 1.9 percent: Michigan, Iowa, Kansas, Minnesota">`;
  const after = `<img alt="cross-hatched, 1.5 thru 1.9 percent: Michigan, Missouri, Iowa, Kansas, Minnesota">`;
  const e = correctionEffect(before, after);
  assert.equal(e.alt_changed, true);
  assert.equal(e.alt_relocated, undefined);
});

test("an abbreviation or a decimal inside a member does not cut its list in half", () => {
  // Both are ordinary on a shaded map — "N.D.", "1.5 thru 1.9" — and a sentence split that took
  // either for the end of a list would put the members after it in a list of their own, then report
  // every one of them as having moved the next time the description was re-emitted. This is the
  // whole reason `ENUMERATION_BREAK` will not open on a period after a capital or a digit.
  const before = `<img alt="Shaded 1.5 thru 1.9: N.D., S.D., Kan., Mo.; shaded 2.0 and over: Ohio, Wis., Wyo.">`;
  const reordered = `<img alt="Shaded 1.5 thru 1.9: S.D., Kan., N.D., Mo.; shaded 2.0 and over: Wis., Ohio, Wyo.">`;
  assert.equal(correctionEffect(before, reordered).alt_relocated, undefined);
  // And the move itself is still seen through the same punctuation. "Mo." keeps its period in one
  // reply and loses it to the sentence break at the end of the other, which is why the key a member
  // is matched on drops a trailing one: left in, this move would be two different members and
  // nothing would have crossed.
  const moved = `<img alt="Shaded 1.5 thru 1.9: N.D., S.D., Kan.; shaded 2.0 and over: Ohio, Wis., Wyo., Mo.">`;
  assert.deepEqual(correctionEffect(before, moved).alt_relocated, ["Mo."]);
});

test("a name listed twice in one description is not resolved to one of its places", () => {
  // Which of the two the corrected reply's "Michigan" corresponds to is exactly what this cannot
  // know, and settling it by position would be a guess reported as a measurement. Here Michigan is
  // filed in two bands at once — a first-read defect of its own, and one this says nothing about.
  const twice =
    `<img alt="Darkest: Ohio, Wisconsin, Wyoming, Michigan; cross-hatched: Iowa, Kansas, Minnesota, ` +
    `Illinois; lightest: Texas, Georgia, Michigan">`;
  // A correction that drops the duplicate is not a member changing lists, and reading the repeat as
  // its first occurrence would report exactly that: Michigan listed with Ohio and Wisconsin before,
  // with Texas and Georgia after, and both of those are real lists that existed all along.
  const deduped = twice.replace("Ohio, Wisconsin, Wyoming, Michigan", "Ohio, Wisconsin, Wyoming");
  assert.equal(correctionEffect(twice, deduped).alt_relocated, undefined);
  // And the other members of a list holding a repeat are still read, so one ambiguous name does not
  // cost the description the check.
  const moved = twice
    .replace("Ohio, Wisconsin, Wyoming, Michigan", "Ohio, Wisconsin, Michigan")
    .replace("Iowa, Kansas", "Iowa, Wyoming, Kansas");
  assert.deepEqual(correctionEffect(twice, moved).alt_relocated, ["Wyoming"]);
});

test("a correction that changed how many images there are reports no relocation", () => {
  // Descriptions are paired by position, so an image added or dropped shifts every pairing after it
  // and every member of both lists would read as relocated. That correction is a structural change
  // and is reported as one.
  const e = correctionEffect(
    BANDS_BEFORE,
    `<img src="new.png" alt="a chart">${BANDS_AFTER}`,
  );
  assert.equal(e.structure_changed, true);
  assert.equal(e.alt_relocated, undefined);
});

test("a re-typed href is a change, though no word on the page moves", () => {
  // The correction the links pass exists to buy: links.ts asks for "exactly that URL —
  // without changing anything else about the page", so a model that obeys, on an anchor it
  // had already emitted with a mangled href, changes one attribute and nothing else. Read
  // on text, descriptions and tag names alone this is a pass that did nothing — and a
  // measure that says so about the fix it asked for is measuring the wrong thing.
  const e = correctionEffect(
    `<p>Read <a href="https://example.org/rep">the full report</a></p>`,
    `<p>Read <a href="https://example.org/report">the full report</a></p>`,
  );
  assert.equal(e.attrs_changed, true);
  assert.equal(changedAnything(e), true);
  assert.equal(e.text_changed, false);
  assert.equal(e.structure_changed, false);
  assert.equal(e.alt_changed, false);
});

test("the accessibility attributes the prompt asks for by name are changes", () => {
  // Every one of these is a fix agents/page.md requires, and none of them moves a word or a
  // tag: a scope on a header cell, a name on a symbolic footnote marker, a note associated
  // with its table, a language change.
  for (const [before, after] of [
    [`<table><tr><th>Year</th></tr></table>`, `<table><tr><th scope="col">Year</th></tr></table>`],
    [`<sup><a href="#fn-1" id="fnref-1">*</a></sup>`, `<sup><a href="#fn-1" id="fnref-1" aria-label="Footnote 1">*</a></sup>`],
    [`<table><tr><td>1</td></tr></table>`, `<table aria-describedby="numbering-note-1"><tr><td>1</td></tr></table>`],
    [`<p>Bonjour</p>`, `<p lang="fr">Bonjour</p>`],
  ] as [string, string][]) {
    const e = correctionEffect(before, after);
    assert.equal(e.attrs_changed, true, `not seen as a change: ${after}`);
    assert.equal(e.text_changed, false, `read as a text change: ${after}`);
  }
});

test("attribute order and re-spacing are not a change", () => {
  // A model re-emitting its own tag may reorder its attributes or space them differently,
  // and neither is something a reader can tell apart — the same reason re-indentation is not
  // a change to the text.
  const e = correctionEffect(
    `<img src="a.png" class="fig" alt="a kayak">`,
    `<img  class="fig"   src="a.png"  alt="a kayak">`,
  );
  assert.equal(e.attrs_changed, false);
  assert.equal(changedAnything(e), false);
});

test("an attribute that moved to the wrong element is a change", () => {
  // The same attributes, the same words, the same tags — and an `id` that now names the
  // wrapper instead of the paragraph, which is how a `for`, a `headers` or an
  // `aria-describedby` pointing at it stops resolving. Nothing but the tag boundary says so,
  // which is why the tags are joined on something an attribute value cannot contain: on a
  // space, these two flatten to the same string.
  const e = correctionEffect(
    `<div dir="ltr"><p id="x" lang="fr">Bonjour</p></div>`,
    `<div dir="ltr" id="x"><p lang="fr">Bonjour</p></div>`,
  );
  assert.equal(e.attrs_changed, true);
  assert.equal(e.text_changed, false);
  assert.equal(e.structure_changed, false);
  assert.equal(changedAnything(e), true);
});

test("rewriting an HTML comment is not an attribute change", () => {
  // A comment is not content anywhere in this module — `visibleText` strips them — and the
  // attribute scan sees `<!-- … -->` as a tag whose body is a list of attribute names unless
  // it strips them too. Uncaught, a re-worded comment lands in `effects.attrs`, the bucket
  // documented as a re-typed `href`, and spends the batch's one measurement slot.
  for (const [before, after] of [
    [`<!-- continued from previous page --><p>Hi</p>`, `<!-- continues on next page --><p>Hi</p>`],
    [`<!-- a note --><p>Hi</p>`, `<p>Hi</p>`],
    // And one the model never closed, which a parser reads as running to the end of the
    // fragment. Both signals have to read it that way or they disagree about the same
    // characters: the tag scan swallows `<!-- continued alpha <p>` whole, so the text signal
    // drops those words while the attribute signal would file them as attribute names.
    [`<p>Hi</p><!-- continued alpha <p>`, `<p>Hi</p><!-- continued beta <p>`],
  ] as [string, string][]) {
    const e = correctionEffect(before, after);
    assert.equal(e.attrs_changed, false, `read as an attribute change: ${after}`);
    assert.equal(changedAnything(e), false, `read as a change to the page: ${after}`);
  }
});

test("a page rewritten to nothing reports what it lost", () => {
  const e = correctionEffect(`<p>The whole page</p>`, ``);
  assert.equal(e.text_changed, true);
  assert.equal(e.structure_changed, true);
  assert.equal(e.chars_after, 0);
});

test("the floor under a correction is a quarter of the page, and it is a floor and not a rule", () => {
  // Where the quarter comes from is in `CORRECTION_SHRINK_FLOOR`: over 265 corrections in the
  // bench logs, every legitimate one lands between 0.62 and 2.32 times the page it replaced,
  // and the two below that are both issue #170 — a scratch template and an abandoned draft.
  // So the guard has to refuse those two shapes while leaving a correction that genuinely
  // tightens a page alone.
  const page = "x".repeat(400);
  assert.equal(destroyedPage(page, "x".repeat(3)), true, "the reply that replaced a page with `...`");
  assert.equal(destroyedPage(page, "x".repeat(66)), true, "0.165 of the page: the abandoned draft");
  assert.equal(destroyedPage(page, "x".repeat(99)), true);
  assert.equal(destroyedPage(page, "x".repeat(100)), false, "exactly a quarter is not past the floor");
  assert.equal(destroyedPage(page, "x".repeat(248)), false, "0.62: the smallest real correction on record");
  assert.equal(destroyedPage(page, "x".repeat(928)), false, "and a correction may grow a page freely");
  // A page that was empty to begin with cannot be shrunk, and must not divide by it.
  assert.equal(destroyedPage("", ""), false);
});

// --- through the pipeline -----------------------------------------------------

interface Event {
  type: string;
  [k: string]: unknown;
}

type VerifyProblem = string | { kind: string; problem: string };

interface Behaviour {
  // Initial render per page order.
  html: (order: number) => string;
  // First verdict per page order: the problems it names, empty for a pass. A plain string
  // is a problem with no kind, which is what an agent file predating the kinds returns and
  // what most of the tests below use — the kinds are additive and nothing here depends on
  // them (issue #182). A `{kind, problem}` entry is the current contract.
  problems: (order: number) => VerifyProblem[];
  // What the correction pass returns, or "" for a call that produced nothing.
  corrected: (order: number) => string;
  // The re-verification's verdict, for pages that get one.
  recheck?: (order: number) => VerifyProblem[];
  // A provider error on the re-verification, the way ProviderRouter.complete raises one.
  recheckThrows?: boolean;
  // A provider error on the FIRST verify — the fidelity check itself. Separate from
  // `recheckThrows` because that one fires on every call after the first, and the whole point of
  // issue #364 is that this call is reached by every page in every run while a recheck is reached
  // only by a page that was corrected. A thunk rather than a flag so a test can choose the shape:
  // a throttle carries no reply, and a `TruncatedResponseError` carries the evidence the log line
  // exists to preserve.
  verifyThrows?: () => unknown;
  // The first verify answers prose with no JSON in it. `verifyAgentOutput` cannot read a
  // verdict out of that and returns its non-blocking default, which is a page nothing
  // judged rather than a page that passed.
  verifyGarbles?: boolean;
  // The first verdict names its problems and sets both flags TRUE anyway — the verifier that
  // describes a defect and ticks the box (issue #210). Everything else here derives `faithful`
  // from whether the list is empty, which is the contract; this is the measured departure from
  // it, and the only way to reach the branch that ships such a page.
  describesAndPasses?: boolean;
  // The same, on the RE-verification only: the first verdict is real and the second is prose.
  // Separate from `verifyGarbles` because a garbled first verdict passes the page and so buys
  // no correction and no recheck — the two flags cannot reach the same call.
  recheckGarbles?: boolean;
  // A provider error on the CORRECTION call itself: the output ceiling, a stall, a throttle.
  // Not per page, unlike the rest of these — the correction prompt does not carry the page's
  // filename (it carries the page's own previous output), so `orderOf` cannot see which page
  // is being corrected. Tests that want one page to fail give only that page a problem.
  correctionThrows?: () => Error;
  links?: PdfLink[];
  // The correction call's own user message, for a test whose subject is what that prompt says
  // rather than what the page came back as.
  onCorrection?: (user: string) => void;
}

function makeCtx(dir: string, events: Event[], b: Behaviour, pages = 2): PipelineContext {
  const agentsDir = join(dir, "agents");
  const fragDir = join(dir, "fragments");
  const inputDir = join(dir, "input");
  for (const d of [agentsDir, fragDir, inputDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
  writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\nvision\n");
  const names = Array.from({ length: pages }, (_, i) => `page-00${i + 1}.png`);
  for (const n of names) writeFileSync(join(inputDir, n), "not-a-real-png");
  const orderOf = (user: string): number => names.findIndex((n) => user.includes(n)) + 1;
  // Which verify call this is for a given page: the first is the fidelity check, a
  // second is a re-verification of the corrected fragment.
  const verifies = new Map<number, number>();

  return {
    sessionId: "ses_test",
    images: names.map((name, i) => ({
      name,
      order: i + 1,
      path: join(inputDir, name),
      links: b.links ?? [],
    })),
    extractionConcurrency: pages,
    recheckSampleSize: 1,
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
        if (user.includes("TASK: verify")) {
          const n = (verifies.get(order) ?? 0) + 1;
          verifies.set(order, n);
          if (n === 1 && b.verifyThrows) throw b.verifyThrows();
          if (n > 1 && b.recheckThrows) throw new Error("ThrottlingException: Too many requests");
          if (n === 1 && b.verifyGarbles) return { text: "I was unable to compare the HTML with the image." };
          if (n > 1 && b.recheckGarbles) return { text: "I was unable to compare the HTML with the image." };
          const problems = n === 1 ? b.problems(order) : (b.recheck ?? (() => []))(order);
          return {
            text: JSON.stringify({
              faithful: problems.length === 0 || (n === 1 && b.describesAndPasses === true),
              accessible: true,
              problems,
            }),
          };
        }
        if (user.includes("had fidelity/accessibility problems")) {
          b.onCorrection?.(user);
          if (b.correctionThrows) throw b.correctionThrows();
          return { text: JSON.stringify({ html: b.corrected(order) }) };
        }
        return { text: JSON.stringify({ html: b.html(order), log: "" }) };
      },
    },
    log: {
      event: (type: string, fields: Record<string, unknown>) => events.push({ type, ...fields }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iris-verification-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const of = (events: Event[], type: string): Event[] => events.filter((e) => e.type === type);

test("a correction that changed the page says what it changed", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const rendered = `<h2>Findings</h2><img src="a.png" alt="a kayak">`;
    const fixed = `<h2>Findings</h2><img src="a.png" alt="a kayak, the paddler facing away">`;
    const ctx = makeCtx(dir, events, {
      html: () => rendered,
      problems: (o) =>
        o === 1 ? [{ kind: "alt_quality", problem: "the alt text omits that the person faces away" }] : [],
      corrected: () => fixed,
    });
    const result = await runExtraction(ctx);

    const corrected = of(events, "page_corrected");
    assert.equal(corrected.length, 1, "one page failed its check, so one correction");
    assert.deepEqual(
      { ...corrected[0] },
      {
        type: "page_corrected",
        image: "page-001.png",
        page: 1,
        trigger: "verify",
        problems: 1,
        // The issue #182 page, on one line: what the verifier said was wrong (`alt_quality`)
        // beside what the correction did (`alt_changed` alone). A run whose corrections all
        // look like this is spending a page call per page on image descriptions, which no
        // pairing of `verify_failed` with `effects` could say before the kind was on the line.
        kinds: ["alt_quality"],
        result: "kept",
        chars_before: rendered.length,
        chars_after: fixed.length,
        // "Findings", both times: the fragment grew by 25 characters and the reader receives
        // exactly what they did before, which is the alt-only correction stated in sizes.
        text_chars_before: 8,
        text_chars_after: 8,
        text_changed: false,
        alt_changed: true,
        attrs_changed: false,
        structure_changed: false,
      },
    );
    // And the document is the corrected page, unchanged by any of this.
    assert.match(result.fragments[0].innerHtml, /facing away/);
  });
});

// #355. The unit tests above are on `correctionEffect`; this one is on the line an operator reads.
// A relocation that no event carries is a measurement nobody has, which is the state the issue
// reported: both replies existed, one after the other, and the log said `alt_changed: true`.
test("a member that crossed between two lists reaches the correction's log line", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    await runExtraction(
      makeCtx(dir, events, {
        html: () => BANDS_BEFORE,
        problems: (o) =>
          o === 1
            ? [{ kind: "content_wrong", problem: "Missouri appears cross-hatched, not in the darkest band" }]
            : [],
        corrected: () => BANDS_AFTER,
      }),
    );
    const corrected = of(events, "page_corrected");
    assert.equal(corrected.length, 1);
    assert.deepEqual(corrected[0].alt_relocated, ["Missouri"]);
    // Beside the fields that were the whole of this line before, and which cannot say it: the page's
    // words did not move, its structure did not move, and one description was refined.
    assert.equal(corrected[0].alt_changed, true);
    assert.equal(corrected[0].text_changed, false);
    assert.equal(corrected[0].result, "kept");
    // The verdict that bought the correction is on the same line, so the pair reads as one fact: a
    // `content_wrong` finding was acted on, and what it moved was a state between two bands.
    assert.deepEqual(corrected[0].kinds, ["content_wrong"]);
  });
});

test("an ordinary correction leaves the relocation field off the line entirely", async () => {
  // The field is absent rather than empty, so it costs nothing on the corrections that are not this
  // — and a consumer counting relocations counts lines that have it.
  await withTemp(async (dir) => {
    const events: Event[] = [];
    await runExtraction(
      makeCtx(dir, events, {
        html: () => `<h2>Findings</h2><img src="a.png" alt="a kayak">`,
        problems: (o) => (o === 1 ? [{ kind: "alt_quality", problem: "the alt text is thin" }] : []),
        corrected: () => `<h2>Findings</h2><img src="a.png" alt="a kayak, the paddler facing away">`,
      }),
    );
    const corrected = of(events, "page_corrected");
    assert.equal(corrected.length, 1);
    assert.ok(!("alt_relocated" in corrected[0]));
  });
});

// Issue #132: a re-render came back with heading levels, table cells and semantic markup that a
// previous, accepted iteration had right — reported by the user as "a clear regression". Both
// paths that re-render a page show the model its own previous output, and until this change only
// one of them said what to do with the parts nobody had complained about: `renderPage`'s
// `priorSection` carries "Keep everything the feedback does NOT concern exactly as it was", and
// this path carried nothing. "Resolve every problem" against a whole page and an image reads as a
// licence to produce the page again.
//
// Which costs the page silently. The corrected fragment replaces the previous one wholesale, and
// `correctionEffect` measures the change without judging it: a heading that moved a level and a
// cell's list flattened arrive as `structure_changed: true`, which is also what the requested fix
// looks like. `destroyedPage` refuses only a fragment that lost most of itself.
//
// So the scope is now in the prompt, and it is asserted here rather than in a wording test
// because the sentence has to reach the model on this path specifically — that is the asymmetry
// #132 was filed about. The page prompt carries the same rule for both paths
// (test/page-prompt.test.ts).
test("the correction prompt names the problems and bounds what else may change", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const prompts: string[] = [];
    const rendered = `<h2>Controls</h2><dl><dt>Power</dt><dd>Turns the unit on.</dd></dl>`;
    await runExtraction(
      makeCtx(dir, events, {
        html: () => rendered,
        problems: (o) => (o === 1 ? ["the heading level is wrong"] : []),
        corrected: () => `<h3>Controls</h3><dl><dt>Power</dt><dd>Turns the unit on.</dd></dl>`,
        onCorrection: (user) => prompts.push(user),
      }),
    );

    assert.equal(prompts.length, 1, "one page failed its check, so one correction prompt");
    const user = prompts[0].replace(/\s+/g, " ");
    // What it is asked to fix, and the page it is fixing — unchanged, and pinned here because
    // the scope clause below is meaningless without them.
    assert.match(user, /- the heading level is wrong/);
    assert.match(user, /## Your previous output/);
    assert.match(user, /return a corrected version that resolves every problem/);
    // And the bound. Enumerated rather than left as "nothing else": #132's regression was four
    // different kinds of element at once, and a model reading "resolve every problem" needs to
    // be told that the <dl> it was not asked about is not its business either.
    assert.match(
      user,
      /Change nothing the list above does not name: every heading, table, list, label and attribute that is not part of a problem is carried over exactly as it stands\./,
    );
  });
});

test("a correction that returned the page it was given is recorded as buying nothing", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const same = `<p>Unchanged</p>`;
    await runExtraction(
      makeCtx(dir, events, {
        html: () => same,
        problems: (o) => (o === 1 ? ["a column of the table was dropped"] : []),
        corrected: () => same,
      }),
    );
    const corrected = of(events, "page_corrected");
    assert.equal(corrected.length, 1);
    assert.equal(corrected[0].result, "identical");
    // No effect fields: there was no difference to describe, and reporting three
    // `false`s would read as a change measured rather than a call wasted.
    assert.equal("text_changed" in corrected[0], false);
    // A call that changed nothing does not spend the batch's one measurement slot
    // either — there is nothing to re-verify.
    assert.equal(of(events, "page_correction_recheck").length, 0);
  });
});

test("a page re-typed to no effect is counted with the calls that bought nothing", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The model returns its own page re-indented, with `&` where it wrote `&amp;`. That is a
    // different string and the same page, so bucketing on string identity would file it as
    // `kept` — a page call that bought nothing counted beside one that restored a table, and
    // not recoverable from the fold afterwards, since `text` and `structure` overlap and
    // cannot be subtracted from `kept`.
    const rendered = `<ul><li>Costs &amp; savings</li></ul>`;
    const retyped = `<ul>\n  <li>Costs & savings</li>\n</ul>`;
    const result = await runExtraction(
      makeCtx(dir, events, {
        html: () => rendered,
        problems: (o) => (o === 1 ? ["a list item was dropped"] : []),
        corrected: () => retyped,
      }),
    );
    const corrected = of(events, "page_corrected");
    assert.equal(corrected.length, 1);
    assert.equal(corrected[0].result, "identical");
    // Every flag false is what makes it `identical`, and the sizes say which kind of nothing
    // it was: a model that re-typed the page and one that handed back the exact string it
    // was given cost the same and are not the same event.
    assert.deepEqual(
      { t: corrected[0].text_changed, a: corrected[0].alt_changed, at: corrected[0].attrs_changed, s: corrected[0].structure_changed },
      { t: false, a: false, at: false, s: false },
    );
    assert.equal(corrected[0].chars_before, rendered.length);
    assert.equal(corrected[0].chars_after, retyped.length);
    // And it buys no re-verification either: there is no change to check.
    assert.equal(of(events, "page_correction_recheck").length, 0);
    assert.match(result.fragments[0].innerHtml, /Costs/);
  });
});

test("a correction that came back empty is recorded, and the page keeps its content", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const result = await runExtraction(
      makeCtx(dir, events, {
        html: () => `<p>What the page says</p>`,
        problems: (o) => (o === 1 ? ["the heading level is wrong"] : []),
        corrected: () => "",
      }),
    );
    const corrected = of(events, "page_corrected");
    assert.equal(corrected.length, 1);
    assert.equal(corrected[0].result, "empty");
    assert.match(result.fragments[0].innerHtml, /What the page says/);
  });
});

test("a correction that came back as a fragment of the page is refused, and the page kept", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The reply from issue #170, in the shape the pipeline sees it: the correction pass
    // returns a few characters where a page was. It happened because `extractJson` bound a
    // reasoning model's scratch template instead of its answer — but nothing here asked what
    // the reply looked like, so the fragment was adopted, logged `result: "kept"`, and page 17
    // left the delivered document while the run reported every page delivered.
    const page = `<h2>Table 3</h2><table><tr><th>State</th><th>Total</th></tr><tr><td>Alabama</td><td>4,132</td></tr></table>`;
    const result = await runExtraction(
      makeCtx(dir, events, {
        html: () => page,
        problems: (o) => (o === 1 ? ["the Alabama row's total is wrong"] : []),
        corrected: () => "...",
      }),
    );
    const rejected = of(events, "page_correction_rejected");
    assert.equal(rejected.length, 1);
    assert.deepEqual(
      { ...rejected[0] },
      {
        type: "page_correction_rejected",
        image: "page-001.png",
        page: 1,
        trigger: "verify",
        reason: "shrank",
        chars_before: page.length,
        chars_after: 3,
      },
    );
    // The page that was corrected is the page that ships — the same outcome as a correction
    // that came back empty, and for the same reason.
    assert.equal(result.fragments[0].innerHtml, page);
    // On the record as a correction that was thrown away, which is what `results.rejected`
    // in diagnostics counts.
    assert.equal(of(events, "page_corrected")[0].result, "rejected");
    // And no verdict was bought on a fragment nothing will deliver: the batch's one
    // measurement slot is still there for a page whose correction is real.
    assert.equal(of(events, "page_correction_recheck").length, 0);
  });
});

test("a links-triggered correction is refused for shrinking before the Feedback Agent is asked", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const link = { text: "the full report", href: "https://example.org/report" };
    // Same guard, other trigger. This page PASSED its fidelity check and is being re-rendered
    // only to recover a link, so the links path was already going to re-verify and discard a
    // rewrite that lost something. The size check gets there first, which saves the call: a
    // fragment this much smaller than the page is not a rewrite to be judged.
    const page =
      `<h2>Progress</h2><p>Read the full report for the 2026 figures, which cover every region.</p>` +
      `<p>The regional tables that follow restate the same figures by county, and the notes at the ` +
      `foot of the page record which of them were revised after publication.</p>`;
    const result = await runExtraction(
      makeCtx(dir, events, {
        html: () => page,
        problems: () => [],
        corrected: () => `<p><a href="https://example.org/report">the full report</a></p>`,
        links: [link],
      }),
    );
    assert.deepEqual(of(events, "page_correction_rejected").map((e) => [e.trigger, e.reason]), [
      ["links", "shrank"],
      ["links", "shrank"],
    ]);
    assert.equal(result.fragments[0].innerHtml, page, "the page that had passed is the one delivered");
    // The links path's own rejection event did not fire, because its re-verification never
    // ran — the two are not two rejections of the same fragment.
    assert.equal(of(events, "page_links_correction_rejected").length, 0);
    assert.equal(of(events, "page_correction_recheck").length, 0);
    // The link is still missing from the delivered page, and the log still says so: refusing
    // the correction does not quietly close the failure it was asked to fix.
    assert.deepEqual(of(events, "page_links_unrecovered").length, 0, "not this event — the page was never replaced");
    assert.equal(of(events, "page_links_missing").length, 2);
  });
});

test("a correction that tightens a page without gutting it is still delivered", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The guard has to be a floor and not a policy about size. This is the smallest real
    // correction in the bench logs, roughly to scale: a page re-rendered at 0.62 of its
    // length because the model collapsed a table it had first written as nested divs.
    const page = `<div><div>State</div><div>Total</div></div>`.repeat(6);
    const tighter = `<table><tr><th>State</th><th>Total</th></tr></table>`.repeat(3);
    const result = await runExtraction(
      makeCtx(dir, events, {
        html: () => page,
        problems: (o) => (o === 1 ? ["the table is marked up as divs"] : []),
        corrected: () => tighter,
      }),
    );
    assert.ok(tighter.length / page.length < 0.7, "the fixture is a real shrink, not a rounding one");
    assert.equal(of(events, "page_correction_rejected").length, 0);
    assert.equal(of(events, "page_corrected")[0].result, "kept");
    assert.equal(result.fragments[0].innerHtml, tighter);
  });
});

test("a correction that hit the output ceiling costs the correction, not the page", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // Issue #171, as it happened: a page rendered fine, the Feedback Agent named two cosmetic
    // problems, and the correction call ran for 522 seconds and hit the 32,000-token ceiling.
    // The error propagated out of `extractPage` into `failedPage`, so the run logged
    // `page_extraction_failed` and shipped a `@page-failed` marker for a page whose valid
    // 17,721-character extraction was sitting in a local variable.
    const page = `<hr aria-label="Page 36"><h2>Regional detail</h2><p>Southeast through Rocky Mountain.</p>`;
    const result = await runExtraction(
      makeCtx(dir, events, {
        html: () => page,
        problems: (o) => (o === 1 ? ["the printed folio is transcribed as visible content", "an unwarranted <section> wrapper"] : []),
        corrected: () => "<p>never reached</p>",
        correctionThrows: () => new TruncatedResponseError("bedrock", "some-model", 32000, TRUNCATED_REPLY),
      }),
    );
    // The page is delivered, whole, as the extraction that succeeded left it.
    assert.equal(result.failedPages.length, 0);
    assert.equal(result.fragments[0].innerHtml, page);
    assert.doesNotMatch(result.fragments.map((f) => f.innerHtml).join(""), /@page-failed/);
    // And the stage that failed is the stage that is named. `page_extraction_failed` would
    // send anyone reading the log — `pages_failed`, the markers, any triage of why pages
    // fail — to a vision call that worked.
    assert.equal(of(events, "page_extraction_failed").length, 0);
    const failed = of(events, "page_correction_failed");
    assert.equal(failed.length, 1);
    assert.deepEqual(
      { ...failed[0], error: "…" },
      {
        type: "page_correction_failed",
        image: "page-001.png",
        page: 1,
        trigger: "verify",
        problems: 2,
        error: "…",
        truncated: true,
        // The whole reply and its two ends, which on this line are the evidence and not colour: 93,039
        // characters against an 89-character page is the ratio the argument about the cap turns on, and
        // a head that is the page's own opening tells that apart from a model answering about something
        // else (#293). `reply_chars` and not `chars`, because `chars_kept` is on this same line.
        reply_chars: TRUNCATED_REPLY.length,
        reply_head: TRUNCATED_REPLY.slice(0, 240),
        reply_tail: TRUNCATED_REPLY.slice(-240),
        chars_kept: page.length,
      },
    );
    assert.match(String(failed[0].error), /32000-token output ceiling/);
    // Counted as a correction that bought nothing, in its own bucket: this one paid for a
    // full ceiling of output, where `empty` answered briefly and said nothing.
    const corrected = of(events, "page_corrected");
    assert.equal(corrected.length, 1);
    assert.equal(corrected[0].result, "failed");
    // The fidelity problems are still on record as unfixed — refusing to lose the page does
    // not claim the page was correct.
    assert.equal(of(events, "page_verify_failed").length, 1);
  });
});

test("any provider error on a correction is survivable, not only a ceiling", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // A throttle, a stall and a ceiling all leave the same thing behind: a page good enough
    // to have been worth correcting. So the catch is not a list of survivable error classes —
    // a list would go stale in the direction that loses pages.
    const page = `<h2>Findings</h2><p>Two of the three measures improved.</p>`;
    const result = await runExtraction(
      makeCtx(dir, events, {
        html: () => page,
        problems: (o) => (o === 1 ? ["the heading level skips one"] : []),
        corrected: () => "<p>never reached</p>",
        correctionThrows: () => new Error("ThrottlingException: Too many requests"),
      }),
    );
    assert.equal(result.failedPages.length, 0);
    assert.equal(result.fragments[0].innerHtml, page);
    const failed = of(events, "page_correction_failed");
    assert.equal(failed.length, 1);
    assert.match(String(failed[0].error), /ThrottlingException/);
    // Not a truncation, and the log says which it was: only one of the two has a
    // `providers.*.max_tokens` to raise.
    assert.equal(failed[0].truncated, false);
    assert.equal(of(events, "page_corrected")[0].result, "failed");
  });
});

test("a links-triggered correction that throws keeps the page that had passed", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const link = { text: "the full report", href: "https://example.org/report" };
    // The worse version of the same defect: this page PASSED its fidelity check and is being
    // re-rendered only to attach a link. A throw here used to delete a page that nothing had
    // found any fault with, for a link that is additive.
    const page = `<h2>Progress</h2><p>Read the full report for the 2026 figures.</p>`;
    const result = await runExtraction(
      makeCtx(dir, events, {
        html: () => page,
        problems: () => [],
        corrected: () => "<p>never reached</p>",
        correctionThrows: () => new TruncatedResponseError("bedrock", "some-model", 32000, TRUNCATED_REPLY),
        links: [link],
      }),
    );
    assert.equal(result.failedPages.length, 0);
    for (const f of result.fragments) assert.equal(f.innerHtml, page);
    assert.deepEqual(of(events, "page_correction_failed").map((e) => e.trigger), ["links", "links"]);
    // No verdict was bought on a correction that never came back, on either path.
    assert.equal(of(events, "page_correction_recheck").length, 0);
    assert.equal(of(events, "page_links_correction_rejected").length, 0);
    // The link is still missing, and the log still says so.
    assert.equal(of(events, "page_links_missing").length, 2);
  });
});

test("one page per run is re-verified, however many were corrected", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // Every page fails, which is the run the issue reports (25 of 25). Re-verifying all
    // of them would roughly double the Feedback Agent's share of the bill, which is the
    // number under investigation.
    await runExtraction(
      makeCtx(
        dir,
        events,
        {
          html: (o) => `<p>page ${o}</p>`,
          problems: () => ["a figure is missing its caption"],
          corrected: (o) => `<p>page ${o}</p><figcaption>Figure ${o}</figcaption>`,
          recheck: () => [],
        },
        4,
      ),
    );
    assert.equal(of(events, "page_verify_failed").length, 4);
    assert.equal(of(events, "page_corrected").length, 4);
    const rechecks = of(events, "page_correction_recheck");
    assert.equal(rechecks.length, 1, "the sample is one page, not one per correction");
    assert.equal(rechecks[0].ok, true);
    // Not a gate: this verdict decided nothing, and a consumer must be able to tell
    // that from the event rather than from reading the pipeline.
    assert.equal(rechecks[0].binding, false);
  });
});

test("a corrected page that still fails is reported as still failing, and still kept", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const result = await runExtraction(
      makeCtx(dir, events, {
        html: () => `<p>first pass</p>`,
        problems: (o) => (o === 1 ? ["the second column of the table was dropped"] : []),
        corrected: () => `<p>second pass</p>`,
        recheck: () => ["the second column of the table is still missing"],
      }),
    );
    const rechecks = of(events, "page_correction_recheck");
    assert.equal(rechecks.length, 1);
    assert.equal(rechecks[0].ok, false);
    assert.deepEqual(rechecks[0].problems, ["the second column of the table is still missing"]);
    // One problem in, one problem out: a correction that fixed nothing it was asked to.
    // Indistinguishable from the test below on `ok` alone, which is the reading issue #166
    // reports — four failed samples that could have been four wasted calls or four near
    // misses.
    assert.equal(rechecks[0].problems_before, 1);
    assert.equal(rechecks[0].problems_after, 1);
    // The measurement is measurement only. A verify-driven correction is accepted
    // exactly as it was before this event existed — whether to re-render until a page
    // passes is a policy question the rate has to answer first.
    assert.match(result.fragments[0].innerHtml, /second pass/);
    assert.equal(of(events, "page_corrected")[0].result, "kept");
  });
});

// Issue #182: the verdict's line says what KIND of problem it found, so `verify_failed` can be
// read as something other than "pages the verifier had an opinion about". test/verify-kinds.test.ts
// pins how a reply is read into that set and how a log of it folds; these two pin that the set
// reaches the events, which is the only place a benchmark round can see it from.
test("the verdict's line names the kinds it found, and how many problems carried none", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    await runExtraction(
      makeCtx(dir, events, {
        html: () => `<p>first pass</p>`,
        problems: (o) =>
          o === 1
            ? [
                { kind: "content_missing", problem: "the totals row of the table is absent" },
                { kind: "content_missing", problem: "the footnote under it is absent" },
                "the heading is a level too deep",
              ]
            : [],
        corrected: () => `<p>second pass</p>`,
      }),
    );
    const failed = of(events, "page_verify_failed");
    assert.equal(failed.length, 1);
    // Two problems of one kind are one kind: the question is what the PAGE lost. The third
    // problem came back untagged, and the line says so rather than letting the two kinds read
    // as the whole verdict.
    assert.deepEqual(failed[0].kinds, ["content_missing"]);
    assert.equal(failed[0].untagged, 1);
    assert.equal((failed[0].problems as string[]).length, 3, "the correction is still told all three");
    // And the correction line carries the same set, so what was wrong going in sits beside what
    // the pass changed without a join back to the verdict.
    assert.deepEqual(of(events, "page_corrected")[0].kinds, ["content_missing"]);
  });
});

test("a recheck says which kinds survived the correction, not just that it did not pass", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    await runExtraction(
      makeCtx(dir, events, {
        html: () => `<p>first pass</p>`,
        problems: (o) =>
          o === 1
            ? [
                { kind: "content_missing", problem: "the second column of the table was dropped" },
                { kind: "alt_quality", problem: "the figure's description is thin" },
              ]
            : [],
        corrected: () => `<p>second pass</p>`,
        recheck: () => [{ kind: "alt_quality", problem: "the figure's description is still thin" }],
      }),
    );
    const rechecks = of(events, "page_correction_recheck");
    assert.equal(rechecks.length, 1);
    assert.equal(rechecks[0].ok, false);
    // The reading the counts alone cannot give: the content came back and the description is
    // now the whole complaint. Two-in-one-out says the pass got most of the way; these say the
    // half it got was the half that mattered — and `content_missing` on both sides would have
    // been the opposite verdict on the same numbers.
    assert.deepEqual(rechecks[0].kinds_before, ["content_missing", "alt_quality"]);
    assert.deepEqual(rechecks[0].kinds_after, ["alt_quality"]);
  });
});

test("a correction that fixed three of four problems is not the same not-ok as one that fixed none", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    await runExtraction(
      makeCtx(dir, events, {
        html: () => `<p>first pass</p>`,
        problems: (o) =>
          o === 1
            ? [
                "the second column of the table was dropped",
                "the figure has no caption",
                "the heading is a level too deep",
                "the footnote marker has no accessible name",
              ]
            : [],
        corrected: () => `<p>second pass</p>`,
        recheck: () => ["the heading is still a level too deep"],
      }),
    );
    const rechecks = of(events, "page_correction_recheck");
    assert.equal(rechecks.length, 1);
    // Still not ok, and still kept — nothing about the decision changed. What changed is
    // that the log now says the pass got most of the way there, which is the difference
    // between a loop worth its 24% of the bill and one that is not.
    assert.equal(rechecks[0].ok, false);
    assert.equal(rechecks[0].problems_before, 4);
    assert.equal(rechecks[0].problems_after, 1);
    assert.equal(of(events, "page_corrected")[0].result, "kept");
  });
});

test("a missing link is not counted as a problem the second verdict could have cleared", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const link = { text: "the full report", href: "https://example.org/report" };
    await runExtraction(
      makeCtx(dir, events, {
        // Page 1 fails its fidelity check AND lost the link, which is `trigger: "both"` — and
        // it can win the batch's one sample slot, because that branch is guarded on the verify
        // failure alone. Page 2 passed and only lost the link.
        html: () => `<p>Read the full report</p>`,
        problems: (o) => (o === 1 ? ["the figure has no caption"] : []),
        corrected: () => `<p>Read <a href="https://example.org/report">the full report</a></p>`,
        recheck: (o) => (o === 1 ? ["the figure still has no caption"] : []),
        links: [link],
      }),
    );
    const rechecks = of(events, "page_correction_recheck");
    const sampled = rechecks.find((r) => r.binding === false);
    assert.ok(sampled, "the page that failed its check took the sample slot");
    // One fidelity problem in, one out: the correction re-attached the link and fixed nothing
    // the verifier named. Counting the link would have made this two-in-one-out — a loop
    // converging, on a page where it converged on nothing. The second verdict judges the
    // fragment against the image, where a link target does not appear, so it could never have
    // named the link either way.
    assert.equal(sampled.problems_before, 1);
    assert.equal(sampled.problems_after, 1);
    assert.equal(sampled.links_before, 1, "the link share is carried, not folded in");
    // And the links path's own verdict, on a page that had PASSED: nothing was named going in,
    // so a problem named here would be a rewrite that lost something rather than a correction
    // that fell short.
    const binding = rechecks.find((r) => r.binding === true);
    assert.ok(binding);
    assert.equal(binding.problems_before, 0);
    assert.equal(binding.links_before, 1);
  });
});

test("a link-driven correction's own re-verification is logged as the binding one", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const link = { text: "the full report", href: "https://example.org/report" };
    // The page passes its fidelity check but dropped the link, so the correction runs
    // for a reason the Feedback Agent never named — and that path already re-verifies,
    // because a rewrite of a page that had passed has to earn its place.
    const result = await runExtraction(
      makeCtx(dir, events, {
        html: () => `<p>Read the full report</p>`,
        problems: () => [],
        corrected: () => `<p>Read <a href="https://example.org/report">the full report</a></p>`,
        recheck: () => [],
        links: [link],
      }),
    );
    const corrected = of(events, "page_corrected");
    assert.equal(corrected.length, 2, "both pages dropped the link, so both were corrected");
    assert.equal(corrected[0].trigger, "links");
    assert.equal(corrected[0].result, "kept");
    assert.equal(corrected[0].structure_changed, true);
    const rechecks = of(events, "page_correction_recheck");
    // Two, not one: these are not the sample. The links path pays for its own
    // re-verification because it decides whether to keep the rewrite.
    assert.equal(rechecks.length, 2);
    assert.deepEqual(rechecks.map((r) => r.binding), [true, true]);
    assert.match(result.fragments[0].innerHtml, /href="https:\/\/example\.org\/report"/);
  });
});

test("a correction that only re-typed a URL is delivered, not read as buying nothing", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const link = { text: "the full report", href: "https://example.org/report" };
    // The page linked the right words to the wrong URL — a mis-typed href is exactly what
    // the links pass exists to catch, and `missingLinkProblem` asks for the fix that changes
    // "anything else about the page" not at all. So the corrected fragment differs from the
    // original in one attribute value and in nothing else: no word moves, no tag changes,
    // no description changes.
    //
    // Which is why the delivery gate is string identity and not the effect. A signal that
    // could not see attributes would call this correction `identical`, and — because the
    // decision to deliver rode on the same signal — revert the one thing it was asked to
    // fix, silently, on the pass whose whole purpose is that URL.
    const result = await runExtraction(
      makeCtx(dir, events, {
        html: () => `<p>Read <a href="https://example.org/reprot">the full report</a></p>`,
        problems: () => [],
        corrected: () => `<p>Read <a href="https://example.org/report">the full report</a></p>`,
        recheck: () => [],
        links: [link],
      }),
    );
    const corrected = of(events, "page_corrected");
    assert.equal(corrected.length, 2, "both pages missed the link, so both were corrected");
    assert.equal(corrected[0].trigger, "links");
    assert.equal(corrected[0].result, "kept");
    assert.deepEqual(
      {
        t: corrected[0].text_changed,
        a: corrected[0].alt_changed,
        at: corrected[0].attrs_changed,
        s: corrected[0].structure_changed,
      },
      { t: false, a: false, at: true, s: false },
    );
    // And the delivered document carries the URL the source file actually has.
    for (const f of result.fragments) {
      assert.match(f.innerHtml, /href="https:\/\/example\.org\/report"/);
      assert.doesNotMatch(f.innerHtml, /reprot/);
    }
    // Nor is the link reported as still lost, which is the other half of the same bug: that
    // event lives behind the same gate, so a reverted fix would also have gone unmentioned.
    assert.equal(of(events, "page_links_unrecovered").length, 0);
  });
});

test("a page nobody could judge says so on the line that says it passed", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // Verification is non-blocking, and that is not in question here: a verdict the model
    // garbled must never cost a page, so the page ships and the event is still
    // `page_verify_ok` — every reader of this log still counts it as one verified page.
    //
    // What the flag adds is that the two cases stop being the same line. "The verifier looked
    // and was satisfied" and "nobody looked" were indistinguishable in the record, so a run
    // that lost its Feedback Agent halfway through read as a run with an unusually good pass
    // rate, and `verify_failed / pages_verified` was a rate over pages that were never judged
    // (issue #211; the harness in #180 needed the same distinction from outside).
    const result = await runExtraction(
      makeCtx(dir, events, {
        html: () => `<h2>Findings</h2><p>A page that rendered fine.</p>`,
        problems: () => [],
        corrected: () => "",
        verifyGarbles: true,
      }),
    );
    const ok = of(events, "page_verify_ok");
    assert.equal(ok.length, 2, "both pages still pass — verification never breaks a run");
    for (const e of ok) assert.equal(e.unjudged, true);
    assert.equal(of(events, "page_verify_failed").length, 0);
    assert.equal(of(events, "page_corrected").length, 0, "and nothing was corrected, so nothing was paid");
    for (const f of result.fragments) assert.match(f.innerHtml, /A page that rendered fine/);

    // The fold reads it back: two verified pages, neither of them judged. The other half of
    // this is pinned in test/diagnostics.test.ts, over a hand-written log; this is the half
    // that says the pipeline actually writes what that fold reads.
    const d = summarizeRun(
      events.map((e) => JSON.stringify({ ts: new Date(Date.UTC(2026, 0, 1)).toISOString(), ...e })).join("\n"),
      { sessionId: "s", status: "ready_for_review", phase: "done", now: Date.UTC(2026, 0, 1) },
    );
    assert.equal(d.verification.pages_verified, 2);
    assert.equal(d.verification.pages_unjudged, 2);
    assert.equal(d.verification.verify_failed, 0);
  });
});

test("a verdict that describes a defect and passes the page says so on its own line", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The measured case: both flags true, the defect written out in full. `failedCheck` needs a
    // false flag AND a named problem, so the page ships, nothing is corrected, and until this
    // event the sentence was nowhere in the log — `page_verify_ok` carries no `problems`
    // (issue #210: 3 of 30 injected defects were described and passed, which is most of the
    // gap between the 28 the verifier perceived and the 25 it flagged).
    const result = await runExtraction(
      makeCtx(dir, events, {
        html: () => `<p>Payment terms: net 30.</p><p>The standard fee is $5,555.00.</p>`,
        problems: (o) =>
          o === 1
            ? [{ kind: "structure_wrong", problem: "the fee paragraph comes first in the image; the HTML reverses the two" }]
            : [{ kind: "alt_quality", problem: "the chart's description could name the units" }],
        corrected: () => "",
        describesAndPasses: true,
      }),
    );
    // Nothing about the run changes: this event decides nothing and costs nothing.
    assert.equal(of(events, "page_verify_ok").length, 2);
    assert.equal(of(events, "page_verify_failed").length, 0);
    assert.equal(of(events, "page_corrected").length, 0, "a passing verdict buys no correction");
    for (const f of result.fragments) assert.match(f.innerHtml, /Payment terms/);

    const said = of(events, "page_verify_inconsistent");
    assert.equal(said.length, 2);
    assert.equal(said[0].image, "page-001.png");
    assert.deepEqual(said[0].kinds, ["structure_wrong"]);
    assert.equal(said[0].untagged, 0);
    // The prose, because the prose is the finding — a count of it cannot be read back as
    // evidence that the verifier saw the defect.
    assert.match(String((said[0].problems as string[])[0]), /the HTML reverses the two/);
    assert.deepEqual(said[1].kinds, ["alt_quality"]);
    // And a page whose only note is advice is not this bug, which is the whole reason the
    // kinds are on the line: it is one of the two pages, and neither of the two page calls a
    // kind-gated rule would buy.
    const d = summarizeRun(
      events.map((e) => JSON.stringify({ ts: new Date(Date.UTC(2026, 0, 1)).toISOString(), ...e })).join("\n"),
      { sessionId: "s", status: "ready_for_review", phase: "done", now: Date.UTC(2026, 0, 1) },
    );
    assert.equal(d.verification.pages_verified, 2, "both pages passed, and are counted once each");
    assert.equal(d.verification.verify_failed, 0);
    assert.equal(d.verification.verify_inconsistent.pages, 2);
    assert.equal(d.verification.verify_inconsistent.structure_wrong, 1);
    assert.equal(d.verification.verify_inconsistent.alt_quality, 1);
    assert.equal(d.verification.verify_inconsistent.content_or_structure, 1);
  });
});

test("a rewrite nobody could judge says so on the line that keeps it", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const link = { text: "the full report", href: "https://example.org/report" };
    // The dangerous half of the same conflation, and the one that is reachable with no
    // Feedback Agent at all: a page that PASSED its check and lost a link is corrected on the
    // links trigger, and that path's recheck is BINDING — it decides whether the rewrite
    // ships. `ok` there is "the verifier named no problem", which is also what a reply nothing
    // could be read out of returns, so a whole run of kept rewrites read as rewrites that had
    // been checked and found good (issue #211).
    const result = await runExtraction(
      makeCtx(dir, events, {
        html: () => `<p>Read the full report</p>`,
        problems: () => [],
        corrected: () => `<p>Read <a href="https://example.org/report">the full report</a></p>`,
        recheckGarbles: true,
        links: [link],
      }),
    );
    const rechecks = of(events, "page_correction_recheck");
    assert.equal(rechecks.length, 2, "both pages lost the link, so both rewrites were rechecked");
    for (const r of rechecks) {
      assert.equal(r.binding, true);
      // Non-blocking, exactly as before the flag: an unreadable verdict must not discard a
      // rewrite that recovered a link, so `ok` stays true and the page keeps the correction.
      assert.equal(r.ok, true);
      assert.equal(r.unjudged, true);
    }
    assert.equal(of(events, "page_links_correction_rejected").length, 0);
    for (const f of result.fragments) assert.match(f.innerHtml, /href="https:\/\/example\.org\/report"/);

    // And the fold reads it back: two binding rechecks, both nominally ok, neither judged —
    // so the judged pass rate is 0 of 0 rather than 2 of 2.
    const d = summarizeRun(
      events.map((e) => JSON.stringify({ ts: new Date(Date.UTC(2026, 0, 1)).toISOString(), ...e })).join("\n"),
      { sessionId: "s", status: "ready_for_review", phase: "done", now: Date.UTC(2026, 0, 1) },
    );
    assert.equal(d.verification.rechecks.binding, 2);
    assert.equal(d.verification.rechecks.binding_ok, 2);
    assert.equal(d.verification.rechecks.binding_unjudged, 2);
    assert.equal(d.verification.rechecks.sampled, 0);
  });
});

test("a provider error on the sample costs the measurement, not the page", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The sampled recheck is one more Feedback Agent call, and `verifyAgentOutput` is
    // non-blocking only for an absent agent and an unparseable reply — a provider error is
    // rethrown. Uncaught, it would leave extractPage through the per-page catch and ship a
    // `@page-failed` marker for a page that had rendered, verified AND corrected: a whole
    // page of accessible content lost to a measurement that decides nothing.
    const result = await runExtraction(
      makeCtx(dir, events, {
        html: () => `<p>first pass</p>`,
        problems: () => ["a figure is missing its caption"],
        corrected: (o) => `<p>first pass</p><figcaption>Figure ${o}</figcaption>`,
        recheckThrows: true,
      }),
    );
    // Both pages are delivered, corrected, and neither carries a failure marker.
    assert.equal(result.failedPages.length, 0);
    for (const f of result.fragments) assert.match(f.innerHtml, /<figcaption>/);
    assert.doesNotMatch(result.fragments.map((f) => f.innerHtml).join(""), /@page-failed/);
    // The sample is recorded as not taken, rather than silently absent, and there is no
    // verdict for it.
    const missed = of(events, "page_correction_recheck_failed");
    assert.equal(missed.length, 1);
    assert.match(String(missed[0].error), /ThrottlingException/);
    assert.equal(of(events, "page_correction_recheck").length, 0);
    // And the slot stays spent: a throttled provider is not asked again for every
    // corrected page in the batch.
    assert.equal(of(events, "page_corrected").length, 2);
  });
});

// --- a check that cannot answer may not delete the page it was checking (issue #364) ---------

test("a verify call that overruns its ceiling keeps the page it was judging", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The worst reach of the same defect, and the one the two tests above do not cover: they
    // guard the calls a CORRECTED page makes, and this is the call every page in every run
    // makes. Uncaught, a provider error on the fidelity check left `extractPage` through the
    // per-page catch and shipped a `@page-failed` comment for a page whose extraction had
    // succeeded and was sitting in a local variable — measured once as 8,855 characters of a
    // statistical table delivered as 156 bytes, where $0.5051 of the page's $0.6634 was the
    // call that deleted it.
    const page = `<h2>Table 4</h2><table><tr><th>State</th><td>Illinois</td></tr></table>`;
    const result = await runExtraction(
      makeCtx(dir, events, {
        html: () => page,
        problems: () => ["never reached"],
        corrected: () => `<p>never reached</p>`,
        verifyThrows: () => new TruncatedResponseError("bedrock", "some-model", 32_000, TRUNCATED_REPLY),
      }),
    );
    // The page is delivered, whole and unmarked. This is the assertion the issue is about:
    // everything below is about being able to say WHY, and this is the content.
    assert.equal(result.failedPages.length, 0);
    for (const f of result.fragments) assert.equal(f.innerHtml, page);
    assert.doesNotMatch(result.fragments.map((f) => f.innerHtml).join(""), /@page-failed/);
    // And no correction is bought: an unobtainable verdict is a fidelity check that did not
    // run, and a check that did not run names nothing to correct. So the page ships exactly as
    // it would have with no Feedback Agent configured at all, which is what the rest of this
    // file already guarantees for that configuration.
    assert.equal(of(events, "page_corrected").length, 0);
    assert.equal(of(events, "page_extraction_failed").length, 0);
    // The failure is on the record with the evidence, under its own name — `page_verify_failed`
    // is already taken by a verdict that named problems, which is the opposite of this.
    const errs = of(events, "page_verify_error");
    assert.equal(errs.length, 2);
    for (const e of errs) {
      assert.equal(e.step, "verify");
      assert.match(String(e.error), /truncat/i);
      // The shape with a configuration remedy, named rather than left to be read out of the
      // message, and both ends of the reply — which is what says whether the ceiling was too
      // tight or the verifier wrote an essay about a page it had already judged. The round
      // cannot be asked again: a truncation has already been billed for a full ceiling.
      assert.equal(e.truncated, true);
      assert.equal(e.reply_chars, TRUNCATED_REPLY.length);
    }
    // The page is countable beside the others without reading two event streams, and it is
    // counted as the kind of unjudged that COST money rather than the kind that saved it.
    const oks = of(events, "page_verify_ok");
    assert.equal(oks.length, 2);
    for (const o of oks) {
      assert.equal(o.unjudged, true);
      assert.equal(o.skipped, "error");
    }
    // Which the fold reads back nested, so nothing published moves: both pages are still
    // `pages_verified`, still `pages_unjudged`, and the judged pass rate is 0 of 0.
    const d = summarizeRun(
      events.map((e) => JSON.stringify({ ts: new Date(Date.UTC(2026, 0, 1)).toISOString(), ...e })).join("\n"),
      { sessionId: "s", status: "ready_for_review", phase: "done", now: Date.UTC(2026, 0, 1) },
    );
    assert.equal(d.verification.pages_verified, 2);
    assert.equal(d.verification.pages_unjudged, 2);
    assert.equal(d.verification.pages_verify_error, 2);
    // And it is NOT the blank skip. The two point opposite ways in money — a blank page's call
    // is not made and is a saving, this one was billed for a full ceiling and answered with
    // nothing — so a reader adding them together would price a loss as a saving.
    assert.equal(d.verification.pages_skipped_blank, 0);
    assert.equal(d.verification.verify_failed, 0);
    assert.deepEqual(d.pages_failed, []);
    // And the first check's failure is counted ONCE. `page_verify_error` and `page_verify_ok` both
    // fire for it, so the fold matches `step` strictly rather than reading "not the recheck" — a
    // `binding_error` here would be this page counted twice under two names.
    assert.equal(d.verification.rechecks.binding_error, 0);
  });
});

test("a throttled verify is unjudged for its own reason, not the blank one", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The other shape, which is the commoner one: a throttle has no reply to quote, so `error`
    // is the whole of what is known about it and the truncation fields are absent rather than
    // false. Asserted because `truncationEvidence` spreads nothing for a plain Error, and a
    // `truncated: false` here would read as a measurement that the ceiling was fine.
    const result = await runExtraction(
      makeCtx(dir, events, {
        html: () => `<p>Kept</p>`,
        problems: () => ["never reached"],
        corrected: () => `<p>never reached</p>`,
        verifyThrows: () => new Error("ThrottlingException: Too many requests"),
      }),
    );
    assert.equal(result.failedPages.length, 0);
    const errs = of(events, "page_verify_error");
    assert.equal(errs.length, 2);
    for (const e of errs) {
      assert.match(String(e.error), /ThrottlingException/);
      assert.equal("truncated" in e, false);
      assert.equal("reply_chars" in e, false);
    }
    // A run being throttled reads, on a log written before this event existed, as a run whose
    // vision was failing — the failure took the page with it and was recorded as an extraction
    // failure. That is the misattribution the count exists to end.
    const d = summarizeRun(
      events.map((e) => JSON.stringify({ ts: new Date(Date.UTC(2026, 0, 1)).toISOString(), ...e })).join("\n"),
      { sessionId: "s", status: "ready_for_review", phase: "done", now: Date.UTC(2026, 0, 1) },
    );
    assert.equal(d.verification.pages_verify_error, 2);
    assert.deepEqual(d.pages_failed, []);
  });
});

test("an unobtainable binding recheck discards the correction and keeps the page that passed", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    const link = { text: "the full report", href: "https://example.org/report" };
    // The second unguarded call site, which is not in the issue's report and costs MORE when it
    // fires: this page rendered, PASSED its fidelity check, and was corrected, so a throw here
    // threw away two calls' work instead of one, by the same route into the per-page catch.
    //
    // Where its verdict cannot be obtained the correction is DISCARDED, which is a decision and
    // not a default. This recheck is the gate on changing a page that had already passed — the
    // page is being re-rendered only to attach one link — so no verdict is no licence, and the
    // status quo is the fragment that passed. It is also the same answer this branch gives a
    // verdict that fails.
    const page = `<h2>Progress</h2><p>Read the full report for the 2026 figures.</p>`;
    const corrected = `<h2>Progress</h2><p>Read <a href="https://example.org/report">the full report</a> for the 2026 figures.</p>`;
    const result = await runExtraction(
      makeCtx(dir, events, {
        html: () => page,
        problems: () => [],
        corrected: () => corrected,
        recheckThrows: true,
        links: [link],
      }),
    );
    // The page that passed is what ships, byte for byte, and the link stays missing — which is
    // the trade this branch was written to make: recovering a target may not cost a page the
    // accessibility it already had.
    assert.equal(result.failedPages.length, 0);
    for (const f of result.fragments) assert.equal(f.innerHtml, page);
    assert.doesNotMatch(result.fragments.map((f) => f.innerHtml).join(""), /href="https:\/\/example\.org\/report"/);
    assert.equal(of(events, "page_extraction_failed").length, 0);
    // The correction was billed, so the discard is on the record rather than inferred from an
    // absent rejection line, and `trigger` says which repair the money bought nothing for.
    const errs = of(events, "page_verify_error");
    assert.equal(errs.length, 2);
    for (const e of errs) {
      assert.equal(e.step, "recheck_binding");
      assert.equal(e.correction_discarded, true);
      assert.equal(e.trigger, "links");
      assert.match(String(e.error), /ThrottlingException/);
    }
    // And the rejection event does NOT fire: it reports what the second verdict said was wrong,
    // and there is no second verdict. A line claiming problems it never read would be worse than
    // no line, which is why the discard has an event of its own.
    assert.equal(of(events, "page_links_correction_rejected").length, 0);
    // The FIRST verdict stands and is a real one — this page passed. So the failure here is not
    // an unjudged page: the fold must not count it as one, or a run whose rechecks were
    // throttled would read as a run nothing verified.
    const oks = of(events, "page_verify_ok");
    assert.equal(oks.length, 2);
    for (const o of oks) {
      assert.equal("unjudged" in o, false);
      assert.equal("skipped" in o, false);
    }
    const d = summarizeRun(
      events.map((e) => JSON.stringify({ ts: new Date(Date.UTC(2026, 0, 1)).toISOString(), ...e })).join("\n"),
      { sessionId: "s", status: "ready_for_review", phase: "done", now: Date.UTC(2026, 0, 1) },
    );
    assert.equal(d.verification.pages_verified, 2);
    // NOT unjudged, and NOT `pages_verify_error`: that count is nested inside `pages_unjudged`, and
    // this page has a real first verdict which it passed. Counting it there would put a judged page
    // inside the unjudged total and move the rate the nesting exists to protect. Review round 1
    // caught the README claiming otherwise while this assertion said the opposite.
    assert.equal(d.verification.pages_unjudged, 0);
    assert.equal(d.verification.pages_verify_error, 0);
    // Which is why it needs a number of its own, and this is it. Without it the page reached NO
    // counter anywhere — `binding` and `failures` come off `page_correction_recheck`, which does not
    // fire when there is no verdict, and `errors` needs an `ok: false` this event does not carry —
    // so the more expensive of the two failure shapes was the silent one.
    assert.equal(d.verification.rechecks.binding_error, 2);
    // Disjoint from the verdict-fed fields rather than a subset of them, so the judged-only rate
    // `(binding_ok - binding_unjudged) / (binding - binding_unjudged)` is untouched by it.
    assert.equal(d.verification.rechecks.binding, 0);
    assert.equal(d.verification.rechecks.binding_ok, 0);
    assert.equal(d.verification.rechecks.failures.length, 0);
    // And the only other trace it has, which is why the count is worth having: a `rejected` pooled
    // with the shrink floor and with a rewrite a second verdict genuinely refused.
    const corrected2 = of(events, "page_corrected");
    assert.equal(corrected2.length, 2);
    for (const c of corrected2) assert.equal(c.result, "rejected");
  });
});

test("a page that passed and kept its links costs no correction and no event", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    await runExtraction(
      makeCtx(dir, events, {
        html: () => `<p>Clean</p>`,
        problems: () => [],
        corrected: () => `<p>should never be asked for</p>`,
      }),
    );
    assert.equal(of(events, "page_verify_ok").length, 2);
    assert.equal(of(events, "page_corrected").length, 0);
    assert.equal(of(events, "page_correction_recheck").length, 0);
  });
});
