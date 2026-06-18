import * as vscode from 'vscode';

import { getExtensionConfig } from '../config/extensionConfig';
import { SphinxDoctorLogger } from '../logging/extensionLogger';
import { DiagnosticsPublicationIndex } from '../publication/publicationIndex';
import { publishDiagnosticsBatch, computeDiagnosticsAccounting, PublishResult } from '../publication/publishDiagnostics';
import { discoverWorkspaceProjectDecisions, listGitWorktreesPorcelain, mergeProjects } from '../workspace/projectDiscovery';
import {
  ConfiguredProject,
  ExtensionConfig,
  WorkspaceFolderInfo,
} from '../types';
import {
  createSingleFlightController,
  createDebouncedTrigger,
  DebouncedTrigger,
  hasOpenWorkspaceFolders,
} from './watchModeState';
import { WatchDiagnosticsState } from './watchDiagnosticsState';
import { WatchProjectRefreshRunner } from './watchProjectRefresh';

interface PreparedProjectEntry {
  project: ConfiguredProject;
  projectKey?: string;
  contract: any;
  loadedPath: string;
  loadedIssueCount: number;
  publishableIssueCount: number;
  defaultSourceWorkspaceFolder: string;
  defaultRepoRoot?: string;
  fixtureSourceRoot?: string;
  allowFirstFolderFallback?: boolean;
}

function logDiscoveryDecisions(
  logger: SphinxDoctorLogger,
  decisions: Array<{
    workspaceFolderName: string;
    outcome: 'discovered' | 'skipped';
    reason: string;
  }>,
): void {
  for (const decision of decisions) {
    const prefix = decision.outcome === 'discovered' ? 'Discovery include' : 'Discovery skip';
    logger.info(`${prefix} ${decision.workspaceFolderName}: ${decision.reason}.`);
  }
}

function toWorkspaceFolderInfo(
  workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined,
): WorkspaceFolderInfo[] {
  return (workspaceFolders ?? []).map((folder) => ({
    name: folder.name,
    fsPath: folder.uri.fsPath,
  }));
}

const NOOP_PUBLISH_LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface WatchRefreshCoordinatorDeps {
  collection: vscode.DiagnosticCollection;
  publicationIndex: DiagnosticsPublicationIndex<vscode.Uri>;
  logger: SphinxDoctorLogger;
  diagnosticsState: WatchDiagnosticsState;
  projectRunner: WatchProjectRefreshRunner;
  onAggregateChanged(result: {
    projectCount: number;
    diagnosticMode: ExtensionConfig['diagnosticsMode'];
    watcherCount: number;
    rawPendingCount: number;
    errorCount: number;
    message?: string;
  }): void;
  getWatcherCount(): number;
  getKnownProjectIds(): string[];
  getStatusSummaryProjectCount(): number;
  syncWatchers(projects: ConfiguredProject[], workspaceFolders: WorkspaceFolderInfo[]): Promise<void>;
  onRefreshBookkeeping(info: {
    discoveredProjectIds: string[];
    knownProjectIds: string[];
  }): void;
  onProjectError(message: string): void;
}

export class WatchRefreshCoordinator {
  private refreshTrigger: DebouncedTrigger | undefined;
  private autoRefreshTriggers = new Map<string, DebouncedTrigger>();
  private readonly projectRefreshSingleFlight = createSingleFlightController();

  constructor(private readonly deps: WatchRefreshCoordinatorDeps) {}

  scheduleRefresh(reason: string): void {
    this.refreshTrigger?.trigger(reason);
  }

