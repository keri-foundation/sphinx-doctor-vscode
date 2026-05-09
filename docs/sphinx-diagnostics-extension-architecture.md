# Sphinx Diagnostics Extension Architecture Specification

## Executive Summary

The recommended design is a two-layer system, not a problem-matcher-only setup. The first layer is a Python enrichment step, `Devtools/sphinx/enrich_sphinx_issues_for_vscode.py`, that converts existing Sphinx inventory output into a versioned, source-enriched JSON contract. The second layer is a local TypeScript VS Code extension that loads that JSON, publishes a `DiagnosticCollection`, renders a grouped Tree View, writes stable AI-readable packets, and optionally runs the inventory command through a configured process or task. This choice matches the strengths of VS Code’s direct diagnostics APIs, while avoiding the main limitation of task problem matchers: they are regex-driven and can capture file/location/severity/message fields, but they do not provide a post-processing enrichment layer for converting object-relative docstring lines into physical source ranges. citeturn30view0turn31view0turn31view2turn39view1turn39view2

Problem matchers are still worth using in a Phase Zero baseline, because VS Code can scan task output and report problems inline and in the Problems panel, and newer VS Code agent workflows can use problem-matcher diagnostics when an agent runs a task. But that should remain auxiliary. Your hard case is not “parse compiler-like output”; it is “map a Sphinx/autodoc issue for object `X`, docstring line `Y`, into a reliable source range in Python file `Z`.” That is a data-enrichment problem, not a regex problem. citeturn28view0turn39view2turn40view1turn20view0turn37view0

The canonical source of truth for the extension should be a predictable workspace file contract such as `.sphinx-diagnostics/latest.json` and `.sphinx-diagnostics/latest-for-ai.md`, with archived per-run artifacts under `.sphinx-diagnostics/runs/<run-id>/`. That design is more robust for both humans and entity["software","GitHub Copilot","AI coding assistant"] than terminal-only output, because current Copilot context features are documented around files, folders, symbols, prompt files, and explicitly attached Problems entries; they do not document Output channels or arbitrary extension-private state as durable context surfaces. Problems can be attached to chat with `#problems`, but stable Markdown and JSON files remain the most reliable AI contract. citeturn33view4turn33view5turn33view6turn40view0

The first implementation slice should therefore be the enrichment script, not the extension UI. It unlocks the rest of the architecture: once the repo can emit `issues.vscode.json` with physical source ranges and mapping confidence, the extension becomes straightforward plumbing over stable data instead of speculative log interpretation. A deeper Sphinx-side structured capture hook is worth considering later, using Sphinx’s logging API and `autodoc-process-docstring` event to improve exactness for transformed docstrings, but it should not block the first slice. citeturn21view0turn20view0turn21view3

## Research Basis and Problem Statement

### Problem Statement

The workflow described in the project context is slow because the most important information is not being expressed in the UI surface where developers actually work: the source editor and Problems panel. Existing Sphinx inventory artifacts already provide useful structured data, but the missing step is a trustworthy mapping from object-relative docstring warning lines to physical source ranges in Python files. Without that mapping, both human review and AI review spend time reconstructing context that should have been materialized once and reused everywhere.

This is specifically a diagnostics-integration problem across four systems: entity["software","Sphinx","Python documentation generator"] warning production, entity["software","Docutils","reStructuredText processing system"] error semantics, Python AST-based source mapping, and VS Code diagnostics/view infrastructure. The right architecture is therefore not “a prettier terminal”; it is “a structured diagnostics pipeline.”

### Research Sources Consulted

This specification is grounded primarily in official VS Code documentation for diagnostics, programmatic language features, Tree Views, Webviews, tasks and problem matchers, multi-root workspaces, Workspace Trust, and extension testing; official Sphinx documentation for logging, warning files, warning categories, events, and autodoc; official Python documentation for `ast` and `inspect`; the OASIS SARIF specification; and marketplace or project documentation for relevant prior-art extensions such as entity["software","Esbonio","Sphinx language server"], entity["software","reStructuredText","Visual Studio Code extension"], entity["software","Error Lens","VS Code inline diagnostics extension"], entity["software","SARIF Viewer","Visual Studio Code SARIF extension"], and entity["software","SARIF Explorer","VSCode static-analysis triage extension"]. citeturn29view0turn29view1turn28view5turn28view6turn28view0turn28view2turn28view3turn28view4turn21view0turn21view1turn21view2turn20view0turn37view0turn35view1turn11search3turn10search0turn9search3turn9search1turn11search4turn11search2

### Existing VS Code Capabilities

VS Code already exposes exactly the primitives this project needs. A direct diagnostics implementation can use `vscode.languages.createDiagnosticCollection`, set diagnostics for any file URI, and populate problems for resources across the workspace, not only open editors. Diagnostics carry ranges, severity, source labels, codes, and related information, and are the native bridge to editor squiggles and the Problems panel. citeturn30view0turn31view0turn31view2

For grouped navigation, the Tree View API is the right native surface. Views can live in an existing or custom view container, users can move view containers between the sidebar and panel, `TreeItem` entries can have tooltips and commands, and `TreeView.reveal()` supports programmatic reveal/selection when the provider implements `getParent`. VS Code’s own UX guidance explicitly recommends Tree Views for displaying data and warns against deep nesting and unnecessary custom webviews. citeturn28view5turn32view0turn32view1turn32view2turn32view4turn32view5

