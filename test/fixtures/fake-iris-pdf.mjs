#!/usr/bin/env node
// Stands in for the `iris-pdf` command in test/tagged-pdf.test.ts. Same arguments, exit
// codes and one-line errors, and no PDF work. Its "PDF" is JSON of what it was given.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const [command, ...rest] = process.argv.slice(2);
const { values: a } = parseArgs({
  args: rest,
  strict: false,
  options: { pdf: { type: "string" }, pages: { type: "string" }, values: { type: "string" }, out: { type: "string" }, report: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" } },
});
const fail = (code, message, exit) => {
  process.stderr.write(`iris-pdf: ${code}: ${message}\n`);
  process.exit(exit);
};

if (a.help) {
  console.log("iris-pdf 0.0.0-fake");
  process.exit(0);
}
const pdf = readFileSync(a.pdf, "utf8");
if (pdf.includes("ENCRYPTED")) fail("encrypted", "The PDF is encrypted.", 1);

if (command === "fields") {
  console.log(JSON.stringify([
    { name: "applicant.name", type: "text", page: 1, options: [], required: true, readonly: false, maxlen: 40, editable: false, multiSelect: false },
    { name: "applicant.consent", type: "checkbox", page: 1, options: ["Yes"], required: false, readonly: false, maxlen: null, editable: false, multiSelect: false },
  ]));
} else if (command === "tag") {
  const values = JSON.parse(readFileSync(a.values, "utf8"));
  if ("unknown.field" in values) fail("bad_value", "No field is named unknown.field.", 3);
  if ("crash" in values) fail("internal_error", `Cannot set ${values.crash}.`, 3);
  if ("slow" in values) await new Promise((r) => setTimeout(r, 5000));
  const input = JSON.parse(readFileSync(a.pages, "utf8"));
  const mode = (statSync(a.values).mode & 0o777).toString(8);
  writeFileSync(a.out, "%PDF-fake " + JSON.stringify({ source: pdf, input, values, mode, scratch: a.values }));
  writeFileSync(a.report, JSON.stringify({ tool: "iris-pdf 0.0.0-fake", warnings: [{ code: "duplicate_text_layer", page: 1 }] }));
} else {
  fail("bad_arguments", `Unknown command ${command}.`, 3);
}
