import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
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
// relics of the per-content-type fan-out that was withdrawn: `config.example.yaml`
// offered a commented `table:` line described as the way to put a stronger model on the table
// join, and the now-retired specification's own block showed `image_analysis: bedrock`. They
// are stale in different ways, which is why this file pins the set rather than those two
// names — `image_analysis` was
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
  for (const file of ["config.example.yaml", "docs/models.md"]) {
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
        // skipped rather than read: a `#` line in a live block is a comment about the block
        // and cannot be an override however it is indented.
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
  // The order of this list decides NOTHING — do not add a phrase here on the assumption that putting
  // it earlier wins. It used to: the phrases overlap ("swap recommended, not yet applied" holds
  // `applied`), first match won, and reordering reclassified documents. That was the defect, because
  // both halves of the check below read this same list in the same order, so an overlapping clause
  // made them agree on the wrong word instead of disagreeing. A clause matching two entries now
  // FAILS. The text each entry is matched against is still cut at the first comma or dash, so a later
  // clause cannot reclassify a paragraph.
  //
  // `open` was added an hour after this test was written, and by the route the comment above
  // predicted: the seat that ran the verifier round retracted its headline, `feedback`'s keep became
  // undecided, and both §0 and §4 stopped stating a disposition in the four words this list knew. The
  // test failed rather than skipping the pair, which is the whole point of listing DECIDED — a
  // decision can be *un*-taken, and "no answer yet" is a disposition a reader has to be told.
  ["open", /\bopen\b|\bundecided\b/i],
  ["declined", /declin/i],
  ["recommended", /recommend/i],
  ["keep", /\bkeep\b/i],
  ["applied", /\bswapped\b|\bapplied\b|\blive\b/i],
] as const;

