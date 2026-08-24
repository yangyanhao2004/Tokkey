import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SkillsShSkill, SkillsShSourceKind } from '../../shared/types';
import SkillsShClient, { type SkillsShFetch, type SkillsShSleep } from './SkillsShClient';

const SITE_INDEX_PATH = '/.well-known/skills/index.json';
const SITE_FILE_TIMEOUT_MS = 30_000;
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface SiteSkillIndexEntry {
  name: string;
  description: string;
  files: string[];
}

export interface SiteSkillIndex {
  skills: SiteSkillIndexEntry[];
}

export interface SiteSkillDownload {
  source: string;
  skillId: string;
  skillName: string;
  skillPath: string;
  relativePath: string;
}

export interface SiteSkillDownloaderOptions {
  cacheRoot?: string;
  homeDirectory?: string;
  client?: SiteSkillHttpClient;
  clientFactory?: (baseUrl: string) => SiteSkillHttpClient;
  fetcher?: SkillsShFetch;
  sleep?: SkillsShSleep;
  random?: () => number;
  createId?: () => string;
}

/** Minimal HTTP surface needed by the site downloader, useful for deterministic tests. */
export interface SiteSkillHttpClient {
  fetchJson(relativePath: string, requestName: string): Promise<unknown>;
  fetchBytes(relativePath: string, requestName: string, timeoutMs?: number): Promise<Uint8Array>;
}

/** Downloads and atomically publishes skills from a skills.sh site source. */
export class SiteSkillDownloader {
  private readonly cacheRoot: string;
  private readonly client: SiteSkillHttpClient | null;
  private readonly clientFactory: (baseUrl: string) => SiteSkillHttpClient;
  private readonly fetcher?: SkillsShFetch;
  private readonly sleep?: SkillsShSleep;
  private readonly random?: () => number;
  private readonly createId: () => string;

  constructor(options: SiteSkillDownloaderOptions = {}) {
    const homeDirectory = path.resolve(options.homeDirectory ?? os.homedir());
    this.cacheRoot = path.resolve(options.cacheRoot ?? path.join(homeDirectory, '.amis', 'cache', 'skill-repos'));
    this.client = options.client ?? null;
    this.fetcher = options.fetcher;
    this.sleep = options.sleep;
    this.random = options.random;
    this.createId = options.createId ?? randomUUID;
    this.clientFactory = options.clientFactory ?? ((baseUrl) => new SkillsShClient({
      baseUrl,
      fetcher: this.fetcher,
      sleep: this.sleep,
      random: this.random
    }));
  }

  /** Resolves a site listing into a local skill folder, using cache-first semantics. */
  async downloadSkill(listing: SkillsShSkill | { source: string; skillId: string }): Promise<SiteSkillDownload> {
    const source = this.requireSiteSource(listing.source);
    const skillId = this.requireSkillName(listing.skillId);
    const siteRoot = path.resolve(this.cacheRoot, source);
    const skillRoot = path.resolve(siteRoot, skillId);
    this.ensureExistingCachePathIsSafe(this.cacheRoot);
    this.ensureInsideCache(siteRoot);
    this.ensureInsideCache(skillRoot);
    this.ensureExistingCachePathIsSafe(siteRoot);
    this.ensureExistingCachePathIsSafe(skillRoot);

    if (this.pathExists(skillRoot)) {
      if (this.hasReadableManifest(skillRoot)) {
        return this.makeDownload(source, skillId, skillRoot);
      }
      throw new Error(`Cached site skill is incomplete: ${skillRoot}`);
    }

    const client = this.client ?? this.clientFactory(`https://${source}`);
    const index = this.decodeIndex(await client.fetchJson(SITE_INDEX_PATH, `site ${source} index`));
    const selectedEntry = index.skills.find((entry) => entry.name === skillId);
    if (!selectedEntry) {
      const publishedNames = index.skills.map((entry) => entry.name).join(', ') || 'none';
      throw new Error(`Site ${source} does not publish skill ${skillId}; published skills: ${publishedNames}`);
    }

    const stagingRoot = path.join(this.cacheRoot, `.amis-site-skill-download-${this.createId()}`);
    const stagingSkillRoot = path.join(stagingRoot, skillId);
    mkdirSync(stagingSkillRoot, { recursive: true });
    try {
      for (const filePath of selectedEntry.files) {
        const destinationPath = this.safeChildPath(stagingSkillRoot, filePath);
        const relativeUrl = `/.well-known/skills/${encodeURIComponent(skillId)}/${this.encodePath(filePath)}`;
        const bytes = await client.fetchBytes(relativeUrl, `site ${source}/${skillId}/${filePath}`, SITE_FILE_TIMEOUT_MS);
        mkdirSync(path.dirname(destinationPath), { recursive: true });
        writeFileSync(destinationPath, bytes);
      }
      if (!this.hasReadableManifest(stagingSkillRoot)) {
        throw new Error(`Downloaded site skill has no readable SKILL.md: ${skillId}`);
      }
      this.publishAtomically(siteRoot, skillRoot, stagingRoot, stagingSkillRoot);
      if (!this.hasReadableManifest(skillRoot)) {
        throw new Error(`Downloaded site skill has no readable SKILL.md: ${skillRoot}`);
      }
      return this.makeDownload(source, skillId, skillRoot);
    } finally {
      if (this.pathExists(stagingRoot)) {
        rmSync(stagingRoot, { recursive: true, force: true });
      }
    }
  }

