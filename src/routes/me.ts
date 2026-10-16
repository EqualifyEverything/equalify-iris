import { Router } from "express";
import type { IrisConfig } from "../config.ts";

// GET /v1/me — the defaults this deployment applies.
//
// Not "who am I": every session belongs to the deployment, so this describes the
// DEPLOYMENT. It is still the useful first call for a client, because it is the cheapest way
// to find out whether this deployment can be used at all: 200 means any `server.api_token`
// was accepted, 401 means it was not. That answer cannot go stale the way a published flag
// could, since it is the same code path a real request takes.
export function meRouter(cfg: IrisConfig): Router {
  const r = Router();
  r.get("/", (_req, res) => {
    res.json({ defaults: { max_review_iterations: cfg.defaults.max_review_iterations } });
  });
  return r;
}
