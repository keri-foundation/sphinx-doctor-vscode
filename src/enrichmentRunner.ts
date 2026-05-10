import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { loadDiagnosticsFromPath } from './loadDiagnostics';
import { ConfiguredProject, DiagnosticsContract, WorkspaceFolderInfo } from './types';
import { findWorkspaceFolderByName } from './workspace';

export interface EnrichmentRunPlan {
  command: string;
  args: string[];
  cwd: string;
  rawIssuesPath: string;
  sourceRoot: string;
  inventoryRoot: string;
  repoRoot: string;
  docsRoot: string;
  mirrorRoot: string;
  mirrorRootPath: string;
  runId: string;
  runDirectoryPath: string;
  archiveOutputPath: string;
  latestOutputPath: string;
}

export interface EnrichmentRunResult {
  plan: EnrichmentRunPlan;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RefreshScopeSnapshot {
  total: number;
  mappedCount: number;
  retainedOnly: number;
  categories: string[];
}

export interface RefreshScopeComparison {
  hasCurrentBaseline: boolean;
  currentBaseline?: RefreshScopeSnapshot;
  refreshedBaseline: RefreshScopeSnapshot;
  totalIncrease: number;
  mappedIncrease: number;
  retainedOnlyIncrease: number;
  totalRatio?: number;
  mappedRatio?: number;
  addedCategories: string[];
}

export interface RefreshScopeDriftResult {
  detected: boolean;
  reasons: string[];
  comparison: RefreshScopeComparison;
}

export interface RefreshBaselinePromotionResult {
  currentBaseline?: DiagnosticsContract;
  refreshedBaseline: DiagnosticsContract;
  comparison: RefreshScopeComparison;
  drift: RefreshScopeDriftResult;
  promoted: boolean;
  activeDiagnosticsPath: string;
}

export interface BuildEnrichmentRunPlanOptions {
  extensionRoot: string;
  pythonInterpreter: string;
  project: ConfiguredProject;
  workspaceFolders: WorkspaceFolderInfo[];
  rawIssuesPath: string;
  now?: Date;
}

export interface EnrichmentPermission {
  allowed: boolean;
  reason?: string;
}

export interface RunEnrichmentPlanOptions {
  promoteLatest?: boolean;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function summarizeRefreshScope(contract: DiagnosticsContract): RefreshScopeSnapshot {
  return {
    total: contract.summary.total,
    mappedCount: contract.summary.mappedCount,
    retainedOnly: contract.summary.retainedOnly,
    categories: Object.keys(contract.summary.byCategory).sort(),
  };
}

function computeGrowthRatio(previousCount: number, nextCount: number): number | undefined {
  if (previousCount <= 0) {
    return undefined;
  }

  return nextCount / previousCount;
}

function formatScopeSnapshot(snapshot: RefreshScopeSnapshot): string {
  return `${snapshot.total} total, ${snapshot.mappedCount} mapped/publishable, ${snapshot.retainedOnly} retained-only, categories: ${snapshot.categories.join(', ') || 'none'}`;
}

async function loadCurrentBaselineContract(
  currentBaselinePath: string,
): Promise<DiagnosticsContract | undefined> {
  try {
    return await loadDiagnosticsFromPath(currentBaselinePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
}

export function buildRunId(now: Date): string {
  return [
    String(now.getFullYear()),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

export function buildRefreshScopeComparison(
  currentBaseline: DiagnosticsContract | undefined,
  refreshedBaseline: DiagnosticsContract,
): RefreshScopeComparison {
  const refreshedSnapshot = summarizeRefreshScope(refreshedBaseline);
  const currentSnapshot = currentBaseline ? summarizeRefreshScope(currentBaseline) : undefined;
  const addedCategories = refreshedSnapshot.categories.filter(
    (category) => !currentSnapshot?.categories.includes(category),
  );

  return {
    hasCurrentBaseline: currentSnapshot !== undefined,
    currentBaseline: currentSnapshot,
    refreshedBaseline: refreshedSnapshot,
    totalIncrease: refreshedSnapshot.total - (currentSnapshot?.total ?? 0),
    mappedIncrease: refreshedSnapshot.mappedCount - (currentSnapshot?.mappedCount ?? 0),
    retainedOnlyIncrease: refreshedSnapshot.retainedOnly - (currentSnapshot?.retainedOnly ?? 0),
    totalRatio: computeGrowthRatio(currentSnapshot?.total ?? 0, refreshedSnapshot.total),
    mappedRatio: computeGrowthRatio(currentSnapshot?.mappedCount ?? 0, refreshedSnapshot.mappedCount),
    addedCategories,
  };
}

export function detectRefreshScopeDrift(
  comparison: RefreshScopeComparison,
): RefreshScopeDriftResult {
  if (!comparison.hasCurrentBaseline || !comparison.currentBaseline) {
    return {
      detected: false,
      reasons: [],
      comparison,
    };
  }

  const reasons: string[] = [];

  if ((comparison.totalRatio ?? 0) > 2 && comparison.totalIncrease >= 50) {
    reasons.push(
      `total issues grew from ${comparison.currentBaseline.total} to ${comparison.refreshedBaseline.total}`,
    );
  }

  if ((comparison.mappedRatio ?? 0) > 2 && comparison.mappedIncrease >= 50) {
    reasons.push(
      `mapped/publishable issues grew from ${comparison.currentBaseline.mappedCount} to ${comparison.refreshedBaseline.mappedCount}`,
    );
  }

  if (
    comparison.retainedOnlyIncrease >= 50 &&
    comparison.refreshedBaseline.retainedOnly >= 50
  ) {
    reasons.push(
      `retained-only issues grew from ${comparison.currentBaseline.retainedOnly} to ${comparison.refreshedBaseline.retainedOnly}`,
    );
  }

  return {
    detected: comparison.addedCategories.length > 0 && reasons.length > 0,
    reasons,
    comparison,
  };
}

export function formatRefreshScopeDriftWarning(
  projectLabel: string,
  drift: RefreshScopeDriftResult,
): string {
  if (!drift.comparison.hasCurrentBaseline || !drift.comparison.currentBaseline) {
    return `Sphinx Doctor refresh for ${projectLabel} did not find an existing baseline to compare.`;
  }

  const triggerText = drift.reasons.join('; ');
  const addedCategoryText = drift.comparison.addedCategories.join(', ');

  return [
    `Sphinx Doctor refresh for ${projectLabel} found a much broader diagnostics universe and did not replace latest.json.`,
    `Current baseline: ${formatScopeSnapshot(drift.comparison.currentBaseline)}.`,
    `Refreshed run: ${formatScopeSnapshot(drift.comparison.refreshedBaseline)}.`,
    `Added categories: ${addedCategoryText}.`,
    `Trigger: ${triggerText}.`,
  ].join(' ');
}

export async function promoteDiagnosticsBaseline(
  refreshedDiagnosticsPath: string,
  latestOutputPath: string,
): Promise<void> {
  const normalizedRefreshedPath = path.resolve(refreshedDiagnosticsPath);
  const normalizedLatestPath = path.resolve(latestOutputPath);
  if (normalizedRefreshedPath === normalizedLatestPath) {
    return;
  }

  await fs.mkdir(path.dirname(normalizedLatestPath), { recursive: true });
  await fs.copyFile(normalizedRefreshedPath, normalizedLatestPath);
}

export async function evaluateRefreshBaselinePromotion(
  options: {
    currentBaselinePath: string;
    refreshedDiagnosticsPath: string;
    latestOutputPath: string;
  },
): Promise<RefreshBaselinePromotionResult> {
  const currentBaseline = await loadCurrentBaselineContract(options.currentBaselinePath);
  const refreshedBaseline = await loadDiagnosticsFromPath(options.refreshedDiagnosticsPath);
  const comparison = buildRefreshScopeComparison(currentBaseline, refreshedBaseline);
  const drift = detectRefreshScopeDrift(comparison);

  if (!drift.detected) {
    await promoteDiagnosticsBaseline(options.refreshedDiagnosticsPath, options.latestOutputPath);
  }

  return {
    currentBaseline,
    refreshedBaseline,
    comparison,
    drift,
    promoted: !drift.detected,
    activeDiagnosticsPath: drift.detected
      ? options.currentBaselinePath
      : options.latestOutputPath,
  };
}

export function getEnrichmentPermission(
  isWorkspaceTrusted: boolean | undefined,
  enrichmentEnabled: boolean,
): EnrichmentPermission {
  if (!enrichmentEnabled) {
    return {
      allowed: false,
      reason: 'Sphinx Doctor enrichment is disabled by settings. Enable sphinxDoctor.enrichment.enabled to run the Python enrichment CLI.',
    };
  }

  if (isWorkspaceTrusted !== true) {
    return {
      allowed: false,
      reason: 'Sphinx Doctor enrichment requires a trusted workspace because it runs a local Python process.',
    };
  }

  return { allowed: true };
}

export function buildEnrichmentRunPlan(
  options: BuildEnrichmentRunPlanOptions,
): EnrichmentRunPlan {
  const sourceWorkspaceFolder = findWorkspaceFolderByName(
    options.workspaceFolders,
    options.project.sourceWorkspaceFolder,
  );
  if (!sourceWorkspaceFolder) {
    throw new Error(
      `Source workspace folder "${options.project.sourceWorkspaceFolder}" could not be resolved for project ${options.project.id}.`,
    );
  }

  const inventoryWorkspaceFolder = findWorkspaceFolderByName(
    options.workspaceFolders,
    options.project.inventoryWorkspaceFolder,
  );
  if (!inventoryWorkspaceFolder) {
    throw new Error(
      `Inventory workspace folder "${options.project.inventoryWorkspaceFolder}" could not be resolved for project ${options.project.id}.`,
    );
  }

  const repoRoot = options.project.repoRoot ?? '.';
  const docsRoot = options.project.docsRoot ?? 'docs';
  const mirrorRoot = options.project.mirrorRoot ?? '.sphinx-diagnostics';
  const sourceRoot = path.resolve(sourceWorkspaceFolder.fsPath, repoRoot);
  const inventoryRoot = inventoryWorkspaceFolder.fsPath;
  const mirrorRootPath = path.resolve(sourceRoot, mirrorRoot);
  const runId = buildRunId(options.now ?? new Date());
  const runDirectoryPath = path.join(mirrorRootPath, 'runs', runId);
  const archiveOutputPath = path.join(runDirectoryPath, 'enriched.json');
  const latestOutputPath = path.join(mirrorRootPath, 'latest.json');

  return {
    command: options.pythonInterpreter,
    args: [
      '-m',
      'sphinx_doctor.cli',
      'enrich',
      '--raw-issues',
      options.rawIssuesPath,
      '--source-root',
      sourceRoot,
      '--inventory-root',
      inventoryRoot,
      '--project-id',
      options.project.id,
      '--source-workspace-folder',
      options.project.sourceWorkspaceFolder,
      '--inventory-workspace-folder',
      options.project.inventoryWorkspaceFolder,
      '--repo-root',
      repoRoot,
      '--docs-root',
      docsRoot,
      '--mirror-root',
      mirrorRoot,
      '--out',
      archiveOutputPath,
      '--run-id',
      runId,
    ],
    cwd: options.extensionRoot,
    rawIssuesPath: options.rawIssuesPath,
    sourceRoot,
    inventoryRoot,
    repoRoot,
    docsRoot,
    mirrorRoot,
    mirrorRootPath,
    runId,
    runDirectoryPath,
    archiveOutputPath,
    latestOutputPath,
  };
}

function executeProcess(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
      });
    });
  });
}

export async function runEnrichmentPlan(
  plan: EnrichmentRunPlan,
  options: RunEnrichmentPlanOptions = {},
): Promise<EnrichmentRunResult> {
  await fs.mkdir(plan.runDirectoryPath, { recursive: true });
  await fs.mkdir(path.dirname(plan.latestOutputPath), { recursive: true });

  const execution = await executeProcess(plan.command, plan.args, plan.cwd);
  if (execution.exitCode !== 0) {
    const detail = execution.stderr.trim() || execution.stdout.trim() || 'Unknown enrichment failure.';
    throw new Error(`Enrichment exited with code ${execution.exitCode}: ${detail}`);
  }

  if (options.promoteLatest !== false) {
    await fs.copyFile(plan.archiveOutputPath, plan.latestOutputPath);
  }

  return {
    plan,
    exitCode: execution.exitCode,
    stdout: execution.stdout,
    stderr: execution.stderr,
  };
}