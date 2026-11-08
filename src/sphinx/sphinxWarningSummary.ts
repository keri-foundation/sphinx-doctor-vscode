export interface WarningFileSummary {
  byteLength: number;
  lineCount: number;
  blankLineCount: number;
  nonBlankLineCount: number;
  docstringWarningCount: number;
  standardWarningCount: number;
  globalWarningCount: number;
  firstTenLines: string;
}

export function summarizeWarningFileContent(content: string): WarningFileSummary {
  const lines = content.split(/\r?\n/);
  const blankLineCount = lines.filter((line) => line.trim().length === 0).length;

  return {
    byteLength: Buffer.byteLength(content, 'utf8'),
    lineCount: lines.length,
    blankLineCount,
    nonBlankLineCount: lines.length - blankLineCount,
    docstringWarningCount: lines.filter((line) => line.includes('docstring of')).length,
    standardWarningCount: lines.filter((line) => /^[^:]+:[0-9]+: (WARNING|ERROR|INFO):/.test(line)).length,
    globalWarningCount: lines.filter((line) => /^(WARNING|ERROR|INFO):/.test(line)).length,
    firstTenLines: lines.slice(0, 10).map((line) => line.trimEnd()).join(' | '),
  };
}

export function shouldTreatWarningFileAsEmpty(summary: WarningFileSummary): boolean {
  return summary.byteLength === 0 || summary.nonBlankLineCount === 0;
}
