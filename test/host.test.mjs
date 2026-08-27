import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';

import { HostDiskProbe } from '../dist/main/host/HostDiskProbe.js';
import { HostMachineIdentity } from '../dist/main/host/HostMachineIdentity.js';
import { HostMemoryProbe } from '../dist/main/host/HostMemoryProbe.js';
import { HostSnapshotService } from '../dist/main/host/HostSnapshotService.js';

/** Real `vm_stat` output, trimmed to the counters the formula reads. */
const VM_STAT_OUTPUT = [
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free:                                8000.',
  'Pages active:                            100000.',
  'Pages inactive:                           50000.',
  'Pages speculative:                         2000.',
  'Pages wired down:                         30000.',
  'Pages purgeable:                           5000.',
  'File-backed pages:                        60000.',
  'Anonymous pages:                          92000.',
  'Pages occupied by compressor:             10000.'
].join('\n');

/** `statfs` values for a 1000-block volume with 250 blocks left to a user. */
const STATFS_READING = { blocks: 1000, bsize: 1_073_741_824, bavail: 250 };

/** Foundation is unavailable, so every reading falls through to `statfs`. */
const NO_FOUNDATION = async () => null;

/** Identity command output keyed the way `HostMachineIdentity` invokes them. */
class StubCommandLine {
  constructor(responses) {
    this.responses = responses;
    this.calls = [];
  }

  runner() {
    return async (file, args) => {
      const key = [file, ...args].join(' ');
      this.calls.push(key);
      const response = this.responses[key];
      if (response === undefined) throw new Error(`unexpected command: ${key}`);
      return response;
    };
  }
}

const APPLE_SILICON_COMMANDS = {
  '/usr/sbin/sysctl -n hw.model': 'Mac17,3\n',
  '/usr/sbin/sysctl -n machdep.cpu.brand_string': 'Apple M5\n',
  '/usr/bin/sw_vers -productVersion': '26.4\n',
  // `product-name` is a NUL-terminated base64 blob: "MacBook Air (13-inch, M5)\0".
  '/usr/sbin/ioreg -arc IOPlatformDevice -k product-name': [
    '<plist version="1.0"><array><dict>',
    '<key>product-name</key>',
    '<data>',
    'TWFjQm9vayBBaXIgKDEzLWluY2gsIE01KQA=',
    '</data>',
    '</dict></array></plist>'
  ].join('\n')
};

test('memory probe reproduces the Activity Monitor used-memory formula', async () => {
  const probe = new HostMemoryProbe(async () => VM_STAT_OUTPUT);

  const reading = await probe.read();

  // (92000 - 5000 app) + 30000 wired + 10000 compressor = 127000 pages of 16 KiB.
  assert.equal(reading.used, 127_000 * 16_384);
  assert.equal(reading.total, os.totalmem());
  assert.equal(reading.available, reading.total - reading.used);
});

test('memory probe parses the page size instead of assuming Apple silicon', async () => {
  const intelOutput = VM_STAT_OUTPUT.replace('page size of 16384', 'page size of 4096');

  const reading = await new HostMemoryProbe(async () => intelOutput).read();

  assert.equal(reading.used, 127_000 * 4096);
});

test('memory probe reports which vm_stat counter is missing', async () => {
  const truncated = VM_STAT_OUTPUT.replace(/^Pages purgeable.*$/m, '');

  await assert.rejects(
    () => new HostMemoryProbe(async () => truncated).read(),
    /missing field: Pages purgeable/
  );
});

test('memory probe clamps used memory to the installed total', async () => {
  // A page count far past physical RAM must not produce a fraction above 1.
  const overshoot = VM_STAT_OUTPUT.replace('Pages wired down:                         30000.', 'Pages wired down:                    999999999.');

  const reading = await new HostMemoryProbe(async () => overshoot).read();

  assert.equal(reading.used, reading.total);
  assert.equal(reading.available, 0);
});

test('disk probe prefers the Finder-visible capacity, which counts purgeable space', async () => {
  const paths = [];
  // Foundation counts ~40 GB of purgeable data that statfs omits entirely.
  const probe = new HostDiskProbe(
    '/System/Volumes/Data',
    async (path) => {
      paths.push(path);
      return { total: 494_384_795_648, free: 209_961_166_061 };
    },
    async () => STATFS_READING
  );

  const reading = await probe.read();

  assert.deepEqual(paths, ['/System/Volumes/Data']);
  assert.equal(reading.free, 209_961_166_061);
});

test('disk probe falls back to statfs when Foundation cannot be reached', async () => {
  const probe = new HostDiskProbe(
    '/System/Volumes/Data',
    async () => {
      throw new Error('osascript failed');
    },
    async () => STATFS_READING
  );

  const reading = await probe.read();

  assert.equal(reading.total, 1000 * 1_073_741_824);
  // `bavail`, not `bfree`: root's reserve blocks are not ours to spend.
  assert.equal(reading.free, 250 * 1_073_741_824);
});

test('disk probe rejects an empty Foundation reading rather than showing a zero bar', async () => {
  const probe = new HostDiskProbe('/System/Volumes/Data', async () => null, async () => STATFS_READING);

  const reading = await probe.read();

  assert.equal(reading.total, 1000 * 1_073_741_824);
});

