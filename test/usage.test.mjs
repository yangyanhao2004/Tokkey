import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { USAGE_QUERY_BATCH_SIZE } from '../dist/shared/types.js';

const sqliteAvailable = await import('node:sqlite').then(
  () => true,
  () => false
);
const skipWithoutSqlite = sqliteAvailable ? false : 'node:sqlite is unavailable on this runtime';

/** The router's own schema, copied from the binary that writes it. */
const ROUTER_USAGE_SCHEMA = `
CREATE TABLE usage_queries (
  user_id             TEXT    NOT NULL,
  session_id          TEXT    NOT NULL,
  turn_id             TEXT    NOT NULL,
  query_text          TEXT    NOT NULL,
  started_at          TEXT    NOT NULL,
  started_at_epoch_ms INTEGER NOT NULL,
  mode                TEXT    NOT NULL DEFAULT '',
  local_routes        TEXT    NOT NULL DEFAULT '[]',
  cloud_routes        TEXT    NOT NULL DEFAULT '[]',
  PRIMARY KEY (user_id, session_id, turn_id)
);
CREATE TABLE usage_calls (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               TEXT    NOT NULL,
  session_id            TEXT    NOT NULL,
  turn_id               TEXT    NOT NULL,
  thread_id             TEXT    NOT NULL DEFAULT '',
  step_idx              INTEGER NOT NULL DEFAULT 0,
  role                  TEXT    NOT NULL,
  protocol              TEXT    NOT NULL,
  route                 TEXT    NOT NULL,
  model                 TEXT    NOT NULL,
  started_at            TEXT    NOT NULL,
  started_at_epoch_ms   INTEGER NOT NULL,
  ended_at              TEXT    NOT NULL,
  ended_at_epoch_ms     INTEGER NOT NULL,
  duration_ms           INTEGER NOT NULL,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens      INTEGER NOT NULL DEFAULT 0,
  total_tokens          INTEGER GENERATED ALWAYS AS
                          (input_tokens + output_tokens +
                           cache_creation_tokens + cache_read_tokens) VIRTUAL,
  status                TEXT    NOT NULL,
  error                 TEXT    NOT NULL DEFAULT ''
);`;

const BASE_EPOCH_MS = 1_789_000_000_000;

/** Real `gpt-5.6-terra` rates, so an expected figure can be worked out on paper. */
const TEST_PRICES = {
  'cloud-model': {
    input_cost_per_token: 0.000002,
    output_cost_per_token: 0.000012,
    cache_creation_input_token_cost: 0.0000025,
    cache_read_input_token_cost: 0.0000002
  }
};

/** Money compared to the cent it is drawn at, not to the last float bit. */
function assertUsd(actual, expected, what) {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${what}: expected ${expected}, got ${actual}`
  );
}

/** A temp database and the store reading it, torn down when the test ends. */
async function usageFixture(t, { withSchema = true, prices = TEST_PRICES } = {}) {
  const [{ UsageStatsStore }, { ModelPriceCatalog }, { DatabaseSync }] = await Promise.all([
    import('../dist/main/usage/UsageStatsStore.js'),
    import('../dist/main/usage/ModelPriceCatalog.js'),
    import('node:sqlite')
  ]);
  const directory = mkdtempSync(path.join(tmpdir(), 'tokkey-usage-'));
  const databasePath = path.join(directory, 'tokkey.db');
  const database = new DatabaseSync(databasePath);
  if (withSchema) database.exec(ROUTER_USAGE_SCHEMA);

  // A catalog with its own cache file and a stubbed fetch: tests must never reach the
  // network, and must never read or write the developer's real price cache.
  const priceCatalog = new ModelPriceCatalog({
    cachePath: path.join(directory, 'prices.json'),
    fetchJson: async () => prices
  });
  const store = new UsageStatsStore({ databasePath, priceCatalog });
  t.after(() => {
    store.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { database, store };
}

function insertQuery(
  database,
  {
    userId = 'default',
    sessionId,
    turnId,
    text,
    epochMs,
    mode = 'orchestrate',
    localRoutes = [],
    cloudRoutes = []
  }
) {
  database
    .prepare(
      `INSERT INTO usage_queries
         (user_id, session_id, turn_id, query_text, started_at, started_at_epoch_ms,
          mode, local_routes, cloud_routes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      sessionId,
      turnId,
      text,
      new Date(epochMs).toISOString(),
      epochMs,
      mode,
      JSON.stringify(localRoutes),
      JSON.stringify(cloudRoutes)
    );
}

