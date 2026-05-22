import express from "express";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { Store } from "./store/db.ts";
import { makeAuthMiddleware } from "./auth/middleware.ts";
import { authRouter } from "./routes/auth.ts";
import { meRouter } from "./routes/me.ts";
import { sessionsRouter } from "./routes/sessions.ts";

const cfg = loadConfig();

// Ensure the on-disk layout exists (PRD §8.1).
mkdirSync(join(cfg.storage.data_dir, "sessions"), { recursive: true });
mkdirSync(join(cfg.storage.data_dir, "tmp"), { recursive: true });

const store = new Store(cfg.storage.database);
// Clear sessions orphaned by a previous shutdown (their in-process run is gone).
const stale = store.failStaleSessions();
if (stale > 0) console.log(`Marked ${stale} interrupted session(s) as failed on startup.`);
const app = express();
app.use(express.json({ limit: "2mb" }));

// Liveness probe (unauthenticated) — confirms the service is up.
app.get("/v1/health", (_req, res) => res.json({ status: "ok", service: "equalify-iris" }));

// Accessible browser demo (unauthenticated page; it drives the /v1 API itself).
// no-store so an iterating deployment never serves a stale copy of the page.
const demoFile = fileURLToPath(new URL("../public/demo.html", import.meta.url));
app.get("/demo", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(demoFile);
});

// Auth endpoints are unauthenticated by definition (§9.1).
app.use("/v1/auth", authRouter(cfg));

// Everything else requires a GitHub bearer token.
const auth = makeAuthMiddleware(store, cfg);
app.use("/v1/me", auth, meRouter(cfg));
app.use("/v1/sessions", auth, sessionsRouter(cfg, store));

const port = cfg.server.port;
app.listen(port, () => {
  console.log(`Equalify Iris listening on http://localhost:${port} (base_url: ${cfg.server.base_url})`);
});
