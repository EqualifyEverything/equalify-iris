// The one GitHub call Iris makes to identify itself.
//
// A deployment has a single GitHub identity: the token in `github.token`, set once by the
// operator and never sent to a client. This file turns that token into an account.
//
// The base URL is passed in rather than hardcoded so a deployment can target GitHub
// Enterprise, and so the suite can drive this against a mock host.
//
// What the token is used for, and it is only two things:
//
//   1. `GET /user`, here, to name the account sessions and issues belong to.
//   2. Filing agent-suggestion and agent-update issues on `upstream_repo` (create the
//      issue, and read-or-create its triage label) — see src/github/issue.ts.
//
// So the narrowest credential that works is a fine-grained personal access token scoped to
// `upstream_repo` alone with `Issues: read and write`. Nothing pushes, nothing opens pull
// requests, and nothing reads code, so a classic `repo` token grants far more than this
// service uses.
//
// Two operator-visible consequences of there being one token:
//
//   - Every issue is filed under this account. Iris credits the human who prompted a
//     contribution in the issue body instead (see src/github/issue.ts), because a token
//     cannot act as somebody else.
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