For command-driven interactions, Quick Picks are appropriate for transient selection flows, and Output channels are the native logging surface. Recent VS Code releases also provide a dedicated `LogOutputChannel` flavor rather than treating logs as generic output. Status bar items are possible, but the UX guidance is conservative: keep them short, sparse, and workspace-relevant. citeturn28view7turn28view8turn28view9turn33view0turn33view1turn33view2

VS Code tasks and problem matchers are useful, but their model is intentionally shallow. A problem matcher defines regex patterns for file, location, severity, code, and message fields, plus filename interpretation and background-task detection. That makes them good for compiler-like logs, but there is no documented transformation layer where a matcher can say “object `keri.core.coring.Tholder`, docstring line `11`, please parse AST and compute source line `4339`.” citeturn39view1turn39view2turn39view3

### Existing Sphinx and reStructuredText Tooling

Sphinx’s warning model is richer than plain stderr text suggests. Sphinx’s logging API accepts warning categories (`type`, `subtype`) and a `location`, and that location can be a docname, a `(docname, line)` tuple, or a node. Sphinx can also write warnings and errors to a file with `-w/--warning-file`, and warning categories can be surfaced via `show_warning_types`, which is now enabled by default. These are strong signals that a structured, file-based warning pipeline is aligned with Sphinx itself rather than fighting it. citeturn21view0turn21view1turn21view2

Autodoc is the part that makes your problem unusual. `sphinx.ext.autodoc` imports the modules being documented, which means builds can execute import side effects. Its `autodoc-process-docstring` event exposes the fully qualified object name, the object kind, the object itself, and the processed docstring lines that Sphinx is about to emit. That event is the key official hook for any future exact mapping extension, because it sits at the boundary where object identity and processed docstring text are both visible. citeturn19view0turn20view0

Sphinx’s history also shows that autodoc/docutils line reporting in included docstrings has been tricky in practice: the changelog explicitly records fixes for “strange reports of line numbers for warnings generated from autodoc-included docstrings.” That historical evidence is not a reason to avoid the project; it is a reason to avoid a log-only architecture and to preserve explicit confidence metadata in your mapping layer. citeturn5search4

Prior art confirms the gap. Esbonio is a language server for Sphinx documentation projects and already reports some Sphinx config/build errors as diagnostics, which makes it a valuable architectural precedent. The reStructuredText extension stack is useful for authoring `.rst` files. Error Lens is useful for making any diagnostics more visible inline, but it does not generate diagnostics itself. SARIF Viewer and SARIF Explorer show that VS Code can review external static-analysis results effectively when those results are in the right structured form. None of these tools directly solve your exact need: loading existing Sphinx inventory JSON, enriching Python docstring object-relative lines, and publishing them as native VS Code diagnostics with AI-readable repo-local packets. citeturn10search0turn10search2turn10search3turn9search0turn9search3turn9search1turn11search4turn11search2

## Architecture Options and Decision Matrix

### Problem Matcher Only

A problem-matcher-only architecture is the simplest baseline. VS Code tasks can scan terminal output and surface problems inline and in the Problems panel, and problem matchers can interpret relative paths, absolute paths, or even search filenames deeply. This makes them appropriate for a quick experiment around direct `.rst` warnings or straightforward `file:line:message` output. citeturn28view0turn39view0turn39view1turn39view2

It is not sufficient for your primary use case. The matcher schema captures regex groups for filename, line/column or range, severity, code, and message. It does not model object identity, docstring-relative lines, AST enrichment, mapping confidence, per-run metadata, or AI packet generation. You could sometimes push approximate file-level warnings into Problems, but you would still need a second system for the hard cases, which means “problem matcher only” is not actually a complete architecture. citeturn39view1turn39view2

**Recommendation:** useful for Phase Zero validation, not recommended as the primary design.

### Direct Diagnostics Extension

A direct extension that reads JSON and publishes diagnostics through `createDiagnosticCollection` is the simplest robust architecture. It natively supports unopened files, exact ranges, source labels, related information, and custom code identifiers. It also unlocks Tree Views, commands, output channels, and stable AI packets without requiring a separate language server protocol implementation. citeturn30view0turn31view0turn31view2turn28view5turn28view7

This option fits your workflow especially well because the source of truth is already near-structured: `issues.json` exists today, and the missing capability is enrichment. Once enrichment exists, the extension is mostly presentation and orchestration. citeturn20view0turn37view0

**Recommendation:** recommended MVP and still likely the best long-term architecture for this repository-specific workflow.

### Full Language Server

A full language server is justified when language analysis is expensive, when the same server should be reusable across editors, or when the editing experience requires live semantic services such as completions, definitions, hover, and on-type diagnostics. VS Code’s own documentation frames LSP as the right abstraction when a heavy or reusable analysis engine is needed across tools. citeturn29view0turn29view1turn38search14

Your current problem does not require that overhead. This is not a general-purpose Python or reStructuredText language service. It is a workspace-integrated diagnostics consumer for externally produced inventories, with some source enrichment. A full LSP would add protocol, client/server lifecycle, and synchronization complexity before it delivers user value. It becomes attractive only if later phases evolve into on-save revalidation, cross-editor reuse, or deep integration with live Sphinx project semantics. citeturn29view0turn29view1

**Recommendation:** overkill for MVP; revisit only if the product scope expands far beyond inventory-driven review.

### Existing Extension Integration

