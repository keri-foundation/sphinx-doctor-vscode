import * as fs from 'node:fs/promises';
import path from 'node:path';

import { DiagnosticsContract } from './types';

export type DiagnosticsFileKind = 'enriched' | 'raw' | 'unknown';

export interface DiagnosticsBindingInfo {
  kind: DiagnosticsFileKind;
  repoRoot?: string;
  sourceWorkspaceFolder?: string;
}

export interface DiagnosticsBindingCompatibility {
  compatible: boolean;
  reason?: string;
}

function isLikelyRawInventoryIssue(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) {
    return false;
  }

  const hasPath = typeof record.path === 'string' && record.path.length > 0;
  const hasCategory = typeof record.category === 'string' && record.category.length > 0;
  const hasMessage = typeof record.message === 'string' && record.message.length > 0;
  const hasRaw = typeof record.raw === 'string' && record.raw.length > 0;
  const hasLine = typeof record.line === 'number';
  const hasObjectName = typeof record.object_name === 'string' && record.object_name.length > 0;

  return hasPath && hasCategory && (hasMessage || hasRaw || hasLine || hasObjectName);
}

function isLikelyRawInventoryPayload(record: Record<string, unknown>): boolean {
  if (typeof record.repo_root !== 'string' || !Array.isArray(record.issues)) {
    return false;
  }

  const hasReportMetadata =
    typeof record.log_path === 'string' ||
    typeof record.generated_at === 'string' ||
    asRecord(record.summary) !== undefined ||
    asRecord(record.filters) !== undefined;
  if (!hasReportMetadata) {
    return false;
  }

  if (record.issues.length === 0) {
    return true;
  }

  return record.issues.some((issue) => isLikelyRawInventoryIssue(issue));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

export function inspectDiagnosticsPayload(payload: unknown): DiagnosticsFileKind {
  const record = asRecord(payload);
  if (!record) {
    return 'unknown';
  }

  if (
    record.schema === 'sphinx-diagnostics-v1' &&
    record.schemaVersion === 1 &&
    Array.isArray(record.issues)
  ) {
    return 'enriched';
  }

  if (typeof record.schema === 'string' && record.schema.startsWith('sphinx-inventory') && Array.isArray(record.issues)) {
    return 'raw';
  }

  if (isLikelyRawInventoryPayload(record)) {
    return 'raw';
  }

  return 'unknown';
}

export function inspectDiagnosticsBindingPayload(payload: unknown): DiagnosticsBindingInfo {
  const record = asRecord(payload);
  if (!record) {
    return { kind: 'unknown' };
  }

  const kind = inspectDiagnosticsPayload(payload);
  if (kind === 'raw') {
    return {
      kind,
      repoRoot: typeof record.repo_root === 'string' ? record.repo_root : undefined,
    };
  }

  if (kind === 'enriched') {
    const workspace = asRecord(record.workspace);
    return {
      kind,
      sourceWorkspaceFolder:
        typeof workspace?.sourceWorkspaceFolder === 'string'
          ? workspace.sourceWorkspaceFolder
          : undefined,
    };
  }

  return { kind };
}

export function inspectDiagnosticsText(text: string): DiagnosticsFileKind {
  try {
    return inspectDiagnosticsPayload(JSON.parse(text) as unknown);
  } catch {
    return 'unknown';
  }
}

export async function inspectDiagnosticsFile(filePath: string): Promise<DiagnosticsFileKind> {
  const text = await fs.readFile(filePath, 'utf8');
  return inspectDiagnosticsText(text);
}

export async function inspectDiagnosticsFileBinding(filePath: string): Promise<DiagnosticsBindingInfo> {
  const text = await fs.readFile(filePath, 'utf8');
  try {
    return inspectDiagnosticsBindingPayload(JSON.parse(text) as unknown);
  } catch {
    return { kind: 'unknown' };
  }
}

export function isDiagnosticsBindingCompatible(
  binding: DiagnosticsBindingInfo,
  expected: { sourceWorkspaceFolder: string; sourceRoot: string },
): DiagnosticsBindingCompatibility {
  if (binding.kind === 'unknown') {
    return {
      compatible: false,
      reason: 'Diagnostics payload is not recognized as enriched diagnostics or raw inventory.',
    };
  }

  if (
    binding.kind === 'enriched' &&
    binding.sourceWorkspaceFolder &&
    binding.sourceWorkspaceFolder !== expected.sourceWorkspaceFolder
  ) {
    return {
      compatible: false,
      reason:
        `Diagnostics contract targets workspace folder ${binding.sourceWorkspaceFolder}, ` +
        `not ${expected.sourceWorkspaceFolder}.`,
    };
  }

  if (binding.kind === 'raw' && !binding.repoRoot) {
    return {
      compatible: false,
      reason: 'Raw inventory is missing repo_root, so it cannot be bound safely to an open source workspace folder.',
    };
  }

  if (binding.kind === 'raw' && binding.repoRoot) {
    const normalizedActual = path.resolve(binding.repoRoot);
    const normalizedExpected = path.resolve(expected.sourceRoot);
    if (normalizedActual !== normalizedExpected) {
      return {
        compatible: false,
        reason:
          `Raw inventory repo_root ${normalizedActual} does not match expected source root ${normalizedExpected}.`,
      };
    }
  }

  return { compatible: true };
}

export function parseDiagnosticsText(text: string): DiagnosticsContract {
  const payload = JSON.parse(text) as Partial<DiagnosticsContract>;

  if (inspectDiagnosticsPayload(payload) !== 'enriched') {
    throw new Error('Diagnostics payload is not an enriched sphinx-diagnostics-v1 contract.');
  }

  if (payload.schema !== 'sphinx-diagnostics-v1') {
    throw new Error(`Unsupported diagnostics schema: ${String(payload.schema)}`);
  }

  if (payload.schemaVersion !== 1) {
    throw new Error(`Unsupported diagnostics schema version: ${String(payload.schemaVersion)}`);
  }

  if (!Array.isArray(payload.issues)) {
    throw new Error('Diagnostics payload is missing an issues array.');
  }

  return payload as DiagnosticsContract;
}

export async function loadDiagnosticsFromPath(filePath: string): Promise<DiagnosticsContract> {
  const text = await fs.readFile(filePath, 'utf8');
  return parseDiagnosticsText(text);
}