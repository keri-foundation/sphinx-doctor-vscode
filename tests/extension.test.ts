import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildEnrichmentRunPlan,
  buildRunId,
  buildRefreshScopeComparison,
  detectRefreshScopeDrift,
  evaluateRefreshBaselinePromotion,
  formatRefreshScopeDriftWarning,
  getEnrichmentPermission,
} from '../src/enrichmentRunner';
import { parseSphinxWarnings } from '../src/parser/SphinxWarningParser';
import {
  applyRefreshScopeToConfig,
  buildRefreshCategoryArgs,
  buildRefreshRunPlan,
  filterRecentInventoryCandidates,
  getRefreshPermission,
  inferRefreshScopeFromContract,
  inferProjectRefreshConfig,
} from '../src/refreshRunner';
import {
  ConfiguredProject,
  DiagnosticsContract,
  DiagnosticsIssue,
  issueMatchesDiagnosticMode,
  shouldPublishIssue,
} from '../src/types';
import {
  SELF_TEST_STATUS_TEXT,
} from '../src/selfTest';
import {
  selectInventoryCandidate,
} from '../src/workspace';

const contract: DiagnosticsContract = {
  schema: 'sphinx-diagnostics-v1',
  schemaVersion: 1,
  generatedAt: '2026-05-08T18:28:00Z',
  tool: { name: 'sphinx-doctor-enricher', version: '0.1.0' },
  workspace: {
    sourceWorkspaceFolder: '02-keripy',
    inventoryWorkspaceFolder: 'example-workspace',
    repoRoot: '.',
    docsRoot: 'docs',
    mirrorRoot: '.sphinx-diagnostics',
  },
  run: {
    id: 'fixture-run-001',
    source: 'external-inventory',
    inventoryFile: 'tmp/run/issues.json',
    inventoryDir: 'tmp/run',
  },
  summary: {
    total: 1,
    bySeverity: { error: 1 },
    byCategory: { 'unexpected-indentation': 1 },
    mappedCount: 1,
    unmappedCount: 0,
    publishedDiagnostics: 1,
    retainedOnly: 0,
  },
  issues: [],
};

const mappedIssue: DiagnosticsIssue = {
  id: 'demo-issue',
  severity: 'error',
  category: 'unexpected-indentation',
  code: 'docutils.unexpected-indentation',
  message: 'Unexpected indentation in autodoc docstring block.',
  raw: {},
  objectName: 'keri.core.coring.Number',
  objectKind: 'class',
  docstringLine: 6,
  sourceWorkspaceFolder: '02-keripy',
  inventoryWorkspaceFolder: 'example-workspace',
  repoRelativePath: 'src/keri/core/coring.py',
  inventoryRelativePath: 'tmp/run/issues.json',
  rawLocation: 'src/keri/core/coring.py:keri.core.coring.Number:docstring:6',
  sourceRange: {
    startLine: 13,
    startColumn: 5,
    endLine: 13,
    endColumn: 29,
    anchorKind: 'docstring-line',
  },
  mapping: {
    confidence: 'low',
    strategy: 'ast-docstring-cleaned-line',
    reason: 'demo',
    objectResolved: true,
    lineResolved: true,
  },
  publishDiagnostic: true,
  related: [],
};

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

const hioProject: ConfiguredProject = {
  id: 'hio',
  label: 'hio',
  sourceWorkspaceFolder: '03-hio',
  inventoryWorkspaceFolder: 'example-workspace',
  repoRoot: '.',
  docsRoot: 'docs',
  inventorySearchGlobs: [
    'tmp/sphinx-inventory-hio-*/report/issues.vscode.json',
    'tmp/sphinx-inventory-hio-*/report/issues.json',
  ],
  preferredInventoryFiles: ['issues.vscode.json', 'issues.json'],
  mirrorRoot: '.sphinx-diagnostics',
};

const locksmithProject: ConfiguredProject = {
  id: 'locksmith',
  label: 'locksmith',
  sourceWorkspaceFolder: '06-locksmith',
  inventoryWorkspaceFolder: 'example-workspace',
  repoRoot: '.',
  docsRoot: 'docs',
  inventorySearchGlobs: [
    'tmp/sphinx-inventory-locksmith-*/report/issues.vscode.json',
    'tmp/sphinx-inventory-locksmith-*/report/issues.json',
  ],
  preferredInventoryFiles: ['issues.vscode.json', 'issues.json'],
  mirrorRoot: '.sphinx-diagnostics',
};

const witnessProject: ConfiguredProject = {
  id: 'witness-hk',
  label: 'witness-hk',
  sourceWorkspaceFolder: '07-witness-hk',
  inventoryWorkspaceFolder: 'example-workspace',
  repoRoot: '.',
  docsRoot: 'docs',
  inventorySearchGlobs: [
    'tmp/sphinx-inventory-witness-hk-*/report/issues.vscode.json',
    'tmp/sphinx-inventory-witness-hk-*/report/issues.json',
  ],
  preferredInventoryFiles: ['issues.vscode.json', 'issues.json'],
  mirrorRoot: '.sphinx-diagnostics',
};

const configuredRefresh = {
  enabled: true,
  cwdWorkspaceFolder: 'example-workspace',
  command: 'bash',
  args: [
    'Devtools/sphinx/run_sphinx_inventory.sh',
    '--repo-root',
    'libs/keripy',
    '--python',
    'libs/keripy/.venv-docs/bin/python',
    '--context-lines',
    '16',
  ],
  expectedOutputGlobs: [
    'tmp/sphinx-inventory-keripy-*/report/issues.vscode.json',
    'tmp/sphinx-inventory-keripy-*/report/issues.json',
  ],
};

