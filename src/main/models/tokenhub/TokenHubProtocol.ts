import {
  createPublicKey,
  randomBytes,
  verify
} from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type {
  TokenHubCommandResponse,
  TokenHubCommandTransport
} from './TokenHubSerialTransport';

const DEVICE_ID_SIZE = 8;
const PUBLIC_KEY_SIZE = 1_312;
const SIGNATURE_SIZE = 2_420;
const NONCE_SIZE = 32;
const SESSION_ID_SIZE = 16;
const CERTIFICATE_SIZE = 1_440;
const CERTIFICATE_BODY_SIZE = 1_376;
const CERTIFICATE_ISSUER_OFFSET = 1_328;
const CERTIFICATE_VALID_FROM_OFFSET = 1_360;
const CERTIFICATE_VALID_TO_OFFSET = 1_368;
const CERTIFICATE_ISSUER = Buffer.from('AMIS-DEV-CA');
const PRESENCE_VERSION = 3;
const MAX_PENDING_TTL_MS = 3_000;
const MAX_LEASE_TTL_MS = 90_000;
const DEFAULT_REFRESH_INTERVAL_MS = 30_000;
const AUTHENTICATION_CONTEXT = Buffer.alloc(14);
const ED25519_SPKI_PREFIX = Buffer.from([
  0x30, 0x2a,
  0x30, 0x05,
  0x06, 0x03, 0x2b, 0x65, 0x70,
  0x03, 0x21, 0x00
]);

export const TOKEN_HUB_CA_PUBLIC_KEY = Buffer.from(
  'a6536e4c3c110a41222e80c8be64996b23e9f778f9764d44bbe777882c3076e1',
  'hex'
);

const COMMAND = {
  getPublicKey: 0xa0,
  getCertificate: 0xa2,
  getStatus: 0xa3,
  signChallenge: 0xa5,
  externalFileInfo: 0xac,
  externalFileRead: 0xad,
  readApplicationManifest: 0xb2,
  authBegin: 0xb6,
  authProve: 0xb7,
  authRefresh: 0xb8,
  authClose: 0xb9
} as const;

export const TOKEN_HUB_EXTERNAL_READ_CHUNK_SIZE = 0xffff - 4;

export interface TokenHubCertifiedIdentity {
  deviceId: Buffer;
  publicKey: Buffer;
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

/** Verifies an ML-DSA-44 signature under the firmware's fixed context. */
export function verifyTokenHubSignature(
  publicKey: Buffer,
  message: Buffer,
  signature: Buffer
): boolean {
  if (signature.length !== SIGNATURE_SIZE) {
    throw new Error(`ML-DSA-44 signature is ${signature.length}/${SIGNATURE_SIZE} bytes.`);
  }
  const key = createPublicKey({ key: wrapMldsa44PublicKey(publicKey), format: 'der', type: 'spki' });
  return verify(null, message, { key, context: AUTHENTICATION_CONTEXT }, signature);
}

/** Verifies the optional A5 32-byte challenge using ML-DSA-44. */
export function verifyTokenHubChallenge(
  publicKey: Buffer,
  challenge: Buffer,
  signature: Buffer
): boolean {
  if (challenge.length !== NONCE_SIZE) {
    throw new Error(`ML-DSA-44 challenge is ${challenge.length}/${NONCE_SIZE} bytes.`);
  }
  return verifyTokenHubSignature(publicKey, challenge, signature);
}

function ed25519PublicKey(publicKey: Buffer): ReturnType<typeof createPublicKey> {
  if (publicKey.length !== 32) {
    throw new Error(`Amis Hub CA public key is ${publicKey.length}/32 bytes.`);
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
    format: 'der',
    type: 'spki'
  });
}

function isAsciiDate(value: Buffer): boolean {
  return value.length === 8 && value.every((byte) => byte >= 0x30 && byte <= 0x39);
}

function utcDate(): string {
  const now = new Date();
  return [
    now.getUTCFullYear().toString().padStart(4, '0'),
    (now.getUTCMonth() + 1).toString().padStart(2, '0'),
    now.getUTCDate().toString().padStart(2, '0')
  ].join('');
}

