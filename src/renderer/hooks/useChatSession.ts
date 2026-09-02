import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  LocalChatEvent,
  LocalChatRuntimeState,
  LocalChatStoredSession,
  LocalChatWorkspace,
  LocalChatTurnRequest
} from '../../shared/types';
import { createLocalChatSessionTitle } from '../../shared/LocalChatSessionTitle';
import {
  groupHistory,
  summarizeSession,
  type ChatHistoryGroup,
  type ChatMessage,
  type ChatModelOption,
  type ChatModelState,
  type ChatRequestState,
  type ChatSession,
  type ChatTokenUsage
} from '../pages/chatContent';

const LOCAL_CONTEXT_WINDOW_TOKENS = 4_096;
const FALLBACK_SESSION: ChatSession = {
  id: 'loading-local-chat',
  title: 'New Private Chat',
  createdAt: 0,
  updatedAt: 0,
  messages: []
};

type HistoryMode = 'closed' | 'browsing';
type CopyState = 'idle' | 'copied' | 'error';

interface ActiveChatTurn {
  sessionId: string;
  assistantMessageId: string;
  startedAt: number;
}

interface PendingMessageDeltas {
  text: string;
  reasoningContent: string;
}

const INITIAL_RUNTIME_STATE: LocalChatRuntimeState = {
  status: 'unavailable',
  model: null,
  contextWindowTokens: null,
  error: null
};

export interface ChatSessionController {
  sessions: ChatSession[];
  openSessions: ChatSession[];
  activeSession: ChatSession;
  activeSessionId: string;
  requestState: ChatRequestState;
  historyMode: HistoryMode;
  historyGroups: ChatHistoryGroup[];
  modelState: ChatModelState;
  selectedModel: ChatModelOption | null;
  copyStateByMessageId: Readonly<Record<string, CopyState>>;
  openHistory: () => void;
  closeHistory: () => void;
  selectSession: (sessionId: string) => void;
  createNewChat: () => void;
  closeSession: (sessionId: string) => void;
  sendMessage: (content: string) => void;
  stopStreaming: () => void;
  copyMessage: (message: ChatMessage) => Promise<void>;
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function modelStateForRuntime(runtimeState: LocalChatRuntimeState): ChatModelState {
  switch (runtimeState.status) {
    case 'ready':
      return 'available';
    case 'starting':
      return 'loading';
    case 'error':
      return 'error';
    default:
      return 'unavailable';
  }
}

function formatResponseDuration(startedAt: number): string {
  return formatResponseDurationMilliseconds(Date.now() - startedAt);
}

function formatResponseDurationMilliseconds(durationMilliseconds: number): string {
  const durationSeconds = Math.max(1, Math.round(durationMilliseconds / 1_000));
  const minutes = Math.floor(durationSeconds / 60);
  const seconds = durationSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'The local model request failed.';
}

function updateAssistantMessage(
  sessions: ChatSession[],
  sessionId: string,
  assistantMessageId: string,
  update: (message: ChatMessage) => ChatMessage
): ChatSession[] {
  return sessions.map((session) => {
    if (session.id !== sessionId) return session;
    let changed = false;
    const messages = session.messages.map((message) => {
      if (message.id !== assistantMessageId) return message;
      changed = true;
      return update(message);
    });
    return changed ? { ...session, updatedAt: Date.now(), messages } : session;
  });
}

function chatMessageStatusForStoredMessage(status: LocalChatStoredSession['messages'][number]['status']): ChatMessage['status'] {
  return status === 'incomplete' ? 'error' : status;
}

function chatTokenUsageForStoredMessage(
  tokenUsage: LocalChatStoredSession['messages'][number]['tokenUsage']
): ChatTokenUsage | null {
  if (!tokenUsage) return null;
  const inputTokens = tokenUsage.inputTokens ?? 0;
  const outputTokens = tokenUsage.outputTokens ?? 0;
  const contextWindowTokens = tokenUsage.contextWindowTokens ?? LOCAL_CONTEXT_WINDOW_TOKENS;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    usedContextTokens: inputTokens + outputTokens,
    contextWindowTokens
  };
}

function chatSessionForStoredSession(session: LocalChatStoredSession): ChatSession {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: session.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      reasoningContent: message.reasoningContent,
      createdAt: message.createdAt,
      durationLabel: message.durationMs === null ? null : formatResponseDurationMilliseconds(message.durationMs),
      status: chatMessageStatusForStoredMessage(message.status),
      tokenUsage: chatTokenUsageForStoredMessage(message.tokenUsage)
    }))
  };
}

