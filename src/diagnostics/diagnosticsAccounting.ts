import type { PublishResult } from '../publication/publishDiagnostics';
import { DiagnosticMode, DiagnosticsContract } from '../types';

export interface DiagnosticsAccountingReportInput {
  contract: DiagnosticsContract;
  diagnosticMode: DiagnosticMode;
  diagnosticsFilePath: string;
  accounting: PublishResult;
}

export function buildDiagnosticsAccountingReport(
  input: DiagnosticsAccountingReportInput,
): string {
  const lines = [
    'Sphinx Doctor diagnostics count explanation:',
    `- diagnostic mode: ${input.diagnosticMode}`,
    `- diagnostics file: ${input.diagnosticsFilePath}`,
    `- total enriched issues: ${input.accounting.issueCount}`,
    `- contract summary published diagnostics: ${input.contract.summary.publishedDiagnostics}`,
    `- contract retained-only count: ${input.contract.summary.retainedOnly}`,
    `- publishable before mode filter: ${input.accounting.publishableBeforeFilter}`,
    `- published after mode filter: ${input.accounting.publishedDiagnostics}`,
    `- filtered by mode: ${input.accounting.filteredByMode}`,
    `- skipped issues: ${input.accounting.skippedIssues}`,
    `- resolution failures: ${input.accounting.resolutionFailures}`,
    `- target URI count: ${input.accounting.targetUriCount}`,
    '- explanation: Problems should match published after mode filter, not total enriched issues.',
  ];

  return lines.join('\n');
}

export function buildDiagnosticsCountsToastMessage(
  input: DiagnosticsAccountingReportInput,
): string {
  return `Problems should match ${input.accounting.publishedDiagnostics} published diagnostics in ${input.diagnosticMode} mode, not ${input.accounting.issueCount} total enriched issues.`;
}