function monotonicMilliseconds(): number {
  return performance.now();
}

/** Verifies the CA signature and A0 identity binding of a V3 device certificate. */
export function verifyTokenHubCertificate(
  certificate: Buffer,
  expectedDeviceId: Buffer,
  expectedPublicKey: Buffer,
  caPublicKey = TOKEN_HUB_CA_PUBLIC_KEY,
  currentDate = utcDate()
): TokenHubCertifiedIdentity {
  if (certificate.length !== CERTIFICATE_SIZE) {
    throw new Error(`Amis Hub certificate is ${certificate.length}/${CERTIFICATE_SIZE} bytes.`);
  }
  if (!certificate.subarray(0, 4).equals(Buffer.from('DC01'))) {
    throw new Error('Amis Hub certificate magic is not DC01.');
  }
  if (certificate.readUInt16LE(4) !== 2 || certificate.readUInt16LE(6) !== 0) {
    throw new Error('Amis Hub certificate version or flags are unsupported.');
  }
  if (expectedDeviceId.length !== DEVICE_ID_SIZE || expectedPublicKey.length !== PUBLIC_KEY_SIZE) {
    throw new Error('Amis Hub certificate was checked against an invalid A0 identity.');
  }
  const certificateDeviceId = certificate.subarray(8, 16);
  const certificatePublicKey = certificate.subarray(16, 16 + PUBLIC_KEY_SIZE);
  if (!certificateDeviceId.equals(expectedDeviceId) || !certificatePublicKey.equals(expectedPublicKey)) {
    throw new Error('Amis Hub certificate does not match the connected Dongle identity.');
  }
  const issuer = certificate.subarray(CERTIFICATE_ISSUER_OFFSET, CERTIFICATE_ISSUER_OFFSET + 16);
  if (
    !issuer.subarray(0, CERTIFICATE_ISSUER.length).equals(CERTIFICATE_ISSUER) ||
    issuer.subarray(CERTIFICATE_ISSUER.length).some((byte) => byte !== 0)
  ) {
    throw new Error('Amis Hub certificate issuer is not trusted.');
  }
  const validFrom = certificate.subarray(CERTIFICATE_VALID_FROM_OFFSET, CERTIFICATE_VALID_FROM_OFFSET + 8);
  const validTo = certificate.subarray(CERTIFICATE_VALID_TO_OFFSET, CERTIFICATE_VALID_TO_OFFSET + 8);
  if (!isAsciiDate(validFrom) || !isAsciiDate(validTo)) {
    throw new Error('Amis Hub certificate has an invalid validity period.');
  }
  const validFromText = validFrom.toString('ascii');
  const validToText = validTo.toString('ascii');
  if (validFromText > validToText || currentDate < validFromText || currentDate > validToText) {
    throw new Error('Amis Hub certificate is outside its validity period.');
  }
  if (!verify(
    null,
    certificate.subarray(0, CERTIFICATE_BODY_SIZE),
    ed25519PublicKey(caPublicKey),
    certificate.subarray(CERTIFICATE_BODY_SIZE)
  )) {
    throw new Error('Amis Hub certificate CA signature verification failed.');
  }
  return {
    deviceId: Buffer.from(certificateDeviceId),
    publicKey: Buffer.from(certificatePublicKey)
  };
}

/** Parses the V3 manifest fields that bind the protected Flash payload to one Dongle. */
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

/** Verifies the CA signature before parsing a manifest that authorizes the Flash payload. */
export function verifyTokenHubManifest(
  manifest: Buffer,
  expectedDeviceId: Buffer,
  caPublicKey = TOKEN_HUB_CA_PUBLIC_KEY
): TokenHubApplicationManifest {
  if (manifest.length !== 128) throw new Error(`Amis Hub manifest has invalid length ${manifest.length}.`);
  if (!verify(null, manifest.subarray(0, 64), ed25519PublicKey(caPublicKey), manifest.subarray(64))) {
    throw new Error('Amis Hub manifest CA signature verification failed.');
  }
  return parseTokenHubManifest(manifest, expectedDeviceId);
}

