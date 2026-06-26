import * as assert from 'node:assert';
import path from 'node:path';
import { test } from 'node:test';
import { parseSphinxWarnings } from '../src/sphinx/SphinxWarningParser';

test('parseSphinxWarnings parses standard warning with line number and category', async () => {
  const content = '/path/to/file.py:42: WARNING: Unknown target name: "foo" [ref]';
  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
    sourceWorkspaceFolder: 'test-workspace',
  });

  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.unmappedCount, 0);
  assert.strictEqual(result.unparsedCount, 0);
  assert.strictEqual(result.totalLines, 1);

  const issue = result.issues[0];
  assert.strictEqual(issue.severity, 'warning');
  assert.strictEqual(issue.category, 'ref');
  assert.strictEqual(issue.message, 'Unknown target name: "foo"');
  assert.strictEqual(issue.repoRelativePath, 'file.py');
  assert.strictEqual(issue.sourceRange?.startLine, 42);
  assert.strictEqual(issue.sourceWorkspaceFolder, 'test-workspace');
});

test('parseSphinxWarnings parses warning without category', async () => {
  const content = '/path/to/file.rst:10: WARNING: Unexpected indentation.';
  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.unparsedCount, 0);
  const issue = result.issues[0];
  assert.strictEqual(issue.severity, 'warning');
  assert.strictEqual(issue.category, 'sphinx-warning');
  assert.strictEqual(issue.message, 'Unexpected indentation.');
  assert.strictEqual(issue.sourceRange?.startLine, 10);
});

test('parseSphinxWarnings parses warning without line number', async () => {
  const content = '/path/to/file.py: WARNING: document isn\'t included in any toctree [toc]';
  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.unparsedCount, 0);
  const issue = result.issues[0];
  assert.strictEqual(issue.severity, 'warning');
  assert.strictEqual(issue.category, 'toc');
  assert.strictEqual(issue.message, 'document isn\'t included in any toctree');
  assert.strictEqual(issue.sourceRange, null);
});

test('parseSphinxWarnings parses warning without location', async () => {
  const content = 'WARNING: Some global warning [misc]';
  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 0);
  assert.strictEqual(result.unmappedCount, 1);
  assert.strictEqual(result.unparsedCount, 0);
});

test('parseSphinxWarnings handles multiple warnings', async () => {
  const content = `/path/to/file1.py:10: WARNING: First warning [ref]
/path/to/file2.py:20: WARNING: Second warning [autodoc]
/path/to/file3.py: WARNING: Third warning without line [toc]`;

  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 3);
  assert.strictEqual(result.unmappedCount, 0);
  assert.strictEqual(result.unparsedCount, 0);
  assert.strictEqual(result.totalLines, 3);

  assert.strictEqual(result.issues[0].sourceRange?.startLine, 10);
  assert.strictEqual(result.issues[1].sourceRange?.startLine, 20);
  assert.strictEqual(result.issues[2].sourceRange, null);
});

test('parseSphinxWarnings handles empty content', async () => {
  const result = await parseSphinxWarnings({
    warningFileContent: '',
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 0);
  assert.strictEqual(result.unmappedCount, 0);
  assert.strictEqual(result.unparsedCount, 1);
  assert.strictEqual(result.totalLines, 1);
  assert.strictEqual(result.blankLineCount, 1);
  assert.strictEqual(result.docstringWarningCount, 0);
  assert.strictEqual(result.standardWarningCount, 0);
  assert.strictEqual(result.globalWarningCount, 0);
});

test('parseSphinxWarnings handles content with only blank lines', async () => {
  const content = '\n\n\n';
  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 0);
  assert.strictEqual(result.unmappedCount, 0);
  assert.strictEqual(result.unparsedCount, 4);
  assert.strictEqual(result.totalLines, 4);
  assert.strictEqual(result.blankLineCount, 4);
  assert.strictEqual(result.docstringWarningCount, 0);
  assert.strictEqual(result.standardWarningCount, 0);
  assert.strictEqual(result.globalWarningCount, 0);
});

test('parseSphinxWarnings handles ERROR severity', async () => {
  const content = '/path/to/file.py:5: ERROR: Critical error [build]';
  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.unparsedCount, 0);
  assert.strictEqual(result.issues[0].severity, 'error');
  assert.strictEqual(result.issues[0].category, 'build');
});

