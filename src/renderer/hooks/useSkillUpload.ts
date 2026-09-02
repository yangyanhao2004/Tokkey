import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  InstalledSkill,
  SkillUploadConflictChoice,
  SkillUploadResult
} from '../../shared/types';
import {
  describeSkillUploadFailure,
  describeSkillUploadOutcome,
  type CatalogNotice
} from '../pages/agentHubContent';

/** The question the conflict prompt is holding, and the token that answers it. */
export interface SkillUploadConflict {
  pendingUploadId: string;
  folderName: string;
}

export interface SkillUpload {
  /** True from the moment the picker opens until the copy settles. */
  isUploading: boolean;
  /** Set only while the Replace / Keep Both / Skip prompt is up. */
  conflict: SkillUploadConflict | null;
  /** The one line the section shows about the last upload, or null. */
  notice: CatalogNotice | null;
  start: () => void;
  resolveConflict: (choice: SkillUploadConflictChoice) => void;
}

export interface SkillUploadOptions {
  /**
   * Handed every scan an upload produces, so the catalog on screen is the one
   * the main process just read rather than a second walk of the same roots.
   */
  onCatalogScanned: (skills: InstalledSkill[]) => void;
}

/**
 * The "Upload Skill" button's whole flow: open the folder picker, then either
 * report what happened or raise the conflict prompt and finish once it is
 * answered.
 *
 * Nothing here decides anything about the filesystem — the main process picks
 * the folder, rescans, checks for a duplicate, and copies. This hook only holds
 * which of those answers the page is currently showing.
 */
export function useSkillUpload({ onCatalogScanned }: SkillUploadOptions): SkillUpload {
  const [isUploading, setIsUploading] = useState(false);
  const [conflict, setConflict] = useState<SkillUploadConflict | null>(null);
  const [notice, setNotice] = useState<CatalogNotice | null>(null);
  // Guards against an upload that settles after the page is gone.
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  /** Runs one attempt and turns its result into what the page shows next. */
  const run = useCallback(
    (call: () => Promise<SkillUploadResult>) => {
      setIsUploading(true);
      setNotice(null);
      void (async () => {
        try {
          const result = await call();
          if (!isMountedRef.current) return;
          setConflict(
            result.status === 'conflict' && result.pendingUploadId
              ? { pendingUploadId: result.pendingUploadId, folderName: result.folderName ?? '' }
              : null
          );
          if (result.installedSkills) {
            onCatalogScanned(result.installedSkills);
          }
          setNotice(describeSkillUploadOutcome(result));
        } catch (cause) {
          if (!isMountedRef.current) return;
          setConflict(null);
          setNotice(describeSkillUploadFailure(cause instanceof Error ? cause.message : String(cause)));
        } finally {
          if (isMountedRef.current) {
            setIsUploading(false);
          }
        }
      })();
    },
    [onCatalogScanned]
  );

  const start = useCallback(() => {
    run(() => window.tokkey.uploadSkillFolder());
  }, [run]);

  const resolveConflict = useCallback(
    (choice: SkillUploadConflictChoice) => {
      if (!conflict) {
        return;
      }
      const { pendingUploadId } = conflict;
      // Closing the prompt now keeps a second answer from reaching a spent token.
      setConflict(null);
      run(() => window.tokkey.resolveSkillUploadConflict(pendingUploadId, choice));
    },
    [conflict, run]
  );

  // No dismissal of its own: a notice lives as long as the tab that raised it.
  return { isUploading, conflict, notice, start, resolveConflict };
}
