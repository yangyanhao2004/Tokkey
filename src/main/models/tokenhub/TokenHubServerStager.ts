import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
  type FileHandle
} from 'node:fs/promises';
import path from 'node:path';
import {
  TOKEN_HUB_EXTERNAL_READ_CHUNK_SIZE,
  TokenHubCrc32,
  type TokenHubApplicationManifest
} from './TokenHubProtocol';

const ARM64_MACH_O_MAGIC = 'cffaedfe';
const ARM64_CPU_TYPE = 0x0100_000c;
const REQUIRED_SERVER_MARKERS = [
  '--dongle-port',
  '--chat-template-file',
  'Dongle V3 authentication passed'
];

export interface TokenHubProtectedFileClient {
  externalFileInfo(): Promise<{ fileSize: number; crc32: number }>;
  externalFileChunk(offset: number, size: number): Promise<Buffer>;
}

export interface TokenHubFileLease {
  refreshIfNeeded(): Promise<void>;
}

export interface TokenHubServerStagingOptions {
  client: TokenHubProtectedFileClient;
  lease: TokenHubFileLease;
  manifest: TokenHubApplicationManifest;
  serverPath: string;
  assertCurrent(): void;
}

export interface TokenHubServerStaging {
  stage(options: TokenHubServerStagingOptions): Promise<void>;
  remove(serverPath: string): Promise<void>;
}

/** Verifies that a fully downloaded payload is the expected Dongle-aware Mach-O server. */
export function validateTokenHubServer(data: Buffer): void {
  const magic = data.subarray(0, 4).toString('hex');
  if (magic !== ARM64_MACH_O_MAGIC || data.length < 8 || data.readUInt32LE(4) !== ARM64_CPU_TYPE) {
    throw new Error('Amis Hub Flash server is not a macOS Apple Silicon Mach-O executable.');
  }
  const missing = REQUIRED_SERVER_MARKERS.filter(
    (marker) => data.indexOf(Buffer.from(marker)) < 0
  );
  if (missing.length > 0) {
    throw new Error(`Amis Hub Flash server does not support Dongle V3: ${missing.join(', ')}.`);
  }
}

/** Streams the manifest-bound Flash payload into a private executable only after full verification. */
export class TokenHubServerStager implements TokenHubServerStaging {
  async stage(options: TokenHubServerStagingOptions): Promise<void> {
    const { client, lease, manifest, serverPath, assertCurrent } = options;
    await mkdir(path.dirname(serverPath), { recursive: true, mode: 0o700 });
    const partialPath = `${serverPath}.partial`;
    await Promise.all([
      rm(serverPath, { force: true }),
      rm(partialPath, { force: true })
    ]);
    const metadata = await client.externalFileInfo();
    if (metadata.fileSize !== manifest.fileSize || metadata.crc32 !== manifest.fileCrc32) {
      throw new Error('Amis Hub Flash metadata does not match its authenticated manifest.');
    }

    let file: FileHandle | null = null;
    try {
      file = await open(partialPath, 'wx', 0o700);
      const sha256 = createHash('sha256');
      const crc32 = new TokenHubCrc32();
      let offset = 0;
      while (offset < manifest.fileSize) {
        assertCurrent();
        await lease.refreshIfNeeded();
        const size = Math.min(TOKEN_HUB_EXTERNAL_READ_CHUNK_SIZE, manifest.fileSize - offset);
        const chunk = await client.externalFileChunk(offset, size);
        if (chunk.length !== size) {
          throw new Error(`Amis Hub Flash download returned ${chunk.length}/${size} bytes at ${offset}.`);
        }
        await file.writeFile(chunk);
        sha256.update(chunk);
        crc32.update(chunk);
        offset += chunk.length;
        await lease.refreshIfNeeded();
      }
      assertCurrent();
      await file.sync();
      await file.close();
      file = null;

      if (crc32.value() !== manifest.fileCrc32) {
        throw new Error('Amis Hub Flash download failed CRC32 verification.');
      }
      if (!sha256.digest().equals(manifest.fileSha256)) {
        throw new Error('Amis Hub Flash download failed SHA256 verification.');
      }
      validateTokenHubServer(await readFile(partialPath));
      await chmod(partialPath, 0o700);
      await rename(partialPath, serverPath);
    } catch (cause) {
      await file?.close().catch(() => undefined);
      await rm(partialPath, { force: true }).catch(() => undefined);
      throw cause;
    }
  }

  async remove(serverPath: string): Promise<void> {
    await Promise.all([
      this.removeFile(serverPath),
      this.removeFile(`${serverPath}.partial`)
    ]);
  }

  private async removeFile(filePath: string): Promise<void> {
    try {
      await unlink(filePath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
  }
}

export default TokenHubServerStager;