  /** Alias matching resolver terminology. */
  resolveSkill(listing: SkillsShSkill | { source: string; skillId: string }): Promise<SiteSkillDownload> {
    return this.downloadSkill(listing);
  }

  /** Compatibility alias for downloader-oriented callers. */
  download(listing: SkillsShSkill | { source: string; skillId: string }): Promise<SiteSkillDownload> {
    return this.downloadSkill(listing);
  }

  /** Validates the site index before any advertised path is used. */
  validateIndex(payload: unknown): SiteSkillIndex {
    return this.decodeIndex(payload);
  }

  getCacheRoot(): string {
    return this.cacheRoot;
  }

  private decodeIndex(payload: unknown): SiteSkillIndex {
    if (!this.isRecord(payload) || !Array.isArray(payload.skills) || payload.skills.length === 0) {
      throw new Error('Site skills index must contain a non-empty skills array');
    }
    const names = new Set<string>();
    const skills = payload.skills.map((entry, index) => {
      if (!this.isRecord(entry)) {
        throw new Error(`Site skills index entry ${index} is not an object`);
      }
      const name = this.requireSkillName(entry.name, `Site skills index entry ${index} name`);
      if (names.has(name)) {
        throw new Error(`Site skills index contains duplicate skill name: ${name}`);
      }
      names.add(name);
      if (typeof entry.description !== 'string' || entry.description.trim().length === 0) {
        throw new Error(`Site skills index entry ${name} has an empty description`);
      }
      if (!Array.isArray(entry.files) || entry.files.length === 0) {
        throw new Error(`Site skills index entry ${name} must list files`);
      }
      const files = entry.files.map((file, fileIndex) => {
        const filePath = typeof file === 'string'
          ? file
          : this.isRecord(file) && typeof file.path === 'string' ? file.path : '';
        return this.validateFilePath(filePath, `${name} file ${fileIndex}`);
      });
      if (new Set(files).size !== files.length) {
        throw new Error(`Site skills index entry ${name} contains duplicate files`);
      }
      if (!files.includes('SKILL.md')) {
        throw new Error(`Site skills index entry ${name} must include SKILL.md`);
      }
      return { name, description: entry.description.trim(), files };
    });
    return { skills };
  }

  private requireSiteSource(source: string): string {
    if (typeof source !== 'string' || source.length === 0 || source.includes('\\') || source.includes('\u0000')) {
      throw new Error('Site source must be a valid host');
    }
    if (this.classifySource(source) !== 'site') {
      throw new Error(`Source is not a site: ${source}`);
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(`https://${source}`);
    } catch {
      throw new Error(`Invalid site host: ${source}`);
    }
    if (
      parsedUrl.protocol !== 'https:' ||
      parsedUrl.hostname !== source ||
      parsedUrl.username ||
      parsedUrl.password ||
      parsedUrl.port ||
      parsedUrl.pathname !== '/' ||
      parsedUrl.search ||
      parsedUrl.hash
    ) {
      throw new Error(`Site source must be an exact HTTPS host: ${source}`);
    }
    return source;
  }

