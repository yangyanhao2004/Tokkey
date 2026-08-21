import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  InstalledSkill,
  SkillAgent,
  SkillInstallation,
  SkillRoot
} from '../../shared/types';
import type { DiscoveredSkill, SkillFileId } from './SkillCatalogScanner';

/** The scanner roots, ordered by preferred installation priority. */
export const SKILL_ROOTS: readonly SkillRoot[] = [
  'amis',
  'claudeCode',
  'codex',
  'agents'
];

const MANIFEST_FILE_NAME = 'SKILL.md';
const AGENT_BADGE_ORDER: readonly SkillAgent[] = ['claudeCode', 'codex'];

/** Agents that read each root. The Amis root is an app-owned source only. */
const ROOT_AGENTS: Readonly<Record<SkillRoot, readonly SkillAgent[]>> = {
  amis: [],
  claudeCode: ['claudeCode'],
  codex: ['codex'],
  agents: ['codex']
};

/** Provides a stable fingerprint for a skill's SKILL.md. */
export interface SkillContentHashing {
  contentHash(absolutePath: string): string | null;
}

/** Computes the SHA-256 fingerprint used only for physically distinct copies. */
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

/** Collapses same-name discoveries only when identity or manifest bytes prove sameness. */
export class SkillDeduplicator {
  private readonly contentHasher: SkillContentHashing;

  constructor(contentHasher: SkillContentHashing = new FileSkillContentHasher()) {
    this.contentHasher = contentHasher;
  }

  /** Returns stable, root-priority-ordered installed skill cards. */
  deduplicate(discovered: DiscoveredSkill[]): InstalledSkill[] {
    const groups = new Map<string, DiscoveredSkill[]>();
    for (const entry of discovered) {
      const group = groups.get(entry.name) ?? [];
      group.push(entry);
      groups.set(entry.name, group);
    }

    const catalog: InstalledSkill[] = [];
    for (const [name, entries] of groups) {
      const clusters = this.clusterByContent(this.sortByPriority(entries));
      const hasNameCollision = clusters.length > 1;
      for (const cluster of clusters) {
        const primary = cluster.entries[0];
        if (!primary) {
          continue;
        }
        const installations = cluster.entries.map((entry) => this.makeInstallation(entry));
        catalog.push({
          id: hasNameCollision ? `${name}#${this.discriminator(cluster, primary)}` : name,
          name,
          summary: primary.manifest.skillDescription,
          primaryInstallation: installations[0],
          additionalInstallations: installations.slice(1),
          installations,
          sourcePath: primary.resolvedPath,
          hasNameCollision,
          agentBadges: this.makeAgentBadges(installations)
        });
      }
    }
    return catalog.sort((left, right) => this.compareCatalogItems(left, right));
  }

  /** Partitions by inode first, then hashes only when multiple physical copies remain. */
  private clusterByContent(entries: DiscoveredSkill[]): SkillCluster[] {
    const physicalCopies = this.partitionByFileId(entries);
    if (physicalCopies.length <= 1) {
      return physicalCopies.map((copy) => ({ contentHash: null, entries: copy }));
    }

    const clusters: SkillCluster[] = [];
    const clusterIndexByHash = new Map<string, number>();
    for (const copy of physicalCopies) {
      const representative = copy[0];
      if (!representative) {
        continue;
      }
      const hash = this.contentHasher.contentHash(representative.absolutePath);
      if (hash === null) {
        clusters.push({ contentHash: null, entries: copy });
        continue;
      }
      const existingIndex = clusterIndexByHash.get(hash);
      if (existingIndex === undefined) {
        clusterIndexByHash.set(hash, clusters.length);
        clusters.push({ contentHash: hash, entries: copy });
      } else {
        clusters[existingIndex].entries.push(...copy);
      }
    }

    for (const cluster of clusters) {
      cluster.entries = this.sortByPriority(cluster.entries);
    }
    return clusters.sort((left, right) => this.compareDiscovered(left.entries[0], right.entries[0]));
  }

  /** Entries with no inode are deliberately kept as separate physical copies. */
  private partitionByFileId(entries: DiscoveredSkill[]): DiscoveredSkill[][] {
    const partitions: DiscoveredSkill[][] = [];
    const partitionIndexByFileId = new Map<SkillFileId, number>();
    for (const entry of entries) {
      if (entry.fileId === null) {
        partitions.push([entry]);
        continue;
      }
      const existingIndex = partitionIndexByFileId.get(entry.fileId);
      if (existingIndex === undefined) {
        partitionIndexByFileId.set(entry.fileId, partitions.length);
        partitions.push([entry]);
      } else {
        partitions[existingIndex].push(entry);
      }
    }
    return partitions.map((partition) => this.sortByPriority(partition));
  }

  private makeInstallation(entry: DiscoveredSkill): SkillInstallation {
    return {
      root: entry.root,
      relativePath: entry.relativePath,
      absolutePath: entry.absolutePath,
      resolvedPath: entry.resolvedPath,
      isSymlink: entry.isSymlink,
      isCanonicalLocation: !entry.isSymlink
    };
  }

  private makeAgentBadges(installations: SkillInstallation[]) {
    const installedAgents = new Set<SkillAgent>();
    for (const installation of installations) {
      for (const agent of ROOT_AGENTS[installation.root]) {
        installedAgents.add(agent);
      }
    }
    return AGENT_BADGE_ORDER.map((agent) => ({
      agent,
      state: installedAgents.has(agent) ? ('checked' as const) : ('unchecked' as const)
    }));
  }

  private discriminator(cluster: SkillCluster, primary: DiscoveredSkill): string {
    return cluster.contentHash?.slice(0, 12) ?? `${primary.root}/${primary.relativePath}`;
  }

  private sortByPriority(entries: DiscoveredSkill[]): DiscoveredSkill[] {
    return [...entries].sort((left, right) => this.compareDiscovered(left, right));
  }

  private compareDiscovered(left: DiscoveredSkill | undefined, right: DiscoveredSkill | undefined): number {
    if (!left || !right) {
      return left ? -1 : right ? 1 : 0;
    }
    const priorityDifference = SKILL_ROOTS.indexOf(left.root) - SKILL_ROOTS.indexOf(right.root);
    return priorityDifference !== 0
      ? priorityDifference
      : left.relativePath.localeCompare(right.relativePath);
  }

  private compareCatalogItems(left: InstalledSkill, right: InstalledSkill): number {
    const nameComparison = left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: 'base'
    });
    return nameComparison !== 0 ? nameComparison : left.id.localeCompare(right.id);
  }
}

interface SkillCluster {
  contentHash: string | null;
  entries: DiscoveredSkill[];
}
