# Data Contract

Sphinx Doctor uses a JSON-first contract so the same diagnostics data can drive three workflows without re-parsing terminal output:

- enrichment and source mapping
- native VS Code diagnostics
- AI-readable workspace artifacts

The canonical contract for enriched diagnostics lives in [schema/sphinx-diagnostics-v1.schema.json](../schema/sphinx-diagnostics-v1.schema.json).

## Why JSON First

Problem matchers are useful for basic terminal parsing, but they are auxiliary only. The hard problem in this project is not capturing `file:line:message`; it is preserving object identity, docstring-relative line numbers, source-range anchors, confidence, and multi-root workspace metadata in one stable payload.

JSON is the right contract because it can carry:

- source and inventory workspace folder identities
- repo-relative paths that survive multi-root workspaces
- mapping confidence and reasons
- issues that are retained for review but should not become editor diagnostics
- AI-friendly and human-friendly derivative outputs without lossy re-parsing

## `issues.json` Versus `issues.vscode.json`

The existing Sphinx cleanup workflow may already produce an inventory-style `issues.json`. Sphinx Doctor treats that as upstream input, not as the final extension contract.

Recommended distinction:

- `issues.json`: upstream or raw inventory report, close to emitted Sphinx or harness findings
- `issues.vscode.json`: enriched report with source mapping, confidence, and publication intent for VS Code

The raw fixture in [fixtures/raw/keripy-coring-unexpected-indentation.sample.json](../fixtures/raw/keripy-coring-unexpected-indentation.sample.json) represents the upstream side. The enriched fixture in [fixtures/enriched/keripy-coring-unexpected-indentation.expected.json](../fixtures/enriched/keripy-coring-unexpected-indentation.expected.json) represents the contract the extension should eventually consume.

## Source Ranges

`sourceRange` is optional. Some issues can be mapped to an exact line inside a docstring literal, while others can only be anchored to a docstring block, an object block, or not mapped at all.

Supported anchors are:

- `docstring-line`
- `docstring-block`
- `object-block`
- `file-line`
- `file-top`

Sphinx Doctor should prefer honest anchors over false precision.

## Mapping Confidence

Each issue includes a `mapping` object with:

- `confidence`
- `strategy`
- `reason`
- `objectResolved`
- `lineResolved`

Confidence levels:

- `high`: exact object and line mapping
- `medium`: exact object, approximate but still trustworthy location
- `low`: coarse anchor that is still useful for navigation
- `none`: no trustworthy source anchor

## Unmapped Issues

Unmapped issues stay in the contract. They are not discarded just because a source range could not be computed.

When mapping fails honestly:

- `sourceRange` may be `null`
- `mapping.confidence` should be `none`
- `publishDiagnostic` may be `false`
- the issue remains available for the Tree View, summaries, AI packets, and manual review

This avoids losing information while keeping editor diagnostics truthful.

## Future VS Code Consumption

The future extension should load the enriched contract, not the raw inventory. That allows a `DiagnosticCollection` to make publication decisions from explicit fields instead of hidden heuristics.

Expected consumption pattern:

1. load the enriched JSON contract
2. filter `publishDiagnostic == true`
3. publish editor diagnostics only for issues with trustworthy file anchors
4. retain all issues for grouped navigation, summaries, and AI packets

The top-level summary should also expose `mappedCount` and `unmappedCount` so the future extension and AI packet generator can report mapping quality without re-counting every issue.