function insertCall(database, call) {
  const {
    userId = 'default',
    sessionId,
    turnId,
    stepIndex = 0,
    role = 'local',
    model,
    route,
    epochMs,
    inputTokens = 0,
    outputTokens = 0,
    cacheReadTokens = 0,
    status = 'ok'
  } = call;
  database
    .prepare(
      `INSERT INTO usage_calls
         (user_id, session_id, turn_id, step_idx, role, protocol, route, model,
          started_at, started_at_epoch_ms, ended_at, ended_at_epoch_ms, duration_ms,
          input_tokens, output_tokens, cache_read_tokens, status)
       VALUES (?, ?, ?, ?, ?, 'responses', ?, ?, ?, ?, ?, ?, 100, ?, ?, ?, ?)`
    )
    .run(
      userId,
      sessionId,
      turnId,
      stepIndex,
      role,
      // A call's route defaults to its model name, which is how a native
      // passthrough route is actually recorded.
      route ?? model,
      model,
      new Date(epochMs).toISOString(),
      epochMs,
      new Date(epochMs + 100).toISOString(),
      epochMs + 100,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      status
    );
}

/** Two queries, the newer one routed through two models. */
function seedTwoQueries(database) {
  insertQuery(database, {
    sessionId: 'session-a',
    turnId: 'turn-older',
    text: 'Summarize the meeting notes',
    epochMs: BASE_EPOCH_MS
  });
  insertCall(database, {
    sessionId: 'session-a',
    turnId: 'turn-older',
    model: 'qwen-8b',
    epochMs: BASE_EPOCH_MS,
    inputTokens: 100,
    outputTokens: 20
  });

  insertQuery(database, {
    sessionId: 'session-b',
    turnId: 'turn-newer',
    text: 'Draft a launch announcement',
    epochMs: BASE_EPOCH_MS + 60_000
  });
  insertCall(database, {
    sessionId: 'session-b',
    turnId: 'turn-newer',
    stepIndex: 0,
    role: 'planner',
    model: 'planner-model',
    epochMs: BASE_EPOCH_MS + 60_000,
    inputTokens: 500,
    outputTokens: 10
  });
  insertCall(database, {
    sessionId: 'session-b',
    turnId: 'turn-newer',
    stepIndex: 1,
    role: 'local',
    model: 'qwen-35b',
    epochMs: BASE_EPOCH_MS + 61_000,
    inputTokens: 1_000,
    outputTokens: 250,
    cacheReadTokens: 4_000
  });
}

test('reads queries newest first with the calls each was routed through', { skip: skipWithoutSqlite }, async (t) => {
  const { database, store } = await usageFixture(t);
  seedTwoQueries(database);

  const batch = await store.readQueryWindow(null);

  // Two queries fit in one batch, so there is nothing after it.
  assert.equal(batch.nextCursor, null);
  assert.deepEqual(
    batch.queries.map((query) => query.queryText),
    ['Draft a launch announcement', 'Summarize the meeting notes']
  );

  const [newest] = batch.queries;
  assert.equal(newest.id, 'session-b:turn-newer');
  // Steps keep the router's own order: the planning call, then what it planned.
  assert.deepEqual(
    newest.steps.map((step) => step.modelName),
    ['planner-model', 'qwen-35b']
  );
  // Cache reads were fed to the model, so they land in the input figure and
  // the two sides reconcile with the total: 5_500 + 260 = 5_760.
  assert.equal(newest.inputTokens, 500 + 1_000 + 4_000);
  assert.equal(newest.outputTokens, 260);
  assert.equal(newest.totalTokens, 510 + 5_250);
  assert.equal(newest.inputTokens + newest.outputTokens, newest.totalTokens);
});

