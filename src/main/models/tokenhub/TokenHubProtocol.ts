import {
  createHash,
  createHmac,
  createPublicKey,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  verify
} from 'node:crypto';
import type {
  TokenHubCommandResponse,
  TokenHubCommandTransport
} from './TokenHubSerialTransport';

const DEVICE_ID_SIZE = 8;
const PUBLIC_KEY_SIZE = 1_312;
const SIGNATURE_SIZE = 2_420;
const NONCE_SIZE = 32;
const SESSION_ID_SIZE = 16;
const KEY_ID_SIZE = 8;
const API_KEY_PREFIX = 'sk_dongle_v1_';
const API_KEY_LENGTH = 73;
const AUTHENTICATION_CONTEXT = Buffer.alloc(14);

const COMMAND = {
  getPublicKey: 0xa0,
  getStatus: 0xa3,
  signChallenge: 0xa5,
  externalFileInfo: 0xac,
  externalFileRead: 0xad,
  readApplicationManifest: 0xb2,
  deriveApiKey: 0xb5,
  authBegin: 0xb6,
  authProve: 0xb7,
  authRefresh: 0xb8,
  authClose: 0xb9
} as const;

export const TOKEN_HUB_EXTERNAL_READ_CHUNK_SIZE = 0xffff - 4;

export interface TokenHubCredential {
  deviceId: Buffer;
  keyEpoch: number;
  keyId: Buffer;
  apiKey: string;
  keyMaterial: Buffer;
}

export interface TokenHubApplicationManifest {
  deviceId: Buffer;
  fileSize: number;
  fileCrc32: number;
  fileSha256: Buffer;
  generation: bigint;
}

function commandName(command: number): string {
  return `0x${command.toString(16).toUpperCase().padStart(2, '0')}`;
}

function assertLength(command: number, data: Buffer, expected: number, description: string): void {
  if (data.length !== expected) {
    throw new Error(
      `Amis Hub command ${commandName(command)} returned ${data.length} bytes; expected ${description}.`
    );
  }
}

