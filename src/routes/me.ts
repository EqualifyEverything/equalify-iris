import { Router } from "express";
import type { IrisConfig } from "../config.ts";
import type { AuthedRequest } from "../auth/middleware.ts";

// GET /v1/me — the authenticated GitHub user and current configuration (§9.1).
export function meRouter(cfg: IrisConfig): Router {
  const r = Router();
  r.get("/", (req: AuthedRequest, res) => {
    const u = req.user!;
    // No `fork_repo`: it was always null, because the fork-and-PR flow it belonged
    // to (PRD §7.13) was never built and has been dropped — contributions are filed
    // as issues under the user's own GitHub identity (§12).
    res.json({
      github_login: u.github_login,
      github_user_id: u.github_user_id,
      upstream_repo: cfg.github.upstream_repo,
      defaults: { max_review_iterations: u.max_review_iterations },
    });
  });
  return r;
}
