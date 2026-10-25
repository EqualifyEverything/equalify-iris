// The technical walkthrough (public/how-it-works.html, served at /how-it-works) and the event index it
// is given (src/eventIndex.ts). The page's log-reading functions are lifted out of its script, as
// test/demo-pdf-form.test.ts does for the demo, so a change to the page is what gets tested.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { eventIndex, howItWorksPage } from "../src/eventIndex.ts";
import { runAxe } from "../src/pipeline/lint.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const apiMd = readFileSync(join(root, "docs", "API.md"), "utf8");
const page = readFileSync(join(root, "public", "how-it-works.html"), "utf8");
const index = eventIndex(apiMd);

test("the event index reads every row of the run log's index, one entry per event named", () => {
  const rows = apiMd.slice(apiMd.indexOf("## Run log"), apiMd.indexOf("\n### ", apiMd.indexOf("## Run log")));
  const named = [...rows.matchAll(/^\| \[(.+?)\]\(#/gm)].flatMap((m) => (m[1].match(/`[^`]+`/g) ?? []).map((n) => n.slice(1, -1)));
  assert.ok(named.length > 100, `only ${named.length} events in the index`);
  assert.deepEqual(Object.keys(index).sort(), [...new Set(named)].sort());
  // A row naming two events gives both the same anchor.
  assert.equal(index.model_call_start.anchor, "model_call_start--model_call");
  assert.equal(index.model_call.anchor, "model_call_start--model_call");
  assert.ok(!/[`*]/.test(index.page_style_attributes.summary), "markdown is taken out of a summary");
});

test("the served page carries the index, and no summary can end its script", () => {
  const out = howItWorksPage(page, apiMd);
  assert.ok(!out.includes("/*IRIS_EVENT_INDEX*/"), "the placeholder was replaced");
  const json = /const EVENT_INDEX = (\{.*?\});\n/.exec(out)?.[1];
  assert.ok(json, "the index is in the page");
  assert.deepEqual(JSON.parse(json), index);
  const hostile = howItWorksPage(page, "## Run log\n\n| [`x`](#x) | ends </script><b> here |\n");
  const line = hostile.split("\n").find((l) => l.includes("const EVENT_INDEX = "))!;
  assert.ok(line.includes("ends \\u003c/script>"), "the summary is there, escaped");
  assert.ok(!line.toLowerCase().includes("</script"), "and cannot close the script");
});

// The page's pure functions: everything between the two markers in its script.
const script = page.slice(page.lastIndexOf("<script>") + 8, page.lastIndexOf("</script>"));
const pure = script.slice(script.indexOf("// ----- Reading the log"), script.indexOf("// ----- State and API calls"));
const lib = new Function(
  "EVENT_INDEX",
  `const REF = 'https://x/API.md'; const API = '/v1'; const location = { origin: 'https://iris.test' };
   const esc = (s) => String(s); const AI = ''; const CODE = '';
   const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
   ${pure}
   return { parseLog, parseReply, explain, SAY, runsOf, pagesFrom, roundsFrom, problems, unresolvedFrom, stagesFrom, curl };`,
)(index) as {
  parseLog(t: string): Record<string, unknown>[];
  parseReply(o: unknown): Record<string, unknown> | null;
  explain(e: Record<string, unknown>): string;
  SAY: Record<string, unknown>;
  runsOf(ev: Record<string, unknown>[]): Record<string, unknown>[][];
  pagesFrom(ev: unknown[], m?: unknown): { image: string; order: number; drafts: (string | null)[]; verify: string | null; corrected: unknown; prompts: unknown[] }[];
  roundsFrom(ev: unknown[]): { issues: { issue: string }[]; count?: number; patch: unknown; snapshot: unknown }[];
  problems(ev: unknown[], s?: unknown): { level: string; text: string; type: string }[];
  unresolvedFrom(html: string): string[];
  stagesFrom(ev: unknown[], s: unknown): { done: string[]; active: string | null };
  curl(method: string, path: string, extra?: string): string;
};

test("every event the page explains in its own words is a real event", () => {
  assert.deepEqual(Object.keys(lib.SAY).filter((t) => !index[t]), []);
});

test("an event the page has no sentence for gets the reference's summary, and an unknown one its name", () => {
  assert.equal(lib.explain({ type: "page_soft_hyphens" }), index.page_soft_hyphens.summary + ".");
  assert.equal(lib.explain({ type: "no_such_event" }), "Iris recorded no_such_event.");
  // A known event missing the fields its sentence reads falls back rather than throwing.
  assert.equal(lib.explain({ type: "page_verify_failed" }), index.page_verify_failed.summary + ".");
});

test("the log is read line by line, and a half-written last line is skipped", () => {
  assert.deepEqual(lib.parseLog('{"type":"a"}\n\n{"type":"b"}\n{"type":"c'), [{ type: "a" }, { type: "b" }]);
});

test("a model's reply is read with or without a fence or prose around it", () => {
  assert.deepEqual(lib.parseReply('{"html":"<p>x</p>"}'), { html: "<p>x</p>" });
  assert.deepEqual(lib.parseReply('```json\n{"issues":[]}\n```'), { issues: [] });
  assert.deepEqual(lib.parseReply('Here it is: {"html":"<p>y</p>"} done'), { html: "<p>y</p>" });
  assert.equal(lib.parseReply("<p>not json</p>"), null);
});

const RUN = [
  { type: "run_start", images: 2 },
  { type: "page_fields", image: "doc-p1.png", fields: 3, dropped: 0 },
  { type: "model_call_start", agent: "page", step: "extract", model: "m", prompt: { messages: [{ role: "user", sha256: "a".repeat(64), chars: 10 }], images: [{ sha256: "img1", bytes: 1, media_type: "image/png" }] } },
  { type: "agent_call", agent: "page.md", image: "doc-p2.png", output: '{"html":"<p>two</p>"}' },
  { type: "agent_call", agent: "page.md", image: "doc-p1.png", output: '{"html":"<p>one</p>"}' },
  { type: "page_verify_failed", image: "doc-p1.png", problems: ["a heading is missing"] },
  { type: "page_verify_failed", image: "doc-p2.png", problems: ["a table is wrong"] },
  { type: "agent_call", agent: "page.md", image: "doc-p1.png", output: '{"html":"<h2>one</h2>"}' },
  { type: "page_corrected", image: "doc-p1.png", page: 1, result: "kept", kinds: [] },
  { type: "extraction_complete", pages: 2, failed: [] },
  { type: "assembly", pages: 2, lint_ok: true, violations: 0 },
  { type: "audit_snapshot", run: 1, name: "assembled", chars: 20 },
  { type: "reader_start", iteration: 0, chunks: 1 },
  { type: "agent_call", agent: "reader.md", output: '```json\n{"issues":[{"issue":"two h1s","pages":[1]}]}\n```' },
  { type: "reader", iteration: 0, issues: 1 },
  { type: "editor_patch", blocks: 4, edits: 2, applied: 0, discarded: "refusal_with_loss" },
  { type: "editor", iteration: 1, changed: false },
  { type: "audit_snapshot", run: 1, name: "round-1", chars: 20 },
  { type: "run_complete", iterations: 1, unresolved: 1 },
];
const MANIFEST = { pages: [{ order: 1, name: "doc-p1.png", sha256: "img1" }, { order: 2, name: "doc-p2.png", sha256: "img2" }] };

test("each page's drafts, verdict, fix and prompts are gathered, in page order", () => {
  const pages = lib.pagesFrom(RUN, MANIFEST);
  assert.deepEqual(pages.map((p) => [p.order, p.image, p.drafts, p.verify, Boolean(p.corrected), p.prompts.length]), [
    [1, "doc-p1.png", ["<p>one</p>", "<h2>one</h2>"], "failed", true, 1],
    [2, "doc-p2.png", ["<p>two</p>"], "failed", false, 0],
  ]);
});

test("each review round has the reader's issues, the editor's patch and its snapshot", () => {
  const [r] = lib.roundsFrom(RUN);
  assert.deepEqual(r.issues.map((i) => i.issue), ["two h1s"]);
  assert.equal(r.count, 1);
  assert.ok(r.patch && r.snapshot);
});

test("problems name an unfixed failed page and a thrown-away round, and not a page that was fixed", () => {
  const p = lib.problems(RUN, { status: "ready_for_review" });
  assert.deepEqual(p.map((x) => [x.level, x.type]), [
    ["high", "page_verify_failed"],
    ["medium", "editor_patch"],
    ["info", "run_complete"],
  ]);
  assert.match(p[0].text, /^doc-p2\.png failed the check/);
  assert.deepEqual(lib.problems([], { status: "failed", error: "boom" }).map((x) => x.text), ["The run failed: boom."]);
});

test("the unsolved list is read from the HTML's @unresolved comment", () => {
  assert.deepEqual(lib.unresolvedFrom("<main></main>\n<!-- @unresolved\n  - one\n  - two\n-->\n"), ["one", "two"]);
  assert.deepEqual(lib.unresolvedFrom("<main></main>"), []);
});

test("the diagram marks done steps and the one running now", () => {
  const mid = lib.stagesFrom(RUN.slice(0, 5), { status: "running", phase: "extraction" });
  assert.equal(mid.active, "page");
  assert.ok(mid.done.includes("page") && !mid.done.includes("assemble"));
  const end = lib.stagesFrom(RUN, { status: "ready_for_review", phase: "done" });
  assert.equal(end.active, null);
  for (const k of ["page", "verify", "assemble", "reader", "editor", "serve", "html"]) assert.ok(end.done.includes(k), k);
  assert.ok(!end.done.includes("pdf"), "no tagged PDF was made");
});

test("the curl shown for a call is the call the page made", () => {
  assert.equal(lib.curl("GET", "/sessions/ses_1/logs"), "curl -s 'https://iris.test/v1/sessions/ses_1/logs'");
  assert.equal(lib.curl("POST", "/sessions", "-F 'images=@f.pdf'"), "curl -s -X POST -F 'images=@f.pdf' 'https://iris.test/v1/sessions'");
});

test("the page passes the same axe check Iris gives its own output", async () => {
  const r = await runAxe(howItWorksPage(page, apiMd));
  assert.deepEqual(r.violations, []);
  assert.equal(r.ok, true);
});

test("the page says it is the technical view and links to the demo", () => {
  assert.match(page, /This is the technical view\.<\/strong>[^<]*<a href="\/">use the demo<\/a>/);
});

// A session that took feedback: run 1 lost page 2, run 2 re-read it and got it back.
const TWO_RUNS = [
  { type: "form_fields", fields: 0 },
  { type: "run_queued" },
  { type: "run_start", images: 2, feedback: null },
  { type: "page_extraction_failed", page: 2, image: "doc-p2.png", error: "timeout" },
  { type: "reader_start", iteration: 0 },
  { type: "reader", iteration: 0, issues: 3 },
  { type: "run_complete", iterations: 1, unresolved: 3, failed_pages: [2] },
  { type: "run_queued" },
  { type: "phase", phase: "extraction" },
  { type: "feedback_rerun", feedback: "page 2 is missing" },
  { type: "run_start", images: 2, feedback: "page 2 is missing" },
  { type: "agent_call", agent: "page.md", image: "doc-p2.png", output: '{"html":"<p>two</p>"}' },
  { type: "page_verify_ok", image: "doc-p2.png" },
  { type: "reader_start", iteration: 0 },
  { type: "reader", iteration: 0, issues: 0 },
  { type: "run_complete", iterations: 0, unresolved: 0 },
];

test("a session's log is split into runs, each with the lines that lead into it", () => {
  const runs = lib.runsOf(TWO_RUNS);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0].map((e) => e.type), ["form_fields", "run_queued", "run_start", "page_extraction_failed", "reader_start", "reader", "run_complete"]);
  assert.deepEqual(runs[1].slice(0, 4).map((e) => e.type), ["run_queued", "phase", "feedback_rerun", "run_start"]);
  assert.deepEqual(lib.runsOf([{ type: "run_queued" }]).length, 1, "a log with no run_start yet is one run");
});

test("a page an earlier run lost and a later run recovered is not reported as missing", () => {
  const [first, second] = lib.runsOf(TWO_RUNS);
  const now = lib.problems(second, { status: "ready_for_review" });
  assert.deepEqual(now, [], "the latest run delivered every page");
  assert.deepEqual(lib.pagesFrom(second).map((p) => [p.image, p.verify, p.drafts.length]), [["doc-p2.png", "ok", 1]]);
  // The first run, read on its own, still says what it delivered.
  assert.deepEqual(lib.problems(first).map((p) => [p.level, p.type]), [["high", "page_extraction_failed"], ["high", "run_complete"], ["info", "run_complete"]]);
  // Rounds are counted within a run, not across the session.
  assert.equal(lib.roundsFrom(second).length, 1);
});
