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
    return this.setRootKeyRaw(key, JSON.stringify(value));
  }

  /**
   * Sets one root-level key to an already-rendered right-hand side, verbatim.
   *
   * The plain-value {@link setRootKey} always JSON-encodes; this is what lets a
   * caller restore exactly the RHS text a key held before Tokkey touched it,
   * whatever TOML type that was, without re-encoding it as a string.
   */
  setRootKeyRaw(key: string, rawValue: string): CodexTomlDocument {
    const rendered = `${key} = ${rawValue}`;
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

  /** The raw right-hand side of a root-level key, or null if it is not set there. */
  getRootKey(key: string): string | null {
    const assignment = new RegExp(`^\\s*${CodexTomlDocument.escape(key)}\\s*=\\s*(.*)$`);
    for (const line of this.text.split('\n')) {
      if (CodexTomlDocument.readHeaderPath(line)) break;
      const match = assignment.exec(line);
      if (match) return match[1]!.trim();
    }
    return null;
  }

  /** Drops one root-level key's line entirely, the undo of {@link setRootKey}. */
  removeRootKey(key: string): CodexTomlDocument {
    const assignment = new RegExp(`^\\s*${CodexTomlDocument.escape(key)}\\s*=`);
    const lines = this.text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (CodexTomlDocument.readHeaderPath(line)) break;
      if (!assignment.test(line)) continue;
      // A key inserted just before the first table left a blank separator line
      // behind it (see the insert branch of `setRootKeyRaw`); drop that too, or
      // removing only the key would leave an orphaned gap before the table.
      const next = lines[index + 1];
      const dropsSeparator = next === '' && CodexTomlDocument.readHeaderPath(lines[index + 2] ?? '') !== null;
      const kept = [...lines.slice(0, index), ...lines.slice(index + (dropsSeparator ? 2 : 1))];
      return new CodexTomlDocument(kept.join('\n'));
    }
    return this;
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

  /** The raw text of one table, header through its last line, or null if it is absent. */
  getTable(tablePath: readonly string[]): string | null {
    let isInside = false;
    const collected: string[] = [];
    for (const line of this.text.split('\n')) {
      const headerPath = CodexTomlDocument.readHeaderPath(line);
      if (headerPath) {
        isInside = CodexTomlDocument.isUnderPath(headerPath, tablePath);
      }
      if (isInside) collected.push(line);
    }
    if (collected.length === 0) return null;
    const joined = collected.join('\n').replace(/\s+$/, '');
    return joined.length === 0 ? null : joined;
  }

  /** Replaces one table wholesale with already-rendered text, or drops it when `renderedText` is null. */
  setTable(tablePath: readonly string[], renderedText: string | null): CodexTomlDocument {
    const cleared = this.removeTable(tablePath);
    return renderedText === null ? cleared : cleared.insertTable(renderedText);
  }

  /** Appends one table, keeping exactly one blank line before it. */
  appendTable(tablePath: readonly string[], entries: ReadonlyArray<[string, string | boolean]>): CodexTomlDocument {
    return this.insertTable(CodexTomlDocument.renderTable(tablePath, entries));
  }

  /** Renders a table's header and entries, with no surrounding document context. */
  static renderTable(tablePath: readonly string[], entries: ReadonlyArray<[string, string | boolean]>): string {
    const header = `[${tablePath.map((segment) => CodexTomlDocument.renderKey(segment)).join('.')}]`;
    const lines = entries.map(
      ([key, value]) => `${key} = ${typeof value === 'boolean' ? String(value) : JSON.stringify(value)}`
    );
    return [header, ...lines].join('\n');
  }

  /** Appends an already-rendered table block, keeping exactly one blank line before it. */
  private insertTable(renderedText: string): CodexTomlDocument {
    const separator = this.text.length === 0 ? '' : this.text.endsWith('\n\n') ? '' : this.text.endsWith('\n') ? '\n' : '\n\n';
    return new CodexTomlDocument(`${this.text}${separator}${renderedText}\n`);
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
