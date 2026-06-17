import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildWatchModeSummary,
  canAutoRunEnrichment,
  createDebouncedTrigger,
  createSingleFlightController,
  findOwningProjectForPath,
  formatWatchModeText,
  getRefreshOnSaveDebounceMs,
  getRefreshOnSaveDecision,
  hasOpenWorkspaceFolders,
  isExcludedWorkspaceFolder,
  isRelevantRefreshSavePath,
  runWatchModeStartup,
  summarizeProjectPublicationSnapshots,
} from '../src/watchModeState';

import { resolveProjectSourceRoot } from '../src/workspace/inventoryCandidates';
import type { ConfiguredProject } from '../src/types';

const configuredProject: ConfiguredProject = {
  id: 'keripy',
  label: 'keripy',
  sourceWorkspaceFolder: '02-keripy',
  inventoryWorkspaceFolder: 'example-workspace',
  repoRoot: '.',
  docsRoot: 'docs',
  inventorySearchGlobs: [
    'tmp/sphinx-inventory-keripy-sphinx-unexpected-indentation-batch-01-*/report/issues.vscode.json',
    'tmp/sphinx-inventory-keripy-sphinx-unexpected-indentation-batch-01-*/report/issues.json',
  ],
  preferredInventoryFiles: ['issues.vscode.json', 'issues.json'],
  mirrorRoot: '.sphinx-diagnostics',
};

test('project publication summaries preserve unrelated project counts during a scoped refresh', () => {
  const before = summarizeProjectPublicationSnapshots([
    {
      loaded: true,
      loadedPath: '/workspace/keripy/.sphinx-diagnostics/latest.json',
      issueCount: 6,
      publishableBeforeFilter: 4,
      publishedDiagnostics: 3,
      filteredByMode: 1,
      skippedIssues: 3,
      resolutionFailures: 0,
    },
    {
      loaded: true,
      loadedPath: '/workspace/hio/.sphinx-diagnostics/latest.json',
      issueCount: 5,
      publishableBeforeFilter: 3,
      publishedDiagnostics: 2,
      filteredByMode: 1,
      skippedIssues: 3,
      resolutionFailures: 0,
    },
  ]);

  const after = summarizeProjectPublicationSnapshots([
    {
      loaded: true,
      loadedPath: '/workspace/keripy/.sphinx-diagnostics/latest.json',
      issueCount: 2,
      publishableBeforeFilter: 1,
      publishedDiagnostics: 1,
      filteredByMode: 0,
      skippedIssues: 1,
      resolutionFailures: 0,
    },
    {
      loaded: true,
      loadedPath: '/workspace/hio/.sphinx-diagnostics/latest.json',
      issueCount: 5,
      publishableBeforeFilter: 3,
      publishedDiagnostics: 2,
      filteredByMode: 1,
      skippedIssues: 3,
      resolutionFailures: 0,
    },
  ]);

  assert.equal(before.loadedProjectCount, 2);
  assert.equal(before.issueCount, 11);
  assert.equal(before.publishedDiagnostics, 5);
  assert.equal(after.loadedProjectCount, 2);
  assert.equal(after.issueCount, 7);
  assert.equal(after.publishableBeforeFilter, 4);
  assert.equal(after.publishedDiagnostics, 3);
  assert.deepEqual(after.loadedDiagnosticsFiles, [
    '/workspace/hio/.sphinx-diagnostics/latest.json',
    '/workspace/keripy/.sphinx-diagnostics/latest.json',
  ]);
});

