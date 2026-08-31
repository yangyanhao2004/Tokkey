import { execFile } from 'node:child_process';
import type { TokenHubDevice } from '../../../shared/types';

const DEFAULT_VENDOR_ID = 0x8888;
const DEFAULT_PRODUCT_ID = 0x0007;

type IoregRunner = () => Promise<string>;

interface IoregNode {
  indentation: number;
  className: string;
  startLine: number;
}

function readIntegerProperty(lines: string[], key: string): number | null {
  const pattern = new RegExp(`"${key}"\\s*=\\s*(\\d+)`);
  for (const line of lines) {
    const match = line.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

function readStringProperty(lines: string[], keys: readonly string[]): string | null {
  for (const key of keys) {
    const pattern = new RegExp(`"${key}"\\s*=\\s*"([^"]+)"`);
    for (const line of lines) {
      const match = line.match(pattern);
      if (match) return match[1];
    }
  }
  return null;
}

function parseNode(line: string, startLine: number): IoregNode | null {
  const match = line.match(/^([ |]*)\+-o .*<class ([^,>]+)/);
  if (!match) return null;
  return { indentation: match[1].length, className: match[2], startLine };
}

/** Parses matching IOUSBHostDevice subtrees and their descendant serial clients. */
export function parseIoregUsbDevices(
  output: string,
  vendorId = DEFAULT_VENDOR_ID,
  productId = DEFAULT_PRODUCT_ID
): TokenHubDevice[] {
  const lines = output.split(/\r?\n/);
  const nodes = lines.flatMap((line, index) => {
    const node = parseNode(line, index);
    return node ? [node] : [];
  });
  const devices = new Map<string, TokenHubDevice>();

  nodes.forEach((node, nodeIndex) => {
    if (node.className !== 'IOUSBHostDevice') return;
    const nextBoundary = nodes.slice(nodeIndex + 1).find(
      (candidate) => candidate.indentation <= node.indentation
    );
    const endLine = nextBoundary?.startLine ?? lines.length;
    const firstChild = nodes.slice(nodeIndex + 1).find(
      (candidate) => candidate.startLine < endLine && candidate.indentation > node.indentation
    );
    const propertyLines = lines.slice(node.startLine + 1, firstChild?.startLine ?? endLine);
    if (
      readIntegerProperty(propertyLines, 'idVendor') !== vendorId ||
      readIntegerProperty(propertyLines, 'idProduct') !== productId
    ) {
      return;
    }

    const subtree = lines.slice(node.startLine + 1, endLine);
    const calloutPath = readStringProperty(subtree, ['IOCalloutDevice']);
    if (!calloutPath) return;
    const serialNumber = readStringProperty(propertyLines, [
      'kUSBSerialNumberString',
      'USB Serial Number'
    ]);
    const locationNumber = readIntegerProperty(propertyLines, 'locationID');
    const location = locationNumber === null
      ? null
      : locationNumber.toString(16).toUpperCase().padStart(8, '0');
    const stableComponent = serialNumber ?? location ?? calloutPath;
    const identity = [vendorId, productId]
      .map((value) => value.toString(16).toUpperCase().padStart(4, '0'))
      .concat(stableComponent)
      .join(':');
    devices.set(calloutPath, { identity, calloutPath, serialNumber, location });
  });

  return [...devices.values()].sort((left, right) =>
    left.calloutPath.localeCompare(right.calloutPath)
  );
}

function runIoreg(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/sbin/ioreg',
      ['-r', '-c', 'IOUSBHostDevice', '-l', '-w', '0'],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(new Error(`Could not inspect USB devices: ${error.message}`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

/** Finds the serial endpoint belonging to the supported USB VID/PID. */
export class TokenHubDeviceProbe {
  constructor(private readonly ioregRunner: IoregRunner = runIoreg) {}

  async connectedDevices(
    vendorId = DEFAULT_VENDOR_ID,
    productId = DEFAULT_PRODUCT_ID
  ): Promise<TokenHubDevice[]> {
    if (process.platform !== 'darwin') return [];
    return parseIoregUsbDevices(await this.ioregRunner(), vendorId, productId);
  }
}

export default TokenHubDeviceProbe;
