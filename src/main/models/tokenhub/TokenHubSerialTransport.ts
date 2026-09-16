import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

export interface TokenHubCommandResponse {
  status: number;
  data: Buffer;
}

export interface TokenHubCommandTransport {
  sendCommand(command: number, payload?: Buffer): Promise<TokenHubCommandResponse>;
  close(): Promise<void>;
}

const MAX_FRAME_PAYLOAD_SIZE = 0xffff;
const MAX_ERROR_RESPONSE_SIZE = 16;
const RESPONSE_HEADER_SIZE = 3;
const EXTERNAL_FILE_READ_RESPONSE_PREFIX_SIZE = 4;
const SERIAL_RETRY_DELAY_MS = 10;
const RECEIVE_DRAIN_BUFFER_SIZE = 4 * 1024;
const MAX_RECEIVE_DRAIN_BYTES = RESPONSE_HEADER_SIZE + MAX_FRAME_PAYLOAD_SIZE + 1;

const FIXED_RESPONSE_LIMITS = new Map<number, number>([
  [0xa0, 8 + 1_312],
  [0xa2, 2 + 1_440],
  [0xa3, 4],
  [0xa5, 4 + 2_420],
  [0xac, 20],
  [0xb2, 2 + 128],
  [0xb6, 60],
  [0xb7, 16 + 4 + 2 + 2_420],
  [0xb8, 4 + 4 + 2 + 2_420],
  [0xb9, 1]
]);

/** Returns the largest framed response valid for a Dongle command and its request payload. */
export function tokenHubResponseLimit(command: number, payload: Buffer = Buffer.alloc(0)): number {
  if (command === 0xad && payload.length === 6) {
    const requestedSize = payload.readUInt16LE(4);
    return Math.max(
      MAX_ERROR_RESPONSE_SIZE,
      Math.min(MAX_FRAME_PAYLOAD_SIZE, EXTERNAL_FILE_READ_RESPONSE_PREFIX_SIZE + requestedSize)
    );
  }
  return Math.max(MAX_ERROR_RESPONSE_SIZE, FIXED_RESPONSE_LIMITS.get(command) ?? 0);
}

/** Pure framing helper kept public so protocol bytes can be regression-tested. */
export function encodeTokenHubRequest(command: number, payload: Uint8Array = Buffer.alloc(0)): Buffer {
  if (!Number.isInteger(command) || command < 0 || command > 0xff) {
    throw new Error(`Invalid Amis Hub command: ${command}`);
  }
  if (payload.length > 0xffff) {
    throw new Error(`Amis Hub command 0x${command.toString(16)} payload is too large.`);
  }
  const request = Buffer.allocUnsafe(3 + payload.length);
  request[0] = command;
  request.writeUInt16LE(payload.length, 1);
  Buffer.from(payload).copy(request, 3);
  return request;
}

export function decodeTokenHubResponseHeader(header: Buffer): { status: number; length: number } {
  if (header.length !== 3) throw new Error(`Amis Hub response header is ${header.length}/3 bytes.`);
  return { status: header[0], length: header.readUInt16LE(1) };
}

function isSerialWouldBlock(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EAGAIN' || code === 'EWOULDBLOCK';
}

function configureSerialPort(path: string, baudRate: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/stty',
      ['-f', path, String(baudRate), 'raw', 'clocal', 'cread', 'cs8', '-cstopb', '-parenb'],
      (error) => {
        if (error) {
          reject(new Error(`Could not configure Amis Hub serial port ${path}: ${error.message}`));
          return;
        }
        resolve();
      }
    );
  });
}

