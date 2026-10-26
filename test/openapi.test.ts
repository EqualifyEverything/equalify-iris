// docs/openapi.yaml is the API's exact contract, so it must name every route the code serves and
// every error code the code sends, and nothing else. Its schemas are checked against real
// responses in test/e2e.sh (test/openapi-check.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { validate } from "./openapi-validate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const spec = parse(readFileSync(join(root, "docs", "openapi.yaml"), "utf8"));
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");

// "GET /v1/sessions/{id}/logs" for every route: app.get in index.ts, and each router's own paths
// under the mount index.ts gives it.
function routesInCode(): Set<string> {
  const index = read("src", "index.ts");
  const out = new Set<string>();
  for (const m of index.matchAll(/app\.(get|post)\("(\/v1\/[^"]+)"/g)) out.add(`${m[1].toUpperCase()} ${m[2]}`);
  const files: Record<string, string> = {};
  for (const m of index.matchAll(/import \{ (\w+Router) \} from "\.\/routes\/(\w+)\.ts"/g)) files[m[1]] = m[2];
  for (const m of index.matchAll(/app\.use\("(\/v1\/[a-z]+)",[^\n]*?(\w+Router)\(/g)) {
    const src = read("src", "routes", `${files[m[2]]}.ts`);
    for (const r of src.matchAll(/r\.(get|post|put|delete)\("([^"]*)"/g)) {
      const path = (m[1] + (r[2] === "/" ? "" : r[2])).replace(/:(\w+)/g, "{$1}");
      out.add(`${r[1].toUpperCase()} ${path}`);
    }
  }
  return out;
}

test("the spec names every route the code serves, and no other", () => {
  const inSpec = new Set<string>();
  for (const [path, ops] of Object.entries(spec.paths as Record<string, Record<string, unknown>>)) {
    for (const method of Object.keys(ops)) inSpec.add(`${method.toUpperCase()} ${path}`);
  }
  const code = routesInCode();
  assert.ok(code.size > 20, `only ${code.size} routes found; the patterns above stopped matching`);
  assert.deepEqual([...code].filter((r) => !inSpec.has(r)).sort(), [], "routes the spec does not describe");
  assert.deepEqual([...inSpec].filter((r) => !code.has(r)).sort(), [], "routes the spec describes that the code does not serve");
});

test("the spec lists every error code Iris sends, and none it does not", () => {
  const sent = new Set<string>();
  const dirs = ["src/routes", "src/util", "src/auth"];
  for (const d of dirs) {
    for (const f of readdirSync(join(root, d)).filter((n) => n.endsWith(".ts"))) {
      const src = read(d, f);
      for (const m of src.matchAll(/sendError\(\s*res,\s*\d{3},\s*"([a-z_]+)"/g)) sent.add(m[1]);
      for (const m of src.matchAll(/status === 413 \? "([a-z_]+)" : "([a-z_]+)"/g)) { sent.add(m[1]); sent.add(m[2]); }
    }
  }
  // The tagger's own two, mapped in sessions.ts `taggerError`; iris-pdf's codes pass through besides.
  sent.add("tagger_failed"); sent.add("timeout");
  const listed = new Set<string>(spec.components.schemas.ErrorCode["x-codes"]);
  assert.deepEqual([...sent].filter((c) => !listed.has(c)).sort(), [], "codes Iris sends that the spec does not list");
  assert.deepEqual([...listed].filter((c) => !sent.has(c)).sort(), [], "codes the spec lists that Iris does not send");
});

test("every operation has a summary and a success response, and every $ref resolves", () => {
  const refs: string[] = [];
  const walk = (o: unknown) => {
    if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) k === "$ref" ? refs.push(v as string) : walk(v);
  };
  walk(spec);
  for (const r of refs) assert.ok(r.replace(/^#\//, "").split("/").reduce((o: Record<string, unknown> | undefined, k) => o && (o[k] as Record<string, unknown>), spec), r);
  for (const [path, ops] of Object.entries(spec.paths as Record<string, Record<string, { summary?: string; responses?: Record<string, unknown> }>>)) {
    for (const [method, op] of Object.entries(ops)) {
      assert.ok(op.summary, `${method} ${path} has no summary`);
      assert.ok(Object.keys(op.responses ?? {}).some((c) => c.startsWith("2")), `${method} ${path} has no success response`);
    }
  }
});

test("the schema check finds what it should", () => {
  const s = { type: "object", required: ["a"], properties: { a: { type: "integer" }, b: { type: ["string", "null"] }, c: { enum: ["x"] } } };
  assert.deepEqual(validate(s, { a: 1, b: null, c: "x" }, {}), []);
  assert.deepEqual(validate(s, { a: 1.5, b: 2, c: "y" }, {}), ["$.a: expected integer, got number", "$.b: expected string or null, got number", '$.c: "y" is not one of x']);
  assert.deepEqual(validate(s, {}, {}), ["$: missing a"]);
});
