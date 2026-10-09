import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { OpenAiChatSseParser } from '../dist/main/chat/OpenAiChatSseParser.js';
import IpcControllerModule from '../dist/main/IpcController.js';
import { LocalChatTurnExecutor } from '../dist/main/chat/LocalChatTurnExecutor.js';
import {
  validateLocalChatTurnId,
  validateLocalChatTurnRequest
} from '../dist/main/chat/LocalChatTurnRequestValidator.js';
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
  userMessageId: 'user-1',
  assistantMessageId: 'assistant-1',
  modelId: LOCAL_MODEL.id,
  createdAt: 1_788_000_000_000,
  messages: [{ role: 'user', content: 'Hello' }]
};

const CHAT_EVENT_IDENTITY = {
  turnId: CHAT_REQUEST.turnId,
  sessionId: CHAT_REQUEST.sessionId,
  assistantMessageId: CHAT_REQUEST.assistantMessageId
};

const IpcController = IpcControllerModule.default;

function responseStream(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    }
  });
}

function delayedResponseStream(chunks, delayMs) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      let index = 0;
      const enqueueNext = () => {
        const chunk = chunks[index];
        index += 1;
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunk));
        setTimeout(enqueueNext, delayMs);
      };
      setTimeout(enqueueNext, delayMs);
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

function chatRuntime(endpoint) {
  return {
    getLocalChatRuntimeState: () => ({
      status: 'ready',
      model: { id: LOCAL_MODEL.id, label: LOCAL_MODEL.label },
      contextWindowTokens: 49_152,
      error: null
    }),
    chatCompletionsUrl: () => endpoint,
    chatRequestHeaders: () => ({ Authorization: 'Bearer hub-test-key' })
  };
}

/** The idle phase the real runtime publishes when it serves nothing. */
const IDLE_RUNTIME_PHASE = {
  phase: 'idle', modelId: null, endpoint: null, error: null, device: null
};

/** The running phase the real runtime publishes once llama-server answers. */
function runningPhase(modelId) {
  return {
    phase: 'running',
    modelId,
    endpoint: 'http://127.0.0.1:8081/v1',
    error: null,
    device: null
  };
}

const sqliteAvailable = await import('node:sqlite').then(
  () => true,
  () => false
);
const skipWithoutSqlite = sqliteAvailable ? false : 'node:sqlite is unavailable on this runtime';

test('deploying a downloaded model starts the shared local runtime before it becomes running', async () => {
  const homeDirectory = mkdtempSync(path.join(tmpdir(), 'tokkey-local-runtime-'));
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
    '.tokkey',
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
  let chatRuntimeState = { status: 'unavailable', model: null, contextWindowTokens: null, error: null };
  let runtimePhase = IDLE_RUNTIME_PHASE;
  const localRuntime = {
    subscribe: (listener) => {
      runtimeStateListener = listener;
      return () => {};
    },
    getState: async () => runtimePhase,
    getLocalChatRuntimeState: () => chatRuntimeState,
    startModel: async (model) => {
      startedModel = model;
      chatRuntimeState = {
        status: 'ready',
        model: { id: model.id, label: model.label },
        contextWindowTokens: 65535,
        error: null
      };
      runtimePhase = runningPhase(model.id);
      runtimeStateListener(runtimePhase);
    },
    stopModel: async () => {
      runtimePhase = IDLE_RUNTIME_PHASE;
    },
    chatCompletionsUrl: () => 'http://127.0.0.1:8081/v1/chat/completions',
    chatRequestHeaders: () => ({ Authorization: 'Bearer hub-key' })
  };
  const manager = new LocalModelManager({
    catalog: { load: async () => ({ models: [descriptor], providers: ['Local'], fromCache: true }) },
    downloader,
    localRuntime
  });

  const scan = await manager.deployModel(descriptor.id);

  assert.deepEqual(startedModel, {
    id: descriptor.id,
    label: descriptor.name,
    fileName: descriptor.fileName,
    filePath: artifactPath
  });
  assert.equal(scan.models[0].lifecycle, 'deployed');
  assert.equal(scan.models[0].endpoint, 'http://127.0.0.1:8081');
});

