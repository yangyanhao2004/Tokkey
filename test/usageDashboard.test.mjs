import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

// Exercise the renderer's state owner without a DOM or Electron process.
const { outputFiles } = await build({
  entryPoints: ['src/renderer/hooks/UsageDashboardModel.ts'],
  bundle: true, write: false, format: 'esm', platform: 'node'
});
const { UsageDashboardModel } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
);

class DashboardFixture {
  version = 1;
  queries = [this.query(3), this.query(2), this.query(1)];
  totals = { spendUsd: 1, savedUsd: 2 };
  queryReads = 0;
  totalReads = 0;
  versionReads = 0;
  states = [];
  failTotals = false;
  pendingRead = null;

  constructor(t) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    this.model = new UsageDashboardModel(this, (state) => { this.states = [...this.states, state]; });
    t.after(() => this.model.stop());
  }

  query(id, totalTokens = id) {
    return { id: String(id), sessionId: 'session', turnId: String(id), startedAtEpochMs: id, totalTokens };
  }

  async readUsageDataVersion() {
    this.versionReads += 1;
    return this.version;
  }

  async readUsageCostTotals() {
    this.totalReads += 1;
    if (this.failTotals) throw new Error('Temporary read failure');
    return this.totals;
  }

  async readUsageQueryWindow(cursor) {
    this.queryReads += 1;
    if (this.pendingRead) await this.pendingRead;
    const remaining = this.queries.filter((query) => cursor === null || query.startedAtEpochMs < Number(cursor));
    const queries = remaining.slice(0, 2);
    return { queries, nextCursor: remaining.length > 2 ? queries.at(-1).id : null };
  }

  get state() { return this.states.at(-1); }

  async settle() {
    // Drain the bounded chain of IPC promises without advancing the poll clock.
    for (let index = 0; index < 30; index += 1) await Promise.resolve();
  }

  async tick(t) {
    t.mock.timers.tick(1_000);
    await this.settle();
  }
}

test('polls cheaply while unchanged and refreshes all visible metrics after a write', async (t) => {
  const fixture = new DashboardFixture(t);
  fixture.model.start();
  await fixture.settle();
  assert.equal(fixture.state.isLoading, false);
  await fixture.tick(t);
  assert.equal(fixture.versionReads, 2);
  assert.equal(fixture.queryReads, 1);
  assert.equal(fixture.totalReads, 1);

  fixture.queries = [fixture.query(3, 100), fixture.query(2, 200), fixture.query(1)];
  fixture.totals = { spendUsd: 3, savedUsd: 4 };
  fixture.version += 1;
  await fixture.tick(t);
  assert.deepEqual(fixture.state.queries.map((query) => query.totalTokens), [100, 200]);
  assert.deepEqual(fixture.state.totals, fixture.totals);
});

test('keeps loaded history when new queries arrive and refreshes older rows', async (t) => {
  const fixture = new DashboardFixture(t);
  fixture.model.start();
  await fixture.settle();
  await fixture.model.loadMore();
  fixture.queries = [fixture.query(5), fixture.query(4), fixture.query(3), fixture.query(2), fixture.query(1, 99)];
  fixture.version += 1;
  await fixture.tick(t);
  assert.deepEqual(fixture.state.queries.map((query) => query.id), ['5', '4', '3', '2', '1']);
  assert.equal(fixture.state.queries.at(-1).totalTokens, 99);
  assert.equal(fixture.state.hasMore, false);
});

test('retains last good numbers on failure and retries without another database write', async (t) => {
  t.mock.method(console, 'error', () => {});
  const fixture = new DashboardFixture(t);
  fixture.model.start();
  await fixture.settle();
  fixture.failTotals = true;
  fixture.version += 1;
  await fixture.tick(t);
  assert.ok(fixture.state.error);
  assert.deepEqual(fixture.state.totals, { spendUsd: 1, savedUsd: 2 });
  fixture.failTotals = false;
  fixture.totals = { spendUsd: 10, savedUsd: 20 };
  await fixture.tick(t);
  assert.equal(fixture.state.error, null);
  assert.deepEqual(fixture.state.totals, fixture.totals);
});

test('serializes slow pagination with polling and ignores replies after teardown', async (t) => {
  const fixture = new DashboardFixture(t);
  fixture.model.start();
  await fixture.settle();
  let resolveRead;
  fixture.pendingRead = new Promise((resolve) => { resolveRead = resolve; });
  const loading = fixture.model.loadMore();
  await fixture.model.loadMore();
  await fixture.tick(t);
  assert.equal(fixture.queryReads, 2);
  assert.equal(fixture.versionReads, 1);
  fixture.model.stop();
  const stateCount = fixture.states.length;
  resolveRead();
  await loading;
  await fixture.tick(t);
  assert.equal(fixture.states.length, stateCount);
  assert.equal(fixture.versionReads, 1);
});

test('catches a commit during an in-flight refresh on the next poll', async (t) => {
  const fixture = new DashboardFixture(t);
  let resolveRead;
  fixture.pendingRead = new Promise((resolve) => { resolveRead = resolve; });
  fixture.model.start();
  await fixture.settle();
  fixture.version += 1;
  fixture.totals = { spendUsd: 7, savedUsd: 8 };
  resolveRead();
  await fixture.settle();
  await fixture.tick(t);
  assert.equal(fixture.totalReads, 2);
  assert.deepEqual(fixture.state.totals, fixture.totals);
});

test('waits for a slow query before retrying a failed totals read', async (t) => {
  t.mock.method(console, 'error', () => {});
  const fixture = new DashboardFixture(t);
  let resolveRead;
  fixture.pendingRead = new Promise((resolve) => { resolveRead = resolve; });
  fixture.failTotals = true;
  fixture.model.start();
  await fixture.settle();
  await fixture.tick(t);
  assert.equal(fixture.versionReads, 1);
  resolveRead();
  await fixture.settle();
  assert.ok(fixture.state.error);
  fixture.failTotals = false;
  await fixture.tick(t);
  assert.equal(fixture.state.error, null);
});
