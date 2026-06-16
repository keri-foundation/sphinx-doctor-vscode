# Sphinx Doctor Local Instructions

Treat this file as the canonical instruction surface when this repository is opened on its own.

This repo is the VS Code extension source for Sphinx Doctor. Keep guidance here self-contained so the repo does not depend on a larger multi-root workspace being open.

## Workflow Lanes

Preserve these three lanes and do not collapse them into one generic "test the extension" story:

1. Development Host
   - Use `Run Sphinx Doctor Extension Host` from `.vscode/launch.json`.
   - Confirm the active build with `Sphinx Doctor: Troubleshoot Environment`.
   - Treat `Sphinx Doctor: Publish Self-Test Diagnostic` as proof that diagnostic publishing works, not proof that the newest build is active.

2. Installed VSIX
   - Package with `npm run package`.
   - Install with `npm run install:local` or VS Code's VSIX install flow.
   - Confirm `Production` mode and installed extension path with `Sphinx Doctor: Troubleshoot Environment`.

3. Automated Test Host
   - Use `npm run test:integration` for the real VS Code host lane.
   - Use `npm run test:all` when you want both the unit lane and the host lane.
   - Prefer the tiny fixture workspace under `tests/fixtures/simple-sphinx/` over a larger multi-root workspace for extension-host tests.

## Working Rules

- Use `npm`, not `yarn`.
- `npm test` and `npm run test:unit` are the fast unit lane.
- `npm run test:integration` is the real extension-host lane.
- `npm run test:all` is the combined lane.
- `Sphinx Doctor: Troubleshoot Environment` is the mode and path source of truth.
- After `package.json` command contribution changes, restart the Extension Development Host or reinstall the VSIX. Do not assume a normal reload picked up the manifest change.
- Keep repo-local helpers thin. Prefer the existing npm scripts, `.vscode/tasks.json`, `.vscode/launch.json`, and `.vscode-test.mjs` over bespoke wrapper logic.

## Runtime Verification Rule (HARD)

**Before claiming a VS Code extension behavior is fixed, verify the active runtime lane.**

- Development Host verification requires `Troubleshoot Environment` showing **Development** mode and a source checkout path (e.g., `libs/sphinx-doctor-vscode`).
- Production verification requires reinstalling the local VSIX with `npm run reinstall:local`, reloading the target window, and then `Troubleshoot Environment` showing **Production** mode.
- Do not claim Problems or status bar behavior is fixed from unit tests or compiled JS grep alone.
- Live Sphinx output must show the expected command args and publish/status logs.
- If the normal KERI workspace is using Production mode, source edits alone are irrelevant until VSIX reinstall + reload.
- A stale runtime symptom is live Sphinx args missing `-E` after source has it.
- Another stale runtime symptom is fatal Tree-sitter initialization after fallback was implemented.

- If a task is explicitly docs, instructions, or workflow-only, keep runtime TypeScript behavior unchanged unless the user asks for runtime changes.
- Do not add real Sphinx execution to the first extension-host test slice unless the user asks for it. Start with bounded host-behavior checks.
- Do not assume `Devtools/sphinx-doctor/README.md` exists when this repo is opened standalone.
- Do not commit or push unless the user explicitly asks.