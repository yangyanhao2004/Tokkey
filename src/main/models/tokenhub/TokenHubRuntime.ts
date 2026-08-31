import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  InstalledLocalModel,
  LocalModelRuntimeState,
  TokenHubDevice
} from '../../../shared/types';
import type { HubModelConnecting, RunningHubModel } from '../HubModelConnector';
import TokenHubDeviceProbe from './TokenHubDeviceProbe';
import {
  parseTokenHubManifest,
  TOKEN_HUB_EXTERNAL_READ_CHUNK_SIZE,
  TokenHubCrc32,
  TokenHubLicenseSession,
  TokenHubProtocolClient,
  type TokenHubApplicationManifest
} from './TokenHubProtocol';
import TokenHubRuntimeLocator from './TokenHubRuntimeLocator';
import TokenHubSerialTransport, {
  type TokenHubCommandTransport
} from './TokenHubSerialTransport';

const SERVER_PORT = 8081;
const SERVER_ENDPOINT = `http://127.0.0.1:${SERVER_PORT}/v1`;
const DEVICE_SCAN_INTERVAL_MS = 1_000;
const SERVER_READINESS_TIMEOUT_MS = 180_000;
const SERVER_STOP_GRACE_MS = 3_000;
const MAX_DIAGNOSTIC_LENGTH = 32 * 1024;

interface DeviceProbing {
  connectedDevices(vendorId?: number, productId?: number): Promise<TokenHubDevice[]>;
}

interface RuntimeLocating {
  resolve(): Promise<{ serverPath: string; templatePath: string }>;
}

interface RunningProcess {
  child: ChildProcess;
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

/** Owns the single authenticated Dongle/server lifecycle used by Tokiie's Start button. */
export class TokenHubRuntime {
  private readonly listeners = new Set<RuntimeStateListener>();
  private readonly deviceProbe: DeviceProbing;
  private readonly transportFactory: TransportFactory;
  private readonly runtimeLocator: RuntimeLocating;
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
  private activeProcess: RunningProcess | null = null;
  private generation = 0;

