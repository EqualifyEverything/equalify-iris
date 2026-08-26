// The Copy Editor is the one place after extraction where a source image and the HTML are in
// front of the same model, and it had nowhere to say that the two disagreed.
//
// Fidelity — does the HTML say what the page says — was checked exactly once per page, by the
// Feedback Agent's VERIFY task during extraction, and that check's blind spots are the
// transcriber's by construction: same model family, same image, same failure modes. Neither half
// of the review loop could originate a second opinion. The Reader cannot see the source images at
// all and is told not to speculate about what it cannot see, so a dropped table row is perfectly
// self-consistent to it and a misread number contradicts nothing. The Copy Editor can — it is
// handed the images for the pages the Reader's issues name — but it was told to fix what those
// issues named and carry everything else over unchanged, so it could be looking straight at a
// dropped row on a page it was sent to fix a heading level and have no field to report it in
// (issue #183).
//
// So it reports them, as observations and not as edits, and this file pins both halves of that:
// what gets read out of the reply, and that nothing about the delivered document changes because
// of it. Acting on one would mean re-reading that page in full, which is a re-extraction and not
// this loop's job — and an edit made from one reading of an image reaches a reader as what the
// page says, where an observation costs a person a look.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EDITOR_SYSTEM, readFidelityObserved, runReview, type ReviewIssue } from "../src/pipeline/review.ts";
import { VERIFY_KINDS } from "../src/pipeline/feedback.ts";
import { summarizeRun } from "../src/diagnostics.ts";
import type { InputImage, PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// --- what the contract promises ----------------------------------------------

test("the editor is asked for the same five kinds the fidelity check uses, and asked not to act", () => {
  // The taxonomy is defined once, in agents/feedback.md, and read by the VERIFY parse as
  // `VERIFY_KINDS`. The editor's prompt interpolates that list rather than restating it, because
  // two prompts naming their own five kinds would drift and the whole value of using the same
  // five is that `fidelity_observed` and `verification.verify_kinds` can be read against each
  // other. This holds the interpolation honest.
  for (const kind of VERIFY_KINDS) assert.ok(EDITOR_SYSTEM.includes(kind), kind);
  // And the instruction that keeps this free of the document: report, do not fix.
  assert.match(EDITOR_SYSTEM, /REPORT those and do\s+NOT act on them/);
  // Only pages it can see. An observation about a page whose image was not attached is a guess
  // about a page the model was not shown, which is the same rule the Reader is held to.
  assert.match(EDITOR_SYSTEM, /Report only pages whose image is attached/);
  // And the scope, which two earlier instructions need protecting from: "content the page shows
  // that the HTML does not have" is also the [not legible] rule ("look at that region again … put
  // the words the page shows in the marker's place") and also an ordinary structural issue the
  // Reader raised. Both are still the editor's to FIX; this paragraph is later and more general
  // than either, so it says so rather than leaving "nobody asked you about" to carry it alone.
  assert.match(EDITOR_SYSTEM, /This takes nothing off your list/);
  assert.match(EDITOR_SYSTEM, /An issue the reviewer raised is still yours to fix/);
  assert.match(EDITOR_SYSTEM, /\[not legible\] marker on an attached page is still yours to resolve/);
  assert.ok(
    EDITOR_SYSTEM.indexOf("put the words the page shows in the marker's place") <
      EDITOR_SYSTEM.indexOf("This takes nothing off your list"),
    "the carve-out comes after the rules it protects",
  );
  // The body comes first in the contract because it is what the round exists to produce and the
  // list is an aside — a model that answers in the order it was asked spends its output on the
  // document first. NOT for truncation salvage: a reply that hits the ceiling throws
  // `TruncatedResponseError` in the provider before anything parses its text, so a reply cut off
  // mid-list is discarded whole and re-made a section at a time, whatever order the fields were
  // in. Which is also the one cost this feature has: on a reply already close to the ceiling, the
  // appended observations are what push a round that would have fit into that salvage path.
  assert.ok(
    EDITOR_SYSTEM.indexOf('"html"') < EDITOR_SYSTEM.indexOf("fidelity_observed"),
    "the corrected body is asked for first",
  );
});

// --- reading the field -------------------------------------------------------

test("an observation carries its page, its kind and its sentence", () => {
  const read = readFidelityObserved(
    [
      { page: 7, kind: "content_missing", observation: "the second table's third row is absent from the HTML" },
      { page: 7, kind: "content_wrong", observation: "the total reads 1,240 on the page and 1,420 here" },
    ],
    [7],
  );
  assert.deepEqual(read.observations, [
    { page: 7, kind: "content_missing", observation: "the second table's third row is absent from the HTML" },
    { page: 7, kind: "content_wrong", observation: "the total reads 1,240 on the page and 1,420 here" },
  ]);
  assert.equal(read.unattached, 0);
  assert.equal(read.unplaced, 0);
});

test("a kind no version of this reader knows is dropped, and its observation is not", () => {
  // The same asymmetry `readProblems` follows for VERIFY: a lost label costs a label, and a lost
  // observation costs whatever it was about. `constructor` is in there because a kind matched
  // against `Object.prototype` rather than against the closed list would be truthy.
  const read = readFidelityObserved(
    [
      { page: 2, kind: "urgent", observation: "the figure caption is not in the HTML" },
      { page: 2, kind: "constructor", observation: "the sidebar is missing" },
      { page: 2, kind: "Content-Missing", observation: "a heading is absent" },
    ],
    [2],
  );
  assert.deepEqual(read.observations.map((o) => o.kind), [null, null, "content_missing"]);
  assert.equal(read.observations.length, 3, "every sentence survives its label");
});

test("a page number is read however the reply wrote it, and a page it did not write is not invented", () => {
  const read = readFidelityObserved(
    [
      { page: "3", kind: "structure_wrong", observation: "the page prints a table; the HTML has paragraphs" },
      // The Reader's own issues carry `pages: [n]`, and the editor is given those issues — so
      // echoing their shape is a likelier mistake than inventing a third one.
      { pages: [4], observation: "the caption belongs to the other figure" },
      // Not a page: left unplaced rather than rounded into a page that exists.
      { page: 0, observation: "something is off about the header" },
      { page: 2.5, observation: "and about the footer" },
      { observation: "the numbers in the second column look transposed" },
    ],
    [3, 4],
  );
  assert.deepEqual(read.observations.map((o) => o.page), [3, 4, null, null, null]);
  assert.equal(read.unplaced, 3, "three observations name no page this reader can use");
  assert.equal(read.unattached, 0);
});

test("an observation about a page the editor was not shown is counted apart, not dropped", () => {
  // The prompt asks for attached pages only, so this is the model guessing about a page it could
  // not see. It is still logged — a guess that turns out to be right is worth a look, and the
  // count is what lets a reader discount the whole set if it is mostly guesses.
  const read = readFidelityObserved(
    [
      { page: 2, kind: "content_missing", observation: "a row is missing" },
      { page: 9, kind: "content_missing", observation: "page 9 has a table that is not here" },
    ],
    [2],
  );
  assert.equal(read.observations.length, 2);
  assert.equal(read.unattached, 1);
});

test("a reply that answered in the wrong shape is read for whatever it does carry", () => {
  // Every shape here came back from a model somewhere in this pipeline's history: a bare list of
  // strings, a prose key under another name, an entry that is neither, and the two absences.
  assert.deepEqual(readFidelityObserved(["the totals row is missing"], [1]), {
    observations: [{ page: null, kind: null, observation: "the totals row is missing" }],
    unattached: 0,
    unplaced: 1,
  });
  assert.equal(readFidelityObserved([{ page: 1, problem: "a row is missing" }], [1]).observations[0]?.observation,
    "a row is missing");
  assert.equal(readFidelityObserved([{ page: 1, description: "a row is missing" }], [1]).observations[0]?.observation,
    "a row is missing");
  // No recognizable prose at all is stringified rather than discarded, so the reply's own words
  // reach the log and a person can see what the model was trying to say.
  assert.equal(readFidelityObserved([{ page: 1, note: "a row is missing" }], [1]).observations[0]?.observation,
    '{"page":1,"note":"a row is missing"}');
  // And the absences: nothing to report, and a field that is not a list at all.
  for (const raw of [undefined, null, [], "none", 3, {}, [null, undefined, "", "   "]]) {
    assert.deepEqual(readFidelityObserved(raw, [1]), { observations: [], unattached: 0, unplaced: 0 }, String(raw));
  }
});

// --- through the review loop -------------------------------------------------

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iris-fidelity-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Recorded {
  events: { type: string; data: Record<string, unknown> }[];
}

// A context whose Reader raises one issue on page 2 (so the editor runs and is given that page's
// image) and whose editor answers with `editorReply`.
function ctxWith(dir: string, editorReply: string): { ctx: PipelineContext; rec: Recorded } {
  const inputDir = join(dir, "input");
  mkdirSync(inputDir, { recursive: true });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64",
  );
  const images: InputImage[] = [];
  for (let order = 1; order <= 3; order++) {
    const path = join(inputDir, `page-00${order}.png`);
    writeFileSync(path, png);
    images.push({ name: `page-00${order}.png`, order, path });
  }
  const issues: ReviewIssue[] = [
    { issue: "revenue table has no headers", severity: "high", suggested_action: "add th scope", pages: [2] },
  ];
  const rec: Recorded = { events: [] };
  const ctx = {
    sessionId: "ses_test",
    images,
    maxReviewIterations: 1,
    extractionConcurrency: 4,
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
  { order: 3, innerHtml: "<p>Outlook for next year.</p>" },
];

const observedEvent = (rec: Recorded) => rec.events.find((e) => e.type === "editor_fidelity_observed");

test("an observation is logged with the pages the editor actually had", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = ctxWith(
      dir,
      JSON.stringify({
        html: "<h1>Report</h1><table><caption>Revenue</caption></table>",
        fidelity_observed: [
          { page: 2, kind: "content_missing", observation: "the revenue table's third row is absent from the HTML" },
        ],
      }),
    );
    const result = await runReview(ctx, {
      body: "<h1>Report</h1>",
      lint: { ok: true, violations: [] },
      pages: PAGES,
    });
    const event = observedEvent(rec);
    assert.ok(event, "the observation is on the run log");
    assert.equal(event.data.count, 1);
    // The pages it was given, on the same line: an observation is only worth what the model
    // could see, and `editor_images` is a different line that a reader of this one may not have.
    assert.deepEqual(event.data.attached, [2]);
    assert.equal("unattached" in event.data, false, "nothing to say, so nothing said");
    assert.equal("unplaced" in event.data, false);
    // And the document is the editor's corrected body, unchanged by any of this: the observation
    // is a log line, not an edit.
    assert.match(result.body, /Revenue/);
  });
});

