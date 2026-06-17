import * as vscode from 'vscode';

import { SphinxDoctorLogger } from '../log';
import {
  buildDiagnosticMessage,
  DiagnosticMode,
  DiagnosticsContract,
  DiagnosticsIssue,
  issueMatchesDiagnosticMode,
  normalizeSeverityName,
  shouldPublishIssue,
  toZeroBasedPosition,
  WorkspaceFolderInfo,
} from '../types';
import { resolveIssueFilePath } from '../workspace';

export type PublishLogger = Pick<SphinxDoctorLogger, 'debug' | 'info' | 'warn' | 'error'>;

type PublishedTargetsByProject = Map<string, Map<string, vscode.Uri>>;

interface PublicationIndexLike {
  replaceAll(collection: vscode.DiagnosticCollection, nextTargetsByProject: PublishedTargetsByProject): void;
  replaceProjects(
    collection: vscode.DiagnosticCollection,
    projectKeys: Iterable<string>,
    nextTargetsByProject: PublishedTargetsByProject,
  ): void;
}

export interface PublishOptions {
  workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined;
  diagnosticMode: DiagnosticMode;
  replaceMode?: 'full' | 'project';
  projectKey?: string;
  publicationIndex?: PublicationIndexLike;
  defaultSourceWorkspaceFolder?: string;
  defaultRepoRoot?: string;
  fixtureSourceRoot?: string;
  allowFirstFolderFallback?: boolean;
  applyDiagnosticModeFilter?: boolean;
  logger: PublishLogger;
}

export type SkipReason =
  | 'not-publishable'
  | 'mode-filtered'
  | 'no-target-uri';

export interface PublishResult {
  issueCount: number;
  publishableBeforeFilter: number;
  publishedDiagnostics: number;
  filteredByMode: number;
  targetUriCount: number;
  skippedIssues: number;
  resolutionFailures: number;
  /** Counts of skipped issues grouped by skip reason. */
  skipReasons?: Record<SkipReason, number>;
}

export interface PublishBatchEntry {
  contract: DiagnosticsContract;
  projectKey?: string;
  defaultSourceWorkspaceFolder?: string;
  defaultRepoRoot?: string;
  fixtureSourceRoot?: string;
  allowFirstFolderFallback?: boolean;
}

interface CollectedDiagnostics {
  grouped: Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>;
  result: PublishResult;
}

function resolveProjectKey(entry: PublishBatchEntry): string | undefined {
  return entry.projectKey ?? entry.contract.workspace.sourceWorkspaceFolder ?? entry.defaultSourceWorkspaceFolder;
}

function mapSeverity(severity: string): vscode.DiagnosticSeverity {
  const normalized = normalizeSeverityName(severity);
  if (normalized === 'error') {
    return vscode.DiagnosticSeverity.Error;
  }
  if (normalized === 'warning') {
    return vscode.DiagnosticSeverity.Warning;
  }
  return vscode.DiagnosticSeverity.Information;
}

function toWorkspaceFolderInfo(
  workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined,
): WorkspaceFolderInfo[] {
  return (workspaceFolders ?? []).map((folder) => ({
    name: folder.name,
    fsPath: folder.uri.fsPath,
  }));
}

function toRange(issue: DiagnosticsIssue): vscode.Range {
  const sourceRange = issue.sourceRange!;
  const startLine = toZeroBasedPosition(sourceRange.startLine);
  const startColumn = toZeroBasedPosition(sourceRange.startColumn);
  const endLine = Math.max(startLine, toZeroBasedPosition(sourceRange.endLine));
  let endColumn = toZeroBasedPosition(sourceRange.endColumn);
  if (endLine === startLine && endColumn < startColumn) {
    endColumn = startColumn;
  }
  if (endLine === startLine && endColumn === startColumn) {
    endColumn = startColumn + 1;
  }
  return new vscode.Range(startLine, startColumn, endLine, endColumn);
}

