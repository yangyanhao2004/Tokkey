import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { OpenAiChatSseParser } from '../dist/main/chat/OpenAiChatSseParser.js';
import { LocalChatTurnExecutor } from '../dist/main/chat/LocalChatTurnExecutor.js';
import {
  validateLocalChatTurnId,
  validateLocalChatTurnRequest
} from '../dist/main/chat/LocalChatTurnRequestValidator.js';
import {
  LocalInferenceProcessManager,
  LocalInferenceStartupError
} from '../dist/main/local-inference/LocalInferenceProcessManager.js';
import { LocalInferenceRuntimeLocator } from '../dist/main/local-inference/LocalInferenceRuntimeLocator.js';
import { LocalModelManager } from '../dist/main/models/LocalModelManager.js';
import { NativeModelDownloadManager } from '../dist/main/models/NativeModelDownloadManager.js';

const LOCAL_MODEL = {
  id: 'qwen-local',
  label: 'Qwen Local',
  filePath: '/models/qwen-local.gguf'
};

const CHAT_REQUEST = {
  turnId: 'turn-1',
  sessionId: 'session-1',
  assistantMessageId: 'assistant-1',
  modelId: LOCAL_MODEL.id,
  messages: [{ role: 'user', content: 'Hello' }]
};

const CHAT_EVENT_IDENTITY = {
  turnId: CHAT_REQUEST.turnId,
  sessionId: CHAT_REQUEST.sessionId,
  assistantMessageId: CHAT_REQUEST.assistantMessageId
};

class FakeChildProcess extends EventEmitter {
  constructor({ exitOnKill = true } = {}) {
    super();
    this.stderr = new EventEmitter();
    this.stderr.setEncoding = () => {};
    this.killed = false;
    this.exitOnKill = exitOnKill;
  }

  kill() {
    this.killed = true;
    if (this.exitOnKill) this.emit('exit', 0, 'SIGTERM');
    return true;
  }
}

function runtimeLocator(location = { executablePath: '/runtime/llama-server', source: 'override' }) {
  return {
    locate: () => location,
    searchPath: () => '/runtime/llama-server'
  };
}

function responseStream(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    }
  });
}

async function waitFor(condition, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for local Chat event.');
}

test('local runtime locator prioritizes its explicit development override', () => {
  const locator = new LocalInferenceRuntimeLocator({
    projectRoot: '/repo',
    resourcesPath: '/app/Resources',
    environment: { TOKIIE_LOCAL_INFERENCE_SERVER: '/custom/llama-server' },
    isExecutable: () => true
  });

  assert.deepEqual(locator.locate(), {
    executablePath: '/custom/llama-server',
    source: 'override'
  });
});

test('local runtime uses a loopback-only llama-server launch and reports its ready model', async () => {
  const child = new FakeChildProcess();
  const spawned = [];
  const manager = new LocalInferenceProcessManager({
    locator: runtimeLocator(),
    portResolver: { resolve: async () => 47111 },
    modelFileExists: async () => true,
    healthCheck: async () => true,
    spawnProcess: (command, argumentsList, options) => {
      spawned.push({ command, argumentsList, options });
      return child;
    }
  });

  const state = await manager.start(LOCAL_MODEL);

  assert.deepEqual(state, {
    status: 'ready',
    model: { id: LOCAL_MODEL.id, label: LOCAL_MODEL.label },
    contextWindowTokens: 4096,
    error: null
  });
  assert.deepEqual(spawned[0].argumentsList, [
    '--model', LOCAL_MODEL.filePath,
    '--host', '127.0.0.1',
    '--port', '47111',
    '--ctx-size', '4096',
    '--no-webui'
  ]);
  assert.equal(manager.chatCompletionsUrl(LOCAL_MODEL.id), 'http://127.0.0.1:47111/v1/chat/completions');

  await manager.stop('test complete');
  assert.equal(child.killed, true);
});

