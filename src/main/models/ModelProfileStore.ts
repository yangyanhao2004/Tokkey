import { chmodSync, mkdirSync } from 'node:fs';
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
  CloudApiFormat,
  LiteLlmModelLink,
  ModelProfile,
  ModelProfileType
} from '../../shared/types';

/** Every API format that may appear in `supported_api_formats`. */
const CLOUD_API_FORMATS: readonly CloudApiFormat[] = [
  'AMIS_GATEWAY_MANAGED',
  'openai_chat',
  'openai_responses',
  'anthropic'
];

/** Every endpoint kind that may appear in `type`. */
const MODEL_PROFILE_TYPES: readonly ModelProfileType[] = ['cloud', 'local', 'hub', 'tokenbox'];

/**
 * Tokiie keeps local business time in readable ISO text with the user's system
 * timezone. A paired epoch column remains available for stable comparisons.
 */
const MODEL_PROFILES_SCHEMA = `
CREATE TABLE IF NOT EXISTS "model_profiles" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "api_url" TEXT NOT NULL,
  "api_key" TEXT,
  "model_name" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'cloud',
  "supported_api_formats" TEXT NOT NULL DEFAULT 'openai_chat',
  "litellm_links" TEXT NOT NULL DEFAULT '[]',
  "created_at" TEXT NOT NULL,
  "created_at_epoch_ms" INTEGER NOT NULL DEFAULT 0,
  "created_at_time_zone" TEXT NOT NULL DEFAULT ''
)`;

const SELECT_PROFILE_BY_ID = `
SELECT id, name, provider, api_url, api_key, model_name, type,
       supported_api_formats, litellm_links, created_at, created_at_epoch_ms
  FROM "model_profiles"
 WHERE id = ?`;

