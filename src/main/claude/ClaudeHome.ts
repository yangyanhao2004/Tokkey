import os from 'node:os';
import path from 'node:path';

/**
 * Locates the files the Claude Code CLI reads, the way the CLI itself locates
 * them.
 *
 * `CLAUDE_CONFIG_DIR` wins over `~/.claude` because that is the override the CLI
 * honours; a user who moved their Claude state expects everything that
 * configures Claude to follow, and writing to the wrong home would configure a
 * Claude nobody runs.
 */
export class ClaudeHome {
  private readonly home: string;
  private readonly userConfigDir: string;

  constructor(options: { homeDirectory?: string; claudeHome?: string } = {}) {
    this.home = ClaudeHome.resolve(options);
    this.userConfigDir = ClaudeHome.resolveUserConfigDir(options);
  }

  /** The Claude home this machine uses, without touching the filesystem. */
  static resolve(options: { homeDirectory?: string; claudeHome?: string } = {}): string {
    const explicit = options.claudeHome?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim();
    if (explicit) {
      return path.resolve(ClaudeHome.expandUser(explicit));
    }
    return path.join(options.homeDirectory ?? os.homedir(), '.claude');
  }

  /**
   * The directory holding `.claude.json`, which is not the Claude home.
   *
   * With no override the CLI keeps that file *beside* `~/.claude` rather than
   * inside it, so deriving it from {@link resolve} would aim at
   * `~/.claude/.claude.json` — a file nothing reads. An override moves the
   * whole config directory, and this file goes with it.
   */
  static resolveUserConfigDir(options: { homeDirectory?: string; claudeHome?: string } = {}): string {
    const explicit = options.claudeHome?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim();
    return explicit ? ClaudeHome.resolve(options) : (options.homeDirectory ?? os.homedir());
  }

  /** Expands a leading `~`, which the shell resolves but Node's path helpers do not. */
  private static expandUser(value: string): string {
    if (value === '~') return os.homedir();
    if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
    return value;
  }

  get directory(): string {
    return this.home;
  }

  /** The user-level settings file, whose `env` block Claude applies to every session. */
  get settingsPath(): string {
    return path.join(this.home, 'settings.json');
  }

  /** The CLI's own state file, which is where user-scope MCP servers are declared. */
  get userConfigPath(): string {
    return path.join(this.userConfigDir, '.claude.json');
  }
}

export default ClaudeHome;
