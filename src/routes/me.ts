import { Router } from "express";
import type { AuthedRequest } from "../auth/middleware.ts";

// GET /v1/me — the GitHub account this deployment acts as, and the defaults it applies.
//
// Not "who am I": there is one identity here and every caller reaches it, so this describes
// the DEPLOYMENT. It is still the useful first call for a client, because it is the cheapest
// way to find out whether this deployment can be used at all — 200 means the account
// resolved and any `server.api_token` was accepted, 401 means one of those failed and the
// message says which. That answer cannot go stale the way a published flag could, since it
// is the same code path a real request takes.
export function meRouter(): Router {
  const r = Router();
  r.get("/", (req: AuthedRequest, res) => {
    const u = req.user!;
    res.json({
      github_login: u.github_login,
      github_user_id: u.github_user_id,
      defaults: { max_review_iterations: u.max_review_iterations },
    });
  });
  return r;
}