test("a reply whose body could not be used still says what the editor saw", async () => {
  // The reply carried no `html` this code can use, which is a round that changes nothing — and
  // one of the cases where knowing what the model was looking at is worth most, so the
  // observations are read before the body is judged.
  await withTemp(async (dir) => {
    const { ctx, rec } = ctxWith(
      dir,
      JSON.stringify({
        fidelity_observed: [{ page: 2, kind: "content_wrong", observation: "the total is 1,240 on the page" }],
      }),
    );
    await runReview(ctx, { body: "<h1>Report</h1>", lint: { ok: true, violations: [] }, pages: PAGES });
    assert.equal(observedEvent(rec)?.data.count, 1);
    assert.ok(
      rec.events.some((e) => e.type === "editor_no_output"),
      "and the unusable body is still reported as one",
    );
  });
});

test("an ordinary round says nothing about fidelity observations", async () => {
  // The commonest reply, and the one that must not gain a line: an editor that noticed nothing
  // leaves the log exactly as it was before #183.
  await withTemp(async (dir) => {
    const { ctx, rec } = ctxWith(dir, JSON.stringify({ html: "<h1>Report</h1><p>Fixed.</p>" }));
    await runReview(ctx, { body: "<h1>Report</h1>", lint: { ok: true, violations: [] }, pages: PAGES });
    assert.equal(observedEvent(rec), undefined);
  });
});

