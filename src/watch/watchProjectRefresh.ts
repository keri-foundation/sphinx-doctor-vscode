import path from 'node:path';

import * as vscode from 'vscode';

import { getExtensionConfig, projectLabel } from '../config/extensionConfig';
import {
  buildEnrichmentRunPlan,
  evaluateRefreshBaselinePromotion,
  formatRefreshScopeDriftWarning,
  getEnrichmentPermission,
  runEnrichmentPlan,
} from '../enrichment/enrichmentRunner';
import {
  buildRefreshRunPlan,
  filterRecentInventoryCandidates,
  getRefreshPermission,
  inferRefreshScopeFromContract,
  inferProjectRefreshConfig,
  runRefreshPlan,
} from '../refresh/refreshRunner';
import {
  inspectDiagnosticsFile,
  inspectDiagnosticsFileBinding,
  isDiagnosticsBindingCompatible,
  loadDiagnosticsFromPath,
} from '../diagnostics/loadDiagnostics';
import { SphinxDoctorLogger } from '../logging/extensionLogger';
import { DiagnosticsPublicationIndex } from '../publication/publicationIndex';
import {
  publishDiagnosticsBatch,
  PublishBatchEntry,
} from '../publication/publishDiagnostics';
import {
  ConfiguredProject,
  ExtensionConfig,
  summarizeDiagnosticMode,
  WorkspaceFolderInfo,
} from '../types';
import {
  findWorkspaceFolderByName,
  selectInventoryCandidate,
} from '../workspace/inventoryCandidates';
import {
  summarizeProjectPublicationSnapshots,
} from './watchModeState';
import { WatchDiagnosticsState } from './watchDiagnosticsState';
import { WatchEventSuppression } from './watchEventSuppression';

interface DiscoveredInventoryCandidate {
  uri: vscode.Uri;
  filePath: string;
  fileName: string;
  directoryPath: string;
  modifiedTime: number;
  workspaceFolderName: string;
}

interface PreparedProjectEntry extends PublishBatchEntry {
  project: ConfiguredProject;
  loadedPath: string;
  loadedIssueCount: number;
  publishableIssueCount: number;
}

function inventorySearchTargets(project: ConfiguredProject) {
  return project.inventorySearchTargets && project.inventorySearchTargets.length > 0
    ? project.inventorySearchTargets
    : [
        {
          workspaceFolderName: project.inventoryWorkspaceFolder,
          globs: project.inventorySearchGlobs,
        },
      ];
}

function projectSourceRoot(
  project: ConfiguredProject,
  workspaceFolders: WorkspaceFolderInfo[],
): string | undefined {
  const sourceFolder = findWorkspaceFolderByName(workspaceFolders, project.sourceWorkspaceFolder);
  if (!sourceFolder) {
    return undefined;
  }

  return path.resolve(sourceFolder.fsPath, project.repoRoot ?? '.');
}

function projectLatestDiagnosticsPath(
  project: ConfiguredProject,
  workspaceFolders: WorkspaceFolderInfo[],
): string | undefined {
  const sourceFolder = findWorkspaceFolderByName(workspaceFolders, project.sourceWorkspaceFolder);
  if (!sourceFolder) {
    return undefined;
  }

  return path.resolve(
    sourceFolder.fsPath,
    project.repoRoot ?? '.',
    project.mirrorRoot ?? '.sphinx-diagnostics',
    'latest.json',
  );
}

export interface WatchProjectRefreshDeps {
  collection: vscode.DiagnosticCollection;
  publicationIndex: DiagnosticsPublicationIndex<vscode.Uri>;
  logger: SphinxDoctorLogger;
  diagnosticsState: WatchDiagnosticsState;
  eventSuppression: WatchEventSuppression;
  extensionRoot: string;
  onAggregateChanged(result: PublishProjectResult): void;
  onError(message: string): void;
  onStatusControllerReset(): void;
}

export interface PublishProjectResult {
  projectId: string;
  projectCount: number;
  publishedDiagnostics: number;
  message?: string;
}

export class WatchProjectRefreshRunner {
  constructor(private readonly deps: WatchProjectRefreshDeps) {}