/** Async request/response transport for the Hub firmware's 3-byte frame header. */
export class TokenHubSerialTransport implements TokenHubCommandTransport {
  private handle: FileHandle | null = null;
  private commandQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly baudRate = 921_600,
    private readonly timeoutMs = 10_000
  ) {}

  async open(): Promise<void> {
    if (this.handle) return;
    const flags = constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK;
    const handle = await open(this.path, flags).catch((error: NodeJS.ErrnoException) => {
      throw new Error(`Could not open Amis Hub serial port ${this.path}: ${error.message}`);
    });
    try {
      await configureSerialPort(this.path, this.baudRate);
      this.handle = handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  sendCommand(command: number, payload = Buffer.alloc(0)): Promise<TokenHubCommandResponse> {
    const attempt = this.commandQueue.then(() => this.performCommand(command, payload));
    this.commandQueue = attempt.then(() => undefined, () => undefined);
    return attempt;
  }

  async close(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    await handle?.close().catch(() => undefined);
  }

  private async performCommand(command: number, payload: Buffer): Promise<TokenHubCommandResponse> {
    const request = encodeTokenHubRequest(command, payload);
    const deadline = performance.now() + this.timeoutMs;
    try {
      await this.drainReceiveBuffer(deadline);
      await this.writeAll(request, deadline);
      const header = await this.readExact(RESPONSE_HEADER_SIZE, deadline);
      const response = decodeTokenHubResponseHeader(header);
      const responseLimit = tokenHubResponseLimit(command, payload);
      if (response.length > responseLimit) {
        throw new Error(
          `Amis Hub command 0x${command.toString(16).toUpperCase().padStart(2, '0')} ` +
          `response is ${response.length} bytes; limit is ${responseLimit}.`
        );
      }
      const data = await this.readExact(response.length, deadline);
      return { status: response.status, data };
    } catch (error) {
      // Drop a partial or rejected frame so the next queued command starts cleanly.
      await this.drainReceiveBuffer(performance.now() + this.timeoutMs).catch(() => undefined);
      throw error;
    }
  }

  private requireHandle(): FileHandle {
    if (!this.handle) throw new Error(`Amis Hub serial port is closed: ${this.path}`);
    return this.handle;
  }

  private async writeAll(data: Buffer, deadline: number): Promise<void> {
    let written = 0;
    while (written < data.length) {
      if (performance.now() >= deadline) {
        throw new Error(`Amis Hub serial write timed out on ${this.path}: ${written}/${data.length} bytes`);
      }
      try {
        const result = await this.requireHandle().write(data, written, data.length - written, null);
        if (result.bytesWritten === 0) {
          await this.waitForSerialRetry(deadline);
          continue;
        }
        written += result.bytesWritten;
      } catch (error) {
        if (!isSerialWouldBlock(error)) throw error;
        await this.waitForSerialRetry(deadline);
      }
    }
  }

  private async readExact(length: number, deadline: number): Promise<Buffer> {
    if (length === 0) return Buffer.alloc(0);
    const result = Buffer.allocUnsafe(length);
    let received = 0;
    while (received < length) {
      if (performance.now() >= deadline) {
        throw new Error(`Amis Hub serial read timed out on ${this.path}: ${received}/${length} bytes`);
      }
      try {
        const read = await this.requireHandle().read(result, received, length - received, null);
        if (read.bytesRead === 0) {
          await this.waitForSerialRetry(deadline);
          continue;
        }
        received += read.bytesRead;
      } catch (error) {
        if (!isSerialWouldBlock(error)) throw error;
        await this.waitForSerialRetry(deadline);
      }
    }
    return result;
  }

  private async drainReceiveBuffer(deadline: number): Promise<void> {
    const buffer = Buffer.allocUnsafe(RECEIVE_DRAIN_BUFFER_SIZE);
    let discarded = 0;
    while (discarded < MAX_RECEIVE_DRAIN_BYTES) {
      if (performance.now() >= deadline) {
        throw new Error(`Amis Hub serial receive drain timed out on ${this.path}.`);
      }
      try {
        const remaining = Math.min(buffer.length, MAX_RECEIVE_DRAIN_BYTES - discarded);
        const read = await this.requireHandle().read(buffer, 0, remaining, null);
        if (read.bytesRead === 0) return;
        discarded += read.bytesRead;
      } catch (error) {
        if (isSerialWouldBlock(error)) return;
        throw error;
      }
    }
    throw new Error(`Amis Hub serial receive drain exceeded ${MAX_RECEIVE_DRAIN_BYTES} bytes on ${this.path}.`);
  }

  private async waitForSerialRetry(deadline: number): Promise<void> {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(SERIAL_RETRY_DELAY_MS, remaining)));
  }
}

export default TokenHubSerialTransport;
