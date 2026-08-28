import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CloudModelCatalog, EnvFile } from '../dist/main/models/CloudModelCatalog.js';
import { CloudModelConnector } from '../dist/main/models/CloudModelConnector.js';
import {
  GatewayModelClient,
  GatewayRequestError
} from '../dist/main/gateway/GatewayModelClient.js';

const CARD = {
  id: 'c0544234-d84a-4764-99eb-f39fdefa8add',
  provider: 'custom',
  modelName: 'gpt-5.6-terra',
  url: 'https://api.onetokens.net',
  prefix: 'openai'
};

const ROUTE_NAME = 'custom-gpt-5.6-terra-openai-c05442';

// The key is read from the environment, so the connect tests are pinned to a
// file that does not exist and a cleared variable: nothing here may depend on
// whatever the developer happens to have in `~/.env`.
delete process.env.TOK_API_KEY;
const NO_ENV_FILE = new EnvFile(path.join(tmpdir(), 'tokiie-absent.env'));

/** A catalog over the given cards that resolves no API key. */
function buildCatalog(cards = [CARD]) {
  return new CloudModelCatalog(cards, NO_ENV_FILE);
}

/** An in-memory stand-in for the SQLite-backed profile store. */
class FakeModelProfileStore {
  constructor(profiles = []) {
    this.profiles = new Map(profiles.map((profile) => [profile.id, profile]));
    this.saves = [];
  }

  async find(profileId) {
    return this.profiles.get(profileId) ?? null;
  }

  async save(profile) {
    this.saves.push(profile);
    this.profiles.set(profile.id, profile);
  }
}

/** A gateway supervisor double that records whether it was asked to start. */
class FakeGateway {
  constructor(baseUrl = 'http://127.0.0.1:4000') {
    this.url = baseUrl;
    this.startCount = 0;
  }

  async startIfNeeded() {
    this.startCount += 1;
  }

  baseUrl() {
    return this.url;
  }

  bearerToken() {
    return 'sk-123456';
  }
}

/** Builds a fetch double over a canned per-path response table. */
function gatewayResponder(routes, created = { id: 'route-uuid-1' }) {
  const calls = [];
  const fetcher = async (input, init) => {
    calls.push({ input, init, body: init.body ? JSON.parse(init.body) : null });
    if (input.endsWith('/model/info')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: routes.map((route) => ({
            model_name: route.modelName,
            litellm_params: {},
            model_info: { id: route.modelId }
          }))
        })
      };
    }
    // A created route joins the table, so a later call sees what the gateway
    // would now be holding.
    routes.push({ modelId: created.id, modelName: JSON.parse(init.body).model_name });
    return { ok: true, status: 200, json: async () => ({ model_id: created.id }) };
  };
  return { fetcher, calls };
}

/** Assembles a connector over the doubles above. */
function buildConnector({ store = new FakeModelProfileStore(), routes = [], created } = {}) {
  const gateway = new FakeGateway();
  const { fetcher, calls } = gatewayResponder(routes, created);
  const connector = new CloudModelConnector({
    catalog: buildCatalog(),
    store,
    client: new GatewayModelClient({ gateway, fetcher })
  });
  return { connector, store, calls, gateway };
}

test('the catalog hands out copies so a caller cannot mutate the shipped card', () => {
  const catalog = buildCatalog();
  catalog.list()[0].url = 'https://evil.example';
  assert.equal(catalog.require(CARD.id).url, 'https://api.onetokens.net');
});

test('requiring an unknown card fails with the requested id', () => {
  const catalog = buildCatalog();
  assert.throws(() => catalog.require('missing'), /Cloud model card not found: missing/);
});

test('a card with no key configured anywhere is still served', () => {
  assert.equal(buildCatalog().list()[0].apiKey, '');
  assert.equal(buildCatalog().require(CARD.id).apiKey, '');
});

