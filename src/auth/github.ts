// The one GitHub call Iris makes to identify itself.
//
// A deployment has a single GitHub identity: the token in `github.token`, set once by the
// operator and never sent to a client. This file turns that token into an account.
//
// The base URL is passed in rather than hardcoded so a deployment can target GitHub
// Enterprise, and so the suite can drive this against a mock host.
//
// The token is used for one thing: `GET /user`, here, to name the account sessions belong
// to. Iris files no issues (#539), so the token needs no repository permissions at all.
//
// One operator-visible consequence of there being one token:
//
//   - A fine-grained PAT EXPIRES, and nothing here refreshes it. The day it lapses, every
//     request 401s with "could not authenticate to GitHub" and the fix is a new token in
//     config. GitHub emails the token's owner before that happens; there is no in-process
//     warning, because a PAT's expiry is not visible in `GET /user`.

export interface GitHubUser {
  id: number;
  login: string;
}

// Identify the GitHub account behind a token.
//
// The status goes in the message because that is the only place it is read: the caller
// backs off for a fixed window on ANY failure and says so, rather than sorting a 401 from a
// 500 (see src/auth/middleware.ts for why one identity makes that distinction moot).
export async function fetchUser(token: string, apiBase: string): Promise<GitHubUser> {
  const res = await fetch(`${apiBase}/user`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "equalify-iris" },
  });
  if (!res.ok) throw new Error(`github user lookup failed: ${res.status}`);
  const json = (await res.json()) as { id: number; login: string };
  return { id: json.id, login: json.login };
}
