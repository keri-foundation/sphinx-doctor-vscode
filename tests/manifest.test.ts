import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { SELF_TEST_COMMAND_ID } from '../src/commands/selfTestDiagnostic';

test('extension manifest declares the stable sphinxDoctor settings surface', async () => {
  const raw = await readFile(path.resolve('package.json'), 'utf-8');
  const manifest = JSON.parse(raw);

  assert.ok(manifest.contributes, 'Expected contributes section');
  const commands = manifest.contributes.commands as Array<{ command: string; title: string }>;
  assert.ok(Array.isArray(commands), 'Expected commands array');

  const commandIds = commands.map((c) => c.command);
  assert.ok(commandIds.includes(SELF_TEST_COMMAND_ID));
  assert.ok(commandIds.includes('sphinxDoctor.loadDiagnosticsFile'));
  assert.ok(commandIds.includes('sphinxDoctor.troubleshootEnvironment'));
  assert.ok(commandIds.includes('sphinxDoctor.runSphinxBuild'));
  assert.ok(commandIds.includes('sphinxDoctor.refreshProjectDiagnostics'));
  assert.ok(commandIds.includes('sphinxDoctor.explainDiagnosticsCounts'));

  const config = manifest.contributes.configuration;
  assert.ok(config, 'Expected configuration section');
  const properties = config.properties as Record<string, unknown>;
  assert.ok(properties, 'Expected configuration properties');

  for (const key of [
    'sphinxDoctor.projects',
    'sphinxDoctor.diagnostics.mode',
    'sphinxDoctor.python.interpreter',
    'sphinxDoctor.enrichment.enabled',
    'sphinxDoctor.enrichment.autoRun',
    'sphinxDoctor.defaultSourceWorkspaceFolder',
    'sphinxDoctor.watch.enabled',
    'sphinxDoctor.watch.autoLoadOnStartup',
    'sphinxDoctor.watch.debounceMs',
    'sphinxDoctor.refresh.autoRunOnStartup',
    'sphinxDoctor.refresh.autoRunOnSave',
    'sphinxDoctor.refresh.debounceMs',
    'sphinxDoctor.discovery.enabled',
    'sphinxDoctor.discovery.includeLowConfidence',
    'sphinxDoctor.discovery.inventoryWorkspaceFolderNames',
    'sphinxDoctor.discovery.excludeWorkspaceFolders',
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(properties, key), true, key);
  }
});

test('launch config exposes one obvious primary extension host workflow', async () => {
  const raw = await readFile(path.resolve('.vscode/launch.json'), 'utf-8');
  const launch = JSON.parse(raw);

  assert.ok(Array.isArray(launch.configurations), 'Expected configurations array');
  const hostConfigs = launch.configurations.filter(
    (c: { type?: string }) => c.type === 'extensionHost',
  );
  assert.ok(hostConfigs.length >= 1, 'Expected at least one extensionHost launch config');

  const primary = (launch.configurations as Array<{
    name?: string;
    type?: string;
    args?: string[];
    preLaunchTask?: string;
  }>).find((c) => c.name === 'Run Sphinx Doctor Extension Host');

  assert.equal(primary?.type, 'extensionHost');
  assert.equal(primary?.preLaunchTask, 'npm: compile');
  assert.deepEqual(primary?.args?.slice(0, 3), [
    '--new-window',
    '--disable-extensions',
    '--extensionDevelopmentPath=${workspaceFolder}',
  ]);
});

test('extension manifest exposes local package and install scripts', async () => {
  const raw = await readFile(path.resolve('package.json'), 'utf-8');
  const manifest = JSON.parse(raw);

  assert.ok(manifest.scripts, 'Expected scripts section');
  assert.equal(manifest.publisher, 'keri-foundation');
  assert.equal(manifest.scripts.package, 'node scripts/package-vsix.mjs');
  assert.equal(
    manifest.scripts['install:local'],
    'npm run package && code --install-extension ./artifacts/sphinx-doctor-vscode-$npm_package_version.vsix --force',
  );
});

test('compiled output contains every runtime module required at extension activation', () => {
  const outDir = path.resolve('out', 'src');

  // These modules are loaded at activation (extension.ts → registerCommands → …)
  const requiredModules = [
    'extension.js',
    'types.js',
    'commands/registerCommands.js',
    'commands/directRun.js',
    'commands/directRunSaveRepublisher.js',
    'commands/diagnosticsLoading.js',
    'commands/projectSelection.js',
    'commands/refreshAndEnrichment.js',
    'commands/runSafely.js',
    'commands/selfTestDiagnostic.js',
    'config/extensionConfig.js',
    'constants/config.js',
    'constants/selfTest.js',
    'diagnostics/diagnosticsAccounting.js',
    'diagnostics/loadAllDiagnostics.js',
    'diagnostics/loadDiagnostics.js',
    'docstrings/PythonDocstringSourceMapper.js',
    'docstrings/TextPythonDocstringSourceMapper.js',
    'enrichment/enrichmentRunner.js',
    'logging/extensionLogger.js',
    'publication/publicationIndex.js',
    'publication/publishDiagnostics.js',
    'refresh/refreshRunner.js',
    'sphinx/SphinxDoctorRunner.js',
    'sphinx/SphinxWarningParser.js',
    'sphinx/sphinxWarningSummary.js',
    'watch/watchMode.js',
    'watch/watchModeState.js',
    'watch/watchFormatting.js',
    'watch/watchStatus.js',
    'watch/watchDiagnosticsState.js',
    'watch/watchEventSuppression.js',
    'watch/watchProjectRefresh.js',
    'watch/watchRefreshCoordinator.js',
    'workspace/inventoryCandidates.js',
    'workspace/projectDiscovery.js',
    'docstrings/remediation/docstringRemediationAssessment.js',
    'docstrings/remediation/docstringRemediationPolicy.js',
  ];

  for (const mod of requiredModules) {
    const fullPath = path.join(outDir, mod);
    assert.ok(existsSync(fullPath), `Missing compiled module: ${fullPath}`);
  }
});

test('package.json main entry exists in compiled output', () => {
  const raw = require('fs').readFileSync(path.resolve('package.json'), 'utf-8');
  const manifest = JSON.parse(raw);
  const mainPath = path.resolve(manifest.main);
  assert.ok(existsSync(mainPath), `main entry "${manifest.main}" does not exist at ${mainPath}`);
});
