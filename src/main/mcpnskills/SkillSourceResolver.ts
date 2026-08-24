import type { SkillsShSkill, SkillsShSourceKind } from '../../shared/types';
import GitHubRepositoryCoordinate from './GitHubRepositoryCoordinate';
import RepositoryCloneCache from './RepositoryCloneCache';
import RepositorySkillScanner, { type ScrapedSkill } from './RepositorySkillScanner';
import SiteSkillDownloader, { type SiteSkillDownload } from './SiteSkillDownloader';

export interface ResolvedSkillSource {
  source: string;
  skillId: string;
  sourceKind: SkillsShSourceKind;
  skillPath: string;
  relativePath: string;
  commit: string | null;
}

export interface SkillSourceResolverOptions {
  cache?: RepositoryCloneCache;
  repositoryScanner?: RepositorySkillScanner;
  siteDownloader?: SiteSkillDownloader;
}

/** Resolves a skills.sh skill to its local repository or site source. */
export class SkillSourceResolver {
  private readonly cache: RepositoryCloneCache;
  private readonly repositoryScanner: RepositorySkillScanner;
  private readonly siteDownloader: SiteSkillDownloader;

  constructor(options: SkillSourceResolverOptions = {}) {
    this.cache = options.cache ?? new RepositoryCloneCache();
    this.repositoryScanner = options.repositoryScanner ?? new RepositorySkillScanner();
    this.siteDownloader = options.siteDownloader ?? new SiteSkillDownloader({
      cacheRoot: this.cache.getCacheRoot()
    });
  }

  /** Resolves one listing to a local folder, downloading only when required. */
  async resolveSkill(listing: SkillsShSkill): Promise<ResolvedSkillSource> {
    const sourceKind = this.classifySource(listing.source);
    if (sourceKind === 'site') {
      return this.fromSite(await this.siteDownloader.downloadSkill(listing), listing);
    }
    return this.resolveRepository(listing);
  }

  /** Compatibility alias for callers that use the shorter resolver verb. */
  resolve(listing: SkillsShSkill): Promise<ResolvedSkillSource> {
    return this.resolveSkill(listing);
  }

  private async resolveRepository(listing: SkillsShSkill): Promise<ResolvedSkillSource> {
    const coordinate = new GitHubRepositoryCoordinate(listing.source);
    const checkout = await this.cache.synchronizeCheckout(coordinate);
    const scanned = this.repositoryScanner.scan(checkout.checkoutPath, coordinate, checkout.commit);
    const matchingSkills = scanned.skills.filter((skill) => skill.name === listing.skillId);
    const matchedSkill = matchingSkills[0];
    if (!matchedSkill) {
      const publishedSkills = scanned.skills.map((skill) => skill.name).join(', ') || 'none';
      throw new Error(
        `Repository ${coordinate.source} does not publish skill ${listing.skillId}; published skills: ${publishedSkills}`
      );
    }
    return this.fromRepository(matchedSkill, listing, checkout.commit);
  }

  private fromRepository(
    skill: ScrapedSkill,
    listing: SkillsShSkill,
    commit: string | null
  ): ResolvedSkillSource {
    return {
      source: listing.source,
      skillId: listing.skillId,
      sourceKind: 'repository',
      skillPath: skill.absolutePath,
      relativePath: skill.relativePath,
      commit
    };
  }

  private fromSite(download: SiteSkillDownload, listing: SkillsShSkill): ResolvedSkillSource {
    return {
      source: listing.source,
      skillId: listing.skillId,
      sourceKind: 'site',
      skillPath: download.skillPath,
      relativePath: download.relativePath,
      commit: null
    };
  }

  private classifySource(source: string): SkillsShSourceKind {
    return source.includes('/') || !source.includes('.') ? 'repository' : 'site';
  }
}

export default SkillSourceResolver;
