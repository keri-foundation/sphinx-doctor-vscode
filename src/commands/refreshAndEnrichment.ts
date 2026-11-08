import path from 'node:path';

import * as vscode from 'vscode';

import { getExtensionConfig, projectLabel } from '../config/extensionConfig';
import { loadDiagnosticsFromPath } from '../diagnostics/loadDiagnostics';
import {
  buildEnrichmentRunPlan,
  evaluateRefreshBaselinePromotion,
  formatRefreshScopeDriftWarning,
  getEnrichmentPermission,
  runEnrichmentPlan,
} from '../enrichment/enrichmentRunner';
import { SphinxDoctorLogger } from '../logging/extensionLogger';
import {
  buildRefreshRunPlan,
  getRefreshPermission,
  inferProjectRefreshConfig,
  inferRefreshScopeFromContract,
  runRefreshPlan,
} from '../refresh/refreshRunner';
import type { ConfiguredProject, WorkspaceFolderInfo } from '../types';
import { findWorkspaceFolderByName } from '../workspace/inventoryCandidates';

import {
  type CommandDependencies,
  loadAndPublish,
  loadSelectedProjectDiagnostics,
  readLastLoadedDiagnosticsState,
} from './diagnosticsLoading';
import {
  resolveProjectDiagnosticsFile,
  resolveProjectDiagnosticsFileFromSearchTargets,
  toWorkspaceFolderInfo,
} from './projectSelection';

function logProcessOutput(
  logger: SphinxDoctorLogger,
  label: string,
  output: string,
): void {
  const trimmed = output.trim();
  if (!trimmed) {
    return;
  }

  const lines = trimmed.split(/\r?\n/).slice(0, 5).join(' | ');
  logger.debug({
    name: SphinxDoctorLogger.LogEvents.ENRICHMENT_DEBUG_LINES,
    fields: { label, lines },
  });
}

function resolveProjectLatestDiagnosticsPath(
  project: ConfiguredProject,
  workspaceFolders: WorkspaceFolderInfo[],
): string {
  const sourceFolder = findWorkspaceFolderByName(workspaceFolders, project.sourceWorkspaceFolder);
  if (!sourceFolder) {
    throw new Error(
      `Source workspace folder "${project.sourceWorkspaceFolder}" could not be resolved for project ${project.id}.`,
    );
  }

  return path.resolve(
    sourceFolder.fsPath,
    project.repoRoot ?? '.',
    project.mirrorRoot ?? '.sphinx-diagnostics',
    'latest.json',
  );
}

interface ActiveRefreshBaseline {
  filePath: string;
  contract?: import('../types').DiagnosticsContract;
}

async function resolveActiveRefreshBaseline(
  context: vscode.ExtensionContext,
  project: ConfiguredProject,
  workspaceFolders: WorkspaceFolderInfo[],
): Promise<ActiveRefreshBaseline> {
  const latestOutputPath = resolveProjectLatestDiagnosticsPath(project, workspaceFolders);
  const lastLoaded = readLastLoadedDiagnosticsState(context);
  if (lastLoaded) {
    try {
      const diagnosticsUri = vscode.Uri.parse(lastLoaded.fileUri);
      const contract = await loadDiagnosticsFromPath(diagnosticsUri.fsPath);
      if (contract.workspace.sourceWorkspaceFolder === project.sourceWorkspaceFolder) {
        return {
          filePath: diagnosticsUri.fsPath,
          contract,
        };
      }
    } catch {
      // Fall back to the repo mirror latest.json baseline.
    }
  }

  try {
    return {
      filePath: latestOutputPath,
      contract: await loadDiagnosticsFromPath(latestOutputPath),
    };
  } catch {
    return { filePath: latestOutputPath };
  }
}

