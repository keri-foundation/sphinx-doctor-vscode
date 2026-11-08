import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  ConfiguredProject,
  DiscoveryConfidence,
  InventorySearchTarget,
  WorkspaceFolderInfo,
} from '../types';
import { resolveProjectSourceRoot } from './inventoryCandidates';

export interface DiscoverySnapshot {
  existingPaths: Set<string>;
  fileContents: Record<string, string>;
}

export interface DiscoveryOptions {
  includeLowConfidence: boolean;
  inventoryWorkspaceFolderNames: string[];
  excludeWorkspaceFolderNames: string[];
  availableWorkspaceFolderNames: string[];
  knownProjects?: ConfiguredProject[];
}

export interface DiscoveryDecision {
  workspaceFolderName: string;
  outcome: 'discovered' | 'skipped';
  reason: string;
  project?: ConfiguredProject;
}

export interface DiscoveryProbe {
  exists(filePath: string): Promise<boolean>;
  readText(filePath: string): Promise<string | undefined>;
  listGitWorktrees?(repoRoot: string): Promise<string | undefined>;
}

export interface GitWorktreeEntry {
  worktreePath: string;
  head?: string;
  branch?: string;
}

const execFileAsync = promisify(execFile);

const HIGH_CONFIDENCE_MARKERS = [
  'docs/conf.py',
  'docs/source/conf.py',
  'doc/conf.py',
  'source/conf.py',
  'conf.py',
];

const GIT_WORKTREE_MARKERS = ['docs/conf.py', 'docs/source/conf.py'];

export function buildDiscoveryProbePaths(): string[] {
  return [...HIGH_CONFIDENCE_MARKERS];
}

