import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assessDocstringRemediation } from '../../../src/docstrings/remediation/docstringRemediationPolicy';
import type { DiagnosticsIssue } from '../../../src/types';

function makeIssue(overrides: Partial<DiagnosticsIssue> = {}): DiagnosticsIssue {
  return {
    id: 'issue-1', severity: 'warning', category: 'unexpected-indentation', code: 'unexpected-indentation',
    message: 'Unexpected indentation in docstring at line 7.', raw: {},
    repoRelativePath: 'test/file.py', inventoryRelativePath: 'test/file.py',
    rawLocation: 'test/file.py:docstring of Foo.bar:3',
    sourceRange: { startLine: 10, startColumn: 0, endLine: 10, endColumn: 0, anchorKind: 'docstring-line' },
    mapping: { confidence: 'high', strategy: 'sphinx-docstring-warning', reason: 'test', objectResolved: true, lineResolved: true },
    publishDiagnostic: true, related: [], sourceWorkspaceFolder: 'test-project',
    ...overrides,
  };
}

test('assessments do not contain raw diagnostic message text', () => {
  const issue = makeIssue({ message: 'Unexpected indentation in docstring at line 7.' });
  const result = assessDocstringRemediation(issue);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('Unexpected indentation'));
  assert.ok(!serialized.includes('line 7'));
});

test('assessments do not contain paths, URIs, source text, fingerprints, offsets, or target identities', () => {
  const result = assessDocstringRemediation(makeIssue());
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('file.py'));
  assert.ok(!serialized.includes('test-project'));
  assert.ok(!serialized.includes('fingerprint'));
  assert.ok(!serialized.includes('offset'));
  assert.ok(!serialized.includes('target'));
  assert.ok(!serialized.includes('identity'));
});

test('every manual-guidance result has bounded string content', () => {
  const result = assessDocstringRemediation(makeIssue());
  assert.equal(result.disposition, 'manual-guidance');
  assert.ok(result.title.length < 200);
  for (const line of result.guidance) {
    assert.ok(line.length < 500);
  }
  assert.ok(result.guidance.length <= 8);
});

test('static policy results are deterministic for equivalent input', () => {
  const a = assessDocstringRemediation(makeIssue({ category: 'unexpected-indentation' }));
  const b = assessDocstringRemediation(makeIssue({ category: 'unexpected-indentation' }));
  assert.deepEqual(a, b);
});

test('no unsupported values or arbitrary objects are exposed', () => {
  const result = assessDocstringRemediation(makeIssue());
  const serialized = JSON.stringify(result);
  // Only allowed keys
  const parsed = JSON.parse(serialized);
  const keys = Object.keys(parsed);
  for (const key of keys) {
    assert.ok(['disposition', 'rule', 'title', 'guidance', 'validation'].includes(key),
      `Unexpected key: ${key}`);
  }
});

test('diagnostic-only result has stable guidance', () => {
  const result = assessDocstringRemediation(makeIssue({ category: 'missing-reference' }));
  assert.equal(result.disposition, 'diagnostic-only');
  assert.ok(result.guidance.length >= 2);
  assert.equal(result.validation, 'rerun-sphinx-doctor');
});
