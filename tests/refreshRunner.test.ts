import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildRefreshScopeComparison,
  detectRefreshScopeDrift,
  evaluateRefreshBaselinePromotion,
  formatRefreshScopeDriftWarning,
} from '../src/enrichmentRunner';

import {
  applyRefreshScopeToConfig,
  buildRefreshCategoryArgs,
  buildRefreshRunPlan,
  filterRecentInventoryCandidates,
  getRefreshPermission,
  inferProjectRefreshConfig,
  inferRefreshScopeFromContract,
} from '../src/refreshRunner';

import type { ConfiguredProject, DiagnosticsContract, DiagnosticsIssue } from '../src/types';

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
