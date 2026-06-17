import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseSphinxWarnings } from '../src/parser/SphinxWarningParser';
import {
  ConfiguredProject,
  DiagnosticsIssue,
  issueMatchesDiagnosticMode,
  shouldPublishIssue,
} from '../src/types';
import {
  SELF_TEST_STATUS_TEXT,
} from '../src/selfTest';
import {
  selectInventoryCandidate,
} from '../src/workspace';

const configuredProject: ConfiguredProject = {
  id: 'keripy',
  label: 'keripy',
  sourceWorkspaceFolder: '02-keripy',
  inventoryWorkspaceFolder: 'example-workspace',
  repoRoot: '.',
  docsRoot: 'docs',
  inventorySearchGlobs: [
    'tmp/sphinx-inventory-keripy-sphinx-unexpected-indentation-batch-01-*/report/issues.vscode.json',
    'tmp/sphinx-inventory-keripy-sphinx-unexpected-indentation-batch-01-*/report/issues.json',
  ],
  preferredInventoryFiles: ['issues.vscode.json', 'issues.json'],
  mirrorRoot: '.sphinx-diagnostics',
};

let cachedWatchModeModule: typeof import('../src/watchMode.js') | undefined;

async function loadWatchModeModule(): Promise<typeof import('../src/watchMode.js')> {
  if (cachedWatchModeModule) {
    return cachedWatchModeModule;
  }

  const moduleLoader = require('node:module') as typeof import('node:module') & {
    _load?: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
  };
  const originalLoad = moduleLoader._load;
  assert.ok(originalLoad, 'Expected node module loader to be available for vscode stubbing.');

  moduleLoader._load = ((request: string, parent: NodeModule | undefined, isMain: boolean) => {
    if (request === 'vscode') {
      return {
        ExtensionMode: {
          Production: 1,
          Development: 2,
          Test: 3,
        },
      };
    }

    return originalLoad(request, parent, isMain);
  }) as typeof originalLoad;

  try {
    const module = await import('../src/watchMode.js');
    cachedWatchModeModule = module;
    return module;
  } finally {
    moduleLoader._load = originalLoad;
  }
}

test('troubleshoot report includes extension mode and extension path', async () => {
  const { buildTroubleshootReport } = await loadWatchModeModule();
  const report = buildTroubleshootReport({
    extensionMode: 2,
    extensionPath: '/workspace/extensions/sphinx-doctor-vscode',
    isWorkspaceTrusted: true,
    config: {
      projects: [configuredProject],
      defaultSourceWorkspaceFolder: '02-keripy',
      diagnosticsMode: 'layout',
      pythonInterpreter: 'python3',
      enrichmentEnabled: true,
      enrichmentAutoRun: false,
      discoveryEnabled: true,
      discoveryIncludeLowConfidence: false,
      discoveryInventoryWorkspaceFolderNames: ['example-workspace'],
      discoveryExcludeWorkspaceFolders: [],
      watchEnabled: true,
      watchAutoLoadOnStartup: true,
      refreshAutoRunOnStartup: false,
      refreshAutoRunOnSave: false,
      refreshDebounceMs: 1500,
      watchDebounceMs: 750,
      logLevel: 'info',
      directRunEnabled: true,
      sphinxCommand: 'sphinx-build',
      sphinxBuilder: 'dirhtml',
      sphinxSourceDir: 'docs',
      sphinxOutputDir: '.tmp/sphinx-doctor/dirhtml',
      sphinxWarningFile: '.tmp/sphinx-doctor/warnings.log',
      sphinxExtraArgs: [],
    },
    state: {
      activated: true,
      workspaceFolders: ['example-workspace', '02-keripy'],
      configuredProjects: ['keripy'],
      discoveredProjects: ['keripy'],
      knownProjects: ['keripy'],
      lastRefreshReason: 'activation',
      lastLoadedDiagnosticsFiles: ['/workspace/notes/libs/keripy/.sphinx-diagnostics/latest.json'],
      lastIssueCount: 398,
      lastPublishableBeforeFilterCount: 256,
      lastPublishedCount: 194,
      lastFilteredByModeCount: 62,
      lastSkippedCount: 142,
      lastResolutionFailureCount: 3,
      lastRawPendingCount: 1,
      lastErrorCount: 0,
      summary: {
        state: 'watching',
        projectCount: 1,
        issueCount: 398,
        publishableBeforeFilter: 256,
        publishedDiagnostics: 194,
        watcherCount: 4,
        diagnosticMode: 'layout',
        message: 'Watching 1 project.',
      },
      projectStatuses: [['keripy', 'loaded latest.json with 398 issues.']],
    },
  });

  assert.match(report, /Extension mode: Development/);
  assert.match(report, /Extension path: \/workspace\/extensions\/sphinx-doctor-vscode/);
});

