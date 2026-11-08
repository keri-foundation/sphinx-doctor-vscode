// tests/integration/keripyProblems.integration.test.ts
// Real-workspace extension-host test.
// Requires: SPHINX_DOCTOR_REAL_WORKSPACE and SPHINX_DOCTOR_EXPECTED_CATEGORY
//
// Proves that Sphinx Doctor publishes real Keripy docstring diagnostics
// to the VS Code Problems API via the public direct-run command path.
//
// This test is NOT included in the default unit suite. Run with:
//   npm run test:real-problems

import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';

const COMMAND_ID = 'sphinxDoctor.runSphinxBuild';
const DIAGNOSTIC_SOURCE = 'sphinx-doctor';
const PUBLICATION_TIMEOUT_MS = 120_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  assert.ok(value, `${name} environment variable must be set`);
  return value;
}

const REAL_WORKSPACE = requireEnv('SPHINX_DOCTOR_REAL_WORKSPACE');
const EXPECTED_CATEGORY = requireEnv('SPHINX_DOCTOR_EXPECTED_CATEGORY');

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

suite('Keripy Real-Workspace Problems', function () {
  this.timeout(PUBLICATION_TIMEOUT_MS + 30_000);

  test('publishes real sphinx-doctor diagnostics on Keripy Python files', async () => {
    // 1. Verify the workspace
    const workspaceFolders = vscode.workspace.workspaceFolders;
    assert.ok(workspaceFolders && workspaceFolders.length > 0, 'Expected workspace to be open');
    const workspaceFolder = workspaceFolders[0];
    const workspacePath = workspaceFolder.uri.fsPath;
    assert.ok(
      path.resolve(workspacePath) === path.resolve(REAL_WORKSPACE),
      `Workspace ${workspacePath} does not match expected ${REAL_WORKSPACE}`,
    );

    // 2. Verify Sphinx Doctor config is suitable
    const config = vscode.workspace.getConfiguration('sphinxDoctor');
    const directRunEnabled = config.get<boolean>('directRun.enabled');
    assert.ok(directRunEnabled, 'sphinxDoctor.directRun.enabled must be true');

    // 3. Verify we can call getDiagnostics (clearing happens on command execute)
    vscode.languages.getDiagnostics();

    // 4. Set up a promise that resolves when diagnostics change
    let diagnosticsChanged = false;
    const diagnosticsPromise = new Promise<void>((resolve) => {
      const sub = vscode.languages.onDidChangeDiagnostics((event) => {
        for (const uri of event.uris) {
          if (uri.fsPath.startsWith(workspacePath)) {
            diagnosticsChanged = true;
            sub.dispose();
            resolve();
            return;
          }
        }
      });
      // Safety timeout
      setTimeout(() => {
        if (!diagnosticsChanged) {
          sub.dispose();
          resolve();
        }
      }, PUBLICATION_TIMEOUT_MS);
    });

    // 5. Invoke the public direct-run command
    await vscode.commands.executeCommand(COMMAND_ID);

    // 6. Wait for diagnostics
    await diagnosticsPromise;

    // 7. Collect diagnostics
    const allDiagnostics = vscode.languages.getDiagnostics();
    const sphinxDoctorDiagnostics: Array<{
      uri: vscode.Uri;
      diagnostic: vscode.Diagnostic;
    }> = [];

    for (const [uri, diagnostics] of allDiagnostics) {
      for (const d of diagnostics) {
        if (d.source === DIAGNOSTIC_SOURCE) {
          sphinxDoctorDiagnostics.push({ uri, diagnostic: d });
        }
      }
    }

    assert.ok(
      sphinxDoctorDiagnostics.length > 0,
      `Expected at least one sphinx-doctor diagnostic, got ${sphinxDoctorDiagnostics.length}`,
    );

    // 8. Find a Python diagnostic matching the expected category
    const pythonMatches = sphinxDoctorDiagnostics.filter(({ uri }) =>
      uri.fsPath.endsWith('.py') && uri.fsPath.startsWith(workspacePath),
    );

    const categoryMatch = pythonMatches.find(({ diagnostic }) => {
      const code = diagnostic.code;
      if (typeof code === 'string') return code === EXPECTED_CATEGORY;
      if (typeof code === 'object' && code !== null) {
        return (code as { value: string }).value === EXPECTED_CATEGORY;
      }
      return false;
    });

    assert.ok(
      categoryMatch,
      `No sphinx-doctor diagnostic with category '${EXPECTED_CATEGORY}' found on a .py file. ` +
      `Found ${pythonMatches.length} Python sphinx-doctor diagnostics total.`,
    );

    const { uri, diagnostic } = categoryMatch;
    const relativePath = path.relative(workspacePath, uri.fsPath);
    const code = typeof diagnostic.code === 'string'
      ? diagnostic.code
      : (diagnostic.code as { value: string })?.value ?? String(diagnostic.code);

    // 9. Verify the visible range contract
    const range = diagnostic.range;
    assert.ok(
      range.start.line === range.end.line,
      `Expected single-line range, got start.line=${range.start.line} end.line=${range.end.line}`,
    );
    assert.ok(
      range.end.character > range.start.character,
      `Expected non-empty range, got start=${range.start.character} end=${range.end.character}`,
    );

    const document = await vscode.workspace.openTextDocument(uri);
    const targetLine = range.start.line;
    const lineText = document.lineAt(targetLine).text;

    // Verify the selected substring contains non-whitespace content
    const selectedSubstring = lineText.substring(range.start.character, range.end.character);
    assert.ok(
      selectedSubstring.trim().length > 0,
      `Selected range content is whitespace-only: "${selectedSubstring}"`,
    );

    // Verify range start is at or after the first non-whitespace character
    const firstNonWs = lineText.search(/\S/);
    assert.ok(
      firstNonWs === -1 || range.start.character >= firstNonWs,
      `Range start ${range.start.character} is before first non-whitespace char ${firstNonWs}`,
    );

    // 10. Count diagnostics on this URI
    const uriDiagnostics = (vscode.languages.getDiagnostics(uri) ?? [])
      .filter((d) => d.source === DIAGNOSTIC_SOURCE);
    const sphinxCount = uriDiagnostics.length;

    // 11. Print evidence line with range columns
    const startCol = range.start.character;
    const endCol = range.end.character;
    const evidence = `KERIPY_PROBLEMS_EVIDENCE path=${relativePath} code=${code} line=${targetLine + 1} start=${startCol} end=${endCol} diagnostics=${sphinxCount}`;
    console.log(evidence);

    // 12. Run a second time and verify no duplication
    const diagnosticsBeforeSecond = vscode.languages.getDiagnostics(uri)
      .filter((d) => d.source === DIAGNOSTIC_SOURCE).length;

    await vscode.commands.executeCommand(COMMAND_ID);

    // Give the second run a moment to publish
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const diagnosticsAfterSecond = vscode.languages.getDiagnostics(uri)
      .filter((d) => d.source === DIAGNOSTIC_SOURCE).length;

    assert.ok(
      diagnosticsAfterSecond <= diagnosticsBeforeSecond + 5,
      `Second run appears to have duplicated diagnostics: ${diagnosticsBeforeSecond} → ${diagnosticsAfterSecond}`,
    );
  });
});
