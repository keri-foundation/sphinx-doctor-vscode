import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inspectDiagnosticsBindingPayload,
  inspectDiagnosticsPayload,
  inspectDiagnosticsText,
  isDiagnosticsBindingCompatible,
} from '../src/diagnostics/loadDiagnostics';
import { isRawInventoryFile } from '../src/workspace/inventoryCandidates';
import { DiagnosticsContract } from '../src/types';

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
