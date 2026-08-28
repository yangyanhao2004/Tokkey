import path from 'node:path';
import type { InstalledSkill } from '../../shared/types';
import { FileSkillContentHasher, type SkillContentHashing } from './SkillContentHasher';

/** Matches cached skill folders against installed catalog entries by name and manifest bytes. */
export class CachedInstalledSkillMatcher {
  private readonly contentHasher: SkillContentHashing;

  constructor(contentHasher: SkillContentHashing = new FileSkillContentHasher()) {
    this.contentHasher = contentHasher;
  }

  /** Runs one batch pass and avoids hashing names that cannot match. */
  findMatches(cachedPaths: Iterable<string>, installedSkills: InstalledSkill[]): Map<string, InstalledSkill> {
    const installedByName = this.groupInstalledSkills(installedSkills);
    const contentHashCache = new Map<string, string | null>();
    const matches = new Map<string, InstalledSkill>();
    for (const cachedPath of cachedPaths) {
      const candidates = installedByName.get(path.basename(cachedPath));
      if (!candidates || candidates.length === 0) {
        continue;
      }
      const cachedHash = this.hashManifest(cachedPath, contentHashCache);
      if (cachedHash === null) {
        continue;
      }
      const match = candidates.find((skill) => {
        const installedHash = this.hashManifest(skill.sourcePath, contentHashCache);
        return installedHash !== null && installedHash === cachedHash;
      });
      if (match) {
        matches.set(path.resolve(cachedPath), match);
      }
    }
    return matches;
  }

  /** Looks up one cached folder using the same batch-safe comparison rule. */
  findMatch(cachedPath: string, installedSkills: InstalledSkill[]): InstalledSkill | null {
    return this.findMatches([cachedPath], installedSkills).get(path.resolve(cachedPath)) ?? null;
  }

  /** Hashes only SKILL.md and caches unreadable files as null for the current batch. */
  hashManifest(skillPath: string, cache: Map<string, string | null> = new Map()): string | null {
    const normalizedPath = path.resolve(skillPath);
    if (cache.has(normalizedPath)) {
      return cache.get(normalizedPath) ?? null;
    }
    const hash = this.contentHasher.contentHash(normalizedPath);
    cache.set(normalizedPath, hash);
    return hash;
  }

  private groupInstalledSkills(installedSkills: InstalledSkill[]): Map<string, InstalledSkill[]> {
    const grouped = new Map<string, InstalledSkill[]>();
    for (const skill of installedSkills) {
      const group = grouped.get(skill.name) ?? [];
      group.push(skill);
      grouped.set(skill.name, group);
    }
    return grouped;
  }
}

/**
 * The same rule under the name the upload flow uses: a folder about to be
 * uploaded is a duplicate only when its folder name matches an installed
 * skill's folder name — namespace path ignored, so `research/arxiv` blocks
 * uploading `arxiv` — *and* both SKILL.md files hash equal. Same name with
 * different bytes is an update the user may want, so it is allowed through to
 * the conflict prompt; same bytes under a different name is a second skill.
 */
export class LocalSkillDuplicateDetector extends CachedInstalledSkillMatcher {
  /** Batch form, hashing each installed skill at most once per pass. */
  findDuplicates(candidatePaths: Iterable<string>, installedSkills: InstalledSkill[]): Map<string, InstalledSkill> {
    return this.findMatches(candidatePaths, installedSkills);
  }

  /** Single-folder form used by the upload flow's preflight check. */
  findDuplicate(candidatePath: string, installedSkills: InstalledSkill[]): InstalledSkill | null {
    return this.findMatch(candidatePath, installedSkills);
  }
}

export default CachedInstalledSkillMatcher;
