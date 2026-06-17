import path from 'node:path';

import * as vscode from 'vscode';

import {
  buildProjectQuickPickItems,
  getExtensionConfig,
  projectLabel,
  projectSelectionMode,
} from './config';
import {
  DiagnosticsFileKind,
  inspectDiagnosticsFileBinding,
  inspectDiagnosticsFile,
  isDiagnosticsBindingCompatible,
  loadDiagnosticsFromPath,
} from './diagnostics/loadDiagnostics';
import {
  buildDiagnosticsAccountingReport,
  buildDiagnosticsCountsToastMessage,
} from './diagnostics/diagnosticsAccounting';
import { loadAllDiscoveredDiagnostics } from './diagnostics/loadAllDiagnostics';
import {
  buildEnrichmentRunPlan,
  evaluateRefreshBaselinePromotion,
  formatRefreshScopeDriftWarning,
  getEnrichmentPermission,
  runEnrichmentPlan,
} from './enrichmentRunner';
import {
  buildRefreshRunPlan,
  inferRefreshScopeFromContract,
  filterRecentInventoryCandidates,
  getRefreshPermission,
  inferProjectRefreshConfig,
  runRefreshPlan,
} from './refreshRunner';
import {
  buildSphinxRunPlan,
  getSphinxRunPermission,
  runSphinxPlan,
  SphinxRunConfig,
} from './sphinx/SphinxDoctorRunner';
import { parseSphinxWarnings } from './sphinx/SphinxWarningParser';
import { SphinxDoctorLogger } from './log';
import { computeDiagnosticsAccounting, publishDiagnostics, PublishLogger } from './publication/publishDiagnostics';
import { discoverWorkspaceProjectDecisions, mergeProjects } from './projectDiscovery';
import {
  listGitWorktreesPorcelain,
} from './projectDiscovery';
import {
  buildSelfTestStatusTooltip,
  clearPublishedDiagnostics,
  createSelfTestDiagnosticSpec,
  publishSelfTestDiagnostic,
  SELF_TEST_COMMAND_ID,
  SELF_TEST_FALLBACK_RELATIVE_PATH,
  SELF_TEST_STATUS_TEXT,
} from './selfTest';
import { DiagnosticsPublicationIndex } from './publication/publicationIndex';
import { ConfiguredProject, DiagnosticsContract, LastLoadedDiagnosticsState, WorkspaceFolderInfo } from './types';
import { SphinxDoctorWatchMode } from './watchMode';
import {
  findWorkspaceFolderByName,
  selectInventoryCandidate,
} from './workspace';

const LAST_DIAGNOSTICS_STATE_KEY = 'sphinxDoctor.lastLoadedDiagnostics';

// Single-flight tracking for Sphinx build command
let sphinxBuildInProgress = false;

interface CommandDependencies {
  collection: vscode.DiagnosticCollection;
  logger: SphinxDoctorLogger;
  watchMode?: SphinxDoctorWatchMode;
  publicationIndex: DiagnosticsPublicationIndex<vscode.Uri>;
}

interface LoadOptions {
  replaceMode?: 'full' | 'project';
  projectKey?: string;
  defaultSourceWorkspaceFolderOverride?: string;
  defaultRepoRootOverride?: string;
  fixtureSourceRoot?: string;
  allowFirstFolderFallback?: boolean;
}

interface DiscoveredInventoryCandidate {
  uri: vscode.Uri;
  filePath: string;
  fileName: string;
  directoryPath: string;
  modifiedTime: number;
  workspaceFolderName: string;
}

interface DiagnosticsSearchTarget {
  workspaceFolderName: string;
  globs: string[];
}

interface SelectedProjectDiagnostics {
  project: ConfiguredProject;
  candidate: DiscoveredInventoryCandidate;
  kind: DiagnosticsFileKind;
}

const NOOP_PUBLISH_LOGGER: PublishLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

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

