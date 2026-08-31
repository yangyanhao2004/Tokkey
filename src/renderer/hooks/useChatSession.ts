import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  LocalChatEvent,
  LocalChatRuntimeState,
  LocalChatTurnRequest
} from '../../shared/types';
import {
  FIXTURE_NOW,
  createBlankSession,
  createChatFixture,
  groupHistory,
  paginateEarlier,
  searchHistory,
  summarizeSession,
  type ChatHistoryGroup,
  type ChatMessage,
  type ChatModelOption,
  type ChatModelState,
  type ChatRequestState,
  type ChatSession,
  type ChatTokenUsage
} from '../pages/chatContent';

const INITIAL_OPEN_SESSION_IDS = ['daily-brief', 'wechat-motivation', 'vendio'];
const EARLIER_PAGE_SIZE = 3;
const LOCAL_CONTEXT_WINDOW_TOKENS = 4_096;

type HistoryMode = 'closed' | 'browsing' | 'searching';
type CopyState = 'idle' | 'copied' | 'error';

interface ActiveChatTurn {
  sessionId: string;
  assistantMessageId: string;
  startedAt: number;
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
  historyQuery: string;
  historyGroups: ChatHistoryGroup[];
  historyResults: ReturnType<typeof searchHistory>;
  earlierPage: number;
  earlierPageItems: ReturnType<typeof paginateEarlier>['items'];
  hasEarlierPage: boolean;
  modelState: ChatModelState;
  selectedModel: ChatModelOption | null;
  copyStateByMessageId: Readonly<Record<string, CopyState>>;
  openHistory: () => void;
  closeHistory: () => void;
  setHistoryQuery: (query: string) => void;
  setEarlierPage: (page: number) => void;
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
  const durationSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1_000));
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

