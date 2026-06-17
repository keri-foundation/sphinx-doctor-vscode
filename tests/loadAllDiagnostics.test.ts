import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLoadAllDiagnosticsStatusMessage,
  loadAllDiscoveredDiagnostics,
} from '../src/loadAllDiagnostics';

test('load-all diagnostics status message summarizes loaded and skipped projects', () => {
  assert.equal(
    buildLoadAllDiagnosticsStatusMessage({
      discoveredProjectCount: 2,
      knownProjectCount: 3,
      loadedProjectCount: 2,
      skippedProjectCount: 1,
      issueCount: 451,
      publishedDiagnostics: 194,
    }),
    'Sphinx Doctor inspected 3 supported project(s); 2 loaded; 1 skipped; 451 issues; 194 published diagnostics',
  );
});

test('load-all diagnostics uses watch-mode batch loading and avoids project selection', async () => {
  const calls: Array<{ reason: string; loadDiagnostics: boolean | undefined }> = [];
  const infoMessages: string[] = [];
  const warningMessages: string[] = [];

  const snapshot = await loadAllDiscoveredDiagnostics({
    watchMode: {
      async refreshAll(reason, loadDiagnostics) {
        calls.push({ reason, loadDiagnostics });
      },
      getLastRefreshSnapshot() {
        return {
          discoveredProjectCount: 2,
          knownProjectCount: 3,
          loadedProjectCount: 2,
          skippedProjectCount: 1,
          issueCount: 451,
          publishedDiagnostics: 194,
        };
      },
    },
    logger: {
      info: () => {},
      warn: () => {},
    },
    showWarningMessage(message) {
      warningMessages.push(message);
    },
    showInformationMessage(message) {
      infoMessages.push(message);
    },
  });

  assert.deepEqual(calls, [
    { reason: 'manual command: discover and load diagnostics', loadDiagnostics: true },
  ]);
  assert.deepEqual(warningMessages, []);
  assert.deepEqual(infoMessages, [
    'Sphinx Doctor inspected 3 supported project(s); 2 loaded; 1 skipped; 451 issues; 194 published diagnostics',
  ]);
  assert.deepEqual(snapshot, {
    discoveredProjectCount: 2,
    knownProjectCount: 3,
    loadedProjectCount: 2,
    skippedProjectCount: 1,
    issueCount: 451,
    publishedDiagnostics: 194,
  });
});

test('load-all diagnostics warns when watch mode is unavailable', async () => {
  const infoMessages: string[] = [];
  const warningMessages: string[] = [];

  const snapshot = await loadAllDiscoveredDiagnostics({
    logger: {
      info: () => {},
      warn: () => {},
    },
    showWarningMessage(message) {
      warningMessages.push(message);
    },
    showInformationMessage(message) {
      infoMessages.push(message);
    },
  });

  assert.equal(snapshot, undefined);
  assert.deepEqual(infoMessages, []);
  assert.deepEqual(warningMessages, [
    'Sphinx Doctor watch mode is unavailable, so Discover and Load Diagnostics cannot load all workspace projects.',
  ]);
});
