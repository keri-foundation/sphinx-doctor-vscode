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
    def _run_cli_with_payload(self, raw_payload: dict[str, object]) -> dict[str, object]:
        with tempfile.TemporaryDirectory() as directory_name:
            raw_path = Path(directory_name) / "raw.json"
            output_path = Path(directory_name) / "output.json"
            raw_path.write_text(json.dumps(raw_payload))
            exit_code = main(
                [
                    "enrich",
                    "--raw-issues",
                    str(raw_path),
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

    def test_reference_warnings_are_reclassified_with_reference_metadata(self) -> None:
        payload = self._run_cli_with_payload(
            {
                "issues": [
                    {
                        "severity": "WARNING",
                        "category": "missing-reference",
                        "path": "src/keri/core/coring.py",
                        "line": 6,
                        "location": "docstring of keri.core.coring.Number",
                        "object_name": "keri.core.coring.Number",
                        "message": "py:class reference target not found: socket.socket [ref.class]",
                        "raw": "src/keri/core/coring.py:docstring of keri.core.coring.Number:6: WARNING: py:class reference target not found: socket.socket [ref.class]",
                    },
                    {
                        "severity": "WARNING",
                        "category": "missing-reference",
                        "path": "src/keri/core/coring.py",
                        "line": 6,
                        "location": "docstring of keri.core.coring.Number",
                        "object_name": "keri.core.coring.Number",
                        "message": "py:class reference target not found: ssl.SSLContext [ref.class]",
                        "raw": "src/keri/core/coring.py:docstring of keri.core.coring.Number:6: WARNING: py:class reference target not found: ssl.SSLContext [ref.class]",
                    },
                    {
                        "severity": "WARNING",
                        "category": "missing-reference",
                        "path": "src/keri/core/coring.py",
                        "line": 6,
                        "location": "docstring of keri.core.coring.Number",
                        "object_name": "keri.core.coring.Number",
                        "message": "py:class reference target not found: io.IOBase [ref.class]",
                        "raw": "src/keri/core/coring.py:docstring of keri.core.coring.Number:6: WARNING: py:class reference target not found: io.IOBase [ref.class]",
                    },
                    {
                        "severity": "WARNING",
                        "category": "other",
                        "path": "src/keri/core/coring.py",
                        "line": 6,
                        "location": "docstring of keri.core.coring.Number",
                        "object_name": "keri.core.coring.Number",
                        "message": "more than one target found for cross-reference 'host': hio.core.tcp.clienting.Client.host, hio.core.udp.udping.Peer.host [ref.python]",
                        "raw": "src/keri/core/coring.py:docstring of keri.core.coring.Number:6: WARNING: more than one target found for cross-reference 'host': hio.core.tcp.clienting.Client.host, hio.core.udp.udping.Peer.host [ref.python]",
                    },
                    {
                        "severity": "WARNING",
                        "category": "other",
                        "path": "src/keri/core/coring.py",
                        "line": 6,
                        "location": "docstring of keri.core.coring.Number",
                        "object_name": "keri.core.coring.Number",
                        "message": "more than one target found for cross-reference 'port': hio.core.tcp.clienting.Client.port, hio.core.udp.udping.Peer.port [ref.python]",
                        "raw": "src/keri/core/coring.py:docstring of keri.core.coring.Number:6: WARNING: more than one target found for cross-reference 'port': hio.core.tcp.clienting.Client.port, hio.core.udp.udping.Peer.port [ref.python]",
                    },
                ]
            }
        )

        by_message = {issue["message"]: issue for issue in payload["issues"]}

        socket_issue = by_message["py:class reference target not found: socket.socket [ref.class]"]
        self.assertEqual(socket_issue["category"], "missing-reference")
        self.assertEqual(socket_issue["code"], "ref.class")
        self.assertEqual(socket_issue["target"], "socket.socket")
        self.assertEqual(socket_issue["refDomain"], "py")
        self.assertEqual(socket_issue["refType"], "class")

        ssl_issue = by_message["py:class reference target not found: ssl.SSLContext [ref.class]"]
        self.assertEqual(ssl_issue["code"], "ref.class")
        self.assertEqual(ssl_issue["target"], "ssl.SSLContext")

        io_issue = by_message["py:class reference target not found: io.IOBase [ref.class]"]
        self.assertEqual(io_issue["code"], "ref.class")
        self.assertEqual(io_issue["target"], "io.IOBase")

        host_issue = by_message[
            "more than one target found for cross-reference 'host': hio.core.tcp.clienting.Client.host, hio.core.udp.udping.Peer.host [ref.python]"
        ]
        self.assertEqual(host_issue["category"], "ambiguous-reference")
        self.assertEqual(host_issue["code"], "ref.python")
        self.assertEqual(host_issue["target"], "host")
        self.assertEqual(
            host_issue["candidates"],
            ["hio.core.tcp.clienting.Client.host", "hio.core.udp.udping.Peer.host"],
        )

        port_issue = by_message[
            "more than one target found for cross-reference 'port': hio.core.tcp.clienting.Client.port, hio.core.udp.udping.Peer.port [ref.python]"
        ]
        self.assertEqual(port_issue["category"], "ambiguous-reference")
        self.assertEqual(port_issue["code"], "ref.python")
        self.assertEqual(port_issue["target"], "port")
        self.assertEqual(
            port_issue["candidates"],
            ["hio.core.tcp.clienting.Client.port", "hio.core.udp.udping.Peer.port"],
        )

    def test_low_confidence_and_unmapped_states_remain_honest(self) -> None:
        payload = self._run_cli_with_payload(
            {
                "issues": [
                    {
                        "severity": "WARNING",
                        "category": "missing-reference",
                        "path": "src/keri/core/coring.py",
                        "line": 999,
                        "location": "docstring of keri.core.coring.Tholder",
                        "object_name": "keri.core.coring.Tholder",
                        "message": "py:class reference target not found: io.IOBase [ref.class]",
                        "raw": "src/keri/core/coring.py:docstring of keri.core.coring.Tholder:999: WARNING: py:class reference target not found: io.IOBase [ref.class]",
                    },
                    {
                        "severity": "WARNING",
                        "category": "missing-reference",
                        "path": "src/keri/core/coring.py",
                        "line": None,
                        "location": "docstring of keri.core.coring.Number:",
                        "object_name": "keri.core.coring.Number:",
                        "message": "py:class reference target not found: io.BytesIO [ref.class]",
                        "raw": "src/keri/core/coring.py:docstring of keri.core.coring.Number:: WARNING: py:class reference target not found: io.BytesIO [ref.class]",
                    },
                    {
                        "severity": "WARNING",
                        "category": "missing-reference",
                        "path": "src/keri/core/coring.py",
                        "line": 3,
                        "location": "docstring of keri.core.coring.MissingThing",
                        "object_name": "keri.core.coring.MissingThing",
                        "message": "py:class reference target not found: ssl.SSLContext [ref.class]",
                        "raw": "src/keri/core/coring.py:docstring of keri.core.coring.MissingThing:3: WARNING: py:class reference target not found: ssl.SSLContext [ref.class]",
                    },
                ]
            }
        )

        by_target = {issue["target"]: issue for issue in payload["issues"]}

        low_confidence_issue = by_target["io.IOBase"]
        self.assertEqual(low_confidence_issue["mapping"]["confidence"], "low")
        self.assertEqual(low_confidence_issue["sourceRange"]["anchorKind"], "docstring-block")
        self.assertTrue(low_confidence_issue["publishDiagnostic"])

        normalized_object_issue = by_target["io.BytesIO"]
        self.assertEqual(normalized_object_issue["objectName"], "keri.core.coring.Number")
        self.assertEqual(normalized_object_issue["mapping"]["confidence"], "low")
        self.assertTrue(normalized_object_issue["publishDiagnostic"])

        unmapped_issue = by_target["ssl.SSLContext"]
        self.assertEqual(unmapped_issue["mapping"]["confidence"], "none")
        self.assertIsNone(unmapped_issue["sourceRange"])
        self.assertFalse(unmapped_issue["publishDiagnostic"])