import * as vscode from 'vscode';

import { SphinxDoctorLogger } from '../logging/extensionLogger';

export async function runSafely(
  logger: SphinxDoctorLogger,
  label: string,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`${label} failed: ${message}`);
    void vscode.window.showErrorMessage(`Sphinx Doctor failed: ${message}`);
  }
}
