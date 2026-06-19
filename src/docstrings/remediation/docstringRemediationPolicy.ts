// src/docstrings/remediation/docstringRemediationPolicy.ts
// Deterministic, static, domain-owned docstring remediation policy.
//
// No VS Code, filesystem, logger, subprocess, model, or network dependency.
// Guidance is authored content — never generated from diagnostic messages.
// All unsupported cases return diagnostic-only.

import type { DiagnosticsIssue } from '../../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DocstringRemediationDisposition =
  | 'manual-guidance'
  | 'diagnostic-only';

export type DocstringRemediationRule =
  | 'normalize-indentation'
  | 'repair-block-quote-boundary'
  | 'repair-definition-list-boundary'
  | 'repair-literal-block-boundary';

export interface DocstringRemediationAssessment {
  readonly disposition: DocstringRemediationDisposition;
  readonly rule?: DocstringRemediationRule;
  readonly title: string;
  readonly guidance: readonly string[];
  readonly validation: 'rerun-sphinx-doctor';
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

const ALLOWLISTED_CATEGORIES: ReadonlySet<string> = new Set([
  'unexpected-indentation',
  'block-quote-unindent',
  'definition-list-unindent',
  'literal-block',
]);

function isEligibleForRemediation(issue: DiagnosticsIssue): boolean {
  return (
    issue.publishDiagnostic === true &&
    issue.mapping.confidence === 'high' &&
    (issue.sourceRange?.anchorKind === 'docstring-line') &&
    ALLOWLISTED_CATEGORIES.has(issue.category)
  );
}

// ---------------------------------------------------------------------------
// Guidance content — static, authored, stable
// ---------------------------------------------------------------------------

const GUIDANCE: Record<DocstringRemediationRule, Omit<DocstringRemediationAssessment, 'rule'>> = {
  'normalize-indentation': {
    disposition: 'manual-guidance',
    title: 'Normalize docstring indentation',
    guidance: [
      'Review indentation of the flagged line relative to the docstring body.',
      'Ensure nested content follows the expected blank-line boundary for the enclosing reStructuredText construct.',
      'Keep content indentation consistent with the surrounding docstring structure.',
      'Rerun Sphinx Doctor after saving the edited docstring.',
    ],
    validation: 'rerun-sphinx-doctor',
  },
  'repair-block-quote-boundary': {
    disposition: 'manual-guidance',
    title: 'Repair block-quote docstring boundary',
    guidance: [
      'Inspect the docstring indentation around block-quote or unindented content.',
      'Confirm that nested block content is separated from the enclosing docstring by a blank line.',
      'Verify that the indentation level of the flagged content matches the expected nesting depth.',
      'Rerun Sphinx Doctor after saving the edited docstring.',
    ],
    validation: 'rerun-sphinx-doctor',
  },
  'repair-definition-list-boundary': {
    disposition: 'manual-guidance',
    title: 'Repair definition-list docstring boundary',
    guidance: [
      'Examine the definition-list item and its surrounding docstring structure.',
      'Confirm that definition terms and definitions are separated by the expected blank-line boundary.',
      'Verify that the indentation of the definition body is consistent with the parent docstring.',
      'Rerun Sphinx Doctor after saving the edited docstring.',
    ],
    validation: 'rerun-sphinx-doctor',
  },
  'repair-literal-block-boundary': {
    disposition: 'manual-guidance',
    title: 'Repair literal-block docstring boundary',
    guidance: [
      'Inspect the literal-block content and its relationship to the enclosing docstring.',
      'Ensure that the literal block is separated from surrounding docstring content by a blank line.',
      'Confirm that the literal-block indentation is consistent and unambiguous.',
      'Rerun Sphinx Doctor after saving the edited docstring.',
    ],
    validation: 'rerun-sphinx-doctor',
  },
};

const DIAGNOSTIC_ONLY: DocstringRemediationAssessment = {
  disposition: 'diagnostic-only',
  title: 'No automated remediation available',
  guidance: [
    'This diagnostic category does not have a deterministic remediation rule.',
    'Review the diagnostic message and manually inspect the flagged docstring location.',
    'Rerun Sphinx Doctor after making any changes.',
  ],
  validation: 'rerun-sphinx-doctor',
};

// ---------------------------------------------------------------------------
// Category → rule mapping (static)
// ---------------------------------------------------------------------------

const CATEGORY_RULE: Readonly<Record<string, DocstringRemediationRule>> = {
  'unexpected-indentation': 'normalize-indentation',
  'block-quote-unindent': 'repair-block-quote-boundary',
  'definition-list-unindent': 'repair-definition-list-boundary',
  'literal-block': 'repair-literal-block-boundary',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assess a published Sphinx Doctor diagnostic for deterministic docstring remediation.
 *
 * Returns `manual-guidance` only for allowlisted layout categories with
 * high-confidence Python docstring mapping. Everything else returns
 * `diagnostic-only`.
 *
 * The result contains static authored guidance — never generated text,
 * and never instructions that imply a single universal edit.
 */
export function assessDocstringRemediation(
  issue: DiagnosticsIssue,
): DocstringRemediationAssessment {
  if (!isEligibleForRemediation(issue)) {
    return DIAGNOSTIC_ONLY;
  }

  const rule = CATEGORY_RULE[issue.category];
  if (!rule) {
    return DIAGNOSTIC_ONLY;
  }

  const base = GUIDANCE[rule];
  return { ...base, rule };
}
