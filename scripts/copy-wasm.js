#!/usr/bin/env node

/**
 * Cross-platform script to copy Tree-sitter WASM files to output directory.
 * This copies both the core runtime and Python grammar WASM files.
 */

const fs = require('fs');
const path = require('path');

const CORE_WASM_SOURCE = path.join(__dirname, '..', 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm');
const PYTHON_WASM_SOURCE = path.join(__dirname, '..', 'node_modules', 'tree-sitter-wasms', 'out', 'tree-sitter-python.wasm');
const OUTPUT_DIR = path.join(__dirname, '..', 'out', 'wasm');
const CORE_WASM_OUTPUT = path.join(OUTPUT_DIR, 'web-tree-sitter.wasm');
const PYTHON_WASM_OUTPUT = path.join(OUTPUT_DIR, 'tree-sitter-python.wasm');

function main() {
  console.log('Copying Tree-sitter WASM files...');
  
  // Check if source WASM files exist
  if (!fs.existsSync(CORE_WASM_SOURCE)) {
    console.error(`ERROR: Core WASM file not found at ${CORE_WASM_SOURCE}`);
    console.error('Please run "npm install" to install web-tree-sitter package.');
    process.exit(1);
  }
  
  if (!fs.existsSync(PYTHON_WASM_SOURCE)) {
    console.error(`ERROR: Python WASM file not found at ${PYTHON_WASM_SOURCE}`);
    console.error('Please run "npm install" to install tree-sitter-wasms package.');
    process.exit(1);
  }
  
  // Create output directory if it doesn't exist
  if (!fs.existsSync(OUTPUT_DIR)) {
    console.log(`Creating output directory: ${OUTPUT_DIR}`);
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  
  // Copy core WASM file
  console.log(`Copying ${CORE_WASM_SOURCE} to ${CORE_WASM_OUTPUT}`);
  fs.copyFileSync(CORE_WASM_SOURCE, CORE_WASM_OUTPUT);
  
  // Verify core copy succeeded
  if (!fs.existsSync(CORE_WASM_OUTPUT)) {
    console.error(`ERROR: Failed to copy core WASM file to ${CORE_WASM_OUTPUT}`);
    process.exit(1);
  }
  
  const coreStats = fs.statSync(CORE_WASM_OUTPUT);
  console.log(`✓ Successfully copied web-tree-sitter.wasm (${coreStats.size} bytes)`);
  
  // Copy Python WASM file
  console.log(`Copying ${PYTHON_WASM_SOURCE} to ${PYTHON_WASM_OUTPUT}`);
  fs.copyFileSync(PYTHON_WASM_SOURCE, PYTHON_WASM_OUTPUT);
  
  // Verify Python copy succeeded
  if (!fs.existsSync(PYTHON_WASM_OUTPUT)) {
    console.error(`ERROR: Failed to copy Python WASM file to ${PYTHON_WASM_OUTPUT}`);
    process.exit(1);
  }
  
  const pythonStats = fs.statSync(PYTHON_WASM_OUTPUT);
  console.log(`✓ Successfully copied tree-sitter-python.wasm (${pythonStats.size} bytes)`);
}

main();
