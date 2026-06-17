import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSelfTestStatusTooltip,
  clearPublishedDiagnostics,
  createSelfTestDiagnosticSpec,
  publishSelfTestDiagnostic,
  SELF_TEST_MESSAGE,
  SELF_TEST_SOURCE,
  SELF_TEST_STATUS_TEXT,
} from '../src/commands/selfTestDiagnostic';

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