let cachedWatchModeModule: typeof import('../src/watchMode.js') | undefined;

async function loadWatchModeModule(): Promise<typeof import('../src/watchMode.js')> {
  if (cachedWatchModeModule) {
    return cachedWatchModeModule;
  }

  const moduleLoader = require('node:module') as typeof import('node:module') & {
    _load?: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
  };
  const originalLoad = moduleLoader._load;
  assert.ok(originalLoad, 'Expected node module loader to be available for vscode stubbing.');

  moduleLoader._load = ((request: string, parent: NodeModule | undefined, isMain: boolean) => {
    if (request === 'vscode') {
      return {
        ExtensionMode: {
          Production: 1,
          Development: 2,
          Test: 3,
        },
      };
    }

    return originalLoad(request, parent, isMain);
  }) as typeof originalLoad;

  try {
    const module = await import('../src/watchMode.js');
    cachedWatchModeModule = module;
    return module;
  } finally {
    moduleLoader._load = originalLoad;
  }
}

function buildSummaryContract(options: {
  total: number;
  mappedCount: number;
  retainedOnly: number;
  byCategory: Record<string, number>;
}): DiagnosticsContract {
  return {
    ...contract,
    summary: {
      total: options.total,
      bySeverity: { error: options.total },
      byCategory: options.byCategory,
      mappedCount: options.mappedCount,
      unmappedCount: Math.max(0, options.total - options.mappedCount),
      publishedDiagnostics: options.mappedCount,
      retainedOnly: options.retainedOnly,
    },
    issues: [],
  };
}

function buildCategoryScopeContract(categories: string[]): DiagnosticsContract {
  return {
    ...contract,
    summary: {
      total: categories.length,
      bySeverity: { error: categories.length },
      byCategory: categories.reduce<Record<string, number>>((counts, category) => {
        counts[category] = (counts[category] ?? 0) + 1;
        return counts;
      }, {}),
      mappedCount: categories.length,
      unmappedCount: 0,
      publishedDiagnostics: categories.length,
      retainedOnly: 0,
    },
    issues: categories.map((category, index) => ({
      ...mappedIssue,
      id: `scope-${index}`,
      category,
      code: category,
    })),
  };
}

test('troubleshoot report includes extension mode and extension path', async () => {
  const { buildTroubleshootReport } = await loadWatchModeModule();
  const report = buildTroubleshootReport({
    extensionMode: 2,
    extensionPath: '/workspace/extensions/sphinx-doctor-vscode',
    isWorkspaceTrusted: true,
    config: {
      projects: [configuredProject],
      defaultSourceWorkspaceFolder: '02-keripy',
      diagnosticsMode: 'layout',
      pythonInterpreter: 'python3',
      enrichmentEnabled: true,
      enrichmentAutoRun: false,
      discoveryEnabled: true,
      discoveryIncludeLowConfidence: false,
      discoveryInventoryWorkspaceFolderNames: ['example-workspace'],
      discoveryExcludeWorkspaceFolders: [],
      watchEnabled: true,
      watchAutoLoadOnStartup: true,
      refreshAutoRunOnStartup: false,
      refreshAutoRunOnSave: false,
      refreshDebounceMs: 1500,
      watchDebounceMs: 750,
      logLevel: 'info',
      directRunEnabled: true,
      sphinxCommand: 'sphinx-build',
      sphinxBuilder: 'dirhtml',
      sphinxSourceDir: 'docs',
      sphinxOutputDir: '.tmp/sphinx-doctor/dirhtml',
      sphinxWarningFile: '.tmp/sphinx-doctor/warnings.log',
      sphinxExtraArgs: [],
    },
    state: {
      activated: true,
      workspaceFolders: ['example-workspace', '02-keripy'],
      configuredProjects: ['keripy'],
      discoveredProjects: ['keripy'],
      knownProjects: ['keripy'],
      lastRefreshReason: 'activation',
      lastLoadedDiagnosticsFiles: ['/workspace/notes/libs/keripy/.sphinx-diagnostics/latest.json'],
      lastIssueCount: 398,
      lastPublishableBeforeFilterCount: 256,
      lastPublishedCount: 194,
      lastFilteredByModeCount: 62,
      lastSkippedCount: 142,
      lastResolutionFailureCount: 3,
      lastRawPendingCount: 1,
      lastErrorCount: 0,
      summary: {
        state: 'watching',
        projectCount: 1,
        issueCount: 398,
        publishableBeforeFilter: 256,
        publishedDiagnostics: 194,
        watcherCount: 4,
        diagnosticMode: 'layout',
        message: 'Watching 1 project.',
      },
      projectStatuses: [['keripy', 'loaded latest.json with 398 issues.']],
    },
  });

  assert.match(report, /Extension mode: Development/);
  assert.match(report, /Extension path: \/workspace\/extensions\/sphinx-doctor-vscode/);
});

