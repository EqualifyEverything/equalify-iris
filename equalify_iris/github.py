from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .config import Config
from .errors import APIError


class GitHubClient:
    def __init__(self, config: Config) -> None:
        self.config = config
        self._user_cache: dict[str, dict[str, Any]] = {}

    def oauth_start_url(self, state: str) -> str:
        self._require_client_id()
        params = urllib.parse.urlencode(
            {
                "client_id": self.config.github_client_id,
                "redirect_uri": self.config.github_redirect_uri,
                "scope": self.config.github_scope,
                "state": state,
            }
        )
        return f"https://github.com/login/oauth/authorize?{params}"

    def exchange_code(self, code: str) -> dict[str, Any]:
        self._require_client_secret()
        payload = {
            "client_id": self.config.github_client_id,
            "client_secret": self.config.github_client_secret,
            "code": code,
            "redirect_uri": self.config.github_redirect_uri,
        }
        response = self._request_json(
            "POST",
            "https://github.com/login/oauth/access_token",
            payload,
            headers={"Accept": "application/json"},
        )

        access_token = response.get("access_token")
        if not access_token:
            raise APIError("unauthorized", "GitHub did not return an access token.", 401, response)

        user = self.identify_token(access_token)
        return {
            "access_token": access_token,
            "token_type": response.get("token_type", "bearer"),
            "scope": response.get("scope"),
            "github_login": user["login"],
            "github_user_id": user["id"],
        }

    def start_device_flow(self) -> dict[str, Any]:
        self._require_client_id()
        payload = {
            "client_id": self.config.github_client_id,
            "scope": self.config.github_scope,
        }
        return self._request_json(
            "POST",
            "https://github.com/login/device/code",
            payload,
            headers={"Accept": "application/json"},
        )

    def poll_device_flow(self, device_code: str) -> dict[str, Any]:
        self._require_client_id()
        payload = {
            "client_id": self.config.github_client_id,
            "device_code": device_code,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        }
        response = self._request_json(
            "POST",
            "https://github.com/login/oauth/access_token",
            payload,
            headers={"Accept": "application/json"},
        )

        if "error" in response:
            raise APIError(response["error"], response.get("error_description", response["error"]), 400)

        access_token = response.get("access_token")
        if not access_token:
            raise APIError("unauthorized", "GitHub did not return an access token.", 401, response)

        user = self.identify_token(access_token)
        return {
            "access_token": access_token,
            "token_type": response.get("token_type", "bearer"),
            "scope": response.get("scope"),
            "github_login": user["login"],
            "github_user_id": user["id"],
        }

    def identify_token(self, token: str) -> dict[str, Any]:
        cached = self._user_cache.get(token)
        if cached:
            return cached

        try:
            user = self._request_json(
                "GET",
                "https://api.github.com/user",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )
        except APIError as exc:
            if exc.status in {401, 403}:
                raise APIError("unauthorized", "GitHub token could not be authenticated.", 401)
            raise

        if "id" not in user or "login" not in user:
            raise APIError("unauthorized", "GitHub token response did not include a user.", 401)

        self._user_cache[token] = user
        return user

    def _require_client_id(self) -> None:
        if not self.config.github_client_id:
            raise APIError("configuration_missing", "GITHUB_CLIENT_ID is required for GitHub OAuth.", 500)

    def _require_client_secret(self) -> None:
        self._require_client_id()
        if not self.config.github_client_secret:
            raise APIError("configuration_missing", "GITHUB_CLIENT_SECRET is required for GitHub OAuth.", 500)

    def _request_json(
        self,
        method: str,
        url: str,
        payload: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        body = None
        request_headers = {"User-Agent": "equalify-iris"}
        request_headers.update(headers or {})

        if payload is not None:
            body = urllib.parse.urlencode(payload).encode("utf-8")
            request_headers.setdefault("Content-Type", "application/x-www-form-urlencoded")

        request = urllib.request.Request(url, data=body, headers=request_headers, method=method)

        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            details = _read_error_details(exc)
            raise APIError("github_error", "GitHub returned an error.", exc.code, details)
        except urllib.error.URLError as exc:
            raise APIError("github_unreachable", "Could not reach GitHub.", 502, {"reason": str(exc.reason)})

        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise APIError("github_invalid_response", "GitHub returned invalid JSON.", 502, {"error": str(exc)})

        if not isinstance(parsed, dict):
            raise APIError("github_invalid_response", "GitHub returned an unexpected response.", 502)

        return parsed


def _read_error_details(exc: urllib.error.HTTPError) -> dict[str, Any]:
    try:
        raw = exc.read().decode("utf-8")
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {"body": raw}
    except Exception:
        return {"status": exc.code}
