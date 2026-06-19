import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createDocstringRepairTarget,
  computeDocstringFingerprint,
  isValidSourceSpan,
  offsetIsInSpan,
} from '../../../src/docstrings/repair/docstringRepairTarget';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('a valid high-confidence exact Python docstring span produces a target', () => {
  const source = 'def greet(name):\n    """Say hello to name."""\n    return f"Hello, {name}"\n';
  // docstring starts at offset 17 ('"') and ends at offset 40 (after closing '"')
  const target = createDocstringRepairTarget({
    source,
    docstringStartOffset: 17,
    docstringEndOffset: 40,
    targetOffset: 21, // "Say" — the first content character
    mappingConfidence: 'high',
    anchorKind: 'docstring-line',
  });

  assert.ok(target, 'Expected a valid target');
  assert.equal(target.language, 'python');
  assert.equal(target.mappingConfidence, 'high');
  assert.equal(target.anchorKind, 'docstring-line');
  assert.equal(target.sourceSpan.startOffset, 17);
  assert.equal(target.sourceSpan.endOffset, 40);
  assert.equal(target.targetOffset, 21);
  assert.ok(typeof target.fingerprint === 'string');
  assert.equal(target.fingerprint.length, 64); // SHA-256 hex
});

test('a one-line docstring span is supported', () => {
  const source = 'def f():\n    """one-liner"""\n    pass\n';
  // opening """ at offset 10, closing """ at offset 23
  const target = createDocstringRepairTarget({
    source,
    docstringStartOffset: 10,
    docstringEndOffset: 23,
    targetOffset: 13, // "o" of "one-liner"
    mappingConfidence: 'high',
    anchorKind: 'docstring-line',
  });

  assert.ok(target);
  assert.equal(target.sourceSpan.startOffset, 10);
  assert.equal(target.sourceSpan.endOffset, 23);
});

test('a multiline docstring span is supported', () => {
  const source = 'class Foo:\n    """First line.\n\n    Second line.\n    """\n    pass\n';
  // opening """ at offset 13, closing """ at offset 52
  const target = createDocstringRepairTarget({
    source,
    docstringStartOffset: 13,
    docstringEndOffset: 52,
    targetOffset: 16, // "F" of "First"
    mappingConfidence: 'high',
    anchorKind: 'docstring-line',
  });

  assert.ok(target);
  assert.equal(target.sourceSpan.startOffset, 13);
  assert.equal(target.sourceSpan.endOffset, 52);
});

test('a fallback mapping (anchorKind != docstring-line) produces no target', () => {
  const source = 'def f():\n    """doc"""\n    pass\n';
  const target = createDocstringRepairTarget({
    source,
    docstringStartOffset: 10,
    docstringEndOffset: 17,
    targetOffset: 13,
    mappingConfidence: 'high',
    anchorKind: 'docstring-line-fallback',
  });

  assert.equal(target, undefined);
});

test('a low-confidence mapping produces no target', () => {
  const source = 'def f():\n    """doc"""\n    pass\n';
  const target = createDocstringRepairTarget({
    source,
    docstringStartOffset: 10,
    docstringEndOffset: 17,
    targetOffset: 13,
    mappingConfidence: 'low',
    anchorKind: 'docstring-line',
  });

  assert.equal(target, undefined);
});

test('invalid or reversed offsets produce no target', () => {
  const source = 'def f():\n    """doc"""\n    pass\n';

  // Reversed
  assert.equal(
    createDocstringRepairTarget({
      source,
      docstringStartOffset: 17,
      docstringEndOffset: 10,
      targetOffset: 13,
      mappingConfidence: 'high',
      anchorKind: 'docstring-line',
    }),
    undefined,
  );

  // Negative
  assert.equal(
    createDocstringRepairTarget({
      source,
      docstringStartOffset: -1,
      docstringEndOffset: 17,
      targetOffset: 13,
      mappingConfidence: 'high',
      anchorKind: 'docstring-line',
    }),
    undefined,
  );

  // Equal (empty span)
  assert.equal(
    createDocstringRepairTarget({
      source,
      docstringStartOffset: 10,
      docstringEndOffset: 10,
      targetOffset: 10,
      mappingConfidence: 'high',
      anchorKind: 'docstring-line',
    }),
    undefined,
  );
});

