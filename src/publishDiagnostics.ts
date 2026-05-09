import * as vscode from 'vscode';

import { SphinxDoctorLogger } from './log';
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
} from './types';
import { resolveIssueFilePath } from './workspace';

export interface PublishOptions {
  workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined;
  diagnosticMode: DiagnosticMode;
  defaultSourceWorkspaceFolder?: string;
  defaultRepoRoot?: string;
  fixtureSourceRoot?: string;
  allowFirstFolderFallback?: boolean;
  logger: SphinxDoctorLogger;
}

export interface PublishResult {
  issueCount: number;
  publishableBeforeFilter: number;
  publishedDiagnostics: number;
  filteredByMode: number;
  targetUriCount: number;
  skippedIssues: number;
  resolutionFailures: number;
}

export interface PublishBatchEntry {
  contract: DiagnosticsContract;
  defaultSourceWorkspaceFolder?: string;
  defaultRepoRoot?: string;
  fixtureSourceRoot?: string;
  allowFirstFolderFallback?: boolean;
}

interface CollectedDiagnostics {
  grouped: Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>;
  result: PublishResult;
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

  for (const issue of contract.issues) {
    if (!shouldPublishIssue(issue)) {
      skippedIssues += 1;
      continue;
    }

    publishableBeforeFilter += 1;

    if (!issueMatchesDiagnosticMode(issue, options.diagnosticMode)) {
      skippedIssues += 1;
      filteredByMode += 1;
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
    },
  };
}

export function publishDiagnosticsBatch(
  collection: vscode.DiagnosticCollection,
  entries: PublishBatchEntry[],
  options: Pick<PublishOptions, 'workspaceFolders' | 'diagnosticMode' | 'logger'>,
): PublishResult {
  const grouped = new Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>();
  let issueCount = 0;
  let publishableBeforeFilter = 0;
  let publishedDiagnostics = 0;
  let filteredByMode = 0;
  let targetUriCount = 0;
  let skippedIssues = 0;
  let resolutionFailures = 0;

  collection.clear();

  for (const entry of entries) {
    const collected = collectDiagnostics(entry.contract, {
      workspaceFolders: options.workspaceFolders,
      diagnosticMode: options.diagnosticMode,
      defaultSourceWorkspaceFolder: entry.defaultSourceWorkspaceFolder,
      defaultRepoRoot: entry.defaultRepoRoot,
      fixtureSourceRoot: entry.fixtureSourceRoot,
      allowFirstFolderFallback: entry.allowFirstFolderFallback,
      logger: options.logger,
    });

    issueCount += collected.result.issueCount;
  publishableBeforeFilter += collected.result.publishableBeforeFilter;
    publishedDiagnostics += collected.result.publishedDiagnostics;
  filteredByMode += collected.result.filteredByMode;
    targetUriCount += collected.result.targetUriCount;
    skippedIssues += collected.result.skippedIssues;
    resolutionFailures += collected.result.resolutionFailures;

    for (const [groupKey, entryGroup] of collected.grouped.entries()) {
      const existing = grouped.get(groupKey);
      if (existing) {
        existing.diagnostics.push(...entryGroup.diagnostics);
      } else {
        grouped.set(groupKey, entryGroup);
      }
    }
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
        defaultSourceWorkspaceFolder: options.defaultSourceWorkspaceFolder,
        defaultRepoRoot: options.defaultRepoRoot,
        fixtureSourceRoot: options.fixtureSourceRoot,
        allowFirstFolderFallback: options.allowFirstFolderFallback,
      },
    ],
    options,
  );
}