import path from 'node:path';

import * as vscode from 'vscode';

import { getExtensionConfig, projectLabel } from './config';
import {
  buildEnrichmentRunPlan,
  getEnrichmentPermission,
  runEnrichmentPlan,
} from './enrichmentRunner';
import {
  buildRefreshRunPlan,
  filterRecentInventoryCandidates,
  getRefreshPermission,
  inferProjectRefreshConfig,
  runRefreshPlan,
} from './refreshRunner';
import {
  inspectDiagnosticsFile,
  inspectDiagnosticsFileBinding,
  isDiagnosticsBindingCompatible,
  loadDiagnosticsFromPath,
} from './loadDiagnostics';
import { SphinxDoctorLogger } from './log';
import { publishDiagnosticsBatch, PublishBatchEntry, PublishResult } from './publishDiagnostics';
import { discoverWorkspaceProjectDecisions, mergeProjects } from './projectDiscovery';
import { SELF_TEST_STATUS_TEXT } from './selfTest';
import {
  ConfiguredProject,
  ExtensionConfig,
  shouldPublishIssue,
  WorkspaceFolderInfo,
} from './types';
import { WatchModeSummary } from './types';
import {
  findWorkspaceFolderByName,
  selectInventoryCandidate,
} from './workspace';
import {
  buildWatchModeSummary,
  canAutoRunEnrichment,
  createSingleFlightController,
  createDebouncedTrigger,
  DebouncedTrigger,
  getRefreshOnSaveDecision,
  formatWatchModeText,
  formatWatchModeTooltip,
  hasOpenWorkspaceFolders,
  runWatchModeStartup,
} from './watchModeState';

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

export class SphinxDoctorWatchMode implements vscode.Disposable {
  private readonly statusItem: vscode.StatusBarItem;

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

  private lastIssueCount = 0;

  private lastPublishedCount = 0;

  private lastSkippedCount = 0;

  private lastResolutionFailureCount = 0;

  private readonly lastProjectStatuses = new Map<string, string>();

