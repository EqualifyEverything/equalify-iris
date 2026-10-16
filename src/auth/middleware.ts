import type { Request, Response, NextFunction } from "express";
import type { IrisConfig } from "../config.ts";
import { apiToken } from "../config.ts";
import { sendError } from "../routes/errors.ts";

// The one question this asks: may this caller use the API? Only when the operator set
// `server.api_token`. An open deployment has nothing to check, which is how a public demo
// is served.
//
// There is no "who is this caller". Every session belongs to the deployment (#540), so a
// caller who presents the token is not thereby anybody, and Iris makes no call to learn it.
export function makeAuthMiddleware(cfg: IrisConfig) {
  // Read once: config does not hot-reload.
  const gate = apiToken(cfg);

  return function auth(req: Request, res: Response, next: NextFunction): void {
    if (gate !== undefined) {
      const header = req.header("authorization") ?? "";
      const match = header.match(/^Bearer\s+(\S.*)$/i);
      // Compared after trimming, because `apiToken` trims what it read from config: a
      // configured `"  s3cret  "` must not be a gate that only an untrimmed copy opens.
      if (!match || match[1].trim() !== gate) {
        // Deliberately the same message for absent, malformed and wrong. A caller learns
        // whether this deployment is gated (it says so) and nothing about the secret.
        sendError(res, 401, "unauthorized", "This deployment requires a shared API token.");
        return;
      }
    }
    next();
  };
}
