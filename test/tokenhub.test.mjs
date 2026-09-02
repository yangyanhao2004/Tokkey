import assert from 'node:assert/strict';
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HubModelConnector } from '../dist/main/models/HubModelConnector.js';
import { parseIoregUsbDevices } from '../dist/main/models/tokenhub/TokenHubDeviceProbe.js';
import {
  parseTokenHubManifest,
  TokenHubCrc32,
  TokenHubLicenseSession,
  TokenHubProtocolClient,
  verifyTokenHubChallenge,
  wrapMldsa44PublicKey
} from '../dist/main/models/tokenhub/TokenHubProtocol.js';
import { TokenHubRuntime } from '../dist/main/models/tokenhub/TokenHubRuntime.js';
import {
  decodeTokenHubResponseHeader,
  encodeTokenHubRequest
} from '../dist/main/models/tokenhub/TokenHubSerialTransport.js';

const DEVICE_ID = Buffer.from('0123456789abcdef', 'hex');
const KEY_MATERIAL = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const KEY_ID = createHash('sha256').update(KEY_MATERIAL).digest().subarray(0, 8);

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
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

test('B5 derives and validates the device-bound API credential', async () => {
  const secret = KEY_MATERIAL.toString('base64url');
  const apiKey = `sk_dongle_v1_${DEVICE_ID.toString('hex')}_${secret}`;
  const header = Buffer.alloc(22);
  DEVICE_ID.copy(header, 0);
  header.writeUInt32LE(7, 8);
  KEY_ID.copy(header, 12);
  header.writeUInt16LE(Buffer.byteLength(apiKey), 20);
  const transport = {
    async sendCommand(command) {
      assert.equal(command, 0xb5);
      return { status: 0, data: Buffer.concat([header, Buffer.from(apiKey)]) };
    },
    async close() {}
  };

  const credential = await new TokenHubProtocolClient(transport).deriveCredential();

  assert.equal(credential.apiKey, apiKey);
  assert.equal(credential.keyEpoch, 7);
  assert.deepEqual(credential.deviceId, DEVICE_ID);
  assert.deepEqual(credential.keyMaterial, KEY_MATERIAL);
});

test('B6-B9 proofs and lease sequencing match the Dongle protocol', async () => {
  const authId = Buffer.alloc(16, 0xa1);
  const deviceNonce = Buffer.alloc(32, 0xd2);
  const sessionId = Buffer.alloc(16, 0x51);
  const leaseTtl = 90;
  let hostNonce;
  let sessionKey;
  const commands = [];
  const transport = {
    async sendCommand(command, payload = Buffer.alloc(0)) {
      commands.push(command);
      if (command === 0xb6) {
        assert.equal(payload[0], 1);
        assert.deepEqual(payload.subarray(1, 9), KEY_ID);
        hostNonce = Buffer.from(payload.subarray(9, 41));
        const ttl = Buffer.alloc(4);
        ttl.writeUInt32LE(30);
        return { status: 0, data: Buffer.concat([authId, DEVICE_ID, deviceNonce, ttl]) };
      }
      if (command === 0xb7) {
        const transcript = Buffer.concat([
          Buffer.from('HOST'), Buffer.from([1]), KEY_ID, DEVICE_ID, hostNonce, deviceNonce, authId
        ]);
        assert.deepEqual(payload.subarray(16), hmac(KEY_MATERIAL, transcript));
        const ttl = Buffer.alloc(4);
        ttl.writeUInt32LE(leaseTtl);
        const deviceTranscript = Buffer.concat([
          Buffer.from('DONGLE'), Buffer.from([1]), KEY_ID, DEVICE_ID,
          hostNonce, deviceNonce, authId, sessionId, ttl
        ]);
        sessionKey = Buffer.from(hkdfSync(
          'sha256', KEY_MATERIAL, Buffer.concat([hostNonce, deviceNonce]),
          Buffer.concat([Buffer.from('SESSION'), sessionId]), 32
        ));
        return { status: 0, data: Buffer.concat([sessionId, ttl, hmac(KEY_MATERIAL, deviceTranscript)]) };
      }
      if (command === 0xb8) {
        const sequence = payload.readUInt32LE(16);
        assert.equal(sequence, 1);
        assert.deepEqual(
          payload.subarray(20),
          hmac(sessionKey, Buffer.concat([Buffer.from('REFRESH'), sessionId, payload.subarray(16, 20)]))
        );
        const remaining = Buffer.alloc(4);
        remaining.writeUInt32LE(90);
        return {
          status: 0,
          data: Buffer.concat([
            payload.subarray(16, 20),
            remaining,
            hmac(sessionKey, Buffer.concat([
              Buffer.from('REFRESH-OK'), sessionId, payload.subarray(16, 20), remaining
            ]))
          ])
        };
      }
      if (command === 0xb9) {
        const sequence = payload.readUInt32LE(16);
        assert.equal(sequence, 2);
        assert.deepEqual(
          payload.subarray(20),
          hmac(sessionKey, Buffer.concat([Buffer.from('CLOSE'), sessionId, payload.subarray(16, 20)]))
        );
        return { status: 0, data: Buffer.from([1]) };
      }
      throw new Error(`Unexpected command ${command}`);
    },
    async close() {}
  };
  const client = new TokenHubProtocolClient(transport);
  const license = new TokenHubLicenseSession(client, {
    deviceId: DEVICE_ID,
    keyEpoch: 1,
    keyId: KEY_ID,
    apiKey: 'unused',
    keyMaterial: KEY_MATERIAL
  }, 0);

  await license.authenticate();
  await license.refreshIfNeeded();
  await license.close();

  assert.deepEqual(commands, [0xb6, 0xb7, 0xb8, 0xb9]);
});

test('manifest, CRC32, and ML-DSA input wrapping preserve the trust contract', () => {
  const manifest = Buffer.alloc(128);
  manifest.write('AMF1');
  manifest.writeUInt16LE(2, 4);
  DEVICE_ID.copy(manifest, 8);
  manifest.writeUInt32LE(1234, 16);
  manifest.writeUInt32LE(0xcbf4_3926, 20);
  Buffer.alloc(32, 0x5a).copy(manifest, 24);
  manifest.writeBigUInt64LE(9n, 56);
  const parsed = parseTokenHubManifest(manifest, DEVICE_ID);
  const crc32 = new TokenHubCrc32();
  crc32.update(Buffer.from('123456789'));

  assert.equal(parsed.fileSize, 1234);
  assert.equal(parsed.generation, 9n);
  assert.equal(crc32.value(), 0xcbf4_3926);
  assert.equal(wrapMldsa44PublicKey(Buffer.alloc(1312)).length, 1334);
  assert.equal(
    verifyTokenHubChallenge(Buffer.alloc(1312), Buffer.alloc(32), Buffer.alloc(2420)),
    false
  );
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
    contextWindowTokens: 16_384,
    error: 'Insert an Amis Hub before starting a model.'
  });
  assert.throws(() => runtime.chatCompletionsUrl('model'), /Hub-authenticated local model is not running/);
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
