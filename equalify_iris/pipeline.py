from __future__ import annotations

import html
import json
import mimetypes
import re
import shutil
import subprocess
import threading
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from .providers import CompletionRequest, ImageInput, ProviderCallError, ProviderNotConfigured, ProviderRegistry
from .storage import Storage
from .timeutil import utc_now


INITIAL_AGENT_FILES = {
    "paragraph.md",
    "heading.md",
    "list.md",
    "table.md",
    "formField.md",
    "image.md",
    "quote.md",
    "caption.md",
    "footnote.md",
}


class Pipeline:
    def __init__(
        self,
        storage: Storage,
        agents_dir: Path,
        sessions_dir: Path,
        tmp_dir: Path,
        providers: ProviderRegistry | None = None,
    ) -> None:
        self.storage = storage
        self.agents_dir = agents_dir
        self.sessions_dir = sessions_dir
        self.tmp_dir = tmp_dir
        self.providers = providers or ProviderRegistry()

    def start(self, session_id: str, feedback: str | None = None) -> None:
        thread = threading.Thread(target=self.run, args=(session_id, feedback), daemon=True)
        thread.start()

    def run(self, session_id: str, feedback: str | None = None) -> None:
        session = self.storage.get_session(session_id)
        session_dir = self.sessions_dir / session_id
        log_path = session_dir / "log.jsonl"

        if not session:
            Storage.log_event(log_path, {"time": utc_now(), "event": "run_failed", "error": "Session not found."})
            return

        try:
            self.storage.update_session(session_id, status="running", phase="triage", iterations_completed=0)
            Storage.log_event(log_path, {"time": utc_now(), "event": "run_started", "feedback": feedback})

            image_paths = _load_image_paths(session_dir / "input")
            if not image_paths:
                raise PipelineError("invalid_input", "Session has no input images.", "triage")

            notes = self._triage(session_id, image_paths, feedback)

            self.storage.update_session(session_id, phase="extraction")
            fragments, no_content = self._extract(session_id, image_paths, notes)

            self.storage.update_session(session_id, phase="reconciliation")
            fragments = self._reconcile(session_id, fragments)

            self.storage.update_session(session_id, phase="assembly")
            document = self._assemble(session_id, fragments)

            self.storage.update_session(session_id, phase="review")
            document, issues, iterations = self._review(
                session_id,
                document,
                image_paths,
                no_content,
                max_iterations=int(session["iterations_max"]),
            )

            (session_dir / "output.html").write_text(document, encoding="utf-8")
            _write_summary_files(session_dir, issues)
            self.storage.update_session(
                session_id,
                status="ready_for_review",
                phase="done",
                iterations_completed=iterations,
            )
            Storage.log_event(log_path, {"time": utc_now(), "event": "run_completed", "issues_remaining": issues})
        except ProviderNotConfigured as exc:
            self._fail(
                session_id,
                log_path,
                "provider_not_configured",
                str(exc),
                "triage",
                {"capability": exc.capability, "agent": exc.agent_name},
            )
        except ProviderCallError as exc:
            self._fail(session_id, log_path, "provider_call_failed", str(exc), "done", exc.details)
        except PipelineError as exc:
            self._fail(session_id, log_path, exc.code, str(exc), exc.phase, exc.details)
        except Exception as exc:
            self._fail(session_id, log_path, "pipeline_failed", str(exc), "done")

    def close(self, session_id: str) -> None:
        tmp_session = self.tmp_dir / session_id
        if tmp_session.exists():
            shutil.rmtree(tmp_session)

    def _triage(self, session_id: str, image_paths: list[Path], feedback: str | None) -> list[dict[str, Any]]:
        provider = self.providers.require("vision", "image_analysis")
        session_dir = self.sessions_dir / session_id
        notes_dir = session_dir / "notes"
        log_path = session_dir / "log.jsonl"
        notes_dir.mkdir(parents=True, exist_ok=True)
        notes: list[dict[str, Any]] = []

        for order, image_path in enumerate(image_paths, start=1):
            result = provider.complete(
                CompletionRequest(
                    capability="vision",
                    messages=[
                        {
                            "role": "system",
                            "content": TRIAGE_SYSTEM_PROMPT,
                        },
                        {
                            "role": "user",
                            "content": "\n".join(
                                [
                                    f"Image filename: {image_path.name}",
                                    f"Image order: {order}",
                                    f"Available content agents: {', '.join(sorted(INITIAL_AGENT_FILES))}",
                                    f"User feedback: {feedback or ''}",
                                ]
                            ),
                        },
                    ],
                    images=[_image_input(image_path)],
                    schema=TRIAGE_SCHEMA,
                )
            )
            parsed = _json_object(result.content)
            note = _normalize_note(image_path.name, order, parsed)
            notes.append(note)
            _write_note(notes_dir / f"{image_path.stem}.md", note)
            Storage.log_event(
                log_path,
                {
                    "time": utc_now(),
                    "event": "agent_call",
                    "phase": "triage",
                    "agent": "image_analysis",
                    "provider": provider.name,
                    "image": image_path.name,
                    "output": note,
                },
            )

        return notes

    def _extract(
        self,
        session_id: str,
        image_paths: list[Path],
        notes: list[dict[str, Any]],
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        fragments_dir = self.sessions_dir / session_id / "fragments"
        log_path = self.sessions_dir / session_id / "log.jsonl"
        fragments_dir.mkdir(parents=True, exist_ok=True)
        fragments: list[dict[str, Any]] = []
        no_content: list[dict[str, Any]] = []

        for image_path, note in zip(image_paths, notes, strict=True):
            for agent_name in note["agent_calls"]:
                agent_path = self._agent_path(session_id, agent_name)
                if not agent_path:
                    agent_path = self._build_agent(session_id, agent_name, image_path, note)

                agent_markdown = agent_path.read_text(encoding="utf-8")
                capability = _runtime_capability(agent_markdown)
                provider = self.providers.require(capability, agent_path.stem)
                result = provider.complete(
                    CompletionRequest(
                        capability=capability,
                        messages=[
                            {"role": "system", "content": _content_agent_system_prompt(agent_markdown)},
                            {
                                "role": "user",
                                "content": "\n".join(
                                    [
                                        f"Source image: {image_path.name}",
                                        "Notes:",
                                        _note_markdown(note),
                                    ]
                                ),
                            },
                        ],
                        images=[_image_input(image_path)] if capability == "vision" else None,
                        schema=CONTENT_AGENT_SCHEMA,
                    )
                )
                parsed = _json_object(result.content)
                if bool(parsed.get("no_content")):
                    entry = {"image": image_path.name, "agent": agent_name, "reason": parsed.get("fragment_log", {})}
                    no_content.append(entry)
                    Storage.log_event(log_path, {"time": utc_now(), "event": "no_content", **entry})
                    continue

                source = _source_id(image_path.name, agent_path.stem, len(fragments) + 1)
                html_fragment = _ensure_wrapped_fragment(str(parsed.get("html_fragment", "")), source, agent_name)
                fragment = {
                    "source": source,
                    "agent": agent_name,
                    "image": image_path.name,
                    "html_fragment": html_fragment,
                    "fragment_log": parsed.get("fragment_log", {}),
                }
                fragment_base = f"{len(fragments) + 1:03d}-{image_path.stem}-{agent_path.stem}"
                (fragments_dir / f"{fragment_base}.html").write_text(html_fragment, encoding="utf-8")
                (fragments_dir / f"{fragment_base}.json").write_text(json.dumps(fragment, indent=2) + "\n", encoding="utf-8")
                fragments.append(fragment)
                Storage.log_event(
                    log_path,
                    {
                        "time": utc_now(),
                        "event": "agent_call",
                        "phase": "extraction",
                        "agent": agent_name,
                        "provider": provider.name,
                        "image": image_path.name,
                        "agent_sha": _agent_git_sha(self.agents_dir, agent_path),
                        "inline_agent_content": None if _is_under(agent_path, self.agents_dir) else agent_markdown,
                        "source": source,
                    },
                )

        return fragments, no_content

    def _build_agent(self, session_id: str, agent_name: str, image_path: Path, note: dict[str, Any]) -> Path:
        safe_name = _safe_agent_name(agent_name)
        provider = self.providers.require("vision", "builder")
        result = provider.complete(
            CompletionRequest(
                capability="vision",
                messages=[
                    {"role": "system", "content": BUILDER_SYSTEM_PROMPT},
                    {
                        "role": "user",
                        "content": "\n".join(
                            [
                                f"Requested agent file: {safe_name}",
                                f"Source image: {image_path.name}",
                                "Notes:",
                                _note_markdown(note),
                            ]
                        ),
                    },
                ],
                images=[_image_input(image_path)],
                schema=BUILDER_SCHEMA,
            )
        )
        parsed = _json_object(result.content)
        markdown = str(parsed.get("markdown", "")).strip()
        if not markdown:
            raise PipelineError("agent_build_failed", f"Builder returned no markdown for {safe_name}.", "extraction")

        tmp_agent_dir = self.tmp_dir / session_id / "agents"
        tmp_agent_dir.mkdir(parents=True, exist_ok=True)
        agent_path = tmp_agent_dir / safe_name
        agent_path.write_text(markdown + "\n", encoding="utf-8")

        new_agents_path = self.sessions_dir / session_id / "new-agents.md"
        with new_agents_path.open("a", encoding="utf-8") as file:
            if new_agents_path.stat().st_size == 0:
                file.write("# New Agents\n\n")
            file.write(f"## {safe_name}\n\n")
            file.write(f"{parsed.get('summary', 'Created for content referenced by triage.')}\n\n")
            file.write(f"Triggered by: {image_path.name}\n\n")

        Storage.log_event(
            self.sessions_dir / session_id / "log.jsonl",
            {
                "time": utc_now(),
                "event": "agent_built",
                "agent": safe_name,
                "provider": provider.name,
                "image": image_path.name,
                "inline_agent_content": markdown,
            },
        )
        return agent_path

    def _reconcile(self, session_id: str, fragments: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if len(fragments) < 2:
            return fragments

        provider = self.providers.require("structured_output", "reconciliation")
        result = provider.complete(
            CompletionRequest(
                capability="structured_output",
                messages=[
                    {"role": "system", "content": RECONCILIATION_SYSTEM_PROMPT},
                    {"role": "user", "content": json.dumps({"fragments": fragments}, indent=2)},
                ],
                schema=RECONCILIATION_SCHEMA,
            )
        )
        parsed = _json_object(result.content)
        reconciled = parsed.get("fragments")
        if not isinstance(reconciled, list):
            raise PipelineError("reconciliation_failed", "Reconciliation response did not include fragments.", "reconciliation")

        Storage.log_event(
            self.sessions_dir / session_id / "log.jsonl",
            {
                "time": utc_now(),
                "event": "reconciliation_completed",
                "provider": provider.name,
                "fragment_count": len(reconciled),
                "notes": parsed.get("notes", []),
            },
        )
        return [_normalize_fragment(fragment) for fragment in reconciled]

    def _assemble(self, session_id: str, fragments: list[dict[str, Any]]) -> str:
        document = _html_document([str(fragment["html_fragment"]) for fragment in fragments])
        lint_issues = _lint_html(document)
        Storage.log_event(
            self.sessions_dir / session_id / "log.jsonl",
            {
                "time": utc_now(),
                "event": "assembly_completed",
                "fragment_count": len(fragments),
                "lint_issues": lint_issues,
            },
        )
        return document

    def _review(
        self,
        session_id: str,
        document: str,
        image_paths: list[Path],
        no_content: list[dict[str, Any]],
        max_iterations: int,
    ) -> tuple[str, list[dict[str, Any]], int]:
        issues: list[dict[str, Any]] = []
        iterations = 0

        for iteration in range(max_iterations + 1):
            iterations = iteration
            issues = self._reader_review(session_id, document, no_content)
            if not issues:
                return document, [], iterations
            if iteration >= max_iterations:
                break

            replacements = self._copy_edit(session_id, document, issues, image_paths)
            if not replacements:
                break

            document = _apply_replacements(document, replacements)
            Storage.log_event(
                self.sessions_dir / session_id / "log.jsonl",
                {
                    "time": utc_now(),
                    "event": "assembler_applied_replacements",
                    "iteration": iteration + 1,
                    "replacement_count": len(replacements),
                },
            )

        return _append_unresolved(document, issues), issues, iterations

    def _reader_review(
        self,
        session_id: str,
        document: str,
        no_content: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        provider = self.providers.require("structured_output", "reader")
        lint_issues = _lint_html(document)
        result = provider.complete(
            CompletionRequest(
                capability="structured_output",
                messages=[
                    {"role": "system", "content": READER_SYSTEM_PROMPT},
                    {
                        "role": "user",
                        "content": json.dumps(
                            {
                                "html": document,
                                "text_view": _text_view(document),
                                "lint_issues": lint_issues,
                                "no_content_signals": no_content,
                            },
                            indent=2,
                        ),
                    },
                ],
                schema=READER_SCHEMA,
            )
        )
        parsed = _json_object(result.content)
        issues = parsed.get("issues", [])
        if not isinstance(issues, list):
            raise PipelineError("review_failed", "Reader response did not include an issue list.", "review")

        normalized = [_normalize_issue(issue) for issue in issues]
        Storage.log_event(
            self.sessions_dir / session_id / "log.jsonl",
            {
                "time": utc_now(),
                "event": "reader_reviewed",
                "provider": provider.name,
                "issue_count": len(normalized),
            },
        )
        return normalized

    def _copy_edit(
        self,
        session_id: str,
        document: str,
        issues: list[dict[str, Any]],
        image_paths: list[Path],
    ) -> list[dict[str, str]]:
        provider = self.providers.require("vision", "copy_editor")
        relevant_images = _relevant_images(issues, image_paths)
        result = provider.complete(
            CompletionRequest(
                capability="vision",
                messages=[
                    {"role": "system", "content": COPY_EDITOR_SYSTEM_PROMPT},
                    {
                        "role": "user",
                        "content": json.dumps({"html": document, "issues": issues}, indent=2),
                    },
                ],
                images=[_image_input(path) for path in relevant_images],
                schema=COPY_EDITOR_SCHEMA,
            )
        )
        parsed = _json_object(result.content)
        replacements = parsed.get("replacements", [])
        if not isinstance(replacements, list):
            raise PipelineError("copy_edit_failed", "Copy editor response did not include replacements.", "review")

        normalized = [_normalize_replacement(replacement) for replacement in replacements]
        Storage.log_event(
            self.sessions_dir / session_id / "log.jsonl",
            {
                "time": utc_now(),
                "event": "copy_editor_proposed",
                "provider": provider.name,
                "replacement_count": len(normalized),
            },
        )
        return normalized

    def _agent_path(self, session_id: str, agent_name: str) -> Path | None:
        safe_name = _safe_agent_name(agent_name)
        for path in (self.agents_dir / safe_name, self.tmp_dir / session_id / "agents" / safe_name):
            if path.exists() and path.is_file():
                return path
        return None

    def _fail(
        self,
        session_id: str,
        log_path: Path,
        code: str,
        message: str,
        phase: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        self.storage.update_session(session_id, status="failed", phase=phase)
        Storage.log_event(
            log_path,
            {
                "time": utc_now(),
                "event": "run_failed",
                "code": code,
                "phase": phase,
                "message": message,
                "details": details or {},
            },
        )


class PipelineError(RuntimeError):
    def __init__(self, code: str, message: str, phase: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.phase = phase
        self.details = details or {}


class TextViewParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self.parts.append(f"\nHeading {tag[1]}: ")
        elif tag == "li":
            self.parts.append("\nList item: ")
        elif tag == "th":
            self.parts.append("\nHeader cell: ")
        elif tag == "td":
            self.parts.append("\nCell: ")
        elif tag == "img":
            alt = dict(attrs).get("alt", "")
            self.parts.append(f"\nImage: {alt}")

    def handle_data(self, data: str) -> None:
        text = " ".join(data.split())
        if text:
            self.parts.append(text + " ")


TRIAGE_SYSTEM_PROMPT = """
You are the Equalify Iris Image Analysis Agent. Analyze one source image and return JSON only.
Identify content types present, fragment indicators on each edge, content agent files to call, and notes for downstream agents.
Use existing agent files when they apply. If no existing agent covers a content type, name the missing agent as <contentType>.md.
""".strip()

BUILDER_SYSTEM_PROMPT = """
You are the Equalify Iris Builder Agent. Create one session-scoped content agent markdown file.
The agent must match the PRD content agent contract: purpose, required capability, system prompt, and output contract.
Return JSON only.
""".strip()

CONTENT_AGENT_CONTRACT = """
Return JSON only. If no matching content is present, set no_content to true.
If content is present, return an accessible HTML fragment wrapped with @source and @end-source comments plus a fragment log.
Use semantic HTML only. Do not add CSS, classes, inline styles, or inline event handlers.
""".strip()

RECONCILIATION_SYSTEM_PROMPT = """
You are the Equalify Iris Reconciliation Agent. Review adjacent fragments and conservatively stitch only high-confidence continuations.
Return all final fragments in order. Preserve provenance comments. Mark suspected continuations in comments rather than silently joining uncertain content.
Return JSON only.
""".strip()

READER_SYSTEM_PROMPT = """
You are the Equalify Iris Reader Agent. Review assembled HTML and its text-only view for reading order, semantic consistency, and accessibility issues.
Return JSON only. If there are no issues, return an empty issues array.
""".strip()

COPY_EDITOR_SYSTEM_PROMPT = """
You are the Equalify Iris Copy Editor Agent. Given issues, source images, and current HTML, propose replacement HTML blocks only for flagged sources.
Do not rewrite unrelated blocks. Preserve or update provenance comments.
Return JSON only.
""".strip()


TRIAGE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["content_types", "fragment_indicators", "agent_calls", "downstream_notes"],
    "properties": {
        "content_types": {"type": "array", "items": {"type": "string"}},
        "fragment_indicators": {
            "type": "object",
            "additionalProperties": {"type": "string"},
        },
        "agent_calls": {"type": "array", "items": {"type": "string"}},
        "downstream_notes": {"type": "array", "items": {"type": "string"}},
    },
}

BUILDER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["agent_name", "markdown", "summary"],
    "properties": {
        "agent_name": {"type": "string"},
        "markdown": {"type": "string"},
        "summary": {"type": "string"},
    },
}

CONTENT_AGENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["no_content", "html_fragment", "fragment_log"],
    "properties": {
        "no_content": {"type": "boolean"},
        "html_fragment": {"type": "string"},
        "fragment_log": {"type": "object", "additionalProperties": True},
    },
}

RECONCILIATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["fragments", "notes"],
    "properties": {
        "fragments": {
            "type": "array",
            "items": {"type": "object", "additionalProperties": True},
        },
        "notes": {"type": "array", "items": {"type": "string"}},
    },
}

READER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["issues"],
    "properties": {
        "issues": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["issue", "source", "severity", "suggested_action"],
                "properties": {
                    "issue": {"type": "string"},
                    "source": {"type": "string"},
                    "severity": {"type": "string"},
                    "suggested_action": {"type": "string"},
                },
            },
        }
    },
}

