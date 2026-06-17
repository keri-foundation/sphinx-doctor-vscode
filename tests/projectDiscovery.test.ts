import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDiscoveryProbePaths,
  discoverWorkspaceProjectDecisions,
  detectProjectFromSnapshot,
  discoverWorkspaceProjects,
  mergeProjects,
  parseGitWorktreeListPorcelain,
} from '../src/projectDiscovery';

import type { ConfiguredProject } from '../src/types';

const configuredProject: ConfiguredProject = {
  id: 'keripy',
  label: 'keripy',
  sourceWorkspaceFolder: '02-keripy',
  inventoryWorkspaceFolder: 'example-workspace',
  repoRoot: '.',
  docsRoot: 'docs',
  inventorySearchGlobs: [
    'tmp/sphinx-inventory-keripy-sphinx-unexpected-indentation-batch-01-*/report/issues.vscode.json',
    'tmp/sphinx-inventory-keripy-sphinx-unexpected-indentation-batch-01-*/report/issues.json',
  ],
  preferredInventoryFiles: ['issues.vscode.json', 'issues.json'],
  mirrorRoot: '.sphinx-diagnostics',
};

test('detectProjectFromSnapshot finds a high-confidence Sphinx project from docs/conf.py', () => {
  const project = detectProjectFromSnapshot(
    { name: '02-keripy', fsPath: '/workspace/keripy' },
    {
      existingPaths: new Set(['docs/conf.py']),
      fileContents: {},
    },
    {
      includeLowConfidence: false,
      inventoryWorkspaceFolderNames: ['example-workspace'],
      excludeWorkspaceFolderNames: [],
      availableWorkspaceFolderNames: ['example-workspace', '02-keripy'],
    },
  );

  assert.equal(project?.discoveryConfidence, 'high');
  assert.equal(project?.docsRoot, 'docs');
  assert.equal(project?.sourceWorkspaceFolder, '02-keripy');
  assert.equal(project?.inventoryWorkspaceFolder, 'example-workspace');
});

test('detectProjectFromSnapshot finds a high-confidence Sphinx project from docs/source/conf.py', () => {
  const project = detectProjectFromSnapshot(
    { name: '03-hio', fsPath: '/workspace/hio' },
    {
      existingPaths: new Set(['docs/source/conf.py']),
      fileContents: {},
    },
    {
      includeLowConfidence: false,
      inventoryWorkspaceFolderNames: ['example-workspace'],
      excludeWorkspaceFolderNames: [],
      availableWorkspaceFolderNames: ['example-workspace', '03-hio'],
    },
  );

  assert.equal(project?.discoveryConfidence, 'high');
  assert.equal(project?.docsRoot, 'docs');
  assert.equal(project?.sourceWorkspaceFolder, '03-hio');
});

test('detectProjectFromSnapshot treats example-workspace as a shared inventory root, not the source repo', () => {
  const project = detectProjectFromSnapshot(
    { name: '02-keripy', fsPath: '/workspace/keripy' },
    {
      existingPaths: new Set(['docs/conf.py']),
      fileContents: {},
    },
    {
      includeLowConfidence: false,
      inventoryWorkspaceFolderNames: ['example-workspace'],
      excludeWorkspaceFolderNames: [],
      availableWorkspaceFolderNames: ['example-workspace', '02-keripy'],
    },
  );

  assert.equal(project?.sourceWorkspaceFolder, '02-keripy');
  assert.equal(project?.inventoryWorkspaceFolder, 'example-workspace');
  assert.equal(
    project?.inventorySearchTargets?.some((target) => target.workspaceFolderName === 'example-workspace'),
    true,
  );
});

test('detectProjectFromSnapshot ignores docs-only and Makefile-only folders without conf.py markers', () => {
  for (const existingPaths of [new Set(['docs']), new Set(['docs/Makefile']), new Set(['pyproject.toml'])]) {
    const project = detectProjectFromSnapshot(
      { name: '09-fortweb', fsPath: '/workspace/fortweb' },
      {
        existingPaths,
        fileContents: {},
      },
      {
        includeLowConfidence: true,
        inventoryWorkspaceFolderNames: ['example-workspace'],
        excludeWorkspaceFolderNames: [],
        availableWorkspaceFolderNames: ['example-workspace', '09-fortweb'],
      },
    );

    assert.equal(project, undefined);
  }
});

test('detectProjectFromSnapshot ignores irrelevant workspace folders', () => {
  const project = detectProjectFromSnapshot(
    { name: 'example-ops-workspace', fsPath: '/workspace/ops' },
    {
      existingPaths: new Set(['README.md']),
      fileContents: {},
    },
    {
      includeLowConfidence: false,
      inventoryWorkspaceFolderNames: ['example-workspace'],
      excludeWorkspaceFolderNames: [],
      availableWorkspaceFolderNames: ['example-workspace', 'example-ops-workspace'],
    },
  );

  assert.equal(project, undefined);
});

