import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AgentDetector } from '../dist/main/agents/AgentDetector.js';
import { DesktopAppDetector } from '../dist/main/agents/DesktopAppDetector.js';
import { AgentManager } from '../dist/main/agents/AgentManager.js';
import { InstalledAgentGate } from '../dist/main/agents/InstalledAgentGate.js';
import { StreamingShellRunner } from '../dist/main/agents/StreamingShellRunner.js';

/** Keeps shell-runner doubles readable without duplicating result shape literals. */
class TestShellResult {
  static create(exitCode, output, diagnosticTail = output) {
    return { exitCode, timedOut: false, output, diagnosticTail };
  }
}

/** Desktop-app lookup double, so detection never depends on the test machine. */
class TestDesktopApps {
  static none() {
    return { locate: () => null };
  }

  static only(agent, bundlePath) {
    return { locate: (candidate) => (candidate === agent ? bundlePath : null) };
  }
}

test('detector runs which, caches results, and re-probes after invalidation', async () => {
  const commands = [];
  const runner = {
    run: async (command) => {
      commands.push(command);
      return command.endsWith('codex')
        ? TestShellResult.create(0, ['/custom/bin/codex'])
        : TestShellResult.create(1, [], ['which: claude: command not found']);
    }
  };
  const detector = new AgentDetector({ shellRunner: runner, desktopApps: TestDesktopApps.none() });

  assert.deepEqual(await detector.detect('codex'), {
    agent: 'codex', installed: true, executablePath: '/custom/bin/codex', desktopAppPath: null, error: null
  });
  await detector.detect('codex');
  await detector.detect('claude');
  detector.invalidate('codex');
  await detector.detect('codex');
  assert.deepEqual(commands, ['which codex', 'which claude', 'which codex']);
});

test('streaming runner invokes a login shell and forwards complete lines', async () => {
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
      this.stdout.setEncoding = () => {};
      this.stderr.setEncoding = () => {};
      this.signals = [];
    }

    kill(signal) {
      this.signals.push(signal);
      return true;
    }
  }

  const child = new FakeChild();
  let launch;
  const runner = new StreamingShellRunner({
    environment: { PATH: '/custom/bin' },
    spawnProcess: (shell, args, options) => {
      launch = { shell, args, options };
      queueMicrotask(() => {
        child.stdout.emit('data', 'first\nsecond');
        child.stderr.emit('data', 'warning\n');
        child.stdout.emit('data', '\n');
        child.emit('close', 0);
      });
      return child;
    }
  });
  const lines = [];
  const result = await runner.run('which codex', {
    shell: '/bin/bash', login: true, timeoutMs: 1000, onLine: (line) => lines.push(line)
  });

  assert.deepEqual(launch.args, ['-lc', 'which codex']);
  assert.equal(launch.options.env.PATH, '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/custom/bin');
  assert.deepEqual(lines, ['first', 'warning', 'second']);
  assert.deepEqual(result.output, lines);
  assert.equal(result.exitCode, 0);
});

test('manager publishes detected state and reports availability only when it flips', async () => {
  const detections = {
    codex: {
      agent: 'codex', installed: false, executablePath: null, desktopAppPath: null, error: 'codex is not installed.'
    },
    claude: {
      agent: 'claude', installed: true, executablePath: '/usr/local/bin/claude', desktopAppPath: null, error: null
    }
  };
  const invalidated = [];
  const detector = {
    detect: async (agent) => detections[agent],
    invalidate: (agent) => invalidated.push(agent)
  };
  const events = [];
  const manager = new AgentManager({ detector, onEvent: (event) => events.push(event) });

  const refreshed = await manager.refresh();
  assert.equal(refreshed.codex.state, 'notInstalled');
  assert.equal(refreshed.claude.executablePath, '/usr/local/bin/claude');
  assert.equal(manager.state('codex').error, 'codex is not installed.');

  const availability = events.filter((event) => event.kind === 'availability-changed');
  assert.deepEqual(availability, [{ kind: 'availability-changed', agent: 'claude', installed: true }]);

  // A second refresh finds the same truth, so no further availability event fires.
  await manager.refresh();
  assert.equal(events.filter((event) => event.kind === 'availability-changed').length, 1);

  manager.invalidate('codex');
  assert.deepEqual(invalidated, ['codex']);
});

