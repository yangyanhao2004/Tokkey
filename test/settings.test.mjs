import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SystemPreferencesStore, DEFAULT_SYSTEM_PREFERENCES } from '../dist/main/settings/SystemPreferencesStore.js';
import { SystemPreferencesService } from '../dist/main/settings/SystemPreferencesService.js';

/** A home directory of its own per test, so no run reads the real ~/.tokkey. */
function temporaryHome() {
  return mkdtempSync(path.join(os.tmpdir(), 'tokkey-settings-'));
}

/** Records every effect the service asks of Electron, and answers for macOS. */
class StubPlatform {
  constructor({ openAtLogin = false, loginItemThrows = false } = {}) {
    this.openAtLogin = openAtLogin;
    this.loginItemThrows = loginItemThrows;
    this.startedBlockers = 0;
    this.stoppedBlockers = [];
    this.openedUrls = [];
    this.nextBlockerId = 1;
  }

  isOpenAtLogin() {
    if (this.loginItemThrows) throw new Error('login items unavailable');
    return this.openAtLogin;
  }

  setOpenAtLogin(openAtLogin) {
    this.openAtLogin = openAtLogin;
  }

  startSleepBlocker() {
    this.startedBlockers += 1;
    return this.nextBlockerId++;
  }

  stopSleepBlocker(blockerId) {
    this.stoppedBlockers.push(blockerId);
  }

  appVersion() {
    return '0.9.4';
  }

  async openExternalUrl(url) {
    this.openedUrls.push(url);
  }
}

function serviceWith(platform, homeDirectory) {
  return new SystemPreferencesService({
    store: new SystemPreferencesStore({ homeDirectory }),
    platform
  });
}

test('a home with no settings file reads as the defaults', () => {
  const store = new SystemPreferencesStore({ homeDirectory: temporaryHome() });
  assert.deepEqual(store.read(), DEFAULT_SYSTEM_PREFERENCES);
});

test('a corrupt settings file reads as the defaults rather than throwing', () => {
  const homeDirectory = temporaryHome();
  mkdirSync(path.join(homeDirectory, '.tokkey'), { recursive: true });
  writeFileSync(path.join(homeDirectory, '.tokkey', 'settings.json'), '{ not json');

  const store = new SystemPreferencesStore({ homeDirectory });
  assert.deepEqual(store.read(), DEFAULT_SYSTEM_PREFERENCES);
});

test('a malformed value falls back to its default, keeping the valid neighbours', () => {
  const homeDirectory = temporaryHome();
  mkdirSync(path.join(homeDirectory, '.tokkey'), { recursive: true });
  writeFileSync(
    path.join(homeDirectory, '.tokkey', 'settings.json'),
    JSON.stringify({ preventSystemSleep: true, launchAtLogin: 'yes' })
  );

  const stored = new SystemPreferencesStore({ homeDirectory }).read();
  assert.equal(stored.preventSystemSleep, true);
  assert.equal(stored.launchAtLogin, false);
});

test('restoring re-applies the stored sleep blocker to the session', () => {
  const homeDirectory = temporaryHome();
  const platform = new StubPlatform();
  serviceWith(platform, homeDirectory).update({ preventSystemSleep: true });

  // A second service is the next launch: the file is all it has to go on.
  const nextLaunch = new StubPlatform();
  const restored = serviceWith(nextLaunch, homeDirectory).restore();

  assert.equal(restored.preventSystemSleep, true);
  assert.equal(nextLaunch.startedBlockers, 1);
});

test('the sleep blocker is started once and released once', () => {
  const platform = new StubPlatform();
  const service = serviceWith(platform, temporaryHome());

  service.update({ preventSystemSleep: true });
  service.update({ launchAtLogin: true });
  assert.equal(platform.startedBlockers, 1, 'an unrelated change must not start a second blocker');

  service.update({ preventSystemSleep: false });
  assert.deepEqual(platform.stoppedBlockers, [1]);

  service.dispose();
  assert.deepEqual(platform.stoppedBlockers, [1], 'disposing with no blocker held stops nothing');
});

test('quitting releases a held sleep blocker', () => {
  const platform = new StubPlatform();
  const service = serviceWith(platform, temporaryHome());

  service.update({ preventSystemSleep: true });
  service.dispose();

  assert.deepEqual(platform.stoppedBlockers, [1]);
});

test('the login item is reported from macOS, not from the stored file', () => {
  const homeDirectory = temporaryHome();
  const platform = new StubPlatform();
  serviceWith(platform, homeDirectory).update({ launchAtLogin: true });

  // The user removed Tokkey from Login Items while the app was closed.
  const nextLaunch = new StubPlatform({ openAtLogin: false });
  const state = serviceWith(nextLaunch, homeDirectory).getState();

  assert.equal(state.preferences.launchAtLogin, false);
});

test('an unreadable login item falls back to the stored value', () => {
  const homeDirectory = temporaryHome();
  const platform = new StubPlatform();
  serviceWith(platform, homeDirectory).update({ launchAtLogin: true });

  const nextLaunch = new StubPlatform({ loginItemThrows: true });
  const restored = serviceWith(nextLaunch, homeDirectory).restore();

  assert.equal(restored.launchAtLogin, true);
});

test('a patch changes only the preference it names', () => {
  const homeDirectory = temporaryHome();
  const service = serviceWith(new StubPlatform(), homeDirectory);

  service.update({ launchAtLogin: true });
  const state = service.update({ preventSystemSleep: true });

  assert.deepEqual(state.preferences, {
    launchAtLogin: true,
    preventSystemSleep: true
  });
  const written = JSON.parse(
    readFileSync(path.join(homeDirectory, '.tokkey', 'settings.json'), 'utf8')
  );
  assert.deepEqual(written, state.preferences);
});

test('the client row reports the installed version and no phantom update', () => {
  const state = serviceWith(new StubPlatform(), temporaryHome()).getState();
  assert.equal(state.client.installedVersion, '0.9.4');
  assert.equal(state.client.availableVersion, null);
  assert.equal(state.client.status, 'unavailable');
});

test('send feedback opens the mail client once', async () => {
  const platform = new StubPlatform();
  await serviceWith(platform, temporaryHome()).sendFeedback();

  assert.equal(platform.openedUrls.length, 1);
  assert.match(platform.openedUrls[0], /^mailto:/);
});
