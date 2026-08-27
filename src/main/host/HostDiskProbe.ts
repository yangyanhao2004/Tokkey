import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';

/** One boot-volume reading in bytes. */
export interface HostDiskReading {
  total: number;
  free: number;
}

/** Seam over the Foundation read, which resolves to `null` when unavailable. */
export type ImportantCapacityReader = (volumePath: string) => Promise<HostDiskReading | null>;

/** Seam over `fs.statfs` so the fallback arithmetic can be tested. */
export type StatfsReader = (path: string) => Promise<{ blocks: number; bsize: number; bavail: number }>;

/**
 * The data volume, not "/": on APFS "/" is the sealed read-only system
 * snapshot and reports a capacity unrelated to what a download can use.
 */
const BOOT_DATA_VOLUME = '/System/Volumes/Data';

/** A hung fork must not stall the poll loop; the real read takes ~50ms. */
const OSASCRIPT_TIMEOUT_MS = 5000;

/**
 * Reads boot-volume capacity as Finder and System Settings report it.
 *
 * `statfs` (and `df`, and `diskutil`) omit purgeable data — local Time Machine
 * snapshots and evictable caches — which on a typical Mac is tens of GB. Only
 * Foundation's `volumeAvailableCapacityForImportantUsage` counts it, so this
 * probe asks Foundation through JXA rather than shelling out to `df`.
 *
 * `statfs` remains the fallback: it always answers, and under-reporting free
 * space is the safe direction when the figure gates a download.
 */
export class HostDiskProbe {
  private readonly volumePath: string;
  private readonly readImportantCapacity: ImportantCapacityReader;
  private readonly readStatfs: StatfsReader;

  constructor(
    volumePath: string = BOOT_DATA_VOLUME,
    readImportantCapacity: ImportantCapacityReader = HostDiskProbe.runFoundationRead,
    readStatfs: StatfsReader = HostDiskProbe.runStatfs
  ) {
    this.volumePath = volumePath;
    this.readImportantCapacity = readImportantCapacity;
    this.readStatfs = readStatfs;
  }

  /** @throws {Error} If neither Foundation nor `statfs` can read the volume. */
  async read(): Promise<HostDiskReading> {
    const finderCapacity = await this.tryImportantCapacity();
    if (finderCapacity) {
      return finderCapacity;
    }

    const filesystem = await this.readStatfs(this.volumePath);
    const blockSize = Number(filesystem.bsize);
    return {
      total: Number(filesystem.blocks) * blockSize,
      // `bavail`, not `bfree`: the reserve blocks only root can spend are not ours.
      free: Number(filesystem.bavail) * blockSize
    };
  }

  /** Foundation is the better answer, never the required one, so failures fall through. */
  private async tryImportantCapacity(): Promise<HostDiskReading | null> {
    try {
      return await this.readImportantCapacity(this.volumePath);
    } catch (error) {
      console.error('[HostDiskProbe] Foundation capacity read failed:', error);
      return null;
    }
  }

  /**
   * Runs the resource-value lookup inside JXA, which bridges straight to
   * Foundation. The doc's alternatives — a bundled Swift helper or a native
   * addon — buy nothing over this at a comparable cost.
   */
  private static async runFoundationRead(volumePath: string): Promise<HostDiskReading | null> {
    // The path is a constant today; encoding it as a JS literal keeps it safe
    // if it ever becomes a caller's value.
    const script = `
      ObjC.import('Foundation');
      const url = $.NSURL.fileURLWithPath(${JSON.stringify(volumePath)});
      const capacity = (key) => {
        const out = Ref();
        url.getResourceValueForKeyError(out, key, null);
        return ObjC.unwrap(out[0]);
      };
      JSON.stringify({
        total: capacity($.NSURLVolumeTotalCapacityKey),
        free: capacity($.NSURLVolumeAvailableCapacityForImportantUsageKey)
      });
    `;
    const output = await HostDiskProbe.runOsascript(script);
    return HostDiskProbe.parseCapacity(output);
  }

  /** An unreadable key yields null or 0, which is not a reading worth showing. */
  private static parseCapacity(output: string): HostDiskReading | null {
    const { total, free } = JSON.parse(output) as { total: unknown; free: unknown };
    if (typeof total !== 'number' || typeof free !== 'number' || total <= 0 || free < 0) {
      return null;
    }
    return { total, free };
  }

  private static runOsascript(script: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        '/usr/bin/osascript',
        ['-l', 'JavaScript', '-e', script],
        { timeout: OSASCRIPT_TIMEOUT_MS },
        (error, stdout) => {
          if (error) {
            reject(new Error(`osascript failed: ${error.message}`));
            return;
          }
          resolve(stdout);
        }
      );
    });
  }

  private static async runStatfs(path: string) {
    return statfs(path);
  }
}

export default HostDiskProbe;