test('parseSphinxWarnings handles INFO severity', async () => {
  const content = '/path/to/file.py:15: INFO: Informational message [info]';
  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.unparsedCount, 0);
  assert.strictEqual(result.issues[0].severity, 'info');
  assert.strictEqual(result.issues[0].category, 'info');
});

test('parseSphinxWarnings parses real keripy docstring warning', async () => {
  const content = '/workspace/project/libs/keripy/src/keri/app/habbing.py:docstring of keri.app.habbing.BaseHab.endorse:7: ERROR: Unexpected indentation. [docutils]';
  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/workspace/project/libs/keripy',
    sourceWorkspaceFolder: 'keripy',
  });

  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.unmappedCount, 0);
  assert.strictEqual(result.unparsedCount, 0);
  assert.strictEqual(result.totalLines, 1);
  assert.strictEqual(result.docstringWarningCount, 1);
  assert.strictEqual(result.standardWarningCount, 0);
  assert.strictEqual(result.globalWarningCount, 0);

  const issue = result.issues[0];
  assert.strictEqual(issue.severity, 'error');
  assert.strictEqual(issue.category, 'docutils');
  assert.strictEqual(issue.message, 'Unexpected indentation. (in keri.app.habbing.BaseHab.endorse)');
  assert.strictEqual(issue.repoRelativePath, 'src/keri/app/habbing.py');
  // AST mapping fails in test environment (source file doesn't exist on disk),
  // so sourceRange is null and publishDiagnostic is false.
  assert.strictEqual(issue.sourceRange, null);
  assert.strictEqual(issue.mapping.confidence, 'low');
  assert.strictEqual(issue.publishDiagnostic, false);
});

test('parseSphinxWarnings handles warning with colons in message', async () => {
  const content = '/path/to/file.py:100: WARNING: Field list ends without a blank line; unexpected indentation. [field]';
  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.unparsedCount, 0);
  assert.strictEqual(result.issues[0].message, 'Field list ends without a blank line; unexpected indentation.');
  assert.strictEqual(result.issues[0].category, 'field');
});

test('parseSphinxWarnings computes correct repo-relative path', async () => {
  const content = '/workspace/project/src/module/file.py:50: WARNING: Test warning [test]';
  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/workspace/project',
  });

  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.unparsedCount, 0);
  assert.strictEqual(result.issues[0].repoRelativePath, 'src/module/file.py');
});

test('parseSphinxWarnings skips warnings outside repo root', async () => {
  const content = '/other/path/file.py:10: WARNING: External warning [ext]';
  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/workspace/project',
  });

  assert.strictEqual(result.issues.length, 0);
  assert.strictEqual(result.unmappedCount, 1);
  assert.strictEqual(result.unparsedCount, 0);
});

test('parseSphinxWarnings preserves raw warning text', async () => {
  const content = '/path/to/file.py:42: WARNING: Original warning text [cat]';
  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.unparsedCount, 0);
  assert.strictEqual(result.issues[0].raw, content);
});

test('parseSphinxWarnings generates unique IDs for each issue', async () => {
  const content = `/path/to/file1.py:10: WARNING: First [ref]
/path/to/file2.py:20: WARNING: Second [ref]`;

  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 2);
  assert.strictEqual(result.unparsedCount, 0);
  assert.notStrictEqual(result.issues[0].id, result.issues[1].id);
});

test('parseSphinxWarnings suppresses non-docstring warnings from direct-run Problems', async () => {
  const content = '/path/to/file.py:10: WARNING: Test [test]';
  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.unparsedCount, 0);
  // Standard file:line warnings are retained for accounting but not published
  // in direct-run mode (only Python docstring diagnostics are published).
  assert.strictEqual(result.issues[0].publishDiagnostic, false);
});

test('parseSphinxWarnings sets mapping metadata', async () => {
  const content = '/path/to/file.py:42: WARNING: Test [test]';
  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.unparsedCount, 0);
  const mapping = result.issues[0].mapping;
  assert.strictEqual(mapping.confidence, 'high');
  assert.strictEqual(mapping.strategy, 'sphinx-warning-file');
  assert.strictEqual(mapping.objectResolved, false);
  assert.strictEqual(mapping.lineResolved, true);
});

