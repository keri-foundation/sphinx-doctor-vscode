import path from 'node:path';

import {
  ConfiguredProject,
  DiscoveryConfidence,
  InventorySearchTarget,
  WorkspaceFolderInfo,
} from './types';

export interface DiscoverySnapshot {
  existingPaths: Set<string>;
  fileContents: Record<string, string>;
}

export interface DiscoveryOptions {
  includeLowConfidence: boolean;
  inventoryWorkspaceFolderNames: string[];
  excludeWorkspaceFolderNames: string[];
  availableWorkspaceFolderNames: string[];
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
}

const HIGH_CONFIDENCE_MARKERS = [
  'docs/conf.py',
  'docs/source/conf.py',
  'doc/conf.py',
  'source/conf.py',
  'conf.py',
];

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
      continue;
    }
    merged.push(project);
  }

  return merged;
}