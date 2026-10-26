// Run by test/e2e.sh: fetch real answers from a running Iris and check each against the schema
// docs/openapi.yaml gives for that path and status. Usage:
//   node test/openapi-check.mjs <base> <api-token> <quality-token> <session-id>
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { validate } from "./openapi-validate.mjs";

const [base, apiToken, qualityToken, sid] = process.argv.slice(2);
const spec = parse(readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8"));
const auth = { Authorization: `Bearer ${apiToken}` };
const q = { Authorization: `Bearer ${qualityToken}` };
// [path as in the spec, URL to fetch, headers, status expected]
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
];
let bad = 0;
for (const [path, url, headers, want] of cases) {
  const res = await fetch(base + url, { headers });
  const op = spec.paths[path]?.get;
  let resp = op?.responses?.[String(res.status)];
  if (resp?.$ref) resp = resp.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o[k], spec);
  const schema = resp?.content?.["application/json"]?.schema;
  const problems = res.status !== want ? [`status ${res.status}, expected ${want}`] : !resp ? [`no response ${res.status} in the spec`] : schema ? validate(schema, await res.json(), spec) : [];
  if (problems.length) { bad++; console.log(`  ✗ GET ${url}: ${problems.slice(0, 5).join("; ")}`); }
}
console.log(bad ? `OPENAPI: ${bad} of ${cases.length} answers do not match` : `OPENAPI: all ${cases.length} answers match the spec`);
process.exit(bad ? 1 : 0);