COPY_EDITOR_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["replacements"],
    "properties": {
        "replacements": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["source", "html_fragment"],
                "properties": {
                    "source": {"type": "string"},
                    "html_fragment": {"type": "string"},
                },
            },
        }
    },
}


def _load_image_paths(input_dir: Path) -> list[Path]:
    manifest_path = input_dir / "manifest.json"
    if manifest_path.exists():
        names = json.loads(manifest_path.read_text(encoding="utf-8"))
        return [input_dir / name for name in names]

    return sorted(path for path in input_dir.iterdir() if path.is_file())


def _image_input(path: Path) -> ImageInput:
    mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return ImageInput(filename=path.name, mime_type=mime_type, data=path.read_bytes())


def _json_object(content: str) -> dict[str, Any]:
    content = content.strip()
    if content.startswith("```"):
        content = re.sub(r"^```(?:json)?\s*", "", content)
        content = re.sub(r"\s*```$", "", content)

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", content, re.DOTALL)
        if not match:
            raise PipelineError("invalid_agent_response", "Provider response did not contain JSON.", "review")
        parsed = json.loads(match.group(0))

    if not isinstance(parsed, dict):
        raise PipelineError("invalid_agent_response", "Provider response JSON must be an object.", "review")
    return parsed


def _normalize_note(image_name: str, order: int, parsed: dict[str, Any]) -> dict[str, Any]:
    agent_calls = [_safe_agent_name(name) for name in parsed.get("agent_calls", []) if str(name).strip()]
    if not agent_calls:
        agent_calls = [_agent_for_content_type(name) for name in parsed.get("content_types", []) if str(name).strip()]

    indicators = parsed.get("fragment_indicators", {})
    if not isinstance(indicators, dict):
        indicators = {}

    return {
        "image": image_name,
        "order": order,
        "content_types": [str(item) for item in parsed.get("content_types", [])],
        "fragment_indicators": {
            "top-edge": str(indicators.get("top-edge", indicators.get("top_edge", "none"))),
            "bottom-edge": str(indicators.get("bottom-edge", indicators.get("bottom_edge", "none"))),
            "left-edge": str(indicators.get("left-edge", indicators.get("left_edge", "none"))),
            "right-edge": str(indicators.get("right-edge", indicators.get("right_edge", "none"))),
        },
        "agent_calls": agent_calls,
        "downstream_notes": [str(item) for item in parsed.get("downstream_notes", [])],
    }