Existing extensions are valuable references but not sufficient foundations. Esbonio proves that Sphinx-oriented diagnostics via an LSP-style stack are feasible. The reStructuredText stack proves there is an audience for documentation-centric VS Code tooling. Error Lens proves that once your extension emits proper diagnostics, inline visibility can be enhanced without your code having to implement that UI itself. SARIF Viewer proves that external analysis results can appear as squiggles, Problems, and a dedicated results panel when the data contract is strong. citeturn10search0turn10search2turn9search3turn9search1turn11search4

But reuse is partial, not foundational. None of these tools are shaped around your existing `issues.json` harness, Python-object source mapping, or AI packet workflow. The right move is to build a custom extension and borrow ideas, not to twist the workflow into one of these products’ assumptions. citeturn10search0turn9search3turn11search2

**Recommendation:** reuse ideas, not architecture.

### SARIF-First or Webview-First

A SARIF-first approach is attractive because SARIF is a standard interchange format for static analysis, the OASIS spec supports physical locations and logical locations, and the VS Code SARIF Viewer already renders results as squiggles, in Problems, and in a dedicated results panel. citeturn11search3turn27search4turn11search4

Even so, SARIF should be a secondary export, not your canonical schema. SARIF is verbose, optimized for broad interoperability, and not naturally shaped around repo-specific fields such as `docstring_line`, `mapping.confidence`, `source_mapping_reason`, AI packet selection state, or run-local inventory directories. A webview-first approach has a similar problem: it can provide a rich dashboard, but VS Code’s UX guidance says to limit custom webview views, and a dashboard-first design misses the native Problems panel and editor squiggles that users will reach for first. citeturn32view4turn28view6

**Recommendation:** optional SARIF export later; webview only after native surfaces are already strong.

### Decision Matrix

**Problem matcher only:** simple, cheap, and useful as a baseline; weak on object-line mapping; not recommended as the main architecture. citeturn28view0turn39view2

**Direct diagnostics extension:** best alignment with the problem; supports native Problems/editor surfaces, file-based reports, and custom grouping; recommended for MVP and likely for the long term. citeturn30view0turn31view0turn28view5

**Full LSP server:** strongest if the scope expands into reusable, heavy, live language analysis; too heavy for the current inventory-centric workflow. citeturn29view0turn29view1

**Existing extension integration:** good inspiration, poor fit as a complete solution. citeturn10search0turn11search4

**Webview dashboard first:** visually rich, native-workflow-poor; defer. citeturn32view4turn28view6

## Recommended Architecture

### Recommended System Architecture

Build a two-layer system:

1. `Devtools/sphinx/enrich_sphinx_issues_for_vscode.py`
2. a local TypeScript VS Code extension in `tools/vscode-sphinx-diagnostics/`

The Python layer transforms raw inventory data into a canonical `issues.vscode.json` contract with exact or approximate source ranges, mapping confidence, stable IDs, summary counts, and enough metadata for AI packet generation. The extension layer consumes only that contract. It should not try to rediscover mapping logic from raw logs. This makes the system testable, debuggable, and resilient to terminal flakiness. citeturn30view0turn31view0turn37view0turn33view4turn33view5

A future third layer is optional, not foundational: a small Sphinx-side structured capture hook that records per-object processed docstring lines during the build by using `autodoc-process-docstring`, and optionally records structured warnings through the logging API. That would improve exactness when docstrings are transformed by Napoleon or other preprocessors, but the project should not wait for it before shipping the enrichment-based MVP. citeturn20view0turn21view0turn21view3

### Technical Architecture Specification

The extension package should live under `tools/vscode-sphinx-diagnostics/`, not under `.vscode/` and not inside `Devtools/`. VS Code extensions are normal packages with a `package.json` manifest, activation events, contribution points, and an entry module; keeping the extension in `tools/` gives it a clean lifecycle and avoids mixing editor configuration with extension source. The Python helper should stay under `Devtools/sphinx/` because it belongs to the existing Sphinx harness and should be runnable independently of VS Code. citeturn15search16turn14search18

Recommended layout:

```text
Devtools/sphinx/
  schema/
    sphinx-diagnostics-v1.schema.json
  enrich_sphinx_issues_for_vscode.py
  fixtures/
    coring/
      issues.json
      issues.vscode.json
      src/

tools/vscode-sphinx-diagnostics/
  package.json
  tsconfig.json
  src/
    extension.ts
    config.ts
    models/
      issue.ts
      schema.ts
    inventory/
      locateLatest.ts
      loadInventory.ts
      latestMirror.ts
    diagnostics/
      collection.ts
      mapper.ts
      severity.ts
    tree/
      SphinxDiagnosticsProvider.ts
      nodes.ts
    commands/
      loadLatestInventory.ts
      loadInventoryFile.ts
      refreshDiagnostics.ts
      clearDiagnostics.ts
      runInventory.ts
      writeAiReviewPacket.ts
      copyCurrentDiagnosticContext.ts
      compareWithPreviousRun.ts
    runner/
      executeConfiguredRun.ts
    output/
      log.ts
      channel.ts
    ai/
      packet.ts
      markdown.ts
    workspace/
      folders.ts
      paths.ts
      trust.ts
    test/
      extension.test.ts
      fixtures.test.ts
```

The extension entry point should register commands, a `DiagnosticCollection`, a Tree Data Provider, an output/log channel, and a file watcher limited to configured inventory/report files. It should also declare limited Workspace Trust support in `package.json`, disabling execution features in untrusted workspaces but allowing read-only inventory loading. VS Code’s workspace trust model explicitly supports this “limited” posture. citeturn28view3

### Data Contract and JSON Schema

