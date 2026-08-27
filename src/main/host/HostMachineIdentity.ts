import { execFile } from 'node:child_process';
import os from 'node:os';
import type { HostMachineInfo } from '../../shared/types';

/** Seam over the identity commands so the parsers can be tested without forks. */
export type CommandRunner = (file: string, args: readonly string[]) => Promise<string>;

/** These are cheap reads (~15ms), but a hung fork must not block the window. */
const COMMAND_TIMEOUT_MS = 5000;

/**
 * Reads the static hardware and system description of the Mac the app runs on:
 * marketing model name, chip, macOS version, and installed memory.
 *
 * None of it changes while the app runs, so `HostSnapshotService` reads it once
 * and caches it. Every field degrades to a usable fallback instead of throwing,
 * because a missing model name should not cost the user their gauges.
 */
export class HostMachineIdentity {
  private readonly runCommand: CommandRunner;

  constructor(runCommand: CommandRunner = HostMachineIdentity.runCommandLine) {
    this.runCommand = runCommand;
  }

  async read(): Promise<HostMachineInfo> {
    const [deviceModel, chip, osVersion] = await Promise.all([
      this.readDeviceModel(),
      this.readChip(),
      this.readOsVersion()
    ]);
    const totalMemoryBytes = os.totalmem();
    return {
      deviceModel,
      chip,
      osVersion,
      totalMemoryBytes,
      detailText: HostMachineIdentity.describe(deviceModel, chip, osVersion, totalMemoryBytes)
    };
  }

  /**
   * The subtitle under "This Mac", e.g.
   * "MacBook Air (13-inch, M5) · 24 GB unified memory · macOS 26.4".
   * Apple silicon shares one memory pool between CPU and GPU, which is what
   * "unified" names; Intel Macs do not, so they get the plain wording.
   */
  static describe(deviceModel: string, chip: string, osVersion: string, totalMemoryBytes: number): string {
    const memoryKind = chip.startsWith('Apple') ? 'unified memory' : 'memory';
    const memory = `${Math.round(totalMemoryBytes / 1_073_741_824)} GB ${memoryKind}`;
    return [deviceModel, memory, `macOS ${osVersion}`].join(' · ');
  }

  /**
   * Marketing name from the device tree, e.g. "MacBook Air (13-inch, M5)".
   * Falls back to the `hw.model` board identifier ("Mac17,3"), which is always
   * available but not something a user recognises.
   */
  private async readDeviceModel(): Promise<string> {
    const boardIdentifier = await this.readSysctl('hw.model');
    const registry = await this.tryRun('/usr/sbin/ioreg', ['-arc', 'IOPlatformDevice', '-k', 'product-name']);
    const productName = HostMachineIdentity.parseProductName(registry);
    return productName || boardIdentifier || 'Mac';
  }

  /** `ioreg -a` emits a plist where `product-name` is a NUL-terminated base64 blob. */
  private static parseProductName(plist: string): string {
    const match = plist.match(/<key>product-name<\/key>\s*<data>\s*([^<\s]+)\s*<\/data>/);
    if (!match) return '';
    return Buffer.from(match[1], 'base64').toString('utf8').replace(/\0+$/, '').trim();
  }

  /** CPU brand string, e.g. "Apple M5". */
  private async readChip(): Promise<string> {
    return (await this.readSysctl('machdep.cpu.brand_string')) || 'Apple Silicon';
  }

  /**
   * The user-facing macOS version, e.g. "26.4". `os.release()` is the Darwin
   * kernel version ("25.4.0") and would read as a different OS entirely.
   */
  private async readOsVersion(): Promise<string> {
    return (await this.tryRun('/usr/bin/sw_vers', ['-productVersion'])).trim() || os.release();
  }

  private async readSysctl(name: string): Promise<string> {
    return (await this.tryRun('/usr/sbin/sysctl', ['-n', name])).trim();
  }

  /** Identity is decoration, not function: an unavailable command yields "". */
  private async tryRun(file: string, args: readonly string[]): Promise<string> {
    try {
      return await this.runCommand(file, args);
    } catch (error) {
      console.error(`[HostMachineIdentity] ${file} failed:`, error);
      return '';
    }
  }

  private static runCommandLine(file: string, args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(file, [...args], { timeout: COMMAND_TIMEOUT_MS }, (error, stdout) => {
        if (error) {
          reject(new Error(`${file} failed: ${error.message}`));
          return;
        }
        resolve(stdout);
      });
    });
  }
}

export default HostMachineIdentity;
