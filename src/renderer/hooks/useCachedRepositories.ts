import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CachedRepository,
  CachedRepositorySkill,
  RepositorySyncResult,
  SkillAgent,
  SkillInstallResult
} from '../../shared/types';

/**
 * How an install answers a name already taken in Tokkey's skills folder.
 * `reportConflict` neither overwrites nor renames: an identical folder is
 * reused and only its agent selection is applied, and a different folder under
 * the same name comes back as a conflict for the tab to report. Choosing
 * between replacing and keeping both is the upload flow's prompt, which this
 * tab does not draw.
 */
const INSTALL_CONFLICT_STRATEGY = 'reportConflict';

export interface CachedRepositories {
  /** The last scan that arrived, or `null` before the first one. */
  repositories: CachedRepository[] | null;
  /** True only while no scan has arrived yet; a refresh keeps the old cards up. */
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
  /**
   * Installs one cached card and deploys it to exactly `enabledAgents`, then
   * re-reads the cache so the card's chips show the result. Rejects when the
   * main process refuses, so the dialog that asked reports the failure.
   */
  installSkill: (
    skill: CachedRepositorySkill,
    enabledAgents: SkillAgent[]
  ) => Promise<SkillInstallResult>;
  /**
   * Downloads one GitHub repository into the cache — a clone, or a fetch when
   * it is already there — then re-reads the cache so its skills appear in the
   * grid. An empty `branch` takes the repository's default branch. Rejects when
   * Git or the name refuses, so the dialog that asked reports the failure.
   */
  addRepository: (input: string, branch: string) => Promise<RepositorySyncResult>;
}

/**
 * The skills published by the repositories already cloned into
 * `~/.amis/cache/skill-repos`, as the Discover pane's "Repos" tab draws them.
 *
 * The scan runs once per mount rather than on a timer: it walks the cache and
 * compares every skill against the installed catalog, and a repository arriving
 * is a deliberate act — returning to the tab re-scans. No Git or network work
 * happens here, which is what makes re-reading the cache cheap enough to do on
 * every visit.
 */
export function useCachedRepositories(): CachedRepositories {
  const [repositories, setRepositories] = useState<CachedRepository[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Guards against a scan that resolves after unmount setting state.
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    void (async () => {
      try {
        const scanned = await window.tokkey.listCachedRepositories();
        if (!isMountedRef.current) return;
        setRepositories(scanned);
        setError(null);
      } catch (cause) {
        if (!isMountedRef.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (isMountedRef.current) {
          setIsLoading(false);
        }
      }
    })();
  }, []);

  useEffect(refresh, [refresh]);

  const installSkill = useCallback(
    async (skill: CachedRepositorySkill, enabledAgents: SkillAgent[]) => {
      const result = await window.tokkey.installRepositorySkill({
        source: skill.source,
        relativePath: skill.relativePath,
        enabledAgents,
        conflictStrategy: INSTALL_CONFLICT_STRATEGY
      });
      // The install answers with the installed catalog, not with the cache, so
      // the cards are re-read rather than patched from the result.
      refresh();
      return result;
    },
    [refresh]
  );

  const addRepository = useCallback(
    async (input: string, branch: string) => {
      const result = await window.tokkey.addRepository(input, branch);
      // The download answers with one repository; the grid draws them all, so
      // the cache is re-read rather than having this one spliced into it.
      refresh();
      return result;
    },
    [refresh]
  );

  return { repositories, isLoading, error, refresh, installSkill, addRepository };
}
