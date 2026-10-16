import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordSuggestions, STANDARD } from "../src/pipeline/contribute.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";
import type { SuggestionRow } from "../src/store/db.ts";

// A suggestion naming a content type the general page pass already covers must never be
// recorded, because the agent-suggestions workflow turns records into public issues
// (#539). `STANDARD` is the whole filter: the nine standard agent files are gone, so
// `loadAgent` no longer catches a padded or re-cased standard name.

interface Rec {
  rows: SuggestionRow[];
  events: { type: string; data: Record<string, unknown> }[];
  modelCalls: number;
}

async function record(names: string[], opts: { agentFiles?: string[] } = {}): Promise<Rec> {
  const dir = mkdtempSync(join(tmpdir(), "iris-standard-"));
  const agentsDir = join(dir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (const f of opts.agentFiles ?? []) writeFileSync(join(agentsDir, f), "# Agent\n");
  const rec: Rec = { rows: [], events: [], modelCalls: 0 };
  const ctx = {
    sessionId: "ses_test",
    paths: { agentsDir, tmpAgentsDir: () => join(dir, "tmp-agents") } as unknown as Paths,
    // Counted: recording must never call a model. Drafting moved to the workflow.
    router: { complete: async () => { rec.modelCalls++; return { text: "" }; } },
    log: { event: (type: string, data: Record<string, unknown> = {}) => rec.events.push({ type, data }) },
    recordSuggestions: (rows: SuggestionRow[]) => rec.rows.push(...rows),
  } as unknown as PipelineContext;
  try {
    recordSuggestions(ctx, names.map((name, i) => ({ name, reason: `reason ${i}`, image: "page-001.png" })));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return rec;
}

test("no standard content type is ever recorded", async () => {
  // Every name in the set, not a sample: a typo in one entry would let one type through.
  const rec = await record([...STANDARD]);
  assert.deepEqual(rec.rows, []);
  assert.deepEqual(rec.events, []);
});

test("whitespace, a .md extension, or a case variant of a standard type is filtered too", async () => {
  const rec = await record([" table.md \n", "  formField.md  ", " list ", "Table", "FOOTNOTE", " Heading.md "]);
  assert.deepEqual(rec.rows, []);
});

test("a new type is recorded with its page and reason, and no model is called", async () => {
  const rec = await record(["chartDataAgent"]);
  assert.equal(rec.modelCalls, 0);
  assert.deepEqual(rec.rows, [
    { kind: "new_agent", agent: "chartDataAgent", session_id: "ses_test", page: "page-001.png", reason: "reason 0" },
  ]);
  assert.deepEqual(rec.events, [{ type: "suggestions_recorded", data: { agents: ["chartDataAgent"], count: 1 } }]);
});

test("two spellings of one type on one page are one record", async () => {
  const rec = await record(["chartData", "chartdata", "CHARTDATA.md"]);
  assert.deepEqual(rec.rows.map((r) => r.agent), ["chartData"]);
});

test("a type the library already has is not recorded", async () => {
  const rec = await record(["chartData"], { agentFiles: ["chartData.md"] });
  assert.deepEqual(rec.rows, []);
});
