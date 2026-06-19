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
