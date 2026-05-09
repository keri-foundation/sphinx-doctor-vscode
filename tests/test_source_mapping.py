# tests/test_source_mapping.py

from __future__ import annotations

from pathlib import Path
import unittest

from sphinx_doctor.source_mapping import map_issue_to_source, resolve_host


ROOT = Path(__file__).resolve().parent.parent
SOURCE_ROOT = ROOT / "fixtures/source/keripy"
REPO_PATH = "src/keri/core/coring.py"
SOURCE_FILE = SOURCE_ROOT / REPO_PATH


class SourceMappingTests(unittest.TestCase):
    def test_class_mapping_is_high_when_docstring_line_exists(self) -> None:
        result = map_issue_to_source(SOURCE_ROOT, REPO_PATH, "keri.core.coring.Number", 6)

        self.assertEqual(result.confidence, "high")
        self.assertIsNotNone(result.source_range)
        self.assertEqual(result.source_range.anchor_kind, "docstring-line")

    def test_class_mapping_falls_back_when_docstring_line_is_out_of_range(self) -> None:
        result = map_issue_to_source(SOURCE_ROOT, REPO_PATH, "keri.core.coring.Tholder", 11)

        self.assertEqual(result.confidence, "low")
        self.assertIsNotNone(result.source_range)
        self.assertEqual(result.source_range.anchor_kind, "docstring-block")

    def test_missing_object_is_retained_as_unmapped(self) -> None:
        result = map_issue_to_source(SOURCE_ROOT, REPO_PATH, "keri.core.coring.MissingThing", 3)

        self.assertEqual(result.confidence, "none")
        self.assertIsNone(result.source_range)

    def test_method_like_object_resolution_works(self) -> None:
        host = resolve_host(SOURCE_FILE, REPO_PATH, "keri.core.coring.Number.__init__")

        self.assertIsNotNone(host)
        self.assertEqual(host.kind, "function")