import { statSync } from 'node:fs';
import path from 'node:path';
import { BrowserWindow, dialog } from 'electron';
import { SkillManifestParser } from './SkillCatalogScanner';

/** How the picker ended: nothing chosen, a folder without a manifest, or a real skill. */
export type SkillFolderSelectionStatus = 'cancelled' | 'notASkillFolder' | 'selected';

/** One answer from the picker, already normalized for the upload flow. */
export interface SkillFolderSelection {
  status: SkillFolderSelectionStatus;
  folderPath: string | null;
  folderName: string | null;
}

/** The directory panel itself, so the upload flow can run without Electron. */
export interface DirectoryChooser {
  chooseDirectory(): Promise<string | null>;
}

/** A directory-only open panel, sheeted onto the window that asked for it. */
export class ElectronDirectoryChooser implements DirectoryChooser {
  /** Returns the chosen directory, or null when the panel was cancelled. */
  async chooseDirectory(): Promise<string | null> {
    const parentWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
    const options = {
      title: 'Choose a skill folder',
      buttonLabel: 'Upload',
      message: 'Choose a folder that contains a SKILL.md.',
      properties: ['openDirectory' as const]
    };
    const result = parentWindow
      ? await dialog.showOpenDialog(parentWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled) {
      return null;
    }
    return result.filePaths[0] ?? null;
  }
}

export interface SkillFolderSelectorOptions {
  chooser?: DirectoryChooser;
}

/**
 * Opens the folder panel and admits only folders that carry a SKILL.md, which
 * is the one thing that makes a directory a skill rather than an ordinary one.
 */
export class SkillFolderSelector {
  private readonly chooser: DirectoryChooser;

  constructor(options: SkillFolderSelectorOptions = {}) {
    this.chooser = options.chooser ?? new ElectronDirectoryChooser();
  }

  /** Cancelling is an ordinary outcome, so it is reported rather than thrown. */
  async selectSkillFolder(): Promise<SkillFolderSelection> {
    const chosenPath = await this.chooser.chooseDirectory();
    if (!chosenPath) {
      return { status: 'cancelled', folderPath: null, folderName: null };
    }

    const folderPath = path.resolve(chosenPath);
    return {
      status: this.hasManifest(folderPath) ? 'selected' : 'notASkillFolder',
      folderPath,
      folderName: path.basename(folderPath)
    };
  }

  /** Follows links, matching how the catalog scanner recognizes a skill folder. */
  private hasManifest(folderPath: string): boolean {
    try {
      return statSync(path.join(folderPath, SkillManifestParser.manifestFileName)).isFile();
    } catch {
      return false;
    }
  }
}

export default SkillFolderSelector;
