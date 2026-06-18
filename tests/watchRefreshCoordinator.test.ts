import assert from 'node:assert/strict';
import test from 'node:test';

interface FakeDisposable { disposed: boolean; dispose(): void; }
function createFakeDisposable(): FakeDisposable {
  return { disposed: false, dispose() { this.disposed = true; } };
}

// Shared Module._load patch — installed once to avoid test-isolation issues.
const moduleLoader = require('node:module') as typeof import('node:module') & {
  _load?: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};
const originalLoad = moduleLoader._load;
assert.ok(originalLoad, 'Expected node module loader to be available.');

const sharedVscodeStub: Record<string, unknown> = {
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  window: {
    showInformationMessage(_msg: string): void {},
    showWarningMessage(_msg: string): void {},
    showErrorMessage(_msg: string): void {},
  },
  workspace: {
    workspaceFolders: [{ name: 'test-folder', uri: { fsPath: '/fake/test-folder' } }],
    isTrusted: true,
    fs: { stat: async () => { throw new Error('not implemented'); }, readFile: async () => { throw new Error('not implemented'); }, writeFile: async () => {}, createDirectory: async () => {} },
    findFiles: async () => [],
  },
  Uri: {
    file(path: string) { return { fsPath: path, scheme: 'file', toString() { return path; } }; },
    parse(_value: string) { return { fsPath: '/fake', scheme: 'file', toString() { return '/fake'; } }; },
    joinPath(_base: unknown, ..._parts: string[]) { return { fsPath: '/fake/joined', scheme: 'file' }; },
  },
  EventEmitter: class {},
  Disposable: { from(..._disposables: unknown[]) { return createFakeDisposable(); } },
};

function stubConfig() {
  return {
    projects: [] as unknown[], diagnosticsMode: 'layout' as const,
    watchEnabled: true, watchAutoLoadOnStartup: true,
    refreshAutoRunOnStartup: false, refreshAutoRunOnSave: false,
    discoveryEnabled: false, discoveryIncludeLowConfidence: false,
    discoveryInventoryWorkspaceFolderNames: [] as string[], discoveryExcludeWorkspaceFolders: [] as string[],
    enrichmentEnabled: true, enrichmentAutoRun: false,
    logLevel: 'info', watchDebounceMs: 1500, refreshDebounceMs: 1500,
    directRunEnabled: false,
    sphinxCommand: 'sphinx-build', sphinxBuilder: 'html',
    sphinxSourceDir: '.', sphinxOutputDir: '_build',
    sphinxWarningFile: '_build/warnings.txt', sphinxExtraArgs: [] as string[],
    defaultSourceWorkspaceFolder: '',
  };
}

moduleLoader._load = ((request: string, parent: NodeModule | undefined, isMain: boolean) => {
  if (request === 'vscode') return sharedVscodeStub;
  if (request === '../config/extensionConfig') return { getExtensionConfig: () => stubConfig() };
  if (request === '../workspace/projectDiscovery') return {
    discoverWorkspaceProjectDecisions: async () => [],
    listGitWorktreesPorcelain: undefined,
    mergeProjects: (configured: unknown[], discovered: unknown[]) => [...configured, ...discovered],
  };
  if (request === '../publication/publishDiagnostics') return {
    publishDiagnosticsBatch: (_c: unknown, _e: unknown[], _o: unknown) => ({
      issueCount: 0, publishableBeforeFilter: 0, publishedDiagnostics: 0,
      targetUriCount: 0, filteredByMode: 0, skippedIssues: 0, resolutionFailures: 0,
    }),
    computeDiagnosticsAccounting: (_c: unknown, _o: unknown) => ({
      issueCount: 0, publishableBeforeFilter: 0, publishedDiagnostics: 0,
      filteredByMode: 0, skippedIssues: 0, resolutionFailures: 0,
    }),
  };
  return originalLoad(request, parent, isMain);
}) as typeof originalLoad;

