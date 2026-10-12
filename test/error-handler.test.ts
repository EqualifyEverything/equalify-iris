import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import express from "express";
import { errorHandler } from "../src/routes/errors.ts";

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

test("the server mounts the error handler after every route", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const last = src.lastIndexOf("app.use(");
  assert.equal(src.slice(last, src.indexOf("\n", last)), "app.use(errorHandler);");
});
