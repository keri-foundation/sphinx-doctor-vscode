import assert from 'node:assert/strict';
import path from 'node:path';

import * as vscode from 'vscode';

const EXTENSION_ID = 'keri-foundation.sphinx-doctor-vscode';
const COMMAND_IDS = [
  'sphinxDoctor.publishSelfTestDiagnostic',
  'sphinxDoctor.loadFixtureDiagnostics',
  'sphinxDoctor.loadProjectDiagnostics',
  'sphinxDoctor.clearDiagnostics',
  'sphinxDoctor.showStatus',
  'sphinxDoctor.troubleshootEnvironment',
];
const TROUBLESHOOT_HEADING = '# Sphinx Doctor Troubleshoot Environment';
const SELF_TEST_MESSAGE = '[self-test] Sphinx Doctor diagnostic publishing is working.';
const FIXTURE_DIAGNOSTIC_MESSAGE = '[unexpected-indentation] Fixture docstring indentation issue. (greet)';

function fixtureUri(...segments: string[]): vscode.Uri {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, 'Expected the integration fixture workspace to be open.');
  return vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, ...segments));
}

function fixtureWorkspaceFolder(): vscode.WorkspaceFolder {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, 'Expected the integration fixture workspace to be open.');
  return workspaceFolder;
}

function publishedSphinxDiagnostics(): Array<[vscode.Uri, readonly vscode.Diagnostic[]]> {
  return vscode.languages
    .getDiagnostics()
    .filter(([, entries]) => entries.some((entry) => entry.source === 'sphinx-doctor'));
}

