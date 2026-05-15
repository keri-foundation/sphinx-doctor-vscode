# Contributing

Sphinx Doctor is in public incubation. Keep contributions small, testable, and explicit about whether they change docs, workflow, or runtime behavior.

## Tooling

- use `npm`, not `yarn`
- use the scripts already defined in [package.json](package.json)
- do not commit generated artifacts such as `out/`, `.vscode-test/`, `node_modules/`, `*.vsix`, or OS/editor files such as `.DS_Store`

## Setup

1. Run `npm ci`.
2. Run `npm run compile`.
3. Run `npm test` for the fast unit lane.

## Test Commands

- `npm run compile` - TypeScript compile
- `npm test` or `npm run test:unit` - fast unit lane
- `npm run test:integration` - real VS Code extension-host lane
- `npm run test:all` - unit plus integration
- `npm run package` - package a local VSIX
- `npm run install:local` - install the packaged VSIX with the `code` CLI

## Development Host

1. Open this repo in VS Code.
2. Press `F5` and choose `Run Sphinx Doctor Extension Host`.
3. In the Extension Development Host window, run `Sphinx Doctor: Troubleshoot Environment`.
4. Confirm the report shows `Development` mode.

Use `Run Sphinx Doctor Extension Host (KERI Workspace Example)` only when you intentionally want to exercise the larger KERI multi-root workspace.

## Installed VSIX

1. Run `npm run package`.
2. Run `npm run install:local`, or install the generated `.vsix` from VS Code.
3. Reload the target VS Code window.
4. Run `Sphinx Doctor: Troubleshoot Environment` and confirm `Production` mode.

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