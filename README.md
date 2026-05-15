# Sphinx Doctor

Sphinx Doctor is a VS Code extension source repo for turning Sphinx warnings and errors into actionable feedback for two audiences:

- humans working inside the editor
- AI tooling that needs structured context about doc failures

This repository started documentation-first and now includes a working extension runtime alongside the planning and contract material. It is intended to grow as a general-purpose Sphinx diagnostics extension for Python documentation workflows. The KERI multi-root workspace remains an important example and stress case, but it is not the entire product identity.

## Status

- public incubation / early developer preview
- useful for Sphinx-heavy Python workspaces and repo-local diagnostics workflows
- not yet Marketplace-polished; the supported evaluation paths are source checkout plus local VSIX workflow

## What Sphinx Doctor Does

- loads Sphinx Doctor diagnostics artifacts from fixture files, repo-local mirrors, or project-selected inventory files
- publishes native VS Code Problems diagnostics mapped back to source files when the artifact has usable source locations
- keeps a clear distinction between Development Host, installed VSIX, and automated extension-host testing through `Sphinx Doctor: Troubleshoot Environment`
- supports generic Sphinx projects while using the KERI workspace as one important multi-root example

## Quick Start

Use this repo to evaluate the extension in a generic Sphinx workspace before wiring it into a larger multi-root setup.

1. Install dependencies with `npm ci`.
2. Compile with `npm run compile`.
3. Run the fast unit lane with `npm test`.
4. Press `F5` and choose `Run Sphinx Doctor Extension Host`.
5. In the Extension Development Host window, run `Sphinx Doctor: Troubleshoot Environment`.
6. Run `Sphinx Doctor: Load Fixture Diagnostics` to prove the basic Problems flow against the bundled fixture, or run `Sphinx Doctor: Load Project Diagnostics` in a repo that already has a compatible `.sphinx-diagnostics/latest.json` artifact.
7. Confirm the Problems view updates and that the troubleshoot report opens as a saved Markdown file rather than an unsaved editor buffer.

For a generic Sphinx repo, the simplest activation signal is a conventional `docs/conf.py` file.

## Known Limitations

- diagnostics count explainability is present, but the broader count-trust story is still being hardened
- refresh behavior and refresh-on-save clarity still need additional product hardening
- non-KERI onboarding is improving, but the KERI workspace remains the best-covered multi-root example today
- Marketplace release work is out of scope for the current incubation phase

## Initial Goals

- surface Sphinx warnings and errors as editor diagnostics
- preserve enough structure for an AI agent to reason about each issue
- give a human a visual triage surface for navigating and fixing problems
- keep the first release local and simple rather than inventing a remote service

## Normal Workflow

Open the Command Palette:

- macOS: `Cmd+Shift+P`
- Windows/Linux: `Ctrl+Shift+P`

Type `Sphinx Doctor`, then run:

`Sphinx Doctor: Discover and Load Diagnostics`

This discovers supported workspace projects, loads compatible existing diagnostics artifacts, and publishes source-mapped diagnostics into Problems.

Use `Sphinx Doctor: Explain Diagnostics Counts` when the total issue count does not match the Problems count.

Use `Sphinx Doctor: Show Status` for current extension status.

## Repo Documents

- [CONTRIBUTING.md](CONTRIBUTING.md) documents the supported contributor workflow
- [CHANGELOG.md](CHANGELOG.md) tracks incubation-era repo changes
- [docs/roadmap.md](docs/roadmap.md) outlines the current public incubation sequence and later roadmap
- [docs/product-scope.md](docs/product-scope.md) defines the problem, users, scope, and non-goals
- [docs/architecture.md](docs/architecture.md) captures the target extension shape
- [docs/research-inbox.md](docs/research-inbox.md) is the landing zone for incoming research notes
- [docs/data-contract.md](docs/data-contract.md) defines the JSON-first diagnostics contract
- [docs/mirror-layout.md](docs/mirror-layout.md) defines the stable `.sphinx-diagnostics/` layout
- [docs/multi-root-workspace-model.md](docs/multi-root-workspace-model.md) explains multi-root path ownership
- [docs/ai-packet-contract.md](docs/ai-packet-contract.md) defines `latest-for-ai.md`
- [docs/vscode-problem-matcher.md](docs/vscode-problem-matcher.md) explains the task-based Problems bridge
- [schema/sphinx-diagnostics-v1.schema.json](schema/sphinx-diagnostics-v1.schema.json) is the versioned contract schema

