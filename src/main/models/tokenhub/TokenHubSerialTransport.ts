import { execFile } from 'node:child_process';
import { open, type FileHandle } from 'node:fs/promises';

export interface TokenHubCommandResponse {
  status: number;
  data: Buffer;
}

export interface TokenHubCommandTransport {
  sendCommand(command: number, payload?: Buffer): Promise<TokenHubCommandResponse>;
  close(): Promise<void>;
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
    const handle = await open(this.path, 'r+').catch((error: NodeJS.ErrnoException) => {
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
    await this.writeAll(request);
    const header = await this.readExact(3);
    const response = decodeTokenHubResponseHeader(header);
    const data = await this.readExact(response.length);
    return { status: response.status, data };
  }

  private requireHandle(): FileHandle {
    if (!this.handle) throw new Error(`Amis Hub serial port is closed: ${this.path}`);
    return this.handle;
  }

  private async writeAll(data: Buffer): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    let written = 0;
    while (written < data.length) {
      if (Date.now() >= deadline) {
        throw new Error(`Amis Hub serial write timed out on ${this.path}: ${written}/${data.length} bytes`);
      }
      const result = await this.requireHandle().write(data, written, data.length - written, null);
      if (result.bytesWritten === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      written += result.bytesWritten;
    }
  }

  private async readExact(length: number): Promise<Buffer> {
    if (length === 0) return Buffer.alloc(0);
    const result = Buffer.allocUnsafe(length);
    const deadline = Date.now() + this.timeoutMs;
    let received = 0;
    while (received < length) {
      if (Date.now() >= deadline) {
        throw new Error(`Amis Hub serial read timed out on ${this.path}: ${received}/${length} bytes`);
      }
      const read = await this.requireHandle().read(result, received, length - received, null);
      if (read.bytesRead === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      received += read.bytesRead;
    }
    return result;
  }
}

export default TokenHubSerialTransport;