function collectDiagnostics(
  contract: DiagnosticsContract,
  options: PublishOptions,
): CollectedDiagnostics {
  const grouped = new Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>();
  const workspaceFolders = toWorkspaceFolderInfo(options.workspaceFolders);
  let publishableBeforeFilter = 0;
  let publishedDiagnostics = 0;
  let filteredByMode = 0;
  let skippedIssues = 0;
  let resolutionFailures = 0;
  const skipReasons: Record<SkipReason, number> = {
    'not-publishable': 0,
    'mode-filtered': 0,
    'no-target-uri': 0,
  };
  // Collect up to 5 samples per skip reason for diagnosis
  const skipSamples: Record<SkipReason, DiagnosticsIssue[]> = {
    'not-publishable': [],
    'mode-filtered': [],
    'no-target-uri': [],
  };

  for (const issue of contract.issues) {
    if (!shouldPublishIssue(issue)) {
      skippedIssues += 1;
      skipReasons['not-publishable'] += 1;
      if (skipSamples['not-publishable'].length < 5) {
        skipSamples['not-publishable'].push(issue);
      }
      continue;
    }

    publishableBeforeFilter += 1;

    if (!issueMatchesDiagnosticMode(issue, options.diagnosticMode) && options.applyDiagnosticModeFilter !== false) {
      skippedIssues += 1;
      filteredByMode += 1;
      skipReasons['mode-filtered'] += 1;
      if (skipSamples['mode-filtered'].length < 5) {
        skipSamples['mode-filtered'].push(issue);
      }
      continue;
    }

    const resolution = resolveIssueFilePath(contract, issue, {
      workspaceFolders,
      defaultSourceWorkspaceFolder: options.defaultSourceWorkspaceFolder,
      defaultRepoRoot: options.defaultRepoRoot,
      fixtureSourceRoot: options.fixtureSourceRoot,
      allowFirstFolderFallback: options.allowFirstFolderFallback,
    });

    if (!resolution.filePath) {
      skippedIssues += 1;
      resolutionFailures += 1;
      skipReasons['no-target-uri'] += 1;
      if (skipSamples['no-target-uri'].length < 5) {
        skipSamples['no-target-uri'].push(issue);
      }
      options.logger.warn(
        `Skipping ${issue.id}: ${resolution.reason ?? 'Issue path could not be resolved.'}`,
      );
      continue;
    }

    if (resolution.reason) {
      options.logger.info(`Issue ${issue.id} resolved with ${resolution.strategy}: ${resolution.reason}`);
    } else {
      options.logger.debug(`Issue ${issue.id} resolved with ${resolution.strategy}.`);
    }

    const diagnostic = new vscode.Diagnostic(
      toRange(issue),
      buildDiagnosticMessage(issue),
      mapSeverity(issue.severity),
    );
    diagnostic.source = 'sphinx-doctor';
    diagnostic.code = issue.category;

    const uri = vscode.Uri.file(resolution.filePath);
    const groupKey = uri.toString();
    const existing = grouped.get(groupKey);
    if (existing) {
      existing.diagnostics.push(diagnostic);
    } else {
      grouped.set(groupKey, { uri, diagnostics: [diagnostic] });
    }
    publishedDiagnostics += 1;
  }

  // Log skip-reason samples for diagnosis when diagnostics are not publishing
  if (publishedDiagnostics === 0 && skippedIssues > 0) {
    for (const reason of ['not-publishable', 'mode-filtered', 'no-target-uri'] as SkipReason[]) {
      const samples = skipSamples[reason];
      if (samples.length > 0) {
        for (const sample of samples) {
          options.logger.info(
            `Direct-run skipped issue sample (${reason}): id=${sample.id}; category=${sample.category}; repoRelativePath=${sample.repoRelativePath}; sourceWorkspaceFolder=${sample.sourceWorkspaceFolder}; sourceRange=${sample.sourceRange ? `L${sample.sourceRange.startLine}` : 'null'}; publishDiagnostic=${sample.publishDiagnostic}`,
          );
        }
      }
    }
  }

  return {
    grouped,
    result: {
      issueCount: contract.issues.length,
      publishableBeforeFilter,
      publishedDiagnostics,
      filteredByMode,
      targetUriCount: grouped.size,
      skippedIssues,
      resolutionFailures,
      skipReasons,
    },
  };
}

export function computeDiagnosticsAccounting(
  contract: DiagnosticsContract,
  options: PublishOptions,
): PublishResult {
  return collectDiagnostics(contract, options).result;
}

