import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HubModelConnector } from '../dist/main/models/HubModelConnector.js';
import { parseIoregUsbDevices } from '../dist/main/models/tokenhub/TokenHubDeviceProbe.js';
import {
  TokenHubCrc32,
  TokenHubPresenceSession,
  TokenHubProtocolClient,
  verifyTokenHubCertificate,
  verifyTokenHubChallenge,
  verifyTokenHubManifest,
  verifyTokenHubSignature,
  wrapMldsa44PublicKey
} from '../dist/main/models/tokenhub/TokenHubProtocol.js';
import {
  buildTokenHubServerArguments,
  TokenHubRuntime
} from '../dist/main/models/tokenhub/TokenHubRuntime.js';
import { TokenHubServerStager } from '../dist/main/models/tokenhub/TokenHubServerStager.js';
import {
  decodeTokenHubResponseHeader,
  encodeTokenHubRequest
} from '../dist/main/models/tokenhub/TokenHubSerialTransport.js';

const DEVICE_ID = Buffer.from('0123456789abcdef', 'hex');
const DEVICE_PUBLIC_KEY_SIZE = 1_312;
const DEVICE_CERTIFICATE_ISSUER = Buffer.from('AMIS-DEV-CA', 'ascii');
const DEVICE_CERTIFICATE_SIGNATURE_SIZE = 64;
const DEVICE_CERTIFICATE_SIZE = 1_440;
const DEVICE_CERTIFICATE_BODY_SIZE = DEVICE_CERTIFICATE_SIZE - DEVICE_CERTIFICATE_SIGNATURE_SIZE;
const DEVICE_CERTIFICATE_ISSUER_OFFSET = 1_328;
const DEVICE_CERTIFICATE_ISSUED_AT_OFFSET = 1_344;
const DEVICE_CERTIFICATE_VALID_FROM_OFFSET = 1_360;
const DEVICE_CERTIFICATE_VALID_TO_OFFSET = 1_368;
const PRESENCE_VERSION = 3;
const PENDING_TTL_MS = 3_000;
const LEASE_TTL_MS = 90_000;
const MLDSA44_SIGNATURE_SIZE = 2_420;

test('runtime builds the Dongle server arguments from detected paths', () => {
  assert.deepEqual(buildTokenHubServerArguments({
    modelPath: '/models/Qwen3.5-35B-A3B-Q4_K_M.gguf',
    templatePath: '/app/resources/TokenHubRuntime/arm64/qwen3_codex_compatible.jinja',
    donglePort: '/dev/cu.usbmodem2110',
    port: 8081
  }), [
    '-m', '/models/Qwen3.5-35B-A3B-Q4_K_M.gguf',
    '--host', '0.0.0.0',
    '--port', '8081',
    '--parallel', '1',
    '-ngl', '99',
    '-t', '2',
    '-rea', 'on',
    '--no-mmap',
    '--cache-ram', '0',
    '-ub', '4096',
    '-b', '4096',
    '-c', '49152',
    '-fa', 'on',
    '--no-cache-prompt',
    '--rge', '0',
    '--chat-template-file', '/app/resources/TokenHubRuntime/arm64/qwen3_codex_compatible.jinja',
    '--dongle-port', '/dev/cu.usbmodem2110'
  ]);
});

function checksum(data) {
  const crc32 = new TokenHubCrc32();
  crc32.update(data);
  return crc32.value();
}

function dongleServerPayload() {
  return Buffer.concat([
    Buffer.from('cffaedfe0c000001', 'hex'),
    Buffer.alloc(70_000, 0x5a),
    Buffer.from('--dongle-port\n--chat-template-file\nDongle V3 authentication passed\n')
  ]);
}

