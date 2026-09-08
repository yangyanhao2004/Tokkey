import type { ClientVersionInfo } from './types';

/** Maps updater states to the existing Settings row without inventing remote results. */
export default class AppUpdatePresentation {
  constructor(private readonly client: ClientVersionInfo) {}

  get buttonLabel(): string {
    switch (this.client.status) {
      case 'checking': return 'Checking...';
      case 'available': return 'Download Update';
      case 'downloading': return 'Downloading...';
      case 'downloaded': return 'Restart to Update';
      case 'installing': return 'Restarting...';
      case 'error': return 'Try Again';
      default: return 'Check for Updates';
    }
  }

  get disabled(): boolean {
    return ['unavailable', 'checking', 'downloading', 'installing'].includes(this.client.status);
  }

  get description(): string {
    const installed = `Version ${this.client.installedVersion}`;
    return `${installed} · ${this.statusText}`;
  }

  private get statusText(): string {
    switch (this.client.status) {
      case 'idle': return 'Updates have not been checked.';
      case 'checking': return 'Checking for updates...';
      case 'upToDate': return 'Tokkey is up to date.';
      case 'available': return `Version ${this.client.availableVersion} is available.`;
      case 'downloading': return `Downloading version ${this.client.availableVersion}: ${Math.round(this.client.downloadPercent ?? 0)}%.`;
      case 'downloaded': return `Version ${this.client.availableVersion} is ready. Restarting will end active tasks.`;
      case 'installing': return 'Restarting to install the update...';
      case 'unavailable': return this.client.message ?? 'Updates are unavailable.';
      case 'error': return this.client.message ?? 'Could not complete the update. Please try again.';
    }
  }
}
