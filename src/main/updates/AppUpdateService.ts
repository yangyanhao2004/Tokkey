import type { AppUpdater } from 'electron-updater';
import type { ClientVersionInfo } from '../../shared/types';

type UpdateDriver = Pick<AppUpdater,
  'autoDownload' | 'autoInstallOnAppQuit' | 'allowPrerelease' | 'allowDowngrade' |
  'on' | 'checkForUpdates' | 'downloadUpdate' | 'quitAndInstall'>;

export interface AppUpdateServiceOptions {
  installedVersion: string;
  updater: UpdateDriver | null;
  unavailableReason?: string;
}

/** Owns update transitions; downloads and restarts always require explicit user actions. */
export default class AppUpdateService {
  private readonly updater: UpdateDriver | null;
  private state: ClientVersionInfo;
  private listeners: readonly ((state: ClientVersionInfo) => void)[] = [];
  private operationPending = false;

  constructor(options: AppUpdateServiceOptions) {
    this.updater = options.updater;
    this.state = AppUpdateService.unavailableState(options.installedVersion, options.unavailableReason);
    if (!this.updater) return;
    this.state = { ...this.state, status: 'idle', message: null };
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.allowPrerelease = false;
    this.updater.allowDowngrade = false;
    this.bindEvents(this.updater);
  }

  /** An unconfigured build must never claim that a remote version was checked. */
  static unavailableState(installedVersion: string, message = 'Updates are not configured for this build.'): ClientVersionInfo {
    return { installedVersion, availableVersion: null, status: 'unavailable', downloadPercent: null, message };
  }

  getState(): ClientVersionInfo {
    return { ...this.state };
  }

  subscribe(listener: (state: ClientVersionInfo) => void): () => void {
    this.listeners = [...this.listeners, listener];
    return () => { this.listeners = this.listeners.filter((candidate) => candidate !== listener); };
  }

  async checkForUpdates(): Promise<ClientVersionInfo> {
    if (!this.updater || this.operationPending || !['idle', 'upToDate', 'available', 'error'].includes(this.state.status)) {
      return this.getState();
    }
    return this.runOperation('checking', async () => {
      const result = await this.updater!.checkForUpdates();
      if (!result) throw new Error('Update checking is unavailable.');
    });
  }

  async downloadUpdate(): Promise<ClientVersionInfo> {
    if (!this.updater || this.operationPending || this.state.status !== 'available') return this.getState();
    return this.runOperation('downloading', async () => { await this.updater!.downloadUpdate(); });
  }

  /** electron-updater quits through Electron, preserving the app's will-quit cleanup. */
  installUpdate(): ClientVersionInfo {
    if (!this.updater || this.operationPending || this.state.status !== 'downloaded') return this.getState();
    this.publish({ status: 'installing', message: null });
    try {
      this.updater.quitAndInstall(false, true);
    } catch (error) {
      this.fail(error);
    }
    return this.getState();
  }

  private bindEvents(updater: UpdateDriver): void {
    updater.on('checking-for-update', () => this.publish({ status: 'checking', message: null }));
    updater.on('update-available', (info) => this.publish({
      status: 'available', availableVersion: info.version, downloadPercent: null, message: null
    }));
    updater.on('update-not-available', () => this.publish({
      status: 'upToDate', availableVersion: null, downloadPercent: null, message: null
    }));
    updater.on('download-progress', (progress) => this.publish({
      status: 'downloading', downloadPercent: Math.max(0, Math.min(100, progress.percent))
    }));
    updater.on('update-downloaded', (info) => this.publish({
      status: 'downloaded', availableVersion: info.version, downloadPercent: 100, message: null
    }));
    updater.on('error', (error) => this.fail(error));
  }

  private async runOperation(status: 'checking' | 'downloading', operation: () => Promise<void>): Promise<ClientVersionInfo> {
    this.operationPending = true;
    this.publish({ status, downloadPercent: null, message: null });
    try {
      await operation();
    } catch (error) {
      this.fail(error);
    } finally {
      this.operationPending = false;
    }
    return this.getState();
  }

  private fail(error: unknown): void {
    console.error('[Updates]', error);
    this.publish({ status: 'error', downloadPercent: null, message: 'Could not complete the update. Check your connection and try again.' });
  }

  private publish(patch: Partial<ClientVersionInfo>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.getState());
  }
}
