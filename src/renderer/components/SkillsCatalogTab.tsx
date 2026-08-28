import { useMemo, useState } from 'react';
import {
  SKILL_SCAN_LOADING_TEXT,
  SKILL_UPLOAD_BUSY_TEXT,
  describeDiscoverAction,
  describeEmptyCatalog,
  describeSkillScanFailure,
  describeUploadAction,
  selectCatalogEntries,
  toSkillCatalogEntries,
  type AgentAvailability
} from '../pages/agentHubContent';
import { useInstalledSkills } from '../hooks/useInstalledSkills';
import { useSkillUpload } from '../hooks/useSkillUpload';
import { CatalogGrid, CatalogMessage, CatalogTabLayout } from './CatalogTabLayout';
import { ManageSkillDialog } from './ManageSkillDialog';
import { PushButton } from './PushButton';
import { SkillUploadConflictDialog } from './SkillUploadConflictDialog';

export interface SkillsCatalogTabProps {
  availability: AgentAvailability;
  /** Opens the Discover Skills pane. */
  onDiscover: () => void;
}

/**
 * The "Skills" tab: the skills the main process finds under the agent roots,
 * plus the two things that can change them — uploading a folder from disk and
 * managing which agents load one.
 *
 * A chip is checked exactly when that agent can already load the skill, so the
 * cards are a reading of the filesystem rather than a list the page keeps. The
 * tab is unmounted when the user switches away, which is also what clears an
 * upload notice: it belongs to the tab that raised it.
 */
export function SkillsCatalogTab({ availability, onDiscover }: SkillsCatalogTabProps) {
  const [query, setQuery] = useState('');
  const [managedSkillId, setManagedSkillId] = useState<string | null>(null);
  const { skills, isLoading, error, applyAgentSelection, uninstall, applyScan } = useInstalledSkills();
  const upload = useSkillUpload({ onCatalogScanned: applyScan });

  // Mapping a whole scan is wasted work on every keystroke of the search box.
  const skillEntries = useMemo(() => toSkillCatalogEntries(skills ?? []), [skills]);
  const entries = selectCatalogEntries(skillEntries, query);
  // Held by id rather than by object so the dialog follows the rescanned card.
  const managedSkill = skills?.find((skill) => skill.id === managedSkillId) ?? null;

  return (
    <>
      <CatalogTabLayout
        query={query}
        onQueryChange={setQuery}
        notice={upload.notice}
        actions={
          <>
            <PushButton
              variant="tinted"
              onClick={upload.start}
              disabled={upload.isUploading}
              testId="catalog-upload"
            >
              {upload.isUploading ? SKILL_UPLOAD_BUSY_TEXT : describeUploadAction('skills')}
            </PushButton>
            <PushButton onClick={onDiscover} testId="catalog-discover">
              {describeDiscoverAction('skills')}
            </PushButton>
          </>
        }
      >
        {isLoading && (
          <CatalogMessage testId="catalog-loading">{SKILL_SCAN_LOADING_TEXT}</CatalogMessage>
        )}

        {error && (
          <CatalogMessage tone="error" testId="catalog-error">
            {describeSkillScanFailure(error)}
          </CatalogMessage>
        )}

        {!isLoading && !error && entries.length === 0 && (
          <CatalogMessage testId="catalog-empty">
            {describeEmptyCatalog('skills', query)}
          </CatalogMessage>
        )}

        <CatalogGrid entries={entries} availability={availability} onAction={setManagedSkillId} />
      </CatalogTabLayout>

      {managedSkill && (
        <ManageSkillDialog
          name={managedSkill.name}
          installedSkillId={managedSkill.id}
          onApply={(selectedAgents) => applyAgentSelection(managedSkill.id, selectedAgents)}
          onUninstall={() => uninstall(managedSkill.id)}
          onClose={() => setManagedSkillId(null)}
        />
      )}

      {upload.conflict && (
        <SkillUploadConflictDialog
          folderName={upload.conflict.folderName}
          onChoose={upload.resolveConflict}
        />
      )}
    </>
  );
}