/** Typed asynchronous client for the firmware commands used during startup. */
export class TokenHubProtocolClient {
  constructor(private readonly transport: TokenHubCommandTransport) {}

  /** Reads A0/A2 and verifies the device identity against the embedded vendor CA. */
  async readCertifiedIdentity(expectedDeviceId?: Buffer): Promise<TokenHubCertifiedIdentity> {
    const status = await this.requireOk(COMMAND.getStatus);
    if (status.length < 4) throw new Error('Amis Hub status response is incomplete.');
    if ((status[0] !== 1 && status[0] !== 2) || status[1] !== 1) {
      throw new Error('Amis Hub has no generated key or provisioned certificate.');
    }

    const identity = await this.requireOk(COMMAND.getPublicKey);
    assertLength(COMMAND.getPublicKey, identity, DEVICE_ID_SIZE + PUBLIC_KEY_SIZE, 'a certified identity');
    const deviceId = Buffer.from(identity.subarray(0, DEVICE_ID_SIZE));
    const publicKey = Buffer.from(identity.subarray(DEVICE_ID_SIZE));
    if (expectedDeviceId && !deviceId.equals(expectedDeviceId)) {
      throw new Error(
        `Amis Hub device ID ${deviceId.toString('hex')} does not match ${expectedDeviceId.toString('hex')}.`
      );
    }

    const certificateResponse = await this.requireOk(COMMAND.getCertificate);
    if (certificateResponse.length < 2) throw new Error('Amis Hub A2 certificate response is incomplete.');
    const certificateLength = certificateResponse.readUInt16LE(0);
    const certificate = certificateResponse.subarray(2);
    if (certificateLength !== CERTIFICATE_SIZE || certificate.length !== certificateLength) {
      throw new Error('Amis Hub A2 certificate response has an invalid length.');
    }
    return verifyTokenHubCertificate(certificate, deviceId, publicKey);
  }

  /** Performs the optional A5 diagnostic challenge after certificate authentication. */
  async authenticateIdentity(expectedDeviceId?: Buffer): Promise<Buffer> {
    const identity = await this.readCertifiedIdentity(expectedDeviceId);
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
    if (!verifyTokenHubChallenge(identity.publicKey, challenge, signature)) {
      throw new Error('Amis Hub challenge-response signature verification failed.');
    }
    return identity.deviceId;
  }

  async beginPresence(hostNonce: Buffer): Promise<{
    authId: Buffer;
    deviceId: Buffer;
    deviceNonce: Buffer;
    pendingTtl: number;
  }> {
    if (hostNonce.length !== NONCE_SIZE) {
      throw new Error('Amis Hub B6 V3 nonce length is invalid.');
    }
    const data = await this.requireOk(
      COMMAND.authBegin,
      Buffer.concat([Buffer.from([PRESENCE_VERSION]), hostNonce])
    );
    assertLength(COMMAND.authBegin, data, 60, 'a 60-byte V3 presence challenge');
    const pendingTtl = data.readUInt32LE(56);
    if (pendingTtl === 0 || pendingTtl > MAX_PENDING_TTL_MS) {
      throw new Error('Amis Hub B6 returned an invalid V3 pending TTL.');
    }
    return {
      authId: Buffer.from(data.subarray(0, 16)),
      deviceId: Buffer.from(data.subarray(16, 24)),
      deviceNonce: Buffer.from(data.subarray(24, 56)),
      pendingTtl
    };
  }

