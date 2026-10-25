// Audit mode (config `server.audit`): the recorder (store/audit.ts), the prompt hook on the router
// (providers/index.ts) and the endpoints that serve what was kept (routes/audit.ts). The pipeline
// wiring is covered end to end by test/e2e.sh, which runs with audit mode on.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditOn, type IrisConfig } from "../src/config.ts";
import { auditRouter } from "../src/routes/audit.ts";
import { AuditRecorder, sha256 } from "../src/store/audit.ts";
import { Store } from "../src/store/db.ts";
import { Paths } from "../src/store/paths.ts";
import { RunLog } from "../src/store/runlog.ts";
import { ProviderRouter } from "../src/providers/index.ts";

function cfg(dir: string, audit?: boolean | string): IrisConfig {
  return {
    server: { port: 3000, base_url: "http://localhost:3000", ...(audit === undefined ? {} : { audit }) },
    storage: { data_dir: dir, agents_dir: "agents", database: join(dir, "iris.sqlite") },
    providers: { default: "openrouter", openrouter: { api_key: "k", default_model: "m" } },
    defaults: { max_review_iterations: 1, extraction_concurrency: 2, max_concurrent_runs: 1, recheck_sample_size: 1 },
  };
}

const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("audit mode is on only for true or \"true\"", () => {
  const dir = "/nonexistent";
  assert.equal(auditOn(cfg(dir)), false);
  assert.equal(auditOn(cfg(dir, false)), false);
  assert.equal(auditOn(cfg(dir, "")), false);
  assert.equal(auditOn(cfg(dir, "yes")), false);
  assert.equal(auditOn(cfg(dir, true)), true);
  assert.equal(auditOn(cfg(dir, " TRUE ")), true);
});

