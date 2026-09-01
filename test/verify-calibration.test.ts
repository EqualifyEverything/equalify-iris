// Issue #180: nothing tests whether the fidelity verifier discriminates. Four independent
// measurements put its rejection rate near four pages in five, and the verdict cannot tell
// us whether that is four bad pages or one eager judge. `src/pipeline/calibration.ts` asks
// from outside: damage one thing in a copy of a page the verifier passed, and put both
// copies back to it against the same image.
//
// This file tests the parts of that harness that are code — the injectors and the runner —
// because they are what a reported number depends on. Two failure modes matter more than
// the rest and are pinned hardest:
//
//   1. An injector that silently changes nothing. Its damaged copy is identical to the
//      clean one, the verifier rightly passes it, and the report says the verifier missed a
//      defect it was never shown. That is a false accusation of the thing being measured,
//      so every injector's contract is "a different string or null, never its input".
//   2. Counting a call that produced no judgement as a pass. `verifyAgentOutput` answers
//      ok=true when there is no Feedback Agent, nothing to verify, or an unparseable reply,
//      because verification must never cost a page. A rate computed over `ok` therefore
//      counts "could not look" as "looked and approved" — which would understate exactly
//      the number this harness exists to measure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import {
  DEFECTS,
  DEFECT_IDS,
  calibrateVerifier,
  formatCalibration,
  type CalibrationPage,
} from "../src/pipeline/calibration.ts";
import { VERIFY_KINDS, verifyAgentOutput } from "../src/pipeline/feedback.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";
import { loadAgent } from "../src/agents/loader.ts";
import { passedImages } from "../src/tools/calibrate.ts";

const defect = (id: string) => {
  const d = DEFECTS.find((x) => x.id === id);
  assert.ok(d, `no such defect: ${id}`);
  return d;
};

// The words of a fragment, in order, so a test can say what a defect did to the text
// without depending on the whitespace jsdom serialized. Text nodes are joined with a space
// rather than read off `textContent`, which runs adjacent cells together: `<td>North</td>`
// beside `<td>120</td>` is two words and not "North120".
function words(html: string): string[] {
  const doc = new JSDOM(`<body>${html}</body>`, { virtualConsole: new VirtualConsole() }).window.document;
  const out: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) out.push(...(node.textContent ?? "").split(/\s+/).filter(Boolean));
    else for (const child of Array.from(node.childNodes)) walk(child);
  };
  walk(doc.body);
  return out;
}

// The fragment as jsdom re-serializes it, untouched. This and not the raw input is the
// string an injector has to differ from: parsing alone rewrites a fragment — a `<table>`
// without `<tbody>` gains one, `&mdash;` becomes an em dash, attribute quoting is
// normalized — so an injector that mutated nothing still returns something unequal to its
// input, and a test comparing against the input would pass it.
function reserialize(html: string): string {
  return new JSDOM(`<body>${html}</body>`, { virtualConsole: new VirtualConsole() }).window.document.body.innerHTML;
}

function count(html: string, selector: string): number {
  const doc = new JSDOM(`<body>${html}</body>`, { virtualConsole: new VirtualConsole() }).window.document;
  return doc.querySelectorAll(selector).length;
}

// A page with one of everything the defect list needs: a table with a header and three data
// rows, two headings a level apart, two consecutive paragraphs, an image with alt text, and
// enough top-level blocks that a third of them is a meaningful truncation.
const RICH = `<h1>Quarterly Report</h1>
<p>The first paragraph of the summary.</p>
<p>The second paragraph of the summary.</p>
<h2>Totals</h2>
<table><thead><tr><th>Region</th><th>Units</th></tr></thead><tbody>
<tr><td>North</td><td>120</td></tr>
<tr><td>South</td><td>85</td></tr>
<tr><td>East</td><td>43</td></tr>
</tbody></table>
<img src="chart.png" alt="A bar chart of units by region">
<p>A closing note.</p>`;

test("every defect on the list is one the verifier's contract can name", () => {
  // The `expects` kinds are the weaker signal the report calls "named", and a kind outside
  // `VERIFY_KINDS` would never match a real verdict — so the report would read as a
  // verifier that failed to tag rather than as this list naming a kind that does not
  // exist. calibration.ts throws at import if this drifts; this says so out loud.
  assert.ok(DEFECTS.length >= 8, "the issue's fixed list");
  assert.deepEqual(DEFECT_IDS, DEFECTS.map((d) => d.id));
  assert.equal(new Set(DEFECT_IDS).size, DEFECT_IDS.length, "ids are unique");
  for (const d of DEFECTS) {
    assert.ok(d.expects.length > 0, `${d.id} predicts at least one kind`);
    for (const kind of d.expects) {
      assert.ok(VERIFY_KINDS.includes(kind), `${d.id} expects ${kind}, which VERIFY_KINDS defines`);
    }
    assert.ok(d.what.trim().length > 0, `${d.id} says what it did`);
  }
});

