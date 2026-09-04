import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexTomlDocument } from '../dist/main/codex/CodexTomlDocument.js';
import { CodexCatalogGenerator, CatalogEntryFactory } from '../dist/main/codex/CodexCatalogGenerator.js';
import { CodexConfigTakeover } from '../dist/main/codex/CodexConfigTakeover.js';
import { CodexGatewayIntegration } from '../dist/main/codex/CodexGatewayIntegration.js';
import { RouterBinding } from '../dist/main/router/RouterBinding.js';
import { RouterModel } from '../dist/main/router/RouterModel.js';

/** A throwaway home holding both `.codex` and `.tokkey`. */
function makeHome() {
  return mkdtempSync(path.join(tmpdir(), 'tokkey-codexconfig-'));
}

function codexHomeOf(home) {
  return path.join(home, '.codex');
}

/** Writes a `config.toml` into the throwaway codex home and returns its path. */
function writeConfig(home, text) {
  mkdirSync(codexHomeOf(home), { recursive: true });
  const filePath = path.join(codexHomeOf(home), 'config.toml');
  writeFileSync(filePath, text);
  return filePath;
}

const USER_CONFIG = `# hand written
model_provider = "openai"
model = "gpt-5.5"

[model_providers.openai]
name = "OpenAI"
base_url = "https://api.openai.com/v1"

[mcp_servers.testhttp]
url = "https://example.invalid/mcp"
`;

// ---------------------------------------------------------------------------
// CodexTomlDocument
// ---------------------------------------------------------------------------

test('replaces a root key in place and leaves comments and tables alone', () => {
  const rewritten = new CodexTomlDocument(USER_CONFIG).setRootKey('model_provider', 'tokkey').toString();

  assert.ok(rewritten.startsWith('# hand written\nmodel_provider = "tokkey"\n'));
  assert.ok(rewritten.includes('model = "gpt-5.5"'));
  assert.ok(rewritten.includes('[mcp_servers.testhttp]'));
});

test('inserts a new root key before the first table, never after it', () => {
  const rewritten = new CodexTomlDocument(USER_CONFIG)
    .setRootKey('model_catalog_json', '/tmp/amis-catalog.json')
    .toString();

  const keyIndex = rewritten.indexOf('model_catalog_json');
  assert.ok(keyIndex !== -1);
  assert.ok(keyIndex < rewritten.indexOf('[model_providers.openai]'));
});

test('appends and removes a table without touching its neighbours', () => {
  const withTable = new CodexTomlDocument(USER_CONFIG).appendTable(
    ['model_providers', 'tokkey'],
    [['name', 'Tokkey'], ['base_url', 'http://127.0.0.1:4000/v1'], ['requires_openai_auth', true]]
  );

  assert.ok(withTable.toString().endsWith('[model_providers.tokkey]\nname = "Tokkey"\nbase_url = "http://127.0.0.1:4000/v1"\nrequires_openai_auth = true\n'));

  const removed = withTable.removeTable(['model_providers', 'tokkey']).toString();
  assert.ok(!removed.includes('tokkey'));
  assert.ok(removed.includes('[model_providers.openai]'));
  assert.ok(removed.includes('[mcp_servers.testhttp]'));
});

test('a key inside a table is not mistaken for the root key of the same name', () => {
  const document = new CodexTomlDocument('[profiles.work]\nmodel_provider = "work"\n');

  const rewritten = document.setRootKey('model_provider', 'tokkey').toString();

  assert.ok(rewritten.startsWith('model_provider = "tokkey"\n'));
  assert.ok(rewritten.includes('[profiles.work]\nmodel_provider = "work"'));
});

// ---------------------------------------------------------------------------
// CodexConfigTakeover
// ---------------------------------------------------------------------------

/** The takeover under a throwaway home, with `.codex` already created. */
function makeTakeover(home) {
  return new CodexConfigTakeover({ homeDirectory: home, codexHome: codexHomeOf(home) });
}

