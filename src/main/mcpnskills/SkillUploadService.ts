import { randomUUID } from 'node:crypto';
import type { SkillUploadConflictChoice, SkillUploadResult } from '../../shared/types';
import { LocalSkillDuplicateDetector } from './CachedInstalledSkillMatcher';
import LocalSkillCatalogScanner from './SkillCatalogScanner';
import SkillFolderImporter from './SkillFolderImporter';
import SkillFolderSelector from './SkillFolderSelector';

/** One conflicted upload waiting for the user to pick a strategy. */
interface PendingUpload {
  folderPath: string;
  folderName: string;
}

export interface SkillUploadServiceOptions {
  installedCatalog?: LocalSkillCatalogScanner;
  importer?: SkillFolderImporter;
  duplicateDetector?: LocalSkillDuplicateDetector;
  selector?: SkillFolderSelector;
}

/**
 * The "Upload Skill" flow: pick a folder, prove it is not already installed,
 * then copy it into the app's own skills root.
 *
 * A conflicted upload is held here rather than handed back to the renderer, so
 * the folder a Replace acts on is always the folder the user actually chose.
 */
export class SkillUploadService {
  private readonly installedCatalog: LocalSkillCatalogScanner;
  private readonly importer: SkillFolderImporter;
  private readonly duplicateDetector: LocalSkillDuplicateDetector;
  private readonly selector: SkillFolderSelector;
  private readonly pendingUploads = new Map<string, PendingUpload>();

  constructor(options: SkillUploadServiceOptions = {}) {
    const installedCatalog = options.installedCatalog ?? new LocalSkillCatalogScanner();
    this.installedCatalog = installedCatalog;
    this.importer = options.importer ?? new SkillFolderImporter({
      filesystem: installedCatalog.getFilesystem()
    });
    this.duplicateDetector = options.duplicateDetector ?? new LocalSkillDuplicateDetector();
    this.selector = options.selector ?? new SkillFolderSelector();
  }

  /**
   * Opens the picker and imports what it returns. The catalog is rescanned
   * before the duplicate check because the cards on screen may be minutes old.
   */
  async uploadSkillFolder(): Promise<SkillUploadResult> {
    const selection = await this.selector.selectSkillFolder();
    if (selection.status === 'cancelled' || !selection.folderPath || !selection.folderName) {
      return this.makeResult({ status: 'cancelled' });
    }
    if (selection.status === 'notASkillFolder') {
      return this.makeResult({ status: 'notASkillFolder', folderName: selection.folderName });
    }

    const installedSkills = await this.installedCatalog.scanInstalledSkills();
    const duplicate = this.duplicateDetector.findDuplicate(selection.folderPath, installedSkills);
    if (duplicate) {
      return this.makeResult({
        status: 'alreadyInstalled',
        folderName: selection.folderName,
        destinationPath: duplicate.primaryInstallation.absolutePath,
        installedSkills
      });
    }

    return this.importFolder(selection.folderPath, selection.folderName, 'reportConflict');
  }

  /** Re-runs a held upload with the strategy the conflict prompt collected. */
  async resolveConflict(
    pendingUploadId: string,
    choice: SkillUploadConflictChoice
  ): Promise<SkillUploadResult> {
    const pendingUpload = this.pendingUploads.get(pendingUploadId);
    if (!pendingUpload) {
      throw new Error(`No skill upload is waiting on this choice: ${pendingUploadId}`);
    }
    this.pendingUploads.delete(pendingUploadId);
    return this.importFolder(pendingUpload.folderPath, pendingUpload.folderName, choice);
  }

  /** Runs one import attempt and rescans only when the catalog can have changed. */
  private async importFolder(
    folderPath: string,
    folderName: string,
    strategy: SkillUploadConflictChoice | 'reportConflict'
  ): Promise<SkillUploadResult> {
    const importResult = this.importer.importSkill(folderPath, folderName, strategy);
    if (importResult.status === 'conflict') {
      const pendingUploadId = randomUUID();
      this.pendingUploads.set(pendingUploadId, { folderPath, folderName });
      return this.makeResult({
        status: 'conflict',
        folderName,
        conflictPath: importResult.conflictPath,
        pendingUploadId
      });
    }
    if (importResult.status === 'skipped') {
      return this.makeResult({
        status: 'skipped',
        folderName,
        destinationPath: importResult.destinationPath,
        conflictPath: importResult.conflictPath
      });
    }

    return this.makeResult({
      status: importResult.status,
      folderName,
      destinationPath: importResult.destinationPath,
      installedSkills: await this.installedCatalog.scanInstalledSkills()
    });
  }

  /** Fills the absent halves of a result so the renderer reads one fixed shape. */
  private makeResult(result: Partial<SkillUploadResult> & Pick<SkillUploadResult, 'status'>): SkillUploadResult {
    return {
      folderName: null,
      destinationPath: null,
      conflictPath: null,
      pendingUploadId: null,
      installedSkills: null,
      ...result
    };
  }
}

export default SkillUploadService;
