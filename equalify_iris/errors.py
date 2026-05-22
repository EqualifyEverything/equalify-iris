from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class APIError(Exception):
    code: str
    message: str
    status: int
    details: dict[str, Any] = field(default_factory=dict)

    def body(self) -> dict[str, Any]:
        return {
            "error": {
                "code": self.code,
                "message": self.message,
                "details": self.details,
            }
        }
