import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import AppUpdateModule from '../dist/main/updates/AppUpdateService.js';
import PresentationModule from '../dist/shared/AppUpdatePresentation.js';
import PackagingConfiguration from '../scripts/PackagingConfiguration.cjs';

const AppUpdateService = AppUpdateModule.default;
const AppUpdatePresentation = PresentationModule.default;

/** Exercises public updater events without downloading or quitting the test process. */
class FakeUpdater extends EventEmitter {
  checkCount = 0;
  downloadCount = 0;
  installCount = 0;
  offeredVersion = '0.2.0';
  checkFailure = null;
  downloadFailure = null;
  checkBarrier = Promise.resolve();
  downloadBarrier = Promise.resolve();

  async checkForUpdates() {
    this.checkCount += 1;
    this.emit('checking-for-update');
    await this.checkBarrier;
    if (this.checkFailure) throw this.checkFailure;
    if (this.offeredVersion) this.emit('update-available', { version: this.offeredVersion });
    else this.emit('update-not-available', { version: '0.1.0' });
    return { updateInfo: { version: this.offeredVersion ?? '0.1.0' } };
  }

  async downloadUpdate() {
    this.downloadCount += 1;
    this.emit('download-progress', { percent: 42.5 });
    await this.downloadBarrier;
    if (this.downloadFailure) throw this.downloadFailure;
    this.emit('update-downloaded', { version: this.offeredVersion });
    return ['/cached/update.zip'];
  }

  quitAndInstall() {
    this.installCount += 1;
  }

  createService() {
    return new AppUpdateService({ installedVersion: '0.1.0', updater: this });
  }
}

test('unconfigured builds never check, download, install, or claim to be current', async () => {
  const service = new AppUpdateService({ installedVersion: '0.1.0', updater: null });
  assert.equal((await service.checkForUpdates()).status, 'unavailable');
  assert.equal((await service.downloadUpdate()).status, 'unavailable');
  assert.equal(service.installUpdate().status, 'unavailable');
  assert.doesNotMatch(new AppUpdatePresentation(service.getState()).description, /up to date/);
});

test('checking does not download and downloading does not install', async () => {
  const updater = new FakeUpdater();
  const service = updater.createService();
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(service.getState().status, 'idle');
  assert.equal((await service.checkForUpdates()).availableVersion, '0.2.0');
  assert.equal(updater.downloadCount, 0);
  assert.equal((await service.downloadUpdate()).status, 'downloaded');
  assert.equal(updater.installCount, 0);
  assert.equal(service.installUpdate().status, 'installing');
  service.installUpdate();
  assert.equal(updater.installCount, 1);
});

test('only a successful no-update event marks the installed version current', async () => {
  const updater = new FakeUpdater();
  const service = updater.createService();
  await service.checkForUpdates();
  updater.offeredVersion = null;
  const state = await service.checkForUpdates();
  assert.equal(state.status, 'upToDate');
  assert.equal(state.availableVersion, null);
  assert.match(new AppUpdatePresentation(state).description, /up to date/);
});

test('download and install requests before an available release do nothing', async () => {
  const updater = new FakeUpdater();
  const service = updater.createService();
  await service.downloadUpdate();
  service.installUpdate();
  assert.equal(updater.downloadCount, 0);
  assert.equal(updater.installCount, 0);
});

test('duplicate checks share the in-flight operation', async () => {
  const updater = new FakeUpdater();
  let finishCheck;
  updater.checkBarrier = new Promise((resolve) => { finishCheck = resolve; });
  const service = updater.createService();
  const pending = service.checkForUpdates();
  assert.equal((await service.checkForUpdates()).status, 'checking');
  assert.equal(updater.checkCount, 1);
  finishCheck();
  assert.equal((await pending).status, 'available');
});

