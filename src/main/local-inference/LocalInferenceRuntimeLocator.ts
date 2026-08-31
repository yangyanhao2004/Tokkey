import { accessSync, constants } from 'node:fs';
import path from 'node:path';

/** Where the app-owned local inference executable was found. */
export interface LocalInferenceRuntimeLocation {
  executablePath: string;
  source: 'override' | 'bundled' | 'development';
}

export interface LocalInferenceRuntimeLocatorOptions {
  projectRoot: string;
  resourcesPath?: string;
  environment?: NodeJS.ProcessEnv;
  architecture?: string;
  isExecutable?: (candidatePath: string) => boolean;
}

/**
 * Locates the `llama-server` executable that Tokiie owns for GGUF inference.
 *
 * A developer can override the executable while bringing up the integration.
 * Packaged builds read the architecture-specific resource copied into the app;
 * development builds use the matching runtime folder in this repository.
 */
export class LocalInferenceRuntimeLocator {
  private static readonly OVERRIDE_VARIABLE = 'TOKIIE_LOCAL_INFERENCE_SERVER';
  private readonly projectRoot: string;
  private readonly resourcesPath: string | undefined;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly architecture: string;
  private readonly isExecutable: (candidatePath: string) => boolean;

  constructor(options: LocalInferenceRuntimeLocatorOptions) {
    this.projectRoot = options.projectRoot;
    this.resourcesPath = options.resourcesPath;
    this.environment = options.environment ?? process.env;
    this.architecture = options.architecture ?? process.arch;
    this.isExecutable = options.isExecutable ?? LocalInferenceRuntimeLocator.canExecute;
  }

  locate(): LocalInferenceRuntimeLocation | null {
    return this.candidates().find((candidate) => this.isExecutable(candidate.executablePath)) ?? null;
  }

  searchPath(): string {
    return this.candidates().map((candidate) => candidate.executablePath).join(':');
  }

  private candidates(): LocalInferenceRuntimeLocation[] {
    const candidates: LocalInferenceRuntimeLocation[] = [];
    const override = this.environment[LocalInferenceRuntimeLocator.OVERRIDE_VARIABLE];
    if (override) {
      candidates.push({ executablePath: override, source: 'override' });
    }
    if (this.resourcesPath) {
      candidates.push({
        executablePath: path.join(
          this.resourcesPath,
          'LocalInferenceRuntime',
          this.runtimeArchitecture(),
          'llama-server'
        ),
        source: 'bundled'
      });
    }
    candidates.push({
      executablePath: path.join(
        this.projectRoot,
        'runtime',
        'local-inference',
        'bin',
        this.runtimeArchitecture(),
        'llama-server'
      ),
      source: 'development'
    });
    return candidates;
  }

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

export default LocalInferenceRuntimeLocator;
