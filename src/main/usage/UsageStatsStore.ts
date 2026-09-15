import { existsSync } from 'node:fs';
import os from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { tokkeyDatabasePath } from '../storage/TokkeyDatabase';
import CallCostCalculator, { type CallCost, type CallTokenCounts } from './CallCostCalculator';
import ModelPriceCatalog from './ModelPriceCatalog';
import {
  USAGE_QUERY_BATCH_SIZE,
  type UsageQueryRecord,
  type UsageQueryStep,
  type UsageQueryWindow,
  type UsageCostTotals
} from '../../shared/types';

/**
 * The account the router records traffic under. It writes one user today, so
 * the dashboard reads that one rather than inventing a selector for it.
 */
export const DEFAULT_USAGE_USER_ID = 'default';

/** Both usage tables belong to the router; the dashboard only ever reads them. */
const REQUIRED_TABLES = ['usage_queries', 'usage_calls'] as const;

/** An empty batch, which is what a machine whose router never ran reports. */
const EMPTY_WINDOW: UsageQueryWindow = { queries: [], nextCursor: null };

const EMPTY_TOTALS: UsageCostTotals = { spendUsd: 0, savedUsd: 0 };

/** The profile table naming each gateway route, read only to price a route by model. */
const MODEL_PROFILES_TABLE = 'model_profiles';

export interface UsageStatsStoreOptions {
  homeDirectory?: string;
  databasePath?: string;
  openDatabase?: (databasePath: string) => DatabaseSync;
  /** Overridden only by tests that record traffic under another account. */
  userId?: string;
  /** Overridden by tests, which must price calls without reaching the network. */
  priceCatalog?: ModelPriceCatalog;
}

/** One row of `usage_queries`, before its calls are attached. */
interface QueryRow {
  session_id: string;
  turn_id: string;
  query_text: string;
  started_at: string;
  started_at_epoch_ms: number;
  /** How the router served this query: `orchestrate` or `proxy`. */
  mode: string;
  /** The gateway routes this query treated as local, and as cloud. */
  local_routes: string[];
  cloud_routes: string[];
}

/**
 * One query's calls, with the moment the last of them finished - which is what
 * says how long the query took, and is not derivable from the steps themselves.
 */
interface QueryTimeline {
  steps: UsageQueryStep[];
  /** The latest recorded end among the calls, or 0 while none has finished. */
  lastEndedAtEpochMs: number;
}

/** What a query whose calls have not been recorded yet reads as. */
const EMPTY_TIMELINE: QueryTimeline = { steps: [], lastEndedAtEpochMs: 0 };

/** Where one batch resumes: the ordering key of the last row already drawn. */
interface QueryCursor {
  startedAtEpochMs: number;
  sessionId: string;
  turnId: string;
}

/** One row of `usage_calls`, keyed back to the query that produced it. */
interface CallRow {
  session_id: string;
  turn_id: string;
  step_idx: number;
  role: string;
  /** The gateway route, which is what the query's two route lists name. */
  route: string;
  model: string;
  /** When the call finished, which is what a query's duration is measured to. */
  ended_at_epoch_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  status: string;
}

/**
 * The Dashboard page's read side: what the router recorded in Tokkey's SQLite
 * database, as `usage_queries` (one row per question asked) and `usage_calls`
 * (one row per model call made answering it).
 *
 * Both tables are owned by the router binary, so nothing here creates or
 * migrates them - a database without them is reported as no usage yet rather
 * than as an error, which is the honest reading on a machine whose router has
 * never run.
 *
 * Queries are read a batch at a time and only that batch is joined to its
 * calls. A machine that has been routing for months holds far more history than
 * a list can draw, and joining the two tables whole to show twenty rows would
 * make the page slower every day it is used.
 *
 * Batches are cut with a keyset cursor rather than LIMIT/OFFSET. Two reasons:
 * OFFSET still walks every row it skips, so reading deep into a long history
 * costs more the further it goes; and history grows at the newest end, so a
 * query recorded between two reads would shift every later row by one and show
 * one of them twice.
 */
export class UsageStatsStore {
  private readonly databasePath: string;
  private readonly openDatabase: (databasePath: string) => DatabaseSync;
  private readonly userId: string;
  private readonly priceCatalog: ModelPriceCatalog;

