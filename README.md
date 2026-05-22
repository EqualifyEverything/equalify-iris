# Equalify Iris

Image-to-accessible-HTML parsing service.

## Sustainability

**Equalify Iris is Open Source.** Sustainability is key to sustaining its growth. With that in mind, we hope you use and alter the codebase.

Iris is built by **Equalify Inc** ([https://equalify.app/](https://equalify.app/)). Continued support and development are paid for when you hire us to host or support any instance. Please consider hiring us.

## Running the API

This implementation uses only the Python standard library.

```bash
python3 -m equalify_iris
```

The API listens on `http://127.0.0.1:8000` by default. Override with:

```bash
IRIS_HOST=0.0.0.0 IRIS_PORT=8000 python3 -m equalify_iris
```

Runtime data is stored in local `sessions/`, `tmp/`, and `iris.sqlite3` files by default.

## Configuration

GitHub OAuth is required by the PRD. Configure these values before using authenticated endpoints:

```bash
export GITHUB_CLIENT_ID=...
export GITHUB_CLIENT_SECRET=...
export GITHUB_REDIRECT_URI=http://127.0.0.1:8000/v1/auth/github/callback
```

Optional runtime settings:

```bash
export IRIS_DATA_DIR=.
export IRIS_UPSTREAM_REPO=https://github.com/example/accessible-html-agents
export IRIS_DEFAULT_MAX_REVIEW_ITERATIONS=3
```

Model calls use OpenRouter in this build:

```bash
export OPENROUTER_API_KEY=...
export OPENROUTER_DEFAULT_MODEL=anthropic/claude-3.5-sonnet
export OPENROUTER_VISION_MODEL=anthropic/claude-3.5-sonnet
export OPENROUTER_STRUCTURED_MODEL=anthropic/claude-3.5-sonnet
export OPENROUTER_TEXT_MODEL=anthropic/claude-3.5-sonnet
```

## API

Endpoints are versioned under `/v1`:

```text
GET  /v1/auth/github/start
GET  /v1/auth/github/callback
POST /v1/auth/github/device
POST /v1/auth/github/device/poll
GET  /v1/me
GET  /v1/sessions
POST /v1/sessions
GET  /v1/sessions/{session_id}
GET  /v1/sessions/{session_id}/output
POST /v1/sessions/{session_id}/feedback
POST /v1/sessions/{session_id}/close
GET  /v1/sessions/{session_id}/logs
```

All non-auth endpoints require `Authorization: Bearer <github_token>`.

Detailed endpoint behavior is documented in [docs/api.md](docs/api.md).

Copy-pasteable bash commands are documented in [docs/bash-quickstart.md](docs/bash-quickstart.md).

PRD coverage is documented in [docs/prd-coverage.md](docs/prd-coverage.md).