test("no injector ever returns its input unchanged", () => {
  // The failure mode that would libel the verifier. Run every defect over a spread of page
  // shapes — including ones it does not apply to — and require each result to be either a
  // genuinely different string or null.
  const shapes = [
    RICH,
    "<p>Only prose here.</p>",
    "",
    "   ",
    "<table><tr><th>Only</th><th>Headers</th></tr></table>",
    "<table><tr><td>One</td><td>row</td></tr></table>",
    "<h1>Just a heading</h1>",
    "<h6>Lowest heading</h6>",
    '<img src="a.png" alt="">',
    '<img src="a.png">',
    "<p>a</p><h2>b</h2>",
    "<main><p>one</p><p>two</p><p>three</p><p>four</p></main>",
    "<div><p>wrapped alone</p></div>",
    "<p>2019 in prose, not a cell</p>",
    "<table><tr><td>no digits</td></tr><tr><td>none here</td></tr></table>",
    // Two paragraphs that read the same, in a fragment jsdom rewrites on the way through
    // (no `<tbody>`, an entity). Swapping them is a no-op a reader could never notice, and
    // comparing the result against the raw input would call it a defect anyway.
    "<p>(continued)</p><p>(continued)</p><table><tr><td>7 &mdash; 8</td></tr></table>",
    "<p>same</p>\n<p>same</p>",
    "<p></p><p>after an empty one</p>",
  ];
  for (const d of DEFECTS) {
    for (const html of shapes) {
      const out = d.damage(html);
      if (out === null) continue;
      // Against the re-serialized clean parse, not `html`: the point is the mutation, and
      // an injector that only parsed the page must come back null.
      assert.notEqual(out, reserialize(html), `${d.id} changed nothing for: ${html.slice(0, 40)}`);
      assert.ok(out.trim().length > 0, `${d.id} returned blank for: ${html.slice(0, 40)}`);
    }
  }
});

test("parsing alone is not damage: the injectors compare against their own clean parse", () => {
  // The bug this pins: jsdom's serialization of an untouched fragment differs from the
  // fragment, so `out !== original` is satisfied by doing nothing at all. Here every
  // difference below is jsdom's, so every injector that finds nothing to change must return
  // null — and one that returns a string must have changed something jsdom did not.
  const rewritten = "<table><tr><td>7 &mdash; 8</td></tr><tr><td>9</td></tr></table>";
  assert.notEqual(reserialize(rewritten), rewritten, "the fixture is one jsdom rewrites");
  for (const d of DEFECTS) {
    const out = d.damage(rewritten);
    if (out === null) continue;
    assert.notEqual(out, reserialize(rewritten), `${d.id} returned a parse rather than a mutation`);
  }
});

test("drop_table_row removes one data row and leaves the table readable", () => {
  const out = defect("drop_table_row").damage(RICH);
  assert.ok(out);
  assert.equal(count(out, "tbody tr"), 2);
  assert.equal(count(out, "table"), 1);
  assert.equal(count(out, "thead th"), 2, "the header row is not what this defect drops");
  assert.ok(!words(out).includes("East"), "the last data row's words are gone");
  assert.ok(words(out).includes("North"));

  // A table with one data row is declined rather than emptied: a header with nothing under
  // it is a different defect, and "drop the whole table" tests that one properly.
  assert.equal(defect("drop_table_row").damage("<table><tr><th>A</th></tr><tr><td>1</td></tr></table>"), null);
  // A header-only table has no data row at all.
  assert.equal(defect("drop_table_row").damage("<table><tr><th>A</th><th>B</th></tr></table>"), null);
});

test("drop_table removes the table and nothing else", () => {
  const out = defect("drop_table").damage(RICH);
  assert.ok(out);
  assert.equal(count(out, "table"), 0);
  for (const w of ["Quarterly", "Totals", "closing"]) assert.ok(words(out).includes(w), `kept ${w}`);
  for (const w of ["North", "South", "East", "120"]) assert.ok(!words(out).includes(w), `dropped ${w}`);
  assert.equal(defect("drop_table").damage("<p>no table</p>"), null);
});

test("change_cell_number changes exactly one number and keeps every word", () => {
  const out = defect("change_cell_number").damage(RICH);
  assert.ok(out);
  const before = words(RICH);
  const after = words(out);
  assert.equal(before.length, after.length, "no words added or lost — this defect is a lie, not a gap");
  const changed = before.filter((w, i) => w !== after[i]);
  assert.equal(changed.length, 1, `exactly one token differs, got ${JSON.stringify(changed)}`);
  assert.match(changed[0], /^\d+$/);
  // The structure is untouched, which is what makes this the defect a reader cannot catch
  // from the document alone.
  assert.equal(count(out, "tbody tr"), 3);
  assert.equal(count(out, "table"), 1);

  // The digit count never changes and no leading zero appears: 9 moves down, everything
  // else up, so the damaged value stays a plausible transcription error.
  const nine = defect("change_cell_number").damage("<table><tr><td>19</td></tr></table>");
  assert.ok(nine);
  assert.match(nine, />18</);
  const eight = defect("change_cell_number").damage("<table><tr><td>18</td></tr></table>");
  assert.ok(eight);
  assert.match(eight, />19</);

  // Markup inside the cell survives, because the edit is made in the text node.
  const nested = defect("change_cell_number").damage("<table><tr><td><strong>7</strong> kg</td></tr></table>");
  assert.ok(nested);
  assert.match(nested, /<strong>8<\/strong>/);

  // A table with no digits anywhere is declined rather than fabricated into one.
  assert.equal(defect("change_cell_number").damage("<table><tr><td>none</td></tr></table>"), null);
  // And prose digits are not cells: this defect is about a table's numbers.
  assert.equal(defect("change_cell_number").damage("<p>2019 was the year</p>"), null);
});