  async refreshAll(reason: string, loadDiagnostics = true): Promise<void> {
    const config = getExtensionConfig();
    this.deps.logger.setLevel(config.logLevel);
    const workspaceFolders = toWorkspaceFolderInfo(vscode.workspace.workspaceFolders);

    this.deps.logger.info(
      `Watch refresh requested (${reason}): workspace folders [${workspaceFolders.map((f) => f.name).join(', ') || 'none'}].`,
    );
    this.deps.logger.info(
      `Configured projects (${config.projects.length}): [${config.projects.map((p) => p.id).join(', ') || 'none'}].`,
    );

    if (!hasOpenWorkspaceFolders(workspaceFolders)) {
      this.deps.publicationIndex.clear(this.deps.collection);
      this.deps.logger.info(`Watch refresh skipped (${reason}): no workspace folders.`);
      this.deps.diagnosticsState.clear();
      this.deps.onAggregateChanged({
        projectCount: 0,
        diagnosticMode: config.diagnosticsMode,
        watcherCount: this.deps.getWatcherCount(),
        rawPendingCount: this.deps.diagnosticsState.getRawPendingCount(),
        errorCount: this.deps.diagnosticsState.getErrorCount(),
      });
      return;
    }

    const discoveryDecisions = config.discoveryEnabled
      ? await discoverWorkspaceProjectDecisions(
          workspaceFolders,
          {
            includeLowConfidence: config.discoveryIncludeLowConfidence,
            inventoryWorkspaceFolderNames: config.discoveryInventoryWorkspaceFolderNames,
            excludeWorkspaceFolderNames: config.discoveryExcludeWorkspaceFolders,
            knownProjects: config.projects,
          },
          {
            exists: async (filePath) => {
              try {
                await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
                return true;
              } catch {
                return false;
              }
            },
            readText: async (filePath) => {
              try {
                const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
                return Buffer.from(content).toString('utf8');
              } catch {
                return undefined;
              }
            },
            listGitWorktrees:
              vscode.workspace.isTrusted === true ? listGitWorktreesPorcelain : undefined,
          },
        )
      : [];

    logDiscoveryDecisions(this.deps.logger, discoveryDecisions);
    const discoveredProjects = discoveryDecisions.flatMap((decision) =>
      decision.project ? [decision.project] : [],
    );

    this.deps.logger.info(
      `Discovered projects (${discoveredProjects.length}): [${discoveredProjects.map((p) => p.id).join(', ') || 'none'}].`,
    );

    const projects = mergeProjects(config.projects, discoveredProjects);

    this.deps.logger.info(
      `Known projects (${projects.length}): [${projects.map((p) => p.id).join(', ') || 'none'}].`,
    );

    this.deps.logger.info(
      `Watch refresh started (${reason}): ${projects.length} projects, ${discoveredProjects.length} discovered.`,
    );

    await this.deps.syncWatchers(projects, workspaceFolders);
    this.deps.onRefreshBookkeeping({
      discoveredProjectIds: discoveredProjects.map((p) => p.id),
      knownProjectIds: projects.map((p) => p.id),
    });

    if (!loadDiagnostics) {
      this.deps.diagnosticsState.clearProjectPublications();
      this.deps.diagnosticsState.clear();
      this.deps.onAggregateChanged({
        projectCount: projects.length,
        diagnosticMode: config.diagnosticsMode,
        watcherCount: this.deps.getWatcherCount(),
        rawPendingCount: this.deps.diagnosticsState.getRawPendingCount(),
        errorCount: this.deps.diagnosticsState.getErrorCount(),
        message:
          projects.length > 0
            ? `Watching ${projects.length} projects for diagnostics changes.`
            : 'No configured or discoverable Sphinx projects in the current workspace.',
      });
      return;
    }

    this.deps.diagnosticsState.clearProjectPublications();
    for (const project of projects) {
      this.deps.diagnosticsState.setProjectPublication(project.id, {
        loaded: false,
        issueCount: 0,
        publishableBeforeFilter: 0,
        publishedDiagnostics: 0,
        filteredByMode: 0,
        skippedIssues: 0,
        resolutionFailures: 0,
      });
    }

    const entries: PreparedProjectEntry[] = [];
    let rawPendingCount = 0;
    let errorCount = 0;

    for (const project of projects) {
      try {
        const entry = await this.deps.projectRunner.prepareProjectEntry(project, config, workspaceFolders);
        if (entry) {
          entries.push(entry as PreparedProjectEntry);
        }
      } catch (error) {
        errorCount += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.deps.onProjectError(message);
        this.deps.projectRunner.setProjectStatus(project.id, `error: ${message}`);
        this.deps.logger.error(`Watch refresh failed for ${project.id}: ${message}`);
      }
    }

    for (const project of projects) {
      const prepared = entries.find((entry) => entry.project.id === project.id);
      if (!prepared) {
        const candidate = await this.deps.projectRunner.selectCandidate(project, workspaceFolders);
        if (candidate && candidate.kind === 'raw') {
          rawPendingCount += 1;
        }
      }
    }

    let publishResult: PublishResult = {
      issueCount: 0,
      publishableBeforeFilter: 0,
      publishedDiagnostics: 0,
      targetUriCount: 0,
      filteredByMode: 0,
      skippedIssues: 0,
      resolutionFailures: 0,
    };

    if (entries.length === 0) {
      this.deps.publicationIndex.deleteKnownTargets(this.deps.collection);
    } else {
      publishResult = publishDiagnosticsBatch(this.deps.collection, entries, {
        workspaceFolders: vscode.workspace.workspaceFolders,
        diagnosticMode: config.diagnosticsMode,
        replaceMode: 'full',
        publicationIndex: this.deps.publicationIndex,
        logger: this.deps.logger,
      });
    }

    for (const entry of entries) {
      const accounting = computeDiagnosticsAccounting(entry.contract, {
        workspaceFolders: vscode.workspace.workspaceFolders,
        diagnosticMode: config.diagnosticsMode,
        defaultSourceWorkspaceFolder: entry.defaultSourceWorkspaceFolder,
        defaultRepoRoot: entry.defaultRepoRoot,
        fixtureSourceRoot: entry.fixtureSourceRoot,
        allowFirstFolderFallback: entry.allowFirstFolderFallback,
        logger: NOOP_PUBLISH_LOGGER,
      });

      this.deps.diagnosticsState.setProjectPublication(entry.project.id, {
        loaded: true,
        loadedPath: entry.loadedPath,
        issueCount: accounting.issueCount,
        publishableBeforeFilter: accounting.publishableBeforeFilter,
        publishedDiagnostics: accounting.publishedDiagnostics,
        filteredByMode: accounting.filteredByMode,
        skippedIssues: accounting.skippedIssues,
        resolutionFailures: accounting.resolutionFailures,
      });
    }

    this.deps.diagnosticsState.setRawPendingCount(rawPendingCount);
    this.deps.diagnosticsState.setErrorCount(errorCount);
    this.deps.onAggregateChanged({
      projectCount: projects.length,
      diagnosticMode: config.diagnosticsMode,
      watcherCount: this.deps.getWatcherCount(),
      rawPendingCount,
      errorCount,
      message:
        errorCount > 0
          ? 'Sphinx Doctor watch mode hit an error. Check the output channel.'
          : undefined,
    });

    if (entries.length > 0) {
      this.deps.logger.info(
        `Loaded diagnostics files: [${this.deps.diagnosticsState.getProjectPublications().size}].`,
      );
    } else {
      this.deps.logger.warn('No diagnostics files were loaded for any known project during this refresh.');
    }
    this.deps.logger.info(
      `Watch refresh completed (${reason}): mode=${config.diagnosticsMode}; loaded ${entries.length} files, ${publishResult.issueCount} issues, ${publishResult.publishableBeforeFilter} publishable before filter, ${publishResult.publishedDiagnostics} published diagnostics across ${publishResult.targetUriCount} target URIs, ${publishResult.filteredByMode} filtered by mode, ${publishResult.skippedIssues} skipped, ${publishResult.resolutionFailures} resolution failures.`,
    );
  }