  constructor(options: {
    deviceProbe?: DeviceProbing;
    transportFactory?: TransportFactory;
    runtimeLocator?: RuntimeLocating;
    profileConnector?: HubModelConnecting | null;
  } = {}) {
    this.deviceProbe = options.deviceProbe ?? new TokenHubDeviceProbe();
    this.transportFactory = options.transportFactory ?? (async (device) => {
      const transport = new TokenHubSerialTransport(device.calloutPath);
      await transport.open();
      return transport;
    });
    this.runtimeLocator = options.runtimeLocator ?? new TokenHubRuntimeLocator();
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

  async startModel(model: InstalledLocalModel): Promise<LocalModelRuntimeState> {
    if (this.state.phase === 'starting' || this.state.phase === 'running') {
      throw new Error('Another local model is already starting or running.');
    }
    if (path.extname(model.filePath).toLowerCase() !== '.gguf') {
      throw new Error(`The selected local model is not a GGUF file: ${model.filePath}`);
    }
    await access(model.filePath, constants.R_OK).catch(() => {
      throw new Error(`The selected local model no longer exists: ${model.filePath}`);
    });

    const [device] = await this.deviceProbe.connectedDevices();
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

    const attempt = ++this.generation;
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
    return this.snapshot();
  }

  /** Synchronous app-exit signal; the child process group is killed immediately. */
  shutdownNow(): void {
    this.generation += 1;
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
    void this.activeTransport?.close();
    this.activeTransport = null;
    const running = this.activeProcess;
    this.activeProcess = null;
    if (running) {
      this.signalProcess(running.child, 'SIGTERM');
      this.signalProcess(running.child, 'SIGKILL');
      void rm(running.workingDirectory, { recursive: true, force: true });
    }
  }

  private async runStart(
    attempt: number,
    device: TokenHubDevice,
    model: InstalledLocalModel
  ): Promise<void> {
    const transport = await this.transportFactory(device);
    let license: TokenHubLicenseSession | null = null;
    try {
      this.assertCurrent(attempt);
      this.activeTransport = transport;
      const client = new TokenHubProtocolClient(transport);
      const deviceId = await client.authenticateIdentity();
      console.info('[TokenHub] Dongle identity authenticated.');
      const credential = await client.deriveCredential();
      if (!credential.deviceId.equals(deviceId)) {
        throw new Error('Amis Hub B5 credential identity does not match its authenticated identity.');
      }
      license = new TokenHubLicenseSession(client, credential);
      await license.authenticate();
      const manifest = parseTokenHubManifest(await client.applicationManifest(), deviceId);
      await this.validateProtectedFlash(client, license, manifest, attempt);
      console.info('[TokenHub] Protected Flash verified.');
      await license.close();
      license = null;
      await transport.close();
      if (this.activeTransport === transport) this.activeTransport = null;
      this.assertCurrent(attempt);

      const resources = await this.runtimeLocator.resolve();
      const running = await this.launchServer(resources, device, model, credential.apiKey);
      try {
        this.assertCurrent(attempt);
        this.activeProcess = running;
        console.info(`[TokenHub] llama-server launched with pid ${running.child.pid ?? 'unknown'}.`);
        await this.waitUntilReady(running, credential.apiKey, attempt);
        console.info('[TokenHub] llama-server readiness check passed.');
        const runningModel: RunningHubModel = {
          deviceId: deviceId.toString('hex'),
          displayName: path.basename(model.filePath, path.extname(model.filePath)),
          modelName: path.basename(model.filePath),
          endpoint: SERVER_ENDPOINT,
          apiKey: credential.apiKey
        };
        this.assertCurrent(attempt);
        this.setState({
          phase: 'running',
          modelId: model.id,
          endpoint: SERVER_ENDPOINT,
          error: null,
          device
        });
        void this.observeExit(running, attempt, model.id);
        await this.synchronizeProfile(runningModel, running, attempt);
      } catch (error) {
        if (this.activeProcess === running) this.activeProcess = null;
        await this.stopProcess(running);
        throw error;
      }
    } finally {
      if (license) await license.close().catch(() => undefined);
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

  private async validateProtectedFlash(
    client: TokenHubProtocolClient,
    license: TokenHubLicenseSession,
    manifest: TokenHubApplicationManifest,
    attempt: number
  ): Promise<void> {
    const info = await client.externalFileInfo();
    if (info.fileSize !== manifest.fileSize || info.crc32 !== manifest.fileCrc32) {
      throw new Error('Amis Hub Flash metadata does not match its authenticated manifest.');
    }
    const sha256 = createHash('sha256');
    const crc32 = new TokenHubCrc32();
    let offset = 0;
    let magic = Buffer.alloc(0);
    while (offset < manifest.fileSize) {
      this.assertCurrent(attempt);
      await license.refreshIfNeeded();
      const size = Math.min(TOKEN_HUB_EXTERNAL_READ_CHUNK_SIZE, manifest.fileSize - offset);
      const chunk = await client.externalFileChunk(offset, size);
      if (offset === 0) magic = Buffer.from(chunk.subarray(0, 4));
      sha256.update(chunk);
      crc32.update(chunk);
      offset += chunk.length;
      await license.refreshIfNeeded();
    }
    if (crc32.value() !== manifest.fileCrc32) {
      throw new Error('Amis Hub Flash download failed CRC32 verification.');
    }
    if (!sha256.digest().equals(manifest.fileSha256)) {
      throw new Error('Amis Hub Flash download failed SHA256 verification.');
    }
    const supportedMagic = new Set([
      'cefaedfe', 'cffaedfe', 'feedface', 'feedfacf',
      'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'
    ]);
    if (!supportedMagic.has(magic.toString('hex'))) {
      throw new Error(`Amis Hub Flash server is not a compatible Mach-O executable: ${magic.toString('hex')}.`);
    }
  }

  private async launchServer(
    resources: { serverPath: string; templatePath: string },
    device: TokenHubDevice,
    model: InstalledLocalModel,
    apiKey: string
  ): Promise<RunningProcess> {
    const workingDirectory = await mkdtemp(path.join(os.tmpdir(), 'tokiie-tokenhub-'));
    await copyFile(resources.templatePath, path.join(workingDirectory, 'qwen3_codex_compatible.jinja'));
    const args = [
      '-m', model.filePath,
      '--host', '0.0.0.0',
      '--port', String(SERVER_PORT),
      '--parallel', '1',
      '-ngl', '99',
      '-t', '2',
      '-rea', 'off',
      '--no-mmap',
      '--cache-ram', '0',
      '-ub', '4096',
      '-b', '4096',
      '-c', '16384',
      '-fa', 'on',
      '--no-cache-prompt',
      '--rge', '0',
      '--chat-template-file', 'qwen3_codex_compatible.jinja',
      '--api-key', apiKey,
      '--dongle-port', device.calloutPath
    ];
    const child = spawn(resources.serverPath, args, {
      cwd: workingDirectory,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DYLD_LIBRARY_PATH: [
          path.join(path.dirname(resources.serverPath), 'lib'),
          process.env.DYLD_LIBRARY_PATH
        ].filter(Boolean).join(':')
      }
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
      await rm(workingDirectory, { recursive: true, force: true });
      throw new Error(`The Amis Hub llama-server could not be launched: ${String(cause)}`);
    }
    return { child, workingDirectory, output, exited };
  }

  private async waitUntilReady(
    running: RunningProcess,
    apiKey: string,
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
        const response = await fetch(`${SERVER_ENDPOINT}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
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
    await rm(running.workingDirectory, { recursive: true, force: true });
    if (this.generation !== attempt || this.activeProcess !== running) return;
    this.activeProcess = null;
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
    let device: TokenHubDevice | null;
    try {
      [device = null] = await this.deviceProbe.connectedDevices();
    } catch (error) {
      console.warn(`[TokenHub] Device scan failed: ${String(error)}`);
      return;
    }
    if (sameDevice(device, this.state.device)) return;
    const wasActive = this.state.phase === 'starting' || this.state.phase === 'running';
    const modelId = this.state.modelId;
    this.state = { ...this.state, device };
    this.publish();
    if (!device && wasActive) {
      this.generation += 1;
      await this.releaseOwnedResources();
      this.setState({
        phase: 'failed',
        modelId,
        endpoint: null,
        error: 'The Amis Hub authentication device was removed.',
        device: null
      });
    }
  }

  private async releaseOwnedResources(): Promise<void> {
    const transport = this.activeTransport;
    this.activeTransport = null;
    await transport?.close().catch(() => undefined);
    const running = this.activeProcess;
    this.activeProcess = null;
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
    await rm(running.workingDirectory, { recursive: true, force: true });
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
