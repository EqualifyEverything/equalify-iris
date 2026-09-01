import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { perAgentKeyWarning } from "../src/config.ts";

// `providers.per_agent` is the whole model-selection surface of this deployment, and it is
// the one config key whose failure mode is silence. `resolveAgentModel` looks an override up
// by agent name and, finding none, falls back through the provider's `per_capability` to its
// `default_model` — so a key naming an agent nothing dispatches is not a startup error, does
// not appear in `by_agent` (which reports the agents that RAN), and costs what the run would
// have cost anyway. A model that was never swapped looks exactly like one that was.
//
// It had already happened twice, in the two files an operator reads first, and both were
// relics of the per-content-type fan-out prd.md §7.4 v1.2 withdrew: `config.example.yaml`
// offered a commented `table:` line described as the way to put a stronger model on the table
// join, and prd.md §10.3's block showed `image_analysis: bedrock`. They are stale in different
// ways, which is why this file pins the set rather than those two names — `image_analysis` was
// the triage agent and went with `src/pipeline/triage.ts`; `table` was never dispatched by
// anything, so no removal could have caught it.
//
// So the check is on the call sites, not on a list. src/config.ts has to carry the static
// names as literals (it cannot read the pipeline it configures), and this is what holds that
// literal to the code: derive the same set from every `router.complete` call in src/ and fail
// if the two disagree in either direction.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const AGENTS_DIR = join(ROOT, "agents");

// Every `.ts` under src/, so a new pipeline file with a new agent is in scope without being
// added anywhere.
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

// The first argument of each `ctx.router.complete(...)` / `this.router.complete(...)` call,
// which is the agent name the override is looked up by. Two shapes reach the router and only
// one of them is a name this can read: a literal or a SCREAMING_CASE const (`PAGE_AGENT`),
// which is resolved to its own literal below; or `agent.name`, the specialist and per-agent
// paths, whose name comes from a file in agents/ at run time and cannot be known here. The
// dynamic ones are counted separately and asserted to exist, because their existence is the
// reason the startup check warns instead of refusing.
function dispatchedAgents(): { literal: Set<string>; dynamic: number } {
  const literal = new Set<string>();
  let dynamic = 0;
  for (const file of sources(SRC)) {
    const text = readFileSync(file, "utf8");
    // `const NAME = "value";` in this file, for resolving a constant first argument.
    const consts = new Map<string, string>();
    for (const m of text.matchAll(/const ([A-Z][A-Z0-9_]*) = "([^"]+)";/g)) consts.set(m[1]!, m[2]!);
    for (const m of text.matchAll(/router\.complete\(\s*([^,]+),/g)) {
      const arg = m[1]!.trim();
      const quoted = arg.match(/^"([^"]+)"$/);
      if (quoted) literal.add(quoted[1]!);
      else if (consts.has(arg)) literal.add(consts.get(arg)!);
      else dynamic++;
    }
  }
  return { literal, dynamic };
}

// Read the literal src/config.ts declares, rather than exporting it: the point is that the
// hand-written list agrees with the code, and importing a value the source disagreed with
// would test nothing. Parsed from the source for the same reason test/config-example.test.ts
// parses the YAML it is about.
function declaredAgents(): string[] {
  const text = readFileSync(join(SRC, "config.ts"), "utf8");
  const m = text.match(/const DISPATCHED_AGENTS = \[([^\]]+)\] as const;/);
  assert.ok(m, "DISPATCHED_AGENTS moved or was renamed in src/config.ts");
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

test("the agent names src/config.ts can route are the ones src/ actually dispatches", () => {
  const { literal, dynamic } = dispatchedAgents();
  const declared = declaredAgents();

  assert.deepEqual(
    [...declared].sort(),
    [...literal].sort(),
    "DISPATCHED_AGENTS in src/config.ts disagrees with the router.complete call sites in src/ — " +
      "add the new agent there (and to config.example.yaml's list) or drop the one that went",
  );

  // The reason `perAgentKeyWarning` warns rather than refusing. If this ever reaches 0, the
  // set of valid keys is closed and an unknown one could be a startup error instead.
  assert.ok(
    dynamic > 0,
    "no router.complete call takes a run-time agent name any more, so the valid per_agent keys " +
      "are now a closed set — an unknown key could be refused at startup rather than warned about",
  );
});

// The half the derivation above cannot see: a specialist's name is the file stem of a `.md` in
// `agents_dir` (src/agents/loader.ts `loadAgent`), so the warning has to read that directory
// or it would call today's shipped specialist an unknown agent.
test("a specialist shipped in agents/ is a routable per_agent key", () => {
  const shipped = readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
  assert.ok(shipped.length > 0, "agents/ has no .md files; this test's premise is gone");
  const specialists = shipped.filter((n) => !declaredAgents().includes(n));
  assert.ok(
    specialists.length > 0,
    "agents/ holds no file beyond the statically dispatched agents, so this test no longer " +
      "exercises the library half of the lookup",
  );
  assert.equal(perAgentKeyWarning({ [specialists[0]!]: "bedrock" }, AGENTS_DIR), undefined);
});

