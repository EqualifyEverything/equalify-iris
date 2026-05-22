from __future__ import annotations

import json
import unittest

from equalify_iris.providers import BedrockProvider, CompletionRequest, ImageInput


class FakeBedrockClient:
    def __init__(self) -> None:
        self.request = None

    def converse(self, **kwargs):
        self.request = kwargs
        return {
            "output": {
                "message": {
                    "content": [{"text": json.dumps({"ok": True})}],
                }
            }
        }


class BedrockProviderTests(unittest.TestCase):
    def test_converse_request_includes_text_schema_and_image_blocks(self) -> None:
        client = FakeBedrockClient()
        provider = BedrockProvider(
            region="us-east-1",
            default_model="anthropic.claude-3-5-sonnet-20241022-v2:0",
            client=client,
        )

        result = provider.complete(
            CompletionRequest(
                capability="vision",
                messages=[
                    {"role": "system", "content": "System prompt"},
                    {"role": "user", "content": "Describe the image."},
                ],
                images=[ImageInput(filename="page.png", mime_type="image/png", data=b"png")],
                schema={"type": "object", "properties": {"ok": {"type": "boolean"}}},
            )
        )

        self.assertEqual(json.loads(result.content), {"ok": True})
        self.assertEqual(client.request["modelId"], "anthropic.claude-3-5-sonnet-20241022-v2:0")
        self.assertEqual(client.request["system"], [{"text": "System prompt"}])
        content = client.request["messages"][0]["content"]
        self.assertEqual(content[0], {"text": "Describe the image."})
        self.assertIn("JSON Schema", content[1]["text"])
        self.assertEqual(content[2]["image"]["format"], "png")
        self.assertEqual(content[2]["image"]["source"]["bytes"], b"png")


if __name__ == "__main__":
    unittest.main()
