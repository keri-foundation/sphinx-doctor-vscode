import * as vscode from 'vscode';

import { registerCommands } from './commands/registerCommands';
import { SphinxDoctorLogger } from './logging/extensionLogger';
import { DiagnosticsPublicationIndex } from './publication/publicationIndex';
import { SphinxDoctorWatchMode } from './watch/watchMode';

export function activate(context: vscode.ExtensionContext): void {
  const logger = SphinxDoctorLogger.create();
  const collection = vscode.languages.createDiagnosticCollection('sphinx-doctor');
  const publicationIndex = new DiagnosticsPublicationIndex<vscode.Uri>();
  const watchMode = new SphinxDoctorWatchMode(context, collection, logger, publicationIndex);

  context.subscriptions.push(logger);
  context.subscriptions.push(collection);
  context.subscriptions.push(watchMode);

  logger.info({
    name: SphinxDoctorLogger.LogEvents.EXTENSION_ACTIVATED,
  });
  registerCommands(context, { collection, logger, watchMode, publicationIndex });
  void watchMode.start();
}

export function deactivate(): void {
  // No-op for MVP.
}