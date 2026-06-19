import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Event catalog — every production log event must use a name from this catalog.
// ---------------------------------------------------------------------------

export const LogEvents = {
  EXTENSION_ACTIVATED: 'extension.activated',
  EXTENSION_DEACTIVATED: 'extension.deactivated',

  COMMAND_FAILED: 'command.failed',

  COMMAND_SELF_TEST_PUBLISHED: 'command.selfTest.published',
  COMMAND_SELF_TEST_COMPLETED: 'command.selfTest.completed',
  COMMAND_FIXTURE_LOADING: 'command.fixture.loading',
  COMMAND_DIAGNOSTICS_CLEARED: 'command.diagnostics.cleared',
  COMMAND_TROUBLESHOOT_SAVED: 'command.troubleshoot.saved',

  COMMAND_DIRECT_RUN_BUILD_START: 'command.directRun.build.start',
  COMMAND_DIRECT_RUN_BUILD_PLAN: 'command.directRun.build.plan',
  COMMAND_DIRECT_RUN_BUILD_COMPLETED: 'command.directRun.build.completed',
  COMMAND_DIRECT_RUN_BUILD_STDOUT: 'command.directRun.build.stdout',
  COMMAND_DIRECT_RUN_BUILD_STDERR: 'command.directRun.build.stderr',
  COMMAND_DIRECT_RUN_CANCELED: 'command.directRun.build.canceled',
  COMMAND_DIRECT_RUN_PARSE_START: 'command.directRun.parse.start',
  COMMAND_DIRECT_RUN_PARSE_RESULT: 'command.directRun.parse.result',
  COMMAND_DIRECT_RUN_PARSE_COUNTS: 'command.directRun.parse.counts',
  COMMAND_DIRECT_RUN_PARSE_DEGRADED: 'command.directRun.parse.degraded',
  COMMAND_DIRECT_RUN_PUBLISHED: 'command.directRun.published',

  COMMAND_LOAD_FILE: 'command.load.file',
  COMMAND_LOAD_CONTRACT: 'command.load.contract',
  COMMAND_LOAD_PUBLISHABLE: 'command.load.publishable',
  COMMAND_LOAD_RESULT: 'command.load.result',
  COMMAND_LOAD_COMPLETED: 'command.load.completed',
  COMMAND_LOAD_EXPLAIN_LINE: 'command.load.explainLine',

  WATCH_STARTUP: 'watch.startup',
  WATCH_STATUS_REPORT_LINE: 'watch.status.reportLine',
  WATCH_FILE_SAVED: 'watch.file.saved',
  WATCH_FILE_SAVE_IGNORED_DISABLED: 'watch.file.saveIgnored.disabled',
  WATCH_FILE_SAVE_IGNORED_DECISION: 'watch.file.saveIgnored.decision',
  WATCH_FILE_SAVE_QUEUED: 'watch.file.saveQueued',
  WATCH_EVENT_IGNORED: 'watch.event.ignored',
  WATCH_EVENT_DETECTED: 'watch.event.detected',

  WATCH_REFRESH_REQUESTED: 'watch.refresh.requested',
  WATCH_REFRESH_CONFIGURED: 'watch.refresh.configured',
  WATCH_REFRESH_SKIPPED_NO_WORKSPACE: 'watch.refresh.skipped.noWorkspace',
  WATCH_DISCOVERY_DECISION: 'watch.discovery.decision',
  WATCH_DISCOVERY_COMPLETED: 'watch.discovery.completed',
  WATCH_PROJECTS_MERGED: 'watch.projects.merged',
  WATCH_REFRESH_STARTED: 'watch.refresh.started',
  WATCH_REFRESH_FAILED: 'watch.refresh.failed',
  WATCH_REFRESH_LOADED: 'watch.refresh.loaded',
  WATCH_REFRESH_NO_DIAGNOSTICS: 'watch.refresh.noDiagnostics',
  WATCH_REFRESH_COMPLETED: 'watch.refresh.completed',

  WATCH_STARTUP_SKIP_UNTRUSTED: 'watch.startup.skip.untrusted',
  WATCH_SAVE_SKIP_UNKNOWN: 'watch.save.skip.unknownProject',
  WATCH_SAVE_STARTED: 'watch.save.started',
  WATCH_SAVE_COMPLETED: 'watch.save.completed',
  WATCH_SINGLE_FLIGHT_SKIP: 'watch.refresh.skipped.singleFlight',

  PROJECT_REFRESH_LOADED: 'project.refresh.loaded',
  PROJECT_REFRESH_AUTO_ENRICH_START: 'project.refresh.autoEnrich.start',
  PROJECT_REFRESH_AUTO_ENRICH_COMPLETE: 'project.refresh.autoEnrich.complete',
  PROJECT_REFRESH_STATUS: 'project.refresh.status',
  PROJECT_REFRESH_RUNNING: 'project.refresh.running',
  PROJECT_REFRESH_FINISHED: 'project.refresh.finished',
  PROJECT_REFRESH_DRIFT_WARNING: 'project.refresh.driftWarning',
  PROJECT_REFRESH_ENRICHING: 'project.refresh.enriching',
  PROJECT_REFRESH_FAILED: 'project.refresh.failed',

  PROJECT_MIRROR_CHECK: 'project.mirror.check',
  PROJECT_MIRROR_KIND: 'project.mirror.kind',
  PROJECT_MIRROR_SELECTED: 'project.mirror.selected',
  PROJECT_MIRROR_MISSING: 'project.mirror.missing',

  PROJECT_CANDIDATE_INCOMPATIBLE: 'project.candidate.incompatible',
  PROJECT_CANDIDATE_SELECTED: 'project.candidate.selected',
  PROJECT_CANDIDATE_SEARCH: 'project.candidate.search',
  PROJECT_CANDIDATES: 'project.candidates',
  PROJECT_NO_CANDIDATE: 'project.noCandidate',

  PROJECT_SELECTION_DISCOVERY_DECISION: 'project.selection.discoveryDecision',
  PROJECT_SELECTION_AMBIGUOUS: 'project.selection.ambiguous',
  PROJECT_SELECTION_SOURCE_MISSING: 'project.selection.sourceMissing',
  PROJECT_SELECTION_INCOMPATIBLE: 'project.selection.incompatible',
  PROJECT_SELECTION_STALE: 'project.selection.stale',
  PROJECT_SELECTION_PICKED: 'project.selection.picked',
  PROJECT_SELECTION_DETECTED: 'project.selection.detected',
  PROJECT_SELECTION_NO_MATCH: 'project.selection.noMatch',
  PROJECT_SELECTION_EMPTY: 'project.selection.empty',

  ENRICHMENT_DEBUG_LINES: 'enrichment.debugLines',
  ENRICHMENT_PERMISSION: 'enrichment.permission',
  ENRICHMENT_SELECTED_RAW: 'enrichment.selectedRaw',
  ENRICHMENT_START: 'enrichment.start',
  ENRICHMENT_COMPLETED: 'enrichment.completed',
  ENRICHMENT_REFRESH_FAILED: 'enrichment.refreshFailed',
  ENRICHMENT_DRIFT_WARNING: 'enrichment.driftWarning',
  ENRICHMENT_UNAVAILABLE: 'enrichment.unavailable',

  PUBLICATION_ISSUE_SKIPPED: 'publication.issue.skipped',
  PUBLICATION_ISSUE_RESOLVED: 'publication.issue.resolved',
  PUBLICATION_SKIP_SAMPLE: 'publication.skipSample',

  DIAGNOSTICS_LOAD_ALL: 'diagnostics.loadAll',
} as const;

