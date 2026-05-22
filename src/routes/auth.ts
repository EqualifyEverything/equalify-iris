import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import type { IrisConfig } from '../config.ts';
import { authorizeUrl, exchangeCode } from '../auth/github.ts';
import { sendError } from './errors.ts';

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

  // GitHub App user-to-server web flow: redirect to GitHub App authorization.
  r.get('/github/start', (_req, res) => {
    if (!cfg.github.client_id || !cfg.github.client_secret) {
      sendError(
        res,
        500,
        'github_not_configured',
        'GitHub App user-to-server OAuth requires both client_id and client_secret.',
      );
      return;
    }
    const state = randomBytes(16).toString('hex');
    states.set(state, Date.now() + STATE_TTL);
    res.redirect(authorizeUrl(cfg.github.client_id, callbackUrl, state, cfg.github.oauth_base_url));
  });

  // GitHub App OAuth callback: exchange code for user-to-server token.
  r.get('/github/callback', async (req, res) => {
    cleanStates();
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    if (!code) {
      sendError(res, 400, 'invalid_request', 'Missing code');
      return;
    }
    if (!state || !states.has(state)) {
      sendError(res, 400, 'invalid_state', 'Missing or unknown OAuth state');
      return;
    }
    states.delete(state);
    if (!cfg.github.client_secret) {
      sendError(
        res,
        500,
        'github_not_configured',
        'GitHub App user-to-server OAuth requires client_secret',
      );
      return;
    }
    try {
      const token = await exchangeCode(
        cfg.github.client_id,
        cfg.github.client_secret,
        code,
        callbackUrl,
        cfg.github.oauth_base_url,
      );
      // Redirect back to the demo page with token in query parameter.
      // Frontend will extract token from URL, store in sessionStorage, and clean up URL.
      const demoUrl = new URL(cfg.server.base_url);
      demoUrl.pathname = '/demo';
      demoUrl.searchParams.set('token', token);
      res.redirect(demoUrl.toString());
    } catch (e) {
      sendError(res, 400, 'oauth_failed', (e as Error).message);
    }
  });

  return r;
}
