import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDiagnosticMessage,
  DiagnosticsIssue,
  issueMatchesDiagnosticMode,
  normalizeDiagnosticMode,
  normalizeSeverityName,
  shouldPublishIssue,
  summarizeDiagnosticMode,
  toZeroBasedPosition,
} from '../src/types';

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

test('buildDiagnosticMessage includes category, object name, and low-confidence marker', () => {
  assert.equal(
    buildDiagnosticMessage(mappedIssue),
    '[unexpected-indentation] Unexpected indentation in autodoc docstring block. (keri.core.coring.Number) [confidence: low]',
  );
});
