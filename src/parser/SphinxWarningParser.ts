import * as fs from 'node:fs/promises';
import path from 'node:path';

import {
  DiagnosticsIssue,
  DiagnosticsMapping,
  DiagnosticsSourceRange,
} from '../types';

/**
 * Discriminated union representing parsed Sphinx warning variants.
 * Each variant has explicit fields for type-safe handling.
 */
export type ParsedSphinxWarning =
  | {
      kind: 'located';
      filePath: string;
      line: number;
      severity: 'WARNING' | 'ERROR' | 'INFO';
      message: string;
      category?: string;
      raw: string;
    }
  | {
      kind: 'fileOnly';
      filePath: string;
      severity: 'WARNING' | 'ERROR' | 'INFO';
      message: string;
      category?: string;
      raw: string;
    }
  | {
      kind: 'global';
      severity: 'WARNING' | 'ERROR' | 'INFO';
      message: string;
      category?: string;
      raw: string;
    }
  | {
      kind: 'unparsed';
      raw: string;
    };

export interface ParseSphinxWarningsOptions {
  warningFileContent: string;
  repoRoot: string;
  sourceWorkspaceFolder?: string;
}

export interface ParseSphinxWarningsResult {
  issues: DiagnosticsIssue[];
  unmappedCount: number;
  unparsedCount: number;
  totalLines: number;
}

/**
 * Parse Sphinx warning format: <path>:<line>: WARNING: <message> [<category>]
 * or: <path>:<line>: <severity>: <message> [<category>]
 * or: WARNING: <message> [<category>] (no location)
 */
const WARNING_PATTERN = /^(.+?):(\d+):\s*(WARNING|ERROR|INFO):\s*(.+?)(?:\s*\[([^\]]+)\])?$/;
const WARNING_NO_LINE_PATTERN = /^(.+?):\s*(WARNING|ERROR|INFO):\s*(.+?)(?:\s*\[([^\]]+)\])?$/;
const WARNING_NO_LOCATION_PATTERN = /^(WARNING|ERROR|INFO):\s*(.+?)(?:\s*\[([^\]]+)\])?$/;

/**
 * Helper function for exhaustiveness checking in switch statements.
 * TypeScript will error if not all variants are handled.
 */
function assertNever(value: never): never {
  throw new Error(`Unhandled parsed warning variant: ${JSON.stringify(value)}`);
}

function parseWarningLine(line: string): ParsedSphinxWarning {
  const trimmed = line.trim();
  if (!trimmed) {
    return { kind: 'unparsed', raw: line };
  }

  // Try pattern with line number
  let match = WARNING_PATTERN.exec(trimmed);
  if (match) {
    return {
      kind: 'located',
      filePath: match[1],
      line: parseInt(match[2], 10),
      severity: match[3].toUpperCase() as 'WARNING' | 'ERROR' | 'INFO',
      message: match[4],
      category: match[5],
      raw: trimmed,
    };
  }

  // Try pattern without line number
  match = WARNING_NO_LINE_PATTERN.exec(trimmed);
  if (match) {
    return {
      kind: 'fileOnly',
      filePath: match[1],
      severity: match[2].toUpperCase() as 'WARNING' | 'ERROR' | 'INFO',
      message: match[3],
      category: match[4],
      raw: trimmed,
    };
  }

  // Try pattern without location
  match = WARNING_NO_LOCATION_PATTERN.exec(trimmed);
  if (match) {
    return {
      kind: 'global',
      severity: match[1].toUpperCase() as 'WARNING' | 'ERROR' | 'INFO',
      message: match[2],
      category: match[3],
      raw: trimmed,
    };
  }

  return { kind: 'unparsed', raw: trimmed };
}

function toRepoRelativePath(absolutePath: string, repoRoot: string): string | null {
  if (!absolutePath) {
    return null;
  }

  const normalizedAbsolute = path.resolve(absolutePath);
  const normalizedRepoRoot = path.resolve(repoRoot);

  if (!normalizedAbsolute.startsWith(normalizedRepoRoot)) {
    return null;
  }

  const relative = path.relative(normalizedRepoRoot, normalizedAbsolute);
  return relative.split(path.sep).join('/');
}

