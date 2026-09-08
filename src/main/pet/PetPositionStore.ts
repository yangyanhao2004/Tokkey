import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface PetPosition {
  x: number;
  y: number;
  displayId: number | null;
}

export interface PetPositionStoring {
  load(): Promise<PetPosition | null>;
  save(position: PetPosition): Promise<void>;
}

/** Persists the user's last Pet placement independently from Pet preferences. */
export class PetPositionStore implements PetPositionStoring {
  private readonly filePathProvider: () => string;

  constructor(filePath: string | (() => string)) {
    this.filePathProvider = typeof filePath === 'string' ? () => filePath : filePath;
  }

  async load(): Promise<PetPosition | null> {
    let contents: string;
    try {
      contents = await readFile(this.filePathProvider(), 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) return null;
      console.error(`[PetPosition] Could not read ${this.filePathProvider()}; ignoring it:`, error);
      return null;
    }

    try {
      return parsePetPosition(JSON.parse(contents));
    } catch (error) {
      console.error(`[PetPosition] Invalid placement file; ignoring it:`, error);
      return null;
    }
  }

  async save(position: PetPosition): Promise<void> {
    assertPetPosition(position);
    const filePath = this.filePathProvider();
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify(position, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      });
      await rename(temporaryPath, filePath);
    } catch (error) {
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if (!isMissingFileError(cleanupError)) {
          console.error(`[PetPosition] Could not clean up ${temporaryPath}:`, cleanupError);
        }
      }
      throw new Error(`Failed to save Pet position to ${filePath}: ${describeError(error)}`, {
        cause: error
      });
    }
  }
}

export function parsePetPosition(value: unknown): PetPosition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Pet position must be an object.');
  }
  const source = value as Record<string, unknown>;
  const position: PetPosition = {
    x: source.x as number,
    y: source.y as number,
    displayId: source.displayId === null ? null : source.displayId as number
  };
  assertPetPosition(position);
  return position;
}

export function assertPetPosition(position: PetPosition): void {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    throw new TypeError('Pet position coordinates must be finite numbers.');
  }
  if (position.displayId !== null && !Number.isFinite(position.displayId)) {
    throw new TypeError('Pet displayId must be null or a finite number.');
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
