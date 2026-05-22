from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Config:
    host: str
    port: int
    data_dir: Path
    agents_dir: Path
    sessions_dir: Path
    tmp_dir: Path
    db_path: Path
    github_client_id: str | None
    github_client_secret: str | None
    github_redirect_uri: str
    github_scope: str
    upstream_repo: str | None
    default_max_review_iterations: int
    provider_default: str | None
    provider_per_agent: dict[str, str]
    openrouter_api_key: str | None
    openrouter_default_model: str
    openrouter_text_model: str
    openrouter_vision_model: str
    openrouter_structured_model: str
    openrouter_site_url: str | None
    openrouter_app_name: str | None
    bedrock_region: str | None
    bedrock_default_model: str | None
    bedrock_text_model: str | None
    bedrock_vision_model: str | None
    bedrock_structured_model: str | None

    @classmethod
    def from_env(cls, host: str | None = None, port: int | None = None) -> "Config":
        data_dir = Path(os.getenv("IRIS_DATA_DIR", ".")).resolve()
        agents_dir = Path(os.getenv("IRIS_AGENTS_DIR", data_dir / "agents")).resolve()
        sessions_dir = Path(os.getenv("IRIS_SESSIONS_DIR", data_dir / "sessions")).resolve()
        tmp_dir = Path(os.getenv("IRIS_TMP_DIR", data_dir / "tmp")).resolve()
        db_path = Path(os.getenv("IRIS_DB_PATH", data_dir / "iris.sqlite3")).resolve()

        resolved_host = host or os.getenv("IRIS_HOST", "127.0.0.1")
        resolved_port = port or int(os.getenv("IRIS_PORT", "8000"))
        redirect_uri = os.getenv(
            "GITHUB_REDIRECT_URI",
            f"http://{resolved_host}:{resolved_port}/v1/auth/github/callback",
        )

        return cls(
            host=resolved_host,
            port=resolved_port,
            data_dir=data_dir,
            agents_dir=agents_dir,
            sessions_dir=sessions_dir,
            tmp_dir=tmp_dir,
            db_path=db_path,
            github_client_id=os.getenv("GITHUB_CLIENT_ID") or None,
            github_client_secret=os.getenv("GITHUB_CLIENT_SECRET") or None,
            github_redirect_uri=redirect_uri,
            github_scope="repo",
            upstream_repo=os.getenv("IRIS_UPSTREAM_REPO") or _git_origin(agents_dir),
            default_max_review_iterations=int(os.getenv("IRIS_DEFAULT_MAX_REVIEW_ITERATIONS", "3")),
            provider_default=os.getenv("IRIS_PROVIDER_DEFAULT") or None,
            provider_per_agent=_parse_provider_per_agent(os.getenv("IRIS_PROVIDER_PER_AGENT", "")),
            openrouter_api_key=os.getenv("OPENROUTER_API_KEY") or None,
            openrouter_default_model=os.getenv("OPENROUTER_DEFAULT_MODEL", "anthropic/claude-3.5-sonnet"),
            openrouter_text_model=os.getenv("OPENROUTER_TEXT_MODEL", os.getenv("OPENROUTER_DEFAULT_MODEL", "anthropic/claude-3.5-sonnet")),
            openrouter_vision_model=os.getenv("OPENROUTER_VISION_MODEL", os.getenv("OPENROUTER_DEFAULT_MODEL", "anthropic/claude-3.5-sonnet")),
            openrouter_structured_model=os.getenv("OPENROUTER_STRUCTURED_MODEL", os.getenv("OPENROUTER_DEFAULT_MODEL", "anthropic/claude-3.5-sonnet")),
            openrouter_site_url=os.getenv("OPENROUTER_SITE_URL") or None,
            openrouter_app_name=os.getenv("OPENROUTER_APP_NAME", "Equalify Iris"),
            bedrock_region=os.getenv("BEDROCK_REGION") or os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or None,
            bedrock_default_model=os.getenv("BEDROCK_DEFAULT_MODEL") or None,
            bedrock_text_model=os.getenv("BEDROCK_TEXT_MODEL") or os.getenv("BEDROCK_DEFAULT_MODEL") or None,
            bedrock_vision_model=os.getenv("BEDROCK_VISION_MODEL") or os.getenv("BEDROCK_DEFAULT_MODEL") or None,
            bedrock_structured_model=os.getenv("BEDROCK_STRUCTURED_MODEL") or os.getenv("BEDROCK_DEFAULT_MODEL") or None,
        )


def _git_origin(path: Path) -> str | None:
    if not (path / ".git").exists():
        return None

    try:
        result = subprocess.run(
            ["git", "-C", str(path), "config", "--get", "remote.origin.url"],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        return None

    origin = result.stdout.strip()
    return origin or None


def _parse_provider_per_agent(raw: str) -> dict[str, str]:
    assignments: dict[str, str] = {}
    for item in raw.split(","):
        if not item.strip():
            continue
        if "=" not in item:
            continue
        agent_name, provider_name = item.split("=", 1)
        assignments[agent_name.strip()] = provider_name.strip()
    return assignments
