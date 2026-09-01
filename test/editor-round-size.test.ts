// A successful review round used to destroy the only copy of its own input.
//
// The Copy Editor is asked for the whole document and its `html` is adopted for the body verbatim,
// so once the round has run, the body that entered it is gone: nothing in the run log says how much
// of the document that round kept. That is the gap #174 is about. The path has no floor — a reply
// shaped like the contract rather than like the document would be adopted whole, and the blast
// radius is the document rather than one page — and a floor cannot be given a number without the
// distribution of a LEGITIMATE round to place it against.
//
// Which was measurable only on rounds that failed, where the delivered body is still the body that
// went in: three of them across four bench rounds, all three `editor_no_output`, all three with a
// REPLY about 1.7% shorter than the body it was given — the reply, because the delivered body on
// those three is the input untouched, which is a ratio of 1.000 and says nothing about a round that
// worked. Three samples, one document, one quantity away. So these four numbers go on the `editor`
// line, which turns that into one sample per round on the population that actually matters.
//
// Both length pairs, because a length cannot say whether a round lost content or lost wrappers, which
// is the question a floor is asked — the same reason #166 needed both on `page_corrected`. Not because
// the three rounds showed the two pairs diverging: no `text_chars_*` ratio exists for a review round
// yet, and what those three showed beyond length was their STRUCTURE counts moving (0.714–1.333)
// while their length moved 1.6% — one round dropping 5 of 7 lists and 13 of 47 list items. So the
// counts are on the line too, grouped so that re-levelling a heading is not a heading lost, and the
// two tests below are the cases each reading sees and the other cannot.
//
// The threshold arrived once those numbers had, which is the second half of this file. One bench
// round (`runs-231`) logged four legitimate rounds with all three readings on them, and they placed
// the floor on the prose pair and ruled the other two out: raw characters because unwrapping a
// mis-structured document keeps every word and loses half the bytes, and the structure counts
// because the whole-body round rewrote a 55-item `<dl>` into list items — a ratio of 0.055 on
// `terms` — while its prose moved 0.3%. So `EDITOR_SHRINK_FLOOR` reads `text_chars_*`, and the tests
// below are one per reading: the two shapes that must survive it, the shape that must not, and the
// size under which none of it is a measurement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview, type ReviewIssue } from "../src/pipeline/review.ts";
import { EDITOR_FLOOR_MIN_TEXT, structureCounts, visibleText } from "../src/pipeline/correction.ts";
import type { InputImage, PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iris-round-size-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Recorded {
  events: { type: string; data: Record<string, unknown> }[];
}

// One issue on page 2, so the editor runs; one round by default, so the log has one `editor` line on
// it. `iterations` is for the one test that needs to see what the NEXT round does with a refusal.
function ctxWith(dir: string, editorReply: string, iterations = 1): { ctx: PipelineContext; rec: Recorded } {
  const inputDir = join(dir, "input");
  mkdirSync(inputDir, { recursive: true });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64",
  );
  const images: InputImage[] = [];
  for (let order = 1; order <= 2; order++) {
    const path = join(inputDir, `page-00${order}.png`);
    writeFileSync(path, png);
    images.push({ name: `page-00${order}.png`, order, path });
  }
  const issues: ReviewIssue[] = [
    { issue: "the revenue table has no headers", severity: "high", suggested_action: "add th scope", pages: [2] },
  ];
  const rec: Recorded = { events: [] };
  const ctx = {
    sessionId: "ses_test",
    images,
    maxReviewIterations: iterations,
    extractionConcurrency: 4,
    recheckSampleSize: 1,
    paths: {
      agentsDir: join(dir, "agents"),
      tmpAgentsDir: () => join(dir, "tmp-agents"),
      agentMemory: () => join(dir, "memory", "page.json"),
    } as unknown as Paths,
    router: {
      complete: async (agent: string) => {
        if (agent === "reader") return { text: JSON.stringify({ issues }) };
        return { text: editorReply };
      },
    },
    log: {
      event: (type: string, data: Record<string, unknown> = {}) => rec.events.push({ type, data }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
  return { ctx, rec };
}

const PAGES = [
  { order: 1, innerHtml: "<h1>Quarterly Report</h1>" },
  { order: 2, innerHtml: "<table><caption>Revenue</caption></table>" },
];

const round = async (dir: string, body: string, html: string) => {
  const { ctx, rec } = ctxWith(dir, JSON.stringify({ html }));
  const result = await runReview(ctx, { body, lint: { ok: true, violations: [] }, pages: PAGES });
  const editor = rec.events.find((e) => e.type === "editor");
  assert.ok(editor, "the round produced no editor line to measure");
  return { data: editor.data, rec, result };
};

// A body long enough for a proportion of it to mean something — the floor declines to judge
// anything under `EDITOR_FLOOR_MIN_TEXT` visible characters, and every fixture above is far under
// it, which is the point of the last test in this file. Paragraphs of ordinary prose rather than one
// repeated string, so the structure counts and the two length pairs all have somewhere to move.
function longBody(): string {
  const paras = [];
  for (let i = 1; i <= 12; i++) {
    paras.push(
      `<p>Section ${i} of the report describes the quarter's revenue by region, the costs ` +
        `booked against it, and the reconciliation the finance team performed before publication.</p>`,
    );
  }
  const body = `<h1>Quarterly Report</h1><h2>Outlook</h2>${paras.join("")}`;
  assert.ok(
    visibleText(body).length > EDITOR_FLOOR_MIN_TEXT * 1.5,
    "the fixture has to clear the floor's minimum with room to spare, or it tests the exemption",
  );
  return body;
}

test("a round records the body it was given as well as the body it returned", async () => {
  await withTemp(async (dir) => {
    const before = "<h1>Report</h1><table><tr><td>Revenue</td></tr></table>";
    const after = "<h1>Report</h1><table><tr><th scope='col'>Revenue</th></tr></table>";
    const { data } = await round(dir, before, after);

    assert.equal(data.changed, true);
    assert.equal(data.chars_before, before.length);
    assert.equal(data.chars_after, after.length);
    // The prose a reader receives, which is the other half of the question a floor would ask.
    // Stated as the strings themselves rather than as a recomputation of the code under test.
    assert.equal(data.text_chars_before, "Report Revenue".length);
    assert.equal(data.text_chars_after, "Report Revenue".length);
    // Not the wrapper: the `@`-comments and the `<main>` around it are added downstream, and are
    // not what the round returned. `chars_after` is the delivered body's own length.
    assert.ok((data.chars_after as number) < 200, "the sizes are the body, not the document");
  });
});

test("markup work and prose work are told apart, which one pair of numbers could not do", async () => {
  await withTemp(async (dir) => {
    // The editor un-wraps a mis-structured page: every word survives, so a reader receives exactly
    // what they did before, and 53% of the characters go with the wrappers. Reading `chars_*` alone
    // here says half the document went missing. Constructed rather than taken from the bench —
    // the three measured rounds moved their structure counts hard and their LENGTH by 1.6%, which is
    // the argument for a structure count and not for this pair. This is the pair's own case.
    const before = "<section><div><h2>Outlook</h2><div><p>Steady growth.</p></div></div></section>";
    const after = "<h2>Outlook</h2><p>Steady growth.</p>";
    const { data } = await round(dir, before, after);

    assert.equal(data.text_chars_before, "Outlook Steady growth.".length);
    assert.equal(data.text_chars_after, data.text_chars_before, "no word moved, so no prose moved");
    assert.ok((data.chars_after as number) / (data.chars_before as number) < 0.5, "and yet half the markup went");
  });
});

test("prose the round deleted is visible in the prose sizes, which is where the floor reads it", async () => {
  await withTemp(async (dir) => {
    // The other direction, and the one the floor is about: the reply is well-formed HTML and is
    // most of the document short. On a document of this size nothing rejects it — 64 characters of
    // prose is under `EDITOR_FLOOR_MIN_TEXT` and a proportion of it is not a measurement, which the
    // last test in this file is about — so what this pins is the reading itself: the numbers say by
    // how much, on the same line, whether or not the floor acted on them.
    const before = "<h1>Report</h1><p>Revenue rose nine percent over the year.</p><p>Costs held flat.</p>";
    const after = "<h1>Report</h1>";
    const { data } = await round(dir, before, after);

    assert.equal(data.text_chars_after, "Report".length);
    assert.ok(
      (data.text_chars_after as number) / (data.text_chars_before as number) < 0.2,
      "a body that lost four fifths of its prose says so on its own line",
    );
    assert.equal(data.changed, true);
  });
});

test("a reply with a fifth of the document's prose in it does not get to be the document", async () => {
  await withTemp(async (dir) => {
    // #174's actual gap: the Copy Editor's `html` is adopted for the WHOLE body with nothing
    // compared against what went in, so a reply that answered about section three, or summarised,
    // or quoted the contract back after answering, arrives here shaped like a corrected document.
    // The blast radius is the deliverable rather than one page, which is why this path got the
    // floor first.
    const before = longBody();
    const after = "<h1>Quarterly Report</h1><p>The report has been reviewed and corrected.</p>";
    const { data, rec, result } = await round(dir, before, after);

    const shrank = rec.events.find((e) => e.type === "editor_shrank");
    assert.ok(shrank, "the round was refused with nothing on the log to say so");
    assert.equal(shrank.data.text_chars_before, visibleText(before).length);
    assert.equal(shrank.data.text_chars_after, visibleText(after).length);
    // Both pairs, because the ratio that tripped and the ratio that did not are together the
    // evidence for ever moving this number.
    assert.equal(shrank.data.chars_before, before.length);
    assert.equal(shrank.data.chars_after, after.length);
    assert.equal(shrank.data.floor, 2);

    // The body that entered is the body that ships, and the `editor` line reports the round as
    // having changed nothing — which is true of the document, and is what the refusal costs: the
    // issues the round was asked to fix stay unresolved.
    assert.equal(result.body, before);
    assert.equal(data.changed, false);
    assert.equal(data.chars_after, before.length);
    // And NOT as a convergence. `review_converged` claims the editor read the document and decided
    // it was better left alone, with rounds to spare; a refused reply is the opposite claim, and
    // the loop must be free to spend another round asking again.
    assert.equal(rec.events.find((e) => e.type === "review_converged"), undefined);
  });
});

test("a refused round is not the end of the loop, it is a round that asks again", async () => {
  await withTemp(async (dir) => {
    // The other half of `usable: false`, and the half the test above can only assert the absence of.
    // A refusal is not a truncation: truncation is the loop's last round because a body that does
    // not fit will not fit next time either, so `editorCall` breaks out. A reply that came back
    // COMPLETE and was refused for its shape says nothing about the next reply, and the issues it
    // was asked to fix are still open — so the loop is entitled to spend another round on them, the
    // same way it does when a reply cannot be parsed at all (`editor_no_output`,
    // test/review-converge.test.ts). Turning this into `usable: true`, or reusing the truncation
    // branch's `break`, passes every other test in this file; this is the one it fails.
    const before = longBody();
    const after = "<h1>Quarterly Report</h1><p>The report has been reviewed and corrected.</p>";
    const { ctx, rec } = ctxWith(dir, JSON.stringify({ html: after }), 2);
    const result = await runReview(ctx, { body: before, lint: { ok: true, violations: [] }, pages: PAGES });

    assert.equal(rec.events.filter((e) => e.type === "editor_shrank").length, 2, "the second round never ran");
    assert.equal(rec.events.filter((e) => e.type === "editor").length, 2);
    // Two rounds spent, and the document that ships is still the one that entered the first of them.
    assert.equal(result.body, before);
    assert.equal(rec.events.find((e) => e.type === "review_converged"), undefined);
  });
});

test("unwrapping the document is not losing it, which is why the floor is not on the characters", async () => {
  await withTemp(async (dir) => {
    // The same shape as the second test in this file, at a size the floor actually judges: a
    // procedure whose every step arrived inside two levels of wrapper, unwrapped. Every word
    // survives and more than half the characters go — and #174's own examples of legitimate
    // deletion are exactly this ("an unwarranted `<section>` wrapper"). A floor on `chars_*` at a
    // half would refuse this round; one loose enough not to would be past the fragment it exists
    // to catch.
    //
    // The share here is written to make the arithmetic visible in one assertion, but the risk it
    // stands for is measured: markup is 21% of the bytes of the prose document in `runs-231` and
    // 56% of the table-heavy one, so on a real body the raw pair's headroom to a half is anywhere
    // from comfortable to none, and which it is depends on what the document happens to contain.
    // That is not a quantity to hang a refusal on.
    const steps = [];
    for (let i = 0; i < 40; i++) steps.push(`<p>Turn the valve and record the reading.</p>`);
    const after = `<h2>Procedure</h2>${steps.join("")}`;
    const before = after.replace(
      /<p>(.*?)<\/p>/g,
      "<section><div><section><div><p>$1</p></div></section></div></section>",
    );
    assert.ok(visibleText(after).length > EDITOR_FLOOR_MIN_TEXT, "the fixture has to clear the minimum");
    const { data, rec, result } = await round(dir, before, after);

    assert.equal(data.text_chars_before, data.text_chars_after, "no word moved");
    assert.ok((data.chars_after as number) / (data.chars_before as number) < 0.6, "and yet the bytes did");
    assert.equal(rec.events.find((e) => e.type === "editor_shrank"), undefined);
    assert.equal(result.body, after, "the round was kept");
  });
});

test("rewriting a definition list into a list is not losing it either, which rules out the counts", async () => {
  await withTemp(async (dir) => {
    // The measured round, reduced. `runs-231`'s whole-body round moved `terms` from 55 to 3 and
    // `items` from 113 to 164 while its prose moved 0.3% — a `<dl>` used for content that was never
    // a definition list, rewritten into one that is a list. That is the editor doing what this
    // pipeline is for, and it is the reason `EDITOR_SHRINK_FLOOR` is not read off a structure count:
    // a threshold loose enough to permit a ratio of 0.055 permits anything.
    const pairs = [];
    const items = [];
    for (let i = 1; i <= 20; i++) {
      pairs.push(`<dt>Step ${i}</dt><dd>Turn the valve and record the reading before continuing.</dd>`);
      items.push(`<li>Step ${i}: turn the valve and record the reading before continuing.</li>`);
    }
    const before = `<h2>Procedure</h2><dl>${pairs.join("")}</dl>`;
    const after = `<h2>Procedure</h2><ol>${items.join("")}</ol>`;
    const { data, rec, result } = await round(dir, before, after);

    const from = data.structure_before as Record<string, number>;
    const to = data.structure_after as Record<string, number>;
    assert.deepEqual([from.terms, from.items], [20, 0]);
    assert.deepEqual([to.terms, to.items], [0, 20]);
    assert.ok(
      (data.text_chars_after as number) / (data.text_chars_before as number) > 0.9,
      "the prose is all still there, which is the reading that decides",
    );
    assert.equal(rec.events.find((e) => e.type === "editor_shrank"), undefined);
    assert.equal(result.body, after, "a floor on `terms` would have thrown this away");
  });
});

test("a document too short for a proportion to mean anything is not judged by one", async () => {
  await withTemp(async (dir) => {
    // Why `EDITOR_FLOOR_MIN_TEXT` exists, in the shape that forced it: the legitimate deletions are
    // fixed-size, not proportional. `[page not fully transcribed]` is 28 characters and a duplicated
    // heading is 20–60, so on a body of 50 a single resolved marker is half the prose — the floor
    // would fire on the editor doing its job, and several of this repo's own round fixtures are that
    // small. What is given up is the floor on a document with under about 150 words in it, where a
    // ratio is noise and the thing unprotected is a document a reader loses a paragraph of.
    const before = "<p>Torque to [not legible] Nm.</p><p>[page not fully transcribed]</p>";
    const after = "<p>Torque to 40 Nm.</p>";
    assert.ok(visibleText(before).length < EDITOR_FLOOR_MIN_TEXT);
    assert.ok(
      visibleText(after).length * 2 < visibleText(before).length,
      "the ratio itself is under the floor; the size is what exempts it",
    );
    const { rec, result } = await round(dir, before, after);

    assert.equal(rec.events.find((e) => e.type === "editor_shrank"), undefined);
    assert.equal(result.body, after, "the round was kept, because resolving two markers is what it looks like");
  });
});

test("the structure a round kept is counted too, which is what those three rounds actually moved", async () => {
  await withTemp(async (dir) => {
    // The case the length pairs are blind to, and the one the bench numbers describe: a round that
    // drops a list. Every word survives — the items become paragraphs — so `text_chars_*` is equal
    // and `chars_*` barely moves, while a screen-reader user has lost how many items there are,
    // which one they are on, and where the list ends. That is the loss agents/page.md's LISTS rule
    // exists to prevent, and until now no number on this line could see it.
    const before = "<h2>Care</h2><ul><li>Unplug it</li><li>Wipe it</li><li>Dry it</li></ul>";
    const after = "<h2>Care</h2><p>Unplug it</p><p>Wipe it</p><p>Dry it</p>";
    const { data } = await round(dir, before, after);

    const from = data.structure_before as Record<string, number>;
    const to = data.structure_after as Record<string, number>;
    assert.deepEqual([from.lists, from.items, from.paragraphs], [1, 3, 0]);
    assert.deepEqual([to.lists, to.items, to.paragraphs], [0, 0, 3]);
    // What the length pairs say about the same round, pinned here so the two readings are held
    // against each other rather than separately. The prose pair is exactly equal — no word moved —
    // and the raw length loses 22%, all of it the tags themselves. Every item in the document is
    // gone and neither number is anywhere near a floor that a destroyed document would trip.
    assert.equal(data.text_chars_before, data.text_chars_after);
    assert.ok(
      (data.chars_after as number) / (data.chars_before as number) > 0.75,
      "the length a floor would read is barely down, on a round that deleted the list",
    );
  });
});

test("re-levelling a heading is not a structure lost, because half the page rules are about levels", async () => {
  await withTemp(async (dir) => {
    // The reason h1-h6 are one number. agents/page.md promotes a sub-topic the page named, makes a
    // printed group label the parent of the cluster under it, and puts a procedure's step one level
    // under its heading — so a round that re-levels a section is doing what it was asked. Counted
    // per level, every one of those reads as one heading gone and another arrived, and a floor on
    // "headings lost" would fire on the corrections this pipeline is for.
    const before = "<h2>Safeguards</h2><h2>Cord</h2><h2>Grinding</h2>";
    const after = "<h2>Safeguards</h2><h3>Cord</h3><h3>Grinding</h3>";
    const { data } = await round(dir, before, after);

    assert.equal((data.structure_before as Record<string, number>).headings, 3);
    assert.equal((data.structure_after as Record<string, number>).headings, 3);
    assert.equal(data.changed, true, "the round did change the document; what it did not do is lose a heading");
  });
});

test("a round that returned nothing usable reports the ratio it is: unchanged, and beside the reason", async () => {
  await withTemp(async (dir) => {
    // The three samples the whole distribution was read off were replies with no usable body in
    // them, where the delivered body IS the body that went in — so their ratio is 1.000 by
    // construction, and a floor reading these numbers must not count them as a legitimate round
    // that happened to change nothing. `editor_no_output` on the same log is what says which it
    // was; `changed: false` alone cannot, because a converged round looks identical.
    const before = "<h1>Report</h1><p>Revenue rose nine percent.</p>";
    const { ctx, rec } = ctxWith(dir, "I have reviewed the document and have no changes to make.");
    await runReview(ctx, { body: before, lint: { ok: true, violations: [] }, pages: PAGES });

    const editor = rec.events.find((e) => e.type === "editor");
    assert.equal(editor?.data.changed, false);
    assert.equal(editor?.data.chars_before, before.length);
    assert.equal(editor?.data.chars_after, before.length);
    assert.equal(editor?.data.text_chars_before, editor?.data.text_chars_after);
    assert.ok(
      rec.events.some((e) => e.type === "editor_no_output"),
      "the line that says the round did not run is what the equal sizes have to be read with",
    );
  });
});

// The scan behind those counts, pinned on its own because both sides of every ratio above depend
// on it reading two fragments the same way — which is the whole reason correction.ts scans rather
// than parses (a parser that repairs one side differently reports a change that is an artifact of
// the repair).
test("the structure scan counts elements, not tags, and reads model output as it arrives", () => {
  // Opening tags only. A reply that closed its <li> elements and one that did not are the same
  // document; counting closing tags too would make the numbers depend on how well-formed the
  // reply happened to be, and a floor would then fire on tidiness.
  assert.equal(structureCounts("<ul><li>a<li>b</ul>").items, 2);
  assert.equal(structureCounts("<ul><li>a</li><li>b</li></ul>").items, 2);

  // Prose about markup is not markup — the same reading `attrText` takes, and the reason a page
  // whose comment mentions a continued list does not count one.
  assert.deepEqual(
    structureCounts("<!-- the <ul> continues overleaf --><p>Done</p>"),
    structureCounts("<p>Done</p>"),
  );

  // A table is counted in five places, because a round can keep the table and lose the rows — and
  // because a <th> demoted to a <td> is the loss that strips a screen-reader table of its header
  // association, with no axe rule behind it to catch what a folded cell count would miss.
  const t = structureCounts(
    "<table><caption>Revenue</caption><tr><th>Q1</th><td>9%</td></tr><tr><td>flat</td></tr></table>",
  );
  assert.deepEqual([t.tables, t.captions, t.rows, t.header_cells, t.cells], [1, 1, 2, 1, 2]);
  const demoted = structureCounts("<table><tr><td>Q1</td><td>9%</td></tr><tr><td>flat</td></tr></table>");
  assert.equal(demoted.header_cells, 0, "the header cell is gone and the count says so");
  assert.equal(demoted.rows, t.rows, "on a round that kept every row, which is why folding them hides it");

  // An attribute value that contains something tag-shaped is not markup. Counted by scanning for
  // `<` and a name, the alt text below holds a paragraph — and a round that rewrote only that alt
  // would then report a paragraph LOST, a structure change invented by the reading.
  assert.deepEqual(
    structureCounts('<img src="f3.png" alt="Figure 3 <p> label">'),
    structureCounts('<img src="f3.png" alt="Figure 3">'),
  );

  // Wrappers are not structures. A <section>/<div> nest is what the second test above unwraps
  // legitimately, so it must not read as content arriving or leaving.
  assert.deepEqual(
    structureCounts("<section><div><p>One</p></div></section>"),
    structureCounts("<p>One</p>"),
  );

  // And <a>/<img> are counted although links.ts and the alt signal already watch their contents:
  // three links collapsed into one keeps every URL, and a dropped <img> has no other signal.
  const a = structureCounts('<p><a href="/a">a</a> <a href="/b">b</a></p><img src="c.png" alt="c">');
  assert.deepEqual([a.links, a.images], [2, 1]);
});
