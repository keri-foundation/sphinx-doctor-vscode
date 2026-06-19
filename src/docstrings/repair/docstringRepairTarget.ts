// src/docstrings/repair/docstringRepairTarget.ts
// Durable deterministic Python docstring repair target contract.
//
// A target is materialized only when all eligibility conditions hold.
// Everything else is diagnostic-only — no best-effort path exists.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Exact UTF-16 code-unit source span.
 * `startOffset` is inclusive; `endOffset` is exclusive.
 */
export interface DocstringSourceSpan {
  readonly startOffset: number;
  readonly endOffset: number;
}

/**
 * Verified repair target for one high-confidence Python docstring diagnostic.
 *
 * The fingerprint is a SHA-256 digest of the canonicalized source span content.
 * It allows a future command-backed Quick Fix to re-validate the document before
 * applying any edit: if the current document's span fingerprint differs, the
 * document changed and the edit must be refused.
 */
export interface DocstringRepairTarget {
  readonly language: 'python';
  readonly mappingConfidence: 'high';
  readonly anchorKind: 'docstring-line';
  readonly sourceSpan: DocstringSourceSpan;
  readonly targetOffset: number;
  readonly fingerprint: string;
}

// ---------------------------------------------------------------------------
// Span eligibility
// ---------------------------------------------------------------------------

export function isValidSourceSpan(span: DocstringSourceSpan): boolean {
  return (
    Number.isInteger(span.startOffset) &&
    Number.isInteger(span.endOffset) &&
    span.startOffset >= 0 &&
    span.endOffset > span.startOffset
  );
}

export function offsetIsInSpan(offset: number, span: DocstringSourceSpan): boolean {
  return offset >= span.startOffset && offset < span.endOffset;
}

// ---------------------------------------------------------------------------
// Line-ending canonicalization (fingerprinting only — source is not modified)
// ---------------------------------------------------------------------------

function canonicalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 lowercase hex fingerprint of the canonicalized source span.
 * Input is the exact substring `source.slice(startOffset, endOffset)`.
 */
export function computeDocstringFingerprint(
  source: string,
  span: DocstringSourceSpan,
): string {
  const content = source.slice(span.startOffset, span.endOffset);
  const canonical = canonicalizeLineEndings(content);
  return createHash('sha256').update(canonical).digest('hex');
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface DocstringRepairTargetFactoryInput {
  /** Full Python source text (required unless fingerprint is pre-computed) */
  readonly source?: string;
  /** Pre-computed SHA-256 fingerprint (avoids needing source text) */
  readonly fingerprint?: string;
  /** Exact docstring start offset (inclusive, UTF-16 code units) */
  readonly docstringStartOffset: number;
  /** Exact docstring end offset (exclusive, UTF-16 code units) */
  readonly docstringEndOffset: number;
  /** Mapped target offset (VS Code diagnostic anchor) */
  readonly targetOffset: number;
  /** Must be 'high' */
  readonly mappingConfidence: string;
  /** Must be 'docstring-line' */
  readonly anchorKind: string;
}

/**
 * Create a verified repair target.
 *
 * Returns `undefined` for every ineligible condition.
 *
 * When `fingerprint` is provided (pre-computed by the mapper),
 * source text is not required. Otherwise, source text is used
 * to validate span bounds and compute the fingerprint.
 */
export function createDocstringRepairTarget(
  input: DocstringRepairTargetFactoryInput,
): DocstringRepairTarget | undefined {
  if (input.mappingConfidence !== 'high') {
    return undefined;
  }

  if (input.anchorKind !== 'docstring-line') {
    return undefined;
  }

  const span: DocstringSourceSpan = {
    startOffset: input.docstringStartOffset,
    endOffset: input.docstringEndOffset,
  };

  if (!isValidSourceSpan(span)) {
    return undefined;
  }

  if (!offsetIsInSpan(input.targetOffset, span)) {
    return undefined;
  }

  let fingerprint: string;
  if (input.fingerprint !== undefined) {
    // Pre-computed fingerprint — trust the mapper
    fingerprint = input.fingerprint;
  } else if (input.source !== undefined && input.source.length > 0) {
    if (span.endOffset > input.source.length) {
      return undefined;
    }
    fingerprint = computeDocstringFingerprint(input.source, span);
  } else {
    return undefined;
  }

  return {
    language: 'python',
    mappingConfidence: 'high',
    anchorKind: 'docstring-line',
    sourceSpan: span,
    targetOffset: input.targetOffset,
    fingerprint,
  };
}
