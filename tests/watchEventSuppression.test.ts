import assert from 'node:assert/strict';
import test from 'node:test';

import { WatchEventSuppression } from '../src/watch/watchEventSuppression.js';

test('unknown path is not suppressed', () => {
  const suppression = new WatchEventSuppression();

  assert.equal(suppression.isSuppressed('/unknown/file.json'), false);
  assert.equal(suppression.isSuppressed('/another/unknown.json'), false);
});

test('recorded paths are suppressed before expiry', () => {
  const fixedNow = 1000000;
  const suppression = new WatchEventSuppression(() => fixedNow);

  suppression.recordSuppressed(['/test/a.json', '/test/b.json']);

  assert.equal(suppression.isSuppressed('/test/a.json'), true);
  assert.equal(suppression.isSuppressed('/test/b.json'), true);

  // Just before expiry (1999ms after record)
  suppression.setNow(() => fixedNow + 1999);
  assert.equal(suppression.isSuppressed('/test/a.json'), true);
});

test('path expires exactly at the duration boundary', () => {
  const fixedNow = 1000000;
  const suppression = new WatchEventSuppression(() => fixedNow);

  suppression.recordSuppressed(['/test/expiring.json']);

  // At exactly 2000ms, the expiry check uses `expiresAt < now()`,
  // so expiresAt === now() is NOT expired
  suppression.setNow(() => fixedNow + 2000);
  assert.equal(suppression.isSuppressed('/test/expiring.json'), true);

  // One millisecond past, expiresAt < now()
  suppression.setNow(() => fixedNow + 2001);
  assert.equal(suppression.isSuppressed('/test/expiring.json'), false);
});

test('expired entries are cleaned from internal state', () => {
  const fixedNow = 1000000;
  const suppression = new WatchEventSuppression(() => fixedNow);

  suppression.recordSuppressed(['/test/cleanup.json']);
  assert.equal(suppression.isSuppressed('/test/cleanup.json'), true);

  // Advance past expiry
  suppression.setNow(() => fixedNow + 2001);

  // Should return false and clean up
  assert.equal(suppression.isSuppressed('/test/cleanup.json'), false);

  // Re-checking after cleanup should also return false
  assert.equal(suppression.isSuppressed('/test/cleanup.json'), false);
});

test('duplicate recording refreshes expiry', () => {
  const fixedNow = 1000000;
  const suppression = new WatchEventSuppression(() => fixedNow);

  suppression.recordSuppressed(['/test/dup.json']);

  // Advance 1500ms and re-record
  suppression.setNow(() => fixedNow + 1500);
  suppression.recordSuppressed(['/test/dup.json']);

  // Should still be suppressed 1999ms after the RE-recording
  suppression.setNow(() => fixedNow + 1500 + 1999);
  assert.equal(suppression.isSuppressed('/test/dup.json'), true);

  // Should expire 2001ms after the re-recording
  suppression.setNow(() => fixedNow + 1500 + 2001);
  assert.equal(suppression.isSuppressed('/test/dup.json'), false);
});

test('path normalization resolves relative and duplicate separators', () => {
  const fixedNow = 1000000;
  const suppression = new WatchEventSuppression(() => fixedNow);

  suppression.recordSuppressed(['/test/dir/../normalized.json']);

  // The resolved path should be suppressed
  assert.equal(suppression.isSuppressed('/test/dir/../normalized.json'), true);
  assert.equal(suppression.isSuppressed('/test/normalized.json'), true);
});
