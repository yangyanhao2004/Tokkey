import ClaudeSettingsDocument, { type ClaudeSettings } from './ClaudeSettingsDocument';

/**
 * An edit to `~/.claude.json`, the CLI's own state file, that refuses to guess.
 *
 * The path editing is `ClaudeSettingsDocument`'s, unchanged — same JSON, same
 * "keep every key the editor does not own" contract. What differs is the one
 * thing that cannot be shared: what to do with a file that will not parse.
 * `settings.json` is small and declarative, so treating a broken one as absent
 * costs the user a few settings they can retype. This file is neither: it
 * carries the CLI's onboarding state, per-project history and MCP servers, and
 * starting from `{}` would hand back an empty document in place of all of it.
 *
 * So a malformed file throws instead. The caller is `OwnedConfigFile`, which
 * logs the failure and leaves the file untouched — Tokkey then does not
 * register its tool server, which is a far smaller loss than the alternative.
 */
export class ClaudeUserConfigDocument {
  private readonly document: ClaudeSettingsDocument;

  /**
   * @param source the current file's text; empty is an absent file, malformed
   *   is an error
   * @throws {Error} if `source` is not a JSON object
   */
  constructor(source: string | ClaudeSettingsDocument = '') {
    this.document =
      typeof source === 'string'
        ? new ClaudeSettingsDocument(ClaudeUserConfigDocument.parse(source))
        : source;
  }

  /** The JSON-encoded value at a dotted path, or null if it is unset. */
  getPath(pathSegments: readonly string[]): string | null {
    return this.document.getPath(pathSegments);
  }

  /** The document with a dotted path set to a JSON-encoded value. */
  setPath(pathSegments: readonly string[], jsonValue: string): ClaudeUserConfigDocument {
    return new ClaudeUserConfigDocument(this.document.setPath(pathSegments, jsonValue));
  }

  /** The document with a dotted path removed, pruning a parent it leaves empty. */
  deletePath(pathSegments: readonly string[]): ClaudeUserConfigDocument {
    return new ClaudeUserConfigDocument(this.document.deletePath(pathSegments));
  }

  /**
   * Whether nothing is left at the top level.
   *
   * True only for a file Tokkey itself brought into being on a machine where
   * the CLI had never run: any real `~/.claude.json` has keys of its own, so
   * removing the one Tokkey owns can never make this report empty and can
   * never get the file deleted underneath the user.
   */
  isEmpty(): boolean {
    return this.document.isEmpty();
  }

  toString(): string {
    return this.document.toString();
  }

  /** The object this text holds, or an empty one when the file is absent. */
  private static parse(source: string): ClaudeSettings {
    if (source.trim() === '') {
      return {};
    }
    const parsed: unknown = JSON.parse(source);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('~/.claude.json must hold a JSON object.');
    }
    return parsed as ClaudeSettings;
  }
}

export default ClaudeUserConfigDocument;
