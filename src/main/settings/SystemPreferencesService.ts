import { app, powerSaveBlocker } from 'electron';
import type {
  ClientVersionInfo,
  FeedbackResult,
  SystemPreferences,
  SystemPreferencesPatch,
  SystemSettingsState
} from '../../shared/types';
import SystemPreferencesStore, { DEFAULT_SYSTEM_PREFERENCES } from './SystemPreferencesStore';
import AppUpdateService from '../updates/AppUpdateService';
import FeedbackApiClient, { type FeedbackSubmitter } from './FeedbackApiClient';
import FeedbackError from './FeedbackErrors';

/**
 * The Electron surfaces the settings actually act on, named so tests can stand
 * in for them without an Electron runtime.
 */
/** What macOS knows about the login item, including whether it knows at all. */
export interface LoginItemState {
  openAtLogin: boolean;
  /**
   * False when macOS has no record of the app: a fresh install, or one that was
   * moved or reinstalled. Distinct from the user having switched the item off,
   * which macOS does remember.
   */
  known: boolean;
}

export interface SystemPreferencesPlatform {
  /** What macOS currently says about launching the app at sign-in. */
  loginItem(): LoginItemState;
  setOpenAtLogin(openAtLogin: boolean): void;
  /**
   * False for a dev run, where the binary macOS would register is Electron
   * itself rather than Tokkey.
   */
  isPackaged(): boolean;
  /** Starts the "app suspension" blocker and returns its id. */
  startSleepBlocker(): number;
  stopSleepBlocker(blockerId: number): void;
  appVersion(): string;
}

/** The real surfaces, used everywhere outside tests. */
const ELECTRON_PLATFORM: SystemPreferencesPlatform = {
  loginItem: () => {
    const settings = app.getLoginItemSettings();
    return {
      openAtLogin: settings.openAtLogin,
      known: settings.status !== 'not-found' && settings.status !== 'not-registered'
    };
  },
  setOpenAtLogin: (openAtLogin) => app.setLoginItemSettings({ openAtLogin }),
  isPackaged: () => app.isPackaged,
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
    const launchAtLogin = this.settledLoginItem(stored.launchAtLogin);

    // When macOS has no record of the app, the stored preference is the only
    // answer there is, so register it rather than report off: otherwise a fresh
    // install strands the default, and a reinstall silently drops a choice the
    // user already made. A login item macOS does remember is left alone, so
    // removing Tokkey from Login Items still sticks.
    // Skipped in a dev run, which would otherwise put Electron itself into the
    // user's Login Items.
    if (this.platform.isPackaged() && !this.readLoginItem().known && launchAtLogin) {
      this.writeLoginItem(true);
    }

    this.preferences = { ...stored, launchAtLogin };
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
    // Compared against the reported state rather than the in-memory copy: the
    // login item can have been changed in System Settings since it was read,
    // and a switch the user flips has to reach macOS even then.
    const current = this.getPreferences();
    const updated: SystemPreferences = { ...current, ...patch };

    if (updated.launchAtLogin !== current.launchAtLogin) {
      this.writeLoginItem(updated.launchAtLogin);
    }
    if (updated.preventSystemSleep !== current.preventSystemSleep) {
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
  async sendFeedback(feedback: string, email: string): Promise<FeedbackResult> {
    try {
      await this.feedbackSubmitter.submit(feedback, email);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: FeedbackError.publicError(error) };
    }
  }

  /** Releases the power blocker; call when the app is shutting down. */
  dispose(): void {
    this.applySleepBlocker(false);
  }

  private getPreferences(): SystemPreferences {
    return { ...this.preferences, launchAtLogin: this.settledLoginItem(this.preferences.launchAtLogin) };
  }

  /** macOS's answer where it has one, and the stored preference where it does not. */
  private settledLoginItem(stored: boolean): boolean {
    const loginItem = this.readLoginItem();
    return loginItem.known ? loginItem.openAtLogin : stored;
  }

  /** An unreadable login item reads as "macOS has no answer", not as "off". */
  private readLoginItem(): LoginItemState {
    try {
      return this.platform.loginItem();
    } catch (error) {
      console.warn(`[SystemPreferences] Could not read the login item: ${String(error)}`);
      return { openAtLogin: false, known: false };
    }
  }

  /**
   * Asks macOS for the login item, keeping a refusal off the caller's path:
   * neither a boot nor a click on another row should fail over this one.
   */
  private writeLoginItem(openAtLogin: boolean): void {
    try {
      this.platform.setOpenAtLogin(openAtLogin);
    } catch (error) {
      console.warn(`[SystemPreferences] Could not write the login item: ${String(error)}`);
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
