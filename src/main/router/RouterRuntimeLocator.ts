import { accessSync, constants } from 'node:fs';
import path from 'node:path';

/** Where the router executable was found, and which layout it came from. */
export interface RouterRuntimeLocation {
  executablePath: string;
  source: 'override' | 'bundled' | 'development';
}

export interface RouterRuntimeLocatorOptions {
  /** Repository root, used to reach the checked-out `resources/` tree. */
  projectRoot: string;
  /** Electron's `process.resourcesPath`; absent outside a packaged app. */
  resourcesPath?: string;
  /** Process environment, injected so tests can drive the override path. */
  environment?: NodeJS.ProcessEnv;
  /** Node's `process.platform`, injected so tests can drive every layout. */
  platform?: string;
  /** Node's `process.arch`, injected so tests need no cross-architecture host. */
  architecture?: string;
  /** Executable check, injected so tests need no binary on disk. */
  isExecutable?: (candidatePath: string) => boolean;
}

/**
 * Resolves the router executable for the host platform and architecture.
 *
 * The router is a single self-contained Go binary, so there is no interpreter,
 * bundle directory, or sibling payload to find — only the right file for this
 * machine. `resources/RouterRuntime` is laid out with Go's own names rather than
 * Node's, both in the directory and in the file:
 *
 *     RouterRuntime/<goarch>/router/router-<goos>-<goarch>
 *     RouterRuntime/arm64/router/router-darwin-arm64
 *
 * `process.arch` says `x64` where Go says `amd64`, so the two are mapped here.
 * This is the one place that mapping lives; `GatewayRuntimeLocator` needs none
 * because the gateway is frozen into `process.arch`-named folders instead.
 *
 * Only darwin binaries ship today. An unmapped platform or architecture is not
 * an error here: `locate()` simply finds nothing, and the caller reports the
 * searched paths.
 */
export class RouterRuntimeLocator {
  private static readonly OVERRIDE_VARIABLE = 'AMIS_ROUTER_EXECUTABLE';
  private static readonly RUNTIME_DIRECTORY = 'RouterRuntime';
  private static readonly BUNDLE_DIRECTORY = 'router';
  /** Node's `process.arch` values mapped onto the Go names on disk. */
  private static readonly GO_ARCHITECTURES: Readonly<Record<string, string>> = {
    x64: 'amd64',
    arm64: 'arm64'
  };

  private readonly projectRoot: string;
  private readonly resourcesPath: string | undefined;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly platform: string;
  private readonly architecture: string;
  private readonly isExecutable: (candidatePath: string) => boolean;

  constructor(options: RouterRuntimeLocatorOptions) {
    this.projectRoot = options.projectRoot;
    this.resourcesPath = options.resourcesPath;
    this.environment = options.environment ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.architecture = options.architecture ?? process.arch;
    this.isExecutable = options.isExecutable ?? RouterRuntimeLocator.canExecute;
  }

  /** Returns the first usable executable, or null when none is installed. */
  locate(): RouterRuntimeLocation | null {
    return this.candidates().find((candidate) => this.isExecutable(candidate.executablePath)) ?? null;
  }

  /** Every path that was considered, for use in "runtime missing" diagnostics. */
  searchPath(): string {
    const candidates = this.candidates();
    if (candidates.length === 0) {
      return `no router binary ships for ${this.platform}/${this.architecture}`;
    }
    return candidates.map((candidate) => candidate.executablePath).join(':');
  }

  private candidates(): RouterRuntimeLocation[] {
    const candidates: RouterRuntimeLocation[] = [];
    const override = this.environment[RouterRuntimeLocator.OVERRIDE_VARIABLE];
    if (override) {
      candidates.push({ executablePath: override, source: 'override' });
    }
    const goArchitecture = RouterRuntimeLocator.GO_ARCHITECTURES[this.architecture];
    if (!goArchitecture) {
      // An unsupported host still gets whatever override was set, and nothing else.
      return candidates;
    }
    if (this.resourcesPath) {
      candidates.push({
        executablePath: this.binaryPath(this.resourcesPath, goArchitecture),
        source: 'bundled'
      });
    }
    candidates.push({
      executablePath: this.binaryPath(path.join(this.projectRoot, 'resources'), goArchitecture),
      source: 'development'
    });
    return candidates;
  }

  /** Builds the per-platform binary path under a resources root. */
  private binaryPath(resourcesRoot: string, goArchitecture: string): string {
    const extension = this.platform === 'win32' ? '.exe' : '';
    return path.join(
      resourcesRoot,
      RouterRuntimeLocator.RUNTIME_DIRECTORY,
      goArchitecture,
      RouterRuntimeLocator.BUNDLE_DIRECTORY,
      `router-${this.platform}-${goArchitecture}${extension}`
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

export default RouterRuntimeLocator;