test("per_agent keys that name no agent are warned about, and routable ones are not", () => {
  // Silence on the whole dispatched set, which is what makes a warning readable when it comes.
  const all = Object.fromEntries(declaredAgents().map((a) => [a, "bedrock"]));
  assert.equal(perAgentKeyWarning(all, AGENTS_DIR), undefined);
  assert.equal(perAgentKeyWarning({}, AGENTS_DIR), undefined);
  assert.equal(perAgentKeyWarning(undefined, AGENTS_DIR), undefined);

  // The two names the shipped examples used, and the shape of a typo.
  const w = perAgentKeyWarning({ table: "openrouter", image_analysis: "bedrock" }, AGENTS_DIR);
  assert.ok(w, "an unroutable per_agent key produced no warning");
  assert.match(w, /"table"/);
  assert.match(w, /"image_analysis"/);
  // The consequence, not just the name: an operator who reads only the first clause has to
  // learn that the entry is ignored, since that is the part no log will tell them.
  assert.match(w, /ignored/);
  // And the way out, including the one an operator is most likely to be looking for.
  for (const agent of declaredAgents()) assert.ok(w.includes(agent), `warning omits ${agent}`);
  assert.match(w, /table join is a copy_editor call/);

  // A routable key alongside a broken one is not named as broken.
  const mixed = perAgentKeyWarning({ page: "bedrock", tabel: "bedrock" }, AGENTS_DIR);
  assert.ok(mixed?.includes('"tabel"'));
  assert.ok(!/"page"/.test(mixed!), "a routable key was reported as unroutable");
});

test("an unreadable agents_dir warns about nothing rather than about everything", () => {
  // The directory is the likelier thing to be wrong, and a deployment whose library failed to
  // check out would otherwise get every specialist entry reported as a bad key on every boot.
  const missing = join(mkdtempSync(join(tmpdir(), "iris-agents-")), "nope");
  assert.equal(perAgentKeyWarning({ chartDataAgent: "bedrock" }, missing), undefined);

  // An empty but readable directory still warns, because there is nothing to have missed.
  const empty = mkdtempSync(join(tmpdir(), "iris-agents-empty-"));
  assert.match(perAgentKeyWarning({ chartDataAgent: "bedrock" }, empty)!, /"chartDataAgent"/);

  // And a specialist added to a library later is routable without a code change, which is the
  // property that makes this a warning.
  const later = mkdtempSync(join(tmpdir(), "iris-agents-later-"));
  mkdirSync(later, { recursive: true });
  writeFileSync(join(later, "formFieldAgent.md"), "# Form Field Agent\n");
  assert.equal(perAgentKeyWarning({ formFieldAgent: "bedrock" }, later), undefined);
});

// The examples are the reason this file exists, so they are asserted rather than trusted:
// every agent key any shipped example names must be one of the dispatched agents. Both files,
// because both were wrong, and including the COMMENTED block in config.example.yaml — a line
// an operator is told to uncomment is a line that has to work.
test("every per_agent key any example names is an agent Iris dispatches", () => {
  const known = new Set([
    ...declaredAgents(),
    ...readdirSync(AGENTS_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, "")),
  ]);

  for (const file of ["config.example.yaml", "prd.md"]) {
    const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
    const start = lines.findIndex((l) => /^\s*#?\s*per_agent:/.test(l));
    assert.ok(start >= 0, `${file} no longer contains a per_agent block; drop this or repoint it`);
    let found = 0;
    for (const raw of lines.slice(start + 1)) {
      // Strip a YAML comment marker so the commented example is read as the operator would
      // uncomment it, then stop at the first line that is not an entry under the key.
      const line = raw.replace(/^(\s*)#\s?/, "$1");
      const m = line.match(/^\s{4,}([A-Za-z_][A-Za-z0-9_]*)\s*:/);
      if (!m) {
        if (/^\s*#/.test(raw) || raw.trim() === "" || /^\s{4,}#/.test(line)) continue;
        break;
      }
      found++;
      assert.ok(
        known.has(m[1]!),
        `${file} offers per_agent key "${m[1]}", which no router.complete call dispatches — ` +
          `it would be silently ignored. Routable: ${[...known].sort().join(", ")}`,
      );
    }
    assert.ok(found > 0, `${file}'s per_agent block has no entries under it to check`);
  }
});
