# AI Packet Contract

The future extension should write a stable human-readable packet to:

```text
.sphinx-diagnostics/latest-for-ai.md
```

This file is for AI-assisted review workflows. It complements native Problems diagnostics and the machine-readable JSON contract.

## Purpose

`latest-for-ai.md` gives GitHub Copilot and other agents a deterministic summary of the currently selected diagnostics run without forcing them to reconstruct context from terminal output.

Until that file exists, the extension's published Problems diagnostics are the primary editor-facing context surface for Copilot-assisted fixes.

The enrichment command already writes `.sphinx-diagnostics/latest.json` beside archived run snapshots, so the future AI packet writer can build on a stable analyzed-repo mirror instead of transient terminal output.

It should be readable on its own and stable enough that agents can depend on its section order.

## Recommended Structure

### Project

- project id and label
- analyzed repo identity
- source workspace folder
- inventory workspace folder

### Run

- run id
- generated timestamp
- inventory file used
- mirror location

### Summary

- total issues
- counts by severity
- counts by category
- published diagnostics count
- retained-only issue count

### Top Issue Groups

- highest-impact files
- highest-count categories
- object groups when available

### Current File Diagnostics

- issues affecting the current file when that context is known
- direct reference back to `latest.json`

### Low-Confidence And Unmapped Issues

- all issues with `mapping.confidence = low`
- all issues with `mapping.confidence = none`
- reasons they were not mapped more precisely

### References

- `.sphinx-diagnostics/latest.json`
- archived run directory under `.sphinx-diagnostics/runs/<run-id>/`

### Suggested Copilot Use

- use `latest-for-ai.md` for human-readable context
- use `latest.json` for machine-readable context
- use Problems diagnostics for source navigation once the extension publishes them
- avoid relying on flaky terminal output as the primary source of truth

## Why This Complements Problems

Problems are the navigation surface. The AI packet is the summary surface.

Together they provide:

- exact source navigation through diagnostics
- stable run context through a file
- explicit treatment of unmapped issues that may not appear as editor squiggles

The AI packet should never replace the canonical JSON contract. It is a derivative view over that contract.