  private requireSkillName(value: unknown, label = 'Site skill name'): string {
    if (typeof value !== 'string' || !SKILL_NAME_PATTERN.test(value)) {
      throw new Error(`${label} must match [a-z0-9][a-z0-9-]{0,63}`);
    }
    return value;
  }

  private validateFilePath(value: string, label: string): string {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.includes('\\') || value.includes('\u0000') || value.startsWith('/')) {
      throw new Error(`Invalid ${label} path`);
    }
    const parts = value.split('/');
    if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
      throw new Error(`Invalid ${label} path`);
    }
    return value;
  }

  private publishAtomically(siteRoot: string, skillRoot: string, stagingRoot: string, stagingSkillRoot: string): void {
    mkdirSync(this.cacheRoot, { recursive: true });
    if (!this.pathExists(siteRoot)) {
      try {
        renameSync(stagingRoot, siteRoot);
        return;
      } catch (error) {
        if (this.hasReadableManifest(skillRoot)) {
          return;
        }
        throw new Error(`Publishing site cache ${siteRoot} failed: ${this.describeError(error)}`);
      }
    }
    if (!this.isDirectory(siteRoot)) {
      throw new Error(`Site cache path is not a directory: ${siteRoot}`);
    }
    if (this.pathExists(skillRoot)) {
      if (this.hasReadableManifest(skillRoot)) {
        return;
      }
      throw new Error(`Cached site skill is incomplete: ${skillRoot}`);
    }
    try {
      renameSync(stagingSkillRoot, skillRoot);
    } catch (error) {
      if (this.hasReadableManifest(skillRoot)) {
        return;
      }
      throw new Error(`Publishing site skill ${skillRoot} failed: ${this.describeError(error)}`);
    }
  }

  private safeChildPath(rootPath: string, relativePath: string): string {
    const candidatePath = path.resolve(rootPath, ...relativePath.split('/'));
    const relativePathToRoot = path.relative(rootPath, candidatePath);
    if (relativePathToRoot.startsWith('..') || path.isAbsolute(relativePathToRoot)) {
      throw new Error(`Site file path escapes skill directory: ${relativePath}`);
    }
    return candidatePath;
  }

  private ensureInsideCache(candidatePath: string): void {
    const relativePath = path.relative(this.cacheRoot, candidatePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error(`Site cache path escapes cache root: ${candidatePath}`);
    }
  }

  private ensureExistingCachePathIsSafe(candidatePath: string): void {
    if (!this.pathExists(candidatePath)) {
      return;
    }
    try {
      if (lstatSync(candidatePath).isSymbolicLink()) {
        throw new Error(`Site cache path cannot be a symbolic link: ${candidatePath}`);
      }
      const relativePath = path.relative(realpathSync(this.cacheRoot), realpathSync(candidatePath));
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new Error(`Site cache path resolves outside cache root: ${candidatePath}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Site cache path')) {
        throw error;
      }
      throw new Error(`Unable to validate site cache path ${candidatePath}: ${this.describeError(error)}`);
    }
  }

  private hasReadableManifest(skillPath: string): boolean {
    try {
      return !lstatSync(skillPath).isSymbolicLink() && this.isDirectory(skillPath) && readFileSync(path.join(skillPath, 'SKILL.md')).length > 0;
    } catch {
      return false;
    }
  }

  private pathExists(candidatePath: string): boolean {
    try {
      lstatSync(candidatePath);
      return true;
    } catch {
      return false;
    }
  }

  private isDirectory(candidatePath: string): boolean {
    try {
      return statSync(candidatePath).isDirectory();
    } catch {
      return false;
    }
  }

  private makeDownload(source: string, skillId: string, skillPath: string): SiteSkillDownload {
    return {
      source,
      skillId,
      skillName: skillId,
      skillPath: path.resolve(skillPath),
      relativePath: skillId
    };
  }

  private encodePath(relativePath: string): string {
    return relativePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  }

  private classifySource(source: string): SkillsShSourceKind {
    return source.includes('/') || !source.includes('.') ? 'repository' : 'site';
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export default SiteSkillDownloader;
