import type { QuickPickItem } from 'vscode';

import {
  DEFAULT_DISCOVERY_INVENTORY_WORKSPACE_FOLDER_NAMES,
  DEFAULT_PREFERRED_INVENTORY_FILES,
  DEFAULT_PYTHON_INTERPRETER,
  DEFAULT_REFRESH_DEBOUNCE_MS,
  DEFAULT_WATCH_DEBOUNCE_MS,
  MIN_REFRESH_DEBOUNCE_MS,
} from '../constants/config';
import {
  ConfiguredProject,
  ExtensionConfig,
  normalizeDiagnosticMode,
  ProjectRefreshConfig,
} from '../types';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => asString(entry))
    .filter((entry): entry is string => entry !== undefined);
}

export function coerceRefreshDebounceMs(value: unknown): number {
  const parsed = asNumber(value);
  if (parsed === undefined || parsed < MIN_REFRESH_DEBOUNCE_MS) {
    return DEFAULT_REFRESH_DEBOUNCE_MS;
  }

  return parsed;
}

function normalizeRefreshConfig(value: unknown): ProjectRefreshConfig | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const cwdWorkspaceFolder = asString(record.cwdWorkspaceFolder);
  const command = asString(record.command);
  const args = asStringArray(record.args);
  const expectedOutputGlobs = asStringArray(record.expectedOutputGlobs);

  if (!cwdWorkspaceFolder || !command || args.length === 0 || expectedOutputGlobs.length === 0) {
    return undefined;
  }

  return {
    enabled: asBoolean(record.enabled) ?? true,
    cwdWorkspaceFolder,
    command,
    args,
    expectedOutputGlobs,
  };
}

function normalizeProject(value: unknown): ConfiguredProject | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const id = asString(record.id);
  const sourceWorkspaceFolder = asString(record.sourceWorkspaceFolder);
  const inventoryWorkspaceFolder = asString(record.inventoryWorkspaceFolder);
  const inventorySearchGlobs = asStringArray(record.inventorySearchGlobs);
  if (!id || !sourceWorkspaceFolder || !inventoryWorkspaceFolder || inventorySearchGlobs.length === 0) {
    return undefined;
  }

  const preferredInventoryFiles = asStringArray(record.preferredInventoryFiles);

  return {
    id,
    label: asString(record.label),
    sourceWorkspaceFolder,
    inventoryWorkspaceFolder,
    repoRoot: asString(record.repoRoot) ?? '.',
    docsRoot: asString(record.docsRoot),
    inventorySearchGlobs,
    preferredInventoryFiles:
      preferredInventoryFiles.length > 0 ? preferredInventoryFiles : [...DEFAULT_PREFERRED_INVENTORY_FILES],
    mirrorRoot: asString(record.mirrorRoot),
    refresh: normalizeRefreshConfig(record.refresh),
  };
}

export function coerceProjects(value: unknown): ConfiguredProject[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => normalizeProject(entry))
    .filter((entry): entry is ConfiguredProject => entry !== undefined);
}

export function projectLabel(project: ConfiguredProject): string {
  return project.label ?? project.id;
}

export function projectSelectionMode(projects: ConfiguredProject[]): 'none' | 'single' | 'pick' {
  if (projects.length === 0) {
    return 'none';
  }

  if (projects.length === 1) {
    return 'single';
  }

  return 'pick';
}

export interface ProjectQuickPickItem extends QuickPickItem {
  project: ConfiguredProject;
}

export function buildProjectQuickPickItems(projects: ConfiguredProject[]): ProjectQuickPickItem[] {
  return projects.map((project) => ({
    label: projectLabel(project),
    description: project.label ? project.id : project.sourceWorkspaceFolder,
    detail: `${project.sourceWorkspaceFolder} <- ${project.inventoryWorkspaceFolder}`,
    project,
  }));
}

export function getExtensionConfig(): ExtensionConfig {
  const vscode = require('vscode') as typeof import('vscode');
  const configuration = vscode.workspace.getConfiguration('sphinxDoctor');
  return {
    projects: coerceProjects(configuration.get('projects')),
    defaultSourceWorkspaceFolder: configuration.get<string>('defaultSourceWorkspaceFolder', ''),
    diagnosticsMode: normalizeDiagnosticMode(configuration.get('diagnostics.mode')),
    pythonInterpreter:
      asString(configuration.get('python.interpreter')) ?? DEFAULT_PYTHON_INTERPRETER,
    enrichmentEnabled: asBoolean(configuration.get('enrichment.enabled')) ?? true,
    enrichmentAutoRun: asBoolean(configuration.get('enrichment.autoRun')) ?? false,
    discoveryEnabled: asBoolean(configuration.get('discovery.enabled')) ?? true,
    discoveryIncludeLowConfidence:
      asBoolean(configuration.get('discovery.includeLowConfidence')) ?? false,
    discoveryInventoryWorkspaceFolderNames: (() => {
      const names = asStringArray(configuration.get('discovery.inventoryWorkspaceFolderNames'));
      return names.length > 0 ? names : [...DEFAULT_DISCOVERY_INVENTORY_WORKSPACE_FOLDER_NAMES];
    })(),
    discoveryExcludeWorkspaceFolders: asStringArray(
      configuration.get('discovery.excludeWorkspaceFolders'),
    ),
    watchEnabled: asBoolean(configuration.get('watch.enabled')) ?? true,
    watchAutoLoadOnStartup: asBoolean(configuration.get('watch.autoLoadOnStartup')) ?? true,
    watchDebounceMs: Math.max(0, asNumber(configuration.get('watch.debounceMs')) ?? DEFAULT_WATCH_DEBOUNCE_MS),
    refreshAutoRunOnStartup: asBoolean(configuration.get('refresh.autoRunOnStartup')) ?? false,
    refreshAutoRunOnSave: asBoolean(configuration.get('refresh.autoRunOnSave')) ?? false,
    refreshDebounceMs: coerceRefreshDebounceMs(configuration.get('refresh.debounceMs')),
    directRunEnabled: asBoolean(configuration.get('directRun.enabled')) ?? true,
    sphinxCommand: asString(configuration.get('sphinx.command')) ?? 'sphinx-build',
    sphinxBuilder: asString(configuration.get('sphinx.builder')) ?? 'dirhtml',
    sphinxSourceDir: asString(configuration.get('sphinx.sourceDir')) ?? 'docs',
    sphinxOutputDir: asString(configuration.get('sphinx.outputDir')) ?? '.tmp/sphinx-doctor/dirhtml',
    sphinxWarningFile: asString(configuration.get('sphinx.warningFile')) ?? '.tmp/sphinx-doctor/warnings.log',
    sphinxExtraArgs: asStringArray(configuration.get('sphinx.extraArgs')),
  };
}