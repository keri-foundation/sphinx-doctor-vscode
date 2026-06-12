import * as assert from 'node:assert';
import { test } from 'node:test';
import { parseSphinxWarnings } from '../src/parser/SphinxWarningParser';

test('parseSphinxWarnings parses standard warning with line number and category', () => {
  const content = '/path/to/file.py:42: WARNING: Unknown target name: "foo" [ref]';
  const result = parseSphinxWarnings({
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

test('parseSphinxWarnings parses warning without category', () => {
  const content = '/path/to/file.rst:10: WARNING: Unexpected indentation.';
  const result = parseSphinxWarnings({
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

test('parseSphinxWarnings parses warning without line number', () => {
  const content = '/path/to/file.py: WARNING: document isn\'t included in any toctree [toc]';
  const result = parseSphinxWarnings({
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

test('parseSphinxWarnings parses warning without location', () => {
  const content = 'WARNING: Some global warning [misc]';
  const result = parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 0);
  assert.strictEqual(result.unmappedCount, 1);
  assert.strictEqual(result.unparsedCount, 0);
});

test('parseSphinxWarnings handles multiple warnings', () => {
  const content = `/path/to/file1.py:10: WARNING: First warning [ref]
/path/to/file2.py:20: WARNING: Second warning [autodoc]
/path/to/file3.py: WARNING: Third warning without line [toc]`;

  const result = parseSphinxWarnings({
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

test('parseSphinxWarnings handles empty content', () => {
  const result = parseSphinxWarnings({
    warningFileContent: '',
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 0);
  assert.strictEqual(result.unmappedCount, 0);
  assert.strictEqual(result.unparsedCount, 1);
  assert.strictEqual(result.totalLines, 1);
});

test('parseSphinxWarnings handles content with only blank lines', () => {
  const content = '\n\n\n';
  const result = parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 0);
  assert.strictEqual(result.unmappedCount, 0);
  assert.strictEqual(result.unparsedCount, 4);
  assert.strictEqual(result.totalLines, 4);
});

test('parseSphinxWarnings handles ERROR severity', () => {
  const content = '/path/to/file.py:5: ERROR: Critical error [build]';
  const result = parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.unparsedCount, 0);
  assert.strictEqual(result.issues[0].severity, 'error');
  assert.strictEqual(result.issues[0].category, 'build');
});

test('parseSphinxWarnings handles INFO severity', () => {
  const content = '/path/to/file.py:15: INFO: Informational message [info]';
  const result = parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.unparsedCount, 0);
  assert.strictEqual(result.issues[0].severity, 'info');
  assert.strictEqual(result.issues[0].category, 'info');
});

test('parseSphinxWarnings handles warning with colons in message', () => {
  const content = '/path/to/file.py:100: WARNING: Field list ends without a blank line; unexpected indentation. [field]';
  const result = parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.unparsedCount, 0);
  assert.strictEqual(result.issues[0].message, 'Field list ends without a blank line; unexpected indentation.');
  assert.strictEqual(result.issues[0].category, 'field');
});

test('parseSphinxWarnings computes correct repo-relative path', () => {
  const content = '/workspace/project/src/module/file.py:50: WARNING: Test warning [test]';
  const result = parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/workspace/project',
  });

  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.unparsedCount, 0);
  assert.strictEqual(result.issues[0].repoRelativePath, 'src/module/file.py');
});

test('parseSphinxWarnings skips warnings outside repo root', () => {
  const content = '/other/path/file.py:10: WARNING: External warning [ext]';
  const result = parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/workspace/project',
  });

  assert.strictEqual(result.issues.length, 0);
  assert.strictEqual(result.unmappedCount, 1);
  assert.strictEqual(result.unparsedCount, 0);
});

test('parseSphinxWarnings preserves raw warning text', () => {
  const content = '/path/to/file.py:42: WARNING: Original warning text [cat]';
  const result = parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.unparsedCount, 0);
  assert.strictEqual(result.issues[0].raw, content);
});

test('parseSphinxWarnings generates unique IDs for each issue', () => {
  const content = `/path/to/file1.py:10: WARNING: First [ref]
/path/to/file2.py:20: WARNING: Second [ref]`;

  const result = parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 2);
  assert.strictEqual(result.unparsedCount, 0);
  assert.notStrictEqual(result.issues[0].id, result.issues[1].id);
});

test('parseSphinxWarnings sets publishDiagnostic to true', () => {
  const content = '/path/to/file.py:10: WARNING: Test [test]';
  const result = parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.unparsedCount, 0);
  assert.strictEqual(result.issues[0].publishDiagnostic, true);
});

test('parseSphinxWarnings sets mapping metadata', () => {
  const content = '/path/to/file.py:42: WARNING: Test [test]';
  const result = parseSphinxWarnings({
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

test('parseSphinxWarnings sets lower confidence for warnings without line numbers', () => {
  const content = '/path/to/file.py: WARNING: Test without line [test]';
  const result = parseSphinxWarnings({
    warningFileContent: content,
    repoRoot: '/path/to',
  });

  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.unparsedCount, 0);
  const mapping = result.issues[0].mapping;
  assert.strictEqual(mapping.confidence, 'medium');
  assert.strictEqual(mapping.lineResolved, false);
});
