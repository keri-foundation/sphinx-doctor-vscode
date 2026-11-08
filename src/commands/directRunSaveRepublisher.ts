import path from 'node:path';

import * as vscode from 'vscode';

import { SphinxDoctorLogger } from '../logging/extensionLogger';

/**
 * Scheduling primitives injected so the republisher is independently unit-testable.
 */
export interface RepublisherScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export function createDefaultRepublisherScheduler(): RepublisherScheduler {
  return {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

/**
 * Result classification so callers can distinguish a completed publishable run
 * from a blocked, declined, or failed run.
 */
export type DirectRunOutcome =
  | 'completed'
  | 'blocked'
  | 'declined'
  | 'failed';

/**
 * Callback signature for the actual direct-run execution.
 * The republisher calls this for both manual and automatic runs.
 */
export type DirectRunExecutor = (
  dependencies: CommandDependenciesForRepublisher,
  options: { suppressSuccessToast: boolean },
) => Promise<DirectRunOutcome>;

/**
 * Minimal dependency surface needed by the republisher.
 */
export interface CommandDependenciesForRepublisher {
  collection: vscode.DiagnosticCollection;
  logger: SphinxDoctorLogger;
  watchMode?: { noteManualDiagnosticsPublished(info: unknown): void };
  publicationIndex: { clear(): void };
}

/**
 * Persistent session state for a single direct-run workspace.
 *
 * Lifecycle:
 * 1. Created inactive.
 * 2. Armed by a completed manual direct run.
 * 3. Listens for eligible ``.py`` saves in the resolved workspace root.
 * 4. Disposed on extension deactivation via context.subscriptions.
 */
export class DirectRunSaveRepublisher {
  private _state:
    | 'inactive'
    | 'armed'
    | 'debouncing'
    | 'running'
    | 'running-with-pending-save'
    | 'disposed' = 'inactive';

  private _workspaceRoot: string | null = null;
  private _outputDir: string | null = null;
  private _debounceTimer: unknown = undefined;
  private _pendingSave = false;
  private _saveListener: vscode.Disposable | null = null;

  constructor(
    private readonly _executor: DirectRunExecutor,
    private readonly _dependencies: CommandDependenciesForRepublisher,
    private readonly _scheduler: RepublisherScheduler,
    private readonly _debounceMsResolver: () => number,
  ) {}

  // ── public API ──────────────────────────────────────────────────────

  /** Arm the session after a successful manual direct run. */
  armSession(
    workspaceRoot: string,
    outputDir: string,
    context: vscode.ExtensionContext,
  ): void {
    if (this._state === 'disposed') {
      return;
    }

    this._workspaceRoot = path.resolve(workspaceRoot);
    this._outputDir = outputDir ? path.resolve(this._workspaceRoot, outputDir) : null;

    // Replace any previous listener (idempotent re-arm).
    this._disposeListener();

    this._saveListener = vscode.workspace.onDidSaveTextDocument(
      (document) => { void this._handleSave(document); },
    );
    context.subscriptions.push(this._saveListener);

    this._state = 'armed';

    this._dependencies.logger.info({
      name: SphinxDoctorLogger.LogEvents.COMMAND_DIRECT_RUN_BUILD_START,
      fields: {
        event: 'direct-run-session-armed',
        workspaceRoot: this._workspaceRoot,
      },
    });
  }

  dispose(): void {
    this._state = 'disposed';
    this._cancelTimer();
    this._disposeListener();
    this._workspaceRoot = null;
    this._outputDir = null;
    this._pendingSave = false;
  }

  // ── save eligibility ────────────────────────────────────────────────

  isEligibleSave(document: vscode.TextDocument): boolean {
    if (this._state === 'inactive' || this._state === 'disposed') {
      return false;
    }

    if (document.uri.scheme !== 'file') {
      return false;
    }

    const ext = path.extname(document.uri.fsPath).toLowerCase();
    if (ext !== '.py') {
      return false;
    }

    if (!this._isWithinRoot(document.uri.fsPath)) {
      return false;
    }

    if (this._isWithinOutputDir(document.uri.fsPath)) {
      return false;
    }

    return true;
  }

  /** Exposed for tests. */
  get state(): string {
    return this._state;
  }

  /** Exposed for tests. */
  get workspaceRoot(): string | null {
    return this._workspaceRoot;
  }

  // ── explicit manual run ─────────────────────────────────────────────

  async handleExplicitRun(): Promise<DirectRunOutcome> {
    this._cancelTimer();

    if (this._state === 'running' || this._state === 'running-with-pending-save') {
      // Queue one manual rerun after the current build completes.
      this._pendingSave = true;
      return 'blocked';
    }

    this._state = 'running';
    try {
      return await this._executor(this._dependencies, { suppressSuccessToast: false });
    } finally {
      this._transitionAfterBuild();
    }
  }

  // ── internal ────────────────────────────────────────────────────────

  private async _handleSave(document: vscode.TextDocument): Promise<void> {
    if (!this.isEligibleSave(document)) {
      return;
    }

    this._dependencies.logger.info({
      name: SphinxDoctorLogger.LogEvents.COMMAND_DIRECT_RUN_BUILD_START,
      fields: {
        event: 'direct-run-save-eligible',
        path: document.uri.fsPath,
        state: this._state,
      },
    });

    if (this._state === 'running' || this._state === 'running-with-pending-save') {
      // Mark one pending rerun; coalesce multiple saves.
      this._state = 'running-with-pending-save';
      this._pendingSave = true;
      return;
    }

    // armed or debouncing → reset debounce
    this._state = 'debouncing';
    this._cancelTimer();
    this._debounceTimer = this._scheduler.setTimeout(() => {
      this._debounceTimer = undefined;
      void this._runAutomaticBuild();
    }, this._debounceMsResolver());
  }

  private async _runAutomaticBuild(): Promise<void> {
    this._state = 'running';
    try {
      await this._executor(this._dependencies, { suppressSuccessToast: true });
    } finally {
      this._transitionAfterBuild();
    }
  }

  private _transitionAfterBuild(): void {
    if (this._state === 'disposed') {
      return;
    }

    if (this._pendingSave) {
      this._pendingSave = false;
      this._state = 'debouncing';
      this._cancelTimer();
      this._debounceTimer = this._scheduler.setTimeout(() => {
        this._debounceTimer = undefined;
        void this._runAutomaticBuild();
      }, this._debounceMsResolver());
    } else {
      this._state = 'armed';
    }
  }

  private _isWithinRoot(candidatePath: string): boolean {
    if (!this._workspaceRoot) {
      return false;
    }

    const normalizedRoot = path.resolve(this._workspaceRoot);
    const normalizedCandidate = path.resolve(candidatePath);

    const relative = path.relative(normalizedRoot, normalizedCandidate);
    return (
      relative !== '' &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative)
    );
  }

  private _isWithinOutputDir(candidatePath: string): boolean {
    if (!this._outputDir) {
      return false;
    }

    const normalizedOutput = path.resolve(this._outputDir);
    const normalizedCandidate = path.resolve(candidatePath);

    const relative = path.relative(normalizedOutput, normalizedCandidate);
    return (
      relative === '' ||
      (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    );
  }

  private _cancelTimer(): void {
    if (this._debounceTimer !== undefined) {
      this._scheduler.clearTimeout(this._debounceTimer);
      this._debounceTimer = undefined;
    }
  }

  private _disposeListener(): void {
    if (this._saveListener) {
      this._saveListener.dispose();
      this._saveListener = null;
    }
  }
}