export type LogEventName = (typeof LogEvents)[keyof typeof LogEvents];

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

type LogValue = string | number | boolean | null | readonly string[];
type LogFields = Readonly<Record<string, LogValue>>;

// ---------------------------------------------------------------------------
// Privacy — keys whose values are always redacted before reaching the channel
// ---------------------------------------------------------------------------

const REDACTED_KEYS = new Set([
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie',
  'secret',
  'apiKey',
  'privateKey',
  'path',
  'fsPath',
  'absolutePath',
  'stdout',
  'stderr',
  'source',
  'document',
  'diagnostic',
  'diagnostics',
  'config',
]);

const REDACTED_MARKER = '[REDACTED]';

// ---------------------------------------------------------------------------
// Structured log event
// ---------------------------------------------------------------------------

export interface LogEvent {
  readonly name: LogEventName;
  readonly fields?: LogFields;
}

// ---------------------------------------------------------------------------
// Logger façade — one root instance per extension activation
// ---------------------------------------------------------------------------

export class SphinxDoctorLogger implements vscode.Disposable {
  static readonly LogEvents = LogEvents;

  private disposed = false;

  private constructor(
    private readonly channel: vscode.LogOutputChannel,
    private readonly contextFields: Readonly<Record<string, LogValue>>,
  ) {}

  // ---- factory ------------------------------------------------------------

  static create(): SphinxDoctorLogger {
    const channel = vscode.window.createOutputChannel('Sphinx Doctor', { log: true });
    return new SphinxDoctorLogger(channel, {});
  }

  // ---- structured methods -------------------------------------------------

  trace(event: LogEvent): void {
    this.emit('trace', event);
  }

  debug(event: LogEvent): void {
    this.emit('debug', event);
  }

  info(event: LogEvent): void {
    this.emit('info', event);
  }

  warn(event: LogEvent): void {
    this.emit('warn', event);
  }

  error(event: LogEvent): void {
    this.emit('error', event);
  }

  // ---- child loggers ------------------------------------------------------

  withContext(fields: LogFields): SphinxDoctorLogger {
    const merged: Record<string, LogValue> = { ...this.contextFields };
    for (const [key, value] of Object.entries(fields)) {
      merged[key] = value;
    }
    return new SphinxDoctorLogger(this.channel, merged);
  }

  // ---- UI -----------------------------------------------------------------

  show(preserveFocus = false): void {
    this.channel.show(preserveFocus);
  }

  // ---- disposal -----------------------------------------------------------

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.channel.dispose();
  }

  // ---- internal -----------------------------------------------------------

  private emit(
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error',
    event: LogEvent,
  ): void {
    if (this.disposed) {
      return;
    }

    const mergedFields: Record<string, LogValue> = { ...this.contextFields };
    if (event.fields) {
      for (const [key, value] of Object.entries(event.fields)) {
        mergedFields[key] = value;
      }
    }

    const safe: Record<string, LogValue> = {};
    for (const [key, value] of Object.entries(mergedFields)) {
      if (REDACTED_KEYS.has(key)) {
        safe[key] = REDACTED_MARKER;
      } else if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        safe[key] = value;
      } else if (Array.isArray(value)) {
        safe[key] = value.every(
          (entry) => typeof entry === 'string',
        )
          ? (value as readonly string[])
          : REDACTED_MARKER;
      } else {
        // Nested objects, functions, buffers, errors, URI objects → drop
        continue;
      }
    }

    const record = {
      event: event.name,
      ...safe,
    };

    const json = JSON.stringify(record);
    this.channel[level](json);
  }
}