// --- the fold (src/diagnostics.ts) ------------------------------------------

const T = (s: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const logOf = (...events: Record<string, unknown>[]): string => events.map((e) => JSON.stringify(e)).join("\n");
const done = (now: number) => ({ sessionId: "s", status: "ready_for_review", phase: "done", now });

test("the tally counts observations and the distinct pages they are about", () => {
  // Two rounds, three observations, two pages — and the same page reported in both rounds is one
  // page and two observations, which is what tells one page reported twice from two pages
  // reported once.
  const text = logOf(
    { ts: T(0), type: "run_start" },
    { ts: T(1), type: "editor_fidelity_observed", count: 2, attached: [2, 5], observations: [
      { page: 2, kind: "content_missing", observation: "a row is missing" },
      { page: 5, kind: "alt_quality", observation: "the chart's description says little" },
    ] },
    { ts: T(2), type: "editor_fidelity_observed", count: 1, attached: [2], observations: [
      { page: 2, kind: "content_missing", observation: "the row is still missing" },
    ] },
    { ts: T(3), type: "run_complete" },
  );
  const d = summarizeRun(text, done(Date.parse(T(3))));
  assert.equal(d.fidelity_observed.observed, 3);
  assert.deepEqual(d.fidelity_observed.pages, [2, 5]);
  assert.deepEqual(d.fidelity_observed.unattached_pages, [], "both pages were attached when reported");
  assert.deepEqual(d.fidelity_observed.kinds, {
    content_missing: 2, content_wrong: 0, structure_wrong: 0, a11y_only: 0, alt_quality: 1, untagged: 0,
  });
  assert.equal(d.fidelity_observed.unattached, 0);
  assert.equal(d.fidelity_observed.unplaced, 0);
});

test("an unlabelled observation is untagged, and the uncheckable ones are counted apart", () => {
  const text = logOf(
    { ts: T(0), type: "run_start" },
    { ts: T(1), type: "editor_fidelity_observed", count: 3, attached: [2], unattached: 1, unplaced: 1, observations: [
      { page: 2, kind: "content_missing", observation: "a row is missing" },
      // A kind this reader does not know, including one that names a function on
      // Object.prototype — matched against the closed list, so it lands in `untagged` and
      // nowhere else.
      { page: 9, kind: "toString", observation: "a table on page 9 is not here" },
      { page: null, observation: "some numbers look transposed" },
    ] },
    { ts: T(2), type: "run_complete" },
  );
  const d = summarizeRun(text, done(Date.parse(T(2))));
  assert.equal(d.fidelity_observed.observed, 3);
  assert.deepEqual(d.fidelity_observed.pages, [2, 9], "the page it named, whether or not it was attached");
  // …and which of those the editor could not see, so `pages` minus this is the set backed by an
  // image. `pages` stays the union because it is where a person should look and a guess that turns
  // out to be right is worth the look.
  assert.deepEqual(d.fidelity_observed.unattached_pages, [9]);
  assert.equal(d.fidelity_observed.kinds.content_missing, 1);
  assert.equal(d.fidelity_observed.kinds.untagged, 2);
  assert.equal(d.fidelity_observed.unattached, 1);
  assert.equal(d.fidelity_observed.unplaced, 1);
});

test("a line that does not say what was attached names no page as a guess", () => {
  // Nothing to tell against, so the page is in `pages` like any other and the line's own
  // `unattached` count is the only thing that says some of them were guesses. Naming them all
  // would read as "the editor saw none of these", which the line does not say.
  const text = logOf(
    { ts: T(0), type: "run_start" },
    { ts: T(1), type: "editor_fidelity_observed", count: 1, unattached: 1, observations: [
      { page: 4, kind: "content_wrong", observation: "the date disagrees with the page" },
    ] },
  );
  const d = summarizeRun(text, done(Date.parse(T(1))));
  assert.deepEqual(d.fidelity_observed.pages, [4]);
  assert.deepEqual(d.fidelity_observed.unattached_pages, []);
  assert.equal(d.fidelity_observed.unattached, 1);
});

test("a run with no observations reports zeros rather than nothing", () => {
  // The field is present on every run, so a client can tell "the editor noticed nothing" from an
  // older server that never looked — the same reason `pages_blank` is always an array.
  const d = summarizeRun(logOf({ ts: T(0), type: "run_start" }), done(Date.parse(T(0))));
  assert.deepEqual(d.fidelity_observed, {
    observed: 0,
    pages: [],
    unattached_pages: [],
    kinds: { content_missing: 0, content_wrong: 0, structure_wrong: 0, a11y_only: 0, alt_quality: 0, untagged: 0 },
    unattached: 0,
    unplaced: 0,
  });
  assert.deepEqual(Object.keys(d.fidelity_observed.kinds), [...VERIFY_KINDS, "untagged"]);
});
