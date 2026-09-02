import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DownloadedModelStore } from '../dist/main/models/DownloadedModelStore.js';
import { LocalModelCatalogService } from '../dist/main/models/LocalModelCatalogService.js';
import { LocalModelManager } from '../dist/main/models/LocalModelManager.js';
import { NativeModelDownloadManager } from '../dist/main/models/NativeModelDownloadManager.js';

import { formatDecimalGB, formatFileSize } from '../dist/shared/byteFormatting.js';

const CATALOG_ROOT = 'https://cpilot.net/api/model-catalog';

test('a file size and the free space it is compared against print in one unit', () => {
  // Qwen3 235B Q6_K against a real 207 GB volume: the row and the subheading
  // are read against each other, so "197 GB" beside "207 GB free" would say the
  // model fits when the download is refused.
  const modelBytes = 211_205_016_781;
  const freeBytes = 207_079_789_805;

  assert.equal(formatFileSize(modelBytes), '211 GB');
  assert.equal(formatDecimalGB(freeBytes), '207 GB');
  assert.ok(modelBytes > freeBytes);
});

test('sub-gigabyte artifacts read in MB rather than "0.0 GB"', () => {
  assert.equal(formatFileSize(437_778_496), '438 MB');
  // Nothing downloadable is truly 0 MB, so the floor keeps a real file visible.
  assert.equal(formatFileSize(1024), '1 MB');
});

/**
 * The four-level shape the real service walks: brands -> series -> sizes ->
 * artifacts. Keys are deliberately mixed (`fileName` vs `filename`, GB vs
 * bytes) because the upstream payload is not consistent about them either.
 */
const CATALOG_RESPONSES = {
  [`${CATALOG_ROOT}/brands/`]: { brands: [{ name: 'Qwen', slug: 'qwen' }] },
  [`${CATALOG_ROOT}/brands/qwen/`]: { series: [{ name: 'Qwen3', slug: 'qwen3' }] },
  [`${CATALOG_ROOT}/series/qwen3/`]: { sizes: [{ name: '8B', slug: 'qwen3-8b' }] },
  [`${CATALOG_ROOT}/sizes/qwen3-8b/`]: {
    data: {
      artifacts: [
        {
          filename: 'Qwen3-8B-Q4_K_M.gguf',
          quantization: 'Q4_K_M',
          size: 5_200_000_000,
          requiredMemoryGb: 8,
          huggingFaceUrl: 'https://huggingface.co/Qwen/Qwen3-8B-GGUF/Q4_K_M.gguf'
        },
        { filename: 'Qwen3-8B-F16.gguf', quantization: 'F16', size: 16_000_000_000 }
      ]
    }
  }
};

/** Counts calls so cache hits can be told apart from network reads. */
class StubCatalogFetcher {
  constructor(responses = CATALOG_RESPONSES) {
    this.responses = responses;
    this.urls = [];
  }

  fetcher() {
    return async (url) => {
      this.urls.push(url);
      const payload = this.responses[url];
      if (payload === undefined) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => payload };
    };
  }
}

/** Polls a condition the code under test satisfies off the event it fired on. */
async function waitFor(condition, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the condition to hold.');
}