  async prepareProjectEntry(
    project: ConfiguredProject,
    config: ExtensionConfig,
    workspaceFolders: WorkspaceFolderInfo[],
  ): Promise<PreparedProjectEntry | undefined> {
    const selected = await this.selectCandidateImpl(project, workspaceFolders);
    if (!selected) {
      return undefined;
    }

    if (selected.kind === 'enriched') {
      const contract = await loadDiagnosticsFromPath(selected.candidate.filePath);
      const publishableIssueCount = summarizeDiagnosticMode(
        contract.issues,
        config.diagnosticsMode,
      ).publishableBeforeFilter;
      this.deps.logger.info({
        name: SphinxDoctorLogger.LogEvents.PROJECT_REFRESH_LOADED,
        fields: {
          projectId: project.id,
          issues: contract.issues.length,
          publishableBeforeFilter: publishableIssueCount,
          mode: config.diagnosticsMode,
        },
      });
      return {
        project,
        projectKey: project.id,
        contract,
        loadedPath: selected.candidate.filePath,
        loadedIssueCount: contract.issues.length,
        publishableIssueCount,
        defaultSourceWorkspaceFolder: project.sourceWorkspaceFolder,
        defaultRepoRoot: project.repoRoot,
      };
    }

    if (selected.kind === 'raw') {
      const permission = getEnrichmentPermission(vscode.workspace.isTrusted, config.enrichmentEnabled);
      if (!config.enrichmentAutoRun) {
        this.setProjectStatus(
          project.id,
          `found raw diagnostics at ${selected.candidate.filePath}, but auto-enrichment is disabled so Problems remain empty until manual enrichment runs.`,
        );
        return undefined;
      }

      if (!permission.allowed) {
        this.setProjectStatus(
          project.id,
          `found raw diagnostics at ${selected.candidate.filePath}, but auto-enrichment is blocked: ${permission.reason ?? 'permission denied'}`,
        );
        return undefined;
      }

      const plan = buildEnrichmentRunPlan({
        extensionRoot: this.deps.extensionRoot,
        pythonInterpreter: config.pythonInterpreter,
        project,
        workspaceFolders,
        rawIssuesPath: selected.candidate.filePath,
      });
      this.deps.logger.info({
        name: SphinxDoctorLogger.LogEvents.PROJECT_REFRESH_AUTO_ENRICH_START,
        fields: { projectId: project.id },
      });
      const result = await runEnrichmentPlan(plan);
      const contract = await loadDiagnosticsFromPath(result.plan.latestOutputPath);
      const publishableIssueCount = summarizeDiagnosticMode(
        contract.issues,
        config.diagnosticsMode,
      ).publishableBeforeFilter;
      this.deps.logger.info({
        name: SphinxDoctorLogger.LogEvents.PROJECT_REFRESH_AUTO_ENRICH_COMPLETE,
        fields: {
          projectId: project.id,
          issues: contract.issues.length,
          publishableBeforeFilter: publishableIssueCount,
          mode: config.diagnosticsMode,
        },
      });
      return {
        project,
        projectKey: project.id,
        contract,
        loadedPath: result.plan.latestOutputPath,
        loadedIssueCount: contract.issues.length,
        publishableIssueCount,
        defaultSourceWorkspaceFolder: project.sourceWorkspaceFolder,
        defaultRepoRoot: project.repoRoot,
      };
    }

    if (selected.kind === 'unknown') {
      this.setProjectStatus(
        project.id,
        `found diagnostics artifact at ${selected.candidate.filePath}, but its JSON shape is not recognized as enriched diagnostics or raw inventory.`,
      );
      return undefined;
    }

    return undefined;
  }

  setProjectStatus(projectId: string, status: string): void {
    this.deps.diagnosticsState.setProjectStatus(projectId, status);
    this.deps.logger.info({
        name: SphinxDoctorLogger.LogEvents.PROJECT_REFRESH_STATUS,
        fields: { projectId, status },
      });
  }

  async selectCandidate(
    project: ConfiguredProject,
    workspaceFolders: WorkspaceFolderInfo[],
  ): Promise<{ candidate: DiscoveredInventoryCandidate; kind: 'enriched' | 'raw' | 'unknown' } | undefined> {
    return this.selectCandidateImpl(project, workspaceFolders);
  }

