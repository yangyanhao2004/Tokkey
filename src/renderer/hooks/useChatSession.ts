import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ASSISTANT_FIXTURE,
  CHAT_MODEL,
  FIXTURE_NOW,
  createBlankSession,
  createChatFixture,
  groupHistory,
  paginateEarlier,
  searchHistory,
  summarizeSession,
  type ChatHistoryGroup,
  type ChatMessage,
  type ChatModelState,
  type ChatRequestState,
  type ChatSession
} from '../pages/chatContent';

const INITIAL_OPEN_SESSION_IDS = ['daily-brief', 'wechat-motivation', 'vendio'];
const EARLIER_PAGE_SIZE = 3;
const RESPONSE_DELAY_MS = 900;

type HistoryMode = 'closed' | 'browsing' | 'searching';

type CopyState = 'idle' | 'copied' | 'error';

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
  selectedModel: typeof CHAT_MODEL | null;
  copyStateByMessageId: Readonly<Record<string, CopyState>>;
  openHistory: () => void;
  closeHistory: () => void;
  setHistoryQuery: (query: string) => void;
  setEarlierPage: (page: number) => void;
  selectSession: (sessionId: string) => void;
  createNewChat: () => void;
  closeSession: (sessionId: string) => void;
  sendMessage: (content: string) => void;
  copyMessage: (message: ChatMessage) => Promise<void>;
}

function makeSessionId(): string {
  return `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useChatSession(): ChatSessionController {
  const [sessions, setSessions] = useState<ChatSession[]>(() => createChatFixture());
  const [openSessionIds, setOpenSessionIds] = useState<string[]>(INITIAL_OPEN_SESSION_IDS);
  const [activeSessionId, setActiveSessionId] = useState('vendio');
  const [requestStateBySessionId, setRequestStateBySessionId] = useState<Record<string, ChatRequestState>>({});
  const [historyMode, setHistoryMode] = useState<HistoryMode>('closed');
  const [historyQuery, setHistoryQuery] = useState('');
  const [earlierPage, setEarlierPage] = useState(0);
  const [modelState] = useState<ChatModelState>('available');
  const [copyStateByMessageId, setCopyStateByMessageId] = useState<Record<string, CopyState>>({});
  const responseTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const copyTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      responseTimers.current.forEach((timer) => clearTimeout(timer));
      copyTimers.current.forEach((timer) => clearTimeout(timer));
    };
  }, []);

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
    setSessions((currentSessions) => {
      if (currentSessions.some((session) => session.id === sessionId)) return currentSessions;
      return currentSessions;
    });
    setOpenSessionIds((currentIds) => currentIds.includes(sessionId) ? currentIds : [...currentIds, sessionId]);
    setActiveSessionId(sessionId);
    setHistoryMode('closed');
  }, []);

  const createNewChat = useCallback(() => {
    const session = createBlankSession(makeSessionId());
    setSessions((currentSessions) => [...currentSessions, session]);
    setOpenSessionIds((currentIds) => [...currentIds, session.id]);
    setActiveSessionId(session.id);
    setHistoryMode('closed');
  }, []);

  const closeSession = useCallback((sessionId: string) => {
    const nextOpenSessionIds = openSessionIds.filter((id) => id !== sessionId);
    const replacement = nextOpenSessionIds.length === 0 ? createBlankSession(makeSessionId()) : null;
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
  }, [activeSessionId, openSessionIds]);

  const sendMessage = useCallback((content: string) => {
    const trimmedContent = content.trim();
    if (!trimmedContent || modelState !== 'available') return;
    const sessionId = activeSessionId;
    const exchangeId = `${sessionId}-${Date.now()}`;
    const createdAt = Date.now();
    const userMessage: ChatMessage = {
      id: `${exchangeId}-user`, role: 'user', content: trimmedContent, createdAt,
      durationLabel: null, status: 'complete'
    };
    const assistantMessage: ChatMessage = {
      id: `${exchangeId}-assistant`, role: 'assistant', content: '', createdAt,
      durationLabel: null, status: 'streaming'
    };
    setSessions((currentSessions) => currentSessions.map((session) => session.id === sessionId
      ? { ...session, title: session.messages.length === 0 ? trimmedContent : session.title, updatedAt: createdAt, messages: [...session.messages, userMessage, assistantMessage] }
      : session));
    setRequestStateBySessionId((currentStates) => ({ ...currentStates, [sessionId]: 'sending' }));
    const timer = setTimeout(() => {
      if (!mountedRef.current) return;
      setSessions((currentSessions) => currentSessions.map((session) => session.id === sessionId
        ? { ...session, updatedAt: Date.now(), messages: session.messages.map((message) => message.id === assistantMessage.id
          ? { ...message, content: ASSISTANT_FIXTURE, durationLabel: '00:09', status: 'complete' }
          : message) }
        : session));
      setRequestStateBySessionId((currentStates) => ({ ...currentStates, [sessionId]: 'idle' }));
    }, RESPONSE_DELAY_MS);
    responseTimers.current = [...responseTimers.current, timer];
  }, [activeSessionId, modelState]);

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
    }, 1600);
    copyTimers.current = [...copyTimers.current, timer];
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
    selectedModel: modelState === 'available' ? CHAT_MODEL : null,
    copyStateByMessageId,
    openHistory,
    closeHistory,
    setHistoryQuery: updateHistoryQuery,
    setEarlierPage,
    selectSession,
    createNewChat,
    closeSession,
    sendMessage,
    copyMessage
  };
}