test('parseSphinxWarnings sets lower confidence for warnings without line numbers', async () => {
  const content = '/path/to/file.py: WARNING: Test without line [test]';
  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.unparsedCount, 0);
  const mapping = result.issues[0].mapping;
  assert.strictEqual(mapping.confidence, 'medium');
  assert.strictEqual(mapping.lineResolved, false);
});

test('parseSphinxWarnings parses docstring warning with ERROR severity', async () => {
  const content = '/path/to/src/keri/app/habbing.py:docstring of keri.app.habbing.BaseHab.endorse:7: ERROR: Unexpected indentation. [docutils]';
  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.unparsedCount, 0);
  assert.strictEqual(result.unmappedCount, 0);

  const issue = result.issues[0];
  assert.strictEqual(issue.severity, 'error');
  assert.strictEqual(issue.category, 'docutils');
  assert.strictEqual(issue.message, 'Unexpected indentation. (in keri.app.habbing.BaseHab.endorse)');
  assert.strictEqual(issue.repoRelativePath, 'src/keri/app/habbing.py');
  // AST mapping fails in test environment (source file doesn't exist on disk),
  // so sourceRange is null and publishDiagnostic is false.
  assert.strictEqual(issue.sourceRange, null);
  assert.strictEqual(issue.mapping.confidence, 'low');
  assert.strictEqual(issue.mapping.strategy, 'sphinx-docstring-warning');
  assert.strictEqual(issue.mapping.objectResolved, false);
  assert.strictEqual(issue.mapping.lineResolved, false);
  assert.strictEqual(issue.publishDiagnostic, false);
});

test('parseSphinxWarnings parses docstring warning with WARNING severity', async () => {
  const content = '/path/to/src/keri/app/habbing.py:docstring of keri.app.habbing.BaseHab.endorse:10: WARNING: Block quote ends without a blank line; unexpected unindent. [docutils]';
  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.unparsedCount, 0);

  const issue = result.issues[0];
  assert.strictEqual(issue.severity, 'warning');
  assert.strictEqual(issue.category, 'docutils');
  assert.strictEqual(issue.message, 'Block quote ends without a blank line; unexpected unindent. (in keri.app.habbing.BaseHab.endorse)');
  // AST mapping fails in test environment — sourceRange is null
  assert.strictEqual(issue.sourceRange, null);
});

test('parseSphinxWarnings parses docstring warning without category', async () => {
  const content = '/path/to/file.py:docstring of module.Class.method:5: ERROR: Some error';
  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.unparsedCount, 0);

  const issue = result.issues[0];
  assert.strictEqual(issue.severity, 'error');
  assert.strictEqual(issue.category, 'docutils'); // defaults to docutils
  assert.strictEqual(issue.message, 'Some error (in module.Class.method)');
});

test('parseSphinxWarnings parses docstring warning with nested object path', async () => {
  const content = '/path/to/file.py:docstring of keri.core.coring.Matter.__init__:3: ERROR: Unexpected indentation. [docutils]';
  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.unparsedCount, 0);

  const issue = result.issues[0];
  assert.ok(issue.message.includes('keri.core.coring.Matter.__init__'));
  // AST mapping fails in test environment — sourceRange is null
  assert.strictEqual(issue.sourceRange, null);
});

test('parseSphinxWarnings handles multiple docstring warnings', async () => {
  const content = `/path/to/file.py:docstring of module.Class.method1:7: ERROR: Error 1 [docutils]
/path/to/file.py:docstring of module.Class.method2:10: WARNING: Warning 2 [docutils]
/path/to/file.py:docstring of module.Class.method3:15: ERROR: Error 3 [docutils]`;

  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 3);
  assert.strictEqual(result.unparsedCount, 0);
  assert.strictEqual(result.unmappedCount, 0);

  // AST mapping fails in test environment — sourceRanges are null
  assert.strictEqual(result.issues[0].sourceRange, null);
  assert.strictEqual(result.issues[1].sourceRange, null);
  assert.strictEqual(result.issues[2].sourceRange, null);
});

