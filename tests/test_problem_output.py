# tests/test_problem_output.py

from __future__ import annotations

import tempfile
from pathlib import Path
import unittest

from sphinx_doctor.cli import main
from sphinx_doctor.problems import normalize_problem_severity, render_vscode_problem_output


ROOT = Path(__file__).resolve().parent.parent
RAW_FIXTURE = ROOT / "fixtures/raw/keripy-coring-unexpected-indentation.sample.json"
SOURCE_ROOT = ROOT / "fixtures/source/keripy"


class ProblemOutputTests(unittest.TestCase):
    def _create_diagnostics_file(self) -> Path:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        output_path = Path(directory.name) / "output.json"
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
                "example-workspace",
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
        return output_path

    def test_problem_output_includes_publishable_mapped_issues(self) -> None:
        output_path = self._create_diagnostics_file()
        with output_path.open() as file_pointer:
            payload = __import__("json").load(file_pointer)

        lines = render_vscode_problem_output(payload).strip().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertIn("src/keri/core/coring.py:13:5: error:", lines[0])
        self.assertIn("src/keri/core/coring.py:30:5: error:", lines[1])

    def test_problem_output_skips_unmapped_retained_issue(self) -> None:
        output_path = self._create_diagnostics_file()
        with output_path.open() as file_pointer:
            payload = __import__("json").load(file_pointer)

        output = render_vscode_problem_output(payload)
        self.assertNotIn("MissingThing", output)

    def test_severity_normalization(self) -> None:
        self.assertEqual(normalize_problem_severity("error"), "error")
        self.assertEqual(normalize_problem_severity("warning"), "warning")
        self.assertEqual(normalize_problem_severity("information"), "info")
        self.assertEqual(normalize_problem_severity("hint"), "info")

    def test_ordering_is_deterministic(self) -> None:
        output_path = self._create_diagnostics_file()
        with output_path.open() as file_pointer:
            payload = __import__("json").load(file_pointer)

        first = render_vscode_problem_output(payload)
        second = render_vscode_problem_output(payload)
        self.assertEqual(first, second)

    def test_cli_problems_command_emits_one_based_positions(self) -> None:
        output_path = self._create_diagnostics_file()
        with tempfile.TemporaryDirectory() as directory_name:
            problems_path = Path(directory_name) / "problems.txt"
            import contextlib
            import io

            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                exit_code = main(
                    [
                        "problems",
                        "--diagnostics-json",
                        str(output_path),
                        "--format",
                        "vscode",
                    ]
                )
            self.assertEqual(exit_code, 0)
            problems_path.write_text(buffer.getvalue())

            lines = problems_path.read_text().strip().splitlines()

        self.assertEqual(lines[0], "src/keri/core/coring.py:13:5: error: [unexpected-indentation] Unexpected indentation in autodoc docstring block. (keri.core.coring.Number)")
        self.assertEqual(lines[1], "src/keri/core/coring.py:30:5: error: [unexpected-indentation] Unexpected indentation in autodoc docstring block. (keri.core.coring.Tholder)")