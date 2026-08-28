/** Runtime information returned by the main process over IPC. */
export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
}

/** The coding agents Tokiie detects, each named after its executable. */
export type CodingAgent = 'codex' | 'claude';

/** One agent's presence on this machine, as a PATH lookup found it. */
export interface AgentInstallation {
  agent: CodingAgent;
  installed: boolean;
  executablePath: string | null;
  /** Why detection found nothing; null whenever the agent is installed. */
  error: string | null;
}

/** Supported local configuration sources for installed MCP servers. */
export type McpAgent = 'claudeCode' | 'codex';

/** Transport names used by the normalized MCP catalog. */
export type McpConnectionType = 'stdio' | 'sse' | 'streamable_http';

/** One MCP definition after an agent adapter has normalized its source format. */
export interface McpServerConfiguration {
  name: string;
  connectionType: McpConnectionType;
  command: string | null;
  arguments: string[];
  environment: Record<string, string>;
  url: string | null;
}

/** Wizard fields accepted by the shared MCP configuration preparer. */
export interface McpWizardDraft {
  mode: 'wizard';
  name: string;
  connectionType: McpConnectionType;
  commandLine: string;
  environmentText: string;
  url: string;
}

/** Full JSON input accepted by the shared MCP configuration preparer. */
export interface McpJsonDraft {
  mode: 'json';
  jsonText: string;
}

/** Either editor representation used to create one canonical MCP document. */
export type McpConfigurationDraft = McpWizardDraft | McpJsonDraft;

/** Non-throwing result used by the renderer for live validation. */
export interface McpConfigurationPreparation {
  isValid: boolean;
  canonicalJson: string | null;
  configuration: McpServerConfiguration | null;
  error: string | null;
}

/** One all-or-nothing request to persist an MCP for selected agents. */
export interface ApplyMcpConfigurationRequest {
  configurationJson: string;
  selectedAgents: McpAgent[];
}

/** A server discovered in one or more agent configuration files. */
export interface InstalledMcp {
  id: string;
  name: string;
  title: string;
  connectionType: McpConnectionType;
  command: string | null;
  arguments: string[];
  environment: Record<string, string>;
  url: string | null;
  agents: McpAgent[];
  badges: McpAgentBadge[];
  hasNameCollision: boolean;
  definition: string;
}

/** The visual state for one agent badge on an MCP card. */
export interface McpAgentBadge {
  agent: McpAgent;
  state: 'checked' | 'unchecked' | 'disabled';
}

/** A configuration entry that an adapter could not represent safely. */
export interface McpSkippedEntry {
  name: string;
  reason: string;
}

/** Parsed output from one agent file, before cross-agent deduplication. */
export interface McpAgentConfigurationReadout {
  servers: McpServerConfiguration[];
  skipped: McpSkippedEntry[];
}

/** A file-level MCP scan failure shown below the catalog. */
export interface McpCatalogFailure {
  agent: McpAgent;
  message: string;
}

/** Complete result returned by one local catalog scan. */
export interface McpCatalogScan {
  servers: InstalledMcp[];
  failures: McpCatalogFailure[];
}

/** The live resources the "This Mac" card gauges. */
export type HostResourceId = 'memory' | 'disk';

/**
 * One capacity bar on the "This Mac" card, fully computed by the main process.
 * The renderer draws `usedFraction` and prints the two strings; it never sees
 * bytes and never does arithmetic.
 */
export interface HostResourceGauge {
  id: HostResourceId;
  /** Caption beside the reading, e.g. "Memory used". */
  label: string;
  /** Share of the resource in use, clamped to 0..1. */
  usedFraction: number;
  /** Whole-percent reading, e.g. "42%". */
  percentText: string;
  /** Line under the bar, e.g. "7.3 GB free of 18 GB". */
  detailText: string;
}