async function loadCoordinatorModule(): Promise<typeof import('../src/watch/watchRefreshCoordinator.js')> {
  const cacheKey = require.resolve('../src/watch/watchRefreshCoordinator.js');
  delete require.cache[cacheKey];
  return await import('../src/watch/watchRefreshCoordinator.js');
}

function buildFakeDiagnosticCollection(): unknown {
  return {
    name: 'sphinx-doctor',
    set(_uris: unknown): void {},
    delete(_uri: unknown): void {},
    clear(): void {},
    forEach(..._args: unknown[]): void {},
    get(_uri: unknown): unknown[] { return []; },
    has(_uri: unknown): boolean { return false; },
    dispose(): void {},
  };
}

function buildFakePublicationIndex() {
  return {
    cleared: false,
    knownTargetsDeleted: false,
    clear(collection?: { clear(): void }) {
      this.cleared = true;
      collection?.clear();
    },
    deleteKnownTargets(_collection: { delete(_target: unknown): void }) {
      this.knownTargetsDeleted = true;
    },
    replaceAll(_collection: unknown, _targets: unknown): void {},
    replaceProjects(_collection: unknown, _keys: unknown, _targets: unknown): void {},
    getPublishedTargetKeys(_projectKey: string): string[] { return []; },
  };
}

function buildFakeLogger() {
  const m: string[] = [];
  return { m, debug(msg: string) { m.push(`debug:${msg}`); }, info(msg: string) { m.push(`info:${msg}`); }, warn(msg: string) { m.push(`warn:${msg}`); }, error(msg: string) { m.push(`error:${msg}`); }, setLevel(_l: string): void {}, show(_p?: boolean): void {} };
}

function buildFakeDiagnosticsState() {
  return {
    cleared: false,
    projectPublicationsCleared: false,
    statuses: new Map(),
    publications: new Map(),
    rawPending: 0,
    errors: 0,
    clear() { this.cleared = true; },
    clearProjectPublications() { this.projectPublicationsCleared = true; },
    setProjectPublication(_id: string, _snapshot: unknown): void {},
    getProjectPublications() { return this.publications as ReadonlyMap<string, unknown>; },
    setProjectStatus(_id: string, _status: string): void {},
    getProjectStatuses() { return this.statuses as ReadonlyMap<string, string>; },
    deriveAggregateFromSnapshots() { return { loadedDiagnosticsFiles: [] }; },
    applyManualCounters(_opts: unknown): void {},
    setRawPendingCount(_count: number): void {},
    getRawPendingCount() { return this.rawPending; },
    setErrorCount(_count: number): void {},
    getErrorCount() { return this.errors; },
    getIssueCount() { return 0; },
    getPublishedCount() { return 0; },
    getPublishableBeforeFilterCount() { return 0; },
    getFilteredByModeCount() { return 0; },
    getSkippedCount() { return 0; },
    getResolutionFailureCount() { return 0; },
    snapshot() { return {} as unknown; },
  };
}

function buildFakeProjectRunner() {
  return {
    prepareCallCount: 0,
    selectCallCount: 0,
    refreshCallCount: 0,
    refreshInProgress: false,
    refreshCompleter: null as (() => void) | null,
    lastRefreshProjectId: '',
    lastRefreshReason: '',
    prepareEntryResult: undefined,
    async prepareProjectEntry(_p: unknown, _c: unknown, _w: unknown) { this.prepareCallCount++; return this.prepareEntryResult; },
    async selectCandidate(_p: unknown, _w: unknown) { this.selectCallCount++; return undefined; },
    setProjectStatus(_id: string, _s: string): void {},
    async runProjectRefreshLifecycle(project: { id: string }, _w: unknown, reason: string, _kc: number, _sc: number) {
      this.lastRefreshProjectId = project.id; this.lastRefreshReason = reason; this.refreshCallCount++;
      this.refreshInProgress = true;
      await new Promise<void>((resolve) => { this.refreshCompleter = resolve as () => void; });
      this.refreshInProgress = false;
    },
  };
}

