# sphinx_doctor/contract.py

from __future__ import annotations

from collections import OrderedDict
from hashlib import sha256
import json
from pathlib import PurePosixPath
import re
from typing import Any


SCHEMA_NAME = "sphinx-diagnostics-v1"
SCHEMA_VERSION = 1


def _slug(value: str) -> str:
    sanitized = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return sanitized or "unknown"


def build_issue_id(
    project_id: str,
    repo_relative_path: str | None,
    object_name: str | None,
    category: str,
    docstring_line: int | None,
    message: str,
) -> str:
    """Build a deterministic issue identifier from stable issue fields."""
    stable_payload = "|".join(
        [
            project_id,
            repo_relative_path or "",
            object_name or "",
            category,
            str(docstring_line or ""),
            message,
        ]
    )
    digest = sha256(stable_payload.encode("utf-8")).hexdigest()[:12]
    name_token = object_name.split(".")[-1] if object_name else PurePosixPath(repo_relative_path or "unknown").stem
    return f"{_slug(project_id)}-{_slug(name_token)}-{_slug(category)}-{digest}"


def build_summary(issues: list[dict[str, Any]]) -> dict[str, Any]:
    """Build deterministic top-level summary counts."""
    by_severity: OrderedDict[str, int] = OrderedDict()
    by_category: OrderedDict[str, int] = OrderedDict()
    mapped_count = 0
    unmapped_count = 0
    published_diagnostics = 0
    retained_only = 0

    for issue in issues:
        severity = str(issue["severity"])
        category = str(issue["category"])
        by_severity[severity] = by_severity.get(severity, 0) + 1
        by_category[category] = by_category.get(category, 0) + 1

        if issue["mapping"]["confidence"] == "none":
            unmapped_count += 1
        else:
            mapped_count += 1

        if issue["publishDiagnostic"]:
            published_diagnostics += 1
        else:
            retained_only += 1

    return {
        "total": len(issues),
        "bySeverity": dict(by_severity),
        "byCategory": dict(by_category),
        "mappedCount": mapped_count,
        "unmappedCount": unmapped_count,
        "publishedDiagnostics": published_diagnostics,
        "retainedOnly": retained_only,
    }


def contract_to_json(payload: dict[str, Any]) -> str:
    """Serialize the enriched contract deterministically."""
    return json.dumps(payload, indent=2, ensure_ascii=False) + "\n"