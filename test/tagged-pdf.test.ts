// The optional tagged-PDF output (src/util/taggedPdf.ts). `iris-pdf` is a separate
// project, so these tests run a stand-in for it (test/fixtures/fake-iris-pdf.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { IrisConfig } from "../src/config.ts";
import type { AuthedRequest } from "../src/auth/middleware.ts";
import { keepSourcePdf, sessionsRouter } from "../src/routes/sessions.ts";
import { limitsRouter } from "../src/routes/limits.ts";
import { Store } from "../src/store/db.ts";
import { Paths } from "../src/store/paths.ts";
import { clearPdfScratch, taggedPdfCommand, taggedPdfStatus } from "../src/util/taggedPdf.ts";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-iris-pdf.mjs");
const USER = 7;

function cfg(dir: string, command?: string, timeout_seconds?: number): IrisConfig {
  return {
    server: { port: 3000, base_url: "http://localhost:3000" },
    storage: { data_dir: dir, agents_dir: "agents", database: join(dir, "iris.sqlite") },
    tagged_pdf: { command, timeout_seconds },
    github: { token: "ghp_test", upstream_repo: "https://github.com/o/r", api_base_url: "https://api.github.com" },
    providers: { default: "openrouter", openrouter: { api_key: "k", default_model: "anthropic/claude-sonnet-4.6" } },
    defaults: { max_review_iterations: 1, extraction_concurrency: 2, max_concurrent_runs: 1, recheck_sample_size: 1 },
  };
}

