# sphinx_doctor/cli.py

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Sequence

from sphinx_doctor.contract import contract_to_json
from sphinx_doctor.enrich import EnrichConfig, enrich_contract
from sphinx_doctor.paths import ensure_parent
from sphinx_doctor.problems import load_diagnostics_json, render_vscode_problem_output


def build_parser() -> argparse.ArgumentParser:
    """Build the Sphinx Doctor CLI parser."""
    parser = argparse.ArgumentParser(prog="python3 -m sphinx_doctor.cli")
    subparsers = parser.add_subparsers(dest="command", required=True)

    enrich_parser = subparsers.add_parser("enrich")
    enrich_parser.add_argument("--raw-issues", required=True)
    enrich_parser.add_argument("--source-root", required=True)
    enrich_parser.add_argument("--inventory-root", required=True)
    enrich_parser.add_argument("--project-id", required=True)
    enrich_parser.add_argument("--source-workspace-folder", required=True)
    enrich_parser.add_argument("--inventory-workspace-folder", required=True)
    enrich_parser.add_argument("--repo-root", required=True)
    enrich_parser.add_argument("--docs-root", required=True)
    enrich_parser.add_argument("--mirror-root", required=True)
    enrich_parser.add_argument("--out", required=True)
    enrich_parser.add_argument("--run-id")
    enrich_parser.add_argument("--generated-at")
    enrich_parser.add_argument("--tool-version")

    problems_parser = subparsers.add_parser("problems")
    problems_parser.add_argument("--diagnostics-json", required=True)
    problems_parser.add_argument("--format", required=True, choices=["vscode"])
    problems_parser.add_argument("--include-skipped-summary", action="store_true")

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the CLI and write the requested enriched contract."""
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "problems":
        payload = load_diagnostics_json(Path(args.diagnostics_json))
        output = render_vscode_problem_output(
            payload,
            include_skipped_summary=bool(args.include_skipped_summary),
        )
        print(output, end="")
        return 0

    if args.command != "enrich":
        parser.error("Unsupported command")

    config = EnrichConfig(
        raw_issues=Path(args.raw_issues),
        source_root=Path(args.source_root),
        inventory_root=Path(args.inventory_root),
        project_id=args.project_id,
        source_workspace_folder=args.source_workspace_folder,
        inventory_workspace_folder=args.inventory_workspace_folder,
        repo_root=args.repo_root,
        docs_root=args.docs_root,
        mirror_root=args.mirror_root,
        out=Path(args.out),
        run_id=args.run_id,
        generated_at=args.generated_at,
        tool_version=args.tool_version,
    )

    payload = enrich_contract(config)
    ensure_parent(config.out)
    config.out.write_text(contract_to_json(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())