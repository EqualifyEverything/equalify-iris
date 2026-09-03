import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgent } from "../src/agents/loader.ts";

// `AgentSpec.sha` is how a run says WHICH prompt produced it (PRD §7.3), and it is written to every
// `agent_call` line as `agent_sha`. It used to be `git -C <agentsDir> rev-parse HEAD:./<file>`, which
// answers null wherever there is no `.git` — and the container Iris is deployed in ships none. So
// every deployed round on file records `agent_sha: null`: four deployed rounds of the same PDF moved
// one defect from 0 pages to 28 of 100, and nothing in their logs can say which prompt each round
// ran (#349). A field that is null exactly where the question gets asked is not a pinned version.
//
// It is now computed from the content, which is the same number by construction — a git blob SHA is
// sha1 over `blob <byte length>\0` and then the bytes — so a maintainer can still take a recorded
// sha to `git show` or to GitHub's contents API and read the prompt back. These tests pin both
// halves of that: the number is git's, and it survives having no checkout.

const PAGE_MD = "# Page Agent\n\n## Required capability\nvision\n";
// `git hash-object --stdin` for exactly those bytes. Hard-coded rather than computed here, so the
// claim is pinned by a value from git and not by this codebase agreeing with itself.
const PAGE_MD_SHA = "c439bce9872d663b4374704261370e2cf088513d";

function withTemp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "iris-agent-sha-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function agentDirs(dir: string): { agentsDir: string; tmpAgentsDir: string } {
  const agentsDir = join(dir, "agents");
  const tmpAgentsDir = join(dir, "tmp-agents");
  mkdirSync(agentsDir, { recursive: true });
  return { agentsDir, tmpAgentsDir };
}

test("a library agent's sha is the git blob SHA of its file", () => {
  withTemp((dir) => {
    const dirs = agentDirs(dir);
    writeFileSync(join(dirs.agentsDir, "page.md"), PAGE_MD);
    const spec = loadAgent("page", dirs);
    assert.ok(spec, "the agent did not load");
    assert.equal(spec.sha, PAGE_MD_SHA);
    // And the same number git itself gives for the file on disk, asked of git rather than of the
    // constant above: the constant pins the algorithm, this pins that the bytes hashed are the ones
    // the file holds. Together they are what makes a recorded sha usable in `git show`.
    const fromGit = execFileSync("git", ["hash-object", join(dirs.agentsDir, "page.md")]).toString().trim();
    assert.equal(spec.sha, fromGit);
  });
});

test("an agent in a directory that is not a checkout still has a sha", () => {
  withTemp((dir) => {
    const dirs = agentDirs(dir);
    writeFileSync(join(dirs.agentsDir, "page.md"), PAGE_MD);
    // The deployed shape, and the whole defect: no `.git` anywhere above this directory, which is
    // the one condition under which the old answer was null — and it was null on 100% of the pages
    // anyone would want to trace.
    const spec = loadAgent("page", dirs);
    assert.ok(spec, "the agent did not load");
    assert.equal(spec.sha, PAGE_MD_SHA);
    assert.equal(spec.sessionBuilt, false);
  });
});

test("a session-built agent has a sha of its own", () => {
  withTemp((dir) => {
    const dirs = agentDirs(dir);
    mkdirSync(dirs.tmpAgentsDir, { recursive: true });
    writeFileSync(join(dirs.agentsDir, "page.md"), PAGE_MD);
    const built = `${PAGE_MD}\n<!-- built for this session -->\n`;
    writeFileSync(join(dirs.tmpAgentsDir, "page.md"), built);

    const spec = loadAgent("page", dirs);
    assert.ok(spec, "the agent did not load");
    assert.equal(spec.content, built, "the session build did not win over the library file");
    assert.equal(spec.sessionBuilt, true);
    // It has no upstream blob and it still has a prompt worth identifying: two rounds of one session
    // can run two builds of the same agent, and grouping their calls needs a key. `sessionBuilt` is
    // what says the blob is not in a checkout; a null here left those rounds indistinguishable.
    assert.notEqual(spec.sha, null);
    assert.equal(
      spec.sha,
      execFileSync("git", ["hash-object", join(dirs.tmpAgentsDir, "page.md")]).toString().trim(),
    );
    assert.notEqual(spec.sha, PAGE_MD_SHA, "the session build was recorded under the library file's sha");
  });
});

test("the sha describes the text that was sent, not the text that was committed", () => {
  withTemp((dir) => {
    const dirs = agentDirs(dir);
    const file = join(dirs.agentsDir, "page.md");
    writeFileSync(file, PAGE_MD);
    // A real checkout, so the old answer was AVAILABLE here — and wrong: `HEAD:./page.md` named the
    // committed blob while the run used the working copy. A round measured against an edited prompt
    // was recorded under the sha of a prompt that did not run, which is the failure that is worst to
    // have, because the sha resolves and reads back as a different contract.
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "add", "agents/page.md"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "add page"], { cwd: dir });
    const committed = execFileSync("git", ["rev-parse", "HEAD:agents/page.md"], { cwd: dir }).toString().trim();
    assert.equal(committed, PAGE_MD_SHA, "the fixture did not commit the bytes this test thinks it did");

    const edited = PAGE_MD.replace("vision", "vision, text");
    writeFileSync(file, edited);
    const spec = loadAgent("page", dirs);
    assert.ok(spec, "the agent did not load");
    assert.notEqual(spec.sha, committed, "an edited prompt was recorded under the committed blob's sha");
    assert.equal(spec.sha, execFileSync("git", ["hash-object", file]).toString().trim());
    // `src/tools/calibrate.ts` recovers a contract with `git cat-file blob <sha>` and already says
    // what it does when the blob is not in this checkout, so an uncommitted prompt now announces
    // itself there instead of being judged against a contract it was never written to.
  });
});

test("one byte of prompt changes the sha, and two files with one prompt share it", () => {
  withTemp((dir) => {
    const dirs = agentDirs(dir);
    writeFileSync(join(dirs.agentsDir, "page.md"), PAGE_MD);
    writeFileSync(join(dirs.agentsDir, "editor.md"), PAGE_MD);
    writeFileSync(join(dirs.agentsDir, "table.md"), `${PAGE_MD} `);

    const page = loadAgent("page", dirs);
    const editor = loadAgent("editor", dirs);
    const table = loadAgent("table", dirs);
    assert.ok(page && editor && table, "an agent did not load");
    // It identifies the PROMPT and not the path, which is what makes it the right key for "did these
    // two rounds run the same instructions": a prompt copied to a second file is the same contract.
    assert.equal(editor.sha, page.sha);
    // And a trailing space is a different contract as far as this field is concerned — the point of
    // the field is that a change cannot be invisible, so it is exact rather than normalised.
    assert.notEqual(table.sha, page.sha);
  });
});
