import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { AgentDetector } from '../dist/main/agents/AgentDetector.js';
import { AgentManager } from '../dist/main/agents/AgentManager.js';
import { ShellAgentInstaller } from '../dist/main/agents/ShellAgentInstaller.js';
import { StreamingShellRunner } from '../dist/main/agents/StreamingShellRunner.js';

/** Keeps shell-runner doubles readable without duplicating result shape literals. */
class TestShellResult {
  static create(exitCode, output, diagnosticTail = output) {
    return { exitCode, timedOut: false, output, diagnosticTail };
  }
}

test('Codex and Claude commands preserve the official installer contract', () => {
  const codex = ShellAgentInstaller.installCommand('codex');
  assert.match(codex, /set -eo pipefail/);
  assert.match(codex, /curl -fsS --max-time 8 -o \/dev\/null https:\/\/chatgpt\.com\/codex\/install\.sh/);
  assert.match(codex, /CODEX_NON_INTERACTIVE=1 sh/);
  assert.match(codex, /https:\/\/v4\.gh-proxy\.com\/https:\/\/raw\.githubusercontent\.com/);
  assert.match(codex, /sed .*https:\/\/github\.com.*v4\.gh-proxy\.com/);
  assert.match(codex, /echo "Codex installation complete"/);

  const claude = ShellAgentInstaller.installCommand('claude');
  assert.match(claude, /curl -fsS --max-time 8 -o \/dev\/null https:\/\/claude\.ai\/install\.sh/);
  assert.match(claude, /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
  assert.match(claude, /Claude installer unavailable/);
});

test('detector runs which, caches results, and invalidates after installation', async () => {
  const commands = [];
  const runner = {
    run: async (command) => {
      commands.push(command);
      return command.endsWith('codex')
        ? TestShellResult.create(0, ['/custom/bin/codex'])
        : TestShellResult.create(1, [], ['which: claude: command not found']);
    }
  };
  const detector = new AgentDetector(runner);

  assert.deepEqual(await detector.detect('codex'), {
    agent: 'codex', installed: true, executablePath: '/custom/bin/codex', error: null
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

test('manager publishes progress and applies success/failure lifecycle transitions', async () => {
  const detections = {
    codex: { agent: 'codex', installed: false, executablePath: null, error: 'codex is not installed.' },
    claude: { agent: 'claude', installed: false, executablePath: null, error: 'claude is not installed.' }
  };
  const detector = {
    detect: async (agent) => detections[agent],
    invalidate: () => {}
  };
  const installer = {
    install: async (_agent, onLine) => {
      onLine('installer output');
      return { ...TestShellResult.create(0, ['installer output']), kind: 'success', agent: 'codex', error: null };
    },
    uninstall: async () => ({ ...TestShellResult.create(0, []), kind: 'success', agent: 'codex', error: null })
  };
  const events = [];
  const manager = new AgentManager({ detector, installer, onEvent: (event) => events.push(event) });

  await manager.refresh('codex');
  const result = await manager.install('codex');
  assert.equal(result.kind, 'success');
  assert.equal(manager.state('codex').state, 'installed');
  assert.ok(events.some((event) => event.kind === 'progress' && event.line === 'installer output'));
  assert.ok(events.some((event) => event.kind === 'availability-changed' && event.installed));
  await manager.uninstall('codex');
  assert.equal(manager.state('codex').state, 'notInstalled');
});
