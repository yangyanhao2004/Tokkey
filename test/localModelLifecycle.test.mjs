import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

import IpcControllerModule from '../dist/main/IpcController.js';
import { LocalModelManager } from '../dist/main/models/LocalModelManager.js';

const IpcController = IpcControllerModule.default;

// The Tokkey page's button copy lives in the renderer, which is bundled rather
// than emitted to `dist`, so it is built here the way the app builds it.
const { outputFiles } = await build({
  entryPoints: ['src/renderer/pages/tokkeyContent.ts'],
  bundle: true, write: false, format: 'esm', platform: 'node'
});
const {
  describeInstalledModel,
  describeModelRemoveButton,
  describeModelRuntimeButton,
  describeRecommendedButtons,
  findRecommendedInstall,
  orderInstalledModels
} = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
);

const MODEL_ID = 'qwen:a';
const ENDPOINT = 'http://127.0.0.1:8081/v1';

/** One published runtime state, with the fields the buttons never read elided. */
function runtimeState(phase, modelId = MODEL_ID) {
  return {
    phase,
    modelId,
    endpoint: phase === 'running' ? ENDPOINT : null,
    error: phase === 'failed' ? 'The Amis Hub llama-server exited (SIGKILL).' : null,
    device: null
  };
}

function lifecycleState(phase, { busyModelId = null, busyAction = null, modelId = MODEL_ID } = {}) {
  return { runtime: runtimeState(phase, modelId), busyModelId, busyAction };
}

function buttonFor(phase, options) {
  return describeModelRuntimeButton(MODEL_ID, lifecycleState(phase, options));
}

function removeButtonFor(phase, options) {
  return describeModelRemoveButton(MODEL_ID, lifecycleState(phase, options));
}

/** The share of the button the design fills while a start or stop is in flight. */
const TRACK = 0.25;

test('the lifecycle button follows the server from Start through Stop and back', () => {
  assert.deepEqual(buttonFor('idle', { modelId: null }), {
    kind: 'start', label: 'Start', disabled: false, progress: null
  });
  // The press is answered before the main process has published anything.
  assert.deepEqual(buttonFor('idle', { modelId: null, busyModelId: MODEL_ID, busyAction: 'start' }), {
    kind: 'start', label: 'Starting…', disabled: true, progress: TRACK
  });
  assert.deepEqual(buttonFor('starting'), {
    kind: 'start', label: 'Starting…', disabled: true, progress: TRACK
  });
  assert.deepEqual(buttonFor('running'), {
    kind: 'stop', label: 'Stop', disabled: false, progress: null
  });
  assert.deepEqual(buttonFor('running', { busyModelId: MODEL_ID, busyAction: 'stop' }), {
    kind: 'stop', label: 'Stopping…', disabled: true, progress: TRACK
  });
  // The runtime's own tear-down phase, so a window that did not press the
  // button reads "Stopping…" too.
  assert.deepEqual(buttonFor('stopping'), {
    kind: 'stop', label: 'Stopping…', disabled: true, progress: TRACK
  });
  // A start that failed offers the retry rather than stranding the row.
  assert.deepEqual(buttonFor('failed'), {
    kind: 'start', label: 'Start', disabled: false, progress: null
  });
});

test('only an in-flight state wears the progress track the design draws', () => {
  // Figma 531:817: the button is its own track while the server comes up, and
  // a flat, pressable chip once it has settled either way.
  const inFlight = ['starting', 'stopping'].map((phase) => buttonFor(phase).progress);
  const settled = ['idle', 'running', 'failed'].map((phase) => buttonFor(phase).progress);

  assert.deepEqual(inFlight, [TRACK, TRACK]);
  assert.deepEqual(settled, [null, null, null]);
});

test('a model the runtime is not serving reads as startable whatever another one is doing', () => {
  const otherModelRunning = buttonFor('running', { modelId: 'meta:a' });

  assert.deepEqual(otherModelRunning, {
    kind: 'start', label: 'Start', disabled: false, progress: null
  });
});

test('Remove is the step after Stop, and is inert until the server is down', () => {
  assert.deepEqual(removeButtonFor('idle', { modelId: null }), {
    kind: 'remove', label: 'Remove', disabled: false
  });
  assert.equal(removeButtonFor('starting').disabled, true);
  assert.equal(removeButtonFor('running').disabled, true);
  assert.equal(removeButtonFor('stopping').disabled, true);
  // A server that died leaves nothing to stop, so its files can go.
  assert.equal(removeButtonFor('failed').disabled, false);
  // Another model's server says nothing about this one's files.
  assert.equal(removeButtonFor('running', { modelId: 'meta:a' }).disabled, false);
  assert.deepEqual(
    removeButtonFor('idle', { modelId: null, busyModelId: MODEL_ID, busyAction: 'remove' }),
    { kind: 'remove', label: 'Removing...', disabled: true }
  );
});

