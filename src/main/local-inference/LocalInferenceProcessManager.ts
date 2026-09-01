import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { LocalChatRuntimeModel, LocalChatRuntimeState } from '../../shared/types';
import LocalInferencePortResolver from './LocalInferencePortResolver';
import LocalInferenceRuntimeLocator from './LocalInferenceRuntimeLocator';

const DEFAULT_CONTEXT_WINDOW_TOKENS = 4_096;
const DEFAULT_READINESS_TIMEOUT_MS = 120_000;
const READINESS_POLL_INTERVAL_MS = 500;
const MAX_RESTART_ATTEMPTS = 5;
const RESTART_BASE_DELAY_MS = 2_000;
const RESTART_CAP_DELAY_MS = 60_000;
const STDERR_TAIL_LIMIT = 30;
const SHUTDOWN_TIMEOUT_MS = 5_000;

/** One GGUF model file eligible for the app-owned inference runtime. */
export interface LocalInferenceModel {
  id: string;
  label: string;
  filePath: string;
}

/** Allows the local Chat executor to resolve the one ready, loopback endpoint. */
export interface LocalInferenceRuntimeServing {
  getState(): LocalChatRuntimeState;
  chatCompletionsUrl(modelId: string): string;
}

export interface LocalInferenceProcessManagerOptions {
  projectRoot?: string;
  resourcesPath?: string;
  locator?: LocalInferenceRuntimeLocator;
  portResolver?: LocalInferencePortResolver;
  spawnProcess?: typeof spawn;
  healthCheck?: (baseUrl: string) => Promise<boolean>;
  delay?: (milliseconds: number) => Promise<void>;
  modelFileExists?: (filePath: string) => Promise<boolean>;
  readinessTimeoutMs?: number;
  contextWindowTokens?: number;
}

/** Raised when the bundled local inference runtime cannot become usable. */
export class LocalInferenceStartupError extends Error {
  constructor(message: string, readonly diagnostics: string) {
    super(diagnostics ? `${message}\n${diagnostics}` : message);
    this.name = 'LocalInferenceStartupError';
  }
}

/**
 * Supervises one app-owned `llama-server` process and exposes only a loopback
 * OpenAI-compatible endpoint. The manager intentionally loads one model at a
 * time: switching models terminates the previous process before the next one
 * is launched, so a Chat turn can never reach a stale model file.
 */
export class LocalInferenceProcessManager implements LocalInferenceRuntimeServing {
  private readonly locator: LocalInferenceRuntimeLocator;
  private readonly portResolver: LocalInferencePortResolver;
  private readonly spawnProcess: typeof spawn;
  private readonly healthCheck: (baseUrl: string) => Promise<boolean>;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly modelFileExists: (filePath: string) => Promise<boolean>;
  private readonly readinessTimeoutMs: number;
  private readonly contextWindowTokens: number;

  private child: ChildProcess | null = null;
  private baseUrl: string | null = null;
  private desiredModel: LocalInferenceModel | null = null;
  private state: LocalChatRuntimeState = {
    status: 'unavailable',
    model: null,
    contextWindowTokens: null,
    error: null
  };
  private stateListener: ((state: LocalChatRuntimeState) => void) | null = null;
  private startup: Promise<LocalChatRuntimeState> | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempts = 0;
  private generation = 0;
  private stderrTail: string[] = [];
  private stderrBuffer = '';

  constructor(options: LocalInferenceProcessManagerOptions = {}) {
    const projectRoot = options.projectRoot ?? path.resolve(__dirname, '../../..');
    this.locator = options.locator ?? new LocalInferenceRuntimeLocator({
      projectRoot,
      resourcesPath: options.resourcesPath
    });
    this.portResolver = options.portResolver ?? new LocalInferencePortResolver();
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.healthCheck = options.healthCheck ?? LocalInferenceProcessManager.defaultHealthCheck;
    this.delay = options.delay ?? LocalInferenceProcessManager.sleep;
    this.modelFileExists = options.modelFileExists ?? LocalInferenceProcessManager.defaultModelFileExists;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.contextWindowTokens = options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  }

  /** Returns a snapshot safe to hand across IPC boundaries. */
  getState(): LocalChatRuntimeState {
    return {
      ...this.state,
      model: this.state.model ? { ...this.state.model } : null
    };
  }

  /** Lets model lifecycle rows reflect a runtime crash or a completed launch. */
  setStateListener(listener: ((state: LocalChatRuntimeState) => void) | null): void {
    this.stateListener = listener;
  }