def _write_note(path: Path, note: dict[str, Any]) -> None:
    path.write_text(_note_markdown(note), encoding="utf-8")


def _note_markdown(note: dict[str, Any]) -> str:
    lines = [
        "---",
        f"image: {note['image']}",
        f"order: {note['order']}",
        "---",
        "",
        "# Content Types",
    ]
    lines.extend(f"- {item}" for item in note["content_types"])
    lines.extend(["", "# Fragment Indicators"])
    lines.extend(f"- {edge}: {value}" for edge, value in note["fragment_indicators"].items())
    lines.extend(["", "# Agent Calls"])
    lines.extend(f"- {item}" for item in note["agent_calls"])
    lines.extend(["", "# Notes for downstream agents"])
    lines.extend(f"- {item}" for item in note["downstream_notes"])
    lines.append("")
    return "\n".join(lines)


def _content_agent_system_prompt(agent_markdown: str) -> str:
    return agent_markdown.strip() + "\n\n" + CONTENT_AGENT_CONTRACT


def _runtime_capability(agent_markdown: str) -> str:
    required = _required_capabilities(agent_markdown)
    if "vision" in required:
        return "vision"
    if "structured_output" in required:
        return "structured_output"
    return "text"


def _required_capabilities(agent_markdown: str) -> set[str]:
    match = re.search(r"## Required capability\s+(.*?)(?:\n## |\Z)", agent_markdown, re.DOTALL | re.IGNORECASE)
    section = match.group(1).lower() if match else ""
    capabilities = {capability for capability in ("vision", "structured_output", "text") if capability in section}
    return capabilities or {"text"}


