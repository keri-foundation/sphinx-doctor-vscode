# Architecture

## Target Shape

Sphinx Doctor should stay thin at the beginning. The extension should observe a docs build, normalize the issues it emits, and present the same issue set through two surfaces:

- a human-facing VS Code experience
- an AI-facing structured interface

## Core Components

### Input Layer

Responsible for collecting Sphinx issues from a local build or saved log output.

### Issue Normalizer

Turns raw Sphinx messages into a stable internal record with fields such as source path, line number, severity, code or category, and original text.

### Diagnostics Publisher

Maps normalized issues to VS Code diagnostics so the editor can underline and navigate directly to affected sources.

### Human Triage Surface

Presents the current issue set in a form that is easier to scan than raw terminal output. The first version can be simple if it improves navigation and filtering.

### AI Surface

Makes the normalized issue set available in a structured form so an AI agent can understand what failed, where it failed, and how issues cluster.

## Proposed Data Flow

1. Trigger or observe a Sphinx build.
2. Capture emitted warnings and errors.
3. Normalize each issue into a stable record.
4. Publish diagnostics for the relevant workspace files.
5. Feed the same record set into the human and AI surfaces.

## Architectural Boundaries

- Sphinx Doctor should not become a replacement docs engine.
- The extension should preserve raw Sphinx output for traceability.
- The normalized issue model should be shared across the human and AI paths.
- Project-specific behavior should be opt-in once real usage shows the need.

## Planned Repo Shape

When code starts, the repo will likely need:

- an extension entry point
- a small core for issue normalization
- one human-facing presentation layer
- one AI-facing interface layer
- fixtures for representative Sphinx output

That layout is intentionally deferred until the research clarifies the best extension model.