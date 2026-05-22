from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from equalify_iris.pipeline import Pipeline
from equalify_iris.providers import CompletionRequest, CompletionResult, ProviderRegistry
from equalify_iris.storage import Storage


class ScriptedProvider:
    name = "scripted"
    capabilities = ("text", "vision", "structured_output")

    def complete(self, request: CompletionRequest) -> CompletionResult:
        system = str(request.messages[0]["content"])
        user = str(request.messages[-1]["content"])

        if "Image Analysis Agent" in system:
            return _result(
                {
                    "content_types": ["paragraph"],
                    "fragment_indicators": {
                        "top-edge": "none",
                        "bottom-edge": "none",
                        "left-edge": "none",
                        "right-edge": "none",
                    },
                    "agent_calls": ["paragraph.md"],
                    "downstream_notes": ["One paragraph is visible."],
                }
            )

        if "Paragraph Agent" in system:
            return _result(
                {
                    "no_content": False,
                    "html_fragment": "<p>Accessible test paragraph.</p>",
                    "fragment_log": {"edges": "none"},
                }
            )

        if "Reconciliation Agent" in system:
            fragments = json.loads(user)["fragments"]
            return _result({"fragments": fragments, "notes": []})

        if "Reader Agent" in system:
            return _result({"issues": []})

        return _result({"replacements": []})


def _result(payload: dict[str, Any]) -> CompletionResult:
    return CompletionResult(content=json.dumps(payload), raw={"scripted": True})


class PipelineTests(unittest.TestCase):
    def test_pipeline_fails_without_model_provider(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            storage = Storage(root / "iris.sqlite3")
            storage.upsert_account(123, "tester")
            session = storage.create_session(123, image_count=1, iterations_max=3)
            session_id = session["session_id"]

            input_dir = root / "sessions" / session_id / "input"
            input_dir.mkdir(parents=True)
            (input_dir / "page-001.png").write_bytes(b"png")
            (input_dir / "manifest.json").write_text(json.dumps(["page-001.png"]), encoding="utf-8")

            pipeline = Pipeline(storage, root / "agents", root / "sessions", root / "tmp")
            pipeline.run(session_id)

            updated = storage.get_session_for_user(session_id, 123)
            self.assertIsNotNone(updated)
            self.assertEqual(updated["status"], "failed")

            log = (root / "sessions" / session_id / "log.jsonl").read_text(encoding="utf-8")
            self.assertIn("provider_not_configured", log)

    def test_pipeline_writes_required_session_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            agents_dir = root / "agents"
            agents_dir.mkdir()
            (agents_dir / "paragraph.md").write_text(
                "\n".join(
                    [
                        "# Paragraph Agent",
                        "",
                        "## Purpose",
                        "Convert paragraph text.",
                        "",
                        "## Required capability",
                        "vision, structured_output",
                        "",
                        "## System prompt",
                        "Return paragraph HTML.",
                        "",
                        "## Output contract",
                        "Return accessible HTML.",
                        "",
                    ]
                ),
                encoding="utf-8",
            )

            storage = Storage(root / "iris.sqlite3")
            storage.upsert_account(123, "tester")
            session = storage.create_session(123, image_count=1, iterations_max=3)
            session_id = session["session_id"]

            session_dir = root / "sessions" / session_id
            input_dir = session_dir / "input"
            input_dir.mkdir(parents=True)
            (input_dir / "page-001.png").write_bytes(b"png")
            (input_dir / "manifest.json").write_text(json.dumps(["page-001.png"]), encoding="utf-8")

            registry = ProviderRegistry([ScriptedProvider()])
            pipeline = Pipeline(storage, agents_dir, root / "sessions", root / "tmp", registry)
            pipeline.run(session_id)

            updated = storage.get_session_for_user(session_id, 123)
            self.assertIsNotNone(updated)
            self.assertEqual(updated["status"], "ready_for_review")
            self.assertTrue((session_dir / "notes" / "page-001.md").exists())
            self.assertTrue((session_dir / "fragments" / "001-page-001-paragraph.html").exists())
            self.assertTrue((session_dir / "output.html").exists())
            self.assertTrue((session_dir / "log.jsonl").exists())
            self.assertTrue((session_dir / "new-agents.md").exists())
            self.assertIn("Accessible test paragraph.", (session_dir / "output.html").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