The canonical contract should be a custom, versioned JSON schema named `sphinx-diagnostics-v1`, not raw LSP JSON and not SARIF as the primary on-disk contract. LSP diagnostics are transport objects, not archival contracts. SARIF is valuable because it can represent result files, regions, and logical locations, and existing viewers can consume it, but it is not the best canonical shape for your repo-specific enrichment metadata. The right compromise is: custom JSON first, optional SARIF export later. citeturn38search0turn11search3turn27search4turn11search4

Recommended canonical example:

```json
{
  "schema": "sphinx-diagnostics-v1",
  "schema_version": 1,
  "generated_at": "2026-05-08T18:28:00Z",
  "tool": {
    "name": "sphinx-diagnostics-enricher",
    "version": "0.1.0"
  },
  "workspace": {
    "workspace_folder": "control-repo",
    "repo_root": "libs/keripy",
    "inventory_dir": "tmp/sphinx-inventory-keripy-sphinx-unexpected-indentation-batch-01-20260508-182800"
  },
  "run": {
    "id": "20260508-182800",
    "source": "external-inventory"
  },
  "summary": {
    "total": 157,
    "by_severity": {
      "error": 91,
      "warning": 66
    },
    "by_category": {
      "unexpected-indentation": 30
    }
  },
  "issues": [
    {
      "id": "sha1:...",
      "path": "src/keri/core/coring.py",
      "uri": "file:///.../src/keri/core/coring.py",
      "severity": "error",
      "category": "unexpected-indentation",
      "message": "Unexpected indentation",
      "raw": "...",
      "object_name": "keri.core.coring.Number",
      "object_kind": "class",
      "docstring_line": 19,
      "source_range": {
        "start_line": 1684,
        "start_character": 8,
        "end_line": 1684,
        "end_character": 80
      },
      "mapping": {
        "status": "mapped",
        "confidence": "high",
        "strategy": "ast-docstring",
        "reason": "Mapped fully qualified object to AST ClassDef docstring"
      }
    }
  ]
}
```

The extension should mirror the latest loaded or generated contract into a stable workspace path such as `.sphinx-diagnostics/latest.json`, plus `.sphinx-diagnostics/latest.md` and `.sphinx-diagnostics/latest-for-ai.md`. This stable directory should be the official AI and human interface, while the original `tmp/sphinx-inventory-*` directories remain immutable run artifacts. That separation keeps `tmp/` large and disposable, while `.sphinx-diagnostics/` stays predictable and small. citeturn33view4turn33view5

Optional later: emit `.sphinx-diagnostics/latest.sarif` as a compatibility export. That lets the team experiment with SARIF Viewer or external code-scanning workflows without forcing SARIF’s data model into the core pipeline. citeturn11search3turn11search4

### Source Mapping Algorithm

The enrichment algorithm should be static-first, conservative, and confidence-scored.

**Primary strategy.** Parse the Python file with `ast.parse()`. Build an index of all docstring-bearing hosts: `Module`, `ClassDef`, `FunctionDef`, and `AsyncFunctionDef`. Python’s AST gives each statement/expression node `lineno`, `col_offset`, `end_lineno`, and `end_col_offset`, and `ast.get_docstring()` and `ast.get_source_segment()` let you retrieve the cleaned docstring and the corresponding source segment. That is enough to create a deterministic mapping engine for conventional docstrings. citeturn37view0turn36view0turn36view2turn36view3

**Object resolution.** Derive the module prefix from the file path, then compute fully qualified names by walking the AST with lexical nesting. For example, `src/keri/core/coring.py` becomes module `keri.core.coring`, and class/method/function nodes underneath become `keri.core.coring.Tholder`, `keri.core.coring.Tholder.__init__`, and so on. Decorated functions, including `@property` accessors, are still `FunctionDef` or `AsyncFunctionDef` nodes and can be indexed by name; `decorator_list` is available in the AST if special handling is needed for property-like labeling. citeturn36view3turn35view1

**Docstring host detection.** For each matched object, locate the docstring-bearing first body statement. If the first body element is a string-expression docstring, use the docstring expression’s source range as the base span. If not, fall back to the object definition node’s range. Module docstrings are handled the same way by checking the `Module` body. `ast.get_docstring()` supports exactly `Module`, `ClassDef`, `FunctionDef`, and `AsyncFunctionDef`, which aligns with the initial scope of this tool. citeturn36view0turn37view0

**Line mapping.** The input `docstring_line` should be interpreted as a logical line in the cleaned docstring, not blindly as a physical source line. The mapper should therefore generate a cleaned-docstring-to-source-line map by combining the docstring source segment, the evaluated docstring value, and `inspect.cleandoc()` semantics. If the cleaned mapping lands unambiguously inside the docstring literal’s source span, emit an exact `source_range` for that physical line. If the logical line cannot be mapped precisely, emit the full docstring-range or object-range anchor instead and lower the confidence. The key is to be honest rather than over-precise. citeturn37view0turn35view1

**Confidence levels.**
- `high`: exact fully qualified object match plus exact docstring line mapping within the docstring literal.
- `medium`: exact object match but only approximate line anchor, usually the start of the docstring block or object block.
- `low`: file matched but object unresolved; anchor to the nearest plausible definition or the original source file line if present.
- `none`: path unresolved or file unreadable; keep the issue in the run and tree view but publish either no diagnostic or a file-top diagnostic, depending on configuration.

