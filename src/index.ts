import express from "express";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyTrustProxy,
  bedrockApiWarning,
  bundledAppWarning,
  clientIdWarning,
  loadConfig,
  promptCacheTtlWarning,
} from "./config.ts";
import { Store } from "./store/db.ts";
import { makeAuthMiddleware } from "./auth/middleware.ts";
import { authRouter } from "./routes/auth.ts";
import { meRouter } from "./routes/me.ts";
import { sessionsRouter } from "./routes/sessions.ts";
import { statsRouter } from "./routes/stats.ts";
import { limitsRouter } from "./routes/limits.ts";
import { qualityRouter } from "./routes/quality.ts";
import { visionModelWarning } from "./providers/imageLimits.ts";
import { authRateLimit, generalRateLimit } from "./util/requestLimits.ts";

const cfg = loadConfig();

// The credential check config can do. An OAuth App id here would authenticate users
// and then fail every issue filing, with nothing at boot to say so (see
// clientIdWarning; the unambiguous `Ov…` case is a startup error in validateConfig).
const cidWarning = clientIdWarning(cfg.github.client_id);
if (cidWarning) console.warn(`WARNING: ${cidWarning}`);

// The other one: the bundled app is installed on one repo, so pointing upstream_repo
// elsewhere without registering your own app files nothing for anyone.
const appWarning = bundledAppWarning(cfg.github.client_id, cfg.github.upstream_repo);
if (appWarning) console.warn(`WARNING: ${appWarning}`);

// A cache TTL nobody can spell is worth saying here, because boot is the only place it
// is observable at all — the two TTLs differ in price, not in reported tokens.
const ttlWarning = promptCacheTtlWarning(cfg.providers);
if (ttlWarning) console.warn(`WARNING: ${ttlWarning}`);

// And a Bedrock `api` nobody can spell, for the same reason: the fallback works, so the
// only symptom is that the deployment is on the path it was trying to leave.
const apiWarning = bedrockApiWarning(cfg.providers);
if (apiWarning) console.warn(`WARNING: ${apiWarning}`);

// What that switch made reachable: a vision model this build has no image limits for.
// Everything still runs, on the conservative defaults — but the limits it publishes are
// then a guess, and nothing downstream of here can say so (providers/imageLimits.ts).
const visionWarning = visionModelWarning(cfg);
if (visionWarning) console.warn(`WARNING: ${visionWarning}`);

// Ensure the on-disk layout exists (PRD §8.1).
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

// The public tally of pages converted (unauthenticated, aggregate-only). The
// browser app reads it to report how many pages Iris has made accessible, so it
// has to answer before anyone signs in — and it is mounted here, above the auth
// middleware, for exactly that reason.
app.use("/v1/stats", statsRouter(store));

// What this deployment accepts for an upload (unauthenticated, no user data). Above
// the auth middleware for the same reason as the tally, plus one of its own: the
// browser app states the file limits on the upload step, where the visitor has not
// signed in yet — and someone deciding whether a scan is small enough should not have
// to authenticate to find out.
app.use("/v1/limits", limitsRouter(cfg));

// The deployment-wide quality tally (PRD §7.16), read by the weekly
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

// Auth endpoints are unauthenticated by definition (§9.1), which is also why they get a
// tighter budget than the rest: there is no credential to count against yet, and every
// device-flow poll spends an outbound call to GitHub. Counted in ADDITION to the general
// limiter above — the stricter of the two is simply the one that bites first.
app.use("/v1/auth", authRateLimit(cfg), authRouter(cfg));

// Everything else requires a GitHub bearer token.
const auth = makeAuthMiddleware(store, cfg);
app.use("/v1/me", auth, meRouter(cfg));
app.use("/v1/sessions", auth, sessionsRouter(cfg, store));

const port = cfg.server.port;
app.listen(port, () => {
  console.log(`Equalify Iris listening on http://localhost:${port} (base_url: ${cfg.server.base_url})`);
});
