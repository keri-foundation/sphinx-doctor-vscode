import assert from 'node:assert/strict';
import test from 'node:test';

import { DiagnosticsPublicationIndex } from '../src/publication/publicationIndex';

function makeCollection(): { clear(): void; delete(target: string): void } & { operations: string[] } {
  const operations: string[] = [];
  return {
    clear() {
      operations.push('clear');
    },
    delete(target: string) {
      operations.push(`delete:${target}`);
    },
    operations,
  };
}

test('publication index full replacement clears previous projects and records new targets', () => {
  const collection = makeCollection();
  const index = new DiagnosticsPublicationIndex<string>();

  index.replaceAll(
    collection,
    new Map([
      ['keripy', new Map([['file:///a1.py', 'file:///a1.py']])],
      ['hio', new Map([['file:///b1.py', 'file:///b1.py']])],
    ]),
  );
  index.replaceAll(
    collection,
    new Map([['keripy', new Map([['file:///a2.py', 'file:///a2.py']])]]),
  );

  assert.deepEqual(collection.operations, ['clear', 'clear']);
  assert.deepEqual(index.getPublishedTargetKeys('keripy'), ['file:///a2.py']);
  assert.deepEqual(index.getPublishedTargetKeys('hio'), []);
});

test('publication index project replacement leaves other projects untouched', () => {
  const collection = makeCollection();
  const index = new DiagnosticsPublicationIndex<string>();

  index.replaceAll(
    collection,
    new Map([
      ['keripy', new Map([['file:///a1.py', 'file:///a1.py']])],
      ['hio', new Map([['file:///b1.py', 'file:///b1.py']])],
    ]),
  );

  collection.operations.length = 0;
  index.replaceProjects(
    collection,
    ['keripy'],
    new Map([['keripy', new Map([['file:///a2.py', 'file:///a2.py']])]]),
  );

  assert.deepEqual(collection.operations, ['delete:file:///a1.py']);
  assert.deepEqual(index.getPublishedTargetKeys('keripy'), ['file:///a2.py']);
  assert.deepEqual(index.getPublishedTargetKeys('hio'), ['file:///b1.py']);
});

test('publication index deletes stale project targets that are no longer published', () => {
  const collection = makeCollection();
  const index = new DiagnosticsPublicationIndex<string>();

  index.replaceAll(
    collection,
    new Map([
      ['keripy', new Map([
        ['file:///a1.py', 'file:///a1.py'],
        ['file:///a2.py', 'file:///a2.py'],
      ])],
      ['witness-hk', new Map([['file:///w1.py', 'file:///w1.py']])],
    ]),
  );

  collection.operations.length = 0;
  index.replaceProjects(
    collection,
    ['keripy'],
    new Map([['keripy', new Map([['file:///a1.py', 'file:///a1.py']])]]),
  );

  assert.deepEqual(collection.operations, ['delete:file:///a1.py', 'delete:file:///a2.py']);
  assert.deepEqual(index.getPublishedTargetKeys('keripy'), ['file:///a1.py']);
  assert.deepEqual(index.getPublishedTargetKeys('witness-hk'), ['file:///w1.py']);
});

test('publication index does not create fake retained-only targets', () => {
  const index = new DiagnosticsPublicationIndex<string>();
  const collection = {
    clear() {},
    delete() {},
  };

  index.replaceAll(
    collection,
    new Map([
      ['witness-hk', new Map()],
      ['hio', new Map([['file:///h1.py', 'file:///h1.py']])],
    ]),
  );

  assert.deepEqual(index.getPublishedTargetKeys('witness-hk'), []);
  assert.deepEqual(index.getPublishedTargetKeys('hio'), ['file:///h1.py']);
});

test('publication index deleteKnownTargets only removes tracked targets, preserving untracked diagnostics', () => {
  const collection = makeCollection();
  const index = new DiagnosticsPublicationIndex<string>();

  // First, register some targets through replaceAll (simulating watch load)
  index.replaceAll(
    collection,
    new Map([
      ['keripy', new Map([['file:///a1.py', 'file:///a1.py']])],
    ]),
  );

  collection.operations.length = 0;

  // deleteKnownTargets should only delete tracked targets, not call clear()
  index.deleteKnownTargets(collection);

  // Should not have called clear() — only delete() for tracked targets
  assert.ok(!collection.operations.includes('clear'), 'deleteKnownTargets must not call collection.clear()');
  assert.deepEqual(collection.operations, ['delete:file:///a1.py']);

  // Index should be empty after deletion
  assert.deepEqual(index.getPublishedTargetKeys('keripy'), []);
});
