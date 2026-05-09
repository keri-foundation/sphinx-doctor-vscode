import path from 'node:path';

import { getEnrichmentPermission } from './enrichmentRunner';
import {
  ConfiguredProject,
  DiagnosticMode,
  ExtensionConfig,
  WatchModeSummary,
  WorkspaceFolderInfo,
} from './types';
import { findWorkspaceFolderByName } from './workspace';

export interface DebounceScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DebouncedTrigger {
  trigger(reason: string): void;
  dispose(): void;
}

export interface SingleFlightController {
  tryStart(key: string): boolean;
  finish(key: string): void;
  isRunning(key: string): boolean;
}

export interface RefreshOnSaveDecision {
  allowed: boolean;
  reason: string;
  project?: ConfiguredProject;
}

export interface WatchModeStartupOptions {
  config: Pick<ExtensionConfig, 'watchEnabled' | 'watchAutoLoadOnStartup'>;
  refresh(reason: string, loadDiagnostics: boolean): Promise<void>;
}

interface RefreshStats {
  projectCount: number;
  loadedProjectCount: number;
  issueCount: number;
  publishableBeforeFilter: number;
  publishedDiagnostics: number;
  watcherCount: number;
  rawPendingCount: number;
  errorCount: number;
  diagnosticMode: DiagnosticMode;
  message?: string;
}

const RELEVANT_REFRESH_EXTENSIONS = new Set(['.py', '.rst', '.md']);
const RELEVANT_REFRESH_BASENAMES = new Set([
  'conf.py',
  'makefile',
  'make.bat',
  'requirements.txt',
  'requirements-docs.txt',
  'pyproject.toml',
]);

function normalizeFilePath(value: string): string {
  return path.resolve(value);
}

function isWithinRoot(filePath: string, rootPath: string): boolean {
  const normalizedFile = normalizeFilePath(filePath);
  const normalizedRoot = normalizeFilePath(rootPath);
  return (
    normalizedFile === normalizedRoot ||
    normalizedFile.startsWith(`${normalizedRoot}${path.sep}`)
  );
}

export function shouldStartWatchMode(
  config: Pick<ExtensionConfig, 'watchEnabled' | 'watchAutoLoadOnStartup'>,
): boolean {
  return config.watchEnabled && config.watchAutoLoadOnStartup;
}

export async function runWatchModeStartup(options: WatchModeStartupOptions): Promise<boolean> {
  if (!options.config.watchEnabled) {
    return false;
  }

  await options.refresh('activation', options.config.watchAutoLoadOnStartup);
  return options.config.watchAutoLoadOnStartup;
}

export function canAutoRunEnrichment(
  isWorkspaceTrusted: boolean,
  config: Pick<ExtensionConfig, 'enrichmentEnabled' | 'enrichmentAutoRun'>,
): boolean {
  return config.enrichmentAutoRun && getEnrichmentPermission(isWorkspaceTrusted, config.enrichmentEnabled).allowed;
}

export function hasOpenWorkspaceFolders(workspaceFolders: WorkspaceFolderInfo[]): boolean {
  return workspaceFolders.length > 0;
}

export function isExcludedWorkspaceFolder(
  folderName: string,
  excludedWorkspaceFolderNames: string[],
): boolean {
  return excludedWorkspaceFolderNames.includes(folderName);
}

export function isRelevantRefreshSavePath(filePath: string): boolean {
  const normalized = normalizeFilePath(filePath);
  if (normalized.split(path.sep).includes('.sphinx-diagnostics')) {
    return false;
  }

  const baseName = path.basename(normalized).toLowerCase();
  if (RELEVANT_REFRESH_BASENAMES.has(baseName)) {
    return true;
  }

  return RELEVANT_REFRESH_EXTENSIONS.has(path.extname(baseName));
}

export function findOwningProjectForPath(
  filePath: string,
  projects: ConfiguredProject[],
  workspaceFolders: WorkspaceFolderInfo[],
): ConfiguredProject | undefined {
  const matches = projects
    .map((project) => {
      const sourceFolder = findWorkspaceFolderByName(workspaceFolders, project.sourceWorkspaceFolder);
      if (!sourceFolder) {
        return undefined;
      }

      const sourceRoot = path.resolve(sourceFolder.fsPath, project.repoRoot ?? '.');
      if (!isWithinRoot(filePath, sourceRoot)) {
        return undefined;
      }

      return {
        project,
        sourceRoot,
      };
    })
    .filter(
      (entry): entry is { project: ConfiguredProject; sourceRoot: string } => entry !== undefined,
    )
    .sort((left, right) => right.sourceRoot.length - left.sourceRoot.length);

  return matches[0]?.project;
}

