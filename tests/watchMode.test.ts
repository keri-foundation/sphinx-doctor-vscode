import assert from 'node:assert/strict';
import test from 'node:test';

let cachedWatchModeModule: typeof import('../src/watch/watchMode.js') | undefined;

async function loadWatchModeModule(): Promise<typeof import('../src/watch/watchMode.js')> {
  if (cachedWatchModeModule) {
    return cachedWatchModeModule;
  }

  const moduleLoader = require('node:module') as typeof import('node:module') & {
    _load?: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
  };
  const originalLoad = moduleLoader._load;
  assert.ok(originalLoad, 'Expected node module loader to be available for vscode stubbing.');

  moduleLoader._load = ((request: string, parent: NodeModule | undefined, isMain: boolean) => {
    if (request === 'vscode') {
      return {
        ExtensionMode: { Production: 1, Development: 2, Test: 3 },
        StatusBarAlignment: { Left: 1, Right: 2 },
        DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
        window: {
          createStatusBarItem(_alignment: unknown, _priority?: unknown) { return internalStatusBarItem; },
          showInformationMessage(_msg: string): void {},
          showWarningMessage(_msg: string): void {},
          showErrorMessage(_msg: string): void {},
        },
        workspace: {
          onDidChangeWorkspaceFolders(_fn: unknown) { return createFakeDisposable(); },
          onDidChangeConfiguration(_fn: unknown) { return createFakeDisposable(); },
          onDidSaveTextDocument(_fn: unknown) { return createFakeDisposable(); },
          workspaceFolders: undefined,
          isTrusted: true,
          fs: {
            stat: async () => { throw new Error('not implemented'); },
            readFile: async () => { throw new Error('not implemented'); },
            writeFile: async () => {},
            createDirectory: async () => {},
          },
          findFiles: async () => [],
          openTextDocument: async () => { throw new Error('not implemented'); },
        },
        Uri: {
          file(path: string) { return { fsPath: path, scheme: 'file', toString() { return path; } }; },
          parse(_value: string) { return { fsPath: '/fake', scheme: 'file', toString() { return '/fake'; } }; },
          joinPath(_base: unknown, ..._parts: string[]) { return { fsPath: '/fake/joined', scheme: 'file', toString() { return '/fake/joined'; } }; },
        },
        Range: class { constructor(_startLine: number, _startCol: number, _endLine: number, _endCol: number) {} },
        Diagnostic: class { source: string | undefined; constructor(_range: unknown, _message: string, _severity?: unknown) {} },
        EventEmitter: class {},
        Disposable: { from(..._disposables: unknown[]): FakeDisposable { return createFakeDisposable(); } },
        ProgressLocation: { Notification: 1 },
      };
    }

    return originalLoad(request, parent, isMain);
  }) as typeof originalLoad;

  try {
    const module = await import('../src/watch/watchMode.js');
    cachedWatchModeModule = module;
    return module;
  } finally {
    moduleLoader._load = originalLoad;
  }
}

interface FakeStatusBarItem {
  text: string;
  tooltip: string;
  command: string;
  show(): void;
  hide(): void;
  dispose(): void;
}

interface FakeDisposable {
  dispose(): void;
}

function createFakeStatusBarItem(): FakeStatusBarItem {
  return {
    text: '',
    tooltip: '',
    command: '',
    show() {},
    hide() {},
    dispose() {},
  };
}

function createFakeDisposable(): FakeDisposable {
  return { dispose() {} };
}