def _safe_agent_name(agent_name: str) -> str:
    name = Path(str(agent_name).strip()).name
    if not name.endswith(".md"):
        name += ".md"
    return re.sub(r"[^A-Za-z0-9_.-]", "", name) or "unknown.md"


def _agent_for_content_type(content_type: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9]", "", content_type)
    if not normalized:
        return "paragraph.md"
    candidate = f"{normalized[0].lower()}{normalized[1:]}.md"
    return candidate if candidate in INITIAL_AGENT_FILES else candidate


def _source_id(image_name: str, agent_name: str, index: int) -> str:
    return f"{image_name}#region-{agent_name}-{index}"


def _ensure_wrapped_fragment(fragment: str, source: str, agent_name: str) -> str:
    fragment = fragment.strip()
    if "<!-- @source:" in fragment and "<!-- @end-source -->" in fragment:
        return fragment + "\n"
    return "\n".join(
        [
            f"<!-- @source: {html.escape(source)} -->",
            f"<!-- @agent: {html.escape(agent_name)} -->",
            fragment,
            "<!-- @end-source -->",
            "",
        ]
    )


def _normalize_fragment(fragment: Any) -> dict[str, Any]:
    if not isinstance(fragment, dict):
        raise PipelineError("reconciliation_failed", "Reconciliation returned a non-object fragment.", "reconciliation")
    return {
        "source": str(fragment.get("source", "")),
        "agent": str(fragment.get("agent", "")),
        "image": str(fragment.get("image", "")),
        "html_fragment": str(fragment.get("html_fragment", "")),
        "fragment_log": fragment.get("fragment_log", {}),
    }


