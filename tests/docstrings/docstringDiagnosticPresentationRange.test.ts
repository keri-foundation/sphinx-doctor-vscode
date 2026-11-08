// tests/docstrings/docstringDiagnosticPresentationRange.test.ts
// Unit tests for visibleContentColumns and the mapped-line presentation range
// contract. No VS Code, no filesystem, no repair semantics.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { visibleContentColumns } from '../../src/docstrings/TextPythonDocstringSourceMapper';

describe('visibleContentColumns', () => {
  it('excludes leading indentation and includes visible content', () => {
    const line = '    This is a docstring line.';
    const result = visibleContentColumns(line);
    assert.ok(result);
    assert.equal(result.start, 4);
    assert.equal(result.end, 29);
  });

  it('includes content through its last non-whitespace character', () => {
    const line = '        Returns the identifier.';
    const result = visibleContentColumns(line);
    assert.ok(result);
    assert.equal(result.start, 8);
    assert.equal(result.end, 31);
  });

  it('excludes trailing whitespace', () => {
    const line = '  trailing spaces here    ';
    const result = visibleContentColumns(line);
    assert.ok(result);
    assert.equal(result.start, 2);
    assert.equal(result.end, 22); // after "here"
  });

  it('returns null for an empty line', () => {
    assert.equal(visibleContentColumns(''), null);
  });

  it('returns null for a whitespace-only line', () => {
    assert.equal(visibleContentColumns('        '), null);
  });

  it('returns null for a tab-only line', () => {
    assert.equal(visibleContentColumns('\t\t\t'), null);
  });

  it('handles a line with no leading whitespace', () => {
    const line = 'No indent at all.';
    const result = visibleContentColumns(line);
    assert.ok(result);
    assert.equal(result.start, 0);
    assert.equal(result.end, 17);
  });

  it('handles a single non-whitespace character', () => {
    const line = '  x';
    const result = visibleContentColumns(line);
    assert.ok(result);
    assert.equal(result.start, 2);
    assert.equal(result.end, 3);
  });

  it('handles non-BMP Unicode with valid UTF-16 column semantics', () => {
    // "🌟 star" — U+1F31F is a surrogate pair (2 UTF-16 code units)
    const line = '  🌟 star';
    const result = visibleContentColumns(line);
    assert.ok(result);
    assert.equal(result.start, 2);
    // start=2, 🌟 takes code units 2-3, space at 4, "star" at 5-8, end=9
    assert.equal(result.end, 9);
  });

  it('does not introduce source-offset, fingerprint, or repair-target concepts', () => {
    const result = visibleContentColumns('  content');
    assert.ok(result);
    assert.ok('start' in result);
    assert.ok('end' in result);
    // Only start and end keys
    const keys = Object.keys(result);
    assert.deepStrictEqual(keys.sort(), ['end', 'start']);
    // All values are numbers (not objects, not strings)
    for (const key of keys) {
      const value: unknown = (result as Record<string, unknown>)[key];
      assert.equal(typeof value, 'number');
    }
  });
});