## Working Assumptions

- the extension will start by consuming Sphinx build output rather than replacing Sphinx
- the extension should support both machine-readable issue context and human-readable navigation
- the first useful slice is likely diagnostics plus source-location mapping, not a full custom docs platform

## MVP Commands

- `Sphinx Doctor: Publish Self-Test Diagnostic`
- `Sphinx Doctor: Troubleshoot Environment`
- `Sphinx Doctor: Load Diagnostics File`
- `Sphinx Doctor: Load Fixture Diagnostics`
- `Sphinx Doctor: Load Project Diagnostics`
- `Sphinx Doctor: Enrich and Load Project Diagnostics`
- `Sphinx Doctor: Refresh Project Diagnostics`
- `Sphinx Doctor: Discover Workspace Projects`
- `Sphinx Doctor: Discover and Load Diagnostics`
- `Sphinx Doctor: Reload Last Diagnostics`
- `Sphinx Doctor: Clear Diagnostics`
- `Sphinx Doctor: Show Status`

## Deterministic Development And Testing Workflow

Use one workflow at a time. The most common source of confusion is proving that some Sphinx Doctor extension is running without proving which build is active.

`Sphinx Doctor: Troubleshoot Environment` is the source of truth for that check:

- use it first to confirm extension mode and extension path
- it writes a timestamped Markdown report under the extension log location and opens that saved report
- use it before and after reinstall or restart steps when a command seems stale
- treat `Sphinx Doctor: Publish Self-Test Diagnostic` as proof that diagnostic publishing works, not proof that the newest build is active

### Workflow A - Development Host

Use this when testing local source changes from this repo checkout.

1. Open the Sphinx Doctor repo in VS Code.
2. Compile with `npm run compile`, or rely on the existing `preLaunchTask` in the debug profile.
3. Stop any existing extension-host sessions with `Debug: Stop` or `Debug: Stop All` until the extra extension-host entries disappear from Call Stack.
4. Select `Run Sphinx Doctor Extension Host` in the debug dropdown.
5. Press `F5` once.
6. Use the new Extension Development Host window that opens as the actual test window.
7. Run `Sphinx Doctor: Troubleshoot Environment`.
8. Confirm the report shows `Development` mode and an extension path pointing to `libs/sphinx-doctor-vscode`.

Optional repo-local tasks:

- `Sphinx Doctor: Compile`
- `Sphinx Doctor: Test`
- `Sphinx Doctor: Test Integration`
- `Sphinx Doctor: Test All`
- `Sphinx Doctor: Test Package Install Local VSIX`

Important notes:

- after `package.json` command-contribution changes, restart the Extension Development Host instead of assuming `Developer: Reload Window` picked up the new manifest data
- `Developer: Reload Window` only reloads the current window; it does not switch a normal VS Code window into the Extension Development Host
- if `Sphinx Doctor: Troubleshoot Environment` is missing in the host window after a manifest change, the host is probably stale and should be restarted

The secondary launch profile, `Run Sphinx Doctor Extension Host (Workspace Extensions Enabled)`, is only for cases where you intentionally want the rest of the workspace extensions available in the host window.

### Workflow B - Installed VSIX

Use this when testing the packaged extension the way a normal user would in a regular VS Code window.

1. From `libs/sphinx-doctor-vscode`, run `npm run package`.
2. Install the VSIX with `npm run install:local`, or use `Extensions: Install from VSIX` and choose the generated `.vsix` file.
3. Reload the target VS Code window.
4. Run `Sphinx Doctor: Troubleshoot Environment`.
5. Confirm the report shows `Production` mode and an extension path under the installed extensions directory.

Optional repo-local tasks:

- `Sphinx Doctor: Package VSIX`
- `Sphinx Doctor: Install Local VSIX`
- `Sphinx Doctor: Test Package Install Local VSIX`

Important notes:

- the `package` script uses `npm exec --yes --package @vscode/vsce -- vsce package`, so the packager is fetched on demand without a separate Yarn install or an interactive approval prompt
- the `install:local` script already installs with `--force`
- the `install:local` script expects the VS Code `code` shell command to be installed; if `code` is not available, use `Extensions: Install from VSIX` instead
- if `Sphinx Doctor: Publish Self-Test Diagnostic` exists but `Sphinx Doctor: Troubleshoot Environment` does not, you are likely testing a stale installed VSIX or a different VS Code window than the one you reloaded

### Workflow C - Automated Test Host

Use this lane for repeatable source-based extension-host checks in a real VS Code test window.

1. Run `npm run test:integration`.
2. This compiles the repo, launches VS Code in test mode, opens `tests/fixtures/simple-sphinx`, and loads the extension from source.
3. The current integration slice proves activation, expected command registration, startup loading of a static fixture `.sphinx-diagnostics/latest.json`, manual loading through `Sphinx Doctor: Load Project Diagnostics`, mapped diagnostics publication, retained-only issues staying unpublished, and clear behavior.
4. Run `npm run test:all` when you want both the fast unit lane and the real host lane together.

Repo-local helpers for this lane:

- `Sphinx Doctor: Test Integration`
- `Sphinx Doctor: Test All`
- `Run Sphinx Doctor Integration Tests` in `.vscode/launch.json`

This lane still does not replace manual Development Host or Installed VSIX checks.

### Clean Reinstall Workflow

Use this when command contributions or package changes look stale in a normal installed-extension window.

1. Run `npm run package`.
2. Run `npm run install:local` again.
3. Reload the target VS Code window.
4. Run `Sphinx Doctor: Troubleshoot Environment` and confirm `Production` mode plus the installed extension path.

If a normal reinstall still looks stale, use a conservative uninstall and reinstall path:

1. Uninstall the extension from the VS Code Extensions UI, or run `code --uninstall-extension jaelliot.sphinx-doctor-vscode`.
2. Run `npm run install:local`, or install the new `.vsix` from the Extensions UI.
3. Reload the target VS Code window.
4. Run `Sphinx Doctor: Troubleshoot Environment` again before doing any other smoke checks.

Do not delete extension folders manually.

The repo-local contributor workflow in [CONTRIBUTING.md](CONTRIBUTING.md) summarizes these lanes for public contributors.

### Smoke-Test Checklist

1. Run `npm run compile`.
2. Run `npm test`.
3. Run `npm run test:integration` or `npm run test:all` when you need the real extension-host lane.
4. Use the bundled `tests/fixtures/simple-sphinx` workspace or a generic Sphinx repo with `docs/conf.py` for smoke testing.
5. Run `Sphinx Doctor: Troubleshoot Environment`.
6. Confirm mode and extension path match the workflow you intended to test.
7. Confirm the expected command exists in the Command Palette.
8. Run `Sphinx Doctor: Publish Self-Test Diagnostic`.
9. Confirm the Problems view shows the Sphinx Doctor warning.
10. Run `Sphinx Doctor: Load Fixture Diagnostics` or `Sphinx Doctor: Load Project Diagnostics`.
11. Confirm diagnostics appear in Problems for the expected file.
12. Confirm the troubleshoot report is a saved Markdown file and not an untitled dirty buffer.
13. Run `Sphinx Doctor: Clear Diagnostics`.
14. Confirm the diagnostics disappear.
15. If testing an installed VSIX, confirm `Production` mode and an installed extension path.
16. If testing the Extension Development Host, confirm `Development` mode and the source repo path.

### Which Window Am I In?

- `Troubleshoot Environment` reports `Development` mode and the source checkout path: you are testing local source in the Extension Development Host.
- `Troubleshoot Environment` reports `Production` mode and an installed extensions path: you are testing the packaged VSIX in a normal VS Code window.
- `sphinxDoctor.*` settings show as unknown in a normal window: Sphinx Doctor is probably not installed or not running in that window.
- `Publish Self-Test Diagnostic` works but `Troubleshoot Environment` is missing: you are probably in a stale host or stale installed-extension window.
- New command contributions are missing right after a `package.json` change: restart the Extension Development Host or reinstall and reload the installed VSIX window.

## Refresh Project Diagnostics

