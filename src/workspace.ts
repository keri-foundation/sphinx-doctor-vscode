import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ConfiguredProject,
  DiagnosticsContract,
  DiagnosticsIssue,
  InventoryCandidate,
  InventorySelectionResult,
  ResolutionResult,
  WorkspaceFolderInfo,
} from './types';

export interface ResolveIssuePathOptions {
  workspaceFolders: WorkspaceFolderInfo[];
  defaultSourceWorkspaceFolder?: string;
  defaultRepoRoot?: string;
  fixtureSourceRoot?: string;
  allowFirstFolderFallback?: boolean;
}

export function findWorkspaceFolderByName(
  workspaceFolders: WorkspaceFolderInfo[],
  folderName: string | undefined,
): WorkspaceFolderInfo | undefined {
  if (!folderName) {
    return undefined;
  }

  return workspaceFolders.find((folder) => folder.name === folderName);
}

export function resolveProjectSourceRoot(
  project: Pick<ConfiguredProject, 'sourceRootPath' | 'sourceWorkspaceFolder' | 'repoRoot'>,
  workspaceFolders: WorkspaceFolderInfo[],
): string | undefined {
  if (typeof project.sourceRootPath === 'string' && path.isAbsolute(project.sourceRootPath)) {
    return path.resolve(project.sourceRootPath);
  }

  const sourceFolder = findWorkspaceFolderByName(workspaceFolders, project.sourceWorkspaceFolder);
  if (!sourceFolder) {
    return undefined;
  }

  return path.resolve(sourceFolder.fsPath, project.repoRoot ?? '.');
}

function directFileUriPath(issue: DiagnosticsIssue): string | undefined {
  const value = typeof issue.fileUri === 'string' ? issue.fileUri : typeof issue.uri === 'string' ? issue.uri : undefined;
  if (!value || !value.startsWith('file:')) {
    return undefined;
  }

  try {
    return fileURLToPath(value);
  } catch {
    return undefined;
  }
}

export function resolveIssueFilePath(
  contract: DiagnosticsContract,
  issue: DiagnosticsIssue,
  options: ResolveIssuePathOptions,
): ResolutionResult {
  const uriPath = directFileUriPath(issue);
  if (uriPath) {
    return {
      filePath: uriPath,
      strategy: 'file-uri',
    };
  }

  if (typeof issue.absolutePath === 'string' && path.isAbsolute(issue.absolutePath)) {
    return {
      filePath: issue.absolutePath,
      strategy: 'absolute-path',
    };
  }

  const repoRelativePath = issue.repoRelativePath;
  if (!repoRelativePath) {
    return {
      strategy: 'unresolved',
      reason: 'Issue is missing repoRelativePath.',
    };
  }

  const repoRoot = contract.workspace.repoRoot ?? options.defaultRepoRoot ?? '.';
  const namedFolder = findWorkspaceFolderByName(
    options.workspaceFolders,
    issue.sourceWorkspaceFolder || contract.workspace.sourceWorkspaceFolder,
  );
  if (namedFolder) {
    return {
      filePath: path.resolve(namedFolder.fsPath, repoRoot, repoRelativePath),
      strategy: 'source-workspace-folder',
    };
  }

  const defaultFolder = findWorkspaceFolderByName(
    options.workspaceFolders,
    options.defaultSourceWorkspaceFolder,
  );
  if (defaultFolder) {
    return {
      filePath: path.resolve(defaultFolder.fsPath, repoRoot, repoRelativePath),
      strategy: 'default-source-workspace-folder',
    };
  }

  if (options.fixtureSourceRoot) {
    return {
      filePath: path.resolve(options.fixtureSourceRoot, repoRelativePath),
      strategy: 'fixture-source-root',
    };
  }

  if (options.allowFirstFolderFallback && options.workspaceFolders.length > 0) {
    return {
      filePath: path.resolve(options.workspaceFolders[0].fsPath, repoRoot, repoRelativePath),
      strategy: 'first-workspace-folder-fallback',
      reason: 'No named workspace folder resolved, so the first workspace folder was used as a demo fallback.',
    };
  }

  return {
    strategy: 'unresolved',
    reason: 'No absolute path, file URI, or workspace-folder-based resolution succeeded.',
  };
}

function inventoryPreferenceRank(fileName: string, preferredInventoryFiles: string[]): number {
  const index = preferredInventoryFiles.indexOf(fileName);
  return index === -1 ? preferredInventoryFiles.length : index;
}

