import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { WorkspaceFolderInfo } from '../types';
import { findWorkspaceFolderByName } from '../workspace';

export interface SphinxRunPermission {
  allowed: boolean;
  reason?: string;
}

export interface SphinxRunPlan {
  command: string;
  args: string[];
  cwd: string;
  cwdWorkspaceFolder: string;
  sourceDir: string;
  outputDir: string;
  warningFile: string;
  builder: string;
  startedAtMs: number;
}

export interface SphinxRunResult {
  plan: SphinxRunPlan;
  status: 'success' | 'failed' | 'canceled';
  exitCode: number;
  stdout: string;
  stderr: string;
  warningFileExists: boolean;
  signal?: string;
}

export interface SphinxRunConfig {
  enabled: boolean;
  command: string;
  builder: string;
  sourceDir: string;
  outputDir: string;
  warningFile: string;
  extraArgs: string[];
}

export interface BuildSphinxRunPlanOptions {
  config: SphinxRunConfig;
  workspaceFolders: WorkspaceFolderInfo[];
  cwdWorkspaceFolder: string;
  now?: Date;
}

export function getSphinxRunPermission(
  isWorkspaceTrusted: boolean | undefined,
  config: SphinxRunConfig | undefined,
): SphinxRunPermission {
  if (!config) {
    return {
      allowed: false,
      reason: 'No Sphinx run configuration is available.',
    };
  }

  if (!config.enabled) {
    return {
      allowed: false,
      reason: 'Direct Sphinx runs are disabled by configuration.',
    };
  }

  if (isWorkspaceTrusted !== true) {
    return {
      allowed: false,
      reason: 'Sphinx Doctor direct runs require a trusted workspace because they execute local commands.',
    };
  }

  return { allowed: true };
}

export function buildSphinxRunPlan(options: BuildSphinxRunPlanOptions): SphinxRunPlan {
  const workspaceFolder = findWorkspaceFolderByName(
    options.workspaceFolders,
    options.cwdWorkspaceFolder,
  );

  if (!workspaceFolder) {
    throw new Error(
      `Workspace folder "${options.cwdWorkspaceFolder}" not found. Available: ${options.workspaceFolders
        .map((f) => f.name)
        .join(', ')}`,
    );
  }

  const cwd = workspaceFolder.fsPath;
  const sourceDir = path.resolve(cwd, options.config.sourceDir);
  const outputDir = path.resolve(cwd, options.config.outputDir);
  const warningFile = path.resolve(cwd, options.config.warningFile);

  const args = [
    '-b',
    options.config.builder,
    '-E',
    sourceDir,
    outputDir,
    '-w',
    warningFile,
    ...options.config.extraArgs,
  ];

  return {
    command: options.config.command,
    args,
    cwd,
    cwdWorkspaceFolder: options.cwdWorkspaceFolder,
    sourceDir,
    outputDir,
    warningFile,
    builder: options.config.builder,
    startedAtMs: options.now?.getTime() ?? Date.now(),
  };
}

export interface RunSphinxPlanOptions {
  cancellationToken?: {
    isCancellationRequested: boolean;
    onCancellationRequested: (listener: () => void) => { dispose: () => void };
  };
}

export async function runSphinxPlan(
  plan: SphinxRunPlan,
  options?: RunSphinxPlanOptions,
): Promise<SphinxRunResult> {
  // Ensure output directory exists
  await fs.mkdir(plan.outputDir, { recursive: true });

  // Ensure warning file directory exists
  const warningFileDir = path.dirname(plan.warningFile);
  await fs.mkdir(warningFileDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let canceled = false;

    // Handle cancellation
    let cancellationDisposable: { dispose: () => void } | undefined;
    if (options?.cancellationToken) {
      if (options.cancellationToken.isCancellationRequested) {
        child.kill('SIGTERM');
        canceled = true;
      } else {
        cancellationDisposable = options.cancellationToken.onCancellationRequested(() => {
          canceled = true;
          child.kill('SIGTERM');
        });
      }
    }

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('error', (error) => {
      cancellationDisposable?.dispose();
      reject(new Error(`Failed to start Sphinx process: ${error.message}`));
    });

    child.on('close', async (code, signal) => {
      cancellationDisposable?.dispose();

      const exitCode = code ?? 1;

      // Check if warning file was created
      let warningFileExists = false;
      try {
        await fs.access(plan.warningFile);
        warningFileExists = true;
      } catch {
        warningFileExists = false;
      }

      // Determine status based on cancellation, exit code, and signal
      let status: 'success' | 'failed' | 'canceled';
      if (canceled || signal === 'SIGTERM') {
        status = 'canceled';
      } else if (exitCode === 0) {
        status = 'success';
      } else {
        status = 'failed';
      }

      resolve({
        plan,
        status,
        exitCode,
        stdout,
        stderr,
        warningFileExists,
        signal: signal ?? undefined,
      });
    });
  });
}
