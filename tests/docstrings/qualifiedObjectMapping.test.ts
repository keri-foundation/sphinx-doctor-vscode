import * as assert from 'node:assert';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { parseSphinxWarnings } from '../../src/sphinx/SphinxWarningParser';
import {
  extractClassAndMember,
  findDefinition,
} from '../../src/docstrings/TextPythonDocstringSourceMapper';

const FIXTURE_DIR = path.resolve(__dirname, '..', '..', '..', 'tests', 'fixtures');
const FIXTURE_FILE = path.resolve(FIXTURE_DIR, 'qualified_object_fixture.py');

function readFixtureLines(): string[] {
  return fs.readFileSync(FIXTURE_FILE, 'utf8').split('\n');
}

// ---- qualified-object resolution ----

test('extractClassAndMember resolves Kevery.processReplyEndRole to [Kevery, processReplyEndRole]', () => {
  const parts = 'keri.core.eventing.Kevery.processReplyEndRole'.split('.');
  const result = extractClassAndMember(parts);
  assert.deepStrictEqual(result, ['Kevery', 'processReplyEndRole']);
});

test('extractClassAndMember resolves bare to [bare] (module-level function)', () => {
  const parts = 'keri.core.eventing.bare'.split('.');
  const result = extractClassAndMember(parts);
  assert.deepStrictEqual(result, ['bare']);
});

test('findDefinition resolves Kevery.processReplyEndRole to the class method (not module-level state)', () => {
  const lines = readFixtureLines();

  const result = findDefinition(lines, ['Kevery', 'processReplyEndRole']);
  assert.ok(result, 'Should find Kevery.processReplyEndRole');
  assert.ok(result.defLine > 0, 'defLine should be valid');

  // The method must be AFTER the class definition line and inside the class
  const classDef = findDefinition(lines, ['Kevery']);
  assert.ok(classDef, 'Should find class Kevery');
  assert.ok(result.defLine > classDef.defLine, 'Method must be after class');
  assert.ok(result.indent > classDef.indent, 'Method must be indented deeper than class');
});

test('findDefinition for single-part state finds module-level function', () => {
  const lines = readFixtureLines();

  const result = findDefinition(lines, ['state']);
  assert.ok(result, 'Should find module-level state');
  // state comes before Kevery in the fixture
  const keveryDef = findDefinition(lines, ['Kevery']);
  assert.ok(keveryDef, 'Should find Kevery');
  assert.ok(result.defLine < keveryDef.defLine, 'state should be before Kevery');
});

test('findDefinition for Kevery.processReplyEndRole does NOT return module-level state', () => {
  const lines = readFixtureLines();

  const result = findDefinition(lines, ['Kevery', 'processReplyEndRole']);
  assert.ok(result, 'Should find processReplyEndRole');

  // Verify the found line contains the correct method name
  const foundLine = lines[result.defLine];
  assert.ok(foundLine.includes('def processReplyEndRole'), `Found wrong definition: ${foundLine}`);
  assert.ok(!foundLine.includes('def state'), `Should not resolve to state: ${foundLine}`);
});

// ---- full pipeline: parser → mapper → publication safety ----

test('parseSphinxWarnings with docstring warning maps inside correct docstring', async () => {
  const warning = `${FIXTURE_FILE}:docstring of Kevery.processReplyEndRole:29: ERROR: Unknown target name: "keri10json00011c". [docutils]`;

  const result = await parseSphinxWarnings({
    warningFileContent: warning,
    repoRoot: path.dirname(FIXTURE_FILE),
    sourceWorkspaceFolder: 'test',
  });

  // Should have 1 issue (docstring warning, mapped)
  assert.strictEqual(result.issues.length, 1, 'Should produce 1 issue');
  assert.strictEqual(result.unmappedCount, 0);

  const issue = result.issues[0];
  assert.strictEqual(issue.publishDiagnostic, true, 'Should be publishable when safely mapped');
  assert.ok(issue.sourceRange, 'Should have a source range');
  assert.ok(issue.docstringStartLine != null, 'Should have docstringStartLine');
  assert.ok(issue.docstringEndLine != null, 'Should have docstringEndLine');

  // The published range must be within the docstring span
  if (issue.docstringStartLine != null && issue.docstringEndLine != null) {
    assert.ok(
      issue.sourceRange!.startLine >= issue.docstringStartLine,
      `startLine ${issue.sourceRange!.startLine} should be >= docstringStartLine ${issue.docstringStartLine}`,
    );
    assert.ok(
      issue.sourceRange!.endLine <= issue.docstringEndLine,
      `endLine ${issue.sourceRange!.endLine} should be <= docstringEndLine ${issue.docstringEndLine}`,
    );
  }
});

test('parseSphinxWarnings with out-of-range docstring line is NOT published', async () => {
  // docstring line 999 is far beyond the actual docstring length
  const warning = `${FIXTURE_FILE}:docstring of Kevery.processReplyEndRole:999: ERROR: Unknown target name: "keri10json00011c". [docutils]`;

  const result = await parseSphinxWarnings({
    warningFileContent: warning,
    repoRoot: path.dirname(FIXTURE_FILE),
    sourceWorkspaceFolder: 'test',
  });

  assert.strictEqual(result.issues.length, 1, 'Should produce 1 issue (retained for inventory)');
  const issue = result.issues[0];
  assert.strictEqual(issue.publishDiagnostic, false, 'Out-of-range line must NOT be published');
  assert.strictEqual(issue.sourceRange, null, 'Source range must be null when not published');
  assert.ok(result.unsafeDocstringFallbackCount >= 1, 'Should count as unsafe fallback');
});

test('parseSphinxWarnings with module-level function still works correctly', async () => {
  const warning = `${FIXTURE_FILE}:docstring of state:7: WARNING: Unexpected indentation. [docutils]`;

  const result = await parseSphinxWarnings({
    warningFileContent: warning,
    repoRoot: path.dirname(FIXTURE_FILE),
    sourceWorkspaceFolder: 'test',
  });

  assert.strictEqual(result.issues.length, 1);
  const issue = result.issues[0];
  // state is a module-level function with a docstring, so it should map
  assert.strictEqual(issue.publishDiagnostic, true, 'Module-level function should be publishable when safely mapped');
  assert.ok(issue.sourceRange, 'Should have source range');
});

test('parseSphinxWarnings: unresolved object is NOT published and has no fallback range', async () => {
  const warning = `${FIXTURE_FILE}:docstring of NonexistentClass.nonexistent:3: ERROR: Some error. [docutils]`;

  const result = await parseSphinxWarnings({
    warningFileContent: warning,
    repoRoot: path.dirname(FIXTURE_FILE),
    sourceWorkspaceFolder: 'test',
  });

  assert.strictEqual(result.issues.length, 1, 'Retained for inventory');
  const issue = result.issues[0];
  assert.strictEqual(issue.publishDiagnostic, false, 'Unresolved object must NOT be published');
  assert.strictEqual(issue.sourceRange, null, 'No fallback source range');
});