  resetRefreshTrigger(debounceMs: number): void {
    this.refreshTrigger?.dispose();
    this.refreshTrigger = createDebouncedTrigger((reason) => this.refreshAll(reason, true), debounceMs);
    this.disposeAutoRefreshTriggers();
  }

  disposeAutoRefreshTriggers(): void {
    for (const trigger of this.autoRefreshTriggers.values()) {
      trigger.dispose();
    }
    this.autoRefreshTriggers.clear();
  }

  getProjectRefreshTrigger(projectId: string, debounceMs: number): DebouncedTrigger {
    const existing = this.autoRefreshTriggers.get(projectId);
    if (existing) {
      return existing;
    }

    const trigger = createDebouncedTrigger(
      (reason) => this.runAutoRefreshForProject(projectId, reason),
      debounceMs,
    );
    this.autoRefreshTriggers.set(projectId, trigger);
    return trigger;
  }

  async runStartupProjectRefreshes(): Promise<void> {
    const config = getExtensionConfig();
    if (!config.refreshAutoRunOnStartup) {
      return;
    }

    if (vscode.workspace.isTrusted !== true) {
      this.deps.logger.info('Skipping startup refreshes because the workspace is not trusted.');
      return;
    }

    const workspaceFolders = toWorkspaceFolderInfo(vscode.workspace.workspaceFolders);
    const projects = await this.resolveKnownProjects(config, workspaceFolders);
    for (const project of projects) {
      await this.runProjectRefreshLifecycle(project, workspaceFolders, 'startup auto refresh');
    }
  }

