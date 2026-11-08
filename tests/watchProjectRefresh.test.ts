import assert from 'node:assert/strict';
import test, { after } from 'node:test';

const moduleLoader = require('node:module') as typeof import('node:module') & {
  _load?: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};
const originalLoad = moduleLoader._load;
assert.ok(originalLoad, 'Expected node module loader to be available.');

const sharedVscodeStub: Record<string, unknown> = {
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  window: {
    showInformationMessage(_m: string): void {},
    showWarningMessage(_m: string): void {},
    showErrorMessage(_m: string): void {},
  },
  workspace: {
    workspaceFolders: [{ name: 'test-folder', uri: { fsPath: '/fake/test-folder' } }],
    isTrusted: true,
    fs: {
      stat: async () => { throw new Error('not implemented'); },
      readFile: async () => { throw new Error('not implemented'); },
      writeFile: async () => {},
      createDirectory: async () => {},
    },
    findFiles: async () => [],
  },
  Uri: {
    file(path: string) { return { fsPath: path, scheme: 'file', toString() { return path; } }; },
    parse(_v: string) { return { fsPath: '/fake', scheme: 'file', toString() { return '/fake'; } }; },
    joinPath(_b: unknown, ..._p: string[]) { return { fsPath: '/fake/joined', scheme: 'file' }; },
  },
  EventEmitter: class {},
  Disposable: { from(..._d: unknown[]) { return { dispose() {} }; } },
  RelativePattern: class { constructor(_b: string, _p: string) {} },
};

moduleLoader._load = ((request: string, parent: NodeModule | undefined, isMain: boolean) => {
  if (request === 'vscode') return sharedVscodeStub;
  if (request === '../config/extensionConfig') return { getExtensionConfig: () => testConfig(), projectLabel: (p: { id: string }) => p.id };
  if (request === '../diagnostics/loadDiagnostics') return {
    loadDiagnosticsFromPath: async () => ({ schema: 'test', schemaVersion: 1, issues: [], summary: { total: 0, bySeverity: {}, byCategory: {}, mappedCount: 0, unmappedCount: 0, publishedDiagnostics: 0, retainedOnly: 0 }, tool: {}, workspace: {}, run: {} }),
    inspectDiagnosticsFile: async () => 'unknown',
    inspectDiagnosticsFileBinding: async () => ({}),
    isDiagnosticsBindingCompatible: () => ({ compatible: true }),
  };
  if (request === '../enrichment/enrichmentRunner') return {
    buildEnrichmentRunPlan: () => ({ rawIssuesPath: '/fake/raw.json', archiveOutputPath: '/fake/archive.json', latestOutputPath: '/fake/latest.json' }),
    runEnrichmentPlan: async () => ({ plan: { latestOutputPath: '/fake/latest.json', archiveOutputPath: '/fake/archive.json' } }),
    getEnrichmentPermission: () => ({ allowed: true }),
    evaluateRefreshBaselinePromotion: async () => ({ drift: { detected: false }, activeDiagnosticsPath: '/fake/latest.json' }),
    formatRefreshScopeDriftWarning: () => 'no drift',
  };
  if (request === '../refresh/refreshRunner') return {
    buildRefreshRunPlan: () => ({ command: 'make', args: ['docs'], cwd: '/fake', startedAtMs: Date.now(), expectedOutputGlobs: ['**/*.json'] }),
    runRefreshPlan: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    getRefreshPermission: () => ({ allowed: true }),
    inferProjectRefreshConfig: async () => ({ config: { command: 'make', args: ['docs'], cwd: '/fake' } }),
    inferRefreshScopeFromContract: () => undefined,
    filterRecentInventoryCandidates: (c: unknown[], _s: number) => c,
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
  if (request === '../workspace/inventoryCandidates') return {
    findWorkspaceFolderByName: () => ({ name: 'test-folder', fsPath: '/fake/test-folder' }),
    selectInventoryCandidate: () => ({ selected: undefined }),
    resolveProjectSourceRoot: () => '/fake/test-folder',
    resolveIssueFilePath: () => '/fake/test-folder/file.py',
  };
  return originalLoad(request, parent, isMain);
}) as typeof originalLoad;

function testConfig(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    projects: [], diagnosticsMode: 'layout',
    watchEnabled: true, watchAutoLoadOnStartup: true,
    refreshAutoRunOnStartup: false, refreshAutoRunOnSave: false,
    discoveryEnabled: false, discoveryIncludeLowConfidence: false,
    discoveryInventoryWorkspaceFolderNames: [], discoveryExcludeWorkspaceFolders: [],
    enrichmentEnabled: true, enrichmentAutoRun: false,
    watchDebounceMs: 1500, refreshDebounceMs: 1500,
    directRunEnabled: false,
    sphinxCommand: 'sphinx-build', sphinxBuilder: 'html',
    sphinxSourceDir: '.', sphinxOutputDir: '_build',
    sphinxWarningFile: '_build/warnings.txt', sphinxExtraArgs: [],
    defaultSourceWorkspaceFolder: '',
    pythonInterpreter: 'python3',
    ...overrides,
  };
}

