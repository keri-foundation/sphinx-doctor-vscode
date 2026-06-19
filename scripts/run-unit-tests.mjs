// scripts/run-unit-tests.mjs
// Recursive unit-test discovery and execution for the Node.js native test runner.
//
// Test taxonomy:
//   *.test.ts             → unit (runs through plain node --test)
//   *.integration.test.ts → VS Code host/integration (excluded here)

import { readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, relative, extname } from 'node:path';

const TESTS_DIR = resolve(import.meta.dirname, '..', 'out', 'tests');
const UNIT_SUFFIX = '.test.js';
const INTEGRATION_SUFFIX = '.integration.test.js';

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

async function discover() {
  const unit = [];
  const integration = [];

  let dirStat;
  try {
    dirStat = await stat(TESTS_DIR);
  } catch {
    console.error(`run-unit-tests: ${TESTS_DIR} does not exist. Run compile first.`);
    process.exit(1);
  }

  if (!dirStat.isDirectory()) {
    console.error(`run-unit-tests: ${TESTS_DIR} is not a directory.`);
    process.exit(1);
  }

  for await (const file of walk(TESTS_DIR)) {
    if (file.endsWith(INTEGRATION_SUFFIX)) {
      integration.push(file);
    } else if (file.endsWith(UNIT_SUFFIX)) {
      unit.push(file);
    }
    // Files that don't match either suffix are ignored silently.
  }

  return { unit, integration };
}

function fail(message) {
  console.error(`run-unit-tests: ${message}`);
  process.exit(1);
}

// -- main --------------------------------------------------------------------

const { unit, integration } = await discover();

if (unit.length === 0) {
  fail('no unit tests discovered.');
}

// Deterministic sort
unit.sort();
integration.sort();

// Dedup check
const seen = new Set();
for (const p of unit) {
  if (seen.has(p)) {
    fail(`duplicate unit-test path: ${p}`);
  }
  seen.add(p);
}

// Existence re-check (files may have been removed between discovery and spawn)
for (const p of unit) {
  try {
    await stat(p);
  } catch {
    fail(`unit-test file no longer exists: ${p}`);
  }
}

// Print discovery summary
const rel = (p) => relative(TESTS_DIR, p);
console.log(`run-unit-tests: ${unit.length} unit test(s) discovered.`);
if (integration.length > 0) {
  console.log(
    `run-unit-tests: ${integration.length} integration test(s) excluded:` +
      integration.map((p) => `\n  ${rel(p)}`).join(''),
  );
}

// Run
const child = spawn(
  process.execPath,
  ['--test', ...unit],
  { stdio: 'inherit', cwd: resolve(import.meta.dirname, '..') },
);

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`run-unit-tests: runner killed by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