  private database: DatabaseSync | null = null;
  /** Null until the first connection attempt decides whether there is one. */
  private hasUsageTables: boolean | null = null;

  constructor(options: UsageStatsStoreOptions = {}) {
    const homeDirectory = options.homeDirectory ?? os.homedir();
    this.databasePath = options.databasePath ?? tokkeyDatabasePath(homeDirectory);
    this.openDatabase = options.openDatabase ?? UsageStatsStore.openSqliteDatabase;
    this.userId = options.userId ?? DEFAULT_USAGE_USER_ID;
    this.priceCatalog = options.priceCatalog ?? new ModelPriceCatalog({ homeDirectory });
  }

  /** Releases the SQLite handle for test cleanup or an explicit caller teardown. */
  close(): void {
    this.database?.close();
    this.database = null;
    this.hasUsageTables = null;
  }

  /**
   * Detects committed writes from the router's separate connection, including WAL
   * commits. Compare values only on this persistent connection, never across stores.
   */
  readDataVersion(): number | null {
    const database = this.connect();
    if (!database) return null;
    const row = database.prepare('PRAGMA data_version').get();
    return UsageStatsStore.numberValue(row, 'data_version');
  }

  /**
   * One batch of queries, newest first, each carrying the calls it was routed
   * through. Pass null for the newest batch, then the previous result's
   * `nextCursor` for each batch after it.
   */
  async readQueryWindow(cursor: string | null): Promise<UsageQueryWindow> {
    const database = this.connect();
    if (!database) return EMPTY_WINDOW;

    // Resolved once before the batch is priced; the catalog holds it thereafter.
    await this.priceCatalog.load();

    // One row more than the batch answers "is there another batch?" without a
    // second query and without counting the whole table.
    const fetched = this.readQueryRows(database, UsageStatsStore.decodeCursor(cursor));
    const hasMore = fetched.length > USAGE_QUERY_BATCH_SIZE;
    const queryRows = hasMore ? fetched.slice(0, USAGE_QUERY_BATCH_SIZE) : fetched;
    const timelines = this.readTimelinesFor(database, queryRows);
    const lastRow = queryRows[queryRows.length - 1];

    return {
      queries: queryRows.map((row) => this.toQueryRecord(row, timelines)),
      nextCursor: hasMore && lastRow ? UsageStatsStore.encodeCursor(lastRow) : null
    };
  }

  /**
   * What every recorded call came to, which is what the Router card reports.
   *
   * Tokens are counted per call for the listing, but not totalled here: the card
   * that shows token figures describes this machine's own models, and the router's
   * tables count its cloud calls alongside them.
   */
  async readCostTotals(): Promise<UsageCostTotals> {
    const database = this.connect();
    if (!database) return EMPTY_TOTALS;

    await this.priceCatalog.load();

    // Rates are per model, so money cannot be one SUM over the whole table. Tokens are
    // folded per (route, model, route-lists) group instead - a handful of rows however
    // long the history - and each group is priced once.
    const groups = database
      .prepare(
        `SELECT c.route, c.model, q.local_routes, q.cloud_routes,
                COALESCE(SUM(c.input_tokens), 0)          AS input_tokens,
                COALESCE(SUM(c.output_tokens), 0)         AS output_tokens,
                COALESCE(SUM(c.cache_creation_tokens), 0) AS cache_creation_tokens,
                COALESCE(SUM(c.cache_read_tokens), 0)     AS cache_read_tokens
           FROM usage_calls c
           LEFT JOIN usage_queries q
             ON  q.user_id    = c.user_id
             AND q.session_id = c.session_id
             AND q.turn_id    = c.turn_id
          WHERE c.user_id = ?
          GROUP BY c.route, c.model, q.local_routes, q.cloud_routes`
      )
      .all(this.userId)
      .map((row) => row as Record<string, unknown>);

    // The groups themselves say which model answered each route, so a stand-in can be
    // named without the profile table - which belongs to the app, not the router, and
    // may not be there at all. Profiles fill in a route no call has used yet.
    const routeModels = this.readRouteModels(database);
    for (const group of groups) {
      const route = UsageStatsStore.textValue(group, 'route');
      const model = UsageStatsStore.textValue(group, 'model');
      if (route && model) routeModels.set(route, model);
    }

    const totals = { spendUsd: 0, savedUsd: 0 };

    for (const group of groups) {
      const cost = this.priceCall(UsageStatsStore.tokenCounts(group), {
        route: UsageStatsStore.textValue(group, 'route'),
        model: UsageStatsStore.textValue(group, 'model'),
        localRoutes: UsageStatsStore.jsonStringArray(group, 'local_routes'),
        cloudModel: UsageStatsStore.firstCloudModel(
          UsageStatsStore.jsonStringArray(group, 'cloud_routes'),
          routeModels,
          null
        )
      });

      totals.spendUsd += cost.spendUsd;
      totals.savedUsd += cost.savedUsd;
    }

    return totals;
  }

