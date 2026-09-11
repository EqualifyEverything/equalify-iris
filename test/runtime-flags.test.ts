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
// `Number()` reads only the first as a number. `lts/*` is accepted too and names no major at
// all: it floats, so nothing here can compare it to the floor, and saying that is more use
// than reporting a version comparison that never happened.
function majorOf(raw: string, what: string): number {
  const found = raw.trim().match(/^v?(\d+)\b/);
  assert.ok(
    found,
    `${what} is "${raw.trim()}", which names no major version, so nothing here can check it against engines.node`,
  );
  return Number(found[1]);
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

  const at = (label: string, rel: string, re: RegExp) => {
    const found = read(rel).match(re);
    assert.ok(found, `${rel} no longer states a Node version where this test reads one`);
    return { label, major: majorOf(found[1], label) };
  };

  // Both workflows run setup-node on .nvmrc, and the Dockerfile's base image is the runtime
  // a deployment actually gets — the one path where a Node below the floor would bite.
  // Above the floor is fine for both: testing or shipping on a newer Node than the package
  // promises is allowed.
  const atLeast = [
    at(".nvmrc", ".nvmrc", /^\s*(\S+)/),
    at("the Dockerfile's base image", "Dockerfile", /^FROM node:(\S+)/m),
  ];
  // "Node 24+" IS the floor claim, so here the numbers have to be equal, not merely clear it.
  const exactly = [
    at("README.md's install requirement", "README.md", /Requires \*\*Node\.js (\d+)\+\*\*/),
    at("CONTRIBUTING.md's install requirement", "CONTRIBUTING.md", /Requires \*\*Node (\d+)\+\*\*/),
  ];

  // Collected rather than asserted one at a time: `assert` throws at the first failure, so
  // checking these in sequence would hide every member after the first that disagrees.
  const wrong = [
    ...atLeast.filter((m) => m.major < floor).map((m) => `${m.label} is ${m.major}, below ${floor}`),
    ...exactly.filter((m) => m.major !== floor).map((m) => `${m.label} says ${m.major}, not ${floor}`),
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
