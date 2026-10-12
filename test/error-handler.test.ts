import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import express from "express";
import { errorHandler, notFound } from "../src/routes/errors.ts";

async function ask(app: express.Express, init: RequestInit = {}): Promise<{ status: number; type: string; body: string }> {
  const server = app.listen(0);
  try {
    const { port } = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}/x`, init);
    return { status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text() };
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test("a route that rejects answers 500 in Iris's error shape, with no stack", async () => {
  const app = express();
  app.get("/x", async () => {
    throw new Error("disk full at /srv/secret/path");
  });
  app.use(errorHandler);
  const quiet = console.error;
  console.error = () => {};
  try {
    const r = await ask(app);
    assert.equal(r.status, 500);
    assert.match(r.type, /application\/json/);
    assert.equal(JSON.parse(r.body).error.code, "server_error");
    assert.doesNotMatch(r.body, /secret|layer\.js/);
  } finally {
    console.error = quiet;
  }
});

test("a malformed JSON body answers 400 invalid_request", async () => {
  const app = express();
  app.use(express.json());
  app.post("/x", (_req, res) => res.json({}));
  app.use(errorHandler);
  const r = await ask(app, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  assert.equal(r.status, 400);
  assert.equal(JSON.parse(r.body).error.code, "invalid_request");
});

test("a JSON body over the parser's limit answers 413 body_too_large", async () => {
  const app = express();
  app.use(express.json({ limit: "10b" }));
  app.post("/x", (_req, res) => res.json({}));
  app.use(errorHandler);
  const r = await ask(app, { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":"0123456789"}' });
  assert.equal(r.status, 413);
  assert.equal(JSON.parse(r.body).error.code, "body_too_large");
});

test("an unknown path answers 404 not_found in the error shape", async () => {
  const app = express();
  app.use(notFound);
  const r = await ask(app);
  assert.equal(r.status, 404);
  assert.equal(JSON.parse(r.body).error.code, "not_found");
});

test("the server mounts notFound then errorHandler after every route", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const uses = src.split("\n").filter((l) => l.startsWith("app.use("));
  assert.deepEqual(uses.slice(-2), ["app.use(notFound);", "app.use(errorHandler);"]);
});
