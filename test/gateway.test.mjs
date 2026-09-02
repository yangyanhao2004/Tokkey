import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { GatewayHealthProbe } from '../dist/main/gateway/GatewayHealthProbe.js';
import { GatewayPortResolver } from '../dist/main/gateway/GatewayPortResolver.js';
import { GatewayRuntimeLocator } from '../dist/main/gateway/GatewayRuntimeLocator.js';
import {
  GATEWAY_RUNTIME_PROTOCOL_VERSION,
  GatewayProcessManager,
  GatewayStartupError
} from '../dist/main/gateway/GatewayProcessManager.js';

const PROJECT_ROOT = '/repo';

/** Builds a fetch double returning one fixed health payload. */
function healthResponder(payload, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    json: async () => payload
  });
}

/** A spawned-process double exposing the pieces the manager subscribes to. */
class FakeChildProcess extends EventEmitter {
  constructor() {
    super();
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

test('locator prefers the developer override over every packaged layout', () => {
  const locator = new GatewayRuntimeLocator({
    projectRoot: PROJECT_ROOT,
    resourcesPath: '/app/Resources',
    environment: { AMIS_GATEWAY_EXECUTABLE: '/custom/amis-gateway' },
    isExecutable: () => true
  });

  const location = locator.locate();

  assert.equal(location.executablePath, '/custom/amis-gateway');
  assert.equal(location.source, 'override');
});

test('locator uses the architecture folder verbatim, without an x86_64 rewrite', () => {
  const locator = new GatewayRuntimeLocator({
    projectRoot: PROJECT_ROOT,
    resourcesPath: '/app/Resources',
    environment: {},
    architecture: 'x64',
    isExecutable: (candidate) => candidate.includes('/app/Resources')
  });

  assert.equal(
    locator.locate().executablePath,
    '/app/Resources/GatewayRuntime/x64/amis-gateway/amis-gateway'
  );
});

test('locator finds the frozen bundle in a packaged app before the checked-out tree', () => {
  const locator = new GatewayRuntimeLocator({
    projectRoot: PROJECT_ROOT,
    resourcesPath: '/app/Resources',
    environment: {},
    architecture: 'arm64',
    isExecutable: () => true
  });

  const location = locator.locate();

  assert.equal(
    location.executablePath,
    '/app/Resources/GatewayRuntime/arm64/amis-gateway/amis-gateway'
  );
  assert.equal(location.source, 'bundled');
});

test('locator falls back to the repository resources tree during development', () => {
  const locator = new GatewayRuntimeLocator({
    projectRoot: PROJECT_ROOT,
    environment: {},
    architecture: 'arm64',
    isExecutable: () => true
  });

  const location = locator.locate();

  assert.equal(
    location.executablePath,
    '/repo/resources/GatewayRuntime/arm64/amis-gateway/amis-gateway'
  );
  assert.equal(location.source, 'development');
});

test('locator reports no runtime rather than returning an unusable path', () => {
  const locator = new GatewayRuntimeLocator({
    projectRoot: PROJECT_ROOT,
    environment: {},
    isExecutable: () => false
  });

  assert.equal(locator.locate(), null);
  assert.match(locator.searchPath(), /GatewayRuntime\/.+\/amis-gateway\/amis-gateway/);
});

test('health probe rejects an orphaned helper from a previous app launch', async () => {
  const probe = new GatewayHealthProbe({
    instanceId: 'current-launch',
    protocolVersion: GATEWAY_RUNTIME_PROTOCOL_VERSION,
    fetchImplementation: healthResponder({
      status: 'ok',
      service: 'amis-gateway',
      instance_id: 'previous-launch',
      runtime_protocol_version: GATEWAY_RUNTIME_PROTOCOL_VERSION
    })
  });

  assert.equal(await probe.isHealthy(4000), false);
});

test('health probe rejects a helper speaking an older runtime protocol', async () => {
  const probe = new GatewayHealthProbe({
    instanceId: 'current-launch',
    protocolVersion: GATEWAY_RUNTIME_PROTOCOL_VERSION,
    fetchImplementation: healthResponder({
      status: 'ok',
      service: 'amis-gateway',
      instance_id: 'current-launch',
      runtime_protocol_version: GATEWAY_RUNTIME_PROTOCOL_VERSION + 1
    })
  });

  assert.equal(await probe.isHealthy(4000), false);
});

test('health probe accepts this launch on the matching protocol', async () => {
  const probe = new GatewayHealthProbe({
    instanceId: 'current-launch',
    protocolVersion: GATEWAY_RUNTIME_PROTOCOL_VERSION,
    fetchImplementation: healthResponder({
      status: 'ok',
      service: 'amis-gateway',
      instance_id: 'current-launch',
      runtime_protocol_version: GATEWAY_RUNTIME_PROTOCOL_VERSION
    })
  });

  assert.equal(await probe.isHealthy(4000), true);
});

test('health probe treats an unreachable port as unhealthy', async () => {
  const probe = new GatewayHealthProbe({
    instanceId: 'current-launch',
    protocolVersion: GATEWAY_RUNTIME_PROTOCOL_VERSION,
    fetchImplementation: async () => {
      throw new Error('connection refused');
    }
  });

  assert.equal(await probe.isHealthy(4000), false);
});

const OWN_EXECUTABLE = '/repo/resources/GatewayRuntime/arm64/amis-gateway/amis-gateway';

test('port resolver keeps the preferred port when nothing is listening', async () => {
  const resolver = new GatewayPortResolver({
    preferredPort: 4000,
    findListener: () => null
  });

  assert.equal(await resolver.resolve(OWN_EXECUTABLE), 4000);
});

test('port resolver reclaims the preferred port from a stale gateway helper', async () => {
  const terminated = [];
  const resolver = new GatewayPortResolver({
    preferredPort: 4000,
    findListener: () => ({
      processId: 321,
      commandLine: `${OWN_EXECUTABLE} --host 127.0.0.1 --port 4000`
    }),
    terminate: (processId) => {
      terminated.push(processId);
      return true;
    },
    findFreePort: async () => 51000
  });

  assert.equal(await resolver.resolve(OWN_EXECUTABLE), 4000);
  assert.deepEqual(terminated, [321]);
});

test('port resolver never kills another app shipping the same gateway executable', async () => {
  const terminated = [];
  const resolver = new GatewayPortResolver({
    preferredPort: 4000,
    findListener: () => ({
      processId: 777,
      commandLine:
        '/Applications/Amis-Wifi.app/Contents/Resources/GatewayRuntime/arm64/amis-gateway/amis-gateway ' +
        '--host 127.0.0.1 --port 4000'
    }),
    terminate: (processId) => {
      terminated.push(processId);
      return true;
    },
    findFreePort: async () => 51000
  });

  assert.equal(await resolver.resolve(OWN_EXECUTABLE), 51000);
  assert.deepEqual(terminated, []);
});

test('port resolver leaves an unrelated process alone and takes a free port', async () => {
  const terminated = [];
  const resolver = new GatewayPortResolver({
    preferredPort: 4000,
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

test('port resolver falls back when a stale helper refuses to release the port', async () => {
  const resolver = new GatewayPortResolver({
    preferredPort: 4000,
    findListener: () => ({ processId: 321, commandLine: `${OWN_EXECUTABLE} --port 4000` }),
    terminate: () => false,
    findFreePort: async () => 51000
  });

  assert.equal(await resolver.resolve(OWN_EXECUTABLE), 51000);
});

test('manager launches the frozen executable with only the loopback flags', async () => {
  const child = new FakeChildProcess();
  let launchArguments = null;
  let launchOptions = null;
  const manager = new GatewayProcessManager({
    locator: new GatewayRuntimeLocator({
      projectRoot: PROJECT_ROOT,
      environment: {},
      architecture: 'arm64',
      isExecutable: () => true
    }),
    portResolver: new GatewayPortResolver({ preferredPort: 4000, findListener: () => null }),
    healthProbe: { isHealthy: async () => true },
    spawnProcess: (executable, args, options) => {
      launchArguments = [executable, ...args];
      launchOptions = options;
      return child;
    },
    delay: async () => {}
  });

  await manager.startIfNeeded();

  // The bundle carries its own interpreter, so no `-m amis_gateway.main` and no
  // interpreter path appear here: the executable is the whole launch contract.
  assert.deepEqual(launchArguments, [
    '/repo/resources/GatewayRuntime/arm64/amis-gateway/amis-gateway',
    '--host',
    '127.0.0.1',
    '--port',
    '4000'
  ]);
  assert.equal(manager.baseUrl(), 'http://127.0.0.1:4000');
  assert.equal(launchOptions.env.AMIS_GATEWAY_MASTER_KEY, undefined);
  assert.equal(launchOptions.env.LITELLM_LOCAL_MODEL_COST_MAP, 'True');
  assert.equal(launchOptions.env.REQUEST_TIMEOUT, '1800');
  assert.ok(launchOptions.env.AMIS_GATEWAY_INSTANCE_ID);
  manager.stop('test finished');
});

test('manager keeps an inherited REQUEST_TIMEOUT so an operator can tune it', async () => {
  const child = new FakeChildProcess();
  let launchOptions = null;
  const inherited = process.env.REQUEST_TIMEOUT;
  process.env.REQUEST_TIMEOUT = '120';
  const manager = new GatewayProcessManager({
    locator: new GatewayRuntimeLocator({
      projectRoot: PROJECT_ROOT,
      environment: {},
      isExecutable: () => true
    }),
    portResolver: new GatewayPortResolver({ preferredPort: 4000, findListener: () => null }),
    healthProbe: { isHealthy: async () => true },
    spawnProcess: (executable, args, options) => {
      launchOptions = options;
      return child;
    },
    delay: async () => {}
  });

  try {
    await manager.startIfNeeded();
    assert.equal(launchOptions.env.REQUEST_TIMEOUT, '120');
  } finally {
    if (inherited === undefined) {
      delete process.env.REQUEST_TIMEOUT;
    } else {
      process.env.REQUEST_TIMEOUT = inherited;
    }
    manager.stop('test finished');
  }
});

test('manager reports the stderr tail when the gateway never becomes ready', async () => {
  const child = new FakeChildProcess();
  const manager = new GatewayProcessManager({
    locator: new GatewayRuntimeLocator({
      projectRoot: PROJECT_ROOT,
      environment: {},
      isExecutable: () => true
    }),
    portResolver: new GatewayPortResolver({ preferredPort: 4000, findListener: () => null }),
    healthProbe: { isHealthy: async () => false },
    readinessTimeoutSeconds: 2,
    spawnProcess: () => {
      // A real child emits after the manager has subscribed, so defer past the
      // synchronous listener wiring that follows this call.
      setImmediate(() => child.stderr.emit('data', 'ModuleNotFoundError: No module named litellm\n'));
      return child;
    },
    // Yield a full event-loop turn per readiness tick so the deferred stderr
    // above is delivered exactly as a real subprocess would deliver it.
    delay: () => new Promise((resolve) => setImmediate(resolve))
  });

  await assert.rejects(
    () => manager.startIfNeeded(),
    (error) => {
      assert.ok(error instanceof GatewayStartupError);
      assert.match(error.message, /did not become ready within 2s/);
      assert.match(error.diagnostics, /ModuleNotFoundError/);
      return true;
    }
  );
  assert.equal(child.killed, true);
});

test('manager fails with a usable hint when the frozen runtime is missing', async () => {
  const manager = new GatewayProcessManager({
    locator: new GatewayRuntimeLocator({
      projectRoot: PROJECT_ROOT,
      environment: {},
      isExecutable: () => false
    }),
    spawnProcess: () => {
      throw new Error('spawn must not be attempted without a runtime');
    },
    delay: async () => {}
  });

  await assert.rejects(
    () => manager.startIfNeeded(),
    (error) => {
      assert.match(error.message, /gateway:freeze/);
      assert.match(error.message, /AMIS_GATEWAY_EXECUTABLE/);
      return true;
    }
  );
});

test('an intentional stop does not trigger the crash restart supervisor', async () => {
  const spawned = [];
  const manager = new GatewayProcessManager({
    locator: new GatewayRuntimeLocator({
      projectRoot: PROJECT_ROOT,
      environment: {},
      isExecutable: () => true
    }),
    portResolver: new GatewayPortResolver({ preferredPort: 4000, findListener: () => null }),
    healthProbe: { isHealthy: async () => true },
    spawnProcess: () => {
      const child = new FakeChildProcess();
      spawned.push(child);
      return child;
    },
    delay: async () => {}
  });

  await manager.startIfNeeded();
  const child = spawned[0];
  manager.stop('application quit');
  child.emit('exit', 0, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(spawned.length, 1);
  assert.equal(manager.baseUrl(), null);
});

test('an unexpected exit schedules a supervised relaunch', async () => {
  const spawned = [];
  const manager = new GatewayProcessManager({
    locator: new GatewayRuntimeLocator({
      projectRoot: PROJECT_ROOT,
      environment: {},
      isExecutable: () => true
    }),
    portResolver: new GatewayPortResolver({ preferredPort: 4000, findListener: () => null }),
    healthProbe: { isHealthy: async () => true },
    spawnProcess: () => {
      const child = new FakeChildProcess();
      spawned.push(child);
      return child;
    },
    delay: async () => {}
  });

  await manager.startIfNeeded();
  spawned[0].emit('exit', 1, null);
  // The first backoff step is ~2s with jitter; wait past its upper bound.
  await new Promise((resolve) => setTimeout(resolve, 3000));

  assert.equal(spawned.length, 2);
  manager.stop('test finished');
});