  /**
   * Prices one call, or one group of calls sharing a model and a query's route lists.
   *
   * A call is local when its route is one the query listed as local; everything else
   * billed, which is what makes a `proxy` query - whose route appears in neither list -
   * count as the upstream spend it is.
   */
  private priceCall(
    tokens: CallTokenCounts,
    context: {
      route: string;
      model: string;
      localRoutes: readonly string[];
      cloudModel: string | null;
    }
  ): CallCost {
    if (context.localRoutes.includes(context.route)) {
      // Served on this machine: nothing was spent, and what a cloud model would have
      // charged for these same tokens is what that avoided.
      return CallCostCalculator.localCall(
        tokens,
        context.cloudModel ? this.priceCatalog.ratesFor(context.cloudModel) : null
      );
    }

    const rates = this.priceCatalog.ratesFor(context.model);
    // An unpriced model reports nothing rather than zero dollars, which would read as
    // a call that was free.
    return rates ? CallCostCalculator.cloudCall(tokens, rates) : CallCostCalculator.unpriced();
  }

  /**
   * The batch itself, read from `usage_queries` alone, one row longer than the
   * batch so the caller can tell whether more history follows.
   *
   * Session and turn break ties so two queries recorded in the same millisecond
   * keep a stable order instead of swapping and hiding one of themselves. The
   * cursor compares against the same three columns as a row value, which is
   * exactly the ordering key, so "everything after this row" is one comparison.
   */
  private readQueryRows(database: DatabaseSync, cursor: QueryCursor | null): QueryRow[] {
    const limit = USAGE_QUERY_BATCH_SIZE + 1;
    const selection = `SELECT session_id, turn_id, query_text, started_at, started_at_epoch_ms,
                  mode, local_routes, cloud_routes
           FROM usage_queries
          WHERE user_id = ?`;
    const ordering = `ORDER BY started_at_epoch_ms DESC, session_id DESC, turn_id DESC
          LIMIT ?`;

    const rows = cursor
      ? database
          .prepare(
            `${selection}
            AND (started_at_epoch_ms, session_id, turn_id) < (?, ?, ?)
          ${ordering}`
          )
          .all(this.userId, cursor.startedAtEpochMs, cursor.sessionId, cursor.turnId, limit)
      : database.prepare(`${selection} ${ordering}`).all(this.userId, limit);

    return rows.map((row) => UsageStatsStore.toQueryRow(row as Record<string, unknown>));
  }

  /**
   * The cursor is opaque to every caller, so it is encoded rather than handed
   * over as three readable fields: nothing outside this class should be able to
   * build one, and the ordering key can change without changing the contract.
   */
  private static encodeCursor(row: QueryRow): string {
    const cursor: QueryCursor = {
      startedAtEpochMs: row.started_at_epoch_ms,
      sessionId: row.session_id,
      turnId: row.turn_id
    };
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  /**
   * A cursor this store did not issue reads as no cursor at all. The list has
   * to draw something, and the newest batch is the honest answer to a request
   * that names no position.
   */
  private static decodeCursor(cursor: string | null): QueryCursor | null {
    if (!cursor) return null;
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object') return null;
      const { startedAtEpochMs, sessionId, turnId } = parsed as Record<string, unknown>;
      if (typeof startedAtEpochMs !== 'number' || !Number.isFinite(startedAtEpochMs)) return null;
      if (typeof sessionId !== 'string' || typeof turnId !== 'string') return null;
      return { startedAtEpochMs, sessionId, turnId };
    } catch {
      return null;
    }
  }