function createHomeDirectory() {
  const home = mkdtempSync(path.join(tmpdir(), 'tokiie-models-'));
  test.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function writeCache(home, cache) {
  mkdirSync(path.join(home, '.amiswifi'), { recursive: true });
  writeFileSync(path.join(home, '.amiswifi', 'model_catalog_cache.json'), JSON.stringify(cache), 'utf8');
}

test('catalog walks brands to artifacts and normalizes every unit it is given', async () => {
  const transport = new StubCatalogFetcher();
  const service = new LocalModelCatalogService({
    homeDirectory: createHomeDirectory(),
    fetcher: transport.fetcher()
  });

  const { models, providers, fromCache } = await service.load();

  assert.equal(fromCache, false);
  assert.deepEqual(providers, ['Qwen']);
  const [quantized] = models;
  assert.equal(quantized.id, 'qwen:qwen3:qwen3-8b:Q4_K_M');
  assert.equal(quantized.provider, 'Qwen');
  assert.equal(quantized.name, 'Qwen3-8B-Q4_K_M.gguf');
  assert.equal(quantized.sizeBytes, 5_200_000_000);
  // "requiredMemoryGb" is a GB figure, so it has to be widened to bytes.
  assert.equal(quantized.requiredRamBytes, 8 * 1_073_741_824);
  assert.equal(quantized.downloadable, true);
});

test('an artifact with no resolvable source stays visible but not downloadable', async () => {
  const transport = new StubCatalogFetcher();
  const service = new LocalModelCatalogService({
    homeDirectory: createHomeDirectory(),
    fetcher: transport.fetcher()
  });

  const { models } = await service.load();

  const unsourced = models.find((model) => model.fileName === 'Qwen3-8B-F16.gguf');
  assert.equal(unsourced.downloadable, false);
  assert.match(unsourced.sourceError, /Hugging Face or ModelScope/);
});

test('a fresh cache is served without touching the network', async () => {
  const home = createHomeDirectory();
  writeCache(home, { savedAt: Date.now(), models: [{ id: 'cached' }], providers: ['Qwen'] });
  const transport = new StubCatalogFetcher();
  const service = new LocalModelCatalogService({ homeDirectory: home, fetcher: transport.fetcher() });

  const { models, fromCache } = await service.load();

  assert.equal(fromCache, true);
  assert.deepEqual(models, [{ id: 'cached' }]);
  assert.deepEqual(transport.urls, []);
});

test('an unreachable catalog falls back to a stale cache instead of failing', async () => {
  const home = createHomeDirectory();
  // Older than the six-hour TTL, so the service tries the network first.
  writeCache(home, { savedAt: 0, models: [{ id: 'stale' }], providers: ['Qwen'] });
  const service = new LocalModelCatalogService({
    homeDirectory: home,
    fetcher: async () => {
      throw new Error('offline');
    }
  });

  const { models, fromCache } = await service.load();

  assert.equal(fromCache, true);
  assert.deepEqual(models, [{ id: 'stale' }]);
});

test('an unreachable catalog with no cache reports why the card is empty', async () => {
  const service = new LocalModelCatalogService({
    homeDirectory: createHomeDirectory(),
    fetcher: async () => {
      throw new Error('offline');
    }
  });

  await assert.rejects(() => service.load(), /Unable to load model catalog: offline/);
});

/** Descriptors standing in for a loaded catalog, so only filtering is under test. */
const DESCRIPTORS = [
  { id: 'qwen:a', provider: 'Qwen', series: 'Qwen3', name: 'Qwen3 8B', fileName: 'qwen3-8b.gguf' },
  { id: 'meta:a', provider: 'Meta', series: 'Llama', name: 'Llama 3.2 3B', fileName: 'llama-3-2-3b.gguf' }
];

function createManager() {
  return new LocalModelManager({
    catalog: { load: async () => ({ models: DESCRIPTORS, providers: ['Qwen', 'Meta'], fromCache: true }) },
    downloader: {
      capability: async () => ({ target: 'mac', freeDiskBytes: null, totalRamBytes: null, platform: 'darwin' }),
      projectRows: async (descriptors) => descriptors.map((descriptor) => ({ ...descriptor, lifecycle: 'downloadable' }))
    },
    localRuntime: {
      subscribe: () => () => {},
      getLocalChatRuntimeState: () => ({ status: 'unavailable', model: null, contextWindowTokens: null, error: null }),
      startModel: async () => ({ phase: 'idle', modelId: null, endpoint: null, error: null, device: null }),
      stopModel: async () => ({ phase: 'idle', modelId: null, endpoint: null, error: null, device: null }),
      chatCompletionsUrl: () => 'http://127.0.0.1:8081/v1/chat/completions',
      chatRequestHeaders: () => ({ Authorization: 'Bearer test-key' })
    }
  });
}

test('the provider filter matches case-insensitively and "all" keeps everything', async () => {
  const manager = createManager();

  const everything = await manager.list({ provider: 'all' });
  const onlyQwen = await manager.list({ provider: 'qwen' });

  assert.deepEqual(everything.models.map((model) => model.id), ['qwen:a', 'meta:a']);
  assert.deepEqual(onlyQwen.models.map((model) => model.id), ['qwen:a']);
  assert.deepEqual(onlyQwen.providers, ['Qwen', 'Meta']);
  assert.equal(onlyQwen.selectedProvider, 'qwen');
});

test('a query searches the name, series, provider, and file name together', async () => {
  const manager = createManager();

  const byFileName = await manager.list({ query: 'llama-3-2' });
  const bySeries = await manager.list({ query: 'qwen3' });

  assert.deepEqual(byFileName.models.map((model) => model.id), ['meta:a']);
  assert.deepEqual(bySeries.models.map((model) => model.id), ['qwen:a']);
});

/** The catalog's own size, as it arrives: a GB figure rounded to two decimals. */
const ARTIFACT = {
  id: 'qwen:qwen3:qwen3-8b:Q4_K_M',
  provider: 'Qwen',
  series: 'Qwen3',
  name: 'Qwen3 8B Q4_K_M',
  fileName: 'qwen3-8b-q4_k_m.gguf',
  sizeBytes: Math.round(4.92 * 1_073_741_824),
  requiredRamBytes: null,
  huggingFaceUrl: 'https://huggingface.co/example.gguf',
  modelScopeUrl: null,
  downloadable: true,
  sourceError: null
};

const NO_LIMITS = { target: 'mac', freeDiskBytes: null, totalRamBytes: null, platform: 'darwin' };

/** Writes a model file of `size` bytes where the manager expects to find it. */
function writeModelFile(home, size) {
  const directory = path.join(home, '.amiswifi', 'models', ARTIFACT.id.replaceAll(':', '_'));
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, ARTIFACT.fileName), Buffer.alloc(size));
}