test('concurrent detections of one agent share a single probe', async () => {
  let probeCount = 0;
  const runner = {
    run: async () => {
      probeCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return TestShellResult.create(0, ['/usr/local/bin/codex']);
    }
  };
  const detector = new AgentDetector({ shellRunner: runner, desktopApps: TestDesktopApps.none() });

  const [first, second] = await Promise.all([detector.detect('codex'), detector.detect('codex')]);
  assert.equal(probeCount, 1);
  assert.equal(first.executablePath, '/usr/local/bin/codex');
  assert.deepEqual(first, second);

  detector.invalidate('codex');
  await detector.detect('codex');
  assert.equal(probeCount, 2);
});

test('the gate reports only the agents that are installed', async () => {
  const manager = new AgentManager({
    detector: {
      detect: async (agent) => ({
        agent,
        installed: agent === 'claude',
        executablePath: agent === 'claude' ? '/usr/local/bin/claude' : null,
        desktopAppPath: null,
        error: agent === 'claude' ? null : 'codex is not installed.'
      }),
      invalidate: () => {}
    }
  });

  assert.deepEqual(await new InstalledAgentGate({ agentManager: manager }).installedAgents(), ['claudeCode']);
});

test('an agent with no CLI still counts as installed when its desktop app is there', async () => {
  const runner = { run: async () => TestShellResult.create(1, [], ['which: claude: command not found']) };
  const detector = new AgentDetector({
    shellRunner: runner,
    desktopApps: TestDesktopApps.only('claude', '/Applications/Claude.app')
  });

  assert.deepEqual(await detector.detect('claude'), {
    agent: 'claude',
    installed: true,
    executablePath: null,
    desktopAppPath: '/Applications/Claude.app',
    error: null
  });
  const codex = await detector.detect('codex');
  assert.equal(codex.installed, false);
  assert.equal(codex.desktopAppPath, null);
});

test('desktop app lookup accepts a matching bundle id and rejects a foreign one', () => {
  const appsDirectory = mkdtempSync(path.join(tmpdir(), 'tokkey-apps-'));
  const writeApp = (bundleName, bundleIdentifier) => {
    const contentsDirectory = path.join(appsDirectory, bundleName, 'Contents');
    mkdirSync(contentsDirectory, { recursive: true });
    writeFileSync(
      path.join(contentsDirectory, 'Info.plist'),
      `<plist><dict><key>CFBundleIdentifier</key><string>${bundleIdentifier}</string></dict></plist>`
    );
  };
  writeApp('Claude.app', 'com.anthropic.claudefordesktop');
  // The plain ChatGPT app is not Codex, so its bundle must not count as one.
  writeApp('ChatGPT.app', 'com.openai.chat');
  const detector = new DesktopAppDetector({ searchDirectories: [appsDirectory] });

  assert.equal(detector.locate('claude'), path.join(appsDirectory, 'Claude.app'));
  assert.equal(detector.locate('codex'), null);

  writeApp('Codex.app', 'com.openai.codex');
  assert.equal(detector.locate('codex'), path.join(appsDirectory, 'Codex.app'));

  rmSync(appsDirectory, { recursive: true, force: true });
});

test('desktop app lookup finds nothing off macOS, where there are no bundles', () => {
  const detector = new DesktopAppDetector({ platform: 'win32', homeDirectory: '/home/user' });

  assert.equal(detector.locate('claude'), null);
  assert.equal(detector.locate('codex'), null);
});
