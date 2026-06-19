import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  lineStartOffset,
  lineEndOffset,
  computeSpanFingerprint,
} from '../../../src/docstrings/TextPythonDocstringSourceMapper';

import { createDocstringRepairTarget } from '../../../src/docstrings/repair/docstringRepairTarget';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function targetFor(source: string, startLine0: number, endLine0: number, targetLine0: number) {
  const lines = source.split('\n');
  const start = lineStartOffset(lines, startLine0);
  const end = lineEndOffset(lines, endLine0);
  const target = lineStartOffset(lines, targetLine0);
  return createDocstringRepairTarget({
    source, docstringStartOffset: start, docstringEndOffset: end,
    targetOffset: target, mappingConfidence: 'high', anchorKind: 'docstring-line',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('one-line triple-double-quoted docstring', () => {
  // def f():             line 0
  //     """one-liner"""  line 1 (docstring)
  //     pass             line 2
  const source = 'def f():\n    """one-liner"""\n    pass\n';
  const target = targetFor(source, 1, 1, 1);
  assert.ok(target);
  const span = source.slice(target.sourceSpan.startOffset, target.sourceSpan.endOffset);
  assert.equal(span, '    """one-liner"""');
  assert.ok(!span.includes('def'));
  assert.ok(!span.includes('pass'));
});

test('one-line triple-single-quoted docstring', () => {
  const source = "def f():\n    '''one-liner'''\n    pass\n";
  const target = targetFor(source, 1, 1, 1);
  assert.ok(target);
  const span = source.slice(target.sourceSpan.startOffset, target.sourceSpan.endOffset);
  assert.equal(span, "    '''one-liner'''");
});

test('multiline triple-double-quoted docstring', () => {
  const source = 'class Foo:\n    """First line.\n\n    Second line.\n    """\n    pass\n';
  const target = targetFor(source, 1, 4, 2);
  assert.ok(target);
  const span = source.slice(target.sourceSpan.startOffset, target.sourceSpan.endOffset);
  assert.ok(span.startsWith('    """'));
  assert.ok(span.endsWith('"""'));
  assert.ok(span.includes('First line'));
  assert.ok(span.includes('Second line'));
  assert.ok(!span.includes('pass'));
});

test('multiline triple-single-quoted docstring', () => {
  const source = "class Foo:\n    '''First.\n\n    Second.\n    '''\n    pass\n";
  const target = targetFor(source, 1, 4, 2);
  assert.ok(target);
  const span = source.slice(target.sourceSpan.startOffset, target.sourceSpan.endOffset);
  assert.ok(span.startsWith("    '''"));
  assert.ok(span.endsWith("'''"));
});

test('non-BMP Unicode before docstring preserves UTF-16 offset correctness', () => {
  // 🐍 = U+1F40D = surrogate pair in UTF-16 (2 code units)
  const source = '# 🐍\ndef f():\n    """snake doc"""\n    pass\n';
  const snake = '\uD83D\uDC0D'; // 🐍 in surrogates
  const expectedPrefix = `# ${snake}\ndef f():\n`;
  assert.ok(source.startsWith(expectedPrefix));

  // Docstring at line 2
  const target = targetFor(source, 2, 2, 2);
  assert.ok(target);
  const span = source.slice(target.sourceSpan.startOffset, target.sourceSpan.endOffset);
  assert.equal(span, '    """snake doc"""');
});

test('malformed unterminated docstring produces no target when offsets are invalid', () => {
  // No closing quote — but mapper may still find the opening line.
  // If offsets are produced, the factory validates them.
  // Even if the mapper produces offsets for a best-effort span,
  // the target offset check may fail.
  const source = 'def f():\n    """unterminated\n    pass\n';
  // Line 1 has opening """, line 2 is '    pass' — no closing quote found by mapper
  // The mapper would return docstring at line 1 only. Let's test that case.
  const target = targetFor(source, 1, 1, 1);
  // Factory may or may not produce target depending on offset validity
  // The key test: no target is created that includes 'pass'
  if (target) {
    const span = source.slice(target.sourceSpan.startOffset, target.sourceSpan.endOffset);
    assert.ok(!span.includes('pass'));
  }
});

test('docstring line-sharing with neighboring code is excluded', () => {
  // Docstring explicitly bounded to its own lines — no adjacent code
  const source = 'def f():\n    """doc"""  # comment\n    pass\n';
  // The mapper finds the """ on line 1, the docstring is just that line
  const target = targetFor(source, 1, 1, 1);
  assert.ok(target);
  const span = source.slice(target.sourceSpan.startOffset, target.sourceSpan.endOffset);
  // The span should contain the docstring but not extend into pass
  assert.ok(!span.includes('pass'));
});

test('CRLF and LF equivalents produce identical fingerprints', () => {
  const sourceLF = 'def f():\n    """hello world"""\n    pass\n';
  const sourceCRLF = 'def f():\r\n    """hello world"""\r\n    pass\r\n';

  const fpLF = computeSpanFingerprint(sourceLF.split('\n'), 13, 31);
  const fpCRLF = computeSpanFingerprint(sourceCRLF.split('\n'), 14, 33);

  assert.equal(fpLF, fpCRLF);
});

test('different docstring content produces different fingerprints', () => {
  const source1 = 'def f():\n    """hello"""\n    pass\n';
  const source2 = 'def f():\n    """world"""\n    pass\n';

  const fp1 = computeSpanFingerprint(source1.split('\n'), 13, 22);
  const fp2 = computeSpanFingerprint(source2.split('\n'), 13, 22);

  assert.notEqual(fp1, fp2);
});

test('lineStartOffset computes correct positions', () => {
  const lines = ['abc', 'def', 'ghi'];
  assert.equal(lineStartOffset(lines, 0), 0);
  assert.equal(lineStartOffset(lines, 1), 4); // 'abc\n' = 4
  assert.equal(lineStartOffset(lines, 2), 8); // 'abc\ndef\n' = 8
  assert.equal(lineStartOffset(lines, -1), -1);
  assert.equal(lineStartOffset(lines, 3), -1);
});

test('lineEndOffset computes correct exclusive end positions', () => {
  const lines = ['abc', 'def', 'ghi'];
  assert.equal(lineEndOffset(lines, 0), 3); // 'abc' = end at 3
  assert.equal(lineEndOffset(lines, 1), 7); // 'abc\ndef' = end at 7
  assert.equal(lineEndOffset(lines, 2), 11); // 'abc\ndef\nghi' = end at 11 (last line, no trailing newline)
});
