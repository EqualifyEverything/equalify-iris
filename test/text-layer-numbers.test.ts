// A number in a page's HTML that the source PDF's text layer lacks is sent to the correction (#585).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_NUMBER_PROBLEMS,
  missingNumberProblem,
  numberTokens,
  numbersMissingFromTextLayer,
  textLayer,
} from "../src/pipeline/numbers.ts";
import { parsePdfHtmlText } from "../src/util/pdf.ts";
import { tightenDigitGroups } from "../src/util/html.ts";
import { declinedSource, runExtraction } from "../src/pipeline/extraction.ts";
import { enumerateInputs } from "../src/pipeline/orchestrator.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import { Paths as RealPaths, type Paths } from "../src/store/paths.ts";
import { stageSession } from "../src/pipeline/stage.ts";
import { summarizeRun } from "../src/diagnostics.ts";
import type { IrisConfig } from "../src/config.ts";
import type { Store } from "../src/store/db.ts";

const LAYER = "Doors open at 9:45 pm. Tickets cost $1,200 for 3 nights, 10–12 June 2026.";

test("numbers are normalised: thousands separators, leading zeros, am/pm", () => {
  assert.deepEqual(numberTokens("1,200 and 1200"), ["1200", "1200"]);
  assert.deepEqual(numberTokens("09:45 P.M., 9:45pm, 9:45 PM"), ["9:45 pm", "9:45 pm", "9:45 pm"]);
  assert.deepEqual(numberTokens("$3.50 and 12.5%"), ["3.50", "12.5"]);
  assert.deepEqual(numberTokens("1,2,3"), ["1", "2", "3"], "not a thousands separator");
  assert.deepEqual(numberTokens("5 amps"), ["5"], "an am/pm must stand alone");
});

test("9:45 pm read as 4:45 pm is missing from the text layer", () => {
  const layer = textLayer(LAYER)!;
  const r = numbersMissingFromTextLayer(layer, "<p>Doors open at 4:45 pm.</p>")!;
  assert.deepEqual(r.numbers, ["4:45 pm"]);
  assert.equal(r.checked, 1);
  assert.deepEqual(numbersMissingFromTextLayer(layer, "<p>At 4:45 p.m. sharp.</p>")!.numbers, ["4:45 p.m."], "quoted as written");
  assert.deepEqual(numbersMissingFromTextLayer(layer, "<p>Doors open at 9:45&nbsp;PM.</p>")!.numbers, []);
  assert.deepEqual(numbersMissingFromTextLayer(layer, "<p>Doors open at 9:45 am.</p>")!.numbers, ["9:45 am"]);
  assert.deepEqual(numbersMissingFromTextLayer(layer, "<p>9:45</p>")!.numbers, [], "a bare time matches either");
  // A timetable whose column is headed "PM" prints the bare time; the HTML may add the pm.
  const timetable = textLayer("Evening departures PM 9:45 10:15")!;
  assert.deepEqual(numbersMissingFromTextLayer(timetable, "<td>9:45 pm</td>")!.numbers, []);
});

test("1,200 matches 1200, and a range matches with a hyphen or an en dash", () => {
  const layer = textLayer(LAYER)!;
  assert.deepEqual(numbersMissingFromTextLayer(layer, "<p>$1200 for 3 nights, 10-12 June 2026</p>")!.numbers, []);
  assert.deepEqual(numbersMissingFromTextLayer(textLayer("pages 10-12 of the report")!, "<p>10–12</p>")!.numbers, []);
  assert.deepEqual(numbersMissingFromTextLayer(layer, "<p>$1,300</p>")!.numbers, ["1,300"]);
});

test("a text layer's `4, 271` is the 4,271 that tightenDigitGroups writes", () => {
  const layer = textLayer("Table 2. Enrolment by year: 2024 total 4, 271 students")!;
  assert.deepEqual(layer.numbers, ["2", "2024", "4271"]);
  const html = tightenDigitGroups("<table><tr><td>2024</td><td>4, 271</td></tr></table>").html;
  assert.match(html, /<td>4,271<\/td>/);
  assert.deepEqual(numbersMissingFromTextLayer(layer, html)!.numbers, []);
  assert.deepEqual(numbersMissingFromTextLayer(layer, "<p>4, 271</p>")!.numbers, [], "and the HTML's own gap");
  assert.deepEqual(numbersMissingFromTextLayer(layer, "<td>4,217</td>")!.numbers, ["4,217"]);
  assert.deepEqual(numberTokens("4, 2711"), ["4", "2711"], "a fourth digit is two numbers");
});