  async provePresence(authId: Buffer): Promise<{
    sessionId: Buffer;
    leaseTtl: number;
    signature: Buffer;
  }> {
    if (authId.length !== SESSION_ID_SIZE) throw new Error('Amis Hub B7 V3 authentication ID is invalid.');
    const data = await this.requireOk(COMMAND.authProve, authId);
    assertLength(COMMAND.authProve, data, 22 + SIGNATURE_SIZE, 'a signed V3 presence lease');
    const leaseTtl = data.readUInt32LE(16);
    if (leaseTtl === 0 || leaseTtl > MAX_LEASE_TTL_MS || data.readUInt16LE(20) !== SIGNATURE_SIZE) {
      throw new Error('Amis Hub B7 returned an invalid V3 presence lease.');
    }
    return {
      sessionId: Buffer.from(data.subarray(0, 16)),
      leaseTtl,
      signature: Buffer.from(data.subarray(22))
    };
  }

  async refreshPresence(sessionId: Buffer, sequence: number, hostNonce: Buffer): Promise<{
    sequence: number;
    leaseTtl: number;
    signature: Buffer;
  }> {
    if (sessionId.length !== SESSION_ID_SIZE || hostNonce.length !== NONCE_SIZE) {
      throw new Error('Amis Hub B8 V3 session or nonce length is invalid.');
    }
    const data = await this.requireOk(
      COMMAND.authRefresh,
      Buffer.concat([sessionId, appendUInt32(sequence), hostNonce])
    );
    assertLength(COMMAND.authRefresh, data, 10 + SIGNATURE_SIZE, 'a signed V3 lease refresh');
    const leaseTtl = data.readUInt32LE(4);
    if (data.readUInt32LE(0) !== sequence || leaseTtl === 0 || leaseTtl > MAX_LEASE_TTL_MS) {
      throw new Error('Amis Hub B8 returned an invalid V3 lease refresh.');
    }
    if (data.readUInt16LE(8) !== SIGNATURE_SIZE) {
      throw new Error('Amis Hub B8 returned an invalid V3 lease signature length.');
    }
    return {
      sequence,
      leaseTtl,
      signature: Buffer.from(data.subarray(10))
    };
  }

  async closePresence(sessionId: Buffer, sequence: number, hostNonce: Buffer): Promise<void> {
    if (sessionId.length !== SESSION_ID_SIZE || hostNonce.length !== NONCE_SIZE) {
      throw new Error('Amis Hub B9 V3 session or nonce length is invalid.');
    }
    const data = await this.requireOk(
      COMMAND.authClose,
      Buffer.concat([sessionId, appendUInt32(sequence), hostNonce])
    );
    if (!data.equals(Buffer.from([PRESENCE_VERSION]))) {
      throw new Error('Amis Hub B9 V3 response is invalid.');
    }
  }

