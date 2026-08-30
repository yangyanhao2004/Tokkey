import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexNativeModelCatalog } from '../dist/main/models/CodexNativeModelCatalog.js';
import { CodexNativeModelRegistrar } from '../dist/main/models/CodexNativeModelRegistrar.js';
import { CodexProviderConfig } from '../dist/main/models/CodexProviderConfig.js';
import { GatewayModelClient } from '../dist/main/gateway/GatewayModelClient.js';

const CODEX_VERSION = 'codex-cli 0.151.0';

/** One entry shaped like the bundled catalog's, including the fields we drop. */
function catalogEntry(slug, overrides = {}) {
  return {
    slug,
    display_name: slug.toUpperCase(),
    description: `${slug} description`,
    context_window: 400000,
    supported_in_api: true,
    visibility: 'list',
    // The real catalog embeds these; they are ~40KB per model and never used.
    base_instructions: 'x'.repeat(1000),
    model_messages: { instructions_template: 'y'.repeat(1000) },
    ...overrides
  };
}

function catalogJson(entries) {
  return JSON.stringify({ models: entries });
}

/** A shell runner that answers the two commands the catalog issues. */
class FakeShellRunner {
  constructor({ version = CODEX_VERSION, catalog = null, failing = false } = {}) {
    this.version = version;
    this.catalog = catalog;
    this.failing = failing;
    this.commands = [];
  }

  async run(command) {
    this.commands.push(command);
    if (this.failing) {
      return { exitCode: 127, timedOut: false, output: ['zsh: command not found: codex'] };
    }
    if (command.includes('--version')) {
      return { exitCode: 0, timedOut: false, output: [this.version] };
    }
    return { exitCode: 0, timedOut: false, output: this.catalog ?? [] };
  }
}

function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'tokiie-codex-'));
  return home;
}

test('keeps only listed models and drops the instruction blobs', async () => {
  const home = makeHome();
  const runner = new FakeShellRunner({
    catalog: [
      catalogJson([
        catalogEntry('gpt-5.6-sol'),
        catalogEntry('gpt-5.5'),
        catalogEntry('gpt-5.4', { visibility: 'hide' }),
        catalogEntry('codex-auto-review', { visibility: 'hide' })
      ])
    ]
  });

  const models = await new CodexNativeModelCatalog({ runner, homeDirectory: home }).list();

  assert.deepEqual(
    models.map((model) => model.slug),
    ['gpt-5.6-sol', 'gpt-5.5']
  );
  assert.equal(models[0].displayName, 'GPT-5.6-SOL');
  assert.equal(models[0].contextWindow, 400000);
  // The projection is the point: the cache must not carry the prompt templates.
  const cached = readFileSync(path.join(home, '.amiswifi', 'codex-native-models.json'), 'utf8');
  assert.ok(!cached.includes('instructions_template'));
  assert.ok(cached.length < 2000);
  rmSync(home, { recursive: true, force: true });
});

test('reuses the cache when the installed codex version is unchanged', async () => {
  const home = makeHome();
  mkdirSync(path.join(home, '.amiswifi'), { recursive: true });
  writeFileSync(
    path.join(home, '.amiswifi', 'codex-native-models.json'),
    JSON.stringify({
      codexVersion: CODEX_VERSION,
      models: [{ slug: 'gpt-5.5', displayName: 'GPT-5.5', description: '', contextWindow: null, supportedInApi: true }]
    })
  );
  const runner = new FakeShellRunner({ catalog: [catalogJson([catalogEntry('gpt-5.6-sol')])] });

  const models = await new CodexNativeModelCatalog({ runner, homeDirectory: home }).list();

  assert.deepEqual(models.map((model) => model.slug), ['gpt-5.5']);
  // Only the version probe ran; the expensive catalog call was skipped.
  assert.deepEqual(runner.commands, ['codex --version']);
  rmSync(home, { recursive: true, force: true });
});

test('refreshes the cache when codex has been upgraded', async () => {
  const home = makeHome();
  mkdirSync(path.join(home, '.amiswifi'), { recursive: true });
  writeFileSync(
    path.join(home, '.amiswifi', 'codex-native-models.json'),
    JSON.stringify({ codexVersion: 'codex-cli 0.1.0', models: [] })
  );
  const runner = new FakeShellRunner({ catalog: [catalogJson([catalogEntry('gpt-5.5')])] });

  const models = await new CodexNativeModelCatalog({ runner, homeDirectory: home }).list();

  assert.deepEqual(models.map((model) => model.slug), ['gpt-5.5']);
  rmSync(home, { recursive: true, force: true });
});

