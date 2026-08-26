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
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";
import type { PdfLink } from "../src/util/pdf.ts";
import { TruncatedResponseError } from "../src/providers/types.ts";

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
  // A provider error on the CORRECTION call itself: the output ceiling, a stall, a throttle.
  // Not per page, unlike the rest of these — the correction prompt does not carry the page's
  // filename (it carries the page's own previous output), so `orderOf` cannot see which page
  // is being corrected. Tests that want one page to fail give only that page a problem.
  correctionThrows?: () => Error;
  links?: PdfLink[];
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
          if (n > 1 && b.recheckThrows) throw new Error("ThrottlingException: Too many requests");
          const problems = n === 1 ? b.problems(order) : (b.recheck ?? (() => []))(order);
          return {
            text: JSON.stringify({
              faithful: problems.length === 0,
              accessible: true,
              problems,
            }),
          };
        }
        if (user.includes("had fidelity/accessibility problems")) {
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
        correctionThrows: () => new TruncatedResponseError("bedrock", "some-model", 32000, 93039),
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
        correctionThrows: () => new TruncatedResponseError("bedrock", "some-model", 32000, 93039),
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