function readLastLoadedDiagnosticsState(
  context: vscode.ExtensionContext,
): LastLoadedDiagnosticsState | undefined {
  const stored = context.workspaceState.get<LastLoadedDiagnosticsState | null>(LAST_DIAGNOSTICS_STATE_KEY);
  if (!stored || typeof stored.fileUri !== 'string' || stored.fileUri.length === 0) {
    return undefined;
  }

  return stored;
}

async function storeLastLoadedDiagnosticsState(
  context: vscode.ExtensionContext,
  state: LastLoadedDiagnosticsState,
): Promise<void> {
  await context.workspaceState.update(LAST_DIAGNOSTICS_STATE_KEY, state);
}

async function loadAndPublish(
  context: vscode.ExtensionContext,
  fileUri: vscode.Uri,
  dependencies: CommandDependencies,
  options: LoadOptions = {},
): Promise<void> {
  const config = getExtensionConfig();
  dependencies.logger.setLevel(config.logLevel);
  dependencies.logger.info(`Loading diagnostics file: ${fileUri.fsPath}`);

  const contract = await loadDiagnosticsFromPath(fileUri.fsPath);
  dependencies.logger.info(
    `Loaded schema ${contract.schema} v${contract.schemaVersion} with ${contract.issues.length} issues; mapped ${contract.summary.mappedCount}, unmapped ${contract.summary.unmappedCount}.`,
  );
  dependencies.logger.info(
    `Diagnostics contract publishable count: ${contract.summary.publishedDiagnostics}; retained-only count: ${contract.summary.retainedOnly}.`,
  );

  const result = publishDiagnostics(dependencies.collection, contract, {
    workspaceFolders: vscode.workspace.workspaceFolders,
    diagnosticMode: config.diagnosticsMode,
    replaceMode: options.replaceMode,
    projectKey: options.projectKey,
    publicationIndex: dependencies.publicationIndex,
    defaultSourceWorkspaceFolder:
      options.defaultSourceWorkspaceFolderOverride ?? config.defaultSourceWorkspaceFolder,
    defaultRepoRoot: options.defaultRepoRootOverride,
    fixtureSourceRoot: options.fixtureSourceRoot,
    allowFirstFolderFallback: options.allowFirstFolderFallback,
    logger: dependencies.logger,
  });

  await storeLastLoadedDiagnosticsState(context, {
    fileUri: fileUri.toString(),
    defaultSourceWorkspaceFolder: options.defaultSourceWorkspaceFolderOverride,
    defaultRepoRoot: options.defaultRepoRootOverride,
  });

  dependencies.logger.info(
    `Published ${result.publishedDiagnostics} diagnostics in ${config.diagnosticsMode} mode across ${result.targetUriCount} target URIs; ${result.publishableBeforeFilter} were publishable before filter, ${result.filteredByMode} were filtered by mode, ${result.skippedIssues} were skipped, and ${result.resolutionFailures} hit resolution failures.`,
  );
  dependencies.logger.info('Diagnostics collection update completed.');

  const statusMessage =
    `Sphinx Doctor loaded ${result.issueCount} issues; ${result.publishableBeforeFilter} publishable before filter; ${result.publishedDiagnostics} published in ${config.diagnosticsMode} mode.`;
  dependencies.watchMode?.noteManualDiagnosticsPublished({
    filePath: fileUri.fsPath,
    issueCount: result.issueCount,
    publishableBeforeFilter: result.publishableBeforeFilter,
    publishedDiagnostics: result.publishedDiagnostics,
    filteredByMode: result.filteredByMode,
    skippedIssues: result.skippedIssues,
    resolutionFailures: result.resolutionFailures,
    message: statusMessage,
  });
  void vscode.window.showInformationMessage(statusMessage);
}