export function getRefreshOnSaveDecision(
  filePath: string,
  projects: ConfiguredProject[],
  workspaceFolders: WorkspaceFolderInfo[],
  options: {
    refreshAutoRunOnSave: boolean;
    isWorkspaceTrusted: boolean;
  },
): RefreshOnSaveDecision {
  if (!options.refreshAutoRunOnSave) {
    return {
      allowed: false,
      reason: 'Refresh-on-save is disabled by settings.',
    };
  }

  if (!options.isWorkspaceTrusted) {
    return {
      allowed: false,
      reason: 'Refresh-on-save requires a trusted workspace.',
    };
  }

  if (!isRelevantRefreshSavePath(filePath)) {
    return {
      allowed: false,
      reason: 'Saved file is not a relevant refresh input.',
    };
  }

  const project = findOwningProjectForPath(filePath, projects, workspaceFolders);
  if (!project) {
    return {
      allowed: false,
      reason: 'Saved file does not belong to any known Sphinx Doctor project.',
    };
  }

  return {
    allowed: true,
    reason: 'Saved file belongs to a refreshable project.',
    project,
  };
}

export function createSingleFlightController(): SingleFlightController {
  const running = new Set<string>();

  return {
    tryStart(key: string): boolean {
      if (running.has(key)) {
        return false;
      }

      running.add(key);
      return true;
    },
    finish(key: string): void {
      running.delete(key);
    },
    isRunning(key: string): boolean {
      return running.has(key);
    },
  };
}

export function buildWatchModeSummary(stats: RefreshStats): WatchModeSummary {
  if (stats.errorCount > 0) {
    return {
      state: 'error',
      projectCount: stats.projectCount,
      issueCount: stats.issueCount,
      publishableBeforeFilter: stats.publishableBeforeFilter,
      publishedDiagnostics: stats.publishedDiagnostics,
      watcherCount: stats.watcherCount,
      diagnosticMode: stats.diagnosticMode,
      message: stats.message ?? 'Sphinx Doctor watch mode hit an error. Check the output channel.',
    };
  }

  if (stats.publishedDiagnostics > 0) {
    return {
      state: 'watching',
      projectCount: stats.projectCount,
      issueCount: stats.issueCount,
      publishableBeforeFilter: stats.publishableBeforeFilter,
      publishedDiagnostics: stats.publishedDiagnostics,
      watcherCount: stats.watcherCount,
      diagnosticMode: stats.diagnosticMode,
      message:
        stats.message ??
        `Watching ${stats.projectCount} projects in ${stats.diagnosticMode} mode with ${stats.issueCount} issues, ${stats.publishableBeforeFilter} publishable before filter, and ${stats.publishedDiagnostics} published diagnostics.`,
    };
  }

  if (stats.projectCount === 0) {
    return {
      state: 'idle',
      projectCount: 0,
      issueCount: 0,
      publishableBeforeFilter: 0,
      publishedDiagnostics: 0,
      watcherCount: stats.watcherCount,
      diagnosticMode: stats.diagnosticMode,
      message: stats.message ?? 'No configured or discoverable Sphinx projects in the current workspace.',
    };
  }

  return {
    state: 'no-diagnostics',
    projectCount: stats.projectCount,
    issueCount: 0,
    publishableBeforeFilter: stats.publishableBeforeFilter,
    publishedDiagnostics: 0,
    watcherCount: stats.watcherCount,
    diagnosticMode: stats.diagnosticMode,
    message:
      stats.message ??
      (stats.rawPendingCount > 0
        ? `Raw diagnostics detected for ${stats.rawPendingCount} project(s); enable auto-run or use manual enrichment.`
        : 'No enriched diagnostics are available yet.'),
  };
}

export function formatWatchModeText(summary: WatchModeSummary): string {
  if (summary.state === 'error') {
    return 'Sphinx Doctor: error';
  }
  if (summary.issueCount > 0) {
    return `Sphinx Doctor: ${summary.issueCount} issues`;
  }
  if (summary.state === 'idle') {
    return 'Sphinx Doctor: idle';
  }
  return 'Sphinx Doctor: no diagnostics';
}

export function formatWatchModeTooltip(summary: WatchModeSummary): string {
  return [
    summary.message,
    `Mode: ${summary.diagnosticMode}`,
    `Projects: ${summary.projectCount}`,
    `Publishable before filter: ${summary.publishableBeforeFilter}`,
    `Published diagnostics: ${summary.publishedDiagnostics}`,
    `Watchers: ${summary.watcherCount}`,
  ].join('\n');
}

export function createDebouncedTrigger(
  callback: (reason: string) => void | Promise<void>,
  debounceMs: number,
  scheduler: DebounceScheduler = {
    setTimeout: (fn, delay) => setTimeout(fn, delay),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): DebouncedTrigger {
  let handle: unknown;
  let latestReason = 'refresh';

  return {
    trigger(reason: string): void {
      latestReason = reason;
      if (handle !== undefined) {
        scheduler.clearTimeout(handle);
      }
      handle = scheduler.setTimeout(() => {
        handle = undefined;
        void callback(latestReason);
      }, debounceMs);
    },
    dispose(): void {
      if (handle !== undefined) {
        scheduler.clearTimeout(handle);
        handle = undefined;
      }
    },
  };
}