test("a scan with a typed stamp is not checked against the stamp", () => {
  const layer = textLayer("CONFIDENTIAL — Exhibit 3, Page 12 of 40")!;
  const body =
    `<p>The committee met on 14 March and approved a budget of $82,500 for the coming year. ` +
    `Attendance at the spring meeting was 214, up from the year before, and members asked that ` +
    `the minutes be circulated before the next meeting rather than read aloud at it.</p>`;
  const r = numbersMissingFromTextLayer(layer, body)!;
  assert.equal(r.skipped, "thin_layer");
  assert.equal(r.missing, 3);
  assert.deepEqual(r.numbers, []);
  // The same layer against a page no longer than it is checked.
  assert.deepEqual(numbersMissingFromTextLayer(layer, "<p>Exhibit 3, page 12 of 41</p>")!.numbers, ["41"]);
});

test("a scan's text layer is not checked against", () => {
  assert.equal(textLayer(""), null);
  assert.equal(textLayer("  \n 3 \n"), null, "a page number alone is a scan");
  assert.equal(textLayer(undefined), null);
  assert.deepEqual(textLayer("A page of words and no digits at all."), { chars: 28, numbers: [] }, "text with no numbers is not a scan");
  assert.equal(textLayer("Page 3 of 9 — final, signed"), null, "19 letters and digits is a scan");
  assert.deepEqual(textLayer("Page 3 of 9 — final, signedX"), { chars: 20, numbers: ["3", "9"] });
  assert.equal(numbersMissingFromTextLayer(undefined, "<p>4:45 pm</p>"), null);
});

test("the page-break marker, attributes, comments, figures and math are not checked", () => {
  const layer = textLayer(LAYER)!;
  const html =
    `<hr role="doc-pagebreak" aria-label="Page 7" id="page-7"><p role="doc-pagebreak">7</p>` +
    `<!-- @unresolved 88 --><img alt="A chart peaking at 450" src="x.png">` +
    `<figure><table><tr><td>451</td></tr></table></figure><math><mn>42</mn></math><p>9:45 pm</p>`;
  assert.deepEqual(numbersMissingFromTextLayer(layer, html), { checked: 1, missing: 0, numbers: [] });
});

test("a page whose numbers are mostly not in the text layer is skipped, not flagged", () => {
  const many = Array.from({ length: MAX_NUMBER_PROBLEMS + 1 }, (_, i) => `<td>${700 + i}</td>`).join("");
  const r = numbersMissingFromTextLayer(textLayer(LAYER)!, `<table><tr>${many}</tr></table>`)!;
  assert.equal(r.skipped, "mostly_absent");
  assert.equal(r.missing, MAX_NUMBER_PROBLEMS + 1);
  assert.deepEqual(r.numbers, []);
  // Under the cap it is flagged even when all are missing: one misread time on a page is the case.
  const few = numbersMissingFromTextLayer(textLayer(LAYER)!, "<p>700 701</p>")!;
  assert.deepEqual(few.numbers, ["700", "701"]);
  // Over the cap but under half missing: the layer does describe the page, so the first ten are sent,
  // and `missing` still counts all of them.
  const present = Array.from({ length: 2 * MAX_NUMBER_PROBLEMS }, (_, i) => String(100 + i));
  const r2 = numbersMissingFromTextLayer(textLayer(`Figures ${present.join(" ")}`)!, `<p>${present.join(" ")}</p>${many}`)!;
  assert.equal(r2.skipped, undefined);
  assert.equal(r2.missing, MAX_NUMBER_PROBLEMS + 1);
  assert.equal(r2.numbers.length, MAX_NUMBER_PROBLEMS);
  assert.equal(r2.numbers[0], "700");
});

test("pdftohtml's XML gives each page its text", () => {
  const xml =
    `<?xml version="1.0"?><pdf2xml>Outline 99<page number="1" top="0"><text top="1">Opens <b>9:45</b></text>` +
    `<text top="2">pm &amp; closes</text></page><page number="2"></page></pdf2xml>`;
  const text = parsePdfHtmlText(xml);
  assert.equal(text.get(1), "Opens 9:45\npm & closes\n");
  assert.equal(text.get(2), "", "a page with no text is an empty string, which textLayer reads as a scan");
  assert.deepEqual(numberTokens(text.get(1)!), ["9:45 pm"], "an am/pm on the next line still belongs to the time");
});

