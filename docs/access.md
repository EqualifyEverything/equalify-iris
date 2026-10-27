# Access, for operators

Iris has no sign-in and no GitHub identity. Every session belongs to the deployment. The only
access control is an optional shared secret, `server.api_token`.

## Gate it, or leave it open

**Blank (the default) means open.** Anyone who can reach the port can convert documents, spend your
model budget, and list and read every session. That is what lets the bundled demo page work with no
setup. It suits a laptop or a private network, not a public URL. With `server.audit` on, reading a
session also means its page images, the original upload and every prompt sent
([Audit](openapi.yaml)).

**Set it and callers must present it:**

```yaml
server:
  api_token: ${IRIS_API_TOKEN}   # openssl rand -hex 32
```

```bash
curl -H "Authorization: Bearer $IRIS_API_TOKEN" "$BASE/me"
```

A missing, malformed or wrong token gets the same `401`, which says only that the deployment is
gated.

**Gating turns off the demo page**, because the page holds no credential.

Iris prints which of the two you chose at every boot.

## What one shared deployment means

| What | Why |
| --- | --- |
| `GET /v1/sessions` lists every session | There is no caller to filter by. |
| A caller can read another caller's document | Sessions are not isolated. Anyone with access can list them. |
| Uploads are limited per address | The token is shared, so it can't key a budget. Behind NAT, callers share a budget, and `server.trust_proxy` must be right or they all look like the proxy. |

## What the gate does not cover

These answer without the token, and none touches a document:

| Endpoint | Why |
| --- | --- |
| `GET /v1/openapi.json` | The API's description. It holds no data. |
| `GET /v1/health` | A load balancer's probe can't hold a secret. |
| `GET /v1/limits` | Anyone should be able to check whether a scan is small enough. |
| `GET /v1/stats` | A deployment-wide tally with no per-session detail. |
| `GET /v1/quality` | Uses its own token (`server.quality_token`), and 404s unless you set it. |
| `GET /v1/suggestions` | Uses that same token, and 404s unless you set it. |

To make any of them private, put them behind your reverse proxy.

## Coming from an earlier build

- **A database from #459 to #540 is migrated on start.** Iris drops the GitHub owner column and the
  `users` table and keeps every session. This is one-way: an older image can't open the file after.
- **A database with a `github_token` column is refused.** An early build stored a plaintext token per
  user. Delete `data/iris.sqlite` rather than archiving it. You lose session history and nothing else.
- **Delete the `github:` block and `IRIS_GITHUB_TOKEN`.** They are ignored, so leaving them in only
  describes a setup you don't have. The same goes for the older `github.client_id`,
  `github.client_secret`, `github.oauth_scope`, `github.oauth_base_url`, `github.anonymous_token`,
  `github.issue_token`, `github.upstream_repo` and `server.rate_limits.auth_per_minute`. You can
  revoke the token at github.com.
- **`GET /v1/me` returns only `defaults`.** It no longer has `github_login` or `github_user_id`.
- **`POST /v1/auth/github/device` and its poll endpoint are gone** (404).