**Failure modes.** Ambiguity will come from nested definitions with repeated names, generated members, inherited docstrings, re-exported objects, doc comments for attributes rather than standard docstrings, and docstrings modified by Sphinx extensions before they are parsed. The script should never silently “upgrade” confidence in these cases. It should record `mapping.reason` precisely and prefer a coarser but truthful anchor. citeturn20view0turn19view0

**Runtime fallback.** A runtime import-based fallback using `inspect.getsourcefile()` and `inspect.getsourcelines()` should be optional and disabled by default. It can help for unusual descriptors or aliasing, but importing modules may execute code, and Sphinx’s own autodoc docs warn about import side effects. In a trusted workspace with an explicitly configured interpreter, this may be a reasonable opt-in escape hatch; it is not a safe default. citeturn19view0turn35view1

### Diagnostics Provider Design

The extension should publish diagnostics from the enriched JSON only. Each issue becomes one `vscode.Diagnostic` with:

- `range`: enriched source range if available, otherwise fallback anchor.
- `severity`: mapped from normalized issue severity.
- `source`: `"sphinx-diagnostics"`.
- `code`: preferably the category, or an object `{ value: category, target: <local or docs uri> }`.
- `relatedInformation`: entries for original inventory line, object declaration line, or report file path when useful.

This is a good fit for the VS Code API, which explicitly supports `source`, `code`, and `relatedInformation` on diagnostics. Using a stable source string also makes the Problems panel filterable through `source:sphinx-diagnostics`. citeturn31view0turn31view1turn31view2turn33view3

Severity mapping should be conservative: `error` and `severe` map to `DiagnosticSeverity.Error`; `warning` to `Warning`; `info` to `Information`; anything explicitly informational-but-actionable can use `Hint` later. Do not synthesize Hints in MVP unless the source system actually distinguishes them.

## Product and UX Specification

### Product Requirements

The primary personas are a documentation maintainer fixing Sphinx/docutils issues manually, a code reviewer using VS Code’s native Problems/editor surfaces, and an AI-assisted reviewer using Copilot with stable workspace files rather than terminal transcripts.

The MVP scope should include: loading enriched inventories, publishing diagnostics for all relevant files, grouped tree navigation, stable AI packet generation, output/log recording, and explicit refresh/clear commands. Non-goals for MVP should include broad automatic fixes, speculative source edits, marketplace publishing, and any feature that relies on hidden extension-only state. VS Code’s diagnostics and Tree View APIs already cover the human-facing core, and Copilot’s context model strongly favors explicit files and attached Problems over hidden tool memory. citeturn30view0turn28view5turn33view4turn40view0

Acceptance criteria for MVP should be concrete: a newly generated `issues.vscode.json` must populate diagnostics for unopened files in the workspace, must label diagnostics with a consistent source, must let the user navigate from Problems to a source range, must render a grouped sidebar without excessive nesting, and must write `.sphinx-diagnostics/latest-for-ai.md` deterministically. VS Code’s programmatic diagnostics guidance explicitly calls out workspace-wide reporting as the advanced target, not just open editors. citeturn30view0

### UX Surface Specification

**Problems panel and editor squiggles.** This is the primary UX surface for MVP. It is native, familiar, directly anchored to file ranges, compatible with `#problems` in Copilot chat, and automatically benefits from any extension the user already has that enhances diagnostics visibility, such as Error Lens. citeturn30view0turn40view0turn9search1

**Tree View sidebar.** This is the primary secondary surface. Use a custom view container called “Sphinx Diagnostics” with one main Tree View and a small toolbar. Do not create a five-level nested tree to expose run → severity → category → file → object → issue all at once; VS Code’s UX guidance warns against deep nesting. Instead, offer grouping modes such as File, Category, Object, Severity, and Run, with each mode producing at most three levels before leaf issues. citeturn32view0turn32view4

**Output/Log channel.** This is recommended for run logs and load diagnostics logs, especially when inventory loading fails or the configured runner exits non-zero. Use a log output channel, but treat it as a human/debugging aid, not the primary AI interface. citeturn28view7turn33view0turn33view1

**Quick Pick commands.** Recommended for transient workflows such as selecting among recent runs, choosing grouping modes, or jumping to the next unresolved category. They are appropriate because Quick Picks are meant for action selection and filtered content choices. citeturn28view8

**Status bar item.** Optional, later-phase. A single item such as `Sphinx: 91E 66W` can be useful, but status bar clutter is easy to create and VS Code’s guidance is conservative. Do not make this an MVP dependency. citeturn28view9

**CodeLens and custom hover.** Later-phase only. Diagnostics already provide hover content, and CodeLens is best for contextual actions rather than bulk issue display. If added later, use it sparingly for object-level actions such as “Show Sphinx issues” or “Copy AI context,” not for every warning line. citeturn29view2turn29view1

**Webview dashboard.** Not recommended for MVP. Use only after the native diagnostics/tree/workflows already work, and only for richer diffs or trend visualizations that do not fit native views. VS Code UX guidance explicitly says to limit custom webview views if not necessary. citeturn32view4turn28view6

### Command Palette Specification

Recommended commands, all deterministic and workspace-scoped:

- `Sphinx Diagnostics: Load Latest Inventory`
- `Sphinx Diagnostics: Load Inventory File`
- `Sphinx Diagnostics: Refresh Diagnostics`
- `Sphinx Diagnostics: Clear Diagnostics`
- `Sphinx Diagnostics: Run Inventory`
- `Sphinx Diagnostics: Write AI Review Packet`
- `Sphinx Diagnostics: Copy Current Diagnostic Context`
- `Sphinx Diagnostics: Compare With Previous Run`
- `Sphinx Diagnostics: Change Grouping`
- `Sphinx Diagnostics: Open Latest Log`