test('falls back to the cached list when codex cannot be run', async () => {
  const home = makeHome();
  mkdirSync(path.join(home, '.amiswifi'), { recursive: true });
  writeFileSync(
    path.join(home, '.amiswifi', 'codex-native-models.json'),
    JSON.stringify({
      codexVersion: CODEX_VERSION,
      models: [{ slug: 'gpt-5.5', displayName: 'GPT-5.5', description: '', contextWindow: null, supportedInApi: true }]
    })
  );
  const runner = new FakeShellRunner({ failing: true });

  const models = await new CodexNativeModelCatalog({ runner, homeDirectory: home }).list();

  assert.deepEqual(models.map((model) => model.slug), ['gpt-5.5']);
  rmSync(home, { recursive: true, force: true });
});

test('returns nothing rather than throwing when codex is absent and nothing is cached', async () => {
  const home = makeHome();

  const models = await new CodexNativeModelCatalog({
    runner: new FakeShellRunner({ failing: true }),
    homeDirectory: home
  }).list();

  assert.deepEqual(models, []);
  rmSync(home, { recursive: true, force: true });
});

test('survives a debug command whose output shape changed', async () => {
  const home = makeHome();
  const runner = new FakeShellRunner({
    catalog: ['not json at all', JSON.stringify({ unexpected: 'shape' })]
  });

  const models = await new CodexNativeModelCatalog({ runner, homeDirectory: home }).list();

  assert.deepEqual(models, []);
  rmSync(home, { recursive: true, force: true });
});

test('finds the catalog even when the shell writes a warning first', async () => {
  const home = makeHome();
  const runner = new FakeShellRunner({
    catalog: ['zsh: some rc-file warning', catalogJson([catalogEntry('gpt-5.5')])]
  });

  const models = await new CodexNativeModelCatalog({ runner, homeDirectory: home }).list();

  assert.deepEqual(models.map((model) => model.slug), ['gpt-5.5']);
  rmSync(home, { recursive: true, force: true });
});

test('runs the codex CLI once however many callers ask for the list', async () => {
  const home = makeHome();
  const runner = new FakeShellRunner({ catalog: [catalogJson([catalogEntry('gpt-5.5')])] });
  const catalog = new CodexNativeModelCatalog({ runner, homeDirectory: home });

  await Promise.all([catalog.list(), catalog.list(), catalog.list()]);

  assert.deepEqual(runner.commands, ['codex --version', 'codex debug models --bundled']);
  rmSync(home, { recursive: true, force: true });
});

/** Writes one `config.toml` and returns the reader pointed at it. */
function providerConfigFor(toml) {
  const home = makeHome();
  const filePath = path.join(home, 'config.toml');
  writeFileSync(filePath, toml);
  return { config: new CodexProviderConfig({ filePath }), home };
}

test('reads the base url of the provider codex is configured to use', async () => {
  const { config, home } = providerConfigFor(
    [
      '#model_provider = "commented-out"',
      'model_provider = "OpenAI"',
      '[model_providers.OpenAI]',
      'base_url = "https://api.onetokens.net"',
      '[model_providers.other]',
      'base_url = "https://elsewhere.example/v1"'
    ].join('\n')
  );

  assert.equal(await config.baseUrl(), 'https://api.onetokens.net');
  rmSync(home, { recursive: true, force: true });
});

test('falls back to codex own default provider when none is named', async () => {
  const { config, home } = providerConfigFor(
    ['[model_providers.openai]', 'base_url = "https://api.openai.com/v1"'].join('\n')
  );

  assert.equal(await config.baseUrl(), 'https://api.openai.com/v1');
  rmSync(home, { recursive: true, force: true });
});

test('reports no endpoint when the configured provider defines no base url', async () => {
  const { config, home } = providerConfigFor(
    ['model_provider = "OpenAI"', '[model_providers.OpenAI]', 'name = "OpenAI"'].join('\n')
  );

  assert.equal(await config.baseUrl(), null);
  rmSync(home, { recursive: true, force: true });
});

test('reports no endpoint when config.toml is missing, empty, or malformed', async () => {
  const home = makeHome();
  const absent = new CodexProviderConfig({ filePath: path.join(home, 'nothing-here.toml') });
  const { config: empty } = providerConfigFor('');
  const { config: malformed } = providerConfigFor('model_provider = [unterminated');

  assert.equal(await absent.baseUrl(), null);
  assert.equal(await empty.baseUrl(), null);
  assert.equal(await malformed.baseUrl(), null);
  rmSync(home, { recursive: true, force: true });
});

