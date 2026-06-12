export type SphinxDoctorLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type DiscoveryConfidence = 'high' | 'medium' | 'low';
export type DiagnosticMode = 'layout' | 'reference' | 'full';

const LAYOUT_CATEGORIES = new Set([
  'unexpected-indentation',
  'block-quote-unindent',
  'definition-list-unindent',
  'literal-block',
]);

const REFERENCE_CATEGORIES = new Set([
  'missing-reference',
  'ambiguous-reference',
]);

const LITERAL_BLOCK_MESSAGE_RE = /literal block expected; none found/i;

export interface DiagnosticsTool {
  name: string;
  version: string;
}

export interface DiagnosticsWorkspace {
  sourceWorkspaceFolder?: string;
  inventoryWorkspaceFolder?: string;
  repoRoot?: string;
  docsRoot?: string;
  mirrorRoot?: string;
}

export interface DiagnosticsRun {
  id: string;
  source: string;
  inventoryFile: string;
  inventoryDir: string;
}

export interface DiagnosticsSummary {
  total: number;
  bySeverity: Record<string, number>;
  byCategory: Record<string, number>;
  mappedCount: number;
  unmappedCount: number;
  publishedDiagnostics: number;
  retainedOnly: number;
}

export interface DiagnosticsSourceRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  anchorKind: string;
}

export interface DiagnosticsMapping {
  confidence: string;
  strategy: string;
  reason: string;
  objectResolved: boolean;
  lineResolved: boolean;
}

export interface DiagnosticsRelated {
  label: string;
  path: string;
}

export interface DiagnosticsIssue {
  id: string;
  severity: string;
  category: string;
  code: string;
  target?: string | null;
  refDomain?: string | null;
  refType?: string | null;
  candidates?: string[] | null;
  message: string;
  raw: unknown;
  objectName?: string | null;
  objectKind?: string | null;
  docstringLine?: number | null;
  sourceWorkspaceFolder?: string;
  inventoryWorkspaceFolder?: string;
  repoRelativePath?: string | null;
  inventoryRelativePath: string;
  rawLocation: string;
  sourceRange?: DiagnosticsSourceRange | null;
  mapping: DiagnosticsMapping;
  publishDiagnostic: boolean;
  related: DiagnosticsRelated[];
  uri?: string;
  fileUri?: string;
  absolutePath?: string;
}

export interface DiagnosticsContract {
  schema: string;
  schemaVersion: number;
  generatedAt: string;
  tool: DiagnosticsTool;
  workspace: DiagnosticsWorkspace;
  run: DiagnosticsRun;
  summary: DiagnosticsSummary;
  issues: DiagnosticsIssue[];
}

export interface ConfiguredProject {
  id: string;
  baseProjectId?: string;
  label?: string;
  sourceWorkspaceFolder: string;
  sourceRootPath?: string;
  inventoryWorkspaceFolder: string;
  repoRoot?: string;
  docsRoot?: string;
  inventorySearchGlobs: string[];
  preferredInventoryFiles: string[];
  mirrorRoot?: string;
  refresh?: ProjectRefreshConfig;
  inventorySearchTargets?: InventorySearchTarget[];
  discoveryConfidence?: DiscoveryConfidence;
  discoveryReasons?: string[];
  origin?: 'configured' | 'discovered';
}

export interface ProjectRefreshConfig {
  enabled: boolean;
  cwdWorkspaceFolder: string;
  command: string;
  args: string[];
  expectedOutputGlobs: string[];
}

export interface ExtensionConfig {
  projects: ConfiguredProject[];
  defaultSourceWorkspaceFolder: string;
  diagnosticsMode: DiagnosticMode;
  pythonInterpreter: string;
  enrichmentEnabled: boolean;
  enrichmentAutoRun: boolean;
  discoveryEnabled: boolean;
  discoveryIncludeLowConfidence: boolean;
  discoveryInventoryWorkspaceFolderNames: string[];
  discoveryExcludeWorkspaceFolders: string[];
  watchEnabled: boolean;
  watchAutoLoadOnStartup: boolean;
  watchDebounceMs: number;
  refreshAutoRunOnStartup: boolean;
  refreshAutoRunOnSave: boolean;
  refreshDebounceMs: number;
  logLevel: SphinxDoctorLogLevel;
  directRunEnabled: boolean;
  sphinxCommand: string;
  sphinxBuilder: string;
  sphinxSourceDir: string;
  sphinxOutputDir: string;
  sphinxWarningFile: string;
  sphinxExtraArgs: string[];
}

