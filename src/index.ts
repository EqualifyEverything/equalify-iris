import express from "express";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
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

// Ensure the on-disk layout exists.
mkdirSync(join(cfg.storage.data_dir, "sessions"), { recursive: true });
mkdirSync(join(cfg.storage.data_dir, "tmp"), { recursive: true });

const store = new Store(cfg.storage.database);
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

// Liveness probe (unauthenticated) — confirms the service is up.
//
// Registered ABOVE the rate limiter on purpose, and it is the only /v1 route that is: a
// probe that answers 429 reports the deployment as down, which is the opposite of what it
// is for. It also polls from one address (a container healthcheck runs on the same host),
// so it is precisely the caller a per-address budget would spend itself on.
app.get("/v1/health", (_req, res) => res.json({ status: "ok", service: "equalify-iris" }));

// How much anyone may ask of this deployment (util/requestLimits.ts). Mounted here —
// above every route below, below the probe above — so a flood is refused before it
// reaches a handler, the store, or multer. The run queue bounds pipeline compute, which
// is a later and narrower question: nothing in it stops a polling loop from occupying
// the event loop with synchronous SQLite reads.
app.use("/v1", generalRateLimit(cfg));

// The public tally of pages converted (aggregate-only, no per-session detail). The
// browser app reads it to report how many pages Iris has made accessible, and it is
// mounted here, above the auth middleware, so it still answers where the operator set
// `server.api_token` — a page count is not something a shared secret should be needed for.
app.use("/v1/stats", statsRouter(store));

// What this deployment accepts for an upload (no user data). Above the auth middleware
// for the same reason as the tally, plus one of its own: the browser app states the file
// limits on the upload step, and someone deciding whether a scan is small enough should
// not need the deployment's shared token to find out.
app.use("/v1/limits", limitsRouter(cfg));

// The deployment-wide quality tally, read by the weekly
// quality-report workflow. Mounted above the GitHub auth middleware because it
// carries its own guard — a shared secret, since the data belongs to no user and the
// caller is a CI job with no GitHub identity. Answers 404 until
// `server.quality_token` is set.
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
const auth = makeAuthMiddleware(store, cfg);
app.use("/v1/me", auth, meRouter(cfg));
app.use("/v1/sessions", auth, sessionsRouter(cfg, store));

const port = cfg.server.port;
app.listen(port, () => {
  console.log(`Equalify Iris listening on http://localhost:${port} (base_url: ${cfg.server.base_url})`);
});