test('stages a verified Dongle server privately and removes it on request', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'tokkey-tokenhub-stage-'));
  test.after(() => rmSync(directory, { recursive: true, force: true }));
  const serverPath = path.join(directory, 'runtime', 'llama-server');
  const payload = dongleServerPayload();
  const reads = [];
  let refreshes = 0;
  const stager = new TokenHubServerStager();

  await stager.stage({
    client: {
      async externalFileInfo() {
        return { fileSize: payload.length, crc32: checksum(payload) };
      },
      async externalFileChunk(offset, size) {
        reads.push({ offset, size });
        return Buffer.from(payload.subarray(offset, offset + size));
      }
    },
    lease: {
      async refreshIfNeeded() {
        refreshes += 1;
      }
    },
    manifest: {
      deviceId: DEVICE_ID,
      fileSize: payload.length,
      fileCrc32: checksum(payload),
      fileSha256: createHash('sha256').update(payload).digest(),
      generation: 1n
    },
    serverPath,
    assertCurrent() {}
  });

  assert.deepEqual(readFileSync(serverPath), payload);
  assert.equal(statSync(serverPath).mode & 0o777, 0o700);
  assert.deepEqual(reads, [
    { offset: 0, size: 65_531 },
    { offset: 65_531, size: payload.length - 65_531 }
  ]);
  assert.equal(refreshes, reads.length * 2);

  writeFileSync(`${serverPath}.partial`, 'incomplete server');
  await stager.remove(serverPath);
  assert.equal(existsSync(serverPath), false);
  assert.equal(existsSync(`${serverPath}.partial`), false);
});

test('does not publish a Dongle server whose checksum verification fails', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'tokkey-tokenhub-stage-'));
  test.after(() => rmSync(directory, { recursive: true, force: true }));
  const serverPath = path.join(directory, 'llama-server');
  const payload = dongleServerPayload();
  const stager = new TokenHubServerStager();

  await assert.rejects(() => stager.stage({
    client: {
      async externalFileInfo() {
        return { fileSize: payload.length, crc32: checksum(payload) };
      },
      async externalFileChunk(offset, size) {
        return Buffer.from(payload.subarray(offset, offset + size));
      }
    },
    lease: { async refreshIfNeeded() {} },
    manifest: {
      deviceId: DEVICE_ID,
      fileSize: payload.length,
      fileCrc32: checksum(payload),
      fileSha256: Buffer.alloc(32, 0x11),
      generation: 1n
    },
    serverPath,
    assertCurrent() {}
  }), /SHA256 verification/);

  assert.equal(existsSync(serverPath), false);
  assert.equal(existsSync(`${serverPath}.partial`), false);
});

