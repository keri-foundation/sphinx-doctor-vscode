# Contributing

Sphinx Doctor is in public incubation. Keep contributions small, testable, and explicit about whether they change docs, workflow, or runtime behavior.

## Tooling

- use `npm`, not `yarn`
- use the scripts already defined in [package.json](package.json)
- do not commit generated artifacts such as `out/`, `.vscode-test/`, `node_modules/`, `artifacts/`, `*.vsix`, or OS/editor files such as `.DS_Store`

## Setup

1. Run `npm ci`.
2. Run `npm run compile`.
3. Run `npm test` for the fast unit lane.

## Test Commands

- `npm run compile` - TypeScript compile
- `npm test` or `npm run test:unit` - fast unit lane
- `npm run test:integration` - real VS Code extension-host lane
- `npm run test:all` - unit plus integration
- `npm run package` - package a local VSIX under `artifacts/`
- `npm run install:local` - install the packaged VSIX from `artifacts/` with the `code` CLI
- `npm run test:real-problems` - targeted real-Keripy Problems API proof (requires env vars)

## Development Host

1. Open this repo in VS Code.
2. Press `F5` and choose `Run Sphinx Doctor Extension Host`.
3. In the Extension Development Host window, run `Sphinx Doctor: Troubleshoot Environment`.
4. Confirm the report shows `Development` mode.
5. To test against a real Sphinx project, open the project workspace in the Extension Host window and run `Sphinx Doctor: Run Sphinx Build`. Filter Problems by `sphinx-doctor` to see only Sphinx Doctor diagnostics.

Use `Run Sphinx Doctor Extension Host (Multi-Root Fixture Example)` only when you intentionally want to exercise a larger multi-root workspace shape than the default single-fixture lane.

## Installed VSIX

1. Run `npm run reinstall:local` (compiles, tests, packages to `artifacts/`, force-installs, and verifies markers).
2. Reload the target VS Code window.
3. Run `Sphinx Doctor: Troubleshoot Environment` and confirm `Production` mode.

For manual control: `npm run package` then `npm run install:local`, or install the generated `.vsix` from `artifacts/` via VS Code.

**Note:** Installed-VSIX runtime behavior against Keripy has not yet been validated. Development Host behavior is proven; normal installed-VSIX validation is a separate step.

## Manual Docstring Triage (Direct-Run Workflow)

1. Open a Sphinx project in the Extension Development Host.
2. Run `Sphinx Doctor: Run Sphinx Build`.
3. Open the Problems view (Cmd+Shift+M) and filter by `sphinx-doctor`.
4. Click a `.py` diagnostic to navigate to the highlighted source line.
5. Manually correct the docstring and save.
6. Rerun `Sphinx Doctor: Run Sphinx Build` to refresh diagnostics.
7. Use `Sphinx Doctor: Explain Diagnostics Counts` to see the full accounting of published vs retained issues.

## Fixtures

Use [tests/fixtures/simple-sphinx/README.md](tests/fixtures/simple-sphinx/README.md) for the smallest repeatable extension-host workspace. It contains a conventional `docs/conf.py`, a demo Python file, and a local `.sphinx-diagnostics/latest.json` mirror.

## Contribution Guardrails

- keep generic extension behavior free of hard-coded KERI-only assumptions
- treat KERI as an example and stress-case workspace, not the default product identity
- keep workflow and docs helpers thin wrappers over the existing npm scripts
- if a slice is docs- or workflow-only, do not change runtime behavior in `src/` or test behavior in `tests/` unless the change is explicitly required

## Before Opening A PR

1. Run `npm run compile`.
2. Run `npm test`.
3. Run `npm run test:integration` or `npm run test:all` when your slice affects extension-host behavior, packaging workflow, or command availability.
4. Manually smoke the relevant lane with `Sphinx Doctor: Troubleshoot Environment`.