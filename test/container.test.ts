import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// These tests exist because of how the gap they close was found: `src/index.ts` explained, in a
// comment, why the liveness probe sits above the rate limiter — "a container healthcheck runs on
// the same host" — and no container healthcheck existed anywhere in the repo. A comment can
// describe a mechanism that was never built. So the mechanisms are pinned to the reasons given
// for them, in the files an operator deploys.

test("the container has a healthcheck, and it polls the route whose comment names it", () => {
  const dockerfile = read("Dockerfile");
  const compose = read("docker-compose.yml");

  // Both places, because they answer different questions: the Dockerfile's applies to anyone who
  // runs the image, compose's is the reference single-machine deployment's own timings.
  const missing = [
    /^HEALTHCHECK /m.test(dockerfile) ? null : "Dockerfile has no HEALTHCHECK",
    /^\s*healthcheck:/m.test(compose) ? null : "docker-compose.yml has no healthcheck:",
  ].filter((m) => m !== null);
  assert.deepEqual(missing, [], missing.join("; "));

  // The route matters, not just the presence of a probe. `/v1/health` is the only /v1 route
  // mounted above the rate limiter, and that exemption is licensed by this caller.
  for (const [what, text] of [
    ["Dockerfile", dockerfile],
    ["docker-compose.yml", compose],
  ] as const) {
    const probe = text.slice(text.search(/^(HEALTHCHECK |\s*healthcheck:)/m));
    assert.match(
      probe,
      /\/v1\/health/,
      `${what}'s healthcheck does not poll /v1/health, which is the route src/index.ts exempts from the rate limiter for it`,
    );
  }
});

test("the healthcheck's port is the port the shipped config serves", () => {
  // The Dockerfile copies config.example.yaml to config.yaml, so `server.port` there is the port
  // the image listens on. A healthcheck on any other port reports every container unhealthy.
  const port = read("config.example.yaml").match(/^\s*port:\s*(\d+)/m);
  assert.ok(port, "config.example.yaml has no server.port, so nothing here can check the healthcheck against it");

  for (const rel of ["Dockerfile", "docker-compose.yml"] as const) {
    const text = read(rel);
    const probe = text.slice(text.search(/^(HEALTHCHECK |\s*healthcheck:)/m));
    const used = probe.match(/127\.0\.0\.1:(\d+)/);
    assert.ok(used, `${rel}'s healthcheck does not name a port on 127.0.0.1`);
    assert.equal(
      used[1],
      port[1],
      `${rel}'s healthcheck polls port ${used[1]} and config.example.yaml serves ${port[1]}`,
    );
  }
});

test("the image installs from the lockfile and drops root", () => {
  const dockerfile = read("Dockerfile");
  // Instructions only. The comment above the `RUN` line names `npm install` to say why it is not
  // used, and a check that reads the whole file cannot tell that from using it — the same
  // distinction the repo's other doc checks make between a rule and prose about the rule.
  const instructions = dockerfile
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

  // `npm ci` is what makes a version number mean something: it installs exactly what
  // package-lock.json pins and fails if the lockfile disagrees with package.json.
  assert.doesNotMatch(
    instructions,
    /npm install\b/,
    "the Dockerfile runs `npm install`, which resolves versions afresh; `npm ci` installs what package-lock.json pins",
  );
  assert.match(instructions, /npm ci\b/, "the Dockerfile does not run `npm ci`");

  // `npm ci` requires the lockfile, so it cannot be copied in as optional.
  assert.doesNotMatch(
    instructions,
    /COPY .*package-lock\.json\*/,
    "package-lock.json is copied as an optional glob, and `npm ci` fails without it",
  );

  assert.match(instructions, /^USER\s+\S+/m, "the Dockerfile sets no USER, so the service runs as root");
  const user = instructions.match(/^USER\s+(\S+)/m);
  assert.notEqual(user?.[1], "root", "the Dockerfile's USER is root, which is what the line is there to avoid");
});

test("the reference deployment comes back up by itself", () => {
  assert.match(
    read("docker-compose.yml"),
    /^\s*restart:\s*\S+/m,
    "docker-compose.yml sets no restart policy, so a crash or a host reboot leaves the deployment down",
  );
});