test('points codex at the gateway and hands the original file back at quit', () => {
  const home = makeHome();
  const configPath = writeConfig(home, USER_CONFIG);
  const takeover = makeTakeover(home);

  assert.equal(takeover.activate('http://127.0.0.1:4173', '/tmp/amis-catalog.json'), true);

  const taken = readFileSync(configPath, 'utf8');
  assert.ok(taken.includes('model_provider = "tokkey"'));
  assert.ok(taken.includes('model_catalog_json = "/tmp/amis-catalog.json"'));
  assert.ok(taken.includes('base_url = "http://127.0.0.1:4173/v1"'));
  assert.ok(taken.includes('wire_api = "responses"'));
  // The user's own provider survives the takeover untouched.
  assert.ok(taken.includes('base_url = "https://api.openai.com/v1"'));

  assert.equal(takeover.restore(), true);
  assert.equal(readFileSync(configPath, 'utf8'), USER_CONFIG);
  assert.equal(existsSync(takeover.backupFilePath), false);
  rmSync(home, { recursive: true, force: true });
});

test('restores a config the previous run was killed before restoring', () => {
  const home = makeHome();
  const configPath = writeConfig(home, USER_CONFIG);
  // A session that never reached its restore: the file is taken over and the
  // backup is still on disk.
  makeTakeover(home).activate('http://127.0.0.1:4173', null);
  assert.ok(readFileSync(configPath, 'utf8').includes('model_provider = "tokkey"'));

  const recovered = makeTakeover(home).recoverInterruptedSession();

  assert.equal(recovered, true);
  assert.equal(readFileSync(configPath, 'utf8'), USER_CONFIG);
  rmSync(home, { recursive: true, force: true });
});

test('leaves a config edited after an interrupted session exactly as the user left it', () => {
  const home = makeHome();
  const configPath = writeConfig(home, USER_CONFIG);
  const killed = makeTakeover(home);
  killed.activate('http://127.0.0.1:4173', null);
  // The user finds Tokkey's leftover file and edits it, not knowing it is on loan.
  const userEdit = readFileSync(configPath, 'utf8').replace('model = "gpt-5.5"', 'model = "gpt-5.6-sol"');
  writeFileSync(configPath, userEdit);

  const recovered = makeTakeover(home).recoverInterruptedSession();

  // Their edit outranks the stale original: nothing is written over it.
  assert.equal(recovered, false);
  assert.equal(readFileSync(configPath, 'utf8'), userEdit);
  // The pre-takeover original is kept aside rather than dropped, and recovery
  // stops retrying the same decision on every launch.
  assert.equal(existsSync(killed.backupFilePath), false);
  assert.equal(readFileSync(`${killed.backupFilePath}.orphaned`, 'utf8'), USER_CONFIG);
  rmSync(home, { recursive: true, force: true });
});

test('leaves a config edited during the session alone at quit', () => {
  const home = makeHome();
  const configPath = writeConfig(home, USER_CONFIG);
  const takeover = makeTakeover(home);
  takeover.activate('http://127.0.0.1:4173', null);
  const userEdit = readFileSync(configPath, 'utf8').replace('model = "gpt-5.5"', 'model = "gpt-5.6-sol"');
  writeFileSync(configPath, userEdit);

  assert.equal(takeover.restore(), false);
  assert.equal(readFileSync(configPath, 'utf8'), userEdit);
  assert.equal(readFileSync(`${takeover.backupFilePath}.orphaned`, 'utf8'), USER_CONFIG);
  rmSync(home, { recursive: true, force: true });
});

test('a mid-session refresh keeps the file restorable', () => {
  const home = makeHome();
  const configPath = writeConfig(home, USER_CONFIG);
  const takeover = makeTakeover(home);
  takeover.activate('http://127.0.0.1:4173', null);
  // A catalog written after activate rewrites the file; the record has to track
  // it, or the restore below would read the refresh as somebody else's edit.
  takeover.activate('http://127.0.0.1:4173', '/tmp/amis-catalog.json');

  assert.equal(takeover.restore(), true);
  assert.equal(readFileSync(configPath, 'utf8'), USER_CONFIG);
  rmSync(home, { recursive: true, force: true });
});

test('a second takeover declares the provider table once, not twice', () => {
  const home = makeHome();
  const configPath = writeConfig(home, USER_CONFIG);

  makeTakeover(home).activate('http://127.0.0.1:4173', null);
  // No restore in between: the second launch recovers, then takes over again.
  makeTakeover(home).activate('http://127.0.0.1:4999', null);

  const taken = readFileSync(configPath, 'utf8');
  assert.equal(taken.split('[model_providers.tokkey]').length - 1, 1);
  assert.ok(taken.includes('base_url = "http://127.0.0.1:4999/v1"'));
  rmSync(home, { recursive: true, force: true });
});

