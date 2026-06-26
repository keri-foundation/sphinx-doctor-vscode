import { findAllDocstringSpans, isRangeInDocstringSpan } from '../docstrings/TextPythonDocstringSourceMapper';

/**
 * Result of verifying whether a diagnostic range lies inside a Python
 * docstring span.
 */
export interface DocstringRangeGateResult {
  /** True when the range is fully inside a verified docstring span. */
  passed: boolean;
  /** Machine-readable reason code for skip accounting. */
  skipReason:
    | 'publisher-range-not-in-docstring'
    | 'publisher-range-outside-resolved-object-docstring'
    | 'publisher-source-unavailable'
    | 'publisher-column-out-of-bounds'
    | 'publisher-docstring-delimiter-range'
    | 'publisher-invalid-range';
  /** Human-readable explanation. */
  reason: string;
}

/**
 * Test whether every character of a source line from startColumn onward
 * is part of a triple-quote delimiter.
 *
 * Columns are 1-indexed (VS Code convention).  A line such as ``    """``
 * with columns 5–7 is a delimiter-only range because every character from
 * column 5 to the end of the visible content is a ``"`` belonging to the
 * ``"""`` token.
 */
function isDelimiterOnlyRange(line: string, startColumn: number, _endColumn: number): boolean {
  const text = line;
  // Find the opening triple-quote position (0-indexed)
  const quoteIdx = text.indexOf('"""');
  if (quoteIdx === -1) {
    const singleIdx = text.indexOf("'''");
    if (singleIdx === -1) return false;
    // Check if startColumn falls on the ''' delimiter
    const col0 = startColumn - 1;
    return col0 >= singleIdx && col0 < singleIdx + 3;
  }
  // Check if startColumn falls on the """ delimiter
  const col0 = startColumn - 1;
  if (col0 < quoteIdx || col0 >= quoteIdx + 3) return false;
  // Verify every character from startColumn to end of line is only whitespace or quotes
  const tail = text.substring(col0);
  for (const ch of tail) {
    if (ch !== '"' && ch !== "'" && ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}

/**
 * Centralized fail-closed docstring-range publication gate.
 *
 * Verifies that a diagnostic source range lies wholly inside a real Python
 * triple-quoted docstring span in the given source text.
 *
 * Columns are 1-indexed (VS Code convention).  When columns are omitted the
 * check degrades to line-only containment.
 *
 * When ``resolvedDocstringStartLine`` and ``resolvedDocstringEndLine`` are
 * provided, the range must also lie within that specific object's docstring,
 * not just any docstring in the file.
 *
 * This is the single choke-point for the invariant:
 *   A Python diagnostic may be published only when its complete published
 *   range is proven to lie inside a real triple-quoted Python docstring span.
 */
export function checkDocstringRangeGate(
  sourceText: string,
  startLine: number,
  endLine: number,
  resolvedDocstringStartLine?: number | null,
  resolvedDocstringEndLine?: number | null,
  startColumn?: number | null,
  endColumn?: number | null,
): DocstringRangeGateResult {
  if (startLine < 1 || endLine < 1) {
    return {
      passed: false,
      skipReason: 'publisher-source-unavailable',
      reason: `Invalid range: startLine=${startLine}, endLine=${endLine}`,
    };
  }

  const lines = sourceText.split('\n');

  // ── Physical column-bounds check ──────────────────────────────────
  if (startColumn != null && endColumn != null) {
    const startLineIdx = startLine - 1;
    const endLineIdx = endLine - 1;

    if (startLineIdx >= lines.length || endLineIdx >= lines.length) {
      return {
        passed: false,
        skipReason: 'publisher-column-out-of-bounds',
        reason: `Line out of bounds: file has ${lines.length} lines, range is [${startLine}, ${endLine}]`,
      };
    }

    const startLineText = lines[startLineIdx];
    const endLineText = lines[endLineIdx];

    // VS Code columns are 1-indexed; line length is the character count
    if (startColumn < 1 || startColumn > startLineText.length + 1) {
      return {
        passed: false,
        skipReason: 'publisher-column-out-of-bounds',
        reason: `startColumn ${startColumn} out of bounds for line ${startLine} (length ${startLineText.length})`,
      };
    }
    if (endColumn < 1 || endColumn > endLineText.length + 1) {
      return {
        passed: false,
        skipReason: 'publisher-column-out-of-bounds',
        reason: `endColumn ${endColumn} out of bounds for line ${endLine} (length ${endLineText.length})`,
      };
    }

    if (startLine === endLine && startColumn > endColumn) {
      return {
        passed: false,
        skipReason: 'publisher-invalid-range',
        reason: `Invalid range: startColumn ${startColumn} > endColumn ${endColumn} on same line`,
      };
    }

    // ── Delimiter-only rejection ────────────────────────────────────
    // Reject ranges that lie only on the opening or closing triple-quote
    // delimiter of a docstring.
    if (startLine === endLine && isDelimiterOnlyRange(startLineText, startColumn, endColumn)) {
      return {
        passed: false,
        skipReason: 'publisher-docstring-delimiter-range',
        reason: `Range [${startLine}:${startColumn}–${endColumn}] is on a triple-quote delimiter`,
      };
    }
  }

  const spans = findAllDocstringSpans(lines);

  if (spans.length === 0) {
    return {
      passed: false,
      skipReason: 'publisher-range-not-in-docstring',
      reason: 'Source file contains no detectable docstring spans',
    };
  }

  // Verify the range is inside at least one docstring span
  if (!isRangeInDocstringSpan(spans, startLine, endLine)) {
    return {
      passed: false,
      skipReason: 'publisher-range-not-in-docstring',
      reason: `Range [${startLine}, ${endLine}] is not inside any docstring span`,
    };
  }

  // If the caller provides resolved-object docstring metadata, also verify
  // the range is inside THAT specific object's docstring
  if (resolvedDocstringStartLine != null && resolvedDocstringEndLine != null) {
    if (startLine < resolvedDocstringStartLine || endLine > resolvedDocstringEndLine) {
      return {
        passed: false,
        skipReason: 'publisher-range-outside-resolved-object-docstring',
        reason: `Range [${startLine}, ${endLine}] outside resolved object docstring [${resolvedDocstringStartLine}, ${resolvedDocstringEndLine}]`,
      };
    }
  }

  return { passed: true, skipReason: 'publisher-source-unavailable', reason: '' };
}
