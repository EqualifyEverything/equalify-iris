import { Router } from "express";
import type { IrisConfig } from "../config.ts";
import type { AuthedRequest } from "../auth/middleware.ts";

// GET /v1/me — the authenticated GitHub user and current configuration.
export function meRouter(cfg: IrisConfig): Router {
  const r = Router();
  r.get("/", (req: AuthedRequest, res) => {
    const u = req.user!;
    // No `fork_repo`: it was always null, because the fork-and-PR flow it belonged
    // to was never built and has been dropped — contributions are filed
    // as issues under the user's own GitHub identity.
    res.json({
      github_login: u.github_login,
      github_user_id: u.github_user_id,
      upstream_repo: cfg.github.upstream_repo,
      defaults: { max_review_iterations: u.max_review_iterations },
      // Present and true only when this caller sent no credential and was served by
      // `github.anonymous_token`. Two reasons it is on THIS route rather than a new one:
      //
      //   1. A client cannot otherwise tell. The body is identical in both modes, so a
      //      demo page would print "Signed in as <bot account>" to a visitor who never
      //      signed in, and a script would credit its own feedback to that account
      //      without knowing.
      //   2. Called with no header, this route IS the capability probe — 200 means this
      //      deployment allows anonymous use, 401 means it does not. That answer cannot
      //      go stale the way a published flag could, because it is the same code path
      //      the real request takes.
      //
      // Omitted rather than `false` for a signed-in user: this route's body is public
      // API, and a key that appears only in the mode it describes reads as the exception
      // it is.
      ...(req.anonymous ? { anonymous: true } : {}),
    });
  });
  return r;
}
