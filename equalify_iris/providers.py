from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from .config import Config


Capability = str


@dataclass(frozen=True)
class CompletionRequest:
    capability: Capability
    messages: list[dict[str, Any]]
    images: list["ImageInput"] | None = None
    schema: dict[str, Any] | None = None
    max_tokens: int | None = None


@dataclass(frozen=True)
class CompletionResult:
    content: str
    raw: dict[str, Any] | None = None


@dataclass(frozen=True)
class ImageInput:
    filename: str
    mime_type: str
    data: bytes


class ModelProvider(Protocol):
    name: str
    capabilities: tuple[Capability, ...]

    def complete(self, request: CompletionRequest) -> CompletionResult:
        """Run a model completion for the requested capability."""


class ProviderNotConfigured(RuntimeError):
    def __init__(self, capability: Capability, agent_name: str) -> None:
        super().__init__(
            f"No model provider is configured for capability '{capability}' required by '{agent_name}'."
        )
        self.capability = capability
        self.agent_name = agent_name


class ProviderRegistry:
    """Provider selection boundary described in PRD section 10.3."""

    def __init__(self, providers: list[ModelProvider] | None = None, per_agent: dict[str, str] | None = None) -> None:
        self.providers = providers or []
        self.per_agent = per_agent or {}

    def require(self, capability: Capability, agent_name: str) -> ModelProvider:
        preferred = self.per_agent.get(agent_name)
        if preferred:
            for provider in self.providers:
                if provider.name == preferred and capability in provider.capabilities:
                    return provider

        for provider in self.providers:
            if capability in provider.capabilities:
                return provider
        raise ProviderNotConfigured(capability, agent_name)


class ProviderCallError(RuntimeError):
    def __init__(self, provider: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.provider = provider
        self.details = details or {}


class OpenRouterProvider:
    name = "openrouter"
    capabilities = ("text", "vision", "structured_output")

    def __init__(
        self,
        api_key: str,
        default_model: str,
        per_capability: dict[str, str] | None = None,
        site_url: str | None = None,
        app_name: str | None = None,
    ) -> None:
        self.api_key = api_key
        self.default_model = default_model
        self.per_capability = per_capability or {}
        self.site_url = site_url
        self.app_name = app_name

    def complete(self, request: CompletionRequest) -> CompletionResult:
        model = self.per_capability.get(request.capability, self.default_model)
        payload: dict[str, Any] = {
            "model": model,
            "messages": _messages_with_images(request.messages, request.images or []),
            "temperature": 0,
        }

        if request.max_tokens is not None:
            payload["max_tokens"] = request.max_tokens

        if request.schema is not None:
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": "equalify_iris_response",
                    "strict": True,
                    "schema": request.schema,
                },
            }

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        if self.site_url:
            headers["HTTP-Referer"] = self.site_url
        if self.app_name:
            headers["X-Title"] = self.app_name

        raw = _post_json("https://openrouter.ai/api/v1/chat/completions", payload, headers, self.name)
        content = _choice_content(raw)
        return CompletionResult(content=content, raw=raw)


def provider_registry_from_config(config: "Config") -> ProviderRegistry:
    providers: list[ModelProvider] = []
    if config.openrouter_api_key:
        providers.append(
            OpenRouterProvider(
                api_key=config.openrouter_api_key,
                default_model=config.openrouter_default_model,
                per_capability={
                    "text": config.openrouter_text_model,
                    "vision": config.openrouter_vision_model,
                    "structured_output": config.openrouter_structured_model,
                },
                site_url=config.openrouter_site_url,
                app_name=config.openrouter_app_name,
            )
        )
    return ProviderRegistry(providers=providers, per_agent=config.provider_per_agent)


def _messages_with_images(messages: list[dict[str, Any]], images: list[ImageInput]) -> list[dict[str, Any]]:
    copied = [dict(message) for message in messages]
    if not images:
        return copied

    image_parts = [
        {
            "type": "image_url",
            "image_url": {
                "url": f"data:{image.mime_type};base64,{base64.b64encode(image.data).decode('ascii')}"
            },
        }
        for image in images
    ]

    for message in reversed(copied):
        if message.get("role") == "user":
            content = message.get("content", "")
            text_parts = content if isinstance(content, list) else [{"type": "text", "text": str(content)}]
            message["content"] = text_parts + image_parts
            return copied

    copied.append({"role": "user", "content": image_parts})
    return copied


def _post_json(url: str, payload: dict[str, Any], headers: dict[str, str], provider: str) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        details = _error_details(exc)
        raise ProviderCallError(provider, f"{provider} returned HTTP {exc.code}.", details)
    except urllib.error.URLError as exc:
        raise ProviderCallError(provider, f"Could not reach {provider}.", {"reason": str(exc.reason)})

    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ProviderCallError(provider, f"{provider} returned invalid JSON.", {"error": str(exc)})

    if not isinstance(parsed, dict):
        raise ProviderCallError(provider, f"{provider} returned an unexpected response.")
    return parsed


def _choice_content(response: dict[str, Any]) -> str:
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices:
        raise ProviderCallError("openrouter", "Response did not include choices.", response)

    message = choices[0].get("message")
    if not isinstance(message, dict):
        raise ProviderCallError("openrouter", "Response did not include a message.", response)

    content = message.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(part.get("text", "")) for part in content if isinstance(part, dict))

    raise ProviderCallError("openrouter", "Response message content was not text.", response)


def _error_details(exc: urllib.error.HTTPError) -> dict[str, Any]:
    try:
        raw = exc.read().decode("utf-8")
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {"body": raw}
    except Exception:
        return {"status": exc.code}