export interface WatchModeSummary {
  state: 'idle' | 'watching' | 'no-diagnostics' | 'error';
  projectCount: number;
  issueCount: number;
  publishableBeforeFilter: number;
  publishedDiagnostics: number;
  watcherCount: number;
  diagnosticMode: DiagnosticMode;
  message: string;
}

export interface DiagnosticModeSummary {
  totalIssues: number;
  publishableBeforeFilter: number;
  publishedInMode: number;
  retainedOnly: number;
}

export interface WorkspaceFolderInfo {
  name: string;
  fsPath: string;
}

export interface ResolutionResult {
  filePath?: string;
  strategy: string;
  reason?: string;
}

export interface InventoryCandidate {
  filePath: string;
  fileName: string;
  directoryPath: string;
  modifiedTime: number;
}

export interface InventorySearchTarget {
  workspaceFolderName: string;
  globs: string[];
  reason?: string;
}

export interface InventorySelectionResult<T extends InventoryCandidate> {
  selected?: T;
  ambiguous?: T[];
}

export interface LastLoadedDiagnosticsState {
  fileUri: string;
  defaultSourceWorkspaceFolder?: string;
  defaultRepoRoot?: string;
}

export function normalizeSeverityName(severity: string): 'error' | 'warning' | 'info' {
  const lowered = severity.toLowerCase();
  if (lowered === 'error') {
    return 'error';
  }
  if (lowered === 'warning') {
    return 'warning';
  }
  return 'info';
}

export function toZeroBasedPosition(value: number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return value <= 1 ? 0 : value - 1;
}

export function normalizeDiagnosticMode(value: unknown): DiagnosticMode {
  if (value === 'layout' || value === 'reference' || value === 'full') {
    return value;
  }

  return 'layout';
}

export function shouldPublishIssue(issue: DiagnosticsIssue): boolean {
  return issue.publishDiagnostic === true && Boolean(issue.sourceRange) && Boolean(issue.repoRelativePath);
}

export function issueMatchesDiagnosticMode(
  issue: Pick<DiagnosticsIssue, 'category' | 'code' | 'message'>,
  mode: DiagnosticMode,
): boolean {
  if (mode === 'full') {
    return true;
  }

  if (mode === 'reference') {
    return REFERENCE_CATEGORIES.has(issue.category) || issue.code.startsWith('ref.');
  }

  return (
    LAYOUT_CATEGORIES.has(issue.category) ||
    LAYOUT_CATEGORIES.has(issue.code) ||
    issue.code.endsWith('unexpected-indentation') ||
    LITERAL_BLOCK_MESSAGE_RE.test(issue.message)
  );
}

export function summarizeDiagnosticMode(
  issues: readonly DiagnosticsIssue[],
  mode: DiagnosticMode,
): DiagnosticModeSummary {
  let publishableBeforeFilter = 0;
  let publishedInMode = 0;

  for (const issue of issues) {
    if (!shouldPublishIssue(issue)) {
      continue;
    }

    publishableBeforeFilter += 1;
    if (issueMatchesDiagnosticMode(issue, mode)) {
      publishedInMode += 1;
    }
  }

  return {
    totalIssues: issues.length,
    publishableBeforeFilter,
    publishedInMode,
    retainedOnly: issues.length - publishableBeforeFilter,
  };
}

export function buildDiagnosticMessage(issue: DiagnosticsIssue): string {
  let message = `[${issue.category}] ${issue.message}`;
  if (issue.objectName) {
    message += ` (${issue.objectName})`;
  }
  if (issue.mapping.confidence === 'low') {
    message += ' [confidence: low]';
  }
  return message;
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