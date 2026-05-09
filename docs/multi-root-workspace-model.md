# Multi-Root Workspace Model

Sphinx Doctor must work in Jay's multi-root workspace, where the extension source repo is only one folder among many.

## Four Distinct Locations

The contract and future settings must distinguish between four locations:

- extension repo: where Sphinx Doctor lives, currently `11-sphinx-doctor`
- analyzed source repo: the repo whose files should receive diagnostics, for example `02-keripy`
- inventory artifact location: where an inventory run was written, often `01-keri-notes/tmp/...`
- diagnostics mirror output: where `.sphinx-diagnostics/` should be written, usually inside the analyzed repo root

These are often different places. Sphinx Doctor must not collapse them into one implied working directory.

## Proposed Settings Contract

```json
{
  "sphinxDoctor.projects": [
    {
      "id": "keripy",
      "label": "keripy",
      "sourceWorkspaceFolder": "02-keripy",
      "inventoryWorkspaceFolder": "01-keri-notes",
      "repoRoot": ".",
      "docsRoot": "docs",
      "inventorySearchGlobs": [
        "tmp/sphinx-inventory-keripy-sphinx-unexpected-indentation-batch-01-*/report/issues.vscode.json",
        "tmp/sphinx-inventory-keripy-sphinx-unexpected-indentation-batch-01-*/report/issues.json"
      ],
      "preferredInventoryFiles": [
        "issues.vscode.json",
        "issues.json"
      ],
      "mirrorRoot": ".sphinx-diagnostics"
    }
  ]
}
```

## Field Meanings

### `sourceWorkspaceFolder`

The workspace folder whose files should receive diagnostics. This is the repo the user is trying to fix.

### `inventoryWorkspaceFolder`

The workspace folder where the extension should search for inventory artifacts. In Jay's setup that may be `01-keri-notes`, because the inventory runner currently writes under `tmp/` there.

### `repoRoot`

The analyzed repo root relative to `sourceWorkspaceFolder`. This keeps path resolution explicit even if the workspace folder is not the exact repo root in some future layout.

### `docsRoot`

The documentation root relative to `sourceWorkspaceFolder`. This helps later grouping and scope filters without assuming all issues come from code.

### `inventorySearchGlobs`

Explicit search globs for candidate inventory files. These should be narrow and project-specific.

### `preferredInventoryFiles`

The filename priority order once a candidate run directory is found.

### `mirrorRoot`

The stable mirror directory relative to `sourceWorkspaceFolder`, usually `.sphinx-diagnostics`.

## Why Broad `tmp/**` Scanning Is Forbidden

Blanket scanning of `tmp/**` is a bad default in this workspace.

Problems it causes:

- unrelated inventory runs from other repos get mixed together
- performance degrades as `tmp/` grows
- stale runs become harder to distinguish from current runs
- the extension becomes sensitive to parent-repo layout accidents rather than explicit project configuration

Sphinx Doctor should prefer explicit project objects and narrow globs over global auto-discovery.

## Example Resolution Flow

For a `keripy` project entry:

1. find `sourceWorkspaceFolder = 02-keripy`
2. resolve repo paths against that workspace folder
3. find `inventoryWorkspaceFolder = 01-keri-notes`
4. search only the configured globs there
5. load the preferred inventory file from the chosen run
6. mirror the selected run into `02-keripy/.sphinx-diagnostics/`
7. publish diagnostics against file URIs under `02-keripy`

This keeps path ownership explicit across the whole workflow.