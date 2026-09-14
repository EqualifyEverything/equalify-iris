import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The reference deployment is a `Dockerfile` and a `docker-compose.yml`, and nothing in the
// suite read either of them for anything but the Node version (test/runtime-flags.test.ts).
// So a comment in `src/index.ts` explained for months why `/v1/health` is registered above
// the rate limiter — "a container healthcheck runs on the same host" — while no healthcheck
// existed anywhere in the repo, and a green suite said nothing about it.
//
// These tests are the missing direction: the code's claims about the container, checked
// against the container. They read the files as text on purpose. Parsing the compose file
// would need a YAML dependency's opinion about a document Docker is the only real reader of,
// and every claim here is about whether a line is present at all.

const ROOT = new URL("../", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, ROOT), "utf8");

// Docker joins a `\`-continued instruction into one before running it. Do the same before
// reading one, so an instruction wrapped over several lines — which the HEALTHCHECK is, and
// which is the readable way to write it — is one line here too.
const joinContinuations = (text: string) => text.replace(/\\\r?\n\s*/g, " ");

test("the healthcheck src/index.ts explains is one the container actually runs", () => {
  const dockerfile = joinContinuations(read("Dockerfile"));
  const healthcheck = dockerfile.match(/^HEALTHCHECK .*$/m);
  assert.ok(
    healthcheck,
    "the Dockerfile declares no HEALTHCHECK, but src/index.ts's /v1/health comment justifies that route's position with one. Add the instruction or stop claiming it",
  );
  // It has to probe the route the comment is about. A HEALTHCHECK on any other endpoint would
  // satisfy the line above while leaving the comment's reasoning — that the probe polls from
  // one address and so would spend a per-address budget on itself — describing nothing.
  assert.match(
    healthcheck[0],
    /\/v1\/health/,
    "the Dockerfile's HEALTHCHECK does not call /v1/health, which is the route src/index.ts's comment says it calls",
  );
  // And from inside the container, which is what makes it the same-host caller the rate
  // limiter is exempted for. A healthcheck aimed at `server.base_url` would come in through
  // whatever is in front of the deployment and be a different caller entirely.
  assert.match(
    healthcheck[0],
    /127\.0\.0\.1|localhost/,
    "the Dockerfile's HEALTHCHECK does not call the loopback address, so it is not the same-host caller /v1/health's rate-limit exemption is written for",
  );
});

test("src/index.ts still says the healthcheck is what that route's position is for", () => {
  // The other direction of the same pin. If the comment is ever rewritten to justify the
  // position some other way, the test above is asserting a mechanism nothing in the code
  // depends on any more, and this failure is where that gets noticed.
  assert.match(
    read("src/index.ts"),
    /container healthcheck/,
    "src/index.ts no longer explains /v1/health's position with a container healthcheck, so the Dockerfile assertion above is pinning something nothing claims",
  );
});

test("the image installs from the lockfile it copies in", () => {
  const dockerfile = read("Dockerfile");
  // `npm install` resolves a fresh tree and may ignore the lockfile that was just copied in,
  // which makes two builds of one commit two different images. `npm ci` fails instead.
  assert.doesNotMatch(
    dockerfile,
    /^RUN npm install\b/m,
    "the Dockerfile runs `npm install`, which can resolve past the lockfile it copied. Use `npm ci`",
  );
  assert.match(dockerfile, /^RUN npm ci\b/m, "the Dockerfile no longer installs with `npm ci`");
  // `npm ci` requires the lockfile, so it cannot be copied by a glob that tolerates its
  // absence: the build would get several layers past the missing file before failing on it.
  assert.match(
    dockerfile,
    /^COPY package\.json package-lock\.json \.\/$/m,
    "the Dockerfile does not copy package-lock.json by name, and `npm ci` needs it to be there",
  );
});

test("the reference compose file comes back up on its own", () => {
  // A single-machine deployment is one nobody is watching. Without a restart policy, a crash
  // or a host reboot leaves the service down until an operator notices — and the healthcheck
  // above only reports that state, it does not repair it.
  assert.match(
    read("docker-compose.yml"),
    /^\s*restart:\s*\S+/m,
    "docker-compose.yml declares no `restart:` policy, so a crashed or rebooted deployment stays down",
  );
});
