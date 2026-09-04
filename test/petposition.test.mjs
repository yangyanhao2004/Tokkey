import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PetPositionStore } from '../dist/main/pet/PetPositionStore.js';

async function makePositionFile() {
  const directory = await mkdtemp(path.join(tmpdir(), 'tokkey-pet-position-'));
  return {
    directory,
    filePath: path.join(directory, 'pet-position.json')
  };
}

test('missing Pet position returns no saved placement', async () => {
  const { directory, filePath } = await makePositionFile();
  try {
    const store = new PetPositionStore(filePath);

    assert.equal(await store.load(), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Pet position round-trips through an atomic JSON file', async () => {
  const { directory, filePath } = await makePositionFile();
  try {
    const store = new PetPositionStore(filePath);
    const position = { x: -420, y: 740, displayId: 17 };

    await store.save(position);

    assert.deepEqual(await store.load(), position);
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), position);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid Pet position is ignored instead of leaking unsafe coordinates', async () => {
  const { directory, filePath } = await makePositionFile();
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, '{"x":"off-screen","y":10,"displayId":1}', 'utf8');
    const store = new PetPositionStore(filePath);

    assert.equal(await store.load(), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
