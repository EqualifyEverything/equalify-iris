from __future__ import annotations

import json
import re
import secrets
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from .config import Config
from .errors import APIError
from .github import GitHubClient
from .multipart import MultipartPart, parse_multipart
from .pipeline import Pipeline
from .providers import provider_registry_from_config
from .storage import Storage


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp"}
SESSION_ROUTE = re.compile(r"^/v1/sessions/([^/]+)(?:/(output|feedback|close|logs))?$")


class IrisApp:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.storage = Storage(config.db_path)
        self.github = GitHubClient(config)
        self.pipeline = Pipeline(
            self.storage,
            config.agents_dir,
            config.sessions_dir,
            config.tmp_dir,
            provider_registry_from_config(config),
        )

        config.agents_dir.mkdir(parents=True, exist_ok=True)
        config.sessions_dir.mkdir(parents=True, exist_ok=True)
        config.tmp_dir.mkdir(parents=True, exist_ok=True)

    def handle(self, handler: "IrisHandler") -> None:
        parsed = urlparse(handler.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        method = handler.command

        try:
            if method == "GET" and path == "/v1/auth/github/start":
                self._auth_start(handler)
                return
            if method == "GET" and path == "/v1/auth/github/callback":
                self._auth_callback(handler, query)
                return
            if method == "POST" and path == "/v1/auth/github/device":
                self._auth_device(handler)
                return
            if method == "POST" and path == "/v1/auth/github/device/poll":
                self._auth_device_poll(handler)
                return
            if method == "GET" and path == "/v1/me":
                self._get_me(handler)
                return
            if path == "/v1/sessions":
                if method == "GET":
                    self._list_sessions(handler, query)
                    return
                if method == "POST":
                    self._create_session(handler)
                    return

            match = SESSION_ROUTE.match(path)
            if match:
                session_id, action = match.groups()
                self._handle_session_route(handler, method, query, session_id, action)
                return

            raise APIError("not_found", "Endpoint not found.", 404)
        except APIError as exc:
            handler.send_json(exc.status, exc.body())
        except Exception as exc:
            error = APIError("internal_error", "Internal server error.", 500, {"error": str(exc)})
            handler.send_json(error.status, error.body())

    def _auth_start(self, handler: "IrisHandler") -> None:
        state = secrets.token_urlsafe(24)
        handler.send_redirect(self.github.oauth_start_url(state))

    def _auth_callback(self, handler: "IrisHandler", query: dict[str, list[str]]) -> None:
        code = _first(query, "code")
        if not code:
            raise APIError("invalid_request", "Missing GitHub OAuth code.", 400)

        response = self.github.exchange_code(code)
        self.storage.upsert_account(response["github_user_id"], response["github_login"])
        handler.send_json(200, response)

    def _auth_device(self, handler: "IrisHandler") -> None:
        handler.read_body()
        handler.send_json(200, self.github.start_device_flow())

    def _auth_device_poll(self, handler: "IrisHandler") -> None:
        body = handler.read_json()
        device_code = body.get("device_code")
        if not isinstance(device_code, str) or not device_code:
            raise APIError("invalid_request", "device_code is required.", 400)

        response = self.github.poll_device_flow(device_code)
        self.storage.upsert_account(response["github_user_id"], response["github_login"])
        handler.send_json(200, response)

    def _get_me(self, handler: "IrisHandler") -> None:
        user = self._require_user(handler)
        account = self.storage.get_account(user["id"])
        handler.send_json(
            200,
            {
                "github_login": user["login"],
                "github_user_id": user["id"],
                "upstream_repo": self.config.upstream_repo,
                "fork_repo": account["fork_repo"] if account else None,
                "defaults": {"max_review_iterations": self.config.default_max_review_iterations},
            },
        )

    def _list_sessions(self, handler: "IrisHandler", query: dict[str, list[str]]) -> None:
        user = self._require_user(handler)
        status = _first(query, "status")
        limit = _int_query(query, "limit", 20)
        cursor = _first(query, "cursor")
        sessions, next_cursor = self.storage.list_sessions(user["id"], status, limit, cursor)
        handler.send_json(
            200,
            {
                "sessions": [_public_session_summary(session) for session in sessions],
                "next_cursor": next_cursor,
            },
        )

    def _create_session(self, handler: "IrisHandler") -> None:
        user = self._require_user(handler)
        content_type = handler.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            raise APIError("invalid_request", "POST /v1/sessions requires multipart/form-data.", 400)

        parts = parse_multipart(content_type, handler.read_body())
        images = [part for part in parts if part.name == "images"]
        if not images:
            raise APIError("invalid_request", "At least one images part is required.", 400)

        config_part = next((part for part in parts if part.name == "config"), None)
        run_config = _parse_run_config(config_part)
        iterations_max = _iterations_max(run_config, self.config.default_max_review_iterations)

        session = self.storage.create_session(user["id"], len(images), iterations_max)
        session_id = session["session_id"]
        session_dir = self.config.sessions_dir / session_id
        input_dir = session_dir / "input"
        input_dir.mkdir(parents=True, exist_ok=True)
        (session_dir / "notes").mkdir(parents=True, exist_ok=True)
        (session_dir / "fragments").mkdir(parents=True, exist_ok=True)
        (self.config.tmp_dir / session_id / "agents").mkdir(parents=True, exist_ok=True)

        ordered_names = _write_images(input_dir, images)
        (input_dir / "manifest.json").write_text(json.dumps(ordered_names, indent=2) + "\n", encoding="utf-8")
        (session_dir / "config.json").write_text(json.dumps(run_config, indent=2) + "\n", encoding="utf-8")

        self.pipeline.start(session_id)
        handler.send_json(201, _public_create_session(session))

    def _handle_session_route(
        self,
        handler: "IrisHandler",
        method: str,
        query: dict[str, list[str]],
        session_id: str,
        action: str | None,
    ) -> None:
        if action is None and method == "GET":
            self._get_session(handler, session_id)
            return
        if action == "output" and method == "GET":
            self._get_output(handler, session_id)
            return
        if action == "feedback" and method == "POST":
            self._post_feedback(handler, session_id)
            return
        if action == "close" and method == "POST":
            self._close_session(handler, query, session_id)
            return
        if action == "logs" and method == "GET":
            self._get_logs(handler, session_id)
            return
        raise APIError("not_found", "Endpoint not found.", 404)

    def _get_session(self, handler: "IrisHandler", session_id: str) -> None:
        user = self._require_user(handler)
        session = self._session_or_404(session_id, user["id"])
        response = _public_session_detail(session)
        if session["status"] == "ready_for_review":
            response["pending_prs"] = {"new_agents": [], "agent_updates": []}
        handler.send_json(200, response)

    def _get_output(self, handler: "IrisHandler", session_id: str) -> None:
        user = self._require_user(handler)
        session = self._session_or_404(session_id, user["id"])
        if session["status"] not in {"ready_for_review", "closed"}:
            raise APIError("invalid_state", "Output is available only after the session is ready for review.", 409)

        output_path = self.config.sessions_dir / session_id / "output.html"
        if not output_path.exists():
            raise APIError("output_not_found", "Session output was not found.", 404)

        handler.send_text(200, output_path.read_text(encoding="utf-8"), "text/html; charset=utf-8")

    def _post_feedback(self, handler: "IrisHandler", session_id: str) -> None:
        user = self._require_user(handler)
        session = self._session_or_404(session_id, user["id"])
        if session["status"] != "ready_for_review":
            raise APIError("invalid_state", "Feedback can be submitted only when the session is ready for review.", 409)

        body = handler.read_json()
        feedback = body.get("feedback")
        if not isinstance(feedback, str) or not feedback.strip():
            raise APIError("invalid_request", "feedback is required.", 400)

        self.storage.update_session(session_id, status="running", phase="triage", iterations_completed=0)
        self.pipeline.start(session_id, feedback.strip())
        handler.send_json(202, {"session_id": session_id, "status": "running", "phase": "triage"})

    def _close_session(self, handler: "IrisHandler", query: dict[str, list[str]], session_id: str) -> None:
        user = self._require_user(handler)
        session = self._session_or_404(session_id, user["id"])
        if session["status"] != "ready_for_review":
            raise APIError("invalid_state", "Only sessions ready for review can be closed.", 409)

        skip_prs = _first(query, "skip_prs") == "true"
        prs_opened: list[dict[str, Any]] = []
        prs_path = self.config.sessions_dir / session_id / "prs.md"
        if skip_prs:
            prs_path.write_text("# Pull Requests\n\nSkipped by request.\n", encoding="utf-8")
        else:
            prs_path.write_text(
                "# Pull Requests\n\nNo pull requests were opened because this session did not generate agent contributions.\n",
                encoding="utf-8",
            )

        self.pipeline.close(session_id)
        self.storage.update_session(session_id, status="closed", phase="done")
        handler.send_json(200, {"session_id": session_id, "status": "closed", "prs_opened": prs_opened})

    def _get_logs(self, handler: "IrisHandler", session_id: str) -> None:
        user = self._require_user(handler)
        self._session_or_404(session_id, user["id"])
        log_path = self.config.sessions_dir / session_id / "log.jsonl"
        content = log_path.read_text(encoding="utf-8") if log_path.exists() else ""
        handler.send_text(200, content, "application/x-ndjson; charset=utf-8")

    def _require_user(self, handler: "IrisHandler") -> dict[str, Any]:
        authorization = handler.headers.get("Authorization", "")
        prefix = "Bearer "
        if not authorization.startswith(prefix):
            raise APIError("unauthorized", "Authorization bearer token is required.", 401)

        token = authorization[len(prefix) :].strip()
        if not token:
            raise APIError("unauthorized", "Authorization bearer token is required.", 401)

        user = self.github.identify_token(token)
        self.storage.upsert_account(user["id"], user["login"])
        return user

    def _session_or_404(self, session_id: str, github_user_id: int) -> dict[str, Any]:
        session = self.storage.get_session_for_user(session_id, github_user_id)
        if not session:
            raise APIError("session_not_found", "Session not found.", 404)
        return session


class IrisHandler(BaseHTTPRequestHandler):
    app: IrisApp

    def do_GET(self) -> None:
        self.app.handle(self)

    def do_POST(self) -> None:
        self.app.handle(self)

    def log_message(self, format: str, *args: Any) -> None:
        return

    def read_body(self) -> bytes:
        length_header = self.headers.get("Content-Length", "0")
        try:
            length = int(length_header)
        except ValueError:
            raise APIError("invalid_request", "Invalid Content-Length.", 400)
        return self.rfile.read(length)

    def read_json(self) -> dict[str, Any]:
        raw = self.read_body()
        if not raw:
            return {}
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise APIError("invalid_request", "Request body must be valid JSON.", 400, {"error": str(exc)})
        if not isinstance(parsed, dict):
            raise APIError("invalid_request", "Request JSON must be an object.", 400)
        return parsed

    def send_json(self, status: int, body: dict[str, Any]) -> None:
        raw = json.dumps(body, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def send_text(self, status: int, body: str, content_type: str) -> None:
        raw = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def send_redirect(self, location: str) -> None:
        self.send_response(HTTPStatus.FOUND)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()


def run_server(config: Config) -> None:
    app = IrisApp(config)
    Handler = type("Handler", (IrisHandler,), {})
    Handler.app = app
    server = ThreadingHTTPServer((config.host, config.port), Handler)
    print(f"Equalify Iris API listening on http://{config.host}:{config.port}", flush=True)
    server.serve_forever()


def _first(query: dict[str, list[str]], name: str) -> str | None:
    values = query.get(name)
    return values[0] if values else None


def _int_query(query: dict[str, list[str]], name: str, default: int) -> int:
    value = _first(query, name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        raise APIError("invalid_request", f"{name} must be an integer.", 400)


def _parse_run_config(config_part: MultipartPart | None) -> dict[str, Any]:
    if config_part is None or not config_part.data:
        return {}

    try:
        parsed = json.loads(config_part.data.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise APIError("invalid_request", "config must be valid JSON.", 400, {"error": str(exc)})

    if not isinstance(parsed, dict):
        raise APIError("invalid_request", "config must be a JSON object.", 400)
    return parsed


def _iterations_max(run_config: dict[str, Any], default: int) -> int:
    value = run_config.get("max_review_iterations", default)
    if not isinstance(value, int) or value < 0:
        raise APIError("invalid_request", "max_review_iterations must be a non-negative integer.", 400)
    return value


def _write_images(input_dir: Path, images: list[MultipartPart]) -> list[str]:
    ordered_names: list[str] = []
    used_names: set[str] = set()

    for index, image in enumerate(images, start=1):
        filename = _safe_filename(image.filename or f"image-{index:03d}")
        extension = Path(filename).suffix.lower()
        if extension not in IMAGE_EXTENSIONS:
            raise APIError(
                "invalid_request",
                "Images must be PNG, JPEG, TIFF, or WebP files.",
                400,
                {"filename": filename},
            )

        final_name = _deduplicate(filename, used_names)
        used_names.add(final_name)
        (input_dir / final_name).write_bytes(image.data)
        ordered_names.append(final_name)

    return ordered_names


def _safe_filename(filename: str) -> str:
    basename = Path(filename).name.strip()
    return basename or "image"


def _deduplicate(filename: str, used_names: set[str]) -> str:
    if filename not in used_names:
        return filename

    path = Path(filename)
    stem = path.stem
    suffix = path.suffix
    counter = 2
    while True:
        candidate = f"{stem}-{counter}{suffix}"
        if candidate not in used_names:
            return candidate
        counter += 1


def _public_create_session(session: dict[str, Any]) -> dict[str, Any]:
    return {
        "session_id": session["session_id"],
        "status": session["status"],
        "image_count": session["image_count"],
        "created_at": session["created_at"],
    }


def _public_session_summary(session: dict[str, Any]) -> dict[str, Any]:
    return {
        "session_id": session["session_id"],
        "status": session["status"],
        "image_count": session["image_count"],
        "created_at": session["created_at"],
        "updated_at": session["updated_at"],
    }


def _public_session_detail(session: dict[str, Any]) -> dict[str, Any]:
    return {
        "session_id": session["session_id"],
        "status": session["status"],
        "phase": session["phase"],
        "iterations_completed": session["iterations_completed"],
        "iterations_max": session["iterations_max"],
        "image_count": session["image_count"],
        "created_at": session["created_at"],
        "updated_at": session["updated_at"],
    }