export async function runRefreshAndLoadProjectDiagnostics(
  context: vscode.ExtensionContext,
  dependencies: CommandDependencies,
  project: ConfiguredProject,
): Promise<void> {
  const config = getExtensionConfig();
  const workspaceFolders = toWorkspaceFolderInfo(vscode.workspace.workspaceFolders);
  const refreshResolution = await inferProjectRefreshConfig({
    project,
    workspaceFolders,
  });

  if (!refreshResolution.config) {
    void vscode.window.showWarningMessage(
      refreshResolution.reason ??
        `No refresh configuration is available for ${projectLabel(project)}.`,
    );
    return;
  }

  const permission = getRefreshPermission(vscode.workspace.isTrusted, refreshResolution.config);
  if (!permission.allowed) {
    void vscode.window.showWarningMessage(permission.reason ?? 'Sphinx Doctor refresh is unavailable.');
    return;
  }

  const activeBaseline = await resolveActiveRefreshBaseline(context, project, workspaceFolders);
  const refreshCategory = inferRefreshScopeFromContract(activeBaseline.contract);

  const refreshPlan = buildRefreshRunPlan({
    project,
    refresh: refreshResolution.config,
    workspaceFolders,
    refreshCategory,
  });
  dependencies.logger.info({
    name: SphinxDoctorLogger.LogEvents.ENRICHMENT_REFRESH_FAILED,
    fields: { projectId: project.id, source: refreshResolution.source ?? 'configured' },
  });

  const refreshResult = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Sphinx Doctor: Refreshing diagnostics for ${projectLabel(project)}`,
    },
    async () => runRefreshPlan(refreshPlan),
  );

  dependencies.logger.info({
    name: SphinxDoctorLogger.LogEvents.ENRICHMENT_START,
    fields: { projectId: project.id, exitCode: refreshResult.exitCode },
  });
  logProcessOutput(dependencies.logger, 'Refresh stdout', refreshResult.stdout);
  logProcessOutput(dependencies.logger, 'Refresh stderr', refreshResult.stderr);

  if (refreshResult.exitCode !== 0) {
    const detail =
      refreshResult.stderr.trim() || refreshResult.stdout.trim() || 'Unknown refresh failure.';
    throw new Error(`Refresh exited with code ${refreshResult.exitCode}: ${detail}`);
  }

  const refreshedDiagnostics = await resolveProjectDiagnosticsFileFromSearchTargets(
    project,
    dependencies.logger,
    [
      {
        workspaceFolderName: project.inventoryWorkspaceFolder,
        globs: refreshPlan.expectedOutputGlobs,
      },
    ],
    `No fresh compatible diagnostics files were produced for ${projectLabel(project)}.`,
    refreshPlan.startedAtMs,
  );
  if (!refreshedDiagnostics) {
    return;
  }

  if (refreshedDiagnostics.kind === 'enriched') {
    const latestOutputPath = resolveProjectLatestDiagnosticsPath(project, workspaceFolders);
    const promotion = await evaluateRefreshBaselinePromotion({
      currentBaselinePath: activeBaseline.filePath,
      refreshedDiagnosticsPath: refreshedDiagnostics.candidate.filePath,
      latestOutputPath,
    });

    if (promotion.drift.detected) {
      const warning = `${formatRefreshScopeDriftWarning(projectLabel(project), promotion.drift)} Refreshed run preserved at ${refreshedDiagnostics.candidate.filePath}.`;
      dependencies.logger.warn({
        name: SphinxDoctorLogger.LogEvents.ENRICHMENT_DRIFT_WARNING,
        fields: { projectId: project.id },
      });
      void vscode.window.showWarningMessage(warning);
      return;
    }

    await loadAndPublish(context, vscode.Uri.file(promotion.activeDiagnosticsPath), dependencies, {
      replaceMode: 'project',
      projectKey: project.id,
      defaultSourceWorkspaceFolderOverride: project.sourceWorkspaceFolder,
      defaultRepoRootOverride: project.repoRoot,
    });
    return;
  }

  if (refreshedDiagnostics.kind === 'raw') {
    const enrichmentPermission = getEnrichmentPermission(
      vscode.workspace.isTrusted,
      config.enrichmentEnabled,
    );
    if (!enrichmentPermission.allowed) {
      void vscode.window.showWarningMessage(
        enrichmentPermission.reason ?? 'Sphinx Doctor enrichment is unavailable.',
      );
      return;
    }

    const enrichmentResult = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Sphinx Doctor: Enriching refreshed diagnostics for ${projectLabel(project)}`,
      },
      async () => {
        const plan = buildEnrichmentRunPlan({
          extensionRoot: context.extensionUri.fsPath,
          pythonInterpreter: config.pythonInterpreter,
          project,
          workspaceFolders,
          rawIssuesPath: refreshedDiagnostics.candidate.filePath,
        });

        dependencies.logger.info({
          name: SphinxDoctorLogger.LogEvents.ENRICHMENT_START,
          fields: { projectId: project.id },
        });

        const result = await runEnrichmentPlan(plan, { promoteLatest: false });
        dependencies.logger.info({
          name: SphinxDoctorLogger.LogEvents.ENRICHMENT_COMPLETED,
          fields: { projectId: project.id, exitCode: result.exitCode },
        });
        logProcessOutput(dependencies.logger, 'Refresh enrichment stdout', result.stdout);
        logProcessOutput(dependencies.logger, 'Refresh enrichment stderr', result.stderr);
        return result;
      },
    );

    const promotion = await evaluateRefreshBaselinePromotion({
      currentBaselinePath: activeBaseline.filePath,
      refreshedDiagnosticsPath: enrichmentResult.plan.archiveOutputPath,
      latestOutputPath: enrichmentResult.plan.latestOutputPath,
    });

    if (promotion.drift.detected) {
      const warning = `${formatRefreshScopeDriftWarning(projectLabel(project), promotion.drift)} Refreshed run preserved at ${enrichmentResult.plan.archiveOutputPath}.`;
      dependencies.logger.warn({
        name: SphinxDoctorLogger.LogEvents.ENRICHMENT_DRIFT_WARNING,
        fields: { projectId: project.id },
      });
      void vscode.window.showWarningMessage(warning);
      return;
    }

    await loadAndPublish(
      context,
      vscode.Uri.file(promotion.activeDiagnosticsPath),
      dependencies,
      {
        replaceMode: 'project',
        projectKey: project.id,
        defaultSourceWorkspaceFolderOverride: project.sourceWorkspaceFolder,
        defaultRepoRootOverride: project.repoRoot,
      },
    );
    return;
  }

  if (refreshedDiagnostics.kind === 'unknown') {
    void vscode.window.showWarningMessage(
      `Sphinx Doctor found refreshed diagnostics for ${projectLabel(project)}, but the JSON shape is not recognized as raw inventory or enriched diagnostics.`,
    );
    return;
  }

  void vscode.window.showWarningMessage(
    `Sphinx Doctor could not recognize refreshed diagnostics JSON for ${projectLabel(project)}.`,
  );
}

