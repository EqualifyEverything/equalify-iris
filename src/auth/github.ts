// GitHub App user-to-server authentication helpers.
// Users authorize the GitHub App and receive a user-to-server token.
// This token authenticates API requests and is scoped to the app's permissions.
// Base URLs are passed in (not hardcoded) for GitHub Enterprise and testing.

const SCOPE = ''; // GitHub App authorization does not use scopes; permissions are configured on the app.

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
  const params: Record<string, string> = {
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  };
  if (SCOPE) params.scope = SCOPE; // GitHub App does not use scopes
  const qs = new URLSearchParams(params).toString();
  return `${oauthBase}/login/oauth/authorize?${qs}`;
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
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const json = (await res.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!json.access_token)
    throw new Error(json.error_description ?? json.error ?? 'token exchange failed');
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
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: SCOPE }),
  });
  if (!res.ok) throw new Error(`device flow start failed: ${res.status}`);
  return (await res.json()) as DeviceCodeResponse;
}

export type DevicePoll =
  | { status: 'approved'; access_token: string }
  | { status: 'pending'; error: string };

// Poll for device-flow approval. Returns pending until the user approves.
export async function pollDeviceFlow(
  clientId: string,
  deviceCode: string,
  oauthBase: string,
): Promise<DevicePoll> {
  const res = await fetch(`${oauthBase}/login/oauth/access_token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  const json = (await res.json()) as { access_token?: string; error?: string };
  if (json.access_token) return { status: 'approved', access_token: json.access_token };
  return { status: 'pending', error: json.error ?? 'authorization_pending' };
}

// Identify the GitHub user behind a token (PRD §9.1: login is signup).
export async function fetchUser(token: string, apiBase: string): Promise<GitHubUser> {
  const res = await fetch(`${apiBase}/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'equalify-iris',
    },
  });
  if (!res.ok) throw new Error(`github user lookup failed: ${res.status}`);
  const json = (await res.json()) as { id: number; login: string };
  return { id: json.id, login: json.login };
}
