import express from "express";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  apiToken,
  applyTrustProxy,
  bedrockApiWarning,
  githubToken,
  identityWarning,
  loadConfig,
  perAgentKeyWarning,
  promptCacheTtlWarning,
} from "./config.ts";
import { Store } from "./store/db.ts";
import { makeAuthMiddleware } from "./auth/middleware.ts";
import { meRouter } from "./routes/me.ts";
import { sessionsRouter } from "./routes/sessions.ts";
import { statsRouter } from "./routes/stats.ts";
import { limitsRouter } from "./routes/limits.ts";
import { qualityRouter } from "./routes/quality.ts";
import { visionModelWarning } from "./providers/imageLimits.ts";
import { generalRateLimit } from "./util/requestLimits.ts";
import { VERSION } from "./version.ts";

const cfg = loadConfig();

// Not a mistake, but a deployment-wide policy whose every consequence is invisible from
// outside: this service has ONE GitHub identity, and whether a stranger may spend it
// depends on a second, unrelated key (see identityWarning). Printed at boot because boot
// is the only place both keys are read together.
const idWarning = identityWarning(githubToken(cfg), apiToken(cfg) !== undefined);
if (idWarning) console.warn(`WARNING: ${idWarning}`);

// A cache TTL nobody can spell is worth saying here, because boot is the only place it
// is observable at all — the two TTLs differ in price, not in reported tokens.
const ttlWarning = promptCacheTtlWarning(cfg.providers);
if (ttlWarning) console.warn(`WARNING: ${ttlWarning}`);

// And a Bedrock `api` nobody can spell, for the same reason: the fallback works, so the
// only symptom is that the deployment is on the path it was trying to leave.
const apiWarning = bedrockApiWarning(cfg.providers);
if (apiWarning) console.warn(`WARNING: ${apiWarning}`);

// And an override that names no agent, which is the same failure on the one key that
// decides which model runs: the entry is ignored and the call takes the provider's own
// model. What ran is answerable afterwards — `by_agent.<agent>.models` in diagnostics names
// the model each agent actually used — but the key that was ignored is nameable only from
// here, because nothing downstream of resolution ever sees it.
const agentKeyWarning = perAgentKeyWarning(cfg.providers.per_agent, cfg.storage.agents_dir);
if (agentKeyWarning) console.warn(`WARNING: ${agentKeyWarning}`);

// What that switch made reachable: a vision model this build has no image limits for.
// Everything still runs, on the conservative defaults — but the limits it publishes are
// then a guess, and nothing downstream of here can say so (providers/imageLimits.ts).
const visionWarning = visionModelWarning(cfg);
if (visionWarning) console.warn(`WARNING: ${visionWarning}`);

