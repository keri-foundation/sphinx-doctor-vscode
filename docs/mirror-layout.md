# Mirror Layout

Sphinx Doctor should mirror the latest selected diagnostics run into a stable `.sphinx-diagnostics/` directory.

## Canonical Layout

```text
.sphinx-diagnostics/
  latest.json
  latest.md
  latest-for-ai.md
  runs/
    <run-id>/
      enriched.json
      summary.md
      for-ai.md
```

## Default Location

The mirror should default to the analyzed repo root, not to the extension repo.

For example, diagnostics for `02-keripy` should mirror into:

```text
libs/keripy/.sphinx-diagnostics/
```

and not into:

```text
libs/sphinx-doctor-vscode/.sphinx-diagnostics/
```

unless Sphinx Doctor itself is the project being analyzed.

## Why The Mirror Lives With The Analyzed Repo

This keeps the stable artifacts next to the files they describe.

Benefits:

- humans can inspect diagnostics from the target repo without switching mental models
- AI tools can read stable files from the same repo they are reviewing
- the extension does not need to invent hidden private state for the latest run
- multi-root workspaces can separate extension code, inventory source, and analyzed repo cleanly

## File Roles

- `latest.json`: the current machine-readable enriched contract
- `latest.md`: a human-readable summary for manual inspection
- `latest-for-ai.md`: a stable context packet for AI workflows
- `runs/<run-id>/enriched.json`: archived run snapshot
- `runs/<run-id>/summary.md`: archived human summary
- `runs/<run-id>/for-ai.md`: archived AI packet

## Relationship To Inventory Inputs

The mirror is not the same thing as the original inventory directory. A run may be discovered under a separate workspace folder such as `example-workspace/tmp/...`, then mirrored into the analyzed repo such as `keripy/.sphinx-diagnostics/`.

That distinction is part of the contract, not an implementation detail.