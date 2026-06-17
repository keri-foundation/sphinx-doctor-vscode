import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildEnrichmentRunPlan,
  buildRunId,
  getEnrichmentPermission,
} from '../src/enrichment/enrichmentRunner';

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