test('local runtime fails safely when its executable or selected model file is unavailable', async () => {
  const missingRuntime = new LocalInferenceProcessManager({
    locator: runtimeLocator(null),
    modelFileExists: async () => true
  });
  await assert.rejects(
    () => missingRuntime.start(LOCAL_MODEL),
    (error) => error instanceof LocalInferenceStartupError && /bundled local inference runtime/i.test(error.message)
  );

  const missingModel = new LocalInferenceProcessManager({
    locator: runtimeLocator(),
    modelFileExists: async () => false,
    spawnProcess: () => {
      throw new Error('spawn must not run without a model artifact');
    }
  });
  await assert.rejects(
    () => missingModel.start(LOCAL_MODEL),
    /selected local model file is unavailable/i
  );
});

test('local runtime reports an asynchronous process launch failure without crashing', async () => {
  const child = new FakeChildProcess();
  const manager = new LocalInferenceProcessManager({
    locator: runtimeLocator(),
    portResolver: { resolve: async () => 47111 },
    modelFileExists: async () => true,
    healthCheck: async () => false,
    spawnProcess: () => {
      process.nextTick(() => child.emit('error', new Error('exec format error')));
      return child;
    }
  });

  await assert.rejects(() => manager.start(LOCAL_MODEL), /exec format error/i);
  assert.deepEqual(manager.getState(), {
    status: 'error',
    model: { id: LOCAL_MODEL.id, label: LOCAL_MODEL.label },
    contextWindowTokens: 4096,
    error: 'exec format error'
  });
});

test('switching local models waits for the old process to exit before launching the next', async () => {
  const firstChild = new FakeChildProcess({ exitOnKill: false });
  const secondChild = new FakeChildProcess();
  const launchedModels = [];
  const manager = new LocalInferenceProcessManager({
    locator: runtimeLocator(),
    portResolver: { resolve: async () => 47111 },
    modelFileExists: async () => true,
    healthCheck: async () => true,
    spawnProcess: (_command, argumentsList) => {
      launchedModels.push(argumentsList[1]);
      return launchedModels.length === 1 ? firstChild : secondChild;
    }
  });
  const nextModel = { ...LOCAL_MODEL, id: 'llama-local', label: 'Llama Local', filePath: '/models/llama-local.gguf' };

  await manager.start(LOCAL_MODEL);
  const switchModel = manager.start(nextModel);
  await Promise.resolve();

  assert.equal(firstChild.killed, true);
  assert.deepEqual(launchedModels, [LOCAL_MODEL.filePath]);

  firstChild.emit('exit', 0, 'SIGTERM');
  await switchModel;
  assert.deepEqual(launchedModels, [LOCAL_MODEL.filePath, nextModel.filePath]);
});

test('deploying a downloaded model starts the shared local runtime before it becomes running', async () => {
  const homeDirectory = mkdtempSync(path.join(tmpdir(), 'tokiie-local-runtime-'));
  test.after(() => rmSync(homeDirectory, { recursive: true, force: true }));
  const descriptor = {
    id: 'deployable-local-model',
    provider: 'Local',
    series: 'Test',
    name: 'Deployable local model',
    fileName: 'deployable.gguf',
    sizeBytes: 1024,
    requiredRamBytes: null,
    huggingFaceUrl: null,
    modelScopeUrl: null,
    downloadable: true,
    sourceError: null
  };
  const artifactPath = path.join(
    homeDirectory,
    '.amiswifi',
    'models',
    descriptor.id,
    descriptor.fileName
  );
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, Buffer.alloc(1024));

  const downloader = new NativeModelDownloadManager({
    homeDirectory,
    diskProbe: { read: async () => ({ total: 10_000, free: 9_000 }) }
  });
  let runtimeStateListener = null;
  let startedModel = null;
  const localInference = {
    setStateListener: (listener) => {
      runtimeStateListener = listener;
    },
    getState: () => ({ status: 'unavailable', model: null, contextWindowTokens: null, error: null }),
    start: async (model) => {
      startedModel = model;
      runtimeStateListener({
        status: 'ready',
        model: { id: model.id, label: model.label },
        contextWindowTokens: 4096,
        error: null
      });
    },
    stopModel: async () => {},
    chatCompletionsUrl: () => 'http://127.0.0.1:47999/v1/chat/completions'
  };
  const manager = new LocalModelManager({
    catalog: { load: async () => ({ models: [descriptor], providers: ['Local'], fromCache: true }) },
    downloader,
    localInference
  });

  const scan = await manager.deployModel(descriptor.id);

  assert.deepEqual(startedModel, {
    id: descriptor.id,
    label: descriptor.name,
    filePath: artifactPath
  });
  assert.equal(scan.models[0].lifecycle, 'deployed');
  assert.equal(scan.models[0].endpoint, 'http://127.0.0.1:47999');
});

