import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { tokkeyDatabasePath } from '../storage/TokkeyDatabase';

/** The pairing the router binary reads to tier a turn, instead of parsing the model name it was sent. */
export interface RouterProfile {
  id: string;
  /**
   * The gateway routes serving the local tier. A list for future-proofing only:
   * exactly one route is ever written today, since only one local model can be
   * started at a time and it always equals `cloudModels`' single entry — no
   * local model can be started yet, so the cloud route stands in for it. Once
   * more than one local route can be active, only the caller changes.
   */
  localModels: string[];
  /** The gateway routes serving the cloud tier. Same future-proofing, same single entry today. */
  cloudModels: string[];
}

const ROUTER_PROFILES_SCHEMA = `
CREATE TABLE IF NOT EXISTS "router_profiles" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "local_models" TEXT NOT NULL,
  "cloud_models" TEXT NOT NULL
)`;

const SELECT_ACTIVE_PROFILE = `SELECT id, local_models, cloud_models FROM "router_profiles" LIMIT 1`;

const INSERT_PROFILE = `
INSERT INTO "router_profiles" (id, local_models, cloud_models) VALUES (?, ?, ?)`;

const DELETE_ALL_PROFILES = `DELETE FROM "router_profiles"`;

/** Persistence contract the router integration programs against. */
export interface RouterProfileStoring {
  /** The active profile, or null while the router has never bound one. */
  findActive(): Promise<RouterProfile | null>;
  /** Replaces whatever profile was active with a freshly-identified one. */
  setActive(pairing: { localModels: string[]; cloudModels: string[] }): Promise<RouterProfile>;
}

export interface SqliteRouterProfileStoreOptions {
  homeDirectory?: string;
  databasePath?: string;
  /** Injected so tests can supply a database handle without touching the disk. */
  openDatabase?: (databasePath: string) => DatabaseSync;
}

/**
 * Reads and writes Tokkey's `router_profiles` table in `~/.tokkey/dbs/tokkey.db`.
 *
 * The router binary takes no `--local` / `--cloud` flags, and no longer decides
 * a turn's tier by parsing the model name it was sent: every routed pair now
 * shares one fixed name (`RouterModel.DISPLAY_NAME`), so a name carries no
 * pairing information at all. This table is how the router learns the pairing
 * instead — `RouterAgentIntegration` writes the active row every time it binds
 * a new pair, and the router reads it directly rather than through the app.
 *
 * At most one row exists at a time: nothing today lets more than one pairing be
 * active at once, and a second row would only invite the router to read the
 * wrong one. `setActive` enforces that by deleting whatever was there before
 * inserting, inside one transaction so a reader never sees the table briefly
 * empty.
 *
 * No timestamp columns, unlike `SqliteModelProfileStore`: nothing here is ever
 * listed or sorted, only read as a single active row, so there is nothing for a
 * timestamp to order.
 */
export class SqliteRouterProfileStore implements RouterProfileStoring {
  private readonly databasePath: string;
  private readonly openDatabase: (databasePath: string) => DatabaseSync;
  private database: DatabaseSync | null = null;

  constructor(options: SqliteRouterProfileStoreOptions = {}) {
    const homeDirectory = options.homeDirectory ?? os.homedir();
    this.databasePath = options.databasePath ?? tokkeyDatabasePath(homeDirectory);
    this.openDatabase = options.openDatabase ?? SqliteRouterProfileStore.openSqliteDatabase;
  }

  async findActive(): Promise<RouterProfile | null> {
    const row = this.connect().prepare(SELECT_ACTIVE_PROFILE).get() as Record<string, unknown> | undefined;
    return row ? this.decodeProfile(row) : null;
  }

  async setActive(pairing: { localModels: string[]; cloudModels: string[] }): Promise<RouterProfile> {
    const active: RouterProfile = { id: randomUUID(), ...pairing };
    const database = this.connect();
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(DELETE_ALL_PROFILES);
      database
        .prepare(INSERT_PROFILE)
        .run(active.id, JSON.stringify(active.localModels), JSON.stringify(active.cloudModels));
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return active;
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
    database.exec(ROUTER_PROFILES_SCHEMA);
    this.database = database;
    // Stored routing state must not be world-readable; matches ModelProfileStore.
    this.restrictPermissions();
    return database;
  }

  private restrictPermissions(): void {
    try {
      chmodSync(this.databasePath, 0o600);
    } catch (error) {
      // An in-memory database has no file, and a database owned by another user
      // is already outside this app's control. Neither should block persistence.
      console.warn(`[RouterProfileStore] Could not restrict database permissions: ${String(error)}`);
    }
  }

  private decodeProfile(row: Record<string, unknown>): RouterProfile {
    return {
      id: this.textValue(row.id),
      localModels: this.stringListValue(row.local_models),
      cloudModels: this.stringListValue(row.cloud_models)
    };
  }

  private textValue(value: unknown): string {
    return typeof value === 'string' ? value : String(value ?? '');
  }

  /** Decodes a `local_models` / `cloud_models` column back into the list it was written from. */
  private stringListValue(value: unknown): string[] {
    return typeof value === 'string' ? (JSON.parse(value) as string[]) : [];
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

export default SqliteRouterProfileStore;
