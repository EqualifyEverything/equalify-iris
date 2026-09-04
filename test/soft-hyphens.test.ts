import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExtraction } from "../src/pipeline/extraction.ts";
import { stripSoftHyphens } from "../src/util/html.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// A word the printing broke across a column, carried into the markup as U+00AD (issue #334).
// `agents/page.md` forbids it in as many words, with a worked example, and three models from three
// different labs do it anyway — 63 occurrences on 9 pages of one 100-page arm, reaching 23 of 62
// delivered documents, on pages Iris's own fidelity check passed.
//
// What makes it worth code rather than more prose is that it is decidable with no image, no word
// list and no second model: there is no output where a soft hyphen is the right answer. It is also
// the quieter of the two ways a model can get this wrong. The visible version (`Govern-ment`) is at
// least on screen; this one renders as nothing, so the page reads as clean while find-in-page
// silently fails — and the words it lands on are table row labels and column headings, which are the
// words a reader searches for.
//
// EVERY SOFT HYPHEN IN THIS FILE IS WRITTEN `\u00ad`, never as the character. A test whose
// expectation is an invisible character is a test the next reader cannot check, and a stray copy of
// one pasted into a fixture would make the strip look like it had found something real.
const SHY = "\u00ad";

test("every spelling a model can write a soft hyphen in, and nothing else", () => {
  // The raw character and the three entity forms, because a strip that reads only the codepoint
  // leaves `&shy;` in the markup — where it renders the same way and defeats find-in-page the same
  // way. Leading zeros and case are both legal.
  const cases = [`a${SHY}b`, "a&shy;b", "a&SHY;b", "a&#173;b", "a&#0173;b", "a&#xad;b", "a&#xAD;b", "a&#X00Ad;b"];
  for (const one of cases) {
    assert.deepEqual(stripSoftHyphens(one), { html: "ab", removed: 1 }, one);
  }
});

test("what a soft-hyphen strip must not touch", () => {
  // A hyphen the word itself owns, and the one the page prompt says to keep at a page's edge.
  assert.deepEqual(stripSoftHyphens("non-tax"), { html: "non-tax", removed: 0 });
  // The literal text `&shy;`, which is what a page ABOUT html entities prints. The `&` is consumed
  // by `amp`, so there is no `&` left immediately before `shy;` for the pattern to match — asserted
  // rather than reasoned about, because getting it wrong deletes visible content from a real page.
  assert.deepEqual(stripSoftHyphens("<code>&amp;shy;</code>"), { html: "<code>&amp;shy;</code>", removed: 0 });
  // `&shy` with no semicolon is legal HTML5 and deliberately NOT matched: requiring the semicolon is
  // what keeps the line above safe from a `&amp;shy` one character shorter.
  assert.deepEqual(stripSoftHyphens("a&shyb"), { html: "a&shyb", removed: 0 });
  // Not a soft hyphen: the hyphen-minus, the non-breaking hyphen, and the zero-width space a model
  // reaching for an invisible break might use instead. Out of scope on purpose — this issue is about
  // one character, and each of those has its own argument.
  assert.deepEqual(stripSoftHyphens("a-b\u2011c\u200bd"), { html: "a-b\u2011c\u200bd", removed: 0 });
  // An href, which is the attribute where a false positive would cost something rather than just be
  // wrong: `normalizeHref` compares a page's links against the ones poppler reported, so a character
  // taken out of a URL reads as a link the page dropped and buys a correction pass for a page that had
  // nothing wrong with it. A query string's escaped ampersand is the shape that comes closest, and it
  // is safe for the same reason `&amp;shy;` is.
  const href = `<a href="?y=2026&amp;q=1">report</a>`;
  assert.deepEqual(stripSoftHyphens(href), { html: href, removed: 0 });
});

test("a soft hyphen inside an attribute goes, href included", () => {
  // Deliberate, and it costs nothing: these are the entity spellings, so a browser resolving that
  // href would put U+00AD into the URL it requests. No URL carries one, which makes it a
  // transcription error either way, and leaving one in an `alt` would defeat the same search the
  // visible text is being repaired for.
  assert.deepEqual(stripSoftHyphens(`<img alt="Insur&#173;ance" src="a&shy;.png">`), {
    html: `<img alt="Insurance" src="a.png">`,
    removed: 2,
  });
});

test("the count is every occurrence, not every page that had one", () => {
  const { html, removed } = stripSoftHyphens(`Commu${SHY}nications and Govern&shy;ment and Insur&#173;ance`);
  assert.equal(html, "Communications and Government and Insurance");
  assert.equal(removed, 3);
});

// --- The seams -------------------------------------------------------------------------------
//
// Four calls in the extraction phase turn a model's reply into markup Iris keeps, and the strip is on
// all four rather than once on the way out of the phase. The reason is that a page's own output is an
// INPUT further along: the first render is what the correction pass is shown as "your previous
// output" and what the specialist merge is shown as the current page. Strip only at the exit and the
// model is handed its own soft hyphen back, together with an instruction to carry over everything the
// problem list does not name exactly as it stands.

