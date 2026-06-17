import type { SphinxDoctorLogger } from '../logging/extensionLogger';

export interface LoadAllDiagnosticsSnapshot {
  discoveredProjectCount: number;
  knownProjectCount: number;
  loadedProjectCount: number;
  skippedProjectCount: number;
  issueCount: number;
  publishedDiagnostics: number;
}

export interface LoadAllDiagnosticsWatchModeLike {
  refreshAll(reason: string, loadDiagnostics?: boolean): Promise<void>;
  getLastRefreshSnapshot(): LoadAllDiagnosticsSnapshot;
}

export interface LoadAllDiagnosticsDependencies {
  watchMode?: LoadAllDiagnosticsWatchModeLike;
  logger: Pick<SphinxDoctorLogger, 'info' | 'warn'>;
  showWarningMessage(message: string): void;
  showInformationMessage(message: string): void;
}

export function buildLoadAllDiagnosticsStatusMessage(
  snapshot: LoadAllDiagnosticsSnapshot,
): string {
  return [
    `Sphinx Doctor inspected ${snapshot.knownProjectCount} supported project(s)`,
    `${snapshot.loadedProjectCount} loaded`,
    `${snapshot.skippedProjectCount} skipped`,
    `${snapshot.issueCount} issues`,
    `${snapshot.publishedDiagnostics} published diagnostics`,
  ].join('; ');
}

export async function loadAllDiscoveredDiagnostics(
  dependencies: LoadAllDiagnosticsDependencies,
): Promise<LoadAllDiagnosticsSnapshot | undefined> {
  if (!dependencies.watchMode) {
    dependencies.showWarningMessage(
      'Sphinx Doctor watch mode is unavailable, so Discover and Load Diagnostics cannot load all workspace projects.',
    );
    return undefined;
  }

  await dependencies.watchMode.refreshAll('manual command: discover and load diagnostics', true);
  const snapshot = dependencies.watchMode.getLastRefreshSnapshot();
  const message = buildLoadAllDiagnosticsStatusMessage(snapshot);

  dependencies.logger.info(
    `Load-all diagnostics completed: discovered=${snapshot.discoveredProjectCount}; known=${snapshot.knownProjectCount}; loaded=${snapshot.loadedProjectCount}; skipped=${snapshot.skippedProjectCount}; issues=${snapshot.issueCount}; published=${snapshot.publishedDiagnostics}.`,
  );
  dependencies.showInformationMessage(message);
  return snapshot;
}