import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SystemPreferencesStore, DEFAULT_SYSTEM_PREFERENCES } from '../dist/main/settings/SystemPreferencesStore.js';
import { SystemPreferencesService } from '../dist/main/settings/SystemPreferencesService.js';
import FeedbackApiClientModule from '../dist/main/settings/FeedbackApiClient.js';
import BackendEnvironmentModule from '../dist/main/config/BackendEnvironment.js';
import FeedbackErrorsModule from '../dist/main/settings/FeedbackErrors.js';

const { default: FeedbackApiClient, FEEDBACK_ENDPOINT_PATH } = FeedbackApiClientModule;
const { default: BackendEnvironment } = BackendEnvironmentModule;
const { default: FeedbackError } = FeedbackErrorsModule;

/** A home directory of its own per test, so no run reads the real ~/.tokkey. */
function temporaryHome() {
  return mkdtempSync(path.join(os.tmpdir(), 'tokkey-settings-'));
}

/** Records every effect the service asks of Electron, and answers for macOS. */
class StubPlatform {
  constructor({ openAtLogin = false, known = true, loginItemThrows = false, packaged = true } = {}) {
    this.openAtLogin = openAtLogin;
    // Whether macOS has any record of the app, as a real install does once it
    // has been registered. A fresh install passes known: false.
    this.known = known;
    this.loginItemThrows = loginItemThrows;
    this.packaged = packaged;
    this.startedBlockers = 0;
    this.stoppedBlockers = [];
    this.nextBlockerId = 1;
  }

  loginItem() {
    if (this.loginItemThrows) throw new Error('login items unavailable');
    return { openAtLogin: this.openAtLogin, known: this.known };
  }

  setOpenAtLogin(openAtLogin) {
    this.openAtLogin = openAtLogin;
    this.known = true;
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

  // Tests stand in for a shipped build; the dev-run skip is covered separately.
  isPackaged() {
    return this.packaged;
  }
}

/** Records every feedback message the service tries to deliver. */
class StubFeedbackSubmitter {
  constructor({ fails = false } = {}) {
    this.submitted = [];
    this.fails = fails;
  }

