import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { AgentDetector } from '../dist/main/agents/AgentDetector.js';
import { AgentManager } from '../dist/main/agents/AgentManager.js';
import { StreamingShellRunner } from '../dist/main/agents/StreamingShellRunner.js';

/** Keeps shell-runner doubles readable without duplicating result shape literals. */
class TestShellResult {
  static create(exitCode, output, diagnosticTail = output) {
    return { exitCode, timedOut: false, output, diagnosticTail };
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

test('manager publishes detected state and reports availability only when it flips', async () => {
  const detections = {
    codex: { agent: 'codex', installed: false, executablePath: null, error: 'codex is not installed.' },
    claude: { agent: 'claude', installed: true, executablePath: '/usr/local/bin/claude', error: null }
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
