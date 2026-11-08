// scripts/package-vsix.mjs
// Portable VSIX packager using only Node built-ins.
// Reads package name/version from package.json, creates artifacts/ directory,
// and produces artifacts/<name>-<version>.vsix.
//
// Usage: node scripts/package-vsix.mjs
// Exit 0 on success, non-zero on failure.

import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

// Read package metadata
const pkgPath = resolve(repoRoot, 'package.json');
const pkg = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(pkgPath, 'utf8')));
const name = pkg.name;
const version = pkg.version;

if (!name || !version) {
  console.error('package-vsix: package.json missing name or version');
  process.exit(1);
}

// Create artifacts directory
const artifactsDir = resolve(repoRoot, 'artifacts');
mkdirSync(artifactsDir, { recursive: true });

// Run vsce package, capturing output path
console.log('package-vsix: running vsce package...');
const result = execFileSync('npx', [
  '--yes',
  '--package', '@vscode/vsce',
  '--',
  'vsce',
  'package',
  '--out', artifactsDir,
], {
  cwd: repoRoot,
  stdio: 'inherit',
  encoding: 'utf8',
  shell: true,
});

// Verify the artifact was created
const vsixPath = resolve(artifactsDir, `${name}-${version}.vsix`);
try {
  const st = statSync(vsixPath);
  if (!st.isFile()) {
    console.error(`package-vsix: artifact path is not a file: ${vsixPath}`);
    process.exit(1);
  }
  console.log(`package-vsix: created ${vsixPath} (${(st.size / 1024).toFixed(1)} KB)`);
} catch {
  console.error(`package-vsix: expected artifact not found: ${vsixPath}`);
  process.exit(1);
}