function uint32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function uint16(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

function rawMldsa44PublicKey(publicKey) {
  const encoded = publicKey.export({ format: 'der', type: 'spki' });
  assert.equal(encoded.length, 1_334);
  return Buffer.from(encoded.subarray(-DEVICE_PUBLIC_KEY_SIZE));
}

function rawEd25519PublicKey(publicKey) {
  const encoded = publicKey.export({ format: 'der', type: 'spki' });
  assert.equal(encoded.length, 44);
  return Buffer.from(encoded.subarray(-32));
}

function generatedDeviceIdentity() {
  const keyPair = generateKeyPairSync('ml-dsa-44');
  return {
    identity: {
      deviceId: Buffer.from(DEVICE_ID),
      publicKey: rawMldsa44PublicKey(keyPair.publicKey)
    },
    privateKey: keyPair.privateKey
  };
}

function buildDeviceCertificate({
  deviceId,
  publicKey,
  caPrivateKey,
  issuedAt = '20260101000000',
  validFrom = '20250101',
  validTo = '20270101'
}) {
  const publicKeyOffset = 16;
  const certificate = Buffer.alloc(DEVICE_CERTIFICATE_SIZE);
  certificate.write('DC01');
  certificate.writeUInt16LE(2, 4);
  certificate.writeUInt16LE(0, 6);
  deviceId.copy(certificate, 8);
  publicKey.copy(certificate, publicKeyOffset);
  DEVICE_CERTIFICATE_ISSUER.copy(certificate, DEVICE_CERTIFICATE_ISSUER_OFFSET);
  certificate.write(issuedAt, DEVICE_CERTIFICATE_ISSUED_AT_OFFSET, 'ascii');
  certificate.write(validFrom, DEVICE_CERTIFICATE_VALID_FROM_OFFSET, 'ascii');
  certificate.write(validTo, DEVICE_CERTIFICATE_VALID_TO_OFFSET, 'ascii');
  sign(null, certificate.subarray(0, DEVICE_CERTIFICATE_BODY_SIZE), caPrivateKey)
    .copy(certificate, DEVICE_CERTIFICATE_BODY_SIZE);
  return certificate;
}

function buildManifest({ deviceId, fileSize, fileCrc32, fileSha256, generation, caPrivateKey }) {
  const manifest = Buffer.alloc(128);
  manifest.write('AMF1');
  manifest.writeUInt16LE(2, 4);
  deviceId.copy(manifest, 8);
  manifest.writeUInt32LE(fileSize, 16);
  manifest.writeUInt32LE(fileCrc32, 20);
  fileSha256.copy(manifest, 24);
  manifest.writeBigUInt64LE(generation, 56);
  sign(null, manifest.subarray(0, 64), caPrivateKey).copy(manifest, 64);
  return manifest;
}

function presenceSignature(privateKey, transcript) {
  return sign(null, transcript, { key: privateKey, context: Buffer.alloc(14) });
}

function presenceTranscript({ authId, hostNonce, deviceNonce, deviceId, sessionId, leaseTtl }) {
  return Buffer.concat([
    Buffer.from('DONGLE-PRESENCE'),
    Buffer.from([PRESENCE_VERSION]),
    deviceId,
    hostNonce,
    deviceNonce,
    authId,
    sessionId,
    uint32(leaseTtl)
  ]);
}

function refreshTranscript({ deviceId, sessionId, sequence, hostNonce, leaseTtl }) {
  return Buffer.concat([
    Buffer.from('DONGLE-PRESENCE-REFRESH'),
    Buffer.from([PRESENCE_VERSION]),
    deviceId,
    sessionId,
    uint32(sequence),
    hostNonce,
    uint32(leaseTtl)
  ]);
}

test('ioreg parser binds a matching USB parent to its descendant callout path', () => {
  const output = `
+-o USB CDC DEVICE@02110000  <class IOUSBHostDevice, id 0x1, registered>
  | {
  |   "idProduct" = 7
  |   "locationID" = 34668544
  |   "kUSBSerialNumberString" = "1234567890ABCDEF"
  |   "idVendor" = 34952
  | }
  | +-o IOUSBHostInterface@1  <class IOUSBHostInterface, id 0x2, registered>
  |   | {
  |   | }
  |   +-o IOSerialBSDClient  <class IOSerialBSDClient, id 0x3, registered>
  |       {
  |         "IOCalloutDevice" = "/dev/cu.usbmodem21101"
  |       }
+-o Other device  <class IOUSBHostDevice, id 0x4, registered>
    {
      "idProduct" = 1
      "idVendor" = 2
    }
`;

  assert.deepEqual(parseIoregUsbDevices(output), [{
    identity: '8888:0007:1234567890ABCDEF',
    calloutPath: '/dev/cu.usbmodem21101',
    serialNumber: '1234567890ABCDEF',
    location: '02110000'
  }]);
});

test('serial request and response headers use the firmware little-endian framing', () => {
  assert.deepEqual(
    encodeTokenHubRequest(0xb6, Buffer.from([1, 2, 3])),
    Buffer.from([0xb6, 3, 0, 1, 2, 3])
  );
  assert.deepEqual(
    decodeTokenHubResponseHeader(Buffer.from([0x0d, 0x34, 0x12])),
    { status: 0x0d, length: 0x1234 }
  );
});

test('reads A3, A0, and A2 without falling back to the legacy B5 credential', async () => {
  const { identity } = generatedDeviceIdentity();
  const certificateAuthority = generateKeyPairSync('ed25519');
  const untrustedCertificate = buildDeviceCertificate({
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    caPrivateKey: certificateAuthority.privateKey,
    validFrom: '20200101',
    validTo: '20990101'
  });
  const commands = [];
  const transport = {
    async sendCommand(command) {
      commands.push(command);
      if (command === 0xa3) return { status: 0, data: Buffer.from([1, 1, 0, 0]) };
      if (command === 0xa0) return { status: 0, data: Buffer.concat([identity.deviceId, identity.publicKey]) };
      if (command === 0xa2) {
        return { status: 0, data: Buffer.concat([uint16(untrustedCertificate.length), untrustedCertificate]) };
      }
      throw new Error(`Unexpected command ${command}`);
    },
    async close() {}
  };

  await assert.rejects(
    () => new TokenHubProtocolClient(transport).readCertifiedIdentity(),
    /CA signature verification failed/
  );

  assert.deepEqual(commands, [0xa3, 0xa0, 0xa2]);
});

test('explains when a Dongle has no CA-signed application manifest', async () => {
  const transport = {
    async sendCommand(command) {
      assert.equal(command, 0xb2);
      return { status: 0x0b, data: Buffer.alloc(0) };
    },
    async close() {}
  };

  await assert.rejects(
    () => new TokenHubProtocolClient(transport).applicationManifest(),
    /Factory provisioning must install a CA-signed manifest/
  );
});

test('V3 B6-B9 presence lease verifies real ML-DSA signatures and increments the refresh sequence', async () => {
  const { identity, privateKey } = generatedDeviceIdentity();
  const authId = Buffer.alloc(16, 0xa1);
  const deviceNonce = Buffer.alloc(32, 0xd2);
  const sessionId = Buffer.alloc(16, 0x51);
  const leaseTtl = LEASE_TTL_MS;
  let hostNonce;
  const commands = [];
  const transport = {
    async sendCommand(command, payload = Buffer.alloc(0)) {
      commands.push(command);
      if (command === 0xb6) {
        assert.equal(payload.length, 33);
        assert.equal(payload[0], PRESENCE_VERSION);
        hostNonce = Buffer.from(payload.subarray(1));
        const ttl = uint32(PENDING_TTL_MS);
        return { status: 0, data: Buffer.concat([authId, identity.deviceId, deviceNonce, ttl]) };
      }
      if (command === 0xb7) {
        assert.deepEqual(payload, authId);
        return {
          status: 0,
          data: Buffer.concat([
            sessionId,
            uint32(leaseTtl),
            uint16(MLDSA44_SIGNATURE_SIZE),
            presenceSignature(privateKey, presenceTranscript({
              authId,
              hostNonce,
              deviceNonce,
              deviceId: identity.deviceId,
              sessionId,
              leaseTtl
            }))
          ])
        };
      }
      if (command === 0xb8) {
        const sequence = payload.readUInt32LE(16);
        assert.equal(sequence, 1);
        assert.deepEqual(payload.subarray(0, 16), sessionId);
        assert.equal(payload.length, 52);
        const refreshNonce = payload.subarray(20);
        return {
          status: 0,
          data: Buffer.concat([
            payload.subarray(16, 20),
            uint32(leaseTtl),
            uint16(MLDSA44_SIGNATURE_SIZE),
            presenceSignature(privateKey, refreshTranscript({
              deviceId: identity.deviceId,
              sessionId,
              sequence,
              hostNonce: refreshNonce,
              leaseTtl
            }))
          ])
        };
      }
      if (command === 0xb9) {
        assert.equal(payload.length, 52);
        assert.deepEqual(payload.subarray(0, 16), sessionId);
        const sequence = payload.readUInt32LE(16);
        assert.equal(sequence, 2);
        assert.equal(payload.subarray(20).length, 32);
        return { status: 0, data: Buffer.from([PRESENCE_VERSION]) };
      }
      throw new Error(`Unexpected command ${command}`);
    },
    async close() {}
  };
  const client = new TokenHubProtocolClient(transport);
  const presence = new TokenHubPresenceSession(client, identity, 0);

  await presence.authenticate();
  await presence.refreshIfNeeded();
  await presence.close();

  assert.deepEqual(commands, [0xb6, 0xb7, 0xb8, 0xb9]);
});

test('invalidates the local V3 lease when B8 fails', async () => {
  const { identity, privateKey } = generatedDeviceIdentity();
  const authId = Buffer.alloc(16, 0xa1);
  const deviceNonce = Buffer.alloc(32, 0xd2);
  const sessionId = Buffer.alloc(16, 0x51);
  const commands = [];
  let hostNonce;
  const transport = {
    async sendCommand(command, payload = Buffer.alloc(0)) {
      commands.push(command);
      if (command === 0xb6) {
        hostNonce = Buffer.from(payload.subarray(1));
        return {
          status: 0,
          data: Buffer.concat([authId, identity.deviceId, deviceNonce, uint32(PENDING_TTL_MS)])
        };
      }
      if (command === 0xb7) {
        return {
          status: 0,
          data: Buffer.concat([
            sessionId,
            uint32(LEASE_TTL_MS),
            uint16(MLDSA44_SIGNATURE_SIZE),
            presenceSignature(privateKey, presenceTranscript({
              authId,
              hostNonce,
              deviceNonce,
              deviceId: identity.deviceId,
              sessionId,
              leaseTtl: LEASE_TTL_MS
            }))
          ])
        };
      }
      if (command === 0xb8) throw new Error('serial link lost during B8');
      throw new Error(`Unexpected command ${command}`);
    },
    async close() {}
  };
  const presence = new TokenHubPresenceSession(new TokenHubProtocolClient(transport), identity, 0);

  await presence.authenticate();
  await assert.rejects(() => presence.refresh(), /serial link lost during B8/);
  await assert.rejects(() => presence.refreshIfNeeded(), /no active V3 presence lease/);
  await presence.close();

  assert.deepEqual(commands, [0xb6, 0xb7, 0xb8]);
});

test('validates V3 certificate and manifest signatures before using their bindings', () => {
  const { identity } = generatedDeviceIdentity();
  const certificateAuthority = generateKeyPairSync('ed25519');
  const certificateAuthorityPublicKey = rawEd25519PublicKey(certificateAuthority.publicKey);
  const certificate = buildDeviceCertificate({
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    caPrivateKey: certificateAuthority.privateKey
  });
  const verifiedIdentity = verifyTokenHubCertificate(
    certificate,
    identity.deviceId,
    identity.publicKey,
    certificateAuthorityPublicKey,
    '20260101'
  );

  assert.equal(certificate.length, DEVICE_CERTIFICATE_SIZE);
  assert.deepEqual(verifiedIdentity, identity);
  assert.throws(
    () => verifyTokenHubCertificate(
      certificate,
      Buffer.alloc(8, 0xff),
      identity.publicKey,
      certificateAuthorityPublicKey,
      '20260101'
    ),
    /does not match the connected Dongle identity/
  );
  assert.throws(
    () => verifyTokenHubCertificate(
      certificate,
      identity.deviceId,
      identity.publicKey,
      certificateAuthorityPublicKey,
      '20280101'
    ),
    /outside its validity period/
  );
  const tamperedCertificate = Buffer.from(certificate);
  tamperedCertificate.writeUInt8(
    tamperedCertificate[DEVICE_CERTIFICATE_BODY_SIZE] ^ 0xff,
    DEVICE_CERTIFICATE_BODY_SIZE
  );
  assert.throws(
    () => verifyTokenHubCertificate(
      tamperedCertificate,
      identity.deviceId,
      identity.publicKey,
      certificateAuthorityPublicKey,
      '20260101'
    ),
    /CA signature verification failed/
  );

  const manifest = buildManifest({
    deviceId: identity.deviceId,
    fileSize: 1234,
    fileCrc32: 0xcbf4_3926,
    fileSha256: Buffer.alloc(32, 0x5a),
    generation: 9n,
    caPrivateKey: certificateAuthority.privateKey
  });
  const parsed = verifyTokenHubManifest(manifest, identity.deviceId, certificateAuthorityPublicKey);

  assert.deepEqual(parsed.deviceId, identity.deviceId);
  assert.equal(parsed.fileSize, 1234);
  assert.equal(parsed.fileCrc32, 0xcbf4_3926);
  assert.equal(parsed.generation, 9n);
  assert.throws(
    () => verifyTokenHubManifest(manifest, Buffer.alloc(8, 0xff), certificateAuthorityPublicKey),
    /does not match authenticated device/
  );
  const tamperedManifest = Buffer.from(manifest);
  tamperedManifest.writeUInt8(tamperedManifest[24] ^ 0xff, 24);
  assert.throws(
    () => verifyTokenHubManifest(tamperedManifest, identity.deviceId, certificateAuthorityPublicKey),
    /CA signature verification failed/
  );
});

test('CRC32 and ML-DSA input wrapping preserve the trust contract', () => {
  const crc32 = new TokenHubCrc32();
  crc32.update(Buffer.from('123456789'));
  const { identity, privateKey } = generatedDeviceIdentity();
  const challenge = Buffer.alloc(32, 0x5a);
  const signature = presenceSignature(privateKey, challenge);
  const tamperedSignature = Buffer.from(signature);
  tamperedSignature.writeUInt8(tamperedSignature[0] ^ 0xff, 0);

  assert.equal(crc32.value(), 0xcbf4_3926);
  assert.equal(wrapMldsa44PublicKey(Buffer.alloc(1312)).length, 1334);
  assert.equal(verifyTokenHubSignature(identity.publicKey, challenge, signature), true);
  assert.equal(verifyTokenHubChallenge(identity.publicKey, challenge, signature), true);
  assert.equal(verifyTokenHubSignature(identity.publicKey, challenge, tamperedSignature), false);
});

test('runtime rejects Start without a connected Dongle and publishes failed state', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'tokkey-tokenhub-test-'));
  test.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'model.gguf');
  writeFileSync(filePath, 'GGUF');
  const states = [];
  const runtime = new TokenHubRuntime({
    deviceProbe: { connectedDevices: async () => [] }
  });
  runtime.subscribe((state) => states.push(state));

  await assert.rejects(() => runtime.startModel({
    id: 'model',
    label: 'model',
    fileName: 'model.gguf',
    filePath
  }), /Insert an Amis Hub/);

  assert.equal(states.at(-1).phase, 'failed');
  assert.equal(states.at(-1).modelId, 'model');
  assert.deepEqual(runtime.getLocalChatRuntimeState(), {
    status: 'error',
    model: { id: 'model', label: 'model' },
    contextWindowTokens: 49_152,
    error: 'Insert an Amis Hub before starting a model.'
  });
  assert.throws(() => runtime.chatCompletionsUrl('model'), /Hub-authenticated local model is not running/);
});

