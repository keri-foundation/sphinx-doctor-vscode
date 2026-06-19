import assert from 'node:assert/strict';
import test from 'node:test';

// ── Module._load patch for vscode stub ──────────────────────────────────
const moduleLoader = require('node:module') as typeof import('node:module') & {
  _load?: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};
const originalLoad = moduleLoader._load;
assert.ok(originalLoad, 'Expected node module loader to be available.');

const saveListeners: Array<(doc: unknown) => void> = [];

const vscodeStub: Record<string, unknown> = {
  window: { showInformationMessage: () => {}, showWarningMessage: () => {}, showErrorMessage: () => {} },
  workspace: {
    onDidSaveTextDocument: (cb: (doc: unknown) => void) => {
      saveListeners.push(cb);
      return { dispose() {} };
    },
    workspaceFolders: [{ name: 'test', uri: { fsPath: '/fake/repo' } }],
    isTrusted: true,
    fs: {
      stat: async () => { throw new Error('not implemented'); },
      readFile: async () => { throw new Error('not implemented'); },
    },
  },
  Uri: {
    file(p: string) { return { fsPath: p, scheme: 'file' }; },
    parse(s: string) { return { fsPath: s, scheme: 'file' }; },
    joinPath() { return { fsPath: '/fake', scheme: 'file' }; },
  },
  Disposable: { from() { return { dispose() {} }; } },
  EventEmitter: class {},
};

moduleLoader._load = ((request: string, parent: NodeModule | undefined, isMain: boolean) => {
  if (request === 'vscode') return vscodeStub;
  return originalLoad!(request, parent, isMain);
});

// ── now safe to import the module under test ───────────────────────────
import { DirectRunSaveRepublisher, createDefaultRepublisherScheduler } from '../src/commands/directRunSaveRepublisher';

interface FakeDoc {
  uri: { scheme: string; fsPath: string };
}

function makeDoc(scheme: string, fsPath: string): FakeDoc {
  return { uri: { scheme, fsPath } };
}

function createRepublisher() {
  return new DirectRunSaveRepublisher(
    async () => 'completed',
    { collection: {} as any, logger: { info: () => {} } as any, publicationIndex: { clear() {} } },
    createDefaultRepublisherScheduler(),
    () => 1500,
  );
}

function fakeContext(): any {
  return { subscriptions: [] };
}

test('isEligibleSave returns false before session is armed', () => {
  const r = createRepublisher();
  const doc = makeDoc('file', '/workspace/src/module.py');
  assert.equal(r.isEligibleSave(doc as any), false);
});

test('isEligibleSave returns true for .py file inside workspace root after arming', () => {
  const r = createRepublisher();
  r.armSession('/workspace', '.tmp/output', fakeContext());
  const doc = makeDoc('file', '/workspace/src/module.py');
  assert.equal(r.isEligibleSave(doc as any), true);
});

test('isEligibleSave returns true for .PY (case-insensitive)', () => {
  const r = createRepublisher();
  r.armSession('/workspace', '.tmp/output', fakeContext());
  const doc = makeDoc('file', '/workspace/src/module.PY');
  assert.equal(r.isEligibleSave(doc as any), true);
});

test('isEligibleSave returns false for .py outside workspace root', () => {
  const r = createRepublisher();
  r.armSession('/workspace', '.tmp/output', fakeContext());
  const doc = makeDoc('file', '/other-project/module.py');
  assert.equal(r.isEligibleSave(doc as any), false);
});

test('isEligibleSave returns false for sibling-prefix escape path', () => {
  const r = createRepublisher();
  r.armSession('/workspace', '.tmp/output', fakeContext());
  const doc = makeDoc('file', '/workspace-other/module.py');
  assert.equal(r.isEligibleSave(doc as any), false);
});

test('isEligibleSave returns false for .rst file', () => {
  const r = createRepublisher();
  r.armSession('/workspace', '.tmp/output', fakeContext());
  const doc = makeDoc('file', '/workspace/docs/index.rst');
  assert.equal(r.isEligibleSave(doc as any), false);
});

test('isEligibleSave returns false for .md file', () => {
  const r = createRepublisher();
  r.armSession('/workspace', '.tmp/output', fakeContext());
  const doc = makeDoc('file', '/workspace/README.md');
  assert.equal(r.isEligibleSave(doc as any), false);
});

test('isEligibleSave returns false for JSON file', () => {
  const r = createRepublisher();
  r.armSession('/workspace', '.tmp/output', fakeContext());
  const doc = makeDoc('file', '/workspace/data.json');
  assert.equal(r.isEligibleSave(doc as any), false);
});

test('isEligibleSave returns false for untitled: scheme', () => {
  const r = createRepublisher();
  r.armSession('/workspace', '.tmp/output', fakeContext());
  const doc = makeDoc('untitled', '/workspace/src/module.py');
  assert.equal(r.isEligibleSave(doc as any), false);
});

test('isEligibleSave returns false for git: scheme', () => {
  const r = createRepublisher();
  r.armSession('/workspace', '.tmp/output', fakeContext());
  const doc = makeDoc('git', '/workspace/src/module.py');
  assert.equal(r.isEligibleSave(doc as any), false);
});

test('isEligibleSave returns false for file inside output directory', () => {
  const r = createRepublisher();
  r.armSession('/workspace', '.tmp/output', fakeContext());
  const doc = makeDoc('file', '/workspace/.tmp/output/generated.py');
  assert.equal(r.isEligibleSave(doc as any), false);
});

test('isEligibleSave returns false after dispose', () => {
  const r = createRepublisher();
  r.armSession('/workspace', '.tmp/output', fakeContext());
  r.dispose();
  const doc = makeDoc('file', '/workspace/src/module.py');
  assert.equal(r.isEligibleSave(doc as any), false);
});

test('isEligibleSave returns false when state is inactive', () => {
  const r = createRepublisher();
  const doc = makeDoc('file', '/workspace/src/module.py');
  assert.equal(r.isEligibleSave(doc as any), false);
  assert.equal(r.state, 'inactive');
});

test('armSession sets state to armed and stores workspace root', () => {
  const r = createRepublisher();
  r.armSession('/my/repo', '.tmp/out', fakeContext());
  assert.equal(r.state, 'armed');
  assert.ok(r.workspaceRoot !== null);
});