test('machine identity decodes the marketing model name from the device tree', async () => {
  const commandLine = new StubCommandLine(APPLE_SILICON_COMMANDS);

  const info = await new HostMachineIdentity(commandLine.runner()).read();

  assert.equal(info.deviceModel, 'MacBook Air (13-inch, M5)');
  assert.equal(info.chip, 'Apple M5');
  assert.equal(info.osVersion, '26.4');
  assert.equal(info.totalMemoryBytes, os.totalmem());
});

test('machine identity falls back to the board identifier when ioreg fails', async () => {
  const commandLine = new StubCommandLine({
    ...APPLE_SILICON_COMMANDS,
    '/usr/sbin/ioreg -arc IOPlatformDevice -k product-name': undefined
  });

  const info = await new HostMachineIdentity(commandLine.runner()).read();

  assert.equal(info.deviceModel, 'Mac17,3');
});

test('machine identity names unified memory only on Apple silicon', () => {
  const appleSilicon = HostMachineIdentity.describe('MacBook Air (13-inch, M5)', 'Apple M5', '26.4', 24 * 1_073_741_824);
  const intel = HostMachineIdentity.describe('MacBook Pro (16-inch, 2019)', 'Intel Core i9', '15.7', 16 * 1_073_741_824);

  assert.equal(appleSilicon, 'MacBook Air (13-inch, M5) · 24 GB unified memory · macOS 26.4');
  assert.equal(intel, 'MacBook Pro (16-inch, 2019) · 16 GB memory · macOS 15.7');
});

/** Probes returning fixed byte totals, so gauge arithmetic is the only variable. */
class StubProbes {
  static memory(total, available) {
    return { read: async () => ({ total, used: total - available, available }) };
  }

  static disk(total, free) {
    return { read: async () => ({ total, free }) };
  }

  static failing(message) {
    return {
      read: async () => {
        throw new Error(message);
      }
    };
  }
}

/** Identity that never forks, so snapshot tests stay off the real machine. */
const STUB_IDENTITY = {
  read: async () => ({
    deviceModel: 'MacBook Air (13-inch, M5)',
    chip: 'Apple M5',
    osVersion: '26.4',
    totalMemoryBytes: 24 * 1_073_741_824,
    detailText: 'MacBook Air (13-inch, M5) · 24 GB unified memory · macOS 26.4'
  })
};

function createService(overrides = {}) {
  return new HostSnapshotService({
    memoryProbe: StubProbes.memory(18 * 1_073_741_824, 7.3 * 1_073_741_824),
    // Real byte counts from a 494 GB Mac, so the units under test are the real ones.
    diskProbe: StubProbes.disk(494_384_795_648, 209_961_166_061),
    machineIdentity: STUB_IDENTITY,
    ...overrides
  });
}

test('snapshot formats both gauges the way the design reads them', async () => {
  const snapshot = await createService().snapshot();

  const [memory, disk] = snapshot.gauges;
  assert.equal(memory.label, 'Memory used');
  assert.equal(memory.percentText, '59%');
  // One decimal below 10 GB, none at or above it.
  assert.equal(memory.detailText, '7.3 GB free of 18 GB');
  assert.equal(disk.percentText, '58%');
  assert.equal(disk.detailText, '210 GB free of 494 GB');
  assert.equal(snapshot.machine.detailText, 'MacBook Air (13-inch, M5) · 24 GB unified memory · macOS 26.4');
});

test('memory reads as binary GB and disk as decimal GB, matching macOS itself', async () => {
  // The same byte count, printed by each metric's own convention.
  const bytes = 494_384_795_648;
  const service = createService({
    memoryProbe: StubProbes.memory(bytes, bytes),
    diskProbe: StubProbes.disk(bytes, bytes)
  });

  const [memory, disk] = (await service.snapshot()).gauges;

  // About This Mac would call this 460 GB; Finder would call it 494 GB.
  assert.equal(memory.detailText, '460 GB free of 460 GB');
  assert.equal(disk.detailText, '494 GB free of 494 GB');
});

test('snapshot reads static machine info once and re-reads the gauges', async () => {
  let identityReads = 0;
  const service = createService({
    machineIdentity: {
      read: async () => {
        identityReads += 1;
        return STUB_IDENTITY.read();
      }
    }
  });

  await service.snapshot();
  await service.snapshot();

  assert.equal(identityReads, 1);
});

test('a failed probe keeps its last good gauge instead of zeroing the bar', async () => {
  const memoryProbe = { read: async () => ({ total: 100, used: 40, available: 60 }) };
  const service = createService({ memoryProbe });

  const first = await service.snapshot();
  memoryProbe.read = async () => {
    throw new Error('vm_stat failed');
  };
  const second = await service.snapshot();

  assert.equal(first.gauges[0].percentText, '40%');
  assert.deepEqual(second.gauges[0], first.gauges[0]);
});

test('a first reading that fails drops the gauge rather than throwing', async () => {
  const service = createService({ memoryProbe: StubProbes.failing('vm_stat failed') });

  const snapshot = await service.snapshot();

  assert.deepEqual(snapshot.gauges.map((gauge) => gauge.id), ['disk']);
});

test('gauges stay at zero when a total is unknown', async () => {
  const service = createService({ memoryProbe: StubProbes.memory(0, 0) });

  const [memory] = (await service.snapshot()).gauges;

  assert.equal(memory.usedFraction, 0);
  assert.equal(memory.percentText, '0%');
});
