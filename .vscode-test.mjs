import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from '@vscode/test-cli';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const integrationWorkspaceFolder = path.resolve(
  __dirname,
  'tests',
  'fixtures',
  'simple-sphinx',
);

export default defineConfig([
  {
    label: 'integration',
    files: 'out/tests/integration/**/*.test.js',
    version: 'stable',
    extensionDevelopmentPath: __dirname,
    workspaceFolder: integrationWorkspaceFolder,
    launchArgs: ['--disable-extensions'],
    mocha: {
      timeout: 60000,
    },
  },
]);