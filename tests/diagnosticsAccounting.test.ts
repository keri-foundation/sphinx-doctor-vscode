import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDiagnosticsAccountingReport,
  buildDiagnosticsCountsToastMessage,
} from '../src/diagnostics/diagnosticsAccounting';
import { DiagnosticsContract } from '../src/types';
import type { PublishResult } from '../src/publication/publishDiagnostics';

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