test('troubleshoot report includes workspace trust, refresh-on-save, and diagnostics counts', async () => {
  const { buildTroubleshootReport } = await loadWatchModeModule();
  const report = buildTroubleshootReport({
    extensionMode: 3,
    extensionPath: '/workspace/extensions/sphinx-doctor-vscode',
    isWorkspaceTrusted: false,
    config: {
      projects: [configuredProject, hioProject],
      defaultSourceWorkspaceFolder: '02-keripy',
      diagnosticsMode: 'reference',
      pythonInterpreter: 'python3',
      enrichmentEnabled: true,
      enrichmentAutoRun: false,
      discoveryEnabled: true,
      discoveryIncludeLowConfidence: false,
      discoveryInventoryWorkspaceFolderNames: ['example-workspace'],
      discoveryExcludeWorkspaceFolders: ['example-ops-workspace'],
      watchEnabled: true,
      watchAutoLoadOnStartup: true,
      refreshAutoRunOnStartup: false,
      refreshAutoRunOnSave: false,
      refreshDebounceMs: 1500,
      watchDebounceMs: 750,
      logLevel: 'debug',
      directRunEnabled: true,
      sphinxCommand: 'sphinx-build',
      sphinxBuilder: 'dirhtml',
      sphinxSourceDir: 'docs',
      sphinxOutputDir: '.tmp/sphinx-doctor/dirhtml',
      sphinxWarningFile: '.tmp/sphinx-doctor/warnings.log',
      sphinxExtraArgs: [],
    },
    state: {
      activated: true,
      workspaceFolders: ['example-workspace', '02-keripy', '03-hio'],
      configuredProjects: ['keripy'],
      discoveredProjects: ['hio'],
      knownProjects: ['keripy', 'hio'],
      lastRefreshReason: 'saved conf.py',
      lastLoadedDiagnosticsFiles: ['/workspace/notes/libs/keripy/.sphinx-diagnostics/latest.json'],
      lastIssueCount: 451,
      lastPublishableBeforeFilterCount: 204,
      lastPublishedCount: 194,
      lastFilteredByModeCount: 10,
      lastSkippedCount: 257,
      lastResolutionFailureCount: 2,
      lastRawPendingCount: 1,
      lastErrorCount: 1,
      lastError: 'example failure',
      summary: {
        state: 'error',
        projectCount: 2,
        issueCount: 451,
        publishableBeforeFilter: 204,
        publishedDiagnostics: 194,
        watcherCount: 6,
        diagnosticMode: 'reference',
        message: 'Sphinx Doctor watch mode hit an error. Check the output channel.',
      },
      projectStatuses: [['keripy', 'loaded latest.json with 451 issues.']],
    },
  });

  assert.match(report, /Workspace trusted: false/);
  assert.match(report, /Refresh on save: false/);
  assert.match(report, /Total issues: 451/);
  assert.match(report, /Publishable before filter: 204/);
  assert.match(report, /Published diagnostics: 194/);
  assert.match(report, /Filtered by mode: 10/);
  assert.match(report, /Skipped issues: 257/);
  assert.match(report, /URI resolution failures: 2/);
  assert.match(report, /Raw pending projects: 1/);
  assert.match(report, /Errors: 1/);
});

test('development and test status-bar badges appear in normal summary text', async () => {
  const { applyExtensionModeBadge } = await loadWatchModeModule();

  assert.equal(applyExtensionModeBadge('Sphinx Doctor: 398 issues', 2), 'Sphinx Doctor (Dev): 398 issues');
  assert.equal(applyExtensionModeBadge('Sphinx Doctor: idle', 3), 'Sphinx Doctor (Test): idle');
  assert.equal(applyExtensionModeBadge('Sphinx Doctor: no diagnostics', 1), 'Sphinx Doctor: no diagnostics');
});

test('development and test status-bar badges are preserved for self-test and manual-like statuses', async () => {
  const { applyExtensionModeBadge } = await loadWatchModeModule();

  assert.equal(
    applyExtensionModeBadge(SELF_TEST_STATUS_TEXT, 2),
    'Sphinx Doctor (Dev): self-test diagnostic published',
  );
  assert.equal(
    applyExtensionModeBadge('Sphinx Doctor: diagnostics cleared.', 3),
    'Sphinx Doctor (Test): diagnostics cleared.',
  );
});

test('buildRunId formats timestamps as YYYYMMDD-HHMMSS', () => {
  assert.equal(buildRunId(new Date(2026, 4, 8, 18, 28, 30)), '20260508-182830');
});

test('getEnrichmentPermission blocks disabled or untrusted execution', () => {
  assert.equal(getEnrichmentPermission(true, true).allowed, true);
  assert.equal(getEnrichmentPermission(false, true).allowed, false);
  assert.equal(getEnrichmentPermission(true, false).allowed, false);
});

test('buildEnrichmentRunPlan keeps source, inventory, and mirror roots separated', () => {
  const plan = buildEnrichmentRunPlan({
    extensionRoot: '/workspace/sphinx-doctor',
    pythonInterpreter: 'python3',
    project: configuredProject,
    workspaceFolders: [
      { name: 'sphinx-doctor-extension', fsPath: '/workspace/sphinx-doctor' },
      { name: 'example-workspace', fsPath: '/workspace/notes' },
      { name: '02-keripy', fsPath: '/workspace/keripy' },
    ],
    rawIssuesPath: '/workspace/notes/tmp/run-002/report/issues.json',
    now: new Date(2026, 4, 8, 18, 28, 30),
  });

  assert.equal(plan.command, 'python3');
  assert.equal(Array.isArray(plan.args), true);
  assert.equal(plan.cwd, '/workspace/sphinx-doctor');
  assert.equal(plan.sourceRoot, '/workspace/keripy');
  assert.equal(plan.inventoryRoot, '/workspace/notes');
  assert.equal(plan.mirrorRootPath, '/workspace/keripy/.sphinx-diagnostics');
  assert.equal(
    plan.archiveOutputPath,
    '/workspace/keripy/.sphinx-diagnostics/runs/20260508-182830/enriched.json',
  );
  assert.equal(plan.latestOutputPath, '/workspace/keripy/.sphinx-diagnostics/latest.json');
  assert.deepEqual(plan.args.slice(0, 4), ['-m', 'sphinx_doctor.cli', 'enrich', '--raw-issues']);
  assert.equal(plan.args.includes('/workspace/notes/tmp/run-002/report/issues.json'), true);
});