const SAMPLE_PROJECT = {
  id: 'project-a', sourceWorkspaceFolder: 'test-folder',
  inventoryWorkspaceFolder: 'test-folder', repoRoot: '.',
  mirrorRoot: '.sphinx-diagnostics', inventorySearchGlobs: ['**/*.json'],
};

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeLogger() {
  const m: string[] = [];
  return { m, debug(e: unknown) { m.push(`debug:${JSON.stringify(e)}`); }, info(e: unknown) { m.push(`info:${JSON.stringify(e)}`); }, warn(e: unknown) { m.push(`warn:${JSON.stringify(e)}`); }, error(e: unknown) { m.push(`error:${JSON.stringify(e)}`); }, show(_p?: boolean): void {} };
}

function fakeDiagnosticsState() {
  const statuses = new Map<string, string>();
  return {
    statuses,
    setProjectStatus(id: string, s: string) { statuses.set(id, s); },
    getProjectStatuses() { return statuses as ReadonlyMap<string, string>; },
    setProjectPublication(_id: string, _s: unknown): void {},
    getProjectPublications() { return new Map() as ReadonlyMap<string, unknown>; },
    clear(): void {},
    clearProjectPublications(): void {},
    deriveAggregateFromSnapshots() { return { loadedDiagnosticsFiles: [] }; },
    getRawPendingCount() { return 0; }, setRawPendingCount(_n: number): void {},
    getErrorCount() { return 0; }, setErrorCount(_n: number): void {},
    getIssueCount() { return 0; }, getPublishedCount() { return 0; },
    getPublishableBeforeFilterCount() { return 0; },
  };
}

function fakeEventSuppression() {
  const recorded: string[][] = [];
  return { recorded, recordSuppressed(paths: string[]) { recorded.push([...paths]); }, isSuppressed(_p: string) { return false; } };
}

interface RunnerDeps {
  logger: ReturnType<typeof fakeLogger>;
  diagState: ReturnType<typeof fakeDiagnosticsState>;
  eventSupp: ReturnType<typeof fakeEventSuppression>;
  aggregateCalls: Array<{ projectId: string; projectCount: number; publishedDiagnostics: number }>;
  errorMessages: string[];
  statusResets: number;
}

function buildRunnerDeps(): RunnerDeps {
  return {
    logger: fakeLogger(),
    diagState: fakeDiagnosticsState(),
    eventSupp: fakeEventSuppression(),
    aggregateCalls: [],
    errorMessages: [],
    statusResets: 0,
  };
}

async function loadRunnerModule(): Promise<typeof import('../src/watch/watchProjectRefresh.js')> {
  const cacheKey = require.resolve('../src/watch/watchProjectRefresh.js');
  delete require.cache[cacheKey];
  return await import('../src/watch/watchProjectRefresh.js');
}