test('a finished file counts as downloaded even though it cannot match the rounded catalog size', async () => {
  const home = createHomeDirectory();
  // A real GGUF is never exactly the two-decimal GB figure the catalog quotes.
  writeModelFile(home, 4096);

  const [row] = await new NativeModelDownloadManager({ homeDirectory: home }).projectRows([ARTIFACT], NO_LIMITS);

  assert.equal(row.lifecycle, 'downloaded');
  assert.equal(row.progress, 1);
});

test('a file left behind by an interrupted transfer is offered for download again', async () => {
  const home = createHomeDirectory();
  writeModelFile(home, 4096);
  // The resume point Chromium saved when the app stopped mid-transfer.
  mkdirSync(path.join(home, '.amiswifi'), { recursive: true });
  writeFileSync(
    path.join(home, '.amiswifi', 'model_downloads.json'),
    JSON.stringify([{ modelId: ARTIFACT.id, path: 'x', urlChain: ['https://huggingface.co/example.gguf'], offset: 4096, length: 9999 }]),
    'utf8'
  );

  const [row] = await new NativeModelDownloadManager({ homeDirectory: home }).projectRows([ARTIFACT], NO_LIMITS);

  assert.equal(row.lifecycle, 'downloadable');
});

test('free space is read through the same probe as the host card, purgeable space included', async () => {
  // What Foundation reports and `statfs` does not: the card shows 210 GB, so
  // the catalog has to gate on 210 GB too.
  const diskProbe = { read: async () => ({ total: 494_384_795_648, free: 209_961_166_061 }) };

  const capability = await new NativeModelDownloadManager({
    homeDirectory: createHomeDirectory(),
    diskProbe
  }).capability();

  assert.equal(capability.freeDiskBytes, 209_961_166_061);
});

test('an unreadable volume leaves free space unknown rather than guessing zero', async () => {
  const diskProbe = {
    read: async () => {
      throw new Error('volume unreadable');
    }
  };

  const capability = await new NativeModelDownloadManager({
    homeDirectory: createHomeDirectory(),
    diskProbe
  }).capability();

  // `null` means "no limit known", so a row is never marked unsupported on a
  // failed reading.
  assert.equal(capability.freeDiskBytes, null);
});

test('models this Mac has the memory for are listed before the ones it does not', async () => {
  const capability = { ...NO_LIMITS, totalRamBytes: 24 * 1_073_741_824 };
  const tooBig = { ...ARTIFACT, id: 'a', name: 'A 700B', requiredRamBytes: 229 * 1_073_741_824 };
  const fits = { ...ARTIFACT, id: 'z', name: 'Z 8B', requiredRamBytes: 8 * 1_073_741_824 };

  const rows = await new NativeModelDownloadManager({ homeDirectory: createHomeDirectory() })
    .projectRows([tooBig, fits], capability);

  // Alphabetically "A 700B" leads; what this Mac can run has to win over that.
  assert.deepEqual(rows.map((row) => row.name), ['Z 8B', 'A 700B']);
});

