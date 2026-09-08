import { existsSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import AppUpdateService from './AppUpdateService';

/** Loads only the feed embedded by electron-builder, never a renderer-supplied URL. */
export default class AppUpdateRuntime {
  static create(): AppUpdateService {
    const configured = app.isPackaged && existsSync(path.join(process.resourcesPath, 'app-update.yml'));
    return new AppUpdateService({
      installedVersion: app.getVersion(),
      updater: configured ? autoUpdater : null,
      unavailableReason: app.isPackaged
        ? 'Updates are not configured for this build.'
        : 'Updates are only available in the installed release of Tokkey.'
    });
  }
}