  /** Starts the local server for one downloaded GGUF artifact. */
  async start(model: LocalInferenceModel): Promise<LocalChatRuntimeState> {
    if (!model.id.trim() || !model.label.trim() || !model.filePath.trim()) {
      throw new LocalInferenceStartupError('The selected local model is incomplete.', 'Missing model id, label, or file path.');
    }
    if (this.isReadyFor(model) && this.baseUrl && await this.healthCheck(this.baseUrl)) {
      return this.getState();
    }
    if (this.startup && this.matchesDesiredModel(model)) {
      return this.startup;
    }

    await this.stop('switching local model');
    this.restartAttempts = 0;
    this.desiredModel = { ...model };
    const generation = ++this.generation;
    const startup = this.launch(model, generation);
    this.startup = startup;
    try {
      return await startup;
    } finally {
      if (this.startup === startup) {
        this.startup = null;
      }
    }
  }

  /** Stops the runtime only when it currently owns the requested model. */
  async stopModel(modelId: string, reason: string): Promise<void> {
    if (this.state.model?.id !== modelId && this.desiredModel?.id !== modelId) {
      return;
    }
    await this.stop(reason);
  }

  /** Stops the owned runtime and prevents automatic restart. */
  async stop(reason: string): Promise<void> {
    ++this.generation;
    this.desiredModel = null;
    this.restartAttempts = 0;
    this.clearRestartTimer();
    const child = this.child;
    this.child = null;
    this.baseUrl = null;
    if (child) {
      console.info(`[LocalInference] Runtime stopped: ${reason}.`);
      await this.waitForChildExit(child);
    }
    this.publish({ status: 'unavailable', model: null, contextWindowTokens: null, error: null });
  }

  /** Resolves the one endpoint the Chat executor may contact. */
  chatCompletionsUrl(modelId: string): string {
    if (!this.baseUrl || this.state.status !== 'ready' || this.state.model?.id !== modelId) {
      throw new Error('The selected local model is not running.');
    }
    return new URL('/v1/chat/completions', this.baseUrl).toString();
  }

