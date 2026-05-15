import path from 'node:path';

import * as vscode from 'vscode';

import { getExtensionConfig, projectLabel } from './config';
import {
  buildEnrichmentRunPlan,
  evaluateRefreshBaselinePromotion,
  formatRefreshScopeDriftWarning,
  getEnrichmentPermission,
  runEnrichmentPlan,
} from './enrichmentRunner';
import {
  buildRefreshRunPlan,
  filterRecentInventoryCandidates,
  getRefreshPermission,
  inferRefreshScopeFromContract,
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
import { DiagnosticsPublicationIndex } from './publicationIndex';
import {
  computeDiagnosticsAccounting,
  publishDiagnosticsBatch,
  PublishBatchEntry,
  PublishResult,
} from './publishDiagnostics';
import { discoverWorkspaceProjectDecisions, listGitWorktreesPorcelain, mergeProjects } from './projectDiscovery';
import { SELF_TEST_STATUS_TEXT } from './selfTest';
import {
  ConfiguredProject,
  ExtensionConfig,
  summarizeDiagnosticMode,
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
  getRefreshOnSaveDebounceMs,
  formatWatchModeText,
  formatWatchModeTooltip,
  hasOpenWorkspaceFolders,
  ProjectPublicationSnapshot,
  runWatchModeStartup,
  summarizeProjectPublicationSnapshots,
} from './watchModeState';

const NOOP_PUBLISH_LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

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

export function describeExtensionMode(mode: vscode.ExtensionMode): 'Development' | 'Test' | 'Production' {
  if (mode === vscode.ExtensionMode.Development) {
    return 'Development';
  }

  if (mode === vscode.ExtensionMode.Test) {
    return 'Test';
  }

  return 'Production';
}

function extensionModeBadge(mode: vscode.ExtensionMode): string | undefined {
  if (mode === vscode.ExtensionMode.Development) {
    return 'Dev';
  }

  if (mode === vscode.ExtensionMode.Test) {
    return 'Test';
  }

  return undefined;
}

export function applyExtensionModeBadge(
  text: string,
  mode: vscode.ExtensionMode,
): string {
  const badge = extensionModeBadge(mode);
  if (!badge) {
    return text;
  }

  if (!text.startsWith('Sphinx Doctor:')) {
    return text;
  }

  return text.replace('Sphinx Doctor:', `Sphinx Doctor (${badge}):`);
}

export interface TroubleshootReportState {
  activated: boolean;
  workspaceFolders: string[];
  configuredProjects: string[];
  discoveredProjects: string[];
  knownProjects: string[];
  lastRefreshReason: string;
  lastLoadedDiagnosticsFiles: string[];
  lastIssueCount: number;
  lastPublishableBeforeFilterCount: number;
  lastPublishedCount: number;
  lastFilteredByModeCount: number;
  lastSkippedCount: number;
  lastResolutionFailureCount: number;
  lastRawPendingCount: number;
  lastErrorCount: number;
  lastError?: string;
  summary: WatchModeSummary;
  projectStatuses: Array<[string, string]>;
}

export function buildTroubleshootReport(options: {
  extensionMode: vscode.ExtensionMode;
  extensionPath: string;
  isWorkspaceTrusted: boolean;
  config: ExtensionConfig;
  state: TroubleshootReportState;
}): string {
  const modeLabel = describeExtensionMode(options.extensionMode);
  const lines = [
    '# Sphinx Doctor Troubleshoot Environment',
    '',
    '## Runtime',
    `- Extension mode: ${modeLabel}`,
    `- Extension path: ${options.extensionPath}`,
    `- Workspace trusted: ${options.isWorkspaceTrusted}`,
    `- Activated: ${options.state.activated}`,
    `- Watch summary state: ${options.state.summary.state}`,
    `- Watch summary message: ${options.state.summary.message}`,
    '',
    '## Workspace',
    `- Open workspace folders: ${options.state.workspaceFolders.join(', ') || 'none'}`,
    `- Configured projects: ${options.state.configuredProjects.join(', ') || 'none'}`,
    `- Discovered projects: ${options.state.discoveredProjects.join(', ') || 'none'}`,
    `- Known projects: ${options.state.knownProjects.join(', ') || 'none'}`,
    '',
    '## Settings',
    `- Diagnostics mode: ${options.config.diagnosticsMode}`,
    `- Watch enabled: ${options.config.watchEnabled}`,
    `- Watch auto-load on startup: ${options.config.watchAutoLoadOnStartup}`,
    `- Refresh on startup: ${options.config.refreshAutoRunOnStartup}`,
    `- Refresh on save: ${options.config.refreshAutoRunOnSave}`,
    `- Discovery enabled: ${options.config.discoveryEnabled}`,
    `- Enrichment enabled: ${options.config.enrichmentEnabled}`,
    `- Enrichment auto-run: ${options.config.enrichmentAutoRun}`,
    `- Log level: ${options.config.logLevel}`,
    '',
    '## Diagnostics State',
    `- Last refresh reason: ${options.state.lastRefreshReason}`,
    `- Last loaded diagnostics artifacts: ${options.state.lastLoadedDiagnosticsFiles.join(', ') || 'none'}`,
    `- Total issues: ${options.state.lastIssueCount}`,
    `- Publishable before filter: ${options.state.lastPublishableBeforeFilterCount}`,
    `- Published diagnostics: ${options.state.lastPublishedCount}`,
    `- Filtered by mode: ${options.state.lastFilteredByModeCount}`,
    `- Skipped issues: ${options.state.lastSkippedCount}`,
    `- URI resolution failures: ${options.state.lastResolutionFailureCount}`,
    `- Raw pending projects: ${options.state.lastRawPendingCount}`,
    `- Errors: ${options.state.lastErrorCount}`,
    `- Last error: ${options.state.lastError ?? 'none'}`,
    '',
    '## Per-Project Status',
  ];

  if (options.state.projectStatuses.length === 0) {
    lines.push('- none');
  } else {
    for (const [projectId, status] of options.state.projectStatuses) {
      lines.push(`- ${projectId}: ${status}`);
    }
  }

  const nextSteps: string[] = [];
  nextSteps.push(`Sphinx Doctor is running in ${modeLabel} mode.`);
  if (!options.isWorkspaceTrusted) {
    nextSteps.push('Trust the workspace before expecting refresh or enrichment commands to run.');
  }
  if (!options.config.refreshAutoRunOnSave) {
    nextSteps.push('Refresh-on-save is disabled, so saving files alone will not refresh diagnostics.');
  }
  if (options.state.lastPublishedCount > 0) {
    nextSteps.push(`Problems should currently show about ${options.state.lastPublishedCount} published diagnostics.`);
  } else if (options.state.lastLoadedDiagnosticsFiles.length === 0) {
    nextSteps.push('No diagnostics artifact has been loaded yet; run Discover and Load Diagnostics or Refresh Project Diagnostics next.');
  } else {
    nextSteps.push('Diagnostics artifacts were seen, but no diagnostics were published; check mode filtering and artifact compatibility next.');
  }
  if (options.state.lastRawPendingCount > 0) {
    nextSteps.push('Some projects only have raw inventory available; enable or run enrichment before expecting Problems entries.');
  }

  lines.push('', '## Interpretation / Next Steps');
  for (const step of nextSteps) {
    lines.push(`- ${step}`);
  }

  return lines.join('\n');
}

export class SphinxDoctorWatchMode implements vscode.Disposable {
  private readonly statusItem: vscode.StatusBarItem;

  private watchers = new Map<string, vscode.FileSystemWatcher>();

  private refreshTrigger: DebouncedTrigger | undefined;

  private autoRefreshTriggers = new Map<string, DebouncedTrigger>();

  private readonly projectRefreshSingleFlight = createSingleFlightController();

  private readonly lastProjectPublications = new Map<string, ProjectPublicationSnapshot>();

  private readonly suppressedWatchPaths = new Map<string, number>();

  private activated = false;

  private lastRefreshReason = 'not-run';

  private lastError: string | undefined;

  private lastWorkspaceFolders: string[] = [];

  private lastConfiguredProjectIds: string[] = [];

  private lastDiscoveredProjectIds: string[] = [];

  private lastKnownProjectIds: string[] = [];

  private lastLoadedDiagnosticsFiles: string[] = [];

  private lastIssueCount = 0;

  private lastPublishableBeforeFilterCount = 0;

  private lastPublishedCount = 0;

  private lastFilteredByModeCount = 0;

  private lastSkippedCount = 0;

  private lastResolutionFailureCount = 0;

  private lastRawPendingCount = 0;

  private lastErrorCount = 0;

  private readonly lastProjectStatuses = new Map<string, string>();

  private summary: WatchModeSummary = buildWatchModeSummary({
    projectCount: 0,
    loadedProjectCount: 0,
    issueCount: 0,
    publishableBeforeFilter: 0,
    publishedDiagnostics: 0,
    watcherCount: 0,
    rawPendingCount: 0,
    errorCount: 0,
    diagnosticMode: 'layout',
    message: 'Sphinx Doctor is idle.',
  });

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly collection: vscode.DiagnosticCollection,
    private readonly logger: SphinxDoctorLogger,
    private readonly publicationIndex: DiagnosticsPublicationIndex<vscode.Uri>,
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
      this.applySummary(
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
      this.lastIssueCount = 0;
      this.lastPublishableBeforeFilterCount = 0;
      this.lastPublishedCount = 0;
      this.lastFilteredByModeCount = 0;
      this.lastSkippedCount = 0;
      this.lastResolutionFailureCount = 0;
      this.lastRawPendingCount = 0;
      this.lastErrorCount = 0;
      this.lastProjectPublications.clear();
      this.lastProjectStatuses.clear();
      this.applySummary(
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
    this.lastProjectStatuses.clear();

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
      this.lastIssueCount = 0;
      this.lastPublishableBeforeFilterCount = 0;
      this.lastPublishedCount = 0;
      this.lastFilteredByModeCount = 0;
      this.lastSkippedCount = 0;
      this.lastResolutionFailureCount = 0;
      this.lastRawPendingCount = 0;
      this.lastErrorCount = 0;
      this.lastProjectPublications.clear();
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
      this.lastProjectPublications.clear();
      this.lastLoadedDiagnosticsFiles = [];
      this.lastIssueCount = 0;
      this.lastPublishableBeforeFilterCount = 0;
      this.lastPublishedCount = 0;
      this.lastFilteredByModeCount = 0;
      this.lastSkippedCount = 0;
      this.lastResolutionFailureCount = 0;
      this.lastRawPendingCount = 0;
      this.lastErrorCount = 0;
      this.applySummary(
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

    this.lastProjectPublications.clear();
    for (const project of projects) {
      this.lastProjectPublications.set(project.id, {
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
      this.publicationIndex.clear(this.collection);
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
      this.lastProjectPublications.set(entry.project.id, {
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

    this.lastRawPendingCount = rawPendingCount;
    this.lastErrorCount = errorCount;
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
    const lines = [
      'Sphinx Doctor status report:',
      `- activated: ${this.activated}`,
      `- watch summary: ${this.summary.state}`,
      `- last refresh reason: ${this.lastRefreshReason}`,
      `- workspace folders: ${this.lastWorkspaceFolders.join(', ') || 'none'}`,
      `- configured projects: ${this.lastConfiguredProjectIds.join(', ') || 'none'}`,
      `- discovered projects: ${this.lastDiscoveredProjectIds.join(', ') || 'none'}`,
      `- known projects: ${this.lastKnownProjectIds.join(', ') || 'none'}`,
      `- diagnostic mode: ${this.summary.diagnosticMode}`,
      `- last loaded diagnostics: ${this.lastLoadedDiagnosticsFiles.join(', ') || 'none'}`,
      `- last issue count: ${this.lastIssueCount}`,
      `- last publishable-before-filter count: ${this.lastPublishableBeforeFilterCount}`,
      `- last published count: ${this.lastPublishedCount}`,
      `- last filtered-by-mode count: ${this.lastFilteredByModeCount}`,
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
        lastIssueCount: this.lastIssueCount,
        lastPublishableBeforeFilterCount: this.lastPublishableBeforeFilterCount,
        lastPublishedCount: this.lastPublishedCount,
        lastFilteredByModeCount: this.lastFilteredByModeCount,
        lastSkippedCount: this.lastSkippedCount,
        lastResolutionFailureCount: this.lastResolutionFailureCount,
        lastRawPendingCount: this.lastRawPendingCount,
        lastErrorCount: this.lastErrorCount,
        lastError: this.lastError,
        summary: this.summary,
        projectStatuses: [...this.lastProjectStatuses.entries()],
      },
    });
  }

  public noteManualClear(): void {
    this.applySummary(
      buildWatchModeSummary({
        projectCount: this.summary.projectCount,
        loadedProjectCount: 0,
        issueCount: 0,
        publishableBeforeFilter: 0,
        publishedDiagnostics: 0,
        watcherCount: this.watchers.size,
        rawPendingCount: 0,
        errorCount: 0,
        diagnosticMode: this.summary.diagnosticMode,
        message: 'Sphinx Doctor diagnostics cleared.',
      }),
    );
  }

  public noteSelfTestDiagnosticPublished(
    targetUri: vscode.Uri,
    diagnosticCount: number,
    tooltip: string,
  ): void {
    this.statusItem.text = applyExtensionModeBadge(
      SELF_TEST_STATUS_TEXT,
      this.context.extensionMode,
    );
    this.statusItem.tooltip = tooltip || [
      'Sphinx Doctor self-test diagnostic published.',
      `Target: ${targetUri.toString()}`,
      `Published diagnostics: ${diagnosticCount}`,
    ].join('\n');
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
    this.lastIssueCount = options.issueCount;
    this.lastPublishableBeforeFilterCount = options.publishableBeforeFilter;
    this.lastPublishedCount = options.publishedDiagnostics;
    this.lastFilteredByModeCount = options.filteredByMode;
    this.lastSkippedCount = options.skippedIssues;
    this.lastResolutionFailureCount = options.resolutionFailures;
    this.applySummary(
      buildWatchModeSummary({
        projectCount: Math.max(this.summary.projectCount, 1),
        loadedProjectCount: 1,
        issueCount: options.issueCount,
        publishableBeforeFilter: options.publishableBeforeFilter,
        publishedDiagnostics: options.publishedDiagnostics,
        watcherCount: this.watchers.size,
        rawPendingCount: 0,
        errorCount: 0,
        diagnosticMode: this.summary.diagnosticMode,
        message: options.message,
      }),
    );
  }

  public getSummary(): WatchModeSummary {
    return this.summary;
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
      issueCount: this.lastIssueCount,
      publishedDiagnostics: this.lastPublishedCount,
    };
  }

  public dispose(): void {
    this.refreshTrigger?.dispose();
    this.disposeAutoRefreshTriggers();
    this.disposeWatchers();
    this.statusItem.dispose();
  }

  private applySummary(summary: WatchModeSummary): void {
    this.summary = summary;
    this.statusItem.text = applyExtensionModeBadge(
      formatWatchModeText(summary),
      this.context.extensionMode,
    );
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

  private applyAggregateState(options: {
    projectCount: number;
    diagnosticMode: ExtensionConfig['diagnosticsMode'];
    watcherCount: number;
    rawPendingCount: number;
    errorCount: number;
    message?: string;
  }): void {
    const aggregate = summarizeProjectPublicationSnapshots(this.lastProjectPublications.values());

    this.lastLoadedDiagnosticsFiles = aggregate.loadedDiagnosticsFiles;
    this.lastIssueCount = aggregate.issueCount;
    this.lastPublishableBeforeFilterCount = aggregate.publishableBeforeFilter;
    this.lastPublishedCount = aggregate.publishedDiagnostics;
    this.lastFilteredByModeCount = aggregate.filteredByMode;
    this.lastSkippedCount = aggregate.skippedIssues;
    this.lastResolutionFailureCount = aggregate.resolutionFailures;

    this.applySummary(
      buildWatchModeSummary({
        projectCount: options.projectCount,
        loadedProjectCount: aggregate.loadedProjectCount,
        issueCount: aggregate.issueCount,
        publishableBeforeFilter: aggregate.publishableBeforeFilter,
        publishedDiagnostics: aggregate.publishedDiagnostics,
        watcherCount: options.watcherCount,
        rawPendingCount: options.rawPendingCount,
        errorCount: options.errorCount,
        diagnosticMode: options.diagnosticMode,
        message: options.message,
      }),
    );
  }

  private suppressWatchEvents(filePaths: string[]): void {
    const expiresAt = Date.now() + 2000;
    for (const filePath of filePaths) {
      this.suppressedWatchPaths.set(path.resolve(filePath), expiresAt);
    }
  }

  private shouldSuppressWatchEvent(filePath: string): boolean {
    const normalizedPath = path.resolve(filePath);
    const expiresAt = this.suppressedWatchPaths.get(normalizedPath);
    if (expiresAt === undefined) {
      return false;
    }

    if (expiresAt < Date.now()) {
      this.suppressedWatchPaths.delete(normalizedPath);
      return false;
    }

    return true;
  }

  private async publishProjectDiagnosticsFromPath(
    project: ConfiguredProject,
    diagnosticsPath: string,
    reason: string,
  ): Promise<void> {
    const config = getExtensionConfig();
    const contract = await loadDiagnosticsFromPath(diagnosticsPath);
    const result = publishDiagnosticsBatch(
      this.collection,
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
        publicationIndex: this.publicationIndex,
        logger: this.logger,
      },
    );

    this.lastRefreshReason = reason;
    this.lastError = undefined;
    this.lastProjectPublications.set(project.id, {
      loaded: true,
      loadedPath: diagnosticsPath,
      issueCount: result.issueCount,
      publishableBeforeFilter: result.publishableBeforeFilter,
      publishedDiagnostics: result.publishedDiagnostics,
      filteredByMode: result.filteredByMode,
      skippedIssues: result.skippedIssues,
      resolutionFailures: result.resolutionFailures,
    });
    this.lastRawPendingCount = 0;
    this.lastErrorCount = 0;
    this.applyAggregateState({
      projectCount: this.lastKnownProjectIds.length || Math.max(this.summary.projectCount, 1),
      diagnosticMode: config.diagnosticsMode,
      watcherCount: this.watchers.size,
      rawPendingCount: this.lastRawPendingCount,
      errorCount: this.lastErrorCount,
      message:
        result.publishedDiagnostics > 0
          ? `Watching ${this.lastKnownProjectIds.length || Math.max(this.summary.projectCount, 1)} projects in ${config.diagnosticsMode} mode with ${summarizeProjectPublicationSnapshots(this.lastProjectPublications.values()).issueCount} issues, ${summarizeProjectPublicationSnapshots(this.lastProjectPublications.values()).publishableBeforeFilter} publishable before filter, and ${summarizeProjectPublicationSnapshots(this.lastProjectPublications.values()).publishedDiagnostics} published diagnostics.`
          : undefined,
    });
    this.setProjectStatus(
      project.id,
      `${reason} published ${result.publishedDiagnostics} diagnostics from ${diagnosticsPath}.`,
    );
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
      const publishableIssueCount = summarizeDiagnosticMode(
        contract.issues,
        config.diagnosticsMode,
      ).publishableBeforeFilter;
      this.logger.info(
        `Watch mode loaded enriched diagnostics for ${project.id}: ${selected.candidate.filePath}; issues=${contract.issues.length}; publishableBeforeFilter=${publishableIssueCount}; mode=${config.diagnosticsMode}.`,
      );
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
      const publishableIssueCount = summarizeDiagnosticMode(
        contract.issues,
        config.diagnosticsMode,
      ).publishableBeforeFilter;
      this.logger.info(
        `Watch mode auto-enriched ${project.id} to ${result.plan.latestOutputPath}; issues=${contract.issues.length}; publishableBeforeFilter=${publishableIssueCount}; mode=${config.diagnosticsMode}.`,
      );
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
          this.logger.warn(warning);
          this.setProjectStatus(project.id, warning);
          void vscode.window.showWarningMessage(warning);
          return;
        }

        this.setProjectStatus(
          project.id,
          `${reason} promoted enriched diagnostics to ${promotion.activeDiagnosticsPath}.`,
        );
        this.suppressWatchEvents([
          refreshed.candidate.filePath,
          promotion.activeDiagnosticsPath,
        ]);
        await this.publishProjectDiagnosticsFromPath(
          project,
          promotion.activeDiagnosticsPath,
          `${reason}: project-scoped republish`,
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
        extensionRoot: this.context.extensionUri.fsPath,
        pythonInterpreter: config.pythonInterpreter,
        project,
        workspaceFolders,
        rawIssuesPath: refreshed.candidate.filePath,
      });
      this.logger.info(
        `Enriching refreshed diagnostics for ${project.id}: raw ${enrichmentPlan.rawIssuesPath}; latest ${enrichmentPlan.latestOutputPath}.`,
      );
      await runEnrichmentPlan(enrichmentPlan, { promoteLatest: false });
      const promotion = await evaluateRefreshBaselinePromotion({
        currentBaselinePath: enrichmentPlan.latestOutputPath,
        refreshedDiagnosticsPath: enrichmentPlan.archiveOutputPath,
        latestOutputPath: enrichmentPlan.latestOutputPath,
      });
      if (promotion.drift.detected) {
        const warning = `${formatRefreshScopeDriftWarning(projectLabel(project), promotion.drift)} Refreshed run preserved at ${enrichmentPlan.archiveOutputPath}.`;
        this.logger.warn(warning);
        this.setProjectStatus(project.id, warning);
        void vscode.window.showWarningMessage(warning);
        return;
      }

      this.setProjectStatus(project.id, `${reason} wrote ${promotion.activeDiagnosticsPath}.`);
      this.suppressWatchEvents([
        refreshed.candidate.filePath,
        enrichmentPlan.archiveOutputPath,
        promotion.activeDiagnosticsPath,
      ]);
      await this.publishProjectDiagnosticsFromPath(
        project,
        promotion.activeDiagnosticsPath,
        `${reason}: project-scoped republish`,
      );
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