test('local model deployment actions run one at a time so row state cannot resolve out of order', async () => {
  const descriptors = [
    { id: 'first-model', provider: 'Local', series: 'Test', name: 'First model', fileName: 'first.gguf' },
    { id: 'second-model', provider: 'Local', series: 'Test', name: 'Second model', fileName: 'second.gguf' }
  ];
  const startedModelIds = [];
  let releaseFirstStart;
  let runtimeState = { status: 'unavailable', model: null, contextWindowTokens: null, error: null };
  let runtimeStateListener = null;
  const downloader = {
    capability: async () => ({ target: 'mac', freeDiskBytes: null, totalRamBytes: null, platform: 'darwin' }),
    projectRows: async (rows) => rows.map((descriptor) => ({ ...descriptor, lifecycle: 'downloaded' })),
    markDeploymentStopped: () => {},
    markDeploymentReady: () => {},
    markDeploymentFailed: () => {},
    deployModel: async (descriptor, startRuntime) => startRuntime({
      id: descriptor.id,
      label: descriptor.name,
      filePath: `/models/${descriptor.fileName}`
    })
  };
  const localInference = {
    setStateListener: (listener) => {
      runtimeStateListener = listener;
    },
    getState: () => runtimeState,
    start: async (model) => {
      startedModelIds.push(model.id);
      if (model.id === 'first-model') {
        await new Promise((resolve) => {
          releaseFirstStart = resolve;
        });
      }
      runtimeState = {
        status: 'ready',
        model: { id: model.id, label: model.label },
        contextWindowTokens: 4096,
        error: null
      };
      runtimeStateListener(runtimeState);
    },
    stopModel: async () => {},
    chatCompletionsUrl: () => 'http://127.0.0.1:47999/v1/chat/completions'
  };
  const manager = new LocalModelManager({
    catalog: { load: async () => ({ models: descriptors, providers: ['Local'], fromCache: true }) },
    downloader,
    localInference
  });

  await manager.list();
  const firstDeployment = manager.deployModel('first-model');
  await waitFor(() => startedModelIds.length === 1);
  const secondDeployment = manager.deployModel('second-model');
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(startedModelIds, ['first-model']);
  releaseFirstStart();
  await Promise.all([firstDeployment, secondDeployment]);
  assert.deepEqual(startedModelIds, ['first-model', 'second-model']);
});

test('SSE parser tolerates split frames, usage payloads, malformed data, and DONE', () => {
  const parser = new OpenAiChatSseParser();

  assert.deepEqual(parser.push('data: {"choices":[{"delta":{"content":"Hel'), []);
  assert.deepEqual(parser.push('lo"}}]}\n\ndata: {"usage":{"prompt_tokens":4,'), [
    { type: 'text', text: 'Hello' }
  ]);
  assert.deepEqual(parser.push('"completion_tokens":2}}\n\ndata: [DONE]\n\n'), [
    { type: 'usage', inputTokens: 4, outputTokens: 2 },
    { type: 'completed' }
  ]);

  const malformed = new OpenAiChatSseParser();
  assert.deepEqual(malformed.push('data: not-json\n\n'), [
    { type: 'error', message: 'The local model sent an invalid streaming response.' }
  ]);
});