function sortCandidatesInDirectory<T extends InventoryCandidate>(
  candidates: T[],
  preferredInventoryFiles: string[],
): T[] {
  return [...candidates].sort((left, right) => {
    const preferenceDelta =
      inventoryPreferenceRank(left.fileName, preferredInventoryFiles) -
      inventoryPreferenceRank(right.fileName, preferredInventoryFiles);
    if (preferenceDelta !== 0) {
      return preferenceDelta;
    }

    const modifiedDelta = right.modifiedTime - left.modifiedTime;
    if (modifiedDelta !== 0) {
      return modifiedDelta;
    }

    return left.fileName.localeCompare(right.fileName);
  });
}

export function orderInventoryCandidates<T extends InventoryCandidate>(
  candidates: T[],
  preferredInventoryFiles: string[],
): T[] {
  const candidatesByDirectory = new Map<string, T[]>();
  for (const candidate of candidates) {
    const current = candidatesByDirectory.get(candidate.directoryPath);
    if (current) {
      current.push(candidate);
    } else {
      candidatesByDirectory.set(candidate.directoryPath, [candidate]);
    }
  }

  return [...candidatesByDirectory.values()]
    .sort((left, right) => {
      const leftNewest = Math.max(...left.map((candidate) => candidate.modifiedTime));
      const rightNewest = Math.max(...right.map((candidate) => candidate.modifiedTime));
      return rightNewest - leftNewest;
    })
    .flatMap((group) => sortCandidatesInDirectory(group, preferredInventoryFiles));
}

export function pickInventoryCandidate<T extends InventoryCandidate>(
  candidates: T[],
  preferredInventoryFiles: string[],
): T | undefined {
  return orderInventoryCandidates(candidates, preferredInventoryFiles)[0];
}

export function isRawInventoryFile(fileName: string): boolean {
  return fileName === 'issues.json';
}

function inventoryMatchTokens(project: Pick<ConfiguredProject, 'id' | 'label' | 'sourceWorkspaceFolder'>): string[] {
  return [...new Set([project.id, project.label, project.sourceWorkspaceFolder]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.toLowerCase().split(/[^a-z0-9]+/))
    .filter((token) => token.length >= 3))];
}

function inventoryMatchScore(
  project: Pick<ConfiguredProject, 'id' | 'label' | 'sourceWorkspaceFolder'>,
  candidate: InventoryCandidate,
): number {
  const haystack = `${candidate.directoryPath}/${candidate.fileName}`.toLowerCase();
  return inventoryMatchTokens(project).reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function candidateComparisonKey(
  project: Pick<ConfiguredProject, 'id' | 'label' | 'sourceWorkspaceFolder'>,
  candidate: InventoryCandidate,
  preferredInventoryFiles: string[],
): [number, number, number] {
  return [
    inventoryMatchScore(project, candidate),
    candidate.modifiedTime,
    -inventoryPreferenceRank(candidate.fileName, preferredInventoryFiles),
  ];
}

export function selectInventoryCandidate<T extends InventoryCandidate>(
  project: Pick<ConfiguredProject, 'id' | 'label' | 'sourceWorkspaceFolder'>,
  candidates: T[],
  preferredInventoryFiles: string[],
): InventorySelectionResult<T> {
  const ordered = [...candidates].sort((left, right) => {
    const leftScore = inventoryMatchScore(project, left);
    const rightScore = inventoryMatchScore(project, right);
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }

    const modifiedDelta = right.modifiedTime - left.modifiedTime;
    if (modifiedDelta !== 0) {
      return modifiedDelta;
    }

    const preferenceDelta =
      inventoryPreferenceRank(left.fileName, preferredInventoryFiles) -
      inventoryPreferenceRank(right.fileName, preferredInventoryFiles);
    if (preferenceDelta !== 0) {
      return preferenceDelta;
    }

    return left.filePath.localeCompare(right.filePath);
  });

  const first = ordered[0];
  if (!first) {
    return {};
  }

  const firstKey = candidateComparisonKey(project, first, preferredInventoryFiles).join(':');
  const ambiguous = ordered.filter(
    (candidate) => candidateComparisonKey(project, candidate, preferredInventoryFiles).join(':') === firstKey,
  );
  if (ambiguous.length > 1) {
    return { ambiguous };
  }

  return { selected: first };
}