  async runProjectRefreshLifecycle(
    project: ConfiguredProject,
    workspaceFolders: WorkspaceFolderInfo[],
    reason: string,
    knownProjectCount: number,
    summaryProjectCount: number,
  ): Promise<void> {
    try {
      const refreshResolution = await inferProjectRefreshConfig({
        project,
        workspaceFolders,
      });
      if (!refreshResolution.config) {
        this.setProjectStatus(
          project.id,
          `auto refresh unavailable: ${refreshResolution.reason ?? 'no refresh configuration'}`,
        );
        return;
      }

      const permission = getRefreshPermission(vscode.workspace.isTrusted, refreshResolution.config);
      if (!permission.allowed) {
        this.setProjectStatus(
          project.id,
          `auto refresh blocked: ${permission.reason ?? 'permission denied'}`,
        );
        return;
      }

      const latestOutputPath = projectLatestDiagnosticsPath(project, workspaceFolders);
      let refreshCategory: string | undefined;
      if (latestOutputPath) {
        try {
          refreshCategory = inferRefreshScopeFromContract(
            await loadDiagnosticsFromPath(latestOutputPath),
          );
        } catch {
          refreshCategory = undefined;
        }
      }

      const refreshPlan = buildRefreshRunPlan({
        project,
        refresh: refreshResolution.config,
        workspaceFolders,
        refreshCategory,
      });
      this.deps.logger.info({
        name: SphinxDoctorLogger.LogEvents.PROJECT_REFRESH_RUNNING,
        fields: { projectId: project.id, reason, command: refreshPlan.command },
      });
      const refreshResult = await runRefreshPlan(refreshPlan);
      this.deps.logger.info({
        name: SphinxDoctorLogger.LogEvents.PROJECT_REFRESH_FINISHED,
        fields: { projectId: project.id, reason, exitCode: refreshResult.exitCode },
      });

      if (refreshResult.exitCode !== 0) {
        const detail =
          refreshResult.stderr.trim() || refreshResult.stdout.trim() || 'Unknown refresh failure.';
        throw new Error(`Refresh exited with code ${refreshResult.exitCode}: ${detail}`);
      }

      const refreshed = await this.resolveFreshRefreshCandidate(project, workspaceFolders, refreshPlan);
      if (!refreshed) {
        this.setProjectStatus(
          project.id,
          `${reason} completed, but no fresh compatible diagnostics artifacts were produced.`,
        );
        return;
      }

      if (refreshed.kind === 'unknown') {
        this.setProjectStatus(
          project.id,
          `${reason} found ${refreshed.candidate.filePath}, but the artifact shape is not recognized.`,
        );
        return;
      }

      if (refreshed.kind === 'enriched') {
        const latestOutputPath = projectLatestDiagnosticsPath(project, workspaceFolders);
        if (!latestOutputPath) {
          this.setProjectStatus(
            project.id,
            `${reason} produced enriched diagnostics, but the source workspace folder could not be resolved for latest.json promotion.`,
          );
          return;
        }

        const promotion = await evaluateRefreshBaselinePromotion({
          currentBaselinePath: latestOutputPath,
          refreshedDiagnosticsPath: refreshed.candidate.filePath,
          latestOutputPath,
        });
        if (promotion.drift.detected) {
          const warning = `${formatRefreshScopeDriftWarning(projectLabel(project), promotion.drift)} Refreshed run preserved at ${refreshed.candidate.filePath}.`;
          this.deps.logger.warn({
          name: SphinxDoctorLogger.LogEvents.PROJECT_REFRESH_DRIFT_WARNING,
          fields: { projectId: project.id },
        });
          this.setProjectStatus(project.id, warning);
          void vscode.window.showWarningMessage(warning);
          return;
        }

        this.setProjectStatus(
          project.id,
          `${reason} promoted enriched diagnostics to ${promotion.activeDiagnosticsPath}.`,
        );
        this.deps.eventSuppression.recordSuppressed([
          refreshed.candidate.filePath,
          promotion.activeDiagnosticsPath,
        ]);
        await this.publishProjectDiagnosticsFromPath(
          project,
          promotion.activeDiagnosticsPath,
          `${reason}: project-scoped republish`,
          knownProjectCount,
          summaryProjectCount,
        );
        return;
      }

      const config = getExtensionConfig();
      const enrichmentPermission = getEnrichmentPermission(
        vscode.workspace.isTrusted,
        config.enrichmentEnabled,
      );
      if (!enrichmentPermission.allowed) {
        this.setProjectStatus(
          project.id,
          `${reason} produced raw diagnostics, but enrichment is blocked: ${enrichmentPermission.reason ?? 'permission denied'}`,
        );
        return;
      }

      const enrichmentPlan = buildEnrichmentRunPlan({
        extensionRoot: this.deps.extensionRoot,
        pythonInterpreter: config.pythonInterpreter,
        project,
        workspaceFolders,
        rawIssuesPath: refreshed.candidate.filePath,
      });
      this.deps.logger.info({
        name: SphinxDoctorLogger.LogEvents.PROJECT_REFRESH_ENRICHING,
        fields: { projectId: project.id },
      });
      await runEnrichmentPlan(enrichmentPlan, { promoteLatest: false });
      const promotion = await evaluateRefreshBaselinePromotion({
        currentBaselinePath: enrichmentPlan.latestOutputPath,
        refreshedDiagnosticsPath: enrichmentPlan.archiveOutputPath,
        latestOutputPath: enrichmentPlan.latestOutputPath,
      });
      if (promotion.drift.detected) {
        const warning = `${formatRefreshScopeDriftWarning(projectLabel(project), promotion.drift)} Refreshed run preserved at ${enrichmentPlan.archiveOutputPath}.`;
        this.deps.logger.warn({
          name: SphinxDoctorLogger.LogEvents.PROJECT_REFRESH_DRIFT_WARNING,
          fields: { projectId: project.id },
        });
        this.setProjectStatus(project.id, warning);
        void vscode.window.showWarningMessage(warning);
        return;
      }

      this.setProjectStatus(project.id, `${reason} wrote ${promotion.activeDiagnosticsPath}.`);
      this.deps.eventSuppression.recordSuppressed([
        refreshed.candidate.filePath,
        enrichmentPlan.archiveOutputPath,
        promotion.activeDiagnosticsPath,
      ]);
      await this.publishProjectDiagnosticsFromPath(
        project,
        promotion.activeDiagnosticsPath,
        `${reason}: project-scoped republish`,
        knownProjectCount,
        summaryProjectCount,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.onError(message);
      this.setProjectStatus(project.id, `error: ${message}`);
      this.deps.logger.error({
        name: SphinxDoctorLogger.LogEvents.PROJECT_REFRESH_FAILED,
        fields: { projectId: project.id, reason, errorMessage: message },
      });
    }
  }

  private async selectCandidateImpl(
    project: ConfiguredProject,
    workspaceFolders: WorkspaceFolderInfo[],
  ): Promise<{ candidate: DiscoveredInventoryCandidate; kind: 'enriched' | 'raw' | 'unknown' } | undefined> {
    const sourceFolder = findWorkspaceFolderByName(workspaceFolders, project.sourceWorkspaceFolder);
    if (sourceFolder) {
      const mirrorLatestUri = vscode.Uri.file(
        path.resolve(sourceFolder.fsPath, project.repoRoot ?? '.', project.mirrorRoot ?? '.sphinx-diagnostics', 'latest.json'),
      );
      this.deps.logger.info({
        name: SphinxDoctorLogger.LogEvents.PROJECT_MIRROR_CHECK,
        fields: { projectId: project.id },
      });
      try {
        await vscode.workspace.fs.stat(mirrorLatestUri);
        const kind = await inspectDiagnosticsFile(mirrorLatestUri.fsPath);
        this.deps.logger.info({
        name: SphinxDoctorLogger.LogEvents.PROJECT_MIRROR_KIND,
        fields: { projectId: project.id, kind },
      });
        if (kind === 'enriched') {
          const stat = await vscode.workspace.fs.stat(mirrorLatestUri);
          this.deps.logger.info({
        name: SphinxDoctorLogger.LogEvents.PROJECT_MIRROR_SELECTED,
        fields: { projectId: project.id },
      });
          return {
            candidate: {
              uri: mirrorLatestUri,
              filePath: mirrorLatestUri.fsPath,
              fileName: path.basename(mirrorLatestUri.fsPath),
              directoryPath: path.dirname(mirrorLatestUri.fsPath),
              modifiedTime: stat.mtime,
              workspaceFolderName: sourceFolder.name,
            },
            kind,
          };
        }
      } catch {
        this.deps.logger.info({
        name: SphinxDoctorLogger.LogEvents.PROJECT_MIRROR_MISSING,
        fields: { projectId: project.id },
      });
      }
    }

    const candidates = await this.discoverProjectDiagnosticsCandidates(project, workspaceFolders);
    if (candidates.length === 0) {
      this.setProjectStatus(project.id, 'no inventory artifacts found for configured search globs.');
      return undefined;
    }

    const sourceRoot = projectSourceRoot(project, workspaceFolders);
    if (!sourceRoot) {
      this.setProjectStatus(
        project.id,
        `source workspace folder ${project.sourceWorkspaceFolder} is not open, so shared inventory artifacts cannot be bound safely.`,
      );
      return undefined;
    }

    const compatibleCandidates: DiscoveredInventoryCandidate[] = [];
    for (const candidate of candidates) {
      const binding = await inspectDiagnosticsFileBinding(candidate.filePath);
      const compatibility = isDiagnosticsBindingCompatible(binding, {
        sourceWorkspaceFolder: project.sourceWorkspaceFolder,
        sourceRoot,
      });
      if (!compatibility.compatible) {
        this.deps.logger.warn({
        name: SphinxDoctorLogger.LogEvents.PROJECT_CANDIDATE_INCOMPATIBLE,
        fields: { projectId: project.id },
      });
        continue;
      }
      compatibleCandidates.push(candidate);
    }

    if (compatibleCandidates.length === 0) {
      this.setProjectStatus(
        project.id,
        'inventory artifacts were found, but none matched the open source workspace folder safely.',
      );
      return undefined;
    }

    const selection = selectInventoryCandidate(project, compatibleCandidates, project.preferredInventoryFiles);
    if (!selection.selected) {
      if (selection.ambiguous && selection.ambiguous.length > 0) {
        this.setProjectStatus(
          project.id,
          `inventory discovery is ambiguous across ${selection.ambiguous.length} candidates, so watch mode did not guess.`,
        );
      }
      return undefined;
    }

    const kind = await inspectDiagnosticsFile(selection.selected.filePath);
    this.deps.logger.info({
        name: SphinxDoctorLogger.LogEvents.PROJECT_CANDIDATE_SELECTED,
        fields: { projectId: project.id, kind },
      });
    return {
      candidate: selection.selected,
      kind,
    };
  }

  private async discoverProjectDiagnosticsCandidates(
    project: ConfiguredProject,
    workspaceFolders: WorkspaceFolderInfo[],
  ): Promise<DiscoveredInventoryCandidate[]> {
    const foundUris = new Map<string, vscode.Uri>();
    const uriOrigins = new Map<string, string>();

    for (const searchTarget of inventorySearchTargets(project)) {
      const inventoryFolder = findWorkspaceFolderByName(workspaceFolders, searchTarget.workspaceFolderName);
      if (!inventoryFolder) {
        this.deps.logger.warn({
        name: SphinxDoctorLogger.LogEvents.PROJECT_NO_CANDIDATE,
        fields: { projectId: project.id },
      });
        continue;
      }

      for (const inventorySearchGlob of searchTarget.globs) {
        const relativePattern = new vscode.RelativePattern(inventoryFolder.fsPath, inventorySearchGlob);
        const matches = await vscode.workspace.findFiles(relativePattern);
        this.deps.logger.info({
        name: SphinxDoctorLogger.LogEvents.PROJECT_CANDIDATE_SEARCH,
        fields: { projectId: project.id, matchCount: matches.length },
      });
        for (const match of matches) {
          foundUris.set(match.toString(), match);
          uriOrigins.set(match.toString(), searchTarget.workspaceFolderName);
        }
      }
    }

    const candidates: DiscoveredInventoryCandidate[] = [];
    for (const uri of foundUris.values()) {
      const stat = await vscode.workspace.fs.stat(uri);
      candidates.push({
        uri,
        filePath: uri.fsPath,
        fileName: path.basename(uri.fsPath),
        directoryPath: path.dirname(uri.fsPath),
        modifiedTime: stat.mtime,
        workspaceFolderName: uriOrigins.get(uri.toString()) ?? project.inventoryWorkspaceFolder,
      });
    }

    this.deps.logger.info({
        name: SphinxDoctorLogger.LogEvents.PROJECT_CANDIDATES,
        fields: { projectId: project.id, candidateCount: candidates.length },
      });

    return candidates;
  }

  private async publishProjectDiagnosticsFromPath(
    project: ConfiguredProject,
    diagnosticsPath: string,
    reason: string,
    knownProjectCount: number,
    summaryProjectCount: number,
  ): Promise<void> {
    const config = getExtensionConfig();
    const contract = await loadDiagnosticsFromPath(diagnosticsPath);
    const result = publishDiagnosticsBatch(
      this.deps.collection,
      [
        {
          contract,
          projectKey: project.id,
          defaultSourceWorkspaceFolder: project.sourceWorkspaceFolder,
          defaultRepoRoot: project.repoRoot,
        },
      ],
      {
        workspaceFolders: vscode.workspace.workspaceFolders,
        diagnosticMode: config.diagnosticsMode,
        replaceMode: 'project',
        publicationIndex: this.deps.publicationIndex,
        logger: this.deps.logger,
      },
    );

    this.deps.diagnosticsState.setProjectPublication(project.id, {
      loaded: true,
      loadedPath: diagnosticsPath,
      issueCount: result.issueCount,
      publishableBeforeFilter: result.publishableBeforeFilter,
      publishedDiagnostics: result.publishedDiagnostics,
      filteredByMode: result.filteredByMode,
      skippedIssues: result.skippedIssues,
      resolutionFailures: result.resolutionFailures,
    });
    this.deps.diagnosticsState.setRawPendingCount(0);
    this.deps.diagnosticsState.setErrorCount(0);
    this.deps.onStatusControllerReset();

    this.deps.onAggregateChanged({
      projectId: project.id,
      projectCount: knownProjectCount || Math.max(summaryProjectCount, 1),
      publishedDiagnostics: result.publishedDiagnostics,
      message:
        result.publishedDiagnostics > 0
          ? `Watching ${knownProjectCount || Math.max(summaryProjectCount, 1)} projects in ${config.diagnosticsMode} mode with ${summarizeProjectPublicationSnapshots(this.deps.diagnosticsState.getProjectPublications().values()).issueCount} issues, ${summarizeProjectPublicationSnapshots(this.deps.diagnosticsState.getProjectPublications().values()).publishableBeforeFilter} publishable before filter, and ${summarizeProjectPublicationSnapshots(this.deps.diagnosticsState.getProjectPublications().values()).publishedDiagnostics} published diagnostics.`
          : undefined,
    });

    this.setProjectStatus(
      project.id,
      `${reason} published ${result.publishedDiagnostics} diagnostics from ${diagnosticsPath}.`,
    );
  }

  private async resolveFreshRefreshCandidate(
    project: ConfiguredProject,
    workspaceFolders: WorkspaceFolderInfo[],
    refreshPlan: {
      startedAtMs: number;
      expectedOutputGlobs: string[];
    },
  ): Promise<{ candidate: DiscoveredInventoryCandidate; kind: 'enriched' | 'raw' | 'unknown' } | undefined> {
    const inventoryFolder = findWorkspaceFolderByName(workspaceFolders, project.inventoryWorkspaceFolder);
    if (!inventoryFolder) {
      this.deps.logger.warn({
        name: SphinxDoctorLogger.LogEvents.PROJECT_NO_CANDIDATE,
        fields: { projectId: project.id },
      });
      return undefined;
    }

    const discovered: DiscoveredInventoryCandidate[] = [];
    for (const inventorySearchGlob of refreshPlan.expectedOutputGlobs) {
      const matches = await vscode.workspace.findFiles(
        new vscode.RelativePattern(inventoryFolder.fsPath, inventorySearchGlob),
      );
      for (const match of matches) {
        const stat = await vscode.workspace.fs.stat(match);
        discovered.push({
          uri: match,
          filePath: match.fsPath,
          fileName: path.basename(match.fsPath),
          directoryPath: path.dirname(match.fsPath),
          modifiedTime: stat.mtime,
          workspaceFolderName: project.inventoryWorkspaceFolder,
        });
      }
    }

    const freshCandidates = filterRecentInventoryCandidates(discovered, refreshPlan.startedAtMs);
    const sourceRoot = projectSourceRoot(project, workspaceFolders);
    if (!sourceRoot) {
      return undefined;
    }

    const compatible: DiscoveredInventoryCandidate[] = [];
    for (const candidate of freshCandidates) {
      const binding = await inspectDiagnosticsFileBinding(candidate.filePath);
      const compatibility = isDiagnosticsBindingCompatible(binding, {
        sourceWorkspaceFolder: project.sourceWorkspaceFolder,
        sourceRoot,
      });
      if (!compatibility.compatible) {
        this.deps.logger.warn({
        name: SphinxDoctorLogger.LogEvents.PROJECT_CANDIDATE_INCOMPATIBLE,
        fields: { projectId: project.id },
      });
        continue;
      }
      compatible.push(candidate);
    }

    const selected = selectInventoryCandidate(project, compatible, project.preferredInventoryFiles).selected;
    if (!selected) {
      return undefined;
    }

    const kind = await inspectDiagnosticsFile(selected.filePath);
    this.deps.logger.info({
        name: SphinxDoctorLogger.LogEvents.PROJECT_CANDIDATE_SELECTED,
        fields: { projectId: project.id, kind },
      });
    return {
      candidate: selected,
      kind,
    };
  }
}
