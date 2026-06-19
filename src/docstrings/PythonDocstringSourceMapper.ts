/**
 * Interface for locating docstrings in Python source files.
 * This abstraction allows different parser backends (Tree-sitter, Python AST, etc.)
 * to be used interchangeably.
 */

export interface PythonDocstringSourceMapRequest {
  /** Absolute path to the Python source file */
  filePath: string;
  /** Dotted object path (e.g., "keri.app.habbing.BaseHab.endorse") */
  objectPath: string;
  /** Line number relative to docstring start (1-indexed) */
  docstringLine: number;
}

export interface PythonDocstringSourceMapResult {
  /** Absolute line number in source file (1-indexed) */
  targetLine?: number;
  /** Docstring start line (1-indexed) */
  docstringStartLine?: number;
  /** Docstring end line (1-indexed) */
  docstringEndLine?: number;
  /**
   * Exact UTF-16 code-unit offset of the docstring start (inclusive).
   * Extension-runtime-only — not persisted in diagnostics artifacts.
   * Only populated for high-confidence Python mappings.
   */
  docstringStartOffset?: number;
  /**
   * Exact UTF-16 code-unit offset of the docstring end (exclusive).
   * Extension-runtime-only — not persisted in diagnostics artifacts.
   * Only populated for high-confidence Python mappings.
   */
  docstringEndOffset?: number;
  /**
   * SHA-256 lowercase hex fingerprint of the canonicalized docstring source span.
   * Extension-runtime-only — not persisted in diagnostics artifacts.
   * Only populated for high-confidence Python mappings.
   */
  docstringFingerprint?: string;
  /**
   * Exact UTF-16 code-unit offset of the target diagnostic line start.
   * Extension-runtime-only — not persisted in diagnostics artifacts.
   * Only populated for high-confidence Python mappings.
   */
  targetOffset?: number;
  /** Confidence level of the mapping */
  confidence: 'high' | 'medium' | 'low' | 'unmapped';
  /** Human-readable reason for the confidence level */
  reason: string;
  /** Parser backend identifier */
  backend: 'tree-sitter-python' | 'python-ast' | 'text-scanner' | 'custom';
  /** Matched object name (if found) */
  matchedObject?: string;
}

export interface PythonDocstringSourceMapper {
  /**
   * Map a single docstring-relative line to an absolute source line.
   */
  locate(request: PythonDocstringSourceMapRequest): Promise<PythonDocstringSourceMapResult>;

  /**
   * Map multiple docstrings in batch.
   * Implementations should optimize by parsing each file only once.
   */
  locateBatch(requests: PythonDocstringSourceMapRequest[]): Promise<PythonDocstringSourceMapResult[]>;

  /**
   * Clean up resources (e.g., WASM memory, parser instances).
   * Optional - implementations may manage resources internally.
   */
  dispose?(): void;
}
