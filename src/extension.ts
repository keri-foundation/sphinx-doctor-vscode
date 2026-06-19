import * as vscode from 'vscode';

import { registerCommands } from './commands/registerCommands';
import { SphinxDoctorLogger } from './logging/extensionLogger';
import { DocstringRepairTargetIndex } from './docstrings/repair/docstringRepairTargetIndex';
import { DiagnosticsPublicationIndex } from './publication/publicationIndex';
import { SphinxDoctorWatchMode } from './watch/watchMode';

export function activate(context: vscode.ExtensionContext): void {
  const logger = SphinxDoctorLogger.create();
  const collection = vscode.languages.createDiagnosticCollection('sphinx-doctor');
  const publicationIndex = new DiagnosticsPublicationIndex<vscode.Uri>();
  const repairIndex = new DocstringRepairTargetIndex();
  const watchMode = new SphinxDoctorWatchMode(context, collection, logger, publicationIndex);

  context.subscriptions.push(logger);
  context.subscriptions.push(collection);
  context.subscriptions.push(watchMode);
  context.subscriptions.push({ dispose: () => repairIndex.clear() });

  logger.info({
    name: SphinxDoctorLogger.LogEvents.EXTENSION_ACTIVATED,
  });
  registerCommands(context, { collection, logger, watchMode, publicationIndex });
  void watchMode.start();
}

export function deactivate(): void {
  // No-op for MVP.
}