interface Recorded {
  events: { type: string; data: Record<string, unknown> }[];
}

interface Spec {
  // The first render's fragment.
  render: string;
  // The reply's `log` and `blank` field, for the one test about a page the model says is empty.
  log?: string;
  blank?: boolean;
  // Present means the fidelity check rejects the page, which buys the one correction pass.
  problems?: string[];
  // What that pass answers with.
  correction?: string;
  // Present means the render asks for the chart specialist, which buys a specialist call and a
  // merge call.
  specialist?: { fragment: string; merged: string };
}

const ORDINARY = `<h2>Page 1</h2><p>${"content ".repeat(20)}</p>`;
const COMPANION = `<h2>Page 2</h2><p>${"other ".repeat(20)}</p>`;

// Page 1 behaves as `spec` says. `companion` adds an ordinary second page, which the one test whose
// page produces nothing needs: a run where NO page produced content throws by design rather than
// containing the failure, so a lost page can only be observed next to a page that worked.
//
// `feedback.md` is written only when the spec needs a verdict: without it `verifyAgentOutput`
// short-circuits to the unjudged verdict, no page is ever rejected, and no correction pass runs.
function makeCtx(dir: string, spec: Spec, companion = false): { ctx: PipelineContext; rec: Recorded } {
  const agentsDir = join(dir, "agents");
  const fragDir = join(dir, "fragments");
  const inputDir = join(dir, "input");
  for (const d of [agentsDir, fragDir, inputDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
  writeFileSync(join(agentsDir, "chartDataAgent.md"), "# Chart Agent\n\n## Required capability\nvision\n");
  if (spec.problems) writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\nvision\n");
  writeFileSync(join(inputDir, "page-001.png"), "not-a-real-png");
  if (companion) writeFileSync(join(inputDir, "page-002.png"), "not-a-real-png");
  const images = [{ name: "page-001.png", order: 1, path: join(inputDir, "page-001.png") }];
  if (companion) images.push({ name: "page-002.png", order: 2, path: join(inputDir, "page-002.png") });

  const rec: Recorded = { events: [] };
  const ctx = {
    sessionId: "ses_test",
    images,
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
      complete: async (
        _agent: string,
        _cap: string,
        messages: { role: string; content: string }[],
        opts?: { step?: string },
      ) => {
        const sys = messages.find((m) => m.role === "system")?.content ?? "";
        const prompt = messages.map((m) => m.content).join("\n");
        const step = opts?.step;
        if (prompt.includes("filename: page-002.png")) return { text: JSON.stringify({ html: COMPANION, log: "" }) };
        if (step === "verify" || step === "recheck_binding" || step === "recheck_sampled") {
          const problems = step === "verify" ? (spec.problems ?? []) : [];
          return { text: JSON.stringify({ faithful: problems.length === 0, accessible: true, problems }) };
        }
        if (step === "correct") return { text: JSON.stringify({ html: spec.correction ?? ORDINARY }) };
        if (step === "specialist") {
          return { text: JSON.stringify({ no_content: false, html: spec.specialist!.fragment }) };
        }
        if (sys.includes("You merge a higher-fidelity HTML fragment")) {
          return { text: JSON.stringify({ html: spec.specialist!.merged }) };
        }
        return {
          text: JSON.stringify({
            html: spec.render,
            log: spec.log ?? "",
            ...(spec.blank === undefined ? {} : { blank: spec.blank }),
            ...(spec.specialist ? { suggested_agent: { name: "chartDataAgent", reason: "a chart" } } : {}),
          }),
        };
      },
    },
    log: {
      event: (type: string, data: Record<string, unknown> = {}) => rec.events.push({ type, data }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
  return { ctx, rec };
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iris-shy-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ev = (rec: Recorded, type: string) => rec.events.filter((e) => e.type === type);

test("the first render's soft hyphens never reach the fragment, in text or in an attribute", async () => {
  await withTemp(async (dir) => {
    // The shape the census found: table column headings set in narrow columns, one of them broken
    // inside an `alt`. The attribute matters as much as the text — a soft hyphen there defeats the
    // same search, and it is announced by whatever the screen reader makes of it.
    const render =
      `<h2>Commu${SHY}nications</h2>` +
      `<p>Govern&shy;ment and agri&#173;culture and manu&#xAD;facturing ${"content ".repeat(20)}</p>` +
      `<p><img src="chart.png" alt="Insur${SHY}ance by state"></p>`;
    const { ctx, rec } = makeCtx(dir, { render });
    const { fragments } = await runExtraction(ctx);

    assert.equal(
      fragments[0].innerHtml,
      `<h2>Communications</h2>` +
        `<p>Government and agriculture and manufacturing ${"content ".repeat(20)}</p>` +
        `<p><img src="chart.png" alt="Insurance by state"></p>`,
    );
    assert.deepEqual(ev(rec, "page_soft_hyphens").map((e) => e.data), [
      { image: "page-001.png", page: 1, where: "extract", removed: 5 },
    ]);
  });
});

test("a page with none of them says nothing about it", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = makeCtx(dir, { render: ORDINARY });
    const { fragments } = await runExtraction(ctx);
    assert.equal(fragments[0].innerHtml, ORDINARY);
    // So a run with no line of this kind is a run where no reply carried one, rather than a run
    // where the count happened to be written as zero.
    assert.deepEqual(ev(rec, "page_soft_hyphens"), []);
  });
});

test("the correction pass is stripped too, and the strip runs before its reply is compared", async () => {
  await withTemp(async (dir) => {
    // The correction reply is the page it was given, plus soft hyphens: a pass that repaired nothing
    // and re-typed two words on its way past. Adopted as a string, it would be `moved` — the
    // rejected page shipping with an invisible defect added, and #328's marker not fired, because
    // something DID change. Stripped first, it is what it actually is: identical.
    const { ctx, rec } = makeCtx(dir, {
      render: ORDINARY,
      problems: ["The table on this page lost its six aggregate rows."],
      correction: ORDINARY.replace("Page 1", `Page${SHY} 1`).replace("content ", "con&shy;tent "),
    });
    const { fragments, uncorrectedPages } = await runExtraction(ctx);

    assert.equal(fragments[0].innerHtml, ORDINARY, "the correction's soft hyphens are not in the page");
    assert.deepEqual(ev(rec, "page_soft_hyphens").map((e) => e.data), [
      { image: "page-001.png", page: 1, where: "correct", removed: 2 },
    ]);
    assert.equal(ev(rec, "page_corrected")[0].data.result, "identical");
    assert.deepEqual(uncorrectedPages, [1], "a pass that only added soft hyphens repaired nothing");
  });
});

test("both specialist seams are stripped", async () => {
  await withTemp(async (dir) => {
    // The specialist fragment is stripped where it is read, before it goes into the merge prompt, so
    // the merge agent is never shown one to copy — and the merge reply is stripped as well, because a
    // merge agent re-typing a word it is joining is the same transcription step that produces these.
    const { ctx, rec } = makeCtx(dir, {
      render: ORDINARY,
      specialist: {
        fragment: `<table><caption>Compos&shy;ite index</caption><tr><td>1</td></tr></table>`,
        merged: `${ORDINARY}<table><caption>Compos${SHY}ite index</caption><tr><td>col&#173;lections</td></tr></table>`,
      },
    });
    const { fragments } = await runExtraction(ctx);

    assert.equal(
      fragments[0].innerHtml,
      `${ORDINARY}<table><caption>Composite index</caption><tr><td>collections</td></tr></table>`,
    );
    assert.deepEqual(ev(rec, "page_soft_hyphens").map((e) => e.data), [
      { image: "page-001.png", page: 1, where: "specialist", removed: 1 },
      { image: "page-001.png", page: 1, where: "specialist_merge", removed: 2 },
    ]);
  });
});

test("a fragment whose only text is soft hyphens is a page with nothing on it", async () => {
  await withTemp(async (dir) => {
    // The reason the strip is ahead of the emptiness check rather than after it. U+00AD is not
    // whitespace to `visibleText`, so `<p>\u00ad</p>` reads as a page with content on it: without
    // the strip in front, this run reports a page delivered and the document carries an empty
    // paragraph. Stripped first, it is the failure it is, and the run says the page is lost.
    const { ctx, rec } = makeCtx(dir, { render: `<p>${SHY}${SHY}</p>` }, true);
    const { fragments, failedPages } = await runExtraction(ctx);

    assert.deepEqual(failedPages, [1]);
    assert.match(fragments[0].innerHtml, /@page-failed 1:/, "and the document says the page is missing");
    assert.equal(ev(rec, "page_no_output").length, 1);
    // Counted before it was discarded, so a page lost this way is still attributable.
    assert.deepEqual(ev(rec, "page_soft_hyphens").map((e) => e.data.removed), [2]);
  });
});

test("...unless the reply SAID the page is empty, in which case it is a blank page and not a lost one", async () => {
  await withTemp(async (dir) => {
    // The same reply as the test above plus a declaration, and the distinction the whole no-content
    // branch exists to keep: a failed page is work to redo, a blank page is nothing to do. The
    // emptiness gate reads the stripped markup and `blankDeclaration` re-derives the same reading
    // from the reply, so the two have to be handed the same fragment — given the raw one it answers
    // "this carries content", refuses the declaration, and a page the model correctly reported empty
    // comes out as a page that FAILED.
    const { ctx, rec } = makeCtx(
      dir,
      { render: `<p>${SHY}${SHY}</p>`, log: "This page is blank.", blank: true },
      true,
    );
    const { failedPages } = await runExtraction(ctx);

    assert.deepEqual(failedPages, [], "declared blank, so nothing was lost");
    assert.equal(ev(rec, "page_no_output").length, 0);
    assert.equal(ev(rec, "page_blank").length, 1);
    // And the markup on that line is the RAW reply: the field says which shape the declaration
    // arrived in, which is a fact about what the model sent and not about what Iris did next.
    assert.equal(ev(rec, "page_blank")[0].data.dropped, `<p>${SHY}${SHY}</p>`);
  });
});