test('buildEnrichmentRunPlan uses explicit roots and never collapses source into inventory', () => {
  const plan = buildEnrichmentRunPlan({
    extensionRoot: '/workspace/sphinx-doctor',
    pythonInterpreter: 'python3',
    project: configuredProject,
    workspaceFolders: [
      { name: 'example-workspace', fsPath: '/workspace/notes' },
      { name: '02-keripy', fsPath: '/workspace/keripy' },
    ],
    rawIssuesPath: '/workspace/notes/tmp/run-003/report/issues.json',
    now: new Date(2026, 4, 8, 20, 0, 0),
  });

  assert.notEqual(plan.sourceRoot, plan.inventoryRoot);
  assert.equal(plan.docsRoot, 'docs');
  assert.equal(plan.mirrorRoot, '.sphinx-diagnostics');
});

test('refresh-scope drift detection catches the Keripy narrow-to-broad repro', () => {
  const currentBaseline = buildSummaryContract({
    total: 193,
    mappedCount: 193,
    retainedOnly: 0,
    byCategory: { 'unexpected-indentation': 193 },
  });
  const refreshedBaseline = buildSummaryContract({
    total: 1236,
    mappedCount: 831,
    retainedOnly: 405,
    byCategory: {
      'unexpected-indentation': 193,
      'missing-reference': 805,
      'block-quote-unindent': 154,
      'definition-list-unindent': 51,
      other: 16,
    },
  });

  const comparison = buildRefreshScopeComparison(currentBaseline, refreshedBaseline);
  const drift = detectRefreshScopeDrift(comparison);

  assert.equal(drift.detected, true);
  assert.match(
    formatRefreshScopeDriftWarning('keripy', drift),
    /did not replace latest\.json/i,
  );
  assert.ok(
    drift.reasons.some((reason) => reason.includes('193') && reason.includes('1236')),
  );
  assert.deepEqual(comparison.addedCategories, [
    'block-quote-unindent',
    'definition-list-unindent',
    'missing-reference',
    'other',
  ]);
});

test('single-category baseline infers a refresh category scope', () => {
  const scope = inferRefreshScopeFromContract(
    buildCategoryScopeContract(['unexpected-indentation', 'unexpected-indentation']),
  );

  assert.equal(scope, 'unexpected-indentation');
});

test('multi-category baseline does not infer a refresh category scope', () => {
  const scope = inferRefreshScopeFromContract(
    buildCategoryScopeContract(['unexpected-indentation', 'missing-reference']),
  );

  assert.equal(scope, undefined);
});

test('empty baseline does not infer a refresh category scope', () => {
  const scope = inferRefreshScopeFromContract({
    ...contract,
    issues: [],
    summary: {
      ...contract.summary,
      total: 0,
      byCategory: {},
      mappedCount: 0,
      unmappedCount: 0,
      publishedDiagnostics: 0,
      retainedOnly: 0,
    },
  });

  assert.equal(scope, undefined);
});

test('buildRefreshCategoryArgs appends a category only when scope exists', () => {
  assert.deepEqual(buildRefreshCategoryArgs('unexpected-indentation'), [
    '--category',
    'unexpected-indentation',
  ]);
  assert.deepEqual(buildRefreshCategoryArgs(undefined), []);
});

test('applyRefreshScopeToConfig appends category args only when scope exists', () => {
  const scoped = applyRefreshScopeToConfig(configuredRefresh, 'unexpected-indentation');

  assert.deepEqual(scoped.args.slice(-2), ['--category', 'unexpected-indentation']);
  assert.deepEqual(
    applyRefreshScopeToConfig(configuredRefresh, undefined).args,
    configuredRefresh.args,
  );
});

test('refresh-scope drift detection ignores modest same-scope growth', () => {
  const currentBaseline = buildSummaryContract({
    total: 120,
    mappedCount: 120,
    retainedOnly: 0,
    byCategory: { 'unexpected-indentation': 120 },
  });
  const refreshedBaseline = buildSummaryContract({
    total: 145,
    mappedCount: 145,
    retainedOnly: 0,
    byCategory: { 'unexpected-indentation': 145 },
  });

  const drift = detectRefreshScopeDrift(
    buildRefreshScopeComparison(currentBaseline, refreshedBaseline),
  );

  assert.equal(drift.detected, false);
  assert.deepEqual(drift.reasons, []);
});

test('refresh-scope drift detection requires category expansion plus large count growth', () => {
  const currentBaseline = buildSummaryContract({
    total: 100,
    mappedCount: 100,
    retainedOnly: 0,
    byCategory: { 'unexpected-indentation': 100 },
  });
  const refreshedBaseline = buildSummaryContract({
    total: 260,
    mappedCount: 240,
    retainedOnly: 20,
    byCategory: {
      'unexpected-indentation': 180,
      'block-quote-unindent': 80,
    },
  });

  const drift = detectRefreshScopeDrift(
    buildRefreshScopeComparison(currentBaseline, refreshedBaseline),
  );

  assert.equal(drift.detected, true);
  assert.deepEqual(drift.comparison.addedCategories, ['block-quote-unindent']);
  assert.ok(drift.reasons.some((reason) => reason.includes('mapped/publishable')));
});

