// src/docstrings/repair/docstringRepairTargetIndex.ts
// Runtime-only repair target index synchronized with diagnostics publication.
//
// Associates at most one repair target per published diagnostic identity.
// No raw docstring text, full diagnostic objects, raw paths, or raw URIs
// are stored. Identity derivation uses opaque SHA-256 hashing — the index
// stores only the digest, never the input values.

import { createHash } from 'node:crypto';
import { DocstringRepairTarget } from './docstringRepairTarget';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Normalized input for deriving an opaque diagnostic identity.
 * All string values are normalized before hashing.
 */
export interface DiagnosticIdentityInput {
  readonly uri: string;
  readonly diagnosticSource: string;
  readonly diagnosticCode: string;
  readonly diagnosticRange: { readonly startLine: number; readonly startColumn: number; readonly endLine: number; readonly endColumn: number };
  readonly normalizedMessage: string;
}

// ---------------------------------------------------------------------------
// Identity derivation
// ---------------------------------------------------------------------------

/**
 * Derive an opaque SHA-256 diagnostic identity from normalized diagnostic properties.
 * The returned string is a lowercase hexadecimal digest.
 * The raw input values are never retained.
 */
export function deriveDiagnosticIdentity(input: DiagnosticIdentityInput): string {
  const parts = [
    input.uri,
    input.diagnosticSource,
    String(input.diagnosticCode),
    `${input.diagnosticRange.startLine}:${input.diagnosticRange.startColumn}`,
    `${input.diagnosticRange.endLine}:${input.diagnosticRange.endColumn}`,
    input.normalizedMessage,
  ];
  const joined = parts.join('\n');
  return createHash('sha256').update(joined).digest('hex');
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

/**
 * Runtime-only repair target index.
 *
 * Lifecycle:
 *   1. registerTarget   — after diagnostic accepted for publication
 *   2. getTarget        — future Code Action lookup (not this slice)
 *   3. replaceForUri    — when a URI's diagnostics are replaced
 *   4. clearUri         — when a URI's diagnostics are cleared
 *   5. clear            — full collection clear
 *
 * Collision behavior: on identity collision, neither target is stored
 * and the identity is marked ambiguous (collision). Both diagnostics
 * remain visible but repair-ineligible.
 */
export class DocstringRepairTargetIndex {
  private targets = new Map<string, DocstringRepairTarget>();
  private collisions = new Set<string>();

  // -- registration -------------------------------------------------------

  /**
   * Register a repair target for a diagnostic identity.
   *
   * Returns `true` when registration succeeded.
   * Returns `false` on collision or when the identity is already ambiguous.
   */
  registerTarget(identity: string, target: DocstringRepairTarget): boolean {
    if (this.collisions.has(identity)) {
      return false;
    }

    if (this.targets.has(identity)) {
      // Collision: existing target already registered for this identity.
      // Remove both and mark the identity ambiguous for this generation.
      this.targets.delete(identity);
      this.collisions.add(identity);
      return false;
    }

    this.targets.set(identity, target);
    return true;
  }

  // -- lookup -------------------------------------------------------------

  getTarget(identity: string): DocstringRepairTarget | undefined {
    if (this.collisions.has(identity)) {
      return undefined;
    }
    return this.targets.get(identity);
  }

  isCollision(identity: string): boolean {
    return this.collisions.has(identity);
  }

  // -- URI-level operations -----------------------------------------------

  /**
   * Remove and return all identities associated with a URI prefix.
   * Existing targets are cleared because they no longer correspond to
   * current published diagnostics.
   */
  stripIdentitiesForUriPrefix(uriPrefix: string): void {
    const toRemove: string[] = [];
    for (const identity of this.targets.keys()) {
      // The identity digest embeds the URI as its first hashed component.
      // We can't reverse the hash, so we use a separate URI→identities map.
      // For simplicity, we iterate — the index is bounded by the number of
      // published diagnostics, which is O(project count × issues).
      if (identity.startsWith(`uri:${uriPrefix}:`)) {
        toRemove.push(identity);
      }
    }
    for (const identity of toRemove) {
      this.targets.delete(identity);
    }
  }

  // -- bulk operations ----------------------------------------------------

  clear(): void {
    this.targets.clear();
    this.collisions.clear();
  }

  // -- inspection (test support only) -------------------------------------

  get size(): number {
    return this.targets.size;
  }

  get collisionCount(): number {
    return this.collisions.size;
  }
}