test('walks the history forward one batch at a time', { skip: skipWithoutSqlite }, async (t) => {
  const { database, store } = await usageFixture(t);
  const queryCount = USAGE_QUERY_BATCH_SIZE + 5;
  for (let index = 0; index < queryCount; index += 1) {
    insertQuery(database, {
      sessionId: 'session-paged',
      turnId: `turn-${index}`,
      text: `Query ${index}`,
      epochMs: BASE_EPOCH_MS + index * 1_000
    });
    insertCall(database, {
      sessionId: 'session-paged',
      turnId: `turn-${index}`,
      model: 'qwen-8b',
      epochMs: BASE_EPOCH_MS + index * 1_000,
      inputTokens: 10,
      outputTokens: 1
    });
  }

  const first = await store.readQueryWindow(null);
  assert.equal(first.queries.length, USAGE_QUERY_BATCH_SIZE);
  assert.equal(first.queries[0].queryText, `Query ${queryCount - 1}`);
  // More history follows, so the batch says where to resume.
  assert.ok(typeof first.nextCursor === 'string');

  const second = await store.readQueryWindow(first.nextCursor);
  assert.equal(second.queries.length, 5);
  assert.equal(second.queries.at(-1).queryText, 'Query 0');
  // The end of the history, so there is nothing to resume from.
  assert.equal(second.nextCursor, null);
  // Every step in the batch is attached, and none from the batch beside it.
  assert.ok(second.queries.every((query) => query.steps.length === 1));

  // The two batches together are the whole history, each query exactly once.
  const walked = [...first.queries, ...second.queries].map((query) => query.queryText);
  assert.equal(new Set(walked).size, queryCount);

  // A cursor this store never issued reads as no cursor at all.
  assert.deepEqual(
    (await store.readQueryWindow('not-a-cursor')).queries.map((query) => query.queryText),
    first.queries.map((query) => query.queryText)
  );
});

test('a query recorded mid-walk never shifts the batch after it', { skip: skipWithoutSqlite }, async (t) => {
  const { database, store } = await usageFixture(t);
  const queryCount = USAGE_QUERY_BATCH_SIZE + 3;
  for (let index = 0; index < queryCount; index += 1) {
    insertQuery(database, {
      sessionId: 'session-live',
      turnId: `turn-${index}`,
      text: `Query ${index}`,
      epochMs: BASE_EPOCH_MS + index * 1_000
    });
  }

  const first = await store.readQueryWindow(null);

  // The router records another query while the list is open. Under OFFSET this
  // would push every later row down one and repeat the last row of the batch.
  insertQuery(database, {
    sessionId: 'session-live',
    turnId: 'turn-newest',
    text: 'Recorded while reading',
    epochMs: BASE_EPOCH_MS + queryCount * 1_000
  });

  const second = await store.readQueryWindow(first.nextCursor);
  const walked = [...first.queries, ...second.queries].map((query) => query.queryText);
  assert.equal(new Set(walked).size, walked.length);
  assert.equal(second.queries.at(-1).queryText, 'Query 0');
  // The newcomer sits ahead of the cursor, so this walk does not see it at all.
  assert.ok(!walked.includes('Recorded while reading'));
});

test('counts cost and queries for the default account only', { skip: skipWithoutSqlite }, async (t) => {
  const { database, store } = await usageFixture(t);
  seedTwoQueries(database);
  insertQuery(database, {
    userId: 'someone-else',
    sessionId: 'session-c',
    turnId: 'turn-other',
    text: 'Another account',
    epochMs: BASE_EPOCH_MS + 120_000
  });
  // Another account's spend, on a model this catalog prices, so it would show up
  // in the total if the account filter ever stopped working.
  insertCall(database, {
    userId: 'someone-else',
    sessionId: 'session-c',
    turnId: 'turn-other',
    model: 'cloud-model',
    epochMs: BASE_EPOCH_MS + 120_000,
    inputTokens: 1_000_000,
    outputTokens: 1_000_000
  });

  const totals = await store.readCostTotals();
  // The seeded queries run on models nothing prices, so the only figure that could
  // appear here is the other account's $14.
  assertUsd(totals.spendUsd, 0, 'spend');
  assertUsd(totals.savedUsd, 0, 'saved');
  assert.equal((await store.readQueryWindow(null)).queries.length, 2);
});

