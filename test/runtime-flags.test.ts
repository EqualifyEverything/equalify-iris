import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// Node stopped needing a flag to load node:sqlite, so every launcher used to pass one that
// does nothing. These tests exist because the flag's absence is not self-explanatory: it is
// licensed by the version floor, and lowering that floor would make it wrong again.

// Every file that starts the service. Workflow comments are deliberately not in this list:
// naming the flag to explain why it is gone is fine, passing it is not.
const LAUNCHERS = ["package.json", "Dockerfile", "test/e2e.sh"];

// `24`, `v24` and `24.16.0` are all forms setup-node's node-version-file accepts, and
// `Number()` reads only the first as a number. Floating aliases are accepted too — `lts/*` in
// .nvmrc, `node:lts-slim` in a Dockerfile — and name no major at all, so nothing here can
// compare them to the floor. `null` says that, which is more use than a version comparison
// that never happened.
const readMajor = (raw: string): number | null => {
  const found = raw.trim().match(/^v?(\d+)\b/);
  return found ? Number(found[1]) : null;
};

const unreadable = (raw: string, what: string) =>
  `${what} is "${raw.trim()}", which names no major version, so nothing here can check it against engines.node`;

// For the floor itself: there is no other member to report alongside it, and every check below
// is a comparison against it, so an unreadable floor ends the test rather than joining a list.
function majorOf(raw: string, what: string): number {
  const major = readMajor(raw);
  assert.ok(major !== null, unreadable(raw, what));
  return major;
}

test("node:sqlite loads in a process that was given no flag for it", () => {
  // The strongest available form of the claim: this process is the evidence. `npm test`
  // passes no --experimental-sqlite, and NODE_OPTIONS could smuggle one in, so check both
  // before trusting the import above.
  const smuggled = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? "").split(/\s+/)];
  assert.ok(
    !smuggled.some((a) => a.includes("experimental-sqlite")),
    `this process was started with a sqlite flag (${smuggled.join(" ")}), so it cannot show the module needs none`,
  );
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE t (a INTEGER)");
    db.prepare("INSERT INTO t (a) VALUES (?)").run(1);
    // node:sqlite hands back null-prototype rows, so read the column rather than comparing
    // the row object.
    const rows = db.prepare("SELECT a FROM t").all() as { a: number }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].a, 1);
  } finally {
    db.close();
  }
});

test("the version floor that licenses dropping the flag is still 24 or higher", () => {
  const pkg = JSON.parse(read("package.json")) as { engines: { node: string } };
  const floor = majorOf(pkg.engines.node.replace(/^\D+/, ""), "engines.node");
  assert.ok(
    floor >= 24,
    `engines.node is "${pkg.engines.node}". node:sqlite needs no flag from 24 on; below that, the launchers have to pass --experimental-sqlite again`,
  );
});

test("every other place that states the Node version agrees with that floor", () => {
  // The floor is written down in five places and only one of them is authoritative. A
  // runtime BELOW it loses unflagged node:sqlite; the two prose lines are what a reader
  // installs, so for them the floor and the printed number are the same claim.
  //
  // Out of scope, deliberately: the three workflow comments naming "Node 24". They explain
  // why setup-node reads .nvmrc rather than telling anyone which Node to install, so no
  // action depends on their number.
  const pkg = JSON.parse(read("package.json")) as { engines: { node: string } };
  const floor = majorOf(pkg.engines.node.replace(/^\D+/, ""), "engines.node");

  // `raw: null` means the line this member reads is GONE — reworded, renamed or deleted.
  // Nothing here asserts: a member that cannot be read is reported like one that disagrees,
  // because rewording README.md's requirement must not stop the test before it has looked at
  // CONTRIBUTING.md.
  type Member = { label: string; raw: string | null; major: number | null };

  const at = (label: string, rel: string, re: RegExp): Member => {
    const found = read(rel).match(re);
    return { label, raw: found?.[1] ?? null, major: found ? readMajor(found[1]) : null };
  };

  // EVERY `FROM node:` line, not the first. The Dockerfile is single-stage today, but a
  // multi-stage one — `FROM node:24-slim AS build` … `FROM node:22-slim` for the runtime — is
  // exactly the case this member exists to catch, and reading only the first match would call
  // it clean while the stage that ships lost unflagged node:sqlite.
  const stages = [...read("Dockerfile").matchAll(/^FROM node:(\S+)/gm)];

  // Both workflows run setup-node on .nvmrc, and the Dockerfile's stages are the runtime a
  // deployment actually gets — the one path where a Node below the floor would bite. Above the
  // floor is fine for both: testing or shipping on a newer Node than the package promises is
  // allowed.
  const atLeast: Member[] = [
    at(".nvmrc", ".nvmrc", /^\s*(\S+)/),
    // Labelled by the image itself rather than by position, so a failure names the line to
    // edit even when several stages disagree. No `FROM node:` at all is one missing member,
    // not an early exit.
    ...(stages.length > 0
      ? stages.map((m) => ({
          label: `the Dockerfile's \`node:${m[1]}\``,
          raw: m[1],
          major: readMajor(m[1]),
        }))
      : [{ label: "the Dockerfile's base image", raw: null, major: null }]),
  ];
  // "Node 24+" IS the floor claim, so here the numbers have to be equal, not merely clear it.
  const exactly: Member[] = [
    at("README.md's install requirement", "README.md", /Requires \*\*Node\.js (\d+)\+\*\*/),
    at("CONTRIBUTING.md's install requirement", "CONTRIBUTING.md", /Requires \*\*Node (\d+)\+\*\*/),
  ];

  // Collected rather than asserted one at a time: `assert` throws at the first failure, so
  // checking these in sequence would hide every member after the first that disagrees. The two
  // ways a member can fail to produce a number — its line is gone, or the version it states
  // names no major — are collected for the same reason. Each is a different fault with a
  // different fix, and reporting one must not swallow the rest.
  const members = [...atLeast, ...exactly];
  const wrong = [
    ...members
      .filter((m) => m.raw === null)
      .map((m) => `${m.label} is gone, or no longer written where this test reads it`),
    ...members
      .filter((m) => m.raw !== null && m.major === null)
      .map((m) => unreadable(m.raw as string, m.label)),
    ...atLeast
      .filter((m) => m.major !== null && m.major < floor)
      .map((m) => `${m.label} is ${m.major}, below ${floor}`),
    ...exactly
      .filter((m) => m.major !== null && m.major !== floor)
      .map((m) => `${m.label} says ${m.major}, not ${floor}`),
  ];
  assert.deepEqual(wrong, [], `engines.node's floor is ${floor}: ${wrong.join("; ")}`);
});

test("no launcher passes a flag node no longer needs", () => {
  for (const rel of LAUNCHERS) {
    assert.ok(
      !read(rel).includes("--experimental-sqlite"),
      `${rel} passes --experimental-sqlite, which is a no-op on the Node this repo requires`,
    );
  }
});