async function explainDiagnosticsCounts(
  context: vscode.ExtensionContext,
  dependencies: CommandDependencies,
): Promise<void> {
  const config = getExtensionConfig();
  dependencies.logger.setLevel(config.logLevel);

  const lastLoaded = readLastLoadedDiagnosticsState(context);
  if (!lastLoaded) {
    void vscode.window.showInformationMessage(
      'No previous diagnostics file is stored yet. Run Sphinx Doctor: Load Project Diagnostics, Discover and Load Diagnostics, or Refresh Project Diagnostics first.',
    );
    return;
  }

  const diagnosticsUri = vscode.Uri.parse(lastLoaded.fileUri);
  try {
    await vscode.workspace.fs.stat(diagnosticsUri);
  } catch {
    void vscode.window.showWarningMessage(
      'The last loaded diagnostics file is no longer available. Run Sphinx Doctor: Load Project Diagnostics, Discover and Load Diagnostics, or Refresh Project Diagnostics again.',
    );
    return;
  }

  const contract = await loadDiagnosticsFromPath(diagnosticsUri.fsPath);
  const accounting = computeDiagnosticsAccounting(contract, {
    workspaceFolders: vscode.workspace.workspaceFolders,
    diagnosticMode: config.diagnosticsMode,
    defaultSourceWorkspaceFolder:
      lastLoaded.defaultSourceWorkspaceFolder ?? config.defaultSourceWorkspaceFolder,
    defaultRepoRoot: lastLoaded.defaultRepoRoot,
    logger: NOOP_PUBLISH_LOGGER,
  });
  const report = buildDiagnosticsAccountingReport({
    contract,
    diagnosticMode: config.diagnosticsMode,
    diagnosticsFilePath: diagnosticsUri.fsPath,
    accounting,
  });

  for (const line of report.split(/\r?\n/)) {
    dependencies.logger.info(line);
  }
  dependencies.logger.show(true);

  void vscode.window.showInformationMessage(
    buildDiagnosticsCountsToastMessage({
      contract,
      diagnosticMode: config.diagnosticsMode,
      diagnosticsFilePath: diagnosticsUri.fsPath,
      accounting,
    }),
  );
}

async function selectProject(projects: ConfiguredProject[]): Promise<ConfiguredProject | undefined> {
  const mode = projectSelectionMode(projects);
  if (mode === 'none') {
    return undefined;
  }

  if (mode === 'single') {
    return projects[0];
  }

  const selected = await vscode.window.showQuickPick(buildProjectQuickPickItems(projects), {
    placeHolder: 'Select a Sphinx Doctor project to load diagnostics for',
    matchOnDescription: true,
    matchOnDetail: true,
  });

  return selected?.project;
}

