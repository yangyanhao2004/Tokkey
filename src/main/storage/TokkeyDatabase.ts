import path from 'node:path';

/** The one SQLite database owned exclusively by Tokkey. */
export function tokkeyDatabasePath(homeDirectory: string): string {
  return path.join(homeDirectory, '.tokkey', 'dbs', 'tokkey.db');
}
