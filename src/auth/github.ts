// GitHub OAuth helpers (PRD §9.1). GitHub is the only auth mechanism.
//
// Base URLs and the requested scope are passed in (not hardcoded) so a deployment
// can target GitHub Enterprise or a private upstream, and so the suite can drive
// the flow against a mock host.

// What the user's token is actually used for, and therefore the narrowest scope
// that still works:
//
//   1. `GET /user`, to identify the caller — needs NO scope. `id` and `login` are
//      public fields, so even a scopeless token answers.
//   2. Filing agent-suggestion issues on the upstream repo — `public_repo` for a
//      public upstream, which the default deployment's is.
//
// Nothing opens pull requests, and nothing pushes. `repo` was requested because
// PRD §7.13 described a fork-and-PR flow that was never built (see README
// "Implementation notes"), and it grants read AND WRITE to every private repo the
// user can reach. That matters more than a scope usually would here, because the
// token is stored in `data/iris.sqlite` in plaintext: with `repo`, read access to
// that file is push access to all of a user's repos, so narrowing the grant
// directly shrinks what a stolen database is worth. See PRD §9.1 ("How the token
// is stored") and the README's deployment note.
//
// Narrowing what we REQUEST does not shrink a grant a user already made — an
// existing token keeps `repo` until it is revoked at
// github.com/settings/applications. Only new authorizations are narrower.
export const DEFAULT_OAUTH_SCOPE = "public_repo";

export interface GitHubUser {
  id: number;
  login: string;
}

export function authorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  oauthBase: string,
  scope: string = DEFAULT_OAUTH_SCOPE,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  });
  // An empty scope is sent as NO parameter rather than `scope=`. Per GitHub's
  // docs, omitting it requests no scopes for a first-time user and reuses whatever
  // a returning user already authorized — which is the documented behavior,
  // whereas what a present-but-empty value does is not specified.
  //
  // Empty is what `normalizeScope` produces for `oauth_scope: none`, and ONLY for
  // that: it cannot be reached by an absent key or an unset `${VAR}`, both of
  // which fall back to the default. See the note on NO_OAUTH_SCOPE in config.ts —
  // an accidental "request nothing" is a 403 at issue-filing time, several steps
  // removed from its cause. A deployment asks for it when its service token files
  // every issue, so a user's token only ever needs to answer `GET /user`.
  if (scope) params.set("scope", scope);
  return `${oauthBase}/login/oauth/authorize?${params.toString()}`;
}

// Exchange an OAuth code (web flow) for an access token.
export async function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  oauthBase: string,
): Promise<string> {
  const res = await fetch(`${oauthBase}/login/oauth/access_token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  });
  const json = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!json.access_token) throw new Error(json.error_description ?? json.error ?? "token exchange failed");
  return json.access_token;
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

// Begin the device flow (CLI clients).
export async function startDeviceFlow(
  clientId: string,
  oauthBase: string,
  scope: string = DEFAULT_OAUTH_SCOPE,
): Promise<DeviceCodeResponse> {
  const res = await fetch(`${oauthBase}/login/device/code`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    // Same reason as authorizeUrl: send no `scope` key at all rather than an empty
    // one when the deployment configured none.
    body: JSON.stringify({ client_id: clientId, ...(scope ? { scope } : {}) }),
  });
  if (!res.ok) throw new Error(`device flow start failed: ${res.status}`);
  return (await res.json()) as DeviceCodeResponse;
}

export type DevicePoll =
  | { status: "approved"; access_token: string }
  | { status: "pending"; error: string };

// Poll for device-flow approval. Returns pending until the user approves.
export async function pollDeviceFlow(
  clientId: string,
  deviceCode: string,
  oauthBase: string,
): Promise<DevicePoll> {
  const res = await fetch(`${oauthBase}/login/oauth/access_token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const json = (await res.json()) as { access_token?: string; error?: string };
  if (json.access_token) return { status: "approved", access_token: json.access_token };
  return { status: "pending", error: json.error ?? "authorization_pending" };
}

// Identify the GitHub user behind a token (PRD §9.1: login is signup).
export async function fetchUser(token: string, apiBase: string): Promise<GitHubUser> {
  const res = await fetch(`${apiBase}/user`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "equalify-iris" },
  });
  if (!res.ok) throw new Error(`github user lookup failed: ${res.status}`);
  const json = (await res.json()) as { id: number; login: string };
  return { id: json.id, login: json.login };
}
