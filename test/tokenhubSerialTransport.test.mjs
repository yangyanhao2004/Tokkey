import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TokenHubSerialTransport,
  tokenHubResponseLimit
} from '../dist/main/models/tokenhub/TokenHubSerialTransport.js';

function responseFrame(status, data) {
  const header = Buffer.alloc(3);
  header[0] = status;
  header.writeUInt16LE(data.length, 1);
  return Buffer.concat([header, data]);
}

class FakeSerialHandle {
  constructor({ pending = Buffer.alloc(0), responses = [] } = {}) {
    this.pending = Buffer.from(pending);
    this.responses = responses.map((response) => Buffer.from(response));
    this.writes = [];
  }

  async write(data, offset, length) {
    const request = Buffer.from(data.subarray(offset, offset + length));
    this.writes.push(request);
    this.pending = this.responses.shift() ?? Buffer.alloc(0);
    return { bytesWritten: request.length, buffer: data };
  }

  async read(buffer, offset, length) {
    if (this.pending.length === 0) return { bytesRead: 0, buffer };
    const bytesRead = Math.min(length, this.pending.length);
    this.pending.copy(buffer, offset, 0, bytesRead);
    this.pending = this.pending.subarray(bytesRead);
    return { bytesRead, buffer };
  }

  async close() {}
}

function transportWithHandle(handle) {
  const transport = new TokenHubSerialTransport('/dev/fake-tokenhub', 921_600, 100);
  transport.handle = handle;
  return transport;
}

test('Token Hub response limits match V3 command framing', () => {
  const externalRead = Buffer.alloc(6);
  externalRead.writeUInt16LE(1_024, 4);

  assert.equal(tokenHubResponseLimit(0xa0), 1_320);
  assert.equal(tokenHubResponseLimit(0xa2), 1_442);
  assert.equal(tokenHubResponseLimit(0xa3), 16);
  assert.equal(tokenHubResponseLimit(0xa5), 2_424);
  assert.equal(tokenHubResponseLimit(0xac), 20);
  assert.equal(tokenHubResponseLimit(0xad, externalRead), 1_028);
  assert.equal(tokenHubResponseLimit(0xb2), 130);
  assert.equal(tokenHubResponseLimit(0xb6), 60);
  assert.equal(tokenHubResponseLimit(0xb7), 2_442);
  assert.equal(tokenHubResponseLimit(0xb8), 2_430);
  assert.equal(tokenHubResponseLimit(0xb9), 16);
});

test('Token Hub transport drains stale RX bytes before a command', async () => {
  const handle = new FakeSerialHandle({
    pending: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
    responses: [responseFrame(0, Buffer.from([1, 1, 0, 0]))]
  });
  const transport = transportWithHandle(handle);

  const response = await transport.sendCommand(0xa3);

  assert.deepEqual(response, { status: 0, data: Buffer.from([1, 1, 0, 0]) });
  assert.deepEqual(handle.writes, [Buffer.from([0xa3, 0, 0])]);
});

test('Token Hub transport rejects an oversized frame and resynchronizes the queued command', async () => {
  const handle = new FakeSerialHandle({
    responses: [
      responseFrame(0, Buffer.alloc(17, 0x5a)),
      responseFrame(0, Buffer.from([1, 1, 0, 0]))
    ]
  });
  const transport = transportWithHandle(handle);

  await assert.rejects(
    () => transport.sendCommand(0xb9),
    /response is 17 bytes; limit is 16/
  );

  assert.deepEqual(
    await transport.sendCommand(0xa3),
    { status: 0, data: Buffer.from([1, 1, 0, 0]) }
  );
  assert.deepEqual(handle.writes, [Buffer.from([0xb9, 0, 0]), Buffer.from([0xa3, 0, 0])]);
});