/** Static hardware and system description of the Mac the app runs on. */
export interface HostMachineInfo {
  /** Marketing model name, e.g. "MacBook Air (13-inch, M5)". */
  deviceModel: string;
  /** CPU brand string, e.g. "Apple M5". */
  chip: string;
  /** User-facing macOS version, e.g. "26.4" — not the Darwin kernel version. */
  osVersion: string;
  totalMemoryBytes: number;
  /** The card's subtitle, already joined with the middot the design uses. */
  detailText: string;
}

/** Everything the "This Mac" card renders in one reading. */
export interface HostSnapshot {
  machine: HostMachineInfo;
  /** Empty only while every probe has failed with no earlier reading to keep. */
  gauges: HostResourceGauge[];
}

/** Renderer-facing API exposed by the preload bridge. */
export interface TokiieApi {
  getAppInfo(): Promise<AppInfo>;
  getHostSnapshot(): Promise<HostSnapshot>;
  detectAgents(): Promise<AgentInstallation[]>;
  getInstalledMcps(): Promise<McpCatalogScan>;
  scanInstalledMcps(): Promise<McpCatalogScan>;
  prepareMcpConfiguration(draft: McpConfigurationDraft): McpConfigurationPreparation;
  applyMcpConfiguration(request: ApplyMcpConfigurationRequest): Promise<McpCatalogScan>;
  applyMcpAgentSelection(mcpId: string, selectedAgents: McpAgent[]): Promise<McpCatalogScan>;
  getInstalledSkills(): Promise<InstalledSkill[]>;
  getSkillAgentSelection(skillId: string): Promise<SkillAgentSelection>;
  applySkillAgentSelection(skillId: string, selectedAgents: SkillAgent[]): Promise<InstalledSkill[]>;
  uninstallSkill(skillId: string): Promise<InstalledSkill[]>;
  uploadSkillFolder(): Promise<SkillUploadResult>;
  resolveSkillUploadConflict(
    pendingUploadId: string,
    choice: SkillUploadConflictChoice
  ): Promise<SkillUploadResult>;
  listCachedRepositories(): Promise<CachedRepository[]>;
  addRepository(input: string, branch?: string): Promise<RepositorySyncResult>;
  installRepositorySkill(request: InstallRepositorySkillRequest): Promise<SkillInstallResult>;
  fetchSkillsPage(page: number): Promise<SkillsShPage>;
  searchSkills(query: string): Promise<SkillsShSkill[]>;
  searchSkillsPage(query: string, page: number): Promise<SkillsShPage>;
  refreshSkillsInstalledStatus(): Promise<void>;
  getSkillCardState(listing: SkillsShSkill): Promise<SkillsShCardState>;
  getSkillCardStates(listings: SkillsShSkill[]): Promise<SkillsShCardState[]>;
  installSkill(request: SkillsShInstallRequest): Promise<SkillsShInstallResult>;
  listLocalModels(request?: LocalModelCatalogRequest): Promise<LocalModelCatalogScan>;
  refreshLocalModels(request?: LocalModelCatalogRequest): Promise<LocalModelCatalogScan>;
  startLocalModelDownload(modelId: string, request?: LocalModelCatalogRequest): Promise<LocalModelCatalogScan>;
  cancelLocalModelDownload(modelId: string, request?: LocalModelCatalogRequest): Promise<LocalModelCatalogScan>;
  deleteLocalModel(modelId: string, request?: LocalModelCatalogRequest): Promise<LocalModelCatalogScan>;
  deployLocalModel(modelId: string, request?: LocalModelCatalogRequest): Promise<LocalModelCatalogScan>;
  listInstalledLocalModels(): Promise<InstalledLocalModel[]>;
  removeInstalledLocalModel(modelId: string): Promise<InstalledLocalModel[]>;
  listCloudModelCards(): Promise<CloudModelCard[]>;
  connectCloudModel(cardId: string): Promise<CloudModelConnection>;
}

/**
 * Upstream routing mode persisted in `model_profiles.supported_api_formats`.
 * `AMIS_GATEWAY_MANAGED` means the gateway owns protocol translation, so no
 * upstream wire format is selected by the user.
 */