  /**
   * The calls behind the queries on screen, and when each query's last call
   * ended, keyed by query. This is the join,
   * and it is restricted to the page's own turns: `idx_usage_calls_by_turn`
   * leads with `turn_id`, so the twenty lookups stay indexed however much
   * history sits behind them.
   */
  private readTimelinesFor(
    database: DatabaseSync,
    queryRows: readonly QueryRow[]
  ): Map<string, QueryTimeline> {
    const timelines = new Map<string, QueryTimeline>();
    if (queryRows.length === 0) return timelines;

    const queriesByKey = new Map(
      queryRows.map((row) => [UsageStatsStore.queryKey(row.session_id, row.turn_id), row])
    );

    const placeholders = queryRows.map(() => '?').join(', ');
    const callRows = database
      .prepare(
        `SELECT session_id, turn_id, step_idx, role, route, model, ended_at_epoch_ms,
                input_tokens, output_tokens,
                cache_creation_tokens, cache_read_tokens,
                total_tokens, status
           FROM usage_calls
          WHERE user_id = ?
            AND turn_id IN (${placeholders})
          ORDER BY step_idx ASC, started_at_epoch_ms ASC, id ASC`
      )
      .all(this.userId, ...queryRows.map((row) => row.turn_id))
      .map((row) => UsageStatsStore.toCallRow(row as Record<string, unknown>));

    // Grouped before pricing, so a query's own calls can supply the model behind its
    // first cloud route without a second read.
    const callsByQuery = new Map<string, CallRow[]>();
    callRows.forEach((call) => {
      // Turn ids are unique in practice, but a query is identified by session
      // and turn together, so the grouping key is too.
      const key = UsageStatsStore.queryKey(call.session_id, call.turn_id);
      callsByQuery.set(key, [...(callsByQuery.get(key) ?? []), call]);
    });

    const routeModels = this.readRouteModels(database);

    callsByQuery.forEach((calls, key) => {
      const query = queriesByKey.get(key);
      const cloudModel = UsageStatsStore.firstCloudModel(
        query?.cloud_routes ?? [],
        routeModels,
        calls
      );

      const steps = calls.map((call) => {
        const tokens = UsageStatsStore.callTokenCounts(call);
        const cost = this.priceCall(tokens, {
          route: call.route,
          model: call.model,
          localRoutes: query?.local_routes ?? [],
          cloudModel
        });

        return {
          modelName: call.model,
          role: call.role,
          stepIndex: call.step_idx,
          // Cache tokens were fed to the model like any other input, so they
          // count as input here. `total_tokens` is generated as input + output +
          // both cache columns, so this is what makes Input + Output = Tokens.
          inputTokens: tokens.inputTokens + tokens.cacheCreationTokens + tokens.cacheReadTokens,
          outputTokens: tokens.outputTokens,
          totalTokens: call.total_tokens,
          spendUsd: cost.spendUsd,
          savedUsd: cost.savedUsd,
          isComplete: call.status === 'ok'
        };
      });

      // Calls are ordered by step, not by when they ended, and a step can
      // outlast the one after it - so the last end is the largest, not the last.
      timelines.set(key, {
        steps,
        lastEndedAtEpochMs: calls.reduce((latest, call) => Math.max(latest, call.ended_at_epoch_ms), 0)
      });
    });

    return timelines;
  }

