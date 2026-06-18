import path from 'node:path';

import * as vscode from 'vscode';

import {
  buildProjectQuickPickItems,
  getExtensionConfig,
  projectLabel,
  projectSelectionMode,
} from '../config/extensionConfig';
import {
  DiagnosticsFileKind,
  inspectDiagnosticsFileBinding,
  inspectDiagnosticsFile,
  isDiagnosticsBindingCompatible,
} from '../diagnostics/loadDiagnostics';
import { SphinxDoctorLogger } from '../logging/extensionLogger';
import { filterRecentInventoryCandidates } from '../refresh/refreshRunner';
import { ConfiguredProject, WorkspaceFolderInfo } from '../types';
import {
  findWorkspaceFolderByName,
  selectInventoryCandidate,
} from '../workspace/inventoryCandidates';
import {
  discoverWorkspaceProjectDecisions,
  listGitWorktreesPorcelain,
  mergeProjects,
} from '../workspace/projectDiscovery';

export interface DiscoveredInventoryCandidate {
  uri: vscode.Uri;
  filePath: string;
  fileName: string;
  directoryPath: string;
  modifiedTime: number;
  workspaceFolderName: string;
}

export interface DiagnosticsSearchTarget {
  workspaceFolderName: string;
  globs: string[];
}

export interface SelectedProjectDiagnostics {
  project: ConfiguredProject;
  candidate: DiscoveredInventoryCandidate;
  kind: DiagnosticsFileKind;
}

function logDiscoveryDecisions(
  logger: SphinxDoctorLogger,
  decisions: Array<{
    workspaceFolderName: string;
    outcome: 'discovered' | 'skipped';
    reason: string;
  }>,
): void {
  for (const decision of decisions) {
    const prefix = decision.outcome === 'discovered' ? 'Discovery include' : 'Discovery skip';
    logger.info(`${prefix} ${decision.workspaceFolderName}: ${decision.reason}.`);
  }
}

export function toWorkspaceFolderInfo(
  workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined,
): WorkspaceFolderInfo[] {
  return (workspaceFolders ?? []).map((folder) => ({
    name: folder.name,
    fsPath: folder.uri.fsPath,
  }));
}

async function selectProject(projects: ConfiguredProject[]): Promise<ConfiguredProject | undefined> {
  const mode = projectSelectionMode(projects);
  if (mode === 'none') {
    return undefined;
  }

  if (mode === 'single') {
    return projects[0];
  }

  const selected = await vscode.window.showQuickPick(buildProjectQuickPickItems(projects), {
    placeHolder: 'Select a Sphinx Doctor project to load diagnostics for',
    matchOnDescription: true,
    matchOnDetail: true,
  });

  return selected?.project;
}