/** A catalog stub so registrar tests do not touch the shell or the disk. */
class StubCatalog {
  constructor(models) {
    this.models = models;
  }

  async list() {
    return this.models;
  }
}

/** Records the management calls the registrar makes against the gateway. */
function recordingGateway({ existing = [], failOn = null } = {}) {
  const created = [];
  const fetcher = async (url, init) => {
    if (url.endsWith('/model/info')) {
      return new Response(
        JSON.stringify({ data: existing.map((name) => ({ model_name: name, model_info: { id: name } })) }),
        { status: 200 }
      );
    }
    const body = JSON.parse(init.body);
    if (failOn === body.model_name) {
      return new Response(JSON.stringify({ detail: 'nope' }), { status: 400 });
    }
    created.push(body);
    return new Response(JSON.stringify({ model_id: `id-${body.model_name}` }), { status: 200 });
  };
  const client = new GatewayModelClient({
    gateway: { startIfNeeded: async () => {}, baseUrl: () => 'http://127.0.0.1:4000' },
    fetcher
  });
  return { client, created };
}

const MODEL = {
  slug: 'gpt-5.5',
  displayName: 'GPT-5.5',
  description: '',
  contextWindow: 400000,
  supportedInApi: true
};

/** A `config.toml` stand-in, so registrar tests never read the real one. */
class StubProviderConfig {
  constructor(url = null) {
    this.url = url;
  }

  async baseUrl() {
    return this.url;
  }
}

test('registers a native route with the codex endpoint, no key, and the native marker', async () => {
  const { client, created } = recordingGateway();

  const registered = await new CodexNativeModelRegistrar({
    catalog: new StubCatalog([MODEL]),
    providerConfig: new StubProviderConfig('https://api.onetokens.net'),
    client
  }).registerAll();

  assert.deepEqual(registered.map((model) => model.slug), ['gpt-5.5']);
  assert.equal(created.length, 1);
  assert.equal(created[0].model_name, 'gpt-5.5');
  assert.equal(created[0].litellm_params.model, 'openai/gpt-5.5');
  assert.equal(created[0].litellm_params.api_key, '');
  assert.equal(created[0].litellm_params.api_base, 'https://api.onetokens.net');
  assert.equal(created[0].model_info.upstream, 'codex_native');
  assert.equal(created[0].model_info.supports_responses_sse_passthrough, true);
  // Nothing persists these, so there is no profile to point at.
  assert.ok(!('profile_id' in created[0].model_info));
});

test('leaves the endpoint unset when codex configures none', async () => {
  const { client, created } = recordingGateway();

  await new CodexNativeModelRegistrar({
    catalog: new StubCatalog([MODEL]),
    providerConfig: new StubProviderConfig(),
    client
  }).registerAll();

  assert.equal(created[0].litellm_params.api_base, null);
});

test('adopts a route that already exists instead of recreating it', async () => {
  const { client, created } = recordingGateway({ existing: ['gpt-5.5'] });

  const registered = await new CodexNativeModelRegistrar({
    catalog: new StubCatalog([MODEL]),
    providerConfig: new StubProviderConfig(),
    client
  }).registerAll();

  assert.deepEqual(registered.map((model) => model.slug), ['gpt-5.5']);
  assert.deepEqual(created, []);
});

test('one rejected model does not cost the others their routes', async () => {
  const { client, created } = recordingGateway({ failOn: 'gpt-5.5' });
  const other = { ...MODEL, slug: 'gpt-5.2' };

  const registered = await new CodexNativeModelRegistrar({
    catalog: new StubCatalog([MODEL, other]),
    providerConfig: new StubProviderConfig(),
    client
  }).registerAll();

  assert.deepEqual(registered.map((model) => model.slug), ['gpt-5.2']);
  assert.deepEqual(created.map((body) => body.model_name), ['gpt-5.2']);
});

test('does not touch the gateway when no codex models were discovered', async () => {
  let called = false;
  const client = new GatewayModelClient({
    gateway: {
      startIfNeeded: async () => {
        called = true;
      },
      baseUrl: () => 'http://127.0.0.1:4000'
    },
    fetcher: async () => new Response('{}', { status: 200 })
  });

  const registered = await new CodexNativeModelRegistrar({
    catalog: new StubCatalog([]),
    providerConfig: new StubProviderConfig(),
    client
  }).registerAll();

  assert.deepEqual(registered, []);
  assert.equal(called, false);
});