  /** Folds a query and its calls into the one record the renderer draws. */
  private toQueryRecord(row: QueryRow, timelines: Map<string, QueryTimeline>): UsageQueryRecord {
    const id = UsageStatsStore.queryKey(row.session_id, row.turn_id);
    // A query recorded before its first call finished has no steps yet, which
    // reads as a query that cost nothing rather than as a missing row.
    const { steps, lastEndedAtEpochMs } = timelines.get(id) ?? EMPTY_TIMELINE;

    return {
      id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      queryText: row.query_text,
      startedAt: row.started_at,
      startedAtEpochMs: row.started_at_epoch_ms,
      durationMs: UsageStatsStore.queryDuration(row.started_at_epoch_ms, lastEndedAtEpochMs),
      steps,
      inputTokens: UsageStatsStore.sumOf(steps, 'inputTokens'),
      outputTokens: UsageStatsStore.sumOf(steps, 'outputTokens'),
      totalTokens: UsageStatsStore.sumOf(steps, 'totalTokens'),
      spendUsd: UsageStatsStore.sumOf(steps, 'spendUsd'),
      savedUsd: UsageStatsStore.sumOf(steps, 'savedUsd')
    };
  }

  /**
   * Opens the database, or reports that there is nothing to read. The tables
   * arrive with the router's first recorded call, so a missing schema is retried
   * on later reads even when the app already opened the database.
   */
  private connect(): DatabaseSync | null {
    if (this.database && this.hasUsageTables) return this.database;
    if (!existsSync(this.databasePath)) return null;

    try {
      const database = this.database ?? this.openDatabase(this.databasePath);
      this.database = database;
      this.hasUsageTables = REQUIRED_TABLES.every((table) =>
        UsageStatsStore.tableExists(database, table)
      );
      return this.hasUsageTables ? database : null;
    } catch (error) {
      console.error('[Usage] Could not open the usage database:', error);
      throw error;
    }
  }

