# The GitHub token, for operators

Iris has **one** GitHub identity: a personal access token you set once, held by the server, used for
every session. Callers never present a GitHub credential — there is no sign-in, no OAuth app and no
device flow. The [README](../README.md#one-github-identity-and-no-sign-in) says why it works this
way. This file is what you need to deploy it.

Iris refuses to start without the token, so this is not optional setup.

## Make the token

1. Go to [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
   (**Fine-grained tokens** → Generate new token).
2. Repository access: **Only select repositories** → your `upstream_repo`.
3. Permissions → Repository permissions → **Issues: Read and write**. Nothing else.
4. Set an expiry you will remember. Nothing renews it.
5. Put the value in the environment as `IRIS_GITHUB_TOKEN`; the example config reads it from there.

```yaml
github:
  token: ${IRIS_GITHUB_TOKEN}
  upstream_repo: https://github.com/your-org/your-agent-library
```

The token is never sent to a browser and never written to the database. Issues get filed as whatever
account made it — so make it an account you are willing to see on those issues, and consider a
service account rather than your own.

**When it expires, conversions keep working.** Filing is the only thing that stops, with a 403 or 404
whose log line names `github.token`. Nothing else breaks, which is why an expired token is easy to
miss — put the expiry date in a calendar.

## What one identity costs

Iris warns about this at every boot, so it is not a surprise later. All four follow from having no
per-caller identity, and none of them is a bug:

| What | Why |
| --- | --- |
| Contributors get **no attribution** | Every issue is filed as your token's account. The issue says what a session found, not who found it. |
| `GET /v1/sessions` lists **the deployment's** sessions | Ownership is one account, so there is no such thing as "the caller's sessions". Anyone who can call it sees every session id, and an id is all `/output` needs. |
| Uploads are limited **per address** | The only credential a caller can present is shared, so keying a budget on it would put the whole internet in one bucket. Behind NAT, callers share a budget — and `server.trust_proxy` has to be right or they all look like the proxy. |
| A visitor can read **another visitor's** document | Given the session id. Sessions are not isolated from each other, because there is nobody to isolate. |

The last two are the ones to think about before you deploy publicly. Gating (below) is the answer.

## Gate it, or leave it open

`server.api_token` is a **separate shared secret** that decides who may call the API at all. It is
not a GitHub token and it does not make anyone anybody: every caller who presents it reaches the same
deployment account.

**Blank (the default) means open.** Anyone who can reach the port can convert documents, spend your
model budget and read any session whose id they have. That is what makes the bundled browser app work
with no setup, and it is the right default for a laptop or a private network — not for a public URL.

**Set it and callers must present it:**

```yaml
server:
  api_token: ${IRIS_API_TOKEN}   # openssl rand -hex 32
```

```bash
curl -H "Authorization: Bearer $IRIS_API_TOKEN" "$BASE/me"
```

Absent, malformed, wrong scheme and wrong secret all get the same `401` saying only that the
deployment is gated. Nothing tells a caller anything about the secret.

**Gating turns off the bundled demo page**, which holds no credential. That is the trade: a public
deployment either hands the secret to the people who should use it, or accepts strangers.

### What the gate does not cover

Four endpoints sit above it and answer on a gated deployment. None touches a document or an identity:

| Endpoint | Why |
| --- | --- |
| `GET /v1/health` | A load balancer's probe cannot hold a secret. |
| `GET /v1/limits` | Someone deciding whether their scan is small enough should not need the key to find out. |
| `GET /v1/stats` | A deployment-wide tally, no per-session detail. |
| `GET /v1/quality` | Has its own token (`server.quality_token`) and 404s unless you set it. |

If any of those must be private too, put it behind your reverse proxy. Iris will not do it for you.

## Two failures and what they look like

**`401 This deployment could not authenticate to GitHub`** — your token is wrong, revoked or expired,
or GitHub is down. Iris asks GitHub once, caches the answer for the life of the process, and after a
failure waits 30 seconds before asking again — so a transient outage clears itself without a restart
and without one `GET /user` per request. Fix the token and restart.

**`500 github.token is not configured`** — only reachable from a config that never went through
validation. A deployment that booted has the key.

Filing failures are separate and never fail a run: they are logged as `agent_issue_failed` /
`agent_update_issue_failed` with a `hint`. The likely cause is always the same one now — that PAT's
access to `upstream_repo`. Expect **404** more often than 403: GitHub does not reveal repositories a
credential cannot see, so no access reads as "no such repo". A misspelled `upstream_repo` is identical
on the wire, and the hint says so rather than blaming one.

## Coming from an earlier build

- **Delete `data/iris.sqlite`.** An early build stored a token per user in a `github_token` column.
  There is no migration and the service refuses to start against such a file rather than adopting it:
  the old `github_token TEXT NOT NULL` survives `CREATE TABLE IF NOT EXISTS`, so Iris could not write
  the one row it owns and **every** request would fail with a `500` naming a SQLite constraint on a
  column no current build writes. The file also still holds live plaintext tokens, so delete it rather
  than archiving it. You lose session history and nothing else.
- **Delete these keys.** `github.client_id`, `github.client_secret`, `github.oauth_scope`,
  `github.oauth_base_url`, `github.anonymous_token`, `github.issue_token`, and
  `server.rate_limits.auth_per_minute`. They are ignored, not errors — but leaving them in a config
  file describes a deployment you do not have.
- **`POST /v1/auth/github/device` and its poll endpoint are gone** (404). Any client running the
  device flow needs updating: it now sends either nothing or `server.api_token`.
- **`GET /v1/me` no longer describes the caller.** It describes the deployment, and it has no
  `anonymous` field to check — 200 means open, 401 means gated.

## What happens to a token

Yours is in your config and your environment; treat it like any other server secret. Nothing else
about it is stored: there is no `github_token` column and no token file. A stolen copy of
`data/iris.sqlite` is not GitHub access. What it does hold is a GitHub user id and login for each
account this deployment has run as — one, unless you have pointed it at a different account, since
nothing removes the old row or its sessions — plus the session history, which is the part worth
protecting.

There is no per-user token to rotate, cache or purge, and no user-facing revocation story — because
no user ever authorized anything. Revoke at github.com and restart.

Rotating the token for the **same** account changes nothing in the database. Pointing it at a
**different** account strands the old account's sessions. Every per-session route checks the owner, so
a session id you still hold answers `404 session_not_found` — all of it, not just the listing:

| What you lose | Why it matters |
| --- | --- |
| Status, document, logs, diagnostics | All four reads 404, so you cannot even check what a session's state was, let alone fetch the HTML it produced. |
| `POST /{id}/feedback` | A session waiting at `ready_for_review` cannot be iterated on — the review loop stops. |
| `POST /{id}/close` | No fixture capture, and the session's temporary files stay on disk. `close` is the only thing that removes them. |

Nothing is deleted. The rows are still in `data/iris.sqlite`, and pointing the config back at the
first account makes them reachable again — but only reachable: the tmp trees go when someone actually
closes those sessions, not when you switch back.

So: **close anything you have finished with before switching accounts**, and finish anything mid-review
first. Exporting the documents does neither.