test('refresh-scope drift detection catches retained-only spikes with new categories', () => {
  const currentBaseline = buildSummaryContract({
    total: 110,
    mappedCount: 110,
    retainedOnly: 0,
    byCategory: { 'unexpected-indentation': 110 },
  });
  const refreshedBaseline = buildSummaryContract({
    total: 260,
    mappedCount: 140,
    retainedOnly: 120,
    byCategory: {
      'unexpected-indentation': 110,
      'missing-reference': 150,
    },
  });

  const drift = detectRefreshScopeDrift(
    buildRefreshScopeComparison(currentBaseline, refreshedBaseline),
  );

  assert.equal(drift.detected, true);
  assert.ok(drift.reasons.some((reason) => reason.includes('retained-only')));
});

test('refresh baseline promotion preserves the archive and keeps latest.json unchanged when drift is detected', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'sphinx-doctor-refresh-'));
  const latestPath = path.join(tempRoot, 'latest.json');
  const archivePath = path.join(tempRoot, 'runs', '20260510-151209', 'enriched.json');

  const currentBaseline = buildSummaryContract({
    total: 193,
    mappedCount: 193,
    retainedOnly: 0,
    byCategory: { 'unexpected-indentation': 193 },
  });
  const refreshedBaseline = buildSummaryContract({
    total: 1236,
    mappedCount: 831,
    retainedOnly: 405,
    byCategory: {
      'unexpected-indentation': 193,
      'missing-reference': 805,
      'block-quote-unindent': 154,
      'definition-list-unindent': 51,
    },
  });

  await writeFile(latestPath, JSON.stringify(currentBaseline, null, 2));
  await mkdir(path.dirname(archivePath), { recursive: true });
  await writeFile(archivePath, JSON.stringify(refreshedBaseline, null, 2));

  const result = await evaluateRefreshBaselinePromotion({
    currentBaselinePath: latestPath,
    refreshedDiagnosticsPath: archivePath,
    latestOutputPath: latestPath,
  });

  assert.equal(result.promoted, false);
  assert.equal(result.activeDiagnosticsPath, latestPath);
  assert.equal(result.drift.detected, true);
  assert.equal(await readFile(archivePath, 'utf8'), JSON.stringify(refreshedBaseline, null, 2));
  assert.equal(await readFile(latestPath, 'utf8'), JSON.stringify(currentBaseline, null, 2));
});

test('getRefreshPermission blocks missing, disabled, or untrusted refresh execution', () => {
  assert.equal(getRefreshPermission(true, configuredRefresh).allowed, true);
  assert.equal(getRefreshPermission(true, undefined).allowed, false);
  assert.equal(getRefreshPermission(false, configuredRefresh).allowed, false);
  assert.equal(
    getRefreshPermission(true, {
      ...configuredRefresh,
      enabled: false,
    }).allowed,
    false,
  );
});

test('buildRefreshRunPlan keeps cwd, source, inventory, and mirror roots separated', () => {
  const plan = buildRefreshRunPlan({
    project: configuredProject,
    refresh: configuredRefresh,
    workspaceFolders: [
      { name: 'example-workspace', fsPath: '/workspace/notes' },
      { name: '02-keripy', fsPath: '/workspace/notes/libs/keripy' },
    ],
    now: new Date(2026, 4, 9, 12, 34, 56),
  });

  assert.equal(plan.command, 'bash');
  assert.equal(plan.cwd, '/workspace/notes');
  assert.equal(plan.sourceRoot, '/workspace/notes/libs/keripy');
  assert.equal(plan.inventoryRoot, '/workspace/notes');
  assert.equal(plan.mirrorRootPath, '/workspace/notes/libs/keripy/.sphinx-diagnostics');
  assert.equal(plan.startedAtMs, new Date(2026, 4, 9, 12, 34, 56).getTime());
  assert.deepEqual(plan.expectedOutputGlobs, configuredRefresh.expectedOutputGlobs);
});

test('buildRefreshRunPlan appends category args when a refresh scope exists', () => {
  const plan = buildRefreshRunPlan({
    project: configuredProject,
    refresh: configuredRefresh,
    workspaceFolders: [
      { name: 'example-workspace', fsPath: '/workspace/notes' },
      { name: '02-keripy', fsPath: '/workspace/notes/libs/keripy' },
    ],
    refreshCategory: 'unexpected-indentation',
  });

  assert.deepEqual(plan.args.slice(-2), ['--category', 'unexpected-indentation']);
});

test('buildRefreshRunPlan keeps existing behavior unchanged without inferred scope', () => {
  const plan = buildRefreshRunPlan({
    project: configuredProject,
    refresh: configuredRefresh,
    workspaceFolders: [
      { name: 'example-workspace', fsPath: '/workspace/notes' },
      { name: '02-keripy', fsPath: '/workspace/notes/libs/keripy' },
    ],
  });

  assert.deepEqual(plan.args, configuredRefresh.args);
});

