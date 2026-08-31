import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeNativeModelCatalog } from '../dist/main/models/ClaudeNativeModelCatalog.js';
import { ClaudeNativeModelRegistrar } from '../dist/main/models/ClaudeNativeModelRegistrar.js';
import { GatewayModelClient } from '../dist/main/gateway/GatewayModelClient.js';

/** A gateway that is always up at one address. */
const GATEWAY = {
  async startIfNeeded() {},
  baseUrl() {
    return 'http://127.0.0.1:4000';
  }
};

/** Records every management call and answers with the routes it holds. */
function recordingFetch(existingNames = []) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/model/info')) {
      return new Response(
        JSON.stringify({
          data: existingNames.map((name, index) => ({
            model_name: name,
            model_info: { id: `existing-${index}` }
          }))
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ model_id: 'new-id' }), { status: 200 });
  };
  return { calls, fetcher };
}

function registrar(fetcher, models) {
  return new ClaudeNativeModelRegistrar({
    catalog: new ClaudeNativeModelCatalog(models ? { models } : {}),
    client: new GatewayModelClient({ gateway: GATEWAY, fetcher })
  });
}

test('registers every catalog model as a keyless anthropic route', async () => {
  const { calls, fetcher } = recordingFetch();

  const registered = await registrar(fetcher, [
    { slug: 'claude-opus-5', displayName: 'Claude Opus 5' }
  ]).registerAll();

  assert.deepEqual(
    registered.map((model) => model.slug),
    ['claude-opus-5']
  );
  const created = calls.find((call) => call.url.endsWith('/model/new'));
  assert.equal(created.body.model_name, 'claude-opus-5');
  assert.equal(created.body.litellm_params.model, 'anthropic/claude-opus-5');
  // The two omissions the OAuth relay depends on: a stored key would outrank the
  // caller's subscription token, and an endpoint would send it somewhere that
  // does not accept it.
  assert.equal(created.body.litellm_params.api_key, '');
  assert.equal(created.body.litellm_params.api_base, null);
  assert.equal(created.body.model_info.display_name, 'Claude Opus 5');
  assert.equal(created.body.model_info.api_format, 'anthropic');
  assert.equal(created.body.model_info.supports_native_streaming, false);
  // Claude routes never claim the per-request upstream switch Codex routes use.
  assert.equal(created.body.model_info.upstream, undefined);
});

test('treats an already-registered model as routable without recreating it', async () => {
  const { calls, fetcher } = recordingFetch(['claude-opus-5']);

  const registered = await registrar(fetcher, [
    { slug: 'claude-opus-5', displayName: 'Claude Opus 5' }
  ]).registerAll();

  assert.deepEqual(
    registered.map((model) => model.slug),
    ['claude-opus-5']
  );
  assert.equal(
    calls.some((call) => call.url.endsWith('/model/new')),
    false
  );
});

test('one rejected route does not cost the others', async () => {
  const fetcher = async (url, init) => {
    if (url.endsWith('/model/info')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    const body = JSON.parse(init.body);
    if (body.model_name === 'claude-sonnet-5') {
      return new Response(JSON.stringify({ detail: 'rejected' }), { status: 400 });
    }
    return new Response(JSON.stringify({ model_id: 'new-id' }), { status: 200 });
  };

  const registered = await registrar(fetcher, [
    { slug: 'claude-opus-5', displayName: 'Claude Opus 5' },
    { slug: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' },
    { slug: 'claude-fable-5', displayName: 'Fable 5' }
  ]).registerAll();

  assert.deepEqual(
    registered.map((model) => model.slug),
    ['claude-opus-5', 'claude-fable-5']
  );
});

test('the shipped catalog carries the verified Anthropic model ids', () => {
  const slugs = new ClaudeNativeModelCatalog().list().map((model) => model.slug);

  // Every id here was confirmed against api.anthropic.com; a typo would surface
  // to the user only as "there's an issue with the selected model".
  assert.deepEqual(slugs, [
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-fable-5'
  ]);
  assert.equal(new Set(slugs).size, slugs.length);
});
