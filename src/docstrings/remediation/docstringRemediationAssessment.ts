// src/docstrings/remediation/docstringRemediationAssessment.ts
// Pure assessment entry point.
// Re-exports the policy and assessment types for external consumers.

export {
  assessDocstringRemediation,
  type DocstringRemediationAssessment,
  type DocstringRemediationDisposition,
  type DocstringRemediationRule,
} from './docstringRemediationPolicy';