const SAMPLE_PROJECT_A = { id: 'project-a', sourceWorkspaceFolder: 'test-folder', inventoryWorkspaceFolder: 'test-folder', repoRoot: '.', mirrorRoot: '.sphinx-diagnostics', inventorySearchGlobs: ['**/*.json'] };

function defaultConfig(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    projects: [],
    diagnosticsMode: 'layout',
    watchEnabled: true, watchAutoLoadOnStartup: true,
    refreshAutoRunOnStartup: false, refreshAutoRunOnSave: false,
    discoveryEnabled: false, discoveryIncludeLowConfidence: false,
    discoveryInventoryWorkspaceFolderNames: [], discoveryExcludeWorkspaceFolders: [],
    enrichmentEnabled: true, enrichmentAutoRun: false,
    logLevel: 'info', watchDebounceMs: 1500, refreshDebounceMs: 1500,
    directRunEnabled: false,
    sphinxCommand: 'sphinx-build', sphinxBuilder: 'html',
    sphinxSourceDir: '.', sphinxOutputDir: '_build',
    sphinxWarningFile: '_build/warnings.txt', sphinxExtraArgs: [],
    defaultSourceWorkspaceFolder: '',
    ...overrides,
  } as unknown as import('../src/types.js').ExtensionConfig;
}

interface CoordinatorDepsTracking {
  aggregateCalls: Array<Record<string, unknown>>;
  syncCalls: Array<{ projects: unknown[]; folders: unknown[] }>;
  bookkeepingCalls: Array<{ discovered: string[]; known: string[] }>;
  errorMessages: string[];
}

function buildCoordinatorDeps(opts: {
  tracking: CoordinatorDepsTracking;
  watcherCount?: number;
  knownIds?: string[];
  summaryProjectCount?: number;
  projectRunner?: ReturnType<typeof buildFakeProjectRunner>;
  diagnosticsState?: ReturnType<typeof buildFakeDiagnosticsState>;
}) {
  const { tracking } = opts;

  return {
    collection: buildFakeDiagnosticCollection() as unknown as import('vscode').DiagnosticCollection,
    publicationIndex: buildFakePublicationIndex() as unknown as import('../src/publication/publicationIndex.js').DiagnosticsPublicationIndex<import('vscode').Uri>,
    logger: buildFakeLogger() as unknown as import('../src/logging/extensionLogger.js').SphinxDoctorLogger,
    diagnosticsState: (opts.diagnosticsState ?? buildFakeDiagnosticsState()) as unknown as import('../src/watch/watchDiagnosticsState.js').WatchDiagnosticsState,
    projectRunner: (opts.projectRunner ?? buildFakeProjectRunner()) as unknown as import('../src/watch/watchProjectRefresh.js').WatchProjectRefreshRunner,
    onAggregateChanged(result: Record<string, unknown>): void {
      tracking.aggregateCalls.push(result);
    },
    getWatcherCount(): number {
      return opts.watcherCount ?? 0;
    },
    getKnownProjectIds(): string[] {
      return opts.knownIds ?? [];
    },
    getStatusSummaryProjectCount(): number {
      return opts.summaryProjectCount ?? 0;
    },
    async syncWatchers(projects: unknown[], folders: unknown[]): Promise<void> {
      tracking.syncCalls.push({ projects, folders });
    },
    onRefreshBookkeeping(info: { discoveredProjectIds: string[]; knownProjectIds: string[] }): void {
      tracking.bookkeepingCalls.push({ discovered: info.discoveredProjectIds, known: info.knownProjectIds });
    },
    onProjectError(message: string): void {
      tracking.errorMessages.push(message);
    },
  };
}