// EVERY match, not the first one. Resolving a clause that carries two dispositions by list order is
// the same off-switch as skipping one that carries none: both halves of the check below read the same
// vocabulary in the same order, so they would shadow identically and *agree on the wrong word* rather
// than disagree. `feedback` reached "swap recommended … still open" in one revision and stopped one
// comma short of this. An ambiguous clause fails and says which two it matched.
function dispositions(text: string): string[] {
  const clause = text.split(/,| — |\s—\s/)[0]!;
  return DISPOSITIONS.filter(([, re]) => re.test(clause)).map(([d]) => d);
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
    // Both sides must classify, exactly once. Neither a null nor a tie here is a pass — see the two
    // notes above the vocabulary.
    const wants = dispositions(status!);
    const gots = dispositions(text);
    const want = wants[0] ?? null;
    const got = gots[0] ?? null;
    const vocabulary = DISPOSITIONS.map(([d]) => d).join(", ");
    for (const [side, matches, quoted] of [
      ["§0's table cell", wants, status!],
      ["its own section's opener", gots, text],
    ] as const) {
      assert.ok(
        matches.length < 2,
        `\`${name}\`'s ${side} reads as "${matches.join('" and "')}" at once: ` +
          `"${quoted.trim().slice(0, 80)}". Which one wins is decided by the order of DISPOSITIONS, ` +
          `and both halves of this check read that same order — so they would agree on the wrong ` +
          `word instead of disagreeing, and this test would pass on a document that states two ` +
          `dispositions for one agent. Say one thing before the first comma.`,
      );
    }
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

// The last defect in this document that shipped past every gate was a rendering one: fixing a figure
// above, I wrapped a clause in `**` inside a sentence that was already bold, and the outer run was
// left open. It renders as two literal asterisks in front of the sentence stating the price of a
// decision. tsc was clean, all 1328 tests passed, and nothing else in the file reads that paragraph —
// the only thing that caught it was a person reading the diff (PR #332 review round 2).
//
// So this checks the one property a markdown document can lose without anything else noticing: every
// `**` run closes inside the paragraph that opened it. Per paragraph rather than per file, because a
// file-wide count comes back even as soon as a second paragraph breaks the other way, and per
// paragraph is also where the render actually goes wrong.
//
// The unit is a rendered block, NOT a blank-line-delimited chunk. Counting parity over a whole chunk
// lets two odd bullets in one list cancel — an unclosed run in one bullet and another in the next add
// to an even total and the check comes back clean, which is the same off-switch as a guard that skips
// what it cannot classify. So a list item and a table row each start a fresh count; their wrapped
// continuation lines belong to the item they continue, because a `**` legitimately spans those.
//
// Two limits, stated because both will eventually fire on innocent text. This is a parity count, not
// a parser: (1) a deliberate literal `**` in prose fails it, and the fix then is to fence or escape
// that text, not to delete the test — fenced blocks are skipped for the same reason, since they quote
// markup rather than use it. (2) The split below tests what a line *looks* like, so a prose line that
// happens to wrap onto `- and that is the point` or `3. Undecided, because…` starts a fresh count
// mid-sentence, and a `**` run spanning that wrap then reports as two odd blocks. That is a false
// positive and the fix is to reflow the paragraph, not to widen the guard. It is latent in **all
// three** documents this runs over, and the audit is per-document because the answer could differ: in
// docs/models.md the minus signs are U+2212, which the ASCII `[-*+]` class does not match, and no line
// wraps onto an ordered marker — §4's numbered list is where a future edit would hit it first. In
// docs/cost.md the same holds (1 × U+2212, no ASCII minus as a numeric sign) and the five sampling
// bounds are genuine ordered markers. docs/sprint-246.md was audited the same way when the report was
// split out of docs/cost.md (15 × U+2212, no ASCII minus as a sign, and §5's `1./2./3.` genuine): both
// lines were checked on it rather than assumed from its parent, which is what a fourth document added
// to the loop below owes as well. Count occurrences with `grep -o … | wc -l`, not `grep -c`, which
// counts matching LINES — this comment first recorded 15 as "12" for exactly that reason, and 12 is
// the number of lines those 15 signs sit on.
function unclosedBoldRuns(doc: string): string[] {
  const unclosed: string[] = [];
  let fenced = false;
  // [line number, text] per line, so the message can name the run that is left open rather than the
  // top of the block — round 3 asked for that and it is the line an editor has to go and look at.
  let block: [number, string][] = [];

  // A `**` inside an inline code span is not emphasis: `src/**` and `.github/workflows/**` are glob
  // patterns, and GFM renders what is between backticks literally by definition. Stripped before
  // counting, or every path pattern written in prose reads as a run that never closes. Four lines of
  // docs/ci.md are what found this, on the commit that first brought that text under this check —
  // it had lived in README.md, which this loop did not cover.
  //
  // Stripping is per line, like everything else here, and a code span WRAPPED across a line break
  // therefore strips the wrong range: the half-span on each line pairs with the next backtick it
  // finds, which can swallow a real `**` in between. docs/sprint-246.md had one (`git worktree
  // list`, split across two lines), and the run it swallowed was the one this check exists to catch,
  // so adding the strip turned a masked defect into a false positive on the same line. It is
  // reflowed rather than parsed for, which is what the note above says to do with a false positive
  // of this shape — but unlike that one, this failure mode also HIDES defects, so if a wrapped span
  // is ever legitimately needed the strip has to become a real scan, not an exemption.
  const stripCode = (text: string): string => text.replace(/`+[^`]*`+/g, "");

  const finish = () => {
    const runs = block.flatMap(([n, text]) => (stripCode(text).match(/\*\*/g) ?? []).map(() => n));
    if (runs.length % 2 !== 0) {
      const [openerLine, opener] = block[0]!;
      unclosed.push(
        `line ${runs.at(-1)} (block opens at line ${openerLine}: ${opener.trim().slice(0, 70)})`,
      );
    }
    block = [];
  };

  for (const [i, line] of doc.split("\n").entries()) {
    if (line.startsWith("```")) {
      finish();
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (line.trim() === "") {
      finish();
      continue;
    }
    // A new list item or table row is its own render unit; anything else continues the current one.
    if (/^\s*(?:[-*+]|\d+\.)\s/.test(line) || line.trimStart().startsWith("|")) finish();
    block.push([i + 1, line]);
  }
  finish();
  return unclosed;
}

