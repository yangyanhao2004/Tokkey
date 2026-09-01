import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSettingsDocument } from '../dist/main/claude/ClaudeSettingsDocument.js';
import { ClaudeConfigTakeover } from '../dist/main/claude/ClaudeConfigTakeover.js';
import { ClaudeGatewayIntegration } from '../dist/main/claude/ClaudeGatewayIntegration.js';

/** A throwaway home holding both `.claude` and `.amiswifi`. */
function makeHome() {
  return mkdtempSync(path.join(tmpdir(), 'tokiie-claudeconfig-'));
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

/** The route name the one shipped cloud card derives; see `CloudModelCatalog`. */
const CLOUD_ROUTE = 'custom-gpt-5.6-terra-openai-c05442';

/** The name that route is published under in the pickers; see `ClaudeModelAlias`. */
const CLOUD_ALIAS = `anthropic.${CLOUD_ROUTE}`;

/** A gateway client answering with a fixed set of routes. */
class FakeGatewayModelClient {
  constructor(routes) {
    this.routes = routes;
  }

  async listModels() {
    return this.routes.map((modelName, index) => ({ modelId: String(index), modelName }));
  }
}

function makeIntegration(home, routeNames, baseUrl = 'http://127.0.0.1:4173') {
  return new ClaudeGatewayIntegration({
    gateway: { startIfNeeded: async () => {}, baseUrl: () => baseUrl },
    client: new FakeGatewayModelClient(routeNames),
    homeDirectory: home,
    claudeHome: claudeHomeOf(home)
  });
}

test('pins claude to the connected cloud model and offers the native ones beside it', async () => {
  const home = makeHome();
  const settingsPath = writeSettings(home, USER_SETTINGS);
  const integration = makeIntegration(home, ['claude-opus-5', CLOUD_ROUTE]);

  assert.equal(await integration.activate(), true);

  const taken = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(taken.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4173');
  // The cloud route is pinned under the alias its picker row is built from —
  // the bare route name would name nothing `availableModels` offers.
  assert.equal(taken.model, CLOUD_ALIAS);
  assert.equal(taken.enforceAvailableModels, true);
  // The cloud model leads, and every Claude model the gateway routes follows.
  assert.equal(taken.availableModels[0], CLOUD_ALIAS);
  assert.ok(taken.availableModels.includes('claude-opus-5'));
  assert.ok(taken.availableModels.slice(1).every((model) => model.startsWith('claude-')));

  integration.deactivate();
  assert.equal(readFileSync(settingsPath, 'utf8'), USER_SETTINGS);
  rmSync(home, { recursive: true, force: true });
});

test('leaves the user their own model when no cloud model is connected', async () => {
  const home = makeHome();
  const settingsPath = writeSettings(home, USER_SETTINGS);

  assert.equal(await makeIntegration(home, ['claude-opus-5']).activate(), true);

  const taken = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(taken.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4173');
  assert.equal(taken.model, 'opus');
  assert.equal(taken.availableModels, undefined);
  assert.equal(taken.enforceAvailableModels, undefined);
  rmSync(home, { recursive: true, force: true });
});

test('leaves settings.json alone when the gateway is not running', async () => {
  const home = makeHome();
  const settingsPath = writeSettings(home, USER_SETTINGS);

  assert.equal(await makeIntegration(home, [CLOUD_ROUTE], null).activate(), false);

  assert.equal(readFileSync(settingsPath, 'utf8'), USER_SETTINGS);
  rmSync(home, { recursive: true, force: true });
});

test('a model connected mid-session reaches the picker, and the backup survives it', async () => {
  const home = makeHome();
  const settingsPath = writeSettings(home, USER_SETTINGS);
  // The launch takes over before any cloud model is connected...
  const routes = ['claude-opus-5'];
  const integration = makeIntegration(home, routes);
  await integration.activate();
  assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8')).model, 'opus');

  // ...and the connect that follows registers the route and republishes.
  routes.push(CLOUD_ROUTE);
  assert.equal(await integration.syncSettings(), true);

  const synced = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(synced.model, CLOUD_ALIAS);
  assert.equal(synced.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4173');
  assert.deepEqual(synced.permissions.allow, ['Bash(npm run test)']);
  // The refresh rewrote the file, not the backup: quit still returns the original.
  integration.deactivate();
  assert.equal(readFileSync(settingsPath, 'utf8'), USER_SETTINGS);
  rmSync(home, { recursive: true, force: true });
});

test('a sync without a takeover leaves the file untouched', async () => {
  const home = makeHome();
  const settingsPath = writeSettings(home, USER_SETTINGS);

  assert.equal(await makeIntegration(home, [CLOUD_ROUTE]).syncSettings(), false);

  assert.equal(readFileSync(settingsPath, 'utf8'), USER_SETTINGS);
  rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Claude Desktop configLibrary
// ---------------------------------------------------------------------------

/** Tokiie's own entry id; see `ClaudeDesktopConfigLibrary`. */
const TOKIIE_ENTRY_ID = '00000000-0000-4000-8000-000000157211';

/** The name the cloud route is published under in Desktop's picker. */
const DESKTOP_ALIAS = 'anthropic.c05442';

function configLibraryOf(home) {
  return path.join(home, 'Library', 'Application Support', 'Claude-3p', 'configLibrary');
}

function readDesktopEntry(home) {
  return JSON.parse(readFileSync(path.join(configLibraryOf(home), `${TOKIIE_ENTRY_ID}.json`), 'utf8'));
}

function readDesktopMeta(home) {
  return JSON.parse(readFileSync(path.join(configLibraryOf(home), '_meta.json'), 'utf8'));
}

/** Seeds a configLibrary that another tool (cc-switch) already owns. */
function writeForeignMeta(home, id) {
  mkdirSync(configLibraryOf(home), { recursive: true });
  const meta = { appliedId: id, entries: [{ id, name: 'cc-switch' }] };
  writeFileSync(path.join(configLibraryOf(home), '_meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

test('desktop is offered the cloud model alone, under a name its validator accepts', async () => {
  const home = makeHome();
  writeSettings(home, USER_SETTINGS);
  const integration = makeIntegration(home, ['claude-opus-5', CLOUD_ROUTE]);

  await integration.activate();

  const entry = readDesktopEntry(home);
  assert.equal(entry.inferenceGatewayBaseUrl, 'http://127.0.0.1:4173');
  // One of Desktop's five credential kinds; anything else leaves the entry
  // with no credential and sign-in fails outright.
  assert.equal(entry.inferenceCredentialKind, 'static');
  assert.equal(entry.inferenceGatewayAuthScheme, 'bearer');
  // Only the cloud route: the native Claude routes carry no key, and Desktop's
  // sign-in probe would send them the static gateway token and get a 401.
  assert.deepEqual(entry.inferenceModels, [
    { name: DESKTOP_ALIAS, labelOverride: 'gpt-5.6-terra', anthropicFamilyTier: 'opus' }
  ]);

  integration.deactivate();
  rmSync(home, { recursive: true, force: true });
});

test('desktop keeps its own config when no cloud model is connected', async () => {
  const home = makeHome();
  writeSettings(home, USER_SETTINGS);
  const foreign = writeForeignMeta(home, '00000000-0000-4000-8000-000000157210');

  await makeIntegration(home, ['claude-opus-5']).activate();

  // A takeover with nothing to offer produces an entry Desktop cannot sign
  // into, so the configLibrary is left exactly as the user had it.
  assert.deepEqual(readDesktopMeta(home), foreign);
  assert.equal(existsSync(path.join(configLibraryOf(home), `${TOKIIE_ENTRY_ID}.json`)), false);
  rmSync(home, { recursive: true, force: true });
});

test('the meta index points at tokiie without unlisting another tool', async () => {
  const home = makeHome();
  writeSettings(home, USER_SETTINGS);
  const foreignId = '00000000-0000-4000-8000-000000157210';
  const foreign = writeForeignMeta(home, foreignId);
  const integration = makeIntegration(home, [CLOUD_ROUTE]);

  await integration.activate();

  const meta = readDesktopMeta(home);
  assert.equal(meta.appliedId, TOKIIE_ENTRY_ID);
  assert.deepEqual(meta.entries.map((entry) => entry.id), [foreignId, TOKIIE_ENTRY_ID]);

  // Quit hands the whole index back, and takes Tokiie's own entry with it.
  integration.deactivate();
  assert.deepEqual(readDesktopMeta(home), foreign);
  assert.equal(existsSync(path.join(configLibraryOf(home), `${TOKIIE_ENTRY_ID}.json`)), false);
  rmSync(home, { recursive: true, force: true });
});

test('a model connected mid-session reaches the desktop picker too', async () => {
  const home = makeHome();
  writeSettings(home, USER_SETTINGS);
  const routes = [CLOUD_ROUTE];
  const integration = makeIntegration(home, routes);
  await integration.activate();

  routes.length = 0;
  routes.push(CLOUD_ROUTE, 'claude-opus-5');
  await integration.syncSettings();

  assert.deepEqual(
    readDesktopEntry(home).inferenceModels.map((model) => model.name),
    [DESKTOP_ALIAS]
  );
  integration.deactivate();
  rmSync(home, { recursive: true, force: true });
});