test('troubleshoot report includes workspace trust, refresh-on-save, and diagnostics counts', async () => {
  const { buildTroubleshootReport } = await loadWatchModeModule();
  const report = buildTroubleshootReport({
    extensionMode: 3,
    extensionPath: '/workspace/extensions/sphinx-doctor-vscode',
    isWorkspaceTrusted: false,
    config: {
      projects: [configuredProject, {
        id: 'hio',
        label: 'hio',
        sourceWorkspaceFolder: '03-hio',
        inventoryWorkspaceFolder: 'example-workspace',
        repoRoot: '.',
        docsRoot: 'docs',
        inventorySearchGlobs: ['tmp/sphinx-inventory-hio-*/report/issues.vscode.json'],
        preferredInventoryFiles: ['issues.vscode.json', 'issues.json'],
        mirrorRoot: '.sphinx-diagnostics',
      }],
      defaultSourceWorkspaceFolder: '02-keripy',
      diagnosticsMode: 'reference',
      pythonInterpreter: 'python3',
      enrichmentEnabled: true,
      enrichmentAutoRun: false,
      discoveryEnabled: true,
      discoveryIncludeLowConfidence: false,
      discoveryInventoryWorkspaceFolderNames: ['example-workspace'],
      discoveryExcludeWorkspaceFolders: ['example-ops-workspace'],
      watchEnabled: true,
      watchAutoLoadOnStartup: true,
      refreshAutoRunOnStartup: false,
      refreshAutoRunOnSave: false,
      refreshDebounceMs: 1500,
      watchDebounceMs: 750,
      logLevel: 'debug',
      directRunEnabled: true,
      sphinxCommand: 'sphinx-build',
      sphinxBuilder: 'dirhtml',
      sphinxSourceDir: 'docs',
      sphinxOutputDir: '.tmp/sphinx-doctor/dirhtml',
      sphinxWarningFile: '.tmp/sphinx-doctor/warnings.log',
      sphinxExtraArgs: [],
    },
    state: {
      activated: true,
      workspaceFolders: ['example-workspace', '02-keripy', '03-hio'],
      configuredProjects: ['keripy'],
      discoveredProjects: ['hio'],
      knownProjects: ['keripy', 'hio'],
      lastRefreshReason: 'saved conf.py',
      lastLoadedDiagnosticsFiles: ['/workspace/notes/libs/keripy/.sphinx-diagnostics/latest.json'],
      lastIssueCount: 451,
      lastPublishableBeforeFilterCount: 204,
      lastPublishedCount: 194,
      lastFilteredByModeCount: 10,
      lastSkippedCount: 257,
      lastResolutionFailureCount: 2,
      lastRawPendingCount: 1,
      lastErrorCount: 1,
      lastError: 'example failure',
      summary: {
        state: 'error',
        projectCount: 2,
        issueCount: 451,
        publishableBeforeFilter: 204,
        publishedDiagnostics: 194,
        watcherCount: 6,
        diagnosticMode: 'reference',
        message: 'Sphinx Doctor watch mode hit an error. Check the output channel.',
      },
      projectStatuses: [['keripy', 'loaded latest.json with 451 issues.']],
    },
  });

  assert.match(report, /Workspace trusted: false/);
  assert.match(report, /Refresh on save: false/);
  assert.match(report, /Total issues: 451/);
  assert.match(report, /Publishable before filter: 204/);
  assert.match(report, /Published diagnostics: 194/);
  assert.match(report, /Filtered by mode: 10/);
  assert.match(report, /Skipped issues: 257/);
  assert.match(report, /URI resolution failures: 2/);
  assert.match(report, /Raw pending projects: 1/);
  assert.match(report, /Errors: 1/);
});

test('development and test status-bar badges appear in normal summary text', async () => {
  const { applyExtensionModeBadge } = await loadWatchModeModule();

  assert.equal(applyExtensionModeBadge('Sphinx Doctor: 398 issues', 2), 'Sphinx Doctor (Dev): 398 issues');
  assert.equal(applyExtensionModeBadge('Sphinx Doctor: idle', 3), 'Sphinx Doctor (Test): idle');
  assert.equal(applyExtensionModeBadge('Sphinx Doctor: no diagnostics', 1), 'Sphinx Doctor: no diagnostics');
});