/** The recommended artifact as the catalog reports it, before it is downloaded. */
const RECOMMENDED_ROW = {
  id: 'qwen:qwen3.5:qwen3.5-35b:Q4_K_M',
  fileName: 'Qwen3.5-35B-A3B-UD-Q4_K_M.gguf',
  lifecycle: 'downloadable',
  progress: null
};

/** The same artifact once its bytes are on disk, as the installed list sees it. */
const RECOMMENDED_INSTALL = {
  id: 'local-file:Qwen3.5-35B-A3B-UD-Q4_K_M.gguf',
  name: 'Qwen3.5 35B A3B UD Q4_K_M',
  provider: 'Qwen',
  fileName: 'Qwen3.5-35B-A3B-UD-Q4_K_M.gguf',
  sizeBytes: 21_474_836_480
};

test('the badge only ever offers the transfer, never the lifecycle', () => {
  // Every state it can be in is a download state: by the time the model can be
  // started, the list below holds it.
  const offered = ['downloadable', 'downloading', 'downloadFailed', 'unsupported'].flatMap(
    (lifecycle) => describeRecommendedButtons({ ...RECOMMENDED_ROW, lifecycle }).map((button) => button.kind)
  );

  assert.deepEqual(offered, ['download', 'cancel', 'download', 'download']);
});

test('the recommended model moves to the list once downloaded, and back when removed', () => {
  // Matched on the file name, which is the one thing a path-derived installed id
  // and a catalog id still have in common.
  const whileDownloading = findRecommendedInstall([], RECOMMENDED_ROW);
  const onceDownloaded = findRecommendedInstall([RECOMMENDED_INSTALL], RECOMMENDED_ROW);
  const onceRemoved = findRecommendedInstall([], RECOMMENDED_ROW);

  // `null` is what keeps the badge on the page; an install takes it off.
  assert.equal(whileDownloading, null);
  assert.equal(onceDownloaded?.id, RECOMMENDED_INSTALL.id);
  assert.equal(onceRemoved, null);
});

test('the recommended row leads the list however recently the others arrived', () => {
  // The store hands the list over newest download first, so a model installed
  // after the recommended one would otherwise push it down.
  const newer = { ...RECOMMENDED_INSTALL, id: 'mistral:b', fileName: 'Mistral.gguf' };
  const listed = [newer, RECOMMENDED_INSTALL];

  const pinned = orderInstalledModels(listed, RECOMMENDED_INSTALL.id);
  const unpinned = orderInstalledModels(listed, null);

  assert.deepEqual(pinned.map((model) => model.id), [RECOMMENDED_INSTALL.id, 'mistral:b']);
  // Nothing to pin while the badge still holds it: the store's order stands.
  assert.deepEqual(unpinned.map((model) => model.id), ['mistral:b', RECOMMENDED_INSTALL.id]);
  assert.deepEqual(listed.map((model) => model.id), ['mistral:b', RECOMMENDED_INSTALL.id]);
  assert.deepEqual(orderInstalledModels(null, RECOMMENDED_INSTALL.id), []);
});

test('the row that took the badge over says so, and the rows beside it do not', () => {
  const recommendedRow = describeInstalledModel(RECOMMENDED_INSTALL, true);
  const ordinaryRow = describeInstalledModel(RECOMMENDED_INSTALL, false);

  assert.equal(recommendedRow.isRecommended, true);
  assert.match(recommendedRow.detail, /^Recommended · /);
  assert.equal(ordinaryRow.isRecommended, false);
  assert.doesNotMatch(ordinaryRow.detail, /Recommended/);
});

/**
 * A runtime the test drives by hand, so the manager is seen reacting to the
 * phases it publishes rather than to the calls the test made.
 */
function createManager() {
  const calls = [];
  let listener = () => {};
  let published = runtimeState('idle', null);
  const publish = (next) => {
    published = next;
    listener(next);
  };
  const manager = new LocalModelManager({
    catalog: { load: async () => ({ models: [], providers: [], fromCache: true }) },
    downloader: {
      capability: async () => ({ target: 'mac', freeDiskBytes: null, totalRamBytes: null, platform: 'darwin' }),
      projectRows: async () => [],
      listInstalled: async () => [{
        id: MODEL_ID,
        name: 'Qwen3 8B',
        fileName: 'qwen3-8b.gguf',
        filePath: '/models/qwen3-8b.gguf'
      }],
      removeInstalled: async (modelId) => {
        calls.push(`removed:${modelId}`);
        return [];
      },
      markDeploymentReady: (modelId, endpoint) => calls.push(`ready:${modelId}@${endpoint}`),
      markDeploymentStopping: (modelId) => calls.push(`stopping:${modelId}`),
      markDeploymentStopped: (modelId) => calls.push(`stopped:${modelId}`),
      markDeploymentFailed: (modelId) => calls.push(`failed:${modelId}`)
    },
    localRuntime: {
      subscribe: (next) => {
        listener = next;
        return () => {};
      },
      getState: async () => published,
      getLocalChatRuntimeState: () => ({
        status: published.phase === 'running' ? 'ready' : 'unavailable',
        model: published.modelId ? { id: published.modelId, label: 'Qwen3 8B' } : null,
        contextWindowTokens: published.phase === 'running' ? 16384 : null,
        error: published.error
      }),
      startModel: async (model) => {
        calls.push(`start:${model.id}`);
        publish(runtimeState('starting', model.id));
        publish(runtimeState('running', model.id));
        return published;
      },
      stopModel: async () => {
        calls.push('stop');
        if (published.modelId) publish({ ...published, phase: 'stopping', endpoint: null });
        publish(runtimeState('idle', null));
        return published;
      },
      chatCompletionsUrl: () => `${ENDPOINT}/chat/completions`,
      chatRequestHeaders: () => ({})
    }
  });
  return { manager, calls, publish };
}

