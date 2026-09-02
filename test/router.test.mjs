import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { LocalPortResolver } from '../dist/main/process/LocalPortResolver.js';
import { RouterHealthProbe } from '../dist/main/router/RouterHealthProbe.js';
import { RouterProcessManager } from '../dist/main/router/RouterProcessManager.js';
import { RouterRuntimeLocator } from '../dist/main/router/RouterRuntimeLocator.js';

const PROJECT_ROOT = '/repo';
const OWN_EXECUTABLE = '/repo/resources/RouterRuntime/arm64/router/router-darwin-arm64';

/** A spawned-process double exposing the streams the manager subscribes to. */
class FakeChildProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stdout.setEncoding = () => {};
    this.stderr = new EventEmitter();
    this.stderr.setEncoding = () => {};
    this.killed = false;
    this.signals = [];
  }

  kill(signal) {
    this.killed = true;
    this.signals.push(signal);
    return true;
  }
}

/** A gateway double reporting one fixed address, or none at all. */
function fakeGateway(baseUrl) {
  return {
    startIfNeeded: async () => undefined,
    baseUrl: () => baseUrl
  };
}

/** A locator that always answers with the same path, so no binary is needed. */
function fakeLocator(architecture = 'arm64') {
  return new RouterRuntimeLocator({
    projectRoot: PROJECT_ROOT,
    environment: {},
    platform: 'darwin',
    architecture,
    isExecutable: () => true
  });
}

/**
 * Builds a manager whose every dependency is a double, plus the recorder the
 * launch assertions read. `healthy` decides whether the router ever answers.
 */
function buildManager({ gatewayUrl = 'http://127.0.0.1:4033', healthy = true, port = 5033 } = {}) {
  const launches = [];
  const children = [];
  const manager = new RouterProcessManager({
    gateway: fakeGateway(gatewayUrl),
    locator: fakeLocator(),
    portResolver: { resolve: async () => port },
    healthProbe: { isHealthy: async () => healthy },
    readinessTimeoutSeconds: 2,
    delay: async () => undefined,
    spawnProcess: (executablePath, args, options) => {
      launches.push({ executablePath, args, options });
      const child = new FakeChildProcess();
      children.push(child);
      return child;
    }
  });
  return { manager, launches, children };
}

test('locator maps Node’s x64 onto the Go amd64 folder the binary ships in', () => {
  const locator = new RouterRuntimeLocator({
    projectRoot: PROJECT_ROOT,
    environment: {},
    platform: 'darwin',
    architecture: 'x64',
    isExecutable: () => true
  });

  assert.equal(
    locator.locate().executablePath,
    '/repo/resources/RouterRuntime/amd64/router/router-darwin-amd64'
  );
});

test('locator keeps arm64 as it is, since Node and Go agree on that name', () => {
  assert.equal(fakeLocator('arm64').locate().executablePath, OWN_EXECUTABLE);
});

test('locator prefers the frozen bundle in a packaged app over the checked-out tree', () => {
  const locator = new RouterRuntimeLocator({
    projectRoot: PROJECT_ROOT,
    resourcesPath: '/app/Resources',
    environment: {},
    platform: 'darwin',
    architecture: 'arm64',
    isExecutable: () => true
  });

  const location = locator.locate();

  assert.equal(
    location.executablePath,
    '/app/Resources/RouterRuntime/arm64/router/router-darwin-arm64'
  );
  assert.equal(location.source, 'bundled');
});

test('locator prefers the developer override over every packaged layout', () => {
  const locator = new RouterRuntimeLocator({
    projectRoot: PROJECT_ROOT,
    resourcesPath: '/app/Resources',
    environment: { AMIS_ROUTER_EXECUTABLE: '/custom/router' },
    platform: 'darwin',
    architecture: 'arm64',
    isExecutable: () => true
  });

  const location = locator.locate();

  assert.equal(location.executablePath, '/custom/router');
  assert.equal(location.source, 'override');
});

test('locator reports the unsupported host rather than guessing an architecture', () => {
  const locator = new RouterRuntimeLocator({
    projectRoot: PROJECT_ROOT,
    environment: {},
    platform: 'linux',
    architecture: 'ppc64',
    isExecutable: () => true
  });

  assert.equal(locator.locate(), null);
  assert.equal(locator.searchPath(), 'no router binary ships for linux/ppc64');
});

test('locator names the .exe suffix on Windows', () => {
  const locator = new RouterRuntimeLocator({
    projectRoot: PROJECT_ROOT,
    environment: {},
    platform: 'win32',
    architecture: 'x64',
    isExecutable: () => true
  });

  assert.match(locator.locate().executablePath, /router-win32-amd64\.exe$/);
});

test('health probe accepts a router answering on its loopback port', async () => {
  let requestedUrl = null;
  const probe = new RouterHealthProbe({
    fetchImplementation: async (url) => {
      requestedUrl = url;
      return { ok: true };
    }
  });

  assert.equal(await probe.isHealthy(5033), true);
  assert.equal(requestedUrl, 'http://127.0.0.1:5033/health');
});

test('health probe treats an unreachable port as not ready yet', async () => {
  const probe = new RouterHealthProbe({
    fetchImplementation: async () => {
      throw new Error('connection refused');
    }
  });

  assert.equal(await probe.isHealthy(5033), false);
});

