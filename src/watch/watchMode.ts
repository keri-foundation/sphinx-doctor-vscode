import path from 'node:path';

import * as vscode from 'vscode';

import { getExtensionConfig } from '../config/extensionConfig';
import { SphinxDoctorLogger } from '../logging/extensionLogger';
import { DiagnosticsPublicationIndex } from '../publication/publicationIndex';
import {
  computeDiagnosticsAccounting,
  publishDiagnosticsBatch,
  PublishBatchEntry,
  PublishResult,
} from '../publication/publishDiagnostics';
import { discoverWorkspaceProjectDecisions, listGitWorktreesPorcelain, mergeProjects } from '../workspace/projectDiscovery';
import {
  ConfiguredProject,
  ExtensionConfig,
  WorkspaceFolderInfo,
} from '../types';
import { WatchModeSummary } from '../types';
import {
  findWorkspaceFolderByName,
} from '../workspace/inventoryCandidates';
import {
  buildWatchModeSummary,
  createSingleFlightController,
  createDebouncedTrigger,
  DebouncedTrigger,
  getRefreshOnSaveDecision,
  getRefreshOnSaveDebounceMs,
  hasOpenWorkspaceFolders,
  runWatchModeStartup,
} from './watchModeState';
import {
  buildTroubleshootReport,
} from './watchFormatting';
import { WatchStatusController } from './watchStatus';
import { WatchDiagnosticsState } from './watchDiagnosticsState';
import { WatchEventSuppression } from './watchEventSuppression';
import { WatchProjectRefreshRunner } from './watchProjectRefresh';

const NOOP_PUBLISH_LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface PreparedProjectEntry extends PublishBatchEntry {
  project: ConfiguredProject;
  loadedPath: string;
  loadedIssueCount: number;
  publishableIssueCount: number;
}

interface WatchPattern {
  key: string;
  basePath: string;
  glob: string;
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

function toRelativeGlob(...segments: string[]): string {
  return segments.filter((segment) => segment.length > 0 && segment !== '.').join('/');
}

function buildMirrorLatestRelativePath(project: ConfiguredProject): string {
  return toRelativeGlob(project.repoRoot ?? '.', project.mirrorRoot ?? '.sphinx-diagnostics', 'latest.json');
}

function buildWatchPatterns(
  project: ConfiguredProject,
  workspaceFolders: WorkspaceFolderInfo[],
): WatchPattern[] {
  const patterns: WatchPattern[] = [];
  const sourceFolder = findWorkspaceFolderByName(workspaceFolders, project.sourceWorkspaceFolder);
  if (sourceFolder) {
    const glob = buildMirrorLatestRelativePath(project);
    patterns.push({
      key: `${sourceFolder.name}::${glob}`,
      basePath: sourceFolder.fsPath,
      glob,
    });
  }

  for (const searchTarget of inventorySearchTargets(project)) {
    const inventoryFolder = findWorkspaceFolderByName(workspaceFolders, searchTarget.workspaceFolderName);
    if (!inventoryFolder) {
      continue;
    }

    for (const glob of searchTarget.globs) {
      patterns.push({
        key: `${inventoryFolder.name}::${glob}`,
        basePath: inventoryFolder.fsPath,
        glob,
      });
    }
  }

  return patterns;
}

export {
  applyExtensionModeBadge,
  buildTroubleshootReport,
  describeExtensionMode,
  type TroubleshootReportState,
} from './watchFormatting';

export class SphinxDoctorWatchMode implements vscode.Disposable {
  private readonly statusController: WatchStatusController;
  private readonly diagnosticsState = new WatchDiagnosticsState();
  private readonly eventSuppression = new WatchEventSuppression();
  private readonly refreshRunner: WatchProjectRefreshRunner;

  private watchers = new Map<string, vscode.FileSystemWatcher>();

  private refreshTrigger: DebouncedTrigger | undefined;

  private autoRefreshTriggers = new Map<string, DebouncedTrigger>();

  private readonly projectRefreshSingleFlight = createSingleFlightController();

  private activated = false;

  private lastRefreshReason = 'not-run';

  private lastError: string | undefined;

  private lastWorkspaceFolders: string[] = [];

  private lastConfiguredProjectIds: string[] = [];

  private lastDiscoveredProjectIds: string[] = [];

  private lastKnownProjectIds: string[] = [];

