#!/usr/bin/env node
// Stands in for the `iris-pdf` command in test/tagged-pdf.test.ts. Same arguments, exit
// codes and one-line errors, and no PDF work. Its "PDF" is JSON of what it was given.
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const [command, ...rest] = process.argv.slice(2);
const { values: a } = parseArgs({
  args: rest,
  strict: false,
  options: { pdf: { type: "string" }, pages: { type: "string" }, values: { type: "string" }, out: { type: "string" }, report: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" }, "report-detail": { type: "boolean" } },
});
const fail = (code, message, exit) => {
  process.stderr.write(`iris-pdf: ${code}: ${message}\n`);
  process.exit(exit);
};

if (a.help) {
  console.log("iris-pdf 0.0.0-fake");
  // Like iris-pdf from #52 on, `tag --help` lists --report-detail; FAKE_NO_DETAIL plays an older one.
  if (command === "tag" && !process.env.FAKE_NO_DETAIL) console.log("  --report-detail  add report.detail");
  process.exit(0);
}
const pdf = readFileSync(a.pdf, "utf8");
if (pdf.includes("ENCRYPTED")) fail("encrypted", "The PDF is encrypted.", 1);

// A "PDF" holding FLAT is a flat form: no fields, until tagging makes one from an <input>.
if (command === "fields" && pdf.includes("FLAT")) {
  const made = pdf.startsWith("%PDF-fake ") && JSON.parse(pdf.slice(10)).input.pages.some((p) => p.html.includes("<input"));
  console.log(JSON.stringify(made ? [{ name: "full-name", type: "text", page: 1, options: [], required: false, readonly: false, maxlen: null, editable: false, multiSelect: false }] : []));
} else if (command === "fields") {
  console.log(JSON.stringify([
    { name: "applicant.name", type: "text", page: 1, options: [], required: true, readonly: false, maxlen: 40, editable: false, multiSelect: false },
    { name: "applicant.consent", type: "checkbox", page: 1, options: ["Yes"], required: false, readonly: false, maxlen: null, editable: false, multiSelect: false },
    ...(pdf.includes("UNSAFE")
      ? [`x" onfocus="alert(1)`, "y".repeat(101)].map((name) => ({ name, type: "text", page: 1, options: [], required: false, readonly: false, maxlen: null, editable: false, multiSelect: false }))
      : []),
  ]));
} else if (command === "tag" && a["report-detail"] && process.env.FAKE_NO_DETAIL) {
  fail("bad_arguments", "Unknown option --report-detail.", 3);
} else if (command === "tag") {
  // So a test can tell whether a tag ran: one line per run, beside the source.
  appendFileSync(join(dirname(a.pdf), "tag-runs.txt"), "tag\n");
  if (pdf.includes("TAGFAIL")) fail("text_lost", "Page 1 lost text.", 2);
  if (pdf.includes("RESTRICTED")) fail("permissions_denied", "The PDF's owner does not permit changes to it.", 1);
  const values = JSON.parse(readFileSync(a.values, "utf8"));
  if (pdf.includes("NOFILL") && Object.keys(values).length) fail("values_not_permitted", "The PDF's owner does not permit filling in its form.", 1);
  if ("unknown.field" in values) fail("bad_value", "No field is named unknown.field.", 3);
  if ("crash" in values) fail("internal_error", `Cannot set ${values.crash}.`, 3);
  if ("slow" in values) await new Promise((r) => setTimeout(r, 5000));
  const input = JSON.parse(readFileSync(a.pages, "utf8"));
  const mode = (statSync(a.values).mode & 0o777).toString(8);
  writeFileSync(a.out, "%PDF-fake " + JSON.stringify({ source: pdf, input, values, mode, scratch: a.values }));
  const detail = a["report-detail"]
    ? {
        structure: { type: "Document", kids: [{ type: "H1", page: 1, text: "Quarterly Report" }, { type: "P", page: 1, text: "Revenue grew." }] },
        pages: [{ page: 1, matched: 5, furniture: { count: 1, words: ["Page", "1"] }, added: { count: 0, words: [] }, lost: { count: 0, words: [] }, redrawn: { count: 1, words: ["grew."] }, differingPixels: 0, textKept: true }],
        fields: { created: [], unresolved: [] },
        timing: { open: 1, form: 0, read: 2, match: 3, tag: 4, save: 5, check: 6 },
      }
    : undefined;
  writeFileSync(a.report, JSON.stringify({ tool: "iris-pdf 0.0.0-fake", warnings: [{ code: "duplicate_text_layer", page: 1 }], ...(detail ? { detail } : {}) }));
} else {
  fail("bad_arguments", `Unknown command ${command}.`, 3);
}
