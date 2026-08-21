/** Runtime information returned by the main process over IPC. */
export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
}

/** Renderer-facing API exposed by the preload bridge. */
export interface TokiieApi {
  getAppInfo(): Promise<AppInfo>;
  getInstalledSkills(): Promise<InstalledSkill[]>;
  getSkillAgentSelection(skillId: string): Promise<SkillAgentSelection>;
  applySkillAgentSelection(skillId: string, selectedAgents: SkillAgent[]): Promise<InstalledSkill[]>;
  uninstallSkill(skillId: string): Promise<InstalledSkill[]>;
  listCachedRepositories(): Promise<CachedRepository[]>;
  addRepository(input: string, branch?: string): Promise<RepositorySyncResult>;
  installRepositorySkill(request: InstallRepositorySkillRequest): Promise<SkillInstallResult>;
}

/** Filesystem roots whose contents are visible to the supported agents. */
export type SkillRoot = 'amis' | 'claudeCode' | 'hermes' | 'codex' | 'agents';

/** Agents that can load a skill from one of the supported roots. */
export type SkillAgent = 'hermes' | 'claudeCode' | 'codex';

/** A parsed subset of the frontmatter in a skill's SKILL.md. */
export interface SkillManifest {
  skillName: string | null;
  skillDescription: string | null;
}

/** One path at which a deduplicated skill is installed. */
export interface SkillInstallation {
  root: SkillRoot;
  relativePath: string;
  absolutePath: string;
  resolvedPath: string;
  isSymlink: boolean;
  isCanonicalLocation: boolean;
}

/** The visual compatibility state for one agent badge. */
export interface SkillAgentBadge {
  agent: SkillAgent;
  state: 'checked' | 'unchecked';
}

/** Current agent selection for a skill-management dialog. */
export interface SkillAgentSelection {
  skill: InstalledSkill;
  selectedAgents: SkillAgent[];
}

/** A serializable, deduplicated skill record ready for frontend rendering. */
export interface InstalledSkill {
  id: string;
  name: string;
  summary: string | null;
  primaryInstallation: SkillInstallation;
  additionalInstallations: SkillInstallation[];
  installations: SkillInstallation[];
  sourcePath: string;
  hasNameCollision: boolean;
  agentBadges: SkillAgentBadge[];
}

/** A normalized GitHub source displayed by the repository browser. */
export interface RepositoryCoordinate {
  owner: string;
  name: string;
  source: string;
  cloneUrl: string;
}

/** One skill discovered inside a cached repository checkout. */
export interface CachedRepositorySkill {
  id: string;
  name: string;
  summary: string | null;
  description: string | null;
  source: string;
  relativePath: string;
  absolutePath: string;
  isInstalled: boolean;
  installedSkillId: string | null;
}

/** A locally cached repository and the skills currently published by it. */
export interface CachedRepository {
  coordinate: RepositoryCoordinate;
  checkoutPath: string;
  commit: string | null;
  skills: CachedRepositorySkill[];
}

/** Result returned after cloning or refreshing a repository checkout. */
export interface RepositorySyncResult {
  repository: CachedRepository;
  wasRefreshed: boolean;
  newSkillCount: number;
  notice: string;
}

/** Conflict behavior used when a cached skill name already exists. */
export type SkillConflictStrategy = 'replace' | 'keepBoth' | 'skip' | 'reportConflict';

/** Renderer request for installing one skill from a cached repository. */
export interface InstallRepositorySkillRequest {
  source: string;
  relativePath: string;
  enabledAgents: SkillAgent[];
  conflictStrategy: SkillConflictStrategy;
}

/** Result returned after importing and linking a cached skill. */
export interface SkillInstallResult {
  status: 'installed' | 'reused' | 'replaced' | 'keptBoth' | 'skipped' | 'conflict';
  destinationPath: string | null;
  conflictPath: string | null;
  installedSkills: InstalledSkill[];
}
