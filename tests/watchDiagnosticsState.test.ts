import assert from 'node:assert/strict';
import test from 'node:test';

import { WatchDiagnosticsState } from '../src/watch/watchDiagnosticsState.js';
import { ProjectPublicationSnapshot } from '../src/watch/watchModeState.js';

function buildSnapshot(overrides?: Partial<ProjectPublicationSnapshot>): ProjectPublicationSnapshot {
  return {
    loaded: true,
    loadedPath: '/test/issues.json',
    issueCount: 10,
    publishableBeforeFilter: 8,
    publishedDiagnostics: 5,
    filteredByMode: 3,
    skippedIssues: 0,
    resolutionFailures: 0,
    ...overrides,
  };
}

test('initial state has zero counters and empty maps', () => {
  const state = new WatchDiagnosticsState();

  assert.equal(state.getIssueCount(), 0);
  assert.equal(state.getPublishedCount(), 0);
  assert.equal(state.getPublishableBeforeFilterCount(), 0);
  assert.equal(state.getFilteredByModeCount(), 0);
  assert.equal(state.getSkippedCount(), 0);
  assert.equal(state.getResolutionFailureCount(), 0);
  assert.equal(state.getRawPendingCount(), 0);
  assert.equal(state.getErrorCount(), 0);
  assert.equal(state.getProjectPublications().size, 0);
  assert.equal(state.getProjectStatuses().size, 0);
});

test('deriveAggregateFromSnapshots computes correct aggregate counters from publications', () => {
  const state = new WatchDiagnosticsState();

  state.setProjectPublication('proj-a', buildSnapshot({
    issueCount: 10,
    publishableBeforeFilter: 8,
    publishedDiagnostics: 5,
    filteredByMode: 3,
    skippedIssues: 0,
    resolutionFailures: 0,
    loadedPath: '/test/a.json',
  }));
  state.setProjectPublication('proj-b', buildSnapshot({
    issueCount: 32,
    publishableBeforeFilter: 32,
    publishedDiagnostics: 10,
    filteredByMode: 22,
    skippedIssues: 2,
    resolutionFailures: 3,
    loadedPath: '/test/b.json',
  }));

  const { loadedDiagnosticsFiles } = state.deriveAggregateFromSnapshots();

  assert.equal(state.getIssueCount(), 42);
  assert.equal(state.getPublishableBeforeFilterCount(), 40);
  assert.equal(state.getPublishedCount(), 15);
  assert.equal(state.getFilteredByModeCount(), 25);
  assert.equal(state.getSkippedCount(), 2);
  assert.equal(state.getResolutionFailureCount(), 3);

  assert.deepStrictEqual(loadedDiagnosticsFiles.sort(), ['/test/a.json', '/test/b.json']);
});

test('applyManualCounters sets all six aggregate counters from direct/manual input', () => {
  const state = new WatchDiagnosticsState();

  state.applyManualCounters({
    issueCount: 42,
    publishableBeforeFilter: 40,
    publishedDiagnostics: 15,
    filteredByMode: 25,
    skippedIssues: 2,
    resolutionFailures: 3,
  });

  assert.equal(state.getIssueCount(), 42);
  assert.equal(state.getPublishableBeforeFilterCount(), 40);
  assert.equal(state.getPublishedCount(), 15);
  assert.equal(state.getFilteredByModeCount(), 25);
  assert.equal(state.getSkippedCount(), 2);
  assert.equal(state.getResolutionFailureCount(), 3);
});

test('clear resets all counters and empties maps', () => {
  const state = new WatchDiagnosticsState();

  state.setProjectPublication('proj-a', buildSnapshot({ issueCount: 42 }));
  state.setProjectStatus('proj-a', 'published 5 diagnostics from /test/a.json');
  state.setRawPendingCount(3);
  state.setErrorCount(1);
  state.applyManualCounters({
    issueCount: 42,
    publishableBeforeFilter: 40,
    publishedDiagnostics: 15,
    filteredByMode: 25,
    skippedIssues: 2,
    resolutionFailures: 3,
  });

  assert.ok(state.getProjectPublications().size > 0);
  assert.ok(state.getProjectStatuses().size > 0);

  state.clear();

  assert.equal(state.getIssueCount(), 0);
  assert.equal(state.getPublishableBeforeFilterCount(), 0);
  assert.equal(state.getPublishedCount(), 0);
  assert.equal(state.getFilteredByModeCount(), 0);
  assert.equal(state.getSkippedCount(), 0);
  assert.equal(state.getResolutionFailureCount(), 0);
  assert.equal(state.getRawPendingCount(), 0);
  assert.equal(state.getErrorCount(), 0);
  assert.equal(state.getProjectPublications().size, 0);
  assert.equal(state.getProjectStatuses().size, 0);
});

test('setProjectStatus records and retrieves project status strings', () => {
  const state = new WatchDiagnosticsState();

  state.setProjectStatus('proj-a', 'published 5 diagnostics from /test/a.json');
  state.setProjectStatus('proj-b', 'no inventory artifacts found');

  const statuses = state.getProjectStatuses();
  assert.equal(statuses.size, 2);
  assert.equal(statuses.get('proj-a'), 'published 5 diagnostics from /test/a.json');
  assert.equal(statuses.get('proj-b'), 'no inventory artifacts found');

  state.setProjectStatus('proj-a', 'updated status');
  assert.equal(state.getProjectStatuses().get('proj-a'), 'updated status');
});

test('snapshot returns consistent read-only view of all state', () => {
  const state = new WatchDiagnosticsState();

  state.setProjectPublication('proj-a', buildSnapshot({ issueCount: 42 }));
  state.setProjectStatus('proj-a', 'status text');
  state.setRawPendingCount(3);
  state.setErrorCount(1);
  state.applyManualCounters({
    issueCount: 42,
    publishableBeforeFilter: 40,
    publishedDiagnostics: 15,
    filteredByMode: 25,
    skippedIssues: 2,
    resolutionFailures: 3,
  });

  const snap = state.snapshot();

  assert.equal(snap.issueCount, 42);
  assert.equal(snap.publishableBeforeFilterCount, 40);
  assert.equal(snap.publishedCount, 15);
  assert.equal(snap.filteredByModeCount, 25);
  assert.equal(snap.skippedCount, 2);
  assert.equal(snap.resolutionFailureCount, 3);
  assert.equal(snap.rawPendingCount, 3);
  assert.equal(snap.errorCount, 1);
  assert.equal(snap.projectPublications.size, 1);
  assert.equal(snap.projectStatuses.get('proj-a'), 'status text');
});
