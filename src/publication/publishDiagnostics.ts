import * as fs from 'node:fs';
import * as vscode from 'vscode';

import { checkDocstringRangeGate } from './docstringRangeGate';
import { SphinxDoctorLogger } from '../logging/extensionLogger';
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
import { resolveIssueFilePath } from '../workspace/inventoryCandidates';

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
  logger: SphinxDoctorLogger;
}

export type SkipReason =
  | 'not-publishable'
  | 'mode-filtered'
  | 'no-target-uri'
  | 'publisher-range-not-in-docstring'
  | 'publisher-range-outside-resolved-object-docstring'
  | 'publisher-source-unavailable'
  | 'publisher-column-out-of-bounds'
  | 'publisher-docstring-delimiter-range'
  | 'publisher-invalid-range';

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

interface SourceGuardResult {
  passed: boolean;
  skipReason: SkipReason;
  reason: string;
}

/**
 * Read the source file and verify that the diagnostic range lies within a
 * real Python triple-quoted docstring span.
 *
 * When the issue carries resolved-object docstring metadata, also require
 * the range to be inside that specific object's docstring (not just any
 * docstring in the file).
 */
export function verifyRangeInSourceDocstring(
  issue: DiagnosticsIssue,
  filePath: string | undefined,
  logger: SphinxDoctorLogger,
): SourceGuardResult {
  if (!filePath || !issue.sourceRange) {
    return {
      passed: false,
      skipReason: 'publisher-source-unavailable',
      reason: `Cannot verify range: filePath=${filePath ?? 'undefined'}, sourceRange=${issue.sourceRange ? 'present' : 'null'}`,
    };
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    logger.warn({
      name: SphinxDoctorLogger.LogEvents.PUBLICATION_ISSUE_SKIPPED,
      fields: { issueId: issue.id, reason: `Cannot read source file: ${filePath}` },
    });
    return {
      passed: false,
      skipReason: 'publisher-source-unavailable',
      reason: `Cannot read source file: ${filePath}`,
    };
  }

  const sl = issue.sourceRange.startLine;
  const el = issue.sourceRange.endLine;
  const sc = issue.sourceRange.startColumn;
  const ec = issue.sourceRange.endColumn;

  const gateResult = checkDocstringRangeGate(
    content,
    sl,
    el,
    issue.docstringStartLine,
    issue.docstringEndLine,
    sc,
    ec,
  );

  if (!gateResult.passed) {
    logger.warn({
      name: SphinxDoctorLogger.LogEvents.PUBLICATION_ISSUE_SKIPPED,
      fields: { issueId: issue.id, reason: gateResult.reason },
    });
  }

  return gateResult;
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
    'publisher-range-not-in-docstring': 0,
    'publisher-range-outside-resolved-object-docstring': 0,
    'publisher-source-unavailable': 0,
    'publisher-column-out-of-bounds': 0,
    'publisher-docstring-delimiter-range': 0,
    'publisher-invalid-range': 0,
  };
  // Collect up to 5 samples per skip reason for diagnosis
  const skipSamples: Record<SkipReason, DiagnosticsIssue[]> = {
    'not-publishable': [],
    'mode-filtered': [],
    'no-target-uri': [],
    'publisher-range-not-in-docstring': [],
    'publisher-range-outside-resolved-object-docstring': [],
    'publisher-source-unavailable': [],
    'publisher-column-out-of-bounds': [],
    'publisher-docstring-delimiter-range': [],
    'publisher-invalid-range': [],
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

    // Defensive fail-closed check: if the issue carries docstring-span metadata,
    // the published range must lie wholly within that span.  This guards against
    // any upstream parser or mapper defect that labels an unsafe range as
    // publishable.
    if (issue.docstringStartLine != null && issue.docstringEndLine != null && issue.sourceRange) {
      const sl = issue.sourceRange.startLine;
      const el = issue.sourceRange.endLine;
      if (sl < issue.docstringStartLine || el > issue.docstringEndLine) {
        skippedIssues += 1;
        skipReasons['not-publishable'] += 1;
        if (skipSamples['not-publishable'].length < 5) {
          skipSamples['not-publishable'].push(issue);
        }
        options.logger.warn({
          name: SphinxDoctorLogger.LogEvents.PUBLICATION_ISSUE_SKIPPED,
          fields: {
            issueId: issue.id,
            reason: `Published range [${sl}, ${el}] outside docstring span [${issue.docstringStartLine}, ${issue.docstringEndLine}] — blocked by publisher`,
          },
        });
        continue;
      }
    }

    // ── Publisher source guard ──────────────────────────────────────────
    // Independently verify that the diagnostic range lies within a real
    // triple-quoted Python docstring span in the current source file.
    // This is the last line of defence — it does not trust mapper metadata.
    //
    // Resolve the file path first so the guard can read the source.
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
      options.logger.warn({
        name: SphinxDoctorLogger.LogEvents.PUBLICATION_ISSUE_SKIPPED,
        fields: { issueId: issue.id, reason: resolution.reason ?? 'Issue path could not be resolved.' },
      });
      continue;
    }

    if (issue.sourceRange && issue.repoRelativePath) {
      const sourceGuardResult = verifyRangeInSourceDocstring(
        issue,
        resolution.filePath,
        options.logger,
      );
      if (!sourceGuardResult.passed) {
        skippedIssues += 1;
        skipReasons[sourceGuardResult.skipReason] += 1;
        if (skipSamples[sourceGuardResult.skipReason].length < 5) {
          skipSamples[sourceGuardResult.skipReason].push(issue);
        }
        options.logger.warn({
          name: SphinxDoctorLogger.LogEvents.PUBLICATION_ISSUE_SKIPPED,
          fields: {
            issueId: issue.id,
            reason: sourceGuardResult.reason,
          },
        });
        continue;
      }
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

    if (resolution.reason) {
      options.logger.info({
        name: SphinxDoctorLogger.LogEvents.PUBLICATION_ISSUE_RESOLVED,
        fields: { issueId: issue.id, strategy: resolution.strategy, reason: resolution.reason },
      });
    } else {
      options.logger.debug({
        name: SphinxDoctorLogger.LogEvents.PUBLICATION_ISSUE_RESOLVED,
        fields: { issueId: issue.id, strategy: resolution.strategy },
      });
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
          options.logger.info({
            name: SphinxDoctorLogger.LogEvents.PUBLICATION_SKIP_SAMPLE,
            fields: {
              skipReason: reason,
              issueId: sample.id,
              category: sample.category,
            },
          });
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
    'publisher-range-not-in-docstring': 0,
    'publisher-range-outside-resolved-object-docstring': 0,
    'publisher-source-unavailable': 0,
    'publisher-column-out-of-bounds': 0,
    'publisher-docstring-delimiter-range': 0,
    'publisher-invalid-range': 0,
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
      for (const reason of [
        'not-publishable', 'mode-filtered', 'no-target-uri',
        'publisher-range-not-in-docstring',
        'publisher-range-outside-resolved-object-docstring',
        'publisher-source-unavailable',
        'publisher-column-out-of-bounds',
        'publisher-docstring-delimiter-range',
        'publisher-invalid-range',
      ] as SkipReason[]) {
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