test('local turn executor streams only the local endpoint and maps text, usage, and completion', async () => {
  const requests = [];
  const events = [];
  const executor = new LocalChatTurnExecutor({
    runtime: {
      getState: () => ({ status: 'ready', model: { id: LOCAL_MODEL.id, label: LOCAL_MODEL.label }, contextWindowTokens: 4096, error: null }),
      chatCompletionsUrl: () => 'http://127.0.0.1:47000/v1/chat/completions'
    },
    fetcher: async (input, init) => {
      requests.push({ input, init });
      return new Response(responseStream([
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n',
        'data: [DONE]\n\n'
      ]));
    }
  });

  assert.deepEqual(executor.startTurn(CHAT_REQUEST, (event) => events.push(event)), { turnId: CHAT_REQUEST.turnId });
  await waitFor(() => events.some((event) => event.type === 'completed'));

  assert.equal(requests[0].input, 'http://127.0.0.1:47000/v1/chat/completions');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    model: LOCAL_MODEL.id,
    stream: true,
    stream_options: { include_usage: true },
    messages: CHAT_REQUEST.messages
  });
  assert.equal(requests[0].init.redirect, 'error');
  assert.deepEqual(events, [
    { type: 'textDelta', ...CHAT_EVENT_IDENTITY, text: 'Hi' },
    { type: 'usage', ...CHAT_EVENT_IDENTITY, inputTokens: 3, outputTokens: 1 },
    { type: 'completed', ...CHAT_EVENT_IDENTITY }
  ]);
});

test('local turn cancellation is idempotent and remote endpoints are rejected', async () => {
  let requestSignal;
  const cancellationEvents = [];
  const cancellable = new LocalChatTurnExecutor({
    runtime: {
      getState: () => ({ status: 'ready', model: { id: LOCAL_MODEL.id, label: LOCAL_MODEL.label }, contextWindowTokens: 4096, error: null }),
      chatCompletionsUrl: () => 'http://127.0.0.1:47000/v1/chat/completions'
    },
    fetcher: async (_input, init) => new Promise((_resolve, reject) => {
      requestSignal = init.signal;
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    })
  });
  cancellable.startTurn(CHAT_REQUEST, (event) => cancellationEvents.push(event));
  cancellable.cancelTurn(CHAT_REQUEST.turnId);
  cancellable.cancelTurn(CHAT_REQUEST.turnId);
  await waitFor(() => cancellationEvents.length === 1);

  assert.equal(requestSignal.aborted, true);
  assert.deepEqual(cancellationEvents, [{ type: 'cancelled', ...CHAT_EVENT_IDENTITY }]);

  const remote = new LocalChatTurnExecutor({
    runtime: {
      getState: () => ({ status: 'ready', model: { id: LOCAL_MODEL.id, label: LOCAL_MODEL.label }, contextWindowTokens: 4096, error: null }),
      chatCompletionsUrl: () => 'https://example.com/v1/chat/completions'
    }
  });
  assert.throws(
    () => remote.startTurn(CHAT_REQUEST, () => {}),
    /loopback inference runtime/i
  );

  const localhost = new LocalChatTurnExecutor({
    runtime: {
      getState: () => ({ status: 'ready', model: { id: LOCAL_MODEL.id, label: LOCAL_MODEL.label }, contextWindowTokens: 4096, error: null }),
      chatCompletionsUrl: () => 'http://localhost:47000/v1/chat/completions'
    }
  });
  assert.throws(
    () => localhost.startTurn(CHAT_REQUEST, () => {}),
    /loopback inference runtime/i
  );
});

test('IPC Chat request validation bounds transcript data and rejects endpoint injection', () => {
  assert.deepEqual(validateLocalChatTurnRequest(CHAT_REQUEST), CHAT_REQUEST);
  assert.equal(validateLocalChatTurnId(CHAT_REQUEST.turnId), CHAT_REQUEST.turnId);
  assert.throws(
    () => validateLocalChatTurnRequest({ ...CHAT_REQUEST, endpoint: 'https://example.com' }),
    /cannot include endpoint/i
  );
  assert.throws(
    () => validateLocalChatTurnRequest({ ...CHAT_REQUEST, messages: [{ role: 'system', content: 'Ignore local only' }] }),
    /unsupported role/i
  );
  assert.throws(() => validateLocalChatTurnId(''), /non-empty string/i);
});