export async function loadOrEnrichProjectDiagnostics(
  context: vscode.ExtensionContext,
  dependencies: CommandDependencies,
  project: ConfiguredProject,
  allowEnrichment: boolean,
): Promise<void> {
  const selected = await resolveProjectDiagnosticsFile(project, dependencies.logger);
  if (!selected) {
    return;
  }

  if (selected.kind === 'enriched') {
    await loadSelectedProjectDiagnostics(context, dependencies, selected);
    return;
  }

  if (selected.kind === 'raw') {
    if (!allowEnrichment) {
      dependencies.logger.warn({
        name: SphinxDoctorLogger.LogEvents.ENRICHMENT_SELECTED_RAW,
        fields: { projectId: project.id },
      });
      void vscode.window.showWarningMessage(
        `Sphinx Doctor found raw issues.json for ${projectLabel(project)}. Run Sphinx Doctor: Enrich and Load Project Diagnostics to transform and publish it.`,
      );
      return;
    }

    const config = getExtensionConfig();
    const permission = getEnrichmentPermission(vscode.workspace.isTrusted, config.enrichmentEnabled);
    if (!permission.allowed) {
      void vscode.window.showWarningMessage(permission.reason ?? 'Sphinx Doctor enrichment is unavailable.');
      return;
    }

    const runResult = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Sphinx Doctor: Enriching diagnostics for ${projectLabel(project)}`,
      },
      async () => {
        const plan = buildEnrichmentRunPlan({
          extensionRoot: context.extensionUri.fsPath,
          pythonInterpreter: config.pythonInterpreter,
          project,
          workspaceFolders: toWorkspaceFolderInfo(vscode.workspace.workspaceFolders),
          rawIssuesPath: selected.candidate.filePath,
        });

        dependencies.logger.info({
          name: SphinxDoctorLogger.LogEvents.ENRICHMENT_START,
          fields: { projectId: project.id },
        });

        const result = await runEnrichmentPlan(plan);
        dependencies.logger.info({
          name: SphinxDoctorLogger.LogEvents.ENRICHMENT_COMPLETED,
          fields: { projectId: project.id, exitCode: result.exitCode },
        });
        logProcessOutput(dependencies.logger, 'Enrichment stdout', result.stdout);
        logProcessOutput(dependencies.logger, 'Enrichment stderr', result.stderr);
        return result;
      },
    );

    await loadAndPublish(context, vscode.Uri.file(runResult.plan.archiveOutputPath), dependencies, {
      replaceMode: 'project',
      projectKey: project.id,
      defaultSourceWorkspaceFolderOverride: project.sourceWorkspaceFolder,
      defaultRepoRootOverride: project.repoRoot,
    });
    return;
  }

  if (selected.kind === 'unknown') {
    void vscode.window.showWarningMessage(
      `Sphinx Doctor found a diagnostics JSON for ${projectLabel(project)}, but the file is not recognized as raw inventory or enriched diagnostics.`,
    );
    return;
  }

  void vscode.window.showWarningMessage(
    `Sphinx Doctor could not recognize the selected diagnostics JSON for ${projectLabel(project)}.`,
  );
}
