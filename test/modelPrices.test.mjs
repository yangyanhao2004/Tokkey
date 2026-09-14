import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ModelPriceCatalog } from '../dist/main/usage/ModelPriceCatalog.js';
import { FALLBACK_MODEL_PRICES } from '../dist/main/usage/modelPriceFallback.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** What the published file looks like: rates buried among fields nothing here reads. */
const PUBLISHED = {
  sample_spec: { input_cost_per_token: 999 },
  'fetched-model': {
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000004,
    max_input_tokens: 200000,
    supports_vision: true
  }
};

/** A temp directory for the cache file, removed when the test ends. */
function cachePath(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'tokkey-prices-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'prices.json');
}

test('keeps only rate fields, and drops the format sample', async (t) => {
  const catalog = new ModelPriceCatalog({
    cachePath: cachePath(t),
    fetchJson: async () => PUBLISHED
  });

  await catalog.load();

  assert.deepEqual(catalog.ratesFor('fetched-model'), {
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000004
  });
  // `sample_spec` documents the file's own shape and must never price a call.
  assert.equal(catalog.ratesFor('sample_spec'), null);
  assert.equal(catalog.ratesFor('never-heard-of-it'), null);
});

test('falls back to the bundled table when the fetch fails and nothing is cached', async (t) => {
  const catalog = new ModelPriceCatalog({
    cachePath: cachePath(t),
    fetchJson: async () => {
      throw new Error('offline');
    }
  });

  await catalog.load();

  // A machine that has never been online still prices a call it routes.
  assert.ok(catalog.ratesFor('claude-opus-5'));
  assert.deepEqual(catalog.ratesFor('claude-opus-5'), FALLBACK_MODEL_PRICES['claude-opus-5']);
});

test('prefers a fresh cache over the network, and refreshes a stale one', async (t) => {
  const file = cachePath(t);
  const now = 1_789_000_000_000;
  let fetches = 0;
  const fetchJson = async () => {
    fetches += 1;
    return PUBLISHED;
  };

  writeFileSync(
    file,
    JSON.stringify({
      fetchedAtEpochMs: now - 1_000,
      prices: { 'cached-model': { input_cost_per_token: 0.5 } }
    })
  );

  const fresh = new ModelPriceCatalog({ cachePath: file, fetchJson, now: () => now });
  await fresh.load();
  assert.deepEqual(fresh.ratesFor('cached-model'), { input_cost_per_token: 0.5 });
  assert.equal(fetches, 0, 'a cache under a week old should not be refetched');

  // The same cache read a week later is too old to trust on its own.
  const stale = new ModelPriceCatalog({
    cachePath: file,
    fetchJson,
    now: () => now + WEEK_MS + 1
  });
  await stale.load();
  assert.equal(fetches, 1);
  assert.ok(stale.ratesFor('fetched-model'), 'the refreshed table should be in use');
});

test('a stale cache still prices calls when the refresh fails', async (t) => {
  const file = cachePath(t);
  const now = 1_789_000_000_000;
  writeFileSync(
    file,
    JSON.stringify({
      fetchedAtEpochMs: now - WEEK_MS - 1,
      prices: { 'cached-model': { input_cost_per_token: 0.5 } }
    })
  );

  const catalog = new ModelPriceCatalog({
    cachePath: file,
    now: () => now,
    fetchJson: async () => {
      throw new Error('offline');
    }
  });
  await catalog.load();

  // An old rate prices a call far better than no rate at all.
  assert.deepEqual(catalog.ratesFor('cached-model'), { input_cost_per_token: 0.5 });
});

test('a file that parsed but priced nothing is not accepted', async (t) => {
  const catalog = new ModelPriceCatalog({
    cachePath: cachePath(t),
    fetchJson: async () => ({ 'model-with-no-rates': { max_input_tokens: 1000 } })
  });

  await catalog.load();

  // Rather than an empty table, the bundled one stands in.
  assert.ok(catalog.ratesFor('claude-opus-5'));
});
