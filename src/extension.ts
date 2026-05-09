import * as vscode from 'vscode';

import { registerCommands } from './commands';
import { getExtensionConfig } from './config';
import { createLogger } from './log';
import { SphinxDoctorWatchMode } from './watchMode';

export function activate(context: vscode.ExtensionContext): void {
  const config = getExtensionConfig();
  const logger = createLogger(config.logLevel);
  const collection = vscode.languages.createDiagnosticCollection('sphinx-doctor');
  const watchMode = new SphinxDoctorWatchMode(context, collection, logger);

  context.subscriptions.push(logger);
  context.subscriptions.push(collection);
  context.subscriptions.push(watchMode);

  logger.info('Sphinx Doctor activated.');
  registerCommands(context, { collection, logger, watchMode });
  void watchMode.start();
}

export function deactivate(): void {
  // No-op for MVP.
}