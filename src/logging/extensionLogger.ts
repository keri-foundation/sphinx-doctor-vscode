import * as vscode from 'vscode';

import { SphinxDoctorLogLevel } from '../types';

const LOG_LEVEL_ORDER: Record<SphinxDoctorLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class SphinxDoctorLogger implements vscode.Disposable {
  private level: SphinxDoctorLogLevel;

  public constructor(private readonly channel: vscode.OutputChannel, level: SphinxDoctorLogLevel) {
    this.level = level;
  }

  public setLevel(level: SphinxDoctorLogLevel): void {
    this.level = level;
  }

  public debug(message: string): void {
    this.log('debug', message);
  }

  public info(message: string): void {
    this.log('info', message);
  }

  public warn(message: string): void {
    this.log('warn', message);
  }

  public error(message: string): void {
    this.log('error', message);
  }

  public show(preserveFocus = false): void {
    this.channel.show(preserveFocus);
  }

  public dispose(): void {
    this.channel.dispose();
  }

  private log(level: SphinxDoctorLogLevel, message: string): void {
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.level]) {
      return;
    }

    const timestamp = new Date().toISOString();
    this.channel.appendLine(`[${timestamp}] ${level.toUpperCase()} ${message}`);
  }
}

export function createLogger(level: SphinxDoctorLogLevel): SphinxDoctorLogger {
  const channel = vscode.window.createOutputChannel('Sphinx Doctor');
  return new SphinxDoctorLogger(channel, level);
}