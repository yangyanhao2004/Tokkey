import { spawn, type ChildProcess } from 'node:child_process';
import { constants, rmSync } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  LocalChatRuntimeModel,
  LocalChatRuntimeState,
  LocalModelRuntimeState,
  TokenHubDevice
} from '../../../shared/types';
import type { HubModelConnecting, RunningHubModel } from '../HubModelConnector';
import type {
  LocalModelLaunchRequest,
  LocalModelRuntime
} from '../LocalModelRuntime';
import TokenHubDeviceProbe from './TokenHubDeviceProbe';
import {
  TokenHubPresenceSession,
  TokenHubProtocolClient,
  verifyTokenHubManifest
} from './TokenHubProtocol';
import TokenHubRuntimeLocator from './TokenHubRuntimeLocator';
import TokenHubSerialTransport, {
  type TokenHubCommandTransport
} from './TokenHubSerialTransport';
import TokenHubServerStager, { type TokenHubServerStaging } from './TokenHubServerStager';
import LocalPortResolver from '../../process/LocalPortResolver';

const DEFAULT_SERVER_PORT = 8081;
function serverEndpoint(port: number): string {
  return `http://127.0.0.1:${port}/v1`;
}

/** Builds the exact llama-server argv from resources discovered for this launch. */
export function buildTokenHubServerArguments(options: {
  modelPath: string;
  templatePath: string;
  donglePort: string;
  port: number;
}): string[] {
  return [
    '-m', options.modelPath,
    '--host', '0.0.0.0',
    '--port', String(options.port),
    '--parallel', '1',
    '-ngl', '99',
    '-t', '2',
    '-rea', 'on',
    '--no-mmap',
    '--cache-ram', '0',
    '-ub', '4096',
    '-b', '4096',
    '-c', '16384',
    '-fa', 'on',
    '--no-cache-prompt',
    '--rge', '0',
    '--chat-template-file', options.templatePath,
    '--dongle-port', options.donglePort
  ];
}

const SERVER_CONTEXT_WINDOW_TOKENS = 16_384;
const DEVICE_SCAN_INTERVAL_MS = 1_000;
const SERVER_READINESS_TIMEOUT_MS = 180_000;
const SERVER_STOP_GRACE_MS = 3_000;
const MAX_DIAGNOSTIC_LENGTH = 32 * 1024;

interface DeviceProbing {
  connectedDevices(vendorId?: number, productId?: number): Promise<TokenHubDevice[]>;
}

interface RuntimeLocating {
  resolve(): Promise<{ templatePath: string }>;
}

interface RunningProcess {
  child: ChildProcess;
  serverPath: string;
  serverFileUnlinked: boolean;
  workingDirectory: string;
  output: ProcessOutput;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

type TransportFactory = (device: TokenHubDevice) => Promise<TokenHubCommandTransport>;
type RuntimeStateListener = (state: LocalModelRuntimeState) => void;

class ProcessOutput {
  private value = '';

  append(data: Buffer): void {
    this.value = `${this.value}${data.toString('utf8')}`.slice(-MAX_DIAGNOSTIC_LENGTH);
  }