test('development and test status-bar badges are preserved for self-test and manual-like statuses', async () => {
  const { applyExtensionModeBadge } = await loadWatchModeModule();

  assert.equal(
    applyExtensionModeBadge(SELF_TEST_STATUS_TEXT, 2),
    'Sphinx Doctor (Dev): self-test diagnostic published',
  );
  assert.equal(
    applyExtensionModeBadge('Sphinx Doctor: diagnostics cleared.', 3),
    'Sphinx Doctor (Test): diagnostics cleared.',
  );
});

test('selectInventoryCandidate prefers issues.vscode.json over issues.json for matching projects', () => {
  const result = selectInventoryCandidate(
    configuredProject,
    [
      {
        filePath: '/workspace/notes/tmp/sphinx-inventory-keripy-001/report/issues.json',
        fileName: 'issues.json',
        directoryPath: '/workspace/notes/tmp/sphinx-inventory-keripy-001/report',
        modifiedTime: 100,
      },
      {
        filePath: '/workspace/notes/tmp/sphinx-inventory-keripy-001/report/issues.vscode.json',
        fileName: 'issues.vscode.json',
        directoryPath: '/workspace/notes/tmp/sphinx-inventory-keripy-001/report',
        modifiedTime: 100,
      },
    ],
    ['issues.vscode.json', 'issues.json'],
  );

  assert.equal(result.selected?.fileName, 'issues.vscode.json');
});

test('selectInventoryCandidate reports ambiguity instead of silently guessing', () => {
  const ambiguousProject = {
    ...configuredProject,
    id: 'keripy-sphinx-cleanup',
    label: 'keripy sphinx cleanup',
    sourceWorkspaceFolder: '13-keripy-sphinx-batch-01',
  };

  const result = selectInventoryCandidate(
    ambiguousProject,
    [
      {
        filePath: '/workspace/notes/tmp/sphinx-inventory-keripy-sphinx-unexpected-indentation-batch-01-a/report/issues.vscode.json',
        fileName: 'issues.vscode.json',
        directoryPath: '/workspace/notes/tmp/sphinx-inventory-keripy-sphinx-unexpected-indentation-batch-01-a/report',
        modifiedTime: 100,
      },
      {
        filePath: '/workspace/notes/tmp/sphinx-inventory-keripy-sphinx-unexpected-indentation-batch-01-b/report/issues.vscode.json',
        fileName: 'issues.vscode.json',
        directoryPath: '/workspace/notes/tmp/sphinx-inventory-keripy-sphinx-unexpected-indentation-batch-01-b/report',
        modifiedTime: 100,
      },
    ],
    ['issues.vscode.json', 'issues.json'],
  );

  assert.equal(result.selected, undefined);
  assert.equal(result.ambiguous?.length, 2);
});

test('parseSphinxWarnings returns issues even when docstring text mapper cannot read source', async () => {
  // TextPythonDocstringSourceMapper replaces WASM Tree-sitter. When source files are not
  // accessible (e.g. test paths), docstring warnings get low confidence and
  // are retained but not published to Problems.

  const sphinxLogLines = [
    '/repo/src/keri/core/eventing.py:docstring of keri.core.eventing.kevery:7: ERROR: Unexpected indentation. [docutils]',
    '/repo/src/keri/core/eventing.py:42: WARNING: Block quote ends without a blank line [docutils]',
    'WARNING: Some global warning [docutils]',
    '',
  ];

  const result = await parseSphinxWarnings({
    warningFileContent: sphinxLogLines.join('\n'),
    repoRoot: '/repo',
    sourceWorkspaceFolder: 'test-workspace',
  });

  assert.ok(result.issues.length > 0, 'should have issues even when source files are not readable');
  assert.equal(result.astDegraded, false, 'text mapper does not degrade on missing files — returns low confidence instead');
  assert.equal(result.unparsedCount, 1, 'blank trailing line counts as unparsed');
  assert.equal(result.unmappedCount, 1, 'global warning should be unmapped');

  // Docstring warning: present but low confidence (file not readable)
  const docstringIssue = result.issues.find((issue) => issue.repoRelativePath?.includes('eventing.py') && issue.category === 'docutils');
  assert.ok(docstringIssue, 'docstring warning should still be an issue');
  assert.equal(docstringIssue!.mapping.confidence, 'low', 'unreadable file should give low confidence');
  assert.equal(docstringIssue!.publishDiagnostic, false,
    'low-confidence docstring mapping should not publish to Problems');
  assert.equal(result.unsafeDocstringFallbackCount, 1,
    'unsafeDocstringFallbackCount should count the retained docstring issue');

  // Located warnings (non-docstring) should be suppressed from direct-run Problems
  const locatedIssue = result.issues.find((issue) => issue.category === 'docutils' && issue.mapping.strategy === 'sphinx-warning-file');
  assert.ok(locatedIssue, 'standard located warning should be present');
  assert.equal(locatedIssue!.publishDiagnostic, false,
    'standard file:line warnings should be suppressed from direct-run Problems');
  assert.equal(result.suppressedNonDocstringCount, 1,
      'suppressedNonDocstringCount should count the file:line warning');
});