  async runAutoRefreshForProject(projectId: string, reason: string): Promise<void> {
    const config = getExtensionConfig();
    if (!config.refreshAutoRunOnSave) {
      return;
    }

    const workspaceFolders = toWorkspaceFolderInfo(vscode.workspace.workspaceFolders);
    const projects = await this.resolveKnownProjects(config, workspaceFolders);
    const project = projects.find((entry) => entry.id === projectId);
    if (!project) {
      this.deps.logger.warn(`Skipping refresh-on-save for ${projectId}: project is no longer known.`);
      return;
    }

    this.deps.logger.info(`Starting save-triggered refresh for ${project.id}: ${reason}.`);
    await this.runProjectRefreshLifecycle(project, workspaceFolders, `refresh-on-save (${reason})`);
    this.deps.logger.info(`Completed save-triggered refresh for ${project.id}: ${reason}.`);
  }

  async runProjectRefreshLifecycle(
    project: ConfiguredProject,
    workspaceFolders: WorkspaceFolderInfo[],
    reason: string,
  ): Promise<void> {
    if (!this.projectRefreshSingleFlight.tryStart(project.id)) {
      this.deps.logger.info(`Skipping ${reason} for ${project.id} because a refresh is already running.`);
      return;
    }

    try {
      await this.deps.projectRunner.runProjectRefreshLifecycle(
        project,
        workspaceFolders,
        reason,
        this.deps.getKnownProjectIds().length,
        this.deps.getStatusSummaryProjectCount(),
      );
    } finally {
      this.projectRefreshSingleFlight.finish(project.id);
    }
  }

  dispose(): void {
    this.refreshTrigger?.dispose();
    this.disposeAutoRefreshTriggers();
  }

  public async resolveKnownProjects(
    config: ExtensionConfig,
    workspaceFolders: WorkspaceFolderInfo[],
  ): Promise<ConfiguredProject[]> {
    const discoveryDecisions = config.discoveryEnabled
      ? await discoverWorkspaceProjectDecisions(
          workspaceFolders,
          {
            includeLowConfidence: config.discoveryIncludeLowConfidence,
            inventoryWorkspaceFolderNames: config.discoveryInventoryWorkspaceFolderNames,
            excludeWorkspaceFolderNames: config.discoveryExcludeWorkspaceFolders,
            knownProjects: config.projects,
          },
          {
            exists: async (filePath) => {
              try {
                await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
                return true;
              } catch {
                return false;
              }
            },
            readText: async (filePath) => {
              try {
                const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
                return Buffer.from(content).toString('utf8');
              } catch {
                return undefined;
              }
            },
            listGitWorktrees:
              vscode.workspace.isTrusted === true ? listGitWorktreesPorcelain : undefined,
          },
        )
      : [];

    logDiscoveryDecisions(this.deps.logger, discoveryDecisions);
    const discoveredProjects = discoveryDecisions.flatMap((decision) =>
      decision.project ? [decision.project] : [],
    );

    return mergeProjects(config.projects, discoveredProjects);
  }
}
