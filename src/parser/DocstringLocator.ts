/**
 * Interface for locating docstrings in Python source files.
 * This abstraction allows different parser backends (Tree-sitter, Python AST, etc.)
 * to be used interchangeably.
 */

export interface DocstringLocationRequest {
  /** Absolute path to the Python source file */
  filePath: string;
  /** Dotted object path (e.g., "keri.app.habbing.BaseHab.endorse") */
  objectPath: string;
  /** Line number relative to docstring start (1-indexed) */
  docstringLine: number;
}

export interface DocstringLocationResult {
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
  backend: 'tree-sitter-python' | 'python-ast' | 'custom';
  /** Matched object name (if found) */
  matchedObject?: string;
}

export interface DocstringLocator {
  /**
   * Locate a single docstring and map a relative line to an absolute line.
   */
  locate(request: DocstringLocationRequest): Promise<DocstringLocationResult>;

  /**
   * Locate multiple docstrings in batch.
   * Implementations should optimize by parsing each file only once.
   */
  locateBatch(requests: DocstringLocationRequest[]): Promise<DocstringLocationResult[]>;

  /**
   * Clean up resources (e.g., WASM memory, parser instances).
   * Optional - implementations may manage resources internally.
   */
  dispose?(): void;
}
