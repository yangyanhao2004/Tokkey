import path from 'node:path';

/** The one SQLite database owned exclusively by Tokiie. */
export function tokiieDatabasePath(homeDirectory: string): string {
  return path.join(homeDirectory, '.tokiie', 'dbs', 'tokiie.db');
}
