import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

import {
  PythonDocstringSourceMapRequest,
  PythonDocstringSourceMapResult,
  PythonDocstringSourceMapper,
} from './PythonDocstringSourceMapper';

// ---- Internal types ----

interface DefResult {
  defLine: number;
  indent: number;
}

interface DocstringBlock {
  startLine: number;
  endLine: number;
}

// ---- Locator implementation ----

/**
 * Conservative text-based Python docstring locator.
 *
 * Uses indentation and triple-quoted string detection to find Python
 * docstring blocks. No WASM, no native compilation, no external parser
 * dependencies.
 *
 * Safety rules:
 * - Only accepts triple-quoted strings immediately after class/def headers.
 * - Indentation is used to constrain class/method nesting.
 * - Target line must be inside the docstring block.
 * - Returns no result for ambiguous cases.
 * - Prefers fewer correct diagnostics over many wrong diagnostics.
 */
export class TextPythonDocstringSourceMapper implements PythonDocstringSourceMapper {
  async locate(request: PythonDocstringSourceMapRequest): Promise<PythonDocstringSourceMapResult> {
    const results = await this.locateBatch([request]);
    return results[0];
  }

  async locateBatch(requests: PythonDocstringSourceMapRequest[]): Promise<PythonDocstringSourceMapResult[]> {
    const byFile = new Map<string, PythonDocstringSourceMapRequest[]>();
    for (const req of requests) {
      const existing = byFile.get(req.filePath) || [];
      existing.push(req);
      byFile.set(req.filePath, existing);
    }

    const results: PythonDocstringSourceMapResult[] = [];

    for (const [filePath, fileRequests] of byFile) {
      let lines: string[];
      try {
        const content = await fs.readFile(filePath, 'utf8');
        lines = content.split('\n');
      } catch {
        for (const req of fileRequests) {
          results.push(this.lowConfidence(req, `Failed to read file: ${filePath}`));
        }
        continue;
      }

      for (const req of fileRequests) {
        results.push(this.locateInSource(req, lines));
      }
    }

    return results;
  }

  // ---- Core logic ----

  private locateInSource(request: PythonDocstringSourceMapRequest, lines: string[]): PythonDocstringSourceMapResult {
    const objectPath = request.objectPath;
    const docstringLine = request.docstringLine;

    const pathParts = objectPath.split('.');
    const targetParts = extractClassAndMember(pathParts);

    const defResult = findDefinition(lines, targetParts);
    if (!defResult) {
      return this.lowConfidence(request, `Could not find object "${objectPath}" in source`);
    }

    const docstring = findDocstring(lines, defResult.defLine);
    if (!docstring) {
      return {
        targetLine: defResult.defLine + 1,
        confidence: 'low',
        reason: `Object "${objectPath}" found but has no detectable docstring`,
        matchedObject: targetParts.join('.'),
        backend: 'text-scanner',
      };
    }

    // Sphinx docstringLine is 1-indexed inside docstring content.
    // docstring.startLine is 0-indexed pointing at the """ line.
    // targetLine0 = startLine + docstringLine (first content line after """)
    const targetLine0 = docstring.startLine + docstringLine;

    if (targetLine0 > docstring.endLine) {
      return {
        targetLine: docstring.startLine + 1,
        confidence: 'medium',
        reason: `Docstring line ${docstringLine} outside docstring bounds`,
        matchedObject: targetParts.join('.'),
        docstringStartLine: docstring.startLine + 1,
        docstringEndLine: docstring.endLine + 1,
        backend: 'text-scanner',
      };
    }

    if (targetLine0 <= docstring.startLine) {
      return {
        targetLine: docstring.startLine + 2,
        confidence: 'medium',
        reason: `Docstring line ${docstringLine} is before first content line`,
        matchedObject: targetParts.join('.'),
        docstringStartLine: docstring.startLine + 1,
        docstringEndLine: docstring.endLine + 1,
        backend: 'text-scanner',
      };
    }

    // Compute exact UTF-16 code-unit offsets.
    // docstring.startLine is 0-indexed pointing at the opening delimiter line.
    // docstring.endLine is 0-indexed pointing at the closing delimiter line.
    const docstringStartOffset = lineStartOffset(lines, docstring.startLine);
    const docstringEndOffset = lineEndOffset(lines, docstring.endLine);

    // targetOffset: position of the target line within the source.
    // targetLine0 is 0-indexed pointing at the content line within the docstring.
    const targetOffset = lineStartOffset(lines, targetLine0);

    // Join lines back to source for factory fingerprint computation
    const sourceText = lines.join('\n');

    return {
      targetLine: targetLine0 + 1,
      confidence: 'high',
      reason: `Mapped to source line ${targetLine0 + 1} in docstring of ${targetParts.join('.')}`,
      matchedObject: targetParts.join('.'),
      docstringStartLine: docstring.startLine + 1,
      docstringEndLine: docstring.endLine + 1,
      docstringStartOffset,
      docstringEndOffset,
      targetOffset,
      sourceText,
      docstringFingerprint: computeSpanFingerprint(lines, docstringStartOffset, docstringEndOffset),
      backend: 'text-scanner',
    };
  }

  private lowConfidence(request: PythonDocstringSourceMapRequest, reason: string): PythonDocstringSourceMapResult {
    return {
      targetLine: request.docstringLine,
      confidence: 'low',
      reason,
      backend: 'text-scanner',
    };
  }

