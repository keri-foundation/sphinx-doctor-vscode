# tests/test_contract_output.py

from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from sphinx_doctor.cli import main
from sphinx_doctor.inventory import load_raw_inventory


ROOT = Path(__file__).resolve().parent.parent
RAW_FIXTURE = ROOT / "fixtures/raw/keripy-coring-unexpected-indentation.sample.json"
SOURCE_ROOT = ROOT / "fixtures/source/keripy"


class ContractOutputTests(unittest.TestCase):
    def test_raw_fixture_loads(self) -> None:
        inventory = load_raw_inventory(RAW_FIXTURE)

        self.assertEqual(len(inventory.issues), 3)
        self.assertEqual(inventory.issues[0].object_name, "keri.core.coring.Number")

    def test_contract_output_contains_expected_issue_states(self) -> None:
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

            payload = json.loads(output_path.read_text())

        by_object = {issue["objectName"]: issue for issue in payload["issues"]}
        number_issue = by_object["keri.core.coring.Number"]
        tholder_issue = by_object["keri.core.coring.Tholder"]
        missing_issue = by_object["keri.core.coring.MissingThing"]

        self.assertTrue(number_issue["publishDiagnostic"])
        self.assertEqual(number_issue["mapping"]["confidence"], "high")
        self.assertIsNotNone(number_issue["sourceRange"])

        self.assertTrue(tholder_issue["publishDiagnostic"])
        self.assertEqual(tholder_issue["mapping"]["confidence"], "low")
        self.assertIsNotNone(tholder_issue["sourceRange"])

        self.assertFalse(missing_issue["publishDiagnostic"])
        self.assertEqual(missing_issue["mapping"]["confidence"], "none")
        self.assertIsNone(missing_issue["sourceRange"])