// Guaranteed cleanup.
after(() => { moduleLoader._load = originalLoad; });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('setProjectStatus records status in diagnostics state', async () => {
  const module = await loadRunnerModule();
  const d = buildRunnerDeps();
  const runner = new module.WatchProjectRefreshRunner({
    collection: {} as unknown as import('vscode').DiagnosticCollection,
    publicationIndex: {} as unknown as import('../src/publication/publicationIndex.js').DiagnosticsPublicationIndex<import('vscode').Uri>,
    logger: d.logger as unknown as import('../src/logging/extensionLogger.js').SphinxDoctorLogger,
    diagnosticsState: d.diagState as unknown as import('../src/watch/watchDiagnosticsState.js').WatchDiagnosticsState,
    eventSuppression: d.eventSupp as unknown as import('../src/watch/watchEventSuppression.js').WatchEventSuppression,
    extensionRoot: '/fake/root',
    onAggregateChanged(_r: unknown): void {},
    onError(_m: string): void {},
    onStatusControllerReset(): void {},
  });

  runner.setProjectStatus('proj-a', 'all good');

  assert.equal(d.diagState.statuses.get('proj-a'), 'all good');
  assert.ok(d.logger.m.some((e: string) => e.includes('project.refresh.status') && e.includes('proj-a') && e.includes('all good')));
});

test('selectCandidate returns undefined when no mirror or inventory artifacts exist', async () => {
  const module = await loadRunnerModule();
  const d = buildRunnerDeps();
  const runner = new module.WatchProjectRefreshRunner({
    collection: {} as unknown as import('vscode').DiagnosticCollection,
    publicationIndex: {} as unknown as import('../src/publication/publicationIndex.js').DiagnosticsPublicationIndex<import('vscode').Uri>,
    logger: d.logger as unknown as import('../src/logging/extensionLogger.js').SphinxDoctorLogger,
    diagnosticsState: d.diagState as unknown as import('../src/watch/watchDiagnosticsState.js').WatchDiagnosticsState,
    eventSuppression: d.eventSupp as unknown as import('../src/watch/watchEventSuppression.js').WatchEventSuppression,
    extensionRoot: '/fake/root',
    onAggregateChanged(_r: unknown): void {},
    onError(_m: string): void {},
    onStatusControllerReset(): void {},
  });

  const result = await runner.selectCandidate(
    SAMPLE_PROJECT as unknown as import('../src/types.js').ConfiguredProject,
    [{ name: 'test-folder', fsPath: '/fake/test-folder' }],
  );

  assert.equal(result, undefined);
  assert.equal(d.diagState.statuses.get('project-a'), 'no inventory artifacts found for configured search globs.');
});

test('prepareProjectEntry returns undefined when no candidate is available', async () => {
  const module = await loadRunnerModule();
  const d = buildRunnerDeps();
  const runner = new module.WatchProjectRefreshRunner({
    collection: {} as unknown as import('vscode').DiagnosticCollection,
    publicationIndex: {} as unknown as import('../src/publication/publicationIndex.js').DiagnosticsPublicationIndex<import('vscode').Uri>,
    logger: d.logger as unknown as import('../src/logging/extensionLogger.js').SphinxDoctorLogger,
    diagnosticsState: d.diagState as unknown as import('../src/watch/watchDiagnosticsState.js').WatchDiagnosticsState,
    eventSuppression: d.eventSupp as unknown as import('../src/watch/watchEventSuppression.js').WatchEventSuppression,
    extensionRoot: '/fake/root',
    onAggregateChanged(_r: unknown): void {},
    onError(_m: string): void {},
    onStatusControllerReset(): void {},
  });

  const result = await runner.prepareProjectEntry(
    SAMPLE_PROJECT as unknown as import('../src/types.js').ConfiguredProject,
    testConfig() as unknown as import('../src/types.js').ExtensionConfig,
    [{ name: 'test-folder', fsPath: '/fake/test-folder' }],
  );

  assert.equal(result, undefined);
});