// INSERT OR REPLACE keeps a profile's stable ID idempotent within Tokiie's database.
const UPSERT_PROFILE = `
INSERT OR REPLACE INTO "model_profiles"
  (id, name, provider, api_url, api_key, model_name, type,
   supported_api_formats, litellm_links,
   created_at, created_at_epoch_ms, created_at_time_zone)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** Persistence contract the connector programs against. */
export interface ModelProfileStoring {
  /** One saved profile by id, or null when it was never saved. */
  find(profileId: string): Promise<ModelProfile | null>;
  /** Inserts or replaces one profile, keyed by its id. */
  save(profile: ModelProfile): Promise<void>;
}

export interface SqliteModelProfileStoreOptions {
  homeDirectory?: string;
  databasePath?: string;
  /** Injected so tests can supply a database handle without touching the disk. */
  openDatabase?: (databasePath: string) => DatabaseSync;
}

/**
 * Reads and writes Tokiie's `model_profiles` in `~/.tokiie/dbs/tokiie.db`.
 */
export class SqliteModelProfileStore implements ModelProfileStoring {
  private readonly databasePath: string;
  private readonly openDatabase: (databasePath: string) => DatabaseSync;
  private database: DatabaseSync | null = null;

  constructor(options: SqliteModelProfileStoreOptions = {}) {
    const homeDirectory = options.homeDirectory ?? os.homedir();
    this.databasePath = options.databasePath ?? tokiieDatabasePath(homeDirectory);
    this.openDatabase = options.openDatabase ?? SqliteModelProfileStore.openSqliteDatabase;
  }

  async find(profileId: string): Promise<ModelProfile | null> {
    const row = this.connect().prepare(SELECT_PROFILE_BY_ID).get(profileId);
    return row ? this.decodeProfile(row) : null;
  }

  async save(profile: ModelProfile): Promise<void> {
    const createdAt = this.timestampForSeconds(profile.createdAt);
    this.connect()
      .prepare(UPSERT_PROFILE)
      .run(
        profile.id,
        profile.name,
        profile.provider,
        profile.apiUrl,
        profile.apiKey,
        profile.modelName,
        profile.type,
        profile.supportedApiFormats.join(','),
        JSON.stringify(profile.litellmLinks),
        createdAt.localDateTime,
        createdAt.epochMilliseconds,
        createdAt.timeZone
      );
  }

  /** Releases the file handle; call when the app is shutting down. */
  close(): void {
    this.database?.close();
    this.database = null;
  }

  /** Opens the database on first use and makes sure the table exists. */
  private connect(): DatabaseSync {
    if (this.database) {
      return this.database;
    }
    mkdirSync(path.dirname(this.databasePath), { recursive: true });
    const database = this.openDatabase(this.databasePath);
    database.exec(MODEL_PROFILES_SCHEMA);
    this.database = database;
    this.migrateLocalTimestampStorage();
    // Stored API keys must not be world-readable; matches the Swift app.
    this.restrictPermissions();
    return database;
  }

  private migrateLocalTimestampStorage(): void {
    if (!this.tableHasColumn('created_at_epoch_ms') || !this.tableHasColumn('created_at_time_zone')) {
      this.rebuildTimestampSchema();
    }
    this.backfillLocalTimestamp();
  }

  private rebuildTimestampSchema(): void {
    const database = this.databaseOrThrow();
    const rows = database.prepare('SELECT rowid, * FROM "model_profiles"').all() as Record<string, unknown>[];
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec('ALTER TABLE "model_profiles" RENAME TO "model_profiles_legacy_timestamp"');
      database.exec(MODEL_PROFILES_SCHEMA);
      const statement = database.prepare(`
        INSERT INTO "model_profiles"
          (id, name, provider, api_url, api_key, model_name, type, supported_api_formats, litellm_links,
           created_at, created_at_epoch_ms, created_at_time_zone)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      rows.forEach((row) => {
        const createdAt = this.timestampForRow(row);
        statement.run(
          this.textValue(row.id),
          this.textValue(row.name),
          this.textValue(row.provider),
          this.textValue(row.api_url),
          row.api_key === null || row.api_key === undefined ? null : this.textValue(row.api_key),
          this.textValue(row.model_name),
          this.textValue(row.type),
          this.textValue(row.supported_api_formats),
          this.textValue(row.litellm_links),
          createdAt.localDateTime,
          createdAt.epochMilliseconds,
          createdAt.timeZone
        );
      });
      database.exec('DROP TABLE "model_profiles_legacy_timestamp"');
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  private backfillLocalTimestamp(): void {
    const rows = this.databaseOrThrow()
      .prepare('SELECT rowid, * FROM "model_profiles"')
      .all() as Record<string, unknown>[];
    rows.forEach((row) => {
      if (this.hasCompleteTimestamp(row)) return;
      const createdAt = this.timestampForRow(row);
      this.databaseOrThrow().prepare(`
        UPDATE "model_profiles"
           SET created_at = ?, created_at_epoch_ms = ?, created_at_time_zone = ?
         WHERE rowid = ?`)
        .run(createdAt.localDateTime, createdAt.epochMilliseconds, createdAt.timeZone, this.numberValue(row.rowid));
    });
  }

  private hasCompleteTimestamp(row: Record<string, unknown>): boolean {
    const timeZone = row.created_at_time_zone;
    return (
      isLocalStorageTimestamp(row.created_at) &&
      epochMillisecondsFromStoredTimestamp(row.created_at_epoch_ms, 'milliseconds') !== null &&
      typeof timeZone === 'string' && timeZone.length > 0
    );
  }

  private timestampForRow(row: Record<string, unknown>): LocalStorageTimestamp {
    if (this.hasCompleteTimestamp(row)) {
      return {
        localDateTime: this.textValue(row.created_at),
        epochMilliseconds: epochMillisecondsFromStoredTimestamp(row.created_at_epoch_ms, 'milliseconds') ?? Date.now(),
        timeZone: this.textValue(row.created_at_time_zone)
      };
    }
    const epochMilliseconds = epochMillisecondsFromStoredTimestamp(row.created_at_epoch_ms, 'milliseconds')
      ?? epochMillisecondsFromStoredTimestamp(row.created_at, 'seconds')
      ?? Date.now();
    return localTimestampForEpochMilliseconds(epochMilliseconds);
  }

  private timestampForSeconds(seconds: number): LocalStorageTimestamp {
    const timestamp = epochMillisecondsFromStoredTimestamp(seconds, 'seconds');
    if (timestamp === null) {
      throw new TypeError('Model profile createdAt must be a positive Unix timestamp in seconds.');
    }
    return localTimestampForEpochMilliseconds(timestamp);
  }

  private createdAtSeconds(row: Record<string, unknown>): number {
    const epochMilliseconds = epochMillisecondsFromStoredTimestamp(row.created_at_epoch_ms, 'milliseconds')
      ?? epochMillisecondsFromStoredTimestamp(row.created_at, 'seconds')
      ?? 0;
    return epochMilliseconds / 1_000;
  }

  private tableHasColumn(columnName: string): boolean {
    const rows = this.databaseOrThrow().prepare('PRAGMA table_info("model_profiles")').all() as Record<string, unknown>[];
    return rows.some((row) => this.textValue(row.name) === columnName);
  }

  private databaseOrThrow(): DatabaseSync {
    return this.database ?? this.connect();
  }

  private restrictPermissions(): void {
    try {
      chmodSync(this.databasePath, 0o600);
    } catch (error) {
      // An in-memory database has no file, and a database owned by another user
      // is already outside this app's control. Neither should block persistence.
      console.warn(`[ModelProfileStore] Could not restrict database permissions: ${String(error)}`);
    }
  }

  /**
   * A row degrades rather than throws: an unreadable column written by a newer
   * app version must not take down the whole profile list.
   */
  private decodeProfile(row: Record<string, unknown>): ModelProfile {
    return {
      id: this.textValue(row.id),
      name: this.textValue(row.name),
      provider: this.textValue(row.provider),
      apiUrl: this.textValue(row.api_url),
      apiKey: row.api_key === null || row.api_key === undefined ? null : this.textValue(row.api_key),
      modelName: this.textValue(row.model_name),
      type: this.decodeType(this.textValue(row.type)),
      supportedApiFormats: this.decodeFormats(this.textValue(row.supported_api_formats)),
      litellmLinks: this.decodeLinks(this.textValue(row.litellm_links)),
      createdAt: this.createdAtSeconds(row)
    };
  }

  private decodeType(value: string): ModelProfileType {
    const type = MODEL_PROFILE_TYPES.find((candidate) => candidate === value);
    return type ?? 'cloud';
  }

  /** Comma-joined raw values; unknown tokens are dropped, never guessed. */
  private decodeFormats(value: string): CloudApiFormat[] {
    const parsed = value
      .split(',')
      .map((token) => token.trim())
      .filter((token): token is CloudApiFormat =>
        CLOUD_API_FORMATS.some((format) => format === token)
      );
    return parsed.length > 0 ? parsed : ['openai_chat'];
  }

  /** Undecodable JSON degrades to no links, so the profile can be re-materialized. */
  private decodeLinks(value: string): LiteLlmModelLink[] {
    try {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry): entry is LiteLlmModelLink => this.isModelLink(entry));
    } catch {
      return [];
    }
  }

  private isModelLink(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const link = value as Record<string, unknown>;
    return (
      typeof link.modelID === 'string' &&
      typeof link.modelName === 'string' &&
      CLOUD_API_FORMATS.some((format) => format === link.apiFormat)
    );
  }

  private textValue(value: unknown): string {
    return typeof value === 'string' ? value : String(value ?? '');
  }

  private numberValue(value: unknown): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * Loaded lazily so this module can be imported by tooling running on a Node
   * release without `node:sqlite`; the Electron runtime that actually opens the
   * database ships Node 24, where the module is built in.
   */
  private static openSqliteDatabase(databasePath: string): DatabaseSync {
    const sqlite = require('node:sqlite') as typeof import('node:sqlite');
    return new sqlite.DatabaseSync(databasePath);
  }
}

export default SqliteModelProfileStore;
