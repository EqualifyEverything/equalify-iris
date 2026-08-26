import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
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
});
