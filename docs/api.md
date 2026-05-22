# API Reference

The service exposes the PRD v1 REST API under `/v1`.

For a complete bash workflow, see [bash-quickstart.md](bash-quickstart.md).

All endpoints return JSON unless the PRD specifies another content type. Error responses use:

```json
{
  "error": {
    "code": "invalid_state",
    "message": "Human-readable description",
    "details": {}
  }
}
```

## Authentication

GitHub OAuth is the only authentication mechanism.

### `GET /v1/auth/github/start`

Redirects to the GitHub OAuth consent screen with `repo` scope.

Requires:

```bash
GITHUB_CLIENT_ID=...
GITHUB_REDIRECT_URI=http://127.0.0.1:8000/v1/auth/github/callback
```

### `GET /v1/auth/github/callback?code=...`

Exchanges a GitHub OAuth code for an access token, identifies the GitHub user, and provisions the local account record.

Requires:

```bash
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
```

### `POST /v1/auth/github/device`

Starts GitHub's device flow for CLI clients.

### `POST /v1/auth/github/device/poll`

Request:

```json
{ "device_code": "..." }
```

Polls GitHub until the user authorizes the device flow or GitHub returns a pending/expired response.

## Current User

### `GET /v1/me`

Requires:

```http
Authorization: Bearer <github_token>
```

Returns the authenticated GitHub user, configured upstream repo, fork repo if known, and default run settings.

## Sessions

### `GET /v1/sessions`

Lists sessions owned by the authenticated GitHub user.

Optional query parameters:

- `status`
- `limit`
- `cursor`

### `POST /v1/sessions`

Creates a session and uploads ordered input images.

Request type: `multipart/form-data`

Parts:

- `images`: repeated image files in processing order. Supported extensions: `.png`, `.jpg`, `.jpeg`, `.tif`, `.tiff`, `.webp`.
- `config`: optional JSON object, for example `{ "max_review_iterations": 3 }`.

The API creates `sessions/<session-id>/`, `tmp/<session-id>/`, stores the original images, and starts the pipeline asynchronously.

If no model provider is configured, the API still accepts the session but the pipeline marks it `failed` with `provider_not_configured` in `log.jsonl`.

With Bedrock or OpenRouter configured, the pipeline runs triage, content extraction, reconciliation, assembly, and review through the configured provider.

### `GET /v1/sessions/{session_id}`

Returns session status and phase. When `status` is `ready_for_review`, the response includes `pending_prs`.

### `GET /v1/sessions/{session_id}/output`

Returns `text/html` when the session is `ready_for_review` or `closed`.

Returns `409 Conflict` while the session is still running or if it failed before producing output.

### `POST /v1/sessions/{session_id}/feedback`

Request:

```json
{ "feedback": "Free-text feedback for the next run." }
```

Valid only when the session is `ready_for_review`. Starts a new asynchronous run in the same session.

### `POST /v1/sessions/{session_id}/close`

Finalizes a `ready_for_review` session and deletes `tmp/<session-id>/`.

Optional query parameter:

- `skip_prs=true`

If the session did not generate agent contributions, the response returns an empty `prs_opened` array.

### `GET /v1/sessions/{session_id}/logs`

Returns `application/x-ndjson` containing the session `log.jsonl` content.