  async applicationManifest(): Promise<Buffer> {
    const response = await this.transport.sendCommand(COMMAND.readApplicationManifest);
    if (response.status === 0x09) throw new Error('Amis Hub manifest authentication expired.');
    if (response.status === 0x0b) {
      throw new Error(
        'Amis Hub application manifest is missing. Factory provisioning must install a CA-signed manifest for this Dongle llama-server.'
      );
    }
    this.requireOkResponse(COMMAND.readApplicationManifest, response);
    if (response.data.length !== 130 || response.data.readUInt16LE(0) !== 128) {
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

  private async requireOk(command: number, payload: Buffer = Buffer.alloc(0)): Promise<Buffer> {
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
}

interface TokenHubPresenceLease {
  sessionId: Buffer;
  sequence: number;
  expiresAt: number;
  refreshAt: number;
}

/** Owns the V3 signed presence lease used while reading protected Flash. */
export class TokenHubPresenceSession {
  private lease: TokenHubPresenceLease | null = null;

  constructor(
    private readonly client: TokenHubProtocolClient,
    private readonly identity: TokenHubCertifiedIdentity,
    private readonly refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS
  ) {}

  async authenticate(): Promise<void> {
    const hostNonce = randomBytes(NONCE_SIZE);
    const beginStartedAt = monotonicMilliseconds();
    const challenge = await this.client.beginPresence(hostNonce);
    if (!challenge.deviceId.equals(this.identity.deviceId)) {
      throw new Error('Amis Hub B6 device ID does not match its certified identity.');
    }
    const pendingExpiresAt = beginStartedAt + challenge.pendingTtl;
    const proveStartedAt = monotonicMilliseconds();
    const authorized = await this.client.provePresence(challenge.authId);
    if (monotonicMilliseconds() >= pendingExpiresAt) {
      throw new Error('Amis Hub B7 V3 presence challenge expired.');
    }
    const transcript = Buffer.concat([
      Buffer.from('DONGLE-PRESENCE'),
      Buffer.from([PRESENCE_VERSION]),
      this.identity.deviceId,
      hostNonce,
      challenge.deviceNonce,
      challenge.authId,
      authorized.sessionId,
      appendUInt32(authorized.leaseTtl)
    ]);
    if (!verifyTokenHubSignature(this.identity.publicKey, transcript, authorized.signature)) {
      throw new Error('Amis Hub B7 V3 presence signature verification failed.');
    }
    if (monotonicMilliseconds() >= proveStartedAt + authorized.leaseTtl) {
      throw new Error('Amis Hub B7 V3 presence lease expired during verification.');
    }
    this.lease = {
      sessionId: authorized.sessionId,
      sequence: 0,
      expiresAt: proveStartedAt + authorized.leaseTtl,
      refreshAt: proveStartedAt + this.nextRefreshDelay(authorized.leaseTtl)
    };
  }

  async refreshIfNeeded(): Promise<void> {
    const lease = this.requireLease();
    if (monotonicMilliseconds() >= lease.expiresAt) {
      this.lease = null;
      throw new Error('Amis Hub V3 presence lease expired locally.');
    }
    if (monotonicMilliseconds() < lease.refreshAt) return;
    await this.refresh();
  }

  /** Forces a signed B8 before releasing the serial port to the native server. */
  async refresh(): Promise<void> {
    const lease = this.requireLease();
    try {
      const startedAt = monotonicMilliseconds();
      if (startedAt >= lease.expiresAt) {
        throw new Error('Amis Hub V3 presence lease expired locally.');
      }
      if (lease.sequence >= 0xffff_ffff) throw new Error('Amis Hub V3 authorization sequence is exhausted.');
      const sequence = lease.sequence + 1;
      const hostNonce = randomBytes(NONCE_SIZE);
      const response = await this.client.refreshPresence(lease.sessionId, sequence, hostNonce);
      if (monotonicMilliseconds() >= lease.expiresAt) {
        throw new Error('Amis Hub V3 presence lease expired before B8 completed.');
      }
      const transcript = Buffer.concat([
        Buffer.from('DONGLE-PRESENCE-REFRESH'),
        Buffer.from([PRESENCE_VERSION]),
        this.identity.deviceId,
        lease.sessionId,
        appendUInt32(sequence),
        hostNonce,
        appendUInt32(response.leaseTtl)
      ]);
      if (!verifyTokenHubSignature(this.identity.publicKey, transcript, response.signature)) {
        throw new Error('Amis Hub B8 V3 presence signature verification failed.');
      }
      if (monotonicMilliseconds() >= startedAt + response.leaseTtl) {
        throw new Error('Amis Hub B8 V3 presence lease expired during verification.');
      }
      this.lease = {
        sessionId: lease.sessionId,
        sequence,
        expiresAt: startedAt + response.leaseTtl,
        refreshAt: startedAt + this.nextRefreshDelay(response.leaseTtl)
      };
    } catch (cause) {
      this.lease = null;
      throw cause;
    }
  }

  async close(): Promise<void> {
    const lease = this.lease;
    this.lease = null;
    if (!lease || monotonicMilliseconds() >= lease.expiresAt || lease.sequence >= 0xffff_ffff) return;
    await this.client.closePresence(lease.sessionId, lease.sequence + 1, randomBytes(NONCE_SIZE));
  }

  private requireLease(): TokenHubPresenceLease {
    if (!this.lease) throw new Error('Amis Hub has no active V3 presence lease.');
    return this.lease;
  }

  private nextRefreshDelay(leaseTtl: number): number {
    return Math.min(this.refreshIntervalMs, Math.max(1, Math.floor(leaseTtl / 3)));
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