test('project publication summaries drop stale diagnostics when a refreshed project no longer publishes any targets', () => {
  const summary = summarizeProjectPublicationSnapshots([
    {
      loaded: false,
      issueCount: 0,
      publishableBeforeFilter: 0,
      publishedDiagnostics: 0,
      filteredByMode: 0,
      skippedIssues: 0,
      resolutionFailures: 0,
    },
    {
      loaded: true,
      loadedPath: '/workspace/hio/.sphinx-diagnostics/latest.json',
      issueCount: 5,
      publishableBeforeFilter: 3,
      publishedDiagnostics: 2,
      filteredByMode: 1,
      skippedIssues: 3,
      resolutionFailures: 0,
    },
  ]);

  assert.equal(summary.loadedProjectCount, 1);
  assert.deepEqual(summary.loadedDiagnosticsFiles, [
    '/workspace/hio/.sphinx-diagnostics/latest.json',
  ]);
  assert.equal(summary.issueCount, 5);
  assert.equal(summary.publishedDiagnostics, 2);
});

test('runWatchModeStartup does not refresh when watch mode is disabled', async () => {
  let refreshCalls = 0;

  const started = await runWatchModeStartup({
    config: {
      watchEnabled: false,
      watchAutoLoadOnStartup: true,
    },
    refresh: async () => {
      refreshCalls += 1;
    },
  });

  assert.equal(started, false);
  assert.equal(refreshCalls, 0);
});

test('runWatchModeStartup refreshes on activation when watch mode is enabled', async () => {
  const calls: Array<{ reason: string; loadDiagnostics: boolean }> = [];

  const started = await runWatchModeStartup({
    config: {
      watchEnabled: true,
      watchAutoLoadOnStartup: true,
    },
    refresh: async (reason, loadDiagnostics) => {
      calls.push({ reason, loadDiagnostics });
    },
  });

  assert.equal(started, true);
  assert.deepEqual(calls, [{ reason: 'activation', loadDiagnostics: true }]);
});

test('runWatchModeStartup can start watchers without auto-loading diagnostics', async () => {
  const calls: Array<{ reason: string; loadDiagnostics: boolean }> = [];

  const started = await runWatchModeStartup({
    config: {
      watchEnabled: true,
      watchAutoLoadOnStartup: false,
    },
    refresh: async (reason, loadDiagnostics) => {
      calls.push({ reason, loadDiagnostics });
    },
  });

  assert.equal(started, false);
  assert.deepEqual(calls, [{ reason: 'activation', loadDiagnostics: false }]);
});

test('createDebouncedTrigger coalesces multiple events into one refresh', () => {
  const pending: Array<() => void> = [];
  const reasons: string[] = [];

  const trigger = createDebouncedTrigger(
    (reason) => {
      reasons.push(reason);
    },
    750,
    {
      setTimeout: (callback) => {
        pending.push(callback);
        return callback;
      },
      clearTimeout: (handle) => {
        const index = pending.indexOf(handle as () => void);
        if (index >= 0) {
          pending.splice(index, 1);
        }
      },
    },
  );

  trigger.trigger('artifact changed: one');
  trigger.trigger('artifact changed: two');
  assert.equal(pending.length, 1);
  pending[0]();

  assert.deepEqual(reasons, ['artifact changed: two']);
});

test('isExcludedWorkspaceFolder matches configured discovery exclusions', () => {
  assert.equal(
    isExcludedWorkspaceFolder('example-workspace', ['example-workspace', 'sphinx-doctor-extension']),
    true,
  );
  assert.equal(isExcludedWorkspaceFolder('02-keripy', ['example-workspace']), false);
});

test('refresh-on-save ignores generated artifacts under .sphinx-diagnostics', () => {
  assert.equal(isRelevantRefreshSavePath('/workspace/keripy/.sphinx-diagnostics/latest.json'), false);
  assert.equal(isRelevantRefreshSavePath('/workspace/keripy/src/keri/core/coring.py'), true);
});

test('refresh-on-save ignores generated and build paths outside .sphinx-diagnostics', () => {
  assert.equal(isRelevantRefreshSavePath('/workspace/keripy/.venv-docs/bin/python'), false);
  assert.equal(isRelevantRefreshSavePath('/workspace/keripy/docs/_build/html/index.html'), false);
  assert.equal(isRelevantRefreshSavePath('/workspace/keripy/node_modules/pkg/index.js'), false);
  assert.equal(isRelevantRefreshSavePath('/workspace/keripy/src/__pycache__/mod.cpython-312.pyc'), false);
});