/** Owns renderer-only session layout state while main owns every model request. */
export function useChatSession(): ChatSessionController {
  const [sessions, setSessions] = useState<ChatSession[]>(() => createChatFixture());
  const [openSessionIds, setOpenSessionIds] = useState<string[]>(INITIAL_OPEN_SESSION_IDS);
  const [activeSessionId, setActiveSessionId] = useState('vendio');
  const [requestStateBySessionId, setRequestStateBySessionId] = useState<Record<string, ChatRequestState>>({});
  const [historyMode, setHistoryMode] = useState<HistoryMode>('closed');
  const [historyQuery, setHistoryQuery] = useState('');
  const [earlierPage, setEarlierPage] = useState(0);
  const [runtimeState, setRuntimeState] = useState<LocalChatRuntimeState>(INITIAL_RUNTIME_STATE);
  const [copyStateByMessageId, setCopyStateByMessageId] = useState<Record<string, CopyState>>({});
  const mountedRef = useRef(true);
  const copyTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const activeTurnsByIdRef = useRef(new Map<string, ActiveChatTurn>());
  const turnIdBySessionIdRef = useRef(new Map<string, string>());
  const pendingTextByMessageIdRef = useRef(new Map<string, string>());
  const textFlushFrameRef = useRef<number | null>(null);
  const runtimeStateRef = useRef(runtimeState);

  useEffect(() => {
    runtimeStateRef.current = runtimeState;
  }, [runtimeState]);

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

  const flushPendingText = useCallback(() => {
    if (textFlushFrameRef.current !== null) {
      window.cancelAnimationFrame(textFlushFrameRef.current);
      textFlushFrameRef.current = null;
    }
    const pendingText = new Map(pendingTextByMessageIdRef.current);
    pendingTextByMessageIdRef.current.clear();
    if (!mountedRef.current || pendingText.size === 0) return;

    setSessions((currentSessions) => currentSessions.map((session) => {
      let changed = false;
      const messages = session.messages.map((message) => {
        const delta = pendingText.get(message.id);
        if (delta === undefined) return message;
        changed = true;
        return { ...message, content: `${message.content}${delta}` };
      });
      return changed ? { ...session, updatedAt: Date.now(), messages } : session;
    }));
  }, []);

  const markTurnFailed = useCallback((turnId: string, message: string) => {
    const activeTurn = activeTurnsByIdRef.current.get(turnId);
    if (!activeTurn) return;
    flushPendingText();
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
  }, [flushPendingText]);

  const handleLocalChatEvent = useCallback((event: LocalChatEvent) => {
    const activeTurn = activeTurnsByIdRef.current.get(event.turnId);
    if (!activeTurn ||
      activeTurn.sessionId !== event.sessionId ||
      activeTurn.assistantMessageId !== event.assistantMessageId) {
      return;
    }

    if (event.type === 'textDelta') {
      const currentText = pendingTextByMessageIdRef.current.get(event.assistantMessageId) ?? '';
      pendingTextByMessageIdRef.current.set(event.assistantMessageId, `${currentText}${event.text}`);
      if (textFlushFrameRef.current === null) {
        textFlushFrameRef.current = window.requestAnimationFrame(flushPendingText);
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

    flushPendingText();
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
  }, [flushPendingText, markTurnFailed, refreshRuntimeState]);

  useEffect(() => {
    mountedRef.current = true;
    const removeLocalChatEventListener = window.tokiie.onLocalChatEvent(handleLocalChatEvent);
    void refreshRuntimeState();
    return () => {
      mountedRef.current = false;
      removeLocalChatEventListener();
      if (textFlushFrameRef.current !== null) {
        window.cancelAnimationFrame(textFlushFrameRef.current);
      }
      [...activeTurnsByIdRef.current.keys()].forEach((turnId) => {
        void window.tokiie.cancelLocalChatTurn(turnId).catch(() => undefined);
      });
      activeTurnsByIdRef.current.clear();
      turnIdBySessionIdRef.current.clear();
      pendingTextByMessageIdRef.current.clear();
      copyTimersRef.current.forEach((timer) => clearTimeout(timer));
      copyTimersRef.current = [];
    };
  }, [handleLocalChatEvent, refreshRuntimeState]);

  const openSessions = useMemo(
    () => openSessionIds.flatMap((id) => {
      const session = sessions.find((candidate) => candidate.id === id);
      return session ? [session] : [];
    }),
    [openSessionIds, sessions]
  );
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? openSessions[0];
  const safeActiveSession = activeSession ?? createBlankSession('fallback', FIXTURE_NOW);
  const summaries = useMemo(
    () => sessions.filter((session) => session.messages.length > 0).map(summarizeSession),
    [sessions]
  );
  const historyGroups = useMemo(() => groupHistory(summaries, FIXTURE_NOW), [summaries]);
  const historyResults = useMemo(() => searchHistory(summaries, historyQuery), [historyQuery, summaries]);
  const earlierPageData = useMemo(
    () => paginateEarlier(summaries, FIXTURE_NOW, earlierPage, EARLIER_PAGE_SIZE),
    [earlierPage, summaries]
  );
  const modelState = modelStateForRuntime(runtimeState);
  const selectedModel = runtimeState.status === 'ready' && runtimeState.model
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
    setHistoryQuery('');
    setEarlierPage(0);
  }, []);

  const closeHistory = useCallback(() => setHistoryMode('closed'), []);

  const updateHistoryQuery = useCallback((query: string) => {
    setHistoryQuery(query);
    setEarlierPage(0);
    setHistoryMode(query.trim() ? 'searching' : 'browsing');
  }, []);

  const selectSession = useCallback((sessionId: string) => {
    setOpenSessionIds((currentIds) => currentIds.includes(sessionId) ? currentIds : [...currentIds, sessionId]);
    setActiveSessionId(sessionId);
    setHistoryMode('closed');
  }, []);

  const createNewChat = useCallback(() => {
    const session = createBlankSession(makeId('new'), Date.now());
    setSessions((currentSessions) => [...currentSessions, session]);
    setOpenSessionIds((currentIds) => [...currentIds, session.id]);
    setActiveSessionId(session.id);
    setHistoryMode('closed');
  }, []);

  const closeSession = useCallback((sessionId: string) => {
    cancelTurnForSession(sessionId);
    const nextOpenSessionIds = openSessionIds.filter((id) => id !== sessionId);
    const replacement = nextOpenSessionIds.length === 0 ? createBlankSession(makeId('new'), Date.now()) : null;
    const resolvedOpenSessionIds = replacement ? [replacement.id] : nextOpenSessionIds;
    const nextActiveSessionId = sessionId === activeSessionId
      ? resolvedOpenSessionIds[resolvedOpenSessionIds.length - 1]
      : activeSessionId;

    setSessions((currentSessions) => {
      const remainingSessions = currentSessions.filter((session) => session.id !== sessionId);
      return replacement ? [...remainingSessions, replacement] : remainingSessions;
    });
    setOpenSessionIds(resolvedOpenSessionIds);
    setActiveSessionId(nextActiveSessionId);
    setRequestStateBySessionId((currentStates) => {
      const nextStates = { ...currentStates };
      delete nextStates[sessionId];
      return nextStates;
    });
  }, [activeSessionId, cancelTurnForSession, openSessionIds]);

  const sendMessage = useCallback((content: string) => {
    const trimmedContent = content.trim();
    if (!trimmedContent || !selectedModel) return;

    const sessionId = safeActiveSession.id;
    const createdAt = Date.now();
    const turnId = makeId('turn');
    const assistantMessageId = makeId('assistant');
    const userMessage: ChatMessage = {
      id: makeId('user'),
      role: 'user',
      content: trimmedContent,
      createdAt,
      durationLabel: null,
      status: 'complete',
      tokenUsage: null
    };
    const assistantMessage: ChatMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      createdAt,
      durationLabel: null,
      status: 'streaming',
      tokenUsage: null
    };
    const request: LocalChatTurnRequest = {
      turnId,
      sessionId,
      assistantMessageId,
      modelId: selectedModel.id,
      messages: [...safeActiveSession.messages, userMessage]
        .filter((message) => message.status !== 'error' && message.content.trim().length > 0)
        .map((message) => ({ role: message.role, content: message.content }))
    };

    activeTurnsByIdRef.current.set(turnId, { sessionId, assistantMessageId, startedAt: createdAt });
    turnIdBySessionIdRef.current.set(sessionId, turnId);
    setSessions((currentSessions) => currentSessions.map((session) => session.id === sessionId
      ? {
          ...session,
          title: session.messages.length === 0 ? trimmedContent : session.title,
          updatedAt: createdAt,
          messages: [...session.messages, userMessage, assistantMessage]
        }
      : session));
    setRequestStateBySessionId((currentStates) => ({ ...currentStates, [sessionId]: 'sending' }));

    void window.tokiie.startLocalChatTurn(request).catch((error: unknown) => {
      markTurnFailed(turnId, describeError(error));
      void refreshRuntimeState();
    });
  }, [markTurnFailed, refreshRuntimeState, safeActiveSession, selectedModel]);

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
    historyQuery,
    historyGroups,
    historyResults,
    earlierPage,
    earlierPageItems: earlierPageData.items,
    hasEarlierPage: earlierPageData.hasNextPage,
    modelState,
    selectedModel,
    copyStateByMessageId,
    openHistory,
    closeHistory,
    setHistoryQuery: updateHistoryQuery,
    setEarlierPage,
    selectSession,
    createNewChat,
    closeSession,
    sendMessage,
    stopStreaming,
    copyMessage
  };
}