export function publishDiagnosticsBatch(
  collection: vscode.DiagnosticCollection,
  entries: PublishBatchEntry[],
  options: Pick<
    PublishOptions,
    'workspaceFolders' | 'diagnosticMode' | 'logger' | 'replaceMode' | 'publicationIndex' | 'applyDiagnosticModeFilter'
  >,
): PublishResult {
  const grouped = new Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>();
  const publishedTargetsByProject = new Map<string, Map<string, vscode.Uri>>();
  let issueCount = 0;
  let publishableBeforeFilter = 0;
  let publishedDiagnostics = 0;
  let filteredByMode = 0;
  let targetUriCount = 0;
  let skippedIssues = 0;
  let resolutionFailures = 0;
  const mergedSkipReasons: Record<SkipReason, number> = {
    'not-publishable': 0,
    'mode-filtered': 0,
    'no-target-uri': 0,
  };
  const replaceMode = options.replaceMode ?? 'full';
  const affectedProjectKeys = new Set<string>();

  for (const entry of entries) {
    const collected = collectDiagnostics(entry.contract, {
      workspaceFolders: options.workspaceFolders,
      diagnosticMode: options.diagnosticMode,
      defaultSourceWorkspaceFolder: entry.defaultSourceWorkspaceFolder,
      defaultRepoRoot: entry.defaultRepoRoot,
      fixtureSourceRoot: entry.fixtureSourceRoot,
      allowFirstFolderFallback: entry.allowFirstFolderFallback,
      applyDiagnosticModeFilter: options.applyDiagnosticModeFilter,
      logger: options.logger,
    });

    issueCount += collected.result.issueCount;
    publishableBeforeFilter += collected.result.publishableBeforeFilter;
    publishedDiagnostics += collected.result.publishedDiagnostics;
    filteredByMode += collected.result.filteredByMode;
    targetUriCount += collected.result.targetUriCount;
    skippedIssues += collected.result.skippedIssues;
    resolutionFailures += collected.result.resolutionFailures;
    if (collected.result.skipReasons) {
      for (const reason of ['not-publishable', 'mode-filtered', 'no-target-uri'] as SkipReason[]) {
        mergedSkipReasons[reason] += collected.result.skipReasons[reason];
      }
    }

    const projectKey = resolveProjectKey(entry);
    if (projectKey) {
      affectedProjectKeys.add(projectKey);
      const existingTargets = publishedTargetsByProject.get(projectKey) ?? new Map<string, vscode.Uri>();
      for (const entryGroup of collected.grouped.values()) {
        existingTargets.set(entryGroup.uri.toString(), entryGroup.uri);
      }
      publishedTargetsByProject.set(projectKey, existingTargets);
    } else if (replaceMode === 'project') {
      throw new Error('Project replacement publish requires a stable project key.');
    }

    for (const [groupKey, entryGroup] of collected.grouped.entries()) {
      const existing = grouped.get(groupKey);
      if (existing) {
        existing.diagnostics.push(...entryGroup.diagnostics);
      } else {
        grouped.set(groupKey, entryGroup);
      }
    }
  }

  if (replaceMode === 'full') {
    if (options.publicationIndex) {
      options.publicationIndex.replaceAll(collection, publishedTargetsByProject);
    } else {
      collection.clear();
    }
  } else if (options.publicationIndex) {
    options.publicationIndex.replaceProjects(collection, affectedProjectKeys, publishedTargetsByProject);
  } else {
    throw new Error('Project replacement publish requires a publication index.');
  }

  for (const entry of grouped.values()) {
    collection.set(entry.uri, entry.diagnostics);
  }

  return {
    issueCount,
    publishableBeforeFilter,
    publishedDiagnostics,
    filteredByMode,
    targetUriCount,
    skippedIssues,
    resolutionFailures,
    skipReasons: mergedSkipReasons,
  };
}

export function publishDiagnostics(
  collection: vscode.DiagnosticCollection,
  contract: DiagnosticsContract,
  options: PublishOptions,
): PublishResult {
  return publishDiagnosticsBatch(
    collection,
    [
      {
        contract,
        projectKey: options.projectKey,
        defaultSourceWorkspaceFolder: options.defaultSourceWorkspaceFolder,
        defaultRepoRoot: options.defaultRepoRoot,
        fixtureSourceRoot: options.fixtureSourceRoot,
        allowFirstFolderFallback: options.allowFirstFolderFallback,
      },
    ],
    options,
  );
}