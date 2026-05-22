import type { Request, Response, NextFunction } from "express";
import type { IrisConfig } from "../config.ts";
import type { Store, UserRecord } from "../store/db.ts";
import { fetchUser } from "./github.ts";
import { sendError } from "../routes/errors.ts";

// Request augmented with the resolved user + their GitHub token.
export interface AuthedRequest extends Request {
  user?: UserRecord;
  token?: string;
}

// Cache token -> user id so we don't hit GitHub's /user on every request.
const tokenCache = new Map<string, { id: number; expires: number }>();
const TTL_MS = 5 * 60 * 1000;

export function makeAuthMiddleware(store: Store, cfg: IrisConfig) {
  const apiBase = cfg.github.api_base_url;
  const defaultMaxIter = cfg.defaults.max_review_iterations;
  return async function auth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
    const header = req.header("authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      sendError(res, 401, "unauthorized", "Missing or malformed Authorization header");
      return;
    }
    const token = match[1].trim();

    try {
      const cached = tokenCache.get(token);
      let userId: number;
      if (cached && cached.expires > Date.now()) {
        userId = cached.id;
        // Keep the stored token fresh for PR operations.
        const u = store.getUser(userId);
        if (u && u.github_token !== token) store.upsertUser({ github_user_id: u.github_user_id, github_login: u.github_login, github_token: token });
      } else {
        // GitHub identifies the caller; login provisions an account (§9.1).
        const ghUser = await fetchUser(token, apiBase);
        store.upsertUser({ github_user_id: ghUser.id, github_login: ghUser.login, github_token: token }, defaultMaxIter);
        userId = ghUser.id;
        tokenCache.set(token, { id: userId, expires: Date.now() + TTL_MS });
      }
      req.user = store.getUser(userId)!;
      req.token = token;
      next();
    } catch (e) {
      sendError(res, 401, "unauthorized", `Token validation failed: ${(e as Error).message}`);
    }
  };
}
