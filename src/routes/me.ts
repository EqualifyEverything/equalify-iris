import { Router } from "express";
import type { IrisConfig } from "../config.ts";
import type { AuthedRequest } from "../auth/middleware.ts";

// GET /v1/me — the authenticated GitHub user and current configuration (§9.1).
export function meRouter(cfg: IrisConfig): Router {
  const r = Router();
  r.get("/", (req: AuthedRequest, res) => {
    const u = req.user!;
    res.json({
      github_login: u.github_login,
      github_user_id: u.github_user_id,
      upstream_repo: cfg.github.upstream_repo,
      fork_repo: u.fork_repo, // null until first /close (fork created lazily)
      defaults: { max_review_iterations: u.max_review_iterations },
    });
  });
  return r;
}
