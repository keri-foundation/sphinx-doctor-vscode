import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
import {
  applyRefreshScopeToConfig,
  buildRefreshCategoryArgs,
  buildRefreshRunPlan,
  filterRecentInventoryCandidates,
  getRefreshPermission,
  inferRefreshScopeFromContract,
  inferProjectRefreshConfig,
} from '../src/refreshRunner';
import { DiagnosticsPublicationIndex } from '../src/publicationIndex';
import {
  buildLoadAllDiagnosticsStatusMessage,
  loadAllDiscoveredDiagnostics,
} from '../src/loadAllDiagnostics';
import {
  buildDiagnosticsAccountingReport,
  buildDiagnosticsCountsToastMessage,
} from '../src/diagnosticsAccounting';
import {
  buildDiagnosticMessage,
  ConfiguredProject,
  DiagnosticsContract,
  DiagnosticsIssue,
  issueMatchesDiagnosticMode,
  normalizeDiagnosticMode,
  normalizeSeverityName,
  shouldPublishIssue,
  summarizeDiagnosticMode,
  toZeroBasedPosition,
} from '../src/types';
import type { PublishResult } from '../src/publishDiagnostics';
import {
  buildProjectQuickPickItems,
  coerceRefreshDebounceMs,
  coerceProjects,
  projectSelectionMode,
} from '../src/config';
import {
  buildDiscoveryProbePaths,
  discoverWorkspaceProjectDecisions,
  detectProjectFromSnapshot,
  discoverWorkspaceProjects,
  parseGitWorktreeListPorcelain,
  mergeProjects,
} from '../src/projectDiscovery';
import {
  buildWatchModeSummary,
  canAutoRunEnrichment,
  createSingleFlightController,
  createDebouncedTrigger,
  findOwningProjectForPath,
  formatWatchModeText,
  getRefreshOnSaveDebounceMs,
  getRefreshOnSaveDecision,
  hasOpenWorkspaceFolders,
  isExcludedWorkspaceFolder,
  isRelevantRefreshSavePath,
  summarizeProjectPublicationSnapshots,
  runWatchModeStartup,
} from '../src/watchModeState';
import {
  inspectDiagnosticsBindingPayload,
  inspectDiagnosticsPayload,
  inspectDiagnosticsText,
  isDiagnosticsBindingCompatible,
} from '../src/loadDiagnostics';
import {
  buildSelfTestStatusTooltip,
  clearPublishedDiagnostics,
  createSelfTestDiagnosticSpec,
  publishSelfTestDiagnostic,
  SELF_TEST_COMMAND_ID,
  SELF_TEST_MESSAGE,
  SELF_TEST_SOURCE,
  SELF_TEST_STATUS_TEXT,
} from '../src/selfTest';
import {
  isRawInventoryFile,
  orderInventoryCandidates,
  pickInventoryCandidate,
  resolveProjectSourceRoot,
  resolveIssueFilePath,
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

const rawInventoryPayload = {
  log_path: '/workspace/notes/tmp/run-001/sphinx.log',
  repo_root: '/workspace/notes/libs/keripy',
  generated_at: '2026-05-09T00:36:25.364287+00:00',
  filters: {
    category: 'unexpected-indentation',
    path_filter: null,
  },
  summary: {
    unique_issues: 1,
    docs_reference_issues: 0,
    source_docstring_issues: 1,
  },
  issues: [
    {
      severity: 'ERROR',
      category: 'unexpected-indentation',
      path: 'src/keri/core/coring.py',
      line: 3,
      location: 'docstring of keri.core.coring.Matter.__init__',
      object_name: 'keri.core.coring.Matter.__init__',
      message: 'Unexpected indentation. [docutils]',
      raw: '/workspace/notes/libs/keripy/src/keri/core/coring.py:docstring of keri.core.coring.Matter.__init__:3: ERROR: Unexpected indentation. [docutils]',
    },
  ],
};

const unknownIssuesFilePayload = {
  repo_root: '/workspace/notes/libs/keripy',
  issues: [
    {
      hello: 'world',
    },
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

test('normalizeSeverityName collapses non-error severities for the extension', () => {
  assert.equal(normalizeSeverityName('error'), 'error');
  assert.equal(normalizeSeverityName('warning'), 'warning');
  assert.equal(normalizeSeverityName('information'), 'info');
  assert.equal(normalizeSeverityName('hint'), 'info');
});

test('normalizeDiagnosticMode defaults to layout and accepts valid explicit modes', () => {
  assert.equal(normalizeDiagnosticMode('layout'), 'layout');
  assert.equal(normalizeDiagnosticMode('reference'), 'reference');
  assert.equal(normalizeDiagnosticMode('full'), 'full');
  assert.equal(normalizeDiagnosticMode('bogus'), 'layout');
  assert.equal(normalizeDiagnosticMode(undefined), 'layout');
});

test('toZeroBasedPosition converts one-based coordinates to zero-based indices', () => {
  assert.equal(toZeroBasedPosition(1), 0);
  assert.equal(toZeroBasedPosition(13), 12);
  assert.equal(toZeroBasedPosition(undefined), 0);
});

test('shouldPublishIssue requires publish flag, path, and source range', () => {
  assert.equal(shouldPublishIssue(mappedIssue), true);
  assert.equal(shouldPublishIssue({ ...mappedIssue, publishDiagnostic: false }), false);
  assert.equal(shouldPublishIssue({ ...mappedIssue, sourceRange: null }), false);
  assert.equal(shouldPublishIssue({ ...mappedIssue, repoRelativePath: null }), false);
});

test('diagnostic modes distinguish layout, reference, and full warning classes', () => {
  const referenceIssue: DiagnosticsIssue = {
    ...mappedIssue,
    category: 'missing-reference',
    code: 'ref.class',
    message: 'py:class reference target not found: socket.socket [ref.class]',
  };
  const ambiguousIssue: DiagnosticsIssue = {
    ...mappedIssue,
    category: 'ambiguous-reference',
    code: 'ref.python',
    message: "more than one target found for cross-reference 'host': demo.one, demo.two [ref.python]",
  };
  const literalBlockIssue: DiagnosticsIssue = {
    ...mappedIssue,
    category: 'other',
    code: 'other',
    message: 'Literal block expected; none found. [docutils]',
  };

  assert.equal(issueMatchesDiagnosticMode(mappedIssue, 'layout'), true);
  assert.equal(issueMatchesDiagnosticMode(referenceIssue, 'layout'), false);
  assert.equal(issueMatchesDiagnosticMode(referenceIssue, 'reference'), true);
  assert.equal(issueMatchesDiagnosticMode(ambiguousIssue, 'reference'), true);
  assert.equal(issueMatchesDiagnosticMode(literalBlockIssue, 'layout'), true);
  assert.equal(issueMatchesDiagnosticMode(referenceIssue, 'full'), true);
});

test('mode summaries change published counts without deleting retained issues', () => {
  const referenceIssue: DiagnosticsIssue = {
    ...mappedIssue,
    id: 'reference-issue',
    category: 'missing-reference',
    code: 'ref.class',
    message: 'py:class reference target not found: io.IOBase [ref.class]',
  };
  const retainedOnlyIssue: DiagnosticsIssue = {
    ...mappedIssue,
    id: 'retained-only-issue',
    category: 'ambiguous-reference',
    code: 'ref.python',
    message: "more than one target found for cross-reference 'port': demo.one, demo.two [ref.python]",
    publishDiagnostic: false,
    sourceRange: null,
  };

  assert.deepEqual(summarizeDiagnosticMode([mappedIssue, referenceIssue, retainedOnlyIssue], 'layout'), {
    totalIssues: 3,
    publishableBeforeFilter: 2,
    publishedInMode: 1,
    retainedOnly: 1,
  });
  assert.deepEqual(summarizeDiagnosticMode([mappedIssue, referenceIssue, retainedOnlyIssue], 'reference'), {
    totalIssues: 3,
    publishableBeforeFilter: 2,
    publishedInMode: 1,
    retainedOnly: 1,
  });
  assert.deepEqual(summarizeDiagnosticMode([mappedIssue, referenceIssue, retainedOnlyIssue], 'full'), {
    totalIssues: 3,
    publishableBeforeFilter: 2,
    publishedInMode: 2,
    retainedOnly: 1,
  });
});

test('diagnostics accounting report includes all required counters and relationship wording', () => {
  const accounting: PublishResult = {
    issueCount: 451,
    publishableBeforeFilter: 204,
    publishedDiagnostics: 194,
    filteredByMode: 10,
    targetUriCount: 33,
    skippedIssues: 257,
    resolutionFailures: 2,
  };
  const report = buildDiagnosticsAccountingReport({
    contract: {
      ...contract,
      summary: {
        ...contract.summary,
        publishedDiagnostics: 204,
        retainedOnly: 247,
      },
    },
    diagnosticMode: 'layout',
    diagnosticsFilePath: '/workspace/notes/.sphinx-diagnostics/latest.json',
    accounting,
  });

  assert.match(report, /diagnostic mode: layout/);
  assert.match(report, /diagnostics file: \/workspace\/notes\/\.sphinx-diagnostics\/latest\.json/);
  assert.match(report, /total enriched issues: 451/);
  assert.match(report, /contract summary published diagnostics: 204/);
  assert.match(report, /contract retained-only count: 247/);
  assert.match(report, /publishable before mode filter: 204/);
  assert.match(report, /published after mode filter: 194/);
  assert.match(report, /filtered by mode: 10/);
  assert.match(report, /skipped issues: 257/);
  assert.match(report, /resolution failures: 2/);
  assert.match(report, /target URI count: 33/);
  assert.match(report, /Problems should match published after mode filter, not total enriched issues/);
});

test('diagnostics counts toast explains total issues can exceed published diagnostics', () => {
  const message = buildDiagnosticsCountsToastMessage({
    contract,
    diagnosticMode: 'reference',
    diagnosticsFilePath: '/workspace/notes/latest.json',
    accounting: {
      issueCount: 451,
      publishableBeforeFilter: 204,
      publishedDiagnostics: 204,
      filteredByMode: 0,
      targetUriCount: 33,
      skippedIssues: 247,
      resolutionFailures: 0,
    },
  });

  assert.equal(
    message,
    'Problems should match 204 published diagnostics in reference mode, not 451 total enriched issues.',
  );
});

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

test('load-all diagnostics status message summarizes loaded and skipped projects', () => {
  assert.equal(
    buildLoadAllDiagnosticsStatusMessage({
      discoveredProjectCount: 2,
      knownProjectCount: 3,
      loadedProjectCount: 2,
      skippedProjectCount: 1,
      issueCount: 451,
      publishedDiagnostics: 194,
    }),
    'Sphinx Doctor inspected 3 supported project(s); 2 loaded; 1 skipped; 451 issues; 194 published diagnostics',
  );
});

test('load-all diagnostics uses watch-mode batch loading and avoids project selection', async () => {
  const calls: Array<{ reason: string; loadDiagnostics: boolean | undefined }> = [];
  const infoMessages: string[] = [];
  const warningMessages: string[] = [];

  const snapshot = await loadAllDiscoveredDiagnostics({
    watchMode: {
      async refreshAll(reason, loadDiagnostics) {
        calls.push({ reason, loadDiagnostics });
      },
      getLastRefreshSnapshot() {
        return {
          discoveredProjectCount: 2,
          knownProjectCount: 3,
          loadedProjectCount: 2,
          skippedProjectCount: 1,
          issueCount: 451,
          publishedDiagnostics: 194,
        };
      },
    },
    logger: {
      info: () => {},
      warn: () => {},
    },
    showWarningMessage(message) {
      warningMessages.push(message);
    },
    showInformationMessage(message) {
      infoMessages.push(message);
    },
  });

  assert.deepEqual(calls, [
    { reason: 'manual command: discover and load diagnostics', loadDiagnostics: true },
  ]);
  assert.deepEqual(warningMessages, []);
  assert.deepEqual(infoMessages, [
    'Sphinx Doctor inspected 3 supported project(s); 2 loaded; 1 skipped; 451 issues; 194 published diagnostics',
  ]);
  assert.deepEqual(snapshot, {
    discoveredProjectCount: 2,
    knownProjectCount: 3,
    loadedProjectCount: 2,
    skippedProjectCount: 1,
    issueCount: 451,
    publishedDiagnostics: 194,
  });
});

test('load-all diagnostics warns when watch mode is unavailable', async () => {
  const infoMessages: string[] = [];
  const warningMessages: string[] = [];

  const snapshot = await loadAllDiscoveredDiagnostics({
    logger: {
      info: () => {},
      warn: () => {},
    },
    showWarningMessage(message) {
      warningMessages.push(message);
    },
    showInformationMessage(message) {
      infoMessages.push(message);
    },
  });

  assert.equal(snapshot, undefined);
  assert.deepEqual(infoMessages, []);
  assert.deepEqual(warningMessages, [
    'Sphinx Doctor watch mode is unavailable, so Discover and Load Diagnostics cannot load all workspace projects.',
  ]);
});

test('buildDiagnosticMessage includes category, object name, and low-confidence marker', () => {
  assert.equal(
    buildDiagnosticMessage(mappedIssue),
    '[unexpected-indentation] Unexpected indentation in autodoc docstring block. (keri.core.coring.Number) [confidence: low]',
  );
});

test('resolveIssueFilePath prefers the named workspace folder', () => {
  const resolution = resolveIssueFilePath(contract, mappedIssue, {
    workspaceFolders: [
      { name: '11-sphinx-doctor', fsPath: '/workspace/sphinx-doctor' },
      { name: '02-keripy', fsPath: '/workspace/keripy' },
    ],
  });

  assert.equal(resolution.strategy, 'source-workspace-folder');
  assert.equal(resolution.filePath, '/workspace/keripy/src/keri/core/coring.py');
});

test('resolveIssueFilePath can fall back to the fixture source root', () => {
  const resolution = resolveIssueFilePath(contract, mappedIssue, {
    workspaceFolders: [{ name: '11-sphinx-doctor', fsPath: '/workspace/sphinx-doctor' }],
    fixtureSourceRoot: '/workspace/sphinx-doctor/fixtures/source/keripy',
    allowFirstFolderFallback: true,
  });

  assert.equal(resolution.strategy, 'fixture-source-root');
  assert.equal(
    resolution.filePath,
    '/workspace/sphinx-doctor/fixtures/source/keripy/src/keri/core/coring.py',
  );
});

test('coerceProjects keeps valid project settings and drops incomplete entries', () => {
  const projects = coerceProjects([
    {
      ...configuredProject,
      refresh: configuredRefresh,
    },
    {
      id: 'broken',
      sourceWorkspaceFolder: '02-keripy',
    },
  ]);

  assert.equal(projects.length, 1);
  assert.deepEqual(projects[0], {
    ...configuredProject,
    refresh: configuredRefresh,
  });
});

test('coerceRefreshDebounceMs defaults to 1500 and respects safe custom values', () => {
  assert.equal(coerceRefreshDebounceMs(undefined), 1500);
  assert.equal(coerceRefreshDebounceMs(1500), 1500);
  assert.equal(coerceRefreshDebounceMs(2200), 2200);
});

test('coerceRefreshDebounceMs falls back safely for invalid or too-low values', () => {
  assert.equal(coerceRefreshDebounceMs('fast'), 1500);
  assert.equal(coerceRefreshDebounceMs(-1), 1500);
  assert.equal(coerceRefreshDebounceMs(50), 1500);
});

test('projectSelectionMode distinguishes none, single, and multi-project selection', () => {
  assert.equal(projectSelectionMode([]), 'none');
  assert.equal(projectSelectionMode([configuredProject]), 'single');
  assert.equal(projectSelectionMode([configuredProject, { ...configuredProject, id: 'hio', label: 'hio' }]), 'pick');
});

test('buildProjectQuickPickItems exposes label, id, and workspace details', () => {
  const [item] = buildProjectQuickPickItems([configuredProject]);
  assert.equal(item.label, 'keripy');
  assert.equal(item.description, 'keripy');
  assert.equal(item.detail, '02-keripy <- example-workspace');
});

test('orderInventoryCandidates prefers the newest run directory and preferred filenames inside it', () => {
  const ordered = orderInventoryCandidates(
    [
      {
        filePath: '/workspace/notes/tmp/run-001/report/issues.vscode.json',
        fileName: 'issues.vscode.json',
        directoryPath: '/workspace/notes/tmp/run-001/report',
        modifiedTime: 100,
      },
      {
        filePath: '/workspace/notes/tmp/run-002/report/issues.json',
        fileName: 'issues.json',
        directoryPath: '/workspace/notes/tmp/run-002/report',
        modifiedTime: 220,
      },
      {
        filePath: '/workspace/notes/tmp/run-002/report/issues.vscode.json',
        fileName: 'issues.vscode.json',
        directoryPath: '/workspace/notes/tmp/run-002/report',
        modifiedTime: 210,
      },
    ],
    ['issues.vscode.json', 'issues.json'],
  );

  assert.equal(ordered[0].filePath, '/workspace/notes/tmp/run-002/report/issues.vscode.json');
  assert.equal(ordered[1].filePath, '/workspace/notes/tmp/run-002/report/issues.json');
  assert.equal(ordered[2].filePath, '/workspace/notes/tmp/run-001/report/issues.vscode.json');
});

test('pickInventoryCandidate returns the preferred diagnostics file from the latest run', () => {
  const candidate = pickInventoryCandidate(
    [
      {
        filePath: '/workspace/notes/tmp/run-002/report/issues.json',
        fileName: 'issues.json',
        directoryPath: '/workspace/notes/tmp/run-002/report',
        modifiedTime: 220,
      },
      {
        filePath: '/workspace/notes/tmp/run-002/report/issues.vscode.json',
        fileName: 'issues.vscode.json',
        directoryPath: '/workspace/notes/tmp/run-002/report',
        modifiedTime: 210,
      },
    ],
    ['issues.vscode.json', 'issues.json'],
  );

  assert.equal(candidate?.filePath, '/workspace/notes/tmp/run-002/report/issues.vscode.json');
});

test('inspectDiagnosticsPayload distinguishes enriched, raw, and unknown payloads', () => {
  assert.equal(inspectDiagnosticsPayload(contract), 'enriched');
  assert.equal(
    inspectDiagnosticsPayload({
      schema: 'sphinx-inventory-sample-v1',
      issues: [],
    }),
    'raw',
  );
  assert.equal(inspectDiagnosticsPayload(rawInventoryPayload), 'raw');
  assert.equal(inspectDiagnosticsPayload({ schema: 'something-else' }), 'unknown');
  assert.equal(inspectDiagnosticsPayload(unknownIssuesFilePayload), 'unknown');
});

test('inspectDiagnosticsBindingPayload extracts raw repo roots and enriched source folders', () => {
  assert.deepEqual(
    inspectDiagnosticsBindingPayload({
      ...rawInventoryPayload,
      repo_root: '/workspace/keripy-temp',
    }),
    {
      kind: 'raw',
      repoRoot: '/workspace/keripy-temp',
    },
  );

  assert.deepEqual(
    inspectDiagnosticsBindingPayload({
      schema: 'sphinx-diagnostics-v1',
      schemaVersion: 1,
      workspace: { sourceWorkspaceFolder: '02-keripy' },
      issues: [],
    }),
    {
      kind: 'enriched',
      sourceWorkspaceFolder: '02-keripy',
    },
  );
});

test('createSelfTestDiagnosticSpec targets line 1 with the expected warning payload', () => {
  assert.deepEqual(createSelfTestDiagnosticSpec(), {
    startLine: 0,
    startColumn: 0,
    endLine: 0,
    endColumn: 1,
    message: SELF_TEST_MESSAGE,
    source: SELF_TEST_SOURCE,
    severity: 'warning',
  });
});

test('publishSelfTestDiagnostic writes one diagnostic for one target URI', () => {
  let recordedTarget: string | undefined;
  let recordedDiagnostics: Array<{ message: string; source: string }> = [];

  const result = publishSelfTestDiagnostic(
    (target: string, diagnostics: readonly { message: string; source: string }[]) => {
      recordedTarget = target;
      recordedDiagnostics = [...diagnostics];
    },
    'file:///workspace/demo.py',
    (spec) => ({
      message: spec.message,
      source: spec.source,
    }),
  );

  assert.equal(recordedTarget, 'file:///workspace/demo.py');
  assert.equal(recordedDiagnostics.length, 1);
  assert.equal(recordedDiagnostics[0]?.message, SELF_TEST_MESSAGE);
  assert.equal(recordedDiagnostics[0]?.source, SELF_TEST_SOURCE);
  assert.deepEqual(result, { diagnosticCount: 1, targetUriCount: 1 });
});

test('clearPublishedDiagnostics clears self-test diagnostics from the collection', () => {
  const collection = {
    cleared: false,
    clear() {
      this.cleared = true;
    },
  };

  clearPublishedDiagnostics(collection);
  assert.equal(collection.cleared, true);
});

test('publication index full replacement clears previous projects and records new targets', () => {
  const operations: string[] = [];
  const index = new DiagnosticsPublicationIndex<string>();
  const collection = {
    clear() {
      operations.push('clear');
    },
    delete(target: string) {
      operations.push(`delete:${target}`);
    },
  };

  index.replaceAll(
    collection,
    new Map([
      ['keripy', new Map([['file:///a1.py', 'file:///a1.py']])],
      ['hio', new Map([['file:///b1.py', 'file:///b1.py']])],
    ]),
  );
  index.replaceAll(
    collection,
    new Map([['keripy', new Map([['file:///a2.py', 'file:///a2.py']])]]),
  );

  assert.deepEqual(operations, ['clear', 'clear']);
  assert.deepEqual(index.getPublishedTargetKeys('keripy'), ['file:///a2.py']);
  assert.deepEqual(index.getPublishedTargetKeys('hio'), []);
});

test('publication index project replacement leaves other projects untouched', () => {
  const operations: string[] = [];
  const index = new DiagnosticsPublicationIndex<string>();
  const collection = {
    clear() {
      operations.push('clear');
    },
    delete(target: string) {
      operations.push(`delete:${target}`);
    },
  };

  index.replaceAll(
    collection,
    new Map([
      ['keripy', new Map([['file:///a1.py', 'file:///a1.py']])],
      ['hio', new Map([['file:///b1.py', 'file:///b1.py']])],
    ]),
  );

  operations.length = 0;
  index.replaceProjects(
    collection,
    ['keripy'],
    new Map([['keripy', new Map([['file:///a2.py', 'file:///a2.py']])]]),
  );

  assert.deepEqual(operations, ['delete:file:///a1.py']);
  assert.deepEqual(index.getPublishedTargetKeys('keripy'), ['file:///a2.py']);
  assert.deepEqual(index.getPublishedTargetKeys('hio'), ['file:///b1.py']);
});

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

test('publication index deletes stale project targets that are no longer published', () => {
  const operations: string[] = [];
  const index = new DiagnosticsPublicationIndex<string>();
  const collection = {
    clear() {
      operations.push('clear');
    },
    delete(target: string) {
      operations.push(`delete:${target}`);
    },
  };

  index.replaceAll(
    collection,
    new Map([
      ['keripy', new Map([
        ['file:///a1.py', 'file:///a1.py'],
        ['file:///a2.py', 'file:///a2.py'],
      ])],
      ['witness-hk', new Map([['file:///w1.py', 'file:///w1.py']])],
    ]),
  );

  operations.length = 0;
  index.replaceProjects(
    collection,
    ['keripy'],
    new Map([['keripy', new Map([['file:///a1.py', 'file:///a1.py']])]]),
  );

  assert.deepEqual(operations, ['delete:file:///a1.py', 'delete:file:///a2.py']);
  assert.deepEqual(index.getPublishedTargetKeys('keripy'), ['file:///a1.py']);
  assert.deepEqual(index.getPublishedTargetKeys('witness-hk'), ['file:///w1.py']);
});

test('publication index does not create fake retained-only targets', () => {
  const index = new DiagnosticsPublicationIndex<string>();
  const collection = {
    clear() {},
    delete() {},
  };

  index.replaceAll(
    collection,
    new Map([
      ['witness-hk', new Map()],
      ['hio', new Map([['file:///h1.py', 'file:///h1.py']])],
    ]),
  );

  assert.deepEqual(index.getPublishedTargetKeys('witness-hk'), []);
  assert.deepEqual(index.getPublishedTargetKeys('hio'), ['file:///h1.py']);
});

test('self-test status text and tooltip stay explicit for visibility debugging', () => {
  assert.equal(SELF_TEST_STATUS_TEXT, 'Sphinx Doctor: self-test diagnostic published');
  assert.equal(
    buildSelfTestStatusTooltip('file:///workspace/demo.py', 1),
    [
      'Sphinx Doctor self-test diagnostic published.',
      'Target: file:///workspace/demo.py',
      'Published diagnostics: 1',
    ].join('\n'),
  );
});

test('isDiagnosticsBindingCompatible rejects cross-repo inventory binding for a different worktree', () => {
  const rawMismatch = isDiagnosticsBindingCompatible(
    {
      kind: 'raw',
      repoRoot: '/workspace/hio',
    },
    {
      sourceWorkspaceFolder: '02-keripy',
      sourceRoot: '/workspace/keripy',
    },
  );
  assert.equal(rawMismatch.compatible, false);
  assert.match(rawMismatch.reason ?? '', /repo_root|source root/i);

  const enrichedMismatch = isDiagnosticsBindingCompatible(
    {
      kind: 'enriched',
      sourceWorkspaceFolder: '13-keripy-sphinx-batch-01',
    },
    {
      sourceWorkspaceFolder: '02-keripy',
      sourceRoot: '/workspace/keripy',
    },
  );
  assert.equal(enrichedMismatch.compatible, false);
  assert.match(enrichedMismatch.reason ?? '', /workspace folder/i);
});

test('isDiagnosticsBindingCompatible rejects unknown payloads and accepts matching raw inventory', () => {
  const unknown = isDiagnosticsBindingCompatible(
    {
      kind: 'unknown',
    },
    {
      sourceWorkspaceFolder: '02-keripy',
      sourceRoot: '/workspace/keripy',
    },
  );
  assert.equal(unknown.compatible, false);
  assert.match(unknown.reason ?? '', /not recognized/i);

  const rawMatch = isDiagnosticsBindingCompatible(
    {
      kind: 'raw',
      repoRoot: '/workspace/keripy',
    },
    {
      sourceWorkspaceFolder: '02-keripy',
      sourceRoot: '/workspace/keripy',
    },
  );
  assert.equal(rawMatch.compatible, true);
});

test('inspectDiagnosticsText and filename helpers identify raw and enriched files', () => {
  assert.equal(inspectDiagnosticsText(JSON.stringify(contract)), 'enriched');
  assert.equal(
    inspectDiagnosticsText(JSON.stringify(rawInventoryPayload)),
    'raw',
  );
  assert.equal(isRawInventoryFile('issues.json'), true);
  assert.equal(isRawInventoryFile('issues.vscode.json'), false);
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

test('detectProjectFromSnapshot finds a high-confidence Sphinx project from docs/conf.py', () => {
  const project = detectProjectFromSnapshot(
    { name: '02-keripy', fsPath: '/workspace/keripy' },
    {
      existingPaths: new Set(['docs/conf.py']),
      fileContents: {},
    },
    {
      includeLowConfidence: false,
      inventoryWorkspaceFolderNames: ['example-workspace'],
      excludeWorkspaceFolderNames: [],
      availableWorkspaceFolderNames: ['example-workspace', '02-keripy'],
    },
  );

  assert.equal(project?.discoveryConfidence, 'high');
  assert.equal(project?.docsRoot, 'docs');
  assert.equal(project?.sourceWorkspaceFolder, '02-keripy');
  assert.equal(project?.inventoryWorkspaceFolder, 'example-workspace');
});

test('detectProjectFromSnapshot finds a high-confidence Sphinx project from docs/source/conf.py', () => {
  const project = detectProjectFromSnapshot(
    { name: '03-hio', fsPath: '/workspace/hio' },
    {
      existingPaths: new Set(['docs/source/conf.py']),
      fileContents: {},
    },
    {
      includeLowConfidence: false,
      inventoryWorkspaceFolderNames: ['example-workspace'],
      excludeWorkspaceFolderNames: [],
      availableWorkspaceFolderNames: ['example-workspace', '03-hio'],
    },
  );

  assert.equal(project?.discoveryConfidence, 'high');
  assert.equal(project?.docsRoot, 'docs');
  assert.equal(project?.sourceWorkspaceFolder, '03-hio');
});

test('detectProjectFromSnapshot treats example-workspace as a shared inventory root, not the source repo', () => {
  const project = detectProjectFromSnapshot(
    { name: '02-keripy', fsPath: '/workspace/keripy' },
    {
      existingPaths: new Set(['docs/conf.py']),
      fileContents: {},
    },
    {
      includeLowConfidence: false,
      inventoryWorkspaceFolderNames: ['example-workspace'],
      excludeWorkspaceFolderNames: [],
      availableWorkspaceFolderNames: ['example-workspace', '02-keripy'],
    },
  );

  assert.equal(project?.sourceWorkspaceFolder, '02-keripy');
  assert.equal(project?.inventoryWorkspaceFolder, 'example-workspace');
  assert.equal(
    project?.inventorySearchTargets?.some((target) => target.workspaceFolderName === 'example-workspace'),
    true,
  );
});

test('detectProjectFromSnapshot ignores docs-only and Makefile-only folders without conf.py markers', () => {
  for (const existingPaths of [new Set(['docs']), new Set(['docs/Makefile']), new Set(['pyproject.toml'])]) {
    const project = detectProjectFromSnapshot(
      { name: '09-fortweb', fsPath: '/workspace/fortweb' },
      {
        existingPaths,
        fileContents: {},
      },
      {
        includeLowConfidence: true,
        inventoryWorkspaceFolderNames: ['example-workspace'],
        excludeWorkspaceFolderNames: [],
        availableWorkspaceFolderNames: ['example-workspace', '09-fortweb'],
      },
    );

    assert.equal(project, undefined);
  }
});

test('detectProjectFromSnapshot ignores irrelevant workspace folders', () => {
  const project = detectProjectFromSnapshot(
    { name: 'example-ops-workspace', fsPath: '/workspace/ops' },
    {
      existingPaths: new Set(['README.md']),
      fileContents: {},
    },
    {
      includeLowConfidence: false,
      inventoryWorkspaceFolderNames: ['example-workspace'],
      excludeWorkspaceFolderNames: [],
      availableWorkspaceFolderNames: ['example-workspace', 'example-ops-workspace'],
    },
  );

  assert.equal(project, undefined);
});

test('discoverWorkspaceProjects skips excluded workspace folders', async () => {
  const projects = await discoverWorkspaceProjects(
    [
      { name: 'example-workspace', fsPath: '/workspace/notes' },
      { name: '02-keripy', fsPath: '/workspace/keripy' },
      { name: 'sphinx-doctor-extension', fsPath: '/workspace/sphinx-doctor' },
    ],
    {
      includeLowConfidence: false,
      inventoryWorkspaceFolderNames: ['example-workspace'],
      excludeWorkspaceFolderNames: ['example-workspace', 'sphinx-doctor-extension'],
      knownProjects: [],
    },
    {
      exists: async (filePath) => filePath === '/workspace/keripy/docs/conf.py',
      readText: async () => undefined,
    },
  );

  assert.deepEqual(projects.map((project) => project.sourceWorkspaceFolder), ['02-keripy']);
});

test('discoverWorkspaceProjectDecisions report discovered and skipped workspace folders', async () => {
  const detectedPaths = new Set([
    '/workspace/notes/libs/keripy/docs/conf.py',
    '/workspace/notes/libs/hio/docs/source/conf.py',
  ]);

  const decisions = await discoverWorkspaceProjectDecisions(
    [
      { name: 'example-workspace', fsPath: '/workspace/notes' },
      { name: '02-keripy', fsPath: '/workspace/notes/libs/keripy' },
      { name: '03-hio', fsPath: '/workspace/notes/libs/hio' },
      { name: '08-watcher-hk', fsPath: '/workspace/notes/libs/watcher-hk' },
      { name: '09-fortweb', fsPath: '/workspace/notes/libs/fortweb' },
    ],
    {
      includeLowConfidence: true,
      inventoryWorkspaceFolderNames: ['example-workspace'],
      excludeWorkspaceFolderNames: ['example-workspace'],
      knownProjects: [],
    },
    {
      exists: async (filePath) => detectedPaths.has(filePath),
      readText: async () => undefined,
    },
  );

  assert.deepEqual(
    decisions.map((decision) => [decision.workspaceFolderName, decision.outcome, decision.reason]),
    [
      ['example-workspace', 'skipped', 'excluded by sphinxDoctor.discovery.excludeWorkspaceFolders'],
      ['02-keripy', 'discovered', 'high-confidence marker: docs/conf.py'],
      ['03-hio', 'discovered', 'high-confidence marker: docs/source/conf.py'],
      ['08-watcher-hk', 'skipped', 'no high-confidence Sphinx conf.py marker found'],
      ['09-fortweb', 'skipped', 'no high-confidence Sphinx conf.py marker found'],
    ],
  );
});

test('detected projects still include a source mirror latest.json target for artifact watching', () => {
  const project = detectProjectFromSnapshot(
    { name: '02-keripy', fsPath: '/workspace/keripy' },
    {
      existingPaths: new Set(['docs/conf.py']),
      fileContents: {},
    },
    {
      includeLowConfidence: false,
      inventoryWorkspaceFolderNames: ['example-workspace'],
      excludeWorkspaceFolderNames: [],
      availableWorkspaceFolderNames: ['example-workspace', '02-keripy'],
    },
  );

  assert.equal(
    project?.inventorySearchTargets?.some(
      (target) =>
        target.workspaceFolderName === '02-keripy' &&
        target.globs.includes('.sphinx-diagnostics/latest.json'),
    ),
    true,
  );
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

test('extension manifest declares the stable sphinxDoctor settings surface', async () => {
  const manifestText = await readFile(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8');
  const manifest = JSON.parse(manifestText) as {
    activationEvents?: string[];
    contributes?: {
      commands?: Array<{
        command?: string;
        title?: string;
      }>;
      configuration?: {
        properties?: Record<string, unknown>;
      };
    };
  };

  const commandIds = new Set(
    (manifest.contributes?.commands ?? []).map((command) => command.command).filter(Boolean),
  );
  assert.equal(commandIds.has(SELF_TEST_COMMAND_ID), true);
  assert.equal(commandIds.has('sphinxDoctor.refreshProjectDiagnostics'), true);
  assert.equal(commandIds.has('sphinxDoctor.explainDiagnosticsCounts'), true);

  const selfTestCommand = (manifest.contributes?.commands ?? []).find(
    (command) => command.command === SELF_TEST_COMMAND_ID,
  );
  assert.equal(selfTestCommand?.title, 'Sphinx Doctor: Publish Self-Test Diagnostic');

  const refreshCommand = (manifest.contributes?.commands ?? []).find(
    (command) => command.command === 'sphinxDoctor.refreshProjectDiagnostics',
  );
  assert.equal(refreshCommand?.title, 'Sphinx Doctor: Refresh Project Diagnostics');

  const explainCommand = (manifest.contributes?.commands ?? []).find(
    (command) => command.command === 'sphinxDoctor.explainDiagnosticsCounts',
  );
  assert.equal(explainCommand?.title, 'Sphinx Doctor: Explain Diagnostics Counts');

  const properties = manifest.contributes?.configuration?.properties ?? {};
  for (const key of [
    'sphinxDoctor.projects',
    'sphinxDoctor.diagnostics.mode',
    'sphinxDoctor.python.interpreter',
    'sphinxDoctor.enrichment.enabled',
    'sphinxDoctor.enrichment.autoRun',
    'sphinxDoctor.defaultSourceWorkspaceFolder',
    'sphinxDoctor.watch.enabled',
    'sphinxDoctor.watch.autoLoadOnStartup',
    'sphinxDoctor.watch.debounceMs',
    'sphinxDoctor.refresh.autoRunOnStartup',
    'sphinxDoctor.refresh.autoRunOnSave',
    'sphinxDoctor.refresh.debounceMs',
    'sphinxDoctor.discovery.enabled',
    'sphinxDoctor.discovery.includeLowConfidence',
    'sphinxDoctor.discovery.inventoryWorkspaceFolderNames',
    'sphinxDoctor.discovery.excludeWorkspaceFolders',
    'sphinxDoctor.logLevel',
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(properties, key), true, key);
  }
});

test('launch config exposes one obvious primary extension host workflow', async () => {
  const launchText = await readFile(
    path.resolve(__dirname, '..', '..', '.vscode', 'launch.json'),
    'utf8',
  );
  const launch = JSON.parse(launchText) as {
    configurations?: Array<{
      name?: string;
      type?: string;
      args?: string[];
      preLaunchTask?: string;
    }>;
  };

  const primary = (launch.configurations ?? []).find(
    (configuration) => configuration.name === 'Run Sphinx Doctor Extension Host',
  );

  assert.equal(primary?.type, 'extensionHost');
  assert.equal(primary?.preLaunchTask, 'npm: compile');
  assert.deepEqual(primary?.args?.slice(0, 3), [
    '--new-window',
    '--disable-extensions',
    '--extensionDevelopmentPath=${workspaceFolder}',
  ]);
});

test('extension manifest exposes local package and install scripts', async () => {
  const manifestText = await readFile(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8');
  const manifest = JSON.parse(manifestText) as {
    publisher?: string;
    scripts?: Record<string, string>;
  };

  assert.equal(manifest.publisher, 'jaelliot');
  assert.equal(manifest.scripts?.package, 'npm exec --yes --package @vscode/vsce -- vsce package');
  assert.equal(
    manifest.scripts?.['install:local'],
    'npm run package && code --install-extension ./sphinx-doctor-vscode-$npm_package_version.vsix --force',
  );
});

test('mergeProjects keeps explicit projects and suppresses discovered duplicates by source folder', () => {
  const merged = mergeProjects(
    [configuredProject],
    [
      {
        ...configuredProject,
        id: 'discovered-keripy',
        discoveryConfidence: 'high',
        discoveryReasons: ['high-confidence marker: docs/conf.py'],
        origin: 'discovered',
      },
      {
        ...configuredProject,
        id: 'hio',
        sourceWorkspaceFolder: '03-hio',
        inventoryWorkspaceFolder: 'example-workspace',
        discoveryConfidence: 'high',
        discoveryReasons: ['high-confidence marker: docs/source/conf.py'],
        origin: 'discovered',
      },
    ],
  );

  assert.equal(merged.length, 2);
  assert.equal(merged[0].origin, 'configured');
  assert.equal(merged[1].sourceWorkspaceFolder, '03-hio');
});

test('buildDiscoveryProbePaths stays bounded to relative workspace paths', () => {
  assert.equal(
    buildDiscoveryProbePaths().every((entry) => !entry.startsWith('/') && !entry.startsWith('..')),
    true,
  );
});

test('parseGitWorktreeListPorcelain parses porcelain worktree entries', () => {
  const entries = parseGitWorktreeListPorcelain([
    'worktree /workspace/notes/libs/keripy',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree /workspace/notes/libs/keripy-docstring-koming-001',
    'HEAD def456',
    'branch refs/heads/chore/docstrings-koming',
    '',
  ].join('\n'));

  assert.deepEqual(entries, [
    {
      worktreePath: '/workspace/notes/libs/keripy',
      head: 'abc123',
      branch: 'refs/heads/main',
    },
    {
      worktreePath: '/workspace/notes/libs/keripy-docstring-koming-001',
      head: 'def456',
      branch: 'refs/heads/chore/docstrings-koming',
    },
  ]);
});

test('discoverWorkspaceProjectDecisions discovers a synthetic worktree project for a known canonical project', async () => {
  const decisions = await discoverWorkspaceProjectDecisions(
    [
      { name: 'example-workspace', fsPath: '/workspace/notes' },
      { name: '02-keripy', fsPath: '/workspace/notes/libs/keripy' },
    ],
    {
      includeLowConfidence: false,
      inventoryWorkspaceFolderNames: ['example-workspace'],
      excludeWorkspaceFolderNames: ['example-workspace'],
      knownProjects: [configuredProject],
    },
    {
      exists: async (filePath) => filePath === '/workspace/notes/libs/keripy-docstring-koming-001/docs/conf.py',
      readText: async () => undefined,
      listGitWorktrees: async () => [
        'worktree /workspace/notes/libs/keripy',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
        'worktree /workspace/notes/libs/keripy-docstring-koming-001',
        'HEAD def456',
        'branch refs/heads/chore/docstrings-koming',
        '',
      ].join('\n'),
    },
  );

  const worktreeProject = decisions.find((decision) => decision.project?.id === 'keripy@keripy-docstring-koming-001')?.project;
  assert.ok(worktreeProject);
  assert.equal(worktreeProject?.baseProjectId, 'keripy');
  assert.equal(worktreeProject?.label, 'keripy-docstring-koming-001');
  assert.equal(worktreeProject?.sourceRootPath, '/workspace/notes/libs/keripy-docstring-koming-001');
  assert.equal(worktreeProject?.sourceWorkspaceFolder, 'keripy-docstring-koming-001');
});

test('discoverWorkspaceProjectDecisions skips the canonical worktree root duplicate', async () => {
  const decisions = await discoverWorkspaceProjectDecisions(
    [
      { name: 'example-workspace', fsPath: '/workspace/notes' },
      { name: '02-keripy', fsPath: '/workspace/notes/libs/keripy' },
    ],
    {
      includeLowConfidence: false,
      inventoryWorkspaceFolderNames: ['example-workspace'],
      excludeWorkspaceFolderNames: ['example-workspace'],
      knownProjects: [configuredProject],
    },
    {
      exists: async () => true,
      readText: async () => undefined,
      listGitWorktrees: async () => [
        'worktree /workspace/notes/libs/keripy',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
      ].join('\n'),
    },
  );

  assert.equal(decisions.some((decision) => decision.project?.id === 'keripy@keripy'), false);
});

test('discoverWorkspaceProjectDecisions ignores worktrees without Sphinx markers', async () => {
  const decisions = await discoverWorkspaceProjectDecisions(
    [
      { name: 'example-workspace', fsPath: '/workspace/notes' },
      { name: '02-keripy', fsPath: '/workspace/notes/libs/keripy' },
    ],
    {
      includeLowConfidence: false,
      inventoryWorkspaceFolderNames: ['example-workspace'],
      excludeWorkspaceFolderNames: ['example-workspace'],
      knownProjects: [configuredProject],
    },
    {
      exists: async () => false,
      readText: async () => undefined,
      listGitWorktrees: async () => [
        'worktree /workspace/notes/libs/keripy-docstring-koming-001',
        'HEAD def456',
        'branch refs/heads/chore/docstrings-koming',
        '',
      ].join('\n'),
    },
  );

  assert.equal(decisions.some((decision) => decision.project?.baseProjectId === 'keripy'), false);
});

test('discoverWorkspaceProjectDecisions rejects worktree paths outside the trusted workspace root', async () => {
  const decisions = await discoverWorkspaceProjectDecisions(
    [
      { name: 'example-workspace', fsPath: '/workspace/notes' },
      { name: '02-keripy', fsPath: '/workspace/notes/libs/keripy' },
    ],
    {
      includeLowConfidence: false,
      inventoryWorkspaceFolderNames: ['example-workspace'],
      excludeWorkspaceFolderNames: ['example-workspace'],
      knownProjects: [configuredProject],
    },
    {
      exists: async () => true,
      readText: async () => undefined,
      listGitWorktrees: async () => [
        'worktree /tmp/keripy-docstring-koming-001',
        'HEAD def456',
        'branch refs/heads/chore/docstrings-koming',
        '',
      ].join('\n'),
    },
  );

  assert.equal(decisions.some((decision) => decision.project?.id === 'keripy@keripy-docstring-koming-001'), false);
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

test('mergeProjects keeps base and worktree projects distinct by project id', () => {
  const merged = mergeProjects(
    [configuredProject],
    [
      {
        ...configuredProject,
        id: 'keripy@keripy-docstring-koming-001',
        baseProjectId: 'keripy',
        label: 'keripy-docstring-koming-001',
        sourceWorkspaceFolder: 'keripy-docstring-koming-001',
        sourceRootPath: '/workspace/notes/libs/keripy-docstring-koming-001',
        origin: 'discovered',
      },
    ],
  );

  assert.deepEqual(merged.map((project) => project.id), ['keripy', 'keripy@keripy-docstring-koming-001']);
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