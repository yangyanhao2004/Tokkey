import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import IpcControllerModule from '../dist/main/IpcController.js';
import { PetSettingsStore } from '../dist/main/pet/PetSettingsStore.js';

const IpcController = IpcControllerModule.default;

const DEFAULT_SETTINGS = {
  isEnabled: false,
  size: 'mid',
  speed: 'mid',
  movementRange: 'small'
};

async function makeSettingsFile() {
  const directory = await mkdtemp(path.join(tmpdir(), 'tokkey-pet-settings-'));
  return {
    directory,
    filePath: path.join(directory, 'pet-settings.json')
  };
}

test('missing Pet settings return the first-run defaults', async () => {
  const { directory, filePath } = await makeSettingsFile();
  try {
    const store = new PetSettingsStore(filePath);

    assert.deepEqual(await store.load(), DEFAULT_SETTINGS);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Pet settings round-trip through an atomic JSON file', async () => {
  const { directory, filePath } = await makeSettingsFile();
  try {
    const store = new PetSettingsStore(filePath);
    const settings = {
      isEnabled: true,
      size: 'large',
      speed: 'small',
      movementRange: 'large'
    };

    await store.save(settings);

    assert.deepEqual(await store.load(), settings);
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), settings);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('malformed Pet settings fall back to defaults and do not leak invalid values', async () => {
  const { directory, filePath } = await makeSettingsFile();
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, '{"isEnabled":"yes","size":"giant"}', 'utf8');
    const store = new PetSettingsStore(filePath);

    assert.deepEqual(await store.load(), DEFAULT_SETTINGS);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid Pet JSON falls back to defaults', async () => {
  const { directory, filePath } = await makeSettingsFile();
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, '{not-json', 'utf8');
    const store = new PetSettingsStore(filePath);

    assert.deepEqual(await store.load(), DEFAULT_SETTINGS);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('IPC Pet updates merge patches and serialize consecutive writes', async () => {
  const savedSettings = { ...DEFAULT_SETTINGS };
  const store = {
    async load() {
      return { ...savedSettings };
    },
    async save(nextSettings) {
      Object.assign(savedSettings, nextSettings);
    }
  };
  const controller = new IpcController({
    accountService: {},
    localModelManager: {},
    tokenHubRuntime: { subscribe: () => () => {} },
    localChatTurnExecutor: {},
    chatSessionStore: {},
    hostSnapshotService: {},
    petSettingsStore: store
  });

  const [first, second] = await Promise.all([
    controller.updatePetSettings({ isEnabled: true, size: 'large' }),
    controller.updatePetSettings({ speed: 'small' })
  ]);

  assert.deepEqual(first, {
    isEnabled: true,
    size: 'large',
    speed: 'mid',
    movementRange: 'small'
  });
  assert.deepEqual(second, {
    isEnabled: true,
    size: 'large',
    speed: 'small',
    movementRange: 'small'
  });
  assert.deepEqual(await controller.getPetSettings(), second);
  assert.deepEqual(savedSettings, second);
});