  private summary: WatchModeSummary = buildWatchModeSummary({
    projectCount: 0,
    loadedProjectCount: 0,
    issueCount: 0,
    publishedDiagnostics: 0,
    watcherCount: 0,
    rawPendingCount: 0,
    errorCount: 0,
    message: 'Sphinx Doctor is idle.',
  });

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly collection: vscode.DiagnosticCollection,
    private readonly logger: SphinxDoctorLogger,
  ) {
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusItem.command = 'sphinxDoctor.showStatus';
    this.applySummary(this.summary);

    this.context.subscriptions.push(
      this.statusItem,
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
    this.statusItem.show();
    const config = getExtensionConfig();
    this.logger.setLevel(config.logLevel);
    this.logger.info(
      `Watch mode startup: enabled=${config.watchEnabled}, autoLoadOnStartup=${config.watchAutoLoadOnStartup}, autoRun=${config.enrichmentAutoRun}, trusted=${vscode.workspace.isTrusted === true}.`,
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
      this.applySummary(
        buildWatchModeSummary({
          projectCount: 0,
          loadedProjectCount: 0,
          issueCount: 0,
          publishedDiagnostics: 0,
          watcherCount: 0,
          rawPendingCount: 0,
          errorCount: 0,
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
      this.collection.clear();
      this.lastRefreshReason = reason;
      this.lastError = undefined;
      this.lastLoadedDiagnosticsFiles = [];
      this.lastIssueCount = 0;
      this.lastPublishedCount = 0;
      this.lastSkippedCount = 0;
      this.lastResolutionFailureCount = 0;
      this.lastProjectStatuses.clear();
      this.applySummary(
        buildWatchModeSummary({
          projectCount: 0,
          loadedProjectCount: 0,
          issueCount: 0,
          publishedDiagnostics: 0,
          watcherCount: 0,
          rawPendingCount: 0,
          errorCount: 0,
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
    this.lastProjectStatuses.clear();

    this.logger.info(
      `Watch refresh requested (${reason}): workspace folders [${this.lastWorkspaceFolders.join(', ') || 'none'}].`,
    );
    this.logger.info(
      `Configured projects (${this.lastConfiguredProjectIds.length}): [${this.lastConfiguredProjectIds.join(', ') || 'none'}].`,
    );

    if (!hasOpenWorkspaceFolders(workspaceFolders)) {
      this.disposeWatchers();
      this.collection.clear();
      const summary = buildWatchModeSummary({
        projectCount: 0,
        loadedProjectCount: 0,
        issueCount: 0,
        publishedDiagnostics: 0,
        watcherCount: 0,
        rawPendingCount: 0,
        errorCount: 0,
        message: 'No workspace folders are open, so Sphinx Doctor watch mode is idle.',
      });
      this.logger.info(`Watch refresh skipped (${reason}): no workspace folders.`);
      this.lastDiscoveredProjectIds = [];
      this.lastKnownProjectIds = [];
      this.lastLoadedDiagnosticsFiles = [];
      this.lastIssueCount = 0;
      this.lastPublishedCount = 0;
      this.lastSkippedCount = 0;
      this.lastResolutionFailureCount = 0;
      this.applySummary(summary);
      return;
    }

    const discoveryDecisions = config.discoveryEnabled
      ? await discoverWorkspaceProjectDecisions(
          workspaceFolders,
          {
            includeLowConfidence: config.discoveryIncludeLowConfidence,
            inventoryWorkspaceFolderNames: config.discoveryInventoryWorkspaceFolderNames,
            excludeWorkspaceFolderNames: config.discoveryExcludeWorkspaceFolders,
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
      this.applySummary(
        buildWatchModeSummary({
          projectCount: projects.length,
          loadedProjectCount: 0,
          issueCount: 0,
          publishedDiagnostics: 0,
          watcherCount: this.watchers.size,
          rawPendingCount: 0,
          errorCount: 0,
          message:
            projects.length > 0
              ? `Watching ${projects.length} projects for diagnostics changes.`
              : 'No configured or discoverable Sphinx projects in the current workspace.',
        }),
      );
      return;
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
            `loaded ${prepared.loadedPath} with ${prepared.loadedIssueCount} issues and ${prepared.publishableIssueCount} publishable diagnostics.`,
          );
        } else {
          const mirrorRelativePath = buildMirrorLatestRelativePath(project);
          this.logger.debug(
            `No diagnostics loaded for ${project.id}; looked for ${mirrorRelativePath} and configured inventory globs.`,
          );
          if (!this.lastProjectStatuses.has(project.id)) {
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
        const candidate = await this.selectCandidate(project, workspaceFolders);
        if (candidate && candidate.kind === 'raw') {
          rawPendingCount += 1;
        }
      }
    }

    let publishResult: PublishResult = {
      issueCount: 0,
      publishedDiagnostics: 0,
      targetUriCount: 0,
      skippedIssues: 0,
      resolutionFailures: 0,
    };

    if (entries.length > 0) {
      publishResult = publishDiagnosticsBatch(this.collection, entries, {
        workspaceFolders: vscode.workspace.workspaceFolders,
        logger: this.logger,
      });
    } else {
      this.collection.clear();
    }

    this.lastLoadedDiagnosticsFiles = entries.map((entry) => entry.loadedPath);
    this.lastIssueCount = publishResult.issueCount;
    this.lastPublishedCount = publishResult.publishedDiagnostics;
    this.lastSkippedCount = publishResult.skippedIssues;
    this.lastResolutionFailureCount = publishResult.resolutionFailures;

    if (entries.length > 0) {
      this.logger.info(
        `Loaded diagnostics files: [${this.lastLoadedDiagnosticsFiles.join(', ')}].`,
      );
    } else {
      this.logger.warn('No diagnostics files were loaded for any known project during this refresh.');
    }

    const summary = buildWatchModeSummary({
      projectCount: projects.length,
      loadedProjectCount: entries.length,
      issueCount: publishResult.issueCount,
      publishedDiagnostics: publishResult.publishedDiagnostics,
      watcherCount: this.watchers.size,
      rawPendingCount,
      errorCount,
      message:
        errorCount > 0
          ? 'Sphinx Doctor watch mode hit an error. Check the output channel.'
          : undefined,
    });
    this.applySummary(summary);
    this.logger.info(
      `Watch refresh completed (${reason}): loaded ${entries.length} files, ${publishResult.issueCount} issues, ${publishResult.publishedDiagnostics} published diagnostics across ${publishResult.targetUriCount} target URIs, ${publishResult.skippedIssues} skipped, ${publishResult.resolutionFailures} resolution failures, ${this.watchers.size} watchers.`,
    );
  }

  public showStatus(): void {
    const lines = [
      'Sphinx Doctor status report:',
      `- activated: ${this.activated}`,
      `- watch summary: ${this.summary.state}`,
      `- last refresh reason: ${this.lastRefreshReason}`,
      `- workspace folders: ${this.lastWorkspaceFolders.join(', ') || 'none'}`,
      `- configured projects: ${this.lastConfiguredProjectIds.join(', ') || 'none'}`,
      `- discovered projects: ${this.lastDiscoveredProjectIds.join(', ') || 'none'}`,
      `- known projects: ${this.lastKnownProjectIds.join(', ') || 'none'}`,
      `- last loaded diagnostics: ${this.lastLoadedDiagnosticsFiles.join(', ') || 'none'}`,
      `- last issue count: ${this.lastIssueCount}`,
      `- last published count: ${this.lastPublishedCount}`,
      `- last skipped count: ${this.lastSkippedCount}`,
      `- last URI resolution failures: ${this.lastResolutionFailureCount}`,
      `- last error: ${this.lastError ?? 'none'}`,
    ];

    for (const [projectId, status] of this.lastProjectStatuses.entries()) {
      lines.push(`- project ${projectId}: ${status}`);
    }

    for (const line of lines) {
      this.logger.info(line);
    }
    this.logger.show(true);
    void vscode.window.showInformationMessage(this.summary.message);
  }

  public noteManualClear(): void {
    this.applySummary(
      buildWatchModeSummary({
        projectCount: this.summary.projectCount,
        loadedProjectCount: 0,
        issueCount: 0,
        publishedDiagnostics: 0,
        watcherCount: this.watchers.size,
        rawPendingCount: 0,
        errorCount: 0,
        message: 'Sphinx Doctor diagnostics cleared.',
      }),
    );
  }

  public noteSelfTestDiagnosticPublished(
    targetUri: vscode.Uri,
    diagnosticCount: number,
    tooltip: string,
  ): void {
    this.statusItem.text = SELF_TEST_STATUS_TEXT;
    this.statusItem.tooltip = tooltip || [
      'Sphinx Doctor self-test diagnostic published.',
      `Target: ${targetUri.toString()}`,
      `Published diagnostics: ${diagnosticCount}`,
    ].join('\n');
  }

  public noteManualDiagnosticsPublished(options: {
    filePath: string;
    issueCount: number;
    publishedDiagnostics: number;
    skippedIssues: number;
    resolutionFailures: number;
    message: string;
  }): void {
    this.lastRefreshReason = 'manual load';
    this.lastError = undefined;
    this.lastLoadedDiagnosticsFiles = [options.filePath];
    this.lastIssueCount = options.issueCount;
    this.lastPublishedCount = options.publishedDiagnostics;
    this.lastSkippedCount = options.skippedIssues;
    this.lastResolutionFailureCount = options.resolutionFailures;
    this.applySummary(
      buildWatchModeSummary({
        projectCount: Math.max(this.summary.projectCount, 1),
        loadedProjectCount: 1,
        issueCount: options.issueCount,
        publishedDiagnostics: options.publishedDiagnostics,
        watcherCount: this.watchers.size,
        rawPendingCount: 0,
        errorCount: 0,
        message: options.message,
      }),
    );
  }

  public getSummary(): WatchModeSummary {
    return this.summary;
  }

  public dispose(): void {
    this.refreshTrigger?.dispose();
    this.disposeAutoRefreshTriggers();
    this.disposeWatchers();
    this.statusItem.dispose();
  }

  private applySummary(summary: WatchModeSummary): void {
    this.summary = summary;
    this.statusItem.text = formatWatchModeText(summary);
    this.statusItem.tooltip = formatWatchModeTooltip(summary);
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

  private setProjectStatus(projectId: string, status: string): void {
    this.lastProjectStatuses.set(projectId, status);
    this.logger.info(`Project ${projectId}: ${status}`);
  }

  private async prepareProjectEntry(
    project: ConfiguredProject,
    config: ExtensionConfig,
    workspaceFolders: WorkspaceFolderInfo[],
  ): Promise<PreparedProjectEntry | undefined> {
    const selected = await this.selectCandidate(project, workspaceFolders);
    if (!selected) {
      return undefined;
    }

    if (selected.kind === 'enriched') {
      const contract = await loadDiagnosticsFromPath(selected.candidate.filePath);
      const publishableIssueCount = contract.issues.filter((issue) => shouldPublishIssue(issue)).length;
      this.logger.info(
        `Watch mode loaded enriched diagnostics for ${project.id}: ${selected.candidate.filePath}; issues=${contract.issues.length}; publishable=${publishableIssueCount}.`,
      );
      return {
        project,
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
        extensionRoot: this.context.extensionUri.fsPath,
        pythonInterpreter: config.pythonInterpreter,
        project,
        workspaceFolders,
        rawIssuesPath: selected.candidate.filePath,
      });
      this.logger.info(
        `Watch mode auto-enriching ${project.id}: raw ${plan.rawIssuesPath}; archive ${plan.archiveOutputPath}; latest ${plan.latestOutputPath}.`,
      );
      const result = await runEnrichmentPlan(plan);
      const contract = await loadDiagnosticsFromPath(result.plan.latestOutputPath);
      const publishableIssueCount = contract.issues.filter((issue) => shouldPublishIssue(issue)).length;
      this.logger.info(
        `Watch mode auto-enriched ${project.id} to ${result.plan.latestOutputPath}; issues=${contract.issues.length}; publishable=${publishableIssueCount}.`,
      );
      return {
        project,
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

  private async selectCandidate(
    project: ConfiguredProject,
    workspaceFolders: WorkspaceFolderInfo[],
  ): Promise<{ candidate: DiscoveredInventoryCandidate; kind: 'enriched' | 'raw' | 'unknown' } | undefined> {
    const sourceFolder = findWorkspaceFolderByName(workspaceFolders, project.sourceWorkspaceFolder);
    if (sourceFolder) {
      const mirrorLatestUri = vscode.Uri.file(
        path.resolve(sourceFolder.fsPath, project.repoRoot ?? '.', project.mirrorRoot ?? '.sphinx-diagnostics', 'latest.json'),
      );
      this.logger.info(`Checking mirror latest.json for ${project.id}: ${mirrorLatestUri.fsPath}.`);
      try {
        await vscode.workspace.fs.stat(mirrorLatestUri);
        const kind = await inspectDiagnosticsFile(mirrorLatestUri.fsPath);
        this.logger.info(`Mirror artifact kind for ${project.id}: ${kind}.`);
        if (kind === 'enriched') {
          const stat = await vscode.workspace.fs.stat(mirrorLatestUri);
          this.logger.info(`Selected mirror artifact for ${project.id}: ${mirrorLatestUri.fsPath}.`);
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
        this.logger.info(`Mirror latest.json missing for ${project.id}: ${mirrorLatestUri.fsPath}.`);
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
        this.logger.warn(
          `Skipping incompatible inventory candidate for ${project.id}: ${candidate.filePath}. ${compatibility.reason ?? 'Binding mismatch.'}`,
        );
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
    this.logger.info(
      `Selected inventory artifact for ${project.id}: ${selection.selected.filePath}; kind=${kind}.`,
    );
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
        this.logger.warn(
          `Inventory workspace folder ${searchTarget.workspaceFolderName} could not be resolved for ${project.id}.`,
        );
        continue;
      }

      for (const inventorySearchGlob of searchTarget.globs) {
        const relativePattern = new vscode.RelativePattern(inventoryFolder.fsPath, inventorySearchGlob);
        const matches = await vscode.workspace.findFiles(relativePattern);
        this.logger.info(
          `Searching inventory glob for ${project.id}: ${searchTarget.workspaceFolderName}:${inventorySearchGlob} -> ${matches.length} match(es).`,
        );
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

    this.logger.info(
      `Inventory candidates for ${project.id}: ${candidates.length > 0 ? candidates.map((candidate) => candidate.filePath).join(', ') : 'none'}.`,
    );

    return candidates;
  }

  private async handleDidSaveTextDocument(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== 'file') {
      return;
    }

    const config = getExtensionConfig();
    if (!config.refreshAutoRunOnSave) {
      return;
    }

    const workspaceFolders = toWorkspaceFolderInfo(vscode.workspace.workspaceFolders);
    const projects = await this.resolveKnownProjects(config, workspaceFolders);
    const decision = getRefreshOnSaveDecision(document.uri.fsPath, projects, workspaceFolders, {
      refreshAutoRunOnSave: config.refreshAutoRunOnSave,
      isWorkspaceTrusted: vscode.workspace.isTrusted === true,
    });
    if (!decision.allowed || !decision.project) {
      return;
    }

    this.logger.info(`Queued refresh-on-save for ${decision.project.id}: ${document.uri.fsPath}.`);
    this.getProjectRefreshTrigger(decision.project.id, config.watchDebounceMs).trigger(
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
      await this.runProjectRefreshLifecycle(project, workspaceFolders, 'startup auto refresh');
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

    await this.runProjectRefreshLifecycle(project, workspaceFolders, `refresh-on-save (${reason})`);
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

      const refreshPlan = buildRefreshRunPlan({
        project,
        refresh: refreshResolution.config,
        workspaceFolders,
      });
      this.logger.info(
        `Running ${reason} for ${project.id} with ${refreshPlan.command} ${refreshPlan.args.join(' ')} in ${refreshPlan.cwd}.`,
      );
      const refreshResult = await runRefreshPlan(refreshPlan);
      this.logger.info(`${reason} finished for ${project.id} with exit code ${refreshResult.exitCode}.`);

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
        this.setProjectStatus(
          project.id,
          `${reason} produced enriched diagnostics at ${refreshed.candidate.filePath}.`,
        );
        this.scheduleRefresh(`${reason}: enriched artifact changed`);
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
        extensionRoot: this.context.extensionUri.fsPath,
        pythonInterpreter: config.pythonInterpreter,
        project,
        workspaceFolders,
        rawIssuesPath: refreshed.candidate.filePath,
      });
      this.logger.info(
        `Enriching refreshed diagnostics for ${project.id}: raw ${enrichmentPlan.rawIssuesPath}; latest ${enrichmentPlan.latestOutputPath}.`,
      );
      await runEnrichmentPlan(enrichmentPlan);
      this.setProjectStatus(project.id, `${reason} wrote ${enrichmentPlan.latestOutputPath}.`);
      this.scheduleRefresh(`${reason}: latest.json changed`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.setProjectStatus(project.id, `error: ${message}`);
      this.logger.error(`${reason} failed for ${project.id}: ${message}`);
    } finally {
      this.projectRefreshSingleFlight.finish(project.id);
    }
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
      this.logger.warn(
        `Inventory workspace folder ${project.inventoryWorkspaceFolder} could not be resolved for ${project.id} during auto refresh.`,
      );
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
        this.logger.warn(
          `Skipping refreshed diagnostics candidate for ${project.id}: ${candidate.filePath}. ${compatibility.reason ?? 'Binding mismatch.'}`,
        );
        continue;
      }
      compatible.push(candidate);
    }

    const selected = selectInventoryCandidate(project, compatible, project.preferredInventoryFiles).selected;
    if (!selected) {
      return undefined;
    }

    const kind = await inspectDiagnosticsFile(selected.filePath);
    this.logger.info(
      `Selected refreshed diagnostics artifact for ${project.id}: ${selected.filePath}; kind=${kind}.`,
    );
    return {
      candidate: selected,
      kind,
    };
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