test('inferProjectRefreshConfig derives the Devtools runner for a shared inventory workspace', async () => {
  const existingPaths = new Set([
    '/workspace/notes/Devtools/sphinx/run_sphinx_inventory.sh',
    '/workspace/notes/libs/keripy/.venv-docs/bin/python',
    '/workspace/notes/libs/keripy/docs/conf.py',
  ]);

  const resolution = await inferProjectRefreshConfig({
    project: configuredProject,
    workspaceFolders: [
      { name: 'example-workspace', fsPath: '/workspace/notes' },
      { name: '02-keripy', fsPath: '/workspace/notes/libs/keripy' },
    ],
    pathExists: async (filePath) => existingPaths.has(filePath),
  });

  assert.equal(resolution.source, 'inferred');
  assert.deepEqual(resolution.config, configuredRefresh);
});

test('inferProjectRefreshConfig supports a single ordinary workspace when the runner lives there', async () => {
  const project: ConfiguredProject = {
    ...configuredProject,
    sourceWorkspaceFolder: 'docs-workspace',
    inventoryWorkspaceFolder: 'docs-workspace',
  };

  const resolution = await inferProjectRefreshConfig({
    project,
    workspaceFolders: [{ name: 'docs-workspace', fsPath: '/workspace/docs-workspace' }],
    pathExists: async (filePath) =>
      new Set([
        '/workspace/docs-workspace/Devtools/sphinx/run_sphinx_inventory.sh',
        '/workspace/docs-workspace/.venv-docs/bin/python',
        '/workspace/docs-workspace/docs/conf.py',
      ]).has(filePath),
  });

  assert.equal(resolution.source, 'inferred');
  assert.deepEqual(resolution.config, {
    enabled: true,
    cwdWorkspaceFolder: 'docs-workspace',
    command: 'bash',
    args: [
      'Devtools/sphinx/run_sphinx_inventory.sh',
      '--repo-root',
      '.',
      '--python',
      '.venv-docs/bin/python',
      '--context-lines',
      '16',
    ],
    expectedOutputGlobs: [
      'tmp/sphinx-inventory-docs-workspace-*/report/issues.vscode.json',
      'tmp/sphinx-inventory-docs-workspace-*/report/issues.json',
    ],
  });
});

test('filterRecentInventoryCandidates rejects outputs that predate the current refresh run', () => {
  const candidates = filterRecentInventoryCandidates(
    [
      {
        filePath: '/workspace/notes/tmp/run-001/report/issues.json',
        fileName: 'issues.json',
        directoryPath: '/workspace/notes/tmp/run-001/report',
        modifiedTime: 100,
      },
      {
        filePath: '/workspace/notes/tmp/run-002/report/issues.json',
        fileName: 'issues.json',
        directoryPath: '/workspace/notes/tmp/run-002/report',
        modifiedTime: 250,
      },
    ],
    200,
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.filePath, '/workspace/notes/tmp/run-002/report/issues.json');
});

test('candidate repos with conf.py markers stay passive until docs Python exists', async () => {
  const runnerPath = '/workspace/notes/Devtools/sphinx/run_sphinx_inventory.sh';

  for (const [project, sourceRoot, docsMarker] of [
    [hioProject, '/workspace/notes/libs/hio', '/workspace/notes/libs/hio/docs/Makefile'],
    [locksmithProject, '/workspace/notes/libs/locksmith', '/workspace/notes/libs/locksmith/docs/conf.py'],
    [witnessProject, '/workspace/notes/libs/witness-hk', '/workspace/notes/libs/witness-hk/docs/conf.py'],
  ] as const) {
    const resolution = await inferProjectRefreshConfig({
      project,
      workspaceFolders: [
        { name: 'example-workspace', fsPath: '/workspace/notes' },
        { name: project.sourceWorkspaceFolder, fsPath: sourceRoot },
      ],
      pathExists: async (filePath) => new Set([runnerPath, docsMarker]).has(filePath),
    });

    assert.equal(resolution.config, undefined, project.id);
    assert.match(resolution.reason ?? '', /Docs Python is missing/i, project.id);
  }
});

test('selectInventoryCandidate prefers issues.vscode.json over issues.json for matching projects', () => {
  const result = selectInventoryCandidate(
    configuredProject,
    [
      {
        filePath: '/workspace/notes/tmp/sphinx-inventory-keripy-001/report/issues.json',
        fileName: 'issues.json',
        directoryPath: '/workspace/notes/tmp/sphinx-inventory-keripy-001/report',
        modifiedTime: 100,
      },
      {
        filePath: '/workspace/notes/tmp/sphinx-inventory-keripy-001/report/issues.vscode.json',
        fileName: 'issues.vscode.json',
        directoryPath: '/workspace/notes/tmp/sphinx-inventory-keripy-001/report',
        modifiedTime: 100,
      },
    ],
    ['issues.vscode.json', 'issues.json'],
  );

  assert.equal(result.selected?.fileName, 'issues.vscode.json');
});

test('selectInventoryCandidate reports ambiguity instead of silently guessing', () => {
  const ambiguousProject = {
    ...configuredProject,
    id: 'keripy-sphinx-cleanup',
    label: 'keripy sphinx cleanup',
    sourceWorkspaceFolder: '13-keripy-sphinx-batch-01',
  };

  const result = selectInventoryCandidate(
    ambiguousProject,
    [
      {
        filePath: '/workspace/notes/tmp/sphinx-inventory-keripy-sphinx-unexpected-indentation-batch-01-a/report/issues.vscode.json',
        fileName: 'issues.vscode.json',
        directoryPath: '/workspace/notes/tmp/sphinx-inventory-keripy-sphinx-unexpected-indentation-batch-01-a/report',
        modifiedTime: 100,
      },
      {
        filePath: '/workspace/notes/tmp/sphinx-inventory-keripy-sphinx-unexpected-indentation-batch-01-b/report/issues.vscode.json',
        fileName: 'issues.vscode.json',
        directoryPath: '/workspace/notes/tmp/sphinx-inventory-keripy-sphinx-unexpected-indentation-batch-01-b/report',
        modifiedTime: 100,
      },
    ],
    ['issues.vscode.json', 'issues.json'],
  );

  assert.equal(result.selected, undefined);
  assert.equal(result.ambiguous?.length, 2);
});

