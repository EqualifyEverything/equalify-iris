// The technical walkthrough (public/how-it-works.html, served at /how-it-works) and the event index it
// is given (src/eventIndex.ts). The page's log-reading functions are lifted out of its script, as
// test/demo-pdf-form.test.ts does for the demo, so a change to the page is what gets tested.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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
   return { settingsHtml, inputsHtml, processSteps, pdfReportHtml, PDF_WARN, INPUTS, parseLog, parseReply, explain, SAY, runsOf, pagesFrom, roundsFrom, problems, unresolvedFrom, stagesFrom, curl };`,
)(index) as {
  parseLog(t: string): Record<string, unknown>[];
  parseReply(o: unknown): Record<string, unknown> | null;
  explain(e: Record<string, unknown>): string;
  SAY: Record<string, unknown>;
  INPUTS: { method: string; path: string; field: string | null }[];
  settingsHtml(st: unknown, limits?: unknown): string;
  inputsHtml(): string;
  processSteps(ev: unknown[], s: unknown, o?: unknown): { key: string; state: string; detail: string; seconds?: number | null }[];
  pdfReportHtml(r: unknown): string;
  PDF_WARN: Record<string, string>;
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

test("a run's last line that lands after the next run starts still belongs to its own run", () => {
  const runs = lib.runsOf([
    { type: "run_start", feedback: null },
    { type: "reader", issues: 2 },
    { type: "run_start", feedback: "again" },
    { type: "run_complete", unresolved: 2, failed_pages: [3] },
    { type: "reader", issues: 0 },
  ]);
  assert.deepEqual(runs.map((r) => r.map((e) => e.type)), [["run_start", "reader", "run_complete"], ["run_start", "reader"]]);
  assert.deepEqual(lib.problems(runs[1]), [], "run 2 is still working and has no last line yet");
});

// "What you can send" is the API's whole input surface: every field a route reads from a request.
test("every request field a route reads is listed under What you can send", () => {
  const found = new Set<string>();
  for (const f of readdirSync(join(root, "src", "routes")).filter((n) => n.endsWith(".ts"))) {
    const src = readFileSync(join(root, "src", "routes", f), "utf8");
    for (const m of src.matchAll(/req\.query\.(\w+)/g)) found.add(m[1]);
    for (const m of src.matchAll(/upload\.(?:array|single)\("(\w+)"/g)) found.add(m[1]);
    for (const line of src.split("\n").filter((l) => /req\.body/.test(l))) {
      const m = /req\.body[^\n]*?\)\??\.(\w+)/.exec(line);
      assert.ok(m, `a req.body read this test cannot parse, in ${f}:\n  ${line.trim()}`);
      found.add(m[1]);
    }
  }
  assert.ok(found.size >= 7, `only ${found.size} inputs found; the patterns above stopped matching`);
  const listed = new Set(lib.INPUTS.map((i) => i.field).filter(Boolean));
  assert.deepEqual([...found].filter((f) => !listed.has(f)).sort(), [], "a route reads an input the page does not list");
});

// axe has no rule for a data table without column headers, so this checks it directly.
test("the settings and inputs tables all have column headers, and say the settings in words", async () => {
  const { deploymentSettings } = await import("../src/routes/settings.ts");
  const st = deploymentSettings({
    server: { port: 1, base_url: "x" },
    storage: { data_dir: "/d", agents_dir: join(root, "agents"), database: "/d/db" },
    providers: { default: "openrouter", openrouter: { default_model: "m-1" } },
    defaults: { max_review_iterations: 2, extraction_concurrency: 5, max_concurrent_runs: 2, recheck_sample_size: 1 },
  } as never);
  const html = lib.settingsHtml(st, { max_pages: 25 }) + lib.inputsHtml();
  const tables = html.split("<table>").slice(1);
  assert.ok(tables.length >= 3, "the core, specialist and inputs tables");
  for (const t of tables) assert.match(t.slice(0, t.indexOf("</table>")), /<thead><tr><th scope="col">/);
  for (const words of ["Up to 2 review rounds per document.", "Up to 5 pages read at the same time.", "Up to 25 pages per document."]) assert.ok(html.includes(words), words);
});
test("the process panel says each step's state, count and time", () => {
  const t = (s: number) => new Date(Date.UTC(2026, 9, 25, 12, 0, s)).toISOString();
  const ev = [
    { type: "run_start", ts: t(0), images: 2 },
    { type: "agent_call", agent: "page.md", image: "a-p1.png", ts: t(10) },
  ];
  const mid = lib.processSteps(ev, { status: "running", phase: "extraction", image_count: 2 }, { maxRounds: 2, now: Date.parse(t(30)) });
  const by = Object.fromEntries(mid.map((x) => [x.key, x]));
  assert.equal(by.read.state, "working");
  assert.equal(by.read.detail, "1 of 2 written");
  assert.equal(by.read.seconds, 30);
  assert.equal(by.review.state, "waiting");
  const done = lib.processSteps([...ev,
    { type: "page_extraction_failed", page: 2, ts: t(40) },
    { type: "extraction_complete", ts: t(50) },
    { type: "assembly", lint_ok: true, violations: 0, ts: t(52) },
    { type: "phase", phase: "review", ts: t(53) },
    { type: "reader", ts: t(60) },
    { type: "run_complete", unresolved: 3, ts: t(70) },
  ], { status: "ready_for_review", phase: "done", image_count: 2 }, { maxRounds: 2, pdfOn: true });
  const d = Object.fromEntries(done.map((x) => [x.key, x]));
  assert.equal(d.read.state, "problem", "a lost page is a problem, said in words");
  assert.equal(d.review.detail, "round 1 of 2");
  assert.equal(d.result.detail, "3 left open");
  assert.equal(d.result.seconds, 70);
  assert.deepEqual([d.pdf.state, d.pdf.detail], ["waiting", "not asked for"]);
});

// The report iris-pdf 0.1.0 returned for a one-page document on UIC (2026-10-25).
const REPORT = {
  tool: "iris-pdf 0.1.0",
  source: { pages: 1, encrypted: false, signed: false, acroform: false, xfa: false, hadTextLayer: [1] },
  pages: [{ page: 1, textSource: "pdf-text", words: 7, matched: 7, addedFromHtml: 0, furniture: 0, lost: 0, redrawn: 0, mcids: 2 }],
  structure: { elements: 3, byType: { Document: 1, H1: 1, P: 1 } },
  form: { fields: 0, set: 0, skippedReadOnly: 0, unresolved: [], created: [] },
  verification: { pixels: "identical-outside-fields", differingPixels: 0, textPreserved: true },
  pdfua: { checked: false },
  sizeIncreaseBytes: 1932,
  warnings: [{ code: "font_not_embedded", detail: "Helvetica; the output does not claim PDF/UA-1." }],
};

test("iris-pdf's report is shown as its four steps, with warnings in plain words", () => {
  const h = lib.pdfReportHtml(REPORT);
  for (const part of ["a. Read the PDF", "b. Match the words", "c. Tag and fill", "d. Check, then save", "identical, apart from form fields", "3 structure elements: Document 1, H1 1, P 1", lib.PDF_WARN.font_not_embedded]) {
    assert.ok(h.includes(part), part);
  }
  assert.ok(!h.includes(">font_not_embedded<"), "a known code is not shown raw");
  const thin = lib.pdfReportHtml({ warnings: [{ code: "new_code" }] });
  assert.ok(thin.includes("new_code"), "an unknown code is shown as it is");
  assert.ok(!/pages|Pixels|word kept|structure element/.test(thin), "a field the report lacks is left out, not shown as a default");
});


test("iris-pdf's detailed report shows the tree, the unmatched words with their reasons, the fields and timing", () => {
  const h = lib.pdfReportHtml({
    ...REPORT,
    detail: {
      structure: { type: "Document", kids: [{ type: "H1", page: 1, text: "Quarterly Report" }, { type: "Figure", page: 1, alt: "A chart" }, { type: "Form", page: 1, field: "full-name" }] },
      structureTruncated: true,
      pages: [{ page: 1, matched: 5, furniture: { count: 2, words: ["Page", "1"] }, added: { count: 0, words: [] }, lost: { count: 51, words: ["x"] }, redrawn: { count: 0, words: [] }, differingPixels: 0, textKept: true }],
      fields: { created: [{ name: "full-name", type: "text", page: 1, box: [1, 2, 3, 4], label: "Full name" }], unresolved: [{ name: "sig", code: "field_not_placed" }] },
      timing: { open: 1, match: 3 },
    },
  });
  for (const part of ["open 1 ms, match 3 ms", "Page furniture", "(Page 1)", "Page words not in the HTML", "(x …)", "<code>H1</code>", "alt: “A chart”", "field full-name", "Cut short", "beside “Full name”", lib.PDF_WARN.field_not_placed]) {
    assert.ok(h.includes(part), part);
  }
  assert.ok(!h.includes("Words that could not be tagged in place"), "a kind with no words is left out");
  const bare = lib.pdfReportHtml({ detail: { structure: null, pages: [{ page: 2, lost: { count: 1, words: ["z"] } }] } });
  assert.ok(!bare.includes("undefined"), "a page without `matched` leaves it out");
  assert.ok(bare.includes("Page 2: 1 kind of difference"));
});
