import path from 'node:path';

import * as vscode from 'vscode';

import {
  getExtensionConfig,
  projectLabel,
} from './config/extensionConfig';
import { loadAllDiscoveredDiagnostics } from './diagnostics/loadAllDiagnostics';
import {
  buildSphinxRunPlan,
  getSphinxRunPermission,
  runSphinxPlan,
  SphinxRunConfig,
} from './sphinx/SphinxDoctorRunner';
import { parseSphinxWarnings } from './sphinx/SphinxWarningParser';
import { summarizeWarningFileContent, shouldTreatWarningFileAsEmpty } from './sphinx/sphinxWarningSummary';
import { publishDiagnostics } from './publication/publishDiagnostics';
import {
  buildSelfTestStatusTooltip,
  clearPublishedDiagnostics,
  createSelfTestDiagnosticSpec,
  publishSelfTestDiagnostic,
  SELF_TEST_COMMAND_ID,
  SELF_TEST_FALLBACK_RELATIVE_PATH,
  SELF_TEST_STATUS_TEXT,
} from './commands/selfTestDiagnostic';
import { DiagnosticsContract, WorkspaceFolderInfo } from './types';
import {
  discoverOnlyProject,
  selectConfiguredProject,
  selectMergedProject,
} from './commands/projectSelection';
import { runSafely } from './commands/runSafely';
import {
  type CommandDependencies,
  explainDiagnosticsCounts,
  loadAndPublish,
  readLastLoadedDiagnosticsState,
} from './commands/diagnosticsLoading';
import {
  loadOrEnrichProjectDiagnostics,
  runRefreshAndLoadProjectDiagnostics,
} from './commands/refreshAndEnrichment';

// Single-flight tracking for Sphinx build command
let sphinxBuildInProgress = false;

const TROUBLESHOOT_REPORTS_DIRECTORY = 'troubleshoot-reports';
const TROUBLESHOOT_REPORT_FILENAME_PREFIX = 'troubleshoot-environment';

function formatTroubleshootReportTimestamp(now: Date = new Date()): string {
  const year = now.getFullYear().toString().padStart(4, '0');
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const seconds = now.getSeconds().toString().padStart(2, '0');

  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

async function writeTroubleshootReport(
  context: vscode.ExtensionContext,
  reportContent: string,
): Promise<vscode.Uri> {
  const reportsDirectoryUri = vscode.Uri.joinPath(context.logUri, TROUBLESHOOT_REPORTS_DIRECTORY);
  await vscode.workspace.fs.createDirectory(reportsDirectoryUri);

  const reportFileName = `${TROUBLESHOOT_REPORT_FILENAME_PREFIX}-${formatTroubleshootReportTimestamp()}.md`;
  const reportUri = vscode.Uri.joinPath(reportsDirectoryUri, reportFileName);
  await vscode.workspace.fs.writeFile(reportUri, new TextEncoder().encode(reportContent));

  return reportUri;
}

function createVscodeSelfTestDiagnostic(): vscode.Diagnostic {
  const spec = createSelfTestDiagnosticSpec();
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(spec.startLine, spec.startColumn, spec.endLine, spec.endColumn),
    spec.message,
    vscode.DiagnosticSeverity.Warning,
  );
  diagnostic.source = spec.source;
  return diagnostic;
}

async function resolveSelfTestTargetUri(
  context: vscode.ExtensionContext,
): Promise<vscode.Uri> {
  const activeDocumentUri = vscode.window.activeTextEditor?.document.uri;
  if (activeDocumentUri) {
    return activeDocumentUri;
  }

  const fallbackUri = vscode.Uri.joinPath(context.extensionUri, SELF_TEST_FALLBACK_RELATIVE_PATH);
  const document = await vscode.workspace.openTextDocument(fallbackUri);
  await vscode.window.showTextDocument(document, { preview: true });
  return document.uri;
}