  async submit(feedback, email) {
    if (this.fails) throw new Error('Failed to send feedback');
    this.submitted.push({ feedback, email });
  }
}

function serviceWith(platform, homeDirectory, feedbackSubmitter = new StubFeedbackSubmitter()) {
  return new SystemPreferencesService({
    store: new SystemPreferencesStore({ homeDirectory }),
    platform,
    feedbackSubmitter
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
  assert.equal(stored.launchAtLogin, DEFAULT_SYSTEM_PREFERENCES.launchAtLogin);
});

test('a first run registers the default login item with macOS', () => {
  const homeDirectory = temporaryHome();
  const platform = new StubPlatform({ known: false });

  const restored = serviceWith(platform, homeDirectory).restore();

  assert.equal(restored.launchAtLogin, true, 'a fresh install launches at login');
  assert.equal(platform.openAtLogin, true, 'the default has to reach macOS, not just the file');
});

test('a login item the user removed is not re-registered on the next launch', () => {
  const homeDirectory = temporaryHome();
  serviceWith(new StubPlatform({ known: false }), homeDirectory).restore();

  // The user removed Tokkey from Login Items while the app was closed.
  const nextLaunch = new StubPlatform({ openAtLogin: false });
  const restored = serviceWith(nextLaunch, homeDirectory).restore();

  assert.equal(restored.launchAtLogin, false);
  assert.equal(nextLaunch.openAtLogin, false);
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

test('a stored login item is re-registered when macOS has no record of it', () => {
  const homeDirectory = temporaryHome();
  mkdirSync(path.join(homeDirectory, '.tokkey'), { recursive: true });
  writeFileSync(
    path.join(homeDirectory, '.tokkey', 'settings.json'),
    JSON.stringify({ launchAtLogin: true, preventSystemSleep: false, privacyGate: false })
  );

  // The app was reinstalled or moved: the file remembers the choice, macOS does not.
  const platform = new StubPlatform({ openAtLogin: false, known: false });
  const restored = serviceWith(platform, homeDirectory).restore();

  assert.equal(restored.launchAtLogin, true, 'the stored choice is the only answer there is');
  assert.equal(platform.openAtLogin, true, 'and it is handed back to macOS');
});

test('a dev run does not put the Electron binary into Login Items', () => {
  const platform = new StubPlatform({ known: false, packaged: false });

  const restored = serviceWith(platform, temporaryHome()).restore();

  assert.equal(platform.openAtLogin, false, 'nothing is registered from a dev run');
  assert.equal(restored.launchAtLogin, true, 'but the stored preference still reads on');
});

test('a patch changes only the preference it names', () => {
  const homeDirectory = temporaryHome();
  const service = serviceWith(new StubPlatform(), homeDirectory);

  service.update({ launchAtLogin: true });
  const state = service.update({ preventSystemSleep: true });

  assert.deepEqual(state.preferences, {
    launchAtLogin: true,
    preventSystemSleep: true,
    privacyGate: false
  });
  const written = JSON.parse(
    readFileSync(path.join(homeDirectory, '.tokkey', 'settings.json'), 'utf8')
  );
  assert.deepEqual(written, state.preferences);
});

test('the privacy gate starts closed and stays where the user leaves it', () => {
  const homeDirectory = temporaryHome();
  const service = serviceWith(new StubPlatform(), homeDirectory);

  assert.equal(service.getState().preferences.privacyGate, false, 'consent is never assumed');

  service.update({ privacyGate: true });

  // A second service is the next launch: the file is all it has to go on.
  const restored = serviceWith(new StubPlatform(), homeDirectory).restore();
  assert.equal(restored.privacyGate, true);
});

test('the client row reports the installed version and no phantom update', () => {
  const state = serviceWith(new StubPlatform(), temporaryHome()).getState();
  assert.equal(state.client.installedVersion, '0.9.4');
  assert.equal(state.client.availableVersion, null);
  assert.equal(state.client.status, 'unavailable');
});

test('send feedback posts the typed message and reply address once', async () => {
  const submitter = new StubFeedbackSubmitter();
  const service = serviceWith(new StubPlatform(), temporaryHome(), submitter);

  const result = await service.sendFeedback('Line one\nR&D idea', 'user@example.com');

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(submitter.submitted, [
    { feedback: 'Line one\nR&D idea', email: 'user@example.com' }
  ]);
});

test('a failed send answers with a reason, so the dialog can show it', async () => {
  const service = serviceWith(
    new StubPlatform(),
    temporaryHome(),
    new StubFeedbackSubmitter({ fails: true })
  );

  const result = await service.sendFeedback('Never delivered', 'user@example.com');

  assert.equal(result.ok, false);
  // An unrecognised throw is reported as the generic reason, never as its text.
  assert.equal(result.error.code, 'unavailable');
  assert.match(result.error.message, /Could not reach Tokkey/);
});

test('the feedback client posts the endpoint contract to the environment origin', async () => {
  const requests = [];
  const client = new FeedbackApiClient(undefined, async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ code: 'OK', message: 'success', data: null }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' }
    });
  });

  await client.submit('Line one\nR&D idea', 'user@example.com');

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${BackendEnvironment.stagingOrigin}${FEEDBACK_ENDPOINT_PATH}`);
  assert.deepEqual(requests[0].body, { email: 'user@example.com', feedback: 'Line one\nR&D idea' });
});

test('each feedback failure status becomes the reason the user is shown', async () => {
  // The backend reports every failure as a non-2xx status, so the status alone
  // decides which message the dialog puts on screen.
  const cases = [
    { status: 400, backendCode: 'VALIDATION_FAILED', code: 'invalidInput' },
    { status: 429, backendCode: 'FEEDBACK_RATE_LIMITED', code: 'rateLimited' },
    { status: 503, backendCode: 'FEEDBACK_DELIVERY_FAILED', code: 'undeliverable' },
    { status: 500, backendCode: 'INTERNAL_ERROR', code: 'unavailable' }
  ];

  for (const { status, backendCode, code } of cases) {
    const client = new FeedbackApiClient(undefined, async () =>
      new Response(JSON.stringify({ code: backendCode, message: 'backend detail' }), {
        status,
        headers: { 'Content-Type': 'application/json' }
      })
    );

    const failure = await client.submit('Never delivered', 'user@example.com').then(
      () => null,
      (error) => error
    );

    assert.ok(failure, `HTTP ${status} should have failed`);
    assert.equal(failure.code, code);
    // The backend's own wording is logged, never handed to the user.
    assert.doesNotMatch(FeedbackError.publicError(failure).message, /backend detail/);
  }
});

test('a network failure reads as unreachable rather than as a rejected message', async () => {
  const client = new FeedbackApiClient(undefined, async () => {
    throw new TypeError('fetch failed');
  });

  const failure = await client.submit('Never sent', 'user@example.com').then(
    () => null,
    (error) => error
  );

  assert.equal(failure.code, 'unavailable');
});