async function selectInventoryCandidateInteractively(
  project: ConfiguredProject,
  candidates: DiscoveredInventoryCandidate[],
  logger: SphinxDoctorLogger,
): Promise<DiscoveredInventoryCandidate | undefined> {
  const selection = selectInventoryCandidate(project, candidates, project.preferredInventoryFiles);
  if (selection.selected) {
    return selection.selected;
  }

  if (!selection.ambiguous || selection.ambiguous.length === 0) {
    return undefined;
  }

  logger.warn(
    `Inventory discovery for ${project.id} is ambiguous across ${selection.ambiguous.length} candidates; asking the user to choose.`,
  );

  const picked = await vscode.window.showQuickPick(
    selection.ambiguous.map((candidate) => ({
      label: candidate.fileName,
      description: candidate.workspaceFolderName,
      detail: candidate.filePath,
      candidate,
    })),
    {
      placeHolder: `Select diagnostics artifact for ${projectLabel(project)}`,
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );

  return picked?.candidate;
}

function inventorySearchTargets(project: ConfiguredProject): DiagnosticsSearchTarget[] {
  return project.inventorySearchTargets && project.inventorySearchTargets.length > 0
    ? project.inventorySearchTargets
    : [
        {
          workspaceFolderName: project.inventoryWorkspaceFolder,
          globs: project.inventorySearchGlobs,
        },
      ];
}

async function discoverDiagnosticsCandidates(
  searchTargets: DiagnosticsSearchTarget[],
  fallbackWorkspaceFolderName: string,
): Promise<DiscoveredInventoryCandidate[]> {
  const workspaceFolders = toWorkspaceFolderInfo(vscode.workspace.workspaceFolders);

  const foundUris = new Map<string, vscode.Uri>();
  const uriOrigins = new Map<string, string>();
  for (const searchTarget of searchTargets) {
    const inventoryFolder = findWorkspaceFolderByName(workspaceFolders, searchTarget.workspaceFolderName);
    if (!inventoryFolder) {
      continue;
    }

    for (const inventorySearchGlob of searchTarget.globs) {
      const relativePattern = new vscode.RelativePattern(inventoryFolder.fsPath, inventorySearchGlob);
      const matches = await vscode.workspace.findFiles(relativePattern);
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
      workspaceFolderName: uriOrigins.get(uri.toString()) ?? fallbackWorkspaceFolderName,
    });
  }

  return candidates;
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

async function filterCompatibleCandidates(
  project: ConfiguredProject,
  candidates: DiscoveredInventoryCandidate[],
  workspaceFolders: WorkspaceFolderInfo[],
  logger: SphinxDoctorLogger,
): Promise<DiscoveredInventoryCandidate[]> {
  const sourceRoot = projectSourceRoot(project, workspaceFolders);
  if (!sourceRoot) {
    logger.warn(
      `Source workspace folder ${project.sourceWorkspaceFolder} could not be resolved for ${project.id}; no shared inventory candidate will be bound automatically.`,
    );
    return [];
  }

  const compatible: DiscoveredInventoryCandidate[] = [];
  for (const candidate of candidates) {
    const binding = await inspectDiagnosticsFileBinding(candidate.filePath);
    const compatibility = isDiagnosticsBindingCompatible(binding, {
      sourceWorkspaceFolder: project.sourceWorkspaceFolder,
      sourceRoot,
    });
    if (!compatibility.compatible) {
      logger.warn(
        `Skipping inventory candidate for ${project.id}: ${candidate.filePath}. ${compatibility.reason ?? 'Binding mismatch.'}`,
      );
      continue;
    }
    compatible.push(candidate);
  }

  return compatible;
}

async function resolveProjectDiagnosticsFileFromSearchTargets(
  project: ConfiguredProject,
  logger: SphinxDoctorLogger,
  searchTargets: DiagnosticsSearchTarget[],
  emptyMessage: string,
  minimumModifiedTime?: number,
): Promise<SelectedProjectDiagnostics | undefined> {
  const workspaceFolders = toWorkspaceFolderInfo(vscode.workspace.workspaceFolders);
  const discovered = await discoverDiagnosticsCandidates(searchTargets, project.inventoryWorkspaceFolder);
  const freshCandidates =
    minimumModifiedTime === undefined
      ? discovered
      : filterRecentInventoryCandidates(discovered, minimumModifiedTime);
  if (
    minimumModifiedTime !== undefined &&
    discovered.length > 0 &&
    freshCandidates.length === 0
  ) {
    logger.warn(
      `Ignoring ${discovered.length} stale diagnostics candidates for ${project.id} because they predate the current refresh run.`,
    );
  }
  const candidates = await filterCompatibleCandidates(project, freshCandidates, workspaceFolders, logger);
  if (candidates.length === 0) {
    void vscode.window.showWarningMessage(emptyMessage);
    return undefined;
  }

  const selected = await selectInventoryCandidateInteractively(project, candidates, logger);
  if (!selected) {
    void vscode.window.showWarningMessage(
      `Sphinx Doctor found inventory candidates for ${projectLabel(project)} but could not choose one.`,
    );
    return undefined;
  }

  logger.info(
    `Selected project ${project.id} from ${project.sourceWorkspaceFolder}; inventory root ${selected.workspaceFolderName}; picked ${selected.filePath}.`,
  );

  const kind = await inspectDiagnosticsFile(selected.filePath);
  logger.info(`Detected ${kind} diagnostics file for ${project.id}: ${selected.filePath}.`);

  return {
    project,
    candidate: selected,
    kind,
  };
}

async function resolveProjectDiagnosticsFile(
  project: ConfiguredProject,
  logger: SphinxDoctorLogger,
): Promise<SelectedProjectDiagnostics | undefined> {
  return resolveProjectDiagnosticsFileFromSearchTargets(
    project,
    logger,
    inventorySearchTargets(project),
    `No compatible diagnostics files matched the configured search targets for ${projectLabel(project)}.`,
  );
}

async function selectConfiguredProject(
  logger: SphinxDoctorLogger,
): Promise<ConfiguredProject | undefined> {
  const config = getExtensionConfig();
  logger.setLevel(config.logLevel);

  if (config.projects.length === 0) {
    void vscode.window.showWarningMessage(
      'No Sphinx Doctor projects are configured. Add sphinxDoctor.projects to workspace settings and run the command again.',
    );
    return undefined;
  }

  return selectProject(config.projects);
}

async function projectDiscoveryProbeExists(filePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    return true;
  } catch {
    return false;
  }
}

