import { app, powerSaveBlocker } from 'electron';
import type {
  ClientVersionInfo,
  SystemPreferences,
  SystemPreferencesPatch,
  SystemSettingsState
} from '../../shared/types';
import SystemPreferencesStore, { DEFAULT_SYSTEM_PREFERENCES } from './SystemPreferencesStore';
import AppUpdateService from '../updates/AppUpdateService';
import FeedbackApiClient, { type FeedbackSubmitter } from './FeedbackApiClient';

/**
 * The Electron surfaces the settings actually act on, named so tests can stand
 * in for them without an Electron runtime.
 */
export interface SystemPreferencesPlatform {
  /** True when macOS currently launches the app at sign-in. */
  isOpenAtLogin(): boolean;
  setOpenAtLogin(openAtLogin: boolean): void;
  /** Starts the "app suspension" blocker and returns its id. */
  startSleepBlocker(): number;
  stopSleepBlocker(blockerId: number): void;
  appVersion(): string;
}

/** The real surfaces, used everywhere outside tests. */
const ELECTRON_PLATFORM: SystemPreferencesPlatform = {
  isOpenAtLogin: () => app.getLoginItemSettings().openAtLogin,
  setOpenAtLogin: (openAtLogin) => app.setLoginItemSettings({ openAtLogin }),
  // "prevent-app-suspension" is the blocker that matches the row's promise:
  // the Mac stays awake and networked while the display is still free to sleep.
  startSleepBlocker: () => powerSaveBlocker.start('prevent-app-suspension'),
  stopSleepBlocker: (blockerId) => powerSaveBlocker.stop(blockerId),
  appVersion: () => app.getVersion()
};

export interface SystemPreferencesServiceOptions {
  store?: SystemPreferencesStore;
  platform?: SystemPreferencesPlatform;
  clientVersion?: () => ClientVersionInfo;
  feedbackSubmitter?: FeedbackSubmitter;
}

/**
 * Owns the Settings page's preferences: what is stored, and what each one does
 * to the running app.
 *
 * The stored file is the source of truth for sleep, and macOS is the source of
 * truth for the login item — the user can remove Tokkey from
 * Login Items in System Settings without the app running, so that one is read
 * back from the OS rather than trusted from disk.
 */
export class SystemPreferencesService {
  private readonly store: SystemPreferencesStore;
  private readonly platform: SystemPreferencesPlatform;
  private readonly clientVersion: () => ClientVersionInfo;
  private readonly feedbackSubmitter: FeedbackSubmitter;
  private preferences: SystemPreferences;
  /** The live power blocker's id, or null whenever sleep is not being held off. */
  private sleepBlockerId: number | null = null;

  constructor(options: SystemPreferencesServiceOptions = {}) {
    this.store = options.store ?? new SystemPreferencesStore();
    this.platform = options.platform ?? ELECTRON_PLATFORM;
    this.clientVersion = options.clientVersion ?? (() => AppUpdateService.unavailableState(this.platform.appVersion()));
    this.feedbackSubmitter = options.feedbackSubmitter ?? new FeedbackApiClient();
    this.preferences = { ...DEFAULT_SYSTEM_PREFERENCES };
  }

  /**
   * Re-applies the stored preferences to this session. Called once at startup,
   * because the sleep blocker is process state that dies with the previous run.
   */
  restore(): SystemPreferences {
    const stored = this.store.read();
    this.preferences = { ...stored, launchAtLogin: this.readLoginItem(stored.launchAtLogin) };
    this.applySleepBlocker(this.preferences.preventSystemSleep);
    return this.getPreferences();
  }

  /** Everything the Settings page renders in one reading. */
  getState(): SystemSettingsState {
    return {
      preferences: this.getPreferences(),
      client: this.clientVersion()
    };
  }

  /**
   * Applies the changed settings and persists the result. Takes a patch rather
   * than the whole set so a row only ever speaks for its own switch.
   */
  update(patch: SystemPreferencesPatch): SystemSettingsState {
    const updated: SystemPreferences = { ...this.preferences, ...patch };

    if (updated.launchAtLogin !== this.preferences.launchAtLogin) {
      this.platform.setOpenAtLogin(updated.launchAtLogin);
    }
    if (updated.preventSystemSleep !== this.preferences.preventSystemSleep) {
      this.applySleepBlocker(updated.preventSystemSleep);
    }

    this.preferences = updated;
    this.store.write(updated);
    return this.getState();
  }

  /**
   * Posts one message to the feedback endpoint. Rejecting is meaningful: the
   * dialog holds the typed message open rather than claiming it was sent.
   */
  async sendFeedback(message: string, email?: string): Promise<void> {
    await this.feedbackSubmitter.submit(message, email);
  }

  /** Releases the power blocker; call when the app is shutting down. */
  dispose(): void {
    this.applySleepBlocker(false);
  }

  private getPreferences(): SystemPreferences {
    return { ...this.preferences, launchAtLogin: this.readLoginItem(this.preferences.launchAtLogin) };
  }

  /** The OS's answer, falling back to the stored one if it cannot be read. */
  private readLoginItem(fallback: boolean): boolean {
    try {
      return this.platform.isOpenAtLogin();
    } catch (error) {
      console.warn(`[SystemPreferences] Could not read the login item: ${String(error)}`);
      return fallback;
    }
  }

  /** Holds at most one blocker, so repeated calls cannot leak them. */
  private applySleepBlocker(preventSleep: boolean): void {
    if (preventSleep && this.sleepBlockerId === null) {
      this.sleepBlockerId = this.platform.startSleepBlocker();
      return;
    }
    if (!preventSleep && this.sleepBlockerId !== null) {
      this.platform.stopSleepBlocker(this.sleepBlockerId);
      this.sleepBlockerId = null;
    }
  }
}

export default SystemPreferencesService;
