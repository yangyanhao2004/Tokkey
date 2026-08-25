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
    environment: { AMIS_GATEWAY_PYTHON: '/custom/python3' },
    isExecutable: () => true
  });

  const location = locator.locate();

  assert.equal(location.interpreterPath, '/custom/python3');
  assert.equal(location.source, 'override');
});

test('locator maps x64 onto the x86_64 bundled runtime folder', () => {
  const locator = new GatewayRuntimeLocator({
    projectRoot: PROJECT_ROOT,
    resourcesPath: '/app/Resources',
    environment: {},
    architecture: 'x64',
    isExecutable: (candidate) => candidate.includes('/app/Resources')
  });

  assert.equal(
    locator.locate().interpreterPath,
    '/app/Resources/GatewayRuntime/x86_64/python/bin/python3'
  );
});

test('locator falls back to the development virtualenv when nothing is bundled', () => {
  const locator = new GatewayRuntimeLocator({
    projectRoot: PROJECT_ROOT,
    environment: {},
    isExecutable: () => true
  });

  const location = locator.locate();

  assert.equal(location.interpreterPath, '/repo/runtime/amis-gateway/.venv/bin/python3');
  assert.equal(location.source, 'development');
});

test('locator reports no interpreter rather than returning an unusable path', () => {
  const locator = new GatewayRuntimeLocator({
    projectRoot: PROJECT_ROOT,
    environment: {},
    isExecutable: () => false
  });

  assert.equal(locator.locate(), null);
  assert.match(locator.searchPath(), /\.venv\/bin\/python3/);
});

test('health probe rejects an orphaned helper from a previous app launch', async () => {
  const probe = new GatewayHealthProbe({
    instanceId: 'current-launch',
    masterKey: 'key',
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
    masterKey: 'key',
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
    masterKey: 'key',
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
    masterKey: 'key',
    protocolVersion: GATEWAY_RUNTIME_PROTOCOL_VERSION,
    fetchImplementation: async () => {
      throw new Error('connection refused');
    }
  });

  assert.equal(await probe.isHealthy(4000), false);
});

const OWN_INTERPRETER = '/repo/runtime/amis-gateway/.venv/bin/python3';

test('port resolver keeps the preferred port when nothing is listening', async () => {
  const resolver = new GatewayPortResolver({
    preferredPort: 4000,
    findListener: () => null
  });

  assert.equal(await resolver.resolve(OWN_INTERPRETER), 4000);
});

test('port resolver reclaims the preferred port from a stale gateway helper', async () => {
  const terminated = [];
  const resolver = new GatewayPortResolver({
    preferredPort: 4000,
    findListener: () => ({
      processId: 321,
      commandLine: `${OWN_INTERPRETER} -m amis_gateway.main --host 127.0.0.1 --port 4000`
    }),
    terminate: (processId) => {
      terminated.push(processId);
      return true;
    },
    findFreePort: async () => 51000
  });

  assert.equal(await resolver.resolve(OWN_INTERPRETER), 4000);
  assert.deepEqual(terminated, [321]);
});

test('port resolver never kills another app running the same gateway module', async () => {
  const terminated = [];
  const resolver = new GatewayPortResolver({
    preferredPort: 4000,
    findListener: () => ({
      processId: 777,
      commandLine:
        '/Applications/Amis-Wifi.app/Contents/Resources/AmisGatewayRuntime/arm64/python/bin/python3 ' +
        '-m amis_gateway.main --host 127.0.0.1 --port 4000'
    }),
    terminate: (processId) => {
      terminated.push(processId);
      return true;
    },
    findFreePort: async () => 51000
  });

  assert.equal(await resolver.resolve(OWN_INTERPRETER), 51000);
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

  assert.equal(await resolver.resolve(OWN_INTERPRETER), 51000);
  assert.deepEqual(terminated, []);
});

test('port resolver falls back when a stale helper refuses to release the port', async () => {
  const resolver = new GatewayPortResolver({
    preferredPort: 4000,
    findListener: () => ({ processId: 321, commandLine: `${OWN_INTERPRETER} -m amis_gateway.main` }),
    terminate: () => false,
    findFreePort: async () => 51000
  });

  assert.equal(await resolver.resolve(OWN_INTERPRETER), 51000);
});

test('manager launches the interpreter with the gateway module and loopback flags', async () => {
  const child = new FakeChildProcess();
  let launchArguments = null;
  let launchOptions = null;
  const manager = new GatewayProcessManager({
    locator: new GatewayRuntimeLocator({
      projectRoot: PROJECT_ROOT,
      environment: {},
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

  assert.deepEqual(launchArguments, [
    '/repo/runtime/amis-gateway/.venv/bin/python3',
    '-m',
    'amis_gateway.main',
    '--host',
    '127.0.0.1',
    '--port',
    '4000'
  ]);
  assert.equal(manager.baseUrl(), 'http://127.0.0.1:4000');
  assert.equal(manager.bearerToken(), 'sk-123456');
  assert.equal(launchOptions.env.AMIS_GATEWAY_MASTER_KEY, manager.bearerToken());
  assert.equal(launchOptions.env.LITELLM_LOCAL_MODEL_COST_MAP, 'True');
  assert.equal(launchOptions.env.PYTHONDONTWRITEBYTECODE, '1');
  assert.ok(launchOptions.env.AMIS_GATEWAY_INSTANCE_ID);
  manager.stop('test finished');
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

test('manager fails with a usable hint when no interpreter is installed', async () => {
  const manager = new GatewayProcessManager({
    locator: new GatewayRuntimeLocator({
      projectRoot: PROJECT_ROOT,
      environment: {},
      isExecutable: () => false
    }),
    spawnProcess: () => {
      throw new Error('spawn must not be attempted without an interpreter');
    },
    delay: async () => {}
  });

  await assert.rejects(
    () => manager.startIfNeeded(),
    (error) => {
      assert.match(error.message, /uv sync/);
      assert.match(error.message, /AMIS_GATEWAY_PYTHON/);
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