test('parseSphinxWarnings handles mixed warning types including docstring', async () => {
  const content = `/path/to/file1.py:10: WARNING: Standard warning [ref]
/path/to/file2.py:docstring of module.Class.method:5: ERROR: Docstring error [docutils]
/path/to/file3.py: WARNING: File-only warning [toc]
WARNING: Global warning [misc]`;

  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 3); // 3 mapped, 1 unmapped (global)
  assert.strictEqual(result.unmappedCount, 1);
  assert.strictEqual(result.unparsedCount, 0);

  // Check that we have different types
  const strategies = result.issues.map(i => i.mapping.strategy);
  assert.ok(strategies.includes('sphinx-warning-file'));
  assert.ok(strategies.includes('sphinx-docstring-warning'));
});

test('parseSphinxWarnings preserves raw docstring warning text', async () => {
  const content = '/path/to/file.py:docstring of module.Class.method:7: ERROR: Test error [docutils]';
  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.unparsedCount, 0);
  assert.strictEqual(result.issues[0].raw, content);
});

test('parseSphinxWarnings generates unique IDs for docstring warnings', async () => {
  const content = `/path/to/file.py:docstring of module.Class.method1:7: ERROR: Error 1 [docutils]
/path/to/file.py:docstring of module.Class.method2:7: ERROR: Error 2 [docutils]`;

  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 2);
  assert.strictEqual(result.unparsedCount, 0);
  assert.notStrictEqual(result.issues[0].id, result.issues[1].id);
});

test('parseSphinxWarnings retains but does not publish docstring warnings without safe AST mapping', async () => {
  const content = '/path/to/file.py:docstring of module.Class.method:7: ERROR: Test [docutils]';
  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.unparsedCount, 0);
  // Docstring warnings without high-confidence AST mapping are retained
  // for accounting but not published to Problems.
  assert.strictEqual(result.issues[0].publishDiagnostic, false);
});

test('parseSphinxWarnings publishes docstring warning with safe AST mapping from real fixture file', async () => {
  const fixturePath = path.resolve('tests/fixtures/sample_module.py');
  const repoRoot = path.resolve('tests/fixtures');
  // The Calculator.add docstring is at source lines 10-13, with "Add two integers."
  // at source line 11. A docstring warning at docstring line 3 maps to source line 12.
  const content = `${fixturePath}:docstring of sample_module.Calculator.add:3: WARNING: Blank line missing after summary. [docutils]`;
  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot,
  });

  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.unparsedCount, 0);
  assert.strictEqual(result.unmappedCount, 0);

  const issue = result.issues[0];
  assert.strictEqual(issue.severity, 'warning');
  assert.strictEqual(issue.category, 'docutils');
  assert.ok(issue.message.includes('sample_module.Calculator.add'));
  // When AST mapping succeeds, the anchor should be the safe docstring-line kind.
  assert.strictEqual(issue.sourceRange?.anchorKind, 'docstring-line');
  assert.strictEqual(issue.mapping.confidence, 'high');
  assert.strictEqual(issue.mapping.lineResolved, true);
  assert.strictEqual(issue.publishDiagnostic, true);
  // The mapped source line should land inside the Calculator.add docstring (lines 12-15).
  assert.ok(issue.sourceRange!.startLine >= 12, `Expected startLine >= 12, got ${issue.sourceRange?.startLine}`);
  assert.ok(issue.sourceRange!.startLine <= 15, `Expected startLine <= 15, got ${issue.sourceRange?.startLine}`);
});

test('parseSphinxWarnings handles docstring warning with colons in message', async () => {
  const content = '/path/to/file.py:docstring of module.Class.method:7: WARNING: Field list ends without a blank line; unexpected indentation. [docutils]';
  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.unparsedCount, 0);
  assert.ok(result.issues[0].message.includes('Field list ends without a blank line; unexpected indentation.'));
});

test('parseSphinxWarnings handles docstring warning outside repo root', async () => {
  const content = '/other/path/file.py:docstring of module.Class.method:7: ERROR: External error [docutils]';
  const result = await parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/workspace/project',
  });

  assert.strictEqual(result.issues.length, 0);
  assert.strictEqual(result.unmappedCount, 1);
  assert.strictEqual(result.unparsedCount, 0);
});