test("the recorder keeps each distinct prompt once, names images by hash, and numbers runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-audit-"));
  try {
    const log = new RunLog(join(dir, "log.jsonl"));
    const rec = new AuditRecorder(join(dir, "audit"), log);
    assert.equal(rec.run, 1);
    const img = { data: Buffer.from("png-bytes"), media_type: "image/png" };
    const a = rec.prompt([{ role: "system", content: "contract" }, { role: "user", content: "page 1" }], [img]);
    rec.prompt([{ role: "system", content: "contract" }, { role: "user", content: "page 2" }]);
    assert.deepEqual(a, {
      prompt: {
        messages: [
          { role: "system", sha256: sha256("contract"), chars: 8 },
          { role: "user", sha256: sha256("page 1"), chars: 6 },
        ],
        images: [{ media_type: "image/png", bytes: 9, sha256: sha256(Buffer.from("png-bytes")) }],
      },
    });
    // Three distinct texts, so three files: the contract is not written twice.
    assert.equal(readdirSync(join(dir, "audit", "prompts")).length, 3);
    assert.equal(readFileSync(join(dir, "audit", "prompts", `${sha256("page 2")}.txt`), "utf8"), "page 2");

    rec.snapshot("assembled", "<p>body</p>");
    assert.equal(readFileSync(join(dir, "audit", "runs", "1", "assembled.html"), "utf8"), "<p>body</p>");
    assert.deepEqual(
      lines(join(dir, "log.jsonl")).map(({ ts: _, ...e }) => e),
      [{ type: "audit_snapshot", run: 1, name: "assembled", chars: 11 }],
    );
    // A feedback re-run is the next run, and keeps the first run's snapshots. A run that saves
    // nothing still takes its number, so the one after it is run 3.
    assert.equal(new AuditRecorder(join(dir, "audit"), log).run, 2);
    assert.equal(new AuditRecorder(join(dir, "audit"), log).run, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a prompt that cannot be saved is still described, and does not throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-audit-ro-"));
  try {
    const rec = new AuditRecorder(join(dir, "audit"), new RunLog(join(dir, "log.jsonl")));
    rmSync(join(dir, "audit", "prompts"), { recursive: true });
    writeFileSync(join(dir, "audit", "prompts"), "not a folder");
    assert.deepEqual(rec.prompt([{ role: "user", content: "x" }]), {
      prompt: { messages: [{ role: "user", sha256: sha256("x"), chars: 1 }], images: [] },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the prompt goes on model_call_start only, and only when the hook is set", async () => {
  for (const hooked of [false, true]) {
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const router = new ProviderRouter(
      cfg("/nonexistent"),
      (type, data) => events.push({ type, data }),
      hooked ? (messages) => ({ prompt: { n: messages.length } }) : undefined,
    );
    (router as unknown as { cache: Map<string, unknown> }).cache.set("openrouter", {
      complete: async () => ({ text: "ok", model: "m", provider: "openrouter" }),
    });
    await router.complete("page", "text", [{ role: "user", content: "hi" }], { step: "extract" });
    assert.deepEqual(events.map((e) => e.type), ["model_call_start", "model_call"]);
    assert.deepEqual(events[0].data.prompt, hooked ? { n: 1 } : undefined);
    assert.equal(events[1].data.prompt, undefined, "the end line does not repeat the prompt");
  }
});

// A session on disk with one page, two working files and one snapshot, served by the audit router.
async function serve(audit: boolean, fn: (base: string, id: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "iris-audit-http-"));
  const config = cfg(dir, audit);
  const store = new Store(config.storage.database);
  const paths = new Paths(config);
  const id = "ses_audit_1";
  store.createSession({ session_id: id, image_count: 1, iterations_max: 1 });
  paths.initSession(id);
  writeFileSync(join(paths.sessionInput(id), "0001__report-p1.png"), "png-1");
  writeFileSync(paths.sessionLint(id), '{"ok":true}');
  writeFileSync(paths.sessionLog(id), "");
  mkdirSync(join(paths.sessionAudit(id), "runs", "1"), { recursive: true });
  writeFileSync(join(paths.sessionAudit(id), "runs", "1", "assembled.html"), "<script>x</script>");
  mkdirSync(join(paths.sessionAudit(id), "prompts"), { recursive: true });
  writeFileSync(join(paths.sessionAudit(id), "prompts", `${sha256("hello")}.txt`), "hello");
  const app = express();
  app.use("/v1/sessions", auditRouter(config, store));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/sessions`, id);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("with audit mode off, every audit route answers 404 audit_off", async () => {
  await serve(false, async (base, id) => {
    for (const path of ["audit", "audit/pages/1", "audit/files/lint.json", "audit/runs/1/assembled", `audit/prompts/${sha256("hello")}`]) {
      const res = await fetch(`${base}/${id}/${path}`);
      assert.equal(res.status, 404, path);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, "audit_off", path);
    }
  });
});

test("the audit list names the pages, files, snapshots and prompts, and each URL serves it", async () => {
  await serve(true, async (base, id) => {
    const m = (await (await fetch(`${base}/${id}/audit`)).json()) as {
      pages: { order: number; name: string; sha256: string; url: string }[];
      files: { name: string; url: string }[];
      runs: { run: number; snapshots: { name: string; url: string }[] }[];
      prompts: { count: number };
    };
    assert.deepEqual(m.pages.map((p) => [p.order, p.name, p.sha256]), [[1, "report-p1.png", sha256(Buffer.from("png-1"))]]);
    assert.deepEqual(m.files.map((f) => f.name), ["lint.json"]);
    assert.deepEqual(m.runs.map((r) => [r.run, r.snapshots.map((s) => s.name)]), [[1, ["assembled"]]]);
    assert.equal(m.prompts.count, 1);
    const origin = base.replace(/\/v1\/sessions$/, "");
    const page = await fetch(origin + m.pages[0].url);
    assert.equal(page.headers.get("content-type"), "image/png");
    assert.equal(await page.text(), "png-1");
    assert.equal(await (await fetch(origin + m.files[0].url)).text(), '{"ok":true}');
    // Saved HTML is model output: sent as text, never run on the API's origin.
    const snap = await fetch(origin + m.runs[0].snapshots[0].url);
    assert.match(snap.headers.get("content-type") ?? "", /^text\/plain/);
    assert.equal(snap.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await snap.text(), "<script>x</script>");
    assert.equal(await (await fetch(`${base}/${id}/audit/prompts/${sha256("hello")}`)).text(), "hello");
  });
});

test("a request cannot name a path: only listed files, exact hashes and snapshot names are served", async () => {
  await serve(true, async (base, id) => {
    for (const path of [
      "audit/files/..%2Flog.jsonl",
      "audit/files/log.jsonl",
      "audit/files/toString",
      "audit/files/fields.json", // listed, but this session has none
      "audit/pages/..%2F..%2Firis.sqlite",
      "audit/pages/2",
      "audit/prompts/..%2F..%2Flog.jsonl",
      `audit/prompts/${sha256("hello").toUpperCase()}`,
      "audit/runs/1/..%2F..%2Fprompts",
      "audit/runs/..%2F..%2Finput/assembled",
      "audit/runs/1/round-x",
    ]) {
      assert.equal((await fetch(`${base}/${id}/${path}`)).status, 404, path);
    }
    assert.equal((await fetch(`${base}/ses_nope/audit`)).status, 404);
  });
});

// The review loop's own call site: an editor round saves the body it returned, under its round
// number. Built like test/editor-round-size.test.ts: one issue, so the editor runs once.
test("an editor round saves the document it returned as round-<n>", async () => {
  const { runReview } = await import("../src/pipeline/review.ts");
  const dir = mkdtempSync(join(tmpdir(), "iris-audit-round-"));
  try {
    mkdirSync(join(dir, "input"), { recursive: true });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
    writeFileSync(join(dir, "input", "page-001.png"), png);
    const after = "<h1>Report</h1><table><tr><th scope='col'>Revenue</th></tr></table>";
    const saved: [string, string][] = [];
    const ctx = {
      sessionId: "ses_test",
      images: [{ name: "page-001.png", order: 1, path: join(dir, "input", "page-001.png") }],
      maxReviewIterations: 1,
      extractionConcurrency: 1,
      recheckSampleSize: 0,
      paths: { agentsDir: join(dir, "agents"), tmpAgentsDir: () => join(dir, "t"), agentMemory: () => join(dir, "m.json") },
      router: {
        complete: async (agent: string) =>
          agent === "reader"
            ? { text: JSON.stringify({ issues: [{ issue: "no headers", severity: "high", suggested_action: "add th", pages: [1] }] }) }
            : { text: JSON.stringify({ html: after }) },
      },
      log: { event: () => {}, agentCall: () => {} },
      audit: { snapshot: (name: string, html: string) => saved.push([name, html]) },
    } as unknown as Parameters<typeof runReview>[0];
    const body = "<h1>Report</h1><table><tr><td>Revenue</td></tr></table>";
    await runReview(ctx, { body, lint: { ok: true, violations: [] }, pages: [{ order: 1, innerHtml: body }] });
    assert.deepEqual(saved, [["round-1", after]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