async function projectDiscoveryProbeReadText(filePath: string): Promise<string | undefined> {
  try {
    const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
    return Buffer.from(content).toString('utf8');
  } catch {
    return undefined;
  }
}

async function discoverProjectsFromWorkspace(
  logger: SphinxDoctorLogger,
): Promise<ConfiguredProject[]> {
  const config = getExtensionConfig();
  logger.setLevel(config.logLevel);

  if (!config.discoveryEnabled) {
    return [];
  }

  const workspaceFolders = toWorkspaceFolderInfo(vscode.workspace.workspaceFolders);
  const decisions = await discoverWorkspaceProjectDecisions(
    workspaceFolders,
    {
      includeLowConfidence: config.discoveryIncludeLowConfidence,
      inventoryWorkspaceFolderNames: config.discoveryInventoryWorkspaceFolderNames,
      excludeWorkspaceFolderNames: config.discoveryExcludeWorkspaceFolders,
      knownProjects: config.projects,
    },
    {
      exists: projectDiscoveryProbeExists,
      readText: projectDiscoveryProbeReadText,
      listGitWorktrees:
        vscode.workspace.isTrusted === true ? listGitWorktreesPorcelain : undefined,
    },
  );

  logDiscoveryDecisions(logger, decisions);
  return decisions.flatMap((decision) => (decision.project ? [decision.project] : []));
}

async function selectMergedProject(
  logger: SphinxDoctorLogger,
): Promise<ConfiguredProject | undefined> {
  const config = getExtensionConfig();
  logger.setLevel(config.logLevel);

  const discoveredProjects = await discoverProjectsFromWorkspace(logger);
  const mergedProjects = mergeProjects(config.projects, discoveredProjects);
  if (mergedProjects.length === 0) {
    void vscode.window.showWarningMessage(
      'Sphinx Doctor did not find any configured or discoverable workspace projects.',
    );
    return undefined;
  }

  return selectProject(mergedProjects);
}

async function discoverOnlyProject(
  logger: SphinxDoctorLogger,
): Promise<ConfiguredProject | undefined> {
  const discoveredProjects = await discoverProjectsFromWorkspace(logger);
  if (discoveredProjects.length === 0) {
    void vscode.window.showWarningMessage(
      'Sphinx Doctor did not discover any Sphinx-capable workspace folders with high-confidence conf.py markers.',
    );
    return undefined;
  }

  return selectProject(discoveredProjects);
}

async function loadSelectedProjectDiagnostics(
  context: vscode.ExtensionContext,
  dependencies: CommandDependencies,
  selected: SelectedProjectDiagnostics,
): Promise<void> {
  await loadAndPublish(context, selected.candidate.uri, dependencies, {
    replaceMode: 'project',
    projectKey: selected.project.id,
    defaultSourceWorkspaceFolderOverride: selected.project.sourceWorkspaceFolder,
    defaultRepoRootOverride: selected.project.repoRoot,
  });
}

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
  logger.debug(`${label}: ${lines}`);
}

interface WarningFileSummary {
  byteLength: number;
  lineCount: number;
  blankLineCount: number;
  nonBlankLineCount: number;
  docstringWarningCount: number;
  standardWarningCount: number;
  globalWarningCount: number;
  firstTenLines: string;
}

