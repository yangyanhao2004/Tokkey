#!/usr/bin/env node

const { spawn } = require('node:child_process');
const electronBinaryPath = require('electron');

/**
 * The terminations a terminal can deliver to a foreground job: Ctrl+C (SIGINT),
 * a `kill` or a `pkill` (SIGTERM), the terminal window closing (SIGHUP). Each is
 * passed on to Electron once and only once.
 */
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Starts Electron in a process group of its own, so a terminal signal reaches it
 * exactly once.
 *
 * Ctrl+C goes to every process in the terminal's foreground group, and the
 * `electron` npm wrapper that would otherwise launch the app puts Electron in
 * that group and *also* forwards the signal to it by hand. Electron therefore
 * receives two: the first starts the orderly `before-quit`/`will-quit` shutdown,
 * and the second arrives while that shutdown is still running and kills the
 * process outright. Everything `will-quit` exists to do is skipped, and Codex is
 * left pointed at a gateway that stopped answering — the borrowed config files
 * are handed back only by that shutdown.
 *
 * Detaching is what breaks the tie. Electron leads a group the terminal does not
 * signal, this launcher stays in the foreground group to receive the signal
 * itself, and it passes on a single one. A second Ctrl+C is read as impatience
 * rather than a repeat, and force-kills the group.
 *
 * Signal handlers work here for the same reason they do not work inside
 * Electron: this is an ordinary Node process, with libuv free to watch for
 * signals rather than a Chromium main process that installs its own handlers
 * first.
 */
class ElectronDevLauncher {
  /** @param {string[]} electronArguments passed straight through to Electron */
  constructor(electronArguments) {
    this.electronArguments = electronArguments;
    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null;
    /** True once a shutdown has been asked for and Electron may be mid-quit. */
    this.shutdownRequested = false;
  }

  /** Launches Electron and waits for it, mirroring how it exited. */
  run() {
    this.child = spawn(electronBinaryPath, this.electronArguments, {
      // The terminal is shared, so the app's logs still appear where the
      // developer is looking.
      stdio: 'inherit',
      // The point of the whole file: a new process group, which the terminal
      // does not deliver Ctrl+C to.
      detached: true,
      windowsHide: false
    });
    this.child.on('error', (error) => {
      console.error('[electron-dev] Could not start Electron:', error);
      process.exit(1);
    });
    this.child.on('close', (code, signal) => this.onElectronClosed(code, signal));
    for (const signal of FORWARDED_SIGNALS) {
      process.on(signal, () => this.forward(signal));
    }
  }

  /**
   * Passes one signal on to Electron, or gives up waiting on the second.
   *
   * Only the group leader is signalled on the way down: Electron stops the
   * gateway and the router itself, in the order it wants them stopped, and
   * signalling the whole group would take them out from under it.
   */
  forward(signal) {
    if (this.child === null || this.child.exitCode !== null) {
      return;
    }
    if (this.shutdownRequested) {
      console.error('\n[electron-dev] Second interrupt — killing Electron and everything under it.');
      this.killGroup();
      return;
    }
    this.shutdownRequested = true;
    this.child.kill(signal);
  }

  /**
   * Kills Electron's whole process group, so the gateway it spawned goes with
   * it rather than outliving the app that owns it.
   */
  killGroup() {
    try {
      process.kill(-this.child.pid, 'SIGKILL');
    } catch {
      // Already gone, which is the state this was aiming for.
    }
  }

  /**
   * Exits the way Electron did, except after a shutdown this launcher asked
   * for: that is a clean end to a dev session, and reporting it as a failure
   * would only make npm print a lifecycle error over it.
   */
  onElectronClosed(code, signal) {
    if (this.shutdownRequested) {
      process.exit(0);
    }
    if (code === null) {
      console.error('[electron-dev] Electron exited with signal', signal);
      process.exit(1);
    }
    process.exit(code);
  }
}

new ElectronDevLauncher(process.argv.slice(2)).run();
