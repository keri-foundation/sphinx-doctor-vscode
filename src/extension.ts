import * as vscode from 'vscode';

import { registerCommands } from './commands';
import { getExtensionConfig } from './config';
import { createLogger } from './log';
import { DiagnosticsPublicationIndex } from './publication/publicationIndex';
import { SphinxDoctorWatchMode } from './watchMode';

export function activate(context: vscode.ExtensionContext): void {
  const config = getExtensionConfig();
  const logger = createLogger(config.logLevel);
  const collection = vscode.languages.createDiagnosticCollection('sphinx-doctor');
  const publicationIndex = new DiagnosticsPublicationIndex<vscode.Uri>();
  const watchMode = new SphinxDoctorWatchMode(context, collection, logger, publicationIndex);

  context.subscriptions.push(logger);
  context.subscriptions.push(collection);
  context.subscriptions.push(watchMode);

  logger.info('Sphinx Doctor activated.');
  registerCommands(context, { collection, logger, watchMode, publicationIndex });
  void watchMode.start();
}

export function deactivate(): void {
  // No-op for MVP.
}