def _html_document(fragments: list[str]) -> str:
    return "\n".join(
        [
            "<!doctype html>",
            '<html lang="en">',
            "<head>",
            '  <meta charset="utf-8" />',
            "  <title>Equalify Iris Output</title>",
            "</head>",
            "<body>",
            "<main>",
            *fragments,
            "</main>",
            "</body>",
            "</html>",
            "",
        ]
    )


def _lint_html(document: str) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    if '<html lang="' not in document and "<html lang='" not in document:
        issues.append({"issue": "Document is missing html lang.", "source": "document", "severity": "high"})
    if "<main" not in document:
        issues.append({"issue": "Document is missing main landmark.", "source": "document", "severity": "high"})
    if re.search(r"<img\b(?![^>]*\balt=)", document, re.IGNORECASE):
        issues.append({"issue": "Image is missing alt text.", "source": "document", "severity": "high"})
    if re.search(r"<table\b", document, re.IGNORECASE) and not re.search(r"<caption\b", document, re.IGNORECASE):
        issues.append({"issue": "Table is missing caption.", "source": "document", "severity": "high"})
    return issues


def _text_view(document: str) -> str:
    parser = TextViewParser()
    parser.feed(document)
    return " ".join("".join(parser.parts).split())


def _normalize_issue(issue: Any) -> dict[str, str]:
    if not isinstance(issue, dict):
        return {"issue": str(issue), "source": "document", "severity": "medium", "suggested_action": "Review document."}
    return {
        "issue": str(issue.get("issue", "")),
        "source": str(issue.get("source", "document")),
        "severity": str(issue.get("severity", "medium")),
        "suggested_action": str(issue.get("suggested_action", "Review document.")),
    }


