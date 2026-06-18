import path from 'node:path';

import * as vscode from 'vscode';

import { getExtensionConfig } from '../config/extensionConfig';
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

let sphinxBuildInProgress = false;

export async function runSphinxBuildDirect(
  dependencies: CommandDependencies,
): Promise<void> {
  // Check if a build is already in progress
  if (sphinxBuildInProgress) {
    void vscode.window.showWarningMessage(
      'Sphinx Doctor: A Sphinx build is already in progress. Please wait for it to complete.',
    );
    return;
  }

  const config = getExtensionConfig();
  dependencies.logger.setLevel(config.logLevel);

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
    return;
  }

  // Get workspace folder
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    void vscode.window.showWarningMessage(
      'Sphinx Doctor requires an open workspace folder to run Sphinx build.',
    );
    return;
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
      return;
    }
    selectedFolder = picked;
  }

  const workspaceFolderInfo: WorkspaceFolderInfo = {
    name: selectedFolder.name,
    fsPath: selectedFolder.uri.fsPath,
  };

  // Mark build as in progress
  sphinxBuildInProgress = true;

  try {
    dependencies.logger.info(
      `Running Sphinx build in workspace folder: ${workspaceFolderInfo.name} (${workspaceFolderInfo.fsPath})`,
    );

    // Build run plan
    const plan = buildSphinxRunPlan({
      config: sphinxConfig,
      workspaceFolders: [workspaceFolderInfo],
      cwdWorkspaceFolder: workspaceFolderInfo.name,
    });

    dependencies.logger.info(
      `Sphinx build plan: command=${plan.command}, args=${plan.args.join(' ')}, cwd=${plan.cwd}`,
    );

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

    dependencies.logger.info(
      `Sphinx build completed: status=${result.status}, exitCode=${result.exitCode}, warningFileExists=${result.warningFileExists}`,
    );

    if (result.stdout) {
      dependencies.logger.info(`Sphinx stdout:\n${result.stdout}`);
    }
    if (result.stderr) {
      dependencies.logger.info(`Sphinx stderr:\n${result.stderr}`);
    }

    // Handle cancellation
    if (result.status === 'canceled') {
      dependencies.logger.info('Sphinx build was canceled by user');
      void vscode.window.showInformationMessage('Sphinx Doctor: Build canceled.');
      return;
    }

    // Handle failure
    if (result.status === 'failed' && !result.warningFileExists) {
      void vscode.window.showErrorMessage(
        `Sphinx build failed with exit code ${result.exitCode}. Check the output channel for details.`,
      );
      return;
    }

    // Check if warning file exists and has content
    if (!result.warningFileExists) {
      void vscode.window.showWarningMessage(
        'Sphinx Doctor: Warning file was not created. Sphinx may have failed before generating it.',
      );
      return;
    }

    const warningFileContent = await vscode.workspace.fs.readFile(vscode.Uri.file(plan.warningFile));
    const warningText = Buffer.from(warningFileContent).toString('utf8');
    const warningSummary = summarizeWarningFileContent(warningText);

    dependencies.logger.info(`Parsing warnings from: ${plan.warningFile}`);

    const parseResult = await parseSphinxWarnings({
      warningFileContent: warningText,
      repoRoot: workspaceFolderInfo.fsPath,
      sourceWorkspaceFolder: workspaceFolderInfo.name,
    });

    dependencies.logger.info(
      `Sphinx Doctor run context: selectedWorkspaceFolder=${workspaceFolderInfo.name}; cwd=${plan.cwd}; command=${plan.command}; args=${plan.args.join(' ')}; warningFile=${plan.warningFile}; exists=${result.warningFileExists}; bytes=${warningSummary.byteLength}; lines=${warningSummary.lineCount}; first10=${warningSummary.firstTenLines}; docstring=${warningSummary.docstringWarningCount}; standard=${warningSummary.standardWarningCount}; global=${warningSummary.globalWarningCount}; parserRawLines=${parseResult.totalLines}; parsed=${parseResult.issues.length}; unparsed=${parseResult.unparsedCount}; mapped=${parseResult.issues.length}; unmapped=${parseResult.unmappedCount}; publishable=${parseResult.issues.length}; astDegraded=${parseResult.astDegraded}; unsafeDocstringFallback=${parseResult.unsafeDocstringFallbackCount}; suppressedNonDocstring=${parseResult.suppressedNonDocstringCount}.`,
    );

    dependencies.logger.info(
      `Parsed ${parseResult.issues.length} issues from ${parseResult.totalLines} lines (${parseResult.unmappedCount} unmapped, ${parseResult.unparsedCount} unparsed, ${parseResult.suppressedNonDocstringCount} non-docstring suppressed, ${parseResult.unsafeDocstringFallbackCount} unsafe docstring fallback retained)`,
    );

    if (parseResult.astDegraded) {
      dependencies.logger.warn(
        `Python docstring text mapper degraded; ${parseResult.unsafeDocstringFallbackCount} docstring warnings retained (not published to Problems — source docstring range could not be determined). ${parseResult.suppressedNonDocstringCount} non-docstring warnings also suppressed.`,
      );
    }

    if (shouldTreatWarningFileAsEmpty(warningSummary) && parseResult.issues.length === 0) {
      void vscode.window.showInformationMessage(
        'Sphinx Doctor: Sphinx produced no warnings (empty or single blank line in warning file).',
      );
      return;
    }

    if (parseResult.issues.length === 0 && parseResult.unparsedCount > 0) {
      void vscode.window.showWarningMessage(
        `Sphinx Doctor: Warnings were present but none matched parser patterns (${parseResult.unparsedCount} unparsed lines).`,
      );
      return;
    }

    if (parseResult.issues.length === 0 && parseResult.unmappedCount > 0) {
      void vscode.window.showWarningMessage(
        `Sphinx Doctor: Warnings parsed but could not be mapped to files (${parseResult.unmappedCount} unmapped).`,
      );
      return;
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

    dependencies.logger.info(
      `Direct-run diagnostics published for ${workspaceFolderInfo.name}: ${publishResult.issueCount} issues, ${publishResult.publishableBeforeFilter} publishable before filter, ${publishResult.publishedDiagnostics} published across ${publishResult.targetUriCount} target URIs; ${publishResult.filteredByMode} filtered by mode, ${publishResult.skippedIssues} skipped, ${publishResult.resolutionFailures} resolution failures${publishResult.skipReasons ? `; skip breakdown: not-publishable=${publishResult.skipReasons['not-publishable']}, mode-filtered=${publishResult.skipReasons['mode-filtered']}, no-target-uri=${publishResult.skipReasons['no-target-uri']}` : ''}. Warning file: ${plan.warningFile}.`,
    );

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

    void vscode.window.showInformationMessage(
      `Sphinx Doctor: Published ${publishResult.publishedDiagnostics} diagnostics from Sphinx build (${parseResult.unmappedCount} unmapped warnings).`,
    );
  } finally {
    // Always reset the single-flight flag
    sphinxBuildInProgress = false;
  }
}