test("drop_heading removes a heading and keeps what was under it", () => {
  const out = defect("drop_heading").damage(RICH);
  assert.ok(out);
  assert.equal(count(out, "h1, h2, h3, h4, h5, h6"), 1);
  // The second heading where there is one: a page whose only heading is its title is the
  // hardest case to attribute, since some pages legitimately render without one.
  assert.ok(words(out).includes("Quarterly"), "the first heading stays");
  assert.ok(!words(out).includes("Totals"));
  assert.equal(count(out, "table"), 1, "the section's content is left behind, orphaned");

  const only = defect("drop_heading").damage("<h1>Alone</h1><p>x</p>");
  assert.ok(only);
  assert.equal(count(only, "h1"), 0);
  assert.equal(defect("drop_heading").damage("<p>no headings</p>"), null);
});

test("demote_heading breaks the nesting and keeps every word", () => {
  const out = defect("demote_heading").damage(RICH);
  assert.ok(out);
  assert.deepEqual(words(out), words(RICH), "nothing about the text changes");
  assert.equal(count(out, "h1"), 0);
  assert.equal(count(out, "h3"), 1, "h1 became h3");
  assert.equal(count(out, "h2"), 1, "the h2 below it is untouched, so the order is now 3 then 2");

  // Attributes and children ride along: an id a link points at must not vanish, or the
  // damaged copy would carry a second, unintended defect.
  const withId = defect("demote_heading").damage('<h2 id="totals">A <em>big</em> total</h2>');
  assert.ok(withId);
  assert.match(withId, /<h4 id="totals">A <em>big<\/em> total<\/h4>/);

  // No room to demote by two.
  assert.equal(defect("demote_heading").damage("<h5>x</h5>"), null);
  assert.equal(defect("demote_heading").damage("<h6>x</h6>"), null);
  assert.equal(defect("demote_heading").damage("<p>x</p>"), null);
});

test("remove_alt strips a real alt and leaves a decorative one alone", () => {
  const out = defect("remove_alt").damage(RICH);
  assert.ok(out);
  assert.equal(count(out, "img"), 1);
  assert.equal(count(out, "img[alt]"), 0);
  assert.ok(!out.includes("bar chart"));

  // `alt=""` is correct markup for a decorative image, so removing that one would inject a
  // defect the verifier is right to weigh differently — or not to call a defect at all.
  assert.equal(defect("remove_alt").damage('<img src="a.png" alt="">'), null);
  assert.equal(defect("remove_alt").damage('<img src="a.png" alt="   ">'), null);
  assert.equal(defect("remove_alt").damage('<img src="a.png">'), null);
  assert.equal(defect("remove_alt").damage("<p>no images</p>"), null);
});

test("swap_paragraphs reverses reading order and loses nothing", () => {
  const out = defect("swap_paragraphs").damage(RICH);
  assert.ok(out);
  const before = words(RICH);
  const after = words(out);
  assert.equal(before.length, after.length);
  assert.deepEqual([...before].sort(), [...after].sort(), "both paragraphs are still present");
  const doc = new JSDOM(`<body>${out}</body>`, { virtualConsole: new VirtualConsole() }).window.document;
  const ps = Array.from(doc.querySelectorAll("p")).map((p) => p.textContent);
  assert.equal(ps[0], "The second paragraph of the summary.");
  assert.equal(ps[1], "The first paragraph of the summary.");

  // Neighbours, not any two paragraphs: a single paragraph, or paragraphs separated by
  // other blocks, is declined rather than reordered across a heading.
  assert.equal(defect("swap_paragraphs").damage("<p>one</p>"), null);
  assert.equal(defect("swap_paragraphs").damage("<p>one</p><h2>b</h2><p>two</p>"), null);

  // Two paragraphs that read the same are declined too, and this is the case that would
  // otherwise be scored as a miss: the document is unchanged for any reader, so a verifier
  // answering "faithful" is right, and the report would call it wrong. Real pages have
  // them — repeated "(continued)" markers, a column of blank-looking labels.
  assert.equal(defect("swap_paragraphs").damage("<p>(continued)</p><p>(continued)</p>"), null);
  assert.equal(defect("swap_paragraphs").damage("<p>same</p>\n<p>  same  </p>"), null, "whitespace is not text");
  // Same text, different markup: still nothing a reader of the page could notice.
  assert.equal(defect("swap_paragraphs").damage("<p><em>x</em></p><p>x</p>"), null);
  // An empty paragraph beside a real one moves nothing a reader can see either.
  assert.equal(defect("swap_paragraphs").damage("<p></p><p>after an empty one</p>"), null);
  // But the next differing pair along is still fair game, so one repeated pair does not
  // make the whole page undamageable. Here the second "same" and "one" are the first pair
  // that reads differently, and they are the ones swapped.
  const later = defect("swap_paragraphs").damage("<p>same</p><p>same</p><p>one</p>");
  assert.ok(later);
  assert.equal(later, "<p>same</p><p>one</p><p>same</p>");
});