async function selectInventoryCandidateInteractively(
  project: ConfiguredProject,
  candidates: DiscoveredInventoryCandidate[],
  logger: SphinxDoctorLogger,
): Promise<DiscoveredInventoryCandidate | undefined> {
  const selection = selectInventoryCandidate(project, candidates, project.preferredInventoryFiles);
  if (selection.selected) {
    return selection.selected;
  }

  if (!selection.ambiguous || selection.ambiguous.length === 0) {
    return undefined;
  }

  logger.warn(
    `Inventory discovery for ${project.id} is ambiguous across ${selection.ambiguous.length} candidates; asking the user to choose.`,
  );

  const picked = await vscode.window.showQuickPick(
    selection.ambiguous.map((candidate) => ({
      label: candidate.fileName,
      description: candidate.workspaceFolderName,
      detail: candidate.filePath,
      candidate,
    })),
    {
      placeHolder: `Select diagnostics artifact for ${projectLabel(project)}`,
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );

  return picked?.candidate;
}

function inventorySearchTargets(project: ConfiguredProject): DiagnosticsSearchTarget[] {
  return project.inventorySearchTargets && project.inventorySearchTargets.length > 0
    ? project.inventorySearchTargets
    : [
        {
          workspaceFolderName: project.inventoryWorkspaceFolder,
          globs: project.inventorySearchGlobs,
        },
      ];
}

async function discoverDiagnosticsCandidates(
  searchTargets: DiagnosticsSearchTarget[],
  fallbackWorkspaceFolderName: string,
): Promise<DiscoveredInventoryCandidate[]> {
  const workspaceFolders = toWorkspaceFolderInfo(vscode.workspace.workspaceFolders);

  const foundUris = new Map<string, vscode.Uri>();
  const uriOrigins = new Map<string, string>();
  for (const searchTarget of searchTargets) {
    const inventoryFolder = findWorkspaceFolderByName(workspaceFolders, searchTarget.workspaceFolderName);
    if (!inventoryFolder) {
      continue;
    }

    for (const inventorySearchGlob of searchTarget.globs) {
      const relativePattern = new vscode.RelativePattern(inventoryFolder.fsPath, inventorySearchGlob);
      const matches = await vscode.workspace.findFiles(relativePattern);
      for (const match of matches) {
        foundUris.set(match.toString(), match);
        uriOrigins.set(match.toString(), searchTarget.workspaceFolderName);
      }
    }
  }

  const candidates: DiscoveredInventoryCandidate[] = [];
  for (const uri of foundUris.values()) {
    const stat = await vscode.workspace.fs.stat(uri);
    candidates.push({
      uri,
      filePath: uri.fsPath,
      fileName: path.basename(uri.fsPath),
      directoryPath: path.dirname(uri.fsPath),
      modifiedTime: stat.mtime,
      workspaceFolderName: uriOrigins.get(uri.toString()) ?? fallbackWorkspaceFolderName,
    });
  }

  return candidates;
}

function projectSourceRoot(
  project: ConfiguredProject,
  workspaceFolders: WorkspaceFolderInfo[],
): string | undefined {
  const sourceFolder = findWorkspaceFolderByName(workspaceFolders, project.sourceWorkspaceFolder);
  if (!sourceFolder) {
    return undefined;
  }

  return path.resolve(sourceFolder.fsPath, project.repoRoot ?? '.');
}

async function filterCompatibleCandidates(
  project: ConfiguredProject,
  candidates: DiscoveredInventoryCandidate[],
  workspaceFolders: WorkspaceFolderInfo[],
  logger: SphinxDoctorLogger,
): Promise<DiscoveredInventoryCandidate[]> {
  const sourceRoot = projectSourceRoot(project, workspaceFolders);
  if (!sourceRoot) {
    logger.warn(
      `Source workspace folder ${project.sourceWorkspaceFolder} could not be resolved for ${project.id}; no shared inventory candidate will be bound automatically.`,
    );
    return [];
  }

  const compatible: DiscoveredInventoryCandidate[] = [];
  for (const candidate of candidates) {
    const binding = await inspectDiagnosticsFileBinding(candidate.filePath);
    const compatibility = isDiagnosticsBindingCompatible(binding, {
      sourceWorkspaceFolder: project.sourceWorkspaceFolder,
      sourceRoot,
    });
    if (!compatibility.compatible) {
      logger.warn(
        `Skipping inventory candidate for ${project.id}: ${candidate.filePath}. ${compatibility.reason ?? 'Binding mismatch.'}`,
      );
      continue;
    }
    compatible.push(candidate);
  }

  return compatible;
}

export async function resolveProjectDiagnosticsFileFromSearchTargets(
  project: ConfiguredProject,
  logger: SphinxDoctorLogger,
  searchTargets: DiagnosticsSearchTarget[],
  emptyMessage: string,
  minimumModifiedTime?: number,
): Promise<SelectedProjectDiagnostics | undefined> {
  const workspaceFolders = toWorkspaceFolderInfo(vscode.workspace.workspaceFolders);
  const discovered = await discoverDiagnosticsCandidates(searchTargets, project.inventoryWorkspaceFolder);
  const freshCandidates =
    minimumModifiedTime === undefined
      ? discovered
      : filterRecentInventoryCandidates(discovered, minimumModifiedTime);
  if (
    minimumModifiedTime !== undefined &&
    discovered.length > 0 &&
    freshCandidates.length === 0
  ) {
    logger.warn(
      `Ignoring ${discovered.length} stale diagnostics candidates for ${project.id} because they predate the current refresh run.`,
    );
  }
  const candidates = await filterCompatibleCandidates(project, freshCandidates, workspaceFolders, logger);
  if (candidates.length === 0) {
    void vscode.window.showWarningMessage(emptyMessage);
    return undefined;
  }

  const selected = await selectInventoryCandidateInteractively(project, candidates, logger);
  if (!selected) {
    void vscode.window.showWarningMessage(
      `Sphinx Doctor found inventory candidates for ${projectLabel(project)} but could not choose one.`,
    );
    return undefined;
  }

  logger.info(
    `Selected project ${project.id} from ${project.sourceWorkspaceFolder}; inventory root ${selected.workspaceFolderName}; picked ${selected.filePath}.`,
  );

  const kind = await inspectDiagnosticsFile(selected.filePath);
  logger.info(`Detected ${kind} diagnostics file for ${project.id}: ${selected.filePath}.`);

  return {
    project,
    candidate: selected,
    kind,
  };
}

export async function resolveProjectDiagnosticsFile(
  project: ConfiguredProject,
  logger: SphinxDoctorLogger,
): Promise<SelectedProjectDiagnostics | undefined> {
  return resolveProjectDiagnosticsFileFromSearchTargets(
    project,
    logger,
    inventorySearchTargets(project),
    `No compatible diagnostics files matched the configured search targets for ${projectLabel(project)}.`,
  );
}

export async function selectConfiguredProject(
  logger: SphinxDoctorLogger,
): Promise<ConfiguredProject | undefined> {
  const config = getExtensionConfig();
  logger.setLevel(config.logLevel);

  if (config.projects.length === 0) {
    void vscode.window.showWarningMessage(
      'No Sphinx Doctor projects are configured. Add sphinxDoctor.projects to workspace settings and run the command again.',
    );
    return undefined;
  }

  return selectProject(config.projects);
}

async function projectDiscoveryProbeExists(filePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    return true;
  } catch {
    return false;
  }
}

