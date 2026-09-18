import assert from 'node:assert/strict';
import test from 'node:test';

import { HubModelConnector } from '../dist/main/models/HubModelConnector.js';
import { LocalModel } from '../dist/main/models/LocalModel.js';
import { LocalModelAgentIntegration } from '../dist/main/models/LocalModelAgentIntegration.js';
import { LocalModelBinding } from '../dist/main/models/LocalModelBinding.js';

const RUNNING_MODEL = {
  deviceId: 'ABCDEF',
  displayName: 'Qwen3 4B',
  modelName: 'qwen3-4b-q4_k_m.gguf',
  endpoint: 'http://127.0.0.1:8080/v1',
  apiKey: ''
};

/** A stand-in for the runtime, driven one phase at a time by the test. */
class FakeRuntime {
  constructor() {
    this.listeners = new Set();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(phase) {
    for (const listener of this.listeners) {
      listener({ phase, modelId: 'qwen3-4b', endpoint: null, error: null, device: null });
    }
  }
}

/** Records what the integration asked of the connector, and can refuse a connect. */
class FakeConnector {
  constructor({ failConnect = false } = {}) {
    this.calls = [];
    this.failConnect = failConnect;
  }

  async connect(model) {
    this.calls.push(`connect:${model.displayName}`);
    if (this.failConnect) throw new Error('the gateway refused the route');
  }

  async disconnect() {
    this.calls.push('disconnect');
  }
}

class FakeCli {
  constructor() {
    this.syncs = 0;
  }

  async sync() {
    this.syncs += 1;
  }

  async syncSettings() {
    this.syncs += 1;
  }
}

function makeIntegration(options = {}) {
  const connector = options.connector ?? new FakeConnector();
  const binding = new LocalModelBinding();
  const codex = new FakeCli();
  const claude = new FakeCli();
  const integration = new LocalModelAgentIntegration({ connector, binding, codex, claude });
  return { integration, connector, binding, codex, claude };
}

test('publishes the model to both CLIs only after its route exists', async () => {
  const { integration, connector, binding, codex, claude } = makeIntegration();

  await integration.connect(RUNNING_MODEL);

  // The route first: a row published ahead of it would 404 on the first turn.
  assert.deepEqual(connector.calls, ['connect:Qwen3 4B']);
  assert.equal(binding.model.slug, LocalModel.DISPLAY_NAME);
  assert.equal(binding.model.displayName, 'Qwen3 4B');
  assert.equal(codex.syncs, 1);
  assert.equal(claude.syncs, 1);
});

test('publishes nothing when the route could not be created', async () => {
  const { integration, binding, codex, claude } = makeIntegration({
    connector: new FakeConnector({ failConnect: true })
  });

  await assert.rejects(() => integration.connect(RUNNING_MODEL), /refused the route/);

  // The throw is the runtime's to report; what matters here is that no picker
  // was told about a model that never got a route.
  assert.equal(binding.isBound, false);
  assert.equal(codex.syncs, 0);
  assert.equal(claude.syncs, 0);
});

test('withdraws the model when the runtime stops serving it', async () => {
  const runtime = new FakeRuntime();
  const { integration, connector, binding, codex, claude } = makeIntegration();
  integration.observe(runtime);
  await integration.connect(RUNNING_MODEL);

  runtime.publish('idle');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(binding.isBound, false);
  assert.deepEqual(connector.calls, ['connect:Qwen3 4B', 'disconnect']);
  assert.equal(codex.syncs, 2);
  assert.equal(claude.syncs, 2);
});

test('a crashed server takes the same path back as a deliberate stop', async () => {
  const runtime = new FakeRuntime();
  const { integration, connector, binding } = makeIntegration();
  integration.observe(runtime);
  await integration.connect(RUNNING_MODEL);

  runtime.publish('failed');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(binding.isBound, false);
  assert.deepEqual(connector.calls, ['connect:Qwen3 4B', 'disconnect']);
});

test('leaves the row alone while the model is still on its way up', async () => {
  const runtime = new FakeRuntime();
  const { integration, connector, binding } = makeIntegration();
  integration.observe(runtime);
  await integration.connect(RUNNING_MODEL);

  // Neither phase means the model went away, so neither may withdraw it.
  runtime.publish('starting');
  runtime.publish('running');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(binding.isBound, true);
  assert.deepEqual(connector.calls, ['connect:Qwen3 4B']);
});

test('a stop with nothing published costs neither CLI a rewrite', async () => {
  const runtime = new FakeRuntime();
  const { integration, connector, codex, claude } = makeIntegration();
  integration.observe(runtime);

  runtime.publish('idle');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(connector.calls, []);
  assert.equal(codex.syncs, 0);
  assert.equal(claude.syncs, 0);
});

test('the connector deletes the route it published under its fixed name', async () => {
  const routes = [
    { modelId: 'm-1', modelName: 'some-cloud-route' },
    { modelId: 'm-2', modelName: LocalModel.DISPLAY_NAME }
  ];
  const deleted = [];
  const connector = new HubModelConnector(
    {
      listModels: async () => routes,
      deleteModel: async (modelId) => deleted.push(modelId)
    },
    { find: async () => null, save: async () => {} }
  );

  await connector.disconnect();

  assert.deepEqual(deleted, ['m-2']);
});

test('the connector treats an already-gone route as nothing to do', async () => {
  const deleted = [];
  const connector = new HubModelConnector(
    {
      listModels: async () => [],
      deleteModel: async (modelId) => deleted.push(modelId)
    },
    { find: async () => null, save: async () => {} }
  );

  // The gateway holds routes in memory, so a restart leaves none to delete.
  await connector.disconnect();

  assert.deepEqual(deleted, []);
});

test('the connector names the route for the model, not the dongle', async () => {
  const created = [];
  const saved = [];
  const connector = new HubModelConnector(
    {
      listModels: async () => [],
      createModel: async (request) => {
        created.push(request);
        return 'm-9';
      }
    },
    { find: async () => null, save: async (profile) => saved.push(profile) }
  );

  await connector.connect(RUNNING_MODEL);

  assert.equal(created[0].modelName, LocalModel.DISPLAY_NAME);
  // The slug names no model, so the label is what tells a caller which is running.
  assert.equal(created[0].marker.displayName, 'Qwen3 4B');
  assert.equal(created[0].params.model, 'openai/qwen3-4b-q4_k_m.gguf');
  assert.equal(created[0].params.apiBase, RUNNING_MODEL.endpoint);
  // The profile stays keyed by device; only the route name changed.
  assert.equal(saved[0].id, 'hub-abcdef');
  assert.deepEqual(saved[0].litellmLinks, [
    { apiFormat: 'openai_responses', modelName: LocalModel.DISPLAY_NAME, modelID: 'm-9' }
  ]);
});
