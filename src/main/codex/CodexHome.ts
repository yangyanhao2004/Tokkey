import os from 'node:os';
import path from 'node:path';

/** The catalog Tokkey writes, next to Codex's own state. */
const CATALOG_FILE_NAME = 'amis-catalog.json';

/**
 * Locates the files the Codex CLI reads, the way the CLI itself locates them.
 *
 * `CODEX_HOME` wins over `~/.codex` because that is the override the CLI
 * honours; a user who moved their Codex state expects everything that writes
 * into it to follow, and a Tokkey that wrote to the wrong home would configure
 * a Codex nobody runs.
 */
export class CodexHome {
  private readonly home: string;

  constructor(options: { homeDirectory?: string; codexHome?: string } = {}) {
    this.home = CodexHome.resolve(options);
  }

  /** The Codex home this machine uses, without touching the filesystem. */
  static resolve(options: { homeDirectory?: string; codexHome?: string } = {}): string {
    const explicit = options.codexHome?.trim() || process.env.CODEX_HOME?.trim();
    if (explicit) {
      return path.resolve(CodexHome.expandUser(explicit));
    }
    return path.join(options.homeDirectory ?? os.homedir(), '.codex');
  }

  /**
   * Expands a leading `~`, which the shell resolves but Node's path helpers do
   * not. Public because every path read out of `config.toml` needs the same
   * rule: the file is hand-written, so `~` appears in it wherever a path does.
   */
  static expandUser(value: string): string {
    if (value === '~') return os.homedir();
    if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
    return value;
  }

  get directory(): string {
    return this.home;
  }

  get configPath(): string {
    return path.join(this.home, 'config.toml');
  }

  /** Where Tokkey writes the model catalog it points `model_catalog_json` at. */
  get catalogPath(): string {
    return path.join(this.home, CATALOG_FILE_NAME);
  }
}

export default CodexHome;
