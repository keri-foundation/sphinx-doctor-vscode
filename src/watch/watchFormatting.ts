import * as vscode from 'vscode';

import type { ExtensionConfig, WatchModeSummary } from '../types';

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