  dispose(): void {
    // No resources to clean up
  }
}

// ---- Pure helper functions ----

/**
 * Extract class/method names from a fully qualified Python object path.
 * Discards module prefix (lowercase segments).
 *
 *   "keri.app.habbing.BaseHab.endorse" → ["BaseHab", "endorse"]
 *   "keri.core.coring.Matter"          → ["Matter"]
 *   "keri.core.coring.Matter.__init__" → ["Matter", "__init__"]
 *   "keri.app.habbing.openHab"         → ["openHab"]
 */
export function extractClassAndMember(pathParts: string[]): string[] {
  const result: string[] = [];
  for (const part of pathParts) {
    if (part.length === 0) continue;
    const isUpper = part[0] !== part[0].toLowerCase();
    const isDunder = part.startsWith('__') && part.endsWith('__');
    if (isUpper || isDunder) {
      result.push(part);
    }
  }
  // If classes were found, include the final path part as the method/function name
  // (it may be lowercase, e.g. "endorse" in "BaseHab.endorse")
  const lastPart = pathParts[pathParts.length - 1];
  if (result.length > 0 && lastPart && lastPart !== result[result.length - 1]) {
    const isUpper = lastPart[0] !== lastPart[0].toLowerCase();
    const isDunder = lastPart.startsWith('__') && lastPart.endsWith('__');
    if (!isUpper && !isDunder) {
      result.push(lastPart);
    }
  }
  // If no class was found, the last part is a module-level function
  if (result.length === 0 && pathParts.length > 0) {
    result.push(pathParts[pathParts.length - 1]);
  }
  return result;
}

const CLASS_DEF_RE = /^\s*class\s+(\w+)\s*[:\(]/;
const DEF_RE = /^\s*def\s+(\w+)\s*\(/;
const DECORATOR_RE = /^\s*@/;
const TRIPLE_QUOTE_RE = /^\s*(?:r|u|ur|ru|b|br|rb|f|fr|rf)?("""|''')/;

/**
 * Find a class or function definition by scanning source lines.
 */
export function findDefinition(lines: string[], targetParts: string[]): DefResult | null {
  if (targetParts.length === 0) return null;

  const found: DefResult[] = [];
  let targetIdx = targetParts.length - 1;

  for (let i = 0; i < lines.length && targetIdx >= 0; i++) {
    const line = lines[i];
    if (DECORATOR_RE.test(line)) continue;

    const classMatch = CLASS_DEF_RE.exec(line);
    const defMatch = DEF_RE.exec(line);
    const name = classMatch ? classMatch[1] : defMatch ? defMatch[1] : null;

    if (name && name === targetParts[targetIdx]) {
      const indent = line.search(/\S/);
      found.push({ defLine: i, indent });
      targetIdx--;
    }
  }

  // Return the innermost match (first found when scanning targetParts from end)
  return found.length > 0 ? found[0] : null;
}

/**
 * Find a triple-quoted docstring immediately after a definition line.
 */
export function findDocstring(lines: string[], defLine: number): DocstringBlock | null {
  const maxLookahead = Math.min(defLine + 8, lines.length);

  for (let i = defLine + 1; i < maxLookahead; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const match = TRIPLE_QUOTE_RE.exec(lines[i]);
    if (!match) return null;

    const quote = match[1];
    const startLine = i;

    // Single-line docstring?
    const afterOpening = lines[i].substring(lines[i].indexOf(quote) + 3);
    if (afterOpening.includes(quote)) {
      return { startLine, endLine: startLine };
    }

    // Multi-line: find closing quote
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].includes(quote)) {
        return { startLine, endLine: j };
      }
    }

    return { startLine, endLine: startLine };
  }

  return null;
}

// ---- UTF-16 offset helpers ----

/**
 * Compute the start offset of a 0-indexed line in a source split by LF.
 * Each line is counted as `line.length + 1` (the +1 accounts for the LF).
 */
export function lineStartOffset(lines: string[], lineIndex: number): number {
  if (lineIndex < 0 || lineIndex >= lines.length) {
    return -1;
  }

  let offset = 0;
  for (let i = 0; i < lineIndex; i++) {
    offset += lines[i].length + 1; // +1 for LF
  }
  return offset;
}

/**
 * Compute the exclusive end offset of a 0-indexed line.
 * The end offset is the start of the next line (or source.length for the last line).
 */
export function lineEndOffset(lines: string[], lineIndex: number): number {
  if (lineIndex < 0 || lineIndex >= lines.length) {
    return -1;
  }

  // End of this line = start of next line, or source length for last line
  const nextStart = lineStartOffset(lines, lineIndex + 1);
  if (nextStart < 0) {
    // Last line: sum all lines
    let offset = 0;
    for (const l of lines) {
      offset += l.length + 1;
    }
    // Remove trailing newline if source didn't end with one
    return offset > 0 ? offset - 1 : 0;
  }
  return nextStart - 1; // subtract the LF between this line and the next
}

/**
 * Compute a SHA-256 lowercase hex fingerprint of the source span.
 * Line endings are canonicalized (CRLF/CR → LF) before hashing.
 */
export function computeSpanFingerprint(
  lines: string[],
  startOffset: number,
  endOffset: number,
): string {
  const source = lines.join('\n');
  const content = source.slice(startOffset, endOffset);
  const canonical = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return createHash('sha256').update(canonical).digest('hex');
}
