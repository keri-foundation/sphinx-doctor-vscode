import path from 'node:path';

export class WatchEventSuppression {
  private suppressedPaths = new Map<string, number>();
  private now: () => number;

  constructor(clock: () => number = Date.now) {
    this.now = clock;
  }

  setNow(clock: () => number): void {
    this.now = clock;
  }

  recordSuppressed(filePaths: string[]): void {
    const expiresAt = this.now() + 2000;
    for (const filePath of filePaths) {
      this.suppressedPaths.set(path.resolve(filePath), expiresAt);
    }
  }

  isSuppressed(filePath: string): boolean {
    const normalizedPath = path.resolve(filePath);
    const expiresAt = this.suppressedPaths.get(normalizedPath);
    if (expiresAt === undefined) {
      return false;
    }

    if (expiresAt < this.now()) {
      this.suppressedPaths.delete(normalizedPath);
      return false;
    }

    return true;
  }
}
