import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
    'sphinxDoctor.logLevel',
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
  assert.equal(manifest.scripts.package, 'npm exec --yes --package @vscode/vsce -- vsce package');
  assert.equal(
    manifest.scripts['install:local'],
    'npm run package && code --install-extension ./sphinx-doctor-vscode-$npm_package_version.vsix --force',
  );
});