test('a completed download leaves a manifest the installed list can read offline', async () => {
  const home = createHomeDirectory();
  const store = new DownloadedModelStore({ homeDirectory: home });
  writeModelFile(home, 4096);

  await store.writeManifest(ARTIFACT);
  const installed = await store.listInstalled();

  assert.equal(installed.length, 1);
  assert.equal(installed[0].id, ARTIFACT.id);
  assert.equal(installed[0].name, 'Qwen3 8B Q4_K_M');
  assert.equal(installed[0].provider, 'Qwen');
  // The file's real length, not the two-decimal GB figure the catalog quotes.
  assert.equal(installed[0].sizeBytes, 4096);
});

test('a model folder with no manifest is still listed, named after its artifact', async () => {
  const home = createHomeDirectory();
  // What a download from before manifests existed, or a hand-placed file, looks like.
  writeModelFile(home, 4096);

  const [installed] = await new DownloadedModelStore({ homeDirectory: home }).listInstalled();

  assert.equal(installed.name, ARTIFACT.fileName);
  assert.equal(installed.sizeBytes, 4096);
});

test('GGUF files are discovered at the models root and in every nested directory', async () => {
  const home = createHomeDirectory();
  const modelsRoot = path.join(home, '.amiswifi', 'models');
  const nestedDirectory = path.join(modelsRoot, 'imports', 'qwen', 'weights');
  mkdirSync(nestedDirectory, { recursive: true });
  writeFileSync(path.join(modelsRoot, 'root-model.gguf'), Buffer.alloc(1024));
  writeFileSync(path.join(nestedDirectory, 'nested-model.GGUF'), Buffer.alloc(2048));
  writeFileSync(path.join(nestedDirectory, 'tokenizer.json'), Buffer.alloc(4096));

  const installed = await new DownloadedModelStore({ homeDirectory: home }).listInstalled();

  assert.deepEqual(installed.map((model) => model.name).sort(), ['nested-model.GGUF', 'root-model.gguf']);
  assert.deepEqual(installed.map((model) => model.sizeBytes).sort((left, right) => left - right), [1024, 2048]);
});

test('a manifest still describes a GGUF nested inside its model directory', async () => {
  const home = createHomeDirectory();
  const store = new DownloadedModelStore({ homeDirectory: home });
  const nestedArtifact = { ...ARTIFACT, fileName: 'weights/qwen3-8b-q4_k_m.gguf' };
  mkdirSync(path.dirname(store.fileFor(nestedArtifact)), { recursive: true });
  writeFileSync(store.fileFor(nestedArtifact), Buffer.alloc(4096));

  await store.writeManifest(nestedArtifact);
  const [installed] = await store.listInstalled();

  assert.equal(installed.id, ARTIFACT.id);
  assert.equal(installed.name, ARTIFACT.name);
  assert.equal(installed.filePath, store.fileFor(nestedArtifact));
});

test('an emptied model folder drops out of the installed list', async () => {
  const home = createHomeDirectory();
  const store = new DownloadedModelStore({ homeDirectory: home });
  writeModelFile(home, 4096);
  await store.writeManifest(ARTIFACT);
  // The artifact deleted from Finder; only the manifest is left behind.
  rmSync(path.join(home, '.amiswifi', 'models', ARTIFACT.id.replaceAll(':', '_'), ARTIFACT.fileName));

  assert.deepEqual(await store.listInstalled(), []);
});

test('a half-transferred file is not offered as an installed model', async () => {
  const home = createHomeDirectory();
  const store = new DownloadedModelStore({ homeDirectory: home });
  writeModelFile(home, 4096);
  await store.writeManifest(ARTIFACT);
  // Chromium writes straight to the final path, so only the saved resume point
  // tells a partial file apart from a finished one.
  mkdirSync(path.join(home, '.amiswifi'), { recursive: true });
  writeFileSync(
    path.join(home, '.amiswifi', 'model_downloads.json'),
    JSON.stringify([{ modelId: ARTIFACT.id, path: 'x', urlChain: ['https://huggingface.co/example.gguf'], offset: 4096, length: 9999 }]),
    'utf8'
  );

  const installed = await new NativeModelDownloadManager({ homeDirectory: home }).listInstalled();

  assert.deepEqual(installed, []);
});

test('a half-transferred GGUF is hidden before its manifest exists', async () => {
  const home = createHomeDirectory();
  const store = new DownloadedModelStore({ homeDirectory: home });
  writeModelFile(home, 4096);
  mkdirSync(path.join(home, '.amiswifi'), { recursive: true });
  writeFileSync(
    path.join(home, '.amiswifi', 'model_downloads.json'),
    JSON.stringify([
      {
        modelId: ARTIFACT.id,
        path: store.fileFor(ARTIFACT),
        urlChain: ['https://huggingface.co/example.gguf'],
        offset: 4096,
        length: 9999
      }
    ]),
    'utf8'
  );

  const installed = await new NativeModelDownloadManager({ homeDirectory: home }).listInstalled();

  assert.deepEqual(installed, []);
});