export type CloudApiFormat =
  | 'AMIS_GATEWAY_MANAGED'
  | 'openai_chat'
  | 'openai_responses'
  | 'anthropic';

/** What kind of endpoint one model profile fronts. */
export type ModelProfileType = 'cloud' | 'local' | 'hub' | 'tokenbox';

/**
 * One gateway route materialized for a (profile, API format) pair.
 *
 * The field names are the JSON keys already stored in `model_profiles.litellm_links`
 * by the Swift app that shares this database, so `modelID` keeps its spelling
 * instead of following the local `modelId` convention.
 */
export interface LiteLlmModelLink {
  apiFormat: CloudApiFormat;
  modelName: string;
  modelID: string;
}

/** One saved model connection; mirrors a row of the `model_profiles` table. */
export interface ModelProfile {
  id: string;
  name: string;
  provider: string;
  apiUrl: string;
  apiKey: string | null;
  modelName: string;
  type: ModelProfileType;
  supportedApiFormats: CloudApiFormat[];
  litellmLinks: LiteLlmModelLink[];
  /** Unix timestamp in seconds, stored as SQLite REAL for exact roundtrips. */
  createdAt: number;
}

/** A hardcoded cloud offering the user can connect to with one click. */
export interface CloudModelCard {
  /** Fixed UUID; also the id of the model profile this card connects to. */
  id: string;
  provider: string;
  modelName: string;
  url: string;
  /** LiteLLM provider prefix applied to `modelName`, e.g. `openai`. */
  prefix: string;
  apiKey: string;
}

/**
 * What one connect attempt did. `alreadyConnected` means the profile and its
 * gateway route both survived, so nothing was created or written.
 */
export type CloudModelConnectionStatus = 'connected' | 'reconnected' | 'alreadyConnected';

/** Result of connecting one cloud model card. */
export interface CloudModelConnection {
  card: CloudModelCard;
  profile: ModelProfile;
  status: CloudModelConnectionStatus;
}

/** Supported catalog providers exposed by the remote catalog service. */
export type LocalModelProvider = string;

/** A single concrete model artifact shown in the local catalog. */
export interface LocalModelDescriptor {
  id: string;
  provider: string;
  series: string;
  name: string;
  fileName: string;
  sizeBytes: number | null;
  requiredRamBytes: number | null;
  huggingFaceUrl: string | null;
  modelScopeUrl: string | null;
  downloadable: boolean;
  sourceError: string | null;
}

/** Model lifecycle state projected by the main-process manager. */
export type LocalModelLifecycle =
  | 'downloadable'
  | 'pendingArtifact'
  | 'downloading'
  | 'downloaded'
  | 'downloadFailed'
  | 'deployPreparing'
  | 'deployed'
  | 'deployStopping'
  | 'deployFailed'
  | 'unsupported';

/** UI-ready model row with lifecycle and transfer information. */
export interface LocalModelRow extends LocalModelDescriptor {
  lifecycle: LocalModelLifecycle;
  progress: number | null;
  error: string | null;
  endpoint: string | null;
  isTargetSupported: boolean;
}

/**
 * A model whose bytes are on this Mac, read from its manifest in
 * `~/.amiswifi/models`. Independent of the remote catalog, so the Tokiie page
 * can list what is installed while offline.
 */
export interface InstalledLocalModel {
  id: string;
  name: string;
  provider: string;
  series: string;
  fileName: string;
  /** Actual bytes on disk, not the rounded figure the catalog publishes. */
  sizeBytes: number;
  /** Unix milliseconds at which the download completed. */
  downloadedAt: number;
  filePath: string;
}

/** Local machine capability used for download gates and runtime display. */
export interface LocalModelCapability {
  target: 'mac';
  freeDiskBytes: number | null;
  totalRamBytes: number | null;
  platform: string;
}

