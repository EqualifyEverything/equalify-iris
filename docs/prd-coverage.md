# PRD Coverage

This document maps the current implementation to `prd.md`.

## Implemented

| PRD section | Coverage |
| --- | --- |
| 7.1 Input | Accepts ordered PNG, JPEG, TIFF, and WebP uploads as repeated `images` multipart parts. Supports `max_review_iterations` and feedback re-runs. |
| 7.2 Image Analysis Agent | Runs a vision provider per image and writes `notes/<image-name>.md` using the PRD schema. |
| 7.3 Orchestrator | Processes images sequentially, dispatches listed content agents, records `no-content` signals, and writes `log.jsonl`. |
| 7.4 Content Agents | Loads markdown agent files from `agents/`, parses required capabilities, sends full source images plus notes, and stores wrapped HTML fragments plus fragment logs. |
| 7.5 Builder Agent | Creates missing content agents in `tmp/<session-id>/agents/`, logs inline agent content, and records summaries in `new-agents.md`. |
| 7.6 Reconciliation Agent | Sends collected fragments through the reconciliation provider and preserves final fragments in order. |
| 7.7 Assembly | Builds a minimal accessible HTML shell with provenance comments preserved and runs built-in structural lint before review. |
| 7.8-7.11 Review loop | Runs Reader, Copy Editor, and Assembler phases with a bounded review loop. Remaining issues are appended as an unresolved block and written to `unresolved.md`. |
| 7.12 User feedback re-run | Feedback starts a new run in the same session and is passed to triage. |
| 7.13 GitHub PR workflow | Close finalizes accepted output, deletes `tmp/<session-id>/`, and returns PR results. Sessions without generated contributions return an empty PR list. |
| 8.1 File layout | Creates `agents/`, `tmp/<session-id>/`, and `sessions/<session-id>/` with input, notes, fragments, output, log, and summary files. |
| 8.2 Session lifecycle | Creates session and tmp directories on open. Deletes `tmp/<session-id>/` on close. Preserves `sessions/<session-id>/`. |
| 9 API specification | Implements every listed `/v1` route. |
| 9.1 Authentication | Uses GitHub OAuth and GitHub token introspection for authenticated routes. Provisions accounts on first successful auth. |
| 9.2 Sessions | Implements list, create, detail, output, feedback, close, and logs endpoints with PRD-shaped responses. |
| 9.3 Errors | Uses the standard `{ "error": { "code", "message", "details" } }` envelope. |
| 9.4 Asynchrony | Session creation and feedback start background pipeline runs. Clients poll session detail. |
| 10.2 Storage | Uses local filesystem artifacts and SQLite metadata by default. |
| 10.3 Model providers | Provides the model-provider interface, Bedrock adapter, and OpenRouter adapter for `text`, `vision`, and `structured_output` capabilities. |
| 10.4 Packaging | Includes Dockerfile and `docker-compose.yml` for local single-machine deployment. |
| 12 Sustainability | README includes the required sustainability notice above install and usage instructions. |
| Appendix A / initial agents | Provides the v1 initial agent markdown files in `agents/`. |

## Production Test Configuration

Required:

```bash
export GITHUB_CLIENT_ID=...
export GITHUB_CLIENT_SECRET=...
export GITHUB_REDIRECT_URI=http://127.0.0.1:8000/v1/auth/github/callback
export IRIS_PROVIDER_DEFAULT=bedrock
export BEDROCK_REGION=us-east-1
export BEDROCK_DEFAULT_MODEL=anthropic.claude-3-5-sonnet-20241022-v2:0
```

Bedrock uses the standard AWS credential chain. You can set `AWS_PROFILE`, or direct AWS credential environment variables.

OpenRouter can be used instead:

```bash
export IRIS_PROVIDER_DEFAULT=openrouter
export OPENROUTER_API_KEY=...
export OPENROUTER_DEFAULT_MODEL=anthropic/claude-3.5-sonnet
```

The pipeline fails a session with `provider_not_configured` when no provider is configured, which keeps production tests from silently passing without model execution.