// Ensure the on-disk layout exists, and open the database.
//
// These are the first things that can fail on an otherwise correctly configured deployment, and
// the way they fail is worth catching: the container runs as uid 1000 and compose bind-mounts
// `./data`, which keeps its HOST ownership, so on Linux a `./data` owned by anyone else fails
// here — at import, before the port is bound. With `restart: unless-stopped` that is a loop, so
// this message is the whole diagnostic an operator gets, and it repeats. Uncaught, they get a
// stack trace naming a path inside a container whose ownership they cannot see from outside.
//
// The store is inside the guard because the layout check alone does not catch the case:
// `mkdirSync(p, { recursive: true })` SUCCEEDS on an existing directory the process cannot
// write, so a `./data` that already holds sessions/ and tmp/ — which is what `npm start` leaves
// behind before a first `docker compose up` — passes it and dies one line later. And it dies
// worse: node:sqlite reports `ERR_SQLITE_ERROR`, "unable to open database file", with no errno,
// no path and no uid (measured). Hence `checkWritable` rather than a look at `err.code`: the
// error that needs this message is the one that cannot identify itself.
const writable = (dir: string) => {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

const openStorage = (): Store => {
  try {
    mkdirSync(join(cfg.storage.data_dir, "sessions"), { recursive: true });
    mkdirSync(join(cfg.storage.data_dir, "tmp"), { recursive: true });
    return new Store(cfg.storage.database);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    console.error(`FATAL: cannot open this deployment's storage (${e.code ?? e.message}).`);
    // Which path is at fault, asked directly. Three candidates, not one: the database may sit
    // outside data_dir, and the database FILE can be unwritable while both directories are fine
    // (a group-writable ./data holding a foreign-owned iris.sqlite). It is only worth asking about
    // once it exists — accessSync on a path that is absent fails for the wrong reason, and this
    // guard also runs on a first boot, when not creating it yet is correct.
    const checked = [...new Set([cfg.storage.data_dir, dirname(cfg.storage.database), cfg.storage.database])].filter(
      (p) => existsSync(p),
    );
    const unwritable = checked.filter((p) => !writable(p));
    if (unwritable.length > 0) {
      const uid = process.getuid?.() ?? 1000;
      const gid = process.getgid?.() ?? 1000;
      console.error(
        `This process runs as uid ${uid} (gid ${gid}) and cannot write ${unwritable.join(" or ")}.\n` +
          `In Docker, ./data is bind-mounted from the host and keeps the host's ownership. Either give it\n` +
          `to uid ${uid}:\n` +
          `  sudo chown -R ${uid}:${gid} ./data\n` +
          `or run the container as the user that owns it: add \`user: "1234:1234"\` to the iris service in\n` +
          `docker-compose.yml, using your own numbers from \`id -u\` and \`id -g\`. They have to be literal —\n` +
          `compose does not expand \`$(id -u)\` in a YAML value.`,
      );
    } else {
      // Says what was checked rather than what the cause is not. "This is not an ownership
      // problem" would be a positive claim this code cannot support — something unreadable, a
      // full disk or a corrupt database all land here — and a wrong one sends the operator away
      // from the cause.
      console.error(`Every path checked is writable by uid ${process.getuid?.() ?? "?"}: ${checked.join(", ")}.`);
      console.error(`So this is not one of the ownership failures this message can explain. The error was:`);
      console.error(e.stack ?? String(err));
    }
    process.exit(1);
  }
};

const store = openStorage();
// Clear sessions orphaned by a previous shutdown (their in-process run is gone).
const stale = store.failStaleSessions();
if (stale > 0) console.log(`Marked ${stale} interrupted session(s) as failed on startup.`);
const app = express();
// Whose address `req.ip` is. Off unless a deployment says how many proxies are in front
// of it, because the rate limits below are only per-caller if this is right: unset behind
// Caddy every caller looks like the proxy, and set too permissively every caller can
// claim to be someone new (see normalizeTrustProxy).
//
// The third startup warning comes from here, for either way this key can be wrong: `true`
// is accepted by Express and defeats every per-address limit, because the address then
// comes from a header the client can write (coerced to one hop), and a value Express cannot
// compile would otherwise be a crash naming no config key (trusted as nothing instead).
const proxyWarning = applyTrustProxy(app, cfg.server.trust_proxy);
if (proxyWarning) console.warn(`WARNING: ${proxyWarning}`);
app.use(express.json({ limit: "2mb" }));

// Liveness probe (unauthenticated) — confirms the service is up and says which build it is.
//
// Registered ABOVE the rate limiter on purpose, and it is the only /v1 route that is: a
// probe that answers 429 reports the deployment as down, which is the opposite of what it
// is for. It also polls from one address (the Dockerfile's HEALTHCHECK runs on the same
// host), so it is precisely the caller a per-address budget would spend itself on.
//
// `version` is package.json's, and it is here rather than only in the boot log because a
// deployed container is read from outside (see version.ts).
app.get("/v1/health", (_req, res) => res.json({ status: "ok", service: "equalify-iris", version: VERSION }));

// How much anyone may ask of this deployment (util/requestLimits.ts). Mounted here —
// above every route below, below the probe above — so a flood is refused before it
// reaches a handler, the store, or multer. The run queue bounds pipeline compute, which
// is a later and narrower question: nothing in it stops a polling loop from occupying
// the event loop with synchronous SQLite reads.
app.use("/v1", generalRateLimit(cfg));

// The public tally of pages converted (aggregate-only, no per-session detail). The browser
// app reads it to report how many pages Iris has made accessible, and it is not handed the
// `auth` middleware below, so it still answers where the operator set `server.api_token` —
// a page count is not something a shared secret should be needed for.
app.use("/v1/stats", statsRouter(store));

// What this deployment accepts for an upload (no user data). Ungated for the same reason as
// the page tally above, plus one of its own: the browser app states the file limits on the
// upload step, and someone deciding whether a scan is small enough should not need the
// deployment's shared token to find out.
app.use("/v1/limits", limitsRouter(cfg));

// The deployment-wide quality tally, read by the weekly quality-report workflow. It carries
// its own guard, `server.quality_token`, and answers 404 until that is set.
//
// It is not handed `auth` either, which is what keeps it answering on a GATED deployment:
// the CI job holds `quality_token` and not `server.api_token` (config.ts's `quality_token`
// argues why they are separate).
app.use("/v1/quality", qualityRouter(store, cfg.server));

// The browser app is the front door, served at the root (unauthenticated; it
// drives the /v1 API itself). no-store so a deploy never serves a stale page.
const demoFile = fileURLToPath(new URL("../public/demo.html", import.meta.url));
app.get("/", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(demoFile);
});
// Keep the old /demo path working for any shared links.
app.get("/demo", (_req, res) => res.redirect(302, "/"));

// Everything else runs as this deployment's GitHub account, and is refused if that
// account cannot be resolved. If `server.api_token` is set, the caller must also present
// it — see auth/middleware.ts, which asks those two questions separately.
//
// `auth` is attached PER ROUTE, on the two mounts below and nowhere else. That, and not its
// position in this file, is what leaves /v1/health, /v1/stats, /v1/limits and /v1/quality
// reachable on a gated deployment: nothing stands in front of them because nothing was put
// there, and moving any of those lines below these two would not change it.
//
// Read top to bottom the order looks load-bearing, and for one middleware it is — the rate
// limiter above is mounted on the whole of `/v1`. So /v1/health being registered above THAT
// is a real decision (see its own comment) and the four mounts sitting above `auth` is not.
const auth = makeAuthMiddleware(store, cfg);
app.use("/v1/me", auth, meRouter(cfg));
app.use("/v1/sessions", auth, sessionsRouter(cfg, store));

const port = cfg.server.port;
app.listen(port, () => {
  console.log(`Equalify Iris listening on http://localhost:${port} (base_url: ${cfg.server.base_url})`);
});