function summarizeWarningFileContent(content: string): WarningFileSummary {
  const lines = content.split(/\r?\n/);
  const blankLineCount = lines.filter((line) => line.trim().length === 0).length;

  return {
    byteLength: Buffer.byteLength(content, 'utf8'),
    lineCount: lines.length,
    blankLineCount,
    nonBlankLineCount: lines.length - blankLineCount,
    docstringWarningCount: lines.filter((line) => line.includes('docstring of')).length,
    standardWarningCount: lines.filter((line) => /^[^:]+:[0-9]+: (WARNING|ERROR|INFO):/.test(line)).length,
    globalWarningCount: lines.filter((line) => /^(WARNING|ERROR|INFO):/.test(line)).length,
    firstTenLines: lines.slice(0, 10).map((line) => line.trimEnd()).join(' | '),
  };
}

function shouldTreatWarningFileAsEmpty(summary: WarningFileSummary): boolean {
  return summary.byteLength === 0 || summary.nonBlankLineCount === 0;
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
  contract?: import('./types').DiagnosticsContract;
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

async function runRefreshAndLoadProjectDiagnostics(
  context: vscode.ExtensionContext,
  dependencies: CommandDependencies,
  project: ConfiguredProject,
): Promise<void> {
  const config = getExtensionConfig();
  dependencies.logger.setLevel(config.logLevel);
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
  dependencies.logger.info(
    `Running refresh for ${project.id} (${refreshResolution.source ?? 'configured'}) with ${refreshPlan.command} ${refreshPlan.args.join(' ')} in ${refreshPlan.cwd}; source ${refreshPlan.sourceRoot}; inventory ${refreshPlan.inventoryRoot}.`,
  );

  const refreshResult = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Sphinx Doctor: Refreshing diagnostics for ${projectLabel(project)}`,
    },
    async () => runRefreshPlan(refreshPlan),
  );

  dependencies.logger.info(
    `Refresh finished with exit code ${refreshResult.exitCode}; source ${refreshResult.plan.sourceRoot}; inventory ${refreshResult.plan.inventoryRoot}; mirror ${refreshResult.plan.mirrorRootPath}.`,
  );
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
      dependencies.logger.warn(warning);
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

        dependencies.logger.info(
          `Enriching refreshed diagnostics with ${plan.command} in ${plan.cwd}; raw ${plan.rawIssuesPath}; archive ${plan.archiveOutputPath}; latest ${plan.latestOutputPath}.`,
        );

        const result = await runEnrichmentPlan(plan, { promoteLatest: false });
        dependencies.logger.info(
          `Refresh enrichment completed with exit code ${result.exitCode}; raw ${result.plan.rawIssuesPath}; archive ${result.plan.archiveOutputPath}; latest ${result.plan.latestOutputPath}.`,
        );
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
      dependencies.logger.warn(warning);
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

async function loadOrEnrichProjectDiagnostics(
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
      dependencies.logger.warn(`Selected raw inventory file ${selected.candidate.filePath}; use the explicit enrichment command to transform it before publishing.`);
      void vscode.window.showWarningMessage(
        `Sphinx Doctor found raw issues.json for ${projectLabel(project)}. Run Sphinx Doctor: Enrich and Load Project Diagnostics to transform and publish it.`,
      );
      return;
    }

    const config = getExtensionConfig();
    dependencies.logger.setLevel(config.logLevel);
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

        dependencies.logger.info(
          `Running enrichment with ${plan.command} in ${plan.cwd}; raw ${plan.rawIssuesPath}; archive ${plan.archiveOutputPath}; latest ${plan.latestOutputPath}.`,
        );

        const result = await runEnrichmentPlan(plan);
        dependencies.logger.info(
          `Enrichment completed with exit code ${result.exitCode}; raw ${result.plan.rawIssuesPath}; enriched ${result.plan.archiveOutputPath}; latest ${result.plan.latestOutputPath}.`,
        );
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

async function runSafely(
  logger: SphinxDoctorLogger,
  label: string,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`${label} failed: ${message}`);
    void vscode.window.showErrorMessage(`Sphinx Doctor failed: ${message}`);
  }
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