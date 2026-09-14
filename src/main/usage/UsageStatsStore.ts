import { existsSync } from 'node:fs';
import os from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { tokkeyDatabasePath } from '../storage/TokkeyDatabase';
import {
  USAGE_QUERY_BATCH_SIZE,
  type UsageQueryRecord,
  type UsageQueryStep,
  type UsageQueryWindow,
  type UsageTokenTotals
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

const EMPTY_TOTALS: UsageTokenTotals = {
  totalTokens: 0,
  prefillTokens: 0,
  decodeTokens: 0
};

export interface UsageStatsStoreOptions {
  homeDirectory?: string;
  databasePath?: string;
  openDatabase?: (databasePath: string) => DatabaseSync;
  /** Overridden only by tests that record traffic under another account. */
  userId?: string;
}

/** One row of `usage_queries`, before its calls are attached. */
interface QueryRow {
  session_id: string;
  turn_id: string;
  query_text: string;
  started_at: string;
  started_at_epoch_ms: number;
}

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
  model: string;
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

  private database: DatabaseSync | null = null;
  /** Null until the first connection attempt decides whether there is one. */
  private hasUsageTables: boolean | null = null;

  constructor(options: UsageStatsStoreOptions = {}) {
    const homeDirectory = options.homeDirectory ?? os.homedir();
    this.databasePath = options.databasePath ?? tokkeyDatabasePath(homeDirectory);
    this.openDatabase = options.openDatabase ?? UsageStatsStore.openSqliteDatabase;
    this.userId = options.userId ?? DEFAULT_USAGE_USER_ID;
  }

  /** Releases the SQLite handle for test cleanup or an explicit caller teardown. */
  close(): void {
    this.database?.close();
    this.database = null;
    this.hasUsageTables = null;
  }

  /**
   * One batch of queries, newest first, each carrying the calls it was routed
   * through. Pass null for the newest batch, then the previous result's
   * `nextCursor` for each batch after it.
   */
  readQueryWindow(cursor: string | null): UsageQueryWindow {
    const database = this.connect();
    if (!database) return EMPTY_WINDOW;

    // One row more than the batch answers "is there another batch?" without a
    // second query and without counting the whole table.
    const fetched = this.readQueryRows(database, UsageStatsStore.decodeCursor(cursor));
    const hasMore = fetched.length > USAGE_QUERY_BATCH_SIZE;
    const queryRows = hasMore ? fetched.slice(0, USAGE_QUERY_BATCH_SIZE) : fetched;
    const stepsByQuery = this.readStepsFor(database, queryRows);
    const lastRow = queryRows[queryRows.length - 1];

    return {
      queries: queryRows.map((row) => this.toQueryRecord(row, stepsByQuery)),
      nextCursor: hasMore && lastRow ? UsageStatsStore.encodeCursor(lastRow) : null
    };
  }

  /**
   * Every token this machine has put through the router, which is what the
   * "Local AI usage" card counts. Prefill is everything fed to the models,
   * cache reads and writes included, and decode is what they generated, so the
   * two add up to the total.
   */
  readTokenTotals(): UsageTokenTotals {
    const database = this.connect();
    if (!database) return EMPTY_TOTALS;

    const row = database
      .prepare(
        `SELECT COALESCE(SUM(input_tokens + cache_creation_tokens + cache_read_tokens), 0) AS prefill_tokens,
                COALESCE(SUM(output_tokens), 0) AS decode_tokens,
                COALESCE(SUM(total_tokens), 0)  AS total_tokens
           FROM usage_calls
          WHERE user_id = ?`
      )
      .get(this.userId) as Record<string, unknown> | undefined;

    return {
      totalTokens: UsageStatsStore.numberValue(row, 'total_tokens'),
      prefillTokens: UsageStatsStore.numberValue(row, 'prefill_tokens'),
      decodeTokens: UsageStatsStore.numberValue(row, 'decode_tokens')
    };
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
    const selection = `SELECT session_id, turn_id, query_text, started_at, started_at_epoch_ms
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
   * The calls behind the queries on screen, keyed by query. This is the join,
   * and it is restricted to the page's own turns: `idx_usage_calls_by_turn`
   * leads with `turn_id`, so the twenty lookups stay indexed however much
   * history sits behind them.
   */
  private readStepsFor(
    database: DatabaseSync,
    queryRows: readonly QueryRow[]
  ): Map<string, UsageQueryStep[]> {
    const stepsByQuery = new Map<string, UsageQueryStep[]>();
    if (queryRows.length === 0) return stepsByQuery;

    const placeholders = queryRows.map(() => '?').join(', ');
    const callRows = database
      .prepare(
        `SELECT session_id, turn_id, step_idx, role, model,
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

    callRows.forEach((call) => {
      // Turn ids are unique in practice, but a query is identified by session
      // and turn together, so the grouping key is too.
      const key = UsageStatsStore.queryKey(call.session_id, call.turn_id);
      const steps = stepsByQuery.get(key) ?? [];
      steps.push({
        modelName: call.model,
        role: call.role,
        stepIndex: call.step_idx,
        // Cache tokens were fed to the model like any other input, so they
        // count as input here. `total_tokens` is generated as input + output +
        // both cache columns, so this is what makes Input + Output = Tokens.
        inputTokens:
          call.input_tokens + call.cache_creation_tokens + call.cache_read_tokens,
        outputTokens: call.output_tokens,
        totalTokens: call.total_tokens,
        isComplete: call.status === 'ok'
      });
      stepsByQuery.set(key, steps);
    });

    return stepsByQuery;
  }

  /** Folds a query and its calls into the one record the renderer draws. */
  private toQueryRecord(row: QueryRow, stepsByQuery: Map<string, UsageQueryStep[]>): UsageQueryRecord {
    const id = UsageStatsStore.queryKey(row.session_id, row.turn_id);
    // A query recorded before its first call finished has no steps yet, which
    // reads as a query that cost nothing rather than as a missing row.
    const steps = stepsByQuery.get(id) ?? [];

    return {
      id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      queryText: row.query_text,
      startedAt: row.started_at,
      startedAtEpochMs: row.started_at_epoch_ms,
      steps,
      inputTokens: UsageStatsStore.sumOf(steps, 'inputTokens'),
      outputTokens: UsageStatsStore.sumOf(steps, 'outputTokens'),
      totalTokens: UsageStatsStore.sumOf(steps, 'totalTokens')
    };
  }

  /**
   * Opens the database, or reports that there is nothing to read. The tables
   * arrive with the router's first recorded call, so their absence is checked
   * once per connection rather than assumed either way.
   */
  private connect(): DatabaseSync | null {
    if (this.database) return this.hasUsageTables ? this.database : null;
    if (!existsSync(this.databasePath)) return null;

    try {
      const database = this.openDatabase(this.databasePath);
      this.database = database;
      this.hasUsageTables = REQUIRED_TABLES.every((table) =>
        UsageStatsStore.tableExists(database, table)
      );
      return this.hasUsageTables ? database : null;
    } catch (error) {
      console.error('[Usage] Could not open the usage database:', error);
      return null;
    }
  }

  private static tableExists(database: DatabaseSync, tableName: string): boolean {
    const row = database
      .prepare(`SELECT COUNT(*) AS found FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(tableName) as Record<string, unknown> | undefined;
    return UsageStatsStore.numberValue(row, 'found') > 0;
  }

  /** The one spelling of a query's identity, shared by its row and its calls. */
  private static queryKey(sessionId: string, turnId: string): string {
    return `${sessionId}:${turnId}`;
  }

  private static sumOf(
    steps: readonly UsageQueryStep[],
    field: 'inputTokens' | 'outputTokens' | 'totalTokens'
  ): number {
    return steps.reduce((running, step) => running + step[field], 0);
  }

  private static toQueryRow(row: Record<string, unknown>): QueryRow {
    return {
      session_id: UsageStatsStore.textValue(row, 'session_id'),
      turn_id: UsageStatsStore.textValue(row, 'turn_id'),
      query_text: UsageStatsStore.textValue(row, 'query_text'),
      started_at: UsageStatsStore.textValue(row, 'started_at'),
      started_at_epoch_ms: UsageStatsStore.numberValue(row, 'started_at_epoch_ms')
    };
  }

  private static toCallRow(row: Record<string, unknown>): CallRow {
    return {
      session_id: UsageStatsStore.textValue(row, 'session_id'),
      turn_id: UsageStatsStore.textValue(row, 'turn_id'),
      step_idx: UsageStatsStore.numberValue(row, 'step_idx'),
      role: UsageStatsStore.textValue(row, 'role'),
      model: UsageStatsStore.textValue(row, 'model'),
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
