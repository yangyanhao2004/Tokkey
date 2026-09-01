import { chmodSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { tokiieDatabasePath } from '../storage/TokiieDatabase';
import {
  epochMillisecondsFromStoredTimestamp,
  isLocalStorageTimestamp,
  localTimestampForEpochMilliseconds,
  type LocalStorageTimestamp
} from '../storage/LocalTimestamp';
import type {
  LocalChatEvent,
  LocalChatMessageRole,
  LocalChatMessageStatus,
  LocalChatStoredMessage,
  LocalChatStoredSession,
  LocalChatTokenUsage,
  LocalChatTurnRequest,
  LocalChatTurnStatus,
  LocalChatWorkspace
} from '../../shared/types';
import {
  createLocalChatSessionTitle,
  DEFAULT_LOCAL_CHAT_SESSION_TITLE
} from '../../shared/LocalChatSessionTitle';

const WATCHDOG_ERROR_MESSAGE = 'The local model stopped responding before completing this reply.';
const INTERRUPTED_ERROR_MESSAGE = 'This response was interrupted before completion.';

const CHAT_SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS "chat_sessions" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "title" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "created_at_epoch_ms" INTEGER NOT NULL DEFAULT 0,
  "created_at_time_zone" TEXT NOT NULL DEFAULT '',
  "updated_at" TEXT NOT NULL,
  "updated_at_epoch_ms" INTEGER NOT NULL DEFAULT 0,
  "updated_at_time_zone" TEXT NOT NULL DEFAULT '',
  "model_id" TEXT,
  "model_label" TEXT,
  "closed" INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "chat_messages" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "session_id" TEXT NOT NULL REFERENCES "chat_sessions"("id"),
  "turn_id" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "reasoning_content" TEXT NOT NULL DEFAULT '',
  "created_at" TEXT NOT NULL,
  "created_at_epoch_ms" INTEGER NOT NULL DEFAULT 0,
  "created_at_time_zone" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL,
  "duration_ms" INTEGER,
  "input_tokens" INTEGER,
  "output_tokens" INTEGER,
  "context_window_tokens" INTEGER
);

CREATE TABLE IF NOT EXISTS "chat_turns" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "session_id" TEXT NOT NULL REFERENCES "chat_sessions"("id"),
  "user_message_id" TEXT NOT NULL,
  "assistant_message_id" TEXT NOT NULL,
  "model_id" TEXT NOT NULL,
  "model_label" TEXT NOT NULL,
  "started_at" TEXT NOT NULL,
  "started_at_epoch_ms" INTEGER NOT NULL DEFAULT 0,
  "started_at_time_zone" TEXT NOT NULL DEFAULT '',
  "ended_at" TEXT,
  "ended_at_epoch_ms" INTEGER,
  "ended_at_time_zone" TEXT,
  "status" TEXT NOT NULL,
  "input_tokens" INTEGER,
  "output_tokens" INTEGER,
  "context_window_tokens" INTEGER
);