async function projectDiscoveryProbeReadText(filePath: string): Promise<string | undefined> {
  try {
    const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
    return Buffer.from(content).toString('utf8');
  } catch {
    return undefined;
  }
}

async function discoverProjectsFromWorkspace(
  logger: SphinxDoctorLogger,
): Promise<ConfiguredProject[]> {
  const config = getExtensionConfig();
  logger.setLevel(config.logLevel);

  if (!config.discoveryEnabled) {
    return [];
  }

  const workspaceFolders = toWorkspaceFolderInfo(vscode.workspace.workspaceFolders);
  const decisions = await discoverWorkspaceProjectDecisions(
    workspaceFolders,
    {
      includeLowConfidence: config.discoveryIncludeLowConfidence,
      inventoryWorkspaceFolderNames: config.discoveryInventoryWorkspaceFolderNames,
      excludeWorkspaceFolderNames: config.discoveryExcludeWorkspaceFolders,
      knownProjects: config.projects,
    },
    {
      exists: projectDiscoveryProbeExists,
      readText: projectDiscoveryProbeReadText,
      listGitWorktrees:
        vscode.workspace.isTrusted === true ? listGitWorktreesPorcelain : undefined,
    },
  );

  logDiscoveryDecisions(logger, decisions);
  return decisions.flatMap((decision) => (decision.project ? [decision.project] : []));
}

export async function selectMergedProject(
  logger: SphinxDoctorLogger,
): Promise<ConfiguredProject | undefined> {
  const config = getExtensionConfig();
  logger.setLevel(config.logLevel);

  const discoveredProjects = await discoverProjectsFromWorkspace(logger);
  const mergedProjects = mergeProjects(config.projects, discoveredProjects);
  if (mergedProjects.length === 0) {
    void vscode.window.showWarningMessage(
      'Sphinx Doctor did not find any configured or discoverable workspace projects.',
    );
    return undefined;
  }

  return selectProject(mergedProjects);
}

export async function discoverOnlyProject(
  logger: SphinxDoctorLogger,
): Promise<ConfiguredProject | undefined> {
  const discoveredProjects = await discoverProjectsFromWorkspace(logger);
  if (discoveredProjects.length === 0) {
    void vscode.window.showWarningMessage(
      'Sphinx Doctor did not discover any Sphinx-capable workspace folders with high-confidence conf.py markers.',
    );
    return undefined;
  }

  return selectProject(discoveredProjects);
}