function docsRootFromMarker(marker: string): string {
  if (marker === 'conf.py') {
    return '.';
  }

  return marker.split('/')[0];
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function labelFromWorkspaceFolderName(name: string): string {
  return name.replace(/^\d+-/, '');
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function normalizeAbsolutePath(value: string): string {
  return path.resolve(value);
}

function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  const normalizedCandidate = normalizeAbsolutePath(candidatePath);
  const normalizedRoot = normalizeAbsolutePath(rootPath);

  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`)
  );
}

function buildTmpInventoryGlobs(projectId: string, sourceBasename: string): string[] {
  const prefixes = uniqueStrings([projectId, sourceBasename]);
  const globs: string[] = [];
  for (const prefix of prefixes) {
    globs.push(`tmp/sphinx-inventory-${prefix}-*/report/issues.vscode.json`);
    globs.push(`tmp/sphinx-inventory-${prefix}-*/report/issues.json`);
  }
  return globs;
}

function buildInventorySearchTargets(
  folder: WorkspaceFolderInfo,
  projectId: string,
  options: DiscoveryOptions,
  mirrorRoot: string,
): InventorySearchTarget[] {
  const sourceBasename = slugify(path.basename(folder.fsPath));
  const mirrorGlobs = [
    path.posix.join(mirrorRoot, 'latest.json'),
    path.posix.join(mirrorRoot, 'runs', '*', 'enriched.json'),
  ];
  const targets: InventorySearchTarget[] = [
    {
      workspaceFolderName: folder.name,
      globs: mirrorGlobs,
      reason: 'source mirror root',
    },
  ];

  const tmpGlobs = buildTmpInventoryGlobs(projectId, sourceBasename);
  for (const inventoryWorkspaceFolderName of options.inventoryWorkspaceFolderNames) {
    if (
      inventoryWorkspaceFolderName !== folder.name &&
      options.availableWorkspaceFolderNames.includes(inventoryWorkspaceFolderName)
    ) {
      targets.push({
        workspaceFolderName: inventoryWorkspaceFolderName,
        globs: tmpGlobs,
        reason: 'shared inventory tmp root',
      });
    }
  }

  return targets;
}

function buildDiscoveredProject(
  folder: WorkspaceFolderInfo,
  confidence: DiscoveryConfidence,
  docsRoot: string,
  reasons: string[],
  options: DiscoveryOptions,
): ConfiguredProject {
  const sourceBasename = slugify(path.basename(folder.fsPath));
  const projectId = sourceBasename || slugify(labelFromWorkspaceFolderName(folder.name));
  const mirrorRoot = '.sphinx-diagnostics';
  const inventorySearchTargets = buildInventorySearchTargets(folder, projectId, options, mirrorRoot);
  const primaryInventoryTarget = inventorySearchTargets.find(
    (target) => target.workspaceFolderName !== folder.name,
  ) ?? inventorySearchTargets[0];

  return {
    id: projectId,
    label: labelFromWorkspaceFolderName(folder.name),
    sourceWorkspaceFolder: folder.name,
    sourceRootPath: path.resolve(folder.fsPath),
    inventoryWorkspaceFolder: primaryInventoryTarget.workspaceFolderName,
    repoRoot: '.',
    docsRoot,
    inventorySearchGlobs: inventorySearchTargets.flatMap((target) => target.globs),
    preferredInventoryFiles: ['issues.vscode.json', 'issues.json'],
    mirrorRoot,
    inventorySearchTargets,
    discoveryConfidence: confidence,
    discoveryReasons: reasons,
    origin: 'discovered',
  };
}

function preferredInventoryWorkspaceFolderName(
  project: ConfiguredProject,
  options: DiscoveryOptions,
): string {
  if (options.availableWorkspaceFolderNames.includes(project.inventoryWorkspaceFolder)) {
    return project.inventoryWorkspaceFolder;
  }

  return options.inventoryWorkspaceFolderNames.find((name) =>
    options.availableWorkspaceFolderNames.includes(name),
  ) ?? project.inventoryWorkspaceFolder;
}

function buildSyntheticWorktreeProject(
  baseProject: ConfiguredProject,
  worktreePath: string,
  marker: string,
  options: DiscoveryOptions,
): ConfiguredProject {
  const worktreeName = path.basename(worktreePath);
  const projectId = `${baseProject.id}@${worktreeName}`;
  const inventoryWorkspaceFolder = preferredInventoryWorkspaceFolderName(baseProject, options);

  return {
    id: projectId,
    baseProjectId: baseProject.id,
    label: worktreeName,
    sourceWorkspaceFolder: worktreeName,
    sourceRootPath: normalizeAbsolutePath(worktreePath),
    inventoryWorkspaceFolder,
    repoRoot: '.',
    docsRoot: docsRootFromMarker(marker),
    inventorySearchGlobs: buildTmpInventoryGlobs(projectId, slugify(worktreeName)),
    preferredInventoryFiles: [...baseProject.preferredInventoryFiles],
    mirrorRoot: '.sphinx-diagnostics',
    inventorySearchTargets: [
      {
        workspaceFolderName: inventoryWorkspaceFolder,
        globs: buildTmpInventoryGlobs(projectId, slugify(worktreeName)),
        reason: 'shared inventory tmp root',
      },
    ],
    discoveryConfidence: 'high',
    discoveryReasons: [
      `git worktree of ${baseProject.id}`,
      `high-confidence marker: ${marker}`,
    ],
    origin: 'discovered',
  };
}

function resolveTrustedWorkspaceRoot(
  workspaceFolders: WorkspaceFolderInfo[],
  options: DiscoveryOptions,
): string | undefined {
  for (const folderName of options.inventoryWorkspaceFolderNames) {
    const folder = workspaceFolders.find((candidate) => candidate.name === folderName);
    if (folder) {
      return normalizeAbsolutePath(folder.fsPath);
    }
  }

  return undefined;
}

async function discoverGitWorktreeProjects(
  baseProjects: ConfiguredProject[],
  workspaceFolders: WorkspaceFolderInfo[],
  options: DiscoveryOptions,
  probe: DiscoveryProbe,
): Promise<DiscoveryDecision[]> {
  if (!probe.listGitWorktrees) {
    return [];
  }

  const trustedWorkspaceRoot = resolveTrustedWorkspaceRoot(workspaceFolders, options);
  if (!trustedWorkspaceRoot) {
    return [];
  }

  const decisions: DiscoveryDecision[] = [];
  const seenProjectIds = new Set<string>();

  for (const baseProject of baseProjects) {
    const canonicalSourceRoot = resolveProjectSourceRoot(baseProject, workspaceFolders);
    if (!canonicalSourceRoot) {
      continue;
    }

    const listing = await probe.listGitWorktrees(canonicalSourceRoot);
    if (!listing) {
      continue;
    }

    for (const entry of parseGitWorktreeListPorcelain(listing)) {
      const worktreePath = normalizeAbsolutePath(entry.worktreePath);
      if (worktreePath === normalizeAbsolutePath(canonicalSourceRoot)) {
        continue;
      }

      if (!isWithinRoot(worktreePath, trustedWorkspaceRoot)) {
        continue;
      }

      let matchedMarker: string | undefined;
      for (const marker of GIT_WORKTREE_MARKERS) {
        if (await probe.exists(path.join(worktreePath, marker))) {
          matchedMarker = marker;
          break;
        }
      }

      if (!matchedMarker) {
        continue;
      }

      const project = buildSyntheticWorktreeProject(baseProject, worktreePath, matchedMarker, options);
      if (seenProjectIds.has(project.id)) {
        continue;
      }

      seenProjectIds.add(project.id);
      decisions.push({
        workspaceFolderName: path.basename(worktreePath),
        outcome: 'discovered',
        reason: (project.discoveryReasons ?? []).join('; '),
        project,
      });
    }
  }

  return decisions;
}

export function parseGitWorktreeListPorcelain(text: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.length === 0) {
      if (current?.worktreePath) {
        entries.push(current);
      }
      current = undefined;
      continue;
    }

    if (line.startsWith('worktree ')) {
      if (current?.worktreePath) {
        entries.push(current);
      }
      current = {
        worktreePath: line.slice('worktree '.length),
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
      continue;
    }

    if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    }
  }

  if (current?.worktreePath) {
    entries.push(current);
  }

  return entries;
}

export async function listGitWorktreesPorcelain(repoRoot: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout;
  } catch {
    return undefined;
  }
}

export function detectProjectFromSnapshot(
  folder: WorkspaceFolderInfo,
  snapshot: DiscoverySnapshot,
  options: DiscoveryOptions,
): ConfiguredProject | undefined {
  for (const marker of HIGH_CONFIDENCE_MARKERS) {
    if (snapshot.existingPaths.has(marker)) {
      return buildDiscoveredProject(
        folder,
        'high',
        docsRootFromMarker(marker),
        [`high-confidence marker: ${marker}`],
        options,
      );
    }
  }

  return undefined;
}

async function collectDiscoverySnapshot(
  folder: WorkspaceFolderInfo,
  probe: DiscoveryProbe,
): Promise<DiscoverySnapshot> {
  const existingPaths = new Set<string>();
  const fileContents: Record<string, string> = {};

  for (const relativePath of buildDiscoveryProbePaths()) {
    const absolutePath = path.join(folder.fsPath, relativePath);
    if (!(await probe.exists(absolutePath))) {
      continue;
    }

    existingPaths.add(relativePath);
  }

  return { existingPaths, fileContents };
}

export async function discoverWorkspaceProjectDecisions(
  workspaceFolders: WorkspaceFolderInfo[],
  options: Omit<DiscoveryOptions, 'availableWorkspaceFolderNames'>,
  probe: DiscoveryProbe,
): Promise<DiscoveryDecision[]> {
  const mergedOptions: DiscoveryOptions = {
    ...options,
    availableWorkspaceFolderNames: workspaceFolders.map((folder) => folder.name),
  };

  const decisions: DiscoveryDecision[] = [];
  for (const folder of workspaceFolders) {
    if (mergedOptions.excludeWorkspaceFolderNames.includes(folder.name)) {
      decisions.push({
        workspaceFolderName: folder.name,
        outcome: 'skipped',
        reason: 'excluded by sphinxDoctor.discovery.excludeWorkspaceFolders',
      });
      continue;
    }

    const snapshot = await collectDiscoverySnapshot(folder, probe);
    const project = detectProjectFromSnapshot(folder, snapshot, mergedOptions);
    if (project) {
      decisions.push({
        workspaceFolderName: folder.name,
        outcome: 'discovered',
        reason: (project.discoveryReasons ?? []).join('; ') || 'high-confidence Sphinx conf.py marker found',
        project,
      });
      continue;
    }

    decisions.push({
      workspaceFolderName: folder.name,
      outcome: 'skipped',
      reason: 'no high-confidence Sphinx conf.py marker found',
    });
  }

  const discoveredCanonicalProjects = decisions.flatMap((decision) =>
    decision.project ? [decision.project] : [],
  );
  const knownProjects = mergeProjects(options.knownProjects ?? [], discoveredCanonicalProjects);
  const worktreeDecisions = await discoverGitWorktreeProjects(
    knownProjects,
    workspaceFolders,
    mergedOptions,
    probe,
  );

  decisions.push(...worktreeDecisions);

  return decisions;
}

export async function discoverWorkspaceProjects(
  workspaceFolders: WorkspaceFolderInfo[],
  options: Omit<DiscoveryOptions, 'availableWorkspaceFolderNames'>,
  probe: DiscoveryProbe,
): Promise<ConfiguredProject[]> {
  const decisions = await discoverWorkspaceProjectDecisions(workspaceFolders, options, probe);
  return decisions.flatMap((decision) => (decision.project ? [decision.project] : []));
}

export function mergeProjects(
  explicitProjects: ConfiguredProject[],
  discoveredProjects: ConfiguredProject[],
): ConfiguredProject[] {
  const merged: ConfiguredProject[] = explicitProjects.map((project) => ({
    ...project,
    origin: 'configured',
  }));
  const explicitIds = new Set(merged.map((project) => project.id));
  const explicitSourceFolders = new Set(merged.map((project) => project.sourceWorkspaceFolder));

  for (const project of discoveredProjects) {
    if (explicitIds.has(project.id) || explicitSourceFolders.has(project.sourceWorkspaceFolder)) {
      const duplicate = merged.find(
        (existing) =>
          existing.id === project.id || existing.sourceWorkspaceFolder === project.sourceWorkspaceFolder,
      );
      if (duplicate && !duplicate.sourceRootPath && project.sourceRootPath) {
        duplicate.sourceRootPath = project.sourceRootPath;
      }
      continue;
    }
    merged.push(project);
  }

  return merged;
}