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
  /**
   * The model every session starts on, or null to leave Claude Code's own
   * `model` setting untouched. Null is how a model can be offered in
   * `availableModels` without being forced on the user — the routed model, in
   * particular, is never worth silently switching an existing session onto.
   */
  model: string | null;
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
   * `model` is overwritten the same way whenever `selection.model` is given —
   * while the takeover is in force it would otherwise name a model this gateway
   * cannot answer for — and the backup puts it back at quit. A null
   * `selection.model` leaves the existing `model` key alone instead, which is
   * how an entry can be added to the picker without moving the user onto it.
   */
  setModelSelection(selection: ClaudeModelSelection): ClaudeSettingsDocument {
    const { model, availableModels } = selection;
    return new ClaudeSettingsDocument({
      ...this.settings,
      ...(model !== null ? { [MODEL_KEY]: model } : {}),
      [AVAILABLE_MODELS_KEY]: [...availableModels],
      [ENFORCE_AVAILABLE_MODELS_KEY]: true
    });
  }

  /** The current value of one `env` entry, or null when it is unset. */
  environmentVariable(name: string): string | null {
    const value = this.settings.env?.[name];
    return typeof value === 'string' ? value : null;
  }

  /** The JSON-encoded value at a dotted path (e.g. `['env', 'ANTHROPIC_BASE_URL']`), or null if unset. */
  getPath(pathSegments: readonly string[]): string | null {
    let node: unknown = this.settings;
    for (const segment of pathSegments) {
      if (typeof node !== 'object' || node === null || Array.isArray(node)) return null;
      node = (node as Record<string, unknown>)[segment];
    }
    return node === undefined ? null : JSON.stringify(node);
  }

  /** The document with a dotted path set to a JSON-encoded value, creating intermediate objects as needed. */
  setPath(pathSegments: readonly string[], jsonValue: string): ClaudeSettingsDocument {
    return new ClaudeSettingsDocument(
      ClaudeSettingsDocument.withPath(this.settings, pathSegments, JSON.parse(jsonValue))
    );
  }

  /** The document with a dotted path removed entirely, leaving its siblings alone. */
  deletePath(pathSegments: readonly string[]): ClaudeSettingsDocument {
    return new ClaudeSettingsDocument(ClaudeSettingsDocument.withoutPath(this.settings, pathSegments));
  }

  /** Whether every top-level key is gone, the JSON equivalent of an empty file. */
  isEmpty(): boolean {
    return Object.keys(this.settings).length === 0;
  }

  private static withPath(node: ClaudeSettings, pathSegments: readonly string[], value: unknown): ClaudeSettings {
    const [key, ...rest] = pathSegments;
    if (key === undefined) return node;
    if (rest.length === 0) return { ...node, [key]: value };
    const child = typeof node[key] === 'object' && node[key] !== null ? (node[key] as ClaudeSettings) : {};
    return { ...node, [key]: ClaudeSettingsDocument.withPath(child, rest, value) };
  }

  /**
   * Removes a dotted path, and cascades the removal up through any parent
   * object that a nested delete leaves with no keys of its own.
   *
   * A parent that is left empty by this specific delete was never meaningful
   * on its own — nothing here writes an object just to leave it standing empty
   * — so pruning it is what lets `env` disappear once `ANTHROPIC_BASE_URL` is
   * the last thing gone from it, the same way it would if Tokkey had never
   * added it in the first place.
   */
  private static withoutPath(node: ClaudeSettings, pathSegments: readonly string[]): ClaudeSettings {
    const [key, ...rest] = pathSegments;
    if (key === undefined) return node;
    if (rest.length === 0) {
      const remainder = { ...node };
      delete remainder[key];
      return remainder;
    }
    const child = node[key];
    if (typeof child !== 'object' || child === null || Array.isArray(child)) return node;
    const prunedChild = ClaudeSettingsDocument.withoutPath(child as ClaudeSettings, rest);
    const remainder = { ...node };
    if (Object.keys(prunedChild).length === 0) {
      delete remainder[key];
    } else {
      remainder[key] = prunedChild;
    }
    return remainder;
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