test('every served card carries the key written in the env file', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'tokiie-env-'));
  const envPath = path.join(directory, '.env');
  try {
    writeFileSync(
      envPath,
      ['# a comment', '', 'DEEPSEEK_API_KEY=other', 'TOK_API_KEY = "sk-from-file" '].join('\n')
    );
    const catalog = new CloudModelCatalog([CARD], new EnvFile(envPath));

    assert.equal(catalog.list()[0].apiKey, 'sk-from-file');
    assert.equal(catalog.require(CARD.id).apiKey, 'sk-from-file');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a real environment variable overrides the env file', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'tokiie-env-'));
  const envPath = path.join(directory, '.env');
  try {
    writeFileSync(envPath, 'TOK_API_KEY=sk-from-file\n');
    process.env.TOK_API_KEY = 'sk-from-shell';
    const catalog = new CloudModelCatalog([CARD], new EnvFile(envPath));

    assert.equal(catalog.list()[0].apiKey, 'sk-from-shell');
  } finally {
    delete process.env.TOK_API_KEY;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a key added to the env file after startup is picked up without a restart', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'tokiie-env-'));
  const envPath = path.join(directory, '.env');
  try {
    const catalog = new CloudModelCatalog([CARD], new EnvFile(envPath));
    assert.equal(catalog.list()[0].apiKey, '');

    writeFileSync(envPath, 'TOK_API_KEY=sk-written-later\n');

    assert.equal(catalog.list()[0].apiKey, 'sk-written-later');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a first connect creates the route and persists the profile', async () => {
  const { connector, store, calls } = buildConnector();

  const connection = await connector.connect(CARD.id);

  assert.equal(connection.status, 'connected');
  const create = calls.find((call) => call.input.endsWith('/model/new'));
  assert.deepEqual(create.body, {
    model_name: ROUTE_NAME,
    litellm_params: {
      model: 'openai/gpt-5.6-terra',
      api_key: '',
      api_base: 'https://api.onetokens.net'
    },
    model_info: {
      created_by: 'amis-wifi',
      profile_id: CARD.id,
      api_format: 'AMIS_GATEWAY_MANAGED',
      supports_native_streaming: true,
      supports_responses_sse_passthrough: false
    }
  });
  assert.equal(create.init.headers.Authorization, 'Bearer sk-123456');
  assert.equal(store.saves.length, 1);
  assert.deepEqual(store.saves[0].litellmLinks, [
    { modelID: 'route-uuid-1', apiFormat: 'AMIS_GATEWAY_MANAGED', modelName: ROUTE_NAME }
  ]);
});

test('the persisted profile matches the row described by the card', async () => {
  const { connector, store } = buildConnector();

  await connector.connect(CARD.id);

  const saved = store.saves[0];
  assert.equal(saved.id, CARD.id);
  assert.equal(saved.name, '');
  assert.equal(saved.provider, 'custom');
  assert.equal(saved.apiUrl, 'https://api.onetokens.net');
  assert.equal(saved.apiKey, '');
  assert.equal(saved.modelName, 'gpt-5.6-terra');
  assert.equal(saved.type, 'cloud');
  assert.deepEqual(saved.supportedApiFormats, ['AMIS_GATEWAY_MANAGED']);
  // Seconds, not milliseconds: the shared database stores REAL Unix timestamps.
  assert.ok(saved.createdAt > 1_600_000_000 && saved.createdAt < 100_000_000_000);
});

test('the route is created before the profile is persisted', async () => {
  const store = new FakeModelProfileStore();
  const order = [];
  const originalSave = store.save.bind(store);
  store.save = async (profile) => {
    order.push('save');
    return originalSave(profile);
  };
  const { connector, calls } = buildConnector({ store });
  calls.push = new Proxy(calls.push, {
    apply(target, thisArg, args) {
      if (args[0].input.endsWith('/model/new')) order.push('create');
      return Reflect.apply(target, thisArg, args);
    }
  });

  await connector.connect(CARD.id);

  assert.deepEqual(order, ['create', 'save']);
});

test('nothing is created or written when the profile and its route both survive', async () => {
  const stored = {
    id: CARD.id,
    name: '',
    provider: 'custom',
    apiUrl: 'https://api.onetokens.net',
    apiKey: '',
    modelName: 'gpt-5.6-terra',
    type: 'cloud',
    supportedApiFormats: ['AMIS_GATEWAY_MANAGED'],
    litellmLinks: [
      { modelID: 'route-uuid-1', apiFormat: 'AMIS_GATEWAY_MANAGED', modelName: ROUTE_NAME }
    ],
    createdAt: 1_787_000_000
  };
  const { connector, store, calls } = buildConnector({
    store: new FakeModelProfileStore([stored]),
    routes: [{ modelId: 'route-uuid-1', modelName: ROUTE_NAME }]
  });

  const connection = await connector.connect(CARD.id);

  assert.equal(connection.status, 'alreadyConnected');
  assert.equal(connection.profile.createdAt, 1_787_000_000);
  assert.equal(store.saves.length, 0);
  assert.equal(calls.filter((call) => call.input.endsWith('/model/new')).length, 0);
});

test('a stored profile whose route is gone is reconnected under the same id', async () => {
  const stored = {
    id: CARD.id,
    name: 'named by the user',
    provider: 'custom',
    apiUrl: 'https://api.onetokens.net',
    apiKey: '',
    modelName: 'gpt-5.6-terra',
    type: 'cloud',
    supportedApiFormats: ['AMIS_GATEWAY_MANAGED'],
    litellmLinks: [
      { modelID: 'dead-route', apiFormat: 'AMIS_GATEWAY_MANAGED', modelName: ROUTE_NAME }
    ],
    createdAt: 1_787_000_000
  };
  const { connector, store } = buildConnector({
    store: new FakeModelProfileStore([stored]),
    created: { id: 'route-uuid-2' }
  });

  const connection = await connector.connect(CARD.id);

  assert.equal(connection.status, 'reconnected');
  assert.equal(store.saves.length, 1);
  // Reconnecting repoints the profile without rewriting what the user owns.
  assert.equal(store.saves[0].name, 'named by the user');
  assert.equal(store.saves[0].createdAt, 1_787_000_000);
  assert.equal(store.saves[0].litellmLinks[0].modelID, 'route-uuid-2');
});

test('a route already registered under this name is adopted, not recreated', async () => {
  const { connector, store, calls } = buildConnector({
    routes: [{ modelId: 'pre-existing', modelName: ROUTE_NAME }]
  });

  const connection = await connector.connect(CARD.id);

  assert.equal(connection.status, 'connected');
  assert.equal(calls.filter((call) => call.input.endsWith('/model/new')).length, 0);
  assert.equal(store.saves[0].litellmLinks[0].modelID, 'pre-existing');
});

test('an unrelated route in the gateway does not satisfy the connect', async () => {
  const { connector, calls } = buildConnector({
    routes: [{ modelId: 'other', modelName: 'local-qwen3-8b-openai_responses' }]
  });

  await connector.connect(CARD.id);

  assert.equal(calls.filter((call) => call.input.endsWith('/model/new')).length, 1);
});

/** The row an earlier run would have left behind for the card. */
function savedProfile(modelId = 'route-uuid-1') {
  return {
    id: CARD.id,
    name: '',
    provider: 'custom',
    apiUrl: 'https://api.onetokens.net',
    apiKey: '',
    modelName: 'gpt-5.6-terra',
    type: 'cloud',
    supportedApiFormats: ['AMIS_GATEWAY_MANAGED'],
    litellmLinks: [{ modelID: modelId, apiFormat: 'AMIS_GATEWAY_MANAGED', modelName: ROUTE_NAME }],
    createdAt: 1_787_000_000
  };
}

test('a restart restores the route of a saved card the gateway no longer holds', async () => {
  const { connector, store, calls } = buildConnector({
    store: new FakeModelProfileStore([savedProfile('dead-route')]),
    created: { id: 'route-uuid-2' }
  });

  const restored = await connector.restoreConnected();

  assert.equal(restored.length, 1);
  assert.equal(restored[0].card.id, CARD.id);
  assert.equal(restored[0].status, 'reconnected');
  assert.equal(calls.filter((call) => call.input.endsWith('/model/new')).length, 1);
  assert.equal(store.saves[0].litellmLinks[0].modelID, 'route-uuid-2');
});

test('a restore leaves a card that was never connected alone', async () => {
  const { connector, store, calls } = buildConnector();

  assert.deepEqual(await connector.restoreConnected(), []);

  assert.equal(calls.length, 0);
  assert.equal(store.saves.length, 0);
});

test('a restore writes nothing when the route outlived the app', async () => {
  const { connector, store, calls } = buildConnector({
    store: new FakeModelProfileStore([savedProfile()]),
    routes: [{ modelId: 'route-uuid-1', modelName: ROUTE_NAME }]
  });

  const restored = await connector.restoreConnected();

  assert.equal(restored[0].status, 'alreadyConnected');
  assert.equal(calls.filter((call) => call.input.endsWith('/model/new')).length, 0);
  assert.equal(store.saves.length, 0);
});

test('two connects for one card share a single attempt instead of racing', async () => {
  const { connector, store, calls } = buildConnector();

  // What a restore overlapping a click does: the gateway rejects a duplicate
  // route name, so the second caller has to wait on the first, not repeat it.
  const [first, second] = await Promise.all([connector.connect(CARD.id), connector.connect(CARD.id)]);

  assert.equal(first, second);
  assert.equal(calls.filter((call) => call.input.endsWith('/model/new')).length, 1);
  assert.equal(store.saves.length, 1);
});

test('a card connects again after its previous attempt settled', async () => {
  const { connector, calls } = buildConnector();

  await connector.connect(CARD.id);
  await connector.connect(CARD.id);

  // The second connect adopts what the first created rather than creating again.
  assert.equal(calls.filter((call) => call.input.endsWith('/model/new')).length, 1);
  assert.equal(calls.filter((call) => call.input.endsWith('/model/info')).length, 2);
});

test('an already-prefixed card model name is not prefixed twice', async () => {
  const gateway = new FakeGateway();
  const { fetcher, calls } = gatewayResponder([]);
  const connector = new CloudModelConnector({
    catalog: buildCatalog([{ ...CARD, modelName: 'OpenAI/gpt-5.6-terra' }]),
    store: new FakeModelProfileStore(),
    client: new GatewayModelClient({ gateway, fetcher })
  });

  await connector.connect(CARD.id);

  const create = calls.find((call) => call.input.endsWith('/model/new'));
  assert.equal(create.body.litellm_params.model, 'OpenAI/gpt-5.6-terra');
});

test('the gateway is started before any management call', async () => {
  const { connector, gateway } = buildConnector();

  await connector.connect(CARD.id);

  assert.ok(gateway.startCount >= 1);
});

test('a gateway that never came up fails the connect with a clear reason', async () => {
  const gateway = new FakeGateway(null);
  const connector = new CloudModelConnector({
    catalog: buildCatalog(),
    store: new FakeModelProfileStore(),
    client: new GatewayModelClient({ gateway, fetcher: async () => assert.fail('no request') })
  });

  await assert.rejects(connector.connect(CARD.id), /The local gateway is not running/);
});

test('a rejected creation surfaces the gateway detail and writes nothing', async () => {
  const store = new FakeModelProfileStore();
  const gateway = new FakeGateway();
  const connector = new CloudModelConnector({
    catalog: buildCatalog(),
    store,
    client: new GatewayModelClient({
      gateway,
      fetcher: async (input) =>
        input.endsWith('/model/info')
          ? { ok: true, status: 200, json: async () => ({ data: [] }) }
          : {
              ok: false,
              status: 400,
              json: async () => ({ detail: "model_name 'x' already exists" })
            }
    })
  });

  await assert.rejects(connector.connect(CARD.id), (error) => {
    assert.ok(error instanceof GatewayRequestError);
    assert.equal(error.status, 400);
    assert.match(error.message, /model_name 'x' already exists/);
    return true;
  });
  assert.equal(store.saves.length, 0);
});

test('a creation response without a model id is refused', async () => {
  const gateway = new FakeGateway();
  const client = new GatewayModelClient({
    gateway,
    fetcher: async () => ({ ok: true, status: 200, json: async () => ({}) })
  });

  await assert.rejects(
    client.createModel({
      modelName: ROUTE_NAME,
      params: { model: 'openai/gpt-5.6-terra', apiKey: '', apiBase: null },
      marker: {
        profileId: CARD.id,
        apiFormat: 'AMIS_GATEWAY_MANAGED',
        supportsNativeStreaming: true,
        supportsResponsesSsePassthrough: false
      }
    }),
    /without returning its id/
  );
});

test('listing tolerates a malformed route entry instead of failing the connect', async () => {
  const gateway = new FakeGateway();
  const client = new GatewayModelClient({
    gateway,
    fetcher: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ model_name: 'no-info' }, { model_info: { id: 'no-name' } }] })
    })
  });

  assert.deepEqual(await client.listModels(), []);
});