def _normalize_replacement(replacement: Any) -> dict[str, str]:
    if not isinstance(replacement, dict):
        raise PipelineError("copy_edit_failed", "Replacement must be an object.", "review")
    return {
        "source": str(replacement.get("source", "")),
        "html_fragment": str(replacement.get("html_fragment", "")),
    }


def _relevant_images(issues: list[dict[str, Any]], image_paths: list[Path]) -> list[Path]:
    names = {str(issue.get("source", "")).split("#", 1)[0] for issue in issues}
    selected = [path for path in image_paths if path.name in names]
    return selected or image_paths[:1]


def _apply_replacements(document: str, replacements: list[dict[str, str]]) -> str:
    updated = document
    for replacement in replacements:
        source = re.escape(replacement["source"])
        pattern = re.compile(rf"<!-- @source:\s*{source}\s*-->.*?<!-- @end-source -->", re.DOTALL)
        replacement_html = replacement["html_fragment"].strip()
        if not replacement_html:
            continue
        updated, _count = pattern.subn(replacement_html, updated, count=1)
    return updated


def _append_unresolved(document: str, issues: list[dict[str, Any]]) -> str:
    if not issues:
        return document
    items = "\n".join(
        f"<li><strong>{html.escape(issue['severity'])}</strong>: {html.escape(issue['issue'])} ({html.escape(issue['source'])})</li>"
        for issue in issues
    )
    unresolved = "\n".join(["<!-- @unresolved -->", "<section aria-labelledby=\"unresolved-issues\">", "<h2 id=\"unresolved-issues\">Unresolved issues</h2>", "<ul>", items, "</ul>", "</section>"])
    return document.replace("</main>", unresolved + "\n</main>")