test('refresh-on-save treats docs config and requirements files as relevant inputs', () => {
  assert.equal(isRelevantRefreshSavePath('/workspace/keripy/docs/conf.py'), true);
  assert.equal(isRelevantRefreshSavePath('/workspace/keripy/docs/source/conf.py'), true);
  assert.equal(isRelevantRefreshSavePath('/workspace/keripy/docs/requirements-docs.txt'), true);
  assert.equal(isRelevantRefreshSavePath('/workspace/keripy/requirements.txt'), true);
  assert.equal(isRelevantRefreshSavePath('/workspace/keripy/pyproject.toml'), true);
});

test('findOwningProjectForPath resolves the matching source project', () => {
  const project = findOwningProjectForPath(
    '/workspace/keripy/src/keri/core/coring.py',
    [configuredProject, { ...configuredProject, id: 'hio', sourceWorkspaceFolder: '03-hio', label: 'hio' }],
    [
      { name: '02-keripy', fsPath: '/workspace/keripy' },
      { name: '03-hio', fsPath: '/workspace/hio' },
    ],
  );

  assert.equal(project?.id, 'keripy');
});

test('findOwningProjectForPath resolves a saved file under a worktree to the synthetic project', () => {
  const project = findOwningProjectForPath(
    '/workspace/notes/libs/keripy-docstring-koming-001/src/keri/db/koming.py',
    [
      configuredProject,
      {
        ...configuredProject,
        id: 'keripy@keripy-docstring-koming-001',
        baseProjectId: 'keripy',
        label: 'keripy-docstring-koming-001',
        sourceWorkspaceFolder: 'keripy-docstring-koming-001',
        sourceRootPath: '/workspace/notes/libs/keripy-docstring-koming-001',
      },
    ],
    [{ name: '02-keripy', fsPath: '/workspace/notes/libs/keripy' }],
  );

  assert.equal(project?.id, 'keripy@keripy-docstring-koming-001');
});

test('findOwningProjectForPath keeps canonical saved-file ownership unchanged', () => {
  const project = findOwningProjectForPath(
    '/workspace/notes/libs/keripy/src/keri/db/koming.py',
    [
      {
        ...configuredProject,
        sourceRootPath: resolveProjectSourceRoot(configuredProject, [
          { name: '02-keripy', fsPath: '/workspace/notes/libs/keripy' },
        ]),
      },
      {
        ...configuredProject,
        id: 'keripy@keripy-docstring-koming-001',
        baseProjectId: 'keripy',
        label: 'keripy-docstring-koming-001',
        sourceWorkspaceFolder: 'keripy-docstring-koming-001',
        sourceRootPath: '/workspace/notes/libs/keripy-docstring-koming-001',
      },
    ],
    [{ name: '02-keripy', fsPath: '/workspace/notes/libs/keripy' }],
  );

  assert.equal(project?.id, 'keripy');
});

test('getRefreshOnSaveDecision blocks refresh-on-save when disabled', () => {
  const decision = getRefreshOnSaveDecision(
    '/workspace/keripy/src/keri/core/coring.py',
    [configuredProject],
    [{ name: '02-keripy', fsPath: '/workspace/keripy' }],
    {
      refreshAutoRunOnSave: false,
      isWorkspaceTrusted: true,
    },
  );

  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /disabled/i);
});

test('getRefreshOnSaveDecision blocks refresh-on-save in untrusted workspaces', () => {
  const decision = getRefreshOnSaveDecision(
    '/workspace/keripy/src/keri/core/coring.py',
    [configuredProject],
    [{ name: '02-keripy', fsPath: '/workspace/keripy' }],
    {
      refreshAutoRunOnSave: true,
      isWorkspaceTrusted: false,
    },
  );

  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /trusted workspace/i);
});