async function waitFor<T>(
  factory: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  timeoutMs = 20000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await factory();
    if (predicate(value)) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for test condition.`);
}

async function openDemoFile(): Promise<vscode.Uri> {
  const uri = fixtureUri('src', 'demo.py');
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
  return uri;
}

suite('Sphinx Doctor extension host integration', function () {
  this.timeout(60000);

  teardown(async () => {
    await vscode.commands.executeCommand('sphinxDoctor.clearDiagnostics');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('activates in the fixture workspace, auto-loads fixture diagnostics, and clears them cleanly', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `Expected extension ${EXTENSION_ID} to be available.`);

    await extension.activate();
    assert.equal(extension.isActive, true);

    const commands = await vscode.commands.getCommands(true);
    for (const commandId of COMMAND_IDS) {
      assert.ok(commands.includes(commandId), `Expected command ${commandId} to be registered.`);
    }
    const uri = await openDemoFile();

    const publishedDiagnostics = await waitFor(
      () => vscode.languages.getDiagnostics().filter(([, entries]) => entries.some((entry) => entry.source === 'sphinx-doctor')),
      (entries) => entries.length > 0,
    );

    assert.equal(publishedDiagnostics.length, 1);
    assert.equal(publishedDiagnostics[0]?.[0].toString(), uri.toString());
    assert.equal(publishedDiagnostics[0]?.[1].length, 1);
    assert.equal(publishedDiagnostics[0]?.[1][0]?.message, FIXTURE_DIAGNOSTIC_MESSAGE);
    assert.equal(publishedDiagnostics[0]?.[1][0]?.source, 'sphinx-doctor');
    assert.equal(publishedDiagnostics[0]?.[1][0]?.severity, vscode.DiagnosticSeverity.Error);
    assert.equal(publishedDiagnostics[0]?.[1][0]?.code, 'unexpected-indentation');

    await vscode.commands.executeCommand('sphinxDoctor.clearDiagnostics');
    await waitFor(
      () => vscode.languages.getDiagnostics(),
      (entries) => entries.length === 0,
    );
  });

  test('troubleshoot environment opens a markdown report in test mode', async () => {
    await openDemoFile();

    await vscode.commands.executeCommand('sphinxDoctor.troubleshootEnvironment');

    const editor = await waitFor(
      () => vscode.window.activeTextEditor,
      (candidate) => candidate?.document.uri.path.includes('/troubleshoot-reports/') === true,
    );
    assert.ok(editor, 'Expected the troubleshoot command to open an editor.');

    const reportPath = editor.document.uri.fsPath;
    const reportFileName = path.basename(reportPath);
    const workspaceRoot = fixtureWorkspaceFolder().uri.fsPath;

    assert.equal(editor.document.languageId, 'markdown');
    assert.notEqual(editor.document.uri.scheme, 'untitled');
    assert.equal(editor.document.isDirty, false);
    assert.equal(reportFileName.includes(' '), false);
    assert.equal(reportFileName.startsWith('#'), false);
    assert.equal(path.resolve(reportPath).startsWith(`${path.resolve(workspaceRoot)}${path.sep}`), false);
    assert.match(editor.document.uri.path, /\/troubleshoot-reports\/troubleshoot-environment-[^/]+\.md$/);
    assert.match(reportFileName, /^troubleshoot-environment-\d{8}-\d{6}\.md$/);
    assert.match(editor.document.getText(), /# Sphinx Doctor Troubleshoot Environment/);
    assert.match(editor.document.getText(), /Extension mode: Test/);
    assert.match(editor.document.getText(), /Extension path:/);
    assert.match(editor.document.getText(), /Workspace trusted:/);

    const reportStat = await vscode.workspace.fs.stat(editor.document.uri);
    assert.notEqual(reportStat.type & vscode.FileType.File, 0);
  });

  test('load project diagnostics publishes the flattened fixture artifact and clears it cleanly', async () => {
    const uri = await openDemoFile();
    const diagnosticsArtifactUri = fixtureUri('.sphinx-diagnostics', 'latest.json');

    await vscode.commands.executeCommand('sphinxDoctor.clearDiagnostics');
    await waitFor(
      () => publishedSphinxDiagnostics(),
      (entries) => entries.length === 0,
    );

    await vscode.commands.executeCommand('sphinxDoctor.loadProjectDiagnostics');

    const publishedDiagnostics = await waitFor(
      () => publishedSphinxDiagnostics(),
      (entries) => entries.length > 0,
    );

    assert.equal(publishedDiagnostics.length, 1);
    assert.equal(publishedDiagnostics[0]?.[0].toString(), uri.toString());
    assert.equal(publishedDiagnostics[0]?.[1].length, 1);
    assert.equal(publishedDiagnostics[0]?.[1][0]?.message, FIXTURE_DIAGNOSTIC_MESSAGE);
    assert.equal(publishedDiagnostics[0]?.[1][0]?.source, 'sphinx-doctor');
    assert.equal(publishedDiagnostics[0]?.[1][0]?.severity, vscode.DiagnosticSeverity.Error);
    assert.equal(publishedDiagnostics[0]?.[1][0]?.code, 'unexpected-indentation');
    assert.equal(vscode.languages.getDiagnostics(diagnosticsArtifactUri).length, 0);

    await vscode.commands.executeCommand('sphinxDoctor.clearDiagnostics');
    await waitFor(
      () => publishedSphinxDiagnostics(),
      (entries) => entries.length === 0,
    );
  });

  test('self-test diagnostics publish to the active file and can be cleared', async () => {
    const uri = await openDemoFile();

    await vscode.commands.executeCommand('sphinxDoctor.clearDiagnostics');
    await waitFor(
      () => vscode.languages.getDiagnostics(uri),
      (diagnostics) => diagnostics.length === 0,
    );

    await vscode.commands.executeCommand('sphinxDoctor.publishSelfTestDiagnostic');

    const diagnostics = await waitFor(
      () => vscode.languages.getDiagnostics(uri),
      (entries) => entries.some((entry) => entry.source === 'sphinx-doctor'),
    );

    assert.ok(diagnostics.some((entry) => entry.source === 'sphinx-doctor'));
    assert.ok(diagnostics.some((entry) => entry.message === SELF_TEST_MESSAGE));

    await vscode.commands.executeCommand('sphinxDoctor.clearDiagnostics');
    await waitFor(
      () => vscode.languages.getDiagnostics(uri),
      (entries) => entries.length === 0,
    );
  });
});