export {
  SkillDeduplicator,
  SKILL_ROOTS
} from './SkillDeduplicator';
export { default as FileSkillContentHasher } from './SkillContentHasher';
export { InstalledSkillCatalog, LocalSkillCatalogScanner, SkillManifestParser, SkillRootWalker } from './SkillCatalogScanner';
export { SkillDeployer, SkillDeploymentError, SKILL_AGENT_ORDER } from './SkillDeployer';
export { SkillFilesystemLayout, SKILL_ROOT_RELATIVE_PATHS } from './SkillFilesystem';
export { default as GitHubRepositoryCoordinate } from './GitHubRepositoryCoordinate';
export { default as GitCommandRunner, GitCommandError } from './GitCommandRunner';
export { default as RepositoryCloneCache } from './RepositoryCloneCache';
export { default as RepositorySkillScanner } from './RepositorySkillScanner';
export { default as CachedRepositoryCatalog, LocalCachedRepositoryCatalog } from './CachedRepositoryCatalog';
export { default as SkillFolderImporter } from './SkillFolderImporter';
export { default as SkillInstaller, RepositorySkillInstaller } from './SkillInstaller';
export { default as DiscoverRepositories } from './DiscoverRepositories';
export { default as SkillsShClient, SkillsShError } from './SkillsShClient';
export { default as SiteSkillDownloader } from './SiteSkillDownloader';
export { default as SkillSourceResolver } from './SkillSourceResolver';
export { default as CachedSourceCatalog, LocalCachedSourceCatalog } from './CachedSourceCatalog';
export { default as CachedInstalledSkillMatcher, LocalSkillDuplicateDetector } from './CachedInstalledSkillMatcher';
export { default as SkillFolderSelector, ElectronDirectoryChooser } from './SkillFolderSelector';
export { default as SkillUploadService } from './SkillUploadService';
export { default as DiscoverSkillsService } from './DiscoverSkillsService';
export type {
  DiscoveredSkill,
  LocalSkillCatalogScannerOptions,
  SkillFileId
} from './SkillCatalogScanner';
export type { SkillFilesystemLayoutOptions } from './SkillFilesystem';
export type { SkillDeployerOptions } from './SkillDeployer';
export type { SkillContentHashing } from './SkillContentHasher';
export type {
  ScrapedRepository,
  ScrapedSkill,
  RepositorySkillScannerOptions
} from './RepositorySkillScanner';
export type { GitCommandExecutor, RepositoryCloneCacheOptions, RepositoryCheckoutResult } from './RepositoryCloneCache';
export type { GitCommandResult, GitCommandRunnerOptions, GitCommandRunOptions } from './GitCommandRunner';
export type { CachedRepositoryCatalogOptions } from './CachedRepositoryCatalog';
export type { SkillFolderImporterOptions, SkillFolderImportResult } from './SkillFolderImporter';
export type { SkillInstallerOptions } from './SkillInstaller';
export type {
  DirectoryChooser,
  SkillFolderSelection,
  SkillFolderSelectionStatus,
  SkillFolderSelectorOptions
} from './SkillFolderSelector';
export type { SkillUploadServiceOptions } from './SkillUploadService';
export type { DiscoverRepositoriesOptions } from './DiscoverRepositories';
export type {
  SkillsShClientOptions,
  SkillsShFetch,
  SkillsShSleep
} from './SkillsShClient';
export type {
  SiteSkillDownloaderOptions,
  SiteSkillIndex,
  SiteSkillIndexEntry,
  SiteSkillDownload,
  SiteSkillHttpClient
} from './SiteSkillDownloader';
export type { SkillSourceResolverOptions, ResolvedSkillSource } from './SkillSourceResolver';
export type { CachedSourceCatalogOptions, CachedSource, CachedSourceSkill } from './CachedSourceCatalog';
export type { DiscoverSkillsServiceOptions } from './DiscoverSkillsService';
export type {
  CachedRepository,
  CachedRepositorySkill,
  InstallRepositorySkillRequest,
  RepositoryCoordinate,
  RepositorySyncResult,
  SkillConflictStrategy,
  SkillInstallResult,
  SkillUploadConflictChoice,
  SkillUploadResult,
  SkillUploadStatus
} from '../../shared/types';
export type {
  SkillsShCardState,
  SkillsShInstallRequest,
  SkillsShInstallResult,
  SkillsShPage,
  SkillsShSearchResult,
  SkillsShSkill,
  SkillsShSourceKind
} from '../../shared/types';

// MCP catalog exports live beside the skill services while sharing this public barrel.
export {
  CanonicalMcpCodec,
  ClaudeCodeMcpAdapter,
  CodexMcpAdapter,
  LocalMcpCatalogScanner,
  McpCatalogDeduplicator,
  McpConfigFileReader
} from '../mcp/McpCatalogScanner';
export type { DiscoveredMcp, McpAgentConfigAdapter, McpFileReader } from '../mcp/McpCatalogScanner';
