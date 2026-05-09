# tests/test_enrich_fixtures.py

from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from sphinx_doctor.cli import main


ROOT = Path(__file__).resolve().parent.parent
RAW_FIXTURE = ROOT / "fixtures/raw/keripy-coring-unexpected-indentation.sample.json"
SOURCE_ROOT = ROOT / "fixtures/source/keripy"


class EnrichFixtureTests(unittest.TestCase):
    def _run_cli(self) -> dict[str, object]:
        with tempfile.TemporaryDirectory() as directory_name:
            output_path = Path(directory_name) / "output.json"
            exit_code = main(
                [
                    "enrich",
                    "--raw-issues",
                    str(RAW_FIXTURE),
                    "--source-root",
                    str(SOURCE_ROOT),
                    "--inventory-root",
                    str(ROOT),
                    "--project-id",
                    "keripy",
                    "--source-workspace-folder",
                    "02-keripy",
                    "--inventory-workspace-folder",
                    "01-keri-notes",
                    "--repo-root",
                    ".",
                    "--docs-root",
                    "docs",
                    "--mirror-root",
                    ".sphinx-diagnostics",
                    "--run-id",
                    "fixture-run-001",
                    "--generated-at",
                    "2026-05-08T18:28:00Z",
                    "--tool-version",
                    "0.1.0",
                    "--out",
                    str(output_path),
                ]
            )
            self.assertEqual(exit_code, 0)
            return json.loads(output_path.read_text())

    def test_cli_transforms_fixture(self) -> None:
        payload = self._run_cli()

        self.assertEqual(payload["schema"], "sphinx-diagnostics-v1")
        self.assertEqual(payload["schemaVersion"], 1)
        self.assertEqual(payload["summary"]["total"], 3)
        self.assertEqual(payload["summary"]["mappedCount"], 2)
        self.assertEqual(payload["summary"]["unmappedCount"], 1)
        self.assertEqual(len(payload["issues"]), 3)

    def test_multi_root_metadata_is_preserved(self) -> None:
        payload = self._run_cli()

        self.assertEqual(payload["workspace"]["sourceWorkspaceFolder"], "02-keripy")
        self.assertEqual(payload["workspace"]["inventoryWorkspaceFolder"], "01-keri-notes")
        self.assertEqual(payload["workspace"]["mirrorRoot"], ".sphinx-diagnostics")

    def test_output_is_deterministic(self) -> None:
        first = self._run_cli()
        second = self._run_cli()
        self.assertEqual(first, second)