CREATE TABLE IF NOT EXISTS "chat_open_sessions" (
  "session_id" TEXT PRIMARY KEY NOT NULL REFERENCES "chat_sessions"("id"),
  "tab_order" INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "chat_workspace_state" (
  "id" INTEGER PRIMARY KEY NOT NULL CHECK ("id" = 1),
  "active_session_id" TEXT REFERENCES "chat_sessions"("id"),
  "updated_at" TEXT NOT NULL,
  "updated_at_epoch_ms" INTEGER NOT NULL DEFAULT 0,
  "updated_at_time_zone" TEXT NOT NULL DEFAULT ''
);`;

const CHAT_TIMESTAMP_INDEXES = `
CREATE INDEX IF NOT EXISTS "idx_chat_messages_session" ON "chat_messages" ("session_id", "created_at_epoch_ms");
CREATE INDEX IF NOT EXISTS "idx_chat_turns_session" ON "chat_turns" ("session_id", "started_at_epoch_ms");
CREATE INDEX IF NOT EXISTS "idx_chat_sessions_updated" ON "chat_sessions" ("updated_at_epoch_ms");`;

interface ActivePersistedTurn {
  request: LocalChatTurnRequest;
  modelLabel: string;
  contextWindowTokens: number | null;
  text: string;
  reasoningContent: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

interface StoredTurnStart {
  request: LocalChatTurnRequest;
  modelLabel: string;
  contextWindowTokens: number | null;
}

interface TimestampBackfillTable {
  tableName: string;
  columns: readonly string[];
  nullableColumns?: readonly string[];
}

export interface ChatSessionStoreOptions {
  homeDirectory?: string;
  databasePath?: string;
  openDatabase?: (databasePath: string) => DatabaseSync;
  now?: () => number;
  createId?: () => string;
}

/**
 * Durable local Chat workspace backed by Tokiie's SQLite database. Business
 * timestamps retain the operating system's local datetime and timezone, while
 * paired epoch columns keep sorting and duration calculations unambiguous.
 */
export class ChatSessionStore {
  private readonly databasePath: string;
  private readonly openDatabase: (databasePath: string) => DatabaseSync;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly activeTurns = new Map<string, ActivePersistedTurn>();
  private database: DatabaseSync | null = null;
  private recoveredInterruptedTurns = false;

  constructor(options: ChatSessionStoreOptions = {}) {
    const homeDirectory = options.homeDirectory ?? os.homedir();
    this.databasePath = options.databasePath ?? tokiieDatabasePath(homeDirectory);
    this.openDatabase = options.openDatabase ?? ChatSessionStore.openSqliteDatabase;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  /** Releases the SQLite handle for test cleanup or an explicit caller teardown. */
  close(): void {
    this.database?.close();
    this.database = null;
  }

  /** Restores all history and guarantees that the workspace has one open tab. */
  loadWorkspace(): LocalChatWorkspace {
    this.connect();
    this.recoverInterruptedTurnsOnce();
    return this.transaction(() => {
      this.ensureWorkspace();
      return this.readWorkspace();
    });
  }

  /** Creates a blank session, opens it as the final tab, and focuses it. */
  createSession(): LocalChatWorkspace {
    this.connect();
    this.recoverInterruptedTurnsOnce();
    return this.transaction(() => {
      const sessionId = this.insertBlankSession();
      this.openSessionTab(sessionId);
      this.setActiveSession(sessionId);
      return this.readWorkspace();
    });
  }

  /** Reopens a historical session when necessary and makes it the current tab. */
  openSession(sessionId: string): LocalChatWorkspace {
    this.connect();
    this.recoverInterruptedTurnsOnce();
    return this.transaction(() => {
      if (!this.sessionExists(sessionId)) {
        throw new Error('Chat session was not found.');
      }
      this.databaseOrThrow()
        .prepare('UPDATE "chat_sessions" SET closed = 0 WHERE id = ?')
        .run(sessionId);
      this.openSessionTab(sessionId);
      this.setActiveSession(sessionId);
      return this.readWorkspace();
    });
  }

  /** Closes a visible tab while keeping the session in local history. */
  closeSession(sessionId: string): LocalChatWorkspace {
    this.connect();
    this.recoverInterruptedTurnsOnce();
    return this.transaction(() => {
      if (!this.sessionExists(sessionId)) {
        throw new Error('Chat session was not found.');
      }
      const database = this.databaseOrThrow();
      database.prepare('DELETE FROM "chat_open_sessions" WHERE session_id = ?').run(sessionId);
      database.prepare('UPDATE "chat_sessions" SET closed = 1 WHERE id = ?').run(sessionId);

      let openSessionIds = this.readOpenSessionIds();
      if (openSessionIds.length === 0) {
        const replacementId = this.insertBlankSession();
        this.openSessionTab(replacementId);
        openSessionIds = [replacementId];
      }

      const activeSessionId = this.readActiveSessionId();
      const nextActiveSessionId = activeSessionId === sessionId || !openSessionIds.includes(activeSessionId ?? '')
        ? openSessionIds[openSessionIds.length - 1]
        : activeSessionId;
      this.setActiveSession(nextActiveSessionId ?? openSessionIds[openSessionIds.length - 1]);
      return this.readWorkspace();
    });
  }

  /** Persists the user/assistant pair and its streaming turn before inference begins. */
  beginTurn(start: StoredTurnStart): void {
    this.connect();
    this.recoverInterruptedTurnsOnce();
    const { request } = start;
    if (this.activeTurns.has(request.turnId)) {
      throw new Error(`Chat turn ${request.turnId} is already being persisted.`);
    }
    const userMessage = request.messages[request.messages.length - 1];
    if (!userMessage || userMessage.role !== 'user') {
      throw new Error('The persisted Chat turn must end with a user message.');
    }
    const startedAt = this.timestampFor(request.createdAt);

    this.transaction(() => {
      this.ensureTurnSession(request.sessionId, userMessage.content, startedAt);
      const database = this.databaseOrThrow();
      const messageCount = this.numberValue(
        database.prepare('SELECT COUNT(*) AS count FROM "chat_messages" WHERE session_id = ?').get(request.sessionId) ?? {},
        'count'
      );
      if (messageCount === 0) {
        database.prepare('UPDATE "chat_sessions" SET title = ? WHERE id = ?').run(
          this.titleFor(userMessage.content),
          request.sessionId
        );
      }

      database.prepare(`
        INSERT INTO "chat_messages"
          (id, session_id, turn_id, role, content, reasoning_content, created_at, created_at_epoch_ms, created_at_time_zone,
           status, duration_ms, input_tokens, output_tokens, context_window_tokens)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`)
        .run(
          request.userMessageId,
          request.sessionId,
          request.turnId,
          'user',
          userMessage.content,
          '',
          startedAt.localDateTime,
          startedAt.epochMilliseconds,
          startedAt.timeZone,
          'complete'
        );
      database.prepare(`
        INSERT INTO "chat_messages"
          (id, session_id, turn_id, role, content, reasoning_content, created_at, created_at_epoch_ms, created_at_time_zone,
           status, duration_ms, input_tokens, output_tokens, context_window_tokens)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`)
        .run(
          request.assistantMessageId,
          request.sessionId,
          request.turnId,
          'assistant',
          '',
          '',
          startedAt.localDateTime,
          startedAt.epochMilliseconds,
          startedAt.timeZone,
          'streaming'
        );
      database.prepare(`
        INSERT INTO "chat_turns"
          (id, session_id, user_message_id, assistant_message_id, model_id, model_label,
           started_at, started_at_epoch_ms, started_at_time_zone,
           ended_at, ended_at_epoch_ms, ended_at_time_zone,
           status, input_tokens, output_tokens, context_window_tokens)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, ?)`)
        .run(
          request.turnId,
          request.sessionId,
          request.userMessageId,
          request.assistantMessageId,
          request.modelId,
          start.modelLabel,
          startedAt.localDateTime,
          startedAt.epochMilliseconds,
          startedAt.timeZone,
          'streaming',
          start.contextWindowTokens
        );
      database.prepare(`
        UPDATE "chat_sessions"
           SET model_id = ?, model_label = ?, closed = 0,
               updated_at = ?, updated_at_epoch_ms = ?, updated_at_time_zone = ?
         WHERE id = ?`)
        .run(
          request.modelId,
          start.modelLabel,
          startedAt.localDateTime,
          startedAt.epochMilliseconds,
          startedAt.timeZone,
          request.sessionId
        );
      this.openSessionTab(request.sessionId);
      this.setActiveSession(request.sessionId);
    });

    this.activeTurns.set(request.turnId, {
      ...start,
      text: '',
      reasoningContent: '',
      inputTokens: null,
      outputTokens: null
    });
  }

  /** Buffers deltas in memory and atomically commits the full turn at its terminal event. */
  handleStreamEvent(event: LocalChatEvent): void {
    const activeTurn = this.activeTurns.get(event.turnId);
    if (!activeTurn ||
      activeTurn.request.sessionId !== event.sessionId ||
      activeTurn.request.assistantMessageId !== event.assistantMessageId) {
      return;
    }

    if (event.type === 'textDelta') {
      this.activeTurns.set(event.turnId, { ...activeTurn, text: `${activeTurn.text}${event.text}` });
      return;
    }
    if (event.type === 'reasoningDelta') {
      this.activeTurns.set(event.turnId, {
        ...activeTurn,
        reasoningContent: `${activeTurn.reasoningContent}${event.text}`
      });
      return;
    }
    if (event.type === 'usage') {
      this.activeTurns.set(event.turnId, {
        ...activeTurn,
        inputTokens: event.inputTokens ?? activeTurn.inputTokens,
        outputTokens: event.outputTokens ?? activeTurn.outputTokens
      });
      return;
    }

    const terminal = this.terminalFor(event);
    this.finishTurn(activeTurn, terminal.status, terminal.message);
    this.activeTurns.delete(event.turnId);
  }

  /** Records a synchronous start rejection that cannot reach the executor's event stream. */
  failTurnStart(turnId: string, message: string): void {
    const activeTurn = this.activeTurns.get(turnId);
    if (!activeTurn) return;
    this.finishTurn(activeTurn, 'error', message);
    this.activeTurns.delete(turnId);
  }

  private finishTurn(activeTurn: ActivePersistedTurn, status: LocalChatTurnStatus, errorMessage: string | null): void {
    const endedAt = this.timestampFor(this.now());
    const durationMs = Math.max(0, endedAt.epochMilliseconds - activeTurn.request.createdAt);
    const hasUsage = activeTurn.inputTokens !== null || activeTurn.outputTokens !== null;
    const content = activeTurn.text || this.emptyTerminalContent(status, errorMessage);
    const messageStatus: LocalChatMessageStatus = status === 'completed' || status === 'cancelled'
      ? 'complete'
      : status === 'incomplete'
        ? 'incomplete'
        : 'error';

    this.transaction(() => {
      const database = this.databaseOrThrow();
      database.prepare(`
        UPDATE "chat_messages"
           SET content = ?, reasoning_content = ?, status = ?, duration_ms = ?, input_tokens = ?, output_tokens = ?, context_window_tokens = ?
         WHERE id = ? AND session_id = ?`)
        .run(
          content,
          activeTurn.reasoningContent,
          messageStatus,
          durationMs,
          hasUsage ? activeTurn.inputTokens : null,
          hasUsage ? activeTurn.outputTokens : null,
          hasUsage ? activeTurn.contextWindowTokens : null,
          activeTurn.request.assistantMessageId,
          activeTurn.request.sessionId
        );
      database.prepare(`
        UPDATE "chat_turns"
           SET ended_at = ?, ended_at_epoch_ms = ?, ended_at_time_zone = ?,
               status = ?, input_tokens = ?, output_tokens = ?, context_window_tokens = ?
         WHERE id = ? AND session_id = ?`)
        .run(
          endedAt.localDateTime,
          endedAt.epochMilliseconds,
          endedAt.timeZone,
          status,
          hasUsage ? activeTurn.inputTokens : null,
          hasUsage ? activeTurn.outputTokens : null,
          hasUsage ? activeTurn.contextWindowTokens : null,
          activeTurn.request.turnId,
          activeTurn.request.sessionId
        );
      database.prepare(`
        UPDATE "chat_sessions"
           SET updated_at = ?, updated_at_epoch_ms = ?, updated_at_time_zone = ?
         WHERE id = ?`)
        .run(
          endedAt.localDateTime,
          endedAt.epochMilliseconds,
          endedAt.timeZone,
          activeTurn.request.sessionId
        );
    });
  }

  private terminalFor(event: Exclude<LocalChatEvent, { type: 'textDelta' | 'usage' }>): {
    status: LocalChatTurnStatus;
    message: string | null;
  } {
    if (event.type === 'completed') return { status: 'completed', message: null };
    if (event.type === 'cancelled') return { status: 'cancelled', message: null };
    if (event.type === 'watchdogTerminated') return { status: 'watchdogTerminated', message: WATCHDOG_ERROR_MESSAGE };
    if (event.type === 'error') return { status: 'error', message: event.message };
    return { status: 'incomplete', message: INTERRUPTED_ERROR_MESSAGE };
  }

  private emptyTerminalContent(status: LocalChatTurnStatus, errorMessage: string | null): string {
    if (status === 'watchdogTerminated') return WATCHDOG_ERROR_MESSAGE;
    if (status === 'error') return errorMessage ?? 'The local model request failed.';
    if (status === 'incomplete') return INTERRUPTED_ERROR_MESSAGE;
    if (status === 'cancelled') return 'Generation stopped before a response was received.';
    return '';
  }

  private recoverInterruptedTurnsOnce(): void {
    if (this.recoveredInterruptedTurns) return;
    const recoveredAt = this.timestampFor(this.now());
    this.transaction(() => {
      const database = this.databaseOrThrow();
      database.prepare(`
        UPDATE "chat_sessions"
           SET updated_at = ?, updated_at_epoch_ms = ?, updated_at_time_zone = ?
         WHERE id IN (SELECT DISTINCT session_id FROM "chat_turns" WHERE status = 'streaming')`)
        .run(recoveredAt.localDateTime, recoveredAt.epochMilliseconds, recoveredAt.timeZone);
      database.prepare(`
        UPDATE "chat_messages"
           SET status = 'incomplete', content = CASE WHEN content = '' THEN ? ELSE content END
         WHERE status = 'streaming'`)
        .run(INTERRUPTED_ERROR_MESSAGE);
      database.prepare(`
        UPDATE "chat_turns"
           SET status = 'incomplete',
               ended_at = COALESCE(ended_at, ?),
               ended_at_epoch_ms = COALESCE(ended_at_epoch_ms, ?),
               ended_at_time_zone = COALESCE(ended_at_time_zone, ?)
         WHERE status = 'streaming'`)
        .run(recoveredAt.localDateTime, recoveredAt.epochMilliseconds, recoveredAt.timeZone);
    });
    this.recoveredInterruptedTurns = true;
  }

  private ensureWorkspace(): void {
    if (this.readOpenSessionIds().length === 0) {
      const sessionId = this.insertBlankSession();
      this.openSessionTab(sessionId);
      this.setActiveSession(sessionId);
      return;
    }
    const openSessionIds = this.readOpenSessionIds();
    const activeSessionId = this.readActiveSessionId();
    if (!activeSessionId || !openSessionIds.includes(activeSessionId)) {
      this.setActiveSession(openSessionIds[openSessionIds.length - 1]);
    }
  }

  private ensureTurnSession(sessionId: string, userMessage: string, createdAt: LocalStorageTimestamp): void {
    if (this.sessionExists(sessionId)) return;
    const database = this.databaseOrThrow();
    database.prepare(`
      INSERT INTO "chat_sessions"
        (id, title,
         created_at, created_at_epoch_ms, created_at_time_zone,
         updated_at, updated_at_epoch_ms, updated_at_time_zone,
         model_id, model_label, closed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0)`)
      .run(
        sessionId,
        this.titleFor(userMessage),
        createdAt.localDateTime,
        createdAt.epochMilliseconds,
        createdAt.timeZone,
        createdAt.localDateTime,
        createdAt.epochMilliseconds,
        createdAt.timeZone
      );
  }

  private insertBlankSession(): string {
    const sessionId = this.createId();
    const createdAt = this.timestampFor(this.now());
    this.databaseOrThrow().prepare(`
      INSERT INTO "chat_sessions"
        (id, title,
         created_at, created_at_epoch_ms, created_at_time_zone,
         updated_at, updated_at_epoch_ms, updated_at_time_zone,
         model_id, model_label, closed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0)`)
      .run(
        sessionId,
        DEFAULT_LOCAL_CHAT_SESSION_TITLE,
        createdAt.localDateTime,
        createdAt.epochMilliseconds,
        createdAt.timeZone,
        createdAt.localDateTime,
        createdAt.epochMilliseconds,
        createdAt.timeZone
      );
    return sessionId;
  }

  private openSessionTab(sessionId: string): void {
    const database = this.databaseOrThrow();
    const isOpen = database.prepare('SELECT 1 AS present FROM "chat_open_sessions" WHERE session_id = ?').get(sessionId);
    if (isOpen) return;
    const tabOrder = this.numberValue(
      database.prepare('SELECT COALESCE(MAX(tab_order), -1) + 1 AS tab_order FROM "chat_open_sessions"').get() ?? {},
      'tab_order'
    );
    database.prepare('INSERT INTO "chat_open_sessions" (session_id, tab_order) VALUES (?, ?)')
      .run(sessionId, tabOrder);
  }

  private setActiveSession(sessionId: string): void {
    const updatedAt = this.timestampFor(this.now());
    this.databaseOrThrow().prepare(`
      INSERT OR REPLACE INTO "chat_workspace_state"
        (id, active_session_id, updated_at, updated_at_epoch_ms, updated_at_time_zone)
      VALUES (1, ?, ?, ?, ?)`)
      .run(
        sessionId,
        updatedAt.localDateTime,
        updatedAt.epochMilliseconds,
        updatedAt.timeZone
      );
  }

  private readWorkspace(): LocalChatWorkspace {
    const openSessionIds = this.readOpenSessionIds();
    const activeSessionId = this.readActiveSessionId() ?? openSessionIds[openSessionIds.length - 1];
    const rows = this.databaseOrThrow().prepare(`
      SELECT id, title, created_at_epoch_ms, updated_at_epoch_ms, model_id, model_label, closed
        FROM "chat_sessions"
       ORDER BY updated_at_epoch_ms DESC, created_at_epoch_ms DESC`).all() as Record<string, unknown>[];
    const sessions = rows.map((row) => this.decodeSession(row));
    return { sessions, openSessionIds, activeSessionId };
  }

  private decodeSession(row: Record<string, unknown>): LocalChatStoredSession {
    const sessionId = this.textValue(row.id);
    const rows = this.databaseOrThrow().prepare(`
      SELECT id, role, content, reasoning_content, created_at_epoch_ms, status, duration_ms, input_tokens, output_tokens, context_window_tokens
        FROM "chat_messages"
       WHERE session_id = ?
       ORDER BY created_at_epoch_ms ASC, rowid ASC`).all(sessionId) as Record<string, unknown>[];
    const activeTextByAssistantMessageId = new Map(
      [...this.activeTurns.values()]
        .filter((activeTurn) => activeTurn.request.sessionId === sessionId)
        .map((activeTurn) => [activeTurn.request.assistantMessageId, activeTurn.text])
    );
    const activeReasoningByAssistantMessageId = new Map(
      [...this.activeTurns.values()]
        .filter((activeTurn) => activeTurn.request.sessionId === sessionId)
        .map((activeTurn) => [activeTurn.request.assistantMessageId, activeTurn.reasoningContent])
    );
    return {
      id: sessionId,
      title: this.textValue(row.title),
      createdAt: this.numberValue(row, 'created_at_epoch_ms'),
      updatedAt: this.numberValue(row, 'updated_at_epoch_ms'),
      modelId: this.nullableTextValue(row.model_id),
      modelLabel: this.nullableTextValue(row.model_label),
      closed: this.numberValue(row, 'closed') !== 0,
      messages: rows.map((row) => {
        const message = this.decodeMessage(row);
        const activeText = activeTextByAssistantMessageId.get(message.id);
        const activeReasoning = activeReasoningByAssistantMessageId.get(message.id);
        return activeText === undefined && activeReasoning === undefined
          ? message
          : {
              ...message,
              content: activeText ?? message.content,
              reasoningContent: activeReasoning ?? message.reasoningContent,
              status: 'streaming'
            };
      })
    };
  }

  private decodeMessage(row: Record<string, unknown>): LocalChatStoredMessage {
    const inputTokens = this.nullableNumberValue(row.input_tokens);
    const outputTokens = this.nullableNumberValue(row.output_tokens);
    const contextWindowTokens = this.nullableNumberValue(row.context_window_tokens);
    const hasUsage = inputTokens !== null || outputTokens !== null || contextWindowTokens !== null;
    return {
      id: this.textValue(row.id),
      role: this.decodeRole(this.textValue(row.role)),
      content: this.textValue(row.content),
      reasoningContent: this.textValue(row.reasoning_content),
      createdAt: this.numberValue(row, 'created_at_epoch_ms'),
      durationMs: this.nullableNumberValue(row.duration_ms),
      status: this.decodeMessageStatus(this.textValue(row.status)),
      tokenUsage: hasUsage ? { inputTokens, outputTokens, contextWindowTokens } : null
    };
  }

  private readOpenSessionIds(): string[] {
    const rows = this.databaseOrThrow().prepare(`
      SELECT session_id FROM "chat_open_sessions" ORDER BY tab_order ASC`).all() as Record<string, unknown>[];
    return rows.map((row) => this.textValue(row.session_id)).filter((sessionId) => sessionId.length > 0);
  }

  private readActiveSessionId(): string | null {
    const row = this.databaseOrThrow().prepare(`
      SELECT active_session_id FROM "chat_workspace_state" WHERE id = 1`).get() as Record<string, unknown> | undefined;
    return row ? this.nullableTextValue(row.active_session_id) : null;
  }

  private sessionExists(sessionId: string): boolean {
    return Boolean(this.databaseOrThrow().prepare('SELECT 1 AS present FROM "chat_sessions" WHERE id = ?').get(sessionId));
  }

  private titleFor(content: string): string {
    return createLocalChatSessionTitle(content);
  }

  private transaction<T>(operation: () => T): T {
    const database = this.databaseOrThrow();
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // The failed statement can have ended its own transaction.
      }
      throw error;
    }
  }

  private connect(): DatabaseSync {
    if (this.database) return this.database;
    mkdirSync(path.dirname(this.databasePath), { recursive: true });
    const database = this.openDatabase(this.databasePath);
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(CHAT_SESSION_SCHEMA);
    this.database = database;
    this.ensureReasoningContentColumn();
    this.migrateLocalTimestampStorage();
    database.exec(CHAT_TIMESTAMP_INDEXES);
    this.restrictPermissions();
    return database;
  }

  private ensureReasoningContentColumn(): void {
    if (this.tableHasColumn('chat_messages', 'reasoning_content')) return;
    this.databaseOrThrow().exec(`ALTER TABLE "chat_messages" ADD COLUMN "reasoning_content" TEXT NOT NULL DEFAULT ''`);
  }

  private migrateLocalTimestampStorage(): void {
    if (!this.hasCurrentTimestampSchema()) {
      this.rebuildTimestampSchema();
    }
    this.backfillLocalTimestamps();
  }

  private hasCurrentTimestampSchema(): boolean {
    const requiredColumns = [
      ['chat_sessions', 'created_at_epoch_ms'],
      ['chat_sessions', 'created_at_time_zone'],
      ['chat_sessions', 'updated_at_epoch_ms'],
      ['chat_sessions', 'updated_at_time_zone'],
      ['chat_messages', 'created_at_epoch_ms'],
      ['chat_messages', 'created_at_time_zone'],
      ['chat_turns', 'started_at_epoch_ms'],
      ['chat_turns', 'started_at_time_zone'],
      ['chat_turns', 'ended_at_epoch_ms'],
      ['chat_turns', 'ended_at_time_zone'],
      ['chat_workspace_state', 'updated_at_epoch_ms'],
      ['chat_workspace_state', 'updated_at_time_zone']
    ] as const;
    return requiredColumns.every(([tableName, columnName]) => this.tableHasColumn(tableName, columnName));
  }

  private rebuildTimestampSchema(): void {
    const database = this.databaseOrThrow();
    const sessions = this.tableRows('chat_sessions');
    const messages = this.tableRows('chat_messages');
    const turns = this.tableRows('chat_turns');
    const openSessions = this.tableRows('chat_open_sessions');
    const workspaceState = this.tableRows('chat_workspace_state');

    database.exec('PRAGMA foreign_keys = OFF');
    database.exec('BEGIN IMMEDIATE');
    try {
      [
        'chat_workspace_state',
        'chat_open_sessions',
        'chat_turns',
        'chat_messages',
        'chat_sessions'
      ].forEach((tableName) => database.exec(`DROP TABLE IF EXISTS "${tableName}"`));
      database.exec(CHAT_SESSION_SCHEMA);
      this.insertMigratedSessions(sessions);
      this.insertMigratedMessages(messages);
      this.insertMigratedTurns(turns);
      this.insertMigratedOpenSessions(openSessions);
      this.insertMigratedWorkspaceState(workspaceState);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    } finally {
      database.exec('PRAGMA foreign_keys = ON');
    }
  }

  private insertMigratedSessions(rows: readonly Record<string, unknown>[]): void {
    const statement = this.databaseOrThrow().prepare(`
      INSERT INTO "chat_sessions"
        (id, title,
         created_at, created_at_epoch_ms, created_at_time_zone,
         updated_at, updated_at_epoch_ms, updated_at_time_zone,
         model_id, model_label, closed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    rows.forEach((row) => {
      const createdAt = this.timestampForRow(row, 'created_at');
      const updatedAt = this.timestampForRow(row, 'updated_at');
      statement.run(
        this.textValue(row.id),
        this.textValue(row.title),
        createdAt.localDateTime,
        createdAt.epochMilliseconds,
        createdAt.timeZone,
        updatedAt.localDateTime,
        updatedAt.epochMilliseconds,
        updatedAt.timeZone,
        this.nullableTextValue(row.model_id),
        this.nullableTextValue(row.model_label),
        this.numberValue(row, 'closed')
      );
    });
  }

  private insertMigratedMessages(rows: readonly Record<string, unknown>[]): void {
    const statement = this.databaseOrThrow().prepare(`
      INSERT INTO "chat_messages"
        (id, session_id, turn_id, role, content, reasoning_content,
         created_at, created_at_epoch_ms, created_at_time_zone,
         status, duration_ms, input_tokens, output_tokens, context_window_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    rows.forEach((row) => {
      const createdAt = this.timestampForRow(row, 'created_at');
      statement.run(
        this.textValue(row.id),
        this.textValue(row.session_id),
        this.textValue(row.turn_id),
        this.textValue(row.role),
        this.textValue(row.content),
        this.textValue(row.reasoning_content),
        createdAt.localDateTime,
        createdAt.epochMilliseconds,
        createdAt.timeZone,
        this.textValue(row.status),
        this.nullableNumberValue(row.duration_ms),
        this.nullableNumberValue(row.input_tokens),
        this.nullableNumberValue(row.output_tokens),
        this.nullableNumberValue(row.context_window_tokens)
      );
    });
  }

  private insertMigratedTurns(rows: readonly Record<string, unknown>[]): void {
    const statement = this.databaseOrThrow().prepare(`
      INSERT INTO "chat_turns"
        (id, session_id, user_message_id, assistant_message_id, model_id, model_label,
         started_at, started_at_epoch_ms, started_at_time_zone,
         ended_at, ended_at_epoch_ms, ended_at_time_zone,
         status, input_tokens, output_tokens, context_window_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    rows.forEach((row) => {
      const startedAt = this.timestampForRow(row, 'started_at');
      const endedAt = this.nullableTimestampForRow(row, 'ended_at');
      statement.run(
        this.textValue(row.id),
        this.textValue(row.session_id),
        this.textValue(row.user_message_id),
        this.textValue(row.assistant_message_id),
        this.textValue(row.model_id),
        this.textValue(row.model_label),
        startedAt.localDateTime,
        startedAt.epochMilliseconds,
        startedAt.timeZone,
        endedAt?.localDateTime ?? null,
        endedAt?.epochMilliseconds ?? null,
        endedAt?.timeZone ?? null,
        this.textValue(row.status),
        this.nullableNumberValue(row.input_tokens),
        this.nullableNumberValue(row.output_tokens),
        this.nullableNumberValue(row.context_window_tokens)
      );
    });
  }

  private insertMigratedOpenSessions(rows: readonly Record<string, unknown>[]): void {
    const statement = this.databaseOrThrow().prepare(`
      INSERT INTO "chat_open_sessions" (session_id, tab_order) VALUES (?, ?)`);
    rows.forEach((row) => statement.run(this.textValue(row.session_id), this.numberValue(row, 'tab_order')));
  }

  private insertMigratedWorkspaceState(rows: readonly Record<string, unknown>[]): void {
    const statement = this.databaseOrThrow().prepare(`
      INSERT INTO "chat_workspace_state"
        (id, active_session_id, updated_at, updated_at_epoch_ms, updated_at_time_zone)
      VALUES (?, ?, ?, ?, ?)`);
    rows.forEach((row) => {
      const updatedAt = this.timestampForRow(row, 'updated_at');
      statement.run(
        this.numberValue(row, 'id'),
        this.nullableTextValue(row.active_session_id),
        updatedAt.localDateTime,
        updatedAt.epochMilliseconds,
        updatedAt.timeZone
      );
    });
  }

  private backfillLocalTimestamps(): void {
    const tables: readonly TimestampBackfillTable[] = [
      { tableName: 'chat_sessions', columns: ['created_at', 'updated_at'] },
      { tableName: 'chat_messages', columns: ['created_at'] },
      { tableName: 'chat_turns', columns: ['started_at'], nullableColumns: ['ended_at'] },
      { tableName: 'chat_workspace_state', columns: ['updated_at'] }
    ] as const;

    this.transaction(() => {
      tables.forEach(({ tableName, columns, nullableColumns = [] }) => {
        this.tableRows(tableName).forEach((row) => {
          const columnAssignments: string[] = [];
          const values: (string | number)[] = [];
          [...columns, ...nullableColumns].forEach((column) => {
            if (this.hasCompleteTimestamp(row, column)) return;
            const timestamp = nullableColumns.includes(column)
              ? this.nullableTimestampForRow(row, column)
              : this.timestampForRow(row, column);
            if (!timestamp) return;
            columnAssignments.push(`${column} = ?`, `${column}_epoch_ms = ?`, `${column}_time_zone = ?`);
            values.push(timestamp.localDateTime, timestamp.epochMilliseconds, timestamp.timeZone);
          });
          if (columnAssignments.length === 0) return;
          this.databaseOrThrow().prepare(
            `UPDATE "${tableName}" SET ${columnAssignments.join(', ')} WHERE rowid = ?`
          ).run(...values, this.numberValue(row, 'rowid'));
        });
      });
    });
  }

  private hasCompleteTimestamp(row: Record<string, unknown>, column: string): boolean {
    const timeZone = row[`${column}_time_zone`];
    return (
      isLocalStorageTimestamp(row[column]) &&
      epochMillisecondsFromStoredTimestamp(row[`${column}_epoch_ms`], 'milliseconds') !== null &&
      typeof timeZone === 'string' && timeZone.length > 0
    );
  }

  private timestampForRow(row: Record<string, unknown>, column: string): LocalStorageTimestamp {
    if (this.hasCompleteTimestamp(row, column)) {
      return {
        localDateTime: this.textValue(row[column]),
        epochMilliseconds: epochMillisecondsFromStoredTimestamp(row[`${column}_epoch_ms`], 'milliseconds') ?? this.now(),
        timeZone: this.textValue(row[`${column}_time_zone`])
      };
    }
    const epochMilliseconds = epochMillisecondsFromStoredTimestamp(row[`${column}_epoch_ms`], 'milliseconds')
      ?? epochMillisecondsFromStoredTimestamp(row[column], 'milliseconds')
      ?? this.now();
    return this.timestampFor(epochMilliseconds);
  }

  private nullableTimestampForRow(row: Record<string, unknown>, column: string): LocalStorageTimestamp | null {
    if (row[column] === null || row[column] === undefined) return null;
    return this.timestampForRow(row, column);
  }

  private timestampFor(epochMilliseconds: number): LocalStorageTimestamp {
    return localTimestampForEpochMilliseconds(epochMilliseconds);
  }

  private tableRows(tableName: string): Record<string, unknown>[] {
    return this.databaseOrThrow().prepare(`SELECT rowid, * FROM "${tableName}"`).all() as Record<string, unknown>[];
  }

  private tableHasColumn(tableName: string, columnName: string): boolean {
    const rows = this.databaseOrThrow()
      .prepare(`PRAGMA table_info("${tableName}")`)
      .all() as Record<string, unknown>[];
    return rows.some((row) => this.textValue(row.name) === columnName);
  }

  private databaseOrThrow(): DatabaseSync {
    return this.database ?? this.connect();
  }

  private restrictPermissions(): void {
    try {
      chmodSync(this.databasePath, 0o600);
    } catch (error) {
      console.warn(`[ChatSessionStore] Could not restrict database permissions: ${String(error)}`);
    }
  }

  private decodeRole(value: string): LocalChatMessageRole {
    return value === 'assistant' ? 'assistant' : 'user';
  }

  private decodeMessageStatus(value: string): LocalChatMessageStatus {
    return ['complete', 'streaming', 'error', 'incomplete'].includes(value)
      ? value as LocalChatMessageStatus
      : 'incomplete';
  }

  private textValue(value: unknown): string {
    return typeof value === 'string' ? value : String(value ?? '');
  }

  private nullableTextValue(value: unknown): string | null {
    return value === null || value === undefined ? null : this.textValue(value);
  }

  private numberValue(row: Record<string, unknown>, key: string): number {
    const value = row[key];
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private nullableNumberValue(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private static openSqliteDatabase(databasePath: string): DatabaseSync {
    const sqlite = require('node:sqlite') as typeof import('node:sqlite');
    return new sqlite.DatabaseSync(databasePath);
  }
}

export default ChatSessionStore;
