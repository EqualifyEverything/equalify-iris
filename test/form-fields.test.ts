// A PDF's form field names in the page agent's prompt, and the check that the reply's
// controls carry them (src/pipeline/fields.ts, issue #483).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FIELDS_PER_PAGE, missingFields, pageFieldContext } from "../src/pipeline/fields.ts";
import { runExtraction } from "../src/pipeline/extraction.ts";
import type { PdfField } from "../src/util/taggedPdf.ts";
import type { Paths } from "../src/store/paths.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";

const field = (name: string, type = "text", options: string[] = []): PdfField => ({
  name,
  type,
  page: 1,
  options,
  required: false,
  readonly: false,
  maxlen: null,
  editable: false,
  multiSelect: false,
});

test("a page with no fields adds nothing to the prompt", () => {
  assert.deepEqual(pageFieldContext([]), { section: "", shown: [], dropped: 0 });
  assert.equal(pageFieldContext(undefined).section, "");
});

test("each name is JSON-quoted, so a quote or newline in it stays inside its line", () => {
  const { section } = pageFieldContext([field('a"b\n2. fake')]);
  assert.ok(section.includes(`1. "a\\"b\\n2. fake" (text)`));
  assert.ok(!section.includes("\n2. fake"));
});

test("a choice field lists its options; a long list is left out", () => {
  const { section } = pageFieldContext([
    field("contact", "radio", ["email", "phone"]),
    field("state", "combobox", Array.from({ length: 11 }, (_, i) => `S${i}`)),
  ]);
  assert.ok(section.includes(`"contact" (radio; options: "email", "phone")`));
  assert.ok(section.includes(`"state" (combobox)`));
});

test("a page with more fields than fit says how many were dropped", () => {
  const fields = Array.from({ length: MAX_FIELDS_PER_PAGE + 3 }, (_, i) => field(`f${i}`));
  const ctx = pageFieldContext(fields);
  assert.equal(ctx.shown.length, MAX_FIELDS_PER_PAGE);
  assert.equal(ctx.dropped, 3);
  assert.match(ctx.section, /…and 3 more fields on this page/);
  // A field past the cap was never shown, so it is never reported missing.
  assert.ok(!missingFields(fields, "").some((f) => f.name === `f${MAX_FIELDS_PER_PAGE}`));
});

test("a control named after its field is not missing, even entity-encoded", () => {
  const html = `<input name="a&amp;b"><input name='c'><select name=d></select>`;
  assert.deepEqual(missingFields([field("a&b"), field("c"), field("d")], html), []);
});

test("data-name is not a name, and a radio group is reported once", () => {
  const fields = [field("x"), field("g", "radio"), field("g", "radio")];
  const missing = missingFields(fields, `<div data-name="x"></div>`);
  assert.deepEqual(missing.map((f) => f.name), ["x", "g"]);
});

// The page render, with a router that records each prompt. Only what extraction touches is
// real, as in pdf-links.test.ts.
async function render(fields: PdfField[], html: string) {
  const dir = mkdtempSync(join(tmpdir(), "iris-fields-"));
  try {
    const agentsDir = join(dir, "agents");
    const fragDir = join(dir, "fragments");
    for (const d of [agentsDir, fragDir]) mkdirSync(d, { recursive: true });
    writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
    writeFileSync(join(dir, "page-001.png"), "not-a-real-png");
    const prompts: string[] = [];
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const ctx = {
      sessionId: "ses_test",
      images: [{ name: "page-001.png", order: 1, path: join(dir, "page-001.png"), links: [], fields }],
      extractionConcurrency: 1,
      recheckSampleSize: 1,
      maxReviewIterations: 1,
      paths: {
        agentsDir,
        tmpAgentsDir: () => join(dir, "tmp-agents"),
        agentMemory: (agent: string) => join(dir, `mem-${agent.replace(/\.md$/, "")}.json`),
        sessionFragments: () => fragDir,
      } as unknown as Paths,
      router: {
        complete: async (_agent: string, _cap: string, messages: { content: string }[]) => {
          prompts.push(messages.map((m) => m.content).join("\n"));
          return { text: JSON.stringify({ html, log: "" }) };
        },
      },
      log: { event: (type: string, data: Record<string, unknown> = {}) => events.push({ type, data }), agentCall: () => {} },
    } as unknown as PipelineContext;
    await runExtraction(ctx);
    return { prompts, events };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the page agent is shown the page's fields, and an unnamed one is logged, not corrected", async () => {
  const { prompts, events } = await render(
    [field("applicant.name"), field("applicant.consent", "checkbox")],
    `<p><label>Full name <input name="applicant.name"></label></p><p><input type="checkbox"> I agree</p>`,
  );
  assert.equal(prompts.length, 1, "a missing field buys no correction pass");
  assert.match(prompts[0], /## Form fields on this page/);
  assert.ok(prompts[0].includes(`"applicant.consent" (checkbox)`));
  assert.equal(events.find((e) => e.type === "page_fields")?.data.fields, 2);
  assert.deepEqual(events.find((e) => e.type === "page_fields_missing")?.data.fields, ["applicant.consent"]);
});

test("a page with no fields sends the prompt it always sent", async () => {
  const { prompts, events } = await render([], "<p>Plain page.</p>");
  assert.ok(!prompts[0].includes("## Form fields"));
  assert.ok(!events.some((e) => e.type.startsWith("page_fields")));
});