// Every measurement document, not just the one the defect happened in. docs/cost.md and
// docs/sprint-246.md are the same kind of writing — bold lead-ins on nearly every paragraph, tables
// whose emphasis lands on whichever figure moved — so they fail the same way, and both were written
// after this check existed. sprint-246.md is most of the prose docs/cost.md used to carry, so leaving
// it out of the loop would have quietly dropped ~250 already-covered lines out of coverage on the
// commit that moved them.
//
// `docs/design-notes.md`, `docs/ci.md`, `docs/verifier-calibration.md` and `docs/github-auth.md` are
// in the loop for the same reason sprint-246.md is: they are ~1,950 lines lifted out of README.md,
// written in exactly this style, and a move is the commit where a `**` run gets cut in half.
//
// One list, read off the directory, for every markdown check in this file. Three things went wrong
// with the hand-written version and each is fixed by the same line:
//   - The bold-run and table-swallow checks kept a COPY of it each, so a document added to one and
//     not the other was covered by half the guard while reading as covered by both.
//   - The link check three functions down enumerated `docs/` with readdirSync while these two named
//     files, so the two halves of this file disagreed about what "the docs" meant — and a new
//     `docs/*.md` was auto-covered by one and silently uncovered by the others.
//   - `docs/API.md` (1,897 lines, bold lead-ins and tables throughout) and CONTRIBUTING.md were
//     outside BOTH checks for no stated reason. They pass, so nothing was holding them out.
// A document is now covered by being a document, which is the only rule that cannot go stale.
const PROSE_DOCS = [
  "README.md",
  "CONTRIBUTING.md",
  ...readdirSync(join(ROOT, "docs"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/${f}`),
];

test("the measurement docs' bold runs close in the block that opens them", () => {
  for (const file of PROSE_DOCS) {
    const unclosed = unclosedBoldRuns(readFileSync(join(ROOT, file), "utf8"));
    assert.deepEqual(
      unclosed,
      [],
      `${file} has ${unclosed.length} block(s) with an odd number of \`**\` runs, so a bold ` +
        `run opens and never closes and the asterisks render literally. Each entry names the line ` +
        `carrying the run that is left open — a paragraph, one list item or one table row:\n  ` +
        `${unclosed.join("\n  ")}`,
    );
  }
});