test('direct-run diagnostics would be filtered by layout mode without override', () => {
  // Direct-run issues have category 'docutils', which layout mode does not pass.
  // The fix: applyDiagnosticModeFilter=false in publishDiagnostics bypasses this.
  const docutilsShape = {
    category: 'docutils',
    code: 'docutils',
    message: 'Unexpected indentation. [docutils]',
  };

  assert.equal(issueMatchesDiagnosticMode(docutilsShape, 'layout'), false,
    'docutils category should NOT pass layout — direct-run was 0-published because of this');
  assert.equal(issueMatchesDiagnosticMode(docutilsShape, 'full'), true,
    'docutils should pass full mode');
  assert.equal(issueMatchesDiagnosticMode(docutilsShape, 'reference'), false,
    'docutils should not pass reference mode');

  // Verify that the 'unexpected-indentation' category (from artifact/enriched diagnostics) DOES pass layout
  assert.equal(issueMatchesDiagnosticMode({ category: 'unexpected-indentation', code: 'docutils.unexpected-indentation', message: 'Unexpected indentation.' }, 'layout'), true,
    'unexpected-indentation should pass layout — this is the existing artifact behavior we preserve');
});

test('direct-run bypass: docutils issue is only filtered by issueMatchesDiagnosticMode, not by shouldPublishIssue', () => {
  // Regression for SPHINX-DOCTOR-014: publishDiagnosticsBatch used Pick<> that excluded
  // applyDiagnosticModeFilter, so the direct-run bypass was silently dropped.
  // This test verifies the pure-function decision points that control publication:
  //   1. shouldPublishIssue: checks publishDiagnostic, repoRelativePath, sourceRange
  //   2. issueMatchesDiagnosticMode: checks category against mode allowlist
  // The bypass (applyDiagnosticModeFilter=false) skips step 2 for direct-run.

  const docutilsIssue = {
    id: 'bypass-test-1',
    category: 'docutils',
    code: 'docutils',
    message: 'Unexpected indentation. [docutils]',
    severity: 'warning',
    repoRelativePath: 'src/keri/app/habbing.py',
    sourceWorkspaceFolder: '02-keripy',
    sourceRange: { startLine: 7, startColumn: 1, endLine: 7, endColumn: 1, anchorKind: 'line' },
    publishDiagnostic: true,
  } as unknown as DiagnosticsIssue;

  // Step 1: shouldPublishIssue — direct-run issues pass this gate
  assert.equal(shouldPublishIssue(docutilsIssue), true,
    'direct-run docutils issue should pass shouldPublishIssue (has path, range, publishDiagnostic)');

  // Step 2: issueMatchesDiagnosticMode — blocks in layout mode (this is correct)
  assert.equal(issueMatchesDiagnosticMode(docutilsIssue, 'layout'), false,
    'docutils should be blocked by layout mode at the pure-function level');

  // Step 2 with bypass: the caller skips issueMatchesDiagnosticMode when applyDiagnosticModeFilter=false
  // This is what the Pick<> bug was silently preventing.

  // Verify the skip-reason tracking contract: when an issue is mode-filtered,
  // the skipReasons counter should reflect 'mode-filtered', not 'not-publishable' or 'no-target-uri'.
  // This ensures the diagnostic logging added in SPHINX-DOCTOR-013 correctly attributes skips.
});

