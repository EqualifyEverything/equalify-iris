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
  const floor = Number(pkg.engines.node.match(/(\d+)/)?.[1]);
  assert.ok(
    floor >= 24,
    `engines.node is "${pkg.engines.node}". node:sqlite needs no flag from 24 on; below that, the launchers have to pass --experimental-sqlite again`,
  );
  // setup-node in both workflows reads .nvmrc, not engines, so CI's runtime has to clear
  // the same floor. Above it is fine — this asks that CI never test a Node the package
  // does not support.
  const ci = Number(read(".nvmrc").trim());
  assert.ok(ci >= floor, `.nvmrc is ${ci}, below engines.node's floor of ${floor}`);
});

test("no launcher passes a flag node no longer needs", () => {
  for (const rel of LAUNCHERS) {
    assert.ok(
      !read(rel).includes("--experimental-sqlite"),
      `${rel} passes --experimental-sqlite, which is a no-op on the Node this repo requires`,
    );
  }
});
