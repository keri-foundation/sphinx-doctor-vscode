import assert from 'node:assert/strict';
import { test, after } from 'node:test';

// Stub vscode
const moduleLoader = require('node:module') as typeof import('node:module') & {
  _load?: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};
const originalLoad = moduleLoader._load;
assert.ok(originalLoad);

const stubs: Record<string, unknown> = {
  vscode: {
    Uri: { file: (p: string) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }) },
    Diagnostic: class {
      range: { start: { line: number; character: number }; end: { line: number; character: number } };
      message: string; source = ''; code: string | undefined; severity: number;
      constructor(r: { start: { line: number; character: number }; end: { line: number; character: number } }, m: string, s: number) {
        this.range = r; this.message = m; this.severity = s;
      }
    },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    Range: class {
      constructor(public sl: number, public sc: number, public el: number, public ec: number) {}
      get start() { return { line: this.sl, character: this.sc }; }
      get end() { return { line: this.el, character: this.ec }; }
    },
    window: { createOutputChannel: () => ({ name: 'test', logLevel: 3, trace() {}, debug() {}, info() {}, warn() {}, error() {}, show() {}, dispose() {}, append() {}, appendLine() {}, replace() {}, clear() {}, hide() {} }) },
  },
};
moduleLoader._load = ((r: string, p: NodeModule | undefined, m: boolean) => stubs[r] ? stubs[r] : originalLoad(r, p, m)) as typeof originalLoad;
after(() => { moduleLoader._load = originalLoad; });

import { DocstringRepairTargetIndex } from '../../../src/docstrings/repair/docstringRepairTargetIndex';
import { publishDiagnostics } from '../../../src/publication/publishDiagnostics';

function fakeLogger() {
  return { trace() {}, debug() {}, info() {}, warn() {}, error() {}, show() {}, dispose() {}, withContext() { return this; } } as unknown as import('../../../src/logging/extensionLogger.js').SphinxDoctorLogger;
}
function fakeCollection() { return { set() {}, delete() {}, clear() {} } as unknown as import('vscode').DiagnosticCollection; }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('publishDiagnostics accepts repairIndex and does not crash', () => {
  const index = new DocstringRepairTargetIndex();
  assert.doesNotThrow(() => {
    publishDiagnostics(fakeCollection(), { schema: 'sphinx-diagnostics-v1', schemaVersion: 1, generatedAt: '', tool: { name: 't', version: '0' }, workspace: {}, run: { id: 'r', source: 's', inventoryFile: '', inventoryDir: '' }, summary: { total: 0, bySeverity: {}, byCategory: {}, mappedCount: 0, unmappedCount: 0, publishedDiagnostics: 0, retainedOnly: 0 }, issues: [] }, {
      workspaceFolders: undefined, diagnosticMode: 'layout', repairIndex: index, repairTargets: new Map(), logger: fakeLogger(),
    });
  });
});

test('repair index survives clear and re-registration', () => {
  const index = new DocstringRepairTargetIndex();
  const target = { language: 'python' as const, mappingConfidence: 'high' as const, anchorKind: 'docstring-line' as const, sourceSpan: { startOffset: 0, endOffset: 10 }, targetOffset: 5, fingerprint: 'abc' };
  assert.equal(index.registerTarget('id-1', target), true);
  assert.equal(index.size, 1);
  index.clear();
  assert.equal(index.size, 0);
  // After clear, re-registration works
  assert.equal(index.registerTarget('id-1', target), true);
  assert.equal(index.size, 1);
});

test('collision fails closed and index reports collision', () => {
  const index = new DocstringRepairTargetIndex();
  const t = { language: 'python' as const, mappingConfidence: 'high' as const, anchorKind: 'docstring-line' as const, sourceSpan: { startOffset: 0, endOffset: 10 }, targetOffset: 5, fingerprint: 'abc' };
  assert.equal(index.registerTarget('id-x', t), true);
  assert.equal(index.registerTarget('id-x', { ...t, fingerprint: 'def' }), false);
  assert.equal(index.size, 0);
  assert.equal(index.collisionCount, 1);
  assert.equal(index.isCollision('id-x'), true);
});
