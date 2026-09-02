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
// have cost anyway. `by_agent.<agent>.models` closes half of that: a finished run now names
// the model each agent used, so a swap that did not happen is visible after the fact. The
// ignored KEY still appears nowhere but this warning, which is also the only account of it
// that arrives before the run is paid for.
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
  // And the way out. The two routable sets are named SEPARATELY — the dispatched agents, then
  // the directory and what is in it — because that is the distinction the sentence exists to
  // draw, and one merged list has to be sorted, which drops a specialist in the middle of the
  // built-ins. An earlier draft said "the last of those beyond <built-ins> are specialist
  // files" over a sorted list, where `chartDataAgent` came out second.
  for (const agent of declaredAgents()) assert.ok(w.includes(agent), `warning omits ${agent}`);
  assert.match(w, /any agent file in .*agents/);
  const shipped = readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .filter((n) => !declaredAgents().includes(n));
  for (const s of shipped) assert.ok(w.includes(s), `warning omits the specialist ${s}`);

  // `table` earns its own sentence, because that key was shipped in this repo's own example
  // and the join really is a copy_editor call — but only where it answers the key in hand.
  assert.match(w, /no table agent/);

  // A routable key alongside a broken one is not named as broken, and a typo does not get a
  // sentence about tables.
  const mixed = perAgentKeyWarning({ page: "bedrock", tabel: "bedrock" }, AGENTS_DIR);
  assert.ok(mixed?.includes('"tabel"'));
  assert.ok(!/"page"/.test(mixed!), "a routable key was reported as unroutable");
  assert.ok(!/table agent/.test(mixed!), "a typo was answered with a sentence about tables");
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

  // A YAML comment marker is stripped so a commented example is read as the operator would
  // uncomment it — but only for a block whose own `per_agent:` was commented, and only for
  // lines indented deeper than that key. An earlier version scanned everything after the
  // FIRST `per_agent:` and stopped at the first line that was neither an entry, a comment nor
  // blank, which in config.example.yaml is `openrouter:` some forty lines later: every
  // paragraph of prose in between was a candidate, and one indented comment reading
  // `#   max_tokens: 32000` anywhere in that span would have failed this suite claiming the
  // file offers a per_agent key called `max_tokens`. Both files carry more than one block, so
  // each is scanned in turn rather than picking one.
  const blocks = /^(\s*)(#\s?)?per_agent:/;
  for (const file of ["config.example.yaml", "prd.md", "docs/models.md"]) {
    const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
    let found = 0;
    let seenBlock = false;
    for (const [i, head] of lines.entries()) {
      const b = head.match(blocks);
      if (!b) continue;
      seenBlock = true;
      const indent = b[1]!.length;
      const commented = Boolean(b[2]);
      for (const raw of lines.slice(i + 1)) {
        // A COMMENTED block is the contiguous run of comment lines, because that run is what
        // an operator uncomments as a unit — so prose inside it is skipped rather than ending
        // the block, and only a blank line or live YAML closes it. config.example.yaml's block
        // ends with three prose lines about `copy_editor`, and an entry written after that
        // paragraph is still an entry the operator would uncomment; stopping at the prose would
        // leave it unchecked while this test passed.
        //
        // A LIVE block runs to the first line at or above the key's own indent, since that is
        // the line that has left the mapping. YAML allows both blank lines and comments
        // between two entries, so neither ends it — and neither can BE an entry, so both are
        // skipped rather than read (prd.md's `# everything else uses default` is a comment
        // about the block, and a `#` line in a live block cannot be an override however it is
        // indented).
        const isComment = /^\s*#/.test(raw);
        const blank = raw.trim() === "";
        if (commented) {
          if (!isComment) break;
        } else if (blank || isComment) continue;
        const line = commented ? raw.replace(/^(\s*)#\s?/, "$1") : raw;
        const m = line.match(/^(\s+)([A-Za-z_][A-Za-z0-9_]*)\s*:/);
        if (m === null || m[1]!.length <= indent) {
          if (commented) continue;
          break;
        }
        found++;
        assert.ok(
          known.has(m[2]!),
          `${file} offers per_agent key "${m[2]}", which no router.complete call dispatches — ` +
            `it would be silently ignored. Routable: ${[...known].sort().join(", ")}`,
        );
      }
    }
    assert.ok(seenBlock, `${file} no longer contains a per_agent block; drop this or repoint it`);
    // Self-arming: config.example.yaml's live block is `per_agent: {}` with no entries, so a
    // count above 0 can only come from the COMMENTED example — a stop rule that gave up before
    // reaching it would fail here rather than pass silently.
    assert.ok(found > 0, `${file}'s per_agent blocks have no entries under them to check`);
  }
});