function buildFakeExtensionContext(overrides?: Partial<{
  subscriptions: unknown[];
  extensionMode: number;
  extensionPath: string;
}>): unknown {
  return {
    subscriptions: overrides?.subscriptions ?? [],
    extensionMode: overrides?.extensionMode ?? 1,
    extensionPath: overrides?.extensionPath ?? '/fake/path',
  };
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

function buildFakePublicationIndex(): unknown {
  return {
    clear(_collection?: unknown): void {},
    deleteKnownTargets(_collection: unknown): void {},
    replaceAll(_collection: unknown, _targets: unknown): void {},
    replaceProjects(_collection: unknown, _keys: unknown, _targets: unknown): void {},
  };
}

function buildFakeLogger(): { messages: string[]; shownCount: number; debug(msg: string): void; info(msg: string): void; warn(msg: string): void; error(msg: string): void; setLevel(_level: string): void; show(_preserveFocus?: boolean): void; dispose(): void } {
  const messages: string[] = [];
  return {
    messages,
    shownCount: 0,
    debug(msg: string) { messages.push(`debug:${msg}`); },
    info(msg: string) { messages.push(`info:${msg}`); },
    warn(msg: string) { messages.push(`warn:${msg}`); },
    error(msg: string) { messages.push(`error:${msg}`); },
    setLevel(_level: string): void {},
    show(_preserveFocus?: boolean): void { this.shownCount++; },
    dispose() {},
  };
}

let internalStatusBarItem: FakeStatusBarItem;

async function setupWatchMode(extensionMode = 2): Promise<{
  watchMode: InstanceType<Awaited<ReturnType<typeof loadWatchModeModule>>['SphinxDoctorWatchMode']>;
  statusBar: FakeStatusBarItem;
  logger: ReturnType<typeof buildFakeLogger>;
}> {
  internalStatusBarItem = createFakeStatusBarItem();
  cachedWatchModeModule = undefined; // force fresh vscode stub per test (statusBarItem changes)

  const module = await loadWatchModeModule();

  const context = buildFakeExtensionContext({ extensionMode }) as unknown as import('vscode').ExtensionContext;
  const collection = buildFakeDiagnosticCollection() as unknown as import('vscode').DiagnosticCollection;
  const logger = buildFakeLogger();
  const publicationIndex = buildFakePublicationIndex() as unknown as import('../src/publication/publicationIndex.js').DiagnosticsPublicationIndex<unknown>;

  const watchMode = new module.SphinxDoctorWatchMode(
    context,
    collection,
    logger as unknown as import('../src/logging/extensionLogger.js').SphinxDoctorLogger,
    publicationIndex as unknown as import('../src/publication/publicationIndex.js').DiagnosticsPublicationIndex<import('vscode').Uri>,
  );

  return { watchMode, statusBar: internalStatusBarItem, logger };
}

test('getSummary returns the initial idle summary after construction', async () => {
  const { watchMode } = await setupWatchMode();

  const summary = watchMode.getSummary();
  assert.equal(summary.state, 'idle');
  assert.equal(summary.message, 'Sphinx Doctor is idle.');
  assert.equal(summary.projectCount, 0);
  assert.equal(summary.publishedDiagnostics, 0);
});

test('initial status bar reflects idle state', async () => {
  const { statusBar } = await setupWatchMode();

  assert.ok(statusBar.text.includes('Sphinx Doctor'));
  assert.ok(statusBar.text.includes('Dev') || statusBar.text.includes('idle'));
  assert.equal(statusBar.command, 'sphinxDoctor.showStatus');
});

test('noteManualDiagnosticsPublished updates status bar text', async () => {
  const { watchMode, statusBar } = await setupWatchMode();

  watchMode.noteManualDiagnosticsPublished({
    filePath: '/test/issues.json',
    issueCount: 42,
    publishableBeforeFilter: 40,
    publishedDiagnostics: 15,
    filteredByMode: 25,
    skippedIssues: 2,
    resolutionFailures: 3,
    message: 'Sphinx Doctor loaded 42 issues',
  });

  assert.ok(statusBar.text.includes('Sphinx Doctor'));
  assert.ok(statusBar.text.includes('Dev'));
  assert.ok(!statusBar.text.includes('idle'));

  const summary = watchMode.getSummary();
  assert.equal(summary.state, 'watching');
  assert.equal(summary.issueCount, 42);
  assert.equal(summary.publishedDiagnostics, 15);
  assert.ok(summary.message.includes('loaded'));
});

test('noteManualClear restores idle-like status after published diagnostics', async () => {
  const { watchMode } = await setupWatchMode();

  watchMode.noteManualDiagnosticsPublished({
    filePath: '/test/issues.json',
    issueCount: 10,
    publishableBeforeFilter: 10,
    publishedDiagnostics: 8,
    filteredByMode: 2,
    skippedIssues: 0,
    resolutionFailures: 0,
    message: 'loaded',
  });

  const afterPublish = watchMode.getSummary();
  assert.equal(afterPublish.publishedDiagnostics, 8);

  watchMode.noteManualClear();

  const afterClear = watchMode.getSummary();
  assert.equal(afterClear.publishedDiagnostics, 0);
  assert.ok(afterClear.message.includes('cleared'));
});

test('noteSelfTestDiagnosticPublished sets self-test status bar text', async () => {
  const { watchMode, statusBar } = await setupWatchMode();

  const targetUri = { fsPath: '/fake/file.py', scheme: 'file', toString() { return 'file:///fake/file.py'; } } as unknown as import('vscode').Uri;

  watchMode.noteSelfTestDiagnosticPublished(targetUri, 1, 'self-test tooltip');

  assert.ok(statusBar.text.includes('Sphinx Doctor'));
  assert.ok(statusBar.text.includes('self-test diagnostic'));
  assert.equal(statusBar.tooltip, 'self-test tooltip');
});