`Sphinx Doctor: Refresh Project Diagnostics` is the producer path that the self-test deliberately does not cover.

For a configured or discovered project, the command now runs this pipeline:

1. resolve an explicit or conservative inferred refresh command
2. run the external inventory producer in a trusted workspace
3. locate a fresh compatible output artifact written after the refresh started
4. enrich raw `issues.json` into a run archive under `.sphinx-diagnostics/runs/<run-id>/enriched.json` when needed
5. compare the refreshed enriched run to the current `.sphinx-diagnostics/latest.json` baseline before promotion
6. promote to `.sphinx-diagnostics/latest.json` only when the refreshed run does not represent major scope drift
7. publish the resulting diagnostics into VS Code Problems

The command refuses to bind stale inventory files from older runs, and it keeps the existing compatibility checks that reject artifacts generated for a different source workspace folder or worktree.

If a refresh finds a much broader diagnostics universe than the current baseline, Sphinx Doctor preserves the new run archive for inspection but does not silently replace `.sphinx-diagnostics/latest.json`.

When the current diagnostics baseline is a focused single-category lane, refresh preserves that category by passing the same category filter back into the inventory runner before the parity guard compares the new run.

## KERI Workspace Example

The KERI workspace is the most exercised multi-root example today. It demonstrates how Sphinx Doctor behaves in a larger shared workspace, but it is not the only supported shape.

- `02-keripy` is the current active, refresh-capable repo because it has a verified Sphinx marker, a working docs Python at `.venv-docs/bin/python`, and a valid inventory-runner path through `01-keri-notes/Devtools/sphinx/run_sphinx_inventory.sh`.
- `03-hio`, `06-locksmith`, and `07-witness-hk` are passive discovery candidates only. Sphinx Doctor may discover them from high-confidence `conf.py` markers, but refresh stays blocked until each repo has a verified docs Python environment.
- `08-watcher-hk` and `09-fortweb` are not treated as Sphinx projects until real `conf.py` markers exist.
- `01-keri-notes`, `11-sphinx-doctor`, and `20-billing-ops-tasks` stay intentionally excluded from source-project discovery.

For the standard KERI workspace layout, Sphinx Doctor can infer a refresh command without a committed `sphinxDoctor.projects` entry when all of the following are true:

- `01-keri-notes` is open in the workspace
- the source repo is nested under `01-keri-notes/libs/`
- `Devtools/sphinx/run_sphinx_inventory.sh` exists in `01-keri-notes`
- the source repo has `.venv-docs/bin/python`
- the source repo has a Sphinx marker such as `docs/conf.py`

If any prerequisite is missing, the command fails with a clear message instead of pretending that an older artifact is current.

In a normal VS Code window:

1. Sphinx Doctor must actually be installed there, for example from a VSIX.
2. If `sphinxDoctor.*` settings show as Unknown Configuration Setting, Sphinx Doctor is probably not installed or not running in that window.
3. Use the self-test command first before debugging inventory discovery.

The installed VSIX lane is usually easier when the goal is normal editor use rather than extension internals debugging.

## Watch Mode

Sphinx Doctor now includes a passive watch mode intended to feel closer to a linter than a one-shot command runner.

On activation, if watch mode is enabled, the extension:

- discovers configured and likely Sphinx projects from the open workspace folders only
- checks each project's `.sphinx-diagnostics/latest.json` mirror first
- falls back to configured inventory artifacts such as `issues.vscode.json` or `issues.json`
- publishes native VS Code Problems diagnostics automatically when enriched diagnostics are available
- starts file watchers for mirror and inventory artifacts so Problems refresh when those files change

If `sphinxDoctor.refresh.autoRunOnStartup` is enabled, Sphinx Doctor can also run one startup refresh per known project in a trusted workspace. If `sphinxDoctor.refresh.autoRunOnSave` is enabled, Sphinx Doctor can run a debounced project refresh after saving a relevant file such as `.py`, `.rst`, `.md`, `conf.py`, `Makefile`, or `pyproject.toml`.

Refresh-on-save is intentionally conservative:

- it is disabled by default
- it is blocked in untrusted workspaces
- it ignores files under `.sphinx-diagnostics/` to avoid refresh loops
- it refreshes only the project that owns the saved file
- it debounces repeated saves
- it skips overlapping refresh runs for the same project