test("dropping privileges is stated where the bind mounts are declared", () => {
  // The catch, not the flag: compose bind-mounts ./data from the host, and a host directory keeps
  // its host ownership. Running as uid 1000 without that written down is how a working deployment
  // starts failing to write sessions, with the cause invisible from inside the container.
  const compose = read("docker-compose.yml");
  const dataMount = compose.indexOf("./data:/app/data");
  assert.ok(dataMount > 0, "docker-compose.yml no longer bind-mounts ./data, so this test is pinning nothing");

  // The note has to be near the mount it is about, or it is not the thing a reader finds when the
  // upload fails. 25 lines is the volumes block's own span.
  const nearby = compose.split("\n");
  const mountLine = nearby.findIndex((l) => l.includes("./data:/app/data"));
  const window = nearby.slice(Math.max(0, mountLine - 15), mountLine + 5).join("\n");
  assert.match(
    window,
    /uid 1000/,
    "the ./data mount does not say the container runs as uid 1000, which is what an operator needs when the first upload fails with EACCES",
  );
});

test("a fresh clone contains ./data, so the daemon never creates the mount source", () => {
  // The reason this is a test and not just a file: compose bind-mounts `./data`, and when the
  // source does not exist the Docker daemon creates it ROOT-OWNED. The container runs as uid 1000,
  // `src/index.ts` makes sessions/ and tmp/ at import, and the result is EACCES before the port is
  // bound — on Linux, from the exact sequence README's Docker quickstart gives. A tracked file
  // inside `data/` means the clone creates the directory instead, owned by whoever cloned.
  //
  // Reproduced before this was written: a root-owned /app/data with the image's `node` user gives
  // `EACCES: permission denied, mkdir '/app/data/sessions'` and exit 1, with no port ever bound.
  const tracked = execFileSync("git", ["ls-files", "data"], { cwd: ROOT }).toString().trim().split("\n");
  assert.ok(
    tracked.includes("data/.gitkeep"),
    `data/.gitkeep is not tracked (git ls-files data => ${JSON.stringify(tracked)}), so a fresh clone has no ./data and the Docker daemon will create it root-owned`,
  );

  // And the rule that keeps it that way. `data/` alone would exclude the directory, and git does not
  // look inside an excluded directory, so the negation would never be read.
  const ignore = read(".gitignore");
  assert.match(ignore, /^data\/\*$/m, ".gitignore does not use `data/*`, so the `!data/.gitkeep` line below it is unreachable");
  assert.match(ignore, /^!data\/\.gitkeep$/m, ".gitignore does not re-include data/.gitkeep");

  // The point of the mount is that real session data stays out of git. Checked against git itself
  // rather than by re-reading the patterns, because the patterns are what could be wrong.
  const wouldCommit = execFileSync("git", ["check-ignore", "data/iris.sqlite", "data/sessions/x.json", "data/tmp/y"], {
    cwd: ROOT,
  })
    .toString()
    .trim()
    .split("\n");
  assert.equal(wouldCommit.length, 3, `the ./data exception is too wide: ${JSON.stringify(wouldCommit)} of 3 paths are ignored`);
});

