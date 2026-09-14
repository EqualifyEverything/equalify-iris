import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { SERVICE_VERSION, readVersion } from "../src/util/version.ts";

// `GET /v1/health` reports the running build's version, and this is the file that keeps the
// three places the version can be read from saying the same thing. The route itself is
// asserted end to end (test/e2e.sh step 1b, against the real server); what is left over is
// the reading of package.json — which cannot be exercised there, because e2e only ever runs
// against a tree whose package.json is present and well formed.

const ROOT = new URL("../", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, ROOT), "utf8");
const packageVersion = () => (JSON.parse(read("package.json")) as { version: string }).version;

// A temp file per case rather than one shared directory: each case writes a different broken
// package.json, and a shared path would make the order of the tests part of what they assert.
const withFile = (contents: string): URL => {
  const dir = mkdtempSync(join(tmpdir(), "iris-version-"));
  const path = join(dir, "package.json");
  writeFileSync(path, contents);
  return pathToFileURL(path);
};

test("the version the probe reports is the one package.json states", () => {
  assert.equal(SERVICE_VERSION, packageVersion());
});

test("a package.json that cannot name the build reads as null, and never throws", () => {
  // Every one of these is a build that cannot say what it is, and the probe's job on all four
  // is to keep answering. A throw here would be a liveness probe reporting the service DOWN
  // over a file the service does not need in order to convert a document.
  const unnameable: [string, URL][] = [
    ["a package.json that is not there", new URL("file:///nonexistent/iris/package.json")],
    ["a package.json that is not JSON", withFile("not json at all")],
    ["a package.json with no version key", withFile('{"name":"equalify-iris"}')],
    // Two shapes that are present and still say nothing: `npm version` writes a string, so a
    // number is someone editing by hand, and an empty string would render as `"version":""`
    // — a field an operator would read as an answer.
    ["a version that is not a string", withFile('{"version":1}')],
    ["an empty version", withFile('{"version":""}')],
  ];
  for (const [what, from] of unnameable) {
    assert.equal(readVersion(from), null, `${what} should read as null`);
  }
});

test("every doc that prints a version prints the one package.json states", () => {
  // The version is authoritative in package.json and quoted in two docs, which is the same
  // shape as the Node floor in test/runtime-flags.test.ts: one source, several copies, and a
  // release that bumps the source silently staling the copies. Collected rather than asserted
  // one at a time, for that test's reason — `assert` throws at the first failure, so checking
  // these in sequence would report README.md and say nothing about docs/API.md.
  //
  // Each member reads the version out of the SAMPLE RESPONSE, not out of prose: the docs are
  // allowed to discuss versions, and what has to track package.json is only the body a reader
  // would copy as the answer they expect.
  const version = packageVersion();
  const wrong = ["docs/API.md", "README.md"].flatMap((rel) => {
    const found = read(rel).match(/\{"status":"ok","service":"equalify-iris","version":"([^"]*)"\}/);
    if (!found) return [`${rel} no longer prints a \`GET /v1/health\` body this test can read`];
    return found[1] === version ? [] : [`${rel} prints version "${found[1]}", not "${version}"`];
  });
  assert.deepEqual(wrong, [], `package.json's version is ${version}: ${wrong.join("; ")}`);
});
