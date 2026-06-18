import path from 'node:path';

import * as vscode from 'vscode';

import {
  projectLabel,
} from './config/extensionConfig';
import { loadAllDiscoveredDiagnostics } from './diagnostics/loadAllDiagnostics';
import {
  buildSelfTestStatusTooltip,
  clearPublishedDiagnostics,
  createSelfTestDiagnosticSpec,
  publishSelfTestDiagnostic,
  SELF_TEST_COMMAND_ID,
  SELF_TEST_FALLBACK_RELATIVE_PATH,
  SELF_TEST_STATUS_TEXT,
} from './commands/selfTestDiagnostic';
import {
  discoverOnlyProject,
  selectConfiguredProject,
  selectMergedProject,
} from './commands/projectSelection';
import { runSafely } from './commands/runSafely';
import { runSphinxBuildDirect } from './commands/directRun';
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
        await runSphinxBuildDirect(dependencies);
      });
    }),
  );
}