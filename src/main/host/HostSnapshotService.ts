import type { HostMachineInfo, HostResourceGauge, HostResourceId, HostSnapshot } from '../../shared/types';
import { formatBinaryGB, formatDecimalGB } from '../../shared/byteFormatting';
import HostDiskProbe from './HostDiskProbe';
import HostMachineIdentity from './HostMachineIdentity';
import HostMemoryProbe from './HostMemoryProbe';

/** Each metric prints in the unit macOS itself uses for it. */
type ByteFormatter = (bytes: number) => string;

/** Collaborators the service builds itself unless a caller supplies one. */
export interface HostSnapshotServiceOptions {
  memoryProbe?: HostMemoryProbe;
  diskProbe?: HostDiskProbe;
  machineIdentity?: HostMachineIdentity;
}

/**
 * Assembles the "This Mac" card payload: the cached static machine description
 * plus one freshly probed gauge per live resource.
 *
 * All arithmetic and formatting happen here so the renderer only draws a bar
 * from `usedFraction` and prints two strings — it never sees bytes.
 */
export class HostSnapshotService {
  private readonly memoryProbe: HostMemoryProbe;
  private readonly diskProbe: HostDiskProbe;
  private readonly machineIdentity: HostMachineIdentity;
  /** Static info never changes while the app runs, so it is read once. */
  private machine: HostMachineInfo | null = null;
  /** A failed probe keeps its previous reading rather than zeroing the bar. */
  private readonly lastGauges = new Map<HostResourceId, HostResourceGauge>();

  constructor(options: HostSnapshotServiceOptions = {}) {
    this.memoryProbe = options.memoryProbe ?? new HostMemoryProbe();
    this.diskProbe = options.diskProbe ?? new HostDiskProbe();
    this.machineIdentity = options.machineIdentity ?? new HostMachineIdentity();
  }

  /** One reading of everything the card shows. Never throws into the render path. */
  async snapshot(): Promise<HostSnapshot> {
    const [machine, memory, disk] = await Promise.all([
      this.readMachine(),
      this.readMemoryGauge(),
      this.readDiskGauge()
    ]);
    // A gauge is absent only when its probe failed and no earlier reading exists;
    // the card then renders the machine row on its own.
    return { machine, gauges: [memory, disk].filter((gauge) => gauge !== null) };
  }

  private async readMachine(): Promise<HostMachineInfo> {
    if (!this.machine) {
      this.machine = await this.machineIdentity.read();
    }
    return this.machine;
  }

  private async readMemoryGauge(): Promise<HostResourceGauge | null> {
    return this.buildGauge('memory', 'Memory used', formatBinaryGB, async () => {
      const { total, available } = await this.memoryProbe.read();
      return { total, available };
    });
  }

  private async readDiskGauge(): Promise<HostResourceGauge | null> {
    return this.buildGauge('disk', 'Disk used', formatDecimalGB, async () => {
      const { total, free } = await this.diskProbe.read();
      return { total, available: free };
    });
  }

  /**
   * Both metrics share the same arithmetic, so they share the same builder;
   * only the unit their bytes are printed in differs.
   * A probe failure resolves to the last good gauge and is only logged.
   */
  private async buildGauge(
    id: HostResourceId,
    label: string,
    format: ByteFormatter,
    probe: () => Promise<{ total: number; available: number }>
  ): Promise<HostResourceGauge | null> {
    try {
      const { total, available } = await probe();
      const used = Math.max(total - available, 0);
      const usedFraction = total > 0 ? Math.min(used / total, 1) : 0;
      const gauge: HostResourceGauge = {
        id,
        label,
        usedFraction,
        percentText: `${Math.round(usedFraction * 100)}%`,
        detailText: `${format(available)} free of ${format(total)}`
      };
      this.lastGauges.set(id, gauge);
      return gauge;
    } catch (error) {
      console.error(`[HostSnapshotService] ${id} probe failed:`, error);
      return this.lastGauges.get(id) ?? null;
    }
  }
}

export default HostSnapshotService;
