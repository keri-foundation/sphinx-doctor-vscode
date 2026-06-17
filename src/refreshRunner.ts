import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import {
  ConfiguredProject,
  DiagnosticsContract,
  InventoryCandidate,
  ProjectRefreshConfig,
  WorkspaceFolderInfo,
} from './types';
import { findWorkspaceFolderByName } from './workspace/inventoryCandidates';

export interface RefreshPermission {
  allowed: boolean;
  reason?: string;
}

export interface RefreshRunPlan {
  command: string;
  args: string[];
  cwd: string;
  cwdWorkspaceFolder: string;
  sourceRoot: string;
  inventoryRoot: string;
  repoRoot: string;
  mirrorRoot: string;
  mirrorRootPath: string;
  expectedOutputGlobs: string[];
  startedAtMs: number;
}

export interface RefreshRunResult {
  plan: RefreshRunPlan;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface BuildRefreshRunPlanOptions {
  project: ConfiguredProject;
  refresh: ProjectRefreshConfig;
  workspaceFolders: WorkspaceFolderInfo[];
  refreshCategory?: string;
  now?: Date;
}

export interface ProjectRefreshResolution {
  config?: ProjectRefreshConfig;
  source?: 'configured' | 'inferred';
  reason?: string;
}

export interface InferProjectRefreshOptions {
  project: ConfiguredProject;
  workspaceFolders: WorkspaceFolderInfo[];
  pathExists?: (filePath: string) => Promise<boolean>;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function hasRefreshCategoryArg(args: readonly string[]): boolean {
  return args.includes('--category');
}

export function inferRefreshScopeFromContract(
  contract: DiagnosticsContract | undefined,
): string | undefined {
  if (!contract || contract.issues.length === 0) {
    return undefined;
  }

  const categories = Array.from(
    new Set(
      contract.issues
        .map((issue) => issue.category.trim())
        .filter((category) => category.length > 0),
    ),
  ).sort();

  return categories.length === 1 ? categories[0] : undefined;
}

export function buildRefreshCategoryArgs(category: string | undefined): string[] {
  return category ? ['--category', category] : [];
}

export function applyRefreshScopeToConfig(
  refresh: ProjectRefreshConfig,
  category: string | undefined,
): ProjectRefreshConfig {
  if (!category || hasRefreshCategoryArg(refresh.args)) {
    return {
      ...refresh,
      args: [...refresh.args],
      expectedOutputGlobs: [...refresh.expectedOutputGlobs],
    };
  }

  return {
    ...refresh,
    args: [...refresh.args, ...buildRefreshCategoryArgs(category)],
    expectedOutputGlobs: [...refresh.expectedOutputGlobs],
  };
}

async function defaultPathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export function getRefreshPermission(
  isWorkspaceTrusted: boolean | undefined,
  refresh: ProjectRefreshConfig | undefined,
): RefreshPermission {
  if (!refresh) {
    return {
      allowed: false,
      reason: 'No refresh configuration is available for this project.',
    };
  }

  if (!refresh.enabled) {
    return {
      allowed: false,
      reason: 'Project refresh is disabled by configuration.',
    };
  }

  if (isWorkspaceTrusted !== true) {
    return {
      allowed: false,
      reason: 'Sphinx Doctor refresh requires a trusted workspace because it runs a local external command.',
    };
  }

  return { allowed: true };
}

export function buildRefreshRunPlan(options: BuildRefreshRunPlanOptions): RefreshRunPlan {
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

  const cwdWorkspaceFolder = findWorkspaceFolderByName(
    options.workspaceFolders,
    options.refresh.cwdWorkspaceFolder,
  );
  if (!cwdWorkspaceFolder) {
    throw new Error(
      `Refresh cwd workspace folder "${options.refresh.cwdWorkspaceFolder}" could not be resolved for project ${options.project.id}.`,
    );
  }

  const repoRoot = options.project.repoRoot ?? '.';
  const mirrorRoot = options.project.mirrorRoot ?? '.sphinx-diagnostics';
  const sourceRoot = path.resolve(sourceWorkspaceFolder.fsPath, repoRoot);
  const inventoryRoot = inventoryWorkspaceFolder.fsPath;
  const mirrorRootPath = path.resolve(sourceRoot, mirrorRoot);

  const refreshConfig = applyRefreshScopeToConfig(options.refresh, options.refreshCategory);

  return {
    command: refreshConfig.command,
    args: [...refreshConfig.args],
    cwd: cwdWorkspaceFolder.fsPath,
    cwdWorkspaceFolder: refreshConfig.cwdWorkspaceFolder,
    sourceRoot,
    inventoryRoot,
    repoRoot,
    mirrorRoot,
    mirrorRootPath,
    expectedOutputGlobs: [...refreshConfig.expectedOutputGlobs],
    startedAtMs: (options.now ?? new Date()).getTime(),
  };
}

export async function inferProjectRefreshConfig(
  options: InferProjectRefreshOptions,
): Promise<ProjectRefreshResolution> {
  if (options.project.refresh) {
    return {
      config: options.project.refresh,
      source: 'configured',
    };
  }

  const pathExists = options.pathExists ?? defaultPathExists;
  const inventoryWorkspaceFolder = findWorkspaceFolderByName(
    options.workspaceFolders,
    options.project.inventoryWorkspaceFolder,
  );
  if (!inventoryWorkspaceFolder) {
    return {
      reason: `Inventory workspace folder ${options.project.inventoryWorkspaceFolder} is not open, so no default refresh command can be inferred.`,
    };
  }

  const sourceWorkspaceFolder = findWorkspaceFolderByName(
    options.workspaceFolders,
    options.project.sourceWorkspaceFolder,
  );
  if (!sourceWorkspaceFolder) {
    return {
      reason: `Source workspace folder ${options.project.sourceWorkspaceFolder} is not open.`,
    };
  }

  const repoRoot = path.resolve(sourceWorkspaceFolder.fsPath, options.project.repoRoot ?? '.');
  const relativeRepoRoot = path.relative(inventoryWorkspaceFolder.fsPath, repoRoot);
  if (relativeRepoRoot.startsWith('..') || path.isAbsolute(relativeRepoRoot)) {
    return {
      reason: `Source root ${repoRoot} is not inside inventory workspace folder ${options.project.inventoryWorkspaceFolder}, so no default refresh command can be inferred.`,
    };
  }

  const runnerPath = path.resolve(
    inventoryWorkspaceFolder.fsPath,
    'Devtools',
    'sphinx',
    'run_sphinx_inventory.sh',
  );
  if (!(await pathExists(runnerPath))) {
    return {
      reason: `Sphinx inventory runner is missing: ${runnerPath}.`,
    };
  }

  const pythonPath = path.resolve(repoRoot, '.venv-docs', 'bin', 'python');
  if (!(await pathExists(pythonPath))) {
    return {
      reason: `Docs Python is missing for ${options.project.id}: ${pythonPath}.`,
    };
  }

  const docsRoot = options.project.docsRoot ?? 'docs';
  const docsConfPath = path.resolve(repoRoot, docsRoot, 'conf.py');
  const docsMakefilePath = path.resolve(repoRoot, docsRoot, 'Makefile');
  if (!(await pathExists(docsConfPath)) && !(await pathExists(docsMakefilePath))) {
    return {
      reason: `No Sphinx marker was found under ${path.resolve(repoRoot, docsRoot)}.`,
    };
  }

  const repoName = path.basename(repoRoot);
  const normalizedRelativeRepoRoot = relativeRepoRoot.length === 0 ? '.' : toPosixPath(relativeRepoRoot);
  const relativePythonPath = toPosixPath(path.relative(inventoryWorkspaceFolder.fsPath, pythonPath));

  return {
    source: 'inferred',
    config: {
      enabled: true,
      cwdWorkspaceFolder: options.project.inventoryWorkspaceFolder,
      command: 'bash',
      args: [
        'Devtools/sphinx/run_sphinx_inventory.sh',
        '--repo-root',
        normalizedRelativeRepoRoot,
        '--python',
        relativePythonPath,
        '--context-lines',
        '16',
      ],
      expectedOutputGlobs: [
        `tmp/sphinx-inventory-${repoName}-*/report/issues.vscode.json`,
        `tmp/sphinx-inventory-${repoName}-*/report/issues.json`,
      ],
    },
  };
}

export function filterRecentInventoryCandidates<T extends InventoryCandidate>(
  candidates: T[],
  startedAtMs: number,
): T[] {
  return candidates.filter((candidate) => candidate.modifiedTime >= startedAtMs);
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

export async function runRefreshPlan(plan: RefreshRunPlan): Promise<RefreshRunResult> {
  const execution = await executeProcess(plan.command, plan.args, plan.cwd);
  return {
    plan,
    exitCode: execution.exitCode,
    stdout: execution.stdout,
    stderr: execution.stderr,
  };
}