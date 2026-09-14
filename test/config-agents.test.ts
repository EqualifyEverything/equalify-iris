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
  // The RECOMMENDATION table specifically, not the file. Other tables in the document name agents
  // too, so a check against the whole file passes while the one table a reader acts on is missing a
  // row — which is the failure being guarded, and the one an earlier version of this test did not
  // catch when the `builder` row was taken out of the summary.
  const section = doc.split(/^## /m).find((s) => s.startsWith("The suggested config"));
  assert.ok(section, "docs/models.md has no `## The suggested config` section any more");

  // Both directions, because both are the same mistake in the reader's hands. A MISSING row
  // reads as an agent with no cost; an EXTRA one names a `per_agent` key that would be silently
  // ignored, which is the failure the rest of this file exists for — and a recommendation is
  // the most likely place someone copies such a key from. The first backticked name in a row is the
  // agent it is about; the word `specialists` deliberately carries no backticks, since it is a class
  // of agents named at run time and not a key anyone can write.
  const rows = [...section.matchAll(/^\| `([^`]+)`/gm)].map((m) => m[1]!);
  assert.deepEqual(
    [...rows].sort(),
    [...declaredAgents()].sort(),
    "docs/models.md's suggested-config table and DISPATCHED_AGENTS disagree — a missing row " +
      "leaves a reader unable to tell whether that agent was measured, left alone deliberately " +
      "or forgotten, and an extra one recommends a per_agent key Iris would silently ignore",
  );
});

// The two arithmetic checks that used to sit here are gone with the tables they read. docs/models.md
// carried two share partitions — one per agent for the unswapped round, one for the post-swap round —
// and #466 cut both: the document is now which model to run and what it was measured at, and the
// share partition lives in docs/cost.md, where the check below reads it. Deleting a check with the
// table it guards is the honest move; keeping it pointed at a heading that no longer exists is how a
// test starts asserting that a document has a section rather than that its numbers add up.
//
// The suggested-config table is the summary, and a paragraph per agent restates it. That restatement
// is the document's most
// frequent defect: five of the false statements PR #327 removed were a claim corrected in one place
// and left standing in another, and #327 itself merged with §8 still saying "the revert is the one
// config line" an hour after §5 had been corrected to two. Then #329 flipped `copy_editor` from a
// keep to a recommended swap, which had to be rewritten in four places — the intro, §0, §4 and §8 —
// and nothing in the repo could have told anyone if one had been missed.
//
// So this pins the join on the DISPOSITION — keep / declined / recommended / applied, which is the
// thing a reader acts on. #466 cut the share column the check also used to compare; that partition now
// lives in docs/cost.md and is checked there, and re-quoting a share in two places is the drift this
// document no longer has room for.
//
// Deliberately not a check that the disposition is correct — no test can say whether "keep" is the
// right call. This says only that the document gives one answer rather than two. That is the whole of
// the defect it is written for: at no point was either copy of a drifted claim unverifiable, and at
// every point both were present.
//
// Openers only, not every mention, so a paragraph that discusses a disposition it is not about cannot
// fail the check.
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

test("docs/models.md's paragraphs agree with its table about each agent's disposition", () => {
  const doc = readFileSync(join(ROOT, "docs/models.md"), "utf8");
  const summary = doc.split(/^## /m).find((s) => s.startsWith("The suggested config"));
  assert.ok(summary, "docs/models.md has no `## The suggested config` section any more");

  // agent -> status cell, from the rows the test above already treats as the claim. The status is the
  // LAST cell of the row, so a column inserted before it does not silently read as the disposition.
  const stated = new Map<string, string>();
  for (const m of summary.matchAll(/^\| `([^`]+)`[^|]*\|(.*)\|\s*$/gm)) {
    const cells = m[2]!.split("|");
    stated.set(m[1]!, cells[cells.length - 1]!);
  }
  assert.ok(stated.size >= 4, `the table yielded ${stated.size} agent rows; expected one per agent`);

  // A paragraph's opener: a bolded lead-in naming a backticked agent, then its disposition after a
  // dash. One paragraph per decided agent, which is the whole of the restatement.
  const openers = new Map<string, string>();
  for (const m of doc.matchAll(/^\*\*`([a-z_]+)`\s+—\s*([^*]+)\*\*/gm)) {
    openers.set(m[1]!, m[2]!);
  }

  for (const name of DECIDED) {
    const status = stated.get(name);
    assert.ok(status, `\`${name}\` has a model decision on it but no row in the suggested-config table`);
    const text = openers.get(name);
    assert.ok(
      text,
      `no paragraph of docs/models.md opens with \`**\`${name}\` — disposition**\`, so its ` +
        `disposition is stated only in the table and nothing checks the prose a reader is sent to.`,
    );
    // Both sides must classify, exactly once. Neither a null nor a tie here is a pass — see the two
    // notes above the vocabulary.
    const wants = dispositions(status);
    const gots = dispositions(text);
    const want = wants[0] ?? null;
    const got = gots[0] ?? null;
    const vocabulary = DISPOSITIONS.map(([d]) => d).join(", ");
    for (const [side, matches, quoted] of [
      ["the suggested-config table cell", wants, status],
      ["its own paragraph's opener", gots, text],
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
      `the \`${name}\` row no longer states a disposition this test can read (${vocabulary}): ` +
        `"${status.trim().slice(0, 80)}". That table is where a reader takes the decision from, so ` +
        `either say which of those it is, or add the new phrasing to DISPOSITIONS deliberately.`,
    );
    assert.ok(
      got,
      `\`${name}\`'s own paragraph opens without a disposition this test can read (${vocabulary}): ` +
        `"${text.trim().slice(0, 80)}". Skipping this pair is how the check disabled itself.`,
    );
    assert.equal(
      got,
      want,
      `the table says \`${name}\` is "${want}" and its own paragraph says "${got}". This is the ` +
        `sentence a ` +
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
// bounds are genuine ordered markers. A document added to the loop below owes the same audit on its own
// bytes rather than inheriting the answer from the file it was split out of. Count occurrences with
// `grep -o … | wc -l`, not `grep -c`, which counts matching LINES — this comment once recorded 15 as
// "12" for exactly that reason.
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
  // finds, which can swallow a real `**` in between. One document had exactly that (a `git worktree
  // list` span split across two lines), and the run it swallowed was the one this check exists to
  // catch, so adding the strip turned a masked defect into a false positive on the same line. It is
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

// Every measurement document, not just the one the defect happened in. They are all the same kind of
// writing — bold lead-ins on nearly every paragraph, tables whose emphasis lands on whichever figure
// moved — so they fail the same way. `docs/design-notes.md`, `docs/ci.md`,
// `docs/verifier-calibration.md` and `docs/github-auth.md` are in the loop because they are ~1,950
// lines lifted out of README.md, written in exactly this style, and a move is the commit where a `**`
// run gets cut in half.
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

// The three-arm page-model comparison that used to be checked here went with docs/sprint-246.md,
// deleted in #466: it was a 454-line sprint narrative whose own opening line sent a reader wanting the
// price to docs/cost.md, and #370 is that sprint's permanent report. Its transferable half — what a
// benchmark here gets wrong — moved to docs/models.md, and the figures it stated differently from #370
// were posted there. Nothing is left to check, so the check is gone rather than repointed.
//
// docs/cost.md is a price sheet whose entire value is that a reader can take a figure off it without
// excavating: one headline, one per-STEP table, and the prose figures read off that table. The
// realistic edit is the one this sprint has already made twice — a newer round moves a row and the
// headline, a block subtotal or a share is left standing.
//
// What makes it worth a check rather than a proofread is that the document deliberately states four
// sets of numbers that are NOT independent of the table: the cents-a-page headline is the total over
// 100, each share is a row over the total, the two block subtotals are groups of rows added, and the
// "checking costs 4.7x producing" claim is one row over another. Nothing in a markdown file tells a
// reader which of those went stale.
//
// Review round 1 of PR #396 caught that an earlier version of this comment claimed the block subtotals
// were covered when nothing read them, and the same round found the sentence the row-sum assertion
// anchored on was about the BLOCKS rather than the rows — so the strictest assertion in the test was
// right by coincidence. The document now states each decomposition in its own sentence and this reads
// the one it means.
//
// The cost column is found by its HEADER, not by position. #466 added an `agent` column between the
// step and its cost, and the old index-based filter read every row as having no money in it and passed
// by finding zero rows — the assertion on row count is what caught that, and reading the header is what
// stops it recurring.
//
// Rounding is asserted rather than tolerated away. The per-step cells are published to four decimals,
// so the share column sums to 100.1% rather than 100%; the document says so out loud, and this reads
// the sum it states rather than accepting any total within a point.
test("docs/cost.md's price sheet decomposes to the headline it opens with", () => {
  const doc = readFileSync(join(ROOT, "docs/cost.md"), "utf8");
  const money = (cell: string | undefined) => {
    const m = cell?.replace(/\*\*/g, "").match(/\$([\d,]+\.\d+)/);
    return m ? Number(m[1]!.replace(/,/g, "")) : undefined;
  };

  const tableLines = doc
    .split("\n")
    .filter((l) => /^\| /.test(l))
    .map((l) =>
      l
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim()),
    );
  const header = tableLines.find((cells) => cells.includes("step") && cells.includes("cost"));
  assert.ok(
    header,
    "docs/cost.md has no table with `step` and `cost` columns, so nothing below can be located by " +
      "header. The price sheet's whole job is that a reader can take a figure off one table.",
  );
  const iStep = header.indexOf("step");
  const iCost = header.indexOf("cost");
  const iShare = header.indexOf("share");
  assert.ok(iShare >= 0, "docs/cost.md's price table has no `share` column any more");

  const rows = tableLines.filter((cells) => money(cells[iCost]) !== undefined);
  assert.ok(rows.length >= 7, `docs/cost.md's table has ${rows.length} step rows; expected one per step`);

  const total = money(doc.match(/total\s+\*\*(\$[\d,]+\.\d+)\*\*/)?.[1]);
  assert.ok(
    total !== undefined,
    "docs/cost.md no longer states the round's total as `total **$N**`, so nothing below can be " +
      "checked against it — every share and the cents-a-page headline are that total's denominator.",
  );

  const summed = rows.reduce((a, cells) => a + money(cells[iCost])!, 0);
  // The sentence about the STEPS, not the one about the blocks. Those two sums are equal today, so
  // anchoring on the wrong one passes and stops meaning anything the moment the blocks are regrouped.
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
    const [name, cost, share] = [cells[iStep], cells[iCost], cells[iShare]];
    const one = Number(share!.replace(/\*\*/g, "").match(/([\d.]+)%/)?.[1]);
    assert.ok(Number.isFinite(one), `docs/cost.md's ${name} row has no share: ${share}`);
    statedShares.push(one);
    const actual = (money(cost)! / total!) * 100;
    assert.ok(
      Math.abs(actual - one) <= 0.05,
      `docs/cost.md says ${name} is ${share} of the bill; ${cost} over the headline ` +
        `$${total!.toFixed(4)} is ${actual.toFixed(2)}%. The share column is read off the total the ` +
        `document opens with, so one of the two is from a different round.`,
    );
  }

  // The share column's own total, which the document states because it is not 100% and says so instead
  // of rounding one cell to hide it. Every share above is pinned to its own row, so reaching this needs
  // a restated round — and then the column can land elsewhere with the prose still claiming the old
  // gap, which is the sentence telling a reader the column is a rounded decomposition.
  const columnSum = statedShares.reduce((a, b) => a + b, 0);
  const statedColumnSum = Number(doc.match(/share column sums to ([\d.]+)%/)?.[1]);
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

  // The two block subtotals, which are the sentence a reader quotes when they want one number for
  // "where does the money go" and are the only figures in the document that are a GROUP of rows added.
  // The grouping is the document's own, restated here: a step in no block, or in two, fails rather than
  // being silently dropped from a subtotal — which is exactly how #311 published four shares summing to
  // 94.6%, by leaving each agent's failed spend out of a numerator that kept it in the denominator.
  const BLOCKS: [string, string[]][] = [
    ["producing and checking pages", ["extract", "correct", "verify", "recheck_sampled"]],
    ["reviewing and editing the assembled document", ["read", "edit", "table_join"]],
  ];
  const stepName = (cell: string) => cell.replace(/[`*]/g, "").trim();
  const assigned = BLOCKS.flatMap(([, steps]) => steps);
  const tableSteps = rows.map((cells) => stepName(cells[iStep]!));
  assert.deepEqual(
    [...tableSteps].sort(),
    [...assigned].sort(),
    `docs/cost.md's table and the block subtotals under it name different steps. The table has ` +
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
      const row = rows.find((cells) => stepName(cells[iStep]!) === step);
      assert.ok(row, `docs/cost.md's table has no \`${step}\` row, so the "${label}" block is unpriced`);
      return a + money(row![iCost])!;
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
  assert.ok(Number.isFinite(cents), "docs/cost.md no longer states `**N¢ a page.**`");
  assert.equal(
    cents,
    Number(((total! / 100) * 100).toFixed(1)),
    `docs/cost.md states ${cents}¢ a page, but its own total $${total!.toFixed(4)} over the 100 ` +
      `pages it names is ${((total! / 100) * 100).toFixed(1)}¢. The headline is the figure everything ` +
      `else in the repo quotes.`,
  );

  // And the one comparison the document draws between two of its own rows, which is the finding it
  // leads with: checking a page costs a multiple of producing it. Stated as a ratio rather than as two
  // shares added, because #466's table put `correct` on the page agent and `verify` on the checker, and
  // adding shares across that boundary is what made the earlier version of this claim ambiguous.
  const ratio = Number(
    doc.match(/Checking a page costs ([\d.]+)x what producing it costs/)?.[1],
  );
  assert.ok(
    Number.isFinite(ratio),
    "docs/cost.md no longer states `Checking a page costs Nx what producing it costs`, which is the " +
      "claim its lead finding rests on.",
  );
  const rowCost = (step: string) => {
    const row = rows.find((cells) => stepName(cells[iStep]!) === step);
    assert.ok(row, `docs/cost.md's table has no \`${step}\` row, so its ${ratio}x cannot be checked`);
    return money(row![iCost])!;
  };
  const actualRatio = rowCost("verify") / rowCost("extract");
  assert.ok(
    Math.abs(actualRatio - ratio) <= 0.05,
    `docs/cost.md says checking costs ${ratio}x producing; its own \`verify\` and \`extract\` rows ` +
      `give ${actualRatio.toFixed(2)}x. That figure is the document's headline finding about where ` +
      `the money goes.`,
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

// The other way that helper lies, and the reason it is a Set: two headings that slug the same
// collapse into one entry, so a link to either resolves against the check below while GitHub numbers
// the second `#thing-1` and every link written to `#thing` lands on the first. There are none today
// across the 13 prose docs, which is what makes this cheap to keep.
test("no two headings in one doc slug the same", () => {
  const clashes: string[] = [];
  for (const file of PROSE_DOCS) {
    const counts = new Map<string, number>();
    let fenced = false;
    for (const line of readFileSync(join(ROOT, file), "utf8").split("\n")) {
      if (line.startsWith("```")) fenced = !fenced;
      if (fenced || !/^#{1,6}\s/.test(line)) continue;
      for (const a of headingAnchors(line)) counts.set(a, (counts.get(a) ?? 0) + 1);
    }
    for (const [a, n] of counts) if (n > 1) clashes.push(`${file}: ${n} headings make #${a}`);
  }
  assert.deepEqual(
    clashes,
    [],
    `heading anchor(s) are ambiguous, so a link to them cannot say which section it means:\n  ` +
      clashes.join("\n  "),
  );
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

// docs/API.md's run log was one table of 65 rows, and the largest cell in it ran to 9,176
// characters — a reference nobody could scan and nobody could read. It is now an index of one row per
// event and a section per event, which introduces a way to be wrong that the single table did not
// have: the two halves can disagree. A new event indexed and not written up is a row that scrolls
// nowhere, and one written up and not indexed cannot be found from the top at all. The link check
// above catches the first (a dead anchor) and is blind to the second.
test("every run-log event in docs/API.md is both indexed and written up, once each", () => {
  const lines = readFileSync(join(ROOT, "docs/API.md"), "utf8").split("\n");
  const from = lines.indexOf("## Run log");
  assert.notEqual(from, -1, "docs/API.md has no `## Run log` heading any more");
  const after = lines.findIndex((l, i) => i > from && l.startsWith("## "));
  assert.ok(after > from, "`## Run log` is the last section in the file, which it should not be");
  const body = lines.slice(from, after);

  // The index is everything before the first section, so a table inside a section body is not read
  // as a malformed index row — which is how this would have failed, naming the wrong file.
  const firstSection = body.findIndex((l) => l.startsWith("### "));
  assert.ok(firstSection > 0, "the run log has no `### ` sections, so the restructure was undone");
  const indexed = body.slice(0, firstSection)
    .filter((l) => l.startsWith("|") && l !== "| --- | --- |" && !l.startsWith("| `type`"))
    .map((l) => {
      const m = /^\| \[(.+?)\]\(#([^)]+)\) \| .+ \|$/.exec(l);
      assert.ok(m, `an index row is not \`| [name](#anchor) | summary |\`:\n  ${l}`);
      return { name: m[1]!, anchor: m[2]! };
    });
  assert.ok(indexed.length > 60, `only ${indexed.length} events indexed in the run log`);

  const headings = body.filter((l) => l.startsWith("### ")).map((l) => l.slice(4));
  // "Once each" is not implied by the comparison below: two same-order lists are deepEqual with a
  // repeat in both. It is also the case where the anchors go wrong and nothing else notices —
  // GitHub disambiguates a second `### `page_blank`` to `#page_blank-1`, while `headingAnchors`
  // slugs each heading alone and returns `page_blank` for both, so the second row scrolls to the
  // first section and the link check above is satisfied because `#page_blank` does exist.
  assert.equal(
    new Set(headings).size,
    headings.length,
    "two run-log sections have the same heading; GitHub numbers the second anchor and links break",
  );
  assert.deepEqual(
    indexed.map((e) => e.name),
    headings,
    "the run log's index and its sections name different events, or name them in a different order",
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
  assert.deepEqual(empty, [], `run-log section(s) with no text under the heading: ${empty.join(", ")}`);
});

// The run log now claims to document EVERY event src/ emits, which is the claim this test exists for:
// the sentence that first made it was wrong by 40 events, and a reader who greps a `run_start` line
// would have concluded the log could not carry it. It was replaced by a paragraph that counted the
// gap instead, and the gap has since been closed section by section. So the strong claim is back, and
// this time nothing about it is maintained by hand — the numbers are read back out of that paragraph,
// and the coverage itself is asserted rather than counted. A new event fails here until it is written
// up.
test("docs/API.md's run log documents every event src/ emits, and says so in numbers that are current", () => {
  // THREE emit shapes reach the log, and each is invisible to a grep for the others:
  //   1. `ctx.log.event("name", …)` everywhere in the pipeline — 108 names.
  //   2. `this.onEvent?.("model_call_start", meta)` in src/providers — `model_call_start` and
  //      `model_call`, the two the run log documents best.
  //   3. a RunLog method that skips event() and names its own type. `agentCall` does, on every one of
  //      13 call sites, so `agent_call` is one of the commonest lines in the log while its name
  //      appears nowhere either grep above can reach.
  //
  // The first two are searched across src/, because those calls are made from everywhere. The third
  // is searched in src/store/runlog.ts ALONE, and every literal `type` in that file counts however
  // its object literal is ordered — `{ phase, type: "x" }` is the same event as `{ type: "x", phase }`
  // and a pattern keyed on `this.write({ type:` would see only the second. Scoping it to that file is
  // a claim about the rest of src/, so the claim is checked below rather than assumed.
  const RUNLOG = join(SRC, "store/runlog.ts");
  const emitted = new Set<string>();
  // Where each name is emitted FROM, not just that it is. The run log's coverage paragraph makes its
  // claim about the undocumented events by file rather than by name — three of them are not named for
  // the family they belong to — so the check needs the file, and the same loop already has it.
  const where = new Map<string, Set<string>>();
  const emit = (name: string, file: string) => {
    emitted.add(name);
    if (!where.has(name)) where.set(name, new Set());
    where.get(name)!.add(file.slice(ROOT.length));
  };
  // Shapes 1 and 2 differ only in the name, so the two searches below are nearly the same pattern —
  // and both spell `onEvent(` without the optional chain as well as with it. Nothing writes it that
  // way today, but it is one character from a spelling that IS here.
  //
  // THE TWO ARE DELIBERATELY NOT THE SAME WIDTH, because they fail in opposite directions.
  //
  // EMIT_LITERAL stays wide: it is anchored on a string literal, and a method signature —
  // `onEvent(type: string, data: …): void` in an interface, where today's `TelemetryFn` is a type
  // alias — has none, so nothing that is not a call can reach it. That matters because an event this
  // search misses is an event the coverage claim below is never made over, and it goes missing with no
  // message at all: a receiverless `onEvent?.("new_event")` would leave `undocumented` empty and the
  // suite green while the run log says it documents everything. Silent staleness is the exact failure
  // the `agent_call` history left behind, so this half concedes nothing it does not have to.
  //
  // EMIT_CALL requires a receiver. With no literal to anchor on it cannot tell a call from a
  // signature, and a match on a signature accuses a type-only change of emitting under a name the
  // test cannot read. What that narrowing gives up is a receiverless COMPUTED bridge, and losing that
  // costs a warning rather than a claim — the same one-directional standing as APPENDS above.
  const EMIT_NAMED = String.raw`(?:\.event|onEvent(?:\?\.)?)\(\s*`;
  // The name class is `[^"]`, not `[a-z0-9_]`: a `log.event("foo-bar")` cannot have a run-log section,
  // because every heading there is asserted to be snake_case — so it must fail as undocumented and be
  // renamed, rather than slip past the search and out of the claim.
  const EMIT_LITERAL = new RegExp(EMIT_NAMED + String.raw`"([^"]+)"`, "g");
  const EMIT_CALL = new RegExp(String.raw`\.(?:event|onEvent(?:\?\.)?)\(\s*(?!")([^\s,)][^,)]*)`, "g");
  for (const file of sources(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(EMIT_LITERAL)) emit(m[1]!, file);
  }
  const runlog = readFileSync(RUNLOG, "utf8");
  // `[^"]` for the same reason as EMIT_LITERAL: an off-convention name must fail loudly as
  // undocumented rather than fall out of the search and out of the claim.
  for (const m of runlog.matchAll(/\btype:\s*"([^"]+)"/g)) emit(m[1]!, RUNLOG);

  // What makes one file enough: nothing else in src/ reaches for an append-shaped fs call. If a
  // second file ever writes the log, shape 3 stops being findable where this looks and the count
  // goes quietly stale — the failure `agent_call` already demonstrated once.
  //
  // This cannot be an invariant, and the comment does not claim to be one: an `open`/`write` pair, a
  // spawned process or a stream handed in from elsewhere would all slip past. It is the four spellings
  // a writer would actually reach for, and it fails loudly on a plain mention — one message asking
  // someone to check, against a silently stale count, is the right direction to be wrong in.
  const APPENDS = /appendFileSync\(|appendFile\(|createWriteStream\(|flags?:\s*"a/;
  const appenders = sources(SRC)
    .filter((f) => APPENDS.test(readFileSync(f, "utf8")))
    .map((f) => f.slice(ROOT.length));
  assert.deepEqual(
    appenders,
    ["src/store/runlog.ts"],
    `something outside src/store/runlog.ts opens a file for appending: ${appenders.join(", ")}. If ` +
      "any of them writes the run log, reading shape 3 from runlog.ts alone no longer sees every " +
      "event — widen that search with the writers rather than adjusting the count.",
  );

  // All three shapes above read a LITERAL name, so a call whose first argument is an expression is
  // invisible to every one of them — and the run log now claims to document every event, which a name
  // the grep cannot see would make quietly false. Two such call sites exist and both are the router's
  // telemetry bridge, which forwards names that originate in a literal `this.onEvent?.("…")` in
  // src/providers, so shape 2 still sees all of them.
  //
  // Same standing as APPENDS above, and the same reason: not an invariant (a name built from a literal
  // in a lookup table, or a bridge added inside a class, would each slip past), but the shape a caller
  // would actually write, failing loudly on a third bridge rather than dropping its events from a
  // coverage claim that says it has none.
  //
  // Each entry is file + the argument's own text and carries NO line number, deliberately: an import
  // added to orchestrator.ts moves the bridge a line, and this would then fail an unrelated PR with a
  // message accusing it of emitting under an unreadable name. Dropping to a set of paths would go too
  // far the other way — a THIRD bridge in a file that already has one would vanish into it, and the
  // duplicate entry is what catches that.
  const bridges = sources(SRC)
    .flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return [...text.matchAll(EMIT_CALL)].map((m) => `${file.slice(ROOT.length)} ${m[1]!.trim()}`);
    })
    .sort();
  assert.deepEqual(
    bridges,
    ["src/pipeline/orchestrator.ts type", "src/tools/calibrate.ts type"],
    `an event is emitted under a name this test cannot read: ${bridges.join(", ")}. The run log claims to ` +
      "document every event src/ emits, and a computed name is documented or not without this test " +
      "being able to tell — give the new call site a literal name, or teach the searches above where " +
      "its names come from before the claim goes stale.",
  );

  assert.ok(emitted.size > 90, `only ${emitted.size} event names found in src/ — the grep missed`);
  // Losing shape 3 would SHRINK a count rather than fail anything, which is how `agent_call` went
  // undocumented for as long as it did: an event with no run-log section just stops being counted, while
  // a broken shape-2 pattern fails `ghosts` loudly because `model_call` has one. `agent_call` has a
  // section now, so a broken shape 3 would reach `ghosts` as well — this assertion stays because it
  // says WHICH of the two failures it is, and because the next event added this way will again have
  // no section to be missed from.
  assert.ok(
    emitted.has("agent_call"),
    "`agent_call` is not in the emitted set. Either the shape-3 search above stopped matching " +
      `${RUNLOG}, or that literal \`type\` was renamed — check which, because the first means ` +
      "fixing the search and not the count.",
  );

  const api = readFileSync(join(ROOT, "docs/API.md"), "utf8");
  const lines = api.split("\n");
  const from = lines.indexOf("## Run log");
  // Named, because the alternative is loud but wrong: a renamed heading leaves `from` at -1, the
  // slice below empty, and every event in src/ reported as undocumented.
  assert.notEqual(from, -1, "docs/API.md has no `## Run log` heading any more");
  const after = lines.findIndex((l, i) => i > from && l.startsWith("## "));
  const headings = lines.slice(from, after).filter((l) => l.startsWith("### ")).map((l) => l.slice(4));

  // Every run-log heading is event names and nothing else, which is what makes reading its code spans as
  // event names safe. A heading that also named a field — `### `quality_report` (`score`)` — would
  // have to fail HERE, as a heading this test cannot parse, and not two lines down as an event src/
  // no longer emits. If the run log ever needs such a heading, widen this shape and the extraction
  // together.
  for (const h of headings) {
    assert.match(
      h,
      /^`[a-z0-9_]+`( \/ `[a-z0-9_]+`)*$/,
      `a run-log heading is not event names only: \`### ${h}\`. Every code span in a run-log heading is read ` +
        "below as an event name, so anything else in one is reported as a deleted event.",
    );
  }

  const documented = new Set(
    headings.flatMap((h) => [...h.matchAll(/`([a-z0-9_]+)`/g)].map((m) => m[1]!)),
  );

  // A section for an event nothing emits any more is dead documentation, and reads as current.
  const ghosts = [...documented].filter((n) => !emitted.has(n)).sort();
  assert.deepEqual(ghosts, [], `the run log documents event(s) src/ no longer emits: ${ghosts.join(", ")}`);

  // The whole claim, and the one assertion a new event fails. Everything below it is about the
  // paragraph that states it; this is the property. Kept as a list rather than a count so the failure
  // names what to write up.
  const undocumented = [...emitted].filter((n) => !documented.has(n)).sort();
  assert.deepEqual(
    undocumented,
    [],
    `the run log says it documents every event src/ emits, and these have no section: ${undocumented.join(", ")}. ` +
      "Write them up, or replace that claim with one that is true — a count of the gap is what this " +
      "paragraph used to carry, and it went stale every time the gap moved.",
  );

  // Read the numbers out of THAT paragraph, not out of the file: a check against the whole document
  // would pass on a paragraph that had lost the sentence entirely, since both numbers appear
  // elsewhere in these 4,000 lines.
  //
  // Scoped from that opening to the index table rather than to the next blank line: the coverage
  // prose is two paragraphs, and the second is where the promise about what is checked is made.
  const opens = "**The index is the whole log.**";
  const paraStart = lines.findIndex((l) => l.startsWith(opens));
  assert.ok(paraStart > 0, `the run log no longer opens its coverage paragraph with ${opens}`);
  const paraEnd = lines.findIndex((l, i) => i > paraStart && l.startsWith("| `type`"));
  assert.ok(paraEnd > paraStart, "the run log's coverage prose is no longer followed by the index table");
  const para = lines.slice(paraStart, paraEnd).join(" ").replace(/\s+/g, " ");

  const stated =
    /`src\/` emits \*\*(\d+)\*\* event types and every one of them has a section below — \*\*(\d+)\*\* sections/.exec(
      para,
    );
  assert.ok(
    stated,
    "the run log's coverage paragraph was reworded, so its numbers are no longer checked. Keep the shape " +
      "`emits **N** event types and every one of them has a section below — **N** sections`, or move " +
      "the check with the words.",
  );
  assert.deepEqual(
    stated.slice(1, 3).map(Number),
    [emitted.size, headings.length],
    `the run log says ${stated.slice(1, 3).join("/")} (emitted/sections) and src/ says ` +
      `${[emitted.size, headings.length].join("/")}`,
  );

  // A few sections make a claim about src/ rather than about the log — which file a line comes from,
  // and what can reach that file — and those are checked where they are written. Bodies keyed by
  // every event name in the heading, since a section can cover a pair.
  const sections: { names: string[]; body: string[] }[] = [];
  for (const line of lines.slice(from, after)) {
    if (line.startsWith("### ")) {
      sections.push({ names: [...line.slice(4).matchAll(/`([a-z0-9_]+)`/g)].map((m) => m[1]!), body: [] });
    } else if (sections.length) {
      sections[sections.length - 1]!.body.push(line);
    }
  }
  const bodyOf = (name: string): string => {
    const found = sections.find((s) => s.names.includes(name));
    assert.ok(found, `the run log has no section for \`${name}\`, so the claim below cannot be checked`);
    return found!.body.join(" ").replace(/\s+/g, " ");
  };

  // Three events are named for neither their family nor the file they come from, and each section
  // says which file that is. Read one-directionally, name -> file: these files emit others too.
  const ATTRIBUTED: [string, string][] = [
    ["contribution_failed", "src/pipeline/orchestrator.ts"],
    ["feedback_training_failed", "src/pipeline/orchestrator.ts"],
    ["calibrate_call_failed", "src/pipeline/calibration.ts"],
  ];
  for (const [name, file] of ATTRIBUTED) {
    assert.ok(
      bodyOf(name).includes(`\`${file}\``),
      `the run log's \`${name}\` section no longer names ${file} as where the line comes from`,
    );
    assert.deepEqual([...(where.get(name) ?? [])], [file], `the run log attributes \`${name}\` to ${file}`);
  }

  // "Calibration is a tool — `src/tools/calibrate.ts` — and not a phase of a run", which is what makes
  // the section's "an ordinary run never writes this line" true. A claim about the pipeline rather
  // than about the log, and the one a later change would silently falsify.
  //
  // Both import forms, because a DYNAMIC import is the likeliest way a run reaches this: the module
  // is only wanted on the calibration path, and `await import(...)` inside the branch that wants it
  // is what someone adding it would reach for. A static-only pattern would let exactly that through.
  const IMPORTS_CALIBRATION = /(?:from|import\()\s*"[^"]*\/calibration\.ts"/;
  const importers = sources(SRC)
    .filter((f) => IMPORTS_CALIBRATION.test(readFileSync(f, "utf8")))
    .map((f) => f.slice(ROOT.length));
  assert.deepEqual(
    importers,
    ["src/tools/calibrate.ts"],
    `the run log says an ordinary run never writes \`calibrate_call_failed\` because calibration is a tool. ` +
      `These import it: ${importers.join(", ")}. If a run reaches it now, that sentence is wrong.`,
  );
  assert.ok(
    bodyOf("calibrate_call_failed").includes("`src/tools/calibrate.ts`"),
    "the run log's `calibrate_call_failed` section no longer names the tool that reaches calibration",
  );

  // `agent_update_blocked` is documented as ONE line with two shapes, told apart by a `reason` only
  // the eval-gate one carries. Two emit sites, exactly one naming `reason`, is what makes that rule
  // usable — a third site, or a `reason` on the first, would make the section wrong about how to read
  // a line while every number above stayed right.
  const feedbackSrc = readFileSync(join(SRC, "pipeline/feedback.ts"), "utf8");
  const blocked = [...feedbackSrc.matchAll(/\.event\("agent_update_blocked",\s*\{([^}]*)\}/g)].map((m) => m[1]!);
  assert.equal(
    blocked.length,
    2,
    `the run log documents \`agent_update_blocked\` as two shapes and feedback.ts emits it ${blocked.length} time(s)`,
  );
  assert.deepEqual(
    blocked.map((fields) => /\breason:/.test(fields)),
    [false, true],
    "the run log says the regression-gate shape of `agent_update_blocked` carries no `reason` and the eval-gate " +
      "one carries `reason: \"eval_regression\"`. The two emit sites no longer split that way.",
  );

  // And the units of `failures`, which is the collision the two sections warn about: a count on
  // `regression_gate`, the list behind it on `agent_update_blocked`. One name, two shapes, both lines
  // written for the same blocked update.
  assert.ok(
    /\.event\("regression_gate",[^}]*failures: failures\.length/.test(feedbackSrc),
    "the run log says `regression_gate`'s `failures` is a count; feedback.ts no longer logs `failures.length`",
  );
  assert.ok(
    /failures: gate\.failures/.test(blocked[0]!),
    "the run log says `agent_update_blocked`'s `failures` is the list of strings, not a count; the " +
      "regression-gate emit site no longer passes `gate.failures`",
  );

  // The run log's `agent_trained` section says a run reaches that branch only if something outside the
  // pipeline seeds the session's tmp agents directory: the branch is behind `sessionBuilt`, which
  // `loadAgent` sets from a file existing there, and the one line that writes such a file is inside
  // the branch. Same shape of claim as APPENDS above and the same caveat — these are the write
  // spellings a seeder would reach for, not an invariant.
  const seeders = sources(SRC)
    .filter((f) => /(writeFileSync|writeFile|copyFileSync|renameSync|cpSync)\([^;]*tmpAgentsDir/.test(readFileSync(f, "utf8")))
    .map((f) => f.slice(ROOT.length));
  assert.deepEqual(
    seeders,
    ["src/pipeline/feedback.ts"],
    `the run log says the only line writing into tmp/<id>/agents is the training branch itself. These write ` +
      `there: ${seeders.join(", ")}. If one of them seeds it, \`agent_trained\` is reachable and that ` +
      "paragraph is wrong.",
  );
});