test("the problem names the number and leaves the answer to the image", () => {
  const p = missingNumberProblem("4:45 pm");
  assert.match(p, /writes "4:45 pm", and the source PDF's own text for this page has no such number/);
  assert.match(p, /If the image does show "4:45 pm", change nothing for it/);
});

test("a decline in the numbers band is attributed to it", () => {
  const counts = { verify: 1, links: 0, alt: 0, ids: 0, words: 1, numbers: 2 };
  assert.equal(declinedSource(2, counts), "words");
  assert.equal(declinedSource(3, counts), "numbers");
  assert.equal(declinedSource(4, counts), "numbers");
  assert.equal(declinedSource(5, counts), null);
});

test("enumerateInputs puts the text layer on the page, and leaves a scan or a malformed entry without one", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-numbers-"));
  try {
    mkdirSync(join(dir, "input"));
    writeFileSync(join(dir, "input", "0001__a.png"), "x");
    writeFileSync(join(dir, "input", "0002__b.png"), "x");
    writeFileSync(join(dir, "input", "0003__c.png"), "x");
    writeFileSync(join(dir, "input", "0004__d.png"), "x");
    writeFileSync(
      join(dir, "text-layer.json"),
      JSON.stringify({ "1": { chars: 40, numbers: ["9:45 pm"] }, "3": ["9:45 pm"], "4": { numbers: ["9:45 pm"] }, "5": { chars: 40, numbers: "9:45 pm" } }),
    );
    writeFileSync(join(dir, "input", "0005__e.png"), "x");
    const paths = {
      sessionInput: () => join(dir, "input"),
      sessionLinks: () => join(dir, "links.json"),
      sessionFields: () => join(dir, "fields.json"),
      sessionTextLayer: () => join(dir, "text-layer.json"),
    } as unknown as Paths;
    const [a, b, c, d, e] = enumerateInputs(paths, "ses_x");
    assert.equal(d.textLayer, undefined, "and one without its size");
    assert.equal(e.textLayer, undefined, "and one whose numbers are not a list");
    assert.deepEqual(a.textLayer, { chars: 40, numbers: ["9:45 pm"] });
    assert.equal(b.textLayer, undefined);
    assert.equal(c.textLayer, undefined, "an entry of the wrong shape is no text layer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stageSession writes each text-layer page by order, and nothing for a scan", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-numbers-stage-"));
  try {
    const cfg = { storage: { data_dir: dir, agents_dir: join(dir, "agents") }, defaults: { max_review_iterations: 1 } } as unknown as IrisConfig;
    const paths = new RealPaths(cfg);
    const store = { createSession: (s: { session_id: string }) => s } as unknown as Store;
    const pages = [
      { name: "a.png", buffer: Buffer.from("x"), links: [], text: LAYER },
      { name: "b.png", buffer: Buffer.from("x"), links: [], text: " 2 " },
      { name: "c.png", buffer: Buffer.from("x"), links: [] },
    ];
    const rec = await stageSession(cfg, store, paths, [{ originalname: "doc.pdf", buffer: Buffer.from("%PDF") }], pages, []);
    const written = JSON.parse(readFileSync(paths.sessionTextLayer(rec.session_id), "utf8"));
    assert.deepEqual(Object.keys(written), ["1"]);
    assert.deepEqual(written["1"], { chars: 53, numbers: ["9:45 pm", "1200", "3", "10", "12", "2026"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- through the pipeline: the hook in extractPage ------------------------------------------

interface Event {
  type: string;
  [k: string]: unknown;
}

const page = (time: string) =>
  `<h2>Opening hours</h2><p>The hall is open to members every weekday evening. Doors open at ${time}, ` +
  `and the bar closes half an hour before the hall does. Members may bring one guest each.</p>`;

async function run(numbers: string[] | undefined, corrected: string, declined?: { problem: number; why: string }[], chars = 200) {
  const dir = mkdtempSync(join(tmpdir(), "iris-numbers-run-"));
  const events: Event[] = [];
  const prompts: string[] = [];
  try {
    const agentsDir = join(dir, "agents");
    const fragDir = join(dir, "fragments");
    const inputDir = join(dir, "input");
    for (const d of [agentsDir, fragDir, inputDir]) mkdirSync(d, { recursive: true });
    writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
    writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\nvision\n");
    writeFileSync(join(inputDir, "page-001.png"), "not-a-real-png");
    const ctx = {
      sessionId: "ses_test",
      images: [{ name: "page-001.png", order: 1, path: join(inputDir, "page-001.png"), links: [], ...(numbers ? { textLayer: { chars, numbers } } : {}) }],
      extractionConcurrency: 1,
      recheckSampleSize: 0,
      maxReviewIterations: 1,
      paths: {
        agentsDir,
        tmpAgentsDir: () => join(dir, "tmp-agents"),
        agentMemory: (agent: string) => join(dir, `mem-${agent.replace(/\.md$/, "")}.json`),
        sessionFragments: () => fragDir,
      } as unknown as Paths,
      router: {
        complete: async (_agent: string, _cap: string, messages: { role: string; content: string }[]) => {
          const user = messages.find((m) => m.role === "user")?.content ?? "";
          // The verifier passes the page: the misread is one it did not see, which is #585.
          if (user.includes("TASK: verify")) return { text: JSON.stringify({ faithful: true, accessible: true, problems: [] }) };
          if (user.includes("had fidelity/accessibility problems")) {
            prompts.push(user);
            return { text: JSON.stringify({ html: corrected, ...(declined ? { declined } : {}) }) };
          }
          return { text: JSON.stringify({ html: page("4:45 pm"), log: "" }) };
        },
      },
      log: {
        event: (type: string, fields: Record<string, unknown>) => events.push({ type, ...fields }),
        agentCall: () => {},
      },
    } as unknown as PipelineContext;
    await runExtraction(ctx);
    return { events, prompts };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const of = (events: Event[], type: string) => events.filter((e) => e.type === type);

test("a page that passed with a misread time is corrected against the text layer", async () => {
  const { events, prompts } = await run(["9:45 pm"], page("9:45 pm"));
  const [found] = of(events, "text_layer_numbers");
  assert.deepEqual(found, { type: "text_layer_numbers", image: "page-001.png", page: 1, checked: 1, missing: 1, numbers: ["4:45 pm"] });
  assert.equal(prompts.length, 1);
  const entry = prompts[0].split("\n").find((l) => /^\d+\. /.test(l))!;
  assert.match(entry, /writes "4:45 pm"/);
  assert.match(entry, /\(Iris checked in code that the PDF's text for this page lacks this number, not what the page prints\.\)$/);
  assert.match(prompts[0].replace(/\s+/g, " "), /A problem marked "\(Iris checked in code that the PDF's text for this page lacks this number/);
  const [corrected] = of(events, "page_corrected");
  assert.equal(corrected.trigger, "numbers");
  assert.equal(of(events, "text_layer_numbers_unrecovered").length, 0);
});

test("a correction that keeps the misread says so", async () => {
  // Changed elsewhere, so it is kept: an identical reply is not a correction at all.
  const { events } = await run(["9:45 pm"], page("4:45 pm").replace("hall is", "hall is always"));
  const [left] = of(events, "text_layer_numbers_unrecovered");
  assert.deepEqual(left.numbers, ["4:45 pm"]);
});

test("a page with no text layer is not checked and buys no correction", async () => {
  const { events, prompts } = await run(undefined, page("9:45 pm"));
  assert.equal(of(events, "text_layer_numbers").length, 0);
  assert.equal(prompts.length, 0);
});

test("a page whose text layer is a stamp logs why it was skipped and buys no correction", async () => {
  const { events, prompts } = await run(["12"], page("9:45 pm"), undefined, 30);
  assert.deepEqual(of(events, "text_layer_numbers")[0], {
    type: "text_layer_numbers",
    image: "page-001.png",
    page: 1,
    checked: 1,
    missing: 1,
    skipped: "thin_layer",
  });
  assert.equal(prompts.length, 0);
});

test("a page whose numbers match logs the count and buys no correction", async () => {
  const { events, prompts } = await run(["4:45 pm"], page("4:45 pm"));
  assert.deepEqual(of(events, "text_layer_numbers")[0], { type: "text_layer_numbers", image: "page-001.png", page: 1, checked: 1, missing: 0 });
  assert.equal(prompts.length, 0);
});

test("a decline of a number is counted as one, not as a refused code-checked fact", async () => {
  const { events } = await run(["9:45 pm"], page("4:45 pm"), [{ problem: 1, why: "the image prints 4:45 pm" }]);
  const [line] = of(events, "page_correction_declined");
  assert.deepEqual((line.declined as { source: string }[]).map((d) => d.source), ["numbers"]);
  const d = summarizeRun(
    events.map((e) => JSON.stringify({ ts: new Date(Date.UTC(2026, 0, 1)).toISOString(), ...e })).join("\n"),
    { sessionId: "s", status: "ready_for_review", phase: "done", now: Date.UTC(2026, 0, 1) },
  );
  assert.equal(d.verification.declined.numbers, 1);
  assert.equal(d.verification.declined.code_checked, 0);
  assert.equal(d.verification.triggers.numbers, 1);
});