def _write_summary_files(session_dir: Path, issues: list[dict[str, Any]]) -> None:
    if not (session_dir / "new-agents.md").exists():
        (session_dir / "new-agents.md").write_text("# New Agents\n\nNo session-built agents were created.\n", encoding="utf-8")
    if not (session_dir / "agent-updates.md").exists():
        (session_dir / "agent-updates.md").write_text("# Agent Updates\n\nNo agent updates were proposed.\n", encoding="utf-8")
    if not (session_dir / "prs.md").exists():
        (session_dir / "prs.md").write_text("# Pull Requests\n\nNo pull requests opened yet.\n", encoding="utf-8")

    if issues:
        lines = ["# Unresolved Issues", ""]
        for issue in issues:
            lines.append(f"- {issue['severity']}: {issue['issue']} ({issue['source']})")
        lines.append("")
        (session_dir / "unresolved.md").write_text("\n".join(lines), encoding="utf-8")
    else:
        (session_dir / "unresolved.md").write_text("# Unresolved Issues\n\nNo unresolved issues.\n", encoding="utf-8")


def _is_under(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def _agent_git_sha(agents_dir: Path, agent_path: Path) -> str | None:
    if not _is_under(agent_path, agents_dir) or not (agents_dir / ".git").exists():
        return None
    try:
        relative = agent_path.resolve().relative_to(agents_dir.resolve())
        result = subprocess.run(
            ["git", "-C", str(agents_dir), "rev-parse", f"HEAD:{relative.as_posix()}"],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        return None
    sha = result.stdout.strip()
    return sha or None
