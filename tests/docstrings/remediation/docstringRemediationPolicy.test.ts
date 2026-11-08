import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assessDocstringRemediation } from '../../../src/docstrings/remediation/docstringRemediationPolicy';
import type { DiagnosticsIssue } from '../../../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<DiagnosticsIssue> = {}): DiagnosticsIssue {
  return {
    id: 'issue-1',
    severity: 'warning',
    category: 'unexpected-indentation',
    code: 'unexpected-indentation',
    message: 'Unexpected indentation.',
    raw: {},
    repoRelativePath: 'test/file.py',
    inventoryRelativePath: 'test/file.py',
    rawLocation: 'test/file.py:docstring of Foo.bar:3',
    sourceRange: { startLine: 10, startColumn: 0, endLine: 10, endColumn: 0, anchorKind: 'docstring-line' },
    mapping: { confidence: 'high', strategy: 'sphinx-docstring-warning', reason: 'test', objectResolved: true, lineResolved: true },
    publishDiagnostic: true,
    related: [],
    sourceWorkspaceFolder: 'test-project',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — eligibility
// ---------------------------------------------------------------------------

test('unexpected-indentation returns manual-guidance', () => {
  const result = assessDocstringRemediation(makeIssue({ category: 'unexpected-indentation', code: 'unexpected-indentation' }));
  assert.equal(result.disposition, 'manual-guidance');
  assert.equal(result.rule, 'normalize-indentation');
  assert.ok(result.title.length > 0);
  assert.ok(result.guidance.length >= 2);
  assert.equal(result.validation, 'rerun-sphinx-doctor');
});

test('block-quote-unindent returns manual-guidance', () => {
  const result = assessDocstringRemediation(makeIssue({ category: 'block-quote-unindent', code: 'block-quote-unindent' }));
  assert.equal(result.disposition, 'manual-guidance');
  assert.equal(result.rule, 'repair-block-quote-boundary');
});

test('definition-list-unindent returns manual-guidance', () => {
  const result = assessDocstringRemediation(makeIssue({ category: 'definition-list-unindent', code: 'definition-list-unindent' }));
  assert.equal(result.disposition, 'manual-guidance');
  assert.equal(result.rule, 'repair-definition-list-boundary');
});

test('literal-block returns manual-guidance', () => {
  const result = assessDocstringRemediation(makeIssue({ category: 'literal-block', code: 'literal-block' }));
  assert.equal(result.disposition, 'manual-guidance');
  assert.equal(result.rule, 'repair-literal-block-boundary');
});

test('missing-reference returns diagnostic-only', () => {
  const result = assessDocstringRemediation(makeIssue({ category: 'missing-reference', code: 'missing-reference' }));
  assert.equal(result.disposition, 'diagnostic-only');
});

test('ambiguous-reference returns diagnostic-only', () => {
  const result = assessDocstringRemediation(makeIssue({ category: 'ambiguous-reference', code: 'ambiguous-reference' }));
  assert.equal(result.disposition, 'diagnostic-only');
});

test('unknown category returns diagnostic-only', () => {
  const result = assessDocstringRemediation(makeIssue({ category: 'unknown-cat', code: 'unknown-cat' }));
  assert.equal(result.disposition, 'diagnostic-only');
});

test('fallback mapping (anchorKind != docstring-line) returns diagnostic-only', () => {
  const result = assessDocstringRemediation(makeIssue({
    category: 'unexpected-indentation',
    sourceRange: { startLine: 10, startColumn: 0, endLine: 10, endColumn: 0, anchorKind: 'docstring-line-fallback' },
  }));
  assert.equal(result.disposition, 'diagnostic-only');
});

test('low-confidence mapping returns diagnostic-only', () => {
  const result = assessDocstringRemediation(makeIssue({
    category: 'unexpected-indentation',
    mapping: { confidence: 'low', strategy: 'sphinx-docstring-warning', reason: 'test', objectResolved: false, lineResolved: false },
  }));
  assert.equal(result.disposition, 'diagnostic-only');
});

test('unpublished diagnostic returns diagnostic-only', () => {
  const result = assessDocstringRemediation(makeIssue({
    category: 'unexpected-indentation',
    publishDiagnostic: false,
  }));
  assert.equal(result.disposition, 'diagnostic-only');
});
