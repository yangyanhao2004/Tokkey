import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** One catalog row as it is serialized. Codex tolerates unknown keys, so this stays open. */
export type CatalogEntry = Record<string, unknown>;

/** The catalog document. Only `models` is meaningful here; other keys are preserved. */
export interface CatalogDocument {
  models?: CatalogEntry[];
  [key: string]: unknown;
}

/**
 * Reads and atomically writes catalog-shaped JSON.
 *
 * Writes go through a uniquely named temporary file in the same directory and
 * are renamed into place, which is atomic on macOS: a Codex process reading the
 * catalog at the same moment sees either the old file or the new one, never a
 * half-written one.
 *
 * A write whose bytes match what is already on disk is skipped, and the
 * comparison is made on Buffers rather than strings — reading as UTF-8 turns
 * every invalid byte into U+FFFD, so a corrupted file could compare equal to
 * valid content and the repair would be skipped.
 */
export class CatalogFileStore {
  /** The parsed document, or null when it is absent, unparseable, or shapeless. */
  read(filePath: string): CatalogDocument | null {
    try {
      if (!existsSync(filePath)) return null;
      const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
      const document = parsed as CatalogDocument | null;
      return document && Array.isArray(document.models) ? document : null;
    } catch {
      // Another tool's file, a truncated write, a hand edit: rebuilt from scratch.
      return null;
    }
  }

  /** Writes `content` unless it is already there; reports whether it wrote. */
  writeIfChanged(filePath: string, content: string): boolean {
    const current = this.readBytes(filePath);
    if (current !== null && current.equals(Buffer.from(content, 'utf8'))) {
      return false;
    }
    this.atomicWrite(filePath, content);
    return true;
  }

  private readBytes(filePath: string): Buffer | null {
    try {
      return readFileSync(filePath);
    } catch {
      return null;
    }
  }

  private atomicWrite(filePath: string, content: string): void {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const unique = createHash('sha256')
      .update(`${process.pid}:${Date.now()}:${Math.random()}`)
      .digest('hex')
      .slice(0, 12);
    const temporaryPath = `${filePath}.${unique}.tmp`;
    try {
      // 0600: the catalog carries provider metadata, so keep it owner-only.
      writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
      renameSync(temporaryPath, filePath);
    } catch (error: unknown) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Best effort: a cleanup failure must never mask the real one.
      }
      throw error;
    }
  }
}

/**
 * Renders the catalog with a canonical key order.
 *
 * Without it the generator is not idempotent. Routed rows are cloned from a
 * native row, so the second run finds the strict fields the first run appended
 * already present: the same keys land in a different order, the bytes differ,
 * and the file is rewritten although nothing changed. Codex treats a newer
 * catalog mtime as "this session's model list is stale", so that churn has a
 * real cost. Deterministic ordering makes an unchanged model set produce
 * byte-identical output forever.
 */
export class CatalogSerializer {
  /** Identity fields first, so a hand-read catalog stays scannable. */
  private static readonly LEAD_KEYS = ['slug', 'display_name', 'description', 'priority', 'visibility'];

  /** The document as text, ending in the trailing newline Codex's own writer emits. */
  render(document: CatalogDocument): string {
    return `${JSON.stringify(this.canonicalize(document), null, 2)}\n`;
  }

  /** Reorders object keys recursively. Array order is left alone: it is semantic. */
  private canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.canonicalize(item));
    }
    if (value === null || typeof value !== 'object') {
      return value;
    }
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source);
    const lead = CatalogSerializer.LEAD_KEYS.filter((key) => keys.includes(key));
    const rest = keys.filter((key) => !lead.includes(key)).sort();
    const ordered: Record<string, unknown> = {};
    for (const key of [...lead, ...rest]) {
      ordered[key] = this.canonicalize(source[key]);
    }
    return ordered;
  }
}