// docs/models.md is a recommendation PER AGENT, so its table is a claim about the same set the
// test above derives — and the sprint report it was written from got that set wrong, listing the
// specialist row in place of `builder` and arriving at five by counting one agent twice. A
// missing row is the failure that matters: an agent nobody has a recommendation for reads as an
// agent with no cost, which is exactly how `builder` and the specialist came to be reported as
// two independent zeroes (they are one gate — see the file).
test("docs/models.md's recommendation table is exactly the agents a deployment can route", () => {
  const doc = readFileSync(join(ROOT, "docs/models.md"), "utf8");
  // The RECOMMENDATION table specifically, not the file. Every dispatched agent also appears in
  // §1's table of call sites, so a check against the whole document passes while the summary a
  // reader actually acts on is missing a row — which is the failure being guarded, and the one
  // an earlier version of this test did not catch when the `builder` row was taken out of §0.
  const section = doc.split(/^## /m).find((s) => s.startsWith("0."));
  assert.ok(section, "docs/models.md has no `## 0.` summary section any more");

  // Both directions, because both are the same mistake in the reader's hands. A MISSING row
  // reads as an agent with no cost; an EXTRA one names a `per_agent` key that would be silently
  // ignored, which is the failure the rest of this file exists for — and a recommendation is
  // the most likely place someone copies such a key from. Rows whose agent cell is backticked
  // are the claim; §0's `specialists` row is deliberately not, since it is a class of agents
  // named at run time and not a key anyone can write.
  const rows = [...section.matchAll(/^\| `([^`]+)`/gm)].map((m) => m[1]!);
  assert.deepEqual(
    [...rows].sort(),
    [...declaredAgents()].sort(),
    "docs/models.md §0's recommendation table and DISPATCHED_AGENTS disagree — a missing row " +
      "leaves a reader unable to tell whether that agent was measured, left alone deliberately " +
      "or forgotten, and an extra one recommends a per_agent key Iris would silently ignore",
  );
});

// The same table's OTHER column is a partition, and the way it goes wrong is one row being
// updated from a new round while its neighbours keep the old round's numbers. That has happened
// twice already in this sprint's reporting: #311 published four shares that summed to 94.6%, and
// §0 carried a set from one round while §6 predicted where a later round would put them. A share
// that does not belong to the same denominator as the one beside it is unusable, and the sum is
// the only free check for it — nothing in the document can tell a reader that 42.0% and 25.0%
// came from different rounds, but they cannot both be true at once.
//
// NOT a check that the figures are current: it passes on any self-consistent set, so it does not
// substitute for the round names §6 attaches to each. It fails on the realistic edit — one row
// moved, the rest left standing.
test("docs/models.md §0's share column is a partition of one round, not a mix of several", () => {
  const doc = readFileSync(join(ROOT, "docs/models.md"), "utf8");
  const section = doc.split(/^## /m).find((s) => s.startsWith("0."));
  assert.ok(section, "docs/models.md has no `## 0.` summary section any more");

  // Second cell of each row, which is the share. Read as a number only when it looks like a
  // percentage, so a row that stops quoting one (or the header separator) is skipped rather than
  // read as zero — a silent 0 would make a broken table sum closer to 100, not further from it.
  const shares = [...section.matchAll(/^\|[^|]+\|\s*\*{0,2}([\d.]+)%\*{0,2}\s*\|/gm)].map((m) =>
    Number(m[1]!),
  );
  assert.ok(shares.length >= 4, `§0 has ${shares.length} share cells; expected one per agent`);
  const sum = shares.reduce((a, b) => a + b, 0);
  // A tenth of a point per row, since each is published rounded to one decimal.
  assert.ok(
    Math.abs(sum - 100) <= shares.length * 0.1,
    `docs/models.md §0's shares sum to ${sum.toFixed(1)}%, not 100% — ${shares.join(" + ")}. ` +
      `Either a row was updated from a newer round while its neighbours kept the old one, or an ` +
      `agent is missing from the denominator. Both read to an operator as "this is where the ` +
      `money is" and neither is.`,
  );
});

// §5's per-agent table is the OTHER partition in this document, and it needs the same guard §0 has.
//
// What it does NOT catch, said plainly because it was proposed as the fix for exactly this: the
// version reviewed on PR #327 left `builder` out of §5 altogether, and no arithmetic check could
// have found that. The four rows summed to the stated total to the cent and the shares summed to
// 100.0%, because the total was ITSELF the four-agent subtotal the harness prints — an agent absent
// from the rows *and* the denominator leaves a table that is internally perfect and mis-labelled.
// The only fix for that shape is naming the denominator in the prose, which §5 now does. A test that
// passes on the defect it was written for is worse than no test, so this one claims a different job.
//
// The job it does have is the realistic later edit: a fifth row added while the total stands, a total
// updated while the rows stand, or one column re-run and the other left stale. It also pins the
// arithmetic the section's own headline is read off — the reviewed draft summarised this table as
// "only about a third of the saving comes from the agent that was swapped" when its two money
// columns give 63.8%, and a table that adds up cannot be summarised backwards without one of the two
// being wrong on its face.
//
// Both money columns, because they fail differently: the SWAPPED column is the one an agent goes
// missing from (a new agent appears in a later round and nobody adds a row), and the UNSWAPPED column
// is the one that goes stale (a re-run moves the baseline and only the interesting half is updated).
test("docs/models.md §5's per-agent rows sum to the total row they are published under", () => {
  const doc = readFileSync(join(ROOT, "docs/models.md"), "utf8");
  const section = doc.split(/^## /m).find((s) => s.startsWith("5."));
  assert.ok(section, "docs/models.md has no `## 5.` section any more");

  // Cells with the bold markers stripped, since emphasis lands on whichever figures moved.
  const rows = section
    .split("\n")
    .filter((l) => l.startsWith("|"))
    .map((l) =>
      l
        .replace(/\*\*/g, "")
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim()),
    );
  const money = (cell: string | undefined) => {
    const m = cell?.match(/\$([\d,]+\.\d+)/);
    return m ? Number(m[1]!.replace(/,/g, "")) : undefined;
  };

  // Anchored on the total row and walked BACK to its own header separator, rather than picking rows
  // that look like agents: §5 carries a second table of Iris's verifier counters whose first cell is
  // also a backticked snake_case name (`content_missing`, `editor_truncated`), and a name-shaped
  // filter swept those in. Structural membership also means "a row with no dollar figure" is a real
  // failure rather than a row this test declined to recognise.
  const iTotal = rows.findIndex((r) => /^total\b/.test(r[0] ?? ""));
  assert.ok(iTotal > 0, "docs/models.md §5's per-agent table has no `total` row to check against");
  const total = rows[iTotal]!;
  const agents: string[][] = [];
  for (let i = iTotal - 1; i >= 0 && !/^-+$/.test(rows[i]![0] ?? ""); i--) agents.unshift(rows[i]!);
  assert.ok(agents.length >= 4, `§5 lists ${agents.length} agent rows; expected one per agent`);

  for (const [col, label] of [
    [1, "unswapped"],
    [2, "swapped"],
  ] as const) {
    const parts = agents.map((r) => money(r[col]));
    assert.ok(
      parts.every((p) => p !== undefined),
      `§5's ${label} column has a row with no dollar figure in it: ` +
        `${agents.map((r) => `${r[0]}=${r[col]}`).join(", ")}`,
    );
    const sum = parts.reduce((a, b) => a! + b!, 0)!;
    const stated = money(total[col]);
    assert.ok(stated !== undefined, `§5's total row has no ${label} figure`);
    // Half a cent per row: the rows are published to four decimals, the total to four.
    assert.ok(
      Math.abs(sum - stated) <= agents.length * 0.005,
      `docs/models.md §5's ${label} agent rows sum to $${sum.toFixed(4)}, but the total row says ` +
        `$${stated.toFixed(4)}. An agent that ran and is not in this table reads as an agent that ` +
        `cost nothing, and the share column beside it then partitions a subtotal while the prose ` +
        `calls it the round.`,
    );
  }

  // And the share column, which is only meaningful over the total the rows above actually sum to.
  const shares = agents.map((r) => Number(r[r.length - 1]!.match(/([\d.]+)%/)?.[1]));
  assert.ok(
    shares.every((s) => Number.isFinite(s)),
    `§5's last column is not a share on every agent row: ${agents.map((r) => r[r.length - 1]).join(" | ")}`,
  );
  const shareSum = shares.reduce((a, b) => a + b, 0);
  assert.ok(
    Math.abs(shareSum - 100) <= shares.length * 0.1,
    `docs/models.md §5's post-swap shares sum to ${shareSum.toFixed(1)}%, not 100% — ` +
      `${shares.join(" + ")}.`,
  );

  // And the figures the section's HEADLINE is actually read off, which is the gap the two sums above
  // leave open: each agent's share of the SAVING is a difference of the two money columns, so an edit
  // that moves the table and leaves this sentence standing reproduces the reviewed defect exactly —
  // both columns would still sum, the shares would still be 100.0%, and everything above would pass
  // while the prose said "a third" of a saving that is two thirds. Recomputed from the same rows
  // rather than pinned as literals, so it is the relationship that is asserted and not the numbers.
  const totalDelta = money(total[1])! - money(total[2])!;
  const attributed = [
    ...section.matchAll(/`([a-z_]+)`\s+(?:is|gives)\s+\$([\d.]+)(?:\s+back)?\s+\((−?[\d.]+)%\)/g),
  ];
  assert.equal(
    attributed.length,
    agents.length,
    `§5 attributes the saving to ${attributed.length} agents but its table has ${agents.length} ` +
      `rows — every row's contribution to the saving has to be stated, including a negative one, or ` +
      `the sentence adds to less than the total it claims to break down`,
  );
  for (const [, name, dollars, percent] of attributed) {
    const row = agents.find((r) => r[0] === `\`${name}\``);
    assert.ok(row, `§5 attributes part of the saving to \`${name}\`, which has no row in its table`);
    const delta = money(row[1])! - money(row[2])!;
    // Written unsigned with "back" where an agent got dearer, so compare magnitudes here and let the
    // percentage carry the sign.
    assert.ok(
      Math.abs(Math.abs(delta) - Number(dollars)) <= 0.0001,
      `§5 says \`${name}\` accounts for $${dollars} of the saving, but its own row is ` +
        `${row[1]} → ${row[2]}, a difference of $${Math.abs(delta).toFixed(4)}`,
    );
    const stated = Number(percent.replace("−", "-"));
    const actual = (delta / totalDelta) * 100;
    assert.ok(
      Math.abs(actual - stated) <= 0.1,
      `§5 says \`${name}\` is ${percent}% of the saving; its own columns give ` +
        `${actual.toFixed(1)}% ($${delta.toFixed(4)} of $${totalDelta.toFixed(4)}). This is the ` +
        `sentence a reader takes the keep-or-revert decision from.`,
    );
  }
});

// §0's table is the summary, and the sections restate it. That restatement is the document's most
// frequent defect: five of the false statements PR #327 removed were a claim corrected in one place
// and left standing in another, and #327 itself merged with §8 still saying "the revert is the one
// config line" an hour after §5 had been corrected to two. Then #329 flipped `copy_editor` from a
// keep to a recommended swap, which had to be rewritten in four places — the intro, §0, §4 and §8 —
// and nothing in the repo could have told anyone if one had been missed.
//
// So this pins the join, in both of the ways the two statements can disagree: the SHARE (§0's column
// is re-quoted in the section's own opener, and a re-run that moves one leaves the other stale) and
// the DISPOSITION (keep / declined / recommended / applied, which is the thing a reader acts on).
//
// Deliberately not a check that either is correct — §0's share is already pinned as a partition by
// the test above, and no test can say whether "keep" is the right call. This says only that the
// document gives one answer rather than two. That is the whole of the defect it is written for: at no
// point was either copy of a drifted claim unverifiable, and at every point both were present.
//
// Openers only, not every mention. §6 re-quotes all four shares in its drift note and also quotes
// #311's two INCORRECT ones (43.2%, 20.8%) on purpose, so a document-wide sweep would fail on the
// paragraph whose job is to publish a wrong figure — the same trap that made an earlier draft of the
// §5 test above read a table of verifier counters. The cost of scoping this way is real and worth
// naming: §6's drift-note shares go unchecked, and so does any share quoted mid-paragraph.
//
// The agents checked are LISTED rather than discovered, which is the whole of what makes the
// disposition half load-bearing (PR #332 review, note 1). The first version of this test skipped any
// pair it could not classify — `if (want === null || got === null) continue` — so rewording §0's
// cell to "swap pending a decision" disabled the check silently and let §4 go on saying whatever it
// liked. An unclassifiable cell is now a FAILURE for these four, because "§0 stopped stating a
// disposition in words this test knows" is itself the thing worth being told about: either the
// vocabulary below needs a phrase adding, or the summary stopped answering the question a reader
// came for.
//
// Four, not five: `page`, `reader`, `copy_editor` and `feedback` are the agents a model decision has
// been taken or recommended on. `builder` is exempt because it genuinely has no disposition in this
// vocabulary — its §0 cell is a zero with a date on it, not a keep or a swap — and forcing it into
// one would be inventing a decision nobody took. Add an agent here when a decision is taken on it.
const DECIDED = ["page", "reader", "copy_editor", "feedback"] as const;

const DISPOSITIONS = [
  // Ordered, because the phrases overlap: "swap recommended, not yet applied" holds `applied`, and
  // §4's `copy_editor` opener quotes the word "keep" while saying it no longer applies. First match
  // in this order wins, and the text each is matched against is cut at the first comma or dash so a
  // later clause cannot reclassify a paragraph.
  ["declined", /declin/i],
  ["recommended", /recommend/i],
  ["keep", /\bkeep\b/i],
  ["applied", /\bswapped\b|\bapplied\b|\blive\b/i],
] as const;

function disposition(text: string): string | null {
  const clause = text.split(/,| — |\s—\s/)[0]!;
  return DISPOSITIONS.find(([, re]) => re.test(clause))?.[0] ?? null;
}

test("docs/models.md's sections agree with §0 about each agent's share and disposition", () => {
  const doc = readFileSync(join(ROOT, "docs/models.md"), "utf8");
  const summary = doc.split(/^## /m).find((s) => s.startsWith("0."));
  assert.ok(summary, "docs/models.md has no `## 0.` summary section any more");

  // agent -> [share, status cell], from the rows the test above already treats as the claim.
  const stated = new Map<string, [number, string]>();
  for (const m of summary.matchAll(/^\| `([^`]+)` \|\s*\*{0,2}([\d.]+)%\*{0,2}\s*\|([^|]*)\|/gm)) {
    stated.set(m[1]!, [Number(m[2]!), m[3]!]);
  }
  assert.ok(stated.size >= 4, `§0 yielded ${stated.size} agent rows; expected one per dispatched agent`);

  // A section's opener: a bolded lead-in naming a backticked agent and re-quoting its share. Any
  // further parenthetical between the share and the dash is tolerated — `(0% in this round)` carries
  // a caveat rather than a second figure, and §4's `builder` opener names the specialists too.
  const openers = new Map<string, [string, string]>();
  for (const m of doc.matchAll(/^\*\*`([a-z_]+)` \((\d[\d.]*)%[^—]*—\s*([^*]+)\*\*/gm)) {
    openers.set(m[1]!, [m[2]!, m[3]!]);
  }

  for (const name of DECIDED) {
    const row = stated.get(name);
    assert.ok(row, `\`${name}\` has a model decision on it but no row in §0's table`);
    const [share0, status] = row;
    const opener = openers.get(name);
    assert.ok(
      opener,
      `no section of docs/models.md opens with \`**\`${name}\` (share%) — disposition**\`, so its ` +
        `share and its disposition are stated only in §0 and nothing checks the section a reader ` +
        `is sent to. \`page\` and \`reader\` were both in this position until PR #332.`,
    );
    const [share, text] = opener;
    assert.equal(
      Number(share),
      share0,
      `\`${name}\` is ${share0}% in §0's table and ${share}% in its own section's opener. One of ` +
        `the two was updated from a newer round and the other was not; §0's is the partition that ` +
        `is checked to sum to 100%, so the opener is the likelier stale copy.`,
    );
    // Both sides must classify. A null here is not a pass — see the note above the vocabulary.
    const want = disposition(status!);
    const got = disposition(text);
    const vocabulary = DISPOSITIONS.map(([d]) => d).join(", ");
    assert.ok(
      want,
      `§0's \`${name}\` cell no longer states a disposition this test can read (${vocabulary}): ` +
        `"${status!.trim().slice(0, 80)}". §0 is the table a reader takes the decision from, so ` +
        `either say which of those it is, or add the new phrasing to DISPOSITIONS deliberately.`,
    );
    assert.ok(
      got,
      `\`${name}\`'s own section opens without a disposition this test can read (${vocabulary}): ` +
        `"${text.trim().slice(0, 80)}". Skipping this pair is how the check disabled itself.`,
    );
    assert.equal(
      got,
      want,
      `§0 says \`${name}\` is "${want}" and its own section says "${got}". This is the sentence a ` +
        `reader acts on, and it is the defect that recurred most in this document: a decision ` +
        `changed in the summary and left standing in the section, or the reverse.`,
    );
  }
});
