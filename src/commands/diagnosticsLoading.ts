import * as vscode from 'vscode';

import { getExtensionConfig } from '../config/extensionConfig';
import {
  loadDiagnosticsFromPath,
} from '../diagnostics/loadDiagnostics';
import {
  buildDiagnosticsAccountingReport,
  buildDiagnosticsCountsToastMessage,
} from '../diagnostics/diagnosticsAccounting';
import { SphinxDoctorLogger } from '../logging/extensionLogger';
import { computeDiagnosticsAccounting, publishDiagnostics } from '../publication/publishDiagnostics';
import { DiagnosticsPublicationIndex } from '../publication/publicationIndex';
import type { LastLoadedDiagnosticsState } from '../types';
import { SphinxDoctorWatchMode } from '../watch/watchMode';

import type { SelectedProjectDiagnostics } from './projectSelection';

const LAST_DIAGNOSTICS_STATE_KEY = 'sphinxDoctor.lastLoadedDiagnostics';

export interface CommandDependencies {
  collection: vscode.DiagnosticCollection;
  logger: SphinxDoctorLogger;
  watchMode?: SphinxDoctorWatchMode;
  publicationIndex: DiagnosticsPublicationIndex<vscode.Uri>;
}

interface LoadOptions {
  replaceMode?: 'full' | 'project';
  projectKey?: string;
  defaultSourceWorkspaceFolderOverride?: string;
  defaultRepoRootOverride?: string;
  fixtureSourceRoot?: string;
  allowFirstFolderFallback?: boolean;
}

function readLastLoadedDiagnosticsState(
  context: vscode.ExtensionContext,
): LastLoadedDiagnosticsState | undefined {
  const stored = context.workspaceState.get<LastLoadedDiagnosticsState | null>(LAST_DIAGNOSTICS_STATE_KEY);
  if (!stored || typeof stored.fileUri !== 'string' || stored.fileUri.length === 0) {
    return undefined;
  }

  return stored;
}

async function storeLastLoadedDiagnosticsState(
  context: vscode.ExtensionContext,
  state: LastLoadedDiagnosticsState,
): Promise<void> {
  await context.workspaceState.update(LAST_DIAGNOSTICS_STATE_KEY, state);
}

export async function loadAndPublish(
  context: vscode.ExtensionContext,
  fileUri: vscode.Uri,
  dependencies: CommandDependencies,
  options: LoadOptions = {},
): Promise<void> {
  const config = getExtensionConfig();
  dependencies.logger.info({
    name: SphinxDoctorLogger.LogEvents.COMMAND_LOAD_FILE,
  });

  const contract = await loadDiagnosticsFromPath(fileUri.fsPath);
  dependencies.logger.info({
    name: SphinxDoctorLogger.LogEvents.COMMAND_LOAD_CONTRACT,
    fields: {
      schema: contract.schema,
      schemaVersion: contract.schemaVersion,
      issues: contract.issues.length,
      mapped: contract.summary.mappedCount,
      unmapped: contract.summary.unmappedCount,
    },
  });
  dependencies.logger.info({
    name: SphinxDoctorLogger.LogEvents.COMMAND_LOAD_PUBLISHABLE,
    fields: {
      publishedDiagnostics: contract.summary.publishedDiagnostics,
      retainedOnly: contract.summary.retainedOnly,
    },
  });

  const result = publishDiagnostics(dependencies.collection, contract, {
    workspaceFolders: vscode.workspace.workspaceFolders,
    diagnosticMode: config.diagnosticsMode,
    replaceMode: options.replaceMode,
    projectKey: options.projectKey,
    publicationIndex: dependencies.publicationIndex,
    defaultSourceWorkspaceFolder:
      options.defaultSourceWorkspaceFolderOverride ?? config.defaultSourceWorkspaceFolder,
    defaultRepoRoot: options.defaultRepoRootOverride,
    fixtureSourceRoot: options.fixtureSourceRoot,
    allowFirstFolderFallback: options.allowFirstFolderFallback,
    logger: dependencies.logger,
  });

  await storeLastLoadedDiagnosticsState(context, {
    fileUri: fileUri.toString(),
    defaultSourceWorkspaceFolder: options.defaultSourceWorkspaceFolderOverride,
    defaultRepoRoot: options.defaultRepoRootOverride,
  });

  dependencies.logger.info({
    name: SphinxDoctorLogger.LogEvents.COMMAND_LOAD_RESULT,
    fields: {
      publishedDiagnostics: result.publishedDiagnostics,
      mode: config.diagnosticsMode,
      targetUriCount: result.targetUriCount,
      publishableBeforeFilter: result.publishableBeforeFilter,
      filteredByMode: result.filteredByMode,
      skippedIssues: result.skippedIssues,
      resolutionFailures: result.resolutionFailures,
    },
  });
  dependencies.logger.info({
    name: SphinxDoctorLogger.LogEvents.COMMAND_LOAD_COMPLETED,
  });

  const statusMessage =
    `Sphinx Doctor loaded ${result.issueCount} issues; ${result.publishableBeforeFilter} publishable before filter; ${result.publishedDiagnostics} published in ${config.diagnosticsMode} mode.`;
  dependencies.watchMode?.noteManualDiagnosticsPublished({
    filePath: fileUri.fsPath,
    issueCount: result.issueCount,
    publishableBeforeFilter: result.publishableBeforeFilter,
    publishedDiagnostics: result.publishedDiagnostics,
    filteredByMode: result.filteredByMode,
    skippedIssues: result.skippedIssues,
    resolutionFailures: result.resolutionFailures,
    message: statusMessage,
  });
  void vscode.window.showInformationMessage(statusMessage);
}

