import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// The version-drift test builds its members inside array literals, so a throw there hides every
// member after it. `readFileSync` throws on a deleted file, which was the last way out of that
// rule — `null` keeps it a reportable member instead. Only ENOENT: a permission or I/O failure
// is not "the file is gone", and answering it with that message would be a wrong diagnosis.
const readIfPresent = (rel: string): string | null => {
  try {
    return read(rel);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
};

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

  // A member yields either a major to compare or a `problem` saying why it cannot — its file is
  // gone, its line is gone, or the version it states names no major. Nothing here asserts:
  // rewording README.md's requirement must not stop the test before it has looked at
  // CONTRIBUTING.md, and each of the three faults has a different fix, so each says which it is.
  type Member = { label: string; major: number | null; problem: string | null };

  const fromText = (label: string, raw: string): Member => {
    const major = readMajor(raw);
    return { label, major, problem: major === null ? unreadable(raw, label) : null };
  };

  const at = (label: string, rel: string, re: RegExp): Member => {
    const text = readIfPresent(rel);
    if (text === null) return { label, major: null, problem: `${rel} is not in the repo` };
    const found = text.match(re);
    if (!found)
      return { label, major: null, problem: `${label} is no longer written where this test reads it` };
    return fromText(label, found[1]);
  };

  // EVERY `FROM node:` line, not the first. The Dockerfile is single-stage today, but a
  // multi-stage one — `FROM node:24-slim AS build` … `FROM node:22-slim` for the runtime — is
  // exactly the case this member exists to catch, and reading only the first match would call
  // it clean while the stage that ships lost unflagged node:sqlite.
  const dockerfile = readIfPresent("Dockerfile");
  const stages = [...(dockerfile ?? "").matchAll(/^FROM node:(\S+)/gm)];

  // Both workflows run setup-node on .nvmrc, and the Dockerfile's stages are the runtime a
  // deployment actually gets — the one path where a Node below the floor would bite. Above the
  // floor is fine for both: testing or shipping on a newer Node than the package promises is
  // allowed.
  const atLeast: Member[] = [
    at(".nvmrc", ".nvmrc", /^\s*(\S+)/),
    // Labelled by the image itself rather than by position, so a failure names the line to
    // edit even when several stages disagree. A missing Dockerfile, or one that no longer
    // builds on a `node:` image, is one reportable member — not an early exit.
    ...(stages.length > 0
      ? stages.map((m) => fromText(`the Dockerfile's \`node:${m[1]}\``, m[1]))
      : [
          {
            label: "the Dockerfile's base image",
            major: null,
            problem:
              dockerfile === null
                ? "Dockerfile is not in the repo"
                : "the Dockerfile no longer builds on a `node:` image",
          },
        ]),
  ];
  // "Node 24+" IS the floor claim, so here the numbers have to be equal, not merely clear it.
  const exactly: Member[] = [
    at("README.md's install requirement", "README.md", /Requires \*\*Node\.js (\d+)\+\*\*/),
    at("CONTRIBUTING.md's install requirement", "CONTRIBUTING.md", /Requires \*\*Node (\d+)\+\*\*/),
  ];

  // Collected rather than asserted one at a time: `assert` throws at the first failure, so
  // checking these in sequence would hide every member after the first that disagrees. A member
  // that yields no major at all is collected for the same reason and carries its own `problem`,
  // because "the file is gone", "the line is gone" and "the version names no major" have three
  // different fixes — and reporting one must not swallow the rest.
  const members = [...atLeast, ...exactly];
  const wrong = [
    ...members.filter((m) => m.problem !== null).map((m) => m.problem as string),
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
  // Collected for the same reason as the drift test above: asserting per file stops at the
  // first, so a Dockerfile that still passed the flag would say nothing about test/e2e.sh — and
  // a launcher that has been DELETED is reported rather than thrown, because ENOENT out of the
  // loop hides the launchers after it while claiming to have checked them.
  const wrong = LAUNCHERS.flatMap((rel) => {
    const text = readIfPresent(rel);
    if (text === null) return [`${rel} is not in the repo, so this test no longer covers it`];
    if (!text.includes("--experimental-sqlite")) return [];
    return [`${rel} passes --experimental-sqlite, which is a no-op on the Node this repo requires`];
  });
  assert.deepEqual(wrong, [], wrong.join("; "));
});
