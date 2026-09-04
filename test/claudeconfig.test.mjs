import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSettingsDocument } from '../dist/main/claude/ClaudeSettingsDocument.js';
import { ClaudeConfigTakeover } from '../dist/main/claude/ClaudeConfigTakeover.js';
import { ClaudeGatewayIntegration } from '../dist/main/claude/ClaudeGatewayIntegration.js';
import { ClaudeDesktopConfigLibrary } from '../dist/main/claude/ClaudeDesktopConfigLibrary.js';
import { RouterBinding } from '../dist/main/router/RouterBinding.js';
import { RouterModel } from '../dist/main/router/RouterModel.js';

/** A throwaway home holding both `.claude` and `.tokkey`. */
function makeHome() {
  return mkdtempSync(path.join(tmpdir(), 'tokkey-claudeconfig-'));
}

function claudeHomeOf(home) {
  return path.join(home, '.claude');
}

/** Writes a `settings.json` into the throwaway claude home and returns its path. */
function writeSettings(home, text) {
  mkdirSync(claudeHomeOf(home), { recursive: true });
  const filePath = path.join(claudeHomeOf(home), 'settings.json');
  writeFileSync(filePath, text);
  return filePath;
}

const USER_SETTINGS = JSON.stringify(
  {
    model: 'opus',
    env: { CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' },
    permissions: { allow: ['Bash(npm run test)'] }
  },
  null,
  2
);

/** The takeover under a throwaway home, with `.claude` already created. */
function makeTakeover(home) {
  return new ClaudeConfigTakeover({ homeDirectory: home, claudeHome: claudeHomeOf(home) });
}

// ---------------------------------------------------------------------------
// ClaudeSettingsDocument
// ---------------------------------------------------------------------------

test('sets one env entry and leaves every other setting alone', () => {
  const rewritten = new ClaudeSettingsDocument(USER_SETTINGS)
    .setEnvironmentVariable('ANTHROPIC_BASE_URL', 'http://127.0.0.1:4000')
    .toString();

  const parsed = JSON.parse(rewritten);
  assert.equal(parsed.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4000');
  assert.equal(parsed.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '1');
  assert.equal(parsed.model, 'opus');
  assert.deepEqual(parsed.permissions.allow, ['Bash(npm run test)']);
});

test('writes settings from scratch when there is no file yet', () => {
  const parsed = JSON.parse(
    new ClaudeSettingsDocument('').setEnvironmentVariable('ANTHROPIC_BASE_URL', 'http://x').toString()
  );

  assert.deepEqual(parsed, { env: { ANTHROPIC_BASE_URL: 'http://x' } });
});

test('a malformed settings file is replaced rather than propagated', () => {
  const parsed = JSON.parse(
    new ClaudeSettingsDocument('{ not json').setEnvironmentVariable('ANTHROPIC_BASE_URL', 'http://x').toString()
  );

  assert.deepEqual(parsed, { env: { ANTHROPIC_BASE_URL: 'http://x' } });
});

test('restricts the model list without disturbing the rest of the file', () => {
  const parsed = JSON.parse(
    new ClaudeSettingsDocument(USER_SETTINGS)
      .setModelSelection({ model: 'cloud-route', availableModels: ['cloud-route', 'claude-opus-5'] })
      .toString()
  );

  assert.equal(parsed.model, 'cloud-route');
  assert.deepEqual(parsed.availableModels, ['cloud-route', 'claude-opus-5']);
  assert.equal(parsed.enforceAvailableModels, true);
  assert.deepEqual(parsed.permissions.allow, ['Bash(npm run test)']);
});

test('editing does not mutate the document it was derived from', () => {
  const original = new ClaudeSettingsDocument(USER_SETTINGS);

  original.setEnvironmentVariable('ANTHROPIC_BASE_URL', 'http://x');

  assert.equal(original.environmentVariable('ANTHROPIC_BASE_URL'), null);
});

// ---------------------------------------------------------------------------
// ClaudeConfigTakeover
// ---------------------------------------------------------------------------

test('points claude at the gateway and hands the original file back at quit', () => {
  const home = makeHome();
  const settingsPath = writeSettings(home, USER_SETTINGS);
  const takeover = makeTakeover(home);

  assert.equal(takeover.activate('http://127.0.0.1:4173'), true);

  const taken = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(taken.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4173');
  // The user's own settings survive the takeover untouched.
  assert.equal(taken.model, 'opus');
  assert.equal(taken.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '1');

  assert.equal(takeover.restore(), true);
  assert.equal(readFileSync(settingsPath, 'utf8'), USER_SETTINGS);
  assert.equal(existsSync(takeover.backupFilePath), false);
  rmSync(home, { recursive: true, force: true });
});

test('strips a /v1 suffix, which claude appends itself', () => {
  const home = makeHome();
  const settingsPath = writeSettings(home, USER_SETTINGS);

  makeTakeover(home).activate('http://127.0.0.1:4173/v1/');

  assert.equal(
    JSON.parse(readFileSync(settingsPath, 'utf8')).env.ANTHROPIC_BASE_URL,
    'http://127.0.0.1:4173'
  );
  rmSync(home, { recursive: true, force: true });
});

test('restores settings the previous run was killed before restoring', () => {
  const home = makeHome();
  const settingsPath = writeSettings(home, USER_SETTINGS);
  // A session that never reached its restore: the file is taken over and the
  // backup is still on disk.
  makeTakeover(home).activate('http://127.0.0.1:4173');
  assert.ok(readFileSync(settingsPath, 'utf8').includes('ANTHROPIC_BASE_URL'));

  const recovered = makeTakeover(home).recoverInterruptedSession();

  assert.equal(recovered, true);
  assert.equal(readFileSync(settingsPath, 'utf8'), USER_SETTINGS);
  rmSync(home, { recursive: true, force: true });
});

test('a second takeover carries the new port, not the stale one', () => {
  const home = makeHome();
  const settingsPath = writeSettings(home, USER_SETTINGS);

  makeTakeover(home).activate('http://127.0.0.1:4173');
  // No restore in between: the second launch recovers, then takes over again.
  makeTakeover(home).activate('http://127.0.0.1:4999');

  assert.equal(
    JSON.parse(readFileSync(settingsPath, 'utf8')).env.ANTHROPIC_BASE_URL,
    'http://127.0.0.1:4999'
  );
  rmSync(home, { recursive: true, force: true });
});

test('leaves no settings.json behind when there was none to begin with', () => {
  const home = makeHome();
  const takeover = makeTakeover(home);

  assert.equal(takeover.activate('http://127.0.0.1:4173'), true);
  assert.ok(readFileSync(takeover.configPath, 'utf8').includes('ANTHROPIC_BASE_URL'));

  takeover.restore();
  assert.equal(existsSync(takeover.configPath), false);
  rmSync(home, { recursive: true, force: true });
});

test('restoring without a takeover is a no-op', () => {
  const home = makeHome();
  const settingsPath = writeSettings(home, USER_SETTINGS);

  assert.equal(makeTakeover(home).restore(), false);

  assert.equal(readFileSync(settingsPath, 'utf8'), USER_SETTINGS);
  rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ClaudeGatewayIntegration
// ---------------------------------------------------------------------------

/** The route the one shipped cloud card derives; see `CloudModelCatalog`. */
const CLOUD_ROUTE = 'custom-gpt-5.6-terra-openai-c05442';

/** The picker-qualified fixed slug the router recognizes for every pairing. */
const ROUTER_ALIAS = `anthropic.${RouterModel.DISPLAY_NAME}`;

const GATEWAY_URL = 'http://127.0.0.1:4173';
const ROUTER_URL = 'http://127.0.0.1:5173';

/** A binding already switched on, as `RouterAgentIntegration.turnOn` leaves it. */
function boundRouter() {
  const binding = new RouterBinding();
  binding.bind(ROUTER_URL, RouterModel.forSingleModel({ routeName: CLOUD_ROUTE, displayName: 'gpt-5.6-terra' }));
  return binding;
}

function makeIntegration(home, { routerBinding, baseUrl = GATEWAY_URL } = {}) {
  return new ClaudeGatewayIntegration({
    gateway: { startIfNeeded: async () => {}, baseUrl: () => baseUrl },
    routerBinding: routerBinding ?? new RouterBinding(),
    homeDirectory: home,
    claudeHome: claudeHomeOf(home)
  });
}

test('offers the routed pair without moving claude off its own model', async () => {
  const home = makeHome();
  const settingsPath = writeSettings(home, USER_SETTINGS);
  const integration = makeIntegration(home, { routerBinding: boundRouter() });

  assert.equal(await integration.activate(), true);

  const taken = JSON.parse(readFileSync(settingsPath, 'utf8'));
  // Claude Code follows the router, not the gateway, whenever a pair is bound.
  assert.equal(taken.env.ANTHROPIC_BASE_URL, ROUTER_URL);
  // The user's own model is left alone: the routed pair is offered, not forced.
  assert.equal(taken.model, 'opus');
  assert.equal(taken.enforceAvailableModels, true);
  // The pair leads, and every Claude model the gateway routes follows.
  assert.equal(taken.availableModels[0], ROUTER_ALIAS);
  assert.ok(taken.availableModels.includes('claude-opus-5'));
  assert.ok(taken.availableModels.slice(1).every((model) => model.startsWith('claude-')));

  integration.deactivate();
  assert.equal(readFileSync(settingsPath, 'utf8'), USER_SETTINGS);
  rmSync(home, { recursive: true, force: true });
});

test('leaves the user their own model while the router is off', async () => {
  const home = makeHome();
  const settingsPath = writeSettings(home, USER_SETTINGS);

  assert.equal(await makeIntegration(home).activate(), true);

  const taken = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(taken.env.ANTHROPIC_BASE_URL, GATEWAY_URL);
  assert.equal(taken.model, 'opus');
  assert.equal(taken.availableModels, undefined);
  assert.equal(taken.enforceAvailableModels, undefined);
  rmSync(home, { recursive: true, force: true });
});

test('leaves settings.json alone when the gateway is not running', async () => {
  const home = makeHome();
  const settingsPath = writeSettings(home, USER_SETTINGS);

  assert.equal(await makeIntegration(home, { baseUrl: null }).activate(), false);

  assert.equal(readFileSync(settingsPath, 'utf8'), USER_SETTINGS);
  rmSync(home, { recursive: true, force: true });
});

test('the router switch moves claude both ways, and the backup survives it', async () => {
  const home = makeHome();
  const settingsPath = writeSettings(home, USER_SETTINGS);
  // The launch takes over before the Router page is touched...
  const binding = new RouterBinding();
  const integration = makeIntegration(home, { routerBinding: binding });
  await integration.activate();
  assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8')).model, 'opus');

  // ...the switch goes on, and the republish that follows moves the picker.
  binding.bind(ROUTER_URL, RouterModel.forSingleModel({ routeName: CLOUD_ROUTE, displayName: 'gpt-5.6-terra' }));
  assert.equal(await integration.syncSettings(), true);
  const routed = JSON.parse(readFileSync(settingsPath, 'utf8'));
  // The user's model is still untouched; only the picker gained the pair.
  assert.equal(routed.model, 'opus');
  assert.ok(routed.availableModels.includes(ROUTER_ALIAS));
  assert.equal(routed.env.ANTHROPIC_BASE_URL, ROUTER_URL);
  assert.deepEqual(routed.permissions.allow, ['Bash(npm run test)']);

  // ...and off again, which takes the pair away and hands the port back.
  binding.release();
  assert.equal(await integration.syncSettings(), true);
  const reverted = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(reverted.model, 'opus');
  assert.equal(reverted.availableModels, undefined);
  assert.equal(reverted.env.ANTHROPIC_BASE_URL, GATEWAY_URL);

  // Every refresh rewrote the file, not the backup: quit still returns the original.
  integration.deactivate();
  assert.equal(readFileSync(settingsPath, 'utf8'), USER_SETTINGS);
  rmSync(home, { recursive: true, force: true });
});

test('a sync without a takeover leaves the file untouched', async () => {
  const home = makeHome();
  const settingsPath = writeSettings(home, USER_SETTINGS);

  assert.equal(await makeIntegration(home, { routerBinding: boundRouter() }).syncSettings(), false);

  assert.equal(readFileSync(settingsPath, 'utf8'), USER_SETTINGS);
  rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Claude Desktop configLibrary
// ---------------------------------------------------------------------------

/** Tokkey's own entry id; see `ClaudeDesktopConfigLibrary`. */
const TOKKEY_ENTRY_ID = '00000000-0000-4000-8000-000000157211';
const FOREIGN_ENTRY_ID = '00000000-0000-4000-8000-000000157210';

function configLibraryOf(home) {
  return path.join(home, 'Library', 'Application Support', 'Claude-3p', 'configLibrary');
}

function metaBackupPathOf(home) {
  return path.join(home, '.tokkey', 'desktop-config-meta-backup.json');
}

function tokkeyEntryPathOf(home) {
  return path.join(configLibraryOf(home), `${TOKKEY_ENTRY_ID}.json`);
}

function readDesktopMeta(home) {
  return JSON.parse(readFileSync(path.join(configLibraryOf(home), '_meta.json'), 'utf8'));
}

/** Seeds a configLibrary that another tool (cc-switch) already owns. */
function writeForeignMeta(home, id = FOREIGN_ENTRY_ID) {
  mkdirSync(configLibraryOf(home), { recursive: true });
  const meta = { appliedId: id, entries: [{ id, name: 'cc-switch' }] };
  writeFileSync(path.join(configLibraryOf(home), '_meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

function makeDesktopLibrary(home) {
  return new ClaudeDesktopConfigLibrary({
    configLibraryDir: configLibraryOf(home),
    metaBackupPath: metaBackupPathOf(home)
  });
}

test('desktop publishes the router model the moment it is bound at launch', async () => {
  const home = makeHome();
  writeSettings(home, USER_SETTINGS);
  const foreign = writeForeignMeta(home);
  const integration = makeIntegration(home, { routerBinding: boundRouter() });

  assert.equal(await integration.activate(), true);

  const meta = readDesktopMeta(home);
  assert.equal(meta.appliedId, TOKKEY_ENTRY_ID);
  // cc-switch's own entry stays listed; only Tokkey's is added and applied.
  assert.deepEqual(meta.entries.map((entry) => entry.id), [FOREIGN_ENTRY_ID, TOKKEY_ENTRY_ID]);
  const entry = JSON.parse(readFileSync(tokkeyEntryPathOf(home), 'utf8'));
  assert.equal(entry.inferenceGatewayBaseUrl, ROUTER_URL);
  // Desktop must call the router profile, not the stale cloud route behind it.
  assert.deepEqual(entry.inferenceModels, [{ name: ROUTER_ALIAS, labelOverride: RouterModel.DISPLAY_NAME }]);

  // Quitting hands the whole index back, cc-switch's entry untouched.
  integration.deactivate();
  assert.deepEqual(readDesktopMeta(home), foreign);
  assert.equal(existsSync(tokkeyEntryPathOf(home)), false);
  rmSync(home, { recursive: true, force: true });
});

test('the router switch moves desktop both ways, alongside claude code', async () => {
  const home = makeHome();
  writeSettings(home, USER_SETTINGS);
  const foreign = writeForeignMeta(home);
  const binding = new RouterBinding();
  const integration = makeIntegration(home, { routerBinding: binding });

  // The router is off at launch: desktop is left exactly as the user had it.
  await integration.activate();
  assert.deepEqual(readDesktopMeta(home), foreign);
  assert.equal(existsSync(tokkeyEntryPathOf(home)), false);

  // ...the switch goes on, and the republish that follows signs desktop in.
  binding.bind(ROUTER_URL, RouterModel.forSingleModel({ routeName: CLOUD_ROUTE, displayName: 'gpt-5.6-terra' }));
  assert.equal(await integration.syncSettings(), true);
  assert.equal(readDesktopMeta(home).appliedId, TOKKEY_ENTRY_ID);
  const routedEntry = JSON.parse(readFileSync(tokkeyEntryPathOf(home), 'utf8'));
  assert.equal(routedEntry.inferenceGatewayBaseUrl, ROUTER_URL);
  // Switching on must publish the router profile, not its selected backend.
  assert.deepEqual(routedEntry.inferenceModels, [
    { name: ROUTER_ALIAS, labelOverride: RouterModel.DISPLAY_NAME }
  ]);

  // ...and off again, which hands the configLibrary straight back.
  binding.release();
  assert.equal(await integration.syncSettings(), true);
  assert.deepEqual(readDesktopMeta(home), foreign);
  assert.equal(existsSync(tokkeyEntryPathOf(home)), false);

  integration.deactivate();
  assert.deepEqual(readDesktopMeta(home), foreign);
  rmSync(home, { recursive: true, force: true });
});

test('a configLibrary an earlier build took over is handed back on the next launch', () => {
  const home = makeHome();
  const foreign = writeForeignMeta(home);
  // Exactly what the previous build left behind: its own entry, the index
  // pointing at it, and the user's index saved aside.
  mkdirSync(path.dirname(metaBackupPathOf(home)), { recursive: true });
  writeFileSync(metaBackupPathOf(home), JSON.stringify(foreign, null, 2));
  writeFileSync(tokkeyEntryPathOf(home), '{}');
  writeFileSync(
    path.join(configLibraryOf(home), '_meta.json'),
    JSON.stringify({ appliedId: TOKKEY_ENTRY_ID, entries: [{ id: TOKKEY_ENTRY_ID }] }, null, 2)
  );

  assert.equal(makeIntegration(home).recoverInterruptedSession(), true);

  assert.deepEqual(readDesktopMeta(home), foreign);
  assert.equal(existsSync(tokkeyEntryPathOf(home)), false);
  assert.equal(existsSync(metaBackupPathOf(home)), false);
  rmSync(home, { recursive: true, force: true });
});

test('the meta index points at tokkey without unlisting another tool', () => {
  const home = makeHome();
  const foreign = writeForeignMeta(home);
  const library = makeDesktopLibrary(home);

  assert.equal(library.activate(GATEWAY_URL, [{ name: 'anthropic.c05442' }]), true);

  const meta = readDesktopMeta(home);
  assert.equal(meta.appliedId, TOKKEY_ENTRY_ID);
  assert.deepEqual(meta.entries.map((entry) => entry.id), [FOREIGN_ENTRY_ID, TOKKEY_ENTRY_ID]);

  // Quit hands the whole index back, and takes Tokkey's own entry with it.
  library.restore();
  assert.deepEqual(readDesktopMeta(home), foreign);
  assert.equal(existsSync(tokkeyEntryPathOf(home)), false);
  rmSync(home, { recursive: true, force: true });
});

test('a takeover with no models to offer is refused', () => {
  const home = makeHome();
  const foreign = writeForeignMeta(home);

  // Desktop signs in by running one inference call against a model from this
  // list, so an entry with no models cannot be signed into at all.
  assert.equal(makeDesktopLibrary(home).activate(GATEWAY_URL, []), false);

  assert.deepEqual(readDesktopMeta(home), foreign);
  assert.equal(existsSync(tokkeyEntryPathOf(home)), false);
  rmSync(home, { recursive: true, force: true });
});