test('discoverWorkspaceProjects skips excluded workspace folders', async () => {
  const projects = await discoverWorkspaceProjects(
    [
      { name: 'example-workspace', fsPath: '/workspace/notes' },
      { name: '02-keripy', fsPath: '/workspace/keripy' },
      { name: 'sphinx-doctor-extension', fsPath: '/workspace/sphinx-doctor' },
    ],
    {
      includeLowConfidence: false,
      inventoryWorkspaceFolderNames: ['example-workspace'],
      excludeWorkspaceFolderNames: ['example-workspace', 'sphinx-doctor-extension'],
      knownProjects: [],
    },
    {
      exists: async (filePath) => filePath === '/workspace/keripy/docs/conf.py',
      readText: async () => undefined,
    },
  );

  assert.deepEqual(projects.map((project) => project.sourceWorkspaceFolder), ['02-keripy']);
});

test('discoverWorkspaceProjectDecisions report discovered and skipped workspace folders', async () => {
  const detectedPaths = new Set([
    '/workspace/notes/libs/keripy/docs/conf.py',
    '/workspace/notes/libs/hio/docs/source/conf.py',
  ]);

  const decisions = await discoverWorkspaceProjectDecisions(
    [
      { name: 'example-workspace', fsPath: '/workspace/notes' },
      { name: '02-keripy', fsPath: '/workspace/notes/libs/keripy' },
      { name: '03-hio', fsPath: '/workspace/notes/libs/hio' },
      { name: '08-watcher-hk', fsPath: '/workspace/notes/libs/watcher-hk' },
      { name: '09-fortweb', fsPath: '/workspace/notes/libs/fortweb' },
    ],
    {
      includeLowConfidence: true,
      inventoryWorkspaceFolderNames: ['example-workspace'],
      excludeWorkspaceFolderNames: ['example-workspace'],
      knownProjects: [],
    },
    {
      exists: async (filePath) => detectedPaths.has(filePath),
      readText: async () => undefined,
    },
  );

  assert.deepEqual(
    decisions.map((decision) => [decision.workspaceFolderName, decision.outcome, decision.reason]),
    [
      ['example-workspace', 'skipped', 'excluded by sphinxDoctor.discovery.excludeWorkspaceFolders'],
      ['02-keripy', 'discovered', 'high-confidence marker: docs/conf.py'],
      ['03-hio', 'discovered', 'high-confidence marker: docs/source/conf.py'],
      ['08-watcher-hk', 'skipped', 'no high-confidence Sphinx conf.py marker found'],
      ['09-fortweb', 'skipped', 'no high-confidence Sphinx conf.py marker found'],
    ],
  );
});

test('detected projects still include a source mirror latest.json target for artifact watching', () => {
  const project = detectProjectFromSnapshot(
    { name: '02-keripy', fsPath: '/workspace/keripy' },
    {
      existingPaths: new Set(['docs/conf.py']),
      fileContents: {},
    },
    {
      includeLowConfidence: false,
      inventoryWorkspaceFolderNames: ['example-workspace'],
      excludeWorkspaceFolderNames: [],
      availableWorkspaceFolderNames: ['example-workspace', '02-keripy'],
    },
  );

  assert.equal(
    project?.inventorySearchTargets?.some(
      (target) =>
        target.workspaceFolderName === '02-keripy' &&
        target.globs.includes('.sphinx-diagnostics/latest.json'),
    ),
    true,
  );
});

test('mergeProjects keeps explicit projects and suppresses discovered duplicates by source folder', () => {
  const merged = mergeProjects(
    [configuredProject],
    [
      {
        ...configuredProject,
        id: 'discovered-keripy',
        discoveryConfidence: 'high',
        discoveryReasons: ['high-confidence marker: docs/conf.py'],
        origin: 'discovered',
      },
      {
        ...configuredProject,
        id: 'hio',
        sourceWorkspaceFolder: '03-hio',
        inventoryWorkspaceFolder: 'example-workspace',
        discoveryConfidence: 'high',
        discoveryReasons: ['high-confidence marker: docs/source/conf.py'],
        origin: 'discovered',
      },
    ],
  );

  assert.equal(merged.length, 2);
  assert.equal(merged[0].origin, 'configured');
  assert.equal(merged[1].sourceWorkspaceFolder, '03-hio');
});

test('buildDiscoveryProbePaths stays bounded to relative workspace paths', () => {
  assert.equal(
    buildDiscoveryProbePaths().every((entry) => !entry.startsWith('/') && !entry.startsWith('..')),
    true,
  );
});

test('parseGitWorktreeListPorcelain parses porcelain worktree entries', () => {
  const entries = parseGitWorktreeListPorcelain([
    'worktree /workspace/notes/libs/keripy',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree /workspace/notes/libs/keripy-docstring-koming-001',
    'HEAD def456',
    'branch refs/heads/chore/docstrings-koming',
    '',
  ].join('\n'));

  assert.deepEqual(entries, [
    {
      worktreePath: '/workspace/notes/libs/keripy',
      head: 'abc123',
      branch: 'refs/heads/main',
    },
    {
      worktreePath: '/workspace/notes/libs/keripy-docstring-koming-001',
      head: 'def456',
      branch: 'refs/heads/chore/docstrings-koming',
    },
  ]);
});

