# Sphinx Doctor Architecture

This document describes the current implementation in this repository. It is intentionally narrower than the earlier research notes and reflects the extension as it exists today.

## System Overview

Sphinx Doctor is a VS Code extension that reads a versioned diagnostics contract, resolves the issues against workspace files, and publishes native VS Code diagnostics.

The core runtime is intentionally split into a few small layers:

1. An external enrichment or inventory step produces an enriched `sphinx-diagnostics-v1` JSON file.
2. The extension loads that contract from a stable mirror such as `.sphinx-diagnostics/latest.json` or from a selected diagnostics file.
3. Sphinx Doctor resolves each issue against the correct workspace folder and publishes a `DiagnosticCollection` for the Problems panel and editor decorations.
4. Watch mode keeps configured projects in sync and can trigger refresh or enrichment commands when the workspace allows it.

The canonical contract schema lives at [schema/sphinx-diagnostics-v1.schema.json](../schema/sphinx-diagnostics-v1.schema.json).

## Runtime Components

### Extension activation

[src/extension.ts](../src/extension.ts) is the entry point. It creates the logger, diagnostic collection, publication index, and watch-mode coordinator, then registers the public commands.

### Contract loading and validation

[src/loadDiagnostics.ts](../src/loadDiagnostics.ts) classifies diagnostics files, validates the enriched contract shape, and checks whether a file is safely bound to the current source workspace folder before it is published.

### Diagnostic publication

[src/publishDiagnostics.ts](../src/publishDiagnostics.ts) turns publishable issues into `vscode.Diagnostic` objects. It applies the current diagnostics mode, resolves issue paths against the active multi-root workspace, and updates the publication index so stale project diagnostics are replaced cleanly.

### Watch mode and project orchestration

[src/watchMode.ts](../src/watchMode.ts) is the main coordinator. It merges configured and discovered projects, watches mirror and inventory locations, loads diagnostics on startup, and routes refresh or enrichment requests through the runtime safety checks.

### Refresh and enrichment boundaries

[src/refreshRunner.ts](../src/refreshRunner.ts) builds and runs external refresh commands for a project.

[src/enrichmentRunner.ts](../src/enrichmentRunner.ts) handles the enrichment side of the workflow and the baseline-promotion checks around `.sphinx-diagnostics/latest.json`.

These commands are optional and require a trusted workspace. Read-only loading of an existing diagnostics contract remains available in limited trust mode.

### Project and workspace resolution

[src/config.ts](../src/config.ts), [src/projectDiscovery.ts](../src/projectDiscovery.ts), and [src/workspace.ts](../src/workspace.ts) define the project model, discovery rules, and workspace-folder resolution logic that make the extension work in multi-root setups.

## Data Flow

The normal flow is:

1. a source repo receives an enriched diagnostics mirror at `.sphinx-diagnostics/latest.json`
2. Sphinx Doctor discovers or selects the matching project
3. the extension validates the diagnostics binding against the intended source workspace folder
4. publishable issues with mapped source ranges become native VS Code diagnostics
5. retained-only or unmapped issues stay in the contract without creating fake editor anchors

This same flow supports the bundled host-test fixture under [tests/fixtures/simple-sphinx](../tests/fixtures/simple-sphinx).

## Multi-Root Model

Sphinx Doctor does not assume that the extension repo, the analyzed repo, and the inventory artifact location are the same folder.

The current contract distinguishes between:

- the source workspace folder that owns the files receiving diagnostics
- the inventory workspace folder where diagnostics artifacts are searched
- the repo root inside the source workspace folder
- the stable mirror root, usually `.sphinx-diagnostics`

The detailed workspace contract is documented in [docs/multi-root-workspace-model.md](multi-root-workspace-model.md) and the mirror layout is documented in [docs/mirror-layout.md](mirror-layout.md).

## Problem Matcher Boundary

The task-based problem matcher bridge is still supported, but it is a compatibility layer rather than the primary runtime.

The bridge converts an existing enriched contract into parseable terminal output for VS Code Tasks. That workflow is documented in [docs/vscode-problem-matcher.md](vscode-problem-matcher.md), and the example task template lives at [examples/vscode/tasks.sphinx-doctor.example.json](../examples/vscode/tasks.sphinx-doctor.example.json).

## Current Boundaries

Sphinx Doctor currently aims to be a diagnostics consumer and workspace orchestrator.

It is not trying to:

- replace Sphinx itself
- act as a general-purpose language server
- hide workspace ownership rules behind one implicit working directory

That narrow scope keeps the extension testable and makes the public contract easier to understand.

## Related Documents

- [README.md](../README.md)
- [docs/product-scope.md](product-scope.md)
- [docs/multi-root-workspace-model.md](multi-root-workspace-model.md)
- [docs/mirror-layout.md](mirror-layout.md)
- [docs/vscode-problem-matcher.md](vscode-problem-matcher.md)