test("truncate_tail drops the last third, and unwraps a single container first", () => {
  const out = defect("truncate_tail").damage(RICH);
  assert.ok(out);
  assert.ok(words(out).includes("Quarterly"), "the page starts as it did");
  assert.ok(!words(out).includes("closing"), "the tail is gone, with no marker saying so");

  // A page the model wrapped in one container would otherwise have one top-level child,
  // where a third is either nothing or everything.
  const wrapped = defect("truncate_tail").damage(
    "<main><p>one</p><p>two</p><p>three</p><p>four</p><p>five</p><p>six</p></main>",
  );
  assert.ok(wrapped);
  assert.equal(count(wrapped, "main"), 1, "the container itself survives");
  assert.equal(count(wrapped, "p"), 4);
  assert.ok(!words(wrapped).includes("five"));

  // Too few blocks to drop a third of: declined, rather than dropping the only block and
  // calling a blank page a truncation.
  assert.equal(defect("truncate_tail").damage("<p>one</p><p>two</p>"), null);
  assert.equal(defect("truncate_tail").damage("<div><p>alone</p></div>"), null);
});

// ---------------------------------------------------------------------------
// The runner, against a stub verifier whose behaviour the test chooses
// ---------------------------------------------------------------------------

interface Stub {
  // What the Feedback Agent replies, given the HTML it was asked to judge.
  reply(html: string): string;
  // Set to false to leave `agents/feedback.md` out, which is the "no verifier at all" case.
  feedback?: boolean;
}

