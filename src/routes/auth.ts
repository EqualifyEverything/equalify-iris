import { Router } from "express";
import { randomBytes } from "node:crypto";
import type { IrisConfig } from "../config.ts";
import { authorizeUrl, exchangeCode, startDeviceFlow, pollDeviceFlow } from "../auth/github.ts";
import { sendError } from "./errors.ts";

export function authRouter(cfg: IrisConfig): Router {
  const r = Router();
  const callbackUrl = `${cfg.server.base_url}/v1/auth/github/callback`;
  // Short-lived OAuth state values issued by /start, checked at /callback.
  const states = new Map<string, number>();
  const STATE_TTL = 10 * 60 * 1000;

  const cleanStates = () => {
    const now = Date.now();
    for (const [s, exp] of states) if (exp < now) states.delete(s);
  };

  // Web flow: redirect to the GitHub consent screen (requests `repo` scope).
  r.get("/github/start", (_req, res) => {
    if (!cfg.github.client_id) {
      sendError(res, 500, "github_not_configured", "GITHUB_CLIENT_ID is not set");
      return;
    }
    const state = randomBytes(16).toString("hex");
    states.set(state, Date.now() + STATE_TTL);
    res.redirect(authorizeUrl(cfg.github.client_id, callbackUrl, state, cfg.github.oauth_base_url));
  });

  // Web flow: exchange the code for a token and return it to the client.
  r.get("/github/callback", async (req, res) => {
    cleanStates();
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    if (!code) {
      sendError(res, 400, "invalid_request", "Missing code");
      return;
    }
    if (!state || !states.has(state)) {
      sendError(res, 400, "invalid_state", "Missing or unknown OAuth state");
      return;
    }
    states.delete(state);
    try {
      const token = await exchangeCode(cfg.github.client_id, cfg.github.client_secret, code, callbackUrl, cfg.github.oauth_base_url);
      res.json({ access_token: token, token_type: "bearer" });
    } catch (e) {
      sendError(res, 400, "oauth_failed", (e as Error).message);
    }
  });

  // Device flow (CLI): begin and return the user code + verification URI.
  r.post("/github/device", async (_req, res) => {
    if (!cfg.github.client_id) {
      sendError(res, 500, "github_not_configured", "GITHUB_CLIENT_ID is not set");
      return;
    }
    try {
      const d = await startDeviceFlow(cfg.github.client_id, cfg.github.oauth_base_url);
      res.json({
        device_code: d.device_code,
        user_code: d.user_code,
        verification_uri: d.verification_uri,
        expires_in: d.expires_in,
        interval: d.interval,
      });
    } catch (e) {
      sendError(res, 502, "oauth_failed", (e as Error).message);
    }
  });

  // Device flow (CLI): poll for approval; returns the token once approved.
  r.post("/github/device/poll", async (req, res) => {
    const deviceCode = (req.body as { device_code?: string } | undefined)?.device_code;
    if (!deviceCode) {
      sendError(res, 400, "invalid_request", "Missing device_code");
      return;
    }
    try {
      const result = await pollDeviceFlow(cfg.github.client_id, deviceCode, cfg.github.oauth_base_url);
      if (result.status === "approved") {
        res.json({ access_token: result.access_token, token_type: "bearer" });
      } else {
        // 202: still pending (authorization_pending / slow_down / etc.)
        res.status(202).json({ status: "pending", error: result.error });
      }
    } catch (e) {
      sendError(res, 502, "oauth_failed", (e as Error).message);
    }
  });

  return r;
}
