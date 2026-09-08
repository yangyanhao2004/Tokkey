import { useEffect, useRef, type Ref } from 'react';
import { ICON_BASE_PATH, summarizeSession, type ChatSession } from '../../pages/chatContent';
import { ChatHistoryPopover } from './ChatHistoryPopover';

interface ChatTabBarProps {
  sessions: ChatSession[];
  activeSessionId: string;
  historyIsOpen: boolean;
  historyGroups: { label: 'Today' | '7Days' | 'Earlier'; items: ReturnType<typeof summarizeSession>[] }[];
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onCreateChat: () => void;
  onOpenHistory: () => void;
  onCloseHistory: () => void;
}

function ChatTab({
  session,
  isActive,
  isFirst,
  tabRef,
  onSelect,
  onClose
}: {
  session: ChatSession;
  isActive: boolean;
  isFirst: boolean;
  tabRef?: Ref<HTMLDivElement>;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div
      ref={tabRef}
      className={`app-no-drag relative flex h-9 w-[200.091px] shrink-0 items-stretch ${isActive ? 'z-20' : 'z-10'} ${isActive && !isFirst ? '-ml-4' : ''}`}
      data-testid={`chat-tab-${session.id}`}
    >
      {isActive && (
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <span className="absolute inset-y-0 left-4 right-4 bg-chat-tab-active" />
          <img className="absolute left-0 top-0 h-9 w-4 max-w-none" src={`${ICON_BASE_PATH}/chat-tab-fold-leading.svg`} alt="" />
          <img className="absolute right-0 top-0 h-9 w-4 max-w-none -scale-x-100" src={`${ICON_BASE_PATH}/chat-tab-fold-leading.svg`} alt="" />
        </div>
      )}
      <button
        type="button"
        className={`relative z-10 flex h-9 w-[185px] min-w-0 shrink-0 items-center gap-1 bg-transparent py-0 pr-9 text-left focus-visible:z-20 focus-visible:outline-2 focus-visible:outline-white ${isActive ? 'pl-5' : 'pl-3'}`}
        onClick={onSelect}
        aria-current={isActive ? 'page' : undefined}
        aria-label={`Open ${session.title}`}
      >
        <img className="block size-4 shrink-0 max-w-none" src={`${ICON_BASE_PATH}/chat-tab-sparkles.svg`} alt="" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-white">{session.title}</span>
      </button>
      <button
        type="button"
        className="absolute left-[148.5px] top-1/2 z-20 flex size-6 -translate-y-1/2 items-center justify-center rounded text-white/85 focus-visible:outline-2 focus-visible:outline-white"
        onClick={onClose}
        aria-label={`Close ${session.title}`}
      >
        <img className="block size-4 max-w-none" src={`${ICON_BASE_PATH}/chat-tab-close.svg`} alt="" />
      </button>
    </div>
  );
}

export function ChatTabBar({
  sessions,
  activeSessionId,
  historyIsOpen,
  historyGroups,
  onSelectSession,
  onCloseSession,
  onCreateChat,
  onOpenHistory,
  onCloseHistory
}: ChatTabBarProps) {
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const activeTabRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeSessionId]);

  return (
    <header className="app-drag relative flex h-[42px] shrink-0 items-end gap-4 overflow-visible bg-chat-tab-bar pr-3 pt-[6px]" data-testid="chat-tab-bar">
      <div className="flex h-9 min-w-0 flex-1 items-end overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {sessions.map((session, index) => (
          <ChatTab
            key={session.id}
            session={session}
            isActive={session.id === activeSessionId}
            isFirst={index === 0}
            tabRef={session.id === activeSessionId ? activeTabRef : undefined}
            onSelect={() => onSelectSession(session.id)}
            onClose={() => onCloseSession(session.id)}
          />
        ))}
      </div>
      <img className="mb-[13px] block h-px w-[13px] shrink-0 rotate-90" src={`${ICON_BASE_PATH}/chat-tab-divider.svg`} alt="" />
      <div className="app-no-drag relative mb-[7px] flex h-6 shrink-0 overflow-visible rounded-full border border-white/10 bg-white/5" data-testid="chat-tab-actions">
        <button
          type="button"
          className="flex w-[26px] items-center justify-center border-r border-white/10 focus-visible:outline-2 focus-visible:outline-white"
          onClick={onCreateChat}
          aria-label="New private chat"
          title="New private chat"
          data-testid="chat-new"
        >
          <img className="block size-[14px] max-w-none" src={`${ICON_BASE_PATH}/chat-new.svg`} alt="" />
        </button>
        <button
          ref={historyButtonRef}
          type="button"
          className="flex w-[26px] items-center justify-center focus-visible:outline-2 focus-visible:outline-white"
          onClick={historyIsOpen ? onCloseHistory : onOpenHistory}
          aria-expanded={historyIsOpen}
          aria-haspopup="dialog"
          aria-label="Private chat history"
          title="Private chat history"
          data-testid="chat-history-trigger"
        >
          <img className="block size-[14px] max-w-none" src={`${ICON_BASE_PATH}/chat-history.svg`} alt="" />
        </button>
        {historyIsOpen && (
          <ChatHistoryPopover
            browseGroups={historyGroups}
            onSelectSession={onSelectSession}
            onClose={onCloseHistory}
            onRestoreFocus={() => historyButtonRef.current?.focus()}
          />
        )}
      </div>
    </header>
  );
}
