import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let logCalls: Array<{ level: string; json: string }> = [];

function buildFakeLogOutputChannel() {
  return {
    name: 'Sphinx Doctor',
    logLevel: 3, // info
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
          createOutputChannel: (_name: string, _options?: { log?: boolean }) => {
            return buildFakeLogOutputChannel();
          },
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

test('each structured severity method maps to the corresponding fake LogOutputChannel method', async () => {
  const { SphinxDoctorLogger } = await import('../../src/logging/extensionLogger.js');

  const logger = SphinxDoctorLogger.create();
  logCalls = [];

  logger.trace({ name: SphinxDoctorLogger.LogEvents.EXTENSION_ACTIVATED, fields: { mode: 'test' } });
  logger.debug({ name: SphinxDoctorLogger.LogEvents.EXTENSION_ACTIVATED });
  logger.info({ name: SphinxDoctorLogger.LogEvents.EXTENSION_ACTIVATED });
  logger.warn({ name: SphinxDoctorLogger.LogEvents.COMMAND_FAILED, fields: { label: 'test' } });
  logger.error({ name: SphinxDoctorLogger.LogEvents.COMMAND_FAILED, fields: { label: 'test' } });

  assert.equal(logCalls.length, 5);
  assert.equal(logCalls[0].level, 'trace');
  assert.equal(logCalls[1].level, 'debug');
  assert.equal(logCalls[2].level, 'info');
  assert.equal(logCalls[3].level, 'warn');
  assert.equal(logCalls[4].level, 'error');

  // Each call should produce valid JSON with the event name
  for (const call of logCalls) {
    const parsed = JSON.parse(call.json);
    assert.ok(typeof parsed.event === 'string');
  }

  logger.dispose();
});

test('event records include the central event name and safe fields', async () => {
  const { SphinxDoctorLogger } = await import('../../src/logging/extensionLogger.js');

  const logger = SphinxDoctorLogger.create();
  logCalls = [];

  logger.info({
    name: SphinxDoctorLogger.LogEvents.COMMAND_DIRECT_RUN_BUILD_COMPLETED,
    fields: { status: 'success', exitCode: 0, warningFileExists: true },
  });

  assert.equal(logCalls.length, 1);
  const parsed = JSON.parse(logCalls[0].json);
  assert.equal(parsed.event, 'command.directRun.build.completed');
  assert.equal(parsed.status, 'success');
  assert.equal(parsed.exitCode, 0);
  assert.equal(parsed.warningFileExists, true);

  logger.dispose();
});

test('withContext merges immutable contextual fields without creating another channel', async () => {
  const { SphinxDoctorLogger } = await import('../../src/logging/extensionLogger.js');

  const logger = SphinxDoctorLogger.create();
  const child = logger.withContext({ component: 'watch', projectId: 'test-project' });
  logCalls = [];

  child.info({
    name: SphinxDoctorLogger.LogEvents.WATCH_STARTUP,
    fields: { watchEnabled: true },
  });

  assert.equal(logCalls.length, 1);
  const parsed = JSON.parse(logCalls[0].json);
  assert.equal(parsed.component, 'watch');
  assert.equal(parsed.projectId, 'test-project');
  assert.equal(parsed.watchEnabled, true);

  // Child should not own disposal
  child.dispose();
  // Root should still be usable
  logCalls = [];
  logger.info({ name: SphinxDoctorLogger.LogEvents.EXTENSION_ACTIVATED });
  assert.equal(logCalls.length, 1);

  logger.dispose();
});

test('root disposal is idempotent and disposes the channel once', async () => {
  const { SphinxDoctorLogger } = await import('../../src/logging/extensionLogger.js');

  const logger = SphinxDoctorLogger.create();

  logger.dispose();
  logger.dispose(); // second call should be a no-op

  // After disposal, logging should be a no-op
  logCalls = [];
  logger.info({ name: SphinxDoctorLogger.LogEvents.EXTENSION_ACTIVATED });
  assert.equal(logCalls.length, 0);
});

test('child-view disposal does not dispose the root channel', async () => {
  const { SphinxDoctorLogger } = await import('../../src/logging/extensionLogger.js');

  const logger = SphinxDoctorLogger.create();
  const child = logger.withContext({ component: 'test' });

  child.dispose();

  // Root should still work after child disposal
  logCalls = [];
  logger.info({ name: SphinxDoctorLogger.LogEvents.EXTENSION_ACTIVATED });
  assert.equal(logCalls.length, 1);

  logger.dispose();
});

test('fields with safe primitive types are passed through', async () => {
  const { SphinxDoctorLogger } = await import('../../src/logging/extensionLogger.js');

  const logger = SphinxDoctorLogger.create();
  logCalls = [];

  logger.info({
    name: SphinxDoctorLogger.LogEvents.COMMAND_DIRECT_RUN_BUILD_COMPLETED,
    fields: {
      exitCode: 0,
      status: 'success',
      warningFileExists: true,
      count: null,
      labels: ['a', 'b'],
    },
  });

  assert.equal(logCalls.length, 1);
  const parsed = JSON.parse(logCalls[0].json);
  assert.equal(parsed.exitCode, 0);
  assert.equal(parsed.status, 'success');
  assert.equal(parsed.warningFileExists, true);
  assert.equal(parsed.count, null);
  assert.deepEqual(parsed.labels, ['a', 'b']);

  logger.dispose();
});