async function run(
  pages: { name: string; html: string }[],
  stub: Stub,
  opts: Parameters<typeof calibrateVerifier>[3] = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "iris-calibrate-"));
  try {
    const agentsDir = join(dir, "agents");
    const inputDir = join(dir, "input");
    for (const d of [agentsDir, inputDir]) mkdirSync(d, { recursive: true });
    writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
    if (stub.feedback !== false) {
      writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\nvision\n");
    }
    const calls: string[] = [];
    const ctx = {
      sessionId: "ses_test",
      paths: { agentsDir, tmpAgentsDir: () => join(dir, "tmp-agents") } as unknown as Paths,
      extractionConcurrency: 3,
      recheckSampleSize: 1,
      router: {
        complete: async (
          _agent: string,
          _cap: string,
          messages: { role: string; content: string }[],
        ) => {
          // The HTML under judgement, as the verifier was actually asked about it — read
          // back out of the message rather than passed in, so this stub cannot be fooled by
          // a runner that verified the wrong copy.
          const user = messages.find((m) => m.role === "user")?.content ?? "";
          const html = /```html\n([\s\S]*?)\n```/.exec(user)?.[1] ?? "";
          calls.push(html);
          return { text: stub.reply(html) };
        },
      },
      log: { event: () => {}, agentCall: () => {} },
    } as unknown as PipelineContext;

    const agent = loadAgent("page", { agentsDir, tmpAgentsDir: join(dir, "tmp-agents") });
    assert.ok(agent);
    const calibrationPages: CalibrationPage[] = pages.map((p, i) => {
      const path = join(inputDir, p.name);
      writeFileSync(path, "not-a-real-png");
      return { image: { name: p.name, order: i + 1, path, links: [] }, html: p.html };
    });
    const report = await calibrateVerifier(ctx, agent, calibrationPages, opts);
    return { report, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A verifier that is right about everything: it passes any HTML it was given as clean and
// rejects anything else. The stub knows which is which because the test tells it.
const perfect = (clean: string[]): Stub => ({
  reply: (html) =>
    clean.includes(html)
      ? JSON.stringify({ faithful: true, accessible: true, problems: [] })
      : JSON.stringify({
          faithful: false,
          accessible: true,
          problems: [{ kind: "content_missing", problem: "something is missing" }],
        }),
});

test("a verifier that is always right scores 0% false positives and 100% caught", async () => {
  const pages = [
    { name: "page-001.png", html: RICH },
    { name: "page-002.png", html: RICH },
  ];
  const { report, calls } = await run(pages, perfect([RICH]));

  // 2N calls, which is what the issue costs out: one clean and one damaged per page.
  assert.equal(calls.length, 4);
  assert.equal(report.pages, 2);
  assert.equal(report.clean.passed, 2);
  assert.equal(report.clean.failed, 0);
  assert.equal(report.clean.unjudged, 0);

  const applied = Object.values(report.perDefect).reduce((n, t) => n + t.applied, 0);
  assert.equal(applied, 2, "rotate mode gives each page exactly one defect");
  const caught = Object.values(report.perDefect).reduce((n, t) => n + t.caught, 0);
  assert.equal(caught, 2);
  assert.equal(report.skipped.length, 0);

  // The rotation walks with the page index, so two identical pages exercise two different
  // defects rather than the same one twice.
  const exercised = DEFECTS.filter((d) => report.perDefect[d.id].applied > 0).map((d) => d.id);
  assert.deepEqual(exercised, ["drop_table_row", "drop_table"]);
});

test("a verifier that rejects everything is measured as a false-positive machine", async () => {
  // The hypothesis this harness exists to test: a judge calibrated to find something finds
  // something. Its true-positive rate is a perfect 100% and it is useless, which is
  // precisely why the clean-copy rate is reported next to it and not underneath it.
  const alwaysReject: Stub = {
    reply: () =>
      JSON.stringify({
        faithful: false,
        accessible: true,
        problems: [{ kind: "content_wrong", problem: "the heading is slightly off" }],
      }),
  };
  const { report } = await run([{ name: "p1.png", html: RICH }], alwaysReject);
  assert.equal(report.clean.passed, 0);
  assert.equal(report.clean.failed, 1);
  const caught = Object.values(report.perDefect).reduce((n, t) => n + t.caught, 0);
  assert.equal(caught, 1);
  const text = formatCalibration(report);
  assert.match(text, /false-positive rate 100%/);
  assert.match(text, /1 of 1 caught \(100%\)/);
});

test("a rejection with no problems in it is not a catch", async () => {
  // The same test the pipeline applies before it spends a correction call (`failedCheck`):
  // a verdict that flags a page and names nothing is not actionable, whatever the flag
  // says, and counting it as a catch would credit the verifier for a shrug.
  const flagOnly: Stub = { reply: () => JSON.stringify({ faithful: false, accessible: false, problems: [] }) };
  const { report } = await run([{ name: "p1.png", html: RICH }], flagOnly);
  assert.equal(report.clean.failed, 0, "and not a false positive either");
  assert.equal(report.clean.passed, 1);
  assert.equal(Object.values(report.perDefect).reduce((n, t) => n + t.caught, 0), 0);
});

test("a defect described in full and flagged faithful is its own column, not a miss", async () => {
  // The most actionable thing the first live run turned up: three of its five apparent
  // misses were the verifier describing the defect exactly — one quoted both paragraphs of a
  // reversed pair — and then answering faithful:true. `failedCheck` needs ok=false AND a
  // problem, so the page ships unquestioned with the defect written down in the log.
  //
  // Scoring that as a miss would send someone to `agents/feedback.md` to teach the verifier
  // to SEE reading order, which it already does. The fix is the two-boolean contract.
  const sees: Stub = {
    reply: (html) =>
      html === RICH
        ? JSON.stringify({ faithful: true, accessible: true, problems: [] })
        : JSON.stringify({
            faithful: true,
            accessible: true,
            problems: [{ kind: "structure_wrong", problem: "the two paragraphs are in the wrong order" }],
          }),
  };
  const { report } = await run([{ name: "p1.png", html: RICH }], sees, { only: ["swap_paragraphs"] });
  const tally = report.perDefect["swap_paragraphs"];
  assert.equal(tally.applied, 1);
  assert.equal(tally.caught, 0, "not caught: the pipeline would not correct this page");
  assert.equal(tally.named, 0, "naming is only scored on a verdict that also flagged");
  assert.equal(tally.describedOnly, 1);
  const text = formatCalibration(report);
  assert.match(text, /1 were DESCRIBED and flagged faithful anyway/);
  assert.match(text, /saw 1 of 1 \(100%\) and only flagged 0/);
  assert.match(text, /failedCheck needs both/);

  // On a clean copy the same shape is still a pass — that is what the pipeline does with it
  // — but it is counted, because a page the verifier complained about and passed is not the
  // same event as one it had nothing to say about.
  const chatty: Stub = {
    reply: () =>
      JSON.stringify({
        faithful: true,
        accessible: true,
        problems: [{ kind: "alt_quality", problem: "the alt text could be richer" }],
      }),
  };
  const second = await run([{ name: "p1.png", html: RICH }], chatty, { only: ["drop_table"] });
  assert.equal(second.report.clean.passed, 1);
  assert.equal(second.report.clean.failed, 0);
  assert.equal(second.report.clean.describedOnly, 1);
  assert.match(formatCalibration(second.report), /1 of the passes named a problem and answered faithful anyway/);
});

test("naming the kind is scored separately from catching the defect", async () => {
  // A verifier that spots every defect but calls all of them alt text problems has caught
  // them and named none, and the report has to be able to say so — that sentence is about
  // `agents/feedback.md`, and an aggregate rejection rate cannot produce it.
  const wrongKind: Stub = {
    reply: (html) =>
      html === RICH
        ? JSON.stringify({ faithful: true, accessible: true, problems: [] })
        : JSON.stringify({
            faithful: false,
            accessible: true,
            problems: [{ kind: "alt_quality", problem: "the alt text could be richer" }],
          }),
  };
  const { report } = await run([{ name: "p1.png", html: RICH }], wrongKind, { only: ["drop_table"] });
  const tally = report.perDefect["drop_table"];
  assert.equal(tally.applied, 1);
  assert.equal(tally.caught, 1);
  assert.equal(tally.named, 0, "content_missing is what a verifier that saw a dropped table says");
  assert.match(formatCalibration(report), /0 tagged with a kind the defect predicts/);

  // And a defect whose `expects` lists two kinds is named by either, because both are true
  // of it: a dropped heading is content gone AND structure changed.
  const structureOnly: Stub = {
    reply: (html) =>
      html === RICH
        ? JSON.stringify({ faithful: true, accessible: true, problems: [] })
        : JSON.stringify({
            faithful: false,
            accessible: true,
            problems: [{ kind: "structure_wrong", problem: "a section has lost its heading" }],
          }),
  };
  const second = await run([{ name: "p1.png", html: RICH }], structureOnly, { only: ["drop_heading"] });
  assert.equal(second.report.perDefect["drop_heading"].named, 1);
});

test("calls that produced no judgement are excluded from every rate", async () => {
  // With no feedback.md, `verifyAgentOutput` returns ok=true without asking anything. That
  // is correct for a run — verification must never cost a page — and catastrophic for a
  // measurement: it would report a verifier that passes every clean page and misses every
  // defect, from a corpus where nothing was ever looked at.
  const { report, calls } = await run([{ name: "p1.png", html: RICH }], {
    reply: () => "never called",
    feedback: false,
  });
  assert.equal(calls.length, 0, "no model call is made at all");
  assert.equal(report.clean.passed, 0);
  assert.equal(report.clean.failed, 0);
  assert.equal(report.clean.unjudged, 1);
  const tally = Object.values(report.perDefect).reduce(
    (acc, t) => ({ applied: acc.applied + t.applied, caught: acc.caught + t.caught, unjudged: acc.unjudged + t.unjudged }),
    { applied: 0, caught: 0, unjudged: 0 },
  );
  assert.equal(tally.applied, 1);
  assert.equal(tally.caught, 0);
  assert.equal(tally.unjudged, 1);
  const text = formatCalibration(report);
  assert.match(text, /1 judged|0 judged/);
  assert.match(text, /Unjudged calls are excluded from every rate above: 1 clean, 1 damaged/);
  // n/a rather than 0%: a rate over nothing is not zero.
  assert.match(text, /false-positive rate n\/a/);
});

test("one failed call is unjudged and named, not the end of a paid run", async () => {
  // A run of this is bought call by call, and `mapWithConcurrency` rejects on the first
  // failing one — so a single throttled request an hour in would throw away every verdict
  // already paid for. Each call catches its own error instead, comes back unjudged (nothing
  // judged that copy, which is the honest reading and is excluded from both rates), and is
  // listed in the report, because numbers resting on calls that never happened are not the
  // numbers the page count implies.
  const flaky: Stub = {
    reply: (html) => {
      if (html !== RICH) throw new Error("ThrottlingException: rate exceeded");
      return JSON.stringify({ faithful: true, accessible: true, problems: [] });
    },
  };
  const { report } = await run([{ name: "p1.png", html: RICH }], flaky, { only: ["drop_table"] });
  assert.equal(report.clean.passed, 1, "the clean copy was bought and still counts");
  const tally = report.perDefect["drop_table"];
  assert.equal(tally.applied, 1);
  assert.equal(tally.unjudged, 1);
  assert.equal(tally.caught, 0, "and not a miss: nobody looked");
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].defect, "drop_table");
  assert.match(report.errors[0].message, /ThrottlingException/);
  const text = formatCalibration(report);
  assert.match(text, /1 call failed and is counted unjudged: p1\.png\/drop_table: ThrottlingException/);
  assert.match(text, /Unjudged calls are excluded from every rate above: 0 clean, 1 damaged/);
});