test('a query recorded before its first call keeps its row', { skip: skipWithoutSqlite }, async (t) => {
  const { database, store } = await usageFixture(t);
  insertQuery(database, {
    sessionId: 'session-d',
    turnId: 'turn-pending',
    text: 'Just asked',
    epochMs: BASE_EPOCH_MS
  });

  const [query] = (await store.readQueryWindow(null)).queries;
  assert.equal(query.steps.length, 0);
  assert.equal(query.totalTokens, 0);
});

test('reports no usage when the router has never recorded any', { skip: skipWithoutSqlite }, async (t) => {
  const { store } = await usageFixture(t, { withSchema: false });

  assert.deepEqual((await store.readQueryWindow(null)).queries, []);
  assert.equal((await store.readQueryWindow(null)).nextCursor, null);
  assert.deepEqual(await store.readCostTotals(), { spendUsd: 0, savedUsd: 0 });
});

test('detects committed WAL inserts, updates, and deletes from the router connection', { skip: skipWithoutSqlite }, async (t) => {
  const { database, store } = await usageFixture(t);
  database.exec('PRAGMA journal_mode = WAL');
  const initialVersion = store.readDataVersion();
  assert.equal(store.readDataVersion(), initialVersion);

  database.exec('BEGIN');
  seedTwoQueries(database);
  // Uncommitted writes must not trigger a display of data another reader cannot see.
  assert.equal(store.readDataVersion(), initialVersion);
  assert.equal((await store.readQueryWindow(null)).queries.length, 0);
  database.exec('COMMIT');
  const insertedVersion = store.readDataVersion();
  assert.notEqual(insertedVersion, initialVersion);
  assert.equal((await store.readQueryWindow(null)).queries.length, 2);

  database.exec('UPDATE usage_calls SET output_tokens = output_tokens + 100');
  const updatedVersion = store.readDataVersion();
  assert.notEqual(updatedVersion, insertedVersion);
  const [query] = (await store.readQueryWindow(null)).queries;
  assert.ok(query.steps.every((step) => step.outputTokens >= 100));

  database.exec('DELETE FROM usage_calls');
  assert.notEqual(store.readDataVersion(), updatedVersion);
  assert.equal((await store.readQueryWindow(null)).queries[0].totalTokens, 0);
});

test('discovers usage tables created after the dashboard has opened', { skip: skipWithoutSqlite }, async (t) => {
  const { database, store } = await usageFixture(t, { withSchema: false });
  assert.equal(store.readDataVersion(), null);
  assert.deepEqual((await store.readQueryWindow(null)).queries, []);

  database.exec(ROUTER_USAGE_SCHEMA);
  seedTwoQueries(database);

  assert.equal(typeof store.readDataVersion(), 'number');
  assert.equal((await store.readQueryWindow(null)).queries.length, 2);
});