test('direct-run parser suppresses .rst/.md/docs warnings and publishes only Python docstring diagnostics', async () => {
  // SPHINX-DOCTOR-016: direct-run Problems scope is Python docstring only.
  // .rst, .md, and other non-docstring warnings should be retained for
  // accounting but not published to Problems.
  const sphinxLogLines = [
    // Python docstring warning — should be a Problems candidate (with safe mapping)
    '/repo/src/keri/app/habbing.py:docstring of keri.app.habbing.BaseHab.endorse:7: ERROR: Unexpected indentation. [docutils]',
    // .rst docs warning — should be suppressed from Problems
    '/repo/docs/keri_app.rst:55: WARNING: more than one target found [ref.python]',
    // .md docs warning — should be suppressed from Problems
    '/repo/docs/ref/tel.md:145: WARNING: Lexing literal_block failed [misc.highlighting_failure]',
    // Standard file:line on a .py file — should be suppressed (not docstring-backed)
    '/repo/src/keri/core/eventing.py:42: WARNING: Block quote ends without a blank line [docutils]',
  ];

  const result = await parseSphinxWarnings({
    warningFileContent: sphinxLogLines.join('\n'),
    repoRoot: '/repo',
    sourceWorkspaceFolder: 'test-workspace',
  });

  // All 4 lines should parse into issues
  assert.equal(result.issues.length, 4, 'should parse all 4 warnings');

  // Docstring warning: present, but publishDiagnostic depends on AST mapping
  const docstringIssue = result.issues.find((i) => i.rawLocation?.includes('docstring of'));
  assert.ok(docstringIssue, 'Python docstring warning should be present');

  // .rst warning: present but publishDiagnostic=false
  const rstIssue = result.issues.find((i) => i.repoRelativePath?.includes('.rst'));
  assert.ok(rstIssue, '.rst warning should be parsed');
  assert.equal(rstIssue!.publishDiagnostic, false,
    '.rst warnings should not publish to direct-run Problems');

  // .md warning: present but publishDiagnostic=false
  const mdIssue = result.issues.find((i) => i.repoRelativePath?.includes('.md'));
  assert.ok(mdIssue, '.md warning should be parsed');
  assert.equal(mdIssue!.publishDiagnostic, false,
    '.md warnings should not publish to direct-run Problems');

  // standard file:line warning: present but publishDiagnostic=false
  const locatedIssue = result.issues.find((i) => i.mapping.strategy === 'sphinx-warning-file');
  assert.ok(locatedIssue, 'standard located warning should be present');
  assert.equal(locatedIssue!.publishDiagnostic, false,
    'non-docstring file:line warnings should not publish to direct-run Problems');

  // Counters
  assert.equal(result.suppressedNonDocstringCount, 3,
    'should count 3 suppressed non-docstring issues (.rst, .md, located)');
});

test('TextPythonDocstringSourceMapper maps class method docstring to source range', async () => {
  // Write a temp Python file with a class containing a docstring method
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'sphinx-doctor-textmapper-'));
  const pyPath = path.join(tmpDir, 'habbing.py');
  const source = [
    'class BaseHab:',
    '    def endorse(self, serder):',
    '        """',
    '        Endorse a serialized data structure.',
    '',
    '        Args:',
    '            serder: Serder instance',
    '',
    '        Returns:',
    '            bytes: CESR signature',
    '        """',
    '        pass',
  ].join('\n');
  await writeFile(pyPath, source, 'utf8');

  try {
    const sphinxLogLines = [
      `${pyPath}:docstring of keri.app.habbing.BaseHab.endorse:3: ERROR: Unexpected indentation. [docutils]`,
    ];

    const result = await parseSphinxWarnings({
      warningFileContent: sphinxLogLines.join('\n'),
      repoRoot: tmpDir,
      sourceWorkspaceFolder: 'test-workspace',
    });

    assert.equal(result.issues.length, 1, 'should parse one docstring warning');
    assert.equal(result.astDegraded, false, 'text mapper should not degrade');
    assert.equal(result.unsafeDocstringFallbackCount, 0, 'no unsafe fallback');

    const issue = result.issues[0];
    assert.equal(issue.publishDiagnostic, true, 'should publish mapped docstring');
    assert.equal(issue.mapping.confidence, 'high', 'should have high confidence');
    assert.equal(issue.mapping.strategy, 'sphinx-docstring-warning', 'should use docstring strategy');
    assert.ok(issue.sourceRange, 'should have source range');
    // Docstring line 3 (1-indexed in docstring content) from """ at line 2 (0-indexed):
    // startLine=2 (0-idx """), docstringLine=3 → targetLine0=5, 1-idx=6
    // Line 6 in source is "        Args:"
    assert.equal(issue.sourceRange!.startLine, 6,
      'targetLine should map to source line inside docstring');
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});