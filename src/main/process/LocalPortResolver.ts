import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';

/** The process currently listening on a port. */
export interface PortListener {
  processId: number;
  commandLine: string;
}

export interface LocalPortResolverOptions {
  /** The port this helper binds unless something else already holds it. */
  preferredPort: number;
  /** Name this resolver logs under, e.g. `AmisGateway`. */
  logLabel: string;
  /** Injected so tests can simulate an occupied port without binding one. */
  findListener?: (port: number) => PortListener | null;
  /** Injected so tests never signal a real process. */
  terminate?: (processId: number) => boolean;
  /** Injected so tests can force a deterministic fallback port. */
  findFreePort?: () => Promise<number>;
}

/**
 * Chooses the port a bundled loopback helper binds.
 *
 * The preferred port is reclaimed when an orphan of a previous app launch still
 * holds it. A port owned by an unrelated process is left alone and a
 * kernel-assigned free port is used instead, so an unrelated local service never
 * gets killed and the launch never fails just because the default port is taken.
 *
 * "Orphan of a previous launch" is matched on the executable path, never on the
 * program name: other apps ship these same helpers, so a name check would let
 * this app terminate a live helper belonging to one of them. Only a process
 * running *this* app's copy of the executable can be ours.
 *
 * Shared by every helper this app supervises — the gateway and the router — so
 * the eviction rule and the fallback behaviour stay identical across them.
 */
export class LocalPortResolver {
  private readonly preferredPort: number;
  private readonly logLabel: string;
  private readonly findListener: (port: number) => PortListener | null;
  private readonly terminate: (processId: number) => boolean;
  private readonly findFreePortImplementation: () => Promise<number>;

  constructor(options: LocalPortResolverOptions) {
    this.preferredPort = options.preferredPort;
    this.logLabel = options.logLabel;
    this.findListener = options.findListener ?? LocalPortResolver.listenerOnPort;
    this.terminate = options.terminate ?? LocalPortResolver.terminateProcess;
    this.findFreePortImplementation = options.findFreePort ?? LocalPortResolver.freePort;
  }

  /**
   * Returns the port this launch should bind, evicting a stale helper if needed.
   * @param executablePath the executable this launch will run, used to tell this
   *   app's own orphaned helper apart from another app's live one
   */
  async resolve(executablePath: string): Promise<number> {
    const listener = this.findListener(this.preferredPort);
    if (!listener) {
      return this.preferredPort;
    }
    const isOwnHelper = LocalPortResolver.isOwnProcess(listener.commandLine, executablePath);
    if (isOwnHelper && this.terminate(listener.processId)) {
      console.info(
        `[${this.logLabel}] Reclaimed port ${this.preferredPort} from stale helper ${listener.processId}.`
      );
      return this.preferredPort;
    }
    const fallbackPort = await this.findFreePortImplementation();
    console.info(
      `[${this.logLabel}] Port ${this.preferredPort} is held by process ${listener.processId} ` +
        `(${listener.commandLine}); launching on ${fallbackPort} instead.`
    );
    return fallbackPort;
  }

  /**
   * Recognizes only this app's own helper as safe to evict.
   *
   * The executable path is the whole signal: this exact file can only be this
   * app's helper, and another app shipping the same binary runs it from its own
   * directory.
   */
  private static isOwnProcess(commandLine: string, executablePath: string): boolean {
    return commandLine.includes(executablePath);
  }

  private static listenerOnPort(port: number): PortListener | null {
    try {
      const processIds = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
        encoding: 'utf8',
        timeout: 3000
      })
        .split('\n')
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((value) => Number.isInteger(value) && value > 0);
      if (processIds.length === 0) {
        return null;
      }
      const processId = processIds[0]!;
      const commandLine = execFileSync('ps', ['-o', 'command=', '-p', String(processId)], {
        encoding: 'utf8',
        timeout: 3000
      }).trim();
      return { processId, commandLine };
    } catch {
      // `lsof` exits non-zero when nothing is listening, which is the common case.
      return null;
    }
  }

  /** Sends SIGTERM and reports whether the process actually released the port. */
  private static terminateProcess(processId: number): boolean {
    try {
      process.kill(processId, 'SIGTERM');
    } catch {
      return false;
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        process.kill(processId, 0);
      } catch {
        return true;
      }
      // A short synchronous wait keeps port resolution to a single ordered step;
      // the loop runs only while evicting a helper that is already shutting down.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    return false;
  }

  /** Asks the kernel for an unused loopback port by binding and releasing it. */
  private static freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          server.close(() => reject(new Error('failed to resolve a free loopback port')));
          return;
        }
        const { port } = address;
        server.close(() => resolve(port));
      });
    });
  }
}

export default LocalPortResolver;