// A session made from one PDF, finished, with two extracted pages.
async function serve(opts: { command?: string; source?: string | null; status?: string; timeout?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "iris-tagged-pdf-"));
  const config = cfg(dir, "command" in opts ? opts.command : FAKE, opts.timeout);
  const store = new Store(config.storage.database);
  const paths = new Paths(config);
  const id = "ses_pdf_1";
  store.createSession({ session_id: id, github_user_id: USER, image_count: 2, iterations_max: 1 });
  store.updateSession(id, { status: (opts.status ?? "ready_for_review") as "ready_for_review" });
  paths.initSession(id);
  writeFileSync(paths.sessionSourceName(id), "permit");
  if (opts.source !== null) writeFileSync(paths.sessionSourcePdf(id), opts.source ?? "%PDF-1.7 source");
  const frag = (order: number, innerHtml: string) => ({ image: `p${order}.png`, order, agent: "page.md", region: "page", innerHtml, edges: [], log: "" });
  // Stored out of order on purpose: the pages must reach the tagger by page order.
  // Page 3 failed extraction, so it holds only its note.
  const pages = [frag(2, "<p>two</p>"), frag(3, "<!-- @page-failed 3: timeout -->"), frag(1, "<h1>one</h1>")];
  writeFileSync(paths.sessionFinalFragments(id), JSON.stringify({ fragments: pages, body: "" }));
  writeFileSync(paths.sessionOutput(id), '<!DOCTYPE html><html lang="fr"><head><title>x</title></head><body></body></html>');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as AuthedRequest).user = { github_user_id: USER, github_login: "t", max_review_iterations: 1 } as AuthedRequest["user"];
    next();
  });
  app.use("/v1/sessions", sessionsRouter(config, store));
  app.use("/v1/limits", limitsRouter(config));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return {
    config,
    paths,
    id,
    fields: () => fetch(`${base}/sessions/${id}/fields`),
    tag: (body: unknown) =>
      fetch(`${base}/sessions/${id}/pdf`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    limits: () => fetch(`${base}/limits`),
    close: () => {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("tagged PDFs are off unless the command is set and runs", () => {
  const dir = tmpdir();
  assert.equal(taggedPdfCommand(cfg(dir)), null);
  assert.equal(taggedPdfCommand(cfg(dir, "")), null);
  assert.equal(taggedPdfStatus(cfg(dir)), null, "blank says nothing at startup");
  assert.equal(taggedPdfCommand(cfg(dir, "/nonexistent/iris-pdf")), null);
  assert.match(taggedPdfStatus(cfg(dir, "/nonexistent/iris-pdf"))!, /^WARNING: .*did not run\. Tagged PDFs are off\.$/);
  // A command that runs but is not iris-pdf is not taken for it.
  assert.equal(taggedPdfCommand(cfg(dir, "true")), null);
  assert.equal(taggedPdfCommand(cfg(dir, FAKE)), FAKE);
  assert.equal(taggedPdfStatus(cfg(dir, FAKE)), "Tagged PDFs on (iris-pdf 0.0.0-fake).");
});

test("GET /v1/limits says whether tagged PDFs are on", async () => {
  for (const [command, on] of [[FAKE, true], [undefined, false]] as const) {
    const s = await serve({ command });
    try {
      assert.equal((await (await s.limits()).json()).tagged_pdf, on);
    } finally {
      s.close();
    }
  }
});

test("the upload is kept only when tagged PDFs are on and it is one PDF", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-keep-"));
  try {
    const pdf = { originalname: "a.pdf", buffer: Buffer.from("%PDF") };
    const png = { originalname: "b.png", buffer: Buffer.from("png") };
    const cases = [
      [FAKE, [pdf], true],
      [undefined, [pdf], false],
      [FAKE, [pdf, pdf], false],
      [FAKE, [png], false],
      [FAKE, [pdf, png], false],
    ] as const;
    cases.forEach(([command, files, kept], i) => {
      const config = cfg(dir, command);
      const paths = new Paths(config);
      const id = `ses_keep_${i}`;
      paths.initSession(id);
      assert.equal(keepSourcePdf(config, paths, id, [...files]), kept, `case ${i}`);
      assert.equal(existsSync(paths.sessionSourcePdf(id)), kept, `case ${i}`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // And the upload route is what calls it, after the session directory exists.
  const route = readFileSync(join(dirname(FAKE), "..", "..", "src", "routes", "sessions.ts"), "utf8");
  const handler = route.slice(route.indexOf('r.post("/", '), route.indexOf("store.createSession("));
  assert.match(handler, /paths\.initSession\(sessionId\);[\s\S]*keepSourcePdf\(cfg, paths, sessionId, files\);/);
});

test("GET /fields passes the PDF's fields through", async () => {
  const s = await serve();
  try {
    const res = await s.fields();
    assert.equal(res.status, 200);
    const { fields } = await res.json();
    assert.deepEqual(fields.map((f: { name: string }) => f.name), ["applicant.name", "applicant.consent"]);
  } finally {
    s.close();
  }
});

test("a deployment without the command, or a session without a PDF, says so", async () => {
  const off = await serve({ command: undefined });
  try {
    const res = await off.fields();
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "tagged_pdf_unavailable");
    assert.equal((await off.tag({})).status, 404);
  } finally {
    off.close();
  }
  const images = await serve({ source: null });
  try {
    const res = await images.tag({});
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, "no_source_pdf");
  } finally {
    images.close();
  }
});

test("POST /pdf tags the pages in page order, leaves out a failed page, fills the values, and keeps nothing", async () => {
  const s = await serve();
  try {
    const res = await s.tag({ values: { "applicant.name": "Ada Lovelace", "applicant.consent": true } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.filename, "permit_tagged.pdf");
    assert.deepEqual(body.report.warnings, [{ code: "duplicate_text_layer", page: 1 }]);
    const made = JSON.parse(Buffer.from(body.pdf, "base64").toString("utf8").replace(/^%PDF-fake /, ""));
    assert.equal(made.source, "%PDF-1.7 source");
    assert.deepEqual(made.input, {
      lang: "fr",
      title: "permit",
      pages: [{ sourcePage: 1, html: "<h1>one</h1>" }, { sourcePage: 2, html: "<p>two</p>" }],
    });
    assert.deepEqual(made.values, { "applicant.name": "Ada Lovelace", "applicant.consent": true });
    assert.equal(made.mode, "600", "only this process can read the values file");
    // The values, and the filled PDF, are gone once the answer is sent.
    assert.equal(existsSync(made.scratch), false);
    assert.equal(dirname(made.scratch).startsWith(s.paths.pdfScratchRoot()), true);
    assert.deepEqual(readdirSync(s.paths.pdfScratchRoot()).filter((f) => f.startsWith("pdf-")), []);
    const log = readFileSync(s.paths.sessionLog(s.id), "utf8");
    assert.match(log, /"tagged_pdf"/);
    assert.match(log, /applicant\.name/, "the field names are logged");
    assert.doesNotMatch(log, /Ada Lovelace/, "the values are not");
  } finally {
    s.close();
  }
});

test("POST /pdf passes the tagger's refusals on with its code", async () => {
  const s = await serve();
  try {
    const bad = await s.tag({ values: { "unknown.field": "x" } });
    assert.equal(bad.status, 400);
    const { error } = await bad.json();
    assert.deepEqual([error.code, error.message], ["bad_value", "No field is named unknown.field."]);
    assert.equal((await s.tag({ values: ["x"] })).status, 400);
    // A crash inside the tagger can quote a value. The client sent it, so it may see it
    // again, but the log does not keep it.
    const crash = await s.tag({ values: { crash: "Jane Doe" } });
    assert.equal((await crash.json()).error.code, "internal_error");
    const log = readFileSync(s.paths.sessionLog(s.id), "utf8");
    assert.match(log, /"tagged_pdf_failed".*"bad_value".*No field is named unknown\.field/);
    assert.doesNotMatch(log, /Jane Doe/);
  } finally {
    s.close();
  }
  const locked = await serve({ source: "%PDF ENCRYPTED" });
  try {
    const res = await locked.tag({});
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.code, "encrypted");
    assert.equal((await locked.fields()).status, 422);
  } finally {
    locked.close();
  }
});

test("POST /pdf waits for the finished document and stops a run that takes too long", async () => {
  const running = await serve({ status: "running" });
  try {
    assert.equal((await running.tag({})).status, 409);
  } finally {
    running.close();
  }
  const slow = await serve({ timeout: 0.5 });
  try {
    const res = await slow.tag({ values: { slow: true } });
    assert.equal(res.status, 504);
    assert.equal((await res.json()).error.code, "timeout");
    assert.deepEqual(readdirSync(slow.paths.pdfScratchRoot()).filter((f) => f.startsWith("pdf-")), []);
  } finally {
    slow.close();
  }
});

test("two tagger runs at once, across both routes, and a third is told to wait", async () => {
  const s = await serve();
  const slow = [s.tag({ values: { slow: true } }), s.tag({ values: { slow: true } })];
  try {
    await new Promise((r) => setTimeout(r, 300));
    for (const res of [await s.tag({}), await s.fields()]) {
      const body = await res.json();
      assert.equal(res.status, 503);
      assert.equal(res.headers.get("retry-after"), "10");
      assert.equal(body.error.code, "busy");
    }
    for (const res of await Promise.all(slow)) assert.equal(res.status, 200);
    const after = await s.fields();
    await after.body?.cancel();
    assert.equal(after.status, 200, "the count goes back down");
  } finally {
    await Promise.allSettled(slow.map(async (p) => (await p).body?.cancel()));
    s.close();
  }
});

test("startup removes the scratch a killed process left, and nothing else", () => {
  const root = mkdtempSync(join(tmpdir(), "iris-scratch-"));
  try {
    mkdirSync(join(root, "pdf-abc123"));
    writeFileSync(join(root, "pdf-abc123", "values.json"), "{}");
    mkdirSync(join(root, "ses_keep"));
    assert.equal(clearPdfScratch(root), 1);
    assert.deepEqual(readdirSync(root), ["ses_keep"]);
    assert.equal(clearPdfScratch(join(root, "missing")), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  // And startup runs it on the root the routes use, before it listens.
  const index = readFileSync(join(dirname(FAKE), "..", "..", "src", "index.ts"), "utf8");
  const call = index.indexOf('clearPdfScratch(join(cfg.storage.data_dir, "tmp"))');
  assert.ok(call > 0 && call < index.indexOf("app.listen("));
});
