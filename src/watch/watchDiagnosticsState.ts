import {
  ProjectPublicationSnapshot,
  summarizeProjectPublicationSnapshots,
} from './watchModeState';

export interface DiagnosticsStateSnapshot {
  readonly projectPublications: ReadonlyMap<string, ProjectPublicationSnapshot>;
  readonly projectStatuses: ReadonlyMap<string, string>;
  readonly issueCount: number;
  readonly publishableBeforeFilterCount: number;
  readonly publishedCount: number;
  readonly filteredByModeCount: number;
  readonly skippedCount: number;
  readonly resolutionFailureCount: number;
  readonly rawPendingCount: number;
  readonly errorCount: number;
}

export class WatchDiagnosticsState {
  private projectPublications = new Map<string, ProjectPublicationSnapshot>();
  private projectStatuses = new Map<string, string>();

  private issueCount = 0;
  private publishableBeforeFilterCount = 0;
  private publishedCount = 0;
  private filteredByModeCount = 0;
  private skippedCount = 0;
  private resolutionFailureCount = 0;
  private rawPendingCount = 0;
  private errorCount = 0;

  clear(): void {
    this.projectPublications.clear();
    this.projectStatuses.clear();
    this.issueCount = 0;
    this.publishableBeforeFilterCount = 0;
    this.publishedCount = 0;
    this.filteredByModeCount = 0;
    this.skippedCount = 0;
    this.resolutionFailureCount = 0;
    this.rawPendingCount = 0;
    this.errorCount = 0;
  }

  clearProjectPublications(): void {
    this.projectPublications.clear();
  }

  setProjectPublication(
    projectId: string,
    snapshot: ProjectPublicationSnapshot,
  ): void {
    this.projectPublications.set(projectId, snapshot);
  }

  getProjectPublications(): ReadonlyMap<string, ProjectPublicationSnapshot> {
    return this.projectPublications;
  }

  clearProjectStatuses(): void {
    this.projectStatuses.clear();
  }

  setProjectStatus(projectId: string, status: string): void {
    this.projectStatuses.set(projectId, status);
  }

  getProjectStatuses(): ReadonlyMap<string, string> {
    return this.projectStatuses;
  }

  deriveAggregateFromSnapshots(): { loadedDiagnosticsFiles: string[] } {
    const aggregate = summarizeProjectPublicationSnapshots(
      this.projectPublications.values(),
    );

    this.issueCount = aggregate.issueCount;
    this.publishableBeforeFilterCount = aggregate.publishableBeforeFilter;
    this.publishedCount = aggregate.publishedDiagnostics;
    this.filteredByModeCount = aggregate.filteredByMode;
    this.skippedCount = aggregate.skippedIssues;
    this.resolutionFailureCount = aggregate.resolutionFailures;

    return { loadedDiagnosticsFiles: aggregate.loadedDiagnosticsFiles };
  }

  applyManualCounters(options: {
    issueCount: number;
    publishableBeforeFilter: number;
    publishedDiagnostics: number;
    filteredByMode: number;
    skippedIssues: number;
    resolutionFailures: number;
  }): void {
    this.issueCount = options.issueCount;
    this.publishableBeforeFilterCount = options.publishableBeforeFilter;
    this.publishedCount = options.publishedDiagnostics;
    this.filteredByModeCount = options.filteredByMode;
    this.skippedCount = options.skippedIssues;
    this.resolutionFailureCount = options.resolutionFailures;
  }

  setRawPendingCount(count: number): void {
    this.rawPendingCount = count;
  }

  getRawPendingCount(): number {
    return this.rawPendingCount;
  }

  setErrorCount(count: number): void {
    this.errorCount = count;
  }

  getErrorCount(): number {
    return this.errorCount;
  }

  getIssueCount(): number {
    return this.issueCount;
  }

  getPublishedCount(): number {
    return this.publishedCount;
  }

  getPublishableBeforeFilterCount(): number {
    return this.publishableBeforeFilterCount;
  }

  getFilteredByModeCount(): number {
    return this.filteredByModeCount;
  }

  getSkippedCount(): number {
    return this.skippedCount;
  }

  getResolutionFailureCount(): number {
    return this.resolutionFailureCount;
  }

  snapshot(): DiagnosticsStateSnapshot {
    return {
      projectPublications: this.projectPublications,
      projectStatuses: this.projectStatuses,
      issueCount: this.issueCount,
      publishableBeforeFilterCount: this.publishableBeforeFilterCount,
      publishedCount: this.publishedCount,
      filteredByModeCount: this.filteredByModeCount,
      skippedCount: this.skippedCount,
      resolutionFailureCount: this.resolutionFailureCount,
      rawPendingCount: this.rawPendingCount,
      errorCount: this.errorCount,
    };
  }
}