/** Owns renderer-only session layout state while main owns every model request. */
export function useChatSession(): ChatSessionController {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [openSessionIds, setOpenSessionIds] = useState<string[]>([]);
  const [activeSessionId, setActiveSessionId] = useState('');
  const [workspaceIsReady, setWorkspaceIsReady] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [requestStateBySessionId, setRequestStateBySessionId] = useState<Record<string, ChatRequestState>>({});
  const [historyMode, setHistoryMode] = useState<HistoryMode>('closed');
  const [runtimeState, setRuntimeState] = useState<LocalChatRuntimeState>(INITIAL_RUNTIME_STATE);
  const [copyStateByMessageId, setCopyStateByMessageId] = useState<Record<string, CopyState>>({});
  const mountedRef = useRef(true);
  const copyTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const activeTurnsByIdRef = useRef(new Map<string, ActiveChatTurn>());
  const turnIdBySessionIdRef = useRef(new Map<string, string>());
  const pendingMessageDeltasRef = useRef(new Map<string, PendingMessageDeltas>());
  const messageFlushFrameRef = useRef<number | null>(null);
  const runtimeStateRef = useRef(runtimeState);

  useEffect(() => {
    runtimeStateRef.current = runtimeState;
  }, [runtimeState]);

  const applyWorkspace = useCallback((workspace: LocalChatWorkspace) => {
    if (!mountedRef.current) return;
    setSessions(workspace.sessions.map(chatSessionForStoredSession));
    setOpenSessionIds(workspace.openSessionIds);
    setActiveSessionId(workspace.activeSessionId);
    setWorkspaceError(null);
    setWorkspaceIsReady(true);
  }, []);

  const handleWorkspaceError = useCallback((error: unknown) => {
    if (!mountedRef.current) return;
    setWorkspaceError(describeError(error));
    setWorkspaceIsReady(false);
  }, []);

  const loadWorkspace = useCallback(async () => {
    try {
      applyWorkspace(await window.tokiie.loadLocalChatWorkspace());
    } catch (error) {
      handleWorkspaceError(error);
    }
  }, [applyWorkspace, handleWorkspaceError]);

  const refreshRuntimeState = useCallback(async () => {
    try {
      const nextState = await window.tokiie.getLocalChatRuntimeState();
      if (mountedRef.current) {
        setRuntimeState(nextState);
      }
    } catch (error) {
      if (mountedRef.current) {
        setRuntimeState({
          status: 'error',
          model: null,
          contextWindowTokens: null,
          error: describeError(error)
        });
      }
    }
  }, []);

  const flushPendingDeltas = useCallback(() => {
    if (messageFlushFrameRef.current !== null) {
      window.cancelAnimationFrame(messageFlushFrameRef.current);
      messageFlushFrameRef.current = null;
    }
    const pendingDeltas = new Map(pendingMessageDeltasRef.current);
    pendingMessageDeltasRef.current.clear();
    if (!mountedRef.current || pendingDeltas.size === 0) return;

    setSessions((currentSessions) => currentSessions.map((session) => {
      let changed = false;
      const messages = session.messages.map((message) => {
        const delta = pendingDeltas.get(message.id);
        if (delta === undefined) return message;
        if (!delta.text && !delta.reasoningContent) return message;
        changed = true;
        return {
          ...message,
          content: `${message.content}${delta.text}`,
          reasoningContent: `${message.reasoningContent}${delta.reasoningContent}`
        };
      });
      return changed ? { ...session, updatedAt: Date.now(), messages } : session;
    }));
  }, []);

  const markTurnFailed = useCallback((turnId: string, message: string) => {
    const activeTurn = activeTurnsByIdRef.current.get(turnId);
    if (!activeTurn) return;
    flushPendingDeltas();
    activeTurnsByIdRef.current.delete(turnId);
    if (turnIdBySessionIdRef.current.get(activeTurn.sessionId) === turnId) {
      turnIdBySessionIdRef.current.delete(activeTurn.sessionId);
    }
    if (!mountedRef.current) return;

    setSessions((currentSessions) => updateAssistantMessage(
      currentSessions,
      activeTurn.sessionId,
      activeTurn.assistantMessageId,
      (assistantMessage) => ({
        ...assistantMessage,
        content: assistantMessage.content || message,
        durationLabel: formatResponseDuration(activeTurn.startedAt),
        status: 'error'
      })
    ));
    setRequestStateBySessionId((currentStates) => ({
      ...currentStates,
      [activeTurn.sessionId]: 'error'
    }));
  }, [flushPendingDeltas]);

  const handleLocalChatEvent = useCallback((event: LocalChatEvent) => {
    const activeTurn = activeTurnsByIdRef.current.get(event.turnId);
    if (!activeTurn ||
      activeTurn.sessionId !== event.sessionId ||
      activeTurn.assistantMessageId !== event.assistantMessageId) {
      return;
    }

    if (event.type === 'textDelta') {
      const currentDeltas = pendingMessageDeltasRef.current.get(event.assistantMessageId) ?? {
        text: '',
        reasoningContent: ''
      };
      pendingMessageDeltasRef.current.set(event.assistantMessageId, {
        ...currentDeltas,
        text: `${currentDeltas.text}${event.text}`
      });
      if (messageFlushFrameRef.current === null) {
        messageFlushFrameRef.current = window.requestAnimationFrame(flushPendingDeltas);
      }
      return;
    }

    if (event.type === 'reasoningDelta') {
      const currentDeltas = pendingMessageDeltasRef.current.get(event.assistantMessageId) ?? {
        text: '',
        reasoningContent: ''
      };
      pendingMessageDeltasRef.current.set(event.assistantMessageId, {
        ...currentDeltas,
        reasoningContent: `${currentDeltas.reasoningContent}${event.text}`
      });
      if (messageFlushFrameRef.current === null) {
        messageFlushFrameRef.current = window.requestAnimationFrame(flushPendingDeltas);
      }
      return;
    }

    if (event.type === 'usage') {
      const contextWindowTokens = runtimeStateRef.current.contextWindowTokens ?? LOCAL_CONTEXT_WINDOW_TOKENS;
      setSessions((currentSessions) => updateAssistantMessage(
        currentSessions,
        event.sessionId,
        event.assistantMessageId,
        (assistantMessage) => {
          const previousUsage = assistantMessage.tokenUsage;
          const inputTokens = event.inputTokens ?? previousUsage?.inputTokens ?? 0;
          const outputTokens = event.outputTokens ?? previousUsage?.outputTokens ?? 0;
          const tokenUsage: ChatTokenUsage = {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            usedContextTokens: inputTokens + outputTokens,
            contextWindowTokens
          };
          return { ...assistantMessage, tokenUsage };
        }
      ));
      return;
    }

    if (event.type === 'error') {
      markTurnFailed(event.turnId, event.message);
      void refreshRuntimeState();
      return;
    }

    if (event.type === 'watchdogTerminated') {
      markTurnFailed(event.turnId, 'The local model stopped responding before completing this reply.');
      void refreshRuntimeState();
      return;
    }

    flushPendingDeltas();
    activeTurnsByIdRef.current.delete(event.turnId);
    if (turnIdBySessionIdRef.current.get(event.sessionId) === event.turnId) {
      turnIdBySessionIdRef.current.delete(event.sessionId);
    }
    if (!mountedRef.current) return;

    setSessions((currentSessions) => updateAssistantMessage(
      currentSessions,
      event.sessionId,
      event.assistantMessageId,
      (assistantMessage) => ({
        ...assistantMessage,
        durationLabel: formatResponseDuration(activeTurn.startedAt),
        status: 'complete'
      })
    ));
    setRequestStateBySessionId((currentStates) => ({
      ...currentStates,
      [event.sessionId]: 'idle'
    }));
  }, [flushPendingDeltas, markTurnFailed, refreshRuntimeState]);

  useEffect(() => {
    mountedRef.current = true;
    const removeLocalChatEventListener = window.tokiie.onLocalChatEvent(handleLocalChatEvent);
    void Promise.all([refreshRuntimeState(), loadWorkspace()]);
    return () => {
      mountedRef.current = false;
      removeLocalChatEventListener();
      if (messageFlushFrameRef.current !== null) {
        window.cancelAnimationFrame(messageFlushFrameRef.current);
      }
      [...activeTurnsByIdRef.current.keys()].forEach((turnId) => {
        void window.tokiie.cancelLocalChatTurn(turnId).catch(() => undefined);
      });
      activeTurnsByIdRef.current.clear();
      turnIdBySessionIdRef.current.clear();
      pendingMessageDeltasRef.current.clear();
      copyTimersRef.current.forEach((timer) => clearTimeout(timer));
      copyTimersRef.current = [];
    };
  }, [handleLocalChatEvent, loadWorkspace, refreshRuntimeState]);

  const openSessions = useMemo(
    () => openSessionIds.flatMap((id) => {
      const session = sessions.find((candidate) => candidate.id === id);
      return session ? [session] : [];
    }),
    [openSessionIds, sessions]
  );
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? openSessions[0];
  const safeActiveSession = activeSession ?? FALLBACK_SESSION;
  const summaries = useMemo(
    () => sessions.filter((session) => session.messages.length > 0).map(summarizeSession),
    [sessions]
  );
  const historyGroups = useMemo(() => groupHistory(summaries, Date.now()), [summaries]);
  const modelState = workspaceError ? 'error' : modelStateForRuntime(runtimeState);
  const selectedModel = workspaceIsReady && runtimeState.status === 'ready' && runtimeState.model
    ? {
        id: runtimeState.model.id,
        label: runtimeState.model.label,
        source: 'local' as const,
        isAvailable: true
      }
    : null;

  const cancelTurnForSession = useCallback((sessionId: string) => {
    const turnId = turnIdBySessionIdRef.current.get(sessionId);
    if (!turnId) return;
    void window.tokiie.cancelLocalChatTurn(turnId).catch((error: unknown) => {
      markTurnFailed(turnId, describeError(error));
    });
  }, [markTurnFailed]);

  const openHistory = useCallback(() => {
    setHistoryMode('browsing');
  }, []);

  const closeHistory = useCallback(() => setHistoryMode('closed'), []);

  const selectSession = useCallback((sessionId: string) => {
    setHistoryMode('closed');
    void window.tokiie.openLocalChatSession(sessionId)
      .then(applyWorkspace)
      .catch(handleWorkspaceError);
  }, [applyWorkspace, handleWorkspaceError]);

  const createNewChat = useCallback(() => {
    setHistoryMode('closed');
    void window.tokiie.createLocalChatSession()
      .then(applyWorkspace)
      .catch(handleWorkspaceError);
  }, [applyWorkspace, handleWorkspaceError]);

  const closeSession = useCallback((sessionId: string) => {
    cancelTurnForSession(sessionId);
    void window.tokiie.closeLocalChatSession(sessionId)
      .then(applyWorkspace)
      .catch(handleWorkspaceError);
  }, [applyWorkspace, cancelTurnForSession, handleWorkspaceError]);

  const sendMessage = useCallback((content: string) => {
    const trimmedContent = content.trim();
    if (!trimmedContent || !selectedModel || !workspaceIsReady) return;

    const sessionId = safeActiveSession.id;
    const createdAt = Date.now();
    const turnId = makeId('turn');
    const assistantMessageId = makeId('assistant');
    const userMessage: ChatMessage = {
      id: makeId('user'),
      role: 'user',
      content: trimmedContent,
      reasoningContent: '',
      createdAt,
      durationLabel: null,
      status: 'complete',
      tokenUsage: null
    };
    const assistantMessage: ChatMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      reasoningContent: '',
      createdAt,
      durationLabel: null,
      status: 'streaming',
      tokenUsage: null
    };
    const request: LocalChatTurnRequest = {
      turnId,
      sessionId,
      userMessageId: userMessage.id,
      assistantMessageId,
      modelId: selectedModel.id,
      createdAt,
      messages: [...safeActiveSession.messages, userMessage]
        .filter((message) => message.status !== 'error' && message.content.trim().length > 0)
        .map((message) => ({ role: message.role, content: message.content }))
    };

    activeTurnsByIdRef.current.set(turnId, { sessionId, assistantMessageId, startedAt: createdAt });
    turnIdBySessionIdRef.current.set(sessionId, turnId);
    setSessions((currentSessions) => currentSessions.map((session) => session.id === sessionId
      ? {
          ...session,
          title: session.messages.length === 0 ? createLocalChatSessionTitle(trimmedContent) : session.title,
          updatedAt: createdAt,
          messages: [...session.messages, userMessage, assistantMessage]
        }
      : session));
    setRequestStateBySessionId((currentStates) => ({ ...currentStates, [sessionId]: 'sending' }));

    void window.tokiie.startLocalChatTurn(request).catch((error: unknown) => {
      markTurnFailed(turnId, describeError(error));
      void refreshRuntimeState();
    });
  }, [markTurnFailed, refreshRuntimeState, safeActiveSession, selectedModel, workspaceIsReady]);

  const stopStreaming = useCallback(() => {
    cancelTurnForSession(safeActiveSession.id);
  }, [cancelTurnForSession, safeActiveSession.id]);

  const copyMessage = useCallback(async (message: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(message.content);
      if (!mountedRef.current) return;
      setCopyStateByMessageId((currentStates) => ({ ...currentStates, [message.id]: 'copied' }));
    } catch {
      if (!mountedRef.current) return;
      setCopyStateByMessageId((currentStates) => ({ ...currentStates, [message.id]: 'error' }));
    }
    const timer = setTimeout(() => {
      if (!mountedRef.current) return;
      setCopyStateByMessageId((currentStates) => ({ ...currentStates, [message.id]: 'idle' }));
    }, 1_600);
    copyTimersRef.current = [...copyTimersRef.current, timer];
  }, []);

  return {
    sessions,
    openSessions,
    activeSession: safeActiveSession,
    activeSessionId: safeActiveSession.id,
    requestState: requestStateBySessionId[safeActiveSession.id] ?? 'idle',
    historyMode,
    historyGroups,
    modelState,
    selectedModel,
    copyStateByMessageId,
    openHistory,
    closeHistory,
    selectSession,
    createNewChat,
    closeSession,
    sendMessage,
    stopStreaming,
    copyMessage
  };
}
