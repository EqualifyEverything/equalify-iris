// Run by test/e2e.sh: fetch real answers from a running Iris and check each against the schema
// docs/openapi.yaml gives for that path and status. Usage:
//   node test/openapi-check.mjs <base> <api-token> <quality-token> <session-id>
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { validate } from "./openapi-validate.ts";

const [base, apiToken, qualityToken, sid] = process.argv.slice(2);
const spec = parse(readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8"));
const auth = { Authorization: `Bearer ${apiToken}` };
const q = { Authorization: `Bearer ${qualityToken}` };
// [path as in the spec, URL to fetch, headers, status expected, method, body]
const json = (o) => JSON.stringify(o);
const cases = [
  ["/v1/health", "/v1/health", {}, 200],
  ["/v1/stats", "/v1/stats", {}, 200],
  ["/v1/limits", "/v1/limits", {}, 200],
  ["/v1/me", "/v1/me", auth, 200],
  ["/v1/me", "/v1/me", {}, 401],
  ["/v1/settings", "/v1/settings", auth, 200],
  ["/v1/sessions", "/v1/sessions?limit=2", auth, 200],
  ["/v1/sessions", "/v1/sessions?cursor=nonsense", auth, 400],
  ["/v1/sessions/{id}", `/v1/sessions/${sid}`, auth, 200],
  ["/v1/sessions/{id}", "/v1/sessions/ses_nope", auth, 404],
  ["/v1/sessions/{id}/diagnostics", `/v1/sessions/${sid}/diagnostics`, auth, 200],
  ["/v1/sessions/{id}/audit", `/v1/sessions/${sid}/audit`, auth, 200],
  ["/v1/sessions/{id}/fields", `/v1/sessions/${sid}/fields`, auth, 409],
  ["/v1/quality", "/v1/quality", q, 200],
  ["/v1/quality", "/v1/quality", {}, 401],
  ["/v1/suggestions", "/v1/suggestions", q, 200],
  ["/v1/sessions/{id}/feedback", "/v1/sessions/ses_nope/feedback", auth, 404, "post", () => json({ feedback: "x" })],
  // The e2e session is closed by now, so feedback is refused for its state before its body is read.
  ["/v1/sessions/{id}/feedback", `/v1/sessions/${sid}/feedback`, auth, 409, "post", () => json({})],
  ["/v1/sessions/{id}/close", "/v1/sessions/ses_nope/close", auth, 404, "post"],
  ["/v1/sessions/{id}/pdf", `/v1/sessions/${sid}/pdf`, auth, 409, "post", () => json({ values: {} })],
];
let bad = 0;
// Answers e2e already received earlier, when the run was fresh: [path, method, status, file holding the body].
// The upload's own 201 is one: asked again here, the upload rate limit would answer 429 instead.
const recorded = (process.env.OPENAPI_RECORDED || "").split(";").filter(Boolean).map((x) => x.split(","));
for (const [path, method, status, file] of recorded) {
  // The status is the one e2e asserted when it received the answer (its own checks pin the body too);
  // only the body is validated here.
  let resp = spec.paths[path]?.[method]?.responses?.[status];
  if (resp?.$ref) resp = resp.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o[k], spec);
  const schema = resp?.content?.["application/json"]?.schema;
  const problems = !resp ? [`no response ${status} in the spec`] : !schema ? [`response ${status} has no JSON schema to check against`] : validate(schema, JSON.parse(readFileSync(file, "utf8")), spec);
  if (problems.length) { bad++; console.log(`  ✗ ${method.toUpperCase()} ${path} (recorded ${status}): ${problems.slice(0, 5).join("; ")}`); }
}
for (const [path, url, headers, want, method = "get", body] of cases) {
  const b = body ? body() : undefined;
  const h = typeof b === "string" ? { ...headers, "Content-Type": "application/json" } : headers;
  const res = await fetch(base + url, { method: method.toUpperCase(), headers: h, body: b });
  const op = spec.paths[path]?.[method];
  let resp = op?.responses?.[String(res.status)];
  if (resp?.$ref) resp = resp.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o[k], spec);
  const schema = resp?.content?.["application/json"]?.schema;
  const problems = res.status !== want ? [`status ${res.status}, expected ${want}`] : !resp ? [`no response ${res.status} in the spec`] : schema ? validate(schema, await res.json(), spec) : [];
  if (problems.length) { bad++; console.log(`  ✗ ${method.toUpperCase()} ${url}: ${problems.slice(0, 5).join("; ")}`); }
}
const n = cases.length + recorded.length;
console.log(bad ? `OPENAPI: ${bad} of ${n} answers do not match` : `OPENAPI: all ${n} answers match the spec`);
process.exit(bad ? 1 : 0);