test('getRefreshOnSaveDecision ignores .sphinx-diagnostics saves to avoid loops', () => {
  const decision = getRefreshOnSaveDecision(
    '/workspace/keripy/.sphinx-diagnostics/latest.json',
    [configuredProject],
    [{ name: '02-keripy', fsPath: '/workspace/keripy' }],
    {
      refreshAutoRunOnSave: true,
      isWorkspaceTrusted: true,
    },
  );

  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /not a relevant/i);
});

test('getRefreshOnSaveDecision returns the owning project for relevant saves', () => {
  const decision = getRefreshOnSaveDecision(
    '/workspace/keripy/docs/index.rst',
    [configuredProject],
    [{ name: '02-keripy', fsPath: '/workspace/keripy' }],
    {
      refreshAutoRunOnSave: true,
      isWorkspaceTrusted: true,
    },
  );

  assert.equal(decision.allowed, true);
  assert.equal(decision.project?.id, 'keripy');
});

test('save-triggered refresh uses refresh debounce instead of watch debounce', () => {
  assert.equal(
    getRefreshOnSaveDebounceMs({
      watchDebounceMs: 750,
      refreshDebounceMs: 1500,
    }),
    1500,
  );
});

test('createSingleFlightController blocks overlapping project refreshes', () => {
  const controller = createSingleFlightController();

  assert.equal(controller.tryStart('keripy'), true);
  assert.equal(controller.isRunning('keripy'), true);
  assert.equal(controller.tryStart('keripy'), false);
  controller.finish('keripy');
  assert.equal(controller.tryStart('keripy'), true);
});

test('buildWatchModeSummary returns watching state for direct-run diagnostics with no watchers', () => {
  const summary = buildWatchModeSummary({
    projectCount: 1,
    loadedProjectCount: 1,
    issueCount: 623,
    publishableBeforeFilter: 623,
    publishedDiagnostics: 623,
    watcherCount: 0,
    rawPendingCount: 0,
    errorCount: 0,
    diagnosticMode: 'layout',
  });

  assert.equal(summary.state, 'watching');
  assert.equal(summary.issueCount, 623);
  assert.equal(summary.publishedDiagnostics, 623);
  assert.equal(formatWatchModeText(summary), 'Sphinx Doctor: 623 issues');
});

test('formatWatchModeText shows issue counts for active diagnostics', () => {
  const summary = buildWatchModeSummary({
    projectCount: 2,
    loadedProjectCount: 1,
    issueCount: 30,
    publishableBeforeFilter: 18,
    publishedDiagnostics: 18,
    watcherCount: 4,
    rawPendingCount: 0,
    errorCount: 0,
    diagnosticMode: 'layout',
  });

  assert.equal(formatWatchModeText(summary), 'Sphinx Doctor: 30 issues');
});

test('buildWatchModeSummary reports no diagnostics when projects are loaded but empty', () => {
  const summary = buildWatchModeSummary({
    projectCount: 1,
    loadedProjectCount: 0,
    issueCount: 0,
    publishableBeforeFilter: 0,
    publishedDiagnostics: 0,
    watcherCount: 2,
    rawPendingCount: 0,
    errorCount: 0,
    diagnosticMode: 'reference',
  });

  assert.equal(summary.state, 'no-diagnostics');
  assert.equal(summary.diagnosticMode, 'reference');
  assert.equal(summary.publishableBeforeFilter, 0);
  assert.equal(summary.publishedDiagnostics, 0);
});

test('canAutoRunEnrichment blocks watch-mode enrichment when workspace is untrusted', () => {
  assert.equal(
    canAutoRunEnrichment(false, {
      enrichmentEnabled: true,
      enrichmentAutoRun: true,
    }),
    false,
  );
  assert.equal(
    canAutoRunEnrichment(true, {
      enrichmentEnabled: true,
      enrichmentAutoRun: true,
    }),
    true,
  );
});

test('hasOpenWorkspaceFolders reports a safe no-op when no folders are open', () => {
  assert.equal(hasOpenWorkspaceFolders([]), false);
  assert.equal(hasOpenWorkspaceFolders([{ name: '02-keripy', fsPath: '/workspace/keripy' }]), true);
});