test('a target offset outside the source span produces no target', () => {
  const source = 'def f():\n    """doc"""\n    pass\n';
  const target = createDocstringRepairTarget({
    source,
    docstringStartOffset: 10,
    docstringEndOffset: 17,
    targetOffset: 5, // before the docstring
    mappingConfidence: 'high',
    anchorKind: 'docstring-line',
  });

  assert.equal(target, undefined);
});

test('CRLF and LF equivalents produce identical fingerprints', () => {
  const sourceLF = 'def f():\n    """hello world"""\n    pass\n';
  // LF positions: docstring """ at offset 13, closing """ at offset 31
  const fingerprintLF = computeDocstringFingerprint(sourceLF, {
    startOffset: 13,
    endOffset: 31,
  });

  const sourceCRLF = 'def f():\r\n    """hello world"""\r\n    pass\r\n';
  // CRLF positions: docstring """ at offset 14 (extra \r before first \n), closing """ at offset 33
  const fingerprintCRLF = computeDocstringFingerprint(sourceCRLF, {
    startOffset: 14,
    endOffset: 33,
  });

  assert.equal(fingerprintLF, fingerprintCRLF);
});

test('different docstring lexemes produce different fingerprints', () => {
  const source1 = 'def f():\n    """hello"""\n    pass\n';
  const source2 = 'def f():\n    """world"""\n    pass\n';

  // docstring: positions 13-22 for both ("""hello""" or """world""")
  const fp1 = computeDocstringFingerprint(source1, { startOffset: 13, endOffset: 22 });
  const fp2 = computeDocstringFingerprint(source2, { startOffset: 13, endOffset: 22 });

  assert.notEqual(fp1, fp2);
});

test('raw source text is not retained by the target object', () => {
  const source = 'def greet(name):\n    """Say hello."""\n    return f"Hello, {name}"\n';
  const target = createDocstringRepairTarget({
    source,
    docstringStartOffset: 17,
    docstringEndOffset: 40,
    targetOffset: 21,
    mappingConfidence: 'high',
    anchorKind: 'docstring-line',
  });

  assert.ok(target);
  // The target must not contain the raw source text
  const serialized = JSON.stringify(target);
  assert.ok(!serialized.includes('Say hello'));
  assert.ok(!serialized.includes('greet'));
});

test('a pre-computed fingerprint avoids the need for source text', () => {
  const target = createDocstringRepairTarget({
    fingerprint: 'abc123def456',
    docstringStartOffset: 10,
    docstringEndOffset: 30,
    targetOffset: 15,
    mappingConfidence: 'high',
    anchorKind: 'docstring-line',
  });

  assert.ok(target);
  assert.equal(target.fingerprint, 'abc123def456');
});

test('isValidSourceSpan rejects invalid inputs', () => {
  assert.equal(isValidSourceSpan({ startOffset: 0, endOffset: 5 }), true);
  assert.equal(isValidSourceSpan({ startOffset: 5, endOffset: 0 }), false);
  assert.equal(isValidSourceSpan({ startOffset: -1, endOffset: 5 }), false);
  assert.equal(isValidSourceSpan({ startOffset: 0, endOffset: 0 }), false);
  assert.equal(isValidSourceSpan({ startOffset: 0.5, endOffset: 5 }), false);
});

test('offsetIsInSpan correctly checks bounds', () => {
  const span = { startOffset: 10, endOffset: 20 };
  assert.equal(offsetIsInSpan(10, span), true); // inclusive start
  assert.equal(offsetIsInSpan(15, span), true);
  assert.equal(offsetIsInSpan(19, span), true);
  assert.equal(offsetIsInSpan(20, span), false); // exclusive end
  assert.equal(offsetIsInSpan(9, span), false);
});