test('the manager takes a model through start, stop, and remove', async () => {
  const { manager, calls } = createManager();

  await manager.startInstalledModel(MODEL_ID);
  await manager.stopModel();
  await manager.removeInstalled(MODEL_ID);

  // Each catalog mark is the one the runtime's own phase asked for, in order.
  assert.deepEqual(calls, [
    `start:${MODEL_ID}`,
    `ready:${MODEL_ID}@http://127.0.0.1:8081`,
    'stop',
    `stopping:${MODEL_ID}`,
    `stopped:${MODEL_ID}`,
    `removed:${MODEL_ID}`
  ]);
});

test('starting a model already running does nothing rather than restarting it', async () => {
  const { manager, calls } = createManager();

  await manager.startInstalledModel(MODEL_ID);
  const repeated = await manager.startInstalledModel(MODEL_ID);

  assert.equal(repeated.status, 'ready');
  assert.deepEqual(calls.filter((call) => call.startsWith('start:')), [`start:${MODEL_ID}`]);
});

test('a stop asked for anywhere else still clears the deployment its row shows', async () => {
  // The runtime is stopped without the manager being asked, so the manager
  // only ever sees the phases that follow.
  const { manager, calls, publish } = createManager();

  await manager.startInstalledModel(MODEL_ID);
  calls.length = 0;
  publish({ ...runtimeState('running'), phase: 'stopping', endpoint: null });
  publish(runtimeState('idle', null));

  assert.deepEqual(calls, [`stopping:${MODEL_ID}`, `stopped:${MODEL_ID}`]);
});

test('a runtime that never served a model has no deployment to clear', () => {
  const { calls, publish } = createManager();

  publish(runtimeState('idle', null));

  assert.deepEqual(calls, []);
});

test('a server that exited reports the failure rather than a clean stop', async () => {
  const { manager, calls, publish } = createManager();

  await manager.startInstalledModel(MODEL_ID);
  calls.length = 0;
  publish(runtimeState('failed'));
  publish(runtimeState('idle', null));

  assert.deepEqual(calls, [`failed:${MODEL_ID}`]);
});

test('removing a model stops the server that is serving it first', async () => {
  const { manager, calls } = createManager();

  await manager.startInstalledModel(MODEL_ID);
  calls.length = 0;
  await manager.removeInstalled(MODEL_ID);

  assert.deepEqual(calls, ['stop', `stopping:${MODEL_ID}`, `stopped:${MODEL_ID}`, `removed:${MODEL_ID}`]);
});

test('every lifecycle IPC call is answered by the manager, not the runtime', async () => {
  const asked = [];
  const refuse = (name) => () => {
    throw new Error(`The runtime was asked to ${name} directly.`);
  };
  const controller = new IpcController({
    accountService: {},
    chatSessionStore: {},
    localChatTurnExecutor: {},
    hostSnapshotService: {},
    // Only the state the Chat runtime serves; every lifecycle call must fail.
    tokenHubRuntime: {
      subscribe: () => () => {},
      getState: refuse('report its state'),
      startModel: refuse('start'),
      stopModel: refuse('stop')
    },
    localModelManager: {
      getRuntimeState: async () => {
        asked.push('getRuntimeState');
        return runtimeState('running');
      },
      startDownload: async (modelId) => asked.push(`startDownload:${modelId}`),
      startInstalledModel: async (modelId) => asked.push(`startInstalledModel:${modelId}`),
      stopModel: async () => asked.push('stopModel'),
      removeInstalled: async (modelId) => asked.push(`removeInstalled:${modelId}`)
    }
  });

  await controller.startLocalModelDownload(MODEL_ID);
  await controller.startInstalledLocalModel(MODEL_ID);
  assert.deepEqual(await controller.getLocalModelRuntimeState(), runtimeState('running'));
  await controller.stopLocalModelRuntime();
  await controller.removeInstalledLocalModel(MODEL_ID);

  assert.deepEqual(asked, [
    `startDownload:${MODEL_ID}`,
    `startInstalledModel:${MODEL_ID}`,
    'getRuntimeState',
    'stopModel',
    `removeInstalled:${MODEL_ID}`
  ]);
});
