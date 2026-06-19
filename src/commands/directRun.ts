import path from 'node:path';

import * as vscode from 'vscode';

import { getExtensionConfig } from '../config/extensionConfig';
import { SphinxDoctorLogger } from '../logging/extensionLogger';
import { publishDiagnostics } from '../publication/publishDiagnostics';
import {
  buildSphinxRunPlan,
  getSphinxRunPermission,
  runSphinxPlan,
  type SphinxRunConfig,
} from '../sphinx/SphinxDoctorRunner';
import { parseSphinxWarnings } from '../sphinx/SphinxWarningParser';
import { shouldTreatWarningFileAsEmpty, summarizeWarningFileContent } from '../sphinx/sphinxWarningSummary';
import type { DiagnosticsContract, WorkspaceFolderInfo } from '../types';

import type { CommandDependencies } from './diagnosticsLoading';
import type { DirectRunOutcome } from './directRunSaveRepublisher';

export type { DirectRunOutcome } from './directRunSaveRepublisher';

let sphinxBuildInProgress = false;

let currentDirectRunWorkspaceRoot: string | null = null;
let currentDirectRunOutputDir: string | null = null;

export function getSphinxBuildInProgress(): boolean {
  return sphinxBuildInProgress;
}

export function getCurrentDirectRunWorkspaceRoot(): string | null {
  return currentDirectRunWorkspaceRoot;
}

export function getCurrentDirectRunOutputDir(): string | null {
  return currentDirectRunOutputDir;
}

export interface DirectRunOptions {
  suppressSuccessToast?: boolean;
}