  diagnostic(): string {
    return this.value.trim();
  }
}

function sameDevice(left: TokenHubDevice | null, right: TokenHubDevice | null): boolean {
  return left?.identity === right?.identity && left?.calloutPath === right?.calloutPath;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

function stagedTokenHubServerPath(): string {
  return path.join(os.tmpdir(), 'tokkey-tokenhub-runtime', 'llama-server');
}

/** Owns the single authenticated Dongle/server lifecycle used by local model deployment and Chat. */
export class TokenHubRuntime implements LocalModelRuntime {
  private readonly listeners = new Set<RuntimeStateListener>();
  private readonly deviceProbe: DeviceProbing;
  private readonly transportFactory: TransportFactory;
  private readonly runtimeLocator: RuntimeLocating;
  private readonly serverStager: TokenHubServerStaging;
  private readonly portResolver: LocalPortResolver;
  private readonly profileConnector: HubModelConnecting | null;
  private state: LocalModelRuntimeState = {
    phase: 'idle',
    modelId: null,
    endpoint: null,
    error: null,
    device: null
  };
  private monitorTimer: NodeJS.Timeout | null = null;
  private activeTransport: TokenHubCommandTransport | null = null;
  private activeStagedServerPath: string | null = null;
  private activeProcess: RunningProcess | null = null;
  private activeChatServer: {
    modelId: string;
    endpoint: string;
  } | null = null;
  private selectedChatModel: LocalChatRuntimeModel | null = null;
  private startReserved = false;
  private generation = 0;

  constructor(options: {
    deviceProbe?: DeviceProbing;
    transportFactory?: TransportFactory;
    runtimeLocator?: RuntimeLocating;
    serverStager?: TokenHubServerStaging;
    portResolver?: LocalPortResolver;
    profileConnector?: HubModelConnecting | null;
  } = {}) {
    this.deviceProbe = options.deviceProbe ?? new TokenHubDeviceProbe();
    this.transportFactory = options.transportFactory ?? (async (device) => {
      const transport = new TokenHubSerialTransport(device.calloutPath);
      await transport.open();
      return transport;
    });
    this.runtimeLocator = options.runtimeLocator ?? new TokenHubRuntimeLocator();
    this.serverStager = options.serverStager ?? new TokenHubServerStager();
    this.portResolver = options.portResolver ?? new LocalPortResolver({
      preferredPort: DEFAULT_SERVER_PORT,
      logLabel: 'TokenHub'
    });
    this.profileConnector = options.profileConnector ?? null;
  }

  /** Starts one shared one-second USB presence scan. */
  startMonitoring(): void {
    if (this.monitorTimer) return;
    void this.refreshDevice();
    this.monitorTimer = setInterval(() => void this.refreshDevice(), DEVICE_SCAN_INTERVAL_MS);
    this.monitorTimer.unref();
  }

  subscribe(listener: RuntimeStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getState(): Promise<LocalModelRuntimeState> {
    await this.refreshDevice();
    return this.snapshot();
  }

  /** Returns the renderer-safe state of the one Hub-authenticated Chat runtime. */
  getLocalChatRuntimeState(): LocalChatRuntimeState {
    const model = this.selectedChatModel && this.selectedChatModel.id === this.state.modelId
      ? { ...this.selectedChatModel }
      : null;
    const status = this.chatStatusForPhase(this.state.phase);
    return {
      status,
      model,
      contextWindowTokens: model ? SERVER_CONTEXT_WINDOW_TOKENS : null,
      error: this.state.error
    };
  }

  /** Resolves the Chat route only for the currently authenticated Hub model. */
  chatCompletionsUrl(modelId: string): string {
    const server = this.requireActiveChatServer(modelId);
    return `${server.endpoint}/chat/completions`;
  }

  /** Validates the active model before returning its unauthenticated local headers. */
  chatRequestHeaders(modelId: string): Record<string, string> {
    this.requireActiveChatServer(modelId);
    return {};
  }

  async startModel(model: LocalModelLaunchRequest): Promise<LocalModelRuntimeState> {
    if (this.startReserved || this.state.phase === 'starting' || this.state.phase === 'running') {
      throw new Error('Another local model is already starting or running.');
    }
    this.startReserved = true;
    const attempt = ++this.generation;
    try {
      if (path.extname(model.filePath).toLowerCase() !== '.gguf') {
        throw new Error(`The selected local model is not a GGUF file: ${model.filePath}`);
      }
      await access(model.filePath, constants.R_OK).catch(() => {
        throw new Error(`The selected local model no longer exists: ${model.filePath}`);
      });
      this.assertCurrent(attempt);
      this.selectedChatModel = { id: model.id, label: model.label };

      const [device] = await this.deviceProbe.connectedDevices();
      this.assertCurrent(attempt);
      if (!device) {
        this.setState({
          phase: 'failed',
          modelId: model.id,
          endpoint: null,
          error: 'Insert an Amis Hub before starting a model.',
          device: null
        });
        throw new Error('Insert an Amis Hub before starting a model.');
      }

      this.setState({
        phase: 'starting',
        modelId: model.id,
        endpoint: null,
        error: null,
        device
      });
      console.info(`[TokenHub] Starting local model ${model.fileName}.`);
      try {
        await this.runStart(attempt, device, model);
        return this.snapshot();
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        if (this.generation === attempt) {
          await this.releaseOwnedResources();
          this.setState({
            phase: 'failed',
            modelId: model.id,
            endpoint: null,
            error: error.message,
            device: this.state.device
          });
        }
        throw error;
      }
    } finally {
      this.startReserved = false;
    }
  }

  async stopModel(): Promise<LocalModelRuntimeState> {
    this.generation += 1;
    await this.releaseOwnedResources();
    this.setState({
      phase: 'idle',
      modelId: null,
      endpoint: null,
      error: null,
      device: this.state.device
    });
    this.selectedChatModel = null;
    return this.snapshot();
  }

  /** Synchronous app-exit signal; the child process group is killed immediately. */
  shutdownNow(): void {
    this.generation += 1;
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
    void this.activeTransport?.close();
    this.activeTransport = null;
    const stagedServerPath = this.activeStagedServerPath;
    this.activeStagedServerPath = null;
    if (stagedServerPath) this.removeStagedServerNow(stagedServerPath);
    this.activeChatServer = null;
    const running = this.activeProcess;
    this.activeProcess = null;
    if (running) {
      this.signalProcess(running.child, 'SIGTERM');
      this.signalProcess(running.child, 'SIGKILL');
      this.cleanupRunningFilesNow(running);
    }
  }

  private async runStart(
    attempt: number,
    device: TokenHubDevice,
    model: LocalModelLaunchRequest
  ): Promise<void> {
    const transport = await this.transportFactory(device);
    let presence: TokenHubPresenceSession | null = null;
    let stagedServerPath: string | null = null;
    try {
      this.assertCurrent(attempt);
      this.activeTransport = transport;
      const client = new TokenHubProtocolClient(transport);
      const identity = await client.readCertifiedIdentity();
      console.info('[TokenHub] Dongle identity and certificate authenticated.');

      const resources = await this.runtimeLocator.resolve();
      const serverPath = stagedTokenHubServerPath();
      const port = await this.portResolver.resolve(serverPath);
      presence = new TokenHubPresenceSession(client, identity);
      await presence.authenticate();
      const manifest = verifyTokenHubManifest(await client.applicationManifest(), identity.deviceId);
      stagedServerPath = serverPath;
      this.activeStagedServerPath = serverPath;
      await this.serverStager.stage({
        client,
        lease: presence,
        manifest,
        serverPath,
        assertCurrent: () => this.assertCurrent(attempt)
      });
      console.info('[TokenHub] Downloaded and verified llama-server from the Dongle.');

      await presence.refresh();
      await presence.close();
      presence = null;
      await transport.close();
      if (this.activeTransport === transport) this.activeTransport = null;
      this.assertCurrent(attempt);

      let running = await this.launchServer(
        { serverPath, templatePath: resources.templatePath },
        device,
        model,
        port
      );
      stagedServerPath = null;
      this.activeStagedServerPath = null;
      try {
        this.assertCurrent(attempt);
        this.activeProcess = running;
        console.info(`[TokenHub] llama-server launched with pid ${running.child.pid ?? 'unknown'}.`);
        await this.waitUntilReady(running, port, attempt);
        await this.removeStagedServer(running.serverPath);
        const readyRunning = { ...running, serverFileUnlinked: true };
        if (this.activeProcess === running) this.activeProcess = readyRunning;
        running = readyRunning;
        console.info('[TokenHub] llama-server readiness check passed.');
        const runningModel: RunningHubModel = {
          deviceId: identity.deviceId.toString('hex'),
          displayName: model.label,
          modelName: model.fileName,
          endpoint: serverEndpoint(port),
          apiKey: ''
        };
        this.assertCurrent(attempt);
        this.activeChatServer = {
          modelId: model.id,
          endpoint: serverEndpoint(port)
        };
        this.setState({
          phase: 'running',
          modelId: model.id,
          endpoint: serverEndpoint(port),
          error: null,
          device
        });
        void this.observeExit(running, attempt, model.id);
        await this.synchronizeProfile(runningModel, running, attempt);
      } catch (error) {
        if (this.activeProcess === running) this.activeProcess = null;
        this.activeChatServer = null;
        await this.stopProcess(running);
        throw error;
      }
    } finally {
      if (presence) await presence.close().catch(() => undefined);
      if (stagedServerPath) {
        await this.removeStagedServer(stagedServerPath).catch((error) => {
          console.warn(`[TokenHub] Could not clean up staged llama-server: ${String(error)}`);
        });
        if (this.activeStagedServerPath === stagedServerPath) this.activeStagedServerPath = null;
      }
      if (this.activeTransport === transport) this.activeTransport = null;
      await transport.close().catch(() => undefined);
    }
  }

  /** A Gateway/profile failure must not tear down an authenticated, ready server. */
  private async synchronizeProfile(
    model: RunningHubModel,
    running: RunningProcess,
    attempt: number
  ): Promise<void> {
    if (!this.profileConnector) return;
    try {
      await this.profileConnector.connect(model);
      console.info('[TokenHub] Hub model profile synchronized.');
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      console.error('[TokenHub] Hub model profile synchronization failed:', error);
      if (
        this.generation === attempt &&
        this.activeProcess === running &&
        this.state.phase === 'running'
      ) {
        this.setState({
          ...this.state,
          error: `The model is running, but its Gateway profile could not be synchronized: ${error.message}`
        });
      }
    }
  }

  private async launchServer(
    resources: { serverPath: string; templatePath: string },
    device: TokenHubDevice,
    model: LocalModelLaunchRequest,
    port: number
  ): Promise<RunningProcess> {
    const workingDirectory = await mkdtemp(path.join(os.tmpdir(), 'tokkey-tokenhub-'));
    const args = buildTokenHubServerArguments({
      modelPath: model.filePath,
      templatePath: resources.templatePath,
      donglePort: device.calloutPath,
      port
    });
    const child = spawn(resources.serverPath, args, {
      cwd: workingDirectory,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const output = new ProcessOutput();
    child.stdout?.on('data', (data: Buffer) => output.append(data));
    child.stderr?.on('data', (data: Buffer) => output.append(data));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
      child.once('error', () => resolve({ code: child.exitCode, signal: child.signalCode }));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    } catch (cause) {
      await Promise.allSettled([
        rm(workingDirectory, { recursive: true, force: true }),
        this.removeStagedServer(resources.serverPath)
      ]);
      throw new Error(`The Amis Hub llama-server could not be launched: ${String(cause)}`);
    }
    return {
      child,
      serverPath: resources.serverPath,
      serverFileUnlinked: false,
      workingDirectory,
      output,
      exited
    };
  }

  private async waitUntilReady(
    running: RunningProcess,
    port: number,
    attempt: number
  ): Promise<void> {
    const deadline = Date.now() + SERVER_READINESS_TIMEOUT_MS;
    let lastDetail = 'server did not answer';
    while (Date.now() < deadline) {
      this.assertCurrent(attempt);
      if (running.child.exitCode !== null || running.child.signalCode !== null) {
        throw this.exitedServerError(running);
      }
      try {
        const response = await fetch(`${serverEndpoint(port)}/models`, {
          signal: AbortSignal.timeout(2_000)
        });
        if (response.ok) return;
        lastDetail = `HTTP ${response.status}`;
      } catch (cause) {
        lastDetail = cause instanceof Error ? cause.message : String(cause);
      }
      await delay(500);
    }
    throw new Error(`The Amis Hub llama-server did not become ready: ${lastDetail}`);
  }

  private async observeExit(
    running: RunningProcess,
    attempt: number,
    modelId: string
  ): Promise<void> {
    await running.exited;
    await this.cleanupRunningFiles(running);
    if (this.generation !== attempt || this.activeProcess !== running) return;
    this.activeProcess = null;
    this.activeChatServer = null;
    this.setState({
      phase: 'failed',
      modelId,
      endpoint: null,
      error: this.exitedServerError(running).message,
      device: this.state.device
    });
  }

  private exitedServerError(running: RunningProcess): Error {
    const code = running.child.exitCode;
    const signal = running.child.signalCode;
    const diagnostic = running.output.diagnostic();
    const suffix = diagnostic ? `\n${diagnostic}` : '';
    return new Error(`The Amis Hub llama-server exited (${signal ?? code ?? 'unknown'}).${suffix}`);
  }

  private async refreshDevice(): Promise<void> {
    let connectedDevices: TokenHubDevice[];
    try {
      connectedDevices = await this.deviceProbe.connectedDevices();
    } catch (error) {
      console.warn(`[TokenHub] Device scan failed: ${String(error)}`);
      return;
    }
    const wasActive = this.state.phase === 'starting' || this.state.phase === 'running';
    const activeDevice = this.state.device;
    const activeDeviceStillConnected = activeDevice !== null && connectedDevices.some(
      (candidate) => sameDevice(candidate, activeDevice)
    );
    const device = wasActive && activeDeviceStillConnected
      ? activeDevice
      : connectedDevices[0] ?? null;
    if (sameDevice(device, this.state.device)) return;
    const modelId = this.state.modelId;
    this.state = { ...this.state, device };
    this.publish();
    if (wasActive && !activeDeviceStillConnected) {
      this.generation += 1;
      await this.releaseOwnedResources();
      this.setState({
        phase: 'failed',
        modelId,
        endpoint: null,
        error: 'The Amis Hub authentication device was removed or replaced.',
        device
      });
    }
  }

  private async releaseOwnedResources(): Promise<void> {
    const transport = this.activeTransport;
    this.activeTransport = null;
    await transport?.close().catch(() => undefined);
    const stagedServerPath = this.activeStagedServerPath;
    this.activeStagedServerPath = null;
    if (stagedServerPath) {
      await this.removeStagedServer(stagedServerPath).catch((error) => {
        console.warn(`[TokenHub] Could not clean up staged llama-server: ${String(error)}`);
      });
    }
    const running = this.activeProcess;
    this.activeProcess = null;
    this.activeChatServer = null;
    if (running) await this.stopProcess(running);
  }

  private async stopProcess(running: RunningProcess): Promise<void> {
    if (running.child.exitCode === null && running.child.signalCode === null) {
      this.signalProcess(running.child, 'SIGTERM');
      await Promise.race([running.exited.then(() => undefined), delay(SERVER_STOP_GRACE_MS)]);
      if (running.child.exitCode === null && running.child.signalCode === null) {
        this.signalProcess(running.child, 'SIGKILL');
        await running.exited;
      }
    }
    await this.cleanupRunningFiles(running);
  }

  private async cleanupRunningFiles(running: RunningProcess): Promise<void> {
    const cleanup = [rm(running.workingDirectory, { recursive: true, force: true })];
    if (!running.serverFileUnlinked) cleanup.push(this.removeStagedServer(running.serverPath));
    const results = await Promise.allSettled(cleanup);
    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn(`[TokenHub] Could not clean up temporary runtime files: ${String(result.reason)}`);
      }
    }
  }

  private async removeStagedServer(serverPath: string): Promise<void> {
    try {
      await this.serverStager.remove(serverPath);
    } catch (error) {
      console.warn(`[TokenHub] Direct staged llama-server removal failed; removing its private directory: ${String(error)}`);
    }
    await rm(path.dirname(serverPath), {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50
    });
  }

  private removeStagedServerNow(serverPath: string): void {
    try {
      rmSync(path.dirname(serverPath), { recursive: true, force: true });
    } catch (error) {
      console.warn(`[TokenHub] Could not synchronously remove staged llama-server: ${String(error)}`);
    }
  }

  private cleanupRunningFilesNow(running: RunningProcess): void {
    try {
      rmSync(running.workingDirectory, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[TokenHub] Could not synchronously remove temporary server files: ${String(error)}`);
    }
    if (!running.serverFileUnlinked) this.removeStagedServerNow(running.serverPath);
  }

  private signalProcess(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  }

  private assertCurrent(attempt: number): void {
    if (this.generation !== attempt) throw new Error('The Amis Hub model startup was stopped.');
  }

  private requireActiveChatServer(modelId: string): {
    modelId: string;
    endpoint: string;
  } {
    const server = this.activeChatServer;
    if (
      !server ||
      this.state.phase !== 'running' ||
      server.modelId !== modelId ||
      this.state.modelId !== modelId
    ) {
      throw new Error('The selected Hub-authenticated local model is not running.');
    }
    return server;
  }

  private chatStatusForPhase(phase: LocalModelRuntimeState['phase']): LocalChatRuntimeState['status'] {
    switch (phase) {
    case 'idle': return 'unavailable';
    case 'starting': return 'starting';
    case 'running': return 'ready';
    case 'failed': return 'error';
    }
  }

  private setState(state: LocalModelRuntimeState): void {
    this.state = state;
    this.publish();
  }

  private snapshot(): LocalModelRuntimeState {
    return {
      ...this.state,
      device: this.state.device ? { ...this.state.device } : null
    };
  }

  private publish(): void {
    const state = this.snapshot();
    this.listeners.forEach((listener) => listener(state));
  }
}

export default TokenHubRuntime;