test("--only reports the defects it ran, and does not call the rest unmeasured", async () => {
  // A `--only drop_table` run listing the other seven under "never applied in this run"
  // would be reporting its own argument back to the reader as a gap in the corpus.
  const { report } = await run([{ name: "p1.png", html: RICH }], perfect([RICH]), { only: ["drop_table"] });
  assert.deepEqual(Object.keys(report.perDefect), ["drop_table"]);
  const text = formatCalibration(report);
  assert.ok(!text.includes("Never applied in this run"), text);
  for (const id of DEFECT_IDS.filter((i) => i !== "drop_table")) {
    assert.ok(!text.includes(id), `${id} was not part of this run and is not in its report`);
  }
});

test("a reply the verifier could not be read from is unjudged, not a pass", async () => {
  const unparseable: Stub = { reply: () => "I'm afraid I can't help with that." };
  const { report } = await run([{ name: "p1.png", html: RICH }], unparseable);
  assert.equal(report.clean.unjudged, 1);
  assert.equal(report.clean.passed, 0);
});

test("the unjudged flag is on the verdict itself, and absent when there was a verdict", async () => {
  // Additive and optional: every existing reader tests `ok` and `problems`, and this field
  // being absent leaves all of them saying what they said before.
  const dir = mkdtempSync(join(tmpdir(), "iris-calibrate-verdict-"));
  try {
    const agentsDir = join(dir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
    writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\nvision\n");
    const imgPath = join(dir, "page-001.png");
    writeFileSync(imgPath, "not-a-real-png");
    const img = { name: "page-001.png", order: 1, path: imgPath, links: [] };
    const agent = loadAgent("page", { agentsDir, tmpAgentsDir: join(dir, "tmp-agents") });
    assert.ok(agent);
    const ctxWith = (reply: string) =>
      ({
        sessionId: "ses_test",
        paths: { agentsDir, tmpAgentsDir: () => join(dir, "tmp-agents") } as unknown as Paths,
        router: { complete: async () => ({ text: reply }) },
        log: { event: () => {}, agentCall: () => {} },
      }) as unknown as PipelineContext;

    const judged = await verifyAgentOutput(
      ctxWith(JSON.stringify({ faithful: true, accessible: true, problems: [] })),
      agent,
      img,
      [{ html: "<p>x</p>" }],
      "verify",
    );
    assert.equal(judged.ok, true);
    assert.equal(judged.unjudged, undefined, "a real verdict carries no flag");

    const nothingToVerify = await verifyAgentOutput(ctxWith("{}"), agent, img, [], "verify");
    assert.equal(nothingToVerify.ok, true, "still non-blocking");
    assert.equal(nothingToVerify.unjudged, true);

    const garbled = await verifyAgentOutput(ctxWith("no json here"), agent, img, [{ html: "<p>x</p>" }], "verify");
    assert.equal(garbled.ok, true);
    assert.equal(garbled.unjudged, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a page no defect applies to is reported, never silently dropped", async () => {
  // A report over 20 pages where 6 could not be damaged is a report over 14, and the only
  // way to know that is for the report to say it. Prose with no table, no second heading,
  // no image and too few blocks to truncate is that page.
  const prose = "<p>One paragraph and nothing else at all.</p>";
  const { report, calls } = await run(
    [
      { name: "prose.png", html: prose },
      { name: "rich.png", html: RICH },
    ],
    perfect([prose, RICH]),
  );
  assert.equal(calls.length, 3, "the prose page costs one call, not two");
  assert.equal(report.pages, 2);
  assert.equal(report.clean.passed, 2, "its clean copy is still verified and still counts");
  assert.equal(report.skipped.length, 1);
  assert.equal(report.skipped[0].image, "prose.png");
  assert.match(report.skipped[0].reason, /no defect/);
  const row = report.rows.find((r) => r.image === "prose.png");
  assert.ok(row);
  assert.equal(row.damaged, undefined);
  assert.ok(row.skipped);

  const text = formatCalibration(report);
  assert.match(text, /Pages with no applicable defect: 1 of 2/);
  // And the defects this run never exercised are named, because a defect that was never
  // applied has not been measured and the counts alone read as a zero. Not claimed as a
  // corpus fact: in rotate mode a page stops at its first applicable defect, so a zero row
  // can mean "the rotation did not reach it" — which the tool's dry run separates out.
  assert.match(text, /Never applied in this run \(not measured\):/);
});

test('--defects all applies every applicable defect to every page', async () => {
  const { report, calls } = await run([{ name: "p1.png", html: RICH }], perfect([RICH]), { defects: "all" });
  const applied = Object.values(report.perDefect).reduce((n, t) => n + t.applied, 0);
  assert.equal(applied, DEFECTS.length, "RICH is built to exercise all of them");
  assert.equal(calls.length, 1 + DEFECTS.length);
  assert.equal(report.rows.filter((r) => r.defect).length, DEFECTS.length);
  // Each damaged copy really is a different document — the same page damaged eight ways,
  // not the same edit counted eight times.
  const damaged = calls.filter((c) => c !== RICH);
  assert.equal(new Set(damaged).size, DEFECTS.length);
});

test("a page carrying its own contract is judged against that one, and the row says which", async () => {
  // VERIFY quotes the agent's whole contract and judges the output against it, so a page
  // extracted under an older `agents/page.md` and judged against today's can be rejected
  // for breaking a rule that did not exist when it was written. That rejection is the
  // verifier being right, and a measurement whose subject is false positives would count it
  // as one — so the page's own contract travels with it.
  const dir = mkdtempSync(join(tmpdir(), "iris-calibrate-contract-"));
  try {
    const agentsDir = join(dir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\nToday's rules.\n\n## Required capability\nvision\n");
    writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\nvision\n");
    const imgPath = join(dir, "p.png");
    writeFileSync(imgPath, "bytes");
    const contracts: string[] = [];
    const ctx = {
      sessionId: "ses_test",
      paths: { agentsDir, tmpAgentsDir: () => join(dir, "tmp-agents") } as unknown as Paths,
      extractionConcurrency: 2,
      recheckSampleSize: 1,
      router: {
        complete: async (_a: string, _c: string, messages: { role: string; content: string }[]) => {
          const user = messages.find((m) => m.role === "user")?.content ?? "";
          contracts.push(/Yesterday's rules/.test(user) ? "old" : "current");
          return { text: JSON.stringify({ faithful: true, accessible: true, problems: [] }) };
        },
      },
      log: { event: () => {}, agentCall: () => {} },
    } as unknown as PipelineContext;
    const current = loadAgent("page", { agentsDir, tmpAgentsDir: join(dir, "tmp-agents") });
    assert.ok(current);
    const old = { ...current, content: "# Page Agent\n\nYesterday's rules.\n", sha: "0".repeat(40) };

    const report = await calibrateVerifier(
      ctx,
      current,
      [
        { image: { name: "p.png", order: 1, path: imgPath, links: [] }, html: RICH, agent: old },
        { image: { name: "p.png", order: 2, path: imgPath, links: [] }, html: RICH },
      ],
      { only: ["drop_table"] },
    );
    // Both of the first page's calls quoted the old contract; both of the second's quoted
    // today's. The verifier itself is the current one either way — today's judge is what is
    // being measured, and only the quoted contract goes back.
    assert.deepEqual(contracts.sort(), ["current", "current", "old", "old"]);
    // And the report can be read a year later: which contract each row was judged against
    // is recorded, because a corpus pooled from several sessions is several contracts.
    assert.deepEqual([...new Set(report.rows.map((r) => r.contract))].sort(), [current.sha, "0".repeat(40)].sort());
    assert.match(formatCalibration(report), /Contract judged against: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every verify call goes against the page's own image", async () => {
  // A damaged copy verified against another page's image would fail for the wrong reason,
  // and the report would read as a verifier that catches everything.
  const dir = mkdtempSync(join(tmpdir(), "iris-calibrate-img-"));
  try {
    const agentsDir = join(dir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
    writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\nvision\n");
    const paths = ["a.png", "b.png"].map((n, i) => {
      const p = join(dir, n);
      writeFileSync(p, `bytes-for-${i}`);
      return p;
    });
    const seen: { image: string; html: string }[] = [];
    const ctx = {
      sessionId: "ses_test",
      paths: { agentsDir, tmpAgentsDir: () => join(dir, "tmp-agents") } as unknown as Paths,
      extractionConcurrency: 2,
      recheckSampleSize: 1,
      router: {
        complete: async (
          _agent: string,
          _cap: string,
          messages: { role: string; content: string }[],
          opts: { images: { data: Buffer }[] },
        ) => {
          const user = messages.find((m) => m.role === "user")?.content ?? "";
          seen.push({ image: opts.images[0].data.toString(), html: /```html\n([\s\S]*?)\n```/.exec(user)?.[1] ?? "" });
          return { text: JSON.stringify({ faithful: true, accessible: true, problems: [] }) };
        },
      },
      log: { event: () => {}, agentCall: () => {} },
    } as unknown as PipelineContext;
    const agent = loadAgent("page", { agentsDir, tmpAgentsDir: join(dir, "tmp-agents") });
    assert.ok(agent);
    const pageA = RICH;
    const pageB = RICH.replace("Quarterly Report", "Annual Report");
    await calibrateVerifier(ctx, agent, [
      { image: { name: "a.png", order: 1, path: paths[0], links: [] }, html: pageA },
      { image: { name: "b.png", order: 2, path: paths[1], links: [] }, html: pageB },
    ]);
    assert.equal(seen.length, 4);
    for (const call of seen) {
      const fromA = call.html.includes("Quarterly");
      assert.equal(call.image, fromA ? "bytes-for-0" : "bytes-for-1", "each copy went with its own page's image");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The population itself, which is the other half of the number. `calibrateVerifier` above is
// measured against pages the verifier passed, and `passedImages` is the code that decides
// which pages those are — read off `page_verify_ok` in a finished session's log. It carries
// two subtractions now (unjudged verdicts, and verdicts that described a defect and shipped
// the page anyway), and until this test the only way to exercise either was to run the tool
// against a real session. A page wrongly kept here is a page whose clean copy is not clean,
// and its rejection is scored as a false positive against the verifier.
test("the calibration corpus is the pages the verifier looked at and had nothing to say about", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-passed-"));
  try {
    const log = join(dir, "run.jsonl");
    writeFileSync(
      log,
      [
        // Kept: judged, passed, nothing said.
        JSON.stringify({ type: "page_verify_ok", image: "clean.png", page: 1 }),
        // Dropped: nobody could judge it, so it is not evidence the verifier passed anything.
        JSON.stringify({ type: "page_verify_ok", image: "unjudged.png", page: 2, unjudged: true }),
        // Dropped, and the order matters: the `ok` line for a described page comes first in a
        // real log, because the inconsistency is only detectable once the verdict has passed.
        JSON.stringify({ type: "page_verify_ok", image: "described.png", page: 3 }),
        JSON.stringify({ type: "page_verify_inconsistent", image: "described.png", page: 3, kinds: ["content_wrong"] }),
        // ...and dropped the other way round too, so the subtraction cannot depend on order.
        JSON.stringify({ type: "page_verify_inconsistent", image: "late.png", page: 4, kinds: [] }),
        JSON.stringify({ type: "page_verify_ok", image: "late.png", page: 4 }),
        // Not a pass at all. Named here because the line matches the cheap substring test.
        JSON.stringify({ type: "page_verify_failed", image: "failed.png", page: 5 }),
        // A log still being written. Its truncated tail must not throw away the whole file.
        '{"type":"page_verify_ok","image":"trunc',
      ].join("\n"),
      "utf8",
    );
    assert.deepEqual([...passedImages(log)].sort(), ["clean.png"]);

    // An older log — every one published before this version — says nothing about either
    // case, and comes out exactly as it did when the measurement was first taken.
    const old = join(dir, "old.jsonl");
    writeFileSync(
      old,
      [
        JSON.stringify({ type: "page_verify_ok", image: "a.png", page: 1 }),
        JSON.stringify({ type: "page_verify_ok", image: "b.png", page: 2 }),
      ].join("\n"),
      "utf8",
    );
    assert.deepEqual([...passedImages(old)].sort(), ["a.png", "b.png"]);

    // A session whose log is not there yet is empty, not an exception: the tool takes a list
    // of sessions and one of them having no log must not lose the others.
    assert.equal(passedImages(join(dir, "nope.jsonl")).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