// A GFM table ends at a blank line or at the start of another block-level structure. A plain paragraph
// line is NEITHER, so a paragraph placed directly under a table is swallowed as table rows — one row
// per wrapped line, each cell announced under the table's own column headers, with any `**` run split
// across two rows and rendering as literal asterisks.
//
// This is here because it happened, and because every other gate was green while it was broken. Round 1
// of PR #396 had me mutate docs/cost.md to prove a new assertion could fail; reverting the mutation ate
// the blank line between the price-sheet table and the sentence under it, and tsc, 1511 tests and e2e all
// passed with that document's summary paragraph rendering as five prose rows in a six-column table. The
// `git diff --stat` said so — four insertions against five deletions for a five-line-to-five-line
// paragraph rewrite — and reading the stat rather than the diff is what missed it. A reverted mutation
// needs diffing against the pre-mutation blob, not eyeballing.
//
// Headings, fences, lists, blockquotes and HTML blocks are all block-level starts and end a table
// legitimately, so only a plain paragraph line is a defect. The unit is the source line because that is
// what the renderer consumes; nothing here parses the table.
test("no prose paragraph is swallowed into the table above it", () => {
  for (const file of PROSE_DOCS) {
    const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
    let fenced = false;
    const swallowed: string[] = [];
    for (const [i, line] of lines.entries()) {
      if (line.startsWith("```")) {
        fenced = !fenced;
        continue;
      }
      if (fenced) continue;
      const previous = lines[i - 1];
      if (!previous?.trimStart().startsWith("|")) continue;
      // A block-level start ends the table; anything else is consumed as another row.
      if (line.trim() === "" || /^\s*(?:\||#{1,6}\s|>|```|<|[-*+]\s|\d+\.\s)/.test(line)) continue;
      swallowed.push(`line ${i + 1}: ${line.trim().slice(0, 70)}`);
    }
    assert.deepEqual(
      swallowed,
      [],
      `${file} has ${swallowed.length} line(s) of prose directly under a table row with no blank line ` +
        `between, so GitHub renders them as table rows rather than as a paragraph — each one a cell ` +
        `under the table's column headers, with any bold run split across rows and showing literal ` +
        `asterisks. Insert a blank line before each:\n  ${swallowed.join("\n  ")}`,
    );
  }
});

// docs/sprint-246.md's §3 is the sprint's three-arm page-model comparison, whose rows are an
// ARITHMETIC decomposition rather than a partition: each arm's total is its `verify + correct`
// column plus its `page only` column, and the percentage beside them is the first over the total.
// So the realistic edit — a newer round moves one arm's total and its components are left standing,
// or the reverse — is catchable for free, and it is the edit that has already gone wrong twice in
// this sprint's reporting (#311's four shares summing to 94.6%, and §0 of docs/models.md carrying
// one round's shares while §6 predicted another's).
//
// It lived on docs/cost.md until #395 split that document into a price sheet and this report, which
// is why the section number is unchanged: the table moved file, not position. The per-STEP table that
// replaced it in docs/cost.md is a different shape and has its own check below — the two are not
// interchangeable and neither test covers the other's document.
//
// Deliberately NOT a check that the figures are current or that the round named beside them is the
// one they came from: it passes on any self-consistent set. What it does say is that the table and
// the prose under it cannot drift apart, since the per-page figures the prose quotes are re-derived
// here from the table's own cells rather than pinned as literals.
test("docs/sprint-246.md's cost table decomposes to its own totals, and its prose quotes those totals", () => {
  const doc = readFileSync(join(ROOT, "docs/sprint-246.md"), "utf8");
  const section = doc.split(/^## /m).find((s) => s.startsWith("3."));
  assert.ok(section, "docs/sprint-246.md has no `## 3.` cost section any more");

  const money = (cell: string | undefined) => {
    const m = cell?.replace(/\*\*/g, "").match(/\$([\d,]+\.\d+)/);
    return m ? Number(m[1]!.replace(/,/g, "")) : undefined;
  };
  // Rows naming a backticked model, which is what an arm is. The header and the separator carry no
  // backtick, and no other table in the section does either.
  const arms = section
    .split("\n")
    .filter((l) => /^\| `/.test(l))
    .map((l) =>
      l
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim()),
    );
  assert.ok(arms.length >= 3, `§3's table has ${arms.length} arm rows; expected one per model`);

  for (const row of arms) {
    const [name, total, checked, share, , , pageOnly] = row;
    const [t, c, p] = [money(total), money(checked), money(pageOnly)];
    assert.ok(
      t !== undefined && c !== undefined && p !== undefined,
      `§3's ${name} row is missing one of its three dollar figures: ${row.join(" | ")}`,
    );
    // A cent, since the three are published to four decimals and the round's own totals carry the
    // same rounding.
    assert.ok(
      Math.abs(c! + p! - t!) <= 0.01,
      `docs/sprint-246.md §3 says ${name} cost ${total}, but its own components are ${checked} of ` +
        `checking and correcting plus ${pageOnly} of page calls — $${(c! + p!).toFixed(4)}. One ` +
        `column was updated from a newer round and the others were left standing, and the ` +
        `verify+correct SHARE beside them is read off exactly this decomposition.`,
    );
    const stated = Number(share!.replace(/\*\*/g, "").match(/([\d.]+)%/)?.[1]);
    assert.ok(Number.isFinite(stated), `§3's ${name} row has no verify+correct share: ${share}`);
    assert.ok(
      Math.abs((c! / t!) * 100 - stated) <= 0.5,
      `docs/sprint-246.md §3 says checking and correcting is ${share} of ${name}'s bill; its own cells ` +
        `give ${((c! / t!) * 100).toFixed(1)}% (${checked} of ${total}). That share is the number ` +
        `§5 opens on — "85% of the extraction step is checking and correcting" — so it decides ` +
        `which lever the document sends a reader to.`,
    );
    // And the per-page figure the prose quotes, over the denominator the prose names. The table is
    // per 100 pages SUBMITTED and every cross-arm figure in the document is on that denominator, so
    // a total that moves has to move the prose with it or the two disagree by a factor of a hundred.
    // Scoped to §3, not the whole document: a match anywhere else would let a figure quoted in some
    // other section stand in for the sentence this is here to hold, and the failure message would
    // then be false about where it looked. Prose only — the table row it came from is excluded, or
    // every row would satisfy this against itself.
    const perPage = `$${(t! / 100).toFixed(4)}`;
    const prose = section
      .split("\n")
      .filter((l) => !/^\| /.test(l))
      .join("\n");
    assert.ok(
      prose.includes(perPage),
      `docs/sprint-246.md §3's ${name} row is ${total} per 100 pages submitted, so ${perPage} a page, ` +
        `and no prose in §3 quotes ${perPage}. Either the table moved and the ` +
        `per-page sentence under it did not, or a figure is being quoted on the other ` +
        `denominator — pages that produced a file, which §3 says is not comparable across arms.`,
    );
  }
});

// docs/cost.md is now a price sheet whose entire value is that a reader can take a figure off it
// without excavating: one headline, one per-STEP table, and three prose figures read off that table.
// That is a different shape from the three-arm comparison above — the rows are steps of one round
// rather than arms of three, so they decompose to the headline total instead of to each other — and
// the realistic edit is the one this sprint has already made twice: a newer round moves a row and the
// headline, the block subtotals or a share is left standing.
//
// What makes it worth a check rather than a proofread is that the document deliberately states four
// sets of numbers that are NOT independent of the table: the cents-a-page headline is the total over
// 100, each share is a row over the total, the three block subtotals are groups of rows added, and the
// "checking costs two and a half times producing" claim is three of those shares added. Nothing in a
// markdown file tells a reader which of those went stale.
//
// All four are derived off the rows here, the blocks included. Review round 1 of PR #396 caught that
// this comment claimed the block subtotals were covered when nothing read them — the row filter is
// `/^\| /`, so the prose sentence carrying them was excluded and `$6.4071` → `$6.5071` passed. A
// comment naming what a check catches is itself a claim, and the same round found the sentence the
// row-sum assertion anchors on was about the BLOCKS rather than the rows, so the strictest assertion in
// the test was right by coincidence: the two decompositions are numerically equal today and regrouping
// the blocks would have moved the expected value of a row-sum check. The document now states each
// decomposition in its own sentence and this reads the one it means.
//
// Rounding is asserted rather than tolerated away. The per-step cells are published to four decimals,
// so they sum to $0.0001 less than the round's ledger total and the shares sum to 99.9%; the document
// says both of those out loud, and this reads the sum it states rather than accepting any total within
// a cent — a drifted row would otherwise hide inside the allowance.
test("docs/cost.md's price sheet decomposes to the headline it opens with", () => {
  const doc = readFileSync(join(ROOT, "docs/cost.md"), "utf8");
  const money = (cell: string | undefined) => {
    const m = cell?.replace(/\*\*/g, "").match(/\$([\d,]+\.\d+)/);
    return m ? Number(m[1]!.replace(/,/g, "")) : undefined;
  };

  // Step rows are the table lines whose second cell is a dollar figure; the header and separator
  // carry none. The `failed` row is one of them on purpose — it is billed spend and belongs in the
  // decomposition, which is the error #311 made by excluding it from four numerators.
  const rows = doc
    .split("\n")
    .filter((l) => /^\| /.test(l))
    .map((l) =>
      l
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim()),
    )
    .filter((cells) => money(cells[1]) !== undefined);
  assert.ok(rows.length >= 8, `docs/cost.md's table has ${rows.length} step rows; expected one per step`);

  const total = money(doc.match(/total\s+\*\*(\$[\d,]+\.\d+)\*\*/)?.[1]);
  assert.ok(
    total !== undefined,
    "docs/cost.md's opening paragraph no longer states the round's total as `total **$N**`, so " +
      "nothing below can be checked against it — every share and the cents-a-page headline are that " +
      "total's denominator.",
  );

  const summed = rows.reduce((a, cells) => a + money(cells[1])!, 0);
  // The sentence about the STEPS, not the one about the three blocks. Those two sums are equal today,
  // so anchoring on the wrong one passes and stops meaning anything the moment the blocks are regrouped.
  const stated = money(doc.match(/steps sum to (\$[\d,]+\.\d+)/)?.[1]);
  assert.ok(
    stated !== undefined,
    "docs/cost.md no longer states what its step rows sum to (`… steps sum to $N`). That sentence is " +
      "the one place the table's own arithmetic is written down for a reader, and it has to be the " +
      "sentence about the steps — the block subtotals are a different decomposition of the same rows.",
  );
  assert.equal(
    Number(summed.toFixed(4)),
    stated,
    `docs/cost.md's step rows sum to $${summed.toFixed(4)}, and the prose says they sum to ` +
      `$${stated!.toFixed(4)}. A row moved and the sentence under the table did not.`,
  );
  assert.ok(
    Math.abs(summed - total!) <= 0.01,
    `docs/cost.md's step rows sum to $${summed.toFixed(4)} but the headline total is ` +
      `$${total!.toFixed(4)} — a cent apart at most is per-cell rounding, more than that is a ` +
      `missing or double-counted step.`,
  );

  const statedShares: number[] = [];
  for (const cells of rows) {
    const [name, cost, share] = cells;
    const stated = Number(share!.replace(/\*\*/g, "").match(/([\d.]+)%/)?.[1]);
    assert.ok(Number.isFinite(stated), `docs/cost.md's ${name} row has no share: ${share}`);
    statedShares.push(stated);
    const actual = (money(cost)! / total!) * 100;
    assert.ok(
      Math.abs(actual - stated) <= 0.05,
      `docs/cost.md says ${name} is ${share} of the bill; ${cost} over the headline ` +
        `$${total!.toFixed(4)} is ${actual.toFixed(2)}%. The share column is read off the total the ` +
        `document opens with, so one of the two is from a different round.`,
    );
  }

  // The share column's own total, which the document states because it is 99.9% rather than 100% and
  // says so instead of rounding one cell up to hide it. Every share above is pinned to its own row, so
  // reaching this needs a restated round — and then the column can land on 99.8% with the prose still
  // claiming 99.9%, which is the sentence telling a reader the column is a rounded decomposition and
  // not a partition. Round 2 of PR #396 asked for it.
  const columnSum = statedShares.reduce((a, b) => a + b, 0);
  const statedColumnSum = Number(doc.match(/share column\s+sums to ([\d.]+)%/)?.[1]);
  assert.ok(
    Number.isFinite(statedColumnSum),
    "docs/cost.md no longer states what its share column sums to (`the share column sums to N%`), " +
      "which is the sentence that tells a reader the column is a decomposition rounded rather than a " +
      "partition.",
  );
  assert.ok(
    Math.abs(columnSum - statedColumnSum) <= 0.05,
    `docs/cost.md says the share column sums to ${statedColumnSum}%; its own ${statedShares.length} ` +
      `share cells come to ${columnSum.toFixed(1)}%. Either a share moved or a step was added, and ` +
      `the sentence that explains why the column is not 100% now explains the wrong gap.`,
  );

  // The three block subtotals, which are the sentence a reader quotes when they want one number for
  // "where does the money go" and are the only figures in the document that are a GROUP of rows added.
  // The grouping is the document's own, restated here: a step that appears in no block, or in two,
  // fails rather than being silently dropped from a subtotal — which is exactly how #311 published four
  // shares summing to 94.6%, by leaving each agent's failed spend out of a numerator that kept it in
  // the denominator.
  const BLOCKS: [string, string[]][] = [
    ["producing and checking pages", ["extract", "verify", "correct", "recheck_sampled", "table_join"]],
    ["reviewing and editing the finished document", ["read", "edit"]],
    ["wasted", ["failed"]],
  ];
  const stepName = (cell: string) => cell.replace(/[`*]/g, "").trim();
  const assigned = BLOCKS.flatMap(([, steps]) => steps);
  const tableSteps = rows.map((cells) => stepName(cells[0]!));
  assert.deepEqual(
    [...tableSteps].sort(),
    [...assigned].sort(),
    `docs/cost.md's table and the three block subtotals under it name different steps. The table has ` +
      `${tableSteps.join(", ")}; the blocks account for ${assigned.join(", ")}. A step in no block is ` +
      `spend the "where the money goes" sentence silently omits, and a step in two is spend it ` +
      `double-counts.`,
  );

  const blockFigures = [
    ...(doc.match(/Where the money goes:[\s\S]*?\*\*/)?.[0] ?? "").matchAll(
      /([\d.]+)%\s*\((\$[\d,]+\.\d+)\)/g,
    ),
  ];
  assert.equal(
    blockFigures.length,
    BLOCKS.length,
    `docs/cost.md's "where the money goes" sentence states ${blockFigures.length} percent-and-dollar ` +
      `pairs; the ${BLOCKS.length} blocks below it each need one, or a subtotal is going unchecked.`,
  );

  for (const [i, [label, steps]] of BLOCKS.entries()) {
    const [, statedPct, statedDollars] = blockFigures[i]!;
    const actual = steps.reduce((a, step) => {
      const row = rows.find((cells) => stepName(cells[0]!) === step);
      assert.ok(row, `docs/cost.md's table has no \`${step}\` row, so the "${label}" block is unpriced`);
      return a + money(row![1])!;
    }, 0);
    assert.ok(
      Math.abs(actual - money(statedDollars)!) <= 0.0001,
      `docs/cost.md says "${label}" is ${statedDollars}; its own rows (${steps.join(" + ")}) come to ` +
        `$${actual.toFixed(4)}. This is the sentence a reader quotes for where the money goes, and it ` +
        `is prose rather than a table cell, so nothing else in the repo would notice it going stale.`,
    );
    assert.ok(
      Math.abs((actual / total!) * 100 - Number(statedPct)) <= 0.05,
      `docs/cost.md says "${label}" is ${statedPct}% of the bill; $${actual.toFixed(4)} over the ` +
        `headline $${total!.toFixed(4)} is ${((actual / total!) * 100).toFixed(2)}%.`,
    );
  }

  // The headline a reader quotes, in the unit it is written in.
  const cents = Number(doc.match(/\*\*([\d.]+)¢ a page\.\*\*/)?.[1]);
  assert.ok(Number.isFinite(cents), "docs/cost.md no longer opens with `**N¢ a page.**`");
  assert.equal(
    cents,
    Number(((total! / 100) * 100).toFixed(1)),
    `docs/cost.md opens on ${cents}¢ a page, but its own total $${total!.toFixed(4)} over the 100 ` +
      `pages it names is ${((total! / 100) * 100).toFixed(1)}¢. The headline is the figure everything ` +
      `else in the repo quotes.`,
  );

  // And the one comparison the document draws between its own rows, which is three shares added.
  const claimed = Number(
    doc.match(/`verify`\s*\+\s*`correct`\s*\+\s*`recheck_sampled`\s*is\s*\*\*([\d.]+)%\*\*/)?.[1],
  );
  assert.ok(
    Number.isFinite(claimed),
    "docs/cost.md no longer states the `verify` + `correct` + `recheck_sampled` share, which is the " +
      "claim its 'checking costs more than producing' line rests on.",
  );
  const checking = ["verify", "correct", "recheck_sampled"].map((step) => {
    const row = rows.find((c) => c[0] === `\`${step}\``);
    assert.ok(row, `docs/cost.md's table has no \`${step}\` row, so its ${claimed}% cannot be checked`);
    return money(row![1])!;
  });
  const checkingShare = (checking.reduce((a, b) => a + b, 0) / total!) * 100;
  assert.ok(
    Math.abs(checkingShare - claimed) <= 0.1,
    `docs/cost.md says checking a page is ${claimed}% of the bill; its own \`verify\`, \`correct\` ` +
      `and \`recheck_sampled\` rows come to ${checkingShare.toFixed(2)}%. That figure is the ` +
      `document's headline finding about where the money goes.`,
  );
});

// GitHub's own heading slug, near enough for the links this repo writes: lowercase, drop anything
// that is not a word character, hyphen or space, then spaces to hyphens. Inline code and a link
// inside a heading contribute their text, not their markup.
//
// One hyphen per space, and NOT one per run of spaces: a dropped character between two spaces
// leaves both of them, so `### \`a\` / \`b\`` is `a--b` on GitHub. Collapsing instead would have
// been invisible here — a docs link written to the collapsed slug resolves against a guard that
// collapses too, and dies in the browser. Thirteen headings in these docs are of that shape.
function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    if (fenced) continue;
    const heading = /^#{1,6}\s+(.*?)\s*$/.exec(line);
    if (!heading) continue;
    const text = heading[1].replace(/`/g, "").replace(/\[(.*?)\]\(.*?\)/g, "$1");
    anchors.add(
      text
        .toLowerCase()
        .replace(/[^\w\- ]+/g, "")
        .trim()
        .replace(/ /g, "-"),
    );
  }
  return anchors;
}

// The slug rule itself, pinned on a heading rather than on the docs. The link check below does
// fail on a collapsing rule today — seven of the links in docs/API.md point at headings of this
// shape — but it fails by calling a correct link broken, which reads as the link needing repair.
// It also only fails while some document happens to link to such a heading.
test("a heading slug keeps both spaces around a dropped character", () => {
  const anchors = headingAnchors("### `page_verify_ok` / `page_verify_failed`\n## 9. Close (a / b)\n");
  assert.ok(
    anchors.has("page_verify_ok--page_verify_failed"),
    `got ${[...anchors].join(", ")} — GitHub replaces each space, so the dropped "/" leaves "--"`,
  );
  assert.ok(anchors.has("9-close-a--b"), [...anchors].join(", "));
});

// A cross-reference that does not resolve is the failure mode of moving prose between files, and it
// is silent: GitHub renders a dead relative link as a link, and a dead `#anchor` scrolls nowhere.
// The commit that split ~1,950 lines out of README.md into docs/design-notes.md, docs/ci.md,
// docs/verifier-calibration.md and docs/github-auth.md rewrote 11 pointers and created 18 anchors,
// none of which any other gate reads.
//
// Anchors are checked as well as paths because the paths were the easy half. Two of the pointers
// this replaced were *positional* — "see the end of design notes", "the section above" — which
// cannot break and cannot be checked either; they were turned into anchors precisely so that a
// later move fails here instead of quietly pointing at the wrong paragraph.
test("every relative link in the docs resolves, file and anchor", () => {
  const files = PROSE_DOCS;
  const anchorCache = new Map<string, Set<string>>();
  const anchorsFor = (path: string) => {
    if (!anchorCache.has(path)) anchorCache.set(path, headingAnchors(readFileSync(path, "utf8")));
    return anchorCache.get(path)!;
  };

  const broken: string[] = [];
  let checked = 0;
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const [, target] of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      if (/^(?:https?:|mailto:|#!)/.test(target)) continue;
      const [path, anchor] = target.split("#");
      const abs = path === "" ? join(ROOT, file) : join(ROOT, dirname(file), path);
      checked++;
      if (!existsSync(abs)) {
        broken.push(`${file} -> ${target} (no such file)`);
        continue;
      }
      if (anchor && abs.endsWith(".md") && !anchorsFor(abs).has(anchor)) {
        broken.push(`${file} -> ${target} (file exists, no heading makes that anchor)`);
      }
    }
  }

  // Without this the check passes on a repo whose links it failed to match at all.
  assert.ok(checked > 40, `only ${checked} relative links found across ${files.length} files`);
  assert.deepEqual(
    broken,
    [],
    `${broken.length} relative link(s) in the docs do not resolve. A moved section takes its ` +
      `anchor with it, so repoint the link rather than deleting it:\n  ${broken.join("\n  ")}`,
  );
});

// docs/API.md §7 was one table of 65 rows, and the largest cell in it ran to 9,176 characters — a
// reference nobody could scan and nobody could read. It is now an index of one row per event and a
// section per event, which introduces a way to be wrong that the single table did not have: the two
// halves can disagree. A new event indexed and not written up is a row that scrolls nowhere, and one
// written up and not indexed cannot be found from the top at all. The link check above catches the
// first (a dead anchor) and is blind to the second.
test("every run-log event in docs/API.md is both indexed and written up, once each", () => {
  const lines = readFileSync(join(ROOT, "docs/API.md"), "utf8").split("\n");
  const from = lines.indexOf("## 7. Run log");
  assert.notEqual(from, -1, "docs/API.md has no `## 7. Run log` heading any more");
  const after = lines.findIndex((l, i) => i > from && l.startsWith("## "));
  assert.ok(after > from, "`## 7. Run log` is the last section in the file, which it should not be");
  const body = lines.slice(from, after);

  // A row of the index, and only the index: its first cell is a link and nothing else is.
  const rows = body.filter((l) => l.startsWith("| ["));
  const indexed = rows.map((l) => {
    const m = /^\| \[(.+?)\]\(#([^)]+)\) \| .+ \|$/.exec(l);
    assert.ok(m, `an index row is not \`| [name](#anchor) | summary |\`:\n  ${l}`);
    return { name: m[1], anchor: m[2] };
  });
  assert.ok(indexed.length > 60, `only ${indexed.length} events indexed in §7`);

  const headings = body.filter((l) => l.startsWith("### ")).map((l) => l.slice(4));
  assert.deepEqual(
    indexed.map((e) => e.name),
    headings,
    "§7's index and its sections name different events, or name them in a different order",
  );
  assert.deepEqual(
    indexed.map((e) => e.anchor),
    headings.map((h) => [...headingAnchors(`### ${h}`)][0]),
    "an index row's anchor is not the slug of the section it names",
  );

  // A heading with nothing under it: the shape a half-finished move leaves.
  const empty: string[] = [];
  for (const [i, line] of body.entries()) {
    if (!line.startsWith("### ")) continue;
    let j = i + 1;
    while (j < body.length && !body[j]!.startsWith("### ") && body[j]!.trim() === "") j++;
    if (j >= body.length || body[j]!.startsWith("### ")) empty.push(line.slice(4));
  }
  assert.deepEqual(empty, [], `§7 section(s) with no text under the heading: ${empty.join(", ")}`);
});
