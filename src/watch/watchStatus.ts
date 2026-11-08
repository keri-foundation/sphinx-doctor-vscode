import * as vscode from 'vscode';

import { SELF_TEST_STATUS_TEXT } from '../commands/selfTestDiagnostic';
import { WatchModeSummary } from '../types';
import { applyExtensionModeBadge } from './watchFormatting';
import {
  buildWatchModeSummary,
  formatWatchModeText,
  formatWatchModeTooltip,
} from './watchModeState';

export class WatchStatusController {
  private summary: WatchModeSummary;
  private manualDiagnosticsActive = false;

  constructor(
    private readonly statusItem: vscode.StatusBarItem,
    private readonly extensionMode: vscode.ExtensionMode,
  ) {
    this.summary = buildWatchModeSummary({
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
    this.applySummary(this.summary);
  }

  show(): void {
    this.statusItem.show();
  }

  getSummary(): WatchModeSummary {
    return this.summary;
  }

  applySummary(summary: WatchModeSummary): void {
    this.summary = summary;
    this.statusItem.text = applyExtensionModeBadge(
      formatWatchModeText(summary),
      this.extensionMode,
    );
    this.statusItem.tooltip = formatWatchModeTooltip(summary);
  }

  isManualDiagnosticsActive(): boolean {
    return this.manualDiagnosticsActive;
  }

  setManualDiagnosticsActive(active: boolean): void {
    this.manualDiagnosticsActive = active;
  }

  applySelfTestStatus(
    targetUri: vscode.Uri,
    diagnosticCount: number,
    tooltip: string,
  ): void {
    this.statusItem.text = applyExtensionModeBadge(
      SELF_TEST_STATUS_TEXT,
      this.extensionMode,
    );
    this.statusItem.tooltip = tooltip || [
      'Sphinx Doctor self-test diagnostic published.',
      `Target: ${targetUri.toString()}`,
      `Published diagnostics: ${diagnosticCount}`,
    ].join('\n');
  }

  dispose(): void {
    this.statusItem.dispose();
  }
}
