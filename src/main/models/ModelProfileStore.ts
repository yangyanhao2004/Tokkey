import { chmodSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
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
 * Column-for-column copy of the table the Swift app creates through its GRDB
 * migration. `IF NOT EXISTS` makes this a no-op on a database that already ran
 * that migration, and creates a compatible table on a machine that never had
 * the Swift app installed.
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
  "created_at" REAL NOT NULL
)`;

const SELECT_PROFILE_BY_ID = `
SELECT id, name, provider, api_url, api_key, model_name, type,
       supported_api_formats, litellm_links, created_at
  FROM "model_profiles"
 WHERE id = ?`;

// INSERT OR REPLACE mirrors what GRDB's save() does, so a profile written by
// either app updates the same row instead of failing on the primary key.
const UPSERT_PROFILE = `
INSERT OR REPLACE INTO "model_profiles"
  (id, name, provider, api_url, api_key, model_name, type,
   supported_api_formats, litellm_links, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

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
 * Reads and writes `model_profiles` in `~/.amiswifi/dbs/amis_wifi.db`.
 *
 * The file is shared with the Swift Amis-Wifi app, so this class owns no schema
 * of its own: it creates the table exactly as that app's migration does and
 * encodes every column in the same representation (comma-joined API formats,
 * JSON links, Unix-seconds timestamp).
 */
export class SqliteModelProfileStore implements ModelProfileStoring {
  private readonly databasePath: string;
  private readonly openDatabase: (databasePath: string) => DatabaseSync;
  private database: DatabaseSync | null = null;

  constructor(options: SqliteModelProfileStoreOptions = {}) {
    const homeDirectory = options.homeDirectory ?? os.homedir();
    this.databasePath =
      options.databasePath ?? path.join(homeDirectory, '.amiswifi', 'dbs', 'amis_wifi.db');
    this.openDatabase = options.openDatabase ?? SqliteModelProfileStore.openSqliteDatabase;
  }

  async find(profileId: string): Promise<ModelProfile | null> {
    const row = this.connect().prepare(SELECT_PROFILE_BY_ID).get(profileId);
    return row ? this.decodeProfile(row) : null;
  }

  async save(profile: ModelProfile): Promise<void> {
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
        profile.createdAt
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
    // Stored API keys must not be world-readable; matches the Swift app.
    this.restrictPermissions();
    this.database = database;
    return database;
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
      createdAt: typeof row.created_at === 'number' ? row.created_at : Number(row.created_at ?? 0)
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
