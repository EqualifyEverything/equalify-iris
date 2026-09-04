import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IrisConfig } from "../src/config.ts";
import type { AuthedRequest } from "../src/auth/middleware.ts";
import { sessionsRouter } from "../src/routes/sessions.ts";
import { Store } from "../src/store/db.ts";
import { Paths } from "../src/store/paths.ts";
import type { Fragment } from "../src/pipeline/fragment.ts";
import type { FixtureCase } from "../src/pipeline/regression.ts";

// `POST /:id/close` is where accepting a document turns into a regression fixture: the
// page agent's accepted HTML for a real source image, re-checked before any future
// update to that agent. So what it captures is an assertion that this HTML
// is the RIGHT output for this image — which a page whose extraction failed is not. Its
// fragment is a `@page-failed` comment, and the fixture is keyed to the FIRST fragment
// the agent produced, i.e. page 1: a document that lost page 1 would gate every future
// page-agent change on reproducing a failure note.
//
// Driven through the real route rather than by calling captureFixtures directly, because
// the exclusion is the route's to make — it is the only place that reads `failedPages`
// back out of final.json — and calling the helper with a pre-filtered list would assert
// nothing about whether anyone filters it.

const USER = 4242;

function cfg(dir: string): IrisConfig {
  return {
    server: { port: 3000, base_url: "http://localhost:3000" },
    storage: { data_dir: dir, agents_dir: "agents", database: join(dir, "iris.sqlite") },
    github: {
      client_id: "Iv1.test",
      client_secret: "s",
      upstream_repo: "https://github.com/o/r",
      api_base_url: "https://api.github.com",
      oauth_base_url: "https://github.com",
    },
    providers: { default: "openrouter", openrouter: { api_key: "k", default_model: "anthropic/claude-sonnet-4.6" } },
    defaults: { max_review_iterations: 1, extraction_concurrency: 2, max_concurrent_runs: 1, recheck_sample_size: 1 },
  };
}

const frag = (order: number, innerHtml: string): Fragment => ({
  image: `page-00${order}.png`,
  order,
  agent: "page.md",
  region: "page",
  innerHtml,
  edges: [],
  log: "",
});

// A session parked in `ready_for_review` with `pageCount` uploaded images and the final
// state a run would have left behind, then closed over HTTP. Returns the fixtures the
// close filed.
async function closeWith(
  fragments: Fragment[],
  failedPages: number[] | undefined,
  pageCount: number,
  uncorrectedPages?: number[],
): Promise<FixtureCase[]> {
  const dir = mkdtempSync(join(tmpdir(), "iris-close-fixtures-"));
  const config = cfg(dir);
  const store = new Store(config.storage.database);
  const paths = new Paths(config);
  const id = "ses_close_1";
  store.createSession({ session_id: id, github_user_id: USER, image_count: pageCount, iterations_max: 1 });
  store.updateSession(id, { status: "ready_for_review" });
  paths.initSession(id);
  // Inputs are stored "<0001>__<original-name>" (orchestrator.enumerateInputs), and
  // capture resolves a fragment's image back to one of these — a fixture with no source
  // image is skipped, so getting this wrong would make every assertion below vacuous.
  for (let order = 1; order <= pageCount; order++) {
    writeFileSync(join(paths.sessionInput(id), `${String(order).padStart(4, "0")}__page-00${order}.png`), "png");
  }
  writeFileSync(
    paths.sessionFinalFragments(id),
    JSON.stringify(
      {
        fragments,
        body: "<p>b</p>",
        ...(failedPages ? { failedPages } : {}),
        ...(uncorrectedPages ? { uncorrectedPages } : {}),
      },
      null,
      2,
    ),
  );

  const app = express();
  app.use((req, _res, next) => {
    (req as AuthedRequest).user = {
      github_user_id: USER,
      github_login: "tester",
      max_review_iterations: 1,
    } as AuthedRequest["user"];
    next();
  });
  app.use("/v1/sessions", sessionsRouter(config, store));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/${id}/close`, { method: "POST" });
    assert.equal(res.status, 200, "the session closed");
    const fixtures = paths.agentFixtures("page.md");
    if (!existsSync(fixtures)) return [];
    return readdirSync(fixtures)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(fixtures, f), "utf8")) as FixtureCase);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("accepting a whole document files a fixture for the page agent", async () => {
  // The control: without this, the exclusion below could pass because capture is broken.
  const cases = await closeWith([frag(1, "<p>one</p>"), frag(2, "<p>two</p>")], [], 2);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].source_image, "page-001.png");
  assert.equal(cases[0].accepted_html, "<p>one</p>");
});

test("the page the run lost is not filed as the agent's accepted output", async () => {
  const cases = await closeWith(
    [frag(1, "<!-- @page-failed 1: hit the output ceiling -->"), frag(2, "<p>two</p>")],
    [1],
    2,
  );
  assert.equal(cases.length, 1);
  assert.equal(cases[0].source_image, "page-002.png", "the fixture moved to the page that HAS output");
  assert.doesNotMatch(cases[0].accepted_html, /@page-failed/);
  assert.equal(cases[0].accepted_html, "<p>two</p>");
});

test("a document where the only extracted page failed files nothing", async () => {
  // Nothing to assert about the agent, so no fixture — an empty `accepted_html` keyed to
  // a real image would gate future updates on producing nothing for it.
  const cases = await closeWith([frag(1, "<!-- @page-failed 1: boom -->")], [1], 1);
  assert.deepEqual(cases, []);
});

test("a page the fidelity check rejected is not filed as the agent's accepted output", async () => {
  // One step further than the failed page above, and the harder half: this page HAS content, and
  // the content is what Iris's own verifier named problems in and the correction pass did not
  // replace. Filing it keys the fixture to markup this run had already declared wrong, and every
  // future page-agent update is then gated on reproducing it (#328).
  //
  // Accepting the session is a human saying the DOCUMENT is good enough to close, which is not the
  // same claim as this page being the correct output for its image — and the verdict is nowhere in
  // the markup, so before the set was recorded there was no way to tell the two apart here.
  const cases = await closeWith([frag(1, "<table><tr><td>1</td></tr></table>"), frag(2, "<p>two</p>")], [], 2, [1]);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].source_image, "page-002.png", "the fixture moved to the page that was accepted as it stands");
  assert.equal(cases[0].accepted_html, "<p>two</p>");
});

test("state written before failed pages were recorded captures as it always did", async () => {
  // final.json from a run that predates the field. Absent means "no page is missing",
  // which is what that state implied when it was written; reading it as "unknown" and
  // skipping capture would silently stop filing fixtures for every session in flight
  // across the deploy.
  const cases = await closeWith([frag(1, "<p>one</p>")], undefined, 1);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].accepted_html, "<p>one</p>");
});
