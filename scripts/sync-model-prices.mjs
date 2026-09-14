/**
 * Regenerates `src/main/usage/modelPriceFallback.ts` from the published price list.
 *
 * The fallback is what Tokkey prices calls with when the network is unreachable and
 * nothing is cached yet, so it is committed rather than fetched at build time: a build
 * that cannot reach GitHub still produces an app that can price a call.
 *
 * Only the four rate fields are kept. The upstream file is ~257 KB of context windows and
 * capability flags that nothing here reads; the trimmed table is ~29 KB.
 *
 * Run:  node scripts/sync-model-prices.mjs
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_URL =
  'https://raw.githubusercontent.com/Wei-Shaw/model-price-repo/main/model_prices_and_context_window.json';

/** The only fields a cost calculation reads. Keep in step with `ModelPriceRates`. */
const RATE_FIELDS = [
  'input_cost_per_token',
  'output_cost_per_token',
  'cache_creation_input_token_cost',
  'cache_read_input_token_cost'
];

const OUTPUT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'main',
  'usage',
  'modelPriceFallback.ts'
);

/** Keeps only models that publish at least one rate, and only the rates themselves. */
function trim(published) {
  const trimmed = {};
  for (const [slug, entry] of Object.entries(published)) {
    // `sample_spec` documents the file's own format and prices nothing.
    if (slug === 'sample_spec' || !entry || typeof entry !== 'object') continue;
    const rates = {};
    for (const field of RATE_FIELDS) {
      if (typeof entry[field] === 'number') rates[field] = entry[field];
    }
    if (Object.keys(rates).length > 0) trimmed[slug] = rates;
  }
  return trimmed;
}

function render(trimmed, fetchedAt) {
  const slugs = Object.keys(trimmed).sort();
  const entries = slugs
    .map((slug) => `  ${JSON.stringify(slug)}: ${JSON.stringify(trimmed[slug])}`)
    .join(',\n');

  return `/**
 * GENERATED FILE - do not edit by hand.
 *
 * Run \`node scripts/sync-model-prices.mjs\` to refresh from
 * ${SOURCE_URL}
 *
 * Snapshot taken ${fetchedAt}, ${slugs.length} priced models.
 *
 * This is the last resort behind the live fetch and its cache, so that a machine that has
 * never been online still prices a call rather than drawing a blank figure.
 */

import type { ModelPriceTable } from './ModelPriceCatalog';

export const FALLBACK_MODEL_PRICES: ModelPriceTable = {
${entries}
};

export default FALLBACK_MODEL_PRICES;
`;
}

const response = await fetch(SOURCE_URL);
if (!response.ok) {
  throw new Error(`Price list fetch failed: HTTP ${response.status} ${response.statusText}`);
}
const trimmed = trim(await response.json());
const count = Object.keys(trimmed).length;
if (count === 0) throw new Error('Price list held no priced models; refusing to write an empty table');

writeFileSync(OUTPUT_PATH, render(trimmed, new Date().toISOString().slice(0, 10)), 'utf8');
console.log(`Wrote ${count} priced models to ${path.relative(process.cwd(), OUTPUT_PATH)}`);
