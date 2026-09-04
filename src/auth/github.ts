// GitHub App auth helpers. GitHub is the only auth mechanism.
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
// opens pull requests (an earlier design described a fork-and-PR flow that was
// never built and has been dropped). The consent screen was therefore asking for orders of
// magnitude more than the service does, and there is no narrower OAuth scope — no
// scope means "issues on one repository".
//
// A GitHub App moves that permission off the user entirely. `issues: write` is
// granted once, by INSTALLING the app on `upstream_repo`, and it is scoped to the
// repositories of that installation. Users only authorize; the consent screen
// requests no repository access at all, because there is nothing left for it to ask
// for.
//
// One limit of that, because it is easy to state too strongly: a user-to-server token
// is the INTERSECTION of the installation's permissions and the authorizing user's own
// access. Installing the app does not hand a user access they did not have — GitHub is
// explicit that "if a user does not have access to a repository, your app cannot access
// that repository on their behalf even if the app is installed on that repository." So
// a PUBLIC `upstream_repo` (the design's assumption — the agent library is public) files
// for everyone, while a PRIVATE one files only for users who can already see it and
// 404s for everyone else. A private upstream that anyone can contribute to therefore
// needs `github.issue_token`, which trades away per-user attribution.
//
// What the user's token still carries is their IDENTITY: a user-to-server token acts
// as the user, so issues are filed under their own account and each contribution is
// credited to the person whose session produced it. That is why the app is
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

// The warning text for a token GitHub issued with an expiry, or undefined if it has
// none. Shared by both login flows rather than written at each: BOTH must diagnose
// this, and the device flow having a warning the web flow lacked was the whole defect
// — a web-flow deployment that left "Expire user authorization tokens" at GitHub's
// default got no signal at all, and the symptom (every user 401s, eight hours later,
// nowhere near the cause) is the least guessable one this service has.
//
// Returned rather than logged so the callers decide where it goes and so it is
// testable. Nothing here persists or refreshes a credential — src/auth/middleware.ts
// caches only a token->id mapping, in memory — so an expiring token is not a mode
// this service supports, which is why it warns rather than adapting.
export function expiringTokenWarning(expiresIn: number | undefined): string | undefined {
  if (expiresIn === undefined) return undefined;
  return (
    `GitHub issued a user token expiring in ${expiresIn}s. Iris does not refresh tokens, so users will be ` +
    `logged out and their requests will 401 after that. Turn OFF "Expire user authorization tokens" in the ` +
    `GitHub App's settings.`
  );
}

export interface TokenResult {
  access_token: string;
  // Present only when the app has user-token expiry ON, which this service is not
  // built for. See expiringTokenWarning.
  expires_in?: number;
}

// Exchange an OAuth code (web flow) for an access token.
//
// Returns the expiry alongside the token, for the same reason pollDeviceFlow does:
// it is the only observable difference between an app registered with user-token
// expiry off and one left at GitHub's default, and the web flow needs that diagnosis
// as much as the device flow does.
export async function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  oauthBase: string,
): Promise<TokenResult> {
  const res = await fetch(`${oauthBase}/login/oauth/access_token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  });
  const json = (await res.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
    expires_in?: number;
  };
  if (!json.access_token) throw new Error(json.error_description ?? json.error ?? "token exchange failed");
  return { access_token: json.access_token, expires_in: json.expires_in };
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
  // The body is read on BOTH paths, and the error inside it is the point. GitHub
  // answers `device_flow_disabled` when the app was registered without the "Enable
  // Device Flow" checkbox — the one setting this default login path needs, invisible
  // from here, and the single most likely thing to be wrong on a fresh app. The route
  // turns whatever this throws into the operator's error message, so dropping the
  // body left them with "device flow start failed: 400" and no way to guess.
  //
  // And an error can arrive with a 200: GitHub's OAuth endpoints return `{"error":
  // "..."}` at 200 in some cases, which a status-only check reads as success. That
  // returned a DeviceCodeResponse of undefineds and the route answered 200 with
  // `device_code: null` — a client polling forever against a flow that never started.
  // So success requires a `device_code`, not a 2xx.
  const body = (await res.json().catch(() => null)) as
    | (Partial<DeviceCodeResponse> & { error?: string; error_description?: string })
    | null;
  if (!res.ok || !body?.device_code) {
    const detail = body?.error_description ?? body?.error;
    throw new Error(`device flow start failed: ${res.status}${detail ? ` ${detail}` : ""}`);
  }
  return body as DeviceCodeResponse;
}

export type DevicePoll =
  | { status: "approved"; access_token: string; expires_in?: number }
  | { status: "pending"; error: string };

// Poll for device-flow approval. Returns pending until the user approves.
//
// `expires_in` is carried out of the response for one reason: it is the only
// observable difference between an app registered with user-token expiry OFF (the
// setting this code requires) and one left at GitHub's default. Nothing here
// persists or refreshes a credential, so a deployment that missed that checkbox
// works for eight hours and then 401s every request with nothing to explain it. The
// route logs it; see routes/auth.ts.
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
  const json = (await res.json()) as { access_token?: string; error?: string; expires_in?: number };
  if (json.access_token) {
    return { status: "approved", access_token: json.access_token, expires_in: json.expires_in };
  }
  return { status: "pending", error: json.error ?? "authorization_pending" };
}

// Identify the GitHub user behind a token. Login is signup: there is no separate
// registration step.
export async function fetchUser(token: string, apiBase: string): Promise<GitHubUser> {
  const res = await fetch(`${apiBase}/user`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "equalify-iris" },
  });
  if (!res.ok) throw new Error(`github user lookup failed: ${res.status}`);
  const json = (await res.json()) as { id: number; login: string };
  return { id: json.id, login: json.login };
}
