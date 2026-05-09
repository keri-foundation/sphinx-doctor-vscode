# Sphinx Doctor

Sphinx Doctor is a planned VS Code extension for turning Sphinx warnings and errors into actionable feedback for two audiences:

- humans working inside the editor
- AI tooling that needs structured context about doc failures

This repository is intentionally documentation-first right now. It holds the product framing, target architecture, and research intake surface before any extension code is scaffolded.

## Current Status

The repo is in contract-first planning mode. No extension runtime, build tooling, or UI code has been added yet.

## Initial Goals

- surface Sphinx warnings and errors as editor diagnostics
- preserve enough structure for an AI agent to reason about each issue
- give a human a visual triage surface for navigating and fixing problems
- keep the first release local and simple rather than inventing a remote service

## Repo Documents

- [docs/product-scope.md](docs/product-scope.md) defines the problem, users, scope, and non-goals
- [docs/architecture.md](docs/architecture.md) captures the target extension shape
- [docs/roadmap.md](docs/roadmap.md) breaks the work into thin phases
- [docs/research-inbox.md](docs/research-inbox.md) is the landing zone for incoming research notes
- [docs/data-contract.md](docs/data-contract.md) defines the JSON-first diagnostics contract
- [docs/mirror-layout.md](docs/mirror-layout.md) defines the stable `.sphinx-diagnostics/` layout
- [docs/multi-root-workspace-model.md](docs/multi-root-workspace-model.md) explains multi-root path ownership
- [docs/ai-packet-contract.md](docs/ai-packet-contract.md) defines `latest-for-ai.md`
- [schema/sphinx-diagnostics-v1.schema.json](schema/sphinx-diagnostics-v1.schema.json) is the versioned contract schema

## Working Assumptions

- the extension will start by consuming Sphinx build output rather than replacing Sphinx
- the extension should support both machine-readable issue context and human-readable navigation
- the first useful slice is likely diagnostics plus source-location mapping, not a full custom docs platform

## Near-Term Next Step

The next implementation slice should consume the new schema and fixtures to decide whether the enrichment engine or the minimal extension shell comes first.
