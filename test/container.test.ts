import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  const pkg = JSON.parse(read("package.json")) as { version: string };
  for (const rel of ["README.md", "docs/API.md"] as const) {
    for (const shown of read(rel).matchAll(/"version"\s*:\s*"([^"]+)"/g)) {
      assert.equal(
        shown[1],
        pkg.version,
        `${rel} prints version "${shown[1]}" and package.json is at "${pkg.version}"`,
      );
    }
  }
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
