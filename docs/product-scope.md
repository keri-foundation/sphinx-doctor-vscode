# Product Scope

## Problem

Sphinx failures are often visible only as terminal output or build logs. That makes them slower to triage, harder to map back to the right file location, and awkward to hand to an AI agent in a structured way.

Sphinx Doctor is meant to shorten that loop inside VS Code.

## Primary Users

- documentation authors fixing warnings and errors in `.rst`, Markdown, and docstrings
- maintainers who want a fast view of build health inside the editor
- AI-assisted workflows that need normalized issue data instead of raw log text

## First-Release Scope

- ingest Sphinx warning and error output from a local docs build
- normalize each issue into a stable shape with file, line, message, and category when available
- publish editor diagnostics for direct navigation
- expose a human-facing summary view inside VS Code
- expose an AI-facing issue surface that can be queried or consumed by tooling

## Non-Goals For The First Slice

- replacing Sphinx itself
- remote dashboards or cloud sync
- broad docs analytics beyond immediate build issues
- automated fixes for every warning class
- deep project-specific conventions before the base workflow is proven

## Design Constraints

- local-first behavior
- minimal moving parts
- clear mapping from raw Sphinx output to editor location
- enough structure to support AI workflows without hiding the original message

## Questions To Answer From Research

- which Sphinx output formats are the most reliable inputs
- whether a direct subprocess call or task integration is the cleanest MVP trigger
- what the AI interface should expose first: diagnostics, issue summaries, or both
- what human-facing view is most useful first: panel, tree, inline code action, or webview