import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DocstringRepairTargetIndex } from '../../../src/docstrings/repair/docstringRepairTargetIndex';
import { createDocstringRepairTarget } from '../../../src/docstrings/repair/docstringRepairTarget';
import type { DocstringRepairTarget } from '../../../src/docstrings/repair/docstringRepairTarget';

function makeTarget(overrides: Partial<DocstringRepairTarget> = {}): DocstringRepairTarget {
  return {
    language: 'python',
    mappingConfidence: 'high',
    anchorKind: 'docstring-line',
    sourceSpan: { startOffset: 100, endOffset: 140 },
    targetOffset: 110,
    fingerprint: 'abc123def456',
    ...overrides,
  } as DocstringRepairTarget;
}

test('a target created from valid mapper data is indexed correctly', () => {
  const index = new DocstringRepairTargetIndex();
  const target = makeTarget();
  const identity = 'test-identity-for-issue-1';
  assert.equal(index.registerTarget(identity, target), true);
  assert.equal(index.size, 1);
  const resolved = index.getTarget(identity);
  assert.ok(resolved);
  assert.equal(resolved.fingerprint, 'abc123def456');
});

test('a low-confidence mapper result produces no target and is not indexed', () => {
  const target = createDocstringRepairTarget({
    source: 'def f():\n    """doc"""\n    pass\n',
    docstringStartOffset: 10,
    docstringEndOffset: 17,
    targetOffset: 13,
    mappingConfidence: 'low',
    anchorKind: 'docstring-line',
  });
  assert.equal(target, undefined);
});

test('a fallback anchor kind produces no target', () => {
  const target = createDocstringRepairTarget({
    source: 'def f():\n    """doc"""\n    pass\n',
    docstringStartOffset: 10,
    docstringEndOffset: 17,
    targetOffset: 13,
    mappingConfidence: 'high',
    anchorKind: 'docstring-line-fallback',
  });
  assert.equal(target, undefined);
});

test('publication cleanup removes targets', () => {
  const index = new DocstringRepairTargetIndex();
  assert.equal(index.registerTarget('id-A', makeTarget({ fingerprint: 'fp-a' })), true);
  assert.equal(index.registerTarget('id-B', makeTarget({ fingerprint: 'fp-b' })), true);
  assert.equal(index.size, 2);
  index.clear();
  assert.equal(index.size, 0);
  assert.equal(index.getTarget('id-A'), undefined);
  assert.equal(index.getTarget('id-B'), undefined);
});

test('a registration collision leaves diagnostics visible but repair-ineligible', () => {
  const index = new DocstringRepairTargetIndex();
  const identity = 'shared-identity';
  assert.equal(index.registerTarget(identity, makeTarget({ fingerprint: 'fp-1' })), true);
  assert.equal(index.size, 1);
  assert.equal(index.registerTarget(identity, makeTarget({ fingerprint: 'fp-2' })), false);
  assert.equal(index.size, 0);
  assert.equal(index.collisionCount, 1);
  assert.equal(index.isCollision(identity), true);
  assert.equal(index.registerTarget(identity, makeTarget()), false);
});
