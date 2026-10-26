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
   const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); const AI = ''; const CODE = '';
   const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
   ${pure}
   return { md, apiGroups, fieldRows, apiHtml, feedbackFormHtml, firstSummary, changeSummary, stageSettings, modelFor, usageByStage, usageLine, settingsHtml, processSteps, pdfReportHtml, PDF_WARN, parseLog, parseReply, explain, SAY, runsOf, pagesFrom, roundsFrom, problems, unresolvedFrom, stagesFrom, curl };`,
)(index) as {
  parseLog(t: string): Record<string, unknown>[];
  parseReply(o: unknown): Record<string, unknown> | null;
  explain(e: Record<string, unknown>): string;
  SAY: Record<string, unknown>;
  settingsHtml(st: unknown, limits?: unknown, stats?: unknown): string;
  feedbackFormHtml(): string;
  apiGroups(spec: unknown): { tag: string; ops: { method: string; path: string; auth: string; params: { name: string }[]; body: { name: string }[] }[] }[];
  fieldRows(spec: unknown, schema: unknown, value: unknown): { path: string; value: string; meaning: string }[];
  apiHtml(spec: unknown): string;
  md(t: string): string;
  firstSummary(steps: unknown[], id: string, uploaded: boolean): string;
  changeSummary(prev: Map<string, string>, steps: unknown[]): string[];
  stageSettings(key: string, ev: unknown[], st: unknown, limits: unknown, session: unknown): string;
  modelFor(ev: unknown[], st: unknown, agent: string, step: string, cap: string): string | null;
  usageByStage(ev: unknown[], st?: unknown): Record<string, { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; ms: number; cost: number; unpriced: Set<string> }>;
  usageLine(u: unknown, label?: string): string;
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

// The API section is built from docs/openapi.yaml, so every input a route reads must be in it.
const spec = (await import("yaml")).parse(readFileSync(join(root, "docs", "openapi.yaml"), "utf8"));
test("every request field a route reads is an input in the OpenAPI document, in the same place", () => {
  // Where each read happens: a query string, a JSON body, or a multipart upload part.
  const found: [string, string][] = [];
  for (const f of readdirSync(join(root, "src", "routes")).filter((n) => n.endsWith(".ts"))) {
    const src = readFileSync(join(root, "src", "routes", f), "utf8");
    for (const m of src.matchAll(/req\.query\.(\w+)/g)) found.push(["query", m[1]]);
    for (const m of src.matchAll(/upload\.(?:array|single)\("(\w+)"/g)) found.push(["body", m[1]]);
    for (const line of src.split("\n").filter((l) => /req\.body/.test(l))) {
      const m = /req\.body[^\n]*?\)\??\.(\w+)/.exec(line);
      assert.ok(m, `a req.body read this test cannot parse, in ${f}:\n  ${line.trim()}`);
      found.push(["body", m[1]]);
    }
  }
  assert.ok(found.length >= 7, `only ${found.length} inputs found; the patterns above stopped matching`);
  const ops = lib.apiGroups(spec).flatMap((g) => g.ops) as unknown as { params: { name: string; in: string }[]; body: { name: string }[] }[];
  const listed = new Set(ops.flatMap((o) => [...o.params.filter((p) => p.in === "query").map((p) => "query " + p.name), ...o.body.map((b) => "body " + b.name)]));
  assert.deepEqual(found.map(([w, n]) => w + " " + n).filter((x) => !listed.has(x)).sort(), [], "a route reads an input the API section does not show where it is read");
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
  const html = lib.settingsHtml(st, { max_pages: 25 });
  const tables = html.split("<table>").slice(1);
  assert.ok(tables.length >= 2, "the core and specialist tables");
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
      pages: [{ page: 1, matched: { count: 5, words: ["Quarterly", "Report"] }, furniture: { count: 2, words: ["Page", "1"] }, added: { count: 0, words: [] }, lost: { count: 51, words: ["x"] }, redrawn: { count: 0, words: [] }, differingPixels: 0, textKept: true }],
      fields: { created: [{ name: "full-name", type: "text", page: 1, box: [1, 2, 3, 4], label: "Full name" }], unresolved: [{ name: "sig", code: "field_not_placed" }] },
      timing: { open: 1, match: 3 },
    },
  });
  assert.ok(h.includes("Page 1: 5 words matched"), "the matched count, from iris-pdf's {count, words}");
  for (const part of ["open 1 ms, match 3 ms", "Page furniture", "(Page 1)", "Page words not in the HTML", "(x …)", "<code>H1</code>", "alt: “A chart”", "field full-name", "Cut short", "beside “Full name”", lib.PDF_WARN.field_not_placed]) {
    assert.ok(h.includes(part), part);
  }
  assert.ok(!h.includes("Words that could not be tagged in place"), "a kind with no words is left out");
  const bare = lib.pdfReportHtml({ detail: { structure: null, pages: [{ page: 2, lost: { count: 1, words: ["z"] } }] } });
  assert.ok(!bare.includes("undefined"), "a page without `matched` leaves it out");
  assert.ok(bare.includes("Page 2: 1 kind of difference"));
});

test("tokens and model time are counted per step, from the step that was running", () => {
  const call = (input: number, output: number, ms: number) => ({ type: "model_call", ok: true, input_tokens: input, output_tokens: output, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, duration_ms: ms });
  const u = lib.usageByStage([
    { type: "phase", phase: "extraction" }, call(100, 50, 1000), call(100, 50, 1000),
    { type: "phase", phase: "assembly" }, call(5, 5, 500),
    { type: "phase", phase: "review" }, call(1000, 200, 3000),
  ]);
  assert.deepEqual([u.pages.calls, u.pages.input, u.pages.output, u.join.calls, u.review.output, u.total.calls, u.total.cacheRead], [2, 200, 100, 1, 200, 4, 40]);
  assert.match(lib.usageLine(u.total), /4 model calls · 1,205 tokens in, 305 out · cache: 40 read, 0 written · 6 s of model time/);
  assert.equal(lib.usageLine(u.join && { ...u.join, calls: 0 }), "", "a step with no calls shows nothing");
});

test("each step's Settings line names its caps and models, the run's model before the configured one", async () => {
  const { deploymentSettings } = await import("../src/routes/settings.ts");
  const st = deploymentSettings({
    server: { port: 1, base_url: "x", audit: true },
    storage: { data_dir: "/d", agents_dir: join(root, "agents"), database: "/d/db", session_retention_days: 30 },
    providers: { default: "openrouter", per_agent: { page: { model: "us.page-model" } }, openrouter: { default_model: "configured-model" } },
    defaults: { max_review_iterations: 2, extraction_concurrency: 5, max_concurrent_runs: 2, recheck_sample_size: 1 },
  } as never);
  // Before a call: the configured model, with the `us.` prefix dropped.
  assert.equal(lib.modelFor([], st, "page", "extract", "vision"), "page-model");
  // After one: the model the run's log says it used.
  const ev = [{ type: "model_call", agent: "page", step: "extract", model: "us.used-model" }];
  assert.equal(lib.modelFor(ev, st, "page", "extract", "vision"), "used-model");
  const pages = lib.stageSettings("pages", ev, st, null, null);
  for (const part of ["up to 5 pages at a time", "page agent: used-model", "checker: configured-model", "a failed page is fixed once", "1 fixed page checked again", "12 specialist agents available"]) assert.ok(pages.includes(part), part);
  // The session's own cap wins over the deployment's: it was fixed when the session was made.
  assert.ok(lib.stageSettings("review", [], st, null, { iterations_max: 3 }).includes("up to 3 rounds"));
  assert.ok(lib.stageSettings("review", [], st, null, null).includes("up to 2 rounds"));
  assert.ok(lib.stageSettings("result", [], st, null, null).includes("files kept 30 days"));
  assert.ok(lib.stageSettings("join", [], st, null, null).includes("colour contrast is not checked"));
});

test("the status region says when a session opens failed, finished or working, and then only what changed", () => {
  const failed = lib.processSteps([{ type: "run_start" }], { status: "failed", phase: "extraction", image_count: 2 }, {});
  assert.match(lib.firstSummary(failed, "ses_X", false), /^Opened session ses_X\. 1 of 7 steps done\. Result: problem, the run failed\.$/);
  const done = lib.processSteps([{ type: "run_start" }, { type: "extraction_complete" }, { type: "assembly", lint_ok: true }, { type: "reader" }, { type: "run_complete", unresolved: 3 }], { status: "ready_for_review", phase: "done", image_count: 2 }, {});
  assert.match(lib.firstSummary(done, "ses_Y", true), /^Uploaded\. Session ses_Y\. .* Finished: 3 left open\.$/);
  const mid = lib.processSteps([{ type: "run_start" }], { status: "running", phase: "extraction", image_count: 2 }, {});
  assert.match(lib.firstSummary(mid, "ses_Z", false), /Working now: Read each page\./);
  // Ready, but the run's last line is not written yet: no dangling "Finished: ."
  const early = lib.processSteps([{ type: "run_start" }, { type: "extraction_complete" }], { status: "ready_for_review", phase: "done", image_count: 2 }, {});
  assert.ok(!lib.firstSummary(early, "ses_W", false).includes("Finished"));
  // An update says only the steps that changed.
  const prev = new Map(mid.map((x) => [x.key, x.state]));
  const next = lib.processSteps([{ type: "run_start" }, { type: "extraction_complete" }], { status: "running", phase: "assembly", image_count: 2 }, {});
  assert.deepEqual(lib.changeSummary(prev, next), ["Read each page: done, 0 of 2 written.", "Check each page: done.", "Working now: Join and check."]);
  assert.deepEqual(lib.changeSummary(new Map(next.map((x) => [x.key, x.state])), next), [], "nothing changed, nothing said");
});

test("cost is estimated from each call's model price, and an unpriced model or cache kind is named, not counted free", () => {
  const st = { providers: { blocks: { bedrock: { prices: { "us.sonnet": { input: 3.3, output: 16.5, cache_read: 0.33, cache_write: 4.125 }, "us.luna": { input: 0.22, output: 1.32 } } } } } };
  const call = (model: string, i: number, o: number, cr = 0, cw = 0) => ({ type: "model_call", provider: "bedrock", model, input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw, duration_ms: 1000 });
  const u = lib.usageByStage([
    { type: "phase", phase: "extraction" }, call("us.luna", 1_000_000, 1_000_000),
    { type: "phase", phase: "review" }, call("us.sonnet", 1_000_000, 0, 1_000_000, 1_000_000), call("us.other", 5, 5),
  ], st);
  assert.ok(Math.abs(u.pages.cost - 1.54) < 1e-9, "luna: $0.22 in + $1.32 out");
  assert.ok(Math.abs(u.review.cost - (3.3 + 0.33 + 4.125)) < 1e-9, "sonnet with both cache prices");
  assert.deepEqual([...u.review.unpriced], ["other"], "a model with no price is named");
  assert.match(lib.usageLine(u.pages), /about \$1\.54$|about \$1\.54</);
  assert.match(lib.usageLine(u.review), /at least \$7\.75, not counting other \(no price set\)/);
  // Luna has no cache prices, so its cache tokens are named rather than costed as zero.
  const c = lib.usageByStage([call("us.luna", 0, 0, 10, 10)], st);
  assert.deepEqual([...c.total.unpriced], ["luna cache reads", "luna cache writes"]);
  // No prices at all: tokens, and a plain "cost unknown".
  assert.match(lib.usageLine(lib.usageByStage([call("us.x", 1, 1)], null).total), /cost unknown: no price set for x/);
});

test("a cost under a cent says so plainly", () => {
  const st = { providers: { blocks: { p: { prices: { m: { input: 1, output: 1 } } } } } };
  const u = lib.usageByStage([{ type: "model_call", provider: "p", model: "m", input_tokens: 10, output_tokens: 10, duration_ms: 1 }], st);
  assert.match(lib.usageLine(u.total), / · under \$0\.01<\/p>$/);
});

test("a call that reported no tokens is named, and the cost becomes a minimum or unknown", () => {
  const st = { providers: { blocks: { p: { prices: { m: { input: 1, output: 1 } } } } } };
  const ok = { type: "model_call", provider: "p", model: "m", input_tokens: 1_000_000, output_tokens: 0, duration_ms: 1 };
  const silent = { type: "model_call", provider: "p", model: "m", duration_ms: 1 };
  assert.match(lib.usageLine(lib.usageByStage([ok, silent], st).total), /at least \$1\.00 · 1 call reported no tokens, so the cost is a minimum/);
  const none = lib.usageLine(lib.usageByStage([silent], st).total);
  assert.match(none, /1 call reported no tokens, so the cost is not known/);
  assert.ok(!none.includes("$"), "no dollar figure when nothing was reported");
});

test("the deployment section lists each model's prices and says costs are estimates", async () => {
  const { deploymentSettings } = await import("../src/routes/settings.ts");
  const st = deploymentSettings({
    server: { port: 1, base_url: "x" },
    storage: { data_dir: "/d", agents_dir: join(root, "agents"), database: "/d/db" },
    providers: { default: "bedrock", bedrock: { default_model: "us.m", prices: { "us.m": { input: 3.3, output: 16.5, cache_read: 0.33, cache_write: 4.125 } } } },
    defaults: { max_review_iterations: 2, extraction_concurrency: 5, max_concurrent_runs: 2, recheck_sample_size: 1 },
  } as never);
  const h = lib.settingsHtml(st, null, null);
  assert.ok(h.includes("m: $3.3 in, $16.5 out, $0.33 cache read, $4.125 cache write per million tokens"), h);
  assert.ok(h.includes("Costs on this page are estimates from the prices above"));
});

test("a feedback re-run shows what it kept and what it redid", () => {
  const by = (steps: { key: string; state: string; detail: string }[]) => Object.fromEntries(steps.map((x) => [x.key, x]));
  const doc = by(lib.processSteps([
    { type: "feedback_scoped", target: "document", pages: [], reason: "about tone" },
    { type: "run_start", feedback: "use plainer words" },
    { type: "phase", phase: "review" }, { type: "reader" },
  ], { status: "running", phase: "review", image_count: 6 }, {}) as never);
  assert.deepEqual([doc.upload.state, doc.upload.detail], ["done", "review again, pages kept"]);
  assert.deepEqual([doc.read.state, doc.read.detail, doc.check.state], ["skipped", "kept from the run before", "skipped"]);
  assert.deepEqual([doc.join.state, doc.join.detail], ["done", "axe re-checked the kept document"]);
  const ext = by(lib.processSteps([
    { type: "feedback_scoped", target: "extraction", pages: [2], reason: "names page 2" },
    { type: "run_start", feedback: "the total on page 2 is wrong" },
    { type: "reextract_start", pages: [2], of: 6 },
    { type: "agent_call", agent: "page.md", image: "d-p2.png" },
    { type: "reextract_complete", pages: [2] },
  ], { status: "running", phase: "assembly", image_count: 6 }, {}) as never);
  assert.deepEqual([ext.upload.detail, ext.read.state, ext.read.detail], ["re-read page 2", "done", "1 of 1 re-read"]);
  assert.match(lib.explain({ type: "feedback_scoped", target: "extraction", pages: [2], reason: "names page 2" }), /re-reads page 2 from their images \(names page 2\)/);
});

test("the feedback form has a label, a hint that says it may be quoted publicly, and a submit button", () => {
  const h = lib.feedbackFormHtml();
  assert.match(h, /<label for="feedback-text">/);
  assert.match(h, /<input id="feedback-text" type="text" aria-describedby="feedback-hint"/);
  assert.match(h, /public “agent suggestion” issue/);
  assert.match(h, /<button id="feedback-btn" type="submit"/);
});

test("an axe check that could not run on a re-run is a problem to look at", () => {
  assert.deepEqual(lib.problems([{ type: "lint_unavailable", stage: "feedback_relint", lint_error: "boom" }]).map((p) => [p.level, p.text]), [["high", "axe-core could not check the document (feedback relint), so it was delivered unchecked: boom"]]);
});

test("a re-read page that keeps its earlier version is not reported as lost", () => {
  const steps = lib.processSteps([
    { type: "feedback_scoped", target: "extraction", pages: [2] }, { type: "run_start", feedback: "fix page 2" },
    { type: "reextract_start", pages: [2], of: 6 }, { type: "page_extraction_failed", page: 2, kept: "prior", error: "cut off" },
    { type: "reextract_complete", pages: [], failed: [2] },
  ], { status: "running", phase: "assembly", image_count: 6 }, {});
  const read = steps.find((x) => x.key === "read")!;
  assert.equal(read.state, "done");
  assert.match(read.detail, /1 kept the earlier version/);
  assert.deepEqual(lib.problems([{ type: "page_extraction_failed", page: 2, kept: "prior", error: "cut off" }]).map((p) => p.level), ["info"]);
});

test("while feedback is being routed, the panel says so and nothing else runs yet", () => {
  const steps = lib.processSteps([], { status: "running", phase: "extraction", image_count: 6 }, { pendingFeedback: true });
  assert.deepEqual(steps.map((x) => [x.key, x.state]), [["upload", "working"], ["read", "waiting"], ["check", "waiting"], ["join", "waiting"], ["review", "waiting"], ["result", "waiting"], ["pdf", "skipped"]]);
  assert.equal(steps[0].detail, "deciding what to redo");
});

test("the API section shows every operation in the document, grouped, with who may call it", () => {
  const groups = lib.apiGroups(spec);
  const shown = groups.flatMap((g) => g.ops.map((o) => o.method + " " + o.path));
  const inDoc = Object.entries(spec.paths as Record<string, object>).flatMap(([p, ops]) => Object.keys(ops).map((m) => m.toUpperCase() + " " + p));
  assert.deepEqual(shown.sort(), inDoc.sort());
  const op = (m: string, p: string) => groups.flatMap((g) => g.ops).find((o) => o.method === m && o.path === p)!;
  assert.deepEqual([op("GET", "/v1/stats").auth, op("GET", "/v1/sessions").auth, op("GET", "/v1/quality").auth], ["open", "key", "quality"]);
  const h = lib.apiHtml(spec);
  assert.equal((h.match(/<details data-k="api/g) || []).length, inDoc.length, "one card per operation");
  assert.match(h, /<label for="quality-token">[^<]+<\/label><p class="hint" id="qt-hint">[^<]*never stored, logged or shown/);
  assert.ok(!/Bearer (?!YOUR_QUALITY_TOKEN)/.test(h), "a curl never holds a real token");
});

test("an answer is explained field by field from the document's descriptions", () => {
  const schema = spec.paths["/v1/stats"].get.responses["200"].content["application/json"].schema;
  const rows = lib.fieldRows(spec, schema, { pages_processed: 40125, documents_processed: 6723, since: "2026-08-12T00:00:00Z", quality: { window_days: 30, clean_rate: 0.37 } });
  const by = Object.fromEntries(rows.map((r) => [r.path, r]));
  assert.equal(by.pages_processed.value, "40125");
  assert.match(by.pages_processed.meaning, /Pages delivered/);
  assert.match(by["quality.clean_rate"].meaning, /nothing left open/);
  assert.equal(lib.apiHtml(null), "<p>This deployment did not serve its API description.</p>");
});

test("backticked code in the document's descriptions shows as code, and nothing else becomes markup", () => {
  assert.equal(lib.md("`null` on the <b>last</b> page"), "<code>null</code> on the &lt;b&gt;last&lt;/b&gt; page");
});

test("an answer inside an array is explained from the item schema", () => {
  const schema = spec.paths["/v1/sessions"].get.responses["200"].content["application/json"].schema;
  const rows = lib.fieldRows(spec, schema, { sessions: [{ session_id: "ses_1", status: "queued" }], next_cursor: null });
  assert.match(rows.find((r) => r.path === "sessions[0].status")!.meaning, /waits for a free slot/);
});

test("the API section, rendered, passes the same axe check", async () => {
  const html = howItWorksPage(page, apiMd).replace('<div id="api-body"><p>Loading…</p></div>', '<div id="api-body">' + lib.apiHtml(spec) + "</div>");
  assert.ok(html.includes('data-k="api0"'), "the section was put in the page");
  const r = await runAxe(html);
  assert.deepEqual(r.violations, []);
});