export async function explainDiagnosticsCounts(
  context: vscode.ExtensionContext,
  dependencies: CommandDependencies,
): Promise<void> {
  const config = getExtensionConfig();

  const lastLoaded = readLastLoadedDiagnosticsState(context);
  if (!lastLoaded) {
    void vscode.window.showInformationMessage(
      'No previous diagnostics file is stored yet. Run Sphinx Doctor: Load Project Diagnostics, Discover and Load Diagnostics, or Refresh Project Diagnostics first.',
    );
    return;
  }

  const diagnosticsUri = vscode.Uri.parse(lastLoaded.fileUri);
  try {
    await vscode.workspace.fs.stat(diagnosticsUri);
  } catch {
    void vscode.window.showWarningMessage(
      'The last loaded diagnostics file is no longer available. Run Sphinx Doctor: Load Project Diagnostics, Discover and Load Diagnostics, or Refresh Project Diagnostics again.',
    );
    return;
  }

  const contract = await loadDiagnosticsFromPath(diagnosticsUri.fsPath);
  const accounting = computeDiagnosticsAccounting(contract, {
    workspaceFolders: vscode.workspace.workspaceFolders,
    diagnosticMode: config.diagnosticsMode,
    defaultSourceWorkspaceFolder:
      lastLoaded.defaultSourceWorkspaceFolder ?? config.defaultSourceWorkspaceFolder,
    defaultRepoRoot: lastLoaded.defaultRepoRoot,
    logger: dependencies.logger,
  });
  const report = buildDiagnosticsAccountingReport({
    contract,
    diagnosticMode: config.diagnosticsMode,
    diagnosticsFilePath: diagnosticsUri.fsPath,
    accounting,
  });

  for (const line of report.split(/\r?\n/)) {
    dependencies.logger.info({
      name: SphinxDoctorLogger.LogEvents.COMMAND_LOAD_EXPLAIN_LINE,
      fields: { line },
    });
  }
  dependencies.logger.show(true);

  void vscode.window.showInformationMessage(
    buildDiagnosticsCountsToastMessage({
      contract,
      diagnosticMode: config.diagnosticsMode,
      diagnosticsFilePath: diagnosticsUri.fsPath,
      accounting,
    }),
  );
}

export async function loadSelectedProjectDiagnostics(
  context: vscode.ExtensionContext,
  dependencies: CommandDependencies,
  selected: SelectedProjectDiagnostics,
): Promise<void> {
  await loadAndPublish(context, selected.candidate.uri, dependencies, {
    replaceMode: 'project',
    projectKey: selected.project.id,
    defaultSourceWorkspaceFolderOverride: selected.project.sourceWorkspaceFolder,
    defaultRepoRootOverride: selected.project.repoRoot,
  });
}

export { readLastLoadedDiagnosticsState };