test('manager launches the router with the port, gateway url and gateway key', async () => {
  const { manager, launches } = buildManager();

  const state = await manager.start();

  assert.equal(launches.length, 1);
  assert.equal(launches[0].executablePath, OWN_EXECUTABLE);
  assert.deepEqual(launches[0].args, [
    '--port',
    '5033',
    '--gateway-url',
    'http://127.0.0.1:4033',
    '--gateway-key',
    'sk-123456'
  ]);
  assert.equal(state.phase, 'running');
  assert.equal(state.port, 5033);
  assert.equal(state.baseUrl, 'http://127.0.0.1:5033');
  assert.equal(state.dashboardUrl, 'http://127.0.0.1:5033/admin/dashboard');
});

test('manager launches on the fallback port when 5033 is already held', async () => {
  const { manager, launches } = buildManager({ port: 51000 });

  const state = await manager.start();

  assert.deepEqual(launches[0].args.slice(0, 2), ['--port', '51000']);
  assert.equal(state.port, 51000);
});

test('manager publishes every state change to its subscribers', async () => {
  const { manager } = buildManager();
  const phases = [];
  manager.subscribe((state) => phases.push(state.phase));

  await manager.start();
  manager.stop('test');

  assert.deepEqual(phases, ['starting', 'running', 'stopped']);
});

test('manager starts only once while a start is still in flight', async () => {
  const { manager, launches } = buildManager();

  const [first, second] = await Promise.all([manager.start(), manager.start()]);

  assert.equal(launches.length, 1);
  assert.equal(first.phase, 'running');
  assert.equal(second.phase, 'running');
});

test('manager reports the failure rather than throwing when the gateway is down', async () => {
  const { manager, launches } = buildManager({ gatewayUrl: null });

  const state = await manager.start();

  assert.equal(launches.length, 0);
  assert.equal(state.phase, 'error');
  assert.match(state.error, /gateway is not running/);
});

test('manager reports a router that never answers, and kills it', async () => {
  const { manager, children } = buildManager({ healthy: false });

  const state = await manager.start();

  assert.equal(state.phase, 'error');
  assert.match(state.error, /did not become ready within 2s/);
  assert.equal(children[0].killed, true);
});

test('manager includes the router’s own stdout in a readiness failure', async () => {
  const manager = new RouterProcessManager({
    gateway: fakeGateway('http://127.0.0.1:4033'),
    locator: fakeLocator(),
    portResolver: { resolve: async () => 5033 },
    healthProbe: { isHealthy: async () => false },
    readinessTimeoutSeconds: 1,
    delay: async () => undefined,
    spawnProcess: () => {
      const child = new FakeChildProcess();
      // The router prints its banner and bind errors on stdout, not stderr, so a
      // failure report has to read both streams to say anything useful.
      queueMicrotask(() =>
        child.stdout.emit('data', 'listen tcp :5033: address already in use\n')
      );
      return child;
    }
  });

  const state = await manager.start();

  assert.match(state.error, /address already in use/);
});

test('manager signals the child and reports stopped when switched off', async () => {
  const { manager, children } = buildManager();

  await manager.start();
  const state = manager.stop('switched off');

  assert.deepEqual(children[0].signals, ['SIGTERM']);
  assert.equal(state.phase, 'stopped');
  assert.equal(manager.currentState().phase, 'stopped');
});

test('manager reports an exit it did not ask for as an error', async () => {
  const { manager, children } = buildManager();

  await manager.start();
  children[0].emit('exit', 1, null);

  const state = manager.currentState();
  assert.equal(state.phase, 'error');
  assert.match(state.error, /exited unexpectedly/);
});

test('manager clears a stale failure once the user switches it off', async () => {
  const { manager } = buildManager({ gatewayUrl: null });

  await manager.start();
  const state = manager.stop('switched off');

  assert.equal(state.phase, 'stopped');
  assert.equal(state.error, null);
});

test('port resolver keeps 5033 when nothing else is listening on it', async () => {
  const resolver = new LocalPortResolver({
    preferredPort: RouterProcessManager.DEFAULT_PORT,
    logLabel: 'AmisRouter',
    findListener: () => null
  });

  assert.equal(await resolver.resolve(OWN_EXECUTABLE), 5033);
});

test('port resolver leaves an unrelated listener alone and takes a free port', async () => {
  const terminated = [];
  const resolver = new LocalPortResolver({
    preferredPort: RouterProcessManager.DEFAULT_PORT,
    logLabel: 'AmisRouter',
    findListener: () => ({ processId: 999, commandLine: '/usr/local/bin/postgres -D /data' }),
    terminate: (processId) => {
      terminated.push(processId);
      return true;
    },
    findFreePort: async () => 51000
  });

  assert.equal(await resolver.resolve(OWN_EXECUTABLE), 51000);
  assert.deepEqual(terminated, []);
});

test('port resolver reclaims 5033 from a router this app left behind', async () => {
  const terminated = [];
  const resolver = new LocalPortResolver({
    preferredPort: RouterProcessManager.DEFAULT_PORT,
    logLabel: 'AmisRouter',
    findListener: () => ({ processId: 321, commandLine: `${OWN_EXECUTABLE} --port 5033` }),
    terminate: (processId) => {
      terminated.push(processId);
      return true;
    },
    findFreePort: async () => 51000
  });

  assert.equal(await resolver.resolve(OWN_EXECUTABLE), 5033);
  assert.deepEqual(terminated, [321]);
});
