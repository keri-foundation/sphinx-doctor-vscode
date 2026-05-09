# sphinx_doctor/inventory.py

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import re
from typing import Any


MISSING_REFERENCE_RE = re.compile(
    r"^(?P<ref_domain>[A-Za-z0-9_]+):(?P<ref_type>[A-Za-z0-9_.-]+) reference target not found: (?P<target>.+?) \[(?P<code>[^\]]+)\]$"
)
AMBIGUOUS_REFERENCE_RE = re.compile(
    r"^more than one target found for cross-reference '(?P<target>.+?)': (?P<candidates>.+) \[(?P<code>[^\]]+)\]$"
)
DOCSTRING_LOCATION_RE = re.compile(r"^docstring of (?P<object_name>.+?)(?::)?$")


def _pick(mapping: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in mapping:
            return mapping[key]
    return None


def _normalize_object_name(object_name: Any, location: Any) -> str | None:
    candidate = object_name if isinstance(object_name, str) else None
    if not candidate and isinstance(location, str):
        match = DOCSTRING_LOCATION_RE.match(location.strip())
        if match:
            candidate = match.group("object_name")

    if candidate is None:
        return None

    normalized = candidate.rstrip(":").strip()
    return normalized or None


def _normalize_docstring_line(value: Any) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def _classify_reference_message(
    *,
    category: str,
    code: str | None,
    message: str,
) -> tuple[str, str, str | None, str | None, str | None, list[str] | None]:
    missing_match = MISSING_REFERENCE_RE.match(message)
    if missing_match:
        return (
            "missing-reference",
            missing_match.group("code") if code in (None, "", "unknown", "other", "missing-reference") else code,
            missing_match.group("target"),
            missing_match.group("ref_domain"),
            missing_match.group("ref_type"),
            None,
        )

    ambiguous_match = AMBIGUOUS_REFERENCE_RE.match(message)
    if ambiguous_match:
        candidates = [candidate.strip() for candidate in ambiguous_match.group("candidates").split(",") if candidate.strip()]
        return (
            "ambiguous-reference",
            ambiguous_match.group("code") if code in (None, "", "unknown", "other", "ambiguous-reference") else code,
            ambiguous_match.group("target"),
            None,
            None,
            candidates,
        )

    normalized_code = code or category or "unknown"
    normalized_category = category or "unknown"
    return (normalized_category, normalized_code, None, None, None, None)


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
    target: str | None
    ref_domain: str | None
    ref_type: str | None
    candidates: list[str] | None
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
    location = _pick(issue, "location")
    object_name = _normalize_object_name(_pick(issue, "object_name", "objectName"), location)
    object_kind = _pick(issue, "object_kind", "objectKind")
    docstring_line = _pick(issue, "docstring_line", "line", "docstringLine")
    raw_location = _pick(issue, "raw_location", "rawLocation")
    message = str(_pick(issue, "message") or "")
    category, code, target, ref_domain, ref_type, candidates = _classify_reference_message(
        category=str(_pick(issue, "category") or "unknown"),
        code=str(_pick(issue, "code")) if _pick(issue, "code") is not None else None,
        message=message,
    )

    if raw_location is None:
        path_token = path or "<unknown>"
        object_token = object_name or "<unknown>"
        line_token = docstring_line if docstring_line is not None else "?"
        raw_location = f"{path_token}:{object_token}:docstring:{line_token}"

    raw_payload = _pick(issue, "raw")
    if not isinstance(raw_payload, dict):
        raw_payload = dict(issue)

    normalized_line = _normalize_docstring_line(docstring_line)

    return RawIssue(
        path=path if isinstance(path, str) else None,
        category=category,
        code=code,
        message=message,
        severity=str(_pick(issue, "severity") or "warning").lower(),
        object_name=object_name,
        object_kind=object_kind if isinstance(object_kind, str) else None,
        docstring_line=normalized_line,
        target=target,
        ref_domain=ref_domain,
        ref_type=ref_type,
        candidates=candidates,
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