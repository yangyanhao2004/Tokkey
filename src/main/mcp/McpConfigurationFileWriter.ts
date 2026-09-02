import { open, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Original bytes and mode captured before any MCP configuration is rendered. */
export interface McpConfigurationFileRead {
  filePath: string;
  text: string;
  originalBytes: Uint8Array | null;
  originalMode: number | null;
}

/** One fully staged file replacement ready for an all-or-nothing commit. */
export interface McpConfigurationFileChange extends McpConfigurationFileRead {
  replacementBytes: Uint8Array;
}

/** Filesystem operations used by the transactional writer and isolated tests. */
export interface McpConfigurationFileOperations {
  read(filePath: string): Promise<{ bytes: Uint8Array; mode: number } | null>;
  replaceAtomically(filePath: string, bytes: Uint8Array, mode: number | null): Promise<void>;
  remove(filePath: string): Promise<void>;
}

/** Implements local reads and same-directory atomic replacements. */

export class LocalMcpConfigurationFileOperations implements McpConfigurationFileOperations {
  async read(filePath: string): Promise<{ bytes: Uint8Array; mode: number } | null> {
    try {
      const [bytes, metadata] = await Promise.all([readFile(filePath), stat(filePath)]);
      return { bytes, mode: metadata.mode & 0o777 };
    } catch (error) {
      if (this.isMissingFileError(error)) {
        return null;
      }
      throw error;
    }
  }

  async replaceAtomically(filePath: string, bytes: Uint8Array, mode: number | null): Promise<void> {
    const parentDirectory = path.dirname(filePath);
    await mkdir(parentDirectory, { recursive: true });
    const temporaryPath = path.join(parentDirectory, `.${path.basename(filePath)}.tokkey-${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(temporaryPath, 'wx', mode ?? 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporaryPath, filePath);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async remove(filePath: string): Promise<void> {
    try {
      await unlink(filePath);
    } catch (error) {
      if (!this.isMissingFileError(error)) {
        throw error;
      }
    }
  }

  private isMissingFileError(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
  }
}

/** Commits staged MCP files and restores exact originals after a later failure. */
export class McpConfigurationFileWriter {
  private readonly operations: McpConfigurationFileOperations;

  constructor(operations: McpConfigurationFileOperations = new LocalMcpConfigurationFileOperations()) {
    this.operations = operations;
  }

  async read(filePath: string): Promise<McpConfigurationFileRead> {
    const original = await this.operations.read(filePath);
    if (!original) {
      return { filePath, text: '', originalBytes: null, originalMode: null };
    }
    const originalBytes = new Uint8Array(original.bytes);
    // Fatal UTF-8 decoding prevents an invalid file from being replaced with normalized text.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(originalBytes);
    return { filePath, text, originalBytes, originalMode: original.mode };
  }

  async commit(changes: readonly McpConfigurationFileChange[]): Promise<void> {
    let committedChanges: McpConfigurationFileChange[] = [];
    for (const change of changes) {
      try {
        await this.operations.replaceAtomically(
          change.filePath,
          change.replacementBytes,
          change.originalMode
        );
        committedChanges = [...committedChanges, change];
      } catch (error) {
        const rollbackFailures = await this.rollback(committedChanges);
        const writeError = this.describeError(error);
        const rollbackDetail = rollbackFailures.length === 0
          ? 'Previously written files were restored.'
          : `Rollback also failed: ${rollbackFailures.join('; ')}`;
        throw new Error(`Failed to write ${change.filePath}: ${writeError} ${rollbackDetail}`);
      }
    }
  }

  private async rollback(committedChanges: readonly McpConfigurationFileChange[]): Promise<string[]> {
    let failures: string[] = [];
    for (const change of [...committedChanges].reverse()) {
      try {
        if (change.originalBytes === null) {
          await this.operations.remove(change.filePath);
        } else {
          await this.operations.replaceAtomically(
            change.filePath,
            change.originalBytes,
            change.originalMode
          );
        }
      } catch (error) {
        failures = [...failures, `${change.filePath}: ${this.describeError(error)}`];
      }
    }
    return failures;
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
