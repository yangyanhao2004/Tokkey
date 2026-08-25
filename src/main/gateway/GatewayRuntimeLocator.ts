import { accessSync, constants } from 'node:fs';
import path from 'node:path';

/** Where the gateway interpreter was found, and which layout it came from. */
export interface GatewayRuntimeLocation {
  interpreterPath: string;
  source: 'override' | 'bundled' | 'development';
}

export interface GatewayRuntimeLocatorOptions {
  /** Repository root, used to reach the development virtualenv. */
  projectRoot: string;
  /** Electron's `process.resourcesPath`; absent outside a packaged app. */
  resourcesPath?: string;
  /** Process environment, injected so tests can drive the override path. */
  environment?: NodeJS.ProcessEnv;
  /** `arm64` or `x64`, matching the per-architecture bundled runtime folders. */
  architecture?: string;
  /** Executable check, injected so tests need no interpreter on disk. */
  isExecutable?: (candidatePath: string) => boolean;
}

/**
 * Resolves the Python interpreter that runs the gateway.
 *
 * Three layouts are supported, in priority order: an explicit developer
 * override, the per-architecture interpreter bundled into a packaged app, and
 * the `uv sync` virtualenv used during development. Only the interpreter path
 * is resolved because the relocatable CPython distribution locates its own
 * standard library relative to that binary.
 */
export class GatewayRuntimeLocator {
  private static readonly OVERRIDE_VARIABLE = 'AMIS_GATEWAY_PYTHON';
  private readonly projectRoot: string;
  private readonly resourcesPath: string | undefined;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly architecture: string;
  private readonly isExecutable: (candidatePath: string) => boolean;

  constructor(options: GatewayRuntimeLocatorOptions) {
    this.projectRoot = options.projectRoot;
    this.resourcesPath = options.resourcesPath;
    this.environment = options.environment ?? process.env;
    this.architecture = options.architecture ?? process.arch;
    this.isExecutable = options.isExecutable ?? GatewayRuntimeLocator.canExecute;
  }

  /** Returns the first usable interpreter, or null when none is installed. */
  locate(): GatewayRuntimeLocation | null {
    return this.candidates().find((candidate) => this.isExecutable(candidate.interpreterPath)) ?? null;
  }

  /** Every path that was considered, for use in "interpreter missing" diagnostics. */
  searchPath(): string {
    return this.candidates().map((candidate) => candidate.interpreterPath).join(':');
  }

  private candidates(): GatewayRuntimeLocation[] {
    const candidates: GatewayRuntimeLocation[] = [];
    const override = this.environment[GatewayRuntimeLocator.OVERRIDE_VARIABLE];
    if (override) {
      candidates.push({ interpreterPath: override, source: 'override' });
    }
    if (this.resourcesPath) {
      candidates.push({
        interpreterPath: path.join(
          this.resourcesPath,
          'GatewayRuntime',
          this.runtimeArchitecture(),
          'python',
          'bin',
          'python3'
        ),
        source: 'bundled'
      });
    }
    candidates.push({
      interpreterPath: path.join(this.projectRoot, 'runtime', 'amis-gateway', '.venv', 'bin', 'python3'),
      source: 'development'
    });
    return candidates;
  }

  /** Maps Node's architecture names onto the runtime build's folder names. */
  private runtimeArchitecture(): string {
    return this.architecture === 'x64' ? 'x86_64' : this.architecture;
  }

  private static canExecute(candidatePath: string): boolean {
    try {
      accessSync(candidatePath, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
}

export default GatewayRuntimeLocator;
