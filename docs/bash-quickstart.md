# Bash API Quickstart

These commands exercise the PRD v1 API from a shell.

## 1. Configure

Run these in the shell where you will start the API:

```bash
export IRIS_HOST=127.0.0.1
export IRIS_PORT=8000
export IRIS_DATA_DIR=.

export GITHUB_CLIENT_ID=...
export GITHUB_CLIENT_SECRET=...
export GITHUB_REDIRECT_URI=http://127.0.0.1:8000/v1/auth/github/callback

export IRIS_PROVIDER_DEFAULT=bedrock
export BEDROCK_REGION=us-east-1
export BEDROCK_DEFAULT_MODEL=anthropic.claude-3-5-sonnet-20241022-v2:0
```

Bedrock uses the standard AWS credential chain. For example:

```bash
export AWS_PROFILE=your-profile
```

Or use `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optionally `AWS_SESSION_TOKEN`.

Start the API:

```bash
python3 -m equalify_iris
```

In another shell:

```bash
export API=http://127.0.0.1:8000
```

Verify the API is reachable. This should return `401 Unauthorized` because no token was sent:

```bash
curl -sS -i "$API/v1/me"
```

## 2. Authenticate With GitHub Device Flow

Start device auth:

```bash
DEVICE_JSON=$(curl -fsS -X POST "$API/v1/auth/github/device")
printf '%s\n' "$DEVICE_JSON"
```

Extract the device values:

```bash
eval "$(
  printf '%s' "$DEVICE_JSON" | python3 -c '
import json, shlex, sys
d = json.load(sys.stdin)
print("DEVICE_CODE=" + shlex.quote(d["device_code"]))
print("USER_CODE=" + shlex.quote(d["user_code"]))
print("VERIFICATION_URI=" + shlex.quote(d["verification_uri"]))
print("INTERVAL=" + shlex.quote(str(d.get("interval", 5))))
'
)"
```

Open the verification URL and enter the user code:

```bash
printf 'Open: %s\nCode: %s\n' "$VERIFICATION_URI" "$USER_CODE"
```

Poll until GitHub returns an access token:

```bash
while :; do
  POLL_JSON=$(
    curl -sS -X POST "$API/v1/auth/github/device/poll" \
      -H 'Content-Type: application/json' \
      -d "{\"device_code\":\"$DEVICE_CODE\"}"
  )

  TOKEN=$(
    printf '%s' "$POLL_JSON" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(d.get("access_token", ""))
'
  )

  if [ -n "$TOKEN" ]; then
    export TOKEN
    break
  fi

  ERROR=$(
    printf '%s' "$POLL_JSON" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(d.get("error", {}).get("code", d.get("error", "")) if isinstance(d.get("error"), dict) else d.get("error", ""))
'
  )

  if [ "$ERROR" != "authorization_pending" ] && [ "$ERROR" != "slow_down" ]; then
    printf '%s\n' "$POLL_JSON"
    exit 1
  fi

  sleep "$INTERVAL"
done
```

Confirm the authenticated user:

```bash
curl -fsS "$API/v1/me" \
  -H "Authorization: Bearer $TOKEN"
```

## 3. Create A Session

Set image paths in the order they should be processed:

```bash
IMAGE_1=/absolute/path/to/page-001.png
IMAGE_2=/absolute/path/to/page-002.png
```

Create the session:

```bash
SESSION_JSON=$(
  curl -fsS -X POST "$API/v1/sessions" \
    -H "Authorization: Bearer $TOKEN" \
    -F "images=@$IMAGE_1" \
    -F "images=@$IMAGE_2" \
    -F 'config={"max_review_iterations":3}'
)

SESSION_ID=$(
  printf '%s' "$SESSION_JSON" | python3 -c '
import json, sys
print(json.load(sys.stdin)["session_id"])
'
)

printf 'Session: %s\n' "$SESSION_ID"
```

## 4. Poll Status

```bash
while :; do
  STATUS_JSON=$(
    curl -fsS "$API/v1/sessions/$SESSION_ID" \
      -H "Authorization: Bearer $TOKEN"
  )

  STATUS=$(
    printf '%s' "$STATUS_JSON" | python3 -c '
import json, sys
print(json.load(sys.stdin)["status"])
'
  )

  PHASE=$(
    printf '%s' "$STATUS_JSON" | python3 -c '
import json, sys
print(json.load(sys.stdin).get("phase", ""))
'
  )

  printf 'status=%s phase=%s\n' "$STATUS" "$PHASE"

  if [ "$STATUS" = "ready_for_review" ] || [ "$STATUS" = "failed" ] || [ "$STATUS" = "closed" ]; then
    printf '%s\n' "$STATUS_JSON"
    break
  fi

  sleep 5
done
```

If the session failed, inspect logs:

```bash
curl -fsS "$API/v1/sessions/$SESSION_ID/logs" \
  -H "Authorization: Bearer $TOKEN"
```

## 5. Download Output

When status is `ready_for_review`:

```bash
curl -fsS "$API/v1/sessions/$SESSION_ID/output" \
  -H "Authorization: Bearer $TOKEN" \
  -o output.html
```

## 6. Submit Feedback

```bash
curl -fsS -X POST "$API/v1/sessions/$SESSION_ID/feedback" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"feedback":"Keep footnotes structurally distinct from body text."}'
```

After feedback, poll status again with the command in step 4.

## 7. Close The Session

For a production test that does not open contribution PRs:

```bash
curl -fsS -X POST "$API/v1/sessions/$SESSION_ID/close?skip_prs=true" \
  -H "Authorization: Bearer $TOKEN"
```

Fetch final logs:

```bash
curl -fsS "$API/v1/sessions/$SESSION_ID/logs" \
  -H "Authorization: Bearer $TOKEN"
```
