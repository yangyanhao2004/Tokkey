/** The settings shape this document touches; every other key is carried through. */
interface ClaudeSettings {
  env?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * The model list Tokkey imposes on Claude Code while it holds the settings file.
 *
 * Both fields name gateway routes, not Anthropic model ids: what Claude Code
 * sends as `model` goes to the gateway, so a name it does not serve is a name
 * that fails at the first turn.
 */
export interface ClaudeModelSelection {
  /** The model every session starts on — the cloud model the user connected. */
  model: string;
  /** Every model the picker may offer, in display order. */
  availableModels: readonly string[];
}

/** The settings keys carrying the model choice. */
const MODEL_KEY = 'model';
const AVAILABLE_MODELS_KEY = 'availableModels';
const ENFORCE_AVAILABLE_MODELS_KEY = 'enforceAvailableModels';

/** What Claude Code writes when it has never been configured. */
const EMPTY_SETTINGS: ClaudeSettings = {};

/** Matches the indentation Claude Code itself writes, so a diff stays readable. */
const INDENT_WIDTH = 2;

/**
 * An edit to `settings.json` that keeps every key the editor does not own.
 *
 * Claude's settings file is strict JSON, so unlike Codex's TOML there is no
 * comment or ordering to preserve by hand — parsing and re-serializing loses
 * nothing but whitespace. What still has to be preserved is the *content*: the
 * user's permissions, hooks and model choice all live in this same file, so
 * every write goes through a parse of the current document rather than over it.
 *
 * Immutable, like `CodexTomlDocument`: each edit returns a new document, so a
 * caller can build a rewrite without the half-applied states being observable.
 */
export class ClaudeSettingsDocument {
  private readonly settings: ClaudeSettings;

  /**
   * @param source the current file's text; empty or unparseable is treated as
   *   an absent file, since neither can be edited without discarding it anyway
   */
  constructor(source: string | ClaudeSettings = '') {
    this.settings = typeof source === 'string' ? ClaudeSettingsDocument.parse(source) : source;
  }

  /** The document with one `env` entry set, leaving the rest of `env` alone. */
  setEnvironmentVariable(name: string, value: string): ClaudeSettingsDocument {
    return new ClaudeSettingsDocument({
      ...this.settings,
      env: { ...this.settings.env, [name]: value }
    });
  }

  /**
   * The document restricted to the models the gateway serves.
   *
   * `enforceAvailableModels` is what makes the list binding rather than
   * advisory: without it Claude Code still offers the models it ships with, and
   * picking one sends a name the gateway holds no route for. The user's own
   * `model` is overwritten for the same reason — while the takeover is in force
   * it names a model this gateway cannot answer for — and the backup puts it
   * back at quit.
   */
  setModelSelection(selection: ClaudeModelSelection): ClaudeSettingsDocument {
    return new ClaudeSettingsDocument({
      ...this.settings,
      [MODEL_KEY]: selection.model,
      [AVAILABLE_MODELS_KEY]: [...selection.availableModels],
      [ENFORCE_AVAILABLE_MODELS_KEY]: true
    });
  }

  /** The current value of one `env` entry, or null when it is unset. */
  environmentVariable(name: string): string | null {
    const value = this.settings.env?.[name];
    return typeof value === 'string' ? value : null;
  }

  toString(): string {
    return `${JSON.stringify(this.settings, null, INDENT_WIDTH)}\n`;
  }

  /**
   * The settings this text holds, or an empty document when it holds none.
   *
   * A malformed file is not an error to raise here. The caller's alternative is
   * to refuse the takeover, and refusing would be the wrong call: the original
   * is backed up byte for byte first, so the user gets their file back at quit
   * either way, and meanwhile a valid file is better than a broken one.
   */
  private static parse(source: string): ClaudeSettings {
    if (source.trim() === '') {
      return EMPTY_SETTINGS;
    }
    try {
      const parsed: unknown = JSON.parse(source);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as ClaudeSettings)
        : EMPTY_SETTINGS;
    } catch {
      console.error('[ClaudeConfig] settings.json is not valid JSON; starting from an empty one.');
      return EMPTY_SETTINGS;
    }
  }
}

export default ClaudeSettingsDocument;