test('leaves no config.toml behind when there was none to begin with', () => {
  const home = makeHome();
  mkdirSync(codexHomeOf(home), { recursive: true });
  const takeover = makeTakeover(home);

  assert.equal(takeover.activate('http://127.0.0.1:4173', null), true);
  assert.ok(readFileSync(takeover.configPath, 'utf8').includes('[model_providers.tokkey]'));

  takeover.restore();
  assert.equal(existsSync(takeover.configPath), false);
  rmSync(home, { recursive: true, force: true });
});

test('restoring without a takeover is a no-op', () => {
  const home = makeHome();
  const configPath = writeConfig(home, USER_CONFIG);

  assert.equal(makeTakeover(home).restore(), false);

  assert.equal(readFileSync(configPath, 'utf8'), USER_CONFIG);
  rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// CodexCatalogGenerator
// ---------------------------------------------------------------------------

/** A native row shaped like the bundled catalog's, with the fields we clone. */
function nativeEntry(slug, overrides = {}) {
  return {
    slug,
    display_name: slug.toUpperCase(),
    description: `${slug} description`,
    visibility: 'list',
    context_window: 400000,
    max_context_window: 400000,
    supported_in_api: true,
    input_modalities: ['text', 'image', 'video'],
    minimal_client_version: '99.0.0',
    availability_nux: { seen: 2 },
    supports_websockets: true,
    base_instructions: 'You are Codex, a coding agent based on GPT-5.5. Be helpful.',
    ...overrides
  };
}

function makeGenerator(home, natives) {
  return new CodexCatalogGenerator({
    catalogPath: path.join(home, 'amis-catalog.json'),
    nativeSource: () => (natives === null ? null : { models: natives })
  });
}

test('seeds the natives once and adds one row per routed model', () => {
  const home = makeHome();
  const generator = makeGenerator(home, [nativeEntry('gpt-5.5')]);

  const result = generator.generate([
    { slug: 'custom-gpt-5.6-terra-openai-c05442', displayName: 'custom/gpt-5.6-terra', ownedBy: 'custom' }
  ]);

  assert.deepEqual(result.models.map((entry) => entry.slug), [
    'gpt-5.5',
    'custom-gpt-5.6-terra-openai-c05442'
  ]);
  const routed = result.models[1];
  assert.equal(routed.display_name, 'custom/gpt-5.6-terra');
  assert.equal(routed.visibility, 'list');
  // Cloned from the native row, so the routed model behaves like a real one...
  assert.ok(typeof routed.base_instructions === 'string');
  // ...without claiming to be it.
  assert.ok(!routed.base_instructions.includes('You are Codex'));
  assert.ok(routed.base_instructions.includes('custom-gpt-5.6-terra-openai-c05442'));
  assert.equal(routed.supports_websockets, undefined);
  // A closed enum: one unknown value would make Codex reject the whole file.
  assert.deepEqual(routed.input_modalities, ['text', 'image']);
  assert.deepEqual(result.models[0].input_modalities, ['text', 'image']);
  // A native row keeps everything else it came with.
  assert.equal(result.models[0].base_instructions, 'You are Codex, a coding agent based on GPT-5.5. Be helpful.');
  assert.equal(result.models[0].minimal_client_version, undefined);
  rmSync(home, { recursive: true, force: true });
});

test('leaves every model without the fields codex derives for itself', () => {
  const home = makeHome();

  const native = nativeEntry('gpt-5.5', {
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
    default_reasoning_level: { effort: 'high' }
  });
  const result = makeGenerator(home, [native]).generate([
    { slug: 'kimi-k3', contextWindow: 256000 }
  ]);

  // Both the seeded native and the routed row, since a guessed window is worse
  // than the metadata Codex holds for the model itself.
  for (const entry of result.models) {
    assert.deepEqual(
      ['context_window', 'max_context_window', 'availability_nux'].filter((field) => field in entry),
      []
    );
  }
  // The native keeps the ladder Codex wrote for it, default included...
  assert.deepEqual(result.models[0].supported_reasoning_levels, [
    { effort: 'low' },
    { effort: 'high' }
  ]);
  assert.deepEqual(result.models[0].default_reasoning_level, { effort: 'high' });
  // ...while a routed row carries an explicit sentinel instead of advertising
  // the levels of the model it was cloned from, and carries no default into it.
  assert.deepEqual(result.models[1].supported_reasoning_levels, [
    { description: 'not supported', effort: 'none' }
  ]);
  assert.equal('default_reasoning_level' in result.models[1], false);
  // The compaction threshold survives, derived from the window it was given.
  assert.equal(result.models[1].auto_compact_token_limit, 230400);
  rmSync(home, { recursive: true, force: true });
});

test('drops a model that is no longer routed and keeps everything else', () => {
  const home = makeHome();
  const generator = makeGenerator(home, [nativeEntry('gpt-5.5')]);
  generator.generate([{ slug: 'first' }, { slug: 'second' }]);

  const result = generator.generate([{ slug: 'first' }]);

  assert.deepEqual(result.models.map((entry) => entry.slug), ['gpt-5.5', 'first']);
  rmSync(home, { recursive: true, force: true });
});

test('preserves a row another tool wrote into the same catalog', () => {
  const home = makeHome();
  const catalogPath = path.join(home, 'amis-catalog.json');
  writeFileSync(
    catalogPath,
    JSON.stringify({
      models: [nativeEntry('gpt-5.5'), { slug: 'other/model', description: 'Routed via something else.' }]
    })
  );

  const result = makeGenerator(home, []).generate([{ slug: 'first' }]);

  assert.deepEqual(result.models.map((entry) => entry.slug), ['gpt-5.5', 'other/model', 'first']);
  rmSync(home, { recursive: true, force: true });
});

test('writes byte-identical output when nothing changed', () => {
  const home = makeHome();
  const generator = makeGenerator(home, [nativeEntry('gpt-5.5')]);
  // The second model declares no window, which is the production shape: its row
  // must not derive anything from the native template it was cloned from, or
  // the seeding run and every run after it would disagree.
  const models = [{ slug: 'first', contextWindow: 200000 }, { slug: 'second' }];

  assert.equal(generator.generate(models).written, true);
  const first = readFileSync(generator.path, 'utf8');
  assert.equal(generator.generate(models).written, false);
  assert.equal(generator.generate(models).written, false);

  assert.equal(readFileSync(generator.path, 'utf8'), first);
  rmSync(home, { recursive: true, force: true });
});

test('still produces a usable row when no native template exists', () => {
  const home = makeHome();

  const result = makeGenerator(home, null).generate([{ slug: 'first' }]);

  assert.deepEqual(result.models.map((entry) => entry.slug), ['first']);
  assert.equal(result.models[0].auto_compact_token_limit, 115200);
  assert.equal(CatalogEntryFactory.isTokkeyAuthored(result.models[0]), true);
  rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// CodexGatewayIntegration
// ---------------------------------------------------------------------------

/** A bundled catalog that never shells out. */
class FakeBundledCatalog {
  constructor(models) {
    this.models = models;
  }

  async list() {
    return this.models;
  }

  readCached() {
    return { models: this.models };
  }
}

const GATEWAY_URL = 'http://127.0.0.1:4173';
const ROUTER_URL = 'http://127.0.0.1:5173';

/** The route the one shipped cloud card derives; see `CloudModelCatalog`. */
const CLOUD_ROUTE = 'custom-gpt-5.6-terra-openai-c05442';
/** What the catalog carries for the routed pair: a fixed slug, same for every pairing. */
const ROUTER_SLUG = RouterModel.DISPLAY_NAME;

/** A binding already switched on, as `RouterAgentIntegration.turnOn` leaves it. */
function boundRouter() {
  const binding = new RouterBinding();
  binding.bind(ROUTER_URL, RouterModel.forSingleModel({ routeName: CLOUD_ROUTE, displayName: 'gpt-5.6-terra' }));
  return binding;
}

function makeIntegration(home, { routerBinding, baseUrl = GATEWAY_URL } = {}) {
  const codexHome = codexHomeOf(home);
  return new CodexGatewayIntegration({
    gateway: { startIfNeeded: async () => {}, baseUrl: () => baseUrl },
    routerBinding: routerBinding ?? new RouterBinding(),
    bundled: new FakeBundledCatalog([nativeEntry('gpt-5.5')]),
    homeDirectory: home,
    codexHome
  });
}

function readCatalog(home) {
  return JSON.parse(readFileSync(path.join(codexHomeOf(home), 'amis-catalog.json'), 'utf8'));
}

test('catalogues the routed pair beside codex own models and points codex at the file', async () => {
  const home = makeHome();
  const configPath = writeConfig(home, USER_CONFIG);
  const integration = makeIntegration(home, { routerBinding: boundRouter() });

  assert.equal(await integration.activate(), true);

  const config = readFileSync(configPath, 'utf8');
  const catalogPath = path.join(codexHomeOf(home), 'amis-catalog.json');
  assert.ok(config.includes(`model_catalog_json = "${catalogPath}"`));
  // Codex follows the router, not the gateway, whenever a pair is bound.
  assert.ok(config.includes(`base_url = "${ROUTER_URL}/v1"`));

  const catalog = readCatalog(home);
  // The native model keeps Codex's own row rather than a derived clone.
  assert.deepEqual(catalog.models.map((entry) => entry.slug), ['gpt-5.5', ROUTER_SLUG]);
  assert.equal(CatalogEntryFactory.isTokkeyAuthored(catalog.models[0]), false);
  assert.equal(catalog.models[1].display_name, 'Tokkey-Router');
  // The slug shows only route names, so the description names both models.
  assert.ok(catalog.models[1].description.includes('local gpt-5.6-terra, cloud gpt-5.6-terra'));

  integration.deactivate();
  assert.equal(readFileSync(configPath, 'utf8'), USER_CONFIG);
  rmSync(home, { recursive: true, force: true });
});

test('the router switch moves codex both ways, and the backup survives it', async () => {
  const home = makeHome();
  const configPath = writeConfig(home, USER_CONFIG);
  // The launch takes over before the Router page is touched...
  const binding = new RouterBinding();
  const integration = makeIntegration(home, { routerBinding: binding });
  await integration.activate();
  assert.deepEqual(readCatalog(home).models.map((entry) => entry.slug), ['gpt-5.5']);

  // ...the switch goes on, and the republish that follows adds the pair.
  binding.bind(ROUTER_URL, RouterModel.forSingleModel({ routeName: CLOUD_ROUTE, displayName: 'gpt-5.6-terra' }));
  await integration.sync();
  assert.deepEqual(readCatalog(home).models.map((entry) => entry.slug), ['gpt-5.5', ROUTER_SLUG]);
  assert.ok(readFileSync(configPath, 'utf8').includes(`base_url = "${ROUTER_URL}/v1"`));

  // ...and off again, which takes the pair away and hands the port back.
  binding.release();
  await integration.sync();
  assert.deepEqual(readCatalog(home).models.map((entry) => entry.slug), ['gpt-5.5']);
  assert.ok(readFileSync(configPath, 'utf8').includes(`base_url = "${GATEWAY_URL}/v1"`));

  // Every refresh rewrote the file, not the backup: quit still returns the original.
  integration.deactivate();
  assert.equal(readFileSync(configPath, 'utf8'), USER_CONFIG);
  rmSync(home, { recursive: true, force: true });
});

test('leaves config.toml alone when the gateway is not running', async () => {
  const home = makeHome();
  const configPath = writeConfig(home, USER_CONFIG);
  const integration = makeIntegration(home, { baseUrl: null });

  assert.equal(await integration.activate(), false);

  assert.equal(readFileSync(configPath, 'utf8'), USER_CONFIG);
  rmSync(home, { recursive: true, force: true });
});

test('does not point codex at a catalog that came out empty', async () => {
  const home = makeHome();
  const configPath = writeConfig(home, USER_CONFIG);

  // No router model and no bundled natives: nothing to catalogue.
  await new CodexGatewayIntegration({
    gateway: { startIfNeeded: async () => {}, baseUrl: () => GATEWAY_URL },
    bundled: new FakeBundledCatalog([]),
    homeDirectory: home,
    codexHome: codexHomeOf(home)
  }).activate();

  const config = readFileSync(configPath, 'utf8');
  assert.ok(!config.includes('model_catalog_json'));
  // The gateway is still wired up: only the model list could not be built.
  assert.ok(config.includes('model_provider = "tokkey"'));
  rmSync(home, { recursive: true, force: true });
});