test('discoverWorkspaceProjectDecisions discovers a synthetic worktree project for a known canonical project', async () => {
  const decisions = await discoverWorkspaceProjectDecisions(
    [
      { name: 'example-workspace', fsPath: '/workspace/notes' },
      { name: '02-keripy', fsPath: '/workspace/notes/libs/keripy' },
    ],
    {
      includeLowConfidence: false,
      inventoryWorkspaceFolderNames: ['example-workspace'],
      excludeWorkspaceFolderNames: ['example-workspace'],
      knownProjects: [configuredProject],
    },
    {
      exists: async (filePath) => filePath === '/workspace/notes/libs/keripy-docstring-koming-001/docs/conf.py',
      readText: async () => undefined,
      listGitWorktrees: async () => [
        'worktree /workspace/notes/libs/keripy',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
        'worktree /workspace/notes/libs/keripy-docstring-koming-001',
        'HEAD def456',
        'branch refs/heads/chore/docstrings-koming',
        '',
      ].join('\n'),
    },
  );

  const worktreeProject = decisions.find((decision) => decision.project?.id === 'keripy@keripy-docstring-koming-001')?.project;
  assert.ok(worktreeProject);
  assert.equal(worktreeProject?.baseProjectId, 'keripy');
  assert.equal(worktreeProject?.label, 'keripy-docstring-koming-001');
  assert.equal(worktreeProject?.sourceRootPath, '/workspace/notes/libs/keripy-docstring-koming-001');
  assert.equal(worktreeProject?.sourceWorkspaceFolder, 'keripy-docstring-koming-001');
});

test('discoverWorkspaceProjectDecisions skips the canonical worktree root duplicate', async () => {
  const decisions = await discoverWorkspaceProjectDecisions(
    [
      { name: 'example-workspace', fsPath: '/workspace/notes' },
      { name: '02-keripy', fsPath: '/workspace/notes/libs/keripy' },
    ],
    {
      includeLowConfidence: false,
      inventoryWorkspaceFolderNames: ['example-workspace'],
      excludeWorkspaceFolderNames: ['example-workspace'],
      knownProjects: [configuredProject],
    },
    {
      exists: async () => true,
      readText: async () => undefined,
      listGitWorktrees: async () => [
        'worktree /workspace/notes/libs/keripy',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
      ].join('\n'),
    },
  );

  assert.equal(decisions.some((decision) => decision.project?.id === 'keripy@keripy'), false);
});

test('discoverWorkspaceProjectDecisions ignores worktrees without Sphinx markers', async () => {
  const decisions = await discoverWorkspaceProjectDecisions(
    [
      { name: 'example-workspace', fsPath: '/workspace/notes' },
      { name: '02-keripy', fsPath: '/workspace/notes/libs/keripy' },
    ],
    {
      includeLowConfidence: false,
      inventoryWorkspaceFolderNames: ['example-workspace'],
      excludeWorkspaceFolderNames: ['example-workspace'],
      knownProjects: [configuredProject],
    },
    {
      exists: async () => false,
      readText: async () => undefined,
      listGitWorktrees: async () => [
        'worktree /workspace/notes/libs/keripy-docstring-koming-001',
        'HEAD def456',
        'branch refs/heads/chore/docstrings-koming',
        '',
      ].join('\n'),
    },
  );

  assert.equal(decisions.some((decision) => decision.project?.baseProjectId === 'keripy'), false);
});

test('discoverWorkspaceProjectDecisions rejects worktree paths outside the trusted workspace root', async () => {
  const decisions = await discoverWorkspaceProjectDecisions(
    [
      { name: 'example-workspace', fsPath: '/workspace/notes' },
      { name: '02-keripy', fsPath: '/workspace/notes/libs/keripy' },
    ],
    {
      includeLowConfidence: false,
      inventoryWorkspaceFolderNames: ['example-workspace'],
      excludeWorkspaceFolderNames: ['example-workspace'],
      knownProjects: [configuredProject],
    },
    {
      exists: async () => true,
      readText: async () => undefined,
      listGitWorktrees: async () => [
        'worktree /tmp/keripy-docstring-koming-001',
        'HEAD def456',
        'branch refs/heads/chore/docstrings-koming',
        '',
      ].join('\n'),
    },
  );

  assert.equal(decisions.some((decision) => decision.project?.id === 'keripy@keripy-docstring-koming-001'), false);
});

test('mergeProjects keeps base and worktree projects distinct by project id', () => {
  const merged = mergeProjects(
    [configuredProject],
    [
      {
        ...configuredProject,
        id: 'keripy@keripy-docstring-koming-001',
        baseProjectId: 'keripy',
        label: 'keripy-docstring-koming-001',
        sourceWorkspaceFolder: 'keripy-docstring-koming-001',
        sourceRootPath: '/workspace/notes/libs/keripy-docstring-koming-001',
        origin: 'discovered',
      },
    ],
  );

  assert.deepEqual(merged.map((project) => project.id), ['keripy', 'keripy@keripy-docstring-koming-001']);
});
