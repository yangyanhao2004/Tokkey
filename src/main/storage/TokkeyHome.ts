import os from 'node:os';
import path from 'node:path';

/** Owns the root directory used for all Tokkey-managed user data. */
export class TokkeyHome {
  static readonly DIRECTORY_NAME = '.tokkey';

  readonly rootPath: string;

  constructor(options: { homeDirectory?: string } = {}) {
    this.rootPath = path.join(
      options.homeDirectory ?? os.homedir(),
      TokkeyHome.DIRECTORY_NAME
    );
  }

  /** Builds a path inside Tokkey's user-data directory. */
  pathFor(...segments: string[]): string {
    return path.join(this.rootPath, ...segments);
  }
}

export default TokkeyHome;