test("an unwritable data_dir names its remedy instead of throwing a stack trace", () => {
  // The failure this catches is a loop, not an exit: `restart: unless-stopped` restarts a container
  // that died at import, so this message is the entire diagnostic an operator gets, repeating. An
  // uncaught failure names a path inside a container whose ownership they cannot see from outside.
  const index = read("src/index.ts");
  // Both ends asserted before slicing, not just the start. A missing end marker makes `indexOf`
  // return -1, and `slice(start, -1)` is everything to the last character of the file — so every
  // assertion below would match something further down src/index.ts and the test would pass while
  // pinning nothing. That is the vacuous pass, and it is worse than a failure.
  const from = index.indexOf("const openStorage");
  const to = index.indexOf("= openStorage()");
  assert.ok(from >= 0, "src/index.ts no longer defines openStorage(), so this test is pinning nothing");
  assert.ok(to > from, "src/index.ts no longer calls openStorage() after defining it, so the slice below would run past the guard");
  const guarded = index.slice(from, to);
  assert.match(guarded, /try\s*\{/, "the startup storage setup is unguarded, so an unwritable ./data exits with a stack trace");
  assert.match(guarded, /chown/, "the startup guard does not print the chown that fixes it");
  assert.match(
    guarded,
    /process\.exit\(1\)/,
    "the startup guard does not exit non-zero, so a broken deployment would carry on to bind a port it cannot serve from",
  );

  // The database is inside the guard, not after it, and that is the whole point rather than a
  // detail: `mkdirSync(p, { recursive: true })` succeeds on an existing directory the process
  // cannot write, so the directory checks alone pass on a ./data that already holds sessions/ and
  // tmp/ — and node:sqlite then fails with ERR_SQLITE_ERROR carrying no errno, path or uid.
  assert.match(
    guarded,
    /new Store\(/,
    "opening the database is outside the guard, so an unwritable ./data that already has sessions/ and tmp/ dies one line later with an ERR_SQLITE_ERROR that names nothing",
  );

  // And the first WRITE is inside it too, which is a separate property from opening the database:
  // SQLite OPENS a database it cannot write without complaint and raises only when something
  // writes. So `new Store(` inside the guard is not enough on its own — a root-owned iris.sqlite
  // under a container that drops root gets past every check above and then throws
  // `attempt to write a readonly database` from the first write, with no errno, path or uid.
  //
  // Asserted against the whole file as well as the slice, because moving the call back out is the
  // regression: it was outside for months, it cost the UIC deployment eight rolled-back deploys,
  // and nothing about a passing suite or a working dev box shows it.
  assert.match(
    guarded,
    /failStaleSessions\(\)/,
    "the first database WRITE is outside the guard, so an unwritable iris.sqlite dies with a bare ERR_SQLITE_ERROR and the chown below never prints",
  );
  assert.equal(
    index.split("failStaleSessions()").length - 1,
    1,
    "src/index.ts calls failStaleSessions() more than once, so one of them may sit outside the storage guard",
  );

  // Which is why the remedy is chosen by probing writability rather than by reading `err.code`:
  // the error that most needs this message is the one that cannot identify itself.
  assert.match(
    guarded,
    /accessSync|writable\(/,
    "the guard picks its message off the error code, but the SQLite failure carries no code to read",
  );

  // The database FILE, not just the two directories. Both directories can be writable while
  // iris.sqlite is not, and that case used to reach a branch printing "this is not an ownership
  // problem" — a positive claim, and the wrong one, sending the operator away from the cause.
  assert.match(
    guarded,
    /cfg\.storage\.database/,
    "the writability probe does not include storage.database, so an unwritable iris.sqlite under writable directories reports the wrong cause",
  );
  assert.doesNotMatch(
    guarded,
    /is not an ownership problem/,
    "the guard still claims what the cause is NOT, which it cannot know; it should say what it checked",
  );

  // An absent directory must be probed at its nearest existing ancestor, not skipped. Skipping it
  // dropped the commonest ownership failure after a mistyped path — a data_dir that cannot be
  // CREATED because its parent is unwritable — into the branch that says it cannot explain the
  // failure, and printed an empty list of paths while saying so.
  assert.match(
    guarded,
    /want: cfg\.storage\.data_dir/,
    "storage.data_dir is not among the probed candidates, so the commonest ownership failure reports no cause at all",
  );
  assert.match(
    guarded,
    /nearestExisting\(c\.want\)/,
    "the candidates are not probed at their nearest existing ancestor, so a data_dir that cannot be created answers ENOENT instead of naming the parent",
  );

  // The database file is the one candidate right to drop while absent, since creating it writes
  // into its directory. Stated as: every `existsSync` in the guard is that one call. A regex
  // forbidding one spelling of the group filter (`.filter((p) => existsSync(p))`) would pass
  // against `.filter(existsSync)`, against `existsSync(p) === true`, and against the same
  // predicate rewrapped across two lines — all of them the defect it was written for.
  const existsUses = guarded.match(/existsSync\b[^)]*\)?/g) ?? [];
  assert.deepEqual(
    existsUses,
    ["existsSync(cfg.storage.database)"],
    `existsSync is used in the guard for something other than the database file (${JSON.stringify(existsUses)}); applied to the directories it drops the ones that cannot be created`,
  );

  // The remedy has to name the path that was just diagnosed. A hardcoded `chown -R … ./data` was
  // wrong twice over once absent directories started being reported through an ancestor: outside a
  // container the configured path can be anywhere, and the operator was sent to chown a relative
  // path that may not exist — so the command succeeds, changes nothing, and looks like the fix.
  assert.match(
    guarded,
    /chown[^\n]*c\.want/,
    "the printed chown does not name the path the guard diagnosed, so the operator is told to fix a path this run never checked",
  );
  // And that the command built from it is the command printed. Asserting only that the string is
  // BUILT leaves the version that builds it, ignores it, and prints a hardcoded path — which is
  // the defect, and it passed the check above while the unused variable sat right next to it.
  assert.match(
    guarded,
    /console\.error\([^;]*\$\{remedy\}/,
    "the guard computes a remedy naming the diagnosed path and prints something else",
  );

  // Every command printed names the diagnosed path, and no other. An earlier round branched on
  // `/.dockerenv` to print `chown … ./data` instead, and that decides from a marker what only a
  // lookup could answer: a `database` inside the image is a container whose path is NOT the host's,
  // and a containerd pod writes no marker at all and is one whose path is. The message now names
  // the condition — "in Docker, that path is the one inside the container" — which holds either way.
  //
  // Code lines only. The comment above the remedy names `chown -R /var/lib` to say why the remedy
  // is not spelled that way, and a check reading the whole slice cannot tell that from doing it —
  // the same distinction the Dockerfile's `npm install` check makes between a rule and prose about
  // the rule, and it caught this test on its first run.
  const commands = guarded
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join("\n");
  // Read from `chown` onward, not the whole line: the directory remedy is one template holding a
  // `mkdir -p` and a `chown` together, so a line-wide check is satisfied by the mkdir alone — and
  // that admits `mkdir -p c.want && chown -R c.probe`, which is the one shape the comment above the
  // template singles out as worse than the failure being diagnosed.
  for (const line of commands.split("\n").filter((l) => l.includes("sudo chown"))) {
    const args = line.slice(line.indexOf("sudo chown"));
    assert.match(
      args,
      /c\.want/,
      `a printed chown names a path the guard did not diagnose (${line.trim()}); the operator is told to fix a path this run never checked`,
    );
    assert.doesNotMatch(
      args,
      /c\.probe/,
      `a printed chown targets the ancestor that was probed instead of the path configured (${line.trim()}); \`chown -R\` on /var/lib to fix /var/lib/iris/data is a far worse day than the one being diagnosed`,
    );
  }
  assert.match(
    guarded,
    /bind-mounted/,
    "the message does not tell a containerised deployment that the path it names is the container's own, so chowning it there looks like the fix and dies with the container",
  );

  // Two spellings of one directory are one candidate. `resolve` — which config.ts applies to all
  // three storage paths — collapses `.` and `..`, but not a symlink: a `database` reached through a
  // link to `data_dir` is the same directory twice, and it was blamed and remedied twice.
  assert.match(
    guarded,
    /key: canonical\(c\.want\)/,
    "candidates are not keyed by their real path, so one directory reached through a symlink is diagnosed twice with two remedies for it",
  );
  // Read off the function's body, not the file: `realpathSync` stays in the import line when the
  // call is taken out of `canonical`, and a check that matched anywhere in src/index.ts passed a
  // version whose key was the resolved path again. Both ends asserted, for the reason above.
  const defFrom = index.indexOf("const canonical =");
  const defTo = index.indexOf("const openStorage", defFrom);
  assert.ok(defFrom >= 0, "src/index.ts no longer defines canonical(), so the candidate keys are pinned to nothing");
  assert.ok(defTo > defFrom, "canonical() is no longer defined above openStorage(), so the slice below would run past it");
  assert.match(
    index.slice(defFrom, defTo),
    /realpathSync/,
    "canonical() does not resolve symlinks, so its key cannot tell one directory under two names from two directories",
  );

  // The printed alternative has to be a command that works. Compose does not expand `$(id -u)` in
  // a YAML value — it escapes it to `$$(id -u)` and the daemon gets a literal — so telling an
  // operator to use it stacks a second failure onto the one they are already reading.
  assert.doesNotMatch(
    index,
    /user:\s*"\$\(id -u\)/,
    'the guard prints `user: "$(id -u):$(id -g)"`, which compose does not expand; the numbers have to be literal',
  );
});

test("GET /v1/health reports the running build, and package.json is the one place it is written", () => {
  const index = read("src/index.ts");
  const route = index.slice(index.indexOf('app.get("/v1/health"'));
  assert.match(
    route.slice(0, 300),
    /version/,
    "GET /v1/health returns no version, so a deployed container cannot say which build it is",
  );

  // Read, not written: a literal here would be a second copy of the version, and the second copy
  // is the one that goes stale. `test/e2e.sh` checks the served value against package.json.
  assert.match(
    read("src/version.ts"),
    /package\.json/,
    "src/version.ts does not read package.json, so the reported version is a second copy of it",
  );

  const pkg = JSON.parse(read("package.json")) as { version: string };
  assert.match(
    pkg.version,
    /^\d+\.\d+\.\d+/,
    `package.json's version is "${pkg.version}", which is not a version a release can be tagged from`,
  );
});

test("a version printed in the docs is the version this repo is at", () => {
  // README.md and docs/API.md show the probe's reply with a real version number in it, because a
  // reader comparing their own curl output needs something to compare it to. That makes the docs a
  // second copy of the version — the kind that goes stale at the next release with nothing
  // complaining. This is the complaint: bump package.json and these two lines have to move too.
  //
  // Anchored on the probe's own reply rather than on any `"version"` in the file. Some other
  // component's version in some future JSON example — axe-core's, a provider's, a schema's — is not
  // this fact, and a check that read it would fail naming the wrong defect.
  const pkg = JSON.parse(read("package.json")) as { version: string };
  let found = 0;
  for (const rel of ["README.md", "docs/API.md"] as const) {
    for (const shown of read(rel).matchAll(/"service"\s*:\s*"equalify-iris"\s*,\s*"version"\s*:\s*"([^"]+)"/g)) {
      found++;
      assert.equal(shown[1], pkg.version, `${rel} prints version "${shown[1]}" and package.json is at "${pkg.version}"`);
    }
  }
  // Anchoring narrows what matches, so it can also match nothing — at which point the test passes
  // by reading no version at all. Both files show the reply today; if one stops, say so here rather
  // than going quiet.
  assert.equal(found, 2, `expected the health reply in README.md and docs/API.md, found ${found}`);
});

test("the qs override is still the only way to reach a patched qs", () => {
  // package.json cannot hold a comment, so the reason lives here. `overrides.qs` exists because
  // express's own `latest-4` (4.22.2) depends on qs `~6.15.1`, and the two moderate advisories
  // against qs are fixed in 6.16.0 — a version that range cannot reach. The override forces it.
  //
  // The precondition is express being on 4.x. On express 5, qs comes in already patched and this
  // override becomes a pin nobody remembers adding, which is how a forced version outlives its
  // reason and starts holding a dependency back. So: bump express past 4 and this test reddens.
  const pkg = JSON.parse(read("package.json")) as {
    overrides?: Record<string, string>;
    dependencies: Record<string, string>;
  };
  if (!pkg.overrides?.qs) return; // dropped, which is the intended end state
  assert.match(
    pkg.dependencies.express,
    /^[~^]?4\./,
    `overrides.qs forces a qs version because express 4 pins a vulnerable range, but express is now ${pkg.dependencies.express} — check whether the override is still needed and drop it if not`,
  );
});

test("package.json says where this package lives", () => {
  const pkg = JSON.parse(read("package.json")) as { repository?: { url?: string } };
  assert.ok(
    pkg.repository?.url?.includes("EqualifyEverything/equalify-iris"),
    "package.json has no repository field naming this repo, so a published version points nowhere",
  );
});

test("the type definitions are for the runtime this repo supports", () => {
  const pkg = JSON.parse(read("package.json")) as {
    engines: { node: string };
    devDependencies: Record<string, string>;
  };
  const floor = pkg.engines.node.match(/(\d+)/);
  const types = pkg.devDependencies["@types/node"]?.match(/(\d+)/);
  assert.ok(floor && types, "engines.node or @types/node no longer names a major version");
  assert.equal(
    types[1],
    floor[1],
    `@types/node is ${pkg.devDependencies["@types/node"]} and engines.node is ${pkg.engines.node}; the types should describe the only runtime this repo supports`,
  );
});
