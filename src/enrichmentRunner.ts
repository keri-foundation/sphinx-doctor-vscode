import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { ConfiguredProject, WorkspaceFolderInfo } from './types';
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

function pad(value: number): string {
  return String(value).padStart(2, '0');
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

export async function runEnrichmentPlan(plan: EnrichmentRunPlan): Promise<EnrichmentRunResult> {
  await fs.mkdir(plan.runDirectoryPath, { recursive: true });
  await fs.mkdir(path.dirname(plan.latestOutputPath), { recursive: true });

  const execution = await executeProcess(plan.command, plan.args, plan.cwd);
  if (execution.exitCode !== 0) {
    const detail = execution.stderr.trim() || execution.stdout.trim() || 'Unknown enrichment failure.';
    throw new Error(`Enrichment exited with code ${execution.exitCode}: ${detail}`);
  }

  await fs.copyFile(plan.archiveOutputPath, plan.latestOutputPath);

  return {
    plan,
    exitCode: execution.exitCode,
    stdout: execution.stdout,
    stderr: execution.stderr,
  };
}