`Run Inventory` should be hidden or disabled in untrusted workspaces. `Load Latest Inventory` and `Write AI Review Packet` can stay available in limited mode because they are read-only over existing files. citeturn28view3turn28view2

### Settings Specification

Recommended settings:

- `sphinxDiagnostics.inventory.searchGlobs`: default only explicit report patterns, not blanket `tmp/**`.
- `sphinxDiagnostics.inventory.preferredFileNames`: `["issues.vscode.json", "issues.json"]`
- `sphinxDiagnostics.inventory.mirrorDir`: default `.sphinx-diagnostics`
- `sphinxDiagnostics.grouping.default`: `file`
- `sphinxDiagnostics.maxIssuesPerFile`: sensible cap for UI responsiveness
- `sphinxDiagnostics.run.enabled`: default `false`
- `sphinxDiagnostics.run.mode`: `"task"` or `"process"`
- `sphinxDiagnostics.run.taskLabel`: optional existing task label
- `sphinxDiagnostics.run.command`: executable path only, not a shell blob
- `sphinxDiagnostics.run.args`: string array
- `sphinxDiagnostics.run.cwd`: workspace-relative path
- `sphinxDiagnostics.python.interpreter`: optional path for helper scripts
- `sphinxDiagnostics.mapping.runtimeResolution`: default `false`
- `sphinxDiagnostics.workspace.repoRoots`: array of workspace-relative roots
- `sphinxDiagnostics.workspace.docsRoots`: array or map per repo root
- `sphinxDiagnostics.workspace.inventoryRoots`: array of allowed inventory roots
- `sphinxDiagnostics.ai.packet.maxSnippetLines`: default conservative value

These settings should be marked as trust-restricted where appropriate, especially anything involving command execution or runtime imports. VS Code Workspace Trust supports restricting trust-sensitive configurations explicitly. citeturn28view3

### Core Workflows

**Load Existing Inventory.** The user runs Sphinx inventory externally; the extension finds the latest `issues.vscode.json` or a configured file; the loader mirrors it to `.sphinx-diagnostics/latest.json`; diagnostics are published; the user navigates through Problems and the tree; after rerunning inventory, the user refreshes and the extension recomputes the delta.

**Run Inventory From Extension.** The user invokes `Run Inventory`; the extension runs a configured task or executable in a trusted workspace only; logs go to the terminal and a log output channel; on completion the extension locates or expects the report file, mirrors it, reloads diagnostics, and updates the tree. If task mode is used, problem matchers may populate additional direct warnings and Copilot’s task-diagnostic awareness can help during agent runs, but the canonical refresh still comes from JSON. citeturn40view1turn28view0turn39view1

**AI Review Packet.** The user invokes `Write AI Review Packet`; the extension writes `.sphinx-diagnostics/latest-for-ai.md` containing run metadata, counts, top groups, diagnostics for the active file, source snippets, and a recommended next group. The user can then instruct Copilot to read that file or attach `#problems` alongside it. This workflow matches the documented file- and Problems-oriented context model. citeturn33view4turn33view5turn40view0

**Manual Fix Loop.** The user opens a file with diagnostics, sees squiggles and gutter markers, uses the tree to group by file or object, fixes a cluster manually, reruns inventory, and the extension shows resolved/new/persisting counts based on stable IDs.

### GitHub Copilot and AI Integration Design

Copilot compatibility should be explicit and file-based. The extension should always write these stable files:

- `.sphinx-diagnostics/latest.json`
- `.sphinx-diagnostics/latest.md`
- `.sphinx-diagnostics/latest-for-ai.md`
- `.sphinx-diagnostics/runs/<run-id>/...`

This gives the user a deterministic prompt like: “Read `.sphinx-diagnostics/latest-for-ai.md` and help me fix the top remaining issue group.” That is more reliable than asking Copilot to infer terminal history or extension-local state. VS Code’s context documentation emphasizes file and folder references, while prompt-file support gives an obvious future path for reusable review prompts. citeturn33view4turn33view5turn33view6

Problems should still be leveraged. Because VS Code now supports attaching Problems entries to chat, any diagnostic your extension publishes gains an immediate Copilot bridge without custom chat integration. That means your extension’s job is not to “teach Copilot about Sphinx”; it is to materialize high-quality native diagnostics and stable files that Copilot already knows how to consume. citeturn40view0

A useful optional enhancement is a repo-local prompt file under `.github/prompts/` that tells Copilot how to work with `.sphinx-diagnostics/latest-for-ai.md`. But this should remain optional because prompt-file discovery across parent repositories is conditional and can stop at nested `.git` boundaries, which matters in your parent-repo plus nested-repo topology. citeturn33view5turn33view6

## Operations, Security, and Quality

### Workspace and Repo Topology

The extension must assume multi-root and nested-repo reality from the start. VS Code workspaces can contain one or more folders, tasks are discovered across folders, and variables can be scoped to a specific workspace folder using `${workspaceFolder:name}`. A robust implementation therefore needs explicit workspace-folder awareness in both inventory discovery and command execution. citeturn33view8turn34view0turn33view7

Do not use Git repository discovery as the primary definition of “project root.” In your topology, the parent control repo and nested repos under `libs/` can coexist, and parent-repository AI customization discovery itself has caveats: it only walks upward until it finds a `.git` folder and requires trust on the parent repository. The extension should instead use VS Code workspace folders plus explicit settings for `repoRoots`, `docsRoots`, and `inventoryRoots`. citeturn33view6turn34view0