If the newest available artifact is raw `issues.json`, watch mode does not execute Python unless all of the following are true:

- the workspace is trusted
- `sphinxDoctor.enrichment.enabled` is true
- `sphinxDoctor.enrichment.autoRun` is true

Otherwise Sphinx Doctor logs that raw diagnostics were found and leaves enrichment as a manual command.

## Activation Behavior

The extension now activates from a conservative set of workspace and editor signals:

- `onStartupFinished`
- `onLanguage:python`
- `workspaceContains:docs/conf.py`
- `workspaceContains:doc/conf.py`
- `workspaceContains:source/conf.py`
- `workspaceContains:conf.py`

These events were chosen to cover the common Sphinx and Python-docs cases without adding a full language server or background Sphinx execution.

## Project Settings

Project-aware loading reads `sphinxDoctor.projects` from workspace settings. Each configured project names the source workspace folder, the inventory workspace folder, the repo root, and a narrow set of inventory search globs. Projects can also define an optional `refresh` block for the external producer command.

For the stable shared workspace, the preferred path is to rely on extension defaults and workspace discovery instead of pinning temporary cleanup worktrees in the tracked workspace file. Explicit `sphinxDoctor.projects` entries are still useful for local one-off cleanup sessions, but they should not be committed as permanent shared workspace state.

Enrichment is explicit. `Sphinx Doctor: Load Project Diagnostics` only publishes already-enriched diagnostics. `Sphinx Doctor: Enrich and Load Project Diagnostics` is the trusted command that runs the local Python CLI when the newest inventory file is raw `issues.json`.

Example:

```json
{
	"sphinxDoctor.projects": [
		{
			"id": "keripy",
			"label": "keripy",
			"sourceWorkspaceFolder": "02-keripy",
			"inventoryWorkspaceFolder": "01-keri-notes",
			"repoRoot": ".",
			"docsRoot": "docs",
			"inventorySearchGlobs": [
				"tmp/sphinx-inventory-keripy-sphinx-unexpected-indentation-batch-01-*/report/issues.vscode.json",
				"tmp/sphinx-inventory-keripy-sphinx-unexpected-indentation-batch-01-*/report/issues.json"
			],
			"preferredInventoryFiles": [
				"issues.vscode.json",
				"issues.json"
			],
			"mirrorRoot": ".sphinx-diagnostics",
			"refresh": {
				"enabled": true,
				"cwdWorkspaceFolder": "01-keri-notes",
				"command": "bash",
				"args": [
					"Devtools/sphinx/run_sphinx_inventory.sh",
					"--repo-root",
					"libs/keripy",
					"--python",
					"libs/keripy/.venv-docs/bin/python",
					"--category",
					"unexpected-indentation",
					"--context-lines",
					"16"
				],
				"expectedOutputGlobs": [
					"tmp/sphinx-inventory-keripy-*/report/issues.vscode.json",
					"tmp/sphinx-inventory-keripy-*/report/issues.json"
				]
			}
		}
	]
}
```

The extension uses Problems as the immediate navigation surface. A later slice can still write `.sphinx-diagnostics/latest-for-ai.md` as a stable Copilot summary artifact.

Enrichment writes mirror artifacts into the analyzed repo, not the extension repo. For a project like `02-keripy`, the enriched archive lands under `02-keripy/.sphinx-diagnostics/runs/<run-id>/enriched.json`, and `02-keripy/.sphinx-diagnostics/latest.json` is updated alongside it.

Python execution is blocked in untrusted workspaces. Read-only loading of already-enriched JSON remains available.

Watch mode settings:

```json
{
	"sphinxDoctor.discovery.excludeWorkspaceFolders": [
		"01-keri-notes",
		"11-sphinx-doctor",
		"20-billing-ops-tasks"
	],
	"sphinxDoctor.watch.enabled": true,
	"sphinxDoctor.watch.autoLoadOnStartup": true,
	"sphinxDoctor.watch.debounceMs": 750,
	"sphinxDoctor.enrichment.autoRun": false,
	"sphinxDoctor.refresh.autoRunOnStartup": false,
	"sphinxDoctor.refresh.autoRunOnSave": false,
	"sphinxDoctor.refresh.debounceMs": 1500
}
```

