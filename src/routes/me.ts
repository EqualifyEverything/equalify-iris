import { Router } from "express";
import type { IrisConfig } from "../config.ts";
import type { AuthedRequest } from "../auth/middleware.ts";

// GET /v1/me — the GitHub account this deployment acts as, and the defaults it applies.
//
// Not "who am I": there is one identity here and every caller reaches it, so this describes
// the DEPLOYMENT. It is still the useful first call for a client, because it is the cheapest
// way to find out whether this deployment can be used at all — 200 means the account
// resolved and any `server.api_token` was accepted, 401 means one of those failed and the
// message says which. That answer cannot go stale the way a published flag could, since it
// is the same code path a real request takes.
export function meRouter(cfg: IrisConfig): Router {
  const r = Router();
  r.get("/", (req: AuthedRequest, res) => {
    const u = req.user!;
    // No `fork_repo`: it was always null, because the fork-and-PR flow it belonged to was
    // never built and has been dropped — contributions are filed as issues.
    res.json({
      github_login: u.github_login,
      github_user_id: u.github_user_id,
      upstream_repo: cfg.github.upstream_repo,
      defaults: { max_review_iterations: u.max_review_iterations },
    });
  });
  return r;
}
