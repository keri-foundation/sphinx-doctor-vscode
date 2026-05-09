# VS Code Problem Matcher Bridge

Sphinx Doctor now includes a short-term Problems bridge for VS Code Tasks.

It does not replace the extension runtime. It turns enriched `sphinx-diagnostics-v1` JSON into parseable text lines so a task problem matcher can surface issues in the Problems panel while the native runtime matures.

## CLI Shape

```bash
python3 -m sphinx_doctor.cli problems \
  --diagnostics-json /tmp/sphinx-doctor-fixture-output.json \
  --format vscode
```

By default the command emits only issues that:

- have `publishDiagnostic: true`
- have a non-null `sourceRange`
- have a `repoRelativePath`

Unmapped retained-only issues are skipped by default so they do not produce malformed Problems entries.

Optional flag:

```bash
--include-skipped-summary
```

When present, the command appends a non-problem comment line such as `# skipped issues: 1`.

## Output Format

The output is one line per publishable mapped issue:

```text
<file>:<line>:<column>: <severity>: [<category>] <message> (<objectName>)
```

Example:

```text
src/keri/core/coring.py:13:5: error: [unexpected-indentation] Unexpected indentation in autodoc docstring block. (keri.core.coring.Number)
```

Severity is normalized to:

- `error`
- `warning`
- `info`

## VS Code Task Matcher

The example task template lives in [examples/vscode/tasks.sphinx-doctor.example.json](../examples/vscode/tasks.sphinx-doctor.example.json).

Its problem matcher regex captures:

- file
- line
- column
- severity
- message

Suggested pattern:

```json
{
  "regexp": "^([^:]+):(\\d+):(\\d+):\\s+(error|warning|info):\\s+(.*)$",
  "file": 1,
  "line": 2,
  "column": 3,
  "severity": 4,
  "message": 5
}
```

## Multi-Root Note

In Jay's workspace:

- `11-sphinx-doctor` is the tool repo
- `02-keripy` may be the analyzed repo
- `01-keri-notes` may be the inventory root

That means a real task must set `options.cwd` intentionally. The example is a starting point, not the final multi-root extension architecture.

Problem output paths must resolve relative to the analyzed repo or be absolute. For the fixture example, paths are repo-relative to the analyzed source tree.

This bridge is useful because it gets issues into the Problems panel quickly, but it is still transitional. The current runtime can already load diagnostics JSON directly and publish a `DiagnosticCollection`; the task bridge remains useful for task-based workflows and shell-first integration.