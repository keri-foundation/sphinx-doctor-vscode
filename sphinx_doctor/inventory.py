# sphinx_doctor/inventory.py

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any


def _pick(mapping: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in mapping:
            return mapping[key]
    return None


@dataclass(frozen=True)
class RawIssue:
    """Normalized raw issue representation for enrichment."""

    path: str | None
    category: str
    code: str
    message: str
    severity: str
    object_name: str | None
    object_kind: str | None
    docstring_line: int | None
    raw_location: str
    raw: dict[str, Any]


@dataclass(frozen=True)
class RawInventory:
    """Normalized top-level raw inventory representation."""

    generated_at: str | None
    workspace: dict[str, Any]
    run: dict[str, Any]
    issues: list[RawIssue]


def _normalize_issue(issue: dict[str, Any]) -> RawIssue:
    path = _pick(issue, "path", "source_file", "repoRelativePath")
    object_name = _pick(issue, "object_name", "objectName")
    object_kind = _pick(issue, "object_kind", "objectKind")
    docstring_line = _pick(issue, "docstring_line", "line", "docstringLine")
    raw_location = _pick(issue, "raw_location", "rawLocation")

    if raw_location is None:
        path_token = path or "<unknown>"
        object_token = object_name or "<unknown>"
        line_token = docstring_line if docstring_line is not None else "?"
        raw_location = f"{path_token}:{object_token}:docstring:{line_token}"

    raw_payload = _pick(issue, "raw")
    if not isinstance(raw_payload, dict):
        raw_payload = dict(issue)

    normalized_line: int | None
    if isinstance(docstring_line, int):
        normalized_line = docstring_line
    else:
        normalized_line = None

    return RawIssue(
        path=path if isinstance(path, str) else None,
        category=str(_pick(issue, "category") or "unknown"),
        code=str(_pick(issue, "code") or _pick(issue, "category") or "unknown"),
        message=str(_pick(issue, "message") or ""),
        severity=str(_pick(issue, "severity") or "warning").lower(),
        object_name=object_name if isinstance(object_name, str) else None,
        object_kind=object_kind if isinstance(object_kind, str) else None,
        docstring_line=normalized_line,
        raw_location=str(raw_location),
        raw=raw_payload,
    )


def load_raw_inventory(path: Path) -> RawInventory:
    """Load and normalize a raw inventory-style JSON file."""
    payload = json.loads(path.read_text())
    issues = [_normalize_issue(issue) for issue in payload.get("issues", [])]
    workspace = payload.get("workspace", {})
    run = payload.get("run", {})

    return RawInventory(
        generated_at=payload.get("generatedAt"),
        workspace=workspace if isinstance(workspace, dict) else {},
        run=run if isinstance(run, dict) else {},
        issues=issues,
    )