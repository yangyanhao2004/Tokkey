import { execFile } from 'node:child_process';
import os from 'node:os';

/** One memory reading in bytes. `available` is always `total - used`. */
export interface HostMemoryReading {
  total: number;
  used: number;
  available: number;
}

/** Seam over the `vm_stat` fork so the parser can be tested without a syscall. */
export type VmStatReader = () => Promise<string>;

const VM_STAT_PATH = '/usr/bin/vm_stat';
/** A wedged fork must never stall the 5s poll loop. */
const VM_STAT_TIMEOUT_MS = 5000;

/**
 * Reads Activity Monitor's "Memory Used" from the kernel VM counters.
 *
 * `vm_stat` prints the same `host_statistics64(HOST_VM_INFO64)` counters the
 * Swift app read through Mach, so this is a port rather than an approximation.
 * `os.freemem()` is deliberately unused: it maps to free pages only, and macOS
 * keeps almost none free, so it under-reports available memory by roughly 10x.
 */
export class HostMemoryProbe {
  private readonly readVmStat: VmStatReader;

  constructor(readVmStat: VmStatReader = HostMemoryProbe.runVmStat) {
    this.readVmStat = readVmStat;
  }

  /** @throws {Error} If `vm_stat` cannot be run or omits a counter. */
  async read(): Promise<HostMemoryReading> {
    const output = await this.readVmStat();
    const pageSize = HostMemoryProbe.parsePageSize(output);
    const field = (label: string) => HostMemoryProbe.parseField(output, label);

    // App Memory = internal (anonymous) pages minus the reclaimable purgeable ones.
    const appPages = Math.max(field('Anonymous pages') - field('Pages purgeable'), 0);
    const usedPages = appPages + field('Pages wired down') + field('Pages occupied by compressor');

    const total = os.totalmem();
    // Clamp: the two figures come from different sources, so the fraction could
    // otherwise round past 1 on a busy machine.
    const used = Math.min(usedPages * pageSize, total);
    return { total, used, available: total - used };
  }

  /** Apple silicon uses 16384-byte pages and Intel 4096, so never hardcode it. */
  private static parsePageSize(output: string): number {
    const match = output.match(/page size of (\d+) bytes/);
    if (!match) {
      throw new Error('vm_stat did not report a page size');
    }
    return Number(match[1]);
  }

  private static parseField(output: string, label: string): number {
    const match = output.match(new RegExp(`^${label}:\\s+(\\d+)\\.`, 'm'));
    if (!match) {
      throw new Error(`vm_stat missing field: ${label}`);
    }
    return Number(match[1]);
  }

  private static runVmStat(): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(VM_STAT_PATH, { timeout: VM_STAT_TIMEOUT_MS }, (error, stdout) => {
        if (error) {
          reject(new Error(`vm_stat failed: ${error.message}`));
          return;
        }
        resolve(stdout);
      });
    });
  }
}

export default HostMemoryProbe;
