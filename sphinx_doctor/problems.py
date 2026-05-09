# sphinx_doctor/problems.py

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def load_diagnostics_json(path: Path) -> dict[str, Any]:
    """Load one enriched diagnostics contract from disk."""
    return json.loads(path.read_text())


def normalize_problem_severity(severity: str) -> str:
    """Normalize contract severities to VS Code problem-matcher severities."""
    lowered = severity.lower()
    if lowered == "error":
        return "error"
    if lowered == "warning":
        return "warning"
    return "info"


def _sortable_issue_key(issue: dict[str, Any]) -> tuple[str, int, int, str, str]:
    source_range = issue.get("sourceRange") or {}
    return (
        str(issue.get("repoRelativePath") or ""),
        int(source_range.get("startLine") or 0),
        int(source_range.get("startColumn") or 0),
        str(issue.get("category") or ""),
        str(issue.get("id") or ""),
    )


def _one_based(value: int | None) -> int:
    if value is None:
        return 1
    if value <= 0:
        return 1
    return value


def _format_issue_line(issue: dict[str, Any]) -> str:
    source_range = issue["sourceRange"]
    file_path = str(issue["repoRelativePath"])
    line = _one_based(int(source_range["startLine"]))
    column = _one_based(int(source_range["startColumn"]))
    severity = normalize_problem_severity(str(issue["severity"]))
    category = str(issue["category"])
    message = str(issue["message"])
    object_name = str(issue.get("objectName") or "")
    object_suffix = f" ({object_name})" if object_name else ""
    return f"{file_path}:{line}:{column}: {severity}: [{category}] {message}{object_suffix}"


def render_vscode_problem_output(
    payload: dict[str, Any],
    *,
    include_skipped_summary: bool = False,
) -> str:
    """Render deterministic problem-matcher-friendly output for VS Code Tasks."""
    issues = payload.get("issues", [])
    rendered_lines: list[str] = []
    skipped_count = 0

    for issue in sorted(issues, key=_sortable_issue_key):
        if not issue.get("publishDiagnostic"):
            skipped_count += 1
            continue

        source_range = issue.get("sourceRange")
        repo_relative_path = issue.get("repoRelativePath")
        if source_range is None or not repo_relative_path:
            skipped_count += 1
            continue

        rendered_lines.append(_format_issue_line(issue))

    if include_skipped_summary:
        rendered_lines.append(f"# skipped issues: {skipped_count}")

    return "\n".join(rendered_lines) + ("\n" if rendered_lines else "")