/** Catalog request shared by initial load and refresh. */
export interface LocalModelCatalogRequest {
  provider?: LocalModelProvider;
  query?: string;
}

/** Complete local model catalog response. */
export interface LocalModelCatalogScan {
  providers: string[];
  selectedProvider: LocalModelProvider;
  models: LocalModelRow[];
  capability: LocalModelCapability;
  failures: string[];
}

/** Filesystem roots whose contents are visible to the supported agents. */
export type SkillRoot = 'amis' | 'claudeCode' | 'codex' | 'agents';

/** Agents that can load a skill from one of the supported roots. */
export type SkillAgent = 'claudeCode' | 'codex';

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
  /**
   * Which agents can already load this skill, carried here so a repository card
   * draws the same chips as an installed one. Every badge is unchecked while the
   * skill is only cached: the folder exists, but no agent root points at it yet.
   */
  agentBadges: SkillAgentBadge[];
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
  status: 'installed' | 'alreadyInstalled' | 'reused' | 'replaced' | 'keptBoth' | 'skipped' | 'conflict';
  destinationPath: string | null;
  conflictPath: string | null;
  installedSkills: InstalledSkill[];
}

/** The three answers the upload conflict prompt can collect. */
export type SkillUploadConflictChoice = Exclude<SkillConflictStrategy, 'reportConflict'>;

/**
 * How one "Upload Skill" attempt ended. `cancelled` and `notASkillFolder` are
 * picker outcomes, `alreadyInstalled` is the duplicate check refusing to copy,
 * and `conflict` is the prompt the renderer has to answer before anything moves.
 */
export type SkillUploadStatus =
  | 'cancelled'
  | 'notASkillFolder'
  | 'alreadyInstalled'
  | 'conflict'
  | 'installed'
  | 'replaced'
  | 'keptBoth'
  | 'skipped';

/** Result of one upload attempt, in the single shape the renderer reads. */
export interface SkillUploadResult {
  status: SkillUploadStatus;
  /** The chosen folder's own name, for whatever the notice has to say about it. */
  folderName: string | null;
  destinationPath: string | null;
  conflictPath: string | null;
  /** Set only on `conflict`: the token echoed back with the user's choice. */
  pendingUploadId: string | null;
  /** The rescanned catalog, or null when no scan could have changed it. */
  installedSkills: InstalledSkill[] | null;
}

/** The source form used by skills.sh. */
export type SkillsShSourceKind = 'repository' | 'site';

/** One skill returned by skills.sh browse or search. */
export interface SkillsShSkill {
  id: string;
  source: string;
  skillId: string;
  name: string;
  installs: number;
  isOfficial: boolean;
  sourceKind: SkillsShSourceKind;
  url: string;
}

/**
 * How many listings one browse or search page holds. skills.sh answers browse
 * requests 200 at a time; the pane draws 20, so the main process slices ten UI
 * pages out of every response it fetches. Shared so the renderer can say which
 * range of a listing of thousands it is showing.
 */
export const SKILLS_SH_PAGE_SIZE = 20;

/** One API-sized browse response from skills.sh. */
export interface SkillsShPage {
  skills: SkillsShSkill[];
  total: number;
  hasMore: boolean;
  page: number;
}

/** The flat response returned by the skills.sh search endpoint. */
export interface SkillsShSearchResult {
  skills: SkillsShSkill[];
  count: number;
}

/** Installed comparison for one skills.sh card. */
export interface SkillsShCardState {
  listing: SkillsShSkill;
  installedSkill: InstalledSkill | null;
}

/** Renderer request for downloading and installing one skills.sh skill. */
export interface SkillsShInstallRequest {
  listing: SkillsShSkill;
  enabledAgents: SkillAgent[];
  conflictStrategy: SkillConflictStrategy;
}

/** Skills.sh install result; conflicts keep the resolved local folder available to the caller. */
export interface SkillsShInstallResult extends SkillInstallResult {
  listing: SkillsShSkill;
  resolvedPath: string | null;
}