test('runtime reserves startup before asynchronous model and Dongle checks', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'tokkey-tokenhub-test-'));
  test.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'model.gguf');
  writeFileSync(filePath, 'GGUF');
  let signalProbeStarted;
  const probeStarted = new Promise((resolve) => {
    signalProbeStarted = resolve;
  });
  let resolveDevices;
  const devices = new Promise((resolve) => {
    resolveDevices = resolve;
  });
  const runtime = new TokenHubRuntime({
    deviceProbe: {
      connectedDevices() {
        signalProbeStarted();
        return devices;
      }
    }
  });
  const model = { id: 'model', label: 'model', fileName: 'model.gguf', filePath };
  const firstStart = runtime.startModel(model);

  await probeStarted;
  await assert.rejects(() => runtime.startModel(model), /Another local model is already starting or running/);
  resolveDevices([]);
  await assert.rejects(firstStart, /Insert an Amis Hub/);
});

test('runtime synchronously removes a staged server during application exit', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'tokkey-tokenhub-exit-'));
  const serverPath = path.join(directory, 'llama-server');
  writeFileSync(serverPath, 'server');
  writeFileSync(`${serverPath}.partial`, 'partial');
  const runtime = new TokenHubRuntime();
  runtime.activeStagedServerPath = serverPath;

  runtime.shutdownNow();

  assert.equal(existsSync(serverPath), false);
  assert.equal(existsSync(`${serverPath}.partial`), false);
  assert.equal(existsSync(directory), false);
});

