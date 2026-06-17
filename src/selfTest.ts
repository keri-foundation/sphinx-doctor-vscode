import {
  SELF_TEST_COMMAND_ID,
  SELF_TEST_COMMAND_TITLE,
  SELF_TEST_FALLBACK_RELATIVE_PATH,
  SELF_TEST_MESSAGE,
  SELF_TEST_SOURCE,
  SELF_TEST_STATUS_TEXT,
} from './constants/selfTest';

export {
  SELF_TEST_COMMAND_ID,
  SELF_TEST_COMMAND_TITLE,
  SELF_TEST_FALLBACK_RELATIVE_PATH,
  SELF_TEST_MESSAGE,
  SELF_TEST_SOURCE,
  SELF_TEST_STATUS_TEXT,
};

export interface SelfTestDiagnosticSpec {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  message: string;
  source: string;
  severity: 'warning';
}

export interface SelfTestPublishResult {
  diagnosticCount: number;
  targetUriCount: number;
}

interface ClearableDiagnosticCollection {
  clear(): void;
}

export function createSelfTestDiagnosticSpec(): SelfTestDiagnosticSpec {
  return {
    startLine: 0,
    startColumn: 0,
    endLine: 0,
    endColumn: 1,
    message: SELF_TEST_MESSAGE,
    source: SELF_TEST_SOURCE,
    severity: 'warning',
  };
}

export function publishSelfTestDiagnostic<TTarget, TDiagnostic>(
  setDiagnostics: (target: TTarget, diagnostics: readonly TDiagnostic[]) => void,
  target: TTarget,
  createDiagnostic: (spec: SelfTestDiagnosticSpec) => TDiagnostic,
): SelfTestPublishResult {
  const diagnostic = createDiagnostic(createSelfTestDiagnosticSpec());
  setDiagnostics(target, [diagnostic]);
  return {
    diagnosticCount: 1,
    targetUriCount: 1,
  };
}

export function clearPublishedDiagnostics(collection: ClearableDiagnosticCollection): void {
  collection.clear();
}

export function buildSelfTestStatusTooltip(targetUri: string, diagnosticCount: number): string {
  return [
    'Sphinx Doctor self-test diagnostic published.',
    `Target: ${targetUri}`,
    `Published diagnostics: ${diagnosticCount}`,
  ].join('\n');
}