  private async launch(model: LocalInferenceModel, generation: number): Promise<LocalChatRuntimeState> {
    const runtime = this.locator.locate();
    if (!runtime) {
      return this.failLaunch(
        model,
        generation,
        'The bundled local inference runtime is unavailable.',
        `Searched: ${this.locator.searchPath()}\nSet TOKIIE_LOCAL_INFERENCE_SERVER while developing.`
      );
    }
    if (!(await this.modelFileExists(model.filePath))) {
      return this.failLaunch(
        model,
        generation,
        'The selected local model file is unavailable.',
        `Expected a readable GGUF file at ${model.filePath}.`
      );
    }

    const port = await this.portResolver.resolve();
    this.ensureCurrentGeneration(generation);
    const baseUrl = `http://127.0.0.1:${port}`;
    this.stderrTail = [];
    this.stderrBuffer = '';
    this.baseUrl = baseUrl;
    this.publish({
      status: 'starting',
      model: this.toRuntimeModel(model),
      contextWindowTokens: this.contextWindowTokens,
      error: null
    });

    let child: ChildProcess | null = null;
    let launchError: Error | null = null;

    try {
      const spawnedChild = this.spawnProcess(
        runtime.executablePath,
        [
          '--model', model.filePath,
          '--host', '127.0.0.1',
          '--port', String(port),
          '--ctx-size', String(this.contextWindowTokens),
          '--no-webui',
          // Keep reasoning enabled so reasoning-capable local models can emit
          // activity events while the transcript remains focused on the reply.
          '--reasoning', 'on'
        ],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
          env: { ...process.env, NO_PROXY: '127.0.0.1,localhost,::1' }
        }
      );
      child = spawnedChild;
      spawnedChild.stderr?.setEncoding('utf8');
      spawnedChild.stderr?.on('data', (chunk: string) => this.consumeStderr(chunk));
      spawnedChild.once('error', (error) => {
        launchError = error instanceof Error ? error : new Error(String(error));
      });
      spawnedChild.on('exit', (code, signal) => this.handleExit(spawnedChild, code, signal));
      this.child = spawnedChild;

      await this.waitForReadiness(baseUrl, spawnedChild, generation, () => launchError);
      this.ensureCurrentGeneration(generation);
      this.restartAttempts = 0;
      this.publish({
        status: 'ready',
        model: this.toRuntimeModel(model),
        contextWindowTokens: this.contextWindowTokens,
        error: null
      });
      return this.getState();
    } catch (error) {
      if (generation !== this.generation) {
        throw error;
      }
      if (child && this.child === child) {
        this.child = null;
        await this.waitForChildExit(child);
      }
      this.baseUrl = null;
      this.desiredModel = null;
      const diagnostics = this.diagnostics();
      const message = error instanceof Error ? error.message : String(error);
      this.publish({
        status: 'error',
        model: this.toRuntimeModel(model),
        contextWindowTokens: this.contextWindowTokens,
        error: message
      });
      throw new LocalInferenceStartupError(message, diagnostics);
    }
  }

  private async waitForReadiness(
    baseUrl: string,
    child: ChildProcess,
    generation: number,
    getLaunchError: () => Error | null
  ): Promise<void> {
    const deadline = Date.now() + this.readinessTimeoutMs;
    while (Date.now() < deadline) {
      this.ensureCurrentGeneration(generation);
      const launchError = getLaunchError();
      if (launchError) {
        throw launchError;
      }
      if (this.child !== child) {
        throw new Error('The local inference runtime stopped before becoming ready.');
      }
      if (await this.healthCheck(baseUrl)) {
        return;
      }
      await this.delay(READINESS_POLL_INTERVAL_MS);
    }
    throw new Error(`The local inference runtime did not become ready within ${Math.ceil(this.readinessTimeoutMs / 1_000)} seconds.`);
  }

  private handleExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) {
      return;
    }
    this.child = null;
    this.baseUrl = null;
    const model = this.desiredModel;
    if (!model) {
      return;
    }
    const message = `Local inference runtime exited unexpectedly (code ${code}, signal ${signal}).`;
    console.error(`[LocalInference] ${message}\n${this.diagnostics()}`);
    this.publish({
      status: 'error',
      model: this.toRuntimeModel(model),
      contextWindowTokens: this.contextWindowTokens,
      error: message
    });
    this.scheduleRestart(model);
  }

  private scheduleRestart(model: LocalInferenceModel): void {
    if (this.restartTimer || !this.matchesDesiredModel(model)) {
      return;
    }
    if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      this.desiredModel = null;
      this.publish({
        status: 'error',
        model: this.toRuntimeModel(model),
        contextWindowTokens: this.contextWindowTokens,
        error: 'The local inference runtime stopped repeatedly. Start the model again to retry.'
      });
      return;
    }
    this.restartAttempts += 1;
    const delayMs = Math.min(RESTART_BASE_DELAY_MS * 2 ** (this.restartAttempts - 1), RESTART_CAP_DELAY_MS);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.matchesDesiredModel(model) || this.child || this.startup) {
        return;
      }
      const generation = ++this.generation;
      const restart = this.launch(model, generation);
      this.startup = restart;
      void restart
        .finally(() => {
          if (this.startup === restart) {
            this.startup = null;
          }
        })
        .catch((error: unknown) => {
          console.error('[LocalInference] Automatic runtime restart failed:', error);
        });
    }, delayMs);
    this.restartTimer.unref?.();
  }

  private failLaunch(
    model: LocalInferenceModel,
    generation: number,
    message: string,
    diagnostics: string
  ): never {
    this.ensureCurrentGeneration(generation);
    this.desiredModel = null;
    this.publish({
      status: 'error',
      model: this.toRuntimeModel(model),
      contextWindowTokens: this.contextWindowTokens,
      error: message
    });
    throw new LocalInferenceStartupError(message, diagnostics);
  }

  private ensureCurrentGeneration(generation: number): void {
    if (generation !== this.generation) {
      throw new Error('The local inference startup was superseded.');
    }
  }

  private isReadyFor(model: LocalInferenceModel): boolean {
    return this.state.status === 'ready' && this.state.model?.id === model.id;
  }

  private matchesDesiredModel(model: LocalInferenceModel): boolean {
    return this.desiredModel?.id === model.id;
  }

  private toRuntimeModel(model: LocalInferenceModel): LocalChatRuntimeModel {
    return { id: model.id, label: model.label };
  }

  private publish(next: LocalChatRuntimeState): void {
    this.state = {
      ...next,
      model: next.model ? { ...next.model } : null
    };
    this.stateListener?.(this.getState());
  }

  private consumeStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    const lines = this.stderrBuffer.split('\n');
    this.stderrBuffer = lines.pop() ?? '';
    this.stderrTail = [...this.stderrTail, ...lines.filter((line) => line.length > 0)].slice(-STDERR_TAIL_LIMIT);
  }

  private diagnostics(): string {
    return this.stderrTail.length > 0 ? this.stderrTail.join('\n') : 'No runtime stderr was captured.';
  }

  private clearRestartTimer(): void {
    if (!this.restartTimer) {
      return;
    }
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  /** Waits for a replaced runtime to release its model memory before another starts. */
  private waitForChildExit(child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.removeListener('exit', finish);
        child.removeListener('error', finish);
        resolve();
      };
      const timeout = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // A process that has already exited needs no further cleanup.
        }
        finish();
      }, SHUTDOWN_TIMEOUT_MS);
      timeout.unref?.();

      child.once('exit', finish);
      child.once('error', finish);
      try {
        if (!child.kill('SIGTERM')) finish();
      } catch {
        finish();
      }
    });
  }

  private static async defaultHealthCheck(baseUrl: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetch(new URL('/health', baseUrl), { signal: controller.signal });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private static async defaultModelFileExists(filePath: string): Promise<boolean> {
    try {
      return (await stat(filePath)).isFile();
    } catch {
      return false;
    }
  }

  private static sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}

export default LocalInferenceProcessManager;
