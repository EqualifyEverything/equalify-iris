// The maintainer works on an issue only after an owner labels it `maintainer`. These run the two
// scripts that enforce and announce that against a fake `gh`, and pin the workflow lines that call them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const ROOT = join(import.meta.dirname, "..");
const SCRIPTS = join(ROOT, ".github", "scripts");

const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  "api --paginate") [ -n "\${FAKE_FAIL:-}" ] && exit 1; cat "$FAKE_DIR/events.json" ;;
  "issue view") cat "$FAKE_DIR/issue.json" ;;
  "issue comment") cp "$5" "$FAKE_DIR/posted.md" ;;
  *) echo "fake gh: unexpected $*" >&2; exit 2 ;;
esac
`;

// `owners` swaps in an owners file by running a copy of the script from the temp dir.
function run(script: string, files: Record<string, unknown>, env: Record<string, string> = {}, owners?: string) {
  const dir = mkdtempSync(join(tmpdir(), "owner-gate-"));
  try {
    writeFileSync(join(dir, "gh"), FAKE_GH);
    chmodSync(join(dir, "gh"), 0o755);
    for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(value));
    let path = join(SCRIPTS, script);
    if (owners !== undefined) {
      mkdirSync(join(dir, "scripts"));
      path = join(dir, "scripts", script);
      copyFileSync(join(SCRIPTS, script), path);
      writeFileSync(join(dir, "owners"), owners);
    }
    const r = spawnSync(path, ["7"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_DIR: dir, GITHUB_REPOSITORY: "o/r", ...env },
    });
    const posted = existsSync(join(dir, "posted.md")) ? readFileSync(join(dir, "posted.md"), "utf8") : null;
    return { status: r.status, stdout: r.stdout.trim(), posted };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ev = (event: string, login: string, label = "maintainer") => ({ event, actor: { login }, label: { name: label } });

test("an issue is approved only while an owner's `maintainer` label is on it", () => {
  const approved = (events: unknown[], env?: Record<string, string>) => run("owner-approved.sh", { "events.json": events }, env);
  assert.deepEqual(approved([ev("labeled", "bbertucc")]), { status: 0, stdout: "bbertucc", posted: null });
  assert.equal(approved([ev("labeled", "someone-else")]).status, 1, "not an owner");
  assert.equal(approved([ev("labeled", "bbertucc"), ev("unlabeled", "bbertucc")]).status, 1, "removed again");
  assert.equal(approved([ev("labeled", "bbertucc", "bug")]).status, 1, "another label");
  assert.equal(approved([ev("labeled", "someone-else"), ev("unlabeled", "x"), ev("labeled", "bbertucc")]).status, 0);
  assert.equal(approved([ev("labeled", "bbertucc"), ev("labeled", "someone-else")]).status, 1, "the last label event decides");
  assert.equal(approved([]).status, 1);
  assert.equal(approved([ev("labeled", "bbertucc")], { FAKE_FAIL: "1" }).status, 1, "fails closed");
});

test("triage tags the owners once on an open issue no owner has approved", () => {
  const ask = (issue: unknown) => run("ask-owners.sh", { "issue.json": issue });
  const open = { state: "OPEN", labels: [], comments: [] };
  const first = ask(open);
  assert.equal(first.status, 0);
  assert.match(first.posted ?? "", /^@bbertucc: .*`maintainer` label/);
  assert.match(first.posted ?? "", /<!-- iris-ask-owners:v1 -->/);
  assert.equal(ask({ ...open, state: "CLOSED" }).posted, null);
  for (const name of ["maintainer", "duplicate", "wontfix", "invalid", "question", "no-auto-pr"]) {
    assert.equal(ask({ ...open, labels: [{ name }] }).posted, null, name);
  }
  assert.equal(ask({ ...open, labels: [{ name: "bug" }] }).posted !== null, true);
  assert.equal(ask({ ...open, comments: [{ body: first.posted }] }).posted, null, "already asked");
  const none = run("ask-owners.sh", { "issue.json": open }, {}, "# no one\n\n");
  assert.deepEqual([none.status, none.posted], [0, null], "no owners to ask");
  assert.match(run("ask-owners.sh", { "issue.json": open }, {}, "# x\na\n  \nb\n").posted ?? "", /^@a @b: /);
});

test("issue-to-pr keeps only approved issues, and triage asks once triage succeeds", () => {
  const itp = parse(readFileSync(join(ROOT, ".github", "workflows", "issue-to-pr.yml"), "utf8"));
  const pick: string = itp.jobs.propose.steps.find((s: { id?: string }) => s.id === "triage").run;
  const built = pick.lastIndexOf("> /tmp/candidates.json");
  const label = pick.indexOf('select(any(.labels[]; .name == "maintainer"))');
  const gate = pick.indexOf(".github/scripts/owner-approved.sh");
  const counted = pick.indexOf("COUNT=$(jq length /tmp/candidates.json)");
  assert.ok(built < label && label < gate, "the current label is checked first, after both paths build the candidates");
  assert.ok(gate < counted, "before they are counted");
  assert.match(readFileSync(join(ROOT, ".github", "workflows", "issue-to-pr.yml"), "utf8"), /FORBIDDEN='[^']*\\\.github\/owners/);
  const skip = pick.match(/SKIP_LABELS="([^"]*)"/)![1]!.split(" ");
  const asks = readFileSync(join(SCRIPTS, "ask-owners.sh"), "utf8");
  for (const name of skip) assert.ok(asks.includes(`"${name}"`), `ask-owners skips ${name} too`);

  const triage = parse(readFileSync(join(ROOT, ".github", "workflows", "issue-triage.yml"), "utf8"));
  const job = triage.jobs["ask-owners"];
  assert.equal(job.needs, "triage");
  assert.match(job.if, /needs\.triage\.result == 'success'/);
  assert.match(job.steps.at(-1).run, /^\.github\/scripts\/ask-owners\.sh /);
});
