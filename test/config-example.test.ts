import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, type Capability } from "../src/config.ts";
import { resolveAgentModel } from "../src/providers/index.ts";
import { modelGeneration, resolveImageLimits } from "../src/providers/imageLimits.ts";
import { claudeFamily, cacheableSystemPrompt } from "../src/providers/promptCache.ts";

// `config.example.yaml` is the file README.md and CONTRIBUTING.md tell an operator to
// copy to `config.yaml`, and until this test nothing in the suite parsed it. So a key
// renamed in src/config.ts, a schema-invalid block, or a `${VAR}` that no longer expands
// would ship green and be discovered by the operator on their first run — the one run
// they cannot debug, because they have not read the code yet.
//
// It is also the file that says which model this project runs (#176). That claim is worth
// asserting rather than trusting to a comment: the ids are strings, nothing typechecks
// them, and two of the behaviours they select are silent when they are wrong.

const EXAMPLE = fileURLToPath(new URL("../config.example.yaml", import.meta.url));

// The agents the file's own per_agent comment says are dispatched today, times every
// capability. With `per_agent: {}` these all walk the same fallback chain, so what this
// pins is that the chain ANSWERS for each pair and that the default provider is where it
// lands — not that each agent was configured separately. It is still the assertion that
// would catch the file naming a provider it does not define, or an agent the comment lists
// that resolution has no route for, and it is what an operator uncommenting a per_agent
// line runs into. `builder` is in the list for the same reason as the rest: it is dispatched.
const AGENTS = ["page", "reader", "copy_editor", "feedback", "builder"];
const CAPABILITIES: Capability[] = ["text", "vision", "structured_output"];

test("the example config an operator copies loads, and needs exactly the one credential it names", () => {
  // The unset case FIRST, and this ordering is load-bearing: `loadConfig` memoizes by
  // resolved path, so a successful load below would be handed back here and the check
  // would pass without validating anything.
  delete process.env.OPENROUTER_API_KEY;
  assert.throws(
    () => loadConfig(EXAMPLE),
    /OPENROUTER_API_KEY/,
    "an unexpanded credential must fail at startup, by name, rather than reappear mid-run as a 401",
  );

  // And with that one variable set it loads — one credential and no cloud account, which
  // is what `providers.default: openrouter` is in the file for. The bedrock block is
  // present and unreferenced, and must not be validated for credentials it does not need.
  process.env.OPENROUTER_API_KEY = "test-key";
  const cfg = loadConfig(EXAMPLE);
  assert.equal(cfg.providers.default, "openrouter");
  assert.ok(cfg.providers.bedrock?.default_model, "the second provider block should still be present");
});

test("every agent the example dispatches resolves to a model, on the provider it names", () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const { providers } = loadConfig(EXAMPLE);
  for (const agent of AGENTS) {
    for (const capability of CAPABILITIES) {
      const { provider, model } = resolveAgentModel(providers, agent, capability);
      assert.equal(provider, "openrouter", `${agent}/${capability} left the default provider`);
      assert.ok(model, `${agent}/${capability} resolved to no model at all`);
    }
  }
});

// #176: the file pinned Opus 4.7 on both providers while every deployment and every
// published number was Sonnet 4.6. What that cost is in the issue; what it must not cost
// again is silence, so the property asserted here is INTERNAL AGREEMENT rather than a
// model name — the name is allowed to change, and does. Both blocks, every capability,
// naming one model in the two id spellings the two providers use.
test("both provider blocks in the example name the same model", () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const { providers } = loadConfig(EXAMPLE);
  const ids: string[] = [];
  for (const name of ["openrouter", "bedrock"] as const) {
    const block = providers[name];
    assert.ok(block, `${name} block is missing`);
    ids.push(block.default_model);
    for (const capability of CAPABILITIES) {
      const model = block.per_capability?.[capability];
      assert.ok(model, `${name}.per_capability.${capability} is unset, so it falls back silently`);
      ids.push(model);
    }
  }
  assert.equal(ids.length, 8);

  const generations = ids.map((id) => {
    const gen = modelGeneration(id);
    // An id this cannot parse is the quiet failure: `longEdgeFor` and the cache
    // thresholds both fall back on it, so the deployment publishes and caches as though
    // it were the oldest model rather than saying anything.
    assert.ok(gen, `${id} is not an id modelGeneration can read`);
    return `${gen.major}.${gen.minor}`;
  });
  assert.equal(new Set(generations).size, 1, `the example names more than one generation: ${generations.join(", ")}`);
  assert.equal(new Set(ids.map((id) => claudeFamily(id))).size, 1, `mixed families: ${ids.join(", ")}`);

  // Bedrock's ids need the region prefix — the file's own comment says the bare
  // `anthropic.*` form is rejected for on-demand use, so an example carrying one 400s on
  // the operator's first call.
  for (const id of ids.slice(4)) assert.match(id, /^(us|global)\./, `${id} has no inference-profile prefix`);
  // OpenRouter's are `vendor/model` slugs.
  for (const id of ids.slice(0, 4)) assert.match(id, /^[a-z0-9-]+\//, `${id} is not an OpenRouter slug`);

  // And the model the example picks is one prompt caching applies to. This is the other
  // silent one: a model outside the cache-eligible generations turns every cached prefix
  // into a full-price prefix, and nothing in a run says so — the bill says so.
  const long = "x ".repeat(8000);
  for (const id of ids) assert.ok(cacheableSystemPrompt(id, long), `${id} would silently disable prompt caching`);
});