/**
 * Stands in for one Electron DownloadItem. `getURL()` answers with the final
 * CDN address rather than the requested one, which is what the real item does
 * after Hugging Face redirects, and what the manager has to survive.
 */
class StubDownloadItem {
  constructor(urlChain) {
    this.urlChain = urlChain;
    this.savePath = '';
    this.listeners = new Map();
    this.receivedBytes = 0;
    this.totalBytes = 4096;
  }

  getURL() {
    return this.urlChain[this.urlChain.length - 1];
  }

  getURLChain() {
    return [...this.urlChain];
  }

  setSavePath(value) {
    this.savePath = value;
  }

  getSavePath() {
    return this.savePath;
  }

  getState() {
    return 'progressing';
  }

  getTotalBytes() {
    return this.totalBytes;
  }

  getReceivedBytes() {
    return this.receivedBytes;
  }

  getLastModifiedTime() {
    return '';
  }

  getETag() {
    return '';
  }

  getStartTime() {
    return 0;
  }

  cancel() {}

  on(event, listener) {
    this.listeners.set(event, listener);
  }

  once(event, listener) {
    this.listeners.set(event, listener);
  }

  emit(event, state) {
    this.listeners.get(event)?.({}, state);
  }
}

/** Captures the manager's `will-download` handler so a stub item can be fed to it. */
class StubDownloadSession {
  constructor() {
    this.handler = null;
    this.requestedUrls = [];
  }

  on(event, handler) {
    if (event === 'will-download') this.handler = handler;
  }

  downloadURL(url) {
    this.requestedUrls.push(url);
  }

  createInterruptedDownload() {}
}

test('a download redirected to another host is still claimed by the model that started it', async () => {
  const home = createHomeDirectory();
  const downloadSession = new StubDownloadSession();
  const manager = new NativeModelDownloadManager({ homeDirectory: home });
  manager.attachDownloadSession(downloadSession);

  await manager.startDownload(ARTIFACT, NO_LIMITS);
  // What Hugging Face really does: 302 the GGUF to a signed URL on a CDN host
  // that shares no prefix with the catalog address.
  const item = new StubDownloadItem([
    ARTIFACT.huggingFaceUrl,
    'https://us.aws.cdn.hf.co/xet-bridge-us/abc123?Signature=xyz'
  ]);
  downloadSession.handler({}, item);

  assert.equal(item.getSavePath(), path.join(home, '.amiswifi', 'models', ARTIFACT.id.replaceAll(':', '_'), ARTIFACT.fileName));
});

test('a finished transfer records the manifest and reports the model as downloaded', async () => {
  const home = createHomeDirectory();
  const downloadSession = new StubDownloadSession();
  const manager = new NativeModelDownloadManager({ homeDirectory: home });
  manager.attachDownloadSession(downloadSession);
  await manager.startDownload(ARTIFACT, NO_LIMITS);
  const item = new StubDownloadItem([ARTIFACT.huggingFaceUrl]);
  downloadSession.handler({}, item);

  // Chromium only publishes the file at the end, so write it before "done".
  writeModelFile(home, 4096);
  item.receivedBytes = 4096;
  item.emit('done', 'completed');
  // The manifest is written without blocking the event, and writing it stats
  // the file first, so a single tick is not enough to be sure it has landed.
  await waitFor(async () => (await manager.listInstalled()).length > 0);

  const [row] = await manager.projectRows([ARTIFACT], NO_LIMITS);
  assert.equal(row.lifecycle, 'downloaded');
  assert.equal(row.progress, 1);

  const [installed] = await manager.listInstalled();
  assert.equal(installed.id, ARTIFACT.id);
  assert.equal(installed.name, ARTIFACT.name);
  assert.equal(installed.provider, 'Qwen');
});

test('a model larger than the free disk is shown but not offered', async () => {
  const capability = { ...NO_LIMITS, freeDiskBytes: 1_000_000 };

  const [row] = await new NativeModelDownloadManager({ homeDirectory: createHomeDirectory() })
    .projectRows([ARTIFACT], capability);

  assert.equal(row.isTargetSupported, false);
  assert.equal(row.lifecycle, 'unsupported');
});
