import * as fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Result of mapping a docstring warning to an absolute source location.
 */
export interface DocstringMapping {
  /** Absolute line number in the source file (1-indexed) */
  absoluteLine: number;
  /** Confidence level of the mapping */
  confidence: 'high' | 'medium' | 'low';
  /** Human-readable reason for the confidence level */
  reason: string;
  /** The matched object name (e.g., "BaseHab.endorse") */
  matchedObject?: string;
  /** Docstring start line (1-indexed) */
  docstringStartLine?: number;
  /** Docstring end line (1-indexed) */
  docstringEndLine?: number;
}

/**
 * Python AST node types that can have docstrings.
 */
interface PythonASTNode {
  type: 'FunctionDef' | 'AsyncFunctionDef' | 'ClassDef' | 'Module';
  name?: string;
  lineno: number;
  end_lineno?: number;
  body: PythonASTNode[];
  docstring?: {
    lineno: number;
    end_lineno: number;
  };
}

/**
 * Parse Python source code and extract AST structure with docstring locations.
 * This is a simplified parser that extracts only the information we need.
 */
function parsePythonAST(source: string): PythonASTNode {
  const lines = source.split('\n');
  const root: PythonASTNode = {
    type: 'Module',
    lineno: 1,
    body: [],
  };

  const stack: PythonASTNode[] = [root];
  let currentIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineno = i + 1;
    
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) {
      continue;
    }

    // Calculate indentation level
    const indent = line.search(/\S/);
    
    // Pop stack until we find parent at correct indentation
    while (stack.length > 1 && indent <= currentIndent) {
      stack.pop();
      currentIndent = Math.max(0, currentIndent - 4);
    }

    // Check for class definition
    const classMatch = line.match(/^(\s*)class\s+(\w+)/);
    if (classMatch) {
      const node: PythonASTNode = {
        type: 'ClassDef',
        name: classMatch[2],
        lineno,
        body: [],
      };
      stack[stack.length - 1].body.push(node);
      stack.push(node);
      currentIndent = indent;
      continue;
    }

    // Check for function definition
    const funcMatch = line.match(/^(\s*)(async\s+)?def\s+(\w+)/);
    if (funcMatch) {
      const node: PythonASTNode = {
        type: funcMatch[2] ? 'AsyncFunctionDef' : 'FunctionDef',
        name: funcMatch[3],
        lineno,
        body: [],
      };
      stack[stack.length - 1].body.push(node);
      stack.push(node);
      currentIndent = indent;
      continue;
    }

    // Check for docstring (triple-quoted string as first statement)
    const docstringMatch = line.match(/^(\s*)("""|''')/);
    if (docstringMatch && stack[stack.length - 1].body.length === 0) {
      const quote = docstringMatch[2];
      let endLineno = lineno;
      
      // Find closing quote
      if (!line.includes(quote, line.indexOf(quote) + 3)) {
        // Multi-line docstring
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].includes(quote)) {
            endLineno = j + 1;
            i = j;
            break;
          }
        }
      }
      
      stack[stack.length - 1].docstring = {
        lineno,
        end_lineno: endLineno,
      };
    }
  }

  return root;
}

/**
 * Find a Python object by its dotted path (e.g., "BaseHab.endorse").
 */
function findObjectByPath(
  root: PythonASTNode,
  objectPath: string
): PythonASTNode | null {
  const parts = objectPath.split('.');
  
  // Try to find the object by matching the suffix of the path
  function search(node: PythonASTNode, pathParts: string[]): PythonASTNode | null {
    if (pathParts.length === 0) {
      return node;
    }

    const targetName = pathParts[pathParts.length - 1];
    
    // Search in current node's body
    for (const child of node.body) {
      if (child.name === targetName) {
        if (pathParts.length === 1) {
          return child;
        }
        // Continue searching in this child
        const result = search(child, pathParts.slice(0, -1));
        if (result) {
          return result;
        }
      }
    }

    // Recursively search all children
    for (const child of node.body) {
      const result = search(child, pathParts);
      if (result) {
        return result;
      }
    }

    return null;
  }

  return search(root, parts);
}

/**
 * Map a docstring-relative line number to an absolute source line number.
 * 
 * @param filePath - Absolute path to the Python source file
 * @param objectPath - Dotted path to the object (e.g., "keri.app.habbing.BaseHab.endorse")
 * @param docstringLine - Line number relative to the docstring start (1-indexed)
 * @returns Mapping result with absolute line number and confidence
 */
export async function mapDocstringLine(
  filePath: string,
  objectPath: string,
  docstringLine: number
): Promise<DocstringMapping | null> {
  try {
    const source = await fs.readFile(filePath, 'utf8');
    const ast = parsePythonAST(source);
    
    // Find the object in the AST
    const obj = findObjectByPath(ast, objectPath);
    
    if (!obj) {
      return {
        absoluteLine: docstringLine,
        confidence: 'low',
        reason: `Could not find object "${objectPath}" in AST`,
      };
    }

    if (!obj.docstring) {
      return {
        absoluteLine: obj.lineno,
        confidence: 'low',
        reason: `Object "${objectPath}" found but has no docstring`,
        matchedObject: obj.name,
      };
    }

    // Calculate absolute line number
    const absoluteLine = obj.docstring.lineno + docstringLine - 1;
    
    // Check if the line is within the docstring bounds
    if (absoluteLine > obj.docstring.end_lineno) {
      return {
        absoluteLine: obj.docstring.lineno,
        confidence: 'medium',
        reason: `Docstring line ${docstringLine} is outside docstring bounds (lines ${obj.docstring.lineno}-${obj.docstring.end_lineno})`,
        matchedObject: obj.name,
        docstringStartLine: obj.docstring.lineno,
        docstringEndLine: obj.docstring.end_lineno,
      };
    }

    return {
      absoluteLine,
      confidence: 'high',
      reason: `Mapped to line ${absoluteLine} in docstring of ${obj.name} (lines ${obj.docstring.lineno}-${obj.docstring.end_lineno})`,
      matchedObject: obj.name,
      docstringStartLine: obj.docstring.lineno,
      docstringEndLine: obj.docstring.end_lineno,
    };
  } catch (error) {
    return {
      absoluteLine: docstringLine,
      confidence: 'low',
      reason: `Failed to parse Python file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Batch map multiple docstring warnings to absolute line numbers.
 * This is more efficient than calling mapDocstringLine multiple times
 * because it reads each file only once.
 */
export async function mapDocstringLines(
  mappings: Array<{
    filePath: string;
    objectPath: string;
    docstringLine: number;
  }>
): Promise<DocstringMapping[]> {
  // Group by file path to avoid reading the same file multiple times
  const byFile = new Map<string, typeof mappings>();
  
  for (const mapping of mappings) {
    const existing = byFile.get(mapping.filePath) || [];
    existing.push(mapping);
    byFile.set(mapping.filePath, existing);
  }

  const results: DocstringMapping[] = [];

  for (const [filePath, fileMappings] of byFile) {
    try {
      const source = await fs.readFile(filePath, 'utf8');
      const ast = parsePythonAST(source);

      for (const mapping of fileMappings) {
        const obj = findObjectByPath(ast, mapping.objectPath);
        
        if (!obj) {
          results.push({
            absoluteLine: mapping.docstringLine,
            confidence: 'low',
            reason: `Could not find object "${mapping.objectPath}" in AST`,
          });
          continue;
        }

        if (!obj.docstring) {
          results.push({
            absoluteLine: obj.lineno,
            confidence: 'low',
            reason: `Object "${mapping.objectPath}" found but has no docstring`,
            matchedObject: obj.name,
          });
          continue;
        }

        const absoluteLine = obj.docstring.lineno + mapping.docstringLine - 1;
        
        if (absoluteLine > obj.docstring.end_lineno) {
          results.push({
            absoluteLine: obj.docstring.lineno,
            confidence: 'medium',
            reason: `Docstring line ${mapping.docstringLine} is outside docstring bounds (lines ${obj.docstring.lineno}-${obj.docstring.end_lineno})`,
            matchedObject: obj.name,
            docstringStartLine: obj.docstring.lineno,
            docstringEndLine: obj.docstring.end_lineno,
          });
          continue;
        }

        results.push({
          absoluteLine,
          confidence: 'high',
          reason: `Mapped to line ${absoluteLine} in docstring of ${obj.name} (lines ${obj.docstring.lineno}-${obj.docstring.end_lineno})`,
          matchedObject: obj.name,
          docstringStartLine: obj.docstring.lineno,
          docstringEndLine: obj.docstring.end_lineno,
        });
      }
    } catch (error) {
      // If file read fails, return low-confidence mappings for all items in this file
      for (const mapping of fileMappings) {
        results.push({
          absoluteLine: mapping.docstringLine,
          confidence: 'low',
          reason: `Failed to parse Python file: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  return results;
}