// The one number the example's model choice PUBLISHES, checked against the place it is
// published. `GET /v1/limits` derives `max_long_edge_px` from the configured model, and
// docs/API.md prints a sample response with the value spelled out — so a model change in the
// example config silently makes the documented sample wrong, and a client that hardcoded it
// from the docs (which §3.1 exists to talk them out of) downscales to the wrong edge.
//
// Asserted against the docs rather than against 1568, so this is a drift check and not a
// second copy of the number: whoever changes the model has one file left to update and this
// says which. The prose above the sample quotes the same figure beside the model's name.
test("the long edge the example publishes is the one the API sample prints", () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const resolved = resolveImageLimits(loadConfig(EXAMPLE)).max_long_edge_px;

  const docs = readFileSync(fileURLToPath(new URL("../docs/API.md", import.meta.url)), "utf8");
  const printed = docs.match(/"max_long_edge_px":\s*(\d+)/g) ?? [];
  assert.equal(printed.length, 1, `docs/API.md prints max_long_edge_px ${printed.length} times`);
  assert.equal(Number(printed[0]!.match(/(\d+)/)![1]), resolved);

  // The prose above the sample states the same number beside the model's name, and it is the
  // copy a reader is more likely to act on than the JSON. Only the figure is asserted — the
  // model NAME is deliberately not pinned anywhere in this file, since the name is allowed to
  // change and this suite's whole approach to #176 is to assert agreement instead.
  const sentence = docs.match(/long-edge limit \((\d+) px on /);
  assert.ok(sentence, "docs/API.md no longer states the long edge in prose; drop this or repoint it");
  assert.equal(Number(sentence[1]), resolved, "the prose long edge and the configured model disagree");
});

// The examples an operator uncomments, actually uncommented. They sit under `per_agent`, whose
// active value is `{}`, and YAML will not accept a mapping entry indented beneath a flow map —
// so a copied line that looks like an addition to an empty map is a startup parse error naming
// a line number. It fails loudly, so nobody ships on it; it is a papercut on the one file whose
// entire job is somebody's first run, which is why the block is commented out KEY AND ALL and
// why this test does what the comment tells the operator to do.
//
// It also puts the override forms themselves under test. Three of them are exercised here —
// the bare `<agent>: <provider>` string, a model pinned on the default provider, and both at
// once — and the pairing the block recommends is the assertion at the end: verification must
// not land on the model extraction used, or the example advises against itself.
test("the commented per_agent examples load if an operator uncomments them", () => {
  const text = readFileSync(EXAMPLE, "utf8");
  const lines = text.split("\n");

  const start = lines.indexOf("  # per_agent:");
  assert.ok(start >= 0, "the commented per_agent block moved or was renamed");
  let end = start + 1;
  while (end < lines.length && /^ {2}# {3}\S/.test(lines[end]!)) end++;
  assert.ok(end - start > 2, "the commented per_agent block has no entries under it");
  const active = lines.findIndex((l) => /^ {2}per_agent: \{\}\s*$/.test(l));
  assert.ok(active >= 0 && active < start, "the empty per_agent line moved");

  lines.splice(start, end - start, ...lines.slice(start, end).map((l) => l.replace(/^( *)# ?/, "$1")));
  lines.splice(active, 1);

  process.env.OPENROUTER_API_KEY = "test-key";
  const path = join(mkdtempSync(join(tmpdir(), "iris-config-example-")), "config.yaml");
  writeFileSync(path, lines.join("\n"));
  const { providers } = loadConfig(path);

  // `page: bedrock` — routed, and at the provider's own model rather than a missing one.
  const page = resolveAgentModel(providers, "page", "vision");
  assert.equal(page.provider, "bedrock", "the bare-string override did not route the agent");
  assert.ok(page.model.startsWith("us."), `page resolved to ${page.model}`);
  // `copy_editor: { model: … }` — a model pinned without naming a provider stays on the
  // default one. This line used to read `table:`, and the assertion passed, which is how the
  // example survived: `resolveAgentModel` answers for any name, so proving an override
  // RESOLVES proves nothing about whether anything dispatches it. No call site has ever
  // passed "table" (the join is a `copy_editor` call, pipeline/tables.ts), so what this
  // assertion demonstrated was the silent fallback rather than the override. The agent names
  // are pinned against the call sites in "every per_agent key any example names is an agent
  // Iris dispatches" below; this test keeps its own job, which is the three override FORMS.
  const editor = resolveAgentModel(providers, "copy_editor", "vision");
  assert.equal(editor.provider, "openrouter");
  assert.match(editor.model, /^[a-z0-9-]+\//);
  // `reader: { provider, model }` — both at once.
  const reader = resolveAgentModel(providers, "reader", "text");
  assert.equal(reader.provider, "bedrock");
  assert.match(reader.model, /^us\./);

  const feedback = resolveAgentModel(providers, "feedback", "vision");
  assert.notEqual(
    claudeFamily(feedback.model),
    claudeFamily(page.model),
    "the example puts verification on the same model as extraction, which it also recommends against",
  );
});
