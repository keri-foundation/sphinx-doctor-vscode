import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { Parser, Language, Tree, Node } from 'web-tree-sitter';

import {
  DocstringLocationRequest,
  DocstringLocationResult,
  DocstringLocator,
} from './DocstringLocator';

/**
 * Tree-sitter based docstring locator using WASM Python grammar.
 * This implementation provides accurate Python AST parsing without native compilation.
 */
export class TreeSitterDocstringLocator implements DocstringLocator {
  private parser: Parser | null = null;
  private pythonLanguage: Language | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * Initialize the Tree-sitter parser with Python grammar.
   * This is called lazily on first use and cached.
   */
  private async initialize(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      try {
        // Dynamically import web-tree-sitter to avoid activation failures
        // The module is bundled in the VSIX, not loaded from node_modules at runtime
        const treeSitter = await import('web-tree-sitter');
        
        // Configure WASM file location - both core and Python WASM are in out/wasm/
        const wasmDir = path.join(__dirname, '..', '..', 'wasm');
        
        // Initialize Tree-sitter WASM runtime with locateFile configuration
        await treeSitter.Parser.init({
          locateFile: (scriptName: string) => {
            return path.join(wasmDir, scriptName);
          }
        });

        // Create parser instance
        this.parser = new treeSitter.Parser();

        // Load Python grammar from extension's wasm directory
        const pythonWasmPath = path.join(wasmDir, 'tree-sitter-python.wasm');
        this.pythonLanguage = await treeSitter.Language.load(pythonWasmPath);

        // Set the language for the parser
        if (this.parser) {
          this.parser.setLanguage(this.pythonLanguage);
        }
      } catch (error) {
        this.initPromise = null;
        throw new Error(
          `Failed to initialize Tree-sitter Python parser: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })();

    return this.initPromise;
  }

  /**
   * Parse a Python file and return the syntax tree.
   */
  private async parseFile(filePath: string): Promise<Tree | null> {
    await this.initialize();

    if (!this.parser) {
      return null;
    }

    try {
      const source = await fs.readFile(filePath, 'utf8');
      return this.parser.parse(source);
    } catch (error) {
      return null;
    }
  }

  /**
   * Find a Python object (class/function/method) by its dotted path.
   * Returns the node and its qualified name.
   */
  private findObjectByPath(
    tree: Tree,
    objectPath: string
  ): { node: Node; qualifiedName: string } | null {
    const parts = objectPath.split('.');
    const targetName = parts[parts.length - 1];

    // Manually walk the tree to find class and function definitions
    const candidates: Array<{ node: Node; qualifiedName: string }> = [];
    
    const walkTree = (node: Node, parentPath: string[] = []) => {
      // Check if this is a class or function definition
      if (node.type === 'class_definition' || node.type === 'function_definition') {
        // Find the name child (identifier)
        const nameChild = node.children.find((child: Node) => child.type === 'identifier');
        
        if (nameChild) {
          const currentPath = [...parentPath, nameChild.text];
          const qualifiedName = currentPath.join('.');
          
          // Check if this matches the target (exact or suffix match)
          if (
            qualifiedName === objectPath ||
            qualifiedName.endsWith('.' + objectPath) ||
            objectPath.endsWith('.' + qualifiedName)
          ) {
            candidates.push({ node, qualifiedName });
          }
          
          // Continue walking children with updated path
          for (const child of node.children) {
            walkTree(child, currentPath);
          }
          return;
        }
      }
      
      // Continue walking children with current path
      for (const child of node.children) {
        walkTree(child, parentPath);
      }
    };
    
    walkTree(tree.rootNode);

    // Return the best match (prefer exact match, then shortest suffix match)
    if (candidates.length === 0) {
      return null;
    }

    // Sort by specificity: exact match first, then by qualified name length
    candidates.sort((a, b) => {
      if (a.qualifiedName === objectPath) return -1;
      if (b.qualifiedName === objectPath) return 1;
      return a.qualifiedName.length - b.qualifiedName.length;
    });

    return candidates[0];
  }

  /**
   * Extract docstring from a class or function definition node.
   * Returns the docstring node and its line range.
   */
  private extractDocstring(
    definitionNode: Node
  ): { node: Node; startLine: number; endLine: number } | null {
    // Find the body of the definition
    const bodyNode = definitionNode.children.find((child: Node) => child.type === 'block');

    if (!bodyNode || bodyNode.childCount === 0) {
      return null;
    }

    // The first statement in the body should be the docstring (if present)
    const firstStatement = bodyNode.child(0);

    if (!firstStatement || firstStatement.type !== 'expression_statement') {
      return null;
    }

    // Check if the expression is a string
    const expression = firstStatement.child(0);

    if (!expression || expression.type !== 'string') {
      return null;
    }

    // This is a docstring! Extract line information
    // Tree-sitter uses 0-indexed lines, convert to 1-indexed
    const startLine = expression.startPosition.row + 1;
    const endLine = expression.endPosition.row + 1;

    return {
      node: expression,
      startLine,
      endLine,
    };
  }

  /**
   * Locate a single docstring and map a relative line to an absolute line.
   */
  async locate(request: DocstringLocationRequest): Promise<DocstringLocationResult> {
    const results = await this.locateBatch([request]);
    return results[0];
  }

  /**
   * Locate multiple docstrings in batch.
   * Optimizes by parsing each file only once.
   */
  async locateBatch(requests: DocstringLocationRequest[]): Promise<DocstringLocationResult[]> {
    // Group requests by file path
    const byFile = new Map<string, DocstringLocationRequest[]>();

    for (const request of requests) {
      const existing = byFile.get(request.filePath) || [];
      existing.push(request);
      byFile.set(request.filePath, existing);
    }

    const results: DocstringLocationResult[] = [];

    // Process each file
    for (const [filePath, fileRequests] of byFile) {
      const tree = await this.parseFile(filePath);

      if (!tree) {
        // File couldn't be parsed - return low confidence for all requests
        for (const request of fileRequests) {
          results.push({
            targetLine: request.docstringLine,
            confidence: 'low',
            reason: `Failed to parse Python file: ${filePath}`,
            backend: 'tree-sitter-python',
          });
        }
        continue;
      }

      try {
        // Process each request for this file
        for (const request of fileRequests) {
          const objectResult = this.findObjectByPath(tree, request.objectPath);

          if (!objectResult) {
            results.push({
              targetLine: request.docstringLine,
              confidence: 'low',
              reason: `Could not find object "${request.objectPath}" in ${filePath}`,
              backend: 'tree-sitter-python',
            });
            continue;
          }

          const docstring = this.extractDocstring(objectResult.node);

          if (!docstring) {
            results.push({
              targetLine: objectResult.node.startPosition.row + 1,
              confidence: 'low',
              reason: `Object "${request.objectPath}" found but has no docstring`,
              matchedObject: objectResult.qualifiedName,
              backend: 'tree-sitter-python',
            });
            continue;
          }

          // Calculate the target line
          // Sphinx docstring line is 1-indexed and relative to docstring start
          const targetLine = docstring.startLine + request.docstringLine - 1;

          // Check if the target line is within the docstring bounds
          if (targetLine > docstring.endLine) {
            results.push({
              targetLine: docstring.startLine,
              confidence: 'medium',
              reason: `Docstring line ${request.docstringLine} is outside docstring bounds (lines ${docstring.startLine}-${docstring.endLine})`,
              matchedObject: objectResult.qualifiedName,
              docstringStartLine: docstring.startLine,
              docstringEndLine: docstring.endLine,
              backend: 'tree-sitter-python',
            });
            continue;
          }

          // Success! High confidence mapping
          results.push({
            targetLine,
            confidence: 'high',
            reason: `Mapped to line ${targetLine} in docstring of ${objectResult.qualifiedName} (lines ${docstring.startLine}-${docstring.endLine})`,
            matchedObject: objectResult.qualifiedName,
            docstringStartLine: docstring.startLine,
            docstringEndLine: docstring.endLine,
            backend: 'tree-sitter-python',
          });
        }
      } finally {
        // Clean up the tree to free WASM memory
        tree.delete();
      }
    }

    return results;
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    if (this.parser) {
      this.parser.delete();
      this.parser = null;
    }
    this.pythonLanguage = null;
    this.initPromise = null;
  }
}
