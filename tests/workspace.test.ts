import assert from 'node:assert/strict';
import test from 'node:test';

import { DiagnosticsContract, DiagnosticsIssue } from '../src/types';
import {
  orderInventoryCandidates,
  pickInventoryCandidate,
  resolveIssueFilePath,
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
