import * as assert from 'node:assert';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { checkDocstringRangeGate } from '../../src/publication/docstringRangeGate';

const FIXTURE_DIR = path.resolve(__dirname, '..', '..', '..', 'tests', 'fixtures');
const FIXTURE_FILE = path.resolve(FIXTURE_DIR, 'qualified_object_fixture.py');

// ── Inline-source tests (deterministic line numbers) ──────────────────

const TWO_DOCSTRINGS_SRC = [
  '"""Module docstring."""',       // line 1
  '',                               // line 2
  'def foo():',                     // line 3
  '    """Foo docstring.',         // line 4
  '    More foo docs.',            // line 5
  '    """',                        // line 6
  '    pass',                       // line 7
  '',                               // line 8
  'def bar():',                     // line 9
  '    """Bar docstring.',         // line 10
  '    More bar docs.',            // line 11
  '    """',                        // line 12
  '    pass',                       // line 13
].join('\n');

test('gate withholds range on runtime code line (pass statement)', () => {
  const result = checkDocstringRangeGate(TWO_DOCSTRINGS_SRC, 7, 7);
  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.skipReason, 'publisher-range-not-in-docstring');
});

test('gate withholds range on function-definition line', () => {
  const result = checkDocstringRangeGate(TWO_DOCSTRINGS_SRC, 3, 3);
  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.skipReason, 'publisher-range-not-in-docstring');
});

test('gate publishes range inside foo docstring', () => {
  const result = checkDocstringRangeGate(TWO_DOCSTRINGS_SRC, 5, 5);
  assert.strictEqual(result.passed, true);
});

test('gate publishes range inside bar docstring', () => {
  const result = checkDocstringRangeGate(TWO_DOCSTRINGS_SRC, 11, 11);
  assert.strictEqual(result.passed, true);
});

// ── Resolved-object span enforcement ─────────────────────────────────

test('gate withholds when range is in foo docstring but resolved object is bar', () => {
  const result = checkDocstringRangeGate(TWO_DOCSTRINGS_SRC, 5, 5, 10, 12);
  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.skipReason, 'publisher-range-outside-resolved-object-docstring');
});

test('gate publishes when range is inside resolved object docstring', () => {
  const result = checkDocstringRangeGate(TWO_DOCSTRINGS_SRC, 11, 11, 10, 12);
  assert.strictEqual(result.passed, true);
});

// ── Invalid range ─────────────────────────────────────────────────────

test('gate withholds when startLine is zero', () => {
  const result = checkDocstringRangeGate(TWO_DOCSTRINGS_SRC, 0, 1);
  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.skipReason, 'publisher-source-unavailable');
});

test('gate withholds when endLine is negative', () => {
  const result = checkDocstringRangeGate(TWO_DOCSTRINGS_SRC, 1, -1);
  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.skipReason, 'publisher-source-unavailable');
});

// ── Edge: empty file / no docstrings ─────────────────────────────────

test('gate withholds when source has no detectable docstring spans', () => {
  const result = checkDocstringRangeGate('x = 1\ny = 2\n', 1, 1);
  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.skipReason, 'publisher-range-not-in-docstring');
  assert.match(result.reason, /no detectable docstring spans/);
});

// ── Fixture: Unknown target name regression ──────────────────────────

test('gate withholds Unknown target name diagnostic on runtime line in fixture', () => {
  const source = fs.readFileSync(FIXTURE_FILE, 'utf8');
  const lines = source.split('\n');

  const passAfterState = lines.findIndex((l, i) => l.trim() === 'pass' && i > 8 && i < 25);
  assert.ok(passAfterState > 0, 'Should find pass after state()');

  const result = checkDocstringRangeGate(source, passAfterState + 1, passAfterState + 1);
  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.skipReason, 'publisher-range-not-in-docstring');
});

test('gate publishes Unknown target name diagnostic on KERI10JSON00011c_ line inside docstring', () => {
  const source = fs.readFileSync(FIXTURE_FILE, 'utf8');
  const lines = source.split('\n');

  const keriLine = lines.findIndex((l) => l.includes('KERI10JSON00011c_'));
  assert.ok(keriLine > 0, 'Should find KERI10JSON00011c_ line');

  const result = checkDocstringRangeGate(source, keriLine + 1, keriLine + 1);
  assert.strictEqual(result.passed, true);
});

// ── Column-bounds regression tests ───────────────────────────────────

test('gate withholds when startColumn exceeds line length (out-of-bounds closing-line regression)', () => {
  // Simulates the line-1240 columns-29–79 bug: a closing """ with 7 chars
  const src = [
    'def foo():',          // line 1
    '    """Docstring.',  // line 2
    '    content',         // line 3
    '    """',             // line 4 — 7 characters (4 spaces + 3 quotes)
    '    pass',            // line 5
  ].join('\n');

  const result = checkDocstringRangeGate(src, 4, 4, undefined, undefined, 29, 79);

  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.skipReason, 'publisher-column-out-of-bounds');
  assert.match(result.reason, /out of bounds/);
});

test('gate withholds when range is on closing triple-quote delimiter only', () => {
  // Line 4 is `    """` — columns 5–7 cover the `"""`
  const src = [
    'def foo():',          // line 1
    '    """Docstring.',  // line 2
    '    content',         // line 3
    '    """',             // line 4
    '    pass',            // line 5
  ].join('\n');

  const result = checkDocstringRangeGate(src, 4, 4, undefined, undefined, 5, 7);

  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.skipReason, 'publisher-docstring-delimiter-range');
});

test('gate publishes valid range inside docstring content with correct columns', () => {
  const src = [
    'def foo():',          // line 1
    '    """Docstring.',  // line 2
    '    content',         // line 3 — 11 chars: 4 spaces + "content"
    '    """',             // line 4
    '    pass',            // line 5
  ].join('\n');

  // Columns 5–11 cover "content" inside the docstring
  const result = checkDocstringRangeGate(src, 3, 3, undefined, undefined, 5, 11);

  assert.strictEqual(result.passed, true);
});

test('gate withholds when startColumn is negative', () => {
  const src = [
    'def foo():',
    '    """Docstring.',
    '    content',
    '    """',
  ].join('\n');

  const result = checkDocstringRangeGate(src, 3, 3, undefined, undefined, -1, 5);

  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.skipReason, 'publisher-column-out-of-bounds');
});

test('gate withholds when endColumn is zero', () => {
  const src = [
    'def foo():',
    '    """Docstring.',
    '    content',
    '    """',
  ].join('\n');

  const result = checkDocstringRangeGate(src, 3, 3, undefined, undefined, 1, 0);

  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.skipReason, 'publisher-column-out-of-bounds');
});

// ── Column optional: gate degrades to line-only when columns omitted ──

test('gate passes when columns are omitted and line is inside docstring', () => {
  const src = [
    'def foo():',
    '    """Docstring.',
    '    content',
    '    """',
  ].join('\n');

  // No columns provided — degrades to line-only check
  const result = checkDocstringRangeGate(src, 3, 3);

  assert.strictEqual(result.passed, true);
});