export function registerCommands(
  context: vscode.ExtensionContext,
  dependencies: CommandDependencies,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(SELF_TEST_COMMAND_ID, async () => {
      await runSafely(dependencies.logger, 'Publish Self-Test Diagnostic', async () => {
        const targetUri = await resolveSelfTestTargetUri(context);
        const result = publishSelfTestDiagnostic<vscode.Uri, vscode.Diagnostic>(
          (target, diagnostics) => {
            dependencies.collection.set([[target, diagnostics]]);
          },
          targetUri,
          () => createVscodeSelfTestDiagnostic(),
        );

        dependencies.watchMode?.noteSelfTestDiagnosticPublished(
          targetUri,
          result.diagnosticCount,
          buildSelfTestStatusTooltip(targetUri.toString(), result.diagnosticCount),
        );
        dependencies.logger.info(
          `Self-test diagnostic published: target=${targetUri.toString()} diagnostics=${result.diagnosticCount}.`,
        );
        dependencies.logger.info('Self-test diagnostic collection update completed.');
        void vscode.window.showInformationMessage(SELF_TEST_STATUS_TEXT);
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sphinxDoctor.loadDiagnosticsFile', async () => {
      await runSafely(dependencies.logger, 'Load Diagnostics File', async () => {
        const selected = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: {
            JSON: ['json'],
          },
          openLabel: 'Load Sphinx Doctor Diagnostics',
        });

        if (!selected || selected.length === 0) {
          return;
        }

        await loadAndPublish(context, selected[0], dependencies);
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sphinxDoctor.loadFixtureDiagnostics', async () => {
      await runSafely(dependencies.logger, 'Load Fixture Diagnostics', async () => {
        const diagnosticsUri = vscode.Uri.joinPath(
          context.extensionUri,
          'fixtures',
          'enriched',
          'keripy-coring-unexpected-indentation.expected.json',
        );
        const fixtureSourceRoot = vscode.Uri.joinPath(
          context.extensionUri,
          'fixtures',
          'source',
          'keripy',
        ).fsPath;

        dependencies.logger.info(`Loading fixture diagnostics: ${diagnosticsUri.fsPath}`);

        await loadAndPublish(context, diagnosticsUri, dependencies, {
          fixtureSourceRoot,
          allowFirstFolderFallback: true,
        });
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sphinxDoctor.loadProjectDiagnostics', async () => {
      await runSafely(dependencies.logger, 'Load Project Diagnostics', async () => {
        const project = await selectConfiguredProject(dependencies.logger);
        if (!project) {
          return;
        }

        await loadOrEnrichProjectDiagnostics(context, dependencies, project, false);
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sphinxDoctor.enrichAndLoadProjectDiagnostics', async () => {
      await runSafely(dependencies.logger, 'Enrich and Load Project Diagnostics', async () => {
        const project = await selectConfiguredProject(dependencies.logger);
        if (!project) {
          return;
        }

        await loadOrEnrichProjectDiagnostics(context, dependencies, project, true);
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sphinxDoctor.refreshProjectDiagnostics', async () => {
      await runSafely(dependencies.logger, 'Refresh Project Diagnostics', async () => {
        const project = await selectMergedProject(dependencies.logger);
        if (!project) {
          return;
        }

        await runRefreshAndLoadProjectDiagnostics(context, dependencies, project);
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sphinxDoctor.discoverWorkspaceProjects', async () => {
      await runSafely(dependencies.logger, 'Discover Workspace Projects', async () => {
        const project = await discoverOnlyProject(dependencies.logger);
        if (!project) {
          return;
        }

        void vscode.window.showInformationMessage(
          `Discovered ${projectLabel(project)} with ${project.discoveryConfidence ?? 'unknown'} confidence: ${(project.discoveryReasons ?? []).join('; ')}`,
        );
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sphinxDoctor.discoverAndLoadDiagnostics', async () => {
      await runSafely(dependencies.logger, 'Discover And Load Diagnostics', async () => {
        await loadAllDiscoveredDiagnostics({
          watchMode: dependencies.watchMode,
          logger: dependencies.logger,
          showWarningMessage: (message) => {
            void vscode.window.showWarningMessage(message);
          },
          showInformationMessage: (message) => {
            void vscode.window.showInformationMessage(message);
          },
        });
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sphinxDoctor.reloadLastDiagnostics', async () => {
      await runSafely(dependencies.logger, 'Reload Last Diagnostics', async () => {
        const lastLoaded = readLastLoadedDiagnosticsState(context);
        if (!lastLoaded) {
          void vscode.window.showInformationMessage(
            'No previous diagnostics file is stored yet. Run Sphinx Doctor: Load Project Diagnostics or Sphinx Doctor: Enrich and Load Project Diagnostics first.',
          );
          return;
        }

        const diagnosticsUri = vscode.Uri.parse(lastLoaded.fileUri);
        try {
          await vscode.workspace.fs.stat(diagnosticsUri);
        } catch {
          void vscode.window.showWarningMessage(
            'The last loaded diagnostics file is no longer available. Run Sphinx Doctor: Load Project Diagnostics or Sphinx Doctor: Enrich and Load Project Diagnostics again.',
          );
          return;
        }

        await loadAndPublish(context, diagnosticsUri, dependencies, {
          defaultSourceWorkspaceFolderOverride: lastLoaded.defaultSourceWorkspaceFolder,
          defaultRepoRootOverride: lastLoaded.defaultRepoRoot,
        });
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sphinxDoctor.explainDiagnosticsCounts', async () => {
      await runSafely(dependencies.logger, 'Explain Diagnostics Counts', async () => {
        await explainDiagnosticsCounts(context, dependencies);
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sphinxDoctor.clearDiagnostics', async () => {
      await runSafely(dependencies.logger, 'Clear Diagnostics', async () => {
        clearPublishedDiagnostics(dependencies.collection);
        dependencies.publicationIndex.clear();
        dependencies.watchMode?.noteManualClear();
        dependencies.logger.info('Cleared Sphinx Doctor diagnostics.');
        void vscode.window.showInformationMessage('Sphinx Doctor diagnostics cleared.');
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sphinxDoctor.showStatus', async () => {
      await runSafely(dependencies.logger, 'Show Status', async () => {
        if (dependencies.watchMode) {
          dependencies.watchMode.showStatus();
          return;
        }

        dependencies.logger.show(true);
        void vscode.window.showInformationMessage('Sphinx Doctor is active, but watch mode is unavailable.');
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sphinxDoctor.troubleshootEnvironment', async () => {
      await runSafely(dependencies.logger, 'Troubleshoot Environment', async () => {
        if (!dependencies.watchMode) {
          dependencies.logger.show(true);
          void vscode.window.showInformationMessage(
            'Sphinx Doctor is active, but watch mode is unavailable.',
          );
          return;
        }

        const reportContent = dependencies.watchMode.buildTroubleshootReport();
        const reportUri = await writeTroubleshootReport(context, reportContent);
        const document = await vscode.workspace.openTextDocument(reportUri);
        const reportLocation = reportUri.fsPath || reportUri.toString();

        dependencies.logger.info(`Saved troubleshoot report: ${reportLocation}`);
        await vscode.window.showTextDocument(document, { preview: false });
        vscode.window.setStatusBarMessage(
          `Sphinx Doctor troubleshoot report saved: ${path.basename(reportLocation)}`,
          5000,
        );
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sphinxDoctor.runSphinxBuild', async () => {
      await runSafely(dependencies.logger, 'Run Sphinx Build', async () => {
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
      });
    }),
  );
}