test('parseSphinxWarnings returns issues even when docstring text mapper cannot read source', async () => {
  // TextDocstringLocator replaces WASM Tree-sitter. When source files are not
  // accessible (e.g. test paths), docstring warnings get low confidence and
  // are retained but not published to Problems.

  const sphinxLogLines = [
    '/repo/src/keri/core/eventing.py:docstring of keri.core.eventing.kevery:7: ERROR: Unexpected indentation. [docutils]',
    '/repo/src/keri/core/eventing.py:42: WARNING: Block quote ends without a blank line [docutils]',
    'WARNING: Some global warning [docutils]',
    '',
  ];

  const result = await parseSphinxWarnings({
    warningFileContent: sphinxLogLines.join('\n'),
    repoRoot: '/repo',
    sourceWorkspaceFolder: 'test-workspace',
  });

  assert.ok(result.issues.length > 0, 'should have issues even when source files are not readable');
  assert.equal(result.astDegraded, false, 'text mapper does not degrade on missing files — returns low confidence instead');
  assert.equal(result.unparsedCount, 1, 'blank trailing line counts as unparsed');
  assert.equal(result.unmappedCount, 1, 'global warning should be unmapped');

  // Docstring warning: present but low confidence (file not readable)
  const docstringIssue = result.issues.find((issue) => issue.repoRelativePath?.includes('eventing.py') && issue.category === 'docutils');
  assert.ok(docstringIssue, 'docstring warning should still be an issue');
  assert.equal(docstringIssue!.mapping.confidence, 'low', 'unreadable file should give low confidence');
  assert.equal(docstringIssue!.publishDiagnostic, false,
    'low-confidence docstring mapping should not publish to Problems');
  assert.equal(result.unsafeDocstringFallbackCount, 1,
    'unsafeDocstringFallbackCount should count the retained docstring issue');

  // Located warnings (non-docstring) should be suppressed from direct-run Problems
  const locatedIssue = result.issues.find((issue) => issue.category === 'docutils' && issue.mapping.strategy === 'sphinx-warning-file');
  assert.ok(locatedIssue, 'standard located warning should be present');
  assert.equal(locatedIssue!.publishDiagnostic, false,
    'standard file:line warnings should be suppressed from direct-run Problems');
  assert.equal(result.suppressedNonDocstringCount, 1,
      'suppressedNonDocstringCount should count the file:line warning');
});

test('direct-run diagnostics would be filtered by layout mode without override', () => {
  // Direct-run issues have category 'docutils', which layout mode does not pass.
  // The fix: applyDiagnosticModeFilter=false in publishDiagnostics bypasses this.
  const docutilsShape = {
    category: 'docutils',
    code: 'docutils',
    message: 'Unexpected indentation. [docutils]',
  };

  assert.equal(issueMatchesDiagnosticMode(docutilsShape, 'layout'), false,
    'docutils category should NOT pass layout — direct-run was 0-published because of this');
  assert.equal(issueMatchesDiagnosticMode(docutilsShape, 'full'), true,
    'docutils should pass full mode');
  assert.equal(issueMatchesDiagnosticMode(docutilsShape, 'reference'), false,
    'docutils should not pass reference mode');

  // Verify that the 'unexpected-indentation' category (from artifact/enriched diagnostics) DOES pass layout
  assert.equal(issueMatchesDiagnosticMode({ category: 'unexpected-indentation', code: 'docutils.unexpected-indentation', message: 'Unexpected indentation.' }, 'layout'), true,
    'unexpected-indentation should pass layout — this is the existing artifact behavior we preserve');
});

test('direct-run bypass: docutils issue is only filtered by issueMatchesDiagnosticMode, not by shouldPublishIssue', () => {
  // Regression for SPHINX-DOCTOR-014: publishDiagnosticsBatch used Pick<> that excluded
  // applyDiagnosticModeFilter, so the direct-run bypass was silently dropped.
  // This test verifies the pure-function decision points that control publication:
  //   1. shouldPublishIssue: checks publishDiagnostic, repoRelativePath, sourceRange
  //   2. issueMatchesDiagnosticMode: checks category against mode allowlist
  // The bypass (applyDiagnosticModeFilter=false) skips step 2 for direct-run.

  const docutilsIssue = {
    id: 'bypass-test-1',
    category: 'docutils',
    code: 'docutils',
    message: 'Unexpected indentation. [docutils]',
    severity: 'warning',
    repoRelativePath: 'src/keri/app/habbing.py',
    sourceWorkspaceFolder: '02-keripy',
    sourceRange: { startLine: 7, startColumn: 1, endLine: 7, endColumn: 1, anchorKind: 'line' },
    publishDiagnostic: true,
  } as unknown as DiagnosticsIssue;

  // Step 1: shouldPublishIssue — direct-run issues pass this gate
  assert.equal(shouldPublishIssue(docutilsIssue), true,
    'direct-run docutils issue should pass shouldPublishIssue (has path, range, publishDiagnostic)');

  // Step 2: issueMatchesDiagnosticMode — blocks in layout mode (this is correct)
  assert.equal(issueMatchesDiagnosticMode(docutilsIssue, 'layout'), false,
    'docutils should be blocked by layout mode at the pure-function level');

  // Step 2 with bypass: the caller skips issueMatchesDiagnosticMode when applyDiagnosticModeFilter=false
  // This is what the Pick<> bug was silently preventing.

  // Verify the skip-reason tracking contract: when an issue is mode-filtered,
  // the skipReasons counter should reflect 'mode-filtered', not 'not-publishable' or 'no-target-uri'.
  // This ensures the diagnostic logging added in SPHINX-DOCTOR-013 correctly attributes skips.
});