export async function runSphinxBuildDirect(
  dependencies: CommandDependencies,
  options: DirectRunOptions = {},
): Promise<DirectRunOutcome> {
  // Check if a build is already in progress
  if (sphinxBuildInProgress) {
    if (!options.suppressSuccessToast) {
      void vscode.window.showWarningMessage(
        'Sphinx Doctor: A Sphinx build is already in progress. Please wait for it to complete.',
      );
    }
    return 'blocked';
  }

  const config = getExtensionConfig();

  // Check if direct run is enabled
  const sphinxConfig: SphinxRunConfig = {
    enabled: config.directRunEnabled,
    command: config.sphinxCommand,
    builder: config.sphinxBuilder,
    sourceDir: config.sphinxSourceDir,
    outputDir: config.sphinxOutputDir,
    warningFile: config.sphinxWarningFile,
    extraArgs: config.sphinxExtraArgs,
  };

  const permission = getSphinxRunPermission(vscode.workspace.isTrusted, sphinxConfig);
  if (!permission.allowed) {
    void vscode.window.showWarningMessage(
      `Sphinx Doctor cannot run Sphinx build: ${permission.reason}`,
    );
    return 'blocked';
  }

  // Get workspace folder
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    void vscode.window.showWarningMessage(
      'Sphinx Doctor requires an open workspace folder to run Sphinx build.',
    );
    return 'blocked';
  }

  // Use first workspace folder or let user pick if multiple
  let selectedFolder: vscode.WorkspaceFolder;
  if (workspaceFolders.length === 1) {
    selectedFolder = workspaceFolders[0];
  } else {
    const picked = await vscode.window.showWorkspaceFolderPick({
      placeHolder: 'Select workspace folder for Sphinx build',
    });
    if (!picked) {
      return 'declined';
    }
    selectedFolder = picked;
  }

  const workspaceFolderInfo: WorkspaceFolderInfo = {
    name: selectedFolder.name,
    fsPath: selectedFolder.uri.fsPath,
  };

  // Store resolved workspace root for save-session binding
  currentDirectRunWorkspaceRoot = workspaceFolderInfo.fsPath;
  currentDirectRunOutputDir = path.resolve(workspaceFolderInfo.fsPath, config.sphinxOutputDir);

  // Mark build as in progress
  sphinxBuildInProgress = true;

  try {
    dependencies.logger.info({
      name: SphinxDoctorLogger.LogEvents.COMMAND_DIRECT_RUN_BUILD_START,
      fields: {
        workspaceFolder: workspaceFolderInfo.name,
        source: options.suppressSuccessToast ? 'save-triggered' : 'manual',
      },
    });

    // Build run plan
    const plan = buildSphinxRunPlan({
      config: sphinxConfig,
      workspaceFolders: [workspaceFolderInfo],
      cwdWorkspaceFolder: workspaceFolderInfo.name,
    });

    dependencies.logger.info({
      name: SphinxDoctorLogger.LogEvents.COMMAND_DIRECT_RUN_BUILD_PLAN,
      fields: { command: plan.command, argCount: plan.args.length },
    });

    // Run with progress
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Sphinx Doctor: Running Sphinx build',
        cancellable: true,
      },
      async (_progress, token) => {
        return await runSphinxPlan(plan, { cancellationToken: token });
      },
    );

    dependencies.logger.info({
      name: SphinxDoctorLogger.LogEvents.COMMAND_DIRECT_RUN_BUILD_COMPLETED,
      fields: { status: result.status, exitCode: result.exitCode, warningFileExists: result.warningFileExists },
    });

    if (result.stdout) {
      dependencies.logger.info({
        name: SphinxDoctorLogger.LogEvents.COMMAND_DIRECT_RUN_BUILD_STDOUT,
        fields: { stdout: result.stdout },
      });
    }
    if (result.stderr) {
      dependencies.logger.info({
        name: SphinxDoctorLogger.LogEvents.COMMAND_DIRECT_RUN_BUILD_STDERR,
        fields: { stderr: result.stderr },
      });
    }

    // Handle cancellation
    if (result.status === 'canceled') {
      dependencies.logger.info({
        name: SphinxDoctorLogger.LogEvents.COMMAND_DIRECT_RUN_CANCELED,
      });
      if (!options.suppressSuccessToast) {
        void vscode.window.showInformationMessage('Sphinx Doctor: Build canceled.');
      }
      return 'failed';
    }

    // Handle failure
    if (result.status === 'failed' && !result.warningFileExists) {
      void vscode.window.showErrorMessage(
        `Sphinx build failed with exit code ${result.exitCode}. Check the output channel for details.`,
      );
      return 'failed';
    }

    // Check if warning file exists and has content
    if (!result.warningFileExists) {
      void vscode.window.showWarningMessage(
        'Sphinx Doctor: Warning file was not created. Sphinx may have failed before generating it.',
      );
      return 'failed';
    }

    const warningFileContent = await vscode.workspace.fs.readFile(vscode.Uri.file(plan.warningFile));
    const warningText = Buffer.from(warningFileContent).toString('utf8');
    const warningSummary = summarizeWarningFileContent(warningText);

    dependencies.logger.info({
      name: SphinxDoctorLogger.LogEvents.COMMAND_DIRECT_RUN_PARSE_START,
    });

    const parseResult = await parseSphinxWarnings({
      warningFileContent: warningText,
      repoRoot: workspaceFolderInfo.fsPath,
      sourceWorkspaceFolder: workspaceFolderInfo.name,
    });

    dependencies.logger.info({
      name: SphinxDoctorLogger.LogEvents.COMMAND_DIRECT_RUN_PARSE_RESULT,
      fields: {
        workspaceFolder: workspaceFolderInfo.name,
        command: plan.command,
        bytes: warningSummary.byteLength,
        lines: warningSummary.lineCount,
        docstringWarnings: warningSummary.docstringWarningCount,
        standardWarnings: warningSummary.standardWarningCount,
        globalWarnings: warningSummary.globalWarningCount,
        parserRawLines: parseResult.totalLines,
        parsed: parseResult.issues.length,
        unparsed: parseResult.unparsedCount,
        unmapped: parseResult.unmappedCount,
        astDegraded: parseResult.astDegraded,
        unsafeDocstringFallback: parseResult.unsafeDocstringFallbackCount,
        suppressedNonDocstring: parseResult.suppressedNonDocstringCount,
      },
    });

    dependencies.logger.info({
      name: SphinxDoctorLogger.LogEvents.COMMAND_DIRECT_RUN_PARSE_COUNTS,
      fields: {
        parsed: parseResult.issues.length,
        totalLines: parseResult.totalLines,
        unmapped: parseResult.unmappedCount,
        unparsed: parseResult.unparsedCount,
        suppressedNonDocstring: parseResult.suppressedNonDocstringCount,
        unsafeDocstringFallback: parseResult.unsafeDocstringFallbackCount,
      },
    });

    if (parseResult.astDegraded) {
      dependencies.logger.warn({
        name: SphinxDoctorLogger.LogEvents.COMMAND_DIRECT_RUN_PARSE_DEGRADED,
        fields: {
          unsafeDocstringFallback: parseResult.unsafeDocstringFallbackCount,
          suppressedNonDocstring: parseResult.suppressedNonDocstringCount,
        },
      });
    }

    if (shouldTreatWarningFileAsEmpty(warningSummary) && parseResult.issues.length === 0) {
      if (!options.suppressSuccessToast) {
        void vscode.window.showInformationMessage(
          'Sphinx Doctor: Sphinx produced no warnings (empty or single blank line in warning file).',
        );
      }
      return 'completed';
    }

    if (parseResult.issues.length === 0 && parseResult.unparsedCount > 0) {
      void vscode.window.showWarningMessage(
        `Sphinx Doctor: Warnings were present but none matched parser patterns (${parseResult.unparsedCount} unparsed lines).`,
      );
      return 'completed';
    }

    if (parseResult.issues.length === 0 && parseResult.unmappedCount > 0) {
      void vscode.window.showWarningMessage(
        `Sphinx Doctor: Warnings parsed but could not be mapped to files (${parseResult.unmappedCount} unmapped).`,
      );
      return 'completed';
    }

    // Create a diagnostics contract from parsed warnings
    const contract: DiagnosticsContract = {
      schema: 'sphinx-diagnostics-v1',
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      tool: {
        name: 'sphinx-doctor-direct',
        version: '0.1.0',
      },
      workspace: {
        sourceWorkspaceFolder: workspaceFolderInfo.name,
        repoRoot: '.',
      },
      run: {
        id: `direct-${Date.now()}`,
        source: 'direct-sphinx-build',
        inventoryFile: plan.warningFile,
        inventoryDir: path.dirname(plan.warningFile),
      },
      summary: {
        total: parseResult.issues.length,
        bySeverity: parseResult.issues.reduce((acc, issue) => {
          acc[issue.severity] = (acc[issue.severity] || 0) + 1;
          return acc;
        }, {} as Record<string, number>),
        byCategory: parseResult.issues.reduce((acc, issue) => {
          acc[issue.category] = (acc[issue.category] || 0) + 1;
          return acc;
        }, {} as Record<string, number>),
        mappedCount: parseResult.issues.length,
        unmappedCount: parseResult.unmappedCount,
        publishedDiagnostics: parseResult.issues.length,
        retainedOnly: 0,
      },
      issues: parseResult.issues,
    };

    // Publish diagnostics
    const publishResult = publishDiagnostics(
      dependencies.collection,
      contract,
      {
        workspaceFolders: [selectedFolder],
        diagnosticMode: config.diagnosticsMode,
        defaultSourceWorkspaceFolder: workspaceFolderInfo.name,
        defaultRepoRoot: '.',
        applyDiagnosticModeFilter: false,
        logger: dependencies.logger,
      },
    );

    dependencies.logger.info({
      name: SphinxDoctorLogger.LogEvents.COMMAND_DIRECT_RUN_PUBLISHED,
      fields: {
        workspaceFolder: workspaceFolderInfo.name,
        issueCount: publishResult.issueCount,
        publishableBeforeFilter: publishResult.publishableBeforeFilter,
        publishedDiagnostics: publishResult.publishedDiagnostics,
        targetUriCount: publishResult.targetUriCount,
        filteredByMode: publishResult.filteredByMode,
        skippedIssues: publishResult.skippedIssues,
        resolutionFailures: publishResult.resolutionFailures,
      },
    });

    const statusMessage =
      `Sphinx Doctor direct run: ${publishResult.issueCount} issues; ${publishResult.publishedDiagnostics} published in ${config.diagnosticsMode} mode.`;
    dependencies.watchMode?.noteManualDiagnosticsPublished({
      filePath: plan.warningFile,
      issueCount: publishResult.issueCount,
      publishableBeforeFilter: publishResult.publishableBeforeFilter,
      publishedDiagnostics: publishResult.publishedDiagnostics,
      filteredByMode: publishResult.filteredByMode,
      skippedIssues: publishResult.skippedIssues,
      resolutionFailures: publishResult.resolutionFailures,
      message: statusMessage,
    });

    if (!options.suppressSuccessToast) {
      void vscode.window.showInformationMessage(
        `Sphinx Doctor: Published ${publishResult.publishedDiagnostics} diagnostics from Sphinx build (${parseResult.unmappedCount} unmapped warnings).`,
      );
    }
    return 'completed';
  } finally {
    // Always reset the single-flight flag
    sphinxBuildInProgress = false;
  }
}
