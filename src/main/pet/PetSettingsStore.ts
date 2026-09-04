import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_PET_SETTINGS, type PetSettings } from '../../shared/types';

/** Storage boundary used by the main process to persist Pet settings. */
export interface PetSettingsStoring {
  load(): Promise<PetSettings>;
  save(settings: PetSettings): Promise<void>;
}

/** Detailed failure raised when the Pet settings file cannot be written. */
export class PetSettingsStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PetSettingsStoreError';
  }
}

/**
 * Stores one Pet settings object in the Electron user-data folder.
 * A sibling temporary file and rename keep a crash from leaving partial JSON.
 */
export class PetSettingsStore implements PetSettingsStoring {
  private readonly filePathProvider: () => string;

  constructor(filePath: string | (() => string)) {
    this.filePathProvider = typeof filePath === 'string' ? () => filePath : filePath;
  }

  get filePath(): string {
    return this.filePathProvider();
  }

  async load(): Promise<PetSettings> {
    const filePath = this.filePath;
    let contents: string;
    try {
      contents = await readFile(filePath, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) {
        console.info(`[PetSettings] No settings file at ${filePath}; using defaults.`);
        return clonePetSettings(DEFAULT_PET_SETTINGS);
      }
      console.error(`[PetSettings] Could not read ${filePath}; using defaults:`, error);
      return clonePetSettings(DEFAULT_PET_SETTINGS);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      console.error(`[PetSettings] Could not decode JSON in ${filePath}; using defaults:`, error);
      return clonePetSettings(DEFAULT_PET_SETTINGS);
    }

    try {
      return parsePetSettings(parsed);
    } catch (error) {
      console.error(`[PetSettings] Settings schema is invalid in ${filePath}; using defaults:`, error);
      return clonePetSettings(DEFAULT_PET_SETTINGS);
    }
  }

  async save(settings: PetSettings): Promise<void> {
    assertPetSettings(settings);
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;

    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if (!isMissingFileError(cleanupError)) {
          console.error(`[PetSettings] Could not clean up ${temporaryPath}:`, cleanupError);
        }
      }
      throw new PetSettingsStoreError(
        `Failed to save Pet settings to ${this.filePath}: ${describeError(error)}`,
        { cause: error }
      );
    }
  }
}

/** Validates the JSON shape before it becomes renderer-visible state. */
export function parsePetSettings(value: unknown): PetSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Pet settings must be an object.');
  }

  const source = value as Record<string, unknown>;
  const settings: PetSettings = {
    isEnabled: source.isEnabled as PetSettings['isEnabled'],
    size: source.size as PetSettings['size'],
    speed: source.speed as PetSettings['speed'],
    movementRange: source.movementRange as PetSettings['movementRange']
  };
  assertPetSettings(settings);
  return settings;
}

/** Keeps persisted settings on the finite values accepted by the UI. */
export function assertPetSettings(settings: PetSettings): void {
  if (typeof settings.isEnabled !== 'boolean') {
    throw new TypeError('Pet setting isEnabled must be a boolean.');
  }
  if (!isPetScale(settings.size)) {
    throw new TypeError(`Unsupported Pet size: ${String(settings.size)}.`);
  }
  if (!isPetScale(settings.speed)) {
    throw new TypeError(`Unsupported Pet speed: ${String(settings.speed)}.`);
  }
  if (!isPetScale(settings.movementRange)) {
    throw new TypeError(`Unsupported Pet movement range: ${String(settings.movementRange)}.`);
  }
}

function isPetScale(value: unknown): value is PetSettings['size'] {
  return value === 'small' || value === 'mid' || value === 'large';
}

function clonePetSettings(settings: PetSettings): PetSettings {
  return { ...settings };
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
