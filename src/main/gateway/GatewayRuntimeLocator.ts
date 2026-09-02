import { accessSync, constants } from 'node:fs';
import path from 'node:path';

/** Where the gateway executable was found, and which layout it came from. */
export interface GatewayRuntimeLocation {
  executablePath: string;
  source: 'override' | 'bundled' | 'development';
}

export interface GatewayRuntimeLocatorOptions {
  /** Repository root, used to reach the checked-out `resources/` tree. */
  projectRoot: string;
  /** Electron's `process.resourcesPath`; absent outside a packaged app. */
  resourcesPath?: string;
  /** Process environment, injected so tests can drive the override path. */
  environment?: NodeJS.ProcessEnv;
  /** `arm64` or `x64`, naming the per-architecture folder `gateway:freeze` writes. */
  architecture?: string;
  /** Executable check, injected so tests need no binary on disk. */
  isExecutable?: (candidatePath: string) => boolean;
}

/**
 * Resolves the frozen gateway executable.
 *
 * The gateway ships as a PyInstaller bundle rather than a Python interpreter
 * plus source tree, so nothing here looks for an interpreter, a virtualenv, or
 * an importable module: the executable is self-contained and locates its own
 * dependencies in the sibling `_internal` directory. Three layouts are
 * supported, in priority order — an explicit developer override, the bundle
 * copied into a packaged app's resources, and the same bundle sitting in the
 * checked-out `resources/` tree during development.
 */
export class GatewayRuntimeLocator {
  private static readonly OVERRIDE_VARIABLE = 'AMIS_GATEWAY_EXECUTABLE';
  /**
   * Layout written by `npm run gateway:freeze`, mirroring `TokenHubRuntime`:
   * `<root>/GatewayRuntime/<arch>/amis-gateway/amis-gateway`. The leaf folder
   * is PyInstaller's `COLLECT` name from `packaging/amis-gateway.spec`.
   */
  private static readonly RUNTIME_DIRECTORY = 'GatewayRuntime';
  private static readonly BUNDLE_DIRECTORY = 'amis-gateway';
  private static readonly EXECUTABLE_NAME = 'amis-gateway';

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

  /** Returns the first usable executable, or null when none is installed. */
  locate(): GatewayRuntimeLocation | null {
    return this.candidates().find((candidate) => this.isExecutable(candidate.executablePath)) ?? null;
  }

  /** Every path that was considered, for use in "runtime missing" diagnostics. */
  searchPath(): string {
    return this.candidates().map((candidate) => candidate.executablePath).join(':');
  }

  private candidates(): GatewayRuntimeLocation[] {
    const candidates: GatewayRuntimeLocation[] = [];
    const override = this.environment[GatewayRuntimeLocator.OVERRIDE_VARIABLE];
    if (override) {
      candidates.push({ executablePath: override, source: 'override' });
    }
    if (this.resourcesPath) {
      candidates.push({
        executablePath: this.bundlePath(this.resourcesPath),
        source: 'bundled'
      });
    }
    candidates.push({
      executablePath: this.bundlePath(path.join(this.projectRoot, 'resources')),
      source: 'development'
    });
    return candidates;
  }

  /**
   * Builds the executable path under a resources root.
   *
   * The architecture segment is `process.arch` verbatim, matching both the
   * folder `gateway:freeze` writes and `TokenHubRuntimeLocator`'s lookup. An
   * earlier layout mapped `x64` onto `x86_64`; that mapping is gone, so a
   * future Intel build must land in `x64/` alongside the Apple Silicon tree.
   */
  private bundlePath(resourcesRoot: string): string {
    return path.join(
      resourcesRoot,
      GatewayRuntimeLocator.RUNTIME_DIRECTORY,
      this.architecture,
      GatewayRuntimeLocator.BUNDLE_DIRECTORY,
      GatewayRuntimeLocator.EXECUTABLE_NAME
    );
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
