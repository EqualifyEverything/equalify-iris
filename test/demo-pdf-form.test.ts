// The demo's "Get your PDF back, tagged" form. It is built from the source PDF's own
// fields, so these tests build it from each kind of field, lint it with the same axe
// configuration Iris lints its output with, and check what it sends.
//
// The functions are lifted out of the page's inline script, as test/demo-tally.test.ts
// does, so a change to the page is what gets tested.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";
import { runAxe } from "../src/pipeline/lint.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const demoHtml = readFileSync(join(repoRoot, "public", "demo.html"), "utf8");

function extract(name: string): string {
  const start = demoHtml.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is no longer in public/demo.html`);
  let depth = 0;
  for (let i = demoHtml.indexOf("{", start); i < demoHtml.length; i++) {
    if (demoHtml[i] === "{") depth++;
    else if (demoHtml[i] === "}" && --depth === 0) return demoHtml.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces reading ${name} from public/demo.html`);
}

type Field = { name: string; type: string; options: string[]; required?: boolean; readonly?: boolean; maxlen?: number | null; editable?: boolean; multiSelect?: boolean };
const renderFields = new Function(`${extract("renderFields")}; return renderFields;`)() as (doc: Document, list: Element, fields: Field[]) => number;
const fieldValues = new Function(`${extract("fieldValues")}; return fieldValues;`)() as (list: Element) => Record<string, unknown>;
const pdfNotes = new Function(`${extract("pdfNotes")}; return pdfNotes;`)() as (report: unknown) => string[];

const FIELDS: Field[] = [
  { name: "name", type: "text", options: [], required: true, maxlen: 40 },
  { name: "city", type: "combobox", options: ["Chicago", "Urbana"], editable: true },
  { name: "agree", type: "checkbox", options: ["Yes"] },
  { name: "size", type: "radio", options: ["S", "M"] },
  { name: "state", type: "combobox", options: ["IL", "IN"] },
  { name: "days", type: "listbox", options: ["Mon", "Tue"], multiSelect: true },
  { name: "office", type: "text", options: [], readonly: true },
  { name: "submit", type: "button", options: [] },
  { name: "sig", type: "signature", options: [] },
];

function form() {
  const doc = new JSDOM('<!DOCTYPE html><html lang="en"><head><title>t</title></head><body><main><form id="f"></form></main></body></html>').window.document;
  const list = doc.getElementById("f")!;
  return { doc, list, n: renderFields(doc, list, FIELDS) };
}

test("every settable field gets one labelled control, and the rest get none", async () => {
  const { doc, list, n } = form();
  assert.equal(n, 6);
  assert.deepEqual([...list.querySelectorAll("[data-field]")].map((b) => (b as HTMLElement).dataset.field), ["name", "city", "agree", "size", "state", "days"]);
  assert.equal(list.querySelector("input")!.maxLength, 40);
  assert.match(list.textContent!, /name \(required on the form\)/);
  // An editable combobox takes any text, and offers its options as suggestions.
  const city = list.querySelector('[data-field="city"] input')!;
  assert.equal(doc.getElementById(city.getAttribute("list")!)!.children.length, 2);
  const lint = await runAxe(doc.documentElement.outerHTML);
  assert.equal(lint.error, undefined, `axe-core did not run: ${lint.error}`);
  assert.deepEqual(lint.violations, []);
});

test("an untouched form sends nothing, so the PDF keeps what it had", () => {
  assert.deepEqual(fieldValues(form().list), {});
});

test("a checkbox can be left alone, ticked or unticked", () => {
  const { list } = form();
  const box = (v: string) => list.querySelector(`[data-field="agree"] input[value="${v}"]`) as HTMLInputElement;
  box("Not checked").checked = true;
  assert.deepEqual(fieldValues(list), { agree: false });
  box("Checked").checked = true;
  assert.deepEqual(fieldValues(list), { agree: true });
});

test("what was entered is sent under each field's name", () => {
  const { list } = form();
  const q = (s: string) => list.querySelector(s) as HTMLInputElement & HTMLSelectElement;
  q('[data-field="name"] input').value = "Ada";
  q('[data-field="city"] input').value = "Peoria";
  q('[data-field="agree"] input[value="Checked"]').checked = true;
  q('[data-field="size"] input[value="M"]').checked = true;
  q('[data-field="state"] select').value = "IN";
  (q('[data-field="days"] select').options[1] as HTMLOptionElement).selected = true;
  assert.deepEqual(fieldValues(list), { name: "Ada", city: "Peoria", agree: true, size: "M", state: "IN", days: ["Tue"] });
});

test("the report's warnings come back as one sentence per kind", () => {
  const notes = pdfNotes({
    warnings: [
      { code: "missing_alt", page: 1 },
      { code: "missing_alt", page: 2 },
      { code: "field_not_in_html", page: 1 },
      { code: "no_title" },
      { code: "something_new" },
    ],
  });
  assert.deepEqual(notes, [
    "2 images have no description.",
    "One form field was not found in the HTML, so a screen reader reaches it at the end of its page.",
    "Note from the tagger: something_new.",
  ]);
  assert.deepEqual(pdfNotes({ warnings: [] }), []);
  assert.deepEqual(pdfNotes(null), []);
});

test("the finished document is shown before the PDF offer, which is not awaited", () => {
  const reveal = demoHtml.indexOf("show('result-section'); focusHeading('result-h');");
  const offer = demoHtml.indexOf("showPdfPart()");
  assert.ok(reveal > 0 && offer > reveal, "the offer comes after the reveal");
  assert.doesNotMatch(demoHtml, /await\s+showPdfPart\(/, "a busy tagger must not hold the result back");
});

test("an offer that arrives after a wait is announced, and one that arrives at once is not", () => {
  const body = demoHtml.slice(demoHtml.indexOf("async function showPdfPart"), demoHtml.indexOf("$('pdf-form').addEventListener"));
  assert.match(body, /show\('pdf-part'\);\s*(\/\/.*\s*)*if \(tries > 0\) live\(/);
});

test("a late /fields reply is dropped after a new document, a re-run, or a newer offer", () => {
  const body = demoHtml.slice(demoHtml.indexOf("async function showPdfPart"), demoHtml.indexOf("$('pdf-form').addEventListener"));
  assert.match(body, /const stale = \(\) => turn !== pdfTurn \|\| sessionId !== id \|\| converting;/);
  // Checked after every wait, and after the last await, right before anything is shown.
  assert.equal(body.match(/if \(stale\(\)\) return;|if \(!res\.ok \|\| stale\(\)\) return;/g)?.length, 3);
  const last = body.lastIndexOf("await ");
  const check = body.indexOf("if (stale()) return;", last);
  assert.ok(check > last && check < body.indexOf("show('pdf-part')"), "no await between the last check and the change");
});
