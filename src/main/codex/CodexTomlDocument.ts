/**
 * Line-level edits to Codex's `config.toml`.
 *
 * The document is never re-serialized from a parse. That file is hand-written
 * and holds comments, formatting, and settings Tokkey knows nothing about, all
 * of which a round trip through a TOML library would silently discard. Every
 * edit here therefore touches only the lines it owns and leaves the rest byte
 * for byte as the user wrote it.
 *
 * That is safe to do line by line because a TOML table runs from its header to
 * the next header, and a root-level key can only appear before the first one.
 */
export class CodexTomlDocument {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  toString(): string {
    return this.text;
  }

  /**
   * Sets one root-level key, replacing the line that already assigns it.
   *
   * A new key is inserted just before the first table header rather than
   * appended: after a header the assignment would belong to that table, which
   * is a different key with a different meaning.
   */
  setRootKey(key: string, value: string): CodexTomlDocument {
    const rendered = `${key} = ${JSON.stringify(value)}`;
    const lines = this.text.split('\n');
    const assignment = new RegExp(`^\\s*${CodexTomlDocument.escape(key)}\\s*=`);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (CodexTomlDocument.readHeaderPath(line)) break;
      if (!assignment.test(line)) continue;
      const replaced = [...lines.slice(0, index), rendered, ...lines.slice(index + 1)];
      return new CodexTomlDocument(replaced.join('\n'));
    }

    const headerIndex = lines.findIndex((line) => CodexTomlDocument.readHeaderPath(line) !== null);
    if (headerIndex === -1) {
      return new CodexTomlDocument(CodexTomlDocument.appendLine(this.text, rendered));
    }
    const inserted = [...lines.slice(0, headerIndex), rendered, '', ...lines.slice(headerIndex)];
    return new CodexTomlDocument(inserted.join('\n'));
  }

  /** Drops one table and every table nested under it. */
  removeTable(tablePath: readonly string[]): CodexTomlDocument {
    let isDropping = false;
    const kept = this.text.split('\n').filter((line) => {
      const headerPath = CodexTomlDocument.readHeaderPath(line);
      if (headerPath) {
        isDropping = CodexTomlDocument.isUnderPath(headerPath, tablePath);
      }
      return !isDropping;
    });
    // Dropping the last table leaves the blank lines that separated it behind.
    const remaining = kept.join('\n').replace(/\s+$/, '');
    return new CodexTomlDocument(remaining.length === 0 ? '' : `${remaining}\n`);
  }

  /** Appends one table, keeping exactly one blank line before it. */
  appendTable(tablePath: readonly string[], entries: ReadonlyArray<[string, string | boolean]>): CodexTomlDocument {
    const header = `[${tablePath.map((segment) => CodexTomlDocument.renderKey(segment)).join('.')}]`;
    const lines = entries.map(
      ([key, value]) => `${key} = ${typeof value === 'boolean' ? String(value) : JSON.stringify(value)}`
    );
    const separator = this.text.length === 0 ? '' : this.text.endsWith('\n\n') ? '' : this.text.endsWith('\n') ? '\n' : '\n\n';
    return new CodexTomlDocument(`${this.text}${separator}${[header, ...lines].join('\n')}\n`);
  }

  /** A bare key where TOML allows one, quoted where it does not. */
  private static renderKey(segment: string): string {
    return /^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment);
  }

  private static escape(key: string): string {
    return key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private static appendLine(text: string, line: string): string {
    if (text.length === 0) return `${line}\n`;
    return text.endsWith('\n') ? `${text}${line}\n` : `${text}\n${line}\n`;
  }

  /** Whether a header names this table or one nested inside it. */
  private static isUnderPath(candidate: readonly string[], tablePath: readonly string[]): boolean {
    return (
      candidate.length >= tablePath.length &&
      tablePath.every((segment, index) => candidate[index] === segment)
    );
  }

  /** The dotted key a `[table]` or `[[table]]` line opens, or null for any other line. */
  static readHeaderPath(line: string): string[] | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
      return null;
    }
    const inner =
      trimmed.startsWith('[[') && trimmed.endsWith(']]') ? trimmed.slice(2, -2) : trimmed.slice(1, -1);
    return CodexTomlDocument.splitKeyPath(inner);
  }

  /** Splits a dotted key into segments, so a quoted name may hold dots itself. */
  private static splitKeyPath(inner: string): string[] | null {
    let segments: string[] = [];
    let current = '';
    let openQuote: '"' | '\'' | null = null;
    for (let index = 0; index < inner.length; index += 1) {
      const character = inner[index];
      if (openQuote === null && (character === '"' || character === '\'')) {
        openQuote = character;
      } else if (openQuote !== null && character === openQuote) {
        openQuote = null;
      } else if (openQuote === '"' && character === '\\') {
        // Only the following character is consumed; escapes stay as written,
        // which is enough to compare a name against the scanner's reading.
        current += inner[index + 1] ?? '';
        index += 1;
      } else if (openQuote === null && character === '.') {
        segments = [...segments, current.trim()];
        current = '';
      } else {
        current += character;
      }
    }
    if (openQuote !== null) {
      return null;
    }
    segments = [...segments, current.trim()];
    return segments.every((segment) => segment.length > 0) ? segments : null;
  }
}

export default CodexTomlDocument;