function appendUInt32(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function equalsConstantTime(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Wraps the firmware's raw ML-DSA-44 public key in a standards-compliant SPKI. */
export function wrapMldsa44PublicKey(publicKey: Buffer): Buffer {
  if (publicKey.length !== PUBLIC_KEY_SIZE) {
    throw new Error(`ML-DSA-44 public key is ${publicKey.length}/${PUBLIC_KEY_SIZE} bytes.`);
  }
  const header = Buffer.from([
    0x30, 0x82, 0x05, 0x32,
    0x30, 0x0b,
    0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x03, 0x11,
    0x03, 0x82, 0x05, 0x21, 0x00
  ]);
  return Buffer.concat([header, publicKey]);
}

/** Verifies the A5 challenge using ML-DSA-44 and the firmware's fixed context. */
export function verifyTokenHubChallenge(
  publicKey: Buffer,
  challenge: Buffer,
  signature: Buffer
): boolean {
  if (challenge.length !== NONCE_SIZE) {
    throw new Error(`ML-DSA-44 challenge is ${challenge.length}/${NONCE_SIZE} bytes.`);
  }
  if (signature.length !== SIGNATURE_SIZE) {
    throw new Error(`ML-DSA-44 signature is ${signature.length}/${SIGNATURE_SIZE} bytes.`);
  }
  const key = createPublicKey({ key: wrapMldsa44PublicKey(publicKey), format: 'der', type: 'spki' });
  return verify(null, challenge, { key, context: AUTHENTICATION_CONTEXT }, signature);
}

/** Parses the demo-trust v2 manifest used to bind Flash contents to the chip. */
export function parseTokenHubManifest(
  manifest: Buffer,
  expectedDeviceId: Buffer
): TokenHubApplicationManifest {
  if (manifest.length !== 128) throw new Error(`Amis Hub manifest has invalid length ${manifest.length}.`);
  if (!manifest.subarray(0, 4).equals(Buffer.from('AMF1'))) {
    throw new Error('Amis Hub manifest magic is not AMF1.');
  }
  const version = manifest.readUInt16LE(4);
  const flags = manifest.readUInt16LE(6);
  if (version !== 2 || flags !== 0) {
    throw new Error(`Amis Hub manifest version/flags ${version}/${flags} are unsupported.`);
  }
  const deviceId = manifest.subarray(8, 16);
  if (!deviceId.equals(expectedDeviceId)) {
    throw new Error(
      `Amis Hub manifest device ID ${deviceId.toString('hex')} does not match authenticated device ${expectedDeviceId.toString('hex')}.`
    );
  }
  const fileSize = manifest.readUInt32LE(16);
  if (fileSize === 0) throw new Error('Amis Hub manifest file size is zero.');
  return {
    deviceId: Buffer.from(deviceId),
    fileSize,
    fileCrc32: manifest.readUInt32LE(20),
    fileSha256: Buffer.from(manifest.subarray(24, 56)),
    generation: manifest.readBigUInt64LE(56)
  };
}

/** Typed asynchronous client for the firmware commands used during startup. */
export class TokenHubProtocolClient {
  constructor(private readonly transport: TokenHubCommandTransport) {}

  async authenticateIdentity(expectedDeviceId?: Buffer): Promise<Buffer> {
    const status = await this.requireOk(COMMAND.getStatus);
    if (status.length < 4) throw new Error('Amis Hub status response is incomplete.');
    if (status[0] !== 1 || status[1] !== 1) {
      throw new Error('Amis Hub has no generated key or provisioned certificate.');
    }

    const identity = await this.requireOk(COMMAND.getPublicKey);
    if (identity.length < DEVICE_ID_SIZE + PUBLIC_KEY_SIZE) {
      throw new Error('Amis Hub public-key response is incomplete.');
    }
    const deviceId = identity.subarray(0, DEVICE_ID_SIZE);
    if (expectedDeviceId && !deviceId.equals(expectedDeviceId)) {
      throw new Error(
        `Amis Hub device ID ${deviceId.toString('hex')} does not match ${expectedDeviceId.toString('hex')}.`
      );
    }
    const challenge = randomBytes(NONCE_SIZE);
    const signed = await this.requireOk(COMMAND.signChallenge, challenge);
    if (signed.length < 4) throw new Error('Amis Hub A5 response is incomplete.');
    const challengeLength = signed.readUInt16LE(0);
    const signatureLength = signed.readUInt16LE(2);
    if (
      challengeLength !== challenge.length ||
      signatureLength !== SIGNATURE_SIZE ||
      signed.length < 4 + signatureLength
    ) {
      throw new Error('Amis Hub A5 response has invalid challenge or signature lengths.');
    }
    const signature = signed.subarray(4, 4 + signatureLength);
    const publicKey = identity.subarray(DEVICE_ID_SIZE, DEVICE_ID_SIZE + PUBLIC_KEY_SIZE);
    if (!verifyTokenHubChallenge(publicKey, challenge, signature)) {
      throw new Error('Amis Hub challenge-response signature verification failed.');
    }
    return Buffer.from(deviceId);
  }

  async deriveCredential(): Promise<TokenHubCredential> {
    const data = await this.requireOk(COMMAND.deriveApiKey);
    const headerSize = DEVICE_ID_SIZE + 4 + KEY_ID_SIZE + 2;
    if (data.length < headerSize) throw new Error('Amis Hub B5 credential response is incomplete.');
    const deviceId = Buffer.from(data.subarray(0, DEVICE_ID_SIZE));
    const keyEpoch = data.readUInt32LE(DEVICE_ID_SIZE);
    const keyIdOffset = DEVICE_ID_SIZE + 4;
    const keyId = Buffer.from(data.subarray(keyIdOffset, keyIdOffset + KEY_ID_SIZE));
    const apiKeyLength = data.readUInt16LE(keyIdOffset + KEY_ID_SIZE);
    const apiKey = data.subarray(headerSize).toString('ascii');
    if (apiKeyLength !== API_KEY_LENGTH || data.length !== headerSize + apiKeyLength) {
      throw new Error('Amis Hub returned an invalid B5 API key length.');
    }
    const keyMaterial = this.parseApiKey(apiKey, deviceId);
    const derivedKeyId = createHash('sha256').update(keyMaterial).digest().subarray(0, KEY_ID_SIZE);
    if (!equalsConstantTime(keyId, derivedKeyId)) {
      throw new Error('Amis Hub API key identifier does not match its key material.');
    }
    return { deviceId, keyEpoch, keyId, apiKey, keyMaterial };
  }

  async beginAuthorization(keyId: Buffer, hostNonce: Buffer): Promise<{
    authId: Buffer;
    deviceId: Buffer;
    deviceNonce: Buffer;
    pendingTtl: number;
  }> {
    if (keyId.length !== KEY_ID_SIZE || hostNonce.length !== NONCE_SIZE) {
      throw new Error('Amis Hub B6 key ID or nonce length is invalid.');
    }
    const data = await this.requireOk(COMMAND.authBegin, Buffer.concat([Buffer.from([1]), keyId, hostNonce]));
    assertLength(COMMAND.authBegin, data, 60, 'a 60-byte authorization challenge');
    return {
      authId: Buffer.from(data.subarray(0, 16)),
      deviceId: Buffer.from(data.subarray(16, 24)),
      deviceNonce: Buffer.from(data.subarray(24, 56)),
      pendingTtl: data.readUInt32LE(56)
    };
  }

  async proveAuthorization(authId: Buffer, hostProof: Buffer): Promise<{
    sessionId: Buffer;
    leaseTtl: number;
    deviceProof: Buffer;
  }> {
    const data = await this.requireOk(COMMAND.authProve, Buffer.concat([authId, hostProof]));
    assertLength(COMMAND.authProve, data, 52, 'a 52-byte authorized session');
    return {
      sessionId: Buffer.from(data.subarray(0, 16)),
      leaseTtl: data.readUInt32LE(16),
      deviceProof: Buffer.from(data.subarray(20, 52))
    };
  }

  async refreshAuthorization(sessionId: Buffer, sequence: number, proof: Buffer): Promise<{
    sequence: number;
    remainingTtl: number;
    deviceProof: Buffer;
  }> {
    const data = await this.requireOk(
      COMMAND.authRefresh,
      Buffer.concat([sessionId, appendUInt32(sequence), proof])
    );
    assertLength(COMMAND.authRefresh, data, 40, 'a 40-byte lease refresh');
    return {
      sequence: data.readUInt32LE(0),
      remainingTtl: data.readUInt32LE(4),
      deviceProof: Buffer.from(data.subarray(8, 40))
    };
  }

  async closeAuthorization(sessionId: Buffer, sequence: number, proof: Buffer): Promise<void> {
    const data = await this.requireOk(
      COMMAND.authClose,
      Buffer.concat([sessionId, appendUInt32(sequence), proof])
    );
    if (!data.equals(Buffer.from([1]))) throw new Error('Amis Hub B9 response is invalid.');
  }

  async applicationManifest(): Promise<Buffer> {
    const response = await this.transport.sendCommand(COMMAND.readApplicationManifest);
    if (response.status === 0x09) throw new Error('Amis Hub manifest authentication expired.');
    if (response.status === 0x0b) throw new Error('Amis Hub application manifest is missing.');
    this.requireOkResponse(COMMAND.readApplicationManifest, response);
    if (response.data.length < 2 || response.data.readUInt16LE(0) !== 128 || response.data.length < 130) {
      throw new Error('Amis Hub application manifest response is malformed.');
    }
    return Buffer.from(response.data.subarray(2, 130));
  }

  async externalFileInfo(): Promise<{ fileSize: number; crc32: number }> {
    const data = await this.requireOk(COMMAND.externalFileInfo);
    if (data.length < 16) throw new Error('Amis Hub Flash metadata response is incomplete.');
    return { fileSize: data.readUInt32LE(0), crc32: data.readUInt32LE(4) };
  }

  async externalFileChunk(offset: number, size: number): Promise<Buffer> {
    if (size <= 0 || size > TOKEN_HUB_EXTERNAL_READ_CHUNK_SIZE) {
      throw new Error(`Invalid Amis Hub Flash read size: ${size}.`);
    }
    const payload = Buffer.allocUnsafe(6);
    payload.writeUInt32LE(offset, 0);
    payload.writeUInt16LE(size, 4);
    const data = await this.requireOk(COMMAND.externalFileRead, payload);
    if (data.length < 4) throw new Error('Amis Hub Flash read response is incomplete.');
    const returnedOffset = data.readUInt32LE(0);
    const chunk = data.subarray(4);
    if (returnedOffset !== offset || chunk.length !== size) {
      throw new Error(`Amis Hub Flash read mismatch at ${offset}: ${returnedOffset}/${chunk.length}.`);
    }
    return Buffer.from(chunk);
  }

  private async requireOk(command: number, payload = Buffer.alloc(0)): Promise<Buffer> {
    const response = await this.transport.sendCommand(command, payload);
    this.requireOkResponse(command, response);
    return response.data;
  }

  private requireOkResponse(command: number, response: TokenHubCommandResponse): void {
    if (response.status === 0) return;
    const hints: Record<number, string> = {
      0x05: 'external Flash initialization or I/O failed',
      0x0a: 'no valid external file header is present',
      0x0d: 'Dongle authorization failed',
      0x0e: 'Dongle authorization expired',
      0x0f: 'Dongle authorization state is invalid'
    };
    const hint = hints[response.status];
    throw new Error(
      `Amis Hub command ${commandName(command)} failed with status ${commandName(response.status)}` +
      (hint ? `: ${hint}` : '.')
    );
  }

  private parseApiKey(apiKey: string, expectedDeviceId: Buffer): Buffer {
    if (Buffer.byteLength(apiKey, 'ascii') !== API_KEY_LENGTH || !apiKey.startsWith(API_KEY_PREFIX)) {
      throw new Error('Amis Hub returned an API key with an unexpected format.');
    }
    const deviceStart = API_KEY_PREFIX.length;
    const separator = deviceStart + 16;
    if (
      apiKey[separator] !== '_' ||
      apiKey.slice(deviceStart, separator).toLowerCase() !== expectedDeviceId.toString('hex')
    ) {
      throw new Error('Amis Hub API key device identifier does not match the response.');
    }
    const keyMaterial = Buffer.from(apiKey.slice(separator + 1), 'base64url');
    if (keyMaterial.length !== 32) throw new Error('Amis Hub API key secret is not 32 bytes.');
    return keyMaterial;
  }
}

/** Owns and locally verifies the B6-B9 lease used while reading protected Flash. */
export class TokenHubLicenseSession {
  private sessionId: Buffer | null = null;
  private sessionKey: Buffer | null = null;
  private sequence = 0;
  private lastRefreshAt = 0;

  constructor(
    private readonly client: TokenHubProtocolClient,
    private readonly credential: TokenHubCredential,
    private readonly refreshIntervalMs = 30_000
  ) {}

  async authenticate(): Promise<void> {
    const hostNonce = randomBytes(NONCE_SIZE);
    const challenge = await this.client.beginAuthorization(this.credential.keyId, hostNonce);
    if (!challenge.deviceId.equals(this.credential.deviceId)) {
      throw new Error('Amis Hub B6 device ID does not match the authenticated identity.');
    }
    const hostProof = hmac(
      this.credential.keyMaterial,
      this.transcript('HOST', hostNonce, challenge.deviceNonce, challenge.authId)
    );
    const authorized = await this.client.proveAuthorization(challenge.authId, hostProof);
    const deviceTranscript = Buffer.concat([
      this.transcript('DONGLE', hostNonce, challenge.deviceNonce, challenge.authId),
      authorized.sessionId,
      appendUInt32(authorized.leaseTtl)
    ]);
    const expectedProof = hmac(this.credential.keyMaterial, deviceTranscript);
    this.sessionId = authorized.sessionId;
    this.sessionKey = Buffer.from(
      hkdfSync(
        'sha256',
        this.credential.keyMaterial,
        Buffer.concat([hostNonce, challenge.deviceNonce]),
        Buffer.concat([Buffer.from('SESSION'), authorized.sessionId]),
        32
      )
    );
    this.sequence = 0;
    this.lastRefreshAt = Date.now();
    if (!equalsConstantTime(expectedProof, authorized.deviceProof)) {
      throw new Error('Amis Hub Dongle proof verification failed during B7.');
    }
  }

  async refreshIfNeeded(): Promise<void> {
    if (Date.now() - this.lastRefreshAt < this.refreshIntervalMs) return;
    await this.refresh();
  }

  async close(): Promise<void> {
    if (!this.sessionId || !this.sessionKey) return;
    const sessionId = this.sessionId;
    const sessionKey = this.sessionKey;
    this.sessionId = null;
    this.sessionKey = null;
    const nextSequence = this.nextSequence();
    const proof = hmac(
      sessionKey,
      Buffer.concat([Buffer.from('CLOSE'), sessionId, appendUInt32(nextSequence)])
    );
    await this.client.closeAuthorization(sessionId, nextSequence, proof);
  }

  private async refresh(): Promise<void> {
    if (!this.sessionId || !this.sessionKey) throw new Error('Amis Hub has no active Flash lease.');
    const nextSequence = this.nextSequence();
    const proof = hmac(
      this.sessionKey,
      Buffer.concat([Buffer.from('REFRESH'), this.sessionId, appendUInt32(nextSequence)])
    );
    const response = await this.client.refreshAuthorization(this.sessionId, nextSequence, proof);
    this.sequence = nextSequence;
    if (response.sequence !== nextSequence) throw new Error('Amis Hub B8 returned an unexpected sequence.');
    const expectedProof = hmac(
      this.sessionKey,
      Buffer.concat([
        Buffer.from('REFRESH-OK'),
        this.sessionId,
        appendUInt32(nextSequence),
        appendUInt32(response.remainingTtl)
      ])
    );
    if (!equalsConstantTime(expectedProof, response.deviceProof)) {
      throw new Error('Amis Hub Dongle proof verification failed during B8.');
    }
    this.lastRefreshAt = Date.now();
  }

  private nextSequence(): number {
    if (this.sequence >= 0xffff_ffff) throw new Error('Amis Hub authorization sequence is exhausted.');
    return this.sequence + 1;
  }

  private transcript(domain: string, hostNonce: Buffer, deviceNonce: Buffer, authId: Buffer): Buffer {
    return Buffer.concat([
      Buffer.from(domain),
      Buffer.from([1]),
      this.credential.keyId,
      this.credential.deviceId,
      hostNonce,
      deviceNonce,
      authId
    ]);
  }
}

/** Incremental zlib-compatible CRC32 used for the Flash image. */
export class TokenHubCrc32 {
  private static readonly table = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb8_8320 : value >>> 1;
    }
    return value >>> 0;
  });

  private current = 0xffff_ffff;

  update(data: Buffer): void {
    for (const byte of data) {
      this.current = TokenHubCrc32.table[(this.current ^ byte) & 0xff] ^ (this.current >>> 8);
    }
  }

  value(): number {
    return (this.current ^ 0xffff_ffff) >>> 0;
  }
}