test('checking and duplicate downloads cannot interrupt a download or discard a staged update', async () => {
  const updater = new FakeUpdater();
  const service = updater.createService();
  await service.checkForUpdates();
  let finishDownload;
  updater.downloadBarrier = new Promise((resolve) => { finishDownload = resolve; });
  const pending = service.downloadUpdate();
  const progress = service.getState();
  assert.equal(progress.downloadPercent, 42.5);
  assert.equal(new AppUpdatePresentation(progress).disabled, true);
  await service.checkForUpdates();
  await service.downloadUpdate();
  service.installUpdate();
  assert.equal(updater.checkCount, 1);
  assert.equal(updater.downloadCount, 1);
  assert.equal(updater.installCount, 0);
  finishDownload();
  await pending;
  assert.equal((await service.checkForUpdates()).status, 'downloaded');
});

test('failed checks show a retryable error and recover on the next check', async (context) => {
  context.mock.method(console, 'error', () => {});
  const updater = new FakeUpdater();
  updater.checkFailure = new Error('offline');
  const service = updater.createService();
  const failed = await service.checkForUpdates();
  assert.equal(failed.status, 'error');
  assert.equal(new AppUpdatePresentation(failed).buttonLabel, 'Try Again');
  updater.checkFailure = null;
  assert.equal((await service.checkForUpdates()).status, 'available');
});

test('failed downloads cannot install and can be retried after rechecking', async (context) => {
  context.mock.method(console, 'error', () => {});
  const updater = new FakeUpdater();
  const service = updater.createService();
  await service.checkForUpdates();
  updater.downloadFailure = new Error('checksum mismatch');
  assert.equal((await service.downloadUpdate()).status, 'error');
  service.installUpdate();
  assert.equal(updater.installCount, 0);
  updater.downloadFailure = null;
  await service.checkForUpdates();
  assert.equal((await service.downloadUpdate()).status, 'downloaded');
});

test('native installation errors reach Settings and never report success', async (context) => {
  context.mock.method(console, 'error', () => {});
  const updater = new FakeUpdater();
  const service = updater.createService();
  await service.checkForUpdates();
  await service.downloadUpdate();
  service.installUpdate();
  updater.emit('error', new Error('signature verification failed'));
  assert.equal(service.getState().status, 'error');
  assert.equal(new AppUpdatePresentation(service.getState()).disabled, false);
});

test('state subscribers receive progress and can unsubscribe', async () => {
  const updater = new FakeUpdater();
  const service = updater.createService();
  let states = [];
  const unsubscribe = service.subscribe((state) => { states = [...states, state]; });
  await service.checkForUpdates();
  await service.downloadUpdate();
  assert.ok(states.some((state) => state.status === 'downloading' && state.downloadPercent === 42.5));
  assert.equal(states.at(-1).status, 'downloaded');
  unsubscribe();
  const count = states.length;
  service.installUpdate();
  assert.equal(states.length, count);
});

test('an unsigned package has no inferred update provider', () => {
  const config = new PackagingConfiguration({}).create();
  assert.equal(config.publish, null);
  assert.equal(config.mac.identity, null);
  assert.equal(config.mac.notarize, false);
});

test('release configuration requires a feed and notarization credentials', () => {
  assert.throws(() => new PackagingConfiguration({ TOKKEY_RELEASE: '1' }).create(), /TOKKEY_UPDATE_URL/);
  assert.throws(() => new PackagingConfiguration({
    TOKKEY_RELEASE: '1', TOKKEY_UPDATE_URL: 'https://updates.example.com/stable'
  }).create(), /notarization/);
  const config = new PackagingConfiguration({
    TOKKEY_RELEASE: '1', TOKKEY_UPDATE_URL: 'https://updates.example.com/stable', APPLE_KEYCHAIN_PROFILE: 'test'
  }).create();
  assert.equal(config.forceCodeSigning, true);
  assert.equal(config.mac.notarize, true);
  assert.equal(config.publish[0].url, 'https://updates.example.com/stable/');
});

test('update feeds reject cleartext transport and embedded credentials', () => {
  for (const url of ['http://updates.example.com', 'https://token@updates.example.com', 'https://updates.example.com?token=secret']) {
    assert.throws(() => new PackagingConfiguration({ TOKKEY_UPDATE_URL: url }).create(), /HTTPS directory/);
  }
});
