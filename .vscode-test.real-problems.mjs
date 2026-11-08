// .vscode-test.real-problems.mjs
// Targeted runner: only the real-workspace Keripy Problems test.
// Requires SPHINX_DOCTOR_REAL_WORKSPACE env var.
// Not included in CI or default test suite.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from '@vscode/test-cli';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const realWorkspace = process.env.SPHINX_DOCTOR_REAL_WORKSPACE;
if (!realWorkspace) {
  console.error('SPHINX_DOCTOR_REAL_WORKSPACE must be set');
  process.exit(1);
}

export default defineConfig([
  {
    label: 'real-problems',
    files: 'out/tests/integration/keripyProblems.integration.test.js',
    version: 'stable',
    extensionDevelopmentPath: __dirname,
    workspaceFolder: realWorkspace,
    launchArgs: ['--disable-extensions', '--user-data-dir', '/tmp/vscode-test-keripy'],
    mocha: {
      timeout: 180_000,
    },
  },
]);