Inventory search must be tight. Do not recursively watch all of `tmp/`. Search only the configured inventory glob patterns, mirror a compact stable copy into `.sphinx-diagnostics/`, and compute deltas from mirrored runs. That design avoids large junk directories becoming a responsiveness problem and reduces accidental coupling to transient run folders.

### Security and Workspace Trust Design

The safe default posture is read-only-first and trust-gated execution. Workspace Trust exists precisely because extensions may run code from the current workspace, and restricted mode disables or limits tasks, terminal, agents, and extensions to reduce unintended execution risk. Since your tool may run scripts and optionally import project modules for fallback mapping, it should declare limited support in untrusted workspaces and disable those features until trust is granted. citeturn28view2turn28view3

Recommended trust posture:

- In untrusted workspaces: allow loading existing `issues.vscode.json`, publishing diagnostics, showing the tree, and writing packets from existing data.
- In untrusted workspaces: disable `Run Inventory`, runtime object resolution, and any feature that imports project code or runs workspace scripts.
- In trusted workspaces: allow explicit command execution only through user-invoked commands, never automatically on open.

Because Workspace Trust is shared with VS Code agents, this posture also aligns with AI safety: if the workspace is untrusted, agents are already restricted, so file-based diagnostics remain the right stable handoff once trust is granted. citeturn28view2

For command execution, prefer structured executable-plus-args settings and `ProcessExecution`-style launching over raw shell blobs whenever possible. If a raw shell command must be supported, it should be an advanced setting with a visible warning. Log each run with command, args, cwd, exit code, start time, and resolved report path to `.sphinx-diagnostics/logs/`. Never modify source files automatically. Future code actions must be narrow, opt-in, and explicitly previewable. VS Code supports code actions on errors and warnings, but that should come only after proven-safe patterns are identified. citeturn31view1turn29view2

### Testing Strategy

The Python enrichment layer should have fixture-based unit tests first. Use a frozen fixture centered on `coring.py`-style cases and cover exact object matches, unmapped objects, nested classes/functions, properties, decorators, module docstrings, one-line docstrings, multi-line cleaned docstrings, and ambiguous failures. Snapshot the emitted `issues.vscode.json` to catch accidental schema drift.

The extension should then have integration tests in the Extension Development Host. VS Code’s extension testing model explicitly supports integration tests with full access to the VS Code API, and `@vscode/test-electron` is the standard CI helper for running them. Test loading inventories, publishing diagnostics to unopened files, tree rendering, file navigation, clearing diagnostics, and AI packet writing. citeturn28view4turn15search11

Manual validation should include: loading the latest inventory in a multi-root workspace; verifying Problems entries filter correctly by `source:sphinx-diagnostics`; checking that clicking a leaf issue opens the expected range; verifying untrusted workspace behavior; confirming that the mirrored stable files are written deterministically; and ensuring that a rerun updates resolved/new counts without stale diagnostics remaining. citeturn33view3turn28view2

### Implementation Phases

**Phase Zero.** Build a disposable VS Code task plus problem matcher prototype against raw Sphinx output or warning-file output. Goal: learn what portion of direct file-and-line warnings can be surfaced immediately, and establish a cheap baseline. Risk: false confidence, because object-relative docstring cases will still be wrong. Acceptance: some warnings appear in Problems from a task, but the gap for docstring mapping is documented. citeturn28view0turn39view2turn21view1

**Phase One.** Build `enrich_sphinx_issues_for_vscode.py`. Goal: consume current `issues.json`, perform AST mapping, emit `issues.vscode.json`, and write schema-validated output with confidence levels. This is the highest-leverage phase because it creates the canonical data contract. Acceptance: fixture tests pass and at least one representative batch maps docstring-relative warnings to source ranges with a meaningful high-confidence rate.

**Phase Two.** Build the minimal extension. Goal: load latest enriched inventory, publish diagnostics, refresh, clear, and log. Acceptance: diagnostics are visible for unopened files and filterable by source in Problems. citeturn30view0turn33view3

**Phase Three.** Add Tree View and AI packet generation. Goal: grouped sidebar navigation and `.sphinx-diagnostics/latest-for-ai.md`. Acceptance: the user can navigate by file or category from the tree and can point Copilot at the AI packet. citeturn28view5turn33view4turn33view5

**Phase Four.** Add trusted-workspace run orchestration. Goal: invoke configured task or executable, capture logs, reload results, and compare to previous run. Acceptance: a trusted user can run the inventory from VS Code and see updated diagnostics without leaving the editor. citeturn28view2turn28view3turn40view1

**Phase Five.** Add narrow, opt-in code actions. Goal: only for proven-safe docstring normalizations, never broad rewriting. Acceptance: each action is previewable, explicitly scoped, and backed by fixtures. citeturn29view2

### Risks and Mitigations

The main risk is false precision in mapping. Mitigation: confidence levels, explicit fallback strategies, and side-by-side storage of original docstring-relative line and mapped source range.

The second risk is repo-topology confusion. Mitigation: explicit workspace-folder and repo-root settings, stable mirrored paths, and no dependence on a single flat root model. citeturn34view0turn33view7

The third risk is command-execution safety. Mitigation: Workspace Trust gating, execution disabled by default, structured args preferred over shell text, and permanent run logs. citeturn28view2turn28view3

