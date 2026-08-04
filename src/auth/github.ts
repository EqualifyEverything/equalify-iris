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
//   2. Filing agent-suggestion and agent-update issues on the upstream repo —
//      `public_repo` for a public upstream, which the default deployment's is.
//
// The second one is not optional, and that is the point of the design rather than
// an implementation detail: every user of Iris contributes their feedback back to
// the shared agent library under their own GitHub identity (PRD §12). GitHub is the
// only SSO layer precisely so that authenticating and contributing are the same
// act — a user who could log in but not file would be taking from the library
// without giving back, and there is no mode for that.
//
// So `public_repo` is the floor, not a default to be lowered. It is exactly what
// filing an issue on a public upstream needs and no more. `repo` is for a private
// upstream only; it additionally grants read AND WRITE to every private repo the
// user can reach, which nothing here uses. Nothing opens pull requests and nothing
// pushes — PRD §7.13 described a fork-and-PR flow that was never built and has
// been dropped.
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
  // A running service never gets here with an empty scope: `oauth_scope: none` is
  // the only config that normalizes to "", and validateConfig rejects it at startup
  // (a token that cannot file is not a mode this service has). The guard stays for
  // direct callers — if it ever were empty, send NO parameter rather than `scope=`,
  // because GitHub documents what omitting it does and says nothing about what a
  // present-but-empty value does.
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
    // Same reason as authorizeUrl: unreachable from a valid config, and if it were
    // empty, omit the key rather than sending an empty one.
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