// The store is exercised against real SQLite only where the module exists:
// Electron ships Node 24, while `npm test` may run on an older Node.
const sqliteAvailable = await import('node:sqlite').then(
  () => true,
  () => false
);
const skipWithoutSqlite = sqliteAvailable ? false : 'node:sqlite is unavailable on this runtime';

test('the store round-trips a profile through the shared schema', { skip: skipWithoutSqlite }, async () => {
  const { SqliteModelProfileStore } = await import('../dist/main/models/ModelProfileStore.js');
  const directory = mkdtempSync(path.join(tmpdir(), 'tokiie-profiles-'));
  const store = new SqliteModelProfileStore({ databasePath: path.join(directory, 'amis_wifi.db') });
  try {
    const profile = {
      id: CARD.id,
      name: '',
      provider: 'custom',
      apiUrl: 'https://api.onetokens.net',
      apiKey: '',
      modelName: 'gpt-5.6-terra',
      type: 'cloud',
      supportedApiFormats: ['AMIS_GATEWAY_MANAGED'],
      litellmLinks: [
        { modelID: 'route-uuid-1', apiFormat: 'AMIS_GATEWAY_MANAGED', modelName: ROUTE_NAME }
      ],
      createdAt: 1_787_000_000.5
    };

    assert.equal(await store.find(profile.id), null);
    await store.save(profile);
    assert.deepEqual(await store.find(profile.id), profile);

    // A second save updates the same row rather than colliding on the key.
    await store.save({ ...profile, name: 'renamed' });
    assert.equal((await store.find(profile.id)).name, 'renamed');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the store degrades unreadable columns instead of failing the read', { skip: skipWithoutSqlite }, async () => {
  const { SqliteModelProfileStore } = await import('../dist/main/models/ModelProfileStore.js');
  const { DatabaseSync } = await import('node:sqlite');
  const directory = mkdtempSync(path.join(tmpdir(), 'tokiie-profiles-'));
  const databasePath = path.join(directory, 'amis_wifi.db');
  const store = new SqliteModelProfileStore({ databasePath });
  try {
    await store.save({
      id: 'row',
      name: 'n',
      provider: 'p',
      apiUrl: 'u',
      apiKey: null,
      modelName: 'm',
      type: 'cloud',
      supportedApiFormats: ['openai_chat'],
      litellmLinks: [],
      createdAt: 1
    });
    store.close();

    const raw = new DatabaseSync(databasePath);
    raw
      .prepare(
        `UPDATE model_profiles
            SET type = 'from-a-newer-version',
                supported_api_formats = 'unknown_format',
                litellm_links = 'not json'`
      )
      .run();
    raw.close();

    const reopened = new SqliteModelProfileStore({ databasePath });
    const profile = await reopened.find('row');
    reopened.close();

    assert.equal(profile.type, 'cloud');
    assert.deepEqual(profile.supportedApiFormats, ['openai_chat']);
    assert.deepEqual(profile.litellmLinks, []);
    assert.equal(profile.apiKey, null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