The fourth risk is AI context drift. Mitigation: stable `.sphinx-diagnostics/` files, deterministic filenames, and a clearly documented user workflow that points Copilot to files or attached Problems rather than extension-private state. citeturn33view4turn33view5turn40view0

### Open Questions

The first open question is whether current `issues.json` line numbers always refer to processed docstring lines, or whether some categories already contain physical source lines. That answer changes how aggressively the mapper should reinterpret `line`.

The second is whether the existing harness can be amended cheaply to record richer fields such as warning code, object kind, or source snippet during extraction. If yes, Phase One becomes simpler and more accurate.

The third is whether an optional Sphinx-side capture hook should be added in a later phase to pair `autodoc-process-docstring` object maps with warning-file output for exact transformed-line mapping. The official hooks are there; the question is whether the extra build integration is worth the operational complexity. citeturn20view0turn21view0turn21view1

The fourth is whether SARIF export will be valuable in your organization. If other internal tooling already speaks SARIF, an exporter is easy to justify. If not, it should remain optional. citeturn11search3turn11search4

## Final Recommendation and First Implementation Slice Prompt

### Final Recommendation

Build a JSON-first diagnostics system centered on a Python enrichment layer and a local VS Code extension.

**Specifically:**

- Build `Devtools/sphinx/enrich_sphinx_issues_for_vscode.py` first.
- Make it emit `issues.vscode.json` using a versioned custom schema.
- Mirror the latest normalized outputs into `.sphinx-diagnostics/latest.json`, `.sphinx-diagnostics/latest.md`, and `.sphinx-diagnostics/latest-for-ai.md`.
- Build a local TypeScript extension under `tools/vscode-sphinx-diagnostics/` that loads the canonical JSON, publishes diagnostics through `createDiagnosticCollection`, exposes a Tree View, writes AI packets, and optionally runs inventory in trusted workspaces.
- Keep task problem matchers only as an auxiliary path for direct builder output, not as the source of truth.
- Defer broad code actions.
- Consider an optional later Sphinx-side structured capture hook if static AST mapping needs help for transformed docstrings. citeturn30view0turn31view0turn39view2turn20view0turn21view0

That recommendation is specific because it matches the documented capabilities and limits of VS Code, Sphinx, and Copilot. Direct diagnostics are the simplest robust way to reach native Problems/editor surfaces. Problem matchers are too shallow for object-relative line enrichment. LSP is too heavy for the current problem. Stable workspace files are the most reliable AI interface. citeturn30view0turn39view2turn29view0turn33view4turn40view0

### First Implementation Slice Prompt

```text
Mode
Specification-driven implementation slice. Do not build the VS Code extension yet. Do not edit production docs or Python source files outside the allowed files.

Goal
Build Devtools/sphinx/enrich_sphinx_issues_for_vscode.py so that it reads an existing Sphinx issues.json file, maps Python docstring/object-relative issue lines to source-line-enriched records using static AST analysis, and writes a versioned issues.vscode.json file suitable for a future VS Code diagnostics extension.

Allowed files
- Devtools/sphinx/enrich_sphinx_issues_for_vscode.py
- Devtools/sphinx/schema/sphinx-diagnostics-v1.schema.json
- Devtools/sphinx/fixtures/**
- Devtools/sphinx/tests/**
- If absolutely necessary for validation only: lightweight test runner/config files under Devtools/sphinx/

Hard non-goals
- Do not implement the VS Code extension
- Do not add marketplace publishing artifacts
- Do not add automatic source-file fixing
- Do not add runtime import-based object resolution by default
- Do not change existing project source/docstring files except fixture copies under Devtools/sphinx/fixtures/
- Do not rely on terminal parsing as the canonical output

Current context
- Existing workflow already emits issues.json records with fields like path, category, object_name, line, raw, severity
- The hard problem is that line may be object-relative to a Python docstring, not a physical source line
- The future extension will load issues.vscode.json and publish VS Code diagnostics
- The output must preserve uncertainty with mapping confidence instead of pretending every mapping is exact

Required behavior
- Accept an input path to issues.json and an output path for issues.vscode.json
- Parse Python source files with ast.parse()
- Resolve fully qualified object names from file/module path plus AST walk
- Support at minimum:
  - module docstrings
  - classes
  - functions
  - methods
  - async functions
  - properties as decorated functions
  - nested classes/functions when object_name is fully qualified
- Emit a versioned custom schema:
  - schema
  - schema_version
  - generated_at
  - summary
  - issues[]
- For each issue, emit:
  - stable id
  - path
  - uri if resolvable
  - severity
  - category
  - message
  - raw
  - object_name
  - object_kind
  - docstring_line if present
  - source_range if mapped
  - mapping.status
  - mapping.confidence
  - mapping.strategy
  - mapping.reason
- Use conservative confidence levels:
  - high
  - medium
  - low
  - none
- If exact docstring-line mapping fails, fall back to docstring block or object definition range and lower confidence
- Never silently discard issues because mapping failed
- Write deterministic JSON ordering suitable for snapshot tests

Validation commands
- Run unit tests for mapping fixtures
- Validate emitted JSON against sphinx-diagnostics-v1.schema.json
- Run the script against at least one representative fixture batch and confirm:
  - mapped issues have source_range
  - unmapped issues remain present with confidence none/low
  - summary counts match the input issue count

Final report format
Return a concise implementation report with:
- files changed
- mapping strategies implemented
- fixture cases covered
- validation commands run
- known limitations
- exact next step recommendation
```

