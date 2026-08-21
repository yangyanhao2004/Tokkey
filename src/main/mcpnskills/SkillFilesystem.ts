import os from 'node:os';
import path from 'node:path';
import type { SkillAgent, SkillRoot } from '../../shared/types';

/** Relative filesystem locations used by the app and supported agents. */
export const SKILL_ROOT_RELATIVE_PATHS: Readonly<Record<SkillRoot, string>> = {
  amis: '.amis/skills',
  claudeCode: '.claude/skills',
  hermes: '.hermes/skills',
  codex: '.codex/skills',
  agents: '.agents/skills'
};

export interface SkillFilesystemLayoutOptions {
  homeDirectory?: string;
  rootOverrides?: Partial<Record<SkillRoot, string>>;
}
/** Resolves every skill root and rejects paths that escape that root. */
export class SkillFilesystemLayout {
  private readonly rootPaths: Readonly<Record<SkillRoot, string>>;

  constructor(options: SkillFilesystemLayoutOptions = {}) {
    const homeDirectory = path.resolve(options.homeDirectory ?? os.homedir());
    this.rootPaths = Object.fromEntries(
      (Object.keys(SKILL_ROOT_RELATIVE_PATHS) as SkillRoot[]).map((root) => [
        root,
        path.resolve(options.rootOverrides?.[root] ?? path.join(homeDirectory, SKILL_ROOT_RELATIVE_PATHS[root]))
      ])
    ) as Record<SkillRoot, string>;
  }

  /** Returns the absolute directory for one logical root. */
  getRootPath(root: SkillRoot): string {
    return this.rootPaths[root];
  }

  /** Resolves a relative skill path while preventing directory traversal. */
  getSkillPath(root: SkillRoot, relativePath: string): string {
    const rootPath = this.getRootPath(root);
    const skillPath = path.resolve(rootPath, relativePath);
    const relativeToRoot = path.relative(rootPath, skillPath);
    if (relativeToRoot === '..' || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
      throw new Error(`Skill path escapes ${root} root: ${relativePath}`);
    }
    return skillPath;
  }

  /** Returns the canonical app-owned destination for a skill. */
  getCanonicalSkillPath(relativePath: string): string {
    return this.getSkillPath('amis', relativePath);
  }

  /** Returns all locations an agent may use, in preferred order. */
  getAgentSkillPaths(agent: SkillAgent, relativePath: string): string[] {
    const roots: Record<SkillAgent, SkillRoot[]> = {
      hermes: ['hermes'],
      claudeCode: ['claudeCode'],
      // Prefer the shared Codex root when it already contains the skill.
      codex: ['agents', 'codex']
    };
    return roots[agent].map((root) => this.getSkillPath(root, relativePath));
  }
}
