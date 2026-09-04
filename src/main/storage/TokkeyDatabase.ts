import TokkeyHome from './TokkeyHome';

/** The one SQLite database owned exclusively by Tokkey. */
export function tokkeyDatabasePath(homeDirectory: string): string {
  return new TokkeyHome({ homeDirectory }).pathFor('dbs', 'tokkey.db');
}