test('starting a discovered installed model starts the shared local runtime', async () => {
  const installedModel = {
    id: 'local-file:folder%2Fdiscovered.gguf',
    name: 'discovered.gguf',
    provider: 'Local',
    series: '',
    fileName: 'discovered.gguf',
    sizeBytes: 1024,
    downloadedAt: 1,
    filePath: '/models/discovered.gguf'
  };
  let startedModel = null;
  let chatRuntimeState = { status: 'unavailable', model: null, contextWindowTokens: null, error: null };
  let runtimePhase = IDLE_RUNTIME_PHASE;
  const manager = new LocalModelManager({
    downloader: {
      listInstalled: async () => [installedModel],
      markDeploymentStopping: () => {},
      markDeploymentStopped: () => {},
      markDeploymentReady: () => {},
      markDeploymentFailed: () => {}
    },
    localRuntime: {
      subscribe: () => () => {},
      getState: async () => runtimePhase,
      getLocalChatRuntimeState: () => chatRuntimeState,
      startModel: async (model) => {
        startedModel = model;
        chatRuntimeState = {
          status: 'ready',
          model: { id: model.id, label: model.label },
          contextWindowTokens: 49_152,
          error: null
        };
        runtimePhase = runningPhase(model.id);
        return runtimePhase;
      },
      stopModel: async () => {
        runtimePhase = IDLE_RUNTIME_PHASE;
        return runtimePhase;
      },
      chatCompletionsUrl: () => 'http://127.0.0.1:8081/v1/chat/completions',
      chatRequestHeaders: () => ({ Authorization: 'Bearer hub-key' })
    }
  });

  const state = await manager.startInstalledModel(installedModel.id);

  assert.deepEqual(startedModel, {
    id: installedModel.id,
    label: installedModel.name,
    fileName: installedModel.fileName,
    filePath: installedModel.filePath
  });
  assert.equal(state.status, 'ready');
  await assert.rejects(() => manager.startInstalledModel('local-file:missing.gguf'), /not found/i);
});

