import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildProjectQuickPickItems,
  coerceRefreshDebounceMs,
  coerceProjects,
  projectSelectionMode,
} from '../src/config';
import { ConfiguredProject, ProjectRefreshConfig } from '../src/types';

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

const configuredRefresh: ProjectRefreshConfig = {
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
