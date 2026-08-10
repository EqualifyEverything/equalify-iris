// GitHub App auth helpers (PRD §9.1). GitHub is the only auth mechanism.
//
// Base URLs are passed in (not hardcoded) so a deployment can target GitHub
// Enterprise, and so the suite can drive the flow against a mock host.
//
// Iris authenticates as a GITHUB APP, not an OAuth App, and no scope is requested
// anywhere in this file. That is the whole reason for the choice, so it is worth
// being explicit about where the permission went.
//
// What the user's token is used for is unchanged, and it is only two things:
//
//   1. `GET /user`, to identify the caller.
//   2. Filing agent-suggestion and agent-update issues on the upstream repo
//      (create the issue, and read-or-create its triage label).
//
// An OAuth App can only express #2 as `public_repo`, an ACCOUNT-WIDE grant of read
// and write to every public repository the user can reach — code, commit statuses,
// collaborators, webhooks. Nothing here uses any of that: nothing pushes and nothing
// opens pull requests (PRD §7.13 described a fork-and-PR flow that was never built
// and has been dropped). The consent screen was therefore asking for orders of
// magnitude more than the service does, and there is no narrower OAuth scope — no
// scope means "issues on one repository".
//
// A GitHub App moves that permission off the user entirely. `issues: write` is
// granted once, by INSTALLING the app on `upstream_repo`, and it is scoped to the
// repositories of that installation. Users only authorize; the consent screen
// requests no repository access at all, because there is nothing left for it to ask
// for. A private `upstream_repo` needs no escalation either — installation covers it.
//
// What the user's token still carries is their IDENTITY: a user-to-server token acts
// as the user, so issues are filed under their own account and each contribution is
// credited to the person whose session produced it (PRD §12). That is why the app is
// authorized by users at all rather than filing everything as itself.
//
// Two registration settings this code depends on, both invisible from here:
//   - Device flow ENABLED. It is off by default for a new app, and the default
//     deployment's only login path (`startDeviceFlow`) returns
//     `device_flow_disabled` without it.
//   - Token expiry OFF. GitHub's default is an 8-hour user token plus a refresh
//     token; with expiry off, `expires_in`/`refresh_token` are omitted and a token
//     stays valid until revoked. Nothing here persists or refreshes a credential
//     (src/auth/middleware.ts caches only a token->id mapping, in memory), so
//     turning expiry on later means building refresh plumbing first.

export interface GitHubUser {
  id: number;
  login: string;
}

export function authorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  oauthBase: string,
): string {
  // No `scope` parameter, deliberately. A GitHub App ignores it — its permissions
  // come from the installation, not from the authorization — so sending one would
  // be inert at best and misleading to anyone reading this URL.
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  });
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
): Promise<DeviceCodeResponse> {
  const res = await fetch(`${oauthBase}/login/device/code`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    // No `scope`, same reason as authorizeUrl.
    body: JSON.stringify({ client_id: clientId }),
  });
  // A `device_flow_disabled` error here means the app was registered without the
  // "Enable Device Flow" checkbox — the one setting this default login path needs.
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