test('switching installed models stops the active Hub runtime before starting the next model', async () => {
  const installedModels = [
    { id: 'first', name: 'First', fileName: 'first.gguf', filePath: '/models/first.gguf' },
    { id: 'second', name: 'Second', fileName: 'second.gguf', filePath: '/models/second.gguf' }
  ];
  const calls = [];
  let runtimeState = {
    status: 'ready',
    model: { id: 'first', label: 'First' },
    contextWindowTokens: 49_152,
    error: null
  };
  let runtimePhase = runningPhase('first');
  let publish = () => {};
  const manager = new LocalModelManager({
    downloader: {
      listInstalled: async () => installedModels,
      markDeploymentStopping: (modelId) => calls.push(`stopping:${modelId}`),
      markDeploymentStopped: (modelId) => calls.push(`stopped:${modelId}`),
      markDeploymentReady: () => {},
      markDeploymentFailed: () => {}
    },
    localRuntime: {
      subscribe: (listener) => {
        publish = listener;
        return () => {};
      },
      getState: async () => runtimePhase,
      getLocalChatRuntimeState: () => runtimeState,
      // Publishes the same two phases the real runtime does on the way down,
      // which is how the outgoing model's row learns it has been stopped.
      stopModel: async () => {
        calls.push('stop');
        runtimePhase = { ...runtimePhase, phase: 'stopping', endpoint: null };
        publish(runtimePhase);
        runtimeState = { status: 'unavailable', model: null, contextWindowTokens: null, error: null };
        runtimePhase = IDLE_RUNTIME_PHASE;
        publish(runtimePhase);
        return runtimePhase;
      },
      startModel: async (model) => {
        calls.push(`start:${model.id}`);
        runtimeState = {
          status: 'ready',
          model: { id: model.id, label: model.label },
          contextWindowTokens: 49_152,
          error: null
        };
        runtimePhase = runningPhase(model.id);
        publish(runtimePhase);
        return runtimePhase;
      },
      chatCompletionsUrl: () => 'http://127.0.0.1:8081/v1/chat/completions',
      chatRequestHeaders: () => ({ Authorization: 'Bearer hub-key' })
    }
  });

  const state = await manager.startInstalledModel('second');

  assert.deepEqual(calls, ['stop', 'stopping:first', 'stopped:first', 'start:second']);
  assert.equal(state.model?.id, 'second');
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
    markDeploymentStopping: () => {},
    markDeploymentStopped: () => {},
    markDeploymentReady: () => {},
    markDeploymentFailed: () => {},
    deployModel: async (descriptor, startRuntime) => startRuntime({
      id: descriptor.id,
      label: descriptor.name,
      filePath: `/models/${descriptor.fileName}`
    })
  };
  let runtimePhase = IDLE_RUNTIME_PHASE;
  const localRuntime = {
    subscribe: (listener) => {
      runtimeStateListener = listener;
      return () => {};
    },
    getState: async () => runtimePhase,
    getLocalChatRuntimeState: () => runtimeState,
    startModel: async (model) => {
      startedModelIds.push(model.id);
      if (model.id === 'first-model') {
        await new Promise((resolve) => {
          releaseFirstStart = resolve;
        });
      }
      runtimeState = {
        status: 'ready',
        model: { id: model.id, label: model.label },
        contextWindowTokens: 65535,
        error: null
      };
      runtimePhase = runningPhase(model.id);
      runtimeStateListener(runtimePhase);
    },
    stopModel: async () => {
      runtimePhase = IDLE_RUNTIME_PHASE;
    },
    chatCompletionsUrl: () => 'http://127.0.0.1:8081/v1/chat/completions',
    chatRequestHeaders: () => ({ Authorization: 'Bearer hub-key' })
  };
  const manager = new LocalModelManager({
    catalog: { load: async () => ({ models: descriptors, providers: ['Local'], fromCache: true }) },
    downloader,
    localRuntime
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

  assert.deepEqual(parser.push('data: {"choices":[{"delta":{"reasoning_content":"Thinking"}}]}\n\n'), [
    { type: 'reasoning', text: 'Thinking' }
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
    runtime: chatRuntime('http://127.0.0.1:47000/v1/chat/completions'),
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
  assert.equal(requests[0].init.headers.Authorization, 'Bearer hub-test-key');
  assert.deepEqual(events, [
    { type: 'textDelta', ...CHAT_EVENT_IDENTITY, text: 'Hi' },
    { type: 'usage', ...CHAT_EVENT_IDENTITY, inputTokens: 3, outputTokens: 1 },
    { type: 'completed', ...CHAT_EVENT_IDENTITY }
  ]);
});

test('reasoning deltas stream separately from the visible local Chat reply', async () => {
  const events = [];
  const executor = new LocalChatTurnExecutor({
    runtime: chatRuntime('http://127.0.0.1:47000/v1/chat/completions'),
    idleTimeoutMs: 20,
    fetcher: async () => new Response(delayedResponseStream([
      'data: {"choices":[{"delta":{"reasoning_content":"Thinking"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Visible answer"}}]}\n\n',
      'data: [DONE]\n\n'
    ], 8))
  });

  executor.startTurn(CHAT_REQUEST, (event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === 'completed'));

  assert.deepEqual(events, [
    { type: 'reasoningDelta', ...CHAT_EVENT_IDENTITY, text: 'Thinking' },
    { type: 'textDelta', ...CHAT_EVENT_IDENTITY, text: 'Visible answer' },
    { type: 'completed', ...CHAT_EVENT_IDENTITY }
  ]);
});

test('local turn cancellation is idempotent and remote endpoints are rejected', async () => {
  let requestSignal;
  const cancellationEvents = [];
  const cancellable = new LocalChatTurnExecutor({
    runtime: chatRuntime('http://127.0.0.1:47000/v1/chat/completions'),
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
    runtime: chatRuntime('https://example.com/v1/chat/completions')
  });
  assert.throws(
    () => remote.startTurn(CHAT_REQUEST, () => {}),
    /loopback inference runtime/i
  );

  const localhost = new LocalChatTurnExecutor({
    runtime: chatRuntime('http://localhost:47000/v1/chat/completions')
  });
  assert.throws(
    () => localhost.startTurn(CHAT_REQUEST, () => {}),
    /loopback inference runtime/i
  );
});

test('local turn watchdog cancels a stalled stream and emits one terminal event', async () => {
  let requestSignal;
  const events = [];
  const executor = new LocalChatTurnExecutor({
    runtime: chatRuntime('http://127.0.0.1:47000/v1/chat/completions'),
    idleTimeoutMs: 10,
    fetcher: async (_input, init) => new Promise((_resolve, reject) => {
      requestSignal = init.signal;
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    })
  });

  executor.startTurn(CHAT_REQUEST, (event) => events.push(event));
  await waitFor(() => events.length === 1);

  assert.equal(requestSignal.aborted, true);
  assert.deepEqual(events, [{ type: 'watchdogTerminated', ...CHAT_EVENT_IDENTITY }]);
});

test('Chat session store restores durable history, tabs, and interrupted turns', { skip: skipWithoutSqlite }, async () => {
  const { ChatSessionStore } = await import('../dist/main/chat/ChatSessionStore.js');
  const directory = mkdtempSync(path.join(tmpdir(), 'tokkey-chat-sessions-'));
  const databasePath = path.join(directory, 'amis_wifi.db');
  let currentTime = 1_788_000_000_000;
  let nextId = 0;
  const store = new ChatSessionStore({
    databasePath,
    now: () => currentTime,
    createId: () => `session-${++nextId}`
  });
  let reopened = null;

  try {
    const initialWorkspace = store.loadWorkspace();
    const sessionId = initialWorkspace.activeSessionId;
    assert.deepEqual(initialWorkspace.openSessionIds, [sessionId]);
    assert.equal(initialWorkspace.sessions[0].title, 'New Private Chat');

    const completedRequest = {
      ...CHAT_REQUEST,
      sessionId,
      turnId: 'turn-completed',
      userMessageId: 'user-completed',
      assistantMessageId: 'assistant-completed',
      createdAt: currentTime
    };
    store.beginTurn({ request: completedRequest, modelLabel: LOCAL_MODEL.label, contextWindowTokens: 4096 });
    store.handleStreamEvent({ type: 'reasoningDelta', ...completedRequest, text: 'First thought. ' });
    store.handleStreamEvent({ type: 'textDelta', ...completedRequest, text: 'Hello from ' });
    const streamingSession = store.loadWorkspace().sessions.find((session) => session.id === sessionId);
    assert.equal(streamingSession.messages[1].content, 'Hello from ');
    assert.equal(streamingSession.messages[1].reasoningContent, 'First thought. ');
    assert.equal(streamingSession.messages[1].status, 'streaming');
    store.handleStreamEvent({ type: 'reasoningDelta', ...completedRequest, text: 'Second thought.' });
    store.handleStreamEvent({ type: 'textDelta', ...completedRequest, text: 'local Chat.' });
    store.handleStreamEvent({
      type: 'usage',
      ...completedRequest,
      inputTokens: 4,
      outputTokens: 3
    });
    currentTime += 2_500;
    store.handleStreamEvent({ type: 'completed', ...completedRequest });

    const completedSession = store.loadWorkspace().sessions.find((session) => session.id === sessionId);
    assert.equal(completedSession.title, 'Hello');
    assert.deepEqual(completedSession.messages, [
      {
        id: 'user-completed',
        role: 'user',
        content: 'Hello',
        reasoningContent: '',
        createdAt: completedRequest.createdAt,
        durationMs: null,
        status: 'complete',
        tokenUsage: null
      },
      {
        id: 'assistant-completed',
        role: 'assistant',
        content: 'Hello from local Chat.',
        reasoningContent: 'First thought. Second thought.',
        createdAt: completedRequest.createdAt,
        durationMs: 2_500,
        status: 'complete',
        tokenUsage: { inputTokens: 4, outputTokens: 3, contextWindowTokens: 4096 }
      }
    ]);

    const closedWorkspace = store.closeSession(sessionId);
    assert.equal(closedWorkspace.openSessionIds.includes(sessionId), false);
    assert.equal(closedWorkspace.sessions.find((session) => session.id === sessionId).closed, true);

    const reopenedWorkspace = store.openSession(sessionId);
    assert.equal(reopenedWorkspace.activeSessionId, sessionId);
    assert.equal(reopenedWorkspace.openSessionIds.includes(sessionId), true);

    const interruptedSessionId = store.createSession().activeSessionId;
    currentTime += 1_000;
    const interruptedRequest = {
      ...CHAT_REQUEST,
      sessionId: interruptedSessionId,
      turnId: 'turn-interrupted',
      userMessageId: 'user-interrupted',
      assistantMessageId: 'assistant-interrupted',
      createdAt: currentTime
    };
    store.beginTurn({ request: interruptedRequest, modelLabel: LOCAL_MODEL.label, contextWindowTokens: 4096 });
    store.close();

    currentTime += 1_000;
    reopened = new ChatSessionStore({ databasePath, now: () => currentTime });
    const restoredWorkspace = reopened.loadWorkspace();
    const interruptedSession = restoredWorkspace.sessions.find((session) => session.id === interruptedSessionId);
    assert.deepEqual(interruptedSession.messages[1], {
      id: 'assistant-interrupted',
      role: 'assistant',
      content: 'This response was interrupted before completion.',
      reasoningContent: '',
      createdAt: interruptedRequest.createdAt,
      durationMs: null,
      status: 'incomplete',
      tokenUsage: null
    });
  } finally {
    store.close();
    reopened?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Chat session store migrates token usage from assistant messages onto Chat turns', { skip: skipWithoutSqlite }, async () => {
  const [{ ChatSessionStore }, { DatabaseSync }, { localTimestampForEpochMilliseconds }] = await Promise.all([
    import('../dist/main/chat/ChatSessionStore.js'),
    import('node:sqlite'),
    import('../dist/main/storage/LocalTimestamp.js')
  ]);
  const directory = mkdtempSync(path.join(tmpdir(), 'tokkey-chat-token-usage-'));
  const databasePath = path.join(directory, 'tokkey.db');
  const createdAt = 1_788_000_000_000;
  const timestamp = localTimestampForEpochMilliseconds(createdAt);
  const initialStore = new ChatSessionStore({
    databasePath,
    now: () => createdAt,
    createId: () => 'token-usage-session'
  });
  let migratedStore = null;

  try {
    const sessionId = initialStore.loadWorkspace().activeSessionId;
    initialStore.close();

    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        ALTER TABLE chat_messages ADD COLUMN input_tokens INTEGER;
        ALTER TABLE chat_messages ADD COLUMN output_tokens INTEGER;
        ALTER TABLE chat_messages ADD COLUMN context_window_tokens INTEGER;`);
      const insertMessage = database.prepare(`
        INSERT INTO chat_messages
          (id, session_id, turn_id, role, content, reasoning_content,
           created_at, created_at_epoch_ms, created_at_time_zone,
           status, duration_ms, input_tokens, output_tokens, context_window_tokens)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      insertMessage.run(
        'legacy-token-user', sessionId, 'legacy-token-turn', 'user', 'Hello', '',
        timestamp.localDateTime, createdAt, timestamp.timeZone, 'complete', null, null, null, null
      );
      insertMessage.run(
        'legacy-token-assistant', sessionId, 'legacy-token-turn', 'assistant', 'Hi', '',
        timestamp.localDateTime, createdAt, timestamp.timeZone, 'complete', 1_500, 7, 4, 4_096
      );
      database.prepare(`
        INSERT INTO chat_turns
          (id, session_id, user_message_id, assistant_message_id, model_id, model_label,
           started_at, started_at_epoch_ms, started_at_time_zone,
           ended_at, ended_at_epoch_ms, ended_at_time_zone,
           status, input_tokens, output_tokens, context_window_tokens)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`)
        .run(
          'legacy-token-turn', sessionId, 'legacy-token-user', 'legacy-token-assistant',
          LOCAL_MODEL.id, LOCAL_MODEL.label,
          timestamp.localDateTime, createdAt, timestamp.timeZone,
          timestamp.localDateTime, createdAt, timestamp.timeZone,
          'completed'
        );
    } finally {
      database.close();
    }

    migratedStore = new ChatSessionStore({ databasePath, now: () => createdAt });
    const migratedSession = migratedStore.loadWorkspace().sessions.find((session) => session.id === sessionId);
    const migratedAssistant = migratedSession.messages.find((message) => message.id === 'legacy-token-assistant');
    assert.deepEqual(migratedAssistant.tokenUsage, {
      inputTokens: 7,
      outputTokens: 4,
      contextWindowTokens: 4_096
    });
    migratedStore.close();
    migratedStore = null;

    const migratedDatabase = new DatabaseSync(databasePath);
    try {
      const messageColumns = migratedDatabase.prepare('PRAGMA table_info(chat_messages)').all();
      const turn = migratedDatabase.prepare(`
        SELECT input_tokens, output_tokens, context_window_tokens
          FROM chat_turns WHERE id = 'legacy-token-turn'`).get();

      assert.equal(
        messageColumns.some((column) => ['input_tokens', 'output_tokens', 'context_window_tokens'].includes(column.name)),
        false
      );
      assert.deepEqual({ ...turn }, {
        input_tokens: 7,
        output_tokens: 4,
        context_window_tokens: 4_096
      });
    } finally {
      migratedDatabase.close();
    }
  } finally {
    initialStore.close();
    migratedStore?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Chat session store persists user-local timestamps and preserves sortable instants', { skip: skipWithoutSqlite }, async () => {
  const { ChatSessionStore } = await import('../dist/main/chat/ChatSessionStore.js');
  const { localTimestampForEpochMilliseconds } = await import('../dist/main/storage/LocalTimestamp.js');
  const { DatabaseSync } = await import('node:sqlite');
  const directory = mkdtempSync(path.join(tmpdir(), 'tokkey-local-chat-time-'));
  const databasePath = path.join(directory, 'tokkey.db');
  const startedAt = 1_788_000_000_123;
  const assistantStartedAt = startedAt + 200;
  const endedAt = startedAt + 500;
  let currentTime = startedAt;
  const store = new ChatSessionStore({
    databasePath,
    now: () => currentTime,
    createId: () => 'session-local-time'
  });

  try {
    const sessionId = store.loadWorkspace().activeSessionId;
    const request = {
      ...CHAT_REQUEST,
      sessionId,
      turnId: 'turn-local-time',
      userMessageId: 'user-local-time',
      assistantMessageId: 'assistant-local-time',
      createdAt: startedAt
    };
    store.beginTurn({ request, modelLabel: LOCAL_MODEL.label, contextWindowTokens: 4096 });
    currentTime = assistantStartedAt;
    store.handleStreamEvent({ type: 'reasoningDelta', ...request, text: 'Working it out.' });
    currentTime = endedAt;
    store.handleStreamEvent({
      type: 'completed',
      turnId: request.turnId,
      sessionId,
      assistantMessageId: request.assistantMessageId
    });
    store.close();

    const expectedStartedAt = localTimestampForEpochMilliseconds(startedAt);
    const expectedAssistantStartedAt = localTimestampForEpochMilliseconds(assistantStartedAt);
    const expectedEndedAt = localTimestampForEpochMilliseconds(endedAt);
    const database = new DatabaseSync(databasePath);
    try {
      const session = database.prepare(`
        SELECT created_at, created_at_epoch_ms, created_at_time_zone, typeof(created_at) AS created_at_type,
               updated_at, updated_at_epoch_ms, updated_at_time_zone
          FROM chat_sessions WHERE id = ?`).get(sessionId);
      const turn = database.prepare(`
        SELECT started_at, started_at_epoch_ms, started_at_time_zone,
               ended_at, ended_at_epoch_ms, ended_at_time_zone
          FROM chat_turns WHERE id = ?`).get(request.turnId);
      const assistantMessage = database.prepare(`
        SELECT created_at, created_at_epoch_ms, created_at_time_zone, typeof(created_at) AS created_at_type,
               duration_ms
          FROM chat_messages WHERE id = ?`).get(request.assistantMessageId);

      assert.deepEqual({ ...session }, {
        created_at: expectedStartedAt.localDateTime,
        created_at_epoch_ms: startedAt,
        created_at_time_zone: expectedStartedAt.timeZone,
        created_at_type: 'text',
        updated_at: expectedEndedAt.localDateTime,
        updated_at_epoch_ms: endedAt,
        updated_at_time_zone: expectedEndedAt.timeZone
      });
      assert.deepEqual({ ...turn }, {
        started_at: expectedStartedAt.localDateTime,
        started_at_epoch_ms: startedAt,
        started_at_time_zone: expectedStartedAt.timeZone,
        ended_at: expectedEndedAt.localDateTime,
        ended_at_epoch_ms: endedAt,
        ended_at_time_zone: expectedEndedAt.timeZone
      });
      assert.deepEqual({ ...assistantMessage }, {
        created_at: expectedAssistantStartedAt.localDateTime,
        created_at_epoch_ms: assistantStartedAt,
        created_at_time_zone: expectedAssistantStartedAt.timeZone,
        created_at_type: 'text',
        duration_ms: endedAt - startedAt
      });
    } finally {
      database.close();
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Chat session store upgrades legacy integer timestamps without losing history', { skip: skipWithoutSqlite }, async () => {
  const { ChatSessionStore } = await import('../dist/main/chat/ChatSessionStore.js');
  const { localTimestampForEpochMilliseconds } = await import('../dist/main/storage/LocalTimestamp.js');
  const { DatabaseSync } = await import('node:sqlite');
  const directory = mkdtempSync(path.join(tmpdir(), 'tokkey-chat-time-migration-'));
  const databasePath = path.join(directory, 'tokkey.db');
  const createdAt = 1_788_000_000_123;
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      model_id TEXT,
      model_label TEXT,
      closed INTEGER NOT NULL DEFAULT 0
    )`);
  database.prepare(`
    INSERT INTO chat_sessions (id, title, created_at, updated_at, model_id, model_label, closed)
    VALUES (?, ?, ?, ?, NULL, NULL, 1)`).run('legacy-session', 'Legacy Chat', createdAt, createdAt);
  database.close();

  const store = new ChatSessionStore({
    databasePath,
    now: () => createdAt,
    createId: () => 'replacement-session'
  });
  try {
    const workspace = store.loadWorkspace();
    const legacySession = workspace.sessions.find((session) => session.id === 'legacy-session');
    assert.equal(legacySession.createdAt, createdAt);
    store.close();

    const expected = localTimestampForEpochMilliseconds(createdAt);
    const migratedDatabase = new DatabaseSync(databasePath);
    try {
      const row = migratedDatabase.prepare(`
        SELECT created_at, created_at_epoch_ms, created_at_time_zone, typeof(created_at) AS created_at_type
          FROM chat_sessions WHERE id = 'legacy-session'`).get();
      const column = migratedDatabase.prepare(`
        SELECT type FROM pragma_table_info('chat_sessions') WHERE name = 'created_at'`).get();
      assert.deepEqual({ ...row }, {
        created_at: expected.localDateTime,
        created_at_epoch_ms: createdAt,
        created_at_time_zone: expected.timeZone,
        created_at_type: 'text'
      });
      assert.deepEqual({ ...column }, { type: 'TEXT' });
    } finally {
      migratedDatabase.close();
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Chat session store leaves Amis-Wifi history isolated from Tokkey storage', { skip: skipWithoutSqlite }, async () => {
  const { ChatSessionStore } = await import('../dist/main/chat/ChatSessionStore.js');
  const homeDirectory = mkdtempSync(path.join(tmpdir(), 'tokkey-chat-isolation-'));
  const legacyDatabasePath = path.join(homeDirectory, '.amiswifi', 'dbs', 'amis_wifi.db');
  const legacyStore = new ChatSessionStore({
    databasePath: legacyDatabasePath,
    createId: () => 'legacy-session'
  });
  let tokkeyStore = null;
  let legacyVerificationStore = null;

  try {
    const sessionId = legacyStore.createSession().activeSessionId;
    const request = {
      ...CHAT_REQUEST,
      sessionId,
      turnId: 'legacy-turn',
      userMessageId: 'legacy-user',
      assistantMessageId: 'legacy-assistant'
    };
    legacyStore.beginTurn({ request, modelLabel: LOCAL_MODEL.label, contextWindowTokens: 4096 });
    legacyStore.handleStreamEvent({ type: 'textDelta', ...request, text: 'Migrated reply.' });
    legacyStore.handleStreamEvent({ type: 'completed', ...request });
    legacyStore.close();

    tokkeyStore = new ChatSessionStore({ homeDirectory });
    const tokkeyWorkspace = tokkeyStore.loadWorkspace();
    assert.equal(tokkeyWorkspace.sessions.some((session) => session.id === sessionId), false);

    legacyVerificationStore = new ChatSessionStore({ databasePath: legacyDatabasePath });
    const legacySession = legacyVerificationStore.loadWorkspace().sessions.find((session) => session.id === sessionId);

    assert.equal(legacySession.title, 'Hello');
    assert.equal(legacySession.messages[0].content, 'Hello');
    assert.equal(legacySession.messages[1].content, 'Migrated reply.');
  } finally {
    legacyStore.close();
    tokkeyStore?.close();
    legacyVerificationStore?.close();
    rmSync(homeDirectory, { recursive: true, force: true });
  }
});

test('IPC controller keeps persisted turns, SSE events, and runtime selection in lockstep', () => {
  const calls = [];
  const petSignals = [];
  const workspace = { sessions: [], openSessionIds: [], activeSessionId: 'session-1' };
  const chatSessionStore = {
    loadWorkspace: () => workspace,
    createSession: () => ({ ...workspace, activeSessionId: 'created-session' }),
    openSession: (sessionId) => ({ ...workspace, activeSessionId: sessionId }),
    closeSession: (sessionId) => ({ ...workspace, openSessionIds: [sessionId] }),
    beginTurn: (start) => calls.push({ type: 'begin', start }),
    handleStreamEvent: (streamEvent) => calls.push({ type: 'persist-event', streamEvent }),
    failTurnStart: (turnId, message) => calls.push({ type: 'start-failed', turnId, message })
  };
  const runtime = {
    getLocalChatRuntimeState: () => ({
      status: 'ready',
      model: { id: LOCAL_MODEL.id, label: LOCAL_MODEL.label },
      contextWindowTokens: 49_152,
      error: null
    }),
    subscribe: () => () => {}
  };
  let startShouldFail = false;
  let emitChatEvent = null;
  const executor = {
    startTurn: (request, onEvent) => {
      if (startShouldFail) throw new Error('stream startup failed');
      emitChatEvent = onEvent;
      const streamEvent = { type: 'textDelta', ...CHAT_EVENT_IDENTITY, text: 'Persist me first' };
      onEvent(streamEvent);
      return { turnId: request.turnId };
    },
    cancelTurn: (turnId) => calls.push({ type: 'cancel', turnId })
  };
  const controller = new IpcController({
    chatSessionStore,
    localChatTurnExecutor: executor,
    tokenHubRuntime: runtime,
    localModelManager: {},
    petRuntimeCoordinator: {
      subscribe: () => () => {},
      signalCompanion: (signal) => petSignals.push(signal)
    }
  });
  const sentEvents = [];
  const sender = {
    isDestroyed: () => false,
    send: (channel, streamEvent) => sentEvents.push({ channel, streamEvent })
  };

  assert.deepEqual(controller.startLocalChatTurn({ sender }, CHAT_REQUEST), { turnId: CHAT_REQUEST.turnId });
  assert.deepEqual(calls.slice(0, 2), [
    {
      type: 'begin',
      start: {
        request: CHAT_REQUEST,
        modelLabel: LOCAL_MODEL.label,
        contextWindowTokens: 49_152
      }
    },
    {
      type: 'persist-event',
      streamEvent: { type: 'textDelta', ...CHAT_EVENT_IDENTITY, text: 'Persist me first' }
    }
  ]);
  assert.deepEqual(sentEvents, [
    {
      channel: 'chat:event',
      streamEvent: { type: 'textDelta', ...CHAT_EVENT_IDENTITY, text: 'Persist me first' }
    }
  ]);
  assert.deepEqual(petSignals, [{
    source: 'chat',
    phase: 'sending',
    turnId: CHAT_REQUEST.turnId
  }]);
  emitChatEvent({ type: 'completed', ...CHAT_EVENT_IDENTITY });
  assert.deepEqual(petSignals.at(-1), {
    source: 'chat',
    phase: 'completed',
    turnId: CHAT_REQUEST.turnId
  });
  assert.equal(controller.loadLocalChatWorkspace(), workspace);
  assert.equal(controller.createLocalChatSession().activeSessionId, 'created-session');
  assert.equal(controller.openLocalChatSession('history-session').activeSessionId, 'history-session');
  assert.deepEqual(controller.closeLocalChatSession('remaining-session').openSessionIds, ['remaining-session']);

  startShouldFail = true;
  assert.throws(
    () => controller.startLocalChatTurn({ sender }, { ...CHAT_REQUEST, turnId: 'turn-start-failure' }),
    /stream startup failed/
  );
  assert.deepEqual(calls.at(-1), {
    type: 'start-failed',
    turnId: 'turn-start-failure',
    message: 'stream startup failed'
  });
  assert.deepEqual(petSignals.at(-1), {
    source: 'chat',
    phase: 'error',
    turnId: 'turn-start-failure'
  });

  const unavailableController = new IpcController({
    chatSessionStore,
    localChatTurnExecutor: executor,
    tokenHubRuntime: {
      getLocalChatRuntimeState: () => ({ status: 'unavailable', model: null, contextWindowTokens: null, error: null }),
      subscribe: () => () => {}
    },
    localModelManager: {}
  });
  const beginCallCount = calls.filter((call) => call.type === 'begin').length;
  assert.throws(
    () => unavailableController.startLocalChatTurn({ sender }, CHAT_REQUEST),
    /selected local model is not running/i
  );
  assert.equal(calls.filter((call) => call.type === 'begin').length, beginCallCount);

  controller.cancelLocalChatTurn(CHAT_REQUEST.turnId);
  assert.deepEqual(calls.at(-1), { type: 'cancel', turnId: CHAT_REQUEST.turnId });
});

test('runtime failure broadcasts the Chat availability projection without its endpoint', () => {
  let publishRuntimeState;
  let chatState = { status: 'ready', model: { id: LOCAL_MODEL.id, label: LOCAL_MODEL.label }, contextWindowTokens: 49_152, error: null };
  const controller = new IpcController({
    accountService: {}, chatSessionStore: {}, localChatTurnExecutor: {}, localModelManager: {},
    tokenHubRuntime: {
      getLocalChatRuntimeState: () => chatState,
      subscribe: (listener) => { publishRuntimeState = listener; return () => {}; }
    }
  });
  const events = [];
  controller.broadcast = (channel, payload) => events.push({ channel, payload });
  chatState = { ...chatState, status: 'error', error: 'Process exited with SIGKILL' };
  publishRuntimeState({ phase: 'failed', modelId: LOCAL_MODEL.id, endpoint: null, error: chatState.error, device: null });
  assert.deepEqual(events.map(e => e.channel), ['models:runtime-state-changed', 'chat:runtime-state-changed']);
  assert.deepEqual(events[1].payload, chatState);
  assert.equal(Object.hasOwn(events[1].payload, 'endpoint'), false);
});

test('a failed Pet observer cannot interrupt an accepted Chat turn', () => {
  let turnStarted = false;
  const controller = new IpcController({
    accountService: {},
    chatSessionStore: {
      beginTurn: () => {},
      failTurnStart: () => {},
      handleStreamEvent: () => {}
    },
    localChatTurnExecutor: {
      startTurn: (request) => {
        turnStarted = true;
        return { turnId: request.turnId };
      }
    },
    tokenHubRuntime: {
      getLocalChatRuntimeState: () => ({
        status: 'ready',
        model: { id: LOCAL_MODEL.id, label: LOCAL_MODEL.label },
        contextWindowTokens: 49_152,
        error: null
      }),
      subscribe: () => () => {}
    },
    localModelManager: {},
    petRuntimeCoordinator: {
      subscribe: () => () => {},
      signalCompanion: () => {
        throw new Error('Pet observer failed');
      }
    }
  });
  const sender = { isDestroyed: () => false, send: () => {} };

  assert.deepEqual(
    controller.startLocalChatTurn({ sender }, CHAT_REQUEST),
    { turnId: CHAT_REQUEST.turnId }
  );
  assert.equal(turnStarted, true);
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
  assert.throws(
    () => validateLocalChatTurnRequest({ ...CHAT_REQUEST, createdAt: 0 }),
    /positive millisecond timestamp/i
  );
  assert.throws(
    () => validateLocalChatTurnRequest({ ...CHAT_REQUEST, messages: [{ role: 'assistant', content: 'No user prompt' }] }),
    /final Local Chat message must be from the user/i
  );
  assert.throws(() => validateLocalChatTurnId(''), /non-empty string/i);
});