  private static tableExists(database: DatabaseSync, tableName: string): boolean {
    const row = database
      .prepare(`SELECT COUNT(*) AS found FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(tableName) as Record<string, unknown> | undefined;
    return UsageStatsStore.numberValue(row, 'found') > 0;
  }

  /**
   * How long a query took: from when it was asked to when the last of its calls
   * finished.
   *
   * A query whose calls are all still running has no end recorded, and a clock
   * corrected between the two writes can put the end before the start. Neither is
   * a length of time, so both report nothing rather than zero - which would read
   * as a query answered instantly.
   */
  private static queryDuration(startedAtEpochMs: number, lastEndedAtEpochMs: number): number | null {
    if (lastEndedAtEpochMs <= 0 || lastEndedAtEpochMs < startedAtEpochMs) return null;
    return lastEndedAtEpochMs - startedAtEpochMs;
  }

  /** The one spelling of a query's identity, shared by its row and its calls. */
  private static queryKey(sessionId: string, turnId: string): string {
    return `${sessionId}:${turnId}`;
  }

  private static sumOf(
    steps: readonly UsageQueryStep[],
    field: 'inputTokens' | 'outputTokens' | 'totalTokens' | 'spendUsd' | 'savedUsd'
  ): number {
    return steps.reduce((running, step) => running + step[field], 0);
  }

  /**
   * Which model stands in for a local call's cost.
   *
   * The query names its cloud tier by route, but a price is keyed by model, so the route
   * has to be resolved to one. A call in the same query that used that route already
   * says which model answered it; otherwise the profile that owns the route does.
   */
  private static firstCloudModel(
    cloudRoutes: readonly string[],
    routeModels: ReadonlyMap<string, string>,
    calls: readonly CallRow[] | null
  ): string | null {
    const route = cloudRoutes[0];
    if (!route) return null;
    const served = calls?.find((call) => call.route === route);
    return served?.model ?? routeModels.get(route) ?? null;
  }

  /**
   * Every gateway route a saved profile owns, mapped to the model it fronts.
   *
   * `model_profiles` belongs to the app rather than the router, so its absence is an
   * ordinary state - a route simply goes unresolved and nothing is claimed as saved.
   */
  private readRouteModels(database: DatabaseSync): Map<string, string> {
    const routeModels = new Map<string, string>();
    if (!UsageStatsStore.tableExists(database, MODEL_PROFILES_TABLE)) return routeModels;

    try {
      const rows = database
        .prepare(`SELECT model_name, litellm_links FROM ${MODEL_PROFILES_TABLE}`)
        .all() as Record<string, unknown>[];

      for (const row of rows) {
        const modelName = UsageStatsStore.textValue(row, 'model_name');
        if (!modelName) continue;
        const links = JSON.parse(UsageStatsStore.textValue(row, 'litellm_links') || '[]') as unknown;
        if (!Array.isArray(links)) continue;
        for (const link of links) {
          const routeName = (link as Record<string, unknown>)?.modelName;
          if (typeof routeName === 'string' && routeName) routeModels.set(routeName, modelName);
        }
      }
    } catch (error) {
      // Malformed profile JSON costs a stand-in model, not the whole listing.
      console.error('[Usage] Could not read model profiles for pricing:', error);
    }

    return routeModels;
  }

  /** The four token buckets a cost is computed from, for one call. */
  private static callTokenCounts(call: CallRow): CallTokenCounts {
    return {
      inputTokens: call.input_tokens,
      outputTokens: call.output_tokens,
      cacheCreationTokens: call.cache_creation_tokens,
      cacheReadTokens: call.cache_read_tokens
    };
  }

  /** The same four buckets, read from an aggregate row instead of a call. */
  private static tokenCounts(row: Record<string, unknown>): CallTokenCounts {
    return {
      inputTokens: UsageStatsStore.numberValue(row, 'input_tokens'),
      outputTokens: UsageStatsStore.numberValue(row, 'output_tokens'),
      cacheCreationTokens: UsageStatsStore.numberValue(row, 'cache_creation_tokens'),
      cacheReadTokens: UsageStatsStore.numberValue(row, 'cache_read_tokens')
    };
  }

  /** A route list, which the router stores as a JSON array of route names. */
  private static jsonStringArray(row: Record<string, unknown>, column: string): string[] {
    try {
      const parsed = JSON.parse(UsageStatsStore.textValue(row, column) || '[]') as unknown;
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      // A column written before the router added these lists, or written badly.
      return [];
    }
  }

  private static toQueryRow(row: Record<string, unknown>): QueryRow {
    return {
      session_id: UsageStatsStore.textValue(row, 'session_id'),
      turn_id: UsageStatsStore.textValue(row, 'turn_id'),
      query_text: UsageStatsStore.textValue(row, 'query_text'),
      started_at: UsageStatsStore.textValue(row, 'started_at'),
      started_at_epoch_ms: UsageStatsStore.numberValue(row, 'started_at_epoch_ms'),
      mode: UsageStatsStore.textValue(row, 'mode'),
      local_routes: UsageStatsStore.jsonStringArray(row, 'local_routes'),
      cloud_routes: UsageStatsStore.jsonStringArray(row, 'cloud_routes')
    };
  }

  private static toCallRow(row: Record<string, unknown>): CallRow {
    return {
      session_id: UsageStatsStore.textValue(row, 'session_id'),
      turn_id: UsageStatsStore.textValue(row, 'turn_id'),
      step_idx: UsageStatsStore.numberValue(row, 'step_idx'),
      role: UsageStatsStore.textValue(row, 'role'),
      route: UsageStatsStore.textValue(row, 'route'),
      model: UsageStatsStore.textValue(row, 'model'),
      ended_at_epoch_ms: UsageStatsStore.numberValue(row, 'ended_at_epoch_ms'),
      input_tokens: UsageStatsStore.numberValue(row, 'input_tokens'),
      output_tokens: UsageStatsStore.numberValue(row, 'output_tokens'),
      cache_creation_tokens: UsageStatsStore.numberValue(row, 'cache_creation_tokens'),
      cache_read_tokens: UsageStatsStore.numberValue(row, 'cache_read_tokens'),
      total_tokens: UsageStatsStore.numberValue(row, 'total_tokens'),
      status: UsageStatsStore.textValue(row, 'status')
    };
  }

  /** SQLite hands integers back as `number` or `bigint` depending on width. */
  private static numberValue(row: Record<string, unknown> | undefined, column: string): number {
    const value = row?.[column];
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    return 0;
  }

  private static textValue(row: Record<string, unknown> | undefined, column: string): string {
    const value = row?.[column];
    return typeof value === 'string' ? value : '';
  }

  private static openSqliteDatabase(databasePath: string): DatabaseSync {
    const sqlite = require('node:sqlite') as typeof import('node:sqlite');
    return new sqlite.DatabaseSync(databasePath);
  }
}

export default UsageStatsStore;
