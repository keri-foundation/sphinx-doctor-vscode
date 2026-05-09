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

export interface DiscoveryProbe {
  exists(filePath: string): Promise<boolean>;
  readText(filePath: string): Promise<string | undefined>;
}

const HIGH_CONFIDENCE_MARKERS = ['docs/conf.py', 'doc/conf.py', 'source/conf.py', 'conf.py'];
const MEDIUM_CONFIDENCE_EXISTENCE_MARKERS = [
  'docs/Makefile',
  'docs/make.bat',
  'requirements-docs.txt',
  'requirements/docs.txt',
];
const MEDIUM_CONFIDENCE_CONTENT_MARKERS = ['pyproject.toml', 'tox.ini', 'noxfile.py'];
const LOW_CONFIDENCE_MARKERS = ['docs', 'documentation'];

export function buildDiscoveryProbePaths(): string[] {
  return [
    ...HIGH_CONFIDENCE_MARKERS,
    ...MEDIUM_CONFIDENCE_EXISTENCE_MARKERS,
    ...MEDIUM_CONFIDENCE_CONTENT_MARKERS,
    ...LOW_CONFIDENCE_MARKERS,
  ];
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

  for (const marker of MEDIUM_CONFIDENCE_EXISTENCE_MARKERS) {
    if (snapshot.existingPaths.has(marker)) {
      return buildDiscoveredProject(
        folder,
        'medium',
        marker.startsWith('docs/') ? 'docs' : '.',
        [`medium-confidence marker: ${marker}`],
        options,
      );
    }
  }

  for (const marker of MEDIUM_CONFIDENCE_CONTENT_MARKERS) {
    const text = snapshot.fileContents[marker]?.toLowerCase();
    if (text && (text.includes('sphinx') || text.includes('sphinx-build'))) {
      return buildDiscoveredProject(
        folder,
        'medium',
        marker === 'pyproject.toml' ? 'docs' : '.',
        [`medium-confidence marker: ${marker} contains Sphinx tooling text`],
        options,
      );
    }
  }

  if (options.includeLowConfidence) {
    for (const marker of LOW_CONFIDENCE_MARKERS) {
      if (snapshot.existingPaths.has(marker)) {
        return buildDiscoveredProject(
          folder,
          'low',
          marker,
          [`low-confidence marker: ${marker}/`],
          options,
        );
      }
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
    if (MEDIUM_CONFIDENCE_CONTENT_MARKERS.includes(relativePath)) {
      const text = await probe.readText(absolutePath);
      if (text !== undefined) {
        fileContents[relativePath] = text;
      }
    }
  }

  return { existingPaths, fileContents };
}

export async function discoverWorkspaceProjects(
  workspaceFolders: WorkspaceFolderInfo[],
  options: Omit<DiscoveryOptions, 'availableWorkspaceFolderNames'>,
  probe: DiscoveryProbe,
): Promise<ConfiguredProject[]> {
  const mergedOptions: DiscoveryOptions = {
    ...options,
    availableWorkspaceFolderNames: workspaceFolders.map((folder) => folder.name),
  };

  const discovered: ConfiguredProject[] = [];
  for (const folder of workspaceFolders) {
    if (mergedOptions.excludeWorkspaceFolderNames.includes(folder.name)) {
      continue;
    }

    const snapshot = await collectDiscoverySnapshot(folder, probe);
    const project = detectProjectFromSnapshot(folder, snapshot, mergedOptions);
    if (project) {
      discovered.push(project);
    }
  }

  return discovered;
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