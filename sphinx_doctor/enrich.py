# sphinx_doctor/enrich.py

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sphinx_doctor.contract import SCHEMA_NAME, SCHEMA_VERSION, build_issue_id, build_summary
from sphinx_doctor.inventory import RawInventory, RawIssue, load_raw_inventory
from sphinx_doctor.source_mapping import map_issue_to_source


@dataclass(frozen=True)
class EnrichConfig:
    """CLI-supplied configuration for one enrichment run."""

    raw_issues: Path
    source_root: Path
    inventory_root: Path
    project_id: str
    source_workspace_folder: str
    inventory_workspace_folder: str
    repo_root: str
    docs_root: str
    mirror_root: str
    out: Path
    run_id: str | None = None
    generated_at: str | None = None
    tool_version: str | None = None


def _default_generated_at() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _top_level_run(config: EnrichConfig, inventory: RawInventory) -> dict[str, str]:
    run = inventory.run
    inventory_file = str(run.get("inventoryFile") or config.raw_issues.name)
    inventory_dir = str(run.get("inventoryDir") or Path(inventory_file).parent.as_posix())
    return {
        "id": config.run_id or str(run.get("id") or "run-unknown"),
        "source": "external-inventory",
        "inventoryFile": inventory_file,
        "inventoryDir": inventory_dir,
    }


def _enrich_issue(
    config: EnrichConfig,
    inventory_file: str,
    raw_issue: RawIssue,
) -> dict[str, Any]:
    mapping = map_issue_to_source(
        source_root=config.source_root,
        repo_relative_path=raw_issue.path,
        object_name=raw_issue.object_name,
        docstring_line=raw_issue.docstring_line,
    )

    issue_id = build_issue_id(
        project_id=config.project_id,
        repo_relative_path=raw_issue.path,
        object_name=raw_issue.object_name,
        category=raw_issue.category,
        docstring_line=raw_issue.docstring_line,
        message=raw_issue.message,
    )

    return {
        "id": issue_id,
        "severity": raw_issue.severity,
        "category": raw_issue.category,
        "code": raw_issue.code,
        "target": raw_issue.target,
        "refDomain": raw_issue.ref_domain,
        "refType": raw_issue.ref_type,
        "candidates": raw_issue.candidates,
        "message": raw_issue.message,
        "raw": raw_issue.raw,
        "objectName": raw_issue.object_name,
        "objectKind": raw_issue.object_kind or mapping.resolved_kind,
        "docstringLine": raw_issue.docstring_line,
        "sourceWorkspaceFolder": config.source_workspace_folder,
        "inventoryWorkspaceFolder": config.inventory_workspace_folder,
        "repoRelativePath": raw_issue.path,
        "inventoryRelativePath": inventory_file,
        "rawLocation": raw_issue.raw_location,
        "sourceRange": mapping.source_range.to_dict() if mapping.source_range else None,
        "mapping": {
            "confidence": mapping.confidence,
            "strategy": mapping.strategy,
            "reason": mapping.reason,
            "objectResolved": mapping.object_resolved,
            "lineResolved": mapping.line_resolved,
        },
        "publishDiagnostic": mapping.confidence != "none",
        "related": [
            {
                "label": "raw inventory issue",
                "path": inventory_file,
            }
        ],
    }


def enrich_contract(config: EnrichConfig) -> dict[str, Any]:
    """Return one enriched diagnostics contract from the raw inventory file."""
    inventory = load_raw_inventory(config.raw_issues)
    run = _top_level_run(config, inventory)
    inventory_file = run["inventoryFile"]

    issues = [
        _enrich_issue(config=config, inventory_file=inventory_file, raw_issue=raw_issue)
        for raw_issue in inventory.issues
    ]

    return {
        "schema": SCHEMA_NAME,
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": config.generated_at or inventory.generated_at or _default_generated_at(),
        "tool": {
            "name": "sphinx-doctor-enricher",
            "version": config.tool_version or "0.1.0",
        },
        "workspace": {
            "sourceWorkspaceFolder": config.source_workspace_folder,
            "inventoryWorkspaceFolder": config.inventory_workspace_folder,
            "repoRoot": config.repo_root,
            "docsRoot": config.docs_root,
            "mirrorRoot": config.mirror_root,
        },
        "run": run,
        "summary": build_summary(issues),
        "issues": issues,
    }