test('reports no usage when the database file does not exist yet', { skip: skipWithoutSqlite }, async (t) => {
  const { UsageStatsStore } = await import('../dist/main/usage/UsageStatsStore.js');
  const directory = mkdtempSync(path.join(tmpdir(), 'tokkey-usage-missing-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new UsageStatsStore({ databasePath: path.join(directory, 'absent.db') });

  assert.equal((await store.readQueryWindow(null)).queries.length, 0);
  assert.equal((await store.readCostTotals()).spendUsd, 0);
});

test('prices a cloud call as spend and a local call as saving', { skip: skipWithoutSqlite }, async (t) => {
  const { database, store } = await usageFixture(t);
  insertQuery(database, {
    sessionId: 'session-priced',
    turnId: 'turn-priced',
    text: 'What does this cost?',
    epochMs: BASE_EPOCH_MS,
    localRoutes: ['local-route'],
    cloudRoutes: ['cloud-route']
  });
  insertCall(database, {
    sessionId: 'session-priced',
    turnId: 'turn-priced',
    stepIndex: 0,
    role: 'cloud',
    route: 'cloud-route',
    model: 'cloud-model',
    epochMs: BASE_EPOCH_MS,
    inputTokens: 2_000,
    outputTokens: 200
  });
  insertCall(database, {
    sessionId: 'session-priced',
    turnId: 'turn-priced',
    stepIndex: 1,
    role: 'local',
    route: 'local-route',
    model: 'local-model',
    epochMs: BASE_EPOCH_MS + 1_000,
    inputTokens: 1_000,
    outputTokens: 100,
    cacheReadTokens: 500
  });

  const [query] = (await store.readQueryWindow(null)).queries;
  const [cloudStep, localStep] = query.steps;

  // 2_000 * 2e-6 + 200 * 1.2e-5
  assertUsd(cloudStep.spendUsd, 0.0064, 'cloud spend');
  assertUsd(cloudStep.savedUsd, 0, 'cloud saved');

  // The same tokens repriced at the cloud model's rates, bucket by bucket:
  // 1_000 * 2e-6 + 100 * 1.2e-5 + 500 * 2e-7. Flattening 1_600 tokens onto the
  // input rate would give 0.0032, which is why the split is kept.
  assertUsd(localStep.spendUsd, 0, 'local spend');
  assertUsd(localStep.savedUsd, 0.0033, 'local saved');

  // The query reports its steps added up.
  assertUsd(query.spendUsd, 0.0064, 'query spend');
  assertUsd(query.savedUsd, 0.0033, 'query saved');

  const totals = await store.readCostTotals();
  assertUsd(totals.spendUsd, 0.0064, 'totals spend');
  assertUsd(totals.savedUsd, 0.0033, 'totals saved');
});

test('claims no saving when the query named no cloud route', { skip: skipWithoutSqlite }, async (t) => {
  const { database, store } = await usageFixture(t);
  insertQuery(database, {
    sessionId: 'session-offline',
    turnId: 'turn-offline',
    text: 'Answered entirely on this Mac',
    epochMs: BASE_EPOCH_MS,
    localRoutes: ['local-route'],
    cloudRoutes: []
  });
  insertCall(database, {
    sessionId: 'session-offline',
    turnId: 'turn-offline',
    role: 'local',
    route: 'local-route',
    model: 'local-model',
    epochMs: BASE_EPOCH_MS,
    inputTokens: 5_000,
    outputTokens: 500
  });

  const [query] = (await store.readQueryWindow(null)).queries;
  // Nothing to compare against, so nothing is claimed rather than a model invented.
  assertUsd(query.spendUsd, 0, 'spend');
  assertUsd(query.savedUsd, 0, 'saved');
});

test('a proxied call bills, and an unpriced model reports zero', { skip: skipWithoutSqlite }, async (t) => {
  const { database, store } = await usageFixture(t);
  insertQuery(database, {
    sessionId: 'session-proxy',
    turnId: 'turn-proxy',
    text: 'Passed straight through',
    epochMs: BASE_EPOCH_MS,
    mode: 'proxy',
    localRoutes: [],
    cloudRoutes: []
  });
  // A passthrough route appears in neither list, so it is billed, not credited.
  insertCall(database, {
    sessionId: 'session-proxy',
    turnId: 'turn-proxy',
    stepIndex: 0,
    role: 'proxy',
    model: 'cloud-model',
    epochMs: BASE_EPOCH_MS,
    inputTokens: 1_000,
    outputTokens: 0
  });
  // Nothing prices this model; the row must read zero, never NaN.
  insertCall(database, {
    sessionId: 'session-proxy',
    turnId: 'turn-proxy',
    stepIndex: 1,
    role: 'proxy',
    model: 'model-nobody-prices',
    epochMs: BASE_EPOCH_MS + 1_000,
    inputTokens: 9_999,
    outputTokens: 9_999
  });

  const [query] = (await store.readQueryWindow(null)).queries;
  const [billed, unpriced] = query.steps;

  assertUsd(billed.spendUsd, 0.002, 'proxied spend');
  assertUsd(billed.savedUsd, 0, 'proxied saved');
  assert.equal(unpriced.spendUsd, 0);
  assert.equal(unpriced.savedUsd, 0);
  assert.ok(Number.isFinite(query.spendUsd));
});