test('direct-run parser suppresses .rst/.md/docs warnings and publishes only Python docstring diagnostics', async () => {
  // SPHINX-DOCTOR-016: direct-run Problems scope is Python docstring only.
  // .rst, .md, and other non-docstring warnings should be retained for
  // accounting but not published to Problems.
  const sphinxLogLines = [
    // Python docstring warning — should be a Problems candidate (with safe mapping)
    '/repo/src/keri/app/habbing.py:docstring of keri.app.habbing.BaseHab.endorse:7: ERROR: Unexpected indentation. [docutils]',
    // .rst docs warning — should be suppressed from Problems
    '/repo/docs/keri_app.rst:55: WARNING: more than one target found [ref.python]',
    // .md docs warning — should be suppressed from Problems
    '/repo/docs/ref/tel.md:145: WARNING: Lexing literal_block failed [misc.highlighting_failure]',
    // Standard file:line on a .py file — should be suppressed (not docstring-backed)
    '/repo/src/keri/core/eventing.py:42: WARNING: Block quote ends without a blank line [docutils]',
  ];

  const result = await parseSphinxWarnings({
    warningFileContent: sphinxLogLines.join('\n'),
    repoRoot: '/repo',
    sourceWorkspaceFolder: 'test-workspace',
  });

  // All 4 lines should parse into issues
  assert.equal(result.issues.length, 4, 'should parse all 4 warnings');

  // Docstring warning: present, but publishDiagnostic depends on AST mapping
  const docstringIssue = result.issues.find((i) => i.rawLocation?.includes('docstring of'));
  assert.ok(docstringIssue, 'Python docstring warning should be present');

  // .rst warning: present but publishDiagnostic=false
  const rstIssue = result.issues.find((i) => i.repoRelativePath?.includes('.rst'));
  assert.ok(rstIssue, '.rst warning should be parsed');
  assert.equal(rstIssue!.publishDiagnostic, false,
    '.rst warnings should not publish to direct-run Problems');

  // .md warning: present but publishDiagnostic=false
  const mdIssue = result.issues.find((i) => i.repoRelativePath?.includes('.md'));
  assert.ok(mdIssue, '.md warning should be parsed');
  assert.equal(mdIssue!.publishDiagnostic, false,
    '.md warnings should not publish to direct-run Problems');

  // standard file:line warning: present but publishDiagnostic=false
  const locatedIssue = result.issues.find((i) => i.mapping.strategy === 'sphinx-warning-file');
  assert.ok(locatedIssue, 'standard located warning should be present');
  assert.equal(locatedIssue!.publishDiagnostic, false,
    'non-docstring file:line warnings should not publish to direct-run Problems');

  // Counters
  assert.equal(result.suppressedNonDocstringCount, 3,
    'should count 3 suppressed non-docstring issues (.rst, .md, located)');
});

test('TextDocstringLocator maps class method docstring to source range', async () => {
  // Write a temp Python file with a class containing a docstring method
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'sphinx-doctor-textmapper-'));
  const pyPath = path.join(tmpDir, 'habbing.py');
  const source = [
    'class BaseHab:',
    '    def endorse(self, serder):',
    '        """',
    '        Endorse a serialized data structure.',
    '',
    '        Args:',
    '            serder: Serder instance',
    '',
    '        Returns:',
    '            bytes: CESR signature',
    '        """',
    '        pass',
  ].join('\n');
  await writeFile(pyPath, source, 'utf8');

  try {
    const sphinxLogLines = [
      `${pyPath}:docstring of keri.app.habbing.BaseHab.endorse:3: ERROR: Unexpected indentation. [docutils]`,
    ];

    const result = await parseSphinxWarnings({
      warningFileContent: sphinxLogLines.join('\n'),
      repoRoot: tmpDir,
      sourceWorkspaceFolder: 'test-workspace',
    });

    assert.equal(result.issues.length, 1, 'should parse one docstring warning');
    assert.equal(result.astDegraded, false, 'text mapper should not degrade');
    assert.equal(result.unsafeDocstringFallbackCount, 0, 'no unsafe fallback');

    const issue = result.issues[0];
    assert.equal(issue.publishDiagnostic, true, 'should publish mapped docstring');
    assert.equal(issue.mapping.confidence, 'high', 'should have high confidence');
    assert.equal(issue.mapping.strategy, 'sphinx-docstring-warning', 'should use docstring strategy');
    assert.ok(issue.sourceRange, 'should have source range');
    // Docstring line 3 (1-indexed in docstring content) from """ at line 2 (0-indexed):
    // startLine=2 (0-idx """), docstringLine=3 → targetLine0=5, 1-idx=6
    // Line 6 in source is "        Args:"
    assert.equal(issue.sourceRange!.startLine, 6,
      'targetLine should map to source line inside docstring');
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});