/**
 * Convert a parsed warning variant to a DiagnosticsIssue using exhaustive switch.
 * Returns null for warnings that cannot be mapped to a file location.
 */
function createDiagnosticsIssue(
  warning: ParsedSphinxWarning,
  repoRoot: string,
  sourceWorkspaceFolder?: string,
  index?: number,
): DiagnosticsIssue | null {
  switch (warning.kind) {
    case 'located': {
      const repoRelativePath = toRepoRelativePath(warning.filePath, repoRoot);
      if (!repoRelativePath) {
        return null;
      }

      const sourceRange: DiagnosticsSourceRange = {
        startLine: warning.line,
        startColumn: 0,
        endLine: warning.line,
        endColumn: 0,
        anchorKind: 'line',
      };

      const mapping: DiagnosticsMapping = {
        confidence: 'high',
        strategy: 'sphinx-warning-file',
        reason: 'Parsed from sphinx-build -w output',
        objectResolved: false,
        lineResolved: true,
      };

      const id = `sphinx-${index ?? Date.now()}-${repoRelativePath}-${warning.line}`;

      return {
        id,
        severity: warning.severity.toLowerCase(),
        category: warning.category ?? 'sphinx-warning',
        code: warning.category ?? 'sphinx-warning',
        message: warning.message,
        raw: warning.raw,
        repoRelativePath,
        inventoryRelativePath: repoRelativePath,
        rawLocation: warning.filePath,
        sourceRange,
        mapping,
        publishDiagnostic: true,
        related: [],
        sourceWorkspaceFolder,
      };
    }

    case 'fileOnly': {
      const repoRelativePath = toRepoRelativePath(warning.filePath, repoRoot);
      if (!repoRelativePath) {
        return null;
      }

      const mapping: DiagnosticsMapping = {
        confidence: 'medium',
        strategy: 'sphinx-warning-file',
        reason: 'Parsed from sphinx-build -w output (no line number)',
        objectResolved: false,
        lineResolved: false,
      };

      const id = `sphinx-${index ?? Date.now()}-${repoRelativePath}-noline`;

      return {
        id,
        severity: warning.severity.toLowerCase(),
        category: warning.category ?? 'sphinx-warning',
        code: warning.category ?? 'sphinx-warning',
        message: warning.message,
        raw: warning.raw,
        repoRelativePath,
        inventoryRelativePath: repoRelativePath,
        rawLocation: warning.filePath,
        sourceRange: null,
        mapping,
        publishDiagnostic: true,
        related: [],
        sourceWorkspaceFolder,
      };
    }

    case 'global':
      // Global warnings without file location cannot be mapped to diagnostics
      return null;

    case 'unparsed':
      // Unparsed lines are tracked but not converted to diagnostics
      return null;

    default:
      return assertNever(warning);
  }
}

export function parseSphinxWarnings(options: ParseSphinxWarningsOptions): ParseSphinxWarningsResult {
  const lines = options.warningFileContent.split('\n');
  const issues: DiagnosticsIssue[] = [];
  let unmappedCount = 0;
  let unparsedCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parsed = parseWarningLine(line);

    // Track unparsed lines explicitly
    if (parsed.kind === 'unparsed') {
      unparsedCount++;
      continue;
    }

    // Track global warnings as unmapped (no file location)
    if (parsed.kind === 'global') {
      unmappedCount++;
      continue;
    }

    const issue = createDiagnosticsIssue(
      parsed,
      options.repoRoot,
      options.sourceWorkspaceFolder,
      i,
    );

    if (issue) {
      issues.push(issue);
    } else {
      // Warning was parsed but could not be mapped to repo
      unmappedCount++;
    }
  }

  return {
    issues,
    unmappedCount,
    unparsedCount,
    totalLines: lines.length,
  };
}

export async function parseSphinxWarningsFromFile(
  warningFilePath: string,
  repoRoot: string,
  sourceWorkspaceFolder?: string,
): Promise<ParseSphinxWarningsResult> {
  const content = await fs.readFile(warningFilePath, 'utf8');
  return parseSphinxWarnings({
    warningFileContent: content,
    repoRoot,
    sourceWorkspaceFolder,
  });
}
