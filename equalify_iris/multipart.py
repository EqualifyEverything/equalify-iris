from __future__ import annotations

import re
from dataclasses import dataclass

from .errors import APIError


@dataclass
class MultipartPart:
    name: str
    filename: str | None
    content_type: str | None
    data: bytes


def parse_multipart(content_type: str, body: bytes) -> list[MultipartPart]:
    match = re.search(r'boundary="?([^";]+)"?', content_type)
    if not match:
        raise APIError("invalid_request", "Multipart boundary is missing.", 400)

    boundary = f"--{match.group(1)}".encode("utf-8")
    parts: list[MultipartPart] = []

    for chunk in body.split(boundary):
        chunk = chunk.strip()
        if not chunk or chunk == b"--":
            continue
        if chunk.endswith(b"--"):
            chunk = chunk[:-2].strip()

        try:
            header_blob, data = chunk.split(b"\r\n\r\n", 1)
        except ValueError:
            raise APIError("invalid_request", "Malformed multipart part.", 400)

        headers = _parse_headers(header_blob.decode("utf-8", errors="replace"))
        disposition = headers.get("content-disposition", "")
        name = _disposition_value(disposition, "name")
        filename = _disposition_value(disposition, "filename")

        if not name:
            raise APIError("invalid_request", "Multipart part is missing a name.", 400)

        if data.endswith(b"\r\n"):
            data = data[:-2]

        parts.append(
            MultipartPart(
                name=name,
                filename=filename,
                content_type=headers.get("content-type"),
                data=data,
            )
        )

    return parts


def _parse_headers(header_blob: str) -> dict[str, str]:
    headers: dict[str, str] = {}
    for line in header_blob.split("\r\n"):
        if ":" not in line:
            continue
        name, value = line.split(":", 1)
        headers[name.strip().lower()] = value.strip()
    return headers


def _disposition_value(disposition: str, key: str) -> str | None:
    match = re.search(rf'{key}="([^"]*)"', disposition)
    return match.group(1) if match else None
