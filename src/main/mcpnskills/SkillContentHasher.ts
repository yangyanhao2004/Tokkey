import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const MANIFEST_FILE_NAME = 'SKILL.md';

/** Provides a stable fingerprint for a skill's SKILL.md. */
export interface SkillContentHashing {
  contentHash(absolutePath: string): string | null;
}

/** Computes the SHA-256 fingerprint shared by installed and cached skill comparisons. */
export class FileSkillContentHasher implements SkillContentHashing {
  /** Hashes SKILL.md bytes and returns null when the file cannot be read. */
  contentHash(absolutePath: string): string | null {
    try {
      return createHash('sha256')
        .update(readFileSync(path.join(absolutePath, MANIFEST_FILE_NAME)))
        .digest('hex');
    } catch {
      return null;
    }
  }
}

export default FileSkillContentHasher;
