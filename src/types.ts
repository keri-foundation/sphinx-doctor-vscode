export type SphinxDoctorLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type DiscoveryConfidence = 'high' | 'medium' | 'low';

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
  label?: string;
  sourceWorkspaceFolder: string;
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
  logLevel: SphinxDoctorLogLevel;
}

export interface WatchModeSummary {
  state: 'idle' | 'watching' | 'no-diagnostics' | 'error';
  projectCount: number;
  issueCount: number;
  publishedDiagnostics: number;
  watcherCount: number;
  message: string;
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

export function shouldPublishIssue(issue: DiagnosticsIssue): boolean {
  return issue.publishDiagnostic === true && Boolean(issue.sourceRange) && Boolean(issue.repoRelativePath);
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