## Auto-Refresh On Save

Auto-refresh on save is opt-in because it runs the local Sphinx refresh command.

Example settings:

```json
{
	"sphinxDoctor.refresh.autoRunOnSave": true,
	"sphinxDoctor.refresh.debounceMs": 1500
}
```

Load the focused diagnostics lane first. Then fix a docstring and save. Sphinx Doctor refreshes the owning project, focused single-category baselines preserve their scope, and the parity guard blocks promotion if the refreshed run expands the issue universe too much.

The status bar keeps the watch result visible with short states such as `Sphinx Doctor: idle`, `Sphinx Doctor: no diagnostics`, `Sphinx Doctor: 30 issues`, or `Sphinx Doctor: error`.

## Workspace Discovery

Workspace discovery is bounded to the folders currently open in VS Code. Sphinx Doctor only discovers repos from high-confidence Sphinx `conf.py` markers such as `docs/conf.py`, `docs/source/conf.py`, `doc/conf.py`, `source/conf.py`, and `conf.py`.

Folders without those markers are skipped instead of being guessed from looser hints such as `Makefile`, `requirements.txt`, or `pyproject.toml`. Discovery logs explain whether each workspace folder was included or skipped and why.

Discovery exclusions can be configured through `sphinxDoctor.discovery.excludeWorkspaceFolders`. For the shared KERI workspace, a typical exclusion set is:

```json
{
	"sphinxDoctor.discovery.excludeWorkspaceFolders": [
		"01-keri-notes",
		"11-sphinx-doctor",
		"20-billing-ops-tasks"
	]
}
```

These exclusions prevent workspace-control, extension-dev, and private-ops folders from being treated as source repos even if they contain Sphinx-looking files.

Discovered projects can search both their own `.sphinx-diagnostics/` mirror and selected shared inventory roots such as `01-keri-notes/tmp/`, but the extension never scans outside the current workspace folders.

When Sphinx Doctor finds inventory artifacts under a shared root such as `01-keri-notes/tmp/`, it does not blindly assume they belong to the first matching repo. Raw inventory files are checked against their recorded `repo_root`, and enriched contracts are checked against their recorded `sourceWorkspaceFolder`. If those bindings do not match the open source workspace folder, the artifact is rejected and reported instead of being silently published into the wrong repo.

## Stable Artifact Smoke

Watch mode only publishes Problems automatically when it can load a compatible enriched artifact.

For the stable KERI workspace, that means `02-keripy` needs an enriched mirror artifact at `libs/keripy/.sphinx-diagnostics/latest.json` whose source binding targets `02-keripy`.

Old inventories created for `libs/keripy-sphinx-unexpected-indentation-batch-01` are intentionally rejected once `13-keripy-sphinx-batch-01` has been removed from the shared workspace. Do not fake-bind those old temp-worktree artifacts to `02-keripy`.

If the self-test diagnostic appears but watch mode still shows no Problems for Keripy, the next thing to verify is either the presence and binding of `libs/keripy/.sphinx-diagnostics/latest.json` or the result of `Sphinx Doctor: Refresh Project Diagnostics`.

## Troubleshooting

- If two extension-host debug sessions are running, use `Debug: Stop` or `Debug: Stop All` until both sessions are gone, then start only one `Run Sphinx Doctor Extension Host` session.
- Do not use `Add Config (02-keripy)` when you want to run Sphinx Doctor.
- Do not edit `02-keripy/.vscode/launch.json` to test this extension.
- If `sphinxDoctor.*` settings are unknown in a window, the extension is not installed or not running in that window.
- If the self-test appears but real Sphinx problems do not, the Problems publishing surface works and the remaining issue is the refresh or producer path.
- If `refresh.autoRunOnSave` is enabled and saving files causes too much churn, turn it back off and use `Sphinx Doctor: Refresh Project Diagnostics` manually while keeping artifact watching enabled.

## Near-Term Next Step

The next implementation slice should expand the same refresh and artifact workflow to additional repos such as `hio`, `locksmith`, `witness-hk`, and the rest of the shared workspace without weakening the current compatibility checks.