test('Hub connector creates a durable route and repoints it on the next start', async () => {
  let saved = null;
  const created = [];
  const updated = [];
  let routes = [];
  const client = {
    async listModels() { return routes; },
    async createModel(request) {
      created.push(request);
      routes = [{ modelId: 'route-1', modelName: request.modelName }];
      return 'route-1';
    },
    async updateModel(modelId, params) { updated.push({ modelId, params }); }
  };
  const store = {
    async find() { return saved; },
    async save(profile) { saved = profile; }
  };
  const connector = new HubModelConnector(client, store);
  const model = {
    deviceId: DEVICE_ID.toString('hex'),
    displayName: 'Qwen Local',
    modelName: 'qwen.gguf',
    endpoint: 'http://127.0.0.1:8081/v1',
    apiKey: 'secret'
  };

  await connector.connect(model);
  await connector.connect({ ...model, endpoint: 'http://127.0.0.1:8082/v1' });

  assert.equal(created.length, 1);
  assert.equal(updated.length, 1);
  assert.equal(saved.id, `hub-${DEVICE_ID.toString('hex')}`);
  assert.equal(saved.type, 'hub');
  assert.equal(saved.apiUrl, 'http://127.0.0.1:8082/v1');
  assert.deepEqual(saved.supportedApiFormats, ['openai_responses']);
});