  private lastLoadedDiagnosticsFiles: string[] = [];

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly collection: vscode.DiagnosticCollection,
    private readonly logger: SphinxDoctorLogger,
    private readonly publicationIndex: DiagnosticsPublicationIndex<vscode.Uri>,
  ) {
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusItem.command = 'sphinxDoctor.showStatus';
    this.statusController = new WatchStatusController(statusItem, this.context.extensionMode);

    this.refreshRunner = new WatchProjectRefreshRunner({
      collection: this.collection,
      publicationIndex: this.publicationIndex,
      logger: this.logger,
      diagnosticsState: this.diagnosticsState,
      eventSuppression: this.eventSuppression,
      extensionRoot: this.context.extensionUri?.fsPath ?? '',
      onAggregateChanged: (result) => {
        this.applyAggregateState({
          projectCount: result.projectCount,
          diagnosticMode: getExtensionConfig().diagnosticsMode,
          watcherCount: this.watchers.size,
          rawPendingCount: this.diagnosticsState.getRawPendingCount(),
          errorCount: this.diagnosticsState.getErrorCount(),
          message: result.message,
        });
      },
      onError: (message) => {
        this.lastError = message;
      },
      onStatusControllerReset: () => {
        this.statusController.setManualDiagnosticsActive(false);
      },
    });

    this.context.subscriptions.push(
      statusItem,
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.restart('workspace folders changed');
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('sphinxDoctor')) {
          void this.restart('configuration changed');
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        void this.handleDidSaveTextDocument(document);
      }),
    );
  }

  public async start(): Promise<void> {
    this.activated = true;
    this.statusController.show();
    const config = getExtensionConfig();
    this.logger.setLevel(config.logLevel);
    this.logger.info(
      `Watch mode startup: enabled=${config.watchEnabled}, autoLoadOnStartup=${config.watchAutoLoadOnStartup}, mode=${config.diagnosticsMode}, autoRun=${config.enrichmentAutoRun}, trusted=${vscode.workspace.isTrusted === true}.`,
    );
    this.resetRefreshTrigger(config.watchDebounceMs);
    await runWatchModeStartup({
      config,
      refresh: async (reason, loadDiagnostics) => {
        await this.refreshAll(reason, loadDiagnostics);
      },
    });
    if (config.refreshAutoRunOnStartup) {
      void this.runStartupProjectRefreshes();
    }
    if (!config.watchEnabled) {
      this.lastError = undefined;
      this.statusController.applySummary(
        buildWatchModeSummary({
          projectCount: 0,
          loadedProjectCount: 0,
          issueCount: 0,
          publishableBeforeFilter: 0,
          publishedDiagnostics: 0,
          watcherCount: 0,
          rawPendingCount: 0,
          errorCount: 0,
          diagnosticMode: config.diagnosticsMode,
          message: 'Sphinx Doctor watch mode is disabled by settings.',
        }),
      );
    }
  }

  public async restart(reason: string): Promise<void> {
    const config = getExtensionConfig();
    this.logger.setLevel(config.logLevel);
    this.resetRefreshTrigger(config.watchDebounceMs);
    if (!config.watchEnabled) {
      this.disposeWatchers();
      this.publicationIndex.clear(this.collection);
      this.lastRefreshReason = reason;
      this.lastError = undefined;
      this.lastLoadedDiagnosticsFiles = [];
      this.diagnosticsState.clear();
      this.statusController.applySummary(
        buildWatchModeSummary({
          projectCount: 0,
          loadedProjectCount: 0,
          issueCount: 0,
          publishableBeforeFilter: 0,
          publishedDiagnostics: 0,
          watcherCount: 0,
          rawPendingCount: 0,
          errorCount: 0,
          diagnosticMode: config.diagnosticsMode,
          message: 'Sphinx Doctor watch mode is disabled by settings.',
        }),
      );
      return;
    }

    await this.refreshAll(reason, config.watchAutoLoadOnStartup);
  }

  public scheduleRefresh(reason: string): void {
    this.refreshTrigger?.trigger(reason);
  }

  public async refreshAll(reason: string, loadDiagnostics = true): Promise<void> {
    const config = getExtensionConfig();
    this.logger.setLevel(config.logLevel);
    const workspaceFolders = toWorkspaceFolderInfo(vscode.workspace.workspaceFolders);
    this.lastRefreshReason = reason;
    this.lastError = undefined;
    this.lastWorkspaceFolders = workspaceFolders.map((folder) => folder.name);
    this.lastConfiguredProjectIds = config.projects.map((project) => project.id);
    this.diagnosticsState.clearProjectStatuses();

    this.logger.info(
      `Watch refresh requested (${reason}): workspace folders [${this.lastWorkspaceFolders.join(', ') || 'none'}].`,
    );
    this.logger.info(
      `Configured projects (${this.lastConfiguredProjectIds.length}): [${this.lastConfiguredProjectIds.join(', ') || 'none'}].`,
    );

    if (!hasOpenWorkspaceFolders(workspaceFolders)) {
      this.disposeWatchers();
      this.publicationIndex.clear(this.collection);
      const summary = buildWatchModeSummary({
        projectCount: 0,
        loadedProjectCount: 0,
        issueCount: 0,
        publishableBeforeFilter: 0,
        publishedDiagnostics: 0,
        watcherCount: 0,
        rawPendingCount: 0,
        errorCount: 0,
        diagnosticMode: config.diagnosticsMode,
        message: 'No workspace folders are open, so Sphinx Doctor watch mode is idle.',
      });
      this.logger.info(`Watch refresh skipped (${reason}): no workspace folders.`);
      this.lastDiscoveredProjectIds = [];
      this.lastKnownProjectIds = [];
      this.lastLoadedDiagnosticsFiles = [];
      this.diagnosticsState.clear();
      this.statusController.applySummary(summary);
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

    logDiscoveryDecisions(this.logger, discoveryDecisions);
    const discoveredProjects = discoveryDecisions.flatMap((decision) =>
      decision.project ? [decision.project] : [],
    );

    this.lastDiscoveredProjectIds = discoveredProjects.map((project) => project.id);
    this.logger.info(
      `Discovered projects (${this.lastDiscoveredProjectIds.length}): [${this.lastDiscoveredProjectIds.join(', ') || 'none'}].`,
    );

    const projects = mergeProjects(config.projects, discoveredProjects);
    this.lastKnownProjectIds = projects.map((project) => project.id);
    this.logger.info(
      `Known projects (${this.lastKnownProjectIds.length}): [${this.lastKnownProjectIds.join(', ') || 'none'}].`,
    );
    await this.syncWatchers(projects, workspaceFolders);
    this.logger.info(
      `Watch refresh started (${reason}): ${projects.length} projects, ${discoveredProjects.length} discovered, ${this.watchers.size} watchers.`,
    );

    if (!loadDiagnostics) {
      this.diagnosticsState.clearProjectPublications();
      this.lastLoadedDiagnosticsFiles = [];
      this.diagnosticsState.clear();
      this.statusController.applySummary(
        buildWatchModeSummary({
          projectCount: projects.length,
          loadedProjectCount: 0,
          issueCount: 0,
          publishableBeforeFilter: 0,
          publishedDiagnostics: 0,
          watcherCount: this.watchers.size,
          rawPendingCount: 0,
          errorCount: 0,
          diagnosticMode: config.diagnosticsMode,
          message:
            projects.length > 0
              ? `Watching ${projects.length} projects for diagnostics changes.`
              : 'No configured or discoverable Sphinx projects in the current workspace.',
        }),
      );
      return;
    }

    this.diagnosticsState.clearProjectPublications();
    for (const project of projects) {
      this.diagnosticsState.setProjectPublication(project.id, {
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
        const prepared = await this.prepareProjectEntry(project, config, workspaceFolders);
        if (prepared) {
          entries.push(prepared);
          this.setProjectStatus(
            project.id,
            `loaded ${prepared.loadedPath} with ${prepared.loadedIssueCount} issues and ${prepared.publishableIssueCount} publishable diagnostics before mode filter.`,
          );
        } else {
          const mirrorRelativePath = buildMirrorLatestRelativePath(project);
          this.logger.debug(
            `No diagnostics loaded for ${project.id}; looked for ${mirrorRelativePath} and configured inventory globs.`,
          );
          if (!this.diagnosticsState.getProjectStatuses().has(project.id)) {
            this.setProjectStatus(
              project.id,
              `no diagnostics loaded; looked for ${mirrorRelativePath} and configured inventory globs.`,
            );
          }
        }
      } catch (error) {
        errorCount += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.lastError = message;
        this.setProjectStatus(project.id, `error: ${message}`);
        this.logger.error(`Watch refresh failed for ${project.id}: ${message}`);
      }
    }

    for (const project of projects) {
      const prepared = entries.find((entry) => entry.project.id === project.id);
      if (!prepared) {
        const candidate = await this.refreshRunner.selectCandidate(project, workspaceFolders);
        if (candidate && candidate.kind === 'raw') {
          rawPendingCount += 1;
        }
      }
    }

    let publishResult: PublishResult = {
      issueCount: 0,
      publishableBeforeFilter: 0,
      publishedDiagnostics: 0,
      filteredByMode: 0,
      targetUriCount: 0,
      skippedIssues: 0,
      resolutionFailures: 0,
    };

    if (entries.length > 0) {
      publishResult = publishDiagnosticsBatch(this.collection, entries, {
        workspaceFolders: vscode.workspace.workspaceFolders,
        diagnosticMode: config.diagnosticsMode,
        replaceMode: 'full',
        publicationIndex: this.publicationIndex,
        logger: this.logger,
      });
    } else {
      // Delete only watch-owned targets to preserve manual direct-run diagnostics
      this.publicationIndex.deleteKnownTargets(this.collection);
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
      this.diagnosticsState.setProjectPublication(entry.project.id, {
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

    this.diagnosticsState.setRawPendingCount(rawPendingCount);
    this.diagnosticsState.setErrorCount(errorCount);
    this.applyAggregateState({
      projectCount: projects.length,
      diagnosticMode: config.diagnosticsMode,
      watcherCount: this.watchers.size,
      rawPendingCount,
      errorCount,
      message:
        errorCount > 0
          ? 'Sphinx Doctor watch mode hit an error. Check the output channel.'
          : undefined,
    });

    if (entries.length > 0) {
      this.logger.info(
        `Loaded diagnostics files: [${this.lastLoadedDiagnosticsFiles.join(', ')}].`,
      );
    } else {
      this.logger.warn('No diagnostics files were loaded for any known project during this refresh.');
    }
    this.logger.info(
      `Watch refresh completed (${reason}): mode=${config.diagnosticsMode}; loaded ${entries.length} files, ${publishResult.issueCount} issues, ${publishResult.publishableBeforeFilter} publishable before filter, ${publishResult.publishedDiagnostics} published diagnostics across ${publishResult.targetUriCount} target URIs, ${publishResult.filteredByMode} filtered by mode, ${publishResult.skippedIssues} skipped, ${publishResult.resolutionFailures} resolution failures, ${this.watchers.size} watchers.`,
    );
  }

  public showStatus(): void {
    const currentSummary = this.statusController.getSummary();
    const lines = [
      'Sphinx Doctor status report:',
      `- activated: ${this.activated}`,
      `- watch summary: ${currentSummary.state}`,
      `- last refresh reason: ${this.lastRefreshReason}`,
      `- workspace folders: ${this.lastWorkspaceFolders.join(', ') || 'none'}`,
      `- configured projects: ${this.lastConfiguredProjectIds.join(', ') || 'none'}`,
      `- discovered projects: ${this.lastDiscoveredProjectIds.join(', ') || 'none'}`,
      `- known projects: ${this.lastKnownProjectIds.join(', ') || 'none'}`,
      `- diagnostic mode: ${currentSummary.diagnosticMode}`,
      `- last loaded diagnostics: ${this.lastLoadedDiagnosticsFiles.join(', ') || 'none'}`,
      `- last issue count: ${this.diagnosticsState.getIssueCount()}`,
      `- last publishable-before-filter count: ${this.diagnosticsState.getPublishableBeforeFilterCount()}`,
      `- last published count: ${this.diagnosticsState.getPublishedCount()}`,
      `- last filtered-by-mode count: ${this.diagnosticsState.getFilteredByModeCount()}`,
      `- last skipped count: ${this.diagnosticsState.getSkippedCount()}`,
      `- last URI resolution failures: ${this.diagnosticsState.getResolutionFailureCount()}`,
      `- last error: ${this.lastError ?? 'none'}`,
    ];

    for (const [projectId, status] of this.diagnosticsState.getProjectStatuses().entries()) {
      lines.push(`- project ${projectId}: ${status}`);
    }

    for (const line of lines) {
      this.logger.info(line);
    }
    this.logger.show(true);
    void vscode.window.showInformationMessage(currentSummary.message);
  }

  public buildTroubleshootReport(): string {
    return buildTroubleshootReport({
      extensionMode: this.context.extensionMode,
      extensionPath: this.context.extensionPath,
      isWorkspaceTrusted: vscode.workspace.isTrusted === true,
      config: getExtensionConfig(),
      state: {
        activated: this.activated,
        workspaceFolders: [...this.lastWorkspaceFolders],
        configuredProjects: [...this.lastConfiguredProjectIds],
        discoveredProjects: [...this.lastDiscoveredProjectIds],
        knownProjects: [...this.lastKnownProjectIds],
        lastRefreshReason: this.lastRefreshReason,
        lastLoadedDiagnosticsFiles: [...this.lastLoadedDiagnosticsFiles],
        lastIssueCount: this.diagnosticsState.getIssueCount(),
        lastPublishableBeforeFilterCount: this.diagnosticsState.getPublishableBeforeFilterCount(),
        lastPublishedCount: this.diagnosticsState.getPublishedCount(),
        lastFilteredByModeCount: this.diagnosticsState.getFilteredByModeCount(),
        lastSkippedCount: this.diagnosticsState.getSkippedCount(),
        lastResolutionFailureCount: this.diagnosticsState.getResolutionFailureCount(),
        lastRawPendingCount: this.diagnosticsState.getRawPendingCount(),
        lastErrorCount: this.diagnosticsState.getErrorCount(),
        lastError: this.lastError,
        summary: this.statusController.getSummary(),
        projectStatuses: [...this.diagnosticsState.getProjectStatuses().entries()],
      },
    });
  }

  public noteManualClear(): void {
    this.statusController.setManualDiagnosticsActive(false);
    const currentSummary = this.statusController.getSummary();
    this.statusController.applySummary(
      buildWatchModeSummary({
        projectCount: currentSummary.projectCount,
        loadedProjectCount: 0,
        issueCount: 0,
        publishableBeforeFilter: 0,
        publishedDiagnostics: 0,
        watcherCount: this.watchers.size,
        rawPendingCount: 0,
        errorCount: 0,
        diagnosticMode: currentSummary.diagnosticMode,
        message: 'Sphinx Doctor diagnostics cleared.',
      }),
    );
  }

  public noteSelfTestDiagnosticPublished(
    targetUri: vscode.Uri,
    diagnosticCount: number,
    tooltip: string,
  ): void {
    this.statusController.applySelfTestStatus(targetUri, diagnosticCount, tooltip);
  }

  public noteManualDiagnosticsPublished(options: {
    filePath: string;
    issueCount: number;
    publishableBeforeFilter: number;
    publishedDiagnostics: number;
    filteredByMode: number;
    skippedIssues: number;
    resolutionFailures: number;
    message: string;
  }): void {
    this.lastRefreshReason = 'manual load';
    this.lastError = undefined;
    this.lastLoadedDiagnosticsFiles = [options.filePath];
    this.diagnosticsState.applyManualCounters({
      issueCount: options.issueCount,
      publishableBeforeFilter: options.publishableBeforeFilter,
      publishedDiagnostics: options.publishedDiagnostics,
      filteredByMode: options.filteredByMode,
      skippedIssues: options.skippedIssues,
      resolutionFailures: options.resolutionFailures,
    });
    this.statusController.setManualDiagnosticsActive(options.publishedDiagnostics > 0);
    const currentSummary = this.statusController.getSummary();
    this.statusController.applySummary(
      buildWatchModeSummary({
        projectCount: Math.max(currentSummary.projectCount, 1),
        loadedProjectCount: 1,
        issueCount: options.issueCount,
        publishableBeforeFilter: options.publishableBeforeFilter,
        publishedDiagnostics: options.publishedDiagnostics,
        watcherCount: this.watchers.size,
        rawPendingCount: 0,
        errorCount: 0,
        diagnosticMode: currentSummary.diagnosticMode,
        message: options.message,
      }),
    );
  }

  public getSummary(): WatchModeSummary {
    return this.statusController.getSummary();
  }

  public getLastRefreshSnapshot(): {
    discoveredProjectCount: number;
    knownProjectCount: number;
    loadedProjectCount: number;
    skippedProjectCount: number;
    issueCount: number;
    publishedDiagnostics: number;
  } {
    const loadedProjectCount = this.lastLoadedDiagnosticsFiles.length;
    const knownProjectCount = this.lastKnownProjectIds.length;
    return {
      discoveredProjectCount: this.lastDiscoveredProjectIds.length,
      knownProjectCount,
      loadedProjectCount,
      skippedProjectCount: Math.max(0, knownProjectCount - loadedProjectCount),
      issueCount: this.diagnosticsState.getIssueCount(),
      publishedDiagnostics: this.diagnosticsState.getPublishedCount(),
    };
  }

  public dispose(): void {
    this.refreshTrigger?.dispose();
    this.disposeAutoRefreshTriggers();
    this.disposeWatchers();
    this.statusController.dispose();
  }

  private resetRefreshTrigger(debounceMs: number): void {
    this.refreshTrigger?.dispose();
    this.refreshTrigger = createDebouncedTrigger((reason) => this.refreshAll(reason, true), debounceMs);
    this.disposeAutoRefreshTriggers();
  }

  private disposeAutoRefreshTriggers(): void {
    for (const trigger of this.autoRefreshTriggers.values()) {
      trigger.dispose();
    }
    this.autoRefreshTriggers.clear();
  }

  private applyAggregateState(options: {
    projectCount: number;
    diagnosticMode: ExtensionConfig['diagnosticsMode'];
    watcherCount: number;
    rawPendingCount: number;
    errorCount: number;
    message?: string;
  }): void {
    const { loadedDiagnosticsFiles } = this.diagnosticsState.deriveAggregateFromSnapshots();

    this.lastLoadedDiagnosticsFiles = loadedDiagnosticsFiles;

    const publishedDiagnostics = this.diagnosticsState.getPublishedCount();

    // Preserve manual direct-run status when watch refresh finds no
    // diagnostics to publish (e.g. keripy has no .sphinx-diagnostics/latest.json).
    // Only overwrite when watch actually has diagnostics to report.
    if (this.statusController.isManualDiagnosticsActive() && publishedDiagnostics === 0) {
      return;
    }

    this.statusController.applySummary(
      buildWatchModeSummary({
        projectCount: options.projectCount,
        loadedProjectCount: this.lastLoadedDiagnosticsFiles.length,
        issueCount: this.diagnosticsState.getIssueCount(),
        publishableBeforeFilter: this.diagnosticsState.getPublishableBeforeFilterCount(),
        publishedDiagnostics: publishedDiagnostics,
        watcherCount: options.watcherCount,
        rawPendingCount: options.rawPendingCount,
        errorCount: options.errorCount,
        diagnosticMode: options.diagnosticMode,
        message: options.message,
      }),
    );
  }

  private shouldSuppressWatchEvent(filePath: string): boolean {
    return this.eventSuppression.isSuppressed(filePath);
  }

  private setProjectStatus(projectId: string, status: string): void {
    this.refreshRunner.setProjectStatus(projectId, status);
  }

  private async prepareProjectEntry(
    project: ConfiguredProject,
    config: ExtensionConfig,
    workspaceFolders: WorkspaceFolderInfo[],
  ): Promise<PreparedProjectEntry | undefined> {
    return this.refreshRunner.prepareProjectEntry(project, config, workspaceFolders);
  }

  private async handleDidSaveTextDocument(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== 'file') {
      return;
    }

    this.logger.info(`Saved file detected: ${document.uri.fsPath}.`);
    const config = getExtensionConfig();
    if (!config.refreshAutoRunOnSave) {
      this.logger.info(`Ignoring saved file because refresh-on-save is disabled: ${document.uri.fsPath}.`);
      return;
    }

    const workspaceFolders = toWorkspaceFolderInfo(vscode.workspace.workspaceFolders);
    const projects = await this.resolveKnownProjects(config, workspaceFolders);
    const decision = getRefreshOnSaveDecision(document.uri.fsPath, projects, workspaceFolders, {
      refreshAutoRunOnSave: config.refreshAutoRunOnSave,
      isWorkspaceTrusted: vscode.workspace.isTrusted === true,
    });
    if (!decision.allowed || !decision.project) {
      this.logger.info(`Ignoring saved file ${document.uri.fsPath}: ${decision.reason}`);
      return;
    }

    this.logger.info(
      `Queued refresh-on-save for ${decision.project.id} from ${document.uri.fsPath} with debounce ${config.refreshDebounceMs}ms.`,
    );
    this.getProjectRefreshTrigger(
      decision.project.id,
      getRefreshOnSaveDebounceMs(config),
    ).trigger(
      `saved ${path.basename(document.uri.fsPath)}`,
    );
  }

  private getProjectRefreshTrigger(projectId: string, debounceMs: number): DebouncedTrigger {
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

  private async resolveKnownProjects(
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

    logDiscoveryDecisions(this.logger, discoveryDecisions);
    const discoveredProjects = discoveryDecisions.flatMap((decision) =>
      decision.project ? [decision.project] : [],
    );

    return mergeProjects(config.projects, discoveredProjects);
  }

  private async runStartupProjectRefreshes(): Promise<void> {
    const config = getExtensionConfig();
    if (!config.refreshAutoRunOnStartup) {
      return;
    }

    if (vscode.workspace.isTrusted !== true) {
      this.logger.info('Skipping startup refreshes because the workspace is not trusted.');
      return;
    }

    const workspaceFolders = toWorkspaceFolderInfo(vscode.workspace.workspaceFolders);
    const projects = await this.resolveKnownProjects(config, workspaceFolders);
    for (const project of projects) {
      await this.runProjectRefreshLifecycle(
        project,
        workspaceFolders,
        'startup auto refresh',
      );
    }
  }

  private async runAutoRefreshForProject(projectId: string, reason: string): Promise<void> {
    const config = getExtensionConfig();
    if (!config.refreshAutoRunOnSave) {
      return;
    }

    const workspaceFolders = toWorkspaceFolderInfo(vscode.workspace.workspaceFolders);
    const projects = await this.resolveKnownProjects(config, workspaceFolders);
    const project = projects.find((entry) => entry.id === projectId);
    if (!project) {
      this.logger.warn(`Skipping refresh-on-save for ${projectId}: project is no longer known.`);
      return;
    }

    this.logger.info(`Starting save-triggered refresh for ${project.id}: ${reason}.`);
    await this.runProjectRefreshLifecycle(project, workspaceFolders, `refresh-on-save (${reason})`);
    this.logger.info(`Completed save-triggered refresh for ${project.id}: ${reason}.`);
  }

  private async runProjectRefreshLifecycle(
    project: ConfiguredProject,
    workspaceFolders: WorkspaceFolderInfo[],
    reason: string,
  ): Promise<void> {
    if (!this.projectRefreshSingleFlight.tryStart(project.id)) {
      this.logger.info(`Skipping ${reason} for ${project.id} because a refresh is already running.`);
      return;
    }

    try {
      await this.refreshRunner.runProjectRefreshLifecycle(
        project,
        workspaceFolders,
        reason,
        this.lastKnownProjectIds.length,
        this.statusController.getSummary().projectCount,
      );
    } finally {
      this.projectRefreshSingleFlight.finish(project.id);
    }
  }

  private async syncWatchers(
    projects: ConfiguredProject[],
    workspaceFolders: WorkspaceFolderInfo[],
  ): Promise<void> {
    const desired = new Map<string, WatchPattern>();
    for (const project of projects) {
      for (const pattern of buildWatchPatterns(project, workspaceFolders)) {
        desired.set(pattern.key, pattern);
      }
    }

    for (const [key, watcher] of this.watchers.entries()) {
      if (!desired.has(key)) {
        watcher.dispose();
        this.watchers.delete(key);
      }
    }

    for (const pattern of desired.values()) {
      if (this.watchers.has(pattern.key)) {
        continue;
      }

      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(pattern.basePath, pattern.glob),
      );
      const handleEvent = (uri: vscode.Uri): void => {
        if (this.shouldSuppressWatchEvent(uri.fsPath)) {
          this.logger.debug(`Ignoring internal watch event for ${uri.fsPath}`);
          return;
        }
        this.logger.debug(`Watch event for ${uri.fsPath}`);
        this.scheduleRefresh(`artifact changed: ${path.basename(uri.fsPath)}`);
      };
      watcher.onDidCreate(handleEvent, this, this.context.subscriptions);
      watcher.onDidChange(handleEvent, this, this.context.subscriptions);
      watcher.onDidDelete(handleEvent, this, this.context.subscriptions);
      this.watchers.set(pattern.key, watcher);
    }
  }

  private disposeWatchers(): void {
    for (const watcher of this.watchers.values()) {
      watcher.dispose();
    }
    this.watchers.clear();
  }
}