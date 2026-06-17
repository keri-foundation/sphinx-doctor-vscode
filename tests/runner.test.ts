import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSphinxRunPlan } from '../src/runner/SphinxDoctorRunner';

test('buildSphinxRunPlan includes -E for fresh environment', () => {
  const plan = buildSphinxRunPlan({
    config: {
      enabled: true,
      command: 'sphinx-build',
      builder: 'dirhtml',
      sourceDir: 'docs',
      outputDir: '.tmp/sphinx-doctor/dirhtml',
      warningFile: '.tmp/sphinx-doctor/warnings.log',
      extraArgs: [],
    },
    workspaceFolders: [{ name: 'test-workspace', fsPath: '/tmp/test-project' }],
    cwdWorkspaceFolder: 'test-workspace',
  });

  assert.ok(plan.args.includes('-E'), 'args should include -E for fresh Sphinx environment');
  assert.equal(plan.args[plan.args.indexOf('-E') + 1], plan.sourceDir, '-E should be followed by sourceDir');
});
