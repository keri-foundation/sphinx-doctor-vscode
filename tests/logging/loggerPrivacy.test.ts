import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let logCalls: Array<{ level: string; json: string }> = [];

function buildFakeLogOutputChannel() {
  return {
    name: 'Sphinx Doctor',
    logLevel: 3,
    trace(msg: string) {
      logCalls.push({ level: 'trace', json: msg });
    },
    debug(msg: string) {
      logCalls.push({ level: 'debug', json: msg });
    },
    info(msg: string) {
      logCalls.push({ level: 'info', json: msg });
    },
    warn(msg: string) {
      logCalls.push({ level: 'warn', json: msg });
    },
    error(msg: string) {
      logCalls.push({ level: 'error', json: msg });
    },
    show: () => {},
    dispose: () => {},
    append: () => {},
    appendLine: () => {},
    replace: () => {},
    clear: () => {},
    hide: () => {},
  };
}

function setupModuleStub() {
  const moduleLoader = require('node:module') as typeof import('node:module') & {
    _load?: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
  };
  const originalLoad = moduleLoader._load;
  assert.ok(originalLoad, 'Expected node module loader to be available for vscode stubbing.');

  moduleLoader._load = ((request: string, parent: NodeModule | undefined, isMain: boolean) => {
    if (request === 'vscode') {
      return {
        window: {
          createOutputChannel: () => buildFakeLogOutputChannel(),
        },
      };
    }

    return originalLoad(request, parent, isMain);
  }) as typeof originalLoad;

  return {
    restore() {
      moduleLoader._load = originalLoad;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let moduleStub: ReturnType<typeof setupModuleStub>;

before(() => {
  moduleStub = setupModuleStub();
});

after(() => {
  moduleStub.restore();
});

test('sensitive keys are redacted before the channel receives a record', async () => {
  const { SphinxDoctorLogger } = await import('../../src/logging/extensionLogger.js');

  const logger = SphinxDoctorLogger.create();
  logCalls = [];

  logger.info({
    name: SphinxDoctorLogger.LogEvents.EXTENSION_ACTIVATED,
    fields: {
      password: 'secret123',
      token: 'abc.def.ghi',
      secret: 'my-secret',
      apiKey: 'key-12345',
      safeField: 'visible',
    },
  });

  assert.equal(logCalls.length, 1);
  const parsed = JSON.parse(logCalls[0].json);

  assert.equal(parsed.password, '[REDACTED]');
  assert.equal(parsed.token, '[REDACTED]');
  assert.equal(parsed.secret, '[REDACTED]');
  assert.equal(parsed.apiKey, '[REDACTED]');
  assert.equal(parsed.safeField, 'visible');

  logger.dispose();
});

test('path-like sensitive keys are redacted', async () => {
  const { SphinxDoctorLogger } = await import('../../src/logging/extensionLogger.js');

  const logger = SphinxDoctorLogger.create();
  logCalls = [];

  logger.info({
    name: SphinxDoctorLogger.LogEvents.EXTENSION_ACTIVATED,
    fields: {
      path: '/home/user/project',
      fsPath: '/home/user/project/file.py',
      absolutePath: '/absolute/path',
      safeField: 'visible',
    },
  });

  assert.equal(logCalls.length, 1);
  const parsed = JSON.parse(logCalls[0].json);

  assert.equal(parsed.path, '[REDACTED]');
  assert.equal(parsed.fsPath, '[REDACTED]');
  assert.equal(parsed.absolutePath, '[REDACTED]');
  assert.equal(parsed.safeField, 'visible');

  logger.dispose();
});

test('stdout and stderr keys are redacted', async () => {
  const { SphinxDoctorLogger } = await import('../../src/logging/extensionLogger.js');

  const logger = SphinxDoctorLogger.create();
  logCalls = [];

  logger.info({
    name: SphinxDoctorLogger.LogEvents.COMMAND_DIRECT_RUN_BUILD_STDOUT,
    fields: {
      stdout: 'lots of build output here',
      stderr: 'error output',
    },
  });

  assert.equal(logCalls.length, 1);
  const parsed = JSON.parse(logCalls[0].json);

  assert.equal(parsed.stdout, '[REDACTED]');
  assert.equal(parsed.stderr, '[REDACTED]');

  logger.dispose();
});

test('source, document, diagnostic, diagnostics, config keys are redacted', async () => {
  const { SphinxDoctorLogger } = await import('../../src/logging/extensionLogger.js');

  const logger = SphinxDoctorLogger.create();
  logCalls = [];

  logger.info({
    name: SphinxDoctorLogger.LogEvents.EXTENSION_ACTIVATED,
    fields: {
      source: 'print("hello")',
      document: 'some document text',
      diagnostic: 'diagnostic message',
      diagnostics: 'all diagnostics',
      config: '{"key": "value"}',
    },
  });

  assert.equal(logCalls.length, 1);
  const parsed = JSON.parse(logCalls[0].json);

  assert.equal(parsed.source, '[REDACTED]');
  assert.equal(parsed.document, '[REDACTED]');
  assert.equal(parsed.diagnostic, '[REDACTED]');
  assert.equal(parsed.diagnostics, '[REDACTED]');
  assert.equal(parsed.config, '[REDACTED]');

  logger.dispose();
});

test('channel output is compact structured JSON', async () => {
  const { SphinxDoctorLogger } = await import('../../src/logging/extensionLogger.js');

  const logger = SphinxDoctorLogger.create();
  logCalls = [];

  logger.info({
    name: SphinxDoctorLogger.LogEvents.COMMAND_DIRECT_RUN_BUILD_COMPLETED,
    fields: { exitCode: 0 },
  });

  assert.equal(logCalls.length, 1);
  const parsed = JSON.parse(logCalls[0].json);
  assert.equal(parsed.event, 'command.directRun.build.completed');
  assert.equal(parsed.exitCode, 0);

  // Verify compact JSON (no pretty-print)
  assert.ok(!logCalls[0].json.includes('\n  '));
  assert.ok(!logCalls[0].json.includes('\n'));

  logger.dispose();
});

test('array values with non-string entries are redacted', async () => {
  const { SphinxDoctorLogger } = await import('../../src/logging/extensionLogger.js');

  const logger = SphinxDoctorLogger.create();
  logCalls = [];

  logger.info({
    name: SphinxDoctorLogger.LogEvents.EXTENSION_ACTIVATED,
    fields: {
      // arrays of numbers or mixed types should be redacted
      mixedArray: [1, 2, 3] as unknown as readonly string[],
    },
  });

  assert.equal(logCalls.length, 1);
  const parsed = JSON.parse(logCalls[0].json);
  // Non-string array entries are treated as unsupported → redacted
  assert.equal(parsed.mixedArray, '[REDACTED]');

  logger.dispose();
});