test('refreshAll with no workspace folders clears state and reports empty aggregate', async () => {
  // Mutate the shared stub so workspaceFolders is empty for this test.
  const saved = (sharedVscodeStub as Record<string, unknown>).workspace;
  (sharedVscodeStub as Record<string, unknown>).workspace = {
    ...(saved as Record<string, unknown>),
    workspaceFolders: [],
  };

  const module = await loadCoordinatorModule();

  const tracking: CoordinatorDepsTracking = { aggregateCalls: [], syncCalls: [], bookkeepingCalls: [], errorMessages: [] };
  const deps = buildCoordinatorDeps({ tracking });
  const coordinator = new module.WatchRefreshCoordinator(
    deps as unknown as import('../src/watch/watchRefreshCoordinator.js').WatchRefreshCoordinatorDeps,
  );

  await coordinator.refreshAll('test: no folders', true);

  // Restore workspace stub.
  (sharedVscodeStub as Record<string, unknown>).workspace = saved;

  // Publication index and diagnostics state cleared.
  const pubIdx = deps.publicationIndex as unknown as ReturnType<typeof buildFakePublicationIndex>;
  assert.ok(pubIdx.cleared, 'expected publication index to be cleared');
  const diagState = deps.diagnosticsState as unknown as ReturnType<typeof buildFakeDiagnosticsState>;
  assert.ok(diagState.cleared, 'expected diagnostics state to be cleared');

  // Aggregate called with projectCount=0.
  assert.ok(tracking.aggregateCalls.length > 0, 'expected at least one aggregate call');
  const lastAggregate = tracking.aggregateCalls[tracking.aggregateCalls.length - 1];
  assert.equal(lastAggregate.projectCount, 0, 'expected projectCount 0 when no folders are open');

  coordinator.dispose();
});

test('refreshAll with loadDiagnostics=false clears project state and reports aggregate', async () => {
  const module = await loadCoordinatorModule();

  const runner = buildFakeProjectRunner();
  const diagState = buildFakeDiagnosticsState();
  const tracking: CoordinatorDepsTracking = { aggregateCalls: [], syncCalls: [], bookkeepingCalls: [], errorMessages: [] };
  const deps = buildCoordinatorDeps({ tracking, projectRunner: runner, diagnosticsState: diagState });
  const coordinator = new module.WatchRefreshCoordinator(
    deps as unknown as import('../src/watch/watchRefreshCoordinator.js').WatchRefreshCoordinatorDeps,
  );

  await coordinator.refreshAll('test: watcher-only', false);

  // When loadDiagnostics=false, project publications and state are cleared.
  assert.ok(diagState.projectPublicationsCleared, 'expected project publications to be cleared');
  assert.ok(diagState.cleared, 'expected diagnostics state to be cleared');
  // Aggregate callback was invoked.
  assert.ok(tracking.aggregateCalls.length > 0, 'expected aggregate callback to be called');
  // Project runner was never called.
  assert.equal(runner.prepareCallCount, 0, 'expected no prepareEntry calls');
  assert.equal(runner.refreshCallCount, 0, 'expected no refresh calls');
});

test('getProjectRefreshTrigger returns the same trigger for the same project', async () => {
  const module = await loadCoordinatorModule();

  const tracking: CoordinatorDepsTracking = { aggregateCalls: [], syncCalls: [], bookkeepingCalls: [], errorMessages: [] };
  const deps = buildCoordinatorDeps({ tracking });
  const coordinator = new module.WatchRefreshCoordinator(
    deps as unknown as import('../src/watch/watchRefreshCoordinator.js').WatchRefreshCoordinatorDeps,
  );

  coordinator.resetRefreshTrigger(500);

  const trigger1 = coordinator.getProjectRefreshTrigger('proj-a', 300);
  const trigger2 = coordinator.getProjectRefreshTrigger('proj-a', 300);
  const trigger3 = coordinator.getProjectRefreshTrigger('proj-b', 300);

  // Same projectId returns the same trigger object.
  assert.strictEqual(trigger1, trigger2, 'expected same trigger reference for same projectId');
  // Different projectId returns a different trigger.
  assert.notStrictEqual(trigger1, trigger3, 'expected different trigger for different projectId');

  coordinator.dispose();
});

test('dispose clears auto-refresh triggers so a new call creates a fresh trigger', async () => {
  const module = await loadCoordinatorModule();

  const tracking: CoordinatorDepsTracking = { aggregateCalls: [], syncCalls: [], bookkeepingCalls: [], errorMessages: [] };
  const deps = buildCoordinatorDeps({ tracking });
  const coordinator = new module.WatchRefreshCoordinator(
    deps as unknown as import('../src/watch/watchRefreshCoordinator.js').WatchRefreshCoordinatorDeps,
  );

  coordinator.resetRefreshTrigger(500);

  const triggerA = coordinator.getProjectRefreshTrigger('proj-x', 300);
  coordinator.dispose();

  // After disposal, a new call creates a fresh trigger (not the same reference).
  const triggerB = coordinator.getProjectRefreshTrigger('proj-x', 300);
  assert.notStrictEqual(triggerA, triggerB, 'expected fresh trigger after dispose');

  coordinator.dispose();
});

test('runProjectRefreshLifecycle blocks concurrent execution for the same project', async () => {
  const module = await loadCoordinatorModule();

  const runner = buildFakeProjectRunner();
  const tracking: CoordinatorDepsTracking = { aggregateCalls: [], syncCalls: [], bookkeepingCalls: [], errorMessages: [] };
  const deps = buildCoordinatorDeps({ tracking, projectRunner: runner });
  const coordinator = new module.WatchRefreshCoordinator(
    deps as unknown as import('../src/watch/watchRefreshCoordinator.js').WatchRefreshCoordinatorDeps,
  );

  // Start first refresh — it will pause on the fake promise.
  const firstPromise = coordinator.runProjectRefreshLifecycle(
    SAMPLE_PROJECT_A as unknown as import('../src/types.js').ConfiguredProject,
    [{ name: 'test-folder', fsPath: '/fake/test-folder' }],
    'test: single-flight-1',
  );

  // Let the first call reach the runner and set refreshInProgress.
  await new Promise<void>((resolve) => {
    const check = () => {
      if (runner.refreshInProgress) {
        resolve();
      } else {
        setImmediate(check);
      }
    };
    check();
  });

  // Second call should be blocked by single-flight.
  const secondPromise = coordinator.runProjectRefreshLifecycle(
    SAMPLE_PROJECT_A as unknown as import('../src/types.js').ConfiguredProject,
    [{ name: 'test-folder', fsPath: '/fake/test-folder' }],
    'test: single-flight-2',
  );

  // Complete the first refresh.
  runner.refreshCompleter?.();
  await firstPromise;
  await secondPromise;

  // Runner should have been called exactly once.
  assert.equal(runner.refreshCallCount, 1, 'expected runner to be called exactly once under single-flight');
  assert.equal(runner.lastRefreshProjectId, 'project-a');

  coordinator.dispose();
});

test('resolveKnownProjects returns configured projects when discovery is disabled', async () => {
  const tracking: CoordinatorDepsTracking = { aggregateCalls: [], syncCalls: [], bookkeepingCalls: [], errorMessages: [] };

  const module = await loadCoordinatorModule();

  const deps = buildCoordinatorDeps({ tracking });
  const coordinator = new module.WatchRefreshCoordinator(
    deps as unknown as import('../src/watch/watchRefreshCoordinator.js').WatchRefreshCoordinatorDeps,
  );

  const config = defaultConfig({ projects: [SAMPLE_PROJECT_A] });

  const workspaceFolders = [{ name: 'test-folder', fsPath: '/fake/test-folder' }];

  const result = await coordinator.resolveKnownProjects(config, workspaceFolders);

  assert.equal(result.length, 1, 'expected 1 configured project when discovery is disabled');
  assert.equal(result[0].id, 'project-a');

  coordinator.dispose();
});
